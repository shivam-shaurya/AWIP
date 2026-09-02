#!/usr/bin/env python3
r"""
extract_images.py - pull EVERY embedded image/photo out of a PDF (or a folder of PDFs) at its
ORIGINAL embedded resolution: logos, site photographs, diagrams/maps, scanned figures, stamps and
signatures - ANY raster. Sovereign (PyMuPDF only; no cloud, no new deps).

How this differs from doc_layout's figure layer: doc_layout RE-RENDERS figures as PLACED (150 DPI)
and filters decorative/noise to build the reading-order document. THIS tool instead dumps the ACTUAL
embedded image bytes via fitz `extract_image(xref)` - so a site photo or a logo comes out untouched
at its native resolution and original format - and can ALSO render whole scanned / image-only pages
(a "text image": a page whose picture IS the page, not a separate embedded object).

Outputs per source file (collision-safe sharded dir, same scheme as doc_layout):
  <out>/<hh>/<hh>/<key>/images/p<page>_x<xref>.<ext>    one native image per UNIQUE embedded raster
  <out>/<hh>/<hh>/<key>/images_manifest.json            page(s), xref, w, h, ext, kind, bytes
  <out>/<hh>/<hh>/<key>/pages/p<page>.png               (only with --render-scanned) image-only pages

Run:
  python extract_images.py --in file.pdf --out out_images\
  python extract_images.py --in folder\  --out out_images\ --render-scanned --min-px 32
"""
import argparse, json
from pathlib import Path

try: import fitz                       # PyMuPDF: the only dependency
except Exception: fitz = None
import common                          # leaf module: doc_outdir / atomic_write_text / safe_name


def _kind(w, h):
    """Rough class for triage (NOT authoritative): a small square is an icon/logo, a very wide/short
    strip is a banner/rule, everything else is a photo/figure."""
    m, n = max(w, h), max(1, min(w, h))
    if m <= 160:
        return "icon/logo"
    if m / n >= 6:
        return "banner/rule"
    return "photo/figure"

def extract_embedded(doc, min_px=16, cfg=None):
    """Every UNIQUE embedded raster across the document at NATIVE resolution. De-duped by xref (a
    logo repeated on 50 pages is saved ONCE, with every page it appears on). A soft-masked (cut-out)
    image is composited with its mask so a transparent photo is not dumped as a black box. Returns
    (images, skipped): images = [{xref, pages, width, height, ext, kind, data}]; skipped = rasters
    whose declared pixel area exceeds max_image_megapixels (M3 decompression-bomb guard - flagged and
    NOT decoded/allocated)."""
    seen = {}; skipped = []
    for pno in range(doc.page_count):
        page = doc[pno]
        for img in page.get_images(full=True):
            xref = img[0]
            if xref in seen:
                seen[xref]["pages"].append(pno + 1); continue
            w0 = img[2] if len(img) > 2 else 0     # declared dims from get_images (NO decode)
            h0 = img[3] if len(img) > 3 else 0
            if not common.image_within_pixel_cap(w0, h0, cfg):   # M3: skip a bomb before any Pixmap alloc
                skipped.append({"xref": xref, "page": pno + 1, "width": w0, "height": h0,
                                "reason": "exceeds max_image_megapixels - not decoded"})
                continue
            try:
                info = doc.extract_image(xref)
            except Exception:
                continue
            w, h = info.get("width", 0), info.get("height", 0)
            if max(w, h) < min_px:                 # skip 1x1 spacers / tiny stencil masks
                continue
            if not common.image_within_pixel_cap(w, h, cfg):     # re-check the DECODED dims (defensive)
                skipped.append({"xref": xref, "page": pno + 1, "width": w, "height": h,
                                "reason": "exceeds max_image_megapixels - not decoded"})
                continue
            data, ext = info.get("image"), info.get("ext", "png")
            if info.get("smask"):                  # honour transparency -> composite to PNG
                try:
                    base = fitz.Pixmap(doc, xref)
                    data = fitz.Pixmap(base, fitz.Pixmap(doc, info["smask"])).tobytes("png"); ext = "png"
                except Exception:
                    pass
            if not data:
                continue
            seen[xref] = {"xref": xref, "pages": [pno + 1], "width": w, "height": h,
                          "ext": ext, "kind": _kind(w, h), "data": data}
    return list(seen.values()), skipped

def render_image_pages(doc, dpi=200, min_text=20):
    """Whole-page PNG renders for IMAGE-ONLY pages - a scanned page whose picture IS the page (no
    separate embedded image, no real text layer). Returns [(page_no, png_bytes)]."""
    out = []
    for pno in range(doc.page_count):
        page = doc[pno]
        if len((page.get_text() or "").strip()) >= min_text:
            continue                               # has a text layer -> not an image-only page
        try:
            out.append((pno + 1, page.get_pixmap(dpi=dpi).tobytes("png")))
        except Exception:
            pass
    return out

def extract_file(path, outroot, render_scanned=False, min_px=16, dpi=200, cfg=None):
    """Extract one PDF's images to a sharded, collision-safe output dir + a manifest. Returns a
    summary row {file, images, skipped_images, scanned_page_renders}. Oversized rasters (M3) are
    skipped + recorded; byte writes are long-path safe (R14)."""
    path = Path(path)
    docdir = common.doc_outdir(outroot, path)
    imgdir = docdir / "images"; imgdir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(str(path))
    manifest = []
    images, skipped = extract_embedded(doc, min_px=min_px, cfg=cfg)
    for r in images:
        name = "p%d_x%d.%s" % (r["pages"][0], r["xref"], r["ext"])
        try:
            with open(common._fs_path(imgdir / name), "wb") as f:   # R14: long-path safe binary write
                f.write(r["data"])
        except Exception:
            continue
        manifest.append({"file": "images/" + name, "pages": r["pages"], "xref": r["xref"],
                         "width": r["width"], "height": r["height"], "ext": r["ext"],
                         "kind": r["kind"], "bytes": len(r["data"])})
    n_pages = 0
    if render_scanned:
        pdir = docdir / "pages"; pdir.mkdir(parents=True, exist_ok=True)
        for pno, png in render_image_pages(doc, dpi=dpi):
            try:
                with open(common._fs_path(pdir / ("p%d.png" % pno)), "wb") as f:   # R14: long-path safe
                    f.write(png)
                n_pages += 1
            except Exception:
                pass
    doc.close()
    common.atomic_write_text(docdir / "images_manifest.json", json.dumps(
        {"file": str(path), "images": manifest, "skipped_images": skipped,
         "scanned_page_renders": n_pages}, indent=2, ensure_ascii=False))
    common.mark_done(docdir)
    return {"file": str(path), "images": len(manifest), "skipped_images": len(skipped),
            "scanned_page_renders": n_pages}

def main():
    ap = argparse.ArgumentParser(description="Extract every embedded image/photo from PDF(s) at native resolution.")
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--render-scanned", dest="render_scanned", action="store_true",
                    help="also save a full-page PNG for image-only (scanned) pages that have no text layer.")
    ap.add_argument("--min-px", dest="min_px", type=int, default=16,
                    help="skip images whose long edge is below this many pixels (1x1 spacers / masks).")
    ap.add_argument("--dpi", type=int, default=200, help="DPI for --render-scanned page renders.")
    a = ap.parse_args()
    if fitz is None:
        raise SystemExit("PyMuPDF (fitz) not installed")
    inp = Path(a.inp); out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    files = [inp] if inp.is_file() else sorted(p for p in inp.rglob("*") if p.suffix.lower() == ".pdf")
    if not files:
        print("No PDF found under", inp); return
    total = 0
    for f in files:
        try:
            r = extract_file(f, out, a.render_scanned, a.min_px, a.dpi)
            total += r["images"]
            extra = (" + %d page render(s)" % r["scanned_page_renders"]) if r["scanned_page_renders"] else ""
            print("[%s] %d image(s)%s" % (f.name, r["images"], extra))
        except Exception as e:
            print("[ERROR] %s: %s: %s" % (f.name, type(e).__name__, e))
    print("Done: %d image(s) from %d file(s) -> %s" % (total, len(files), out))

if __name__ == "__main__":
    main()
