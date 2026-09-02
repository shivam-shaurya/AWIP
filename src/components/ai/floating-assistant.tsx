import { useState, useEffect, useRef } from "react";
import { useRouterState, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { X, Minus, Send, Loader2, FileBarChart, ArrowUpRight, Mic, MicOff, RefreshCw } from "lucide-react";
import { useUI } from "@/context/ui-context";
import { useDepartment, filterByDept } from "@/context/department-context";
import { useAuth } from "@/context/auth-context";
import { aiApi, coreApi, ApiError } from "@/lib/api-client";
import { onAssistantSeedMessage } from "@/lib/assistant-bridge";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import type { Msg, QuickAction, ReportType } from "@/types/copilot";
import { cn } from "@/lib/utils";

const GREETED_KEY = "awip.heera.greetedForLogin"; // was "awip.heera.greeted" — renamed since semantics changed to a per-login value compare

// Shown only before the first real exchange, when there's no reply yet to
// derive contextual chips from.
const DEFAULT_SUGGESTIONS: QuickAction[] = [
  { label: "Summarize this page", kind: "prompt", payload: "Summarize this page" },
  { label: "Recommend action", kind: "prompt", payload: "Recommend action" },
  { label: "Show risks", kind: "prompt", payload: "Show risks" },
];

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const REPORT_LABEL: Record<ReportType, string> = {
  service_record: "Download PDF",
  department_digest: "Download Department Digest PDF",
  risk_summary: "Download Risk Summary PDF",
};

function pageContext(path: string) {
  if (path === "/") return { name: "Workforce Command Centre", hint: "Summarize today's workforce posture and active risks." };
  if (path.startsWith("/employees/")) return { name: "Employee 360", hint: "Generate an executive summary for this employee." };
  if (path === "/employees") return { name: "Employee Directory", hint: "Find employees with missing service records." };
  if (path === "/tasks") return { name: "Task Management", hint: "Recommend a department and SLA for a new task." };
  if (path === "/analytics") return { name: "Analytics", hint: "Explain the trend in this view." };
  if (path === "/reports") return { name: "Reports", hint: "Prepare a Commissioner workforce brief." };
  if (path === "/finance") return { name: "Finance", hint: "Which departments are over budget this month?" };
  if (path === "/legal") return { name: "Legal & Compliance", hint: "Summarize open legal cases and upcoming statutory deadlines." };
  if (path === "/grievances") return { name: "Grievance Management", hint: "Summarize open and escalated grievances." };
  if (path === "/leave") return { name: "Leave Management", hint: "Summarize pending leave approvals." };
  if (path === "/recruitment") return { name: "Recruitment", hint: "Summarize the current hiring pipeline." };
  if (path === "/onboarding") return { name: "Onboarding", hint: "Summarize onboarding cases in progress." };
  if (path === "/org360") return { name: "Org 360", hint: "Which departments have the lowest health score?" };
  if (path === "/calendar") return { name: "Calendar", hint: "What's coming up this month?" };
  if (path === "/ocr-scanner") return { name: "OCR Scanner", hint: "What documents can I digitize here?" };
  if (path === "/privacy") return { name: "Data Rights Center", hint: "Summarize open privacy requests." };
  if (path === "/copilot") return { name: "Copilot", hint: "Ask a workforce question." };
  if (path === "/settings") return { name: "Settings", hint: "Ask a workforce question." };
  if (path.startsWith("/my")) return { name: "My Records", hint: "Summarize my leave, insurance, and documents." };
  return { name: "AWIP", hint: "Ask a workforce question." };
}

// Lightweight inline-markdown: just **bold** and "- " bullet lines. Skips a
// full markdown dependency since the AI only ever emits these two forms.
function renderInline(text: string, keyPrefix: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4
      ? <strong key={`${keyPrefix}-${i}`} className="font-semibold">{part.slice(2, -2)}</strong>
      : <span key={`${keyPrefix}-${i}`}>{part}</span>,
  );
}

function FormattedText({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => {
        const isBullet = /^[-*]\s+/.test(line);
        const content = renderInline(isBullet ? line.replace(/^[-*]\s+/, "") : line, `l${i}`);
        return isBullet ? (
          <div key={i} className="flex gap-1.5 pl-0.5">
            <span className="text-muted-foreground/60">•</span>
            <span>{content}</span>
          </div>
        ) : (
          <div key={i}>{line ? content : " "}</div>
        );
      })}
    </>
  );
}

// Renders whatever text has streamed in so far, plus a small blinking cursor
// while more is still arriving — real token-by-token delivery from the
// streaming chat endpoint already reveals text incrementally, so there's no
// need for the old fixed-speed post-hoc typewriter replay.
function AiMessageBody({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <>
      <FormattedText text={text} />
      {streaming && <span className="inline-block w-1.5 h-3 -mb-0.5 bg-current animate-pulse" />}
    </>
  );
}

export function FloatingAssistant() {
  const { assistantOpen, setAssistantOpen, t, pendingAssistantPrompt, clearPendingAssistantPrompt } = useUI();
  const { department } = useDepartment();
  const { user } = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const ctx = pageContext(pathname);
  const [minimized, setMinimized] = useState(false);
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [downloadingReport, setDownloadingReport] = useState<string | null>(null);
  const [hasGreeted, setHasGreeted] = useState(() => {
    if (typeof window === "undefined") return true;
    const currentLogin = sessionStorage.getItem("awip.heera.loginSessionId");
    return currentLogin !== null && sessionStorage.getItem(GREETED_KEY) === currentLogin;
  });
  // True from the moment the user clicks Heera's teaser bubble/icon until the
  // approval-menu message has been built — decoupled from mount/login timing
  // entirely, so it only ever depends on a click that already happened.
  const [pendingApprovalMenu, setPendingApprovalMenu] = useState(false);
  const [approvalMenuTimedOut, setApprovalMenuTimedOut] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const speech = useSpeechRecognition((transcript) => setInput(transcript));

  // Heera's welcome-and-route flow: once per session, a small speech bubble
  // (no network dependency, always shows) invites the user to explore AWIP.
  // Clicking it opens the full panel and only THEN fetches a live-counted
  // menu of what needs approval today.
  const showGreetingBubble = !hasGreeted && !!user && pathname === "/" && !assistantOpen;

  const { data: taskAlertsData, isError: taskAlertsErrored } = useQuery({
    queryKey: ["task-alerts"],
    queryFn: () => coreApi.getTaskAlerts(),
    enabled: pendingApprovalMenu,
  });
  const { data: legalCasesData, isError: legalCasesErrored } = useQuery({
    queryKey: ["legal-cases"],
    queryFn: () => coreApi.getLegalCases(),
    enabled: pendingApprovalMenu,
  });
  const { data: grievancesData, isError: grievancesErrored } = useQuery({
    queryKey: ["grievances-all"],
    queryFn: () => coreApi.getGrievances(),
    enabled: pendingApprovalMenu,
  });
  const { data: leavePendingData, isError: leavePendingErrored } = useQuery({
    queryKey: ["leave-pending-count"],
    queryFn: () => coreApi.getPendingLeaveCount(),
    enabled: pendingApprovalMenu,
  });
  const { data: recentHistoryData, isError: recentHistoryErrored } = useQuery({
    queryKey: ["copilot-recent-history"],
    queryFn: () => coreApi.getRecentChatMessages(6),
    enabled: pendingApprovalMenu,
  });

  const dismissGreeting = () => {
    setHasGreeted(true);
    if (typeof window !== "undefined") {
      const currentLogin = sessionStorage.getItem("awip.heera.loginSessionId");
      if (currentLogin) sessionStorage.setItem(GREETED_KEY, currentLogin);
    }
  };

  const openFromGreeting = () => {
    dismissGreeting();
    setAssistantOpen(true);
    setPendingApprovalMenu(true);
    setApprovalMenuTimedOut(false);
    setMsgs([{ role: "ai", text: `${t("assistant.greeting")}\n${t("assistant.loadingApprovals")}` }]);
  };

  // Safety net: if the approval-count endpoints hang or the backend blips
  // (this app's core server has, in practice, occasionally dropped requests),
  // don't leave the user staring at "checking…" forever — fall back to a
  // menu without counts after a few seconds.
  useEffect(() => {
    if (!pendingApprovalMenu) return;
    const timer = setTimeout(() => setApprovalMenuTimedOut(true), 4000);
    return () => clearTimeout(timer);
  }, [pendingApprovalMenu]);

  useEffect(() => {
    if (!pendingApprovalMenu) return;
    const taskReady = taskAlertsData !== undefined || taskAlertsErrored;
    const legalReady = legalCasesData !== undefined || legalCasesErrored;
    const grievanceReady = grievancesData !== undefined || grievancesErrored;
    const leaveReady = leavePendingData !== undefined || leavePendingErrored;
    const historyReady = recentHistoryData !== undefined || recentHistoryErrored;
    if (!(taskReady && legalReady && grievanceReady && leaveReady && historyReady) && !approvalMenuTimedOut) return;

    const taskCount = taskAlertsData ? (taskAlertsData.data ?? []).length : null;
    const legalCount = legalCasesData ? (legalCasesData.data ?? []).filter((c: any) => c.status === "Pending" || c.status === "Hearing Scheduled").length : null;
    const grievanceCount = grievancesData ? (grievancesData.data ?? []).filter((g: any) => g.status !== "Resolved").length : null;
    const leaveCount = leavePendingData ? leavePendingData.count : null;

    const quickActions: QuickAction[] = [
      { label: taskCount !== null ? `Tasks (${taskCount})` : "Tasks", kind: "navigate", payload: "/tasks" },
      { label: leaveCount !== null ? `Leave Approvals (${leaveCount})` : "Leave Approvals", kind: "navigate", payload: "/leave" },
      { label: legalCount !== null ? `Legal Cases (${legalCount})` : "Legal Cases", kind: "navigate", payload: "/legal" },
      { label: grievanceCount !== null ? `Grievances (${grievanceCount})` : "Grievances", kind: "navigate", payload: "/grievances" },
      { label: "Recruitment Pipeline", kind: "navigate", payload: "/recruitment" },
    ];

    // If the last time this user chatted with Heera they ended up on a
    // redirect (e.g. "Open Legal Cases"), greet with that topic instead of
    // the generic "what needs approval" prompt.
    const lastRedirected = [...(recentHistoryData?.data ?? [])].reverse().find((m) => m.role === "ai" && m.redirectLabel);
    const greetingText = lastRedirected
      ? `${t("assistant.greeting")}\nWelcome back — last time we looked at the ${lastRedirected.redirectLabel} queue.`
      : `${t("assistant.greeting")}\n${t("assistant.askApprove")}`;

    setMsgs([{ role: "ai", text: greetingText, quickActions }]);
    setPendingApprovalMenu(false);
  }, [
    pendingApprovalMenu, approvalMenuTimedOut,
    taskAlertsData, legalCasesData, grievancesData, leavePendingData, recentHistoryData,
    taskAlertsErrored, legalCasesErrored, grievancesErrored, leavePendingErrored, recentHistoryErrored,
  ]);

  useEffect(() => {
    if (pendingApprovalMenu || showGreetingBubble) return;
    // Only seed the very first message — once a real conversation has
    // started, navigating between pages must NOT wipe it. The header
    // subtitle already shows the live page/department context, so an
    // established conversation doesn't need a new announcement bubble either.
    setMsgs((prev) => (prev.length > 0 ? prev : [
      { role: "ai", text: `Context: ${ctx.name} · ${department}. Suggested: "${ctx.hint}"` },
    ]));
  }, [ctx.name, department, pendingApprovalMenu, showGreetingBubble]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);

  // Additive bridge: any other page (e.g. Task Management's "Discuss with
  // Heera" button) can call seedAssistantMessage(text) to drop a message
  // into this panel — it opens/un-minimizes and appends without touching
  // the greeting/history/quick-action logic above.
  useEffect(() => onAssistantSeedMessage((text) => {
    setMinimized(false);
    setMsgs((m) => [...m, { role: "ai", text }]);
  }), []);

  // "Guided Help" actions elsewhere in the app (e.g. an AI Agent's detail
  // overlay) call askAssistant() to open Heera with a prompt already queued
  // — auto-send it once, then clear so it doesn't resend on re-render. Must
  // stay above the pathname-based early return below (Rules of Hooks) —
  // `send` is defined further down but this closure isn't invoked until
  // after the full render pass completes, so it's already initialized by
  // the time this callback actually runs.
  useEffect(() => {
    if (!pendingAssistantPrompt) return;
    send(pendingAssistantPrompt);
    clearPendingAssistantPrompt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAssistantPrompt]);

  if (pathname === "/login") return null;

  const send = async (text: string) => {
    const v = text.trim();
    if (!v || isSending) return;
    setMsgs((m) => [...m, { role: "user", text: v }]);
    coreApi.postChatMessage({ role: "user", text: v }).catch(() => {});
    setInput("");
    setIsSending(true);
    // Placeholder that streamed text is appended into as it arrives — real
    // token-by-token rendering, not a full wait followed by a fake replay.
    setMsgs((m) => [...m, { role: "ai", text: "", streaming: true }]);
    try {
      const recentContext = [...msgs, ...(recentHistoryData?.data ?? [])]
        .filter((m) => m.role === "ai" && "text" in m && m.text)
        .slice(-3)
        .map((m) => m.text.slice(0, 120))
        .join("; ") || undefined;
      const { response, employeeId, reportType, redirect, quickActions } = await aiApi.chat(
        `[Context: ${ctx.name} · Department: ${department}] ${v}`,
        recentContext,
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
      coreApi.postChatMessage({ role: "ai", text: response, redirectPath: redirect?.path, redirectLabel: redirect?.label }).catch(() => {});
      if (minimized) setHasUnread(true);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "AWIP Copilot is unavailable right now — is server-ai running with Ollama?";
      setMsgs((m) => {
        const next = [...m];
        next[next.length - 1] = { role: "ai", text: message, failed: true, retryText: v };
        return next;
      });
      if (minimized) setHasUnread(true);
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

  // Drives the footer suggestion row: the most recent AI turn's own
  // quickActions (and the user question right before it, for report
  // context), not the whole history — a stale set from three turns ago would
  // read as the assistant ignoring what was just asked.
  const lastAiIdx = [...msgs].map((_, i) => i).reverse().find((i) => msgs[i].role === "ai" && !msgs[i].streaming);
  const lastAiMsg = lastAiIdx !== undefined ? msgs[lastAiIdx] : undefined;
  const lastAiQuickActions = lastAiMsg?.quickActions?.length ? lastAiMsg.quickActions : null;
  const lastAiUserQuestion = lastAiIdx !== undefined && msgs[lastAiIdx - 1]?.role === "user" ? msgs[lastAiIdx - 1].text : undefined;

  if (!assistantOpen) {
    return (
      <>
        {showGreetingBubble && (
          <div className="fixed bottom-[104px] right-5 z-40 w-64 bg-card rounded-2xl shadow-[0_8px_30px_rgba(0,93,94,0.18)] p-3 animate-scale-in">
            <button
              onClick={dismissGreeting}
              className="absolute -top-2 -right-2 size-6 rounded-full bg-card shadow-[0_2px_8px_rgba(0,0,0,0.12)] grid place-items-center text-muted-foreground hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="size-3.5" />
            </button>
            <button onClick={openFromGreeting} className="text-left w-full">
              <p className="text-xs leading-relaxed whitespace-pre-line text-foreground">{t("assistant.greeting")}</p>
              <p className="text-xs font-medium text-primary mt-2">{t("assistant.exploreCta")}</p>
            </button>
            {/* Speech-bubble tail pointing down at the launcher icon */}
            <div className="absolute -bottom-1.5 right-8 size-3 bg-card rotate-45" />
          </div>
        )}
        <button
          onClick={showGreetingBubble ? openFromGreeting : () => setAssistantOpen(true)}
          className={cn(
            "fixed bottom-5 right-5 z-40 size-16 rounded-full bg-white shadow-[0_4px_24px_rgba(0,93,94,0.25)] grid place-items-center hover:scale-105 transition-transform animate-fade-in overflow-hidden",
            showGreetingBubble && "animate-heera-float",
          )}
          aria-label="Open Heera, your AWIP assistant"
        >
          <img src={import.meta.env.BASE_URL + "heera-chatbot.jpg"} alt="Heera" className="size-full object-cover object-top" />
        </button>
      </>
    );
  }

  return (
    <div
      className={cn(
        "fixed right-5 z-40 w-[380px] bg-card rounded-2xl shadow-[0_8px_30px_rgba(0,93,94,0.16)] flex flex-col animate-scale-in",
        minimized ? "bottom-5 h-12" : "bottom-5 h-[560px] max-h-[80vh]",
      )}
    >
      <div className="h-12 px-3 flex items-center gap-2 shrink-0">
        <div className="relative size-8 rounded-full bg-white shrink-0 overflow-hidden shadow-[0_2px_8px_rgba(0,0,0,0.08)]">
          <img src={import.meta.env.BASE_URL + "heera-chatbot.jpg"} alt="Heera" className="size-full object-cover object-top" />
          {hasUnread && minimized && (
            <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-destructive ring-2 ring-card" />
          )}
        </div>
        <div className="leading-tight flex-1 min-w-0">
          <div className="text-xs font-semibold truncate">{t("assistant.title")}</div>
          <div className="text-[10px] text-muted-foreground truncate">{ctx.name} · {department}</div>
        </div>
        <button
          onClick={() => setMinimized((v) => { const next = !v; if (!next) setHasUnread(false); return next; })}
          className="size-7 grid place-items-center rounded-lg hover:bg-surface-muted"
          aria-label={minimized ? "Restore" : "Minimize"}
        >
          <Minus className="size-3.5" />
        </button>
        <button onClick={() => setAssistantOpen(false)} className="size-7 grid place-items-center rounded-lg hover:bg-surface-muted" aria-label="Close">
          <X className="size-3.5" />
        </button>
      </div>

      {!minimized && (
        <>
          <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2">
            {msgs.map((m, i) => (
              <div
                key={i}
                className={cn(
                  "text-xs leading-relaxed rounded-xl p-2.5 max-w-[90%] whitespace-pre-line",
                  m.role === "user"
                    ? "ml-auto bg-primary text-primary-foreground"
                    : "bg-surface-muted text-foreground",
                )}
              >
                {m.role === "ai" ? <AiMessageBody text={m.text} streaming={m.streaming} /> : m.text}
                {m.role === "ai" && m.failed && m.retryText && (
                  <div className="mt-1.5">
                    <button
                      onClick={() => send(m.retryText!)}
                      disabled={isSending}
                      className="text-primary hover:underline disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      <RefreshCw className="size-3" /> Retry
                    </button>
                  </div>
                )}
                {m.role === "ai" && m.reportType && (m.reportType !== "service_record" || m.employeeId) && (
                  <div className="mt-1.5">
                    <button
                      onClick={() => downloadReport(m.reportType!, m.employeeId, { question: msgs[i - 1]?.role === "user" ? msgs[i - 1].text : "", answer: m.text })}
                      disabled={downloadingReport === m.reportType}
                      className="text-primary hover:underline disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      <FileBarChart className="size-3" />
                      {downloadingReport === m.reportType ? "Preparing…" : REPORT_LABEL[m.reportType]}
                    </button>
                  </div>
                )}
                {m.role === "ai" && m.redirect && (
                  <div className="mt-1.5">
                    <button onClick={() => navigate({ to: m.redirect!.path })} className="text-primary hover:underline inline-flex items-center gap-1">
                      Open {m.redirect.label} <ArrowUpRight className="size-3" />
                    </button>
                  </div>
                )}
              </div>
            ))}
            {isSending && (
              <div className="flex items-center gap-2 max-w-[90%]">
                <div className="size-5 rounded-full bg-white shrink-0 overflow-hidden shadow-[0_1px_4px_rgba(0,0,0,0.1)]">
                  <img src={import.meta.env.BASE_URL + "heera-chatbot.jpg"} alt="" className="size-full object-cover object-top" />
                </div>
                <div className="text-xs leading-relaxed rounded-xl p-2.5 bg-surface-muted text-muted-foreground inline-flex items-center gap-2">
                  <Loader2 className="size-3.5 animate-spin" /> Thinking…
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>
          {/* Suggestion chips — reflect the last reply's actual follow-ups
              (server-ai classify_followup, keyed off what the user asked, not
              the model's own prose) whenever there is one, so the row always
              tracks where the conversation actually is instead of showing the
              same 3 generic prompts all the way through. Falls back to a
              generic starter set only before the first real exchange. */}
          <div className="px-3 pb-2 flex flex-wrap gap-1.5">
            {(lastAiQuickActions ?? DEFAULT_SUGGESTIONS).map((qa) => (
              <button
                key={qa.label}
                onClick={() => {
                  if (isSending) return;
                  if (qa.kind === "navigate") navigate({ to: qa.payload });
                  else if (qa.kind === "report" && lastAiMsg) {
                    downloadReport(qa.payload as ReportType, lastAiMsg.employeeId, {
                      question: lastAiUserQuestion ?? "",
                      answer: lastAiMsg.text,
                    });
                  } else send(qa.payload);
                }}
                disabled={isSending}
                className="text-[11px] px-2.5 py-1.5 rounded-full bg-surface-muted border border-border hover:bg-accent disabled:opacity-50 transition-colors"
              >
                {qa.label}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => { e.preventDefault(); send(input); }}
            className="p-2 flex gap-1.5"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t("assistant.placeholder")}
              disabled={isSending}
              className="flex-1 h-9 px-3 rounded-lg bg-surface-muted text-xs focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-50"
            />
            {speech.isSupported && (
              <button
                type="button"
                onClick={() => (speech.isListening ? speech.stop() : speech.start())}
                disabled={isSending}
                title={speech.isListening ? "Stop voice input" : "Speak your question"}
                className={cn(
                  "size-9 grid place-items-center rounded-lg disabled:opacity-50",
                  speech.isListening ? "bg-destructive/10 text-destructive animate-pulse" : "bg-surface-muted hover:bg-accent",
                )}
              >
                {speech.isListening ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
              </button>
            )}
            <button type="submit" disabled={isSending} className="h-9 px-3 rounded-lg bg-primary text-primary-foreground inline-flex items-center gap-1 text-xs disabled:opacity-50">
              <Send className="size-3.5" />
            </button>
          </form>
        </>
      )}
    </div>
  );
}
