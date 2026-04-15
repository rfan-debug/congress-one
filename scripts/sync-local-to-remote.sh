#!/usr/bin/env bash
# Sync cached bills from local D1 up to the remote (production) D1.
#
# Why? `/admin/ingest` is slow in production because every new bill costs
# ~5 subrequests (and the Workers free plan caps at 50 per invocation).
# Locally you can burn as many Gemini calls as you want, fill the cache in
# one shot, and then upload the resulting rows to production in a single
# REST-API batch. That path has nothing to do with Worker subrequests, so
# it finishes in seconds regardless of how many bills are in your cache.
#
# Pipeline:
#   1. Migrate the remote DB so its schema matches local (idempotent).
#   2. `wrangler d1 export --local` the bills table to a SQL dump.
#   3. Rewrite every `INSERT INTO` to `INSERT OR REPLACE INTO` so re-runs
#      upsert instead of erroring on bill_id conflicts, and remote-only
#      rows (if any) are preserved.
#   4. `wrangler d1 execute --remote --file=…` to apply the dump.
#
# Usage:
#   scripts/sync-local-to-remote.sh              # full sync
#   scripts/sync-local-to-remote.sh --dry-run    # dump + rewrite, no apply
#   scripts/sync-local-to-remote.sh --skip-migrate  # assume remote schema is current
#
# Prereqs:
#   - You have a local D1 populated via `npm run dev` + /admin/ingest.
#   - `wrangler` is authenticated (`npx wrangler login`) so it can hit the
#     remote D1 REST API.
set -euo pipefail

DB_NAME="congress_one"
DUMP_FILE="${TMPDIR:-/tmp}/congress-one-sync.sql"
DRY_RUN=0
SKIP_MIGRATE=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=1 ;;
    --skip-migrate) SKIP_MIGRATE=1 ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' | sed '$d'
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      echo "usage: $0 [--dry-run] [--skip-migrate]" >&2
      exit 2
      ;;
  esac
done

# --- 1/4 Remote schema migration -------------------------------------------
if [[ "$SKIP_MIGRATE" -eq 0 ]]; then
  echo "--- 1/4 Migrating remote D1 schema (idempotent)"
  npx wrangler d1 execute "$DB_NAME" --remote --file=./schema.sql
  ./scripts/migrate.sh --remote
else
  echo "--- 1/4 Skipping remote schema migration (--skip-migrate)"
fi

# --- 2/4 Dump local data ---------------------------------------------------
echo "--- 2/4 Dumping local D1 '$DB_NAME' (data only) -> $DUMP_FILE"
# --no-schema keeps CREATE TABLE statements out of the dump; the remote
# table already exists (step 1) and we don't want to clobber it.
npx wrangler d1 export "$DB_NAME" --local --no-schema --output="$DUMP_FILE"

if [[ ! -s "$DUMP_FILE" ]]; then
  echo "ERROR: dump is empty. Does your local D1 have any rows?" >&2
  echo "       Run 'npm run dev' and hit /admin/ingest first." >&2
  exit 1
fi

# --- 3/4 Rewrite INSERTs for idempotent upsert -----------------------------
echo "--- 3/4 Rewriting INSERTs to INSERT OR REPLACE"
# Match INSERT INTO at start-of-statement (allowing leading whitespace and
# an optional BEGIN TRANSACTION prefix that some export tools emit). We use
# sed -i.bak for portability between GNU (Linux) and BSD (macOS) sed.
sed -i.bak -E 's/\bINSERT INTO\b/INSERT OR REPLACE INTO/g' "$DUMP_FILE"
rm -f "$DUMP_FILE.bak"

row_count=$(grep -c '^INSERT OR REPLACE INTO' "$DUMP_FILE" || true)
echo "    $row_count INSERT statements ready to apply"

if [[ "$row_count" -eq 0 ]]; then
  echo "ERROR: no INSERT statements found after rewrite. Check $DUMP_FILE" >&2
  exit 1
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "--- 4/4 Dry run — not applying. Dump kept at $DUMP_FILE"
  exit 0
fi

# --- 4/4 Apply to remote ---------------------------------------------------
echo "--- 4/4 Applying to remote D1 '$DB_NAME'"
npx wrangler d1 execute "$DB_NAME" --remote --file="$DUMP_FILE"

echo
echo "sync: done. Uploaded $row_count rows to remote."
echo "(dump kept at $DUMP_FILE for inspection; safe to delete)"
