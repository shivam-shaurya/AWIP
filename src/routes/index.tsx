import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { coreApi } from "@/lib/api-client";
import {
  Users, UserCheck, UserX, Briefcase, TrendingUp, TrendingDown, Clock, IndianRupee,
  ArrowRight, ChevronRight, Calendar, X, ListChecks, Scale, MessageSquareWarning,
  Building2, Activity, Brain, AlertTriangle, GraduationCap, CloudRain, Siren, CalendarClock,
  Info, Sparkles, Loader2, CheckCircle2, RefreshCw,
} from "lucide-react";
import { useUI } from "@/context/ui-context";
import { Panel, Section, Pill } from "@/components/layout/section";
import { useDepartment } from "@/context/department-context";
import { DEPARTMENTS, type Department } from "@/lib/departments";
import { ZONES, type Zone } from "@/lib/zones";
import { EmergencyAlertModal } from "@/components/emergency/emergency-alert-modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FilterPill } from "@/components/ui/filter-pill";
import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

// Page-load entrance: major sections fade up and stagger in, springy not linear.
const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.1 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { type: "spring" as const, stiffness: 300, damping: 30 } },
};

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Command Centre · AWIP" },
      { name: "description", content: "Commissioner Workforce Command Centre — real-time workforce governance intelligence." },
    ],
  }),
  component: CommandCentre,
});

function CommandCentre() {
  const { department, setDepartment, zone, setZone } = useDepartment();
  const navigate = useNavigate();

  // Jump to Employee 360 pre-scoped to a department/zone, optionally with an
  // extra search filter (e.g. absent-today) — used by every click-through
  // below so the dashboard never just shows a number, it always leads somewhere.
  const goToEmployees = (opts: { department?: string; zone?: string; search?: Record<string, unknown> }) => {
    if (opts.department) setDepartment(opts.department as Department);
    if (opts.zone) setZone(opts.zone as Zone);
    navigate({ to: "/employees", search: opts.search ?? {} });
  };

  const { data: deptWorkforce, isError: workforceError, isLoading: workforceLoading, dataUpdatedAt } = useQuery({
    queryKey: ["workforce-summary", zone],
    queryFn: () => coreApi.getWorkforceSummary(zone),
  });
  const { data: zoneWorkforce } = useQuery({
    queryKey: ["workforce-zones", department],
    queryFn: () => coreApi.getWorkforceZones(department),
  });
  const { data: workforceTotals } = useQuery({
    queryKey: ["workforce-totals", department, zone],
    queryFn: () => coreApi.getWorkforceTotals(department, zone),
  });
  const { data: payrollSummary } = useQuery({
    queryKey: ["payroll-summary"],
    queryFn: () => coreApi.getPayrollSummary(),
  });
  const { data: workforceAlerts } = useQuery({
    queryKey: ["workforce-alerts"],
    queryFn: () => coreApi.getWorkforceAlerts(),
  });
  const { data: calendarEvents } = useQuery({
    queryKey: ["calendar-events"],
    queryFn: () => coreApi.getCalendarEvents(),
  });
  const { data: taskAlerts } = useQuery({
    queryKey: ["task-alerts"],
    queryFn: () => coreApi.getTaskAlerts(),
  });
  const { data: legalCases } = useQuery({
    queryKey: ["legal-cases"],
    queryFn: () => coreApi.getLegalCases(),
  });
  const { data: grievances } = useQuery({
    queryKey: ["grievances-all"],
    queryFn: () => coreApi.getGrievances(),
  });
  const { data: deptProfiles } = useQuery({
    queryKey: ["department-profiles"],
    queryFn: () => coreApi.getDepartmentProfiles(),
  });
  const { data: emergencyAlerts, refetch: refetchEmergencyAlerts } = useQuery({
    queryKey: ["emergency-alerts"],
    queryFn: () => coreApi.getEmergencyAlerts(),
  });
  const { data: aiAgents } = useQuery({
    queryKey: ["ai-agents"],
    queryFn: () => coreApi.getAiAgents(),
    refetchInterval: 5 * 60 * 1000,
  });
  const { data: pendingLeave } = useQuery({
    queryKey: ["leave-pending-count", department],
    queryFn: () => coreApi.getPendingLeaveCount(department),
  });
  const { data: smartAlerts } = useQuery({
    queryKey: ["smart-alerts"],
    queryFn: () => coreApi.getSmartAlerts(),
    refetchInterval: 5 * 60 * 1000,
  });

  const [emergencyModalOpen, setEmergencyModalOpen] = useState(false);
  const [dismissTarget, setDismissTarget] = useState<any>(null);
  const queryClient = useQueryClient();
  const dismissAlertMutation = useMutation({
    mutationFn: (id: string) => coreApi.dismissEmergencyAlert(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["emergency-alerts"] });
      setDismissTarget(null);
    },
  });
  // Dismissed alerts are hidden from this at-a-glance panel but stay in the
  // database (with their full audit trail) — see /api/v1/emergency-alerts.
  const emergencyRows = (emergencyAlerts?.data ?? []).filter((a: any) => a.status !== "Dismissed");
  const emergencyCounts = {
    open: emergencyRows.filter((a: any) => a.status === "Open").length,
    escalated: emergencyRows.filter((a: any) => a.status === "Escalated").length,
    resolved: emergencyRows.filter((a: any) => a.status === "Resolved").length,
  };
  const recentAlerts = [...emergencyRows]
    .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 8);

  const upcomingEvents = (calendarEvents?.data ?? []).slice(0, 7);

  // Real per-department workforce rows, scoped to the selected zone server-side.
  const deptData = useMemo(
    () => [...(deptWorkforce?.data ?? [])].sort((a: any, b: any) => b.count - a.count),
    [deptWorkforce],
  );
  // Real per-zone workforce rows, scoped to the selected department server-side.
  const zoneData = useMemo(
    () => [...(zoneWorkforce?.data ?? [])].sort((a: any, b: any) => b.count - a.count),
    [zoneWorkforce],
  );

  // Promotion/retirement alerts are grouped by department OR by zone (not
  // cross-tabbed) — the more specific active filter wins; falls back to org total.
  const findAlertCount = (byDepartment: { department: string; count: number }[] | undefined, byZone: { zone: string; count: number }[] | undefined) => {
    if (zone !== "All Zones" && byZone) return byZone.find((r) => r.zone === zone)?.count ?? 0;
    if (department !== "All Departments" && byDepartment) return byDepartment.find((r) => r.department === department)?.count ?? 0;
    return byDepartment?.reduce((s, r) => s + r.count, 0) ?? 0;
  };

  const totals = useMemo(() => {
    const total = workforceTotals?.total ?? 0;
    const presentPct = workforceTotals?.presentPct ?? 0;
    const presentCount = Math.round(total * (presentPct / 100));
    const vacancies = workforceTotals?.vacancies ?? 0;
    const promotionDue = findAlertCount(workforceAlerts?.promotion.byDepartment, workforceAlerts?.promotion.byZone);
    const retirementDue = findAlertCount(workforceAlerts?.retirement.byDepartment, workforceAlerts?.retirement.byZone);
    const payrollCr = workforceAlerts?.payroll.totalCr ?? 0;
    return { total, presentCount, presentPct, vacancies, promotionDue, retirementDue, payrollCr };
  }, [workforceTotals, workforceAlerts, department, zone]);

  const scopeLabel = [department !== "All Departments" ? department : null, zone !== "All Zones" ? `${zone} Zone` : null].filter(Boolean).join(" · ") || "All Departments · All Zones";

  const kpis = [
    { key: "total", label: "Total Employees", value: totals.total.toLocaleString("en-IN"), sub: scopeLabel, icon: Users, tone: "primary" as const },
    { key: "present", label: "Present Today", value: `${totals.presentPct.toFixed(1)}%`, sub: `${totals.presentCount.toLocaleString("en-IN")} / ${totals.total.toLocaleString("en-IN")}`, icon: UserCheck, tone: "success" as const },
    { key: "vacancies", label: "Vacancies", value: totals.vacancies.toLocaleString("en-IN"), sub: department === "All Departments" ? "Across departments" : department, icon: Briefcase, tone: "warning" as const },
    { key: "promotion", label: "Promotion Due", value: totals.promotionDue.toLocaleString("en-IN"), sub: "Eligible per tenure norms", icon: TrendingUp, tone: "info" as const },
    { key: "retirement", label: "Retirement Due", value: totals.retirementDue.toLocaleString("en-IN"), sub: "Within 24 months", icon: Clock, tone: "destructive" as const },
    { key: "payroll", label: "Payroll This Month", value: `₹${totals.payrollCr.toFixed(1)} Cr`, sub: payrollSummary?.processedEmployees ? `${payrollSummary.processedEmployees.toLocaleString("en-IN")} processed` : "Gross disbursement", icon: IndianRupee, tone: "success" as const },
  ];

  const [selectedKpi, setSelectedKpi] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [smartAlertsOpen, setSmartAlertsOpen] = useState(false);

  // ── Needs Attention panel: real numbers pulled from the same endpoints
  // that back Tasks/Legal/Grievances/Org360, instead of hardcoded cards.
  const openLegalCases = (legalCases?.data ?? []).filter((c: any) => c.status === "Pending" || c.status === "Hearing Scheduled");
  const openGrievances = (grievances?.data ?? []).filter((g: any) => g.status !== "Resolved");
  const criticalGrievances = openGrievances.filter((g: any) => g.severity === "Critical");
  const lowestHealthDept = [...(deptProfiles?.data ?? [])].sort((a: any, b: any) => a.healthScore - b.healthScore)[0];
  const alertItems = taskAlerts?.data ?? [];

  const attentionTiles = [
    {
      icon: ListChecks, tone: "warning" as const, label: "Task Alerts",
      value: alertItems.length, detail: alertItems[0]?.detail || "No SLA breaches or overloaded officers right now.",
      to: "/tasks",
    },
    {
      icon: Scale, tone: "destructive" as const, label: "Open Legal Cases",
      value: openLegalCases.length, detail: openLegalCases[0] ? `${openLegalCases[0].title} · ${openLegalCases[0].department}` : "No pending litigation.",
      to: "/legal",
    },
    {
      icon: MessageSquareWarning, tone: "warning" as const, label: "Open Grievances",
      value: openGrievances.length, detail: criticalGrievances.length ? `${criticalGrievances.length} marked Critical` : "None marked Critical.",
      to: "/grievances",
    },
    {
      icon: Building2, tone: "info" as const, label: "Lowest Health Department",
      value: lowestHealthDept ? `${lowestHealthDept.healthScore}/100` : "—",
      detail: lowestHealthDept ? lowestHealthDept.department : "Loading department scores…",
      to: "/org360",
    },
    {
      icon: CalendarClock, tone: "warning" as const, label: "Pending Leave Approvals",
      value: pendingLeave?.count ?? 0,
      detail: pendingLeave?.latest ? `${pendingLeave.latest.employeeName} · ${pendingLeave.latest.leaveType}` : "No pending leave requests.",
      to: "/leave",
    },
  ];

  // ── AI Insights (Smart Alerts): four real, computed cross-module signals
  // from GET /api/v1/insights/smart-alerts — same "real data, not hardcoded
  // cards" principle as attentionTiles above. Each action navigates to where
  // that signal can actually be acted on; the zone-scoped one goes through
  // goToEmployees (global department/zone context) since /employees has no
  // zone search param of its own, unlike the retirement flag which does.
  const smartAlertItems = [
    {
      icon: UserX, tone: "warning" as const,
      title: smartAlerts?.absenteeism ? `High absenteeism in ${smartAlerts.absenteeism.zone} Zone` : "No zone shows a notable absenteeism rise",
      detail: smartAlerts?.absenteeism ? `${smartAlerts.absenteeism.increasePct}% more than last month` : "Attendance is steady across zones this month.",
      methodology: "Compares the latest two months of real attendance data per zone and flags the zone with the sharpest month-over-month absenteeism rise.",
      action: () => smartAlerts?.absenteeism && goToEmployees({ zone: smartAlerts.absenteeism.zone }),
    },
    {
      icon: TrendingDown, tone: "destructive" as const,
      title: `${smartAlerts?.performanceDeclining ?? 0} employees performance declining`,
      detail: "Risk of productivity impact",
      methodology: "Counts employees whose latest annual performance rating is lower than their previous year's rating, from real performance-record history.",
      action: () => navigate({ to: "/employees", search: { performanceDeclining: true } }),
    },
    {
      icon: Users, tone: "info" as const,
      title: `${smartAlerts?.retiringNext12Months ?? 0} employees retiring in next 12 months`,
      detail: "Critical roles may be impacted",
      methodology: "Active employees with a retirement date falling within the next 12 months, from real service records.",
      action: () => navigate({ to: "/employees", search: { flag: "retirementDue" } }),
    },
    {
      icon: IndianRupee, tone: "destructive" as const,
      title: `${smartAlerts?.departmentsOverBudget ?? 0} departments over salary budget`,
      detail: "Budget reallocation suggested",
      methodology: "Departments where actual spend already exceeds the allocated budget for the latest recorded month, from real department finance data.",
      action: () => navigate({ to: "/finance" }),
    },
    {
      icon: Clock, tone: "destructive" as const,
      title: `${smartAlerts?.retirementReadinessBlocked ?? 0} retiring employees have incomplete pension paperwork`,
      detail: "Service-book gaps may delay their PPO",
      methodology: "Employees retiring within 6 months who have missing documents, an unresolved disciplinary flag, or an unverified service-book entry — real blockers to their pension paperwork.",
      action: () => navigate({ to: "/employees", search: { retirementBlocked: true } }),
    },
    {
      icon: CheckCircle2, tone: "success" as const,
      title: `${smartAlerts?.recentlyRegularised ?? 0} employees newly crossed a regularisation milestone`,
      detail: "900/1800-day service threshold (AMC 1982 policy)",
      methodology: "Employees who crossed the real AMC 900-day or 1800-day service milestone in the last 30 days, per the 1982 regularisation policy.",
      action: () => navigate({ to: "/employees", search: { regularisationMilestone: "recent" } }),
    },
  ];

  const syncedLabel = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—";

  return (
    <motion.div
      className="p-5 space-y-6 max-w-[1600px] mx-auto"
      variants={containerVariants}
      initial="hidden"
      animate="show"
    >
      {/* Title + scope filters, combined into one compact row */}
      <motion.div variants={itemVariants} className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>Workforce OS</span>
            <ChevronRight className="size-3" />
            <span>{scopeLabel}</span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight mt-0.5">Command Centre</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterPill
            value={department}
            onChange={(v) => setDepartment(v as Department)}
            options={DEPARTMENTS as unknown as string[]}
            label="All Departments"
            size="compact"
          />
          <FilterPill
            value={zone}
            onChange={(v) => setZone(v as Zone)}
            options={ZONES as unknown as string[]}
            label="All Zones"
            size="compact"
          />
          <Pill tone="success"><span className="size-1.5 rounded-full bg-success" /> Operational</Pill>
          <Pill tone="info">Synced {syncedLabel}</Pill>
        </div>
      </motion.div>

      {/* KPI strip */}
      <motion.div variants={itemVariants} className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {workforceError && (
          <div className="col-span-full rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Couldn't load live workforce data — the numbers below are stale/zeroed. Is the AWIP core server running and are you still signed in?
          </div>
        )}
        {workforceLoading && (
          <div className="col-span-full text-xs text-muted-foreground py-1">Loading live workforce data…</div>
        )}
        {kpis.map((k) => {
          const { key, ...rest } = k;
          return <KpiCard key={key} {...rest} onClick={() => setSelectedKpi(key)} />;
        })}
      </motion.div>

      {/* Needs Attention — real cross-module risk panel, surfaced first since
          it's live actionable signal (unlike the mock AI Agents strip below) */}
      <motion.div variants={itemVariants}>
        <Section title="Needs Attention" subtitle="Live signals pulled from Tasks, Legal, Grievances and Org 360">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            {attentionTiles.map((t) => (
              <Link
                key={t.label}
                to={t.to}
                className={cn(
                  "bg-card border-2 rounded-xl p-3 transition-all duration-300 ease-out hover:-translate-y-1 hover:shadow-md flex flex-col gap-2 group",
                  KPI_BORDER_TONE[t.tone],
                )}
              >
                <div className="flex items-center justify-between">
                  <div className={cn("size-8 rounded-lg grid place-items-center", KPI_ICON_TONE[t.tone])}>
                    <t.icon className="size-4" />
                  </div>
                  <ArrowRight className="size-3.5 text-muted-foreground/40 group-hover:text-primary transition-colors" />
                </div>
                <div>
                  <div className={cn("text-lg font-semibold tabular-nums leading-tight", toneText(t.tone))}>{t.value}</div>
                  <div className="text-[11px] text-muted-foreground">{t.label}</div>
                </div>
                <div className="text-[10px] text-muted-foreground truncate pt-1.5">{t.detail}</div>
              </Link>
            ))}
          </div>
        </Section>
      </motion.div>

      {/* Emergency Alerts (now half-width) beside AI Insights (Smart Alerts) —
          real, persisted incidents on the left; real computed cross-module
          risk signals on the right. */}
      <motion.div variants={itemVariants} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel className="px-3 pt-3 pb-3 flex flex-col border-2 border-primary/40">
          <PanelHeader
            title="Emergency Alerts"
            subtitle="Civic/infrastructure incidents routed to the concerned department authority"
            action={
              <button
                onClick={() => setEmergencyModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-destructive text-destructive-foreground text-[11px] font-semibold hover:opacity-90 transition-opacity"
              >
                <Siren className="size-3.5" /> Raise Emergency Alert
              </button>
            }
          />
          <div className="grid grid-cols-3 gap-2 mb-3">
            <EmergencyStat label="Open" value={emergencyCounts.open} tone="destructive" />
            <EmergencyStat label="Escalated" value={emergencyCounts.escalated} tone="warning" />
            <EmergencyStat label="Resolved" value={emergencyCounts.resolved} tone="success" />
          </div>
          {recentAlerts.length === 0 ? (
            <div className="flex-1 text-xs text-muted-foreground py-4 text-center flex items-center justify-center">No emergency alerts on record.</div>
          ) : (
            <ul className="flex-1 flex flex-col justify-between gap-2 py-1">
              {recentAlerts.map((a: any) => (
                <li key={a.id} className="p-2.5 flex items-center gap-2.5 border border-border rounded-lg hover:bg-surface-muted transition-colors">
                  <span className="text-[10px] text-muted-foreground w-20 shrink-0 tabular-nums">{a.id}</span>
                  <span className="text-xs truncate flex-1">{a.title} · {a.department}</span>
                  <Pill tone={a.status === "Resolved" ? "success" : a.status === "Escalated" ? "destructive" : "warning"}>{a.status}</Pill>
                  <button
                    onClick={() => setDismissTarget(a)}
                    title="Dismiss alert"
                    className="shrink-0 size-6 rounded-md grid place-items-center hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel className="px-3 pt-3 pb-3 flex flex-col border-2 border-primary/40">
          <PanelHeader title="AI Insights (Smart Alerts)" subtitle="Live cross-module signals computed from real workforce data" />
          <ul className="flex-1 flex flex-col justify-between gap-2 py-1">
            {smartAlertItems.map((item) => (
              <li key={item.title}>
                <button
                  onClick={item.action}
                  className="w-full flex items-start gap-2.5 rounded-lg border border-border px-2.5 py-2.5 text-left hover:bg-surface-muted transition-colors"
                >
                  <item.icon className={cn("size-4 shrink-0 mt-0.5", toneText(item.tone))} />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold truncate">{item.title}</div>
                    <div className="text-[11px] text-muted-foreground truncate">{item.detail}</div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <button
            onClick={() => setSmartAlertsOpen(true)}
            className="mt-3 text-xs font-medium text-primary hover:underline text-center w-full shrink-0"
          >
            View All Insights
          </button>
        </Panel>
      </motion.div>

      <motion.div variants={itemVariants} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Upcoming HR calendar */}
        <Panel className="px-3 pt-3 pb-3 flex flex-col border-2 border-primary/40">
          <PanelHeader title="Upcoming HR Events" action={<Link to="/calendar" className="text-[11px] text-primary hover:underline inline-flex items-center gap-0.5">View Full <ArrowRight className="size-3" /></Link>} />
          {upcomingEvents.length === 0 ? (
            <div className="flex-1 text-xs text-muted-foreground py-4 text-center flex items-center justify-center">No upcoming events in the next 90 days.</div>
          ) : (
            <ul className="flex-1 flex flex-col justify-between gap-2 py-1">
              {upcomingEvents.map((e: any) => (
                <li key={e.id} className="p-2.5 flex items-center gap-2.5 border border-border rounded-lg hover:bg-surface-muted transition-colors">
                  <Calendar className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="text-[10px] text-muted-foreground w-20 shrink-0 tabular-nums">
                    {new Date(`${e.date}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
                  </span>
                  <span className="text-xs truncate flex-1">{e.title}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Active AI Agents & Predictions — status/confidence/last-run come from
            GET /api/v1/agents, computed on a schedule by server-core/agents.js
            and narrated by server-ai; see AGENT_META for the presentational-only
            name/icon/tone/deep-link per agent. */}
        <Panel className="px-3 pt-3 pb-3 border-2 border-primary/40">
          <PanelHeader title="Active AI Agents & Predictions" subtitle="AI workforce intelligence agents" />
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {AGENT_META.map((meta) => {
              const run = (aiAgents?.data ?? []).find((a) => a.agentKey === meta.key);
              return <AgentCard key={meta.key} meta={meta} run={run} onClick={() => setSelectedAgent(meta.key)} />;
            })}
          </div>
        </Panel>
      </motion.div>

      {/* AI Insights (Smart Alerts) Detail Overlay — shows the full detail
          and methodology behind each signal instead of redirecting away. */}
      <AnimatePresence>
        {smartAlertsOpen && (
          <SmartAlertsDetailOverlay
            items={smartAlertItems}
            onClose={() => setSmartAlertsOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* KPI Detail Side Overlay */}
      <AnimatePresence>
        {selectedKpi && (
          <KpiDetailOverlay
            kpiKey={selectedKpi}
            scopeLabel={scopeLabel}
            department={department}
            zone={zone}
            deptData={deptData}
            zoneData={zoneData}
            totals={totals}
            workforceAlerts={workforceAlerts}
            payrollSummary={payrollSummary}
            onNavigate={goToEmployees}
            onClose={() => setSelectedKpi(null)}
          />
        )}
      </AnimatePresence>

      {emergencyModalOpen && (
        <EmergencyAlertModal
          defaultDepartment={department !== "All Departments" ? department : undefined}
          onClose={() => setEmergencyModalOpen(false)}
          onCreated={() => refetchEmergencyAlerts()}
        />
      )}

      <ConfirmDialog
        open={!!dismissTarget}
        onOpenChange={(open) => { if (!open) setDismissTarget(null); }}
        title="Dismiss this alert?"
        description={dismissTarget ? `"${dismissTarget.title}" (${dismissTarget.id}) will be hidden from this panel. The alert and its full history stay on record.` : ""}
        confirmLabel="Dismiss"
        isPending={dismissAlertMutation.isPending}
        onConfirm={() => { if (dismissTarget) dismissAlertMutation.mutate(dismissTarget.id); }}
      />

      {/* Agent Detail Side Overlay */}
      <AnimatePresence>
        {selectedAgent && (
          <AgentDetailOverlay
            agentName={selectedAgent}
            onClose={() => setSelectedAgent(null)}
            onNavigate={(dir) => {
              const idx = AGENT_META.findIndex((a) => a.key === selectedAgent);
              const nextIdx = dir === "next" ? (idx + 1) % AGENT_META.length : (idx - 1 + AGENT_META.length) % AGENT_META.length;
              setSelectedAgent(AGENT_META[nextIdx].key);
            }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   Sub-components
   ══════════════════════════════════════════════════════════════════════ */

function toneBg(tone: "primary" | "success" | "warning" | "destructive" | "info") {
  return {
    primary: "bg-primary/10 text-primary",
    success: "bg-success/10 text-success",
    warning: "bg-warning/15 text-warning-foreground",
    destructive: "bg-destructive/10 text-destructive",
    info: "bg-info/10 text-info",
  }[tone];
}

// Icon glyph keeps its tone color; the box around it stays neutral —
// used anywhere an icon sits in its own small container, as opposed to
// toneBg() which colors a whole tile (e.g. EmergencyStat).
function toneText(tone: "primary" | "success" | "warning" | "destructive" | "info") {
  return {
    primary: "text-primary",
    success: "text-success",
    warning: "text-warning-foreground",
    destructive: "text-destructive",
    info: "text-info",
  }[tone];
}

// `relatedTo` takes this run's findings (may be undefined if the agent
// hasn't completed a run yet) and returns where the primary action button
// should send the user. Each agent's `recommendedAction` describes a real
// operational step (redeploy staff, review spend, nominate a backfill
// candidate) — the destination now matches the TYPE of that step instead of
// always landing on Org 360's read-only department dashboard:
//   - "redeploy staff" / "reassign workload" -> Task Management (/tasks),
//     where reassignment actually happens.
//   - "find/nominate specific people" -> Employee Directory (/employees),
//     scoped by the same global department/zone context goToEmployees uses
//     elsewhere on this page, so the filter is already applied on arrival.
//   - genuine review/analysis (budget variance) -> Org 360's scoped module,
//     which is the right fit for "go look at this dashboard."
// `search` (org360's own department/module URL params) and `department`/
// `zone` (global context, read by /employees and /tasks) are two different
// scoping mechanisms already used elsewhere in this app — AgentLink carries
// whichever one the destination page actually expects.
type AgentLink = { to: string; search?: Record<string, string>; department?: string | null; zone?: string | null };
function orgModuleLink(department: string | null | undefined, module: string): AgentLink {
  return { to: "/org360", search: department ? { department, module } : {} };
}
function operationalLink(to: string, department: string | null | undefined, zone?: string | null): AgentLink {
  return { to, department: department ?? null, zone: zone ?? null };
}

/* ── AI Agents strip — status/confidence/findings/narrative all come from
   GET /api/v1/agents(/:key), computed on a schedule by server-core/agents.js
   and narrated by server-ai. This map is presentational-only: which icon,
   tone, display name, and in-app deep link go with each agentKey. */
const AGENT_META = [
  { key: "workforce-demand-predictor", name: "Workforce Demand Predictor", icon: TrendingUp, tone: "primary" as const, relatedLabel: "Open Employee Directory to reassign staff", relatedTo: (f: any): AgentLink => operationalLink("/employees", f?.projections?.[0]?.department, f?.projections?.[0]?.zone) },
  { key: "workforce-capacity-predictor", name: "Workforce Capacity Predictor", icon: Users, tone: "warning" as const, relatedLabel: "Open Task Management to redeploy workload", relatedTo: (f: any): AgentLink => operationalLink("/tasks", f?.shortfalls?.[0]?.department) },
  { key: "attendance-risk-predictor", name: "Attendance Risk Predictor", icon: AlertTriangle, tone: "destructive" as const, relatedLabel: "Open Employee Directory to review attendance", relatedTo: (f: any): AgentLink => operationalLink("/employees", f?.pairs?.[0]?.department, f?.pairs?.[0]?.zone) },
  { key: "budget-overrun-predictor", name: "Budget Overrun Predictor", icon: IndianRupee, tone: "destructive" as const, relatedLabel: "Review department finance", relatedTo: (f: any): AgentLink => orgModuleLink(f?.projections?.[0]?.department, "finance") },
  { key: "skill-gap-predictor", name: "Skill Gap Predictor", icon: GraduationCap, tone: "info" as const, relatedLabel: "Open Employee Directory to nominate backfill", relatedTo: (f: any): AgentLink => operationalLink("/employees", f?.projections?.[0]?.department) },
  { key: "weather-staff-planner", name: "Weather Staffing Planner", icon: CloudRain, tone: "info" as const, relatedLabel: "Open Task Management to redeploy ahead of forecast", relatedTo: (f: any): AgentLink => operationalLink("/tasks", f?.shortStaffed?.[0]?.department, f?.shortStaffed?.[0]?.priorityZone) },
];

// Soft-tinted square icon per agent — a deliberate exception to the app-wide
// neutral-icon-box rule, since this widget is asked to read as more vivid/
// varied than the rest of the dashboard, not blend into it.
const AGENT_ICON_STYLE: Record<string, string> = {
  primary: "bg-primary/10 text-primary",
  warning: "bg-warning/15 text-warning-foreground",
  success: "bg-success/10 text-success",
  destructive: "bg-destructive/10 text-destructive",
  info: "bg-info/10 text-info",
};

// Plain-English explanation of each finding field an agent shows, plus the
// alert threshold/methodology behind it — sourced directly from the
// thresholds/comments already in server-core/agents.js, so this stays
// accurate to what's actually computed instead of drifting from it.
const AGENT_GLOSSARY: Record<string, { label: string; text: string }[]> = {
  "workforce-demand-predictor": [
    { label: "Projection", text: "A straight-line trend fit through each department/zone's actual monthly task volume (last 6 months), projected one month ahead — flagged when the projected increase exceeds 15% and the trend fit is reasonably reliable." },
    { label: "Working Days Factor", text: "Next month's declared holidays beyond the usual 2/month, applied as a small discount to the projection." },
    { label: "Confidence", text: "Averages how well a straight line actually fits the specific department/zone alert(s) shown above — not every department/zone in the org, most of which never trigger an alert at all. A noisy trend on the shown alert(s) gets low confidence even with 6 months of data." },
  ],
  "workforce-capacity-predictor": [
    { label: "Effective Capacity", text: "Current active headcount minus already-filed leave in the next 30 days and retirements landing in the next 60 — a real, dated near-term supply figure." },
    { label: "Shortfall", text: "How far the resulting workload-per-head ratio would rise above that department's own historical average — flagged above 10%." },
    { label: "Confidence", text: "Weighted by how many months of task history back the shown department(s)' own ratio, and by how far past the 10% alert bar the shortfall actually sits — a marginal 11% shortfall reads as less certain than a 40% one." },
  ],
  "attendance-risk-predictor": [
    { label: "Projection", text: "A straight-line trend fit through each department/zone's actual monthly attendance % (last 6 months), projected one month ahead — flagged if the projection falls below 85%, or the trend is clearly declining even above it. Requires 5+ employees and 4+ months of history." },
    { label: "Confidence", text: "A projection already below the 85% threshold is a measured fact, so confidence starts from a solid base and is then adjusted by how well the trend actually fits and how many months of history back it, and reduced when many pairs lacked enough history to qualify at all." },
  ],
  "budget-overrun-predictor": [
    { label: "Projection", text: "A straight-line trend fit through each department's actual monthly budget variance % (up to 12 months), projected one month ahead — flagged above 10%. The underlying data has no deliberate month-to-month drift, so a weak trend fit is a real, honest possibility, not a bug." },
    { label: "Confidence", text: "Directly weighted by how well the trend fits for the department(s) actually flagged above — a flat/noisy history on the shown alert correctly produces low confidence instead of a falsely-precise forecast." },
  ],
  "skill-gap-predictor": [
    { label: "Projection", text: "Current holders of a department-critical skill, minus how many are retirement-due within 24 months (real dates) — flagged when the projected loss exceeds 20% of current holders. Tracks a small fixed set of skill/department pairs (e.g. Water Treatment Ops → Water Supply)." },
    { label: "Backfill Completion", text: "Current completion rate of a related mandated training course, where one exists — a proxy for how fast the department can backfill the skill, not a trend (no historical training-completion time series exists to trend)." },
    { label: "Confidence", text: "Weighted by how many current holders the shown percentage is computed over (a 25% loss on 8 holders is shakier than 25% on 40) and how far past the 20% alert bar the projected loss sits." },
  ],
  "weather-staff-planner": [
    { label: "Weather", text: "Live current + forecast rainfall for Ahmedabad (Open-Meteo), classified using India Meteorological Department bands. Staffing recommendations only activate once rainfall reaches Moderate or higher." },
    { label: "Short Staffed / Priority Zone", text: "Sanctioned-vs-filled vacancy gap in flood-critical departments (10+ sanctioned posts required), and the zone with the fewest currently-active staff there — both real, measured figures." },
    { label: "Reschedule Candidates", text: "Real open outdoor tasks (Inspection/Survey/Maintenance) in flood-critical departments — an actual list, not an estimate." },
    { label: "Estimated Absenteeism", text: "The one estimated figure here: a policy-calibrated uplift keyed to the rainfall band, since no daily-granularity weather history exists to measure a real correlation against attendance. Always marked as an estimate, never presented as measured." },
    { label: "Confidence", text: "Capped lower than other agents — there's no multi-year monsoon baseline yet — and reduced further if live weather data couldn't be fetched." },
  ],
};

/* ── Agent square tile — same flat, tone-coded treatment as KpiCard, so the
   AI Agents strip matches the KPI strip above. ─────────────────────────── */
function AgentCard({ meta, run, onClick }: {
  meta: (typeof AGENT_META)[number];
  run: { status: string; confidence: number; ranAt: string | null } | undefined;
  onClick: () => void;
}) {
  const status = run?.status ?? "Idle";
  const AgentIcon = meta.icon;
  const statusColor = status === "Running" ? "bg-success" : status === "Alert" ? "bg-warning" : "bg-muted-foreground";
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative overflow-hidden rounded-2xl text-left p-4 flex flex-col justify-between w-full min-h-[136px]",
        "bg-card border border-border",
        "shadow-sm transition-all duration-200 ease-out",
        "hover:-translate-y-0.5 hover:shadow-md",
        "cursor-pointer group",
      )}
    >
      <span className={cn("absolute inset-x-0 top-0 h-1", KPI_ACCENT_BAR[meta.tone])} />

      <div className="flex items-center gap-2.5 min-w-0">
        <div className={cn("size-9 rounded-xl grid place-items-center shrink-0 transition-transform duration-200 ease-out group-hover:scale-110", KPI_ICON_TONE[meta.tone])}>
          <AgentIcon className="size-4" />
        </div>
        <span className="text-xs font-semibold leading-tight text-foreground/90">{meta.name}</span>
      </div>
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-2">
        <span className={cn("size-1.5 rounded-full", statusColor)} />
        {status}
      </div>
    </button>
  );
}

/* ── Agent Detail Side Overlay — live narrative + findings from
   GET /api/v1/agents/:key (computed by server-core/agents.js, narrated by
   server-ai). Findings shape differs per agent, so it's rendered generically
   instead of a hand-written per-agent template. ────────────────────────── */

// Turns a per-agent findings object into flat label/value rows without
// assuming its shape — arrays show a count, primitives show as-is, nested
// objects/arrays of objects render their first couple of entries.
function flattenFindings(findings: Record<string, any>): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  for (const [key, val] of Object.entries(findings || {})) {
    const label = key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
    if (Array.isArray(val)) {
      if (val.length === 0) { rows.push({ label, value: "None" }); continue; }
      if (typeof val[0] === "object") {
        val.slice(0, 3).forEach((item, i) => {
          const summary = Object.entries(item).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(", ");
          rows.push({ label: `${label} #${i + 1}`, value: summary });
        });
      } else {
        rows.push({ label, value: val.join(", ") });
      }
    } else if (val && typeof val === "object") {
      rows.push({ label, value: Object.entries(val).map(([k, v]) => `${k}: ${v}`).join(", ") });
    } else if (val != null) {
      rows.push({ label, value: String(val) });
    }
  }
  return rows;
}

function AgentDetailOverlay({ agentName: agentKey, onClose, onNavigate }: {
  agentName: string;
  onClose: () => void;
  onNavigate: (dir: "prev" | "next") => void;
}) {
  const meta = AGENT_META.find((a) => a.key === agentKey);
  const navigate = useNavigate();
  const { askAssistant } = useUI();
  const { setDepartment, setZone } = useDepartment();
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [findingsOpen, setFindingsOpen] = useState(false);
  const queryClient = useQueryClient();
  const { data: run, isLoading, isError } = useQuery({
    queryKey: ["ai-agent", agentKey],
    queryFn: () => coreApi.getAiAgent(agentKey),
    retry: false,
  });
  // Manual "Run now" — recomputes this one agent immediately instead of
  // waiting for its own cadence (up to 24h for most agents). Updates this
  // overlay's data directly from the response so there's no flash back to
  // stale data while the list query in the background catches up.
  const runNow = useMutation({
    mutationFn: () => coreApi.runAiAgentNow(agentKey),
    onSuccess: (data) => {
      queryClient.setQueryData(["ai-agent", agentKey], data);
      queryClient.invalidateQueries({ queryKey: ["ai-agents"] });
    },
  });
  if (!meta) return null;
  const AgentIcon = meta.icon;
  const status = run?.status ?? "Idle";
  const statusTone = status === "Running" ? "success" : status === "Alert" ? "warning" : "neutral";
  const relatedTo = meta.relatedTo(run?.findings);
  const flaggedDepartment = relatedTo.search?.department ?? relatedTo.department ?? null;
  const glossary = AGENT_GLOSSARY[meta.key] ?? [];

  // Two scoping mechanisms coexist in this app: Org 360 reads department/
  // module from the URL (relatedTo.search), while /employees and /tasks read
  // the global department/zone context instead — this applies whichever one
  // the destination actually expects.
  const goToRelated = () => {
    if (relatedTo.department) setDepartment(relatedTo.department as Department);
    if (relatedTo.zone) setZone(relatedTo.zone as Zone);
    navigate({ to: relatedTo.to, search: relatedTo.search ?? {} });
  };

  const guidedHelp = () => {
    if (!run) return;
    onClose();
    goToRelated();
    askAssistant(
      `The ${meta.name} agent suggested this: "${run.recommendedAction}" — based on: ${run.narrative}. Can you help me act on this?`,
    );
  };

  const createTask = useMutation({
    mutationFn: async () => {
      if (!flaggedDepartment || !run) throw new Error("No specific department to assign this to.");
      const authority = await coreApi.getDepartmentAuthority(flaggedDepartment);
      const eta = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      return coreApi.createTask({
        title: `${meta.name}: ${run.recommendedAction}`.slice(0, 200),
        employeeId: authority.id,
        department: flaggedDepartment,
        priority: "High",
        category: "Audit",
        eta,
      });
    },
  });

  return (
    <>
      <div className="fixed inset-0 z-45 backdrop-blur-sm bg-black/10" onClick={onClose} />
      <motion.div
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className="fixed right-0 top-0 bottom-0 z-50 w-[440px] bg-card shadow-[-8px_0_24px_rgba(0,93,94,0.08)] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={cn("size-10 rounded-xl grid place-items-center shrink-0 shadow-[0_2px_10px_rgba(0,0,0,0.05)]", AGENT_ICON_STYLE[meta.tone])}>
              <AgentIcon className="size-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-foreground truncate">{meta.name}</h2>
              <div className="mt-0.5"><Pill tone={statusTone as any}>{status}</Pill></div>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => runNow.mutate()}
              disabled={runNow.isPending}
              className="size-8 rounded-full grid place-items-center hover:bg-surface-muted transition-colors disabled:opacity-50"
              title="Run this agent now instead of waiting for its next scheduled run"
            >
              <RefreshCw className={cn("size-4 text-muted-foreground", runNow.isPending && "animate-spin")} />
            </button>
            <button onClick={() => onNavigate("prev")} className="size-8 rounded-full grid place-items-center hover:bg-surface-muted transition-colors" title="Previous agent">
              <ChevronRight className="size-4 text-muted-foreground rotate-180" />
            </button>
            <button onClick={() => onNavigate("next")} className="size-8 rounded-full grid place-items-center hover:bg-surface-muted transition-colors" title="Next agent">
              <ChevronRight className="size-4 text-muted-foreground" />
            </button>
            <button onClick={onClose} className="size-8 rounded-full grid place-items-center hover:bg-surface-muted transition-colors cursor-pointer">
              <X className="size-4 text-muted-foreground" />
            </button>
          </div>
        </div>
        {runNow.isError && (
          <div className="px-5 -mt-2 pb-2 text-[11px] text-destructive">
            {(runNow.error as any)?.message || "Couldn't run this agent — try again shortly."}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-5 space-y-4 scrollbar-thin">
          {isLoading && <div className="text-xs text-muted-foreground py-4 text-center">Loading latest run…</div>}
          {isError && (
            <div className="text-xs text-muted-foreground py-4 text-center">
              This agent hasn't completed a scheduled run yet — check back shortly.
            </div>
          )}
          {run && (
            <>
              {/* The prediction itself — this is the agent's actual forecast, so it
                  gets its own card like Recommended Action below. */}
              <div className="bg-surface-muted border border-border rounded-xl p-4">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                  <AgentIcon className="size-3.5" /> Prediction
                </div>
                <p className="text-base font-semibold text-foreground leading-snug">{run.narrative}</p>
              </div>

              {/* Recommended action is the headline of this panel — a directive,
                  not a description, and the primary thing the agent "says". */}
              <div className="bg-primary-soft border border-primary/20 rounded-xl p-4">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-primary uppercase tracking-wider mb-1.5">
                  <Sparkles className="size-3.5" /> Recommended action
                </div>
                <p className="text-sm font-medium text-foreground leading-snug">{run.recommendedAction}</p>
              </div>

              {/* Action row — direct to the module, ask Heera, or turn this into
                  a tracked HR task, instead of leaving the recommendation as
                  text to act on manually. */}
              <div className="grid grid-cols-1 gap-2">
                <button
                  onClick={() => { onClose(); goToRelated(); }}
                  className="inline-flex items-center justify-center gap-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg py-2.5 hover:opacity-95 transition-opacity"
                >
                  {meta.relatedLabel} <ArrowRight className="size-3.5" />
                </button>
                <button
                  onClick={guidedHelp}
                  className="inline-flex items-center justify-center gap-1.5 text-xs font-medium border border-border rounded-lg py-2.5 hover:bg-surface-muted transition-colors"
                  title="Opens the related module and asks Heera for help acting on this agent's suggestion"
                >
                  <Sparkles className="size-3.5 text-primary" /> Ask Heera to help act on this
                </button>
                {flaggedDepartment && (
                  createTask.isSuccess ? (
                    <div className="inline-flex items-center justify-center gap-1.5 text-xs font-medium text-success bg-success/10 rounded-lg py-2.5">
                      <CheckCircle2 className="size-3.5" /> Added as task {createTask.data?.id} for {flaggedDepartment}
                    </div>
                  ) : (
                    <button
                      onClick={() => createTask.mutate()}
                      disabled={createTask.isPending}
                      className="inline-flex items-center justify-center gap-1.5 text-xs font-medium border border-border rounded-lg py-2.5 hover:bg-surface-muted transition-colors disabled:opacity-50"
                      title="Creates a real task for this department's head, due in 7 days"
                    >
                      {createTask.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Calendar className="size-3.5 text-primary" />}
                      {createTask.isPending ? "Adding to HR Calendar…" : "Add as a task for HR to complete"}
                    </button>
                  )
                )}
                {createTask.isError && (
                  <div className="text-[11px] text-destructive text-center">Couldn't create the task — try again or use the module link above.</div>
                )}
              </div>

              {/* Everything below is reference detail, collapsed by default —
                  the agent already said what to do above; this is only for
                  someone who wants to see the numbers behind it. */}
              {glossary.length > 0 && (
                <div>
                  <button
                    onClick={() => setGlossaryOpen((v) => !v)}
                    className="w-full flex items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground py-1"
                  >
                    <span className="inline-flex items-center gap-1.5"><Info className="size-3.5" /> How this is evaluated</span>
                    <ChevronRight className={cn("size-3.5 transition-transform", glossaryOpen && "rotate-90")} />
                  </button>
                  {glossaryOpen && (
                    <div className="space-y-1.5 bg-surface-muted rounded-xl p-3 mt-1.5">
                      {glossary.map((g) => (
                        <div key={g.label} className="text-xs leading-relaxed">
                          <span className="font-semibold text-foreground">{g.label}:</span>{" "}
                          <span className="text-muted-foreground">{g.text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div>
                <button
                  onClick={() => setFindingsOpen((v) => !v)}
                  className="w-full flex items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground py-1"
                >
                  <span className="inline-flex items-center gap-1.5"><Brain className="size-3.5" /> Raw findings</span>
                  <ChevronRight className={cn("size-3.5 transition-transform", findingsOpen && "rotate-90")} />
                </button>
                {findingsOpen && (
                  <div className="space-y-1.5 mt-1.5">
                    {flattenFindings(run.findings).map((h) => (
                      <div key={h.label} className="text-xs bg-surface-muted rounded-lg p-2 flex items-center justify-between gap-3">
                        <span className="text-muted-foreground shrink-0">{h.label}</span>
                        <span className="font-semibold text-foreground text-right truncate">{h.value}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </motion.div>
    </>
  );
}

// Flat tile matching KpiCard/AgentCard's tone-coded treatment, so the
// dashboard's stat tiles read as one consistent design system.
function EmergencyStat({ label, value, tone }: { label: string; value: number; tone: "destructive" | "warning" | "success" }) {
  return (
    <div className={cn("relative overflow-hidden rounded-lg p-2 text-center bg-card border border-border")}>
      <span className={cn("absolute inset-x-0 top-0 h-0.5", KPI_ACCENT_BAR[tone])} />
      <div className={cn("text-lg font-bold tabular-nums", KPI_VALUE_TONE[tone])}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

// Flat, tone-coded surface: a soft solid icon-badge background plus a
// matching top accent bar — the color cue lives in the icon badge and the
// value text, not in a wash over the whole card.
const KPI_ICON_TONE: Record<"primary" | "success" | "warning" | "destructive" | "info", string> = {
  primary: "bg-primary/12 text-primary",
  success: "bg-success/12 text-success",
  warning: "bg-warning/15 text-warning-foreground",
  destructive: "bg-destructive/12 text-destructive",
  info: "bg-info/12 text-info",
};
const KPI_VALUE_TONE: Record<"primary" | "success" | "warning" | "destructive" | "info", string> = {
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning-foreground",
  destructive: "text-destructive",
  info: "text-info",
};
const KPI_ACCENT_BAR: Record<"primary" | "success" | "warning" | "destructive" | "info", string> = {
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  info: "bg-info",
};
const KPI_BORDER_TONE: Record<"primary" | "success" | "warning" | "destructive" | "info", string> = {
  primary: "border-primary/40",
  success: "border-success/40",
  warning: "border-warning/50",
  destructive: "border-destructive/40",
  info: "border-info/40",
};

/* ── KPI Card — flat, bordered stat tile: a full tone-colored border,
   colored icon badge, and a bold tone-colored value. ───────────────────── */
function KpiCard({ label, value, sub, icon: Icon, tone, onClick }: {
  label: string; value: string | number; sub: string;
  icon: typeof Users; tone: "primary" | "success" | "warning" | "destructive" | "info";
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative overflow-hidden rounded-2xl text-left p-4 flex flex-col justify-between w-full min-h-[136px]",
        "bg-card border-2", KPI_BORDER_TONE[tone],
        "shadow-sm transition-all duration-200 ease-out",
        "hover:-translate-y-0.5 hover:shadow-md",
        "cursor-pointer group",
      )}
    >

      <div className="flex items-center gap-2.5 min-w-0">
        <div className={cn("size-9 rounded-xl grid place-items-center shrink-0 transition-transform duration-200 ease-out group-hover:scale-110", KPI_ICON_TONE[tone])}>
          <Icon className="size-4" />
        </div>
        <span className="text-xs font-semibold uppercase tracking-wider leading-tight truncate text-muted-foreground">{label}</span>
      </div>
      <div>
        <div className={cn("text-3xl font-bold tabular-nums leading-tight tracking-tight", KPI_VALUE_TONE[tone])}>{value}</div>
        <div className="text-[11px] mt-1.5 truncate w-full text-muted-foreground">{sub}</div>
      </div>
    </button>
  );
}

/* ── AI Insights (Smart Alerts) Detail Overlay — full detail + methodology
   per signal, replacing what used to be a "View All Insights" redirect to
   /org360. Each item still keeps its own real action button. ───────────── */
function SmartAlertsDetailOverlay({ items, onClose }: {
  items: { icon: typeof Users; tone: "warning" | "destructive" | "info" | "success"; title: string; detail: string; methodology: string; action: () => void }[];
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-45 backdrop-blur-sm bg-black/10" onClick={onClose} />
      <motion.div
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className="fixed right-0 top-0 bottom-0 z-50 w-[440px] bg-card shadow-[-8px_0_24px_rgba(0,93,94,0.08)] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">AI Insights (Smart Alerts)</h2>
            <p className="text-[10px] text-primary font-medium tracking-wide uppercase mt-0.5">Live cross-module signals</p>
          </div>
          <button onClick={onClose} className="size-8 rounded-full grid place-items-center hover:bg-surface-muted transition-colors cursor-pointer">
            <X className="size-4 text-muted-foreground" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3 scrollbar-thin">
          {items.map((item) => (
            <div key={item.title} className="rounded-xl border border-border p-4">
              <div className="flex items-start gap-2.5">
                <div className={cn("size-9 rounded-xl grid place-items-center shrink-0 bg-surface-muted", toneText(item.tone))}>
                  <item.icon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-foreground leading-snug">{item.title}</div>
                  <div className="text-xs text-muted-foreground mt-1">{item.detail}</div>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground mt-3 pt-3 border-t border-border leading-relaxed">{item.methodology}</p>
              <button
                onClick={() => { item.action(); onClose(); }}
                className="mt-3 w-full inline-flex items-center justify-center gap-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg py-2 hover:opacity-95 transition-opacity"
              >
                Act on this <ArrowRight className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      </motion.div>
    </>
  );
}

/* ── KPI Detail Side Overlay — real breakdowns, real navigation ──────── */
function KpiDetailOverlay({ kpiKey, scopeLabel, department, zone, deptData, zoneData, totals, workforceAlerts, payrollSummary, onNavigate, onClose }: {
  kpiKey: string;
  scopeLabel: string;
  department: string;
  zone: string;
  deptData: { dept: string; fullName: string; count: number; attendance: number; vacancies: number }[];
  zoneData: { zone: string; count: number; attendance: number }[];
  totals: any;
  workforceAlerts: any;
  payrollSummary: any;
  onNavigate: (opts: { department?: string; zone?: string; search?: Record<string, unknown> }) => void;
  onClose: () => void;
}) {
  const meta: Record<string, { title: string; value: string; icon: typeof Activity; cta: { to: string; label: string; search?: any } }> = {
    total: { title: "Total Employees", value: totals.total.toLocaleString("en-IN"), icon: Users, cta: { to: "/employees", label: "View Employee Directory" } },
    present: { title: "Present Today", value: `${totals.presentPct.toFixed(1)}%`, icon: UserCheck, cta: { to: "/employees", label: "View Employees Absent Today", search: { presentToday: false } } },
    vacancies: { title: "Vacancies", value: totals.vacancies.toLocaleString("en-IN"), icon: Briefcase, cta: { to: "/org360", label: "View Vacancies by Department" } },
    promotion: { title: "Promotion Due", value: totals.promotionDue.toLocaleString("en-IN"), icon: TrendingUp, cta: { to: "/employees", label: "View Employees Due for Promotion", search: { flag: "promotionDue" } } },
    retirement: { title: "Retirement Due", value: totals.retirementDue.toLocaleString("en-IN"), icon: Clock, cta: { to: "/employees", label: "View Employees Due for Retirement", search: { flag: "retirementDue" } } },
    payroll: { title: "Payroll This Month", value: `₹${totals.payrollCr.toFixed(1)} Cr`, icon: IndianRupee, cta: { to: "/finance", label: "View Finance & Payroll" } },
  };
  const m = meta[kpiKey];

  return (
    <>
      <div className="fixed inset-0 z-45 backdrop-blur-sm bg-black/10" onClick={onClose} />
      <motion.div
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className="fixed right-0 top-0 bottom-0 z-50 w-[440px] bg-card shadow-[-8px_0_24px_rgba(0,93,94,0.08)] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{m.title}</h2>
            <p className="text-[10px] text-primary font-medium tracking-wide uppercase mt-0.5">{scopeLabel}</p>
          </div>
          <button onClick={onClose} className="size-8 rounded-full grid place-items-center hover:bg-surface-muted transition-colors cursor-pointer">
            <X className="size-4 text-muted-foreground" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 scrollbar-thin">
          <div className="bg-primary-soft rounded-xl p-4 flex items-center justify-between">
            <div>
              <div className="text-xs font-medium text-primary uppercase tracking-wider">Current Value</div>
              <div className="text-3xl font-bold text-foreground tracking-tight mt-1 tabular-nums">{m.value}</div>
            </div>
            <div className="size-11 rounded-lg bg-card grid place-items-center text-primary">
              <m.icon className="size-5" />
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">By Department</div>

            {kpiKey === "total" && (
              <BreakdownList
                rows={deptData.map((d) => ({ label: d.fullName, value: d.count.toLocaleString("en-IN"), onClick: () => onNavigate({ department: d.fullName }) }))}
                empty="No departments match the current filter."
              />
            )}

            {kpiKey === "present" && (
              <BreakdownList
                rows={[...deptData].sort((a, b) => a.attendance - b.attendance).map((d) => ({
                  label: d.fullName, value: `${d.attendance.toFixed(1)}%`,
                  onClick: () => onNavigate({ department: d.fullName, search: { presentToday: false } }),
                }))}
                empty="No attendance data available."
              />
            )}

            {kpiKey === "vacancies" && (
              <BreakdownList
                rows={[...deptData].sort((a, b) => b.vacancies - a.vacancies).map((d) => ({ label: d.fullName, value: `${d.vacancies} posts`, onClick: () => onNavigate({ department: d.fullName }) }))}
                empty="No vacancy data available."
              />
            )}

            {kpiKey === "promotion" && (
              <BreakdownList
                rows={(workforceAlerts?.promotion.byCadre ?? []).map((r: any) => ({ label: r.cadre, value: `${r.count} files` }))}
                empty="No employees currently flagged for promotion."
              />
            )}

            {kpiKey === "retirement" && (
              <BreakdownList
                rows={Object.entries(workforceAlerts?.retirement.buckets ?? {}).map(([period, count]) => ({ label: period, value: `${count} officers` }))}
                empty="No employees currently flagged for retirement."
              />
            )}

            {kpiKey === "payroll" && (
              <>
                <BreakdownList
                  rows={(workforceAlerts?.payroll.components ?? []).map((c: any) => ({ label: c.component, value: `₹${c.amountCr.toFixed(1)} Cr (${c.pct}%)` }))}
                  empty="No compensation data available."
                />
                {payrollSummary?.pendingApprovals != null && (
                  <div className="text-[11px] text-muted-foreground mt-2">
                    {payrollSummary.processedEmployees?.toLocaleString("en-IN")} processed · {payrollSummary.pendingApprovals} pending approvals · {payrollSummary.arrearsPending} arrears
                  </div>
                )}
              </>
            )}
          </div>

          {(kpiKey === "total" || kpiKey === "present") && zoneData.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">By Zone</div>
              {kpiKey === "total" ? (
                <BreakdownList
                  rows={zoneData.map((z) => ({ label: z.zone, value: z.count.toLocaleString("en-IN"), onClick: () => onNavigate({ zone: z.zone }) }))}
                  empty="No zone data available."
                />
              ) : (
                <BreakdownList
                  rows={[...zoneData].sort((a, b) => a.attendance - b.attendance).map((z) => ({
                    label: z.zone, value: `${z.attendance.toFixed(1)}%`,
                    onClick: () => onNavigate({ zone: z.zone, search: { presentToday: false } }),
                  }))}
                  empty="No zone attendance data available."
                />
              )}
            </div>
          )}

          <div className="pt-4">
            <Link
              to={m.cta.to}
              search={m.cta.search}
              onClick={() => { if (department !== "All Departments" || zone !== "All Zones") onNavigate({}); }}
              className="flex items-center justify-center gap-1.5 h-9 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 transition-opacity"
            >
              {m.cta.label} <ArrowRight className="size-3.5" />
            </Link>
          </div>
        </div>
      </motion.div>
    </>
  );
}

function BreakdownList({ rows, empty }: { rows: { label: string; value: string; warn?: boolean; onClick?: () => void }[]; empty: string }) {
  if (!rows.length) return <div className="text-xs text-muted-foreground py-3 text-center">{empty}</div>;
  return (
    <div>
      {rows.map((item) => {
        const Tag = item.onClick ? "button" : "div";
        return (
          <Tag
            key={item.label}
            onClick={item.onClick}
            className={cn(
              "text-xs py-3 flex items-center justify-between w-full text-left rounded-lg px-2 -mx-2",
              item.onClick && "hover:bg-surface-muted transition-colors cursor-pointer",
            )}
          >
            <span className="font-medium text-foreground/90 truncate mr-2">{item.label}</span>
            <span className={cn("font-semibold tabular-nums shrink-0", item.warn ? "text-destructive" : "text-foreground")}>{item.value}</span>
          </Tag>
        );
      })}
    </div>
  );
}

/* ── Panel Header ──────────────────────────────────────────────────── */
function PanelHeader({ title, titleGu, subtitle, action }: { title: string; titleGu?: string; subtitle?: string; action?: React.ReactNode }) {
  const { lang } = useUI();
  const displayTitle = (lang === "gu" && titleGu) ? titleGu : title;

  return (
    <div className="flex items-start justify-between gap-2 mb-2">
      <div className="min-w-0">
        <h3 className="text-lg font-semibold text-foreground truncate">{displayTitle}</h3>
        {subtitle && <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
