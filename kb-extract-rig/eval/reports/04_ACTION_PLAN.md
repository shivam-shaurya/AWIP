# Action Plan — kb-extract-rig

Ranked by impact. Each item: what, where, effort (S ≤2h · M ≤1d · L >1d), and the
invariant it must not break. **Correctness / silent-data-loss items come first** —
they can commit wrong data today.

Legend: 🟥 correctness · 🟦 reliability/scale · 🟩 quality/perf · 🟪 measurement

---

## HIGH impact

| # | Item | Where | Effort | Invariant |
|---|---|---|---|---|
| H1 🟥 | **Detect handwriting / low-word-confidence clusters and FORCE review.** Don't average it away. Add a per-region word-confidence floor in `_words_from_rgb`/`_score_page`; if a cluster of low-conf words exists, flip the page to `needs_review` regardless of page mean. | `pdf_extract.py:171,398,418` | M | Never lower a clean page's confidence; add-only. |
| H2 🟥 | **Catch merged-row cells on ruled grids.** Run the "cell holds ≥2 numbers" predicate on ruled grids too (today only borderless), and flag any such cell. | `robust_tables.py:161` + apply post-`ruled_table` | S | Don't false-flag a wrapped description cell (≤1 number). |
| H3 🟥 | **Fix the borderless-no-bbox page-wide subtraction.** Use only the table's own placed words for its bbox; guard `tboxes` against any box covering >~70% of the text extent. | `doc_layout.py:83-88,657,674` | M | Digital output byte-identical for tables that already have a bbox. |
| H4 🟥 | **Fix Excel `.xls` dates + merged cells.** Convert `xlrd XL_CELL_DATE` via `xldate_as_datetime`; read non-`read_only` or expand `ws.merged_cells` before tie-out. | `excel_extract.py:50,187,190` | M | Digital `.xlsx` numeric output unchanged. |
| H5 🟥 | **Fix schedule relationships.** Run `probe_schedule_mpxj.py` on a real `.xer`+`.mpp`; correct the relation accessor (likely `getSuccessorTask`/`getPredecessorTask` → confirm) and pin the MPXJ version; replace the swallowing `except` with a logged, counted failure. | `schedule_mpxj.py:391,402,336` | M | — (currently broken; can only improve) |
| H6 🟦 | **Calibrate the confidence gate.** Fit ECE/reliability on a gold set; only then trust auto-accept. Wire calibrated confidence into the 0.70/0.90/0.95 routing. | `run_ocr_eval.py --calibrate`, `common.load_calibration` | M | Identity (no change) until a `calibration.json` exists. |
| H7 🟪 | **Build the golden set (8–12 files) + run the accuracy benchmark.** Cover the messy matrix. This converts every accuracy claim from proxy to truth. | `eval/golden/`, `eval/run_benchmark.py` | M | — |
| H8 🟥 | **Harden the alt-column tie-out fallback.** Require the alt column to *also* be the header/row-max amount column, not merely "reconciles". | `common.py:528-534` | S | Keep passing existing tie-out golden tests. |

## MEDIUM impact

| # | Item | Where | Effort | Invariant |
|---|---|---|---|---|
| M1 🟦 | **Close resource leaks.** `try/finally: doc.close()` around extract bodies; `shutil.rmtree` temp dirs; free pixmaps. | `pdf_extract.py:494`, `table_pdf.py:150,152`, `doc_layout.py:555`, `excel_extract.py:163` | S | No behaviour change. |
| M2 🟥 | **Guard the cross-page stitch.** Require header similarity or column x-overlap, not just mode+ncols, before merging two consecutive tables. | `doc_layout.py:340-349`, `table_pdf.py:100-104` | M | Don't stop stitching genuine continuations (add golden test both ways). |
| M3 🟩 | **Native `.xer` reader.** Deterministic tab-delimited parser; keep MPXJ for `.mpp`. Guarantees 100% XER capture, removes JVM/version risk. | new `xer_native.py` | L | Output shape matches the schedule contract. |
| M4 🟪 | **Add table-accuracy + schedule-accuracy to the eval loop as a gate.** `table_metrics` is built; add a schedule metric (activity/relationship/date match) and fix `run_ocr_eval` numeric tolerance (route both sides through `parse_number`). | `eval/`, `run_ocr_eval.py:161` | M | — |
| M5 🟩 | **Perf: parse the grid once in `verify_table`.** Build a `float|None` matrix, thread through the ~7 helpers. | `common.py:518-554` | M | Identical verify verdicts (golden tests lock this). |
| M6 🟩 | **Perf: batch scanned-table OCR.** One `image_to_data` per table + word→cell assignment; per-cell only for flagged re-OCR. | `scanned_tables.py:243-256` | M | CER not worse on the gold scans. |
| M7 🟦 | **Security foot-guns.** Prefix `=|+|-|@` cells with `'` on xlsx write; gate/vendor Florence `trust_remote_code`; add zip-bomb/size guards before opening untrusted xlsx/docx. | `table_pdf.py:207`, `pdf_extract.py:245`, `excel_extract.py`/`docx_extract.py` open | M | No change to legitimate content. |
| M8 🟥 | **Word-box-level OCR vote.** Align docTR/Tesseract boxes, pick per-word by confidence, instead of whole-page engine selection. Measurable gain on mixed-quality pages. | `pdf_extract.py:385,405` | L | Never worse than the best single engine (gate on gold CER). |
| M9 🟩 | **Add the missing schedule tests + wire the sub-system into `pipeline.py`.** Pure-logic tests (percent scale, baseline, WBS synth, `detect_format`) need no JVM. Unify the parse/normalize date-type contract. | new `tests/test_schedule_*.py`, `pipeline.py`, `schedule_*` | L | — |
| M10 🟥 | **DOCX reading order + furniture.** Iterate `document.element.body` to keep paragraph↔table order; pull headers/footers/images. | `docx_extract.py:26-35` | M | — |

## LOW impact

| # | Item | Where | Effort |
|---|---|---|---|
| L1 🟩 | Type the element/grid/table schema (`TypedDict`), add hints on public fns, add `mypy` to CI. | `common.py` + rig-wide | L |
| L2 🟩 | Split the god-functions (`extract_document`, `extract_pdf_tables`, `parse_schedule`) into testable stages. | 3 files | L |
| L3 🟩 | Replace `except Exception: pass` on IO with logged warnings. | rig-wide | S |
| L4 🟩 | Map embedded-QR bbox into page coordinates. | `links_qr.py:86-91` | S |
| L5 🟩 | Numeric-segment-aware WBS sort; per-(WBS,name) collision fix. | `schedule_normalize.py:114,202` | S |
| L6 🟦 | Promote private cross-module helpers (`_numeric_columns`, `_write_markdown`) to public API. | `robust_tables.py`, `doc_layout.py` | S |
| L7 🟪 | Add property/fuzz tests for `parse_number`, `detect_format`, `num_match`. | `tests/` | M |

---

## Suggested sequencing (≈3–4 focused weeks to a defensible 8.5–9 on the document core)

1. **Week 1 — stop the bleeding (correctness):** H1, H2, H3, H4, H8, M1. Add a
   regression test per fix. Re-run `tests/test_core.py` after each.
2. **Week 2 — make it measurable:** H7 (goldens) + H6 (calibration) + M4. Now every
   later change is judged by real numbers.
3. **Week 3 — schedule + reconcile reliability:** H5 (probe + fix), M2, M3 (native XER),
   M9, R8 page-attribution fix.
4. **Week 4 — perf + security + polish:** M5, M6, M7, M8, then the LOW items as capacity
   allows.

Every item above can be handed to the `extract-rig-qa` agent one at a time:
`@extract-rig-qa implement H2 — catch merged-row cells on ruled grids — with a
before/after on tests/test_core.py and a new regression test.`
