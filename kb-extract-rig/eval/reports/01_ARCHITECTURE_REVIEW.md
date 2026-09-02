# Architecture Review — kb-extract-rig

## 1. What the system is

A document-extraction rig that turns messy PDFs / images / scanned pages / Excel /
DOCX — and, in a separate sub-system, Primavera `.xer` / MS-Project `.mpp` schedules —
into clean, confidence-scored, **completeness-audited** structured data. Two extraction
layers share one core: a **tables** layer (arithmetic completeness guarantee) and a
**whole-document** layer (text + tables + figures + links in reading order).

## 2. Layering (this is the strong part)

```
                         pipeline.py  (route by type -> extractor -> manifests + queue)
                              │
     ┌────────────────────────┼───────────────────────────────┐
     ▼                        ▼                                ▼
  pdf_extract.py         excel_extract.py                 docx_extract.py
  (native + OCR ladder)  (direct read + tie-out)          (direct read)
     │                        │                                │
     │  robust_tables.py  ◄───┴── table_pdf.py (driver: stitch + VERIFY + xlsx)
     │  (geometry engine)                │
     ▼                                   ▼
  doc_layout.py  ── reuses robust_tables, adds figures/links/reading-order/audit
     │   ├── scanned_layout.py  (OCR-with-geometry, same element schema)
     │   ├── links_qr.py        (hyperlinks/URLs/QR)
     │   └── reconcile_tables.py(align noisy PDF tables to an authoritative Excel)
     ▼
  common.py  ◄─────── the dependency-free LEAF everything imports
  (ExtractConfig · parse_number · verify_table/_verify_col · validate_rows ·
   completeness_status · parallel_foreach [kill-pool + GPU lane] · atomic/sharded IO ·
   logging · calibration)

  SEPARATE ISLAND (not wired to pipeline): schedule_mpxj.py + schedule_normalize.py
  + probe_schedule_mpxj.py   (MPXJ/JVM; .xer/.mpp)
  TOOLING: run_ocr_eval.py · export_pdf.py · audit_run.py · extract_images.py
  NEW: eval/  (table_metrics · run_benchmark · confidence_report · make_golden · report)
```

**Dependency direction is correct**: everything flows *toward* `common.py`, which
depends on nothing in the repo. That single-leaf discipline is why the arithmetic
tie-out, number parsing, and total-keyword detection exist in exactly one place — a
real strength most parsers get wrong (they fork a second number parser and drift).

## 3. Data flow (whole-document path, the richest)

`doc_layout.extract_document` (≈545–735) per page: route native vs scanned by
native-text length → atomize text lines → detect tables (reuse `robust_tables`) →
subtract table+figure regions from the text → classify remaining lines
(heading/para/list) → banded XY-cut reading order → attach links/QR → cross-page
table stitch → money tie-out per table → self-audit → emit `layout.json` + Markdown +
figures + `review_pages.csv`. Scanned pages take the same tail via `scanned_layout`
so the element schema is identical digital-vs-scanned. **This shared-tail design is
excellent** — one classifier/orderer/auditor, two front-ends.

## 4. Design principles that are working

- **Earn completeness, never fake it.** Geometry places every word; the audit flags
  any in-table word left unplaced; borderless tables must pass an anti-fabrication
  gate (`is_tabular` AND ≥2 numeric columns AND row-density floor) before they exist.
- **Arithmetic as truth.** Σ(line items) == grand total (rounding-scaled tolerance),
  plus row-level `Qty·Rate==Amount` and serial-gap detection — three independent
  cross-checks. This is a genuinely good idea, well executed.
- **Opt-in everything.** New accuracy features are flags; with them off the digital
  path is byte-identical. This invariant is testable and is tested.
- **Degrade to review, never crash the batch.** Per-page/per-file isolation, killable
  GPU lane, atomic writes + `.done` sentinel, collision-safe sharded output keys,
  Windows MAX_PATH capping. These are real 1M-scale hardening, not hand-waving.
- **Honesty in the docs.** `CONTEXT.md` distinguishes built vs planned vs unproven and
  lists caveats. Rare and valuable.

## 5. Built vs. claimed (the gaps)

| Claimed in docs | Reality in code |
|---|---|
| "runtime 100% completeness guarantee" (tables) | Guarantees word **presence**, not correct **placement**. Merged/spanning cells can be misplaced and still pass the audit (`robust_tables.py:246-263`). |
| Excel path "audited, 100%" | Holes: `.xls` dates read as float serials; merged cells not expanded in `read_only` mode; tie-out only fires with a Schedule-H weightage column. (`excel_extract.py:187,190,114`) |
| Schedule "P0 done" | Unwired (`_HAVE_BASE=False` always), MPXJ method names unverified, **zero tests despite docstring claims**, ~60–70% field coverage. |
| "48 / 67 tests" | Real, but all on the document core. Tests skip-and-pass when optional deps are missing, so the count overstates coverage; OCR + schedule are untested. |
| Confidence gate 0.70 (+ HITL 0.90/0.95) | Uncalibrated — a guess. No ECE/reliability curve is wired into the gate yet. |

## 6. Architectural weaknesses (ranked)

1. **God-functions.** `doc_layout.extract_document` (~190 lines), `table_pdf.extract_pdf_tables`,
   `schedule_mpxj.parse_schedule` (~200 lines) each do IO + orchestration + audit +
   write. Hard to unit-test the middle; extract stages into named functions.
2. **Untyped dict/list contracts.** Elements are `dict[str,Any]`, grids are
   `list[list[str|None]]`. The schema is convention-only; a typo'd key fails silently.
   A `TypedDict`/dataclass for the element + table-score schema would catch a class of bugs.
3. **The schedule sub-system is an island.** No CLI, not in `pipeline.py`, not in
   `parallel_foreach`, dead registry (`_HAVE_BASE=False`), and its output shape
   (ISO strings) doesn't match what `schedule_normalize` expects (`datetime`), so the
   two never connect. It needs wiring + a shape contract before it can be "100%".
4. **Private-API coupling across modules.** `scanned_layout` reaches into
   `robust_tables._numeric_columns`; `reconcile_tables` imports `doc_layout._write_markdown`.
   Promote these to public, documented helpers.
5. **Measurement was external to the system.** Accuracy was proven by an internal
   consistency proxy (tie-out), not vs ground truth. `eval/` now closes this, but the
   golden set must be built for it to mean anything.

## 7. Recommended target architecture (incremental, not a rewrite)

- Keep the leaf/engine/driver layering — it's right.
- Introduce a typed **`Element`/`Table`/`Grid` schema** (TypedDict) in `common.py`;
  thread it through so contracts are explicit.
- Split each god-function into testable stages (pure transforms in, IO at the edges).
- Add a **native `.xer` reader** beside MPXJ; wire the schedule sub-system into
  `pipeline.py` with the same review-queue + output contract as `doc_layout`.
- Make `eval/` a first-class gate: no accuracy claim ships without a golden-set number.
- Add a **word-box-level OCR vote** and a **handwriting detector** as new stages in the
  OCR ladder (see `03_ACCURACY_AND_RISK.md`).
