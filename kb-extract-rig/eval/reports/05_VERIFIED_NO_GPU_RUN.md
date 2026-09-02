# Verified Run (no GPU) — what was actually executed

Everything below was **run**, not read. Distinct from the desk-review reports: these
findings are CONFIRMED by execution on the real code and real sample files. GPU-only
paths (OCR, scanned PDFs, MPP/XER runtime) are deferred to the server — see
`SERVER_RUNBOOK.md`.

## Environment (this laptop)

- **Python 3.13.14.** Present: `fitz`, `pdfplumber`, `openpyxl`, `numpy`, `cv2`, `PIL`,
  `python-docx`, `yaml`, `psutil`. Missing: `xlrd` (legacy `.xls`), `rapidfuzz`,
  `pytest`, `torch`, `doctr`, `pytesseract`, `img2table`.
- The **digital path runs fully here** (fitz + pdfplumber + openpyxl). Only OCR/scanned
  and legacy `.xls` need the missing deps. The rig ran without `rapidfuzz`/`pytest`, so
  those are not hard runtime deps for the digital path.

## 1. Static + regression — PASS

- **All 20 modules compile** (`py_compile`). One minor issue: `pdf_extract.py:21` emits
  a `SyntaxWarning: invalid escape sequence '\ '` — a docstring usage example
  (`--in samples\ `) that should be a raw string. Cosmetic; fix by making the docstring
  raw (`r"""`). **[LOW]**
- **Regression suite: `67 passed, 0 failed`** via `python tests/test_core.py` (no pytest
  needed). The arithmetic/geometry/reconcile pure-logic core is green.

## 2. Digital PDF — `table_pdf.py` on `Dep-14&11C Network schedule for Oct25.pdf` — WORKS

```
page 1: DIGITAL 2 table(s) · page 2: 2 · page 3: 3
[done] 4 tables (3 fragments skipped) (3 digital, 0 OCR) [NEEDS_REVIEW]
       VERIFY: 1 arithmetic + 0 orphan flag(s)
```
The rig extracted, ran the money VERIFY, found an arithmetic flag, and correctly routed
the file to **NEEDS_REVIEW** rather than committing. Exactly the designed behaviour.

## 3. Excel — `excel_extract.py` on all three `.xlsx` samples — WORKS, but confirms a gap

| File | Sheets | Cells read | Tie-out |
|---|---|---|---|
| Civil BBU 25.10.25. | 4 | 2,223 | **REVIEW** (no contract price / no total rows) |
| Billing Schedule Fabricated Building Structure | 1 | 148 | **REVIEW** (no total rows) |
| RFIView_Report_20260521_114807 | 1 | 56,385 | **REVIEW** (no total rows) |

**Confirmed finding:** the "100% exact cell read" is real (all cells read directly), but
the **arithmetic tie-out fired on none of them** — it only triggers on a Schedule-H
weightage (~1.0) shape (`excel_extract.py:114`). For ordinary BOQ/billing/RFI workbooks,
the completeness *proof* does not run; correctness rests entirely on the direct read.
This matches risk R5-adjacent in `03_ACCURACY_AND_RISK.md` — the "audited 100%" claim is
narrower than it sounds for real-world Excel shapes. (Also: an openpyxl
`Cannot parse header or footer` UserWarning on two files — benign.)

## 4. Whole-document — `doc_layout.py` — CONFIRMED CRASH BUG (MAX_PATH)

- With a **deep output dir**, doc_layout **crashed**:
  `FileNotFoundError: ...\fc\cb\<key>\<key>.layout.json.tmp`. The full path was
  **271 chars > Windows MAX_PATH (260)**.
- With a **short output dir**, it **succeeded**: produced `layout.json` (4 tables,
  `element_counts` = header 21 / table 4 / footer 9), `.md`, `.status.json`, the `.done`
  sentinel, and `review_pages.csv`; 1 page flagged for review.

**New confirmed risk (add to register): `RXX` HIGH-in-effect / MED-severity.** CONTEXT.md
says the MAX_PATH issue was "fixed" by capping the *stem* to 48 chars — but that bounds
only the stem, not the **total** path, and long-path support isn't enabled. A customer
with a deep output root or a nested input tree hits a hard crash (the file is logged to
`_errors.json` and the batch continues, so it's a silent per-file loss, not a total
failure). *Fix:* enable Windows long paths — prefix IO paths with `\\?\` (or set the
`LongPathsEnabled` manifest/registry flag and document it), and/or cap the *total* output
path, not just the stem. Repro is deterministic. Locations: `common.doc_outdir`/`doc_key`
+ `common.atomic_write_text` + `doc_layout.extract_document`.

## 5. Harness self-validation — a real bug found in MY tooling, fixed

Running the harness on real `doc_layout` output exposed that the schema nests tables
under **`pages[].elements[]`**, not a top-level `elements` (that shape is only produced
by other paths). My first cut read the wrong key and reported **0 tables from valid
output**. Fixed in `table_metrics.py` (`tables_from_layout`), `run_benchmark.py`,
`make_golden.py`, `confidence_report.py`. Re-verified on the real file:
- `tables_from_layout` now returns **4 grids** (matches `element_counts.table=4`).
- Round-trip score (output vs a golden seeded from itself) = **F1 1.0, TEDS 1.0** — the
  scorer is correct on real data.
- `confidence_report` routed the real run: 1 manual-review + 4 request-source, auto-accept
  0 (the doc is NEEDS_REVIEW, so nothing auto-committed) — correct.

## 6. Content lead to check when the golden set exists (not yet a confirmed bug)

`doc_layout` reconstructed this network-schedule PDF into very wide, sparse grids
(69×47, 74×48, 37×46 cells). That smells like **column over-segmentation on a
schedule/Gantt-style layout** — plausible but unproven without a hand-verified golden.
Flagged as the first thing to score once `eval/golden/` has this file verified. It is
also a reminder that Primavera/Gantt-style PDFs are a distinct, hard table shape.

---

### What this run did NOT cover (needs the GPU/JVM server)
Scanned OCR accuracy (the 3 NCR letter PDFs are image-only — 0 chars/page), handwriting,
per-cell scanned-table OCR, MPP/XER runtime + the MPXJ probe, and confidence
calibration. All scripted in `SERVER_RUNBOOK.md`.
