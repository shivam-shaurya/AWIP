import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Loader2, GraduationCap, UserMinus2, FileText, PlaneTakeoff, StickyNote, Plus, X, Users, AlarmClock, PartyPopper, Megaphone, Trash2 } from "lucide-react";
import { Panel, Section, Pill } from "@/components/layout/section";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { coreApi, ApiError } from "@/lib/api-client";
import { useAuth } from "@/context/auth-context";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/calendar")({
  head: () => ({ meta: [{ title: "Calendar · AWIP" }] }),
  component: CalendarPage,
});

type CalendarEvent = {
  id: string;
  title: string;
  date: string;
  type: "Leave Approval" | "On Leave" | "Training" | "Retirement" | "Service Record" | "Meeting" | "Deadline" | "Holiday" | "Notice" | "Personal";
  employeeId?: string;
  employeeName?: string;
  department?: string;
  note?: string;
  to?: string;
  deletable?: boolean;
};

const CUSTOM_EVENT_TYPES = ["Meeting", "Deadline", "Holiday", "Notice"] as const;

const TYPE_ICON: Record<CalendarEvent["type"], typeof CalendarClock> = {
  "Leave Approval": CalendarClock,
  "On Leave": PlaneTakeoff,
  Training: GraduationCap,
  Retirement: UserMinus2,
  "Service Record": FileText,
  Meeting: Users,
  Deadline: AlarmClock,
  Holiday: PartyPopper,
  Notice: Megaphone,
  Personal: StickyNote,
};

const TYPE_TONE: Record<CalendarEvent["type"], "primary" | "info" | "warning" | "neutral" | "destructive" | "success"> = {
  "Leave Approval": "warning",
  "On Leave": "info",
  Training: "info",
  Retirement: "warning",
  "Service Record": "neutral",
  Meeting: "primary",
  Deadline: "destructive",
  Holiday: "success",
  Notice: "neutral",
  Personal: "primary",
};

const INLINE_LIMIT = 6;

function CalendarPage() {
  const { user } = useAuth();
  const isEmployee = user?.role === "Employee";
  const queryClient = useQueryClient();
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
  const [viewAllOpen, setViewAllOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addReminderOpen, setAddReminderOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CalendarEvent | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["calendar-events"],
    queryFn: () => coreApi.getCalendarEvents(),
  });
  const events: CalendarEvent[] = data?.data ?? [];

  const deleteMutation = useMutation({
    mutationFn: (id: string) => coreApi.deleteCalendarEvent(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
      setDeleteTarget(null);
    },
  });

  const deleteReminder = useMutation({
    mutationFn: (id: string) => coreApi.deletePersonalEvent(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["calendar-events"] }),
  });

  // Dates from the API are plain "YYYY-MM-DD" strings; parsing them with
  // `new Date(str)` treats them as UTC midnight, which renders one day early
  // in positive-offset timezones (e.g. IST) once local getters are used —
  // appending a local time-of-day avoids that.
  const eventDays = useMemo(() => events.map((e) => new Date(`${e.date}T00:00:00`)), [events]);

  const toLocalDateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const selectedKey = selectedDate ? toLocalDateKey(selectedDate) : undefined;
  const dayEvents = useMemo(
    () => (selectedKey ? events.filter((e) => e.date === selectedKey) : []),
    [events, selectedKey],
  );

  return (
    <div className="p-5 space-y-5 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">HR Calendar</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Upcoming trainings, retirements, service-record postings, pending leave approvals, and approved leaves across the workforce
            {isEmployee ? " — plus your own private reminders." : "."}
          </p>
        </div>
        {isEmployee ? (
          <button
            onClick={() => setAddReminderOpen(true)}
            className="h-9 px-3 inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-95"
          >
            <Plus className="size-3.5" /> Add Reminder
          </button>
        ) : (
          <button
            onClick={() => setAddOpen(true)}
            className="h-9 px-3 inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium shadow-[0_4px_24px_rgba(0,93,94,0.15)] hover:opacity-95 transition-opacity"
          >
            <Plus className="size-4" /> Add Event
          </button>
        )}
      </div>

      {isError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Couldn't load calendar events — is the AWIP core server running?
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-5 items-start">
        <Panel>
          <CalendarPicker
            mode="single"
            selected={selectedDate}
            onSelect={setSelectedDate}
            modifiers={{ hasEvent: eventDays }}
            modifiersClassNames={{ hasEvent: "font-semibold underline decoration-primary decoration-2 underline-offset-4" }}
          />
        </Panel>

        <Section
          title={selectedDate ? `Events on ${selectedDate.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}` : "Select a date"}
          action={<Link to="/" className="text-xs text-primary hover:underline">Back to Command Centre</Link>}
        >
          <Panel>
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
                <Loader2 className="size-4 animate-spin" /> Loading events…
              </div>
            ) : dayEvents.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center">
                No HR events scheduled for this day.
              </div>
            ) : (
              <ul>
                {dayEvents.map((e) => {
                  const Icon = TYPE_ICON[e.type];
                  const content = (
                    <>
                      <div className="size-8 rounded-lg grid place-items-center shrink-0 bg-surface-muted text-primary">
                        <Icon className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{e.title}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {e.type === "Personal" ? (e.note || "Personal reminder") : `${e.employeeName ? `${e.employeeName} · ` : ""}${e.department}`}
                        </div>
                      </div>
                      <Pill tone={TYPE_TONE[e.type]}>{e.type}</Pill>
                      {e.deletable && (
                        <button
                          onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); setDeleteTarget(e); }}
                          title="Delete event"
                          className="shrink-0 size-6 rounded-md grid place-items-center hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                      {e.type === "Personal" && (
                        <button
                          onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); deleteReminder.mutate(e.id); }}
                          disabled={deleteReminder.isPending}
                          className="size-7 grid place-items-center rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors shrink-0"
                          title="Delete reminder"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </>
                  );
                  const className = "py-3 flex items-start gap-3 hover:bg-surface-muted rounded-lg px-2 -mx-2 transition-colors";
                  return (
                    <li key={e.id}>
                      {e.to ? <Link to={e.to} className={className}>{content}</Link> : <div className={className}>{content}</div>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </Section>
      </div>

      <Section
        title="Next 90 days"
        subtitle={`${events.length} upcoming events`}
        action={events.length > INLINE_LIMIT ? (
          <button onClick={() => setViewAllOpen(true)} className="text-xs text-primary hover:underline">View all</button>
        ) : undefined}
      >
        <Panel padded={false}>
          {events.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              <CalendarClock className="size-5 mx-auto mb-2 opacity-50" />
              No upcoming events in this window.
            </div>
          ) : (
            <ul>
              {events.slice(0, INLINE_LIMIT).map((e) => <EventRow key={e.id} event={e} onDelete={setDeleteTarget} />)}
            </ul>
          )}
        </Panel>
      </Section>

      <Dialog open={viewAllOpen} onOpenChange={setViewAllOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>All upcoming events</DialogTitle>
            <DialogDescription>{events.length} events in the next 90 days</DialogDescription>
          </DialogHeader>
          <ul className="overflow-y-auto scrollbar-thin -mx-2">
            {events.map((e) => <EventRow key={e.id} event={e} onDelete={setDeleteTarget} />)}
          </ul>
        </DialogContent>
      </Dialog>

      {addOpen && <AddEventModal onClose={() => setAddOpen(false)} />}

      {addReminderOpen && (
        <AddReminderModal
          defaultDate={selectedKey}
          onClose={() => setAddReminderOpen(false)}
          onAdded={() => { setAddReminderOpen(false); queryClient.invalidateQueries({ queryKey: ["calendar-events"] }); }}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete this event?"
        description={deleteTarget ? `"${deleteTarget.title}" will be permanently removed from the calendar.` : ""}
        confirmLabel="Delete Event"
        isPending={deleteMutation.isPending}
        onConfirm={() => { if (deleteTarget) deleteMutation.mutate(deleteTarget.id); }}
      />
    </div>
  );
}

function AddReminderModal({ defaultDate, onClose, onAdded }: { defaultDate?: string; onClose: () => void; onAdded: () => void }) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(defaultDate ?? new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => coreApi.createPersonalEvent({ title, date, note: note || undefined }),
    onSuccess: () => onAdded(),
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not add reminder."),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/60 backdrop-blur-sm animate-fade-in p-4" onClick={onClose}>
      <div className="w-full max-w-sm bg-card border border-border rounded-lg shadow-2xl animate-scale-in" onClick={(e) => e.stopPropagation()}>
        <div className="h-12 px-4 border-b border-border flex items-center justify-between">
          <div className="text-sm font-semibold">Add Personal Reminder</div>
          <button onClick={onClose} className="size-8 grid place-items-center rounded hover:bg-surface-muted"><X className="size-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          <label className="block">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Title</div>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Doctor appointment" className="w-full h-9 px-3 rounded-md border border-border bg-surface text-sm focus:outline-none focus:ring-2 focus:ring-ring/30" />
          </label>
          <label className="block">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Date</div>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full h-9 px-3 rounded-md border border-border bg-surface text-sm focus:outline-none focus:ring-2 focus:ring-ring/30" />
          </label>
          <label className="block">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Note (optional)</div>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="w-full px-3 py-2 rounded-md border border-border bg-surface text-sm focus:outline-none focus:ring-2 focus:ring-ring/30" />
          </label>
          {error && <div className="text-xs text-destructive">{error}</div>}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={onClose} className="h-9 px-3 rounded-md border border-border bg-card text-sm hover:bg-surface-muted">Cancel</button>
            <button
              onClick={() => { setError(null); create.mutate(); }}
              disabled={!title || !date || create.isPending}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-95 disabled:opacity-50 inline-flex items-center gap-2"
            >
              {create.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EventRow({ event: e, onDelete }: { event: CalendarEvent; onDelete?: (e: CalendarEvent) => void }) {
  const Icon = TYPE_ICON[e.type];
  const content = (
    <>
      <Icon className="size-3.5 text-muted-foreground shrink-0" />
      <span className="text-xs text-muted-foreground w-24 shrink-0">
        {new Date(`${e.date}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
      </span>
      <span className="text-sm truncate flex-1">{e.title}</span>
      <Pill tone={TYPE_TONE[e.type]}>{e.type}</Pill>
      {e.deletable && onDelete && (
        <button
          onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); onDelete(e); }}
          title="Delete event"
          className="shrink-0 size-6 rounded-md grid place-items-center hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </>
  );
  const className = "px-4 py-2.5 flex items-center gap-3 hover:bg-surface-muted transition-colors";
  return (
    <li>
      {e.to ? <Link to={e.to} className={className}>{content}</Link> : <div className={className}>{content}</div>}
    </li>
  );
}

function AddEventModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [type, setType] = useState<(typeof CUSTOM_EVENT_TYPES)[number]>("Notice");
  const [department, setDepartment] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () => coreApi.createCalendarEvent({ title, date, type, department: department || undefined, note: note || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Failed to create event."),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Calendar Event</DialogTitle>
          <DialogDescription>Create a freeform HR entry — meeting, deadline, holiday, or notice.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Zonal Officers Review Meeting"
              className="mt-1 w-full h-9 px-3 rounded-md bg-card border border-border text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="mt-1 w-full h-9 px-3 rounded-md bg-card border border-border text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Type</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as (typeof CUSTOM_EVENT_TYPES)[number])}
                className="mt-1 w-full h-9 px-3 rounded-md bg-card border border-border text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {CUSTOM_EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Department (optional)</label>
            <input
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              placeholder="Leave blank for org-wide"
              className="mt-1 w-full h-9 px-3 rounded-md bg-card border border-border text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Note (optional)</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="mt-1 w-full px-3 py-2 rounded-md bg-card border border-border text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <button onClick={onClose} className="h-9 px-3 rounded-md text-sm hover:bg-surface-muted transition-colors">Cancel</button>
          <button
            disabled={!title || !date || createMutation.isPending}
            onClick={() => createMutation.mutate()}
            className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-95 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {createMutation.isPending ? "Adding…" : "Add Event"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
