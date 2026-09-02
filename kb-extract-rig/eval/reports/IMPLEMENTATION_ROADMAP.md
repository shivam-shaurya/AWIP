# Implementation Roadmap — Multi-Engine Extraction (post-comparison plan)

*The consolidated forward plan after the server run + the 4-engine comparison. Encodes
the final architecture decisions: route by input type, docling for scanned text/layout,
keep pdfplumber+tie-out for digital tables, paddle as a low-confidence FALLBACK only,
VLM as a table tie-breaker only, HITL as the final backstop.*

---

## 1. Guiding principles (apply to every phase)
- **Route by input type** — digital and scanned use different engines (see §2).
- **Everything feeds the arithmetic tie-out** (`verify_table`) — no engine bypasses it.
- **Digital path stays byte-identical** — all new engines are opt-in, default off.
- **Measure before shipping** — a gold set is the referee; nothing ships on assumption.
- **Sovereign-first** — docling + current ship freely; paddle is a flagged fallback
  (non-sovereign); VLM stays a narrow table tie-breaker.
- **Cascade for cost** — the expensive multi-engine path runs only on hard/scanned pages,
  never on every document.

## 2. Final target architecture

### Route by input type
| Input | Text / reading-order | Tables | Verify |
|---|---|---|---|
| **Digital PDF** (has text layer) | fitz atomize (current) | **pdfplumber / robust_tables** (KEEP — best) | tie-out |
| **Scanned PDF / image** (no text layer) | **docling** (measured win) | docling TableFormer + current OCR-table | tie-out |
| **Excel / DOCX** | direct read (current) | direct read | tie-out (Schedule-H) |
| **XER / MPP** | schedule_mpxj (proven) | — | integrity checks |

> pdfplumber/PyMuPDF are already the digital backbone and are the *right* tool there —
> docling does NOT replace them. docling is only for the scanned case where they can't work.

### The scanned escalation ladder (the accuracy + cost design)
```
Scanned page
  1. docling (text/reading-order)  +  current (tables + tie-out)
  2. RECONCILE  → confidence = engine agreement (calibrated)
        ├─ confidence ≥ gate  →  ACCEPT ✅
        └─ confidence < gate  →  escalate ↓
  3. PADDLE fallback — runs ONLY on this low-confidence page (cheap, targeted)
        └─ re-reconcile → confidence
              ├─ ≥ gate  →  ACCEPT (flagged "paddle-assisted / non-sovereign")
              └─ < gate  →  HUMAN REVIEW / request original Excel 🧑
```
Engine roles: **current** = completeness + tables + tie-out · **docling** = clean
text/layout (+ scanned tables) · **paddle** = low-confidence last resort · **VLM** =
table tie-breaker only (extracted 0 text as a doc OCR — not in this ladder).

---

## 3. Phased implementation

### Phase 0 — Gold set *(do FIRST; unblocks all measurement)*
- Transcribe **1–2 scanned pages** → `eval/golden/<stem>.gt.txt` (+ `.tables.json` if a table).
- Add **1 scanned BOQ** (table-heavy — from source Excel or transcription).
- Reuse the 4 existing digital goldens.
- **GPU:** no · **Effort:** ~1–2 hrs (manual) · **Gate:** none (this IS the referee).

### Phase 1 — Wire docling into the scanned path *(bank the measured win)*
- Promote `docling_extract` from eval-only → an opt-in **scanned engine** (`--scanned-engine docling`), for text + reading order. Digital path untouched.
- **Validate:** docling vs current CER on the gold.
- **GPU:** yes · **Effort:** ~1 day · **Gate:** CER/quality ≥ current on the gold.

### Phase 2 — Reconcile ensemble + paddle fallback *(the accuracy lever)*
- New `ensemble_extract.py`: docling = text backbone, current = tables + tie-out,
  **agreement = confidence** (disagreement → review). One output → `verify_table`.
- **Add the paddle fallback tier** (§2 ladder): paddle runs only when reconciled
  confidence < gate; output flagged non-sovereign; still < gate → HITL / request Excel.
- **Validate:** ensemble vs current vs docling on the gold; measure how often paddle
  fallback actually lifts a low-conf page above the gate (drop paddle if it rarely helps).
- **GPU:** yes · **Effort:** ~3–4 days · **Gate:** measured accuracy gain over the best single engine.

### Phase 3 — Scanned-table bake-off (the BOQ test)
- On the scanned BOQ from Phase 0: docling TableFormer + current OCR-table + tie-out.
- **Decides** docling's *table* value for the real BOQ workload (the NCR letters couldn't test it — no real tables).
- **GPU:** yes · **Effort:** ~½ day · **Gate:** table cell/row/col F1 on the gold BOQ.

### Phase 4 — Calibration + cost/ops *(production-safe)*
- **Calibrate the gate** on the gold (`run_ocr_eval.py --calibrate`, ECE) → trustworthy
  "confidence < gate" decisions (the ladder depends on this).
- **Cascade:** ensemble + paddle fallback fire only on low-confidence/scanned pages.
- Ops: `pull_results.sh` helper; assign an **Elastic IP** (server IP stops changing);
  enable the dormant CI if the repo is ever git-init'd.
- **GPU:** mixed · **Effort:** ~1 day.

### Phase 5 — Schedule P1 *(parallel, independent track)*
- Extend `schedule_mpxj`: resources / assignments / costs + calendar working-time (all
  confirmed available by the probe); guard multi-project `.xer`.
- **GPU:** no (JVM only) · **Effort:** ~1–2 days.

---

## 4. Sequencing
**Phase 0 → Phase 1 → Phase 3 (quick check) → Phase 2 → Phase 4.** Phase 5 runs in parallel anytime.

**Immediate next step:** Phase 0 (gold set) + Phase 1 (wire docling) — banks docling's
clear win *with proof*.

## 5. Honest caveats
- The paddle fallback only helps if it beats docling+current on the *hard* pages —
  validate it recovers something before keeping it.
- "confidence < gate" is meaningful only after calibration (Phase 4).
- docling's table strength is still unproven (Phase 3 tests it).
- Every OCR/paddle number feeds the tie-out and is never auto-trusted for financials.
- This is a real code change (the "update the code" step) — scoped to opt-in engines +
  a reconcile layer; the digital path and the tie-out are untouched.

## 6. What ships at the end
- Digital: unchanged (pdfplumber/robust_tables + tie-out — already ~100%).
- Scanned: **docling text/layout + current tables/tie-out, reconciled; paddle fallback on
  low-confidence; HITL/request-Excel as the backstop** — measurably better than today, proven on the gold.
- Schedule: richer field coverage (P1).
- All gated, all verified, all measured.
