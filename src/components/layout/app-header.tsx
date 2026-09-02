import { useState, useMemo, useEffect, useRef } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  Bell,
  ChevronDown,
  Check,
  Building2,
  LogOut,
  Moon,
  Sun,
  Globe,
  AlertTriangle,
  AlertCircle,
  Info,
  ArrowRight,
  CalendarDays,
  FileText,
  ListChecks,
  Users as UsersIcon,
  Menu,
} from "lucide-react";
import { DEPARTMENTS, type Department } from "@/lib/departments";
import { useDepartment } from "@/context/department-context";
import { useAuth } from "@/context/auth-context";
import { useUI } from "@/context/ui-context";
import { coreApi } from "@/lib/api-client";
import { cn, timeAgo } from "@/lib/utils";

type Notification = { id: string; title: string; desc: string; time: string; type: "error" | "warning" | "info"; to: string };

const SEEN_NOTIFICATIONS_KEY = "awip.notifications.seenIds";
function loadSeenIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN_NOTIFICATIONS_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

const SUGGESTIONS = [
  { title: "Command Centre Dashboard", category: "Navigation", path: "/" },
  { title: "Workforce Analytics & Governance", category: "Navigation", path: "/analytics" },
  { title: "Employee Directory & Service Books", category: "Navigation", path: "/employees" },
  { title: "Budget, Payroll & Finance", category: "Navigation", path: "/finance" },
  { title: "Document Vault", category: "Navigation", path: "/ocr-scanner" },
  { title: "Task Force Allocation & SLA Control", category: "Navigation", path: "/tasks" },
  { title: "Legal Case & Statutory Compliance", category: "Navigation", path: "/legal" },
  { title: "Recruitment & Candidate Pipeline", category: "Navigation", path: "/recruitment" },
  { title: "Onboarding & New Hire Checklist", category: "Navigation", path: "/onboarding" },
  { title: "Workforce Briefs & Reports Generator", category: "Navigation", path: "/reports" },
  { title: "AI Copilot & Assistant Console", category: "Navigation", path: "/copilot" },
  { title: "Portal Settings & Configuration", category: "Navigation", path: "/settings" },
];

export function AppHeader() {
  const { department, setDepartment } = useDepartment();
  const { user, signOut } = useAuth();
  const { theme, toggleTheme, lang, setLang, t, setMobileNavOpen } = useUI();
  const navigate = useNavigate();
  
  const [openDept, setOpenDept] = useState(false);
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showNotifications, setShowNotifications] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showLangMenu, setShowLangMenu] = useState(false);
  
  const searchContainerRef = useRef<HTMLDivElement>(null);

  // Close search dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setShowSearchDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const { data: emergencyAlertsData } = useQuery({ queryKey: ["emergency-alerts"], queryFn: () => coreApi.getEmergencyAlerts() });
  const { data: grievancesData } = useQuery({ queryKey: ["grievances-all"], queryFn: () => coreApi.getGrievances() });
  const { data: legalCasesData } = useQuery({ queryKey: ["legal-cases"], queryFn: () => coreApi.getLegalCases() });
  const { data: taskAlertsData } = useQuery({ queryKey: ["task-alerts"], queryFn: () => coreApi.getTaskAlerts() });
  const { data: pendingLeaveData } = useQuery({ queryKey: ["leave-pending-count-global"], queryFn: () => coreApi.getPendingLeaveCount() });

  const notifications: Notification[] = useMemo(() => {
    const items: Notification[] = [];

    const openEmergencies = (emergencyAlertsData?.data ?? [])
      .filter((a: any) => a.status === "Open" || a.status === "Escalated")
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 3);
    for (const a of openEmergencies) {
      items.push({
        id: `emg-${a.id}`,
        title: a.title || a.category,
        desc: `${a.category} · ${a.department} · ${a.status}`,
        time: timeAgo(a.createdAt),
        type: a.severity === "Critical" ? "error" : "warning",
        to: "/",
      });
    }

    const criticalGrievances = (grievancesData?.data ?? [])
      .filter((g: any) => g.severity === "Critical" && g.status !== "Resolved")
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 2);
    for (const g of criticalGrievances) {
      items.push({
        id: `grv-${g.id}`,
        title: `Critical grievance — ${g.department}`,
        desc: g.subject,
        time: timeAgo(g.createdAt),
        type: "error",
        to: "/grievances",
      });
    }

    const in30Days = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const upcomingHearings = (legalCasesData?.data ?? [])
      .filter((c: any) => c.status === "Hearing Scheduled" && c.nextHearing && new Date(c.nextHearing).getTime() <= in30Days)
      .sort((a: any, b: any) => new Date(a.nextHearing).getTime() - new Date(b.nextHearing).getTime())
      .slice(0, 2);
    for (const c of upcomingHearings) {
      items.push({
        id: `lgl-${c.id}`,
        title: `Hearing scheduled — ${c.department}`,
        desc: `${c.title} · ${c.court}`,
        time: `Hearing on ${new Date(c.nextHearing).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}`,
        type: "warning",
        to: "/legal",
      });
    }

    for (const t of (taskAlertsData?.data ?? []).slice(0, 2)) {
      items.push({
        id: `tsk-${t.type}-${t.title}`,
        title: t.title,
        desc: t.detail,
        time: "Live",
        type: t.severity === "High" ? "error" : "warning",
        to: "/tasks",
      });
    }

    if (pendingLeaveData?.count) {
      items.push({
        id: "leave-pending",
        title: `${pendingLeaveData.count} leave requests pending approval`,
        desc: pendingLeaveData.latest ? `Latest: ${pendingLeaveData.latest.employeeName} · ${pendingLeaveData.latest.leaveType}` : "Awaiting review",
        time: "Live",
        type: "info",
        to: "/leave",
      });
    }

    return items;
  }, [emergencyAlertsData, grievancesData, legalCasesData, taskAlertsData, pendingLeaveData]);

  const [seenIds, setSeenIds] = useState<Set<string>>(() => loadSeenIds());
  const markSeen = (ids: string[]) => {
    setSeenIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      sessionStorage.setItem(SEEN_NOTIFICATIONS_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const initials = user?.initials ?? "RP";
  const name = user?.name ?? "R. Pandya, IAS";
  const role = user?.role ?? "Commissioner";

  const unreadCount = notifications.filter((n) => !seenIds.has(n.id)).length;

  const filteredSuggestions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return SUGGESTIONS.slice(0, 4);
    }
    const scored = SUGGESTIONS.map((item) => {
      const title = item.title.toLowerCase();
      let score = 0;
      if (title === query) score = 100;
      else if (title.startsWith(query)) score = 80;
      else if (title.split(/\W+/).some((word) => word.startsWith(query))) score = 60;
      else if (title.includes(query)) score = 40;
      else if (item.category.toLowerCase().includes(query)) score = 10;
      return { item, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.item);
  }, [searchQuery]);

  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 200);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const { data: searchResults, isFetching: searchFetching } = useQuery({
    queryKey: ["global-search", debouncedSearch],
    queryFn: () => coreApi.globalSearch(debouncedSearch),
    enabled: debouncedSearch.length >= 2,
  });
  const employeeResults = debouncedSearch.length >= 2 ? (searchResults?.employees ?? []) : [];
  const taskResults = debouncedSearch.length >= 2 ? (searchResults?.tasks ?? []) : [];
  const documentResults = debouncedSearch.length >= 2 ? (searchResults?.documents ?? []) : [];
  const totalRealResults = employeeResults.length + taskResults.length + documentResults.length;

  const goToSuggestion = (item: { path: string }) => {
    navigate({ to: item.path });
    setSearchQuery("");
    setShowSearchDropdown(false);
  };
  const goToEmployeeResult = (id: string) => {
    navigate({ to: "/employees/$id", params: { id } });
    setSearchQuery("");
    setShowSearchDropdown(false);
  };
  const goToTaskResult = (title: string) => {
    navigate({ to: "/tasks", search: { q: title } });
    setSearchQuery("");
    setShowSearchDropdown(false);
  };

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000 * 30);
    return () => clearInterval(id);
  }, []);
  const dateLabel = now.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
  const timeLabel = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

  return (
    <header className="h-14 shrink-0 bg-surface flex items-center gap-2 px-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <button
        onClick={() => setMobileNavOpen(true)}
        className="lg:hidden size-9 shrink-0 grid place-items-center rounded-full hover:bg-surface-muted transition-colors"
        aria-label="Open navigation menu"
      >
        <Menu className="size-5" />
      </button>
      <Link to="/" className="flex items-center gap-2 lg:hidden">
        <div className="size-7 rounded-lg bg-surface-muted grid place-items-center">
          <Building2 className="size-4 text-primary" />
        </div>
        <span className="text-sm font-semibold">AWIP</span>
      </Link>

      {/* Global Search with Suggestions */}
      <div
        ref={searchContainerRef}
        className="flex-1 relative"
        onFocus={() => setShowSearchDropdown(true)}
      >
        <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          className="w-full h-10 pl-9 pr-4 rounded-full bg-card border border-border text-sm focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-primary/40"
          placeholder={t("common.search")}
          value={searchQuery}
          onFocus={() => setShowSearchDropdown(true)}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            if (!showSearchDropdown) setShowSearchDropdown(true);
          }}
          onKeyDown={(e) => {
            const totalMatches = filteredSuggestions.length + totalRealResults;
            if (e.key === "Enter" && totalMatches === 1) {
              if (filteredSuggestions.length === 1) goToSuggestion(filteredSuggestions[0]);
              else if (employeeResults.length === 1) goToEmployeeResult(employeeResults[0].id);
              else if (taskResults.length === 1) goToTaskResult(taskResults[0].title);
              else if (documentResults.length === 1) goToEmployeeResult(documentResults[0].employeeId);
            } else if (e.key === "Escape") {
              setSearchQuery("");
              setShowSearchDropdown(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold text-muted-foreground hover:text-foreground bg-card px-1.5 py-0.5 rounded shadow-[0_2px_6px_rgba(15,23,42,0.06)] cursor-pointer"
          >
            Clear
          </button>
        )}

        <AnimatePresence>
        {showSearchDropdown && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute left-0 right-0 top-full pt-1 z-50"
          >
            <div className="rounded-xl bg-popover border border-border shadow-xl max-h-[70vh] flex flex-col p-1.5 overflow-hidden">
              
              {/* Top Search Query Banner */}
              <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border flex items-center justify-between shrink-0">
                <span>{searchQuery ? `SEARCH RESULTS FOR "${searchQuery.toUpperCase()}"` : "QUICK NAVIGATION LINKS"}</span>
                {totalRealResults > 0 && (
                  <span className="text-[9px] font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                    {totalRealResults} Total Matches
                  </span>
                )}
              </div>

              {/* Scrollable Results Container */}
              <div className="overflow-y-auto max-h-[60vh] space-y-1 pr-1 pt-1.5 scrollbar-thin">
                
                {/* Suggestions / Navigation */}
                {filteredSuggestions.length > 0 && (
                  <div>
                    {searchQuery && <div className="px-3 py-1 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/70">Pages</div>}
                    {filteredSuggestions.map((item) => (
                      <button
                        key={item.path}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          goToSuggestion(item);
                        }}
                        className="w-full flex items-center justify-between px-3 py-2 text-xs text-left rounded-lg hover:bg-accent text-foreground hover:text-accent-foreground transition-colors cursor-pointer"
                      >
                        <div>
                          <div className="font-semibold">{item.title}</div>
                          <div className="text-[9px] text-muted-foreground mt-0.5">{item.category}</div>
                        </div>
                        <ArrowRight className="size-3 text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                )}

                {/* Employee Results */}
                {debouncedSearch.length >= 2 && employeeResults.length > 0 && (
                  <div>
                    <div className="px-3 py-1 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/80 mt-2 flex items-center justify-between border-t border-border/50 pt-2">
                      <span>Employees</span>
                      <span className="text-[9px] font-semibold text-muted-foreground">{employeeResults.length} records</span>
                    </div>
                    {employeeResults.map((e) => (
                      <button
                        key={e.id}
                        onMouseDown={(ev) => { ev.preventDefault(); goToEmployeeResult(e.id); }}
                        className="w-full flex items-center justify-between px-3 py-2 text-xs text-left rounded-lg hover:bg-accent text-foreground hover:text-accent-foreground transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="size-7 rounded-full bg-primary/10 grid place-items-center text-primary shrink-0">
                            <UsersIcon className="size-3.5" />
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold truncate">{e.name}</div>
                            <div className="text-[9px] text-muted-foreground mt-0.5 truncate">{e.designation} · {e.department}</div>
                          </div>
                        </div>
                        <ArrowRight className="size-3 text-muted-foreground shrink-0" />
                      </button>
                    ))}
                  </div>
                )}

                {/* Task Results */}
                {debouncedSearch.length >= 2 && taskResults.length > 0 && (
                  <div>
                    <div className="px-3 py-1 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/80 mt-2 flex items-center justify-between border-t border-border/50 pt-2">
                      <span>Tasks</span>
                      <span className="text-[9px] font-semibold text-muted-foreground">{taskResults.length} tasks</span>
                    </div>
                    {taskResults.map((tsk) => (
                      <button
                        key={tsk.id}
                        onMouseDown={(ev) => { ev.preventDefault(); goToTaskResult(tsk.title); }}
                        className="w-full flex items-center justify-between px-3 py-2 text-xs text-left rounded-lg hover:bg-accent text-foreground hover:text-accent-foreground transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="size-7 rounded-full bg-warning/10 grid place-items-center text-warning-foreground shrink-0">
                            <ListChecks className="size-3.5" />
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold truncate">{tsk.title}</div>
                            <div className="text-[9px] text-muted-foreground mt-0.5 truncate">{tsk.project} · {tsk.department}</div>
                          </div>
                        </div>
                        <ArrowRight className="size-3 text-muted-foreground shrink-0" />
                      </button>
                    ))}
                  </div>
                )}

                {/* Document Results */}
                {debouncedSearch.length >= 2 && documentResults.length > 0 && (
                  <div>
                    <div className="px-3 py-1 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/80 mt-2 flex items-center justify-between border-t border-border/50 pt-2">
                      <span>Documents</span>
                      <span className="text-[9px] font-semibold text-muted-foreground">{documentResults.length} docs</span>
                    </div>
                    {documentResults.map((d) => (
                      <button
                        key={d.id}
                        onMouseDown={(ev) => { ev.preventDefault(); goToEmployeeResult(d.employeeId); }}
                        className="w-full flex items-center justify-between px-3 py-2 text-xs text-left rounded-lg hover:bg-accent text-foreground hover:text-accent-foreground transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="size-7 rounded-full bg-info/10 grid place-items-center text-info-foreground shrink-0">
                            <FileText className="size-3.5" />
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold truncate">{d.type}</div>
                            <div className="text-[9px] text-muted-foreground mt-0.5 truncate">{d.employeeName}{d.description ? ` · ${d.description}` : ""}</div>
                          </div>
                        </div>
                        <ArrowRight className="size-3 text-muted-foreground shrink-0" />
                      </button>
                    ))}
                  </div>
                )}

                {debouncedSearch.length >= 2 && searchFetching && totalRealResults === 0 && (
                  <div className="p-4 text-xs text-muted-foreground text-center">Searching municipal records…</div>
                )}

                {searchQuery && !searchFetching && filteredSuggestions.length === 0 && totalRealResults === 0 && (
                  <div className="p-4 text-xs text-muted-foreground text-center">No matching records found for "{searchQuery}"</div>
                )}
              </div>

              {/* Scrollable Indicator Footer */}
              {totalRealResults > 5 && (
                <div className="px-3 py-1.5 text-[9px] font-medium text-muted-foreground bg-surface-muted/40 border-t border-border text-center shrink-0 rounded-b-lg">
                  Scroll dropdown to view all {totalRealResults} results
                </div>
              )}
            </div>
          </motion.div>
        )}
        </AnimatePresence>
      </div>

      {/* HR Calendar shortcut with live date/time */}
      <Link
        to="/calendar"
        className="hidden sm:inline-flex items-center gap-2 h-10 px-3.5 rounded-full border border-border bg-card hover:bg-surface-muted transition-colors group"
        title="Open HR Calendar"
      >
        <CalendarDays className="size-4 text-primary" />
        <div className="leading-tight text-left">
          <div className="text-[11px] font-semibold text-foreground tabular-nums">{dateLabel}</div>
          <div className="text-[9px] text-muted-foreground tabular-nums">{timeLabel}</div>
        </div>
      </Link>

      {/* Department scope selector */}
      <div className="relative" onMouseEnter={() => setOpenDept(true)} onMouseLeave={() => setOpenDept(false)}>
        <button
          onClick={() => setOpenDept((v) => !v)}
          className="h-10 pl-4 pr-3 inline-flex items-center gap-2 rounded-full border border-border bg-card text-sm font-medium text-foreground/80 hover:bg-surface-muted transition-colors"
        >
          <span className="max-w-[160px] truncate">{department}</span>
          <ChevronDown className={cn("size-3.5 transition-transform", openDept && "rotate-180")} />
        </button>
        <AnimatePresence>
        {openDept && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute right-0 top-full pt-1 z-50 w-72"
          >
            <div className="rounded-xl bg-popover border border-border shadow-md max-h-96 overflow-y-auto scrollbar-thin">
              <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground bg-surface-muted rounded-t-xl">
                Filter scope · {DEPARTMENTS.length} departments
              </div>
              {DEPARTMENTS.map((d) => {
                const active = d === department;
                return (
                  <button
                    key={d}
                    onClick={() => { setDepartment(d as Department); setOpenDept(false); }}
                    className={cn(
                      "w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-left hover:bg-accent",
                      active && "bg-accent text-accent-foreground font-medium",
                    )}
                  >
                    <span className="truncate">{d}</span>
                    {active && <Check className="size-4 text-primary" />}
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
        </AnimatePresence>
      </div>

      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        className="size-10 grid place-items-center rounded-full border border-border bg-card hover:bg-surface-muted transition-colors"
        aria-label="Toggle theme"
        title={theme === "dark" ? "Switch to light" : "Switch to dark"}
      >
        {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </button>

      {/* Notifications Dropdown — real cross-module signals (emergency
          alerts, critical grievances, upcoming hearings, task/SLA alerts,
          pending leave approvals), not a hardcoded list. */}
      <div className="relative" onMouseLeave={() => setShowNotifications(false)}>
        <button
          onClick={() => setShowNotifications(v => !v)}
          className="size-10 grid place-items-center rounded-full border border-border bg-card hover:bg-surface-muted transition-colors relative"
          aria-label="Notifications"
          title="Administrative Alert Centre"
        >
          <Bell className="size-4 text-foreground/70" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold grid place-items-center tabular-nums">
              {unreadCount}
            </span>
          )}
        </button>
        <AnimatePresence>
        {showNotifications && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute right-0 top-full pt-1 z-50 w-80"
          >
            <div className="rounded-xl bg-popover border border-border shadow-md max-h-96 overflow-y-auto scrollbar-thin p-1">
              <div className="flex items-center justify-between px-3 py-2 bg-surface-muted/40 rounded-t-xl">
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Alerts & Notifications</span>
                {unreadCount > 0 && (
                  <button
                    onClick={() => markSeen(notifications.map((n) => n.id))}
                    className="text-[9px] text-primary hover:underline font-semibold"
                  >
                    Mark all read
                  </button>
                )}
              </div>
              {notifications.length === 0 ? (
                <div className="p-4 text-xs text-muted-foreground text-center">No active alerts right now.</div>
              ) : (
                <div>
                  {notifications.map((n) => {
                    const unread = !seenIds.has(n.id);
                    return (
                      <button
                        key={n.id}
                        onClick={() => {
                          markSeen([n.id]);
                          setShowNotifications(false);
                          navigate({ to: n.to });
                        }}
                        className={cn(
                          "w-full p-3 rounded-lg text-left transition-colors cursor-pointer hover:bg-accent/40",
                          unread && "bg-primary-soft/10",
                        )}
                      >
                        <div className="flex items-start gap-2.5">
                          <div className="mt-0.5 shrink-0">
                            {n.type === "error" && <AlertCircle className="size-3.5 text-destructive" />}
                            {n.type === "warning" && <AlertTriangle className="size-3.5 text-warning-foreground" />}
                            {n.type === "info" && <Info className="size-3.5 text-info" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className={cn("text-xs leading-tight text-foreground", unread ? "font-bold" : "font-medium")}>
                              {n.title}
                            </div>
                            <p className="text-[10px] text-muted-foreground mt-1 leading-snug">{n.desc}</p>
                            <span className="text-[8px] text-muted-foreground mt-1.5 block font-semibold">{n.time}</span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
        )}
        </AnimatePresence>
      </div>

      {/* Language switch */}
      <div className="relative hidden md:block" onMouseLeave={() => setShowLangMenu(false)}>
        <button
          onClick={() => setShowLangMenu((v) => !v)}
          className="h-10 pl-3.5 pr-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-card text-sm font-medium text-foreground/80 hover:bg-surface-muted transition-colors"
        >
          <Globe className="size-3.5" /> {lang === "en" ? "ENG" : "ગુજ"}
          <ChevronDown className={cn("size-3.5 transition-transform", showLangMenu && "rotate-180")} />
        </button>
        <AnimatePresence>
        {showLangMenu && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute right-0 top-full pt-1 z-50 w-36"
          >
            <div className="rounded-xl bg-popover border border-border shadow-md py-1">
              <button
                onClick={() => { setLang("en"); setShowLangMenu(false); }}
                className={cn("w-full flex items-center justify-between px-3.5 py-1.5 text-sm text-left hover:bg-surface-muted", lang === "en" && "text-primary font-semibold")}
              >
                English {lang === "en" && <Check className="size-3.5" />}
              </button>
              <button
                onClick={() => { setLang("gu"); setShowLangMenu(false); }}
                className={cn("w-full flex items-center justify-between px-3.5 py-1.5 text-sm text-left hover:bg-surface-muted", lang === "gu" && "text-primary font-semibold")}
              >
                ગુજરાતી {lang === "gu" && <Check className="size-3.5" />}
              </button>
            </div>
          </motion.div>
        )}
        </AnimatePresence>
      </div>

      {/* User profile dropdown and signout */}
      <div className="relative pl-1" onMouseLeave={() => setShowProfileMenu(false)}>
        <button
          onClick={() => setShowProfileMenu((v) => !v)}
          className="flex items-center gap-2 h-10 pl-1.5 pr-2.5 rounded-full border border-border bg-card hover:bg-surface-muted transition-colors"
        >
          <div className="size-7 rounded-full bg-primary/10 text-primary text-xs font-semibold grid place-items-center shrink-0">{initials}</div>
          <div className="hidden md:block leading-tight text-left">
            <div className="text-xs font-medium">{role}</div>
            <div className="text-[11px] text-muted-foreground">{name}</div>
          </div>
          <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", showProfileMenu && "rotate-180")} />
        </button>
        <AnimatePresence>
        {showProfileMenu && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute right-0 top-full pt-1 z-50 w-56"
          >
            <div className="rounded-xl bg-popover border border-border shadow-md py-1">
              <div className="px-3.5 py-2 border-b border-border">
                <div className="text-sm font-medium">{name}</div>
                <div className="text-xs text-muted-foreground">{role}</div>
              </div>
              <button
                onClick={() => { signOut(); navigate({ to: "/login" }); }}
                className="w-full flex items-center gap-2 px-3.5 py-2 text-sm text-left hover:bg-surface-muted text-destructive"
              >
                <LogOut className="size-4" /> {t("common.signout")}
              </button>
            </div>
          </motion.div>
        )}
        </AnimatePresence>
      </div>
    </header>
  );
}
