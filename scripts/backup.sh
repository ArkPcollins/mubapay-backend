#!/usr/bin/env bash
# MubaPay MongoDB backup — consistent point-in-time dump of a replica set,
# compressed and encrypted (AES-256 via openssl) before it leaves the host.
#
# Required env:  MONGODB_URI, BACKUP_DIR, BACKUP_ENCRYPTION_PASSPHRASE_FILE
# Optional env:  BACKUP_RETENTION_DAYS (default 30)
#
# Restrict access: BACKUP_DIR and the passphrase file must be readable only by
# the backup operator account. Copy encrypted archives to off-site storage.
set -euo pipefail
: "${MONGODB_URI:?MONGODB_URI is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"
: "${BACKUP_ENCRYPTION_PASSPHRASE_FILE:?BACKUP_ENCRYPTION_PASSPHRASE_FILE is required}"
RETENTION="${BACKUP_RETENTION_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/mubapay-$STAMP.archive.gz.enc"

# --oplog captures writes during the dump for a consistent snapshot (replica set required)
mongodump --uri="$MONGODB_URI" --oplog --archive --gzip \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_ENCRYPTION_PASSPHRASE_FILE" -out "$OUT"

(cd "$BACKUP_DIR" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")
echo "Backup written: $OUT"

# retention
find "$BACKUP_DIR" -name 'mubapay-*.archive.gz.enc*' -mtime +"$RETENTION" -print -delete
