import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { X, Loader2, Info, AlertTriangle } from "lucide-react";
import { coreApi, ApiError } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";

type LeaveConflict = {
  conflict: { employeeId: string; name: string; fromDate: string; toDate: string };
  suggestion: { fromDate: string; toDate: string } | null;
  overridable: boolean;
};

const FALLBACK_LEAVE_TYPES = ["Casual Leave", "Earned Leave", "Sick Leave"];

export function ApplyLeaveModal({
  employeeId, onClose, onApplied,
}: { employeeId: string; onClose: () => void; onApplied: () => void }) {
  const { data: balancesResp } = useQuery({
    queryKey: ["leave-balances", employeeId],
    queryFn: () => coreApi.getLeaveBalances(employeeId),
  });
  const leaveTypes = balancesResp?.data.length
    ? [...new Set(balancesResp.data.map((b) => b.leaveType))]
    : FALLBACK_LEAVE_TYPES;

  const { data: rulesResp } = useQuery({
    queryKey: ["compliance-rules"],
    queryFn: () => coreApi.getComplianceRules(),
  });
  const holidayDates = useMemo(() => new Set((rulesResp?.holidays ?? []).map((h: any) => h.date)), [rulesResp]);

  const [leaveType, setLeaveType] = useState(leaveTypes[0]);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<LeaveConflict | null>(null);

  const clearFeedback = () => {
    setError(null);
    setConflict(null);
  };

  // Non-blocking heads-up: weekends/holidays inside the requested range still
  // count toward the day total (the backend counts plain calendar days), so
  // surface that up front rather than let it be a surprise after decision.
  const weekendHolidayNote = useMemo(() => {
    if (!fromDate || !toDate || toDate < fromDate) return null;
    let count = 0;
    const cursor = new Date(`${fromDate}T00:00:00`);
    const end = new Date(`${toDate}T00:00:00`);
    while (cursor <= end) {
      const iso = cursor.toISOString().slice(0, 10);
      const isWeekend = cursor.getDay() === 0 || cursor.getDay() === 6;
      if (isWeekend || holidayDates.has(iso)) count++;
      cursor.setDate(cursor.getDate() + 1);
    }
    return count > 0 ? count : null;
  }, [fromDate, toDate, holidayDates]);

  const apply = useMutation({
    mutationFn: (vars: { overrideConflict?: boolean } = {}) =>
      coreApi.applyForLeave({ employeeId, leaveType, fromDate, toDate, reason, overrideConflict: vars.overrideConflict }),
    onSuccess: onApplied,
    onError: (err) => {
      if (err instanceof ApiError) {
        setError(err.message);
        const data = err.data as Partial<LeaveConflict> | undefined;
        setConflict(data?.conflict ? { conflict: data.conflict, suggestion: data.suggestion ?? null, overridable: !!data.overridable } : null);
      } else {
        setError("Could not submit leave request");
        setConflict(null);
      }
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    clearFeedback();
    if (!fromDate || !toDate || !reason.trim()) {
      setError("From date, to date, and reason are all required");
      return;
    }
    apply.mutate({});
  };

  const useSuggestedDates = () => {
    if (!conflict?.suggestion) return;
    setFromDate(conflict.suggestion.fromDate);
    setToDate(conflict.suggestion.toDate);
    clearFeedback();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-lg shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Apply for Leave</h2>
          <button onClick={onClose} className="size-8 grid place-items-center rounded-md hover:bg-surface-muted"><X className="size-4" /></button>
        </div>
        <form onSubmit={submit} className="p-4 space-y-3">
          {error && <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-2.5 py-1.5">{error}</div>}

          {conflict && (
            <div className="text-[11px] text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-2.5 py-1.5 space-y-1.5">
              <div className="flex items-start gap-1.5">
                <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                <span>{conflict.conflict.name} already has a leave request for {formatDate(conflict.conflict.fromDate)} → {formatDate(conflict.conflict.toDate)}.</span>
              </div>
              {conflict.suggestion && (
                <button
                  type="button"
                  onClick={useSuggestedDates}
                  className="text-[11px] font-medium underline hover:no-underline"
                >
                  Use next available dates instead: {formatDate(conflict.suggestion.fromDate)} → {formatDate(conflict.suggestion.toDate)}
                </button>
              )}
              {conflict.overridable && (
                <div>
                  <button
                    type="button"
                    disabled={apply.isPending}
                    onClick={() => apply.mutate({ overrideConflict: true })}
                    className="text-[11px] font-medium underline hover:no-underline disabled:opacity-50"
                  >
                    Apply anyway (override conflict)
                  </button>
                </div>
              )}
            </div>
          )}

          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Leave Type</label>
            <select
              value={leaveType}
              onChange={(e) => { setLeaveType(e.target.value); clearFeedback(); }}
              className="mt-1 h-9 w-full px-2 rounded-md bg-surface border border-border text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
            >
              {leaveTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">From</label>
              <input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); clearFeedback(); }}
                className="mt-1 h-9 w-full px-2 rounded-md bg-surface border border-border text-sm focus:outline-none focus:ring-2 focus:ring-ring/40" />
            </div>
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">To</label>
              <input type="date" value={toDate} onChange={(e) => { setToDate(e.target.value); clearFeedback(); }}
                className="mt-1 h-9 w-full px-2 rounded-md bg-surface border border-border text-sm focus:outline-none focus:ring-2 focus:ring-ring/40" />
            </div>
          </div>

          {weekendHolidayNote != null && (
            <div className="text-[11px] text-info bg-info/10 border border-info/30 rounded-md px-2.5 py-1.5 flex items-start gap-1.5">
              <Info className="size-3.5 shrink-0 mt-0.5" />
              <span>{weekendHolidayNote} weekend/holiday day(s) fall inside this range and will still count against your balance.</span>
            </div>
          )}

          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Reason</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="mt-1 w-full px-2 py-1.5 rounded-md bg-surface border border-border text-sm focus:outline-none focus:ring-2 focus:ring-ring/40 resize-none"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="h-9 px-3 rounded-md border border-border text-sm font-medium hover:bg-surface-muted">
              Cancel
            </button>
            <button
              type="submit"
              disabled={apply.isPending}
              className="h-9 px-3 inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-95 disabled:opacity-50"
            >
              {apply.isPending && <Loader2 className="size-3.5 animate-spin" />} Submit Request
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
