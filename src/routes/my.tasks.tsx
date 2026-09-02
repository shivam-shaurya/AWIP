import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2, ListChecks, TrendingUp, TrendingDown, CheckCircle2 } from "lucide-react";
import { Panel, Pill } from "@/components/layout/section";
import { coreApi } from "@/lib/api-client";
import { useAuth } from "@/context/auth-context";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/my/tasks")({
  head: () => ({ meta: [{ title: "My Tasks · AWIP" }] }),
  component: MyTasksPage,
});

type MyTask = {
  id: string; project: string; title: string; priority: string; status: string; slaStatus: string;
  dueIn: number; tatDays: number; progressPct: number; createdAt: string; completedAt: string | null;
};

function slaTone(sla: string) {
  return sla === "Breached" ? "destructive" : sla === "At Risk" ? "warning" : "success";
}
function statusTone(status: string) {
  return status === "Completed" ? "success" : status === "Overdue" || status === "Escalated" ? "destructive" : "info";
}

// A real, computed pace comparison — not a canned message. For an open task,
// it compares actual progress against the progress you'd expect by now given
// the task's own target turnaround (tatDays). For a completed task, it
// compares the actual time taken against that same target.
function productivityInsight(t: MyTask) {
  const createdMs = new Date(t.createdAt).getTime();
  const tatDays = t.tatDays > 0 ? t.tatDays : 1;

  if (t.status === "Completed" && t.completedAt) {
    const takenDays = (new Date(t.completedAt).getTime() - createdMs) / 86400000;
    const varianceDays = Math.round(takenDays - tatDays);
    if (varianceDays <= -1) return { label: `Finished ${Math.abs(varianceDays)}d ahead of the ${tatDays}d target`, tone: "success" as const, Icon: TrendingUp };
    if (varianceDays >= 1) return { label: `Finished ${varianceDays}d past the ${tatDays}d target`, tone: "destructive" as const, Icon: TrendingDown };
    return { label: `Finished on target (${tatDays}d)`, tone: "success" as const, Icon: CheckCircle2 };
  }

  const elapsedDays = Math.max(0, (Date.now() - createdMs) / 86400000);
  const expectedPct = Math.min(100, Math.round((elapsedDays / tatDays) * 100));
  const paceDelta = t.progressPct - expectedPct;
  if (paceDelta >= 6) return { label: `Ahead of pace by ${paceDelta}pts (${t.progressPct}% done, ${expectedPct}% expected by now)`, tone: "success" as const, Icon: TrendingUp, expectedPct };
  if (paceDelta <= -6) return { label: `Behind pace by ${Math.abs(paceDelta)}pts (${t.progressPct}% done, ${expectedPct}% expected by now)`, tone: "destructive" as const, Icon: TrendingDown, expectedPct };
  return { label: `On pace (${t.progressPct}% done, ${expectedPct}% expected by now)`, tone: "success" as const, Icon: CheckCircle2, expectedPct };
}

function MyTasksPage() {
  const { user } = useAuth();
  const employeeId = user?.employeeId ?? "";

  const { data: e, isLoading, isError } = useQuery({
    queryKey: ["employee", employeeId],
    queryFn: () => coreApi.getEmployee(employeeId),
    enabled: !!employeeId,
  });

  const tasks = (e?.tasks ?? []) as MyTask[];

  return (
    <div className="min-h-full bg-gradient-to-br from-background via-background to-primary-soft/40 px-5 py-4 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 mb-4">
        <div className="size-9 rounded-lg bg-primary/10 text-primary grid place-items-center"><ListChecks className="size-4.5" /></div>
        <div>
          <div className="text-lg font-semibold tracking-tight">My Tasks</div>
          <div className="text-xs text-muted-foreground">Tasks assigned to you, with a pace comparison against each task's target turnaround</div>
        </div>
      </div>

      {isLoading ? (
        <div className="p-10 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading tasks…
        </div>
      ) : isError || !e ? (
        <Panel><div className="text-sm text-destructive text-center py-6">Could not load your tasks.</div></Panel>
      ) : tasks.length === 0 ? (
        <Panel><div className="text-sm text-muted-foreground text-center py-6">No tasks assigned to you right now.</div></Panel>
      ) : (
        <Panel padded={false} className="divide-y divide-border/60">
          {tasks.map((t) => {
            const insight = productivityInsight(t);
            const InsightIcon = insight.Icon;
            return (
              <div key={t.id} className="p-4 space-y-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{t.title}</div>
                    <div className="text-xs text-muted-foreground truncate">{t.project} · Priority: {t.priority} · Due in {t.dueIn}d</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Pill tone={slaTone(t.slaStatus)}>{t.slaStatus}</Pill>
                    <Pill tone={statusTone(t.status)}>{t.status}</Pill>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-xs">
                  <InsightIcon className={cn("size-3.5 shrink-0", insight.tone === "success" ? "text-success" : "text-destructive")} />
                  <span className={cn(insight.tone === "success" ? "text-success" : "text-destructive")}>{insight.label}</span>
                </div>

                {insight.expectedPct !== undefined && (
                  <div className="relative h-1.5 rounded-full bg-surface-muted overflow-hidden">
                    <div className="h-full bg-primary rounded-full" style={{ width: `${t.progressPct}%` }} />
                    <div className="absolute top-0 bottom-0 w-0.5 bg-foreground/50" style={{ left: `${insight.expectedPct}%` }} title="Expected progress by now" />
                  </div>
                )}
              </div>
            );
          })}
        </Panel>
      )}
    </div>
  );
}
