import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BrainCircuit, 
  Download, 
  TrendingUp, 
  Activity, 
  Target, 
  Users, 
  PieChart as PieChartIcon,
  ShieldCheck,
  Database,
  Award,
  BookOpen,
  AlertTriangle,
  AlertCircle,
  HelpCircle,
  FileCheck,
  ChevronRight,
  Sparkles,
  BookMarked
} from "lucide-react";
import { Panel, Pill, Section } from "@/components/layout/section";
import { Pager } from "@/components/ui/pager";
import { useDepartment } from "@/context/department-context";
import { coreApi } from "@/lib/api-client";
import { CHART_COLORS, CHART_TOOLTIP_STYLE, CHART_ANIMATION } from "@/lib/chart-theme";
import {
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  Tooltip, 
  ResponsiveContainer, 
  CartesianGrid, 
  Cell, 
  PieChart, 
  Pie, 
  BarChart, 
  Bar, 
  Legend,
  Line
} from "recharts";
import { cn } from "@/lib/utils";
import { WardDensityMap } from "@/components/analytics/ward-density-map";

export const Route = createFileRoute("/analytics")({
  head: () => ({ meta: [{ title: "Workforce Analytics & Governance Intelligence · AWIP" }] }),
  component: AnalyticsPage,
});

// Real-data-derived recommendation per governance metric — the metric name
// itself is computed live (see governanceReadiness below); only the advice
// text mapped to "which metric is weakest" is a fixed lookup, not a
// fabricated per-department stat.
const ACTION_BY_METRIC: Record<string, string> = {
  digitization: "Prioritize service book digitization for pending records",
  appraisal: "Expedite current-year appraisal filings",
  training: "Schedule mandatory training completion drives",
  establishment: "Accelerate recruitment against sanctioned vacancies",
};

const COLORS = CHART_COLORS;
const TOOLTIP_STYLE = CHART_TOOLTIP_STYLE;
const PROMOTION_READY_PAGE_SIZE = 10;

function AnalyticsPage() {
  const { department } = useDepartment();
  const [activeTab, setActiveTab] = useState<"core" | "ai" | "governance">("core");
  const [timeRange, setTimeRange] = useState("6M");
  const [selectedDeptIndex, setSelectedDeptIndex] = useState<number>(0);
  const [promotionReadyPage, setPromotionReadyPage] = useState(1);

  const { data: employeesResponse } = useQuery({
    queryKey: ["employees", department],
    queryFn: () => coreApi.getEmployees({ department }),
  });
  const { data: workforce } = useQuery({
    queryKey: ["workforce-summary"],
    queryFn: () => coreApi.getWorkforceSummary(),
  });
  const { data: ageProfileResp } = useQuery({
    queryKey: ["workforce-age-profile"],
    queryFn: () => coreApi.getWorkforceAgeProfile(),
  });
  const ageProfile = ageProfileResp?.data ?? [];

  const { data: alertsResp } = useQuery({
    queryKey: ["workforce-alerts"],
    queryFn: () => coreApi.getWorkforceAlerts(),
  });
  const { data: promotionReadyResp } = useQuery({
    queryKey: ["promotion-ready"],
    queryFn: () => coreApi.getPromotionReadyList(),
  });
  const promotionReadyRows = promotionReadyResp?.data ?? [];
  const promotionReadyTotalPages = Math.max(1, Math.ceil(promotionReadyRows.length / PROMOTION_READY_PAGE_SIZE));
  const promotionReadyVisible = promotionReadyRows.slice(
    (promotionReadyPage - 1) * PROMOTION_READY_PAGE_SIZE,
    promotionReadyPage * PROMOTION_READY_PAGE_SIZE,
  );
  const { data: leaveAnalyticsResp } = useQuery({
    queryKey: ["leave-analytics", department],
    queryFn: () => coreApi.getLeaveAnalytics(department),
  });
  const { data: trainingSummaryResp } = useQuery({
    queryKey: ["training-summary"],
    queryFn: () => coreApi.getTrainingSummary(),
  });
  const { data: retirementTrendResp } = useQuery({
    queryKey: ["retirement-trend"],
    queryFn: () => coreApi.getRetirementTrend(),
  });
  const { data: governanceResp } = useQuery({
    queryKey: ["governance-readiness"],
    queryFn: () => coreApi.getGovernanceReadiness(),
  });
  const { data: serviceBookCompletenessResp } = useQuery({
    queryKey: ["service-book-completeness"],
    queryFn: () => coreApi.getServiceBookCompleteness(),
  });

  // Derived Standard Analytics Data
  const cadreData = useMemo(() => {
    const counts: Record<string, number> = {};
    (employeesResponse?.data ?? []).forEach((e: any) => {
      counts[e.cadre] = (counts[e.cadre] || 0) + 1;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name));
  }, [employeesResponse]);

  const vacancyData = useMemo(() => {
    return (workforce?.data ?? []).map((d: any) => ({
      name: d.dept,
      filled: d.count,
      vacant: d.vacancies,
      total: d.count + d.vacancies,
    }));
  }, [workforce]);

  const leaveData = useMemo(
    () => (leaveAnalyticsResp?.byDepartment ?? []).map((d) => ({ name: d.department, avgTaken: d.avgTaken, pending: d.pending })),
    [leaveAnalyticsResp],
  );

  // Promotion-due headcount by department — a real current snapshot from
  // Employee.promotionDue, not a fabricated month-by-month backlog/cleared
  // trend (there's no historical promotion-request table to build one from).
  const promotionByDept = useMemo(
    () => [...(alertsResp?.promotion?.byDepartment ?? [])].sort((a, b) => b.count - a.count).slice(0, 8),
    [alertsResp],
  );

  const trainingData = useMemo(
    () => (trainingSummaryResp?.byDepartment ?? []).map((d) => ({ name: d.department, compliance: d.completionRate })),
    [trainingSummaryResp],
  );

  const retirementTrend = useMemo(() => {
    if (!retirementTrendResp) return [];
    return retirementTrendResp.data.map((r) => ({
      year: r.year,
      projectedRetirements: r.projectedRetirements,
      activeStrength: retirementTrendResp.activeStrength,
    }));
  }, [retirementTrendResp]);

  const riskIndicators = useMemo(() => {
    const list: { title: string; desc: string; stat: string; impact: string; severity: "destructive" | "warning" | "info"; icon: typeof AlertTriangle }[] = [];
    if (alertsResp?.retirement?.total) {
      const topDepts = [...alertsResp.retirement.byDepartment].sort((a, b) => b.count - a.count).slice(0, 2).map((d) => d.department);
      list.push({
        title: "Retirement Concentration",
        desc: `${topDepts.join(" and ") || "Multiple departments"} carry the largest share of employees retiring within the next 24 months.`,
        stat: `${alertsResp.retirement.total} retiring in 24M`,
        impact: "Succession planning risk",
        severity: "destructive",
        icon: AlertTriangle,
      });
    }
    if (alertsResp?.promotion?.total) {
      const topDepts = [...alertsResp.promotion.byDepartment].sort((a, b) => b.count - a.count).slice(0, 2).map((d) => d.department);
      list.push({
        title: "Promotion Backlog",
        desc: `${topDepts.join(" and ") || "Multiple departments"} have the largest number of employees currently promotion-due.`,
        stat: `${alertsResp.promotion.total} promotion-due`,
        impact: "Employee morale risk",
        severity: "warning",
        icon: AlertCircle,
      });
    }
    const completeness = serviceBookCompletenessResp?.data ?? [];
    if (completeness.length) {
      const worst = [...completeness].sort((a, b) => a.completenessPct - b.completenessPct)[0];
      list.push({
        title: "Digitization & Service Book Backlog",
        desc: `${worst.department} has the lowest service book digitization rate of any department.`,
        stat: `${Math.round((100 - worst.completenessPct) * 10) / 10}% records incomplete`,
        impact: "Appraisal filing delays",
        severity: "info",
        icon: Database,
      });
    }
    return list;
  }, [alertsResp, serviceBookCompletenessResp]);

  // Designation-level training gaps, derived from real per-officer status
  // already computed by /api/v1/training/summary — no invented "recommended
  // curriculum" catalog, just the real pending count and which real category
  // shows up most often among that designation's incomplete trainings.
  const trainingNeeds = useMemo(() => {
    const byDesignation = new Map<string, { designation: string; pendingCount: number; categoryCounts: Map<string, number> }>();
    for (const course of trainingSummaryResp?.data ?? []) {
      for (const o of course.officers as { designation: string; status: string }[]) {
        if (o.status === "Completed") continue;
        const entry = byDesignation.get(o.designation) ?? { designation: o.designation, pendingCount: 0, categoryCounts: new Map() };
        entry.pendingCount += 1;
        entry.categoryCounts.set(course.category, (entry.categoryCounts.get(course.category) ?? 0) + 1);
        byDesignation.set(o.designation, entry);
      }
    }
    return Array.from(byDesignation.values())
      .map((d) => {
        const topCategory = [...d.categoryCounts.entries()].sort((a, b) => b[1] - a[1])[0];
        return {
          designation: d.designation,
          pendingCount: d.pendingCount,
          mostNeededCategory: topCategory ? topCategory[0] : "—",
          priority: d.pendingCount >= 30 ? ("High" as const) : ("Medium" as const),
        };
      })
      .sort((a, b) => b.pendingCount - a.pendingCount)
      .slice(0, 6);
  }, [trainingSummaryResp]);

  const governanceReadiness = useMemo(() => {
    return (governanceResp?.data ?? []).map((d) => {
      const metrics: Record<string, number> = { digitization: d.digitization, appraisal: d.appraisal, training: d.training, establishment: d.establishment };
      const weakest = Object.entries(metrics).sort((a, b) => a[1] - b[1])[0][0];
      return { ...d, action: ACTION_BY_METRIC[weakest] };
    });
  }, [governanceResp]);

  const selectedDeptObj = governanceReadiness[selectedDeptIndex];

  return (
    <div className="p-5 max-w-[1600px] mx-auto flex flex-col gap-6 animate-in fade-in duration-500 w-full">
      
      {/* Header */}
      <div className="w-full flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2 text-foreground">
            <BrainCircuit className="size-6 text-primary" />
            Workforce Analytics & Governance Intelligence
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Official administrative indicators, training compliance, predictive risk modeling, and department readiness.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex bg-surface-muted p-1 rounded-full border border-border">
            {["1M", "3M", "6M", "1Y"].map(t => (
              <button
                key={t}
                onClick={() => setTimeRange(t)}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-full transition-colors",
                  timeRange === t ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <button className="h-9 px-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-card text-xs font-medium hover:bg-surface-muted transition-colors">
            <Download className="size-4" /> Export Report
          </button>
        </div>
      </div>

      {/* Tabs System */}
      <div className="flex bg-surface-muted/30 p-1 rounded-full border border-border w-fit">
        <button
          onClick={() => setActiveTab("core")}
          className={cn(
            "px-4 py-2 text-xs font-semibold rounded-full transition-all flex items-center gap-2 cursor-pointer",
            activeTab === "core" 
              ? "bg-card text-foreground shadow-sm border border-border" 
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <PieChartIcon className="size-3.5 text-primary" />
          Core Analytics
        </button>
        <button
          onClick={() => setActiveTab("ai")}
          className={cn(
            "px-4 py-2 text-xs font-semibold rounded-full transition-all flex items-center gap-2 cursor-pointer",
            activeTab === "ai" 
              ? "bg-card text-foreground shadow-sm border border-border" 
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Sparkles className="size-3.5 text-warning-foreground" />
          AI Intelligence
        </button>
        <button
          onClick={() => setActiveTab("governance")}
          className={cn(
            "px-4 py-2 text-xs font-semibold rounded-full transition-all flex items-center gap-2 cursor-pointer",
            activeTab === "governance" 
              ? "bg-card text-foreground shadow-sm border border-border" 
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <ShieldCheck className="size-3.5 text-success-foreground" />
          Governance Dashboard
        </button>
      </div>

      {/* Tab Panels */}
      {activeTab === "core" && (
        <div className="space-y-6 w-full animate-in fade-in slide-in-from-bottom-2 duration-300">
          {/* Spatial Workforce Allocation — real ward-level data, kept as its own full-width row */}
          <ClientOnly fallback={<Panel className="p-5 h-[420px] grid place-items-center text-xs text-muted-foreground border border-border shadow-sm rounded-xl">Loading ward density map…</Panel>}>
            <WardDensityMap />
          </ClientOnly>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* 1. Cadre Distribution */}
            <Panel className="p-5 flex flex-col col-span-1 border border-border shadow-sm rounded-xl">
              <div className="flex justify-between items-center mb-4 border-b border-border pb-2.5">
                <div className="flex items-center gap-2">
                  <Users className="size-4 text-primary" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Cadre Distribution</h3>
                </div>
                <Pill tone="primary">Live Data</Pill>
              </div>
              <div className="h-[210px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={cadreData}
                      cx="50%"
                      cy="45%"
                      innerRadius={50}
                      outerRadius={75}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {cadreData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend 
                      verticalAlign="bottom" 
                      height={36} 
                      iconType="circle"
                      formatter={(value, entry: any) => <span className="text-[10px] font-medium text-foreground">{value}: {entry.payload.value}</span>} 
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </Panel>

            {/* 2. Age Profile */}
            <Panel className="p-5 flex flex-col lg:col-span-2 border border-border shadow-sm rounded-xl">
              <div className="flex justify-between items-center mb-4 border-b border-border pb-2.5">
                <div className="flex items-center gap-2">
                  <Activity className="size-4 text-primary" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Age Profile Analytics</h3>
                </div>
                <Pill tone="primary">Live Data</Pill>
              </div>
              <div className="h-[210px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={ageProfile} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
                    <XAxis dataKey="ageGroup" tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: 'var(--color-surface-muted)' }} contentStyle={TOOLTIP_STYLE} />
                    <Bar dataKey="count" fill="var(--color-chart-2)" maxBarSize={45} radius={[3, 3, 0, 0]} {...CHART_ANIMATION} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* 3. Leave Analytics */}
            <Panel className="p-5 flex flex-col border border-border shadow-sm rounded-xl">
              <div className="flex justify-between items-center mb-4 border-b border-border pb-2.5">
                <div className="flex items-center gap-2">
                  <BookMarked className="size-4 text-primary" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Leave Analytics (Dept-wise)</h3>
                </div>
                <Pill tone="primary">Live Data</Pill>
              </div>
              <div className="h-[210px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={leaveData} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
                    <XAxis dataKey="name" tick={{ fill: 'var(--color-muted-foreground)', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: 'var(--color-muted-foreground)', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend verticalAlign="top" height={32} iconSize={10} style={{ fontSize: 10 }} />
                    <Bar dataKey="avgTaken" name="Avg Leave Days" fill="var(--color-chart-1)" radius={[3, 3, 0, 0]} {...CHART_ANIMATION} />
                    <Bar dataKey="pending" name="Pending Requests" fill="var(--color-chart-4)" radius={[3, 3, 0, 0]} {...CHART_ANIMATION} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>

            {/* 4. Promotion Analytics */}
            <Panel className="p-5 flex flex-col border border-border shadow-sm rounded-xl">
              <div className="flex justify-between items-center mb-4 border-b border-border pb-2.5">
                <div className="flex items-center gap-2">
                  <Award className="size-4 text-primary" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Promotion-Due — By Department</h3>
                </div>
                <Pill tone="warning">Cadre Review</Pill>
              </div>
              <div className="h-[210px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={promotionByDept} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
                    <XAxis dataKey="department" tick={{ fill: 'var(--color-muted-foreground)', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Bar dataKey="count" name="Employees Promotion-Due" fill="var(--color-warning)" radius={[3, 3, 0, 0]} {...CHART_ANIMATION} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* 5. Training Analytics */}
            <Panel className="p-5 flex flex-col lg:col-span-1 border border-border shadow-sm rounded-xl">
              <div className="flex justify-between items-center mb-4 border-b border-border pb-2.5">
                <div className="flex items-center gap-2">
                  <BookOpen className="size-4 text-primary" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Training Compliance</h3>
                </div>
                <Pill tone="success">Mandatory</Pill>
              </div>
              <div className="h-[220px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={trainingData} layout="vertical" margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--color-border)" opacity={0.3} />
                    <XAxis type="number" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis dataKey="name" type="category" tick={{ fontSize: 9, fill: 'var(--color-muted-foreground)' }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [`${v}%`, "Compliance"]} />
                    <Bar dataKey="compliance" name="Compliance %" fill="var(--color-success)" radius={[0, 3, 3, 0]} barSize={12} {...CHART_ANIMATION} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>

            {/* 6. Vacancy Analytics */}
            <Panel className="p-5 flex flex-col lg:col-span-2 border border-border shadow-sm rounded-xl">
              <div className="flex justify-between items-center mb-4 border-b border-border pb-2.5">
                <div className="flex items-center gap-2">
                  <Target className="size-4 text-primary" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Vacancy Position (Sanctioned vs Active)</h3>
                </div>
                <Pill tone="destructive">Sanctioned</Pill>
              </div>
              <div className="h-[220px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={vacancyData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
                    <XAxis dataKey="name" tick={{ fill: 'var(--color-muted-foreground)', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: 'var(--color-muted-foreground)', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend verticalAlign="top" height={32} iconSize={10} style={{ fontSize: 10 }} />
                    <Bar dataKey="filled" name="Filled Strength" stackId="a" fill="var(--color-chart-3)" {...CHART_ANIMATION} />
                    <Bar dataKey="vacant" name="Vacancies" stackId="a" fill="var(--color-destructive)" radius={[3, 3, 0, 0]} {...CHART_ANIMATION} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>
        </div>
      )}

      {activeTab === "ai" && (
        <div className="space-y-6 w-full animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Workforce Trend Analysis */}
            <Panel className="p-5 flex flex-col lg:col-span-2 border border-border shadow-sm rounded-xl">
              <div className="flex items-center justify-between border-b border-border pb-2.5 mb-4">
                <div className="flex items-center gap-2">
                  <TrendingUp className="size-4 text-warning-foreground" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Workforce Trend & Retirement Forecast</h3>
                </div>
                <Pill tone="warning">5-Year Predictive Model</Pill>
              </div>
              <div className="h-[230px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={retirementTrend} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorStrength" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-primary)" stopOpacity={0.25}/>
                        <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
                    <XAxis dataKey="year" tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend verticalAlign="top" height={32} iconSize={10} style={{ fontSize: 10 }} />
                    <Area type="monotone" name="Active Strength (Today)" dataKey="activeStrength" stroke="var(--color-primary)" fillOpacity={1} fill="url(#colorStrength)" strokeWidth={2} {...CHART_ANIMATION} />
                    <Line type="monotone" name="Projected Retirements" dataKey="projectedRetirements" stroke="var(--color-destructive)" strokeWidth={2} dot={{ r: 4 }} {...CHART_ANIMATION} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Panel>

            {/* Workforce Risk Indicators */}
            <Panel className="p-5 flex flex-col lg:col-span-1 border border-border shadow-sm rounded-xl">
              <div className="flex justify-between items-center mb-4 border-b border-border pb-2.5">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="size-4 text-destructive" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Workforce Risk Hotspots</h3>
                </div>
                <Pill tone="destructive">Risk Scan</Pill>
              </div>
              <div className="flex-1 flex flex-col gap-3 overflow-y-auto max-h-[240px] pr-1">
                {riskIndicators.map((risk, index) => {
                  const Icon = risk.icon;
                  return (
                    <div 
                      key={index} 
                      className="p-3 rounded-xl bg-surface-muted/60 leading-relaxed"
                    >
                      <div className="flex items-start gap-2.5 justify-between">
                        <div className="flex items-center gap-1.5">
                          <Icon className={cn(
                            "size-4 shrink-0",
                            risk.severity === "destructive" ? "text-destructive" :
                            risk.severity === "warning" ? "text-warning-foreground" : "text-info-foreground"
                          )} />
                          <h4 className="text-xs font-bold text-foreground truncate max-w-[170px]">{risk.title}</h4>
                        </div>
                        <span className="text-[9px] font-semibold opacity-85 uppercase">{risk.stat}</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-1.5 leading-snug">{risk.desc}</p>
                      <div className="mt-2 text-[9px] font-medium text-foreground bg-card px-2.5 py-0.5 rounded-full w-fit border border-border">
                        {risk.impact}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          </div>

          {/* Training Need Identification */}
          <Panel className="p-5 flex flex-col border border-border shadow-sm rounded-xl">
            <div className="flex items-center justify-between border-b border-border pb-2.5 mb-4">
              <div className="flex items-center gap-2">
                <Target className="size-4 text-primary" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Training Need Identification Engine</h3>
              </div>
              <p className="text-[10px] text-muted-foreground">Designations with pending training, ranked by headcount.</p>
            </div>
            <div className="overflow-x-auto w-full">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-sidebar text-[10px] uppercase font-semibold text-sidebar-foreground tracking-wider">
                    <th className="py-2.5 px-3">Designation</th>
                    <th className="py-2.5 px-3">Most Needed Category</th>
                    <th className="py-2.5 px-3 text-center">Urgency</th>
                    <th className="py-2.5 px-3 text-right">Staff Pending</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {trainingNeeds.map((t, i) => (
                    <tr key={t.designation} className={cn("hover:bg-surface-muted/60 transition-colors", i % 2 === 1 && "bg-surface-muted")}>
                      <td className="py-3 px-3 font-semibold text-foreground">{t.designation}</td>
                      <td className="py-3 px-3 text-foreground font-medium flex items-center gap-1.5">
                        <BookOpen className="size-3 text-primary shrink-0" />
                        {t.mostNeededCategory}
                      </td>
                      <td className="py-3 px-3 text-center">
                        <Pill tone={t.priority === "High" ? "destructive" : "warning"}>{t.priority}</Pill>
                      </td>
                      <td className="py-3 px-3 text-right font-semibold tabular-nums text-foreground">{t.pendingCount} officers</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* Promotion-Ready List */}
          <Panel className="p-5 flex flex-col border border-border shadow-sm rounded-xl">
            <div className="flex items-center justify-between border-b border-border pb-2.5 mb-4">
              <div className="flex items-center gap-2">
                <Award className="size-4 text-primary" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Promotion-Ready List</h3>
              </div>
              <p className="text-[10px] text-muted-foreground">Every promotion-due employee, ranked by rating + seniority.</p>
            </div>
            <div className="overflow-x-auto w-full">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-sidebar text-[10px] uppercase font-semibold text-sidebar-foreground tracking-wider">
                    <th className="py-2.5 px-3">Name</th>
                    <th className="py-2.5 px-3">Designation</th>
                    <th className="py-2.5 px-3">Department</th>
                    <th className="py-2.5 px-3 text-center">Rating</th>
                    <th className="py-2.5 px-3 text-center">Training %</th>
                    <th className="py-2.5 px-3 text-center">Vigilance</th>
                    <th className="py-2.5 px-3 text-right">Seniority</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {promotionReadyVisible.map((p, i) => (
                    <tr key={p.id} className={cn("hover:bg-surface-muted/60 transition-colors", i % 2 === 1 && "bg-surface-muted")}>
                      <td className="py-3 px-3 font-semibold text-foreground">{p.name}</td>
                      <td className="py-3 px-3 text-muted-foreground">{p.designation}</td>
                      <td className="py-3 px-3 text-muted-foreground">{p.department}</td>
                      <td className="py-3 px-3 text-center tabular-nums text-foreground">{p.latestRating != null ? p.latestRating.toFixed(1) : "—"}</td>
                      <td className="py-3 px-3 text-center tabular-nums text-foreground">{p.trainingCompletionPct}%</td>
                      <td className="py-3 px-3 text-center">
                        <Pill tone={p.vigilance === "Flagged" ? "destructive" : "success"}>{p.vigilance}</Pill>
                      </td>
                      <td className="py-3 px-3 text-right tabular-nums text-foreground">{p.seniorityYears}y</td>
                    </tr>
                  ))}
                  {!promotionReadyRows.length && (
                    <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">No employees are currently promotion-due.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {promotionReadyTotalPages > 1 && <Pager page={promotionReadyPage} totalPages={promotionReadyTotalPages} onChange={setPromotionReadyPage} />}
          </Panel>
        </div>
      )}

      {activeTab === "governance" && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 w-full animate-in fade-in slide-in-from-bottom-2 duration-300">
          {/* Department-wise Readiness Matrix */}
          <Panel className="p-5 flex flex-col xl:col-span-2 border border-border shadow-sm rounded-xl">
            <div className="flex items-center justify-between border-b border-border pb-3 mb-4">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Department-wise Administrative Readiness Matrix</h3>
                <p className="text-[10px] text-muted-foreground mt-1">Select a department to view detailed active governance recommenders.</p>
              </div>
              <Pill tone="success">Governance Audit</Pill>
            </div>
            
            <div className="overflow-x-auto w-full">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-sidebar text-[10px] uppercase font-semibold text-sidebar-foreground tracking-wider">
                    <th className="py-3 px-3">Department</th>
                    <th className="py-3 px-3 text-center">Digitization</th>
                    <th className="py-3 px-3 text-center">Appraisal</th>
                    <th className="py-3 px-3 text-center">Training</th>
                    <th className="py-3 px-3 text-center">Establishment</th>
                    <th className="py-3 px-3 text-center">Avg Score</th>
                    <th className="py-3 px-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {governanceReadiness.map((item, idx) => {
                    const avg = Math.round((item.digitization + item.appraisal + item.training + item.establishment) / 4);
                    const isSelected = selectedDeptIndex === idx;
                    
                    return (
                      <tr 
                        key={idx} 
                        onClick={() => setSelectedDeptIndex(idx)}
                        className={cn(
                          "cursor-pointer transition-colors",
                          isSelected ? "bg-primary/5 hover:bg-primary/5" : idx % 2 === 1 ? "bg-surface-muted hover:bg-surface-muted/80" : "hover:bg-surface-muted/60"
                        )}
                      >
                        <td className="py-3.5 px-3 font-bold text-foreground flex items-center gap-2">
                          <span className={cn(
                            "w-1.5 h-6 rounded-sm shrink-0",
                            isSelected ? "bg-primary animate-pulse" : "bg-transparent"
                          )} />
                          {item.dept}
                        </td>
                        
                        {/* Digitization */}
                        <td className="py-3.5 px-3 text-center">
                          <div className="flex flex-col items-center gap-1.5">
                            <span className="font-semibold tabular-nums text-foreground">{item.digitization}%</span>
                            <div className="w-16 h-1.5 bg-surface-muted rounded-full overflow-hidden">
                              <div className={cn("h-full", item.digitization >= 80 ? "bg-success" : item.digitization >= 60 ? "bg-warning" : "bg-destructive")} style={{ width: `${item.digitization}%` }} />
                            </div>
                          </div>
                        </td>

                        {/* Appraisal */}
                        <td className="py-3.5 px-3 text-center">
                          <div className="flex flex-col items-center gap-1.5">
                            <span className="font-semibold tabular-nums text-foreground">{item.appraisal}%</span>
                            <div className="w-16 h-1.5 bg-surface-muted rounded-full overflow-hidden">
                              <div className={cn("h-full", item.appraisal >= 80 ? "bg-success" : item.appraisal >= 60 ? "bg-warning" : "bg-destructive")} style={{ width: `${item.appraisal}%` }} />
                            </div>
                          </div>
                        </td>

                        {/* Training */}
                        <td className="py-3.5 px-3 text-center">
                          <div className="flex flex-col items-center gap-1.5">
                            <span className="font-semibold tabular-nums text-foreground">{item.training}%</span>
                            <div className="w-16 h-1.5 bg-surface-muted rounded-full overflow-hidden">
                              <div className={cn("h-full", item.training >= 80 ? "bg-success" : item.training >= 60 ? "bg-warning" : "bg-destructive")} style={{ width: `${item.training}%` }} />
                            </div>
                          </div>
                        </td>

                        {/* Establishment */}
                        <td className="py-3.5 px-3 text-center">
                          <div className="flex flex-col items-center gap-1.5">
                            <span className="font-semibold tabular-nums text-foreground">{item.establishment}%</span>
                            <div className="w-16 h-1.5 bg-surface-muted rounded-full overflow-hidden">
                              <div className={cn("h-full", item.establishment >= 80 ? "bg-success" : item.establishment >= 60 ? "bg-warning" : "bg-destructive")} style={{ width: `${item.establishment}%` }} />
                            </div>
                          </div>
                        </td>

                        {/* Avg Score */}
                        <td className="py-3.5 px-3 text-center">
                          <span className={cn(
                            "inline-block font-bold tabular-nums text-xs px-2.5 py-1 rounded-full",
                            avg >= 85 ? "bg-success/15 text-success" : 
                            avg >= 70 ? "bg-warning/15 text-warning-foreground" : "bg-destructive/15 text-destructive"
                          )}>
                            {avg}%
                          </span>
                        </td>
                        
                        <td className="py-3.5 px-3 text-right">
                          <ChevronRight className={cn(
                            "size-4 transition-transform",
                            isSelected ? "text-primary translate-x-1" : "text-muted-foreground"
                          )} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* Interactive Recommender */}
          <Panel className="p-5 flex flex-col xl:col-span-1 border border-border shadow-sm rounded-xl">
            <div className="flex items-center gap-2 mb-4 border-b border-border pb-3">
              <ShieldCheck className="size-5 text-primary" />
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Governance Action Hub</h3>
                <p className="text-[10px] text-muted-foreground">Detailed metrics & recommended correction plan.</p>
              </div>
            </div>
            
            {selectedDeptObj ? (
              <div className="flex-1 flex flex-col justify-between">
                <div className="space-y-4">
                  <div className="bg-surface-muted/30 p-3 rounded-xl border border-border">
                    <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">Active Department</span>
                    <h4 className="text-base font-bold text-foreground mt-0.5">{selectedDeptObj.dept} Department</h4>
                  </div>

                  <div className="space-y-3 pt-2">
                    <h5 className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">Readiness Breakdown</h5>
                    
                    {/* Digitization */}
                    <div className="flex justify-between items-center text-xs">
                      <span className="flex items-center gap-1.5 text-muted-foreground"><Database className="size-3.5" /> Digitization Readiness</span>
                      <span className="font-bold text-foreground">{selectedDeptObj.digitization}%</span>
                    </div>

                    {/* Appraisal */}
                    <div className="flex justify-between items-center text-xs">
                      <span className="flex items-center gap-1.5 text-muted-foreground"><FileCheck className="size-3.5" /> Appraisal Completion</span>
                      <span className="font-bold text-foreground">{selectedDeptObj.appraisal}%</span>
                    </div>

                    {/* Training */}
                    <div className="flex justify-between items-center text-xs">
                      <span className="flex items-center gap-1.5 text-muted-foreground"><BookOpen className="size-3.5" /> Training Compliance</span>
                      <span className="font-bold text-foreground">{selectedDeptObj.training}%</span>
                    </div>

                    {/* Establishment */}
                    <div className="flex justify-between items-center text-xs">
                      <span className="flex items-center gap-1.5 text-muted-foreground"><Users className="size-3.5" /> Establishment Dossier</span>
                      <span className="font-bold text-foreground">{selectedDeptObj.establishment}%</span>
                    </div>
                  </div>

                  <div className="border-t border-border pt-4 mt-2">
                    <Pill tone="warning">Recommended Intervention</Pill>
                    <p className="text-xs text-foreground font-semibold mt-3 leading-relaxed bg-surface-muted/40 p-3 rounded-xl border border-border/80">
                      {selectedDeptObj.action}
                    </p>
                  </div>
                </div>

                <div className="pt-6 space-y-2">
                  <button className="w-full h-9 bg-primary text-primary-foreground font-semibold text-xs rounded-full shadow-sm hover:opacity-95 transition-all flex items-center justify-center gap-1.5 cursor-pointer">
                    <Sparkles className="size-3.5" />
                    Deploy AI Target Action Plan
                  </button>
                  <button className="w-full h-9 bg-card border border-border text-foreground hover:bg-surface-muted text-xs font-semibold rounded-full transition-all cursor-pointer">
                    Assign Directing Officer
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-6 text-muted-foreground">
                <HelpCircle className="size-8 text-muted-foreground opacity-60 mb-2" />
                <p className="text-xs">Select a department from the matrix to load the governance action advisor.</p>
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
export default AnalyticsPage;
