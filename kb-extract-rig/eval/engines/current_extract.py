#!/usr/bin/env python3
r"""
current_extract.py - the BASELINE adapter: wraps THE RIG's existing extraction path (docTR +
robust_tables + scanned_tables + the digital docx/xlsx readers) so it sits in the comparison as the
reference every other engine is measured against.

Sovereign (this rig: PyMuPDF + pdfplumber + robust_tables + docTR/Tesseract - no cloud, no
non-sovereign deps). Per-type routing mirrors the pipeline:
  .pdf  -> pdfplumber page: digital -> robust_tables.extract_page grids + page text;
                            scanned -> docTR text + the img2table table path (if that stack is present)
  .docx -> python-docx table cells -> grids + docx_extract text
  .xlsx -> excel_extract._read_grids sheets -> grids
  image -> docTR text + scanned_tables ruled-grid cell OCR

Everything heavy (docTR / img2table / Tesseract) is reused THROUGH the existing modules and is
lazy: if a piece isn't installed, that part degrades to empty with a clear note and the adapter
still returns available=True (the rig itself is present; it just can't OCR here).
"""
from __future__ import annotations

from pathlib import Path

from . import base

SOVEREIGN = True


def engine_name(opt):
    return "current"


def sovereignty(opt):
    return "sovereign (this rig: docTR + robust_tables)"


def extract(input_path, opt):
    import common
    p = Path(input_path)
    ext = p.suffix.lower()
    cfg = opt.cfg or common.ExtractConfig()
    if ext == ".pdf":
        return _pdf(p, opt, cfg)
    if ext == ".docx":
        return _docx(p)
    if ext in (".xlsx", ".xlsm", ".xls"):
        return _xlsx(p)
    if ext in (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"):
        return _image(p, opt)
    return {"available": True, "tables": [], "text": "", "confidence": None,
            "reason": f"current: unsupported type {ext}"}


# --------------------------------------------------------------------------- PDF
def _pdf(p, opt, cfg):
    import pdfplumber
    import fitz
    import robust_tables as RT
    import table_pdf
    items = []          # (page_no, mode, grid) -> stitched like the rig's table_pdf
    texts = []
    confs = []
    notes = []
    fdoc = fitz.open(str(p))
    try:
        with pdfplumber.open(str(p)) as pdf:
            for i, page in enumerate(pdf.pages):
                if opt.max_pages and i >= opt.max_pages:
                    break
                try:
                    if table_pdf.page_is_digital(page, cfg):
                        txt = page.extract_text() or ""
                        if txt.strip():
                            texts.append(txt)
                            confs.append(0.97)          # rig's digital-text confidence
                        tabs, _ = RT.extract_page(page)
                        for t in tabs:
                            if t.get("grid"):
                                items.append((i + 1, t.get("mode", "txt"), t["grid"]))
                    else:
                        st = _scanned_page(fdoc[i], opt, notes)
                        if st["text"].strip():
                            texts.append(st["text"])
                            confs.append(st["conf"])
                        for g in st["grids"]:
                            items.append((i + 1, "ocr", g))
                except Exception as e:
                    notes.append(f"page {i + 1}: {type(e).__name__}")
    finally:
        fdoc.close()
    merged = table_pdf.stitch(items)                    # cross-page continuation stitch (faithful)
    tables = [rows for _, _, rows in merged]
    conf = (sum(confs) / len(confs)) if confs else None
    return {"available": True, "tables": tables, "text": "\n\n".join(texts),
            "confidence": conf, "reason": "; ".join(sorted(set(notes)))}


def _scanned_page(fpage, opt, notes):
    """Reuse the rig's scanned readers: docTR for text, img2table for tables. Both lazy; if the
    stack (docTR / Tesseract / img2table) isn't installed here, degrade to empty with a note."""
    text, conf, grids = "", 0.0, []
    try:
        import pdf_extract as PE
        if PE.cv2 is None:
            raise base.EngineUnavailable("OpenCV not installed")
        rgb = PE.prep_doctr(PE.render_page(fpage, opt.dpi or 200))
        dt = PE.ocr_doctr_batch([rgb])[0]               # ImportError if docTR missing -> caught below
        text, conf = dt.get("text", ""), float(dt.get("conf", 0.0))
    except Exception:
        notes.append("scanned text OCR unavailable (docTR/OpenCV not installed)")
        rgb = None
    try:
        import tempfile
        import table_pdf
        I2TImage, ocr = table_pdf._load_ocr(opt.lang)   # img2table + a backing OCR (lazy)
        td = Path(tempfile.mkdtemp(prefix="cur_ocr_"))
        try:
            tabs = table_pdf.ocr_tables(fpage, opt.dpi or 200, str(td / "p.png"), I2TImage, ocr)
            grids = [g for g in tabs if g]
        finally:
            import shutil
            shutil.rmtree(str(td), ignore_errors=True)
    except Exception:
        notes.append("scanned tables need img2table+docTR (not installed)")
    return {"text": text, "conf": conf, "grids": grids}


# --------------------------------------------------------------------------- DOCX
def _docx(p):
    import docx as _dx
    import docx_extract
    d = _dx.Document(str(p))
    tables = []
    for tb in d.tables:
        grid = [[c.text.strip() for c in r.cells] for r in tb.rows]
        if any(any(cell for cell in row) for row in grid):
            tables.append(grid)
    _pages, _fields, _chunks, full = docx_extract.extract_docx(str(p))
    return {"available": True, "tables": tables, "text": full, "confidence": 0.97}


# --------------------------------------------------------------------------- XLSX
def _xlsx(p):
    import excel_extract as X
    grids, uncached = X._read_grids(str(p))
    tables = []
    for _name, g in (grids or {}).items():
        rows = [["" if c is None else str(c) for c in row] for row in g]
        rows = [r for r in rows if any(x.strip() for x in r)]
        if rows:
            tables.append(rows)
    text = "\n".join(" | ".join(r) for t in tables for r in t)
    reason = (f"{len(uncached)} uncached formula cell(s) - flagged, not silently blank"
              if uncached else "")
    return {"available": True, "tables": tables, "text": text, "confidence": 1.0, "reason": reason}


# --------------------------------------------------------------------------- image
def _image(p, opt):
    notes = []
    text, conf, grids = "", None, []
    rgbs = base.rasterize_pages(str(p), dpi=opt.dpi or 200)
    rgb = rgbs[0] if rgbs else None
    try:
        import pdf_extract as PE
        dt = PE.ocr_doctr_batch([rgb])[0]
        text, conf = dt.get("text", ""), float(dt.get("conf", 0.0))
    except Exception:
        notes.append("image text OCR unavailable (docTR not installed)")
    try:
        import scanned_tables as ST
        res = ST.ocr_scanned_table(rgb, lang=opt.lang)
        if res and not res.get("degenerate") and res.get("grid"):
            grids = [res["grid"]]
    except Exception:
        notes.append("image table OCR unavailable (Tesseract not installed)")
    return {"available": True, "tables": grids, "text": text, "confidence": conf,
            "reason": "; ".join(notes)}
