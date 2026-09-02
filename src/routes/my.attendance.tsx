import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Clock } from "lucide-react";
import { Section, Panel } from "@/components/layout/section";
import { coreApi } from "@/lib/api-client";
import { useAuth } from "@/context/auth-context";

export const Route = createFileRoute("/my/attendance")({
  head: () => ({ meta: [{ title: "My Attendance · AWIP" }] }),
  component: MyAttendancePage,
});

function MyAttendancePage() {
  const { user } = useAuth();
  const employeeId = user?.employeeId ?? "";
  const { data: e, isLoading, isError } = useQuery({
    queryKey: ["employee", employeeId],
    queryFn: () => coreApi.getEmployee(employeeId),
    enabled: !!employeeId,
  });

  const attendance = (e?.attendance ?? []) as { month: string; presentDays: number; totalDays: number }[];

  return (
    <div className="min-h-full bg-gradient-to-br from-background via-background to-primary-soft/40 px-5 py-4 max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-4">
        <div className="size-9 rounded-lg bg-primary/10 text-primary grid place-items-center"><Clock className="size-4.5" /></div>
        <div>
          <div className="text-lg font-semibold tracking-tight">My Attendance</div>
          <div className="text-xs text-muted-foreground">Month-by-month presence record</div>
        </div>
      </div>

      {isLoading ? (
        <div className="p-10 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading attendance…
        </div>
      ) : isError || !e ? (
        <div className="p-10 text-center text-sm text-destructive">Could not load your attendance record.</div>
      ) : attendance.length === 0 ? (
        <Panel><div className="text-sm text-muted-foreground text-center py-6">No attendance records found.</div></Panel>
      ) : (
        <>
          {(() => {
            const latest = attendance[0];
            const latestPct = latest.totalDays > 0 ? Math.round((latest.presentDays / latest.totalDays) * 100) : 0;
            const avgPct = Math.round(
              (attendance.reduce((s, a) => s + (a.totalDays > 0 ? a.presentDays / a.totalDays : 0), 0) / attendance.length) * 100,
            );
            return (
              <div className="grid grid-cols-3 gap-3 mb-5">
                <Panel className="text-center">
                  <div className="text-[10px] uppercase text-muted-foreground">Latest month</div>
                  <div className="text-2xl font-semibold text-success mt-1">{latestPct}%</div>
                </Panel>
                <Panel className="text-center">
                  <div className="text-[10px] uppercase text-muted-foreground">Average attendance</div>
                  <div className="text-2xl font-semibold mt-1">{avgPct}%</div>
                </Panel>
                <Panel className="text-center">
                  <div className="text-[10px] uppercase text-muted-foreground">Months tracked</div>
                  <div className="text-2xl font-semibold mt-1">{attendance.length}</div>
                </Panel>
              </div>
            );
          })()}

          <Section title="Monthly breakdown">
            <Panel className="space-y-3">
              {attendance.map((a) => {
                const pct = a.totalDays > 0 ? Math.round((a.presentDays / a.totalDays) * 100) : 0;
                const tone = pct >= 90 ? "bg-success" : pct >= 75 ? "bg-warning" : "bg-destructive";
                return (
                  <div key={a.month}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-medium">{a.month}</span>
                      <span className="text-muted-foreground tabular-nums">{a.presentDays}/{a.totalDays} days · {pct}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-surface-muted overflow-hidden">
                      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </Panel>
          </Section>
        </>
      )}
    </div>
  );
}
