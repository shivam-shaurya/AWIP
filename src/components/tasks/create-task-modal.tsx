import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Sparkles, Wand2, Loader2, Plus, Trash2 } from "lucide-react";
import { Pill } from "@/components/layout/section";
import { DEPARTMENTS } from "@/lib/departments";
import { coreApi, ApiError } from "@/lib/api-client";

type TaskRow = {
  title: string;
  description: string;
  sow: string;
  priority: string;
  employeeId: string;
  eta: string;
  projectedCompletion: string;
  milestone: string;
};

const emptyRow = (): TaskRow => ({
  title: "", description: "", sow: "", priority: "Medium",
  employeeId: "", eta: "", projectedCompletion: "", milestone: "",
});

export function CreateTaskModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [project, setProject] = useState("");
  const [department, setDepartment] = useState<string>(DEPARTMENTS[1] ?? "Engineering");
  const [rows, setRows] = useState<TaskRow[]>([emptyRow()]);
  const [error, setError] = useState<string | null>(null);

  const { data: employeesResponse } = useQuery({
    queryKey: ["employees", "All Departments"],
    queryFn: () => coreApi.getEmployees(),
  });
  const employees = employeesResponse?.data ?? [];

  const { data: workloadResponse } = useQuery({
    queryKey: ["employee-workload"],
    queryFn: () => coreApi.getEmployeeWorkload(),
  });
  const workloadByEmployeeId = useMemo(() => {
    const map = new Map<string, number>();
    for (const w of workloadResponse?.data ?? []) map.set(w.employeeId, w.openTaskCount);
    return map;
  }, [workloadResponse]);

  // Least-loaded officers first, so the picker itself nudges toward balanced
  // workload distribution instead of a plain alphabetical list.
  const officersByLoad = useMemo(() => {
    return [...employees]
      .map((e: any) => ({ ...e, openTaskCount: workloadByEmployeeId.get(e.id) ?? 0 }))
      .sort((a, b) => a.openTaskCount - b.openTaskCount);
  }, [employees, workloadByEmployeeId]);

  const createTasks = useMutation({
    mutationFn: () =>
      coreApi.createTasksBulk({
        project,
        department,
        tasks: rows.map((r) => ({
          title: r.title,
          category: "Inspection",
          employeeId: r.employeeId,
          priority: r.priority,
          sow: r.sow || undefined,
          milestone: r.milestone || undefined,
          eta: r.eta || undefined,
          projectedCompletion: r.projectedCompletion || undefined,
        })),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Failed to create task(s)."),
  });

  const updateRow = (i: number, patch: Partial<TaskRow>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const addRow = () => setRows((prev) => [...prev, emptyRow()]);
  const removeRow = (i: number) => setRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));

  const applySuggestion = (i: number) => {
    const row = rows[i];
    const suggestion = recommend(row.title + " " + row.description);
    setDepartment(suggestion.department);
    const patch: Partial<TaskRow> = { priority: suggestion.priority };
    if (!row.eta) {
      const d = new Date();
      d.setDate(d.getDate() + suggestion.tatDays);
      patch.eta = d.toISOString().slice(0, 10);
    }
    if (!row.milestone) patch.milestone = suggestion.milestone;
    updateRow(i, patch);
  };

  const canSubmit = !!project && rows.every((r) => r.title && r.employeeId) && !createTasks.isPending;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/60 backdrop-blur-sm animate-fade-in p-4" onClick={onClose}>
      <div className="w-full max-w-4xl bg-card rounded-2xl shadow-[0_8px_40px_rgba(0,93,94,0.18)] animate-scale-in max-h-[90vh] overflow-y-auto scrollbar-thin" onClick={(e) => e.stopPropagation()}>
        <div className="h-12 px-5 flex items-center justify-between sticky top-0 bg-card z-10">
          <div className="text-sm font-semibold">Create Task{rows.length > 1 ? "s" : ""}</div>
          <button onClick={onClose} className="size-8 grid place-items-center rounded-lg hover:bg-surface-muted"><X className="size-4" /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Shared project details */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Project Name">
              <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="e.g. Road Repair at SG Highway" className="w-full h-9 px-3 rounded-lg bg-surface-muted text-sm focus:outline-none focus:ring-2 focus:ring-ring/30" />
            </Field>
            <Field label="Department">
              <select value={department} onChange={(e) => setDepartment(e.target.value)} className="w-full h-9 px-2 rounded-lg bg-surface-muted text-sm">
                {DEPARTMENTS.slice(1).map((d) => <option key={d}>{d}</option>)}
              </select>
            </Field>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Add one or more tasks below — they'll all be created under this project in one go.
          </p>

          {/* Repeatable task rows */}
          <div className="space-y-3">
            {rows.map((row, i) => (
              <div key={i} className="rounded-xl p-3 space-y-3 bg-surface-muted/60">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">Task {i + 1}</span>
                  {rows.length > 1 && (
                    <button onClick={() => removeRow(i)} className="p-1 rounded hover:bg-destructive/10 text-destructive" title="Remove task">
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Field label="Task Title">
                    <input value={row.title} onChange={(e) => updateRow(i, { title: e.target.value })} placeholder="e.g. Site inspection and damage report" className="w-full h-9 px-3 rounded-lg bg-surface-muted text-sm focus:outline-none focus:ring-2 focus:ring-ring/30" />
                  </Field>
                  <Field label="Assigned Officer">
                    <select value={row.employeeId} onChange={(e) => updateRow(i, { employeeId: e.target.value })} className="w-full h-9 px-2 rounded-lg bg-surface-muted text-sm">
                      <option value="">Select an employee…</option>
                      {officersByLoad.map((e: any) => (
                        <option key={e.id} value={e.id}>
                          {e.name} · {e.designation} ({e.openTaskCount} open)
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                <Field label="Description">
                  <textarea value={row.description} onChange={(e) => updateRow(i, { description: e.target.value })} rows={2} className="w-full px-3 py-2 rounded-lg bg-surface-muted text-sm focus:outline-none focus:ring-2 focus:ring-ring/30" />
                </Field>
                <Field label="Scope of Work (SOW)">
                  <textarea value={row.sow} onChange={(e) => updateRow(i, { sow: e.target.value })} rows={2} placeholder="Define the scope, deliverables, and boundaries of this task" className="w-full px-3 py-2 rounded-lg bg-surface-muted text-sm focus:outline-none focus:ring-2 focus:ring-ring/30" />
                </Field>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Field label="Priority">
                    <select value={row.priority} onChange={(e) => updateRow(i, { priority: e.target.value })} className="w-full h-9 px-2 rounded-lg bg-surface-muted text-sm">
                      {["High", "Medium", "Low"].map((p) => <option key={p}>{p}</option>)}
                    </select>
                  </Field>
                  <Field label="ETA">
                    <input type="date" value={row.eta} onChange={(e) => updateRow(i, { eta: e.target.value })} className="w-full h-9 px-3 rounded-lg bg-surface-muted text-sm" />
                  </Field>
                  <Field label="Projected Completion">
                    <input type="date" value={row.projectedCompletion} onChange={(e) => updateRow(i, { projectedCompletion: e.target.value })} className="w-full h-9 px-3 rounded-lg bg-surface-muted text-sm" />
                  </Field>
                  <Field label="Milestone">
                    <input value={row.milestone} onChange={(e) => updateRow(i, { milestone: e.target.value })} placeholder="e.g. Site Survey Complete" className="w-full h-9 px-3 rounded-lg bg-surface-muted text-sm focus:outline-none focus:ring-2 focus:ring-ring/30" />
                  </Field>
                </div>

                <button onClick={() => applySuggestion(i)} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-primary text-primary-foreground text-xs hover:opacity-95">
                  <Sparkles className="size-3.5" /> Apply AI Suggestion <Wand2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>

          <button onClick={addRow} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-surface-muted text-xs font-medium hover:bg-surface-muted/70">
            <Plus className="size-3.5" /> Add another task to this project
          </button>
        </div>

        <div className="px-5 pb-5 pt-3 flex items-center justify-end gap-2">
          {error && <div className="mr-auto text-xs text-destructive">{error}</div>}
          <button onClick={onClose} className="h-9 px-3 rounded-lg bg-surface-muted text-sm hover:bg-surface-muted/70">Cancel</button>
          <button
            onClick={() => { setError(null); createTasks.mutate(); }}
            disabled={!canSubmit}
            className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium shadow-[0_4px_24px_rgba(0,93,94,0.15)] hover:opacity-95 disabled:opacity-50 inline-flex items-center gap-2"
          >
            {createTasks.isPending && <Loader2 className="size-3.5 animate-spin" />}
            Create {rows.length > 1 ? `${rows.length} Tasks` : "Task"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
      {children}
    </label>
  );
}

function recommend(text: string) {
  const t = text.toLowerCase();
  if (/road|highway|pothole|street/.test(t)) return { department: "Roads & Buildings", priority: "High", tatDays: 7, officer: "Assistant Engineer", milestone: "Site Survey Complete" };
  if (/health|hospital|epidemic|sanitiz/.test(t)) return { department: "Health", priority: "High", tatDays: 5, officer: "Medical Officer", milestone: "Inspection Complete" };
  if (/drain|sewage|water|flood/.test(t)) return { department: "Water Supply", priority: "High", tatDays: 6, officer: "Executive Engineer", milestone: "Pre-monsoon Audit Complete" };
  if (/property|tax|survey/.test(t)) return { department: "Revenue", priority: "Medium", tatDays: 10, officer: "Tax Officer", milestone: "Survey Complete" };
  if (/garbage|waste|swachh/.test(t)) return { department: "Solid Waste Management", priority: "Medium", tatDays: 4, officer: "Sanitary Inspector", milestone: "Route Audit Complete" };
  if (/tree|plant|garden|park/.test(t)) return { department: "Parks & Gardens", priority: "Low", tatDays: 14, officer: "Horticulture Officer", milestone: "Kickoff" };
  if (/building|permission|approv/.test(t)) return { department: "Town Planning", priority: "Medium", tatDays: 12, officer: "Town Planner", milestone: "Draft Report Submitted" };
  return { department: "Administration", priority: "Medium", tatDays: 7, officer: "Section Officer", milestone: "Kickoff" };
}
