#!/usr/bin/env python3
r"""
robust_tables.py - completeness-guaranteed table reconstruction for digital PDFs.

CORE IDEA (no heuristic table-detector can silently drop a row):
  1 read the page's REAL geometry - every word with exact coords (extract_words)
    and the actual ruling lines from vector edges (page.edges).
  2 RULED tables: build the grid from real rule coordinates; place EVERY word into
    the cell that contains it. A row physically cannot be dropped because we are
    placing words, not detecting tables.
  3 BORDERLESS tables (pdfplumber finds NONE of these): reconstruct rows by y-banding
    word baselines and columns by global x-clustering.
  4 COMPLETENESS AUDIT: every word on the page must end up in a cell OR be classified
    as out-of-table text; any in-table-region word left over is FLAGGED as a possible
    dropped row, with its text and position. This is the runtime 100% guarantee.

General, not hardcoded. This module is the extraction core; the file-level driver,
OCR fallback and arithmetic verify live in table_pdf.py.
"""
import re
import pdfplumber
import common                      # leaf module (imports nothing from the rig) - no cycle

def _count_numbers(text):
    return len(re.findall(r"-?\d[\d,]*\.?\d*", text))

# --------------------------------------------------------------- geometry
def _cluster(vals, tol):
    vals = sorted(vals)
    if not vals: return []
    groups = [[vals[0]]]
    for v in vals[1:]:
        if v - groups[-1][-1] <= tol: groups[-1].append(v)
        else: groups.append([v])
    return [sum(g) / len(g) for g in groups]

def _edges(page):
    """Horizontal edges as (x0, x1, y) and vertical edges as (x, y0, y1), keeping
    full extents so we can segment a page into SEPARATE tables."""
    H, V = [], []
    for e in page.edges:
        if abs(e["top"] - e["bottom"]) <= 1 and abs(e["x1"] - e["x0"]) > 3:
            H.append((min(e["x0"], e["x1"]), max(e["x0"], e["x1"]), (e["top"] + e["bottom"]) / 2))
        elif abs(e["x1"] - e["x0"]) <= 1 and abs(e["bottom"] - e["top"]) > 3:
            V.append(((e["x0"] + e["x1"]) / 2, min(e["top"], e["bottom"]), max(e["top"], e["bottom"])))
    return H, V

def table_regions(H, V):
    """Segment a page into tables by VERTICAL GAPS: a table is a run of horizontal
    rules with normal row spacing; a gap much larger than the typical row height marks
    a boundary between two separate tables. Each table's columns are the vertical rules
    that span its y-range. This neither merges distinct tables nor over-fragments a
    single one (connected-components splits a table whenever a rule doesn't quite touch).
    Returns [(H_ys, V_xs), ...] top-to-bottom."""
    if not H: return []
    ys = _cluster([h[2] for h in H], 3)
    if len(ys) < 2: return []
    gaps = sorted(ys[i + 1] - ys[i] for i in range(len(ys) - 1))
    med = gaps[len(gaps) // 2] if gaps else 20
    thr = max(2.5 * med, 28)                    # a gap > this => separate table
    segs = [[ys[0]]]
    for i in range(1, len(ys)):
        (segs[-1].append(ys[i]) if ys[i] - ys[i - 1] <= thr else segs.append([ys[i]]))
    regions = []
    for seg in segs:
        if len(seg) < 2: continue
        y0, y1 = seg[0], seg[-1]
        V_xs = _cluster([v[0] for v in V if v[2] >= y0 - 3 and v[1] <= y1 + 3], 3)
        if len(V_xs) >= 2:
            regions.append((seg, V_xs))
    return regions

def _band(pos, lines):
    """Index of the band [lines[i], lines[i+1]) containing pos, else None."""
    for i in range(len(lines) - 1):
        if lines[i] - 0.1 <= pos < lines[i + 1] + 0.1:
            return i
    return None

# --------------------------------------------------------------- ruled grid
def _assemble(cells, nrows, ncols):
    grid = [["" for _ in range(ncols)] for _ in range(nrows)]
    for (r, c), ws in cells.items():
        ws.sort(key=lambda w: (round(w["top"]), w["x0"]))
        grid[r][c] = " ".join(w["text"] for w in ws).strip()
    return grid

def ruled_table(words, H, V):
    """Place every word into its (row, col) cell defined by the real rules.
    Returns (grid, placed_word_ids, bbox)."""
    nrows, ncols = len(H) - 1, len(V) - 1
    cells, placed = {}, set()
    x0, x1, y0, y1 = V[0], V[-1], H[0], H[-1]
    for idx, w in enumerate(words):
        cx, cy = (w["x0"] + w["x1"]) / 2, (w["top"] + w["bottom"]) / 2
        if not (x0 - 0.1 <= cx <= x1 + 0.1 and y0 - 0.1 <= cy <= y1 + 0.1):
            continue
        r, c = _band(cy, H), _band(cx, V)
        if r is None or c is None:
            continue
        cells.setdefault((r, c), []).append(w); placed.add(idx)
    return _assemble(cells, nrows, ncols), placed, (x0, y0, x1, y1)

# --------------------------------------------------------------- borderless
def _column_bounds(words, min_gap):
    """Column separators = vertical whitespace gaps that no word crosses (projected
    over ALL rows). Far more robust than clustering edges - multi-word cells stay one
    column, real column gaps become boundaries."""
    spans = sorted((w["x0"], w["x1"]) for w in words)
    merged = []
    for a, b in spans:
        if merged and a <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append([a, b])
    bounds = [-1e9]
    for (a, b), (c, d) in zip(merged, merged[1:]):
        if c - b >= min_gap:
            bounds.append((b + c) / 2)
    bounds.append(1e9)
    return bounds

def borderless_table(words, row_tol_frac=0.6):
    """No ruling lines: rows by y-banding of baselines, columns by vertical whitespace
    gaps. Every word is placed -> complete by construction. Returns (grid, placed_ids, n_merges)."""
    if not words: return [], set(), 0
    heights = sorted(w["bottom"] - w["top"] for w in words)
    mh = heights[len(heights) // 2] or 10
    rtol = max(3.0, row_tol_frac * mh)
    rows = []
    for i in sorted(range(len(words)), key=lambda i: words[i]["top"]):
        wd = words[i]; cy = (wd["top"] + wd["bottom"]) / 2
        for row in rows:
            if abs(cy - row["cy"]) <= rtol:
                row["items"].append((i, wd))
                row["cy"] = sum((words[j]["top"] + words[j]["bottom"]) / 2 for j, _ in row["items"]) / len(row["items"]); break
        else:
            rows.append({"cy": cy, "items": [(i, wd)]})
    rows.sort(key=lambda r: r["cy"])
    bounds = _column_bounds(words, min_gap=max(8.0, 1.2 * mh))
    ncols = len(bounds) - 1
    def colof(x):
        for j in range(ncols):
            if bounds[j] <= x < bounds[j + 1]: return j
        return ncols - 1
    grid, placed, merges = [], set(), 0
    for row in rows:
        cells = {}
        for idx, wd in row["items"]:
            cells.setdefault(colof(wd["x0"]), []).append(wd); placed.add(idx)
        line = [""] * ncols
        for c, ws in cells.items():
            ws.sort(key=lambda w: w["x0"]); line[c] = " ".join(w["text"] for w in ws)
        grid.append(line)
        # MERGE DETECTOR (1.5): when two rows set closer than the y-band tolerance collapse into
        # one grid row, each numeric column ends up holding BOTH rows' numbers ('100 200') - and
        # parse_number then silently keeps only the first. The orphan audit can't see it (every word
        # is 'placed'). A real merge doubles the numbers in MULTIPLE cells, so flag a row with >=2
        # cells each holding 2+ numbers (a single wrapped description cell has <=1 number, so it is
        # NOT mistaken for a merge). Reported as a review signal, never a silent drop.
        if sum(1 for cell in line if _count_numbers(cell) >= 2) >= 2:
            merges += 1
    return grid, placed, merges

# --------------------------------------------------------------- anti-fabrication guard
# ONE numeric-cell test for the whole rig (de-dup): the borderless-table detector uses the SAME
# parser as the tie-out, so a Devanagari/odd-format number is recognised identically everywhere.
_cell_is_number = common.is_amount_cell

def _numeric_columns(rows, ncols):
    """Number of columns that hold >=2 numeric cells (a money/qty grid signal)."""
    return sum(1 for c in range(ncols)
               if sum(1 for r in rows if c < len(r) and _cell_is_number(r[c])) >= 2)

def is_tabular(grid):
    """Guard so a borderless reconstruction can NEVER fabricate a 'table' out of prose or
    headings. A grid is a genuine table iff it has >=2 columns, >=3 non-empty rows, AND
    EITHER (a) >=50% of rows have >=2 filled cells (the forgiving structural rule that already
    protects doc_layout) OR (b) it has >=2 numeric columns. The numeric test is an ADDITIVE
    acceptance path - it never ANDs with (a) - so a real but SPARSE BOQ (section-header,
    subtotal and stray 0 rows) is accepted, not over-rejected, while prose (1 column, or few
    multi-filled rows and no numeric columns) is rejected."""
    rows = [r for r in grid if any((c or "").strip() for c in r)]
    ncols = max((len(r) for r in rows), default=0)
    if len(rows) < 3 or ncols < 2:
        return False
    if _numeric_columns(rows, ncols) >= 2:
        return True                                  # numeric structure = a real table (always accept)
    multi = sum(1 for r in rows if sum(1 for c in r if (c or "").strip()) >= 2)
    if multi < max(2, 0.5 * len(rows)):
        return False
    # Structurally aligned but NON-numeric -> could be a multi-column PROSE block. A real text table
    # has SHORT cells; prose has long ones. Reject when the average cell is prose-length (word-density
    # guard). The numeric path above is untouched, so a BOQ with amounts is never affected.
    total_cells = sum(len(r) for r in rows)
    avg_words = sum(len(str(c).split()) for r in rows for c in r) / max(1, total_cells)
    return avg_words < 15

# --------------------------------------------------------------- page driver + audit
def _in_any_bbox(w, bboxes):
    cx, cy = (w["x0"] + w["x1"]) / 2, (w["top"] + w["bottom"]) / 2
    for b in bboxes:
        if not b: continue
        x0, y0, x1, y1 = b
        if x0 - 1 <= cx <= x1 + 1 and y0 - 1 <= cy <= y1 + 1:
            return True
    return False

def _words_bbox(ws):
    if not ws: return None
    return (min(w["x0"] for w in ws), min(w["top"] for w in ws),
            max(w["x1"] for w in ws), max(w["bottom"] for w in ws))

def extract_page(page):
    """Return (tables, audit). tables: list of {grid, mode, bbox}. audit: completeness
    report incl. any in-table-region words that were NOT placed (possible dropped rows)."""
    words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
    H, V = _edges(page)
    regions = table_regions(H, V)
    tables, placed = [], set()
    ruled_bboxes = []
    for H_ys, V_xs in regions:               # one grid per SEPARATE ruled table on the page
        grid, p, bbox = ruled_table(words, H_ys, V_xs)
        tables.append({"grid": grid, "mode": "ruled", "bbox": bbox}); placed |= p
        ruled_bboxes.append(bbox)

    # BORDERLESS reconstruction. With NO ruled tables -> all words. On a MIXED page (some
    # ruled tables) -> only the words OUTSIDE every ruled bbox, so a borderless table elsewhere
    # on the page is NOT silently lost (P0-3). Accept the result ONLY if is_tabular() passes -
    # this is what stops a prose/heading block being fabricated into a 'table' (the guard that
    # protects table_pdf, not just doc_layout) and is applied to BOTH paths.
    out_idx = ([i for i, w in enumerate(words) if not _in_any_bbox(w, ruled_bboxes)]
               if regions else list(range(len(words))))
    outside = [words[i] for i in out_idx]
    border_merges = 0
    if outside:
        grid, p_local, border_merges = borderless_table(outside)
        if grid and is_tabular(grid):
            placed_global = {out_idx[i] for i in p_local}
            bbox = _words_bbox([words[g] for g in placed_global])   # real bbox -> audited below
            tables.append({"grid": grid, "mode": "borderless", "bbox": bbox})
            placed |= placed_global
        else:
            border_merges = 0                  # rejected grid -> not a table, merges irrelevant

    # COMPLETENESS AUDIT: an unplaced word whose centre is STRICTLY INSIDE a table's
    # rule box (between the top and bottom rules, within the column span) is a row that
    # slipped out of the grid -> flag it. Words ABOVE the first rule / BELOW the last
    # are page headings/footers, not dropped rows, so they are not flagged. Borderless
    # tables now carry a real bbox, so they are covered by this audit too.
    orphans = []
    for idx, w in enumerate(words):
        if idx in placed: continue
        cx, cy = (w["x0"] + w["x1"]) / 2, (w["top"] + w["bottom"]) / 2
        for t in tables:
            if not t["bbox"]: continue
            x0, y0, x1, y1 = t["bbox"]
            if x0 - 1 <= cx <= x1 + 1 and y0 + 1 < cy < y1 - 1:
                orphans.append({"text": w["text"], "x": round(cx), "y": round(cy),
                                "significant": _orphan_significant(w)}); break
    audit = {"words_total": len(words), "words_placed": len(placed),
             "orphans_in_table_region": orphans, "borderless_merged_rows": border_merges}
    return tables, audit

def _orphan_significant(w):
    """An orphan (unplaced in-table word) is a LIKELY dropped DATA row only if it bears a
    digit (amount/qty/serial) - a lone decorative/text token (a stray stamp or note) is not
    worth sending a whole document to a human. Used by the completeness gate (C2)."""
    return any(ch.isdigit() for ch in str(w.get("text", "")))
