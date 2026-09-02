# Executive Summary — kb-extract-rig production review

*First-pass review by the `extract-rig-qa` agent. Grounded in a full read of all 20
modules + `CONTEXT.md`. Line numbers were read from the current source; re-verify
before editing.*

## Verdict

This is a **genuinely strong, unusually honest codebase** — not a prototype. It earns
completeness through geometry + an arithmetic self-audit, reports two numbers instead
of a fake "100%", and refuses to fabricate structure. The design instincts are
excellent. It is **not yet production-grade at enterprise scale**, for a small number
of specific, fixable reasons — mostly *silent-data-loss holes*, an *uncalibrated
confidence gate*, *no ground-truth accuracy measurement* (now addressed by `eval/`),
and an *unproven, unwired schedule (XER/MPP) sub-system*.

## Production-readiness scores

| Sub-system | Score | One-line reason |
|---|---:|---|
| **Document extraction (PDF/Excel/DOCX) core** | **7.0 / 10** | Strong architecture + tie-out; held back by ~4 silent-data-loss holes and no accuracy metric. |
| **Table engine (`robust_tables`)** | **6.5 / 10** | Excellent presence-audit; but guarantees word *presence*, not correct *placement* — merged/spanning cells misplace silently. |
| **OCR / scanned / handwriting** | **5.0 / 10** | Sound printed-scan ladder; **no handwriting path** and confidence is averaged so handwriting drops silently. |
| **Reconciliation ("request original Excel")** | **6.5 / 10** | Right idea, well-gated; page-attribution bug + greedy sheet-linking + uncalibrated gate. |
| **Schedule (XER / MPP)** | **3.0 / 10** | Marked "not yet proven" and it isn't: MPXJ calls unverified, zero tests, unwired, ~60–70% field coverage. |
| **Testing & measurement** | **5.5 / 10** | 67 solid core tests; but schedule untested, OCR untested, and (until now) **no table-accuracy metric vs truth**. |
| **Overall** | **6.0 / 10** | A ~3–4 week focused hardening pass gets the document core to a defensible 8.5–9. |

## Can you hit the accuracy targets?

**Measured this run (no-GPU, 2026-07-06):** on 4 hand-verified digital goldens (3 `.xlsx` + 1 `.docx`,
7 grids) `content_f1 = positional_f1 = row_acc = teds_lite = 1.000`, `misplacement = 0.000`
(`eval/reports/benchmark_accuracy.md`). Scanned / handwriting / schedule are **not yet measured** (need
GPU/JVM). The one digital-PDF sample was a Primavera Gantt → deferred (see below).

| Target | Realistic? | Measured / status |
|---|---|---|
| Excel / XML = **100%** | **Yes** | **Measured content_f1 = 1.000** (3 files, 6 sheets), extraction reproduces the verified grids exactly. Residual risks unchanged: `.xls` float-serial dates & merged cells in `read_only` (fixes still pending). |
| DOCX ≈ **100%** | **Yes** | **Measured content_f1 = 1.000** (1 file, 23×7 table); digital cell read. |
| PDF (digital) ≥ **95%** | **Yes, unmeasured on a real BOQ this run** | The only digital-PDF sample was a Gantt (deferred). Digital-PDF *data-table* accuracy is carried by the xlsx/docx goldens (positional_f1 = 1.000) + `test_digital_golden_exact_and_tieout`; needs a real digital BOQ PDF gold to score directly. |
| Schedule (Gantt PDF / XER / MPP) | **NOT YET MEASURED** | Needs JVM/MPXJ or a native `.xer` reader. The `Dep-14…Network schedule` PDF garbles under the PDF path (`pdfplumber` `(cid:)` ligatures) → deferred, not scored. |
| Images / scanned ≥ **95%** | **NOT YET MEASURED** | Needs GPU (docTR/Tesseract/Florence) + a scanned gold set + `run_ocr_eval.py` CER. |
| Handwriting → HITL | **NOT YET MEASURED / Not yet** | No detector forces low-confidence handwriting to review; needs GPU. Single most important accuracy fix. |

## Top 7 things to fix first (full list in `04_ACTION_PLAN.md`)

1. **Handwriting silently drops** (`pdf_extract.py` ~181/418) — page confidence is
   averaged over good printed words, so a low-confidence handwritten annotation never
   trips the gate. Add a low-word-confidence/handwriting detector that *forces* review.
   **[correctness · HIGH]**
2. **Merged-row values silently lost** (`common.parse_number:205`, `robust_tables:161`)
   — a cell holding `"100 200"` yields `100`; the tie-out can still pass. Detect any
   single cell holding ≥2 numbers on ruled grids too, and flag. **[correctness · HIGH]**
3. **Borderless-table-without-bbox drops all prose** (`doc_layout.py:83-88`) — the
   fallback bbox is the whole page, so every text line gets subtracted. **[correctness · HIGH]**
4. **`.xls` dates become fake amounts** + **merged cells not expanded**
   (`excel_extract.py:187,190`) — the two holes under the Excel "100%" claim. **[correctness · HIGH]**
5. **Schedule relationships silently vanish** (`schedule_mpxj.py:391`) — probable wrong
   MPXJ accessor + a swallowing `except` → 0 edges, no error. Run the probe, fix the
   call, add tests. **[correctness · HIGH]**
6. **Uncalibrated confidence gate** — 0.70/0.90/0.95 are guesses. Calibrate against a
   gold set (ECE) before trusting auto-accept. **[reliability · HIGH]**
7. **File-handle leaks at scale** (`pdf_extract.py:494`, `table_pdf.py:152`,
   `doc_layout.py:555`) — unclosed `fitz`/temp dirs; harmless at 10 files, a Windows
   lock/inode problem at 1M. **[scale · MED-HIGH]**

## What this review shipped alongside the findings

- **`eval/table_metrics.py`** — the ground-truth table-accuracy metric the rig lacked
  (cell/row/col P-R, TEDS-lite, and a `misplacement` number that catches exactly the
  placement bug in #2). Tested and working.
- **`eval/confidence_report.py`** — the HITL routing worklist (Tasks 10–11): every
  uncertain table → the exact original file to request.
- **`eval/run_benchmark.py` + `make_golden.py` + `report.py`** — the accuracy/speed
  harness + golden bootstrap + report assembler.
- **`.claude/agents/extract-rig-qa.md`** — the reusable agent that drives all of this.

## Verified this pass (executed, no GPU) — see `05_VERIFIED_NO_GPU_RUN.md`

- **`67 passed, 0 failed`** (regression suite) and **all 20 modules compile**.
- **Digital `table_pdf` + Excel paths run correctly on the real samples** — extraction
  works, the money VERIFY fires, uncertain files route to review.
- **A real crash was reproduced:** `doc_layout` hits Windows MAX_PATH (271 > 260 chars)
  on a deep output dir and silently drops the file to `_errors.json` (risk R14).
- **Confirmed Excel-tie-out gap:** all three real `.xlsx` files read 100% of cells but
  the arithmetic proof fired on *none* (only Schedule-H shapes trigger it).
- The eval harness was validated on real output (found + fixed a schema bug in itself).

Read next: `01_ARCHITECTURE_REVIEW.md` → `02_CODE_REVIEW.md` → `03_ACCURACY_AND_RISK.md`
→ `04_ACTION_PLAN.md` → `05_VERIFIED_NO_GPU_RUN.md`, and `SERVER_RUNBOOK.md` for the
benchmarks that need the GPU/JVM box.
