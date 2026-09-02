import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Sparkles, Send, FileBarChart, Clock, History, Loader2, ArrowUpRight, Mic, MicOff } from "lucide-react";
import { Panel, Pill } from "@/components/layout/section";
import { COPILOT_SUGGESTIONS } from "@/lib/mock-data";
import { aiApi, coreApi, ApiError } from "@/lib/api-client";
import { useDepartment, filterByDept } from "@/context/department-context";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import type { Msg, ReportType } from "@/types/copilot";

export const Route = createFileRoute("/copilot")({
  head: () => ({ meta: [{ title: "AWIP Copilot · AWIP" }] }),
  component: CopilotPage,
});

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function CopilotPage() {
  const [msgs, setMsgs] = useState<Msg[]>([
    {
      role: "ai",
      text:
        "Welcome, Commissioner. I'm AWIP Copilot. I can prepare executive briefs, retirement and promotion lists, cadre strength reports, and run workforce queries in plain English. Pick a suggestion or type a question.",
    },
  ]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [downloadingReport, setDownloadingReport] = useState<string | null>(null);
  const navigate = useNavigate();
  const speech = useSpeechRecognition((transcript) => setInput(transcript));
  const { department } = useDepartment();

  const send = async (text: string) => {
    if (!text.trim() || isSending) return;
    const user: Msg = { role: "user", text };
    setMsgs((m) => [...m, user]);
    setInput("");
    setIsSending(true);
    setMsgs((m) => [...m, { role: "ai", text: "", streaming: true }]);
    try {
      const { response, employeeId, reportType, redirect, quickActions } = await aiApi.chat(
        text, undefined,
        (textSoFar) => setMsgs((m) => {
          const next = [...m];
          next[next.length - 1] = { ...next[next.length - 1], text: textSoFar };
          return next;
        }),
      );
      setMsgs((m) => {
        const next = [...m];
        next[next.length - 1] = { role: "ai", text: response, employeeId, reportType, redirect, quickActions, streaming: false };
        return next;
      });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "AWIP Copilot is unavailable right now — is server-ai running with Ollama?";
      setMsgs((m) => {
        const next = [...m];
        next[next.length - 1] = { role: "ai", text: message };
        return next;
      });
    } finally {
      setIsSending(false);
    }
  };

  const downloadReport = async (reportType: ReportType, employeeId?: string, context?: { question: string; answer: string }) => {
    setDownloadingReport(reportType);
    try {
      if (reportType === "service_record" && employeeId) {
        saveBlob(await aiApi.downloadServiceRecordReport(employeeId), `service-record-${employeeId}.pdf`);
      } else if (reportType === "department_digest") {
        const { data } = await coreApi.getDepartmentProfiles();
        saveBlob(await aiApi.downloadDepartmentDigestReport(filterByDept(data, department), context), "department-digest.pdf");
      } else if (reportType === "risk_summary") {
        const [{ data: grievances }, { data: legalCases }] = await Promise.all([coreApi.getGrievances(), coreApi.getLegalCases()]);
        saveBlob(
          await aiApi.downloadRiskSummaryReport(filterByDept(grievances, department), filterByDept(legalCases, department), context),
          "risk-summary.pdf",
        );
      }
    } catch {
      // Silently ignored — the button remains available to retry.
    } finally {
      setDownloadingReport(null);
    }
  };

  const reportLabel: Record<ReportType, string> = {
    service_record: "Yes, download PDF",
    department_digest: "Download Department Digest PDF",
    risk_summary: "Download Risk Summary PDF",
  };

  return (
    <div className="h-[calc(100vh-3.5rem)] grid grid-cols-1 xl:grid-cols-[1fr_320px]">
      {/* Conversation */}
      <div className="flex flex-col min-w-0">
        <div className="flex-1 overflow-y-auto scrollbar-thin p-5">
          <div className="max-w-3xl mx-auto space-y-4">
            <div>
              <div className="flex items-center gap-2">
                <div className="size-8 rounded-lg bg-primary grid place-items-center">
                  <Sparkles className="size-4 text-primary-foreground" />
                </div>
                <div>
                  <h1 className="text-base font-semibold">AWIP Copilot</h1>
                  <p className="text-xs text-muted-foreground">AI Workforce Operating System · Executive mode</p>
                </div>
              </div>
            </div>

            {msgs.map((m, i) => (
              <div key={i} className={`flex gap-3 ${m.role === "user" ? "justify-end" : ""}`}>
                {m.role === "ai" && (
                  <div className="size-7 rounded-lg bg-surface-muted text-primary grid place-items-center shrink-0">
                    <Sparkles className="size-3.5" />
                  </div>
                )}
                <div className={`max-w-[80%] rounded-2xl text-sm p-3 ${
                  m.role === "user" ? "bg-primary text-primary-foreground" : "bg-card shadow-[0_4px_24px_rgba(0,93,94,0.06)]"
                }`}>
                  {m.role === "ai" ? (
                    <div className="whitespace-pre-line">
                      {m.text}
                      {m.streaming && <span className="inline-block w-1.5 h-3 -mb-0.5 bg-current animate-pulse" />}
                    </div>
                  ) : (
                    m.text
                  )}
                  {m.role === "ai" && m.reportType && (m.reportType !== "service_record" || m.employeeId) && (
                    <div className="mt-2 text-xs text-muted-foreground">
                      Would you like a downloadable PDF report of this?{" "}
                      <button
                        onClick={() => downloadReport(m.reportType!, m.employeeId, { question: msgs[i - 1]?.role === "user" ? msgs[i - 1].text : "", answer: m.text })}
                        disabled={downloadingReport === m.reportType}
                        className="text-primary hover:underline disabled:opacity-50 inline-flex items-center gap-1"
                      >
                        <FileBarChart className="size-3" />
                        {downloadingReport === m.reportType ? "Preparing…" : reportLabel[m.reportType]}
                      </button>
                    </div>
                  )}
                  {m.role === "ai" && m.redirect && (
                    <div className="mt-2">
                      <button
                        onClick={() => navigate({ to: m.redirect!.path })}
                        className="text-primary hover:underline text-xs inline-flex items-center gap-1"
                      >
                        Open {m.redirect.label} <ArrowUpRight className="size-3" />
                      </button>
                    </div>
                  )}
                  {m.role === "ai" && m.quickActions && m.quickActions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {m.quickActions.map((qa) => (
                        <button
                          key={qa.label}
                          onClick={() => {
                            if (qa.kind === "prompt") send(qa.payload);
                            else if (qa.kind === "navigate") navigate({ to: qa.payload });
                            else downloadReport(qa.payload as ReportType, m.employeeId, { question: msgs[i - 1]?.role === "user" ? msgs[i - 1].text : "", answer: m.text });
                          }}
                          className="text-[11px] px-2 py-1 rounded-full bg-surface-muted hover:bg-primary-soft"
                        >
                          {qa.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isSending && (
              <div className="flex gap-3">
                <div className="size-7 rounded-md bg-primary-soft text-primary grid place-items-center shrink-0">
                  <Sparkles className="size-3.5" />
                </div>
                <div className="rounded-2xl text-sm p-3 bg-card shadow-[0_4px_24px_rgba(0,93,94,0.06)] inline-flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Thinking…
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="p-4 bg-surface shadow-[0_-1px_2px_rgba(15,23,42,0.04)]">
          <div className="max-w-3xl mx-auto">
            <div className="flex flex-wrap gap-1.5 mb-2">
              {COPILOT_SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="text-xs px-2.5 py-1 rounded-full bg-surface-muted hover:bg-primary-soft"
                >
                  {s}
                </button>
              ))}
            </div>
            <form
              onSubmit={(e) => { e.preventDefault(); send(input); }}
              className="flex items-center gap-2 bg-card rounded-2xl p-1.5 border border-border shadow-sm"
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask AWIP — e.g. 'prepare commissioner workforce brief'"
                disabled={isSending}
                className="flex-1 h-9 px-2 bg-transparent focus:outline-none text-sm disabled:opacity-50"
              />
              {speech.isSupported && (
                <button
                  type="button"
                  onClick={() => (speech.isListening ? speech.stop() : speech.start())}
                  disabled={isSending}
                  title={speech.isListening ? "Stop voice input" : "Speak your question"}
                  className={`size-9 grid place-items-center rounded-lg transition-colors disabled:opacity-50 ${
                    speech.isListening ? "bg-destructive/10 text-destructive animate-pulse" : "bg-surface-muted hover:bg-primary-soft"
                  }`}
                >
                  {speech.isListening ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
                </button>
              )}
              <button type="submit" disabled={isSending} className="h-9 px-3 inline-flex items-center gap-1 rounded-lg bg-primary text-primary-foreground text-sm hover:opacity-95 disabled:opacity-50">
                <Send className="size-3.5" /> Send
              </button>
            </form>
            {speech.error && <div className="text-[10px] text-destructive mt-1">{speech.error}</div>}
            <div className="text-[10px] text-muted-foreground mt-1.5">
              AWIP responses include source explanations. Actions are logged in the audit trail.
            </div>
          </div>
        </div>
      </div>

      {/* Sidebar */}
      <aside className="hidden xl:flex flex-col bg-surface shadow-[-1px_0_2px_rgba(15,23,42,0.04)]">
        <div className="p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">AI Capabilities</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Pill tone="primary">Executive Briefs</Pill>
            <Pill tone="primary">Workforce Reports</Pill>
            <Pill tone="primary">Promotion Notes</Pill>
            <Pill tone="primary">Establishment</Pill>
            <Pill tone="primary">Training Plans</Pill>
            <Pill tone="primary">Dept Summaries</Pill>
          </div>
        </div>

        <div className="p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground flex items-center gap-1"><History className="size-3" /> Recent</div>
          <ul className="mt-2 space-y-1.5 text-sm">
            {["Retirement list FY 26-27", "DPC backlog summary", "Engineering vacancy forecast", "Class III training gaps"].map((q) => (
              <li key={q}>
                <button onClick={() => send(q)} className="w-full text-left text-foreground/85 hover:text-primary truncate">
                  · {q}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground flex items-center gap-1"><Clock className="size-3" /> Audit</div>
          <Panel className="mt-2 text-xs">
            All AI outputs are explainable. Sources include service book, HRMS, attendance and establishment ledgers.
          </Panel>
        </div>
      </aside>
    </div>
  );
}
