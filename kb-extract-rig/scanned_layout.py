#!/usr/bin/env python3
r"""
scanned_layout.py - reconstruct the SAME typed-element stream as doc_layout, but for SCANNED
pages, from OCR words-with-geometry (pdf_extract.ocr_page_words). Sovereign stack only
(docTR / Tesseract + OpenCV); no cloud, no new system dependency.

Per scanned page:
  1 OCR with geometry   pdf_extract.ocr_page_words(page)  -> words in POINTS + page_conf + rgb
  2 tables first        scanned_tables.ocr_scanned_table (ruled, per-cell, server) AND
                        robust_tables.borderless_table (from the OCR words), both gated by the
                        rig's anti-fabrication guards; the consumed words are subtracted
  3 lines -> classify   _words_to_lines -> doc_layout._classify_line (median word HEIGHT stands
                        in for font size) -> the SAME heading/paragraph/list_item elements
  4 figures             large non-text raster regions (few word centers inside) -> figdir
                        (OFF by default - cfg.scanned_figures)
  5 links / QR          attached by doc_layout via links_qr (QR runs on this page's raster)
  6 fallback            low page_conf / no words -> one paragraph + low_conf -> page to review

Coordinate frame = the prepped (uprighted+deskewed) raster mapped to POINTS (72/dpi); the page's
width/height = prepped raster size in points. Internally consistent - a scan has no fitz text
frame to co-register with, so we never attempt an error-prone inverse-affine.

doc_layout runs the SHARED _order -> _merge_* -> id/section assignment on the returned elements,
so a scanned page emits a stream byte-compatible with a digital one. doc_layout is imported
LAZILY inside the functions to avoid an import cycle (doc_layout imports this module).
"""

import robust_tables as RT
import common

try: import pdf_extract as PE
except Exception: PE = None
try: import scanned_tables as ST
except Exception: ST = None
try: import cv2
except Exception: cv2 = None
try: import numpy as np
except Exception: np = None


# ============================================================================
# words -> lines (the height-proxy that replaces font size on scans)
# ============================================================================
def _words_to_lines(words):
    """OCR words (each {text, conf, bbox[points]}) -> text lines {text,bbox,size,bold,conf}.
    Greedy y-band clustering; size = MEDIAN word-box HEIGHT in points (scans carry no font
    metadata, so height is the size proxy); bold is unknown on a scan -> False."""
    if not words:
        return []
    rows = []
    for w in sorted(words, key=lambda w: w["bbox"][1]):
        b = w["bbox"]; h = b[3] - b[1]; cy = (b[1] + b[3]) / 2
        for r in rows:
            if abs(cy - r["cy"]) <= 0.6 * max(h, r["h"], 1.0):
                r["items"].append(w)
                r["cy"] = sum((x["bbox"][1] + x["bbox"][3]) / 2 for x in r["items"]) / len(r["items"])
                hh = sorted(x["bbox"][3] - x["bbox"][1] for x in r["items"]); r["h"] = hh[len(hh) // 2]
                break
        else:
            rows.append({"cy": cy, "h": h, "items": [w]})
    out = []
    for r in rows:
        it = sorted(r["items"], key=lambda w: w["bbox"][0])
        text = " ".join(w["text"] for w in it).strip()
        if not text:
            continue
        heights = sorted(w["bbox"][3] - w["bbox"][1] for w in it)
        out.append({"text": text,
                    "bbox": [min(w["bbox"][0] for w in it), min(w["bbox"][1] for w in it),
                             max(w["bbox"][2] for w in it), max(w["bbox"][3] for w in it)],
                    "size": round(heights[len(heights) // 2], 1), "bold": False,
                    "conf": min((w.get("conf", 1.0) for w in it), default=1.0)})
    out.sort(key=lambda l: l["bbox"][1])
    return out

def _line_words(words):
    """OCR words (points) -> robust_tables word dicts {text,x0,x1,top,bottom} for borderless_table."""
    return [{"text": w["text"], "x0": w["bbox"][0], "top": w["bbox"][1],
             "x1": w["bbox"][2], "bottom": w["bbox"][3]} for w in words]

def _center_in(b, box):
    cx = (b[0] + b[2]) / 2; cy = (b[1] + b[3]) / 2
    return box[0] <= cx <= box[2] and box[1] <= cy <= box[3]


# ============================================================================
# tables: ruled (real lines on the raster) + borderless (from the OCR words)
# ============================================================================
def _scanned_tables(words, rgb, scale, cfg):
    """Build table elements and the set of word indices they consume.
      (a) RULED: scanned_tables.ocr_scanned_table on the (already deskewed) raster - real ruling
          lines + per-cell digit-whitelist OCR (needs Tesseract; degrades to nothing on a laptop).
      (b) BORDERLESS: robust_tables.borderless_table on the remaining words, accepted ONLY with a
          STRONG numeric grid (>=2 numeric columns) so a prose/heading page can never be
          fabricated into a table. Each table carries the money tie-out (common.verify_table)."""
    tbls, consumed = [], set()
    lang = ((cfg.lang if cfg else None) or "eng")
    # (a) ruled grid via per-cell OCR
    if ST is not None and cv2 is not None and rgb is not None:
        try:
            res = ST.ocr_scanned_table(rgb, lang=lang, deskew_first=False)
            grid = res.get("grid") or []
            if not res.get("degenerate") and RT.is_tabular(grid):
                xs, ys = res["xs"], res["ys"]
                bbox = [xs[0] * scale, ys[0] * scale, xs[-1] * scale, ys[-1] * scale]
                tbls.append({"type": "table", "bbox": bbox, "grid": grid, "mode": "ruled-scanned",
                             "tieout_flags": common.verify_table(grid, cfg, flag_unverified=True)})
                for i, w in enumerate(words):
                    if _center_in(w["bbox"], bbox):
                        consumed.add(i)
        except Exception:
            pass
    # (b) borderless reconstruction from the words the ruled table didn't claim
    rem_idx = [i for i in range(len(words)) if i not in consumed]
    rem = [words[i] for i in rem_idx]
    if rem:
        try:
            grid, placed, merges = RT.borderless_table(_line_words(rem))
            rows = [r for r in grid if any((c or "").strip() for c in r)]
            ncols = max((len(r) for r in rows), default=0)
            # borderless_table places EVERY word, so accepting a grid consumes the whole page. To
            # never collapse number-sprinkled PROSE into a fake table (and drop its headings), the
            # gate is intentionally STRICTER than the digital path: the shared is_tabular guard AND
            # >=2 numeric columns AND a DENSITY floor (a real grid fills most rows with >=2 cells;
            # prose split by stray whitespace yields sparse rows and is rejected back to text).
            dense = bool(rows) and sum(1 for r in rows if sum(1 for c in r if (c or "").strip()) >= 2) >= 0.6 * len(rows)
            if (rows and ncols >= 2 and RT.is_tabular(grid)
                    and RT._numeric_columns(rows, ncols) >= 2 and dense):
                bbox = [min(w["bbox"][0] for w in rem), min(w["bbox"][1] for w in rem),
                        max(w["bbox"][2] for w in rem), max(w["bbox"][3] for w in rem)]
                tbls.append({"type": "table", "bbox": bbox, "grid": grid, "mode": "borderless-scanned",
                             "tieout_flags": common.verify_table(grid, cfg, flag_unverified=True)})
                for p in placed:
                    consumed.add(rem_idx[p])
        except Exception:
            pass
    return tbls, consumed


# ============================================================================
# figures (OFF by default): large non-text raster regions
# ============================================================================
def _scanned_figures(rgb, words, scale, figdir, page_no):
    """Sizeable raster regions with FEW OCR word centers inside -> figure/raster crops. Conservative
    (only big, sparse-text boxes; when unsure emit nothing - a missed figure is cosmetic)."""
    if cv2 is None or np is None or rgb is None:
        return []
    H, W = rgb.shape[:2]
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    inv = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)[1]
    inv = cv2.morphologyEx(inv, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (25, 25)))
    cnts = cv2.findContours(inv, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]
    wpts = [((w["bbox"][0] + w["bbox"][2]) / 2 / scale, (w["bbox"][1] + w["bbox"][3]) / 2 / scale) for w in words]
    figs = []
    for k, c in enumerate(cnts, 1):
        x, y, ww, hh = cv2.boundingRect(c)
        area = ww * hh
        if area < 0.04 * W * H or area > 0.9 * W * H or ww < 0.08 * W or hh < 0.05 * H:
            continue
        if sum(1 for (cx, cy) in wpts if x <= cx <= x + ww and y <= cy <= y + hh) > 4:
            continue                                       # text region, not a figure
        path = None
        try:
            figdir.mkdir(parents=True, exist_ok=True)
            path = str(figdir / f"p{page_no}_scanfig{k}.png")
            cv2.imwrite(path, cv2.cvtColor(rgb[y:y + hh, x:x + ww], cv2.COLOR_RGB2BGR))
        except Exception:
            path = None
        figs.append({"type": "figure", "subtype": "raster",
                     "bbox": [x * scale, y * scale, (x + ww) * scale, (y + hh) * scale],
                     "image_path": path, "is_decorative": area > 0.6 * W * H})
    return figs


# ============================================================================
# PUBLIC: one scanned page -> (elements, meta)
# ============================================================================
def scanned_page_elements(fitz_page, page_no, opt, cfg, figdir, toc_map, words_result=None):
    """Reconstruct one scanned page's element stream. Returns (elements, meta) where elements are
    UN-ordered/UN-merged typed dicts (same schema as the digital path) and meta carries
    width/height (points), page_conf, engine, low_conf, the page raster (rgb, for links/QR), and
    per-page review reasons. doc_layout runs the shared _order/_merge/_assign afterwards.

    `words_result` (P1): when doc_layout pre-OCRs the document's scanned pages in ONE batched docTR
    pass, it passes that page's word result here - we then re-render ONLY the raster (cheap, for
    tables/figures/QR), skipping the per-page docTR call. None -> the per-page path (OCR here)."""
    import doc_layout as DL                              # lazy: breaks the import cycle
    gate = (getattr(cfg, "layout_ocr_conf_gate", 0.70) if cfg else 0.70)
    dpi = (opt.dpi if opt else 300)
    if PE is None:                                       # no OCR stack -> degrade to the old stub
        return [], {"width": fitz_page.rect.width, "height": fitz_page.rect.height,
                    "page_conf": 0.0, "engine": None, "low_conf": True, "rgb": None,
                    "reasons": ["scanned page: OCR stack unavailable"]}
    if words_result is not None:                         # BATCHED path: OCR already done upstream
        res = words_result
        try:
            rgb, _s = PE.render_prep_for_layout(fitz_page, dpi)   # re-render the raster for tables/figures/QR
        except Exception:
            rgb = None
    else:                                                # per-page path: OCR this page now
        res = PE.ocr_page_words(fitz_page, opt)
        rgb = res.get("rgb")
    words = res.get("words") or []
    page_conf = res.get("page_conf", 0.0)
    w_pts, h_pts = res.get("size_pts", (fitz_page.rect.width, fitz_page.rect.height))
    scale = 72.0 / float(dpi)
    reasons, els = [], []
    # tables first, then subtract the words they consumed
    tbls, consumed = _scanned_tables(words, rgb, scale, cfg)
    for t in tbls:
        els.append(t)
        if t.get("tieout_flags"):
            reasons.append("table tie-out / arithmetic flag(s)")
    rem = [w for i, w in enumerate(words) if i not in consumed]
    # remaining words -> lines -> classify (height proxy for font size)
    lines = _words_to_lines(rem)
    if lines:
        modal = DL._modal_size(lines)
        bigger = sorted({l["size"] for l in lines if l["size"] > modal}, reverse=True)
        size_ranks = {s: r + 1 for r, s in enumerate(bigger)}
        for ln in lines:
            cl = DL._classify_line(ln, modal, size_ranks, toc_map)
            if cl:
                els.append({**cl, "bbox": ln["bbox"], "text": ln["text"]})
    # figures (off by default)
    if cfg and getattr(cfg, "scanned_figures", False) and rgb is not None:
        try:
            els += _scanned_figures(rgb, words, scale, figdir, page_no)
        except Exception:
            pass
    # fallback + low-confidence routing (never fabricate structure on an unreadable scan)
    has_content = any(e["type"] in ("heading", "paragraph", "list_item", "table", "figure") for e in els)
    low_conf = (page_conf < gate) or (not words)
    if not has_content:
        joined = " ".join(w["text"] for w in words).strip()
        els.append({"type": "paragraph", "bbox": [0.0, 0.0, w_pts, h_pts], "text": joined})
        if not joined:
            reasons.append("scanned page: no text recovered (OCR empty)")
    if low_conf:
        reasons.append("scanned page low OCR confidence (%.2f < %.2f)" % (page_conf, gate))
    meta = {"width": w_pts, "height": h_pts, "page_conf": page_conf, "engine": res.get("engine"),
            "low_conf": low_conf, "rgb": rgb, "scale": scale, "reasons": reasons}
    return els, meta
