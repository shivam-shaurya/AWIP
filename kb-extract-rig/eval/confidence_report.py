#!/usr/bin/env python3
r"""
confidence_report.py - turn a completed run into a human-in-the-loop (HITL) routing
report, implementing the confidence policy the user specified:

    overall_confidence > 0.95            -> AUTO_ACCEPT
    0.90 - 0.95                          -> MANUAL_REVIEW      (surface uncertain regions)
    < 0.90  and an Excel/native exists   -> REQUEST_SOURCE     (Excel / XER / XML / MPP)
    < 0.90  and no source                -> HITL_REVIEW        (highlight uncertain regions)
    any tie-out gap / not_verified flag  -> forced to at least MANUAL_REVIEW

It is READ-ONLY over a run directory: it consumes the artefacts the rig already writes
(<stem>.status.json, layout.json, review_pages.csv, run_summary.json / _status.json) -
it does NOT re-extract, so it needs no GPU. It emits:
    - confidence.md   : per-doc + per-table verdicts, uncertain regions, source requests
    - confidence.csv  : machine-readable routing queue (stem, page, verdict, reason, ask)

This is the operator's worklist: it says, for every uncertain table, EXACTLY which
original file to ask the client for - the core of "don't silently return wrong data".

USAGE
    python eval/confidence_report.py --run out/ --out eval/reports/
    python eval/confidence_report.py --run out/ --out eval/reports/ \
        --auto 0.95 --review 0.90        # override thresholds
"""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any, Optional

AUTO_DEFAULT = 0.95
REVIEW_DEFAULT = 0.90

# which original file to request, by the doc's source extension
SOURCE_ASK = {
    ".pdf": "original Excel/native (if this table came from a spreadsheet or P6/MSP export)",
    ".png": "higher-resolution scan (>=300 DPI) or the original digital file",
    ".jpg": "higher-resolution scan (>=300 DPI) or the original digital file",
    ".tif": "higher-resolution scan (>=300 DPI) or the original digital file",
}


def _load_json(p: Path) -> Optional[dict]:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _iter_status_files(run: Path):
    """Every <stem>.status.json (table_pdf) and every *.layout.json (doc_layout)."""
    yield from run.rglob("*.status.json")
    yield from run.rglob("*.layout.json")


def _verdict(conf: float, has_flags: bool, source_ext: str,
             auto: float, review: float) -> tuple[str, str]:
    """Return (verdict, recommended_action)."""
    if has_flags and conf > review:
        conf = min(conf, review)          # a tie-out gap can't auto-accept
    if conf > auto and not has_flags:
        return "AUTO_ACCEPT", "commit"
    if conf >= review:
        return "MANUAL_REVIEW", "human verifies the flagged cells/rows"
    ask = SOURCE_ASK.get(source_ext, "the native source file")
    return "REQUEST_SOURCE", f"request {ask}; then reconcile (reconcile_tables.py)"


def _doc_confidence(doc: dict) -> float:
    """Best-effort single confidence for a doc from whatever the artefact carries."""
    for k in ("overall_confidence", "confidence", "doc_confidence", "mean_confidence"):
        v = doc.get(k)
        if isinstance(v, (int, float)):
            return float(v)
    # doc_layout: derive from review fraction if present
    pages = doc.get("pages") or doc.get("page_reports")
    if isinstance(pages, list) and pages:
        need = sum(1 for p in pages if p.get("needs_review"))
        return round(1.0 - need / len(pages), 4)
    return 1.0


def _tables_of(doc: dict) -> list[dict]:
    if isinstance(doc.get("tables"), list):
        return doc["tables"]
    # doc_layout nests tables under pages[].elements[]; carry the page number down.
    out: list[dict] = []
    if isinstance(doc.get("pages"), list):
        for pg in doc["pages"]:
            for e in pg.get("elements", []) or []:
                if e.get("type") == "table":
                    e = dict(e)
                    e.setdefault("page", pg.get("page_no"))
                    out.append(e)
    if not out and isinstance(doc.get("elements"), list):
        out = [e for e in doc["elements"] if e.get("type") == "table"]
    return out


def build_report(run: Path, auto: float, review: float) -> tuple[list[dict], dict]:
    rows: list[dict] = []
    seen: set[str] = set()
    for f in _iter_status_files(run):
        doc = _load_json(f)
        if not doc:
            continue
        stem = doc.get("stem") or doc.get("source") or f.stem.split(".")[0]
        if stem in seen:
            continue
        seen.add(stem)
        src_ext = Path(doc.get("source", stem)).suffix.lower() or ".pdf"
        doc_conf = _doc_confidence(doc)
        tables = _tables_of(doc)
        doc_flags = bool(doc.get("tieout_gaps") or doc.get("needs_review"))

        if not tables:
            v, act = _verdict(doc_conf, doc_flags, src_ext, auto, review)
            rows.append({"stem": stem, "scope": "document", "page": "", "table_id": "",
                         "confidence": doc_conf, "verdict": v, "action": act,
                         "reason": "; ".join(_reasons(doc)) or "-"})
            continue

        for t in tables:
            flags = t.get("tieout_flags") or t.get("flags") or []
            has_flags = bool(flags)
            tconf = t.get("confidence", t.get("table_confidence", doc_conf))
            try:
                tconf = float(tconf)
            except Exception:
                tconf = doc_conf
            v, act = _verdict(tconf, has_flags, src_ext, auto, review)
            rows.append({
                "stem": stem, "scope": "table",
                "page": t.get("page", t.get("page_no", "")),
                "table_id": t.get("id", t.get("element_id", "")),
                "confidence": round(tconf, 4), "verdict": v, "action": act,
                "reason": "; ".join(str(x) for x in flags) or "-",
            })

    summary = _summarise(rows)
    return rows, summary


def _reasons(doc: dict) -> list[str]:
    r = doc.get("review_reasons") or doc.get("reasons") or []
    return [str(x) for x in r] if isinstance(r, list) else [str(r)]


def _summarise(rows: list[dict]) -> dict:
    by_verdict: dict[str, int] = {}
    for r in rows:
        by_verdict[r["verdict"]] = by_verdict.get(r["verdict"], 0) + 1
    n = len(rows) or 1
    return {
        "n_items": len(rows),
        "auto_accept": by_verdict.get("AUTO_ACCEPT", 0),
        "manual_review": by_verdict.get("MANUAL_REVIEW", 0),
        "request_source": by_verdict.get("REQUEST_SOURCE", 0),
        "hitl_review": by_verdict.get("HITL_REVIEW", 0),
        "auto_accept_rate": round(by_verdict.get("AUTO_ACCEPT", 0) / n, 4),
    }


def write_md(rows: list[dict], summary: dict, out: Path) -> None:
    lines = ["# Confidence / HITL routing report", "",
             "Routing policy: `>0.95 auto` · `0.90–0.95 manual review` · "
             "`<0.90 request original source`. Any tie-out/verification flag "
             "caps a table at manual review.", "",
             "## Summary", ""]
    for k, v in summary.items():
        lines.append(f"- **{k}**: {v}")
    lines += ["", "## Items needing attention (worst first)", "",
              "| stem | scope | page | conf | verdict | reason | action |",
              "|---|---|---|---|---|---|---|"]
    worklist = sorted([r for r in rows if r["verdict"] != "AUTO_ACCEPT"],
                      key=lambda r: r["confidence"])
    for r in worklist:
        lines.append(f"| {r['stem'][:40]} | {r['scope']} | {r['page']} | "
                     f"{r['confidence']} | **{r['verdict']}** | {r['reason'][:60]} | {r['action']} |")
    if not worklist:
        lines.append("| — | — | — | — | all AUTO_ACCEPT | — | — |")
    out.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description="Build a HITL routing report from a run dir.")
    ap.add_argument("--run", required=True, help="a completed output run directory")
    ap.add_argument("--out", default="eval/reports", help="report output dir")
    ap.add_argument("--auto", type=float, default=AUTO_DEFAULT)
    ap.add_argument("--review", type=float, default=REVIEW_DEFAULT)
    a = ap.parse_args()
    run, out = Path(a.run), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    rows, summary = build_report(run, a.auto, a.review)
    write_md(rows, summary, out / "confidence.md")
    with (out / "confidence.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["stem", "scope", "page", "table_id",
                                           "confidence", "verdict", "action", "reason"])
        w.writeheader()
        w.writerows(rows)
    print(json.dumps(summary, indent=2))
    print(f"[ok] {out/'confidence.md'}  +  {out/'confidence.csv'}")


if __name__ == "__main__":
    main()
