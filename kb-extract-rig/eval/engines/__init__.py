#!/usr/bin/env python3
r"""
eval.engines - OPT-IN, pluggable multi-engine COMPARISON adapters (EVAL-ONLY).

Nothing here is imported by the production pipeline, so the default extraction path and the digital
happy-path output stay byte-identical whether or not these modules exist. Each engine is an adapter
module exposing `SOVEREIGN`, `engine_name(opt)`, `sovereignty(opt)`, and `extract(input, opt)`, and
returns the SAME result dict (see base.py) so engines are directly comparable. run_engine() times +
fully guards every call, so a missing package/GPU degrades to available=False and the run continues.

    from eval.engines import run_engine, EngineOptions, tieout
    res = run_engine("docling", "file.pdf", EngineOptions())
"""
from __future__ import annotations

from . import base
from .base import EngineOptions, EngineUnavailable, REQUIRED_KEYS, run_adapter, tieout  # noqa: F401
from . import current_extract, docling_extract, paddle_extract, vlm_extract

# registry: the names accepted by --engines
ENGINES = {
    "current": current_extract,   # sovereign baseline (this rig)
    "docling": docling_extract,   # sovereign (IBM, MIT)
    "paddle":  paddle_extract,    # TEST-ONLY / NON-SOVEREIGN (Baidu)
    "vlm":     vlm_extract,       # sovereign default backend (Florence-2); pluggable
}


def run_engine(name, input_path, opt=None):
    """Run one engine by registry name, fully guarded. Unknown name -> a clean unavailable result
    (never raises)."""
    opt = opt or EngineOptions()
    mod = ENGINES.get(name)
    if mod is None:
        return base.blank(name, False, "unknown engine",
                          reason=f"unknown engine '{name}' (have: {', '.join(sorted(ENGINES))})")
    return run_adapter(mod.engine_name(opt), mod.SOVEREIGN, mod.sovereignty(opt),
                       mod.extract, input_path, opt)
