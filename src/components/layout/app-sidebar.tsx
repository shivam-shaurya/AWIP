import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  LayoutDashboard,
  IdCard,
  ListChecks,
  LineChart,
  FileText,
  Settings as SettingsIcon,
  Building2,
  PanelLeftClose,
  PanelLeftOpen,
  ScanText,
  UserPlus,
  ClipboardCheck,
  Wallet,
  Scale,
  MessageSquareWarning,
  CalendarDays,
  CalendarClock,
  Clock,
  Receipt,
  Percent,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useUI } from "@/context/ui-context";
import { useAuth, type Role } from "@/context/auth-context";

type NavGroup = "Operations" | "Intelligence" | "System" | "Self Service";
type NavItem = { to: string; labelEn: string; labelGu: string; icon: typeof LayoutDashboard; end?: boolean; roles: Role[]; group?: NavGroup };

const ADMIN_ROLES: Role[] = ["HR Admin", "Department Head"];

// Groups mirror the Figma nav structure: an unlabeled top section for the
// primary 360-degree views, then labeled OPERATIONS / INTELLIGENCE / SYSTEM
// sections. Self-service (employee-only) items get their own group since the
// design doesn't cover that role.
const NAV: NavItem[] = [
  { to: "/", labelEn: "Command Centre", labelGu: "કમાન્ડ સેન્ટર", icon: LayoutDashboard, end: true, roles: ADMIN_ROLES },
  { to: "/employees", labelEn: "Employee 360", labelGu: "કર્મચારી 360", icon: IdCard, roles: ADMIN_ROLES },
  { to: "/org360", labelEn: "Organization 360", labelGu: "સંસ્થા 360", icon: Building2, roles: ADMIN_ROLES },
  { to: "/recruitment", labelEn: "Recruitment", labelGu: "ભરતી", icon: UserPlus, roles: ADMIN_ROLES },
  { to: "/onboarding", labelEn: "Onboarding", labelGu: "ઓનબોર્ડિંગ", icon: ClipboardCheck, roles: ADMIN_ROLES },

  { to: "/tasks", labelEn: "Task Management", labelGu: "કાર્ય વ્યવસ્થાપન", icon: ListChecks, roles: ADMIN_ROLES, group: "Operations" },
  { to: "/leave", labelEn: "Leave Management", labelGu: "રજા વ્યવસ્થાપન", icon: CalendarClock, roles: ADMIN_ROLES, group: "Operations" },
  { to: "/finance", labelEn: "Finance", labelGu: "નાણાં", icon: Wallet, roles: ADMIN_ROLES, group: "Operations" },
  { to: "/legal", labelEn: "Legal & Compliance", labelGu: "કાનૂની અને અનુપાલન", icon: Scale, roles: ADMIN_ROLES, group: "Operations" },
  { to: "/grievances", labelEn: "Grievances", labelGu: "ફરિયાદો", icon: MessageSquareWarning, roles: ADMIN_ROLES, group: "Operations" },

  { to: "/privacy", labelEn: "Data Rights Center", labelGu: "ડેટા અધિકાર કેન્દ્ર", icon: ShieldCheck, roles: ADMIN_ROLES, group: "Intelligence" },
  { to: "/ocr-scanner", labelEn: "Document Vault", labelGu: "દસ્તાવેજ વૉલ્ટ", icon: ScanText, roles: ADMIN_ROLES, group: "Intelligence" },
  { to: "/analytics", labelEn: "Analytics", labelGu: "વિશ્લેષણ", icon: LineChart, roles: ADMIN_ROLES, group: "Intelligence" },
  { to: "/reports", labelEn: "Reports", labelGu: "અહેવાલો", icon: FileText, roles: ADMIN_ROLES, group: "Intelligence" },

  { to: "/settings", labelEn: "Settings", labelGu: "સેટિંગ્સ", icon: SettingsIcon, roles: ADMIN_ROLES, group: "System" },
  // Shared /calendar with admins — grouped under System for admins, but
  // rendered ungrouped for employees (see the Employee-only block below).
  { to: "/calendar", labelEn: "Calendar", labelGu: "કેલેન્ડર", icon: CalendarDays, roles: ADMIN_ROLES, group: "System" },

  // Employee self-service — scoped to /my/*, plus the admin-shared /calendar.
  { to: "/calendar", labelEn: "Calendar", labelGu: "કેલેન્ડર", icon: CalendarDays, roles: ["Employee"], group: "Self Service" },
  { to: "/my/attendance", labelEn: "Attendance", labelGu: "હાજરી", icon: Clock, roles: ["Employee"], group: "Self Service" },
  { to: "/my/leave", labelEn: "Leave", labelGu: "રજા", icon: CalendarClock, roles: ["Employee"], group: "Self Service" },
  { to: "/my/grievances", labelEn: "Grievances", labelGu: "ફરિયાદો", icon: MessageSquareWarning, roles: ["Employee"], group: "Self Service" },
  { to: "/my/privacy-requests", labelEn: "My Data & Privacy", labelGu: "મારો ડેટા અને ગોપનીયતા", icon: ShieldCheck, roles: ["Employee"], group: "Self Service" },
  { to: "/my/payslip", labelEn: "Payslip", labelGu: "પગાર સ્લિપ", icon: Receipt, roles: ["Employee"], group: "Self Service" },
  { to: "/my/tax-regime", labelEn: "Tax Regime", labelGu: "કર વ્યવસ્થા", icon: Percent, roles: ["Employee"], group: "Self Service" },
  { to: "/my/tasks", labelEn: "My Tasks", labelGu: "મારા કાર્યો", icon: ListChecks, roles: ["Employee"], group: "Self Service" },
];

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { sidebarCollapsed, toggleSidebar, lang, mobileNavOpen, setMobileNavOpen } = useUI();
  const { user } = useAuth();
  const collapsed = sidebarCollapsed;
  const role = user?.role ?? "HR Admin";

  // "My 360" needs the logged-in employee's own id, so it's built here rather
  // than as a static NAV entry.
  const visibleNav = NAV.filter((item) => item.roles.includes(role));
  const my360: NavItem | null = role === "Employee" && user?.employeeId
    ? { to: `/employees/${user.employeeId}`, labelEn: "My 360", labelGu: "મારું 360", icon: IdCard, roles: ["Employee"] }
    : null;
  const items = my360 ? [my360, ...visibleNav] : visibleNav;
  // The mobile drawer is always full-width with labels — "collapsed" is a
  // desktop-rail concept and shouldn't also hide labels inside the overlay.
  const showCollapsed = collapsed && !mobileNavOpen;

  // Close the mobile drawer on navigation — otherwise the new page renders
  // underneath a still-open overlay instead of the drawer dismissing itself.
  useEffect(() => { setMobileNavOpen(false); }, [pathname, setMobileNavOpen]);

  return (
    <>
      {/* Mobile backdrop — only present (and clickable-to-close) below lg */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] lg:hidden transition-opacity duration-200",
          mobileNavOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
        onClick={() => setMobileNavOpen(false)}
        aria-hidden="true"
      />
      <aside
        className={cn(
          "flex shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[transform,width] duration-200",
          "fixed inset-y-0 left-0 z-50 w-60 lg:static lg:z-auto",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
          collapsed ? "lg:w-14" : "lg:w-60",
        )}
      >
      <div className={cn("flex items-center gap-2.5", showCollapsed ? "h-14 px-2 justify-center" : "min-h-[88px] px-3 py-3")}>
        <div className={cn("rounded-xl bg-white grid place-items-center shrink-0 p-1.5 shadow-[0_2px_10px_rgba(15,23,42,0.08)]", showCollapsed ? "size-9" : "size-12")}>
          <img src={import.meta.env.BASE_URL + "amc-logo.png"} alt="AMC seal" className="size-full object-contain" />
        </div>
        {!showCollapsed && (
          <div className="leading-tight min-w-0">
            <div className="font-sans text-[11px] font-semibold uppercase tracking-tight text-white leading-snug">Ahmedabad Municipal Corporation</div>
            <div className="text-[10px] font-medium text-sidebar-primary mt-0.5">અમદાવાદ મ્યુનિસિપલ કોર્પોરેશન</div>
            <div className="text-[9px] uppercase tracking-wider text-sidebar-foreground/50 mt-1">AWIP Workforce Platform</div>
          </div>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto p-2 space-y-0.5 scrollbar-thin">
        {items.map((item, i) => {
          const active = item.end ? pathname === item.to : pathname.startsWith(item.to);
          const Icon = item.icon;
          const label = lang === "gu" ? item.labelGu : item.labelEn;
          const prevGroup = i > 0 ? items[i - 1].group : undefined;
          const showGroupHeader = !showCollapsed && item.group && item.group !== prevGroup;
          return (
            <div key={item.to}>
              {showGroupHeader && (
                <div className="px-2.5 pt-3 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-sidebar-foreground/45">
                  {item.group}
                </div>
              )}
              <Link
                to={item.to}
                title={showCollapsed ? label : undefined}
                className={cn(
                  "group relative flex items-center gap-2.5 rounded-lg text-sm transition-all duration-200",
                  showCollapsed ? "justify-center px-2 py-2" : "px-2.5 py-2",
                  active
                    ? "bg-sidebar-primary/15 text-sidebar-primary font-medium"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                )}
              >
                <Icon className={cn("size-4 shrink-0", active ? "text-sidebar-primary" : "text-sidebar-foreground/60")} />
                {!showCollapsed && (
                  <span className="truncate flex-1">
                    {label}
                  </span>
                )}
                {showCollapsed && (
                  <span className="pointer-events-none absolute left-full ml-2 z-50 whitespace-nowrap rounded-lg bg-popover px-2 py-1 text-xs text-popover-foreground shadow-[0_4px_24px_rgba(0,93,94,0.12)] opacity-0 group-hover:opacity-100 transition-opacity">
                    {label}
                  </span>
                )}
              </Link>
            </div>
          );
        })}
      </nav>

      <button
        onClick={toggleSidebar}
        className={cn(
          "hidden lg:flex h-10 items-center gap-2 text-xs text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/60 transition-colors",
          collapsed ? "justify-center" : "px-3",
        )}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? <PanelLeftOpen className="size-4" /> : <><PanelLeftClose className="size-4" /> Collapse</>}
      </button>

      {!showCollapsed && (
        <div className="px-4 py-3 text-[11px] text-sidebar-foreground/40">
          <div>AWIP v1.0 · AMC</div>
        </div>
      )}
      </aside>
    </>
  );
}
