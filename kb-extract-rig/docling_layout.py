#!/usr/bin/env python3
r"""
docling_layout.py - Phase 1 of the multi-engine plan: IBM Docling as an OPT-IN
SCANNED-document engine that emits the rig's `layout.json` element schema, so docling's
clean text + reading order plug straight into the existing tie-out + reconciliation backstop.

WHY a separate module (not a patch to doc_layout.py):
    doc_layout.py (the sovereign docTR path) is left UNTOUCHED -> the digital path stays
    byte-identical. This is an additive, opt-in entry point. Route to it only for scanned
    documents where docling won the comparison (cleaner reading order, faster).

WHAT it does, per PDF:
    docling.convert(pdf) -> ordered items (headings / paragraphs / lists / tables) grouped
    by page -> {pages:[{page_no, route:"scanned_docling", elements:[...]}], ...} ->
    every TABLE grid through common.verify_table (the arithmetic tie-out) ->
    doc_layout._tag_reconcilable_tables (tombstones uncertain tables for the
    "ask the user for the clean Excel and place it back" reconcile backstop) ->
    write <stem>.layout.json + <stem>.md.

GUARANTEES:
    - No engine bypasses the tie-out (verify_table runs on every table).
    - Uncertain tables are tombstoned -> reconcile_tables.py can inject the authoritative
      Excel into the exact slot (multi-table-per-page safe: keyed by element id).
    - Defensive across Docling versions (like docling_extract.py); any item that fails to
      map is skipped with a note, never crashes the doc.

SERVER-ONLY (needs `docling` + torch). Sovereign (IBM, MIT).
Usage:
    python docling_layout.py --in file.pdf --out out_docling [--reconcile-tables]
    python docling_layout.py --in samples --out out_docling --reconcile-tables
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import common

# reuse the version-defensive table->grid mapper from the eval adapter
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from eval.engines.docling_extract import _table_to_grid
except Exception:                                   # pragma: no cover
    def _table_to_grid(t):
        try:
            df = t.export_to_dataframe()
            return [[("" if v is None else str(v)) for v in row] for row in df.values.tolist()]
        except Exception:
            return []

# label -> our element type (Docling DocItemLabel values; matched case-insensitively)
_LABEL_MAP = {
    "title": ("heading", 1), "section_header": ("heading", 2),
    "paragraph": ("paragraph", None), "text": ("paragraph", None),
    "list_item": ("list", None), "caption": ("caption", None),
    "footnote": ("footnote", None), "code": ("code", None),
}


def _page_of(item) -> int:
    """Best-effort page number from a Docling item's provenance (1-based). 0 if unknown."""
    try:
        prov = getattr(item, "prov", None) or []
        if prov:
            return int(getattr(prov[0], "page_no", 0) or 0)
    except Exception:
        pass
    return 0


def _label_of(item) -> str:
    lab = getattr(item, "label", "") or ""
    return str(getattr(lab, "value", lab)).lower()


_CONV = None


def _converter():
    """Module-level DocumentConverter singleton - built once, reused across the batch (docling's
    layout/table/OCR models are expensive to init; rebuilding per file dominated batch time)."""
    global _CONV
    if _CONV is None:
        from docling.document_converter import DocumentConverter   # ImportError -> caller degrades
        _CONV = DocumentConverter()
    return _CONV


def docling_to_layout(pdf_path: Path, cfg) -> dict:
    """Run docling on ONE pdf and map its document into the rig's layout.json dict.
    Tables run through the tie-out; text/headings/lists become ordered elements per page."""
    doc = _converter().convert(str(pdf_path)).document

    # ------- collect ordered items (text + tables), grouped by page -------
    pages: dict[int, list] = {}
    order = 0
    notes: list[str] = []

    def _emit(page_no: int, el: dict):
        nonlocal order
        el.setdefault("id", f"d{order}")
        el["reading_order_index"] = order
        order += 1
        pages.setdefault(page_no or 1, []).append(el)

    n_tables = 0
    flag_unverified = bool(getattr(cfg, "flag_unverified_amounts", False)) if cfg else False

    def _emit_table(grid, page_no):
        nonlocal n_tables
        if not grid or not common.emit_worthy(grid):
            return
        try:
            flags = common.verify_table(grid, cfg, flag_unverified=flag_unverified)
        except Exception:
            flags = common.verify_table(grid, cfg)
        _emit(page_no or 1, {"type": "table", "grid": grid, "tieout_flags": flags})
        n_tables += 1

    # Preferred: ordered iteration keeps reading order INCLUDING tables IN-POSITION (a table between
    # two paragraphs stays between them, not appended at the page bottom - the reading-order fix).
    iterated = False
    try:
        for item, _level in doc.iterate_items():
            lab = _label_of(item)
            if lab == "table":
                _emit_table(_table_to_grid(item), _page_of(item))
                iterated = True
                continue
            etype_level = _LABEL_MAP.get(lab)
            if not etype_level:
                continue
            txt = (getattr(item, "text", "") or "").strip()
            if not txt:
                continue
            etype, level = etype_level
            el = {"type": etype, "text": txt}
            if level is not None:
                el["level"] = level
            _emit(_page_of(item), el)
            iterated = True
    except Exception as e:
        notes.append(f"iterate_items unavailable ({type(e).__name__}); text from markdown")

    # Fallback: no ordered iteration -> markdown text as one block + tables from doc.tables.
    if not iterated:
        md = ""
        for meth in ("export_to_markdown", "export_to_text"):
            fn = getattr(doc, meth, None)
            if fn:
                try:
                    md = fn(); break
                except Exception:
                    continue
        if md.strip():
            _emit(1, {"type": "paragraph", "text": md.strip()})
        for t in (getattr(doc, "tables", None) or []):
            _emit_table(_table_to_grid(t), _page_of(t))

    # ------- assemble layout.json -------
    page_list = []
    for pno in sorted(pages):
        els = sorted(pages[pno], key=lambda e: e.get("reading_order_index", 0))
        needs_review = any(e.get("type") == "table" and e.get("tieout_flags") for e in els)
        page_list.append({"page_no": pno, "route": "scanned_docling",
                          "elements": els, "needs_review": needs_review,
                          "review_reasons": (["tieout_flags"] if needs_review else [])})
    counts: dict[str, int] = {}
    for pg in page_list:
        for e in pg["elements"]:
            counts[e["type"]] = counts.get(e["type"], 0) + 1
    layout = {"file": str(pdf_path), "engine": "docling", "pages": page_list,
              "element_counts": counts, "notes": notes,
              "status": "NEEDS_REVIEW" if any(p["needs_review"] for p in page_list) else "OK"}

    # ------- reconcile tombstone tagging (the Excel-upload backstop) -------
    if cfg and getattr(cfg, "reconcile_tables", False):
        try:
            import doc_layout
            doc_layout._tag_reconcilable_tables(layout, cfg)
        except Exception as e:
            notes.append(f"reconcile tagging skipped ({type(e).__name__}: {e})")
    return layout


def _md_from_layout(layout: dict) -> str:
    out = [f"<!-- extracted by docling_layout ({layout.get('engine')}) -->", ""]
    for pg in layout.get("pages", []):
        for e in pg.get("elements", []):
            t = e.get("type")
            if t == "heading":
                out.append("#" * min(int(e.get("level", 2)), 6) + " " + e.get("text", ""))
            elif t == "list":
                out.append("- " + e.get("text", ""))
            elif t == "table":
                g = e.get("grid") or []
                if g:
                    out.append("| " + " | ".join(str(c) for c in g[0]) + " |")
                    out.append("|" + "|".join(["---"] * len(g[0])) + "|")
                    for r in g[1:]:
                        out.append("| " + " | ".join(str(c) for c in r) + " |")
            else:
                out.append(e.get("text", ""))
            out.append("")
    return "\n".join(out)


def extract_one(pdf: Path, outroot: Path, cfg) -> dict:
    docdir = common.doc_outdir(outroot, pdf)
    docdir.mkdir(parents=True, exist_ok=True)
    fbase = docdir.name
    layout = docling_to_layout(pdf, cfg)
    common.atomic_write_text(docdir / f"{fbase}.layout.json",
                             json.dumps(layout, indent=2, ensure_ascii=False))
    common.atomic_write_text(docdir / f"{fbase}.md", _md_from_layout(layout))
    common.mark_done(docdir)
    n_tab = layout["element_counts"].get("table", 0)
    n_flag = sum(1 for p in layout["pages"] for e in p["elements"]
                 if e.get("type") == "table" and e.get("tieout_flags"))
    return {"file": pdf.name, "status": layout["status"], "tables": n_tab,
            "flagged_tables": n_flag, "out": str(docdir)}


def main():
    ap = argparse.ArgumentParser(description="Docling scanned-document engine -> rig layout.json + md (opt-in).")
    ap.add_argument("--in", dest="inp", required=True, help="a PDF or a folder of PDFs")
    ap.add_argument("--out", dest="out", default="out_docling")
    ap.add_argument("--reconcile-tables", dest="reconcile", action="store_true",
                    help="tombstone uncertain tables for the Excel-upload reconcile backstop")
    a = ap.parse_args()

    cfg = common.ExtractConfig()
    if a.reconcile:
        setattr(cfg, "reconcile_tables", True)
    inp, outroot = Path(a.inp), Path(a.out)
    outroot.mkdir(parents=True, exist_ok=True)
    pdfs = [inp] if inp.is_file() else sorted(p for p in inp.rglob("*") if p.suffix.lower() == ".pdf")
    if not pdfs:
        print(f"No PDFs under {inp}"); return
    print(f"[docling_layout] {len(pdfs)} pdf(s) -> {outroot}/")
    for p in pdfs:
        try:
            r = extract_one(p, outroot, cfg)
            print(f"  [{r['status']:12}] {r['file'][:50]:50} tables={r['tables']} "
                  f"flagged={r['flagged_tables']}")
        except Exception as e:
            print(f"  [ERROR] {p.name}: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
