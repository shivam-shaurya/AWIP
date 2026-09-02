# `eval/` — the measurement harness

> Measure, don't assert. Every accuracy or speed claim about this rig should come
> from a command in here, run on a named dataset — not from a guess. Built to serve
> the `extract-rig-qa` agent (`.claude/agents/extract-rig-qa.md`).

## What's here

| File | Does |
|---|---|
| `table_metrics.py` | **The metric the rig was missing**: ground-truth table accuracy — cell/row/col precision-recall, header accuracy, shape match, a TEDS-lite structural score, and a `misplacement` number that separates *dropped data* from *right-value-wrong-place*. Numeric-tolerant via `common.parse_number`. |
| `run_benchmark.py` | `score` mode: table + text (CER) accuracy of produced outputs vs golden (no GPU). `time` mode: wall-time + peak RSS per file (server). Reports the two numbers. |
| `compare_engines.py` + `engines/` | **OPT-IN multi-engine comparison** (eval-only, never imported by the pipeline): run any subset of `current` (this rig — sovereign baseline), `docling` (IBM, sovereign), `paddle` (⚠ Baidu — **test-only/non-sovereign**), `vlm` (Florence-2, sovereign; pluggable backends) over the same files. Ties out **every** engine's tables via `common.verify_table`, scores against `golden/<stem>.tables.json` when present, and writes `reports/engine_compare.{md,json}`. Missing engine/GPU → that engine reports `available: NO` and the run continues. |
| `confidence_report.py` | Turns a completed run into a HITL routing worklist: AUTO_ACCEPT / MANUAL_REVIEW / REQUEST_SOURCE per the confidence policy. Says which original file to request. |
| `make_golden.py` | Bootstrap a golden expected-output file by *correcting* machine output (start from digital files, which are ~100%). |
| `report.py` | Assemble `INDEX.md` from the static reviews + the latest measured numbers. Prints "not yet measured" instead of faking a number. |
| `golden/` | Hand-verified ground truth. See `golden/README.md` for the format + coverage matrix. |
| `reports/` | The written reviews + the machine-generated benchmark/confidence outputs. |

## Quick start

```powershell
$PY = "C:\Users\admin\pradeep-defect-work\venv2\Scripts\python.exe"   # server venv
# (laptop: just use `python` — the pure-logic parts run without GPU)

# 0) always: the regression suite (locks the arithmetic/geometry core)
& $PY tests\test_core.py

# 1) build a golden or two (digital files are legit gold seeds — verify every cell!)
& $PY table_pdf.py --in "samples\Civil BBU 25.10.25..xlsx" --out out\ --verify
& $PY eval\make_golden.py --from "out\Civil BBU 25.10.25.tables.json" --stem "Civil BBU 25.10.25." --type xlsx
#    -> open eval/golden/*.tables.json, FIX cells, set "verified": true

# 2) score accuracy of a produced run vs golden (no GPU)
& $PY eval\run_benchmark.py score --run out\ --golden eval\golden\ --out eval\reports\

# 3) HITL routing worklist from a run
& $PY eval\confidence_report.py --run out\ --out eval\reports\

# 4) (server) time the extractor over the samples
& $PY eval\run_benchmark.py time --samples samples\ --out eval\reports\ `
    --py $PY --cmd "{py} table_pdf.py --in {file} --out {outdir} --verify"

# 5) assemble the index (re-injects the latest measured numbers)
& $PY eval\report.py --reports eval\reports\ --out eval\reports\INDEX.md

# 6) OPT-IN multi-engine comparison (default OFF; pipeline unchanged). CPU: current works out of
#    the box; `pip install docling paddlepaddle paddleocr` to light up those rows.
& $PY eval\compare_engines.py --engines current,docling,paddle `
    --in "samples\Risk & Compliance - aaryan.docx" "samples\Dep-14&11C Network schedule for Oct25.pdf" "samples\image (1).png"
#    (server, add the sovereign VLM): --engines current,docling,paddle,vlm --vlm-backend florence
#    -> eval\reports\engine_compare.md  (side-by-side: #tables | tie-out | conf | seconds | accuracy vs gold)
```

## The two numbers (always report both)

- **auto-accept rate** — fraction the machine committed with no human, at the gate.
- **committed accuracy** — accuracy of what was committed (target ~100%, because
  nothing unverified is saved). Anything below the gate is routed, not committed.

Reporting only "95% accuracy" hides which number you mean. The harness prints both.

## Calibrate before trusting a gate

The 0.70 (and the 0.90/0.95 HITL) gates are currently **guesses**. Before you trust
auto-accept, calibrate reported confidence against measured error:

```powershell
& $PY run_ocr_eval.py --out out\ --gold eval\golden\ --calibrate    # -> calibration.json + ECE
```
An uncalibrated auto-accept gate is worse than no gate — it commits wrong data with
false confidence. See `reports/SERVER_RUNBOOK.md`.
