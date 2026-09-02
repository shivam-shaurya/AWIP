#!/usr/bin/env python3
r"""
extract_schedule.py - CLI for the MPXJ schedule parser (schedule_mpxj.parse_schedule).

Runs the parser on Primavera P6 (.xer) / MS Project (.mpp) / PMXML / MSPDI files and
dumps structured JSON. This is the CLI the parser was missing (it was an unwired
"island"). The parser itself is SERVER-VERIFIED (probe_schedule_mpxj.py confirmed:
project properties + every task field + relationships getPredecessorTask/getSuccessorTask
all OK on real .xer/.mpp).

SERVER-ONLY: needs the JVM (default-jre) + `mpxj` + `JPype1` (see requirements-schedule.txt).

Usage:
    python extract_schedule.py --in samples --out sched_out
    python extract_schedule.py --in "samples/SP-II-NMDC 20th Mar.xer" --out sched_out

Per file it writes  sched_out/<stem>.schedule.json  =
    {format, baseline_source, metadata{}, activities[], relationships[], errors[]}
and prints a one-line summary. A file MPXJ can't open yields a STRUCTURED fatal error
inside its JSON (errors[]) and never aborts the batch.
"""
from __future__ import annotations

import argparse
import datetime
import json
from pathlib import Path

import common
import schedule_mpxj

SCHED_EXT = (".xer", ".mpp", ".xml", ".pmxml")


def _ser(o):
    """JSON fallback: dates -> ISO, any object with __dict__ (SimpleNamespace / dataclass)
    -> its attributes, everything else -> str (never raises)."""
    if isinstance(o, (datetime.date, datetime.datetime)):
        return o.isoformat()
    if hasattr(o, "__dict__"):
        return vars(o)
    return str(o)


def extract_one(path: Path, outdir: Path) -> dict:
    res = schedule_mpxj.parse_schedule(str(path))
    outdir.mkdir(parents=True, exist_ok=True)
    out_path = outdir / (path.stem + ".schedule.json")
    common.atomic_write_text(out_path, json.dumps(res, default=_ser, indent=2, ensure_ascii=False))  # long-path safe
    return {"file": path.name, "format": res.get("format"),
            "activities": len(res.get("activities", [])),
            "relationships": len(res.get("relationships", [])),
            "errors": res.get("errors", []),
            "out": str(out_path)}


def main():
    ap = argparse.ArgumentParser(description="Extract .xer/.mpp/PMXML/MSPDI schedules to JSON via MPXJ.")
    ap.add_argument("--in", dest="inp", required=True, help="a schedule file or a folder")
    ap.add_argument("--out", dest="out", default="sched_out", help="output directory")
    a = ap.parse_args()

    inp, outdir = Path(a.inp), Path(a.out)
    files = [inp] if inp.is_file() else sorted(
        p for p in inp.rglob("*") if p.suffix.lower() in SCHED_EXT)
    if not files:
        print(f"No .xer/.mpp/.xml schedule files found under {inp}")
        return

    print(f"[schedule] {len(files)} file(s) -> {outdir}/")
    for f in files:
        try:
            r = extract_one(f, outdir)
        except Exception as e:
            print(f"  [CRASH] {f.name}: {type(e).__name__}: {e}")
            continue
        tag = "OK" if not r["errors"] else f"{len(r['errors'])} err"
        print(f"  [{tag:>6}] {r['file'][:52]:52} fmt={str(r['format']):5} "
              f"activities={r['activities']:5}  relationships={r['relationships']:5}")
        for err in r["errors"]:
            print(f"           ! {err.get('severity','?')}: {err.get('message','')[:90]}")


if __name__ == "__main__":
    main()
