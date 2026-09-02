import { DEPARTMENTS } from "./departments";

export type Employee = {
  id: string;
  name: string;
  designation: string;
  department: string;
  cadre: string;
  doj: string;
  retirement: string;
  status: "Active" | "On Leave" | "Suspended" | "Deputation";
  posting: string;
  flags: {
    promotionDue?: boolean;
    retirementDue?: boolean;
    appraisalPending?: boolean;
    trainingPending?: boolean;
    missingDocs?: boolean;
  };
};

const FIRST = ["Ramesh","Priya","Amit","Sunita","Rajesh","Neha","Kiran","Manish","Pooja","Vikram","Anil","Rekha","Sandeep","Meera","Hardik","Jignesh","Bhavna","Nilesh","Shreya","Devang","Pinkal","Harshad","Mitali","Kunal","Snehal","Arvind","Kalpesh","Falguni","Bipin","Yogesh"];
const LAST = ["Patel","Shah","Mehta","Joshi","Desai","Trivedi","Pandya","Vyas","Rana","Solanki","Bhatt","Gohil","Rathod","Chauhan","Modi","Parmar","Vaghela","Dave"];
const DESIGNATIONS = ["Deputy Commissioner","Assistant Commissioner","Executive Engineer","Asst. Engineer","Medical Officer","Sanitary Inspector","Town Planner","Accounts Officer","Establishment Officer","Junior Clerk","Senior Clerk","Sub-Inspector","Fire Officer","Tax Officer","Legal Officer","System Analyst","Programmer","Office Superintendent","Driver","Helper"];
const CADRES = ["Class I","Class II","Class III","Class IV"];
const POSTINGS = ["Central Zone","North Zone","South Zone","East Zone","West Zone","South-West Zone","North-West Zone","HQ Danapith"];

function seeded(i: number) {
  // deterministic pseudo-random
  let x = Math.sin(i * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

function pick<T>(arr: readonly T[], i: number): T {
  return arr[Math.floor(seeded(i) * arr.length)];
}

export const EMPLOYEES: Employee[] = Array.from({ length: 220 }).map((_, i) => {
  const id = `AMC-${(10001 + i).toString()}`;
  const first = pick(FIRST, i);
  const last = pick(LAST, i * 3 + 1);
  const dept = pick(DEPARTMENTS.slice(1), i * 7 + 2);
  const desig = pick(DESIGNATIONS, i * 11 + 5);
  const cadre = pick(CADRES, i * 13 + 4);
  const dojYear = 1988 + Math.floor(seeded(i * 17) * 32);
  const retYear = dojYear + 35;
  const now = new Date().getFullYear();
  const retiresIn = retYear - now;
  return {
    id,
    name: `${first} ${last}`,
    designation: desig,
    department: dept,
    cadre,
    doj: `${dojYear}-0${1 + (i % 9)}-1${i % 9}`,
    retirement: `${retYear}-0${1 + (i % 9)}-1${i % 9}`,
    status: (["Active","Active","Active","On Leave","Deputation","Active"] as const)[i % 6],
    posting: pick(POSTINGS, i * 19),
    flags: {
      promotionDue: seeded(i * 23) > 0.78,
      retirementDue: retiresIn <= 2,
      appraisalPending: seeded(i * 29) > 0.7,
      trainingPending: seeded(i * 31) > 0.75,
      missingDocs: seeded(i * 37) > 0.82,
    },
  };
});

export function getEmployee(id: string) {
  return EMPLOYEES.find((e) => e.id === id);
}

export type Task = {
  id: string;
  project: string;
  title: string;
  category: "Inspection" | "Survey" | "Maintenance" | "Approval" | "Audit" | "Drive";
  employeeId: string;
  employeeName: string;
  department: string;
  priority: "High" | "Medium" | "Low";
  dueIn: number; // days
  tatDays: number;
  slaStatus: "On Track" | "At Risk" | "Breached";
  createdBy: string;
  updatedAt: string;
  status: "Pending" | "In Progress" | "Escalated" | "Overdue" | "Completed";
  aiSummary: string;
  delayRisk: "Low" | "Medium" | "High";
  employeeStatus?: string;
  sow?: string | null;
  milestone?: string | null;
  eta?: string | null;
  projectedCompletion?: string | null;
  employeeZone?: string;
  effectivePriority?: "High" | "Medium" | "Low";
  progressPct?: number;
  createdAt?: string;
  completedAt?: string | null;
};

const PROJECTS = [
  { project: "Road Repair · SG Highway", title: "Site inspection and damage report", category: "Inspection" as const },
  { project: "Property Tax Survey · West Zone", title: "Door-to-door survey scheduling", category: "Survey" as const },
  { project: "Drainage Maintenance · Vastrapur", title: "Pre-monsoon cleaning audit", category: "Maintenance" as const },
  { project: "Building Approval · Bopal", title: "Plan review and clearance", category: "Approval" as const },
  { project: "Health Inspection · Maninagar", title: "Hospital sanitation audit", category: "Inspection" as const },
  { project: "Waste Collection Audit · North Zone", title: "Route compliance review", category: "Audit" as const },
  { project: "Tree Plantation Drive · Riverfront", title: "Sapling allocation and reporting", category: "Drive" as const },
  { project: "Water Supply · Naroda", title: "Pipeline pressure inspection", category: "Inspection" as const },
];

export const TASKS: Task[] = Array.from({ length: 48 }).map((_, i) => {
  const emp = EMPLOYEES[i * 4 % EMPLOYEES.length];
  const proj = PROJECTS[i % PROJECTS.length];
  const due = Math.floor(seeded(i * 41) * 14) - 4;
  const tat = 5 + (i % 8);
  const status: Task["status"] =
    i % 13 === 0 ? "Completed" :
    due < 0 ? "Overdue" :
    i % 9 === 0 ? "Escalated" :
    i % 5 === 0 ? "In Progress" : "Pending";
  const sla: Task["slaStatus"] = due < 0 ? "Breached" : due < 3 ? "At Risk" : "On Track";
  return {
    id: `TSK-${2400 + i}`,
    project: proj.project,
    title: proj.title,
    category: proj.category,
    employeeId: emp.id,
    employeeName: emp.name,
    department: emp.department,
    priority: (["High","Medium","Low","Medium"] as const)[i % 4],
    dueIn: due,
    tatDays: tat,
    slaStatus: sla,
    createdBy: i % 2 === 0 ? "Meera Trivedi" : "Anil Shah",
    updatedAt: `2026-06-${String(10 + (i % 16)).padStart(2,"0")}`,
    status,
    aiSummary: `${proj.category} task in ${emp.department}. TAT ${tat}d · ${sla}. ${due < 0 ? "SLA breached — escalate" : `${due}d to deadline`}.`,
    delayRisk: due < 0 ? "High" : due < 3 ? "Medium" : "Low",
  };
});

export const AI_INSIGHTS = [
  { id: "i1", text: "187 employees are due for retirement within the next 24 months.", impact: "High", dept: "All Departments" },
  { id: "i2", text: "73 promotion cases are awaiting processing beyond 60-day SLA.", impact: "High", dept: "Administration" },
  { id: "i3", text: "12% of service records are pending digitization across AMC.", impact: "Medium", dept: "All Departments" },
  { id: "i4", text: "Engineering Department may face 14% workforce shortage within 12 months.", impact: "High", dept: "Engineering" },
  { id: "i5", text: "Training coverage in Class III cadre dropped 8% QoQ.", impact: "Medium", dept: "All Departments" },
  { id: "i6", text: "32 appraisals overdue in Health Department for FY 2025-26.", impact: "Medium", dept: "Health" },
];

export const SERVICE_BOOK_DOCS = [
  { id: "DOC-1001", emp: "AMC-10042", type: "Promotion Order", date: "2024-03-12", ocr: 98.4, status: "Verified" },
  { id: "DOC-1002", emp: "AMC-10076", type: "Transfer Order", date: "2023-11-09", ocr: 95.1, status: "Verified" },
  { id: "DOC-1003", emp: "AMC-10110", type: "Appointment Order", date: "2012-06-21", ocr: 92.8, status: "Pending Review" },
  { id: "DOC-1004", emp: "AMC-10042", type: "Joining Report", date: "—", ocr: 0, status: "Missing" },
  { id: "DOC-1005", emp: "AMC-10189", type: "Increment Order", date: "2025-01-04", ocr: 99.1, status: "Verified" },
  { id: "DOC-1006", emp: "AMC-10076", type: "Relieving Order", date: "—", ocr: 0, status: "Missing" },
  { id: "DOC-1007", emp: "AMC-10211", type: "Disciplinary Order", date: "2022-08-15", ocr: 88.7, status: "Verified" },
  { id: "DOC-1008", emp: "AMC-10165", type: "Pension Order", date: "2024-12-30", ocr: 96.5, status: "Verified" },
];

export const COPILOT_SUGGESTIONS = [
  "Show employees retiring next year",
  "Generate cadre strength report",
  "Show pending promotion cases",
  "Generate workforce analytics report",
  "Show employees with missing documents",
  "Prepare commissioner workforce brief",
];
