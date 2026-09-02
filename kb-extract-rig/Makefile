# kb-extract-rig - convenience targets. `make check` mirrors check.sh / check.ps1 / CI.
# (Windows without `make`: run  bash check.sh  or  powershell -File check.ps1  instead.)
.PHONY: check test compile lint

check:            ## full local CI-equivalent: compile -> tests -> lint
	@bash check.sh

compile:          ## py_compile every module (fatal on syntax error)
	python -m compileall -f -q -x "(\.claude|__pycache__|\.git|\.github|venv|\.venv)" .

test:             ## run the unit suite
	python tests/test_core.py

lint:             ## critical lint (fatal) + full lint (informational)
	python -m ruff check --select E9,F63,F7,F82 .
	-python -m ruff check .
