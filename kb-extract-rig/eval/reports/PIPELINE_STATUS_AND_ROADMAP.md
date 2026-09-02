# Extraction Pipeline — Status & Roadmap

*Consolidated "where we are / where we need to improve" report for kb-extract-rig, the
document + schedule extraction engine. Grounded in the real server run (AWS Ubuntu 24.04,
Python 3.12, Tesla T4 GPU) and the measured/verified evidence — no estimates dressed up as
facts. Companion to `EXTRACTION_RUN_REPORT.md` (the raw run) and `00–05_*.md` (the code review).*

---

## 1. Where we are — one-glance scorecard

| File type | Extraction works? | Accuracy | Proven how? | Trust level |
|---|---|---|---|---|
| **Excel (.xlsx)** | ✅ full | **~100%** cell read | Measured `content_f1 = 1.000` on goldens | **High** |
| **Word (.docx)** | ✅ full | **~100%** | Measured `content_f1 = 1.000` on goldens | **High** |
| **Digital PDF** | ✅ | high (~95–100%) | Indirect (goldens + regression test) | Medium-High |
| **Scanned PDF** | ✅ text · ❌ structure | **~85% text** (eyeballed) | Not measured — no gold set | **Low-Medium** |
| **Images (.png/.jpg)** | ⚠️ partial | unknown | Not run through main pipeline | Low |
| **Primavera P6 (.xer)** | ✅ activities + logic | **~95–100%** (captured fields) | Probe-verified end-to-end | **High** |
| **MS Project (.mpp)** | ✅ activities + logic | **~95–100%** (captured fields) | Probe-verified end-to-end | **High** |
| **Handwriting** | ❌ no dedicated path | poor | Not tested | Very Low |

**Headline:** structured formats (Excel, Word, P6, MS-Project) extract **reliably and are
trustworthy**. Scanned documents extract the *content text* decently but lose *table/form
structure* and have **no ground-truth number yet**. The system never commits uncertain data
silently — it routes it to human review.

**Overall engineering maturity:** ~85/100 (well-hardened, 95 automated tests, deployed on
GPU). **Overall *proven* accuracy:** only the structured formats have real numbers; scanned
is the honest unknown.

---

## 2. What was built / proven (the foundation is solid)

- **Full code review** of all 20 modules + a reusable review agent (`.claude/agents/extract-rig-qa.md`).
- **19 bugs fixed** across the effort — silent data-loss (merged-row drop, borderless-table
  prose loss), overwrite/partial-file loss, reconcile data corruption, Windows MAX_PATH crash,
  security (formula injection, zip-bomb, encrypted-PDF) — each with a regression test.
- **Test suite grown 67 → 95, all passing.** Digital output is byte-identical (locked by a
  golden-diff test); the arithmetic tie-out is untouched.
- **A real measurement harness** (`eval/`): ground-truth table accuracy (cell/row/col + TEDS),
  a HITL routing report, a multi-engine comparison harness, and honest "not yet measured" reporting.
- **Deployed to the AWS GPU server** — the scanned-OCR path (docTR on GPU) and the schedule
  parser (JVM/MPXJ) now run; both were laptop-blocked before.
- **Schedule extraction proven + wired** — the parser was an unproven, unwired "island"; today
  the probe confirmed it works and a new `extract_schedule.py` CLI dumps it to JSON.

### Today's live run (real numbers)
- **Documents** (`pipeline.py`, 9 files): 4 auto-accepted / 5 routed to review (gate 0.70).
  Excel read 100% of cells (2,223 / 148 / 56,385); scanned PDFs OCR'd on GPU (~3 min for 3 files).
- **Schedules** (`extract_schedule.py`, 3 files, **0 errors**):

  | File | Format | Activities | Relationships |
  |---|---|---:|---:|
  | SP-II-NMDC 20th Mar | p6_xer | 1,474 | 2,767 |
  | Construction Programme Jun 24i | p6_xer | 1,706 | 1,956 |
  | NMDC Kirandul L3 Rev 03 | mpp | 2,017 | 2,516 |

  Captured per activity: dates, `progress_pct` (0–1), total/free float, baseline, variances,
  WBS, critical flag, constraints. Verified: 1,201/1,474 tasks carry real predecessor links.

---

## 3. Where we need to improve (ranked by impact)

### 🔴 HIGH — accuracy proof & the scanned gap
1. **No ground-truth number for scanned PDFs.** We report ~85% by eyeball only. **Action:**
   hand-transcribe 1–2 scanned pages (or use the source Excel) → run `run_ocr_eval.py` for a
   real CER. *Until then, "scanned accuracy" is an opinion, not a fact.*
2. **Scanned tables/forms lose structure.** The pipeline path emits flat text; a scanned NCR
   *form* comes out unstructured. **Action:** run scanned docs through `doc_layout --ocr-scanned`
   (gives structured tables), and evaluate Docling for scanned table structure.
3. **Digital PDF not directly scored.** The one PDF sample was a Gantt (deferred). **Action:**
   add one born-digital BOQ PDF to the gold set → directly prove the ≥95% target.
4. **The confidence gate (0.70 / 0.90 / 0.95) is uncalibrated** — the numbers are guesses.
   **Action:** calibrate against a gold set (`run_ocr_eval.py --calibrate`) before trusting
   auto-accept; an uncalibrated gate commits with false confidence.

### 🟠 MEDIUM — coverage & completeness
5. **Excel arithmetic proof only fires on Schedule-H shape.** Ordinary BOQ/RFI sheets read
   100% but can't be *verified* (no total row), so they route to review. **Action:** broaden
   the tie-out to detect generic total rows, or accept these as "read-exact, unverified".
6. **Schedule P1 fields not yet extracted** — resources, assignments, costs, and calendar
   working-time (all confirmed *available* in MPXJ by the probe: e.g. 38 resources / 362
   assignments on the bridge project). **Action:** extend the parser to capture them.
7. **Multi-project `.xer` unsupported** (`getProjects` FAILs). **Action:** guard + handle.
8. **Engine comparison undecided.** We installed Docling/PaddleOCR but haven't run a scored
   head-to-head (needs a scanned gold). **Action:** gold → compare current vs Docling vs Paddle
   → adopt the winner (Chinese-model policy relaxed "for now", so Paddle is eligible).

### 🟡 LOWER — robustness & ops
9. **No handwriting path** — handwritten notes are read as noise; low-confidence doesn't always
   force review. **Action:** add a handwriting detector + dedicated OCR (biggest scanned risk).
10. **Pipeline isn't unified** — `pipeline.py` handles PDF/Excel/Word; schedules (`.xer`/`.mpp`)
    and standalone images run via separate commands. **Action:** wire them into one entry point.
11. **CI is dormant** (no git repo by choice) — tests run only when invoked. **Action:** run
    `check.sh` before each change; enable the ready CI config if/when the repo goes under git.
12. **Results live on the server** — pulled to the laptop manually today. **Action:** a tiny
    `pull_results.sh` helper for one-command retrieval.

---

## 4. Prioritized roadmap

**Now — no GPU needed:**
- Broaden Excel tie-out (#5); wire schedule + images into one pipeline entry (#10); add the
  `pull_results.sh` helper (#12).

**Next — needs the GPU/JVM server:**
- Gold-label 1–2 scanned pages → real CER (#1); run scanned docs through `doc_layout`
  structure path (#2); calibrate the gate (#4); run the scored engine comparison (#8).

**Then — feature depth:**
- Schedule resources/costs/calendars + multi-project (#6, #7); a born-digital BOQ PDF gold (#3);
  a handwriting path (#9).

---

## 5. Honest caveats (say these plainly)
- **"~85% scanned" is an eyeball, not a measurement** — no scanned gold exists yet.
- **Schedule accuracy is "high" but not audited field-by-field** against native P6/MSP — it's a
  mature-library deterministic parse and the values are internally consistent, but that's not
  the same as a line-by-line reconciliation.
- **Confidence numbers are uncalibrated** — do not read `conf=0.88` as "88% accurate".
- **Dense/low-DPI scanned number tables have a floor no OCR clears** — the right answer there is
  the "request the original Excel + reconcile" path, not more OCR.

## 6. Environment / reproduce
- Server: AWS Ubuntu 24.04, Python 3.12, Tesla T4 (16 GB), venv `~/kb-extract-rig/venv`.
- Documents: `python pipeline.py --in samples --out out_all --workers 0 --dpi 300 --lang eng+hin+mar`
- Schedules: `python extract_schedule.py --in samples --out sched_out`
- Verify schedule API: `python probe_schedule_mpxj.py "<file>.xer"`
- Regression: `python tests/test_core.py` (expect 95 passed)
- Accuracy benchmark: `python eval/run_benchmark.py score --run out_all --golden eval/golden`
