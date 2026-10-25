#!/usr/bin/env bash
# Restore an encrypted MubaPay backup into a TARGET database.
# NEVER point RESTORE_URI at production unless executing an approved recovery.
#
# Usage: RESTORE_URI=mongodb://... BACKUP_ENCRYPTION_PASSPHRASE_FILE=... scripts/restore.sh <backup.archive.gz.enc>
set -euo pipefail
FILE="${1:?backup file required}"
: "${RESTORE_URI:?RESTORE_URI is required}"
: "${BACKUP_ENCRYPTION_PASSPHRASE_FILE:?BACKUP_ENCRYPTION_PASSPHRASE_FILE is required}"
if [ -f "$FILE.sha256" ]; then (cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256"); fi
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_ENCRYPTION_PASSPHRASE_FILE" -in "$FILE" \
  | mongorestore --uri="$RESTORE_URI" --archive --gzip --oplogReplay --drop
echo "Restore complete into $(printf %s "$RESTORE_URI" | sed -E "s#//[^@/]*@#//***@#"). Now run: node scripts/verify-restore.js"
