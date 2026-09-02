# Golden dataset — ground truth for the benchmark

A benchmark without a gold set is theatre. This folder holds the hand-verified
expected outputs the accuracy benchmark scores against. Grow it to cover the full
matrix; every file here should have been checked by a human against the original.

## File formats (keyed by `<stem>`, the sample's filename without extension)

| File | Purpose | Consumed by |
|---|---|---|
| `<stem>.tables.json` | Expected table grids | `run_benchmark.py score`, `table_metrics.py`, `compare_engines.py` (accuracy columns) |
| `<stem>.gt.txt` | Full correct document text (for CER) | `run_benchmark.py score`, `run_ocr_eval.py` |
| `<stem>.fields.json` | Expected scalar fields, e.g. `{"amount_figures":"2611464676"}` | `run_ocr_eval.py` |

### `<stem>.tables.json`
```json
{
  "type": "pdf",            // pdf | scanned | image | xlsx | docx | xer | mpp | xml
  "source": "MyFile.pdf",
  "verified": true,          // MUST be true — false means the human pass didn't happen
  "tables": [
    { "grid": [ ["Sr","Desc","Qty","Rate","Amount"],
                ["1","Earthwork","100","50","5000"] ] }
  ]
}
```
Empty cells are `""` or `null`. Numbers may be written in any format
(`5000`, `5,000`, `5,000.00`) — the scorer is numeric-tolerant (Indian grouping,
rounding to 0.5%). Put tables in the same order the extractor emits them.

## How to build a golden file (don't hand-type — correct machine output)

1. Pick a sample you can verify. **Digital PDFs/XLSX are ~100% correct**, so their
   extraction is a legitimate gold seed — start there.
2. Run the extractor, then seed:
   ```powershell
   $PY = "C:\Users\admin\pradeep-defect-work\venv2\Scripts\python.exe"
   & $PY table_pdf.py --in "samples\MyFile.pdf" --out "out\" --verify
   & $PY eval\make_golden.py --from "out\MyFile.tables.json" --stem "MyFile" --type pdf
   ```
3. **Open `eval/golden/MyFile.tables.json` and fix every wrong cell** against the
   original document. Set `"verified": true`.
4. For scanned/handwritten files, seed the grid from the **original Excel** (via
   `excel_extract.py`) when one exists — that is the authoritative truth you score the
   scan against (and it's exactly what `reconcile_tables.py` uses in production).

## Target coverage matrix (fill these in)

Aim for at least one verified golden per row:

- [ ] perfect digital PDF (BOQ with Qty·Rate·Amount)
- [ ] messy digital PDF (borderless / multi-line cells / section headers)
- [ ] multi-page table (spans pages, one grand total)
- [ ] scanned PDF (clean, ≥300 DPI)
- [ ] scanned PDF (dense numeric, 150 DPI — the hard floor)
- [ ] image (`.png`/`.jpg`) with a table
- [ ] handwritten / mixed printed+handwritten page
- [ ] rotated / crooked scan
- [ ] engineering / construction report
- [ ] financial statement / invoice / PO / bank statement
- [ ] Excel BOQ (`.xlsx`) — the 100% reference
- [ ] Excel with merged cells / multiple sheets / formulas
- [ ] Primavera P6 export (`.xer`) — activities + relationships
- [ ] MS Project (`.mpp`) — activities + relationships
- [ ] XML

## Available samples (already in `../samples/`)

`Billing Schedule Fabricated Building Structure.xlsx`, `Civil BBU 25.10.25..xlsx`,
`RFIView_Report_20260521_114807.xlsx` (Excel · seed goldens from these first),
`Construction Programme_Jun 24i.xer`, `SP-II-NMDC 20th Mar.xer` (Primavera),
`NMDC_Kirandul_..._Rev 03_....mpp` (MS Project), three scanned NCR letter PDFs,
`Dep-14&11C Network schedule for Oct25.pdf`, `image (1).png`, two `.docx`.
