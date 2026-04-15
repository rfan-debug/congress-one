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
#   2. Find wrangler's local D1 SQLite file and dump the `bills` table
#      directly with the `sqlite3` CLI (`.mode insert`). We deliberately
#      avoid `wrangler d1 export --local` — that path has been flaky
#      across wrangler versions and has silently produced empty dumps.
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
#   - The `sqlite3` CLI is installed:
#       macOS:  brew install sqlite    (or use the system one at /usr/bin/sqlite3)
#       Ubuntu: sudo apt-get install sqlite3
set -euo pipefail

DB_NAME="congress_one"
# Hardcode /tmp so the path is predictable across macOS (where $TMPDIR is
# something like /var/folders/…/T/) and Linux.
DUMP_FILE="/tmp/congress-one-sync.sql"
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

# --- Preflight: sqlite3 CLI must be installed -------------------------------
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: 'sqlite3' CLI not found on PATH." >&2
  echo "       Install it first:" >&2
  echo "         macOS:  brew install sqlite   (or use /usr/bin/sqlite3)" >&2
  echo "         Ubuntu: sudo apt-get install sqlite3" >&2
  exit 1
fi

# --- 1/4 Remote schema migration -------------------------------------------
if [[ "$SKIP_MIGRATE" -eq 0 ]]; then
  echo "--- 1/4 Migrating remote D1 schema (idempotent)"
  npx wrangler d1 execute "$DB_NAME" --remote --file=./schema.sql
  ./scripts/migrate.sh --remote
else
  echo "--- 1/4 Skipping remote schema migration (--skip-migrate)"
fi

# --- 2/4 Find the local SQLite file and dump the `bills` table --------------
echo "--- 2/4 Locating wrangler local D1 SQLite file"
# Wrangler 3/4 stores local D1s under:
#   .wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite
# There can be multiple files (one per bound DB, or stale files from old
# runs). We pick the one that actually has a `bills` table with rows.
STATE_DIR=".wrangler/state/v3/d1"
if [[ ! -d "$STATE_DIR" ]]; then
  echo "ERROR: $STATE_DIR does not exist." >&2
  echo "       Have you run 'npm run dev' at least once?" >&2
  exit 1
fi

LOCAL_SQLITE=""
BEST_COUNT=0
while IFS= read -r -d '' candidate; do
  # Check if this file has a `bills` table at all. If sqlite3 errors
  # (e.g. the file is empty / locked), just skip it.
  count=$(sqlite3 "$candidate" \
    "SELECT COUNT(*) FROM bills;" 2>/dev/null || echo "")
  if [[ -z "$count" ]]; then
    continue
  fi
  echo "    candidate: $candidate (rows=$count)"
  if (( count > BEST_COUNT )); then
    BEST_COUNT=$count
    LOCAL_SQLITE=$candidate
  fi
done < <(find "$STATE_DIR" -type f -name '*.sqlite' -print0)

if [[ -z "$LOCAL_SQLITE" ]]; then
  echo "ERROR: no local D1 sqlite file contained a readable 'bills' table." >&2
  echo "       Expected to find one under $STATE_DIR." >&2
  echo "       Try: npm run dev (stop it once it boots), then re-run." >&2
  exit 1
fi

if (( BEST_COUNT == 0 )); then
  echo "ERROR: found $LOCAL_SQLITE but it has 0 rows in 'bills'." >&2
  echo "       Populate your local cache first:" >&2
  echo "         npm run dev   # in another terminal" >&2
  echo "         curl -X POST http://localhost:8787/admin/ingest \\" >&2
  echo "           -H \"Authorization: Bearer \$ADMIN_TOKEN\"" >&2
  exit 1
fi

echo "    using: $LOCAL_SQLITE ($BEST_COUNT rows)"
echo "--- 2/4 Dumping 'bills' -> $DUMP_FILE"
# .mode insert emits `INSERT INTO "bills" VALUES(...);` for every row.
# Wrapping in BEGIN/COMMIT keeps the remote apply as a single transaction.
{
  echo "BEGIN TRANSACTION;"
  sqlite3 "$LOCAL_SQLITE" <<SQL
.mode insert bills
SELECT * FROM bills;
SQL
  echo "COMMIT;"
} > "$DUMP_FILE"

if [[ ! -s "$DUMP_FILE" ]]; then
  echo "ERROR: dump is empty. This should not happen — $LOCAL_SQLITE had" >&2
  echo "       $BEST_COUNT rows a moment ago. Check $DUMP_FILE manually." >&2
  exit 1
fi

# --- 3/4 Rewrite INSERTs for idempotent upsert -----------------------------
echo "--- 3/4 Rewriting INSERTs to INSERT OR REPLACE"
# Plain literal substitution — no word boundary anchors, since BSD sed (macOS)
# doesn't support `\b` in ERE. The `.mode insert` output always starts each
# row with exactly `INSERT INTO "bills"`, so a literal swap is safe.
sed -i.bak 's/INSERT INTO /INSERT OR REPLACE INTO /g' "$DUMP_FILE"
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
