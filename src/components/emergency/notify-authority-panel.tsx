import { useQuery } from "@tanstack/react-query";
import { Loader2, Copy, Check, Mail, MessageCircle, UserRound } from "lucide-react";
import { useState } from "react";
import { coreApi } from "@/lib/api-client";

/**
 * Shared "AI drafts a message, then hand off to a real channel" panel used by
 * both Emergency Alerts and the Grievance draft-response flow. There is no
 * SMTP/WhatsApp API in this app — "sending" means opening the user's own
 * mail client (mailto:) or WhatsApp (wa.me), addressed to a real,
 * contactable department authority resolved from actual Employee records
 * (not the fabricated DepartmentProfile.headName).
 */
export function NotifyAuthorityPanel({
  department,
  draft,
  isLoading,
  isError,
  onChannelUsed,
}: {
  department: string;
  draft: { subject: string; body: string } | undefined;
  isLoading: boolean;
  isError: boolean;
  onChannelUsed?: (channel: "Email" | "WhatsApp") => void;
}) {
  const [copied, setCopied] = useState(false);

  const { data: authority, isLoading: authorityLoading } = useQuery({
    queryKey: ["department-authority", department],
    queryFn: () => coreApi.getDepartmentAuthority(department),
    enabled: !!department,
  });

  const copy = () => {
    if (!draft) return;
    navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.body}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const digitsOnly = (phone: string) => phone.replace(/[^0-9]/g, "");
  const mailtoHref = draft && authority?.personalEmail
    ? `mailto:${authority.personalEmail}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`
    : undefined;
  const waHref = draft && authority?.phone
    ? `https://wa.me/${digitsOnly(authority.phone)}?text=${encodeURIComponent(`${draft.subject}\n\n${draft.body}`)}`
    : undefined;

  if (isLoading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center"><Loader2 className="size-4 animate-spin" /> Drafting message…</div>;
  }
  if (isError || !draft) {
    return <div className="text-sm text-destructive py-8 text-center">Could not generate a draft — is server-ai running with Ollama?</div>;
  }

  return (
    <div className="space-y-3">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">Concerned Authority</div>
      {authorityLoading ? (
        <div className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="size-3 animate-spin" /> Resolving department authority…</div>
      ) : authority?.name ? (
        <div className="flex items-center gap-2 text-sm bg-surface border border-border rounded-md p-2.5">
          <UserRound className="size-4 text-primary shrink-0" />
          <div className="min-w-0">
            <div className="font-medium truncate">{authority.name} — {authority.designation}</div>
            <div className="text-xs text-muted-foreground truncate">
              {authority.personalEmail || "no email on file"} · {authority.phone || "no phone on file"}
            </div>
          </div>
        </div>
      ) : (
        <div className="text-xs text-destructive">No contactable authority could be resolved for this department.</div>
      )}

      <div className="text-xs uppercase tracking-wider text-muted-foreground pt-2">Subject</div>
      <div className="text-sm font-medium">{draft.subject}</div>
      <div className="text-xs uppercase tracking-wider text-muted-foreground pt-2">Body</div>
      <div className="text-sm whitespace-pre-line bg-surface border border-border rounded-md p-3">{draft.body}</div>

      <div className="flex flex-wrap gap-2 pt-1">
        <a
          href={mailtoHref}
          onClick={() => mailtoHref && onChannelUsed?.("Email")}
          aria-disabled={!mailtoHref}
          className={`h-9 px-3 rounded-md text-sm inline-flex items-center gap-1.5 ${mailtoHref ? "bg-primary text-primary-foreground hover:opacity-90" : "bg-muted text-muted-foreground pointer-events-none"}`}
        >
          <Mail className="size-3.5" /> Send via Email
        </a>
        <a
          href={waHref}
          target="_blank"
          rel="noreferrer"
          onClick={() => waHref && onChannelUsed?.("WhatsApp")}
          aria-disabled={!waHref}
          className={`h-9 px-3 rounded-md text-sm inline-flex items-center gap-1.5 border ${waHref ? "border-success text-success hover:bg-success/10" : "border-border text-muted-foreground pointer-events-none"}`}
        >
          <MessageCircle className="size-3.5" /> Send via WhatsApp
        </a>
        <button onClick={copy} className="h-9 px-3 rounded-md border border-border bg-card text-sm hover:bg-surface-muted inline-flex items-center gap-1.5">
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy to clipboard"}
        </button>
      </div>
    </div>
  );
}
