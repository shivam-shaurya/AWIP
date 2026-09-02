#!/usr/bin/env python3
"""
export_pdf.py - turn extraction output into clean, readable PDFs.
Reads out/<stem>/<stem>.doc.json + .chunks.jsonl and writes:
  out/<stem>/<stem>.extracted.pdf    (one per document)
  out/ALL_extracted.pdf              (everything in one file - easy to download)
Unicode-safe (uses Windows 'Nirmala UI' so Hindi/Marathi render).
Optional: --images  embeds the scanned page image above each page's text.

Run:  python export_pdf.py --out C:\\Users\\admin\\out
      python export_pdf.py --out C:\\Users\\admin\\out --images
"""
import argparse, json, os, html
from pathlib import Path
try:
    from tqdm import tqdm
except Exception:
    def tqdm(it=None, **k): return it if it is not None else []
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                TableStyle, Image, PageBreak, HRFlowable)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# ---- Unicode font (Devanagari + Latin) -------------------------------------
FONT = "Helvetica"
for fp in [r"C:\Windows\Fonts\Nirmala.ttf", r"C:\Windows\Fonts\arial.ttf"]:
    if os.path.exists(fp):
        try:
            pdfmetrics.registerFont(TTFont("Body", fp)); FONT = "Body"; break
        except Exception:
            pass

styles = getSampleStyleSheet()
H1   = ParagraphStyle("H1", parent=styles["Heading1"], fontName=FONT, fontSize=15, spaceAfter=6)
H2   = ParagraphStyle("H2", parent=styles["Heading2"], fontName=FONT, fontSize=11,
                      textColor=colors.HexColor("#1a4d80"), spaceBefore=10, spaceAfter=4)
BODY = ParagraphStyle("BodyTxt", parent=styles["Normal"], fontName=FONT, fontSize=9.5, leading=13)
SMALL= ParagraphStyle("Small", parent=styles["Normal"], fontName=FONT, fontSize=8, textColor=colors.grey)
CELL = ParagraphStyle("Cell", parent=styles["Normal"], fontName=FONT, fontSize=7, leading=8.5)

def esc(s): return html.escape(str(s)).replace("\n", "<br/>")

def boq_table(chunks, page_width):
    """Render BOQ / Schedule-H rows as a real aligned table (split on ' | ')."""
    rows = [[x.strip() for x in (c.get("text") or "").split(" | ")] for c in chunks]
    rows = [r for r in rows if any(r)]
    if not rows: return None
    maxc = max(len(r) for r in rows)
    rows = [r + [""]*(maxc - len(r)) for r in rows]
    avg = [max(1.0, sum(len(r[j]) for r in rows)/len(rows)) for j in range(maxc)]   # width by content
    widths = [page_width * a/sum(avg) for a in avg]
    data = [[Paragraph(esc(cell), CELL) for cell in r] for r in rows]
    t = Table(data, colWidths=widths, repeatRows=0)
    t.setStyle(TableStyle([
        ("GRID", (0,0), (-1,-1), 0.3, colors.HexColor("#cccccc")),
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("ROWBACKGROUNDS", (0,0), (-1,-1), [colors.white, colors.HexColor("#f6f8fa")]),
        ("LEFTPADDING",(0,0),(-1,-1),3), ("RIGHTPADDING",(0,0),(-1,-1),3),
        ("TOPPADDING",(0,0),(-1,-1),1.5), ("BOTTOMPADDING",(0,0),(-1,-1),1.5),
    ]))
    return t

def read_chunks(p):
    if not p.exists(): return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        try: out.append(json.loads(line))
        except Exception: pass
    return out

def story_for(doc, chunks, docdir, with_images):
    s = []
    stem = Path(doc["file"]).name
    flag = "NEEDS REVIEW" if doc.get("needs_review") else "AUTO-ACCEPTED"
    s.append(Paragraph(esc(stem), H1))
    meta = [
        ["doc class",   doc.get("doc_class", "-")],
        ["family",      doc.get("family", "-")],
        ["OCR confidence",     str(doc.get("ocr_confidence", "-"))],
        ["overall confidence", str(doc.get("overall_confidence", "-"))],
        ["status",      flag],
        ["review reasons", "; ".join(doc.get("review_reasons", [])) or "-"],
    ]
    t = Table([[Paragraph(f"<b>{esc(k)}</b>", SMALL), Paragraph(esc(v), SMALL)] for k, v in meta],
              colWidths=[40*mm, 130*mm])
    t.setStyle(TableStyle([("GRID",(0,0),(-1,-1),0.4,colors.lightgrey),
                           ("VALIGN",(0,0),(-1,-1),"TOP")]))
    s += [t, Spacer(1, 4)]
    # fields
    fields = doc.get("fields", {})
    if fields:
        s.append(Paragraph("Extracted fields", H2))
        rows = [[Paragraph("<b>field</b>", SMALL), Paragraph("<b>value</b>", SMALL),
                 Paragraph("<b>conf</b>", SMALL), Paragraph("<b>reconciled</b>", SMALL)]]
        for k, f in fields.items():
            rows.append([Paragraph(esc(k), SMALL), Paragraph(esc(f.get("value","")), SMALL),
                         Paragraph(str(f.get("confidence","")), SMALL),
                         Paragraph(str(f.get("reconciled","")), SMALL)])
        ft = Table(rows, colWidths=[35*mm, 95*mm, 20*mm, 25*mm])
        ft.setStyle(TableStyle([("GRID",(0,0),(-1,-1),0.4,colors.lightgrey),
                                ("BACKGROUND",(0,0),(-1,0),colors.HexColor("#eef3f8"))]))
        s += [ft, Spacer(1, 6)]
    family = doc.get("family", "")
    if family in ("xlsx", "xlsm"):
        # spreadsheet / BOQ -> a real aligned table
        s.append(Paragraph("Extracted Schedule-H / BOQ", H2))
        t = boq_table(chunks, 174*mm)
        if t: s.append(t)
        else: s.append(Paragraph("(no rows)", SMALL))
    else:
        # PDF / DOCX -> clean text per page (+ optional scan image)
        s.append(Paragraph("Extracted text", H2))
        page_png = {}
        if with_images:
            for png in (docdir / "pages").glob("*.png"):
                page_png[png.stem] = png
        for c in chunks:
            pg = c.get("page", "")
            s.append(Paragraph(f"— page {esc(pg)}  ·  confidence {c.get('confidence','')} —", SMALL))
            if with_images:
                key = f"page_{pg}"
                if key in page_png:
                    try:
                        img = Image(str(page_png[key])); img._restrictSize(165*mm, 150*mm)
                        s += [img, Spacer(1, 3)]
                    except Exception: pass
            s.append(Paragraph(esc(c.get("text", "")), BODY))
            s.append(Spacer(1, 6))
    s.append(HRFlowable(width="100%", color=colors.lightgrey))
    return s

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--images", action="store_true", help="embed scanned page images (bigger PDFs)")
    a = ap.parse_args()
    out = Path(a.out)
    all_story = []
    docs = sorted(out.rglob("*.doc.json"))
    if not docs:
        print(f"No *.doc.json under {out} - run extract.py first."); return
    for dj in tqdm(docs, desc="Building PDFs", unit="doc"):
        doc = json.loads(dj.read_text(encoding="utf-8"))
        stem = dj.name[:-len(".doc.json")]
        chunks = read_chunks(dj.parent / f"{stem}.chunks.jsonl")
        # per-document PDF (its own fresh flowables)
        pdf_path = dj.parent / f"{stem}.extracted.pdf"
        try:
            SimpleDocTemplate(str(pdf_path), pagesize=A4, leftMargin=18*mm, rightMargin=18*mm,
                              topMargin=16*mm, bottomMargin=16*mm).build(story_for(doc, chunks, dj.parent, a.images))
            print(f"  {pdf_path}")
        except Exception as e:
            print(f"  [skip {stem}: {e}]")
        # combined gets a SEPARATE fresh story (reportlab flowables are single-use)
        all_story += story_for(doc, chunks, dj.parent, a.images) + [PageBreak()]
    combined = out / "ALL_extracted.pdf"
    try:
        SimpleDocTemplate(str(combined), pagesize=A4, leftMargin=18*mm, rightMargin=18*mm,
                          topMargin=16*mm, bottomMargin=16*mm).build(all_story)
        print(f"\nCombined -> {combined}")
    except Exception as e:
        print(f"\n[combined skipped: {e}] - the per-document PDFs are fine, use those.")

if __name__ == "__main__":
    main()
