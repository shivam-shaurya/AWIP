# Accuracy & Risk Report — kb-extract-rig

Two things here: (1) an honest per-type accuracy assessment against your targets, and
(2) a **risk register** of the silent-data-loss modes — the cases where the rig can
return *wrong* data while reporting success. Silent wrong output is worse than a crash;
these are ranked first.

---

## Part 1 — Accuracy assessment by type

> **MEASURED — no-GPU run, 2026-07-06** (`eval/run_benchmark.py score` vs hand-verified goldens;
> full table in `benchmark_accuracy.md` / `INDEX.md`; cell-weighted micro-averages):
>
> | type | files | content_f1 | positional_f1 | row_acc | teds_lite | misplacement | CER |
> |---|---|---|---|---|---|---|---|
> | xlsx | 3 | **1.000** | 1.000 | 1.000 | 1.000 | 0.000 | — (no gt.txt) |
> | docx | 1 | **1.000** | 1.000 | 1.000 | 1.000 | 0.000 | — (no gt.txt) |
>
> **Verified goldens:** 7 grids across 4 digital files (3 `.xlsx` + 1 `.docx`), each cross-checked
> against an independent raw read (fresh `openpyxl` / `python-docx`) and flagged
> `needs_human_spotcheck`. Digital structured extraction reproduces the verified grids **exactly**
> (meets the 100% / ≥95% targets). These are digital *self-consistent* reproductions validated by an
> independent reader — not a substitute for OCR/scanned measurement.
>
> **NOT YET MEASURED — needs GPU/JVM (or a different path); no number quoted:**
> - **Scanned PDF · images · handwriting** — need the docTR→Tesseract→Florence GPU ladder + a scanned
>   gold set + `run_ocr_eval.py` CER.
> - **Schedule** — the one digital-PDF sample (`Dep-14…Network schedule`) is a **Primavera Gantt**; the
>   PDF table path garbles it (`pdfplumber` `(cid:)` ligature artifacts — `fitz` reads clean) and its
>   authoritative source is the `.xer`/MPXJ path. Recorded in `eval/golden/…deferred.json`, **not scored**.
> - **CER (text accuracy)** — no `.gt.txt` gold yet → shown as `—`.

### Digital PDF (target ≥95%, effectively ~100%)
Text-layer read + arithmetic tie-out make digital extraction essentially exact **when
the table is well-formed**. The residual risk is *placement*, not *presence*: the audit
proves every word landed in *a* cell, not the *right* cell — quantified by
`eval/table_metrics.py` (`positional_f1` vs `content_f1`; the `misplacement` number).
**This run:** the only digital-PDF sample was a Primavera Gantt (deferred, above), so digital-PDF
*data-table* accuracy is carried by the xlsx/docx goldens (positional_f1 = 1.000, misplacement = 0.0)
and the `test_digital_golden_exact_and_tieout` regression, not by a scored BOQ-style PDF this run.

### Excel / XML (target 100%) — **measured content_f1 = 1.000 (3 files, 6 sheets) this run**
Direct structured read is the right approach and gets you to 100% **after two fixes**:
- `.xls` date cells come back from `xlrd` as float serials (~45000) and are never
  converted → they read as amounts (`excel_extract.py:187,50`).
- `read_only=True` does **not** expand merged cells → a merged total/header yields a
  value only in the anchor cell, so `find_meta`/`tieout` miss it (`excel_extract.py:190`).
Also: the tie-out only fires when a Schedule-H weightage column (~1.0) is present
(`excel_extract.py:114`); generic BOQ totals aren't detected (safe — routes to review —
but "audited" overstates coverage). Multi-sheet / hidden-sheet selection is untested.

### XER — Primavera P6 (target 100%) — **NOT YET MEASURED (needs JVM/MPXJ or a native `.xer` reader)**
**Not reachable via the current MPXJ path as-is.** MPXJ maps P6 → an MSP-centric model
lossily, and the method names are unverified (`org.mpxj` namespace assumes MPXJ ≥12;
`getPredecessorTask`/`getSuccessorTask` are likely wrong). Field coverage today is
~60–70% (missing resources, assignments, costs, calendar working-time, P6 Activity
Codes, project Data Date, multi-project). **Recommendation:** a native tab-delimited
`.xer` reader — XER is fully documented text (`PROJECT/TASK/TASKPRED/PROJWBS/RSRC/...`),
so capture is deterministic, JVM-free, version-stable, and lossless. Keep MPXJ for `.mpp`.

### MPP — MS Project (target 100%) — **NOT YET MEASURED (needs JVM/MPXJ)**
Binary OLE2; MPXJ/JVM is the only pragmatic route. "100%" honestly means "100% of what
MPXJ exposes" — run `probe_schedule_mpxj.py` on a real `.mpp` first, then document what
MPXJ cannot reach. Add resource/assignment/cost/Data-Date parsing (all already probed).

### Images / scanned PDF (target ≥95%) — **NOT YET MEASURED (needs GPU + a scanned gold set)**
Achievable for **clean, ≥300-DPI, printed** scans via the docTR→Tesseract→Florence
ladder + OSD orientation. **Not** achievable for **dense 150-DPI numeric tables** — no
OCR clears that floor; the correct behaviour is to request the original Excel and
reconcile (`reconcile_tables.py`), which the rig supports. Measure real CER with
`run_ocr_eval.py` on a gold set before quoting any scanned number.

### Handwriting (target: extract, HITL if low-confidence) — **NOT YET MEASURED (needs GPU)**
**Currently the weakest path.** There is no dedicated handwriting model and no
handwriting *detector*. docTR's printed-text model reads handwriting as noise, and
because page confidence is averaged over many good printed words
(`pdf_extract.py:181,418`), a handwritten annotation on an otherwise-printed page keeps
the page confidence high and is **silently dropped or misread** — it does *not* trip
the review gate. This directly violates the "route low-confidence handwriting to human"
target and is the #1 accuracy fix.

---

## Part 2 — Messy-table assessment (your highest priority)

| Messy case | Handling today | Verdict |
|---|---|---|
| Missing / partial / no borders | `is_tabular` anti-fabrication gate (≥2 numeric cols, row-density floor) — good | **Good**, gated |
| Merged / spanning cells | Not reconstructed; audit says "placed" but can be the wrong column | **Risk** (see R3) |
| Split cells / merged rows | `"100 200"` in one cell → `parse_number` returns `100`, silently | **Silent loss** (R1) |
| Multi-page tables | `_stitch_cross_page_tables` (digital) + tombstone grouping (reconcile) | **Good**, but merge criterion too loose (R4) |
| Rotated tables | Page-level OSD upstream; no per-table de-rotation | **Partial** |
| Tables inside images | `extract_images` dumps rasters; scanned table path via cv2 grid | **Partial**, one-table-per-page assumption (R6) |
| Handwritten-annotated tables | Annotations → low-conf OCR words → dropped, not flagged | **Silent loss** (R2) |
| Primavera / Gantt exports | Schedule sub-system (unproven) | **Unproven** |
| Financial / BOQ / invoices | Core tie-out + row `Qty·Rate` + serial-gap — the rig's strength | **Strong** |

**The one thing that saves the messy cases:** the reconcile-against-Excel path replaces
a whole uncertain grid with the authoritative Excel by arithmetic alignment. That's the
right architecture for "we can't read this messy table — give us the source". It needs
the fixes in R7/R8 and a calibrated gate to be reliable.

---

## Part 3 — Risk register (silent-data-loss first)

Severity = likelihood × (data lost silently?). **HIGH = wrong data can be committed
with no flag.**

| # | Sev | Location | Risk | Failure scenario |
|---|---|---|---|---|
| R1 | **HIGH** | `common.py:205` + `robust_tables.py:161` | `parse_number` returns only the first number; merged-row cell `"100 200"` → `100`. Merge-detector needs ≥2 multi-number cells, so a single-amount-column merge is invisible. | Two rows collapse in a ruled cell; column still "reconciles"; a real value is lost with no flag. |
| R2 | **HIGH** | `pdf_extract.py:181,418` | Page confidence averaged over words; low-confidence handwriting doesn't lower it enough to trip the gate. | Handwritten note/total on a printed page misread or dropped; page auto-accepts at 0.97. |
| R3 | **HIGH** | `robust_tables.py:246-263` | Audit guarantees word *presence*, not *placement*; merged/spanning cells put words in the wrong column but count as "placed". | Value lands under the wrong header; tie-out on the right column still passes. |
| R4 | **HIGH** | `doc_layout.py:83-88` | A borderless "real table" with no bbox falls back to the bounding box of *all* page words → subtracts every text line on the page. | On such a page, all prose/headings vanish, leaving only the (possibly wrong) table. |
| R5 | **HIGH** | `excel_extract.py:187,190` | `.xls` float-serial dates read as amounts; merged cells not expanded in read-only mode. | A date column corrupts a tie-out / a merged grand-total is missed → the Excel "100%" claim breaks. |
| R6 | **HIGH** | `schedule_mpxj.py:391,402` | Probable-wrong relation accessor + swallowing `except` → 0 relationships, silently. | A P6/MSP schedule loads with all activities but no logic links; downstream CPM is meaningless; reported as success. |
| R7 | **MED** | `common.py:528-534` | `verify_table` alt-column fallback: if the header amount column fails but any other column coincidentally reconciles, the failure is suppressed. | A genuine dropped row reads as clean because an unrelated column happened to sum right. |
| R8 | **MED** | `reconcile_tables.py:306-313` | Excel rows mapped to PDF row-index fractions; if OCR dropped a whole page's rows, interpolation assigns Excel rows to the wrong page. | Correct Excel numbers injected under the wrong page/tombstone; confidence can still clear the gate. |
| R9 | **MED** | `table_pdf.py:54` / `pdf_extract.py:499` | `page_is_digital` (≥20–50 chars) misclassifies a scanned page carrying a watermark/page-number as digital → never OCR'd. | Whole scanned page silently empty at confidence 0.97. |
| R10 | **MED** | `common.py:211-217` | Tolerance `ceil(0.5·N)`; in a 500-row table a single dropped row < ~250 passes. | A large table's dropped row slips under tolerance undetected. |
| R11 | **MED** | `doc_layout.py:441-450` | Reading order collapses to top-to-bottom when a full-width element mixes with columns. | Multi-column body text emitted out of order (content correct, sequence wrong). |
| R12 | **MED** | `run_ocr_eval.py:161,37` | Field accuracy uses exact normalized match, no numeric tolerance. | `"2611464676"` vs `"2,61,14,64,676"` scored as a miss → calibration corrupted. |
| R13 | **LOW** | `schedule_mpxj.py:16` | Documented `defusedxml` XXE guard for PMXML/MSPDI doesn't exist. | Malicious XML could trigger entity expansion via MPXJ's parser (unverified). |
| R14 | **MED (CONFIRMED — reproduced)** | `common.doc_outdir`/`doc_key` + `atomic_write_text` + `doc_layout.py` | Windows MAX_PATH: total output path >260 chars crashes the write. The stem-cap "fix" bounds only the stem, not the total path; long-path support not enabled. | A deep output root / nested input tree → `FileNotFoundError: ...layout.json.tmp`; file logged to `_errors.json` and skipped = **silent per-file loss**. Reproduced live at 271 chars — see `05_VERIFIED_NO_GPU_RUN.md`. *Fix:* `\\?\` long-path prefix or cap total path. |

### Cross-cutting reliability risks
- **Uncalibrated gate** — 0.70/0.90/0.95 are guesses; no ECE curve wired in. An
  uncalibrated auto-accept gate commits wrong data with false confidence. Calibrate
  (`run_ocr_eval.py --calibrate`) before trusting auto-accept. **[HIGH]**
- **Resource leaks at scale** — unclosed `fitz` handles + temp dirs; a 1M-file Windows
  run hits file-lock/inode limits. **[MED-HIGH]**
- **No ground-truth accuracy measurement** — until `eval/` goldens exist, every
  accuracy number is an internal-consistency proxy, not truth. **[HIGH — now tooled]**

---

## What to measure to close this report

1. Build 8–12 goldens (`eval/golden/README.md`), covering the messy matrix.
2. `eval/run_benchmark.py score` → real per-type `content_f1`, `positional_f1`,
   `misplacement`, CER. The gap `content_recall − positional_recall` quantifies R3.
3. `run_ocr_eval.py --calibrate` → the calibrated gate + ECE.
4. `eval/confidence_report.py` → the auto-accept rate and the request-source worklist.
