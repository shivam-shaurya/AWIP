"""schedule_mpxj.py - ONE production-grade schedule parser for P6 + MS Project.

Supersedes the three thin parsers (mpp_binary / msp_xml / p6_xer) with a single
MPXJ UniversalProjectReader engine that reads ALL of:
    .mpp        (MS Project binary, OLE2)
    .xer        (Primavera P6 native)
    P6 XML      (Primavera PMXML)         <- previously UNHANDLED in Python
    MSP XML     (Microsoft MSPDI)
into one object model, and ports the production logic from the C# reference
(NMDC.Services) that the old Python port was missing:

    * file-wide PERCENT-SCALE normalization  (0-1 vs 0-100; fixes "100 -> 1%")   [SchedulePercent]
    * file-wide BASELINE selection           (MSP's 11 baselines)                [ScheduleBaselineSelector]
    * XSS sanitization of free-text          (P6 TASKMEMO can carry HTML/iframe)
    * XXE-safety                             (MPXJ does not resolve external entities; native XML uses defusedxml)
    * calendar-aware durations               (MPXJ convertUnits respects the file's hours/day)
    * schedule-INTEGRITY checks              (dangling logic, count reconcile, unresolved rels, date sanity)

Everything ABOVE the "MPXJ ENGINE" banner is pure Python and laptop-testable
(see test_schedule_mpxj.py). Everything below needs the JVM + MPXJ (server).

NOTE: MPXJ method signatures vary across versions. This module follows the SAME
binding conventions as the existing mpp_binary.py (the `mpxj` package, `org.mpxj`
namespace, v13+). The baseline accessor `getBaselineStart(n)` and percent field
names should be confirmed against your installed MPXJ once on the server.
"""
from __future__ import annotations

import html
import logging
import re
import threading
from datetime import datetime
from types import SimpleNamespace
from typing import Iterable, Optional

logger = logging.getLogger(__name__)

# OLE2 Compound Document magic - every .mpp from MS Project 2003+ starts with these 8 bytes.
_OLE2_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

# mpxj/Java relation enum names -> our canonical FS/SS/FF/SF.
_REL_TYPE_MAP = {
    "FINISH_START": "FS", "START_START": "SS",
    "FINISH_FINISH": "FF", "START_FINISH": "SF",
}
_VALID_REL = ("FS", "SS", "FF", "SF")


# ============================================================================
# PURE LOGIC (laptop-testable) - ported 1:1 from the C# reference
# ============================================================================
class SchedulePercent:
    """Normalize 'percent complete' to a 0-1 fraction (port of SchedulePercent.cs).

    Most formats store 0-100, but .mpp via MPXJ UniversalProjectReader can surface an
    already-0-1 fraction for round-tripped/converted files. Dividing one of those by 100
    again collapses 100% -> 1% (the classic 'comes in as 100 in one file, 1 in another').
    A single value cannot disambiguate, so detect the scale ONCE per file from the column.
    """

    @staticmethod
    def is_fraction_scale(raw_values: Iterable[Optional[float]]) -> bool:
        """Fraction iff >=1 non-zero value AND no value exceeds 1.0.

        INHERITED EDGE (1:1 with the C# reference, documented not silently changed): an early-project
        file on the 0-100 scale where EVERY activity is genuinely below 1% complete (e.g. all 0.5)
        looks fraction-scaled and would be read as 50%. Unfixable from a single column without the
        file's stated scale; in practice a real schedule has at least one activity >=1%. Left as-is
        for parity; revisit if a real file trips it."""
        saw_nonzero = False
        for v in raw_values:
            if v is None or v < 0:
                continue            # ignore sentinels / bad data
            if v > 1.0:
                return False        # unmistakably a 0-100 percentage
            if v > 0:
                saw_nonzero = True
        return saw_nonzero

    @staticmethod
    def to_fraction(raw: Optional[float], fraction_scale: bool) -> Optional[float]:
        if raw is None:
            return None
        f = raw if fraction_scale else raw / 100.0
        if f < 0:
            return 0.0
        if f > 1:
            return 1.0
        return f


class ScheduleBaselineSelector:
    """Pick ONE baseline file-wide (port of ScheduleBaselineSelector.cs).

    MSP stores 11 baselines per task (primary #0 + Baseline1..Baseline10). Numbering is not
    chronological, so the baseline the scheduler actually saved into is the MOST-POPULATED one,
    not the highest number. The SAME number is applied to every task so the baseline stays coherent.
    """
    BASELINE_COUNT = 11

    @staticmethod
    def choose_number(counts: list[int]) -> int:
        """counts[n] = #tasks with baseline n populated. -> chosen number, or -1 if none."""
        if not counts:
            return -1
        if counts[0] > 0:
            return 0
        best, best_count = -1, 0
        for n in range(1, len(counts)):
            if counts[n] > best_count:
                best_count = counts[n]
                best = n
        return best

    @staticmethod
    def label(number: int) -> str:
        if number < 0:
            return "(no baseline set)"
        return "Baseline" if number == 0 else f"Baseline{number}"


# ---- XSS sanitization (free-text fields) -----------------------------------
# script/style carry a TEXT body that must be removed wholesale (not just their tags); other
# elements (img/iframe/meta/...) are removed by the general tag strip, their text (if any) is harmless.
_BLOCK_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1\s*>", re.I | re.S)
_TAG_RE = re.compile(r"<[^>]*>")
_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def sanitize_text(s: Optional[str]) -> Optional[str]:
    """Scrub schedule free-text (task name, notes, TASKMEMO) to safe PLAIN TEXT.

    P6 memo/notes can carry rich-text HTML with event handlers / <iframe> / <meta>. These fields are
    not rich content for our purposes, so the safe move is to strip to plain text: decode entities
    first (so entity-encoded tags surface), drop <script>/<style> blocks ENTIRELY (tag + body), strip
    any remaining tags, drop control chars. (For parity with the C# XssSanitizer's exact allowlist,
    swap this for a port of that class.)
    """
    if s is None:
        return None
    s = html.unescape(str(s))     # &lt;script&gt; -> <script> so the patterns below catch it
    s = _BLOCK_RE.sub("", s)      # remove <script>/<style> tag AND body
    s = _TAG_RE.sub("", s)        # strip any remaining tags
    s = _CTRL_RE.sub("", s)       # remove control chars
    s = s.strip()
    return s or None


# ---- format detection (magic bytes + XML namespace sniff) ------------------
def detect_format(file_path: str) -> Optional[str]:
    """Return 'mpp' | 'p6_xer' | 'p6_xml' | 'msp_xml' | None.

    .xer is unambiguously P6; .mpp is unambiguously MSP; but .xml is AMBIGUOUS (MSPDI vs PMXML)
    and MUST be resolved by the root namespace, never by extension.
    """
    try:
        with open(file_path, "rb") as f:
            raw = f.read(4096)
    except OSError:
        return None
    if raw[:8] == _OLE2_MAGIC:
        return "mpp"
    text = raw.decode("utf-8", "replace")
    if text.lstrip().startswith("ERMHDR"):
        return "p6_xer"
    low = text.lower()
    if "schemas.microsoft.com/project" in low:
        return "msp_xml"
    if ("apibusinessobjects" in low) or ("primavera" in low) or ("/p6/" in low):
        return "p6_xml"
    if "<project" in low:                 # MSPDI root is <Project ...> (fallback if namespace stripped)
        return "msp_xml"
    return None


# ---- schedule-integrity checks (the "tie-out" analog) ----------------------
def schedule_integrity(activities, relationships, header_count: Optional[int] = None) -> list[str]:
    """Logic/consistency warnings, surfaced as review reasons (never silent). Reads only public
    attributes (.code, .planned_start, .planned_finish, .extras) so it works on ParsedActivity and
    on lightweight test objects alike."""
    warnings: list[str] = []
    n = len(activities)
    if header_count is not None and header_count != n:
        warnings.append(f"activity count {n} != header-declared {header_count}")

    codes = {a.code for a in activities}
    unresolved = sum(1 for r in relationships
                     if r.predecessor_code not in codes or r.successor_code not in codes)
    if unresolved:
        warnings.append(f"{unresolved} relationship(s) reference an unknown task code")

    has_pred = {r.successor_code for r in relationships}     # tasks that HAVE a predecessor
    has_succ = {r.predecessor_code for r in relationships}   # tasks that HAVE a successor

    def _ex(a, k):
        return (getattr(a, "extras", None) or {}).get(k)

    dangling = [a for a in activities
                if not _ex(a, "is_summary") and not _ex(a, "milestone")
                and a.code not in has_pred and a.code not in has_succ]
    if dangling:
        warnings.append(f"{len(dangling)} activity(ies) with NO predecessor and NO successor (open ends)")

    bad_dates = sum(1 for a in activities
                    if getattr(a, "planned_start", None) and getattr(a, "planned_finish", None)
                    and a.planned_finish < a.planned_start)
    if bad_dates:
        warnings.append(f"{bad_dates} activity(ies) with finish before start")

    return warnings


def _derive_critical(fmt, total_float_days, native_critical):
    """Format-specific criticality (pure logic; ported from the C# parsers).

    Primavera (.xer / P6 XML): Total Float <= 0 is authoritative - P6's driving/critical flag
    UNDER-counts critical activities (the C# saw 114 vs 500+ in real files), so we derive from float.
    MS Project (.mpp / MSP XML): use the native Critical flag.
    Falls back to the native flag when float is unavailable.
    """
    if fmt in ("p6_xer", "p6_xml"):
        if total_float_days is None:
            return native_critical
        return total_float_days <= 0
    return native_critical


# ============================================================================
# MPXJ ENGINE (SERVER - needs JVM + MPXJ; not laptop-testable)
# ============================================================================
_JVM_LOCK = threading.Lock()


def _ensure_jvm() -> None:
    """Start the JVM once per process (idempotent + thread-safe). Same as mpp_binary.py."""
    from mpxj import startJVM, isJVMStarted
    if isJVMStarted():
        return
    with _JVM_LOCK:
        if not isJVMStarted():
            startJVM()
            logger.info("mpxj JVM started")


def _jdate_to_py(jd) -> Optional[datetime]:
    """MPXJ date / LocalDateTime -> python datetime. Robust across ISO-8601 variants MPXJ may emit
    (trailing 'Z', 'T' or space separator, with/without fractional seconds); returns None on anything
    unparseable rather than throwing (a bad date must never abort the whole parse)."""
    if jd is None:
        return None
    s = str(jd).strip()
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))   # py3.11 handles most; 3.10 the common case
    except Exception:
        pass
    base = s.replace("Z", "").replace("T", " ").split("+")[0].split(".")[0].strip()   # drop tz/fraction
    for f in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(base, f)
        except Exception:
            continue
    logger.debug("MPXJ date not parseable: %r", s)
    return None


def _duration_to_days(d, props=None) -> Optional[float]:
    """MPXJ Duration -> days via convertUnits. Passing the project's ProjectProperties applies the
    file's hours-per-day conversion factor (better than a fixed /8 like the old Python and the C#).
    NOTE: this is an hours/day FACTOR conversion, not a full working-calendar conversion - it does NOT
    walk the activity calendar's holidays/exceptions. For day-count reporting that is what P6/MSP
    themselves show; true calendar-walking is a P1 item once calendars are extracted."""
    if d is None:
        return None
    try:
        from mpxj import JClass
        TimeUnit = JClass("org.mpxj.TimeUnit")
        return float(d.convertUnits(TimeUnit.DAYS, props).getDuration())
    except Exception:
        s = str(d)
        try:
            return float(s.rstrip("dhmy "))
        except Exception:
            return None


def _baseline_counts(tasks) -> list[int]:
    """counts[n] = #tasks whose baseline n has a start date populated (n=0 primary, 1..10 numbered)."""
    counts = [0] * ScheduleBaselineSelector.BASELINE_COUNT
    for t in tasks:
        # primary baseline (number 0)
        try:
            if t.getBaselineStart() is not None:
                counts[0] += 1
        except Exception:
            pass
        for n in range(1, ScheduleBaselineSelector.BASELINE_COUNT):
            try:
                if t.getBaselineStart(n) is not None:   # MPXJ numbered-baseline accessor
                    counts[n] += 1
            except Exception:
                pass
    return counts


def _baseline_triplet(t, number, props):
    """(start, finish, duration_days) for the chosen baseline number on one task."""
    try:
        if number == 0:
            return (_jdate_to_py(t.getBaselineStart()), _jdate_to_py(t.getBaselineFinish()),
                    _duration_to_days(t.getBaselineDuration(), props))
        return (_jdate_to_py(t.getBaselineStart(number)), _jdate_to_py(t.getBaselineFinish(number)),
                _duration_to_days(t.getBaselineDuration(number), props))
    except Exception:
        return (None, None, None)


def parse_schedule(file_path: str, project_id: str = "", tenant_id: str = ""):
    """Read ANY supported schedule file via MPXJ UniversalProjectReader and return a dict:
        {format, baseline_source, activities[], relationships[], metadata{}, errors[]}
    activities/relationships are SimpleNamespace rows (the parser class below maps them to
    ParsedActivity / ParsedRelationship). Percent is file-wide normalized to 0-1; one chosen
    baseline is applied file-wide; free-text is sanitized."""
    fmt = detect_format(file_path)
    out = {"format": fmt, "baseline_source": ScheduleBaselineSelector.label(-1),
           "activities": [], "relationships": [], "metadata": {}, "errors": []}

    # P0: opening the file (JVM start + MPXJ read) is the failure-prone boundary - a corrupt /
    # unsupported / password-protected schedule must yield a STRUCTURED fatal error, never a raw throw,
    # so a batch of thousands never aborts on one bad file.
    try:
        _ensure_jvm()
        from mpxj import JClass
        reader = JClass("org.mpxj.reader.UniversalProjectReader")()
        project = reader.read(file_path)
    except Exception as exc:
        logger.exception("MPXJ could not open %s", file_path)
        out["errors"].append({"row": None, "column": None,
                              "message": f"MPXJ could not open this schedule: {exc}", "severity": "fatal"})
        return out
    if project is None:                                   # UniversalProjectReader returns null on unknown formats
        out["errors"].append({"row": None, "column": None,
                              "message": "MPXJ returned no project (unsupported or corrupt file)", "severity": "fatal"})
        return out
    props = _safe(project.getProjectProperties)
    try:
        tasks = [t for t in project.getTasks() if _safe_id(t) not in (None, 0)]
    except Exception as exc:
        out["errors"].append({"row": None, "column": None,
                              "message": f"MPXJ getTasks() failed: {exc}", "severity": "fatal"})
        return out

    # ---- pass 1: raw percents -> detect file-wide scale SEPARATELY for complete vs work-complete ----
    # (matches the C# NormalizePercentages: pctFraction and workFraction are detected independently,
    # so a lone 1.0 in one column can't flip the other.)
    raw_pcts, raw_work = [], []
    code_to_wbs: dict[str, str] = {}            # activity code -> WBS path (for WBS-based logic strings)
    for t in tasks:
        try:
            pc = t.getPercentageComplete()
            raw_pcts.append(float(pc) if pc is not None else None)
        except Exception:
            raw_pcts.append(None)
        raw_work.append(_num(t.getPercentageWorkComplete))
        w = _safe_str(t.getWBS)
        if w:
            code_to_wbs[_activity_code(t)] = w
    fraction_scale = SchedulePercent.is_fraction_scale(raw_pcts)
    work_fraction_scale = SchedulePercent.is_fraction_scale([v for v in raw_work if v is not None])

    # ---- choose ONE baseline file-wide ----
    chosen = ScheduleBaselineSelector.choose_number(_baseline_counts(tasks))
    out["baseline_source"] = ScheduleBaselineSelector.label(chosen)

    # ---- relationships FIRST (so each activity row can carry pred/succ display strings) ----
    # endpoints use the ACTIVITY CODE (P6 task_code / ActivityID), consistent with the activity rows
    # and the integrity checks (so codes always line up). dedup keeps the larger |lag|.
    edges: dict[tuple[str, str, str], float] = {}
    pred_str: dict[str, list[str]] = {}        # successor_code -> ["A1020FS+3d", ...]
    succ_str: dict[str, list[str]] = {}        # predecessor_code -> [...]
    wbs_pred_str: dict[str, list[str]] = {}    # successor_code -> ["<pred WBS>[FS+3d]", ...]  (C# WBSPredecessors)
    wbs_succ_str: dict[str, list[str]] = {}
    for t in tasks:
        preds = _safe(t.getPredecessors)
        if not preds:
            continue
        for rel in preds:
            try:
                p, s = rel.getPredecessorTask(), rel.getSuccessorTask()
                if p is None or s is None or _safe_id(p) in (None, 0) or _safe_id(s) in (None, 0):
                    continue
                pcode, scode = _activity_code(p), _activity_code(s)
                if pcode == scode:
                    continue
                rtype = _REL_TYPE_MAP.get(str(rel.getType().name()), "FS")
                lag = _duration_to_days(_safe(rel.getLag), props) or 0.0
                key = (pcode, scode, rtype)
                if key not in edges or abs(lag) > abs(edges[key]):
                    edges[key] = lag
            except Exception as exc:
                out["errors"].append({"row": _safe_id(t), "column": "Predecessors",
                                      "message": f"relationship parse error: {exc}", "severity": "warning"})
    for (pcode, scode, rtype), lag in edges.items():
        out["relationships"].append(SimpleNamespace(
            predecessor_code=pcode, successor_code=scode, relationship_type=rtype, lag_days=lag))
        pred_str.setdefault(scode, []).append(_rel_token(pcode, rtype, lag))
        succ_str.setdefault(pcode, []).append(_rel_token(scode, rtype, lag))
        # WBS-based variants (the C#'s WBSPredecessors/WBSSuccessors: endpoint WBS in [type+lag] brackets)
        wbs_pred_str.setdefault(scode, []).append(f"{code_to_wbs.get(pcode, pcode)}[{rtype}{_lag_suffix(lag)}]")
        wbs_succ_str.setdefault(pcode, []).append(f"{code_to_wbs.get(scode, scode)}[{rtype}{_lag_suffix(lag)}]")

    # ---- activities: FULL field parity with the C# parsers (rich fields in extras, non-breaking) ----
    for t, raw_pc, raw_wk in zip(tasks, raw_pcts, raw_work):
        tid = _safe_id(t)
        code = _activity_code(t)                               # P6 ActivityID / task_code, NOT the internal getID()
        name = sanitize_text(_safe_str(t.getName)) or f"Task {code}"
        wbs = _safe_str(t.getWBS)
        p_start = _jdate_to_py(_safe(t.getStart))
        total_float = _duration_to_days(_safe(t.getTotalSlack), props)
        # CRITICALITY (format-specific, matching the C#): Primavera (XER/P6-XML) treats Total Float <= 0
        # as authoritative because P6's driving/critical flag UNDER-counts (114 vs 500+ in real files);
        # MS Project (.mpp/MSP-XML) uses the native Critical flag.
        native_crit = bool(_safe(t.getCritical)) if _safe(t.getCritical) is not None else None
        is_critical = _derive_critical(fmt, total_float, native_crit)
        b_start, b_finish, b_dur = (_baseline_triplet(t, chosen, props) if chosen >= 0 else (None, None, None))
        # P6 convention (matching the C# P6 XML path): Primavera has no separate baseline in PMXML -
        # the PLANNED dates ARE the baseline. So for P6 formats, fall back to planned start/finish when
        # MPXJ exposes no baseline. (MS Project keeps the selected numbered baseline.)
        p_finish = _jdate_to_py(_safe(t.getFinish))
        if fmt in ("p6_xer", "p6_xml") and b_start is None and (p_start or p_finish):
            b_start, b_finish = p_start, p_finish
            if b_dur is None:
                b_dur = _duration_to_days(_safe(t.getDuration), props)
            if out["baseline_source"] in ("(no baseline set)",):
                out["baseline_source"] = "Planned (P6)"
        # start variance: MPXJ computes it vs the PRIMARY baseline; when we pick a NON-primary baseline,
        # recompute against the one we actually used (exactly as the C# ApplyBaselines does).
        sv = _duration_to_days(_safe(t.getStartVariance), props)
        if chosen not in (0, -1) and p_start and b_start:
            sv = round((p_start - b_start).total_seconds() / 86400.0, 2)
        # TaskSummaryName = parent task's name (the C# sets this on every path; the normalizer groups on it)
        parent = _safe(t.getParentTask)
        task_summary_name = sanitize_text(_safe_str(parent.getName)) if parent is not None else None
        extras = {
            "source_format": fmt,
            "task_id": tid,
            "unique_id": _safe_int(t.getUniqueID),
            "activity_code": code,
            "wbs": wbs,
            "task_summary_name": task_summary_name,
            "outline_level": _safe_int(t.getOutlineLevel),
            "outline_number": _safe_str(t.getOutlineNumber),
            "is_summary": bool(_safe(t.getSummary)) if _safe(t.getSummary) is not None else False,
            "is_milestone": bool(_safe(t.getMilestone)) if _safe(t.getMilestone) is not None else None,
            "milestone": "Yes" if _safe(t.getMilestone) else None,        # kept for back-compat
            "is_active": bool(_safe(t.getActive)) if _safe(t.getActive) is not None else None,
            # CPM network dates
            "early_start": _iso(_jdate_to_py(_safe(t.getEarlyStart))),
            "early_finish": _iso(_jdate_to_py(_safe(t.getEarlyFinish))),
            "late_start": _iso(_jdate_to_py(_safe(t.getLateStart))),
            "late_finish": _iso(_jdate_to_py(_safe(t.getLateFinish))),
            # durations
            "remaining_duration_days": _duration_to_days(_safe(t.getRemainingDuration), props),
            "actual_duration_days": _duration_to_days(_safe(t.getActualDuration), props),
            # float / slack (critical-path & DCMA analysis)
            "total_float_days": total_float,
            "free_float_days": _duration_to_days(_safe(t.getFreeSlack), props),
            # baseline (file-wide selected) + variances
            "baseline_start": _iso(b_start),
            "baseline_finish": _iso(b_finish),
            "baseline_duration_days": b_dur,
            "baseline_source": out["baseline_source"],
            "start_variance_days": sv,
            "finish_variance_days": _duration_to_days(_safe(t.getFinishVariance), props),
            # cost / work loading (P1 - confirmed available by probe_schedule_mpxj.py)
            "cost": _cost(t.getCost),
            "baseline_cost": _cost(t.getBaselineCost),
            "actual_cost": _cost(t.getActualCost),
            "fixed_cost": _cost(t.getFixedCost),
            "work_days": _duration_to_days(_safe(t.getWork), props),
            # progress (both kinds, normalized to 0-1, scales detected independently)
            "percent_work_complete": SchedulePercent.to_fraction(raw_wk, work_fraction_scale),
            # constraints (schedule-quality analysis)
            "constraint_type": _enum_name(t.getConstraintType),
            "constraint_date": _iso(_jdate_to_py(_safe(t.getConstraintDate))),
            # other task attributes
            "priority": _priority_val(t.getPriority),
            "calendar": _calendar_name(t.getCalendar),
            "notes": sanitize_text(_safe_str(t.getNotes) if hasattr(t, "getNotes") else None),
            # user-defined fields. getText/getNumber capture MSP-style custom fields (Text1/Number1..10).
            # P6 UDFs (UDFTYPE/UDFVALUE, e.g. "MSP Activity ID") surface in MPXJ as aliased custom fields:
            "udf_text": _udf_text(t, 5),
            "udf_number": _udf_number(t, 10),
            "udf_p6": _udf_by_label(t, project),
            # human-readable logic strings (the C#'s Predecessors/Successors and WBSPredecessors/Successors)
            "predecessors": "; ".join(pred_str.get(code, [])) or None,
            "successors": "; ".join(succ_str.get(code, [])) or None,
            "wbs_predecessors": "; ".join(wbs_pred_str.get(code, [])) or None,
            "wbs_successors": "; ".join(wbs_succ_str.get(code, [])) or None,
        }
        out["activities"].append(SimpleNamespace(
            code=code,
            name=name,
            wbs_path=wbs,
            duration_days=_duration_to_days(_safe(t.getDuration), props),
            planned_start=p_start,
            planned_finish=p_finish,
            actual_start=_jdate_to_py(_safe(t.getActualStart)),
            actual_finish=_jdate_to_py(_safe(t.getActualFinish)),
            progress_pct=SchedulePercent.to_fraction(raw_pc, fraction_scale),   # 0-1 contract
            is_critical=is_critical,
            extras=extras,
        ))

    # ---- resources + assignments (P1: RSRC / TASKRSRC - method names confirmed by probe_schedule_mpxj.py) ----
    out["resources"] = _extract_resources(project, out)
    out["assignments"] = _extract_assignments(project, props, out)

    # ---- metadata + integrity ----
    try:
        out["metadata"] = {
            "rows_processed": len(out["activities"]),
            "relationships_extracted": len(out["relationships"]),
            "baseline_source": out["baseline_source"],
            "percent_scale": "fraction(0-1)" if fraction_scale else "percent(0-100)",
            "project_title": _safe_str(props.getProjectTitle) if props else None,
            "data_date": _iso(_jdate_to_py(_safe(props.getStatusDate))) if props else None,  # P1: progress/EVM anchor
            "resources": len(out["resources"]),
            "assignments": len(out["assignments"]),
        }
    except Exception:
        out["metadata"] = {"rows_processed": len(out["activities"]),
                           "relationships_extracted": len(out["relationships"])}
    out["metadata"]["integrity_warnings"] = schedule_integrity(out["activities"], out["relationships"])
    return out


# ---- tiny MPXJ null-safe helpers ----
def _safe(getter):
    try:
        return getter()
    except Exception:
        return None


def _safe_str(getter):
    v = _safe(getter)
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _safe_id(t):
    try:
        return int(t.getID())
    except Exception:
        return None


def _iso(dt):
    return dt.isoformat() if dt else None


def _cost(getter):
    """A monetary/number MPXJ getter -> float (2dp) or None. Never raises."""
    v = _safe(getter)
    if v is None:
        return None
    try:
        return round(float(str(v)), 2)
    except Exception:
        return None


def _extract_resources(project, out):
    """RSRC rows: id / name / type / rate / cost / max-units. [] if the file has no resources."""
    res = []
    try:
        for r in project.getResources():
            name = sanitize_text(_safe_str(r.getName))
            rid = _safe_str(r.getResourceID) or _safe_int(r.getUniqueID)
            if name is None and rid is None:
                continue
            res.append(SimpleNamespace(
                resource_id=rid, name=name, type=_enum_name(r.getType),
                standard_rate=_safe_str(r.getStandardRate), cost=_cost(r.getCost),
                max_units=_num(r.getMaxUnits)))
    except Exception as exc:
        out["errors"].append({"row": None, "column": "resources",
                              "message": f"resource parse error: {exc}", "severity": "warning"})
    return res


def _extract_assignments(project, props, out):
    """TASKRSRC rows: which resource is loaded on which activity (units / work / cost)."""
    asn = []
    try:
        for a in project.getResourceAssignments():
            r = _safe(a.getResource)
            t = _safe(a.getTask)
            asn.append(SimpleNamespace(
                resource=sanitize_text(_safe_str(r.getName)) if r is not None else None,
                task_code=_activity_code(t) if t is not None else None,
                units=_num(a.getUnits), work_days=_duration_to_days(_safe(a.getWork), props),
                cost=_cost(a.getCost), actual_cost=_cost(a.getActualCost)))
    except Exception as exc:
        out["errors"].append({"row": None, "column": "assignments",
                              "message": f"assignment parse error: {exc}", "severity": "warning"})
    return asn


def _safe_int(getter):
    v = _safe(getter)
    if v is None:
        return None
    try:
        return int(v)
    except Exception:
        try:
            return int(v.intValue())
        except Exception:
            return None


def _num(getter):
    """MPXJ Number -> float (handles java.lang.Number)."""
    v = _safe(getter)
    if v is None:
        return None
    try:
        return float(v)
    except Exception:
        try:
            return float(v.doubleValue())
        except Exception:
            return None


def _priority_val(getter):
    v = _safe(getter)
    if v is None:
        return None
    try:
        return int(v.getValue())          # MPXJ Priority object
    except Exception:
        try:
            return int(v)
        except Exception:
            return None


def _calendar_name(getter):
    v = _safe(getter)
    if v is None:
        return None
    try:
        n = v.getName()                   # MPXJ ProjectCalendar
        return str(n).strip() if n else None
    except Exception:
        return None


def _enum_name(getter):
    """MPXJ enum (ConstraintType, ...) -> its name string."""
    v = _safe(getter)
    if v is None:
        return None
    try:
        return str(v.name()) if hasattr(v, "name") else str(v)
    except Exception:
        return None


def _activity_code(t):
    """The activity CODE a planner sees (P6 ActivityID e.g. 'A1020' / MSP task code), NOT MPXJ's
    internal getID(). Falls back to the numeric ID when no code exists. Relationships and the
    integrity checks key on THIS, so activity rows and edges always line up."""
    try:
        v = t.getActivityID()             # P6 activity id
        if v is not None and str(v).strip():
            return str(v).strip()
    except Exception:
        pass
    return str(_safe_id(t))


def _lag_suffix(lag):
    """Lag display suffix: '' (no lag), '+3d', '-2d'."""
    if not lag:
        return ""
    return f"{'+' if lag > 0 else ''}{lag:g}d"


def _rel_token(code, rtype, lag):
    """One predecessor/successor display token: 'A1020FS', 'A1020FS+3d', 'A1020SS-2d'."""
    return f"{code}{rtype}{_lag_suffix(lag)}"


def _udf_text(t, n):
    """Populated user-defined Text1..TextN -> {index: value} (sanitized), or None."""
    out = {}
    for i in range(1, n + 1):
        try:
            v = t.getText(i)
            if v is not None and str(v).strip():
                out[i] = sanitize_text(str(v))
        except Exception:
            pass
    return out or None


def _udf_number(t, n):
    """Populated user-defined Number1..NumberN -> {index: value}, or None."""
    out = {}
    for i in range(1, n + 1):
        try:
            v = t.getNumber(i)
            if v is None:
                continue
            try:
                out[i] = float(v)
            except Exception:
                out[i] = float(v.doubleValue())
        except Exception:
            pass
    return out or None


def _udf_by_label(t, project):
    """P6 user-defined fields by LABEL (the C#'s UDFTYPE/UDFVALUE read, e.g. 'MSP Activity ID').

    In MPXJ, P6 UDFs surface as custom fields whose alias is the P6 field name; the value is read with
    task.get(fieldType). Best-effort and fully guarded - if the CustomFieldContainer API differs in your
    MPXJ version, this returns None rather than failing. Confirm against your MPXJ build on the server;
    this is the one piece of C# logic that can't be verified off the JVM.
    """
    out = {}
    try:
        for f in project.getCustomFields():            # CustomFieldContainer -> CustomField items
            try:
                alias = f.getAlias()
                if alias is None or not str(alias).strip():
                    continue
                v = t.get(f.getFieldType())
                if v is not None and str(v).strip():
                    out[str(alias).strip()] = sanitize_text(str(v))
            except Exception:
                continue
    except Exception:
        return None
    return out or None


# ============================================================================
# PIPELINE PARSER (registers into the existing registry; one parser, all formats)
# ============================================================================
try:
    from .base import BaseParser, ParseResult, ParsedActivity, ParsedRelationship, ParsedError
    from ..parser_registry import register_parser
    _HAVE_BASE = True
except Exception:                       # standalone import (e.g. unit-testing the pure logic) - skip registration
    _HAVE_BASE = False

if _HAVE_BASE:
    @register_parser
    class MpxjScheduleParser(BaseParser):
        FORMAT = "schedule_mpxj"
        KIND = "schedule"
        DESCRIPTION = "P6 + MS Project schedules (.mpp/.xer/P6-XML/MSP-XML) via MPXJ UniversalProjectReader"
        EXTENSIONS = (".mpp", ".xer", ".xml")

        @classmethod
        def can_parse(cls, file_path: str) -> bool:
            return detect_format(file_path) is not None

        def parse(self, file_path: str, project_id: str, tenant_id: str) -> "ParseResult":
            result = ParseResult(format=self.FORMAT)
            try:
                data = parse_schedule(file_path, project_id, tenant_id)
            except Exception as exc:
                logger.exception("MPXJ read failed for %s", file_path)
                result.errors.append(ParsedError(row=None, column=None,
                                     message=f"MPXJ could not read this schedule: {exc}", severity="fatal"))
                return result

            result.format = data["format"] or self.FORMAT
            for a in data["activities"]:
                result.activities.append(ParsedActivity(
                    code=a.code, name=a.name, wbs_path=a.wbs_path, duration_days=a.duration_days,
                    planned_start=a.planned_start, planned_finish=a.planned_finish,
                    actual_start=a.actual_start, actual_finish=a.actual_finish,
                    progress_pct=a.progress_pct, is_critical=a.is_critical, extras=a.extras))
            for r in data["relationships"]:
                result.relationships.append(ParsedRelationship(
                    predecessor_code=r.predecessor_code, successor_code=r.successor_code,
                    relationship_type=r.relationship_type, lag_days=r.lag_days))
            for e in data["errors"]:
                result.errors.append(ParsedError(row=e.get("row"), column=e.get("column"),
                                     message=e.get("message", ""), severity=e.get("severity", "warning")))
            # integrity warnings -> non-fatal errors so they reach the review queue (never silent)
            for w in data["metadata"].get("integrity_warnings", []):
                result.errors.append(ParsedError(row=None, column=None, message=f"integrity: {w}",
                                     severity="warning"))
            result.metadata = data["metadata"]
            return result
