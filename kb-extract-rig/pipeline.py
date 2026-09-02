#!/usr/bin/env python3
r"""
pipeline.py - the orchestrator / single entrypoint for the KB Extract rig.

It does ONE job: discover files, route each by type to the right family
extractor, and let common.run_batch write the per-document manifests + the
run-level review queue / summary. All the real work lives in the modules:

    pipeline.py        <- you are here (routing + CLI)
       |
       +-- pdf_extract.py    PDF native + scanned OCR ladder (the only GPU/OCR module)
       +-- excel_extract.py  XLSX/XLSM direct read = 100% exact + tie-out
       +-- docx_extract.py   DOCX direct read
       |
       +-- common.py         fields/checksums, confidence, output writer, batch driver

Two-path routing (important): .xlsx/.xlsm and .docx are structured data read
DIRECTLY (no OCR, effectively 100%); only scanned PDFs go through the OCR ladder
(which can never be 100% from any single tool -> vote + reconcile + 0.70 gate).

Run:  python pipeline.py --in samples\ --out out\ --gate 0.70 --dpi 300 --lang eng+hin+mar
Each family is ALSO runnable on its own for isolated debugging:
      python pdf_extract.py   --in samples\ --out out\
      python excel_extract.py --in file.xlsx --out out\
      python docx_extract.py  --in file.docx --out out\
"""
import argparse
from pathlib import Path

import common
from common import (run_batch, add_config_args, config_from_args, configure_logging, safe_name,
                    write_outputs, apply_external_paths)
import pdf_extract, excel_extract, docx_extract

PDF_EXT   = (".pdf",)
XLSX_EXT  = (".xlsx", ".xlsm", ".xls")     # legacy .xls read via xlrd in excel_extract
DOCX_EXT  = (".docx",)
ALL_EXT   = PDF_EXT + XLSX_EXT + DOCX_EXT

def build_dispatch(opt):
    """Return a dispatch(path, docdir, png_dir) that routes one file by type.
    Returns (family, pages, fields, chunks, text) or None to skip."""
    def dispatch(path, docdir, png_dir):
        ext = path.suffix.lower()
        if ext in PDF_EXT:
            if pdf_extract.fitz is None: raise RuntimeError("PyMuPDF (fitz) not installed")
            return ("pdf", *pdf_extract.extract_pdf(path, png_dir, opt))
        if ext in XLSX_EXT:
            return ("xlsx", *excel_extract.extract_xlsx(path, docdir))
        if ext in DOCX_EXT:
            return ("docx", *docx_extract.extract_docx(path))
        return None
    return dispatch

def _pipe_is_gpu(path):
    """Route a file to the GPU lane iff it is a PDF with ANY page lacking a text layer (a
    scanned page -> docTR). Short-circuits on the FIRST scanned page so only fully-digital
    PDFs pay a full scan. XLSX/DOCX/native PDFs are CPU and fan out freely."""
    p = Path(path)
    if p.suffix.lower() not in PDF_EXT or pdf_extract.fitz is None:
        return False
    try:
        d = pdf_extract.fitz.open(p)
        try:
            if getattr(d, "needs_pass", False):
                return False                        # encrypted -> CPU lane; worker raises a clear error
            for pg in d:
                if len((pg.get_text() or "").strip()) < 20:
                    return True                     # first scanned page -> GPU lane (short-circuit)
            return False
        finally:
            d.close()
    except Exception:
        return False

def _pipe_worker(path, args):
    """Top-level (picklable) per-file worker for the parallel path. Rebuilds cfg/opt inside the
    worker (torch/docTR import stays lazy), routes by type, and returns the summary row."""
    cfg = common.ExtractConfig(**args["cfg"])
    outroot = Path(args["outroot"]); gate = args["gate"]
    p = Path(path); stem = safe_name(p.stem)
    reason = common.oversized_reason(p, cfg)     # M3: pre-flight fence a pathological file (default off) -> review
    if reason:
        return {"file": str(p), "stem": stem, "family": p.suffix.lower().lstrip("."),
                "doc_class": common.doc_class(stem), "overall_confidence": 0.0,
                "status": "NEEDS_REVIEW", "needs_review": True, "fields": 0, "reasons": reason}
    docdir = common.doc_outdir(outroot, p); docdir.mkdir(parents=True, exist_ok=True)   # H2: collision-safe + sharded
    png_dir = docdir / "pages"
    ext = p.suffix.lower()
    if ext in PDF_EXT:
        if pdf_extract.fitz is None: raise RuntimeError("PyMuPDF (fitz) not installed")
        d = pdf_extract.fitz.open(p)
        enc = common.encrypted_reason(d); d.close()    # M4: shared encryption helper
        if enc: raise RuntimeError(enc)
        opt = pdf_extract.PdfOptions(**cfg.to_pdf_options())
        res = ("pdf", *pdf_extract.extract_pdf(p, png_dir, opt))
    elif ext in XLSX_EXT:
        res = ("xlsx", *excel_extract.extract_xlsx(p, docdir, cfg))    # M5: cfg -> zip-bomb caps
    elif ext in DOCX_EXT:
        res = ("docx", *docx_extract.extract_docx(p, cfg))             # M5: cfg -> zip-bomb caps
    else:
        return None
    family, pages, fields, chunks, text = res
    calib = common.load_calibration(cfg.conf_calibration_path)          # LEVER F (identity by default)
    return write_outputs(p, family, pages, fields, chunks, text, gate, docdir, stem, calib)

def main():
    ap = argparse.ArgumentParser(description="KB Extract pipeline: route PDF/XLSX/DOCX -> manifests + review queue.")
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--gate", type=float, default=None)
    pdf_extract.add_pdf_args(ap)            # PDF flags (--dpi/--lang/--vlm/...) stay identical to pdf_extract.py
    add_config_args(ap)                     # --config/--strict/--workers/--timeout/--resume/--log-json
    a = ap.parse_args()

    inp = Path(a.inp); outroot = Path(a.out); outroot.mkdir(parents=True, exist_ok=True)
    cfg = config_from_args(a)
    configure_logging(cfg, outroot); apply_external_paths(cfg)
    files = [inp] if inp.is_file() else sorted(p for p in inp.rglob("*") if p.suffix.lower() in ALL_EXT)
    if not files:
        print(f"No PDF/XLSX/DOCX found under {inp}"); return

    if pdf_extract.TESS_OK:
        try: avail = pdf_extract.pytesseract.get_languages(config="")
        except Exception: avail = []
        print(f"[tesseract] requested: {cfg.lang}  |  installed: {', '.join(avail) or '?'}  "
              f"(all run TOGETHER per escalated page; per-page script shown live + saved in doc.json)")
    else:
        print("[tesseract] engine not found - docTR only")

    opt = pdf_extract.PdfOptions(**cfg.to_pdf_options())
    wargs = {"cfg": cfg.asdict(), "outroot": str(outroot), "gate": cfg.hitl_gate}
    run_batch(files, build_dispatch(opt), cfg.hitl_gate, outroot, label="Extracting", cfg=cfg,
              worker=_pipe_worker, worker_args=wargs, is_gpu=_pipe_is_gpu)

if __name__ == "__main__":
    main()
