# The nightly backup job as an image, so platforms that keep only the compose
# file (Coolify) still get the script — a bind mount of ./backup/backup.sh
# arrives there as an empty directory.
FROM postgres:16-alpine
COPY backup.sh /backup.sh
CMD ["sh", "/backup.sh"]
