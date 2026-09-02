import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Building2, Users, Wallet, Briefcase, TrendingUp, GraduationCap,
  ShieldCheck, Package, MessageSquareWarning, Folder, ArrowLeft,
  Sparkles, CheckCircle2, X, ChevronLeft, ChevronRight,
  Activity, Database, ClipboardCheck, ArrowRight, Star, Network,
  ArrowUpRight, ArrowDownRight, Clock, Landmark, HeartPulse, HardHat,
  Droplets, Flame, MapPinned, Coins, Home, Trees, Laptop, Scale,
  BookOpen, PawPrint, BookMarked, Trophy, Boxes,
} from "lucide-react";
import { Panel, Pill, Section } from "@/components/layout/section";
import { FilterPill } from "@/components/ui/filter-pill";
import { SearchPill } from "@/components/ui/search-pill";
import { useUI } from "@/context/ui-context";
import { useDepartment } from "@/context/department-context";
import type { Department } from "@/lib/departments";
import { coreApi } from "@/lib/api-client";
import { OrgTreeList } from "@/components/employees/organogram";
import { cn, formatDate } from "@/lib/utils";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid, PieChart, Pie, Cell
} from "recharts";
import { CHART_TOOLTIP_STYLE, CHART_ANIMATION } from "@/lib/chart-theme";

type Org360Search = { department?: string; module?: string };

export const Route = createFileRoute("/org360")({
  head: () => ({
    meta: [
      { title: "Organization 360 · AWIP" },
      { name: "description", content: "Department-level digital twin and organization 360 dashboard." },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): Org360Search => ({
    department: typeof search.department === "string" ? search.department : undefined,
    module: typeof search.module === "string" ? search.module : undefined,
  }),
  component: Org360Page,
});

const ORG_MODULES = [
  { key: "overview", label: "Overview", icon: Activity, tone: "primary" as const },
  { key: "workforce", label: "Workforce", icon: Users, tone: "success" as const },
  { key: "finance", label: "Budget & Finance", icon: Wallet, tone: "warning" as const },
  { key: "vacancies", label: "Vacancies", icon: Briefcase, tone: "warning" as const },
  { key: "performance", label: "Performance", icon: TrendingUp, tone: "info" as const },
  { key: "training", label: "Training", icon: GraduationCap, tone: "info" as const },
  { key: "compliance", label: "Compliance", icon: ShieldCheck, tone: "success" as const },
  { key: "assets", label: "Assets & Logistics", icon: Package, tone: "primary" as const },
  { key: "grievances", label: "Grievances", icon: MessageSquareWarning, tone: "destructive" as const },
  { key: "projects", label: "Projects & Dev", icon: Folder, tone: "success" as const },
  { key: "orgchart", label: "Reporting Structure", icon: Network, tone: "primary" as const },
] as const;

type OrgModuleKey = (typeof ORG_MODULES)[number]["key"];

// Department-name → icon, matched by substring so seed variations
// ("Commissioner Office" vs "Commissioner's Office") still resolve; falls
// back to the generic Building2 badge for anything unmatched.
const DEPT_ICON_MAP: [string, typeof Building2][] = [
  ["commissioner", Landmark],
  ["administration", Landmark],
  ["health", HeartPulse],
  ["engineering", HardHat],
  ["water", Droplets],
  ["drainage", Droplets],
  ["solid waste", Trees],
  ["fire", Flame],
  ["town planning", MapPinned],
  ["estate", Home],
  ["revenue", Coins],
  ["urban community", Users],
  ["housing", Home],
  ["garden", Trees],
  ["information technology", Laptop],
  ["accounts", Coins],
  ["finance", Coins],
  ["legal", Scale],
  ["education", BookOpen],
  ["zoo", PawPrint],
  ["library", BookMarked],
  ["sports", Trophy],
  ["disaster", ShieldCheck],
  ["procurement", Boxes],
  ["grievance", MessageSquareWarning],
];

function deptIcon(name: string) {
  const lower = name.toLowerCase();
  return DEPT_ICON_MAP.find(([key]) => lower.includes(key))?.[1] ?? Building2;
}

function Org360Page() {
  const { department: deepLinkDepartment, module: deepLinkModule } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [selectedDept, setSelectedDept] = useState<string | null>(null);
  const [activeModule, setActiveModule] = useState<OrgModuleKey | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const { lang } = useUI();
  // Guards the deep-link auto-select so it only ever applies once per visit
  // — otherwise clicking "back" (which clears selectedDept) would just
  // re-select the same department again as long as the URL param persists.
  const appliedDeepLink = useRef(false);

  const { data: departmentsResp } = useQuery({
    queryKey: ["departments"],
    queryFn: () => coreApi.getDepartments(),
  });

  const { data: profilesResp } = useQuery({
    queryKey: ["dept-profiles"],
    queryFn: () => coreApi.getDepartmentProfiles(),
  });

  const selectedDeptId = useMemo(() => {
    if (!selectedDept || !departmentsResp?.data) return null;
    const match = departmentsResp.data.find((d: any) => d.name === selectedDept);
    return match?.id ?? null;
  }, [selectedDept, departmentsResp]);

  // Real per-department profile — head/budget/audit facts plus live counts
  // (SLA%, vacancies, grievances, health score) computed from actual rows.
  const departmentsList = useMemo(() => {
    return (profilesResp?.data ?? []).map((d: any) => ({
      ...d,
      name: d.department,
      head: d.headName,
      budget: d.budgetCr,
      health: d.healthScore,
      narrative: `${d.employeeCount.toLocaleString("en-IN")} employees · SLA compliance ${d.slaPct}% · ${d.vacancyCount} open vacancies · ${d.pendingGrievances} pending grievance(s) · budget variance ${d.budgetVariancePct >= 0 ? "+" : ""}${d.budgetVariancePct}%.`,
    }));
  }, [profilesResp]);

  // Deep-link support (e.g. an AI Agent's "Guided Help"/related-module link
  // pointing at the specific department its findings flagged) — auto-select
  // once the real department list has loaded and the name matches.
  useEffect(() => {
    if (!deepLinkDepartment || appliedDeepLink.current) return;
    if (departmentsList.some((d: any) => d.name === deepLinkDepartment)) {
      setSelectedDept(deepLinkDepartment);
      // Open the module the link actually pointed at (e.g. an AI Agent's
      // "workforce" or "training" finding) instead of landing on the bare
      // department picker with no module open — previously `module` was
      // silently ignored, so every agent's "View department X" action
      // deep-linked the right department but always the wrong (no) module.
      if (deepLinkModule && ORG_MODULES.some((m) => m.key === deepLinkModule)) {
        setActiveModule(deepLinkModule as OrgModuleKey);
      }
      appliedDeepLink.current = true;
    }
  }, [deepLinkDepartment, deepLinkModule, departmentsList]);

  const filteredDepts = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return departmentsList;
    return departmentsList.filter((d: any) => d.name.toLowerCase().includes(q) || d.head.toLowerCase().includes(q));
  }, [departmentsList, searchQuery]);

  const activeDeptData = useMemo(() => {
    if (!selectedDept) return null;
    return departmentsList.find((d: any) => d.name === selectedDept) || null;
  }, [selectedDept, departmentsList]);

  if (!selectedDept || !activeDeptData) {
    return (
      <div className="min-h-full bg-gradient-to-br from-background via-background to-primary-soft/40 p-5 max-w-[1600px] mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
              <Building2 className="size-5 text-primary" />
              {lang === "gu" ? "સંસ્થા 360" : "Organization 360"}
            </h1>
            <p className="text-xs text-muted-foreground">
              {lang === "gu" ? "વિભાગીય ડિજિટલ ટ્વીન અને સંસ્થાકીય કામગીરી" : "Department-level digital twin and organizational posture overview"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <SearchPill value={searchQuery} onChange={setSearchQuery} placeholder="Search department, officer..." size="compact" className="w-64" />
          </div>
        </div>

        {/* Department cards grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredDepts.map((d) => {
            const DeptIcon = deptIcon(d.name);
            const tone = d.health >= 85 ? "success" : d.health >= 70 ? "warning" : "destructive";
            return (
              <div
                key={d.name}
                onClick={() => setSelectedDept(d.name)}
                className="bg-card rounded-xl border border-border shadow-sm transition-all duration-300 ease-out hover:-translate-y-1 hover:shadow-md cursor-pointer group overflow-hidden flex flex-col"
              >
                <span className={cn("h-1 shrink-0", tone === "success" ? "bg-success" : tone === "warning" ? "bg-warning" : "bg-destructive")} />
                <div className="p-4 flex flex-col gap-3 flex-1">
                  <div className="flex items-center gap-3">
                    <div className="size-9 rounded-full bg-primary/10 text-primary grid place-items-center shrink-0 group-hover:bg-primary group-hover:text-primary-foreground transition-all duration-300">
                      <DeptIcon className="size-4.5" />
                    </div>
                    <div className="min-w-0">
                      <h2 className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors truncate">{d.name}</h2>
                      <p className="text-[11px] text-muted-foreground truncate">{d.head}</p>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Posture Index</span>
                      <span className="text-xs font-bold tabular-nums">{d.health}/100</span>
                    </div>
                    <div className="h-1.5 w-full bg-surface-muted rounded-full overflow-hidden">
                      <div
                        className={cn("h-full rounded-full", tone === "success" ? "bg-success" : tone === "warning" ? "bg-warning" : "bg-destructive")}
                        style={{ width: `${d.health}%` }}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 border-t border-border pt-3">
                    <div>
                      <div className="flex items-center gap-1 text-[10px] text-muted-foreground"><Users className="size-3" /> Employees</div>
                      <div className="text-xs font-bold text-foreground tabular-nums mt-1">{d.employeeCount.toLocaleString("en-IN")}</div>
                    </div>
                    <div>
                      <div className="flex items-center gap-1 text-[10px] text-muted-foreground"><Wallet className="size-3" /> Budget (FY)</div>
                      <div className="text-xs font-bold text-foreground tabular-nums mt-1">₹{d.budget} Cr</div>
                      {d.budgetVariancePct != null && (
                        <div className={cn("text-[9px] font-medium flex items-center gap-0.5 mt-0.5", d.budgetVariancePct >= 0 ? "text-destructive" : "text-success")}>
                          {d.budgetVariancePct >= 0 ? <ArrowUpRight className="size-2.5" /> : <ArrowDownRight className="size-2.5" />}
                          {Math.abs(d.budgetVariancePct)}%
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-1 text-[10px] text-muted-foreground"><Briefcase className="size-3" /> Openings</div>
                      <div className="text-xs font-bold text-warning-foreground tabular-nums mt-1">{d.vacancyCount}</div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-[11px] border-t border-border pt-3">
                    <span className="text-muted-foreground">SLA: <span className="font-bold text-foreground">{d.slaPct}%</span></span>
                    {d.pendingGrievances > 0 && (
                      <span className="flex items-center gap-1 text-destructive font-medium">
                        <Clock className="size-3" /> {d.pendingGrievances} Pending Grievance{d.pendingGrievances > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>

                <div className="border-t border-border px-4 py-2.5 text-center">
                  <span className="text-xs font-medium text-primary inline-flex items-center gap-1 group-hover:gap-1.5 transition-all">
                    View Digital Twin <ArrowRight className="size-3" />
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-gradient-to-br from-background via-background to-primary-soft/40 p-5 max-w-[1600px] mx-auto space-y-4">
      {/* Header with back navigation */}
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setSelectedDept(null); if (deepLinkDepartment) navigate({ search: {} }); }}
            className="size-9 rounded-full border border-border bg-card flex items-center justify-center hover:bg-surface-muted transition-colors text-foreground"
          >
            <ArrowLeft className="size-4" />
          </button>
          <div>
            <div className="text-[10px] uppercase font-bold tracking-widest text-primary flex items-center gap-1.5">
              <Building2 className="size-3" /> Department Digital Twin · Live
            </div>
            <h1 className="text-lg font-bold text-foreground mt-0.5">{activeDeptData.name}</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Pill tone={activeDeptData.health >= 85 ? "success" : activeDeptData.health >= 70 ? "warning" : "destructive"}>
            Health Score: {activeDeptData.health}/100
          </Pill>
        </div>
      </div>

      {/* Main dashboard twin workspace */}
      <div className="grid gap-4 lg:grid-cols-[1fr_360px] items-start">
        {/* Radial workspace left */}
        <div className="bg-card border border-border rounded-xl p-6 flex flex-col items-center justify-center min-h-[560px] relative overflow-hidden">
          {/* Subtle grid background */}
          <div className="absolute inset-0 opacity-[0.02]" style={{ backgroundImage: "radial-gradient(circle, var(--color-foreground) 1px, transparent 1px)", backgroundSize: "24px 24px" }} />

          <div className="relative w-[440px] h-[440px] max-w-full flex items-center justify-center shrink-0">
            {/* Connection SVG lines */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none z-0">
              {ORG_MODULES.map((m, idx) => {
                const angle = (idx * 360) / ORG_MODULES.length - 90;
                const rad = (angle * Math.PI) / 180;
                const x = 220 + 155 * Math.cos(rad);
                const y = 220 + 155 * Math.sin(rad);
                const isActive = activeModule === m.key;
                return (
                  <line
                    key={m.key}
                    x1="220"
                    y1="220"
                    x2={x}
                    y2={y}
                    stroke={isActive ? "var(--color-primary)" : "var(--color-border)"}
                    strokeWidth={isActive ? 2 : 1}
                    strokeDasharray={isActive ? "none" : "3 3"}
                    className="transition-all duration-300"
                  />
                );
              })}
            </svg>

            {/* Central Badge */}
            <div className="size-24 rounded-full bg-card shadow-[0_4px_24px_rgba(0,93,94,0.08)] flex flex-col items-center justify-center z-10 text-center select-none">
              <Building2 className="size-7 text-primary mb-1 animate-pulse" />
              <div className="text-[9px] font-bold uppercase tracking-wider leading-none text-muted-foreground truncate w-full px-1">
                {activeDeptData.name.split(" ")[0]}
              </div>
            </div>

            {/* Radial Nodes */}
            {ORG_MODULES.map((m, idx) => {
              const angle = (idx * 360) / ORG_MODULES.length - 90;
              const rad = (angle * Math.PI) / 180;
              const x = 220 + 155 * Math.cos(rad);
              const y = 220 + 155 * Math.sin(rad);
              const isActive = activeModule === m.key;
              const Icon = m.icon;

              return (
                <button
                  key={m.key}
                  onClick={() => setActiveModule(m.key)}
                  style={{ left: `${(x / 440) * 100}%`, top: `${(y / 440) * 100}%` }}
                  className={cn(
                    "group absolute -translate-x-1/2 -translate-y-1/2 w-[92px] flex flex-col items-center gap-1 transition-all z-10 cursor-pointer",
                    isActive ? "scale-105" : "hover:scale-105"
                  )}
                >
                  <div className={cn(
                    "relative size-11 rounded-full grid place-items-center transition-all backdrop-blur-sm",
                    isActive
                      ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30 scale-105"
                      : "bg-card text-foreground/70 shadow-[0_4px_24px_rgba(0,93,94,0.08)] hover:bg-primary hover:text-primary-foreground hover:shadow-lg hover:shadow-primary/30"
                  )}>
                    <Icon className="size-4" />
                    {/* Decorative full ring — no longer tied to a score */}
                    <svg className="absolute inset-0 -rotate-90" viewBox="0 0 44 44">
                      <circle cx="22" cy="22" r="20" fill="none" stroke="currentColor" strokeWidth="1"
                        strokeDasharray="125 125" opacity={isActive ? 0.35 : 0.4} />
                    </svg>
                  </div>
                  <div className="text-[9px] font-bold leading-tight text-center text-foreground/90 group-hover:text-primary transition-colors truncate w-full">{m.label}</div>
                </button>
              );
            })}
          </div>

          {/* Status Grading Legend */}
          <div className="flex items-center gap-3.5 bg-card/90 backdrop-blur-sm border border-border rounded-lg px-2.5 py-1 text-[9px] text-muted-foreground z-20 mt-4 select-none">
            <span className="font-semibold text-foreground mr-1">Status Grading:</span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-success" /> Healthy</span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-warning" /> Caution / Pending</span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-destructive" /> Breach / SLA Risk</span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-primary" /> Active</span>
          </div>

          <div className="mt-2.5 text-center">
            <h3 className="text-xs font-semibold text-foreground">Interactive Department Cockpit</h3>
            <p className="text-[9px] text-muted-foreground mt-0.5">Click any node to open real-time system overlay dossiers.</p>
          </div>
        </div>

        {/* Info panel right */}
        <div className="flex flex-col gap-4">
          {/* Dept Info Card */}
          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground border-b border-border/60 pb-2">Department Dossier</h3>
            <div className="space-y-3.5">
              <div>
                <div className="text-[10px] text-muted-foreground uppercase">Officer In-Charge</div>
                <div className="text-sm font-semibold text-foreground mt-0.5">{activeDeptData.head}</div>
                <div className="text-[10px] text-muted-foreground">{activeDeptData.headTitle}</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase">Active Employees</div>
                  <div className="text-base font-bold text-foreground mt-0.5 tabular-nums">{activeDeptData.employeeCount.toLocaleString("en-IN")}</div>
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase">Annual Budget</div>
                  <div className="text-base font-bold text-foreground mt-0.5 tabular-nums">₹{activeDeptData.budget} Cr</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setActiveModule("vacancies")}
                  className="text-left rounded-lg -m-1 p-1 hover:bg-surface-muted/40 transition-colors"
                >
                  <div className="text-[10px] text-muted-foreground uppercase">Open Vacancies</div>
                  <div className="text-sm font-semibold text-warning-foreground mt-0.5 tabular-nums">
                    {activeDeptData.employeeCount ? ((activeDeptData.vacancyCount / activeDeptData.employeeCount) * 100).toFixed(1) : "0.0"}% ({activeDeptData.vacancyCount} open)
                  </div>
                </button>
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase">Audit Status</div>
                  <div className="text-sm font-semibold text-foreground mt-0.5">{activeDeptData.auditStatus}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Health Score Breakdown */}
          {activeDeptData.healthBreakdown && (
            <div className="bg-card border border-border rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between border-b border-border/60 pb-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Health Score Breakdown</h3>
                <span className="text-[10px] font-semibold text-muted-foreground">{activeDeptData.health}/100</span>
              </div>
              <div className="space-y-2.5">
                {activeDeptData.healthBreakdown.factors.map((f: any) => (
                  <div key={f.key} className="group relative">
                    <div className="flex items-baseline justify-between gap-2 mb-1">
                      <span className="text-[10.5px] font-semibold text-foreground">{f.label} <span className="text-muted-foreground font-normal">· {f.weightPct}% weight</span></span>
                      <span className="text-[10.5px] font-bold tabular-nums text-foreground">{f.contribution}/{f.maxPoints} pts</span>
                    </div>
                    <div className="h-1.5 w-full bg-surface-muted rounded-full overflow-hidden">
                      <div
                        className={cn("h-full transition-all", f.componentScore >= 85 ? "bg-success" : f.componentScore >= 65 ? "bg-warning" : "bg-destructive")}
                        style={{ width: `${f.componentScore}%` }}
                      />
                    </div>
                    <p className="text-[9.5px] text-muted-foreground mt-1">{f.rawLabel}</p>
                  </div>
                ))}
              </div>
              {activeDeptData.healthBreakdown.topImprovement && (
                <div className="flex gap-2 rounded-md bg-primary/10 px-3 py-2.5 mt-1">
                  <TrendingUp className="size-3.5 text-primary shrink-0 mt-0.5" />
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-primary">Biggest Improvement Lever</div>
                    <p className="text-[11px] text-foreground leading-snug mt-0.5">{activeDeptData.healthBreakdown.topImprovement.suggestion}</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* AI summary */}
          <div className="flex-1 flex flex-col bg-card border border-border rounded-xl p-5 gap-3 min-h-[120px]">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              <h3 className="text-xs font-semibold text-foreground">AI Intelligence Summary</h3>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {activeDeptData.narrative}
            </p>
          </div>
        </div>
      </div>

      {/* Sliding Module Content Overlay */}
      <OrgModuleOverlay
        deptName={activeDeptData.name}
        deptId={selectedDeptId}
        deptData={activeDeptData}
        active={activeModule}
        onClose={() => setActiveModule(null)}
        onNavigate={(dir) => {
          if (!activeModule) return;
          const idx = ORG_MODULES.findIndex(m => m.key === activeModule);
          if (idx < 0) return;
          const next = dir === "next"
            ? (idx + 1) % ORG_MODULES.length
            : (idx - 1 + ORG_MODULES.length) % ORG_MODULES.length;
          setActiveModule(ORG_MODULES[next].key);
        }}
      />
    </div>
  );
}

/* ─── Org Module Overlay Component ─── */
function OrgModuleOverlay({
  deptName, deptId, deptData, active, onClose, onNavigate
}: {
  deptName: string;
  deptId: string | null;
  deptData: any;
  active: OrgModuleKey | null;
  onClose: () => void;
  onNavigate: (dir: "prev" | "next") => void;
}) {
  const m = active ? ORG_MODULES.find(x => x.key === active) : null;
  const isOpen = !!active && !!m;

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px] transition-opacity duration-300",
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        )}
        onClick={onClose}
      />

      {/* Sliding Panel */}
      <div
        className={cn(
          "fixed top-0 right-0 bottom-0 z-50 w-full sm:w-[520px] bg-card border-l border-border shadow-2xl flex flex-col transition-transform duration-300 ease-in-out",
          isOpen ? "translate-x-0" : "translate-x-full"
        )}
      >
        {m && (
          <>
            {/* Header */}
            <div className="px-4 py-3 border-b border-border bg-gradient-to-r from-primary-soft/50 to-transparent flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="size-9 rounded-md bg-primary text-primary-foreground grid place-items-center shrink-0">
                  <m.icon className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground truncate">{m.label}</div>
                  <div className="text-[10px] text-muted-foreground truncate">{deptName}</div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => onNavigate("prev")}
                  className="size-8 grid place-items-center rounded-full hover:bg-surface-muted transition-colors text-foreground"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <button
                  onClick={() => onNavigate("next")}
                  className="size-8 grid place-items-center rounded-full hover:bg-surface-muted transition-colors text-foreground"
                >
                  <ChevronRight className="size-4" />
                </button>
                <button
                  onClick={onClose}
                  className="size-8 grid place-items-center rounded-full hover:bg-surface-muted transition-colors text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 p-5 overflow-y-auto scrollbar-thin space-y-4">
              <OrgModuleContent active={active} deptId={deptId} deptName={deptName} deptData={deptData} />
            </div>
          </>
        )}
      </div>
    </>
  );
}

/* ─── Reporting Structure (org-tree) Module ─── */
function OrgChartModule({ deptId }: { deptId: string | null }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["department-org-tree", deptId],
    queryFn: () => coreApi.getDepartmentOrgTree(deptId as string),
    enabled: !!deptId,
  });

  if (!deptId) {
    return <div className="p-6 text-center text-xs text-muted-foreground">No department mapping found for reporting structure.</div>;
  }
  if (isLoading) {
    return <div className="p-6 text-center text-xs text-muted-foreground">Loading reporting structure…</div>;
  }
  if (isError || !data) {
    return <div className="p-6 text-center text-xs text-destructive">Failed to load reporting structure.</div>;
  }
  return (
    <Section title="Department Reporting Structure">
      <div className="mt-2">
        <OrgTreeList trees={data.data || []} />
      </div>
    </Section>
  );
}

/* ─── Org Module Content Renderer ─── */
function WorkforceModule({ deptId, deptName }: { deptId: string | null; deptName: string }) {
  const navigate = useNavigate();
  const { setDepartment } = useDepartment();
  const { data, isLoading } = useQuery({
    queryKey: ["cadre-summary", deptId],
    queryFn: () => coreApi.getCadreSummary(deptId || undefined),
  });

  if (isLoading) return <div className="p-6 text-center text-xs text-muted-foreground">Loading workforce data...</div>;

  const rows = (data?.data ?? []) as { departmentId: string; cadre: string; count: number }[];
  const cadreOrder = ["Class I", "Class II", "Class III", "Class IV"];
  const byCadre = new Map<string, number>();
  for (const r of rows) byCadre.set(r.cadre, (byCadre.get(r.cadre) || 0) + r.count);
  const cadreData = cadreOrder.map((name) => ({ name, value: byCadre.get(name) || 0 }));
  const total = cadreData.reduce((s, c) => s + c.value, 0);

  // Drill through to the Employee 360 directory pre-filtered to this
  // department + cadre — department goes through the shared department
  // context (same mechanism the Command Centre's smart-alert links use),
  // cadre through a URL search param since it has no context slot.
  const goToFiltered = (cadreName: string) => {
    setDepartment(deptName as Department);
    navigate({ to: "/employees", search: { cadre: cadreName } });
  };

  return (
    <div className="space-y-4">
      <Section title={deptId ? "Workforce Composition by Cadre" : "Org-wide Workforce Composition by Cadre"}>
        <div className="h-[200px] w-full mt-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={cadreData}>
              <XAxis dataKey="name" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: 'var(--color-surface-muted)' }} />
              <Bar
                dataKey="value" fill="var(--color-primary)" radius={[4, 4, 0, 0]} cursor="pointer"
                onClick={(data: { name: string }) => goToFiltered(data.name)}
                {...CHART_ANIMATION}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Section>
      <div className="space-y-2 text-xs">
        {cadreData.map((c) => (
          <div
            key={c.name}
            onClick={() => goToFiltered(c.name)}
            className="flex justify-between border-b border-border pb-1 cursor-pointer hover:bg-surface-muted/40 rounded px-1 -mx-1 transition-colors"
          >
            <span className="text-muted-foreground">{c.name}</span>
            <span className="font-semibold text-foreground">{c.value.toLocaleString()}</span>
          </div>
        ))}
        <div className="flex justify-between pt-1">
          <span className="text-muted-foreground font-medium">Total</span>
          <span className="font-semibold text-foreground">{total.toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}

function FinanceModule({ deptId, deptName }: { deptId: string | null; deptName: string }) {
  const navigate = useNavigate();
  const { setDepartment } = useDepartment();
  const { data: trendResp, isLoading: trendLoading } = useQuery({
    queryKey: ["expenditure-trend", deptId],
    queryFn: () => coreApi.getExpenditureTrend({ department: deptId || undefined, months: 6 }),
  });
  const { data: varianceResp } = useQuery({
    queryKey: ["budget-variance", deptId],
    queryFn: () => coreApi.getBudgetVariance({ department: deptId || undefined }),
  });

  if (trendLoading) return <div className="p-6 text-center text-xs text-muted-foreground">Loading finance data...</div>;

  const trendRows = (trendResp?.data ?? []) as { month: string; category: string; amountSpent: number; allocatedBudget: number }[];
  const byMonth = new Map<string, number>();
  for (const r of trendRows) byMonth.set(r.month, (byMonth.get(r.month) || 0) + r.amountSpent);
  const spendData = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, amt]) => ({ name: name.slice(5), amt: Math.round(amt / 1e5) / 10 }));

  const varianceRows = (varianceResp?.data ?? []) as { department: string; allocated: number; spent: number; variancePct: number }[];
  const scoped = deptId ? varianceRows.filter((v) => v.department === deptId) : varianceRows;
  const overBudget = scoped.filter((v) => v.variancePct > 5).sort((a, b) => b.variancePct - a.variancePct).slice(0, 5);
  const underBudget = scoped.filter((v) => v.variancePct < -5).sort((a, b) => a.variancePct - b.variancePct).slice(0, 5);

  return (
    <div className="space-y-4">
      <Section title="Monthly Expenditure Trend (₹ Cr)">
        <div className="h-[200px] w-full mt-2">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={spendData}>
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
              <Line type="monotone" dataKey="amt" stroke="var(--color-success)" strokeWidth={2} dot={{ r: 4 }} {...CHART_ANIMATION} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Section>
      <Section title="Budget Variance">
        <p className="text-[11px] text-muted-foreground mt-1 mb-2 leading-relaxed">
          This shows how much each department has spent versus what it was allocated for the period.
          A <span className="text-destructive font-medium">positive %</span> means the department spent more than its budget (over budget);
          a <span className="text-success font-medium">negative %</span> means it spent less (under budget, budget available to reallocate).
        </p>
        <div className="space-y-1.5 text-xs">
          {scoped.length === 0 ? (
            <div className="text-muted-foreground">No budget data available.</div>
          ) : (
            scoped.slice(0, 8).map((v) => (
              <div
                key={v.department}
                onClick={() => { setDepartment(deptName as Department); navigate({ to: "/employees", search: {} }); }}
                className="flex justify-between border-b border-border pb-1 cursor-pointer hover:bg-surface-muted/40 rounded px-1 -mx-1 transition-colors"
              >
                <span className="text-muted-foreground">{deptName}</span>
                <span className={cn("font-semibold", v.variancePct > 5 ? "text-destructive" : v.variancePct < -5 ? "text-success" : "text-foreground")}>
                  {v.variancePct > 0 ? "+" : ""}{v.variancePct}%
                </span>
              </div>
            ))
          )}
        </div>
      </Section>
      <div className="bg-primary-soft p-3 rounded-lg border border-primary/20 text-xs space-y-2">
        <div>
          <div className="font-semibold text-primary">What to do</div>
          <p className="text-muted-foreground mt-1 leading-relaxed">
            {overBudget.length > 0
              ? `Review and freeze discretionary spend in ${overBudget[0].department} first — it's ${overBudget[0].variancePct}% over its allocated budget${overBudget.length > 1 ? `, along with ${overBudget.length - 1} other department(s)` : ""}.`
              : "No department is currently over budget by more than 5% — no immediate spending freeze needed."}
          </p>
        </div>
        {underBudget.length > 0 && (
          <div>
            <p className="text-muted-foreground leading-relaxed">
              {underBudget[0].department} has {Math.abs(underBudget[0].variancePct)}% budget unused
              {underBudget.length > 1 ? ` (along with ${underBudget.length - 1} other department(s))` : ""} — consider reallocating this surplus to over-budget departments instead of losing it at period close.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function TrainingSummaryModule({ deptId }: { deptId: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ["training-summary", deptId],
    queryFn: () => coreApi.getTrainingSummary({ departmentId: deptId || undefined }),
  });
  const [expanded, setExpanded] = useState<string | null>(null);

  if (isLoading) return <div className="p-6 text-center text-xs text-muted-foreground">Loading training data...</div>;

  const courses = (data?.data ?? []) as { title: string; category?: string; totalEnrolled: number; completed: number; completionRate: number; officers: { id: string; name: string; designation: string; department: string; status: string; completionDate: string }[] }[];

  if (courses.length === 0) {
    return <div className="p-6 text-center text-xs text-muted-foreground">No training records found.</div>;
  }

  return (
    <div className="space-y-2 text-xs">
      <Section title="Officer-wise Training Completion">
        <div className="space-y-2 mt-2">
          {courses.map((c) => (
            <div key={c.title} className="border border-border rounded-lg overflow-hidden">
              <button
                className="w-full flex items-center justify-between p-2.5 hover:bg-surface-muted/40 text-left"
                onClick={() => setExpanded(expanded === c.title ? null : c.title)}
              >
                <div>
                  <div className="font-medium">{c.title}</div>
                  <div className="text-[10px] text-muted-foreground">{c.category} · {c.completed}/{c.totalEnrolled} completed</div>
                </div>
                <span className="font-semibold text-success">{c.completionRate}%</span>
              </button>
              {expanded === c.title && (
                <div className="border-t border-border divide-y divide-border">
                  {c.officers.map((o) => (
                    <div key={o.id} className="flex items-center justify-between p-2 text-[10.5px]">
                      <div>
                        <div className="font-medium">{o.name}</div>
                        <div className="text-muted-foreground">{o.designation} · {o.department}</div>
                      </div>
                      <Pill tone={o.status === "Completed" ? "success" : "warning"}>{o.status}</Pill>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function OrgModuleContent({ active, deptId, deptName, deptData }: { active: OrgModuleKey | null; deptId: string | null; deptName: string; deptData: any }) {
  if (!active) return null;

  switch (active) {
    case "orgchart":
      return <OrgChartModule deptId={deptId} />;
    case "overview":
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Panel className="p-3 bg-surface-muted/20">
              <div className="text-[10px] text-muted-foreground uppercase">Tasks Resolved</div>
              <div className="text-lg font-bold mt-1 text-success">{deptData?.slaPct ?? "—"}% SLA</div>
            </Panel>
            <Panel className="p-3 bg-surface-muted/20">
              <div className="text-[10px] text-muted-foreground uppercase">Budget Variance</div>
              <div className="text-lg font-bold mt-1 text-primary">
                {deptData?.budgetVariancePct != null ? `${deptData.budgetVariancePct >= 0 ? "+" : ""}${deptData.budgetVariancePct}%` : "—"}
              </div>
            </Panel>
          </div>
          <Section title="Department Snapshot">
            <div className="space-y-2 mt-2 text-xs">
              <div className="flex justify-between border-b border-border pb-1.5">
                <span className="text-muted-foreground">Active Employees</span>
                <span className="font-semibold text-foreground">{deptData?.employeeCount?.toLocaleString("en-IN") ?? "—"}</span>
              </div>
              <div className="flex justify-between border-b border-border pb-1.5">
                <span className="text-muted-foreground">Open Vacancies</span>
                <span className="font-semibold text-warning-foreground">{deptData?.vacancyCount ?? "—"}</span>
              </div>
              <div className="flex justify-between border-b border-border pb-1.5">
                <span className="text-muted-foreground">Pending Grievances</span>
                <span className="font-semibold text-foreground">{deptData?.pendingGrievances ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Active Projects</span>
                <span className="font-semibold text-foreground">{deptData?.activeProjects ?? "—"}</span>
              </div>
            </div>
          </Section>
        </div>
      );

    case "workforce":
      return <WorkforceModule deptId={deptId} deptName={deptName} />;

    case "finance":
      return <FinanceModule deptId={deptId} deptName={deptName} />;

    case "vacancies":
      return <VacanciesModule deptId={deptId} deptName={deptName} />;

    case "performance":
      return (
        <div className="space-y-4">
          <Section title="Key Performance Indicators (KPIs)">
            <div className="space-y-3 mt-2 text-xs">
              {[
                { name: "SLA Task Compliance", val: deptData?.slaPct ?? 0, target: 90 },
                { name: "Staff Attendance Index", val: deptData?.attendancePct ?? 0, target: 92 },
                { name: "Budget Discipline (100 − |variance|×2)", val: Math.max(0, 100 - Math.abs(deptData?.budgetVariancePct ?? 0) * 2), target: 90 },
              ].map((k, i) => (
                <div key={i} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-foreground/90 font-medium">{k.name}</span>
                    <span className="font-bold text-foreground">{Math.round(k.val)}% <span className="text-[10px] text-muted-foreground">/ {k.target}%</span></span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div className="h-full bg-primary rounded-full" style={{ width: `${Math.min(100, k.val)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </div>
      );

    case "training":
      return <TrainingSummaryModule deptId={deptId} />;

    case "compliance":
      return <ComplianceModule deptData={deptData} />;

    case "assets":
      return <AssetsModule deptId={deptId} />;

    case "grievances":
      return <GrievancesModule deptName={deptName} />;

    case "projects":
      return <ProjectsModule deptId={deptId} />;

    default:
      return null;
  }
}

function VacanciesModule({ deptId, deptName }: { deptId: string | null; deptName: string }) {
  const navigate = useNavigate();
  const { setDepartment } = useDepartment();
  const { data, isLoading } = useQuery({
    queryKey: ["dept-vacancies", deptId],
    queryFn: () => coreApi.getDepartmentVacancies(deptId!),
    enabled: !!deptId,
  });
  if (isLoading) return <div className="p-6 text-center text-xs text-muted-foreground">Loading vacancy data...</div>;
  const rows = data?.data ?? [];
  if (!rows.length) return <div className="p-6 text-center text-xs text-muted-foreground">No tracked designations for this department.</div>;

  const goToDesignation = (designation: string) => {
    setDepartment(deptName as Department);
    navigate({ to: "/employees", search: { designation } });
  };

  return (
    <div className="space-y-3">
      <Section title="Sanctioned vs. Filled Strength">
        <div className="space-y-3 mt-2 text-xs">
          {rows.map((v: any, i: number) => (
            <div
              key={i}
              onClick={() => goToDesignation(v.designation)}
              className="border border-border/60 rounded-lg p-3 space-y-2 cursor-pointer hover:bg-surface-muted/40 hover:border-primary/30 transition-colors"
            >
              <div className="font-semibold text-foreground">{v.designation}</div>
              <div className="grid grid-cols-3 gap-2 text-center text-[10px]">
                <div className="bg-surface border border-border/40 p-1.5 rounded">
                  <span className="text-muted-foreground block">Sanctioned</span>
                  <span className="font-bold text-foreground">{v.sanctioned}</span>
                </div>
                <div className="bg-surface border border-border/40 p-1.5 rounded">
                  <span className="text-muted-foreground block">Filled</span>
                  <span className="font-bold text-success">{v.filled}</span>
                </div>
                <div className="bg-surface border border-border/40 p-1.5 rounded">
                  <span className="text-muted-foreground block">Vacancies</span>
                  <span className="font-bold text-warning-foreground">{v.open}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function ComplianceModule({ deptData }: { deptData: any }) {
  const { data } = useQuery({
    queryKey: ["compliance-radar"],
    queryFn: () => coreApi.getComplianceRadar(),
  });
  const overall = data?.overall;
  return (
    <div className="space-y-3 text-xs">
      <Section title="Regulatory & Audit Compliance">
        <div className="space-y-2.5 mt-2">
          <div className={cn(
            "p-3 rounded-lg flex items-start gap-2 border",
            deptData?.auditStatus === "Clean" ? "border-emerald-500/20 bg-emerald-500/5" : "border-warning/20 bg-warning/5"
          )}>
            <ShieldCheck className={cn("size-4.5 shrink-0 mt-0.5", deptData?.auditStatus === "Clean" ? "text-success" : "text-warning-foreground")} />
            <div>
              <div className={cn("font-semibold", deptData?.auditStatus === "Clean" ? "text-success" : "text-warning-foreground")}>
                Audit Status: {deptData?.auditStatus ?? "—"}
              </div>
              <div className="text-muted-foreground text-[10.5px] mt-0.5">Last audited {deptData?.lastAuditDate ? formatDate(deptData.lastAuditDate) : "—"}.</div>
            </div>
          </div>
          <div className="flex justify-between border-b border-border pb-1.5">
            <span className="text-muted-foreground">Corporation-wide Compliance Score</span>
            <span className="font-bold text-foreground">{overall != null ? `${overall}%` : "—"}</span>
          </div>
          <div className="flex justify-between border-b border-border pb-1.5">
            <span className="text-muted-foreground">Pending Grievances (this dept.)</span>
            <span className="font-semibold text-foreground">{deptData?.pendingGrievances ?? "—"}</span>
          </div>
        </div>
      </Section>
    </div>
  );
}

function AssetsModule({ deptId }: { deptId: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ["dept-assets", deptId],
    queryFn: () => coreApi.getDepartmentAssets(deptId!),
    enabled: !!deptId,
  });
  if (isLoading) return <div className="p-6 text-center text-xs text-muted-foreground">Loading asset data...</div>;
  const rows = data?.data ?? [];
  const byType = new Map<string, { total: number; issues: number }>();
  for (const r of rows) {
    if (!byType.has(r.type)) byType.set(r.type, { total: 0, issues: 0 });
    const rec = byType.get(r.type)!;
    rec.total += r.count;
    if (r.status === "Lost") rec.issues += r.count;
  }
  const entries = [...byType.entries()];
  if (!entries.length) return <div className="p-6 text-center text-xs text-muted-foreground">No assets on file for this department.</div>;

  return (
    <div className="space-y-3 text-xs">
      <Section title="Asset Logistics Inventory">
        <div className="space-y-2.5 mt-2">
          {entries.map(([type, rec], i) => (
            <div key={i} className="flex justify-between border-b border-border pb-1.5">
              <div>
                <span className="font-medium text-foreground">{type}</span>
                <span className="text-[10px] text-muted-foreground block">{rec.total} unit(s){rec.issues ? ` · ${rec.issues} reported lost` : ""}</span>
              </div>
              <Pill tone={rec.issues > 0 ? "warning" : "success"}>{rec.issues > 0 ? "Attention" : "Active"}</Pill>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function GrievancesModule({ deptName }: { deptName: string }) {
  const [categoryFilter, setCategoryFilter] = useState("All");
  const { data, isLoading } = useQuery({
    queryKey: ["dept-grievances", deptName],
    queryFn: () => coreApi.getGrievances(deptName),
    enabled: !!deptName,
  });
  if (isLoading) return <div className="p-6 text-center text-xs text-muted-foreground">Loading grievance data...</div>;
  const rows = data?.data ?? [];
  const open = rows.filter((g: any) => g.status !== "Resolved").length;
  const resolved = rows.filter((g: any) => g.status === "Resolved");
  const byCategory = new Map<string, number>();
  for (const g of rows) byCategory.set(g.category, (byCategory.get(g.category) || 0) + 1);
  const topCategory = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0];
  const categories = ["All", ...Array.from(new Set(rows.map((g: any) => g.category)))];
  const filteredRows = categoryFilter === "All" ? rows : rows.filter((g: any) => g.category === categoryFilter);

  return (
    <div className="space-y-3 text-xs">
      <Section title="Public Grievances Desk">
        <div className="space-y-2 mt-2">
          <div className="flex justify-between border-b border-border pb-1.5">
            <span className="text-muted-foreground">Open/Unresolved Grievances</span>
            <span className="font-bold text-destructive">{open} file(s)</span>
          </div>
          <div className="flex justify-between border-b border-border pb-1.5">
            <span className="text-muted-foreground">Resolved (all time)</span>
            <span className="font-semibold text-foreground">{resolved.length} of {rows.length}</span>
          </div>
          {topCategory && (
            <div className="p-3 border border-border bg-surface-muted/20 rounded-lg">
              <span className="font-semibold text-foreground block">Key Pain Point</span>
              <p className="text-[10.5px] text-muted-foreground mt-1">
                "{topCategory[0]}" accounts for {topCategory[1]} of {rows.length} filed grievance(s) in this department.
              </p>
            </div>
          )}
        </div>
      </Section>

      <Section
        title="Filed Grievances"
        action={
          <FilterPill value={categoryFilter} onChange={setCategoryFilter} options={categories} label="All Categories" size="compact" />
        }
      >
        {filteredRows.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground">No grievances match this filter.</div>
        ) : (
          <div className="space-y-1.5 mt-2 max-h-72 overflow-y-auto scrollbar-thin pr-1">
            {filteredRows.map((g: any) => (
              <div key={g.id} className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-surface p-2">
                <div className="min-w-0">
                  <div className="font-medium truncate">{g.subject}</div>
                  <div className="text-[10px] text-muted-foreground">{g.category} · {g.id}</div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Pill tone={g.severity === "Critical" ? "destructive" : g.severity === "High" ? "warning" : "neutral"}>{g.severity}</Pill>
                  <Pill tone={g.status === "Resolved" ? "success" : "warning"}>{g.status}</Pill>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function ProjectsModule({ deptId }: { deptId: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ["dept-projects", deptId],
    queryFn: () => coreApi.getDepartmentProjects(deptId!),
    enabled: !!deptId,
  });
  if (isLoading) return <div className="p-6 text-center text-xs text-muted-foreground">Loading project data...</div>;
  const rows = data?.data ?? [];
  if (!rows.length) return <div className="p-6 text-center text-xs text-muted-foreground">No active projects for this department.</div>;

  return (
    <div className="space-y-3 text-xs">
      <Section title="Active Infrastructure & Systems Development">
        <div className="space-y-3 mt-2">
          {rows.map((p: any) => (
            <div key={p.id} className="space-y-1">
              <div className="flex justify-between font-medium">
                <span className="text-foreground">{p.name}</span>
                <span className="font-bold text-foreground">{p.progressPct}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div className={cn("h-full rounded-full", p.status === "Delayed" ? "bg-destructive" : p.status === "At Risk" ? "bg-warning" : "bg-success")} style={{ width: `${p.progressPct}%` }} />
              </div>
              <div className="text-[10px] text-muted-foreground">{p.status} · target {formatDate(p.targetDate)} · ₹{p.budgetCr} Cr</div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
