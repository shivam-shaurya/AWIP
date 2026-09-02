#!/usr/bin/env bash
# pull_results.sh - one-command retrieval of extraction outputs from the GPU server to the laptop.
# Ops helper (Phase 4). Usage from the laptop repo root:
#     bash pull_results.sh                       # pulls the default output dirs
#     bash pull_results.sh out_synth out_docling # pulls specific dirs
#
# Uses tar-over-ssh (no rsync needed). Reads the ml-server host + key from ~/.ssh/config
# (Host ml-server). If the server IP changed after a Stop/Start, update that one line in
# ~/.ssh/config first (or assign an Elastic IP so it never changes - see DEPLOY notes).
set -euo pipefail
HOST="${KBE_HOST:-ml-server}"
REMOTE_DIR="${KBE_REMOTE:-~/kb-extract-rig}"
DIRS=("$@")
if [ ${#DIRS[@]} -eq 0 ]; then
  DIRS=(out_all sched_out out_docs out_docling out_ensemble out_synth eval/reports)
fi
# only pull dirs that exist on the server (silently skip the rest)
EXISTING=$(ssh "$HOST" "cd $REMOTE_DIR && for d in ${DIRS[*]}; do [ -e \"\$d\" ] && echo \"\$d\"; done")
if [ -z "$EXISTING" ]; then
  echo "nothing to pull (none of: ${DIRS[*]} exist on $HOST:$REMOTE_DIR)"; exit 0
fi
echo "pulling from $HOST:$REMOTE_DIR -> $(pwd)"
echo "$EXISTING" | sed 's/^/  /'
# shellcheck disable=SC2086
ssh "$HOST" "cd $REMOTE_DIR && tar czf - $EXISTING" | tar xzf -
echo "[ok] pulled to $(pwd)"
