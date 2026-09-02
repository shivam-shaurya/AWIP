import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, CalendarClock, Plus, ScrollText } from "lucide-react";
import { Section, Panel, Pill } from "@/components/layout/section";
import { coreApi } from "@/lib/api-client";
import { useAuth } from "@/context/auth-context";
import { ApplyLeaveModal } from "@/components/leave/apply-leave-modal";
import { formatDate } from "@/lib/utils";

export const Route = createFileRoute("/my/leave")({
  head: () => ({ meta: [{ title: "My Leave · AWIP" }] }),
  component: MyLeavePage,
});

function statusTone(status: string) {
  return status === "Approved" ? "success" : status === "Rejected" ? "destructive" : "warning";
}

function MyLeavePage() {
  const { user } = useAuth();
  const employeeId = user?.employeeId ?? "";
  const queryClient = useQueryClient();
  const [applyOpen, setApplyOpen] = useState(false);

  const { data: balancesResp, isLoading: balancesLoading } = useQuery({
    queryKey: ["leave-balances", employeeId],
    queryFn: () => coreApi.getLeaveBalances(employeeId),
    enabled: !!employeeId,
  });
  const balances = balancesResp?.data ?? [];

  const { data: requestsResp, isLoading: requestsLoading } = useQuery({
    queryKey: ["leave-requests", "employee", employeeId],
    queryFn: () => coreApi.getLeaveRequests({ employeeId }),
    enabled: !!employeeId,
  });
  const requests = (requestsResp?.data ?? []) as { id: string; leaveType: string; fromDate: string; toDate: string; days: number; status: string; managerStatus: string; stage?: string }[];

  const { data: rulesResp, isLoading: rulesLoading } = useQuery({
    queryKey: ["compliance-rules"],
    queryFn: () => coreApi.getComplianceRules(),
  });
  const leaveRules = (rulesResp?.leaveRules ?? []) as { leaveType: string; entitledDaysPerYear: number; carryForwardAllowed: boolean; maxCarryForward: number; eligibilityNote: string; minNoticeDays: number }[];

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["leave-balances", employeeId] });
    queryClient.invalidateQueries({ queryKey: ["leave-requests", "employee", employeeId] });
  };

  return (
    <div className="min-h-full bg-gradient-to-br from-background via-background to-primary-soft/40 px-5 py-4 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="size-9 rounded-lg bg-primary/10 text-primary grid place-items-center"><CalendarClock className="size-4.5" /></div>
          <div>
            <div className="text-lg font-semibold tracking-tight">My Leave</div>
            <div className="text-xs text-muted-foreground">Balances, history, and applying for leave</div>
          </div>
        </div>
        <button
          onClick={() => setApplyOpen(true)}
          disabled={!employeeId}
          className="h-9 px-3 inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-95 disabled:opacity-50"
        >
          <Plus className="size-3.5" /> Apply for Leave
        </button>
      </div>

      <Section title="Leave balances" className="mb-5">
        {balancesLoading ? (
          <div className="p-6 flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
        ) : balances.length === 0 ? (
          <Panel><div className="text-sm text-muted-foreground text-center py-4">No leave balance on file.</div></Panel>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {balances.map((b) => (
              <Panel key={b.id} className="text-center">
                <div className="text-[10px] uppercase text-muted-foreground">{b.leaveType}</div>
                <div className="text-2xl font-semibold mt-1">{b.balance}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">{b.availed}/{b.entitled} availed · {b.year}</div>
              </Panel>
            ))}
          </div>
        )}
      </Section>

      <Section title="Leave policy" className="mb-5">
        {rulesLoading ? (
          <div className="p-6 flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
        ) : leaveRules.length === 0 ? (
          <Panel><div className="text-sm text-muted-foreground text-center py-4">No leave policy on file.</div></Panel>
        ) : (
          <Panel padded={false} className="divide-y divide-border/60">
            {leaveRules.map((r) => (
              <div key={r.leaveType} className="p-4 flex items-start gap-3">
                <ScrollText className="size-4 text-primary shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{r.leaveType}</span>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">{r.entitledDaysPerYear} days/yr</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">{r.eligibilityNote}</div>
                  <div className="text-[11px] text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>{r.carryForwardAllowed ? `Carry-forward up to ${r.maxCarryForward}d` : "No carry-forward"}</span>
                    {r.minNoticeDays > 0 && <span>Min. {r.minNoticeDays}d notice required</span>}
                  </div>
                </div>
              </div>
            ))}
          </Panel>
        )}
      </Section>

      <Section title="Request history">
        {requestsLoading ? (
          <div className="p-6 flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
        ) : requests.length === 0 ? (
          <Panel><div className="text-sm text-muted-foreground text-center py-4">You haven't applied for any leave yet.</div></Panel>
        ) : (
          <Panel className="space-y-2" padded={false}>
            {requests.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 text-sm px-4 py-3 border-b border-border/60 last:border-0">
                <div>
                  <div className="font-medium">{r.leaveType}</div>
                  <div className="text-xs text-muted-foreground">{formatDate(r.fromDate)} → {formatDate(r.toDate)} · {r.days}d</div>
                </div>
                <Pill tone={statusTone(r.status)}>{r.stage && r.status === "Pending" ? r.stage : r.status}</Pill>
              </div>
            ))}
          </Panel>
        )}
      </Section>

      {applyOpen && employeeId && (
        <ApplyLeaveModal
          employeeId={employeeId}
          onClose={() => setApplyOpen(false)}
          onApplied={() => { setApplyOpen(false); refresh(); }}
        />
      )}
    </div>
  );
}
