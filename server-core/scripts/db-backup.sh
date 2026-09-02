#!/usr/bin/env bash
# Snapshots the local awip-postgres Docker container's database to
# backups/awip_db_<timestamp>.dump — pg_dump custom format (compressed,
# supports selective restore via `pg_restore --list` / `pg_restore -t <table>`).
#
# Run from anywhere: server-core/scripts/db-backup.sh
set -euo pipefail

CONTAINER="${AWIP_DB_CONTAINER:-awip-postgres}"
DB_USER="${AWIP_DB_USER:-awip_admin}"
DB_NAME="${AWIP_DB_NAME:-awip_db}"
BACKUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="$BACKUP_DIR/awip_db_${TIMESTAMP}.dump"

mkdir -p "$BACKUP_DIR"

echo "Backing up ${DB_NAME} from container ${CONTAINER} -> ${OUT_FILE}"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -Fc "$DB_NAME" > "$OUT_FILE"

SIZE=$(du -h "$OUT_FILE" | cut -f1)
echo "Backup complete: ${OUT_FILE} (${SIZE})"
echo "Restore with: server-core/scripts/db-restore.sh \"${OUT_FILE}\""
