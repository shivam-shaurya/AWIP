#!/usr/bin/env python3
r"""
table_pdf.py - production PDF table extractor with a row-COMPLETENESS guarantee.

Per page, auto-routed:
  - DIGITAL page -> robust_tables.extract_page(): reconstruct tables from the PDF's
    REAL geometry (every word + the actual ruling lines). Because every word is
    PLACED into a cell, no heuristic 'table detector' can silently drop a row.
    Handles: multi-table pages (segmented), borderless tables, multi-line cells,
    section-header rows, empty cells. A COMPLETENESS AUDIT flags any in-table word
    that did not land in a cell (a possible dropped row).
  - IMAGE page (scanned) -> render @ --dpi and OCR (img2table + Tesseract).

Then:
  - STITCH continued tables across pages (but NOT when the previous table already
    ended in a Total/100% row - so distinct tables are never merged).
  - VERIFY (--verify): generalized tie-out - for every table, SUM(component rows)
    must equal a stated Total/Amount/Grand/Say/sub-total (and %-blocks must sum to
    100); any gap is written to a VERIFY sheet WITH THE EXACT AMOUNT. Plus every
    completeness-audit orphan is listed. => you fix only what is flagged.

GENERAL, never hardcoded to any document. Output: one .xlsx, one sheet per table
(`_txt` exact / `_ocr` OCR'd) + a VERIFY sheet.

Run:
  python table_pdf.py --in "file.pdf" --out tables.xlsx --verify
  python table_pdf.py --in folder\ --out out_dir\ --verify
"""
import argparse, json, os, re, shutil, sys, tempfile
from pathlib import Path

try: import pdfplumber
except Exception: pdfplumber = None
try: import openpyxl
except Exception: openpyxl = None
try: import fitz
except Exception: fitz = None
try: import robust_tables as RT
except Exception: RT = None
try: import scanned_tables as ST          # LEVER B: per-cell numeric-whitelist OCR (opt-in)
except Exception: ST = None
import common   # leaf module (no heavy deps); must sit next to this file

def _load_ocr(lang):
    from img2table.document import Image as I2TImage
    from img2table.ocr import TesseractOCR
    if not shutil.which("tesseract"):
        for p in [r"C:\Program Files\Tesseract-OCR\tesseract.exe",
                  r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"]:
            if Path(p).exists():
                os.environ["PATH"] += os.pathsep + str(Path(p).parent); break
    return I2TImage, TesseractOCR(n_threads=4, lang=lang)

def _page_tmpdir(out_xlsx, src):
    """A per-FILE unique temp dir for scanned-page rasters (H1). The old shared 'out/_pages' meant two
    parallel workers wrote AND read the SAME 'p{N}.png' and could OCR each other's page (silent cross-
    file contamination); mkdtemp guarantees a fresh dir even for two source files with the same stem.
    The caller shutil.rmtree's it in a finally, so nothing is left behind."""
    prefix = "_pages_" + common.safe_name(Path(src).stem)[:32] + "_"
    return Path(tempfile.mkdtemp(prefix=prefix, dir=str(Path(out_xlsx).parent)))

def _xlsx_safe(v):
    """FIX 3 - CSV/formula-injection guard for openpyxl writes: if a cell's value is a STRING starting
    with = + - or @ (which Excel would EXECUTE on open), prefix a single quote so it is inert TEXT.
    Numbers and other types are returned UNCHANGED (a real numeric -500 stays a number); only a value
    written as TEXT starting with those chars is sanitized."""
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@"):
        return "'" + v
    return v

def page_is_digital(page, cfg=None):
    """A page is digital iff its extractable text meets the shared min-text gate (common.is_native_text,
    reading cfg.min_text). ONE definition rig-wide so table_pdf agrees with pdf_extract/doc_layout."""
    return common.is_native_text(page.extract_text() or "", cfg)

def ocr_tables(fitz_page, dpi, tmp_png, I2TImage, ocr):
    r = fitz_page.rect                                       # clamp long edge -> no multi-GB pixmap (A0/600-DPI)
    long_px = (max(r.width, r.height) / 72.0) * dpi
    if long_px > 8000: dpi = max(72, int(dpi * 8000 / long_px))
    pm = fitz_page.get_pixmap(dpi=dpi); pm.save(tmp_png)
    tabs = I2TImage(tmp_png).extract_tables(ocr=ocr, implicit_rows=True,
                                            borderless_tables=False, min_confidence=50)
    out = []
    for t in tabs:
        rows = []
        for r in sorted(t.content):
            cells = t.content[r]
            # img2table 2.x returns each row as a LIST of TableCell; older versions a
            # {col: cell} dict. Handle both (a TableCell is not sortable/keyable).
            cell_list = cells if isinstance(cells, list) else [cells[k] for k in sorted(cells)]
            rows.append(["" if (c is None or getattr(c, "value", None) is None) else str(c.value)
                         for c in cell_list])
        out.append(rows)
    return out

# ============================================================================
# CROSS-PAGE STITCH  (don't merge a table that already finished with a total)
# ============================================================================
def _ncols(rows): return max((len(r) for r in rows), default=0)

def _ends_in_total(rows):
    for row in reversed(rows):
        if any(str(c).strip() for c in row):
            return common.contains_total_kw(" ".join(str(c) for c in row))   # bilingual, one definition
    return False

def _is_repeated_header(first_row, header):
    a = [str(c).strip().lower() for c in first_row if str(c).strip()]
    b = [str(c).strip().lower() for c in header if str(c).strip()]
    return bool(a) and bool(b) and a == b

def stitch(items):
    """items: (page, mode, rows). Merge a continuation into the previous table when
    columns match AND the previous table did not already end in a Total row."""
    out = []
    for pno, mode, rows in items:
        if out:
            ppno, pmode, prows = out[-1]
            cont = (pno - ppno == 1 and mode == pmode and _ncols(rows) == _ncols(prows)
                    and _ncols(rows) >= 2 and not _ends_in_total(prows))
            if cont:
                start = rows[1:] if (rows and _is_repeated_header(rows[0], prows[0])) else rows
                prows.extend(start); out[-1] = (ppno, pmode, prows)
                print("  [stitched page %d into page %d]" % (pno, ppno)); continue
        out.append((pno, mode, list(rows)))
    return out

# ============================================================================
# GENERALIZED VERIFY  (subtotals / grand totals / %-sum-to-100, varied labels)
# ============================================================================
_num = common.parse_number          # shared parser
verify_table = common.verify_table  # THE money tie-out now lives in common (one definition); aliased
_verify_col = common._verify_col    # for back-compat with anything importing them from table_pdf

_emit_worthy = common.emit_worthy   # the >1-data-cell fragment filter now lives in common (one def); aliased

def _repair_ocr_grid(rows, cfg=None):
    """LEVER C driver: digit-correct an OCR'd grid using each row's Qty*Rate=Amount as the oracle
    (common.repair_row_arithmetic). Returns (corrected_rows, fix_flags). Every accepted fix and
    every refused-ambiguous row is surfaced as a 'digit_fix' flag so a human spot-checks it -
    a repaired table is never a silent AUTO_ACCEPT. No-op unless cfg.digit_correct and the grid
    has inferable qty+rate+amount columns."""
    if not common._cfg_get(cfg, "digit_correct", True):
        return rows, []
    cols = common.infer_amount_columns(rows)
    if not all(k in cols for k in ("qty", "rate", "amount")):
        return rows, []
    out, fixes = [], []
    for n, r in enumerate(rows):
        patched, rf = common.repair_row_arithmetic(r, cols)
        out.append(patched)
        for f in rf:
            if f.get("ambiguous"):
                fixes.append({"total_label": "row %d: AMBIGUOUS digit fix - verify by hand" % (n + 1),
                              "stated": f["old"], "sum_of_rows": str(f.get("candidates", "")),
                              "gap": "AMBIGUOUS", "kind": "digit_fix"})
            else:
                fixes.append({"total_label": "row %d: digit-fixed col %d '%s'->'%s'"
                              % (n + 1, f["col"], f["old"], f["new"]),
                              "stated": f["old"], "sum_of_rows": f["new"], "gap": "FIXED", "kind": "digit_fix"})
    return out, fixes

# ============================================================================
# PER-FILE
# ============================================================================
def extract_pdf_tables(src, out_xlsx, dpi, lang, min_text, do_verify, cfg=None):
    wb = openpyxl.Workbook(); wb.remove(wb.active)
    I2TImage = ocr = None
    tmpdir = None; n_txt = n_ocr = n_err = n_drop = n_merge = 0    # tmpdir = per-file, created on first OCR page
    items = []; orphan_flags = []
    doc = fitz.open(src)
    enc = common.encrypted_reason(doc)             # M4: encrypted -> route to review (pdfplumber.open would crash)
    if enc:
        doc.close()
        stem = Path(src).stem
        st = {"file": str(src), "stem": stem, "status": "NEEDS_REVIEW", "reasons": enc,
              "needs_review": True, "tables": 0, "fragments_skipped": 0, "digital_pages": 0,
              "ocr_pages": 0, "errored_pages": 0, "dropped_pages": 0, "sig_orphans": 0,
              "tieout_gaps": 0, "digit_fixes": 0, "borderless_merged_rows": 0, "orphans_total": 0}
        try:
            common.atomic_write_text(out_xlsx.parent.joinpath(stem + ".status.json"),
                                     json.dumps(st, indent=2, ensure_ascii=False))
        except Exception:
            pass
        print("[skip] %s: %s" % (Path(src).name, enc), file=sys.stderr)
        return st
    try:
        with pdfplumber.open(src) as pdf:
            for i, page in enumerate(pdf.pages, 1):
                try:                                       # per-PAGE isolation: one bad page never kills the file
                    if page_is_digital(page, cfg):             # shared min-text gate (cfg.min_text; min_text arg superseded)
                        tabs, audit = RT.extract_page(page)
                        for t in tabs:
                            if t["grid"]: items.append((i, "txt", t["grid"]))
                        for o in audit["orphans_in_table_region"]:
                            orphan_flags.append({"page": i, **o})
                        n_merge += audit.get("borderless_merged_rows", 0)   # 1.5: undetectable row merges
                        n_txt += 1; nt = len(tabs)
                    else:
                        nt = 0; used_cell = False
                        # LEVER B: per-cell numeric-whitelist OCR (opt-in). Falls back to img2table on a
                        # degenerate grid or any failure, so scanned_cell_ocr=False stays byte-for-byte today.
                        if common._cfg_get(cfg, "scanned_cell_ocr", False) and ST is not None:
                            try:
                                res = ST.ocr_scanned_page(doc[i-1], dpi, lang,
                                        common._cfg_get(cfg, "numeric_whitelist", "0123456789.,()-/"),
                                        common._cfg_get(cfg, "cell_ocr_psm", 7))
                                if not res["degenerate"]:
                                    for t in res["tables"]:
                                        if t["grid"]: items.append((i, "ocr", t["grid"]))
                                    nt = len(res["tables"]); n_ocr += 1; used_cell = True
                            except Exception as e:
                                print("  [page %d: cell-OCR failed (%s) - img2table]" % (i, e), file=sys.stderr)
                        if not used_cell:
                            if ocr is None:
                                try: I2TImage, ocr = _load_ocr(lang)
                                except Exception as e:
                                    print("  [page %d: image, OCR unavailable - %s]" % (i, e), file=sys.stderr)
                                    n_drop += 1; continue   # a page we could NOT extract -> completeness signal
                            if tmpdir is None:
                                tmpdir = _page_tmpdir(out_xlsx, src)   # per-FILE unique (no cross-worker collision)
                            tabs = ocr_tables(doc[i-1], dpi, str(tmpdir / ("p%d.png" % i)), I2TImage, ocr)
                            for t in tabs: items.append((i, "ocr", t))
                            n_ocr += 1; nt = len(tabs)
                    print("  page %3d: %s  %d table(s)" % (i, "DIGITAL" if (n_ocr == 0 or items and items[-1][1] == "txt") else "OCR", nt))
                except KeyboardInterrupt:
                    raise
                except Exception as e:
                    n_err += 1                              # a page that errored -> completeness signal
                    print("  page %3d: ERROR (%s: %s) - skipped" % (i, type(e).__name__, e), file=sys.stderr)
    finally:
        doc.close()
        if tmpdir is not None:
            shutil.rmtree(str(tmpdir), ignore_errors=True)   # H1: always remove this file's page rasters

    items = stitch(items)
    flags_all = []; n_emit = 0; n_skip = 0
    for k, (pno, mode, rows) in enumerate(items, 1):
        digit_fixes = []
        if mode == "ocr":                          # LEVER C: only OCR'd grids get digit-repair
            rows, digit_fixes = _repair_ocr_grid(rows, cfg)
        if not _emit_worthy(rows):                 # skip empty page-frame boxes / lone-title fragments
            n_skip += 1; continue                  # (<=1 data cell can't be a table or hold a dropped row)
        n_emit += 1
        ws = wb.create_sheet(("P%d_T%d_%s" % (pno, k, mode))[:31])
        for row in rows: ws.append([_xlsx_safe(c) for c in row])   # sanitize formula-injection on write (FIX 3)
        if do_verify:
            for f in verify_table(rows, cfg, flag_unverified=True):
                f["table"] = ws.title; flags_all.append(f)
            for f in digit_fixes:
                f["table"] = ws.title; flags_all.append(f)

    if do_verify:
        vs = wb.create_sheet("VERIFY", 0)
        vs.append(["check", "table/page", "label/text", "stated", "sum/found", "GAP"])
        for f in flags_all:
            vs.append([_xlsx_safe(x) for x in (f.get("kind", "arithmetic"), f["table"], f["total_label"],
                       f["stated"], f["sum_of_rows"], f["gap"])])                # FIX 3: sanitize flag text too
        for o in orphan_flags:
            vs.append([_xlsx_safe(x) for x in ("dropped-row?", "page %d" % o["page"], o["text"], "",
                       "x=%d y=%d" % (o["x"], o["y"]), "")])                     # FIX 3: orphan text is doc-controlled
        if not flags_all and not orphan_flags:
            vs.append(["OK", "(all tables reconcile; no unplaced rows)", "", "", "", ""])

    if not wb.sheetnames: wb.create_sheet("no_tables_found")
    wb.save(common._fs_path(out_xlsx))              # R14: long-path safe on a deep sharded output dir
    # COMPLETENESS verdict (C2): significant (digit-bearing) orphans = likely dropped DATA rows;
    # tie-out gaps, errored & un-extractable pages all force review. Written as a sidecar so the
    # folder run can split committed vs withheld.
    sig_orphans = sum(1 for o in orphan_flags if o.get("significant"))
    n_digit_fix = sum(1 for f in flags_all if f.get("kind") == "digit_fix")   # lever C audit count
    n_not_verified = sum(1 for f in flags_all if f.get("kind") == "not_verified")   # amounts, no total to check
    n_merged_cell = sum(1 for f in flags_all if f.get("kind") == "merged_cell")     # FIX 1: collapsed-row cell(s)
    real_gaps = len(flags_all) - n_digit_fix - n_not_verified - n_merged_cell  # actual reconcile FAILURES only
    extra = []
    if n_merge: extra.append(f"{n_merge} borderless row(s) may have collapsed (1.5) - verify those tables")
    if n_merged_cell: extra.append(f"{n_merged_cell} cell(s) hold >=2 numbers (possible collapsed/merged row) - verify")
    if n_digit_fix: extra.append(f"{n_digit_fix} OCR digit(s) auto-repaired/ambiguous via arithmetic - spot-check")
    if n_not_verified: extra.append(f"{n_not_verified} table(s) have amounts but NO total row - arithmetic NOT verified")
    status, reasons = common.completeness_status(
        sig_orphans=sig_orphans, tieout_gaps=real_gaps, dropped_pages=n_drop,
        errored_pages=n_err, extra_reasons=extra)
    stem = Path(src).stem
    st = {"file": str(src), "stem": stem, "status": status, "reasons": ";".join(reasons),
          "needs_review": status == "NEEDS_REVIEW", "tables": n_emit, "fragments_skipped": n_skip,
          "digital_pages": n_txt, "ocr_pages": n_ocr, "errored_pages": n_err,
          "dropped_pages": n_drop, "sig_orphans": sig_orphans, "tieout_gaps": real_gaps,
          "digit_fixes": n_digit_fix, "borderless_merged_rows": n_merge, "orphans_total": len(orphan_flags)}
    try:
        common.atomic_write_text(out_xlsx.parent.joinpath(stem + ".status.json"),   # R14: atomic + long-path safe
                                 json.dumps(st, indent=2, ensure_ascii=False))
    except Exception:
        pass
    msg = "[done] %s: %d tables (%d fragments skipped) (%d digital, %d OCR pages) [%s]" % (
        Path(src).name, n_emit, n_skip, n_txt, n_ocr, status)
    if do_verify: msg += " | VERIFY: %d arithmetic + %d orphan flag(s)" % (len(flags_all), len(orphan_flags))
    print(msg + " -> %s" % out_xlsx)
    return st

def _tp_worker(path, args):
    """Top-level (picklable) per-file worker for parallel_foreach. table_pdf's OCR fallback is
    CPU Tesseract (no GPU), so files fan out across processes freely."""
    cfg = common.ExtractConfig(**args["cfg"])
    out = Path(args["out"]); p = Path(path)
    docdir = common.doc_outdir(out, p); docdir.mkdir(parents=True, exist_ok=True)   # H2: collision-safe + sharded
    reason = common.oversized_reason(p, cfg)     # M3: pre-flight fence a pathological file (default off)
    if reason:
        st = {"file": str(p), "stem": p.stem, "status": "NEEDS_REVIEW", "reasons": reason,
              "needs_review": True, "tables": 0}
        try:
            common.atomic_write_text(docdir / (p.stem + ".status.json"),
                                     json.dumps(st, indent=2, ensure_ascii=False))
        except Exception:
            pass
        common.mark_done(docdir)
        return st
    st = extract_pdf_tables(p, docdir / (p.stem + ".tables.xlsx"),
                            args["dpi"], args["lang"], args["min_text"], args["verify"], cfg)
    common.mark_done(docdir)                     # H2: sentinel LAST -> --resume trusts .done, not a partial .xlsx
    return st

def main():
    ap = argparse.ArgumentParser(description="Production PDF table extractor (completeness-guaranteed).")
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--dpi", type=int, default=None)
    ap.add_argument("--lang", default=None, help="Tesseract language(s) for the scanned-table OCR fallback (default eng)")
    ap.add_argument("--verify", action="store_true")
    common.add_config_args(ap)                         # provides the shared --min-text (M1)
    a = ap.parse_args()
    for mod, name, pip in [(pdfplumber, "pdfplumber", "pdfplumber"), (openpyxl, "openpyxl", "openpyxl"),
                           (fitz, "PyMuPDF", "pymupdf"), (RT, "robust_tables.py", "(copy robust_tables.py next to this file)")]:
        if mod is None: raise SystemExit("%s not available  (%s)" % (name, pip))
    cfg = common.config_from_args(a)
    common.configure_logging(cfg); common.apply_external_paths(cfg)
    dpi = cfg.dpi; min_text = cfg.min_text
    lang = a.lang if a.lang is not None else "eng"   # table-OCR fallback default stays 'eng' (back-compat)
    inp = Path(a.inp); out = Path(a.out)
    if inp.is_file():
        out_xlsx = out if out.suffix.lower() == ".xlsx" else (out / (inp.stem + ".tables.xlsx"))
        out_xlsx.parent.mkdir(parents=True, exist_ok=True)
        extract_pdf_tables(inp, out_xlsx, dpi, lang, min_text, a.verify, cfg)
    else:
        out.mkdir(parents=True, exist_ok=True)
        pdfs = sorted(p for p in inp.rglob("*") if p.suffix.lower() == ".pdf")
        if not pdfs: print("No PDF under %s" % inp); return
        # parallel (or serial at --workers 1) + per-file isolation + resume + killable timeout
        wargs = {"cfg": cfg.asdict(), "out": str(out), "dpi": dpi, "lang": lang,
                 "min_text": min_text, "verify": a.verify}
        results, _ = common.parallel_foreach(
            pdfs, _tp_worker, wargs, label="tables", errlog=str(out / "_errors.json"), cfg=cfg,
            done_marker=lambda fp: (common.doc_outdir(out, fp) / ".done").exists())   # H2: sentinel, not partial .xlsx
        results = [r for r in results if r]
        common.write_status_manifest(results, out, cfg.completeness_strict)
        if cfg.completeness_strict:
            held = sum(1 for r in results if r.get("status") != "AUTO_ACCEPT")
            print("[strict] %d/%d committed; %d withheld -> %s" % (len(results)-held, len(results), held, out/"_status.json"))
        # NOTE: parallel_foreach already wrote any per-file failures to out/_errors.json (errlog=).

if __name__ == "__main__":
    main()
