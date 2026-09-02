# Server Runbook — the benchmarks that need the GPU / JVM box

The laptop can run all pure-logic (tie-out, geometry math, `table_metrics`,
`tests/test_core.py`). **OCR (docTR/torch/Tesseract), real scans, and the schedule
parser (MPXJ/JVM) only run on the server.** Run these there and copy the
`eval/reports/` outputs back. Do not claim a GPU/JVM number was verified from the laptop.

```powershell
# --- server setup (once per session) ---
$PY = "C:\Users\admin\pradeep-defect-work\venv2\Scripts\python.exe"
$env:Path += ";C:\Program Files\Tesseract-OCR"
& $PY -c "from doctr.models import ocr_predictor; m=ocr_predictor(pretrained=True); import torch; print('device:', next(m.det_predictor.model.parameters()).device)"
#   expect: device: cuda:0
pip install psutil xlrd img2table PyYAML   # psutil = peak-RSS in the speed benchmark
```

## 0. Regression suite (always first)
```powershell
& $PY tests\test_core.py          # expect the documented count; a drop = you broke the core
```

## 1. Confirm the schedule parser actually works (GATE for XER/MPP = 100%)
This is the single most important unknown. **Do this before trusting any schedule output.**
```powershell
& $PY probe_schedule_mpxj.py "samples\SP-II-NMDC 20th Mar.xer"
& $PY probe_schedule_mpxj.py "samples\NMDC_Kirandul_Updated L3 Schedule_Rev 03_ as on 23.04.2026.mpp"
```
The probe prints OK/FAIL for every MPXJ call the parser uses and dumps the real method
names. **Watch specifically for the relationship accessor** (`getPredecessorTask`/
`getSuccessorTask` vs `getSourceTask`/`getTargetTask`) — if it FAILs, `schedule_mpxj.py:391`
is silently dropping every logic link (risk R6). Record the MPXJ version and pin it in
`requirements-schedule.txt`.

Then parse for real and eyeball counts (activities, relationships ≠ 0, dates populated):
```powershell
& $PY schedule_mpxj.py "samples\SP-II-NMDC 20th Mar.xer" > out\xer_probe.json   # if a CLI exists; else via probe
```

## 2. OCR accuracy on real scans (target ≥95% printed)
Build goldens for the scanned samples first (seed from the original Excel where one
exists — that's authoritative), then:
```powershell
# extract the scanned NCR letters through the table path (keeps the arithmetic guarantee)
& $PY table_pdf.py --in "samples\638938808860809332_Letter No 0410...pdf" --out out\ --verify --scanned-cell-ocr
# whole-document OCR path
& $PY doc_layout.py --in "samples\Dep-14&11C Network schedule for Oct25.pdf" --out out_scan\ --ocr-scanned --dpi 300 --lang eng+hin+mar
# measure CER + field accuracy vs the gold set
& $PY run_ocr_eval.py --out out_scan\ --gold eval\golden\
```
Report the **two numbers**: `auto_accept_rate` and committed accuracy.

## 3. Calibrate the confidence gate (turn a guess into a curve)
```powershell
& $PY run_ocr_eval.py --out out\ --gold eval\golden\ --calibrate    # -> out\calibration.json + ECE table + recommended gate
& $PY pipeline.py --in samples\ --out out2\ --calibration out\calibration.json
```
Do **not** lower 0.70 until the curve is fit on ≥ `min_samples`; report the
`auto_accept_rate` shift first. An uncalibrated auto-accept gate commits wrong data
with false confidence (risk H6).

## 4. Table-accuracy benchmark (the new metric)
```powershell
& $PY eval\run_benchmark.py score --run out_scan\ --golden eval\golden\ --out eval\reports\
```
Read `content_f1` (did we capture the right values), `positional_f1` vs `content_f1`
(the gap = misplacement, risk R3), `table_count_match_rate` (<1 = split/merge error),
and per-type `mean_cer`.

## 5. Speed / memory benchmark
```powershell
& $PY eval\run_benchmark.py time --samples samples\ --out eval\reports\ `
    --py $PY --cmd "{py} table_pdf.py --in {file} --out {outdir} --verify"
& $PY eval\run_benchmark.py time --samples samples\ --out eval\reports\ `
    --py $PY --cmd "{py} doc_layout.py --in {file} --out {outdir} --ocr-scanned --dpi 300"
```
Records wall-time, MB/s, and peak RSS per file. Watch for the perf hot spots in
`02_CODE_REVIEW.md` (per-cell Tesseract spawn, PNG round-trip, double PDF open).

## 6. HITL routing worklist + assemble the index
```powershell
& $PY eval\confidence_report.py --run out_scan\ --out eval\reports\
& $PY eval\report.py --reports eval\reports\ --out eval\reports\INDEX.md
```
`INDEX.md` now shows the real measured numbers; `confidence.csv` is the operator
worklist (which original file to request for each uncertain table).

## 7. (Optional) External-tool benchmark
To benchmark vs pdfplumber / Camelot / Tabula / PyMuPDF / Marker / Unstructured /
Docling / Surya / PaddleOCR / EasyOCR / Textract / Azure DI / Google Doc AI: run each
on the same golden samples, emit grids in the `{"tables":[{"grid":[...]}]}` shape, and
score with `eval/table_metrics.py`. Note cloud cost per 1k pages alongside accuracy.
(A `--tool` adapter for `run_benchmark.py` is a good next addition — not built yet.)

---

### Copy back to the laptop
After the server run, copy `eval\reports\*.json` + `*.md` + `out\calibration.json` back
so the written reviews can be refreshed with real numbers and committed to the repo.
