import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Panel, Pill, Section } from "@/components/layout/section";
import { SearchPill } from "@/components/ui/search-pill";
import { Pager } from "@/components/ui/pager";
import { coreApi, aiApi, ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { CHART_TOOLTIP_STYLE, CHART_ANIMATION } from "@/lib/chart-theme";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  IndianRupee, TrendingUp, Receipt,
  AlertTriangle, ShieldCheck, Zap, ArrowUpRight, ArrowDownRight, Bot,
  Users, Clock, Banknote, Download, Mail, CheckCircle2,
  Database, Server, RefreshCw, WifiOff,
} from "lucide-react";
import {
  ComposedChart, Area, Bar, BarChart, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Legend, LineChart, Line,
  PieChart, Pie, Cell
} from "recharts";

export const Route = createFileRoute("/finance")({
  head: () => ({
    meta: [
      { title: "AI Finance Intelligence · AWIP" },
    ],
  }),
  component: FinancePage,
});

/* ─── Payroll component chart palette (keyed by real component name) ─── */

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const EXPENSE_PAGE_SIZE = 10;

const PAY_COMPONENT_FILL: Record<string, string> = {
  "Basic Salary Pay": "var(--color-primary)",
  "Dearness Allowance (DA)": "var(--color-info)",
  "House Rent Allowance (HRA)": "var(--color-success)",
  "Other Allowances": "var(--color-warning)",
};

/* ─── Systems not yet integrated — a static roadmap, not a live status board ─── */

const PLANNED_INTEGRATIONS = [
  { name: "SAP HCM", icon: Server },
  { name: "Oracle HRMS", icon: Database },
  { name: "Tally ERP", icon: Server },
  { name: "NIC ePayroll", icon: Database },
];

const TOOLTIP_STYLE = CHART_TOOLTIP_STYLE;

type MainTab = "AI Intelligence" | "Payroll Management" | "System Connectors";
type PayrollSubTab = "Payroll Dashboard" | "Payslip Viewer" | "Processing Pipeline";

/* ─── Tab Component ─── */

function TabBar<T extends string>({ tabs, active, onChange }: { tabs: T[]; active: T; onChange: (t: T) => void }) {
  return (
    <div className="flex gap-0 border-b border-border overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={cn(
            "px-5 py-3 text-sm font-medium whitespace-nowrap transition-all relative",
            active === t
              ? "text-primary"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t}
          {active === t && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t" />
          )}
        </button>
      ))}
    </div>
  );
}

/* ─── Main Page ─── */

function FinancePage() {
  const [activeTab, setActiveTab] = useState<MainTab>("AI Intelligence");
  const [payrollSubTab, setPayrollSubTab] = useState<PayrollSubTab>("Payroll Dashboard");
  const [payslipSearch, setPayslipSearch] = useState("");
  const [payslipEmployeeId, setPayslipEmployeeId] = useState<string | null>(null);
  const [payslipError, setPayslipError] = useState<string | null>(null);
  const [downloadingPayslip, setDownloadingPayslip] = useState(false);
  const [resolvedAlerts, setResolvedAlerts] = useState<string[]>([]);
  const [expensePage, setExpensePage] = useState(1);

  const { data: payroll } = useQuery({
    queryKey: ["payroll-summary"],
    queryFn: () => coreApi.getPayrollSummary(),
  });
  const { data: alertsResp } = useQuery({
    queryKey: ["workforce-alerts"],
    queryFn: () => coreApi.getWorkforceAlerts(),
  });
  const { data: expensesResp, isFetching: expensesLoading, refetch: refetchExpenses } = useQuery({
    queryKey: ["finance-expenses"],
    queryFn: () => coreApi.getExpenses(),
  });
  const payComponentData = useMemo(
    () => (alertsResp?.payroll?.components ?? []).map((c) => ({ name: c.component, value: c.pct, fill: PAY_COMPONENT_FILL[c.component] ?? "var(--color-muted-foreground)" })),
    [alertsResp],
  );
  const { data: payrollTrend } = useQuery({
    queryKey: ["payroll-trend"],
    queryFn: () => coreApi.getPayrollTrend(),
  });
  const { data: departmentsResp } = useQuery({
    queryKey: ["departments"],
    queryFn: () => coreApi.getDepartments(),
  });
  const deptNameById = useMemo(
    () => new Map((departmentsResp?.data ?? []).map((d: { id: string; name: string }) => [d.id, d.name])),
    [departmentsResp],
  );
  const { data: budgetVarianceResp } = useQuery({
    queryKey: ["budget-variance"],
    queryFn: () => coreApi.getBudgetVariance(),
  });
  const budgetOptimization = useMemo(() => {
    return (budgetVarianceResp?.data ?? [])
      .map((d) => {
        const usedPct = d.allocated ? Math.round((d.spent / d.allocated) * 100) : 0;
        const colorClass = usedPct >= 90 ? "bg-destructive" : usedPct >= 75 ? "bg-warning" : usedPct >= 50 ? "bg-info" : "bg-success";
        const trend = usedPct >= 90 ? "Critical limit" : usedPct >= 75 ? "High Burn Rate" : usedPct >= 50 ? "On Track" : "Underutilized";
        return { name: deptNameById.get(d.department) ?? d.department, used: usedPct, trend, colorClass, variancePct: d.variancePct };
      })
      .sort((a, b) => b.used - a.used)
      .slice(0, 4);
  }, [budgetVarianceResp, deptNameById]);
  const worstBudgetDept = budgetOptimization[0];
  const { data: payrollByDeptResp } = useQuery({
    queryKey: ["budget-variance", "Salary"],
    queryFn: () => coreApi.getBudgetVariance({ category: "Salary" }),
  });
  const deptPayrollData = useMemo(() => {
    return (payrollByDeptResp?.data ?? [])
      .map((d) => ({ dept: deptNameById.get(d.department) ?? d.department, amount: Math.round((d.avgMonthlySpent / 1e7) * 10) / 10 }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 8);
  }, [payrollByDeptResp, deptNameById]);
  const monthLabel = (ym: string) => {
    const [y, m] = ym.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short" });
  };
  const payrollChartData = (payrollTrend?.data ?? []).map((r) => ({ m: monthLabel(r.month), actual: r.actual, predicted: r.predicted }));
  // Real actual spend only, last 6 months — no year-over-year line here since
  // the seeded history only spans ~12 months total, not the 2 full years a
  // genuine YoY comparison would need; showing a second fabricated line would
  // repeat the exact anti-pattern we just removed from the chart above.
  const monthlyActualTrend = (payrollTrend?.data ?? [])
    .filter((r) => r.actual != null)
    .slice(-6)
    .map((r) => ({ month: monthLabel(r.month), amount: r.actual }));
  // A separate metric from Command Centre's "Payroll This Month" — that one
  // is real gross compensation (Basic+DA+HRA) across all employees, which
  // Compensation only stores as a current snapshot with no month-by-month
  // history to project from. This projects the Salary *budget category*
  // instead, the only slice with 12 real months of history to fit a trend on.
  const projectedSalaryBudget = useMemo(() => {
    const rows = payrollTrend?.data ?? [];
    const nextMonth = rows.find((r) => r.actual == null && r.predicted != null);
    const lastActual = [...rows].reverse().find((r) => r.actual != null);
    if (!nextMonth || !lastActual?.actual) return { label: "Projected Salary Budget (Next Month)", value: "—", trend: "Awaiting data", isUp: true, icon: IndianRupee, tone: undefined as string | undefined };
    const changePct = Math.round(((nextMonth.predicted! - lastActual.actual) / lastActual.actual) * 1000) / 10;
    return {
      label: "Projected Salary Budget (Next Month)",
      value: `₹${nextMonth.predicted!.toFixed(1)} Cr`,
      trend: `${changePct >= 0 ? "+" : ""}${changePct}% · ${payrollTrend?.confidence}% confidence`,
      isUp: changePct >= 0,
      icon: IndianRupee,
      tone: undefined as string | undefined,
    };
  }, [payrollTrend]);
  // Real org-wide budget utilization, computed from the same budget-variance
  // rows that drive the department breakdown below — no separately fabricated
  // FY% figure that could drift from what Budget Optimization actually shows.
  const budgetUtilizationKpi = useMemo(() => {
    const rows = budgetVarianceResp?.data ?? [];
    const totalAllocated = rows.reduce((s, d) => s + d.allocated, 0);
    const totalSpent = rows.reduce((s, d) => s + d.spent, 0);
    const pct = totalAllocated ? Math.round((totalSpent / totalAllocated) * 1000) / 10 : 0;
    return {
      label: "Budget Utilization (FY)", value: `${pct}%`,
      trend: pct >= 90 ? "Critical limit" : pct >= 75 ? "High burn rate" : "On Track",
      isUp: pct < 90, icon: TrendingUp, tone: pct >= 90 ? "destructive" as const : undefined,
    };
  }, [budgetVarianceResp]);
  const anomalyKpis = useMemo(() => {
    const flaggedCount = expensesResp?.kpis.flaggedCount ?? 0;
    const autoApprovedAmount = expensesResp?.kpis.autoApprovedAmount ?? 0;
    return [
      { label: "Flagged Anomalies", value: String(flaggedCount), trend: flaggedCount ? "Rule-based flags" : "None flagged", isUp: flaggedCount === 0, icon: AlertTriangle, tone: flaggedCount ? "destructive" as const : undefined },
      { label: "Auto-Approved Expenses", value: `₹${(autoApprovedAmount / 1e5).toFixed(1)} L`, trend: "No anomaly rule triggered", isUp: true, icon: Zap },
    ];
  }, [expensesResp]);
  const displayKpis = [projectedSalaryBudget, budgetUtilizationKpi, ...anomalyKpis];
  const expenseRows = expensesResp?.data ?? [];
  const expenseTotalPages = Math.max(1, Math.ceil(expenseRows.length / EXPENSE_PAGE_SIZE));
  const visibleExpenses = expenseRows.slice((expensePage - 1) * EXPENSE_PAGE_SIZE, expensePage * EXPENSE_PAGE_SIZE);
  const payrollKpis = useMemo(() => [
    { label: "Total Disbursement", value: payroll?.totalDisbursement ?? "—", trend: "+1.2% MoM", isUp: true, icon: Banknote },
    { label: "Employees Processed", value: payroll?.processedEmployees?.toLocaleString("en-IN") ?? "—", trend: "+126 new", isUp: true, icon: Users },
    { label: "Pending Approvals", value: String(payroll?.pendingApprovals ?? "—"), trend: "Needs action", isUp: false, icon: Clock, tone: "warning" },
    { label: "Arrears Pending", value: payroll?.arrearsPending ?? "—", trend: "3 depts", isUp: false, icon: AlertTriangle, tone: "destructive" },
  ], [payroll]);

  const { data: payslip, isFetching: payslipLoading } = useQuery({
    queryKey: ["payslip", payslipEmployeeId],
    queryFn: () => coreApi.getEmployeePayslip(payslipEmployeeId!),
    enabled: !!payslipEmployeeId,
  });

  const downloadPayslipPdf = async () => {
    if (!payslip) return;
    setDownloadingPayslip(true);
    try {
      saveBlob(await aiApi.downloadServiceRecordReport(payslip.employeeId), `payslip-${payslip.employeeId}.pdf`);
      toast.success("Payslip PDF downloaded");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Payslip download failed — is server-ai running?");
    } finally {
      setDownloadingPayslip(false);
    }
  };

  const downloadCostOptimizationReport = () => {
    if (!budgetOptimization.length) {
      toast.error("No budget data available yet — try again in a moment.");
      return;
    }
    const escape = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const headers = ["Department", "Budget Used %", "Variance %", "Status"];
    const rows = budgetOptimization.map((d) => [d.name, d.used, d.variancePct, d.trend]);
    const csv = [headers, ...rows].map((r) => r.map(escape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "AMC_Finance_Cost_Optimization.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success("Cost Optimization Report downloaded");
  };

  const handlePayslipSearch = async () => {
    const term = payslipSearch.trim();
    if (!term) return;
    setPayslipError(null);
    try {
      const res = await coreApi.getEmployees({ q: term, limit: 1 });
      const match = res.data[0];
      if (!match) {
        setPayslipEmployeeId(null);
        setPayslipError(`No employee found matching "${term}"`);
        return;
      }
      setPayslipEmployeeId(match.id);
    } catch {
      setPayslipEmployeeId(null);
      setPayslipError("Search failed — please try again");
    }
  };

  return (
    <div className="p-5 space-y-6 max-w-[1600px] mx-auto min-h-[calc(100vh-3.5rem)]">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">AI Financial Intelligence Hub</h1>
          <p className="text-sm text-muted-foreground mt-1">Predictive payroll forecasting, budget optimization, and anomaly detection.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={downloadCostOptimizationReport}
            className="bg-card text-foreground border border-border hover:bg-muted/30 px-4 py-2 rounded-lg flex items-center gap-2 text-sm font-semibold shadow-sm w-fit cursor-pointer transition-colors"
          >
            <Download className="size-4 text-primary" /> Cost Optimization Report
          </button>
          <div className="bg-primary/10 text-primary border border-primary/20 px-4 py-2 rounded-lg flex items-center gap-2 text-sm font-semibold shadow-sm w-fit select-none">
            <Bot className="size-4" /> AI Copilot Active
          </div>
        </div>
      </div>

      {/* Main Tab Navigation */}
      <TabBar<MainTab>
        tabs={["AI Intelligence", "Payroll Management", "System Connectors"]}
        active={activeTab}
        onChange={setActiveTab}
      />

      {/* ═══════════════════════════════════════════ */}
      {/* TAB 1: AI Intelligence (existing content)  */}
      {/* ═══════════════════════════════════════════ */}
      {activeTab === "AI Intelligence" && (
        <div className="space-y-6">
          {/* KPIs */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {displayKpis.map((k) => (
              <Panel key={k.label} className="p-5 flex flex-col justify-between shadow-sm">
                <div className="flex items-start justify-between mb-4">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{k.label}</div>
                  <div className={cn("size-9 rounded-full bg-primary/10 grid place-items-center shrink-0", k.tone === "destructive" ? "text-destructive" : "text-success")}>
                    <k.icon className="size-4" />
                  </div>
                </div>
                <div>
                  <div className="text-2xl font-semibold tracking-tight text-foreground mb-2 tabular-nums">{k.value}</div>
                  <div className={cn("text-xs font-medium flex items-center gap-1", k.tone === "destructive" ? "text-destructive" : "text-success")}>
                    {k.isUp ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
                    {k.trend}
                  </div>
                </div>
              </Panel>
            ))}
          </div>

          {/* Main Dashboard Section 1: Chart & Budget Optimization side-by-side */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
            <div className="lg:col-span-2">
              <Section
                title="Salary Budget Trend (₹ Crore)"
                subtitle={
                  payrollTrend
                    ? `Department "Salary" budget category · trend fit over ${(payrollTrend.data ?? []).filter((r) => r.actual != null).length} months of real spend · ${payrollTrend.confidence}% confidence — a different figure from Command Centre's gross payroll disbursement`
                    : "Department \"Salary\" budget category, trend fit over real historical spend"
                }
              >
                <Panel className="p-4 shadow-sm border-2 border-primary/40">
                  <ResponsiveContainer width="100%" height={300}>
                    <ComposedChart data={payrollChartData} margin={{ top: 20, right: 20, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                      <XAxis dataKey="m" tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} axisLine={false} tickLine={false} domain={['auto', 'auto']} />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        itemStyle={{ fontSize: '12px' }}
                        labelStyle={{ fontSize: '12px', fontWeight: 'bold', color: 'var(--color-foreground)' }}
                      />
                      <Legend wrapperStyle={{ fontSize: '12px' }} />
                      <Bar dataKey="actual" name="Actual Spend" fill="var(--color-primary)" radius={[4, 4, 0, 0]} barSize={32} {...CHART_ANIMATION} />
                      <Area type="monotone" dataKey="predicted" name="AI Forecast" fill="var(--color-success)" stroke="var(--color-success)" strokeWidth={2} fillOpacity={0.15} strokeDasharray="5 5" {...CHART_ANIMATION} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </Panel>
              </Section>
            </div>

            {/* Budget Optimization */}
            <div className="lg:col-span-1">
              <Section title="Budget Optimization" subtitle="Department-wise allocation vs utilization">
                <Panel className="p-4 shadow-sm border-2 border-primary/40">
                  <div className="space-y-3.5">
                    {budgetOptimization.map((dept) => (
                      <div key={dept.name}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="font-semibold text-foreground">{dept.name}</span>
                          <span className="text-muted-foreground">{dept.used}% used</span>
                        </div>
                        <div className="h-2 w-full bg-muted rounded-full overflow-hidden mb-1">
                          <div className={cn("h-full rounded-full transition-all", dept.colorClass)} style={{ width: `${Math.min(dept.used, 100)}%` }} />
                        </div>
                        <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider text-right">
                          {dept.trend === "Critical limit" ? (
                            <span className="text-destructive flex items-center justify-end gap-1"><AlertTriangle className="size-3" /> {dept.trend}</span>
                          ) : (
                            dept.trend
                          )}
                        </div>
                      </div>
                    ))}

                    {worstBudgetDept && (
                      <div className="mt-3 bg-warning/10 border border-warning/20 rounded-xl p-3.5">
                        <div className="flex items-start gap-2">
                          <div className="font-bold text-warning-foreground shrink-0 text-xs uppercase tracking-wider">AI Recommendation</div>
                        </div>
                        <p className="text-xs text-warning-foreground/80 mt-1.5 leading-relaxed">
                          {worstBudgetDept.name} is running at {worstBudgetDept.used}% of its allocated FY budget
                          {worstBudgetDept.variancePct > 0 ? `, ${worstBudgetDept.variancePct}% over allocation` : ""}.
                          {worstBudgetDept.used >= 90
                            ? " Recommend freezing non-essential capex until Q4 review."
                            : " Monitor spend pace against remaining allocation."}
                        </p>
                        <button className="mt-2.5 bg-warning text-[#4A3800] text-xs font-semibold px-3 py-1.5 rounded-full hover:opacity-90 transition-opacity shadow-sm">
                          Apply Budget Freeze
                        </button>
                      </div>
                    )}
                  </div>
                </Panel>
              </Section>
            </div>
          </div>

          {/* Full-width Expense & Anomaly Auditor Workbench */}
          <Section
            title="Expense & Anomaly Auditor"
            subtitle="Rule-based scan across vendor payments and employee claims — amount outliers vs. department average, duplicate submitter/amount within 7 days"
            action={
              <button
                onClick={() => refetchExpenses()}
                className="text-xs bg-primary/10 text-primary border border-primary/20 hover:bg-primary hover:text-primary-foreground px-3 py-1.5 rounded-full font-semibold cursor-pointer transition-colors flex items-center gap-1.5"
              >
                <RefreshCw className={cn("size-3", expensesLoading && "animate-spin")} /> Re-Scan
              </button>
            }
          >
            <Panel className="shadow-sm overflow-hidden min-h-[300px] flex flex-col justify-center border-2 border-primary/40">
              {expensesLoading && !expensesResp ? (
                <div className="p-8 text-center text-xs text-muted-foreground">Scanning expense records…</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-sidebar text-[10px] uppercase font-semibold text-sidebar-foreground tracking-wider">
                      <tr>
                        <th className="px-4 py-3">Claim ID</th>
                        <th className="px-4 py-3">Type</th>
                        <th className="px-4 py-3">Submitter</th>
                        <th className="px-4 py-3">Amount</th>
                        <th className="px-4 py-3 text-center">Risk</th>
                        <th className="px-4 py-3">Diagnostic Status</th>
                        <th className="px-4 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {visibleExpenses.map((e, i) => {
                        const isResolved = resolvedAlerts.includes(e.id);
                        return (
                          <tr key={e.id} className={cn("hover:bg-surface-muted/70 transition-colors", isResolved ? "opacity-60 bg-muted/10" : i % 2 === 1 ? "bg-surface-muted" : "")}>
                            <td className="px-4 py-3 font-medium text-foreground">{e.id}</td>
                            <td className="px-4 py-3 text-muted-foreground flex items-center gap-2">
                              <Receipt className="size-3.5 text-muted-foreground/50" /> {e.type}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">{e.submitter}</td>
                            <td className="px-4 py-3 font-semibold text-foreground">₹{e.amount.toLocaleString("en-IN")}</td>
                            <td className="px-4 py-3 text-center">
                              <span className={cn(
                                "inline-flex items-center justify-center px-2.5 py-0.5 text-xs font-semibold rounded-full",
                                isResolved ? "bg-muted text-muted-foreground" : e.risk === "Low" ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"
                              )}>
                                {isResolved ? "Cleared" : e.risk}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              {isResolved ? (
                                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                                  <CheckCircle2 className="size-4 text-success" /> Resolved & Documented
                                </span>
                              ) : !e.flagged ? (
                                <span className="flex items-center gap-1.5 text-xs font-medium text-success">
                                  <ShieldCheck className="size-4" /> {e.action}
                                </span>
                              ) : (
                                <div className="flex flex-col gap-0.5">
                                  <span className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
                                    <AlertTriangle className="size-4" /> Anomalous Activity
                                  </span>
                                  <span className="text-[10px] text-muted-foreground italic pl-5">{e.action}</span>
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {isResolved ? (
                                <span className="text-xs text-muted-foreground">Verified</span>
                              ) : !e.flagged ? (
                                <span className="text-xs text-success font-medium">Auto approved</span>
                              ) : (
                                <div className="flex justify-end gap-1.5">
                                  <button
                                    onClick={() => {
                                      setResolvedAlerts(prev => [...prev, e.id]);
                                      toast.success(`Claim ${e.id} approved & cleared.`);
                                    }}
                                    className="bg-success/15 hover:bg-success hover:text-success-foreground text-success text-[10px] font-semibold px-2.5 py-1 rounded-full transition-colors cursor-pointer"
                                  >
                                    Approve
                                  </button>
                                  <button
                                    onClick={() => {
                                      setResolvedAlerts(prev => [...prev, e.id]);
                                      toast.error(`Disbursement ${e.id} frozen. Escalated to Commissioner.`);
                                    }}
                                    className="bg-destructive/15 hover:bg-destructive hover:text-destructive-foreground text-destructive text-[10px] font-semibold px-2.5 py-1 rounded-full transition-colors cursor-pointer"
                                  >
                                    Freeze Pay
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {expenseTotalPages > 1 && <Pager page={expensePage} totalPages={expenseTotalPages} onChange={setExpensePage} />}
            </Panel>
          </Section>
        </div>
      )}

      {/* ═══════════════════════════════════════════ */}
      {/* TAB 2: Payroll Management                  */}
      {/* ═══════════════════════════════════════════ */}
      {activeTab === "Payroll Management" && (
        <div className="space-y-6">
          <TabBar<PayrollSubTab>
            tabs={["Payroll Dashboard", "Payslip Viewer", "Processing Pipeline"]}
            active={payrollSubTab}
            onChange={setPayrollSubTab}
          />

          {/* ── Payroll Dashboard ── */}
          {payrollSubTab === "Payroll Dashboard" && (
            <div className="space-y-6">
              {/* KPI Cards */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {payrollKpis.map((k) => (
                  <Panel key={k.label} className={cn(
                    "p-5 flex flex-col justify-between shadow-sm border-2",
                    k.tone === "destructive" ? "border-destructive/40"
                      : k.tone === "warning" ? "border-warning/50"
                      : "border-success/40"
                  )}>
                    <div className="flex items-start justify-between mb-4">
                      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{k.label}</div>
                      <div className={cn(
                        "size-8 rounded-lg bg-surface-muted grid place-items-center shrink-0",
                        k.tone === "destructive" ? "text-destructive"
                          : k.tone === "warning" ? "text-warning-foreground"
                          : "text-success"
                      )}>
                        <k.icon className="size-4" />
                      </div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-foreground mb-2 tabular-nums">{k.value}</div>
                      <div className={cn(
                        "text-xs font-medium flex items-center gap-1",
                        k.tone === "destructive" ? "text-destructive"
                          : k.tone === "warning" ? "text-warning-foreground"
                          : "text-success"
                      )}>
                        {k.isUp ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
                        {k.trend}
                      </div>
                    </div>
                  </Panel>
                ))}
              </div>

              {/* Charts Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Department-wise Payroll Breakdown */}
                <Section title="Department-wise Payroll Breakdown" subtitle="Top 8 departments by monthly payroll (₹ Crore)">
                  <Panel className="p-4 shadow-sm border-2 border-primary/40">
                    <ResponsiveContainer width="100%" height={320}>
                      <BarChart data={deptPayrollData} layout="vertical" margin={{ top: 5, right: 30, bottom: 5, left: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} axisLine={false} tickLine={false} />
                        <YAxis dataKey="dept" type="category" tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} axisLine={false} tickLine={false} width={120} />
                        <Tooltip contentStyle={TOOLTIP_STYLE} />
                        <Bar dataKey="amount" name="Payroll (₹ Cr)" fill="var(--color-primary)" radius={[0, 4, 4, 0]} barSize={20} {...CHART_ANIMATION} />
                      </BarChart>
                    </ResponsiveContainer>
                  </Panel>
                </Section>

                {/* Pay Component Split */}
                <Section title="Pay Component Split" subtitle="Salary composition across all employees">
                  <Panel className="p-4 shadow-sm border-2 border-primary/40">
                    <ResponsiveContainer width="100%" height={320}>
                      <PieChart>
                        <Pie
                          data={payComponentData}
                          cx="50%"
                          cy="50%"
                          innerRadius={65}
                          outerRadius={110}
                          paddingAngle={3}
                          dataKey="value"
                          label={({ name, value }) => `${name} ${value}%`}
                          labelLine={{ stroke: "var(--color-muted-foreground)", strokeWidth: 1 }}
                        >
                          {payComponentData.map((entry, i) => (
                            <Cell key={i} fill={entry.fill} />
                          ))}
                        </Pie>
                        <Tooltip contentStyle={TOOLTIP_STYLE} />
                      </PieChart>
                    </ResponsiveContainer>
                  </Panel>
                </Section>
              </div>

              {/* Monthly Payroll Trend */}
              <Section title="Monthly Salary Spend" subtitle="Last 6 months, actual spend (Salary budget category, ₹ Crore)">
                <Panel className="p-4 shadow-sm border-2 border-primary/40">
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={monthlyActualTrend} margin={{ top: 20, right: 30, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                      <XAxis dataKey="month" tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} axisLine={false} tickLine={false} domain={['auto', 'auto']} />
                      <Tooltip contentStyle={TOOLTIP_STYLE} />
                      <Legend wrapperStyle={{ fontSize: '12px' }} />
                      <Line type="monotone" dataKey="amount" name="Actual Spend" stroke="var(--color-primary)" strokeWidth={2.5} dot={{ r: 4, fill: "var(--color-primary)" }} {...CHART_ANIMATION} />
                    </LineChart>
                  </ResponsiveContainer>
                </Panel>
              </Section>
            </div>
          )}

          {/* ── Payslip Viewer ── */}
          {payrollSubTab === "Payslip Viewer" && (
            <div className="space-y-6">
              {/* Search Bar */}
              <Panel className="p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <SearchPill
                    value={payslipSearch}
                    onChange={setPayslipSearch}
                    onKeyDown={(e) => e.key === "Enter" && handlePayslipSearch()}
                    placeholder="Search by Employee ID or Name…"
                    className="flex-1"
                  />
                  <button
                    onClick={handlePayslipSearch}
                    className="h-10 bg-primary text-primary-foreground px-5 rounded-full text-sm font-medium hover:opacity-90 transition-opacity shadow-sm"
                  >
                    Search
                  </button>
                </div>
                {payslipError && <p className="text-xs text-destructive mt-2">{payslipError}</p>}
              </Panel>

              {/* Payslip Card */}
              {payslipLoading && (
                <Panel className="p-8 shadow-sm text-center text-xs text-muted-foreground">Loading payslip…</Panel>
              )}
              {payslip && (
                <Panel className="p-0 shadow-sm overflow-hidden">
                  {/* Payslip Header */}
                  <div className="bg-primary/5 border-b border-border px-6 py-5">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-bold text-foreground">{payslip.name}</h3>
                        <p className="text-sm text-muted-foreground">{payslip.employeeId} · {payslip.designation} · {payslip.department}</p>
                      </div>
                      <div className="text-right">
                        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Pay Period</div>
                        <div className="text-sm font-bold text-foreground">{payslip.payPeriod}</div>
                      </div>
                    </div>
                  </div>

                  <div className="p-6 space-y-6">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      {/* Earnings */}
                      <div>
                        <h4 className="text-xs font-bold text-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                          <ArrowUpRight className="size-3.5 text-success" /> Earnings
                        </h4>
                        <div className="border border-border rounded-lg overflow-hidden">
                          <table className="w-full text-sm">
                            <tbody className="divide-y divide-border">
                              {[
                                { component: "Basic Pay", amount: payslip.earnings.basicPay },
                                { component: "Dearness Allowance", amount: payslip.earnings.daAmount },
                                { component: "HRA", amount: payslip.earnings.hraAmount },
                              ].map((row) => (
                                <tr key={row.component} className="hover:bg-surface-muted/30">
                                  <td className="px-4 py-2.5 text-muted-foreground">{row.component}</td>
                                  <td className="px-4 py-2.5 text-right font-medium text-foreground tabular-nums">₹{row.amount.toLocaleString("en-IN")}</td>
                                </tr>
                              ))}
                            </tbody>
                            <tfoot className="border-t-2 border-border bg-success/5">
                              <tr>
                                <td className="px-4 py-3 font-bold text-foreground text-sm">Gross Earnings</td>
                                <td className="px-4 py-3 text-right font-bold text-foreground text-sm tabular-nums">₹{payslip.earnings.grossPay.toLocaleString("en-IN")}</td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      </div>

                      {/* Deductions */}
                      <div>
                        <h4 className="text-xs font-bold text-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                          <ArrowDownRight className="size-3.5 text-destructive" /> Deductions
                        </h4>
                        <div className="border border-border rounded-lg overflow-hidden">
                          <table className="w-full text-sm">
                            <tbody className="divide-y divide-border">
                              {[
                                { component: "Provident Fund (PF)", amount: payslip.deductions.pfContribution },
                                ...(payslip.deductions.esicContribution > 0 ? [{ component: "ESIC", amount: payslip.deductions.esicContribution }] : []),
                                { component: "Income Tax (TDS)", amount: payslip.deductions.tdsDeduction },
                              ].map((row) => (
                                <tr key={row.component} className="hover:bg-surface-muted/30">
                                  <td className="px-4 py-2.5 text-muted-foreground">{row.component}</td>
                                  <td className="px-4 py-2.5 text-right font-medium text-foreground tabular-nums">₹{row.amount.toLocaleString("en-IN")}</td>
                                </tr>
                              ))}
                            </tbody>
                            <tfoot className="border-t-2 border-border bg-destructive/5">
                              <tr>
                                <td className="px-4 py-3 font-bold text-foreground text-sm">Total Deductions</td>
                                <td className="px-4 py-3 text-right font-bold text-foreground text-sm tabular-nums">₹{payslip.deductions.totalDeductions.toLocaleString("en-IN")}</td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      </div>
                    </div>

                    {/* Net Pay */}
                    <div className="bg-success/10 border border-success/20 rounded-lg p-5 text-center">
                      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Net Pay</div>
                      <div className="text-3xl font-bold text-success tabular-nums">₹{payslip.netPay.toLocaleString("en-IN")}</div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-3">
                      <button
                        onClick={downloadPayslipPdf}
                        disabled={downloadingPayslip}
                        className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2.5 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity shadow-sm disabled:opacity-60"
                      >
                        <Download className="size-4" /> {downloadingPayslip ? "Preparing…" : "Download PDF"}
                      </button>
                      <button className="inline-flex items-center gap-2 bg-card border border-border text-foreground px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-surface-muted transition-colors shadow-sm">
                        <Mail className="size-4" /> Email Payslip
                      </button>
                    </div>
                  </div>
                </Panel>
              )}
            </div>
          )}

          {/* ── Processing Pipeline ── */}
          {payrollSubTab === "Processing Pipeline" && (
            <div className="space-y-6">
              {/* Latest real payroll run snapshot — a point-in-time read of
                  PayrollSummary, not a simulated live log. */}
              <Section
                title="Latest Payroll Run"
                subtitle={payroll?.updatedAt ? `Last computed ${new Date(payroll.updatedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : "Awaiting data"}
              >
                <Panel className="p-6 shadow-sm">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="flex flex-col items-center text-center gap-2 p-4 rounded-lg bg-surface-muted/50">
                      <div className="size-11 rounded-full bg-success/10 text-success grid place-items-center"><CheckCircle2 className="size-5" /></div>
                      <div className="text-xs font-bold text-foreground">Employees Processed</div>
                      <div className="text-lg font-bold text-foreground tabular-nums">{payroll?.processedEmployees?.toLocaleString("en-IN") ?? "—"}</div>
                    </div>
                    <div className="flex flex-col items-center text-center gap-2 p-4 rounded-lg bg-surface-muted/50">
                      <div className="size-11 rounded-full bg-primary/10 text-primary grid place-items-center"><Banknote className="size-5" /></div>
                      <div className="text-xs font-bold text-foreground">Total Disbursement</div>
                      <div className="text-lg font-bold text-foreground tabular-nums">{payroll?.totalDisbursement ?? "—"}</div>
                    </div>
                    <div className="flex flex-col items-center text-center gap-2 p-4 rounded-lg bg-surface-muted/50">
                      <div className="size-11 rounded-full bg-warning/10 text-warning-foreground grid place-items-center"><Clock className="size-5" /></div>
                      <div className="text-xs font-bold text-foreground">Pending Approvals</div>
                      <div className="text-lg font-bold text-foreground tabular-nums">{payroll?.pendingApprovals ?? "—"}</div>
                    </div>
                    <div className="flex flex-col items-center text-center gap-2 p-4 rounded-lg bg-surface-muted/50">
                      <div className="size-11 rounded-full bg-destructive/10 text-destructive grid place-items-center"><AlertTriangle className="size-5" /></div>
                      <div className="text-xs font-bold text-foreground">Arrears Pending</div>
                      <div className="text-lg font-bold text-foreground tabular-nums">{payroll?.arrearsPending ?? "—"}</div>
                    </div>
                  </div>
                </Panel>
              </Section>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════ */}
      {/* TAB 3: System Connectors                   */}
      {/* ═══════════════════════════════════════════ */}
      {activeTab === "System Connectors" && (
        <div className="space-y-6">
          <Section title="Planned Integrations" subtitle="External HR/payroll systems on the integration roadmap — none are connected yet">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {PLANNED_INTEGRATIONS.map((c) => (
                <Panel key={c.name} className="p-5 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="size-10 rounded-lg bg-surface-muted grid place-items-center text-muted-foreground">
                        <c.icon className="size-5" />
                      </div>
                      <div className="text-sm font-bold text-foreground">{c.name}</div>
                    </div>
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold rounded-full bg-muted text-muted-foreground">
                      <WifiOff className="size-3" /> Not Connected
                    </span>
                  </div>
                </Panel>
              ))}
            </div>
          </Section>

          <Panel className="p-5 shadow-sm border-dashed">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <div className="text-sm font-bold text-foreground mb-1">Request an Integration</div>
                <div className="text-xs text-muted-foreground">Connecting an external HR/payroll system requires a REST API or SFTP integration project — contact IT to scope one.</div>
              </div>
            </div>
          </Panel>
        </div>
      )}

    </div>
  );
}