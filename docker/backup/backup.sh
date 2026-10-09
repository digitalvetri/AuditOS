#!/bin/sh
# Nightly backup of the database and the uploaded files, taken together so
# rows and files match. Keeps BACKUP_KEEP_DAYS (default 14) days.
#
#   /backups/YYYY-MM-DD_HHMM/db.dump        pg_dump custom format (pg_restore)
#   /backups/YYYY-MM-DD_HHMM/uploads.tar.gz the uploads volume
#
# These sit on the HOST in docker/backups/ (or BACKUP_HOST_DIR). Copy that
# folder OFF this machine (rclone / rsync / cloud sync) — a backup on the
# same disk does not survive the disk. Keep PORTAL_ACCESS_ENC_KEY and the
# other keys from .env.docker in your password manager too: encrypted
# columns cannot be read back without them.
#
# Restore (stack stopped except postgres):
#   pg_restore --clean --if-exists -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" db.dump
#   tar -xzf uploads.tar.gz -C /app/uploads      # into the uploads volume
set -eu

once() {
  stamp=$(date -u +%Y-%m-%d_%H%M)
  dir="${BACKUP_DIR:-/backups}/$stamp"
  mkdir -p "$dir"
  PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h "${PGHOST:-postgres}" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "$dir/db.dump"
  if [ -d "${UPLOADS_DIR:-/uploads}" ]; then tar -czf "$dir/uploads.tar.gz" -C "${UPLOADS_DIR:-/uploads}" .; fi
  # A dump that pg_restore cannot list is not a backup.
  pg_restore --list "$dir/db.dump" > /dev/null
  echo "[backup] $stamp ok: $(du -sh "$dir" | cut -f1)"
  find "${BACKUP_DIR:-/backups}" -mindepth 1 -maxdepth 1 -type d -mtime +"${BACKUP_KEEP_DAYS:-14}" -exec rm -rf {} +
}

if [ "${1:-}" = "--once" ]; then once; exit 0; fi

# Daily at BACKUP_HOUR_UTC (default 21:00 UTC = 02:30 IST), plus one at start.
once || echo "[backup] first run failed — will retry at the scheduled hour" >&2
while true; do
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%Y-%m-%d) ${BACKUP_HOUR_UTC:-21}:00" +%s 2>/dev/null || echo $((now + 86400)))
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  once || echo "[backup] run failed" >&2
done
