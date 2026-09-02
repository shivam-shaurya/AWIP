#!/usr/bin/env python3
r"""
paddle_layout.py - PaddleOCR as a PER-PAGE producer of the rig's layout.json.

WHY: the ensemble's low-confidence paddle fallback (ensemble_extract.py --paddle) needs a paddle
layout.json to fold in; nothing produced one. This is that producer (closes re-analysis gap #1).

*** NON-SOVEREIGN (PaddleOCR = Baidu). Test / fallback only. Run from the PADDLE venv
    (~/paddle-venv), NOT the rig venv. route='scanned_paddle' so tombstoning + reconcile apply. ***

Per page: PaddleOCR text -> one paragraph element; PP-Structure tables -> table elements (each
through common.verify_table). Engines are cached module singletons (no per-page model reload).
Reuses the exact PaddleOCR/PP-Structure API validated by eval/engines/paddle_extract.py.

Usage (paddle venv):
    ~/paddle-venv/bin/python paddle_layout.py --in file.pdf --out out_paddle --reconcile-tables
Then fold into the ensemble (rig venv):
    python ensemble_extract.py --docling ... --current ... --paddle out_paddle/.../*.layout.json --out ...
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import common

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval.engines import base                              # noqa: E402
from eval.engines.paddle_extract import _html_table_to_grid  # noqa: E402  (no paddle import at module load)

SOVEREIGN = False
_OCR = None
_STRUCT = None


def _ocr_engine(lang):
    global _OCR
    if _OCR is None:
        from paddleocr import PaddleOCR
        _OCR = PaddleOCR(use_angle_cls=True,
                         lang=("en" if lang.startswith("eng") else lang.split("+")[0]),
                         show_log=False)
    return _OCR


def _struct_engine():
    global _STRUCT
    if _STRUCT is None:
        from paddleocr import PPStructure
        _STRUCT = PPStructure(layout=True, table=True, ocr=True, show_log=False)
    return _STRUCT


def paddle_to_layout(pdf_path: Path, cfg, dpi: int = 200, lang: str = "eng") -> dict:
    imgs = base.rasterize_pages(str(pdf_path), dpi=dpi)
    if imgs is None:
        raise base.EngineUnavailable("PaddleOCR is image-based; input not rasterizable")
    ocr = _ocr_engine(lang)
    struct = _struct_engine()
    flag_unverified = bool(getattr(cfg, "flag_unverified_amounts", False)) if cfg else False
    pages = []
    for pno, img in enumerate(imgs, 1):
        els = []
        lines, confs = [], []
        try:                                               # text
            for page in (ocr.ocr(img, cls=True) or []):
                for ln in (page or []):
                    try:
                        lines.append(ln[1][0]); confs.append(float(ln[1][1]))
                    except Exception:
                        continue
        except Exception:
            pass
        if lines:
            els.append({"type": "paragraph", "text": "\n".join(lines)})
        try:                                               # tables (PP-Structure -> grid -> tie-out)
            for region in (struct(img) or []):
                if region.get("type") != "table":
                    continue
                grid = _html_table_to_grid((region.get("res") or {}).get("html", ""))
                if grid and common.emit_worthy(grid):
                    try:
                        flags = common.verify_table(grid, cfg, flag_unverified=flag_unverified)
                    except Exception:
                        flags = common.verify_table(grid, cfg)
                    els.append({"type": "table", "grid": grid, "tieout_flags": flags})
        except Exception:
            pass
        for i, e in enumerate(els):
            e.setdefault("id", f"pd{pno}_{i}")
            e["reading_order_index"] = i
        pages.append({"page_no": pno, "route": "scanned_paddle", "elements": els,
                      "page_conf": (round(sum(confs) / len(confs), 4) if confs else None),
                      "needs_review": any(e.get("tieout_flags") for e in els)})

    counts = {}
    for pg in pages:
        for e in pg["elements"]:
            counts[e["type"]] = counts.get(e["type"], 0) + 1
    layout = {"file": str(pdf_path), "engine": "paddle (NON-SOVEREIGN)", "pages": pages,
              "element_counts": counts,
              "status": "NEEDS_REVIEW" if any(p["needs_review"] for p in pages) else "OK"}
    if cfg and getattr(cfg, "reconcile_tables", False):
        try:
            import doc_layout
            doc_layout._tag_reconcilable_tables(layout, cfg)
        except Exception as e:
            layout.setdefault("notes", []).append(f"reconcile tag skipped ({type(e).__name__}: {e})")
    return layout


def main():
    ap = argparse.ArgumentParser(description="PaddleOCR -> rig layout.json (NON-SOVEREIGN; ensemble fallback producer).")
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", default="out_paddle")
    ap.add_argument("--dpi", type=int, default=200)
    ap.add_argument("--lang", default="eng")
    ap.add_argument("--reconcile-tables", dest="reconcile", action="store_true")
    a = ap.parse_args()
    cfg = common.ExtractConfig()
    if a.reconcile:
        setattr(cfg, "reconcile_tables", True)
    inp, outroot = Path(a.inp), Path(a.out)
    outroot.mkdir(parents=True, exist_ok=True)
    pdfs = [inp] if inp.is_file() else sorted(p for p in inp.rglob("*") if p.suffix.lower() == ".pdf")
    if not pdfs:
        print(f"No PDFs under {inp}"); return
    print(f"[paddle_layout] {len(pdfs)} pdf(s) -> {outroot}/  (NON-SOVEREIGN)")
    for p in pdfs:
        try:
            layout = paddle_to_layout(p, cfg, dpi=a.dpi, lang=a.lang)
            docdir = common.doc_outdir(outroot, p)
            docdir.mkdir(parents=True, exist_ok=True)
            common.atomic_write_text(docdir / f"{docdir.name}.layout.json",
                                     json.dumps(layout, indent=2, ensure_ascii=False))
            common.mark_done(docdir)
            print(f"  [{layout['status']:12}] {p.name[:48]:48} pages={len(layout['pages'])} "
                  f"counts={layout['element_counts']}")
        except Exception as e:
            print(f"  [ERROR] {p.name}: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
