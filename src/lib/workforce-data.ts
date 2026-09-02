// Master workforce dataset — single source of truth used across all modules.
// Sums: total = 34,862; vacancies = 428; attendance weighted = 91.4%.

export const DEPT_WORKFORCE = [
  { dept: "Health",       fullName: "Health",                    count: 8256, attendance: 92.5, vacancies: 124 },
  { dept: "Engineering",  fullName: "Engineering",               count: 6742, attendance: 90.8, vacancies: 96 },
  { dept: "Solid Waste",  fullName: "Solid Waste Management",    count: 5189, attendance: 88.7, vacancies: 72 },
  { dept: "Revenue",      fullName: "Revenue",                   count: 4652, attendance: 93.2, vacancies: 38 },
  { dept: "Water",        fullName: "Water Supply",              count: 3822, attendance: 91.6, vacancies: 20 },
  { dept: "Planning",     fullName: "Town Planning",             count: 3214, attendance: 94.1, vacancies: 30 },
  { dept: "Fire",         fullName: "Fire & Emergency Services", count: 2987, attendance: 89.4, vacancies: 48 },
] as const;

export const TOTAL_WORKFORCE = DEPT_WORKFORCE.reduce((s, d) => s + d.count, 0); // 34,862

/** Get the workforce count for a department (by full name). Returns the org total for unknown/all departments. */
export function getDeptCount(fullDeptName: string): number {
  const match = DEPT_WORKFORCE.find((d) => d.fullName === fullDeptName || d.dept === fullDeptName);
  return match?.count ?? TOTAL_WORKFORCE;
}
