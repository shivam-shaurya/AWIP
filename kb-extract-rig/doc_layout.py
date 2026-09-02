#!/usr/bin/env python3
r"""
doc_layout.py - COMPLETE document extraction for digital PDFs: text + tables +
figures + numbers, in READING ORDER, as one typed-element stream.

Design (from the multi-agent spec): every page -> a flat list of coordinate-bearing
ATOMS -> tables-first (REUSE robust_tables.py) -> subtract table regions -> figures
-> classify remaining text (heading/paragraph/list) -> reading order (column-aware
XY-cut) -> completeness self-check -> emit. Nothing in the table engine is changed;
this only ADDS the layout layer on top.

Outputs per file:
  <stem>.layout.json   canonical ordered element stream (the single source of truth)
  <stem>.md            readable Markdown rebuild (headings, paragraphs, lists, tables, figures)
  figures/p{n}_*.png   every extracted raster + rasterized vector figure
  (tables also go to .xlsx via table_pdf.py; this module focuses on the full layout)

This v1 covers the BORN-DIGITAL path (what GUDC and most tenders are). Scanned pages
are flagged for the OCR path (pdf_extract ladder) to fill in later.

Run:  python doc_layout.py --in file.pdf --out out_dir\
"""
import argparse, json, os, re, statistics
from pathlib import Path

import fitz
import pdfplumber
import robust_tables as RT
import common
try: import links_qr
except Exception: links_qr = None
try: import scanned_layout
except Exception: scanned_layout = None

# ============================================================================
# atoms: text lines from fitz (text + style + bbox)
# ============================================================================
def _lines(page):
    """Text lines with bbox + dominant font size + bold flag (fitz get_text dict)."""
    out = []
    d = page.get_text("dict")
    for b in d["blocks"]:
        if b.get("type") != 0:
            continue
        for ln in b["lines"]:
            spans = [s for s in ln["spans"] if s["text"].strip()]
            if not spans:
                continue
            text = "".join(s["text"] for s in ln["spans"])
            x0 = min(s["bbox"][0] for s in spans); y0 = min(s["bbox"][1] for s in spans)
            x1 = max(s["bbox"][2] for s in spans); y1 = max(s["bbox"][3] for s in spans)
            size = max(s["size"] for s in spans)
            bold = any(("Bold" in s["font"]) or (s["flags"] & 16) for s in spans)
            out.append({"text": text.strip(), "bbox": [x0, y0, x1, y1],
                        "size": round(size, 1), "bold": bold})
    return out

def _modal_size(lines):
    """Char-weighted most common line font size = the body text size."""
    freq = {}
    for ln in lines:
        freq[ln["size"]] = freq.get(ln["size"], 0) + len(ln["text"])
    return max(freq, key=freq.get) if freq else 10.0

# ============================================================================
# tables (REUSE robust_tables) + bbox for the subtraction seam
# ============================================================================
# The "is this a genuine table vs prose" guard now lives in robust_tables (one definition,
# applied INSIDE extract_page so table_pdf is protected too). Kept as a thin alias here.
_is_real_table = RT.is_tabular

def _table_elements(plumber_page):
    tables, audit = RT.extract_page(plumber_page)
    out = []
    for t in tables:
        # RULED tables are always real (bordered). BORDERLESS only if actually tabular -
        # otherwise it's a plain text page robust_tables fell back on; skip it so the
        # layout module classifies that text as headings/paragraphs/lists instead.
        if t["mode"] != "ruled" and not _is_real_table(t["grid"]):
            continue
        # FIX 4: robust_tables.extract_page already sets a bbox from the table's OWN placed words. NEVER
        # fabricate a whole-page bbox from ALL page words for a table that lacks one - that box would then
        # subtract EVERY text line on the page (only the table survives). Missing bbox -> None: this table
        # subtracts NOTHING rather than the whole page (its text simply flows to the classifier).
        bbox = t.get("bbox")
        out.append({"type": "table", "bbox": list(bbox) if bbox else None,
                    "grid": t["grid"], "mode": t["mode"], "audit": audit})
    return out

def _lines_extent(lines):
    """Bounding box of all text lines on a page (the page's TEXT extent), or None if no lines."""
    bs = [l["bbox"] for l in lines if l.get("bbox")]
    if not bs:
        return None
    return [min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs)]

def _covers_most_text(box, extent, frac=0.70):
    """True if `box` overlaps MORE than `frac` of the page's text extent (FIX 4). Such a box must NOT be
    used to subtract text - it would swallow the surrounding prose. Returns False for missing inputs."""
    if not box or not extent:
        return False
    ex_area = max(1.0, (extent[2] - extent[0]) * (extent[3] - extent[1]))
    ix = max(0.0, min(box[2], extent[2]) - max(box[0], extent[0]))
    iy = max(0.0, min(box[3], extent[3]) - max(box[1], extent[1]))
    return (ix * iy) / ex_area > frac

def _inside(bbox, boxes, pad=1.0):
    cx = (bbox[0] + bbox[2]) / 2; cy = (bbox[1] + bbox[3]) / 2
    for x0, y0, x1, y1 in boxes:
        if x0 - pad <= cx <= x1 + pad and y0 - pad <= cy <= y1 + pad:
            return True
    return False

# ============================================================================
# figures: raster (get_images) + vector (get_drawings clustered)
# ============================================================================
def _figure_elements(fpage, doc, figdir, pageno, table_boxes):
    figs = []
    pw, ph = fpage.rect.width, fpage.rect.height
    page_area = pw * ph
    # raster images
    for k, img in enumerate(fpage.get_images(full=True), 1):
        xref = img[0]
        try:
            rects = fpage.get_image_rects(xref)
        except Exception:
            rects = []
        rect = rects[0] if rects else fpage.rect
        bbox = [rect.x0, rect.y0, rect.x1, rect.y1]
        decorative = (rect.width * rect.height) > 0.8 * page_area
        path = None
        try:
            figdir.mkdir(parents=True, exist_ok=True)
            path = str(figdir / f"p{pageno}_img{k}.png")
            pix = fpage.get_pixmap(clip=rect, dpi=150)   # render as placed (honours CTM/clip)
            pix.save(path)
        except Exception:
            path = None
        figs.append({"type": "figure", "subtype": "raster", "bbox": bbox, "xref": xref,
                     "image_path": path, "is_decorative": decorative})
    # vector drawings -> cluster into figure regions, excluding table rules.
    # CAP path count: CAD/engineering pages can carry tens of thousands of paths and
    # the O(n^2) clustering would hang/OOM a worker - bail out generally above the cap.
    try:
        draws = fpage.get_drawings()
    except Exception:
        draws = []
    if len(draws) > 3000:
        return figs                          # too vector-dense to cluster safely; skip vector figures
    rects = []
    for dr in draws:
        r = dr["rect"]
        if r.width < 2 and r.height < 2:
            continue
        # skip thin bars (rules) and anything inside a table
        if _inside([r.x0, r.y0, r.x1, r.y1], table_boxes):
            continue
        rects.append([r.x0, r.y0, r.x1, r.y1])
    for cl in _cluster_boxes(rects, gap=12):
        x0 = min(b[0] for b in cl); y0 = min(b[1] for b in cl)
        x1 = max(b[2] for b in cl); y1 = max(b[3] for b in cl)
        if (x1 - x0) < 40 or (y1 - y0) < 40:    # too small to be a real figure
            continue
        if (x1 - x0) * (y1 - y0) > 0.85 * page_area:
            continue                             # page-size box = decorative/background
        path = None
        try:
            figdir.mkdir(parents=True, exist_ok=True)
            path = str(figdir / f"p{pageno}_vec{int(x0)}_{int(y0)}.png")
            fpage.get_pixmap(clip=fitz.Rect(x0, y0, x1, y1), dpi=150).save(path)
        except Exception:
            path = None
        figs.append({"type": "figure", "subtype": "vector", "bbox": [x0, y0, x1, y1],
                     "image_path": path, "is_decorative": False, "n_paths": len(cl)})
    return figs

def _cluster_boxes(boxes, gap=12):
    """Union-find clusters of boxes that overlap or are within `gap` of each other."""
    n = len(boxes)
    parent = list(range(n))
    def find(a):
        while parent[a] != a: parent[a] = parent[parent[a]]; a = parent[a]
        return a
    def near(a, b):
        ax0, ay0, ax1, ay1 = a; bx0, by0, bx1, by1 = b
        return not (bx0 > ax1 + gap or ax0 > bx1 + gap or by0 > ay1 + gap or ay0 > by1 + gap)
    for i in range(n):
        for j in range(i + 1, n):
            if near(boxes[i], boxes[j]): parent[find(i)] = find(j)
    groups = {}
    for i in range(n): groups.setdefault(find(i), []).append(boxes[i])
    return list(groups.values())

# ============================================================================
# classify remaining text lines
# ============================================================================
_BMARK = "".join(chr(c) for c in (0x2022, 0x25cf, 0x25aa, 0x25a0))      # bullet glyphs
# a LIST marker: bullet | (a)/a) | (i)/i) roman | (2)/2) paren-number | dash/star
_LISTMARK = re.compile(r"^\s*([" + re.escape(_BMARK) + r"]|\(?[a-zA-Z]\)|\(?[ivxIVX]{1,4}[\.\)]|\(?\d{1,2}[\.\)]|[\-\*])\s+")
# a HEADING number: a multi-part dotted number (1.0, 2.1, 4.2.1.3) at line start
_DOTNUM = re.compile(r"^\s*(\d+(?:\.\d+)+)")
_LEADNUM = re.compile(r"^\s*(\d+(?:\.\d+)*)")
_ONLYNUM = re.compile(r"^\s*\d+(?:\.\d+)*[\.\)]?\s*$")                   # a number-only line (e.g. '1.0')

def _norm(t):
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", "", t)).strip().lower()

def _num_level(num):
    """Heading level from numbering depth: 1.0->1, 1.1->2, 4.2.1.3->4 (trailing .0 ignored)."""
    parts = num.split(".")
    while len(parts) > 1 and parts[-1] == "0":
        parts = parts[:-1]
    return min(max(len(parts), 1), 6)

def _classify_line(ln, modal, size_ranks, toc_map):
    """Multi-signal classifier (priority: PDF outline > numbering > list marker > font)."""
    txt = ln["text"].strip()
    if not txt:
        return None
    nt = _norm(txt)
    looks_big = ln["bold"] or ln["size"] >= modal + 0.5
    # 1. PDF outline / bookmarks = ground-truth hierarchy
    if nt in toc_map and looks_big:
        return {"type": "heading", "level": toc_map[nt], "number": None}
    # 2. dotted-number heading (1.0 / 2.1.3), deterministic level from depth
    m = _DOTNUM.match(txt)
    if m and looks_big:
        return {"type": "heading", "level": _num_level(m.group(1)), "number": m.group(1)}
    # 3. list marker (letters / parens / roman / bullets) - unless clearly a big bold heading
    if _LISTMARK.match(txt) and not (ln["bold"] and ln["size"] >= modal + 1.5):
        return {"type": "list_item"}
    # 4. font-size heading fallback (no numbering): a CLEARLY larger line, OR a SHORT
    #    bold title that is not a sentence. Long bold prose / bold sentences / bold
    #    labels ending in a period stay paragraphs (kills the '###' noise on bold body
    #    text and table-cell fragments). Capped at 3 levels since there is no numbering.
    big = ln["size"] >= modal + 2.0
    short_bold_title = (ln["bold"] and 2 <= len(txt) <= 45 and not txt.rstrip().endswith(".")
                        and ln["size"] >= modal)
    if big or short_bold_title:
        lvl = min(size_ranks.get(ln["size"], 3), 3)
        return {"type": "heading", "level": lvl, "number": (_LEADNUM.match(txt).group(1) if _LEADNUM.match(txt) else None)}
    return {"type": "paragraph"}

def _merge_headings(elements):
    """Join a number-only heading ('1.0') with its title, AND merge consecutive
    heading lines that are continuation of one multi-line heading/title."""
    out = []
    for e in elements:
        prev = out[-1] if out else None
        num_title = (prev and e["type"] == "heading" and prev["type"] == "heading"
                     and _ONLYNUM.match(prev["text"]) and not _ONLYNUM.match(e["text"])
                     and abs(e["bbox"][1] - prev["bbox"][1]) < 30)
        lh = (prev["bbox"][3] - prev["bbox"][1] + 1) if prev else 12
        gap = (e["bbox"][1] - prev["bbox"][3]) if prev else 1e9
        continuation = (prev and e["type"] == "heading" and prev["type"] == "heading"
                        and not _LEADNUM.match(e["text"].strip())          # continuation has no number
                        and -lh < gap < 0.6 * lh                           # tight/overlapping line below
                        and abs(e.get("level", 3) - prev.get("level", 3)) <= 1)
        if num_title or continuation:
            prev["text"] = (prev["text"].strip() + " " + e["text"].strip()).strip()
            if num_title and prev.get("number"):
                prev["level"] = _num_level(prev["number"])
            prev["bbox"][2] = max(prev["bbox"][2], e["bbox"][2]); prev["bbox"][3] = max(prev["bbox"][3], e["bbox"][3])
        else:
            out.append(e)
    return out

def _demote_sentence_headings(elements):
    """A long, mostly-lowercase 'heading' is really a bold SENTENCE -> paragraph.
    Keeps upper-case TITLES and numbered headings; removes prose mis-tagged as headings."""
    for e in elements:
        if e["type"] == "heading" and not e.get("number"):
            t = e["text"].strip()
            lower = sum(1 for c in t if c.islower()); upper = sum(1 for c in t if c.isupper())
            if len(t) > 55 and lower > upper:
                e["type"] = "paragraph"; e.pop("level", None)
    return elements

def _merge_list_continuations(elements):
    """Fold a wrapped continuation paragraph back into the list item above it."""
    out = []
    for e in elements:
        if (out and out[-1]["type"] == "list_item" and e["type"] == "paragraph"
                and not _LISTMARK.match(e["text"])
                and e["bbox"][1] - out[-1]["bbox"][3] < 1.8 * (out[-1]["bbox"][3] - out[-1]["bbox"][1] + 1)
                and e["bbox"][0] >= out[-1]["bbox"][0] - 4):
            prev = out[-1]
            joiner = "" if prev["text"].endswith("-") else " "
            prev["text"] = (prev["text"][:-1] if prev["text"].endswith("-") else prev["text"]) + joiner + e["text"]
            prev["bbox"][3] = e["bbox"][3]
        else:
            out.append(e)
    return out

def _merge_paragraphs(elements):
    """Merge consecutive paragraph elements (same column) into blocks; de-hyphenate."""
    out = []
    for e in elements:
        if (out and e["type"] == "paragraph" and out[-1]["type"] == "paragraph"
                and abs(e["bbox"][0] - out[-1]["bbox"][0]) < 25
                and e["bbox"][1] - out[-1]["bbox"][3] < 1.6 * (out[-1]["bbox"][3] - out[-1]["bbox"][1] + 1)):
            prev = out[-1]
            joiner = "" if prev["text"].endswith("-") else " "
            prev["text"] = (prev["text"][:-1] if prev["text"].endswith("-") else prev["text"]) + joiner + e["text"]
            prev["bbox"][2] = max(prev["bbox"][2], e["bbox"][2]); prev["bbox"][3] = e["bbox"][3]
        else:
            out.append(e)
    return out

# ============================================================================
# figure de-duplication: a logo/box repeating across pages = decorative furniture
# ============================================================================
def _figure_signature(f):
    if f.get("subtype") == "raster" and f.get("xref") is not None:
        return ("raster", f["xref"])
    b = f.get("bbox") or [0, 0, 0, 0]
    return ("vec", round(b[0] / 8), round(b[1] / 8), round((b[2] - b[0]) / 8), round((b[3] - b[1]) / 8))

# ============================================================================
# cross-page table stitch: a table that continues onto the next page (P0-7)
# ============================================================================
_TIEOUT_REASONS = ("table tie-out / arithmetic flag(s)",
                   "table: amounts present but NOT verified (no total row)")

def _tbl_ncols(grid): return max((len(r) for r in grid), default=0)

def _ends_in_total(grid):
    return common.ends_in_total(grid)               # ONE shared definition in common.py

def _repeated_header(first_row, header):
    a = [str(c).strip().lower() for c in first_row if str(c).strip()]
    b = [str(c).strip().lower() for c in header if str(c).strip()]
    return bool(a) and bool(b) and a == b

def _tieout_reason(flags):
    if not flags:
        return None
    return (_TIEOUT_REASONS[1] if all(f.get("kind") == "not_verified" for f in flags) else _TIEOUT_REASONS[0])

def _stitch_cross_page_tables(doc, cfg):
    """Merge a table that CONTINUES onto the next page into the table above it (consecutive pages,
    same mode + column count, and the previous table did NOT already end in a total) so a multi-page
    price SUMMARY reconciles as ONE table. Re-runs the money tie-out on the merged grid, drops the
    continuation fragment, and recomputes each page's tie-out review reasons. Returns tieout_gaps."""
    anchor = None; anchor_pno = None
    for pg in doc["pages"]:
        pno = pg["page_no"]
        for e in pg.get("elements", []):
            if e.get("type") != "table":
                continue
            if (anchor is not None and pno - anchor_pno == 1 and e.get("mode") == anchor.get("mode")
                    and _tbl_ncols(e["grid"]) == _tbl_ncols(anchor["grid"]) and _tbl_ncols(e["grid"]) >= 2
                    and not _ends_in_total(anchor["grid"])
                    # don't stitch across a top-level SECTION change: two same-shape tables under
                    # different headings are DISTINCT, not a continuation (mirrors reconcile grouping).
                    and (e.get("section_path") or [None])[0] == (anchor.get("section_path") or [None])[0]):
                start = e["grid"][1:] if (e["grid"] and _repeated_header(e["grid"][0], anchor["grid"][0])) else e["grid"]
                anchor["grid"] = anchor["grid"] + start
                anchor["stitched_pages"] = anchor.get("stitched_pages", []) + [pno]
                e["_stitched_away"] = True              # continuation fragment -> removed below
                anchor_pno = pno                        # the merged table now ends on this page
            else:
                anchor = e; anchor_pno = pno
    tieout_gaps = 0
    for pg in doc["pages"]:
        pg["elements"] = [e for e in pg.get("elements", []) if not e.get("_stitched_away")]
        reasons = [r for r in pg.get("review_reasons", []) if r not in _TIEOUT_REASONS]   # keep non-tie-out
        for e in pg["elements"]:
            if e.get("type") == "table":
                if e.get("stitched_pages"):             # a merged anchor -> re-verify the FULL grid
                    e["tieout_flags"] = common.verify_table(e["grid"], cfg, flag_unverified=True)
                tf = e.get("tieout_flags") or []
                tieout_gaps += len(tf)
                r = _tieout_reason(tf)
                if r and r not in reasons:
                    reasons.append(r)
        if "review_reasons" in pg:
            pg["review_reasons"] = reasons; pg["needs_review"] = bool(reasons)
    return tieout_gaps

def _n_data_cells(grid):
    return sum(1 for r in grid for c in r if str(c if c is not None else "").strip())

def _tag_reconcilable_tables(doc, cfg):
    """Tag UNCERTAIN table elements as 'tombstones' eligible for an authoritative-Excel override
    (Excel<->PDF reconciliation). Runs AFTER _stitch_cross_page_tables so multi-page tables are merged
    and tieout_flags are final. ADDITIVE: it only adds a `reconcile` block to the existing element
    (grid/bbox/id/section_path untouched) and does NOT change needs_review - alignment + injection are a
    separate offline step (reconcile_tables.py) against the written layout.json. A table is uncertain iff
    it is on a scanned/low-confidence page OR carries any tie-out flags; a clean reconciling table is
    never tagged. Default-off via cfg.reconcile_tables, so the digital path is unchanged when disabled."""
    dkey = common.doc_key(doc.get("file", "")) if doc.get("file") else "doc"
    gid = 0
    # A scanned table is inherently untrustworthy: OCR can MERGE two tables into one and COLLAPSE
    # columns while still looking "confident" (proven on a synthetic multi-table scan), so the old
    # `low_conf OR no-elements` trigger let a mangled-but-confident scanned table slip through
    # WITHOUT offering the Excel-upload path. When reconcile is enabled we therefore tombstone EVERY
    # table on a scanned page (tag_all_scanned, default on), not only low-confidence ones. Digital
    # pages (route != "scanned") are untouched -> the digital path stays byte-identical.
    tag_all_scanned = getattr(cfg, "reconcile_all_scanned_tables", True)
    for pg in doc["pages"]:
        # startswith so docling ("scanned_docling") + ensemble ("scanned_ensemble") routes also
        # get the tombstone-all-scanned guarantee, not only the docTR "scanned" route.
        scanned = str(pg.get("route", "")).startswith("scanned")
        scanned_low = scanned and (pg.get("low_conf") or not pg.get("elements"))
        for e in pg.get("elements", []):
            if e.get("type") != "table":
                continue
            scanned_uncertain = scanned_low or (scanned and tag_all_scanned)
            uncertain = scanned_uncertain or bool(e.get("tieout_flags"))
            if not uncertain:
                continue
            grid = e.get("grid") or []
            cols = common.infer_amount_columns(grid)
            counts = common.numeric_col_counts(grid)
            gid += 1
            sec = e.get("section_path") or []
            e["reconcile"] = {
                "tombstone": True,
                "tombstone_id": f"{dkey}:{e.get('id', 'p%d' % pg['page_no'])}",
                "reason": ("scanned_low_conf" if scanned_low
                           else "scanned_table" if scanned else "tieout_flags"),
                "page_conf": pg.get("page_conf"),
                "n_data_rows": sum(1 for r in grid if any(str(c or '').strip() for c in r)),
                "amount_col_index": common.pick_amount_column(grid, counts) if counts else None,
                "anchor_columns": cols,
                # operator queue: tell a human WHICH table to upload the Excel for (page + section + id)
                "page": pg["page_no"],
                "section_path": list(sec),
                "suggested_excel": (sec[-1] if sec else "table on page %d (id %s)" % (pg["page_no"], e.get("id"))),
                "logical_group_id": f"g{gid}",      # refined into real groups by reconcile_tables.group_tombstones
                "status": "PENDING",
                "version": 0,
            }

def _dedupe_figures(doc):
    pages_with = {}
    for pg in doc["pages"]:
        for e in pg["elements"]:
            if e["type"] == "figure":
                pages_with.setdefault(_figure_signature(e), set()).add(pg["page_no"])
    repeating = {s for s, ps in pages_with.items() if len(ps) >= 2}   # any cross-page repeat = furniture
    n = 0
    for pg in doc["pages"]:
        for e in pg["elements"]:
            if e["type"] == "figure" and _figure_signature(e) in repeating and not e.get("is_decorative"):
                e["is_decorative"] = True; e["decorative_reason"] = "repeats across pages"; n += 1
    return n

# ============================================================================
# reading order: column detect + XY ordering
# ============================================================================
def _column_bounds(boxes, page_w):
    """Column separators = vertical whitespace gutters wider than 5% of page width."""
    if not boxes:
        return [0, page_w]
    spans = sorted((b[0], b[2]) for b in boxes)
    merged = []
    for a, b in spans:
        if merged and a <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    bounds = [0.0]
    for (a, b), (c, d) in zip(merged, merged[1:]):
        if c - b >= 0.05 * page_w:
            bounds.append((b + c) / 2)
    bounds.append(page_w)
    return bounds

def _order(elements, page_w):
    """Column-aware reading order via a banded XY-cut: full-width spanners (headings/tables/
    figures/wide blocks) cut the page into horizontal bands; within each band read columns
    left-to-right, each column top-to-bottom; bands emit top-to-bottom. Headers/footers are
    page furniture - kept (the user wants them), with headers hoisted to the top of the page
    stream and footers sent to the bottom, so they never interleave with the body flow."""
    heads = sorted((e for e in elements if e["type"] == "header"), key=lambda e: e["bbox"][1])
    foots = sorted((e for e in elements if e["type"] == "footer"), key=lambda e: e["bbox"][1])
    body  = [e for e in elements if e["type"] not in ("header", "footer")]
    text_boxes = [e["bbox"] for e in body if e["type"] in ("paragraph", "list_item")]
    cols = _column_bounds(text_boxes, page_w)
    ncols = len(cols) - 1
    body.sort(key=lambda e: e["bbox"][1])
    if ncols <= 1:                          # single column: pure top-to-bottom (digital path unchanged)
        return heads + body + foots
    def colof(e):
        w = e["bbox"][2] - e["bbox"][0]
        if w > 0.6 * page_w or e["type"] in ("table", "figure", "heading"):
            return -1                       # full-width spanner -> a horizontal band cut
        cx = (e["bbox"][0] + e["bbox"][2]) / 2
        for j in range(ncols):
            if cols[j] <= cx < cols[j + 1]: return j
        return 0
    for e in body: e["_col"] = colof(e)
    ordered, band = [], []
    def flush(b):                           # one band: column L->R, each column top->bottom
        return sorted(b, key=lambda e: (e["_col"], e["bbox"][1]))
    for e in body:                          # body is y-sorted; a spanner closes the open band
        if e["_col"] == -1:
            ordered += flush(band); band = []
            ordered.append(e)
        else:
            band.append(e)
    ordered += flush(band)
    for e in ordered: e.pop("_col", None)
    return heads + ordered + foots

# ============================================================================
# headers / footers (cross-page repetition)
# ============================================================================
def _mark_furniture(pages):
    """Tag lines in the top/bottom margin whose normalized text repeats across pages."""
    norm = lambda t: re.sub(r"\d+", "#", t).strip().lower()
    counts = {}
    npages = len(pages)
    for pg in pages:
        h = pg["height"]
        for ln in pg["_lines"]:
            ymid = (ln["bbox"][1] + ln["bbox"][3]) / 2
            if ymid < 0.10 * h or ymid > 0.90 * h:
                counts[norm(ln["text"])] = counts.get(norm(ln["text"]), set())
                counts[norm(ln["text"])].add(pg["page_no"])
    repeating = {k for k, v in counts.items() if len(v) >= max(2, 0.4 * npages)}
    for pg in pages:
        h = pg["height"]
        for ln in pg["_lines"]:
            ymid = (ln["bbox"][1] + ln["bbox"][3]) / 2
            if (ymid < 0.10 * h or ymid > 0.90 * h) and norm(ln["text"]) in repeating:
                ln["_furniture"] = "header" if ymid < 0.5 * h else "footer"

# ============================================================================
# main per-document
# ============================================================================
def _attach_links_qr(fpage, page_no, page_elems, roi, section, doc, rgb=None, text=None, scale=1.0):
    """Phase A: append hyperlink/url/email + QR elements to the page (after reading-order, since
    they're annotations/codes) AND a slim entry to doc['links']/doc['codes']. Returns updated roi.
    Works for digital (rgb=None -> QR from embedded images) and scanned (rgb=raster -> QR on it,
    bbox scaled to page points via `scale`=72/dpi)."""
    if links_qr is None:
        return roi
    try:
        found = links_qr.extract_links_qr(fpage, page_no, rgb=rgb, text=text, scale=scale)
    except Exception:
        return roi
    for e in found:
        e["id"] = f"p{page_no}-l{sum(1 for x in page_elems if x.get('id','').startswith(f'p{page_no}-l'))+1}"
        e["page"] = page_no; e["reading_order_index"] = roi; roi += 1
        e["section_path"] = list(section)
        page_elems.append(e)
        (doc["codes"] if e["type"] == "qr" else doc["links"]).append(
            {k: e.get(k) for k in ("subtype", "uri", "data", "page", "bbox") if k in e})
    return roi

def _finalize_page_elements(els, page_w, page_no, roi, section):
    """Shared tail for BOTH the digital and scanned paths: reading order -> merges -> section
    breadcrumb + id + reading_order_index. Mutates `section` in place (the breadcrumb carries
    across pages) and returns (page_elems, roi). One definition so a scanned page emits a stream
    byte-compatible with a digital one."""
    els = _order(els, page_w)                          # reading order FIRST
    els = _merge_headings(els)                          # number+title + multi-line title merge
    els = _demote_sentence_headings(els)               # bold sentences -> paragraphs
    els = _merge_list_continuations(els)
    els = _merge_paragraphs(els)
    page_elems = []
    for e in els:
        if e["type"] == "heading":
            lvl = e.get("level", 3)
            section[:] = section[:lvl - 1] + [e["text"]]
        e["id"] = f"p{page_no}-e{len(page_elems)+1}"
        e["page"] = page_no; e["reading_order_index"] = roi; roi += 1
        e["section_path"] = list(section)
        page_elems.append(e)
    return page_elems, roi

def extract_document(path, out_dir, cfg=None):
    path = Path(path); out_dir = Path(out_dir); stem = path.stem
    docdir = common.doc_outdir(out_dir, path); docdir.mkdir(parents=True, exist_ok=True)   # collision-safe + sharded
    fbase = docdir.name                          # bounded output filename base (= doc_key) -> never exceeds MAX_PATH
    figdir = docdir / "figures"
    # PRE-FLIGHT guard: a pathological oversized file (page count / size) is routed to review
    # UNPROCESSED rather than risk OOM / a multi-hour stall on it (opt-in via cfg; 0 = off).
    max_pages = getattr(cfg, "max_pages_per_doc", 0) if cfg else 0
    max_mb = getattr(cfg, "max_file_mb", 0) if cfg else 0
    try:
        npages = fitz.open(str(path)).page_count
        size_mb = path.stat().st_size / (1024 * 1024)
    except Exception:
        npages = size_mb = 0
    if (max_pages and npages > max_pages) or (max_mb and size_mb > max_mb):
        why = "oversized: %d pages / %.0f MB (caps %s/%s) - routed to review unprocessed" % (
            npages, size_mb, max_pages or "-", max_mb or "-")
        doc = {"file": str(path), "pages": [], "links": [], "codes": [], "status": "NEEDS_REVIEW",
               "completeness": {"status": "NEEDS_REVIEW", "reasons": [why]}, "element_counts": {},
               "review_pages": [{"stem": stem, "page": 0, "confidence": "", "reasons": why}]}
        common.atomic_write_text(docdir / f"{fbase}.layout.json", json.dumps(doc, indent=2, ensure_ascii=False))
        common.mark_done(docdir)
        return doc, {}, {"oversized": True}
    fdoc = fitz.open(str(path))
    enc_reason = common.encrypted_reason(fdoc)     # M4: an encrypted PDF has empty text on every page and would
    if enc_reason:                                 # mis-route as fully-scanned -> route to review UNPROCESSED instead
        fdoc.close()
        doc = {"file": str(path), "pages": [], "links": [], "codes": [], "status": "NEEDS_REVIEW",
               "completeness": {"status": "NEEDS_REVIEW", "reasons": [enc_reason]}, "element_counts": {},
               "review_pages": [{"stem": stem, "page": 0, "confidence": "", "reasons": enc_reason}]}
        common.atomic_write_text(docdir / f"{fbase}.layout.json", json.dumps(doc, indent=2, ensure_ascii=False))
        common.mark_done(docdir)
        return doc, {}, {"encrypted": True}
    toc_map = {}                                   # PDF outline/bookmarks: title -> level
    try:
        for lvl, title, _pg in (fdoc.get_toc(simple=True) or []):
            toc_map[_norm(title)] = min(max(lvl, 1), 6)
    except Exception:
        pass
    pages_meta = []
    # pass 1: gather lines per page (for furniture detection)
    with pdfplumber.open(str(path)) as pdf:
        for i, ppage in enumerate(pdf.pages, 1):
            fpage = fdoc[i - 1]
            native = (fpage.get_text() or "").strip()
            route = "native" if common.is_native_text(native, cfg) else "scanned"   # M1: shared min-text gate
            pages_meta.append({"page_no": i, "width": fpage.rect.width, "height": fpage.rect.height,
                               "route": route, "_lines": _lines(fpage) if route == "native" else [],
                               "_ppage": ppage, "_fpage": fpage})
        _mark_furniture(pages_meta)
        # global modal size
        all_lines = [ln for pg in pages_meta for ln in pg["_lines"]]
        modal = _modal_size(all_lines)
        sizes = sorted({ln["size"] for ln in all_lines if ln["size"] > modal}, reverse=True)
        size_ranks = {s: r + 1 for r, s in enumerate(sizes)}     # biggest = level 1
        # pass 2: build elements per page
        doc = {"file": str(path), "modal_font": modal, "pages": [], "links": [], "codes": []}
        roi = 0; section = []; n_err_pages = 0; sig_orphans = 0; merged_rows = 0; tieout_gaps = 0
        # SCANNED layout is opt-in (--ocr-scanned). Only then do we import the heavy OCR module +
        # build its options, so the digital path stays light and byte-for-byte unchanged.
        ocr_scanned = bool(cfg and getattr(cfg, "layout_ocr_scanned", False) and scanned_layout is not None)
        _pdf_opt = None; scanned_words = {}
        if ocr_scanned:
            try:
                import pdf_extract as _PE
                _pdf_opt = _PE.PdfOptions(**cfg.to_pdf_options())
            except Exception as e:
                print("[doc_layout: scanned OCR unavailable (%s) - scanned pages left as stubs]" % e,
                      file=__import__("sys").stderr)
                ocr_scanned = False
        if ocr_scanned:                                    # P1: OCR every scanned page in ONE batched
            try:                                           # docTR pass (windowed) instead of one call/page
                sc = [(pg["page_no"], pg["_fpage"]) for pg in pages_meta if pg["route"] != "native"]
                if sc:
                    wl = _PE.ocr_pages_words([fp for _no, fp in sc], _pdf_opt)
                    scanned_words = {no: wr for (no, _fp), wr in zip(sc, wl)}
            except Exception as e:
                print("[doc_layout: batched scanned OCR failed (%s) - per-page fallback]" % e,
                      file=__import__("sys").stderr); scanned_words = {}
        for pg in pages_meta:
            els = []
            if pg["route"] != "native":
                # SCANNED page. With --ocr-scanned, reconstruct the element stream from OCR
                # words-with-geometry (scanned_layout); otherwise keep the cheap stub (= today).
                if not ocr_scanned:
                    doc["pages"].append({"page_no": pg["page_no"], "route": "scanned",
                                         "note": "scanned page - run with --ocr-scanned", "elements": []})
                    continue
                pg_reasons = []
                try:
                    s_els, s_meta = scanned_layout.scanned_page_elements(
                        pg["_fpage"], pg["page_no"], _pdf_opt, cfg, figdir, toc_map,
                        words_result=scanned_words.get(pg["page_no"]))   # P1: use the batched OCR result
                except Exception as e:
                    n_err_pages += 1
                    print("  [page %d: scanned OCR failed (%s)]" % (pg["page_no"], e), file=__import__("sys").stderr)
                    doc["pages"].append({"page_no": pg["page_no"], "route": "scanned", "elements": [],
                                         "note": "scanned OCR failed - run OCR path",
                                         "needs_review": True, "review_reasons": ["scanned OCR failed"]})
                    continue
                pg_reasons += s_meta.get("reasons", [])
                for t in s_els:                              # roll scanned table tie-out gaps into the doc
                    if t.get("type") == "table":
                        tieout_gaps += len(t.get("tieout_flags") or [])
                page_elems, roi = _finalize_page_elements(s_els, s_meta["width"], pg["page_no"], roi, section)
                joined = " ".join(e["text"] for e in page_elems if e.get("text"))
                roi = _attach_links_qr(pg["_fpage"], pg["page_no"], page_elems, roi, section, doc,
                                       rgb=s_meta.get("rgb"), text=joined,
                                       scale=s_meta.get("scale", 1.0))         # QR on the page raster -> points
                if not any(e["type"] in ("heading", "paragraph", "list_item", "table", "figure") for e in page_elems):
                    pg_reasons.append("scanned page: no content extracted")
                doc["pages"].append({"page_no": pg["page_no"], "route": "scanned",
                                     "width": s_meta["width"], "height": s_meta["height"],
                                     "elements": page_elems, "page_conf": s_meta.get("page_conf"),
                                     "engine": s_meta.get("engine"), "low_conf": s_meta.get("low_conf"),
                                     "needs_review": bool(pg_reasons), "review_reasons": pg_reasons})
                continue
            pg_reasons = []                       # per-PAGE human-review reasons (Phase B)
            try:                                  # per-PAGE isolation for the failure-prone steps
                tbl_els_all = _table_elements(pg["_ppage"])                       # every ruled/borderless region
                tbl_els = [t for t in tbl_els_all if common.emit_worthy(t["grid"])]  # real tables (>1 data cell)
                # FIX 4: a BORDERLESS box covering > ~70% of the page's TEXT extent must NOT subtract text
                # (an over-captured borderless region would swallow every surrounding line). Ruled boxes
                # come from real ruling lines (trustworthy) and always subtract, so a legit full-page ruled
                # table is unaffected. text extent = union of the page's text lines.
                _txt_ext = _lines_extent(pg["_lines"])
                tboxes = [t["bbox"] for t in tbl_els
                          if t["bbox"] and (t["mode"] == "ruled" or not _covers_most_text(t["bbox"], _txt_ext))]
                fig_exclude = [t["bbox"] for t in tbl_els_all if t["bbox"]]      # but ALL ruled regions block
                figs = _figure_elements(pg["_fpage"], fdoc, figdir, pg["page_no"], fig_exclude)  # figure detection
                fboxes = [f["bbox"] for f in figs if f["bbox"]]                  # -> an empty grid is neither
                if tbl_els:                       # all table els on a page share one page audit
                    aud = tbl_els[0].get("audit") or {}
                    sig_orphans += sum(1 for o in aud.get("orphans_in_table_region", []) if o.get("significant"))
                    merged_rows += aud.get("borderless_merged_rows", 0)
            except Exception as e:
                n_err_pages += 1                  # a page that errored -> completeness signal
                pg_reasons.append("table/figure extraction failed")
                print("  [page %d: table/figure extract failed (%s) - text only]" % (pg["page_no"], e), file=__import__("sys").stderr)
                tbl_els, tboxes, figs, fboxes = [], [], [], []
            # text lines minus furniture, minus table region, minus figure region
            for ln in pg["_lines"]:
                if ln.get("_furniture"):
                    els.append({"type": ln["_furniture"], "bbox": ln["bbox"], "text": ln["text"]}); continue
                if _inside(ln["bbox"], tboxes) or _inside(ln["bbox"], fboxes):
                    continue
                cl = _classify_line(ln, modal, size_ranks, toc_map)
                if cl: els.append({**cl, "bbox": ln["bbox"], "text": ln["text"]})
            for t in tbl_els:                     # Phase D: fold the money tie-out into each table element
                tf = common.verify_table(t["grid"], cfg, flag_unverified=True)
                els.append({"type": t["type"], "bbox": t["bbox"], "grid": t["grid"],
                            "mode": t["mode"], "tieout_flags": tf})
                if tf:
                    n_merged = sum(1 for f in tf if f.get("kind") == "merged_cell")   # FIX 1: collapsed-row cells
                    tieout_gaps += (len(tf) - n_merged)          # merged is a data-loss signal, not a tie-out failure
                    if n_merged:
                        merged_rows += n_merged
                        pg_reasons.append("table: cell(s) hold >=2 numbers (possible collapsed/merged row)")
                    rest = [f for f in tf if f.get("kind") != "merged_cell"]
                    if rest:
                        pg_reasons.append("table: amounts present but NOT verified (no total row)"
                                          if all(f.get("kind") == "not_verified" for f in rest)
                                          else "table tie-out / arithmetic flag(s)")
            els += [{k: f.get(k) for k in ("type", "subtype", "bbox", "xref", "image_path", "is_decorative")} for f in figs]
            page_elems, roi = _finalize_page_elements(els, pg["width"], pg["page_no"], roi, section)
            roi = _attach_links_qr(pg["_fpage"], pg["page_no"], page_elems, roi, section, doc)  # links/QR
            if not any(e["type"] in ("heading", "paragraph", "list_item", "table", "figure") for e in page_elems):
                pg_reasons.append("no content extracted")     # native page yielded nothing -> review
            doc["pages"].append({"page_no": pg["page_no"], "route": "native",
                                 "width": pg["width"], "height": pg["height"], "elements": page_elems,
                                 "needs_review": bool(pg_reasons), "review_reasons": pg_reasons})
    fdoc.close()
    if cfg is None or getattr(cfg, "stitch_cross_page", True):      # P0-7: merge cross-page tables, then
        tieout_gaps = _stitch_cross_page_tables(doc, cfg)           # re-tie-out -> recomputed gaps + reasons
    if cfg is not None and getattr(cfg, "reconcile_tables", False): # tag uncertain tables for Excel override
        _tag_reconcilable_tables(doc, cfg)                          # (additive; off by default -> no change)
    deduped = _dedupe_figures(doc)                  # repeated logos/boxes -> decorative
    # completeness summary + STRUCTURE SELF-AUDIT
    counts = {}
    for pg in doc["pages"]:
        for e in pg["elements"]:
            counts[e["type"]] = counts.get(e["type"], 0) + 1
    audit = _structure_audit(doc, toc_map)
    audit["figures_deduped_decorative"] = deduped
    # COMPLETENESS verdict (C2): significant orphan rows, errored pages, and scanned pages that
    # were not extracted into elements all force review. Attached to the layout + a sidecar.
    dropped = audit.get("scanned_pages_pending_ocr", 0)
    low_scans = audit.get("low_conf_scanned_pages", 0)
    extra = [f"{merged_rows} cell(s)/row(s) may hold merged/collapsed data (>=2 numbers in one cell)"] if merged_rows else []
    if low_scans:
        extra.append(f"{low_scans} scanned page(s) below OCR confidence gate")
    status, reasons = common.completeness_status(
        sig_orphans=sig_orphans, tieout_gaps=tieout_gaps, dropped_pages=dropped,
        errored_pages=n_err_pages, extra_reasons=extra)
    doc["status"] = status
    doc["completeness"] = {"status": status, "reasons": reasons, "sig_orphans": sig_orphans,
                           "tieout_gaps": tieout_gaps, "errored_pages": n_err_pages,
                           "scanned_pages_pending_ocr": dropped, "low_conf_scanned_pages": low_scans,
                           "borderless_merged_rows": merged_rows}
    doc["element_counts"] = counts; doc["structure_audit"] = audit; doc["used_pdf_outline"] = bool(toc_map)
    common.atomic_write_text(docdir / f"{fbase}.layout.json",
                             json.dumps(doc, indent=2, ensure_ascii=False, default=str))
    try:
        common.atomic_write_text(docdir / f"{fbase}.status.json", json.dumps(
            {"file": str(path), "stem": stem, "status": status, "reasons": ";".join(reasons),
             "needs_review": status == "NEEDS_REVIEW", **doc["completeness"]},
            indent=2, ensure_ascii=False))
    except Exception:
        pass
    _write_markdown(doc, docdir / f"{fbase}.md", figdir)
    common.mark_done(docdir)                                  # sentinel LAST: resume trusts .done, not partials
    return doc, counts, audit

def _structure_audit(doc, toc_map):
    """The 'verify' for layout: flag heading levels inconsistent with their numbering,
    number-only headings left unmerged, scanned pages not yet extracted, and low-confidence scans."""
    bad_level, only_num, scanned, low_conf_scans = [], [], 0, 0
    for pg in doc["pages"]:
        if pg.get("route") == "scanned" and not pg.get("elements"):
            scanned += 1                                   # pending ONLY if it produced no elements
        if pg.get("route") == "scanned" and pg.get("low_conf"):
            low_conf_scans += 1
        for e in pg["elements"]:
            if e["type"] == "heading":
                num = e.get("number")
                if num and "." in num and e.get("level") != _num_level(num):
                    bad_level.append({"id": e.get("id"), "number": num, "level": e.get("level"), "expected": _num_level(num)})
                if _ONLYNUM.match(e.get("text", "")):
                    only_num.append(e.get("id"))
    return {"heading_level_mismatches": bad_level[:50], "n_level_mismatches": len(bad_level),
            "number_only_headings": only_num[:50], "n_number_only": len(only_num),
            "scanned_pages_pending_ocr": scanned, "low_conf_scanned_pages": low_conf_scans}

# ============================================================================
# Markdown render
# ============================================================================
def _md_table(grid):
    rows = [r for r in grid if any((c or "").strip() for c in r)]
    if not rows:
        return ""
    ncol = max(len(r) for r in rows)
    rows = [list(r) + [""] * (ncol - len(r)) for r in rows]
    esc = lambda c: str(c or "").replace("|", "\\|").replace("\n", " ")
    out = ["| " + " | ".join(esc(c) for c in rows[0]) + " |",
           "| " + " | ".join("---" for _ in range(ncol)) + " |"]
    for r in rows[1:]:
        out.append("| " + " | ".join(esc(c) for c in r) + " |")
    return "\n".join(out)

def _write_markdown(doc, path, figdir):
    lines = []
    for pg in doc["pages"]:
        if not pg.get("elements"):                         # no content (a scanned stub / failed page)
            lines.append(f"\n<!-- page {pg['page_no']}: {pg.get('note', 'no content extracted')} -->\n"); continue
        if pg.get("route") == "scanned":
            lines.append(f"\n<!-- page {pg['page_no']}: scanned (OCR-reconstructed) -->")
        for e in pg["elements"]:
            t = e["type"]
            if t == "heading":
                lines.append("\n" + "#" * e.get("level", 3) + " " + e["text"])
            elif t == "paragraph":
                lines.append("\n" + e["text"])
            elif t == "list_item":
                lines.append("- " + re.sub(r"^\s*[" + re.escape(_BMARK) + r"\-\*]\s+", "", e["text"]))
            elif t == "table":
                lines.append("\n" + _md_table(e.get("reconciled_grid") or e["grid"]))   # prefer Excel-reconciled
                prov = (e.get("reconcile") or {}).get("provenance")
                if prov:                                       # stamp data lineage on a reconciled table
                    lines.append("_source: %s · sheet %s · reconciled by %s · conf %s_" % (
                        prov.get("excel_key"), prov.get("sheet"), prov.get("by"), prov.get("confidence")))
            elif t == "figure":
                if e.get("is_decorative"):
                    continue
                ip = e.get("image_path")
                rel = ("figures/" + Path(ip).name) if ip else ""
                lines.append(f"\n![figure]({rel})")
            elif t in ("header", "footer", "link", "qr"):
                continue                                       # links/codes -> appendix below
    links, codes = doc.get("links", []), doc.get("codes", [])
    if links:
        lines.append("\n## Links")
        for l in links:
            lines.append(f"- [{l.get('subtype','link')} p{l.get('page')}] {l.get('uri','')}")
    if codes:
        lines.append("\n## QR / codes")
        for c in codes:
            lines.append(f"- [qr p{c.get('page')}] {c.get('data','')}")
    common.atomic_write_text(path, "\n".join(lines))         # atomic + LF newlines (no CRLF)

def _dl_is_gpu(path):
    """Route a PDF that will use OCR (any of its first pages is scanned) to the GPU lane, so docTR
    runs on ONE warm model serialised in a single process instead of being forked across the CPU pool
    (N workers each loading a model + thrashing one GPU). Cheap probe: only the first few pages (a
    scanned tender is scanned from the start); a missed deep-scanned annexure just runs in the CPU
    pool (still correct, just not on the dedicated lane). Top-level so it survives 'spawn'."""
    try:
        d = fitz.open(str(path))
        for i in range(min(3, d.page_count)):
            if len((d[i].get_text() or "").strip()) < 50:
                return True
        return False
    except Exception:
        return False

def _dl_worker(path, args):
    """Top-level (picklable) per-file worker for parallel_foreach. doc_layout is digital-only
    (fitz/pdfplumber/robust_tables) - all CPU, so files parallelize freely."""
    p = Path(path); out = Path(args["out"])
    cfg = common.ExtractConfig(**args["cfg"]) if args.get("cfg") else None
    doc, counts, audit = extract_document(p, out, cfg)
    review_pages = [{"stem": p.stem, "page": pg["page_no"], "confidence": pg.get("page_conf", ""),
                     "reasons": ";".join(pg.get("review_reasons", []))}
                    for pg in doc["pages"] if pg.get("needs_review")]
    review_pages = review_pages or doc.get("review_pages", [])     # oversized/stub docs carry their own
    n_tombstones = sum(1 for pg in doc["pages"] for e in pg.get("elements", [])
                       if e.get("type") == "table" and (e.get("reconcile") or {}).get("tombstone"))
    return {"stem": p.stem, "status": doc.get("status", "AUTO_ACCEPT"),
            "reasons": ";".join(doc.get("completeness", {}).get("reasons", [])),
            "elements": sum(counts.values()), "review_pages": review_pages,
            "doc_key": common.doc_key(str(p)), "n_tombstones": n_tombstones}

def main():
    ap = argparse.ArgumentParser(description="Complete document extraction: text+tables+figures in reading order.")
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--ocr-scanned", dest="ocr_scanned", action="store_true",
                    help="reconstruct SCANNED pages into the element stream via OCR (docTR/Tesseract). "
                         "Off by default - scanned pages are left as stubs (digital path unchanged).")
    ap.add_argument("--scanned-figures", dest="scanned_figures", action="store_true",
                    help="with --ocr-scanned, also detect figure regions on scans (conservative; off by default).")
    ap.add_argument("--scanned-gpu-lane", dest="scanned_gpu_lane", action="store_true",
                    help="route scanned PDFs to the SERIAL warm-model GPU lane (prevents docTR being forked "
                         "across CPU workers on a VRAM-tight box / scan-heavy corpus). Default OFF = the fast "
                         "parallel CPU pool (batched OCR applies either way).")
    ap.add_argument("--ocr-conf-gate", dest="ocr_conf_gate", type=float, default=None,
                    help="a scanned page below this OCR confidence is routed to human review (default 0.70).")
    ap.add_argument("--dpi", dest="dpi", type=int, default=None, help="scanned render DPI (default 300).")
    ap.add_argument("--lang", dest="lang", default=None, help="OCR languages (default eng+hin+mar).")
    ap.add_argument("--escalate-th", dest="escalate_th", type=float, default=None,
                    help="run Tesseract when docTR page confidence is below this (default 0.88).")
    ap.add_argument("--reconcile-tables", dest="reconcile_tables", action="store_true",
                    help="tag uncertain tables (scanned/low-conf OR tie-out flagged) as 'tombstones' eligible "
                         "for an authoritative-Excel override (see reconcile_tables.py). Additive; default OFF.")
    common.add_config_args(ap)
    a = ap.parse_args()
    cfg = common.config_from_args(a)
    if getattr(a, "ocr_scanned", False): cfg.layout_ocr_scanned = True
    if getattr(a, "scanned_figures", False): cfg.scanned_figures = True
    if getattr(a, "scanned_gpu_lane", False): cfg.scanned_gpu_lane = True
    if getattr(a, "reconcile_tables", False): cfg.reconcile_tables = True
    if getattr(a, "ocr_conf_gate", None) is not None: cfg.layout_ocr_conf_gate = a.ocr_conf_gate
    inp = Path(a.inp); out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    common.configure_logging(cfg, out)
    files = [inp] if inp.is_file() else sorted(p for p in inp.rglob("*") if p.suffix.lower() == ".pdf")
    # parallel (or serial at --workers 1) + per-file isolation + resume + killable timeout
    wargs = {"cfg": cfg.asdict(), "out": str(out)}
    # P1: route scanned PDFs to the warm-model GPU lane ONLY when opt-in (--scanned-gpu-lane). Default =
    # the fast parallel CPU pool (the batched OCR win applies either way; the serial GPU lane only helps a
    # scan-heavy corpus / VRAM-tight box where forking docTR across workers would OOM).
    is_gpu = _dl_is_gpu if (cfg.layout_ocr_scanned and cfg.scanned_gpu_lane) else None
    results, _ = common.parallel_foreach(
        files, _dl_worker, wargs, label="doc-layout", errlog=str(out / "_errors.json"), cfg=cfg,
        is_gpu=is_gpu,
        done_marker=lambda fp: (common.doc_outdir(out, fp) / ".done").exists())   # sentinel, not partial output
    results = [r for r in results if r]
    common.write_status_manifest(results, out, cfg.completeness_strict)
    review_pages = [row for r in results for row in r.get("review_pages", [])]   # per-PAGE review queue
    n_rev = common.write_review_pages(review_pages, out)
    if n_rev:
        print(f"[review] {n_rev} page(s) flagged for human review -> {out/'review_pages.csv'}")
    if getattr(cfg, "reconcile_tables", False):              # G2: surface which docs have tombstones awaiting an Excel
        rq = [{"doc_key": r.get("doc_key"), "stem": r.get("stem"), "status": "PENDING_RECONCILE",
               "n_tombstones": r.get("n_tombstones", 0), "n_reconciled": 0, "best_confidence": "",
               "method": "", "sources": "", "reasons": "awaiting authoritative Excel"}
              for r in results if r.get("n_tombstones")]
        n_tomb = common.write_reconcile_queue(rq, out)
        if n_tomb:
            print(f"[reconcile] {sum(r['n_tombstones'] for r in rq)} tombstoned table(s) in {n_tomb} doc(s) "
                  f"-> {out/'reconcile_queue.csv'} (reconcile with reconcile_tables.py + an Excel)")
    if cfg.completeness_strict:
        held = sum(1 for r in results if r.get("status") != "AUTO_ACCEPT")
        print(f"[strict] {len(results)-held}/{len(results)} committed; {held} withheld -> {out/'_status.json'}")

if __name__ == "__main__":
    main()
