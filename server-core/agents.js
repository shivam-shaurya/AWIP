// AI Agents (Command Centre) — deterministic findings + confidence/status for
// each agent, computed straight from Prisma. The LLM narrative layer
// (server-ai POST /api/v1/agents/narrate) only phrases what these functions
// already decided — no agent lets the model compute a number.
import { prisma } from './db.js';
import { getAhmedabadWeather } from './weather.js';

const AI_API_URL = process.env.AI_API_URL || 'http://localhost:8000';

function round1(n) { return Math.round(n * 10) / 10; }

// Confidence is capped below 100 — these are live statistical estimates over
// a changing dataset, and a formula that can output "100% confidence" reads
// as decorative rather than a real signal. Floor of 5 for the same reason in
// the other direction (never claim zero confidence in a computed number).
export function clampConfidence(n) { return Math.max(5, Math.min(97, Math.round(n))); }

// Additional confidence deduction for a thin evidentiary base — e.g. a
// department/cadre bucket of 1-2 people showing "100% retirement-due" isn't
// a real pattern, it's a small-sample artifact. Scales from 0 (n >= minGood)
// up to maxPenalty (n === 0).
function sampleSizePenalty(n, minGood, maxPenalty = 20) {
  return Math.max(0, (minGood - Math.min(n, minGood)) / minGood) * maxPenalty;
}

// Least-squares linear regression over [{x, y}] points — x is a 0-indexed
// month number, y the metric being projected forward. r2 (0-1) measures how
// well a straight line actually fits the real historical points; every
// confidence formula below scales off it instead of assuming a trend fit is
// automatically reliable just because there was enough data to attempt one.
export function linearTrend(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0]?.y ?? 0, r2: 0 };
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (!denom) return { slope: 0, intercept: sumY / n, r2: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const meanY = sumY / n;
  const ssTot = points.reduce((s, p) => s + (p.y - meanY) ** 2, 0);
  const ssRes = points.reduce((s, p) => s + (p.y - (slope * p.x + intercept)) ** 2, 0);
  const r2 = ssTot ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { slope, intercept, r2 };
}

// Project a fitted trend `stepsAhead` x-units past the last x it was fit on.
export function projectForward(trend, lastX, stepsAhead = 1) {
  return trend.intercept + trend.slope * (lastX + stepsAhead);
}

// Real vacancy shortfall for a department — sanctioned minus filled per
// designation, same computation as GET /api/v1/org/departments/:id/vacancies.
// Shared by Weather Staffing Planner and Workforce Capacity Predictor.
async function computeVacancyCount(departmentId) {
  const vacancyRows = await prisma.vacancy.findMany({ where: { department: departmentId } });
  if (!vacancyRows.length) return { vacancyCount: 0, sanctioned: 0 };
  const filledByDesignation = await prisma.employee.groupBy({
    by: ['designation'],
    where: { departmentId, designation: { in: vacancyRows.map((v) => v.designation) } },
    _count: { _all: true },
  });
  const filledMap = new Map(filledByDesignation.map((f) => [f.designation, f._count._all]));
  const sanctioned = vacancyRows.reduce((s, v) => s + v.sanctioned, 0);
  const vacancyCount = vacancyRows.reduce((s, v) => s + Math.max(0, v.sanctioned - (filledMap.get(v.designation) || 0)), 0);
  return { vacancyCount, sanctioned };
}

// Real, measured current headcount by zone for a department — used to find
// which zone is comparatively thinnest-staffed right now. This is a relative
// comparison across zones (a real number), not a fabricated absolute
// "zone X needs N more staff" figure — Vacancy has no zone column to
// sanction against, so no absolute per-zone shortfall can be computed.
async function computeThinnestZone(department) {
  const rows = await prisma.employee.groupBy({
    by: ['zone'], where: { department, status: 'Active', zone: { not: null } }, _count: { _all: true },
  });
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => a._count._all - b._count._all);
  return { zone: sorted[0].zone, headcount: sorted[0]._count._all };
}

// ── Workforce Demand Predictor ──────────────────────────────────────────
// Fits a straight-line trend through each department/zone's actual monthly
// task volume (TaskMonthlySnapshot — seeded with genuine improving/flat/
// declining drift per combo, see seed.js buildTaskMonthlySnapshots) and
// projects one month ahead, then contextualizes that projection against
// real near-term supply-side signals (declared holidays, already-filed
// leave) instead of treating every month as equally staffable.
const MIN_TREND_MONTHS = 4;
const MIN_R2_FOR_SIGNAL = 0.3;
const DEMAND_INCREASE_ALERT_PCT = 15;
const TYPICAL_HOLIDAYS_PER_MONTH = 2;

async function upcomingLeaveDaysByDepartment(daysAhead = 30) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const untilStr = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await prisma.leaveRequest.findMany({
    where: { status: { in: ['Pending', 'Approved'] }, fromDate: { gte: todayStr, lte: untilStr } },
    include: { employee: { select: { department: true } } },
  });
  const byDept = new Map();
  for (const r of rows) {
    const dept = r.employee?.department;
    if (!dept) continue;
    byDept.set(dept, (byDept.get(dept) || 0) + r.days);
  }
  return byDept;
}

async function computeWorkforceDemandPredictor() {
  const rows = await prisma.taskMonthlySnapshot.findMany({ orderBy: { month: 'asc' } });
  const byPair = new Map();
  for (const r of rows) {
    const key = `${r.department}::${r.zone}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(r);
  }

  const today = new Date();
  const nextMonthDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const nextMonthKey = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, '0')}`;
  const holidaysNextMonth = await prisma.holidayCalendar.count({ where: { date: { startsWith: nextMonthKey } } });
  // A typical month absorbs a couple of declared holidays already — only
  // holidays beyond that typical count meaningfully shrink working days.
  const workingDaysFactor = round1(1 - Math.max(0, holidaysNextMonth - TYPICAL_HOLIDAYS_PER_MONTH) * 0.03);

  const leaveDaysByDept = await upcomingLeaveDaysByDepartment(30);

  const projections = [];
  let smallSampleExcluded = 0;
  // Confidence is averaged over only the pairs actually surfaced below (not
  // every department/zone pair in the dataset) — most pairs never clear the
  // r2/changePct alert bar at all, and averaging their (irrelevant, mostly
  // noisy) fits into the score used to mislead by disconnecting "how much
  // should I trust this specific alert" from "how noisy is the org overall."
  let r2Sum = 0, r2Count = 0;
  // Nearest reliable (r2-cleared) pair that still fell short of the alert
  // bar — kept only so the idle-state narrative can say something real
  // ("closest is X at +9%, threshold is 15%") instead of a content-free "no
  // action needed." Gated on the same r2 bar as an actual alert so this
  // never surfaces a noisy, unreliable fit as if it were a near-miss.
  let closest = null;
  for (const [key, monthRows] of byPair.entries()) {
    const [department, zone] = key.split('::');
    if (monthRows.length < MIN_TREND_MONTHS) { smallSampleExcluded++; continue; }
    const sorted = [...monthRows].sort((a, b) => a.month.localeCompare(b.month));
    const points = sorted.map((r, i) => ({ x: i, y: r.totalTasks }));
    const trend = linearTrend(points);
    const projectedNextMonthTasks = Math.max(0, Math.round(projectForward(trend, points.length - 1, 1) * workingDaysFactor));
    const currentMonthTasks = sorted[sorted.length - 1].totalTasks;
    const changePct = currentMonthTasks ? round1(((projectedNextMonthTasks - currentMonthTasks) / currentMonthTasks) * 100) : 0;
    if (trend.r2 >= MIN_R2_FOR_SIGNAL && changePct > DEMAND_INCREASE_ALERT_PCT) {
      projections.push({
        department, zone, currentMonthTasks, projectedNextMonthTasks, changePct,
        trendR2: round1(trend.r2), upcomingLeaveDays: leaveDaysByDept.get(department) || 0,
      });
      r2Sum += trend.r2; r2Count++;
    } else if (trend.r2 >= MIN_R2_FOR_SIGNAL && (!closest || changePct > closest.changePct)) {
      closest = { department, zone, changePct, trendR2: round1(trend.r2) };
    }
  }
  projections.sort((a, b) => b.changePct - a.changePct);

  const avgR2 = r2Count ? r2Sum / r2Count : 0;
  return {
    findings: {
      nextMonth: nextMonthKey, holidaysNextMonth, workingDaysFactor, projections: projections.slice(0, 10),
      smallSampleExcluded, alertThresholdPct: DEMAND_INCREASE_ALERT_PCT, closest,
    },
    alert: projections.length > 0,
    confidence: clampConfidence(avgR2 * 90 - sampleSizePenalty(byPair.size - smallSampleExcluded, 15, 15)),
  };
}

// ── Workforce Capacity Predictor ────────────────────────────────────────
// Effective near-term capacity per department = current active headcount
// minus real, dated drains on it (leave already filed for the next 30 days,
// retirements landing in the next 60) — compared against that department's
// own historical workload-per-head ratio (from the same TaskMonthlySnapshot
// data Demand Predictor uses), not an arbitrary universal target.
const CAPACITY_SHORTFALL_ALERT_PCT = 10;
const MIN_DEPT_HEADCOUNT = 15;

async function computeWorkforceCapacityPredictor() {
  const [departments, headcountRows, leaveDaysByDept, taskRows] = await Promise.all([
    prisma.department.findMany(),
    prisma.employee.groupBy({ by: ['department'], where: { status: 'Active' }, _count: { _all: true } }),
    upcomingLeaveDaysByDepartment(30),
    prisma.taskMonthlySnapshot.findMany({ orderBy: { month: 'asc' } }),
  ]);
  const headcountByDept = new Map(headcountRows.map((r) => [r.department, r._count._all]));

  const todayStr = new Date().toISOString().slice(0, 10);
  const in60Days = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const upcomingRetirees = await prisma.employee.findMany({
    where: { retirementDue: true, status: 'Active', retirement: { gte: todayStr, lte: in60Days } },
    select: { department: true },
  });
  const retireesByDept = new Map();
  for (const e of upcomingRetirees) retireesByDept.set(e.department, (retireesByDept.get(e.department) || 0) + 1);

  const tasksByDept = new Map();
  for (const r of taskRows) {
    if (!tasksByDept.has(r.department)) tasksByDept.set(r.department, []);
    tasksByDept.get(r.department).push(r.totalTasks);
  }

  const shortfalls = [];
  let smallSampleExcluded = 0;
  // Confidence weights the departments actually surfaced below by (a) how
  // many months of task history back their own historical ratio (a ratio
  // from 3 months is shakier than one from 12) and (b) how far past the
  // alert threshold the shortfall actually sits (a 12% shortfall against a
  // 10% bar is a much weaker signal than a 40% shortfall) — previously this
  // was a flat 75 regardless of either, so a marginal and an extreme
  // shortfall looked equally trustworthy.
  let monthsSum = 0, signalSum = 0, surfacedCount = 0;
  // See computeWorkforceDemandPredictor's `closest` for why this is tracked.
  let closest = null;
  for (const dept of departments) {
    const headcount = headcountByDept.get(dept.name) || 0;
    if (headcount < MIN_DEPT_HEADCOUNT) { smallSampleExcluded++; continue; }
    const monthly = tasksByDept.get(dept.name);
    if (!monthly || !monthly.length) continue;

    const leaveDays = leaveDaysByDept.get(dept.name) || 0;
    const retiringCount = retireesByDept.get(dept.name) || 0;
    const effectiveCapacity = round1(headcount - leaveDays / 30 - retiringCount);

    const avgRatio = monthly.reduce((s, t) => s + t / headcount, 0) / monthly.length;
    const latestRatio = monthly[monthly.length - 1] / headcount;
    const projectedRatio = latestRatio * (headcount / Math.max(1, effectiveCapacity));
    const shortfallPct = avgRatio ? round1(((projectedRatio - avgRatio) / avgRatio) * 100) : 0;

    if (shortfallPct > CAPACITY_SHORTFALL_ALERT_PCT) {
      shortfalls.push({ department: dept.name, headcount, effectiveCapacity, upcomingLeaveDays: leaveDays, retiringWithin60d: retiringCount, shortfallPct });
      monthsSum += monthly.length;
      signalSum += Math.min(30, shortfallPct - CAPACITY_SHORTFALL_ALERT_PCT);
      surfacedCount++;
    } else if (!closest || shortfallPct > closest.shortfallPct) {
      closest = { department: dept.name, shortfallPct };
    }
  }
  shortfalls.sort((a, b) => b.shortfallPct - a.shortfallPct);

  const avgMonthsSurfaced = surfacedCount ? monthsSum / surfacedCount : 0;
  const avgSignalSurfaced = surfacedCount ? signalSum / surfacedCount : 0;
  return {
    findings: { shortfalls: shortfalls.slice(0, 10), smallSampleExcluded, alertThresholdPct: CAPACITY_SHORTFALL_ALERT_PCT, closest },
    alert: shortfalls.length > 0,
    confidence: clampConfidence(
      45 + Math.min(20, avgMonthsSurfaced * 2) + avgSignalSurfaced - sampleSizePenalty(departments.length - smallSampleExcluded, 15, 15),
    ),
  };
}

// ── Attendance Risk Predictor ───────────────────────────────────────────
// Same department/zone grouping as before, but instead of comparing the
// latest month to a backward-looking baseline (anomaly detection of the
// past), fits a trend across all available months and projects next
// month's attendance % — flagging risk before it shows up in the numbers.
async function computeAttendanceRiskPredictor() {
  const rows = await prisma.$queryRaw`
    SELECT e."department" as department, e."zone" as zone, a."month" as month,
           AVG(a."presentDays"::float / NULLIF(a."totalDays", 0)) as pct
    FROM attendance_summary a JOIN employees e ON e."id" = a."employeeId"
    WHERE e."zone" IS NOT NULL
    GROUP BY e."department", e."zone", a."month"
  `;

  // A department/zone pair with a handful of employees can swing several
  // points month to month from ordinary individual variance, not a real
  // risk signal — require a minimum headcount before a projection counts.
  const MIN_PAIR_HEADCOUNT = 5;
  const headcountRows = await prisma.employee.groupBy({
    by: ['department', 'zone'], where: { status: 'Active', zone: { not: null } }, _count: { _all: true },
  });
  const headcountByPair = new Map(headcountRows.map((r) => [`${r.department}::${r.zone}`, r._count._all]));

  const byPair = new Map();
  for (const r of rows) {
    const key = `${r.department}::${r.zone}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push({ month: r.month, pct: Number(r.pct) * 100 });
  }

  const RISK_THRESHOLD_PCT = 85;
  const pairs = [];
  let smallSampleExcluded = 0;
  let insufficientHistory = 0;
  // Confidence below blends a real-breach base (a pair already projected
  // under the threshold is a measured fact, not a trend claim) with the
  // actual fit quality/history depth of the pairs surfaced — previously this
  // computed trend.r2 per pair but never used it in the confidence formula,
  // so two runs with identical alert counts but wildly different trend
  // reliability produced the same confidence.
  let r2Sum = 0, monthsSum = 0, surfacedCount = 0;
  // See computeWorkforceDemandPredictor's `closest` for why this is tracked
  // — here "closest" means lowest projected % (nearest to breaching the
  // threshold from above), among pairs whose trend fit actually clears the
  // reliability bar.
  let closest = null;
  for (const [key, months] of byPair.entries()) {
    const [department, zone] = key.split('::');
    if ((headcountByPair.get(key) || 0) < MIN_PAIR_HEADCOUNT) { smallSampleExcluded++; continue; }
    const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month));
    if (sorted.length < MIN_TREND_MONTHS) { insufficientHistory++; continue; }
    const points = sorted.map((m, i) => ({ x: i, y: m.pct }));
    const trend = linearTrend(points);
    const currentPct = sorted[sorted.length - 1].pct;
    const projectedNextMonthPct = round1(projectForward(trend, points.length - 1, 1));
    if (projectedNextMonthPct < RISK_THRESHOLD_PCT || (trend.slope < -0.5 && trend.r2 >= MIN_R2_FOR_SIGNAL)) {
      pairs.push({ department, zone, currentPct: round1(currentPct), projectedNextMonthPct, trendR2: round1(trend.r2) });
      r2Sum += trend.r2; monthsSum += sorted.length; surfacedCount++;
    } else if (trend.r2 >= MIN_R2_FOR_SIGNAL && (!closest || projectedNextMonthPct < closest.projectedNextMonthPct)) {
      closest = { department, zone, projectedNextMonthPct, trendR2: round1(trend.r2) };
    }
  }
  pairs.sort((a, b) => a.projectedNextMonthPct - b.projectedNextMonthPct);

  const totalPairsConsidered = byPair.size;
  const avgR2Surfaced = surfacedCount ? r2Sum / surfacedCount : 0;
  const avgMonthsSurfaced = surfacedCount ? monthsSum / surfacedCount : 0;
  return {
    findings: { pairs: pairs.slice(0, 10), insufficientHistory, smallSampleExcluded, riskThresholdPct: RISK_THRESHOLD_PCT, closest },
    alert: pairs.length > 0,
    confidence: clampConfidence(
      65 + avgR2Surfaced * 20 + Math.min(7, avgMonthsSurfaced) - insufficientHistory * 4 - sampleSizePenalty(totalPairsConsidered, 15, 15),
    ),
  };
}

// ── Budget Overrun Predictor ───────────────────────────────────────────
// Fits a trend through each department's monthly variance % (up to the 12
// months DepartmentFinance carries) and projects next month's variance,
// instead of only reporting last month's actual. seed.js randomizes each
// month's variance independently rather than baking in a drift, so a weak
// trend fit here is the honest answer for this dataset — the confidence
// formula is weighted directly by fit quality (r2) so it reflects that
// rather than presenting a confident forecast built from noise.
async function computeBudgetOverrunPredictor() {
  const [rows, departments] = await Promise.all([
    prisma.departmentFinance.findMany({ orderBy: { month: 'asc' } }),
    prisma.department.findMany(),
  ]);
  if (!rows.length) return { findings: { latestMonth: null, projections: [] }, alert: false, confidence: 100 };
  const nameById = new Map(departments.map((d) => [d.id, d.name]));
  const latestMonth = rows[rows.length - 1].month;

  // department_finance.department stores the short department code (e.g.
  // "PLAN"), not the display name — map to Department.name for narratives.
  const byDeptMonth = new Map();
  let missingSpendCategories = 0, totalCategories = 0;
  for (const r of rows) {
    totalCategories++;
    if (r.amountSpent == null) { missingSpendCategories++; continue; }
    const key = `${r.department}::${r.month}`;
    if (!byDeptMonth.has(key)) byDeptMonth.set(key, { allocatedBudget: 0, amountSpent: 0 });
    const bucket = byDeptMonth.get(key);
    bucket.allocatedBudget += r.allocatedBudget || 0;
    bucket.amountSpent += r.amountSpent || 0;
  }

  const byDept = new Map();
  for (const [key, v] of byDeptMonth.entries()) {
    const [department, month] = key.split('::');
    if (!byDept.has(department)) byDept.set(department, []);
    const variancePct = v.allocatedBudget ? ((v.amountSpent - v.allocatedBudget) / v.allocatedBudget) * 100 : 0;
    byDept.get(department).push({ month, variancePct });
  }

  const MIN_MONTHS = 6;
  const ALERT_PROJECTED_VARIANCE_PCT = 10;
  const projections = [];
  let smallSampleExcluded = 0;
  // Same fix as the Demand Predictor: only average the fit quality of
  // departments actually surfaced as an overrun projection below, not every
  // department's fit (most of which never cross the alert threshold and are
  // irrelevant to how much the user should trust the shown projection).
  let r2Sum = 0, r2Count = 0;
  // See computeWorkforceDemandPredictor's `closest` for why this is tracked.
  let closest = null;
  for (const [department, monthRows] of byDept.entries()) {
    const sorted = [...monthRows].sort((a, b) => a.month.localeCompare(b.month));
    if (sorted.length < MIN_MONTHS) { smallSampleExcluded++; continue; }
    const points = sorted.map((r, i) => ({ x: i, y: r.variancePct }));
    const trend = linearTrend(points);
    const projectedNextMonthVariancePct = round1(projectForward(trend, points.length - 1, 1));
    const current = sorted[sorted.length - 1];
    if (projectedNextMonthVariancePct > ALERT_PROJECTED_VARIANCE_PCT) {
      projections.push({
        department: nameById.get(department) || department,
        currentMonth: current.month, currentVariancePct: round1(current.variancePct),
        projectedNextMonthVariancePct, trendR2: round1(trend.r2),
      });
      r2Sum += trend.r2; r2Count++;
    } else if (trend.r2 >= MIN_R2_FOR_SIGNAL && (!closest || projectedNextMonthVariancePct > closest.projectedNextMonthVariancePct)) {
      closest = { department: nameById.get(department) || department, projectedNextMonthVariancePct, trendR2: round1(trend.r2) };
    }
  }
  projections.sort((a, b) => b.projectedNextMonthVariancePct - a.projectedNextMonthVariancePct);

  const avgR2 = r2Count ? r2Sum / r2Count : 0;
  return {
    findings: { latestMonth, projections: projections.slice(0, 10), smallSampleExcluded, alertThresholdPct: ALERT_PROJECTED_VARIANCE_PCT, closest },
    alert: projections.length > 0,
    confidence: clampConfidence(
      avgR2 * 85 - (totalCategories ? (missingSpendCategories / totalCategories) * 100 : 0) - sampleSizePenalty(byDept.size - smallSampleExcluded, 10, 10),
    ),
  };
}

// ── Skill Gap Predictor ─────────────────────────────────────────────────
// Real forward projection: current holders of a department-critical skill,
// minus how many of them are retirement-due within 24 months (real dates),
// giving a projected holder count — flagged when that projection falls
// below a viable floor. The training-completion rate for a related
// mandated course is included as a current (not trended — training_records
// has no completion-date time series to fit a trend on) backfill-rate proxy.
const CRITICAL_SKILLS_BY_DEPARTMENT = {
  'Water Supply': { skill: 'Water Treatment Ops', relatedCourse: null },
  'Drainage': { skill: 'Site Inspection', relatedCourse: 'Disaster Response Drill' },
  'Fire & Emergency Services': { skill: 'Fire Safety Protocols', relatedCourse: 'Occupational Health & Safety' },
  'Legal': { skill: 'Legal Drafting', relatedCourse: null },
  'Engineering': { skill: 'AutoCAD', relatedCourse: null },
  'Town Planning': { skill: 'GIS Mapping', relatedCourse: null },
  'Accounts & Finance': { skill: 'Financial Auditing', relatedCourse: 'Financial Compliance & Audit' },
};
const MANDATED_COURSES = ['Occupational Health & Safety', 'Disaster Response Drill', 'Financial Compliance & Audit'];
const SKILL_HOLDER_LOSS_ALERT_PCT = 20;
const MIN_HOLDERS = 8;

async function computeSkillGapPredictor() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const in24Months = new Date(Date.now() + 24 * 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const projections = [];
  let smallSampleExcluded = 0;
  // Confidence weights the skill/department pairs actually surfaced below by
  // (a) how many current holders the percentage is computed over (a 25% loss
  // on 8 holders is a much shakier base rate than 25% on 40) and (b) how far
  // past the alert threshold the projected loss sits — previously this was a
  // flat 80 regardless of either, so a thin, marginal finding and a deep,
  // well-evidenced one looked equally trustworthy.
  let holdersSum = 0, signalSum = 0, surfacedCount = 0;
  // See computeWorkforceDemandPredictor's `closest` for why this is tracked.
  let closest = null;
  for (const [department, { skill, relatedCourse }] of Object.entries(CRITICAL_SKILLS_BY_DEPARTMENT)) {
    const holders = await prisma.employeeSkill.findMany({
      where: { name: skill, employee: { department, status: 'Active' } },
      select: { employeeId: true, employee: { select: { retirementDue: true, retirement: true } } },
    });
    if (holders.length < MIN_HOLDERS) { smallSampleExcluded++; continue; }
    const retiringHolders = holders.filter((h) => h.employee?.retirementDue && h.employee.retirement >= todayStr && h.employee.retirement <= in24Months).length;
    const projectedHolders24mo = holders.length - retiringHolders;
    const projectedLossPct = round1((retiringHolders / holders.length) * 100);

    let backfillCompletionPct = null;
    if (relatedCourse) {
      const courseRows = await prisma.trainingRecord.findMany({
        where: { title: relatedCourse, employee: { department } },
        select: { status: true },
      });
      if (courseRows.length) backfillCompletionPct = round1((courseRows.filter((r) => r.status === 'Completed').length / courseRows.length) * 100);
    }

    if (projectedLossPct > SKILL_HOLDER_LOSS_ALERT_PCT) {
      projections.push({
        department, skill, currentHolders: holders.length, retiringWithin24mo: retiringHolders,
        projectedHolders24mo, projectedLossPct, relatedCourse, backfillCompletionPct,
      });
      holdersSum += holders.length;
      signalSum += Math.min(25, projectedLossPct - SKILL_HOLDER_LOSS_ALERT_PCT);
      surfacedCount++;
    } else if (!closest || projectedLossPct > closest.projectedLossPct) {
      closest = { department, skill, projectedLossPct };
    }
  }
  projections.sort((a, b) => b.projectedLossPct - a.projectedLossPct);

  const avgHoldersSurfaced = surfacedCount ? holdersSum / surfacedCount : 0;
  const avgSignalSurfaced = surfacedCount ? signalSum / surfacedCount : 0;
  return {
    findings: {
      projections: projections.slice(0, 10), criticalSkillsTracked: Object.keys(CRITICAL_SKILLS_BY_DEPARTMENT).length,
      smallSampleExcluded, alertThresholdPct: SKILL_HOLDER_LOSS_ALERT_PCT, closest,
    },
    alert: projections.length > 0,
    confidence: clampConfidence(
      40 + Math.min(25, avgHoldersSurfaced) + avgSignalSurfaced - sampleSizePenalty(Object.keys(CRITICAL_SKILLS_BY_DEPARTMENT).length - smallSampleExcluded, 5, 20),
    ),
  };
}

// ── Weather Staffing Planner ────────────────────────────────────────────
const HIGH_LOAD_DEPARTMENTS = ['Drainage', 'Water Supply', 'Fire & Emergency Services', 'Solid Waste Management'];
const LOW_LOAD_DEPARTMENTS = ['Garden', 'Sports', 'Administration'];
const MIN_STAFFING_FLOOR_PCT = 0.8;
// Gujarat's actual IMD-published monsoon window — display-only context
// ("currently inside/outside the typical window"), NOT what drives alerting
// below. The real trigger is measured rainfall (see rainTriggerActive), so
// an early/late monsoon or an unseasonal heavy-rain event still gets caught.
const MONSOON_WINDOW_MONTHS = [6, 7, 8, 9]; // June-September, 1-indexed
const RAIN_TRIGGER_BANDS = ['Moderate Rain', 'Heavy Rain', 'Very Heavy Rain'];

async function computeWeatherStaffPlanner() {
  const currentMonth = new Date().getMonth() + 1;
  const monsoonWindowActive = MONSOON_WINDOW_MONTHS.includes(currentMonth);
  const weather = await getAhmedabadWeather();
  const rainTriggerActive = weather.available && RAIN_TRIGGER_BANDS.includes(weather.conditionLabel);

  const departments = await prisma.department.findMany();
  const idByName = new Map(departments.map((d) => [d.name, d.id]));
  const counts = await prisma.employee.groupBy({ by: ['department'], where: { status: 'Active' }, _count: { _all: true } });
  const countByDept = new Map(counts.map((c) => [c.department, c._count._all]));

  // Real signal: sanctioned-vs-filled vacancy gap for each high-load
  // department (same data as /api/v1/org/departments/:id/vacancies), not a
  // seasonal multiplier applied to the department's own headcount — that
  // would compare a number against a multiple of itself and always fire.
  // A department with only a handful of sanctioned posts can show a large
  // vacancy % from a single open post — require a minimum sanctioned count
  // before it counts as a real signal.
  const MIN_SANCTIONED = 10;
  const ALERT_VACANCY_RATE_PCT = 5;
  const shortStaffed = [];
  let smallSampleExcluded = 0;
  for (const dept of HIGH_LOAD_DEPARTMENTS) {
    const deptId = idByName.get(dept);
    if (!deptId) continue;
    const { vacancyCount, sanctioned } = await computeVacancyCount(deptId);
    if (sanctioned < MIN_SANCTIONED) { smallSampleExcluded++; continue; }
    const vacancyRatePct = round1((vacancyCount / sanctioned) * 100);
    if (vacancyRatePct > ALERT_VACANCY_RATE_PCT) {
      const thinnest = await computeThinnestZone(dept);
      shortStaffed.push({
        department: dept, currentHeadcount: countByDept.get(dept) || 0, sanctioned, vacancyCount, vacancyRatePct,
        priorityZone: thinnest?.zone ?? null, priorityZoneHeadcount: thinnest?.headcount ?? null,
      });
    }
  }
  shortStaffed.sort((a, b) => b.vacancyRatePct - a.vacancyRatePct);

  // Redeployment pool / emergency crew allocation: a policy assumption, not
  // a measured figure — up to MIN_STAFFING_FLOOR_PCT's complement of each
  // low-load department's current headcount is treated as available for
  // temporary redeployment.
  let redeploymentPool = 0;
  for (const dept of LOW_LOAD_DEPARTMENTS) {
    const current = countByDept.get(dept) || 0;
    const floor = Math.round(current * MIN_STAFFING_FLOOR_PCT);
    redeploymentPool += Math.max(0, current - floor);
  }

  // Rescheduling outdoor work: real, queryable list of open field tasks in
  // flood-critical departments — not fabricated, an actual Task table read.
  const OUTDOOR_TASK_CATEGORIES = ['Inspection', 'Survey', 'Maintenance'];
  const rescheduleCandidates = rainTriggerActive
    ? await prisma.task.findMany({
        where: { department: { in: HIGH_LOAD_DEPARTMENTS }, category: { in: OUTDOOR_TASK_CATEGORIES }, status: { not: 'Completed' } },
        select: { id: true, title: true, department: true, dueIn: true },
        take: 5,
      })
    : [];
  const rescheduleCandidateCount = rainTriggerActive
    ? await prisma.task.count({ where: { department: { in: HIGH_LOAD_DEPARTMENTS }, category: { in: OUTDOOR_TASK_CATEGORIES }, status: { not: 'Completed' } } })
    : 0;

  // Increased absenteeism: the one sub-outcome with no measurable historical
  // correlation available — this app has no daily-granularity weather
  // archive to regress against real attendance, so a true measured
  // elasticity can't be computed. This is a policy-calibrated estimate keyed
  // to the real IMD rainfall band, explicitly marked `estimated: true` so
  // callers never present it as a measured statistic.
  const ABSENTEEISM_UPLIFT_BY_BAND = { 'Light Rain': 0, 'Moderate Rain': 5, 'Heavy Rain': 12, 'Very Heavy Rain': 20 };
  const estimatedAbsenteeismUpliftPct = weather.available ? (ABSENTEEISM_UPLIFT_BY_BAND[weather.conditionLabel] ?? 0) : null;

  // Service disruption risk: real composite of two real signals — active
  // rain trigger AND a flood-critical department already short-staffed.
  const serviceDisruptionRisk = rainTriggerActive && shortStaffed.some((d) => d.department === 'Drainage' || d.department === 'Water Supply');

  const alert = rainTriggerActive && shortStaffed.length > 0;

  return {
    findings: {
      weather: {
        available: weather.available,
        conditionLabel: weather.available ? weather.conditionLabel : null,
        monthToDateRainMm: weather.available ? weather.monthToDateRainMm : null,
        next7DayForecastMm: weather.available ? weather.next7DayForecastMm : null,
        monsoonWindowActive,
        rainTriggerActive,
      },
      shortStaffed, redeploymentPool, smallSampleExcluded,
      rescheduleCandidates, rescheduleCandidateCount,
      estimatedAbsenteeismUpliftPct, estimated: true,
      serviceDisruptionRisk,
    },
    alert,
    // Base confidence is capped well below the other agents' ceiling — there
    // is no >2yr historical monsoon-rainfall baseline yet, only live weather
    // plus this season's sanctioned-vs-filled snapshot — further reduced if
    // most high-load departments had too few sanctioned posts to evaluate,
    // or if live weather data couldn't be fetched at all.
    confidence: clampConfidence(
      (weather.available ? 80 : 50) - sampleSizePenalty(HIGH_LOAD_DEPARTMENTS.length - smallSampleExcluded, HIGH_LOAD_DEPARTMENTS.length, 15),
    ),
  };
}

const HOUR = 60 * 60 * 1000;

// ── Registry — each agent's own recompute cadence (see AI_Agents_Command_Centre.xlsx) ──
export const AGENTS = [
  { key: 'workforce-demand-predictor', compute: computeWorkforceDemandPredictor, intervalMs: 24 * HOUR },
  { key: 'workforce-capacity-predictor', compute: computeWorkforceCapacityPredictor, intervalMs: 24 * HOUR },
  { key: 'attendance-risk-predictor', compute: computeAttendanceRiskPredictor, intervalMs: 24 * HOUR },
  { key: 'budget-overrun-predictor', compute: computeBudgetOverrunPredictor, intervalMs: 24 * HOUR },
  { key: 'skill-gap-predictor', compute: computeSkillGapPredictor, intervalMs: 7 * 24 * HOUR },
  // Recomputed more often than the other agents — real weather changes
  // faster than vacancy/training/budget data does.
  { key: 'weather-staff-planner', compute: computeWeatherStaffPlanner, intervalMs: 6 * HOUR },
];

// Only the single most significant finding is sent to the LLM below —
// previously the full (up to 10-entry) findings list went to the model,
// which was then free to narrate a lower-ranked entry instead of the one
// each finder above already sorts to the front as the most significant.
// (Verified: the demand predictor once narrated "Engineering - South Zone"
// while its own top-ranked projection, sorted by changePct, was actually
// Revenue/Central.)
const TOP_ENTRY_FIELD = {
  'workforce-demand-predictor': 'projections',
  'workforce-capacity-predictor': 'shortfalls',
  'attendance-risk-predictor': 'pairs',
  'budget-overrun-predictor': 'projections',
  'skill-gap-predictor': 'projections',
  'weather-staff-planner': 'shortStaffed',
};
function topFindingOnly(agentKey, findings) {
  const field = TOP_ENTRY_FIELD[agentKey];
  if (!field || !Array.isArray(findings[field])) return findings;
  return { ...findings, [field]: findings[field].slice(0, 1) };
}

async function narrate(agentKey, findings) {
  try {
    const res = await fetch(`${AI_API_URL}/api/v1/agents/narrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentKey, findings: topFindingOnly(agentKey, findings) }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`narrate failed with ${res.status}`);
    return await res.json();
  } catch {
    return null; // caller falls back to a templated narrative
  }
}

// Kept deliberately short (1 sentence, the projected number front and
// center) — the detail view leads with action buttons, not paragraphs, so
// the narrative here only needs to say what's projected, not restate the
// whole findings object in prose.
const FALLBACK_NARRATIVE = {
  'workforce-demand-predictor': (f) => f.projections[0]
    ? `${f.projections[0].department}/${f.projections[0].zone} is projected to need ${f.projections[0].changePct}% more task capacity next month (${f.nextMonth}).`
    : f.closest
      ? `No department/zone crosses the ${f.alertThresholdPct}% demand-increase threshold — the closest is ${f.closest.department}/${f.closest.zone} at +${f.closest.changePct}%.`
      : 'No department/zone shows a reliable upward demand trend for next month.',
  'workforce-capacity-predictor': (f) => f.shortfalls[0]
    ? `${f.shortfalls[0].department} is projected ${f.shortfalls[0].shortfallPct}% short of the capacity needed for its usual workload.`
    : f.closest
      ? `No department crosses the ${f.alertThresholdPct}% capacity-shortfall threshold — the closest is ${f.closest.department} at ${f.closest.shortfallPct}%.`
      : 'No department is currently projected to fall short of capacity.',
  'attendance-risk-predictor': (f) => f.pairs[0]
    ? `${f.pairs[0].department}/${f.pairs[0].zone} attendance is projected to fall to ${f.pairs[0].projectedNextMonthPct}% next month.`
    : f.closest
      ? `No department/zone is projected to cross the ${f.riskThresholdPct}% attendance-risk threshold — the closest is ${f.closest.department}/${f.closest.zone} at a projected ${f.closest.projectedNextMonthPct}%.`
      : 'No department/zone is projected to cross the 85% attendance-risk threshold.',
  'budget-overrun-predictor': (f) => f.projections[0]
    ? `${f.projections[0].department} is projected ${f.projections[0].projectedNextMonthVariancePct}% over budget next month.`
    : f.closest
      ? `No department crosses the ${f.alertThresholdPct}% overrun threshold — the closest is ${f.closest.department} at a projected ${f.closest.projectedNextMonthVariancePct}%.`
      : 'No department shows a reliable upward budget-variance trend.',
  'skill-gap-predictor': (f) => f.projections[0]
    ? `${f.projections[0].department} is projected to lose ${f.projections[0].projectedLossPct}% of its ${f.projections[0].skill} holders within 24 months.`
    : f.closest
      ? `No tracked critical skill crosses the ${f.alertThresholdPct}% holder-loss threshold — the closest is ${f.closest.skill} in ${f.closest.department} at a projected ${f.closest.projectedLossPct}% loss.`
      : 'No tracked critical skill is projected to fall below a viable holder count.',
  'weather-staff-planner': (f) => {
    const w = f.weather;
    if (!w?.available) return 'Live weather data is temporarily unavailable.';
    if (!w.rainTriggerActive) return `${w.conditionLabel} — no active rain trigger, staffing recommendations on hold.`;
    const top = f.shortStaffed?.[0];
    return top
      ? `${w.conditionLabel} forecast: ${top.department} (${top.priorityZone || 'multiple zones'}) is short-staffed and at risk of disruption.`
      : `${w.conditionLabel} forecast, but no high-load department is currently short-staffed.`;
  },
};

// Used only when the LLM narrate() call fails — still names a concrete
// department/number/action rather than a generic placeholder, per the same
// "agent does the talking, not a wall of text" principle.
const FALLBACK_RECOMMENDED_ACTION = {
  'workforce-demand-predictor': (f) => f.projections[0]
    ? `Open a staffing request for ${f.projections[0].department} (${f.projections[0].zone}) ahead of ${f.nextMonth}.`
    : 'No action needed — no department shows a reliable demand increase.',
  'workforce-capacity-predictor': (f) => f.shortfalls[0]
    ? `Arrange temporary redeployment or overtime cover for ${f.shortfalls[0].department} before the shortfall lands.`
    : 'No action needed — no department is projected short of capacity.',
  'attendance-risk-predictor': (f) => f.pairs[0]
    ? `Review attendance drivers in ${f.pairs[0].department}/${f.pairs[0].zone} before next month.`
    : 'No action needed — no department/zone is trending toward attendance risk.',
  'budget-overrun-predictor': (f) => f.projections[0]
    ? `Review discretionary spend in ${f.projections[0].department} before next month's cycle closes.`
    : 'No action needed — no department shows a reliable overrun trend.',
  'skill-gap-predictor': (f) => f.projections[0]
    ? `Nominate backfill candidates for ${f.projections[0].skill} in ${f.projections[0].department} before the projected retirements land.`
    : 'No action needed — no tracked critical skill is at risk.',
  // Gated on rainTriggerActive, not just shortStaffed[0] existing — a
  // department can be short-staffed independent of weather, but this
  // planner's whole premise is "act because of the forecast," so the action
  // must not tell the user to redeploy "ahead of the forecast" when there is
  // no active rain trigger (previously it did, directly contradicting this
  // same agent's own narrative, which correctly said recommendations were
  // "on hold").
  'weather-staff-planner': (f) => (f.weather?.rainTriggerActive && f.shortStaffed?.[0])
    ? `Redeploy staff to ${f.shortStaffed[0].department}'s ${f.shortStaffed[0].priorityZone || 'thinnest zone'} ahead of the forecast.`
    : 'No action needed right now.',
};

// One tick: for every agent whose own interval has elapsed since its last
// run, compute, narrate, and persist a new AgentRun. Agents not yet due are
// skipped — the caller can pass force=true (e.g. a manual "run now") to
// ignore cadence and recompute everything immediately. `onlyKey` restricts
// the tick to a single agent — used by the manual "run now" API route so a
// user refreshing one card doesn't pay for recomputing all six.
export async function runAgentTick({ force = false, onlyKey = null } = {}) {
  const results = [];
  const agentsToRun = onlyKey ? AGENTS.filter((a) => a.key === onlyKey) : AGENTS;
  for (const agent of agentsToRun) {
    if (!force) {
      const last = await prisma.agentRun.findFirst({ where: { agentKey: agent.key }, orderBy: { ranAt: 'desc' }, select: { ranAt: true } });
      if (last && Date.now() - new Date(last.ranAt).getTime() < agent.intervalMs) continue;
    }
    let record;
    try {
      const { findings, alert, confidence, forceIdle } = await agent.compute();
      const status = forceIdle ? 'Idle' : alert ? 'Alert' : 'Running';
      // Only ask the LLM to narrate when the deterministic layer actually
      // found something — a small local model (llama3.2:3b) can drift from
      // its own prompt instructions and invent urgency in prose even when
      // told plainly there's nothing to act on (verified: it narrated a
      // "redeploy staff for waterlogging risk" recommendation for the
      // weather agent while its own rainTriggerActive was false). The
      // no-alert case is exactly where a hallucinated recommendation is most
      // harmful, so it skips the model entirely and uses the fallback text,
      // which is guaranteed to match what was actually computed.
      const llm = alert ? await narrate(agent.key, findings) : null;
      const narrative = llm?.narrative || FALLBACK_NARRATIVE[agent.key]?.(findings) || 'No narrative available.';
      // A "no action needed" recommendation directly contradicts alert=true
      // (there IS something crossing threshold — that's what put this run in
      // the alert branch at all) — server-ai's own grounding check only
      // verifies numbers trace back to real findings, not that the
      // recommendation is logically consistent with the alert it's attached
      // to. Verified live: the model can pass number-grounding while still
      // producing this self-contradiction, so it's caught here instead.
      const llmActionContradictsAlert = alert && llm?.recommendedAction && /no action (is |will be )?(needed|required|necessary)/i.test(llm.recommendedAction);
      const recommendedAction = (!llmActionContradictsAlert && llm?.recommendedAction) || FALLBACK_RECOMMENDED_ACTION[agent.key]?.(findings) || 'Review the findings above for the recommended next step.';
      record = { agentKey: agent.key, status, confidence, findings, narrative, recommendedAction };
    } catch (err) {
      record = {
        agentKey: agent.key, status: 'Idle', confidence: 0,
        findings: { error: String(err?.message || err) },
        narrative: 'This agent failed to compute its findings on the last run.',
        recommendedAction: 'Check server-core logs for this agent.',
      };
    }
    await prisma.agentRun.create({ data: record });
    results.push(record);
  }

  // Retention: keep the last 30 runs per agent.
  for (const agent of AGENTS) {
    const old = await prisma.agentRun.findMany({
      where: { agentKey: agent.key }, orderBy: { ranAt: 'desc' }, skip: 30, select: { id: true },
    });
    if (old.length) await prisma.agentRun.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  }

  return results;
}
