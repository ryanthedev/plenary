#!/usr/bin/env bash
# Plenary Verified Restore Script
#
# Verifies SHA-256 checksums (`SHA256SUMS`) before modifying any target file or database.
# Supports restoring:
#   - SQLite databases (`plenary.db`, `registry.db`) with stale WAL/SHM cleanup + integrity check
#   - Local blob store (`blobs.tar.gz`) with path-traversal validation + atomic swap
#   - PostgreSQL dump (`postgres.dump`) via `pg_restore`
#
# IMPORTANT: Stop all Plenary nodes writing to the target database before restoring.
#
# Usage:
#   deploy/scripts/restore.sh --backup-dir /backups/plenary-backup-20261123T000000Z --verify-only
#   deploy/scripts/restore.sh --backup-dir /backups/plenary-backup-20261123T000000Z --data-dir /data --force

set -euo pipefail
umask 077

BACKUP_DIR=""
DATA_DIR="${PLENARY_DATA_DIR:-/data}"
DATABASE_URL_ARG=""
FORCE=0
VERIFY_ONLY=0

usage() {
  cat <<'EOF'
Usage: restore.sh --backup-dir <path> [OPTIONS]

Options:
  --backup-dir <path>     Backup directory containing SHA256SUMS (required)
  --data-dir <path>       Target Plenary data directory (default: $PLENARY_DATA_DIR or /data)
  --database-url <url>    Optional PostgreSQL URL to restore postgres.dump into
  --verify-only           Verify SHA-256 checksums and SQLite integrity without restoring
  --force                 Overwrite existing databases / blobs in --data-dir
  -h, --help              Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-dir)
      BACKUP_DIR="${2:?--backup-dir requires a value}"
      shift 2
      ;;
    --data-dir)
      DATA_DIR="${2:?--data-dir requires a value}"
      shift 2
      ;;
    --database-url)
      DATABASE_URL_ARG="${2:?--database-url requires a value}"
      shift 2
      ;;
    --verify-only)
      VERIFY_ONLY=1
      shift
      ;;
    --force)
      FORCE=1
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

if [[ -z "$BACKUP_DIR" ]]; then
  echo "ERROR: --backup-dir is required" >&2
  usage >&2
  exit 2
fi

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "ERROR: backup directory does not exist: ${BACKUP_DIR}" >&2
  exit 1
fi

MANIFEST="${BACKUP_DIR%/}/SHA256SUMS"
if [[ ! -f "$MANIFEST" ]]; then
  echo "ERROR: checksum manifest missing: ${MANIFEST}" >&2
  exit 1
fi

verify_sha256_manifest() {
  local dir="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$dir" && sha256sum -c SHA256SUMS)
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$dir" && shasum -a 256 -c SHA256SUMS)
  else
    echo "ERROR: neither sha256sum nor shasum found on PATH" >&2
    exit 1
  fi
}

echo "Verifying SHA-256 checksums in ${BACKUP_DIR}..."
verify_sha256_manifest "$BACKUP_DIR"

# Verify SQLite integrity of backup files before touching target
for db_name in plenary.db registry.db; do
  src_db="${BACKUP_DIR%/}/${db_name}"
  if [[ -f "$src_db" ]]; then
    if ! command -v sqlite3 >/dev/null 2>&1; then
      echo "ERROR: sqlite3 is required to verify and restore ${db_name}" >&2
      exit 1
    fi
    check="$(sqlite3 "$src_db" "PRAGMA integrity_check;")"
    if [[ "$check" != "ok" ]]; then
      echo "ERROR: backup SQLite integrity check failed for ${src_db}: ${check}" >&2
      exit 1
    fi
  fi
done

if [[ "$VERIFY_ONLY" -eq 1 ]]; then
  echo "Verification succeeded (no files modified)."
  exit 0
fi

# Check for existing target data unless --force is specified
mkdir -p "$DATA_DIR"
for db_name in plenary.db registry.db; do
  if [[ -f "${BACKUP_DIR%/}/${db_name}" && -e "${DATA_DIR%/}/${db_name}" && "$FORCE" -ne 1 ]]; then
    echo "ERROR: target ${DATA_DIR%/}/${db_name} already exists; stop Plenary and re-run with --force to overwrite" >&2
    exit 1
  fi
done

if [[ -f "${BACKUP_DIR%/}/blobs.tar.gz" && -d "${DATA_DIR%/}/blobs" && "$FORCE" -ne 1 ]]; then
  echo "ERROR: target ${DATA_DIR%/}/blobs already exists; stop Plenary and re-run with --force to overwrite" >&2
  exit 1
fi

# Stage and validate ALL artifacts before modifying any live target files.
STAGING_DIR="$(mktemp -d "${DATA_DIR%/}/.plenary-restore-stage.XXXXXX")"
ROLLBACK_DIR=""
SWAPPED_ITEMS=()

cleanup_and_rollback() {
  local code=$?
  if [[ $code -ne 0 && -n "$ROLLBACK_DIR" && -d "$ROLLBACK_DIR" ]]; then
    echo "ERROR: restore failed (exit ${code}); rolling back local files..." >&2
    for item in "${SWAPPED_ITEMS[@]}"; do
      rm -rf "${DATA_DIR%/}/${item}"
      if [[ -e "${ROLLBACK_DIR}/${item}" ]]; then
        mv -f "${ROLLBACK_DIR}/${item}" "${DATA_DIR%/}/${item}"
      fi
    done
  fi
  [[ -n "$STAGING_DIR" && -d "$STAGING_DIR" ]] && rm -rf "$STAGING_DIR"
  [[ -n "$ROLLBACK_DIR" && -d "$ROLLBACK_DIR" ]] && rm -rf "$ROLLBACK_DIR"
}
trap cleanup_and_rollback EXIT

# 1. Stage & verify SQLite databases
STAGED_DBS=()
for db_name in plenary.db registry.db; do
  src_db="${BACKUP_DIR%/}/${db_name}"
  if [[ -f "$src_db" ]]; then
    staged_db="${STAGING_DIR}/${db_name}"
    cp "$src_db" "$staged_db"
    check="$(sqlite3 "$staged_db" "PRAGMA integrity_check;")"
    if [[ "$check" != "ok" ]]; then
      echo "ERROR: staged SQLite integrity check failed for ${db_name}: ${check}" >&2
      exit 1
    fi
    STAGED_DBS+=("$db_name")
  fi
done

# 2. Validate & stage local blob store archive (reject absolute paths, .. traversal, symlinks, hardlinks, special files)
HAS_STAGED_BLOBS=0
if [[ -f "${BACKUP_DIR%/}/blobs.tar.gz" ]]; then
  echo "Validating and staging blob archive..."
  while IFS= read -r entry; do
    if [[ "$entry" == /* || "$entry" == *".."* ]]; then
      echo "ERROR: unsafe path detected in blobs.tar.gz: ${entry}" >&2
      exit 1
    fi
  done < <(tar -tzf "${BACKUP_DIR%/}/blobs.tar.gz")

  while IFS= read -r line; do
    mode_char="${line:0:1}"
    if [[ "$mode_char" != "-" && "$mode_char" != "d" ]]; then
      echo "ERROR: unsafe archive entry type (${mode_char}) in blobs.tar.gz (links and special files are forbidden): ${line}" >&2
      exit 1
    fi
  done < <(tar -tvzf "${BACKUP_DIR%/}/blobs.tar.gz")

  tar -C "$STAGING_DIR" -xzf "${BACKUP_DIR%/}/blobs.tar.gz"
  if [[ ! -d "${STAGING_DIR}/blobs" ]]; then
    echo "ERROR: blobs.tar.gz did not contain a top-level blobs/ directory" >&2
    exit 1
  fi

  # Post-extraction belt-and-suspenders check: forbid any symlink, special file, or hardlink
  if [[ -n "$(find "${STAGING_DIR}/blobs" \( -type l -o ! \( -type f -o -type d \) \))" ]]; then
    echo "ERROR: extracted blobs/ contains forbidden symlinks or special files" >&2
    exit 1
  fi
  if [[ -n "$(find "${STAGING_DIR}/blobs" -type f -links +1)" ]]; then
    echo "ERROR: extracted blobs/ contains forbidden hardlinks" >&2
    exit 1
  fi
  HAS_STAGED_BLOBS=1
fi

# 3. Restore PostgreSQL dump BEFORE swapping local files so a pg_restore failure leaves local state untouched
if [[ -f "${BACKUP_DIR%/}/postgres.dump" && -n "$DATABASE_URL_ARG" ]]; then
  if ! command -v pg_restore >/dev/null 2>&1; then
    echo "ERROR: pg_restore is required to restore postgres.dump" >&2
    exit 1
  fi
  echo "Restoring PostgreSQL dump..."
  pg_restore --clean --if-exists --no-owner --no-acl --dbname="$DATABASE_URL_ARG" "${BACKUP_DIR%/}/postgres.dump"
  echo "NOTE: If restoring into a staging/cloned cluster that shares a NATS server with production,"
  echo "      run 'DELETE FROM pl_cluster;' before starting Plenary nodes."
elif [[ -f "${BACKUP_DIR%/}/postgres.dump" ]]; then
  echo "INFO: postgres.dump is present in backup; pass --database-url to restore PostgreSQL."
fi

# 4. Swap all staged local artifacts into DATA_DIR with rollback preservation
ROLLBACK_DIR="$(mktemp -d "${DATA_DIR%/}/.plenary-restore-rollback.XXXXXX")"

for db_name in "${STAGED_DBS[@]}"; do
  target_db="${DATA_DIR%/}/${db_name}"
  echo "Restoring SQLite database ${db_name} -> ${target_db}..."
  if [[ -e "$target_db" ]]; then
    mv -f "$target_db" "${ROLLBACK_DIR}/${db_name}"
  fi
  rm -f "${target_db}-wal" "${target_db}-shm"
  SWAPPED_ITEMS+=("$db_name")
  mv -f "${STAGING_DIR}/${db_name}" "$target_db"
done

if [[ "$HAS_STAGED_BLOBS" -eq 1 ]]; then
  echo "Restoring blob store -> ${DATA_DIR%/}/blobs..."
  if [[ -d "${DATA_DIR%/}/blobs" ]]; then
    mv -f "${DATA_DIR%/}/blobs" "${ROLLBACK_DIR}/blobs"
  fi
  SWAPPED_ITEMS+=("blobs")
  mv -f "${STAGING_DIR}/blobs" "${DATA_DIR%/}/blobs"
fi

echo "Restore complete."
