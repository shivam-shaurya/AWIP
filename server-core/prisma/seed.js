import bcrypt from 'bcryptjs';
import { faker } from '@faker-js/faker';
import { prisma } from '../db.js';

const SEED = 20260703;
faker.seed(SEED);

const TOTAL_EMPLOYEES = 10000;
const NOW_YEAR = new Date().getFullYear();

// Department code -> { name, weight }. Weights for the 7 largest departments
// mirror the real headcounts implied by the original workforce_snapshot seed
// (Health 8256, Engineering 6742, Solid Waste 5189, Revenue 4652, Water 3822,
// Planning 3214, Fire 2987 — summing to the historical 34,862 total). The
// remaining departments are given smaller, plausible weights so the full
// 24-department list sums cleanly and scales down to TOTAL_EMPLOYEES.
const DEPARTMENTS = [
  { id: 'COMM', name: 'Commissioner Office', weight: 150 },
  { id: 'ADMIN', name: 'Administration', weight: 320 },
  { id: 'HEALTH', name: 'Health', weight: 8256 },
  { id: 'ENGG', name: 'Engineering', weight: 6742 },
  { id: 'WATER', name: 'Water Supply', weight: 3822 },
  { id: 'DRAIN', name: 'Drainage', weight: 1200 },
  { id: 'SWM', name: 'Solid Waste Management', weight: 5189 },
  { id: 'FIRE', name: 'Fire & Emergency Services', weight: 2987 },
  { id: 'PLAN', name: 'Town Planning', weight: 3214 },
  { id: 'ESTATE', name: 'Estate', weight: 420 },
  { id: 'REV', name: 'Revenue', weight: 4652 },
  { id: 'UCD', name: 'Urban Community Development', weight: 520 },
  { id: 'HOUSING', name: 'Housing', weight: 360 },
  { id: 'GARDEN', name: 'Garden', weight: 900 },
  { id: 'IT', name: 'Information Technology', weight: 260 },
  { id: 'FIN', name: 'Accounts & Finance', weight: 600 },
  { id: 'LEGAL', name: 'Legal', weight: 210 },
  { id: 'EDU', name: 'Education', weight: 2500 },
  { id: 'ZOO', name: 'Zoo', weight: 300 },
  { id: 'LIB', name: 'Library', weight: 260 },
  { id: 'SPORTS', name: 'Sports', weight: 310 },
  { id: 'DM', name: 'Disaster Management', weight: 360 },
  { id: 'PROC', name: 'Procurement', weight: 210 },
  { id: 'GRIEV', name: 'Public Grievance', weight: 260 },
];

// Groups the 24 departments into functional categories so designation
// pools, project/vacancy narrative, audit-status weighting, and budget
// composition can all vary by what a department actually does, instead of
// one generic civic-office template applying everywhere.
const DEPT_CATEGORY = {
  HEALTH: "Health",
  ENGG: "Engineering", WATER: "Engineering", DRAIN: "Engineering", PLAN: "Engineering", ESTATE: "Engineering", HOUSING: "Engineering",
  SWM: "Sanitation", GARDEN: "Sanitation",
  FIRE: "Safety", DM: "Safety",
  COMM: "CivicAdmin", ADMIN: "CivicAdmin", REV: "CivicAdmin", UCD: "CivicAdmin", IT: "CivicAdmin", FIN: "CivicAdmin", PROC: "CivicAdmin", GRIEV: "CivicAdmin",
  LEGAL: "Legal",
  EDU: "Education",
  ZOO: "Culture", LIB: "Culture", SPORTS: "Culture",
};

const MALE_FIRST = [
  "Ramesh","Amit","Rajesh","Kiran","Manish","Vikram","Anil","Sandeep","Hardik","Jignesh",
  "Nilesh","Devang","Harshad","Kunal","Arvind","Kalpesh","Bipin","Yogesh","Ashok","Chetan",
  "Dipak","Fenil","Gaurav","Ishwar","Jayesh","Lalit","Nitin","Om","Qasim","Sachin",
  "Umesh","Wahid","Yash","Ajay","Chirag","Eshwar","Girish","Jitendra","Lokesh","Mahesh",
  "Omkar","Rakesh","Tejas","Vishal","Bhavesh","Darshan",
];
const FEMALE_FIRST = [
  "Priya","Sunita","Neha","Pooja","Rekha","Meera","Bhavna","Shreya","Pinkal","Mitali",
  "Snehal","Falguni","Bharti","Ekta","Hetal","Kavita","Madhavi","Payal","Ritu","Trupti",
  "Varsha","Zarna","Bela","Deepa","Foram","Heena","Indira","Kajal","Nayana","Parul",
  "Sonal","Urvashi","Aarti","Charmi",
];
const FIRST = [...MALE_FIRST, ...FEMALE_FIRST];
const LAST = [
  "Patel","Shah","Mehta","Joshi","Desai","Trivedi","Pandya","Vyas","Rana","Solanki",
  "Bhatt","Gohil","Rathod","Chauhan","Modi","Parmar","Vaghela","Dave","Thakor","Barot",
  "Zala","Makwana","Prajapati","Sharma","Jadeja",
];

const GENDER_WEIGHTED = ["Male", "Male", "Male", "Male", "Male", "Female", "Female", "Female", "Female", "Other"];
const BLOOD_GROUPS_WEIGHTED = ["O+", "O+", "O+", "B+", "B+", "B+", "A+", "A+", "AB+", "O-", "B-", "A-", "AB-"];
const RELATIONS_MARRIED = ["Spouse", "Spouse", "Spouse", "Father", "Mother"];
const RELATIONS_SINGLE = ["Father", "Mother", "Sibling", "Guardian"];

const CADRES = ["Class I", "Class II", "Class III", "Class IV"];
const CADRE_WEIGHTS = { "Class I": 0.04, "Class II": 0.16, "Class III": 0.30, "Class IV": 0.50 };
// Minimum years of service required before an employee can hold a given
// cadre — mirrors real seniority-based promotion norms so a newly-joined
// employee can't randomly land as a senior Class I officer.
const CADRE_MIN_TENURE = { "Class I": 15, "Class II": 8, "Class III": 3, "Class IV": 0 };
// Fallback designation pool for any department without an explicit block
// below — keeps the original generic titles as a safety net so no
// department can ever produce an empty designation array.
const GENERIC_CADRE_DESIGNATIONS = {
  "Class I": ["Deputy Commissioner", "Assistant Commissioner", "Executive Engineer", "Medical Officer", "Town Planner"],
  "Class II": ["Asst. Engineer", "Accounts Officer", "Establishment Officer", "Sanitary Inspector", "Tax Officer", "Legal Officer", "System Analyst"],
  "Class III": ["Senior Clerk", "Junior Clerk", "Sub-Inspector", "Fire Officer", "Programmer", "Office Superintendent"],
  "Class IV": ["Driver", "Helper"],
};

// Per-department designation pools — each of the 24 departments gets its
// own Class I-IV title ladder reflecting what that department actually
// does, instead of a generic title reused corporation-wide regardless of
// function (e.g. a Health employee should never carry an "Executive
// Engineer" title).
const DEPT_CADRE_DESIGNATIONS = {
  COMM: {
    "Class I": ["Deputy Municipal Commissioner", "Assistant Municipal Commissioner", "OSD to Commissioner"],
    "Class II": ["Administrative Officer", "Establishment Officer", "PA to Commissioner"],
    "Class III": ["Senior Clerk", "Office Superintendent", "Steno-Typist"],
    "Class IV": ["Peon", "Driver"],
  },
  ADMIN: {
    "Class I": ["Deputy Commissioner (Admin)", "Assistant Commissioner (Admin)"],
    "Class II": ["Establishment Officer", "Administrative Officer", "HR Officer"],
    "Class III": ["Senior Clerk", "Junior Clerk", "Office Superintendent"],
    "Class IV": ["Peon", "Helper"],
  },
  HEALTH: {
    "Class I": ["Medical Officer of Health", "Assistant Medical Officer", "Chief Medical Officer", "Deputy Medical Officer of Health"],
    "Class II": ["Medical Officer", "Sanitary Inspector", "Pharmacist Officer", "Public Health Nurse Supervisor"],
    "Class III": ["Staff Nurse", "Lab Technician", "Health Worker Supervisor", "Pharmacist"],
    "Class IV": ["Ward Attendant", "Ambulance Driver", "Sanitation Worker"],
  },
  ENGG: {
    "Class I": ["Executive Engineer", "Deputy City Engineer", "Superintending Engineer"],
    "Class II": ["Assistant Engineer", "Junior Engineer (Civil)", "Structural Engineer"],
    "Class III": ["Site Supervisor", "Draftsman", "Survey Assistant"],
    "Class IV": ["Mason Helper", "Site Helper"],
  },
  WATER: {
    "Class I": ["Chief Engineer (Water Supply)", "Executive Engineer (Water)", "Deputy Engineer (Water)"],
    "Class II": ["Assistant Engineer (Water)", "Junior Engineer (PHE)", "Water Quality Officer"],
    "Class III": ["Pump Operator Supervisor", "Meter Reader Supervisor", "Valve Technician"],
    "Class IV": ["Pump Operator", "Pipeline Helper"],
  },
  DRAIN: {
    "Class I": ["Chief Engineer (Drainage)", "Executive Engineer (Drainage)"],
    "Class II": ["Assistant Engineer (Drainage)", "Junior Engineer (Storm Water)"],
    "Class III": ["Drainage Supervisor", "Survey Assistant"],
    "Class IV": ["Drain Cleaning Worker", "Site Helper"],
  },
  SWM: {
    "Class I": ["Deputy Municipal Commissioner (SWM)", "Chief Sanitary Officer"],
    "Class II": ["Sanitary Inspector", "Route Supervisor", "SWM Officer"],
    "Class III": ["Sanitary Sub-Inspector", "Fleet Supervisor"],
    "Class IV": ["Sanitation Worker", "Waste Collection Driver"],
  },
  FIRE: {
    "Class I": ["Chief Fire Officer", "Deputy Chief Fire Officer"],
    "Class II": ["Divisional Fire Officer", "Station Fire Officer"],
    "Class III": ["Fire Sub-Officer", "Leading Fireman"],
    "Class IV": ["Fireman", "Fire Driver"],
  },
  PLAN: {
    "Class I": ["Chief Town Planner", "Deputy Town Planner"],
    "Class II": ["Assistant Town Planner", "Town Planning Officer"],
    "Class III": ["Draftsman (Planning)", "Survey Assistant"],
    "Class IV": ["Site Helper", "Peon"],
  },
  ESTATE: {
    "Class I": ["Estate Officer", "Deputy Estate Officer"],
    "Class II": ["Assistant Estate Officer", "Valuation Officer"],
    "Class III": ["Estate Inspector", "Senior Clerk"],
    "Class IV": ["Peon", "Watchman"],
  },
  REV: {
    "Class I": ["Deputy Municipal Commissioner (Revenue)", "Assistant Commissioner (Revenue)"],
    "Class II": ["Tax Officer", "Assessment Officer", "Revenue Officer"],
    "Class III": ["Tax Inspector", "Bill Collector Supervisor"],
    "Class IV": ["Bill Collector", "Peon"],
  },
  UCD: {
    "Class I": ["Community Development Officer", "Deputy Community Development Officer"],
    "Class II": ["Assistant Community Development Officer", "Project Officer (UCD)"],
    "Class III": ["Community Organizer", "Field Supervisor"],
    "Class IV": ["Field Assistant"],
  },
  HOUSING: {
    "Class I": ["Housing Officer", "Deputy Housing Officer"],
    "Class II": ["Assistant Housing Officer", "Allotment Officer"],
    "Class III": ["Housing Inspector", "Senior Clerk"],
    "Class IV": ["Peon", "Watchman"],
  },
  GARDEN: {
    "Class I": ["Superintendent (Gardens)", "Deputy Superintendent (Gardens)"],
    "Class II": ["Horticulture Officer", "Garden Supervisor"],
    "Class III": ["Nursery Supervisor", "Gardener Head"],
    "Class IV": ["Gardener", "Mali"],
  },
  IT: {
    "Class I": ["Chief Information Officer", "Deputy Chief Information Officer"],
    "Class II": ["System Analyst", "IT Officer", "Network Administrator"],
    "Class III": ["Programmer", "Hardware Technician"],
    "Class IV": ["Data Entry Operator"],
  },
  FIN: {
    "Class I": ["Chief Accounts Officer", "Deputy Chief Accounts Officer"],
    "Class II": ["Accounts Officer", "Internal Audit Officer", "Budget Officer"],
    "Class III": ["Senior Accountant", "Junior Accountant"],
    "Class IV": ["Cashier Assistant", "Peon"],
  },
  LEGAL: {
    "Class I": ["City Solicitor", "Deputy City Solicitor"],
    "Class II": ["Legal Officer", "Assistant Legal Officer"],
    "Class III": ["Legal Assistant", "Process Server"],
    "Class IV": ["Peon", "Record Keeper"],
  },
  EDU: {
    "Class I": ["Administrative Officer (Education)", "Deputy Administrative Officer (Education)"],
    "Class II": ["Education Extension Officer", "School Inspector"],
    "Class III": ["Head Teacher", "Assistant Teacher"],
    "Class IV": ["Peon", "Attendant"],
  },
  ZOO: {
    "Class I": ["Zoo Superintendent", "Deputy Zoo Superintendent"],
    "Class II": ["Veterinary Officer", "Curator"],
    "Class III": ["Zookeeper Supervisor", "Animal Attendant Supervisor"],
    "Class IV": ["Zookeeper", "Animal Attendant"],
  },
  LIB: {
    "Class I": ["City Librarian", "Deputy City Librarian"],
    "Class II": ["Assistant Librarian", "Library Officer"],
    "Class III": ["Library Assistant", "Cataloguer"],
    "Class IV": ["Library Attendant"],
  },
  SPORTS: {
    "Class I": ["Sports Officer", "Deputy Sports Officer"],
    "Class II": ["Assistant Sports Officer", "Coach Supervisor"],
    "Class III": ["Coach", "Ground Supervisor"],
    "Class IV": ["Ground Staff"],
  },
  DM: {
    "Class I": ["Disaster Management Officer", "Deputy Disaster Management Officer"],
    "Class II": ["Assistant Disaster Management Officer", "Emergency Response Officer"],
    "Class III": ["Response Team Supervisor", "Warehouse Supervisor"],
    "Class IV": ["Response Team Member", "Driver"],
  },
  PROC: {
    "Class I": ["Chief Procurement Officer", "Deputy Chief Procurement Officer"],
    "Class II": ["Procurement Officer", "Contracts Officer"],
    "Class III": ["Purchase Assistant", "Store Supervisor"],
    "Class IV": ["Store Helper", "Peon"],
  },
  GRIEV: {
    "Class I": ["Public Grievance Officer", "Deputy Public Grievance Officer"],
    "Class II": ["Grievance Redressal Officer", "Assistant Grievance Officer"],
    "Class III": ["Grievance Assistant", "Case Coordinator"],
    "Class IV": ["Peon", "Receptionist"],
  },
};
const CADRE_BASIC_PAY_RANGE = {
  "Class I": [65000, 95000],
  "Class II": [45000, 65000],
  "Class III": [30000, 45000],
  "Class IV": [20000, 30000],
};
// Categorized disciplinary notes, picked based on what's actually driving
// an employee's "trouble score" (see buildPerformanceAndFlags) so the note
// matches the story the rest of the record tells — an attendance-driven
// case reads as absenteeism, not a random unrelated procurement note.
const DISCIPLINARY_NOTES_BY_CATEGORY = {
  Absenteeism: [
    "Unauthorized absence — show-cause notice issued, reply under review",
    "Repeated late arrival pattern flagged by attendance audit — warning issued",
    "Extended unapproved leave — service record entry pending HR review",
  ],
  Performance: [
    "Sustained below-benchmark performance — formal improvement plan initiated",
    "Failure to meet SLA targets across two consecutive cycles — counselling recorded",
    "Repeated task escalations attributed to non-performance — review scheduled",
  ],
  Conduct: [
    "Complaint of misconduct with public — inquiry committee constituted",
    "Insubordination reported by reporting officer — explanation sought",
    "Breach of office conduct rules — departmental inquiry ongoing",
  ],
  Compliance: [
    "Minor procurement irregularity — departmental inquiry ongoing",
    "Delay in file disposal flagged by vigilance audit — explanation sought",
    "Non-compliance with documentation protocol — corrective notice issued",
  ],
};
const POSTINGS = ["Central Zone", "North Zone", "South Zone", "East Zone", "West Zone", "South-West Zone", "North-West Zone", "HQ Danapith"];
const STATUS_WEIGHTED = ["Active", "Active", "Active", "Active", "Active", "Active", "Active", "Active", "Active", "OnLeave", "Deputation", "Suspended"];
const DA_PERCENT = 46;
const HRA_PERCENT = 24;

const TRAINING_TITLES = [
  { title: "Municipal Governance Fundamentals", category: "Governance" },
  { title: "GIS for Urban Planning", category: "Technical" },
  { title: "Public Grievance Redressal", category: "Soft Skills" },
  { title: "Financial Compliance & Audit", category: "Finance" },
  { title: "Occupational Health & Safety", category: "Safety" },
  { title: "Disaster Response Drill", category: "Safety" },
  { title: "E-Governance Tools", category: "Technical" },
  { title: "RTI & Transparency Norms", category: "Governance" },
  { title: "Leadership for Supervisors", category: "Leadership" },
  { title: "Sanitation & Solid Waste Protocols", category: "Technical" },
];
const SKILL_POOL = [
  "GIS Mapping", "AutoCAD", "Public Speaking", "Financial Auditing", "Project Management",
  "MS Excel", "Tally ERP", "Site Inspection", "Legal Drafting", "Water Treatment Ops",
  "Fire Safety Protocols", "Grievance Handling", "Data Entry", "SQL", "Team Supervision",
];

// AMC's 7 administrative zones — each employee is assigned one so the
// dashboard can offer a real zone-wise view alongside the department view.
const ZONES = [
  { name: "Central", weight: 22 },
  { name: "North", weight: 16 },
  { name: "South", weight: 15 },
  { name: "East", weight: 13 },
  { name: "West", weight: 14 },
  { name: "North-West", weight: 11 },
  { name: "South-West", weight: 9 },
];

// Each zone maps to one administrative division — mirrors how AMC's real org
// chart nests wards/zones under a division tier above them.
const ZONE_DIVISIONS = {
  "Central": { code: "DIV-CEN", name: "Central Zone Division" },
  "North": { code: "DIV-NOR", name: "North Zone Division" },
  "South": { code: "DIV-SOU", name: "South Zone Division" },
  "East": { code: "DIV-EAS", name: "East Zone Division" },
  "West": { code: "DIV-WES", name: "West Zone Division" },
  "North-West": { code: "DIV-NWS", name: "North-West Zone Division" },
  "South-West": { code: "DIV-SWS", name: "South-West Zone Division" },
};

// Cadre -> grade band. Distinct from `cadre` (Class I-IV, the legal service
// class) — this is the internal pay-grade tier within that class.
const CADRE_GRADES = {
  "Class I": ["Grade A-1", "Grade A-2"],
  "Class II": ["Grade B-1", "Grade B-2"],
  "Class III": ["Grade C-1", "Grade C-2"],
  "Class IV": ["Grade D-1", "Grade D-2"],
};

// Functional tag shown as "Job Profile" — a broader work-category label
// distinct from the specific `designation` title.
const JOB_PROFILE_TAGS = [
  "Field Operations", "Administrative Support", "Technical Execution",
  "Policy & Compliance", "Public Interface", "Back-Office Processing",
  "Frontline Service Delivery", "Planning & Coordination",
];

const ACTING_ROLE_CHANCE = 0.04;

// Real ward names/areas from AMC's own civic audit data (Ahmedabad Municipal
// Corporation ward-vs-sanitation-worker density report) — used to give the
// Spatial Workforce Allocation feature genuine geographic figures instead of
// invented ones. Only a representative subset of the city's 48 wards (the
// ones the source audit specifically called out), not the full ward list.
const WARD_AREAS = [
  { name: "Khadia", zone: "Central", areaSqKm: 3.26 },
  { name: "Saraspur-Rakhial", zone: "North", areaSqKm: 3.39 },
  { name: "Thakkarbapanagar", zone: "North", areaSqKm: 3.48 },
  { name: "Navrangpura", zone: "West", areaSqKm: 11.98 },
  { name: "Chandkheda", zone: "West", areaSqKm: 11.90 },
  { name: "Bodakdev", zone: "North-West", areaSqKm: 13.78 },
  { name: "Thaltej", zone: "North-West", areaSqKm: 32.18 },
  { name: "Gota", zone: "North-West", areaSqKm: 30.00 },
  { name: "Bhaipura-Hatkeshwar", zone: "East", areaSqKm: 1.94 },
  { name: "Vastral", zone: "East", areaSqKm: 13.46 },
  { name: "Maktampura", zone: "South-West", areaSqKm: 26.20 },
  { name: "Lambha", zone: "South", areaSqKm: 44.54 },
];
const WARDS_BY_ZONE = new Map();
for (const w of WARD_AREAS) {
  if (!WARDS_BY_ZONE.has(w.zone)) WARDS_BY_ZONE.set(w.zone, []);
  WARDS_BY_ZONE.get(w.zone).push(w);
}
// Sanitation-adjacent departments are the ones the real audit's density
// disparity is actually about — they get inverse-area weighting (small wards
// draw disproportionately more staff, mirroring the real Khadia-vs-Lambha
// pattern). Every other department gets area-proportional weighting (roughly
// uniform density), so the visible imbalance is scoped to where it's real.
const WARD_DENSITY_DEPARTMENTS = new Set(["Solid Waste Management", "Drainage"]);
function pickWard(zone, department) {
  const wards = WARDS_BY_ZONE.get(zone);
  if (!wards || !wards.length) return null;
  const skewed = WARD_DENSITY_DEPARTMENTS.has(department);
  return weightedPick(wards, (w) => (skewed ? 1 / w.areaSqKm : w.areaSqKm)).name;
}

function weightedPick(items, weightFn, rng = faker.number.float) {
  const total = items.reduce((s, it) => s + weightFn(it), 0);
  let r = rng({ min: 0, max: total });
  for (const it of items) {
    r -= weightFn(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

function buildDepartmentAssignment() {
  const totalWeight = DEPARTMENTS.reduce((s, d) => s + d.weight, 0);
  const counts = DEPARTMENTS.map((d) => Math.floor((d.weight / totalWeight) * TOTAL_EMPLOYEES));
  let assigned = counts.reduce((a, b) => a + b, 0);
  let i = 0;
  while (assigned < TOTAL_EMPLOYEES) {
    counts[i % counts.length] += 1;
    assigned += 1;
    i += 1;
  }
  const assignment = [];
  DEPARTMENTS.forEach((d, idx) => {
    for (let n = 0; n < counts[idx]; n++) assignment.push(d);
  });
  return assignment;
}

// Cadre is gated by years of service (tenure) so a newly-joined employee
// can't randomly land as a senior Class I officer — mirrors real
// seniority-based promotion norms.
function pickCadre(tenure) {
  const eligible = CADRES.filter((c) => tenure >= CADRE_MIN_TENURE[c]);
  const totalWeight = eligible.reduce((s, c) => s + CADRE_WEIGHTS[c], 0);
  let r = faker.number.float({ min: 0, max: totalWeight });
  for (const c of eligible) {
    r -= CADRE_WEIGHTS[c];
    if (r <= 0) return c;
  }
  return eligible[eligible.length - 1];
}

const RETIREMENT_AGE = 60;
const MIN_JOINING_AGE = 21;
const MAX_JOINING_AGE = 35;

function buildEmployees() {
  const deptAssignment = buildDepartmentAssignment();
  // Group indices by department, then by cadre within department, so that
  // managers (higher cadre) are always created before their direct reports —
  // this keeps the seed's manager-hierarchy pass simple and FK-safe.
  const byDept = new Map();
  deptAssignment.forEach((dept) => {
    // Joining age first, then tenure capped so nobody's implied retirement
    // (joiningAge + tenure -> age today) exceeds the real retirement age —
    // otherwise the record would represent someone who should've already
    // retired years ago while still marked "Active".
    const joiningAge = faker.number.int({ min: MIN_JOINING_AGE, max: MAX_JOINING_AGE });
    const maxTenure = Math.min(35, RETIREMENT_AGE - joiningAge);
    const tenure = faker.number.int({ min: 0, max: maxTenure });
    const cadre = pickCadre(tenure);
    if (!byDept.has(dept.id)) byDept.set(dept.id, { dept, byCadre: { "Class I": [], "Class II": [], "Class III": [], "Class IV": [] } });
    byDept.get(dept.id).byCadre[cadre].push({ tenure, joiningAge });
  });

  const employees = [];
  const managerAssignments = []; // { id, managerId }
  const deptHeadId = {}; // dept.id -> id of that department's Class I head
  let seq = 10001;

  for (const { dept, byCadre } of byDept.values()) {
    const cadreLevels = ["Class I", "Class II", "Class III", "Class IV"];
    const idsByCadre = { "Class I": [], "Class II": [], "Class III": [], "Class IV": [] };

    cadreLevels.forEach((cadre) => {
      byCadre[cadre].forEach(({ tenure, joiningAge }) => {
        const id = `AMC-${seq++}`;
        const gender = faker.helpers.arrayElement(GENDER_WEIGHTED);
        const first = gender === "Female" ? faker.helpers.arrayElement(FEMALE_FIRST) : faker.helpers.arrayElement(MALE_FIRST);
        const last = faker.helpers.arrayElement(LAST);
        const designation = faker.helpers.arrayElement((DEPT_CADRE_DESIGNATIONS[dept.id] || GENERIC_CADRE_DESIGNATIONS)[cadre]);
        const dojYear = NOW_YEAR - tenure;
        const retYear = dojYear + (RETIREMENT_AGE - joiningAge);
        const retiresIn = retYear - NOW_YEAR;
        const status = faker.helpers.arrayElement(STATUS_WEIGHTED);
        const month = faker.number.int({ min: 1, max: 12 });
        const day = faker.number.int({ min: 1, max: 27 });
        const pad = (n) => String(n).padStart(2, "0");

        // Personal/bio details — derived from the same joining-age/tenure
        // math already used for doj/retirement so ages stay internally
        // consistent (e.g. DOB always predates date of joining by joiningAge years).
        const dobYear = dojYear - joiningAge;
        const dobMonth = faker.number.int({ min: 1, max: 12 });
        const dobDay = faker.number.int({ min: 1, max: 27 });
        const currentAge = NOW_YEAR - dobYear;
        const maritalStatus = currentAge < 24 ? faker.helpers.arrayElement(["Single", "Single", "Married"]) : faker.helpers.arrayElement(["Married", "Married", "Married", "Single", "Widowed"]);
        const emergencyRelationPool = maritalStatus === "Married" ? RELATIONS_MARRIED : RELATIONS_SINGLE;
        const emergencyFirst = faker.helpers.arrayElement(FIRST);
        const emergencyLast = faker.helpers.arrayElement(LAST);
        const phoneDigits = `${faker.number.int({ min: 6, max: 9 })}${faker.string.numeric(9)}`;
        const emergencyPhoneDigits = `${faker.number.int({ min: 6, max: 9 })}${faker.string.numeric(9)}`;
        const zone = weightedPick(ZONES, (z) => z.weight).name;
        const ward = pickWard(zone, dept.name);
        const division = ZONE_DIVISIONS[zone];
        const grade = faker.helpers.arrayElement(CADRE_GRADES[cadre]);
        const jobProfile = faker.helpers.arrayElement(JOB_PROFILE_TAGS);
        let actingRole = null;
        if (faker.datatype.boolean(ACTING_ROLE_CHANCE)) {
          const cadreIdx = cadreLevels.indexOf(cadre);
          const higherCadre = cadreIdx > 0 ? cadreLevels[cadreIdx - 1] : null;
          const higherPool = higherCadre ? (DEPT_CADRE_DESIGNATIONS[dept.id] || GENERIC_CADRE_DESIGNATIONS)[higherCadre] : null;
          if (higherPool && higherPool.length) actingRole = `Acting ${faker.helpers.arrayElement(higherPool)}`;
        }

        employees.push({
          id,
          name: `${first} ${last}`,
          designation,
          department: dept.name,
          departmentId: dept.id,
          cadre,
          doj: `${dojYear}-${pad(month)}-${pad(day)}`,
          retirement: `${retYear}-${pad(month)}-${pad(day)}`,
          status,
          posting: faker.helpers.arrayElement(POSTINGS),
          zone,
          ward,
          grade,
          jobProfile,
          actingRole,
          divisionCode: division.code,
          divisionName: division.name,
          photo: null,
          dob: `${dobYear}-${pad(dobMonth)}-${pad(dobDay)}`,
          gender,
          maritalStatus,
          bloodGroup: faker.helpers.arrayElement(BLOOD_GROUPS_WEIGHTED),
          phone: `+91 ${phoneDigits}`,
          personalEmail: `${first.toLowerCase()}.${last.toLowerCase()}${id.replace("AMC-", "")}@gmail.com`,
          address: `${faker.number.int({ min: 1, max: 999 })}, ${faker.helpers.arrayElement(POSTINGS)}, Ahmedabad, Gujarat - ${faker.number.int({ min: 380001, max: 382481 })}`,
          emergencyContactName: `${emergencyFirst} ${emergencyLast}`,
          emergencyContactRelation: faker.helpers.arrayElement(emergencyRelationPool),
          emergencyContactPhone: `+91 ${emergencyPhoneDigits}`,
          retirementDue: retiresIn <= 2,
          // promotionDue/appraisalPending/trainingPending/missingDocs/
          // disciplinaryFlag/disciplinaryNote are deliberately NOT set here —
          // they're derived afterward in buildPerformanceAndFlags() from a
          // composite performance+attendance "trouble score," so an
          // employee's flags tell one coherent story instead of five
          // independent coin-flips.
        });
        idsByCadre[cadre].push(id);
      });
    });

    // Chain managers within the department: II -> I, III -> II, IV -> III.
    // If a higher cadre is empty, fall back to the nearest non-empty cadre
    // above it — small departments may have zero Class I employees, so the
    // "top" cadre for a department isn't always Class I.
    const higherPool = (level) => {
      for (let l = level; l >= 0; l--) {
        if (idsByCadre[cadreLevels[l]].length) return idsByCadre[cadreLevels[l]];
      }
      return null;
    };
    const topLevelIdx = cadreLevels.findIndex((c) => idsByCadre[c].length > 0);
    if (topLevelIdx === -1) continue; // empty department, shouldn't happen given weights > 0

    for (let level = topLevelIdx + 1; level < cadreLevels.length; level++) {
      const pool = higherPool(level - 1);
      if (!pool) continue;
      idsByCadre[cadreLevels[level]].forEach((id) => {
        managerAssignments.push({ id, managerId: faker.helpers.arrayElement(pool) });
      });
    }

    // Designate exactly one employee from the department's top cadre as its
    // head (no manager); the rest of that cadre reports to the head so each
    // department renders as one connected org tree instead of several
    // disjoint roots.
    const topPool = idsByCadre[cadreLevels[topLevelIdx]];
    const [head, ...rest] = topPool;
    deptHeadId[dept.id] = head;
    rest.forEach((id) => managerAssignments.push({ id, managerId: head }));
  }

  // Tie every department head under the Commissioner Office head, so the
  // whole corporation renders as one connected org tree rather than 24
  // disconnected department trees.
  const commissionerHead = deptHeadId['COMM'];
  if (commissionerHead) {
    Object.entries(deptHeadId).forEach(([deptId, headId]) => {
      if (deptId !== 'COMM') managerAssignments.push({ id: headId, managerId: commissionerHead });
    });
  }

  return { employees, managerAssignments, deptHeadId };
}

const CADRE_RANK = { "Class I": 0, "Class II": 1, "Class III": 2, "Class IV": 3 };
const FLAGSHIP_PER_DEPT = 20;

// Marks the ~20 most senior employees per department as "Flagship" so
// buildCareerHistory/buildEmployeeEvents/buildSkills can generate
// materially deeper history for them without changing TOTAL_EMPLOYEES.
function markFlagshipEmployees(employees) {
  const byDept = new Map();
  for (const e of employees) {
    const key = e.departmentId || e.department;
    if (!byDept.has(key)) byDept.set(key, []);
    byDept.get(key).push(e);
  }
  for (const deptEmployees of byDept.values()) {
    const ranked = deptEmployees.slice().sort((a, b) => {
      const cadreDiff = (CADRE_RANK[a.cadre] ?? 9) - (CADRE_RANK[b.cadre] ?? 9);
      if (cadreDiff !== 0) return cadreDiff;
      return Number(a.doj.slice(0, 4)) - Number(b.doj.slice(0, 4));
    });
    ranked.slice(0, FLAGSHIP_PER_DEPT).forEach((e) => { e.isFlagship = true; });
  }
}

function buildCompensation(employees) {
  return employees.map((e) => {
    const [min, max] = CADRE_BASIC_PAY_RANGE[e.cadre];
    const basicPay = faker.number.int({ min, max });
    const daAmount = Math.round((basicPay * DA_PERCENT) / 100);
    const hraAmount = Math.round((basicPay * HRA_PERCENT) / 100);
    return {
      employeeId: e.id,
      payGrade: e.cadre,
      basicPay,
      daPercent: DA_PERCENT,
      daAmount,
      hraPercent: HRA_PERCENT,
      hraAmount,
      grossPay: basicPay + daAmount + hraAmount,
    };
  });
}

// A manager-style narrative sentence tied to the actual rating/trend for
// that review year — replaces having no comment field at all. Mirrors the
// threshold-based sentence-building pattern used for LEGAL_CASE_TEMPLATES'
// aiSummary elsewhere in this file.
function buildReviewComment(e, rating, trendDelta, year) {
  if (rating >= 4.3) return `Consistently exceeds expectations as ${e.designation} in ${e.department}; strong candidate for accelerated growth in ${year}.`;
  if (rating >= 3.6) {
    return trendDelta >= 0
      ? `Solid, improving performance in ${year}; meets all core KPIs for ${e.designation}.`
      : `Meets expectations overall in ${year}, though recent trend shows a slight dip — monitor next cycle.`;
  }
  if (rating >= 2.8) return `Performance below departmental benchmark in ${year}; targeted coaching recommended for ${e.designation} responsibilities.`;
  return `Significant performance concerns noted in ${year} for ${e.designation}; formal improvement plan advised.`;
}

// Picks a disciplinary note category based on what's actually driving the
// employee's trouble score, so the note matches the rest of the story
// instead of being an unrelated random pick.
function pickDisciplinaryNote(attendanceRate, trendDelta, status) {
  let category;
  if (status === "Suspended") category = "Conduct";
  else if (attendanceRate < 0.82) category = "Absenteeism";
  else if (trendDelta < -0.3) category = "Performance";
  else category = faker.helpers.arrayElement(["Conduct", "Compliance"]);
  return faker.helpers.arrayElement(DISCIPLINARY_NOTES_BY_CATEGORY[category]);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// Replaces the old buildPerformance(): still produces PerformanceRecord
// rows, but ALSO derives and mutates each employee's flags in place
// (promotionDue/appraisalPending/trainingPending/missingDocs/
// disciplinaryFlag/disciplinaryNote) from a composite "trouble score" built
// from the rating trend + real attendance rate, so an employee's flags read
// as one coherent case file instead of five independent coin-flips. Must
// run AFTER buildAttendance() (its rate-per-employee map is passed in) and
// BEFORE employees are persisted, since it mutates the in-memory objects.
function buildPerformanceAndFlags(employees, attendanceRateByEmployee) {
  const perfRows = [];
  for (const e of employees) {
    const dojYear = Number(e.doj.slice(0, 4));
    // Only rate years the employee had actually joined by — a 3-year window
    // for tenured staff, fewer rows for recent joiners, rather than always
    // fabricating a fixed 2-year history regardless of when they joined.
    const years = [NOW_YEAR - 2, NOW_YEAR - 1, NOW_YEAR].filter((y) => y >= dojYear);
    let baseRating = Math.round(faker.number.float({ min: 2.5, max: 4.8, fractionDigits: 1 }) * 10) / 10;
    const ratings = [];
    for (const year of years) {
      const drift = faker.number.float({ min: -0.4, max: 0.4 });
      baseRating = Math.max(2, Math.min(5, Math.round((baseRating + drift) * 10) / 10));
      ratings.push({ year, rating: baseRating });
    }
    const latest = ratings[ratings.length - 1]?.rating ?? 3.5;
    const trendDelta = ratings.length > 1 ? latest - ratings[0].rating : 0;
    const tenure = NOW_YEAR - dojYear;
    const attendanceRate = attendanceRateByEmployee.get(e.id) ?? 0.9;

    // Single composite number driving every flag below, so the story is
    // coherent: poor attendance + declining rating + suspension all push
    // the same needle, instead of five unrelated probability rolls.
    const troubleScore =
      (5 - latest) * 18
      + Math.max(0, -trendDelta) * 25
      + Math.max(0, 0.9 - attendanceRate) * 120
      + (e.status === "Suspended" ? 30 : 0);
    const strengthScore =
      latest * 15
      + Math.max(0, trendDelta) * 20
      + Math.max(0, attendanceRate - 0.92) * 150
      + Math.min(15, tenure);

    for (const { year, rating } of ratings) {
      const attritionRiskScore = Math.round(clamp(
        (5 - rating) * 16 + troubleScore * 0.5 + faker.number.float({ min: -5, max: 5 }),
        0, 100,
      ) * 10) / 10;
      perfRows.push({
        employeeId: e.id,
        year,
        rating,
        attritionRiskScore,
        reviewComments: buildReviewComment(e, rating, trendDelta, year),
        reviewedBy: e.department ? `Reporting Officer, ${e.department}` : "Reporting Officer",
      });
    }

    e.disciplinaryFlag = troubleScore > 55 && faker.number.float({ min: 0, max: 1 }) > 0.55;
    e.disciplinaryNote = e.disciplinaryFlag ? pickDisciplinaryNote(attendanceRate, trendDelta, e.status) : null;

    // Strong performers with enough tenure — and explicitly never someone
    // already flagged for disciplinary reasons.
    e.promotionDue = !e.disciplinaryFlag && strengthScore > 55 && tenure >= (CADRE_MIN_TENURE[e.cadre] || 0) / 2;

    e.appraisalPending = faker.number.float({ min: 0, max: 1 }) < clamp(troubleScore / 140, 0.05, 0.5);
    e.trainingPending = faker.number.float({ min: 0, max: 1 }) < clamp(troubleScore / 120, 0.08, 0.55);
    e.missingDocs = faker.number.float({ min: 0, max: 1 }) < clamp(troubleScore / 200, 0.03, 0.3);
  }
  return perfRows;
}

function buildTraining(employees) {
  const rows = [];
  for (const e of employees) {
    const count = faker.number.int({ min: 1, max: 3 });
    const chosen = faker.helpers.arrayElements(TRAINING_TITLES, count);
    for (const t of chosen) {
      const completed = faker.datatype.boolean(0.75);
      rows.push({
        employeeId: e.id,
        title: t.title,
        category: t.category,
        completionDate: completed ? faker.date.past({ years: 2 }).toISOString().slice(0, 10) : "—",
        status: completed ? "Completed" : "Scheduled",
      });
    }
  }
  return rows;
}

const SKILL_REFERENCE_DATE = `${NOW_YEAR}-07-14`;

function buildSkills(employees) {
  const rows = [];
  const levels = ["Beginner", "Intermediate", "Expert"];
  for (const e of employees) {
    const count = e.isFlagship ? faker.number.int({ min: 6, max: 10 }) : faker.number.int({ min: 1, max: 4 });
    const chosen = faker.helpers.arrayElements(SKILL_POOL, count);
    // Guard against employees who joined after the fixed reference date (new
    // joiners whose doj is later in NOW_YEAR than July 14) — faker.date.between
    // requires from <= to, so fall back to the doj itself in that case.
    const acquiredTo = e.doj > SKILL_REFERENCE_DATE ? e.doj : SKILL_REFERENCE_DATE;
    for (const skill of chosen) {
      const acquiredDate = e.doj >= acquiredTo ? e.doj : faker.date.between({ from: e.doj, to: acquiredTo }).toISOString().slice(0, 10);
      rows.push({ employeeId: e.id, name: skill, proficiency: faker.helpers.arrayElement(levels), acquiredDate });
    }
  }
  return rows;
}

// Municipal offices run a 6-day work week (closed Sundays) — total working
// days per month should reflect the real calendar, not a flat constant.
function workingDaysInMonth(year, month1to12) {
  const daysInMonth = new Date(year, month1to12, 0).getDate();
  let sundays = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    if (new Date(year, month1to12 - 1, d).getDay() === 0) sundays++;
  }
  return daysInMonth - sundays;
}

function buildAttendance(employees) {
  const rows = [];
  const today = new Date();
  const months = Array.from({ length: 6 }).map((_, i) => {
    const y = today.getFullYear();
    const m = today.getMonth() - i;
    const d = new Date(y, m, 1);
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  });
  for (const e of employees) {
    const attendanceRateRange = e.status === "OnLeave" ? [0.55, 0.78] : e.status === "Suspended" ? [0, 0.2] : [0.85, 1];
    for (const { year, month } of months) {
      const totalDays = workingDaysInMonth(year, month);
      const rate = faker.number.float({ min: attendanceRateRange[0], max: attendanceRateRange[1] });
      const presentDays = Math.round(totalDays * rate);
      rows.push({ employeeId: e.id, month: `${year}-${String(month).padStart(2, "0")}`, presentDays, totalDays });
    }
  }
  return rows;
}

// Task pools are department-specific so a task's project/title actually
// matches the assignee's real department, instead of e.g. a Health officer
// being assigned a "Road Repair" task — a realism gap found in review.
const DEPT_TASK_POOLS = {
  "Health": [
    { project: "Health Inspection · Maninagar", title: "Hospital sanitation audit", category: "Inspection" },
    { project: "Epidemic Preparedness Drive", title: "Vector-borne disease surveillance", category: "Drive" },
    { project: "Public Health Audit Q2", title: "Primary health center compliance review", category: "Audit" },
    { project: "Maternal & Child Health Survey", title: "Anganwadi coverage survey", category: "Survey" },
  ],
  "Engineering": [
    { project: "Road Repair · SG Highway", title: "Site inspection and damage report", category: "Inspection" },
    { project: "Building Approval · Bopal", title: "Plan review and clearance", category: "Approval" },
    { project: "Bridge Safety Survey", title: "Structural integrity survey", category: "Survey" },
    { project: "Flyover Maintenance · Ring Road", title: "Expansion joint maintenance", category: "Maintenance" },
  ],
  "Water Supply": [
    { project: "Water Supply · Naroda", title: "Pipeline pressure inspection", category: "Inspection" },
    { project: "Pre-Monsoon Pipeline Maintenance", title: "Valve and pump maintenance", category: "Maintenance" },
    { project: "New Connection Survey", title: "Household connection feasibility survey", category: "Survey" },
  ],
  "Drainage": [
    { project: "Drainage Maintenance · Vastrapur", title: "Pre-monsoon cleaning audit", category: "Maintenance" },
    { project: "Storm Water Survey", title: "Drain capacity survey", category: "Survey" },
    { project: "Waterlogging Complaint Audit", title: "Ward-wise waterlogging review", category: "Audit" },
  ],
  "Solid Waste Management": [
    { project: "Waste Collection Audit · North Zone", title: "Route compliance review", category: "Audit" },
    { project: "Door-to-Door Segregation Drive", title: "Household segregation compliance", category: "Drive" },
    { project: "Landfill Capacity Inspection", title: "Landfill site inspection", category: "Inspection" },
  ],
  "Fire & Emergency Services": [
    { project: "Fire Safety Audit · Commercial Zone", title: "Fire NOC compliance inspection", category: "Inspection" },
    { project: "Emergency Drill Readiness", title: "Mock evacuation drill", category: "Drive" },
    { project: "Hydrant Network Survey", title: "Fire hydrant serviceability survey", category: "Survey" },
  ],
  "Town Planning": [
    { project: "Building Approval · Bopal", title: "Plan review and clearance", category: "Approval" },
    { project: "TP Scheme Survey", title: "Land-use survey", category: "Survey" },
    { project: "Unauthorized Construction Audit", title: "Encroachment identification audit", category: "Audit" },
  ],
  "Revenue": [
    { project: "Property Tax Survey · West Zone", title: "Door-to-door survey scheduling", category: "Survey" },
    { project: "Tax Recovery Audit", title: "Defaulter list reconciliation", category: "Audit" },
    { project: "Rebate Verification Drive", title: "Early-payment rebate verification", category: "Drive" },
  ],
  "Garden": [
    { project: "Tree Plantation Drive · Riverfront", title: "Sapling allocation and reporting", category: "Drive" },
    { project: "Park Maintenance Audit", title: "Garden upkeep inspection", category: "Inspection" },
    { project: "Horticulture Nursery Survey", title: "Nursery stock survey", category: "Survey" },
  ],
  "Education": [
    { project: "School Infrastructure Survey", title: "Classroom condition survey", category: "Survey" },
    { project: "Mid-Day Meal Audit", title: "Kitchen hygiene inspection", category: "Audit" },
    { project: "Enrollment Drive · Primary Schools", title: "Out-of-school children enrollment drive", category: "Drive" },
  ],
  "Urban Community Development": [
    { project: "Slum Rehabilitation Survey", title: "Beneficiary eligibility survey", category: "Survey" },
    { project: "Self-Help Group Audit", title: "SHG financial compliance audit", category: "Audit" },
  ],
  "Housing": [
    { project: "Affordable Housing Inspection", title: "Site construction quality inspection", category: "Inspection" },
    { project: "Housing Allotment Audit", title: "Beneficiary allotment audit", category: "Audit" },
  ],
  "Disaster Management": [
    { project: "Flood Preparedness Drive", title: "Ward-level flood response drill", category: "Drive" },
    { project: "Shelter Readiness Survey", title: "Emergency shelter capacity survey", category: "Survey" },
  ],
};
// Departments without a dedicated pool (administrative/back-office units)
// get realistic office-process tasks instead of field-inspection language.
const GENERIC_TASK_POOL = [
  { project: "Departmental File Disposal Drive", title: "Pending file clearance", category: "Audit" },
  { project: "Annual Compliance Review", title: "Statutory compliance checklist review", category: "Audit" },
  { project: "Office Infrastructure Maintenance", title: "Facility upkeep inspection", category: "Maintenance" },
  { project: "Digital Records Migration", title: "Record digitization tracking", category: "Drive" },
  { project: "Internal Process Audit", title: "SOP adherence review", category: "Audit" },
];

const MILESTONES = ["Kickoff", "Site Survey Complete", "Draft Report Submitted", "Stakeholder Review", "Final Sign-off"];

function addDays(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildTasks(employees, count) {
  const tasks = [];
  const today = new Date();
  for (let i = 0; i < count; i++) {
    const emp = faker.helpers.arrayElement(employees);
    const pool = DEPT_TASK_POOLS[emp.department] || GENERIC_TASK_POOL;
    const proj = faker.helpers.arrayElement(pool);
    const due = faker.number.int({ min: -4, max: 10 });
    const tat = 5 + (i % 8);
    const status =
      i % 13 === 0 ? "Completed" :
      due < 0 ? "Overdue" :
      i % 9 === 0 ? "Escalated" :
      i % 5 === 0 ? "InProgress" : "Pending";
    const sla = due < 0 ? "Breached" : due < 3 ? "AtRisk" : "OnTrack";
    const eta = addDays(today, due);
    const skew = faker.number.int({ min: -2, max: 4 });
    const createdDaysAgo = faker.number.int({ min: 1, max: 45 });
    const createdAt = new Date(addDays(today, -createdDaysAgo));
    const completedAt = status === "Completed"
      ? new Date(addDays(createdAt, faker.number.int({ min: 1, max: createdDaysAgo })))
      : null;
    // Real, stored progress — correlated to status but genuinely varied
    // (not a binary 0/100 derived from status+deadline math at read time,
    // which made ~80% of tasks show an identical flat 0 or 100).
    const progressPct =
      status === "Completed" ? 100 :
      status === "Pending" ? faker.number.int({ min: 0, max: 15 }) :
      status === "InProgress" ? faker.number.int({ min: 20, max: 85 }) :
      status === "Escalated" ? faker.number.int({ min: 15, max: 70 }) :
      faker.number.int({ min: 40, max: 95 }); // Overdue — ran past deadline, often after real partial work
    tasks.push({
      id: `TSK-${2400 + i}`,
      project: proj.project,
      title: proj.title,
      category: proj.category,
      employeeId: emp.id,
      department: emp.department,
      priority: faker.helpers.arrayElement(["High", "Medium", "Low", "Medium"]),
      dueIn: due,
      tatDays: tat,
      slaStatus: sla,
      createdBy: i % 2 === 0 ? "Meera Trivedi" : "Anil Shah",
      updatedAt: addDays(today, -createdDaysAgo),
      status,
      aiSummary: `${proj.category} task in ${emp.department}. TAT ${tat}d · ${sla}. ${due < 0 ? "SLA breached — escalate" : `${due}d to deadline`}.`,
      delayRisk: due < 0 ? "High" : due < 3 ? "Medium" : "Low",
      sow: i % 4 === 0 ? `Scope: ${proj.title} covering ${proj.project.split("·")[1]?.trim() || proj.project}.` : null,
      milestone: i % 3 === 0 ? faker.helpers.arrayElement(MILESTONES) : null,
      eta,
      projectedCompletion: addDays(eta, skew),
      createdAt,
      completedAt,
      progressPct,
    });
  }
  return tasks;
}

// 6 trailing months of real per-department/zone task volume + completion
// rate, so the Task Management "efficiency trend" chart and the AI
// productivity suggestion have genuine month-over-month history to compare
// against — Task itself has no such history (updatedAt is overwritten on
// every reassignment), so this is seeded directly rather than derived.
function buildTaskMonthlySnapshots(employees) {
  const rows = [];
  const combos = new Map(); // "department||zone" -> employee count
  for (const e of employees) {
    if (!e.zone) continue;
    const key = `${e.department}||${e.zone}`;
    combos.set(key, (combos.get(key) || 0) + 1);
  }

  const now = new Date();
  const monthKeys = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  for (const [key, headcount] of combos) {
    const [department, zone] = key.split("||");
    // Deterministic-ish per-combo trend direction: some departments/zones
    // genuinely improving, some flat, some declining — gives the AI
    // suggestion real variation to point at instead of everything looking
    // identical.
    const trendDirection = faker.helpers.arrayElement(["improving", "flat", "flat", "declining"]);
    let completionRate = faker.number.float({ min: 0.72, max: 0.9 });
    let avgTat = faker.number.float({ min: 4, max: 9 });

    monthKeys.forEach((month) => {
      const totalTasks = Math.max(3, Math.round(headcount * faker.number.float({ min: 0.4, max: 0.9 })));
      const completedTasks = Math.round(totalTasks * completionRate);
      const overdueTasks = Math.max(0, Math.round((totalTasks - completedTasks) * faker.number.float({ min: 0.2, max: 0.6 })));
      rows.push({
        department, zone, month,
        totalTasks, completedTasks, overdueTasks,
        avgTatDays: Math.round(avgTat * 10) / 10,
      });
      // Drift for next month, in the chosen direction.
      if (trendDirection === "improving") {
        completionRate = Math.min(0.97, completionRate + faker.number.float({ min: 0.01, max: 0.03 }));
        avgTat = Math.max(2, avgTat - faker.number.float({ min: 0.1, max: 0.4 }));
      } else if (trendDirection === "declining") {
        completionRate = Math.max(0.5, completionRate - faker.number.float({ min: 0.01, max: 0.03 }));
        avgTat = avgTat + faker.number.float({ min: 0.1, max: 0.4 });
      } else {
        completionRate = Math.min(0.95, Math.max(0.6, completionRate + faker.number.float({ min: -0.01, max: 0.01 })));
        avgTat = Math.max(3, avgTat + faker.number.float({ min: -0.2, max: 0.2 }));
      }
    });
  }
  return rows;
}

const ASSET_TYPES = [
  { type: "Laptop", statuses: ["Assigned", "Assigned", "Assigned", "Returned"] },
  { type: "Mobile Phone", statuses: ["Assigned", "Assigned", "Returned"] },
  { type: "ID Card", statuses: ["Assigned", "Assigned", "Assigned", "Assigned"] },
  { type: "Vehicle", statuses: ["Assigned", "Returned"] },
  { type: "Safety Gear", statuses: ["Assigned", "Assigned", "Lost"] },
  { type: "SIM Card", statuses: ["Assigned", "Assigned", "Returned"] },
];

function buildAssets(employees) {
  const rows = [];
  let seq = 1;
  for (const e of employees) {
    const count = faker.number.int({ min: 1, max: 4 });
    const chosen = faker.helpers.arrayElements(ASSET_TYPES, count);
    for (const a of chosen) {
      const status = faker.helpers.arrayElement(a.statuses);
      rows.push({
        id: `AST-${seq++}`,
        employeeId: e.id,
        type: a.type,
        description: `${a.type} issued for official use`,
        assignedDate: faker.date.past({ years: 5 }).toISOString().slice(0, 10),
        status,
        serialNo: a.type === "ID Card" || a.type === "SIM Card" ? null : `SN-${faker.string.alphanumeric(8).toUpperCase()}`,
      });
    }
  }
  return rows;
}

const AWARD_TITLES = [
  { title: "Best Employee Award", category: "Excellence" },
  { title: "Long Service Award", category: "Service" },
  { title: "Excellence in Public Service", category: "Excellence" },
  { title: "Commendation Certificate", category: "Commendation" },
  { title: "Outstanding Contribution Award", category: "Excellence" },
];
const LIFE_EVENT_TITLES = [
  { title: "Marriage", category: "Personal", description: "Availed leave for marriage; family details updated in service records." },
  { title: "Childbirth", category: "Personal", description: "Availed parental leave; dependent details updated in service records." },
  { title: "Bereavement", category: "Personal", description: "Availed compassionate/bereavement leave; condolence noted in service record." },
  { title: "Work Anniversary", category: "Milestone", description: null }, // description built per-tenure below instead of a fixed string
  { title: "Medical Leave — Recovery", category: "Health", description: "Returned to duty following approved medical leave; fitness certificate on file." },
];

function buildEmployeeEvents(employees) {
  const rows = [];
  let seq = 1;
  for (const e of employees) {
    const tenure = NOW_YEAR - Number(e.doj.slice(0, 4));
    const headTitle = DEPT_HEAD_TITLE[e.departmentId] || "Municipal Commissioner";

    // Guaranteed baseline: every employee with at least a year of service
    // gets a Work Anniversary milestone on record, instead of leaving
    // ~72% of employees with zero employeeEvents (the prior behavior),
    // which made their Activity tab/score identical to everyone else's.
    if (tenure >= 1) {
      rows.push({
        id: `EVT-${seq++}`,
        employeeId: e.id,
        kind: "LifeEvent",
        title: "Work Anniversary",
        category: "Milestone",
        date: `${NOW_YEAR}-${e.doj.slice(5, 10)}`,
        description: `Completed ${tenure} year${tenure === 1 ? "" : "s"} of service as ${e.designation}, ${e.department}.`,
        awardedBy: null,
        isPublic: faker.datatype.boolean(0.1),
      });
    }

    // Flagship employees get 3-5 additional Award/LifeEvent rows sampled
    // without replacement, instead of the single probabilistic extra row
    // standard employees may get below — their history should read as
    // materially deeper, not just occasionally-one-more.
    if (e.isFlagship) {
      const extraCount = faker.number.int({ min: 3, max: 5 });
      const eligibleLifeEvents = LIFE_EVENT_TITLES.filter((t) => t.title !== "Work Anniversary");
      const pool = [
        ...AWARD_TITLES.map((a) => ({ kind: "Award", ...a })),
        ...eligibleLifeEvents.map((l) => ({ kind: "LifeEvent", ...l })),
      ];
      const chosen = faker.helpers.arrayElements(pool, Math.min(extraCount, pool.length));
      for (const item of chosen) {
        const isAward = item.kind === "Award";
        rows.push({
          id: `EVT-${seq++}`,
          employeeId: e.id,
          kind: item.kind,
          title: item.title,
          category: item.category,
          date: faker.date.past({ years: 4 }).toISOString().slice(0, 10),
          description: isAward
            ? `Recognized for ${item.category.toLowerCase()} in departmental duties as ${e.designation}.`
            : item.description,
          awardedBy: isAward ? headTitle : null,
          isPublic: isAward ? faker.datatype.boolean(0.8) : faker.datatype.boolean(0.1),
        });
      }
      continue;
    }

    // On top of the guaranteed baseline, a further ~40% chance of an
    // additional award or personal life event, so records still vary in
    // richness rather than every employee having exactly one identical row.
    if (faker.number.float({ min: 0, max: 1 }) > 0.6) continue;
    const isAward = faker.datatype.boolean(0.6);
    if (isAward) {
      const a = faker.helpers.arrayElement(AWARD_TITLES);
      rows.push({
        id: `EVT-${seq++}`,
        employeeId: e.id,
        kind: "Award",
        title: a.title,
        category: a.category,
        date: faker.date.past({ years: 4 }).toISOString().slice(0, 10),
        description: `Recognized for ${a.category.toLowerCase()} in departmental duties as ${e.designation}.`,
        awardedBy: headTitle,
        isPublic: faker.datatype.boolean(0.8),
      });
    } else {
      const l = faker.helpers.arrayElement(LIFE_EVENT_TITLES.filter((t) => t.title !== "Work Anniversary"));
      rows.push({
        id: `EVT-${seq++}`,
        employeeId: e.id,
        kind: "LifeEvent",
        title: l.title,
        category: l.category,
        date: faker.date.past({ years: 4 }).toISOString().slice(0, 10),
        description: l.description,
        awardedBy: null,
        isPublic: faker.datatype.boolean(0.1),
      });
    }
  }
  return rows;
}

// Extra promotion/transfer service-book history beyond the small static
// SERVICE_BOOK_DOCS list, gated by tenure so only employees with enough
// service years plausibly have a promotion/transfer order on file.
function buildCareerHistory(employees) {
  const rows = [];
  let seq = 2000;
  for (const e of employees) {
    const tenure = NOW_YEAR - Number(e.doj.slice(0, 4));

    // Every employee has at least one document on file — the appointment
    // order from their date of joining — so the Documents tab is never
    // empty regardless of tenure/promotion/transfer history below.
    rows.push({
      id: `SBE-${seq++}`,
      employeeId: e.id,
      type: "Appointment Order",
      date: e.doj,
      ocrScore: Math.round(faker.number.float({ min: 90, max: 99.5 }) * 10) / 10,
      status: "Verified",
      description: `First appointment as ${e.designation}, ${e.department}`,
    });

    // Flagship employees always get at least one promotion record (the
    // random gate below is skipped for them), and if they also have enough
    // tenure, a second promotion plus a Training Certification entry so
    // their service book reads materially deeper than a standard employee's.
    if (tenure >= 3 && (e.isFlagship || faker.number.float({ min: 0, max: 1 }) > 0.55)) {
      const fromDesig = faker.helpers.arrayElement((DEPT_CADRE_DESIGNATIONS[e.departmentId] || GENERIC_CADRE_DESIGNATIONS)[e.cadre]);
      rows.push({
        id: `SBE-${seq++}`,
        employeeId: e.id,
        type: "Promotion Order",
        date: faker.date.past({ years: Math.min(tenure, 6) }).toISOString().slice(0, 10),
        ocrScore: Math.round(faker.number.float({ min: 88, max: 99.5 }) * 10) / 10,
        status: "Verified",
        description: `Promoted from ${fromDesig} to ${e.designation}`,
      });

      if (e.isFlagship && tenure >= 5) {
        const earlierDesig = faker.helpers.arrayElement((DEPT_CADRE_DESIGNATIONS[e.departmentId] || GENERIC_CADRE_DESIGNATIONS)[e.cadre]);
        rows.push({
          id: `SBE-${seq++}`,
          employeeId: e.id,
          type: "Promotion Order",
          date: faker.date.past({ years: Math.min(tenure, 10) }).toISOString().slice(0, 10),
          ocrScore: Math.round(faker.number.float({ min: 88, max: 99.5 }) * 10) / 10,
          status: "Verified",
          description: `Promoted from ${earlierDesig} to ${fromDesig}`,
        });
        rows.push({
          id: `SBE-${seq++}`,
          employeeId: e.id,
          type: "Training Certification",
          date: faker.date.past({ years: Math.min(tenure, 5) }).toISOString().slice(0, 10),
          ocrScore: Math.round(faker.number.float({ min: 90, max: 99.5 }) * 10) / 10,
          status: "Verified",
          description: `Completed advanced professional certification relevant to ${e.designation}, ${e.department}.`,
        });
      }
    }
    if (tenure >= 2 && faker.number.float({ min: 0, max: 1 }) > 0.65) {
      const fromPosting = faker.helpers.arrayElement(POSTINGS.filter((p) => p !== e.posting)) || e.posting;
      rows.push({
        id: `SBE-${seq++}`,
        employeeId: e.id,
        type: "Transfer Order",
        date: faker.date.past({ years: Math.min(tenure, 5) }).toISOString().slice(0, 10),
        ocrScore: Math.round(faker.number.float({ min: 85, max: 99 }) * 10) / 10,
        status: "Verified",
        description: `Transferred from ${fromPosting} to ${e.posting}`,
      });
    }
  }
  return rows;
}

const FINANCE_CATEGORIES = ["Salary", "Infrastructure", "Capital Works", "Travel", "Contingency & Reserves", "Misc"];
// Budget composition varies by what a department actually does — e.g.
// Engineering skews toward Capital Works, Legal carries a larger
// Contingency & Reserves share (litigation exposure), CivicAdmin skews
// toward Salary/Misc — instead of one flat share applied identically
// everywhere regardless of function.
const CATEGORY_SHARE_BY_GROUP = {
  Health:      { Salary: 0.62, Infrastructure: 0.10, "Capital Works": 0.18, Travel: 0.04, "Contingency & Reserves": 0.04, Misc: 0.02 },
  Engineering: { Salary: 0.40, Infrastructure: 0.20, "Capital Works": 0.30, Travel: 0.03, "Contingency & Reserves": 0.04, Misc: 0.03 },
  Sanitation:  { Salary: 0.50, Infrastructure: 0.30, "Capital Works": 0.10, Travel: 0.03, "Contingency & Reserves": 0.04, Misc: 0.03 },
  Safety:      { Salary: 0.55, Infrastructure: 0.15, "Capital Works": 0.18, Travel: 0.05, "Contingency & Reserves": 0.05, Misc: 0.02 },
  CivicAdmin:  { Salary: 0.65, Infrastructure: 0.08, "Capital Works": 0.08, Travel: 0.06, "Contingency & Reserves": 0.06, Misc: 0.07 },
  Legal:       { Salary: 0.60, Infrastructure: 0.05, "Capital Works": 0.03, Travel: 0.05, "Contingency & Reserves": 0.20, Misc: 0.07 },
  Education:   { Salary: 0.68, Infrastructure: 0.12, "Capital Works": 0.10, Travel: 0.03, "Contingency & Reserves": 0.04, Misc: 0.03 },
  Culture:     { Salary: 0.55, Infrastructure: 0.20, "Capital Works": 0.12, Travel: 0.05, "Contingency & Reserves": 0.04, Misc: 0.04 },
};

function buildDepartmentFinance(departments, employeesByDept) {
  const rows = [];
  const today = new Date();
  const months = Array.from({ length: 12 }).map((_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  for (const dept of departments) {
    const headcount = employeesByDept.get(dept.id)?.length || 0;
    const baseMonthlyBudget = Math.max(500000, headcount * 42000);
    const share = CATEGORY_SHARE_BY_GROUP[DEPT_CATEGORY[dept.id]] || CATEGORY_SHARE_BY_GROUP.CivicAdmin;
    for (const month of months) {
      // Some departments are intentionally over/under budget so variance
      // analysis has something meaningful to surface.
      const varianceFactor = faker.number.float({ min: 0.82, max: 1.18 });
      for (const category of FINANCE_CATEGORIES) {
        const allocatedBudget = Math.round(baseMonthlyBudget * share[category]);
        const amountSpent = Math.round(allocatedBudget * varianceFactor * faker.number.float({ min: 0.9, max: 1.1 }));
        rows.push({ department: dept.id, month, allocatedBudget, amountSpent, category });
      }
    }
  }
  return rows;
}

const EXPENSE_VENDORS = [
  "Global Infra Ltd", "Apex Supplies", "Shreeji Constructions", "Bhagwati Traders",
  "Reliable Hardware Co.", "Sundaram Engineering Works", "Patel Earthmovers", "Gujarat Steel Traders",
  "Krishna Electricals", "Om Sai Suppliers",
];
const EXPENSE_TYPES_WEIGHTED = ["Vendor Payment", "Vendor Payment", "Travel Claim", "Medical Claim"];

// Real department-scaled expense/claim rows over the last 60 days — a small
// deliberate handful of amount outliers and submitter+amount duplicates are
// seeded in so the rule-based anomaly scan (2x dept average / duplicate
// within 7 days — see GET /api/v1/finance/expenses) has genuine cases to
// surface instead of flagging nothing.
function buildExpenses(departments, employeesByDept) {
  const rows = [];
  let seq = 1;
  const today = new Date();
  for (const dept of departments) {
    const deptEmployees = employeesByDept.get(dept.id) || [];
    const headcount = deptEmployees.length;
    if (!headcount) continue;
    const baseAmount = Math.max(15000, Math.round(headcount * 180));
    const count = faker.number.int({ min: 6, max: 14 });
    const deptRows = [];
    for (let i = 0; i < count; i++) {
      const type = faker.helpers.arrayElement(EXPENSE_TYPES_WEIGHTED);
      const submitter = type === "Vendor Payment"
        ? faker.helpers.arrayElement(EXPENSE_VENDORS)
        : faker.helpers.arrayElement(deptEmployees).name;
      const daysAgo = faker.number.int({ min: 0, max: 60 });
      const submittedAt = new Date(today.getTime() - daysAgo * 24 * 60 * 60 * 1000);
      const amount = Math.round(baseAmount * faker.number.float({ min: 0.4, max: 1.6 }));
      deptRows.push({ id: `EXP-${String(seq++).padStart(5, "0")}`, department: dept.id, type, submitter, amount, submittedAt });
    }
    // One genuine outlier per department — 2.5x-4x the base scale.
    const outlierSubmitter = faker.helpers.arrayElement(EXPENSE_VENDORS);
    deptRows.push({
      id: `EXP-${String(seq++).padStart(5, "0")}`, department: dept.id, type: "Vendor Payment",
      submitter: outlierSubmitter, amount: Math.round(baseAmount * faker.number.float({ min: 2.5, max: 4 })),
      submittedAt: new Date(today.getTime() - faker.number.int({ min: 0, max: 30 }) * 24 * 60 * 60 * 1000),
    });
    rows.push(...deptRows);
  }
  // A handful of cross-row duplicate pairs (same submitter+amount within a
  // few days) so the duplicate-detection rule has real matches to find.
  const duplicateCandidates = faker.helpers.arrayElements(rows, Math.min(6, rows.length));
  for (const original of duplicateCandidates) {
    rows.push({
      id: `EXP-${String(seq++).padStart(5, "0")}`, department: original.department, type: original.type,
      submitter: original.submitter, amount: original.amount,
      submittedAt: new Date(new Date(original.submittedAt).getTime() + faker.number.int({ min: 1, max: 4 }) * 24 * 60 * 60 * 1000),
    });
  }
  return rows;
}

const DEPT_HEAD_TITLE = {
  COMM: "Municipal Commissioner", ADMIN: "Deputy Municipal Commissioner (Admin)",
  HEALTH: "Medical Officer of Health", ENGG: "City Engineer", WATER: "Chief Engineer (Water Supply)",
  DRAIN: "Chief Engineer (Drainage)", SWM: "Deputy Municipal Commissioner (SWM)", FIRE: "Chief Fire Officer",
  PLAN: "Chief Town Planner", ESTATE: "Estate Officer", REV: "Deputy Municipal Commissioner (Revenue)",
  UCD: "Community Development Officer", HOUSING: "Housing Officer", GARDEN: "Superintendent (Gardens)",
  IT: "Chief Information Officer", FIN: "Chief Accounts Officer", LEGAL: "City Solicitor",
  EDU: "Administrative Officer (Education)", ZOO: "Zoo Superintendent", LIB: "City Librarian",
  SPORTS: "Sports Officer", DM: "Disaster Management Officer", PROC: "Chief Procurement Officer",
  GRIEV: "Public Grievance Officer",
};
const AUDIT_STATUS_WEIGHTED = ["Clean", "Clean", "Clean", "Clean", "Minor Observations", "Minor Observations", "Under Review"];
// Audit-status weighting varies by department category — Engineering/Legal
// carry more scrutiny (capital-works spend, litigation exposure) than a
// back-office CivicAdmin department, instead of one shared distribution
// applied identically everywhere (which made almost every department show
// "Clean").
const AUDIT_STATUS_BY_CATEGORY = {
  Engineering: ["Clean", "Clean", "Minor Observations", "Minor Observations", "Under Review"],
  Legal:       ["Clean", "Clean", "Minor Observations", "Under Review", "Under Review"],
  Sanitation:  ["Clean", "Clean", "Clean", "Minor Observations", "Under Review"],
  Safety:      ["Clean", "Clean", "Clean", "Minor Observations"],
  Health:      ["Clean", "Clean", "Clean", "Minor Observations", "Under Review"],
  CivicAdmin:  ["Clean", "Clean", "Clean", "Clean", "Minor Observations"],
  Education:   ["Clean", "Clean", "Clean", "Clean", "Minor Observations"],
  Culture:     ["Clean", "Clean", "Clean", "Clean", "Minor Observations"],
};

function buildDeptRiskNote(dept, auditStatus, headcount) {
  if (auditStatus === "Under Review") {
    return `${dept.name} is under vigilance review following irregularities flagged in the last audit cycle — corrective action plan due.`;
  }
  if (auditStatus === "Minor Observations") {
    return `Last audit of ${dept.name} raised minor observations on documentation/process compliance — remediation in progress, no material risk.`;
  }
  return `${dept.name} cleared its last statutory audit with no material findings across its ${headcount.toLocaleString("en-IN")}-strong workforce.`;
}

// `deptHeadId` (dept.id -> employee id, from buildEmployees()) and
// `employees` (the full list) let the department head be a REAL seeded
// employee instead of a disconnected random name.
function buildDepartmentProfiles(employeesByDept, deptHeadId, employees) {
  const today = new Date();
  const employeeById = new Map(employees.map((e) => [e.id, e]));
  return DEPARTMENTS.map((d) => {
    const headcount = employeesByDept.get(d.id)?.length || 0;
    const daysAgo = faker.number.int({ min: 30, max: 540 });
    const auditDate = new Date(today.getTime() - daysAgo * 24 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const headId = deptHeadId[d.id] || null;
    const head = headId ? employeeById.get(headId) : null;
    const auditPool = AUDIT_STATUS_BY_CATEGORY[DEPT_CATEGORY[d.id]] || AUDIT_STATUS_WEIGHTED;
    const auditStatus = faker.helpers.arrayElement(auditPool);
    return {
      department: d.id,
      headName: head ? head.name : `${faker.helpers.arrayElement(FIRST)} ${faker.helpers.arrayElement(LAST)}`,
      headEmployeeId: head ? head.id : null,
      headTitle: DEPT_HEAD_TITLE[d.id] || "Deputy Municipal Commissioner",
      budgetCr: Math.round(Math.max(2, headcount * 0.018) * 10) / 10,
      auditStatus,
      lastAuditDate: `${auditDate.getFullYear()}-${pad(auditDate.getMonth() + 1)}-${pad(auditDate.getDate())}`,
      riskNote: buildDeptRiskNote(d, auditStatus, headcount),
    };
  });
}

function buildVacancies(employeesByDept) {
  const rows = [];
  for (const d of DEPARTMENTS) {
    const deptEmployees = employeesByDept.get(d.id) || [];
    const byDesignation = new Map();
    for (const e of deptEmployees) {
      byDesignation.set(e.designation, (byDesignation.get(e.designation) || 0) + 1);
    }
    // A handful of real designations per department carry a small sanctioned
    // surplus above the current filled count, so "open vacancies" is a real,
    // small, non-zero number derived from actual headcount rather than fabricated.
    const designations = [...byDesignation.entries()].slice(0, 5);
    for (const [designation, filled] of designations) {
      const surplus = faker.number.int({ min: 0, max: Math.max(1, Math.round(filled * 0.08)) });
      const criticality = surplus === 0 ? null
        : surplus >= Math.max(2, Math.round(filled * 0.06)) ? "Critical"
        : surplus >= 1 ? "High" : "Moderate";
      const note = criticality
        ? `${surplus} sanctioned post${surplus === 1 ? "" : "s"} vacant against ${filled} filled — ${criticality === "Critical" ? "chronic shortage impacting service delivery" : "recruitment in progress"} for ${designation}.`
        : null;
      rows.push({ department: d.id, designation, sanctioned: filled + surplus, criticality, note });
    }
  }
  return rows;
}

const CANDIDATE_SOURCES = ["Job Portal", "Referral", "Walk-in", "Campus Drive"];
const CANDIDATE_STATUS_WEIGHTED = [
  "Applied", "Applied", "Applied", "Screening", "Screening", "InterviewScheduled",
  "InterviewCompleted", "Rejected", "Rejected", "OfferExtended", "OfferAccepted", "OfferDeclined",
];

// Generates applicant pools for each open (criticality-flagged) vacancy,
// reusing the same Indian first/last name arrays used for buildEmployees()
// so candidate records read consistently with the rest of the seeded data
// instead of dropping in generic faker.person names.
function buildCandidates(vacancyRows, departmentsById) {
  const rows = [];
  let seq = 1;
  for (const v of vacancyRows) {
    if (!v.criticality) continue;
    const applicantCount = v.criticality === "Critical" ? faker.number.int({ min: 4, max: 8 })
      : v.criticality === "High" ? faker.number.int({ min: 2, max: 5 })
      : faker.number.int({ min: 1, max: 3 });
    for (let i = 0; i < applicantCount; i++) {
      const gender = faker.helpers.arrayElement(GENDER_WEIGHTED);
      const first = gender === "Female" ? faker.helpers.arrayElement(FEMALE_FIRST) : faker.helpers.arrayElement(MALE_FIRST);
      const last = faker.helpers.arrayElement(LAST);
      const id = `CAND-${seq}`;
      rows.push({
        id, name: `${first} ${last}`,
        email: `${first.toLowerCase()}.${last.toLowerCase()}${seq}@gmail.com`,
        phone: `+91 ${faker.number.int({ min: 6, max: 9 })}${faker.string.numeric(9)}`,
        department: departmentsById.get(v.department)?.name || v.department,
        designation: v.designation,
        vacancyId: v.id,
        source: faker.helpers.arrayElement(CANDIDATE_SOURCES),
        status: faker.helpers.arrayElement(CANDIDATE_STATUS_WEIGHTED),
        appliedDate: faker.date.past({ years: 1 }).toISOString().slice(0, 10),
        resumeScore: faker.number.int({ min: 45, max: 98 }),
        experienceYears: Math.round(faker.number.float({ min: 0, max: 15 }) * 10) / 10,
        expectedCtc: faker.number.int({ min: 250000, max: 1200000 }),
        aiSummary: null,
      });
      seq++;
    }
  }
  return rows;
}

function buildCandidateInterviews(candidates) {
  const rows = [];
  const roundsByStatus = {
    Screening: ["Screening"],
    InterviewScheduled: ["Screening", "Technical"],
    InterviewCompleted: ["Screening", "Technical", "HR"],
    OfferExtended: ["Screening", "Technical", "HR", "Final"],
    OfferAccepted: ["Screening", "Technical", "HR", "Final"],
    OfferDeclined: ["Screening", "Technical", "HR", "Final"],
    Rejected: ["Screening", "Technical"],
  };
  for (const c of candidates) {
    const rounds = roundsByStatus[c.status] || [];
    rounds.forEach((round, idx) => {
      const isLast = idx === rounds.length - 1;
      const stillPending = c.status === "InterviewScheduled" && isLast;
      rows.push({
        candidateId: c.id, round,
        scheduledAt: faker.date.recent({ days: 60 }).toISOString().slice(0, 10),
        interviewer: `Panel Member, ${c.department}`,
        status: stillPending ? "Scheduled" : "Completed",
        feedback: stillPending ? null : faker.helpers.arrayElement([
          "Strong technical fundamentals, recommend progressing.",
          "Good communication, moderate domain depth.",
          "Below expectations on core competency questions.",
        ]),
        rating: stillPending ? null : Math.round(faker.number.float({ min: 2, max: 5 }) * 10) / 10,
      });
    });
  }
  return rows;
}

function buildOnboardingCases(candidates, employees) {
  const rows = [];
  let seq = 1;
  for (const c of candidates.filter((x) => x.status === "OfferAccepted")) {
    const deptEmployees = employees.filter((e) => e.department === c.department);
    const buddy = deptEmployees.length ? faker.helpers.arrayElement(deptEmployees) : null;
    rows.push({
      id: `ONB-${seq++}`, candidateId: c.id, employeeId: null,
      name: c.name, department: c.department, designation: c.designation,
      startDate: faker.date.soon({ days: 30 }).toISOString().slice(0, 10),
      buddyEmployeeId: buddy?.id || null,
      status: faker.helpers.arrayElement(["NotStarted", "InProgress", "InProgress", "Completed"]),
      progressPct: 0,
    });
  }
  // Employees who joined within the last 90 days (relative to the fixed
  // reference date) get an onboarding case of their own, alongside
  // candidate-sourced cases above, so recently-joined staff show up in the
  // onboarding tracker too.
  const referenceDate = `${NOW_YEAR}-07-14`;
  const recentJoiners = employees.filter((e) => {
    const daysSinceJoin = (Date.parse(referenceDate) - Date.parse(e.doj)) / (1000 * 60 * 60 * 24);
    return daysSinceJoin >= 0 && daysSinceJoin <= 90;
  });
  for (const e of recentJoiners) {
    const peers = employees.filter((p) => p.department === e.department && p.id !== e.id);
    const buddy = peers.length ? faker.helpers.arrayElement(peers) : null;
    rows.push({
      id: `ONB-${seq++}`, candidateId: null, employeeId: e.id,
      name: e.name, department: e.department, designation: e.designation,
      startDate: e.doj, buddyEmployeeId: buddy?.id || null,
      status: faker.helpers.arrayElement(["InProgress", "InProgress", "Completed"]),
      progressPct: 0,
    });
  }
  return rows;
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

// Project name+description templates, grouped by department category so a
// Zoo or Library department gets culture-appropriate projects instead of
// the same civic-infrastructure list every department drew from before.
const PROJECT_TEMPLATES_BY_CATEGORY = {
  Health: [
    { name: "Primary Health Center Upgrade — Ward {w}", description: "Modernizing PHC infrastructure and diagnostic equipment to meet NABH standards." },
    { name: "Dengue & Vector Control Drive", description: "Ward-wise fogging, larvae source reduction, and community awareness campaign." },
    { name: "Maternal & Child Health Digitization", description: "Digitizing Anganwadi and maternal health records for real-time tracking." },
    { name: "Mobile Health Unit Expansion", description: "Deploying additional mobile diagnostic units to underserved wards." },
  ],
  Engineering: [
    { name: "Road Resurfacing — Ward {w}", description: "Resurfacing and pothole rectification across arterial and internal roads." },
    { name: "Smart Water Metering Rollout", description: "Installing IoT-enabled water meters for consumption-based billing." },
    { name: "Storm Water Drainage Upgrade", description: "Widening and desilting storm water drains ahead of monsoon season." },
    { name: "Flyover & Bridge Retrofitting", description: "Structural retrofitting of ageing flyovers per the latest safety audit." },
    { name: "Affordable Housing Site Development", description: "Site infrastructure works for the EWS/LIG affordable housing scheme." },
  ],
  Sanitation: [
    { name: "Solid Waste Segregation Drive", description: "Door-to-door segregation compliance drive across residential wards." },
    { name: "Waste-to-Energy Feasibility Study", description: "Feasibility assessment for a municipal waste-to-energy processing plant." },
    { name: "Garden & Green Belt Restoration", description: "Restoring public gardens and green belts damaged during monsoon." },
  ],
  Safety: [
    { name: "Fire Station Modernization — Zone {w}", description: "Upgrading fire station equipment and response vehicle fleet." },
    { name: "Disaster Response Readiness Drive", description: "Ward-level mock drills and emergency shelter readiness audit." },
    { name: "Fire Hydrant Network Expansion", description: "Expanding the city's fire hydrant coverage in high-risk zones." },
  ],
  CivicAdmin: [
    { name: "E-Governance Portal Upgrade", description: "Modernizing the citizen-facing portal for faster service delivery." },
    { name: "Digital Property Tax Assessment", description: "Rolling out GIS-based property tax assessment to reduce disputes." },
    { name: "CCTV Surveillance Expansion", description: "Expanding CCTV coverage across public spaces and municipal offices." },
    { name: "Grievance Redressal System Upgrade", description: "Upgrading the citizen grievance tracking and escalation system." },
    { name: "Procurement Process Digitization", description: "Digitizing tender and procurement workflows for transparency." },
  ],
  Legal: [
    { name: "Litigation Case Management System Rollout", description: "Deploying a case-tracking system for pending litigation and RTI appeals." },
    { name: "Legal Compliance Audit Framework", description: "Standardizing compliance audit procedures across departments." },
  ],
  Education: [
    { name: "School Infrastructure Upgrade", description: "Classroom, sanitation, and furniture upgrades across municipal schools." },
    { name: "Digital Classroom Initiative", description: "Introducing smart boards and digital learning aids in primary schools." },
    { name: "Mid-Day Meal Kitchen Modernization", description: "Upgrading kitchen hygiene infrastructure at meal-serving schools." },
  ],
  Culture: [
    { name: "Zoo Enclosure Modernization", description: "Rebuilding animal enclosures to modern zoological welfare standards." },
    { name: "Library Digitization Drive", description: "Digitizing the reference collection and rolling out an e-library catalog." },
    { name: "Sports Complex Renovation", description: "Renovating public sports grounds and indoor training facilities." },
    { name: "Riverfront Cultural Space Development", description: "Developing public cultural and recreational space along the riverfront." },
  ],
};
const PROJECT_STATUS_WEIGHTED = ["On Track", "On Track", "On Track", "At Risk", "Delayed", "Completed"];

function buildProjects(employeesByDept) {
  const rows = [];
  let seq = 1;
  for (const d of DEPARTMENTS) {
    const deptEmployees = employeesByDept.get(d.id) || [];
    const numProjects = faker.number.int({ min: 2, max: 4 });
    const pool = PROJECT_TEMPLATES_BY_CATEGORY[DEPT_CATEGORY[d.id]] || PROJECT_TEMPLATES_BY_CATEGORY.CivicAdmin;
    const templates = faker.helpers.arrayElements(pool, Math.min(numProjects, pool.length));
    for (const template of templates) {
      const name = template.name.replace("{w}", String(faker.number.int({ min: 1, max: 12 })));
      const status = faker.helpers.arrayElement(PROJECT_STATUS_WEIGHTED);
      const progressPct = status === "Completed" ? 100
        : status === "Delayed" ? faker.number.int({ min: 15, max: 45 })
        : status === "At Risk" ? faker.number.int({ min: 30, max: 60 })
        : faker.number.int({ min: 40, max: 90 });
      const startMonthsAgo = faker.number.int({ min: 2, max: 18 });
      const start = new Date();
      start.setMonth(start.getMonth() - startMonthsAgo);
      const target = new Date(start);
      target.setMonth(target.getMonth() + faker.number.int({ min: 6, max: 24 }));
      const pad = (n) => String(n).padStart(2, "0");
      const fmt = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
      rows.push({
        id: `PRJ-${String(seq++).padStart(4, "0")}`,
        department: d.id,
        name,
        status,
        progressPct,
        startDate: fmt(start),
        targetDate: fmt(target),
        budgetCr: Math.round(faker.number.float({ min: 0.5, max: 25 }) * 10) / 10,
        leadEmployeeId: deptEmployees.length ? faker.helpers.arrayElement(deptEmployees).id : null,
        description: template.description,
      });
    }
  }
  return rows;
}

const LEGAL_CASE_TEMPLATES = [
  {
    type: "RTI Appeal", court: "RTI Appellate Authority", numberPrefix: "RTI", exposureRange: [0, 2],
    titles: [
      "Delay in furnishing information on tender documents",
      "Appeal against denial of file inspection request",
      "Second appeal on incomplete disclosure of survey records",
      "Appeal against denial of information on demolition notices",
      "Second appeal on non-disclosure of contractor payment records",
      "Appeal seeking inspection of building permission file",
    ],
  },
  {
    type: "Labour Dispute", court: "Labour Court Ahmedabad", numberPrefix: "REF", exposureRange: [5, 40],
    titles: [
      "Contract worker regularization demand",
      "Termination dispute — daily wage sanitation staff",
      "Wage parity claim by contractual drivers",
      "Reinstatement claim — retrenched conservancy worker",
      "Bonus and overtime dues claim by outsourced staff",
      "Unfair labour practice complaint — outsourcing agency",
    ],
  },
  {
    type: "Land Acquisition", court: "Gujarat High Court", numberPrefix: "SCA", exposureRange: [50, 400],
    titles: [
      "Compensation dispute — road widening acquisition",
      "Encroachment removal stay petition",
      "Enhanced compensation claim for TP scheme land",
      "Challenge to award under Town Planning Scheme finalisation",
      "Compensation dispute — reservoir expansion acquisition",
    ],
  },
  {
    type: "Contractor Dispute", court: "City Civil Court", numberPrefix: "RCS", exposureRange: [20, 150],
    titles: [
      "Payment dispute — road resurfacing contractor",
      "Blacklisting challenge by solid waste vendor",
      "Liquidated damages dispute on delayed project",
      "Arbitration claim — stormwater drainage works contractor",
      "Extra items payment dispute — bridge construction contractor",
    ],
  },
  {
    type: "Service Matter", court: "Gujarat High Court", numberPrefix: "SCA", exposureRange: [2, 20],
    titles: [
      "Seniority dispute in promotion to Class I",
      "Compassionate appointment denial challenge",
      "Pension recalculation appeal",
      "Departmental inquiry challenge — suspension order",
      "Denial of promotional pay scale benefit",
    ],
  },
  {
    type: "Public Interest Litigation", court: "Gujarat High Court", numberPrefix: "SCA", exposureRange: [10, 100],
    titles: [
      "PIL on inadequate solid waste processing capacity",
      "PIL on encroachment on storm water drains",
      "PIL seeking action on illegal construction",
      "PIL on delay in sewage treatment plant commissioning",
      "PIL on air quality non-compliance near industrial zone",
    ],
  },
  {
    type: "Property Tax Dispute", court: "City Civil Court", numberPrefix: "RCS", exposureRange: [1, 25],
    titles: [
      "Challenge to enhanced property tax assessment",
      "Dispute over occupancy classification for tax rebate",
      "Appeal against penalty on retrospective tax demand",
      "Exemption claim challenge — charitable trust property",
      "Dispute over annual rateable value revision",
    ],
  },
  {
    type: "Encroachment & Demolition", court: "Gujarat High Court", numberPrefix: "SCA", exposureRange: [5, 60],
    titles: [
      "Stay against demolition notice for unauthorized construction",
      "Challenge to footpath encroachment removal drive",
      "Petition against sealing of commercial premises",
      "Stay against removal of religious structure encroachment",
      "Challenge to notice for removal of unauthorized hoarding",
    ],
  },
];
const LEGAL_STATUS_WEIGHTED = ["Pending", "Hearing Scheduled", "Hearing Scheduled", "Stayed", "Disposed - Favorable", "Disposed - Favorable", "Disposed - Unfavorable"];

function buildLegalCases() {
  const rows = [];
  let seq = 2401;
  const today = new Date();
  const count = 34;
  // Avoid repeating the same title twice within a template run, so a larger
  // docket still reads as distinct cases rather than obvious duplicates.
  const usedTitles = new Map();
  for (let i = 0; i < count; i++) {
    const tmpl = faker.helpers.arrayElement(LEGAL_CASE_TEMPLATES);
    // Larger departments realistically generate more litigation/disputes —
    // weight department selection by headcount instead of picking uniformly.
    const dept = weightedPick(DEPARTMENTS, (d) => d.weight);
    const status = faker.helpers.arrayElement(LEGAL_STATUS_WEIGHTED);
    const daysAgo = faker.number.int({ min: 20, max: 720 });
    const filedDate = new Date(today.getTime() - daysAgo * 24 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const fmt = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    const isOpen = status === "Pending" || status === "Hearing Scheduled" || status === "Stayed";
    let nextHearing = null;
    if (isOpen) {
      const hearingDays = faker.number.int({ min: 5, max: 60 });
      nextHearing = fmt(new Date(today.getTime() + hearingDays * 24 * 60 * 60 * 1000));
    }
    const [minExp, maxExp] = tmpl.exposureRange;

    const seen = usedTitles.get(tmpl.type) ?? new Set();
    const available = tmpl.titles.filter((t) => !seen.has(t));
    const title = faker.helpers.arrayElement(available.length ? available : tmpl.titles);
    seen.add(title);
    usedTitles.set(tmpl.type, seen);

    const filedYear = NOW_YEAR - Math.floor(daysAgo / 365);
    const caseNumber = `${tmpl.numberPrefix}/${filedYear}/${faker.number.int({ min: 100, max: 9999 })}`;

    const aiSummary = status === "Disposed - Favorable"
      ? `${tmpl.type} filed against ${dept.name} — disposed in the Corporation's favour, no further liability.`
      : status === "Disposed - Unfavorable"
        ? `${tmpl.type} filed against ${dept.name} — disposed against the Corporation; compliance/payout action required.`
        : status === "Stayed"
          ? `${tmpl.type} filed against ${dept.name} — proceedings currently stayed pending further orders.`
          : `${tmpl.type} filed against ${dept.name} — ${status.toLowerCase()}${nextHearing ? `, next hearing ${nextHearing}` : ""}.`;

    rows.push({
      id: `LGL-${seq++}`,
      caseNumber,
      type: tmpl.type,
      title,
      department: dept.name,
      court: tmpl.court,
      filedDate: fmt(filedDate),
      status,
      nextHearing,
      exposureLakh: faker.number.int({ min: minExp, max: maxExp }),
      aiSummary,
    });
  }
  return rows;
}

const EMERGENCY_TEMPLATES = [
  { category: "Fire", severity: "Critical", depts: ["FIRE"], titles: ["Warehouse fire near industrial estate", "Electrical short-circuit fire in market complex", "Fire outbreak at municipal solid waste yard"] },
  { category: "Flood/Waterlogging", severity: "High", depts: ["DRAIN", "WATER"], titles: ["Severe waterlogging blocking arterial road", "Stormwater drain overflow flooding residential society", "Pumping station failure during heavy rainfall"] },
  { category: "Structural Failure", severity: "Critical", depts: ["ENGG", "PLAN"], titles: ["Partial collapse of old municipal building", "Bridge structural crack reported by residents", "Compound wall collapse near school premises"] },
  { category: "Public Health Hazard", severity: "High", depts: ["HEALTH", "SWM"], titles: ["Suspected dengue outbreak cluster reported", "Contaminated water supply complaint in ward", "Uncollected garbage causing health hazard"] },
  { category: "Electrical Hazard", severity: "High", depts: ["ENGG"], titles: ["Live wire hanging over public road", "Streetlight pole electrocution risk reported", "Transformer sparking near residential area"] },
  { category: "Road/Traffic Hazard", severity: "Medium", depts: ["ENGG", "PLAN"], titles: ["Large pothole causing accidents on highway", "Road cave-in near construction site", "Missing manhole cover reported as hazard"] },
];
const EMERGENCY_STATUS_WEIGHTED = ["Open", "Open", "Acknowledged", "Acknowledged", "Escalated", "Resolved", "Resolved", "Resolved"];

function buildEmergencyAlerts() {
  const rows = [];
  let seq = 5001;
  const today = new Date();
  const count = 18;
  for (let i = 0; i < count; i++) {
    const tmpl = faker.helpers.arrayElement(EMERGENCY_TEMPLATES);
    const deptId = faker.helpers.arrayElement(tmpl.depts);
    const dept = DEPARTMENTS.find((d) => d.id === deptId) || weightedPick(DEPARTMENTS, (d) => d.weight);
    const status = faker.helpers.arrayElement(EMERGENCY_STATUS_WEIGHTED);
    const hoursAgo = faker.number.int({ min: 1, max: 720 });
    const createdAt = new Date(today.getTime() - hoursAgo * 60 * 60 * 1000);
    rows.push({
      id: `EMG-${seq++}`,
      category: tmpl.category,
      title: faker.helpers.arrayElement(tmpl.titles),
      description: `${tmpl.category} incident reported in ${dept.name} jurisdiction — requires immediate attention from the concerned area officer.`,
      department: dept.name,
      location: faker.helpers.arrayElement(POSTINGS),
      severity: tmpl.severity,
      status,
      createdAt,
      acknowledgedAt: status !== "Open" ? new Date(createdAt.getTime() + faker.number.int({ min: 15, max: 180 }) * 60 * 1000) : null,
      resolvedAt: status === "Resolved" ? new Date(createdAt.getTime() + faker.number.int({ min: 2, max: 48 }) * 60 * 60 * 1000) : null,
    });
  }
  return rows;
}

const GRIEVANCE_TEMPLATES = [
  { category: "Harassment", severity: "Critical", sentiment: "Anxious", subject: "Inappropriate comments from supervisor", description: "Reported repeated inappropriate comments regarding personal life during team meetings." },
  { category: "Harassment", severity: "High", sentiment: "Hostile", subject: "Hostile work environment complaint", description: "Colleague has been making demeaning remarks in front of the team on multiple occasions." },
  { category: "Payroll", severity: "Medium", sentiment: "Frustrated", subject: "Overtime not credited", description: "Approved overtime hours were missing from the last pay cycle." },
  { category: "Payroll", severity: "High", sentiment: "Anxious", subject: "Tax deduction error", description: "Incorrect tax slab applied resulting in lower take-home pay for two consecutive months." },
  { category: "Facilities", severity: "Low", sentiment: "Frustrated", subject: "AC broken in office wing", description: "HVAC system has been malfunctioning for weeks despite multiple maintenance tickets." },
  { category: "Facilities", severity: "Low", sentiment: "Neutral", subject: "Washroom cleanliness concern", description: "Washroom on the third floor is not being cleaned per the daily schedule." },
  { category: "Management", severity: "High", sentiment: "Hostile", subject: "Unfair appraisal ratings", description: "Alleges that recent performance reviews were biased and did not reflect actual metrics." },
  { category: "Management", severity: "Medium", sentiment: "Frustrated", subject: "Denied leave without explanation", description: "Leave request was rejected without any stated reason despite adequate balance." },
  { category: "PeerConflict", severity: "Medium", sentiment: "Frustrated", subject: "Credit stolen for project work", description: "Claims a colleague presented their work to leadership without attribution." },
  { category: "PeerConflict", severity: "Low", sentiment: "Neutral", subject: "Ongoing disagreement over task ownership", description: "Two team members repeatedly disagree over who owns a recurring task." },
];

function buildGrievances(employees, count) {
  const rows = [];
  const today = new Date();
  for (let i = 0; i < count; i++) {
    const emp = faker.helpers.arrayElement(employees);
    const tmpl = faker.helpers.arrayElement(GRIEVANCE_TEMPLATES);
    const isAnonymous = faker.datatype.boolean(0.3);
    const daysAgo = faker.number.int({ min: 1, max: 180 });
    const createdAt = new Date(today.getTime() - daysAgo * 24 * 60 * 60 * 1000);
    // Older grievances are more likely to have been worked through to resolution.
    const status = tmpl.severity === "Critical" ? "Escalated"
      : daysAgo > 120 ? faker.helpers.arrayElement(["Resolved", "Resolved", "Escalated"])
      : daysAgo > 45 ? faker.helpers.arrayElement(["Resolved", "UnderInvestigation", "Escalated"])
      : faker.helpers.arrayElement(["New", "New", "UnderInvestigation"]);

    rows.push({
      id: `GRV-${1000 + i}`,
      category: tmpl.category,
      submitterId: isAnonymous ? null : emp.id,
      isAnonymous,
      department: emp.department,
      subject: tmpl.subject,
      description: tmpl.description,
      aiSummary: tmpl.description,
      severity: tmpl.severity,
      sentiment: tmpl.sentiment,
      status,
      createdAt,
    });
  }
  return rows;
}

function buildGrievanceUpdates(grievances) {
  const rows = [];
  for (const g of grievances) {
    if (g.status === "New") continue;
    rows.push({
      grievanceId: g.id,
      status: g.status === "Resolved" ? "UnderInvestigation" : g.status,
      note: g.status === "Resolved" ? "Investigation completed; corrective action taken with the concerned parties." : "Escalated to department head for immediate review.",
      createdBy: "Meera Trivedi",
      createdAt: new Date(new Date(g.createdAt).getTime() + 3 * 24 * 60 * 60 * 1000),
    });
    if (g.status === "Resolved") {
      rows.push({
        grievanceId: g.id,
        status: "Resolved",
        note: "Grievance resolved and communicated to the submitter.",
        createdBy: "Meera Trivedi",
        createdAt: new Date(new Date(g.createdAt).getTime() + 9 * 24 * 60 * 60 * 1000),
      });
    }
  }
  return rows;
}

const LEAVE_TYPES = [
  { type: "Casual Leave", entitled: 12 },
  { type: "Earned Leave", entitled: 30 },
  { type: "Medical Leave", entitled: 15 },
];

function buildLeaveBalances(employees) {
  const rows = [];
  for (const e of employees) {
    for (const lt of LEAVE_TYPES) {
      const availed = faker.number.int({ min: 0, max: lt.entitled });
      rows.push({
        employeeId: e.id, leaveType: lt.type, year: NOW_YEAR,
        entitled: lt.entitled, availed, balance: lt.entitled - availed,
      });
    }
  }
  return rows;
}

const LEAVE_REQUEST_REASONS = {
  "Casual Leave": ["Family function", "Personal work", "Urgent household matter", "Attending a wedding"],
  "Earned Leave": ["Family vacation", "Native place visit", "Personal travel", "Child's school function"],
  "Medical Leave": ["Fever and viral infection", "Scheduled medical procedure", "Doctor's appointment", "Recovering from surgery"],
};

// Real apply→review→decide leave requests, so the HR admin Leave module has
// a genuine mixed backlog to act on instead of an empty queue — some already
// cleared by the employee's manager and awaiting HR's final call, some still
// with the manager, and a larger set of historical decided requests (mostly
// approved, a few rejected at either stage) so the per-employee history/
// balance panel in the HR queue has real prior requests to show.
function buildLeaveRequests(employees, managerAssignments, leaveBalanceRows, count = 70) {
  const managerByEmployee = new Map(managerAssignments.map((a) => [a.id, a.managerId]));
  const balanceByKey = new Map(leaveBalanceRows.map((b) => [`${b.employeeId}::${b.leaveType}`, b]));
  const today = new Date();
  const day = 24 * 60 * 60 * 1000;
  const toDateStr = (d) => d.toISOString().slice(0, 10);

  const pool = faker.helpers.arrayElements(employees, Math.min(count, employees.length));
  const rows = [];
  let seq = 0;

  for (const emp of pool) {
    const lt = faker.helpers.arrayElement(LEAVE_TYPES);
    const balance = balanceByKey.get(`${emp.id}::${lt.type}`);
    if (!balance || balance.balance < 1) continue;

    const days = faker.number.int({ min: 1, max: Math.min(4, balance.balance) });
    const managerId = managerByEmployee.get(emp.id) || null;
    const reason = faker.helpers.arrayElement(LEAVE_REQUEST_REASONS[lt.type]);
    seq += 1;
    const id = `LR-${1000 + seq}`;
    const roll = faker.number.float({ min: 0, max: 1 });

    if (roll < 0.30) {
      // Actionable now: manager already cleared it (or none required); HR
      // hasn't decided yet — this is the demo-visible pending queue.
      const appliedAt = new Date(today.getTime() - faker.number.int({ min: 1, max: 12 }) * day);
      const fromDate = new Date(appliedAt.getTime() + faker.number.int({ min: 2, max: 15 }) * day);
      const toDate = new Date(fromDate.getTime() + (days - 1) * day);
      rows.push({
        id, employeeId: emp.id, leaveType: lt.type, days, reason,
        fromDate: toDateStr(fromDate), toDate: toDateStr(toDate),
        status: "Pending", appliedAt,
        managerId, managerStatus: managerId ? "Approved" : "NotRequired",
        managerDecidedAt: managerId ? new Date(Math.min(appliedAt.getTime() + faker.number.int({ min: 1, max: 3 }) * day, today.getTime())) : null,
        managerNote: managerId ? "Approved — team coverage confirmed." : null,
      });
    } else if (roll < 0.40) {
      // Still with the manager — not yet in the HR queue.
      const appliedAt = new Date(today.getTime() - faker.number.int({ min: 0, max: 5 }) * day);
      const fromDate = new Date(appliedAt.getTime() + faker.number.int({ min: 3, max: 20 }) * day);
      const toDate = new Date(fromDate.getTime() + (days - 1) * day);
      rows.push({
        id, employeeId: emp.id, leaveType: lt.type, days, reason,
        fromDate: toDateStr(fromDate), toDate: toDateStr(toDate),
        status: "Pending", appliedAt,
        managerId, managerStatus: managerId ? "Pending" : "NotRequired",
      });
    } else {
      // Historical, already decided — mostly approved, a minority rejected
      // at either the manager or HR stage.
      const appliedAt = new Date(today.getTime() - faker.number.int({ min: 20, max: 200 }) * day);
      const fromDate = new Date(appliedAt.getTime() + faker.number.int({ min: 2, max: 10 }) * day);
      const toDate = new Date(fromDate.getTime() + (days - 1) * day);
      const rejectedAtManager = !!managerId && faker.datatype.boolean(0.15);
      const managerDecidedAt = managerId ? new Date(appliedAt.getTime() + faker.number.int({ min: 1, max: 4 }) * day) : null;
      const finalStatus = rejectedAtManager ? "Rejected" : faker.helpers.arrayElement(["Approved", "Approved", "Approved", "Rejected"]);
      const decidedAt = rejectedAtManager ? managerDecidedAt : new Date((managerDecidedAt ?? appliedAt).getTime() + faker.number.int({ min: 1, max: 5 }) * day);

      rows.push({
        id, employeeId: emp.id, leaveType: lt.type, days, reason,
        fromDate: toDateStr(fromDate), toDate: toDateStr(toDate),
        status: finalStatus, appliedAt,
        managerId,
        managerStatus: rejectedAtManager ? "Rejected" : (managerId ? "Approved" : "NotRequired"),
        managerDecidedAt,
        managerNote: managerId
          ? (rejectedAtManager ? "Rejected — critical project deadline, cannot spare during this period." : "Approved — team coverage confirmed.")
          : null,
        decidedBy: rejectedAtManager ? null : "hr.admin@amc.gov.in",
        decidedAt,
        decisionNote: rejectedAtManager
          ? null
          : (finalStatus === "Approved" ? "Approved — balance and coverage verified." : "Rejected — insufficient justification on file."),
      });
    }
  }
  return rows;
}

const INSURANCE_PROVIDERS = ["New India Assurance", "United India Insurance", "National Insurance Co."];

function buildInsurance(employees) {
  const rows = [];
  let seq = 1;
  for (const e of employees) {
    if (faker.number.float({ min: 0, max: 1 }) > 0.9) continue; // ~90% of employees are covered
    const sumInsured = faker.helpers.arrayElement([300000, 500000, 1000000]);
    rows.push({
      employeeId: e.id,
      provider: faker.helpers.arrayElement(INSURANCE_PROVIDERS),
      policyNumber: `POL-${String(seq++).padStart(6, "0")}`,
      sumInsured,
      premium: Math.round(sumInsured * 0.015),
      validTill: `${NOW_YEAR + 1}-03-31`,
    });
  }
  return rows;
}

const SERVICE_BOOK_DOCS = [
  { id: "DOC-1001", emp: "AMC-10042", type: "Promotion Order", date: "2024-03-12", ocr: 98.4, status: "Verified" },
  { id: "DOC-1002", emp: "AMC-10076", type: "Transfer Order", date: "2023-11-09", ocr: 95.1, status: "Verified" },
  { id: "DOC-1003", emp: "AMC-10110", type: "Appointment Order", date: "2012-06-21", ocr: 92.8, status: "PendingReview" },
  { id: "DOC-1004", emp: "AMC-10042", type: "Joining Report", date: "—", ocr: 0, status: "Missing" },
  { id: "DOC-1005", emp: "AMC-10189", type: "Increment Order", date: "2025-01-04", ocr: 99.1, status: "Verified" },
  { id: "DOC-1006", emp: "AMC-10076", type: "Relieving Order", date: "—", ocr: 0, status: "Missing" },
  { id: "DOC-1007", emp: "AMC-10211", type: "Disciplinary Order", date: "2022-08-15", ocr: 88.7, status: "Verified" },
  { id: "DOC-1008", emp: "AMC-10165", type: "Pension Order", date: "2024-12-30", ocr: 96.5, status: "Verified" },
];

// Real statutory wage threshold under which ESIC applies (employee's share).
const ESIC_WAGE_THRESHOLD = 21000;
const ESIC_EMPLOYEE_SHARE = 0.0075;
const PF_EMPLOYEE_SHARE = 0.12;
const GRATUITY_MIN_TENURE_YEARS = 5;

// Illustrative monthly TDS bracket by cadre (only Class I/II typically cross
// the real exemption limits) — for demo purposes, not a real tax computation.
const TDS_BRACKET_BY_CADRE = { "Class I": 8000, "Class II": 2500, "Class III": 0, "Class IV": 0 };

function buildStatutoryCompliance(employees, compensationRows) {
  const compByEmployeeId = new Map(compensationRows.map((c) => [c.employeeId, c]));
  const rows = [];
  let pfSeq = 1, esicSeq = 1, cghsSeq = 1;
  for (const e of employees) {
    const comp = compByEmployeeId.get(e.id);
    if (!comp) continue;
    const tenureYears = NOW_YEAR - Number(e.doj.slice(0, 4));
    const esicApplicable = comp.grossPay <= ESIC_WAGE_THRESHOLD;
    rows.push({
      employeeId: e.id,
      pfNumber: `PF-${String(pfSeq++).padStart(7, "0")}`,
      pfMonthlyContribution: Math.round(comp.basicPay * PF_EMPLOYEE_SHARE),
      esicApplicable,
      esicNumber: esicApplicable ? `ESIC-${String(esicSeq++).padStart(7, "0")}` : null,
      esicMonthlyContribution: esicApplicable ? Math.round(comp.grossPay * ESIC_EMPLOYEE_SHARE) : null,
      cghsNumber: faker.datatype.boolean(0.6) ? `CGHS-${String(cghsSeq++).padStart(6, "0")}` : null,
      gratuityEligible: tenureYears >= GRATUITY_MIN_TENURE_YEARS,
      gratuityAccrued: tenureYears >= GRATUITY_MIN_TENURE_YEARS
        ? Math.round((comp.basicPay / 26) * 15 * tenureYears)
        : 0,
      tdsMonthlyDeduction: TDS_BRACKET_BY_CADRE[e.cadre] || 0,
      // No gender field exists on Employee, so eligibility can't be scoped
      // realistically — seeded as a small illustrative subset instead.
      maternityBenefitStatus: faker.number.float({ min: 0, max: 1 }) < 0.04
        ? faker.helpers.arrayElement(["Eligible", "Availed"])
        : "Not Applicable",
    });
  }
  return rows;
}

const HOLIDAYS = [
  { date: `${NOW_YEAR}-01-26`, name: "Republic Day", type: "Public" },
  { date: `${NOW_YEAR}-03-14`, name: "Holi", type: "Public" },
  { date: `${NOW_YEAR}-03-30`, name: "Gudi Padwa", type: "Restricted" },
  { date: `${NOW_YEAR}-04-14`, name: "Dr. Ambedkar Jayanti", type: "Public" },
  { date: `${NOW_YEAR}-05-01`, name: "Maharashtra/Gujarat Day", type: "Public" },
  { date: `${NOW_YEAR}-08-15`, name: "Independence Day", type: "Public" },
  { date: `${NOW_YEAR}-08-19`, name: "Raksha Bandhan", type: "Restricted" },
  { date: `${NOW_YEAR}-08-27`, name: "Janmashtami", type: "Public" },
  { date: `${NOW_YEAR}-10-02`, name: "Gandhi Jayanti", type: "Public" },
  { date: `${NOW_YEAR}-10-21`, name: "Dussehra", type: "Public" },
  { date: `${NOW_YEAR}-11-09`, name: "Diwali", type: "Public" },
  { date: `${NOW_YEAR}-11-10`, name: "Diwali (New Year)", type: "Public" },
  { date: `${NOW_YEAR}-11-11`, name: "Bhai Beej", type: "Restricted" },
  { date: `${NOW_YEAR}-12-25`, name: "Christmas", type: "Public" },
];

const LEAVE_RULES = [
  { leaveType: "Casual Leave", entitledDaysPerYear: 12, carryForwardAllowed: false, maxCarryForward: 0, eligibilityNote: "Available from date of joining; lapses at year end.", minNoticeDays: 2 },
  { leaveType: "Earned Leave", entitledDaysPerYear: 30, carryForwardAllowed: true, maxCarryForward: 300, eligibilityNote: "Accrues monthly; encashable on retirement up to statutory limit.", minNoticeDays: 7 },
  { leaveType: "Medical Leave", entitledDaysPerYear: 15, carryForwardAllowed: true, maxCarryForward: 45, eligibilityNote: "Requires medical certificate for absences beyond 2 consecutive days.", minNoticeDays: 0 },
];

// Windows during which leave cannot be applied for — department: null means
// org-wide. Dates land in the current seed year so they're immediately
// exercisable against "today" during manual verification.
const LEAVE_BLACKOUTS = [
  { fromDate: `${NOW_YEAR}-06-01`, toDate: `${NOW_YEAR}-09-30`, department: "Drainage", reason: "Monsoon duty freeze — Drainage on standby through the monsoon season." },
  { fromDate: `${NOW_YEAR}-06-01`, toDate: `${NOW_YEAR}-09-30`, department: "Solid Waste Management", reason: "Monsoon duty freeze — SWM on standby through the monsoon season." },
  { fromDate: `${NOW_YEAR}-11-08`, toDate: `${NOW_YEAR}-11-12`, department: null, reason: "Diwali festival period — organisation-wide leave freeze." },
];

const STATUTORY_DEADLINES = [
  { title: "PF Monthly Return (ECR)", category: "PF", recurrence: "Monthly", dueDayOfMonth: 15, dueDate: null },
  { title: "ESIC Monthly Contribution", category: "ESIC", recurrence: "Monthly", dueDayOfMonth: 21, dueDate: null },
  { title: "TDS Deposit (Form 24Q)", category: "TDS", recurrence: "Monthly", dueDayOfMonth: 7, dueDate: null },
  { title: "Professional Tax Filing", category: "Professional Tax", recurrence: "Monthly", dueDayOfMonth: 15, dueDate: null },
  { title: "Gratuity Reconciliation", category: "Gratuity", recurrence: "Annual", dueDayOfMonth: null, dueDate: "03-31" },
  { title: "Annual Statutory Compliance Audit", category: "Audit", recurrence: "Annual", dueDayOfMonth: null, dueDate: "06-30" },
];

async function batchCreateMany(label, model, rows, batchSize = 1000) {
  console.log(`Seeding ${rows.length} ${label}...`);
  for (let i = 0; i < rows.length; i += batchSize) {
    await model.createMany({ data: rows.slice(i, i + batchSize), skipDuplicates: true });
  }
}

async function main() {
  console.log('Clearing existing data...');
  await prisma.emergencyAlertUpdate.deleteMany();
  await prisma.emergencyAlert.deleteMany();
  await prisma.legalCase.deleteMany();
  await prisma.project.deleteMany();
  await prisma.onboardingTask.deleteMany();
  await prisma.onboardingCase.deleteMany();
  await prisma.candidateInterview.deleteMany();
  await prisma.candidate.deleteMany();
  await prisma.vacancy.deleteMany();
  await prisma.departmentProfile.deleteMany();
  await prisma.statutoryCompliance.deleteMany();
  await prisma.holidayCalendar.deleteMany();
  await prisma.leaveRule.deleteMany();
  await prisma.leaveBlackout.deleteMany();
  await prisma.leaveRequest.deleteMany();
  await prisma.statutoryDeadline.deleteMany();
  await prisma.grievanceUpdate.deleteMany();
  await prisma.grievance.deleteMany();
  await prisma.leaveBalance.deleteMany();
  await prisma.insurance.deleteMany();
  await prisma.privacyRequest.deleteMany();
  await prisma.user.updateMany({ data: { employeeId: null } });
  await prisma.attendanceSummary.deleteMany();
  await prisma.employeeSkill.deleteMany();
  await prisma.trainingRecord.deleteMany();
  await prisma.performanceRecord.deleteMany();
  await prisma.compensation.deleteMany();
  await prisma.serviceBookEntry.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.employeeEvent.deleteMany();
  await prisma.taskMonthlySnapshot.deleteMany();
  await prisma.task.deleteMany();
  await prisma.personalEvent.deleteMany().catch(() => {});
  await prisma.perk.deleteMany().catch(() => {});
  await prisma.educationRecord.deleteMany().catch(() => {});
  await prisma.workExperience.deleteMany().catch(() => {});
  await prisma.$executeRawUnsafe('UPDATE employees SET "managerId" = NULL');
  await prisma.employee.deleteMany();
  await prisma.department.deleteMany();
  await prisma.payrollSummary.deleteMany();
  await prisma.workforceSnapshot.deleteMany();
  await prisma.departmentFinance.deleteMany();
  await prisma.expense.deleteMany();

  console.log(`Seeding ${DEPARTMENTS.length} departments...`);
  await prisma.department.createMany({
    data: DEPARTMENTS.map((d) => ({ id: d.id, name: d.name })),
  });

  const { employees, managerAssignments, deptHeadId } = buildEmployees();
  markFlagshipEmployees(employees);

  // Attendance rows are computed (pure in-memory, no DB write yet) BEFORE
  // performance/flags, so each employee's real attendance rate can feed the
  // "trouble score" that drives promotionDue/disciplinaryFlag/etc — instead
  // of those flags being independent of the employee's actual record.
  const attendanceSeedRows = buildAttendance(employees);
  const attendanceRateByEmployee = new Map();
  for (const r of attendanceSeedRows) {
    const prev = attendanceRateByEmployee.get(r.employeeId) || { present: 0, total: 0 };
    prev.present += r.presentDays;
    prev.total += r.totalDays;
    attendanceRateByEmployee.set(r.employeeId, prev);
  }
  for (const [id, { present, total }] of attendanceRateByEmployee) {
    attendanceRateByEmployee.set(id, total ? present / total : 0.9);
  }

  // Mutates each employee's flags in place and returns the PerformanceRecord
  // rows — must run before employees are persisted so the finalized flags
  // (not the unset placeholders from buildEmployees) are what gets inserted.
  const performanceRows = buildPerformanceAndFlags(employees, attendanceRateByEmployee);

  await batchCreateMany('employees', prisma.employee, employees);

  console.log(`Assigning ${managerAssignments.length} manager relationships...`);
  for (let i = 0; i < managerAssignments.length; i += 2000) {
    const chunk = managerAssignments.slice(i, i + 2000);
    const ids = chunk.map((c) => c.id);
    const managerIds = chunk.map((c) => c.managerId);
    await prisma.$executeRaw`
      UPDATE employees e SET "managerId" = m.manager_id
      FROM unnest(${ids}::text[], ${managerIds}::text[]) AS m(id, manager_id)
      WHERE e.id = m.id
    `;
  }

  const compensationRows = buildCompensation(employees);
  await batchCreateMany('compensation records', prisma.compensation, compensationRows);
  await batchCreateMany('performance records', prisma.performanceRecord, performanceRows);
  await batchCreateMany('training records', prisma.trainingRecord, buildTraining(employees));
  await batchCreateMany('employee skills', prisma.employeeSkill, buildSkills(employees));
  await batchCreateMany('attendance summaries', prisma.attendanceSummary, attendanceSeedRows);

  const tasks = buildTasks(employees, 6000);
  await batchCreateMany('tasks', prisma.task, tasks);
  await batchCreateMany('task monthly snapshots', prisma.taskMonthlySnapshot, buildTaskMonthlySnapshots(employees));

  console.log(`Seeding ${SERVICE_BOOK_DOCS.length} service book entries...`);
  for (const d of SERVICE_BOOK_DOCS) {
    await prisma.serviceBookEntry.create({
      data: { id: d.id, employeeId: d.emp, type: d.type, date: d.date, ocrScore: d.ocr, status: d.status },
    });
  }
  await batchCreateMany('career history entries', prisma.serviceBookEntry, buildCareerHistory(employees));

  await batchCreateMany('employee assets', prisma.asset, buildAssets(employees));
  await batchCreateMany('employee events', prisma.employeeEvent, buildEmployeeEvents(employees));
  const leaveBalanceRows = buildLeaveBalances(employees);
  await batchCreateMany('leave balances', prisma.leaveBalance, leaveBalanceRows);
  await batchCreateMany('leave requests', prisma.leaveRequest, buildLeaveRequests(employees, managerAssignments, leaveBalanceRows));
  await batchCreateMany('insurance policies', prisma.insurance, buildInsurance(employees));

  const grievances = buildGrievances(employees, 90);
  await batchCreateMany('grievances', prisma.grievance, grievances);
  await batchCreateMany('grievance updates', prisma.grievanceUpdate, buildGrievanceUpdates(grievances));

  await batchCreateMany('statutory compliance records', prisma.statutoryCompliance, buildStatutoryCompliance(employees, compensationRows));
  await batchCreateMany('holidays', prisma.holidayCalendar, HOLIDAYS);
  await batchCreateMany('leave rules', prisma.leaveRule, LEAVE_RULES);
  await batchCreateMany('leave blackouts', prisma.leaveBlackout, LEAVE_BLACKOUTS);
  await batchCreateMany('statutory deadlines', prisma.statutoryDeadline, STATUTORY_DEADLINES);

  console.log('Computing workforce snapshot from generated data...');
  const attendanceRows = await prisma.attendanceSummary.groupBy({
    by: ['employeeId'],
    _avg: { presentDays: true, totalDays: true },
  });
  const attendanceByEmployee = new Map(attendanceRows.map((r) => [r.employeeId, r._avg]));

  const snapshotRows = DEPARTMENTS.map((d) => {
    const deptEmployees = employees.filter((e) => e.departmentId === d.id);
    const count = deptEmployees.length;
    const vacancies = Math.round(count * faker.number.float({ min: 0.01, max: 0.05 }));
    let attendanceSum = 0;
    let attendanceN = 0;
    for (const e of deptEmployees) {
      const avg = attendanceByEmployee.get(e.id);
      if (avg?.presentDays && avg?.totalDays) {
        attendanceSum += (avg.presentDays / avg.totalDays) * 100;
        attendanceN += 1;
      }
    }
    const attendance = attendanceN ? Math.round((attendanceSum / attendanceN) * 10) / 10 : 0;
    return { dept: d.id, fullName: d.name, count, attendance, vacancies };
  });
  await prisma.workforceSnapshot.createMany({ data: snapshotRows });

  console.log('Computing payroll summary from generated compensation...');
  const grossAgg = await prisma.compensation.aggregate({ _sum: { grossPay: true } });
  const totalDisbursementCr = ((grossAgg._sum.grossPay || 0) / 1e7).toFixed(1);
  await prisma.payrollSummary.create({
    data: {
      totalDisbursement: `₹${totalDisbursementCr} Cr`,
      processedEmployees: employees.length,
      pendingApprovals: faker.number.int({ min: 20, max: 80 }),
      arrearsPending: `₹${(Number(totalDisbursementCr) * 0.012).toFixed(2)} Cr`,
    },
  });

  console.log('Computing department finance from generated employees...');
  const employeesByDept = new Map();
  for (const e of employees) {
    if (!employeesByDept.has(e.departmentId)) employeesByDept.set(e.departmentId, []);
    employeesByDept.get(e.departmentId).push(e);
  }
  await batchCreateMany('department finance rows', prisma.departmentFinance, buildDepartmentFinance(DEPARTMENTS, employeesByDept));
  await batchCreateMany('expenses', prisma.expense, buildExpenses(DEPARTMENTS, employeesByDept));

  await batchCreateMany('department profiles', prisma.departmentProfile, buildDepartmentProfiles(employeesByDept, deptHeadId, employees));
  await batchCreateMany('vacancies', prisma.vacancy, buildVacancies(employeesByDept));

  console.log('Seeding candidates and onboarding cases...');
  const vacancyRows = await prisma.vacancy.findMany({ where: { criticality: { not: null } } });
  const departmentsById = new Map(DEPARTMENTS.map((d) => [d.id, d]));
  const candidateRows = buildCandidates(vacancyRows, departmentsById);
  await batchCreateMany('candidates', prisma.candidate, candidateRows);
  await batchCreateMany('candidate interviews', prisma.candidateInterview, buildCandidateInterviews(candidateRows));

  const onboardingCaseRows = buildOnboardingCases(candidateRows, employees);
  const onboardingTaskRows = buildOnboardingTasks(onboardingCaseRows);
  await batchCreateMany('onboarding cases', prisma.onboardingCase, onboardingCaseRows.map(({ _progressPct, ...c }) => ({ ...c, progressPct: _progressPct })));
  await batchCreateMany('onboarding tasks', prisma.onboardingTask, onboardingTaskRows);

  await batchCreateMany('projects', prisma.project, buildProjects(employeesByDept));
  await batchCreateMany('legal cases', prisma.legalCase, buildLegalCases());
  await batchCreateMany('emergency alerts', prisma.emergencyAlert, buildEmergencyAlerts());

  console.log('Seeding demo users...');
  // Pick a real, stable employee (by generated id, deterministic under the fixed
  // faker seed) to back the self-service demo login, so the chatbot has a real
  // employee record — leave balance, insurance, service book — to answer from.
  const selfServiceEmployee = employees.find((e) => e.id === "AMC-10001") || employees[0];
  // A few additional self-service demo logins covering different
  // departments/cadres and, deliberately, one employee who is NOT flagged
  // High-Potential — the earlier employee.demo account is HiPo, and every
  // screen that gates or highlights HiPo-specific content needs a non-HiPo
  // account to actually exercise the "not flagged" branch.
  const employeeDemo2 = employees.find((e) => e.id === "AMC-10006"); // Yogesh Parmar — not High-Potential
  const employeeDemo3 = employees.find((e) => e.id === "AMC-13524"); // Bhavesh Solanki — Water Supply, High-Potential
  const employeeDemo4 = employees.find((e) => e.id === "AMC-15841"); // Payal Rana — Fire & Emergency Services, High-Potential
  const initialsOf = (name) => name.split(" ").map((n) => n[0]).join("");
  const users = [
    { email: "hr.admin@amc.gov.in", password: "AmcHR@2026", role: "HRAdmin", name: "Meera Trivedi", title: "HR Administrator", initials: "MT" },
    { email: "dept.head@amc.gov.in", password: "AmcDH@2026", role: "DepartmentHead", name: "Anil Shah", title: "Department Head · Engineering", initials: "AS" },
    { email: "employee.demo@amc.gov.in", password: "AmcEmp@2026", role: "Employee", name: selfServiceEmployee.name, title: selfServiceEmployee.designation, initials: initialsOf(selfServiceEmployee.name), employeeId: selfServiceEmployee.id },
    ...(employeeDemo2 ? [{ email: "employee2.demo@amc.gov.in", password: "AmcEmp2@2026", role: "Employee", name: employeeDemo2.name, title: employeeDemo2.designation, initials: initialsOf(employeeDemo2.name), employeeId: employeeDemo2.id }] : []),
    ...(employeeDemo3 ? [{ email: "employee3.demo@amc.gov.in", password: "AmcEmp3@2026", role: "Employee", name: employeeDemo3.name, title: employeeDemo3.designation, initials: initialsOf(employeeDemo3.name), employeeId: employeeDemo3.id }] : []),
    ...(employeeDemo4 ? [{ email: "employee4.demo@amc.gov.in", password: "AmcEmp4@2026", role: "Employee", name: employeeDemo4.name, title: employeeDemo4.designation, initials: initialsOf(employeeDemo4.name), employeeId: employeeDemo4.id }] : []),
  ];
  for (const u of users) {
    const passwordHash = await bcrypt.hash(u.password, 10);
    await prisma.user.upsert({
      where: { email: u.email },
      create: { email: u.email, passwordHash, role: u.role, name: u.name, title: u.title, initials: u.initials, employeeId: u.employeeId || null },
      update: { passwordHash, role: u.role, name: u.name, title: u.title, initials: u.initials, employeeId: u.employeeId || null },
    });
  }

  const finalCount = await prisma.employee.count();
  console.log(`Seed complete. employees=${finalCount}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
