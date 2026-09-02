import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Siren, X, Loader2, CheckCircle2 } from "lucide-react";
import { coreApi, aiApi } from "@/lib/api-client";
import { DEPARTMENTS } from "@/lib/departments";
import { NotifyAuthorityPanel } from "@/components/emergency/notify-authority-panel";

const CATEGORIES = ["Fire", "Flood/Waterlogging", "Structural Failure", "Public Health Hazard", "Electrical Hazard", "Road/Traffic Hazard", "Other"];
const SEVERITIES = ["Critical", "High", "Medium"];

export function EmergencyAlertModal({ defaultDepartment, onClose, onCreated }: {
  defaultDepartment?: string;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [department, setDepartment] = useState(defaultDepartment && defaultDepartment !== "All Departments" ? defaultDepartment : DEPARTMENTS[1]);
  const [location, setLocation] = useState("");
  const [severity, setSeverity] = useState(SEVERITIES[0]);
  const [createdAlert, setCreatedAlert] = useState<any | null>(null);

  const createMutation = useMutation({
    mutationFn: () => coreApi.createEmergencyAlert({ category, title, description, department, location: location || undefined, severity }),
    onSuccess: (alert) => {
      setCreatedAlert(alert);
      onCreated?.();
    },
  });

  const draftQuery = useQuery({
    queryKey: ["emergency-draft", createdAlert?.id],
    queryFn: () => aiApi.draftEmergencyMessage({ title, description, category, department, severity, location: location || null }),
    enabled: !!createdAlert,
  });

  const logChannel = (channel: "Email" | "WhatsApp") => {
    if (!createdAlert) return;
    coreApi.updateEmergencyAlertStatus(createdAlert.id, { status: createdAlert.status, channel, note: `Authority notified via ${channel}.` });
  };

  const canSubmit = title.trim() && description.trim() && department;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-card border border-border rounded-lg shadow-2xl max-h-[85vh] overflow-y-auto scrollbar-thin" onClick={(e) => e.stopPropagation()}>
        <div className="h-12 px-4 border-b border-border flex items-center justify-between sticky top-0 bg-card z-10">
          <div className="text-sm font-semibold flex items-center gap-1.5"><Siren className="size-4 text-destructive" /> Raise Emergency Alert</div>
          <button onClick={onClose} className="size-8 grid place-items-center rounded hover:bg-surface-muted"><X className="size-4" /></button>
        </div>

        <div className="p-5">
          {!createdAlert ? (
            <div className="space-y-3">
              <Field label="Category">
                <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full h-9 px-2 rounded-md bg-surface border border-border text-sm">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Title">
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Waterlogging blocking arterial road"
                  className="w-full h-9 px-2 rounded-md bg-surface border border-border text-sm" />
              </Field>
              <Field label="Description">
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="What's happening, and why it needs immediate attention…"
                  className="w-full px-2 py-1.5 rounded-md bg-surface border border-border text-sm resize-none" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Department">
                  <select value={department} onChange={(e) => setDepartment(e.target.value)} className="w-full h-9 px-2 rounded-md bg-surface border border-border text-sm">
                    {DEPARTMENTS.filter((d) => d !== "All Departments").map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </Field>
                <Field label="Severity">
                  <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="w-full h-9 px-2 rounded-md bg-surface border border-border text-sm">
                    {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Location (optional)">
                <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Ring Road, Ward 12"
                  className="w-full h-9 px-2 rounded-md bg-surface border border-border text-sm" />
              </Field>

              {createMutation.isError && (
                <div className="text-xs text-destructive">Could not raise the alert. Is the AWIP core server running?</div>
              )}

              <button
                onClick={() => createMutation.mutate()}
                disabled={!canSubmit || createMutation.isPending}
                className="w-full h-9 rounded-md bg-destructive text-destructive-foreground text-sm font-semibold hover:opacity-90 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
              >
                {createMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Siren className="size-3.5" />}
                Raise Alert & Notify Authority
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-success bg-success/10 border border-success/20 rounded-md p-2.5">
                <CheckCircle2 className="size-4 shrink-0" />
                Alert <span className="font-semibold">{createdAlert.id}</span> raised — this is your acknowledgement number.
              </div>
              <NotifyAuthorityPanel
                department={department}
                draft={draftQuery.data}
                isLoading={draftQuery.isLoading}
                isError={draftQuery.isError}
                onChannelUsed={logChannel}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </label>
  );
}
