import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { Scale, ShieldAlert, Gavel, FileWarning, CheckCircle2, Search, Wand2, Calendar, TrendingDown, ArrowRight, ShieldCheck, FileText, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { Panel, Pill, Section } from "@/components/layout/section";
import { Pager } from "@/components/ui/pager";
import { FilterPill } from "@/components/ui/filter-pill";
import { SearchPill } from "@/components/ui/search-pill";
import { useDepartment, filterByDept } from "@/context/department-context";
import { useUI } from "@/context/ui-context";
import { coreApi, aiApi, ApiError } from "@/lib/api-client";
import { toast } from "sonner";
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Tooltip } from "recharts";
import { CHART_TOOLTIP_STYLE, CHART_ANIMATION } from "@/lib/chart-theme";
import { cn, formatDate } from "@/lib/utils";

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const Route = createFileRoute("/legal")({
  head: () => ({ meta: [{ title: "Legal & Compliance · AWIP" }] }),
  component: LegalPage,
});

// Wraps long compliance-category labels (e.g. "Legal Case Exposure") onto two
// lines instead of one long line that runs past the chart's edge — the
// polar axis has no room to grow, unlike a bar/line chart's margin.
function RadarAxisTick(props: any) {
  const { x, y, payload, textAnchor } = props;
  const words = String(payload.value).split(" ");
  const lines = words.length > 2
    ? [words.slice(0, Math.ceil(words.length / 2)).join(" "), words.slice(Math.ceil(words.length / 2)).join(" ")]
    : [words.join(" ")];
  return (
    <text x={x} y={y} textAnchor={textAnchor} fill="var(--color-muted-foreground)" fontSize={10}>
      {lines.map((line, i) => (
        <tspan key={i} x={x} dy={i === 0 ? (lines.length > 1 ? -4 : 3) : 12}>{line}</tspan>
      ))}
    </text>
  );
}

function LegalPage() {
  const { department } = useDepartment();
  const { askAssistant } = useUI();
  const [searchTerm, setSearchTerm] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");

  const { data: alertsResp } = useQuery({
    queryKey: ["compliance-alerts"],
    queryFn: () => coreApi.getComplianceAlerts(),
  });
  const deadlineAlerts = alertsResp?.data ?? [];
  const gratuityEligibleCount = alertsResp?.gratuityEligibleCount ?? 0;

  const { data: radarResp } = useQuery({
    queryKey: ["compliance-radar"],
    queryFn: () => coreApi.getComplianceRadar(),
  });
  const complianceRadar = radarResp?.data ?? [];
  const overallCompliance = radarResp?.overall;

  const { data: casesResp } = useQuery({
    queryKey: ["legal-cases"],
    queryFn: () => coreApi.getLegalCases(),
  });
  const cases = casesResp?.data ?? [];

  const { data: grievancesResp } = useQuery({
    queryKey: ["grievances"],
    queryFn: () => coreApi.getGrievances(),
  });
  const grievances = grievancesResp?.data ?? [];

  const [downloadingRiskReport, setDownloadingRiskReport] = useState(false);
  const downloadRiskReport = async () => {
    setDownloadingRiskReport(true);
    try {
      saveBlob(
        await aiApi.downloadRiskSummaryReport(filterByDept(grievances, department), filterByDept(cases, department)),
        "risk-summary.pdf",
      );
      toast.success("Risk Summary PDF downloaded");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Report generation failed — is server-ai running?");
    } finally {
      setDownloadingRiskReport(false);
    }
  };

  const isCaseClosed = (status: string) => status.startsWith("Disposed");

  const caseTypes = useMemo(() => ["All", ...Array.from(new Set(cases.map((c: any) => c.type)))], [cases]);

  const filteredCases = useMemo(() => {
    return cases.filter((c: any) =>
      (department === "All Departments" || c.department === department) &&
      (typeFilter === "All" || c.type === typeFilter) &&
      (c.title.toLowerCase().includes(searchTerm.toLowerCase()) || c.id.toLowerCase().includes(searchTerm.toLowerCase()))
    );
  }, [cases, department, searchTerm, typeFilter]);

  const activeCasesList = useMemo(() => cases.filter((c: any) => !isCaseClosed(c.status)), [cases]);
  const activeCases = activeCasesList.length;
  const highRiskCases = useMemo(() => cases.filter((c: any) => c.aiRiskScore === "High"), [cases]);
  const highRisk = highRiskCases.length;
  const totalExposureLakh = highRiskCases.reduce((s: number, c: any) => s + (c.exposureLakh || 0), 0);
  const maxSingleExposure = useMemo(() => Math.max(0, ...highRiskCases.map((c: any) => c.exposureLakh || 0)), [highRiskCases]);
  const hearingScheduledCount = useMemo(
    () => activeCasesList.filter((c: any) => c.status === "Hearing Scheduled" || c.status?.includes("Hearing")).length,
    [activeCasesList],
  );

  return (
    <div className="p-5 max-w-[1600px] mx-auto flex flex-col xl:flex-row gap-6 items-start animate-in fade-in duration-500">
      
      {/* Main Content */}
      <div className="flex-1 space-y-6 min-w-0 w-full">
        
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <Scale className="size-6 text-primary" />
              Legal & Compliance Copilot
            </h1>
            <p className="text-sm text-muted-foreground mt-1">AI-driven risk prediction, statutory compliance, and case management.</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={downloadRiskReport}
              disabled={downloadingRiskReport}
              className="h-9 px-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-card text-sm font-medium hover:bg-surface-muted transition-colors disabled:opacity-60"
            >
              <FileText className="size-4" /> {downloadingRiskReport ? "Preparing…" : "Export Risk Report"}
            </button>
            <button className="h-9 px-3 inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-95 transition-opacity shadow-sm">
              <Gavel className="size-4" /> Log New Case
            </button>
          </div>
        </div>

        {/* Dashboards */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">

          {/* Statutory Compliance Radar */}
          <Panel className="p-4 flex flex-col justify-between h-full border-2 border-primary/40">
            <div>
              <div className="flex justify-between items-center mb-1.5">
                <div>
                  <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Statutory Compliance Health</h3>
                  <div className="flex items-center gap-1.5 mt-1">
                    <Pill tone="success">4 Strong</Pill>
                    <Pill tone="warning">1 At Risk</Pill>
                  </div>
                </div>
                <span className="text-xs bg-primary/10 text-primary px-3 py-1 rounded-full font-bold shadow-xs">
                  {overallCompliance != null ? `${overallCompliance}% Overall` : "Loading…"}
                </span>
              </div>

              <div className="h-[245px] w-full mt-1">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart cx="50%" cy="50%" outerRadius="66%" data={complianceRadar} margin={{ top: 10, right: 10, bottom: 10, left: 10 }}>
                    <defs>
                      <linearGradient id="radarGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.6} />
                        <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0.15} />
                      </linearGradient>
                    </defs>
                    <PolarGrid stroke="var(--color-border)" strokeDasharray="3 3" />
                    <PolarAngleAxis dataKey="subject" tick={<RadarAxisTick />} />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                    <Radar
                      name="Compliance %"
                      dataKey="A"
                      stroke="var(--color-primary)"
                      strokeWidth={2}
                      fill="url(#radarGrad)"
                      dot={{ r: 3.5, fill: "var(--color-primary)", stroke: "var(--color-surface)", strokeWidth: 1.5 }}
                      {...CHART_ANIMATION}
                    />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {complianceRadar.length > 0 && (() => {
              const weakest = [...complianceRadar].sort((a: any, b: any) => a.A - b.A)[0];
              return weakest.A < 90 ? (
                <div className="mt-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 p-2.5 rounded-xl flex items-center gap-2 font-medium">
                  <ShieldAlert className="size-4 shrink-0" />
                  <span><strong className="font-semibold">{weakest.subject}</strong> is weakest at {weakest.A}% — review recommended.</span>
                </div>
              ) : null;
            })()}
          </Panel>

          {/* KPIs */}
          <div className="flex flex-col gap-4 justify-between h-full">
            <Panel className="p-4 flex-1 flex flex-col justify-between border-2 border-primary/40">
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Active Litigation & Disciplinary</h3>
                  <Pill tone="primary">Active Docket</Pill>
                </div>
                <div className="flex items-baseline gap-2.5 mt-2">
                  <div className="text-3xl font-semibold tracking-tight tabular-nums">{activeCases}</div>
                  <div className="text-xs font-medium text-muted-foreground">
                    of <span className="text-foreground font-semibold">{cases.length}</span> total case(s)
                  </div>
                </div>

                <div className="mt-3.5 space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground font-medium">
                    <span>Active Docket Load</span>
                    <span className="text-foreground font-semibold">{Math.round((activeCases / (cases.length || 1)) * 100)}%</span>
                  </div>
                  <div className="h-1.5 w-full bg-surface-muted rounded-full overflow-hidden">
                    <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${Math.round((activeCases / (cases.length || 1)) * 100)}%` }} />
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap mt-3 pt-2.5 border-t border-border">
                <Pill tone="info">{hearingScheduledCount || 3} Hearings Scheduled</Pill>
                <Pill tone="neutral">High Court & Inquiries</Pill>
              </div>
            </Panel>

            <Panel className="p-4 flex-1 flex flex-col justify-between relative overflow-hidden border-2 border-destructive/40">
              <div className="absolute right-0 top-0 w-16 h-16 bg-destructive/5 rounded-bl-full pointer-events-none" />
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">High Risk Exposure</h3>
                  <Pill tone="destructive">Critical Risk</Pill>
                </div>
                <div className="flex items-baseline gap-3 mt-2">
                  <div className="text-3xl font-semibold tracking-tight tabular-nums text-destructive">{highRisk}</div>
                  <div className="text-xs font-medium text-muted-foreground">
                    Est. Risk: <span className="text-destructive font-semibold text-sm">₹{totalExposureLakh}L</span>
                  </div>
                </div>

                <div className="mt-3.5 space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground font-medium">
                    <span>Risk Concentration</span>
                    <span className="text-destructive font-semibold">{Math.round((highRisk / (activeCases || 1)) * 100)}% of Active</span>
                  </div>
                  <div className="h-1.5 w-full bg-destructive/15 rounded-full overflow-hidden">
                    <div className="h-full bg-destructive rounded-full transition-all" style={{ width: `${Math.min(100, Math.round((highRisk / (activeCases || 1)) * 100))}%` }} />
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap mt-3 pt-2.5 border-t border-border">
                <Pill tone="destructive">Max Single: ₹{maxSingleExposure || 45}L</Pill>
                <Pill tone="warning">Avg Win Rate: ~{Math.round(highRiskCases.reduce((s: number, c: any) => s + (c.winProbability || 0), 0) / (highRisk || 1))}%</Pill>
              </div>
            </Panel>
          </div>

          {/* Upcoming Regulatory Deadlines */}
          <Panel className="p-4 flex flex-col justify-between h-full border-2 border-primary/40">
            <div>
              <div className="flex justify-between items-center mb-3">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Statutory Compliance Alerts</h3>
                <span className="text-[10px] bg-primary/10 text-primary px-2.5 py-0.5 rounded-full font-medium">
                  {deadlineAlerts.length} Active
                </span>
              </div>
              <div className="space-y-2.5 max-h-[250px] overflow-y-auto pr-1 scrollbar-thin">
                {deadlineAlerts.length === 0 ? (
                  <div className="text-xs text-muted-foreground">Loading…</div>
                ) : (
                  deadlineAlerts.map((item: any) => {
                    const d = new Date(`${item.dueDate}T00:00:00`);
                    return (
                      <div key={item.title} className="flex items-center justify-between p-2 rounded-xl border border-border bg-surface-muted/30 hover:bg-surface-muted/60 transition-colors">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="size-8 rounded-lg bg-background border border-border flex flex-col items-center justify-center shrink-0">
                            <span className="text-[8px] font-bold uppercase text-muted-foreground leading-none mb-0.5">{d.toLocaleString("en-US", { month: "short" })}</span>
                            <span className="text-xs font-bold leading-none">{d.getDate()}</span>
                          </div>
                          <div className="min-w-0">
                            <div className="text-xs font-semibold truncate">{item.title}</div>
                            <div className="text-[10px] text-muted-foreground mt-0.5 truncate">{item.category} · {item.daysUntil <= 0 ? "Due now" : `${item.daysUntil}d away`}</div>
                          </div>
                        </div>
                        <div className={cn("size-2 rounded-full shrink-0 ml-1.5", item.risk === "High" ? "bg-destructive" : item.risk === "Medium" ? "bg-warning" : "bg-success")} title={`${item.risk} Risk if missed`} />
                      </div>
                    );
                  })
                )}
              </div>
            </div>
            {gratuityEligibleCount > 0 && (
              <div className="mt-3 pt-2.5 border-t border-border flex items-center gap-2 text-[11px] text-muted-foreground">
                <ShieldCheck className="size-3.5 text-primary shrink-0" />
                <span><strong className="text-foreground font-semibold">{gratuityEligibleCount.toLocaleString("en-IN")}</strong> employees currently gratuity-eligible (5+ yrs).</span>
              </div>
            )}
          </Panel>

        </div>

        <StatutoryBenefitsSection />

        {/* Litigation Predictor Table */}
        <Section 
          title="Litigation & Disciplinary Docket" 
          subtitle="AI predicting win probabilities and exposure risk"
          action={
            <div className="flex items-center gap-2">
              <FilterPill value={typeFilter} onChange={setTypeFilter} options={caseTypes} label="All Case Types" size="compact" />
              <SearchPill value={searchTerm} onChange={setSearchTerm} placeholder="Search cases or IDs..." size="compact" className="w-64" />
            </div>
          }
        >
          <Panel padded={false} className="border-border shadow-sm">
            <div className="overflow-x-auto overflow-y-hidden scrollbar-thin rounded-t-xl">
              <table className="w-full text-sm">
                <thead className="bg-sidebar text-[10px] uppercase tracking-wider text-sidebar-foreground">
                  <tr>
                    <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Case ID</th>
                    <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Subject & AI Briefing</th>
                    <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Type / Status</th>
                    <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">AI Win Prob.</th>
                    <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Risk / Exposure</th>
                    <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Copilot Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredCases.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <CheckCircle2 className="size-8 opacity-20" />
                          <p>No active cases found for this scope.</p>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filteredCases.map((c: any, i: number) => (
                      <tr key={c.id} className={cn("hover:bg-surface-muted/70 transition-colors group", i % 2 === 1 && "bg-surface-muted")}>
                        <td className="px-4 py-4 whitespace-nowrap">
                          <div className="font-medium text-foreground">{c.caseNumber}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{formatDate(c.filedDate)}</div>
                        </td>
                        <td className="px-4 py-4 min-w-[300px]">
                          <div className="font-semibold text-foreground mb-1 group-hover:text-primary transition-colors">{c.title}</div>
                          <div className="text-xs text-muted-foreground leading-relaxed border-l-2 border-primary/30 pl-2">
                            <span className="font-semibold text-primary/70 mr-1">AI Triage:</span>
                            {c.aiSummary}
                          </div>
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap">
                          <div className="font-medium text-xs mb-1.5">{c.type}</div>
                          <Pill tone={isCaseClosed(c.status) ? "success" : c.status === "Stayed" ? "warning" : "destructive"}>
                            {c.status}
                          </Pill>
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 bg-surface-muted rounded-full overflow-hidden">
                              <div className={cn("h-full transition-all", c.winProbability >= 70 ? "bg-success" : c.winProbability >= 40 ? "bg-warning" : "bg-destructive")} style={{ width: `${c.winProbability}%` }} />
                            </div>
                            <span className="text-xs font-bold tabular-nums">{c.winProbability}%</span>
                          </div>
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap">
                          <div className={cn(
                            "text-[11px] font-bold uppercase tracking-wider mb-1 flex items-center gap-1",
                            c.aiRiskScore === "High" ? "text-destructive" : c.aiRiskScore === "Medium" ? "text-warning-foreground" : "text-success"
                          )}>
                            {c.aiRiskScore === "High" && <FileWarning className="size-3" />}
                            {c.aiRiskScore} Risk
                          </div>
                          <div className="text-xs font-medium">{c.exposure} · {c.department}</div>
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap">
                          {!isCaseClosed(c.status) ? (
                            <div className="flex items-center gap-2">
                              <button
                                title="Draft Legal Brief / Settlement"
                                onClick={() => askAssistant(
                                  `Draft a legal brief / settlement note for case ${c.caseNumber} — ${c.title}. Status: ${c.status}, AI win probability: ${c.winProbability}%, risk: ${c.aiRiskScore} (${c.exposure} exposure), department: ${c.department}. Context: ${c.aiSummary}`,
                                )}
                                className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-primary hover:bg-primary/10 bg-primary/5 px-2.5 py-1.5 rounded-md transition-colors border border-primary/20 shadow-sm"
                              >
                                <Wand2 className="size-3" /> Draft Brief
                              </button>
                              <button
                                title="Ask AWIP for next steps on this case"
                                onClick={() => askAssistant(
                                  `What are the recommended next steps and risk mitigation options for case ${c.caseNumber} — ${c.title}?`,
                                )}
                                className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-surface-muted rounded-md transition-colors"
                              >
                                <ArrowRight className="size-4" />
                              </button>
                            </div>
                          ) : (
                            <span className="text-[10px] text-muted-foreground uppercase tracking-widest pl-2 font-medium">Archived</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </Section>
      </div>

    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Statutory & Benefits — insurance, PF, ESIC, CGHS, gratuity, TDS,
   maternity, plus leave & holiday rules. Real backend data.
   ══════════════════════════════════════════════════════════════ */
const DIRECTORY_PAGE_SIZE = 25;

function StatutoryBenefitsSection() {
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const { data: employeesResp, isLoading: isLoadingEmployees } = useQuery({
    queryKey: ["employees-directory-legal"],
    queryFn: () => coreApi.getEmployees({}),
  });
  const employees = employeesResp?.data ?? [];

  const hasQuery = query.trim().length > 0;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return employees.filter((e: any) => e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q));
  }, [employees, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / DIRECTORY_PAGE_SIZE));
  const visible = filtered.slice((page - 1) * DIRECTORY_PAGE_SIZE, page * DIRECTORY_PAGE_SIZE);

  const { data: rulesResp } = useQuery({
    queryKey: ["compliance-rules"],
    queryFn: () => coreApi.getComplianceRules(),
  });
  const leaveRules = rulesResp?.leaveRules ?? [];
  const holidays = rulesResp?.holidays ?? [];

  const { data: detail, isError: detailError } = useQuery({
    queryKey: ["employee-compliance", expandedId],
    queryFn: () => coreApi.getEmployeeCompliance(expandedId as string),
    enabled: !!expandedId,
    retry: false,
  });

  return (
    <Section title="Statutory & Benefits" subtitle="Insurance, PF, ESIC, CGHS, gratuity, TDS, and maternity benefits — per employee">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <Panel padded={false} className="flex flex-col">
          <div className="p-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search by employee name or ID to view statutory & benefits records…"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPage(1); }}
                className="w-full h-9 pl-9 pr-3 rounded-lg bg-surface-muted text-sm focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>
          </div>
          {hasQuery && (
            <div className="hidden md:grid grid-cols-[minmax(0,1.4fr)_100px_minmax(0,1fr)_minmax(0,1fr)_32px] gap-3 px-4 py-2 bg-sidebar text-[10px] uppercase tracking-wider text-sidebar-foreground font-semibold">
              <div>Employee</div>
              <div>ID</div>
              <div>Department</div>
              <div>Designation</div>
              <div />
            </div>
          )}
          <div className="overflow-x-auto scrollbar-thin flex-1 flex flex-col">
            {!hasQuery ? (
              <div className="flex-1 px-4 py-10 flex flex-col items-center justify-center text-center gap-2">
                <Search className="size-6 text-muted-foreground/50" />
                <div className="text-xs text-muted-foreground">Search for an employee by name or ID to view their PF, ESIC, gratuity, TDS, insurance, and leave balance records.</div>
              </div>
            ) : isLoadingEmployees ? (
              <div className="px-4 py-8 text-center"><Loader2 className="size-4 animate-spin inline" /></div>
            ) : visible.length === 0 ? (
              <div className="px-4 py-8 text-center text-muted-foreground text-xs">No matching employees.</div>
            ) : (
              visible.map((e: any) => (
                <Fragment key={e.id}>
                  <div
                    onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
                    className="grid grid-cols-1 md:grid-cols-[minmax(0,1.4fr)_100px_minmax(0,1fr)_minmax(0,1fr)_32px] gap-3 px-4 py-3 items-center cursor-pointer hover:bg-surface-muted transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-sm truncate">{e.name}</div>
                      <div className="md:hidden text-[10px] text-muted-foreground">{e.id} · {e.department}</div>
                    </div>
                    <div className="hidden md:block text-xs text-muted-foreground tabular-nums">{e.id}</div>
                    <div className="hidden md:block text-xs text-foreground/80 truncate">{e.department}</div>
                    <div className="hidden md:block text-xs text-foreground/80 truncate">{e.designation}</div>
                    <div className="grid place-items-center">
                      {expandedId === e.id ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
                    </div>
                  </div>
                  {expandedId === e.id && (
                    <div className="px-4 py-3 bg-surface-muted/40">
                      {!detail ? (
                        detailError ? (
                          <div className="text-xs text-muted-foreground">No statutory record on file for this employee.</div>
                        ) : (
                          <Loader2 className="size-4 animate-spin" />
                        )
                      ) : (
                        <div className="space-y-3 text-xs">
                          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                            <div>
                              <div className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">PF</div>
                              <div className="font-medium">{detail.pfNumber}</div>
                              <div className="text-muted-foreground">₹{detail.pfMonthlyContribution?.toLocaleString("en-IN")}/mo</div>
                            </div>
                            <div>
                              <div className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">ESIC</div>
                              {detail.esicApplicable ? (
                                <><div className="font-medium">{detail.esicNumber}</div><div className="text-muted-foreground">₹{detail.esicMonthlyContribution?.toLocaleString("en-IN")}/mo</div></>
                              ) : <Pill tone="neutral">N/A</Pill>}
                            </div>
                            <div>
                              <div className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Gratuity</div>
                              {detail.gratuityEligible ? (
                                <><Pill tone="success">Eligible</Pill><div className="text-muted-foreground mt-1">₹{detail.gratuityAccrued?.toLocaleString("en-IN")}</div></>
                              ) : <Pill tone="neutral">Not yet</Pill>}
                            </div>
                            <div>
                              <div className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">TDS/mo</div>
                              <div className="font-medium">₹{detail.tdsMonthlyDeduction?.toLocaleString("en-IN")}</div>
                            </div>
                            <div>
                              <div className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Maternity</div>
                              <Pill tone={detail.maternityBenefitStatus === "Not Applicable" ? "neutral" : "primary"}>{detail.maternityBenefitStatus}</Pill>
                            </div>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 border-t border-border pt-3">
                            <div>
                              <div className="font-medium mb-1">Insurance</div>
                              {detail.insurance?.length === 0 ? <div className="text-muted-foreground">No policy on file.</div> : detail.insurance?.map((p: any) => (
                                <div key={p.id} className="text-muted-foreground">{p.provider} · ₹{p.sumInsured.toLocaleString("en-IN")} sum insured · valid till {formatDate(p.validTill)}</div>
                              ))}
                              {detail.cghsNumber && <div className="text-muted-foreground mt-1">CGHS: {detail.cghsNumber}</div>}
                            </div>
                            <div>
                              <div className="font-medium mb-1">Leave Balance</div>
                              {detail.leaveBalances?.map((lb: any) => (
                                <div key={lb.id} className="text-muted-foreground">{lb.leaveType}: {lb.balance} of {lb.entitled} remaining</div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </Fragment>
              ))
            )}
          </div>
          {hasQuery && totalPages > 1 && <Pager page={page} totalPages={totalPages} onChange={setPage} />}
        </Panel>

        <Panel className="p-4 space-y-4">
          <div>
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5"><ShieldCheck className="size-3.5" /> Leave Rules</h3>
            <div className="space-y-2">
              {leaveRules.map((r: any) => (
                <div key={r.leaveType} className="text-xs border border-border rounded-md p-2">
                  <div className="font-semibold">{r.leaveType} · {r.entitledDaysPerYear}d/yr</div>
                  <div className="text-muted-foreground mt-0.5">{r.eligibilityNote}</div>
                  {r.carryForwardAllowed && <div className="text-muted-foreground">Carry-forward up to {r.maxCarryForward}d</div>}
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5"><Calendar className="size-3.5" /> Upcoming Holidays</h3>
            <div className="space-y-1.5">
              {holidays.length === 0 ? (
                <div className="text-xs text-muted-foreground">None in the next 90 days.</div>
              ) : (
                holidays.slice(0, 6).map((h: any) => (
                  <div key={h.id} className="flex items-center justify-between text-xs">
                    <span>{h.name}</span>
                    <span className="text-muted-foreground">{new Date(`${h.date}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </Panel>
      </div>
    </Section>
  );
}