#!/usr/bin/env python3
r"""
run_ocr_eval.py - measure the rig honestly against a gold set.

Gold layout (you create this once):
  gold/<stem>.gt.txt        # ground-truth full text of the document (for CER)
  gold/<stem>.fields.json   # {"amount_figures":"2611464676","pan":"ABCDE1234F"} (for field accuracy)
Both files are optional per doc - provide whichever you have.

Reads the rig's output (out/<stem>/<stem>.doc.json + .chunks.jsonl) and reports:
  - CER (character error rate) vs gt.txt
  - field accuracy vs fields.json
  - auto-accept rate (from out/run_summary.json)

Run:  python run_ocr_eval.py --out out\ --gold gold\
"""
import argparse, json, re
from pathlib import Path

try:
    from rapidfuzz.distance import Levenshtein
    def lev(a, b): return Levenshtein.distance(a, b)
except Exception:
    def lev(a, b):
        # tiny DP fallback
        m, n = len(a), len(b)
        d = list(range(n + 1))
        for i in range(1, m + 1):
            prev, d[0] = d[0], i
            for j in range(1, n + 1):
                cur = d[j]
                d[j] = min(d[j] + 1, d[j-1] + 1, prev + (a[i-1] != b[j-1]))
                prev = cur
        return d[n]

def norm(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())

def text_from_chunks(chunks_path):
    if not chunks_path.exists(): return ""
    out = []
    for line in chunks_path.read_text(encoding="utf-8").splitlines():
        try: out.append(json.loads(line).get("text", ""))
        except Exception: pass
    return "\n".join(out)

# ============================================================================
# LEVER F - confidence calibration (pure math; makes the 0.70 gate predict real error)
# ============================================================================
def reliability_table(pairs, n_bins=10):
    """pairs = [(reported_conf, is_error)]. Bin reported confidence into n_bins over [0,1] and,
    per bin, report (count, mean reported conf, observed error rate). ECE = sample-weighted
    |mean_conf - observed_accuracy| (0 = perfectly calibrated). Pure - unit-testable, no OCR."""
    ps = [(float(c), bool(e)) for c, e in pairs if c is not None]
    N = len(ps)
    bins = []
    for b in range(n_bins):
        lo, hi = b / n_bins, (b + 1) / n_bins
        sel = [(c, e) for c, e in ps if (lo <= c < hi) or (b == n_bins - 1 and c >= hi)]
        if not sel:
            bins.append({"bin": [round(lo, 3), round(hi, 3)], "count": 0, "mean_conf": None, "error_rate": None})
            continue
        cnt = len(sel); mc = sum(c for c, _ in sel) / cnt; er = sum(1 for _, e in sel if e) / cnt
        bins.append({"bin": [round(lo, 3), round(hi, 3)], "count": cnt,
                     "mean_conf": round(mc, 4), "error_rate": round(er, 4)})
    ece = (sum((bb["count"] / N) * abs(bb["mean_conf"] - (1 - bb["error_rate"]))
               for bb in bins if bb["count"]) if N else None)
    return {"bins": bins, "n": N, "ece": round(ece, 4) if ece is not None else None}

def fit_calibration(pairs, target_err=0.05, min_samples=50, n_bins=10):
    """Recommend a gate: the LOWEST reported-conf threshold g at which the aggregate error of
    everything auto-accepted (conf >= g) is <= target_err. Refuses (keeps the default 0.70) below
    min_samples - calibrating on a tiny gold set overfits, and a curve is per-engine/per-DPI."""
    rt = reliability_table(pairs, n_bins)
    base = {"bins": rt["bins"], "ece": rt["ece"], "n": rt["n"]}
    if rt["n"] < min_samples:
        return {**base, "recommended_gate": 0.70,
                "note": f"only {rt['n']} samples (< {min_samples}) - keep the default 0.70 gate (overfit guard)"}
    best = None
    for g in sorted({round(float(c), 3) for c, _ in pairs if c is not None}):
        sub = [(c, e) for c, e in pairs if c is not None and float(c) >= g]
        if sub and (sum(1 for _, e in sub if e) / len(sub)) <= target_err:
            best = g; break
    if best is None:
        return {**base, "recommended_gate": 0.70,
                "note": f"no threshold reaches error <= {target_err} - keep 0.70 and review more"}
    sub = [(c, e) for c, e in pairs if c is not None and float(c) >= best]
    return {**base, "recommended_gate": best,
            "note": f"auto-accept at conf >= {best} -> error {sum(1 for _, e in sub if e)/len(sub):.3f} "
                    f"<= {target_err} over {len(sub)} samples"}

def calibrate_confidence(out_dir, gold_dir, *, target_err=0.05, n_bins=10, cer_err=0.03):
    """Harvest (reported overall_confidence, is_error) over every doc that has a gold file, fit
    the calibration, persist it to <out_dir>/calibration.json, and print the recommended gate
    next to the current 0.70. is_error := page/doc CER > cer_err OR any gold field mismatched.
    File plumbing is laptop-testable with a hand-written doc.json + gold fixture (no OCR)."""
    out, gold = Path(out_dir), Path(gold_dir)
    pairs = []
    for docjson in out.rglob("*.doc.json"):
        stem = docjson.name[:-len(".doc.json")]
        doc = json.loads(docjson.read_text(encoding="utf-8"))
        conf = doc.get("overall_confidence")
        if conf is None:
            continue
        err = None
        gt = gold / f"{stem}.gt.txt"
        if gt.exists():
            pred = norm(text_from_chunks(docjson.parent / f"{stem}.chunks.jsonl"))
            truth = norm(gt.read_text(encoding="utf-8"))
            if truth:
                err = (lev(pred, truth) / len(truth)) > cer_err
        gf = gold / f"{stem}.fields.json"
        if gf.exists():
            want = json.loads(gf.read_text(encoding="utf-8")); got = doc.get("fields", {})
            mism = any(norm(str(got.get(k, {}).get("value", ""))) != norm(str(v)) for k, v in want.items())
            err = mism if err is None else (err or mism)
        if err is not None:
            pairs.append((conf, err))
    fit = fit_calibration(pairs, target_err=target_err, n_bins=n_bins)
    (out / "calibration.json").write_text(json.dumps(fit, indent=2), encoding="utf-8")
    print("\n=== Confidence calibration (LEVER F) ===")
    for bb in fit["bins"]:
        if bb["count"]:
            print(f"  conf {bb['bin']}  n={bb['count']:4}  mean_conf={bb['mean_conf']}  error_rate={bb['error_rate']}")
    print(f"  ECE={fit['ece']}  samples={fit['n']}")
    print(f"  RECOMMENDED GATE = {fit['recommended_gate']}  (current default 0.70) - {fit['note']}")
    print(f"  -> {out/'calibration.json'}  (set conf_calibration_path to use it; do NOT apply blindly)")
    return fit

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--gold", required=True)
    ap.add_argument("--calibrate", action="store_true",
                    help="LEVER F: fit confidence calibration from doc.json confidence vs gold error -> calibration.json")
    ap.add_argument("--target-err", dest="target_err", type=float, default=0.05)
    a = ap.parse_args()
    out = Path(a.out); gold = Path(a.gold)
    if a.calibrate:
        calibrate_confidence(out, gold, target_err=a.target_err); return

    cer_rows = []; field_rows = []
    for docjson in out.rglob("*.doc.json"):
        stem = docjson.name[:-len(".doc.json")]
        doc = json.loads(docjson.read_text(encoding="utf-8"))
        # ---- CER ----
        gt = gold / f"{stem}.gt.txt"
        if gt.exists():
            pred = norm(text_from_chunks(docjson.parent / f"{stem}.chunks.jsonl"))
            truth = norm(gt.read_text(encoding="utf-8"))
            if truth:
                cer = lev(pred, truth) / len(truth)
                cer_rows.append((stem, doc.get("doc_class"), round(cer, 4)))
        # ---- field accuracy ----
        gf = gold / f"{stem}.fields.json"
        if gf.exists():
            want = json.loads(gf.read_text(encoding="utf-8"))
            got = doc.get("fields", {})
            for k, exp in want.items():
                pred = got.get(k, {}).get("value", "")
                ok = norm(str(pred)) == norm(str(exp))
                field_rows.append((stem, k, ok, str(exp), str(pred)))

    print("=== CER (lower is better; target <=0.03 printed / <=0.08 handwriting) ===")
    for stem, dc, cer in sorted(cer_rows, key=lambda x: -x[2]):
        print(f"  {cer:6.3f}  {dc:12} {stem}")
    if cer_rows:
        mean = sum(c for _, _, c in cer_rows) / len(cer_rows)
        print(f"  MEAN CER = {mean:.4f}  over {len(cer_rows)} docs")

    print("\n=== Field accuracy ===")
    if field_rows:
        ok = sum(1 for *_, b, _, _ in [(s,k,b,e,p) for s,k,b,e,p in field_rows] if b)
        for stem, k, good, exp, pred in field_rows:
            mark = "OK " if good else "XX "
            print(f"  {mark} {stem} . {k}: expected '{exp}'  got '{pred}'")
        print(f"  FIELD ACCURACY = {ok}/{len(field_rows)} = {ok/len(field_rows):.3f}")
    else:
        print("  (no gold/*.fields.json provided)")

    rs = out / "run_summary.json"
    if rs.exists():
        s = json.loads(rs.read_text(encoding="utf-8"))
        print(f"\n=== Throughput (from run_summary.json) ===")
        print(f"  files={s['files']}  auto_accept_rate={s['auto_accept_rate']}  "
              f"sent_to_review={s['sent_to_review']}  gate={s['gate']}")
    print("\nReport BOTH: committed accuracy (the reviewed truth) AND auto_accept_rate (machine's solo share).")

if __name__ == "__main__":
    main()
