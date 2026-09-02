# KB Extract Rig - Context & Plan

> Sovereign document-extraction system for RODIC / AIPMS. Turns messy real-world
> PDFs (tenders, BOQs, reports), XLSX and DOCX into clean, **complete**,
> confidence-scored, structured data. Two extraction layers: **tables** (numbers,
> completeness-guaranteed) and **whole-document** (text + tables + figures + numbers
> in reading order). General and production-grade - NOT hardcoded to any file.

Last updated: 2026-06-26.

---

## 1. What it does now

| Layer | Entry point | Output | Status |
|---|---|---|---|
| **Pipeline** (route by type) | `pipeline.py` | per-file `doc.json` / `chunks.jsonl` / `preview.html` + review queue | done |
| **Tables only** (any PDF) | `table_pdf.py` | one `.xlsx` (sheet per table) + **VERIFY** sheet | done, validated |
| **Whole document** (digital **+ scanned** PDF) | `doc_layout.py` | `layout.json` (ordered elements incl. **links/QR**, money-verified tables) + `.md` + `figures/*.png` + `review_pages.csv` | digital done; **scanned `--ocr-scanned`** |
| Excel direct read | `excel_extract.py` | cells.json / readable.txt / tie-out | done (audited) |
| DOCX | `docx_extract.py` | unified chunks | done |

---

## 2. Architecture (files & roles)

```
pipeline.py        orchestrator: route PDF/XLSX/DOCX -> extractor -> manifests + review queue
  pdf_extract.py     PDF native + scanned OCR ladder (docTR batched + Tesseract + Florence-2 VLM)
  excel_extract.py   XLSX/XLSM: direct read = 100% exact + Schedule-H tie-out (audited)
  docx_extract.py    DOCX direct read
  common.py          shared: field regex+checksums, confidence, output writer, batch driver

robust_tables.py   TABLE GEOMETRY ENGINE (the core): reconstruct tables from the PDF's
                   real geometry (every word + ruling lines). A row CANNOT be silently
                   dropped because every word is PLACED into a cell. Handles borderless
                   tables, multi-table pages (gap segmentation), multi-line cells,
                   section headers, empty cells. Completeness AUDIT flags orphan rows.
table_pdf.py       production table driver: robust_tables + cross-page stitch + a MONEY
                   tie-out VERIFY (Sigma amounts == grand total -> flags missing rows
                   with the exact amount) + completeness audit. One xlsx + VERIFY sheet.

doc_layout.py      WHOLE-DOCUMENT "extract everything": per page -> atomize text (fitz) ->
                   tables (REUSE robust_tables) + per-table MONEY tie-out -> subtract table
                   regions -> figures (raster + vector) -> classify text (heading/paragraph/
                   list, levels from NUMBERING + PDF outline) -> header/footer furniture ->
                   links + QR (links_qr) -> reading order (banded XY-cut) -> structure
                   self-audit + per-PAGE & per-DOC review routing -> emit layout.json +
                   Markdown + figure PNGs + review_pages.csv. SCANNED pages reconstructed via
                   scanned_layout when `--ocr-scanned` is set (else left as cheap stubs).
links_qr.py        SOVEREIGN links/codes: PDF hyperlinks (fitz.get_links) + URLs/emails in
                   text (regex) + QR codes (cv2.QRCodeDetector on the page raster / embedded
                   images). Per-page, merged into the element stream + a doc-level summary.
scanned_layout.py  SCANNED whole-document layout: OCR-with-geometry (pdf_extract.ocr_page_words)
                   -> words-in-points -> tables (ruled per-cell + borderless, anti-fabrication
                   gated) -> lines (median word HEIGHT as the font-size proxy) -> the SAME
                   doc_layout classify/order/merge -> figures (opt-in). Low-confidence / empty
                   scans route to human review, never fabricate structure. Sovereign only.

export_pdf.py      render extraction output to readable PDFs
run_ocr_eval.py    measure CER + field accuracy vs a gold set

tests/             pytest golden + unit suite (48 tests): tolerance, amount-column, is_tabular
                   sparse-accept/prose-reject, digital golden tie-out, parallel determinism, lever
                   B/C/F, bilingual (English+Hindi) tie-out, Excel path, links/QR regex, banded
                   reading order + furniture, whole-doc tie-out, OCR word-geometry math, scanned
                   line-grouping + table-gate anti-fabrication. `python tests/test_core.py`.
config.yaml        (optional) thresholds; see ExtractConfig in common.py for every key + default.
```

**14 top-level .py:** common, robust_tables, scanned_tables, pdf_extract, excel_extract, docx_extract,
table_pdf, doc_layout, **links_qr**, **scanned_layout**, **extract_images**, pipeline, run_ocr_eval, export_pdf.

`extract_images.py` (NEW): a standalone tool that dumps EVERY embedded image/photo from a PDF at its ORIGINAL
resolution (logos, site photos, diagrams, stamps - any raster) via fitz `extract_image(xref)`, de-duped by xref
(a repeated logo saved once, all pages recorded), soft-masks composited, + optional `--render-scanned` for
image-only pages. Output is the same collision-safe sharded dir + a manifest. Distinct from doc_layout's figure
layer (which RE-renders figures as-placed at 150 DPI and filters noise for the reading-order document);
extract_images gives the raw native-resolution bytes. Run: `python extract_images.py --in <pdf|folder> --out <dir>`.

**EXCEL<->PDF TABLE RECONCILIATION (NEW, opt-in, 64 tests; P0 done 2026-06-29):** reconcile noisy/scanned
PDF tables against an authoritative user-uploaded Excel, mapping ONE Excel sheet across N fragmented PDF
pages by ARITHMETIC alignment (not fuzzy text). Files: `reconcile_tables.py` (NEW) + `_tag_reconcilable_tables`
in `doc_layout.py` + `common.write_reconcile_queue` + `reconcile_*` keys in `ExtractConfig`.
- **Tombstone tagging** (`doc_layout --reconcile-tables`, default OFF -> digital layout byte-identical): after
  the cross-page stitch, tag UNCERTAIN tables (scanned/low-conf OR any tie-out flag) with an additive
  `reconcile` block (keeps grid/bbox/id; never discards the extraction).
- **`reconcile_tables.py`** (standalone, laptop-testable; reuses `common` tie-out/`parse_number`/`_GLYPH_MAP`/
  atomic IO + `excel_extract._analyze`): `num_match` (exact/relative/OCR-glyph), `align_sheet_to_group`
  (anchor-then-segment: confident distinctive mutually-best anchors -> LIS monotonicity -> fill by order ->
  per-page boundaries + confidence; `count_order` fallback capped below the gate), `group_tombstones`,
  `excel_is_trusted` (GATES: Excel must itself tie out + no un-recalc formulas + row-count reconcile),
  `build_reconciliation` (sidecar), idempotent atomic `inject` (sets `reconciled_grid`, KEEPS
  `reconcile.original_grid` + provenance, never deletes the tombstone, re-verifies + re-runs completeness).
- **State = filesystem sidecar** `<stem>.reconcile.json` + run-level `reconcile_queue.csv` (maps onto a DB
  row later). **Approval = CLI dry-run (default) -> `--apply`.** Plan: `.claude/plans/kb-extract-rig-dazzling-hinton.md`.
- **P1 (server/real scans):** run as a post-pass after `doc_layout --ocr-scanned` on real 150-DPI + Excel;
  tune thresholds; thin admin UI on the queue+sidecar. P2: DB adapter, transposed/merged-cell Excel, scale.
- **Review fixes (2026-06-29, external prod review, 67 tests):** **G1** glyph-aware PDF data-row predicate
  (`_pdf_numeric`/`grid_data_rows(numeric_pred=)`) so a blurry `1OOO` cell still counts as a data row and
  reaches the glyph-tolerant matcher (PDF side lenient, Excel side strict) - was the key degradation on real
  scans. **G3** the corrected data is now DELIVERED: `doc_layout._write_markdown` prefers `reconciled_grid` +
  stamps a provenance line, and `inject` re-renders the `.md`. **G8** re-apply is a true no-op (skip RECONCILED
  members, `--force` to redo a corrected Excel, no version/file churn). **G7** manual `--mark <element_id>`
  tombstones a high-confidence-but-wrong table auto-tagging missed. DEFERRED (P1/P2): **G2** surface the queue
  from `pipeline.py` (today reconcile lives on the `doc_layout` path - documented as THE reconciliation runbook);
  **G4** calibrate the confidence gate (use `run_ocr_eval` reliability/ECE before trusting auto-eligibility);
  **G5** thin operator UI on the queue+sidecars; **G6** DB adapter + per-doc lock for concurrent approvals.
- **VERIFY (run these):** (1) `python tests/test_core.py` -> expect **67 passed** (locks the pure logic +
  the digital-byte-identical-with-feature-off guarantee). (2) On a real scanned tender + its Excel:
  `doc_layout.py --in t.pdf --out out_rec --ocr-scanned --reconcile-tables` (tags tombstones) ->
  `reconcile_tables.py --layout out_rec\<sharded>\t.layout.json --excel auth.xlsx` (DRY RUN: prints
  `Sheet -> g1 : INJECT (conf=0.94)` or `hold` + reason, mutates nothing, writes reconcile_queue.csv) ->
  add `--apply` to inject. CORRECT = the tombstone gains `reconciled_grid` (clean Excel rows incl. Total),
  `reconcile.status:"RECONCILED"`, `reconcile.original_grid` kept, `tieout_flags:[]`; a non-tie-out / wrong-
  row-count Excel shows `hold`; re-running `--apply` is idempotent (no duplicate tables). Real scanned-OCR
  tombstones are the one thing not laptop-testable (no docTR locally) - that's what the server run confirms.

**SCHEDULE PARSER (NEW sub-system, separate domain - project schedules, not document extraction; added
2026-06-29):** `schedule_mpxj.py` + `schedule_normalize.py` + `probe_schedule_mpxj.py` + `requirements-schedule.txt`.
One MPXJ-based parser (UniversalProjectReader, JVM) reads Primavera P6 (`.xer` + P6/PMXML) AND MS Project
(`.mpp` + MSPDI) into one model: activities (code/WBS/dates/float/%complete/baseline/constraints/UDFs),
relationships (FS/SS/FF/SF + lag), file-wide percent-scale + baseline selection, format-aware criticality,
XSS sanitization, integrity checks; `schedule_normalize.py` reshapes flat XER into a WBS hierarchy. Ported
from a C# reference (NMDC.Services); pure-logic half is laptop-testable, MPXJ half is server-only (JVM).
**STATUS: P0 done, NOT YET PROVEN.** P0 (2026-06-29): hardened `parse_schedule` (try/except -> structured
fatal errors, null-project guard), robust `_jdate_to_py` (ISO variants), softened the calendar-math claim,
marked the <1% percent edge as inherited, + `requirements-schedule.txt` + `probe_schedule_mpxj.py`. **GATE
(do FIRST, tomorrow): run `probe_schedule_mpxj.py <real .xer/.mpp>` on the server** - the MPXJ method names
are UNVERIFIED (the module says so); the probe prints OK/FAIL for every call the parser uses AND dumps the
real method names for P1. **P1 (after the probe, server-testable): resources + assignments, costs/budget,
calendars working-time, P6 Activity Codes (ACTVCODE - distinct from the ActivityID already captured), project
Data Date, multi-project XER.** P2: DCMA 14-point analytics. Build P0-proven before P1 (don't pour unverified
coverage on an unverified base).

Earlier cleanup deleted as dead:
`extract.py` (back-compat shim - **use `pipeline.py` directly**) and the `evals/` archive (table_extract*,
try_img2table - the useful grid+cell-OCR logic now lives in `scanned_tables.py`). Also removed the unused
`safe_foreach` from common.py (superseded by `parallel_foreach`).

`common.py` also now hosts (all shared, one definition each): **ExtractConfig** (every threshold;
config.yaml + CLI), **completeness_status** (the AUTO_ACCEPT vs NEEDS_REVIEW verdict), **round_tolerance**
+ **pick_amount_column** + **parse_number** (the tie-out helpers), **parallel_foreach** (file-level
parallel + resume + a KILLABLE per-file timeout + a serialized GPU lane), and **get_logger /
configure_logging** (tqdm-safe console + JSON run-log).

Key principle (same for both layers): **earn completeness via geometry + a self-audit;
never silently drop or fake data.** Tables tie out arithmetically; the document layout
checks that every text atom is placed.

---

## 3. How to run

```powershell
# call the venv python directly (PS activation is blocked on the server)
$PY = "C:\Users\admin\pradeep-defect-work\venv2\Scripts\python.exe"
$env:Path += ";C:\Program Files\Tesseract-OCR"   # for any OCR

# A) TABLES only (BOQ / price schedules) -> Excel + VERIFY sheet + <stem>.status.json
& $PY table_pdf.py --in "file.pdf" --out "tables.xlsx" --verify

# B) WHOLE DOCUMENT "extract everything" (text+tables+figures+links/QR+header/footer, reading order,
#    per-table money tie-out, per-page review) -> layout.json + Markdown + figures + review_pages.csv
& $PY doc_layout.py --in "file.pdf" --out "out_dir"
#    + SCANNED PDFs (OCR-reconstruct scanned pages into the same element stream):
& $PY doc_layout.py --in "scan.pdf" --out "out_dir" --ocr-scanned --dpi 300 --lang eng+hin+mar

# C) PIPELINE (auto-route PDF/XLSX/DOCX) -> manifests + review queue
& $PY pipeline.py --in "samples\" --out "out\" --gate 0.70
```

**Cross-cutting flags (every entrypoint) - all OPT-IN; omitting them == today's behaviour:**
```
--config config.yaml   load thresholds from a file (defaults -> yaml -> CLI; PyYAML optional)
--strict               withhold NEEDS_REVIEW files from the run-level _status.json `committed` set
--workers N            file-level parallelism (1 = serial = default; 0 = auto = cores-1, RAM-capped)
--timeout S            per-file timeout seconds; a hung file's worker is KILLED + logged, run continues
--resume               skip files whose output already exists (append-only batches)
--log-json PATH        write a queryable JSON run-log (also run.log.jsonl / run_log.jsonl per run dir)
```
Scanned BOQs: run them through **table_pdf** (cell-level tie-out), NOT the general pipeline (which
OCRs scanned PDFs to flat text and loses the arithmetic guarantee).

**Output noise-filter (2026-06-26):** `table_pdf` no longer emits a sheet for a table with <=1 data cell
(empty page-frame boxes, repeated header/footer text like `'GUDC Ltd.'`, `'CONTENTS'` that the ruled-table
path captures). Real-file audit found ~60% of emitted "tables" were such fragments; the filter drops them
with ZERO data loss (a <=1-cell box can't be a table or hold a dropped row). `status.json` now reports the
real `tables` count + `fragments_skipped`. On the GUDC file this turns 102 sheets (62 junk) into ~47 clean tables.

**"Extract Everything" enhancement (2026-06-26, `doc_layout`; 48 tests):** the whole-document layer now
captures EVERYTHING and routes incomplete pages to humans. All additive; **with `--ocr-scanned` OFF the
digital path is byte-for-byte unchanged** (verified: a mixed digital+scanned PDF's native-page element
stream — including `section_path`/ids — is identical with and without the flag).
- **Links & QR** (`links_qr.py`, sovereign): PDF hyperlinks (`fitz.get_links`), URLs/emails in the text
  (regex), and QR codes (`cv2.QRCodeDetector` on the page raster / embedded images) become typed elements +
  a doc-level `links`/`codes` summary + a Markdown appendix. Scanned QR boxes are scaled to page points.
- **Per-page + per-doc human review:** every page gets `needs_review` + `review_reasons`; the run writes
  `review_pages.csv` (`stem,page,confidence,reasons`) alongside the per-doc `_status.json`. Triggers: a
  page that errored, produced no content, a table tie-out failure on that page, or a low-confidence scan.
- **Money tie-out folded in** (Phase D): every table element in `layout.json` carries `tieout_flags`
  (`common.verify_table`, the same proof `table_pdf` gives — now ONE shared definition in `common.py`); a
  dropped row flips the page to review and rolls `tieout_gaps` into the doc completeness verdict.
- **Reading order fixed** (Phase E): `_order` is now a real **banded XY-cut** (full-width spanners cut the
  page into bands; columns read L→R within a band) — fixes the old bug that floated every heading/table
  above 2/3-column body text. **Header/footer furniture is now KEPT** (was silently dropped by `_order`).
- **Scanned whole-document layout** (`scanned_layout.py`, `--ocr-scanned`): OCR-with-geometry
  (`pdf_extract.ocr_page_words`, docTR→Tesseract escalation, words in POINTS via the prepped-raster frame
  72/dpi) → ruled (`scanned_tables`, `deskew_first=False` shares the frame) + borderless tables (gated by
  `is_tabular` AND ≥2 numeric columns AND a row-density floor, so prose is never fabricated into a table) →
  lines→classify (median word HEIGHT stands in for font size) → optional figures (`--scanned-figures`). An
  unreadable/low-confidence scan emits the recovered text + `low_conf` and routes to review — never fakes
  structure. New `ExtractConfig` keys: `layout_ocr_scanned`, `layout_ocr_conf_gate` (0.70), `scanned_figures`.
  New flags: `--ocr-scanned`, `--scanned-figures`, `--ocr-conf-gate`, `--dpi`, `--lang`, `--escalate-th`.

**Post-server-validation fixes (2026-06-26, 50 tests; found by a real 5-file / 325-page run):**
- **Empty-fragment filter in `doc_layout`** — `common.emit_worthy` (the `>1-data-cell` rule that already
  de-noised `table_pdf`) now also runs in `doc_layout`, applied to `tbl_els` **before** their boxes subtract
  text. On the NMDC RFP ~54% of "tables" (186/342) were empty page-frame boxes; these are dropped with zero
  data loss AND any text behind such a box is no longer swallowed (it flows to the classifier).
- **Hierarchical-subtotal tie-out** — `common._verify_col` is now two-level and general. A subtotal row
  (`Sub-Total`, `Amount (1)`, `Amount O&M (2)`, `Carried/Brought Forward` via `is_subtotal_label`; a label that
  STARTS with Total/Grand Total/Say is the grand total, not a subtotal) CARRIES FORWARD as a subtotal and resets
  the line-item run; the GRAND total is verified against **carried subtotals + the remaining post-subtotal
  items** (`base = subtotals + comps`). A subtotal is checked against its own visible items ONLY when they cover
  `>= reconcile_subtotal_min_coverage` (0.5) of it (else the section spans pages -> flagging would be a false
  positive; a near-complete shortfall is still a caught dropped row). This is the general accounting structure
  `Grand Total = Σ(section subtotals) + additional charges`. Validated on three REAL shapes from the server run:
  004 p12 (`Amount(1)+Amount(2)=Total`), OPRMC p11/p13 (`items -> Sub-Total -> charges -> Total`) all reconcile
  to the paisa, while flat AND within-section dropped rows STILL flag. Money-check is now trustworthy (0 false
  positives across the 5-file run).
- **Ruled regions excluded from figure detection** — `doc_layout` passes ALL ruled/borderless regions (real
  tables AND the empty fragments dropped by fix #1) to `_figure_elements` as exclusion boxes, while only REAL
  tables subtract text. So an empty page-frame grid is **neither a table nor a figure** (fix #1 alone had let it
  resurface as a vector "figure" - NMDC figures jumped 288->409). Real diagrams/logos are unaffected (robust_tables
  never detects a diagram as a ruled grid). This also prevents a ruled border from swallowing the text inside it.

**PRODUCTION & SCALE HARDENING — P0 (2026-06-29, 56 tests; for ~1M-PDF runs; all general):** closes the
silent failure modes a million-file batch would hit. Found by a 6-dimension code audit + a real-output pass.
- **CORRECTNESS — "not verified" can no longer read as "verified"** (`common.verify_table(..., flag_unverified=True)`,
  used by doc_layout/table_pdf/scanned_layout): a header-identified money column with significant values but NO
  total/subtotal anchor AND no Qty*Rate row-check emits a `not_verified` flag → review reason "amounts present but
  NOT verified". `_verify_col` now returns `(flags, n_anchors)`. Closes the hole where a cross-page price SUMMARY
  AUTO_ACCEPTed with 0 flags. (Default OFF preserves the verify_table contract for tests.)
- **Cross-page table stitch** (`doc_layout._stitch_cross_page_tables`, cfg `stitch_cross_page=True`): a table that
  continues onto the next page (consecutive, same mode+column-count, previous didn't end in a total) is merged into
  ONE table, the money tie-out re-runs on the full grid, the continuation fragment is dropped, and per-page tie-out
  reasons + doc `tieout_gaps` recompute. So a multi-page summary reconciles instead of being flagged forever.
- **Collision-safe sharded output** (`common.doc_key` = `<stem-capped-to-48-chars>__<8-hex of abs path>`,
  `common.doc_outdir` = `out/<hh>/<hh>/<key>/`): two `BOQ.pdf` in different folders no longer overwrite each
  other (the one silent data-loss hole), and a flat million-subdir parent (inode cliff) becomes 65k buckets.
  doc_layout uses it. **Windows MAX_PATH (260) fix (2026-06-30, server-found):** the stem is capped to 48
  chars in `doc_key`, and `extract_document` builds output filenames from `fbase = docdir.name` (the bounded
  key) rather than the raw `stem`, so a ~90-char tender filename + sharded dir can't blow past 260 and fail
  with `FileNotFoundError: ...layout.json.tmp` (3/13 server files hit this; all bounded now, regression-tested).
- **Reconcile queue from doc_layout (2026-06-30, server-found G2):** `doc_layout --reconcile-tables` now writes
  `out/reconcile_queue.csv` itself (one `PENDING_RECONCILE` row per doc that has table tombstones: doc_key, stem,
  n_tombstones, reason="awaiting authoritative Excel"), so an operator sees which docs need an Excel without
  having to run `reconcile_tables.py` first. `_dl_worker` returns `doc_key` + `n_tombstones` to feed it.
- **Atomic writes + .done sentinel** (`common.atomic_write_text` = tmp+os.replace, LF newlines [fixes CRLF];
  `common.mark_done`): a worker killed mid-write never leaves a half-file that resume trusts; `--resume` keys on
  `.done`, not on a possibly-partial output.
- **Pixmap DPI clamp** (`pdf_extract.clamp_dpi`, applied in pdf_extract/scanned_tables render_page + table_pdf.ocr_tables):
  an A0/A1 or 600-DPI page's effective DPI drops so the long edge stays ≤ 8000px — no multi-GB pixmap OOM; it still
  OCRs. Plus a **pre-flight guard** (cfg `max_pages_per_doc`/`max_file_mb`, 0=off): an oversized/pathological file is
  routed to review UNPROCESSED rather than OOM/stall.
- **Killable GPU/scanned lane** (`common._gpu_serial_killable`): one persistent child holds the warm docTR model and
  pulls files one at a time; a file exceeding the timeout is killed and a fresh child respawned — one hung scan can no
  longer hang the whole run, and the warm-model fast path survives. **Safer default**: when `--workers>1` and no
  `--timeout` is set, a 1800s per-file timeout auto-applies (workers=1 stays serial+unbounded = today's behaviour).

**PRODUCTION & SCALE — P1 throughput (2026-06-29, 58 tests):** the scanned-OCR GPU bottleneck.
- **Batched scanned-layout OCR** (`pdf_extract.ocr_pages_words`): doc_layout now OCRs ALL of a document's scanned
  pages in ONE windowed docTR pass (sub-batched by `opt.batch`) instead of one docTR call per page (~⅛–1/16 → full
  GPU utilisation). Per-page logic refactored into `_words_from_rgb` (shared by the per-page `ocr_page_words` and the
  batched path); the batched path returns words-only (no raster) so peak RAM stays flat, and `scanned_layout`
  re-renders the raster per page only when it needs tables/figures/QR. Per-page path is the automatic fallback.
- **Scanned files → warm-model GPU lane (OPT-IN, `--scanned-gpu-lane`)** (`doc_layout._dl_is_gpu`): a scanned PDF
  goes to the serial/killable GPU lane so docTR runs on ONE warm model — not forked across N CPU workers thrashing a
  GPU. **Default OFF** because the lane is serial and not yet concurrent with the CPU pool, so on a small/mostly-
  digital batch it is SLOWER (a mixed file's many digital pages lose parallelism); it pays off on a scan-heavy
  corpus / VRAM-tight box where the CPU-pool fork would OOM. The **batched OCR win applies either way**. (Concurrent
  lanes = P2.) Verified: digital element stream byte-identical through the batched path; scanned still degrades-to-review.

**Production invocation (1M-scale):** run with parallelism + the kill-pool, e.g.
`doc_layout.py --in <root> --out <out> --workers 0 --resume [--ocr-scanned --dpi 300 --lang eng+hin+mar]`
(0 = auto cores-1, capped 16). Set `max_pages_per_doc`/`max_file_mb` via `--config` to fence pathological files. Still
on the P2 roadmap (not yet done): multi-GPU fan-out (wire `gpu_workers` to K CUDA-pinned warm workers), a
work-queue/shard with atomic claims for multi-machine, streamed run-level manifests, lane-routing inside the worker
(the is_gpu probe is still a bounded serial parent pre-scan), and the same collision-safe keying for
pipeline.py/table_pdf.py.

**Robustness updates (2026-06-26):** `--tesseract <path>` / `--soffice <path>` externalize the binary
locations (default `""`/`soffice` keeps today's Windows auto-probe - set them for Linux/server); Florence-2
recovers VRAM on `torch.cuda.OutOfMemoryError` (skips the page instead of killing the batch); `is_tabular`
gained a **word-density guard** - a non-numeric, paragraph-length multi-column block is rejected as prose
(the numeric path is untouched, so any BOQ-with-amounts is unaffected).

**Accuracy levers added (2026-06-25, all general / non-hardcoded, 25 tests):**
- **Row-level arithmetic** (`common.validate_rows` + `infer_amount_columns`): every row with Qty/Rate/Amount
  is checked `Qty*Rate==Amount` - catches per-row errors AND the error-cancellation case where two opposite
  slips leave the COLUMN total reconciling perfectly (the single highest-ROI BOQ check). Flagged in VERIFY.
- **Serial-gap** (`common.detect_serial_gaps`): a Sr-No column that skips a number (1,2,3,5) = a dropped row,
  detected independently of geometry/OCR.
- **Parser hardening:** accounting negatives `(2,500)` -> **-2500** (deductions no longer flip sign);
  descriptive percentages / labelled cells (`80% of Value`, `Total Station 3`) are excluded from amount
  columns/sums (`is_amount_cell`); total-row detection tightened (`is_total_label`: keyword must start a short
  label, so a line item that merely contains "total" no longer corrupts the tie-out).
- **Excel un-cached formulas (1.1):** `data_only=True` returns None for a library-authored workbook's formula
  cells; now DETECTED, a sovereign **LibreOffice recalc** is attempted, and anything un-recovered is a hard
  review reason - never silently committed as blank.
- **Borderless row-merge (1.5):** a row that collapsed two lines (`'100 200'` in one numeric cell) is now
  detected (>=2 cells each holding 2+ numbers) and flagged for review - closing the one ruled-vs-borderless
  guarantee gap (a wrapped description cell, <=1 number, is not false-flagged).

**Scanned/calibration levers B/C/F (2026-06-26, opt-in; default = today's behaviour; SERVER-validated):**
- **C - OCR digit repair** (`common.repair_row_arithmetic`, on by default for OCR grids): fixes digit slips
  (`1O->10`, `3OO0->3000`) using the row's own `Qty*Rate=Amount` as an ORACLE. Accepts a correction only if
  it makes the arithmetic hold; never touches a reconciling row; substitutes only glyphs present (<=2/cell);
  REFUSES when >1 distinct result reconciles. Every fix -> a `digit_fix` VERIFY flag (review, never silent).
- **B - per-cell numeric-whitelist OCR** (`scanned_tables.py`, opt-in `--scanned-cell-ocr`): grid-detect (cv2)
  -> OCR each cell alone -> re-OCR numeric columns with a digit whitelist (psm 7). Degenerate grid (<2 cols/rows)
  -> FALLS BACK to img2table. Numeric parsing routes through `common.*` (no second parser). Cell-OCR needs
  Tesseract (server); geometry + `_ocr_config` are laptop-tested.
- **F - confidence calibration** (`run_ocr_eval.py --calibrate` + `--calibration cal.json`): bins reported
  confidence vs measured error from a gold set, recommends a gate where auto-accept error <= target, refuses
  below min-samples. The gate compares CALIBRATED confidence; identity (no change) until a `calibration.json`
  is supplied. Needs a hand-labelled gold set (build on server).

**Bilingual tie-out (English + Hindi, 2026-06-26) - now across ALL paths (table + Excel), de-duplicated:**
the arithmetic proof is no longer English-only. `parse_number`/`is_amount_cell` read Devanagari digits
(०-९); `is_total_label` (कुल/योग/जोड़/महायोग), `infer_amount_columns` (मात्रा/दर/राशि...), `pick_amount_column`,
`detect_serial_gaps` (क्रम/क्रमांक) and the shared `contains_total_kw` match Hindi. A Hindi BOQ **PDF** ties
out, catches a dropped row with the exact amount, and flags serial gaps.
- **Excel path fixed (was a silent hole):** `excel_extract` had its OWN `to_num`/`tieout` that never got
  the fix, so a Hindi Schedule-H found no `कुल` row -> `passed=None` -> traced to **auto-commit with the
  money proof never run**. Now `to_num` routes strings through `common.parse_number`, `tieout` uses the
  shared `contains_total_kw`, META/contract-price labels include Hindi, AND **`passed=None` with amounts
  present is surfaced as a review reason** ("tie-out NOT attempted") so it can never read as verified.
- **De-dup, not a 3rd copy:** `contains_total_kw` is the single bilingual total-keyword check (table stitch +
  Excel both use it); `robust_tables._cell_is_number` is now `common.is_amount_cell` (one numeric test rig-wide,
  so the borderless detector also reads Devanagari). Adding the next language reaches every recognizer at once.
- Still English-only (secondary, not the money proof): `FIELD_PATTERNS["amount_figures"]` + `indian_words`
  (field-level Rs/INR amount extraction). Other regional languages: same one-line keyword pattern to add.

**Remaining honest caveats:**
- Money tie-out is **skipped for stated totals < `reconcile_min_total` (default 1000)** - lakh/crore grand
  totals need that config lowered.
- `--gpu-workers` is **reserved, not wired** (GPU lane is serial in-parent). Dual-GPU pinning is future work.
- B/C cell-OCR + digit-repair effectiveness is **OCR-dependent and unmeasured until the gold set exists** -
  dense 150-DPI scans remain the OCR wall; B+C raise the floor + flag what's uncertain, they don't guarantee.

---

## 7. Server validation checklist (B/C/F)

```powershell
$PY = "C:\Users\admin\pradeep-defect-work\venv2\Scripts\python.exe"
$env:Path += ";C:\Program Files\Tesseract-OCR"
pip install xlrd img2table PyYAML          # new deps this round
# 1) regression on the server (needs pytest or run standalone)
& $PY tests\test_core.py                   # expect: 32 passed
# 2) LEVER B: per-cell OCR on a real scanned BOQ + img2table fallback proof
& $PY table_pdf.py --in "scanned_boq.pdf" --out out\ --verify --scanned-cell-ocr
#    -> check the .tables.xlsx grid is row x col (not 1 mega-column); a faint/borderless page must
#       still fall back to img2table (no crash, no 1-col merge). Compare CER vs the default img2table run.
# 3) LEVER C: confirm digit_fix flags in the VERIFY sheet (auto-repaired rows) and NO fabricated repair
#    (spot-check each digit_fix; ambiguous rows must be left for human, not guessed).
# 4) LEVER F: build a small gold set (gold\<stem>.gt.txt / .fields.json) then fit + apply:
& $PY run_ocr_eval.py --out out\ --gold gold\ --calibrate     # -> out\calibration.json + recommended gate
& $PY pipeline.py --in samples\ --out out2\ --calibration out\calibration.json
#    -> do NOT lower 0.70 until the curve is fit on >= min_samples; report the auto_accept_rate shift first.
```

---

## 4. Accuracy (measured)

- **Digital PDFs / XLSX / DOCX -> ~100% exact** (read from the text layer / cells, no OCR).
  - GUDC tender (53 pp): table money tie-out MATCHES (Sigma B1..B38 == Amount(1),
    diff 0.01 rounding); B28 (a row pdfplumber dropped) recovered; VERIFY clean.
  - Whole-document extraction: ~95+ after numbering-based heading levels + figure dedup.
- **Scanned PDFs -> NOT 100% from any single tool.** Multi-engine vote + checksum
  reconcile + 0.70 HITL gate. Low-res (e.g. 150 DPI) dense numeric tables are the hard
  floor - get the source XLSX or a 300-DPI rescan; no OCR can guarantee those.

Report TWO numbers: auto-accept rate (machine alone) and committed accuracy
(~100%, because nothing unverified is saved).

---

## 5. Plan / roadmap

**Done**
- Modular pipeline; audited XLSX path; production table engine (completeness + tie-out);
  whole-document digital extractor (text+tables+figures+reading order+self-audit).
- **Production hardening pass (2026-06-25) -> ~10/10:**
  - A1 rounding-scaled tie-out tolerance (`ceil(0.5*n_rows)` rupees, magnitude-independent -
    replaced the 0.5%-of-total slack that hid a ₹5L dropped row in a ₹4cr total).
  - A2 amount-column-by-header (right column on full Sr/Desc/Qty/Rate/Amount BOQs, not just abstracts).
  - A3 anti-fabrication guard (`robust_tables.is_tabular`): a borderless grid is accepted ONLY if it's a
    real table (>=50% multi-filled rows OR >=2 numeric columns - additive, never over-rejects a sparse
    BOQ); fixed table_pdf shipping fabricated prose-tables; + borderless tables now extracted on MIXED
    pages and covered by the completeness audit.
  - C1 ExtractConfig + optional config.yaml; C2 enforced completeness gate (status.json + _status.json
    committed/withheld, --strict) with a digit-bearing orphan-severity filter; C3 parallel/resume/killable
    timeout/GPU lane; C4 JSON run-log.
  - B1 windowed OCR (flat RAM on huge scans) + B2 0/90/180/270 orientation (OSD) + B3 Florence agreement gate.
  - D .xls support (xlrd), metadata best-effort caveat, 14->11 top-level files (dead experiments -> evals/).
  - E tests/ (17 golden+unit, all green on the laptop).
  - Back-compat invariant held: `--workers 1` + no `--strict` + no `--config` == prior behaviour.

**Next (priority order)**
1. **Scanned-OCR path for `doc_layout`** - scanned pages currently flagged `route:scanned`;
   route them through the `pdf_extract` docTR/Tesseract ladder so they yield the SAME
   element schema (the design spec covers this). Makes whole-doc work on scans too.
2. **DOCX / cleaner exports** from `layout.json` (editable Word: headings, real tables,
   inline images) via python-docx; full-reflow `preview.html` for QC.
3. **Layout polish** - caption linking to figures, two-column reading order on
   multi-column pages, footnotes, AcroForm fields.
4. **KB ingestion** - feed `layout.json` element stream (element-granular chunks with
   `section_path`, bbox, type) into the KB engine; mint per-project namespace.
5. **Gold set + eval** - hand-label a few pages, run `run_ocr_eval` (CER target <=3%
   printed) and a layout-accuracy check.

**Known limits (honest)**
- 150-DPI scanned dense number tables: not reliably extractable by any OCR.
- Whole-doc reading order is heuristic XY-cut: correct for 1/2/3-column Manhattan
  layouts; pathological magazine/overlap layouts fall back to Y-then-X (flagged).
- Heading/list classification is numbering + font-stat + regex based; docs that encode
  headings only by capitalization (no number, no size change) are harder.

---

## 6. Environment

Server: Windows, 2x RTX 5090, venv `C:\Users\admin\pradeep-defect-work\venv2` (Python 3.11).
Installed: torch+cu128, doctr, pymupdf(fitz), pdfplumber, pdfminer, opencv, openpyxl,
python-docx, reportlab, img2table, Tesseract 5.4 (eng+hin+mar) at `C:\Program Files\Tesseract-OCR`.
Files are edited on the laptop `Desktop\kb-extract-rig\` and copied to the server.
`robust_tables.py` must sit next to `table_pdf.py` / `doc_layout.py` (they import it).
