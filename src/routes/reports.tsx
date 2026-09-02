import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Panel, Pill, Section } from "@/components/layout/section";
import { FileBarChart, Download, Sparkles, Loader2 } from "lucide-react";
import { coreApi } from "@/lib/api-client";
import { useAuth } from "@/context/auth-context";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/reports")({
  head: () => ({ meta: [{ title: "Reports Center · AWIP" }] }),
  component: ReportsPage,
});

type ReportRows = { headers: string[]; rows: (string | number)[][] };

// Each report pulls from the same real endpoints already used elsewhere in
// the app (Analytics, Employees, Finance) — there is no separate "report
// generation" data source, so a report can never show a number that
// contradicts the live screen it's summarizing.
const REPORTS: { title: string; fetch: () => Promise<ReportRows> }[] = [
  {
    title: "Workforce Strength Report",
    fetch: async () => {
      const { data } = await coreApi.getWorkforceSummary();
      return { headers: ["Department", "Filled", "Vacancies", "Attendance %"], rows: data.map((d: any) => [d.fullName, d.count, d.vacancies, d.attendance]) };
    },
  },
  {
    title: "Cadre Strength Report",
    fetch: async () => {
      const { data } = await coreApi.getCadreSummary();
      return { headers: ["Department", "Cadre", "Count"], rows: data.map((d: any) => [d.departmentId, d.cadre, d.count]) };
    },
  },
  {
    title: "Vacancy Report",
    fetch: async () => {
      const { data } = await coreApi.getWorkforceSummary();
      return { headers: ["Department", "Sanctioned", "Filled", "Vacant"], rows: data.map((d: any) => [d.fullName, d.count + d.vacancies, d.count, d.vacancies]) };
    },
  },
  {
    title: "Retirement Report",
    fetch: async () => {
      const { data, activeStrength } = await coreApi.getRetirementTrend();
      return { headers: ["Year", "Projected Retirements", "Active Strength Today"], rows: data.map((d) => [d.year, d.projectedRetirements, activeStrength]) };
    },
  },
  {
    title: "Promotion Due Report",
    fetch: async () => {
      const { promotion } = await coreApi.getWorkforceAlerts();
      return { headers: ["Department", "Promotion-Due Count"], rows: promotion.byDepartment.map((d) => [d.department, d.count]) };
    },
  },
  {
    title: "Appraisal Status Report",
    fetch: async () => {
      const resp = await coreApi.getPerformanceSummary();
      return { headers: ["Department", "Avg Score"], rows: resp.deptScores.map((d) => [d.department, d.score]) };
    },
  },
  {
    title: "Training Coverage Report",
    fetch: async () => {
      const { byDepartment } = await coreApi.getTrainingSummary();
      return { headers: ["Department", "Enrolled", "Completion Rate %"], rows: byDepartment.map((d) => [d.department, d.enrolled, d.completionRate]) };
    },
  },
  {
    title: "Disciplinary Summary",
    fetch: async () => {
      const resp = await coreApi.getEmployees({ flag: "disciplinaryFlag", limit: 1 });
      return { headers: ["Metric", "Count"], rows: [["Employees with an open or past disciplinary flag", resp.total ?? resp.count ?? 0]] };
    },
  },
  {
    title: "Establishment Readiness Brief",
    fetch: async () => {
      const { data } = await coreApi.getGovernanceReadiness();
      return { headers: ["Department", "Digitization %", "Appraisal %", "Training %", "Establishment %"], rows: data.map((d) => [d.dept, d.digitization, d.appraisal, d.training, d.establishment]) };
    },
  },
];

function toCsv({ headers, rows }: ReportRows) {
  const escape = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(escape).join(",")).join("\n");
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type ExportLogEntry = { report: string; generatedAt: string; by: string };

function ReportsPage() {
  const { user } = useAuth();
  const [generating, setGenerating] = useState<Record<string, boolean>>({});
  // Real, session-local log of exports actually triggered this session — not
  // a fabricated history. Starts empty; nothing to show until you generate one.
  const [exportLog, setExportLog] = useState<ExportLogEntry[]>([]);

  const handleGenerate = async (report: { title: string; fetch: () => Promise<ReportRows> }) => {
    setGenerating((g) => ({ ...g, [report.title]: true }));
    try {
      const rows = await report.fetch();
      const csv = toCsv(rows);
      const filename = `${report.title.replace(/\s+/g, "_")}.csv`;
      downloadCsv(filename, csv);
      setExportLog((log) => [{ report: report.title, generatedAt: new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }), by: user?.name ?? "You" }, ...log].slice(0, 10));
      toast.success(`${report.title} downloaded`);
    } catch {
      toast.error(`Couldn't generate ${report.title} — please try again`);
    } finally {
      setGenerating((g) => ({ ...g, [report.title]: false }));
    }
  };

  return (
    <div className="p-5 max-w-[1600px] mx-auto flex flex-col gap-6 animate-in fade-in duration-500 w-full">
      
      {/* Header */}
      <div className="w-full flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2 text-foreground">
            <FileBarChart className="size-6 text-primary" />
            Reports Center
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Official administrative CSV exports, live-computed from current municipal databases.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Pill tone="primary">{REPORTS.length} Standard Reports</Pill>
        </div>
      </div>

      <Section title="Standard Reports" subtitle="Generate a CSV export from live data with one click">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {REPORTS.map((r) => (
            <Panel key={r.title} className="p-4 bg-card border border-border shadow-sm rounded-xl flex flex-col justify-between gap-4 hover:shadow-md transition-all">
              <div className="flex items-start gap-3 justify-between">
                <div className="flex items-start gap-3">
                  <div className="size-9 rounded-full bg-primary/10 grid place-items-center text-primary shrink-0">
                    <FileBarChart className="size-4.5 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">{r.title}</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">Computed live from current data</p>
                  </div>
                </div>
                <Pill tone="success">Ready</Pill>
              </div>

              <button
                onClick={() => handleGenerate(r)}
                disabled={generating[r.title]}
                className={cn(
                  "w-full h-8.5 rounded-full bg-primary text-primary-foreground text-xs font-semibold hover:opacity-95 transition-all inline-flex items-center justify-center gap-1.5 cursor-pointer shadow-sm",
                  generating[r.title] && "opacity-70 cursor-wait",
                )}
              >
                {generating[r.title] ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                {generating[r.title] ? "Generating CSV…" : "Generate CSV"}
              </button>
            </Panel>
          ))}
        </div>
      </Section>

      <Section title="Recent Exports" subtitle="This session's actual downloads">
        <Panel padded={false} className="shadow-sm overflow-hidden border border-border rounded-xl">
          {exportLog.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">No exports generated yet this session — click "Generate CSV" above.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-sidebar text-[10px] uppercase font-semibold text-sidebar-foreground tracking-wider">
                  <tr>
                    <th className="px-4 py-3">Report Name</th>
                    <th className="px-4 py-3">Generated At</th>
                    <th className="px-4 py-3">Exported By</th>
                    <th className="px-4 py-3 text-right">Format</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {exportLog.map((e, idx) => (
                    <tr key={idx} className={cn("hover:bg-surface-muted/70 transition-colors", idx % 2 === 1 && "bg-surface-muted")}>
                      <td className="px-4 py-3 font-semibold text-foreground">{e.report}</td>
                      <td className="px-4 py-3 text-muted-foreground">{e.generatedAt}</td>
                      <td className="px-4 py-3 text-muted-foreground">{e.by}</td>
                      <td className="px-4 py-3 text-right">
                        <Pill tone="primary">CSV</Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </Section>
    </div>
  );
}
