import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldCheck, X, Check } from "lucide-react";
import { Section, Panel, Pill } from "@/components/layout/section";
import { FilterPill } from "@/components/ui/filter-pill";
import { coreApi, ApiError } from "@/lib/api-client";

export const Route = createFileRoute("/privacy")({
  head: () => ({ meta: [{ title: "Data Rights Center · AWIP" }] }),
  component: PrivacyPage,
});

type PrivacyRequest = {
  id: string; type: string; description: string; status: string; notes: string | null;
  createdAt: string; employeeId: string; employeeName?: string;
};

function statusTone(status: string) {
  return status === "Resolved" ? "success" : status === "In Progress" ? "warning" : "neutral";
}

function PrivacyPage() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<PrivacyRequest | null>(null);
  const [filter, setFilter] = useState<"All" | "New" | "In Progress" | "Resolved">("All");

  const { data: resp, isLoading, isError } = useQuery({
    queryKey: ["privacy-requests"],
    queryFn: () => coreApi.getPrivacyRequests(),
  });
  const requests = (resp?.data ?? []) as PrivacyRequest[];
  const filtered = filter === "All" ? requests : requests.filter((r) => r.status === filter);

  const openCount = requests.filter((r) => r.status !== "Resolved").length;

  return (
    <div className="min-h-full bg-gradient-to-br from-background via-background to-primary-soft/40 px-5 py-4 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="size-9 rounded-lg bg-primary/10 text-primary grid place-items-center"><ShieldCheck className="size-4.5" /></div>
          <div>
            <div className="text-lg font-semibold tracking-tight">Data Rights Center</div>
            <div className="text-xs text-muted-foreground">DPDP Act 2023 — employee access/correction/erasure requests, and consent scope on file</div>
          </div>
        </div>
        <Pill tone={openCount > 0 ? "warning" : "success"}>{openCount} open request(s)</Pill>
      </div>

      <Panel className="mb-4 text-xs leading-relaxed text-muted-foreground">
        <span className="font-semibold text-foreground">Notice & Consent (DPDP Sections 5–6):</span> employees are informed, before any
        biometric/HR data is collected, of the exact purpose (attendance verification, payroll, pension) and may request access,
        correction, or erasure at any time via My Data & Privacy. Biometric verification tokens — never raw photographs — are purged
        on termination/superannuation once statutory retention periods (tax, pension) lapse.
      </Panel>

      <Section
        title="Requests"
        action={
          <FilterPill value={filter} onChange={(v) => setFilter(v as typeof filter)} options={["All", "New", "In Progress", "Resolved"]} label="All" />
        }
      >
        {isLoading ? (
          <div className="p-6 flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
        ) : isError ? (
          <Panel><div className="text-sm text-destructive text-center py-4">Could not load privacy requests.</div></Panel>
        ) : filtered.length === 0 ? (
          <Panel><div className="text-sm text-muted-foreground text-center py-4">No requests match this filter.</div></Panel>
        ) : (
          <Panel padded={false} className="divide-y divide-border/60">
            {filtered.map((r) => (
              <button key={r.id} onClick={() => setSelected(r)} className="w-full text-left p-4 flex items-start justify-between gap-3 hover:bg-surface-muted transition-colors">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{r.employeeName ?? r.employeeId} — {r.type} request</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{r.id} · {new Date(r.createdAt).toLocaleDateString("en-IN")}</div>
                  <div className="text-xs text-muted-foreground mt-1.5 line-clamp-1">{r.description}</div>
                </div>
                <Pill tone={statusTone(r.status)}>{r.status}</Pill>
              </button>
            ))}
          </Panel>
        )}
      </Section>

      {selected && (
        <ResolveModal
          request={selected}
          onClose={() => setSelected(null)}
          onSaved={() => { setSelected(null); queryClient.invalidateQueries({ queryKey: ["privacy-requests"] }); }}
        />
      )}
    </div>
  );
}

function ResolveModal({ request, onClose, onSaved }: { request: PrivacyRequest; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState(request.status);
  const [notes, setNotes] = useState(request.notes ?? "");
  const [error, setError] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: () => coreApi.updatePrivacyRequestStatus(request.id, { status, notes }),
    onSuccess: () => onSaved(),
    onError: (err) => setError(err instanceof ApiError ? err.message : "Failed to update request."),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/60 backdrop-blur-sm animate-fade-in p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-card border border-border rounded-lg shadow-2xl animate-scale-in max-h-[90vh] overflow-y-auto scrollbar-thin" onClick={(e) => e.stopPropagation()}>
        <div className="h-12 px-4 border-b border-border flex items-center justify-between sticky top-0 bg-card z-10">
          <div className="text-sm font-semibold">{request.employeeName ?? request.employeeId} — {request.type} request</div>
          <button onClick={onClose} className="size-8 grid place-items-center rounded hover:bg-surface-muted"><X className="size-4" /></button>
        </div>

        <div className="p-5 space-y-3">
          <div className="text-xs text-muted-foreground bg-surface-muted rounded-md p-3">{request.description}</div>

          <label className="block">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Status</div>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full h-9 px-2 rounded-md border border-border bg-surface text-sm">
              <option value="New">New</option>
              <option value="In Progress">In Progress</option>
              <option value="Resolved">Resolved</option>
            </select>
          </label>
          <label className="block">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Note to employee</div>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="What did you do to resolve this?" className="w-full px-3 py-2 rounded-md border border-border bg-surface text-sm focus:outline-none focus:ring-2 focus:ring-ring/30" />
          </label>

          {error && <div className="text-xs text-destructive">{error}</div>}

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
            <button onClick={onClose} className="h-9 px-3 rounded-md border border-border bg-card text-sm hover:bg-surface-muted">Cancel</button>
            <button
              onClick={() => { setError(null); update.mutate(); }}
              disabled={update.isPending}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-95 disabled:opacity-50 inline-flex items-center gap-2"
            >
              {update.isPending && <Loader2 className="size-3.5 animate-spin" />}
              {!update.isPending && <Check className="size-3.5" />}
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
