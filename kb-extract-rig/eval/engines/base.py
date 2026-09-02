#!/usr/bin/env python3
r"""
base.py - the common engine-adapter interface for the OPT-IN multi-engine comparison harness.

EVAL-ONLY. Nothing in eval/engines is imported by the production pipeline (pipeline.py /
pdf_extract.py / common.py), so the default extraction path and the digital happy-path output
stay byte-identical whether or not these modules exist.

Every adapter returns the SAME result dict so engines are directly comparable:

    {
      "engine":      str,          # "current" | "docling" | "paddle" | "vlm:florence" | ...
      "sovereign":   bool,         # True for sovereign engines; False for test-only/non-sovereign
      "sovereignty": str,          # human label, e.g. "TEST-ONLY / NON-SOVEREIGN (PaddleOCR, Baidu)"
      "available":   bool,         # False when the package / model / GPU isn't installed here
      "reason":      str,          # why unavailable, or a degradation/error note (may be "")
      "tables":      [grid],       # list of list[list[str]] grids (rig's grid shape)
      "text":        str,          # extracted full text
      "confidence":  float|None,   # mean engine confidence (None if the engine has no native one)
      "seconds":     float,        # wall-clock for this engine on this file
    }

run_adapter() times + FULLY guards each adapter call: a missing package (ImportError) or an
EngineUnavailable degrades to available=False with a reason; any other error is recorded but the
engine still counts as "available" (it ran, this one file failed) - one bad file never aborts the
comparison. verify_table (the arithmetic tie-out) is applied by the harness to EVERY engine's
grids via tieout() below, so no engine bypasses the completeness guarantee.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

REQUIRED_KEYS = ("engine", "sovereign", "sovereignty", "available", "reason",
                 "tables", "text", "confidence", "seconds")

# imports that mean "this engine can't run here" (degrade, don't crash)
_UNAVAILABLE = (ImportError, ModuleNotFoundError, OSError)


class EngineUnavailable(Exception):
    """Raised by an adapter (or its lazy import) to signal the engine can't run in this environment
    - package / model weights / GPU missing, or the input type isn't rasterizable for that engine.
    Caught by run_adapter -> available=False, and the harness continues with the other engines."""


@dataclass
class EngineOptions:
    """Shared, engine-neutral knobs. Kept tiny + additive so adapters stay comparable."""
    dpi: int = 200                 # raster DPI for image-based engines (paddle / vlm / scanned current)
    lang: str = "eng"              # OCR language hint (Tesseract/docTR/scanned_tables)
    vlm_backend: str = "florence"  # which VLM in vlm_extract (florence=sovereign default)
    max_pages: int = 0             # 0 = all pages; cap for speed on huge scans
    cfg: object = None             # optional common.ExtractConfig (built lazily by adapters if None)


# --------------------------------------------------------------------------- result shaping
def _grid_norm(tables):
    """Coerce any engine's tables into list[list[str]] grids (None -> ""). Drops fully empty grids."""
    out = []
    for t in tables or []:
        rows = [["" if c is None else str(c) for c in row] for row in t]
        if any(any(str(c).strip() for c in row) for row in rows):
            out.append(rows)
    return out


def blank(engine, sovereign, sovereignty, reason=""):
    """An 'engine not available here' result (empty, never raises)."""
    return {"engine": engine, "sovereign": bool(sovereign), "sovereignty": sovereignty,
            "available": False, "reason": reason, "tables": [], "text": "",
            "confidence": None, "seconds": 0.0}


def result(engine, sovereign, sovereignty, *, tables=None, text="", confidence=None,
           seconds=0.0, available=True, reason=""):
    """Normalize one adapter's raw output into the shared, comparable result dict."""
    return {"engine": engine, "sovereign": bool(sovereign), "sovereignty": sovereignty,
            "available": bool(available), "reason": reason or "",
            "tables": _grid_norm(tables), "text": str(text or ""),
            "confidence": (None if confidence is None else round(float(confidence), 4)),
            "seconds": round(float(seconds), 3)}


def run_adapter(engine, sovereign, sovereignty, fn, input_path, opt):
    """Time + fully guard ONE adapter. fn(input_path, opt) -> dict(tables,text,confidence[,available,reason]).

    - ImportError / ModuleNotFoundError / OSError / EngineUnavailable -> available=False (not installed
      here / input not supported), harness continues.
    - any other Exception -> available=True but reason='error: ...' with empty tables (the engine IS
      installed, it just failed on this one file) so one bad file/page never aborts the run.
    NEVER raises."""
    t0 = time.perf_counter()
    try:
        out = fn(input_path, opt) or {}
    except (EngineUnavailable, *_UNAVAILABLE) as e:
        r = blank(engine, sovereign, sovereignty,
                  reason=f"unavailable: {type(e).__name__}: {str(e)[:200]}")
        r["seconds"] = round(time.perf_counter() - t0, 3)
        return r
    except Exception as e:  # ran, but failed on this file
        return result(engine, sovereign, sovereignty, tables=[], text="", confidence=None,
                      seconds=time.perf_counter() - t0, available=True,
                      reason=f"error: {type(e).__name__}: {str(e)[:200]}")
    return result(engine, sovereign, sovereignty,
                  tables=out.get("tables"), text=out.get("text", ""),
                  confidence=out.get("confidence"), seconds=time.perf_counter() - t0,
                  available=out.get("available", True), reason=out.get("reason", ""))


# --------------------------------------------------------------------------- the tie-out (shared)
def tieout(tables, cfg=None):
    """Run the rig's ONE arithmetic tie-out (common.verify_table) over EVERY grid an engine produced.
    Returns a summary so the harness can print pass/fail per engine. `pass` = no real reconcile
    FAILURE (numeric-gap / dropped-row); merged-cell / not-verified / digit-fix are data-quality
    flags, surfaced but not counted as tie-out failures (same split the production writer uses).
    No engine bypasses this - OCR/VLM numbers are flagged, never silently trusted."""
    import common
    flags = []
    for g in tables or []:
        flags.extend(common.verify_table(g, cfg, flag_unverified=True))
    soft = ("merged_cell", "not_verified", "digit_fix")
    real = [f for f in flags if f.get("kind") not in soft]
    return {
        "pass": len(real) == 0,
        "real_gaps": len(real),
        "merged_cell": sum(1 for f in flags if f.get("kind") == "merged_cell"),
        "not_verified": sum(1 for f in flags if f.get("kind") == "not_verified"),
        "flags_total": len(flags),
    }


# --------------------------------------------------------------------------- rasterization (shared)
def rasterize_pages(path, dpi=200, max_pages=0):
    """PDF pages / a single image file -> list of RGB numpy arrays, for the image-based engines
    (paddle / vlm / the scanned 'current' path). Returns None for non-raster types (docx/xlsx) so
    the caller can report a clean 'not rasterized' note. Raises EngineUnavailable when the raster
    stack (PyMuPDF / OpenCV / PIL) needed for THIS input is missing."""
    p = Path(path)
    ext = p.suffix.lower()
    if ext == ".pdf":
        try:
            import fitz
            import numpy as np
        except Exception as e:
            raise EngineUnavailable(f"PyMuPDF/numpy needed to rasterize PDF: {e}")
        out = []
        doc = fitz.open(str(p))
        try:
            for i, page in enumerate(doc):
                if max_pages and i >= max_pages:
                    break
                pix = page.get_pixmap(dpi=dpi)
                arr = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
                if pix.n == 4:
                    arr = arr[:, :, :3]
                elif pix.n == 1:
                    arr = np.repeat(arr, 3, axis=2)
                out.append(np.ascontiguousarray(arr))
        finally:
            doc.close()
        return out
    if ext in (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"):
        try:
            import cv2
            bgr = cv2.imread(str(p))
            if bgr is not None:
                return [cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)]
        except Exception:
            pass
        try:
            import numpy as np
            from PIL import Image
            return [np.asarray(Image.open(str(p)).convert("RGB"))]
        except Exception as e:
            raise EngineUnavailable(f"no image decoder (OpenCV/PIL) available: {e}")
    return None
