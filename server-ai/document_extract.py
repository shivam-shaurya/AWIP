"""Wraps the kb-extract-rig batch extraction engine (../kb-extract-rig) for use
as a synchronous, per-request HTTP call instead of its native folder-in/folder-out
batch CLI. CPU-only: no torch/docTR/Florence-2/Docling/PaddleOCR/MPXJ — those are
all lazily-imported inside kb-extract-rig itself and degrade gracefully when
absent (docTR/Tesseract missing -> pages route to review instead of crashing).
"""
import shutil
import sys
import tempfile
from pathlib import Path

KB_EXTRACT_RIG_PATH = Path(__file__).resolve().parent.parent / "kb-extract-rig"
if str(KB_EXTRACT_RIG_PATH) not in sys.path:
    sys.path.insert(0, str(KB_EXTRACT_RIG_PATH))

import common as kb_common  # noqa: E402
import docx_extract  # noqa: E402
import excel_extract  # noqa: E402
import pdf_extract  # noqa: E402

SUPPORTED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".docx", ".xlsx", ".xlsm"}

_CFG = kb_common.ExtractConfig()
_PDF_OPTS = pdf_extract.PdfOptions(**_CFG.to_pdf_options())


def _build_result(path: Path, family: str, pages: list, fields: dict, chunks: list, full_text: str, gate: float) -> dict:
    """Mirrors the in-memory confidence/completeness logic of
    kb-extract-rig/common.py::write_outputs (lines ~1099-1147) without its
    disk-write side effects — this runs per HTTP request, not per batch file."""
    num_pages = [p for p in pages if isinstance(p.get("confidence"), (int, float))]
    if num_pages:
        wsum = sum(max(p.get("chars", 0), 1) for p in num_pages)
        ocr_conf = round(sum(p["confidence"] * max(p.get("chars", 0), 1) for p in num_pages) / wsum, 3)
    else:
        ocr_conf = 0.0

    hard = ("pan", "gstin", "ifsc", "aadhaar")
    hard_fail = [k for k, f in fields.items() if k in hard and f.get("reconciled") is False]
    dropped_pages = sum(
        1 for p in pages
        if p.get("route") == "scanned_no_cv2" or (isinstance(p.get("confidence"), (int, float)) and p["confidence"] == 0.0)
    )
    tie_fail = sum(1 for p in pages if p.get("tieout_failed"))
    tie_not_run = sum(1 for p in pages if p.get("tieout_not_attempted"))
    uncached = sum(p.get("uncached_formulas", 0) for p in pages)

    overall = ocr_conf
    low_pages = [p["page"] for p in pages if isinstance(p.get("confidence"), (int, float)) and p["confidence"] < gate]

    extra = []
    if uncached:
        extra.append(f"{uncached} formula cell(s) have no cached value — open/recalc the source workbook")
    if tie_not_run:
        extra.append("money tie-out not attempted — amounts present but no total row detected")
    if overall < gate:
        extra.append(f"mean OCR confidence {overall:.2f} < gate {gate} (install Tesseract for scanned pages)")
    for k in hard_fail:
        extra.append(f"{k} failed checksum")
    if low_pages:
        extra.append(f"{len(low_pages)} page(s) below gate: {low_pages[:10]}")

    status, reasons = kb_common.completeness_status(tieout_gaps=tie_fail, dropped_pages=dropped_pages, extra_reasons=extra)
    needs_review = status == "NEEDS_REVIEW"

    return {
        "family": family,
        "overall_confidence": round(overall, 3),
        "status": status,
        "needs_review": needs_review,
        "review_reasons": reasons,
        "page_count": len(pages),
        "pages": [
            {"page": p.get("page"), "route": p.get("route"), "confidence": p.get("confidence"), "chars": p.get("chars")}
            for p in pages
        ],
        "fields": {k: {"value": f.get("value"), "confidence": f.get("confidence"), "reconciled": f.get("reconciled")} for k, f in fields.items()},
        "chunk_count": len(chunks),
        "text_preview": full_text[:4000],
        "full_text_length": len(full_text),
    }


def extract_document(path: Path) -> dict:
    ext = path.suffix.lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise ValueError(f"Unsupported file type: {ext or '(none)'}")

    tmp = Path(tempfile.mkdtemp(prefix="awip_extract_"))
    try:
        if ext in (".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff"):
            # PyMuPDF opens raster images as a 1-page document too, so the same
            # digital-text/scanned-OCR ladder handles both PDFs and photos.
            pages, fields, chunks, full_text = pdf_extract.extract_pdf(path, tmp, _PDF_OPTS)
            family = "pdf" if ext == ".pdf" else "image"
        elif ext == ".docx":
            pages, fields, chunks, full_text = docx_extract.extract_docx(path, None)
            family = "docx"
        else:  # .xlsx / .xlsm
            pages, fields, chunks, full_text = excel_extract.extract_xlsx(path, tmp, None)
            family = "xlsx"
        return _build_result(path, family, pages, fields, chunks, full_text, _CFG.hitl_gate)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
