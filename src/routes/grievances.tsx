import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquareWarning, AlertOctagon, TrendingDown, Wand2, ArrowRight, ScanEye, X, Loader2, Check, Plus } from "lucide-react";
import { Panel, Pill, Section } from "@/components/layout/section";
import { Pager } from "@/components/ui/pager";
import { FilterPill } from "@/components/ui/filter-pill";
import { SearchPill } from "@/components/ui/search-pill";
import { useDepartment } from "@/context/department-context";
import { DEPARTMENTS } from "@/lib/departments";
import { coreApi, aiApi, ApiError } from "@/lib/api-client";
import { NotifyAuthorityPanel } from "@/components/emergency/notify-authority-panel";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { CHART_TOOLTIP_STYLE, CHART_ANIMATION } from "@/lib/chart-theme";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/grievances")({
  head: () => ({ meta: [{ title: "Grievances & Relations · AWIP" }] }),
  component: GrievancesPage,
});

const CATEGORIES = ["Harassment", "Payroll", "Facilities", "Management", "Peer Conflict"];
const PAGE_SIZE = 10;

function GrievancesPage() {
  const { department } = useDepartment();
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [showFile, setShowFile] = useState<{ forceCritical: boolean } | null>(null);
  const [selected, setSelected] = useState<any | null>(null);
  const [draftFor, setDraftFor] = useState<any | null>(null);
  const [page, setPage] = useState(1);

  const { data: grievancesResp, isLoading, isError } = useQuery({
    queryKey: ["grievances", department],
    queryFn: () => coreApi.getGrievances(department === "All Departments" ? undefined : department),
  });
  const allGrievances = grievancesResp?.data ?? [];

  const { data: analyticsResp } = useQuery({
    queryKey: ["grievance-analytics"],
    queryFn: () => coreApi.getGrievanceAnalytics(),
  });
  const trendData = analyticsResp?.data ?? [];
  const byDepartment = analyticsResp?.byDepartment ?? [];

  const filtered = useMemo(() => {
    return allGrievances.filter((g: any) =>
      (categoryFilter === "All" || g.category === categoryFilter) &&
      (g.subject.toLowerCase().includes(searchTerm.toLowerCase()) || g.id.toLowerCase().includes(searchTerm.toLowerCase()))
    );
  }, [allGrievances, searchTerm, categoryFilter]);

  const criticalCount = filtered.filter((g: any) => g.severity === "Critical").length;
  const openCount = filtered.filter((g: any) => g.status === "New" || g.status === "Under Investigation" || g.status === "Escalated").length;

  useEffect(() => setPage(1), [department, categoryFilter, searchTerm]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="p-5 max-w-[1600px] mx-auto flex flex-col xl:flex-row gap-6 items-start animate-in fade-in duration-500">
      <div className="flex-1 space-y-6 min-w-0 w-full">

        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <MessageSquareWarning className="size-6 text-primary" />
              Grievances & Relations Hub
            </h1>
            <p className="text-sm text-muted-foreground mt-1">AI-powered employee dispute triage and resolution copilot.</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowFile({ forceCritical: false })}
              className="h-9 px-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-card text-sm font-medium hover:bg-surface-muted transition-colors"
            >
              <Plus className="size-4" /> File Grievance
            </button>
            <button
              onClick={() => setShowFile({ forceCritical: true })}
              className="h-9 px-3 inline-flex items-center gap-1.5 rounded-full bg-destructive text-destructive-foreground text-sm font-medium hover:opacity-95 transition-opacity shadow-sm"
            >
              <AlertOctagon className="size-4" /> File Critical Incident
            </button>
          </div>
        </div>

        {/* Dashboard Analytics - 4 Columns in 1 Row */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 items-stretch">

          {/* Open Grievances */}
          <Panel className="p-4 bg-card shadow-sm flex flex-col justify-between border-2 border-primary/40 h-full">
            <div>
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Open Grievances</h3>
                <Pill tone="primary">Active</Pill>
              </div>
              <div className="text-3xl font-semibold tracking-tight tabular-nums mt-2">{openCount}</div>
              <div className="mt-3 space-y-1.5">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground font-medium">
                  <span>Open Rate</span>
                  <span className="text-foreground font-semibold">{Math.round((openCount / (filtered.length || 1)) * 100)}%</span>
                </div>
                <div className="h-1.5 w-full bg-surface-muted rounded-full overflow-hidden">
                  <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${Math.round((openCount / (filtered.length || 1)) * 100)}%` }} />
                </div>
              </div>
            </div>
            <div className="mt-3 pt-2 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5 font-medium"><TrendingDown className="size-3 text-primary" /> Of {filtered.length} total on record</span>
            </div>
          </Panel>

          {/* Critical Severity */}
          <Panel className="p-4 bg-card shadow-sm flex flex-col justify-between relative overflow-hidden border-2 border-destructive/40 h-full">
            <div className="absolute right-0 top-0 w-16 h-16 bg-destructive/5 rounded-bl-full pointer-events-none" />
            <div>
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Critical Severity</h3>
                <Pill tone="destructive">High Risk</Pill>
              </div>
              <div className="text-3xl font-semibold tracking-tight tabular-nums text-destructive mt-2">{criticalCount}</div>
              <div className="mt-3 space-y-1.5">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground font-medium">
                  <span>Critical Ratio</span>
                  <span className="text-destructive font-semibold">{Math.round((criticalCount / (openCount || 1)) * 100)}% of Open</span>
                </div>
                <div className="h-1.5 w-full bg-destructive/15 rounded-full overflow-hidden">
                  <div className="h-full bg-destructive rounded-full transition-all" style={{ width: `${Math.min(100, Math.round((criticalCount / (openCount || 1)) * 100))}%` }} />
                </div>
              </div>
            </div>
            <div className="mt-3 pt-2 border-t border-border text-[11px] text-muted-foreground truncate">
              <span className="font-semibold text-destructive">Action Required:</span> {criticalCount} auto-escalated
            </div>
          </Panel>

          {/* Volume Trend (6 Mo) */}
          <Panel className="p-4 flex flex-col justify-between bg-card shadow-sm border-2 border-primary/40 h-full">
            <div>
              <div className="flex justify-between items-center mb-1">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Volume Trend (6 Mo)</h3>
                <span className="text-[10px] bg-primary/10 text-primary px-2.5 py-0.5 rounded-full font-medium">Live Data</span>
              </div>
              <div className="h-[95px] w-full mt-1 -ml-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trendData}>
                    <defs>
                      <linearGradient id="colorVol" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-primary)" stopOpacity={0.35}/>
                        <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" opacity={0.5} />
                    <XAxis dataKey="month" hide />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                    <Area type="monotone" dataKey="volume" stroke="var(--color-primary)" strokeWidth={2} fillOpacity={1} fill="url(#colorVol)" {...CHART_ANIMATION} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="mt-2 pt-2 border-t border-border flex items-center justify-between text-[11px] text-muted-foreground">
              <span>MoM Pace</span>
              <span className="font-semibold text-foreground">Steady Trend</span>
            </div>
          </Panel>

          {/* Department Heatmap */}
          <Panel className="p-4 flex flex-col justify-between bg-card shadow-sm border-2 border-primary/40 h-full">
            <div>
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Department Heatmap</h3>
                <span className="text-[10px] bg-primary/10 text-primary px-2.5 py-0.5 rounded-full font-medium">Live Data</span>
              </div>
              {byDepartment.length === 0 ? (
                <div className="text-xs text-muted-foreground py-3 text-center">No open grievances on record.</div>
              ) : (
                <ul className="space-y-1.5 text-xs">
                  {byDepartment.slice(0, 3).map((d) => (
                    <li key={d.department} className="flex items-center justify-between gap-2">
                      <span className="truncate max-w-[110px] font-medium">{d.department}</span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {d.criticalCount > 0 && <Pill tone="destructive">{d.criticalCount} crit</Pill>}
                        <span className="tabular-nums font-semibold">{d.openCount}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="mt-2 pt-2 border-t border-border flex items-center justify-between text-[11px] text-muted-foreground">
              <span>Highest Load</span>
              <span className="font-semibold text-foreground truncate max-w-[100px]">{byDepartment[0]?.department ?? "None"}</span>
            </div>
          </Panel>

        </div>

        {/* Triage Table */}
        <Section
          title="Incident Triage Inbox"
          subtitle="AI-categorized tickets sorted by severity"
          action={
            <div className="flex items-center gap-2">
              <FilterPill value={categoryFilter} onChange={setCategoryFilter} options={["All", ...CATEGORIES]} label="All Categories" size="compact" />
              <SearchPill value={searchTerm} onChange={setSearchTerm} placeholder="Search subjects or IDs..." size="compact" className="w-64" />
            </div>
          }
        >
          <Panel padded={false} className="border-border shadow-sm">
            <div className="overflow-x-auto overflow-y-hidden scrollbar-thin rounded-t-xl">
              <table className="w-full text-sm">
                <thead className="bg-sidebar text-[10px] uppercase tracking-wider text-sidebar-foreground">
                  <tr>
                    <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">ID / Date</th>
                    <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Submitter</th>
                    <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Subject & AI Summary</th>
                    <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Sentiment</th>
                    <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Severity</th>
                    <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Status</th>
                    <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Copilot Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {isLoading ? (
                    <tr><td colSpan={7} className="px-4 py-12 text-center text-muted-foreground"><Loader2 className="size-5 animate-spin inline" /></td></tr>
                  ) : isError ? (
                    <tr><td colSpan={7} className="px-4 py-12 text-center text-destructive">Couldn't load grievances. Is the AWIP core server running?</td></tr>
                  ) : filtered.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <ScanEye className="size-8 opacity-20" />
                          <p>No grievances found for this scope.</p>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    visible.map((g: any, i: number) => (
                      <tr key={g.id} className={cn("hover:bg-surface-muted/70 transition-colors group", i % 2 === 1 && "bg-surface-muted")}>
                        <td className="px-4 py-4 whitespace-nowrap">
                          <div className="font-medium text-foreground">{g.id}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{new Date(g.createdAt).toLocaleDateString("en-IN")}</div>
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap">
                          {g.isAnonymous ? (
                            <div className="flex items-center gap-1.5 text-muted-foreground bg-surface-muted px-2 py-1 rounded w-fit text-xs font-medium border border-border">
                              Anonymous
                            </div>
                          ) : (
                            <div className="font-medium">{g.submitterName || "—"}</div>
                          )}
                          <div className="text-[10px] text-muted-foreground mt-1 uppercase tracking-wider">{g.category}</div>
                        </td>
                        <td className="px-4 py-4 min-w-[300px]">
                          <div className="font-semibold text-foreground mb-1 group-hover:text-primary transition-colors">{g.subject}</div>
                          <div className="text-xs text-muted-foreground leading-relaxed border-l-2 border-primary/30 pl-2">
                            <span className="font-semibold text-primary/70 mr-1">AI Summary:</span>
                            {g.aiSummary}
                          </div>
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap">
                          <Pill tone={
                            g.sentiment === "Hostile" ? "destructive" :
                            g.sentiment === "Frustrated" ? "warning" :
                            g.sentiment === "Anxious" ? "warning" : "primary"
                          }>
                            {g.sentiment}
                          </Pill>
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap">
                          <div className={cn(
                            "flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider",
                            g.severity === "Critical" ? "text-destructive" :
                            g.severity === "High" ? "text-warning-foreground" :
                            g.severity === "Medium" ? "text-primary" : "text-success"
                          )}>
                            {g.severity === "Critical" && <AlertOctagon className="size-3.5" />}
                            {g.severity}
                          </div>
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap">
                          <Pill tone={g.status === "Resolved" ? "success" : g.status === "New" ? "primary" : "warning"}>
                            {g.status}
                          </Pill>
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap">
                          {g.status !== "Resolved" ? (
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => setDraftFor(g)}
                                title="Draft Resolution Email"
                                className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-primary hover:bg-primary/10 bg-primary/5 px-2.5 py-1.5 rounded-md transition-colors border border-primary/20 shadow-sm"
                              >
                                <Wand2 className="size-3" /> Draft Res.
                              </button>
                              <button onClick={() => setSelected(g)} className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-surface-muted rounded-md transition-colors">
                                <ArrowRight className="size-4" />
                              </button>
                            </div>
                          ) : (
                            <button onClick={() => setSelected(g)} className="text-[10px] text-muted-foreground hover:text-foreground uppercase tracking-widest pl-2 font-medium">
                              View
                            </button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && <Pager page={page} totalPages={totalPages} onChange={setPage} />}
          </Panel>
        </Section>
      </div>

      {showFile && <FileGrievanceModal forceCritical={showFile.forceCritical} onClose={() => setShowFile(null)} />}
      {selected && <GrievanceDetailsDrawer grievance={selected} onClose={() => setSelected(null)} />}
      {draftFor && <DraftEmailModal grievance={draftFor} onClose={() => setDraftFor(null)} />}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   File Grievance Modal
   ══════════════════════════════════════════════════════════════ */
function FileGrievanceModal({ forceCritical, onClose }: { forceCritical: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [department, setDepartment] = useState<string>(DEPARTMENTS[1] ?? "Engineering");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null);

  const fileGrievance = useMutation({
    mutationFn: () =>
      coreApi.createGrievance({
        category, subject, description, department, isAnonymous,
        severityOverride: forceCritical ? "Critical" : undefined,
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["grievances"] });
      queryClient.invalidateQueries({ queryKey: ["grievance-analytics"] });
      setResult(data);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Failed to file grievance."),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/60 backdrop-blur-sm animate-fade-in p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-card border border-border rounded-lg shadow-2xl animate-scale-in max-h-[90vh] overflow-y-auto scrollbar-thin" onClick={(e) => e.stopPropagation()}>
        <div className="h-12 px-4 border-b border-border flex items-center justify-between sticky top-0 bg-card z-10">
          <div className="text-sm font-semibold">{forceCritical ? "File Critical Incident" : "File Grievance"}</div>
          <button onClick={onClose} className="size-8 grid place-items-center rounded hover:bg-surface-muted"><X className="size-4" /></button>
        </div>

        {result ? (
          <div className="p-6 text-center space-y-3">
            <div className="size-12 rounded-full bg-surface-muted flex items-center justify-center mx-auto">
              <Check className="size-6 text-success" />
            </div>
            <p className="font-semibold">Grievance {result.id} filed</p>
            <div className="flex items-center justify-center gap-2 text-xs">
              <Pill tone={result.severity === "Critical" ? "destructive" : "primary"}>{result.severity} severity</Pill>
              <Pill tone="warning">{result.sentiment}</Pill>
              <Pill tone={result.status === "Escalated" ? "destructive" : "neutral"}>{result.status}</Pill>
            </div>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">{result.aiSummary}</p>
            <button onClick={onClose} className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-95">Done</button>
          </div>
        ) : (
          <div className="p-5 space-y-3">
            {forceCritical && (
              <div className="text-xs bg-destructive/10 border border-destructive/20 text-destructive rounded-md p-2.5">
                This will be filed as a Critical-severity incident and auto-escalated immediately.
              </div>
            )}
            <Field label="Category">
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full h-9 px-2 rounded-md border border-border bg-surface text-sm">
                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Department">
              <select value={department} onChange={(e) => setDepartment(e.target.value)} className="w-full h-9 px-2 rounded-md border border-border bg-surface text-sm">
                {DEPARTMENTS.slice(1).map((d) => <option key={d}>{d}</option>)}
              </select>
            </Field>
            <Field label="Subject">
              <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Brief summary of the issue" className="w-full h-9 px-3 rounded-md border border-border bg-surface text-sm focus:outline-none focus:ring-2 focus:ring-ring/30" />
            </Field>
            <Field label="Description">
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="Describe what happened in detail" className="w-full px-3 py-2 rounded-md border border-border bg-surface text-sm focus:outline-none focus:ring-2 focus:ring-ring/30" />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isAnonymous} onChange={(e) => setIsAnonymous(e.target.checked)} className="size-4 rounded border-border" />
              File anonymously
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
                Submit
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Details Drawer — description, AI summary, resolution timeline, status
   ══════════════════════════════════════════════════════════════ */
function GrievanceDetailsDrawer({ grievance, onClose }: { grievance: any; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");

  const { data: full } = useQuery({
    queryKey: ["grievance", grievance.id],
    queryFn: () => coreApi.getGrievance(grievance.id),
  });
  const g = full || grievance;
  const updates = g.updates ?? [];

  const nextStatus = g.status === "Escalated" || g.status === "New" ? "Under Investigation" : g.status === "Under Investigation" ? "Resolved" : null;

  const advance = useMutation({
    mutationFn: (status: string) => coreApi.updateGrievanceStatus(g.id, { status, note: note || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grievances"] });
      queryClient.invalidateQueries({ queryKey: ["grievance", g.id] });
      setNote("");
    },
  });

  return (
    <>
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 w-full sm:w-[440px] bg-card border-l border-border shadow-2xl z-50 p-6 flex flex-col overflow-y-auto scrollbar-thin animate-in slide-in-from-right duration-300">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-lg">{g.id}</h2>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-surface-muted"><X className="size-5" /></button>
        </div>

        <div className="space-y-1.5 mb-4">
          <div className="font-medium">{g.subject}</div>
          <div className="flex items-center gap-2">
            <Pill tone={g.severity === "Critical" ? "destructive" : "primary"}>{g.severity}</Pill>
            <Pill tone="warning">{g.sentiment}</Pill>
            <Pill tone={g.status === "Resolved" ? "success" : "neutral"}>{g.status}</Pill>
          </div>
        </div>

        <div className="text-sm text-muted-foreground leading-relaxed mb-4">{g.description}</div>

        <div className="text-xs text-muted-foreground border-l-2 border-primary/30 pl-2 mb-6">
          <span className="font-semibold text-primary/70 mr-1">AI Summary:</span>{g.aiSummary}
        </div>

        <div className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mb-2">Resolution Steps</div>
        <div className="space-y-2 mb-6">
          {updates.length === 0 ? (
            <div className="text-xs text-muted-foreground">No updates yet.</div>
          ) : (
            updates.map((u: any) => (
              <div key={u.id} className="text-xs bg-surface border border-border rounded-md p-2.5">
                <div className="flex items-center justify-between mb-1">
                  <Pill tone="neutral">{u.status}</Pill>
                  <span className="text-muted-foreground">{new Date(u.createdAt).toLocaleDateString("en-IN")}</span>
                </div>
                <div>{u.note}</div>
              </div>
            ))
          )}
        </div>

        {nextStatus && (
          <div className="mt-auto pt-4 border-t border-border space-y-2">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder={`Note for moving to "${nextStatus}"…`}
              className="w-full px-3 py-2 rounded-md border border-border bg-surface text-sm focus:outline-none focus:ring-2 focus:ring-ring/30"
            />
            <button
              onClick={() => advance.mutate(nextStatus)}
              disabled={advance.isPending}
              className="w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-95 disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {advance.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Move to {nextStatus}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/* ══════════════════════════════════════════════════════════════
   AI Draft Email Modal
   ══════════════════════════════════════════════════════════════ */
function DraftEmailModal({ grievance, onClose }: { grievance: any; onClose: () => void }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["grievance-draft-email", grievance.id],
    queryFn: () => aiApi.draftGrievanceEmail({
      subject: grievance.subject, description: grievance.description,
      category: grievance.category, submitterName: grievance.submitterName,
    }),
  });

  const logChannel = (channel: "Email" | "WhatsApp") => {
    coreApi.updateGrievanceStatus(grievance.id, { status: grievance.status, note: `Concerned authority notified via ${channel}.` });
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/60 backdrop-blur-sm animate-fade-in p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-card border border-border rounded-lg shadow-2xl animate-scale-in max-h-[85vh] overflow-y-auto scrollbar-thin" onClick={(e) => e.stopPropagation()}>
        <div className="h-12 px-4 border-b border-border flex items-center justify-between sticky top-0 bg-card z-10">
          <div className="text-sm font-semibold flex items-center gap-1.5"><Wand2 className="size-4 text-primary" /> AI Drafted Response</div>
          <button onClick={onClose} className="size-8 grid place-items-center rounded hover:bg-surface-muted"><X className="size-4" /></button>
        </div>
        <div className="p-5">
          <NotifyAuthorityPanel
            department={grievance.department}
            draft={data}
            isLoading={isLoading}
            isError={isError}
            onChannelUsed={logChannel}
          />
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
