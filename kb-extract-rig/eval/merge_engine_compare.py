#!/usr/bin/env python3
"""Merge multiple engine_compare_*.json into ONE side-by-side table + a text side-by-side.

Used when the engines can't all run in one venv (e.g. paddle is isolated), so the
comparison is produced in two passes and merged here. Adds a `text chars` column
(a proxy for how much content each engine actually extracted — the real signal on
text-heavy docs where nobody finds tables).

    python eval/merge_engine_compare.py eval/reports/engine_compare_scanned.json eval/reports/engine_compare_paddle.json
"""
import json
import sys
from pathlib import Path

paths = sys.argv[1:] or ["eval/reports/engine_compare_scanned.json",
                         "eval/reports/engine_compare_paddle.json"]
byfile, order = {}, []
for p in paths:
    d = json.loads(Path(p).read_text(encoding="utf-8"))
    for f in d.get("files", []):
        stem = f.get("stem") or f.get("file")
        if stem not in byfile:
            byfile[stem] = {"file": f.get("file"), "engines": {}}
            order.append(stem)
        for e in f.get("engines", []):
            byfile[stem]["engines"][e.get("engine")] = e


def _chars(e):
    return len(e.get("text") or "")


def _tieout(e):
    to = e.get("tieout")
    if not to:
        return "n/a"
    return "PASS" if to.get("pass") else f"FAIL({to.get('real_gaps')})"


lines = ["# Engine comparison — merged (all engines, scanned NCR PDFs)", ""]
for stem in order:
    ff = byfile[stem]
    lines += [f"## {Path(ff['file']).name}", "",
              "| engine | available | #tables | tie-out | text conf | seconds | text chars |",
              "|---|---|---|---|---|---|---|"]
    for name, e in ff["engines"].items():
        conf = e.get("confidence")
        lines.append(f"| {name} | {'yes' if e.get('available') else 'NO'} | "
                     f"{len(e.get('tables') or [])} | {_tieout(e)} | "
                     f"{'-' if conf is None else f'{conf:.2f}'} | "
                     f"{e.get('seconds', 0):.1f} | {_chars(e)} |")
    lines.append("")
Path("eval/reports/engine_compare_merged.md").write_text("\n".join(lines), encoding="utf-8")
print("\n".join(lines))

# text side-by-side for the first file (so a human can judge which OCR is best)
stem = order[0]
ff = byfile[stem]
sbs = [f"# Text side-by-side — {Path(ff['file']).name}", "",
       "First 900 characters of each engine's extracted text. Compare against the real PDF.", ""]
for name, e in ff["engines"].items():
    sbs += [f"## {name}  (text chars={_chars(e)}, conf={e.get('confidence')})", "```",
            (e.get("text") or "")[:900], "```", ""]
Path("eval/reports/scanned_side_by_side.md").write_text("\n".join(sbs), encoding="utf-8")
print("\n[ok] wrote engine_compare_merged.md + scanned_side_by_side.md")
