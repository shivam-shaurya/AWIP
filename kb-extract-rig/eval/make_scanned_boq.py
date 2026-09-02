#!/usr/bin/env python3
r"""
make_scanned_boq.py - generate a CONTROLLED multi-table "scanned" test with known ground truth,
so the reconcile backstop can be proven end-to-end WITHOUT a real dirty scan on hand.

Produces:
  <out>/synthetic_scanned_boq.pdf   - an IMAGE-ONLY (no text layer = "scanned") PDF containing
                                       TWO distinct BOQ tables ON ONE PAGE (exercises the
                                       same-page multi-table element-id keying we hardened).
  <out>/synthetic_boq_clean.xlsx    - the matching CLEAN Excel, ONE SHEET PER TABLE
                                       (this is the authoritative "user-uploaded clean table" +
                                       the ground truth). Amounts tie out (Qty*Rate=Amount, ΣTotal).

Then the reconcile flow is:
  doc_layout.py --in synthetic_scanned_boq.pdf --out out_s --ocr-scanned --reconcile-tables
  reconcile_tables.py --layout out_s/.../*.layout.json --excel synthetic_boq_clean.xlsx --apply
  -> each Excel sheet must align to its CORRECT tombstone (by arithmetic) and inject into that slot.

HONEST CAVEAT: a rendered scan is cleaner than a real camera/photocopier scan (no skew/noise/
stamps/faint ink). This proves the PLUMBING + best-case accuracy; real dirty-scan accuracy still
needs a real scanned BOQ.

Usage: python eval/make_scanned_boq.py --out samples
"""
from __future__ import annotations

import argparse
from pathlib import Path

import fitz  # PyMuPDF

# two DISTINCT BOQ tables (distinct amounts so the reconcile matcher can tell them apart)
TABLE1 = ("Earthwork", [
    ["Sr", "Description", "Qty", "Rate", "Amount"],
    ["1", "Excavation in soil", "1200", "150", "180000"],
    ["2", "Excavation in rock", "340", "450", "153000"],
    ["3", "Backfilling compacted", "800", "90", "72000"],
    ["", "Total", "", "", "405000"],
])
TABLE2 = ("Concrete", [
    ["Sr", "Description", "Qty", "Rate", "Amount"],
    ["1", "PCC M10 grade", "220", "4800", "1056000"],
    ["2", "RCC M25 grade", "480", "6500", "3120000"],
    ["3", "Formwork shuttering", "1500", "320", "480000"],
    ["", "Total", "", "", "4656000"],
])
COL_W = [50, 230, 75, 75, 110]


def _draw_table(page, x0, y0, title, rows):
    fs = 14                                          # larger -> OCR reads every row cleanly
    page.insert_text((x0, y0 - 10), title, fontsize=13, fontname="helv")
    y = y0
    rh = 30
    for r, row in enumerate(rows):
        x = x0
        for c, cell in enumerate(row):
            page.draw_rect(fitz.Rect(x, y, x + COL_W[c], y + rh), width=0.8)
            page.insert_text((x + 3, y + 14), str(cell), fontsize=fs, fontname="helv")
            x += COL_W[c]
        y += rh
    return y


def make_pdf(out_pdf: Path):
    doc = fitz.open()
    # ONE table PER PAGE -> OCR keeps them separate -> TWO tombstones -> tests matching each
    # uploaded Excel sheet to its correct tombstone (the multi-scanned-table scenario).
    for n, (title, rows) in enumerate((TABLE1, TABLE2)):
        page = doc.new_page(width=595, height=842)  # A4
        page.insert_text((40, 40), "ANNEXURE - BILL OF QUANTITIES (synthetic test)", fontsize=13, fontname="helv")
        _draw_table(page, 40, 100, "Table 3.%d - %s" % (n + 1, title), rows)
    # rasterize -> image-only PDF (destroys the text layer = "scanned")
    scan = fitz.open()
    for p in doc:
        pix = p.get_pixmap(dpi=300)
        np_ = scan.new_page(width=p.rect.width, height=p.rect.height)
        np_.insert_image(np_.rect, pixmap=pix)
    scan.save(str(out_pdf))
    doc.close(); scan.close()


def make_xlsx(out_xlsx: Path):
    import openpyxl
    wb = openpyxl.Workbook()
    for i, (title, rows) in enumerate((TABLE1, TABLE2)):
        ws = wb.active if i == 0 else wb.create_sheet()
        ws.title = title
        for row in rows:
            ws.append([(_num(c) if _isnum(c) else c) for c in row])
    wb.save(str(out_xlsx))


def _isnum(s):
    try:
        float(str(s)); return str(s) != ""
    except Exception:
        return False


def _num(s):
    f = float(s)
    return int(f) if f == int(f) else f


def main():
    ap = argparse.ArgumentParser(description="Generate a synthetic multi-table scanned BOQ + clean Excel.")
    ap.add_argument("--out", default="samples")
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    pdf = out / "synthetic_scanned_boq.pdf"
    xlsx = out / "synthetic_boq_clean.xlsx"
    make_pdf(pdf)
    make_xlsx(xlsx)
    # verify the pdf is really image-only (no text layer)
    d = fitz.open(str(pdf))
    txt = sum(len((p.get_text() or "").strip()) for p in d); d.close()
    print(f"[ok] {pdf}  (text-layer chars={txt} -> {'IMAGE-ONLY / scanned' if txt < 20 else 'HAS TEXT (not scanned!)'})")
    print(f"[ok] {xlsx}  (2 sheets: {TABLE1[0]}, {TABLE2[0]} - the clean ground truth)")


if __name__ == "__main__":
    main()
