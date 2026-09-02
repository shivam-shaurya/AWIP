#!/usr/bin/env python3
r"""
audit_run.py - STRONG post-run audit of a doc_layout output tree. Read-only; stdlib only.
Walks every <stem>/<stem>.layout.json under the given out dir and prints a deep diagnostic so a
human (or Claude) can judge production-readiness: per-file status + element mix, native vs scanned
page coverage + OCR confidence, EVERY money tie-out flag (auto-classified real vs hierarchical-
summary false-positive), scanned-text health snippets, links/QR, and aggregate red flags.

Run:  python audit_run.py C:\Users\admin\out_everything
"""
import sys, json, glob, os, re, csv
from collections import Counter

try: sys.stdout.reconfigure(encoding="utf-8")          # Hindi/Devanagari-safe console
except Exception: pass

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
# recursive: outputs are sharded outroot/<hh>/<hh>/<key>/<stem>.layout.json (collision-safe dirs)
files = sorted(glob.glob(os.path.join(OUT, "**", "*.layout.json"), recursive=True))
if not files:
    print("No *.layout.json under", OUT); sys.exit(0)

# a cell that looks like a SUBTOTAL/grand-total label (the hierarchical-summary signature)
_SUBTOTAL = re.compile(r"(amount\s*\(\s*\d|sub[-\s]?total|grand\s*total|say\b|carried|brought\s*f|total\s*amount|कुल|योग|महायोग)", re.I)

def short(s, n=90):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s[:n] + ("…" if len(s) > n else "")

agg = Counter()
all_flags = []          # (stem, page, flag, classification)
scanned_rows = []       # (stem, page, engine, conf, low, nelems, snippet)
red = []                # red-flag lines

print("=" * 100)
print("PER-FILE SUMMARY")
print("=" * 100)
for f in files:
    try:
        d = json.load(open(f, encoding="utf-8"))
    except Exception as e:
        red.append("CANNOT PARSE %s (%s)" % (os.path.basename(f), e)); continue
    stem = os.path.splitext(os.path.basename(f))[0].replace(".layout", "")
    pages = d.get("pages", [])
    native = sum(1 for p in pages if p.get("route") == "native")
    scanned = sum(1 for p in pages if p.get("route") == "scanned")
    scanned_with_content = sum(1 for p in pages if p.get("route") == "scanned" and p.get("elements"))
    ec = d.get("element_counts", {})
    comp = d.get("completeness", {})
    status = d.get("status", "?")
    agg["files"] += 1; agg[status] += 1
    agg["pages"] += len(pages); agg["native_pages"] += native; agg["scanned_pages"] += scanned
    for k, v in ec.items(): agg["el_" + k] += v
    print("\n%-55s  %s" % (short(stem, 55), status))
    print("   pages=%d (native=%d, scanned=%d[content=%d])  elements=%s"
          % (len(pages), native, scanned, scanned_with_content, dict(ec)))
    if comp.get("reasons"):
        print("   completeness: %s" % "; ".join(comp["reasons"]))
    # collect tie-out flags + classify
    for p in pages:
        for e in p.get("elements", []):
            if e.get("type") == "table":
                grid = e.get("grid", [])
                hierarchical = sum(1 for row in grid for c in row if _SUBTOTAL.search(str(c or ""))) >= 2
                for fl in (e.get("tieout_flags") or []):
                    klass = "LIKELY FALSE-POS (hierarchical summary)" if hierarchical else "LIKELY REAL (flat list)"
                    all_flags.append((stem, p.get("page_no"), fl, klass))
        if p.get("route") == "scanned":
            txt = " ".join(e.get("text", "") for e in p.get("elements", []) if e.get("text"))
            scanned_rows.append((stem, p.get("page_no"), p.get("engine"), p.get("page_conf"),
                                 p.get("low_conf"), len(p.get("elements", [])), short(txt, 110)))
    # red flags
    if len(pages) and all(not p.get("elements") for p in pages):
        red.append("%s: ZERO elements on every page" % short(stem, 40))
    tiny = sum(1 for p in pages for e in p.get("elements", [])
               if e.get("type") == "table" and sum(1 for row in e.get("grid", []) for c in row if str(c or "").strip()) <= 1)
    if tiny: red.append("%s: %d empty/1-cell 'table' fragment(s)" % (short(stem, 40), tiny))
    agg["links"] += len(d.get("links", [])); agg["codes"] += len(d.get("codes", []))

print("\n" + "=" * 100)
print("MONEY TIE-OUT FLAGS (%d total) - the key accuracy signal" % len(all_flags))
print("=" * 100)
for stem, page, fl, klass in all_flags:
    print("\n  [%s p%s] %s" % (short(stem, 40), page, klass))
    print("     label=%r stated=%s sum_of_rows=%s gap=%s tol=%s"
          % (fl.get("total_label"), fl.get("stated"), fl.get("sum_of_rows"), fl.get("gap"), fl.get("tol")))
if not all_flags:
    print("  (none - every extracted table reconciled)")

print("\n" + "=" * 100)
print("SCANNED PAGES (%d) - did OCR actually recover structure?" % len(scanned_rows))
print("=" * 100)
for stem, page, eng, conf, low, n, snip in scanned_rows[:60]:
    print("  [%s p%s] engine=%s conf=%s low=%s elems=%d :: %s"
          % (short(stem, 35), page, eng, conf, low, n, snip))
if len(scanned_rows) > 60:
    print("  … +%d more scanned pages" % (len(scanned_rows) - 60))

print("\n" + "=" * 100)
print("AGGREGATE")
print("=" * 100)
print("  files=%d  | AUTO_ACCEPT=%d  NEEDS_REVIEW=%d"
      % (agg["files"], agg.get("AUTO_ACCEPT", 0), agg.get("NEEDS_REVIEW", 0)))
print("  pages=%d (native=%d, scanned=%d)" % (agg["pages"], agg["native_pages"], agg["scanned_pages"]))
print("  elements: " + ", ".join("%s=%d" % (k[3:], v) for k, v in sorted(agg.items()) if k.startswith("el_")))
print("  links=%d  qr/codes=%d  tie-out flags=%d" % (agg["links"], agg["codes"], len(all_flags)))

print("\n" + "=" * 100)
print("RED FLAGS")
print("=" * 100)
print("\n".join("  - " + r for r in red) if red else "  (none)")

# echo the review queue if present
rp = os.path.join(OUT, "review_pages.csv")
if os.path.exists(rp):
    print("\n" + "=" * 100); print("review_pages.csv (human queue)"); print("=" * 100)
    print(open(rp, encoding="utf-8").read().strip())
