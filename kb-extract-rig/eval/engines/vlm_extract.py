#!/usr/bin/env python3
r"""
vlm_extract.py - vision-LLM adapter, pluggable BACKEND registry.

Default backend `florence` REUSES the rig's already-wired Florence-2 path
(pdf_extract.ocr_florence) - SOVEREIGN (Microsoft, MIT). Florence-2's <OCR> task returns page
TEXT only (no table structure), so #tables = 0 for that backend; the value here is a sovereign
VLM text reading to compare against docTR/Docling on hard pages. GPU-only in practice (falls back
to CPU but very slow); if torch/transformers/weights aren't present the engine degrades to
available=False.

Adding a second VLM later is a one-line registry entry - each backend is `fn(rgb) -> {text,
confidence, tables, note}`:
  - `llama32v`  : Llama-3.2-Vision (Meta) - SOVEREIGN, scaffolded (raises EngineUnavailable until wired)
  - `qwen2vl`   : Qwen2-VL (Alibaba)       - *** NON-SOVEREIGN / test-only ***, scaffolded
A table-capable backend (prompted for structured rows) would return grids in `tables`, which the
harness then tie-outs like any other engine - OCR/VLM numbers are never auto-committed.
"""
from __future__ import annotations

from pathlib import Path

from . import base

# Sovereign default (Florence-2). The *engine's* sovereignty is resolved per-backend below.
SOVEREIGN = True

# per-backend sovereignty (Florence=Microsoft, Llama=Meta -> sovereign; Qwen=Alibaba -> not)
_BACKEND_SOVEREIGN = {"florence": True, "llama32v": True, "qwen2vl": False}


def engine_name(opt):
    return f"vlm:{opt.vlm_backend}"


def sovereignty(opt):
    b = opt.vlm_backend
    if _BACKEND_SOVEREIGN.get(b, True):
        note = {"florence": "Florence-2, Microsoft, MIT",
                "llama32v": "Llama-3.2-Vision, Meta"}.get(b, b)
        return f"sovereign (VLM backend: {note})"
    return f"TEST-ONLY / NON-SOVEREIGN (VLM backend: {b})"


def _probe(backend):
    """Availability probe run BEFORE rasterization so a VLM whose stack/weights aren't installed reads
    UNAVAILABLE consistently for every input type (not only for rasterizable ones)."""
    if backend == "florence":
        import torch          # noqa: F401  (ImportError/DLL failure -> unavailable)
        import transformers   # noqa: F401
    elif backend == "llama32v":
        raise base.EngineUnavailable(
            "llama-3.2-vision backend not implemented yet (sovereign scaffold - add weights + prompt)")
    elif backend == "qwen2vl":
        raise base.EngineUnavailable(
            "qwen2-vl backend not implemented (NON-SOVEREIGN / Alibaba - comparison-only scaffold)")


def extract(input_path, opt):
    backend = _BACKENDS.get(opt.vlm_backend)
    if backend is None:
        raise base.EngineUnavailable(
            f"unknown VLM backend '{opt.vlm_backend}' (have: {', '.join(sorted(_BACKENDS))})")
    _probe(opt.vlm_backend)
    imgs = base.rasterize_pages(str(input_path), dpi=opt.dpi or 200, max_pages=opt.max_pages)
    if imgs is None:
        return {"available": True, "tables": [], "text": "", "confidence": None,
                "reason": f"VLM is image-based; {Path(input_path).suffix} not rasterized"}

    texts, grids, notes = [], [], []
    for img in imgs:
        out = backend(img)                       # ImportError/OOM here -> caught by run_adapter
        if out.get("text"):
            texts.append(out["text"])
        grids += out.get("tables", []) or []
        if out.get("note"):
            notes.append(out["note"])
    return {"available": True, "tables": grids, "text": "\n\n".join(texts),
            "confidence": None, "reason": "; ".join(sorted(set(notes)))}


# --------------------------------------------------------------------------- backends
def _florence(rgb):
    """Reuse the EXISTING Florence-2 wiring in pdf_extract (torch/transformers imported lazily
    there). <OCR> = text only, so no table grids."""
    import pdf_extract as PE
    r = PE.ocr_florence(rgb)                      # ImportError(torch) / OOM -> propagates -> unavailable
    return {"text": r.get("text", ""), "confidence": None, "tables": [],
            "note": "Florence-2 <OCR> = TEXT only; no table structure (#tables=0). "
                    "Register a table-prompted VLM backend to score tables."}


def _llama32v(rgb):
    raise base.EngineUnavailable(
        "llama-3.2-vision backend not implemented yet (sovereign scaffold - add weights + prompt here)")


def _qwen2vl(rgb):
    raise base.EngineUnavailable(
        "qwen2-vl backend not implemented (NON-SOVEREIGN / Alibaba - comparison-only scaffold)")


_BACKENDS = {
    "florence": _florence,
    "llama32v": _llama32v,
    "qwen2vl": _qwen2vl,
}
