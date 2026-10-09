#!/bin/sh
# Nightly backup of the database and the uploaded files, taken together so
# rows and files match. Keeps BACKUP_KEEP_DAYS (default 14) days.
#
#   /backups/YYYY-MM-DD_HHMM/db.dump        pg_dump custom format (pg_restore)
#   /backups/YYYY-MM-DD_HHMM/uploads.tar.gz the uploads volume
#   (…/db.dump.enc, uploads.tar.gz.enc when BACKUP_PASSPHRASE is set)
#
# Optional, each off until its variable is set:
#   BACKUP_PASSPHRASE     encrypt both files (AES-256, PBKDF2) and keep no
#                         plaintext copy. Keep the passphrase in your password
#                         manager: without it the backups cannot be read.
#   BACKUP_RCLONE_REMOTE  copy each backup off this server, e.g.
#                         "offsite:auditos-backups" with the remote defined by
#                         RCLONE_CONFIG_OFFSITE_* variables (rclone docs).
#   BACKUP_PING_URL       healthchecks.io-style URL: pinged on success,
#                         "<url>/fail" on failure, so a silent failure alerts.
#   BACKUP_RESTORE_TEST_DAY  day of month (default 1) on which the night's
#                         dump is restored into a scratch database and
#                         checked, then dropped. 0 turns it off.
#
# A backup on the same disk does not survive the disk — set
# BACKUP_RCLONE_REMOTE. Keep PORTAL_ACCESS_ENC_KEY and the other keys in your
# password manager too: encrypted columns cannot be read back without them.
#
# Restore (stack stopped except the database):
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in db.dump.enc -out db.dump   # if encrypted
#   pg_restore --clean --if-exists -h <db host> -U "$POSTGRES_USER" -d "$POSTGRES_DB" db.dump
#   tar -xzf uploads.tar.gz -C /app/uploads      # into the uploads volume
#
#   sh backup.sh --once           one backup now
#   sh backup.sh --restore-test   restore the newest backup into a scratch DB
set -u

ROOT="${BACKUP_DIR:-/backups}"
DB_HOST="${PGHOST:-postgres}"
export PGPASSWORD="$POSTGRES_PASSWORD"

ping() { # ping [suffix]
  [ -n "${BACKUP_PING_URL:-}" ] || return 0
  wget -q -T 10 -O /dev/null "${BACKUP_PING_URL}${1:-}" 2>/dev/null || true
}

encrypt() { # encrypt <file> — replaces <file> with <file>.enc
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -in "$1" -out "$1.enc"
  rm -f "$1"
}

# The steps run as their own `sh` process with -e, so any failed step ends the
# run as a failure. (Inside a function or subshell called from `if` or `||`,
# the shell switches -e off and a failed dump would still report "ok".)
SELF="$0"
once() { sh "$SELF" __once; }
restore_test() { sh "$SELF" __restore_test; }

do_once() {
  stamp=$(date -u +%Y-%m-%d_%H%M)
  dir="$ROOT/$stamp"
  mkdir -p "$dir"
  trap 'rm -rf "$dir"' EXIT
  pg_dump -h "$DB_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "$dir/db.dump"
  # A dump that pg_restore cannot list is not a backup.
  pg_restore --list "$dir/db.dump" > /dev/null
  if [ -d "${UPLOADS_DIR:-/uploads}" ]; then tar -czf "$dir/uploads.tar.gz" -C "${UPLOADS_DIR:-/uploads}" .; fi
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    encrypt "$dir/db.dump"
    [ -f "$dir/uploads.tar.gz" ] && encrypt "$dir/uploads.tar.gz"
  fi
  if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
    rclone copy "$dir" "$BACKUP_RCLONE_REMOTE/$stamp" --quiet
  fi
  trap - EXIT
  echo "[backup] $stamp ok: $(du -sh "$dir" | cut -f1)${BACKUP_RCLONE_REMOTE:+, copied off-site}"
  # Prune only after this run succeeded, so failures never eat good backups.
  find "$ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime +"${BACKUP_KEEP_DAYS:-14}" -exec rm -rf {} +
}

# Restores the newest backup into a throwaway database and checks it has
# tables and users, then drops it. Proves the backups can actually be read.
do_restore_test() {
  latest=$(ls -1d "$ROOT"/20* 2>/dev/null | sort | tail -1)
  [ -n "$latest" ] || { echo "[backup] restore test: no backup found" >&2; exit 1; }
  work=$(mktemp -d)
  trap 'rm -rf "$work"; dropdb -h "$DB_HOST" -U "$POSTGRES_USER" --if-exists auditos_restore_test 2>/dev/null || true' EXIT
  if [ -f "$latest/db.dump.enc" ]; then
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$latest/db.dump.enc" -out "$work/db.dump"
  else
    cp "$latest/db.dump" "$work/db.dump"
  fi
  dropdb -h "$DB_HOST" -U "$POSTGRES_USER" --if-exists auditos_restore_test
  createdb -h "$DB_HOST" -U "$POSTGRES_USER" auditos_restore_test
  pg_restore --no-owner --no-privileges -h "$DB_HOST" -U "$POSTGRES_USER" -d auditos_restore_test "$work/db.dump"
  tables=$(psql -h "$DB_HOST" -U "$POSTGRES_USER" -d auditos_restore_test -tAc "select count(*) from information_schema.tables where table_schema='public'")
  users=$(psql -h "$DB_HOST" -U "$POSTGRES_USER" -d auditos_restore_test -tAc 'select count(*) from "User"')
  [ "$tables" -gt 0 ] && [ "$users" -gt 0 ]
  echo "[backup] restore test ok: $(basename "$latest") → $tables tables, $users users"
}

run() {
  if once; then
    ping
    day=$(date -u +%d | sed 's/^0//')
    if [ "${BACKUP_RESTORE_TEST_DAY:-1}" = "$day" ]; then
      restore_test || { echo "[backup] restore test FAILED" >&2; ping /fail; }
    fi
  else
    echo "[backup] run FAILED — previous backups kept" >&2
    ping /fail
    return 1
  fi
}

case "${1:-}" in
  __once) set -e; do_once; exit 0 ;;
  __restore_test) set -e; do_restore_test; exit 0 ;;
  --once) run; exit $? ;;
  --restore-test) restore_test; exit $? ;;
esac

# Daily at BACKUP_HOUR_UTC (default 21:00 UTC = 02:30 IST), plus one at start.
run || true
while true; do
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%Y-%m-%d) ${BACKUP_HOUR_UTC:-21}:00" +%s 2>/dev/null || echo $((now + 86400)))
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  run || true
done
