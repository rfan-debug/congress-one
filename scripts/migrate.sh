#!/usr/bin/env bash
# Idempotent D1 migration runner.
#
# Why a script instead of a `.sql` file? SQLite's ALTER TABLE ADD COLUMN has
# no `IF NOT EXISTS` form, so running a plain .sql file twice fails with
# "duplicate column name" on the second run. This wrapper runs each column
# addition individually and treats that specific error as success.
#
# Usage:
#   scripts/migrate.sh --local    # local (wrangler dev) D1
#   scripts/migrate.sh --remote   # production D1
#
# New migrations: add a line to NEW_COLUMNS below with the column definition.
# The script will add it on first run and skip it on every subsequent run.
set -euo pipefail

TARGET="${1:-}"
if [[ "$TARGET" != "--local" && "$TARGET" != "--remote" ]]; then
  echo "usage: $0 --local|--remote" >&2
  exit 2
fi

# One entry per column. Format: "column_name COLUMN_DEFINITION"
NEW_COLUMNS=(
  "rights_impact TEXT"
  "tax_impact TEXT"
  "benefits_impact TEXT"
  "tags TEXT"
)

DB_NAME="congress_one"

for col_def in "${NEW_COLUMNS[@]}"; do
  col_name="${col_def%% *}"
  echo "--- migrate: ALTER TABLE bills ADD COLUMN $col_def"
  # Capture both streams so we can grep for the specific error SQLite emits
  # when the column already exists. We deliberately DON'T use `set -e` inside
  # the subshell — we want to inspect the output before deciding.
  output=$(npx wrangler d1 execute "$DB_NAME" "$TARGET" \
    --command "ALTER TABLE bills ADD COLUMN $col_def" 2>&1 || true)

  if echo "$output" | grep -q "duplicate column name"; then
    echo "    already present, skipping"
  elif echo "$output" | grep -q "no such table: bills"; then
    echo "    ERROR: the 'bills' table does not exist in this database."
    echo
    echo "    Run the schema first, then re-run this script:"
    if [[ "$TARGET" == "--local" ]]; then
      echo "      npm run db:init:local   # or: npm run db:migrate:local (does both)"
    else
      echo "      npm run db:init:remote  # or: npm run db:migrate:remote (does both)"
    fi
    exit 1
  elif echo "$output" | grep -qiE "error|✘"; then
    echo "    ERROR adding column '$col_name':"
    echo "$output"
    exit 1
  else
    echo "    added"
  fi
done

echo "migrate: done"
