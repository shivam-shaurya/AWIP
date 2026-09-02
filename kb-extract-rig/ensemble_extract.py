#!/usr/bin/env python3
r"""
ensemble_extract.py - Phase 2: reconcile MULTIPLE engines' layout.json outputs into ONE,
playing each engine to its measured strength, with agreement-based confidence and a
paddle low-confidence FALLBACK. Feeds the tie-out + the reconcile (Excel-upload) backstop.

Measured engine strengths (from the server comparison) drive the merge:
    - docling  -> cleanest TEXT + reading order          (the text backbone)
    - current  -> TABLES (+ the arithmetic tie-out) + LINKS/QR  (docTR keeps these; docling drops links)
    - paddle   -> low-confidence FALLBACK text voter only (non-sovereign; runs only when needed)

DESIGN (decoupled + testable): this module MERGES already-produced layout.json files. Run the
engines with their own validated CLIs first, then merge:
    python doc_layout.py     --in f.pdf --out out_cur  --ocr-scanned     # current (docTR): tables + links
    python docling_layout.py --in f.pdf --out out_doc                    # docling: clean text
    python ensemble_extract.py --current out_cur/.../f.layout.json \
                               --docling out_doc/.../f.layout.json \
                               [--paddle out_pad/.../f.layout.json] \
                               --out out_ens --reconcile-tables
Merge rules:
    text  = docling's text elements (headings/paragraphs/lists/captions)  [fallback: current's if docling empty]
    tables= current's tables (they carry the tie-out)                     [fallback: docling's if current has none]
    links = current's link/code/figure elements                          (docling loses these)
    confidence(page) = token agreement between docling & current text     (calibrate the gate later)
    if confidence < gate: mark needs_paddle_fallback; if a paddle layout is supplied, fold it in as a
        3rd voter (agreement lifts confidence; still-low pages -> needs_review / reconcile / HITL)
Every table still runs through common.verify_table; uncertain tables are tombstoned for reconcile.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import common

sys.path.insert(0, str(Path(__file__).resolve().parent))

_TEXT_TYPES = ("heading", "paragraph", "list", "list_item", "caption", "footnote", "code")
_TABLE_TYPES = ("table",)
_LINK_TYPES = ("link", "code_qr", "qr", "figure")


def _load(p):
    return json.loads(Path(p).read_text(encoding="utf-8")) if p and Path(p).exists() else None


def _tokens(text: str) -> set:
    return set(re.findall(r"\w+", (text or "").lower()))


def _agreement(a: str, b: str) -> float:
    """Corroboration score in [0,1] between two engines' texts.

    NOT plain Jaccard: Jaccard (|A∩B|/|A∪B|) unfairly punishes a CLEAN engine whose tokens are
    largely CONTAINED in a noisier engine's output (e.g. docling 2.7k chars vs docTR 4.4k incl.
    photo-page noise -> Jaccard 0.37 even though docling is right). Instead blend the overlap
    coefficient (|A∩B|/min|A|,|B| = corroboration/containment) with Jaccard (identity), and scale
    down when there's too little text to trust. So "clean subset of a noisier superset" scores HIGH,
    while "the two engines saw genuinely different content" still scores LOW."""
    ta, tb = _tokens(a), _tokens(b)
    if not ta and not tb:
        return 1.0                                 # both engines agree the page has NO text (blank/figure) - not a divergence
    if not ta or not tb:
        return 0.0                                 # one found text, the other didn't - a real divergence
    inter = len(ta & tb)
    smaller = min(len(ta), len(tb))
    overlap = inter / smaller                      # corroboration: 1.0 if one ⊆ the other
    jacc = inter / len(ta | tb)                    # identity: penalises any divergence
    score = 0.7 * overlap + 0.3 * jacc             # reward corroboration, temper with identity
    if smaller < 8 and score < 0.9:                # tiny sample AND weak overlap = untrustworthy; strong agreement on a short page is fine
        score *= smaller / 8.0
    return round(min(1.0, score), 4)


def _page_text(layout: dict, pno: int) -> str:
    if not layout:
        return ""
    return " ".join(e.get("text", "") for p in layout.get("pages", [])
                    if p.get("page_no") == pno for e in p.get("elements", [])
                    if e.get("type") in _TEXT_TYPES)


def _elems(layout, pno, types):
    if not layout:
        return []
    return [e for p in layout.get("pages", []) if p.get("page_no") == pno
            for e in p.get("elements", []) if e.get("type") in types]


def _pagenos(*layouts) -> list:
    s = set()
    for L in layouts:
        if L:
            s.update(p.get("page_no", 1) for p in L.get("pages", []))
    return sorted(s)


def merge_layouts(docling, current, cfg, gate: float = 0.90, paddle=None) -> dict:
    """Merge engine layout.jsons into one ensemble layout (see module docstring for rules)."""
    pages_out = []
    for pno in _pagenos(docling, current, paddle):
        # READING ORDER: use docling's ordered stream (text + its tables IN-POSITION) as the backbone,
        # and SUBSTITUTE current's tables (they carry the tie-out) at each table slot by ordinal. This
        # keeps a mid-page table between its paragraphs instead of dumping all tables after all text.
        d_stream = sorted(_elems(docling, pno, _TEXT_TYPES + _TABLE_TYPES),
                          key=lambda e: e.get("reading_order_index", 0))
        cur_tables = _elems(current, pno, _TABLE_TYPES)
        cur_links = _elems(current, pno, _LINK_TYPES)
        text_src = "docling" if any(e.get("type") in _TEXT_TYPES for e in d_stream) else "current"
        tbl_src = "current" if cur_tables else "docling"

        els = []
        ti = 0
        if d_stream:
            for e in d_stream:
                if e.get("type") in _TEXT_TYPES:
                    els.append({**e, "source": "docling"})
                elif ti < len(cur_tables):                 # docling table position -> current's table (tie-out)
                    els.append({**cur_tables[ti], "source": "current"}); ti += 1
                else:                                       # docling saw a table current didn't
                    els.append({**e, "source": "docling"})
        else:                                               # docling empty on this page -> current's text
            for e in _elems(current, pno, _TEXT_TYPES):
                els.append({**e, "source": "current"})
        for t in cur_tables[ti:]:                           # current tables beyond docling's positions
            els.append({**t, "source": "current"})
        for e in cur_links:                                 # links/QR (docling drops these) at page end
            els.append({**e, "source": "current"})

        # 4) confidence = docling vs current text agreement on this page
        agr = _agreement(_page_text(docling, pno), _page_text(current, pno))
        conf = agr
        fallback = []
        # 5) paddle FALLBACK: only meaningful when agreement is low
        if agr < gate:
            fallback.append("low_engine_agreement")
            if paddle:
                pa = _agreement(_page_text(paddle, pno), _page_text(docling, pno))
                pc = _agreement(_page_text(paddle, pno), _page_text(current, pno))
                # paddle agreeing with either backbone lifts confidence (a 3rd vote)
                conf = round(max(agr, min(1.0, agr + 0.5 * max(pa, pc))), 4)
                if max(pa, pc) < gate:
                    fallback.append("paddle_also_diverges")
            else:
                fallback.append("needs_paddle_fallback")

        tbl_flag = any(e.get("type") == "table" and e.get("tieout_flags") for e in els)
        needs_review = (conf < gate) or tbl_flag
        reasons = []
        if conf < gate:
            reasons.append(f"engine_agreement {conf:.2f} < gate {gate:.2f}")
        if tbl_flag:
            reasons.append("table tie-out flag")
        reasons += fallback
        for i, e in enumerate(els):
            e.setdefault("id", f"e{pno}_{i}")
            e["reading_order_index"] = i
        pages_out.append({"page_no": pno, "route": "scanned_ensemble",
                          "elements": els, "confidence": conf, "text_source": text_src,
                          "table_source": tbl_src, "needs_review": needs_review,
                          "review_reasons": reasons})

    counts = {}
    for pg in pages_out:
        for e in pg["elements"]:
            counts[e["type"]] = counts.get(e["type"], 0) + 1
    doc_conf = round(sum(p["confidence"] for p in pages_out) / len(pages_out), 4) if pages_out else 0.0
    layout = {"file": (current or docling or {}).get("file", ""), "engine": "ensemble(docling+current+paddle)",
              "pages": pages_out, "element_counts": counts, "doc_confidence": doc_conf,
              "gate": gate,
              "status": "NEEDS_REVIEW" if any(p["needs_review"] for p in pages_out) else "OK"}

    if cfg and getattr(cfg, "reconcile_tables", False):
        try:
            import doc_layout
            doc_layout._tag_reconcilable_tables(layout, cfg)
        except Exception as e:
            layout.setdefault("notes", []).append(f"reconcile tagging skipped ({type(e).__name__}: {e})")
    return layout


def main():
    ap = argparse.ArgumentParser(description="Reconcile engine layout.jsons into one ensemble output.")
    ap.add_argument("--docling", help="docling layout.json (text backbone)")
    ap.add_argument("--current", help="current/docTR layout.json (tables + links + tie-out)")
    ap.add_argument("--paddle", help="optional paddle layout.json (low-confidence fallback voter)")
    ap.add_argument("--out", dest="out", default="out_ensemble")
    ap.add_argument("--gate", type=float, default=0.90, help="engine-agreement confidence gate")
    ap.add_argument("--reconcile-tables", dest="reconcile", action="store_true")
    a = ap.parse_args()
    if not (a.docling or a.current):
        print("need at least --docling or --current"); raise SystemExit(2)

    cfg = common.ExtractConfig()
    if a.reconcile:
        setattr(cfg, "reconcile_tables", True)
    docling, current, paddle = _load(a.docling), _load(a.current), _load(a.paddle)
    for label, path, obj in (("docling", a.docling, docling), ("current", a.current, current), ("paddle", a.paddle, paddle)):
        if path and obj is None:
            print(f"[warn] --{label} did not load (missing/invalid path): {path} -> proceeding WITHOUT it",
                  file=sys.stderr)
    layout = merge_layouts(docling, current, cfg, gate=a.gate, paddle=paddle)

    outdir = Path(a.out); outdir.mkdir(parents=True, exist_ok=True)
    stem = Path(layout.get("file", "ensemble")).stem or "ensemble"
    common.atomic_write_text(outdir / f"{stem}.ensemble.layout.json",
                             json.dumps(layout, indent=2, ensure_ascii=False))
    print(f"[ensemble] {stem}: pages={len(layout['pages'])} doc_confidence={layout['doc_confidence']} "
          f"status={layout['status']} element_counts={layout['element_counts']}")
    low = [p["page_no"] for p in layout["pages"] if p["confidence"] < a.gate]
    if low:
        print(f"  low-confidence pages (< {a.gate}) -> paddle fallback / review: {low}")
    print(f"[ok] wrote {outdir}/{stem}.ensemble.layout.json")


if __name__ == "__main__":
    main()
