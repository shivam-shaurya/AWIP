import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState, useCallback, useEffect } from "react";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, Plus, Clock, AlertTriangle, X, ChevronRight, TrendingUp, UserRoundCog, ArrowLeftRight, CheckSquare, Square, Zap, Loader2, UserX, MessageCircleMore, ArrowUpRight, Info, Trash2 } from "lucide-react";
import { PieChart, Pie, Cell, BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } from "recharts";
import { Panel, Pill, Section } from "@/components/layout/section";
import { FilterPill } from "@/components/ui/filter-pill";
import { SearchPill } from "@/components/ui/search-pill";
import { useDepartment } from "@/context/department-context";
import { coreApi, ApiError } from "@/lib/api-client";
import type { Task } from "@/lib/mock-data";
import { DEPARTMENTS } from "@/lib/departments";
import { CreateTaskModal } from "@/components/tasks/create-task-modal";
import { CHART_COLORS, CHART_TOOLTIP_STYLE, CHART_ANIMATION } from "@/lib/chart-theme";
import { seedAssistantMessage } from "@/lib/assistant-bridge";
import { useUI } from "@/context/ui-context";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Pager } from "@/components/ui/pager";
import { cn } from "@/lib/utils";

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { type: "spring" as const, stiffness: 300, damping: 30 } },
};

const PAGE_SIZE = 10;

type TasksSearch = { q?: string };

export const Route = createFileRoute("/tasks")({
  head: () => ({ meta: [{ title: "Task Management · AWIP" }] }),
  validateSearch: (search: Record<string, unknown>): TasksSearch => ({
    q: typeof search.q === "string" ? search.q : undefined,
  }),
  component: TasksPage,
});

const TABS = ["Pending", "In Progress", "Completed", "Overdue", "Escalated"] as const;

function TasksPage() {
  const { department, zone } = useDepartment();
  const { setAssistantOpen } = useUI();
  const { q: deepLinkQuery } = Route.useSearch();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Pending");
  const [showCreate, setShowCreate] = useState(false);
  const [pendingDrawer, setPendingDrawer] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  const [sortBy, setSortBy] = useState<"priority" | "due">("priority");
  const [viewMode, setViewMode] = useState<"list" | "project">("list");
  const [page, setPage] = useState(1);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  // Seeds from a deep link (e.g. the header's global search) so landing here
  // from a search result actually filters to it, instead of showing the
  // default unfiltered Pending tab with the match nowhere in view.
  const [searchInput, setSearchInput] = useState(deepLinkQuery ?? "");
  const [search, setSearch] = useState(deepLinkQuery ?? "");

  // Debounce the search box so every keystroke doesn't fire a new request —
  // the actual query only re-runs 350ms after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  /* ── Modal states ── */
  const [reassignTask, setReassignTask] = useState<Task | null>(null);
  const [reallocateTask, setReallocateTask] = useState<Task | null>(null);

  /* ── Bulk selection ── */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  /* ── Delete ── */
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const queryClient = useQueryClient();
  const deleteMutation = useMutation({
    mutationFn: (id: string) => coreApi.deleteTask(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["tasks-count"] });
      queryClient.invalidateQueries({ queryKey: ["task-zone-stats"] });
      queryClient.invalidateQueries({ queryKey: ["task-trend"] });
      setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      if (detailTaskId === id) setDetailTaskId(null);
    },
  });
  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => { for (const id of ids) await coreApi.deleteTask(id); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["tasks-count"] });
      queryClient.invalidateQueries({ queryKey: ["task-zone-stats"] });
      queryClient.invalidateQueries({ queryKey: ["task-trend"] });
      setSelectedIds(new Set());
      setBulkDeleteConfirm(false);
    },
  });
  const bulkEscalateMutation = useMutation({
    mutationFn: (ids: string[]) => coreApi.escalateTasks(ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["tasks-count"] });
      queryClient.invalidateQueries({ queryKey: ["task-zone-stats"] });
      queryClient.invalidateQueries({ queryKey: ["task-trend"] });
      setSelectedIds(new Set());
    },
  });

  // Reset to page 1 whenever the active tab, scope, or search term changes —
  // otherwise a filter change could land on a now-nonexistent page N.
  useEffect(() => setPage(1), [tab, department, zone, search]);

  const deptParam = department !== "All Departments" ? department : undefined;
  const zoneParam = zone !== "All Zones" ? zone : undefined;
  const searchParam = search || undefined;

  // Server-side paginated fetch for the current tab — replaces the old
  // "fetch every task, filter/sort in memory" approach which shipped the
  // entire tasks table to the browser on every load. Real page-number
  // pagination (fixed page size, Prev/Next) rather than an ever-growing
  // "Load More" limit, so page N always re-fetches just that page's rows.
  const { data: tasksResponse, isLoading: tasksLoading, isError: tasksError } = useQuery({
    queryKey: ["tasks", deptParam, zoneParam, tab, searchParam, page],
    queryFn: () => coreApi.getTasks({ department: deptParam, zone: zoneParam, status: tab, q: searchParam, page, limit: PAGE_SIZE }),
  });
  const pageTasks: Task[] = tasksResponse?.data ?? [];
  const total = tasksResponse?.total ?? tasksResponse?.count ?? pageTasks.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const priorityScore = (p: string) => p === "High" ? 3 : p === "Medium" ? 2 : 1;

  // Sorting is applied only to the currently-loaded page — full server-side
  // sort across the whole filtered set isn't part of this API, and sorting
  // just the visible rows is an acceptable simplification (matches the
  // approved plan) rather than silently dropping the control.
  const filtered = useMemo(() => {
    return [...pageTasks].sort((a, b) => {
      if (sortBy === "priority") {
        return priorityScore(b.effectivePriority ?? b.priority) - priorityScore(a.effectivePriority ?? a.priority);
      }
      return a.dueIn - b.dueIn;
    });
  }, [pageTasks, sortBy]);

  const { data: alertsResp, isLoading: alertsLoading } = useQuery({
    queryKey: ["task-alerts"],
    queryFn: () => coreApi.getTaskAlerts(),
    enabled: showAlerts,
  });
  const taskAlerts = alertsResp?.data ?? [];

  /* ── Lightweight per-tab + per-priority totals ──
     Cheap `limit: 1` requests that only read the `total` field — gives
     accurate org-scoped counts for the tab badges, the workload donut and
     the "High Risk" banner without ever pulling the full task list. */
  const countQueries = useQueries({
    queries: [
      ...TABS.map((s) => ({
        queryKey: ["tasks-count", deptParam, zoneParam, s],
        queryFn: () => coreApi.getTasks({ department: deptParam, zone: zoneParam, status: s, page: 1, limit: 1 }),
      })),
      {
        queryKey: ["tasks-count", deptParam, zoneParam, "priority-high"],
        queryFn: () => coreApi.getTasks({ department: deptParam, zone: zoneParam, priority: "High", page: 1, limit: 1 }),
      },
    ],
  });
  const counts = TABS.reduce((acc, s, i) => {
    acc[s] = countQueries[i]?.data?.total ?? countQueries[i]?.data?.count ?? 0;
    return acc;
  }, {} as Record<(typeof TABS)[number], number>);
  const highPri = countQueries[TABS.length]?.data?.total ?? countQueries[TABS.length]?.data?.count ?? 0;
  const scopedTotal = Object.values(counts).reduce((s, v) => s + v, 0);

  // Employees-on-leave-with-active-tasks banner is derived from the
  // currently loaded page rather than the full org (no dedicated filter
  // exists server-side for it) — a narrow, deliberate simplification.
  const onLeaveTasks = pageTasks.filter((t) => t.employeeStatus === "On Leave" && t.status !== "Completed");

  const donutData = TABS.map(t => ({ name: t, value: counts[t] })).filter(d => d.value > 0);
  const COLORS = CHART_COLORS;

  /* ── Org-wide zone stats (used for both the Zone panel and the SLA/velocity
     roll-up — a weighted aggregate across zones, since there's no separate
     org-wide aggregate endpoint) ── */
  const { data: zoneStatsResp, isLoading: zoneStatsLoading } = useQuery({
    queryKey: ["task-zone-stats"],
    queryFn: () => coreApi.getTaskZoneStats(),
  });
  const zoneStats = zoneStatsResp?.data ?? [];
  const grandTotal = zoneStats.reduce((s, z) => s + z.total, 0);
  const slaPct = grandTotal ? Math.round(zoneStats.reduce((s, z) => s + z.slaPct * z.total, 0) / grandTotal) : 100;
  const avgTat = grandTotal ? Math.round(zoneStats.reduce((s, z) => s + z.avgTatDays * z.total, 0) / grandTotal) : 0;

  // When nothing is scoped to a specific department/zone, the fully org-wide
  // aggregate flattens ~168 real department+zone combinations into a
  // near-constant band — ask the backend for the genuinely best/weakest real
  // combos as separate series instead, so the chart shows real variance.
  const isTrendScoped = !!deptParam || !!zoneParam;
  const { data: trendResp, isLoading: trendLoading } = useQuery({
    queryKey: ["task-trend", deptParam, zoneParam],
    queryFn: () => coreApi.getTaskTrend({ department: deptParam, zone: zoneParam, months: 6, compare: !isTrendScoped }),
  });
  const trendData = trendResp?.data ?? [];
  const trendSeries = trendResp?.series ?? [];

  /* ── Bulk helpers ── */
  const allFilteredSelected = filtered.length > 0 && filtered.every(t => selectedIds.has(t.id));
  const toggleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filtered.forEach(t => next.delete(t.id));
      } else {
        filtered.forEach(t => next.add(t.id));
      }
      return next;
    });
  }, [filtered, allFilteredSelected]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="p-5 space-y-4 max-w-[1600px] mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Task Management</h1>
          <p className="text-sm text-muted-foreground">Operational workboard · scope: {department}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowAlerts(true)}
            className="h-9 px-3 inline-flex items-center gap-1.5 rounded-lg bg-primary/5 text-primary text-sm font-medium hover:bg-primary/10 transition-colors"
          >
            <Sparkles className="size-4" /> Smart Alerts
          </button>
          <button
            onClick={() => setPendingDrawer(true)}
            className="h-9 px-3.5 inline-flex items-center gap-1.5 rounded-full bg-surface-muted text-sm font-medium hover:bg-surface-muted/70 transition-colors"
          >
            <Clock className="size-4" /> My Pending Tasks
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="h-9 px-4 inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground text-sm font-medium shadow-[0_4px_24px_rgba(0,93,94,0.15)] hover:opacity-95 transition-opacity"
          >
            <Plus className="size-4" /> Create Task
          </button>
        </div>
      </div>

      {/* Alert banners — side-by-side when both apply, to recover vertical
          space above the task list; a single full-width banner otherwise */}
      {(onLeaveTasks.length > 0 || highPri > 0) && (
        <div className={cn("grid gap-3", onLeaveTasks.length > 0 && highPri > 0 ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1")}>
          {onLeaveTasks.length > 0 && (
            <div className="bg-warning/10 text-warning-foreground rounded-xl p-3 flex items-start gap-3">
              <UserX className="size-5 shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-sm">Needs Reassignment — Employee On Leave</h3>
                <p className="text-xs opacity-90 mt-0.5">
                  {onLeaveTasks.length} active task{onLeaveTasks.length > 1 ? "s are" : " is"} assigned to {onLeaveTasks.length > 1 ? "employees" : "an employee"} currently on leave. Use the reassign action to hand these off.
                </p>
              </div>
            </div>
          )}

          {highPri > 0 && (
            <div className="bg-destructive/10 text-destructive rounded-xl p-3 flex items-start gap-3">
              <AlertTriangle className="size-5 shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-sm">High Risk Tasks Alert</h3>
                <p className="text-xs opacity-90 mt-0.5">There are {highPri} high-priority tasks requiring immediate attention within {department === "All Departments" ? "the organization" : department}.</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Visual Analytics Header */}
      <motion.div variants={containerVariants} initial="hidden" animate="show" className="space-y-4">
        <motion.div variants={itemVariants} className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* 1. Workload Distribution */}
          <Panel className="p-4 flex flex-col border-2 border-primary/40">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Workload Distribution</h3>
            <div className="flex items-center gap-4 flex-1 min-h-[140px]">
              <div className="w-[120px] h-full relative shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={donutData} cx="50%" cy="50%" innerRadius={35} outerRadius={55} dataKey="value" stroke="none" {...CHART_ANIMATION}>
                      {donutData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[TABS.indexOf(entry.name as any)]} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <div className="text-xl font-bold text-foreground">{scopedTotal}</div>
                </div>
              </div>
              <div className="flex-1 flex flex-col gap-1 justify-center">
                {TABS.map((t, i) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={cn(
                      "text-left flex items-center gap-2 px-2 py-1 rounded transition-colors text-[10px] font-medium border border-transparent w-full",
                      tab === t ? "bg-primary-soft border-primary/30 text-foreground shadow-sm" : "text-muted-foreground hover:bg-surface-muted hover:text-foreground"
                    )}
                  >
                    <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: COLORS[i] }} />
                    <span className="font-semibold text-foreground/90">{t}</span>
                    <span className="ml-auto tabular-nums font-bold bg-muted/60 px-1.5 py-0.5 rounded text-[10px]">{counts[t]}</span>
                  </button>
                ))}
              </div>
            </div>
          </Panel>

          {/* 2. Task Stats by Zone */}
          <Panel className="p-4 flex flex-col border-2 border-primary/40">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Task Stats by Zone</h3>
            <div className="flex-1 min-h-[140px]">
              {zoneStatsLoading ? (
                <div className="h-full flex items-center justify-center text-xs text-muted-foreground gap-2"><Loader2 className="size-3.5 animate-spin" /> Loading…</div>
              ) : zoneStats.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-muted-foreground">No zone data available.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={zoneStats} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <XAxis dataKey="zone" tick={{ fontSize: 9, fill: 'var(--color-muted-foreground)' }} tickLine={false} axisLine={false} interval={0} angle={-20} textAnchor="end" height={30} />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} tickLine={false} axisLine={false} width={28} />
                    <Tooltip cursor={{ fill: 'var(--color-surface-muted)' }} contentStyle={CHART_TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    {/* Real task volume per zone (genuinely ranges ~570-1291,
                        a 2x spread) split by completed vs. overdue, instead of
                        SLA% — which clusters in a narrow 71-77% band across
                        every zone and reads as "all zones look equal." */}
                    <Bar dataKey="completed" name="Completed" stackId="tasks" radius={[0, 0, 0, 0]} barSize={20} fill="var(--color-success)" {...CHART_ANIMATION} />
                    <Bar dataKey="overdue" name="Overdue" stackId="tasks" radius={[4, 4, 0, 0]} barSize={20} fill="var(--color-destructive)" {...CHART_ANIMATION} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </Panel>

          {/* 3. SLA Health & Velocity */}
          <Panel className="p-4 flex flex-col justify-center border-2 border-primary/40">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-4">SLA Health & Velocity</h3>

            <div className="mb-4">
              <div className="flex justify-between items-end mb-1">
                <span className="text-2xl font-bold tabular-nums text-foreground">{slaPct}%</span>
                <span className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">Tasks meeting SLA</span>
              </div>
              <div className="h-2 w-full bg-surface-muted rounded-full overflow-hidden">
                <div className={cn("h-full transition-all", slaPct >= 90 ? "bg-success" : slaPct >= 75 ? "bg-warning" : "bg-destructive")} style={{ width: `${slaPct}%` }} />
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-border pt-4 mb-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Avg Turnaround (org-wide)</div>
                <div className="text-lg font-semibold tabular-nums text-foreground">{avgTat} Days</div>
              </div>
              <div className="flex items-center gap-1 text-primary text-xs font-bold tracking-wide bg-primary/10 px-2 py-1 rounded">
                <TrendingUp className="size-3" /> See trend below
              </div>
            </div>

            <div className="flex gap-1.5 rounded-md bg-surface-muted px-2.5 py-2 text-[10.5px] leading-snug text-muted-foreground">
              <Info className="size-3 shrink-0 mt-0.5" />
              <span>
                <strong className="text-foreground font-semibold">SLA %</strong> = share of all assigned tasks that are on-track or completed without breaching their due date (task-count weighted across every zone).{" "}
                <strong className="text-foreground font-semibold">Avg Turnaround</strong> = mean days from assignment to completion (or to today, if still open), weighted the same way. Both roll up the live task table — no estimate or sample.
              </span>
            </div>
          </Panel>
        </motion.div>

        <motion.div variants={itemVariants} className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <TaskTrendPanel data={trendData} series={trendSeries} isLoading={trendLoading} />
          </div>
          <ProductivityInsightCard onDiscuss={setAssistantOpen} />
        </motion.div>
      </motion.div>

      <Section
        title={tab}
        subtitle="Department-based operational tasks"
        action={
          <div className="flex items-center gap-3 text-xs">
            <SearchPill value={searchInput} onChange={setSearchInput} placeholder="Search by title, project, or task ID…" size="compact" className="w-56" />
            <div className="flex items-center rounded-full border border-border overflow-hidden">
              <button
                onClick={() => setViewMode("list")}
                className={cn("h-8 px-2.5 text-xs font-medium", viewMode === "list" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-surface-muted")}
              >
                List
              </button>
              <button
                onClick={() => setViewMode("project")}
                className={cn("h-8 px-2.5 text-xs font-medium", viewMode === "project" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-surface-muted")}
              >
                By Project
              </button>
            </div>
            {viewMode === "list" && (
              <>
                <FilterPill
                  value={sortBy === "priority" ? "Priority (High to Low)" : "Due Date (Earliest First)"}
                  onChange={(v) => setSortBy(v === "Priority (High to Low)" ? "priority" : "due")}
                  options={["Priority (High to Low)", "Due Date (Earliest First)"]}
                  label="Sort By"
                />
              </>
            )}
          </div>
        }
      >
        {viewMode === "project" ? (
          <ProjectGroupedView department={deptParam} zone={zoneParam} status={tab} search={searchParam} />
        ) : (
        <Panel padded={false}>
          <div className="overflow-x-auto overflow-y-hidden scrollbar-thin relative rounded-t-xl">
            <table className="w-full text-sm">
              <thead className="bg-sidebar text-[11px] uppercase tracking-wider text-sidebar-foreground">
                <tr>
                  {/* Checkbox column */}
                  <th className="text-left font-medium px-3 py-2.5 whitespace-nowrap w-10">
                    <button onClick={toggleSelectAll} className="flex items-center justify-center p-0.5 rounded hover:bg-primary/10 transition-colors" title="Select All">
                      {allFilteredSelected && filtered.length > 0 ? (
                        <CheckSquare className="size-4 text-primary" />
                      ) : (
                        <Square className="size-4 text-muted-foreground" />
                      )}
                    </button>
                  </th>
                  <th className="text-left font-medium px-4 py-2.5 whitespace-nowrap">Task ID</th>
                  <th className="text-left font-medium px-4 py-2.5 whitespace-nowrap">Project</th>
                  <th className="text-left font-medium px-4 py-2.5 whitespace-nowrap">Title & AI Summary</th>
                  <th className="text-left font-medium px-4 py-2.5 whitespace-nowrap">Department</th>
                  <th className="text-left font-medium px-4 py-2.5 whitespace-nowrap">Assigned To</th>
                  <th className="text-left font-medium px-4 py-2.5 whitespace-nowrap">Priority</th>
                  <th className="text-left font-medium px-4 py-2.5 whitespace-nowrap">Progress</th>
                  <th className="text-left font-medium px-4 py-2.5 whitespace-nowrap">Status</th>
                  <th className="text-left font-medium px-4 py-2.5 whitespace-nowrap">TAT</th>
                  <th className="text-left font-medium px-4 py-2.5 whitespace-nowrap">Due In</th>
                  <th className="text-left font-medium px-4 py-2.5 whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {tasksLoading ? (
                  <tr>
                    <td colSpan={11} className="px-4 py-8 text-center text-muted-foreground">
                      <span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Loading tasks…</span>
                    </td>
                  </tr>
                ) : tasksError ? (
                  <tr>
                    <td colSpan={11} className="px-4 py-8 text-center text-destructive">
                      Couldn't load tasks. Is the AWIP core server running?
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="px-4 py-8 text-center text-muted-foreground">
                      No {tab.toLowerCase()} tasks found for this scope.
                    </td>
                  </tr>
                ) : (
                  filtered.map((t, i) => {
                    const effPriority = t.effectivePriority ?? t.priority;
                    const pct = t.progressPct ?? (t.status === "Completed" ? 100 : t.status === "Pending" ? 0 : 50);
                    const pctTone = pct >= 75 ? "bg-success" : pct >= 40 ? "bg-primary" : "bg-warning";
                    return (
                    <tr
                      key={t.id}
                      onClick={() => setDetailTaskId(t.id)}
                      className={cn(
                        "hover:bg-surface-muted/70 transition-colors cursor-pointer",
                        selectedIds.has(t.id) ? "bg-primary/5" : i % 2 === 1 ? "bg-surface-muted" : "",
                      )}
                    >
                      {/* Checkbox */}
                      <td className="px-3 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => toggleSelect(t.id)} className="flex items-center justify-center p-0.5 rounded hover:bg-primary/10 transition-colors">
                          {selectedIds.has(t.id) ? (
                            <CheckSquare className="size-4 text-primary" />
                          ) : (
                            <Square className="size-4 text-muted-foreground" />
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">{t.id}</td>
                      <td className="px-4 py-3 font-medium max-w-[150px] truncate" title={t.project}>{t.project}</td>
                      <td className="px-4 py-3 max-w-[280px]">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0">
                            <div className="font-medium truncate" title={t.title}>{t.title}</div>
                            <div className="text-[10.5px] text-muted-foreground mt-1 line-clamp-1 border-l-2 border-primary/40 pl-1.5" title={t.aiSummary || "AI summary not available"}>
                              {t.aiSummary || "AI summary not available"}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap">{t.department || (t as any).dept}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center justify-between gap-2">
                          <span className={cn("truncate flex items-center gap-1.5", t.employeeStatus === "On Leave" && "text-warning font-medium")}>
                            {t.employeeName || (t as any).assignee}
                            {t.employeeStatus === "On Leave" && (
                              <span className="group relative">
                                <UserX className="size-3.5 text-warning shrink-0" />
                                <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-50 whitespace-nowrap rounded-md bg-popover border border-border px-2 py-1 text-[10px] text-popover-foreground shadow-md opacity-0 group-hover:opacity-100 transition-opacity">
                                  On leave — reassign
                                </span>
                              </span>
                            )}
                          </span>
                          {(t.status === "Pending" || t.status === "Overdue") && (
                            <button
                              onClick={(e) => e.stopPropagation()}
                              title="AI Auto-Assign & Workload Balance"
                              className="shrink-0 p-1 rounded-md hover:bg-primary/10 text-primary transition-colors border border-transparent hover:border-primary/20"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z"></path><path d="m14 7 3 3"></path><path d="M5 6v4"></path><path d="M19 14v4"></path><path d="M10 2v2"></path><path d="M7 8H3"></path><path d="M21 16h-4"></path><path d="M11 3H9"></path></svg>
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Pill tone={effPriority === "High" ? "destructive" : effPriority === "Medium" ? "warning" : "primary"}>
                          {effPriority}
                        </Pill>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap w-[100px]">
                        <div className="flex items-center gap-1.5">
                          <div className="h-2 w-16 bg-surface-muted rounded-full overflow-hidden shrink-0">
                            <div className={cn("h-full transition-all", pctTone)} style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Pill tone={t.status === "Completed" ? "success" : t.status === "Pending" ? "warning" : "primary"}>
                          {t.status}
                        </Pill>
                      </td>
                      <td className="px-4 py-3 tabular-nums text-xs whitespace-nowrap">{t.tatDays}d</td>
                      <td className="px-4 py-3 tabular-nums text-xs whitespace-nowrap">
                        {t.dueIn < 0 ? (
                          <span className="text-destructive font-medium flex items-center gap-1">
                            Overdue {-t.dueIn}d
                          </span>
                        ) : t.dueIn === 0 ? (
                          <span className="text-warning-foreground font-medium">Today</span>
                        ) : (
                          <span>{t.dueIn}d</span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-1">
                          {/* Reassign button */}
                          <div className="group relative">
                            <button
                              onClick={() => setReassignTask(t)}
                              className="shrink-0 p-1.5 rounded-md hover:bg-primary/10 text-primary transition-colors border border-transparent hover:border-primary/20"
                            >
                              <UserRoundCog className="size-3.5" />
                            </button>
                            <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-50 whitespace-nowrap rounded-md bg-popover border border-border px-2 py-1 text-[10px] text-popover-foreground shadow-md opacity-0 group-hover:opacity-100 transition-opacity">
                              Reassign Task
                            </div>
                          </div>

                          {/* Reallocate button */}
                          <div className="group relative">
                            <button
                              onClick={() => setReallocateTask(t)}
                              className="shrink-0 p-1.5 rounded-md hover:bg-chart-1/10 text-chart-1 transition-colors border border-transparent hover:border-chart-1/20"
                            >
                              <ArrowLeftRight className="size-3.5" />
                            </button>
                            <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-50 whitespace-nowrap rounded-md bg-popover border border-border px-2 py-1 text-[10px] text-popover-foreground shadow-md opacity-0 group-hover:opacity-100 transition-opacity">
                              Reallocate to Department
                            </div>
                          </div>

                          {/* Delete button */}
                          <div className="group relative">
                            <button
                              onClick={() => setDeleteTarget(t)}
                              className="shrink-0 p-1.5 rounded-md hover:bg-destructive/10 text-destructive transition-colors border border-transparent hover:border-destructive/20"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                            <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-50 whitespace-nowrap rounded-md bg-popover border border-border px-2 py-1 text-[10px] text-popover-foreground shadow-md opacity-0 group-hover:opacity-100 transition-opacity">
                              Delete Task
                            </div>
                          </div>

                          {/* Existing Draft Follow-up for overdue/high-risk */}
                          {(t.status === "Overdue" || t.delayRisk === "High") && (
                            <button className="flex items-center gap-1 text-[10px] uppercase font-bold text-primary hover:bg-primary/10 px-2 py-1.5 rounded transition-colors border border-primary/30">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                              Follow-up
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );})
                )}
              </tbody>
            </table>
          </div>

          {/* ── Bulk Actions Floating Bar ── */}
            {selectedIds.size > 0 && (
              <div className="sticky bottom-4 left-0 right-0 flex justify-center z-30 pointer-events-none px-4">
                <div className="pointer-events-auto inline-flex items-center gap-3 bg-primary text-primary-foreground px-5 py-2.5 rounded-xl shadow-lg shadow-primary/25 animate-in slide-in-from-bottom-4 duration-300">
                  <span className="text-sm font-semibold tabular-nums">{selectedIds.size} task{selectedIds.size > 1 ? "s" : ""} selected</span>
                  <div className="w-px h-5 bg-primary-foreground/30" />
                  <button
                    onClick={() => { if (selectedIds.size > 0) { const first = filtered.find(t => selectedIds.has(t.id)); if (first) setReassignTask(first); } }}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-primary-foreground/15 hover:bg-primary-foreground/25 transition-colors"
                  >
                    <UserRoundCog className="size-3.5" /> Bulk Reassign
                  </button>
                  <button
                    onClick={() => { if (selectedIds.size > 0) { const first = filtered.find(t => selectedIds.has(t.id)); if (first) setReallocateTask(first); } }}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-primary-foreground/15 hover:bg-primary-foreground/25 transition-colors"
                  >
                    <ArrowLeftRight className="size-3.5" /> Bulk Reallocate
                  </button>
                  <button
                    onClick={() => bulkEscalateMutation.mutate([...selectedIds])}
                    disabled={bulkEscalateMutation.isPending}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-primary-foreground/15 hover:bg-primary-foreground/25 transition-colors disabled:opacity-60"
                  >
                    {bulkEscalateMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />} Bulk Escalate
                  </button>
                  <button
                    onClick={() => setBulkDeleteConfirm(true)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-destructive/25 hover:bg-destructive/40 transition-colors"
                  >
                    <Trash2 className="size-3.5" /> Delete
                  </button>
                  <div className="w-px h-5 bg-primary-foreground/30" />
                  <button
                    onClick={() => setSelectedIds(new Set())}
                    className="p-1 rounded-md hover:bg-primary-foreground/20 transition-colors"
                    title="Clear selection"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              </div>
            )}

          {/* Pagination — same shared control as Employee 360's directory */}
          {totalPages > 1 && (
            <Pager page={page} totalPages={totalPages} onChange={setPage} />
          )}
        </Panel>
        )}
      </Section>

      {/* ── Task Detail Overlay ── */}
      <AnimatePresence>
        {detailTaskId && <TaskDetailOverlay taskId={detailTaskId} onClose={() => setDetailTaskId(null)} onRequestDelete={(task) => setDeleteTarget(task)} />}
      </AnimatePresence>

      {/* ── Reassign Modal ── */}
      {reassignTask && <ReassignModal task={reassignTask} isBulk={selectedIds.size > 1} bulkCount={selectedIds.size} onClose={() => setReassignTask(null)} />}

      {/* ── Reallocate Modal ── */}
      {reallocateTask && <ReallocateModal task={reallocateTask} isBulk={selectedIds.size > 1} bulkCount={selectedIds.size} onClose={() => setReallocateTask(null)} />}

      {/* ── Delete confirmations ── */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete this task?"
        description={deleteTarget ? `"${deleteTarget.title}" (${deleteTarget.id}) will be permanently removed. This cannot be undone.` : ""}
        confirmLabel="Delete Task"
        isPending={deleteMutation.isPending}
        onConfirm={() => { if (deleteTarget) deleteMutation.mutate(deleteTarget.id, { onSuccess: () => setDeleteTarget(null) }); }}
      />
      <ConfirmDialog
        open={bulkDeleteConfirm}
        onOpenChange={setBulkDeleteConfirm}
        title={`Delete ${selectedIds.size} task${selectedIds.size > 1 ? "s" : ""}?`}
        description="These tasks will be permanently removed. This cannot be undone."
        confirmLabel="Delete Tasks"
        isPending={bulkDeleteMutation.isPending}
        onConfirm={() => bulkDeleteMutation.mutate([...selectedIds])}
      />

      {/* Smart Alerts Right Sidebar Drawer */}
      <AnimatePresence>
        {showAlerts && (
          <>
            <div className="fixed inset-0 backdrop-blur-sm bg-black/10 z-40" onClick={() => setShowAlerts(false)} />
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="fixed inset-y-0 right-0 w-full sm:w-[400px] bg-card shadow-[-8px_0_24px_rgba(0,93,94,0.08)] z-50 p-6 flex flex-col"
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold flex items-center gap-2"><Sparkles className="size-5 text-primary" /> Smart Alerts</h2>
                <button onClick={() => setShowAlerts(false)} className="p-1 rounded-md hover:bg-surface-muted transition-colors"><X className="size-5" /></button>
              </div>

              <div className="flex items-center justify-between mb-4">
                <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Latest Activity</span>
                <button className="text-[10px] text-muted-foreground hover:text-foreground uppercase tracking-wider font-medium">Mark all read</button>
              </div>

              <div className="space-y-3 overflow-y-auto pr-2 pb-10 flex-1 scrollbar-thin">
                {alertsLoading ? (
                  <div className="text-xs text-muted-foreground text-center py-8">Loading…</div>
                ) : taskAlerts.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-8">No active alerts — all tasks are within SLA.</div>
                ) : (
                  taskAlerts.map((a: any, i: number) => {
                    const tone = a.severity === "High" ? "destructive" : a.type === "Department Bottleneck" ? "success" : "warning";
                    const Icon = a.type === "SLA Breach" ? AlertTriangle : a.type === "Overloaded Officer" ? Clock : TrendingUp;
                    return (
                      <div key={i} className="rounded-xl p-3 bg-card border border-border shadow-sm">
                        <div className="flex gap-2">
                          <Icon className={cn("size-4 shrink-0 mt-0.5", tone === "destructive" ? "text-destructive" : tone === "success" ? "text-success" : "text-warning-foreground")} />
                          <div className="min-w-0 flex-1">
                            <div className="mb-1"><Pill tone={tone as any}>{a.type}</Pill></div>
                            <div className="text-sm font-medium text-foreground mb-1">{a.title}</div>
                            <div className="text-xs text-muted-foreground leading-relaxed">{a.detail}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {showCreate && <CreateTaskModal onClose={() => setShowCreate(false)} />}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Reassign Modal
   ══════════════════════════════════════════════════════════════ */
function ReassignModal({ task, isBulk, bulkCount, onClose }: { task: Task; isBulk: boolean; bulkCount: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [selectedSuggestion, setSelectedSuggestion] = useState<number | null>(null);
  const [manualOverride, setManualOverride] = useState("");
  const [manualSearch, setManualSearch] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState(task.employeeStatus === "On Leave" ? "Leave" : "Manual");

  const { data: workloadResp } = useQuery({
    queryKey: ["employee-workload"],
    queryFn: () => coreApi.getEmployeeWorkload(),
  });
  const { data: employeesResp } = useQuery({
    queryKey: ["employees", "All Departments"],
    queryFn: () => coreApi.getEmployees(),
  });
  const employees = employeesResp?.data ?? [];

  const filteredManualEmployees = useMemo(() => {
    if (!manualSearch.trim()) return [];
    const q = manualSearch.toLowerCase().trim();
    return employees.filter((e: any) =>
      (e.name ?? "").toLowerCase().includes(q) ||
      (e.id ?? "").toLowerCase().includes(q) ||
      (e.designation ?? "").toLowerCase().includes(q) ||
      (e.department ?? "").toLowerCase().includes(q)
    );
  }, [employees, manualSearch]);

  const selectedManualEmp = useMemo(() => {
    if (!manualOverride) return null;
    return employees.find((e: any) => e.id === manualOverride) ?? null;
  }, [employees, manualOverride]);

  const suggestions = useMemo(() => {
    const workload = (workloadResp?.data ?? []) as { employeeId: string; name: string; department: string; openTaskCount: number; totalTatDays: number }[];
    return workload
      .filter((w) => w.department === task.department && w.employeeId !== (task as any).employeeId)
      .sort((a, b) => a.openTaskCount - b.openTaskCount)
      .slice(0, 3)
      .map((w) => ({ ...w, matchScore: Math.max(60, 98 - w.openTaskCount * 4) }));
  }, [workloadResp, task]);

  const reassignMutation = useMutation({
    mutationFn: (employeeId: string) => coreApi.reassignTask(task.id, { employeeId, reason, note: reason === "Leave" ? "Reassigned due to employee leave" : reason === "ChargeHandover" ? "Charge handover" : undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      setConfirmed(true);
      setTimeout(onClose, 1200);
    },
  });

  const handleConfirm = () => {
    const employeeId = selectedSuggestion !== null ? suggestions[selectedSuggestion].employeeId : manualOverride;
    if (!employeeId) return;
    reassignMutation.mutate(employeeId);
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 animate-in fade-in duration-200" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-4 duration-300 max-h-[90vh] overflow-y-auto scrollbar-thin" onClick={e => e.stopPropagation()}>
          
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="flex items-center gap-2">
              <div className="size-8 rounded-lg bg-surface-muted flex items-center justify-center">
                <UserRoundCog className="size-4 text-primary" />
              </div>
              <div>
                <h2 className="font-semibold text-foreground">{isBulk ? `Bulk Reassign (${bulkCount} tasks)` : "Reassign Task"}</h2>
                {!isBulk && <p className="text-xs text-muted-foreground">{task.id} · {task.title}</p>}
              </div>
            </div>
            <button onClick={onClose} className="p-1 rounded-md hover:bg-surface-muted transition-colors"><X className="size-5 text-muted-foreground" /></button>
          </div>

          {confirmed ? (
            <div className="p-8 text-center">
              <div className="size-12 rounded-full bg-surface-muted flex items-center justify-center mx-auto mb-3">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
              </div>
              <p className="font-semibold text-foreground">Reassignment Confirmed</p>
              <p className="text-xs text-muted-foreground mt-1">Workload has been rebalanced automatically.</p>
            </div>
          ) : (
            <div className="p-5 space-y-5">
              {/* Current Assignee */}
              <div className="bg-surface rounded-lg p-3 border border-border">
                <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Current Assignee</div>
                <div className="flex items-center gap-3">
                  <div className="size-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                    {task.employeeName.split(" ").map(n => n[0]).join("")}
                  </div>
                  <div>
                    <div className="font-medium text-sm text-foreground">{task.employeeName}</div>
                    <div className="text-xs text-muted-foreground">{task.department}</div>
                  </div>
                </div>
              </div>

              {/* Reason */}
              <div>
                <div className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Reason for Reassignment</div>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full h-9 px-3 rounded-md bg-card border border-border text-sm focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                >
                  <option value="Manual">Manual reassignment</option>
                  <option value="Leave">Employee on leave</option>
                  <option value="ChargeHandover">Charge handover</option>
                  <option value="WorkloadBalance">Workload balancing</option>
                </select>
              </div>

              {/* Workload-based Suggested Alternatives */}
              <div>
                <div className="flex items-center gap-1.5 mb-2.5">
                  <Sparkles className="size-3.5 text-primary" />
                  <span className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground">Least-loaded in {task.department}</span>
                </div>
                {suggestions.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No workload data available for this department — use manual override below.</div>
                ) : (
                  <div className="space-y-2">
                    {suggestions.map((s, i) => (
                      <div
                        key={s.employeeId}
                        className={cn(
                          "rounded-lg p-3 border transition-all cursor-pointer",
                          selectedSuggestion === i
                            ? "border-primary bg-primary/5 shadow-sm"
                            : "border-border bg-surface hover:border-primary/30 hover:bg-surface-muted"
                        )}
                        onClick={() => { setSelectedSuggestion(i); setManualOverride(""); }}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className="size-6 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-bold text-primary">
                              {s.name.split(" ").map(n => n[0]).join("")}
                            </div>
                            <div>
                              <span className="text-sm font-medium text-foreground">{s.name}</span>
                              <span className="text-[10px] text-muted-foreground ml-2">{s.department}</span>
                            </div>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); setSelectedSuggestion(i); setManualOverride(""); }}
                            className={cn(
                              "text-[10px] font-semibold px-2.5 py-1 rounded-md transition-colors",
                              selectedSuggestion === i
                                ? "bg-primary text-primary-foreground"
                                : "bg-primary/10 text-primary hover:bg-primary/20"
                            )}
                          >
                            {selectedSuggestion === i ? "Selected" : "Select"}
                          </button>
                        </div>
                        <div className="flex items-center gap-4 text-xs">
                          <div className="flex-1">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-muted-foreground">Open tasks</span>
                              <span className="tabular-nums font-medium text-foreground">{s.openTaskCount}</span>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="text-muted-foreground mb-0.5">Match Score</div>
                            <div className="font-bold text-foreground tabular-nums">{s.matchScore}%</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Manual Override (Search-based) */}
              <div className="space-y-2">
                <div className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground">Manual Override</div>
                {selectedManualEmp ? (
                  <div className="flex items-center justify-between p-3 rounded-lg border border-primary bg-primary/10 text-sm">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="size-8 rounded-full bg-primary/20 text-primary grid place-items-center text-xs font-bold shrink-0">
                        {selectedManualEmp.name.split(" ").map((n: string) => n[0]).join("")}
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold text-foreground truncate">{selectedManualEmp.name}</div>
                        <div className="text-xs text-muted-foreground truncate">{selectedManualEmp.id} · {selectedManualEmp.designation} · {selectedManualEmp.department}</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setManualOverride(""); setManualSearch(""); }}
                      className="text-xs text-muted-foreground hover:text-foreground font-medium underline shrink-0 ml-2 cursor-pointer"
                    >
                      Clear
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <SearchPill
                      value={manualSearch}
                      onChange={(v) => setManualSearch(v)}
                      placeholder="Type employee name, ID, or designation to search…"
                      className="w-full"
                    />
                    {manualSearch.trim() && (
                      <div className="max-h-48 overflow-y-auto scrollbar-thin border border-border rounded-lg bg-card divide-y divide-border shadow-md">
                        {filteredManualEmployees.length === 0 ? (
                          <div className="p-3 text-xs text-muted-foreground text-center">No employee found matching "{manualSearch}".</div>
                        ) : (
                          filteredManualEmployees.slice(0, 6).map((e: any) => (
                            <button
                              key={e.id}
                              type="button"
                              onClick={() => {
                                setManualOverride(e.id);
                                setSelectedSuggestion(null);
                                setManualSearch("");
                              }}
                              className="w-full text-left p-2.5 hover:bg-surface-muted transition-colors flex items-center justify-between gap-2 cursor-pointer"
                            >
                              <div className="min-w-0">
                                <div className="font-medium text-sm text-foreground truncate">{e.name}</div>
                                <div className="text-xs text-muted-foreground truncate">{e.id} · {e.designation} · {e.department}</div>
                              </div>
                              <span className="text-xs font-semibold text-primary bg-primary/10 px-2.5 py-1 rounded-full shrink-0">Select</span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {reassignMutation.isError && (
                <div className="text-xs text-destructive">
                  {reassignMutation.error instanceof ApiError ? reassignMutation.error.message : "Failed to reassign task."}
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 pt-2">
                <button onClick={onClose} className="h-9 px-4 rounded-md border border-border bg-card text-sm font-medium hover:bg-surface-muted transition-colors text-foreground">
                  Cancel
                </button>
                <button
                  onClick={handleConfirm}
                  disabled={(selectedSuggestion === null && !manualOverride) || reassignMutation.isPending}
                  className={cn(
                    "h-9 px-4 rounded-md text-sm font-medium transition-all inline-flex items-center gap-2",
                    selectedSuggestion !== null || manualOverride
                      ? "bg-primary text-primary-foreground hover:opacity-95"
                      : "bg-primary/30 text-primary-foreground/60 cursor-not-allowed"
                  )}
                >
                  {reassignMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
                  Confirm Reassignment
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ══════════════════════════════════════════════════════════════
   Reallocate Modal
   ══════════════════════════════════════════════════════════════ */
function ReallocateModal({ task, isBulk, bulkCount, onClose }: { task: Task; isBulk: boolean; bulkCount: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [targetDept, setTargetDept] = useState("");
  const [targetEmployeeId, setTargetEmployeeId] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const { data: employeesResp } = useQuery({
    queryKey: ["employees", targetDept],
    queryFn: () => coreApi.getEmployees({ department: targetDept }),
    enabled: !!targetDept,
  });
  const targetEmployees = employeesResp?.data ?? [];

  const { data: workloadResp } = useQuery({
    queryKey: ["employee-workload"],
    queryFn: () => coreApi.getEmployeeWorkload(),
  });
  const workload = workloadResp?.data ?? [];
  const moved = isBulk ? bulkCount : 1;
  const avgOpen = (dept: string) => {
    const rows = workload.filter((w: any) => w.department === dept);
    return rows.length ? rows.reduce((s: number, r: any) => s + r.openTaskCount, 0) / rows.length : 0;
  };
  const sourceAvgBefore = avgOpen(task.department);
  const sourceRows = workload.filter((w: any) => w.department === task.department);
  const sourceAvgAfter = sourceRows.length ? Math.max(0, (sourceRows.reduce((s: number, r: any) => s + r.openTaskCount, 0) - moved) / sourceRows.length) : 0;
  const targetRows = workload.filter((w: any) => w.department === targetDept);
  const targetAvgBefore = avgOpen(targetDept);
  const targetAvgAfter = targetRows.length
    ? (targetRows.reduce((s: number, r: any) => s + r.openTaskCount, 0) + moved) / targetRows.length
    : moved;
  const impactPct = targetAvgBefore > 0 ? Math.round(((targetAvgAfter - targetAvgBefore) / targetAvgBefore) * 100) : 100;
  const CAP = 12; // open-task count treated as "full load" for the bar visualization
  const barWidth = (avg: number) => Math.min(100, Math.round((avg / CAP) * 100));

  const reallocateMutation = useMutation({
    mutationFn: () => coreApi.reallocateTask(task.id, { employeeId: targetEmployeeId, reason: "ChargeHandover", note: reason || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      setConfirmed(true);
      setTimeout(onClose, 1200);
    },
  });

  const handleConfirm = () => {
    if (!targetEmployeeId) return;
    reallocateMutation.mutate();
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 animate-in fade-in duration-200" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-4 duration-300 max-h-[90vh] overflow-y-auto scrollbar-thin" onClick={e => e.stopPropagation()}>
          
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="flex items-center gap-2">
              <div className="size-8 rounded-lg bg-chart-1/10 flex items-center justify-center">
                <ArrowLeftRight className="size-4 text-chart-1" />
              </div>
              <div>
                <h2 className="font-semibold text-foreground">{isBulk ? `Bulk Reallocate (${bulkCount} tasks)` : "Reallocate to Department"}</h2>
                {!isBulk && <p className="text-xs text-muted-foreground">{task.id} · {task.title}</p>}
              </div>
            </div>
            <button onClick={onClose} className="p-1 rounded-md hover:bg-surface-muted transition-colors"><X className="size-5 text-muted-foreground" /></button>
          </div>

          {confirmed ? (
            <div className="p-8 text-center">
              <div className="size-12 rounded-full bg-surface-muted flex items-center justify-center mx-auto mb-3">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
              </div>
              <p className="font-semibold text-foreground">Reallocation Confirmed</p>
              <p className="text-xs text-muted-foreground mt-1">Task moved to {targetDept}. Resource load updated.</p>
            </div>
          ) : (
            <div className="p-5 space-y-5">
              {/* Current Department */}
              <div className="bg-surface rounded-lg p-3 border border-border">
                <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Current Department</div>
                <div className="flex items-center gap-2">
                  <Pill tone="primary">{task.department}</Pill>
                  <span className="text-xs text-muted-foreground">•</span>
                  <span className="text-xs text-muted-foreground">{task.employeeName}</span>
                </div>
              </div>

              {/* Target Department */}
              <div>
                <div className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Target Department</div>
                <select
                  value={targetDept}
                  onChange={(e) => setTargetDept(e.target.value)}
                  className="w-full h-9 px-3 rounded-md bg-card border border-border text-sm focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                >
                  <option value="">Select department…</option>
                  {DEPARTMENTS.filter(d => d !== "All Departments" && d !== task.department).map(d => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>

              {/* Target Employee */}
              {targetDept && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Target Officer</div>
                  <select
                    value={targetEmployeeId}
                    onChange={(e) => setTargetEmployeeId(e.target.value)}
                    className="w-full h-9 px-3 rounded-md bg-card border border-border text-sm focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                  >
                    <option value="">Select an officer…</option>
                    {targetEmployees.map((e: any) => <option key={e.id} value={e.id}>{e.name} · {e.designation}</option>)}
                  </select>
                </div>
              )}

              {/* Resource Impact Preview */}
              {targetDept && (
                <div className="bg-warning/5 border border-warning/20 rounded-lg p-3">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <AlertTriangle className="size-3.5 text-warning-foreground" />
                    <span className="text-[11px] uppercase tracking-wider font-bold text-warning-foreground">Resource Impact Preview</span>
                  </div>
                  <p className="text-sm text-foreground">
                    This will increase <span className="font-semibold">{targetDept}</span> task load by <span className="font-bold text-warning-foreground">{impactPct}%</span>
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <div className="text-muted-foreground mb-1">{task.department} (source)</div>
                      <div className="h-1.5 w-full bg-surface-muted rounded-full overflow-hidden">
                        <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${barWidth(sourceAvgAfter)}%` }} />
                      </div>
                      <div className="text-[10px] tabular-nums text-foreground mt-0.5">avg {sourceAvgBefore.toFixed(1)} → {sourceAvgAfter.toFixed(1)} open tasks/officer</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-1">{targetDept} (target)</div>
                      <div className="h-1.5 w-full bg-surface-muted rounded-full overflow-hidden">
                        <div className="h-full bg-warning rounded-full transition-all" style={{ width: `${barWidth(targetAvgAfter)}%` }} />
                      </div>
                      <div className="text-[10px] tabular-nums text-foreground mt-0.5">avg {targetAvgBefore.toFixed(1)} → {targetAvgAfter.toFixed(1)} open tasks/officer</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Reason */}
              <div>
                <div className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Reason for Reallocation</div>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder="Describe why this task is being reallocated…"
                  className="w-full px-3 py-2 rounded-md bg-card border border-border text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-none text-foreground placeholder:text-muted-foreground"
                />
              </div>

              {reallocateMutation.isError && (
                <div className="text-xs text-destructive">
                  {reallocateMutation.error instanceof ApiError ? reallocateMutation.error.message : "Failed to reallocate task."}
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 pt-2">
                <button onClick={onClose} className="h-9 px-4 rounded-md border border-border bg-card text-sm font-medium hover:bg-surface-muted transition-colors text-foreground">
                  Cancel
                </button>
                <button
                  onClick={handleConfirm}
                  disabled={!targetEmployeeId || reallocateMutation.isPending}
                  className={cn(
                    "h-9 px-4 rounded-md text-sm font-medium transition-all inline-flex items-center gap-2",
                    targetEmployeeId
                      ? "bg-primary text-primary-foreground hover:opacity-95"
                      : "bg-primary/30 text-primary-foreground/60 cursor-not-allowed"
                  )}
                >
                  {reallocateMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
                  Confirm Reallocation
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ══════════════════════════════════════════════════════════════
   Project Grouped View
   ══════════════════════════════════════════════════════════════ */
// Project list is a lightweight name+count rollup (GET /tasks/projects) —
// the full task rows for a project only fetch once that project is actually
// expanded, instead of shipping every project's every task up front just to
// render a collapsed list of project names.
function ProjectGroupedView({ department, zone, status, search }: {
  department?: string; zone?: string; status: string; search?: string;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: projectsResp, isLoading: projectsLoading, isError: projectsError } = useQuery({
    queryKey: ["task-projects", department, zone, status, search],
    queryFn: () => coreApi.getTaskProjects({ department, zone, status, q: search }),
  });
  const groups = projectsResp?.data ?? [];

  const { data: expandedResp, isLoading: expandedLoading } = useQuery({
    queryKey: ["tasks", department, zone, status, "project", expanded],
    queryFn: () => coreApi.getTasks({ department, zone, status, project: expanded! }),
    enabled: !!expanded,
  });
  const expandedTasks: (Task & { milestone?: string | null; eta?: string | null })[] = expandedResp?.data ?? [];

  if (projectsLoading) {
    return <Panel className="p-8 text-center text-sm text-muted-foreground">Loading projects…</Panel>;
  }
  if (projectsError) {
    return <Panel className="p-8 text-center text-sm text-destructive">Couldn't load projects. Is the AWIP core server running?</Panel>;
  }
  if (groups.length === 0) {
    return <Panel className="p-8 text-center text-sm text-muted-foreground">No tasks found for this scope.</Panel>;
  }

  return (
    <div className="space-y-2">
      {groups.map((g) => (
        <Panel key={g.project} padded={false} className="overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-muted/40 text-left"
            onClick={() => setExpanded(expanded === g.project ? null : g.project)}
          >
            <div className="min-w-0">
              <div className="font-medium text-sm truncate">{g.project}</div>
            </div>
            <div className="flex items-center gap-3 shrink-0 ml-3">
              <span className="text-xs text-muted-foreground">{g.completed}/{g.total} completed</span>
              <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", expanded === g.project && "rotate-90")} />
            </div>
          </button>
          {expanded === g.project && (
            <div className="border-t border-border divide-y divide-border">
              {expandedLoading ? (
                <div className="px-4 py-4 text-center text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Loading tasks…</span>
                </div>
              ) : (
                expandedTasks.map((t) => (
                  <div key={t.id} className="px-4 py-2.5 flex items-center justify-between text-xs">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{t.title}</div>
                      <div className="text-[10.5px] text-muted-foreground mt-0.5">
                        {t.id} · {t.employeeName} {t.milestone ? `· Milestone: ${t.milestone}` : ""} {t.eta ? `· ETA ${t.eta}` : ""}
                      </div>
                    </div>
                    <Pill tone={t.status === "Completed" ? "success" : t.slaStatus === "Breached" ? "destructive" : "primary"}>{t.status}</Pill>
                  </div>
                ))
              )}
            </div>
          )}
        </Panel>
      ))}
    </div>
  );
}

function KpiCard({ label, value, tone = "primary" }: { label: string; value: string | number; tone?: "primary" | "success" | "warning" | "destructive" }) {
  const tones = {
    primary: "text-foreground",
    success: "text-success",
    warning: "text-warning-foreground",
    destructive: "text-destructive",
  };
  return (
    <div className="bg-card border border-border p-3 rounded-md flex flex-col justify-center shadow-sm">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
      <div className={cn("text-2xl font-bold tabular-nums", tones[tone])}>{value}</div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Task Efficiency Trend — 6-month completion rate / avg TAT
   ══════════════════════════════════════════════════════════════ */
type TrendSeries = { label: string; department: string; zone: string; data: { month: string; completionRatePct: number; avgTatDays: number }[] };

const TREND_SERIES_COLORS = ["var(--color-success)", "var(--color-primary)", "var(--color-destructive)", "var(--color-warning)"];

// Merges N per-combo series (each its own {month, completionRatePct} array)
// into one row-per-month dataset with one column per series, which is what
// recharts' single-`data`-array LineChart needs to draw multiple lines.
function buildComparisonChartData(series: TrendSeries[]) {
  const months = [...new Set(series.flatMap((s) => s.data.map((d) => d.month)))].sort();
  return months.map((month) => {
    const row: Record<string, string | number> = { month };
    series.forEach((s, i) => {
      row[`s${i}`] = s.data.find((d) => d.month === month)?.completionRatePct ?? 0;
    });
    return row;
  });
}

function TaskTrendPanel({ data, series, isLoading }: {
  data: { month: string; completionRatePct: number; avgTatDays: number }[];
  series: TrendSeries[];
  isLoading: boolean;
}) {
  // Comparing the fully org-wide aggregate flattens ~168 real department/zone
  // combinations into a near-constant band that reads as "fake" — when the
  // backend returns real best/weakest combos as separate series, plot those
  // instead of the single flat aggregate line.
  const showComparison = series.length > 0;
  const comparisonData = showComparison ? buildComparisonChartData(series) : [];

  return (
    <Panel className="p-4 h-full border-2 border-primary/40">
      <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
        Task Efficiency Trend · Last 6 Months{showComparison && " · Best vs. Weakest Zones"}
      </h3>
      <div className="h-[200px]">
        {isLoading ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground gap-2"><Loader2 className="size-3.5 animate-spin" /> Loading trend…</div>
        ) : showComparison ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={comparisonData} margin={{ top: 6, right: 12, left: -14, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="month" tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} tickLine={false} axisLine={false} width={30} domain={['dataMin - 5', 'dataMax + 5']} />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(value: number) => `${value}%`} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              {series.map((s, i) => (
                <Line
                  key={s.label} type="monotone" dataKey={`s${i}`} name={s.label}
                  stroke={TREND_SERIES_COLORS[i % TREND_SERIES_COLORS.length]} strokeWidth={2} dot={{ r: 3 }} {...CHART_ANIMATION}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : data.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">No trend data available yet.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 6, right: 12, left: -14, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="month" tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} tickLine={false} axisLine={false} />
              <YAxis yAxisId="left" tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} tickLine={false} axisLine={false} width={30} domain={['dataMin - 5', 'dataMax + 5']} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} tickLine={false} axisLine={false} width={30} />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line yAxisId="left" type="monotone" dataKey="completionRatePct" name="Completion Rate %" stroke="var(--color-primary)" strokeWidth={2} dot={{ r: 3 }} {...CHART_ANIMATION} />
              <Line yAxisId="right" type="monotone" dataKey="avgTatDays" name="Avg TAT (days)" stroke="var(--color-chart-2)" strokeWidth={2} dot={{ r: 3 }} {...CHART_ANIMATION} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </Panel>
  );
}

/* ══════════════════════════════════════════════════════════════
   AI Productivity Insight Card
   ══════════════════════════════════════════════════════════════ */
function ProductivityInsightCard({ onDiscuss }: { onDiscuss: (v: boolean) => void }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["task-productivity-insight"],
    queryFn: () => coreApi.getTaskProductivityInsight(),
    staleTime: 5 * 60 * 1000,
  });

  const handleDiscuss = () => {
    if (!data) return;
    onDiscuss(true);
    seedAssistantMessage(
      `Productivity insight — ${data.narrative}\n\nRecommended action: ${data.recommendedAction}`,
    );
  };

  return (
    <Panel className="p-4 flex flex-col border-2 border-primary/40">
      <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
        <Sparkles className="size-3.5 text-primary" /> AI Productivity Suggestion
      </h3>
      {isLoading ? (
        <div className="flex-1 space-y-2 animate-pulse">
          <div className="h-3 bg-surface-muted rounded w-5/6" />
          <div className="h-3 bg-surface-muted rounded w-full" />
          <div className="h-3 bg-surface-muted rounded w-4/6" />
          <div className="text-[11px] text-muted-foreground pt-1 inline-flex items-center gap-1.5"><Loader2 className="size-3 animate-spin" /> Heera is analyzing recent task data…</div>
        </div>
      ) : isError || !data ? (
        <div className="flex-1 text-xs text-muted-foreground">Productivity insight is unavailable right now — is server-ai running with Ollama?</div>
      ) : (
        <>
          <p className="text-xs text-foreground/90 leading-relaxed flex-1">{data.narrative}</p>
          <div className="mt-2 text-[11px] bg-primary/5 text-primary rounded-md px-2.5 py-2 leading-relaxed">
            <span className="font-semibold">Recommended:</span> {data.recommendedAction}
          </div>
          <button
            onClick={handleDiscuss}
            className="mt-3 h-8 px-3 inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors self-start"
          >
            <MessageCircleMore className="size-3.5" /> Discuss with Heera
          </button>
        </>
      )}
    </Panel>
  );
}

/* ══════════════════════════════════════════════════════════════
   Task Detail Overlay — clicking a task row
   ══════════════════════════════════════════════════════════════ */
function TaskDetailOverlay({ taskId, onClose, onRequestDelete }: { taskId: string; onClose: () => void; onRequestDelete: (task: Task) => void }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["task-detail", taskId],
    queryFn: () => coreApi.getTaskDetail(taskId),
  });

  return (
    <>
      <div className="fixed inset-0 z-45 backdrop-blur-sm bg-black/10" onClick={onClose} />
      <motion.div
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className="fixed right-0 top-0 bottom-0 z-50 w-full sm:w-[440px] bg-card shadow-[-8px_0_24px_rgba(0,93,94,0.08)] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">Task Detail</h2>
          <div className="flex items-center gap-1">
            {data?.task && (
              <button
                onClick={() => onRequestDelete(data.task)}
                title="Delete Task"
                className="size-8 rounded-md grid place-items-center hover:bg-destructive/10 text-destructive transition-colors"
              >
                <Trash2 className="size-4" />
              </button>
            )}
            <button onClick={onClose} className="size-8 rounded-md grid place-items-center hover:bg-surface-muted transition-colors">
              <X className="size-4 text-muted-foreground" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5 scrollbar-thin">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground py-10">
              <Loader2 className="size-4 animate-spin" /> Loading task detail…
            </div>
          ) : isError || !data ? (
            <div className="text-xs text-destructive text-center py-10">Couldn't load task detail.</div>
          ) : (
            <>
              {/* Task info */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <Pill tone={data.task.status === "Completed" ? "success" : data.task.slaStatus === "Breached" ? "destructive" : "primary"}>{data.task.status}</Pill>
                  <Pill tone={(data.task.effectivePriority ?? data.task.priority) === "High" ? "destructive" : (data.task.effectivePriority ?? data.task.priority) === "Medium" ? "warning" : "primary"}>
                    {data.task.effectivePriority ?? data.task.priority} Priority
                  </Pill>
                </div>
                <h3 className="text-base font-semibold text-foreground">{data.task.title}</h3>
                <p className="text-xs text-muted-foreground">{data.task.id} · {data.task.project} · {data.task.category}</p>
                {data.task.aiSummary && (
                  <p className="text-xs text-foreground/80 border-l-2 border-primary/40 pl-2 leading-relaxed">{data.task.aiSummary}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs bg-surface rounded-lg p-3 border border-border">
                <Meta label="Department" value={data.task.department} />
                <Meta label="TAT" value={`${data.task.tatDays} days`} />
                <Meta label="Due In" value={data.task.dueIn < 0 ? `Overdue ${-data.task.dueIn}d` : data.task.dueIn === 0 ? "Today" : `${data.task.dueIn}d`} />
                <Meta label="SLA Status" value={data.task.slaStatus} />
                {data.task.sow && <Meta label="Scope of Work" value={data.task.sow} />}
                {data.task.milestone && <Meta label="Milestone" value={data.task.milestone} />}
                {data.task.eta && <Meta label="ETA" value={data.task.eta} />}
                {data.task.createdAt && <Meta label="Created" value={new Date(data.task.createdAt).toLocaleDateString("en-IN")} />}
                {data.task.completedAt && <Meta label="Completed" value={new Date(data.task.completedAt).toLocaleDateString("en-IN")} />}
              </div>

              {/* Assignee card */}
              <div>
                <div className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Assignee</div>
                <Link
                  to="/employees/$id"
                  params={{ id: data.assignee.id }}
                  className="flex items-center gap-3 bg-surface rounded-lg p-3 border border-border hover:border-primary/40 hover:bg-surface-muted transition-colors group"
                >
                  <div className="size-9 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                    {data.assignee.name.split(" ").map((n) => n[0]).slice(0, 2).join("")}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm text-foreground truncate group-hover:text-primary transition-colors">{data.assignee.name}</div>
                    <div className="text-[11px] text-muted-foreground truncate">{data.assignee.designation} · {data.assignee.cadre}</div>
                    <div className="text-[10px] text-muted-foreground">{data.assignee.department} · {data.assignee.zone}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <Pill tone={data.assignee.status === "Active" ? "success" : data.assignee.status === "On Leave" ? "warning" : "neutral"}>{data.assignee.status}</Pill>
                    <ArrowUpRight className="size-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
                  </div>
                </Link>
              </div>

              {/* Manager chain */}
              {data.managerChain.length > 0 && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Reporting Line (Root → Manager)</div>
                  <div className="border-l-2 border-dashed border-border ml-2 space-y-2">
                    {data.managerChain.map((m) => (
                      <div key={m.id} className="pl-3 -ml-px flex items-center gap-2 text-xs">
                        <span className="size-1.5 rounded-full bg-primary/50 -ml-[19px]" />
                        <span className="font-medium text-foreground">{m.name}</span>
                        <span className="text-muted-foreground">· {m.designation} · {m.cadre}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Direct reports */}
              {data.directReports.length > 0 && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Direct Reports ({data.directReports.length})</div>
                  <div className="space-y-1.5">
                    {data.directReports.map((r) => (
                      <div key={r.id} className="flex items-center gap-2 text-xs bg-surface rounded-md px-2.5 py-1.5 border border-border">
                        <span className="font-medium text-foreground">{r.name}</span>
                        <span className="text-muted-foreground">· {r.designation} · {r.cadre}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Task summary */}
              <div>
                <div className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Assignee's Task Load</div>
                <div className="grid grid-cols-4 gap-2 text-center">
                  <TaskSummaryStat label="Total" value={data.taskSummary.total} />
                  <TaskSummaryStat label="Open" value={data.taskSummary.open} />
                  <TaskSummaryStat label="Completed" value={data.taskSummary.completed} tone="success" />
                  <TaskSummaryStat label="Overdue" value={data.taskSummary.overdue} tone="destructive" />
                </div>
              </div>

              <Link
                to="/employees/$id"
                params={{ id: data.assignee.id }}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
              >
                Open full Employee 360 profile <ArrowUpRight className="size-3.5" />
              </Link>
            </>
          )}
        </div>
      </motion.div>
    </>
  );
}

function Meta({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-foreground font-medium truncate">{value}</div>
    </div>
  );
}

function TaskSummaryStat({ label, value, tone = "primary" }: { label: string; value: number; tone?: "primary" | "success" | "destructive" }) {
  const tones = { primary: "text-foreground", success: "text-success", destructive: "text-destructive" };
  return (
    <div className="bg-surface rounded-md p-2 border border-border">
      <div className={cn("text-lg font-bold tabular-nums", tones[tone])}>{value}</div>
      <div className="text-[9.5px] uppercase tracking-wider text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
