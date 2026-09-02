# Engine Comparison — current vs docling vs paddle vs vlm (scanned NCR PDFs)

*Server run (Tesla T4). 4 engines on the 3 scanned NCR letter PDFs. current = the rig's
own docTR path (sovereign baseline); docling = IBM (sovereign); paddle = Baidu
(non-sovereign, own venv); vlm = Florence-2 (sovereign, the rig's tie-breaker). This is
a BEHAVIOR + eyeballed-QUALITY comparison — a true accuracy number still needs a
transcribed gold page (see bottom).*

## Results (merged, all 3 files)

| Engine | #tables | tie-out | text conf | seconds | text chars | reading-order / quality |
|---|---|---|---|---|---|---|
| **current** (docTR) | **1** (files 1,3) | PASS | 0.75–0.90 | 60–138 | **highest (4174–4486)** | most raw text, but **jumbled order** + garbles (letter-no "HBT-1648-S0-**ANCR2025109**") |
| **docling** (IBM) | 0 | n/a | – | **8–17 (fast)** | 2680–3472 | **cleanest reading order**; got the letter-no **right** ("HBT-1648-SO-NCR-2025/1049"); markdown; may drop some lines |
| **paddle** (Baidu) | 0 | n/a | **0.96–0.98** | 30–117 | 3678–4228 | competitive quantity, high confidence, faster than current on 2/3 |
| **vlm:florence** | 0 | n/a | – | 1–1.5 | **0 (nothing)** | not a full-page OCR — extracted no text |

## Honest read

1. **These are letters + a form, not table documents** — so nobody finds meaningful
   tables (current found 1 where a form-grid existed). **This is NOT a fair test of
   docling's table strength** — that needs a scanned BOQ (we don't have one in samples).
2. **VLM (Florence-2) is useless as a document OCR here — 0 chars on all 3.** It's built
   into the rig only as a *table tie-breaker*, not a page reader. Don't expect it to
   transcribe letters. (Keep it in its narrow role; don't add it as a doc engine.)
3. **current extracts the MOST raw text** (and the tables + tie-out) — but with the
   **jumbled reading order** and OCR garbles we flagged before (it even mangled the
   letter number).
4. **docling extracts LESS text but of noticeably HIGHER quality** — proper reading
   order (fixes current's interleaved-letterhead problem), clean markdown, and it got the
   letter number **correct** where current garbled it. It's also **~8× faster**. Downside:
   fewer chars → it may drop some detail (needs the gold to confirm).
5. **paddle** is competitive on quantity, high-confidence, faster than current — but no
   clear win here, and it's **non-sovereign**. Reasonable reference, low priority to ship.

## The complementary insight (answers your "use both?" question)
**current and docling are complementary, not redundant:**
- **current** → best *completeness* + the arithmetic tie-out + table detection.
- **docling** → best *reading order / structure / readability* (its layout model beats
  the rig's XY-cut) + much faster.
So an **ensemble** — docling for layout/clean text, current for tables + tie-out — is
genuinely worth considering for scanned *documents* (it directly fixes the jumbled-order
weakness). Paddle/VLM don't earn a spot on this evidence.

## Honest caveats
- **`text chars` is QUANTITY, not QUALITY** — current's higher count partly = it also
  transcribed the photo-page noise. More ≠ better.
- **No true accuracy number yet** — this is behavior + a one-page eyeball, not a measured CER.
- **docling's table strength is untested here** (no real tables in these files).

## Recommendations
1. **Adopt docling for scanned-document reading order / markdown quality** — it clearly
   beats current's XY-cut on these letters and is far faster. (Sovereign, ships freely.)
2. **Test docling + paddle on a scanned BOQ** (table-heavy) to fairly judge table
   extraction — the decision that actually matters for your BOQ workload.
3. **Get a real CER:** take the best engine's text for one page, correct it into
   `eval/golden/<stem>.gt.txt`, then `python run_ocr_eval.py --out out_docs --gold eval/golden`.
4. **Drop VLM as a doc OCR** (0 chars); keep it only as the table tie-breaker it is.
5. **Paddle: keep as a benchmark reference**, low priority to ship (non-sovereign, no clear win here).

## Artifacts
- `eval/reports/engine_compare_merged.md` — the full 4-engine table (this run).
- `eval/reports/scanned_side_by_side.md` — each engine's extracted text, first 900 chars, for eyeballing.
- `eval/reports/engine_compare_scanned.json` / `engine_compare_paddle.json` — raw results.
