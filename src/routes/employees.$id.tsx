import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import {
  ChevronLeft, ChevronRight, Sparkles, Briefcase, Award, MapPin, GraduationCap,
  FileText, Download, Share2, ShieldCheck, Gauge, CheckSquare, CalendarDays,
  BookOpen, Route as RouteIcon, Folder, Laptop, Wallet, Brain, X,
  TrendingUp, TrendingDown, Clock, Star, ArrowUpRight, Send, Bot, Plus,
  ArrowRightLeft, BadgeCheck, FileSearch, Heart, Zap, Target, Layers,
  Network, Calendar, ChevronUp, ShieldAlert, CheckCircle2, Trophy, Info,
  AlertTriangle,
} from "lucide-react";
import { Pill } from "@/components/layout/section";
import { FilterPill } from "@/components/ui/filter-pill";
import { coreApi, ApiError } from "@/lib/api-client";
import { Organogram } from "@/components/employees/organogram";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { cn, formatDate, formatMonthYear } from "@/lib/utils";
import { useAuth } from "@/context/auth-context";

export const Route = createFileRoute("/employees/$id")({
  head: ({ params }) => ({ meta: [{ title: `Employee 360 · ${params.id} · AWIP` }] }),
  component: Employee360,
});

type EmployeeDetail = any;

// ----- Module registry -----
type ModuleKey =
  | "overview" | "ai" | "performance" | "tasks" | "attendance" | "skills"
  | "career" | "documents" | "assets" | "compensation" | "activity" | "training";

type ModuleDef = {
  key: ModuleKey;
  label: string;
  icon: ComponentType<{ className?: string }>;
  tone: "primary" | "success" | "warning" | "destructive" | "info";
};

const MODULES: ModuleDef[] = [
  { key: "ai",           label: "AI Insights",   icon: Brain,       tone: "primary" },
  { key: "performance",  label: "Performance",   icon: Gauge,       tone: "success" },
  { key: "tasks",        label: "Tasks",         icon: CheckSquare, tone: "info" },
  { key: "career",       label: "Career",        icon: RouteIcon,   tone: "info" },
  { key: "training",     label: "Training",      icon: GraduationCap, tone: "warning" },
  { key: "compensation", label: "Compensation",  icon: Wallet,      tone: "success" },
  { key: "activity",     label: "Awards & Events", icon: Award,     tone: "primary" },
  { key: "assets",       label: "Assets",        icon: Laptop,      tone: "success" },
  { key: "documents",    label: "Documents",     icon: Folder,      tone: "warning" },
  { key: "skills",       label: "Skills",        icon: BookOpen,    tone: "info" },
  { key: "attendance",   label: "Attendance",    icon: CalendarDays, tone: "success" },
  { key: "overview",     label: "Overview",      icon: Layers,      tone: "primary" },
];

// Falls back to a neutral 75 if the backend hasn't computed insights for
// this response shape (e.g. a lighter list-endpoint payload).
function moduleScore(employee: EmployeeDetail, key: ModuleKey): number {
  return employee?.insights?.healthScores?.[key] ?? 75;
}
function moduleBadge(employee: EmployeeDetail, key: ModuleKey): number | undefined {
  return employee?.insights?.badges?.[key];
}

function Employee360() {
  const { id } = Route.useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const isEmployeeView = user?.role === "Employee";

  useEffect(() => {
    if (isEmployeeView && user?.employeeId && id !== user.employeeId) {
      navigate({ to: "/employees/$id", params: { id: user.employeeId } });
    }
  }, [isEmployeeView, user?.employeeId, id, navigate]);

  const { data: e, isLoading, isError } = useQuery({
    queryKey: ["employee", id],
    queryFn: () => coreApi.getEmployee(id),
  });

  return (
    <div className="min-h-full bg-background">
      <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-3 max-w-[1700px] mx-auto">
        <Link to="/employees" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ChevronLeft className="size-3.5" /> Back to Directory
        </Link>
      </div>
      <div className="px-5 pb-8 max-w-[1700px] mx-auto">
        {isLoading ? (
          <div className="p-10 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading employee…
          </div>
        ) : isError || !e ? (
          <div className="p-10 text-center text-sm text-destructive">Employee not found.</div>
        ) : (
          <EmployeeDigitalTwin employee={e} isEmployeeView={isEmployeeView} />
        )}
      </div>
    </div>
  );
}

export function EmployeeDigitalTwin({
  employee: e, layout = "split", isEmployeeView = false,
}: {
  employee: EmployeeDetail;
  layout?: "split" | "stacked";
  isEmployeeView?: boolean;
}) {
  const [active, setActive] = useState<ModuleKey | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [orgOpen, setOrgOpen] = useState(false);
  const [vigilanceOpen, setVigilanceOpen] = useState(false);
  const [hpOpen, setHpOpen] = useState(false);
  const isHiPo = !!e.insights?.highPotential?.flagged;
  // HR/Dept Head always gets the button (so they can manually flag anyone,
  // not just employees the AI already caught) — self-view stays read-only
  // and only appears once actually flagged, since manual control isn't a
  // self-service action.
  const showHpButton = !isEmployeeView || isHiPo;

  void layout;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
        <Pill tone="primary"><Sparkles className="size-3" /> Digital Employee Twin · Live</Pill>
        {showHpButton && (
          <button
            onClick={() => setHpOpen(true)}
            className={cn(
              "h-8 px-3 inline-flex items-center gap-1.5 rounded-full text-xs font-semibold",
              isHiPo
                ? "border border-primary/40 bg-primary-soft text-primary hover:bg-primary-soft/80"
                : "border border-border bg-card text-foreground/70 font-medium hover:bg-surface-muted",
            )}
          >
            <Trophy className="size-3.5" /> High Potential
          </button>
        )}
        <button
          onClick={() => setOrgOpen(true)}
          className="h-8 px-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-card text-xs font-medium hover:bg-surface-muted"
        >
          <Network className="size-3.5" /> Organogram
        </button>
        <button
          onClick={() => setCopilotOpen(true)}
          className="h-8 px-3 inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium hover:opacity-95"
        >
          <Bot className="size-3.5" /> Ask AWIP about {e.name.split(" ")[0]}
        </button>
      </div>

      <HighPotentialOverlay employee={e} isEmployeeView={isEmployeeView} open={hpOpen} onClose={() => setHpOpen(false)} />

      {/* Radial centered on top */}
      <RadialWorkspace
        employee={e}
        active={active}
        onSelect={(k) => setActive(k === active ? null : k)}
      />

      {/* Info + AI/Detail below */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <TwinInfoCard employee={e} onOpenOrg={() => setOrgOpen(true)} onOpenVigilance={isEmployeeView ? undefined : () => setVigilanceOpen(true)} />
        <WelcomePanel employee={e} onOpenCopilot={() => setCopilotOpen(true)} isEmployeeView={isEmployeeView} />
      </div>

      {/* Module detail overlay */}
      <ModuleDetailOverlay
        employee={e}
        active={active}
        isEmployeeView={isEmployeeView}
        onClose={() => setActive(null)}
        onNavigate={(dir) => {
          if (!active) return;
          const idx = MODULES.findIndex((m) => m.key === active);
          if (idx < 0) return;
          const next = dir === "next"
            ? (idx + 1) % MODULES.length
            : (idx - 1 + MODULES.length) % MODULES.length;
          setActive(MODULES[next].key);
        }}
      />


      {/* Organogram section (scrollable) */}
      <div id="organogram" className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="size-8 rounded-full bg-surface-muted text-primary grid place-items-center">
              <Network className="size-4" />
            </div>
            <div>
              <div className="text-sm font-semibold">Reporting Structure</div>
              <div className="text-[11px] text-muted-foreground">Where {e.name.split(" ")[0]} sits in the organisation</div>
            </div>
          </div>
          <button
            onClick={() => setOrgOpen(true)}
            className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
          >
            Expand <ArrowUpRight className="size-3" />
          </button>
        </div>
        <div className="max-h-[360px] overflow-y-auto scrollbar-thin pr-2">
          <Organogram employee={e} />
        </div>
      </div>

      {/* Organogram — side overlay (matches ModuleDetailOverlay's slide-in pattern) */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px] transition-opacity duration-300",
          orgOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
        onClick={() => setOrgOpen(false)}
        aria-hidden="true"
      />
      <div
        className={cn(
          "fixed top-0 right-0 bottom-0 z-50 w-full sm:w-[520px] bg-card border-l border-border shadow-2xl flex flex-col transition-transform duration-300 ease-in-out",
          orgOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
        <div className="px-4 py-3 border-b border-border bg-card flex items-center gap-3">
          <div className="size-9 rounded-full bg-primary text-primary-foreground grid place-items-center shrink-0">
            <Network className="size-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate">Organogram · {e.name}</div>
            <div className="text-[11px] text-muted-foreground truncate">{e.designation} · {e.department}</div>
          </div>
          <button
            onClick={() => setOrgOpen(false)}
            className="size-8 grid place-items-center rounded-full hover:bg-surface-muted transition-colors shrink-0"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 p-4 overflow-y-auto scrollbar-thin">
          <Organogram employee={e} />
        </div>
      </div>

      <Dialog open={vigilanceOpen} onOpenChange={setVigilanceOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-primary" /> Vigilance & Disciplinary Record
            </DialogTitle>
            <DialogDescription>
              Confidential record for {e.name}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className={cn(
              "flex items-center justify-between p-3 rounded-lg border-2 bg-surface-muted/30",
              e.insights?.vigilance.clearance === "Flagged" ? "border-destructive/40" : "border-success/40",
            )}>
              <div className="flex items-center gap-2">
                <CheckCircle2 className={cn("size-4", e.insights?.vigilance.clearance === "Flagged" ? "text-destructive" : "text-success")} />
                <span className="text-sm font-medium">Vigilance Clearance</span>
              </div>
              <span className={cn("text-xs font-semibold", e.insights?.vigilance.clearance === "Flagged" ? "text-destructive" : "text-success")}>
                {e.insights?.vigilance.clearance ?? "Granted"}
              </span>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Past Inquiries</div>
              <div className="text-sm text-muted-foreground border border-border rounded-lg p-6 text-center bg-card">
                {e.insights?.vigilance.note ?? "No active or past disciplinary inquiries found on record."}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {copilotOpen && (
        <CopilotPanel employee={e} onClose={() => setCopilotOpen(false)} />
      )}
    </div>
  );
}



// ============ Radial layout ============
// ============ Radial layout ============
function RadialWorkspace({
  employee, active, onSelect,
}: {
  employee: EmployeeDetail;
  active: ModuleKey | null;
  onSelect: (k: ModuleKey) => void;
}) {
  const e = employee;
  // Geometry
  const size = 760;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 290;
  const modulePositions = useMemo(() => {
    return MODULES.map((m, i) => {
      const angle = (i / MODULES.length) * Math.PI * 2 - Math.PI / 2;
      return {
        ...m,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      };
    });
  }, []);

  const initials = e.name.split(" ").map((n: string) => n[0]).slice(0, 2).join("");

  const toneColors = {
    primary: "var(--color-primary)",
    success: "var(--color-success)",
    warning: "var(--color-warning)",
    info: "var(--color-info)",
    destructive: "var(--color-destructive)",
  };

  // Nexus aesthetic: every satellite node uses the same indigo fill when
  // active/hovered (via group-hover, the parent <button> is the "group"),
  // regardless of tone — tone still colors the score pill and connecting
  // line below, just not the node's own background.
  const getButtonClass = (isActive: boolean) => {
    if (isActive) {
      return "bg-primary text-primary-foreground shadow-lg shadow-primary/30 scale-110";
    }
    return "bg-card text-foreground/70 shadow-[0_4px_24px_rgba(0,93,94,0.08)] group-hover:bg-primary group-hover:text-primary-foreground group-hover:shadow-lg group-hover:shadow-primary/30";
  };

  return (
    <div className="relative bg-card rounded-xl overflow-hidden p-2 border border-border shadow-sm">
      <div className="relative mx-auto aspect-square w-full max-w-[560px]">

        {/* Connection lines */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          viewBox={`0 0 ${size} ${size}`}
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <radialGradient id="ring" cx="50%" cy="50%" r="50%">
              <stop offset="60%" stopColor="var(--color-primary)" stopOpacity="0" />
              <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0.04" />
            </radialGradient>
          </defs>
          <circle cx={cx} cy={cy} r={radius} fill="url(#ring)" />
          <circle cx={cx} cy={cy} r={radius} fill="none" stroke="var(--color-border)" strokeDasharray="2 6" opacity="0.8" />
          <circle cx={cx} cy={cy} r={radius - 50} fill="none" stroke="var(--color-border)" strokeDasharray="1 5" opacity="0.4" />
          {modulePositions.map((m) => {
            const isActive = active === m.key;
            return (
              <line
                key={m.key}
                x1={cx} y1={cy} x2={m.x} y2={m.y}
                stroke={isActive ? toneColors[m.tone] : "var(--color-border)"}
                strokeWidth={isActive ? 2 : 0.5}
                opacity={isActive ? 0.95 : 0.35}
              />
            );
          })}
          {/* Animated pulse on active line */}
          {active && (() => {
            const m = modulePositions.find((x) => x.key === active)!;
            return (
              <circle r="3.5" fill={toneColors[m.tone]}>
                <animateMotion dur="1.4s" repeatCount="indefinite"
                  path={`M ${cx} ${cy} L ${m.x} ${m.y}`} />
              </circle>
            );
          })()}
        </svg>

        {/* Module nodes */}
        {modulePositions.map((m) => {
          const Icon = m.icon;
          const isActive = active === m.key;
          const badge = moduleBadge(e, m.key);
          return (
            <button
              key={m.key}
              onClick={() => onSelect(m.key)}
              className={cn(
                "group absolute -translate-x-1/2 -translate-y-1/2 w-[112px] flex flex-col items-center gap-1.5 transition-transform",
                "hover:-translate-y-[calc(50%+2px)]",
              )}
              style={{ left: `${(m.x / size) * 100}%`, top: `${(m.y / size) * 100}%` }}
            >
              <motion.div
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className={cn(
                  "relative size-14 rounded-full grid place-items-center backdrop-blur-sm",
                  getButtonClass(isActive)
                )}
              >
                <Icon className="size-5" />
                {!!badge && (
                  <span className="absolute -top-1 -right-1 size-5 rounded-full bg-destructive text-destructive-foreground text-[10px] font-semibold grid place-items-center border-2 border-card">
                    {badge}
                  </span>
                )}
                {/* Decorative full ring — no longer tied to a score */}
                <svg className="absolute inset-0 -rotate-90" viewBox="0 0 56 56">
                  <circle cx="28" cy="28" r="26" fill="none" stroke="currentColor" strokeWidth="1.5"
                    strokeDasharray="163 163" opacity={isActive ? 0.35 : 0.4} />
                </svg>
              </motion.div>
              <div className="text-[11px] font-medium leading-tight text-center text-foreground/90 group-hover:text-foreground">{m.label}</div>
            </button>
          );
        })}

        {/* Center employee card */}
        <CenterCard employee={e} initials={initials} />
      </div>

      {/* Status Grading Legend */}
      <div className="absolute bottom-3 left-3 flex items-center gap-3.5 bg-card/90 backdrop-blur-sm rounded-lg px-2.5 py-1 text-[10px] text-muted-foreground shadow-[0_4px_24px_rgba(0,93,94,0.08)] z-20 select-none">
        <span className="font-semibold text-foreground mr-1">Status Grading:</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-success" /> Healthy</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-warning" /> Caution / Pending</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-destructive" /> Breach / SLA Risk</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-primary" /> Active Module</span>
      </div>
    </div>
  );
}

function CenterCard({
  employee: e, initials,
}: {
  employee: EmployeeDetail;
  initials: string;
}) {
  const scrollToInfo = () => {
    const el = document.getElementById("employee-info-card");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-1/2 w-[clamp(140px,22%,180px)] bg-card rounded-2xl border border-border shadow-sm p-3 text-center"
      style={{ left: "50%", top: "50%" }}
    >
      <div className="flex flex-col items-center gap-1.5">
        <div className="relative">
          {e.photo ? (
            <img src={e.photo} alt={e.name} className="size-14 rounded-full object-cover ring-4 ring-primary/10" />
          ) : (
            <div className="size-14 rounded-full bg-gradient-to-br from-primary to-primary/60 text-primary-foreground text-lg font-semibold grid place-items-center ring-4 ring-primary/10">
              {initials}
            </div>
          )}
          <span className="absolute bottom-0 right-0 size-3.5 rounded-full bg-success border-2 border-card" />
        </div>
        <div className="min-w-0 w-full">
          <button
            onClick={scrollToInfo}
            className="text-xs font-semibold truncate w-full hover:text-primary hover:underline transition-colors cursor-pointer"
            title="Jump to employee details"
          >
            {e.name}
          </button>
          <div className="text-[10px] text-muted-foreground truncate">{e.designation}</div>
          <div className="text-[9px] text-muted-foreground tabular-nums">{e.id}</div>
        </div>
        <div className="text-[9px] text-muted-foreground pt-1 w-full">
          AI Confidence · <span className="text-primary font-semibold">{moduleScore(e, "ai")}%</span>
        </div>
      </div>
    </div>
  );
}

function TwinInfoCard({ employee: e, onOpenOrg, onOpenVigilance }: { employee: EmployeeDetail; onOpenOrg?: () => void; onOpenVigilance?: () => void }) {
  const initials = e.name.split(" ").map((n: string) => n[0]).slice(0, 2).join("");
  const education = (e.educationRecords ?? []) as { id: number; degree: string; institution: string; fieldOfStudy?: string | null; yearCompleted?: number | null }[];
  const experience = (e.workExperience ?? []) as { id: number; organization: string; role: string; fromYear?: number | null; toYear?: number | null; description?: string | null }[];
  const scrollToTop = () => {
    const main = document.querySelector("main");
    if (main) main.scrollTo({ top: 0, behavior: "smooth" });
    else window.scrollTo({ top: 0, behavior: "smooth" });
  };
  return (
    <div id="employee-info-card" className="bg-card border border-border rounded-xl p-4 flex flex-col gap-3 scroll-mt-4">
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          {e.photo ? (
            <img src={e.photo} alt={e.name} className="size-12 rounded-full object-cover ring-4 ring-primary/10" />
          ) : (
            <div className="size-12 rounded-full bg-gradient-to-br from-primary to-primary/60 text-primary-foreground text-base font-semibold grid place-items-center ring-4 ring-primary/10">
              {initials}
            </div>
          )}
          <span className="absolute bottom-0 right-0 size-3 rounded-full bg-success border-2 border-card" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="text-sm font-semibold truncate">{e.name}</div>
            {e.isFlagship && (
              <Pill tone="primary"><Trophy className="size-3" /> Flagship Profile</Pill>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">{e.designation}</div>
          <div className="text-[10px] text-muted-foreground tabular-nums">{e.id}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
        <Meta label="Dept" value={e.department} />
        <Meta label="Cadre" value={e.cadre} />
        <Meta label="Grade" value={e.grade ?? "—"} />
        <Meta label="Job Profile" value={e.jobProfile ?? "—"} />
        <Meta label="Posting" value={e.posting} />
        <Meta label="Ward" value={e.ward ?? "—"} />
        <Meta label="Division" value={e.divisionName ?? "—"} />
        <Meta label="Reports to" value={e.manager ? `${e.manager.designation} · ${e.manager.name}` : "Department Head"} />
        <Meta label="Joined" value={formatDate(e.doj)} />
        <Meta label="Retirement" value={formatMonthYear(e.retirement.slice(0, 7))} />
        <Meta label="Seniority" value={e.seniorityYears != null ? `${e.seniorityYears} yrs` : "—"} />
        {e.actingRole && <Meta label="Acting Role" value={e.actingRole} />}
      </div>

      {e.bio && (
        <div className="pt-3 border-t border-border space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Personal Details</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
            <Meta label="DOB" value={e.bio.dob ? `${formatDate(e.bio.dob)} (${new Date().getFullYear() - Number(e.bio.dob.slice(0, 4))} yrs)` : "—"} />
            <Meta label="Gender" value={e.bio.gender ?? "—"} />
            <Meta label="Blood Group" value={e.bio.bloodGroup ?? "—"} />
            <Meta label="Marital Status" value={e.bio.maritalStatus ?? "—"} />
          </div>
          <div className="grid grid-cols-1 gap-1 text-[10px] pt-1">
            <Meta label="Phone" value={e.bio.phone ?? "—"} />
            <Meta label="Personal Email" value={e.bio.personalEmail ?? "—"} />
            <Meta label="Address" value={e.bio.address ?? "—"} />
            {e.bio.emergencyContact && (
              <Meta label="Emergency Contact" value={`${e.bio.emergencyContact.name} (${e.bio.emergencyContact.relation}) · ${e.bio.emergencyContact.phone}`} />
            )}
          </div>
        </div>
      )}

      {(education.length > 0 || experience.length > 0) && (
        <div className="pt-3 border-t border-border space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Education &amp; Experience</div>
          <div className="space-y-1">
            {education.map((ed) => (
              <div key={`ed-${ed.id}`} className="flex items-start gap-1.5 text-[10px]">
                <GraduationCap className="size-3 text-primary shrink-0 mt-0.5" />
                <span>
                  <span className="text-foreground font-medium">{ed.degree}</span>{ed.fieldOfStudy ? ` · ${ed.fieldOfStudy}` : ""} — {ed.institution}{ed.yearCompleted ? ` (${ed.yearCompleted})` : ""}
                </span>
              </div>
            ))}
            {experience.map((w) => (
              <div key={`we-${w.id}`} className="flex items-start gap-1.5 text-[10px]">
                <Briefcase className="size-3 text-primary shrink-0 mt-0.5" />
                <span>
                  <span className="text-foreground font-medium">{w.role}</span> · {w.organization} ({w.fromYear ?? "—"}–{w.toYear ?? "Present"})
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-1.5">
        <ScoreTile label="Attendance" value={moduleScore(e, "attendance")} icon={Zap} tone="primary" />
        <ScoreTile label="Career Readiness" value={moduleScore(e, "career")} icon={TrendingUp} tone="success" />
        <ScoreTile
          label="Workload"
          value={e.insights ? Math.min(100, Math.round((e.insights.overview.workload.open / e.insights.overview.workload.capacity) * 100)) : 20}
          icon={Heart} tone="destructive" inverted
        />
        <ScoreTile label="Skills" value={moduleScore(e, "skills")} icon={Star} tone="info" />
      </div>

      <div className="mt-auto space-y-3">
        <div className="pt-3 border-t border-border grid grid-cols-3 gap-1">
          <QuickAction icon={Sparkles} label="AI Brief" />
          <QuickAction icon={Download} label="Report" />
          <QuickAction icon={Network} label="Org" onClick={onOpenOrg} />
          {onOpenVigilance && <QuickAction icon={ShieldAlert} label="Vigilance" onClick={onOpenVigilance} />}
          <QuickAction icon={ChevronUp} label="Top" onClick={scrollToTop} />
        </div>

        <div className="text-[10px] text-center text-muted-foreground">
          AI Confidence · <span className="text-primary font-semibold">{moduleScore(e, "ai")}%</span>
        </div>
      </div>
    </div>
  );
}

function ScoreTile({
  label, value, icon: Icon, tone, inverted,
}: { label: string; value: number; icon: ComponentType<{ className?: string }>; tone: string; inverted?: boolean }) {
  const good = inverted ? value < 40 : value >= 70;
  return (
    <div className={cn(
      "rounded-md border-2 px-2 py-1.5 flex items-center gap-1.5 bg-card",
      good ? "border-success/40" : "border-warning/40",
    )}>
      <Icon className={cn("size-3", good ? "text-success" : "text-warning-foreground")} />
      <div className="leading-tight">
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="text-xs font-semibold tabular-nums">{value}</div>
      </div>
    </div>
  );
}

function QuickAction({ icon: Icon, label, onClick }: { icon: ComponentType<{ className?: string }>; label: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-0.5 py-1.5 rounded-md hover:bg-surface-muted transition-colors">
      <Icon className="size-3.5 text-primary" />
      <span className="text-[9px] text-muted-foreground">{label}</span>
    </button>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-foreground truncate" title={value}>{value}</div>
    </div>
  );
}

// ============ Module detail overlay ============
function ModuleDetailOverlay({
  employee: e, active, isEmployeeView = false, onClose, onNavigate,
}: {
  employee: EmployeeDetail;
  active: ModuleKey | null;
  isEmployeeView?: boolean;
  onClose: () => void;
  onNavigate: (dir: "prev" | "next") => void;
}) {
  const m = active ? MODULES.find((x) => x.key === active) : null;
  const isOpen = !!active && !!m;

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px] transition-opacity duration-300",
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sliding panel */}
      <div
        className={cn(
          "fixed top-0 right-0 bottom-0 z-50 w-full sm:w-[520px] bg-card border-l border-border shadow-2xl flex flex-col transition-transform duration-300 ease-in-out",
          isOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
        {m && (
          <>
            {/* Header */}
            <div className="px-4 py-3 border-b border-border bg-card flex items-center gap-3">
              <div className="size-9 rounded-full bg-primary text-primary-foreground grid place-items-center shrink-0">
                <m.icon className="size-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold">{m.label}</div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => onNavigate("prev")}
                  className="size-8 grid place-items-center rounded-full hover:bg-surface-muted transition-colors"
                  aria-label="Previous module"
                  title="Previous module"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <button
                  onClick={() => onNavigate("next")}
                  className="size-8 grid place-items-center rounded-full hover:bg-surface-muted transition-colors"
                  aria-label="Next module"
                  title="Next module"
                >
                  <ChevronRight className="size-4" />
                </button>
                <button
                  onClick={onClose}
                  className="size-8 grid place-items-center rounded-full hover:bg-surface-muted transition-colors"
                  aria-label="Close"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 p-4 overflow-y-auto scrollbar-thin">
              <ModuleContent active={m.key} employee={e} isEmployeeView={isEmployeeView} />
            </div>
          </>
        )}
      </div>
    </>
  );
}


function WelcomePanel({
  employee: e, onOpenCopilot, isEmployeeView = false,
}: { employee: EmployeeDetail; onOpenCopilot: () => void; isEmployeeView?: boolean }) {
  const stats = e.insights?.stats;
  const overview = e.insights?.overview;
  const workloadPct = overview ? Math.round((overview.workload.open / overview.workload.capacity) * 100) : null;

  // Low-balance reminder, self-view only — reuses the same real leave
  // balance data /my/leave already shows, just surfaced here too since this
  // page (Employee 360) is where a self-service employee actually lands.
  const { data: ownBalancesResp } = useQuery({
    queryKey: ["leave-balances", e.id],
    queryFn: () => coreApi.getLeaveBalances(e.id),
    enabled: isEmployeeView,
  });
  const lowBalances = (ownBalancesResp?.data ?? []).filter((b) => b.balance <= 2);

  const summary = stats
    ? `${e.name.split(" ")[0]} is active in ${e.department}` +
      (stats.performanceDeltaPct != null ? ` (${stats.performanceDeltaPct >= 0 ? "+" : ""}${stats.performanceDeltaPct}% YoY performance)` : "") +
      `. ${e.flags?.promotionDue ? "Promotion-eligible per tenure norms" : "Not yet due for promotion"}; ` +
      `${overview?.recommendations.length ?? 0} action item(s) flagged. ` +
      `Workload is ${workloadPct != null && workloadPct >= 70 ? "high" : "manageable"} at ${overview?.workload.open ?? 0} open task(s).`
    : `Loading ${e.name.split(" ")[0]}'s AI summary…`;

  return (
    <div className="bg-card border border-border rounded-xl p-5 flex flex-col gap-4">
      {e.insights?.explanations?.overview && <ScoreExplanation text={e.insights.explanations.overview} />}
      <div className="flex items-start gap-3">
        <div className="size-10 rounded-full bg-surface-muted text-primary grid place-items-center">
          <Sparkles className="size-5" />
        </div>
        <div>
          <div className="text-sm font-semibold">Digital Employee Twin</div>
          <div className="text-xs text-muted-foreground">
            Hover any radial module to preview. Click to expand details here while the twin stays visible.
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface-muted/40 p-4">
        <div className="text-[10px] uppercase tracking-wider text-primary font-semibold mb-1.5">AI Summary · computed from live record</div>
        <p className="text-sm leading-relaxed">{summary}</p>
        <button
          onClick={onOpenCopilot}
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        >
          <Bot className="size-3.5" /> Ask follow-up
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <StatCard icon={TrendingUp} label="Performance" value={stats?.performancePct != null ? `${stats.performancePct}` : "—"}
          trend={stats?.performanceDeltaPct != null ? `${stats.performanceDeltaPct >= 0 ? "+" : ""}${stats.performanceDeltaPct}%` : "—"} tone="success" />
        <StatCard icon={Clock} label="Avg TAT" value={stats ? `${stats.avgTatDays}d` : "—"} trend="vs. task ETA" tone="success" />
        <StatCard icon={CheckSquare} label="Tasks Open" value={stats ? `${stats.openTasks}` : "—"}
          trend={stats && stats.overdueTasks > 0 ? `${stats.overdueTasks} SLA risk` : "on track"} tone={stats && stats.overdueTasks > 0 ? "warning" : "success"} />
        <StatCard icon={Target} label="Goal Progress" value={stats ? `${stats.goalProgressPct}%` : "—"} trend="tasks completed" tone="primary" />
      </div>

      <div className="mt-auto space-y-4">
        <div className="rounded-lg border border-border bg-surface-muted/50 p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Recommended actions</div>
          <ul className="space-y-1.5 text-xs">
            {(overview?.recommendations ?? ["Loading…"]).map((r: string, i: number) => (
              <li key={i} className="flex items-center gap-2">
                <Calendar className="size-3 text-primary shrink-0" /> {r}
              </li>
            ))}
          </ul>
        </div>

        {isEmployeeView && lowBalances.length > 0 && (
          <div className="rounded-lg border-2 border-warning/50 bg-warning/10 p-3">
            <div className="text-[10px] uppercase tracking-wider text-warning-foreground font-semibold mb-2 flex items-center gap-1.5">
              <AlertTriangle className="size-3.5" /> Low leave balance
            </div>
            <ul className="space-y-1 text-xs text-warning-foreground">
              {lowBalances.map((b) => (
                <li key={b.leaveType}>{b.leaveType}: {b.balance} day(s) remaining</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon, label, value, trend, tone,
}: { icon: ComponentType<{ className?: string }>; label: string; value: string; trend: string; tone: string }) {
  return (
    <div className={cn(
      "rounded-lg border-2 bg-surface p-3",
      tone === "success" && "border-success/40",
      tone === "warning" && "border-warning/50",
      tone === "primary" && "border-primary/40",
    )}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3" /> {label}
      </div>
      <div className="text-xl font-semibold mt-1 tabular-nums">{value}</div>
      <div className={cn(
        "text-[10px] mt-0.5",
        tone === "success" && "text-success",
        tone === "warning" && "text-warning-foreground",
        tone === "primary" && "text-primary",
      )}>{trend}</div>
    </div>
  );
}

// ============ Per-module content ============
function ModuleContent({ active, employee: e, isEmployeeView = false }: { active: ModuleKey; employee: EmployeeDetail; isEmployeeView?: boolean }) {
  switch (active) {
    case "overview": return <OverviewModule e={e} />;
    case "ai": return <AIModule e={e} isEmployeeView={isEmployeeView} />;
    case "performance": return <PerformanceModule e={e} isEmployeeView={isEmployeeView} />;
    case "tasks": return <TasksModule e={e} />;
    case "attendance": return <AttendanceModule e={e} />;
    case "skills": return <SkillsModule e={e} />;
    case "training": return <TrainingModule e={e} />;
    case "career": return <CareerModule e={e} />;
    case "documents": return <DocumentsModule e={e} />;
    case "assets": return <AssetsModule e={e} />;
    case "compensation": return <CompensationModule e={e} />;
    case "activity": return <ActivityModule e={e} />;
  }
}

function ScoreExplanation({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-surface-muted px-3 py-2 mb-3 text-[11px] text-muted-foreground">
      <Info className="size-3.5 shrink-0 mt-0.5" />
      <span>{text}</span>
    </div>
  );
}

function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-2">
      <div className="text-[10px] uppercase tracking-wider text-primary font-semibold">{title}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Bar({ label, value, max = 100, tone = "primary" }: { label: string; value: number; max?: number; tone?: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">{value}</span>
      </div>
      <div className="h-1.5 rounded-full bg-surface-muted overflow-hidden mt-1">
        <div className={cn(
          "h-full rounded-full",
          tone === "primary" && "bg-primary",
          tone === "success" && "bg-success",
          tone === "warning" && "bg-warning",
          tone === "destructive" && "bg-destructive",
          tone === "info" && "bg-info",
        )} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function OverviewModule({ e }: { e: EmployeeDetail }) {
  const overview = e.insights?.overview;
  if (!overview) return <div className="p-6 text-center text-xs text-muted-foreground">No overview data found.</div>;
  return (
    <div className="space-y-4">
      <div>
        <SectionHead title="AI Summary" />
        <p className="text-xs leading-relaxed">
          {overview.tenureYears} years of service in {e.department}. SLA compliance is {overview.slaPct}%
          across {overview.workload.open} open task(s), with {overview.skillCount} recorded skill(s) on file.
          {overview.composite != null && ` Composite Score: ${overview.composite}/100, see the AI Insights tab for the pillar breakdown.`}
        </p>
      </div>
      <div>
        <SectionHead title="Current workload" />
        <div className="space-y-2">
          <Bar label="Active tasks" value={overview.workload.open} max={overview.workload.capacity} tone="info" />
          <Bar label="SLA compliance" value={overview.slaPct} tone="success" />
        </div>
      </div>
      <div>
        <SectionHead title="Retirement forecast" />
        <p className="text-xs">Retires {formatMonthYear(e.retirement.slice(0, 7))} · {overview.retirementYearsLeft} year(s) remaining service window.</p>
        {e.insights?.retirementReadiness?.dueSoon && (
          <div className={cn(
            "mt-2 rounded-lg border px-3 py-2 text-xs",
            e.insights.retirementReadiness.ready
              ? "border-success/30 bg-success/10 text-success"
              : "border-warning/30 bg-warning/10 text-warning-foreground",
          )}>
            <div className="font-semibold flex items-center gap-1.5">
              <CheckCircle2 className="size-3.5" />
              Retirement Readiness Audit: {e.insights.retirementReadiness.daysToRetirement} day(s) to retirement
            </div>
            {e.insights.retirementReadiness.ready ? (
              <p className="mt-1">Service book, documents, and disciplinary record are clear, pension processing can proceed on schedule.</p>
            ) : (
              <ul className="mt-1 space-y-0.5 list-disc list-inside">
                {e.insights.retirementReadiness.blockers.map((b: string, i: number) => <li key={i}>{b}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
      <div>
        <SectionHead title="AI recommendations" />
        <ul className="space-y-1.5 text-xs">
          {overview.recommendations.map((r: string, i: number) => (
            <li key={i} className="flex gap-2"><Sparkles className="size-3 text-primary shrink-0 mt-0.5" /> {r}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

type AiInsights = {
  peerComparison: { peerCount: number; peerAvgScore: number; percentile: number } | null;
  perfTrend: "Improving" | "Declining" | "Stable" | "Insufficient data";
  attendanceTrendDelta: number | null;
  skillGrowthRatePct: number | null;
  workloadTrend: "Rising" | "Easing" | "Stable";
  workloadPctOfCapacity: number;
  retentionRisk: "High" | "Medium" | "Low" | "Unknown";
  narrative: string;
  why?: {
    peerComparison: string;
    perfTrend: string;
    attendanceTrendDelta: string;
    skillGrowthRatePct: string;
    workloadTrend: string;
    retentionRisk: string;
  };
};

type DataCompleteness = "full" | "partial" | "none";
type Pillar = { score: number; dataCompleteness: DataCompleteness; why: string };
type Pillars = {
  performanceDelivery: Pillar;
  reliabilityCompliance: Pillar;
  growthCapability: Pillar;
};

const PILLAR_META: { key: keyof Pillars; label: string; icon: ComponentType<{ className?: string }>; tone: "success" | "warning" | "info" }[] = [
  { key: "performanceDelivery", label: "Performance & Delivery", icon: Gauge, tone: "success" },
  { key: "reliabilityCompliance", label: "Reliability & Compliance", icon: ShieldCheck, tone: "info" },
  { key: "growthCapability", label: "Growth & Capability", icon: TrendingUp, tone: "warning" },
];

function CompletenessBadge({ level }: { level: DataCompleteness }) {
  if (level === "full") return null;
  return (
    <span className={cn(
      "text-[9px] px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wide",
      level === "partial" ? "bg-warning/15 text-warning-foreground" : "bg-surface-muted text-muted-foreground",
    )}>
      {level === "partial" ? "Limited data" : "Not enough data yet"}
    </span>
  );
}

function PillarCard({ label, icon: Icon, tone, pillar }: { label: string; icon: ComponentType<{ className?: string }>; tone: "success" | "warning" | "info"; pillar: Pillar }) {
  return (
    <div className={cn(
      "rounded-lg border-2 p-3 bg-surface",
      tone === "success" && "border-success/40",
      tone === "warning" && "border-warning/50",
      tone === "info" && "border-info/40",
    )}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <Icon className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">{label}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <CompletenessBadge level={pillar.dataCompleteness} />
          <span className="text-xs font-semibold tabular-nums">{pillar.score}/100</span>
        </div>
      </div>
      <Bar label="" value={pillar.score} tone={tone} />
      <div className="text-[11px] text-muted-foreground mt-1.5 italic">Why: {pillar.why}</div>
    </div>
  );
}

function AIModule({ e, isEmployeeView = false }: { e: EmployeeDetail; isEmployeeView?: boolean }) {
  const composite = e.insights?.composite as number | undefined;
  const pillars = e.insights?.pillars as Pillars | undefined;
  const ai = e.insights?.aiInsights as AiInsights | undefined;

  if (composite == null || !pillars) {
    return <div className="p-6 text-center text-xs text-muted-foreground">No performance/AI data found.</div>;
  }

  const trendTone = ai?.perfTrend === "Improving" ? "success" : ai?.perfTrend === "Declining" ? "destructive" : "neutral";
  const workloadTone = ai?.workloadTrend === "Rising" ? "warning" : ai?.workloadTrend === "Easing" ? "success" : "neutral";
  const retentionTone = ai?.retentionRisk === "High" ? "destructive" : ai?.retentionRisk === "Medium" ? "warning" : ai?.retentionRisk === "Low" ? "success" : "neutral";
  const attendanceDelta = ai?.attendanceTrendDelta ?? null;
  const attendanceTone = attendanceDelta === null ? "neutral" : attendanceDelta > 0 ? "success" : attendanceDelta < 0 ? "destructive" : "neutral";

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-primary/25 bg-primary-soft/50 p-4">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            <Sparkles className="size-3.5 text-primary" />
            <span className="text-xs font-semibold text-primary">Composite Score</span>
          </div>
          <span className="text-lg font-bold tabular-nums text-primary">{composite}/100</span>
        </div>
        {ai?.narrative && <p className="text-xs leading-relaxed text-foreground">{ai.narrative}</p>}
      </div>

      <div>
        <SectionHead title="Scored pillars" hint="Performance & Delivery 40% · Reliability & Compliance 30% · Growth & Capability 30% = Composite Score above" />
        <div className="space-y-2">
          {PILLAR_META.map((m) => (
            <PillarCard key={m.key} label={m.label} icon={m.icon} tone={m.tone} pillar={pillars[m.key]} />
          ))}
        </div>
      </div>

      {ai && (
        <div>
          <SectionHead title="Context" hint="Informational, not folded into the Composite Score above" />
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {ai.peerComparison && (
              <StatChip label="Peer standing" value={`${ordinal(ai.peerComparison.percentile)} percentile`} hint={`among ${ai.peerComparison.peerCount} peers`} why={ai.why?.peerComparison} />
            )}
            <StatChip label="Performance trend" pill={{ tone: trendTone, text: ai.perfTrend }} why={ai.why?.perfTrend} />
            {attendanceDelta !== null && (
              <StatChip
                label="Attendance trend"
                pill={{ tone: attendanceTone, text: `${attendanceDelta > 0 ? "+" : ""}${attendanceDelta} pts` }}
                why={ai.why?.attendanceTrendDelta}
              />
            )}
            {ai.skillGrowthRatePct !== null && (
              <StatChip label="Skill growth" value={`${ai.skillGrowthRatePct}%`} hint="of skills acquired in the past year" why={ai.why?.skillGrowthRatePct} />
            )}
            <StatChip label="Workload" pill={{ tone: workloadTone, text: ai.workloadTrend }} hint={`${ai.workloadPctOfCapacity}% of capacity (AMC cadre-wide norm)`} why={ai.why?.workloadTrend} />
            {!isEmployeeView && <StatChip label="Retention risk" pill={{ tone: retentionTone, text: ai.retentionRisk }} why={ai.why?.retentionRisk} />}
          </div>
        </div>
      )}
    </div>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function StatChip({
  label, value, hint, pill, why,
}: { label: string; value?: string; hint?: string; pill?: { tone: "success" | "warning" | "destructive" | "neutral"; text: string }; why?: string }) {
  return (
    <div className={cn(
      "rounded-lg p-2.5 bg-surface",
      pill?.tone === "success" ? "border-2 border-success/40"
        : pill?.tone === "warning" ? "border-2 border-warning/50"
        : pill?.tone === "destructive" ? "border-2 border-destructive/40"
        : "border border-border",
    )}>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">{label}</div>
      {pill ? (
        <Pill tone={pill.tone}>{pill.text}</Pill>
      ) : (
        <div className="text-xs font-semibold">{value}</div>
      )}
      {hint && <div className="text-[10px] text-muted-foreground mt-1">{hint}</div>}
      {why && <div className="text-[11px] text-muted-foreground italic mt-1">Why: {why}</div>}
    </div>
  );
}

function PerformanceModule({ e, isEmployeeView = false }: { e: EmployeeDetail; isEmployeeView?: boolean }) {
  const perf = e.performanceRecords as { rating: number; attritionRiskScore: number; year: number }[] | undefined;

  if (!perf || perf.length === 0) {
    return <div className="p-6 text-center text-xs text-muted-foreground">No performance records found.</div>;
  }

  const latest = perf[perf.length - 1];
  const avgRating = perf.reduce((s, p) => s + p.rating, 0) / perf.length;
  const trendValues = perf.map((p) => Math.round((p.rating / 5) * 100));

  return (
    <div className="space-y-4">
      {e.insights?.explanations?.performance && <ScoreExplanation text={e.insights.explanations.performance} />}
      <div className="grid grid-cols-3 gap-2">
        {[
          { l: "Latest Rating", v: `${latest.rating}/5` },
          { l: "Avg Rating", v: avgRating.toFixed(1) },
          { l: "Years Tracked", v: String(perf.length) },
        ].map((s) => (
          <div key={s.l} className="rounded-lg border border-border bg-surface p-2 text-center">
            <div className="text-[10px] uppercase text-muted-foreground">{s.l}</div>
            <div className="text-lg font-semibold">{s.v}</div>
          </div>
        ))}
      </div>
      <div>
        <SectionHead title={`Performance trend (${perf[0].year}–${latest.year})`} />
        <Sparkline values={trendValues} />
      </div>
      {!isEmployeeView && (
        <Pill tone="success"><TrendingUp className="size-3" /> Attrition risk (latest): {Math.round(latest.attritionRiskScore)}%</Pill>
      )}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 240, h = 60, max = Math.max(...values), min = Math.min(...values);
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / (max - min || 1)) * h;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-16">
      <polyline points={pts} fill="none" stroke="var(--color-primary)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <polyline points={`0,${h} ${pts} ${w},${h}`} fill="var(--color-primary)" opacity="0.1" />
    </svg>
  );
}

function TasksModule({ e }: { e: EmployeeDetail }) {
  const tasks = (e.tasks ?? []) as { id: string; title: string; slaStatus: string; priority: string; status: string; tatDays: number }[];

  if (tasks.length === 0) {
    return <div className="p-6 text-center text-xs text-muted-foreground">No tasks assigned.</div>;
  }

  const open = tasks.filter((t) => t.status !== "Completed");
  const done = tasks.filter((t) => t.status === "Completed");
  const avgTat = tasks.length ? (tasks.reduce((s, t) => s + (t.tatDays || 0), 0) / tasks.length).toFixed(1) : "0";

  return (
    <div className="space-y-3">
      {e.insights?.explanations?.tasks && <ScoreExplanation text={e.insights.explanations.tasks} />}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-md border border-border p-2"><div className="text-[10px] uppercase text-muted-foreground">Open</div><div className="text-lg font-semibold">{open.length}</div></div>
        <div className="rounded-md border border-border p-2"><div className="text-[10px] uppercase text-muted-foreground">Completed</div><div className="text-lg font-semibold">{done.length}</div></div>
        <div className="rounded-md border border-border p-2"><div className="text-[10px] uppercase text-muted-foreground">Avg TAT</div><div className="text-lg font-semibold">{avgTat}d</div></div>
      </div>
      <div>
        <SectionHead title="Task history" />
        <div className="space-y-1.5">
          {tasks.map((t) => (
            <div key={t.id} className="flex items-center gap-2 rounded-md border border-border p-2 text-xs">
              <CheckSquare className="size-3.5 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{t.title}</div>
                <div className="text-[10px] text-muted-foreground">{t.id} · {t.priority} · {t.status}</div>
              </div>
              <Pill tone={t.slaStatus === "Breached" ? "destructive" : t.slaStatus === "At Risk" ? "warning" : "success"}>{t.slaStatus}</Pill>
            </div>
          ))}
        </div>
      </div>
      <Link to="/tasks" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
        Open in Task Management <ArrowUpRight className="size-3" />
      </Link>
    </div>
  );
}

function AttendanceModule({ e }: { e: EmployeeDetail }) {
  const attendance = e.attendance as { presentDays: number; totalDays: number; month: string }[] | undefined;

  const { data: balancesResp } = useQuery({
    queryKey: ["leave-balances", e.id],
    queryFn: () => coreApi.getLeaveBalances(e.id),
  });
  const { data: requestsResp } = useQuery({
    queryKey: ["leave-requests", "employee", e.id],
    queryFn: () => coreApi.getLeaveRequests({ employeeId: e.id }),
  });
  const balances = balancesResp?.data ?? [];
  const requests = (requestsResp?.data ?? []) as { id: string; leaveType: string; fromDate: string; toDate: string; days: number; status: string }[];

  if (!attendance || attendance.length === 0) {
    return <div className="p-6 text-center text-xs text-muted-foreground">No attendance records found.</div>;
  }

  const latest = attendance[0];
  const latestPct = latest.totalDays > 0 ? Math.round((latest.presentDays / latest.totalDays) * 100) : 0;
  const avgPct = Math.round(
    attendance.reduce((s, a) => s + (a.totalDays > 0 ? a.presentDays / a.totalDays : 0), 0) / attendance.length * 100
  );

  // Connects attendance to Leave Management: how much of this year's
  // non-attendance is accounted for by approved leave, vs. unexplained by
  // any leave record on file — a factual split, not an inferred cause.
  const currentYear = new Date().getFullYear();
  const totalAbsentDays = attendance
    .filter((a) => Number(a.month.slice(0, 4)) === currentYear)
    .reduce((s, a) => s + Math.max(0, a.totalDays - a.presentDays), 0);
  const approvedLeaveDaysThisYear = requests
    .filter((r) => r.status === "Approved" && new Date(`${r.fromDate}T00:00:00`).getFullYear() === currentYear)
    .reduce((s, r) => s + r.days, 0);
  const coveredPct = totalAbsentDays > 0 ? Math.min(100, Math.round((approvedLeaveDaysThisYear / totalAbsentDays) * 100)) : null;

  return (
    <div className="space-y-4">
      {e.insights?.explanations?.attendance && <ScoreExplanation text={e.insights.explanations.attendance} />}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-md border border-border p-2"><div className="text-[10px] uppercase text-muted-foreground">Latest month</div><div className="text-lg font-semibold text-success">{latestPct}%</div></div>
        <div className="rounded-md border border-border p-2"><div className="text-[10px] uppercase text-muted-foreground">Avg attendance</div><div className="text-lg font-semibold">{avgPct}%</div></div>
        <div className="rounded-md border border-border p-2"><div className="text-[10px] uppercase text-muted-foreground">Months tracked</div><div className="text-lg font-semibold">{attendance.length}</div></div>
      </div>
      <div>
        <SectionHead title="Monthly attendance" />
        <div className="space-y-2">
          {attendance.map((a) => {
            const pct = a.totalDays > 0 ? Math.round((a.presentDays / a.totalDays) * 100) : 0;
            return (
              <Bar
                key={a.month}
                label={`${a.month} (${a.presentDays}/${a.totalDays})`}
                value={pct}
                tone={pct >= 90 ? "success" : pct >= 75 ? "warning" : "destructive"}
              />
            );
          })}
        </div>
      </div>
      <div>
        <SectionHead title="Leave" hint="Connected from Leave Management" />
        {balances.length === 0 && requests.length === 0 ? (
          <div className="text-xs text-muted-foreground py-2">No leave data on file for this employee.</div>
        ) : (
          <>
            {balances.length > 0 && (
              <div className="space-y-2 mb-3">
                {balances.map((b) => (
                  <Bar
                    key={b.id}
                    label={`${b.leaveType} (${b.availed}/${b.entitled} availed)`}
                    value={b.entitled > 0 ? Math.round((b.availed / b.entitled) * 100) : 0}
                    tone={b.balance <= 2 ? "destructive" : "info"}
                  />
                ))}
              </div>
            )}
            {totalAbsentDays > 0 && (
              <div className="rounded-md border border-border p-2 mb-3">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-muted-foreground">Absences this year</span>
                  <span className="font-semibold tabular-nums">{totalAbsentDays}d</span>
                </div>
                <div className="h-1.5 rounded-full bg-surface-muted overflow-hidden flex">
                  <div className="h-full bg-success" style={{ width: `${coveredPct ?? 0}%` }} />
                  <div className="h-full bg-warning" style={{ width: `${100 - (coveredPct ?? 0)}%` }} />
                </div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  {approvedLeaveDaysThisYear}d covered by approved leave · {Math.max(0, totalAbsentDays - approvedLeaveDaysThisYear)}d other
                </div>
              </div>
            )}
            {requests.length > 0 && (
              <div className="space-y-1.5">
                {requests.slice(0, 5).map((r) => (
                  <div key={r.id} className="flex items-center justify-between text-xs bg-surface border border-border/60 rounded-md p-2">
                    <span>{r.leaveType} · {formatDate(r.fromDate)} → {formatDate(r.toDate)} ({r.days}d)</span>
                    <Pill tone={r.status === "Approved" ? "success" : r.status === "Rejected" ? "destructive" : "warning"}>{r.status}</Pill>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const PROFICIENCY_PCT: Record<string, number> = {
  beginner: 30, basic: 30,
  intermediate: 60,
  advanced: 85,
  expert: 97,
};

function proficiencyToPct(p: string) {
  return PROFICIENCY_PCT[p?.toLowerCase()] ?? 50;
}

function SkillsModule({ e }: { e: EmployeeDetail }) {
  const skills = e.skills as { name: string; proficiency: string }[] | undefined;

  if (!skills || skills.length === 0) {
    return <div className="p-6 text-center text-xs text-muted-foreground">No skills recorded.</div>;
  }

  return (
    <div className="space-y-4">
      {e.insights?.explanations?.skills && <ScoreExplanation text={e.insights.explanations.skills} />}
      <div>
        <SectionHead title="Competency matrix" />
        <div className="space-y-2">
          {skills.map((k) => {
            const v = proficiencyToPct(k.proficiency);
            return <Bar key={k.name} label={`${k.name} (${k.proficiency})`} value={v} tone={v < 60 ? "warning" : v < 80 ? "info" : "success"} />;
          })}
        </div>
      </div>
    </div>
  );
}

function TrainingModule({ e }: { e: EmployeeDetail }) {
  const records = e.trainingRecords as { title: string; category?: string; completionDate?: string | null; status: string }[] | undefined;

  if (!records || records.length === 0) {
    return <div className="p-6 text-center text-xs text-muted-foreground">No training records found.</div>;
  }

  const completed = records.filter((r) => r.status?.toLowerCase() === "completed").length;
  const pending = records.length - completed;

  const statusToPct = (status: string) => {
    const s = status?.toLowerCase();
    if (s === "completed") return 100;
    if (s === "in progress" || s === "in_progress") return 50;
    return 0;
  };

  return (
    <div className="space-y-3">
      {e.insights?.explanations?.training && <ScoreExplanation text={e.insights.explanations.training} />}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-md border border-border p-2"><div className="text-[10px] uppercase text-muted-foreground">Total</div><div className="text-lg font-semibold">{records.length}</div></div>
        <div className="rounded-md border border-border p-2"><div className="text-[10px] uppercase text-muted-foreground">Completed</div><div className="text-lg font-semibold">{completed}</div></div>
        <div className="rounded-md border border-border p-2"><div className="text-[10px] uppercase text-muted-foreground">Pending</div><div className="text-lg font-semibold text-warning-foreground">{pending}</div></div>
      </div>
      <div className="space-y-2">
        {records.map((c, i) => {
          const pct = statusToPct(c.status);
          return (
            <div key={i} className="rounded-md border border-border p-2">
              <div className="flex items-center gap-2 text-xs">
                <BookOpen className="size-3.5 text-primary" />
                <span className="flex-1 font-medium">{c.title}</span>
                {c.category && <Pill tone="info">{c.category}</Pill>}
              </div>
              <div className="mt-1.5"><Bar label={c.status} value={pct} tone={pct === 100 ? "success" : pct === 0 ? "warning" : "primary"} /></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CareerModule({ e }: { e: EmployeeDetail }) {
  const docs = (e.serviceBookDocs ?? []) as { id: string; type: string; date: string; description?: string | null }[];

  const appointment = docs.find((d) => d.type === "Appointment Order");
  const promotions = docs.filter((d) => d.type === "Promotion Order");
  const transfers = docs.filter((d) => d.type === "Transfer Order");

  const events = [
    ...(appointment ? [{ date: appointment.date, t: "Appointed", d: `${e.designation} · ${e.department}`, icon: Briefcase, tone: "info" }] : []),
    ...promotions.map((p) => ({ date: p.date, t: "Promotion", d: p.description || `→ ${e.cadre}`, icon: Award, tone: "success" as const })),
    ...transfers.map((t) => ({ date: t.date, t: "Transfer", d: t.description || `→ ${e.posting}`, icon: ArrowRightLeft, tone: "info" as const })),
  ].filter((ev) => ev.date && ev.date !== "—").sort((a, b) => a.date.localeCompare(b.date));

  const reg = e.insights?.regularisation;

  return (
    <div>
      {e.insights?.explanations?.career && <ScoreExplanation text={e.insights.explanations.career} />}
      {reg?.daysServed != null && (
        <div className="rounded-lg border border-border bg-surface p-3 mb-4">
          <div className="text-[10px] uppercase tracking-wider text-primary font-semibold mb-1.5">Regularisation Status (AMC 1982 policy)</div>
          <div className="text-xs">
            <span className="font-semibold tabular-nums">{reg.daysServed.toLocaleString("en-IN")}</span> day(s) of cumulative service.
            {reg.milestoneCrossed ? (
              <> Crossed the <span className="font-medium">{reg.milestoneCrossed}-day</span> regularisation milestone.</>
            ) : (
              <> Has not yet reached the 900-day regularisation milestone.</>
            )}
            {reg.nextMilestone && reg.daysToNextMilestone != null && (
              <> {reg.daysToNextMilestone} day(s) until the {reg.nextMilestone}-day milestone.</>
            )}
          </div>
        </div>
      )}
      {events.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground">No promotion or transfer history on record.</div>
      ) : (
      <ol className="relative border-l-2 border-border ml-2 space-y-4">
      {events.map((ev, i) => {
        const Icon = ev.icon;
        return (
          <li key={i} className="pl-5 relative">
            <span className={cn(
              "absolute -left-[11px] top-0 size-5 rounded-full grid place-items-center",
              ev.tone === "success" && "bg-success text-success-foreground",
              // Fixed dark-brown, not the theme-varying --warning-foreground token —
              // this text sits on the invariant bright-yellow --warning fill itself
              // (same color in both themes), not on a theme-varying card background.
              ev.tone === "warning" && "bg-warning text-[#4A3800]",
              ev.tone === "info" && "bg-info text-info-foreground",
              ev.tone === "primary" && "bg-primary text-primary-foreground",
            )}>
              <Icon className="size-3" />
            </span>
            <div className="text-sm font-medium"><span className="tabular-nums">{formatDate(ev.date)}</span> · {ev.t}</div>
            <div className="text-xs text-muted-foreground">{ev.d}</div>
          </li>
        );
      })}
      </ol>
      )}
    </div>
  );
}

function DocumentsModule({ e }: { e: EmployeeDetail }) {
  const docs = (e.serviceBookDocs ?? []) as { id: string; type: string; date: string; status: string; ocrScore: number }[];
  const cats = [...new Set(docs.map((d) => d.type))];

  return (
    <div className="space-y-3">
      {e.insights?.explanations?.documents && <ScoreExplanation text={e.insights.explanations.documents} />}
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5">
          <button className="h-7 px-2 rounded-full border border-border text-xs inline-flex items-center gap-1"><Plus className="size-3" /> Upload</button>
          <button className="h-7 px-2 rounded-full border border-border text-xs inline-flex items-center gap-1"><FileSearch className="size-3" /> OCR search</button>
          <button className="h-7 px-2 rounded-full border border-border text-xs inline-flex items-center gap-1"><Sparkles className="size-3" /> AI summary</button>
        </div>
      </div>
      {cats.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {cats.map((c) => (
            <span key={c} className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-surface-muted text-muted-foreground">{c}</span>
          ))}
        </div>
      )}
      {docs.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground">No documents on file.</div>
      ) : (
        <div className="space-y-1.5">
          {docs.map((d) => (
            <div key={d.id} className="flex items-center gap-2 rounded-md border border-border p-2 text-xs">
              <FileText className="size-3.5 text-primary" />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{d.type}</div>
                <div className="text-[10px] text-muted-foreground">{formatDate(d.date)} · OCR {d.ocrScore}%</div>
              </div>
              <Pill tone={d.status === "Verified" ? "success" : d.status === "Missing" ? "destructive" : "warning"}>{d.status}</Pill>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AssetsModule({ e }: { e: EmployeeDetail }) {
  const assets = (e.assets ?? []) as { id: string; type: string; description: string; assignedDate: string; status: string; serialNo?: string | null }[];

  if (assets.length === 0) {
    return <div className="p-6 text-center text-xs text-muted-foreground">No assets currently assigned.</div>;
  }

  return (
    <div className="grid grid-cols-1 gap-2">
      {assets.map((a) => (
        <div key={a.id} className="flex items-center gap-2 rounded-md border border-border p-2 text-xs">
          <Laptop className="size-3.5 text-primary" />
          <div className="flex-1 min-w-0">
            <div className="font-medium">{a.type}{a.serialNo ? ` · ${a.serialNo}` : ""}</div>
            <div className="text-[10px] text-muted-foreground">Assigned {formatDate(a.assignedDate)}</div>
          </div>
          <Pill tone={a.status === "Assigned" ? "success" : a.status === "Lost" ? "destructive" : "warning"}>{a.status}</Pill>
        </div>
      ))}
    </div>
  );
}

function fmtInr(n: number | undefined | null) {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return `₹ ${Math.round(n).toLocaleString("en-IN")}`;
}

function CompensationModule({ e }: { e: EmployeeDetail }) {
  const c = e.compensation;
  if (!c) {
    return <div className="p-6 text-center text-xs text-muted-foreground">No compensation record found.</div>;
  }
  return (
    <div className="space-y-4">
      {e.insights?.explanations?.compensation && <ScoreExplanation text={e.insights.explanations.compensation} />}
      <div className="rounded-lg border border-border bg-surface-muted/40 p-3">
        <div className="text-[10px] uppercase text-muted-foreground">Gross monthly (CTC)</div>
        <div className="text-2xl font-semibold tabular-nums">{fmtInr(c.grossPay)}</div>
        <div className="text-[11px] text-muted-foreground">{c.payGrade || "—"}</div>
      </div>
      <div className="space-y-1.5 text-xs">
        {[
          ["Basic Pay", fmtInr(c.basicPay)],
          [`DA (${c.daPercent ?? "—"}%)`, fmtInr(c.daAmount)],
          [`HRA (${c.hraPercent ?? "—"}%)`, fmtInr(c.hraAmount)],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between border-b border-border py-1.5">
            <span className="text-muted-foreground">{k}</span><span className="tabular-nums">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityModule({ e }: { e: EmployeeDetail }) {
  const awards = (e.awards ?? []) as { id: string; title: string; category?: string; date: string; description?: string | null; awardedBy?: string | null; isPublic: boolean }[];
  const lifeEvents = (e.lifeEvents ?? []) as { id: string; title: string; category?: string; date: string; description?: string | null }[];

  const combined = [
    ...awards.map((a) => ({ ...a, kind: "Award" as const, icon: Award, tone: "warning" as const })),
    ...lifeEvents.map((l) => ({ ...l, kind: "LifeEvent" as const, icon: Heart, tone: "info" as const })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  if (combined.length === 0) {
    return <div className="p-6 text-center text-xs text-muted-foreground">No awards or life events on record.</div>;
  }

  return (
    <div>
      {e.insights?.explanations?.activity && <ScoreExplanation text={e.insights.explanations.activity} />}
      <ol className="space-y-2">
      {combined.map((ev) => {
        const Icon = ev.icon;
        return (
          <li key={ev.id} className="flex gap-2 rounded-lg bg-surface-muted p-2 text-xs">
            <div className={cn(
              "size-7 rounded-full bg-card grid place-items-center shrink-0",
              ev.tone === "warning" && "text-warning-foreground",
              ev.tone === "info" && "text-info",
            )}>
              <Icon className="size-3.5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium flex items-center gap-1.5">
                {ev.title}
                {ev.kind === "Award" && ev.isPublic && <Pill tone="success">Public</Pill>}
              </div>
              <div className="text-[10px] text-muted-foreground">{ev.category ? `${ev.category} · ` : ""}{formatDate(ev.date)}</div>
            </div>
          </li>
        );
      })}
      </ol>
    </div>
  );
}

const PERK_TYPES = ["Special Increment", "Letter of Appreciation", "Out-of-Turn Promotion Recommendation", "Priority Posting Preference", "Cash Award", "Nomination for Training Program", "Other"];

// High Potential panel — available for every employee so HR can manually
// flag someone the AI hasn't caught, not just a read-only badge for
// AI-flagged employees. Self-view stays read-only and only reachable once
// actually flagged (see showHpButton above).
function HighPotentialOverlay({ employee: e, isEmployeeView = false, open, onClose }: {
  employee: EmployeeDetail; isEmployeeView?: boolean; open: boolean; onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const hp = e.insights?.highPotential;
  const [perkType, setPerkType] = useState(PERK_TYPES[0]);
  const [customLabel, setCustomLabel] = useState("");
  const [perkNote, setPerkNote] = useState("");
  const [perkError, setPerkError] = useState<string | null>(null);

  const { data: perksResp } = useQuery({
    queryKey: ["employee-perks", e.id],
    queryFn: () => coreApi.getEmployeePerks(e.id),
    enabled: open,
  });
  const perks = perksResp?.data ?? [];

  const { data: hpDetail } = useQuery({
    queryKey: ["employee-hp-detail", e.id],
    queryFn: () => coreApi.getHpDetail(e.id),
    enabled: open,
  });

  const grantPerk = useMutation({
    mutationFn: () => coreApi.grantPerk(e.id, { type: perkType, customLabel: perkType === "Other" ? customLabel : undefined, note: perkNote || undefined }),
    onSuccess: () => {
      setPerkError(null); setCustomLabel(""); setPerkNote("");
      queryClient.invalidateQueries({ queryKey: ["employee-perks", e.id] });
    },
    onError: (err) => setPerkError(err instanceof ApiError ? err.message : "Could not grant perk"),
  });

  const setOverride = useMutation({
    mutationFn: (flagged: boolean | null) => coreApi.setHighPotentialOverride(e.id, flagged),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["employee", e.id] }),
  });

  const peer = hpDetail?.peerComparison;
  const trend = hpDetail?.trend ?? [];
  const isOpen = open;

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px] transition-opacity duration-300",
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sliding panel */}
      <div
        className={cn(
          "fixed top-0 right-0 bottom-0 z-50 w-full sm:w-[480px] bg-card border-l border-border shadow-2xl flex flex-col transition-transform duration-300 ease-in-out",
          isOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border bg-card flex items-center gap-3">
          <div className="size-9 rounded-full bg-primary text-primary-foreground grid place-items-center shrink-0">
            <Trophy className="size-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">{hp.flagged ? "Flagged High Potential" : "High Potential"}</div>
            <div className="text-[10px] text-muted-foreground">Score {hp.score}/100</div>
          </div>
          <button
            onClick={onClose}
            className="size-8 grid place-items-center rounded-full hover:bg-surface-muted transition-colors shrink-0"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 p-4 overflow-y-auto scrollbar-thin space-y-4">
          <div className="text-[10px] text-muted-foreground">Combines the AI-computed score below with an optional HR override — HR can force this employee into or out of High Potential either direction, regardless of what the AI score says.</div>

          {!isEmployeeView && (
            <div className={cn(
              "space-y-2 p-2.5 rounded-lg border",
              hp.hasOverride ? (hp.overrideValue ? "border-primary/30 bg-primary-soft" : "border-destructive/30 bg-destructive/5") : "border-border bg-surface-muted/40",
            )}>
              <div className="text-xs">
                {hp.hasOverride ? (
                  hp.overrideValue
                    ? <>HR override: <span className="font-semibold">forced in</span>{hp.overrideBy ? ` by ${hp.overrideBy}` : ""} — AI read {hp.aiFlagged ? "agrees" : "would say no"}</>
                    : <>HR override: <span className="font-semibold">forced out</span>{hp.overrideBy ? ` by ${hp.overrideBy}` : ""} — AI read {hp.aiFlagged ? "flagged this employee" : "agrees"}</>
                ) : (
                  <>No HR override — following the AI read ({hp.aiFlagged ? "flagged" : "not flagged"})</>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setOverride.mutate(true)}
                  disabled={setOverride.isPending || (hp.hasOverride && hp.overrideValue === true)}
                  className={cn(
                    "h-7 px-2.5 rounded-full text-xs font-medium disabled:opacity-50 border",
                    hp.hasOverride && hp.overrideValue === true
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card hover:bg-surface-muted",
                  )}
                >
                  Force In
                </button>
                <button
                  onClick={() => setOverride.mutate(false)}
                  disabled={setOverride.isPending || (hp.hasOverride && hp.overrideValue === false)}
                  className={cn(
                    "h-7 px-2.5 rounded-full text-xs font-medium disabled:opacity-50 border",
                    hp.hasOverride && hp.overrideValue === false
                      ? "border-destructive bg-destructive text-destructive-foreground"
                      : "border-border bg-card hover:bg-surface-muted",
                  )}
                >
                  Force Out
                </button>
                {hp.hasOverride && (
                  <button
                    onClick={() => setOverride.mutate(null)}
                    disabled={setOverride.isPending}
                    className="h-7 px-2.5 rounded-full text-xs font-medium border border-border bg-card hover:bg-surface-muted disabled:opacity-50"
                  >
                    Clear override
                  </button>
                )}
              </div>
            </div>
          )}

          <ul className="space-y-1">
            {hp.reasons.map((r: string, i: number) => (
              <li key={i} className="text-xs flex gap-1.5"><Sparkles className="size-3 text-primary shrink-0 mt-0.5" /> {r}</li>
            ))}
          </ul>

          <div className="space-y-4 pt-3 border-t border-border">
            <div>
              <SectionHead title="Score trend" hint="Performance-driven, other inputs held at current value" />
              {trend.length < 2 ? (
                <div className="text-xs text-muted-foreground py-2">Not enough performance history yet to show a trend.</div>
              ) : (
                <Sparkline values={trend.map((t) => t.score)} />
              )}
            </div>
            <div>
              <SectionHead title="Peer comparison" />
              {!peer || peer.peerCount === 0 ? (
                <div className="text-xs text-muted-foreground py-2">No peers in the same cadre/department to compare against.</div>
              ) : (
                <div className="space-y-2">
                  <div className="text-xs">
                    Top <span className="font-semibold">{100 - (peer.percentile ?? 0)}%</span> among <span className="font-semibold">{peer.peerCount}</span> peers in {peer.cadre} · {peer.department}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="w-16 shrink-0">This score</span>
                    <div className="h-1.5 flex-1 rounded-full bg-surface-muted overflow-hidden"><div className="h-full bg-primary rounded-full" style={{ width: `${hp.score}%` }} /></div>
                    <span className="tabular-nums w-7 text-right">{hp.score}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="w-16 shrink-0">Peer avg</span>
                    <div className="h-1.5 flex-1 rounded-full bg-surface-muted overflow-hidden"><div className="h-full bg-muted-foreground/50 rounded-full" style={{ width: `${peer.peerAvgScore ?? 0}%` }} /></div>
                    <span className="tabular-nums w-7 text-right">{peer.peerAvgScore}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="pt-3 border-t border-border">
            <SectionHead title="Perks granted" hint="Government service incentives, recorded against this officer's file" />
            {perks.length === 0 ? (
              <div className="text-xs text-muted-foreground py-2">No perks granted yet.</div>
            ) : (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {perks.map((p) => (
                  <span key={p.id} className="inline-flex items-center gap-1.5 text-xs bg-surface border border-border/60 rounded-full pl-2.5 pr-1 py-1">
                    <span className="font-medium">{p.type === "Other" ? p.customLabel : p.type}{p.note ? ` — ${p.note}` : ""}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0 bg-surface-muted rounded-full px-1.5 py-0.5">{new Date(p.grantedAt).toLocaleDateString("en-IN")}</span>
                  </span>
                ))}
              </div>
            )}
            {!isEmployeeView && (
              <>
                {perkError && <div className="text-xs text-destructive mb-2">{perkError}</div>}
                <div className="flex flex-wrap gap-1.5 items-center">
                  <FilterPill value={perkType} onChange={setPerkType} options={PERK_TYPES} label={PERK_TYPES[0]} size="compact" />
                  {perkType === "Other" && (
                    <input value={customLabel} onChange={(ev) => setCustomLabel(ev.target.value)} placeholder="Custom perk"
                      className="h-8 px-3 rounded-full bg-card border border-border text-xs w-32" />
                  )}
                  <input value={perkNote} onChange={(ev) => setPerkNote(ev.target.value)} placeholder="Note (optional)"
                    className="h-8 px-3 rounded-full bg-card border border-border text-xs flex-1 min-w-[120px]" />
                  <button
                    onClick={() => grantPerk.mutate()}
                    disabled={grantPerk.isPending || (perkType === "Other" && !customLabel.trim())}
                    className="h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-medium hover:opacity-95 disabled:opacity-50"
                  >
                    Grant Perk
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ============ Copilot ============
function CopilotPanel({
  employee: e, onClose,
}: { employee: EmployeeDetail; onClose: () => void }) {
  const [messages, setMessages] = useState<{ role: "user" | "ai"; text: string }[]>([
    { role: "ai", text: `Hi — I'm your AWIP Copilot for ${e.name}. Ask me about performance, promotion readiness, transfers, training, or generate an appraisal summary.` },
  ]);
  const [input, setInput] = useState("");

  const suggestions = [
    "Summarise last 12 months",
    "Why is this employee promotion-ready?",
    "Compare with similar employees",
    "Best next assignment?",
    "Suggest a replacement if transferred",
    "Predict retirement impact",
    "Identify skill gaps",
    "Recommend training",
    "Generate appraisal summary",
  ];

  const ask = (q: string) => {
    const reply = mockAnswer(q, e.name);
    setMessages((m) => [...m, { role: "user", text: q }, { role: "ai", text: reply }]);
    setInput("");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/30 backdrop-blur-sm">
      <div className="w-full sm:w-[440px] bg-card border-l border-border flex flex-col animate-in slide-in-from-right duration-200">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2 bg-gradient-to-r from-primary to-primary/80 text-primary-foreground">
          <div className="size-8 rounded-md bg-white/15 grid place-items-center"><Bot className="size-4" /></div>
          <div className="flex-1">
            <div className="text-sm font-semibold">AWIP Copilot</div>
            <div className="text-[11px] opacity-80">Context: {e.name} · {e.id}</div>
          </div>
          <button onClick={onClose} className="size-8 grid place-items-center rounded-md hover:bg-white/10"><X className="size-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((m, i) => (
            <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div className={cn(
                "max-w-[80%] rounded-2xl px-3 py-2 text-xs leading-relaxed",
                m.role === "user" ? "bg-primary text-primary-foreground" : "bg-surface-muted border border-border",
              )}>
                {m.text}
              </div>
            </div>
          ))}
        </div>

        <div className="px-3 py-2 border-t border-border">
          <div className="flex gap-1.5 overflow-x-auto pb-2 scrollbar-thin">
            {suggestions.map((s) => (
              <button key={s} onClick={() => ask(s)}
                className="shrink-0 text-[11px] px-2 py-1 rounded-full border border-border bg-surface hover:bg-accent">
                {s}
              </button>
            ))}
          </div>
          <form
            onSubmit={(ev) => { ev.preventDefault(); if (input.trim()) ask(input.trim()); }}
            className="flex items-center gap-2"
          >
            <input
              value={input}
              onChange={(ev) => setInput(ev.target.value)}
              placeholder="Ask AWIP..."
              className="flex-1 h-9 px-3 rounded-md bg-surface border border-border text-xs focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
            <button type="submit" className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs inline-flex items-center gap-1">
              <Send className="size-3.5" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function mockAnswer(q: string, name: string) {
  const lc = q.toLowerCase();
  if (lc.includes("summari")) return `${name} delivered 42 tasks this year with avg TAT 3.2d. KPI 87/100, citizen rating 4.5, attendance 94%. Strong field execution; 2 mandatory trainings pending.`;
  if (lc.includes("promotion")) return `Promotion-ready: KPI ≥ 85 for 4 consecutive quarters, tenure threshold met (>= 8y in grade), peer rating 4.6, no disciplinary record. AI confidence 76%.`;
  if (lc.includes("compare")) return `Among 38 peers at the same cadre and posting, ${name} ranks in the top quartile on KPI and citizen rating, median on training hours, and bottom quartile on absenteeism (low is good).`;
  if (lc.includes("assignment") || lc.includes("next")) return `Recommended next: Lead Vastrapur pre-monsoon drainage audit. Skill fit 0.91, geographic continuity, current workload allows.`;
  if (lc.includes("replace")) return `If transferred, candidates: AMC-10118 (fit 0.84), AMC-10231 (0.81), AMC-10056 (0.78). 14-day handover window recommended.`;
  if (lc.includes("retire")) return `Retires 2037-05. Knowledge-transfer risk: Medium. 3 cross-trained successors identified.`;
  if (lc.includes("gap")) return `Skill gaps vs Dy Commissioner profile: Public Procurement (-26), DPC Norms (-32). Strengths: Field Inspection (+12), RTI (+6).`;
  if (lc.includes("training")) return `Recommended: 1) Public Procurement Act (12h), 2) DPC & Service Rules (8h), 3) Leadership in Civic Admin (24h, cohort starts Aug).`;
  if (lc.includes("appraisal")) return `Draft APR: "${name} has delivered against all 5 KPIs, exceeding 3 of them. Demonstrates initiative in field operations. Recommended overall rating: A (Outstanding)."`;
  return `Based on the digital twin, ${name} is performing above departmental median with a stable trajectory. Ask about promotion, training, transfers, or generate an appraisal.`;
}
