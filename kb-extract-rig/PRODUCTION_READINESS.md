# Production Readiness — kb-extract-rig

*What it takes to run this as a **production service** that accepts multiple-file uploads and
sustains ~1000 files/day. This doc covers the **service / scale / ops** axis. For the
**extraction-accuracy** axis (per-file-type accuracy, calibration, the scanned unknown) see
`eval/reports/PIPELINE_STATUS_AND_ROADMAP.md` — the two are complementary and both must be green
before this is "production."*

> **Honest one-liner:** the extraction **engine** is production-grade for *batch* and can
> realistically do 1000 files/day. But it is a **CLI/batch tool, not a service** — there is no
> upload API, job queue, results database, monitoring, or horizontal scaling. "Upload multiple
> files" and "run daily at scale" is a **service layer that still needs to be built around** the
> engine. **Do not rewrite the engine — wrap it.**

---

## 1. Verdict at a glance

| Question | Answer |
|---|---|
| Can the engine process many files in one run? | ✅ Yes — folder batch, parallel workers, per-file isolation, resume. |
| Is 1000 files/day achievable throughput? | ✅ Yes for the digital mix; ⚠️ GPU-bound for heavy scanned; needs a load test to confirm. |
| Is there an upload endpoint / API / UI? | ❌ No — it reads a folder path on disk. |
| Is there a queue / job orchestration / results DB? | ❌ No — outputs are files + `.done` / `_errors.json` sentinels. |
| Is it monitored, auto-retrying, horizontally scalable? | ❌ No. |
| Has it been load / soak tested? | ❌ No. |
| **Is it a production *service* today?** | **❌ No — it is the production *engine* for one.** |

---

## 2. Readiness scorecard

### A. Extraction engine — mostly READY (details in `PIPELINE_STATUS_AND_ROADMAP.md`)

| Capability | Status | Evidence / note |
|---|---|---|
| Digital PDF / Excel / Word accuracy | ✅ Ready | Measured **content-F1 1.0 / row-acc 1.0** on verified gold |
| Schedules (`.xer` / `.mpp`) | ✅ Ready | Probe-verified on real files (activities, logic, resources, costs) |
| Scanned / OCR accuracy | ⏳ Unproven | No real gold yet; **confidence gate uncalibrated** (needs GPU + ~50 domain pages) |
| Handwriting | ⏳ Not built | Routes to human review by design |
| Batch robustness | ✅ Ready | `--workers`/`--gpu-workers`, per-file `--timeout` kill, `_errors.json` isolation, `.done` resume, atomic + long-path-safe writes, sharded output |
| Never-silent-loss guarantee | ✅ Ready | Money tie-out + review/reconcile routing; failures logged, not dropped |
| Sovereignty | ✅ Ready | docTR / Docling / Florence-2 sovereign; PaddleOCR isolated + labelled |

### B. Production service — NOT built (this is the work)

| Capability | Status | What's needed |
|---|---|---|
| **Ingestion / upload API** | ❌ | HTTP endpoint (e.g. FastAPI) that accepts multi-file uploads → object store / inbox; auth |
| **Job queue + orchestration** | ❌ | Redis/RQ, Celery, or NATS; a worker pool that calls the existing pipeline per file/batch |
| **Job-state + results store** | ❌ | DB (Postgres) for job status/retries/audit; object storage (S3/MinIO) for inputs + outputs |
| **Review / reconcile UI** | ❌ | Surface the HITL review queue + "upload the original Excel" reconcile flow to operators |
| **Monitoring / observability** | ❌ | Metrics (throughput, queue depth, auto-accept rate, GPU util), logs, alerting |
| **Retries / dead-letter / backpressure** | ❌ | Automatic retry policy; rate limiting so uploads can't swamp the GPU |
| **Horizontal scaling** | ❌ | Multiple workers across machines; GPU worker autoscaling |
| **Load / soak testing** | ❌ | Establish real files/hour on the true file mix; find the GPU ceiling |
| **Security / multi-tenancy** | ❌ | AuthN/Z, tenant isolation, secrets management, PII handling of documents |

---

## 3. Throughput analysis — is 1000 files/day realistic?

**Rate:** 1000/day ≈ **1 file every ~1.5 min** (24 h) or **~2 files/min** in an 8-hour window.
That is a *modest* rate — the engine is not the constraint for most mixes.

- **Digital PDF / Excel / Word** → seconds per file on CPU. 1000/day is trivial.
- **Scanned / OCR** → the real bottleneck. OCR runs on the **GPU**, and a single GPU (e.g. Tesla T4)
  processes scanned pages **serially**. A heavy multi-page scan can take seconds-to-minutes. If a
  large fraction of the daily 1000 are dense scans, one GPU may be tight — mitigate with docTR
  **batching** (`--batch`), **windowing** (`--ocr-window`), and adding **GPU workers**.
- **Human review is part of throughput.** Low-confidence scans route to review/reconcile. "1000/day"
  fully-automated is only true to the extent files **auto-accept**; the rest need operator capacity.
  Report **both** numbers: machine auto-accept rate **and** committed (reviewed) accuracy.

**Bottom line:** 1000/day is achievable, but the honest number for *your* file mix comes only from a
**load test** (§5, Phase C) — especially the scanned/GPU share and the resulting review volume.

---

## 4. Target production architecture

Keep the current engine as the **worker**; add a thin service shell around it.

```
   Client / upload
        │  (HTTPS, auth)
        ▼
  ┌─────────────┐     enqueue     ┌───────────┐   pull    ┌────────────────────┐
  │  Upload API │ ───────────────►│   Queue   │ ────────► │  Worker pool        │
  │  (FastAPI)  │                 │ Redis/RQ  │           │  = pipeline.py logic│
  └─────┬───────┘                 │ /NATS     │           │  (CPU + GPU workers)│
        │ store input             └───────────┘           └─────────┬──────────┘
        ▼                                                            │ results
  ┌──────────────┐                                        ┌─────────▼──────────┐
  │ Object store │◄───────────────────────────────────────│ Results DB (jobs,  │
  │ (S3 / MinIO) │   outputs (layout.json/.md/.xlsx),      │ status, retries,   │
  └──────────────┘   review + reconcile queues            │ audit) + Review UI │
                                                           └────────────────────┘
   Cross-cutting: metrics + logs + alerting · auth/multi-tenancy · rate limiting/backpressure
```

**Principle:** the extraction logic (routing, tie-out, OCR ladder, reconcile) is the hard part and
is already built and hardened. The service layer is standard plumbing. **Wrap, don't rewrite.**

---

## 5. Roadmap — do it in this order

**Phase A — Validate the engine (NOW, before any scaling).**
Building a 1000/day service before accuracy is proven means scaling an unvalidated number.
- [ ] Run this testing round on the GPU box against real documents.
- [ ] Produce a **real scanned-accuracy number** + **calibrate the confidence gate**
      (`run_ocr_eval.py --calibrate`, ≥50 domain pages + gold — see `README.md` §6, `eval/golden/README.md`).
- **Exit:** scanned path has a measured accuracy + a fitted gate; digital/schedule already green.

**Phase B — Service shell (makes "upload multiple files" real).**
- [ ] FastAPI upload endpoint (multi-file) → object storage inbox; basic auth.
- [ ] Queue (Redis/RQ or NATS) + a worker that calls the existing pipeline per job.
- [ ] Results DB (Postgres) for job status/retries/audit; expose the review + reconcile queues.
- **Exit:** a file uploaded via API is processed and its result + review status is queryable.

**Phase C — Scale & ops (makes "1000/day" real and observable).**
- [ ] **Load / soak test** on the true file mix → real files/hour, GPU ceiling, review volume.
- [ ] GPU worker autoscaling; docTR batching/windowing tuned from the load test.
- [ ] Monitoring (throughput, queue depth, auto-accept rate, GPU util), logs, alerting.
- [ ] Retry policy + dead-letter + rate limiting/backpressure.
- **Exit:** sustains the target rate with headroom; alerts fire before saturation.

**Phase D — Hardening (before untrusted / multi-tenant traffic).**
- [ ] AuthN/Z + tenant isolation; secrets management; document PII handling/retention.
- [ ] Security review (upload validation — the zip-bomb guard exists; extend to the service edge).
- **Exit:** passes a security review; safe for multi-tenant production.

---

## 6. Open decisions / dependencies

- **GPU capacity:** how many GPUs, and the real scanned share of the daily 1000 (drives Phase C sizing).
- **Sync vs async delivery:** do callers wait for results, or poll/webhook? (Async fits a queue model.)
- **Where the review UI lives:** standalone, or integrated into an existing operator tool.
- **Domain gold:** Phase A calibration is blocked on ~50 real scanned pages + ground truth from the team.
- **Sovereignty stance at the service edge:** confirm PaddleOCR stays isolated/opt-in in the deployed image.

---

*This document tracks the SERVICE/SCALE gap. Update it as phases complete. The engine's
extraction-accuracy state is tracked separately in `eval/reports/PIPELINE_STATUS_AND_ROADMAP.md`.*
