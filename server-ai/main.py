import os
import io
import json
import random
import re
import tempfile
import time
from pathlib import Path
import httpx
import jwt
import psycopg
import document_extract
from fastapi import FastAPI, UploadFile, File, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors

load_dotenv()

DATABASE_URL = os.environ["DATABASE_URL"]
JWT_SECRET = os.environ.get("JWT_SECRET")

# Every structured/background LLM-backed feature in this file — grievance
# analysis, draft emails/alerts, report analysis, task productivity insight,
# and AI Agents narration — runs on Z.AI's hosted GLM model first (Heera's
# live chat runs on OpenRouter instead, see stream_reply() below). "thinking"
# is left disabled by default: these calls all need a direct answer/JSON
# object, not the model's reasoning trace mixed into the response.
ZAI_API_KEY = os.environ.get("ZAI_API_KEY")
ZAI_MODEL = os.environ.get("ZAI_MODEL", "glm-4.7-flash")
ZAI_URL = "https://api.z.ai/api/paas/v4/chat/completions"
ZAI_THINKING_ENABLED = os.environ.get("ZAI_THINKING", "disabled") == "enabled"

# Fallback providers — only used when Z.AI itself errors (auth, quota/billing,
# timeout, network), not when Z.AI answers but the response fails our own
# parsing/grounding checks (that's a model-quality problem, not an
# availability one, and retrying it on a different model wouldn't fix the
# caller's own validation logic). Kept as the previous working setup: a local
# Ollama model backs the structured/background calls, OpenRouter backs the
# interactive chatbot — same split this app ran on before Z.AI was added.
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2:3b")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "google/gemma-4-26b-a4b-it:free")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

app = FastAPI(title="AWIP AI Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_db_conn: psycopg.Connection | None = None

def get_db_conn() -> psycopg.Connection:
    """Reuse one long-lived connection across chat turns instead of paying a
    fresh TCP/TLS handshake to the DB on every single message — the single
    biggest fixed cost in the old per-request `psycopg.connect(...)` pattern.
    Reconnects transparently if the connection died (idle timeout, network
    blip); safe here because FastAPI's sync psycopg calls already run one at
    a time on this event loop, never truly concurrently.

    Also recovers from a failed transaction — if any query anywhere (a typo'd
    column, an invalid enum value, whatever) throws, Postgres leaves this
    connection's transaction ABORTED and refuses every further command until
    an explicit ROLLBACK. Since this same connection is reused across every
    request, one bad query used to permanently break the entire chat feature
    for every subsequent user until the process was restarted (verified live:
    an invalid grievance status value in one page-summary fetcher took down
    every other chat request afterward). Rolling back here means a single
    fetcher's bug degrades just that one reply, not the whole service."""
    global _db_conn
    if _db_conn is None or _db_conn.closed:
        _db_conn = psycopg.connect(DATABASE_URL)
    elif _db_conn.info.transaction_status != psycopg.pq.TransactionStatus.IDLE:
        try:
            _db_conn.rollback()
        except Exception:
            _db_conn = psycopg.connect(DATABASE_URL)
    return _db_conn

class ChatQuery(BaseModel):
    query: str
    # Short, frontend-truncated "last time we discussed X" string — used for
    # continuity only, never a raw history array (keeps every turn cheap and
    # the endpoint stateless). Optional/nullable so older clients still work.
    recentContext: str | None = None

def resolve_employee_id(authorization: str | None, conn=None) -> str | None:
    """Decode the bearer token issued by server-core and look up the linked
    employee, if any. Returns None (falls back to org-wide-only answers) for
    missing/invalid tokens or accounts with no linked employee. Accepts an
    optional open connection to avoid a redundant DB round trip when the
    caller already has one (e.g. inside chat_copilot)."""
    if not authorization or not authorization.startswith("Bearer ") or not JWT_SECRET:
        return None
    token = authorization.removeprefix("Bearer ")
    try:
        # server-core signs "sub" as a numeric user id, not a string — PyJWT's
        # default subject-type check would otherwise reject every valid token.
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"], options={"verify_sub": False})
    except jwt.PyJWTError:
        return None
    user_id = payload.get("sub")
    if user_id is None:
        return None
    try:
        with (conn or get_db_conn()).cursor() as cur:
            cur.execute('SELECT "employeeId" FROM users WHERE id = %s', (user_id,))
            row = cur.fetchone()
    except Exception:
        return None
    return row[0] if row else None

# Roles allowed to look up an arbitrary colleague's record (not just their own)
# — an ordinary Employee login must never pull up someone else's leave/
# insurance/performance data through the chat, only HR staff who'd already
# see it in Employee 360 anyway.
STAFF_LOOKUP_ROLES = {"HRAdmin", "DeptHead"}

def resolve_role(authorization: str | None) -> str | None:
    """Decode just the role claim from the bearer token — cheap, no DB call,
    used to gate arbitrary-employee lookups to HR staff roles."""
    if not authorization or not authorization.startswith("Bearer ") or not JWT_SECRET:
        return None
    token = authorization.removeprefix("Bearer ")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"], options={"verify_sub": False})
    except jwt.PyJWTError:
        return None
    return payload.get("role")

@app.get("/api/v1/health")
def health_check():
    return {"status": "healthy", "service": "awip-ai-service"}

@app.post("/api/v1/digitization/upload")
async def upload_service_book(file: UploadFile = File(...)):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in document_extract.SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type '{suffix}'. Upload PDF, image, DOCX, or XLSX.")

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = Path(tmp.name)
    try:
        result = document_extract.extract_document(tmp_path)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Extraction failed: {e}")
    finally:
        tmp_path.unlink(missing_ok=True)

    return {"filename": file.filename, **result}

_SNAPSHOT_CACHE = {"text": None, "ts": 0.0}
SNAPSHOT_TTL_SECONDS = 30

def fetch_workforce_snapshot(conn=None) -> str:
    """Pull a compact live snapshot from Postgres to ground the LLM's answers in
    real data. Org-wide figures barely move minute to minute, so this is cached
    for a short TTL to avoid five aggregate queries on every single chat turn —
    the biggest source of latency before this change."""
    now = time.monotonic()
    if _SNAPSHOT_CACHE["text"] is not None and now - _SNAPSHOT_CACHE["ts"] < SNAPSHOT_TTL_SECONDS:
        return _SNAPSHOT_CACHE["text"]

    def _run(cur):
        cur.execute('SELECT COUNT(*) FROM employees')
        total_employees = cur.fetchone()[0]

        cur.execute('SELECT department, COUNT(*) FROM employees GROUP BY department ORDER BY COUNT(*) DESC')
        by_dept = cur.fetchall()

        cur.execute('''
            SELECT
                COUNT(*) FILTER (WHERE "retirementDue"),
                COUNT(*) FILTER (WHERE "promotionDue"),
                COUNT(*) FILTER (WHERE "appraisalPending"),
                COUNT(*) FILTER (WHERE "trainingPending"),
                COUNT(*) FILTER (WHERE "missingDocs")
            FROM employees
        ''')
        retirement_due, promotion_due, appraisal_pending, training_pending, missing_docs = cur.fetchone()

        cur.execute('SELECT status, COUNT(*) FROM tasks GROUP BY status')
        task_status_counts = dict(cur.fetchall())

        cur.execute('SELECT "totalDisbursement", "processedEmployees", "pendingApprovals", "arrearsPending" FROM payroll_summary ORDER BY "updatedAt" DESC LIMIT 1')
        payroll_row = cur.fetchone()

        cur.execute('SELECT "fullName", count, attendance, vacancies FROM workforce_snapshot ORDER BY count DESC')
        org_wide = cur.fetchall()

        cur.execute('SELECT status, COUNT(*) FROM grievances GROUP BY status')
        grievance_status_counts = dict(cur.fetchall())

        cur.execute('SELECT COUNT(*) FROM statutory_compliance WHERE "gratuityEligible" = true')
        gratuity_eligible_count = cur.fetchone()[0]

        return (total_employees, by_dept, retirement_due, promotion_due, appraisal_pending, training_pending,
                missing_docs, task_status_counts, payroll_row, org_wide, grievance_status_counts, gratuity_eligible_count)

    with (conn or get_db_conn()).cursor() as cur:
        result = _run(cur)

    (total_employees, by_dept, retirement_due, promotion_due, appraisal_pending,
     training_pending, missing_docs, task_status_counts, payroll_row, org_wide,
     grievance_status_counts, gratuity_eligible_count) = result

    dept_lines = "\n".join(f"  - {d}: {c}" for d, c in by_dept)
    task_lines = "\n".join(f"  - {status}: {count}" for status, count in task_status_counts.items())
    org_lines = "\n".join(f"  - {name}: {count:,} employees, {attendance}% attendance, {vac} vacancies" for name, count, attendance, vac in org_wide)
    grievance_lines = "\n".join(f"  - {status}: {count}" for status, count in grievance_status_counts.items()) or "  - No grievances on file"
    payroll_line = (
        f"Total disbursement {payroll_row[0]}, {payroll_row[1]:,} employees processed, "
        f"{payroll_row[2]} pending approvals, {payroll_row[3]} arrears pending"
        if payroll_row else "No payroll data available"
    )

    text = f"""Live AWIP workforce snapshot:

Sample employee directory (demo dataset): {total_employees} employees
By department (sample directory):
{dept_lines}

Flags in sample directory:
  - Retirement due: {retirement_due}
  - Promotion due: {promotion_due}
  - Appraisal pending: {appraisal_pending}
  - Training pending: {training_pending}
  - Missing documents: {missing_docs}

Tasks by status:
{task_lines}

Payroll: {payroll_line}

Grievances by status:
{grievance_lines}

Statutory compliance: {gratuity_eligible_count} employees are currently gratuity-eligible (5+ years tenure)

Org-wide workforce scale (all departments, official establishment figures):
{org_lines}
"""
    _SNAPSHOT_CACHE["text"] = text
    _SNAPSHOT_CACHE["ts"] = now
    return text

def fetch_employee_context(employee_id: str, conn=None) -> str | None:
    """Pull the logged-in employee's own HR record — documents, leave balance,
    insurance, latest promotion, latest performance rating — so the copilot can
    answer personal questions instead of only org-wide aggregates."""
    def _run(cur):
        cur.execute('SELECT name, designation, department, doj, cadre FROM employees WHERE id = %s', (employee_id,))
        emp = cur.fetchone()
        if not emp:
            return None
        name, designation, department, doj, cadre = emp

        cur.execute(
            'SELECT "leaveType", entitled, availed, balance FROM leave_balances WHERE "employeeId" = %s ORDER BY "leaveType"',
            (employee_id,),
        )
        leave_rows = cur.fetchall()

        cur.execute(
            'SELECT provider, "policyNumber", "sumInsured", "validTill" FROM insurance_policies WHERE "employeeId" = %s',
            (employee_id,),
        )
        insurance_rows = cur.fetchall()

        cur.execute(
            'SELECT type, date, status, description FROM service_book_entries WHERE "employeeId" = %s ORDER BY date DESC',
            (employee_id,),
        )
        doc_rows = cur.fetchall()

        cur.execute(
            'SELECT year, rating FROM performance_records WHERE "employeeId" = %s ORDER BY year DESC LIMIT 1',
            (employee_id,),
        )
        perf_row = cur.fetchone()

        return name, designation, department, doj, cadre, leave_rows, insurance_rows, doc_rows, perf_row

    with (conn or get_db_conn()).cursor() as cur:
        result = _run(cur)

    if result is None:
        return None
    name, designation, department, doj, cadre, leave_rows, insurance_rows, doc_rows, perf_row = result

    leave_lines = "\n".join(f"  - {t}: {avail} availed of {ent}, {bal} remaining" for t, ent, avail, bal in leave_rows) or "  - No leave records on file"
    insurance_lines = "\n".join(f"  - {p} (policy {pn}), sum insured Rs.{si:,}, valid till {vt}" for p, pn, si, vt in insurance_rows) or "  - No insurance policy on file"
    last_promotion = next((d for d in doc_rows if d[0] == "Promotion Order"), None)
    promotion_line = f"  - Last promotion: {last_promotion[3] or 'Promotion Order'} on {last_promotion[1]} (status: {last_promotion[2]})" if last_promotion else "  - No promotion order on file"
    doc_lines = "\n".join(f"  - {t} dated {d}, status: {s}" for t, d, s, _ in doc_rows) or "  - No documents on file"
    perf_line = f"{perf_row[1]}/5 (year {perf_row[0]})" if perf_row else "not recorded"

    return f"""PERSONAL RECORD (for the logged-in employee only — do not confuse with the org-wide data above):

Name: {name} | Designation: {designation} | Department: {department} | Cadre: {cadre} | Date of joining: {doj}
Latest performance rating: {perf_line}

Leave balance ({employee_id}):
{leave_lines}

Insurance:
{insurance_lines}

{promotion_line}

Service book / documents on file:
{doc_lines}
"""

# Employee ID pattern used throughout the seed data / UI (e.g. "AMC-10042").
EMPLOYEE_ID_PATTERN = re.compile(r"\bAMC-\d{3,6}\b", re.IGNORECASE)

# Phrasing that signals the user is asking about a specific colleague rather
# than an org-wide aggregate — gates the (more expensive, ILIKE) name-search
# path so a plain department question doesn't trigger a fuzzy employee scan
# on every turn.
EMPLOYEE_LOOKUP_INTENT_HINTS = (
    "employee id", "who is", "tell me about", "look up", "lookup",
    "leave balance of", "leave balance for", "insurance of", "insurance for",
    "performance of", "performance rating of", "record of", "profile of",
    "service record of", "service book of", "documents of", "promotion history of",
)

def strip_page_context_prefix(query: str) -> str:
    """The frontend prefixes every message with "[Context: <page> · Department:
    <dept>] " for the LLM's benefit — but that same bracket used to leak into
    our own keyword/entity matching (e.g. asking about Health department
    performers while sitting on the Engineering page would spuriously match
    "Engineering" instead, since match_department just substring-scans the
    whole query text). Intent/entity detection should only ever look at what
    the user actually typed."""
    return re.sub(r"^\[Context:.*?\]\s*", "", query, count=1)

_PAGE_CONTEXT_RE = re.compile(r"^\[Context:\s*([^·\]]+?)\s*(?:·|$)")

def extract_page_name(query: str) -> str | None:
    """Pulls the page name back out of the same "[Context: <page> · ...]"
    prefix strip_page_context_prefix throws away — used so a "summarize this
    page" question actually knows which page. Must match the exact set of
    names the frontend's pageContext() in floating-assistant.tsx produces."""
    m = _PAGE_CONTEXT_RE.match(query)
    return m.group(1).strip() if m else None

PAGE_SUMMARY_INTENT_HINTS = ("this page", "summarize this", "summarise this", "what's on this page", "whats on this page")

def wants_page_summary(query: str) -> bool:
    text = query.lower()
    return any(hint in text for hint in PAGE_SUMMARY_INTENT_HINTS)

def fetch_finance_page(conn=None) -> str:
    with (conn or get_db_conn()).cursor() as cur:
        cur.execute('SELECT "totalDisbursement", "processedEmployees", "pendingApprovals", "arrearsPending" FROM payroll_summary ORDER BY "updatedAt" DESC LIMIT 1')
        payroll = cur.fetchone()
        cur.execute('''
            SELECT department, month, SUM("allocatedBudget") as allocated, SUM("amountSpent") as spent
            FROM department_finance GROUP BY department, month
        ''')
        rows = cur.fetchall()
    latest_month = max((r[1] for r in rows), default=None)
    variances = []
    for dept, month, allocated, spent in rows:
        if month != latest_month or not allocated:
            continue
        variances.append((dept, round((spent - allocated) / allocated * 100, 1)))
    variances.sort(key=lambda v: v[1], reverse=True)
    over_lines = "\n".join(f"  - {d}: {v:+.1f}% variance" for d, v in variances[:5]) or "  - No variance data available"
    payroll_line = (
        f"Total disbursement {payroll[0]}, {payroll[1]:,} employees processed, {payroll[2]} pending approvals, {payroll[3]} arrears pending"
        if payroll else "No payroll data available"
    )
    return f"""FINANCE PAGE — real data for this page specifically (not the org-wide snapshot above):

Payroll: {payroll_line}

Budget variance by department, {latest_month or "latest month"} (sorted, most over-budget first):
{over_lines}
"""

def fetch_legal_page(conn=None) -> str:
    with (conn or get_db_conn()).cursor() as cur:
        cur.execute("SELECT status, COUNT(*) FROM legal_cases GROUP BY status")
        by_status = cur.fetchall()
        cur.execute('SELECT department, COUNT(*), SUM("exposureLakh") FROM legal_cases WHERE status != %s GROUP BY department ORDER BY SUM("exposureLakh") DESC LIMIT 5', ("Closed",))
        by_dept = cur.fetchall()
        cur.execute("SELECT title, category, recurrence FROM statutory_deadlines LIMIT 10")
        deadlines = cur.fetchall()
    status_lines = "\n".join(f"  - {s}: {c}" for s, c in by_status) or "  - No legal cases on file"
    dept_lines = "\n".join(f"  - {d}: {c} open case(s), Rs.{e or 0} lakh exposure" for d, c, e in by_dept) or "  - No open cases by department"
    deadline_lines = "\n".join(f"  - {t} ({cat}, {rec})" for t, cat, rec in deadlines) or "  - No statutory deadlines on file"
    return f"""LEGAL & COMPLIANCE PAGE — real data for this page specifically (not the org-wide snapshot above):

Legal cases by status:
{status_lines}

Highest exposure departments (open cases only):
{dept_lines}

Statutory deadlines tracked:
{deadline_lines}
"""

def fetch_grievances_page(conn=None) -> str:
    with (conn or get_db_conn()).cursor() as cur:
        cur.execute("SELECT status, COUNT(*) FROM grievances GROUP BY status")
        by_status = cur.fetchall()
        cur.execute("SELECT severity, COUNT(*) FROM grievances WHERE status != %s GROUP BY severity", ("Resolved",))
        by_severity = cur.fetchall()
        cur.execute("SELECT department, COUNT(*) FROM grievances WHERE status != %s GROUP BY department ORDER BY COUNT(*) DESC LIMIT 5", ("Resolved",))
        by_dept = cur.fetchall()
    status_lines = "\n".join(f"  - {s}: {c}" for s, c in by_status) or "  - No grievances on file"
    severity_lines = "\n".join(f"  - {s}: {c}" for s, c in by_severity) or "  - No open grievances"
    dept_lines = "\n".join(f"  - {d}: {c} open" for d, c in by_dept) or "  - No open grievances by department"
    return f"""GRIEVANCE MANAGEMENT PAGE — real data for this page specifically (not the org-wide snapshot above):

Grievances by status:
{status_lines}

Open grievances by severity:
{severity_lines}

Departments with the most open grievances:
{dept_lines}
"""

def fetch_leave_page(conn=None) -> str:
    with (conn or get_db_conn()).cursor() as cur:
        cur.execute("SELECT status, COUNT(*) FROM leave_requests GROUP BY status")
        by_status = cur.fetchall()
        cur.execute('SELECT COUNT(*) FROM leave_requests WHERE status = %s AND "managerStatus" = %s', ("Pending", "Approved"))
        awaiting_hr = cur.fetchone()[0]
    status_lines = "\n".join(f"  - {s}: {c}" for s, c in by_status) or "  - No leave requests on file"
    return f"""LEAVE MANAGEMENT PAGE — real data for this page specifically (not the org-wide snapshot above):

Leave requests by status:
{status_lines}

Awaiting final HR approval (already manager-approved): {awaiting_hr}
"""

def fetch_recruitment_page(conn=None) -> str:
    with (conn or get_db_conn()).cursor() as cur:
        cur.execute("SELECT status, COUNT(*) FROM candidates GROUP BY status")
        by_status = cur.fetchall()
        cur.execute("SELECT COUNT(*) FROM vacancies")
        open_vacancies = cur.fetchone()[0]
    status_lines = "\n".join(f"  - {s}: {c}" for s, c in by_status) or "  - No candidates on file"
    return f"""RECRUITMENT PAGE — real data for this page specifically (not the org-wide snapshot above):

Open vacancies: {open_vacancies}

Candidates by pipeline status:
{status_lines}
"""

def fetch_onboarding_page(conn=None) -> str:
    with (conn or get_db_conn()).cursor() as cur:
        cur.execute("SELECT status, COUNT(*) FROM onboarding_cases GROUP BY status")
        by_status = cur.fetchall()
        cur.execute('SELECT AVG("progressPct") FROM onboarding_cases WHERE status != %s', ("Completed",))
        avg_progress = cur.fetchone()[0]
    status_lines = "\n".join(f"  - {s}: {c}" for s, c in by_status) or "  - No onboarding cases on file"
    return f"""ONBOARDING PAGE — real data for this page specifically (not the org-wide snapshot above):

Onboarding cases by status:
{status_lines}

Average progress on in-flight cases: {round(avg_progress) if avg_progress is not None else "N/A"}%
"""

# Page name (as produced by the frontend's pageContext()) -> fetcher. Only
# pages with a real data domain distinct from the general workforce snapshot
# get one — Task Management, Analytics, Employee Directory etc. are already
# reasonably served by the snapshot above, so adding a redundant fetcher for
# those would just be more DB load for no grounding improvement.
PAGE_SNAPSHOT_FETCHERS = {
    "Finance": fetch_finance_page,
    "Legal & Compliance": fetch_legal_page,
    "Grievance Management": fetch_grievances_page,
    "Leave Management": fetch_leave_page,
    "Recruitment": fetch_recruitment_page,
    "Onboarding": fetch_onboarding_page,
}

def wants_employee_lookup(query: str) -> bool:
    text = query.lower()
    return bool(EMPLOYEE_ID_PATTERN.search(query)) or any(hint in text for hint in EMPLOYEE_LOOKUP_INTENT_HINTS)

def extract_employee_id(query: str) -> str | None:
    m = EMPLOYEE_ID_PATTERN.search(query)
    return m.group(0).upper() if m else None

def find_employee_id_by_name(query: str, conn=None) -> str | None:
    """Fuzzy ILIKE match against real employee names for queries like "what's
    Priya Patel's leave balance" that don't carry an explicit AMC-ID. Picks
    the single best match only when the query is unambiguous (exactly one
    active employee's name appears as a substring) — with 10,000 seeded
    employees, a short/common name could otherwise match dozens of people,
    and guessing wrong is worse than saying "which one?" via no match at all."""
    words = [w.strip(".,?!'\"") for w in query.split() if len(w) > 2 and w[0].isupper()]
    if not words:
        return None
    with (conn or get_db_conn()).cursor() as cur:
        cur.execute(
            'SELECT id, name FROM employees WHERE status = %s AND ('
            + " OR ".join(['name ILIKE %s'] * len(words)) + ') LIMIT 5',
            ("Active", *[f"%{w}%" for w in words]),
        )
        rows = cur.fetchall()
    return rows[0][0] if len(rows) == 1 else None

def fetch_employee_lookup(employee_id: str, conn=None) -> str | None:
    """Same shape as fetch_employee_context, but for an arbitrary colleague
    rather than only the logged-in user — gated by STAFF_LOOKUP_ROLES at the
    call site since it exposes another person's leave/insurance/performance
    data."""
    block = fetch_employee_context(employee_id, conn)
    if block is None:
        return None
    return block.replace(
        "PERSONAL RECORD (for the logged-in employee only — do not confuse with the org-wide data above):",
        f"LOOKED-UP EMPLOYEE RECORD ({employee_id} — the user asked about this specific colleague, not themselves):",
    )

SYSTEM_PROMPT_TEMPLATE = """You are Heera, a friendly and sharp workforce-governance copilot embedded in the AI Workforce Intelligence Platform for the Ahmedabad Municipal Corporation (AMC). Talk like a knowledgeable colleague who's genuinely glad to help — warm and conversational, never a cold report — while staying precise and numbers-first like an experienced public-administration analyst would.

Answer the user's question using the live data below. Lead with the direct answer, cite at least one specific number from the data to back it up, and — whenever it's genuinely relevant — close with one short proactive insight (a risk worth flagging, a trend worth watching, or a next step worth taking). {length_instruction} If the question can't be answered from this data, say so honestly and warmly instead of making up numbers, and suggest what you *can* help with instead. If a personal record section is present, use it for questions about "my" leave, insurance, promotion, or documents; otherwise those questions can't be answered because no employee is linked to this login. If a named-employee performance list is present below, that IS real per-employee data — use it directly to answer "best/worst performing employees" questions by name; only say individual data is unavailable if that section is genuinely absent or empty. If a looked-up colleague's record is present below, that's real per-employee data for the specific person the user asked about — use it directly. If a page-specific data section is present below and the user asked to summarize "this page" or similar, base your summary on THAT section, not the general workforce snapshot — the user is looking at that specific page right now, not the Command Centre.

{snapshot}
{personal}{lookup}{performers}{page}{help}{recent_context}"""

# Real per-employee names + ratings for a specific department — the org-wide
# snapshot above is aggregate-only (COUNT/AVG), so a "list the best/worst
# performing employees in X" question would otherwise get a false "I don't
# have individual data" refusal even though performance_records has exactly
# this, per-employee. Only queried when the question actually asks for a
# ranked employee list, not on every turn.
# Split into a superlative group and a performance/employee-subject group,
# matched with AND-across-groups/OR-within-group (same shape as HELP_TOPICS)
# instead of fixed two/three-word phrases. A flat phrase list like
# "best performing" breaks the moment a user inserts a word — "best 5
# performing employees" or "best high-potential performer" would otherwise
# silently miss and fall back to a false "I don't have that data" answer.
TOP_PERFORMER_SUPERLATIVES = ("best", "top", "highest", "worst", "lowest", "underperform", "poor", "bottom")
TOP_PERFORMER_SUBJECTS = ("performing", "performer", "performers", "rated", "rating", "employee", "employees", "staff", "officer", "officers")
WORST_PERFORMER_HINTS = ("worst", "lowest", "underperform", "poor", "bottom")

_DEPARTMENTS_CACHE = {"names": None, "ts": 0.0}
DEPARTMENTS_TTL_SECONDS = 300

def fetch_department_names(conn=None) -> list[str]:
    """Real department names on file — cached briefly since the department
    list changes essentially never, unlike the workforce snapshot."""
    now = time.monotonic()
    if _DEPARTMENTS_CACHE["names"] is not None and now - _DEPARTMENTS_CACHE["ts"] < DEPARTMENTS_TTL_SECONDS:
        return _DEPARTMENTS_CACHE["names"]
    with (conn or get_db_conn()).cursor() as cur:
        cur.execute('SELECT name FROM departments')
        names = [r[0] for r in cur.fetchall()]
    _DEPARTMENTS_CACHE["names"] = names
    _DEPARTMENTS_CACHE["ts"] = now
    return names

def match_department(query: str, departments: list[str]) -> str | None:
    """Longest matching real department name mentioned in the query (case-
    insensitive substring) — longest-match avoids a short name like "IT"
    spuriously matching inside an unrelated word."""
    text = query.lower()
    matches = [d for d in departments if d.lower() in text]
    return max(matches, key=len) if matches else None

def wants_top_performers(query: str) -> bool:
    text = query.lower()
    return any(s in text for s in TOP_PERFORMER_SUPERLATIVES) and any(s in text for s in TOP_PERFORMER_SUBJECTS)

def extract_requested_count(query: str, default: int = 8, cap: int = 20) -> int:
    """Picks up an explicit "best 5 ..." / "top 3 ..." count from the query so
    "best 5 performing employees" actually returns 5 rows instead of the
    fixed default — clamped to `cap` so a typo'd huge number doesn't blow up
    the prompt."""
    m = re.search(r"\b(\d{1,3})\b", query)
    if not m:
        return default
    n = int(m.group(1))
    return max(1, min(n, cap))

def fetch_top_performers(department: str, conn=None, limit: int = 8, worst: bool = False) -> list[tuple]:
    """Real employees in `department`, ranked by their latest recorded
    appraisal rating — the actual per-employee data a "best/worst performing
    employees" question needs, joined the same way Employee 360's composite
    score does (server-core/server.js computeComposite), just via raw SQL
    since server-ai talks to Postgres directly rather than through Prisma."""
    order = "ASC" if worst else "DESC"
    with (conn or get_db_conn()).cursor() as cur:
        cur.execute(
            f'''
            SELECT e.name, e.designation, p.rating, p.year
            FROM employees e
            JOIN performance_records p ON p."employeeId" = e.id
            WHERE e.department = %s AND e.status = 'Active'
              AND p.year = (SELECT MAX(year) FROM performance_records WHERE "employeeId" = e.id)
            ORDER BY p.rating {order}, e.name ASC
            LIMIT %s
            ''',
            (department, limit),
        )
        return cur.fetchall()

DEFAULT_LENGTH_INSTRUCTION = "Stay in plain prose, no markdown or bullet lists, 2 to 4 sentences unless the user explicitly asks for a detailed breakdown."
DETAIL_LENGTH_INSTRUCTION = "The user asked for detail, so give a genuinely thorough answer — several sentences or short paragraphs are fine, plain prose still preferred over bullet lists, but don't compress it down to 2-4 sentences this time."

# Phrasing that signals the user actually wants a longer, more thorough
# answer rather than the default terse 2-4 sentences — without this, every
# reply is capped to the same short shape regardless of what was asked.
DETAIL_INTENT_HINTS = ("explain", "why", "detailed", "detail", "breakdown", "analyze", "analysis", "elaborate", "in depth", "walk me through")

def wants_detail(query: str) -> bool:
    text = query.lower()
    return any(hint in text for hint in DETAIL_INTENT_HINTS)

# Keyword -> in-app module redirect. Checked cheaply against the query text
# before/after the LLM call so we don't spend an extra model round trip just
# to decide where to point the user.
REDIRECT_RULES = [
    (("task", "assignment", "workload", "reassign", "sow", "milestone"), "/tasks", "Task Management"),
    (("grievance", "complaint"), "/grievances", "Grievance Management"),
    (("calendar", "event", "training schedule", "holiday", "upcoming"), "/calendar", "Calendar"),
    (("compliance", "statutory", " pf ", "pf number", "esic", "gratuity", "tds", "cghs", "legal"), "/legal", "Legal & Compliance"),
    (("leave", "leave request", "leave balance", "leave approval"), "/leave", "Leave Management"),
    (("org chart", "hierarchy", "reporting structure", "org 360"), "/org360", "Org 360"),
    (("payroll", "budget", "finance", "disbursement", "arrears"), "/finance", "Finance"),
    (("performance", "appraisal", "rating"), "/performance", "Performance"),
    (("ocr", "scan", "digitiz"), "/ocr-scanner", "OCR Scanner"),
    (("document", "service book"), "/documents", "Documents"),
    (("employee directory", "employee profile", "search employee", "find employee"), "/employees", "Employee Directory"),
]

# Real "how do I use this" knowledge — REDIRECT_RULES only knows *where* a
# page is, this knows the actual click-path on it. Only consulted when the
# query also carries help-seeking phrasing (HELP_INTENT_HINTS below), so an
# ordinary data question like "how many tasks are open" doesn't get grounded
# with unrelated UI instructions.
HELP_INTENT_HINTS = ("how do i", "how to", "how can i", "where do i", "where can i", "can i", "help me", "steps to", "guide me")

# Each entry is (groups, how_to) where groups is a list of keyword-groups —
# a topic matches only if EVERY group has at least one hit (AND across
# groups, OR within a group). This is what makes matching survive real
# phrasing like "how do I dismiss an emergency alert" (adjective inserted
# between the action and the subject) instead of requiring an exact fixed
# phrase like "dismiss an alert".
HELP_TOPICS = [
    ([("delete", "remove"), ("task",)],
     "Open Task Management, find the task in the row list (or open its detail panel), and click the trash-can icon next to Reassign/Reallocate — or select several with the checkboxes and use Delete in the bulk-actions bar. A confirmation dialog appears before anything is removed."),
    ([("reassign", "reallocate", "hand off", "transfer"), ("task",)],
     "In Task Management, click the reassign icon on a task row to hand it to another officer in the same department, or the reallocate icon to move it to a different department. Both open a picker showing current workload so you can pick a less-loaded officer."),
    ([("dismiss", "remove", "clear", "delete", "hide"), ("alert",)],
     "On the Command Centre, each Emergency Alert row has a small × button. Clicking it asks for confirmation, then hides the alert from the panel — the record and its full history stay on file, it's a dismiss, not a permanent delete."),
    ([("add", "create"), ("event", "reminder")],
     "On the HR Calendar, HR admins see an 'Add Event' button for meetings, deadlines, holidays, or notices. Employees instead see an 'Add Reminder' button for their own private reminders, visible only to them."),
    ([("delete", "remove"), ("event", "reminder")],
     "Only HR-created events and your own personal reminders show a delete icon on the calendar — training, retirement, and leave entries are auto-generated from real records and can't be deleted directly."),
    ([("apply", "request", "take"), ("leave",)],
     "On My Leave, click 'Apply for Leave', pick a leave type and date range, and give a reason. It checks your balance and notice period automatically before sending it to your manager and then HR for approval."),
    ([("approve", "reject", "review", "decide"), ("leave",)],
     "On the Leave module, pending requests go through a manager-review stage then an HR-review stage. Click a request to see the employee's balance and history, then use Approve or Reject — approval automatically debits their leave balance."),
    ([("file", "raise", "submit", "complain", "report"), ("grievance", "complaint")],
     "Employees can file a grievance from My Grievances — pick a category, describe the issue, and optionally submit anonymously. It's tracked through New, Under Investigation, Escalated, and Resolved stages."),
    ([("download", "generate", "get", "see"), ("service record", "my report", "payslip")],
     "Ask about your leave balance, insurance, or service record and a 'Download Service Record PDF' button will appear — or find the same option on your profile/My records page."),
    ([("search", "find", "look up"), ("employee",)],
     "Employee Directory has a search box (name/designation) plus filters for department, status, and today's attendance — results are paginated, use 'Load more' for further pages."),
    ([("scan", "digitize", "upload", "ocr"), ("document", "service book")],
     "OCR Scanner lets you upload a PDF, image, DOCX, or XLSX of a service-book document; it extracts the key fields automatically so you don't have to retype them."),
    ([("health score", "org 360", "department drill", "department profile", "department card")],
     "Org 360 shows every department as a card — click one to open its digital-twin view with a radial module picker and a Health Score Breakdown panel explaining exactly which factors (SLA, attendance, vacancy, grievances, budget) are pulling the score down and by how much."),
]

def match_help_topic(query: str) -> str | None:
    text = query.lower()
    if not any(hint in text for hint in HELP_INTENT_HINTS):
        return None
    for groups, how_to in HELP_TOPICS:
        if all(any(kw in text for kw in group) for group in groups):
            return how_to
    return None

SERVICE_RECORD_KEYWORDS = ("leave balance", "insurance", "service record", "promotion", "my documents", "payslip", "my record", "my report")
DEPARTMENT_KEYWORDS = ("department", "health score", "workforce digest", "compliance digest", "vacancy", "attendance rate", "budget variance")
RISK_KEYWORDS = ("risk summary", "grievance report", "legal risk", "risk digest", "litigation")

# Wider pool than what's ever shown at once — classify_followup samples 2 of
# these per reply instead of always the same fixed pair, so the chatbot's
# suggestions don't feel identical on every visit. Only used as a last
# resort when nothing below recognizes the query's topic (see
# TOPIC_FOLLOWUPS) — a resolved question should lead somewhere related to
# what was just asked, not a generic unrelated rotation.
FALLBACK_QUICK_ACTIONS = [
    {"label": "Show today's alerts", "kind": "prompt", "payload": "What are today's most urgent workforce alerts?"},
    {"label": "Summarize workforce posture", "kind": "prompt", "payload": "Give me a summary of our current workforce posture."},
    {"label": "Vacancy hotspots", "kind": "prompt", "payload": "Which departments have the highest vacancy rates right now?"},
    {"label": "Attendance outliers", "kind": "prompt", "payload": "Which departments or zones have the weakest attendance this month?"},
    {"label": "Budget variance flags", "kind": "prompt", "payload": "Which departments are furthest over or under their budget?"},
    {"label": "Retirement pipeline", "kind": "prompt", "payload": "How many employees are due for retirement in the next year, and where?"},
]

# Topic -> 2 genuinely related follow-up questions, keyed off the query
# (never the answer — same reason as everywhere else in this file). Checked
# only when the query didn't already produce a redirect/report-driven quick
# action above, so a resolved question naturally leads to the next relevant
# one instead of falling straight to the generic FALLBACK_QUICK_ACTIONS
# rotation. Same AND-of-groups matching shape as HELP_TOPICS.
TOPIC_FOLLOWUPS = [
    ([("best", "top", "highest rated", "highest performing", "high performer")], [
        {"label": "See the worst performers too", "kind": "prompt", "payload": "Who are the worst performing employees in the same department?"},
        {"label": "High-Potential by department", "kind": "prompt", "payload": "Which departments have the most High-Potential employees?"},
    ]),
    ([("worst", "lowest rated", "underperform", "poor performer", "low performer")], [
        {"label": "Suggest a training fix", "kind": "prompt", "payload": "What training programs would help these employees improve?"},
        {"label": "Performance risk by department", "kind": "prompt", "payload": "Which department has the most performance-related risk?"},
    ]),
    ([("vacanc", "understaffed", "short-staffed", "short staffed")], [
        {"label": "Which zones are hit hardest", "kind": "prompt", "payload": "Which zones are most affected by these vacancies?"},
        {"label": "Retirement pipeline", "kind": "prompt", "payload": "How many employees are retiring in the next 12 months?"},
    ]),
    ([("attendance", "absentee")], [
        {"label": "Sharpest zone decline", "kind": "prompt", "payload": "Which zone has the sharpest attendance decline this month?"},
        {"label": "Chronic absenteeism check", "kind": "prompt", "payload": "Are there any departments with chronic absenteeism?"},
    ]),
    ([("budget", "over budget", "overrun", "expenditure", "overspend")], [
        {"label": "Furthest over budget", "kind": "prompt", "payload": "Which departments are furthest over budget?"},
        {"label": "What's driving the variance", "kind": "prompt", "payload": "What's driving the budget variance this month?"},
    ]),
    ([("retiring", "retirement", "superannuation", "pension")], [
        {"label": "Check pension paperwork", "kind": "prompt", "payload": "Do any of them have incomplete service-book documentation?"},
        {"label": "Skills at risk", "kind": "prompt", "payload": "Which critical skills are most at risk from these retirements?"},
    ]),
    ([("training", "skill gap", "certification")], [
        {"label": "Lowest training compliance", "kind": "prompt", "payload": "Which departments have the lowest training compliance?"},
        {"label": "Critical skill shortages", "kind": "prompt", "payload": "What critical skills are most at risk of shortage?"},
    ]),
    ([("grievance", "complaint", "harassment")], [
        {"label": "Most open grievances", "kind": "navigate", "payload": "/grievances"},
        {"label": "Any Critical right now?", "kind": "prompt", "payload": "Are any grievances marked Critical right now?"},
    ]),
    ([("legal", "litigation", "court case")], [
        {"label": "Pending case count", "kind": "prompt", "payload": "How many legal cases are currently pending?"},
        {"label": "Most legal exposure", "kind": "prompt", "payload": "Which department has the most legal exposure?"},
    ]),
    ([("task", "overdue", "sla breach", "deadline", "milestone")], [
        {"label": "Who's overloaded", "kind": "prompt", "payload": "Which officers have the heaviest task workload right now?"},
        {"label": "Open Task Management", "kind": "navigate", "payload": "/tasks"},
    ]),
    ([("missing doc", "missing documents", "service book", "digitiz", "ocr")], [
        {"label": "Worst department for this", "kind": "prompt", "payload": "Which department has the most employees with missing documents?"},
        {"label": "Open OCR Scanner", "kind": "navigate", "payload": "/ocr-scanner"},
    ]),
    ([("employee id", "who is", "tell me about", "leave balance of", "leave balance for", "insurance of", "performance of", "record of", "profile of")], [
        {"label": "Their task history", "kind": "prompt", "payload": "What tasks are currently assigned to them?"},
        {"label": "Open Employee 360", "kind": "navigate", "payload": "/employees"},
    ]),
    # Broad "what needs attention" catch-all — kept last so a query that also
    # matches a more specific topic above (grievance, budget, etc.) gets that
    # topic's sharper follow-ups instead of this generic pair.
    ([("urgent", "needs attention", "what's wrong", "priorit", "top risk", "biggest risk", "most pressing")], [
        {"label": "Overdue tasks", "kind": "navigate", "payload": "/tasks"},
        {"label": "Missing documents by department", "kind": "prompt", "payload": "Which department has the most employees with missing documents?"},
    ]),
]

def topic_followup_actions(query_text: str) -> list[dict] | None:
    for groups, actions in TOPIC_FOLLOWUPS:
        if all(any(kw in query_text for kw in group) for group in groups):
            return actions
    return None

def classify_followup(query: str, has_employee: bool) -> tuple[str | None, dict | None, list[dict]]:
    """Cheap keyword classification (no extra LLM call) deciding which
    downloadable PDF (if any) to offer, which module to redirect to, and
    which quick-action chips to surface below the reply."""
    # Everything below is keyed off what the user actually typed, never the
    # model's own generated prose. That combined-text approach was the real
    # bug: "department" and "attendance rate" show up in almost any workforce
    # answer regardless of what was asked (so "Generate Department Digest
    # PDF" appeared after nearly every reply), and a department literally
    # named "Public Grievance" appearing in an answer about attendance was
    # enough to redirect to /grievances and offer a Risk Summary PDF. A
    # wrong nav/report suggestion isn't actually low-stakes if it fires on
    # unrelated questions — it reads as the chatbot being broken.
    query_text = query.lower()

    redirect = None
    for keywords, path, label in REDIRECT_RULES:
        if any(k in query_text for k in keywords):
            redirect = {"path": path, "label": label}
            break

    # A legal/grievance redirect implies risk-summary intent even if the
    # RISK_KEYWORDS phrasing itself wasn't used — keeps report_type and the
    # quick-action chips pointing at the same report instead of disagreeing.
    is_risk_topic = redirect is not None and redirect["path"] in ("/legal", "/grievances")
    is_department_topic = any(k in query_text for k in DEPARTMENT_KEYWORDS) and not has_employee

    # Personal intent wins over generic org talk; only one report is ever offered per reply.
    report_type = None
    if has_employee and any(k in query_text for k in SERVICE_RECORD_KEYWORDS):
        report_type = "service_record"
    elif is_risk_topic or any(k in query_text for k in RISK_KEYWORDS):
        report_type = "risk_summary"
    elif is_department_topic:
        report_type = "department_digest"

    quick_actions: list[dict] = []
    if redirect and redirect["path"] == "/legal":
        quick_actions.append({"label": "Show pending cases", "kind": "navigate", "payload": "/legal"})
        quick_actions.append({"label": "Generate Risk Summary PDF", "kind": "report", "payload": "risk_summary"})
    elif redirect and redirect["path"] == "/grievances":
        quick_actions.append({"label": "Show critical grievances", "kind": "navigate", "payload": "/grievances"})
        quick_actions.append({"label": "Generate Risk Summary PDF", "kind": "report", "payload": "risk_summary"})

    # Specific topics (best/worst performer, vacancy, attendance, budget,
    # task, missing docs, ...) get first crack before the generic "the query
    # merely mentions 'department'" fallback below — otherwise a genuinely
    # specific question like "best performing employees in X department"
    # always lost to the same generic digest-PDF pair just because it also
    # happens to say "department", which read as the chatbot ignoring what
    # was actually asked.
    if not quick_actions:
        quick_actions = topic_followup_actions(query_text) or []

    if not quick_actions and is_department_topic:
        quick_actions.append({"label": "Generate Department Digest PDF", "kind": "report", "payload": "department_digest"})
        quick_actions.append({"label": "Show lowest health department", "kind": "prompt", "payload": "Which department has the lowest health score right now?"})

    if not quick_actions:
        # Fallback rotation never includes a report chip — a chip should
        # only point at data the query actually asked about. Sampled from a
        # wider pool (rather than always the same fixed two) so repeat
        # visits don't see an identical pair of chips every time.
        quick_actions = random.sample(FALLBACK_QUICK_ACTIONS, 2)

    seen = set()
    deduped = []
    for action in quick_actions:
        if action["label"] not in seen:
            seen.add(action["label"])
            deduped.append(action)

    return report_type, redirect, deduped[:3]

@app.post("/api/v1/copilot/chat")
async def chat_copilot(query: ChatQuery, authorization: str | None = Header(default=None)):
    try:
        # Reused connection (get_db_conn) instead of a fresh connect per
        # request — cuts a real network round trip off every chat turn.
        conn = get_db_conn()
        employee_id = resolve_employee_id(authorization, conn)
        snapshot = fetch_workforce_snapshot(conn)
        personal = fetch_employee_context(employee_id, conn) if employee_id else None
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Could not read workforce data: {e}")

    # Strip the frontend's "[Context: page · Department: X]" prefix before any
    # of our own keyword/entity matching — see strip_page_context_prefix's
    # docstring for why (it used to cause spurious department matches).
    user_text = strip_page_context_prefix(query.query)

    help_topic = match_help_topic(user_text)
    help_block = f"\nHOW TO USE THIS FEATURE (answer navigation/usage questions from this, don't guess):\n{help_topic}\n" if help_topic else ""
    recent_context = f"\nRecent conversation context (for continuity only, do not repeat verbatim): {query.recentContext}" if query.recentContext else ""
    detail = wants_detail(user_text)
    length_instruction = DETAIL_LENGTH_INSTRUCTION if detail else DEFAULT_LENGTH_INSTRUCTION

    performers_block = ""
    if wants_top_performers(user_text):
        try:
            departments = fetch_department_names(conn)
        except Exception:
            departments = []
        department = match_department(user_text, departments)
        if department:
            worst = any(k in user_text.lower() for k in WORST_PERFORMER_HINTS)
            limit = extract_requested_count(user_text)
            rows = fetch_top_performers(department, conn, limit=limit, worst=worst)
            if rows:
                label = "Lowest" if worst else "Best"
                lines = "\n".join(f"  - {name} ({designation}): {rating}/5 (rated {year})" for name, designation, rating, year in rows)
                performers_block = f"\n{label} performing employees in {department} by latest appraisal rating (real, named individuals):\n{lines}\n"
            else:
                performers_block = f"\nNo performance records are on file for any active employee in {department}.\n"

    # Arbitrary-colleague lookup — HR staff only (STAFF_LOOKUP_ROLES), so an
    # ordinary employee login can't fish for someone else's leave/insurance/
    # performance data through the chat. Tries an explicit AMC-ID first, then
    # falls back to an unambiguous name match.
    lookup_block = ""
    if wants_employee_lookup(user_text) and resolve_role(authorization) in STAFF_LOOKUP_ROLES:
        lookup_id = extract_employee_id(user_text) or find_employee_id_by_name(user_text, conn)
        if lookup_id and lookup_id != employee_id:
            looked_up = fetch_employee_lookup(lookup_id, conn)
            if looked_up:
                lookup_block = f"\n{looked_up}\n"
            else:
                lookup_block = f"\nNo employee record found for '{lookup_id}'.\n"

    # "Summarize this page" (or similar) needs page-specific data, not just the
    # org-wide snapshot every query gets — otherwise a Finance-page summary
    # reads identically to a Command Centre summary, since the LLM is never
    # given anything that actually differs by page. Only fetched on that
    # specific intent, and only for pages with a data domain distinct enough
    # from the snapshot to warrant one (PAGE_SNAPSHOT_FETCHERS).
    page_block = ""
    if wants_page_summary(user_text):
        page_name = extract_page_name(query.query)
        fetcher = PAGE_SNAPSHOT_FETCHERS.get(page_name) if page_name else None
        if fetcher:
            try:
                page_block = f"\n{fetcher(conn)}\n"
            except Exception:
                page_block = ""

    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(
        snapshot=snapshot, personal=personal or "", lookup=lookup_block, performers=performers_block,
        page=page_block, help=help_block, recent_context=recent_context, length_instruction=length_instruction,
    )
    max_output_tokens = 900 if detail else 400
    temperature = 0.65 if detail else 0.5

    async def _stream_provider(url: str, headers: dict, body: dict):
        """Yields each streamed text delta, or raises if the provider errors
        before producing one. Shared OpenAI-compatible SSE parsing — both
        Z.AI and the OpenRouter fallback below speak this same protocol."""
        async with httpx.AsyncClient(timeout=45.0) as client:
            async with client.stream("POST", url, headers=headers, json=body) as res:
                if res.status_code != 200:
                    raw = await res.aread()
                    raise RuntimeError(f"{res.status_code}: {raw.decode(errors='replace')[:500]}")
                async for line in res.aiter_lines():
                    # keep-alive comment lines are skipped, real payloads are "data: ...".
                    if not line.startswith("data: "):
                        continue
                    payload = line[len("data: "):]
                    if payload.strip() == "[DONE]":
                        break
                    chunk = json.loads(payload)
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    # reasoning_content only appears when ZAI_THINKING=enabled —
                    # skipped so the chat bubble never shows the model's raw
                    # chain-of-thought, only its final answer content.
                    delta = choices[0].get("delta", {}).get("content") or ""
                    if delta:
                        yield delta

    def stream_zai():
        if not ZAI_API_KEY:
            raise RuntimeError("ZAI_API_KEY is not configured on server-ai.")
        return _stream_provider(
            ZAI_URL,
            {"Authorization": f"Bearer {ZAI_API_KEY}"},
            {
                "model": ZAI_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": query.query},
                ],
                "thinking": {"type": "enabled" if ZAI_THINKING_ENABLED else "disabled"},
                "stream": True,
                "temperature": temperature,
                "max_tokens": max_output_tokens,
            },
        )

    def stream_openrouter():
        if not OPENROUTER_API_KEY:
            raise RuntimeError("OPENROUTER_API_KEY is not configured either — no fallback available.")
        return _stream_provider(
            OPENROUTER_URL,
            {"Authorization": f"Bearer {OPENROUTER_API_KEY}"},
            {
                "model": OPENROUTER_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": query.query},
                ],
                "stream": True,
                "temperature": temperature,
                "max_tokens": max_output_tokens,
            },
        )

    async def stream_reply():
        answer_parts: list[str] = []
        zai_error: Exception | None = None
        try:
            async for delta in stream_zai():
                answer_parts.append(delta)
                yield json.dumps({"delta": delta}) + "\n"
        except Exception as e:
            zai_error = e

        if zai_error and not answer_parts:
            # Z.AI failed before producing anything — fall back to
            # OpenRouter, the provider this chat ran on before Z.AI was
            # added. If Z.AI instead failed partway through (some deltas
            # already streamed to the client), don't restart on a different
            # provider mid-message — a different model finishing the same
            # reply differently would be worse than just surfacing the error.
            try:
                async for delta in stream_openrouter():
                    answer_parts.append(delta)
                    yield json.dumps({"delta": delta}) + "\n"
            except Exception:
                yield json.dumps({"error": f"AI model request failed: {zai_error}"}) + "\n"
                return
        elif zai_error:
            yield json.dumps({"error": f"AI model request failed: {zai_error}"}) + "\n"
            return

        answer = "".join(answer_parts)
        citations = ["Live AWIP database — employees, tasks, payroll, workforce snapshot"]
        if personal:
            citations.append("Employee service book, leave, and insurance records")
        if lookup_block:
            citations.append("Looked-up colleague's service book, leave, and insurance records")
        if performers_block:
            citations.append("Per-employee appraisal ratings (performance_records)")
        if page_block:
            citations.append(f"{extract_page_name(query.query)} page data")
        report_type, redirect, quick_actions = classify_followup(user_text, bool(personal))
        yield json.dumps({
            "done": True,
            "citations": citations,
            "employeeId": employee_id,
            "reportType": report_type,
            "redirect": redirect,
            "quickActions": quick_actions,
        }) + "\n"

    return StreamingResponse(stream_reply(), media_type="application/x-ndjson")

REPORT_TABLE_STYLE = TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2937")),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
    ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
    ("FONTSIZE", (0, 0), (-1, -1), 9),
])

def make_report_table(header: list[str], rows: list[list]) -> Table:
    table = Table([header] + rows, hAlign="LEFT")
    table.setStyle(REPORT_TABLE_STYLE)
    return table

def build_report_pdf(filename: str, elements: list) -> StreamingResponse:
    """Shared ReportLab renderer for every PDF report generator — one
    SimpleDocTemplate/A4 layout so new report types don't re-copy the same
    document setup and table styling."""
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4)
    doc.build(elements)
    buffer.seek(0)
    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )

class ReportContext(BaseModel):
    """The chat turn that triggered a report download — question and Heera's
    own answer — so the PDF can carry a real, question-specific analysis
    instead of the same generic tables for every requester."""
    question: str
    answer: str

REPORT_ANALYSIS_PROMPT = """You are a workforce-governance analyst writing the opening analysis paragraph of a PDF report for AMC leadership. You'll be given the report's underlying data and, if available, the question that prompted this report. Write 3-4 sentences of real analysis grounded ONLY in the data given — reference specific numbers, note whichever department/case stands out best or worst, and if a triggering question is given, answer it directly as the opening sentence. Plain prose, no markdown, no headers, no restating these instructions."""

def generate_report_analysis(data_summary: str, context: ReportContext | None) -> str | None:
    """One extra non-streaming LLM call (reports are a background action, not
    a live chat turn, so waiting for the full paragraph is fine) that turns
    the raw table data into a real written analysis instead of leaving the
    PDF as tables alone."""
    if not ZAI_API_KEY:
        return None
    user_message = data_summary
    if context:
        user_message = f'Triggering question: "{context.question}"\nHeera\'s chat answer: "{context.answer}"\n\nReport data:\n{data_summary}'
    try:
        import asyncio
        return asyncio.run(call_llm(REPORT_ANALYSIS_PROMPT, user_message))
    except Exception:
        return None

def require_valid_token(authorization: str | None) -> None:
    """Org-wide report endpoints don't need an employee link (unlike the
    per-employee service record below), but shouldn't be callable by
    anonymous requests either — just confirm the bearer token is genuine."""
    if not authorization or not authorization.startswith("Bearer ") or not JWT_SECRET:
        raise HTTPException(status_code=401, detail="Missing or invalid authorization token.")
    token = authorization.removeprefix("Bearer ")
    try:
        jwt.decode(token, JWT_SECRET, algorithms=["HS256"], options={"verify_sub": False})
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Missing or invalid authorization token.")

@app.get("/api/v1/reports/employee/{employee_id}/service-record")
def generate_service_record_report(employee_id: str, authorization: str | None = Header(default=None)):
    """Generate a downloadable one-page PDF summarizing an employee's service
    record — documents, compensation, and leave balance."""
    requester_employee_id = resolve_employee_id(authorization)
    requester_role = decode_role(authorization)
    if requester_employee_id != employee_id and requester_role not in ("HRAdmin", "DepartmentHead"):
        raise HTTPException(status_code=403, detail="You can only download your own service record.")

    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT name, designation, department, doj, cadre FROM employees WHERE id = %s', (employee_id,))
            emp = cur.fetchone()
            if not emp:
                raise HTTPException(status_code=404, detail="Employee not found")
            name, designation, department, doj, cadre = emp

            cur.execute('SELECT "payGrade", "grossPay" FROM compensation WHERE "employeeId" = %s', (employee_id,))
            comp = cur.fetchone()

            cur.execute(
                'SELECT "leaveType", entitled, availed, balance FROM leave_balances WHERE "employeeId" = %s ORDER BY "leaveType"',
                (employee_id,),
            )
            leave_rows = cur.fetchall()

            cur.execute(
                'SELECT type, date, status FROM service_book_entries WHERE "employeeId" = %s ORDER BY date DESC',
                (employee_id,),
            )
            doc_rows = cur.fetchall()

    styles = getSampleStyleSheet()
    elements = [
        Paragraph("AWIP — Employee Service Record", styles["Title"]),
        Spacer(1, 12),
        Paragraph(f"{name} ({employee_id}) — {designation}, {department}", styles["Heading2"]),
        Paragraph(f"Cadre: {cadre} | Date of joining: {doj}", styles["Normal"]),
        Spacer(1, 12),
    ]

    if comp:
        elements.append(Paragraph(f"Pay grade: {comp[0]} | Gross pay: Rs.{comp[1]:,}/month", styles["Normal"]))
        elements.append(Spacer(1, 12))

    # Deterministic summary (no LLM call needed — this is real computed data,
    # not a generic blurb, and stays fast since it's just arithmetic).
    total_entitled = sum(r[1] for r in leave_rows) or 1
    total_balance = sum(r[3] for r in leave_rows)
    utilization_pct = round((1 - total_balance / total_entitled) * 100)
    verified_docs = sum(1 for d in doc_rows if d[2] == "Verified")
    elements.append(Paragraph(
        f"Summary: {utilization_pct}% of annual leave entitlement used so far; "
        f"{verified_docs} of {len(doc_rows)} service-book document(s) on file are Verified.",
        styles["Normal"],
    ))
    elements.append(Spacer(1, 12))

    elements.append(Paragraph("Leave Balance", styles["Heading3"]))
    elements.append(make_report_table(["Leave Type", "Entitled", "Availed", "Balance"], [list(r) for r in leave_rows]))
    elements.append(Spacer(1, 12))

    elements.append(Paragraph("Service Book Entries", styles["Heading3"]))
    elements.append(make_report_table(["Type", "Date", "Status"], [list(r) for r in doc_rows]))

    return build_report_pdf(f"service-record-{employee_id}.pdf", elements)

class DepartmentProfileIn(BaseModel):
    department: str
    employeeCount: int | None = None
    attendancePct: float | None = None
    slaPct: float | None = None
    vacancyCount: int | None = None
    budgetVariancePct: float | None = None
    healthScore: float | None = None
    auditStatus: str | None = None

class DepartmentDigestRequest(BaseModel):
    departments: list[DepartmentProfileIn]
    context: ReportContext | None = None

@app.post("/api/v1/reports/department-digest")
def generate_department_digest_report(payload: DepartmentDigestRequest, authorization: str | None = Header(default=None)):
    """Renders the department profiles already computed by server-core
    (healthScore, slaPct, budgetVariancePct etc.) into a PDF — no metrics are
    re-derived here, this endpoint only lays out data the frontend already
    fetched via coreApi.getDepartmentProfiles(), scoped to whatever
    department(s) the caller had selected."""
    require_valid_token(authorization)
    if not payload.departments:
        raise HTTPException(status_code=422, detail="No department data provided.")

    data_summary = "\n".join(
        f"- {d.department}: {d.employeeCount or 0} employees, {d.attendancePct if d.attendancePct is not None else '—'}% attendance, "
        f"{d.slaPct if d.slaPct is not None else '—'}% SLA, {d.vacancyCount or 0} vacancies, "
        f"{d.budgetVariancePct if d.budgetVariancePct is not None else '—'}% budget variance, "
        f"health score {d.healthScore if d.healthScore is not None else '—'}, audit: {d.auditStatus or '—'}"
        for d in payload.departments
    )
    analysis = generate_report_analysis(data_summary, payload.context)

    styles = getSampleStyleSheet()
    elements = [
        Paragraph("AWIP — Department Workforce & Compliance Digest", styles["Title"]),
        Spacer(1, 12),
    ]
    if analysis:
        elements.append(Paragraph("AI Analysis", styles["Heading3"]))
        elements.append(Paragraph(analysis, styles["Normal"]))
        elements.append(Spacer(1, 12))
    elements += [
        make_report_table(
            ["Department", "Headcount", "Attendance %", "SLA %", "Vacancies", "Budget Var %", "Health Score", "Audit"],
            [
                [
                    d.department, d.employeeCount or 0,
                    f"{d.attendancePct:.1f}" if d.attendancePct is not None else "—",
                    f"{d.slaPct:.1f}" if d.slaPct is not None else "—",
                    d.vacancyCount or 0,
                    f"{d.budgetVariancePct:+.1f}" if d.budgetVariancePct is not None else "—",
                    f"{d.healthScore:.0f}" if d.healthScore is not None else "—",
                    d.auditStatus or "—",
                ]
                for d in payload.departments
            ],
        ),
        Spacer(1, 14),
    ]

    ranked = sorted((d for d in payload.departments if d.healthScore is not None), key=lambda d: d.healthScore)
    if ranked:
        elements.append(Paragraph("Departments Needing Attention", styles["Heading3"]))
        worst = ", ".join(f"{d.department} ({d.healthScore:.0f})" for d in ranked[:3])
        elements.append(Paragraph(f"Lowest health scores: {worst}.", styles["Normal"]))

    return build_report_pdf("department-digest.pdf", elements)

class GrievanceIn(BaseModel):
    department: str | None = None
    status: str | None = None
    severity: str | None = None
    title: str | None = None

class LegalCaseIn(BaseModel):
    title: str | None = None
    department: str | None = None
    aiRiskScore: str | None = None
    exposure: str | None = None

class RiskSummaryRequest(BaseModel):
    grievances: list[GrievanceIn] = []
    legalCases: list[LegalCaseIn] = []
    context: ReportContext | None = None

@app.post("/api/v1/reports/risk-summary")
def generate_risk_summary_report(payload: RiskSummaryRequest, authorization: str | None = Header(default=None)):
    """Renders grievance and legal-case data already fetched via
    coreApi.getGrievances()/getLegalCases() into a cross-module risk PDF,
    scoped to whatever department the caller had selected."""
    require_valid_token(authorization)
    if not payload.grievances and not payload.legalCases:
        raise HTTPException(status_code=422, detail="No grievance or legal case data provided.")

    open_grievances_summary = [g for g in payload.grievances if g.status != "Resolved"]
    data_summary = (
        f"Grievances: {len(open_grievances_summary)} open of {len(payload.grievances)} total "
        f"({sum(1 for g in open_grievances_summary if g.severity == 'Critical')} Critical).\n"
        + "\n".join(f"- {g.title or '—'} ({g.department or '—'}): {g.status or '—'}, {g.severity or '—'} severity" for g in payload.grievances)
        + f"\n\nLegal cases: {len(payload.legalCases)} total.\n"
        + "\n".join(f"- {c.title or '—'} ({c.department or '—'}): risk {c.aiRiskScore or '—'}, exposure {c.exposure or '—'}" for c in payload.legalCases)
    )
    analysis = generate_report_analysis(data_summary, payload.context)

    styles = getSampleStyleSheet()
    elements = [
        Paragraph("AWIP — Grievance & Legal Risk Summary", styles["Title"]),
        Spacer(1, 12),
    ]
    if analysis:
        elements.append(Paragraph("AI Analysis", styles["Heading3"]))
        elements.append(Paragraph(analysis, styles["Normal"]))
        elements.append(Spacer(1, 12))

    open_grievances = [g for g in payload.grievances if g.status != "Resolved"]
    critical_grievances = [g for g in open_grievances if g.severity == "Critical"]
    elements.append(Paragraph("Open Grievances", styles["Heading3"]))
    elements.append(Paragraph(f"{len(open_grievances)} open, {len(critical_grievances)} marked Critical.", styles["Normal"]))
    if open_grievances:
        elements.append(Spacer(1, 8))
        elements.append(make_report_table(
            ["Title", "Department", "Status", "Severity"],
            [[g.title or "—", g.department or "—", g.status or "—", g.severity or "—"] for g in open_grievances],
        ))
    elements.append(Spacer(1, 14))

    elements.append(Paragraph("Legal Case Risk", styles["Heading3"]))
    if payload.legalCases:
        elements.append(make_report_table(
            ["Case", "Department", "AI Risk", "Exposure"],
            [[c.title or "—", c.department or "—", c.aiRiskScore or "—", c.exposure or "—"] for c in payload.legalCases],
        ))
    else:
        elements.append(Paragraph("No legal cases on record.", styles["Normal"]))

    return build_report_pdf("risk-summary.pdf", elements)

class GrievanceAnalysisRequest(BaseModel):
    subject: str
    description: str

async def call_zai(system_prompt: str, user_message: str) -> str:
    if not ZAI_API_KEY:
        raise RuntimeError("ZAI_API_KEY is not configured on server-ai.")
    async with httpx.AsyncClient(timeout=45.0) as client:
        res = await client.post(
            ZAI_URL,
            headers={"Authorization": f"Bearer {ZAI_API_KEY}"},
            json={
                "model": ZAI_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message},
                ],
                "thinking": {"type": "enabled" if ZAI_THINKING_ENABLED else "disabled"},
                "stream": False,
                "max_tokens": 320,
                "temperature": 0.3,
            },
        )
        res.raise_for_status()
        return res.json()["choices"][0]["message"]["content"]

async def call_ollama_fallback(system_prompt: str, user_message: str) -> str:
    async with httpx.AsyncClient(timeout=45.0) as client:
        res = await client.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": OLLAMA_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message},
                ],
                "stream": False,
                "keep_alive": "30m",
                "options": {"num_predict": 320, "temperature": 0.3},
            },
        )
        res.raise_for_status()
        return res.json()["message"]["content"]

async def call_llm(system_prompt: str, user_message: str) -> str:
    """Shared non-streaming call behind every structured/background AI
    feature (grievance analysis, draft emails/alerts, report analysis, task
    productivity insight, AI Agents narration). Tries Z.AI's GLM model first;
    if Z.AI itself errors (auth, quota/billing, timeout, network — not a
    response that merely fails the caller's own JSON/grounding checks), falls
    back to the local Ollama model that ran this before Z.AI was added, so a
    Z.AI outage doesn't take these features down entirely."""
    try:
        return await call_zai(system_prompt, user_message)
    except Exception as zai_err:
        try:
            return await call_ollama_fallback(system_prompt, user_message)
        except Exception:
            raise zai_err

GRIEVANCE_ANALYSIS_PROMPT = """You are an HR triage assistant. Given a grievance's subject and description, assess it and respond with ONLY a JSON object (no other text, no markdown fences) in this exact shape:
{"sentiment": "Hostile|Frustrated|Neutral|Anxious", "severity": "Critical|High|Medium|Low", "summary": "one sentence AI summary of the grievance"}

Use "Critical" severity only for allegations of harassment, safety, or legal/statutory risk. Use "Hostile" sentiment only when the language is angry or accusatory."""

@app.post("/api/v1/grievances/analyze")
async def analyze_grievance(req: GrievanceAnalysisRequest):
    fallback = {"sentiment": "Neutral", "severity": "Medium", "summary": req.description[:140]}
    try:
        raw = await call_llm(GRIEVANCE_ANALYSIS_PROMPT, f"Subject: {req.subject}\n\nDescription: {req.description}")
    except Exception:
        return fallback
    try:
        start, end = raw.index("{"), raw.rindex("}") + 1
        result = json.loads(raw[start:end])
        if result.get("sentiment") not in ("Hostile", "Frustrated", "Neutral", "Anxious"):
            result["sentiment"] = fallback["sentiment"]
        if result.get("severity") not in ("Critical", "High", "Medium", "Low"):
            result["severity"] = fallback["severity"]
        if not result.get("summary"):
            result["summary"] = fallback["summary"]
        return result
    except Exception:
        return fallback

class TaskProductivityRequest(BaseModel):
    weakest: dict
    strongest: dict
    sampleSize: int

TASK_PRODUCTIVITY_PROMPT = """You are a municipal workforce-productivity analyst. You will be given real, already-computed statistics for the weakest- and strongest-performing department/zone combinations by task completion rate. Respond with ONLY a JSON object (no other text, no markdown fences) in this exact shape:
{"narrative": "2-3 sentences naming the actual weakest department and zone with its real completion rate, overdue count, and average turnaround", "recommendedAction": "1-2 sentences with a concrete, specific manpower or task-reallocation suggestion naming both the weakest and strongest department/zone"}

Never invent numbers or names beyond what's given. Never give generic advice that could apply to any department — reference the specific figures provided."""

@app.post("/api/v1/tasks/productivity-insight")
async def task_productivity_insight(req: TaskProductivityRequest):
    user_message = (
        f"Weakest performer: {req.weakest}\n"
        f"Strongest performer: {req.strongest}\n"
        f"Sample size: {req.sampleSize} department/zone combinations evaluated."
    )
    try:
        raw = await call_llm(TASK_PRODUCTIVITY_PROMPT, user_message)
        start, end = raw.index("{"), raw.rindex("}") + 1
        result = json.loads(raw[start:end])
        if result.get("narrative") and result.get("recommendedAction"):
            return result
    except Exception:
        pass
    raise HTTPException(status_code=503, detail="Could not generate productivity insight — check ZAI_API_KEY / Z.AI availability.")

class GrievanceEmailRequest(BaseModel):
    subject: str
    description: str
    category: str
    submitterName: str | None = None

EMAIL_DRAFT_PROMPT = """You are an HR officer drafting a professional, empathetic email response to an employee grievance. Respond with ONLY a JSON object (no other text, no markdown fences) in this exact shape:
{"subject": "email subject line", "body": "full email body, plain text, professional tone, acknowledging the concern and outlining next steps"}"""

@app.post("/api/v1/grievances/draft-email")
async def draft_grievance_email(req: GrievanceEmailRequest):
    user_message = (
        f"Grievance category: {req.category}\nSubject: {req.subject}\nDescription: {req.description}\n"
        f"Submitter: {req.submitterName or 'the employee (anonymous submission)'}"
    )
    try:
        raw = await call_llm(EMAIL_DRAFT_PROMPT, user_message)
        start, end = raw.index("{"), raw.rindex("}") + 1
        result = json.loads(raw[start:end])
        if result.get("subject") and result.get("body"):
            return result
    except Exception:
        pass
    raise HTTPException(status_code=503, detail="Could not generate email draft — check ZAI_API_KEY / Z.AI availability.")

class EmergencyAlertMessageRequest(BaseModel):
    title: str
    description: str
    category: str
    department: str
    severity: str
    location: str | None = None

ALERT_DRAFT_PROMPT = """You are a municipal corporation official drafting an urgent notification to the department authority responsible for a civic/infrastructure emergency. Respond with ONLY a JSON object (no other text, no markdown fences) in this exact shape:
{"subject": "short urgent email subject line", "body": "full message body, plain text, urgent but professional tone, stating the incident, its severity, location if given, and requesting immediate action/acknowledgement"}"""

@app.post("/api/v1/emergency/draft-alert-message")
async def draft_emergency_alert_message(req: EmergencyAlertMessageRequest):
    user_message = (
        f"Category: {req.category}\nSeverity: {req.severity}\nDepartment: {req.department}\n"
        f"Title: {req.title}\nDescription: {req.description}\nLocation: {req.location or 'not specified'}"
    )
    try:
        raw = await call_llm(ALERT_DRAFT_PROMPT, user_message)
        start, end = raw.index("{"), raw.rindex("}") + 1
        result = json.loads(raw[start:end])
        if result.get("subject") and result.get("body"):
            return result
    except Exception:
        pass
    raise HTTPException(status_code=503, detail="Could not generate alert message draft — check ZAI_API_KEY / Z.AI availability.")

class AgentNarrateRequest(BaseModel):
    agentKey: str
    findings: dict

# One prompt per Command Centre agent — the SQL layer in server-core/agents.js
# has already decided what's true (counts, thresholds, breaches); this prompt
# only turns that structured findings JSON into a short narrative + one
# recommended action. Same "respond with ONLY JSON" contract as the
# grievance-analysis/email-draft prompts above.
#
# Each entry carries its OWN worked example using that agent's real field
# names/units. A single shared example ("Redeploy 3 staff to Drainage - East
# Zone") used to sit in AGENT_OUTPUT_CONTRACT below and was verified to cause
# exactly the failure it looks like it would: the small local model (llama3.2:
# 3b) pattern-matched that phrasing onto agents whose findings have no
# headcount field at all, fabricating a "staff" figure from an unrelated
# number in the data (workforce-demand-predictor's task-count delta 211-159=52
# came back narrated as "need 52 staff"; workforce-capacity-predictor's
# shortfallPct 91.8 came back as "fall short by approximately 95 staff" — 95
# does not appear anywhere in that finding). Giving each agent a tailored
# example in its own real units, plus the numeric-grounding check in
# narrate_agent below, closes both the specific failure and the general class
# of it.
AGENT_PROMPTS = {
    "workforce-demand-predictor": (
        "You are AWIP's Workforce Demand Predictor agent. Given a trend-projected next-month TASK "
        "VOLUME (a count of tasks, not people) by department/zone, plus upcoming holidays and "
        "already-filed leave, name the specific department/zone projected to need more task-handling "
        "capacity and by when. These findings have no headcount field — never say 'N staff' or "
        "'N employees'; describe the increase in tasks/workload/capacity terms only. Example: given "
        "{\"department\": \"Drainage\", \"zone\": \"East\", \"currentMonthTasks\": 120, "
        "\"projectedNextMonthTasks\": 150, \"changePct\": 25, \"nextMonth\": \"2026-09\"}, respond "
        "{\"narrative\": \"Drainage - East Zone is projected to need 25% more task capacity by "
        "2026-09 (120 to 150 tasks).\", \"recommendedAction\": \"Redistribute workload or bring in "
        "temporary support for Drainage - East Zone ahead of 2026-09.\"}"
    ),
    "workforce-capacity-predictor": (
        "You are AWIP's Workforce Capacity Predictor agent. Given a department's real headcount, its "
        "effectiveCapacity (headcount minus already-filed leave and upcoming retirements — also a "
        "real headcount figure), and shortfallPct (how far its workload-per-head ratio would rise "
        "above its own historical average), name the specific department and state the shortfall as "
        "a PERCENTAGE using shortfallPct — never convert shortfallPct into an invented headcount gap "
        "number, since no field in these findings represents 'N people short'. Example: given "
        "{\"department\": \"Drainage\", \"headcount\": 300, \"effectiveCapacity\": 285, "
        "\"shortfallPct\": 18.4, \"retiringWithin60d\": 2}, respond {\"narrative\": \"Drainage is "
        "projected 18.4% short of the capacity its usual workload needs, with effective capacity "
        "down to 285 of its 300 headcount.\", \"recommendedAction\": \"Arrange temporary "
        "redeployment or overtime cover for Drainage before the shortfall lands.\"}"
    ),
    "attendance-risk-predictor": (
        "You are AWIP's Attendance Risk Predictor agent. Given a trend-projected next-month "
        "attendance % by department/zone (a real regression over historical months) and the real "
        "riskThresholdPct this agent alerts against, name the specific department/zone at risk, "
        "state the projected % exactly as given, and reference the real riskThresholdPct — never "
        "invent your own threshold framing. Example: given {\"department\": \"Estate\", \"zone\": "
        "\"South-West\", \"currentPct\": 70, \"projectedNextMonthPct\": 69.5, \"riskThresholdPct\": "
        "85}, respond {\"narrative\": \"Estate - South-West attendance is projected to fall to 69.5% "
        "next month, well under the 85% risk threshold.\", \"recommendedAction\": \"Open an "
        "attendance-drivers review for Estate - South-West before next month.\"}"
    ),
    "budget-overrun-predictor": (
        "You are AWIP's Budget Overrun Predictor agent. Given a trend-projected next-month budget "
        "variance % by department and the real alertThresholdPct this agent alerts against, name the "
        "specific department and the projected variance exactly as given. If the trend fit is weak "
        "(low trendR2), say so plainly rather than presenting a confident number from noise. Example: "
        "given {\"department\": \"Housing\", \"currentVariancePct\": 8.1, "
        "\"projectedNextMonthVariancePct\": 12.2, \"trendR2\": 0.2, \"alertThresholdPct\": 10}, "
        "respond {\"narrative\": \"Housing's budget variance is projected to reach 12.2% next month, "
        "above the 10% threshold, though the trend fit is weak (r2 0.2).\", \"recommendedAction\": "
        "\"Review discretionary spend in Housing before next month's cycle closes.\"}"
    ),
    "skill-gap-predictor": (
        "You are AWIP's Skill Gap Predictor agent. Given a critical department skill's real current "
        "holder count (currentHolders), how many of those holders are retirement-due within 24 "
        "months (retiringWithin24mo), and the resulting projectedHolders24mo, name the specific "
        "department/skill pair and state the projected holder count and loss % exactly as given — "
        "never invent a different holder number. Example: given {\"department\": \"Water Supply\", "
        "\"skill\": \"Water Treatment Ops\", \"currentHolders\": 40, \"retiringWithin24mo\": 10, "
        "\"projectedHolders24mo\": 30, \"projectedLossPct\": 25}, respond {\"narrative\": \"Water "
        "Supply is projected to lose 25% of its Water Treatment Ops holders within 24 months, from "
        "40 down to 30.\", \"recommendedAction\": \"Nominate backfill candidates for Water Treatment "
        "Ops in Water Supply before the projected retirements land.\"}"
    ),
    "weather-staff-planner": (
        "You are AWIP's Weather Staffing Planner agent. Given live current/forecast rainfall for "
        "Ahmedabad, vacancy shortfalls in flood-critical departments, the thinnest-staffed zone in "
        "the worst-affected one, and reschedule candidates among open outdoor tasks, name the exact "
        "department and zone and tie the action to the weather reason if a rain trigger is active. "
        "If no rain trigger is active, say staffing recommendations are on hold rather than "
        "inventing urgency. Example: given {\"weather\": {\"conditionLabel\": \"Heavy Rain\", "
        "\"rainTriggerActive\": true}, \"shortStaffed\": [{\"department\": \"Drainage\", "
        "\"priorityZone\": \"East\", \"vacancyRatePct\": 12}]}, respond {\"narrative\": \"Heavy Rain "
        "forecast: Drainage - East Zone is short-staffed (12% vacancy rate) and at risk of "
        "disruption.\", \"recommendedAction\": \"Redeploy staff to Drainage - East Zone ahead of the "
        "forecast.\"}"
    ),
}

# The panel leads with action, not paragraphs — this prompt exists to keep
# the LLM's output that short: one sentence stating the projection (never a
# restatement of the whole findings object), and a recommendedAction that
# reads as an instruction naming a real department/number/date, since the
# frontend surfaces it as the primary call-to-action button, not as prose
# to read.
AGENT_OUTPUT_CONTRACT = (
    ' The findings object contains exactly one finding — base your narrative and recommendation on '
    'that finding only, using ONLY numbers and units that literally appear in it (never invent a '
    'headcount/staff figure that is not itself a field in the findings, and never relabel a '
    'percentage, task count, or day count as "staff" or "employees"). Respond with ONLY a JSON '
    'object (no other text, no markdown fences) in this exact shape: {"narrative": "exactly 1 '
    'sentence stating the projected number/department/timeframe in its real unit", '
    '"recommendedAction": "one short imperative instruction naming the specific department/zone and '
    'a concrete next step — never a bare \'monitor\' or \'keep an eye on\' with nothing else to act '
    'on"}. '
    "Only state a timeframe (month, 'within N days', etc.) that literally appears in the findings — "
    "never invent a specific day of the week or calendar date that isn't in the data. "
    "If the findings show no breach of any threshold, say so plainly in one short sentence instead "
    "of inventing a risk, and set recommendedAction to \"No action needed.\""
)

# Extracts every standalone number the model wrote in its narrative/action and
# rejects the whole response if any of them can't be traced back to a real
# number in the findings that were sent — see the AGENT_PROMPTS comment above
# for the two live hallucinations (52, 95 "staff") this closes. ISO month/date
# tokens (2026-08, 2026-07-15) are stripped first so they aren't parsed as
# multiple ungrounded numbers. A generous tolerance (±0.6 absolute or ±5%
# relative) allows for the model's own rounding of a real value.
def _flatten_numbers(obj, acc):
    if isinstance(obj, bool):
        return
    if isinstance(obj, (int, float)):
        acc.add(float(obj))
    elif isinstance(obj, dict):
        for v in obj.values():
            _flatten_numbers(v, acc)
    elif isinstance(obj, list):
        for v in obj:
            _flatten_numbers(v, acc)

def _numbers_in_text(text):
    stripped = re.sub(r"\d{4}-\d{2}(-\d{2})?", " ", text or "")
    return [float(n) for n in re.findall(r"\d+(?:\.\d+)?", stripped)]

def _agent_output_is_grounded(narrative, recommended_action, findings):
    known = set()
    _flatten_numbers(findings, known)
    claimed = _numbers_in_text(narrative) + _numbers_in_text(recommended_action)
    for n in claimed:
        if not any(abs(n - k) <= max(0.6, k * 0.05) for k in known):
            return False
    return True

@app.post("/api/v1/agents/narrate")
async def narrate_agent(req: AgentNarrateRequest):
    system_prompt = AGENT_PROMPTS.get(req.agentKey)
    if not system_prompt:
        raise HTTPException(status_code=400, detail=f"Unknown agentKey '{req.agentKey}'")

    user_message = f"Findings:\n{json.dumps(req.findings, default=str)}"
    try:
        raw = await call_llm(system_prompt + AGENT_OUTPUT_CONTRACT, user_message)
        start, end = raw.index("{"), raw.rindex("}") + 1
        result = json.loads(raw[start:end])
        narrative, recommended = result.get("narrative"), result.get("recommendedAction")
        if narrative and recommended and _agent_output_is_grounded(narrative, recommended, req.findings):
            return result
    except Exception:
        pass
    # No grounded LLM result — caller (server-core/agents.js runAgentTick) falls
    # back to its own deterministic FALLBACK_NARRATIVE/FALLBACK_RECOMMENDED_ACTION
    # text, which is built directly from the same findings and can't hallucinate.
    raise HTTPException(status_code=503, detail="Could not generate a grounded agent narrative")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
