#!/usr/bin/env python3
r"""
reconcile_tables.py - ARITHMETIC-ANCHORED reconciliation of noisy PDF tables against an authoritative
Excel. One Excel sheet may map across N fragmented PDF pages; we align on the MONEY SEQUENCE (not fuzzy
text - engineering docs repeat headers and OCR is noisy), then inject the clean Excel rows into the
doc_layout element stream IN PLACE of the tombstones, preserving id/bbox/section_path/reading order.

Pipeline (all offline, against the written <stem>.layout.json):
  1 doc_layout (--reconcile-tables) tagged uncertain tables with a `reconcile` tombstone block.
  2 group_tombstones        -> cluster per-page tombstones into logical tables (1 logical table = N pages).
  3 analyze_excel           -> excel_extract._analyze: clean grids + the Excel's OWN tie-out proof.
  4 propose_links + align   -> map each Excel sheet to a tombstone group; anchor-then-segment alignment.
  5 GATES (excel_is_trusted + count-reconcile + confidence) -> propose, never silently commit.
  6 inject (--apply, human-approved) -> idempotent, atomic; keeps the original grid + provenance.

REUSES common.py (one parser / one tie-out / one glyph map / one atomic IO) and excel_extract._analyze.
The pure-logic core (num_match, align_sheet_to_group, gates, grouping) is laptop-testable with no files.
Default CLI run is a DRY RUN (writes the sidecar + queue row, mutates nothing).
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import common
try:
    import excel_extract
except Exception:                       # excel_extract pulls openpyxl/xlrd; keep the pure core importable
    excel_extract = None


def _cfg(cfg, k, d):
    return getattr(cfg, k, d) if cfg is not None else d


# ============================================================================
# NUMERIC MATCHING (tolerance + OCR-glyph) - the alignment primitive
# ============================================================================
def _fmt_digits(v):
    """A float's significant digit string (drop trailing .0, strip separators/decimal): 3000.0->'3000',
    1234.50->'123450'. The canonical form an OCR'd token must match (after glyph-mapping)."""
    if v is None:
        return ""
    s = ("%f" % float(v)).rstrip("0").rstrip(".") if isinstance(v, float) else str(v)
    return re.sub(r"[^0-9]", "", s)

def _glyph_subs(excel_digits, pdf_raw):
    """If the OCR token `pdf_raw`, after mapping glyph-confusable chars to digits (common._GLYPH_MAP:
    O->0, l/I/|->1, S->5 ...), equals `excel_digits`, return the NUMBER of glyph substitutions used;
    else None. A non-digit/non-glyph char (real text) -> None (not a numeric token)."""
    pd = re.sub(r"[^0-9A-Za-z|]", "", str(pdf_raw or ""))
    if not pd:
        return None
    mapped, subs = [], 0
    for ch in pd:
        if ch.isdigit():
            mapped.append(ch)
        elif ch in common._GLYPH_MAP and common._GLYPH_MAP[ch].isdigit():
            mapped.append(common._GLYPH_MAP[ch]); subs += 1
        else:
            return None
    return subs if "".join(mapped) == excel_digits else None

def _glyph_to_digits(raw):
    """Map a token's glyph-confusable chars to digits and keep only the digit run (O->0, l/I/|->1...)."""
    s = re.sub(r"[^0-9A-Za-z|]", "", str(raw or ""))
    out = []
    for ch in s:
        if ch.isdigit():
            out.append(ch)
        elif ch in common._GLYPH_MAP and common._GLYPH_MAP[ch].isdigit():
            out.append(common._GLYPH_MAP[ch])
    return "".join(out)

def _pdf_numeric(raw):
    """LENIENT, GLYPH-AWARE numeric-cell test for the PDF (noisy) side ONLY. A blurry amount like
    '1OOO' (no surviving digit) is still a numeric candidate so the glyph-tolerant matcher can score it
    (G1). Guarded against prose: the cell must be PREDOMINANTLY digit/glyph chars (>=60%) with >=2 such
    chars - 'ItemI' is rejected, '1OOO'/'l23.4S' accepted. The Excel side stays on the strict parser."""
    if common.is_amount_cell(raw):
        return True
    s = re.sub(r"[\s,]", "", str(raw or ""))
    if not s:
        return False
    digitish = sum(1 for ch in s if ch.isdigit() or (ch in common._GLYPH_MAP and common._GLYPH_MAP[ch].isdigit()))
    return digitish >= 2 and digitish >= 0.6 * len(s)

def num_match(excel_val, pdf_val, pdf_raw, cfg=None):
    """Score how well one Excel number matches one PDF cell: exact within rounding tol -> 1.0; within a
    relative tol -> 0.9; an OCR-glyph variant of the same digits (<= max_subs) -> 0.7; else 0.0.
    excel_val is the clean float; pdf_val is parse_number(raw) (may be None if OCR mangled it); pdf_raw
    is the original OCR string (used for the glyph tier)."""
    if excel_val is None:
        return None
    if pdf_val is not None:
        tol = common.round_tolerance(1, per_row=_cfg(cfg, "reconcile_round_rupees", 0.5),
                                     floor=_cfg(cfg, "reconcile_abs_floor", 1.0))
        if abs(excel_val - pdf_val) <= tol:
            return 1.0
        rel = _cfg(cfg, "reconcile_align_rel", 0.01)
        if abs(excel_val - pdf_val) <= rel * max(abs(excel_val), abs(pdf_val), 1.0):
            return 0.9
    ed = _glyph_subs(_fmt_digits(excel_val), pdf_raw)
    if ed is not None and ed <= _cfg(cfg, "reconcile_align_max_subs", 2):
        return 0.7
    return 0.0

_WEIGHTS = {"amount": 0.6, "rate": 0.25, "qty": 0.15}

def _row_score(excel_anchor, pdf_anchor, cfg=None):
    """Weighted multi-column row match (amount .6 / rate .25 / qty .15) over the columns both sides have."""
    num = den = 0.0
    for role, w in _WEIGHTS.items():
        ev = excel_anchor.get(role, (None, ""))[0]
        if ev is None:
            continue
        pv, praw = pdf_anchor.get(role, (None, ""))
        m = num_match(ev, pv, praw, cfg)
        if m is None:
            continue
        num += w * m; den += w
    return (num / den) if den > 0 else 0.0


# ============================================================================
# CONTEXT SIGNALS (header / section / caption) - tie-breakers ON TOP of numbers.
# Numeric-anchor alignment stays PRIMARY; these only nudge confidence +/- so a
# numbers-coincidence with clashing headers/section holds for a human (FIX 2/3).
# ============================================================================
_TABLE_TOKEN_RE = re.compile(
    r"\b(table|schedule|annexure|annex|appendix|exhibit|form|bill)\b[\s\-:.#]*([0-9]+(?:\.[0-9]+)*|[a-z])\b",
    re.I)

def _header_text(grid):
    """Normalized text of a grid's HEADER rows (everything before the first data row). Compared PDF-side
    vs Excel-side to disambiguate similar-numbered tables. Falls back to row 0 when no header is inferred."""
    try:
        header, _data, _ = grid_data_rows(grid, numeric_pred=_pdf_numeric)
    except Exception:
        header = []
    rows = header if header else ([0] if grid else [])
    return " ".join(str(c) for i in rows if i < len(grid) for c in grid[i] if str(c or "").strip()).strip()

def _table_token(text):
    """A caption token from free text: 'Table 3.2'->('table','3.2'), 'Schedule H'->('schedule','h'),
    'Annexure B'->('annexure','b'). None when no recognizable token."""
    m = _TABLE_TOKEN_RE.search(str(text or ""))
    return (m.group(1).lower(), m.group(2).lower()) if m else None

def _fuzzy(a, b):
    """Token-set similarity in [0,1] (rapidfuzz via common.fuzz, difflib fallback). None if either empty."""
    a = (a or "").strip(); b = (b or "").strip()
    if not a or not b:
        return None
    return max(0.0, min(1.0, common.fuzz.token_set_ratio(a, b) / 100.0))

def _caption_signal(pdf_text, excel_text, cfg=None):
    """Caption/table-number agreement between a tombstone's section/caption and an Excel sheet name:
    +bonus when both carry the SAME kind+ident ('Table 3.2' == 'Table 3.2'); -penalty when the SAME KIND
    but a DIFFERENT ident ('Table 3.2' vs 'Table 5' -> strong disagreement -> push to human); 0 otherwise."""
    pt, et = _table_token(pdf_text), _table_token(excel_text)
    if not pt or not et or pt[0] != et[0]:
        return 0.0
    return _cfg(cfg, "reconcile_caption_bonus", 0.10) if pt[1] == et[1] else -_cfg(cfg, "reconcile_caption_penalty", 0.25)

def _context_adjust(numeric_conf, pdf_header, excel_header, section_text, sheet_name, cfg=None):
    """Fold header + section + caption agreement into the numeric confidence. Numeric stays PRIMARY: with
    NO context (empty headers/section, no caption token) the adjustment is EXACTLY 0 -> byte-identical to
    numbers-only. Agreement nudges confidence UP (capped 1.0); disagreement nudges it DOWN (a coincidental
    numeric match with clashing headers/section drops below the gate -> held for a human). Returns
    (adjusted_conf, context_dict)."""
    hs = _fuzzy(pdf_header, excel_header)
    ss = _fuzzy(section_text, sheet_name)
    cap = _caption_signal(section_text, sheet_name, cfg)
    adj = 0.0
    if hs is not None:
        adj += _cfg(cfg, "reconcile_w_header", 0.12) * (hs - 0.5) * 2.0
    if ss is not None:
        adj += _cfg(cfg, "reconcile_w_section", 0.08) * (ss - 0.5) * 2.0
    adj += cap
    if cap < 0:                       # a CONTRADICTING caption is authoritative: header/section fuzzy
        adj = min(adj, cap)           # (esp. the shared 'Table' word) must NOT rescue it -> stays >= full penalty
    conf = max(0.0, min(1.0, numeric_conf + adj))
    return round(conf, 3), {"header_sim": hs, "section_sim": ss, "caption": round(cap, 3), "adjust": round(adj, 3)}

def _apply_context(al, pdf_header, excel_header, section_text, sheet_name, cfg=None):
    """Return a COPY of alignment `al` with overall + per-segment confidence rescaled to the context-
    adjusted confidence (so inject's gate sees header/section/caption agreement), preserving segment
    pages/elem_ids/excel_rows. A FAILED numeric alignment is never rescued by context (stays 0)."""
    if al.get("method") == "failed" or not al.get("segments"):
        return al
    adj_conf, ctx = _context_adjust(al.get("confidence", 0.0), pdf_header, excel_header, section_text, sheet_name, cfg)
    base = al.get("confidence", 0.0) or 0.0
    factor = (adj_conf / base) if base > 0 else 1.0
    segs = [dict(s, confidence=round(min(1.0, max(0.0, s["confidence"] * factor)), 3)) for s in al["segments"]]
    out = dict(al); out["segments"] = segs; out["confidence"] = adj_conf; out["context"] = ctx
    return out


# ============================================================================
# GRID -> data-row anchors (shared shape for Excel [clean] and PDF [noisy])
# ============================================================================
def _anchor_cols(grid, numeric_pred=None):
    numeric_pred = numeric_pred or common.is_amount_cell
    cols = common.infer_amount_columns(grid)                  # header-based: works even if values are glyphed
    if "amount" not in cols:
        nc = max((len(r) for r in grid), default=0)
        counts = [sum(1 for r in grid if len(r) > c and numeric_pred(r[c])) for c in range(nc)]
        ac = common.pick_amount_column(grid, counts) if counts else None
        if ac is not None:
            cols["amount"] = ac
    return cols

def _row_anchor(row, cols):
    out = {}
    for role in ("qty", "rate", "amount"):
        c = cols.get(role)
        if c is not None and c < len(row):
            raw = row[c]
            out[role] = (common.parse_number(raw), str(raw if raw is not None else ""))
        else:
            out[role] = (None, "")
    return out

def grid_data_rows(grid, cols=None, numeric_pred=None):
    """(header_row_indices, [data_row_dicts], cols) for a table grid. A DATA row has a numeric anchor
    and is NOT a total/subtotal label; the header is everything before the first data row. Used for the
    clean Excel grid (strict default predicate) AND noisy PDF tombstone grids (pass numeric_pred=
    _pdf_numeric so glyph-mangled amount cells still count as data rows -> the matcher can score them, G1)."""
    numeric_pred = numeric_pred or common.is_amount_cell
    cols = cols or _anchor_cols(grid, numeric_pred)
    anchor_idx = [c for c in (cols.get("amount"), cols.get("rate"), cols.get("qty")) if c is not None]
    data = []
    for i, row in enumerate(grid):
        label = " ".join(str(row[k]) for k in range(len(row)) if k not in anchor_idx and str(row[k]).strip())
        if common.is_total_label(label) or common.is_subtotal_label(label):
            continue
        if any(c < len(row) and numeric_pred(row[c]) for c in anchor_idx):
            data.append({"grid_ix": i, "anchor": _row_anchor(row, cols)})
    header = list(range(data[0]["grid_ix"])) if data else list(range(len(grid)))
    return header, data, cols


# ============================================================================
# TOMBSTONES: find + group into logical tables
# ============================================================================
def find_tombstones(doc):
    """All tombstoned table elements in reading order, each annotated with its page_no."""
    out = []
    for pg in doc.get("pages", []):
        for e in pg.get("elements", []):
            if e.get("type") == "table" and (e.get("reconcile") or {}).get("tombstone"):
                out.append({"page": pg["page_no"], "element": e})
    out.sort(key=lambda t: (t["element"].get("reading_order_index", 0)))
    return out

def _col_signature(grid):
    return max((len(r) for r in grid), default=0)

def _ends_in_total(grid):
    """True if a grid's last non-empty row is a total/grand-total (=> COMPLETE, not a continuation),
    so two distinct same-header tables (each with its own Total) aren't merged into one group and an
    uploaded Excel sheet isn't spread across two unrelated tables. Delegates to common.ends_in_total
    (ONE definition, shared with the doc_layout cross-page stitch)."""
    return common.ends_in_total(grid)

def group_tombstones(tombstones, cfg=None):
    """Cluster per-page tombstones into LOGICAL tables: a table that CONTINUES onto the NEXT page
    (delta exactly 1), compatible column count (+-1, OCR-tolerant), no top-level section change. Two
    DISTINCT tombstones on the SAME page are kept as SEPARATE groups (FIX 1: the old `(0, 1)` merge
    conflated them and inject then overwrote one - each same-page table must reconcile independently).
    Does NOT merge bboxes (each page keeps its own element for injection). Returns [{group_id, members:[
    {page, element}]}]."""
    groups = []
    cur = None
    for t in tombstones:
        e = t["element"]
        sig = _col_signature(e.get("grid") or [])
        top = (e.get("section_path") or [None])[0]
        if cur is not None:
            pe = cur["members"][-1]
            same = (t["page"] - pe["page"] == 1                # ONLY the next page (never same page)
                    and abs(sig - cur["sig"]) <= 1
                    and (e.get("section_path") or [None])[0] == cur["top"]
                    and not _ends_in_total(pe["element"].get("grid") or []))  # prev complete -> distinct table
            if same:
                cur["members"].append(t); cur["sig"] = sig; continue
        cur = {"group_id": "g%d" % (len(groups) + 1), "members": [t], "sig": sig, "top": top}
        groups.append(cur)
    for g in groups:
        for t in g["members"]:
            t["element"]["reconcile"]["logical_group_id"] = g["group_id"]
        g.pop("sig", None); g.pop("top", None)
    return groups


# ============================================================================
# ALIGNMENT: anchor-then-segment (the core)
# ============================================================================
def _lis_indices(seq):
    """Indices of a longest strictly-increasing subsequence of seq (keeps order-consistent anchors)."""
    import bisect
    tails, prev, idx = [], [-1] * len(seq), []
    tail_ix = []
    for i, v in enumerate(seq):
        p = bisect.bisect_left([seq[j] for j in tail_ix], v)
        if p == len(tail_ix):
            prev[i] = tail_ix[-1] if tail_ix else -1
            tail_ix.append(i)
        else:
            prev[i] = tail_ix[p - 1] if p > 0 else -1
            tail_ix[p] = i
    res, k = [], (tail_ix[-1] if tail_ix else -1)
    while k != -1:
        res.append(k); k = prev[k]
    return res[::-1]

def align_sheet_to_group(excel_rows, pdf_rows, cfg=None):
    """Map clean Excel data rows (in order) onto noisy PDF tombstone rows spread across pages.
    excel_rows: [{grid_ix, anchor}]; pdf_rows: [{page, anchor, ...}] in reading order.
    Returns {method, n_anchors, row_to_page:[page per excel row], segments:[{excel_rows:[pos..], page,
    confidence}], confidence}. Strategy: confident DISTINCTIVE mutually-best anchors -> LIS for
    monotonicity -> fill gaps by proportional order -> derive per-page segments + confidence. Falls back
    to count/reading-order (confidence capped < gate) when too few anchors; refuses if counts diverge."""
    cfg = cfg
    E, P = len(excel_rows), len(pdf_rows)
    gate = _cfg(cfg, "reconcile_segment_conf_gate", 0.70)
    if E == 0 or P == 0:
        return {"method": "failed", "n_anchors": 0, "row_to_page": [], "segments": [], "confidence": 0.0}

    # best PDF row per Excel row + the score (for anchors AND for the confidence term)
    best_p, best_s = [-1] * E, [0.0] * E
    for i, er in enumerate(excel_rows):
        bi, bs = -1, -1.0
        for j, pr in enumerate(pdf_rows):
            s = _row_score(er["anchor"], pr["anchor"], cfg)
            if s > bs:
                bs, bi = s, j
        best_p[i], best_s[i] = bi, bs

    # distinctive amounts only (a value seen > max_dup times can't anchor)
    amt_key = lambda a: None if a["anchor"]["amount"][0] is None else round(a["anchor"]["amount"][0], 2)
    freq = {}
    for er in excel_rows:
        k = amt_key(er)
        if k is not None:
            freq[k] = freq.get(k, 0) + 1
    max_dup = _cfg(cfg, "reconcile_anchor_max_dup", 3)
    th = _cfg(cfg, "reconcile_anchor_th", 0.85)
    # mutual-best check
    pdf_best_for = {}
    for j, pr in enumerate(pdf_rows):
        bi, bs = -1, -1.0
        for i, er in enumerate(excel_rows):
            s = _row_score(er["anchor"], pr["anchor"], cfg)
            if s > bs:
                bs, bi = s, i
        pdf_best_for[j] = bi
    anchors = []   # (excel_pos, pdf_pos)
    for i in range(E):
        j = best_p[i]
        k = amt_key(excel_rows[i])
        if (best_s[i] >= th and j >= 0 and pdf_best_for.get(j) == i
                and k is not None and freq.get(k, 0) <= max_dup):
            anchors.append((i, j))
    # keep order-consistent anchors (LIS on pdf positions, excel already sorted)
    if anchors:
        keep = _lis_indices([j for _, j in anchors])
        anchors = [anchors[k] for k in keep]

    min_anchors = _cfg(cfg, "reconcile_min_anchors", 2)
    density = (len(anchors) / E) if E else 0.0
    slack = _cfg(cfg, "reconcile_gap_slack", 2)

    row_to_elem = [None] * E                     # FIX 1: track the target ELEMENT id per excel row (not just page)
    if len(anchors) < min_anchors or density < _cfg(cfg, "reconcile_min_anchor_density", 0.1):
        # FALLBACK: counts must reconcile, else refuse (wrong sheet/file)
        if abs(E - P) > slack:
            return {"method": "failed", "n_anchors": len(anchors), "row_to_page": [],
                    "segments": [], "confidence": 0.0}
        idxs = [min(int(round(i * (P - 1) / max(E - 1, 1))), P - 1) for i in range(E)]
        row_to_page = [pdf_rows[j]["page"] for j in idxs]
        row_to_elem = [pdf_rows[j].get("elem_id") for j in idxs]
        method, capped = "count_order", True
    else:
        # anchor-then-segment: map each excel pos to a pdf pos via the bracketing anchors, then page
        row_to_page = [None] * E
        aug = [(-1, -1)] + anchors + [(E, P)]    # sentinels at both ends
        for a in range(len(aug) - 1):
            (ea, pa), (eb, pb) = aug[a], aug[a + 1]
            for i in range(max(ea, 0), min(eb, E)):
                if eb == ea:
                    pj = pa
                else:
                    frac = (i - ea) / float(eb - ea)
                    pj = pa + frac * (pb - pa)
                pj = int(min(max(round(pj), 0), P - 1))
                row_to_page[i] = pdf_rows[pj]["page"]
                row_to_elem[i] = pdf_rows[pj].get("elem_id")
        method, capped = "anchor", False

    # segments = consecutive excel rows sharing a page
    segments, anchor_pos = [], {i for i, _ in anchors}
    i = 0
    while i < E:
        pg = row_to_page[i]
        seg_elem = row_to_elem[i]
        j = i
        while j + 1 < E and row_to_page[j + 1] == pg:
            j += 1
        rows = list(range(i, j + 1))
        n_anchor_in = sum(1 for r in rows if r in anchor_pos)
        pdf_on_page = sum(1 for pr in pdf_rows if pr["page"] == pg)
        cov = 1.0 - (abs(len(rows) - pdf_on_page) / max(len(rows), 1))
        mean_s = sum(best_s[r] for r in rows) / max(len(rows), 1)
        conf = 0.5 * (n_anchor_in / max(len(rows), 1)) + 0.3 * max(cov, 0.0) + 0.2 * mean_s
        if capped:
            conf = min(conf, gate - 0.01)
        segments.append({"excel_rows": rows, "page": pg, "elem_id": seg_elem, "confidence": round(conf, 3)})
        i = j + 1
    overall = round(sum(s["confidence"] * len(s["excel_rows"]) for s in segments) / max(E, 1), 3)
    return {"method": method, "n_anchors": len(anchors), "row_to_page": row_to_page,
            "segments": segments, "confidence": overall}


# ============================================================================
# EXCEL authority + GATES
# ============================================================================
def analyze_excel(path):
    if excel_extract is None:
        raise RuntimeError("excel_extract unavailable (needs openpyxl/xlrd)")
    return excel_extract._analyze(path)

def excel_sheet_rows(grid):
    """Clean Excel data rows in order -> (header_indices, [{grid_ix, anchor}], cols)."""
    header, data, cols = grid_data_rows(grid)
    return header, data, cols

def excel_is_trusted(an, sheet, n_pdf_rows, n_excel_rows, cfg=None):
    """GATES that must pass before an Excel sheet may overwrite PDF data (never garbage-in)."""
    reasons = []
    # (1) Excel's own tie-out: the sheet's verify_table is clean OR _analyze proved the chosen sheet
    grid = an.get("grids", {}).get(sheet) or []
    flags = common.verify_table(grid, None, flag_unverified=True)
    tie_ok = (not flags) or (an.get("tie", {}).get("passed") is True and an.get("sched") == sheet)
    if not tie_ok:
        reasons.append("excel sheet does not tie out (amounts present but not reconciled)")
    # (2) uncached formulas on this sheet -> would inject blanks
    if any((s == sheet) for (s, _coord) in (an.get("uncached") or [])):
        reasons.append("excel sheet has un-recalculated formula cells")
    # (3) count-reconcile
    if abs(n_excel_rows - n_pdf_rows) > _cfg(cfg, "reconcile_gap_slack", 2):
        reasons.append("row-count mismatch: excel %d vs pdf %d" % (n_excel_rows, n_pdf_rows))
    return (not reasons), reasons


# ============================================================================
# LINKING: Excel sheet <-> tombstone group
# ============================================================================
def _assign_global(sheets, gids, score):
    """FIX 4: GLOBAL best-match assignment maximizing the total score over (sheet x group), NOT greedy
    dict order. Uses scipy's Hungarian when importable, else a dependency-free global-best-first
    (all pairs sorted desc, take the highest, skip a used sheet/group). Only POSITIVE-score pairs are
    assigned (a 0/failed pair is left unlinked). Returns [(sheet, gid)]."""
    if not sheets or not gids:
        return []
    try:
        import numpy as _np
        from scipy.optimize import linear_sum_assignment
        M = _np.array([[float(score.get((s, g), 0.0)) for g in gids] for s in sheets], dtype=float)
        ri, cj = linear_sum_assignment(-M)                 # maximize
        return [(sheets[i], gids[j]) for i, j in zip(ri, cj) if M[i, j] > 0.0]
    except Exception:
        out, us, ug = [], set(), set()
        for s, g in sorted(((s, g) for s in sheets for g in gids),
                           key=lambda p: score.get(p, 0.0), reverse=True):
            if score.get((s, g), 0.0) <= 0.0:
                break
            if s in us or g in ug:
                continue
            us.add(s); ug.add(g); out.append((s, g))
        return out

def propose_links(groups, an, cfg=None, sheet_hint=None):
    """Link Excel sheets to tombstone groups by a GLOBAL best-match assignment (FIX 4 - not greedy dict
    order): score every (sheet x group) pair by numeric-anchor alignment (PRIMARY) folded with
    header/section/caption agreement (tie-breakers, FIX 2/3), then assign all sheets to their best
    overall groups together. sheet_hint forces a sheet->group_id (honoured before the global step).
    Returns [{sheet, group_id, trusted, trust_reasons, alignment, context}] for the assigned pairs."""
    grids = an.get("grids", {})
    # per-group: flattened pdf data rows (glyph-aware, carrying the source element id for FIX 1) + a
    # header/section signature for the tie-breaker.
    group_rows = {}; group_header = {}; group_section = {}
    for g in groups:
        rows = []
        for m in g["members"]:
            if (m["element"].get("reconcile") or {}).get("status") == "RECONCILED":
                continue                                       # G8: don't re-propose an already-reconciled table
            grid = m["element"].get("grid") or []
            _, data, _ = grid_data_rows(grid, numeric_pred=_pdf_numeric)   # G1: glyph-aware on the PDF side
            eid = m["element"].get("id")
            for d in data:
                rows.append({"page": m["page"], "elem_id": eid, "anchor": d["anchor"]})
        group_rows[g["group_id"]] = rows
        m0 = g["members"][0]["element"] if g["members"] else {}
        group_header[g["group_id"]] = _header_text(m0.get("grid") or [])
        group_section[g["group_id"]] = " > ".join(str(s) for s in (m0.get("section_path") or []))

    sheets = list(grids.keys())
    gids = [g["group_id"] for g in groups]
    excel_data = {s: grid_data_rows(grids[s])[1] for s in sheets}
    excel_header = {s: _header_text(grids[s]) for s in sheets}
    # score matrix + per-cell context-adjusted alignment
    score, align_cache = {}, {}
    for s in sheets:
        for gid in gids:
            al = align_sheet_to_group(excel_data[s], group_rows.get(gid, []), cfg)
            al = _apply_context(al, group_header.get(gid, ""), excel_header.get(s, ""),
                                group_section.get(gid, ""), s, cfg)               # FIX 2/3
            align_cache[(s, gid)] = al
            score[(s, gid)] = al.get("confidence", 0.0) if al.get("method") != "failed" else 0.0

    # ASSIGNMENT: honour sheet_hint first, then GLOBAL-optimal over the remainder.
    assigned, used_g = {}, set()
    if sheet_hint:
        for s, gid in sheet_hint.items():
            if s in grids and gid in gids and gid not in used_g:
                assigned[s] = gid; used_g.add(gid)
    free_s = [s for s in sheets if s not in assigned]
    free_g = [g for g in gids if g not in used_g]
    for s, gid in _assign_global(free_s, free_g, score):
        assigned[s] = gid

    links = []
    for s, gid in assigned.items():
        al = align_cache.get((s, gid)) or align_sheet_to_group(excel_data[s], group_rows.get(gid, []), cfg)
        trusted, treasons = excel_is_trusted(an, s, len(group_rows.get(gid, [])), len(excel_data[s]), cfg)
        links.append({"sheet": s, "group_id": gid, "trusted": trusted, "trust_reasons": treasons,
                      "alignment": al, "context": al.get("context")})
    return links


# ============================================================================
# SIDECAR (state) + run-level queue
# ============================================================================
def build_reconciliation(doc, layout_path, excel_paths, cfg=None, sheet_hint=None):
    """Build the per-document reconciliation sidecar (proposal). Pure: no mutation of the layout."""
    dkey = common.doc_key(doc.get("file", layout_path))
    tombstones = find_tombstones(doc)
    groups = group_tombstones(tombstones, cfg)
    sources = []
    for xp in excel_paths:
        an = analyze_excel(xp)
        links = propose_links(groups, an, cfg, sheet_hint)
        sources.append({
            "excel_path": str(xp), "excel_key": common.doc_key(xp),
            "tie_out": {"passed": an.get("tie", {}).get("passed"), "how": an.get("tie", {}).get("how")},
            "uncached": len(an.get("uncached") or []),
            "links": links,
        })
    n_resolvable = sum(1 for s in sources for l in s["links"]
                       if l["trusted"] and l["alignment"]["method"] != "failed"
                       and l["alignment"]["confidence"] >= _cfg(cfg, "reconcile_segment_conf_gate", 0.70))
    status = "NEEDS_RECONCILIATION" if sources else "PENDING"
    return {
        "schema": "reconcile/v1", "doc_key": dkey, "layout_path": str(layout_path),
        "status": status, "sources": sources,
        "tombstones": [{"tombstone_id": t["element"]["reconcile"]["tombstone_id"],
                        "page": t["page"], "element_id": t["element"].get("id"),
                        "section_path": t["element"].get("section_path")
                                        or t["element"]["reconcile"].get("section_path") or [],
                        "suggested_excel": t["element"]["reconcile"].get("suggested_excel"),
                        "logical_group_id": t["element"]["reconcile"].get("logical_group_id"),
                        "status": t["element"]["reconcile"].get("status", "PENDING"),
                        "n_data_rows": t["element"]["reconcile"].get("n_data_rows")}
                       for t in tombstones],
        "approval": {"approved_by": None, "approved_at": None, "decision": None},
        "n_resolvable": n_resolvable, "history": [], "version": 1,
    }

def queue_row(sidecar):
    n_t = len(sidecar.get("tombstones", []))
    n_done = sum(1 for t in sidecar.get("tombstones", []) if t.get("status") == "RECONCILED")
    confs = [l["alignment"]["confidence"] for s in sidecar.get("sources", []) for l in s.get("links", [])]
    methods = {l["alignment"]["method"] for s in sidecar.get("sources", []) for l in s.get("links", [])}
    reasons = "; ".join(r for s in sidecar.get("sources", []) for l in s.get("links", [])
                        for r in l.get("trust_reasons", []))
    return {"doc_key": sidecar["doc_key"], "stem": Path(sidecar["layout_path"]).stem.replace(".layout", ""),
            "status": sidecar["status"], "n_tombstones": n_t, "n_reconciled": n_done,
            "best_confidence": max(confs) if confs else "", "method": ",".join(sorted(methods)),
            "sources": ",".join(Path(s["excel_path"]).name for s in sidecar.get("sources", [])),
            "reasons": reasons}


# ============================================================================
# INJECTION (idempotent, atomic, auditable)
# ============================================================================
def _norm_grid(grid):
    """Raw cell values with a None->'' normalization ONLY. The reconciled grid lands in layout.json
    (JSON) and the .md deliverable (Markdown) - neither needs HTML escaping, and html.escape here
    corrupted the authoritative Excel data ('Excavation & filling' -> '...&amp;...'). Store verbatim."""
    return [[("" if c is None else str(c)) for c in row] for row in grid]

def inject(layout_path, sidecar, cfg=None, *, dry_run=True, approved_by=None, force=False):
    """Apply the approved Excel overrides into layout.json. Idempotent + atomic + auditable: sets
    `reconciled_grid` + keeps `reconcile.original_grid` (once) + provenance + bumps version on each member
    tombstone, NEVER deletes the tombstone, then re-verifies, re-runs completeness, and rewrites the
    layout/sidecar atomically. dry_run=True validates + returns the plan without mutating. A member that
    is ALREADY `RECONCILED` is skipped (a re-apply is a true no-op - no version churn) unless force=True
    (re-do with a corrected Excel)."""
    layout_path = Path(layout_path)
    doc = json.loads(layout_path.read_text(encoding="utf-8"))
    # RE-DERIVE the logical groups on the freshly-loaded doc so the group ids match EXACTLY what
    # propose_links used (group_tombstones is deterministic on the same layout). The old code keyed on the
    # on-disk logical_group_id set provisionally by _tag_reconcilable_tables, which diverges from the
    # link ids whenever group_tombstones merges pages -> members were then lost. group_tombstones stamps
    # the consistent id back onto each element too.
    tomb_by_group = {g["group_id"]: g["members"] for g in group_tombstones(find_tombstones(doc), cfg)}
    gate = _cfg(cfg, "reconcile_segment_conf_gate", 0.70)
    plan, injected = [], 0
    for src in sidecar.get("sources", []):
        an = analyze_excel(src["excel_path"]) if not dry_run else None
        for link in src.get("links", []):
            al = link["alignment"]
            ok = (link["trusted"] and al["method"] != "failed"
                  and al["confidence"] >= gate and all(s["confidence"] >= gate for s in al["segments"]))
            plan.append({"sheet": link["sheet"], "group_id": link["group_id"], "eligible": ok,
                         "confidence": al["confidence"], "method": al["method"], "trusted": link["trusted"]})
            if dry_run or not ok:
                continue
            members = sorted(tomb_by_group.get(link["group_id"], []), key=lambda t: t["page"])
            by_elem = {m["element"].get("id"): m["element"] for m in members}   # FIX 1: key by unique element id
            page_to_member = {m["page"]: m["element"] for m in members}         # fallback for sidecars w/o elem_id
            grid = an["grids"].get(link["sheet"]) or []
            header, edata, _ = grid_data_rows(grid)
            header_rows = [grid[i] for i in header]
            for seg in al["segments"]:
                el = by_elem.get(seg.get("elem_id")) or page_to_member.get(seg["page"])   # FIX 1: id first
                if el is None:
                    continue
                if (el.get("reconcile") or {}).get("status") == "RECONCILED" and not force:
                    continue                                 # G8: already reconciled -> no-op (no churn)
                # slice a CONTIGUOUS grid-row span (data rows + the total/subtotal/blank rows that sit
                # with them) so totals are never dropped; the trailing total lands on the last segment.
                pos = [p for p in seg["excel_rows"] if p < len(edata)]
                if not pos:
                    continue
                start_gi = edata[pos[0]]["grid_ix"]
                end_gi = (edata[pos[-1] + 1]["grid_ix"] - 1) if pos[-1] + 1 < len(edata) else (len(grid) - 1)
                sliced = header_rows + grid[start_gi:end_gi + 1]      # header repeated per page (reads as a table)
                el["reconciled_grid"] = _norm_grid(sliced)
                rec = el.setdefault("reconcile", {})
                rec.setdefault("original_grid", el.get("grid"))      # retain garbage ONCE (idempotent)
                rec["status"] = "RECONCILED"
                rec["version"] = rec.get("version", 0) + 1
                rec["provenance"] = {"excel_key": src["excel_key"], "sheet": link["sheet"],
                                     "excel_rows": [seg["excel_rows"][0], seg["excel_rows"][-1]] if seg["excel_rows"] else [],
                                     "method": al["method"], "confidence": seg["confidence"], "by": approved_by}
                el["tieout_flags"] = common.verify_table([[str(c) for c in r] for r in sliced], cfg)
                injected += 1
    if dry_run:
        return {"dry_run": True, "plan": plan, "would_inject": sum(1 for p in plan if p["eligible"])}
    if injected == 0:                                        # G8: nothing changed -> no file/version churn
        return {"dry_run": False, "injected": 0, "noop": True, "status": doc.get("status"), "plan": plan}

    # recompute completeness over the (now partly reconciled) tables + atomic write
    tieout_gaps = sum(len(e.get("tieout_flags") or []) for pg in doc["pages"]
                      for e in pg.get("elements", []) if e.get("type") == "table")
    for pg in doc["pages"]:                                  # clear resolved tie-out review reasons
        reasons = [r for r in pg.get("review_reasons", [])
                   if "tie-out" not in r and "NOT verified" not in r] if pg.get("review_reasons") else []
        for e in pg.get("elements", []):
            if e.get("type") == "table" and e.get("tieout_flags") and (e.get("reconcile") or {}).get("status") != "RECONCILED":
                reasons.append("table tie-out / arithmetic flag(s)")
        if "review_reasons" in pg:
            pg["review_reasons"] = reasons; pg["needs_review"] = bool(reasons)
    comp = doc.get("completeness", {})
    status, creasons = common.completeness_status(
        sig_orphans=comp.get("sig_orphans", 0), tieout_gaps=tieout_gaps,
        dropped_pages=comp.get("scanned_pages_pending_ocr", 0), errored_pages=comp.get("errored_pages", 0))
    doc["status"] = status
    doc["completeness"] = {**comp, "status": status, "reasons": creasons, "tieout_gaps": tieout_gaps}
    common.atomic_write_text(layout_path, json.dumps(doc, indent=2, ensure_ascii=False, default=str))
    # G3: re-render the .md deliverable so it shows the reconciled grid + provenance (not the stale noisy
    # table written at extraction time). Best-effort: needs doc_layout (fitz); layout.json stays the truth.
    try:
        import doc_layout as _DL
        _DL._write_markdown(doc, layout_path.with_name(layout_path.name.replace(".layout.json", ".md")),
                            layout_path.parent / "figures")
    except Exception:
        pass
    # mark sidecar tombstones RECONCILED + bump version/history
    done_groups = {p["group_id"] for p in plan if p["eligible"]}
    for t in sidecar.get("tombstones", []):
        if t.get("logical_group_id") in done_groups:
            t["status"] = "RECONCILED"
    sidecar["status"] = "RECONCILED" if all(t["status"] == "RECONCILED" for t in sidecar.get("tombstones", [])) else "NEEDS_RECONCILIATION"
    sidecar["version"] = sidecar.get("version", 1) + 1
    sidecar.setdefault("history", []).append({"action": "injected", "by": approved_by, "version": sidecar["version"]})
    common.atomic_write_text(layout_path.with_name(layout_path.name.replace(".layout.json", ".reconcile.json")),
                             json.dumps(sidecar, indent=2, ensure_ascii=False, default=str))
    common.mark_done(layout_path.parent)
    return {"dry_run": False, "injected": injected, "status": doc["status"], "plan": plan}


def refresh_review(out_root, cfg=None):
    """Rebuild the run-level reconcile_queue.csv from every <stem>.reconcile.json sidecar under out_root."""
    rows = []
    for sc in Path(out_root).rglob("*.reconcile.json"):
        try:
            rows.append(queue_row(json.loads(sc.read_text(encoding="utf-8"))))
        except Exception:
            continue
    return common.write_reconcile_queue(rows, out_root)


def mark_tombstone(doc, element_ids, cfg=None):
    """G7: manually mark specific table element(s) as tombstones (for a table that OCR'd at high
    confidence but WRONG and carries no tie-out flag, so auto-tagging missed it). Returns #marked."""
    ids = set(element_ids); n = 0
    for pg in doc.get("pages", []):
        for e in pg.get("elements", []):
            if e.get("type") == "table" and e.get("id") in ids and not (e.get("reconcile") or {}).get("tombstone"):
                grid = e.get("grid") or []
                cols = _anchor_cols(grid)
                counts = common.numeric_col_counts(grid)
                e["reconcile"] = {"tombstone": True, "tombstone_id": "%s:%s" % (common.doc_key(doc.get("file", "")), e.get("id")),
                                  "reason": "manual", "page_conf": pg.get("page_conf"),
                                  "n_data_rows": sum(1 for r in grid if any(str(c or "").strip() for c in r)),
                                  "amount_col_index": common.pick_amount_column(grid, counts) if counts else None,
                                  "anchor_columns": cols, "logical_group_id": None, "status": "PENDING", "version": 0}
                n += 1
    return n


# ============================================================================
# CLI
# ============================================================================
def main():
    ap = argparse.ArgumentParser(description="Reconcile noisy PDF table tombstones against an authoritative Excel.")
    ap.add_argument("--layout", required=True, help="path to a <stem>.layout.json produced by doc_layout --reconcile-tables")
    ap.add_argument("--excel", default=None, help="authoritative Excel file(s), comma-separated (omit when only --mark'ing)")
    ap.add_argument("--sheet", default=None, help='optional forced map "SheetName=g1,Other=g2"')
    ap.add_argument("--apply", action="store_true", help="inject the approved alignment (default = dry run, no mutation)")
    ap.add_argument("--force", action="store_true", help="re-inject a table already RECONCILED (e.g. a corrected Excel)")
    ap.add_argument("--mark", default=None, help="comma-separated table element id(s) to manually tombstone (G7), then exit")
    ap.add_argument("--out", default=None, help="run root for reconcile_queue.csv (default: layout's parent)")
    ap.add_argument("--by", default="cli", help="approver id recorded in provenance/history")
    a = ap.parse_args()

    layout_path = Path(a.layout)
    doc = json.loads(layout_path.read_text(encoding="utf-8"))
    if a.mark:                                               # G7: manual-tombstone mode (no Excel needed)
        n = mark_tombstone(doc, [x.strip() for x in a.mark.split(",") if x.strip()])
        common.atomic_write_text(layout_path, json.dumps(doc, indent=2, ensure_ascii=False, default=str))
        print("[mark] tombstoned %d table(s); now reconcile with --excel" % n); return
    if not a.excel:
        ap.error("--excel is required (unless --mark)")
    excel_paths = [p.strip() for p in a.excel.split(",") if p.strip()]
    sheet_hint = None
    if a.sheet:
        sheet_hint = {kv.split("=")[0].strip(): kv.split("=")[1].strip() for kv in a.sheet.split(",") if "=" in kv}
    cfg = common.ExtractConfig()
    sidecar = build_reconciliation(doc, layout_path, excel_paths, cfg, sheet_hint)
    sidecar_path = layout_path.with_name(layout_path.name.replace(".layout.json", ".reconcile.json"))
    common.atomic_write_text(sidecar_path, json.dumps(sidecar, indent=2, ensure_ascii=False, default=str))

    if a.apply:
        sidecar["approval"] = {"approved_by": a.by, "approved_at": "applied", "decision": "approved"}
        res = inject(layout_path, sidecar, cfg, dry_run=False, approved_by=a.by, force=a.force)
        print("[apply] injected %d table-page(s)%s; doc status=%s" % (
            res["injected"], " (no-op)" if res.get("noop") else "", res["status"]))
    else:
        res = inject(layout_path, sidecar, cfg, dry_run=True)
        print("[dry-run] %d eligible alignment(s); proposals -> %s" % (res["would_inject"], sidecar_path.name))
        for p in res["plan"]:
            print("   %s -> %s : %s (conf=%.2f, %s)" % (p["sheet"], p["group_id"],
                  "INJECT" if p["eligible"] else "hold", p["confidence"], p["method"]))
    n = refresh_review(a.out or layout_path.parent, cfg)
    print("[reconcile_queue] %d doc(s) -> %s" % (n, (Path(a.out or layout_path.parent) / "reconcile_queue.csv")))


if __name__ == "__main__":
    main()
