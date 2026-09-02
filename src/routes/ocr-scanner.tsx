import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ScanText, Upload, Search, Sparkles, FileText, FileCheck2, FileX2,
  GitCompare, History, Tag, ShieldCheck, AlertTriangle, CheckCircle2,
  Loader2, Layers, Filter, Download, Eye, RefreshCw, Brain, Database, Clock,
} from "lucide-react";
import { Panel, Pill, Section } from "@/components/layout/section";
import { aiApi, coreApi } from "@/lib/api-client";
import { cn, formatDate } from "@/lib/utils";
import { Pager } from "@/components/ui/pager";
import { FilterPill } from "@/components/ui/filter-pill";
import { SearchPill } from "@/components/ui/search-pill";

export const Route = createFileRoute("/ocr-scanner")({
  head: () => ({
    meta: [
      { title: "Document Vault · AWIP" },
      { name: "description", content: "Service book digitization, AI OCR, classification, validation, search, comparison and version control." },
    ],
  }),
  component: OcrScannerPage,
});

type Tab = "scan" | "library" | "search" | "compare" | "missing" | "versions";

function OcrScannerPage() {
  const [tab, setTab] = useState<Tab>("scan");

  const tabs: { key: Tab; label: string; icon: typeof ScanText }[] = [
    { key: "scan", label: "Scan & Digitize", icon: ScanText },
    { key: "library", label: "Library", icon: Database },
    { key: "search", label: "Smart Search", icon: Search },
    { key: "compare", label: "Compare", icon: GitCompare },
    { key: "missing", label: "Missing Docs", icon: FileX2 },
    { key: "versions", label: "Versions", icon: History },
  ];

  return (
    <div className="p-5 space-y-5 max-w-[1600px] mx-auto">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <span className="size-9 rounded-lg bg-surface-muted text-primary grid place-items-center">
              <ScanText className="size-5" />
            </span>
            Document Vault
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Service book digitization · AI OCR · classification · validation · search · comparison · version control
          </p>
        </div>
        <div className="flex gap-2">
          <button className="h-9 px-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-card text-sm hover:bg-surface-muted">
            <Download className="size-4" /> Export
          </button>
          <button className="h-9 px-3 inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-95">
            <Upload className="size-4" /> Upload Documents
          </button>
        </div>
      </header>

      <KpiStrip />

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="flex flex-wrap gap-1 px-2 pt-2 border-b border-border bg-surface-muted/30">
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "h-9 px-3 inline-flex items-center gap-1.5 rounded-t-md text-xs font-medium border-b-2 transition-colors -mb-px",
                  active
                    ? "border-primary text-primary bg-card"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-surface-muted/60",
                )}
              >
                <Icon className="size-3.5" /> {t.label}
              </button>
            );
          })}
        </div>

        <div className="p-4">
          {tab === "scan" && <ScanTab />}
          {tab === "library" && <LibraryTab />}
          {tab === "search" && <SearchTab />}
          {tab === "compare" && <CompareTab />}
          {tab === "missing" && <MissingTab />}
          {tab === "versions" && <VersionsTab />}
        </div>
      </div>

      <CapabilitiesSection />
    </div>
  );
}

function KpiStrip() {
  const { data: stats } = useQuery({
    queryKey: ["service-book-stats"],
    queryFn: () => coreApi.getServiceBookStats(),
  });
  const kpis = [
    { l: "Digitized", v: stats ? stats.digitized.toLocaleString("en-IN") : "—", t: "success" as const, i: FileCheck2 },
    { l: "Pending Review", v: stats ? stats.pendingReview.toLocaleString("en-IN") : "—", t: "warning" as const, i: Loader2 },
    { l: "OCR Accuracy", v: stats ? `${stats.ocrAccuracyPct}%` : "—", t: "info" as const, i: Brain },
    { l: "Missing Docs", v: stats ? stats.missing.toLocaleString("en-IN") : "—", t: "destructive" as const, i: FileX2 },
    { l: "Verified", v: stats ? `${stats.verifiedPct}%` : "—", t: "success" as const, i: ShieldCheck },
    { l: "Document Types", v: stats ? String(stats.documentTypes) : "—", t: "primary" as const, i: Tag },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {kpis.map((k) => {
        const Icon = k.i;
        return (
          <Panel key={k.l} className={cn("relative overflow-hidden border-2", TONE_BORDER[k.t])}>
            <div className="flex items-center justify-between">
              <div className={cn("size-8 rounded-lg grid place-items-center", TONE_SOFT_BG[k.t], TONE_TEXT_COLOR[k.t])}>
                <Icon className="size-4" />
              </div>
              <Pill tone={k.t}>Live</Pill>
            </div>
            <div className={cn("text-2xl font-bold tabular-nums mt-2.5", TONE_TEXT_COLOR[k.t])}>{k.v}</div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mt-0.5">{k.l}</div>
          </Panel>
        );
      })}
    </div>
  );
}

type Tone = "success" | "warning" | "info" | "destructive" | "primary";
const TONE_BORDER: Record<Tone, string> = {
  success: "border-success/40", warning: "border-warning/50", info: "border-info/40",
  destructive: "border-destructive/40", primary: "border-primary/40",
};
const TONE_SOFT_BG: Record<Tone, string> = {
  success: "bg-success/15", warning: "bg-warning/15", info: "bg-info/15",
  destructive: "bg-destructive/15", primary: "bg-primary/15",
};
const TONE_TEXT_COLOR: Record<Tone, string> = {
  success: "text-success", warning: "text-warning-foreground", info: "text-info",
  destructive: "text-destructive", primary: "text-primary",
};

type ExtractResult = {
  id: string;
  filename: string;
  status: "Processing" | "Done" | "Error";
  data?: any;
  error?: string;
};

function ScanTab() {
  const [results, setResults] = useState<ExtractResult[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const fileInputRef = useState(() => ({ current: null as HTMLInputElement | null }))[0];

  const handleFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    for (const file of Array.from(files)) {
      const id = `${Date.now()}-${file.name}`;
      setResults((prev) => [{ id, filename: file.name, status: "Processing" }, ...prev]);
      try {
        const data = await aiApi.uploadServiceBook(file);
        setResults((prev) => prev.map((r) => (r.id === id ? { ...r, status: "Done", data } : r)));
      } catch (e: any) {
        setResults((prev) => prev.map((r) => (r.id === id ? { ...r, status: "Error", error: e?.message || "Extraction failed" } : r)));
      }
    }
  };

  const processingCount = results.filter((r) => r.status === "Processing").length;
  const doneCount = results.filter((r) => r.status === "Done").length;
  const errorCount = results.filter((r) => r.status === "Error").length;
  const needsReviewCount = results.filter((r) => r.status === "Done" && r.data?.needs_review).length;
  const reviewReasons = results
    .filter((r) => r.status === "Done" && r.data?.needs_review)
    .flatMap((r) => (r.data.review_reasons ?? []).map((reason: string) => `${r.filename}: ${reason}`));

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
      <Section title="Upload & Digitize" subtitle="Real extraction — digital PDFs, DOCX and XLSX are fully accurate; scanned images need Tesseract installed locally for OCR" className="xl:col-span-2">
        <Panel className="border-dashed border-2 border-border bg-surface-muted/30">
          <div className="py-10 text-center">
            <div className="mx-auto size-12 rounded-full bg-surface-muted text-primary grid place-items-center">
              <Upload className="size-6" />
            </div>
            <div className="mt-3 text-sm font-medium">Drop files here, or click to browse</div>
            <div className="text-xs text-muted-foreground mt-1">
              PDF · JPG · PNG · TIFF · DOCX · XLSX
            </div>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <input
                ref={(el) => { fileInputRef.current = el; }}
                type="file"
                multiple
                accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.docx,.xlsx,.xlsm"
                className="hidden"
                onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="h-9 px-3 inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium"
              >
                <Upload className="size-3.5" /> Select Files
              </button>
            </div>
          </div>
        </Panel>

        <Section title="Extraction Results" subtitle="Real OCR/text extraction output for each uploaded file">
          <Panel padded={false}>
            {results.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">No files uploaded yet.</div>
            ) : (
              <ul className="divide-y divide-border">
                {results.map((r) => (
                  <li key={r.id} className="p-3">
                    <div className="flex items-center gap-3">
                      <div className="size-9 rounded-lg bg-surface-muted text-primary grid place-items-center shrink-0">
                        <FileText className="size-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="text-sm font-medium truncate">{r.filename}</div>
                          {r.data?.family && <Pill tone="neutral">{r.data.family}</Pill>}
                        </div>
                        {r.status === "Done" && r.data && (
                          <div className="text-[11px] text-muted-foreground mt-0.5">
                            {r.data.page_count} page(s) · {(r.data.overall_confidence * 100).toFixed(0)}% confidence
                          </div>
                        )}
                        {r.status === "Error" && (
                          <div className="text-[11px] text-destructive mt-0.5">{r.error}</div>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        {r.status === "Processing" && (
                          <Pill tone="info"><Loader2 className="size-3 animate-spin" /> Processing</Pill>
                        )}
                        {r.status === "Done" && (
                          <Pill tone={r.data.needs_review ? "warning" : "success"}>{r.data.status}</Pill>
                        )}
                        {r.status === "Error" && <Pill tone="destructive">Error</Pill>}
                      </div>
                    </div>
                    {r.status === "Done" && r.data && (
                      <div className="mt-2 pl-12">
                        <button
                          onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                          className="text-[11px] text-primary hover:underline"
                        >
                          {expanded === r.id ? "Hide extracted text" : "View extracted text"}
                        </button>
                        {expanded === r.id && (
                          <div className="mt-2 space-y-2">
                            {r.data.review_reasons?.length > 0 && (
                              <div className="text-[11px] text-warning-foreground bg-warning/10 border border-warning/20 rounded-md p-2">
                                {r.data.review_reasons.join(" · ")}
                              </div>
                            )}
                            <pre className="text-[11px] whitespace-pre-wrap bg-surface border border-border rounded-md p-2 max-h-48 overflow-y-auto">
                              {r.data.text_preview || "(no text extracted)"}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </Section>
      </Section>

      <Section title="AI Pipeline" subtitle="Live status for this upload batch — not a fixed diagram" action={<Pill tone="primary"><Sparkles className="size-3" /> AI</Pill>}>
        <div className="flex items-stretch">
          <PipelineStage
            icon={Upload}
            tone="primary"
            label="Upload"
            detail="PDF, image, or scanned document ingested"
            status={results.length === 0 ? "queued" : "done"}
          />
          <PipelineConnector />
          <PipelineStage
            icon={Brain}
            tone="success"
            label="Document Intelligence"
            detail="OCR, classification & metadata extraction"
            status={processingCount > 0 ? "active" : (doneCount + errorCount) > 0 ? "done" : "queued"}
          />
          <PipelineConnector />
          <PipelineStage
            icon={Eye}
            tone="warning"
            label="Review flagging"
            detail="Identify documents requiring attention"
            status={doneCount > 0 ? "done" : "queued"}
          />
        </div>

        <Panel className="bg-primary-soft border-primary/30 mt-4">
          <div className="text-xs font-semibold text-primary flex items-center gap-1.5">
            <Sparkles className="size-3.5" /> AI Insight
          </div>
          {reviewReasons.length > 0 ? (
            <ul className="text-xs mt-1 text-foreground/80 space-y-1">
              {reviewReasons.slice(0, 5).map((r, i) => <li key={i}>• {r}</li>)}
            </ul>
          ) : (
            <p className="text-xs mt-1 text-foreground/80">
              {results.length === 0 ? "Upload files to see real review flags here." : "No documents in this batch need review."}
            </p>
          )}
        </Panel>
      </Section>
    </div>
  );
}

function PipelineConnector() {
  return <div className="w-4 md:w-6 shrink-0 self-center border-t-2 border-dashed border-border" />;
}

function PipelineStage({ icon: Icon, tone, label, detail, status }: {
  icon: typeof Upload; tone: Tone; label: string; detail: string; status: "done" | "active" | "queued";
}) {
  return (
    <div className={cn("relative flex-1 min-w-0 rounded-xl border-2 p-4 text-center", TONE_BORDER[tone], TONE_SOFT_BG[tone])}>
      <div className={cn(
        "absolute top-2 right-2 size-5 rounded-full grid place-items-center",
        status === "done" && "bg-success/20 text-success",
        status === "active" && "bg-primary text-primary-foreground",
        status === "queued" && "bg-surface-muted text-muted-foreground",
      )}>
        {status === "done" ? <CheckCircle2 className="size-3.5" /> : status === "active" ? <Loader2 className="size-3 animate-spin" /> : <Clock className="size-3" />}
      </div>
      <div className={cn("mx-auto size-10 rounded-full grid place-items-center", TONE_TEXT_COLOR[tone])}>
        <Icon className="size-5" />
      </div>
      <div className="text-xs font-semibold mt-2">{label}</div>
      <div className="text-[10.5px] text-muted-foreground mt-0.5 leading-snug">{detail}</div>
    </div>
  );
}

const LIBRARY_PAGE_SIZE = 20;

function LibraryTab() {
  const [type, setType] = useState("All Types");
  const [status, setStatus] = useState("All Status");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => setPage(1), [type, status, search]);

  const { data: typesResp } = useQuery({
    queryKey: ["service-book-types"],
    queryFn: () => coreApi.getServiceBookTypes(),
  });
  const { data: docsResp, isFetching } = useQuery({
    queryKey: ["service-book", type, status, search, page],
    queryFn: () => coreApi.getServiceBook({
      type: type !== "All Types" ? type : undefined,
      status: status !== "All Status" ? status : undefined,
      q: search || undefined,
      page,
      limit: LIBRARY_PAGE_SIZE,
    }),
  });

  const docs = docsResp?.data ?? [];
  const types = ["All Types", ...(typesResp?.data ?? [])];
  const statuses = ["All Status", "Verified", "Pending Review", "Missing"];
  const totalPages = docsResp?.totalPages ?? 1;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
          <Filter className="size-3" /> Filters
        </div>
        <FilterPill value={type} onChange={setType} options={types} label="All Types" size="compact" />
        <FilterPill value={status} onChange={setStatus} options={statuses} label="All Status" size="compact" />
        <SearchPill
          value={search}
          onChange={setSearch}
          placeholder="Search employee ID or name…"
          size="compact"
          className="w-56"
        />
        <div className="ml-auto text-[11px] text-muted-foreground">{docsResp?.total?.toLocaleString("en-IN") ?? "—"} documents</div>
      </div>
      <Panel padded={false}>
        <div className="overflow-x-auto overflow-y-hidden scrollbar-thin rounded-t-xl">
          <table className="w-full text-sm">
            <thead className="bg-sidebar text-[11px] uppercase tracking-wider text-sidebar-foreground">
              <tr>
                <th className="text-left font-medium px-3 py-2">Document</th>
                <th className="text-left font-medium px-3 py-2">Employee</th>
                <th className="text-left font-medium px-3 py-2">Type</th>
                <th className="text-left font-medium px-3 py-2">Date</th>
                <th className="text-left font-medium px-3 py-2">OCR</th>
                <th className="text-left font-medium px-3 py-2">Status</th>
                <th className="text-right font-medium px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {!isFetching && docs.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-xs text-muted-foreground">No documents match these filters.</td></tr>
              )}
              {docs.map((d, i) => (
                <tr key={d.id} className={cn("border-t border-border hover:bg-surface-muted/80", i % 2 === 1 && "bg-surface-muted")}>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">{d.id}</td>
                  <td className="px-3 py-2 font-medium">{d.employeeName} <span className="text-muted-foreground font-normal">({d.employeeId})</span></td>
                  <td className="px-3 py-2">{d.type}</td>
                  <td className="px-3 py-2 tabular-nums">{formatDate(d.date)}</td>
                  <td className="px-3 py-2 tabular-nums">{d.ocrScore ? `${d.ocrScore}%` : "—"}</td>
                  <td className="px-3 py-2">
                    <Pill tone={d.status === "Verified" ? "success" : d.status === "Missing" ? "destructive" : "warning"}>
                      {d.status === "Verified" ? <CheckCircle2 className="size-3" /> : <AlertTriangle className="size-3" />}
                      {d.status}
                    </Pill>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex gap-1">
                      <button className="size-7 grid place-items-center rounded hover:bg-surface-muted" title="Preview"><Eye className="size-3.5" /></button>
                      <button className="size-7 grid place-items-center rounded hover:bg-surface-muted" title="Re-run OCR"><RefreshCw className="size-3.5" /></button>
                      <button className="size-7 grid place-items-center rounded hover:bg-surface-muted" title="Download"><Download className="size-3.5" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      {totalPages > 1 && <Pager page={page} totalPages={totalPages} onChange={setPage} />}
    </div>
  );
}

function SearchTab() {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
      <Section title="Universal Search" subtitle="Natural language across all digitized documents" className="xl:col-span-2">
        <Panel>
          <div className="relative">
            <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              className="w-full h-11 pl-9 pr-3 rounded-md bg-surface-muted border border-border text-sm focus:outline-none focus:ring-2 focus:ring-ring/30"
              placeholder="e.g. 'Promotion orders after 2018' or 'AMC-10042 joining report'"
            />
          </div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {[
              "Show all promotion orders after 2018",
              "Find missing joining reports for Class IV",
              "Service history for AMC-10042",
              "Documents with OCR confidence below 90%",
              "Mismatched ACP dates this year",
              "Recently re-validated documents",
            ].map((q) => (
              <button key={q} className="text-left text-sm p-2 rounded border border-border bg-surface-muted hover:bg-primary-soft hover:border-primary/40">
                {q}
              </button>
            ))}
          </div>
        </Panel>
      </Section>
      <Section title="AI Findings" action={<Pill tone="primary"><Sparkles className="size-3" /> Live</Pill>}>
        <Panel className="bg-primary-soft border-primary/30 text-xs space-y-1.5">
          <div className="font-semibold text-primary flex items-center gap-1"><Sparkles className="size-3" /> Detected</div>
          <ul className="space-y-1 text-foreground/80">
            <li>• AMC-10042 — promotion order present, joining report missing (94%)</li>
            <li>• AMC-10076 — transfer order present, relieving order missing (91%)</li>
            <li>• AMC-10211 — disciplinary order date conflicts with attendance (87%)</li>
            <li>• 32 documents tagged for re-OCR (low confidence)</li>
          </ul>
        </Panel>
      </Section>
    </div>
  );
}

function CompareTab() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {[
          { label: "Document A", id: "DOC-1001", type: "Promotion Order", date: "2024-03-12", version: "v3" },
          { label: "Document B", id: "DOC-1014", type: "Promotion Order", date: "2024-03-12", version: "v1" },
        ].map((d) => (
          <Panel key={d.label}>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{d.label}</div>
            <div className="text-sm font-semibold mt-0.5">{d.id} · {d.type}</div>
            <div className="text-xs text-muted-foreground">Date: {formatDate(d.date)} · {d.version}</div>
            <div className="mt-3 h-40 rounded-md border border-dashed border-border bg-surface-muted grid place-items-center text-xs text-muted-foreground">
              Document preview
            </div>
          </Panel>
        ))}
      </div>
      <Panel className="bg-primary-soft border-primary/30">
        <div className="text-xs font-semibold text-primary flex items-center gap-1.5">
          <GitCompare className="size-3.5" /> AI Comparison Result
        </div>
        <ul className="text-xs text-foreground/80 mt-2 space-y-1">
          <li>• 3 textual differences detected (order number prefix, signatory name, effective date)</li>
          <li>• Stamp signature consistency: <span className="text-success font-medium">98% match</span></li>
          <li>• Recommendation: keep Document A as canonical, archive B as superseded.</li>
        </ul>
      </Panel>
    </div>
  );
}

function MissingTab() {
  const { data: missingResp } = useQuery({
    queryKey: ["service-book", "Missing", "missing-tab"],
    queryFn: () => coreApi.getServiceBook({ status: "Missing", limit: 25 }),
  });
  const { data: completenessResp } = useQuery({
    queryKey: ["service-book-completeness"],
    queryFn: () => coreApi.getServiceBookCompleteness(),
  });
  const missing = missingResp?.data ?? [];
  const completeness = [...(completenessResp?.data ?? [])].sort((a, b) => a.completenessPct - b.completenessPct);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
      <Section
        title="Missing Document Detection"
        subtitle={missingResp ? `${missingResp.total.toLocaleString("en-IN")} documents flagged missing · showing first ${missing.length}` : "AI cross-checks service book completeness"}
        className="xl:col-span-2"
      >
        <Panel padded={false}>
          <ul className="divide-y divide-border">
            {missing.length === 0 && (
              <li className="p-6 text-center text-xs text-muted-foreground">No missing documents.</li>
            )}
            {missing.map((m) => (
              <li key={m.id} className="p-3 flex items-center gap-3">
                <div className="size-9 rounded-lg bg-surface-muted text-destructive grid place-items-center shrink-0">
                  <FileX2 className="size-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{m.type} missing for <span className="tabular-nums">{m.employeeName} ({m.employeeId})</span></div>
                  <div className="text-[11px] text-muted-foreground">Detected via cross-check with related orders · {m.id}</div>
                </div>
                <button className="h-8 px-2.5 inline-flex items-center gap-1 rounded-md border border-border bg-card text-xs hover:bg-surface-muted">
                  <Upload className="size-3.5" /> Request Upload
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      </Section>
      <Section title="Completeness Score" subtitle="Per department">
        <Panel className="space-y-2">
          {completeness.map((r) => (
            <div key={r.department}>
              <div className="flex justify-between text-xs">
                <span>{r.department}</span>
                <span className="tabular-nums font-medium">{r.completenessPct}%</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-surface-muted overflow-hidden">
                <div className={cn("h-full", r.completenessPct >= 90 ? "bg-success" : r.completenessPct >= 80 ? "bg-warning" : "bg-destructive")} style={{ width: `${r.completenessPct}%` }} />
              </div>
            </div>
          ))}
        </Panel>
      </Section>
    </div>
  );
}

function VersionsTab() {
  const versions = [
    { v: "v4", who: "S. Iyer", when: "2025-06-22 14:02", change: "Re-OCR with enhanced model (+2.1% confidence)" },
    { v: "v3", who: "AI Pipeline", when: "2025-04-10 09:31", change: "Auto-reclassified as 'Promotion Order'" },
    { v: "v2", who: "M. Joshi", when: "2024-12-01 16:48", change: "Metadata corrected (effective date)" },
    { v: "v1", who: "Bulk Import", when: "2024-03-12 11:00", change: "Initial digitization from physical service book" },
  ];
  return (
    <div className="space-y-3">
      <Panel>
        <div className="flex items-center gap-2 text-sm">
          <Layers className="size-4 text-primary" />
          <span className="font-medium">DOC-1001 · Promotion Order · AMC-10042</span>
          <Pill tone="success"><CheckCircle2 className="size-3" /> Current v4</Pill>
        </div>
      </Panel>
      <Panel padded={false}>
        <ol className="divide-y divide-border">
          {versions.map((v) => (
            <li key={v.v} className="p-3 flex items-start gap-3">
              <div className="size-8 rounded-full bg-surface-muted text-primary grid place-items-center text-[10px] font-semibold">{v.v}</div>
              <div className="flex-1 min-w-0">
                <div className="text-sm">{v.change}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">{v.who} · {v.when}</div>
              </div>
              <div className="flex gap-1">
                <button className="h-7 px-2 inline-flex items-center gap-1 rounded border border-border bg-card text-[11px] hover:bg-surface-muted">
                  <Eye className="size-3" /> View
                </button>
                <button className="h-7 px-2 inline-flex items-center gap-1 rounded border border-border bg-card text-[11px] hover:bg-surface-muted">
                  <GitCompare className="size-3" /> Diff
                </button>
              </div>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}

function CapabilitiesSection() {
  const caps = [
    { i: ScanText, l: "Service Book Digitization", d: "Bulk capture & paginated scanning" },
    { i: Brain, l: "Intelligent OCR", d: "Multi-language, handwritten support" },
    { i: Tag, l: "AI Classification", d: "24+ document types" },
    { i: FileText, l: "Metadata Extraction", d: "Order no, dates, signatories" },
    { i: ShieldCheck, l: "Validation", d: "Cross-check against service rules" },
    { i: Search, l: "Smart Search", d: "Natural language queries" },
    { i: GitCompare, l: "Document Comparison", d: "Textual & signature diff" },
    { i: FileX2, l: "Missing Doc Detection", d: "Completeness graph" },
    { i: History, l: "Version Control", d: "Full audit history" },
    { i: ShieldCheck, l: "Audit Trail", d: "Tamper-evident log" },
    { i: Database, l: "Bulk Import", d: "ZIP / scanner / network share" },
    { i: Sparkles, l: "AI Anomaly Alerts", d: "Date / cadre / ACP conflicts" },
  ];
  return (
    <Section title="Capabilities">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {caps.map(({ i: Icon, l, d }) => (
          <Panel key={l} className="flex items-start gap-3">
            <div className="size-8 rounded-lg bg-surface-muted text-primary grid place-items-center shrink-0">
              <Icon className="size-4" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium">{l}</div>
              <div className="text-[11px] text-muted-foreground">{d}</div>
            </div>
          </Panel>
        ))}
      </div>
    </Section>
  );
}
