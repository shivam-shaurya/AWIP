# Code Review — kb-extract-rig (scored 1–10 per dimension)

Scores are per cluster, with evidence. Cluster A = shared core + table engine
(`common.py`, `robust_tables.py`, `table_pdf.py`); B = whole-doc + reconcile
(`doc_layout.py`, `links_qr.py`, `scanned_layout.py`, `reconcile_tables.py`);
C = OCR + scanned + structured (`pdf_extract.py`, `scanned_tables.py`,
`extract_images.py`, `excel_extract.py`, `docx_extract.py`); D = schedule + eval +
tests (`schedule_mpxj.py`, `schedule_normalize.py`, `probe_*`, `run_ocr_eval.py`,
`export_pdf.py`, `audit_run.py`, `tests/`).

## Scorecard

| Dimension | A core+tables | B layout+reconcile | C OCR+excel | D schedule+eval | Weighted |
|---|:--:|:--:|:--:|:--:|:--:|
| Architecture | 8 | 8 | 8 | 7 | **7.8** |
| SOLID / SRP | 6 | 6 | 7 | 7 | **6.5** |
| DRY / duplication | 8 | 8 | 7 | 6 | **7.3** |
| Coupling | 7 | 6 | 7 | 7 | **6.8** |
| Config management | 9 | 8 | 7 | 6 | **7.5** |
| Error handling | 6 | 8 | 6 | 8 | **7.0** |
| Resource safety | 5 | 7 | 5 | 6 | **5.8** |
| Type safety | 4 | 5 | 5 | 6 | **5.0** |
| Performance | 6 | 6 | 4 | 6 | **5.3** |
| Testability | 6 | 7 | 8 | 4 | **6.3** |
| Documentation | 9 | 9 | 9 | 8 | **8.8** |
| Security | 6 | 7 | 5 | 6 | **6.0** |
| **Cluster mean** | **6.7** | **7.1** | **6.5** | **6.4** | **6.6** |

## Dimension notes (what's dragging each score)

- **Type safety (5.0)** — the lowest structural score. Almost no type hints; grids and
  elements are stringly-typed dicts. `PdfOptions`/`ExtractConfig`/`TableScore` are the
  only typed shapes. A wrong dict key fails silently. *Fix:* `TypedDict` for the
  element/grid/table-score contract; add hints on public functions; run `mypy` in CI.
- **Performance (5.3)** — real hot spots (see below), all fixable without accuracy loss.
- **Resource safety (5.8)** — unclosed `fitz` handles (`pdf_extract.py:494`,
  `table_pdf.py:152`, `doc_layout.py:555`), un-cleaned temp dirs (`table_pdf.py:150`
  scanned PNGs; `excel_extract.py:163` LibreOffice tmp), Florence-2 co-resident on VRAM.
  Harmless at 10 files; a Windows file-lock/inode problem at 1M.
- **Security (6.0)** — good: `safe_name`, `html.escape`, `yaml.safe_load`, atomic
  writes. Weak: **xlsx formula injection** (a cell starting `=`/`+`/`-`/`@` written to
  the VERIFY sheet executes when an analyst opens it — `table_pdf.py:207`); **Florence-2
  `trust_remote_code=True`** runs remote repo code (`pdf_extract.py:245,247`); **no
  zip-bomb / size guard** before opening untrusted `xlsx`/`docx`; the documented
  `defusedxml` XXE path for PMXML/MSPDI **does not exist** (`schedule_mpxj.py:16`).
- **Error handling (7.0)** — genuinely good per-page/per-file isolation and structured
  fatals; dragged down by many `except Exception: pass` that hide real failures
  (`common.py:83,946,1206`; `excel_extract.py:170`; `links_qr.py:36,70,90`;
  `schedule_mpxj.py:402` which silently drops *all* relationships).
- **Documentation (8.8)** — exceptional, occasionally aspirational (docstrings
  reference tests and a `defusedxml` path that don't exist).

## Performance hot spots (ranked, all fixable without accuracy loss)

1. **`verify_table` re-parses the grid ~7×** (`common.py:518-554`) — `counts`,
   `pick_amount_column`, `rowwise_max_column`, `_verify_col`, `infer_amount_columns`,
   `validate_rows`, `detect_serial_gaps` each re-walk and re-`parse_number`.
   *Fix:* parse the grid once into a `float|None` matrix, thread it through. ~5–7× on
   the verify path.
2. **Per-cell Tesseract subprocess** (`scanned_tables.py:243-256`) — spawns a process
   per cell, twice over numeric columns → hundreds of spawns per table.
   *Fix:* one `image_to_data` over the whole table + word→cell box assignment; reserve
   per-cell only for whitelist re-OCR of flagged cells.
3. **PNG encode→decode round-trip per page** (`pdf_extract.py:82-83`) — every RGB page
   is zlib-PNG-encoded then docTR re-decodes. *Fix:* pass arrays/PIL directly.
4. **Double/triple PDF open** (`doc_layout.py:555,568,577`) — pdfplumber + fitz + a
   throwaway fitz open for `page_count`. *Fix:* reuse one handle; close the pre-flight.
5. **O(n²) geometry** — borderless row banding (`robust_tables.py:131-138`), box
   union-find over ≤3000 rects/page (`doc_layout.py:163-178`), reconcile double O(E·P)
   score sweeps (`reconcile_tables.py:251-276`). *Fix:* sort+bucket / sweep-line /
   build the score matrix once.
6. **150-DPI scan rendered at 300 DPI** (`pdf_extract.py:338`) — upsamples for no gain.
   *Fix:* probe embedded image DPI, clamp render DPI to native.

## Testability & test-suite state

- **~67 tests, all on the document core** (tie-out, geometry, bilingual, reconcile
  pure logic, links/QR regex, DPI clamp, collision keys, parallel determinism). Solid.
- **Overstated coverage:** tests that hit a missing optional dep `return` early and
  still count as passed. "67 passed" is not "67 behaviours verified".
- **Untested critical paths:** the entire **schedule** sub-system (pure logic is
  laptop-testable yet has *zero* tests, contradicting its docstrings); `run_ocr_eval`'s
  CER + field-accuracy path; real OCR; the placement/merged-cell failure modes;
  `export_pdf`; `audit_run`.
- **No regression/perf/property/fuzz testing.** `parse_number` and `detect_format` are
  prime property/fuzz candidates.

## SOLID / SRP

Good use of small focused classes (`SchedulePercent`, `ScheduleBaselineSelector`,
`ExtractConfig`). The SRP violations are the three god-functions named in the
architecture review; splitting them is the single biggest testability win.

## Bottom line

Code quality is **above average for a document-AI codebase** — the discipline around
single-definition core logic and honest degradation is better than most commercial
parsers. The path from 6.6 → 8.5 is: type the contracts, close the resource leaks,
fix the security foot-guns (formula injection, remote-code, zip-bomb), split the
god-functions, and — most importantly — back every accuracy claim with the `eval/`
golden numbers. See `04_ACTION_PLAN.md`.
