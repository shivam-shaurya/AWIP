import { EMPLOYEES, TASKS, SERVICE_BOOK_DOCS } from "./mock-data";
import type { QuickAction, ReportType } from "@/types/copilot";

// Falls back to whatever host the page was loaded from (LAN IP, localhost,
// or a real domain in production) so a dev machine's DHCP-reassigned IP
// never has to be hardcoded and re-typed into an .env file by hand.
const inferredHost = typeof window !== "undefined" ? window.location.hostname : "localhost";
const CORE_API_URL = import.meta.env.VITE_CORE_API_URL || `http://${inferredHost}:5000`;
const AI_API_URL = import.meta.env.VITE_AI_API_URL || `http://${inferredHost}:8000`;
const TOKEN_KEY = "awip.auth.token";
const USER_KEY = "awip.auth.user";

export function getToken() {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  // Structured fields a route handler attached to the error body beyond the
  // plain `error` string — e.g. leave-apply's conflict/suggestion payload —
  // so callers can render more than just a message when they need to.
  data?: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function getLocalMockFallback<T>(path: string): T {
  if (path.startsWith("/api/v1/employees/")) {
    const id = path.split("/").pop();
    const emp = EMPLOYEES.find(e => e.id === id) || EMPLOYEES[0];
    const shaped = {
      ...emp,
      performanceScore: 84,
      complianceScore: 91,
      aiConfidence: "94%",
      recentActivities: [
        { id: "a1", action: "Service Book updated via OCR Scan", date: "29 Jun 2026" },
        { id: "a2", action: "Completed Training: Prevention of Waterlogging", date: "15 Jun 2026" }
      ],
      tasks: TASKS.filter(t => t.employeeId === emp.id).map(t => ({ ...t, status: t.status, slaStatus: t.slaStatus })),
      serviceBookDocs: SERVICE_BOOK_DOCS.filter(d => d.emp === emp.id).map(d => ({ ...d, status: d.status }))
    };
    return shaped as T;
  }
  if (path.startsWith("/api/v1/employees")) {
    const searchString = path.includes("?") ? path.split("?")[1] : "";
    const params = new URLSearchParams(searchString);
    const department = params.get("department");
    const status = params.get("status");
    let filtered = [...EMPLOYEES];
    if (department && department !== "All Departments") {
      filtered = filtered.filter(e => e.department === department);
    }
    if (status) {
      filtered = filtered.filter(e => e.status.replace(" ", "") === status.replace(" ", ""));
    }
    return { count: filtered.length, data: filtered } as T;
  }
  if (path.startsWith("/api/v1/tasks/zone-stats")) {
    return { data: [] } as T;
  }
  if (path.startsWith("/api/v1/tasks/trend")) {
    return { data: [] } as T;
  }
  if (path.includes("/api/v1/tasks/productivity-insight")) {
    return {
      weakest: { department: "Unavailable", zone: "Unavailable", completionRatePct: 0, trendPct: 0, overdueTasks: 0, avgTatDays: 0, headcount: 0 },
      strongest: { department: "Unavailable", zone: "Unavailable", completionRatePct: 0, trendPct: 0, overdueTasks: 0, avgTatDays: 0, headcount: 0 },
      narrative: "Productivity insights are unavailable while offline.",
      recommendedAction: "Reconnect to the AWIP core server to generate a live recommendation.",
    } as T;
  }
  if (path.includes("/detail") && path.startsWith("/api/v1/tasks/")) {
    const id = path.split("/")[3];
    const task = TASKS.find(t => t.id === id) || TASKS[0];
    return {
      task,
      assignee: { id: task.employeeId, name: task.employeeName, designation: "Unavailable", department: task.department, cadre: "Unavailable", zone: "Unavailable", status: task.employeeStatus || "Active" },
      managerChain: [],
      directReports: [],
      taskSummary: { total: 0, open: 0, completed: 0, overdue: 0 },
    } as T;
  }
  if (path.startsWith("/api/v1/tasks")) {
    return { count: TASKS.length, total: TASKS.length, data: TASKS } as T;
  }
  if (path.startsWith("/api/v1/service-book")) {
    return { count: SERVICE_BOOK_DOCS.length, data: SERVICE_BOOK_DOCS } as T;
  }
  if (path.startsWith("/api/v1/payroll/summary")) {
    return {
      totalDisbursement: "₹184.6 Cr",
      processedEmployees: 34862,
      pendingApprovals: 47,
      arrearsPending: "₹2.3 Cr"
    } as T;
  }
  if (path.startsWith("/api/v1/workforce/alerts-summary")) {
    return {
      promotion: { total: 0, byDepartment: [], byZone: [], byCadre: [] },
      retirement: { total: 0, byDepartment: [], byZone: [], buckets: {} },
      payroll: { totalCr: 0, components: [] },
    } as T;
  }
  if (path.startsWith("/api/v1/workforce/zones")) {
    return { data: [], total: 0 } as T;
  }
  if (path.startsWith("/api/v1/workforce/totals")) {
    return { total: 0, presentPct: 0, vacancies: 0 } as T;
  }
  if (path.startsWith("/api/v1/workforce/summary")) {
    return {
      total: 34862,
      data: [
        { dept: "HEALTH", fullName: "Health", count: 8200, attendance: 91.2, vacancies: 210 },
        { dept: "SWM", fullName: "Solid Waste Management", count: 6742, attendance: 88.4, vacancies: 180 },
        { dept: "ENGG", fullName: "Engineering", count: 4500, attendance: 90.1, vacancies: 140 },
        { dept: "WATER", fullName: "Water Supply", count: 3200, attendance: 89.7, vacancies: 95 },
        { dept: "ADMIN", fullName: "Administration", count: 2800, attendance: 93.0, vacancies: 40 },
      ]
    } as T;
  }
  if (path.startsWith("/api/v1/calendar/events")) {
    return { data: [] } as T;
  }
  if (path.startsWith("/api/v1/emergency-alerts")) {
    return { data: [] } as T;
  }
  if (path.startsWith("/api/v1/agents")) {
    return { data: [] } as T;
  }
  if (path.startsWith("/api/v1/leave/overview")) {
    return { current: [], upcoming: [] } as T;
  }
  if (path.startsWith("/api/v1/leave/calendar")) {
    return { month: "", days: {} } as T;
  }
  if (path.startsWith("/api/v1/leave/analytics")) {
    return { utilization: [], mostAvailedType: null, nearingZero: [], approvalRate: null, avgDecisionDays: null, approvedCount: 0, rejectedCount: 0 } as T;
  }
  if (path.includes("/hp-detail")) {
    return { trend: [], peerComparison: { peerCount: 0, peerAvgScore: null, percentile: null, cadre: "", department: "" } } as T;
  }
  if (path.includes("/leave/requests/pending-count")) {
    return { count: 0, latest: null } as T;
  }
  if (path.startsWith("/api/v1/leave") || path.includes("/perks")) {
    return { data: [] } as T;
  }
  if (path.includes("/authority")) {
    return { id: "", name: "Unavailable", designation: "", department: "", personalEmail: null, phone: null } as T;
  }
  if (path.startsWith("/api/v1/grievances/analytics")) {
    return { data: [], byDepartment: [] } as T;
  }
  if (path.startsWith("/api/v1/grievances")) {
    return { count: 0, data: [] } as T;
  }
  if (path.startsWith("/api/v1/privacy-requests")) {
    return { count: 0, data: [] } as T;
  }
  if (path.startsWith("/api/v1/performance/summary")) {
    return { appraisalsCompleted: 0, pendingSubmission: 0, avgPerformanceScore: 0, highPerformers: 0, completionRatePct: 0, deptScores: [] } as T;
  }
  if (path.startsWith("/api/v1/compliance/rules")) {
    return { leaveRules: [], holidays: [] } as T;
  }
  if (path.startsWith("/api/v1/search")) {
    const searchString = path.includes("?") ? path.split("?")[1] : "";
    const params = new URLSearchParams(searchString);
    const q = (params.get("q") || "").toLowerCase().trim();
    if (!q) return { employees: [], tasks: [], documents: [] } as T;

    const matchedEmployees = EMPLOYEES.filter(
      e => e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q) || e.designation.toLowerCase().includes(q)
    ).slice(0, 30).map(e => ({ id: e.id, name: e.name, designation: e.designation, department: e.department }));

    const matchedTasks = TASKS.filter(
      t => t.title.toLowerCase().includes(q) || t.project.toLowerCase().includes(q)
    ).slice(0, 20).map(t => ({ id: t.id, title: t.title, project: t.project, department: t.department }));

    const matchedDocs = SERVICE_BOOK_DOCS.filter(
      d => d.type.toLowerCase().includes(q)
    ).slice(0, 20).map(d => {
      const emp = EMPLOYEES.find(e => e.id === d.emp);
      return { id: d.id, type: d.type, description: d.status, employeeId: d.emp, employeeName: emp?.name || "Officer" };
    });

    return { employees: matchedEmployees, tasks: matchedTasks, documents: matchedDocs } as T;
  }
  if (path.startsWith("/api/v1/compliance/alerts")) {
    return { data: [], gratuityEligibleCount: 0 } as T;
  }
  if (path.startsWith("/api/v1/compliance")) {
    return { data: [] } as T;
  }
  throw new Error(`No mock fallback for path ${path}`);
}

async function request<T>(baseUrl: string, path: string, options: RequestInit = {}, auth = true): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  try {
    const res = await fetch(`${baseUrl}${path}`, { ...options, headers });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 401 && auth) {
        // Stale/invalid token — force a clean re-login instead of letting
        // every screen silently render zeroed-out data.
        clearToken();
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(USER_KEY);
          if (window.location.pathname !== "/login") window.location.href = "/login";
        }
      }
      throw new ApiError(res.status, body.error || `Request failed with status ${res.status}`, body);
    }
    return res.json();
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }
    console.warn(`[API Client] Core server offline at ${baseUrl}. Falling back to mock data for path: ${path}`);
    return getLocalMockFallback<T>(path);
  }
}

export const coreApi = {
  login: (email: string, password: string) =>
    request<{ token: string; user: { role: string; name: string; title: string; initials: string; email: string; employeeId: string | null } }>(
      CORE_API_URL, "/api/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }, false,
    ),
  getEmployees: (params?: {
    department?: string; status?: string; zone?: string;
    cadre?: string; designation?: string; q?: string; page?: number; limit?: number; flag?: string;
    highPotential?: boolean;
    performanceDeclining?: boolean; regularisationMilestone?: "recent"; retirementBlocked?: boolean;
  }) => {
    // Strip undefined entries — URLSearchParams would otherwise stringify
    // them as the literal text "undefined", which the server would then
    // (mis)parse as a real page/limit value.
    const clean: Record<string, string> = {};
    if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined) clean[k] = String(v);
    const qs = new URLSearchParams(clean).toString();
    return request<{ count: number; total?: number; data: any[] }>(CORE_API_URL, `/api/v1/employees${qs ? `?${qs}` : ""}`);
  },
  getEmployeeDesignations: (params?: { department?: string; zone?: string }) => {
    const clean: Record<string, string> = {};
    if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined) clean[k] = String(v);
    const qs = new URLSearchParams(clean).toString();
    return request<{ data: string[] }>(CORE_API_URL, `/api/v1/employees/designations${qs ? `?${qs}` : ""}`);
  },
  getEmployee: (id: string) => request<any>(CORE_API_URL, `/api/v1/employees/${id}`),
  getEmployeeOrgTree: (id: string) => request<any>(CORE_API_URL, `/api/v1/employees/${id}/org-tree`),
  getEmployeePayslip: (id: string) =>
    request<{
      employeeId: string; name: string; designation: string; department: string; payPeriod: string;
      earnings: { basicPay: number; daAmount: number; hraAmount: number; grossPay: number };
      deductions: { pfContribution: number; esicContribution: number; tdsDeduction: number; totalDeductions: number };
      netPay: number;
    }>(CORE_API_URL, `/api/v1/employees/${id}/payslip`),
  getDepartments: () => request<{ data: any[] }>(CORE_API_URL, "/api/v1/departments"),
  getDepartmentOrgTree: (id: string) => request<{ data: any[] }>(CORE_API_URL, `/api/v1/departments/${id}/org-tree`),
  getTasks: (params?: {
    department?: string; zone?: string; status?: string; priority?: string; project?: string;
    q?: string; page?: number; limit?: number;
  }) => {
    // Strip undefined/"All ..." sentinel entries — URLSearchParams would
    // otherwise stringify undefined as the literal text "undefined".
    const clean: Record<string, string> = {};
    if (params) for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      if ((k === "department" && v === "All Departments") || (k === "zone" && v === "All Zones")) continue;
      clean[k] = String(v);
    }
    const qs = new URLSearchParams(clean).toString();
    return request<{ count: number; total?: number; data: any[] }>(CORE_API_URL, `/api/v1/tasks${qs ? `?${qs}` : ""}`);
  },
  getTaskProjects: (params?: { department?: string; zone?: string; status?: string; q?: string }) => {
    const clean: Record<string, string> = {};
    if (params) for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      if ((k === "department" && v === "All Departments") || (k === "zone" && v === "All Zones")) continue;
      clean[k] = String(v);
    }
    const qs = new URLSearchParams(clean).toString();
    return request<{ data: { project: string; total: number; completed: number }[] }>(
      CORE_API_URL, `/api/v1/tasks/projects${qs ? `?${qs}` : ""}`,
    );
  },
  globalSearch: (q: string) =>
    request<{
      employees: { id: string; name: string; designation: string; department: string }[];
      tasks: { id: string; title: string; project: string; department: string }[];
      documents: { id: string; type: string; description: string | null; employeeId: string; employeeName: string }[];
    }>(CORE_API_URL, `/api/v1/search?q=${encodeURIComponent(q)}`),
  getTaskZoneStats: () =>
    request<{ data: { zone: string; total: number; completed: number; overdue: number; avgTatDays: number; slaPct: number }[] }>(
      CORE_API_URL, "/api/v1/tasks/zone-stats",
    ),
  getTaskTrend: (params?: { department?: string; zone?: string; months?: number; compare?: boolean }) => {
    const clean: Record<string, string> = {};
    if (params) for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      if ((k === "department" && v === "All Departments") || (k === "zone" && v === "All Zones")) continue;
      clean[k] = String(v);
    }
    const qs = new URLSearchParams(clean).toString();
    return request<{
      data: { month: string; totalTasks: number; completedTasks: number; overdueTasks: number; completionRatePct: number; avgTatDays: number }[];
      // Only present when `compare: true` was requested with no department/zone
      // scope — real best/weakest department+zone combos as separate series,
      // since the fully org-wide aggregate flattens ~168 combos into a
      // near-constant band that hides the genuine variation between them.
      series?: {
        label: string; department: string; zone: string;
        data: { month: string; totalTasks: number; completedTasks: number; overdueTasks: number; completionRatePct: number; avgTatDays: number }[];
      }[];
    }>(
      CORE_API_URL, `/api/v1/tasks/trend${qs ? `?${qs}` : ""}`,
    );
  },
  getTaskDetail: (id: string) =>
    request<{
      task: any;
      assignee: { id: string; name: string; designation: string; department: string; cadre: string; zone: string; status: string };
      managerChain: { id: string; name: string; designation: string; cadre: string }[];
      directReports: { id: string; name: string; designation: string; cadre: string }[];
      taskSummary: { total: number; open: number; completed: number; overdue: number };
    }>(CORE_API_URL, `/api/v1/tasks/${id}/detail`),
  getTaskProductivityInsight: () =>
    request<{
      weakest: { department: string; zone: string; completionRatePct: number; trendPct: number; overdueTasks: number; avgTatDays: number; headcount: number };
      strongest: { department: string; zone: string; completionRatePct: number; trendPct: number; overdueTasks: number; avgTatDays: number; headcount: number };
      narrative: string;
      recommendedAction: string;
    }>(CORE_API_URL, "/api/v1/tasks/productivity-insight"),
  createTask: (payload: Record<string, unknown>) =>
    request<any>(CORE_API_URL, "/api/v1/tasks", { method: "POST", body: JSON.stringify(payload) }),
  createTasksBulk: (payload: { project: string; department?: string; tasks: Record<string, unknown>[] }) =>
    request<{ data: any[] }>(CORE_API_URL, "/api/v1/tasks/bulk", { method: "POST", body: JSON.stringify(payload) }),
  reassignTask: (id: string, payload: { employeeId: string; reason?: string; note?: string }) =>
    request<any>(CORE_API_URL, `/api/v1/tasks/${id}/reassign`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteTask: (id: string) =>
    request<{ message: string; id: string }>(CORE_API_URL, `/api/v1/tasks/${id}`, { method: "DELETE" }),
  escalateTasks: (ids: string[]) =>
    request<{ data: any[] }>(CORE_API_URL, "/api/v1/tasks/escalate", { method: "POST", body: JSON.stringify({ ids }) }),
  getServiceBook: (params?: { type?: string; status?: string; q?: string; department?: string; page?: number; limit?: number }) => {
    const clean: Record<string, string> = {};
    if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined) clean[k] = String(v);
    const qs = new URLSearchParams(clean).toString();
    return request<{
      count: number; total: number; page: number; totalPages: number;
      data: { id: string; employeeId: string; employeeName: string; department: string; type: string; date: string; ocrScore: number; status: string }[];
    }>(CORE_API_URL, `/api/v1/service-book${qs ? `?${qs}` : ""}`);
  },
  getServiceBookTypes: () => request<{ data: string[] }>(CORE_API_URL, "/api/v1/service-book/types"),
  getServiceBookStats: () =>
    request<{ digitized: number; pendingReview: number; ocrAccuracyPct: number; missing: number; verifiedPct: number; documentTypes: number }>(
      CORE_API_URL, "/api/v1/service-book/stats",
    ),
  getServiceBookCompleteness: () =>
    request<{ data: { department: string; total: number; completenessPct: number }[] }>(CORE_API_URL, "/api/v1/service-book/completeness"),
  getPayrollSummary: () => request<any>(CORE_API_URL, "/api/v1/payroll/summary"),
  getWorkforceSummary: (zone?: string) =>
    request<{ data: any[]; total: number }>(CORE_API_URL, `/api/v1/workforce/summary${zone && zone !== "All Zones" ? `?zone=${encodeURIComponent(zone)}` : ""}`),
  getWorkforceZones: (department?: string) =>
    request<{ data: { zone: string; count: number; attendance: number }[]; total: number }>(
      CORE_API_URL, `/api/v1/workforce/zones${department && department !== "All Departments" ? `?department=${encodeURIComponent(department)}` : ""}`,
    ),
  getWorkforceTotals: (department?: string, zone?: string) => {
    const qs = new URLSearchParams();
    if (department && department !== "All Departments") qs.set("department", department);
    if (zone && zone !== "All Zones") qs.set("zone", zone);
    const s = qs.toString();
    return request<{ total: number; presentPct: number; vacancies: number }>(CORE_API_URL, `/api/v1/workforce/totals${s ? `?${s}` : ""}`);
  },
  getWorkforceAgeProfile: () => request<{ data: { ageGroup: string; count: number }[] }>(CORE_API_URL, "/api/v1/workforce/age-profile"),
  getWorkforceAlerts: () => request<{
    promotion: { total: number; byDepartment: { department: string; count: number }[]; byZone: { zone: string; count: number }[]; byCadre: { cadre: string; count: number }[] };
    retirement: { total: number; byDepartment: { department: string; count: number }[]; byZone: { zone: string; count: number }[]; buckets: Record<string, number> };
    payroll: { totalCr: number; components: { component: string; amountCr: number; pct: number }[]; totalDisbursement?: string; processedEmployees?: number; pendingApprovals?: number; arrearsPending?: string };
  }>(CORE_API_URL, "/api/v1/workforce/alerts-summary"),
  getPerformanceSummary: () => request<{
    appraisalsCompleted: number;
    pendingSubmission: number;
    avgPerformanceScore: number;
    highPerformers: number;
    completionRatePct: number;
    deptScores: { department: string; score: number }[];
  }>(CORE_API_URL, "/api/v1/performance/summary"),
  getSmartAlerts: () => request<{
    absenteeism: { zone: string; increasePct: number } | null;
    performanceDeclining: number;
    retiringNext12Months: number;
    departmentsOverBudget: number;
    retirementReadinessBlocked: number;
    recentlyRegularised: number;
  }>(CORE_API_URL, "/api/v1/insights/smart-alerts"),
  reallocateTask: (id: string, payload: { employeeId: string; reason?: string; note?: string }) =>
    request<any>(CORE_API_URL, `/api/v1/tasks/${id}/reallocate`, { method: "PUT", body: JSON.stringify(payload) }),
  getEmployeeWorkload: () => request<{ data: any[] }>(CORE_API_URL, "/api/v1/employees/workload"),
  getPromotionReadyList: () =>
    request<{ data: { id: string; name: string; designation: string; department: string; cadre: string; seniorityYears: number; latestRating: number | null; trainingCompletionPct: number; vigilance: "Granted" | "Flagged"; score: number }[] }>(
      CORE_API_URL, "/api/v1/employees/promotion-ready",
    ),
  getCadreSummary: (departmentId?: string) =>
    request<{ data: any[] }>(CORE_API_URL, `/api/v1/workforce/cadre-summary${departmentId ? `?departmentId=${departmentId}` : ""}`),
  getTrainingSummary: (params?: { departmentId?: string; courseTitle?: string }) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return request<{ data: any[]; byDepartment: { department: string; enrolled: number; completionRate: number }[] }>(
      CORE_API_URL, `/api/v1/training/summary${qs ? `?${qs}` : ""}`,
    );
  },
  getRetirementTrend: () =>
    request<{ data: { year: string; projectedRetirements: number }[]; activeStrength: number }>(
      CORE_API_URL, "/api/v1/workforce/retirement-trend",
    ),
  getGovernanceReadiness: () =>
    request<{ data: { dept: string; digitization: number; appraisal: number; training: number; establishment: number }[] }>(
      CORE_API_URL, "/api/v1/workforce/governance-readiness",
    ),
  getExpenses: () =>
    request<{
      data: { id: string; department: string; type: string; submitter: string; amount: number; submittedAt: string; risk: "Low" | "Medium" | "High"; flagged: boolean; action: string }[];
      kpis: { flaggedCount: number; autoApprovedAmount: number };
    }>(CORE_API_URL, "/api/v1/finance/expenses"),
  getExpenditureTrend: (params?: { department?: string; months?: number }) => {
    const qs = new URLSearchParams(params as any).toString();
    return request<{ data: any[] }>(CORE_API_URL, `/api/v1/finance/expenditure-trend${qs ? `?${qs}` : ""}`);
  },
  getBudgetVariance: (params?: { department?: string; category?: string }) => {
    const qs = new URLSearchParams();
    if (params?.department) qs.set("department", params.department);
    if (params?.category) qs.set("category", params.category);
    const s = qs.toString();
    return request<{ data: { department: string; allocated: number; spent: number; variance: number; variancePct: number; avgMonthlySpent: number }[] }>(
      CORE_API_URL, `/api/v1/finance/budget-variance${s ? `?${s}` : ""}`,
    );
  },
  getPayrollTrend: () =>
    request<{ data: { month: string; actual: number | null; predicted: number | null }[]; confidence: number; trendR2?: number }>(
      CORE_API_URL, "/api/v1/finance/payroll-trend",
    ),
  getCalendarEvents: (params?: { from?: string; to?: string }) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return request<{ data: any[] }>(CORE_API_URL, `/api/v1/calendar/events${qs ? `?${qs}` : ""}`);
  },
  createCalendarEvent: (payload: { title: string; date: string; type?: string; department?: string; note?: string }) =>
    request<any>(CORE_API_URL, "/api/v1/calendar/events", { method: "POST", body: JSON.stringify(payload) }),
  deleteCalendarEvent: (id: string) =>
    request<{ message: string; id: string }>(CORE_API_URL, `/api/v1/calendar/events/${id}`, { method: "DELETE" }),
  createPersonalEvent: (payload: { title: string; date: string; note?: string }) =>
    request<any>(CORE_API_URL, "/api/v1/calendar/personal-events", { method: "POST", body: JSON.stringify(payload) }),
  deletePersonalEvent: (id: string) =>
    request<{ success: boolean }>(CORE_API_URL, `/api/v1/calendar/personal-events/${id.replace(/^personal-/, "")}`, { method: "DELETE" }),
  getGrievances: (department?: string) =>
    request<{ count: number; data: any[] }>(CORE_API_URL, `/api/v1/grievances${department ? `?department=${department}` : ""}`),
  getGrievance: (id: string) => request<any>(CORE_API_URL, `/api/v1/grievances/${id}`),
  getGrievanceAnalytics: () => request<{ data: any[]; byDepartment: { department: string; openCount: number; criticalCount: number }[] }>(CORE_API_URL, "/api/v1/grievances/analytics"),
  createGrievance: (payload: Record<string, unknown>) =>
    request<any>(CORE_API_URL, "/api/v1/grievances", { method: "POST", body: JSON.stringify(payload) }),
  updateGrievanceStatus: (id: string, payload: { status: string; note?: string }) =>
    request<any>(CORE_API_URL, `/api/v1/grievances/${id}/status`, { method: "PUT", body: JSON.stringify(payload) }),
  getPrivacyRequests: () => request<{ count: number; data: any[] }>(CORE_API_URL, "/api/v1/privacy-requests"),
  createPrivacyRequest: (payload: { type: "Access" | "Correction" | "Erasure"; description: string; employeeId?: string }) =>
    request<any>(CORE_API_URL, "/api/v1/privacy-requests", { method: "POST", body: JSON.stringify(payload) }),
  updatePrivacyRequestStatus: (id: string, payload: { status: string; notes?: string }) =>
    request<any>(CORE_API_URL, `/api/v1/privacy-requests/${id}/status`, { method: "PUT", body: JSON.stringify(payload) }),
  searchStatutoryCompliance: (search: string) =>
    request<{ data: any[] }>(CORE_API_URL, `/api/v1/compliance/statutory?search=${encodeURIComponent(search)}`),
  getEmployeeCompliance: (id: string) => request<any>(CORE_API_URL, `/api/v1/compliance/employee/${id}`),
  getComplianceRules: () => request<{ leaveRules: any[]; holidays: any[] }>(CORE_API_URL, "/api/v1/compliance/rules"),
  getComplianceAlerts: () => request<{ data: any[]; gratuityEligibleCount: number }>(CORE_API_URL, "/api/v1/compliance/alerts"),
  getDepartmentProfiles: () => request<{ data: any[] }>(CORE_API_URL, "/api/v1/org/departments/profiles"),
  getWardDensity: () => request<{
    data: { ward: string; zone: string; workerCount: number; areaSqKm: number; workersPerSqKm: number; status: "Overstaffed" | "Understaffed" | "Balanced" }[];
    avgDensity: number;
  }>(CORE_API_URL, "/api/v1/org/wards"),
  getDepartmentProfile: (id: string) => request<any>(CORE_API_URL, `/api/v1/org/departments/${id}/profile`),
  getDepartmentVacancies: (id: string) => request<{ data: any[] }>(CORE_API_URL, `/api/v1/org/departments/${id}/vacancies`),
  getDepartmentProjects: (id: string) => request<{ data: any[] }>(CORE_API_URL, `/api/v1/org/departments/${id}/projects`),
  getDepartmentAssets: (id: string) => request<{ data: any[] }>(CORE_API_URL, `/api/v1/org/departments/${id}/assets`),
  getLegalCases: () => request<{ data: any[] }>(CORE_API_URL, "/api/v1/legal/cases"),
  getComplianceRadar: () => request<{ data: any[]; overall: number }>(CORE_API_URL, "/api/v1/compliance/radar"),
  getTaskAlerts: () => request<{ data: any[] }>(CORE_API_URL, "/api/v1/tasks/alerts"),
  getDepartmentAuthority: (department: string) =>
    request<{ id: string; name: string; designation: string; department: string; personalEmail: string | null; phone: string | null }>(
      CORE_API_URL, `/api/v1/departments/${encodeURIComponent(department)}/authority`,
    ),
  getEmergencyAlerts: () => request<{ data: any[] }>(CORE_API_URL, "/api/v1/emergency-alerts"),
  createEmergencyAlert: (payload: { category: string; title: string; description: string; department: string; location?: string; severity: string; reportedBy?: string }) =>
    request<any>(CORE_API_URL, "/api/v1/emergency-alerts", { method: "POST", body: JSON.stringify(payload) }),
  updateEmergencyAlertStatus: (id: string, payload: { status: string; channel?: string; note?: string }) =>
    request<any>(CORE_API_URL, `/api/v1/emergency-alerts/${id}/status`, { method: "PUT", body: JSON.stringify(payload) }),
  dismissEmergencyAlert: (id: string) =>
    request<any>(CORE_API_URL, `/api/v1/emergency-alerts/${id}/status`, { method: "PUT", body: JSON.stringify({ status: "Dismissed", note: "Dismissed by HR admin." }) }),
  getLeaveBalances: (employeeId: string) =>
    request<{ data: { id: number; leaveType: string; year: number; entitled: number; availed: number; balance: number }[] }>(
      CORE_API_URL, `/api/v1/leave/balances/${employeeId}`,
    ),
  getLeaveRequests: (params?: { employeeId?: string; department?: string; status?: string }) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return request<{ data: any[] }>(CORE_API_URL, `/api/v1/leave/requests${qs ? `?${qs}` : ""}`);
  },
  applyForLeave: (payload: { employeeId: string; leaveType: string; fromDate: string; toDate: string; reason: string; overrideConflict?: boolean }) =>
    request<any>(CORE_API_URL, "/api/v1/leave/requests", { method: "POST", body: JSON.stringify(payload) }),
  decideLeaveRequest: (id: string, payload: { status: "Approved" | "Rejected"; note?: string }) =>
    request<any>(CORE_API_URL, `/api/v1/leave/requests/${id}/decision`, { method: "PUT", body: JSON.stringify(payload) }),
  getLeaveOverview: (department?: string) =>
    request<{ current: any[]; upcoming: any[] }>(
      CORE_API_URL, `/api/v1/leave/overview${department && department !== "All Departments" ? `?department=${encodeURIComponent(department)}` : ""}`,
    ),
  getPendingLeaveCount: (department?: string) =>
    request<{ count: number; latest: { employeeName: string; leaveType: string } | null }>(
      CORE_API_URL, `/api/v1/leave/requests/pending-count${department && department !== "All Departments" ? `?department=${encodeURIComponent(department)}` : ""}`,
    ),
  managerDecideLeaveRequest: (id: string, payload: { status: "Approved" | "Rejected"; note?: string }) =>
    request<any>(CORE_API_URL, `/api/v1/leave/requests/${id}/manager-decision`, { method: "PUT", body: JSON.stringify(payload) }),
  getLeaveCalendar: (month: string, department?: string) => {
    const qs = new URLSearchParams({ month, ...(department && department !== "All Departments" ? { department } : {}) }).toString();
    return request<{ month: string; days: Record<string, { employeeId: string; name: string; department: string; leaveType: string }[]> }>(
      CORE_API_URL, `/api/v1/leave/calendar?${qs}`,
    );
  },
  getLeaveAnalytics: (department?: string) =>
    request<{
      utilization: { leaveType: string; entitled: number; availed: number; balance: number }[];
      mostAvailedType: string | null;
      nearingZero: { employeeId: string; name: string; department: string; leaveType: string; balance: number }[];
      approvalRate: number | null;
      avgDecisionDays: number | null;
      approvedCount: number;
      rejectedCount: number;
      byDepartment: { department: string; avgTaken: number; pending: number }[];
    }>(CORE_API_URL, `/api/v1/leave/analytics${department && department !== "All Departments" ? `?department=${encodeURIComponent(department)}` : ""}`),
  getEmployeePerks: (employeeId: string) =>
    request<{ data: { id: number; type: string; customLabel: string | null; note: string | null; grantedBy: string; grantedAt: string }[] }>(
      CORE_API_URL, `/api/v1/employees/${employeeId}/perks`,
    ),
  grantPerk: (employeeId: string, payload: { type: string; customLabel?: string; note?: string }) =>
    request<any>(CORE_API_URL, `/api/v1/employees/${employeeId}/perks`, { method: "POST", body: JSON.stringify(payload) }),
  getHpDetail: (employeeId: string) =>
    request<{
      trend: { year: number; score: number }[];
      peerComparison: { peerCount: number; peerAvgScore: number | null; percentile: number | null; cadre: string; department: string };
    }>(CORE_API_URL, `/api/v1/employees/${employeeId}/hp-detail`),
  setHighPotentialOverride: (employeeId: string, flagged: boolean | null) =>
    request<{ hiPoOverride: boolean | null; hiPoOverrideBy: string | null; hiPoOverrideAt: string | null }>(
      CORE_API_URL, `/api/v1/employees/${employeeId}/high-potential`, { method: "PATCH", body: JSON.stringify({ flagged }) },
    ),
  getAiAgents: () =>
    request<{ data: { agentKey: string; status: "Running" | "Alert" | "Idle"; confidence: number; ranAt: string | null }[] }>(
      CORE_API_URL, "/api/v1/agents",
    ),
  getAiAgent: (key: string) =>
    request<{
      agentKey: string; status: "Running" | "Alert" | "Idle"; confidence: number;
      findings: Record<string, any>; narrative: string; recommendedAction: string; ranAt: string;
    }>(CORE_API_URL, `/api/v1/agents/${key}`),
  runAiAgentNow: (key: string) =>
    request<{
      agentKey: string; status: "Running" | "Alert" | "Idle"; confidence: number;
      findings: Record<string, any>; narrative: string; recommendedAction: string; ranAt: string;
    }>(CORE_API_URL, `/api/v1/agents/${key}/run`, { method: "POST" }),
  getRecruitmentSummary: () =>
    request<{ totalApplications: number; inPipeline: number; offersExtended: number; offersAccepted: number; rejected: number; byStatus: Record<string, number> }>(
      CORE_API_URL, "/api/v1/recruitment/summary",
    ),
  getCandidates: (params?: { department?: string; status?: string }) => {
    const clean: Record<string, string> = {};
    if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") clean[k] = String(v);
    const qs = new URLSearchParams(clean).toString();
    return request<{ count: number; data: any[] }>(CORE_API_URL, `/api/v1/recruitment/candidates${qs ? `?${qs}` : ""}`);
  },
  getCandidateDetail: (id: string) => request<any>(CORE_API_URL, `/api/v1/recruitment/candidates/${id}`),
  updateCandidateStatus: (id: string, status: string) =>
    request<any>(CORE_API_URL, `/api/v1/recruitment/candidates/${id}/status`, { method: "PUT", body: JSON.stringify({ status }) }),
  getOnboardingSummary: () =>
    request<{ totalCases: number; notStarted: number; inProgress: number; completed: number }>(
      CORE_API_URL, "/api/v1/onboarding/summary",
    ),
  getOnboardingCases: (params?: { department?: string; status?: string }) => {
    const clean: Record<string, string> = {};
    if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") clean[k] = String(v);
    const qs = new URLSearchParams(clean).toString();
    return request<{ count: number; data: any[] }>(CORE_API_URL, `/api/v1/onboarding/cases${qs ? `?${qs}` : ""}`);
  },
  getOnboardingCaseDetail: (id: string) => request<any>(CORE_API_URL, `/api/v1/onboarding/cases/${id}`),
  updateOnboardingTaskStatus: (taskId: string, status: string) =>
    request<any>(CORE_API_URL, `/api/v1/onboarding/tasks/${taskId}/status`, { method: "PUT", body: JSON.stringify({ status }) }),
  getRecentChatMessages: (limit = 6) =>
    request<{ data: { id: string; userId: string; role: "user" | "ai"; text: string; redirectPath: string | null; redirectLabel: string | null; createdAt: string }[] }>(
      CORE_API_URL, `/api/v1/copilot/messages/recent?limit=${limit}`,
    ),
  postChatMessage: (msg: { role: "user" | "ai"; text: string; redirectPath?: string; redirectLabel?: string }) =>
    request<{ data: unknown }>(CORE_API_URL, "/api/v1/copilot/messages", { method: "POST", body: JSON.stringify(msg) }),
};

async function downloadBlob(path: string, body: unknown): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${AI_API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, "Report generation failed");
  return res.blob();
}

export const aiApi = {
  // Streams the reply token-by-token (NDJSON lines from server-ai) instead
  // of waiting for the full completion — onDelta fires with the
  // accumulated-so-far text on every chunk so the caller can render it live.
  chat: async (query: string, recentContext: string | undefined, onDelta?: (textSoFar: string) => void) => {
    const token = getToken();
    const res = await fetch(`${AI_API_URL}/api/v1/copilot/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ query, recentContext }),
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}) as any);
      throw new ApiError(res.status, body.error || "Chat request failed");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let response = "";
    let streamError: string | null = null;
    let meta: {
      citations?: string[];
      employeeId?: string;
      reportType?: ReportType | null;
      redirect?: { path: string; label: string } | null;
      quickActions?: QuickAction[];
    } = {};

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line);
        if (chunk.error) streamError = chunk.error;
        else if (chunk.delta) { response += chunk.delta; onDelta?.(response); }
        else if (chunk.done) meta = chunk;
      }
    }
    if (streamError) throw new ApiError(503, streamError);

    return {
      query, response, confidence: 0.85,
      citations: meta.citations ?? [],
      employeeId: meta.employeeId,
      reportType: meta.reportType ?? null,
      redirect: meta.redirect ?? null,
      quickActions: meta.quickActions ?? [],
    };
  },
  draftGrievanceEmail: (payload: { subject: string; description: string; category: string; submitterName?: string | null }) =>
    request<{ subject: string; body: string }>(
      AI_API_URL, "/api/v1/grievances/draft-email", { method: "POST", body: JSON.stringify(payload) },
    ),
  draftEmergencyMessage: (payload: { title: string; description: string; category: string; department: string; severity: string; location?: string | null }) =>
    request<{ subject: string; body: string }>(
      AI_API_URL, "/api/v1/emergency/draft-alert-message", { method: "POST", body: JSON.stringify(payload) },
    ),
  downloadServiceRecordReport: async (employeeId: string) => {
    const token = getToken();
    const res = await fetch(`${AI_API_URL}/api/v1/reports/employee/${employeeId}/service-record`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) throw new ApiError(res.status, "Report generation failed");
    return res.blob();
  },
  downloadDepartmentDigestReport: (departments: unknown[], context?: { question: string; answer: string }) =>
    downloadBlob("/api/v1/reports/department-digest", { departments, context }),
  downloadRiskSummaryReport: (grievances: unknown[], legalCases: unknown[], context?: { question: string; answer: string }) =>
    downloadBlob("/api/v1/reports/risk-summary", { grievances, legalCases, context }),
  uploadServiceBook: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const token = getToken();
    return fetch(`${AI_API_URL}/api/v1/digitization/upload`, {
      method: "POST",
      body: form,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }).then(async (res) => {
      if (!res.ok) throw new ApiError(res.status, "Upload failed");
      return res.json();
    });
  },
};
