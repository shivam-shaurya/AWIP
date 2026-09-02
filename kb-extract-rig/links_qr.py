#!/usr/bin/env python3
r"""
links_qr.py - SOVEREIGN extraction of LINKS and QR/barcodes from a PDF page.

  - PDF hyperlinks : fitz page.get_links()  -> uri + rect           (clickable annotations)
  - URLs / emails  : regex over the page text                       (written-out links)
  - QR codes       : cv2.QRCodeDetector on the page raster (scanned) OR embedded images (digital)

No new system dependency: PyMuPDF (fitz), OpenCV (cv2), numpy - all already used by the rig. Every
function degrades gracefully (returns []) when a lib or an OpenCV feature is missing.
"""
import re

import common                                 # leaf module (M3 image pixel-cap guard); always present
try: import fitz
except Exception: fitz = None
try: import cv2
except Exception: cv2 = None
try: import numpy as np
except Exception: np = None

_URL_RE = re.compile(r"\b((?:https?://|www\.)[^\s<>\"')\]]+)", re.I)
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_TRIM = ".,;:)]}>\"'"

def page_hyperlinks(fitz_page, page_no=0):
    """Embedded clickable link annotations -> [{type:'link', subtype:'hyperlink', uri, bbox, page}]."""
    out = []
    try:
        for lk in fitz_page.get_links():
            uri = lk.get("uri") or lk.get("file")
            if not uri:
                continue
            r = lk.get("from")
            bbox = [r.x0, r.y0, r.x1, r.y1] if r is not None else None
            out.append({"type": "link", "subtype": "hyperlink", "uri": uri, "bbox": bbox, "page": page_no})
    except Exception:
        pass
    return out

def text_urls(text, page_no=0):
    """URLs/emails written in the text (not necessarily clickable). De-duped per page."""
    out, seen = [], set()
    for m in _URL_RE.finditer(text or ""):
        u = m.group(1).rstrip(_TRIM)
        if u.lower() not in seen:
            seen.add(u.lower()); out.append({"type": "link", "subtype": "url", "uri": u, "page": page_no})
    for m in _EMAIL_RE.finditer(text or ""):
        e = m.group(0)
        if e.lower() not in seen:
            seen.add(e.lower()); out.append({"type": "link", "subtype": "email", "uri": e, "page": page_no})
    return out

def detect_qr(rgb, page_no=0):
    """Decode QR codes in an RGB/gray numpy image via cv2.QRCodeDetector (sovereign, built-in).
    Returns [{type:'qr', data, bbox, page}]. [] if cv2/feature unavailable."""
    if cv2 is None or rgb is None:
        return []
    out = []
    try:
        det = cv2.QRCodeDetector()
        res = det.detectAndDecodeMulti(rgb)          # (ok, decoded_info, points, [straight_qr])
        ok, decoded, pts = res[0], res[1], res[2]
        if ok and decoded is not None and pts is not None:
            for data, p in zip(decoded, pts):
                if not data:
                    continue
                xs = [float(pt[0]) for pt in p]; ys = [float(pt[1]) for pt in p]
                out.append({"type": "qr", "subtype": "qr", "data": data,
                            "bbox": [min(xs), min(ys), max(xs), max(ys)], "page": page_no})
    except Exception:
        pass
    return out

def _qr_from_embedded(fitz_page, page_no=0):
    """Digital PDFs: a QR is usually an EMBEDDED raster - decode each embedded image."""
    if fitz is None or cv2 is None or np is None:
        return []
    out = []
    try:
        for img in fitz_page.get_images(full=True):
            xref = img[0]
            w = img[2] if len(img) > 2 else 0
            h = img[3] if len(img) > 3 else 0
            if not common.image_within_pixel_cap(w, h):   # M3: skip an oversized / decompression-bomb raster
                continue
            try:
                pix = fitz.Pixmap(fitz_page.parent, xref)
                if pix.n >= 4 or pix.colorspace is None:
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                arr = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
                out += detect_qr(arr, page_no)
            except Exception:
                continue
    except Exception:
        pass
    return out

def extract_links_qr(fitz_page, page_no=0, rgb=None, text=None, scale=1.0):
    """Merge hyperlinks + text URLs + QR. QR runs on the provided raster `rgb` (scanned page) or on
    the page's embedded images (digital). `text` defaults to the page's native text layer. `scale`
    (=72/dpi on a scanned page) converts QR boxes from the raster's PIXEL frame to page POINTS so a
    scanned QR's bbox is in the same units as the page's other elements (1.0 = leave as-is)."""
    out = page_hyperlinks(fitz_page, page_no)
    out += text_urls(text if text is not None else (fitz_page.get_text() or ""), page_no)
    qr = detect_qr(rgb, page_no) if rgb is not None else _qr_from_embedded(fitz_page, page_no)
    if rgb is not None and scale != 1.0:
        for q in qr:
            b = q.get("bbox")
            if b:
                q["bbox"] = [b[0] * scale, b[1] * scale, b[2] * scale, b[3] * scale]
    out += qr
    return out
