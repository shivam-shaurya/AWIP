"""schedule_normalize.py - Python port of XerScheduleNormalizer.cs (the "normalization" step).

Reshapes flat Primavera XER tasks into MSP-style HIERARCHICAL form so a downstream "is_leaf"
WBS-prefix logic works unchanged. Faithful 1:1 port of the C# reference. Pure Python, fully
laptop-testable (see test_schedule_normalize.py).

Four transformations, in order (exactly as the C#):
  1. SANITIZE every free-text field (XSS strip) - P6 TASKMEMO can carry HTML/event-handlers/iframe.
  2. REWRITE each leaf's WBS with a unique .NNNN suffix within its (WBS, task_summary_name) group.
  3. SYNTHESIZE summary rows bottom-up: one per (parent_wbs, task_summary_name), then again at each
     higher WBS level by stripping the trailing dot segment; stop at the root (a WBS with no '.').
  4. ORDER everything by WBS (ordinal) and assign a 1-based Id.

Synthetic summary ActivityId = "SUM-" + first 16 hex of SHA1(packageId|wbs|name) (UPPER, matching
C# BitConverter.ToString). Stable, so a re-import updates the same summary row instead of duplicating.

DATA SHAPE: operates on a list of task dicts. Keys it uses (others are passed through untouched):
  wbs, task_summary_name, name, notes, text1, remarks, responsible_person, contact_number,
  predecessors, successors, wbs_predecessors, wbs_successors,   (free-text -> sanitized)
  baseline_start, baseline_finish (datetime|None -> rolled up onto summaries),
  is_summary, activity_id, outline_level, id  (set/overwritten by this module).

RELATION TO MPXJ: when you read files via MPXJ UniversalProjectReader (schedule_mpxj.py), MPXJ already
resolves the real WBS hierarchy, so this normalizer is OPTIONAL there - run it only if a downstream
consumer specifically needs this .NNNN-leaf + SUM- summary shape. For the native XER path (flat tasks)
it is required.
"""
from __future__ import annotations

import hashlib
import html
import re
from collections import OrderedDict
from typing import Optional

# Reuse the one sanitizer from the parser if importable; otherwise a local copy (keeps this standalone).
try:
    from schedule_mpxj import sanitize_text  # type: ignore
except Exception:
    _BLOCK_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1\s*>", re.I | re.S)
    _TAG_RE = re.compile(r"<[^>]*>")
    _CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

    def sanitize_text(s: Optional[str]) -> Optional[str]:
        if s is None:
            return None
        s = html.unescape(str(s))
        s = _BLOCK_RE.sub("", s)
        s = _TAG_RE.sub("", s)
        s = _CTRL_RE.sub("", s)
        s = s.strip()
        return s or None


# Free-text fields scrubbed before anything can reach a web surface (1:1 with C# SanitizeTextFields).
_FREE_TEXT_FIELDS = (
    "notes", "name", "task_summary_name", "text1", "remarks", "responsible_person",
    "contact_number", "predecessors", "successors", "wbs_predecessors", "wbs_successors",
)


# ============================================================================
# WBS segment helpers (1:1 with the C#)
# ============================================================================
def strip_last_segment(wbs: Optional[str]) -> str:
    """Everything before the last '.', or '' when there is no '.'."""
    if not wbs:
        return ""
    i = wbs.rfind(".")
    return "" if i < 0 else wbs[:i]


def last_segment(wbs: Optional[str]) -> Optional[str]:
    """Everything after the last '.', or the whole string when there is no '.'."""
    if not wbs:
        return wbs
    i = wbs.rfind(".")
    return wbs if i < 0 else wbs[i + 1:]


def segment_count(wbs: Optional[str]) -> int:
    """Number of dot-separated segments (0 for empty)."""
    return 0 if not wbs else wbs.count(".") + 1


def synthetic_activity_id(package_id: Optional[str], wbs: Optional[str], name: Optional[str]) -> str:
    """Stable 'SUM-' + first 16 UPPERCASE hex of SHA1(packageId|wbs|name). Deterministic across
    re-imports (same inputs -> same id), matching C# BitConverter.ToString(...).Replace("-","")."""
    raw = (package_id or "") + "|" + (wbs or "") + "|" + (name or "")
    hexd = hashlib.sha1(raw.encode("utf-8")).hexdigest().upper()
    return "SUM-" + hexd[:16]


# ============================================================================
# steps
# ============================================================================
def _sanitize_fields(tasks: list[dict]) -> None:
    for t in tasks:
        for k in _FREE_TEXT_FIELDS:
            if k in t:
                t[k] = sanitize_text(t.get(k))


def _rewrite_leaf_wbs(tasks: list[dict]) -> list[dict]:
    """Each leaf's WBS gets a unique .NNNN suffix within its (WBS, task_summary_name) group, in
    original order. Marks is_summary=False. (Faithful to C#: the suffix counter is per
    (WBS, task_summary_name) group - see the note in normalize_xer_schedule about the edge case.)"""
    groups: "OrderedDict[tuple, list[dict]]" = OrderedDict()
    for t in tasks:
        key = (t.get("wbs") or "", t.get("task_summary_name") or "")
        groups.setdefault(key, []).append(t)
    for items in groups.values():
        seq = 1
        for t in items:                       # insertion order == original order
            parent = t.get("wbs") or ""
            t["wbs"] = f"{parent}.{seq:04d}"
            t["is_summary"] = False
            seq += 1
    return tasks


def _build_summary(package_id: Optional[str], wbs: str, name: Optional[str], children: list[dict]) -> dict:
    """A synthetic summary node: baseline start = min(children), finish = max(children)."""
    min_start = None
    max_finish = None
    for c in children:
        cs = c.get("baseline_start")
        cf = c.get("baseline_finish")
        if cs is not None and (min_start is None or cs < min_start):
            min_start = cs
        if cf is not None and (max_finish is None or cf > max_finish):
            max_finish = cf
    return {
        "activity_id": synthetic_activity_id(package_id, wbs, name),
        "wbs": wbs,
        "name": name,
        "task_summary_name": name,
        "is_summary": True,
        "baseline_start": min_start,
        "baseline_finish": max_finish,
        "outline_level": segment_count(wbs),
    }


def _synthesize_summaries(leaves: list[dict], package_id: Optional[str]) -> list[dict]:
    """Bottom-up synthetic summaries, at most ONE per WBS node (keyed by WBS)."""
    emitted: "dict[str, dict]" = {}

    # Level 1: one per distinct (parent_wbs, task_summary_name); first name wins per parent_wbs.
    level1: "OrderedDict[tuple, list[dict]]" = OrderedDict()
    for t in leaves:
        tsn = t.get("task_summary_name")
        if not tsn or not str(tsn).strip():
            continue
        parent = strip_last_segment(t.get("wbs") or "")
        if not parent:
            continue
        level1.setdefault((parent, str(tsn).strip()), []).append(t)

    for (parent, name) in sorted(level1.keys(), key=lambda k: k[0]):   # ordinal by parent_wbs, stable
        if parent in emitted:
            continue
        emitted[parent] = _build_summary(package_id, parent, name, level1[(parent, name)])

    # Higher levels: strip trailing dot segments until the root.
    frontier = list(emitted.keys())
    while frontier:
        nxt: set[str] = set()
        for w in frontier:
            parent = strip_last_segment(w)
            if not parent:
                continue                       # already at root
            if "." not in parent:
                continue                       # would be a self-named root row (useless)
            if parent in emitted:
                nxt.add(parent)
                continue
            children = [s for s in emitted.values() if strip_last_segment(s["wbs"]) == parent]
            emitted[parent] = _build_summary(package_id, parent, last_segment(parent), children)
            nxt.add(parent)
        frontier = list(nxt)

    return list(emitted.values())


def normalize_xer_schedule(tasks: list[dict], package_id: str) -> list[dict]:
    """Top-level entry (1:1 with XerScheduleNormalizer.Normalize). Mutates and returns `tasks`
    plus synthetic summary rows, ordered by WBS with a 1-based id.

    EDGE CASE (preserved from the C#): the leaf-WBS suffix counter is per (WBS, task_summary_name)
    group, so two leaves that share a WBS but have DIFFERENT task_summary_name both restart at .0001
    and collide. Faithful to the reference (their data keeps task_summary_name consistent per WBS);
    if your XER can violate that, make the counter per-WBS instead. Flagged, not silently changed.
    """
    if not tasks:
        return tasks
    _sanitize_fields(tasks)
    leaves = _rewrite_leaf_wbs(tasks)
    summaries = _synthesize_summaries(leaves, package_id)

    combined = summaries + leaves
    combined.sort(key=lambda t: t.get("wbs") or "")        # ordinal WBS order (summaries before their leaves)
    for i, t in enumerate(combined):
        t["id"] = i + 1
    return combined
