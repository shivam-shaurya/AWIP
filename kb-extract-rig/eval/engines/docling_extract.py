#!/usr/bin/env python3
r"""
docling_extract.py - IBM Docling adapter (SOVEREIGN: IBM, MIT-licensed, CPU-OK).

Docling converts PDF / DOCX / image / XLSX into a structured document with table cells + text.
Lazy import: if `docling` isn't installed, run_adapter degrades this engine to available=False and
the harness continues. Docling exposes no per-cell confidence, so `confidence` is reported as None
(shown as "-" in the report). Tables still go through the harness tie-out like every other engine.

Install (CPU):  pip install docling
"""
from __future__ import annotations

from pathlib import Path

SOVEREIGN = True


def engine_name(opt):
    return "docling"


def sovereignty(opt):
    return "sovereign (IBM Docling, MIT)"


def extract(input_path, opt):
    from docling.document_converter import DocumentConverter   # ImportError -> unavailable

    conv = DocumentConverter()
    res = conv.convert(str(input_path))
    doc = res.document

    tables = []
    for t in (getattr(doc, "tables", None) or []):
        grid = _table_to_grid(t)
        if grid:
            tables.append(grid)

    text = ""
    for meth in ("export_to_markdown", "export_to_text"):
        fn = getattr(doc, meth, None)
        if fn is None:
            continue
        try:
            text = fn()
            break
        except Exception:
            continue

    return {"available": True, "tables": tables, "text": text, "confidence": None,
            "reason": "docling has no per-cell confidence (reported as -)"}


def _table_to_grid(t):
    """A Docling TableItem -> list[list[str]]. Prefer the pandas dataframe (header + body); fall
    back to the raw TableData cell grid. Defensive across Docling versions - any failure -> []."""
    # 1) dataframe path (includes the header row)
    try:
        df = t.export_to_dataframe()
        header = [("" if c is None else str(c)) for c in list(df.columns)]
        body = [[("" if v is None else str(v)) for v in row] for row in df.values.tolist()]
        header_real = [h for h in header if h and not h.lower().startswith("unnamed")]
        return ([header] + body) if header_real else body
    except Exception:
        pass
    # 2) raw TableData cell grid
    try:
        data = t.data
        nrows = int(getattr(data, "num_rows", 0))
        ncols = int(getattr(data, "num_cols", 0))
        cells = getattr(data, "table_cells", None) or getattr(data, "cells", None) or []
        if nrows and ncols:
            grid = [["" for _ in range(ncols)] for _ in range(nrows)]
            for cell in cells:
                r0 = int(getattr(cell, "start_row_offset_idx", getattr(cell, "row", 0)) or 0)
                c0 = int(getattr(cell, "start_col_offset_idx", getattr(cell, "col", 0)) or 0)
                if 0 <= r0 < nrows and 0 <= c0 < ncols:
                    grid[r0][c0] = str(getattr(cell, "text", "") or "")
            return grid
    except Exception:
        pass
    return []
