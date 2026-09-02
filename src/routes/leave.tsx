import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock, Check, X, Loader2, Search, PlaneTakeoff, CalendarPlus,
  ChevronLeft, ChevronRight, BarChart3, AlertTriangle, Users, Clock, HeartPulse,
} from "lucide-react";
import { Panel, Pill } from "@/components/layout/section";
import { SearchPill } from "@/components/ui/search-pill";
import { Pager } from "@/components/ui/pager";
import { useDepartment } from "@/context/department-context";
import { coreApi, ApiError } from "@/lib/api-client";
import { cn, formatDate } from "@/lib/utils";

export const Route = createFileRoute("/leave")({
  head: () => ({ meta: [{ title: "Leave Management · AWIP" }] }),
  component: LeavePage,
});

function statusTone(status: string) {
  return status === "Approved" ? "success" : status === "Rejected" ? "destructive" : "warning";
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function LeavePage() {
  const { department } = useDepartment();
  const queryClient = useQueryClient();
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [queueSearch, setQueueSearch] = useState("");
  const [queueTab, setQueueTab] = useState<"Manager" | "HR">("Manager");
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const { data: employeesResp } = useQuery({
    queryKey: ["employees", "All Departments"],
    queryFn: () => coreApi.getEmployees(),
  });
  const employees = employeesResp?.data ?? [];
  const filteredEmployees = useMemo(() => {
    const q = employeeSearch.trim().toLowerCase();
    if (!q) return [];
    return employees
      .filter((e: any) =>
        e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q) || e.department?.toLowerCase().includes(q))
      .slice(0, 20);
  }, [employees, employeeSearch]);

  useEffect(() => {
    const onClickOutside = (ev: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(ev.target as Node)) setShowSuggestions(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const { data: balancesResp, isLoading: balancesLoading } = useQuery({
    queryKey: ["leave-balances", selectedEmployeeId],
    queryFn: () => coreApi.getLeaveBalances(selectedEmployeeId!),
    enabled: !!selectedEmployeeId,
  });
  const balances = balancesResp?.data ?? [];

  const { data: myRequestsResp } = useQuery({
    queryKey: ["leave-requests", "employee", selectedEmployeeId],
    queryFn: () => coreApi.getLeaveRequests({ employeeId: selectedEmployeeId! }),
    enabled: !!selectedEmployeeId,
  });
  const myRequests = myRequestsResp?.data ?? [];

  const { data: pendingResp } = useQuery({
    queryKey: ["leave-requests", "pending", department],
    queryFn: () => coreApi.getLeaveRequests({ status: "Pending", ...(department !== "All Departments" ? { department } : {}) }),
  });
  const pendingRequests = pendingResp?.data ?? [];
  const managerQueue = useMemo(() => pendingRequests.filter((r: any) => r.stage === "Manager Review"), [pendingRequests]);
  const hrQueue = useMemo(() => pendingRequests.filter((r: any) => r.stage === "HR Review"), [pendingRequests]);

  const filterBySearch = (rows: any[]) => {
    const q = queueSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.employeeName?.toLowerCase().includes(q) || r.leaveType?.toLowerCase().includes(q) || r.department?.toLowerCase().includes(q));
  };
  const filteredManagerQueue = useMemo(() => filterBySearch(managerQueue), [managerQueue, queueSearch]);
  const filteredHrQueue = useMemo(() => filterBySearch(hrQueue), [hrQueue, queueSearch]);

  const { data: overviewResp } = useQuery({
    queryKey: ["leave-overview", department],
    queryFn: () => coreApi.getLeaveOverview(department),
  });
  const currentLeaves = overviewResp?.current ?? [];
  const upcomingLeaves = overviewResp?.upcoming ?? [];

  const invalidateLeave = () => {
    queryClient.invalidateQueries({ queryKey: ["leave-requests"] });
    queryClient.invalidateQueries({ queryKey: ["leave-balances"] });
    queryClient.invalidateQueries({ queryKey: ["leave-overview"] });
    queryClient.invalidateQueries({ queryKey: ["leave-calendar"] });
    queryClient.invalidateQueries({ queryKey: ["leave-analytics"] });
  };

  const managerDecide = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "Approved" | "Rejected" }) => coreApi.managerDecideLeaveRequest(id, { status }),
    onSuccess: () => { setDecisionError(null); invalidateLeave(); },
    onError: (err) => setDecisionError(err instanceof ApiError ? err.message : "Could not record manager decision"),
  });

  const decide = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "Approved" | "Rejected" }) => coreApi.decideLeaveRequest(id, { status }),
    onSuccess: () => { setDecisionError(null); invalidateLeave(); },
    onError: (err) => setDecisionError(err instanceof ApiError ? err.message : "Could not record decision"),
  });

  const selectedEmployee = useMemo(() => employees.find((e: any) => e.id === selectedEmployeeId), [employees, selectedEmployeeId]);

  return (
    <div className="p-5 max-w-[1600px] mx-auto space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <CalendarClock className="size-6 text-primary" /> Leave Management
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Leave requests against real balances and policy, with manager then HR approval.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel className="p-4 border-2 border-primary/40">
          <div className="flex items-center gap-1.5 text-sm font-semibold mb-2">
            <PlaneTakeoff className="size-4 text-primary" /> Currently on Leave
          </div>
          {currentLeaves.length === 0 ? (
            <div className="text-xs text-muted-foreground py-4 text-center">No one is on approved leave today.</div>
          ) : (
            <div className="space-y-1.5 max-h-48 overflow-y-auto scrollbar-thin">
              {currentLeaves.map((r: any) => (
                <div key={r.id} className="flex items-center justify-between gap-2 text-xs bg-surface border border-border/60 rounded-md p-2">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{r.employeeName} · {r.designation}</div>
                    <div className="text-[10px] text-muted-foreground">{r.leaveType} · returns {formatDate(r.toDate)}</div>
                  </div>
                  <Pill tone="warning">{r.days}d</Pill>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel className="p-4 border-2 border-primary/40">
          <div className="flex items-center gap-1.5 text-sm font-semibold mb-2">
            <CalendarPlus className="size-4 text-primary" /> Upcoming Leave
          </div>
          {upcomingLeaves.length === 0 ? (
            <div className="text-xs text-muted-foreground py-4 text-center">No approved leave scheduled ahead.</div>
          ) : (
            <div className="space-y-1.5 max-h-48 overflow-y-auto scrollbar-thin">
              {upcomingLeaves.map((r: any) => (
                <div key={r.id} className="flex items-center justify-between gap-2 text-xs bg-surface border border-border/60 rounded-md p-2">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{r.employeeName} · {r.designation}</div>
                    <div className="text-[10px] text-muted-foreground">{r.leaveType} · {formatDate(r.fromDate)} → {formatDate(r.toDate)}</div>
                  </div>
                  <Pill tone="info">{r.days}d</Pill>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LeaveCalendarPanel department={department} />
        <LeaveAnalyticsPanel department={department} />
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="size-9 rounded-lg bg-primary/10 text-primary grid place-items-center shrink-0">
            <Users className="size-4.5" />
          </div>
          <h3 className="text-sm font-semibold">Employee</h3>
        </div>
        <div className="relative w-full sm:w-96" ref={pickerRef}>
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            value={employeeSearch}
            onChange={(e) => {
              setEmployeeSearch(e.target.value);
              setSelectedEmployeeId(null);
              setShowSuggestions(true);
            }}
            onFocus={() => setShowSuggestions(true)}
            placeholder="Search by name, ID, or department…"
            className="h-10 w-full pl-10 pr-9 rounded-full bg-card border border-border text-sm focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-primary/40"
          />
          {selectedEmployeeId && (
            <button
              onClick={() => { setSelectedEmployeeId(null); setEmployeeSearch(""); }}
              title="Clear selection"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 size-5 grid place-items-center rounded-full border border-border text-muted-foreground hover:text-foreground hover:bg-surface-muted"
            >
              <X className="size-3" />
            </button>
          )}
          {showSuggestions && !selectedEmployeeId && employeeSearch.trim() && (
            <div className="absolute z-20 mt-1 w-full max-h-60 overflow-y-auto scrollbar-thin rounded-md border border-border bg-card shadow-lg">
              {filteredEmployees.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">No employees match "{employeeSearch}".</div>
              ) : (
                filteredEmployees.map((e: any) => (
                  <button
                    key={e.id}
                    onClick={() => {
                      setSelectedEmployeeId(e.id);
                      setEmployeeSearch(`${e.name} · ${e.id}`);
                      setShowSuggestions(false);
                    }}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-surface-muted border-b border-border/60 last:border-0"
                  >
                    <div className="font-medium">{e.name}</div>
                    <div className="text-[10px] text-muted-foreground">{e.id} · {e.designation} · {e.department}</div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {selectedEmployeeId && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <Panel className="p-4 flex flex-col">
            <h3 className="text-sm font-semibold mb-3">{selectedEmployee?.name}'s Leave Balance</h3>
            {balancesLoading ? (
              <div className="text-xs text-muted-foreground py-4 text-center">Loading balances…</div>
            ) : balances.length === 0 ? (
              <div className="text-xs text-muted-foreground py-4 text-center">No leave balance on file for this employee.</div>
            ) : (
              <div className="space-y-2.5">
                {balances.map((b) => (
                  <div key={b.id} className="flex items-center justify-between text-xs">
                    <span className="font-medium">{b.leaveType} ({b.year})</span>
                    <span className="text-muted-foreground tabular-nums flex items-center gap-1.5">
                      {b.availed} availed / {b.entitled} entitled
                      <span className="size-1 rounded-full bg-muted-foreground/50" />
                      <span className="font-semibold text-success">{b.balance} Left</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel className="p-4 flex flex-col">
            <h3 className="text-sm font-semibold mb-3">Request History</h3>
            {myRequests.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2.5 text-center py-6">
                <div className="size-11 rounded-full bg-warning/10 text-warning-foreground grid place-items-center">
                  <Clock className="size-5" />
                </div>
                <div className="text-xs text-muted-foreground">No leave requests filed yet.</div>
              </div>
            ) : (
              <div className="space-y-1.5 max-h-64 overflow-y-auto scrollbar-thin">
                {myRequests.map((r: any) => (
                  <div key={r.id} className="flex items-center justify-between text-xs bg-surface border border-border/60 rounded-md p-2">
                    <div>
                      <div className="font-medium">{r.leaveType} · {r.days}d</div>
                      <div className="text-[10px] text-muted-foreground">{formatDate(r.fromDate)} → {formatDate(r.toDate)}</div>
                      {r.status === "Pending" && (
                        <div className="text-[10px] text-muted-foreground italic">
                          {r.managerStatus === "Pending" ? "Awaiting manager approval" : "Awaiting HR approval"}
                        </div>
                      )}
                    </div>
                    <Pill tone={statusTone(r.status) as any}>{r.status}</Pill>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      )}

      {decisionError && (
        <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-2.5 py-1.5">{decisionError}</div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-0 border-b border-border">
          {(["Manager", "HR"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setQueueTab(t)}
              className={cn(
                "px-5 py-3 text-sm font-medium whitespace-nowrap transition-all relative inline-flex items-center gap-2",
                queueTab === t ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Awaiting {t} Approval
              <span className={cn(
                "text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded-full",
                queueTab === t ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
              )}>
                {t === "Manager" ? managerQueue.length : hrQueue.length}
              </span>
              {queueTab === t && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t" />}
            </button>
          ))}
        </div>
        <SearchPill value={queueSearch} onChange={setQueueSearch} placeholder="Search this approval queue…" className="w-64" />
      </div>

      {queueTab === "Manager" ? (
        <ApprovalQueue
          key="Manager"
          subtitle={`Scoped to ${department} · first stage of review`}
          rows={filteredManagerQueue}
          totalRows={managerQueue.length}
          searchKey={queueSearch}
          pending={managerDecide.isPending}
          onApprove={(id) => managerDecide.mutate({ id, status: "Approved" })}
          onReject={(id) => managerDecide.mutate({ id, status: "Rejected" })}
        />
      ) : (
        <ApprovalQueue
          key="HR"
          subtitle={`Scoped to ${department} · final stage — debits leave balance on approval`}
          rows={filteredHrQueue}
          totalRows={hrQueue.length}
          searchKey={queueSearch}
          pending={decide.isPending}
          onApprove={(id) => decide.mutate({ id, status: "Approved" })}
          onReject={(id) => decide.mutate({ id, status: "Rejected" })}
        />
      )}
    </div>
  );
}

const AVATAR_TONES = [
  "bg-warning/20 text-warning-foreground",
  "bg-chart-1/15 text-chart-1",
  "bg-success/15 text-success",
  "bg-destructive/15 text-destructive",
  "bg-info/15 text-info",
  "bg-primary/15 text-primary",
  "bg-chart-4/15 text-chart-4",
];

function initials(name: string) {
  return name.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

const QUEUE_PAGE_SIZE = 10;

function ApprovalQueue({
  subtitle, rows, totalRows, searchKey, pending, onApprove, onReject,
}: {
  subtitle: string; rows: any[]; totalRows: number; searchKey: string; pending: boolean;
  onApprove: (id: string) => void; onReject: (id: string) => void;
}) {
  const [page, setPage] = useState(1);
  const [detailRow, setDetailRow] = useState<any | null>(null);
  useEffect(() => setPage(1), [searchKey]);

  const totalPages = Math.max(1, Math.ceil(rows.length / QUEUE_PAGE_SIZE));
  const visible = rows.slice((page - 1) * QUEUE_PAGE_SIZE, page * QUEUE_PAGE_SIZE);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{subtitle}</p>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground py-6 text-center border border-border rounded-xl bg-card">
          {totalRows === 0 ? "Nothing waiting here." : "No requests match your search."}
        </div>
      ) : (
        <Panel padded={false}>
          <div className="overflow-x-auto overflow-y-hidden scrollbar-thin rounded-t-xl">
            <table className="w-full text-sm">
              <thead className="bg-sidebar text-[10px] uppercase tracking-wider text-sidebar-foreground font-semibold">
                <tr>
                  <th className="text-left font-medium px-4 py-3 whitespace-nowrap">Employee</th>
                  <th className="text-left font-medium px-4 py-3 whitespace-nowrap">Designation</th>
                  <th className="text-left font-medium px-4 py-3 whitespace-nowrap">Leave Type</th>
                  <th className="text-left font-medium px-4 py-3 whitespace-nowrap">Period</th>
                  <th className="text-left font-medium px-4 py-3 whitespace-nowrap">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.map((r: any, i: number) => (
                  <tr
                    key={r.id}
                    onClick={() => setDetailRow(r)}
                    className={cn("hover:bg-surface-muted/70 transition-colors cursor-pointer", i % 2 === 1 && "bg-surface-muted")}
                  >
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2.5">
                        <div className={cn("size-8 rounded-full grid place-items-center text-[11px] font-bold shrink-0", AVATAR_TONES[i % AVATAR_TONES.length])}>
                          {initials(r.employeeName)}
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium truncate">{r.employeeName}</div>
                          <div className="text-[10px] text-muted-foreground truncate">{r.department}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{r.designation}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{r.leaveType}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{formatDate(r.fromDate)} to {formatDate(r.toDate)} ({r.days}d)</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Pill tone={r.balanceRemaining != null && r.balanceRemaining < r.days ? "destructive" : "info"}>
                        {r.balanceRemaining ?? "—"}d left
                      </Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && <Pager page={page} totalPages={totalPages} onChange={setPage} />}
        </Panel>
      )}

      {detailRow && (
        <ApprovalDetailModal
          row={detailRow}
          pending={pending}
          onClose={() => setDetailRow(null)}
          onApprove={() => { onApprove(detailRow.id); setDetailRow(null); }}
          onReject={() => { onReject(detailRow.id); setDetailRow(null); }}
        />
      )}
    </div>
  );
}

function ApprovalDetailModal({ row, pending, onClose, onApprove, onReject }: {
  row: any; pending: boolean; onClose: () => void; onApprove: () => void; onReject: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 w-full sm:w-[440px] bg-card border-l border-border shadow-2xl z-50 p-6 flex flex-col overflow-y-auto scrollbar-thin animate-in slide-in-from-right duration-300">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="font-semibold text-lg">{row.employeeName}</h2>
            <div className="text-xs text-muted-foreground mt-0.5">{row.designation} · {row.department}</div>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-surface-muted shrink-0"><X className="size-5" /></button>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm mb-4">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Leave Type</div>
            <div className="font-medium">{row.leaveType}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Period</div>
            <div className="font-medium">{formatDate(row.fromDate)} → {formatDate(row.toDate)} ({row.days}d)</div>
          </div>
        </div>

        <div className="mb-4">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Reason</div>
          <p className="text-sm italic bg-surface-muted/50 rounded-md p-2.5">"{row.reason}"</p>
        </div>

        <div className="mb-6">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Balance & History</div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Pill tone={row.balanceRemaining != null && row.balanceRemaining < row.days ? "destructive" : "info"}>
              {row.balanceRemaining ?? "—"} {row.leaveType} day(s) left
            </Pill>
            {row.history && (
              <>
                <Pill tone="success">{row.history.approvedCount} approved before</Pill>
                {row.history.rejectedCount > 0 && <Pill tone="destructive">{row.history.rejectedCount} rejected before</Pill>}
                <Pill tone="warning">{row.history.daysTakenThisYear}d taken this year</Pill>
              </>
            )}
            {row.managerStatus === "Approved" && <Pill tone="success">Manager approved</Pill>}
          </div>
        </div>

        <div className="mt-auto pt-4 border-t border-border flex items-center gap-2">
          <button
            onClick={onApprove}
            disabled={pending}
            className="h-9 px-3.5 inline-flex items-center gap-1.5 rounded-md bg-success text-success-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Approve
          </button>
          <button
            onClick={onReject}
            disabled={pending}
            className="h-9 px-3.5 inline-flex items-center gap-1.5 rounded-md border border-border text-sm font-medium hover:bg-surface-muted disabled:opacity-50"
          >
            <X className="size-4" /> Reject
          </button>
        </div>
      </div>
    </>
  );
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CONFLICT_THRESHOLD = 3;

type LeaveTone = "warning" | "success" | "info" | "primary";
const TONE_BG: Record<LeaveTone, string> = { warning: "bg-warning", success: "bg-success", info: "bg-info", primary: "bg-primary" };
const TONE_BG_SOFT: Record<LeaveTone, string> = { warning: "bg-warning/15", success: "bg-success/15", info: "bg-info/15", primary: "bg-primary/15" };
const TONE_TEXT: Record<LeaveTone, string> = { warning: "text-warning-foreground", success: "text-success", info: "text-info", primary: "text-primary" };
const LEAVE_TYPE_STYLE: Record<string, { icon: typeof PlaneTakeoff; tone: LeaveTone }> = {
  "Casual Leave": { icon: PlaneTakeoff, tone: "warning" },
  "Earned Leave": { icon: Users, tone: "success" },
  "Medical Leave": { icon: HeartPulse, tone: "info" },
};
function leaveTypeStyle(type: string) {
  return LEAVE_TYPE_STYLE[type] ?? { icon: CalendarClock, tone: "primary" as const };
}

function LeaveCalendarPanel({ department }: { department: string }) {
  const [month, setMonth] = useState(currentMonth());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["leave-calendar", month, department],
    queryFn: () => coreApi.getLeaveCalendar(month, department),
  });
  const days = data?.days ?? {};

  const [year, m] = month.split("-").map(Number);
  const firstWeekday = new Date(year, m - 1, 1).getDay();
  const lastDay = new Date(year, m, 0).getDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: lastDay }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];

  const shiftMonth = (delta: number) => {
    const d = new Date(year, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    setSelectedDay(null);
  };

  const monthLabel = new Date(year, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  return (
    <Panel className="p-4 flex flex-col border-2 border-primary/40">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5 text-sm font-semibold">
          <div className="size-8 rounded-lg bg-primary/10 text-primary grid place-items-center shrink-0">
            <CalendarClock className="size-4" />
          </div>
          Team Leave Calendar
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => shiftMonth(-1)} className="size-7 grid place-items-center rounded-full hover:bg-surface-muted transition-colors"><ChevronLeft className="size-3.5" /></button>
          <span className="text-xs font-medium tabular-nums w-24 text-center">{monthLabel}</span>
          <button onClick={() => shiftMonth(1)} className="size-7 grid place-items-center rounded-full hover:bg-surface-muted transition-colors"><ChevronRight className="size-3.5" /></button>
        </div>
      </div>
      {isLoading ? (
        <div className="flex-1 text-xs text-muted-foreground py-6 text-center flex items-center justify-center">Loading calendar…</div>
      ) : (
        <>
          <div className="grid grid-cols-7 gap-1.5 text-center text-[10px] text-muted-foreground mb-1.5">
            {WEEKDAY_LABELS.map((w) => <div key={w}>{w}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1.5 flex-1 auto-rows-fr">
            {cells.map((date, i) => {
              if (!date) return <div key={i} />;
              const names = days[date] ?? [];
              const count = names.length;
              const conflict = count >= CONFLICT_THRESHOLD;
              return (
                <button
                  key={date}
                  onClick={() => setSelectedDay(count > 0 ? date : null)}
                  className={cn(
                    "w-full h-full min-h-9 rounded-xl border text-[10px] flex flex-col items-center justify-center gap-0.5 transition-colors",
                    count === 0 && "border-border/60 text-muted-foreground",
                    count > 0 && count < CONFLICT_THRESHOLD && "border-warning/40 bg-warning/10 text-warning-foreground",
                    conflict && "border-destructive/50 bg-destructive/10 text-destructive ring-1 ring-destructive/30",
                    selectedDay === date && "ring-2 ring-primary/50",
                  )}
                  title={names.map((n) => n.name).join(", ")}
                >
                  <span className="tabular-nums">{Number(date.slice(-2))}</span>
                  {count > 0 && <span className="font-semibold">{count}</span>}
                </button>
              );
            })}
          </div>

          <div className="pt-2 space-y-2 shrink-0">
            <div className="text-[10px] text-muted-foreground flex items-center gap-1.5">
              <AlertTriangle className="size-3 text-destructive" /> {CONFLICT_THRESHOLD}+ on leave the same day is flagged as a team overlap risk.
            </div>
            {selectedDay && (
              <div className="rounded-md border border-border bg-surface p-2 space-y-1">
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{selectedDay}</div>
                {(days[selectedDay] ?? []).map((n, i) => (
                  <div key={i} className="text-xs flex items-center justify-between">
                    <span>{n.name} · {n.department}</span>
                    <Pill tone="info">{n.leaveType}</Pill>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}

function LeaveAnalyticsPanel({ department }: { department: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["leave-analytics", department],
    queryFn: () => coreApi.getLeaveAnalytics(department),
  });

  return (
    <Panel className="p-4 flex flex-col border-2 border-primary/40">
      <div className="flex items-center gap-2.5 text-sm font-semibold mb-3">
        <div className="size-8 rounded-lg bg-warning/15 text-warning-foreground grid place-items-center shrink-0">
          <BarChart3 className="size-4" />
        </div>
        Leave Analytics
      </div>
      {isLoading || !data ? (
        <div className="flex-1 text-xs text-muted-foreground py-6 text-center flex items-center justify-center">Loading analytics…</div>
      ) : (
        <div className="flex-1 flex flex-col space-y-4">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg border-2 border-warning/40 p-2">
              <div className="text-[9px] uppercase text-muted-foreground">Most Availed</div>
              <div className="text-xs font-bold mt-0.5 truncate text-warning-foreground">{data.mostAvailedType ?? "—"}</div>
            </div>
            <div className="rounded-lg border-2 border-destructive/40 p-2">
              <div className="text-[9px] uppercase text-muted-foreground">Approval Rate</div>
              <div className="text-lg font-bold text-destructive">{data.approvalRate != null ? `${data.approvalRate}%` : "—"}</div>
            </div>
            <div className="rounded-lg border-2 border-success/40 p-2">
              <div className="text-[9px] uppercase text-muted-foreground">Avg Decision Time</div>
              <div className="text-lg font-bold text-success">{data.avgDecisionDays != null ? `${data.avgDecisionDays}d` : "—"}</div>
            </div>
          </div>

          {data.utilization.length > 0 && (
            <div className="space-y-3">
              {data.utilization.map((u) => {
                const pct = u.entitled > 0 ? Math.min(100, Math.round((u.availed / u.entitled) * 100)) : 0;
                const style = leaveTypeStyle(u.leaveType);
                const Icon = style.icon;
                return (
                  <div key={u.leaveType}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 font-semibold">
                        <span className={cn("size-6 rounded-full grid place-items-center shrink-0", TONE_BG_SOFT[style.tone], TONE_TEXT[style.tone])}>
                          <Icon className="size-3.5" />
                        </span>
                        {u.leaveType}
                      </span>
                      <span className={cn("font-bold tabular-nums", TONE_TEXT[style.tone])}>{pct}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-surface-muted overflow-hidden mt-1.5">
                      <div className={cn("h-full rounded-full", TONE_BG[style.tone])} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="text-[10px] text-muted-foreground tabular-nums mt-1">{u.availed}/{u.entitled} availed</div>
                  </div>
                );
              })}
            </div>
          )}

          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">Nearing Zero Balance</div>
            {data.nearingZero.length === 0 ? (
              <div className="text-xs text-muted-foreground py-2 text-center">No one is close to exhausting a leave balance.</div>
            ) : (
              <div className="max-h-64 space-y-1.5 overflow-y-auto scrollbar-thin">
                {data.nearingZero.map((n, i) => (
                  <div key={i} className={cn(
                    "flex items-center gap-2.5 rounded-lg p-2",
                    n.balance === 0 ? "bg-destructive/5" : "bg-warning/5",
                  )}>
                    <div className={cn(
                      "size-8 rounded-full grid place-items-center text-[10px] font-bold shrink-0",
                      n.balance === 0 ? "bg-destructive/15 text-destructive" : "bg-warning/20 text-warning-foreground",
                    )}>
                      {initials(n.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium truncate">{n.name}</div>
                      <div className="text-[10px] text-muted-foreground truncate">{n.leaveType}</div>
                    </div>
                    <Pill tone={n.balance === 0 ? "destructive" : "warning"}>{n.balance} left</Pill>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
