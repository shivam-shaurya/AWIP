import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import swaggerUi from 'swagger-ui-express';
import { prisma } from './db.js';
import { AGENTS, runAgentTick, linearTrend, projectForward, clampConfidence } from './agents.js';
import { swaggerSpec } from './swagger.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;
const AI_API_URL = process.env.AI_API_URL || 'http://localhost:8000';

app.use(cors());
app.use(express.json());

// Interactive API docs + the raw spec Postman (or any OpenAPI-aware tool) can
// import directly: File -> Import -> http://localhost:5000/api-docs.json
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/api-docs.json', (req, res) => res.json(swaggerSpec));

// Prisma enum values are stored without spaces (e.g. "OnLeave"); the frontend's
// mock-data.ts types use the display form with spaces (e.g. "On Leave").
const DISPLAY_MAP = {
  OnLeave: "On Leave", InProgress: "In Progress", OnTrack: "On Track",
  AtRisk: "At Risk", PendingReview: "Pending Review",
  UnderInvestigation: "Under Investigation", PeerConflict: "Peer Conflict",
  FlexibleHours: "Flexible Hours", SponsoredCertification: "Sponsored Certification",
  FastTrackTraining: "Fast-Track Training", RecognitionAward: "Recognition Award",
  ParkingSpot: "Parking Spot",
};
const toDisplay = (v) => DISPLAY_MAP[v] ?? v;
const REVERSE_MAP = Object.fromEntries(Object.entries(DISPLAY_MAP).map(([k, v]) => [v, k]));
const toEnum = (v) => REVERSE_MAP[v] ?? v;

const NOW_YEAR_SRV = new Date().getFullYear();
const DAY_MS = 24 * 60 * 60 * 1000;

// Signed day-count from today to `dateStr` (positive = future, negative =
// past) — used for both "days until retirement" and "days served since
// joining" (as `-daysUntil(doj)`), so there's one date-math helper instead of
// two near-duplicate ones.
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - Date.now()) / DAY_MS);
}

// There's no per-day attendance table — only monthly present/total-day
// aggregates. "Present today" is derived from each employee's real average
// attendance rate via a deterministic hash of (employeeId + today's date),
// so the same employee shows the same today's-status all day (not re-rolled
// on every request) while still tracking their actual attendance record.
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function isPresentToday(employeeId, attendancePct, status) {
  // null, not false — attendance doesn't apply while suspended or on leave,
  // which is distinct from actually being absent (see AttendancePill).
  if (status === "Suspended" || status === "OnLeave") return null;
  const todayKey = new Date().toISOString().slice(0, 10);
  return (hashStr(employeeId + todayKey) % 100) < attendancePct;
}

function seniorityYears(doj) {
  if (!doj) return null;
  const dojDate = new Date(doj);
  if (Number.isNaN(dojDate.getTime())) return null;
  return Math.floor((Date.now() - dojDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
}

// Self-contained High-Potential score formula — shared by computeEmployeeInsights
// (below) and the hp-detail endpoint's peer-comparison/trend computations, so
// there's a single source of truth for the score instead of two copies that
// could drift. `performancePctOverride` lets the trend endpoint substitute a
// past year's rating while holding the other (non-historized) inputs current.
function computeHpScore(e, { performancePctOverride } = {}) {
  const perf = (e.performanceRecords || []).slice().sort((a, b) => a.year - b.year);
  const latestRating = perf.length ? perf[perf.length - 1].rating : null;
  const performancePct = performancePctOverride ?? (latestRating != null ? Math.round((latestRating / 5) * 100) : null);

  const tasks = e.tasks || [];
  const overdueTasks = tasks.filter((t) => t.status === "Overdue" || t.slaStatus === "Breached");
  const slaPct = tasks.length ? Math.round(((tasks.length - overdueTasks.length) / tasks.length) * 100) : 100;

  const attendanceRows = e.attendance || [];
  const attendancePct = attendanceRows.length
    ? Math.round((attendanceRows.reduce((s, a) => s + (a.totalDays ? a.presentDays / a.totalDays : 0), 0) / attendanceRows.length) * 100)
    : null;

  const trainingRows = e.trainingRecords || [];
  const trainingCompletionPct = trainingRows.length
    ? Math.round((trainingRows.filter((t) => t.status === "Completed").length / trainingRows.length) * 100)
    : null;

  const skillCount = (e.skills || []).length;
  const skillsScore = computeSkillsScore(e.skills) ?? 50;

  const score = Math.round(
    (performancePct ?? 70) * 0.35 + (attendancePct ?? 90) * 0.15 +
    slaPct * 0.20 + (trainingCompletionPct ?? (e.trainingPending ? 40 : 85)) * 0.15 + skillsScore * 0.15,
  );

  const tenureYears = e.doj ? NOW_YEAR_SRV - Number(String(e.doj).slice(0, 4)) : null;
  const tenureOk = (tenureYears ?? 0) >= 2;
  const hasPerfRecord = perf.length >= 1;
  // A Suspended employee can never be High-Potential, regardless of score —
  // disciplinaryFlag alone doesn't guarantee this (it's a probabilistic
  // outcome of the seed's "trouble score," so a Suspended employee can have
  // disciplinaryFlag: false and still clear the composite threshold).
  const flagged = score >= 80 && !e.disciplinaryFlag && e.status !== "Suspended" && tenureOk && hasPerfRecord;

  return { score, flagged, tenureYears, perf };
}

// This employee's percentile rank on the Employee 360 Composite Score (see
// computeComposite below) among same-department/same-cadre peers. Distinct
// from the High-Potential score/flag above — HP is a stricter "should this
// person be flagged as high-potential" threshold used for filtering, while
// this is the everyday "how does this person's overall evaluation compare
// to peers" read shown on the Employee 360 AI Insights tab.
function computeCompositePercentile(compositeScore, peers) {
  if (!peers || !peers.length) return null;
  const peerScores = peers.map((p) => computeComposite(p).composite);
  return {
    peerCount: peerScores.length,
    peerAvgScore: Math.round(peerScores.reduce((s, v) => s + v, 0) / peerScores.length),
    percentile: Math.round((peerScores.filter((s) => s < compositeScore).length / peerScores.length) * 100),
  };
}

const PILLAR_LABELS = {
  performanceDelivery: "Performance & Delivery",
  reliabilityCompliance: "Reliability & Compliance",
  growthCapability: "Growth & Capability",
};

// Stitches the Composite Score and its 3 pillars into one readable "overall
// evaluation" paragraph, naming each pillar explicitly (rather than vague
// "workload is Stable" phrasing with no anchor) and flagging when a pillar
// is provisional due to thin underlying data.
function buildOverallInsightNarrative(e, { compositeScore, pillars, hpFlagged, peerComparison, perfTrend, attendanceTrendDelta, skillGrowthRatePct, workloadTrend }) {
  const parts = [];
  parts.push(
    `${e.name}'s Composite Score is ${compositeScore}/100, built from Performance & Delivery ${pillars.performanceDelivery.score}, ` +
    `Reliability & Compliance ${pillars.reliabilityCompliance.score}, and Growth & Capability ${pillars.growthCapability.score}.` +
    (hpFlagged ? " Flagged as a High-Potential employee." : ""),
  );
  if (peerComparison?.peerCount) {
    parts.push(`Ranks in the ${peerComparison.percentile}th percentile among ${peerComparison.peerCount} peer(s) of the same cadre in ${e.department}.`);
  }
  parts.push(`Performance trend is ${perfTrend.toLowerCase()}${
    attendanceTrendDelta != null ? `, with attendance ${attendanceTrendDelta >= 0 ? "improving" : "declining"} ${Math.abs(attendanceTrendDelta)} pts over the last quarter` : ""
  }.`);
  if (skillGrowthRatePct != null) parts.push(`${skillGrowthRatePct}% of recorded skills were acquired in the past year.`);
  const thin = Object.entries(pillars).filter(([, p]) => p.dataCompleteness !== "full").map(([k]) => PILLAR_LABELS[k]);
  if (thin.length) {
    parts.push(`Note: ${thin.join(" and ")} ${thin.length > 1 ? "are" : "is"} based on limited record history, so treat this as provisional.`);
  }
  // Retention risk is deliberately not folded into this prose — it's an
  // HR-facing signal surfaced as its own structured field (ai.retentionRisk)
  // so the frontend can withhold it from the employee self-service view
  // without having to string-match sentences out of a paragraph.
  parts.push(`Current workload is ${workloadTrend.toLowerCase()}.`);
  return parts.join(" ");
}

// Open-task capacity scales with seniority — a Class I officer realistically
// oversees more concurrent items than a Class IV field worker, so this
// isn't a single flat number applied to every employee regardless of role.
// This (and CADRE_PROMOTION_CYCLE_YEARS below) are institutional policy
// constants, not employee data — every explanation that references them
// names them as such rather than presenting them as computed-from-records.
const WORKLOAD_CAPACITY_BY_CADRE = { "Class I": 18, "Class II": 15, "Class III": 12, "Class IV": 8 };
const CADRE_PROMOTION_CYCLE_YEARS = { "Class I": 5, "Class II": 4, "Class III": 3, "Class IV": 2 };

// Same proficiency→pct mapping the frontend's SkillsModule uses (kept as a
// single source of truth would require sharing a module across the two
// runtimes, which this repo doesn't do elsewhere either — mirrored here
// intentionally so both sides agree on what each proficiency level is worth).
const PROFICIENCY_PCT_SRV = { beginner: 30, basic: 30, intermediate: 60, advanced: 85, expert: 97 };

// Real average of each skill's proficiency level (not just a headcount), plus
// a small bonus for breadth — returns null when there's nothing to compute
// from, so callers can show an honest "no skills recorded" state instead of
// a fabricated number.
function computeSkillsScore(skills) {
  const rows = skills || [];
  if (!rows.length) return null;
  const avgProf = rows.reduce((s, k) => s + (PROFICIENCY_PCT_SRV[String(k.proficiency).toLowerCase()] ?? 50), 0) / rows.length;
  const breadthBonus = Math.min(10, rows.length);
  return Math.min(100, Math.round(avgProf + breadthBonus));
}

// Blends each service-book document's real status (Verified/PendingReview/
// Missing) with its real OCR confidence score — returns null when there are
// no documents at all, so the caller can show an honest "none on file" state
// instead of a guessed number standing in for real data.
const DOC_STATUS_PCT = { Verified: 100, PendingReview: 60, Missing: 0 };
function computeDocumentsScore(docs) {
  const rows = docs || [];
  if (!rows.length) return { score: null, avgOcr: null };
  const weighted = rows.map((d) => {
    const statusPct = DOC_STATUS_PCT[d.status] ?? 50;
    const ocrPct = d.ocrScore != null ? d.ocrScore : statusPct;
    return (statusPct + ocrPct) / 2;
  });
  const score = Math.round(weighted.reduce((s, v) => s + v, 0) / weighted.length);
  const avgOcr = Math.round(rows.reduce((s, d) => s + (d.ocrScore || 0), 0) / rows.length);
  return { score, avgOcr };
}

// Weighted, recency-aware read of the employee's real award/life-event
// history — Awards count for more than a generic life event, and anything
// in the last 2 years counts more than older history. Base 50 (neutral)
// when there's no history at all yet.
function computeActivityScore(events) {
  const rows = events || [];
  if (!rows.length) return { score: 50, awardCount: 0, lifeEventCount: 0 };
  const nowMs = Date.now();
  let sum = 0;
  let awardCount = 0;
  let lifeEventCount = 0;
  for (const ev of rows) {
    const isAward = ev.kind === "Award";
    if (isAward) awardCount++; else lifeEventCount++;
    const base = isAward ? 15 : 8;
    const ageYears = ev.date ? (nowMs - new Date(ev.date).getTime()) / (365.25 * 24 * 60 * 60 * 1000) : 99;
    sum += base * (ageYears <= 2 ? 1 : 0.5);
  }
  return { score: Math.min(100, Math.round(50 + sum)), awardCount, lifeEventCount };
}

// Real percentile of this employee's gross pay among same-department/
// same-cadre peers (peers query already fetches `compensation` for the
// aiInsights peer comparison — reused here rather than a second query).
function computeCompensationScore(e, peers) {
  const gross = e.compensation?.grossPay;
  if (gross == null) return { score: null, peerCount: 0, percentile: null };
  const peerGross = (peers || []).map((p) => p.compensation?.grossPay).filter((v) => v != null);
  if (!peerGross.length) return { score: 60, peerCount: 0, percentile: null };
  const percentile = Math.round((peerGross.filter((v) => v < gross).length / peerGross.length) * 100);
  return { score: percentile, peerCount: peerGross.length, percentile };
}

// Real tenure-vs-expected-promotion-cycle read (cycle length is the cadre
// policy constant above), boosted by actual Promotion/Transfer records on
// file and docked when the employee is currently flagged promotion-overdue.
function computeCareerScore(e, tenureYears) {
  const cycle = CADRE_PROMOTION_CYCLE_YEARS[e.cadre] || 4;
  const promotionRecords = (e.serviceBookDocs || []).filter((d) => /promotion|transfer/i.test(d.type || "")).length;
  const cycleRatio = tenureYears != null ? tenureYears / cycle : 0;
  let score = Math.round(50 + cycleRatio * 15 + promotionRecords * 10);
  if (e.promotionDue) score -= 20;
  return { score: Math.max(20, Math.min(100, score)), cycle, promotionRecords };
}

// Single source of truth for the Employee 360 Composite Score. Replaces the
// old flat 12-score list's two near-duplicate "overview" and "ai" rollups
// with 3 named, weighted pillars — Performance & Delivery / Reliability &
// Compliance / Growth & Capability — that roll up to one number. Called
// once for the employee and once per peer (see computeCompositePercentile
// above) so every consumer agrees on the same score computed the same way.
// Compensation, recognition/activity, and workload are deliberately left
// out of this — they're shown as separate "context" cards on the AI
// Insights tab, not folded into the merit composite (pay in particular is
// kept out so pay percentile never reads as a merit signal).
function computeComposite(e) {
  const tasks = e.tasks || [];
  const overdueTasks = tasks.filter((t) => t.status === "Overdue" || t.slaStatus === "Breached");
  const slaPct = tasks.length ? Math.round(((tasks.length - overdueTasks.length) / tasks.length) * 100) : 100;

  const perf = (e.performanceRecords || []).slice().sort((a, b) => a.year - b.year);
  const latestRating = perf.length ? perf[perf.length - 1].rating : null;
  const prevRating = perf.length > 1 ? perf[perf.length - 2].rating : null;
  const performancePct = latestRating != null ? Math.round((latestRating / 5) * 100) : null;

  const attendanceRows = e.attendance || [];
  const attendancePct = attendanceRows.length
    ? Math.round((attendanceRows.reduce((s, a) => s + (a.totalDays ? a.presentDays / a.totalDays : 0), 0) / attendanceRows.length) * 100)
    : null;

  const docsResult = computeDocumentsScore(e.serviceBookDocs);

  const trainingRows = e.trainingRecords || [];
  const trainingCompletionPct = trainingRows.length
    ? Math.round((trainingRows.filter((t) => t.status === "Completed").length / trainingRows.length) * 100)
    : null;

  const skillsWithDate = (e.skills || []).filter((s) => s.acquiredDate);
  const oneYearAgo = `${NOW_YEAR_SRV - 1}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`;
  const recentSkillCount = skillsWithDate.filter((s) => s.acquiredDate >= oneYearAgo).length;
  const skillGrowthRatePct = skillsWithDate.length ? Math.round((recentSkillCount / skillsWithDate.length) * 100) : null;

  const tenureYears = e.doj ? NOW_YEAR_SRV - Number(String(e.doj).slice(0, 4)) : null;
  const careerResult = computeCareerScore(e, tenureYears);

  const performanceDelivery = {
    score: Math.round((performancePct ?? 70) * 0.6 + slaPct * 0.4),
    dataCompleteness: performancePct != null && tasks.length > 0 ? "full" : (performancePct != null || tasks.length > 0) ? "partial" : "none",
    why: `Weighted mainly on the latest appraisal rating ${performancePct != null ? `(${performancePct}/100, 60% weight)` : "(no record on file, so a neutral baseline carries 60% weight)"}, with task/SLA delivery rate (${slaPct}%, 40% weight) making up the rest.`,
  };

  // A disciplinary flag caps this pillar regardless of the other two inputs —
  // mirrors the existing "can't be High-Potential while Suspended" guard in
  // computeHpScore below.
  const reliabilityRaw = Math.round((attendancePct ?? 90) * 0.5 + (docsResult.score ?? 65) * 0.3 + (e.disciplinaryFlag ? 0 : 100) * 0.2);
  const reliabilityCompliance = {
    score: e.disciplinaryFlag ? Math.min(reliabilityRaw, 40) : reliabilityRaw,
    dataCompleteness: attendancePct != null && docsResult.score != null ? "full" : (attendancePct != null || docsResult.score != null) ? "partial" : "none",
    why: `Driven by attendance ${attendancePct != null ? `(${attendancePct}%, 50% weight)` : "(no record on file, so a neutral baseline carries 50% weight)"}, document completeness (${docsResult.score ?? "no docs on file"}, 30% weight), and disciplinary clearance (20% weight).` +
      (e.disciplinaryFlag ? " Capped at 40 due to an active disciplinary flag." : ""),
  };

  const growthCapability = {
    score: Math.round((skillGrowthRatePct ?? 50) * 0.4 + (trainingCompletionPct ?? (e.trainingPending ? 40 : 85)) * 0.35 + careerResult.score * 0.25),
    dataCompleteness: skillGrowthRatePct != null && trainingCompletionPct != null ? "full" : (skillGrowthRatePct != null || trainingCompletionPct != null) ? "partial" : "none",
    why: `Combines skill growth rate ${skillGrowthRatePct != null ? `(${skillGrowthRatePct}%, 40% weight)` : "(no dated skills on file, so a neutral baseline carries 40% weight)"}, training completion ${trainingCompletionPct != null ? `(${trainingCompletionPct}%, 35% weight)` : "(no records on file, so a neutral baseline carries 35% weight)"}, and career/promotion pacing (${careerResult.score}, 25% weight).`,
  };

  const composite = Math.round(performanceDelivery.score * 0.4 + reliabilityCompliance.score * 0.3 + growthCapability.score * 0.3);

  return {
    composite,
    pillars: { performanceDelivery, reliabilityCompliance, growthCapability },
    tasks, overdueTasks, slaPct, perf, latestRating, prevRating, performancePct,
    attendanceRows, attendancePct, docsResult, trainingRows, trainingCompletionPct,
    skillGrowthRatePct, skillsWithDate, oneYearAgo, tenureYears, careerResult,
  };
}

// One human-readable explanation per score, built from THIS employee's real
// numbers (not generic copy) — surfaced in each module's overlay so "why is
// this 72/100" always has a concrete, checkable answer.
function buildScoreExplanations(e, ctx) {
  const {
    perf, latestRating, prevRating, performancePct,
    attendanceRows, attendancePct,
    tasks, overdueTasks, slaPct,
    trainingRows, trainingCompletionPct,
    docsResult, skillCount, activityResult,
    compensationResult, careerResult, capacity, composite,
  } = ctx;

  const latestYear = perf.length ? perf[perf.length - 1].year : null;
  const presentDaysTotal = attendanceRows.reduce((s, a) => s + (a.presentDays || 0), 0);
  const totalDaysTotal = attendanceRows.reduce((s, a) => s + (a.totalDays || 0), 0);
  const completedTrainingCount = trainingRows.filter((t) => t.status === "Completed").length;

  return {
    performance: perf.length
      ? `Performance Index is the latest recorded appraisal rating (${latestRating}/5 in ${latestYear}) scaled to 100, giving ${performancePct}/100.${prevRating != null ? ` Previous year (${latestYear - 1}) was ${prevRating}/5.` : ""}`
      : "No performance record is on file yet, so this shows a neutral baseline, not a real rating.",
    attendance: attendanceRows.length
      ? `Average across ${attendanceRows.length} monthly attendance record(s): ${presentDaysTotal}/${totalDaysTotal} days present, or ${attendancePct}%.`
      : "No attendance records are on file yet, so this shows a neutral baseline.",
    tasks: tasks.length
      ? `${tasks.length - overdueTasks.length} of ${tasks.length} assigned task(s) on-track or completed with no SLA breach, or ${slaPct}%.`
      : "No tasks are assigned yet, so this shows a full-marks baseline (nothing to breach).",
    training: trainingRows.length
      ? `${completedTrainingCount} of ${trainingRows.length} training record(s) marked Completed, or ${trainingCompletionPct}%.`
      : "No training records are on file yet, so this shows a neutral baseline, not a real completion rate.",
    documents: docsResult.score != null
      ? `Blended from ${docsResult.avgOcr != null ? "each" : ""} service-book document's status (Verified/Pending Review/Missing) and its OCR confidence score (avg ${docsResult.avgOcr}%).`
      : "No service-book documents are on file yet, so this shows a neutral baseline, not a real average.",
    skills: skillCount
      ? `Average proficiency across ${skillCount} recorded skill(s), using Beginner/Basic=30, Intermediate=60, Advanced=85, Expert=97, plus a small bonus for skill breadth.`
      : "No skills are recorded yet, so this shows a neutral baseline.",
    activity: `Base 50 plus weighted recognition from ${activityResult.awardCount} award(s) (+15 pt each) and ${activityResult.lifeEventCount} recorded life event(s) (+8 pt each); events from the last 2 years are weighted higher than older ones. Context only, not a scored pillar.`,
    compensation: compensationResult.peerCount
      ? `Gross pay percentile among ${compensationResult.peerCount} peer(s) of the same cadre in ${e.department}: this employee's pay is higher than ${compensationResult.percentile}% of those peers. Context only; pay is deliberately not factored into the Composite Score, to avoid pay looking like a merit signal.`
      : (e.compensation ? "No peers in the same department/cadre to compare pay against, so this shows a neutral baseline. Context only, not scored." : "No compensation record on file."),
    career: `Tenure of ${ctx.tenureYears ?? 0} yr(s) against the typical ${careerResult.cycle}-yr promotion cycle for ${e.cadre} (AMC HR policy), with ${careerResult.promotionRecords} promotion/transfer record(s) on file${e.promotionDue ? ", currently flagged promotion-overdue" : ""}. Feeds 25% of the Growth & Capability pillar.`,
    overview: `Composite Score (${composite}/100): the single weighted rollup of the 3 pillars below, Performance & Delivery 40%, Reliability & Compliance 30%, Growth & Capability 30%. This is the same number shown on the AI Insights tab.`,
    workloadCapacity: `Capacity of ${capacity} concurrent tasks is AMC's standard workload norm for ${e.cadre}, an institutional policy figure, not specific to this employee.`,
  };
}

// Replaces the wireframe's fixed per-employee scores/narrative with numbers
// computed from the employee's actual included relations — two employees
// will genuinely show different figures instead of the same canned values.
function computeEmployeeInsights(e, isSelf = false) {
  // Single source of truth for the Composite Score and its 3 pillars — see
  // computeComposite above. Everything below reuses its sub-metrics instead
  // of recomputing them, so there's exactly one place that decides what
  // "performance %" or "attendance %" means for this employee.
  const comp = computeComposite(e);
  const {
    tasks, overdueTasks, slaPct, perf, latestRating, prevRating, performancePct,
    attendanceRows, attendancePct, docsResult, trainingRows, trainingCompletionPct,
    skillGrowthRatePct, skillsWithDate, oneYearAgo, tenureYears, careerResult,
    composite, pillars,
  } = comp;

  const openTasks = tasks.filter((t) => t.status !== "Completed");
  const completedTasks = tasks.filter((t) => t.status === "Completed");
  const avgTatDays = completedTasks.length
    ? Math.round((completedTasks.reduce((s, t) => s + (t.tatDays || 0), 0) / completedTasks.length) * 10) / 10
    : 0;

  const performanceDeltaPct = latestRating != null && prevRating != null
    ? Math.round(((latestRating - prevRating) / 5) * 100)
    : null;

  const skillCount = (e.skills || []).length;
  const goalProgressPct = tasks.length ? Math.round((completedTasks.length / tasks.length) * 100) : 0;

  const assetRows = e.assets || [];
  const lostAssets = assetRows.filter((a) => a.status === "Lost").length;
  const assetsScore = assetRows.length ? Math.round(((assetRows.length - lostAssets) / assetRows.length) * 100) : 90;

  const documentsScore = docsResult.score ?? 65;

  const activityResult = computeActivityScore(e.employeeEvents);
  const activityScore = activityResult.score;

  const skillsScore = computeSkillsScore(e.skills) ?? 50;
  const compensationResult = computeCompensationScore(e, e._peers);
  const compensationScore = compensationResult.score ?? 60;
  const careerScore = careerResult.score;

  // Per-module scores driving the radial ring on Employee 360 — every value
  // traces back to a real included relation instead of the wireframe's fixed
  // per-module numbers, so two employees genuinely render differently. See
  // `explanations` below for exactly how each of these was derived.
  // `overview` and `ai` both point at the one Composite Score (computeComposite
  // above) — they used to be two independently-drifting rollups of overlapping
  // inputs; now both radial rings agree on the same number.
  const healthScores = {
    performance: performancePct ?? 70,
    attendance: attendancePct ?? 90,
    tasks: slaPct,
    training: trainingCompletionPct ?? (e.trainingPending ? 40 : 85),
    documents: documentsScore,
    assets: assetsScore,
    skills: skillsScore,
    activity: activityScore,
    compensation: compensationScore,
    career: careerScore,
    overview: composite,
    ai: composite,
  };

  const retirementYearsLeft = e.retirement ? Number(String(e.retirement).slice(0, 4)) - NOW_YEAR_SRV : null;

  // Retirement Readiness Audit — real document/disciplinary blockers checked
  // specifically for employees retiring within 6 months, instead of the
  // static countdown above being the only retirement-adjacent signal. Not
  // folded into `recommendations` above because those are generic
  // any-time-flags; this is scoped to "will this specific gap actually delay
  // this employee's pension" and only applies in the retirement window.
  const daysToRetirement = daysUntil(e.retirement);
  const unverifiedDocs = (e.serviceBookDocs || []).filter((d) => d.status !== "Verified");
  const retirementDueSoon = daysToRetirement != null && daysToRetirement >= 0 && daysToRetirement <= 180;
  const retirementBlockers = retirementDueSoon ? [
    ...(e.missingDocs ? ["Service book flagged with pending/missing documents"] : []),
    ...(unverifiedDocs.length ? [`${unverifiedDocs.length} service-book document(s) not yet Verified`] : []),
    ...(e.disciplinaryFlag ? ["Open disciplinary matter must be cleared before pension processing"] : []),
  ] : [];
  const retirementReadiness = {
    dueSoon: retirementDueSoon,
    daysToRetirement,
    blockers: retirementBlockers,
    ready: retirementDueSoon ? retirementBlockers.length === 0 : null,
  };

  // Regularisation / Tenure-Day Tracker — AMC's real 1982 policy grants
  // permanent status at 900 (full-time) / 1800 (part-time) cumulative
  // service days. This app has no employment-type (contractual vs.
  // permanent) field, so it reports the real day-count and milestone for
  // every employee rather than inventing one — honest given the schema.
  const tenureDaysServed = e.doj ? -daysUntil(e.doj) : null;
  const milestoneCrossed = tenureDaysServed == null ? null : tenureDaysServed >= 1800 ? 1800 : tenureDaysServed >= 900 ? 900 : null;
  const nextMilestone = milestoneCrossed === 1800 ? null : milestoneCrossed === 900 ? 1800 : 900;
  const regularisation = {
    daysServed: tenureDaysServed,
    milestoneCrossed,
    nextMilestone,
    daysToNextMilestone: tenureDaysServed != null && nextMilestone != null ? nextMilestone - tenureDaysServed : null,
    // "Recently crossed" (last 30 days) is the actionable signal for an
    // org-wide alert — nearly every long-tenured employee is technically
    // past 900 days, so a running total would be a meaningless huge number,
    // not a real notification.
    recentlyCrossed: tenureDaysServed != null && ((tenureDaysServed >= 900 && tenureDaysServed <= 930) || (tenureDaysServed >= 1800 && tenureDaysServed <= 1830)),
  };

  // Severity-ranked, capped at 3: compliance/risk items first, then
  // performance/delivery, then growth — so the highest-stakes item is never
  // buried under an equally-weighted lower-priority one. Text is phrased
  // in second person for the employee viewing their own record (isSelf),
  // third person/HR-instructional otherwise — same self-vs-other split
  // fetch_employee_context already uses (server-ai/main.py), just applied
  // here too so an employee reading their own Digital Twin doesn't see
  // instructions addressed to HR about them.
  const recommendationCandidates = [];
  if (e.missingDocs) recommendationCandidates.push({
    text: isSelf ? "Your service book has pending/missing documents to digitize" : "Digitize pending service book documents", severity: 1,
  });
  if (e.disciplinaryFlag) recommendationCandidates.push({
    text: isSelf ? "You have an open disciplinary matter on record" : "Review open disciplinary matter before any promotion/HP consideration", severity: 1,
  });
  if (overdueTasks.length > 0) recommendationCandidates.push({
    text: isSelf ? `You have ${overdueTasks.length} overdue task(s) to complete` : `Review ${overdueTasks.length} overdue task(s) for reassignment or extension`, severity: 2,
  });
  if (e.appraisalPending) recommendationCandidates.push({
    text: isSelf ? "Your performance appraisal is pending completion" : "Complete pending performance appraisal", severity: 2,
  });
  if (e.trainingPending) recommendationCandidates.push({
    text: isSelf ? "You have an overdue refresher training to schedule" : "Schedule the overdue refresher training", severity: 3,
  });
  if (e.promotionDue) recommendationCandidates.push({
    text: isSelf ? "Your promotion review is due; you're eligible per tenure norms" : "Initiate promotion review; eligible per tenure norms", severity: 3,
  });
  const recommendations = recommendationCandidates.length
    ? recommendationCandidates.sort((a, b) => a.severity - b.severity).slice(0, 3).map((r) => r.text)
    : ["No outstanding action items, record is in good standing"];

  const badges = {
    tasks: overdueTasks.length || undefined,
    training: trainingRows.filter((t) => t.status !== "Completed").length || undefined,
    documents: (e.serviceBookDocs || []).filter((d) => d.status !== "Verified").length || undefined,
  };

  // High-Potential flag — AI/algorithm-computed at read time from real
  // signals already derived above, PLUS an optional HR-set override
  // (hiPoOverride: null = no override, true = HR force-flagged someone the
  // AI missed, false = HR force-removed someone the AI flagged). The
  // override wins either direction; the underlying AI read is still shown
  // in the reasons so HR can see what the algorithm actually said. Tenure
  // and sample-size guards mirror the small-sample lesson learned building
  // the Command Centre AI agents: a brand-new hire with one great month of
  // data shouldn't outrank someone with a sustained track record.
  const hpResult = computeHpScore(e);
  const hpScore = hpResult.score;
  const hpAiFlagged = hpResult.flagged;
  const hpHasOverride = e.hiPoOverride !== null && e.hiPoOverride !== undefined;
  const hpOverrideValue = hpHasOverride ? !!e.hiPoOverride : null;
  const hpFlagged = hpHasOverride ? hpOverrideValue : hpAiFlagged;
  const hpTenureOk = (tenureYears ?? 0) >= 2;
  const hpHasPerfRecord = perf.length >= 1;

  const hpReasons = [];
  hpReasons.push("Composite score weighting: Performance 35% + Attendance 15% + Tasks (SLA) 20% + Training 15% + Skills 15%.");
  if (hpHasOverride) {
    const overrideDate = e.hiPoOverrideAt ? ` on ${e.hiPoOverrideAt.toISOString().slice(0, 10)}` : "";
    hpReasons.push(hpOverrideValue
      ? `Manually flagged by ${e.hiPoOverrideBy || "HR"}${overrideDate}`
      : `Manually removed from High Potential by ${e.hiPoOverrideBy || "HR"}${overrideDate}, overriding the AI read below`);
  }
  if (hpAiFlagged) {
    if (performancePct != null && performancePct >= 85) hpReasons.push(`Performance rating ${performancePct}/100`);
    if (attendancePct != null && attendancePct >= 90) hpReasons.push(`Attendance ${attendancePct}%`);
    if (tasks.length > 0 && overdueTasks.length === 0) hpReasons.push("Zero SLA breaches on record");
    if (trainingCompletionPct != null && trainingCompletionPct >= 85) hpReasons.push("Strong training completion record");
    if (skillCount >= 3) hpReasons.push(`${skillCount} recorded skill(s) on file`);
  } else {
    if (!hpHasPerfRecord) hpReasons.push("No performance record on file yet to evaluate");
    else if (!hpTenureOk) hpReasons.push(`Tenure ${tenureYears ?? 0}yr, below the 2yr minimum for consideration`);
    else if (e.status === "Suspended") hpReasons.push("Currently suspended, excluded from High-Potential consideration");
    else if (e.disciplinaryFlag) hpReasons.push("Disciplinary flag on record excludes consideration");
    else hpReasons.push(`Composite score ${hpScore}/100, below the 80 threshold`);
  }

  // Additional AI-evaluation signals beyond the base health scores — peer
  // standing, trend direction, skill growth, workload trend, and an overall
  // retention-risk read, stitched into one narrative for the AI Insights tab.
  // Peer standing is ranked on the Composite Score, not the (separate,
  // stricter) High-Potential score — see computeCompositePercentile above.
  const peerComparison = computeCompositePercentile(composite, e._peers);

  const perfTrend = perf.length >= 2
    ? (latestRating - perf[0].rating > 0.3 ? "Improving" : latestRating - perf[0].rating < -0.3 ? "Declining" : "Stable")
    : "Insufficient data";

  const avgAttendanceRate = (rows) => rows.length
    ? rows.reduce((s, a) => s + (a.totalDays ? a.presentDays / a.totalDays : 0), 0) / rows.length
    : null;
  const recentAttendance = attendanceRows.slice(0, 3);
  const priorAttendance = attendanceRows.slice(3);
  const recentRate = avgAttendanceRate(recentAttendance);
  const priorRate = avgAttendanceRate(priorAttendance);
  const attendanceTrendDelta = recentRate != null && priorRate != null
    ? Math.round((recentRate - priorRate) * 100)
    : null;

  const capacity = WORKLOAD_CAPACITY_BY_CADRE[e.cadre] || 12;
  const tasksByMonth = new Map();
  for (const t of tasks) {
    const key = String(t.updatedAt).slice(0, 7);
    if (t.status === "Completed") continue;
    tasksByMonth.set(key, (tasksByMonth.get(key) || 0) + 1);
  }
  const monthKeys = [...tasksByMonth.keys()].sort();
  const workloadTrend = monthKeys.length >= 2
    ? (tasksByMonth.get(monthKeys.at(-1)) > tasksByMonth.get(monthKeys[0]) ? "Rising" : "Easing")
    : "Stable";
  const workloadPctOfCapacity = Math.round((openTasks.length / capacity) * 100);

  const latestAttritionRisk = perf.length ? perf[perf.length - 1].attritionRiskScore : null;
  const latestYearForRisk = perf.length ? perf[perf.length - 1].year : null;
  const retentionRisk = latestAttritionRisk == null ? "Unknown"
    : latestAttritionRisk >= 60 || perfTrend === "Declining" || (attendanceTrendDelta != null && attendanceTrendDelta < -10) ? "High"
    : latestAttritionRisk >= 35 ? "Medium" : "Low";

  const aiInsights = {
    peerComparison, perfTrend, attendanceTrendDelta, skillGrowthRatePct,
    workloadTrend, workloadPctOfCapacity, retentionRisk,
    narrative: buildOverallInsightNarrative(e, { compositeScore: composite, pillars, hpFlagged, peerComparison, perfTrend, attendanceTrendDelta, skillGrowthRatePct, workloadTrend, retentionRisk }),
    why: {
      peerComparison: peerComparison?.peerCount
        ? `Composite Score (${composite}/100) ranked against ${peerComparison.peerCount} peer(s) of the same cadre in ${e.department}.`
        : "No peers of the same cadre/department found to compare against.",
      perfTrend: perf.length >= 2
        ? `Latest rating (${latestRating}/5) vs. earliest on file (${perf[0].rating}/5, ${perf[0].year}).`
        : "Fewer than 2 performance records are on file, not enough history for a trend.",
      attendanceTrendDelta: attendanceTrendDelta != null
        ? `Average of the most recent 3 attendance record(s) vs. the prior ${priorAttendance.length} record(s).`
        : "Not enough attendance history (need 3+ prior months) to compute a trend.",
      skillGrowthRatePct: skillGrowthRatePct != null
        ? `${skillsWithDate.filter((s) => s.acquiredDate >= oneYearAgo).length} of ${skillsWithDate.length} dated skill(s) were acquired in the last 12 months.`
        : "No skills have a recorded acquisition date.",
      workloadTrend: `Open (non-completed) task count by month, compared first vs. most recent month on file; ${openTasks.length} open of ${capacity} capacity = ${workloadPctOfCapacity}%.`,
      retentionRisk: latestAttritionRisk != null
        ? `Latest attrition risk score on file (${latestAttritionRisk}/100 in ${latestYearForRisk}) combined with performance/attendance trend direction.`
        : "No performance record on file yet, so attrition risk can't be assessed.",
    },
  };

  const explanations = buildScoreExplanations(e, {
    perf, latestRating, prevRating, performancePct,
    attendanceRows, attendancePct,
    tasks, overdueTasks, slaPct,
    trainingRows, trainingCompletionPct,
    docsResult, skillCount, activityResult: activityResult,
    compensationResult, careerResult, capacity, tenureYears, composite,
  });

  return {
    healthScores,
    // The one Composite Score plus its 3 named pillars, each carrying a
    // dataCompleteness flag ("full" | "partial" | "none") so the AI Insights
    // tab can show "Not enough data yet" instead of a fabricated-looking
    // number when a pillar leaned on a neutral baseline.
    composite,
    pillars,
    highPotential: {
      flagged: hpFlagged, score: hpScore, reasons: hpReasons,
      aiFlagged: hpAiFlagged, hasOverride: hpHasOverride, overrideValue: hpOverrideValue,
      overrideBy: e.hiPoOverrideBy || null, overrideAt: e.hiPoOverrideAt || null,
    },
    badges,
    stats: {
      performancePct, performanceDeltaPct, avgTatDays,
      openTasks: openTasks.length, overdueTasks: overdueTasks.length, goalProgressPct,
    },
    overview: {
      composite,
      tenureYears, retirementYearsLeft,
      workload: { open: openTasks.length, capacity: WORKLOAD_CAPACITY_BY_CADRE[e.cadre] || 12 },
      slaPct,
      skillCount,
      recommendations,
    },
    retirementReadiness,
    regularisation,
    vigilance: {
      clearance: e.disciplinaryFlag ? "Flagged" : "Granted",
      note: e.disciplinaryFlag ? e.disciplinaryNote : "No active or past disciplinary inquiries on record.",
    },
    aiInsights,
    explanations,
  };
}

// `full: false` (used by the /employees list endpoint) drops the bio/PII
// block, which the directory list view never renders — that field alone
// was going out for all ~10,000 rows on every unfiltered directory fetch.
function shapeEmployee(e, { full = true, isSelf = false } = {}) {
  return {
    id: e.id, name: e.name, designation: e.designation, department: e.department,
    cadre: e.cadre, doj: e.doj, retirement: e.retirement, status: toDisplay(e.status),
    posting: e.posting, zone: e.zone, ward: e.ward, seniorityYears: seniorityYears(e.doj),
    grade: e.grade, jobProfile: e.jobProfile, actingRole: e.actingRole,
    divisionCode: e.divisionCode, divisionName: e.divisionName, photo: e.photo,
    ...(e._attendancePct != null ? { presentToday: isPresentToday(e.id, e._attendancePct, e.status) } : {}),
    ...(full ? {
      bio: {
        dob: e.dob, gender: e.gender, maritalStatus: e.maritalStatus, bloodGroup: e.bloodGroup,
        phone: e.phone, personalEmail: e.personalEmail, address: e.address,
        emergencyContact: e.emergencyContactName ? {
          name: e.emergencyContactName, relation: e.emergencyContactRelation, phone: e.emergencyContactPhone,
        } : null,
      },
    } : {}),
    flags: {
      promotionDue: e.promotionDue, retirementDue: e.retirementDue,
      appraisalPending: e.appraisalPending, trainingPending: e.trainingPending,
      missingDocs: e.missingDocs,
    },
    ...(e.tasks ? { tasks: e.tasks.map((t) => shapeTask({ ...t, employeeName: e.name })) } : {}),
    ...(e.serviceBookDocs ? { serviceBookDocs: e.serviceBookDocs.map(shapeServiceBookEntry) } : {}),
    ...(e.compensation !== undefined ? { compensation: e.compensation } : {}),
    ...(e.performanceRecords ? { performanceRecords: e.performanceRecords } : {}),
    ...(e.trainingRecords ? { trainingRecords: e.trainingRecords } : {}),
    ...(e.skills ? { skills: e.skills } : {}),
    ...(e.attendance ? { attendance: e.attendance } : {}),
    ...(e.assets ? { assets: e.assets } : {}),
    ...(e.employeeEvents ? {
      awards: e.employeeEvents.filter((ev) => ev.kind === "Award"),
      lifeEvents: e.employeeEvents.filter((ev) => ev.kind === "LifeEvent"),
    } : {}),
    ...(e.manager !== undefined ? { manager: e.manager ? { id: e.manager.id, name: e.manager.name, designation: e.manager.designation } : null } : {}),
    ...(e.educationRecords ? { educationRecords: e.educationRecords } : {}),
    ...(e.workExperience ? { workExperience: e.workExperience } : {}),
    ...(e.tasks && e.performanceRecords ? { insights: computeEmployeeInsights(e, isSelf) } : {}),
    ...(e.isFlagship !== undefined ? { isFlagship: e.isFlagship } : {}),
  };
}

function shapeOrgNode(e) {
  return {
    id: e.id, name: e.name, designation: e.designation, cadre: e.cadre, department: e.department,
    directReports: (e.directReports || []).map(shapeOrgNode),
  };
}

// A task's manually-set `priority` and its AI-derived `delayRisk` used to be
// shown as two independent, sometimes-contradicting columns (e.g. Priority
// "Low" next to AI Risk "High"). This folds the real delay-risk signal into
// a single, coherent priority instead: escalates one level when delay risk
// is High and priority hasn't already caught up, never downgrades.
const PRIORITY_RANK = { Low: 0, Medium: 1, High: 2 };
const PRIORITY_BY_RANK = ["Low", "Medium", "High"];
function computeEffectivePriority(priority, delayRisk) {
  const base = PRIORITY_RANK[priority] ?? 1;
  const escalated = delayRisk === "High" ? Math.min(2, base + 1) : base;
  return PRIORITY_BY_RANK[escalated];
}

function shapeTask(t) {
  const { employee, ...rest } = t;
  return {
    ...rest,
    employeeName: employee?.name ?? t.employeeName,
    employeeStatus: employee ? toDisplay(employee.status) : t.employeeStatus,
    employeeZone: employee?.zone ?? t.employeeZone,
    status: toDisplay(t.status),
    slaStatus: toDisplay(t.slaStatus),
    effectivePriority: computeEffectivePriority(t.priority, t.delayRisk),
    // progressPct is a real stored column (rest already carries it through) —
    // seeded/updated directly rather than derived from status+deadline math,
    // which used to make ~80% of tasks show an identical flat 0 or 100.
  };
}

function shapeServiceBookEntry(d) {
  return { ...d, status: toDisplay(d.status) };
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * @swagger
 * /api/v1/health:
 *   get:
 *     summary: Get health
 *     tags: [health]
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 */
app.get('/api/v1/health', (req, res) => {
  res.json({ status: "healthy", service: "awip-core-api" });
});

// Global header search — real cross-entity lookup (employees, tasks,
// service-book documents). Cap set to 50 per category to support full
// scrolling in the header dropdown.
const GLOBAL_SEARCH_LIMIT = 50;
/**
 * @swagger
 * /api/v1/search:
 *   get:
 *     summary: Get search
 *     tags: [search]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/search', requireAuth, async (req, res) => {
  const term = (req.query.q || '').trim();
  if (!term) return res.json({ employees: [], tasks: [], documents: [] });

  const [employees, tasks, documents] = await Promise.all([
    prisma.employee.findMany({
      where: {
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { id: { contains: term, mode: 'insensitive' } },
          { designation: { contains: term, mode: 'insensitive' } },
        ],
      },
      take: GLOBAL_SEARCH_LIMIT,
      orderBy: { name: 'asc' },
    }),
    prisma.task.findMany({
      where: {
        OR: [
          { title: { contains: term, mode: 'insensitive' } },
          { project: { contains: term, mode: 'insensitive' } },
          { id: { contains: term, mode: 'insensitive' } },
        ],
      },
      include: { employee: true },
      take: GLOBAL_SEARCH_LIMIT,
      orderBy: { id: 'asc' },
    }),
    prisma.serviceBookEntry.findMany({
      where: {
        OR: [
          { type: { contains: term, mode: 'insensitive' } },
          { description: { contains: term, mode: 'insensitive' } },
        ],
      },
      include: { employee: { select: { id: true, name: true } } },
      take: GLOBAL_SEARCH_LIMIT,
      orderBy: { id: 'asc' },
    }),
  ]);

  res.json({
    employees: employees.map((e) => shapeEmployee(e, { full: false })),
    tasks: tasks.map(shapeTask),
    documents: documents.map((d) => ({
      id: d.id, type: d.type, description: d.description, status: d.status,
      employeeId: d.employee.id, employeeName: d.employee.name,
    })),
  });
});

// Auth
/**
 * @swagger
 * /api/v1/auth/login:
 *   post:
 *     summary: Create auth login
 *     tags: [auth]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 */
app.post('/api/v1/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: "Invalid email or password" });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "Invalid email or password" });

  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, employeeId: user.employeeId },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({
    token,
    user: { role: user.role, name: user.name, title: user.title, initials: user.initials, email: user.email, employeeId: user.employeeId },
  });
});

// An Employee-role token may only reach data scoped to their own linked
// employeeId — HR Admin/Department Head are unrestricted. Returns true and
// sends the 403 itself when blocked, so callers can `if (blocked) return;`.
function blockIfNotSelf(req, res, employeeId) {
  if (req.user.role === 'Employee' && req.user.employeeId !== employeeId) {
    res.status(403).json({ error: "Forbidden — you can only access your own records" });
    return true;
  }
  return false;
}

// Employees
// `page`/`limit` are opt-in — omitting them preserves the original
// return-everything-matching behavior so existing callers (task-assignment
// pickers, analytics, the legal directory) that need the complete scoped
// list keep working unchanged. `q`/`cadre`/`designation` let a paginated
// caller filter server-side instead of having to fetch everything first.
const EMPLOYEE_FLAG_FIELDS = ["promotionDue", "retirementDue", "appraisalPending", "trainingPending", "missingDocs"];

/**
 * @swagger
 * /api/v1/employees:
 *   get:
 *     summary: Get employees
 *     tags: [employees]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/employees', requireAuth, async (req, res) => {
  const {
    department, status, zone, cadre, designation, q, page, limit, flag, highPotential,
    // Real computed-at-read-time filters (not stored columns, same pattern as
    // `highPotential` below) — added so the Command Centre's Smart Alerts
    // rows can deep-link to the actual matching employees instead of dumping
    // the full unfiltered directory, which was the "misleading action"
    // reported for the performance-declining and recently-regularised rows.
    performanceDeclining, regularisationMilestone, retirementBlocked,
  } = req.query;
  const where = {};
  if (department && department !== "All Departments") where.department = department;
  if (zone && zone !== "All Zones") where.zone = zone;
  if (status) where.status = toEnum(status);
  if (cadre && cadre !== "All Cadres") where.cadre = cadre;
  if (designation && designation !== "All Designations") where.designation = designation;
  if (flag && EMPLOYEE_FLAG_FIELDS.includes(flag)) where[flag] = true;
  if (q && q.trim()) {
    const term = q.trim();
    where.OR = [
      { name: { contains: term, mode: 'insensitive' } },
      { id: { contains: term, mode: 'insensitive' } },
      { designation: { contains: term, mode: 'insensitive' } },
    ];
  }

  // highPotential isn't a stored column (it's computed from several relations
  // at read time — see computeHpScore) so it can't be pushed into the SQL
  // where-clause; when requested, fetch the full matching set un-paginated,
  // compute the flag, filter, then paginate in JS below.
  const wantsHpFilter = highPotential === 'true';
  const wantsPerformanceDecliningFilter = performanceDeclining === 'true';
  const wantsRegularisationFilter = regularisationMilestone === 'recent';
  const wantsRetirementBlockedFilter = retirementBlocked === 'true';
  const wantsSpecialFilter = wantsHpFilter || wantsPerformanceDecliningFilter || wantsRegularisationFilter || wantsRetirementBlockedFilter;
  const pageNum = page ? Math.max(1, parseInt(page, 10) || 1) : null;
  const limitNum = limit ? Math.max(1, parseInt(limit, 10) || 50) : null;
  const total = (pageNum && limitNum && !wantsSpecialFilter) ? await prisma.employee.count({ where }) : null;

  const data = await prisma.employee.findMany({
    where,
    orderBy: { id: 'asc' },
    ...(pageNum && limitNum && !wantsSpecialFilter ? { skip: (pageNum - 1) * limitNum, take: limitNum } : {}),
  });

  const ids = data.map((e) => e.id);

  // Batch-fetch each returned employee's average attendance rate (one query,
  // not N) so "present today" can be derived from a real per-employee number.
  const attendanceRows = ids.length
    ? await prisma.attendanceSummary.groupBy({ by: ['employeeId'], where: { employeeId: { in: ids } }, _avg: { presentDays: true, totalDays: true } })
    : [];
  const attendancePctById = new Map(attendanceRows.map((r) => [
    r.employeeId, r._avg.totalDays ? (r._avg.presentDays / r._avg.totalDays) * 100 : 90,
  ]));

  // Batch-fetch just enough per-relation data to run computeHpScore for the
  // whole page — narrow selects, grouped in JS by employeeId, so the
  // directory list can show/filter on the High-Potential flag without the
  // per-employee cost of the full Employee 360 include set.
  const [taskRows, perfRows, trainingRows, skillRows] = ids.length ? await Promise.all([
    prisma.task.findMany({ where: { employeeId: { in: ids } }, select: { employeeId: true, status: true, slaStatus: true } }),
    prisma.performanceRecord.findMany({ where: { employeeId: { in: ids } }, select: { employeeId: true, rating: true, year: true } }),
    prisma.trainingRecord.findMany({ where: { employeeId: { in: ids } }, select: { employeeId: true, status: true } }),
    prisma.employeeSkill.findMany({ where: { employeeId: { in: ids } }, select: { employeeId: true } }),
  ]) : [[], [], [], []];
  const groupByEmployee = (rows) => rows.reduce((map, r) => {
    (map.get(r.employeeId) ?? map.set(r.employeeId, []).get(r.employeeId)).push(r);
    return map;
  }, new Map());
  const tasksByEmp = groupByEmployee(taskRows);
  const perfByEmp = groupByEmployee(perfRows);
  const trainingByEmp = groupByEmployee(trainingRows);
  const skillsByEmp = groupByEmployee(skillRows);

  const hpFlagById = new Map(data.map((e) => {
    const aiFlagged = computeHpScore({
      tasks: tasksByEmp.get(e.id) ?? [],
      performanceRecords: perfByEmp.get(e.id) ?? [],
      trainingRecords: trainingByEmp.get(e.id) ?? [],
      skills: skillsByEmp.get(e.id) ?? [],
      attendance: [{ presentDays: attendancePctById.get(e.id) ?? 90, totalDays: 100 }],
      doj: e.doj,
      disciplinaryFlag: e.disciplinaryFlag,
    }).flagged;
    const hasOverride = e.hiPoOverride !== null && e.hiPoOverride !== undefined;
    return [e.id, hasOverride ? !!e.hiPoOverride : aiFlagged];
  }));

  // Same real signal the Command Centre's smart-alerts endpoint uses: latest
  // recorded rating below the previous year's, from the perf rows already
  // batch-fetched above for this result set.
  const performanceDecliningById = new Map(data.map((e) => {
    const perf = (perfByEmp.get(e.id) ?? []).slice().sort((a, b) => a.year - b.year);
    const latest = perf[perf.length - 1], prev = perf[perf.length - 2];
    return [e.id, !!(latest && prev && latest.rating < prev.rating)];
  }));

  // Real cumulative days-served vs. the actual AMC 900/1800-day regularisation
  // thresholds — "recent" mirrors the smart-alerts endpoint's own 30-day
  // recently-crossed window (a running total of everyone already past the
  // threshold would be nearly the whole workforce, not a useful filter).
  const regularisationMilestoneById = new Map(data.map((e) => {
    if (!e.doj) return [e.id, false];
    const daysServed = Math.round((Date.now() - new Date(e.doj).getTime()) / DAY_MS);
    const recent = (daysServed >= 900 && daysServed <= 930) || (daysServed >= 1800 && daysServed <= 1830);
    return [e.id, recent];
  }));

  // Real retirement-readiness blockers — same three checks as Employee 360's
  // per-employee retirementReadiness (missingDocs, disciplinary flag, or an
  // unverified service-book entry), scoped to retiring within 6 months.
  const unverifiedDocsIds = wantsRetirementBlockedFilter && ids.length
    ? new Set((await prisma.serviceBookEntry.findMany({
        where: { employeeId: { in: ids }, status: { not: 'Verified' } },
        select: { employeeId: true },
      })).map((d) => d.employeeId))
    : new Set();
  const retirementBlockedById = new Map(data.map((e) => {
    const daysToRetirement = e.retirement ? Math.round((new Date(e.retirement).getTime() - Date.now()) / DAY_MS) : null;
    const dueSoon = daysToRetirement != null && daysToRetirement >= 0 && daysToRetirement <= 180;
    const blocked = dueSoon && (e.missingDocs || e.disciplinaryFlag || unverifiedDocsIds.has(e.id));
    return [e.id, !!blocked];
  }));

  let shaped = data.map((e) => ({
    ...shapeEmployee({ ...e, _attendancePct: attendancePctById.get(e.id) ?? 90 }, { full: false }),
    highPotential: hpFlagById.get(e.id) ?? false,
  }));
  if (wantsHpFilter) shaped = shaped.filter((e) => hpFlagById.get(e.id));
  if (wantsPerformanceDecliningFilter) shaped = shaped.filter((e) => performanceDecliningById.get(e.id));
  if (wantsRegularisationFilter) shaped = shaped.filter((e) => regularisationMilestoneById.get(e.id));
  if (wantsRetirementBlockedFilter) shaped = shaped.filter((e) => retirementBlockedById.get(e.id));
  if (wantsSpecialFilter && pageNum && limitNum) shaped = shaped.slice((pageNum - 1) * limitNum, pageNum * limitNum);

  res.json({
    count: shaped.length,
    ...(total !== null ? { total } : {}),
    data: shaped,
  });
});

// Distinct designation values in-scope, for populating the Employee
// Directory's designation filter dropdown without fetching every employee
// row just to read one field off each. Must be declared before the
// `/employees/:id` route below, or Express will match "designations" as an id.
/**
 * @swagger
 * /api/v1/employees/designations:
 *   get:
 *     summary: Get employees designations
 *     tags: [employees]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/employees/designations', requireAuth, async (req, res) => {
  const { department, zone } = req.query;
  const where = {};
  if (department && department !== "All Departments") where.department = department;
  if (zone && zone !== "All Zones") where.zone = zone;
  const rows = await prisma.employee.findMany({ where, distinct: ['designation'], select: { designation: true }, orderBy: { designation: 'asc' } });
  res.json({ data: rows.map((r) => r.designation) });
});

// Workload — open-task count/TAT-days per employee, used to power
// workload-based reassignment suggestions. Must be declared before the
// `/employees/:id` route below, or Express will match "workload" as an id.
/**
 * @swagger
 * /api/v1/employees/workload:
 *   get:
 *     summary: Get employees workload
 *     tags: [employees]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/employees/workload', requireAuth, async (req, res) => {
  const openStatuses = ["Pending", "InProgress", "Escalated", "Overdue"];
  const grouped = await prisma.task.groupBy({
    by: ['employeeId'],
    where: { status: { in: openStatuses } },
    _count: { _all: true },
    _sum: { tatDays: true },
  });
  const employees = await prisma.employee.findMany({
    where: { id: { in: grouped.map((g) => g.employeeId) } },
  });
  const byId = new Map(employees.map((e) => [e.id, e]));
  const data = grouped.map((g) => {
    const e = byId.get(g.employeeId);
    return {
      employeeId: g.employeeId,
      name: e?.name, department: e?.department, cadre: e?.cadre,
      openTaskCount: g._count._all, totalTatDays: g._sum.tatDays || 0,
    };
  }).sort((a, b) => a.openTaskCount - b.openTaskCount);
  res.json({ data });
});

// Consolidated, ranked promotion-ready list — joins eligibility
// (promotionDue), latest APAR rating, training completion, and vigilance
// (disciplinary) clearance into one real, transparent score instead of the
// scattered promotionDue flag used elsewhere. Must be registered before
// '/api/v1/employees/:id' or Express would route this path into that
// handler instead (same reason '/employees/workload' above it is too).
/**
 * @swagger
 * /api/v1/employees/promotion-ready:
 *   get:
 *     summary: Get employees promotion ready
 *     tags: [employees]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/employees/promotion-ready', requireAuth, async (req, res) => {
  if (req.user.role !== 'HRAdmin' && req.user.role !== 'DepartmentHead') {
    return res.status(403).json({ error: "Only HR Admin or Department Head can view the promotion-ready list" });
  }
  const employees = await prisma.employee.findMany({
    where: { promotionDue: true },
    select: {
      id: true, name: true, designation: true, department: true, cadre: true, doj: true,
      disciplinaryFlag: true, trainingPending: true,
      performanceRecords: { orderBy: { year: 'desc' }, take: 1, select: { rating: true } },
      trainingRecords: { select: { status: true } },
    },
  });

  const data = employees.map((e) => {
    const latestRating = e.performanceRecords[0]?.rating ?? null;
    const totalTraining = e.trainingRecords.length;
    const completedTraining = e.trainingRecords.filter((t) => t.status === 'Completed').length;
    const trainingCompletionPct = totalTraining ? Math.round((completedTraining / totalTraining) * 1000) / 10 : 0;
    const seniority = seniorityYears(e.doj) ?? 0;
    // Transparent, real, documented weighting — not a fabricated "AI" score:
    // rating (0-5) dominates, seniority contributes up to 30 points capped,
    // an open disciplinary matter is a hard penalty, pending training a
    // smaller one. Nobody is hidden for a low score — every promotion-due
    // employee appears, ranked, so HR makes the final call (matches how
    // vigilance is surfaced elsewhere in the app: shown, never auto-excluded).
    const score = Math.round(
      (latestRating ?? 0) * 20 +
      Math.min(seniority, 30) -
      (e.disciplinaryFlag ? 50 : 0) -
      (e.trainingPending ? 10 : 0)
    );
    return {
      id: e.id, name: e.name, designation: e.designation, department: e.department, cadre: e.cadre,
      seniorityYears: seniority, latestRating, trainingCompletionPct,
      vigilance: e.disciplinaryFlag ? 'Flagged' : 'Granted',
      score,
    };
  }).sort((a, b) => b.score - a.score);

  res.json({ data });
});

/**
 * @swagger
 * /api/v1/employees/{id}:
 *   get:
 *     summary: Get employees id
 *     tags: [employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/employees/:id', requireAuth, async (req, res) => {
  if (blockIfNotSelf(req, res, req.params.id)) return;
  const emp = await prisma.employee.findUnique({
    where: { id: req.params.id },
    include: {
      tasks: true,
      serviceBookDocs: true,
      compensation: true,
      performanceRecords: { orderBy: { year: 'asc' } },
      trainingRecords: true,
      skills: true,
      attendance: { orderBy: { month: 'desc' } },
      assets: true,
      employeeEvents: { orderBy: { date: 'desc' } },
      manager: true,
      educationRecords: true,
      workExperience: { orderBy: { fromYear: 'desc' } },
    },
  });
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const attendancePct = emp.attendance?.length
    ? (emp.attendance.reduce((s, a) => s + a.presentDays / a.totalDays, 0) / emp.attendance.length) * 100
    : 90;
  const peers = await prisma.employee.findMany({
    where: { department: emp.department, cadre: emp.cadre, id: { not: emp.id } },
    include: { tasks: { select: { status: true, slaStatus: true } }, performanceRecords: true, attendance: true, trainingRecords: true, skills: true, compensation: true },
  });
  const isSelf = req.user.role === 'Employee' && req.user.employeeId === emp.id;
  res.json(shapeEmployee({ ...emp, _attendancePct: attendancePct, _peers: peers }, { isSelf }));
});

// Real payslip for the current pay period — built from the employee's actual
// Compensation and StatutoryCompliance rows. Compensation only stores a
// current snapshot (no month-by-month history), so this deliberately has no
// "Year-to-Date" section — that would require inventing 2-3 months of
// numbers off a single row, which is exactly the fabrication this replaces.
/**
 * @swagger
 * /api/v1/employees/{id}/payslip:
 *   get:
 *     summary: Get employees id payslip
 *     tags: [employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/employees/:id/payslip', requireAuth, async (req, res) => {
  if (blockIfNotSelf(req, res, req.params.id)) return;
  const [employee, compensation, statutory] = await Promise.all([
    prisma.employee.findUnique({ where: { id: req.params.id } }),
    prisma.compensation.findUnique({ where: { employeeId: req.params.id } }),
    prisma.statutoryCompliance.findUnique({ where: { employeeId: req.params.id } }),
  ]);
  if (!employee) return res.status(404).json({ error: "Employee not found" });
  if (!compensation) return res.status(404).json({ error: "No compensation record on file for this employee" });

  const pfContribution = statutory?.pfMonthlyContribution ?? 0;
  const esicContribution = statutory?.esicApplicable ? (statutory.esicMonthlyContribution ?? 0) : 0;
  const tdsDeduction = statutory?.tdsMonthlyDeduction ?? 0;
  const totalDeductions = pfContribution + esicContribution + tdsDeduction;

  const now = new Date();
  res.json({
    employeeId: employee.id,
    name: employee.name,
    designation: employee.designation,
    department: employee.department,
    payPeriod: now.toLocaleDateString("en-IN", { month: "long", year: "numeric" }),
    earnings: {
      basicPay: compensation.basicPay,
      daAmount: compensation.daAmount,
      hraAmount: compensation.hraAmount,
      grossPay: compensation.grossPay,
    },
    deductions: {
      pfContribution,
      esicContribution,
      tdsDeduction,
      totalDeductions,
    },
    netPay: compensation.grossPay - totalDeductions,
  });
});

// Perks — granted off the back of the AI-computed High-Potential flag
// (see computeEmployeeInsights); the flag itself is never stored, only
// what a human decided to do about it.
/**
 * @swagger
 * /api/v1/employees/{id}/perks:
 *   get:
 *     summary: Get employees id perks
 *     tags: [employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/employees/:id/perks', requireAuth, async (req, res) => {
  const rows = await prisma.perk.findMany({ where: { employeeId: req.params.id }, orderBy: { grantedAt: 'desc' } });
  res.json({ data: rows.map((p) => ({ ...p, type: toDisplay(p.type) })) });
});

/**
 * @swagger
 * /api/v1/employees/{id}/perks:
 *   post:
 *     summary: Create employees id perks
 *     tags: [employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.post('/api/v1/employees/:id/perks', requireAuth, async (req, res) => {
  const { type, customLabel, note } = req.body;
  if (!type) return res.status(400).json({ error: "type is required" });
  if (type === 'Other' && !customLabel) return res.status(400).json({ error: "customLabel is required when type is 'Other'" });

  const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!employee) return res.status(404).json({ error: "Employee not found" });

  const perk = await prisma.perk.create({
    data: { employeeId: req.params.id, type: toEnum(type), customLabel: customLabel || null, note: note || null, grantedBy: req.user.email },
  });
  res.status(201).json({ ...perk, type: toDisplay(perk.type) });
});

// High-Potential detail — a performance-driven score trend (the other
// inputs to computeHpScore aren't historized per-year, so only the
// performance component varies across years; everything else is held at
// its current value) plus a same-department/same-cadre peer comparison.
// Both are computed on demand rather than stored, consistent with the flag
// itself being AI/algorithm-computed at read time, not persisted.
/**
 * @swagger
 * /api/v1/employees/{id}/hp-detail:
 *   get:
 *     summary: Get employees id hp detail
 *     tags: [employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/employees/:id/hp-detail', requireAuth, async (req, res) => {
  const employee = await prisma.employee.findUnique({
    where: { id: req.params.id },
    include: { tasks: true, performanceRecords: { orderBy: { year: 'asc' } }, attendance: true, trainingRecords: true, skills: true },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found" });

  const perf = employee.performanceRecords;
  const trend = perf.length >= 2
    ? perf.map((p) => ({ year: p.year, score: computeHpScore(employee, { performancePctOverride: Math.round((p.rating / 5) * 100) }).score }))
    : [];

  const peers = await prisma.employee.findMany({
    where: { department: employee.department, cadre: employee.cadre, id: { not: employee.id } },
    include: { tasks: { select: { status: true, slaStatus: true } }, performanceRecords: true, attendance: true, trainingRecords: true, skills: true },
  });
  const peerScores = peers.map((p) => computeHpScore(p).score);
  const peerCount = peerScores.length;
  const thisScore = computeHpScore(employee).score;
  const peerComparison = peerCount > 0
    ? {
        peerCount,
        peerAvgScore: Math.round(peerScores.reduce((s, v) => s + v, 0) / peerCount),
        percentile: Math.round((peerScores.filter((s) => s < thisScore).length / peerCount) * 100),
        cadre: employee.cadre,
        department: employee.department,
      }
    : { peerCount: 0, peerAvgScore: null, percentile: null, cadre: employee.cadre, department: employee.department };

  res.json({ trend, peerComparison });
});

// High-Potential override — tri-state: true forces the flag on (for someone
// the AI missed), false forces it off (for someone the AI flagged that HR
// wants excluded), null clears the override entirely so the AI score is
// back in sole control (see the hpFlagged blend in computeEmployeeInsights).
app.patch('/api/v1/employees/:id/high-potential', requireAuth, async (req, res) => {
  if (req.user.role !== 'HRAdmin' && req.user.role !== 'DepartmentHead') {
    return res.status(403).json({ error: "Only HR Admin or Department Head can set the High-Potential override" });
  }
  const { flagged } = req.body;
  if (flagged !== true && flagged !== false && flagged !== null) {
    return res.status(400).json({ error: "flagged must be true, false, or null" });
  }

  const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!employee) return res.status(404).json({ error: "Employee not found" });

  const updated = await prisma.employee.update({
    where: { id: req.params.id },
    data: flagged === null
      ? { hiPoOverride: null, hiPoOverrideBy: null, hiPoOverrideAt: null }
      : { hiPoOverride: flagged, hiPoOverrideBy: req.user.email, hiPoOverrideAt: new Date() },
  });
  res.json({
    hiPoOverride: updated.hiPoOverride,
    hiPoOverrideBy: updated.hiPoOverrideBy,
    hiPoOverrideAt: updated.hiPoOverrideAt,
  });
});

// Org chart: returns the manager chain up to the department head and the
// full reporting subtree below the requested employee.
/**
 * @swagger
 * /api/v1/employees/{id}/org-tree:
 *   get:
 *     summary: Get employees id org tree
 *     tags: [employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/employees/:id/org-tree', requireAuth, async (req, res) => {
  const root = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!root) return res.status(404).json({ error: "Employee not found" });

  async function loadSubtree(id, depth) {
    const node = await prisma.employee.findUnique({
      where: { id },
      include: { directReports: depth > 0 ? true : false },
    });
    if (!node) return null;
    const children = depth > 0
      ? await Promise.all(node.directReports.map((child) => loadSubtree(child.id, depth - 1)))
      : [];
    return { id: node.id, name: node.name, designation: node.designation, cadre: node.cadre, department: node.department, directReports: children.filter(Boolean) };
  }

  const chain = [];
  let current = root;
  while (current) {
    chain.unshift({ id: current.id, name: current.name, designation: current.designation, cadre: current.cadre });
    current = current.managerId ? await prisma.employee.findUnique({ where: { id: current.managerId } }) : null;
  }

  const subtree = await loadSubtree(root.id, 3);
  res.json({ managerChain: chain.slice(0, -1), tree: subtree });
});

// Department org chart: the top-of-department employee(s) — no manager, or
// a manager outside the department (e.g. the Commissioner) — with their
// reporting subtree, for the Org 360 view.
/**
 * @swagger
 * /api/v1/departments/{id}/org-tree:
 *   get:
 *     summary: Get departments id org tree
 *     tags: [departments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/departments/:id/org-tree', requireAuth, async (req, res) => {
  const heads = await prisma.employee.findMany({
    where: {
      departmentId: req.params.id,
      OR: [{ managerId: null }, { manager: { departmentId: { not: req.params.id } } }],
    },
    orderBy: { id: 'asc' },
  });

  async function loadSubtree(id, depth) {
    const node = await prisma.employee.findUnique({
      where: { id },
      include: { directReports: depth > 0 ? true : false },
    });
    if (!node) return null;
    const children = depth > 0
      ? await Promise.all(node.directReports.map((child) => loadSubtree(child.id, depth - 1)))
      : [];
    return { id: node.id, name: node.name, designation: node.designation, cadre: node.cadre, department: node.department, directReports: children.filter(Boolean) };
  }

  const trees = await Promise.all(heads.map((h) => loadSubtree(h.id, 3)));
  res.json({ data: trees.filter(Boolean) });
});

// Real "concerned authority" for a department — the same top-of-department
// resolution used by org-tree above, but projected down to just the contact
// fields. This is the one place Grievances and Emergency Alerts both go to
// find a real, contactable person instead of DepartmentProfile's fake headName.
/**
 * @swagger
 * /api/v1/departments/{id}/authority:
 *   get:
 *     summary: Get departments id authority
 *     tags: [departments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/departments/:id/authority', requireAuth, async (req, res) => {
  const dept = await prisma.department.findFirst({ where: { OR: [{ id: req.params.id }, { name: req.params.id }] } });
  if (!dept) return res.status(404).json({ error: "Department not found" });

  const head = await prisma.employee.findFirst({
    where: { departmentId: dept.id, OR: [{ managerId: null }, { manager: { departmentId: { not: dept.id } } }] },
    orderBy: { id: 'asc' },
  });
  if (!head) return res.status(404).json({ error: "No authority found for this department" });

  res.json({
    id: head.id, name: head.name, designation: head.designation, department: dept.name,
    personalEmail: head.personalEmail, phone: head.phone,
  });
});

// Departments
/**
 * @swagger
 * /api/v1/departments:
 *   get:
 *     summary: Get departments
 *     tags: [departments]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/departments', requireAuth, async (req, res) => {
  const data = await prisma.department.findMany({ orderBy: { name: 'asc' } });
  res.json({ data });
});

// Weighted health score breakdown reused for both the Org 360 department
// radial and the department profile card — every input is a live
// aggregate, not a stored/fabricated number. Same 5 weighted factors, but
// exposes each factor's raw metric, its 0-100 component score, how many
// of the 100 points it's contributing, and how many it's leaving on the
// table (the "improvement headroom"), so the Org 360 UI can explain the
// score and point to the single biggest lever instead of showing one
// opaque number.
function computeDeptHealthBreakdown({ attendancePct, slaPct, vacancyRatePct, grievanceRatePct, budgetVariancePct }) {
  const factors = [
    {
      key: "sla", label: "SLA Compliance", weight: 0.30,
      componentScore: slaPct,
      rawLabel: `${slaPct}% of tasks on-track or completed without an SLA breach`,
      suggestion: (gap) => gap > 3
        ? `Recover up to ${gap.toFixed(1)} pts by clearing the current SLA-breached task backlog — this is the single largest weight (30%) in the score.`
        : `SLA compliance is healthy at ${slaPct}%; keep breach rate near-zero to hold this factor's full 30 pts.`,
    },
    {
      key: "attendance", label: "Attendance", weight: 0.25,
      componentScore: attendancePct,
      rawLabel: `${attendancePct}% average attendance across the department`,
      suggestion: (gap) => gap > 3
        ? `Recover up to ${gap.toFixed(1)} pts by improving attendance — check zones/designations with the highest absenteeism in the Workforce module.`
        : `Attendance is strong at ${attendancePct}%; this factor is already contributing nearly its full 25 pts.`,
    },
    {
      key: "vacancy", label: "Vacancy Rate", weight: 0.15,
      componentScore: Math.max(0, 100 - vacancyRatePct * 5),
      rawLabel: `${vacancyRatePct}% of sanctioned posts are currently vacant`,
      suggestion: (gap) => gap > 3
        ? `Recover up to ${gap.toFixed(1)} pts by filling sanctioned vacancies — see the Vacancies module for the exact designations open.`
        : `Vacancy rate of ${vacancyRatePct}% is low impact; this factor is near its full 15 pts.`,
    },
    {
      key: "grievance", label: "Grievance Load", weight: 0.15,
      componentScore: Math.max(0, 100 - grievanceRatePct * 20),
      rawLabel: `${grievanceRatePct.toFixed(2)} pending grievances per 100 employees`,
      suggestion: (gap) => gap > 3
        ? `Recover up to ${gap.toFixed(1)} pts by resolving pending grievances — this factor is heavily penalized (each 1% pending rate costs 20 pts).`
        : `Grievance load is low at ${grievanceRatePct.toFixed(2)} per 100 employees; this factor is near its full 15 pts.`,
    },
    {
      key: "budget", label: "Budget Discipline", weight: 0.15,
      componentScore: Math.max(0, 100 - Math.abs(budgetVariancePct) * 4),
      rawLabel: `${budgetVariancePct >= 0 ? "+" : ""}${budgetVariancePct}% variance between spend and allocated budget`,
      suggestion: (gap) => gap > 3
        ? `Recover up to ${gap.toFixed(1)} pts by bringing spend within ${Math.round(Math.abs(budgetVariancePct) / 2)}% of the allocated budget.`
        : `Budget variance of ${budgetVariancePct}% is within a healthy range; this factor is near its full 15 pts.`,
    },
  ].map((f) => {
    const contribution = Math.round(f.componentScore * f.weight * 10) / 10;
    const maxPoints = Math.round(f.weight * 100 * 10) / 10;
    const gap = Math.round((maxPoints - contribution) * 10) / 10;
    return { ...f, contribution, maxPoints, gap, suggestion: f.suggestion(gap) };
  });

  const score = Math.round(factors.reduce((sum, f) => sum + f.contribution, 0));
  const weakest = [...factors].sort((a, b) => b.gap - a.gap)[0];
  return {
    score,
    factors: factors.map(({ key, label, weight, componentScore, rawLabel, contribution, maxPoints, gap, suggestion }) => ({
      key, label, weightPct: Math.round(weight * 100), componentScore: Math.round(componentScore),
      rawLabel, contribution, maxPoints, gap, suggestion,
    })),
    topImprovement: weakest ? { factor: weakest.key, label: weakest.label, suggestion: weakest.suggestion, potentialGain: weakest.gap } : null,
  };
}

// Org 360 — department profile: stored head/budget/audit facts plus live
// counts (pending grievances, active projects, vacancy gap, health score)
// computed from real rows so the numbers move as the underlying data does.
/**
 * @swagger
 * /api/v1/org/departments/{id}/profile:
 *   get:
 *     summary: Get org departments id profile
 *     tags: [org]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/org/departments/:id/profile', requireAuth, async (req, res) => {
  const deptId = req.params.id;
  const dept = await prisma.department.findUnique({ where: { id: deptId } });
  if (!dept) return res.status(404).json({ error: "Department not found" });

  const [profile, employeeCount, vacancyRows, projectCount, pendingGrievances, tasks, financeRows, attendanceAgg] = await Promise.all([
    prisma.departmentProfile.findUnique({ where: { department: deptId } }),
    prisma.employee.count({ where: { departmentId: deptId } }),
    prisma.vacancy.findMany({ where: { department: deptId } }),
    prisma.project.count({ where: { department: deptId, status: { not: "Completed" } } }),
    prisma.grievance.count({ where: { department: dept.name, status: { in: ["New", "UnderInvestigation", "Escalated"] } } }),
    prisma.task.findMany({ where: { department: dept.name }, select: { status: true, slaStatus: true } }),
    prisma.departmentFinance.groupBy({ by: ['department'], where: { department: deptId }, _sum: { amountSpent: true, allocatedBudget: true } }),
    prisma.$queryRaw`SELECT AVG("presentDays"::float / NULLIF("totalDays", 0)) as avg FROM attendance_summary a JOIN employees e ON e."id" = a."employeeId" WHERE e."departmentId" = ${deptId}`,
  ]);

  const filledByDesignation = await prisma.employee.groupBy({
    by: ['designation'],
    where: { departmentId: deptId, designation: { in: vacancyRows.map((v) => v.designation) } },
    _count: { _all: true },
  });
  const filledMap = new Map(filledByDesignation.map((f) => [f.designation, f._count._all]));
  const vacancyCount = vacancyRows.reduce((sum, v) => sum + Math.max(0, v.sanctioned - (filledMap.get(v.designation) || 0)), 0);

  const slaBreaches = tasks.filter((t) => t.slaStatus === "Breached").length;
  const slaPct = tasks.length ? Math.round(((tasks.length - slaBreaches) / tasks.length) * 100) : 100;
  const attendancePct = Math.round((Number(attendanceAgg?.[0]?.avg) || 0.9) * 100);
  const vacancyRatePct = employeeCount ? Math.round((vacancyCount / employeeCount) * 100) : 0;
  const grievanceRatePct = employeeCount ? (pendingGrievances / employeeCount) * 100 : 0;
  const finance = financeRows[0];
  const budgetVariancePct = finance?._sum.allocatedBudget
    ? Math.round((((finance._sum.amountSpent || 0) - finance._sum.allocatedBudget) / finance._sum.allocatedBudget) * 1000) / 10
    : 0;

  const healthBreakdown = computeDeptHealthBreakdown({ attendancePct, slaPct, vacancyRatePct, grievanceRatePct, budgetVariancePct });

  res.json({
    department: dept.name, departmentId: deptId,
    headName: profile?.headName || "Unassigned", headTitle: profile?.headTitle || "Department Head",
    budgetCr: profile?.budgetCr || 0, auditStatus: profile?.auditStatus || "Clean", lastAuditDate: profile?.lastAuditDate || null,
    employeeCount, pendingGrievances, activeProjects: projectCount, vacancyCount,
    slaPct, attendancePct, vacancyRatePct, grievanceRatePct, budgetVariancePct,
    healthScore: healthBreakdown.score,
    healthBreakdown,
  });
});

// Bulk variant of the profile endpoint above, for the Org 360 grid view —
// one batch of vectorized queries across all departments instead of 24
// sequential round trips.
// Real ward areas (sq km) from the same AMC civic-audit data used to seed
// employees' `ward` field (see prisma/seed.js WARD_AREAS / scripts/backfill-
// wards.js) — kept here too since server.js has no shared-constants import
// path to seed.js (a run-once script, not a module).
const WARD_AREAS_SQKM = {
  Khadia: 3.26, "Saraspur-Rakhial": 3.39, Thakkarbapanagar: 3.48,
  Navrangpura: 11.98, Chandkheda: 11.90,
  Bodakdev: 13.78, Thaltej: 32.18, Gota: 30.00,
  "Bhaipura-Hatkeshwar": 1.94, Vastral: 13.46,
  Maktampura: 26.20, Lambha: 44.54,
};

// Spatial Workforce Allocation — real worker-density-per-ward, the same kind
// of figure the AI-HRMS blueprint's civic audit used to expose the Khadia
// (233.74 workers/sq km) vs. Lambha (5.47 workers/sq km) disparity. Flags
// wards above/below the citywide average density as over/understaffed.
/**
 * @swagger
 * /api/v1/org/wards:
 *   get:
 *     summary: Get org wards
 *     tags: [org]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/org/wards', requireAuth, async (req, res) => {
  const rows = await prisma.employee.groupBy({
    by: ['ward', 'zone'],
    where: { ward: { not: null }, status: 'Active' },
    _count: { _all: true },
  });
  const wards = rows
    .filter((r) => WARD_AREAS_SQKM[r.ward] != null)
    .map((r) => ({
      ward: r.ward, zone: r.zone, workerCount: r._count._all,
      areaSqKm: WARD_AREAS_SQKM[r.ward],
      workersPerSqKm: Math.round((r._count._all / WARD_AREAS_SQKM[r.ward]) * 100) / 100,
    }))
    .sort((a, b) => b.workersPerSqKm - a.workersPerSqKm);

  const avgDensity = wards.length ? wards.reduce((s, w) => s + w.workersPerSqKm, 0) / wards.length : 0;
  const data = wards.map((w) => ({
    ...w,
    status: w.workersPerSqKm > avgDensity * 1.5 ? 'Overstaffed' : w.workersPerSqKm < avgDensity * 0.5 ? 'Understaffed' : 'Balanced',
  }));

  res.json({ data, avgDensity: Math.round(avgDensity * 100) / 100 });
});

/**
 * @swagger
 * /api/v1/org/departments/profiles:
 *   get:
 *     summary: Get org departments profiles
 *     tags: [org]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/org/departments/profiles', requireAuth, async (req, res) => {
  const [departments, profiles, employeeCounts, vacancies, projectCounts, grievanceCounts, taskRows, financeRows, attendanceRows] = await Promise.all([
    prisma.department.findMany(),
    prisma.departmentProfile.findMany(),
    prisma.employee.groupBy({ by: ['departmentId'], _count: { _all: true } }),
    prisma.vacancy.findMany(),
    prisma.project.groupBy({ by: ['department'], where: { status: { not: "Completed" } }, _count: { _all: true } }),
    prisma.grievance.groupBy({ by: ['department'], where: { status: { in: ["New", "UnderInvestigation", "Escalated"] } }, _count: { _all: true } }),
    prisma.task.findMany({ select: { department: true, slaStatus: true } }),
    prisma.departmentFinance.groupBy({ by: ['department'], _sum: { amountSpent: true, allocatedBudget: true } }),
    prisma.$queryRaw`SELECT e."departmentId" as dept, AVG("presentDays"::float / NULLIF("totalDays", 0)) as avg FROM attendance_summary a JOIN employees e ON e."id" = a."employeeId" GROUP BY e."departmentId"`,
  ]);

  const filledByDeptDesignation = await prisma.employee.groupBy({ by: ['departmentId', 'designation'], _count: { _all: true } });
  const filledMap = new Map(filledByDeptDesignation.map((f) => [`${f.departmentId}::${f.designation}`, f._count._all]));

  const profileByDept = new Map(profiles.map((p) => [p.department, p]));
  const employeeCountByDept = new Map(employeeCounts.map((c) => [c.departmentId, c._count._all]));
  const projectCountByDept = new Map(projectCounts.map((c) => [c.department, c._count._all]));
  const grievanceCountByDept = new Map(grievanceCounts.map((c) => [c.department, c._count._all]));
  const financeByDept = new Map(financeRows.map((f) => [f.department, f._sum]));
  const attendanceByDept = new Map(attendanceRows.map((a) => [a.dept, Number(a.avg) || 0.9]));
  const vacancyByDept = new Map();
  for (const v of vacancies) {
    if (!vacancyByDept.has(v.department)) vacancyByDept.set(v.department, []);
    vacancyByDept.get(v.department).push(v);
  }
  const taskStatsByDept = new Map();
  for (const t of taskRows) {
    if (!taskStatsByDept.has(t.department)) taskStatsByDept.set(t.department, { total: 0, breached: 0 });
    const rec = taskStatsByDept.get(t.department);
    rec.total += 1;
    if (t.slaStatus === "Breached") rec.breached += 1;
  }

  const data = departments.map((dept) => {
    const profile = profileByDept.get(dept.id);
    const employeeCount = employeeCountByDept.get(dept.id) || 0;
    const vacancyRows = vacancyByDept.get(dept.id) || [];
    const vacancyCount = vacancyRows.reduce((sum, v) => sum + Math.max(0, v.sanctioned - (filledMap.get(`${dept.id}::${v.designation}`) || 0)), 0);
    const pendingGrievances = grievanceCountByDept.get(dept.name) || 0;
    const taskStats = taskStatsByDept.get(dept.name) || { total: 0, breached: 0 };
    const slaPct = taskStats.total ? Math.round(((taskStats.total - taskStats.breached) / taskStats.total) * 100) : 100;
    const attendancePct = Math.round((attendanceByDept.get(dept.id) || 0.9) * 100);
    const vacancyRatePct = employeeCount ? Math.round((vacancyCount / employeeCount) * 100) : 0;
    const grievanceRatePct = employeeCount ? (pendingGrievances / employeeCount) * 100 : 0;
    const finance = financeByDept.get(dept.id);
    const budgetVariancePct = finance?.allocatedBudget
      ? Math.round((((finance.amountSpent || 0) - finance.allocatedBudget) / finance.allocatedBudget) * 1000) / 10
      : 0;
    const healthBreakdown = computeDeptHealthBreakdown({ attendancePct, slaPct, vacancyRatePct, grievanceRatePct, budgetVariancePct });
    return {
      department: dept.name, departmentId: dept.id,
      headName: profile?.headName || "Unassigned", headTitle: profile?.headTitle || "Department Head",
      budgetCr: profile?.budgetCr || 0, auditStatus: profile?.auditStatus || "Clean", lastAuditDate: profile?.lastAuditDate || null,
      employeeCount, pendingGrievances, activeProjects: projectCountByDept.get(dept.id) || 0, vacancyCount,
      slaPct, attendancePct, vacancyRatePct, grievanceRatePct, budgetVariancePct,
      healthScore: healthBreakdown.score,
      healthBreakdown,
    };
  });

  res.json({ data });
});

/**
 * @swagger
 * /api/v1/org/departments/{id}/vacancies:
 *   get:
 *     summary: Get org departments id vacancies
 *     tags: [org]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/org/departments/:id/vacancies', requireAuth, async (req, res) => {
  const deptId = req.params.id;
  const vacancyRows = await prisma.vacancy.findMany({ where: { department: deptId } });
  const filledByDesignation = await prisma.employee.groupBy({
    by: ['designation'],
    where: { departmentId: deptId, designation: { in: vacancyRows.map((v) => v.designation) } },
    _count: { _all: true },
  });
  const filledMap = new Map(filledByDesignation.map((f) => [f.designation, f._count._all]));
  const data = vacancyRows.map((v) => {
    const filled = filledMap.get(v.designation) || 0;
    return { designation: v.designation, sanctioned: v.sanctioned, filled, open: Math.max(0, v.sanctioned - filled), criticality: v.criticality, note: v.note };
  });
  res.json({ data });
});

/**
 * @swagger
 * /api/v1/org/departments/{id}/projects:
 *   get:
 *     summary: Get org departments id projects
 *     tags: [org]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/org/departments/:id/projects', requireAuth, async (req, res) => {
  const data = await prisma.project.findMany({ where: { department: req.params.id }, orderBy: { targetDate: 'asc' } });
  res.json({ data });
});

/**
 * @swagger
 * /api/v1/org/departments/{id}/assets:
 *   get:
 *     summary: Get org departments id assets
 *     tags: [org]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/org/departments/:id/assets', requireAuth, async (req, res) => {
  const rows = await prisma.asset.groupBy({
    by: ['type', 'status'],
    where: { employee: { departmentId: req.params.id } },
    _count: { _all: true },
  });
  res.json({ data: rows.map((r) => ({ type: r.type, status: r.status, count: r._count._all })) });
});

// Tasks
// `page`/`limit` are opt-in (same convention as GET /employees) — omitting
// them preserves the original return-everything behavior for callers that
// need the full scoped list (e.g. project-grouped view). Loading ALL tasks
// unfiltered on every page visit was the Task Management page's confirmed
// performance bug; the default page size going forward is 10 (frontend-set).
/**
 * @swagger
 * /api/v1/tasks:
 *   get:
 *     summary: Get tasks
 *     tags: [tasks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/tasks', requireAuth, async (req, res) => {
  const { department, zone, status, priority, project, q, page, limit } = req.query;
  const where = {};
  if (department && department !== "All Departments") where.department = department;
  if (zone && zone !== "All Zones") where.employee = { zone };
  if (status) where.status = toEnum(status);
  if (priority && priority !== "All Priorities") where.priority = priority;
  if (project) where.project = project;
  if (q && q.trim()) {
    const term = q.trim();
    where.OR = [
      { title: { contains: term, mode: 'insensitive' } },
      { project: { contains: term, mode: 'insensitive' } },
      { id: { contains: term, mode: 'insensitive' } },
    ];
  }

  const pageNum = page ? Math.max(1, parseInt(page, 10) || 1) : null;
  const limitNum = limit ? Math.max(1, parseInt(limit, 10) || 10) : null;
  const total = (pageNum && limitNum) ? await prisma.task.count({ where }) : null;

  const data = await prisma.task.findMany({
    where,
    orderBy: { id: 'asc' },
    include: { employee: true },
    ...(pageNum && limitNum ? { skip: (pageNum - 1) * limitNum, take: limitNum } : {}),
  });
  res.json({ count: data.length, ...(total !== null ? { total } : {}), data: data.map(shapeTask) });
});

// Lightweight per-project rollup for the "By Project" view — name + counts
// only, so switching to that view doesn't pull every task's full row (title,
// AI summary, employee join, etc.) for every project just to show a list of
// project names; the full task list for one project loads on-demand when
// the user actually expands it (see the `project` filter above).
/**
 * @swagger
 * /api/v1/tasks/projects:
 *   get:
 *     summary: Get tasks projects
 *     tags: [tasks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/tasks/projects', requireAuth, async (req, res) => {
  const { department, zone, status, q } = req.query;
  const where = {};
  if (department && department !== "All Departments") where.department = department;
  if (zone && zone !== "All Zones") where.employee = { zone };
  if (status) where.status = toEnum(status);
  if (q && q.trim()) {
    const term = q.trim();
    where.OR = [
      { title: { contains: term, mode: 'insensitive' } },
      { project: { contains: term, mode: 'insensitive' } },
      { id: { contains: term, mode: 'insensitive' } },
    ];
  }

  const [totals, completed] = await Promise.all([
    prisma.task.groupBy({ by: ['project'], where, _count: { _all: true } }),
    prisma.task.groupBy({ by: ['project'], where: { ...where, status: 'Completed' }, _count: { _all: true } }),
  ]);
  const completedByProject = new Map(completed.map((c) => [c.project, c._count._all]));
  const data = totals
    .map((t) => ({ project: t.project, total: t._count._all, completed: completedByProject.get(t.project) || 0 }))
    .sort((a, b) => b.total - a.total);
  res.json({ data });
});

// Real per-zone task stats (Task has no direct zone column — zone lives on
// the assigned employee — so this fetches the narrow join and reduces
// in-memory, same approach as this file's other zone/department rollups).
/**
 * @swagger
 * /api/v1/tasks/zone-stats:
 *   get:
 *     summary: Get tasks zone stats
 *     tags: [tasks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/tasks/zone-stats', requireAuth, async (req, res) => {
  const rows = await prisma.task.findMany({
    select: { status: true, slaStatus: true, tatDays: true, employee: { select: { zone: true } } },
  });
  const byZone = new Map();
  for (const t of rows) {
    const zone = t.employee?.zone;
    if (!zone) continue;
    if (!byZone.has(zone)) byZone.set(zone, { zone, total: 0, completed: 0, overdue: 0, tatSum: 0 });
    const bucket = byZone.get(zone);
    bucket.total += 1;
    if (t.status === "Completed") bucket.completed += 1;
    if (t.status === "Overdue" || t.slaStatus === "Breached") bucket.overdue += 1;
    bucket.tatSum += t.tatDays || 0;
  }
  const data = [...byZone.values()].map((b) => ({
    zone: b.zone, total: b.total, completed: b.completed, overdue: b.overdue,
    avgTatDays: b.total ? Math.round((b.tatSum / b.total) * 10) / 10 : 0,
    slaPct: b.total ? Math.round(((b.total - b.overdue) / b.total) * 100) : 100,
  })).sort((a, b) => b.total - a.total);
  res.json({ data });
});

// Real 6-month (default) task-efficiency trend, read from the seeded
// TaskMonthlySnapshot rollup — Task itself has no history (updatedAt is
// overwritten on every reassignment), so this is the only source of a real
// "previous month's progress" comparison.
function summarizeMonthlyRows(rows, monthsNum) {
  const byMonth = new Map();
  for (const r of rows) {
    if (!byMonth.has(r.month)) byMonth.set(r.month, { month: r.month, totalTasks: 0, completedTasks: 0, overdueTasks: 0, tatWeighted: 0 });
    const bucket = byMonth.get(r.month);
    bucket.totalTasks += r.totalTasks;
    bucket.completedTasks += r.completedTasks;
    bucket.overdueTasks += r.overdueTasks;
    bucket.tatWeighted += r.avgTatDays * r.totalTasks;
  }
  return [...byMonth.values()].slice(-monthsNum).map((b) => ({
    month: b.month,
    totalTasks: b.totalTasks,
    completedTasks: b.completedTasks,
    overdueTasks: b.overdueTasks,
    completionRatePct: b.totalTasks ? Math.round((b.completedTasks / b.totalTasks) * 100) : 0,
    avgTatDays: b.totalTasks ? Math.round((b.tatWeighted / b.totalTasks) * 10) / 10 : 0,
  }));
}

/**
 * @swagger
 * /api/v1/tasks/trend:
 *   get:
 *     summary: Get tasks trend
 *     tags: [tasks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/tasks/trend', requireAuth, async (req, res) => {
  const { department, zone, months, compare } = req.query;
  const monthsNum = Math.max(1, Math.min(24, parseInt(months, 10) || 6));
  const hasScope = (department && department !== "All Departments") || (zone && zone !== "All Zones");

  // Comparing the fully org-wide aggregate flattens ~168 department/zone
  // combinations into a near-constant band, hiding the real variation that
  // exists per combination — so when nothing is scoped, return the genuinely
  // best/weakest real combos as separate named series instead of one line.
  if (compare === 'true' && !hasScope) {
    const allRows = await prisma.taskMonthlySnapshot.findMany({ orderBy: { month: 'asc' } });
    const byKey = new Map();
    for (const r of allRows) {
      const key = `${r.department}||${r.zone}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
    const ranked = [...byKey.entries()].map(([key, rows]) => {
      const latest = rows[rows.length - 1];
      const rate = latest.totalTasks ? latest.completedTasks / latest.totalTasks : 0;
      return { key, rows, rate };
    }).sort((a, b) => b.rate - a.rate);

    const picks = [
      ...ranked.slice(0, 2).map((r) => ({ ...r, tag: 'best' })),
      ...ranked.slice(-2).map((r) => ({ ...r, tag: 'weakest' })),
    ];
    const series = picks.map(({ key, rows, tag }) => {
      const [dept, z] = key.split("||");
      return { label: `${dept} · ${z} (${tag})`, department: dept, zone: z, data: summarizeMonthlyRows(rows, monthsNum) };
    });
    return res.json({ data: summarizeMonthlyRows(allRows, monthsNum), series });
  }

  const where = {};
  if (department && department !== "All Departments") where.department = department;
  if (zone && zone !== "All Zones") where.zone = zone;
  const rows = await prisma.taskMonthlySnapshot.findMany({ where, orderBy: { month: 'asc' } });
  res.json({ data: summarizeMonthlyRows(rows, monthsNum) });
});

// Task detail — the task plus its assignee's real place in the org
// hierarchy (manager chain + direct reports, reusing the org-tree logic
// already built for Employee 360) and the assignee's own task load, so
// "who's involved and what's their bigger picture" is answerable from one
// click instead of navigating away.
/**
 * @swagger
 * /api/v1/tasks/{id}/detail:
 *   get:
 *     summary: Get tasks id detail
 *     tags: [tasks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/tasks/:id/detail', requireAuth, async (req, res) => {
  const task = await prisma.task.findUnique({ where: { id: req.params.id }, include: { employee: true } });
  if (!task) return res.status(404).json({ error: "Task not found" });

  const assignee = task.employee;
  const chain = [];
  let current = assignee;
  while (current) {
    chain.unshift({ id: current.id, name: current.name, designation: current.designation, cadre: current.cadre });
    current = current.managerId ? await prisma.employee.findUnique({ where: { id: current.managerId } }) : null;
  }
  const directReports = await prisma.employee.findMany({
    where: { managerId: assignee.id },
    select: { id: true, name: true, designation: true, cadre: true },
    orderBy: { id: 'asc' },
  });

  const assigneeTasks = await prisma.task.findMany({ where: { employeeId: assignee.id }, select: { status: true } });
  const taskSummary = {
    total: assigneeTasks.length,
    open: assigneeTasks.filter((t) => t.status !== "Completed").length,
    completed: assigneeTasks.filter((t) => t.status === "Completed").length,
    overdue: assigneeTasks.filter((t) => t.status === "Overdue").length,
  };

  res.json({
    task: shapeTask(task),
    assignee: {
      id: assignee.id, name: assignee.name, designation: assignee.designation,
      department: assignee.department, cadre: assignee.cadre, zone: assignee.zone,
      status: toDisplay(assignee.status),
    },
    managerChain: chain.slice(0, -1),
    directReports,
    taskSummary,
  });
});

// Real AI productivity suggestion — computes actual completion/breach rates
// per department+zone from the seeded monthly history, picks the weakest
// real one, and asks server-ai to narrate a concrete manpower suggestion
// naming that actual department/zone (never generic boilerplate).
/**
 * @swagger
 * /api/v1/tasks/productivity-insight:
 *   get:
 *     summary: Get tasks productivity insight
 *     tags: [tasks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/tasks/productivity-insight', requireAuth, async (req, res) => {
  const rows = await prisma.taskMonthlySnapshot.findMany({ orderBy: { month: 'asc' } });
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.department}||${r.zone}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const findings = [...byKey.entries()].map(([key, months]) => {
    const [department, zone] = key.split("||");
    const latest = months[months.length - 1];
    const earliest = months[0];
    const latestRate = latest.totalTasks ? latest.completedTasks / latest.totalTasks : 0;
    const earliestRate = earliest.totalTasks ? earliest.completedTasks / earliest.totalTasks : 0;
    return {
      department, zone,
      completionRatePct: Math.round(latestRate * 100),
      trendPct: Math.round((latestRate - earliestRate) * 100),
      overdueTasks: latest.overdueTasks,
      avgTatDays: latest.avgTatDays,
      headcount: latest.totalTasks,
    };
  });
  findings.sort((a, b) => a.completionRatePct - b.completionRatePct || a.trendPct - b.trendPct);
  const weakest = findings[0];
  const strongest = findings[findings.length - 1];

  let narrative = null;
  let recommendedAction = null;
  try {
    const aiRes = await fetch(`${AI_API_URL}/api/v1/tasks/productivity-insight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weakest, strongest, sampleSize: findings.length }),
    });
    if (aiRes.ok) ({ narrative, recommendedAction } = await aiRes.json());
  } catch {
    // AI service unreachable — the real numbers below still stand on their own.
  }
  if (!narrative) {
    narrative = `${weakest.department} (${weakest.zone} zone) has the lowest task completion rate at ${weakest.completionRatePct}% with ${weakest.overdueTasks} overdue task(s) and a ${weakest.avgTatDays}-day average turnaround, ${weakest.trendPct <= 0 ? "trending flat or worse" : "though improving"} over the last 6 months.`;
    recommendedAction = `Consider redistributing task load or adding manpower to ${weakest.department} (${weakest.zone} zone); ${strongest.department} (${strongest.zone} zone) is comparatively over-performing at ${strongest.completionRatePct}% completion and may have capacity to share resources or best practices.`;
  }

  res.json({ weakest, strongest, narrative, recommendedAction });
});

// Builds the create() data for a single task row (minus id/employeeId, which
// callers supply) — shared by the single-task and bulk-create endpoints.
function buildTaskFields({ title, category, department, employeeId, priority, sow, milestone, eta, projectedCompletion }, createdBy) {
  const today = new Date();
  let dueIn = 7;
  if (eta) {
    const etaDate = new Date(eta);
    if (!Number.isNaN(etaDate.getTime())) {
      dueIn = Math.round((etaDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
    }
  }
  const tatDays = Math.max(dueIn, 1);
  const slaStatus = dueIn < 0 ? "Breached" : dueIn < 3 ? "AtRisk" : "OnTrack";

  return {
    title,
    category: category || "Inspection",
    department: department || "Administration",
    employeeId,
    priority: priority || "Medium",
    dueIn,
    tatDays,
    slaStatus,
    createdBy,
    updatedAt: new Date().toISOString().slice(0, 10),
    status: "Pending",
    aiSummary: `${category || "Inspection"} task assigned. TAT ${tatDays}d · ${toDisplay(slaStatus)}.`,
    delayRisk: dueIn < 0 ? "High" : dueIn < 3 ? "Medium" : "Low",
    sow: sow || null,
    milestone: milestone || null,
    eta: eta || null,
    projectedCompletion: projectedCompletion || null,
  };
}

/**
 * @swagger
 * /api/v1/tasks:
 *   post:
 *     summary: Create tasks
 *     tags: [tasks]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.post('/api/v1/tasks', requireAuth, async (req, res) => {
  const { title, project, employeeId } = req.body;
  if (!title || !employeeId) return res.status(400).json({ error: "title and employeeId are required" });

  const assignee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!assignee) return res.status(400).json({ error: "employeeId does not match a known employee" });

  const count = await prisma.task.count();
  const task = await prisma.task.create({
    data: {
      id: `TSK-${2400 + count + 1}`,
      project: project || title,
      ...buildTaskFields(req.body, req.user.email),
    },
  });
  res.status(201).json(shapeTask({ ...task, employeeName: assignee.name, employeeStatus: toDisplay(assignee.status) }));
});

// Creates multiple tasks under one shared project in a single request, so a
// project doesn't have to be built one task-at-a-time.
/**
 * @swagger
 * /api/v1/tasks/bulk:
 *   post:
 *     summary: Create tasks bulk
 *     tags: [tasks]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.post('/api/v1/tasks/bulk', requireAuth, async (req, res) => {
  const { project, department: sharedDepartment, tasks: rows } = req.body;
  if (!project || !Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "project and a non-empty tasks array are required" });
  }
  for (const row of rows) {
    if (!row.title || !row.employeeId) return res.status(400).json({ error: "each task requires title and employeeId" });
  }

  const employeeIds = [...new Set(rows.map((r) => r.employeeId))];
  const assignees = await prisma.employee.findMany({ where: { id: { in: employeeIds } } });
  const assigneeById = new Map(assignees.map((a) => [a.id, a]));
  const missing = employeeIds.filter((id) => !assigneeById.has(id));
  if (missing.length > 0) return res.status(400).json({ error: `Unknown employeeId(s): ${missing.join(", ")}` });

  const count = await prisma.task.count();
  const created = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const task = await prisma.task.create({
      data: {
        id: `TSK-${2400 + count + i + 1}`,
        project,
        ...buildTaskFields({ ...row, department: row.department || sharedDepartment }, req.user.email),
      },
    });
    const assignee = assigneeById.get(row.employeeId);
    created.push(shapeTask({ ...task, employeeName: assignee.name, employeeStatus: toDisplay(assignee.status) }));
  }
  res.status(201).json({ data: created });
});

async function performReassign(req, res, { requireSameDepartment } = {}) {
  const { employeeId, reason, note } = req.body;
  if (!employeeId) return res.status(400).json({ error: "employeeId is required" });

  const [existing, assignee] = await Promise.all([
    prisma.task.findUnique({ where: { id: req.params.id } }),
    prisma.employee.findUnique({ where: { id: employeeId } }),
  ]);
  if (!existing) return res.status(404).json({ error: "Task not found" });
  if (!assignee) return res.status(400).json({ error: "employeeId does not match a known employee" });

  const task = await prisma.task.update({
    where: { id: req.params.id },
    data: {
      employeeId,
      department: assignee.department,
      lastReassignedFrom: existing.employeeId,
      lastReassignReason: reason || (requireSameDepartment ? "Reallocation" : "Manual"),
      lastReassignedAt: new Date().toISOString().slice(0, 10),
      ...(note ? { aiSummary: `${existing.aiSummary} Reassignment note: ${note}` } : {}),
    },
  });
  res.json({ message: "Task reassigned successfully", task: shapeTask({ ...task, employeeName: assignee.name }) });
}

/**
 * @swagger
 * /api/v1/tasks/{id}/reassign:
 *   put:
 *     summary: Update tasks id reassign
 *     tags: [tasks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.put('/api/v1/tasks/:id/reassign', requireAuth, (req, res) => performReassign(req, res));

/**
 * @swagger
 * /api/v1/tasks/{id}/reallocate:
 *   put:
 *     summary: Update tasks id reallocate
 *     tags: [tasks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.put('/api/v1/tasks/:id/reallocate', requireAuth, (req, res) => performReassign(req, res, { requireSameDepartment: true }));

/**
 * @swagger
 * /api/v1/tasks/escalate:
 *   post:
 *     summary: Create tasks escalate
 *     tags: [tasks]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.post('/api/v1/tasks/escalate', requireAuth, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids array is required" });

  const tasks = await prisma.task.findMany({ where: { id: { in: ids } }, include: { employee: true } });
  const foundIds = new Set(tasks.map((t) => t.id));
  const missing = ids.filter((id) => !foundIds.has(id));
  if (missing.length > 0) return res.status(404).json({ error: `Unknown task id(s): ${missing.join(", ")}` });

  const updated = [];
  for (const t of tasks) {
    const task = await prisma.task.update({
      where: { id: t.id },
      data: { status: "Escalated", aiSummary: `${t.aiSummary} Escalated by ${req.user.email}.` },
    });
    updated.push(shapeTask({ ...task, employee: t.employee }));
  }
  res.json({ data: updated });
});

/**
 * @swagger
 * /api/v1/tasks/{id}:
 *   delete:
 *     summary: Delete tasks id
 *     tags: [tasks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.delete('/api/v1/tasks/:id', requireAuth, async (req, res) => {
  const task = await prisma.task.findUnique({ where: { id: req.params.id } });
  if (!task) return res.status(404).json({ error: "Task not found" });
  await prisma.task.delete({ where: { id: req.params.id } });
  res.json({ message: "Task deleted successfully", id: req.params.id });
});

// Service book / OCR documents — the Document Vault's Library tab. 18k+ real
// rows exist, so this is filtered + paginated server-side rather than ever
// shipping the full table to the client.
/**
 * @swagger
 * /api/v1/service-book:
 *   get:
 *     summary: Get service book
 *     tags: [service-book]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/service-book', requireAuth, async (req, res) => {
  const { type, status, q, department, page, limit } = req.query;
  const where = {};
  if (type && type !== "All Types") where.type = type;
  if (status && status !== "All Status") where.status = toEnum(status);
  if (department && department !== "All Departments") where.employee = { department };
  if (q && q.trim()) {
    const term = q.trim();
    where.OR = [
      { employeeId: { contains: term, mode: 'insensitive' } },
      { employee: { name: { contains: term, mode: 'insensitive' } } },
    ];
  }

  const pageNum = page ? Math.max(1, parseInt(page, 10) || 1) : 1;
  const limitNum = limit ? Math.max(1, parseInt(limit, 10) || 25) : 25;
  const [total, rows] = await Promise.all([
    prisma.serviceBookEntry.count({ where }),
    prisma.serviceBookEntry.findMany({
      where,
      include: { employee: { select: { name: true, department: true } } },
      orderBy: { id: 'asc' },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
    }),
  ]);
  const data = rows.map(({ employee, ...d }) => ({
    ...shapeServiceBookEntry(d),
    employeeName: employee.name,
    department: employee.department,
  }));
  res.json({ count: data.length, total, page: pageNum, totalPages: Math.max(1, Math.ceil(total / limitNum)), data });
});

// Distinct document types, for the Library tab's filter dropdown — independent
// of the current page/filter so the full type list is always available.
/**
 * @swagger
 * /api/v1/service-book/types:
 *   get:
 *     summary: Get service book types
 *     tags: [service-book]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/service-book/types', requireAuth, async (req, res) => {
  const rows = await prisma.serviceBookEntry.findMany({ distinct: ['type'], select: { type: true }, orderBy: { type: 'asc' } });
  res.json({ data: rows.map((r) => r.type) });
});

// Document Vault KPI strip — real counts/averages instead of hand-typed numbers.
/**
 * @swagger
 * /api/v1/service-book/stats:
 *   get:
 *     summary: Get service book stats
 *     tags: [service-book]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/service-book/stats', requireAuth, async (req, res) => {
  const [total, byStatus, ocrAgg, typeCount] = await Promise.all([
    prisma.serviceBookEntry.count(),
    prisma.serviceBookEntry.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.serviceBookEntry.aggregate({ where: { ocrScore: { gt: 0 } }, _avg: { ocrScore: true } }),
    prisma.serviceBookEntry.findMany({ distinct: ['type'], select: { type: true } }),
  ]);
  const countFor = (s) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
  const verified = countFor('Verified');
  const pendingReview = countFor('PendingReview');
  const missing = countFor('Missing');
  res.json({
    digitized: total,
    pendingReview,
    ocrAccuracyPct: ocrAgg._avg.ocrScore != null ? Math.round(ocrAgg._avg.ocrScore * 10) / 10 : 0,
    missing,
    verifiedPct: total ? Math.round((verified / total) * 1000) / 10 : 0,
    documentTypes: typeCount.length,
  });
});

// Per-department completeness — % of a department's service book entries that
// are present (Verified or Pending Review) rather than flagged Missing.
/**
 * @swagger
 * /api/v1/service-book/completeness:
 *   get:
 *     summary: Get service book completeness
 *     tags: [service-book]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/service-book/completeness', requireAuth, async (req, res) => {
  const rows = await prisma.$queryRaw`
    SELECT e."department" AS department,
      COUNT(*)::int AS total,
      SUM(CASE WHEN sb."status" != 'Missing' THEN 1 ELSE 0 END)::int AS complete
    FROM service_book_entries sb
    JOIN employees e ON e."id" = sb."employeeId"
    GROUP BY e."department"
    ORDER BY e."department" ASC
  `;
  const data = rows.map((r) => ({
    department: r.department,
    total: r.total,
    completenessPct: r.total ? Math.round((r.complete / r.total) * 1000) / 10 : 0,
  }));
  res.json({ data });
});

// Workforce snapshot — department-wise headcount + attendance, computed live
// so it can be scoped to a zone. Vacancies stay department-only (there is no
// per-zone vacancy concept — sanctioned strength is set per department+designation).
/**
 * @swagger
 * /api/v1/workforce/summary:
 *   get:
 *     summary: Get workforce summary
 *     tags: [workforce]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/workforce/summary', requireAuth, async (req, res) => {
  const { zone } = req.query;
  const zoneFilter = zone && zone !== 'All Zones' ? zone : null;

  const [counts, attendanceRows, snapshotRows] = await Promise.all([
    prisma.employee.groupBy({ by: ['departmentId'], where: zoneFilter ? { zone: zoneFilter } : undefined, _count: { _all: true } }),
    zoneFilter
      ? prisma.$queryRaw`SELECT e."departmentId" as dept, AVG("presentDays"::float / NULLIF("totalDays", 0)) as avg FROM attendance_summary a JOIN employees e ON e."id" = a."employeeId" WHERE e."zone" = ${zoneFilter} GROUP BY e."departmentId"`
      : prisma.$queryRaw`SELECT e."departmentId" as dept, AVG("presentDays"::float / NULLIF("totalDays", 0)) as avg FROM attendance_summary a JOIN employees e ON e."id" = a."employeeId" GROUP BY e."departmentId"`,
    prisma.workforceSnapshot.findMany(),
  ]);

  const countByDept = new Map(counts.map((c) => [c.departmentId, c._count._all]));
  const attendanceByDept = new Map(attendanceRows.map((a) => [a.dept, Number(a.avg) || 0]));
  const vacancyByDept = new Map(snapshotRows.map((s) => [s.dept, s.vacancies]));
  const nameByDept = new Map(snapshotRows.map((s) => [s.dept, s.fullName]));

  const data = [...countByDept.keys()].map((deptId) => ({
    dept: deptId,
    fullName: nameByDept.get(deptId) || deptId,
    count: countByDept.get(deptId) || 0,
    attendance: Math.round((attendanceByDept.get(deptId) || 0) * 1000) / 10,
    vacancies: vacancyByDept.get(deptId) || 0,
  })).filter((d) => d.count > 0).sort((a, b) => b.count - a.count);

  const total = data.reduce((sum, d) => sum + d.count, 0);
  res.json({ data, total });
});

// Zone-wise workforce & attendance — mirrors the department summary above
// but grouped by the employee's administrative zone instead, optionally
// scoped to a single department.
/**
 * @swagger
 * /api/v1/workforce/zones:
 *   get:
 *     summary: Get workforce zones
 *     tags: [workforce]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/workforce/zones', requireAuth, async (req, res) => {
  const { department } = req.query;
  const deptFilter = department && department !== 'All Departments' ? department : null;

  const [counts, attendanceRows] = await Promise.all([
    prisma.employee.groupBy({ by: ['zone'], where: deptFilter ? { department: deptFilter } : undefined, _count: { _all: true } }),
    deptFilter
      ? prisma.$queryRaw`SELECT e."zone" as zone, AVG("presentDays"::float / NULLIF("totalDays", 0)) as avg FROM attendance_summary a JOIN employees e ON e."id" = a."employeeId" WHERE e."department" = ${deptFilter} GROUP BY e."zone"`
      : prisma.$queryRaw`SELECT e."zone" as zone, AVG("presentDays"::float / NULLIF("totalDays", 0)) as avg FROM attendance_summary a JOIN employees e ON e."id" = a."employeeId" GROUP BY e."zone"`,
  ]);

  const attendanceByZone = new Map(attendanceRows.map((a) => [a.zone, Number(a.avg) || 0]));
  const data = counts
    .filter((c) => c.zone)
    .map((c) => ({
      zone: c.zone,
      count: c._count._all,
      attendance: Math.round((attendanceByZone.get(c.zone) || 0) * 1000) / 10,
    }))
    .sort((a, b) => b.count - a.count);

  const total = data.reduce((sum, d) => sum + d.count, 0);
  res.json({ data, total });
});

// Command Centre "AI Insights (Smart Alerts)" panel — four real, computed
// cross-module signals (not fabricated placeholders): the zone with the
// sharpest month-over-month absenteeism rise, employees whose latest
// appraisal rating dropped from the year before, employees retiring within
// the next 12 months, and departments whose latest month's actual spend
// exceeded their allocated budget.
// Performance & Appraisal page — real appraisal-cycle rollup. Previously
// this whole page was hardcoded mock numbers tagged with a "Live" pill;
// every figure below is computed from real employee/performanceRecords data.
/**
 * @swagger
 * /api/v1/performance/summary:
 *   get:
 *     summary: Get performance summary
 *     tags: [performance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/performance/summary', requireAuth, async (req, res) => {
  const [totalActive, pendingCount, latestRatingRows] = await Promise.all([
    prisma.employee.count({ where: { status: 'Active' } }),
    prisma.employee.count({ where: { status: 'Active', appraisalPending: true } }),
    prisma.$queryRaw`
      SELECT e."department" as department, p.rating as rating
      FROM employees e
      JOIN performance_records p ON p."employeeId" = e.id
      WHERE e.status = 'Active'
        AND p.year = (SELECT MAX(year) FROM performance_records WHERE "employeeId" = e.id)
    `,
  ]);

  const ratings = latestRatingRows.map((r) => Number(r.rating));
  const completedCount = ratings.length;
  const avgPerformanceScore = completedCount
    ? Math.round((ratings.reduce((s, r) => s + r, 0) / completedCount / 5) * 1000) / 10
    : 0;
  // A "high performer" here means the latest recorded appraisal rating
  // itself is strong (>=4.5/5) — a simpler, rating-only bar than the
  // Employee 360 Composite Score/High-Potential flag (which also weighs
  // attendance, SLA, training, skills), so this page's number and Employee
  // 360's HP count are deliberately not the same metric.
  const highPerformerCount = ratings.filter((r) => r >= 4.5).length;
  const completionRatePct = totalActive ? Math.round((completedCount / totalActive) * 100) : 0;

  const byDept = new Map();
  for (const r of latestRatingRows) {
    if (!byDept.has(r.department)) byDept.set(r.department, []);
    byDept.get(r.department).push(Number(r.rating));
  }
  const deptScores = [...byDept.entries()]
    .map(([department, deptRatings]) => ({
      department,
      score: Math.round((deptRatings.reduce((s, r) => s + r, 0) / deptRatings.length / 5) * 100),
    }))
    .sort((a, b) => b.score - a.score);

  res.json({
    appraisalsCompleted: completedCount,
    pendingSubmission: pendingCount,
    avgPerformanceScore,
    highPerformers: highPerformerCount,
    completionRatePct,
    deptScores,
  });
});

/**
 * @swagger
 * /api/v1/insights/smart-alerts:
 *   get:
 *     summary: Get insights smart alerts
 *     tags: [insights]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/insights/smart-alerts', requireAuth, async (req, res) => {
  const todayStr = new Date().toISOString().slice(0, 10);
  const in12Months = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const in180Days = new Date(Date.now() + 180 * DAY_MS).toISOString().slice(0, 10);
  const isoDaysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

  const [
    zoneMonthlyAttendance, decliningRows, retiringCount, latestFinanceMonthRow,
    retiringSoonEmployees, recentlyRegularisedCount,
  ] = await Promise.all([
    prisma.$queryRaw`
      SELECT e."zone" as zone, a."month" as month,
             AVG(a."presentDays"::float / NULLIF(a."totalDays", 0)) as pct
      FROM attendance_summary a JOIN employees e ON e."id" = a."employeeId"
      WHERE e."zone" IS NOT NULL
      GROUP BY e."zone", a."month"
      ORDER BY a."month" DESC
    `,
    prisma.$queryRaw`
      SELECT COUNT(*)::int as count FROM (
        SELECT p1."employeeId",
          (SELECT rating FROM performance_records p2 WHERE p2."employeeId" = p1."employeeId" ORDER BY year DESC LIMIT 1) as latest,
          (SELECT rating FROM performance_records p2 WHERE p2."employeeId" = p1."employeeId" ORDER BY year DESC OFFSET 1 LIMIT 1) as prev
        FROM performance_records p1
        GROUP BY p1."employeeId"
      ) x WHERE prev IS NOT NULL AND latest < prev
    `,
    prisma.employee.count({
      where: { status: 'Active', retirement: { gte: todayStr, lte: in12Months } },
    }),
    prisma.departmentFinance.findFirst({ orderBy: { month: 'desc' }, select: { month: true } }),
    // Retirement Readiness Audit — real service-book/disciplinary blockers
    // for employees retiring within 6 months (see computeEmployeeInsights'
    // per-employee retirementReadiness for the same logic, applied here at
    // the org level with a lean query instead of the full insights compute).
    prisma.employee.findMany({
      where: { status: 'Active', retirement: { gte: todayStr, lte: in180Days } },
      select: { missingDocs: true, disciplinaryFlag: true, serviceBookDocs: { select: { status: true } } },
    }),
    // Regularisation / Tenure-Day Tracker — only employees who crossed the
    // real AMC 900/1800-day milestone in the last 30 days count here (not a
    // running total of everyone already past it, which would be nearly the
    // entire workforce and not an actionable signal).
    prisma.employee.count({
      where: {
        status: 'Active',
        OR: [
          { doj: { gte: isoDaysAgo(930), lte: isoDaysAgo(900) } },
          { doj: { gte: isoDaysAgo(1830), lte: isoDaysAgo(1800) } },
        ],
      },
    }),
  ]);

  const retirementReadinessBlockedCount = retiringSoonEmployees.filter((e) =>
    e.missingDocs || e.disciplinaryFlag || e.serviceBookDocs.some((d) => d.status !== 'Verified'),
  ).length;

  // Sharpest month-over-month absenteeism rise across zones — absenteeism%
  // is just 100 - attendance%, so a rising absenteeism% is a falling
  // attendance% between the latest two months on file for that zone.
  const byZone = new Map();
  for (const row of zoneMonthlyAttendance) {
    if (!byZone.has(row.zone)) byZone.set(row.zone, []);
    byZone.get(row.zone).push({ month: row.month, pct: Number(row.pct) || 0 });
  }
  let worstZone = null, worstIncreasePct = 0;
  for (const [zone, months] of byZone.entries()) {
    if (months.length < 2) continue;
    const [latest, prior] = months; // already DESC-ordered by month
    const latestAbsenteeism = 100 - latest.pct * 100;
    const priorAbsenteeism = 100 - prior.pct * 100;
    if (priorAbsenteeism <= 0) continue;
    const increasePct = Math.round(((latestAbsenteeism - priorAbsenteeism) / priorAbsenteeism) * 100);
    if (increasePct > worstIncreasePct) { worstIncreasePct = increasePct; worstZone = zone; }
  }

  const latestFinanceMonth = latestFinanceMonthRow?.month ?? null;
  const overBudgetDeptCount = latestFinanceMonth
    ? (await prisma.departmentFinance.groupBy({
        by: ['department'],
        where: { month: latestFinanceMonth },
        _sum: { allocatedBudget: true, amountSpent: true },
      })).filter((d) => (d._sum.amountSpent || 0) > (d._sum.allocatedBudget || 0)).length
    : 0;

  res.json({
    absenteeism: worstZone ? { zone: worstZone, increasePct: worstIncreasePct } : null,
    performanceDeclining: decliningRows[0]?.count ?? 0,
    retiringNext12Months: retiringCount,
    departmentsOverBudget: overBudgetDeptCount,
    retirementReadinessBlocked: retirementReadinessBlockedCount,
    recentlyRegularised: recentlyRegularisedCount,
  });
});

// Live combined total for the Command Centre KPI strip — the one place that
// needs department AND zone applied together, which the pre-aggregated
// per-department/per-zone summaries above can't do on their own.
/**
 * @swagger
 * /api/v1/workforce/totals:
 *   get:
 *     summary: Get workforce totals
 *     tags: [workforce]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/workforce/totals', requireAuth, async (req, res) => {
  const { department, zone } = req.query;
  const where = {};
  if (department && department !== 'All Departments') where.department = department;
  if (zone && zone !== 'All Zones') where.zone = zone;

  const [total, attendanceAgg, vacancySnapshot] = await Promise.all([
    prisma.employee.count({ where }),
    prisma.attendanceSummary.aggregate({
      where: Object.keys(where).length ? { employee: where } : undefined,
      _sum: { presentDays: true, totalDays: true },
    }),
    department && department !== 'All Departments'
      ? prisma.workforceSnapshot.findFirst({ where: { fullName: department } })
      : prisma.workforceSnapshot.findMany(),
  ]);

  const presentPct = attendanceAgg._sum.totalDays ? (attendanceAgg._sum.presentDays / attendanceAgg._sum.totalDays) * 100 : 0;
  const vacancies = Array.isArray(vacancySnapshot)
    ? vacancySnapshot.reduce((s, v) => s + v.vacancies, 0)
    : (vacancySnapshot?.vacancies || 0);

  res.json({ total, presentPct: Math.round(presentPct * 10) / 10, vacancies });
});

// Payroll
/**
 * @swagger
 * /api/v1/payroll/summary:
 *   get:
 *     summary: Get payroll summary
 *     tags: [payroll]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/payroll/summary', requireAuth, async (req, res) => {
  const summary = await prisma.payrollSummary.findFirst({ orderBy: { updatedAt: 'desc' } });
  res.json(summary || {});
});

// Age distribution for Analytics' workforce demographics chart — bucketed
// live from each employee's real dob rather than a hand-typed curve.
/**
 * @swagger
 * /api/v1/workforce/age-profile:
 *   get:
 *     summary: Get workforce age profile
 *     tags: [workforce]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/workforce/age-profile', requireAuth, async (req, res) => {
  const employees = await prisma.employee.findMany({ select: { dob: true } });
  const buckets = { "20-30": 0, "31-40": 0, "41-50": 0, "51-60": 0, "60+": 0 };
  const now = Date.now();
  for (const e of employees) {
    if (!e.dob) continue;
    const dobMs = new Date(e.dob).getTime();
    if (Number.isNaN(dobMs)) continue;
    const age = (now - dobMs) / (365.25 * 24 * 60 * 60 * 1000);
    if (age <= 30) buckets["20-30"]++;
    else if (age <= 40) buckets["31-40"]++;
    else if (age <= 50) buckets["41-50"]++;
    else if (age <= 60) buckets["51-60"]++;
    else buckets["60+"]++;
  }
  res.json({ data: Object.entries(buckets).map(([ageGroup, count]) => ({ ageGroup, count })) });
});

// Command Centre KPI drill-downs — promotion/retirement pipeline and real
// payroll component split, computed live so the dashboard never fabricates
// a breakdown that its own linked module (Employees/Finance) would contradict.
/**
 * @swagger
 * /api/v1/workforce/alerts-summary:
 *   get:
 *     summary: Get workforce alerts summary
 *     tags: [workforce]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/workforce/alerts-summary', requireAuth, async (req, res) => {
  const [promotionDueEmployees, retirementDueEmployees, compAgg, payrollSummary] = await Promise.all([
    prisma.employee.findMany({ where: { promotionDue: true }, select: { department: true, cadre: true, zone: true } }),
    prisma.employee.findMany({ where: { retirementDue: true }, select: { department: true, retirement: true, zone: true } }),
    prisma.compensation.aggregate({ _sum: { basicPay: true, daAmount: true, hraAmount: true, grossPay: true } }),
    prisma.payrollSummary.findFirst({ orderBy: { updatedAt: 'desc' } }),
  ]);

  function groupCount(rows, key) {
    const map = new Map();
    for (const r of rows) map.set(r[key], (map.get(r[key]) || 0) + 1);
    return [...map.entries()].map(([department, count]) => ({ department, count })).sort((a, b) => b.count - a.count);
  }

  const promotionByCadre = groupCount(promotionDueEmployees, 'cadre').map((r) => ({ cadre: r.department, count: r.count }));

  const today = new Date();
  const bucketOf = (dateStr) => {
    const target = new Date(`${dateStr}T00:00:00`);
    const months = (target.getFullYear() - today.getFullYear()) * 12 + (target.getMonth() - today.getMonth());
    if (months <= 6) return "Next 0-6 Months";
    if (months <= 12) return "Next 7-12 Months";
    if (months <= 18) return "Next 13-18 Months";
    return "Next 19-24 Months";
  };
  const retirementBuckets = { "Next 0-6 Months": 0, "Next 7-12 Months": 0, "Next 13-18 Months": 0, "Next 19-24 Months": 0 };
  for (const e of retirementDueEmployees) {
    if (e.retirement) retirementBuckets[bucketOf(e.retirement)] = (retirementBuckets[bucketOf(e.retirement)] || 0) + 1;
  }

  const sums = compAgg._sum;
  const totalGross = sums.grossPay || 0;
  const other = Math.max(0, totalGross - (sums.basicPay || 0) - (sums.daAmount || 0) - (sums.hraAmount || 0));
  const payrollComponents = totalGross ? [
    { component: "Basic Salary Pay", amountCr: (sums.basicPay || 0) / 1e7, pct: Math.round(((sums.basicPay || 0) / totalGross) * 100) },
    { component: "Dearness Allowance (DA)", amountCr: (sums.daAmount || 0) / 1e7, pct: Math.round(((sums.daAmount || 0) / totalGross) * 100) },
    { component: "House Rent Allowance (HRA)", amountCr: (sums.hraAmount || 0) / 1e7, pct: Math.round(((sums.hraAmount || 0) / totalGross) * 100) },
    { component: "Other Allowances", amountCr: other / 1e7, pct: Math.round((other / totalGross) * 100) },
  ] : [];

  res.json({
    promotion: {
      total: promotionDueEmployees.length,
      byDepartment: groupCount(promotionDueEmployees, 'department'),
      byZone: groupCount(promotionDueEmployees, 'zone').map((r) => ({ zone: r.department, count: r.count })),
      byCadre: promotionByCadre,
    },
    retirement: {
      total: retirementDueEmployees.length,
      byDepartment: groupCount(retirementDueEmployees, 'department'),
      byZone: groupCount(retirementDueEmployees, 'zone').map((r) => ({ zone: r.department, count: r.count })),
      buckets: retirementBuckets,
    },
    payroll: { totalCr: totalGross / 1e7, components: payrollComponents, ...payrollSummary },
  });
});

// Real projected retirements for the next 5 years, from each active
// employee's actual `retirement` date — paired with today's real active
// headcount as a flat reference line. No fabricated future headcount growth
// (unlike the mock data this replaces): there's no real basis to project new
// hires/attrition beyond known retirements.
/**
 * @swagger
 * /api/v1/workforce/retirement-trend:
 *   get:
 *     summary: Get workforce retirement trend
 *     tags: [workforce]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/workforce/retirement-trend', requireAuth, async (req, res) => {
  const employees = await prisma.employee.findMany({ where: { status: 'Active' }, select: { retirement: true } });
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 5 }, (_, i) => currentYear + i);
  const counts = Object.fromEntries(years.map((y) => [y, 0]));
  for (const e of employees) {
    if (!e.retirement) continue;
    const y = new Date(`${e.retirement}T00:00:00`).getFullYear();
    if (y in counts) counts[y] += 1;
  }
  const data = years.map((y) => ({ year: String(y), projectedRetirements: counts[y] }));
  res.json({ data, activeStrength: employees.length });
});

// Department-wise governance readiness composite for Analytics' Governance
// tab — every metric derives from tables that already exist elsewhere in the
// app (service book digitization, current-year appraisal coverage, training
// completion, establishment fill rate), so it can never drift from what
// those other screens show for the same department.
/**
 * @swagger
 * /api/v1/workforce/governance-readiness:
 *   get:
 *     summary: Get workforce governance readiness
 *     tags: [workforce]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/workforce/governance-readiness', requireAuth, async (req, res) => {
  const currentYear = new Date().getFullYear();
  const [serviceBookRows, employees, trainingRecords, snapshotRows, currentYearAppraisals] = await Promise.all([
    prisma.$queryRaw`
      SELECT e."department" AS department,
        COUNT(*)::int AS total,
        SUM(CASE WHEN sb."status" != 'Missing' THEN 1 ELSE 0 END)::int AS complete
      FROM service_book_entries sb
      JOIN employees e ON e."id" = sb."employeeId"
      GROUP BY e."department"
    `,
    prisma.employee.findMany({ select: { id: true, department: true } }),
    prisma.trainingRecord.findMany({ select: { status: true, employee: { select: { department: true } } } }),
    prisma.workforceSnapshot.findMany(),
    prisma.performanceRecord.findMany({ where: { year: currentYear }, select: { employeeId: true } }),
  ]);

  const digitizationByDept = new Map(serviceBookRows.map((r) => [r.department, r.total ? Math.round((r.complete / r.total) * 1000) / 10 : 0]));

  const trainingByDept = new Map();
  for (const r of trainingRecords) {
    const dept = r.employee?.department;
    if (!dept) continue;
    const entry = trainingByDept.get(dept) || { total: 0, completed: 0 };
    entry.total += 1;
    if (r.status === "Completed") entry.completed += 1;
    trainingByDept.set(dept, entry);
  }

  const establishmentByDept = new Map(
    snapshotRows.map((s) => [s.fullName, (s.count + s.vacancies) ? Math.round((s.count / (s.count + s.vacancies)) * 1000) / 10 : 0]),
  );

  const appraisalCoveredIds = new Set(currentYearAppraisals.map((p) => p.employeeId));
  const employeesByDept = new Map();
  for (const e of employees) {
    if (!e.department) continue;
    if (!employeesByDept.has(e.department)) employeesByDept.set(e.department, []);
    employeesByDept.get(e.department).push(e);
  }

  const data = [...employeesByDept.entries()].map(([dept, deptEmployees]) => {
    const appraisalCovered = deptEmployees.filter((e) => appraisalCoveredIds.has(e.id)).length;
    const training = trainingByDept.get(dept);
    return {
      dept,
      digitization: digitizationByDept.get(dept) ?? 0,
      appraisal: deptEmployees.length ? Math.round((appraisalCovered / deptEmployees.length) * 1000) / 10 : 0,
      training: training?.total ? Math.round((training.completed / training.total) * 1000) / 10 : 0,
      establishment: establishmentByDept.get(dept) ?? 0,
    };
  }).sort((a, b) => a.dept.localeCompare(b.dept));

  res.json({ data });
});

// Staff-category (cadre) breakdown, optionally scoped to a department.
/**
 * @swagger
 * /api/v1/workforce/cadre-summary:
 *   get:
 *     summary: Get workforce cadre summary
 *     tags: [workforce]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/workforce/cadre-summary', requireAuth, async (req, res) => {
  const { departmentId } = req.query;
  const grouped = await prisma.employee.groupBy({
    by: ['departmentId', 'cadre'],
    where: departmentId ? { departmentId } : undefined,
    _count: { _all: true },
  });
  const data = grouped.map((g) => ({ departmentId: g.departmentId, cadre: g.cadre, count: g._count._all }));
  res.json({ data });
});

// Officer-wise training completion drill-down, e.g. "42 officers completed X".
/**
 * @swagger
 * /api/v1/training/summary:
 *   get:
 *     summary: Get training summary
 *     tags: [training]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/training/summary', requireAuth, async (req, res) => {
  const { departmentId, courseTitle } = req.query;
  const records = await prisma.trainingRecord.findMany({
    where: courseTitle ? { title: courseTitle } : undefined,
    include: { employee: true },
  });
  const scoped = departmentId ? records.filter((r) => r.employee.departmentId === departmentId) : records;

  const byCourse = new Map();
  for (const r of scoped) {
    if (!byCourse.has(r.title)) byCourse.set(r.title, { title: r.title, category: r.category, officers: [] });
    byCourse.get(r.title).officers.push({
      id: r.employeeId, name: r.employee.name, designation: r.employee.designation,
      department: r.employee.department, status: r.status, completionDate: r.completionDate,
    });
  }
  const data = Array.from(byCourse.values()).map((c) => {
    const totalEnrolled = c.officers.length;
    const completed = c.officers.filter((o) => o.status === "Completed").length;
    return { ...c, totalEnrolled, completed, completionRate: totalEnrolled ? Math.round((completed / totalEnrolled) * 1000) / 10 : 0 };
  });

  // Department rollup — real enrolled count + completion rate, computed
  // org-wide (ignores the departmentId/courseTitle filters above) since this
  // backs Analytics' cross-department "Training Compliance" chart. No
  // avgHours here — TrainingRecord has no hours field, so there's nothing
  // real to report for that metric.
  const byDeptMap = new Map();
  for (const r of records) {
    const dept = r.employee.department;
    const entry = byDeptMap.get(dept) || { department: dept, enrolled: 0, completed: 0 };
    entry.enrolled += 1;
    if (r.status === "Completed") entry.completed += 1;
    byDeptMap.set(dept, entry);
  }
  const byDepartment = Array.from(byDeptMap.values())
    .map((d) => ({ department: d.department, enrolled: d.enrolled, completionRate: d.enrolled ? Math.round((d.completed / d.enrolled) * 1000) / 10 : 0 }))
    .sort((a, b) => b.completionRate - a.completionRate);

  res.json({ data, byDepartment });
});

// Monthly expenditure trend, optionally scoped to a department.
/**
 * @swagger
 * /api/v1/finance/expenditure-trend:
 *   get:
 *     summary: Get finance expenditure trend
 *     tags: [finance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/finance/expenditure-trend', requireAuth, async (req, res) => {
  const { department, months } = req.query;
  const grouped = await prisma.departmentFinance.groupBy({
    by: ['month', 'category'],
    where: department ? { department } : undefined,
    _sum: { amountSpent: true, allocatedBudget: true },
    orderBy: { month: 'asc' },
  });
  const limit = months ? Number(months) : null;
  const monthOrder = [...new Set(grouped.map((g) => g.month))].sort();
  const keep = limit ? new Set(monthOrder.slice(-limit)) : null;
  const data = grouped
    .filter((g) => !keep || keep.has(g.month))
    .map((g) => ({ month: g.month, category: g.category, amountSpent: g._sum.amountSpent, allocatedBudget: g._sum.allocatedBudget }));
  res.json({ data });
});

// Budget variance (allocated vs. spent) by department, optionally scoped to
// one spend category (e.g. category=Salary for payroll-only totals).
/**
 * @swagger
 * /api/v1/finance/budget-variance:
 *   get:
 *     summary: Get finance budget variance
 *     tags: [finance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/finance/budget-variance', requireAuth, async (req, res) => {
  const { department, category } = req.query;
  const where = {
    ...(department ? { department } : {}),
    ...(category ? { category } : {}),
  };
  const [grouped, months] = await Promise.all([
    prisma.departmentFinance.groupBy({
      by: ['department'],
      where,
      _sum: { amountSpent: true, allocatedBudget: true },
    }),
    prisma.departmentFinance.findMany({ where, distinct: ['month'], select: { month: true } }),
  ]);
  const monthCount = months.length || 1;
  const data = grouped.map((g) => {
    const allocated = g._sum.allocatedBudget || 0;
    const spent = g._sum.amountSpent || 0;
    const variance = spent - allocated;
    return {
      department: g.department, allocated, spent, variance,
      variancePct: allocated ? Math.round((variance / allocated) * 1000) / 10 : 0,
      avgMonthlySpent: Math.round(spent / monthCount),
    };
  }).sort((a, b) => b.variancePct - a.variancePct);
  res.json({ data });
});

// Real monthly payroll (Salary category) spend, org-wide, with a short
// bounded projection fit by least-squares over the actual history — not an
// open-ended hand-typed curve. Real month-to-month payroll is mostly flat
// (increments/DA hikes land on specific cycles, not continuously), so an
// honest fit here is expected to show low-to-moderate confidence, not a
// smooth line trending upward forever.
const MIN_PAYROLL_TREND_MONTHS = 4;
const PAYROLL_PROJECTION_MONTHS = 2;
/**
 * @swagger
 * /api/v1/finance/payroll-trend:
 *   get:
 *     summary: Get finance payroll trend
 *     tags: [finance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/finance/payroll-trend', requireAuth, async (req, res) => {
  const rows = await prisma.departmentFinance.groupBy({
    by: ['month'],
    where: { category: 'Salary' },
    _sum: { amountSpent: true },
  });
  const sorted = rows
    .map((r) => ({ month: r.month, spentCr: (r._sum.amountSpent || 0) / 1e7 }))
    .sort((a, b) => a.month.localeCompare(b.month));

  if (sorted.length < MIN_PAYROLL_TREND_MONTHS) {
    return res.json({ data: sorted.map((r) => ({ month: r.month, actual: Math.round(r.spentCr * 100) / 100, predicted: null })), confidence: 5 });
  }

  const points = sorted.map((r, i) => ({ x: i, y: r.spentCr }));
  const trend = linearTrend(points);
  const confidence = clampConfidence(trend.r2 * 90);

  const data = sorted.map((r, i) => ({
    month: r.month,
    actual: Math.round(r.spentCr * 100) / 100,
    predicted: i === sorted.length - 1 ? Math.round(r.spentCr * 100) / 100 : null,
  }));
  for (let step = 1; step <= PAYROLL_PROJECTION_MONTHS; step++) {
    const [y, m] = sorted[sorted.length - 1].month.split('-').map(Number);
    const projectedDate = new Date(y, m - 1 + step, 1);
    const projectedMonth = `${projectedDate.getFullYear()}-${String(projectedDate.getMonth() + 1).padStart(2, '0')}`;
    const projectedSpend = Math.max(0, projectForward(trend, points.length - 1, step));
    data.push({ month: projectedMonth, actual: null, predicted: Math.round(projectedSpend * 100) / 100 });
  }

  res.json({ data, confidence, trendR2: Math.round(trend.r2 * 100) / 100 });
});

// Vendor payments and employee claims with rule-based (not model-driven)
// anomaly flags computed live: amount > 2x the submitting department's own
// average, and same submitter+amount recurring within 7 days. Replaces the
// old hand-typed EXPENSES table — every row and every flag now traces back
// to a real Expense record instead of fabricated risk scores.
const EXPENSE_OUTLIER_MULTIPLE = 2;
const EXPENSE_DUPLICATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * @swagger
 * /api/v1/finance/expenses:
 *   get:
 *     summary: Get finance expenses
 *     tags: [finance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/finance/expenses', requireAuth, async (req, res) => {
  const rows = await prisma.expense.findMany({ orderBy: { submittedAt: 'desc' }, take: 200 });

  const amountsByDept = new Map();
  for (const e of rows) {
    if (!amountsByDept.has(e.department)) amountsByDept.set(e.department, []);
    amountsByDept.get(e.department).push(e.amount);
  }
  const avgByDept = new Map(
    [...amountsByDept.entries()].map(([dept, amounts]) => [dept, amounts.reduce((a, b) => a + b, 0) / amounts.length]),
  );

  const data = rows.map((e) => {
    const avg = avgByDept.get(e.department) || e.amount;
    const ratio = avg ? e.amount / avg : 1;
    const isOutlier = ratio >= EXPENSE_OUTLIER_MULTIPLE;
    const isDuplicate = rows.some((o) =>
      o.id !== e.id && o.submitter === e.submitter && o.amount === e.amount &&
      Math.abs(new Date(o.submittedAt).getTime() - new Date(e.submittedAt).getTime()) <= EXPENSE_DUPLICATE_WINDOW_MS
    );
    const reasons = [];
    if (isOutlier) reasons.push(`${Math.round(ratio * 10) / 10}x department average`);
    if (isDuplicate) reasons.push('possible duplicate (same submitter/amount within 7 days)');
    const flagged = reasons.length > 0;
    return {
      ...e,
      risk: reasons.length >= 2 ? 'High' : reasons.length === 1 ? 'Medium' : 'Low',
      flagged,
      action: flagged ? `Flagged: ${reasons.join('; ')}` : 'Auto-Approved',
    };
  });

  res.json({
    data,
    kpis: {
      flaggedCount: data.filter((d) => d.flagged).length,
      autoApprovedAmount: data.filter((d) => !d.flagged).reduce((sum, d) => sum + d.amount, 0),
    },
  });
});

// Calendar — aggregates upcoming HR events (task deadlines, trainings,
// retirements, service-book postings) from existing tables into one
// unified, date-sorted feed for the dashboard/calendar view.
/**
 * @swagger
 * /api/v1/calendar/events:
 *   get:
 *     summary: Get calendar events
 *     tags: [calendar]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/calendar/events', requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const ninetyDaysOut = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const fromStr = req.query.from || today;
  const toStr = req.query.to || ninetyDaysOut;
  // Dates are stored as "YYYY-MM-DD" strings, which sort identically to a
  // chronological comparison — a plain string range filter works at the DB level.
  const dateRange = { gte: fromStr, lte: toStr };

  const [trainings, retirees, serviceBookEntries, pendingLeave, approvedLeave, customEvents, personalEvents] = await Promise.all([
    prisma.trainingRecord.findMany({ where: { completionDate: dateRange }, include: { employee: true } }),
    prisma.employee.findMany({ where: { retirementDue: true, retirement: dateRange } }),
    prisma.serviceBookEntry.findMany({ where: { date: dateRange }, include: { employee: true } }),
    prisma.leaveRequest.findMany({ where: { status: 'Pending', fromDate: dateRange }, include: { employee: true } }),
    prisma.leaveRequest.findMany({ where: { status: 'Approved', fromDate: dateRange }, include: { employee: true } }),
    prisma.calendarEvent.findMany({ where: { date: dateRange } }),
    // Private, employee-owned reminders — only ever fetched for the caller's
    // own record, and only when they're an Employee (these are personal
    // notes, not organizational data, so admins don't see anyone's here).
    req.user.role === 'Employee' && req.user.employeeId
      ? prisma.personalEvent.findMany({ where: { employeeId: req.user.employeeId, date: dateRange } })
      : Promise.resolve([]),
  ]);

  const events = [
    // HR-created freeform entries — the only type with its own row, so the
    // only type the frontend is allowed to offer a delete action on.
    ...customEvents.map((c) => ({
      id: c.id, title: c.title, date: c.date, type: c.type, department: c.department || undefined, deletable: true,
    })),
    ...trainings.map((tr) => ({
      id: `training-${tr.id}`, title: `Training: ${tr.title}`, date: tr.completionDate, type: "Training",
      employeeId: tr.employeeId, employeeName: tr.employee?.name, department: tr.employee?.department,
    })),
    ...retirees.map((e) => ({
      id: `retirement-${e.id}`, title: `Retirement: ${e.name}`, date: e.retirement, type: "Retirement",
      employeeId: e.id, employeeName: e.name, department: e.department,
    })),
    ...serviceBookEntries.map((d) => ({
      id: `service-${d.id}`, title: `${d.type}: ${d.employee?.name}`, date: d.date, type: "Service Record",
      employeeId: d.employeeId, employeeName: d.employee?.name, department: d.employee?.department,
    })),
    ...pendingLeave.map((r) => ({
      id: `leave-${r.id}`, title: `Leave approval pending: ${r.employee?.name}`, date: r.fromDate, type: "Leave Approval",
      employeeId: r.employeeId, employeeName: r.employee?.name, department: r.employee?.department, to: "/leave",
    })),
    ...approvedLeave.map((r) => ({
      id: `on-leave-${r.id}`, title: `${r.employee?.name} on ${r.leaveType}`, date: r.fromDate, type: "On Leave",
      employeeId: r.employeeId, employeeName: r.employee?.name, department: r.employee?.department, to: "/leave",
    })),
    ...personalEvents.map((p) => ({
      id: `personal-${p.id}`, title: p.title, date: p.date, type: "Personal", note: p.note,
      employeeId: p.employeeId,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  res.json({ data: events });
});

// HR-created calendar entries — the only calendar event type backed by its
// own table (see the CalendarEvent model note above); training/retirement/
// leave entries are read-only projections and are never targeted by these.
/**
 * @swagger
 * /api/v1/calendar/events:
 *   post:
 *     summary: Create calendar events
 *     tags: [calendar]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.post('/api/v1/calendar/events', requireAuth, async (req, res) => {
  const { title, date, type, department, note } = req.body;
  if (!title || !date) return res.status(400).json({ error: "title and date are required" });
  const event = await prisma.calendarEvent.create({
    data: { title, date, type: type || "Notice", department: department || null, note: note || null, createdBy: req.user?.email || null },
  });
  res.status(201).json(event);
});

/**
 * @swagger
 * /api/v1/calendar/events/{id}:
 *   delete:
 *     summary: Delete calendar events id
 *     tags: [calendar]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.delete('/api/v1/calendar/events/:id', requireAuth, async (req, res) => {
  const event = await prisma.calendarEvent.findUnique({ where: { id: req.params.id } });
  if (!event) return res.status(404).json({ error: "Calendar event not found" });
  await prisma.calendarEvent.delete({ where: { id: req.params.id } });
  res.json({ message: "Calendar event deleted successfully", id: req.params.id });
});

// Personal calendar reminders — private to the employee who created them.
/**
 * @swagger
 * /api/v1/calendar/personal-events:
 *   post:
 *     summary: Create calendar personal events
 *     tags: [calendar]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.post('/api/v1/calendar/personal-events', requireAuth, async (req, res) => {
  const { title, date, note } = req.body;
  if (!title || !date) return res.status(400).json({ error: "title and date are required" });
  if (req.user.role !== 'Employee' || !req.user.employeeId) {
    return res.status(403).json({ error: "Only an employee self-service account can add a personal reminder" });
  }
  const event = await prisma.personalEvent.create({
    data: { employeeId: req.user.employeeId, title, date, note: note || null },
  });
  res.status(201).json({ id: `personal-${event.id}`, title: event.title, date: event.date, note: event.note, type: "Personal", employeeId: event.employeeId });
});

/**
 * @swagger
 * /api/v1/calendar/personal-events/{id}:
 *   delete:
 *     summary: Delete calendar personal events id
 *     tags: [calendar]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.delete('/api/v1/calendar/personal-events/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const event = await prisma.personalEvent.findUnique({ where: { id } });
  if (!event) return res.status(404).json({ error: "Personal event not found" });
  if (event.employeeId !== req.user.employeeId) {
    return res.status(403).json({ error: "You can only delete your own reminders" });
  }
  await prisma.personalEvent.delete({ where: { id } });
  res.json({ success: true });
});

// Grievances
const ESCALATION_HOURS = 48;

function shapeGrievance(g) {
  const { submitter, updates, ...rest } = g;
  return {
    ...rest,
    category: toDisplay(g.category),
    status: toDisplay(g.status),
    submitterName: g.isAnonymous ? null : submitter?.name,
    ...(updates ? { updates: updates.map((u) => ({ ...u, status: toDisplay(u.status) })) } : {}),
  };
}

/**
 * @swagger
 * /api/v1/grievances:
 *   get:
 *     summary: Get grievances
 *     tags: [grievances]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/grievances', requireAuth, async (req, res) => {
  const { department } = req.query;

  // Time-based auto-escalation: any New/UnderInvestigation grievance older
  // than the SLA window gets escalated the moment it's next read, rather than
  // requiring a background job.
  const cutoff = new Date(Date.now() - ESCALATION_HOURS * 60 * 60 * 1000);
  await prisma.grievance.updateMany({
    where: { status: { in: ["New", "UnderInvestigation"] }, createdAt: { lt: cutoff } },
    data: { status: "Escalated" },
  });

  // Employees only ever see grievances they themselves filed (ignoring any
  // department filter) — this endpoint otherwise returns every grievance
  // org-wide, which would leak other employees' filed complaints to a
  // self-service caller.
  const where = req.user.role === 'Employee'
    ? { submitterId: req.user.employeeId }
    : (department && department !== "All Departments" ? { department } : {});
  const data = await prisma.grievance.findMany({ where, orderBy: { createdAt: 'desc' }, include: { submitter: true } });
  res.json({ count: data.length, data: data.map(shapeGrievance) });
});

/**
 * @swagger
 * /api/v1/grievances/analytics:
 *   get:
 *     summary: Get grievances analytics
 *     tags: [grievances]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/grievances/analytics', requireAuth, async (req, res) => {
  const since = new Date();
  since.setMonth(since.getMonth() - 5);
  since.setDate(1);
  const rows = await prisma.grievance.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true, severity: true },
  });

  const byMonth = new Map();
  for (let i = 0; i < 6; i++) {
    const d = new Date(since.getFullYear(), since.getMonth() + i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    byMonth.set(key, { month: d.toLocaleString('en-US', { month: 'short' }), volume: 0, critical: 0 });
  }
  for (const r of rows) {
    const d = new Date(r.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const bucket = byMonth.get(key);
    if (!bucket) continue;
    bucket.volume += 1;
    if (r.severity === "Critical") bucket.critical += 1;
  }

  // Department grievance heatmap — real open-grievance concentration by
  // department, giving leadership the "sudden localized surge" visibility
  // the AI-HRMS blueprint describes, without inventing a zone derivation
  // that would silently break for anonymous submitters (Grievance stores
  // `department` directly on every row; it has no `zone` column).
  const openByDept = await prisma.grievance.groupBy({
    by: ['department'],
    where: { status: { in: ['New', 'UnderInvestigation', 'Escalated'] } },
    _count: { _all: true },
  });
  const criticalByDept = await prisma.grievance.groupBy({
    by: ['department'],
    where: { status: { in: ['New', 'UnderInvestigation', 'Escalated'] }, severity: 'Critical' },
    _count: { _all: true },
  });
  const criticalMap = new Map(criticalByDept.map((d) => [d.department, d._count._all]));
  const byDepartment = openByDept
    .map((d) => ({ department: d.department, openCount: d._count._all, criticalCount: criticalMap.get(d.department) || 0 }))
    .sort((a, b) => b.openCount - a.openCount);

  res.json({ data: [...byMonth.values()], byDepartment });
});

// Defense-in-depth alongside the AI severity classifier (server-ai's
// GRIEVANCE_ANALYSIS_PROMPT already handles this well in the common case) —
// a hard keyword match forces Critical/Escalated regardless of what the LLM
// returns, so a life-safety complaint is never one bad model call away from
// sitting in the normal queue. Matched case-insensitively against subject +
// description together.
const SAFETY_HARD_TRIGGER_KEYWORDS = [
  "toxic fume", "no safety gear", "no ppe", "without ppe", "no mask", "no harness",
  "assault", "assaulted", "molest", "sexual harassment", "life threat", "threatened to kill",
  "police complaint", "manual scavenging", "sewage tank", "drowned", "electrocut",
];
function matchesSafetyHardTrigger(subject, description) {
  const text = `${subject} ${description}`.toLowerCase();
  return SAFETY_HARD_TRIGGER_KEYWORDS.some((kw) => text.includes(kw));
}

/**
 * @swagger
 * /api/v1/grievances:
 *   post:
 *     summary: Create grievances
 *     tags: [grievances]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.post('/api/v1/grievances', requireAuth, async (req, res) => {
  const { category, subject, description, department, isAnonymous, severityOverride } = req.body;
  // An Employee caller can only ever file as themselves — never trust a
  // client-supplied submitterId, which would let one employee's session
  // spoof another employee as the filer.
  const submitterId = req.user.role === 'Employee' ? req.user.employeeId : (req.body.submitterId || null);
  if (!subject || !description || !category) {
    return res.status(400).json({ error: "category, subject, and description are required" });
  }

  let analysis = { sentiment: "Neutral", severity: "Medium", summary: description.slice(0, 140) };
  try {
    const aiRes = await fetch(`${AI_API_URL}/api/v1/grievances/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, description }),
    });
    if (aiRes.ok) analysis = await aiRes.json();
  } catch {
    // AI service unreachable — filing must still succeed with a safe default.
  }
  // "File Critical Incident" lets the filer force Critical severity — still
  // runs AI for sentiment/summary, but skips its severity verdict. The
  // keyword hard-trigger below overrides both the AI and the filer's own
  // choice (a filer might under-describe severity; a safety keyword match
  // shouldn't depend on them checking the right box).
  const hardTriggered = matchesSafetyHardTrigger(subject, description);
  const severity = hardTriggered ? "Critical" : (severityOverride === "Critical" ? "Critical" : analysis.severity);
  const aiSummary = hardTriggered
    ? `[Auto-escalated: safety/harassment keyword match] ${analysis.summary}`
    : analysis.summary;

  const count = await prisma.grievance.count();
  const grievance = await prisma.grievance.create({
    data: {
      id: `GRV-${1000 + count + 1}`,
      category: toEnum(category),
      submitterId: isAnonymous ? null : submitterId || null,
      isAnonymous: !!isAnonymous,
      department: department || "General Administration",
      subject,
      description,
      aiSummary,
      sentiment: analysis.sentiment,
      // Auto-escalation: a Critical severity skips the "New" queue and lands
      // directly as Escalated.
      severity,
      status: severity === "Critical" ? "Escalated" : "New",
    },
    include: { submitter: true },
  });
  await prisma.grievanceUpdate.create({
    data: { grievanceId: grievance.id, status: grievance.status, note: "Grievance filed.", createdBy: req.user.email },
  });
  res.status(201).json(shapeGrievance(grievance));
});

/**
 * @swagger
 * /api/v1/grievances/{id}:
 *   get:
 *     summary: Get grievances id
 *     tags: [grievances]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/grievances/:id', requireAuth, async (req, res) => {
  const grievance = await prisma.grievance.findUnique({
    where: { id: req.params.id },
    include: { submitter: true, updates: { orderBy: { createdAt: 'asc' } } },
  });
  if (!grievance) return res.status(404).json({ error: "Grievance not found" });
  if (req.user.role === 'Employee' && grievance.submitterId !== req.user.employeeId) {
    return res.status(403).json({ error: "You can only view grievances you filed" });
  }
  res.json(shapeGrievance(grievance));
});

/**
 * @swagger
 * /api/v1/grievances/{id}/status:
 *   put:
 *     summary: Update grievances id status
 *     tags: [grievances]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.put('/api/v1/grievances/:id/status', requireAuth, async (req, res) => {
  const { status, note } = req.body;
  if (!status) return res.status(400).json({ error: "status is required" });

  const grievance = await prisma.grievance.update({
    where: { id: req.params.id },
    data: { status: toEnum(status) },
    include: { submitter: true },
  });
  await prisma.grievanceUpdate.create({
    data: { grievanceId: grievance.id, status: grievance.status, note: note || `Status changed to ${status}.`, createdBy: req.user.email },
  });
  res.json(shapeGrievance(grievance));
});

// DPDP Act 2023 Data-Rights Center — a real, working request tracker: an
// employee can file an Access/Correction/Erasure request against their own
// HR/biometric data, and HR can actually resolve it. Mirrors the Grievance
// endpoints' auth/shape pattern above rather than inventing a new one.
function shapePrivacyRequest(r) {
  const { employee, ...rest } = r;
  return { ...rest, status: toDisplay(r.status), employeeName: employee?.name };
}

/**
 * @swagger
 * /api/v1/privacy-requests:
 *   get:
 *     summary: Get privacy requests
 *     tags: [privacy-requests]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/privacy-requests', requireAuth, async (req, res) => {
  // Employees only ever see their own filed requests — same self-service
  // scoping as GET /api/v1/grievances above.
  const where = req.user.role === 'Employee' ? { employeeId: req.user.employeeId } : {};
  const data = await prisma.privacyRequest.findMany({
    where, orderBy: { createdAt: 'desc' }, include: { employee: true },
  });
  res.json({ count: data.length, data: data.map(shapePrivacyRequest) });
});

/**
 * @swagger
 * /api/v1/privacy-requests:
 *   post:
 *     summary: Create privacy requests
 *     tags: [privacy-requests]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.post('/api/v1/privacy-requests', requireAuth, async (req, res) => {
  const { type, description } = req.body;
  const employeeId = req.user.role === 'Employee' ? req.user.employeeId : req.body.employeeId;
  if (!employeeId) return res.status(400).json({ error: "employeeId is required" });
  if (!['Access', 'Correction', 'Erasure'].includes(type)) {
    return res.status(400).json({ error: "type must be Access, Correction, or Erasure" });
  }
  if (!description) return res.status(400).json({ error: "description is required" });

  const count = await prisma.privacyRequest.count();
  const request = await prisma.privacyRequest.create({
    data: { id: `PRV-${1000 + count + 1}`, employeeId, type, description },
    include: { employee: true },
  });
  res.status(201).json(shapePrivacyRequest(request));
});

/**
 * @swagger
 * /api/v1/privacy-requests/{id}/status:
 *   put:
 *     summary: Update privacy requests id status
 *     tags: [privacy-requests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.put('/api/v1/privacy-requests/:id/status', requireAuth, async (req, res) => {
  if (req.user.role === 'Employee') return res.status(403).json({ error: "Only HR can update a privacy request's status" });
  const { notes } = req.body;
  const status = toEnum(req.body.status);
  if (!['New', 'InProgress', 'Resolved'].includes(status)) {
    return res.status(400).json({ error: "status must be New, In Progress, or Resolved" });
  }
  const request = await prisma.privacyRequest.update({
    where: { id: req.params.id },
    data: { status, notes: notes ?? undefined, resolvedAt: status === 'Resolved' ? new Date() : null },
    include: { employee: true },
  });
  res.json(shapePrivacyRequest(request));
});

// Recruitment — candidate pipeline (Candidate + CandidateInterview), backed
// by real seeded data instead of the frontend's previous hardcoded mocks.
function shapeCandidate(c) {
  const { interviews, vacancy, onboarding, ...rest } = c;
  return {
    ...rest,
    vacancySanctioned: vacancy?.sanctioned,
    ...(interviews ? { interviews } : {}),
    ...(onboarding !== undefined ? { onboardingCaseId: onboarding?.id ?? null } : {}),
  };
}

/**
 * @swagger
 * /api/v1/recruitment/candidates:
 *   get:
 *     summary: Get recruitment candidates
 *     tags: [recruitment]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/recruitment/candidates', requireAuth, async (req, res) => {
  const { department, status } = req.query;
  const where = {
    ...(department && department !== "All Departments" ? { department } : {}),
    ...(status ? { status } : {}),
  };
  const data = await prisma.candidate.findMany({ where, orderBy: { appliedDate: 'desc' }, include: { vacancy: true } });
  res.json({ count: data.length, data: data.map(shapeCandidate) });
});

/**
 * @swagger
 * /api/v1/recruitment/summary:
 *   get:
 *     summary: Get recruitment summary
 *     tags: [recruitment]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/recruitment/summary', requireAuth, async (req, res) => {
  const [total, byStatus] = await Promise.all([
    prisma.candidate.count(),
    prisma.candidate.groupBy({ by: ['status'], _count: { status: true } }),
  ]);
  const statusCounts = Object.fromEntries(byStatus.map((r) => [r.status, r._count.status]));
  res.json({
    totalApplications: total,
    inPipeline: (statusCounts.Applied || 0) + (statusCounts.Screening || 0) + (statusCounts.InterviewScheduled || 0) + (statusCounts.InterviewCompleted || 0),
    offersExtended: statusCounts.OfferExtended || 0,
    offersAccepted: statusCounts.OfferAccepted || 0,
    rejected: statusCounts.Rejected || 0,
    byStatus: statusCounts,
  });
});

/**
 * @swagger
 * /api/v1/recruitment/candidates/{id}:
 *   get:
 *     summary: Get recruitment candidates id
 *     tags: [recruitment]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/recruitment/candidates/:id', requireAuth, async (req, res) => {
  const c = await prisma.candidate.findUnique({
    where: { id: req.params.id },
    include: { vacancy: true, interviews: { orderBy: { scheduledAt: 'asc' } }, onboarding: true },
  });
  if (!c) return res.status(404).json({ error: "Candidate not found" });
  res.json(shapeCandidate(c));
});

/**
 * @swagger
 * /api/v1/recruitment/candidates/{id}/status:
 *   put:
 *     summary: Update recruitment candidates id status
 *     tags: [recruitment]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.put('/api/v1/recruitment/candidates/:id/status', requireAuth, async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: "status is required" });
  const c = await prisma.candidate.update({ where: { id: req.params.id }, data: { status } });
  res.json(shapeCandidate(c));
});

// Onboarding — new-hire checklist (OnboardingCase + OnboardingTask), backed
// by real seeded data instead of the frontend's previous hardcoded mocks.
function shapeOnboardingCase(c) {
  const { tasks, buddy, employee, candidate, ...rest } = c;
  return { ...rest, buddyName: buddy?.name, ...(tasks ? { tasks } : {}) };
}

/**
 * @swagger
 * /api/v1/onboarding/cases:
 *   get:
 *     summary: Get onboarding cases
 *     tags: [onboarding]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/onboarding/cases', requireAuth, async (req, res) => {
  const { department, status } = req.query;
  const where = {
    ...(department && department !== "All Departments" ? { department } : {}),
    ...(status ? { status } : {}),
  };
  const data = await prisma.onboardingCase.findMany({ where, orderBy: { startDate: 'asc' }, include: { buddy: true } });
  res.json({ count: data.length, data: data.map(shapeOnboardingCase) });
});

/**
 * @swagger
 * /api/v1/onboarding/summary:
 *   get:
 *     summary: Get onboarding summary
 *     tags: [onboarding]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/onboarding/summary', requireAuth, async (req, res) => {
  const [total, byStatus] = await Promise.all([
    prisma.onboardingCase.count(),
    prisma.onboardingCase.groupBy({ by: ['status'], _count: { status: true } }),
  ]);
  const statusCounts = Object.fromEntries(byStatus.map((r) => [r.status, r._count.status]));
  res.json({ totalCases: total, notStarted: statusCounts.NotStarted || 0, inProgress: statusCounts.InProgress || 0, completed: statusCounts.Completed || 0 });
});

/**
 * @swagger
 * /api/v1/onboarding/cases/{id}:
 *   get:
 *     summary: Get onboarding cases id
 *     tags: [onboarding]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/onboarding/cases/:id', requireAuth, async (req, res) => {
  const c = await prisma.onboardingCase.findUnique({
    where: { id: req.params.id },
    include: { buddy: true, tasks: true, candidate: true, employee: true },
  });
  if (!c) return res.status(404).json({ error: "Onboarding case not found" });
  res.json(shapeOnboardingCase(c));
});

/**
 * @swagger
 * /api/v1/onboarding/tasks/{id}/status:
 *   put:
 *     summary: Update onboarding tasks id status
 *     tags: [onboarding]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.put('/api/v1/onboarding/tasks/:id/status', requireAuth, async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: "status is required" });
  const task = await prisma.onboardingTask.update({
    where: { id: Number(req.params.id) },
    data: { status, completedDate: status === "Completed" ? new Date().toISOString().slice(0, 10) : null },
  });
  const remaining = await prisma.onboardingTask.findMany({ where: { onboardingCaseId: task.onboardingCaseId } });
  const progressPct = Math.round((remaining.filter((t) => t.status === "Completed").length / remaining.length) * 100);
  await prisma.onboardingCase.update({
    where: { id: task.onboardingCaseId },
    data: { progressPct, status: progressPct === 100 ? "Completed" : progressPct > 0 ? "InProgress" : "NotStarted" },
  });
  res.json(task);
});

// Copilot chat history — persisted per authenticated user (User.id, the JWT
// `sub` claim), not per employee, since HR Admin/Department Head accounts
// have no employeeId. Lets the chatbot greet with "welcome back" context
// referencing what was last discussed, across logins.
/**
 * @swagger
 * /api/v1/copilot/messages:
 *   post:
 *     summary: Create copilot messages
 *     tags: [copilot]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.post('/api/v1/copilot/messages', requireAuth, async (req, res) => {
  const { role, text, redirectPath, redirectLabel } = req.body;
  if (!role || !text) return res.status(400).json({ error: "role and text are required" });
  if (role !== 'user' && role !== 'ai') return res.status(400).json({ error: "role must be 'user' or 'ai'" });
  const msg = await prisma.chatMessage.create({
    data: { userId: req.user.sub, role, text, redirectPath: redirectPath ?? null, redirectLabel: redirectLabel ?? null },
  });
  res.status(201).json({ data: msg });
});

/**
 * @swagger
 * /api/v1/copilot/messages/recent:
 *   get:
 *     summary: Get copilot messages recent
 *     tags: [copilot]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/copilot/messages/recent', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 6, 20);
  const rows = await prisma.chatMessage.findMany({
    where: { userId: req.user.sub },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  res.json({ data: rows.reverse() });
});

// Legal & Compliance — statutory benefits (PF/ESIC/CGHS/gratuity/TDS/maternity),
// leave & holiday rules, and real-time compliance alerts.
function shapeStatutoryCompliance(sc) {
  const { employee, ...rest } = sc;
  return { ...rest, employeeName: employee?.name, department: employee?.department, designation: employee?.designation };
}

/**
 * @swagger
 * /api/v1/compliance/statutory:
 *   get:
 *     summary: Get compliance statutory
 *     tags: [compliance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/compliance/statutory', requireAuth, async (req, res) => {
  const { search } = req.query;
  if (!search || search.trim().length < 2) return res.json({ data: [] });

  const data = await prisma.statutoryCompliance.findMany({
    where: {
      employee: {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { id: { contains: search, mode: 'insensitive' } },
        ],
      },
    },
    include: { employee: true },
    take: 25,
  });
  res.json({ data: data.map(shapeStatutoryCompliance) });
});

/**
 * @swagger
 * /api/v1/compliance/employee/{id}:
 *   get:
 *     summary: Get compliance employee id
 *     tags: [compliance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/compliance/employee/:id', requireAuth, async (req, res) => {
  if (blockIfNotSelf(req, res, req.params.id)) return;
  const [statutory, insurance, leaveBalances] = await Promise.all([
    prisma.statutoryCompliance.findUnique({ where: { employeeId: req.params.id }, include: { employee: true } }),
    prisma.insurance.findMany({ where: { employeeId: req.params.id } }),
    prisma.leaveBalance.findMany({ where: { employeeId: req.params.id } }),
  ]);
  if (!statutory) return res.status(404).json({ error: "No statutory record for this employee" });
  res.json({ ...shapeStatutoryCompliance(statutory), insurance, leaveBalances });
});

// Leave Management — apply/approve workflow. LeaveBalance (above) stays the
// source of truth for entitlement/balance; approving a request debits it.
/**
 * @swagger
 * /api/v1/leave/balances/{employeeId}:
 *   get:
 *     summary: Get leave balances employee Id
 *     tags: [leave]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: employeeId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/leave/balances/:employeeId', requireAuth, async (req, res) => {
  if (blockIfNotSelf(req, res, req.params.employeeId)) return;
  const data = await prisma.leaveBalance.findMany({ where: { employeeId: req.params.employeeId }, orderBy: { leaveType: 'asc' } });
  res.json({ data });
});

/**
 * @swagger
 * /api/v1/leave/requests:
 *   get:
 *     summary: Get leave requests
 *     tags: [leave]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/leave/requests', requireAuth, async (req, res) => {
  let { employeeId, department, status } = req.query;
  if (req.user.role === 'Employee') employeeId = req.user.employeeId;
  const where = {};
  if (employeeId) where.employeeId = employeeId;
  if (status) where.status = status;
  if (department && department !== 'All Departments') where.employee = { department };

  const rows = await prisma.leaveRequest.findMany({
    where, include: { employee: { select: { name: true, department: true, designation: true } } },
    orderBy: { appliedAt: 'desc' },
  });

  // For pending requests, adminHR needs to see the employee's leave history
  // and current balance alongside the request to judge patterns (frequent
  // short-notice leave, near-exhausted balance) before deciding.
  const data = await Promise.all(rows.map(async (r) => {
    const stage = r.status !== 'Pending'
      ? 'Done'
      : r.managerStatus === 'Pending' ? 'Manager Review' : 'HR Review';
    const base = {
      ...r, employeeName: r.employee?.name, department: r.employee?.department, designation: r.employee?.designation, employee: undefined, stage,
    };
    if (r.status !== 'Pending') return base;

    const year = new Date(`${r.fromDate}T00:00:00`).getFullYear();
    const [balance, priorRequests] = await Promise.all([
      prisma.leaveBalance.findUnique({ where: { employeeId_leaveType_year: { employeeId: r.employeeId, leaveType: r.leaveType, year } } }),
      prisma.leaveRequest.findMany({ where: { employeeId: r.employeeId, id: { not: r.id } }, orderBy: { appliedAt: 'desc' } }),
    ]);
    const approvedCount = priorRequests.filter((p) => p.status === 'Approved').length;
    const rejectedCount = priorRequests.filter((p) => p.status === 'Rejected').length;
    const daysTakenThisYear = priorRequests
      .filter((p) => p.status === 'Approved' && new Date(`${p.fromDate}T00:00:00`).getFullYear() === year)
      .reduce((s, p) => s + p.days, 0);

    return {
      ...base,
      balanceRemaining: balance?.balance ?? null,
      history: { approvedCount, rejectedCount, totalRequests: priorRequests.length, daysTakenThisYear },
    };
  }));
  res.json({ data });
});

// Lightweight count for dashboard tiles — deliberately skips the per-row
// balance/history enrichment that GET /api/v1/leave/requests does, since a
// tile only needs a number and the single most-recent request's summary.
/**
 * @swagger
 * /api/v1/leave/requests/pending-count:
 *   get:
 *     summary: Get leave requests pending count
 *     tags: [leave]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/leave/requests/pending-count', requireAuth, async (req, res) => {
  const { department } = req.query;
  const where = { status: 'Pending' };
  if (department && department !== 'All Departments') where.employee = { department };

  const [count, latest] = await Promise.all([
    prisma.leaveRequest.count({ where }),
    prisma.leaveRequest.findFirst({
      where, orderBy: { appliedAt: 'desc' }, include: { employee: { select: { name: true } } },
    }),
  ]);
  res.json({
    count,
    latest: latest ? { employeeName: latest.employee?.name, leaveType: latest.leaveType } : null,
  });
});

// Who is currently on approved leave, and who has approved leave coming up —
// scoped by department, computed from LeaveRequest rather than tracked separately.
/**
 * @swagger
 * /api/v1/leave/overview:
 *   get:
 *     summary: Get leave overview
 *     tags: [leave]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/leave/overview', requireAuth, async (req, res) => {
  const { department } = req.query;
  const today = new Date().toISOString().slice(0, 10);
  const where = { status: 'Approved', toDate: { gte: today } };
  if (department && department !== 'All Departments') where.employee = { department };

  const rows = await prisma.leaveRequest.findMany({
    where, include: { employee: { select: { name: true, department: true, designation: true } } },
    orderBy: { fromDate: 'asc' },
  });
  const shaped = rows.map((r) => ({
    ...r, employeeName: r.employee?.name, department: r.employee?.department, designation: r.employee?.designation, employee: undefined,
  }));
  res.json({
    current: shaped.filter((r) => r.fromDate <= today),
    upcoming: shaped.filter((r) => r.fromDate > today),
  });
});

// Per-day breakdown of approved leave for a given month, department-scoped —
// lets adminHR spot team overlap (too many people out the same day) at a glance.
/**
 * @swagger
 * /api/v1/leave/calendar:
 *   get:
 *     summary: Get leave calendar
 *     tags: [leave]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/leave/calendar', requireAuth, async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const { department } = req.query;
  const [y, m] = month.split('-').map(Number);
  const monthStart = `${month}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const monthEnd = `${month}-${String(lastDay).padStart(2, '0')}`;

  const where = { status: 'Approved', fromDate: { lte: monthEnd }, toDate: { gte: monthStart } };
  if (department && department !== 'All Departments') where.employee = { department };

  const rows = await prisma.leaveRequest.findMany({
    where, include: { employee: { select: { name: true, department: true } } },
  });

  const days = {};
  for (let d = 1; d <= lastDay; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const onLeave = rows
      .filter((r) => r.fromDate <= date && r.toDate >= date)
      .map((r) => ({ employeeId: r.employeeId, name: r.employee?.name, department: r.employee?.department, leaveType: r.leaveType }));
    if (onLeave.length > 0) days[date] = onLeave;
  }
  res.json({ month, days });
});

// Department-scoped leave utilization, most-availed type, employees nearing
// zero balance, and approval-throughput stats — for the Leave Analytics panel.
/**
 * @swagger
 * /api/v1/leave/analytics:
 *   get:
 *     summary: Get leave analytics
 *     tags: [leave]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/leave/analytics', requireAuth, async (req, res) => {
  const { department } = req.query;
  const year = new Date().getFullYear();
  const employeeWhere = department && department !== 'All Departments' ? { department } : {};

  const balances = await prisma.leaveBalance.findMany({
    where: { year, employee: employeeWhere },
    include: { employee: { select: { name: true, department: true } } },
  });

  const byType = {};
  for (const b of balances) {
    byType[b.leaveType] ??= { leaveType: b.leaveType, entitled: 0, availed: 0, balance: 0 };
    byType[b.leaveType].entitled += b.entitled;
    byType[b.leaveType].availed += b.availed;
    byType[b.leaveType].balance += b.balance;
  }
  const utilization = Object.values(byType);
  const mostAvailedType = utilization.length
    ? utilization.reduce((a, b) => (b.availed > a.availed ? b : a)).leaveType
    : null;

  const nearingZero = balances
    .filter((b) => b.balance <= 2 && b.entitled > 0)
    .map((b) => ({ employeeId: b.employeeId, name: b.employee?.name, department: b.employee?.department, leaveType: b.leaveType, balance: b.balance }))
    .sort((a, b) => a.balance - b.balance)
    .slice(0, 20);

  const decided = await prisma.leaveRequest.findMany({
    where: { status: { in: ['Approved', 'Rejected'] }, employee: employeeWhere },
    select: { status: true, appliedAt: true, decidedAt: true },
  });
  const approvedCount = decided.filter((r) => r.status === 'Approved').length;
  const rejectedCount = decided.filter((r) => r.status === 'Rejected').length;
  const approvalRate = decided.length ? Math.round((approvedCount / decided.length) * 100) : null;
  const decisionDays = decided.filter((r) => r.decidedAt).map((r) => (r.decidedAt - r.appliedAt) / (24 * 60 * 60 * 1000));
  const avgDecisionDays = decisionDays.length ? Math.round((decisionDays.reduce((a, b) => a + b, 0) / decisionDays.length) * 10) / 10 : null;

  // Department breakdown — avg total leave days availed per employee, and
  // count of currently-pending requests, both grouped by the employee's
  // real department (drives Analytics' "Leave Analytics" chart).
  const employeeAvailedTotal = new Map();
  for (const b of balances) {
    const dept = b.employee?.department;
    if (!dept) continue;
    const prev = employeeAvailedTotal.get(b.employeeId) || { total: 0, department: dept };
    prev.total += b.availed;
    employeeAvailedTotal.set(b.employeeId, prev);
  }
  const availedByDept = new Map();
  for (const { total, department } of employeeAvailedTotal.values()) {
    const agg = availedByDept.get(department) || { sum: 0, count: 0 };
    agg.sum += total;
    agg.count += 1;
    availedByDept.set(department, agg);
  }
  const pendingRows = await prisma.leaveRequest.findMany({
    where: { status: 'Pending', employee: employeeWhere },
    select: { employee: { select: { department: true } } },
  });
  const pendingByDept = new Map();
  for (const r of pendingRows) {
    const dept = r.employee?.department;
    if (!dept) continue;
    pendingByDept.set(dept, (pendingByDept.get(dept) || 0) + 1);
  }
  const byDepartment = [...availedByDept.entries()]
    .map(([department, agg]) => ({
      department,
      avgTaken: agg.count ? Math.round((agg.sum / agg.count) * 10) / 10 : 0,
      pending: pendingByDept.get(department) || 0,
    }))
    .sort((a, b) => b.avgTaken - a.avgTaken);

  res.json({ utilization, mostAvailedType, nearingZero, approvalRate, avgDecisionDays, approvedCount, rejectedCount, byDepartment });
});

// Naive inclusive day count — the seeded leave rules don't model weekends/
// holidays as leave-exempt, so a plain calendar-day difference matches the
// rest of this app's leave/balance math (see LeaveBalance, seeded flat).
function countLeaveDays(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00`);
  const to = new Date(`${toDate}T00:00:00`);
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)) + 1;
}

// Two overlapping [aFrom,aTo] / [bFrom,bTo] date ranges (inclusive, string
// dates compare lexically since they're all YYYY-MM-DD).
function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  return aFrom <= bTo && bFrom <= aTo;
}

// Adds `n` calendar days to a YYYY-MM-DD string, entirely in UTC — unlike
// `new Date(\`${d}T00:00:00\`)` (parsed as *local* time) followed by
// `.toISOString()`, which silently shifts the date backward a day on any
// server running ahead of UTC (e.g. IST, UTC+5:30).
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * @swagger
 * /api/v1/leave/requests:
 *   post:
 *     summary: Create leave requests
 *     tags: [leave]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.post('/api/v1/leave/requests', requireAuth, async (req, res) => {
  const employeeId = req.user.role === 'Employee' ? req.user.employeeId : req.body.employeeId;
  const { leaveType, fromDate, toDate, reason } = req.body;
  if (!employeeId || !leaveType || !fromDate || !toDate || !reason) {
    return res.status(400).json({ error: "employeeId, leaveType, fromDate, toDate, and reason are required" });
  }
  const days = countLeaveDays(fromDate, toDate);
  if (days < 1) return res.status(400).json({ error: "toDate must be on or after fromDate" });

  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { managerId: true, department: true, designation: true, cadre: true } });
  if (!employee) return res.status(404).json({ error: "Employee not found" });

  const rule = await prisma.leaveRule.findUnique({ where: { leaveType } });
  const today = new Date().toISOString().slice(0, 10);
  if (rule) {
    const noticeDays = countLeaveDays(today, fromDate) - 1;
    if (noticeDays < rule.minNoticeDays) {
      return res.status(400).json({ error: `${leaveType} requires at least ${rule.minNoticeDays} day(s) notice; this request gives ${Math.max(0, noticeDays)}.` });
    }
  }

  const blackouts = await prisma.leaveBlackout.findMany({
    where: { OR: [{ department: null }, { department: employee.department }] },
  });
  const hitBlackout = blackouts.find((b) => rangesOverlap(fromDate, toDate, b.fromDate, b.toDate));
  if (hitBlackout) {
    return res.status(400).json({ error: `Leave cannot be applied for during this period: ${hitBlackout.reason} (${hitBlackout.fromDate} to ${hitBlackout.toDate})` });
  }

  // Staffing-continuity rule — only one person per department/designation/
  // cadre group can be on leave at a time. Triggers on any non-Rejected peer
  // request (Pending or Approved), since two people racing for the same
  // dates would otherwise both slip through while still undecided.
  // HRAdmin/DepartmentHead may explicitly override; Employee self-service
  // cannot, regardless of what it sends.
  const peers = await prisma.employee.findMany({
    where: { department: employee.department, designation: employee.designation, cadre: employee.cadre, id: { not: employeeId } },
    select: { id: true, name: true },
  });
  const peerNameById = new Map(peers.map((p) => [p.id, p.name]));
  const peerRequests = peers.length
    ? await prisma.leaveRequest.findMany({
        where: { employeeId: { in: peers.map((p) => p.id) }, status: { not: 'Rejected' } },
        select: { employeeId: true, fromDate: true, toDate: true },
      })
    : [];
  const conflict = peerRequests.find((r) => rangesOverlap(fromDate, toDate, r.fromDate, r.toDate));
  const canOverride = req.body.overrideConflict === true && (req.user.role === 'HRAdmin' || req.user.role === 'DepartmentHead');
  if (conflict && !canOverride) {
    const earliestStart = [today, fromDate].sort()[1]; // later of the two, as plain YYYY-MM-DD strings
    const noticeFloor = rule?.minNoticeDays ? addDays(today, rule.minNoticeDays) : today;
    let candidateStart = [earliestStart, noticeFloor].sort()[1];
    let suggestion = null;
    for (let i = 0; i < 180; i++) {
      const candidateEnd = addDays(candidateStart, days - 1);
      const overlapsPeer = peerRequests.some((r) => rangesOverlap(candidateStart, candidateEnd, r.fromDate, r.toDate));
      const overlapsBlackout = blackouts.some((b) => rangesOverlap(candidateStart, candidateEnd, b.fromDate, b.toDate));
      if (!overlapsPeer && !overlapsBlackout) {
        suggestion = { fromDate: candidateStart, toDate: candidateEnd };
        break;
      }
      candidateStart = addDays(candidateStart, 1);
    }
    return res.status(400).json({
      error: `${peerNameById.get(conflict.employeeId)} (${employee.designation}, ${employee.department}) already has an overlapping leave request for these dates — only one person per role can be on leave at a time.`,
      conflict: { employeeId: conflict.employeeId, name: peerNameById.get(conflict.employeeId), fromDate: conflict.fromDate, toDate: conflict.toDate },
      suggestion,
      overridable: req.user.role === 'HRAdmin' || req.user.role === 'DepartmentHead',
    });
  }

  const year = new Date(`${fromDate}T00:00:00`).getFullYear();
  const balance = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveType_year: { employeeId, leaveType, year } } });
  if (!balance) return res.status(400).json({ error: `No ${leaveType} leave balance on file for ${year}` });
  if (days > balance.balance) {
    return res.status(400).json({ error: `Requested ${days} day(s) exceeds remaining ${leaveType} balance of ${balance.balance}` });
  }

  const count = await prisma.leaveRequest.count();
  const request = await prisma.leaveRequest.create({
    data: {
      id: `LR-${1000 + count + 1}`, employeeId, leaveType, fromDate, toDate, days, reason,
      managerId: employee.managerId, managerStatus: employee.managerId ? 'Pending' : 'NotRequired',
    },
  });
  res.status(201).json(request);
});

/**
 * @swagger
 * /api/v1/leave/requests/{id}/manager-decision:
 *   put:
 *     summary: Update leave requests id manager decision
 *     tags: [leave]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.put('/api/v1/leave/requests/:id/manager-decision', requireAuth, async (req, res) => {
  const { status, note } = req.body;
  if (status !== 'Approved' && status !== 'Rejected') return res.status(400).json({ error: "status must be 'Approved' or 'Rejected'" });

  const existing = await prisma.leaveRequest.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Leave request not found" });
  if (existing.managerStatus !== 'Pending') return res.status(400).json({ error: `Manager review is already ${existing.managerStatus}` });

  const updated = await prisma.leaveRequest.update({
    where: { id: req.params.id },
    data: {
      managerStatus: status,
      managerDecidedAt: new Date(),
      managerNote: note || null,
      // A manager rejection is final — no need to also occupy the HR queue.
      ...(status === 'Rejected' ? { status: 'Rejected', decidedBy: req.user.email, decidedAt: new Date(), decisionNote: note || 'Rejected at manager review' } : {}),
    },
  });
  res.json(updated);
});

/**
 * @swagger
 * /api/v1/leave/requests/{id}/decision:
 *   put:
 *     summary: Update leave requests id decision
 *     tags: [leave]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.put('/api/v1/leave/requests/:id/decision', requireAuth, async (req, res) => {
  const { status, note } = req.body;
  if (status !== 'Approved' && status !== 'Rejected') return res.status(400).json({ error: "status must be 'Approved' or 'Rejected'" });

  const existing = await prisma.leaveRequest.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Leave request not found" });
  if (existing.status !== 'Pending') return res.status(400).json({ error: `This request is already ${existing.status}` });
  if (existing.managerStatus === 'Pending') return res.status(400).json({ error: "Awaiting manager approval first" });

  if (status === 'Approved') {
    const year = new Date(`${existing.fromDate}T00:00:00`).getFullYear();
    const balance = await prisma.leaveBalance.findUnique({
      where: { employeeId_leaveType_year: { employeeId: existing.employeeId, leaveType: existing.leaveType, year } },
    });
    if (!balance || existing.days > balance.balance) {
      return res.status(400).json({ error: "Balance is no longer sufficient to approve this request" });
    }
    await prisma.$transaction([
      prisma.leaveBalance.update({
        where: { id: balance.id },
        data: { availed: balance.availed + existing.days, balance: balance.balance - existing.days },
      }),
      prisma.leaveRequest.update({
        where: { id: req.params.id },
        data: { status, decidedBy: req.user.email, decidedAt: new Date(), decisionNote: note || null },
      }),
    ]);
  } else {
    await prisma.leaveRequest.update({
      where: { id: req.params.id },
      data: { status, decidedBy: req.user.email, decidedAt: new Date(), decisionNote: note || null },
    });
  }

  const updated = await prisma.leaveRequest.findUnique({ where: { id: req.params.id } });
  res.json(updated);
});

/**
 * @swagger
 * /api/v1/compliance/rules:
 *   get:
 *     summary: Get compliance rules
 *     tags: [compliance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/compliance/rules', requireAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const in90Days = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [leaveRules, holidays] = await Promise.all([
    prisma.leaveRule.findMany(),
    prisma.holidayCalendar.findMany({ where: { date: { gte: today, lte: in90Days } }, orderBy: { date: 'asc' } }),
  ]);
  res.json({ leaveRules, holidays });
});

/**
 * @swagger
 * /api/v1/compliance/alerts:
 *   get:
 *     summary: Get compliance alerts
 *     tags: [compliance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/compliance/alerts', requireAuth, async (req, res) => {
  const deadlines = await prisma.statutoryDeadline.findMany();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const alerts = deadlines.map((d) => {
    let nextDue;
    if (d.recurrence === 'Monthly') {
      nextDue = new Date(today.getFullYear(), today.getMonth(), d.dueDayOfMonth);
      if (nextDue < today) nextDue = new Date(today.getFullYear(), today.getMonth() + 1, d.dueDayOfMonth);
    } else {
      const [month, day] = d.dueDate.split('-').map(Number);
      nextDue = new Date(today.getFullYear(), month - 1, day);
      if (nextDue < today) nextDue = new Date(today.getFullYear() + 1, month - 1, day);
    }
    const daysUntil = Math.round((nextDue.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
    // Format from local getters, not toISOString() — that converts to UTC and
    // can roll the date back by one in positive-offset timezones.
    const pad = (n) => String(n).padStart(2, '0');
    return {
      title: d.title,
      category: d.category,
      dueDate: `${nextDue.getFullYear()}-${pad(nextDue.getMonth() + 1)}-${pad(nextDue.getDate())}`,
      daysUntil,
      risk: daysUntil <= 3 ? "High" : daysUntil <= 10 ? "Medium" : "Low",
    };
  }).sort((a, b) => a.daysUntil - b.daysUntil);

  const gratuityEligibleCount = await prisma.statutoryCompliance.count({ where: { gratuityEligible: true } });

  res.json({ data: alerts, gratuityEligibleCount });
});

// Litigation docket — risk/win figures are computed via a transparent
// formula over real stored fields (case type, age, current status), not
// fabricated per row.
const CASE_TYPE_BASE_RISK = {
  "Land Acquisition": 70, "Public Interest Litigation": 65, "Encroachment & Demolition": 60,
  "Labour Dispute": 55, "Contractor Dispute": 50, "Property Tax Dispute": 45,
  "Service Matter": 40, "RTI Appeal": 20,
};
function computeCaseRisk(c) {
  let score = CASE_TYPE_BASE_RISK[c.type] ?? 50;
  const daysOpen = Math.round((Date.now() - new Date(c.filedDate).getTime()) / (24 * 60 * 60 * 1000));
  if ((c.status === "Pending" || c.status === "Hearing Scheduled") && daysOpen > 365) score += 10;
  if (c.status === "Disposed - Unfavorable") score += 15;
  if (c.status === "Disposed - Favorable") score -= 35;
  if (c.status === "Stayed") score -= 10;
  score = Math.max(5, Math.min(95, score));
  const winProbability = c.status === "Disposed - Favorable" ? 100
    : c.status === "Disposed - Unfavorable" ? 0
    : Math.max(5, Math.min(95, 100 - score));
  const aiRiskScore = score >= 65 ? "High" : score >= 35 ? "Medium" : "Low";
  return { aiRiskScore, riskScore: score, winProbability };
}

/**
 * @swagger
 * /api/v1/legal/cases:
 *   get:
 *     summary: Get legal cases
 *     tags: [legal]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/legal/cases', requireAuth, async (req, res) => {
  const cases = await prisma.legalCase.findMany({ orderBy: { filedDate: 'desc' } });
  const data = cases.map((c) => ({ ...c, exposure: `₹${c.exposureLakh}L`, ...computeCaseRisk(c) }));
  res.json({ data });
});

// Compliance radar — 6 metrics computed live from real statutory/grievance/
// task/legal data, replacing the wireframe's fixed 6-point spider chart.
/**
 * @swagger
 * /api/v1/compliance/radar:
 *   get:
 *     summary: Get compliance radar
 *     tags: [compliance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/compliance/radar', requireAuth, async (req, res) => {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const [
    totalStatutory, esicApplicableCount, esicRegisteredCount,
    tdsOwedCount, tdsDeductedCount,
    recentGrievances, resolvedRecentGrievances,
    deadlines,
    openHighRiskCases, totalCases,
  ] = await Promise.all([
    prisma.statutoryCompliance.count(),
    prisma.statutoryCompliance.count({ where: { esicApplicable: true } }),
    prisma.statutoryCompliance.count({ where: { esicApplicable: true, esicNumber: { not: null } } }),
    prisma.statutoryCompliance.count({ where: { employee: { cadre: { in: ["Class I", "Class II"] } } } }),
    prisma.statutoryCompliance.count({ where: { employee: { cadre: { in: ["Class I", "Class II"] } }, tdsMonthlyDeduction: { gt: 0 } } }),
    prisma.grievance.count({ where: { createdAt: { gte: ninetyDaysAgo } } }),
    prisma.grievance.count({ where: { createdAt: { gte: ninetyDaysAgo }, status: "Resolved" } }),
    prisma.statutoryDeadline.findMany(),
    prisma.legalCase.count({ where: { status: { in: ["Pending", "Hearing Scheduled"] } } }),
    prisma.legalCase.count(),
  ]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const overdueDeadlines = deadlines.filter((d) => {
    if (d.recurrence !== 'Monthly') return false;
    return today.getDate() > d.dueDayOfMonth;
  }).length;

  const laborLawScore = totalStatutory ? Math.round((esicApplicableCount ? esicRegisteredCount / esicApplicableCount : 1) * 100) : 100;
  const payrollTaxScore = totalStatutory ? Math.round((tdsDeductedCount / Math.max(1, tdsOwedCount)) * 100) : 100;
  const grievanceScore = recentGrievances ? Math.round((resolvedRecentGrievances / recentGrievances) * 100) : 100;
  const deadlineScore = deadlines.length ? Math.round(((deadlines.length - overdueDeadlines) / deadlines.length) * 100) : 100;
  const legalExposureScore = totalCases ? Math.round(((totalCases - openHighRiskCases) / totalCases) * 100) : 100;

  const data = [
    { subject: "Labor Law Compliance", A: laborLawScore, fullMark: 100 },
    { subject: "Payroll & Tax", A: payrollTaxScore, fullMark: 100 },
    { subject: "Grievance Resolution", A: grievanceScore, fullMark: 100 },
    { subject: "Statutory Deadlines", A: deadlineScore, fullMark: 100 },
    { subject: "Legal Case Exposure", A: legalExposureScore, fullMark: 100 },
  ];
  const overall = Math.round(data.reduce((s, d) => s + d.A, 0) / data.length);
  res.json({ data, overall });
});

// Task Management — real "smart alerts": SLA breaches, overloaded officers,
// and department bottlenecks, computed from live Task rows instead of the
// wireframe's 4 fixed cards.
/**
 * @swagger
 * /api/v1/tasks/alerts:
 *   get:
 *     summary: Get tasks alerts
 *     tags: [tasks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/tasks/alerts', requireAuth, async (req, res) => {
  const openStatuses = ["Pending", "InProgress", "Escalated", "Overdue"];

  const [breachedTasks, workload, allOpenTasks] = await Promise.all([
    prisma.task.findMany({ where: { slaStatus: "Breached", status: { not: "Completed" } }, include: { employee: true }, take: 5, orderBy: { updatedAt: 'desc' } }),
    prisma.task.groupBy({ by: ['employeeId'], where: { status: { in: openStatuses } }, _count: { _all: true } }),
    prisma.task.findMany({ where: { status: { in: openStatuses } }, select: { department: true, slaStatus: true } }),
  ]);

  const overloadThreshold = 8;
  const overloaded = workload.filter((w) => w._count._all >= overloadThreshold).sort((a, b) => b._count._all - a._count._all).slice(0, 3);
  const overloadedEmployees = overloaded.length
    ? await prisma.employee.findMany({ where: { id: { in: overloaded.map((o) => o.employeeId) } } })
    : [];
  const overloadedById = new Map(overloadedEmployees.map((e) => [e.id, e]));

  const byDept = new Map();
  for (const t of allOpenTasks) {
    if (!byDept.has(t.department)) byDept.set(t.department, { total: 0, breached: 0 });
    const rec = byDept.get(t.department);
    rec.total += 1;
    if (t.slaStatus === "Breached") rec.breached += 1;
  }
  let bottleneck = null;
  for (const [department, rec] of byDept.entries()) {
    if (rec.total < 5) continue;
    const rate = rec.breached / rec.total;
    if (!bottleneck || rate > bottleneck.rate) bottleneck = { department, rate, breached: rec.breached, total: rec.total };
  }

  const alerts = [
    ...breachedTasks.map((t) => ({
      type: "SLA Breach",
      title: `Task ${t.id} — ${t.title}`,
      detail: `Assigned to ${t.employee?.name || "Unassigned"} · ${t.department} · overdue by ${Math.max(0, -t.dueIn)}d`,
      severity: "High",
    })),
    ...overloaded.map((o) => {
      const e = overloadedById.get(o.employeeId);
      return {
        type: "Overloaded Officer",
        title: e?.name || o.employeeId,
        detail: `${o._count._all} open tasks · ${e?.department || ""} — consider reassigning some via workload picker`,
        severity: "Medium",
      };
    }),
    ...(bottleneck ? [{
      type: "Department Bottleneck",
      title: bottleneck.department,
      detail: `${bottleneck.breached} of ${bottleneck.total} open tasks (${Math.round(bottleneck.rate * 100)}%) are SLA-breached`,
      severity: bottleneck.rate > 0.3 ? "High" : "Medium",
    }] : []),
  ];

  res.json({ data: alerts });
});

// Emergency Alerts — civic/infrastructure incidents routed to the real
// concerned department authority, modeled on AMC's real complaint-portal
// pattern (acknowledgement id + auto-escalation on SLA breach).
const EMERGENCY_SLA_HOURS = { Critical: 2, High: 6, Medium: 24 };

/**
 * @swagger
 * /api/v1/emergency-alerts:
 *   get:
 *     summary: Get emergency alerts
 *     tags: [emergency-alerts]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/emergency-alerts', requireAuth, async (req, res) => {
  const now = Date.now();
  const stale = await prisma.emergencyAlert.findMany({ where: { status: { in: ["Open", "Acknowledged"] } } });
  for (const a of stale) {
    const slaHours = EMERGENCY_SLA_HOURS[a.severity] ?? 24;
    const ageHours = (now - new Date(a.createdAt).getTime()) / 36e5;
    if (ageHours > slaHours) {
      await prisma.emergencyAlert.update({ where: { id: a.id }, data: { status: "Escalated" } });
      await prisma.emergencyAlertUpdate.create({
        data: { alertId: a.id, status: "Escalated", note: `Auto-escalated after exceeding the ${slaHours}h SLA for ${a.severity} severity.` },
      });
    }
  }
  const data = await prisma.emergencyAlert.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ data });
});

/**
 * @swagger
 * /api/v1/emergency-alerts:
 *   post:
 *     summary: Create emergency alerts
 *     tags: [emergency-alerts]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.post('/api/v1/emergency-alerts', requireAuth, async (req, res) => {
  const { category, title, description, department, location, severity, reportedBy } = req.body;
  if (!category || !title || !description || !department || !severity) {
    return res.status(400).json({ error: "category, title, description, department, and severity are required" });
  }

  let authorityEmployeeId = null;
  const dept = await prisma.department.findFirst({ where: { OR: [{ id: department }, { name: department }] } });
  if (dept) {
    const head = await prisma.employee.findFirst({
      where: { departmentId: dept.id, OR: [{ managerId: null }, { manager: { departmentId: { not: dept.id } } }] },
      orderBy: { id: 'asc' },
    });
    authorityEmployeeId = head?.id ?? null;
  }

  const count = await prisma.emergencyAlert.count();
  const alert = await prisma.emergencyAlert.create({
    data: {
      id: `EMG-${1000 + count + 1}`,
      category, title, description, department, location: location || null,
      severity, reportedBy: reportedBy || null, authorityEmployeeId,
    },
  });
  await prisma.emergencyAlertUpdate.create({ data: { alertId: alert.id, status: "Open", note: "Emergency alert raised." } });
  res.status(201).json(alert);
});

/**
 * @swagger
 * /api/v1/emergency-alerts/{id}/status:
 *   put:
 *     summary: Update emergency alerts id status
 *     tags: [emergency-alerts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.put('/api/v1/emergency-alerts/:id/status', requireAuth, async (req, res) => {
  const { status, channel, note } = req.body;
  if (!status) return res.status(400).json({ error: "status is required" });

  const data = { status };
  if (status === "Acknowledged") data.acknowledgedAt = new Date();
  if (status === "Resolved") data.resolvedAt = new Date();

  const alert = await prisma.emergencyAlert.update({ where: { id: req.params.id }, data });
  await prisma.emergencyAlertUpdate.create({
    data: { alertId: alert.id, status, channel: channel || null, note: note || `Status changed to ${status}${channel ? ` via ${channel}` : ""}.` },
  });
  res.json(alert);
});

// Command Centre "AI Agents" — latest scheduled run per agent, and full
// detail for the overlay. See server-core/agents.js for the computation and
// server-ai's /api/v1/agents/narrate for the LLM narrative layer.
/**
 * @swagger
 * /api/v1/agents:
 *   get:
 *     summary: Get agents
 *     tags: [agents]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/agents', requireAuth, async (req, res) => {
  const data = await Promise.all(AGENTS.map(async (agent) => {
    const latest = await prisma.agentRun.findFirst({ where: { agentKey: agent.key }, orderBy: { ranAt: 'desc' } });
    return latest
      ? { agentKey: latest.agentKey, status: latest.status, confidence: latest.confidence, ranAt: latest.ranAt }
      : { agentKey: agent.key, status: 'Idle', confidence: 0, ranAt: null };
  }));
  res.json({ data });
});

/**
 * @swagger
 * /api/v1/agents/{key}:
 *   get:
 *     summary: Get agents key
 *     tags: [agents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Missing or invalid token
 */
app.get('/api/v1/agents/:key', requireAuth, async (req, res) => {
  const latest = await prisma.agentRun.findFirst({ where: { agentKey: req.params.key }, orderBy: { ranAt: 'desc' } });
  if (!latest) return res.status(404).json({ error: 'This agent has not run yet.' });
  res.json(latest);
});

// Manual "Run now" — recomputes one agent immediately instead of waiting for
// its own cadence (up to 24h for most agents). HR Admin/Dept Head only, same
// as everything else in this dashboard an ordinary Employee login has no
// business triggering; also rate-limited per agent (in-memory, fine for a
// single-instance server) so a user double-clicking doesn't force back-to-
// back recomputes or LLM calls.
const _lastManualRun = new Map();
const MANUAL_RUN_COOLDOWN_MS = 30 * 1000;
app.post('/api/v1/agents/:key/run', requireAuth, async (req, res) => {
  if (req.user.role === 'Employee') return res.status(403).json({ error: 'Only HR staff can trigger a manual agent run.' });
  const { key } = req.params;
  if (!AGENTS.some((a) => a.key === key)) return res.status(404).json({ error: `Unknown agent '${key}'.` });

  const last = _lastManualRun.get(key) || 0;
  const waitMs = MANUAL_RUN_COOLDOWN_MS - (Date.now() - last);
  if (waitMs > 0) return res.status(429).json({ error: `This agent was just run — try again in ${Math.ceil(waitMs / 1000)}s.` });
  _lastManualRun.set(key, Date.now());

  try {
    const [result] = await runAgentTick({ force: true, onlyKey: key });
    if (!result) return res.status(500).json({ error: 'Agent run produced no result.' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: `Agent run failed: ${e.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`AWIP Core Server is running on port ${PORT}`);

  // Run once shortly after boot (lets Prisma/Neon connection warm up first),
  // then re-check every 15 minutes which agents are due per their own
  // cadence (agents.js AGENTS[].intervalMs) — see runAgentTick().
  setTimeout(() => { runAgentTick().catch((e) => console.error('Agent tick failed:', e)); }, 5000);
  setInterval(() => { runAgentTick().catch((e) => console.error('Agent tick failed:', e)); }, 15 * 60 * 1000);
});
