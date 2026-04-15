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

# --- Preflight: python3 must be installed ---------------------------------
# We use python3's built-in sqlite3 module (not the `sqlite3` CLI) because
# the CLI's `.mode insert` emits `unistr('\xNNNN')` escape sequences for
# non-ASCII characters starting in SQLite 3.45, and D1's SQLite build
# doesn't ship the `unistr()` function. Python's sqlite3 driver lets us
# emit plain single-quoted string literals that work everywhere.
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: 'python3' not found on PATH." >&2
  echo "       Install it first:" >&2
  echo "         macOS:  comes preinstalled; otherwise 'brew install python'" >&2
  echo "         Ubuntu: sudo apt-get install python3" >&2
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
# We do discovery + dump in one Python pass (using the stdlib sqlite3
# module) so we emit plain single-quoted string literals for every column
# — no `unistr('\xNNNN')` escapes, which D1's SQLite build can't execute.
STATE_DIR=".wrangler/state/v3/d1"
if [[ ! -d "$STATE_DIR" ]]; then
  echo "ERROR: $STATE_DIR does not exist." >&2
  echo "       Have you run 'npm run dev' at least once?" >&2
  exit 1
fi

echo "--- 2/4 Locating local D1 SQLite file and dumping 'bills'"
STATE_DIR="$STATE_DIR" DUMP_FILE="$DUMP_FILE" DB_TABLE="bills" \
python3 - <<'PY'
import os
import pathlib
import sqlite3
import sys

state_dir = pathlib.Path(os.environ["STATE_DIR"])
dump_file = pathlib.Path(os.environ["DUMP_FILE"])
table = os.environ["DB_TABLE"]


def sqlite_lit(v):
    """Render a Python value as a SQLite literal.

    Uses only `NULL`, bare numbers, `x'...'` blobs, and single-quoted
    strings with doubled quotes. No `unistr()`, no `char()` — so the
    output works on any SQLite build, including D1's.
    """
    if v is None:
        return "NULL"
    if isinstance(v, bool):  # must precede int-check: bool is a subclass of int
        return "1" if v else "0"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        # repr() preserves full precision; SQLite accepts scientific notation.
        return repr(v)
    if isinstance(v, (bytes, bytearray)):
        return "x'" + bytes(v).hex() + "'"
    # Text. SQLite allows literal newlines and other control chars inside
    # '...' strings; only NUL is disallowed, so strip it defensively.
    s = str(v).replace("\x00", "")
    return "'" + s.replace("'", "''") + "'"


# Find candidate .sqlite files and pick the one with the most rows.
best_path = None
best_count = 0
for candidate in state_dir.rglob("*.sqlite"):
    if not candidate.is_file():
        continue
    try:
        with sqlite3.connect(f"file:{candidate}?mode=ro", uri=True) as conn:
            cur = conn.execute(f"SELECT COUNT(*) FROM {table}")
            (count,) = cur.fetchone()
    except sqlite3.Error:
        continue
    print(f"    candidate: {candidate} (rows={count})")
    if count > best_count:
        best_count = count
        best_path = candidate

if best_path is None:
    print(
        f"ERROR: no local D1 sqlite file contained a readable '{table}' table.\n"
        f"       Expected to find one under {state_dir}.\n"
        f"       Try: npm run dev (stop it once it boots), then re-run.",
        file=sys.stderr,
    )
    sys.exit(1)

if best_count == 0:
    print(
        f"ERROR: found {best_path} but it has 0 rows in '{table}'.\n"
        f"       Populate your local cache first:\n"
        f"         npm run dev   # in another terminal\n"
        f"         curl -X POST http://localhost:8787/admin/ingest \\\n"
        f"           -H \"Authorization: Bearer $ADMIN_TOKEN\"",
        file=sys.stderr,
    )
    sys.exit(1)

print(f"    using: {best_path} ({best_count} rows)")
print(f"    dumping -> {dump_file}")

with sqlite3.connect(f"file:{best_path}?mode=ro", uri=True) as conn:
    # Use TEXT for blobs-that-are-really-utf8 etc. Default works here because
    # every column in `bills` is declared TEXT/INTEGER in schema.sql.
    cur = conn.execute(f'SELECT * FROM "{table}"')
    cols = [d[0] for d in cur.description]
    col_list = ",".join(f'"{c}"' for c in cols)
    written = 0
    with dump_file.open("w", encoding="utf-8") as f:
        for row in cur:
            vals = ",".join(sqlite_lit(v) for v in row)
            f.write(
                f'INSERT OR REPLACE INTO "{table}" ({col_list}) VALUES ({vals});\n'
            )
            written += 1

print(f"    wrote {written} INSERT OR REPLACE statements")
PY

if [[ ! -s "$DUMP_FILE" ]]; then
  echo "ERROR: dump is empty — check $DUMP_FILE manually." >&2
  exit 1
fi

# --- 3/4 Sanity-check the dump ---------------------------------------------
echo "--- 3/4 Verifying dump"
row_count=$(grep -c '^INSERT OR REPLACE INTO' "$DUMP_FILE" || true)
echo "    $row_count INSERT statements ready to apply"

if [[ "$row_count" -eq 0 ]]; then
  echo "ERROR: no INSERT statements found in $DUMP_FILE" >&2
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
