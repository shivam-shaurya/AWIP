import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Theme = "light" | "dark";
export type Lang = "en" | "gu";

export type SettingsState = {
  emailAlerts: boolean;
  criticalIncidentPush: boolean;
  payrollAnomalyAlerts: boolean;
  leaveEscalations: boolean;
  cadreReviewDigest: "Daily" | "Weekly" | "Monthly";

  tableDensity: "compact" | "standard";
  currencyDisplay: "Crores" | "Millions" | "Exact";
  dateFormat: "DD/MM/YYYY" | "YYYY-MM-DD" | "MMM DD, YYYY";

  twoFactorAuth: boolean;
  auditLoggingLevel: "Verbose" | "Standard" | "Minimal";
  sessionTimeout: "15m" | "30m" | "60m";

  hrmsSyncFreq: "Real-time" | "15m" | "Hourly";
  biometricSync: boolean;
};

const DEFAULT_SETTINGS: SettingsState = {
  emailAlerts: true,
  criticalIncidentPush: true,
  payrollAnomalyAlerts: true,
  leaveEscalations: true,
  cadreReviewDigest: "Weekly",

  tableDensity: "standard",
  currencyDisplay: "Crores",
  dateFormat: "DD/MM/YYYY",

  twoFactorAuth: true,
  auditLoggingLevel: "Verbose",
  sessionTimeout: "30m",

  hrmsSyncFreq: "Real-time",
  biometricSync: true,
};

type Ctx = {
  theme: Theme;
  toggleTheme: () => void;
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string) => string;
  settings: SettingsState;
  updateSettings: (partial: Partial<SettingsState>) => void;
  resetSettings: () => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  mobileNavOpen: boolean;
  setMobileNavOpen: (v: boolean) => void;
  assistantOpen: boolean;
  setAssistantOpen: (v: boolean) => void;
  // Opens Heera and queues a prompt to auto-send — used by "Guided Help"
  // actions (e.g. an AI Agent's overlay) so the chat conversation opens
  // pre-loaded with context instead of a blank input.
  pendingAssistantPrompt: string | null;
  askAssistant: (prompt: string) => void;
  clearPendingAssistantPrompt: () => void;
};

const UIContext = createContext<Ctx | null>(null);

const DICT: Record<string, { en: string; gu: string }> = {
  "nav.dashboard": { en: "Dashboard", gu: "ડેશબોર્ડ" },
  "nav.employees": { en: "Employee 360", gu: "કર્મચારી 360" },
  "nav.tasks": { en: "Task Management", gu: "કાર્ય વ્યવસ્થાપન" },
  "nav.analytics": { en: "Analytics", gu: "વિશ્લેષણ" },
  "nav.reports": { en: "Reports", gu: "અહેવાલો" },
  "nav.audit": { en: "Audit Logs", gu: "ઓડિટ લોગ" },
  "nav.settings": { en: "Settings", gu: "સેટિંગ્સ" },
  "common.search": { en: "Search employees, orders, cases, documents…", gu: "કર્મચારી, હુકમ, કેસ, દસ્તાવેજ શોધો…" },
  "common.signout": { en: "Sign out", gu: "બહાર નીકળો" },
  "common.askAwip": { en: "Ask AWIP", gu: "AWIP ને પૂછો" },
  "assistant.title": { en: "Heera · AWIP Assistant", gu: "હીરા · AWIP સહાયક" },
  "assistant.placeholder": { en: "Ask about this page…", gu: "આ પૃષ્ઠ વિશે પૂછો…" },
  "assistant.greeting": { en: "Namaste! 🙏 I'm Heera, your AWIP assistant.", gu: "નમસ્તે! 🙏 હું હીરા છું, તમારો AWIP સહાયક." },
  "assistant.askApprove": { en: "What would you like to approve today?", gu: "આજે તમારે શું મંજૂર કરવાનું છે?" },
  "assistant.loadingApprovals": { en: "One moment — checking what's waiting for your approval…", gu: "એક ક્ષણ — તમારી મંજૂરી માટે શું બાકી છે તે તપાસી રહ્યા છીએ…" },
  "assistant.exploreCta": { en: "Want to explore AWIP? Tap me to get started →", gu: "AWIP અન્વેષણ કરવું છે? શરૂ કરવા મને ટેપ કરો →" },
};

export function UIProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "light";
    return (localStorage.getItem("awip-theme") as Theme) || "light";
  });
  const [lang, setLangState] = useState<Lang>(() => {
    if (typeof window === "undefined") return "en";
    return (localStorage.getItem("awip-lang") as Lang) || "en";
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("awip-sb") === "1";
  });
  const [settings, setSettingsState] = useState<SettingsState>(() => {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    try {
      const saved = localStorage.getItem("awip-settings");
      return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [pendingAssistantPrompt, setPendingAssistantPrompt] = useState<string | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    localStorage.setItem("awip-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("awip-lang", lang);
  }, [lang]);

  useEffect(() => {
    localStorage.setItem("awip-sb", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem("awip-settings", JSON.stringify(settings));
    const root = document.documentElement;
    if (settings.tableDensity === "compact") {
      root.classList.add("compact-mode");
    } else {
      root.classList.remove("compact-mode");
    }
  }, [settings]);

  const updateSettings = (partial: Partial<SettingsState>) => {
    setSettingsState((prev) => ({ ...prev, ...partial }));
  };

  const resetSettings = () => {
    setSettingsState(DEFAULT_SETTINGS);
  };

  const t = (key: string) => DICT[key]?.[lang] ?? key;

  return (
    <UIContext.Provider
      value={{
        theme,
        toggleTheme: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
        lang,
        setLang: setLangState,
        t,
        settings,
        updateSettings,
        resetSettings,
        sidebarCollapsed,
        toggleSidebar: () => setSidebarCollapsed((v) => !v),
        mobileNavOpen,
        setMobileNavOpen,
        assistantOpen,
        setAssistantOpen,
        pendingAssistantPrompt,
        askAssistant: (prompt) => { setAssistantOpen(true); setPendingAssistantPrompt(prompt); },
        clearPendingAssistantPrompt: () => setPendingAssistantPrompt(null),
      }}
    >
      {children}
    </UIContext.Provider>
  );
}

export function useUI() {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error("useUI must be used within UIProvider");
  return ctx;
}
