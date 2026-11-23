#!/usr/bin/env bash
# Plenary Safe Hot Backup Script
#
# Performs a consistent online backup of Plenary state:
#   - SQLite databases (`plenary.db`, `registry.db`) via SQLite's online `.backup` API
#     (NEVER raw `cp` of an open WAL-mode database!)
#   - Optional PostgreSQL database via `pg_dump --format=custom`
#   - Local blob store (`<data-dir>/blobs`) archived as `blobs.tar.gz`
#   - SHA-256 checksum manifest (`SHA256SUMS`) and `metadata.json`
#
# Usage:
#   deploy/scripts/backup.sh --data-dir /data --output-dir /backups
#   deploy/scripts/backup.sh --data-dir /data --output-dir /backups --database-url "$DATABASE_URL"

set -euo pipefail
umask 077

DATA_DIR="${PLENARY_DATA_DIR:-/data}"
OUTPUT_DIR="${PLENARY_BACKUP_DIR:-./backups}"
DATABASE_URL_ARG=""
SKIP_BLOBS=0
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

usage() {
  cat <<'EOF'
Usage: backup.sh [OPTIONS]

Options:
  --data-dir <path>       Plenary data directory (default: $PLENARY_DATA_DIR or /data)
  --output-dir <path>     Parent directory for timestamped backup folders (default: ./backups)
  --database-url <url>    Optional PostgreSQL connection URL for pg_dump
  --skip-blobs            Skip archiving <data-dir>/blobs
  -h, --help              Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir)
      DATA_DIR="${2:?--data-dir requires a value}"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="${2:?--output-dir requires a value}"
      shift 2
      ;;
    --database-url)
      DATABASE_URL_ARG="${2:?--database-url requires a value}"
      shift 2
      ;;
    --skip-blobs)
      SKIP_BLOBS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

compute_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$@"
  else
    echo "ERROR: neither sha256sum nor shasum found on PATH" >&2
    exit 1
  fi
}

sqlite_hot_backup() {
  local src="$1"
  local dest="$2"
  local escaped_dest="${dest//\'/\'\'}"

  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "ERROR: sqlite3 is required for safe hot SQLite backups" >&2
    exit 1
  fi

  # Use SQLite's online backup API (WAL-safe, waits up to 10s on busy locks).
  sqlite3 "$src" ".timeout 10000" ".backup '${escaped_dest}'"

  local check
  check="$(sqlite3 "$dest" "PRAGMA integrity_check;")"
  if [[ "$check" != "ok" ]]; then
    echo "ERROR: SQLite integrity check failed for ${dest}: ${check}" >&2
    exit 1
  fi
}

mkdir -p "$OUTPUT_DIR"
BACKUP_PATH="${OUTPUT_DIR%/}/plenary-backup-${TIMESTAMP}"
if [[ -e "$BACKUP_PATH" ]]; then
  BACKUP_PATH="${BACKUP_PATH}-$$"
fi
mkdir -p "$BACKUP_PATH"

# Clean up partial backup directory on failure.
cleanup_on_error() {
  local code=$?
  if [[ $code -ne 0 && -d "$BACKUP_PATH" ]]; then
    echo "ERROR: backup failed (exit ${code}); removing incomplete directory ${BACKUP_PATH}" >&2
    rm -rf "$BACKUP_PATH"
  fi
}
trap cleanup_on_error EXIT

ARTIFACTS=()

# 1. Safe hot SQLite backups (plenary.db and registry.db)
for db_name in plenary.db registry.db; do
  src_db="${DATA_DIR%/}/${db_name}"
  if [[ -f "$src_db" ]]; then
    echo "Backing up SQLite database ${db_name} (hot .backup)..."
    sqlite_hot_backup "$src_db" "${BACKUP_PATH}/${db_name}"
    ARTIFACTS+=("$db_name")
  fi
done

# 2. Optional PostgreSQL dump
if [[ -n "$DATABASE_URL_ARG" ]]; then
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "ERROR: pg_dump is required when --database-url is provided" >&2
    exit 1
  fi
  echo "Backing up PostgreSQL database (pg_dump custom format)..."
  pg_dump --format=custom --no-owner --no-acl --file="${BACKUP_PATH}/postgres.dump" "$DATABASE_URL_ARG"
  ARTIFACTS+=("postgres.dump")
fi

# 3. Local blob store archive
if [[ "$SKIP_BLOBS" -eq 0 && -d "${DATA_DIR%/}/blobs" ]]; then
  echo "Archiving local blob store..."
  tar -C "$DATA_DIR" -czf "${BACKUP_PATH}/blobs.tar.gz" blobs
  ARTIFACTS+=("blobs.tar.gz")
fi

if [[ "${#ARTIFACTS[@]}" -eq 0 ]]; then
  echo "ERROR: nothing found to back up in ${DATA_DIR} (no plenary.db, registry.db, blobs/, or --database-url)" >&2
  exit 1
fi

# 4. Write metadata.json (with JSON string escaping)
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

HOST_NAME="$(hostname 2>/dev/null || echo unknown)"
{
  printf '{\n'
  printf '  "createdAt": "%s",\n' "$(json_escape "$TIMESTAMP")"
  printf '  "hostname": "%s",\n' "$(json_escape "$HOST_NAME")"
  printf '  "dataDir": "%s",\n' "$(json_escape "$DATA_DIR")"
  printf '  "hasPostgres": %s,\n' "$([[ -n "$DATABASE_URL_ARG" ]] && echo true || echo false)"
  printf '  "artifacts": ['
  for i in "${!ARTIFACTS[@]}"; do
    [[ $i -gt 0 ]] && printf ', '
    printf '"%s"' "$(json_escape "${ARTIFACTS[$i]}")"
  done
  printf ']\n}\n'
} > "${BACKUP_PATH}/metadata.json"
ARTIFACTS+=("metadata.json")

# 5. Generate SHA-256 checksum manifest (relative filenames, sorted)
(
  cd "$BACKUP_PATH"
  LC_ALL=C printf '%s\n' "${ARTIFACTS[@]}" | sort | while IFS= read -r file; do
    compute_sha256 "$file"
  done > SHA256SUMS
)

trap - EXIT
echo "Backup complete: ${BACKUP_PATH}"
echo "Checksum manifest: ${BACKUP_PATH}/SHA256SUMS"
