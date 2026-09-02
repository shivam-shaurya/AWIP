#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# check.sh - local CI-equivalent (NO git needed). Runs, in order:
#   1. py_compile of every module   (fatal on syntax error)
#   2. python tests/test_core.py    (fatal on test failure)
#   3. lint                         (ruff or flake8; SKIPS cleanly if neither is
#                                    installed - a missing linter is NOT a failure)
# Exit code is non-zero iff step 1 or 2 (or a CRITICAL lint error) failed.
# Usage:  bash check.sh            (or ./check.sh after chmod +x)
# -----------------------------------------------------------------------------
set -u
cd "$(dirname "$0")"
fail=0

echo "== [1/3] py_compile (all modules) =="
if python -m compileall -f -q -x "(\.claude|__pycache__|\.git|\.github|venv|\.venv)" . ; then
    echo "   OK: every module compiles"
else
    echo "   FAIL: a module did not compile"; fail=1
fi

echo "== [2/3] unit tests (tests/test_core.py) =="
if python tests/test_core.py ; then
    echo "   OK: unit tests passed"
else
    echo "   FAIL: unit tests failed"; fail=1
fi

echo "== [3/3] lint (critical = fatal, full = informational) =="
lint_critical() {           # $1 = tool prefix, e.g. "python -m ruff" or "python -m flake8"
    local tool="$1"
    case "$tool" in
        *ruff*)  $tool check --select E9,F63,F7,F82 . ;;
        *flake8*) $tool . --select=E9,F63,F7,F82 --show-source ;;
    esac
}
lint_full() {
    local tool="$1"
    case "$tool" in
        *ruff*)  $tool check . || true ;;
        *flake8*) $tool . --exit-zero --count || true ;;
    esac
}
TOOL=""
if python -m ruff --version   >/dev/null 2>&1; then TOOL="python -m ruff"
elif command -v ruff          >/dev/null 2>&1; then TOOL="ruff"
elif python -m flake8 --version >/dev/null 2>&1; then TOOL="python -m flake8"
elif command -v flake8        >/dev/null 2>&1; then TOOL="flake8"
fi
if [ -z "$TOOL" ]; then
    echo "   SKIP: no linter installed (pip install ruff) - not a failure"
else
    echo "   using: $TOOL"
    if lint_critical "$TOOL" ; then
        echo "   OK: critical lint (E9,F63,F7,F82) clean"
        echo "   --- full lint (style; informational only, never fails the check) ---"
        lint_full "$TOOL"
    else
        echo "   FAIL: critical lint errors (syntax / undefined names)"; fail=1
    fi
fi

echo "======================================"
if [ "$fail" -eq 0 ]; then echo "CHECK: PASS"; else echo "CHECK: FAIL"; fi
exit "$fail"
