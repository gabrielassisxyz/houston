#!/usr/bin/env bash
# Back up the notes database into a synced folder, keeping the seven newest copies.
#
# Usage:
#   scripts/notes-backup.sh <db> <dir>
#
# Makes <dir>/houston-backup when missing, copies <db> with `VACUUM INTO` under
# a temporary name, renames it to notes-YYYY-MM-DD.db, and keeps the seven most
# recent copies. The live database and its write-ahead log are not safe to sync;
# the VACUUM INTO copy is one closed file in `delete` journal mode.
set -euo pipefail

die() {
  printf 'notes-backup: %s\n' "$1" >&2
  exit 1
}

if [ "$#" -ne 2 ]; then
  printf 'notes-backup: usage: notes-backup.sh <db> <dir>\n' >&2
  exit 1
fi

DB=$1
DIR=$2

[ -n "$DB" ] || die "database path is empty"
[ -n "$DIR" ] || die "backup directory path is empty"

# A missing database exits non-zero before touching anything on disk.
if [ ! -f "$DB" ]; then
  die "database not found: $DB"
fi

command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 not found on PATH"
command -v date >/dev/null 2>&1 || die "date not found on PATH"

TODAY=$(date +%F)
[ -n "$TODAY" ] || die "date +%F produced no output"

BACKUP_DIR="$DIR/houston-backup"
mkdir -p "$BACKUP_DIR" || die "could not create backup folder: $BACKUP_DIR"

PARTIAL="$BACKUP_DIR/.notes-$TODAY.db.partial"
FINAL="$BACKUP_DIR/notes-$TODAY.db"

# Remove the temporary file a failed run left behind.
rm -f "$PARTIAL"

# A synced folder's name can hold a single quote; double each one inside the
# SQL string literal.
escaped_partial=${PARTIAL//\'/\'\'}

if ! sqlite3 "$DB" "VACUUM INTO '$escaped_partial'"; then
  printf 'notes-backup: sqlite3 VACUUM INTO failed for %s\n' "$DB" >&2
  exit 1
fi

if [ ! -f "$PARTIAL" ]; then
  die "backup copy was not created: $PARTIAL"
fi

mv -f "$PARTIAL" "$FINAL" || die "could not rename $PARTIAL to $FINAL"

# Keep the seven most recent notes-YYYY-MM-DD.db by name (ISO dates sort in
# time order) and delete the older ones, touching no other file.
shopt -s nullglob
copies=( "$BACKUP_DIR"/notes-*.db )
shopt -u nullglob

if [ "${#copies[@]}" -gt 7 ]; then
  sorted_list=$(printf '%s\n' "${copies[@]}" | LC_ALL=C sort)
  count=${#copies[@]}
  to_delete=$((count - 7))
  deleted=0
  while IFS= read -r old; do
    if [ "$deleted" -ge "$to_delete" ]; then
      break
    fi
    rm -f "$old"
    deleted=$((deleted + 1))
  done <<< "$sorted_list"
fi
