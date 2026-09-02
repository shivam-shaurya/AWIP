#!/usr/bin/env bash
# Restores a pg_dump custom-format backup created by db-backup.sh.
#
# Usage: server-core/scripts/db-restore.sh backups/awip_db_20260728-153000.dump
#
# WARNING: this drops and recreates every object in the target database
# (--clean --if-exists) before restoring the dump's contents. Confirms
# interactively before running.
set -euo pipefail

CONTAINER="${AWIP_DB_CONTAINER:-awip-postgres}"
DB_USER="${AWIP_DB_USER:-awip_admin}"
DB_NAME="${AWIP_DB_NAME:-awip_db}"

if [ $# -ne 1 ]; then
  echo "Usage: $0 <path-to-dump-file>" >&2
  exit 1
fi
DUMP_FILE="$1"
if [ ! -f "$DUMP_FILE" ]; then
  echo "Dump file not found: $DUMP_FILE" >&2
  exit 1
fi

echo "This will DROP and recreate every object in '${DB_NAME}' (container ${CONTAINER})"
echo "before restoring from: ${DUMP_FILE}"
read -r -p "Type YES to continue: " CONFIRM
if [ "$CONFIRM" != "YES" ]; then
  echo "Aborted."
  exit 1
fi

docker exec -i "$CONTAINER" pg_restore -U "$DB_USER" -d "$DB_NAME" --clean --if-exists --no-owner < "$DUMP_FILE"
echo "Restore complete."
