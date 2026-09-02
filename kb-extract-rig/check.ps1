# -----------------------------------------------------------------------------
# check.ps1 - local CI-equivalent (NO git needed). Runs, in order:
#   1. py_compile of every module   (fatal on syntax error)
#   2. python tests/test_core.py    (fatal on test failure)
#   3. lint                         (ruff or flake8; SKIPS cleanly if neither is
#                                    installed - a missing linter is NOT a failure)
# Exit code is non-zero iff step 1 or 2 (or a CRITICAL lint error) failed.
# Usage:  powershell -ExecutionPolicy Bypass -File check.ps1     (or  .\check.ps1)
# -----------------------------------------------------------------------------
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
$fail = 0

Write-Host "== [1/3] py_compile (all modules) =="
python -m compileall -f -q -x "(\.claude|__pycache__|\.git|\.github|venv|\.venv)" .
if ($LASTEXITCODE -eq 0) { Write-Host "   OK: every module compiles" }
else { Write-Host "   FAIL: a module did not compile"; $fail = 1 }

Write-Host "== [2/3] unit tests (tests/test_core.py) =="
python tests/test_core.py
if ($LASTEXITCODE -eq 0) { Write-Host "   OK: unit tests passed" }
else { Write-Host "   FAIL: unit tests failed"; $fail = 1 }

Write-Host "== [3/3] lint (critical = fatal, full = informational) =="
$tool = $null
python -m ruff --version *> $null
if ($LASTEXITCODE -eq 0) { $tool = "ruff" }
else {
    python -m flake8 --version *> $null
    if ($LASTEXITCODE -eq 0) { $tool = "flake8" }
}
if ($null -eq $tool) {
    Write-Host "   SKIP: no linter installed (pip install ruff) - not a failure"
}
elseif ($tool -eq "ruff") {
    Write-Host "   using: python -m ruff"
    python -m ruff check --select E9,F63,F7,F82 .
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   OK: critical lint (E9,F63,F7,F82) clean"
        Write-Host "   --- full lint (style; informational only) ---"
        python -m ruff check .    # informational; its exit code is intentionally ignored
    } else { Write-Host "   FAIL: critical lint errors"; $fail = 1 }
}
else {
    Write-Host "   using: python -m flake8"
    python -m flake8 . --select=E9,F63,F7,F82 --show-source
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   OK: critical lint clean"
        Write-Host "   --- full lint (style; informational only) ---"
        python -m flake8 . --exit-zero --count
    } else { Write-Host "   FAIL: critical lint errors"; $fail = 1 }
}

Write-Host "======================================"
if ($fail -eq 0) { Write-Host "CHECK: PASS" } else { Write-Host "CHECK: FAIL" }
exit $fail
