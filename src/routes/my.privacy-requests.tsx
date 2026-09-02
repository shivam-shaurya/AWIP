import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldCheck, Plus, X, Check } from "lucide-react";
import { Section, Panel, Pill } from "@/components/layout/section";
import { coreApi, ApiError } from "@/lib/api-client";
import { useAuth } from "@/context/auth-context";

export const Route = createFileRoute("/my/privacy-requests")({
  head: () => ({ meta: [{ title: "My Data & Privacy · AWIP" }] }),
  component: MyPrivacyRequestsPage,
});

const TYPES = ["Access", "Correction", "Erasure"] as const;
const TYPE_HELP: Record<(typeof TYPES)[number], string> = {
  Access: "Get a copy of the personal/HR data AWIP holds about you.",
  Correction: "Ask HR to fix an incorrect or outdated field in your record.",
  Erasure: "Ask HR to delete personal data no longer required to be kept (subject to statutory retention rules).",
};

function statusTone(status: string) {
  return status === "Resolved" ? "success" : status === "In Progress" ? "warning" : "neutral";
}

function MyPrivacyRequestsPage() {
  const { user } = useAuth();
  const employeeId = user?.employeeId ?? "";
  const queryClient = useQueryClient();
  const [fileOpen, setFileOpen] = useState(false);

  const { data: resp, isLoading, isError } = useQuery({
    queryKey: ["privacy-requests", "self", employeeId],
    queryFn: () => coreApi.getPrivacyRequests(),
    enabled: !!employeeId,
  });
  const requests = (resp?.data ?? []) as { id: string; type: string; description: string; status: string; notes: string | null; createdAt: string }[];

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["privacy-requests", "self", employeeId] });

  return (
    <div className="min-h-full bg-gradient-to-br from-background via-background to-primary-soft/40 px-5 py-4 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="size-9 rounded-lg bg-primary/10 text-primary grid place-items-center"><ShieldCheck className="size-4.5" /></div>
          <div>
            <div className="text-lg font-semibold tracking-tight">My Data & Privacy</div>
            <div className="text-xs text-muted-foreground">Request access to, correction of, or erasure of your personal data — under the DPDP Act, 2023</div>
          </div>
        </div>
        <button
          onClick={() => setFileOpen(true)}
          disabled={!employeeId}
          className="h-9 px-3 inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-95 disabled:opacity-50"
        >
          <Plus className="size-3.5" /> New Request
        </button>
      </div>

      <Panel className="mb-4 text-xs leading-relaxed text-muted-foreground">
        <span className="font-semibold text-foreground">What we collect and why:</span> AWIP stores your service-book records,
        attendance, performance ratings, leave/insurance details, and (where enrolled) a biometric verification token — never a raw
        photograph. This data is used only for HR administration, payroll, and pension processing, and is retained only as long as
        statutory rules (tax, pension) require.
      </Panel>

      <Section title="Your requests">
        {isLoading ? (
          <div className="p-6 flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
        ) : isError ? (
          <Panel><div className="text-sm text-destructive text-center py-4">Could not load your requests.</div></Panel>
        ) : requests.length === 0 ? (
          <Panel><div className="text-sm text-muted-foreground text-center py-4">You haven't filed any data-rights requests yet.</div></Panel>
        ) : (
          <Panel padded={false} className="divide-y divide-border/60">
            {requests.map((r) => (
              <div key={r.id} className="p-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{r.type} request</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{new Date(r.createdAt).toLocaleDateString("en-IN")}</div>
                  <div className="text-xs text-muted-foreground mt-1.5 line-clamp-2">{r.description}</div>
                  {r.notes && <div className="text-xs text-foreground/80 mt-1.5"><span className="font-medium">HR note:</span> {r.notes}</div>}
                </div>
                <Pill tone={statusTone(r.status)}>{r.status}</Pill>
              </div>
            ))}
          </Panel>
        )}
      </Section>

      {fileOpen && employeeId && (
        <FilePrivacyRequestModal onClose={() => setFileOpen(false)} onFiled={() => { setFileOpen(false); refresh(); }} />
      )}
    </div>
  );
}

function FilePrivacyRequestModal({ onClose, onFiled }: { onClose: () => void; onFiled: () => void }) {
  const [type, setType] = useState<(typeof TYPES)[number]>("Access");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const fileRequest = useMutation({
    mutationFn: () => coreApi.createPrivacyRequest({ type, description }),
    onSuccess: () => onFiled(),
    onError: (err) => setError(err instanceof ApiError ? err.message : "Failed to file request."),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/60 backdrop-blur-sm animate-fade-in p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-card border border-border rounded-lg shadow-2xl animate-scale-in max-h-[90vh] overflow-y-auto scrollbar-thin" onClick={(e) => e.stopPropagation()}>
        <div className="h-12 px-4 border-b border-border flex items-center justify-between sticky top-0 bg-card z-10">
          <div className="text-sm font-semibold">New Data-Rights Request</div>
          <button onClick={onClose} className="size-8 grid place-items-center rounded hover:bg-surface-muted"><X className="size-4" /></button>
        </div>

        <div className="p-5 space-y-3">
          <label className="block">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Request type</div>
            <select value={type} onChange={(e) => setType(e.target.value as (typeof TYPES)[number])} className="w-full h-9 px-2 rounded-md border border-border bg-surface text-sm">
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <p className="text-[11px] text-muted-foreground mt-1">{TYPE_HELP[type]}</p>
          </label>
          <label className="block">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Details</div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="What specifically are you asking for? (e.g. which field is wrong, what data you want a copy of)"
              className="w-full px-3 py-2 rounded-md border border-border bg-surface text-sm focus:outline-none focus:ring-2 focus:ring-ring/30"
            />
          </label>

          {error && <div className="text-xs text-destructive">{error}</div>}

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
            <button onClick={onClose} className="h-9 px-3 rounded-md border border-border bg-card text-sm hover:bg-surface-muted">Cancel</button>
            <button
              onClick={() => { setError(null); fileRequest.mutate(); }}
              disabled={!description || fileRequest.isPending}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-95 disabled:opacity-50 inline-flex items-center gap-2"
            >
              {fileRequest.isPending && <Loader2 className="size-3.5 animate-spin" />}
              {!fileRequest.isPending && <Check className="size-3.5" />}
              Submit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
