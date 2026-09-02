#!/usr/bin/env python3
r"""
make_golden.py - bootstrap a GOLDEN expected-output file from a produced extraction,
so you *correct* machine output into ground truth instead of typing tables by hand.

Workflow:
  1. Run the extractor on a sample you trust you can verify (ideally a DIGITAL file,
     which is ~100% correct, so its output is a legitimate gold seed).
  2. python eval/make_golden.py --from out/<stem>/<stem>.layout.json --stem <stem>
     (or --from a table_pdf .tables.json). Writes eval/golden/<stem>.tables.json.
  3. OPEN that file and FIX every wrong cell against the original document. A golden
     file is only as good as this human pass - do not skip it.
  4. For scanned/handwritten files: seed from the ORIGINAL Excel (excel_extract) when
     one exists - that is the authoritative grid; the PDF is what you score against it.

The emitted json matches what run_benchmark.py / table_metrics.py expect:
    {"type": "pdf", "source": "<name>", "verified": false, "tables": [{"grid": [[...]]}]}
`verified:false` is a loud reminder the human pass hasn't happened; flip to true when done.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def grids_from_layout(p: Path) -> list[list[list]]:
    # doc_layout nests table elements under pages[].elements[] (verified on real output);
    # older/other paths use a top-level "elements". Handle both.
    data = json.loads(p.read_text(encoding="utf-8"))
    grids = []
    for pg in data.get("pages", []) or []:
        grids += [e["grid"] for e in (pg.get("elements") or []) if e.get("type") == "table" and e.get("grid")]
    if not grids:
        grids = [e["grid"] for e in data.get("elements", []) if e.get("type") == "table" and e.get("grid")]
    return grids


def grids_from_tables_json(p: Path) -> list[list[list]]:
    data = json.loads(p.read_text(encoding="utf-8"))
    if isinstance(data, dict) and "tables" in data:
        return [t.get("grid", []) for t in data["tables"]]
    return data


def main() -> None:
    ap = argparse.ArgumentParser(description="Bootstrap a golden expected-output file.")
    ap.add_argument("--from", dest="src", required=True, help="a produced layout.json or tables.json")
    ap.add_argument("--stem", default="", help="golden stem (default: derived from --from)")
    ap.add_argument("--type", default="pdf", help="file type tag: pdf/xlsx/xer/mpp/image/scanned")
    ap.add_argument("--golden-dir", default="eval/golden")
    a = ap.parse_args()

    src = Path(a.src)
    grids = grids_from_layout(src) if src.name.endswith("layout.json") else grids_from_tables_json(src)
    # strip only the KNOWN produced-output suffixes (filenames may contain dots, so don't split on ".")
    stem = a.stem
    if not stem:
        stem = src.name
        for suf in (".layout.json", ".tables.json", ".doc.json", ".json"):
            if stem.endswith(suf):
                stem = stem[: -len(suf)]
                break
    gdir = Path(a.golden_dir)
    gdir.mkdir(parents=True, exist_ok=True)
    out = gdir / f"{stem}.tables.json"
    payload = {"type": a.type, "source": src.name, "verified": False,
               "n_tables": len(grids),
               "_instructions": "FIX every wrong cell against the original, then set verified=true.",
               "tables": [{"grid": g} for g in grids]}
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[ok] seeded {out} with {len(grids)} tables. NOW open it and verify every cell.")


if __name__ == "__main__":
    main()
