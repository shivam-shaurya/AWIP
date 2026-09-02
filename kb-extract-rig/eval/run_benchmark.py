#!/usr/bin/env python3
r"""
run_benchmark.py - the accuracy + speed benchmark for kb-extract-rig.

It answers, on a NAMED golden dataset, the questions the targets demand:
  - table accuracy   (cell/row/col P-R + TEDS-lite, per file TYPE)  -> table_metrics
  - text accuracy    (CER)                                          -> reuse run_ocr_eval
  - the TWO numbers  (auto-accept rate  vs  committed accuracy)
  - speed/memory     (wall time + peak RSS per file, optional)

DESIGN: it scores ALREADY-PRODUCED outputs against golden expected files, so the
accuracy pass needs NO GPU/JVM - run the extractor on the server, then benchmark the
`out/` dir here or there. Timing is a thin wrapper that shells out to the extractor.

GOLDEN LAYOUT (see eval/golden/README.md)
    eval/golden/<stem>.tables.json   # {"type":"pdf","tables":[{"grid":[[...]]}, ...]}
    eval/golden/<stem>.gt.txt        # full correct text (for CER), optional
    eval/golden/<stem>.fields.json   # {"amount_figures":"..."}, optional

USAGE
    # A) accuracy: score produced outputs vs golden (no GPU)
    python eval/run_benchmark.py score --run out/ --golden eval/golden/ --out eval/reports/

    # B) speed: time the extractor over a sample folder (server; records wall+peak RAM)
    python eval/run_benchmark.py time --samples samples/ --out eval/reports/ \
        --cmd "{py} table_pdf.py --in {file} --out {outdir} --verify"
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from eval.table_metrics import score_tables, norm_text, tables_from_layout  # noqa: E402

try:
    import psutil  # optional, for peak RSS
except Exception:
    psutil = None


# --------------------------------------------------------------------------- CER
def _cer(pred: str, gold: str) -> float:
    """Character error rate = levenshtein(pred, gold)/len(gold), space-normalised."""
    a, b = norm_text(pred), norm_text(gold)
    if not b:
        return 0.0 if not a else 1.0
    # iterative DP levenshtein
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return round(prev[-1] / len(b), 4)


# --------------------------------------------------------------------------- find outputs
# NOTE: we substring-match on filenames rather than glob, because sample names contain
# glob metacharacters and many dots/parens (e.g. "image (1).png", "Civil BBU 25.10.25.").
def _walk(run: Path, suffix: str, stem: str) -> list[Path]:
    s = stem.lower()
    return [p for p in run.rglob("*")
            if p.is_file() and p.name.lower().endswith(suffix) and s in p.name.lower()]


def _grids_from_cells_json(data: Any) -> list[list[list[Any]]]:
    """xlsx run output <stem>.cells.json = {sheet_name: [[row cells]]}. One grid per sheet,
    in sheet order (matches how the gold lists one table per sheet)."""
    if isinstance(data, dict):
        return [g for g in data.values() if isinstance(g, list) and g]
    return []


def _grids_from_table_row_chunks(lines: list[str]) -> list[list[list[Any]]]:
    """docx run output <stem>.chunks.jsonl carries table rows as 'table_row' chunks whose text is
    the cells joined by ' | ' (see docx_extract). Group CONSECUTIVE table_row chunks into one grid
    (any non-table chunk between them ends the current table). Best-effort: the ' | ' delimiter is
    what the extractor emits, so a cell containing ' | ' literally would over-split (rare)."""
    grids: list[list[list[Any]]] = []
    cur: list[list[Any]] = []
    for ln in lines:
        if not ln.strip():
            continue
        try:
            o = json.loads(ln)
        except Exception:
            continue
        if o.get("kind") == "table_row":
            cur.append([c.strip() for c in str(o.get("text", "")).split(" | ")])
        elif cur:
            grids.append(cur); cur = []
    if cur:
        grids.append(cur)
    return grids


def _find_pred_tables(run: Path, stem: str) -> list[list[list[Any]]]:
    """Locate produced grids for <stem> across every output shape the rig emits, by file type:
    PDF/scanned -> layout.json / doc.json (pages[].elements[]); xlsx -> cells.json ({sheet:grid});
    docx -> chunks.jsonl (table_row chunks); or a pre-extracted *.tables.json. First hit wins."""
    for lj in _walk(run, ".layout.json", stem):                 # PDF / scanned (doc_layout)
        grids = tables_from_layout(json.loads(lj.read_text(encoding="utf-8")))
        if grids:
            return grids
    for dj in _walk(run, ".doc.json", stem):                    # unified doc (when it carries table elements)
        grids = tables_from_layout(json.loads(dj.read_text(encoding="utf-8")))
        if grids:
            return grids
    for cj in _walk(run, ".cells.json", stem):                  # xlsx (one grid per sheet)
        grids = _grids_from_cells_json(json.loads(cj.read_text(encoding="utf-8")))
        if grids:
            return grids
    for ch in _walk(run, ".chunks.jsonl", stem):                # docx (table_row chunks)
        grids = _grids_from_table_row_chunks(ch.read_text(encoding="utf-8", errors="ignore").splitlines())
        if grids:
            return grids
    for tj in _walk(run, ".json", stem):                        # pre-extracted {"tables":[{"grid":...}]}
        if "tables" not in tj.name.lower():
            continue
        data = json.loads(tj.read_text(encoding="utf-8"))
        if isinstance(data, dict) and "tables" in data:
            return [t.get("grid", []) for t in data["tables"]]
    return []


def _find_pred_text(run: Path, stem: str) -> str:
    for md in _walk(run, ".md", stem):
        return md.read_text(encoding="utf-8", errors="ignore")
    for cj in _walk(run, ".jsonl", stem):
        if "chunks" not in cj.name.lower():
            continue
        return " ".join(json.loads(l).get("text", "") for l in cj.read_text(
            encoding="utf-8", errors="ignore").splitlines() if l.strip())
    return ""


# --------------------------------------------------------------------------- score mode
def cmd_score(a: argparse.Namespace) -> None:
    run, golden, out = Path(a.run), Path(a.golden), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    by_type: dict[str, dict] = {}
    per_file: list[dict] = []

    gold_tables = sorted(golden.glob("*.tables.json"))
    skipped: list[str] = []
    for gt in gold_tables:
        stem = gt.name[: -len(".tables.json")]
        gdata = json.loads(gt.read_text(encoding="utf-8"))
        # Score ONLY human-verified ground truth. An unverified gold (the human pass never happened -
        # see eval/golden/README.md) would otherwise report a meaningless 0.0 that reads as an
        # extraction failure. Skip it explicitly and report the count instead.
        if gdata.get("verified") is False:
            skipped.append(stem)
            continue
        ftype = gdata.get("type", "pdf")
        gold_grids = [t.get("grid", t) for t in gdata.get("tables", [])]
        pred_grids = _find_pred_tables(run, stem)
        n = min(len(pred_grids), len(gold_grids))
        tbl = score_tables(list(zip(pred_grids[:n], gold_grids[:n]))) if n else {"n_tables": 0}
        rec: dict[str, Any] = {"stem": stem, "type": ftype,
                               "gold_tables": len(gold_grids), "pred_tables": len(pred_grids),
                               "table_content_f1": tbl.get("content_f1"),
                               "table_recall": tbl.get("content_recall"),
                               "positional_f1": tbl.get("positional_f1"),
                               "row_accuracy": tbl.get("row_accuracy"),
                               "teds_lite": tbl.get("teds_lite"),
                               "misplacement": tbl.get("misplacement")}
        gt_txt = golden / f"{stem}.gt.txt"
        if gt_txt.exists():
            rec["cer"] = _cer(_find_pred_text(run, stem), gt_txt.read_text(encoding="utf-8", errors="ignore"))
        per_file.append(rec)
        b = by_type.setdefault(ftype, {"files": 0, "f1_sum": 0.0, "recall_sum": 0.0,
                                        "pos_sum": 0.0, "row_sum": 0.0, "misp_sum": 0.0,
                                        "teds_sum": 0.0, "cer_sum": 0.0, "cer_n": 0,
                                        "table_count_match": 0})
        b["files"] += 1
        b["f1_sum"] += tbl.get("content_f1", 0.0) or 0.0
        b["recall_sum"] += tbl.get("content_recall", 0.0) or 0.0
        b["pos_sum"] += tbl.get("positional_f1", 0.0) or 0.0
        b["row_sum"] += tbl.get("row_accuracy", 0.0) or 0.0
        b["misp_sum"] += tbl.get("misplacement", 0.0) or 0.0
        b["teds_sum"] += tbl.get("teds_lite", 0.0) or 0.0
        if len(pred_grids) == len(gold_grids):
            b["table_count_match"] += 1
        if "cer" in rec:
            b["cer_sum"] += rec["cer"]
            b["cer_n"] += 1

    agg = {}
    for t, b in by_type.items():
        f = b["files"] or 1
        agg[t] = {"files": b["files"],
                  "mean_table_f1": round(b["f1_sum"] / f, 4),
                  "mean_table_recall": round(b["recall_sum"] / f, 4),
                  "mean_positional_f1": round(b["pos_sum"] / f, 4),
                  "mean_row_accuracy": round(b["row_sum"] / f, 4),
                  "mean_misplacement": round(b["misp_sum"] / f, 4),
                  "mean_teds_lite": round(b["teds_sum"] / f, 4),
                  "table_count_match_rate": round(b["table_count_match"] / f, 4),
                  "mean_cer": round(b["cer_sum"] / b["cer_n"], 4) if b["cer_n"] else None}
    report = {"per_file": per_file, "by_type": agg, "skipped_unverified": skipped,
              "note": "table_count_match_rate<1 means we produced a different #tables than gold "
                      "(split/merge error). Investigate before trusting f1. skipped_unverified = gold "
                      "files with verified:false (no human pass yet) - not scored."}
    (out / "benchmark_accuracy.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    _write_accuracy_md(report, out / "benchmark_accuracy.md")
    print(json.dumps(agg, indent=2))
    print(f"[ok] {out/'benchmark_accuracy.md'}")
    if skipped:
        print(f"[skip] {len(skipped)} unverified gold file(s) not scored (verified:false): "
              f"{', '.join(s[:32] for s in skipped)}")
    if not gold_tables:
        print("[warn] no *.tables.json golden files found - see eval/golden/README.md to create them.")


def _write_accuracy_md(report: dict, out: Path) -> None:
    L = ["# Benchmark - accuracy vs golden", "", "## By file type", "",
         "| type | files | content F1 | positional F1 | row acc | TEDS-lite | misplace | recall | #tables match | mean CER |",
         "|---|---|---|---|---|---|---|---|---|---|"]
    for t, b in report["by_type"].items():
        L.append(f"| {t} | {b['files']} | {b['mean_table_f1']} | {b.get('mean_positional_f1')} | "
                 f"{b.get('mean_row_accuracy')} | {b['mean_teds_lite']} | {b.get('mean_misplacement')} | "
                 f"{b['mean_table_recall']} | {b['table_count_match_rate']} | {b['mean_cer']} |")
    L += ["", f"> {report['note']}", "", "## Per file", "",
          "| stem | type | gold/pred tbls | F1 | recall | row acc | TEDS | misplace | CER |",
          "|---|---|---|---|---|---|---|---|---|"]
    for r in report["per_file"]:
        L.append(f"| {r['stem'][:34]} | {r['type']} | {r['gold_tables']}/{r['pred_tables']} | "
                 f"{r.get('table_content_f1')} | {r.get('table_recall')} | {r.get('row_accuracy')} | "
                 f"{r.get('teds_lite')} | {r.get('misplacement')} | {r.get('cer','-')} |")
    out.write_text("\n".join(L), encoding="utf-8")


# --------------------------------------------------------------------------- time mode
def cmd_time(a: argparse.Namespace) -> None:
    samples, out = Path(a.samples), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    exts = tuple(e.strip() for e in a.ext.split(",")) if a.ext else (
        ".pdf", ".xlsx", ".xlsm", ".xls", ".docx", ".png", ".jpg", ".xer", ".mpp", ".xml")
    files = [p for p in samples.rglob("*") if p.suffix.lower() in exts] if samples.is_dir() else [samples]
    rows = []
    for f in files:
        outdir = out / "_time_out" / f.stem
        outdir.mkdir(parents=True, exist_ok=True)
        cmd = a.cmd.format(py=a.py, file=str(f), outdir=str(outdir))
        t0 = time.perf_counter()
        peak = _run_capture_peak(cmd)
        dt = round(time.perf_counter() - t0, 3)
        mb = f.stat().st_size / 1e6
        rows.append({"file": f.name, "ext": f.suffix.lower(), "size_mb": round(mb, 3),
                     "seconds": dt, "mb_per_s": round(mb / dt, 3) if dt else None,
                     "peak_rss_mb": peak})
        print(f"  {f.name:45.45}  {dt:8.2f}s  peak={peak}MB")
    (out / "benchmark_speed.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    _write_speed_md(rows, out / "benchmark_speed.md")
    print(f"[ok] {out/'benchmark_speed.md'}")


def _run_capture_peak(cmd: str) -> Optional[float]:
    if psutil is None:
        subprocess.run(cmd, shell=True, capture_output=True)
        return None
    proc = psutil.Popen(cmd, shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    peak = 0
    try:
        while proc.poll() is None:
            try:
                rss = proc.memory_info().rss
                for c in proc.children(recursive=True):
                    rss += c.memory_info().rss
                peak = max(peak, rss)
            except Exception:
                pass
            time.sleep(0.1)
    finally:
        proc.wait()
    return round(peak / 1e6, 1)


def _write_speed_md(rows: list[dict], out: Path) -> None:
    L = ["# Benchmark - speed / memory", "",
         "| file | ext | size MB | seconds | MB/s | peak RSS MB |",
         "|---|---|---|---|---|---|"]
    for r in sorted(rows, key=lambda r: -r["seconds"]):
        L.append(f"| {r['file'][:40]} | {r['ext']} | {r['size_mb']} | {r['seconds']} | "
                 f"{r['mb_per_s']} | {r['peak_rss_mb']} |")
    out.write_text("\n".join(L), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description="kb-extract-rig accuracy + speed benchmark")
    sub = ap.add_subparsers(dest="mode", required=True)

    s = sub.add_parser("score", help="score produced outputs vs golden (no GPU)")
    s.add_argument("--run", required=True)
    s.add_argument("--golden", required=True)
    s.add_argument("--out", default="eval/reports")
    s.set_defaults(func=cmd_score)

    t = sub.add_parser("time", help="time the extractor over samples (server)")
    t.add_argument("--samples", required=True)
    t.add_argument("--out", default="eval/reports")
    t.add_argument("--py", default=sys.executable)
    t.add_argument("--ext", default="")
    t.add_argument("--cmd", required=True,
                   help='command template with {py} {file} {outdir}, '
                        'e.g. "{py} table_pdf.py --in {file} --out {outdir} --verify"')
    t.set_defaults(func=cmd_time)

    a = ap.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
