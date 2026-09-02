# KB Extract Rig - how to run (server + sample data)

Sovereign/non-Chinese extraction harness. Families: PDF (native + scanned) | XLSX/BOQ | DOCX.
Honest accuracy: digital files ~100%; scanned gated at 0.70 -> anything below = needs_review.

## Install (laptop / CPU core)
The digital happy-path (native-PDF text + tables, XLSX, DOCX, the arithmetic tie-out) is CPU-only
and needs just the pinned **core** set (Python 3.13):
```cmd
python -m pip install -r requirements.txt
```
`requirements.txt` is the CORE (CPU) install; versions are pinned to a `pip check`-coherent set.
OPTIONAL extras are installed only if you need the feature (a laptop needs none of them):
```cmd
pip install -r requirements-gpu.txt        :: GPU OCR: scanned/handwriting/VLM (torch + doctr + pytesseract + img2table)
pip install -r requirements-schedule.txt   :: Primavera .xer / MS .mpp (needs a JVM: Java 8+)
pip install reportlab==4.4.10              :: readable-PDF export (export_pdf.py)
pip install scipy==1.17.0                  :: global-assignment reconcile (reconcile_tables.py)
pip install xlrd==2.0.1                    :: legacy .xls reading
```

## Local check (CI-equivalent, no git needed)
One command runs, in order, **py_compile of every module -> `tests/test_core.py` -> lint**. The lint
step uses ruff (or flake8) and **SKIPS cleanly with a message if no linter is installed** - it never
hard-fails on a missing linter. Critical lint errors (syntax / undefined names) are fatal; style
findings are informational only.
```cmd
bash check.sh                                   :: macOS/Linux/Git-Bash
powershell -ExecutionPolicy Bypass -File check.ps1   :: Windows PowerShell
make check                                      :: if `make` is available
```
Expected tail on a clean tree: `CHECK: PASS` (exit 0). Install the linter with `pip install ruff`.

**Dormant CI:** `.github/workflows/ci.yml` mirrors `check.sh` and runs on push once the repo is put
under git + pushed to GitHub. **The repo is intentionally NOT under git today**; the workflow does
nothing until then - do not `git init` just to enable it unless you intend to.

## 0. Files in this folder (modular pipeline)
The old monolith was split into one module PER DATA TYPE + a shared core + an orchestrator,
so each stage is easy to read, run and debug on its own:

```
pipeline.py        <- RUN THIS. Routes each file by type -> the right extractor -> outputs.
  pdf_extract.py     PDF family: native text + scanned OCR ladder (the only GPU/OCR module).
  excel_extract.py   XLSX/XLSM family: DIRECT read = 100% exact + Schedule-H tie-out (no OCR).
  docx_extract.py    DOCX family: direct read (no OCR).
  common.py          shared core: field regex+checksums, confidence, output writer, batch driver.
extract.py         back-compat shim -> forwards to pipeline.py (old command still works).
export_pdf.py      turns the output into readable PDFs.
run_ocr_eval.py    measures CER + field accuracy vs a gold set.
requirements-gpu.txt
```

Each extractor ALSO runs standalone for isolated debugging of one type:
```cmd
python pdf_extract.py   --in samples\ --out out\        :: PDFs only
python excel_extract.py --in file.xlsx --out out\        :: one workbook (rich tie-out output)
python docx_extract.py  --in file.docx --out out\        :: DOCX only
```

## 1. Get it onto the GPU server
Copy this whole `kb-extract-rig` folder to the server, e.g. `C:\Users\admin\kb-extract-rig\`.
(USB, RDP copy-paste, shared drive, or `git`.)

## 2. One missing dep (you already have the rest in venv2)
```cmd
C:\Users\admin\pradeep-defect-work\venv2\Scripts\activate
pip install python-docx
```
Already installed in venv2: torch+CUDA, doctr, opencv, pymupdf(fitz), pytesseract, scikit-image,
rapidfuzz, openpyxl, pillow, numpy. Only `python-docx` is new.

(Optional - the 2nd OCR engine for voting: install the UB-Mannheim Tesseract .exe with Hindi+Marathi.
Without it the rig still runs on docTR alone.)

## 3. Put some sample files on the server
Make a folder and drop a mix in it:
```
C:\Users\admin\samples\
   19B Schedule-H.xlsx          (digital BOQ - tests the XLSX path, runs instantly)
   ND-II 35A.docx               (digital - tests DOCX path)
   some_scanned_contract.pdf    (scanned - tests the GPU OCR ladder)
```
Your MSIDC Schedule-H workbooks (from ProjectData) are perfect for the digital path NOW -
no GPU needed - so you get a working result on real data immediately.

## 4. Run it
```cmd
:: whole folder (routes PDF/XLSX/DOCX automatically)
python pipeline.py --in C:\Users\admin\samples\ --out C:\Users\admin\out\ --gate 0.70 --dpi 300 --lang eng+hin+mar

:: one file
python pipeline.py --in "C:\Users\admin\samples\19B Schedule-H.xlsx" --out C:\Users\admin\out\
```
(`python extract.py ...` still works - it now forwards to `pipeline.py`.)

PDF-only flags (also accepted by `pipeline.py`): `--escalate-th`, `--batch`, `--no-smart-lang`,
`--vlm off|low|tables|all`, `--vlm-th`. New: **`--vlm tables`** runs the Florence-2 VLM ONLY on
dense table pages (docTR-token heuristic), not on photos/clean text - the targeted-VLM mode.

Console prints one line per file ([OK] / [REVIEW]) then a JSON summary with `auto_accept_rate`.

## 5. Look at the results
```
C:\Users\admin\out\
   review_queue.csv            <- open in Excel; work top-down (lowest confidence first)
   run_summary.json            <- files, auto_accept_rate, per-family counts
   <stem>\<stem>.doc.json      <- machine manifest: per-page confidence, fields, reasons
   <stem>\<stem>.chunks.jsonl  <- one canonical chunk per line (feed to KB/embeddings)
   <stem>\<stem>.preview.html  <- OPEN IN BROWSER: low-confidence fields in RED + page images
```

## 6. (Later) measure accuracy honestly
Create a `gold\` folder with hand-checked answers for a few docs:
```
gold\19B Schedule-H.fields.json   -> {"amount_figures":"2611464676"}
gold\some_scan.gt.txt             -> the correct full text of that scan
```
Then:
```cmd
python run_ocr_eval.py --out C:\Users\admin\out\ --gold C:\Users\admin\gold\
```
Prints CER (target <=0.03 printed / <=0.08 handwriting), field accuracy, and auto-accept rate.

## What "100%" means here (say this to seniors)
Digital files: deterministic parsing, effectively 100%.
Scanned files: NOT 100% from any single read - so 2 engines vote, checksums (PAN/GSTIN/Aadhaar)
and amount words-vs-figures must reconcile, and anything below 0.70 goes to a human.
Report TWO numbers: auto_accept_rate (machine alone) and committed accuracy (~100%, because
nothing unverified is saved). That is audit-defensible; raw "100% OCR" is not.

## Quick smoke test before real data
```cmd
python -c "from doctr.models import ocr_predictor; m=ocr_predictor(pretrained=True); print('device:', next(m.det_predictor.model.parameters()).device)"
```
Expect `device: cuda:0`.
