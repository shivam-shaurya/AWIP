#!/usr/bin/env python3
r"""
paddle_extract.py - PaddleOCR adapter.

*** TEST-ONLY / NON-SOVEREIGN ***  PaddleOCR is a Baidu (China) project. It is included in this
harness for ACCURACY COMPARISON ONLY and is clearly labelled non-sovereign in every output. It must
never become part of the shipping pipeline for a sovereign deployment.

Image-based engine: PDF pages / images are rasterized (base.rasterize_pages). Text + per-line
confidence come from PaddleOCR; table STRUCTURE comes from PP-Structure (HTML -> grid, parsed with
the stdlib html.parser, no lxml/bs4 dependency). DOCX/XLSX are not rasterized -> reported N/A.

Lazy import: if `paddleocr` isn't installed, run_adapter degrades this engine to available=False.
The PaddleOCR / PP-Structure API varies across versions; each stage is guarded so a version
mismatch is recorded as a note rather than aborting the comparison.

Install (CPU, for COMPARISON ONLY):  pip install paddlepaddle paddleocr
"""
from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path

from . import base

SOVEREIGN = False


def engine_name(opt):
    return "paddle"


def sovereignty(opt):
    return "TEST-ONLY / NON-SOVEREIGN (PaddleOCR, Baidu / China)"


def extract(input_path, opt):
    import paddleocr   # noqa: F401  -- availability probe FIRST so a not-installed engine reads
    #                                    UNAVAILABLE consistently for EVERY input type (not just PDFs)
    imgs = base.rasterize_pages(str(input_path), dpi=opt.dpi or 200, max_pages=opt.max_pages)
    if imgs is None:
        return {"available": True, "tables": [], "text": "", "confidence": None,
                "reason": f"PaddleOCR is image-based; {Path(input_path).suffix} not rasterized "
                          f"for comparison (non-sovereign / test-only)"}

    notes = ["NON-SOVEREIGN engine (Baidu) - comparison only, never shipped"]
    text_lines, confs = _ocr_text(imgs, opt, notes)
    tables = _structure_tables(imgs, opt, notes)
    conf = (sum(confs) / len(confs)) if confs else None
    return {"available": True, "tables": tables, "text": "\n".join(text_lines),
            "confidence": conf, "reason": "; ".join(notes)}


def _ocr_text(imgs, opt, notes):
    """PaddleOCR text + per-line confidence (Paddle DOES expose a confidence per detected line)."""
    lines, confs = [], []
    try:
        from paddleocr import PaddleOCR
        lang = "en" if opt.lang.startswith("eng") else opt.lang.split("+")[0]
        ocr = PaddleOCR(use_angle_cls=True, lang=lang, show_log=False)
        for img in imgs:
            res = ocr.ocr(img, cls=True)
            for page in (res or []):
                for line in (page or []):
                    try:
                        txt, c = line[1][0], float(line[1][1])
                    except Exception:
                        continue
                    lines.append(txt)
                    confs.append(c)
    except Exception as e:
        notes.append(f"paddle text OCR failed ({type(e).__name__})")
    return lines, confs


def _structure_tables(imgs, opt, notes):
    """PP-Structure table recognition -> HTML -> grid."""
    tables = []
    try:
        from paddleocr import PPStructure
        engine = PPStructure(layout=True, table=True, ocr=True, show_log=False)
        for img in imgs:
            for region in (engine(img) or []):
                if region.get("type") != "table":
                    continue
                html = (region.get("res") or {}).get("html", "")
                grid = _html_table_to_grid(html)
                if grid:
                    tables.append(grid)
    except Exception as e:
        notes.append(f"paddle PP-Structure table recog failed ({type(e).__name__})")
    return tables


class _TableHTMLParser(HTMLParser):
    """Minimal <table> -> list[list[str]] (first table). Handles <tr>/<td>/<th>; ignores colspan
    (a merged header cell just lands once - the tie-out and metrics tolerate ragged rows)."""

    def __init__(self):
        super().__init__()
        self.rows = []
        self._row = None
        self._cell = None
        self._buf = []

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th"):
            self._cell = True
            self._buf = []

    def handle_data(self, data):
        if self._cell:
            self._buf.append(data)

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._row is not None:
            self._row.append(" ".join("".join(self._buf).split()))
            self._cell = False
            self._buf = []
        elif tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None


def _html_table_to_grid(html):
    if not html:
        return []
    try:
        p = _TableHTMLParser()
        p.feed(html)
        return [r for r in p.rows if any(c.strip() for c in r)]
    except Exception:
        return []
