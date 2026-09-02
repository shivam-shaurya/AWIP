export type QuickAction = { label: string; kind: "prompt" | "navigate" | "report"; payload: string };

export type ReportType = "service_record" | "department_digest" | "risk_summary";

export type Msg = {
  role: "user" | "ai";
  text: string;
  employeeId?: string;
  reportType?: ReportType | null;
  redirect?: { path: string; label: string } | null;
  quickActions?: QuickAction[];
  // True while tokens are still arriving from the streaming chat endpoint —
  // lets the bubble show a live "typing" cursor.
  streaming?: boolean;
  // Set on the error bubble when a send() failed, alongside the original
  // text so a Retry button can resend it without the user retyping.
  failed?: boolean;
  retryText?: string;
};
