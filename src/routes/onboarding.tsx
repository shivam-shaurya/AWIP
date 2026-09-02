import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Users, PlayCircle, CheckCircle2, Circle, X, Loader2, FileCheck2, Laptop2, GraduationCap, UserCog, ShieldCheck } from "lucide-react";
import { Panel, Pill, Section } from "@/components/layout/section";
import { Pager } from "@/components/ui/pager";
import { FilterPill } from "@/components/ui/filter-pill";
import { SearchPill } from "@/components/ui/search-pill";
import { useDepartment } from "@/context/department-context";
import { coreApi } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/onboarding")({
  head: () => ({ meta: [{ title: "Onboarding · AWIP" }] }),
  component: OnboardingPage,
});

const CASE_STATUSES = ["NotStarted", "InProgress", "Completed"] as const;
const CASE_STATUS_LABEL: Record<string, string> = {
  NotStarted: "Not Started",
  InProgress: "In Progress",
  Completed: "Completed",
};

function caseStatusTone(status: string): "success" | "warning" | "neutral" {
  if (status === "Completed") return "success";
  if (status === "InProgress") return "warning";
  return "neutral";
}

const PAGE_SIZE = 10;

const TASK_STATUS_FLOW: Record<string, string | undefined> = {
  Pending: "InProgress",
  InProgress: "Completed",
};

const CATEGORY_ICON: Record<string, React.ReactNode> = {
  Documentation: <FileCheck2 className="size-3.5" />,
  Orientation: <GraduationCap className="size-3.5" />,
  "IT/Asset Provisioning": <Laptop2 className="size-3.5" />,
  "Buddy Assignment": <UserCog className="size-3.5" />,
  Compliance: <ShieldCheck className="size-3.5" />,
};

function OnboardingPage() {
  const { department } = useDepartment();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const deptParam = department === "All Departments" ? undefined : department;
  const statusParam = statusFilter === "All" ? undefined : statusFilter;

  const { data: summaryResp } = useQuery({
    queryKey: ["onboarding-summary"],
    queryFn: () => coreApi.getOnboardingSummary(),
  });
  const summary = summaryResp ?? { totalCases: 0, notStarted: 0, inProgress: 0, completed: 0 };

  const { data: casesResp, isLoading } = useQuery({
    queryKey: ["onboarding-cases", deptParam, statusParam],
    queryFn: () => coreApi.getOnboardingCases({ department: deptParam, status: statusParam }),
  });
  const cases = casesResp?.data ?? [];

  const filtered = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return cases;
    return cases.filter((c: any) =>
      c.name.toLowerCase().includes(q) || (c.designation ?? "").toLowerCase().includes(q) || (c.department ?? "").toLowerCase().includes(q),
    );
  }, [cases, searchTerm]);

  useEffect(() => setPage(1), [department, statusFilter, searchTerm]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="p-5 max-w-[1600px] mx-auto space-y-6 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <ClipboardCheck className="size-6 text-primary" />
            Onboarding
          </h1>
          <p className="text-sm text-muted-foreground mt-1">New-hire onboarding checklists, buddy assignments and progress tracking.</p>
        </div>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiTile icon={<Users className="size-4 text-primary" />} label="Total Cases" value={summary.totalCases} />
        <KpiTile icon={<Circle className="size-4 text-muted-foreground" />} label="Not Started" value={summary.notStarted} />
        <KpiTile icon={<PlayCircle className="size-4 text-warning-foreground" />} label="In Progress" value={summary.inProgress} />
        <KpiTile icon={<CheckCircle2 className="size-4 text-success" />} label="Completed" value={summary.completed} />
      </div>

      {/* Case list */}
      <Section
        title="Onboarding Cases"
        subtitle="Track new hires from day zero through checklist completion"
        action={
          <div className="flex items-center gap-2">
            <FilterPill
              value={statusFilter}
              onChange={setStatusFilter}
              options={[{ value: "All", label: "All Statuses" }, ...CASE_STATUSES.map((s) => ({ value: s, label: CASE_STATUS_LABEL[s] }))]}
              label="All Statuses"
              size="compact"
            />
            <SearchPill value={searchTerm} onChange={setSearchTerm} placeholder="Search new hires…" size="compact" className="w-64" />
          </div>
        }
      >
        <Panel padded={false} className="border-border shadow-sm">
          <div className="overflow-x-auto overflow-y-hidden scrollbar-thin rounded-t-xl">
            <table className="w-full text-sm">
              <thead className="bg-sidebar text-[10px] uppercase tracking-wider text-sidebar-foreground">
                <tr>
                  <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">New Hire</th>
                  <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Department / Designation</th>
                  <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Start Date</th>
                  <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Buddy</th>
                  <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Status</th>
                  <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Progress</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading ? (
                  <tr><td colSpan={6} className="px-4 py-12 text-center text-muted-foreground"><Loader2 className="size-5 animate-spin inline" /></td></tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <Users className="size-8 opacity-20" />
                        <p>No onboarding cases found for this scope.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  visible.map((c: any, i: number) => (
                    <tr
                      key={c.id}
                      onClick={() => setSelectedId(c.id)}
                      className={cn("hover:bg-surface-muted/70 transition-colors cursor-pointer group", i % 2 === 1 && "bg-surface-muted")}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground group-hover:text-primary transition-colors">{c.name}</div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        <div className="text-foreground/90">{c.department}</div>
                        <div className="text-xs">{c.designation}</div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                        {c.startDate ? new Date(c.startDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{c.buddyName ?? "—"}</td>
                      <td className="px-4 py-3">
                        <Pill tone={caseStatusTone(c.status)}>{CASE_STATUS_LABEL[c.status] ?? c.status}</Pill>
                      </td>
                      <td className="px-4 py-3 min-w-[140px]">
                        <div className="flex items-center gap-2">
                          <div className="w-20 h-1.5 bg-surface-muted rounded-full overflow-hidden">
                            <div
                              className={cn("h-full transition-all", c.progressPct >= 100 ? "bg-success" : c.progressPct >= 40 ? "bg-warning" : "bg-primary")}
                              style={{ width: `${c.progressPct ?? 0}%` }}
                            />
                          </div>
                          <span className="text-xs font-bold tabular-nums">{c.progressPct ?? 0}%</span>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && <Pager page={page} totalPages={totalPages} onChange={setPage} />}
        </Panel>
      </Section>

      {selectedId && <OnboardingCaseDrawer caseId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function KpiTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="bg-card rounded-xl border border-border p-4 shadow-sm flex items-center gap-3">
      <div className="size-10 rounded-full bg-primary/10 grid place-items-center shrink-0">{icon}</div>
      <div>
        <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
        <div className="text-2xl font-semibold tracking-tight text-foreground leading-tight tabular-nums">{value}</div>
      </div>
    </div>
  );
}

function OnboardingCaseDrawer({ caseId, onClose }: { caseId: string; onClose: () => void }) {
  const queryClient = useQueryClient();

  const { data: onboardingCase, isLoading } = useQuery({
    queryKey: ["onboarding-case", caseId],
    queryFn: () => coreApi.getOnboardingCaseDetail(caseId),
  });

  const advanceTask = useMutation({
    mutationFn: ({ taskId, status }: { taskId: string; status: string }) => coreApi.updateOnboardingTaskStatus(taskId, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["onboarding-cases"] });
      queryClient.invalidateQueries({ queryKey: ["onboarding-summary"] });
      queryClient.invalidateQueries({ queryKey: ["onboarding-case", caseId] });
    },
  });

  const tasks = onboardingCase?.tasks ?? [];
  const grouped = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const t of tasks) {
      const key = t.category ?? "Other";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return Array.from(map.entries());
  }, [tasks]);

  return (
    <>
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 w-full sm:w-[460px] bg-card border-l border-border shadow-2xl z-50 p-6 flex flex-col overflow-y-auto scrollbar-thin animate-in slide-in-from-right duration-300">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-lg">{onboardingCase?.name ?? "Onboarding Case"}</h2>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-surface-muted"><X className="size-5" /></button>
        </div>

        {isLoading || !onboardingCase ? (
          <div className="flex-1 grid place-items-center text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
        ) : (
          <>
            <div className="space-y-1.5 mb-4">
              <div className="text-sm text-muted-foreground">{onboardingCase.designation} · {onboardingCase.department}</div>
              <div className="flex items-center gap-2 flex-wrap">
                <Pill tone={caseStatusTone(onboardingCase.status)}>{CASE_STATUS_LABEL[onboardingCase.status] ?? onboardingCase.status}</Pill>
                {onboardingCase.buddyName && <Pill tone="neutral">Buddy: {onboardingCase.buddyName}</Pill>}
              </div>
            </div>

            <div className="mb-6">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-foreground font-medium">Overall progress</span>
                <span className="font-bold tabular-nums">{onboardingCase.progressPct ?? 0}%</span>
              </div>
              <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
                <div
                  className={cn("h-full transition-all", (onboardingCase.progressPct ?? 0) >= 100 ? "bg-success" : "bg-primary")}
                  style={{ width: `${onboardingCase.progressPct ?? 0}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-6 text-xs">
              <div className="bg-surface-muted/40 rounded-md p-2.5">
                <div className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Start Date</div>
                <div>{onboardingCase.startDate ? new Date(onboardingCase.startDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—"}</div>
              </div>
              <div className="bg-surface-muted/40 rounded-md p-2.5">
                <div className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Employee ID</div>
                <div>{onboardingCase.employeeId ?? "—"}</div>
              </div>
            </div>

            <div className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mb-2">Checklist</div>
            <div className="space-y-4">
              {grouped.length === 0 ? (
                <div className="text-xs text-muted-foreground">No tasks on file for this case.</div>
              ) : (
                grouped.map(([category, categoryTasks]) => (
                  <div key={category}>
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground/80 mb-2">
                      {CATEGORY_ICON[category] ?? <Circle className="size-3.5" />}
                      {category}
                    </div>
                    <div className="space-y-2">
                      {categoryTasks.map((t: any) => {
                        const next = TASK_STATUS_FLOW[t.status];
                        const isDone = t.status === "Completed";
                        const isBlocked = t.status === "Blocked";
                        return (
                          <div key={t.id} className="text-xs bg-surface border border-border rounded-md p-2.5 flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className={cn("font-medium", isDone && "line-through text-muted-foreground")}>{t.title}</div>
                              <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5">
                                <Pill tone={isDone ? "success" : isBlocked ? "destructive" : t.status === "InProgress" ? "warning" : "neutral"}>{t.status}</Pill>
                                {t.assignedTo && <span>· {t.assignedTo}</span>}
                                {t.dueDate && <span>· due {new Date(t.dueDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</span>}
                              </div>
                            </div>
                            {next && (
                              <button
                                onClick={() => advanceTask.mutate({ taskId: t.id, status: next })}
                                disabled={advanceTask.isPending}
                                className="shrink-0 h-7 px-2 rounded-md bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground border border-primary/20 text-[10px] font-bold transition-colors disabled:opacity-50"
                              >
                                Mark {next === "Completed" ? "Done" : "In Progress"}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
