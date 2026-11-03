#!/bin/sh
# Nightly backup: database dump + OTA firmware files, kept 14 days.
# Cron (root):  20 3 * * * /opt/argus/deploy/backup.sh >> /var/log/argus-backup.log 2>&1
# Restore:      docker compose -f docker-compose.prod.yml exec -T postgres \
#                 pg_restore --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB" < FILE.dump
set -e
APP_DIR=/opt/argus
OUT=/var/backups/argus
STAMP=$(date +%Y%m%d-%H%M)
cd "$APP_DIR"
. ./.env
mkdir -p "$OUT"

docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB" > "$OUT/db-$STAMP.dump"
docker compose -f docker-compose.prod.yml exec -T backend \
  tar -czf - -C /srv ota > "$OUT/ota-$STAMP.tar.gz"

find "$OUT" -type f -mtime +14 -delete
echo "backup ok $STAMP"
