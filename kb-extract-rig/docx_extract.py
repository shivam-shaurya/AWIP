#!/usr/bin/env python3
r"""
docx_extract.py - the DOCX family extractor.

A .docx is structured/digital text (python-docx reads it directly), so like the
Excel path there is NO OCR and no GPU - paragraphs and table rows are read exactly
(~0.97 confidence). Emits the same (pages, fields, chunks, full_text) shape as
every other extractor so it plugs straight into the pipeline.

Standalone:   python docx_extract.py --in file.docx --out out\
Via pipeline: python pipeline.py --in folder\ --out out\
"""
import argparse
from pathlib import Path

from common import extract_fields, run_batch, zip_bomb_reason

try: import docx as _docx              # python-docx
except Exception: _docx = None

def extract_docx(path, cfg=None):
    """Return (pages, fields, chunks, full_text) for one DOCX. A zip-bomb .docx (absurd uncompressed
    size / ratio in the central directory) is fenced BEFORE python-docx decompresses it (M5)."""
    if _docx is None:
        raise RuntimeError("python-docx not installed (pip install python-docx)")
    reason = zip_bomb_reason(path, cfg)          # M5: route a decompression bomb to review, don't OOM
    if reason:
        raise RuntimeError(reason)
    d = _docx.Document(str(path)); text = []; chunks = []
    for para in d.paragraphs:
        if para.text.strip():
            chunks.append({"kind": "para", "page": 1, "text": para.text.strip(), "confidence": 0.97})
            text.append(para.text.strip())
    for tb in d.tables:
        for r in tb.rows:
            line = " | ".join(c.text.strip() for c in r.cells)
            if line.strip(" |"):
                chunks.append({"kind": "table_row", "page": 1, "text": line, "confidence": 0.97})
                text.append(line)
    pages = [{"page": 1, "route": "docx", "confidence": 0.97, "chars": len("\n".join(text)),
              "doctr_conf": None, "tess_conf": None, "agreement": 1.0, "png": None}]
    return pages, extract_fields(text), chunks, "\n".join(text)


# ============================================================================
# STANDALONE CLI (DOCX only)
# ============================================================================
def main():
    ap = argparse.ArgumentParser(description="DOCX extractor (direct read, no OCR).")
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--gate", type=float, default=0.70)
    a = ap.parse_args()
    if _docx is None: raise SystemExit("python-docx not installed (pip install python-docx)")
    inp = Path(a.inp); outroot = Path(a.out); outroot.mkdir(parents=True, exist_ok=True)
    files = [inp] if inp.is_file() else sorted(p for p in inp.rglob("*") if p.suffix.lower() == ".docx")
    if not files:
        print(f"No DOCX found under {inp}"); return

    def dispatch(path, docdir, png_dir):
        return ("docx", *extract_docx(path))
    run_batch(files, dispatch, a.gate, outroot, label="DOCX extract")

if __name__ == "__main__":
    main()
