import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Panel, Pill, Section } from "@/components/layout/section";
import { useUI } from "@/context/ui-context";
import { useAuth } from "@/context/auth-context";
import {
  Settings as SettingsIcon,
  Sun,
  Moon,
  Globe,
  Bell,
  Shield,
  Key,
  Sliders,
  CheckCircle2,
  Lock,
  Smartphone,
  Server,
  Zap,
  RotateCcw,
  Check,
  Building2,
  Database,
  Radio,
  FileCheck
} from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "System Settings & Governance Preferences · AWIP" }] }),
  component: SettingsPage,
});

type SettingsTab = "general" | "notifications" | "security" | "integrations";

function SettingsPage() {
  const { theme, toggleTheme, lang, setLang, settings, updateSettings, resetSettings } = useUI();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");

  const handleUpdate = (partial: Parameters<typeof updateSettings>[0], sectionName: string) => {
    updateSettings(partial);
    toast.success(`${sectionName} preferences updated and saved`);
  };

  return (
    <div className="p-5 max-w-[1600px] mx-auto flex flex-col gap-6 animate-in fade-in duration-500 w-full">
      
      {/* Page Header */}
      <div className="w-full flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2 text-foreground">
            <SettingsIcon className="size-6 text-primary" />
            System Settings & Preferences
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Configure administrative preferences, notification triggers, security controls, and system integrations.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { resetSettings(); toast.info("Settings reset to system defaults"); }}
            className="h-8.5 px-3 rounded-full border border-border bg-card text-xs font-semibold hover:bg-surface-muted transition-colors flex items-center gap-1.5 cursor-pointer text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="size-3.5" /> Reset Defaults
          </button>
          <Pill tone="primary">Session Active · {user?.role ?? "Commissioner"}</Pill>
        </div>
      </div>

      {/* Settings Navigation Tabs */}
      <div className="flex bg-surface-muted/30 p-1 rounded-full border border-border w-fit flex-wrap">
        <button
          onClick={() => setActiveTab("general")}
          className={cn(
            "px-4 py-2 text-xs font-semibold rounded-full transition-all flex items-center gap-2 cursor-pointer",
            activeTab === "general"
              ? "bg-card text-foreground shadow-sm border border-border"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Sliders className="size-3.5 text-primary" />
          Appearance & Display
        </button>

        <button
          onClick={() => setActiveTab("notifications")}
          className={cn(
            "px-4 py-2 text-xs font-semibold rounded-full transition-all flex items-center gap-2 cursor-pointer",
            activeTab === "notifications"
              ? "bg-card text-foreground shadow-sm border border-border"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Bell className="size-3.5 text-warning-foreground" />
          Notifications & Triggers
        </button>

        <button
          onClick={() => setActiveTab("security")}
          className={cn(
            "px-4 py-2 text-xs font-semibold rounded-full transition-all flex items-center gap-2 cursor-pointer",
            activeTab === "security"
              ? "bg-card text-foreground shadow-sm border border-border"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Shield className="size-3.5 text-destructive" />
          Security & Access
        </button>

        <button
          onClick={() => setActiveTab("integrations")}
          className={cn(
            "px-4 py-2 text-xs font-semibold rounded-full transition-all flex items-center gap-2 cursor-pointer",
            activeTab === "integrations"
              ? "bg-card text-foreground shadow-sm border border-border"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Server className="size-3.5 text-success" />
          Connectors & APIs
        </button>
      </div>

      {/* TAB 1: APPEARANCE & DISPLAY */}
      {activeTab === "general" && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
          
          <Section title="Theme & Color Mode" subtitle="Switch between dark and light enterprise canvases">
            <Panel className="p-5 border border-border shadow-sm rounded-xl space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-foreground">Canvas Color Mode</div>
                  <div className="text-xs text-muted-foreground">Currently active: <span className="capitalize font-semibold text-primary">{theme} Mode</span></div>
                </div>
                <div className="flex items-center gap-2 bg-surface-muted p-1 rounded-full border border-border">
                  <button
                    onClick={() => { if (theme !== "light") { toggleTheme(); toast.success("Switched to Light Canvas Mode"); } }}
                    className={cn(
                      "px-3.5 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer",
                      theme === "light" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Sun className="size-3.5 text-warning-foreground" /> Light Mode
                  </button>
                  <button
                    onClick={() => { if (theme !== "dark") { toggleTheme(); toast.success("Switched to Dark Canvas Mode"); } }}
                    className={cn(
                      "px-3.5 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer",
                      theme === "dark" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Moon className="size-3.5 text-primary" /> Dark Mode
                  </button>
                </div>
              </div>
            </Panel>
          </Section>

          <Section title="Localization & Regional Formats" subtitle="Language preferences and numerical notation rules">
            <Panel className="p-5 border border-border shadow-sm rounded-xl space-y-5">
              
              <div className="flex items-center justify-between pb-4 border-b border-border">
                <div>
                  <div className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <Globe className="size-4 text-primary" /> Interface Language
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">Select preferred language for operational headers and data labels</div>
                </div>
                <div className="flex rounded-full border border-border overflow-hidden text-xs font-semibold">
                  <button
                    onClick={() => { setLang("en"); toast.success("Interface Language set to English"); }}
                    className={cn("px-4 py-2 transition-colors cursor-pointer", lang === "en" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-surface-muted")}
                  >
                    English
                  </button>
                  <button
                    onClick={() => { setLang("gu"); toast.success("ઇન્ટરફેસ ભાષા ગુજરાતી સેટ કરી"); }}
                    className={cn("px-4 py-2 transition-colors cursor-pointer", lang === "gu" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-surface-muted")}
                  >
                    ગુજરાતી
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-1">
                <div>
                  <label className="text-xs font-semibold text-foreground mb-1.5 block">Financial Currency Denomination</label>
                  <select
                    value={settings.currencyDisplay}
                    onChange={(e) => handleUpdate({ currencyDisplay: e.target.value as any }, "Currency Format")}
                    className="w-full h-9 px-3 rounded-xl bg-card border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                  >
                    <option value="Crores">₹ Crore / Lakhs (Indian Standard)</option>
                    <option value="Millions">₹ Millions (International Standard)</option>
                    <option value="Exact">Full Numeric (₹ 1,00,00,000)</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-foreground mb-1.5 block">Date & Time Format</label>
                  <select
                    value={settings.dateFormat}
                    onChange={(e) => handleUpdate({ dateFormat: e.target.value as any }, "Date Format")}
                    className="w-full h-9 px-3 rounded-xl bg-card border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                  >
                    <option value="DD/MM/YYYY">DD/MM/YYYY (e.g. 28/07/2026 IST)</option>
                    <option value="YYYY-MM-DD">YYYY-MM-DD (ISO Format)</option>
                    <option value="MMM DD, YYYY">MMM DD, YYYY (e.g. Jul 28, 2026)</option>
                  </select>
                </div>
              </div>

            </Panel>
          </Section>

          <Section title="Data Density & Layout" subtitle="Adjust table padding and grid layout density">
            <Panel className="p-5 border border-border shadow-sm rounded-xl">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-foreground">Grid & Table View Density</div>
                  <div className="text-xs text-muted-foreground">Compact mode displays 25% more rows on high-resolution screens</div>
                </div>
                <div className="flex bg-surface-muted p-1 rounded-full border border-border">
                  <button
                    onClick={() => handleUpdate({ tableDensity: "standard" }, "Standard Table Density")}
                    className={cn(
                      "px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all cursor-pointer",
                      settings.tableDensity === "standard" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    Standard
                  </button>
                  <button
                    onClick={() => handleUpdate({ tableDensity: "compact" }, "Compact Table Density")}
                    className={cn(
                      "px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all cursor-pointer",
                      settings.tableDensity === "compact" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    Compact
                  </button>
                </div>
              </div>
            </Panel>
          </Section>

        </div>
      )}

      {/* TAB 2: NOTIFICATIONS & TRIGGERS */}
      {activeTab === "notifications" && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
          
          <Section title="Real-Time Triggers & Alert Triggers" subtitle="Configure automated notifications for critical municipal events">
            <Panel className="p-5 border border-border shadow-sm rounded-xl space-y-5">
              
              {/* Trigger 1 */}
              <div className="flex items-center justify-between pb-4 border-b border-border">
                <div>
                  <div className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <Shield className="size-4 text-destructive" /> Critical Incident & Disciplinary Alerts
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">Send instant push alert when a critical grievance or vigilance flag is filed</div>
                </div>
                <button
                  onClick={() => handleUpdate({ criticalIncidentPush: !settings.criticalIncidentPush }, "Critical Incident Alerts")}
                  className={cn(
                    "w-12 h-6 rounded-full transition-colors p-0.5 relative cursor-pointer",
                    settings.criticalIncidentPush ? "bg-primary" : "bg-muted"
                  )}
                >
                  <div className={cn("size-5 rounded-full bg-white transition-transform shadow-sm", settings.criticalIncidentPush ? "translate-x-6" : "translate-x-0")} />
                </button>
              </div>

              {/* Trigger 2 */}
              <div className="flex items-center justify-between pb-4 border-b border-border">
                <div>
                  <div className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <Zap className="size-4 text-warning-foreground" /> Expense & Payroll Anomaly Auditor Triggers
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">Flag vendor payment anomalies or claim duplicates exceeding ₹50,000</div>
                </div>
                <button
                  onClick={() => handleUpdate({ payrollAnomalyAlerts: !settings.payrollAnomalyAlerts }, "Payroll Anomaly Alerts")}
                  className={cn(
                    "w-12 h-6 rounded-full transition-colors p-0.5 relative cursor-pointer",
                    settings.payrollAnomalyAlerts ? "bg-primary" : "bg-muted"
                  )}
                >
                  <div className={cn("size-5 rounded-full bg-white transition-transform shadow-sm", settings.payrollAnomalyAlerts ? "translate-x-6" : "translate-x-0")} />
                </button>
              </div>

              {/* Trigger 3 */}
              <div className="flex items-center justify-between pb-4 border-b border-border">
                <div>
                  <div className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <Bell className="size-4 text-primary" /> Leave & Attendance Escalations
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">Auto-escalate pending leave requests unreviewed for over 3 business days</div>
                </div>
                <button
                  onClick={() => handleUpdate({ leaveEscalations: !settings.leaveEscalations }, "Leave Escalations")}
                  className={cn(
                    "w-12 h-6 rounded-full transition-colors p-0.5 relative cursor-pointer",
                    settings.leaveEscalations ? "bg-primary" : "bg-muted"
                  )}
                >
                  <div className={cn("size-5 rounded-full bg-white transition-transform shadow-sm", settings.leaveEscalations ? "translate-x-6" : "translate-x-0")} />
                </button>
              </div>

              {/* Digest Preference */}
              <div className="flex items-center justify-between pt-1">
                <div>
                  <div className="text-sm font-semibold text-foreground">Cadre Review & Promotion Digest</div>
                  <div className="text-xs text-muted-foreground">Frequency of automated executive promotion readiness digests</div>
                </div>
                <select
                  value={settings.cadreReviewDigest}
                  onChange={(e) => handleUpdate({ cadreReviewDigest: e.target.value as any }, "Cadre Review Digest Frequency")}
                  className="h-9 px-3 rounded-xl bg-card border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                >
                  <option value="Daily">Daily Summary</option>
                  <option value="Weekly">Weekly Digest (Mondays)</option>
                  <option value="Monthly">Monthly Cadre Brief</option>
                </select>
              </div>

            </Panel>
          </Section>

        </div>
      )}

      {/* TAB 3: SECURITY & ACCESS */}
      {activeTab === "security" && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
          
          <Section title="Authentication & Single Sign-On (SSO)" subtitle="Aadhaar OTP and State Govt SSO credentials">
            <Panel className="p-5 border border-border shadow-sm rounded-xl space-y-5">
              
              <div className="flex items-center justify-between pb-4 border-b border-border">
                <div>
                  <div className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <Smartphone className="size-4 text-success" /> Two-Factor Authentication (Aadhaar OTP)
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 font-medium">Verified for Municipal Commissioner & HR Head Accounts</div>
                </div>
                <button
                  onClick={() => handleUpdate({ twoFactorAuth: !settings.twoFactorAuth }, "2FA Enforce Mode")}
                  className={cn(
                    "w-12 h-6 rounded-full transition-colors p-0.5 relative cursor-pointer",
                    settings.twoFactorAuth ? "bg-primary" : "bg-muted"
                  )}
                >
                  <div className={cn("size-5 rounded-full bg-white transition-transform shadow-sm", settings.twoFactorAuth ? "translate-x-6" : "translate-x-0")} />
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-1">
                <div>
                  <label className="text-xs font-semibold text-foreground mb-1.5 block">Session Inactivity Timeout</label>
                  <select
                    value={settings.sessionTimeout}
                    onChange={(e) => handleUpdate({ sessionTimeout: e.target.value as any }, "Session Timeout")}
                    className="w-full h-9 px-3 rounded-xl bg-card border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                  >
                    <option value="15m">15 Minutes</option>
                    <option value="30m">30 Minutes (Recommended)</option>
                    <option value="60m">60 Minutes</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-foreground mb-1.5 block">Audit Logging Level</label>
                  <select
                    value={settings.auditLoggingLevel}
                    onChange={(e) => handleUpdate({ auditLoggingLevel: e.target.value as any }, "Audit Logging Level")}
                    className="w-full h-9 px-3 rounded-xl bg-card border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                  >
                    <option value="Verbose">Verbose (Log all reads, edits, exports)</option>
                    <option value="Standard">Standard (Log edits & sensitive exports)</option>
                    <option value="Minimal">Minimal (Log security failures only)</option>
                  </select>
                </div>
              </div>

            </Panel>
          </Section>

          <Section title="Active Session Credentials" subtitle="Current logged-in commissioner identity">
            <Panel className="p-5 border border-border shadow-sm rounded-xl">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="size-10 rounded-full bg-primary/10 grid place-items-center text-primary font-bold text-sm">
                    {user?.name?.slice(0, 2).toUpperCase() ?? "MC"}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-foreground">{user?.name ?? "Municipal Commissioner"}</div>
                    <div className="text-xs text-muted-foreground">Role: {user?.role ?? "Commissioner"} · AMC Portal ID: #AMC-2026-8941</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs font-medium text-success flex items-center justify-end gap-1">
                    <CheckCircle2 className="size-3.5" /> Authenticated via GSWAN
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">IP: 10.240.18.42 (AMC HQ Network)</div>
                </div>
              </div>
            </Panel>
          </Section>

        </div>
      )}

      {/* TAB 4: CONNECTORS & APIS */}
      {activeTab === "integrations" && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
          
          <Section title="State HRMS & Treasury Connectors" subtitle="Live integrations with Gujarat State Government portals">
            <Panel className="p-5 border border-border shadow-sm rounded-xl space-y-4">
              
              <div className="flex items-center justify-between pb-3 border-b border-border">
                <div className="flex items-center gap-3">
                  <div className="size-9 rounded-full bg-primary/10 grid place-items-center text-primary">
                    <Building2 className="size-4.5" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-foreground">Gujarat State HRMS Portal (iORA / IFMS)</div>
                    <div className="text-xs text-muted-foreground">Bi-directional sync for service books, cadre lists, and pension dockets</div>
                  </div>
                </div>
                <Pill tone="success">Connected · Active</Pill>
              </div>

              <div className="flex items-center justify-between pb-3 border-b border-border">
                <div className="flex items-center gap-3">
                  <div className="size-9 rounded-full bg-success/10 grid place-items-center text-success">
                    <Radio className="size-4.5" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-foreground">Ward Biometric Attendance Network</div>
                    <div className="text-xs text-muted-foreground">42 Municipal Ward Terminals & Zonal Office Check-ins</div>
                  </div>
                </div>
                <button
                  onClick={() => handleUpdate({ biometricSync: !settings.biometricSync }, "Biometric Network Sync")}
                  className={cn(
                    "px-3 py-1 rounded-full text-xs font-semibold transition-colors cursor-pointer border border-border",
                    settings.biometricSync ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
                  )}
                >
                  {settings.biometricSync ? "Online (42/42 Wards)" : "Offline (Paused)"}
                </button>
              </div>

              <div className="flex items-center justify-between pt-1">
                <div>
                  <div className="text-sm font-semibold text-foreground">State HRMS Sync Frequency</div>
                  <div className="text-xs text-muted-foreground">Interval for background reconciliation with State Treasury</div>
                </div>
                <select
                  value={settings.hrmsSyncFreq}
                  onChange={(e) => handleUpdate({ hrmsSyncFreq: e.target.value as any }, "HRMS Sync Frequency")}
                  className="h-9 px-3 rounded-xl bg-card border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                >
                  <option value="Real-time">Real-time Webhook</option>
                  <option value="15m">Every 15 Minutes</option>
                  <option value="Hourly">Hourly Batch</option>
                </select>
              </div>

            </Panel>
          </Section>

        </div>
      )}

    </div>
  );
}

export default SettingsPage;
