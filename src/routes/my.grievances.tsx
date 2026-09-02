import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageSquareWarning, Plus, X, Check } from "lucide-react";
import { Section, Panel, Pill } from "@/components/layout/section";
import { coreApi, ApiError } from "@/lib/api-client";
import { useAuth } from "@/context/auth-context";
import { DEPARTMENTS } from "@/lib/departments";

export const Route = createFileRoute("/my/grievances")({
  head: () => ({ meta: [{ title: "My Grievances · AWIP" }] }),
  component: MyGrievancesPage,
});

const CATEGORIES = ["Harassment", "Payroll", "Facilities", "Management", "Peer Conflict"];

function statusTone(status: string) {
  return status === "Resolved" ? "success" : status === "Escalated" ? "destructive" : "warning";
}

function MyGrievancesPage() {
  const { user } = useAuth();
  const employeeId = user?.employeeId ?? "";
  const queryClient = useQueryClient();
  const [fileOpen, setFileOpen] = useState(false);

  const { data: grievancesResp, isLoading, isError } = useQuery({
    queryKey: ["grievances", "self", employeeId],
    queryFn: () => coreApi.getGrievances(),
    enabled: !!employeeId,
  });
  const grievances = (grievancesResp?.data ?? []) as { id: string; category: string; subject: string; description: string; severity: string; status: string; createdAt: string; isAnonymous: boolean }[];

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["grievances", "self", employeeId] });

  return (
    <div className="min-h-full bg-gradient-to-br from-background via-background to-primary-soft/40 px-5 py-4 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="size-9 rounded-lg bg-primary/10 text-primary grid place-items-center"><MessageSquareWarning className="size-4.5" /></div>
          <div>
            <div className="text-lg font-semibold tracking-tight">My Grievances</div>
            <div className="text-xs text-muted-foreground">File a grievance and track its status — visible only to you and HR</div>
          </div>
        </div>
        <button
          onClick={() => setFileOpen(true)}
          disabled={!employeeId}
          className="h-9 px-3 inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-95 disabled:opacity-50"
        >
          <Plus className="size-3.5" /> File a Grievance
        </button>
      </div>

      <Section title="Filed grievances">
        {isLoading ? (
          <div className="p-6 flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
        ) : isError ? (
          <Panel><div className="text-sm text-destructive text-center py-4">Could not load your grievances.</div></Panel>
        ) : grievances.length === 0 ? (
          <Panel><div className="text-sm text-muted-foreground text-center py-4">You haven't filed any grievances yet.</div></Panel>
        ) : (
          <Panel padded={false} className="divide-y divide-border/60">
            {grievances.map((g) => (
              <div key={g.id} className="p-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{g.subject}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{g.category} · {new Date(g.createdAt).toLocaleDateString("en-IN")}{g.isAnonymous ? " · Filed anonymously" : ""}</div>
                  <div className="text-xs text-muted-foreground mt-1.5 line-clamp-2">{g.description}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Pill tone={g.severity === "Critical" ? "destructive" : "neutral"}>{g.severity}</Pill>
                  <Pill tone={statusTone(g.status)}>{g.status}</Pill>
                </div>
              </div>
            ))}
          </Panel>
        )}
      </Section>

      {fileOpen && employeeId && (
        <FileGrievanceModal
          employeeId={employeeId}
          onClose={() => setFileOpen(false)}
          onFiled={() => { setFileOpen(false); refresh(); }}
        />
      )}
    </div>
  );
}

function FileGrievanceModal({ employeeId, onClose, onFiled }: { employeeId: string; onClose: () => void; onFiled: () => void }) {
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [department, setDepartment] = useState<string>(DEPARTMENTS[1] ?? "Engineering");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileGrievance = useMutation({
    mutationFn: () => coreApi.createGrievance({ category, subject, description, department, isAnonymous, submitterId: employeeId }),
    onSuccess: () => onFiled(),
    onError: (err) => setError(err instanceof ApiError ? err.message : "Failed to file grievance."),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/60 backdrop-blur-sm animate-fade-in p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-card border border-border rounded-lg shadow-2xl animate-scale-in max-h-[90vh] overflow-y-auto scrollbar-thin" onClick={(e) => e.stopPropagation()}>
        <div className="h-12 px-4 border-b border-border flex items-center justify-between sticky top-0 bg-card z-10">
          <div className="text-sm font-semibold">File a Grievance</div>
          <button onClick={onClose} className="size-8 grid place-items-center rounded hover:bg-surface-muted"><X className="size-4" /></button>
        </div>

        <div className="p-5 space-y-3">
          <label className="block">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Category</div>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full h-9 px-2 rounded-md border border-border bg-surface text-sm">
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label className="block">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Department this concerns</div>
            <select value={department} onChange={(e) => setDepartment(e.target.value)} className="w-full h-9 px-2 rounded-md border border-border bg-surface text-sm">
              {DEPARTMENTS.slice(1).map((d) => <option key={d}>{d}</option>)}
            </select>
          </label>
          <label className="block">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Subject</div>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Brief summary of the issue" className="w-full h-9 px-3 rounded-md border border-border bg-surface text-sm focus:outline-none focus:ring-2 focus:ring-ring/30" />
          </label>
          <label className="block">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Description</div>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="Describe what happened in detail" className="w-full px-3 py-2 rounded-md border border-border bg-surface text-sm focus:outline-none focus:ring-2 focus:ring-ring/30" />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isAnonymous} onChange={(e) => setIsAnonymous(e.target.checked)} className="size-4 rounded border-border" />
            File anonymously (HR won't see your name attached)
          </label>

          {error && <div className="text-xs text-destructive">{error}</div>}

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
            <button onClick={onClose} className="h-9 px-3 rounded-md border border-border bg-card text-sm hover:bg-surface-muted">Cancel</button>
            <button
              onClick={() => { setError(null); fileGrievance.mutate(); }}
              disabled={!subject || !description || fileGrievance.isPending}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-95 disabled:opacity-50 inline-flex items-center gap-2"
            >
              {fileGrievance.isPending && <Loader2 className="size-3.5 animate-spin" />}
              {!fileGrievance.isPending && <Check className="size-3.5" />}
              Submit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
