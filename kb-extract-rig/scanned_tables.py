#!/usr/bin/env python3
r"""
scanned_tables.py - LEVER B: grid-aware, per-cell numeric-whitelist OCR for SCANNED bordered tables.

The live alternative to table_pdf's flat img2table path (opt-in via cfg.scanned_cell_ocr). Promoted
from the archived evals/table_extract2.py with the geometry kept verbatim (it is proven) but ALL
number parsing routed through common.* so a scanned grid parses identically to the digital path and
the tie-out (no second, divergent numeric parser).

  1 DETECT THE GRID with OpenCV  - bordered tables have strong rules; find every horizontal +
    vertical line -> every CELL rectangle (a real row x col matrix). Pure cv2/numpy, laptop-testable.
  2 OCR EACH CELL ALONE          - a lone value in a clean crop is the easiest thing OCR can do.
    NUMERIC columns are re-OCR'd with a DIGIT WHITELIST (a money cell can only be digits/.,()-/),
    which kills letter-noise. Needs Tesseract -> runs on the server.
  3 DEGENERATE-GRID SENTINEL     - if detection collapses to <2 columns or <2 rows, return
    degenerate=True so the caller FALLS BACK to img2table rather than emitting a 1-column grid that
    silently merges every amount.

Numeric-column choice + parsing use common.is_amount_cell / common.parse_number (NOT a local copy),
and digit repair / tie-out happen downstream in table_pdf exactly as for any other 'ocr' grid.
"""
import re

try: import fitz
except Exception: fitz = None
try: import cv2
except Exception: cv2 = None
try: import numpy as np
except Exception: np = None
try: import pytesseract
except Exception: pytesseract = None
import shutil
from pathlib import Path

import common

# Windows: auto-find Tesseract if not on PATH (lifted from table_extract2.py)
if pytesseract and not shutil.which("tesseract"):
    for _p in (r"C:\Program Files\Tesseract-OCR\tesseract.exe",
               r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"):
        if Path(_p).exists():
            pytesseract.pytesseract.tesseract_cmd = _p; break


# ============================================================================
# RENDER + DESKEW (pure cv2/numpy - laptop-testable)
# ============================================================================
_MAX_RENDER_PX = 8000         # clamp long edge so an A0/A1 high-DPI scan can't allocate a multi-GB pixmap
def render_page(page, dpi):
    r = page.rect
    long_px = (max(r.width, r.height) / 72.0) * dpi
    if long_px > _MAX_RENDER_PX:
        dpi = max(72, int(dpi * _MAX_RENDER_PX / long_px))
    pix = page.get_pixmap(dpi=dpi)
    img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
    if pix.n == 4: img = cv2.cvtColor(img, cv2.COLOR_RGBA2RGB)
    elif pix.n == 1: img = cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
    return img

def _skew_angle(rgb):
    """Skew = slope of the long near-horizontal table rules (robust to a rotated side-title)."""
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=200,
                            minLineLength=max(50, gray.shape[1] // 3), maxLineGap=20)
    if lines is None:
        return 0.0
    import statistics
    angs = []
    for x1, y1, x2, y2 in np.asarray(lines).reshape(-1, 4):   # robust to cv2 (N,1,4) vs (N,4)
        if x2 == x1: continue
        a = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        if abs(a) <= 15: angs.append(a)
    if not angs:
        return 0.0
    return max(-10.0, min(10.0, float(statistics.median(angs))))

def deskew(rgb):
    ang = _skew_angle(rgb)
    if abs(ang) < 0.3:
        return rgb
    h, w = rgb.shape[:2]
    M = cv2.getRotationMatrix2D((w // 2, h // 2), ang, 1.0)
    return cv2.warpAffine(rgb, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


# ============================================================================
# GRID DETECTION (pure OpenCV - fully testable without OCR)
# ============================================================================
def _cluster(vals, min_gap):
    """Collapse nearby line coordinates into one (a real rule is ~2-3px thick)."""
    if not vals:
        return []
    vals = sorted(vals)
    groups = [[vals[0]]]
    for v in vals[1:]:
        if v - groups[-1][-1] <= min_gap: groups[-1].append(v)
        else: groups.append([v])
    return [int(sum(g) / len(g)) for g in groups]

def detect_grid(rgb, min_frac=0.30, max_gap=25):
    """Detect horizontal + vertical rules with HoughLinesP (gap-tolerant, thin-line friendly).
    Returns (ys, xs, None)."""
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    binv = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 15, -2)
    h, w = binv.shape
    minlen = int(min_frac * min(w, h))
    lines = cv2.HoughLinesP(binv, 1, np.pi / 180, threshold=120, minLineLength=minlen, maxLineGap=max_gap)
    ys, xs = [], []
    if lines is not None:
        # reshape(-1,4) is robust to cv2 returning (N,1,4) OR (N,4) across OpenCV builds (the server's
        # build returns (N,4), so lines[:,0] iterated to unpack-refusing int32 scalars -> TypeError).
        for x1, y1, x2, y2 in np.asarray(lines).reshape(-1, 4):
            dx, dy = abs(x2 - x1), abs(y2 - y1)
            if dy <= 3 and dx >= min_frac * w: ys.append((y1 + y2) // 2)
            elif dx <= 3 and dy >= min_frac * h: xs.append((x1 + x2) // 2)
    ys = _cluster(ys, max(6, h // 200))
    xs = _cluster(xs, max(6, w // 200))
    return sorted(ys), sorted(xs), None

def detect_row_bands(rgb, x0, x1):
    """Row boundaries from TEXT ink when there are too few horizontal rules: project ink in the
    column band onto the y-axis; contiguous ink = a text row, gaps = separators."""
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    binv = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 15, -2)
    x0 = max(0, x0); x1 = min(binv.shape[1], x1) if x1 > x0 else binv.shape[1]
    strip = binv[:, x0:x1]; w = max(1, x1 - x0)
    kx = max(10, w // 8)
    closed = cv2.morphologyEx(strip, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (kx, 1)))
    ink = (closed > 0).sum(axis=1).astype(float) / w
    text = ink > 0.15
    bands, s = [], None
    for i, t in enumerate(text):
        if t and s is None: s = i
        elif not t and s is not None: bands.append((s, i)); s = None
    if s is not None: bands.append((s, len(text)))
    minh = max(4, int(0.006 * len(text)))
    bands = [(a, b) for (a, b) in bands if (b - a) >= minh]
    if not bands:
        return []
    ys = [bands[0][0]]
    for (a, b), (a2, _) in zip(bands, bands[1:]):
        ys.append((b + a2) // 2)
    ys.append(bands[-1][1])
    return ys

def analyze_layout(rgb, deskew_first=True):
    """Deskew -> detect grid. Rows from horizontal RULES when there are enough, else text-ink
    bands. Columns from vertical lines. Returns (deskewed_rgb, ys, xs). deskew_first=False when
    the caller already uprighted+deskewed the raster (scanned_layout shares one coordinate frame
    with the OCR words) so the grid is not deskewed a SECOND time."""
    if deskew_first:
        rgb = deskew(rgb)
    ys_lines, xs, _ = detect_grid(rgb)
    if len(xs) < 2:
        xs = [0, rgb.shape[1]]
    ys = ys_lines if len(ys_lines) >= 4 else detect_row_bands(rgb, xs[0], xs[-1])
    return rgb, ys, xs

def build_cells(ys, xs):
    """Cells = rectangles between consecutive lines. Returns rows: list of list of (x0,y0,x1,y1)."""
    rows = []
    for r in range(len(ys) - 1):
        rows.append([(xs[c], ys[r], xs[c + 1], ys[r + 1]) for c in range(len(xs) - 1)])
    return rows

def draw_grid(rgb, ys, xs):
    img = rgb.copy()
    for y in ys: cv2.line(img, (0, y), (img.shape[1], y), (255, 0, 0), 2)
    for x in xs: cv2.line(img, (x, 0), (x, img.shape[0]), (0, 0, 255), 2)
    return img

def is_degenerate(ys, xs):
    """A usable table needs >=2 columns (>=3 vertical rules) AND >=2 rows (>=3 horizontal bounds).
    Otherwise the grid collapsed to a single mega-column/row and would silently merge values ->
    the caller should fall back to img2table."""
    return len(xs) < 3 or len(ys) < 3


# ============================================================================
# PER-CELL OCR (needs Tesseract -> SERVER). _ocr_config is laptop-testable.
# ============================================================================
def _ocr_config(whitelist=None, psm=7):
    """Assemble the Tesseract config string. Refactored out of ocr_cell so the LEVER-B whitelist
    wiring is unit-testable WITHOUT pytesseract."""
    cfg = f"--oem 1 --psm {psm}"
    if whitelist:
        cfg += f" -c tessedit_char_whitelist={whitelist}"
    return cfg

def prep_cell(crop, target_h=48, pad=6):
    g = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY) if crop.ndim == 3 else crop
    if g.shape[0] < 3 or g.shape[1] < 3:
        return None
    scale = target_h / g.shape[0]
    if scale > 1:
        g = cv2.resize(g, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    g = cv2.copyMakeBorder(g, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=255)
    return cv2.threshold(g, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]

def ocr_cell(crop, lang, whitelist=None, psm=7):
    prepped = prep_cell(crop)
    if prepped is None:
        return "", -1.0
    d = pytesseract.image_to_data(prepped, lang=lang, config=_ocr_config(whitelist, psm),
                                  output_type=pytesseract.Output.DICT)
    toks, confs = [], []
    for t, c in zip(d["text"], d["conf"]):
        t = (t or "").strip()
        if not t: continue
        toks.append(t)
        try: confs.append(float(c))
        except Exception: pass
    return " ".join(toks), (sum(confs) / len(confs) if confs else -1.0)


# ============================================================================
# NUMERIC COLUMN CHOICE (reuses common.is_amount_cell - no second parser)
# ============================================================================
def _numeric_cols(grid, thresh=0.6):
    """Columns where most non-empty cells read as a real amount (common.is_amount_cell). These get
    the digit-whitelist re-OCR. Header-independent (scanned headers are often garbled)."""
    ncols = max((len(r) for r in grid), default=0)
    out = []
    for c in range(ncols):
        vals = [r[c] for r in grid if c < len(r) and str(r[c] or "").strip()]
        if vals and sum(1 for v in vals if common.is_amount_cell(v)) / len(vals) >= thresh:
            out.append(c)
    return out


# ============================================================================
# PUBLIC: OCR one scanned table / page  (SERVER - needs Tesseract)
# ============================================================================
def ocr_scanned_table(rgb, lang="eng", numeric_whitelist="0123456789.,()-/", psm=7, deskew_first=True):
    """Two-pass per-cell OCR of one bordered table image. Pass 1: general OCR every cell.
    Pass 2: re-OCR the NUMERIC columns with the digit whitelist. Returns
    {grid, conf, degenerate, ys, xs}. degenerate=True -> caller falls back to img2table.
    deskew_first=False when the raster is already uprighted+deskewed (scanned_layout)."""
    rgb, ys, xs = analyze_layout(rgb, deskew_first=deskew_first)
    if is_degenerate(ys, xs):
        return {"grid": [], "conf": [], "degenerate": True, "ys": ys, "xs": xs}
    cells = build_cells(ys, xs)
    grid, confg = [], []
    for row in cells:
        grow, crow = [], []
        for (x0, y0, x1, y1) in row:
            txt, cf = ocr_cell(rgb[y0:y1, x0:x1], lang, whitelist=None, psm=psm)
            grow.append(txt); crow.append(cf)
        grid.append(grow); confg.append(crow)
    for c in _numeric_cols(grid):                       # pass 2: digit whitelist on numeric columns
        for ri, row in enumerate(cells):
            if c >= len(row): continue
            x0, y0, x1, y1 = row[c]
            txt, cf = ocr_cell(rgb[y0:y1, x0:x1], lang, whitelist=numeric_whitelist, psm=psm)
            if txt:
                grid[ri][c], confg[ri][c] = txt, cf
    return {"grid": grid, "conf": confg, "degenerate": False, "ys": ys, "xs": xs}

def ocr_scanned_page(fitz_page, dpi=300, lang="eng", numeric_whitelist="0123456789.,()-/", psm=7):
    """Render a scanned PDF page and OCR its bordered table per cell. Returns
    {tables: [{grid, conf}], degenerate: bool}. degenerate (or missing cv2/Tesseract) -> the caller
    keeps the img2table path. (Treats one detected grid per page, the BOQ-scan common case.)"""
    if cv2 is None or np is None or pytesseract is None:
        return {"tables": [], "degenerate": True}
    res = ocr_scanned_table(render_page(fitz_page, dpi), lang, numeric_whitelist, psm)
    if res["degenerate"]:
        return {"tables": [], "degenerate": True}
    return {"tables": [{"grid": res["grid"], "conf": res["conf"]}], "degenerate": False}
