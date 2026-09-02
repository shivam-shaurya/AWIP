# kb-extract-rig

**A sovereign, production-grade document + schedule extraction engine.** Turns messy
real-world PDFs (tenders, BOQs, reports, scanned letters), Excel, Word, and project
schedules (Primavera P6 `.xer` / MS Project `.mpp`) into clean, **completeness-audited**,
confidence-scored structured data — with an arithmetic **money tie-out**, a human-in-the-loop
gate, and an "ask for the original Excel" reconciliation backstop for tables OCR can't read.

> **Design creed:** *earn completeness through geometry + a self-audit; never silently drop
> or fabricate data.* Tables must tie out arithmetically (Σ line items == grand total). Anything
> unverifiable is flagged for review, never committed as if correct. The rig reports **two
> numbers** — machine auto-accept rate, and committed accuracy (~100%, because nothing
> unverified is saved).

---

## 👉 For testers — start here

**Setup**
```bash
pip install -r requirements.txt          # laptop / digital path
bash setup_server.sh                      # GPU box (scanned + schedules): docTR/tesseract/java + CUDA torch + deps
```
**Run**
```bash
python pipeline.py --in <folder> --out out --lang eng+hin+mar   # main entry point
python tests/test_core.py                                        # 96 pure-logic tests (no GPU)
bash check.sh                                                    # compile + tests + lint
```

**Already solid (spot-check, don't belabor):** Digital PDF, Excel, Word, and Primavera/MS-Project
schedules — near-exact and **measured** (Excel + Word = content-F1 1.0 / row-acc 1.0 on gold).

**Where to spend the effort — the scanned / OCR path.** This is the unproven part and the whole
point of this round (scanned OCR needs the **GPU box** — it won't run on a laptop):
1. Run real scanned BOQs / documents through `pipeline.py` on the GPU server.
2. Produce the **scanned-accuracy number** and **calibrate the confidence gate** — needs ~50 real
   scanned pages + ground truth (see §6 and `eval/golden/README.md`).
3. Exercise the **review + reconcile** flow (upload the original Excel for tables OCR can't read).

**Known limits (note them — they are not bugs):** handwriting → routes to human review;
multi-project `.xer` unsupported; this is a **batch engine, not a service yet** (no upload API /
queue — see `PRODUCTION_READINESS.md` for the service/scale roadmap to uploads + 1000 files/day).

**Golden rule for feedback:** the rig never silently drops or fabricates — anything uncertain lands
in the **review / reconcile queue** or `_errors.json`. So the useful bug report is *"why did this go
to review?"*, not *"it didn't auto-accept."* Full honest state + limits: §8.

---

## 1. What it extracts

| Input | Path | Result |
|---|---|---|
| **Digital PDF** | text layer + geometry | tables (tie-out) + text + figures + links, in reading order |
| **Scanned PDF / image** | OCR ladder / docling | same element stream; low-confidence → review / reconcile |
| **Excel** (`.xlsx/.xlsm/.xls`) | direct read | exact cells + Schedule-H tie-out |
| **Word** (`.docx`) | direct read | tables + paragraphs |
| **Primavera P6** (`.xer`) / **MS Project** (`.mpp`) | MPXJ (JVM) | activities, relationships, dates, float, %complete, baseline, **resources, assignments, costs, Data Date** |

**Outputs:** `layout.json` (structured element stream), `.md` (readable markdown),
`.xlsx` (tables + a VERIFY sheet), `chunks.jsonl` (for KB/embeddings), `<stem>.schedule.json`
(schedules), a per-run **review queue**, and a **reconcile queue** (which docs need an Excel).

---

## 2. Quick start

```bash
# install (CPU / laptop — the digital path needs only this)
pip install -r requirements.txt
#   or, editable with the same core deps + optional extras declared in pyproject.toml:
#     pip install -e .              # core (CPU / digital)
#     pip install -e ".[gpu]"       # + scanned/OCR ladder   (needs a GPU + system tesseract)
#     pip install -e ".[schedule]"  # + .xer/.mpp parser      (needs a JVM / Java 8+)

# --- run ---
# whole folder, auto-routed (PDF/XLSX/DOCX):
python pipeline.py --in samples --out out --workers 0 --dpi 300 --lang eng+hin+mar

# whole-document JSON + Markdown (digital + scanned tables/structure):
python doc_layout.py --in file.pdf --out out_docs --ocr-scanned --dpi 300 --lang eng+hin+mar

# tables only -> one xlsx + money VERIFY sheet:
python table_pdf.py --in file.pdf --out tables.xlsx --verify

# schedules (needs Java + the schedule extras):
python extract_schedule.py --in file.xer --out sched_out

# regression suite (pure logic, no GPU):
python tests/test_core.py           # expect: all passed
```

GPU/OCR, docling, PaddleOCR and the schedule parser need extra deps + a server — see
[§7 Deployment](#7-deployment) and `SERVER_RUNBOOK.md`.

---

## 3. Architecture

```
                       pipeline.py  (route by file type)
                            │
   ┌────────────────────────┼─────────────────────────────┐
   ▼                        ▼                              ▼
 pdf_extract.py        excel_extract.py               docx_extract.py
 (native + OCR ladder) (exact read + tie-out)         (exact read)
   │
   │   robust_tables.py  ◄── table_pdf.py (driver: stitch + money VERIFY + xlsx)
   │   (geometry engine)          │
   ▼                              ▼
 doc_layout.py  — atomize text → tables → figures → links → banded reading order →
   │              cross-page stitch → money tie-out → self-audit → layout.json + .md
   │   ├── scanned_layout.py / scanned_tables.py   (scanned pages → same schema)
   │   ├── links_qr.py                             (hyperlinks / URLs / QR)
   │   └── reconcile_tables.py                     ★ "ask for the original Excel" backstop
   ▼
 common.py  ◄─── the dependency-free LEAF everyone imports
 (ExtractConfig · money tie-out verify_table · number parsing · ends_in_total ·
  completeness verdict · parallel kill-pool · atomic/sharded IO · logging · calibration)

 MULTI-ENGINE (opt-in, scanned):  docling_layout.py (IBM Docling) + current(docTR) →
   ensemble_extract.py reconcile → paddle_layout.py fallback on low-confidence pages
 SCHEDULES (separate, JVM):  schedule_mpxj.py + schedule_normalize.py + extract_schedule.py
 EVAL / QA:  eval/ (metrics, benchmark, engine comparison, golden set) + tests/
```

### The scanned engine ladder (multi-engine, route by strength)
```
Scanned document
  ├─ docling  → clean TEXT + reading order (+ scanned tables)
  ├─ current  → TABLES + the arithmetic tie-out + links/QR
  └─ RECONCILE (ensemble_extract) → agreement = confidence
        ≥ gate → accept
        < gate → paddle fallback (cheap, only on hard pages)
                   still low → HUMAN REVIEW / request original Excel → reconcile_tables
```
Engine roles are chosen from measured strengths: **docling** = cleanest reading order (fast,
sovereign); **current/docTR** = completeness + the money tie-out + links; **paddle** =
low-confidence fallback only (non-sovereign, opt-in); **Florence-2 VLM** = table tie-breaker only.

### The reconcile backstop (tables OCR can't read)
When a scanned table is uncertain, `doc_layout --reconcile-tables` leaves a **tombstone** in
its exact slot and lists the doc in `reconcile_queue.csv`. The operator uploads the authoritative
Excel; `reconcile_tables.py` aligns each sheet to the right tombstone by **arithmetic** (anchor →
LIS monotonicity → segment), injects the clean rows into the exact position, and re-verifies the
tie-out. Multiple tables → multiple sheets are matched independently (element-id keyed).

---

## 4. Module map

| Group | Files |
|---|---|
| **Orchestration** | `pipeline.py` |
| **Shared core** | `common.py` |
| **Table engine** | `robust_tables.py`, `table_pdf.py` |
| **Whole-document** | `doc_layout.py` |
| **OCR / scanned** | `pdf_extract.py` (docTR→Tesseract→Florence), `scanned_layout.py`, `scanned_tables.py` |
| **Structured readers** | `excel_extract.py`, `docx_extract.py` |
| **Links / images** | `links_qr.py`, `extract_images.py` |
| **Reconcile backstop** | `reconcile_tables.py` |
| **Multi-engine (opt-in)** | `docling_layout.py`, `paddle_layout.py`, `ensemble_extract.py`, `eval/compare_engines.py`, `eval/engines/` |
| **Schedules (JVM)** | `schedule_mpxj.py`, `schedule_normalize.py`, `probe_schedule_mpxj.py`, `extract_schedule.py` |
| **Eval / QA** | `eval/` (`table_metrics`, `run_benchmark`, `confidence_report`, `make_golden`, `make_scanned_boq`, `merge_engine_compare`, `report`), `tests/test_core.py` |
| **Export / audit** | `export_pdf.py`, `run_ocr_eval.py`, `audit_run.py` |
| **Ops / config** | `setup_server.sh`, `pull_results.sh`, `check.sh`/`check.ps1`, `Makefile`, `requirements*.txt`, `ruff.toml`, `config.yaml` |
| **Docs** | `README.md`, `CONTEXT.md`, `RUN.md`, `eval/reports/*` |

---

## 5. Tech stack (what + why)

**Core (CPU, sovereign):** PyMuPDF/`fitz` + `pdfplumber` (digital PDF text, geometry, tables) ·
`openpyxl` / `python-docx` / `xlrd` (Office) · `numpy` / `opencv` / `scikit-image` / `Pillow`
(imaging) · `PyYAML` / `psutil` / `rapidfuzz` / `tqdm`.

**GPU OCR ladder (sovereign):** `python-doctr` (Mindee, France — primary) → `pytesseract`
(Tesseract 5, voting) → **Florence-2** (Microsoft, MIT — table tie-breaker VLM) · `torch`+CUDA ·
`img2table`.

**Multi-engine (opt-in):** **IBM Docling** (MIT, sovereign — scanned text/layout + TableFormer) ·
**PaddleOCR** (Baidu — *non-sovereign*, low-confidence fallback / benchmark **only**, isolated venv).

**Schedules:** **MPXJ** (+ `JPype1`, needs a JVM) — one reader for P6 `.xer`/PMXML and MSP `.mpp`/MSPDI.

> **Sovereignty:** docTR / Docling / Florence-2 are sovereign and shippable. PaddleOCR is
> non-sovereign — included as a labelled, opt-in fallback/benchmark, never a default.

---

## 6. Testing & evaluation

```bash
python tests/test_core.py                                   # 96 pure-logic golden/unit tests (no GPU)
python eval/run_benchmark.py score --run out --golden eval/golden   # table/text accuracy vs a gold set
python eval/confidence_report.py --run out                  # HITL routing worklist
python eval/compare_engines.py --engines current,docling,paddle,vlm --in ...   # engine bake-off
bash check.sh                                               # compile + tests + lint (one command)

# calibrate the confidence gate on the GPU server (needs >=50 of YOUR scanned pages + gold):
python pipeline.py --in your_scanned/ --out out_cal --lang eng+hin+mar
python run_ocr_eval.py --out out_cal --gold your_gold/ --calibrate   # -> out_cal/calibration.json
```
`eval/golden/` holds hand-verified ground truth (see `eval/golden/README.md`); `eval/reports/`
holds the written architecture/code/accuracy reviews + machine-generated benchmark outputs.

---

## 7. Deployment

Server (Ubuntu + NVIDIA GPU) one-command setup:
```bash
bash setup_server.sh     # system libs (tesseract/java/libreoffice) + venv + CUDA torch + rig deps + docling
```
PaddleOCR installs into its **own** venv (`~/paddle-venv`) to avoid a numpy conflict. The
schedule parser needs Java; run `python probe_schedule_mpxj.py <file>.xer` once to confirm the
MPXJ API before relying on it. Full benchmark/calibration runbook: `SERVER_RUNBOOK.md`.

---

## 8. Honest status & limitations

- ✅ **Digital PDF / Excel / DOCX** — effectively exact (text-layer/cell read + tie-out); the
  strongest, most-trusted path. *Measured:* Excel + Word score **content-F1 1.0 / row-accuracy 1.0**
  against the verified gold (`eval/run_benchmark.py score`).
- ✅ **Schedules (`.xer`/`.mpp`)** — proven on real files (activities + relationships + resources +
  assignments + costs + Data Date). *Multi-project `.xer` is not yet supported.*
- ⚠️ **Scanned / images** — works; docling gives clean text, the reconcile backstop covers tables OCR
  can't read. **Dense low-DPI numeric tables are a hard floor no OCR clears** → request the source Excel.
- ⚠️ **Handwriting** — no dedicated model yet; low-confidence routes to review.
- ⏳ **Accuracy numbers are validated on digital + synthetic goldens.** A *real* scanned-BOQ gold +
  a transcribed page are needed to calibrate the confidence gate and publish measured scanned accuracy.
- **Confidence gate — the calibrator is built, tested, and ready; it only needs real data to fit.**
  `run_ocr_eval.py --calibrate` (LEVER F) turns ≥50 GPU-OCR'd docs + their gold into a fitted gate
  (demonstrated: it recommends `0.924` on a 50+-sample curve; unit-tested in `tests/test_core.py`).
  Until fit, the 0.70 / 0.90 / 0.95 gate is conservative **routing**, not a proven probability. The
  unblock is small and specific: **a handful of your scanned BOQ pages + the original Excel**
  (`eval/golden/README.md` step 4), run on the GPU server — see §6. **Public web datasets are not a
  valid substitute:** the field extractor is India-tuned (`Rs/INR`, PAN/GSTIN — `common.py`), so
  foreign receipts calibrate degenerately, and English-OCR CER does not transfer to eng+hin+mar.
- ✅ **Windows long paths handled.** Every per-file writer (PDF/doc layout, the Excel `cells.json`/
  `summary.json` sidecars, and the schedule JSON) writes through the `\\?\` long-path prefix, so a deep
  sharded output path over the 260-char `MAX_PATH` limit no longer fails. Verified at ~277 chars.

See `eval/reports/PIPELINE_STATUS_AND_ROADMAP.md` for the full extraction-accuracy state + roadmap,
and `PRODUCTION_READINESS.md` for the **service / scale / ops** roadmap (upload API, queue, 1000/day).

---

## 9. Repository layout

```
kb-extract-rig/
  *.py                 flat modules (imports are flat — keep them at the root)
  eval/                measurement harness + engine comparison + golden set + written reviews
    engines/           opt-in comparison adapters (current / docling / paddle / vlm)
    golden/            hand-verified ground truth
    reports/           architecture / code / accuracy reviews + benchmark outputs
  tests/               test_core.py (pure-logic golden + unit suite)
  samples/             example inputs
  pyproject.toml       project metadata + dependency EXTRAS ([gpu]/[schedule]/[dev]) + pytest cfg
  requirements*.txt    core (CPU) + gpu + schedule dependency sets (authoritative pinned install)
  ruff.toml            lint config (auto-discovered by check.sh)
  setup_server.sh      one-command GPU-server setup
  README.md CONTEXT.md RUN.md   docs
  PRODUCTION_READINESS.md       service/scale/ops roadmap (uploads, queue, 1000/day)
```

Transient outputs (`out*/`, `sched_out*/`, `__pycache__/`, generated fixtures) are git-ignored and
recreated by each run — never checked in.
