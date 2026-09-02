#!/usr/bin/env python3
r"""
pdf_extract.py - the PDF family extractor (native text + scanned OCR ladder).

This is the ONLY module that touches OCR / the GPU. Everything file-type-neutral
(fields, checksums, confidence aggregation, output writing) lives in common.py.

Scanned ladder (gated, so the slow steps run only where they help):
  1 RENDER + LIGHT DESKEW   render @ --dpi; deskew only (NLM/Sauvola removed -
                            docTR is robust to noise and doesn't need them).
  2 docTR (GPU, BATCHED across pages) = primary reader on every scanned page.
  3 ESCALATE per page, only if docTR conf < --escalate-th (0.88):
       - Tesseract (CPU) with SMART per-page language (eng on Latin pages,
         eng+hin+mar only when OSD sees Devanagari).
       - Florence-2 VLM (GPU) per the --vlm mode (off | low | tables | all).
  4 PRIMARY    = the single highest-confidence engine's text (one per page).
  5 CONFIDENCE = best reader, damped only on CONFIDENT disagreement.
  6 fields + gate happen later in common.write_outputs.

Run standalone (PDF only):
  python pdf_extract.py --in samples\ --out out\ --gate 0.70 --dpi 300 --lang eng+hin+mar
Or via the unified pipeline:
  python pipeline.py --in samples\ --out out\
"""
import argparse, sys, shutil
from dataclasses import dataclass
from pathlib import Path
import numpy as np

from common import (fuzz, TW, tqdm, extract_fields, run_batch, add_config_args, config_from_args,
                    configure_logging, apply_external_paths, is_native_text)

# ---- imports with graceful degradation -------------------------------------
try: import fitz                       # PyMuPDF: PDF text + render
except Exception: fitz = None
try: import cv2
except Exception: cv2 = None
try: import pytesseract
except Exception: pytesseract = None

# Windows: auto-find Tesseract if not on PATH
if pytesseract:
    if not shutil.which("tesseract"):
        for p in [r"C:\Program Files\Tesseract-OCR\tesseract.exe",
                  r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"]:
            if Path(p).exists():
                pytesseract.pytesseract.tesseract_cmd = p; break

# one-time Tesseract availability check (avoids per-page spam)
TESS_OK = False
if pytesseract:
    try:
        pytesseract.get_tesseract_version(); TESS_OK = True
    except Exception:
        print("[notice] Tesseract engine not found - running docTR ALONE (no 2nd-engine vote). "
              "Install UB-Mannheim Tesseract (with hin+mar) to enable voting.", file=sys.stderr)


# ============================================================================
# OCR ENGINES
# ============================================================================
_DOCTR = None
def doctr_model():
    global _DOCTR
    if _DOCTR is None:
        from doctr.models import ocr_predictor
        _DOCTR = ocr_predictor(pretrained=True)
    return _DOCTR

def _doctr_page_to_dict(pg):
    lines, confs = [], []
    for blk in pg.blocks:
        for ln in blk.lines:
            lines.append(" ".join(w.value for w in ln.words))
            confs += [float(w.confidence) for w in ln.words]
    return {"engine": "doctr", "text": "\n".join(lines),
            "conf": float(np.mean(confs)) if confs else 0.0}

def ocr_doctr_batch_pages(images_rgb):
    """Batched docTR OCR -> the RAW docTR page objects (carry per-word geometry). One GPU pass
    for many pages. The flat-text `ocr_doctr_batch` wraps this; the layout path keeps the boxes."""
    from doctr.io import DocumentFile
    bufs = [cv2.imencode(".png", cv2.cvtColor(im, cv2.COLOR_RGB2BGR))[1].tobytes() for im in images_rgb]
    res = doctr_model()(DocumentFile.from_images(bufs))
    return res.pages

def ocr_doctr_batch(images_rgb):
    """Batched docTR OCR on a LIST of RGB images -> flat {engine,text,conf} dicts (text path,
    geometry discarded - unchanged behavior)."""
    return [_doctr_page_to_dict(pg) for pg in ocr_doctr_batch_pages(images_rgb)]

def ocr_tesseract(binar, lang):
    d = pytesseract.image_to_data(binar, lang=lang, output_type=pytesseract.Output.DICT)
    confs = [int(c) for c in d["conf"] if str(c) != "-1"]
    return {"engine": "tesseract", "text": " ".join(t for t in d["text"] if t.strip()),
            "conf": (np.mean(confs)/100.0) if confs else 0.0}

# ---- OCR WITH GEOMETRY (for scanned whole-document layout) ------------------
# These KEEP per-word boxes (the flat-text functions above join words and drop them). All boxes
# are in the PREPPED RASTER's pixel frame; ocr_page_words scales them to PDF points (72/dpi).
def _geom_to_box(geom, w, h):
    """docTR word.geometry (relative pts, 2-tuple box or 4-pt polygon) -> abs pixel [x0,y0,x1,y1]."""
    xs = [float(p[0]) for p in geom]; ys = [float(p[1]) for p in geom]
    return [min(xs) * w, min(ys) * h, max(xs) * w, max(ys) * h]

def doctr_page_to_words(pg, w, h):
    """Raw docTR page object -> [{text, conf, bbox_px}] (one entry per word)."""
    out = []
    for blk in pg.blocks:
        for ln in blk.lines:
            for word in ln.words:
                v = (word.value or "").strip()
                if not v:
                    continue
                out.append({"text": v, "conf": float(word.confidence),
                            "bbox_px": _geom_to_box(word.geometry, w, h)})
    return out

def ocr_tesseract_words(binar, lang):
    """Tesseract image_to_data -> [{text, conf, bbox_px}] (one entry per word). Mirrors
    ocr_tesseract but keeps each word's left/top/width/height box instead of joining."""
    d = pytesseract.image_to_data(binar, lang=lang, output_type=pytesseract.Output.DICT)
    out = []
    for k in range(len(d["text"])):
        t = (d["text"][k] or "").strip()
        cs = str(d["conf"][k])
        if not t or cs == "-1":
            continue
        x, y, ww, hh = d["left"][k], d["top"][k], d["width"][k], d["height"][k]
        out.append({"text": t, "conf": int(float(cs)) / 100.0,
                    "bbox_px": [float(x), float(y), float(x + ww), float(y + hh)]})
    return out

def render_prep_for_layout(page, dpi):
    """Render + upright + deskew (the same raster docTR reads) and the pixel->point scale.
    Returns (prepped_rgb, scale) where scale = 72/dpi maps prepped-raster px to PDF points."""
    return prep_doctr(render_page(page, dpi)), 72.0 / float(dpi)

def _px_words_to_points(words, scale):
    """[{text,conf,bbox_px}] -> [{text,conf,bbox(points)}] using the px->point scale."""
    out = []
    for wd in words:
        b = wd["bbox_px"]
        out.append({"text": wd["text"], "conf": wd["conf"],
                    "bbox": [b[0] * scale, b[1] * scale, b[2] * scale, b[3] * scale]})
    return out

def ocr_page_words(page, opt=None):
    """OCR ONE page and KEEP per-word geometry, for scanned layout reconstruction. docTR is the
    primary reader; escalate to Tesseract when docTR page conf < opt.escalate_th and keep the
    higher-confidence engine's words. No Florence (it has no usable word geometry).

    Coordinate frame: the PREPPED (uprighted+deskewed) raster mapped to POINTS (72/dpi); the
    scanned page's width/height in points = prepped raster size * scale. Internally consistent
    (a scanned page has no fitz frame to co-register with). Degrades to words:[] when
    cv2/docTR/Tesseract are missing or both engines read nothing -> caller routes to review."""
    opt = opt or PdfOptions()
    if fitz is None or cv2 is None:
        r = getattr(page, "rect", None)                    # keep the TRUE page size (not 0x0) so the
        size = (r.width, r.height) if r is not None else (0.0, 0.0)   # emitted page isn't a 0-area stub
        return {"words": [], "page_conf": 0.0, "engine": None, "size_pts": size, "rgb": None}
    rgb, scale = render_prep_for_layout(page, opt.dpi)
    try:
        pgobj = ocr_doctr_batch_pages([rgb])[0]            # per-page docTR (batch of one)
    except Exception as e:
        TW(f"[doctr-words skip] {e}"); pgobj = None
    res = _words_from_rgb(rgb, scale, pgobj, opt)          # shared word-building (docTR + Tess escalation)
    res["rgb"] = rgb                                       # per-page path keeps the raster for back-compat
    return res

def _words_from_rgb(rgb, scale, pgobj, opt):
    """Build the word result for ONE already-rendered page from its docTR page object (pgobj, may be
    None) + escalate to Tesseract when docTR is weak. Returns {words(points), page_conf, engine,
    size_pts} WITHOUT the raster - shared by the per-page ocr_page_words and the batched ocr_pages_words."""
    h_px, w_px = rgb.shape[:2]
    size_pts = (w_px * scale, h_px * scale)
    words_px, page_conf, engine = [], 0.0, None
    if pgobj is not None:
        try:
            words_px = doctr_page_to_words(pgobj, w_px, h_px)
            page_conf = float(np.mean([wd["conf"] for wd in words_px])) if words_px else 0.0
            engine = "doctr"
        except Exception as e:
            TW(f"[doctr-words skip] {e}")
    if TESS_OK and page_conf < opt.escalate_th:            # escalate when docTR is weak/empty
        try:
            binar = binarize_for_tess(rgb)
            lang = pick_lang(binar, opt.lang, opt.smart_lang)
            twords = ocr_tesseract_words(binar, lang)
            tconf = float(np.mean([wd["conf"] for wd in twords])) if twords else 0.0
            if tconf > page_conf:                          # keep the higher-confidence engine
                words_px, page_conf, engine = twords, tconf, "tesseract"
        except Exception as e:
            TW(f"[tess-words skip] {e}")
    return {"words": _px_words_to_points(words_px, scale), "page_conf": round(page_conf, 3),
            "engine": engine, "size_pts": size_pts}

def ocr_pages_words(pages, opt=None):
    """BATCHED OCR-with-geometry for the scanned-LAYOUT path: render + docTR a WINDOW of pages in one
    GPU pass (far higher utilisation than one docTR call per page - the throughput win at scale), with
    per-page Tesseract escalation, words in POINTS. Returns a list of per-page dicts {words, page_conf,
    engine, size_pts} aligned to `pages`, WITHOUT the raster (bounded RAM - the caller re-renders the
    page raster only when it needs tables/figures/QR). Windowed (opt.ocr_window) so peak RAM stays flat
    regardless of page count; docTR sub-batched by opt.batch within the window."""
    opt = opt or PdfOptions()
    out = [None] * len(pages)
    if fitz is None or cv2 is None:                        # no render/OCR stack -> empty word results
        for i, p in enumerate(pages):
            r = getattr(p, "rect", None)
            out[i] = {"words": [], "page_conf": 0.0, "engine": None,
                      "size_pts": (r.width, r.height) if r is not None else (0.0, 0.0)}
        return out
    win = max(1, opt.ocr_window)
    for w0 in range(0, len(pages), win):
        widx = list(range(w0, min(w0 + win, len(pages))))
        rendered = [(i, render_prep_for_layout(pages[i], opt.dpi)) for i in widx]   # [(i,(rgb,scale))]
        imgs = [rgb for _, (rgb, _s) in rendered]
        pgobjs = []
        try:                                               # ONE GPU pass per opt.batch slice of the window
            for b in range(0, len(imgs), opt.batch):
                pgobjs += ocr_doctr_batch_pages(imgs[b:b + opt.batch])
        except Exception as e:
            TW(f"[doctr batch failed: {e}]"); pgobjs = []
        if len(pgobjs) != len(imgs):
            pgobjs = (pgobjs + [None] * len(imgs))[:len(imgs)]
        for k, (i, (rgb, scale)) in enumerate(rendered):
            out[i] = _words_from_rgb(rgb, scale, pgobjs[k], opt)
        del rendered, imgs, pgobjs                         # free the window before the next (flat RAM)
    return out

# ---- Tier-2 vision-LLM reader: Florence-2 (Microsoft, MIT, sovereign) -------
VLM_STATE = {"dead": False}
_FLOR = None; _FLOR_PROC = None
def ocr_florence(rgb):
    """Florence-2 GPU OCR. A THIRD reader used as a tie-breaker on hard pages.
    Never the sole source (VLMs can hallucinate) - it only earns trust by AGREEING."""
    global _FLOR, _FLOR_PROC
    import torch
    from PIL import Image as PILImage
    if _FLOR is None:
        from transformers import AutoProcessor, AutoModelForCausalLM
        dev = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if dev == "cuda" else torch.float32
        _FLOR = AutoModelForCausalLM.from_pretrained(
            "microsoft/Florence-2-large", trust_remote_code=True, torch_dtype=dtype).to(dev).eval()
        _FLOR_PROC = AutoProcessor.from_pretrained(
            "microsoft/Florence-2-large", trust_remote_code=True)
    dev = next(_FLOR.parameters()).device
    dtype = next(_FLOR.parameters()).dtype
    pil = PILImage.fromarray(rgb)
    enc = _FLOR_PROC(text="<OCR>", images=pil, return_tensors="pt")
    ids = enc["input_ids"].to(dev)
    pix = enc["pixel_values"].to(dev, dtype)
    with torch.no_grad():
        try:
            gen = _FLOR.generate(input_ids=ids, pixel_values=pix,
                                 max_new_tokens=1024, num_beams=3, do_sample=False)
        except torch.cuda.OutOfMemoryError:
            # recover the VRAM so the run continues (the caller skips the VLM for this page) rather
            # than the whole batch dying on one oversized page.
            del ids, pix
            torch.cuda.empty_cache()
            raise RuntimeError("Florence-2 VLM OOM - VRAM recovered, skipping this page")
    raw = _FLOR_PROC.batch_decode(gen, skip_special_tokens=False)[0]
    parsed = _FLOR_PROC.post_process_generation(raw, task="<OCR>",
                                                image_size=(pil.width, pil.height))
    return {"engine": "florence", "text": parsed.get("<OCR>", ""), "conf": None}


# ============================================================================
# STAGE 1 - preprocess (darkroom). CPU.
# ============================================================================
def _deskew_angle(gray):
    """Estimate skew on a DOWNSCALED copy (fast) - angle is the same at any scale."""
    h, w = gray.shape
    scale = 1000.0 / max(h, w)
    small = cv2.resize(gray, (int(w*scale), int(h*scale)), interpolation=cv2.INTER_AREA) if scale < 1 else gray
    inv = cv2.bitwise_not(small)
    thr = cv2.threshold(inv, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]
    coords = np.column_stack(np.where(thr > 0))
    if len(coords) < 50: return 0.0
    ang = cv2.minAreaRect(coords)[-1]
    return -(90 + ang) if ang < -45 else -ang

def _orientation_deg(img):
    """B2: detect 0/90/180/270 page orientation via Tesseract OSD (sovereign). Returns the
    clockwise degrees to rotate the page UPRIGHT. Sideways tender scans are extremely common
    and the small-tilt deskew below cannot fix them; this does. 0 if undetectable (sparse page)."""
    if pytesseract is None or not TESS_OK:
        return 0
    try:
        osd = pytesseract.image_to_osd(img, output_type=pytesseract.Output.DICT)
        return int(osd.get("rotate", 0)) % 360
    except Exception:
        return 0   # OSD needs enough text; on a sparse page leave it as-is (deskew still runs)

def _upright(rgb):
    """Rotate a 90/180/270-rotated page upright BEFORE deskew/OCR (B2)."""
    if cv2 is None: return rgb
    rot = _orientation_deg(rgb)
    if rot == 90:  return cv2.rotate(rgb, cv2.ROTATE_90_CLOCKWISE)
    if rot == 180: return cv2.rotate(rgb, cv2.ROTATE_180)
    if rot == 270: return cv2.rotate(rgb, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return rgb

def prep_doctr(rgb):
    """LIGHT prep for docTR: 0/90/180/270 orientation (B2) THEN small-tilt deskew. docTR is
    robust to noise, so the slow Non-Local-Means denoise + Sauvola binarize are skipped."""
    if cv2 is None: return rgb
    rgb = _upright(rgb)                                  # B2: fix gross rotation first
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    ang = _deskew_angle(gray)
    if abs(ang) >= 0.3:
        h, w = gray.shape
        M = cv2.getRotationMatrix2D((w//2, h//2), ang, 1.0)
        gray = cv2.warpAffine(gray, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2RGB)

def binarize_for_tess(rgb):
    """FAST binarization for Tesseract (only runs on escalated pages):
    light median denoise + OpenCV adaptive threshold (no slow NLM / Sauvola)."""
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    gray = cv2.medianBlur(gray, 3)
    return cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                 cv2.THRESH_BINARY, 31, 10)

MAX_RENDER_PX = 8000          # clamp the rendered pixmap's LONG edge (A0/A1 600-DPI scans -> multi-GB
                              # pixmaps that OOM a worker; the clamp keeps OCR working at a sane DPI)
def clamp_dpi(page, dpi, max_px=MAX_RENDER_PX):
    """Lower the effective DPI so the rendered pixmap's long edge stays <= max_px. A large-format /
    high-DPI page still OCRs (just not at an absurd resolution) instead of allocating gigabytes."""
    r = page.rect
    long_px = (max(r.width, r.height) / 72.0) * dpi
    if long_px > max_px:
        return max(72, int(dpi * max_px / long_px))
    return dpi

def render_page(page, dpi):
    pix = page.get_pixmap(dpi=clamp_dpi(page, dpi))          # clamp: never allocate a multi-GB pixmap
    img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
    if pix.n == 4 and cv2: img = cv2.cvtColor(img, cv2.COLOR_RGBA2RGB)
    elif pix.n == 1 and cv2: img = cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
    return img


# ============================================================================
# STAGE 3 - vote + per-page scoring
# ============================================================================
def detect_script(text):
    """Which script the extracted text actually contains (Latin vs Devanagari)."""
    deva  = sum(1 for ch in text if 'ऀ' <= ch <= 'ॿ')
    latin = sum(1 for ch in text if ch.isascii() and ch.isalpha())
    if deva + latin == 0: return "none"
    if deva == 0:  return "english(Latin)"
    if latin == 0: return "Marathi/Hindi(Devanagari)"
    return f"mixed({round(100*deva/(deva+latin))}%Devanagari)"

def pick_lang(binar, full_lang, smart=True):
    """Per-page language: fast 'eng' for Latin pages, the full set (eng+hin+mar) ONLY
    when Tesseract's script detector sees Devanagari. Honours multi-language where it
    matters without paying the 3-model cost (and Devanagari-noise) on English pages."""
    if not smart or full_lang == "eng":
        return full_lang
    try:
        osd = pytesseract.image_to_osd(binar, output_type=pytesseract.Output.DICT)
        return full_lang if "Devanagari" in osd.get("script", "") else "eng"
    except Exception:
        return full_lang   # detector unsure (sparse page) -> use the full set, be safe

def looks_like_table(text):
    """Cheap table detector on the docTR text already in hand (no extra model).
    Per the design note: many short/numeric tokens = a dense data table (worth the
    VLM); very few tokens = photo/blank (nothing to read, skip); long words = a hard
    TEXT page (docTR is already fine). Used only to gate `--vlm tables`."""
    toks = text.split()
    if len(toks) < 8:                                   # photo / blank / near-empty
        return False
    numericish = sum(1 for t in toks if any(c.isdigit() for c in t))
    short      = sum(1 for t in toks if len(t) <= 4)
    fn, fs = numericish / len(toks), short / len(toks)
    # a real data table is number-dense; require SOME numbers so ordinary prose
    # (English has many short function words) is not mistaken for a table.
    return fn >= 0.30 or (fn >= 0.12 and fs >= 0.55)

def vote(engines):
    """N-engine agreement = mean pairwise text similarity (0-1). More engines
    agreeing -> higher agreement -> legitimately higher confidence."""
    texts = [e["text"] for e in engines if e and e["text"].strip()]
    if len(texts) < 2: return texts, (0.5 if texts else 0.0)
    sims = []
    for i in range(len(texts)):
        for j in range(i + 1, len(texts)):
            sims.append(fuzz.token_set_ratio(texts[i], texts[j]) / 100.0)
    return texts, (sum(sims) / len(sims) if sims else 0.5)

def _rank_engine(e): return e["conf"] if e.get("conf") is not None else 0.85

def _score_page(engines, vlm_agree_th=0.5):
    """Returns (primary_text, page_conf, agreement, by-engine confs).
    B3 AGREEMENT GATE: a VLM (conf=None) may only become the PRIMARY text if it agrees with
    the best OCR engine by >= vlm_agree_th. A VLM can hallucinate, so without agreement it
    only informs confidence - it never silently replaces the OCR reading."""
    _, agree = vote(engines)
    valid = [e for e in engines if e["text"].strip()]
    ranked = sorted(valid, key=_rank_engine, reverse=True)
    primary = ""
    if ranked:
        top = ranked[0]
        if top.get("conf") is None:                      # the VLM ranked top (default 0.85)
            ocr = [e for e in ranked if e.get("conf") is not None]
            if ocr:
                sim = fuzz.token_set_ratio(top["text"], ocr[0]["text"]) / 100.0
                primary = top["text"] if sim >= vlm_agree_th else ocr[0]["text"]
            else:
                primary = top["text"]                    # VLM is the only reader (rare)
        else:
            primary = top["text"]
    confs = [e["conf"] for e in engines if e.get("conf") is not None]
    best = max(confs) if confs else (0.80 if primary.strip() else 0.0)
    strong = [e for e in engines if e["text"].strip()
              and (e.get("conf") is None or e["conf"] >= best - 0.25)]
    if len(strong) > 1:
        st = [e["text"] for e in strong]
        sims = [fuzz.token_set_ratio(st[a], st[b]) / 100.0
                for a in range(len(st)) for b in range(a + 1, len(st))]
        sa = sum(sims) / len(sims) if sims else 1.0
        page_conf = round(best * (0.6 + 0.4*sa), 3)
    else:
        page_conf = round(best, 3)
    return primary, page_conf, round(agree, 3), {e["engine"]: e.get("conf") for e in engines}


# ============================================================================
# EXTRACTOR
# ============================================================================
@dataclass
class PdfOptions:
    """Tunables for the PDF ladder (sensible defaults = the fast+accurate mode)."""
    dpi: int = 300
    lang: str = "eng+hin+mar"
    escalate_th: float = 0.88
    vlm: str = "off"          # off | low | tables | all
    vlm_th: float = 0.85
    vlm_agree_th: float = 0.5  # B3: VLM only becomes primary if it agrees this much with OCR
    batch: int = 8
    ocr_window: int = 16      # B1: pages OCR'd per memory window (flat RAM on huge scans)
    smart_lang: bool = True
    min_text: int = 50        # M1: chars of native text >= this => read the text layer (else OCR). Shared gate.

def _run_vlm(vlm, classic, table_like, vlm_th):
    """Decide whether the Florence-2 VLM should read this page."""
    if vlm == "off": return False
    if vlm == "all": return True
    if vlm == "low": return classic < vlm_th
    if vlm == "tables": return table_like and classic < vlm_th
    return False

def _verify_scanned_page(i, rgb, dt, opt, png_dir, made_flag):
    """Escalate (Tesseract/Florence) + score ONE scanned page. Returns (page_meta, text).
    Body is verbatim from the original per-page loop - only lifted out so the window loop
    (B1) reads cleanly. made_flag is a 1-element list so png_dir is mkdir'd at most once."""
    if not made_flag[0]: png_dir.mkdir(parents=True, exist_ok=True); made_flag[0] = True
    png_path = str(png_dir / f"page_{i+1}.png")
    cv2.imwrite(png_path, cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    engines = [dt] if dt else []
    classic = dt["conf"] if dt else 0.0
    table_like = looks_like_table(dt["text"]) if dt else False
    used_lang = None
    if TESS_OK and (dt is None or dt["conf"] < opt.escalate_th):
        try:
            binar = binarize_for_tess(rgb)
            used_lang = pick_lang(binar, opt.lang, opt.smart_lang)     # per-page language
            te = ocr_tesseract(binar, used_lang); engines.append(te)
            classic = max(classic, te["conf"])
        except Exception as e: TW(f"[tess skip p{i+1}] {e}")
    if not VLM_STATE["dead"] and _run_vlm(opt.vlm, classic, table_like, opt.vlm_th):
        try: engines.append(ocr_florence(rgb))
        except Exception as e:
            VLM_STATE["dead"] = True
            TW(f"[vlm disabled - {type(e).__name__}: {str(e)[:120]}]")
    primary, page_conf, agree, by = _score_page(engines, opt.vlm_agree_th)
    script = detect_script(primary)
    meta = {"page": i+1, "route": "scanned", "confidence": page_conf, "chars": len(primary),
            "engines": list(by.keys()),
            "doctr_conf": round(by["doctr"], 3) if by.get("doctr") is not None else None,
            "tess_conf": round(by["tesseract"], 3) if by.get("tesseract") is not None else None,
            "tess_lang": used_lang, "script": script, "table_like": table_like,
            "vlm": "florence" in by, "agreement": agree, "png": png_path}
    return meta, primary

def extract_pdf(path, png_dir, opt: PdfOptions = PdfOptions()):
    """Return (pages, fields, chunks, full_text) for one PDF. Scanned pages are OCR'd in
    fixed-size WINDOWS (opt.ocr_window): render+deskew+docTR+verify a window, then FREE its
    images before the next - so peak RAM stays flat regardless of page count (B1)."""
    doc = fitz.open(path); n = len(doc)
    pages = [None]*n; texts = [None]*n; scanned_idx = []
    # 1. route every page (cheap) - scanned ones are rendered later, per window
    for i, page in enumerate(doc):
        native = page.get_text().strip()
        if is_native_text(native, opt):                        # native text layer (shared min-text gate)
            pages[i] = {"page": i+1, "route": "native", "confidence": 0.97, "chars": len(native),
                        "engines": ["pdf_text"], "doctr_conf": None, "tess_conf": None,
                        "vlm": False, "agreement": 1.0, "png": None}
            texts[i] = native
        elif cv2 is not None:
            scanned_idx.append(i)
        else:
            pages[i] = {"page": i+1, "route": "scanned_no_cv2", "confidence": 0.0, "chars": 0,
                        "engines": [], "doctr_conf": None, "tess_conf": None, "vlm": False,
                        "agreement": 0.0, "png": None}
            texts[i] = ""
    # 2-3. WINDOWED scanned OCR: render -> docTR batch -> per-page verify -> FREE, per window
    made = [False]
    win = max(1, opt.ocr_window)
    pbar = (tqdm(total=len(scanned_idx), desc=f"{path.name[:22]} scan-OCR", unit="pg", leave=False)
            if scanned_idx else None)
    for w0 in range(0, len(scanned_idx), win):
        widx = scanned_idx[w0:w0 + win]
        rendered = [(i, prep_doctr(render_page(doc[i], opt.dpi))) for i in widx]
        imgs = [im for _, im in rendered]
        results = []
        try:
            for b in range(0, len(imgs), opt.batch):
                results += ocr_doctr_batch(imgs[b:b + opt.batch])
        except Exception as e:
            print(f"[doctr batch failed: {e}]", file=sys.stderr); results = []
        if len(results) != len(imgs):
            results = (results + [None]*len(imgs))[:len(imgs)]
        dt_by_idx = {i: dt for (i, _), dt in zip(rendered, results)}
        for i, rgb in rendered:
            pages[i], texts[i] = _verify_scanned_page(i, rgb, dt_by_idx.get(i), opt, png_dir, made)
            if pbar: pbar.update(1)
        del rendered, imgs, results, dt_by_idx              # free the window before the next
    if pbar: pbar.close()
    # 4. assemble (every index is filled)
    fields = extract_fields([t for t in texts if t])
    chunks = [{"kind": "page", "page": pages[i]["page"], "text": texts[i] or "",
               "confidence": pages[i]["confidence"]} for i in range(n)]
    return pages, fields, chunks, "\n\n".join(t for t in texts if t)


# ============================================================================
# STANDALONE CLI (PDF only) - run `python pdf_extract.py --in ... --out ...`
# ============================================================================
def _options_from_args(a):
    """Back-compat shim: build PdfOptions via the unified ExtractConfig (config.yaml + CLI)."""
    return PdfOptions(**config_from_args(a).to_pdf_options())

def add_pdf_args(ap):
    """Shared by this CLI and pipeline.py so the PDF flags stay identical. Defaults are None
    so config.yaml can supply them; ExtractConfig holds the real defaults (= today's values)."""
    ap.add_argument("--dpi", type=int, default=None)
    ap.add_argument("--lang", default=None)
    ap.add_argument("--escalate-th", dest="escalate_th", type=float, default=None,
                    help="run CPU Tesseract only when docTR page conf < this. "
                         "0.88 (default) = fast + accurate; 1.01 = always vote (max verify, slower).")
    ap.add_argument("--batch", type=int, default=None,
                    help="docTR GPU batch size (pages per GPU pass). Higher = faster on big PDFs.")
    ap.add_argument("--ocr-window", dest="ocr_window", type=int, default=None,
                    help="pages OCR'd per memory window (keeps RAM flat on huge scans; default 16).")
    ap.add_argument("--no-smart-lang", dest="no_smart_lang", action="store_true",
                    help="disable per-page language routing; run the full --lang set on every "
                         "escalated page (slower, and noisier on English pages).")
    ap.add_argument("--vlm", choices=["off", "low", "tables", "all"], default=None,
                    help="Florence-2 vision-LLM 3rd reader (GPU): off | low (hard pages) | "
                         "tables (dense table pages only) | all.")
    ap.add_argument("--vlm-th", dest="vlm_th", type=float, default=None,
                    help="with --vlm low/tables, run the VLM when classic OCR confidence < this.")
    ap.add_argument("--vlm-agree-th", dest="vlm_agree_th", type=float, default=None,
                    help="the VLM only becomes the chosen text if it agrees with OCR by >= this.")

def main():
    ap = argparse.ArgumentParser(description="PDF extractor (native + scanned OCR ladder).")
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--gate", type=float, default=None)
    add_pdf_args(ap); add_config_args(ap)
    a = ap.parse_args()
    if fitz is None: raise SystemExit("PyMuPDF (fitz) not installed")
    inp = Path(a.inp); outroot = Path(a.out); outroot.mkdir(parents=True, exist_ok=True)
    cfg = config_from_args(a)
    configure_logging(cfg, outroot); apply_external_paths(cfg)
    opt = PdfOptions(**cfg.to_pdf_options())
    files = [inp] if inp.is_file() else sorted(p for p in inp.rglob("*") if p.suffix.lower() == ".pdf")
    if not files:
        print(f"No PDF found under {inp}"); return
    if TESS_OK:
        try: avail = pytesseract.get_languages(config="")
        except Exception: avail = []
        print(f"[tesseract] requested: {cfg.lang}  |  installed: {', '.join(avail) or '?'}")
    else:
        print("[tesseract] engine not found - docTR only")

    def dispatch(path, docdir, png_dir):
        return ("pdf", *extract_pdf(path, png_dir, opt))
    run_batch(files, dispatch, cfg.hitl_gate, outroot, label="PDF extract", cfg=cfg)

if __name__ == "__main__":
    main()
