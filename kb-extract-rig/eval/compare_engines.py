#!/usr/bin/env python3
r"""
compare_engines.py - OPT-IN, side-by-side multi-engine extraction COMPARISON (EVAL-ONLY).

Runs any subset of {current, docling, paddle, vlm} over one or more files, ties out EVERY engine's
tables through common.verify_table (no engine bypasses the arithmetic guarantee), and writes a
per-file side-by-side report to eval/reports/engine_compare.{md,json}. When a matching gold file
eval/golden/<stem>.tables.json exists, adds the accuracy columns from eval/table_metrics.py; when
it doesn't, still emits the extraction + tie-out result for eyeballing and says "no gold - not scored".

This module is NEVER imported by the pipeline; the default extraction path is unchanged.

Examples
  # CPU now (docling+paddle must be pip-installed; current works out of the box):
  python eval/compare_engines.py --engines current,docling,paddle \
      --in "samples/Risk & Compliance - aaryan.docx" \
           "samples/Dep-14&11C Network schedule for Oct25.pdf" \
           "samples/image (1).png"

  # GPU (server): add the sovereign Florence-2 VLM to the same comparison
  python eval/compare_engines.py --engines current,docling,paddle,vlm --vlm-backend florence \
      --in "samples/638950872304904615_1049, Unsuitable material Dumped (NCR no.04) at Shoulders. 20A.pdf"
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import common  # noqa: E402
from eval.engines import run_engine, EngineOptions, tieout  # noqa: E402
from eval import table_metrics  # noqa: E402

ACCURACY_KEYS = ("content_f1", "positional_f1", "row_accuracy", "teds_lite", "misplacement")
DEFAULT_GOLD_DIR = Path(__file__).resolve().parent / "golden"
DEFAULT_OUT = Path(__file__).resolve().parent / "reports" / "engine_compare"


def _safe_stem(path):
    return common.safe_name(Path(path).stem)


def _gold_for(stem, gold_dir):
    f = Path(gold_dir) / f"{stem}.tables.json"
    return f if f.exists() else None


def _detect_misorder(preds, golds, byorder_f1, margin=0.2):
    """The scorer pairs pred[i] with gold[i] BY ORDER. If a greedy best-match pairing beats the
    by-order pairing on content_f1 by more than `margin`, the tables are probably MISORDERED (or
    split/merged), so the by-order F1 understates true accuracy. Returns a warning string or ''."""
    n = len(preds)
    if n < 2 or byorder_f1 is None:
        return ""
    M = [[table_metrics.score_table(p, g).content_f1 for g in golds] for p in preds]  # small n; cheap
    diag = sum(M[i][i] for i in range(n)) / n
    best = sum(max(M[i]) for i in range(n)) / n            # each pred -> its best gold (upper bound)
    if best - diag > margin:
        return (f"tables may be MISORDERED: by-order content_f1={round(diag, 3)} vs best-match "
                f"content_f1={round(best, 3)} (delta={round(best - diag, 3)}) - align pred/gold order "
                f"before trusting F1")
    return ""


def score_vs_gold(pred_tables, gold_path):
    """Score predicted grids against a gold tables json (reuses table_metrics). Returns the headline
    accuracy columns, or None when there is nothing to score. F1 is a BY-ORDER pairing, so this also
    surfaces `warnings` when the pred/gold table COUNT or ORDER differ (F1 is only apples-to-apples
    when they align)."""
    try:
        golds = table_metrics._load_grids(Path(gold_path))
    except Exception as e:
        return {"error": f"gold load failed: {e}"}
    npred, ngold = len(pred_tables), len(golds)
    if ngold == 0:
        return None                                # empty/stub gold -> nothing to score (not a mismatch)
    warnings = []
    if npred != ngold:
        warnings.append(f"table COUNT differs (pred={npred}, gold={ngold}) - scored first "
                        f"{min(npred, ngold)} BY ORDER; F1 is only comparable when counts match")
    n = min(npred, ngold)
    if n == 0:
        return {"n_pred_tables": npred, "n_gold_tables": ngold, "scored_tables": 0,
                "warnings": warnings} if warnings else None
    agg = table_metrics.score_tables(list(zip(pred_tables[:n], golds[:n])))
    order_warn = _detect_misorder(pred_tables[:n], golds[:n], agg.get("content_f1"))
    if order_warn:
        warnings.append(order_warn)
    out = {k: agg.get(k) for k in ACCURACY_KEYS}
    out["n_pred_tables"] = npred
    out["n_gold_tables"] = ngold
    out["scored_tables"] = n
    if warnings:
        out["warnings"] = warnings
    return out


def _gold_status(gold):
    """Inspect a gold file: (n_grids, is_stub). A stub = a `needs_human_transcription` marker or a
    verified=false file with 0 grids (a scanned placeholder) - present but NOT usable for scoring."""
    if not gold:
        return 0, False
    try:
        n = len(table_metrics._load_grids(Path(gold)))
        raw = json.loads(Path(gold).read_text(encoding="utf-8"))
        stub = isinstance(raw, dict) and (raw.get("needs_human_transcription")
                                          or (n == 0 and not raw.get("verified")))
        return n, bool(stub)
    except Exception:
        return 0, False


def run_file(path, engines, opt, gold_dir=DEFAULT_GOLD_DIR):
    """Run every requested engine on one file. Tie-out (common.verify_table) is applied to EVERY
    engine's grids; accuracy is added only when a gold with >=1 transcribed grid exists (a scanned
    transcription STUB is present-but-not-scored, never a false 'scored')."""
    stem = _safe_stem(path)
    gold = _gold_for(stem, gold_dir)
    n_gold, gold_stub = _gold_status(gold)
    scored = n_gold > 0
    rows = []
    for name in engines:
        res = run_engine(name, path, opt)
        res["tieout"] = tieout(res["tables"], opt.cfg) if res["tables"] else None
        res["accuracy"] = (score_vs_gold(res["tables"], gold)
                           if (scored and res["tables"]) else None)
        rows.append(res)
    return {"file": str(path), "stem": stem, "gold": (str(gold) if gold else None),
            "scored": scored, "gold_stub": gold_stub, "gold_grids": n_gold, "engines": rows}


# --------------------------------------------------------------------------- rendering
def _conf_cell(c):
    return "-" if c is None else f"{c:.2f}"


def _tieout_cell(res):
    to = res.get("tieout")
    if to is None:
        return "n/a (0 tables)"
    tag = "PASS" if to["pass"] else f"FAIL ({to['real_gaps']})"
    extra = []
    if to.get("merged_cell"):
        extra.append(f"{to['merged_cell']} merged?")
    if to.get("not_verified"):
        extra.append(f"{to['not_verified']} not-verified")
    return tag + (f" [{'; '.join(extra)}]" if extra else "")


def _acc_cells(res, scored):
    if not scored:
        return ["no gold - not scored"] * len(ACCURACY_KEYS)
    acc = res.get("accuracy")
    if not acc:
        return ["-"] * len(ACCURACY_KEYS)
    if "error" in acc:
        return [acc["error"]] + ["-"] * (len(ACCURACY_KEYS) - 1)
    return [("-" if acc.get(k) is None else f"{acc[k]:.3f}") for k in ACCURACY_KEYS]


def to_markdown(report):
    """Render the full report dict to a human side-by-side markdown document."""
    opt = report.get("options", {})
    out = ["# Multi-engine extraction comparison",
           "",
           f"- generated: {report.get('generated', '')}",
           f"- engines: {', '.join(opt.get('engines', []))}",
           f"- options: dpi={opt.get('dpi')} lang={opt.get('lang')} vlm_backend={opt.get('vlm_backend')}",
           "",
           "> **Sovereignty:** `[SOV]` sovereign engines are shippable. "
           "`[NON-SOV]` **NON-SOVEREIGN** engines (PaddleOCR = Baidu, Qwen2-VL = Alibaba) are included "
           "for **COMPARISON ONLY** and must never ship in a sovereign deployment.",
           "> Every engine's tables are run through `common.verify_table` (the arithmetic tie-out); "
           "OCR/VLM numbers are flagged for review, never auto-committed.",
           ""]
    cols = ["engine", "sov", "available", "#tables", "tie-out", "mean conf", "seconds",
            *ACCURACY_KEYS]
    for f in report.get("files", []):
        out.append(f"## {Path(f['file']).name}")
        if f.get("scored"):
            gold_note = f"gold: `{Path(f['gold']).name}` - scored ({f.get('gold_grids')} grid(s))"
        elif f.get("gold_stub"):
            gold_note = (f"gold STUB present (`{Path(f['gold']).name}`) - awaiting human transcription; "
                         "NOT scored (extraction + tie-out + confidence only)")
        else:
            gold_note = "no gold - not scored (extraction + tie-out only)"
        out.append(f"_{gold_note}_")
        out.append("")
        out.append("| " + " | ".join(cols) + " |")
        out.append("|" + "|".join(["---"] * len(cols)) + "|")
        for res in f["engines"]:
            sov = "[SOV]" if res.get("sovereign") else "[NON-SOV]"
            avail = "yes" if res.get("available") else "**NO**"
            cells = [res.get("engine", ""), sov, avail, str(len(res.get("tables", []))),
                     _tieout_cell(res), _conf_cell(res.get("confidence")),
                     f"{res.get('seconds', 0):.2f}", *_acc_cells(res, f.get("scored"))]
            out.append("| " + " | ".join(str(c) for c in cells) + " |")
        # notes / reasons below the table
        for res in f["engines"]:
            if res.get("reason"):
                out.append(f"- _{res.get('engine')}_: {res['reason']}")
            for w in (res.get("accuracy") or {}).get("warnings", []):
                out.append(f"- **WARN** _{res.get('engine')}_: {w}")
        out.append("")
    out.append("---")
    out.append("_Engines that report `available: NO` are simply not installed on this host "
               "(lazy import) - install them and re-run; the harness degrades gracefully._")
    return "\n".join(out)


def _write(report, out_base):
    out_base = Path(out_base)
    out_base.parent.mkdir(parents=True, exist_ok=True)
    md = to_markdown(report)
    json_txt = json.dumps(report, indent=2, ensure_ascii=False)
    try:
        common.atomic_write_text(out_base.with_suffix(".md"), md)
        common.atomic_write_text(out_base.with_suffix(".json"), json_txt)
    except Exception:
        out_base.with_suffix(".md").write_text(md, encoding="utf-8")
        out_base.with_suffix(".json").write_text(json_txt, encoding="utf-8")
    return out_base.with_suffix(".md"), out_base.with_suffix(".json")


def main():
    ap = argparse.ArgumentParser(description="OPT-IN multi-engine extraction comparison (eval-only).")
    ap.add_argument("--in", dest="inp", nargs="+", required=True, help="one or more input files")
    ap.add_argument("--engines", default="current",
                    help="comma list of: current,docling,paddle,vlm (default: current)")
    ap.add_argument("--vlm-backend", dest="vlm_backend", default="florence",
                    help="VLM backend for the 'vlm' engine: florence (sovereign) | llama32v | qwen2vl")
    ap.add_argument("--dpi", type=int, default=200, help="raster DPI for image-based engines")
    ap.add_argument("--lang", default="eng", help="OCR language hint")
    ap.add_argument("--max-pages", dest="max_pages", type=int, default=0,
                    help="cap pages per file (0 = all); use on huge scans for a quick look")
    ap.add_argument("--gold-dir", dest="gold_dir", default=str(DEFAULT_GOLD_DIR))
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output base path (.md/.json appended)")
    a = ap.parse_args()

    engines = [e.strip() for e in a.engines.split(",") if e.strip()]
    from eval.engines import ENGINES
    unknown = [e for e in engines if e not in ENGINES]
    if unknown:
        print(f"[warn] unknown engine(s): {', '.join(unknown)} (have: {', '.join(sorted(ENGINES))})",
              file=sys.stderr)
    opt = EngineOptions(dpi=a.dpi, lang=a.lang, vlm_backend=a.vlm_backend, max_pages=a.max_pages,
                        cfg=common.ExtractConfig())
    files = [f for f in a.inp if Path(f).exists()]
    missing = [f for f in a.inp if not Path(f).exists()]
    for m in missing:
        print(f"[warn] not found, skipping: {m}", file=sys.stderr)
    if not files:
        print("No input files found.", file=sys.stderr)
        raise SystemExit(2)

    print(f"[compare] {len(files)} file(s) x engines: {', '.join(engines)}")
    report = {"generated": datetime.now().isoformat(timespec="seconds"),
              "options": {"engines": engines, "dpi": a.dpi, "lang": a.lang,
                          "vlm_backend": a.vlm_backend, "max_pages": a.max_pages},
              "files": []}
    for f in files:
        print(f"  - {Path(f).name}")
        fr = run_file(f, engines, opt, a.gold_dir)
        report["files"].append(fr)
        for res in fr["engines"]:
            av = "ok" if res["available"] else "UNAVAILABLE"
            print(f"      {res['engine']:<14} {av:<12} #tables={len(res['tables'])} "
                  f"tie-out={_tieout_cell(res)} conf={_conf_cell(res['confidence'])} "
                  f"{res['seconds']:.2f}s")
            for w in (res.get("accuracy") or {}).get("warnings", []):
                print(f"        WARN: {w}", file=sys.stderr)
    md_path, json_path = _write(report, a.out)
    print(f"[ok] wrote {md_path}")
    print(f"[ok] wrote {json_path}")


if __name__ == "__main__":
    main()
