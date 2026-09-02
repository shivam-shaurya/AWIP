#!/usr/bin/env python3
"""
common.py - shared building blocks for the KB Extract pipeline.

This is the LEAF module: it imports nothing from the rest of the rig, so the
per-type extractors (pdf_extract / excel_extract / docx_extract) and the
pipeline orchestrator can all import it without any circular-import risk.

What lives here (everything that is NOT specific to one file type):
  - small filesystem / fuzzy-match / progress helpers
  - FIELD extraction: regexes, ID checksums (PAN/GSTIN/Aadhaar/IFSC),
    amount words-vs-figures reconcile  -> extract_fields()
  - document-level CONFIDENCE aggregation + the canonical OUTPUT writer
    (<stem>.doc.json, <stem>.chunks.jsonl, <stem>.preview.html)
  - run_batch(): the single batch driver used by BOTH the pipeline and any
    standalone extractor (so review_queue.csv / run_summary.json are written
    in exactly ONE place).

No OCR, no GPU, no torch here -> fast to import and easy to unit-test.
"""
import csv
import hashlib
import html
import json
import logging
import math
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Optional, TypedDict

# ---- optional deps with graceful degradation -------------------------------
try:
    from rapidfuzz import fuzz
except Exception:
    import difflib
    class _F:
        @staticmethod
        def token_set_ratio(a, b): return difflib.SequenceMatcher(None, a, b).ratio()*100
        @staticmethod
        def partial_ratio(a, b): return difflib.SequenceMatcher(None, a, b).ratio()*100
    fuzz = _F()

try:
    from tqdm import tqdm  # progress bars
    def TW(msg): tqdm.write(msg)        # print without breaking an active bar
except Exception:
    def tqdm(it=None, **k): return it if it is not None else []
    def TW(msg): print(msg)

# ============================================================================
# shared TYPES - the public contract (hint the surface; not a full-file rewrite)
# ============================================================================
Cell = Any                              # a raw grid cell: str (usual), or int/float/None from a reader
Row = list                             # one table row  (list[Cell])
Grid = list                            # a table grid   (list[Row]); numeric-tolerant everywhere


class Flag(TypedDict, total=False):
    """One tie-out / completeness finding from verify_table. `kind` absent => a real arithmetic gap;
    the soft kinds (merged_cell / not_verified / digit_fix / serial_gap / row_arith) are review markers."""
    total_label: str
    stated: Any
    sum_of_rows: Any
    gap: Any                            # numeric rupee gap OR a marker: DROPPED-ROW? / MERGED-CELL? / NOT-VERIFIED
    tol: float
    kind: str
    table: str


class Element(TypedDict, total=False):
    """A doc_layout reading-order element - the digital element stream locked by the golden-diff test."""
    type: str                           # heading | paragraph | list_item | table | figure | header | footer | qr ...
    level: Optional[int]
    id: str                             # deterministic, e.g. "p1-e3"
    page: int
    reading_order_index: int
    section_path: list
    text: str
    grid: Grid
    bbox: list


# ============================================================================
# small helpers
# ============================================================================
def safe_name(s):
    """Filesystem-safe stem: strip trailing spaces/dots (Windows can't mkdir them)."""
    s = s.strip().rstrip(" .")
    for ch in '<>:"/\\|?*': s = s.replace(ch, "_")
    return s or "doc"

def doc_key(path):
    """Collision-safe output key: <sanitized-stem>__<8 hex of the abs path>. Two source files that
    sanitize to the SAME stem (every project folder has a BOQ.pdf / Schedule-H.xlsx in a subdir) get
    DISTINCT keys, so their outputs never silently overwrite and resume never mis-skips one for the
    other - the single silent-data-loss hole at scale."""
    p = Path(path)
    h = hashlib.sha1(os.path.abspath(str(p)).encode("utf-8", "replace")).hexdigest()[:8]
    return f"{safe_name(p.stem)[:48]}__{h}"   # cap the stem so sharded dir + filename stay under Windows MAX_PATH

def doc_outdir(outroot, path):
    """Sharded per-document output dir: outroot/<hh>/<hh>/<key>/ - a flat million subdirs under one
    parent is an inode/listing cliff (NTFS/ext4); two hash levels = 65k buckets of ~uniform fanout."""
    key = doc_key(path)
    h = key.rsplit("__", 1)[-1]
    return Path(outroot) / h[:2] / h[2:4] / key

def _fs_path(path):
    r"""Low-level filesystem path for open()/os.replace() that survives Windows MAX_PATH (260). On
    win32, return the extended-length form \\?\<abs> (requires a fully-qualified, backslash-separated
    path with no '.'/'..' segments - abspath normalizes it) so a deep sharded output dir cannot raise
    FileNotFoundError on the .tmp write or the rename. On other OSes the path is returned unchanged.
    This prefix is used ONLY for the syscall - it is NEVER stored in an output, returned to a caller,
    or logged (callers keep the plain Path)."""
    p = os.path.abspath(str(path))
    if os.name == "nt" and not p.startswith("\\\\?\\"):
        if p.startswith("\\\\"):                         # UNC \\server\share -> \\?\UNC\server\share
            p = "\\\\?\\UNC\\" + p[2:]
        else:
            p = "\\\\?\\" + p
    return p

def atomic_write_text(path, text, encoding="utf-8"):
    """Crash-safe write: render to <path>.tmp then os.replace (atomic on the same filesystem), so a
    worker killed mid-write never leaves a half-written artifact that --resume would trust as done.
    newline="" => write \\n verbatim (no Windows CRLF translation) so JSON/MD are byte-stable. The
    open + rename go through _fs_path so a deep sharded path stays under Windows MAX_PATH."""
    path = Path(path); tmp = path.with_name(path.name + ".tmp")
    with open(_fs_path(tmp), "w", encoding=encoding, newline="") as f:
        f.write(text)
    os.replace(_fs_path(tmp), _fs_path(path))

def mark_done(docdir):
    """Drop the .done sentinel AFTER every artifact for a document has flushed. Resume keys on this,
    never on the mere existence of a (possibly partial) output file. Long-path safe (_fs_path)."""
    try:
        with open(_fs_path(Path(docdir) / ".done"), "w", encoding="utf-8") as f:
            f.write("")
    except Exception:
        pass

def doc_class(name):
    n = name.lower()
    if "schedule" in n or "sch-h" in n or "sch h" in n or "boq" in n: return "schedule_h"
    if "loa" in n: return "loa"
    if "ipc" in n: return "ipc"
    if "contract" in n or "agreement" in n: return "contract"
    if "tor" in n: return "tor"
    return "unknown"

# ============================================================================
# STAGE 4-5 - field extract + reconcile (the proof layer)
# ============================================================================
FIELD_PATTERNS = {
    "pan":     r"\b[A-Z]{5}[0-9]{4}[A-Z]\b",
    "gstin":   r"\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b",
    "ifsc":    r"\b[A-Z]{4}0[A-Z0-9]{6}\b",
    "aadhaar": r"\b[2-9][0-9]{3}[ -]?[0-9]{4}[ -]?[0-9]{4}\b",  # space/hyphen only, no newline
    "amount_figures": r"(?:Rs\.?|Rs|INR)\s*([0-9][0-9,]*\.?[0-9]*)",
    "date":    r"\b[0-3]?\d[\/\-\.][01]?\d[\/\-\.]20\d{2}\b",
}
# ID fields are only believed when the document actually labels one nearby -
# stops a stray reference/phone number from being treated as a failing Aadhaar/PAN.
LABELS = {
    "pan":     r"\bpan\b",
    "gstin":   r"\bgst(in)?\b",
    "ifsc":    r"\bifsc\b",
    "aadhaar": r"\b(aadhaar|aadhar|uid)\b",
}
_VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],
 [4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],
 [8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]]
_VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,9,1,6,7,4,3,2],[8,9,1,6,0,4,3,5,2,7],
 [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]]
def valid_aadhaar(n):
    ds = [int(x) for x in re.sub(r"\s", "", n)][::-1]
    if len(ds) != 12: return False
    c = 0
    for i, d in enumerate(ds): c = _VD[c][_VP[i % 8][d]]
    return c == 0
def valid_pan(p):  return bool(re.fullmatch(r"[A-Z]{5}[0-9]{4}[A-Z]", p.upper()))
def valid_ifsc(s): return bool(re.fullmatch(r"[A-Z]{4}0[A-Z0-9]{6}", s.upper()))
def valid_gstin(g):
    cs = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"; g = g.upper()
    if not re.fullmatch(r"[0-9A-Z]{15}", g): return False
    s = 0
    for i, ch in enumerate(g[:14]):
        p = cs.index(ch) * (1 if i % 2 == 0 else 2); s += p // 36 + p % 36
    return cs[(36 - s % 36) % 36] == g[14]
_ONES = ["","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve",
 "thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"]
_TENS = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"]
def _two(n): return _ONES[n] if n < 20 else _TENS[n//10] + ((" " + _ONES[n % 10]) if n % 10 else "")
def _three(n):
    h, r = n // 100, n % 100
    return (_ONES[h] + " hundred" + ((" " + _two(r)) if r else "")) if h else _two(r)
def indian_words(n):
    if n == 0: return "zero"
    out = []; cr, n = n//10**7, n%10**7; la, n = n//10**5, n%10**5; th, n = n//10**3, n%10**3
    # crore group can be >= 100 (e.g. 261 crore) - _two() only covers <100, so use
    # _three() for 100-999 and recurse for the rare >999-crore case (never crash).
    if cr: out.append((_three(cr) if cr < 1000 else indian_words(cr)) + " crore")
    if la: out.append(_two(la) + " lakh")
    if th: out.append(_two(th) + " thousand")
    if n:  out.append(_three(n))
    return " ".join(out)
def reconcile_amount(fig, text):
    if "." in fig:                       # decimal = crore/lakh shorthand -> words check unreliable
        return None
    try: n = int(re.sub(r"[,\s]", "", fig))
    except ValueError: return None
    # Only assert pass/FAIL when a real amount-in-words context exists ("Rupees ... only").
    if not re.search(r"rupees|only", text, re.I):
        return None
    return fuzz.partial_ratio(indian_words(n).lower(), text.lower()) >= 80

def extract_fields(texts):
    """Pull labelled fields out of one or more reader texts and attach a
    confidence + a reconcile verdict (True/False/None) to each."""
    joined = "\n".join(texts); fields = {}
    def in_all(v): return len(texts) >= 2 and all(v in t for t in texts)
    for name, pat in FIELD_PATTERNS.items():
        m = re.search(pat, joined, re.I)
        if not m: continue
        # ID fields require a context label in the doc, else the match is coincidental
        # (a reference/phone number) and must NOT be treated as a failing field.
        if name in LABELS and not re.search(LABELS[name], joined, re.I):
            continue
        raw = (m.group(1) if (m.groups() and name == "amount_figures") else m.group(0)).strip()
        rec = None
        if name == "pan": rec = valid_pan(raw)
        elif name == "gstin": rec = valid_gstin(raw)
        elif name == "ifsc": rec = valid_ifsc(raw)
        elif name == "aadhaar": rec = valid_aadhaar(raw)
        elif name == "amount_figures": rec = reconcile_amount(raw, joined)
        conf = 0.95 if in_all(raw) else 0.65
        if rec is True: conf = max(conf, 0.99)
        if rec is False: conf = min(conf, 0.40)
        fields[name] = {"value": raw, "confidence": round(conf, 2),
                        "engines_agree": bool(in_all(raw)), "reconciled": rec}
    return fields

# ============================================================================
# VERIFY / TABLE TIE-OUT helpers (shared by table_pdf + excel_extract)
# ============================================================================
# Devanagari (Hindi/Marathi) digits -> ASCII, so a Hindi BOQ's amounts parse like any other.
_DEVA_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")

def parse_number(s: Cell) -> Optional[float]:
    """Pull a number out of a messy cell: drop the rupee sign, thousands commas, 'Rs' and '%'.
    Handles DEVANAGARI digits (Hindi/Marathi scans). Returns float or None. ACCOUNTING NEGATIVES
    written '(2,500.00)' are returned NEGATIVE - deduction/credit/recovery rows are real and reading
    them positive would corrupt any tie-out that includes them by 2x the deduction. (Shared so
    verify_table, pick_amount_column and the Excel tie-out all parse numbers identically.)"""
    if s is None:
        return None
    t = str(s).strip().translate(_DEVA_DIGITS)
    neg = t.startswith("(") and t.endswith(")")            # accounting negative
    t = (t.replace(chr(0x20b9), "").replace(",", "").replace("Rs", "").replace("%", "")
          .replace("(", "").replace(")", "").strip())
    m = re.search(r"-?\d+\.\d+|-?\d+", t)
    if not m:
        return None
    v = float(m.group())
    return -abs(v) if neg else v

def round_tolerance(n_rows: int, *, per_row: float = 0.5, floor: float = 1.0) -> float:
    """Rounding-scaled tie-out tolerance. Each summed line carries <= ~`per_row` rupee of
    independent rounding, so N lines drift by at most ceil(per_row * N). This bound is
    MAGNITUDE-INDEPENDENT - unlike a %-of-grand-total tolerance it cannot hide a million-
    rupee dropped row. ASSUMES the source rounds to whole rupees (per_row=0.5); do NOT
    'fix' this back to a percentage of the total."""
    return max(floor, math.ceil(per_row * max(n_rows, 1)))

# Bilingual amount-column header keywords (English + Hindi/Devanagari). Hindi terms are matched by
# substring (Devanagari word boundaries are unreliable in `re`); they make the money-column picker
# and the tie-out fire on Hindi BOQs, not just English ones.
_DEF_AMT_KW = ("amount", "total", "price", "value", "rate", "cost",
               "राशि", "रकम", "कुल", "योग", "धनराशि", "मूल्य", "दर")

def rowwise_max_column(rows: Grid, counts: list) -> Optional[int]:
    """The column that most often holds the row's LARGEST number (an extended Amount =
    Qty x Rate is >= its factors). Restricted to columns with >=3 numeric cells.
    Returns a column index, or None if there are no numeric columns."""
    nc = len(counts)
    if nc == 0 or max(counts, default=0) < 3:
        return None
    wins = [0] * nc
    for r in rows:
        nums = [(c, parse_number(r[c])) for c in range(min(len(r), nc))]
        nums = [(c, v) for c, v in nums if v is not None]
        if not nums:
            continue
        wins[max(nums, key=lambda cv: cv[1])[0]] += 1
    cand = [c for c in range(nc) if counts[c] >= 3]
    if not cand or max(wins[c] for c in cand) == 0:
        return None
    return max(cand, key=lambda c: (wins[c], counts[c]))

def pick_amount_column(rows: Grid, counts: list, keywords=_DEF_AMT_KW) -> Optional[int]:
    """Choose the column holding the MONEY amounts - general across single-money-column
    abstracts AND full Sr/Desc/Unit/Qty/Rate/Amount BOQs. Returns a column index or None.
      (1) HEADER match: a column whose header text (first 3 rows) contains an amount keyword
          AND has >=3 numeric cells -> the RIGHTMOST such (extended Amount sits right of Rate).
      (2) ROW-WISE MAX: the column most often holding the row's largest number.
      (3) FALLBACK: the column with the most numeric cells (legacy behaviour - never worse).
    Only ADDS preference over the legacy 'most numeric' rule, so it can't regress the
    previously-correct single-column case."""
    nc = len(counts)
    if nc == 0 or max(counts, default=0) < 3:
        return None
    kws = tuple(k.lower() for k in keywords)
    headers = [" ".join(str(r[c]) for r in rows[:3] if c < len(r)).lower() for c in range(nc)]
    hdr = [c for c in range(nc) if counts[c] >= 3 and any(k in headers[c] for k in kws)]
    if hdr:
        return max(hdr)                                  # rightmost labelled amount column
    rmax = rowwise_max_column(rows, counts)
    if rmax is not None:
        return rmax
    return max(range(nc), key=lambda c: counts[c])        # legacy fallback

def _header_amount_columns(rows, counts, keywords=_DEF_AMT_KW):
    """The set of columns whose header text (first 3 rows) contains an amount keyword AND have >=3
    numeric cells - the SAME header-amount test pick_amount_column uses. verify_table's alt-column
    fallback uses this so a reconcile only CLEARS a failure on a legitimate (header-identified) amount
    column, never a coincidental reconcile on an unrelated (qty/serial) column (FIX 2)."""
    nc = len(counts)
    kws = tuple(k.lower() for k in keywords)
    headers = [" ".join(str(r[c]) for r in rows[:3] if c < len(r)).lower() for c in range(nc)]
    return {c for c in range(nc) if counts[c] >= 3 and any(k in headers[c] for k in kws)}

def _cfg_get(cfg, name, default):
    """Read a config attribute if a cfg object is supplied, else fall back to the literal
    default. Lets verify_table/tie-out work BEFORE ExtractConfig exists and AFTER (cfg passed)."""
    return getattr(cfg, name, default) if cfg is not None else default

def native_text_gate(cfg=None) -> int:
    """The ONE min-text threshold (chars) separating a native/digital PDF page from a scanned one.
    Reads .min_text off a cfg OR a PdfOptions (both expose it); default 50 = today's
    pipeline/pdf_extract/doc_layout routing, so out-of-the-box behaviour is unchanged."""
    return _cfg_get(cfg, "min_text", 50)

def is_native_text(text: str, cfg=None) -> bool:
    """True when a page's extractable text is long enough to read from the text layer instead of OCR
    (len >= the min-text gate). ONE definition shared by table_pdf/pdf_extract/doc_layout so every path
    agrees on the same page for the same threshold and --min-text is a real knob, not three hardcoded
    constants. Default 50 reproduces today's routing exactly (digital path byte-identical)."""
    return len((text or "").strip()) >= native_text_gate(cfg)

# ============================================================================
# UNTRUSTED-INPUT GUARDS (M3/M4/M5) - never crash / OOM / fabricate on a hostile file;
# route it to review with a clear reason. All caps have generous defaults so a LEGITIMATE
# document is completely unaffected.
# ============================================================================
def image_within_pixel_cap(w, h, cfg=None):
    """M3: True if an image of w x h pixels is safe to decode/composite (area <= max_image_megapixels).
    A crafted image DECLARING huge dimensions (a decompression bomb) is skipped BEFORE any Pixmap is
    allocated - dimensions come from the xref/image dict WITHOUT decoding. Unknown / non-positive
    dimensions -> False (cap defensively; never decode blind). cap<=0 disables the check."""
    try:
        w = int(w); h = int(h)
    except Exception:
        return False
    if w <= 0 or h <= 0:
        return False
    cap = _cfg_get(cfg, "max_image_megapixels", 300)
    if cap <= 0:
        return True
    return (w * h) <= cap * 1_000_000

def oversized_reason(path, cfg=None):
    """M3: pre-flight guard for untrusted input - a review reason if `path` exceeds the configured caps
    (max_file_mb, and for PDFs max_pages_per_doc; both 0 = OFF = default, so legitimate files are
    unaffected), else None. Cheap: a stat + (for PDFs) a page_count open. Lets pipeline/table_pdf fence
    a pathological file to review UNPROCESSED instead of OOM/stalling on it."""
    max_pages = _cfg_get(cfg, "max_pages_per_doc", 0)
    max_mb = _cfg_get(cfg, "max_file_mb", 0)
    if not max_pages and not max_mb:
        return None
    try:
        size_mb = os.path.getsize(str(path)) / (1024 * 1024)
    except Exception:
        size_mb = 0.0
    if max_mb and size_mb > max_mb:
        return "oversized: %.0f MB > cap %d MB - routed to review unprocessed" % (size_mb, max_mb)
    if max_pages and str(path).lower().endswith(".pdf"):
        try:
            import fitz as _f
            d = _f.open(str(path)); n = d.page_count; d.close()
            if n > max_pages:
                return "oversized: %d pages > cap %d - routed to review unprocessed" % (n, max_pages)
        except Exception:
            pass
    return None

def encrypted_reason(doc):
    """M4: a review reason if a fitz-opened PDF is password-protected (needs_pass), else None. Takes an
    opened doc (or any object exposing .needs_pass) so it is unit-testable with a stub and cheap for a
    caller that already has the doc open. Never raises."""
    try:
        if getattr(doc, "needs_pass", False):
            return "encrypted / password-protected PDF - cannot extract; supply the password or an unlocked copy"
    except Exception:
        pass
    return None

def _zip_bomb_verdict(total_unc, total_comp, cfg=None):
    """M5 pure predicate: given the summed UNCOMPRESSED/compressed bytes from a zip's central directory,
    return a review reason if it looks like a zip bomb (exceeds max_uncompressed_mb, or an absurd
    compression ratio on a non-trivial payload), else None. Unit-testable without a real archive."""
    max_mb = _cfg_get(cfg, "max_uncompressed_mb", 2048)
    max_ratio = _cfg_get(cfg, "max_compression_ratio", 200)
    if max_mb > 0 and total_unc > max_mb * 1024 * 1024:
        return "zip-bomb guard: %.0f MB uncompressed > cap %d MB - routed to review" % (
            total_unc / (1024 * 1024), max_mb)
    if (max_ratio > 0 and total_comp > 0 and total_unc > 50 * 1024 * 1024
            and (total_unc / total_comp) > max_ratio):
        return "zip-bomb guard: %.0fx compression on %.0f MB uncompressed (> %dx) - routed to review" % (
            total_unc / total_comp, total_unc / (1024 * 1024), max_ratio)
    return None

def zip_bomb_reason(path, cfg=None):
    """M5: cheap pre-open guard for OPC/zip containers (xlsx/xlsm/docx) - sum UNCOMPRESSED sizes from the
    central directory (ZipInfo.file_size, NO decompression) and flag a bomb via _zip_bomb_verdict.
    Not a zip / unreadable -> None (let the normal reader surface it). Generous defaults so a legitimate
    workbook is never flagged."""
    try:
        import zipfile
        if not zipfile.is_zipfile(str(path)):
            return None
        with zipfile.ZipFile(str(path)) as z:
            infos = z.infolist()
        return _zip_bomb_verdict(sum(i.file_size for i in infos),
                                 sum(i.compress_size for i in infos), cfg)
    except Exception:
        return None

def is_amount_cell(s: Cell) -> bool:
    """A cell that is ESSENTIALLY a number (a real amount), NOT prose that merely contains a
    digit ('80% of Value Quoted', 'Total Station 3'). Gates what may enter an amount column / a
    summed component, so a descriptive percentage or a labelled item never pollutes a tie-out.
    Devanagari digits are normalised first (Hindi/Marathi scans)."""
    t = str(s or "").strip().translate(_DEVA_DIGITS)
    if not any(ch.isdigit() for ch in t):
        return False
    core = (t.replace(",", "").replace(chr(0x20b9), "").replace("%", "").replace("(", "")
             .replace(")", "").replace("-", "").replace("Rs", "").replace("/", "").strip())
    try:
        float(core); return True
    except ValueError:
        return False

_TOTAL_KW = re.compile(r"\b(grand\s+total|sub[-\s]?total|total|say)\b", re.I)
_TOTAL_START = re.compile(r"^\s*(grand\s+total|sub[-\s]?total|total|say)\b", re.I)
_TOTAL_HI = ("कुल", "योग", "जोड़", "महायोग")           # total / sum / grand-total (Hindi/Marathi)
def is_total_label(label: str) -> bool:
    """True for a real TOTAL-row label (Total / Grand Total / Sub-Total / Say ... OR the Hindi
    कुल/योग/जोड़/महायोग). General + structural: English keywords must START a SHORT label (a total is
    a label, not a description) - so 'Total Road Work' / 'Grand Total' match, while 'Total quantity of
    steel as per IS' or a buried '...subtotal...' does NOT. Hindi: a short label containing a
    Devanagari total term. The arithmetic guard in verify_table (amount ~ sum of components) is the
    second line of defence for a short collision ('Total Station survey')."""
    s = (label or "").strip()
    if _TOTAL_START.match(s) and len(re.findall(r"[A-Za-z]+", _TOTAL_KW.sub("", s))) <= 3:
        return True
    if any(t in s for t in _TOTAL_HI) and len([w for w in s.split() if w]) <= 4:
        return True
    return False

_GRAND_START = re.compile(r"^\s*(grand\s+total|total|say)\b", re.I)   # FINAL/grand-total markers (line start)
_SUBTOTAL_LABEL = re.compile(r"\bsub[-\s]?total\b|\bamount\b[^()]*\(\s*\d|\bcarried\s+(?:over|forward)|\bbrought\s+forward", re.I)
def is_subtotal_label(label: str) -> bool:
    """A SUBTOTAL row that aggregates ONE section AND carries forward into the grand total -
    'Sub-Total', 'Amount (1) in Rs.', 'Amount O&M (2)', 'Carried/Brought Forward'. A label that
    STARTS with Total / Grand Total / Say is the grand total itself, never a subtotal (so
    'Total Amount (1+2)' is the grand total, but 'Sub-Total' / 'Amount (1)' are subtotals)."""
    s = (label or "").strip()
    if _GRAND_START.match(s):
        return False
    return bool(_SUBTOTAL_LABEL.search(s))

_TOTAL_ANY = re.compile(r"\btotal\b|\bgrand\b|\bsay\b|\bamount\b|\bsub[-\s]?total\b|कुल|योग|जोड़|महायोग", re.I)
def contains_total_kw(text):
    """Bilingual SUBSTRING check: does the text contain ANY total keyword (English or Hindi)? Used by
    the cross-page stitch (table_pdf) AND the Excel tie-out row-detector - ONE definition, so adding a
    language reaches every total-recognizer at once (the fragmentation the review flagged)."""
    return bool(_TOTAL_ANY.search(str(text or "")))

def ends_in_total(grid) -> bool:
    """True if a grid's LAST non-empty row is a total/grand-total => the table is COMPLETE, not a
    continuation. ONE definition shared by the cross-page stitch (doc_layout) and the reconcile
    grouping (reconcile_tables) so two distinct same-header tables, each ending in their own Total,
    are never merged. Uses both is_total_label (keyword STARTS a short label) and contains_total_kw
    (bilingual keyword anywhere) for robustness."""
    for row in reversed(grid or []):
        cells = [str(c) for c in row if str(c).strip()]
        if not cells:
            continue
        label = " ".join(cells)
        return is_total_label(label) or contains_total_kw(label)
    return False

def numeric_col_counts(rows: Grid) -> list:
    """Per-column count of numeric cells (parse_number succeeds), indexed by column; [] for an
    empty grid. The one idiom pick_amount_column's callers (verify_table here, doc_layout
    tombstones, reconcile_tables) share to locate the amount column - kept here so they never drift."""
    nc = max((len(r) for r in rows), default=0)
    return [sum(1 for r in rows if len(r) > c and parse_number(r[c]) is not None) for c in range(nc)]

def infer_amount_columns(rows: Grid) -> dict:
    """Infer {qty, rate, amount} column indices for ROW-LEVEL Qty*Rate=Amount validation.
    General: match headers (qty|quantity|nos, rate|unit rate|price, amount|total|value|cost) in
    the first 3 rows AND require each candidate column to be mostly numeric. Returns a dict with
    whichever of the three were confidently found (need all three to validate a row)."""
    nc = max((len(r) for r in rows), default=0)
    if nc < 3:
        return {}
    headers = [" ".join(str(r[c]) for r in rows[:3] if c < len(r)).lower() for c in range(nc)]
    numeric = [sum(1 for r in rows if c < len(r) and is_amount_cell(r[c])) for c in range(nc)]
    # bilingual role headers: (English word-regex, Hindi/Devanagari substring terms)
    pats = {"qty":    (r"\b(qty|quantity|nos|number)\b", ("मात्रा", "संख्या", "नग", "परिमाण")),
            "rate":   (r"\b(rate|unit\s*rate|price)\b",  ("दर", "मूल्य", "प्रति")),
            "amount": (r"\b(amount|total|value|cost)\b", ("राशि", "रकम", "कुल", "योग", "धनराशि"))}
    cols = {}
    for role, (en, hi) in pats.items():
        cands = [c for c in range(nc) if numeric[c] >= 2
                 and (re.search(en, headers[c]) or any(h in headers[c] for h in hi))]
        if cands:
            cols[role] = max(cands) if role == "amount" else min(cands)   # amount = rightmost
    return cols

def merged_numeric_cells(rows: Grid) -> list:
    """DATA cells that look like TWO rows collapsed into ONE: >=2 DISTINCT numeric tokens AND the cell is
    PREDOMINANTLY numeric. parse_number keeps only the FIRST number, so the rest is silently lost and a
    tie-out can still pass - ONE such cell should route the table to review. General across ruled AND
    borderless grids. Guarded so a wrapped description ('Providing 100 mm x 200 mm pipe as per IS 458'),
    'Rate per 100' or '2 nos' (<=1 distinct number, or mostly prose) NEVER flags - reuses is_amount_cell.
    Returns [(row_idx, col_idx)]."""
    out = []
    for ri, row in enumerate(rows):
        for ci, cell in enumerate(row):
            toks = str(cell if cell is not None else "").split()
            if len(toks) < 2:
                continue
            nums = [parse_number(t) for t in toks if is_amount_cell(t)]
            nums = [n for n in nums if n is not None]
            if len({round(n, 4) for n in nums}) >= 2 and len(nums) >= max(2, 0.6 * len(toks)):
                out.append((ri, ci))
    return out

_SERIAL_HDR = re.compile(r"\b(sr\.?\s*no\.?|s\.?\s*no\.?|sl\.?\s*no\.?|s\s*no|sno|item\s*no|serial)\b", re.I)
_SERIAL_HI = ("क्रम", "क्रमांक", "क्र.सं", "क्र सं", "क्र.")     # serial-no header (Hindi/Marathi)
def detect_serial_gaps(rows: Grid) -> list:
    """A Sr-No / serial column that SKIPS a number (1,2,3,5 -> 4 missing) is a DROPPED ROW - a
    completeness signal INDEPENDENT of geometry/OCR (so it catches drops the orphan audit can't).
    General + conservative: only a header-matched column whose values are MOSTLY consecutive
    integers is trusted (so a Qty column of integers is never mistaken for a serial). Returns
    [{column, missing, range}]."""
    nc = max((len(r) for r in rows), default=0)
    if nc == 0:
        return []
    headers = [" ".join(str(r[c]) for r in rows[:2] if c < len(r)) for c in range(nc)]
    out = []
    for c in (c for c in range(nc)
              if _SERIAL_HDR.search(headers[c]) or any(t in headers[c] for t in _SERIAL_HI)):
        seq = []
        for r in rows:
            v = parse_number(r[c]) if c < len(r) and is_amount_cell(r[c]) else None
            if v is not None and float(v).is_integer() and 0 < v < 100000:
                seq.append(int(v))
        if len(seq) < 3:
            continue
        inc = sum(1 for a, b in zip(seq, seq[1:], strict=False) if b == a + 1)
        if inc < 0.6 * (len(seq) - 1):          # not actually a running serial (e.g. a qty column)
            continue
        present, lo, hi = set(seq), min(seq), max(seq)
        missing = [n for n in range(lo, hi + 1) if n not in present]
        if missing:
            out.append({"column": c, "missing": missing[:20], "range": [lo, hi]})
    return out

# OCR digit confusions (numeric context only). The arithmetic ORACLE - not this map - decides
# what is accepted, so an over-broad map is safe: a substitution is only kept if it makes
# Qty*Rate=Amount hold AND is unambiguous.
_GLYPH_MAP = {"O": "0", "o": "0", "D": "0", "Q": "0", "l": "1", "I": "1", "|": "1", "i": "1",
              "Z": "2", "z": "2", "S": "5", "s": "5", "B": "8", "g": "9", "b": "6", "T": "7",
              "A": "4", "G": "6"}

def _cell_candidates(raw, glyph_map, max_amb=2):
    """All glyph-substitution variants of one numeric cell - substituting ONLY ambiguous chars
    that ACTUALLY appear (never invent a digit). Each variant returned as (value, string, n_subs);
    the original is NOT returned (callers add it). Capped to cells with <= max_amb ambiguous chars
    so the search can never blow up. Only variants that read as a clean amount are kept."""
    s = str(raw)
    pos = [i for i, ch in enumerate(s) if ch in glyph_map]
    if not pos or len(pos) > max_amb:
        return []
    out = {}
    for mask in range(1, 1 << len(pos)):                 # mask 0 = original (excluded)
        chars = list(s); nsub = 0
        for bit, i in enumerate(pos):
            if mask & (1 << bit):
                chars[i] = glyph_map[s[i]]; nsub += 1
        cand = "".join(chars)
        if is_amount_cell(cand):
            v = parse_number(cand)
            if v is not None and (cand not in out or nsub < out[cand][1]):
                out[cand] = (v, nsub)
    return [(v, cand, n) for cand, (v, n) in out.items()]

def repair_row_arithmetic(row, cols, *, glyph_map=None, rel=0.005, floor=1.0):
    """LEVER C: fix OCR digit slips in a BOQ row using the row's OWN arithmetic as an oracle.
    Returns (patched_row, fixes). A correction is accepted ONLY if it makes Qty*Rate=Amount hold.
    FALSE-ACCEPT GUARDS: (1) never touch a row that already reconciles; (2) only substitute glyphs
    present in the cell, <=2 per cell; (3) accept the MINIMUM-edit candidate; (4) if >1 distinct
    numeric result reconciles at the minimum edit distance, REFUSE (return unchanged + an
    'ambiguous' note) rather than guess. Every accepted fix is returned for the VERIFY audit -
    a digit-fixed row is a soft note, never a silent AUTO_ACCEPT. Only fires when qty+rate+amount
    were all inferred; abstracts/count tables get no row oracle."""
    gm = glyph_map or _GLYPH_MAP
    if not all(k in cols for k in ("qty", "rate", "amount")):
        return list(row), []
    iq, ir, ia = cols["qty"], cols["rate"], cols["amount"]
    if max(iq, ir, ia) >= len(row):
        return list(row), []
    raw = {iq: str(row[iq]), ir: str(row[ir]), ia: str(row[ia])}
    q0, r0, a0 = (parse_number(raw[iq]), parse_number(raw[ir]), parse_number(raw[ia]))
    if None in (q0, r0, a0):
        return list(row), []
    if abs(q0 * r0 - a0) <= max(floor, rel * abs(a0)):   # guard 1: already reconciles
        return list(row), []
    # option lists per cell = the original value (0 subs) + each substitution variant
    opts = {}
    for idx, v0 in ((iq, q0), (ir, r0), (ia, a0)):
        opts[idx] = [(v0, raw[idx], 0)] + _cell_candidates(raw[idx], gm)
    passing = []
    for (vq, sq, nq) in opts[iq]:
        for (vr, sr, nr) in opts[ir]:
            for (va, sa, na) in opts[ia]:
                if nq + nr + na == 0:                    # the original combo already failed
                    continue
                if abs(vq * vr - va) <= max(floor, rel * abs(va)):
                    passing.append((nq + nr + na, (vq, vr, va), {iq: sq, ir: sr, ia: sa}))
    if not passing:
        return list(row), []
    best = min(p[0] for p in passing)
    winners = [p for p in passing if p[0] == best]
    if len({p[1] for p in winners}) > 1:                 # guard 4: ambiguous -> refuse
        return list(row), [{"col": ia, "ambiguous": True, "old": raw[ia],
                            "candidates": [w[1] for w in winners][:5]}]
    _, _, strings = winners[0]
    patched, fixes = list(row), []
    for idx in (iq, ir, ia):
        if strings[idx] != raw[idx]:
            patched[idx] = strings[idx]
            fixes.append({"col": idx, "old": raw[idx], "new": strings[idx]})
    return patched, fixes

def validate_rows(rows: Grid, cols: dict, *, rel: float = 0.005, floor: float = 1.0) -> list:
    """ROW-LEVEL cross-validation: for every row with all of qty,rate,amount numeric, flag any
    where |qty*rate - amount| exceeds a scaled tolerance. This is the densest check available -
    every row becomes a test, not just the column total - so it catches per-row errors AND the
    error-cancellation case where two opposite slips leave the column total reconciling perfectly.
    General (runs on digital + scanned)."""
    if not all(k in cols for k in ("qty", "rate", "amount")):
        return []
    out = []
    for n, r in enumerate(rows):
        q  = parse_number(r[cols["qty"]])    if cols["qty"] < len(r)    and is_amount_cell(r[cols["qty"]])    else None
        rt = parse_number(r[cols["rate"]])   if cols["rate"] < len(r)   and is_amount_cell(r[cols["rate"]])   else None
        am = parse_number(r[cols["amount"]]) if cols["amount"] < len(r) and is_amount_cell(r[cols["amount"]]) else None
        if None in (q, rt, am):
            continue
        if abs(q * rt - am) > max(floor, rel * abs(am)):
            out.append({"row": n, "qty": q, "rate": rt, "amount": am, "expected": round(q * rt, 2)})
    return out

def _verify_col(rows, numcol, cfg=None):
    """Tie-out a SINGLE chosen amount column: Sigma(component rows) must equal each stated
    Total/Amount/Grand/Say within a rounding-scaled tolerance. Returns (flags, n_anchors) where
    n_anchors = how many total/subtotal rows anchored a tie-out (0 => the column was never checked
    against any total => 'amounts present but NOT verified', surfaced by verify_table)."""
    min_total = _cfg_get(cfg, "reconcile_min_total", 1000.0)
    per_row   = _cfg_get(cfg, "reconcile_round_rupees", 0.5)
    floor     = _cfg_get(cfg, "reconcile_abs_floor", 1.0)
    sub_cov   = _cfg_get(cfg, "reconcile_subtotal_min_coverage", 0.5)
    flags = []; comps = []; subtotals = []; anchors = 0
    def check(total_v, base, label):                           # Sigma(base) must equal a stated total
        if base and total_v >= min_total and total_v >= 0.5 * sum(base):
            diff = round(total_v - sum(base), 2)
            tol = round_tolerance(len(base), per_row=per_row, floor=floor)
            if abs(diff) > tol:
                flags.append({"total_label": label[:45] or "(total)", "stated": total_v,
                              "sum_of_rows": round(sum(base), 2), "gap": diff, "tol": tol})
    for r in rows:
        cell = r[numcol] if len(r) > numcol else None
        v = parse_number(cell) if is_amount_cell(cell) else None   # %-text / labelled item never sums (1.4)
        label = " ".join(str(x) for k, x in enumerate(r) if k != numcol and str(x).strip())
        if v is None:
            continue
        if is_subtotal_label(label):                           # 'Sub-Total','Amount (1)','Carried Fwd':
            anchors += 1
            if comps and sum(comps) >= sub_cov * v:            # verify the section ONLY when its visible
                check(v, comps, label)                         # items cover most of it (else it spans
            subtotals.append(v); comps = []                    # pages - flagging would be a false positive);
        elif is_total_label(label):                            # a near-complete shortfall = a dropped row.
            anchors += 1
            check(v, subtotals + comps, label)                 # GRAND total = carried subtotals + the
            comps = []; subtotals = []                         # remaining line items (Amount(1)+Amount(2),
        else:                                                  # or Sub-Total + post-subtotal charges)
            comps.append(v)
    return flags, anchors

def verify_table(rows: Grid, cfg=None, flag_unverified: bool = False) -> list[Flag]:
    """THE money tie-out (one definition, shared by table_pdf + doc_layout): pick the amount column
    (header-aware), tie it out (rounding-scaled tolerance), AND row-level cross-validate
    (Qty*Rate=Amount) + serial-gap. Returns flags (each {total_label, stated, sum_of_rows, gap, kind?}).

    flag_unverified=True (the production callers) ALSO emits a soft 'not_verified' marker when a real
    money column is present with significant values but NOTHING could check it - no total/subtotal row
    anchored a tie-out AND there is no Qty*Rate=Amount triple to cross-validate rows. This closes the
    silent hole where a price SUMMARY whose grand total is on another page AUTO_ACCEPTed with 0 flags:
    'amounts present, arithmetic NOT verified' is a review reason, never a silent pass. (Same guard the
    Excel path already enforces, now shared so PDFs honour it.)"""
    counts = numeric_col_counts(rows)
    if not counts:
        return []
    kw = _cfg_get(cfg, "amount_header_keywords", _DEF_AMT_KW)
    flags = []
    numcol = pick_amount_column(rows, counts, kw)
    anchors = 0
    if numcol is not None:
        col_flags, anchors = _verify_col(rows, numcol, cfg)
        if col_flags:                                          # header column didn't reconcile - try row-max
            alt = rowwise_max_column(rows, counts)
            # FIX 2: only let an ALT column CLEAR a genuine failure if it is itself a legitimate amount
            # column (header-identified as amount). A coincidental reconcile on an unrelated column - a
            # Qty/serial column that happens to sum to its own total - must NOT mask a real dropped row.
            hdr_amt = _header_amount_columns(rows, counts, kw)
            if alt is not None and alt != numcol and alt in hdr_amt:
                alt_flags, alt_anchors = _verify_col(rows, alt, cfg)
                if not alt_flags:
                    col_flags, anchors = alt_flags, alt_anchors
        flags.extend(col_flags)
    amt_cols = infer_amount_columns(rows)
    for rf in validate_rows(rows, amt_cols):
        flags.append({"total_label": "row %d: Qty*Rate != Amount" % (rf["row"] + 1),
                      "stated": rf["amount"], "sum_of_rows": rf["expected"],
                      "gap": round(rf["amount"] - rf["expected"], 2), "kind": "row_arith"})
    for g in detect_serial_gaps(rows):
        flags.append({"total_label": "serial gap (col %d): missing %s" % (g["column"], g["missing"]),
                      "stated": "range %s-%s" % (g["range"][0], g["range"][1]), "sum_of_rows": "",
                      "gap": "DROPPED-ROW?", "kind": "serial_gap"})
    # NOT-ATTEMPTED guard (opt-in): a header-identified money column with >=2 significant values, no
    # total/subtotal anchor, and no row-level Qty*Rate check -> amounts are present but were NEVER
    # verified. Surface it so the doc can't silently AUTO_ACCEPT (e.g. a cross-page price summary).
    if flag_unverified and numcol is not None and anchors == 0 and not flags:
        row_verifiable = all(k in amt_cols for k in ("qty", "rate", "amount"))
        amounts = [parse_number(r[numcol]) for r in rows if len(r) > numcol and is_amount_cell(r[numcol])]
        amounts = [a for a in amounts if a is not None]
        if not row_verifiable and len(amounts) >= 2 and max(amounts) >= _cfg_get(cfg, "reconcile_min_total", 1000.0):
            flags.append({"total_label": "(amounts present, no total row)", "stated": "",
                          "sum_of_rows": round(sum(amounts), 2), "gap": "NOT-VERIFIED", "kind": "not_verified"})
    # MERGED-CELL guard (FIX 1): a DATA cell holding >=2 distinct numbers is a suspected collapsed row -
    # parse_number keeps only the first, so the rest is silently lost. ONE such cell routes to review.
    # Runs on ruled AND borderless grids; guarded so prose / 'Rate per 100' / '2 nos' never flags.
    for (ri, ci) in merged_numeric_cells(rows):
        cell = str(rows[ri][ci])[:40]
        flags.append({"total_label": "row %d col %d: '%s' holds >=2 numbers (possible collapsed/merged row)"
                      % (ri + 1, ci, cell), "stated": cell, "sum_of_rows": "",
                      "gap": "MERGED-CELL?", "kind": "merged_cell"})
    return flags

def emit_worthy(rows: Grid) -> bool:
    """A grid is worth emitting as a table iff it has >1 non-empty cell. Empty page-frame boxes and
    lone-title fragments (a header/footer/'CONTENTS' the ruled-table path captured) are NOT tables -
    dropping them declutters the output with ZERO data loss: a <=1-cell box can't be a table or hold
    a dropped row, and its text still flows to the text/paragraph classifier. Shared by table_pdf
    (skip the .xlsx sheet) and doc_layout (skip the element AND its region-subtraction)."""
    return sum(1 for r in rows for c in r if str(c if c is not None else "").strip()) > 1

# ============================================================================
# CONFIG - one dataclass for every threshold (defaults == today's magic numbers,
# so no config + no new flags == byte-for-byte current behaviour)
# ============================================================================
@dataclass
class ExtractConfig:
    # accuracy / human-in-the-loop gate
    hitl_gate: float = 0.70
    # OCR / scanned ladder
    dpi: int = 300
    min_text: int = 50               # chars of extractable text >= this => a PDF page is read NATIVE (digital), else OCR'd.
                                     # 50 = today's pipeline/pdf_extract/doc_layout routing (byte-identical); shared by every path.
    lang: str = "eng+hin+mar"
    escalate_th: float = 0.88
    vlm: str = "off"
    vlm_th: float = 0.85
    vlm_agree_th: float = 0.5          # VLM may only become 'primary' if it agrees this much
    ocr_batch: int = 8
    ocr_window: int = 16              # pages OCR'd per memory window (flat RAM on huge scans)
    smart_lang: bool = True
    # tie-out / table reconcile
    reconcile_round_rupees: float = 0.5
    reconcile_abs_floor: float = 1.0
    reconcile_min_total: float = 1000.0
    reconcile_subtotal_min_coverage: float = 0.5   # verify a subtotal vs its items only when they cover
                                                   # >= this fraction (else the section spans pages)
    amount_header_keywords: tuple = _DEF_AMT_KW
    # external binaries (default "" / "soffice" = auto-probe today's Windows paths; override for Linux/server)
    tesseract_cmd: str = ""                    # "" = auto-detect; else explicit tesseract(.exe) path
    soffice_cmd: str = "soffice"               # LibreOffice headless (Excel formula recalc)
    # scanned cell-OCR + digit-repair + confidence calibration (B/C/F)
    scanned_cell_ocr: bool = False            # B: per-cell numeric-whitelist OCR (opt-in); else img2table
    numeric_whitelist: str = "0123456789.,()-/"
    cell_ocr_psm: int = 7
    digit_correct: bool = True                # C: arithmetic-gated digit repair on OCR grids (digital path unaffected)
    conf_calibration_path: str = ""           # F: calibration.json; "" = identity (today's 0.70 gate)
    # whole-document table handling
    stitch_cross_page: bool = True            # merge a table that continues onto the next page (so a
                                              # multi-page price summary reconciles as ONE table)
    # Excel<->PDF table reconciliation (opt-in; default OFF = digital layout byte-identical)
    reconcile_tables: bool = False            # tag uncertain tables (scanned/low-conf OR tie-out flagged)
                                              # as 'tombstones' eligible for authoritative-Excel override
    reconcile_align_rel: float = 0.01         # relative tolerance for a numeric anchor match
    reconcile_align_max_subs: int = 2         # max OCR-glyph substitutions for a fuzzy numeric match
    reconcile_anchor_th: float = 0.85         # min row score to be a confident alignment anchor
    reconcile_anchor_max_dup: int = 3         # a value occurring more than this often can't anchor (ambiguous)
    reconcile_min_anchors: int = 2            # below this -> fall back to count/reading-order alignment
    reconcile_min_anchor_density: float = 0.1 # anchors/rows below this -> fallback
    reconcile_gap_slack: int = 2              # tolerated row-count delta in a segment / count-reconcile gate
    reconcile_segment_conf_gate: float = 0.70 # a segment below this confidence forces human approval
    reconcile_scale_min_frac: float = 0.6     # a single 10^k scale factor must explain >= this frac to apply
    # Excel<->PDF reconcile: CONTEXT tie-breakers (numeric anchor stays PRIMARY; these only nudge the
    # confidence +/- so a numbers-coincidence with clashing headers/section holds for a human).
    reconcile_w_header: float = 0.12          # header-row token-similarity weight (sim 1 -> +w, sim 0 -> -w, 0.5 -> 0)
    reconcile_w_section: float = 0.08         # section_path vs Excel sheet-name similarity weight (same +/- scaling)
    reconcile_caption_bonus: float = 0.10     # MATCHING 'Table X.Y'/'Schedule H'/'Annexure B' token -> confidence bonus
    reconcile_caption_penalty: float = 0.25   # CONTRADICTING caption token (same kind, different number) -> penalty
    # large-file / pathological-input guards (scale safety)
    max_pages_per_doc: int = 0                # 0 = off; else a doc with more pages -> routed to review unprocessed
    max_file_mb: int = 0                      # 0 = off; else a file larger than this -> routed to review unprocessed
    max_image_megapixels: int = 300           # M3: skip an embedded image whose w*h exceeds this (decompression-bomb
                                              # guard) BEFORE a native-res Pixmap is allocated (0 = off). 300 MP covers
                                              # a 300-DPI A0 scan (~139 MP) with margin; stops a crafted 50k*50k (2500 MP).
    max_uncompressed_mb: int = 2048           # M5: OPC/zip (xlsx/docx) total uncompressed cap from the central directory
    max_compression_ratio: int = 200          # M5: absurd uncompressed/compressed ratio on a >50 MB payload = a zip bomb
    # scanned WHOLE-DOCUMENT layout (doc_layout --ocr-scanned; OFF by default = today's behaviour)
    layout_ocr_scanned: bool = False          # reconstruct scanned pages into the element stream (else stub)
    scanned_gpu_lane: bool = False            # route scanned PDFs to the SERIAL warm-model GPU lane (opt-in:
                                              # prevents docTR being forked across CPU workers on a VRAM-tight
                                              # box / scan-heavy corpus; default OFF = fast parallel CPU pool)
    layout_ocr_conf_gate: float = 0.70        # a scanned page below this OCR confidence -> human review
    scanned_figures: bool = False             # detect figure regions on scans (off in v1; conservative)
    # completeness / commit policy
    completeness_strict: bool = False
    # scale / batch
    max_workers: int = 1             # 1 = serial (today's behaviour); 0 = auto; N = N workers
    per_file_timeout: int = 0        # seconds; 0 = no timeout (a hung file is killed + logged)
    resume: bool = False
    gpu_workers: int = 1             # RESERVED: GPU lane is serial in-parent; dual-GPU not yet wired
    # logging
    log_json: str = ""
    log_level: str = "INFO"

    @classmethod
    def load(cls, path=None, overrides=None):
        """defaults -> optional config.yaml -> CLI overrides (only keys that are set)."""
        data = {}
        if path:
            data.update(_load_yaml(path))
        if overrides:
            data.update({k: v for k, v in overrides.items() if v is not None})
        cfg = cls()
        for k, v in data.items():
            if not hasattr(cfg, k):
                TW(f"[config] ignoring unknown key: {k}"); continue
            if k == "amount_header_keywords" and isinstance(v, list):
                v = tuple(v)                       # yaml gives a list; the field is a tuple
            setattr(cfg, k, v)
        return cfg

    def to_pdf_options(self):
        """Plain dict of PdfOptions kwargs - keeps common a LEAF (pdf_extract does
        PdfOptions(**cfg.to_pdf_options())), no import of pdf_extract here."""
        return {"dpi": self.dpi, "lang": self.lang, "escalate_th": self.escalate_th,
                "vlm": self.vlm, "vlm_th": self.vlm_th, "batch": self.ocr_batch,
                "smart_lang": self.smart_lang, "ocr_window": self.ocr_window,
                "vlm_agree_th": self.vlm_agree_th, "min_text": self.min_text}

    def asdict(self):
        return asdict(self)

def load_calibration(path):
    """LEVER F: return a function mapping a reported confidence -> a CALIBRATED confidence
    (observed accuracy), read from a calibration.json (run_ocr_eval --calibrate). IDENTITY when
    path is empty or the file is missing/unusable - so with NO gold set the 0.70 gate behaves
    EXACTLY as today (back-compat). Piecewise-linear over the per-bin (mean_conf -> 1-error_rate)
    points, monotone-clamped at the ends."""
    if not path:
        return (lambda c: c)
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        pts = sorted((b["mean_conf"], 1 - b["error_rate"]) for b in data.get("bins", [])
                     if b.get("count") and b.get("mean_conf") is not None and b.get("error_rate") is not None)
        if not pts:
            return (lambda c: c)
        def cal(c):
            if c is None:
                return c
            if c <= pts[0][0]:
                return pts[0][1]
            if c >= pts[-1][0]:
                return pts[-1][1]
            for (x0, y0), (x1, y1) in zip(pts, pts[1:], strict=False):
                if x0 <= c <= x1:
                    return y0 + (y1 - y0) * ((c - x0) / (x1 - x0) if x1 > x0 else 0.0)
            return c
        return cal
    except Exception:
        return (lambda c: c)

def _load_yaml(path):
    """Read a config.yaml if PyYAML is present and the file exists; otherwise degrade
    gracefully to defaults (a missing optional dep must never crash a run)."""
    try:
        import yaml
    except Exception:
        TW("[config] PyYAML not installed - config file ignored, using defaults/CLI"); return {}
    try:
        p = Path(path)
        if not p.exists():
            TW(f"[config] {path} not found - using defaults/CLI"); return {}
        return yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    except Exception as e:
        TW(f"[config] failed to read {path}: {e} - using defaults/CLI"); return {}

def add_config_args(ap):
    """Cross-cutting flags shared by EVERY entrypoint (config + scale + strict + logging).
    All default to None so 'unset' is distinguishable from an explicit value -> config.yaml
    fills the gaps and only flags the user actually passed override it. Per-extractor flags
    (--dpi/--lang/--gate/...) keep their own None defaults and are mapped in config_from_args."""
    ap.add_argument("--config", default=None, help="optional config.yaml of thresholds")
    ap.add_argument("--strict", dest="strict", action="store_const", const=True, default=None,
                    help="strict completeness: withhold NEEDS_REVIEW files from the committed set")
    ap.add_argument("--workers", dest="workers", type=int, default=None,
                    help="file-level parallel workers (1 = serial = today's behaviour; 0 = auto)")
    ap.add_argument("--timeout", dest="timeout", type=int, default=None,
                    help="per-file timeout seconds (0 = none); a hung file is killed + logged")
    ap.add_argument("--resume", dest="resume", action="store_const", const=True, default=None,
                    help="skip files whose output already exists")
    ap.add_argument("--gpu-workers", dest="gpu_workers", type=int, default=None,
                    help="RESERVED (not yet wired): GPU lane currently runs serial in-parent so the "
                         "docTR model is reused and never forked. Dual-GPU pinning is future work.")
    ap.add_argument("--log-json", dest="log_json", default=None, help="write a JSON run-log here")
    ap.add_argument("--scanned-cell-ocr", dest="scanned_cell_ocr", action="store_const", const=True,
                    default=None, help="B: per-cell numeric-whitelist OCR for scanned tables (opt-in; "
                                       "default is img2table). Falls back to img2table on a degenerate grid.")
    ap.add_argument("--no-digit-correct", dest="no_digit_correct", action="store_true",
                    help="C: disable arithmetic-gated OCR digit repair on scanned grids (on by default).")
    ap.add_argument("--calibration", dest="calibration", default=None,
                    help="F: path to calibration.json (from run_ocr_eval --calibrate) used to calibrate "
                         "the HITL gate. Default empty = identity = today's raw 0.70 gate.")
    ap.add_argument("--min-text", dest="min_text", type=int, default=None,
                    help="chars of extractable text at/above which a PDF page is read as NATIVE (digital) "
                         "instead of OCR'd (default 50). Lower it to treat sparse pages as digital.")
    ap.add_argument("--tesseract", dest="tesseract_cmd", default=None,
                    help="explicit tesseract(.exe) path (default: auto-detect Windows install / PATH)")
    ap.add_argument("--soffice", dest="soffice_cmd", default=None,
                    help="LibreOffice 'soffice' command/path for Excel formula recalc (default: soffice on PATH)")

# map an args namespace -> ExtractConfig field (only the keys present + set)
_ARG2CFG = {"gate": "hitl_gate", "dpi": "dpi", "lang": "lang", "min_text": "min_text",
            "batch": "ocr_batch", "ocr_window": "ocr_window", "escalate_th": "escalate_th",
            "vlm": "vlm", "vlm_th": "vlm_th", "vlm_agree_th": "vlm_agree_th",
            "strict": "completeness_strict", "workers": "max_workers",
            "timeout": "per_file_timeout", "resume": "resume", "gpu_workers": "gpu_workers",
            "log_json": "log_json", "scanned_cell_ocr": "scanned_cell_ocr",
            "calibration": "conf_calibration_path", "tesseract_cmd": "tesseract_cmd",
            "soffice_cmd": "soffice_cmd"}

def apply_external_paths(cfg):
    """Apply a configured tesseract path so a Linux/server box can point at its own binary; a no-op
    when tesseract_cmd is '' (default), which keeps today's Windows auto-probe unchanged. Sets both
    pytesseract.tesseract_cmd (docTR-ladder + cell-OCR) and prepends its dir to PATH (img2table)."""
    cmd = _cfg_get(cfg, "tesseract_cmd", "")
    if not cmd:
        return
    try:
        import os

        import pytesseract
        pytesseract.pytesseract.tesseract_cmd = cmd
        os.environ["PATH"] += os.pathsep + str(Path(cmd).parent)
    except Exception:
        pass

def config_from_args(a):
    """Build an ExtractConfig from defaults -> config.yaml (--config) -> the CLI flags the
    user actually set. Existing per-extractor flags default to None so they don't clobber
    config.yaml unless passed."""
    overrides = {arg_to: getattr(a, arg_from, None)
                 for arg_from, arg_to in _ARG2CFG.items() if getattr(a, arg_from, None) is not None}
    if getattr(a, "no_smart_lang", False):
        overrides["smart_lang"] = False
    if getattr(a, "no_digit_correct", False):
        overrides["digit_correct"] = False
    return ExtractConfig.load(getattr(a, "config", None), overrides)

# ============================================================================
# LOGGING - tqdm-safe console + an optional JSON run-log (C4)
# ============================================================================
def get_logger(name="kbextract"):
    """Every module does `log = get_logger(__name__)`. All loggers are children of the
    'kbextract' logger configured once by configure_logging()."""
    return logging.getLogger("kbextract" if name in (None, "__main__") else f"kbextract.{name}")

class _TqdmHandler(logging.StreamHandler):
    """Console handler that writes through tqdm.write (TW) so a log line never shreds a live bar."""
    def emit(self, record):
        try: TW(self.format(record))
        except Exception: self.handleError(record)

class _JsonFormatter(logging.Formatter):
    def format(self, record):
        obj = {"level": record.levelname, "logger": record.name, "msg": record.getMessage()}
        ej = getattr(record, "extra_json", None)
        if isinstance(ej, dict): obj.update(ej)
        return json.dumps(obj, ensure_ascii=False, default=str)

_LOG_CONFIGURED = False
def configure_logging(cfg=None, run_dir=None):
    """Idempotent: a tqdm-safe console handler (human output) + an optional JSON file handler
    (cfg.log_json, else run_dir/run.log.jsonl). Multi-process safe because workers do NOT share
    a FileHandler - per-file records travel back in the result and the PARENT writes the JSON
    run-log (see write_run_log). Safe to call from every main()."""
    global _LOG_CONFIGURED
    logger = logging.getLogger("kbextract")
    level = getattr(logging, str(_cfg_get(cfg, "log_level", "INFO")).upper(), logging.INFO)
    logger.setLevel(level)
    if not _LOG_CONFIGURED:
        ch = _TqdmHandler(); ch.setFormatter(logging.Formatter("%(message)s")); ch.setLevel(level)
        logger.addHandler(ch); logger.propagate = False
        _LOG_CONFIGURED = True
    path = _cfg_get(cfg, "log_json", "") or (str(Path(run_dir) / "run.log.jsonl") if run_dir else "")
    if path and not any(isinstance(h, logging.FileHandler) and getattr(h, "baseFilename", "") == str(Path(path).resolve())
                        for h in logger.handlers):
        try:
            fh = logging.FileHandler(path, encoding="utf-8"); fh.setFormatter(_JsonFormatter()); fh.setLevel(level)
            logger.addHandler(fh)
        except Exception:
            pass
    return logger

def write_run_log(summary, outroot):
    """Parent writes ONE JSON object per file to run_log.jsonl - the queryable record of a
    batch (status, confidence, reasons) so failures in a 10k-file run are greppable. Race-free
    (single writer), which is why workers return records rather than logging to a shared file."""
    try:
        with open(Path(outroot) / "run_log.jsonl", "w", encoding="utf-8") as f:
            for r in summary:
                f.write(json.dumps({"event": "file_done", "file": r.get("file"),
                                    "stem": r.get("stem"), "family": r.get("family"),
                                    "status": r.get("status"),
                                    "overall_confidence": r.get("overall_confidence"),
                                    "needs_review": r.get("needs_review"),
                                    "reasons": r.get("reasons")}, ensure_ascii=False) + "\n")
    except Exception:
        pass

# ============================================================================
# COMPLETENESS GATE - one shared verdict used by every extractor (C2)
# ============================================================================
def completeness_status(*, sig_orphans=0, tieout_gaps=0, dropped_pages=0, errored_pages=0,
                        low_conf=False, hard_fail=0, extra_reasons=None):
    """The single source of truth for AUTO_ACCEPT vs NEEDS_REVIEW. A document needs review
    iff ANY completeness signal fires: a SIGNIFICANT unplaced in-table row (sig_orphans -
    digit-bearing, see robust_tables._orphan_significant), a failed money tie-out, a page that
    could not be extracted, a page that errored, mean OCR confidence below the gate, or a hard
    checksum failure. `strict` does NOT live here - it changes COMMIT eligibility (whether a
    NEEDS_REVIEW file is withheld), not the verdict, and is applied by the batch driver."""
    reasons = list(extra_reasons or [])
    if sig_orphans:   reasons.append(f"{sig_orphans} unplaced in-table data row(s) - possible dropped row")
    if tieout_gaps:   reasons.append(f"{tieout_gaps} table(s) fail the money tie-out")
    if dropped_pages: reasons.append(f"{dropped_pages} page(s) not extracted (scanned/unreadable)")
    if errored_pages: reasons.append(f"{errored_pages} page(s) errored during extraction")
    if low_conf:      reasons.append("mean OCR confidence below gate")
    if hard_fail:     reasons.append(f"{hard_fail} hard checksum failure(s)")
    return ("NEEDS_REVIEW" if reasons else "AUTO_ACCEPT"), reasons

# ============================================================================
# OUTPUT - canonical per-document manifest + previews
# ============================================================================
def write_outputs(path, family, pages, fields, chunks, full_text, gate, docdir, stem, calib=None):
    """Write <stem>.doc.json + <stem>.chunks.jsonl + <stem>.preview.html and
    return the one-row summary used by the review queue. Works for every family
    because every extractor emits the same page/chunk shape."""
    # ---- confidence model ---------------------------------------------------
    # overall = TOKEN-WEIGHTED mean page confidence: pages with more text count
    # more, so photo/chart/blank pages can't drag down a well-read document.
    num_pages = [p for p in pages if isinstance(p["confidence"], (int, float))]
    if num_pages:
        wsum = sum(max(p.get("chars", 0), 1) for p in num_pages)
        ocr_conf = round(sum(p["confidence"] * max(p.get("chars", 0), 1) for p in num_pages) / wsum, 3)
    else:
        ocr_conf = 0.0
    # only HARD checksums (PAN/GSTIN/Aadhaar/IFSC) are true errors -> force review
    hard = ("pan", "gstin", "ifsc", "aadhaar")
    hard_fail = [k for k, f in fields.items() if k in hard and f["reconciled"] is False]
    # COMPLETENESS signals visible at this layer: a page that produced nothing (dropped) and
    # a failed structured tie-out (Excel sets pages[*]['tieout_failed']). Orphan/table tie-out
    # counts live in the table_pdf / doc_layout drivers, which call completeness_status directly.
    dropped_pages = sum(1 for p in pages if p.get("route") == "scanned_no_cv2"
                        or (isinstance(p["confidence"], (int, float)) and p["confidence"] == 0.0))
    tie_fail = sum(1 for p in pages if p.get("tieout_failed"))
    tie_not_run = sum(1 for p in pages if p.get("tieout_not_attempted"))   # money present but no total row found
    uncached = sum(p.get("uncached_formulas", 0) for p in pages)   # Excel un-cached formulas (1.1)
    overall = ocr_conf
    # LEVER F: gate on CALIBRATED confidence (observed accuracy). Identity by default, so with no
    # calibration.json this is byte-for-byte today's raw-confidence gate.
    cal = calib or (lambda c: c)
    gate_conf = cal(overall)
    low_pages = [p["page"] for p in pages
                 if isinstance(p["confidence"], (int, float)) and cal(p["confidence"]) < gate]
    extra = []
    if uncached:
        extra.append(f"{uncached} formula cell(s) have no cached value (None) - open/recalc the source workbook")
    if tie_not_run:
        extra.append("money tie-out NOT attempted - amounts present but no total row detected (verify; "
                     "passed=None must never read as verified)")
    if gate_conf < gate:
        extra.append(f"mean OCR confidence {overall:.2f}{'' if gate_conf == overall else f' (calibrated {gate_conf:.2f})'} "
                     f"< gate {gate} (install Tesseract for a 2nd-engine vote to raise it)")
    for k in hard_fail: extra.append(f"{k} failed checksum")
    if low_pages: extra.append(f"{len(low_pages)} page(s) below gate: {low_pages[:10]}")
    # detailed low-conf / hard-fail / below-gate lines are already in `extra`; pass only the
    # STRUCTURED signals so reasons aren't duplicated. Any non-empty reason -> NEEDS_REVIEW.
    status, reasons = completeness_status(
        tieout_gaps=tie_fail, dropped_pages=dropped_pages, extra_reasons=extra)
    needs_review = status == "NEEDS_REVIEW"
    dc = doc_class(stem)
    docj = {"file": str(path), "family": family, "doc_class": dc,
            "ocr_confidence": ocr_conf, "overall_confidence": round(overall, 3),
            "calibrated_confidence": round(gate_conf, 3),
            "status": status, "needs_review": needs_review, "review_reasons": reasons,
            "pages": pages, "fields": fields}
    atomic_write_text(docdir / f"{stem}.doc.json", json.dumps(docj, indent=2, ensure_ascii=False))
    atomic_write_text(docdir / f"{stem}.chunks.jsonl",
                      "".join(json.dumps({"doc_id": stem, "chunk_ix": ix, **c}, ensure_ascii=False) + "\n"
                              for ix, c in enumerate(chunks)))
    rows = []
    for k, fl in fields.items():
        color = "red" if (fl["confidence"] < gate or fl["reconciled"] is False) else "green"
        rows.append(f"<tr><td>{k}</td><td style='color:{color}'>{html.escape(str(fl['value']))}</td>"
                    f"<td>{fl['confidence']}</td><td>{fl['reconciled']}</td></tr>")
    pg = []
    for p in pages:
        img = f"<img src='pages/{Path(p['png']).name}' style='max-width:480px'>" if p.get("png") else ""
        pg.append(f"<div><b>page {p['page']}</b> ({p['route']}, conf {p['confidence']}) {img}</div>")
    flag = 'REVIEW' if needs_review else 'OK'
    htmlt = (f"<html><meta charset='utf-8'><body style='font-family:sans-serif'>"
             f"<h2>{html.escape(stem)} - {dc} - overall {overall:.2f} [{flag}]</h2>"
             f"<table border=1 cellpadding=4><tr><th>field</th><th>value</th><th>conf</th><th>reconciled</th></tr>"
             f"{''.join(rows)}</table><hr>{''.join(pg)}"
             f"<hr><pre style='white-space:pre-wrap'>{html.escape(full_text[:5000])}</pre></body></html>")
    atomic_write_text(docdir / f"{stem}.preview.html", htmlt)
    mark_done(docdir)                          # H2: sentinel LAST -> --resume trusts .done, never a partial output
    return {"file": str(path), "stem": stem, "family": family, "doc_class": dc,
            "overall_confidence": round(overall, 3), "status": status,
            "needs_review": needs_review, "fields": len(fields), "reasons": ";".join(reasons)}

# ============================================================================
# BATCH SAFETY - one bad file never aborts a run of thousands (general, any input)
# ============================================================================
def _write_errlog(errors, errlog, n_total):
    if errors:
        TW(f"[batch continued] {len(errors)} file(s) FAILED out of {n_total}")
        if errlog:
            try:
                Path(errlog).write_text(json.dumps(errors, indent=2), encoding="utf-8")
                TW(f"[errors logged -> {errlog}]")
            except Exception:
                pass

# ============================================================================
# PARALLEL BATCH DRIVER - file-level parallelism + resume + KILLABLE timeout (C3)
# ============================================================================
def _resolve_workers(cfg):
    import os
    mw = _cfg_get(cfg, "max_workers", 1)
    if mw and mw > 0:
        return mw
    cores = os.cpu_count() or 2          # 0 = auto: cores-1, capped so many big PDFs don't OOM
    return max(1, min(cores - 1, 16))

def _proc_target(worker, fp, worker_args, out_q):
    """Child entry: run worker(path, args) and post the (picklable) result back. Top-level so
    it survives Windows 'spawn'."""
    try:
        out_q.put(("ok", str(fp), worker(fp, worker_args)))
    except Exception as e:
        out_q.put(("err", str(fp), f"{type(e).__name__}: {e}"))

def _gpu_loop(in_q, out_q, worker, worker_args):
    """Persistent GPU-lane child: hold ONE warm model and process files pulled from in_q one at a
    time, posting each (picklable) result to out_q. The parent kills + respawns this child ONLY when
    a file hangs, so the warm model is reused across the common case while a hung scan can never
    block the run forever. Top-level so it survives 'spawn'."""
    while True:
        fp = in_q.get()
        if fp is None:
            break
        try:
            out_q.put(("ok", worker(fp, worker_args)))
        except Exception as e:
            out_q.put(("err", f"{type(e).__name__}: {e}"))

def _pool_with_timeout(files, worker, worker_args, workers, timeout, label):
    """A managed multiprocessing pool where the parent KILLS any worker whose file exceeds
    `timeout` (Windows has no SIGALRM, and future.result(timeout) would leave the worker running
    forever holding a slot). A timed-out file is terminate()/kill()'d, recorded, and its slot
    is freed for the next file - so a few pathological PDFs cannot starve the whole run."""
    import multiprocessing as mp
    import time
    ctx = mp.get_context("spawn")
    out_q = ctx.Queue()
    pending = list(files); running = {}; results, errors = [], []
    bar = tqdm(total=len(files), desc=f"{label} (kill@{timeout}s)", unit="file")
    def _finish(info, ok, payload):
        if ok: results.append(payload)
        else:
            errors.append({"file": str(info["file"]), "error": payload}); TW(f"[ERROR] {info['file']}: {payload}")
        bar.update(1)
    while pending or running:
        while pending and len(running) < workers:                    # fill free slots
            fp = pending.pop(0)
            p = ctx.Process(target=_proc_target, args=(worker, fp, worker_args, out_q), daemon=False)
            p.start(); running[p.pid] = {"proc": p, "file": fp, "start": time.monotonic(), "result": None}
        try:                                                          # drain finished results
            while True:
                tag, fpath, payload = out_q.get(timeout=0.1)
                for info in running.values():
                    if str(info["file"]) == fpath: info["result"] = (tag == "ok", payload)
        except Exception:
            pass
        for pid, info in list(running.items()):                       # reap done / crashed / timed-out
            p = info["proc"]
            if info["result"] is not None:
                p.join(timeout=2); _finish(info, *info["result"]); del running[pid]
            elif not p.is_alive():
                p.join(timeout=1); _finish(info, False, "worker exited without a result (crash)"); del running[pid]
            elif time.monotonic() - info["start"] > timeout:
                p.terminate(); p.join(timeout=2)
                if p.is_alive(): p.kill(); p.join(timeout=2)          # the KILL the reviewer required
                _finish(info, False, f"TIMEOUT after {timeout}s (worker killed)")
                TW(f"[TIMEOUT] {info['file']} killed after {timeout}s"); del running[pid]
    bar.close()
    return results, errors

def _gpu_serial_killable(gpu_files, worker, worker_args, timeout, label):
    """The GPU lane WITH a per-file kill-on-timeout. One persistent child holds the warm model and
    pulls files one at a time; if a file exceeds `timeout` the child is terminate()/kill()'d, the
    file recorded as a timeout, and a FRESH child spawned (reloads the model) for the rest. So the
    warm-model fast path survives, but one hung scanned PDF can no longer hang the entire run."""
    import multiprocessing as mp
    import queue as _queue
    ctx = mp.get_context("spawn")
    results, errors = [], []
    bar = tqdm(total=len(gpu_files), desc=f"{label} (GPU kill@{timeout}s)", unit="file")
    def _spawn():
        iq, oq = ctx.Queue(), ctx.Queue()
        p = ctx.Process(target=_gpu_loop, args=(iq, oq, worker, worker_args), daemon=True)
        p.start(); return p, iq, oq
    proc, inq, outq = _spawn()
    for fp in gpu_files:
        if proc is None or not proc.is_alive():
            proc, inq, outq = _spawn()                     # respawn a warm child after a kill/crash
        inq.put(str(fp))
        try:
            tag, payload = outq.get(timeout=timeout)
            if tag == "ok":
                results.append(payload)
            else:
                errors.append({"file": str(fp), "error": payload}); TW(f"[ERROR] {fp}: {payload}")
        except _queue.Empty:                               # the file hung -> kill + respawn
            try:
                proc.terminate(); proc.join(timeout=2)
                if proc.is_alive(): proc.kill(); proc.join(timeout=2)
            except Exception:
                pass
            errors.append({"file": str(fp), "error": f"TIMEOUT after {timeout}s (GPU worker killed)"})
            TW(f"[TIMEOUT] {fp} killed after {timeout}s (GPU lane)")
            proc = None
        bar.update(1)
    try:
        if proc is not None and proc.is_alive():
            inq.put(None); proc.join(timeout=5)
    except Exception:
        pass
    bar.close()
    return results, errors

def parallel_foreach(files, worker, worker_args=None, *, label="Processing", errlog=None,
                     cfg=None, is_gpu=None, done_marker=None):
    """Run worker(path, worker_args) for every file with per-file crash isolation + optional
    file-level PARALLELISM, RESUME and a killable per-file TIMEOUT. Delegates to a plain serial loop
    when max_workers == 1 (today's behaviour, zero risk).

    worker MUST be a top-level (picklable) function and worker_args picklable (pass cfg.asdict(),
    paths as strings) so they survive Windows 'spawn'. Lanes: is_gpu(path) True -> GPU lane, run
    SERIALLY in the parent so the docTR model is reused and never forked across the pool; CPU lane
    -> a process pool (killable when a timeout is set). Returns (results, errors)."""
    files = list(files)
    results, errors = [], []
    resume = bool(_cfg_get(cfg, "resume", False))
    if resume and done_marker:                                        # RESUME: skip already-done files
        kept = []
        for fp in files:
            try:
                if done_marker(fp):
                    TW(f"[resume] skip {getattr(fp, 'name', fp)} (output exists)"); continue
            except Exception:
                pass
            kept.append(fp)
        files = kept
    if not files:
        return results, errors
    workers = _resolve_workers(cfg)
    timeout = int(_cfg_get(cfg, "per_file_timeout", 0) or 0)
    if timeout <= 0 and workers > 1:                                   # P0-5 SAFER DEFAULT: once the
        timeout = 1800                                                 # parallel path is engaged, bound a
    # (workers==1 stays serial + unbounded = today's behaviour; an explicit --timeout overrides.)  hung file
    gpu_of = is_gpu or (lambda p: False)
    cpu_files = [f for f in files if not gpu_of(f)]
    gpu_files = [f for f in files if gpu_of(f)]

    def _serial(fl, lbl):
        for fp in (tqdm(fl, desc=lbl, unit="file") if fl else []):
            try:
                results.append(worker(fp, worker_args))
            except KeyboardInterrupt:
                raise
            except Exception as e:
                errors.append({"file": str(fp), "error": f"{type(e).__name__}: {e}"})
                TW(f"[ERROR] {getattr(fp, 'name', fp)}: {type(e).__name__}: {e}")

    if gpu_files:                                                      # GPU lane: warm model, never forked
        if timeout > 0:                                                # ...but KILL+respawn a hung scan (P0-2)
            r, e = _gpu_serial_killable(gpu_files, worker, worker_args, timeout, label)
            results += r; errors += e
        else:
            _serial(gpu_files, f"{label} (GPU serial)")
    if cpu_files:
        if workers <= 1:
            _serial(cpu_files, label)
        elif timeout > 0:
            r, e = _pool_with_timeout(cpu_files, worker, worker_args, workers, timeout, label)
            results += r; errors += e
        else:
            from concurrent.futures import ProcessPoolExecutor, as_completed
            ex = ProcessPoolExecutor(max_workers=workers)
            try:
                futs = {ex.submit(worker, fp, worker_args): fp for fp in cpu_files}
                for fut in tqdm(as_completed(futs), total=len(futs), desc=label, unit="file"):
                    fp = futs[fut]
                    try:
                        results.append(fut.result())
                    except Exception as e:
                        errors.append({"file": str(fp), "error": f"{type(e).__name__}: {e}"})
                        TW(f"[ERROR] {getattr(fp, 'name', fp)}: {type(e).__name__}: {e}")
            finally:
                ex.shutdown(wait=True)
    _write_errlog(errors, errlog, len(files))
    return results, errors


# ============================================================================
# BATCH DRIVER - one place that loops files + writes the run-level outputs
# ============================================================================
def run_batch(files, dispatch, gate, outroot, *, label="Extracting", cfg=None,
              worker=None, worker_args=None, is_gpu=None):
    """Drive a batch: for each file call `dispatch(path, docdir, png_dir)` which
    returns (family, pages, fields, chunks, full_text) or None to skip, then
    write its manifest and accumulate the run summary.

    Used by BOTH pipeline.py (dispatch routes by file type) and each standalone
    extractor's main() (dispatch is just that one extractor) - so the review
    queue / run summary logic exists in exactly ONE place.

    PARALLEL path: if a top-level (picklable) `worker(path, worker_args)->summary_row` is given
    AND the user asked for parallelism / a timeout / resume, fan out via parallel_foreach
    (CPU files in a pool, scanned/GPU files serial). Otherwise the serial dispatch path runs -
    so --workers 1 with no timeout/resume is byte-for-byte today's behaviour."""
    use_parallel = worker is not None and (
        _cfg_get(cfg, "max_workers", 1) != 1 or _cfg_get(cfg, "per_file_timeout", 0)
        or _cfg_get(cfg, "resume", False))
    if use_parallel:
        results, _ = parallel_foreach(
            files, worker, worker_args, label=label, errlog=str(outroot / "_errors.json"),
            cfg=cfg, is_gpu=is_gpu,
            done_marker=lambda fp: (doc_outdir(outroot, fp) / ".done").exists())   # H2: sentinel, not partial output
        summary = [r for r in results if r]
        for r in summary:
            TW(f"{'[REVIEW]' if r.get('needs_review') else '[ OK ]  '} {r.get('stem')}  "
               f"conf={r.get('overall_confidence')}  status={r.get('status')}")
        _write_run_outputs(summary, gate, outroot, cfg)
        return summary
    calib = load_calibration(_cfg_get(cfg, "conf_calibration_path", ""))   # LEVER F (identity by default)
    summary = []
    for fp in tqdm(files, desc=label, unit="file"):
        try:
            stem = safe_name(fp.stem)
            docdir = doc_outdir(outroot, fp); docdir.mkdir(parents=True, exist_ok=True)   # H2: collision-safe + sharded
            png_dir = docdir / "pages"
            res = dispatch(fp, docdir, png_dir)
            if not res:
                continue
            family, pages, fields, chunks, text = res
            r = write_outputs(fp, family, pages, fields, chunks, text, gate, docdir, stem, calib)
            summary.append(r)
            TW(f"{'[REVIEW]' if r['needs_review'] else '[ OK ]  '} {fp.name}  "
               f"conf={r['overall_confidence']}  fields={r['fields']}")
        except Exception as e:
            TW(f"[ERROR] {fp.name}: {e}")
            summary.append({"file": str(fp), "stem": safe_name(fp.stem), "family": "error",
                            "doc_class": "-", "overall_confidence": 0.0, "status": "NEEDS_REVIEW",
                            "needs_review": True, "fields": 0, "reasons": str(e)})
    _write_run_outputs(summary, gate, outroot, cfg)
    return summary

def write_status_manifest(summary, outroot, strict):
    """Run-level commit ledger: split files into committed (AUTO_ACCEPT) vs withheld
    (NEEDS_REVIEW). `strict` does not change the verdict - it records that withheld files
    are EXCLUDED from the committed set (instead of silently committed). Written by every
    driver so the split exists in exactly ONE place. Returns the manifest dict."""
    committed = [r.get("stem") or r["file"] for r in summary if r.get("status") == "AUTO_ACCEPT"]
    withheld = [{"stem": r.get("stem") or r["file"], "reasons": r.get("reasons", "")}
                for r in summary if r.get("status") != "AUTO_ACCEPT"]
    manifest = {"strict": bool(strict), "files": len(summary),
                "committed": committed, "needs_review": withheld}
    try:
        (Path(outroot) / "_status.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False),
                                                     encoding="utf-8")
    except Exception:
        pass
    return manifest

def write_review_pages(page_rows, outroot):
    """Per-PAGE human-review queue: which page(s) of which doc need a human (incomplete extraction,
    low OCR confidence, tie-out failure). page_rows = [{stem, page, reasons, confidence}]. Written
    alongside the per-DOCUMENT review_queue.csv / _status.json so a reviewer can work pages, not whole
    docs. No rows -> still writes a header (so the file's presence means 'checked, nothing flagged')."""
    try:
        with open(Path(outroot) / "review_pages.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["stem", "page", "confidence", "reasons"], extrasaction="ignore")
            w.writeheader()
            for r in sorted(page_rows, key=lambda x: (x.get("stem", ""), x.get("page", 0))):
                w.writerow(r)
    except Exception:
        pass
    return len(page_rows)

def write_reconcile_queue(rows, outroot):
    """Run-level Excel<->PDF reconciliation queue (sibling of review_pages.csv): which documents have
    table 'tombstones' awaiting an authoritative-Excel override, their proposed-alignment status, and
    confidence. rows = [{doc_key, stem, status, n_tombstones, n_reconciled, best_confidence, method,
    sources, reasons}]. No rows -> still writes a header (presence = 'checked')."""
    cols = ["doc_key", "stem", "status", "n_tombstones", "n_reconciled",
            "best_confidence", "method", "sources", "reasons"]
    try:
        with open(Path(outroot) / "reconcile_queue.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
            w.writeheader()
            for r in sorted(rows, key=lambda x: (x.get("stem", ""), x.get("doc_key", ""))):
                w.writerow(r)
    except Exception:
        pass
    return len(rows)

def _write_run_outputs(summary, gate, outroot, cfg=None):
    with open(outroot / "review_queue.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["file", "family", "doc_class", "overall_confidence",
                                          "status", "needs_review", "fields", "reasons"],
                           extrasaction="ignore")
        w.writeheader()
        for r in sorted(summary, key=lambda x: x["overall_confidence"]): w.writerow(r)
    auto = sum(1 for r in summary if not r["needs_review"])
    strict = bool(_cfg_get(cfg, "completeness_strict", False))
    run = {"files": len(summary), "auto_accepted": auto, "sent_to_review": len(summary) - auto,
           "auto_accept_rate": round(auto/len(summary), 3) if summary else None,
           "strict": strict, "by_family": {}, "gate": gate}
    for r in summary: run["by_family"][r["family"]] = run["by_family"].get(r["family"], 0) + 1
    (outroot / "run_summary.json").write_text(json.dumps(run, indent=2), encoding="utf-8")
    write_status_manifest(summary, outroot, strict)
    write_run_log(summary, outroot)                    # queryable per-file JSON record (C4)
    print("\n" + json.dumps(run, indent=2))
    if strict:
        print(f"[strict] {auto}/{len(summary)} committed; {len(summary)-auto} withheld -> {outroot/'_status.json'}")
    print(f"\nReview queue -> {outroot/'review_queue.csv'} (work it top-down, lowest confidence first)")
