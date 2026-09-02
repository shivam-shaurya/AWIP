#!/usr/bin/env python3
r"""
table_metrics.py - ground-truth table-accuracy metrics for kb-extract-rig.

WHY THIS EXISTS
    The rig's whole thesis is "tables, completeness-guaranteed", yet until now the
    ONLY table signal was the arithmetic tie-out - an *internal consistency* proxy,
    not accuracy-vs-truth. A table can tie out and still be wrong (transposed column,
    merged-row value, mis-OCR'd digit that happens to reconcile). This module scores a
    predicted grid against a GOLD grid so we can report real numbers per the targets
    (PDF >=95%, Excel 100%, ...).

WHAT IT MEASURES (all on list[list[str]] grids; None/"" == empty cell)
    - cell_content_pr   : alignment-FREE multiset precision/recall/F1 of non-empty
                          normalised cell values. Robust to row/col shifts. This is the
                          headline "did we capture the right values" number.
    - cell_positional   : precision/recall/F1 where a cell counts only if it matches at
                          the SAME (row, col). Catches transposition/misplacement that
                          the bag metric forgives. (The gap between the two localises
                          "right values, wrong place" errors - exactly the merged/
                          spanning-cell failure mode the reviewers flagged.)
    - row_accuracy      : fraction of GOLD rows whose full normalised content is present
                          as some predicted row (order-insensitive within the row).
    - col_accuracy      : same, per column.
    - header_accuracy   : row_0 cell match rate (headers drive downstream semantics).
    - shape             : exact (nrows,ncols) match + within-1 tolerance.
    - grids_score (TEDS-lite): 1 - normalised cell edit distance over the aligned grid;
                          a single 0..1 structural+content similarity per table.

NUMERIC TOLERANCE
    Cells compare via common.parse_number when both sides look numeric, so
    "2,61,14,64,676" == "2611464676" == "26,11,46,476.00" (indian/rounding tolerant).
    Text compares on a lower/space-collapsed normal form.

USAGE
    from eval.table_metrics import score_table, score_tables
    m = score_table(pred_grid, gold_grid)          # one table -> dict of metrics
    agg = score_tables([(pred, gold), ...])         # many -> micro-averaged dict

    CLI (score a predicted layout.json / tables.xlsx-derived json vs a gold json):
    python eval/table_metrics.py --pred pred_tables.json --gold gold_tables.json
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any, Optional

# --- reuse the rig's single number parser so tolerance matches production ---------
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
try:
    from common import parse_number  # type: ignore
except Exception:                    # pragma: no cover - harness must run standalone
    def parse_number(s: Any) -> Optional[float]:
        if s is None:
            return None
        try:
            return float(str(s).replace(",", "").strip())
        except Exception:
            return None

Grid = list[list[Any]]

# relative tolerance for "numbers are equal" (0.5% - covers rounding/paisa noise but
# not a real digit slip). Overridable per call.
DEFAULT_NUM_RTOL = 0.005


# --------------------------------------------------------------------------- normalise
def norm_text(v: Any) -> str:
    """Lower/space-collapsed normal form for a non-numeric cell."""
    if v is None:
        return ""
    return " ".join(str(v).strip().lower().split())


def cell_equal(a: Any, b: Any, num_rtol: float = DEFAULT_NUM_RTOL) -> bool:
    """True if two cells are equal, numeric-tolerant when both parse as numbers."""
    na, nb = parse_number(a), parse_number(b)
    if na is not None and nb is not None:
        if na == nb:
            return True
        scale = max(abs(na), abs(nb), 1.0)
        return abs(na - nb) <= num_rtol * scale
    return norm_text(a) == norm_text(b)


def _nonempty_cells(grid: Grid) -> list[Any]:
    return [c for row in grid for c in row if norm_text(c) != ""]


# --------------------------------------------------------------------------- multiset PR
def _multiset_pr(pred_vals: list[Any], gold_vals: list[Any],
                 num_rtol: float) -> tuple[float, float, float, int]:
    """Alignment-free precision/recall/F1 over cell VALUES (numeric-tolerant).

    Greedy multiset match: each gold value can be consumed once. O(P*G) - fine for
    tables (hundreds of cells). Returns (precision, recall, f1, true_positives).
    """
    remaining = list(gold_vals)
    tp = 0
    for pv in pred_vals:
        for i, gv in enumerate(remaining):
            if cell_equal(pv, gv, num_rtol):
                tp += 1
                remaining.pop(i)
                break
    p = tp / len(pred_vals) if pred_vals else (1.0 if not gold_vals else 0.0)
    r = tp / len(gold_vals) if gold_vals else (1.0 if not pred_vals else 0.0)
    f1 = (2 * p * r / (p + r)) if (p + r) else 0.0
    return p, r, f1, tp


# --------------------------------------------------------------------------- positional
def _positional_pr(pred: Grid, gold: Grid, num_rtol: float) -> tuple[float, float, float]:
    rows = max(len(pred), len(gold))
    pred_ne = _count_nonempty(pred)
    gold_ne = _count_nonempty(gold)
    match = 0
    for i in range(rows):
        pr = pred[i] if i < len(pred) else []
        gr = gold[i] if i < len(gold) else []
        cols = max(len(pr), len(gr))
        for j in range(cols):
            pv = pr[j] if j < len(pr) else None
            gv = gr[j] if j < len(gr) else None
            if norm_text(gv) == "" and norm_text(pv) == "":
                continue
            if norm_text(pv) != "" and cell_equal(pv, gv, num_rtol):
                match += 1
    p = match / pred_ne if pred_ne else (1.0 if not gold_ne else 0.0)
    r = match / gold_ne if gold_ne else (1.0 if not pred_ne else 0.0)
    f1 = (2 * p * r / (p + r)) if (p + r) else 0.0
    return p, r, f1


def _count_nonempty(grid: Grid) -> int:
    return sum(1 for row in grid for c in row if norm_text(c) != "")


# --------------------------------------------------------------------------- row / col
def _line_key(cells: list[Any]) -> tuple:
    """Order-insensitive multiset key of a row/col's non-empty normalised values.

    Numbers are keyed by rounded value so numeric-equal cells collapse together."""
    key = []
    for c in cells:
        n = parse_number(c)
        key.append(("n", round(n, 2)) if n is not None else ("t", norm_text(c)))
    key = [k for k in key if k != ("t", "")]
    return tuple(sorted(key))


def _line_accuracy(pred_lines: list[list[Any]], gold_lines: list[list[Any]]) -> float:
    if not gold_lines:
        return 1.0 if not pred_lines else 0.0
    pred_keys: dict[tuple, int] = {}
    for ln in pred_lines:
        pred_keys[_line_key(ln)] = pred_keys.get(_line_key(ln), 0) + 1
    hit = 0
    for ln in gold_lines:
        k = _line_key(ln)
        if pred_keys.get(k, 0) > 0:
            pred_keys[k] -= 1
            hit += 1
    return hit / len(gold_lines)


def _cols(grid: Grid) -> list[list[Any]]:
    if not grid:
        return []
    ncols = max((len(r) for r in grid), default=0)
    return [[(r[j] if j < len(r) else None) for r in grid] for j in range(ncols)]


# --------------------------------------------------------------------------- TEDS-lite
def _teds_lite(pred: Grid, gold: Grid, num_rtol: float) -> float:
    """Structural+content similarity in [0,1]: 1 - editcells / total_cells over the
    union grid. Not the full APTED tree distance, but monotone with it for the grid
    shapes this rig produces, and dependency-free."""
    rows = max(len(pred), len(gold))
    total = 0
    edits = 0
    for i in range(rows):
        pr = pred[i] if i < len(pred) else []
        gr = gold[i] if i < len(gold) else []
        cols = max(len(pr), len(gr))
        for j in range(cols):
            pv = pr[j] if j < len(pr) else None
            gv = gr[j] if j < len(gr) else None
            if norm_text(pv) == "" and norm_text(gv) == "":
                continue
            total += 1
            if not cell_equal(pv, gv, num_rtol):
                edits += 1
    return 1.0 - (edits / total) if total else 1.0


# --------------------------------------------------------------------------- public API
@dataclass
class TableScore:
    n_gold_cells: int
    n_pred_cells: int
    content_precision: float
    content_recall: float
    content_f1: float
    positional_precision: float
    positional_recall: float
    positional_f1: float
    row_accuracy: float
    col_accuracy: float
    header_accuracy: float
    shape_exact: bool
    shape_within1: bool
    teds_lite: float
    # gap between content and positional recall => "captured value, wrong place"
    misplacement: float = field(default=0.0)

    def as_dict(self) -> dict:
        return asdict(self)


def score_table(pred: Grid, gold: Grid, num_rtol: float = DEFAULT_NUM_RTOL) -> TableScore:
    pred = [list(r) for r in (pred or [])]
    gold = [list(r) for r in (gold or [])]
    cp, cr, cf, _ = _multiset_pr(_nonempty_cells(pred), _nonempty_cells(gold), num_rtol)
    pp, pr_, pf = _positional_pr(pred, gold, num_rtol)
    row_acc = _line_accuracy(pred, gold)
    col_acc = _line_accuracy(_cols(pred), _cols(gold))
    hdr = _positional_pr([pred[0]] if pred else [], [gold[0]] if gold else [], num_rtol)[2]
    shp_exact = (len(pred) == len(gold)
                 and max((len(r) for r in pred), default=0) == max((len(r) for r in gold), default=0))
    shp_w1 = (abs(len(pred) - len(gold)) <= 1
              and abs(max((len(r) for r in pred), default=0) - max((len(r) for r in gold), default=0)) <= 1)
    return TableScore(
        n_gold_cells=_count_nonempty(gold),
        n_pred_cells=_count_nonempty(pred),
        content_precision=round(cp, 4), content_recall=round(cr, 4), content_f1=round(cf, 4),
        positional_precision=round(pp, 4), positional_recall=round(pr_, 4), positional_f1=round(pf, 4),
        row_accuracy=round(row_acc, 4), col_accuracy=round(col_acc, 4),
        header_accuracy=round(hdr, 4),
        shape_exact=shp_exact, shape_within1=shp_w1,
        teds_lite=round(_teds_lite(pred, gold, num_rtol), 4),
        misplacement=round(max(0.0, cr - pr_), 4),
    )


def score_tables(pairs: list[tuple[Grid, Grid]],
                 num_rtol: float = DEFAULT_NUM_RTOL) -> dict:
    """Micro-average across many (pred, gold) pairs, weighted by gold cell count."""
    scores = [score_table(p, g, num_rtol) for p, g in pairs]
    if not scores:
        return {"n_tables": 0}
    tot = sum(s.n_gold_cells for s in scores) or 1
    def w(attr):  # cell-weighted mean
        return round(sum(getattr(s, attr) * (s.n_gold_cells or 1) for s in scores) / tot, 4)
    def m(attr):  # simple mean
        return round(sum(getattr(s, attr) for s in scores) / len(scores), 4)
    return {
        "n_tables": len(scores),
        "n_gold_cells": tot,
        "content_f1": w("content_f1"),
        "content_recall": w("content_recall"),
        "content_precision": w("content_precision"),
        "positional_f1": w("positional_f1"),
        "row_accuracy": m("row_accuracy"),
        "col_accuracy": m("col_accuracy"),
        "header_accuracy": m("header_accuracy"),
        "teds_lite": w("teds_lite"),
        "misplacement": w("misplacement"),
        "shape_exact_rate": round(sum(1 for s in scores if s.shape_exact) / len(scores), 4),
        "per_table": [s.as_dict() for s in scores],
    }


# --------------------------------------------------------------------------- CLI
def tables_from_layout(data: dict) -> list[Grid]:
    """Extract table grids from a doc_layout `layout.json`.

    SCHEMA (verified against real output): doc_layout nests elements under
    `pages[].elements[]`; the top-level `elements` shape is only produced by other
    paths. Handle both so the metric works on real production output."""
    grids: list[Grid] = []
    if isinstance(data.get("pages"), list):
        for pg in data["pages"]:
            for e in pg.get("elements", []) or []:
                if e.get("type") == "table" and e.get("grid"):
                    grids.append(e["grid"])
    if not grids and isinstance(data.get("elements"), list):
        grids = [e.get("grid", []) for e in data["elements"]
                 if e.get("type") == "table" and e.get("grid")]
    return grids


def _load_grids(path: Path) -> list[Grid]:
    """Accept a bare list-of-grids json, a {"tables":[{"grid":[[...]]}]}, or a layout.json."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and "tables" in data:
        return [t.get("grid", t) for t in data["tables"]]
    if isinstance(data, dict) and ("pages" in data or "elements" in data):
        return tables_from_layout(data)
    return data  # assume list[grid]


def main() -> None:
    ap = argparse.ArgumentParser(description="Score predicted tables against a gold set.")
    ap.add_argument("--pred", required=True, help="predicted tables json (list of grids, or layout.json)")
    ap.add_argument("--gold", required=True, help="gold tables json (list of grids)")
    ap.add_argument("--rtol", type=float, default=DEFAULT_NUM_RTOL, help="numeric relative tolerance")
    ap.add_argument("--out", default="", help="optional: write full json report here")
    a = ap.parse_args()
    preds, golds = _load_grids(Path(a.pred)), _load_grids(Path(a.gold))
    n = min(len(preds), len(golds))
    if len(preds) != len(golds):
        print(f"[warn] table count differs: pred={len(preds)} gold={len(golds)} -> scoring first {n} by order")
    agg = score_tables(list(zip(preds[:n], golds[:n])), a.rtol)
    summary = {k: v for k, v in agg.items() if k != "per_table"}
    print(json.dumps(summary, indent=2))
    if a.out:
        Path(a.out).write_text(json.dumps(agg, indent=2), encoding="utf-8")
        print(f"[ok] full report -> {a.out}")


if __name__ == "__main__":
    main()
