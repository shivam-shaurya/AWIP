import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Users, Briefcase, Award, CheckCircle2, XCircle, X, Loader2, ArrowRight, Star } from "lucide-react";
import { Panel, Pill, Section } from "@/components/layout/section";
import { Pager } from "@/components/ui/pager";
import { FilterPill } from "@/components/ui/filter-pill";
import { SearchPill } from "@/components/ui/search-pill";
import { useDepartment } from "@/context/department-context";
import { coreApi } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/recruitment")({
  head: () => ({ meta: [{ title: "Recruitment · AWIP" }] }),
  component: RecruitmentPage,
});

const STATUS_ORDER = [
  "Applied",
  "Screening",
  "InterviewScheduled",
  "InterviewCompleted",
  "OfferExtended",
  "OfferAccepted",
  "OfferDeclined",
  "Rejected",
] as const;

const STATUS_LABEL: Record<string, string> = {
  Applied: "Applied",
  Screening: "Screening",
  InterviewScheduled: "Interview Scheduled",
  InterviewCompleted: "Interview Completed",
  OfferExtended: "Offer Extended",
  OfferAccepted: "Offer Accepted",
  OfferDeclined: "Offer Declined",
  Rejected: "Rejected",
};

function statusTone(status: string): "success" | "warning" | "destructive" | "info" | "primary" | "neutral" {
  if (status === "OfferAccepted") return "success";
  if (status === "OfferDeclined" || status === "Rejected") return "destructive";
  if (status === "OfferExtended") return "primary";
  if (status === "InterviewScheduled" || status === "InterviewCompleted") return "info";
  if (status === "Screening") return "warning";
  return "neutral";
}

const PAGE_SIZE = 10;

const NEXT_STATUS: Record<string, string | undefined> = {
  Applied: "Screening",
  Screening: "InterviewScheduled",
  InterviewScheduled: "InterviewCompleted",
  InterviewCompleted: "OfferExtended",
  OfferExtended: "OfferAccepted",
};

function RecruitmentPage() {
  const { department } = useDepartment();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const deptParam = department === "All Departments" ? undefined : department;
  const statusParam = statusFilter === "All" ? undefined : statusFilter;

  const { data: summaryResp } = useQuery({
    queryKey: ["recruitment-summary"],
    queryFn: () => coreApi.getRecruitmentSummary(),
  });
  const summary = summaryResp ?? { totalApplications: 0, inPipeline: 0, offersExtended: 0, offersAccepted: 0, rejected: 0, byStatus: {} };

  const { data: candidatesResp, isLoading } = useQuery({
    queryKey: ["candidates", deptParam, statusParam],
    queryFn: () => coreApi.getCandidates({ department: deptParam, status: statusParam }),
  });
  const candidates = candidatesResp?.data ?? [];

  const filtered = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c: any) =>
      c.name.toLowerCase().includes(q) || (c.designation ?? "").toLowerCase().includes(q) || (c.department ?? "").toLowerCase().includes(q),
    );
  }, [candidates, searchTerm]);

  useEffect(() => setPage(1), [department, statusFilter, searchTerm]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="p-5 max-w-[1600px] mx-auto space-y-6 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <UserPlus className="size-6 text-primary" />
            Recruitment
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Candidate pipeline, screening, interviews and offer management.</p>
        </div>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <KpiTile icon={<Users className="size-4 text-primary" />} label="Total Applications" value={summary.totalApplications} />
        <KpiTile icon={<Briefcase className="size-4 text-info" />} label="In Pipeline" value={summary.inPipeline} />
        <KpiTile icon={<Award className="size-4 text-warning-foreground" />} label="Offers Extended" value={summary.offersExtended} />
        <KpiTile icon={<CheckCircle2 className="size-4 text-success" />} label="Offers Accepted" value={summary.offersAccepted} />
        <KpiTile icon={<XCircle className="size-4 text-destructive" />} label="Rejected" value={summary.rejected} />
      </div>

      {/* Candidate list */}
      <Section
        title="Candidate Pipeline"
        subtitle="Filter by status and department to track applicants through the hiring flow"
        action={
          <div className="flex items-center gap-2">
            <FilterPill
              value={statusFilter}
              onChange={setStatusFilter}
              options={[{ value: "All", label: "All Statuses" }, ...STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABEL[s] }))]}
              label="All Statuses"
              size="compact"
            />
            <SearchPill value={searchTerm} onChange={setSearchTerm} placeholder="Search candidates…" size="compact" className="w-64" />
          </div>
        }
      >
        <Panel padded={false} className="border-border shadow-sm">
          <div className="overflow-x-auto overflow-y-hidden scrollbar-thin rounded-t-xl">
            <table className="w-full text-sm">
              <thead className="bg-sidebar text-[10px] uppercase tracking-wider text-sidebar-foreground">
                <tr>
                  <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Candidate</th>
                  <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Department / Designation</th>
                  <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Source</th>
                  <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Status</th>
                  <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Resume Score</th>
                  <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Experience</th>
                  <th className="text-left font-semibold px-4 py-3 whitespace-nowrap">Applied</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading ? (
                  <tr><td colSpan={7} className="px-4 py-12 text-center text-muted-foreground"><Loader2 className="size-5 animate-spin inline" /></td></tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <Users className="size-8 opacity-20" />
                        <p>No candidates found for this scope.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  visible.map((c: any, i: number) => (
                    <tr
                      key={c.id}
                      onClick={() => setSelectedId(c.id)}
                      className={cn("hover:bg-surface-muted/70 transition-colors cursor-pointer group", i % 2 === 1 && "bg-surface-muted")}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground group-hover:text-primary transition-colors">{c.name}</div>
                        <div className="text-xs text-muted-foreground">{c.email}</div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        <div className="text-foreground/90">{c.department}</div>
                        <div className="text-xs">{c.designation}</div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{c.source}</td>
                      <td className="px-4 py-3">
                        <Pill tone={statusTone(c.status)}>{STATUS_LABEL[c.status] ?? c.status}</Pill>
                      </td>
                      <td className="px-4 py-3">
                        {c.resumeScore != null ? (
                          <div className="flex items-center gap-1.5">
                            <Star className="size-3.5 text-warning-foreground" />
                            <span className="font-medium tabular-nums">{c.resumeScore}</span>
                          </div>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground tabular-nums">{c.experienceYears != null ? `${c.experienceYears} yrs` : "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                        {c.appliedDate ? new Date(c.appliedDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
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

      {selectedId && <CandidateDrawer candidateId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function KpiTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="bg-card rounded-xl border border-border p-4 shadow-sm flex items-center gap-3">
      <div className="size-10 rounded-full bg-primary/10 grid place-items-center shrink-0">{icon}</div>
      <div>
        <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
        <div className="text-2xl font-semibold tracking-tight text-foreground leading-tight tabular-nums">{value}</div>
      </div>
    </div>
  );
}

function CandidateDrawer({ candidateId, onClose }: { candidateId: string; onClose: () => void }) {
  const queryClient = useQueryClient();

  const { data: candidate, isLoading } = useQuery({
    queryKey: ["candidate", candidateId],
    queryFn: () => coreApi.getCandidateDetail(candidateId),
  });

  const advance = useMutation({
    mutationFn: (status: string) => coreApi.updateCandidateStatus(candidateId, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["candidates"] });
      queryClient.invalidateQueries({ queryKey: ["recruitment-summary"] });
      queryClient.invalidateQueries({ queryKey: ["candidate", candidateId] });
    },
  });

  const interviews = candidate?.interviews ?? [];
  const status = candidate?.status;
  const nextStatus = status ? NEXT_STATUS[status] : undefined;
  const isTerminal = status === "OfferAccepted" || status === "OfferDeclined" || status === "Rejected";

  return (
    <>
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 w-full sm:w-[460px] bg-card border-l border-border shadow-2xl z-50 p-6 flex flex-col overflow-y-auto scrollbar-thin animate-in slide-in-from-right duration-300">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-lg">{candidate?.name ?? "Candidate"}</h2>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-surface-muted"><X className="size-5" /></button>
        </div>

        {isLoading || !candidate ? (
          <div className="flex-1 grid place-items-center text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
        ) : (
          <>
            <div className="space-y-1.5 mb-4">
              <div className="text-sm text-muted-foreground">{candidate.designation} · {candidate.department}</div>
              <div className="flex items-center gap-2 flex-wrap">
                <Pill tone={statusTone(candidate.status)}>{STATUS_LABEL[candidate.status] ?? candidate.status}</Pill>
                <Pill tone="neutral">{candidate.source}</Pill>
                {candidate.resumeScore != null && <Pill tone="warning">Score {candidate.resumeScore}</Pill>}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4 text-xs">
              <div className="bg-surface-muted/40 rounded-md p-2.5">
                <div className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Email</div>
                <div className="truncate">{candidate.email}</div>
              </div>
              <div className="bg-surface-muted/40 rounded-md p-2.5">
                <div className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Phone</div>
                <div>{candidate.phone ?? "—"}</div>
              </div>
              <div className="bg-surface-muted/40 rounded-md p-2.5">
                <div className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Experience</div>
                <div>{candidate.experienceYears != null ? `${candidate.experienceYears} yrs` : "—"}</div>
              </div>
              <div className="bg-surface-muted/40 rounded-md p-2.5">
                <div className="text-[10px] uppercase text-muted-foreground font-semibold mb-1">Expected CTC</div>
                <div>{candidate.expectedCtc != null ? `₹${Number(candidate.expectedCtc).toLocaleString("en-IN")}` : "—"}</div>
              </div>
            </div>

            {candidate.aiSummary && (
              <div className="text-xs text-muted-foreground border-l-2 border-primary/30 pl-2 mb-6 leading-relaxed">
                <span className="font-semibold text-primary/70 mr-1">AI Summary:</span>{candidate.aiSummary}
              </div>
            )}

            <div className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mb-2">Interview Rounds</div>
            <div className="space-y-2 mb-6">
              {interviews.length === 0 ? (
                <div className="text-xs text-muted-foreground">No interviews scheduled yet.</div>
              ) : (
                interviews.map((iv: any) => (
                  <div key={iv.id} className="text-xs bg-surface border border-border rounded-md p-2.5">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-semibold">{iv.round}</span>
                      <Pill tone="neutral">{iv.status}</Pill>
                    </div>
                    <div className="text-muted-foreground">{iv.interviewer} · {iv.scheduledAt ? new Date(iv.scheduledAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}</div>
                    {iv.feedback && <div className="mt-1">{iv.feedback}</div>}
                    {iv.rating != null && <div className="mt-1 text-warning-foreground font-medium">Rating: {iv.rating}/5</div>}
                  </div>
                ))
              )}
            </div>

            {!isTerminal && (
              <div className="mt-auto pt-4 border-t border-border space-y-2">
                {nextStatus && (
                  <button
                    onClick={() => advance.mutate(nextStatus)}
                    disabled={advance.isPending}
                    className="w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-95 disabled:opacity-50 inline-flex items-center justify-center gap-2"
                  >
                    {advance.isPending && <Loader2 className="size-3.5 animate-spin" />}
                    Advance to {STATUS_LABEL[nextStatus]} <ArrowRight className="size-3.5" />
                  </button>
                )}
                <button
                  onClick={() => advance.mutate("Rejected")}
                  disabled={advance.isPending}
                  className="w-full h-9 rounded-md border border-destructive/30 text-destructive text-sm font-medium hover:bg-destructive/10 disabled:opacity-50 inline-flex items-center justify-center gap-2"
                >
                  Reject Candidate
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
