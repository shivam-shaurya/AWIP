import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Download, Users, ChevronRight, Loader2, Trophy } from "lucide-react";
import { Pill } from "@/components/layout/section";
import { Pager } from "@/components/ui/pager";
import { FilterPill } from "@/components/ui/filter-pill";
import { useDepartment } from "@/context/department-context";
import { DEPARTMENTS, type Department } from "@/lib/departments";
import { ZONES, type Zone } from "@/lib/zones";
import { coreApi } from "@/lib/api-client";
import { cn } from "@/lib/utils";

const CADRES = ["All Cadres", "Class I", "Class II", "Class III", "Class IV"];

type EmployeesSearch = {
  flag?: "promotionDue" | "retirementDue" | "appraisalPending" | "trainingPending" | "missingDocs";
  presentToday?: boolean;
  // Real computed-at-read-time filters (not stored columns) that the Command
  // Centre's Smart Alerts rows deep-link into — added so those alerts point
  // at the actual matching employees instead of the full unfiltered
  // directory, which read as misleading (e.g. "23 employees performance
  // declining" landing on all 10,000 employees with no filter applied).
  performanceDeclining?: boolean;
  regularisationMilestone?: "recent";
  retirementBlocked?: boolean;
  // Deep-link target for Org 360's cadre-chart drill-through — lets that
  // click pre-select a cadre in addition to the department (set separately
  // via the shared department context, not a URL param).
  cadre?: string;
  // Deep-link target for Org 360's Vacancies module drill-through. Unlike
  // cadre, designations are dynamic (department-specific, DB-driven) rather
  // than a fixed list, so this is just validated as a non-empty string.
  designation?: string;
};

export const Route = createFileRoute("/employees/")({
  head: () => ({ meta: [{ title: "Employee 360 · AWIP" }] }),
  validateSearch: (search: Record<string, unknown>): EmployeesSearch => ({
    flag: ["promotionDue", "retirementDue", "appraisalPending", "trainingPending", "missingDocs"].includes(search.flag as string)
      ? (search.flag as EmployeesSearch["flag"])
      : undefined,
    presentToday: typeof search.presentToday === "boolean" ? search.presentToday : undefined,
    performanceDeclining: search.performanceDeclining === true ? true : undefined,
    regularisationMilestone: search.regularisationMilestone === "recent" ? "recent" : undefined,
    retirementBlocked: search.retirementBlocked === true ? true : undefined,
    cadre: CADRES.includes(search.cadre as string) ? (search.cadre as string) : undefined,
    designation: typeof search.designation === "string" && search.designation.trim() ? search.designation : undefined,
  }),
  component: EmployeesPage,
});

const PAGE_SIZE = 50;

const FLAG_LABEL: Record<string, string> = {
  promotionDue: "Promotion Due",
  retirementDue: "Retirement Due",
  appraisalPending: "Appraisal Pending",
  trainingPending: "Training Pending",
  missingDocs: "Missing Documents",
};

function EmployeesPage() {
  const { department, setDepartment, zone, setZone } = useDepartment();
  const { flag, presentToday, performanceDeclining, regularisationMilestone, retirementBlocked, cadre: cadreParam, designation: designationParam } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [q, setQ] = useState("");
  const [cadre, setCadre] = useState(cadreParam ?? "All Cadres");
  // These three deep-linked filters are all computed against Active
  // employees only (see server-core/server.js) — defaulting status to match
  // means the count shown here agrees with the number promised in the Smart
  // Alerts row that linked here, instead of silently including non-Active
  // employees the alert never counted.
  const [status, setStatus] = useState(
    performanceDeclining || regularisationMilestone || retirementBlocked ? "Active" : "All Status",
  );
  const [designation, setDesignation] = useState(designationParam ?? "All Designations");
  const [highPotentialOnly, setHighPotentialOnly] = useState(false);
  const [attendanceToday, setAttendanceToday] = useState<"All Attendance" | "Present Today" | "Absent Today">(
    presentToday === false ? "Absent Today" : presentToday === true ? "Present Today" : "All Attendance",
  );
  const [page, setPage] = useState(1);

  // Debounce free-text search so it doesn't fire a network request on every
  // keystroke now that search runs server-side instead of over an
  // already-fetched full list.
  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Any filter change invalidates the current page — e.g. page 4 of an
  // unfiltered list may not exist at all once a narrowing filter is applied.
  useEffect(() => {
    setPage(1);
  }, [department, zone, cadre, designation, status, debouncedQ, flag, highPotentialOnly, attendanceToday, performanceDeclining, regularisationMilestone, retirementBlocked]);

  // Every filter except attendance-today maps to a real, indexable column, so
  // the server can do the filtering/pagination itself instead of shipping
  // the whole matching set to the browser. Attendance-today is a derived
  // per-request value (not a stored column) and `highPotential` is computed
  // from several relations at read time (not a stored column either) — the
  // server still accepts page/limit for it, but can't report an accurate
  // `total` while doing so, so both cases fetch the full matching set and
  // derive the count client-side — narrow, deliberate exceptions, not the
  // default path.
  const needsFullFetch = attendanceToday !== "All Attendance" || highPotentialOnly || performanceDeclining || !!regularisationMilestone || retirementBlocked;

  const { data, isLoading, isError } = useQuery({
    queryKey: ["employees", department, zone, status, cadre, designation, debouncedQ, flag, highPotentialOnly, performanceDeclining, regularisationMilestone, retirementBlocked, needsFullFetch, page],
    queryFn: () => coreApi.getEmployees({
      department, zone,
      status: status !== "All Status" ? status : undefined,
      cadre: cadre !== "All Cadres" ? cadre : undefined,
      designation: designation !== "All Designations" ? designation : undefined,
      q: debouncedQ.trim() || undefined,
      flag,
      highPotential: highPotentialOnly || undefined,
      performanceDeclining: performanceDeclining || undefined,
      regularisationMilestone,
      retirementBlocked: retirementBlocked || undefined,
      ...(needsFullFetch ? {} : { page, limit: PAGE_SIZE }),
    }),
  });
  const employees = data?.data ?? [];

  const { data: designationsResp } = useQuery({
    queryKey: ["employee-designations", department, zone],
    queryFn: () => coreApi.getEmployeeDesignations({ department, zone }),
  });
  const cadres = CADRES;
  const designations = useMemo(() => ["All Designations", ...(designationsResp?.data ?? [])], [designationsResp]);
  const statuses = ["All Status", "Active", "On Leave", "Deputation", "Suspended"];

  // Attendance-today is the one filter the server can't apply in its
  // where-clause (it's derived, not stored) — fall back to a client-side pass
  // over the (still department/zone/etc-narrowed, un-paginated) fetched set.
  // When `highPotentialOnly` is on, the server has already filtered by it
  // before returning `employees`, so no extra client-side pass is needed for
  // that one.
  const list = useMemo(() => {
    if (!needsFullFetch) return employees;
    if (attendanceToday === "Absent Today") return employees.filter((e: any) => e.presentToday === false);
    if (attendanceToday === "Present Today") return employees.filter((e: any) => e.presentToday === true);
    return employees;
  }, [employees, needsFullFetch, attendanceToday]);

  const totalCount = needsFullFetch ? list.length : (data?.total ?? list.length);
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // When the server already paginated (the common path), `list` is exactly
  // this page's rows. When we had to fetch the full matching set (attendance
  // filter / high-potential-only, both derived rather than stored columns),
  // slice out this page client-side instead.
  const visible = needsFullFetch ? list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : list;
  const rangeStart = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, totalCount);

  const { data: workforce } = useQuery({
    queryKey: ["workforce-summary", zone],
    queryFn: () => coreApi.getWorkforceSummary(zone),
  });
  const deptTotal = department === "All Departments"
    ? (workforce?.total ?? 0)
    : (workforce?.data.find((d: any) => d.fullName === department || d.dept === department)?.count ?? workforce?.total ?? 0);

  const hasFilters = q || cadre !== "All Cadres" || designation !== "All Designations" || status !== "All Status" || highPotentialOnly || attendanceToday !== "All Attendance";
  const clearAll = () => { setQ(""); setCadre("All Cadres"); setDesignation("All Designations"); setStatus("All Status"); setHighPotentialOnly(false); setAttendanceToday("All Attendance"); };

  return (
    <div className="min-h-full bg-background p-5 max-w-[1600px] mx-auto space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <Users className="size-5 text-primary" />
            Employee 360
          </h1>
          <p className="text-xs text-muted-foreground">
            {deptTotal.toLocaleString("en-IN")} employees · scope: {department}{zone !== "All Zones" ? ` · ${zone} Zone` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="h-9 px-3 inline-flex items-center gap-1.5 rounded-lg bg-surface-muted text-sm hover:bg-surface-muted/70 transition-colors">
            <Download className="size-4" /> Export
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="space-y-6">

        {(flag || presentToday === false || performanceDeclining || regularisationMilestone || retirementBlocked) && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-primary/10 border border-primary/20 text-xs text-primary font-medium">
            Filtered from Command Centre:{" "}
            <span className="font-semibold">
              {flag ? FLAG_LABEL[flag]
                : performanceDeclining ? "Performance Declining"
                : regularisationMilestone ? "Recently Crossed Regularisation Milestone"
                : retirementBlocked ? "Retiring Soon — Pension Paperwork Incomplete"
                : "Absent Today"}
            </span>
            <button
              onClick={() => { navigate({ search: {} }); setAttendanceToday("All Attendance"); }}
              className="ml-auto text-primary/70 hover:text-primary underline"
            >
              Clear filter
            </button>
          </div>
        )}

        {/* Filter bar */}
        <div className="bg-card rounded-xl p-4 border border-border space-y-3">
          {/* Search — its own row so it always keeps a readable width instead
              of being squeezed by the filter selects competing for space */}
          <div className="relative w-full sm:max-w-sm">
            <Search className="size-4 absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, ID, designation…"
              className="w-full h-10 pl-10 pr-4 rounded-full bg-card border border-border text-sm focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-primary/40"
            />
          </div>

          {/* Filter pills — free to wrap onto as many lines as needed */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setHighPotentialOnly((v) => !v)}
              className={cn(
                "h-10 px-4 rounded-full border text-sm font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0",
                highPotentialOnly ? "bg-success/15 text-success border-success/30" : "bg-card border-border text-foreground/80 hover:bg-surface-muted",
              )}
              title="Show only AI-flagged High Potential employees"
            >
              <Trophy className="size-3.5" /> High Potential
            </button>
            <FilterPill
              value={attendanceToday}
              onChange={(v) => setAttendanceToday(v as "All Attendance" | "Present Today" | "Absent Today")}
              options={["All Attendance", "Present Today", "Absent Today"]}
              label="Attendance"
            />
            <FilterPill value={status} onChange={setStatus} options={statuses} label="Status" />
            <FilterPill value={cadre} onChange={setCadre} options={cadres} label="Cadres" />
            <FilterPill value={zone} onChange={(v) => setZone(v as Zone)} options={ZONES as unknown as string[]} label="Zones" />
            <FilterPill value={department} onChange={(v) => setDepartment(v as Department)} options={DEPARTMENTS as unknown as string[]} label="Departments" />
            <FilterPill value={designation} onChange={setDesignation} options={designations} label="Designation" />
            {hasFilters && (
              <button
                onClick={clearAll}
                className="text-xs text-primary hover:underline whitespace-nowrap shrink-0 ml-1"
              >
                Clear all
              </button>
            )}
          </div>
        </div>

        {/* Employee count bar */}
        <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
          <span>
            Showing <span className="text-foreground font-medium tabular-nums">{rangeStart.toLocaleString("en-IN")}–{rangeEnd.toLocaleString("en-IN")}</span> of{" "}
            <span className="text-foreground font-medium tabular-nums">{totalCount.toLocaleString("en-IN")}</span> employees
          </span>
          {hasFilters && (
            <span className="text-primary font-medium">Filtered</span>
          )}
        </div>

        {/* Data table */}
        <div className="bg-card rounded-xl overflow-hidden border border-border">
          {isLoading ? (
            <div className="p-10 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading employees…
            </div>
          ) : isError ? (
            <div className="p-10 text-center text-sm text-destructive">
              Couldn't load employees. Is the AWIP core server running?
            </div>
          ) : list.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              No employees match the current filters. Try adjusting your search or filter criteria.
            </div>
          ) : (
            <>
              {/* Table header */}
              <div className="hidden md:grid grid-cols-[44px_minmax(0,1.5fr)_100px_minmax(0,1.2fr)_minmax(0,1fr)_110px_90px_100px_32px] gap-3 px-4 py-2.5 bg-sidebar text-[10px] uppercase tracking-wider text-sidebar-foreground font-semibold">
                <div></div>
                <div>Full Name</div>
                <div>Employee ID</div>
                <div>Designation</div>
                <div>Department</div>
                <div>Cadre</div>
                <div>Status</div>
                <div>Today</div>
                <div></div>
              </div>

              {/* Table rows */}
              <div>
                {visible.map((e, i) => {
                  const initials = e.name.split(" ").map((n: string) => n[0]).slice(0, 2).join("");
                  return (
                    <Link
                      key={e.id}
                      to="/employees/$id"
                      params={{ id: e.id }}
                      className={cn(
                        "group grid grid-cols-1 md:grid-cols-[44px_minmax(0,1.5fr)_100px_minmax(0,1.2fr)_minmax(0,1fr)_110px_90px_100px_32px] gap-3 px-4 py-3 items-center transition-colors cursor-pointer hover:bg-surface-muted",
                        i % 2 === 1 && "bg-surface-muted",
                      )}
                    >
                      {/* Avatar */}
                      <div className="size-9 rounded-full bg-gradient-to-br from-primary to-primary/60 text-primary-foreground text-xs font-semibold grid place-items-center shrink-0 ring-2 ring-primary/10">
                        {initials}
                      </div>

                      {/* Name (mobile has extra info) */}
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate group-hover:text-primary transition-colors flex items-center gap-1.5">
                          <span className="truncate">{e.name}</span>
                          {e.highPotential && (
                            <span title="High Potential" className="shrink-0 inline-flex">
                              <Trophy className="size-3.5 text-warning" />
                            </span>
                          )}
                        </div>
                        <div className="md:hidden text-[11px] text-muted-foreground truncate">
                          {e.designation} · {e.id}
                        </div>
                      </div>

                      {/* ID */}
                      <div className="hidden md:block text-xs text-muted-foreground tabular-nums">{e.id}</div>

                      {/* Designation */}
                      <div className="hidden md:block text-xs text-foreground/80 truncate">{e.designation}</div>

                      {/* Department */}
                      <div className="hidden md:block text-xs text-foreground/80 truncate">
                        {e.department}
                        {e.zone && <span className="text-muted-foreground"> · {e.zone}</span>}
                      </div>

                      {/* Cadre */}
                      <div className="hidden md:block text-xs text-muted-foreground">{e.cadre}</div>

                      {/* Status */}
                      <div className="hidden md:flex">
                        <StatusPill status={e.status} />
                      </div>

                      {/* Attendance today */}
                      <div className="hidden md:flex">
                        <AttendancePill presentToday={e.presentToday} />
                      </div>

                      {/* Arrow */}
                      <div className="hidden md:grid place-items-center">
                        <ChevronRight className="size-4 text-muted-foreground/40 group-hover:text-primary transition-colors" />
                      </div>

                      {/* Mobile status */}
                      <div className="md:hidden flex items-center gap-2 mt-1">
                        <StatusPill status={e.status} />
                        <AttendancePill presentToday={e.presentToday} />
                        <span className="text-[10px] text-muted-foreground">{e.cadre}{e.zone ? ` · ${e.zone}` : ""}</span>
                        {e.flags.promotionDue && <span className="text-[10px] text-warning-foreground">Promo due</span>}
                      </div>
                    </Link>
                  );
                })}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <Pager page={page} totalPages={totalPages} onChange={setPage} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone = status === "Active" ? "success" : status === "On Leave" ? "warning" : status === "Suspended" ? "destructive" : "neutral";
  return <Pill tone={tone}>{status}</Pill>;
}

function AttendancePill({ presentToday }: { presentToday?: boolean | null }) {
  if (presentToday == null) return null;
  return <Pill tone={presentToday ? "success" : "destructive"}>{presentToday ? "Present" : "Absent"}</Pill>;
}

