import { faker } from '@faker-js/faker';
import { prisma } from '../db.js';

// The Recruitment pipeline's candidate status and interview ratings were
// generated fully independently of each other and of resumeScore — so a
// candidate could land on "Rejected" with great ratings, or "OfferAccepted"
// with a "Below expectations on core competency questions" review on file.
// This regenerates candidates + their interviews (and the onboarding cases
// sourced from accepted candidates) so status, resumeScore, and interview
// ratings/feedback all agree with each other.
//
// Scoped narrowly: only `candidates`, `candidate_interviews`, and the
// candidate-sourced subset of `onboarding_cases`/`onboarding_tasks` are
// touched. Employees, departments, and every other table are untouched.

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// Same monthly basic-pay bands seed.js uses for actual employee compensation
// (buildCompensation) — reused here to judge whether a candidate's expected
// CTC is realistic for the role's cadre, not just to display the number.
const CADRE_BASIC_PAY_RANGE = {
  "Class I": [65000, 95000],
  "Class II": [45000, 65000],
  "Class III": [30000, 45000],
  "Class IV": [20000, 30000],
};
const DA_PERCENT = 46;
const HRA_PERCENT = 24;
function annualCeilingForCadre(cadre) {
  const [, maxBasic] = CADRE_BASIC_PAY_RANGE[cadre] || CADRE_BASIC_PAY_RANGE["Class III"];
  return Math.round(maxBasic * (1 + DA_PERCENT / 100 + HRA_PERCENT / 100) * 12);
}

// experienceYears and expectedCtc were previously generated flat (0-15 yrs,
// ₹2.5-12L) regardless of the role's seniority — so a Library Attendant
// (Class IV) could roll 14.9 years of experience, or expect a Class I salary.
// Scale both to the role's cadre instead.
const EXPERIENCE_RANGE_BY_CADRE = {
  "Class I": [6, 20],
  "Class II": [3, 15],
  "Class III": [1, 10],
  "Class IV": [0, 6],
};
// Upper bound intentionally runs a bit above each cadre's actual sanctioned
// ceiling (annualCeilingForCadre) — most candidates land within band, but
// enough land above it that the CTC-mismatch rejection/decline logic below
// still has real cases to catch, instead of never triggering.
const EXPECTED_CTC_RANGE_BY_CADRE = {
  "Class I": [900000, 2600000],
  "Class II": [500000, 1800000],
  "Class III": [300000, 1250000],
  "Class IV": [200000, 850000],
};

const CANDIDATE_SOURCES = ["Job Portal", "Referral", "Walk-in", "Campus Drive"];
// Original unbiased pool, kept for resume scores in the mid-range (59-77) —
// only strong/weak resumes get their outcome pool biased below.
const CANDIDATE_STATUS_WEIGHTED = [
  "Applied", "Applied", "Applied", "Screening", "Screening", "InterviewScheduled",
  "InterviewCompleted", "Rejected", "Rejected", "OfferExtended", "OfferAccepted", "OfferDeclined",
];

// A strong resume should make an eventual Rejected outcome less likely and
// an Offer* outcome more likely, and vice versa for a weak one — instead of
// picking the funnel outcome fully independent of resumeScore.
function pickStatus(resumeScore) {
  if (resumeScore <= 58) {
    return faker.helpers.arrayElement([
      "Applied", "Applied", "Screening", "Screening", "InterviewScheduled",
      "InterviewCompleted", "Rejected", "Rejected", "Rejected", "Rejected", "OfferExtended",
    ]);
  }
  if (resumeScore >= 78) {
    return faker.helpers.arrayElement([
      "Applied", "Screening", "InterviewScheduled", "InterviewCompleted", "InterviewCompleted",
      "Rejected", "OfferExtended", "OfferExtended", "OfferAccepted", "OfferAccepted", "OfferAccepted", "OfferDeclined",
    ]);
  }
  return faker.helpers.arrayElement(CANDIDATE_STATUS_WEIGHTED);
}

// Interview ratings are drawn from a range tied to the eventual status,
// instead of a flat 2-5 regardless of outcome — so "Rejected" always reads
// as genuinely weak and an Offer* outcome always reads as genuinely strong.
function ratingRangeForStatus(status) {
  if (status === "Rejected") return [1.8, 3.0];
  if (status === "OfferExtended" || status === "OfferAccepted" || status === "OfferDeclined") return [3.6, 5];
  return [2.6, 4.4]; // still mid-pipeline, no decision made yet
}

function feedbackForRating(rating) {
  if (rating >= 4.2) return "Strong technical fundamentals, recommend progressing.";
  if (rating >= 3.2) return "Good communication, moderate domain depth.";
  return "Below expectations on core competency questions.";
}

// Short narrative explaining the decision, tying resumeScore, actual
// interview performance, and CTC fit together — surfaced in the UI's
// existing (previously always-null) "AI Summary" line on each candidate.
function buildAiSummary(status, resumeScore, roundRatings, ctcOverBudget, expectedCtc, ceiling) {
  const avg = roundRatings.length ? roundRatings.reduce((s, r) => s + r, 0) / roundRatings.length : null;
  const avgTxt = avg != null ? `${avg.toFixed(1)}/5 average across ${roundRatings.length} completed round${roundRatings.length === 1 ? "" : "s"}` : null;
  const ctcTxt = `expected CTC of ₹${expectedCtc.toLocaleString("en-IN")} vs a ~₹${ceiling.toLocaleString("en-IN")} sanctioned band for this role`;

  if (status === "Rejected") {
    if (ctcOverBudget && avg != null && avg < 3.2) return `Rejected: weak interview performance (${avgTxt}) compounded by a CTC mismatch, ${ctcTxt}.`;
    if (ctcOverBudget) return `Rejected: ${ctcTxt}, well above what the role can sanction.`;
    return `Rejected: resume score ${resumeScore}/100 and ${avgTxt} fell short of the bar for this role.`;
  }
  if (status === "OfferDeclined") {
    if (ctcOverBudget) return `Offer extended on strong performance (${avgTxt}), but ${ctcTxt}; candidate declined.`;
    return `Cleared every round strongly (${avgTxt}); offer extended but declined by the candidate for other reasons.`;
  }
  if (status === "OfferAccepted") return `Offer accepted: resume score ${resumeScore}/100 with consistently strong reviews (${avgTxt}), CTC expectations within band.`;
  if (status === "OfferExtended") return `Offer extended: resume score ${resumeScore}/100 with consistently strong reviews (${avgTxt}); awaiting candidate decision.`;
  if (avg != null) return `In progress: ${avgTxt}, resume score ${resumeScore}/100; decision pending further rounds.`;
  return `In progress: resume score ${resumeScore}/100; awaiting first interview round.`;
}

const ROUNDS_BY_STATUS = {
  Screening: ["Screening"],
  InterviewScheduled: ["Screening", "Technical"],
  InterviewCompleted: ["Screening", "Technical", "HR"],
  OfferExtended: ["Screening", "Technical", "HR", "Final"],
  OfferAccepted: ["Screening", "Technical", "HR", "Final"],
  OfferDeclined: ["Screening", "Technical", "HR", "Final"],
  Rejected: ["Screening", "Technical"],
};

function buildCandidatesAndInterviews(vacancyRows, departmentsById, cadreByDesignation) {
  const candidates = [];
  const interviews = [];
  let seq = 1;
  for (const v of vacancyRows) {
    if (!v.criticality) continue;
    const applicantCount = v.criticality === "Critical" ? faker.number.int({ min: 4, max: 8 })
      : v.criticality === "High" ? faker.number.int({ min: 2, max: 5 })
      : faker.number.int({ min: 1, max: 3 });
    for (let i = 0; i < applicantCount; i++) {
      const gender = faker.helpers.arrayElement(["Male", "Male", "Male", "Male", "Male", "Female", "Female", "Female", "Female", "Other"]);
      const first = gender === "Female"
        ? faker.helpers.arrayElement(["Priya","Sunita","Neha","Pooja","Rekha","Meera","Bhavna","Shreya","Pinkal","Mitali","Snehal","Falguni","Bharti","Ekta","Hetal","Kavita","Madhavi","Payal","Ritu","Trupti","Varsha","Zarna","Bela","Deepa","Foram","Heena","Indira","Kajal","Nayana","Parul","Sonal","Urvashi","Aarti","Charmi"])
        : faker.helpers.arrayElement(["Ramesh","Amit","Rajesh","Kiran","Manish","Vikram","Anil","Sandeep","Hardik","Jignesh","Nilesh","Devang","Harshad","Kunal","Arvind","Kalpesh","Bipin","Yogesh","Ashok","Chetan","Dipak","Fenil","Gaurav","Ishwar","Jayesh","Lalit","Nitin","Om","Qasim","Sachin","Umesh","Wahid","Yash","Ajay","Chirag","Eshwar","Girish","Jitendra","Lokesh","Mahesh","Omkar","Rakesh","Tejas","Vishal","Bhavesh","Darshan"]);
      const last = faker.helpers.arrayElement(["Patel","Shah","Mehta","Joshi","Desai","Trivedi","Pandya","Vyas","Rana","Solanki","Bhatt","Gohil","Rathod","Chauhan","Modi","Parmar","Vaghela","Dave","Thakor","Barot","Zala","Makwana","Prajapati","Sharma","Jadeja"]);
      const id = `CAND-${seq}`;
      const department = departmentsById.get(v.department)?.name || v.department;
      const resumeScore = faker.number.int({ min: 45, max: 98 });
      const cadre = cadreByDesignation.get(v.designation) || "Class III";
      const [expMin, expMax] = EXPERIENCE_RANGE_BY_CADRE[cadre];
      const experienceYears = Math.round(faker.number.float({ min: expMin, max: expMax }) * 10) / 10;
      const [ctcMin, ctcMax] = EXPECTED_CTC_RANGE_BY_CADRE[cadre];
      const expectedCtc = faker.number.int({ min: ctcMin, max: ctcMax });
      const ceiling = annualCeilingForCadre(cadre);
      const ctcOverBudget = expectedCtc > ceiling * 1.15;

      let status = pickStatus(resumeScore);
      // A real HR rejection often comes down to budget, not just merit — and
      // a candidate who'd otherwise be accepted but wants more than the role
      // can sanction realistically declines a lower offer instead.
      if (ctcOverBudget && status === "OfferAccepted") status = "OfferDeclined";

      const rounds = ROUNDS_BY_STATUS[status] || [];
      const [min, max] = ratingRangeForStatus(status);
      const roundRatings = [];
      rounds.forEach((round, idx) => {
        const isLast = idx === rounds.length - 1;
        const stillPending = status === "InterviewScheduled" && isLast;
        const rating = stillPending ? null : Math.round(faker.number.float({ min, max }) * 10) / 10;
        if (rating != null) roundRatings.push(rating);
        interviews.push({
          candidateId: id, round,
          scheduledAt: faker.date.recent({ days: 60 }).toISOString().slice(0, 10),
          interviewer: `Panel Member, ${department}`,
          status: stillPending ? "Scheduled" : "Completed",
          feedback: rating == null ? null : feedbackForRating(rating),
          rating,
        });
      });

      candidates.push({
        id, name: `${first} ${last}`,
        email: `${first.toLowerCase()}.${last.toLowerCase()}${seq}@gmail.com`,
        phone: `+91 ${faker.number.int({ min: 6, max: 9 })}${faker.string.numeric(9)}`,
        department, designation: v.designation, vacancyId: v.id,
        source: faker.helpers.arrayElement(CANDIDATE_SOURCES),
        status, appliedDate: faker.date.past({ years: 1 }).toISOString().slice(0, 10),
        resumeScore, experienceYears,
        expectedCtc,
        aiSummary: buildAiSummary(status, resumeScore, roundRatings, ctcOverBudget, expectedCtc, ceiling),
      });

      seq++;
    }
  }
  return { candidates, interviews };
}

const ONBOARDING_TASK_TEMPLATE = [
  { category: "Documentation", title: "Submit ID proof & educational certificates" },
  { category: "Documentation", title: "Complete background verification form" },
  { category: "Orientation", title: "Attend department induction session" },
  { category: "Orientation", title: "Complete code-of-conduct briefing" },
  { category: "IT/Asset Provisioning", title: "Issue laptop/desktop and ID card" },
  { category: "IT/Asset Provisioning", title: "Provision email & system access" },
  { category: "Buddy Assignment", title: "Introduce assigned buddy / mentor" },
  { category: "Compliance", title: "Complete statutory (PF/ESIC) enrollment" },
];

// Mutates each case with a computed `_progressPct` as a side effect (matching
// seed.js's own buildOnboardingTasks) — must run BEFORE the case rows are
// persisted so progressPct isn't left at its placeholder 0.
function buildOnboardingTasks(cases) {
  const rows = [];
  for (const c of cases) {
    let completedCount = 0;
    for (const t of ONBOARDING_TASK_TEMPLATE) {
      const isDone = c.status === "Completed" || (c.status === "InProgress" && faker.datatype.boolean(0.5));
      if (isDone) completedCount++;
      rows.push({
        onboardingCaseId: c.id, category: t.category, title: t.title,
        status: c.status === "NotStarted" ? "Pending" : isDone ? "Completed" : faker.helpers.arrayElement(["Pending", "InProgress"]),
        dueDate: faker.date.soon({ days: 21, refDate: c.startDate }).toISOString().slice(0, 10),
        completedDate: isDone ? faker.date.recent({ days: 20 }).toISOString().slice(0, 10) : null,
        assignedTo: t.category === "Buddy Assignment" ? "Buddy" : "HR Admin",
      });
    }
    c._progressPct = Math.round((completedCount / ONBOARDING_TASK_TEMPLATE.length) * 100);
  }
  return rows;
}

async function main() {
  const [vacancyRows, departments, employees, maxOnbRow] = await Promise.all([
    prisma.vacancy.findMany({ where: { criticality: { not: null } } }),
    prisma.department.findMany(),
    prisma.employee.findMany({ select: { id: true, name: true, department: true } }),
    prisma.onboardingCase.findMany({ select: { id: true } }),
  ]);
  const departmentsById = new Map(departments.map((d) => [d.id, d]));
  const maxOnbSeq = maxOnbRow.reduce((max, r) => {
    const n = Number(String(r.id).replace('ONB-', ''));
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0);

  // A designation -> most common cadre map, derived from real seeded
  // employees, so we can judge whether a candidate's expected CTC is
  // realistic for the role without duplicating seed.js's large static
  // per-department designation/cadre tables.
  const designationCadreCounts = await prisma.employee.groupBy({
    by: ['designation', 'cadre'],
    _count: { _all: true },
  });
  const cadreByDesignation = new Map();
  const bestCount = new Map();
  for (const row of designationCadreCounts) {
    const count = row._count._all;
    if (count > (bestCount.get(row.designation) || 0)) {
      bestCount.set(row.designation, count);
      cadreByDesignation.set(row.designation, row.cadre);
    }
  }

  const { candidates, interviews } = buildCandidatesAndInterviews(vacancyRows, departmentsById, cadreByDesignation);
  console.log(`Regenerating ${candidates.length} candidates, ${interviews.length} interview rounds.`);

  await prisma.$transaction(async (tx) => {
    // Delete only the candidate-sourced onboarding data + its children, in
    // FK-safe order — employee-sourced onboarding cases are left alone.
    const candidateOnbCases = await tx.onboardingCase.findMany({ where: { candidateId: { not: null } }, select: { id: true } });
    const candidateOnbIds = candidateOnbCases.map((c) => c.id);
    if (candidateOnbIds.length) {
      await tx.onboardingTask.deleteMany({ where: { onboardingCaseId: { in: candidateOnbIds } } });
      await tx.onboardingCase.deleteMany({ where: { id: { in: candidateOnbIds } } });
    }
    await tx.candidateInterview.deleteMany({});
    await tx.candidate.deleteMany({});

    await tx.candidate.createMany({ data: candidates });
    await tx.candidateInterview.createMany({ data: interviews });

    // Rebuild onboarding cases for the newly-accepted candidates, mirroring
    // seed.js's buildOnboardingCases candidate-sourced branch exactly, but
    // continuing the id sequence past whatever employee-sourced cases exist.
    let seq = maxOnbSeq + 1;
    const newCases = [];
    for (const c of candidates.filter((x) => x.status === "OfferAccepted")) {
      const deptEmployees = employees.filter((e) => e.department === c.department);
      const buddy = deptEmployees.length ? faker.helpers.arrayElement(deptEmployees) : null;
      newCases.push({
        id: `ONB-${seq++}`, candidateId: c.id, employeeId: null,
        name: c.name, department: c.department, designation: c.designation,
        startDate: faker.date.soon({ days: 30 }).toISOString().slice(0, 10),
        buddyEmployeeId: buddy?.id || null,
        status: faker.helpers.arrayElement(["NotStarted", "InProgress", "InProgress", "Completed"]),
        progressPct: 0,
      });
    }
    if (newCases.length) {
      const taskRows = buildOnboardingTasks(newCases); // sets _progressPct on each case
      await tx.onboardingCase.createMany({
        data: newCases.map(({ _progressPct, ...c }) => ({ ...c, progressPct: _progressPct })),
      });
      await tx.onboardingTask.createMany({ data: taskRows });
    }
    console.log(`Rebuilt ${newCases.length} candidate-sourced onboarding cases.`);
  }, { timeout: 120_000, maxWait: 15_000 });

  console.log('Done.');
}

main()
  .catch((e) => {
    console.error('Fix failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
