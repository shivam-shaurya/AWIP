import { Link } from "@tanstack/react-router";
import { X, FileText, Download, Sparkles, UserCircle2, Briefcase, MapPin, Calendar, Building2 } from "lucide-react";
import { Pill } from "@/components/layout/section";
import type { Employee } from "@/lib/mock-data";

export function EmployeeCardModal({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const years = new Date().getFullYear() - parseInt(employee.doj.slice(0, 4), 10);
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-background/60 backdrop-blur-sm animate-fade-in p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-card border border-border rounded-lg shadow-2xl animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-12 px-4 border-b border-border flex items-center justify-between">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Employee Card</div>
          <button onClick={onClose} className="size-8 grid place-items-center rounded hover:bg-surface-muted" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        <div className="p-5 flex gap-4">
          <div className="size-20 rounded-lg bg-primary/10 text-primary text-2xl font-semibold grid place-items-center shrink-0">
            {employee.name.split(" ").map((n) => n[0]).slice(0, 2).join("")}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{employee.name}</h2>
              <Pill tone="neutral">{employee.id}</Pill>
              <Pill tone={employee.status === "Active" ? "success" : employee.status === "On Leave" ? "warning" : "neutral"}>
                {employee.status}
              </Pill>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-3 text-xs">
              <Meta icon={Building2} label="Department" value={employee.department} />
              <Meta icon={Briefcase} label="Designation" value={employee.designation} />
              <Meta icon={UserCircle2} label="Cadre" value={employee.cadre} />
              <Meta icon={MapPin} label="Current Posting" value={employee.posting} />
              <Meta icon={Calendar} label="Date of Joining" value={employee.doj} />
              <Meta icon={Calendar} label="Years of Service" value={`${years} yrs`} />
              <Meta icon={Calendar} label="Retirement" value={employee.retirement.slice(0, 7)} />
              <Meta icon={UserCircle2} label="Reporting Officer" value="Dy. Commissioner" />
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {employee.flags.promotionDue && <Pill tone="warning">Promotion Due</Pill>}
              {employee.flags.retirementDue && <Pill tone="destructive">Retirement Due</Pill>}
              {employee.flags.appraisalPending && <Pill tone="info">Appraisal Pending</Pill>}
              {employee.flags.trainingPending && <Pill tone="info">Training Pending</Pill>}
              {employee.flags.missingDocs && <Pill tone="destructive">Missing Docs</Pill>}
            </div>
          </div>
        </div>

        <div className="px-5 pb-5 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Link
            to="/employees/$id"
            params={{ id: employee.id }}
            className="h-9 px-3 inline-flex items-center justify-center gap-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-95"
          >
            <UserCircle2 className="size-4" /> Open 360
          </Link>
          <button className="h-9 px-3 inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card text-xs hover:bg-surface-muted">
            <FileText className="size-4" /> Documents
          </button>
          <button className="h-9 px-3 inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card text-xs hover:bg-surface-muted">
            <Download className="size-4" /> Service Record
          </button>
          <button className="h-9 px-3 inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card text-xs hover:bg-surface-muted">
            <Sparkles className="size-4" /> AI Summary
          </button>
        </div>
      </div>
    </div>
  );
}

function Meta({ icon: Icon, label, value }: { icon: typeof FileText; label: string; value: string }) {
  return (
    <div className="flex items-start gap-1.5">
      <Icon className="size-3.5 text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="text-foreground truncate">{value}</div>
      </div>
    </div>
  );
}
