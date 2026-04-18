// Thin D1 access layer.
//
// D1 rows come back as plain objects whose TEXT columns are strings. The
// `tags` column is stored as a JSON-encoded array, so this module is the
// single place that serializes on write and parses on read — callers work
// with `BillRow` (tags: string[]) everywhere else.

import type { BillRow, ImpactDirection } from "./types";

/**
 * Raw shape of a bill row as D1 returns it: TEXT columns are strings, and
 * the tags array is still a JSON-encoded string. We translate this to
 * {@link BillRow} in `toBillRow` below.
 */
interface RawBillRow {
    bill_id: string;
    congress: number;
    bill_type: string;
    bill_number: number;
    title: string;
    sponsor: string | null;
    introduced_date: string;
    latest_action_date: string | null;
    latest_action_text: string | null;
    source_url: string;
    summary_en: string;
    summary_zh: string;
    rights_impact: string | null;
    tax_impact: string | null;
    benefits_impact: string | null;
    tags: string | null;
    summarized_at: string;
    model: string;
}

export async function hasBill(db: D1Database, billId: string): Promise<boolean> {
    const row = await db
        .prepare("SELECT 1 FROM bills WHERE bill_id = ? LIMIT 1")
        .bind(billId)
        .first();
    return row !== null;
}

export async function insertBill(db: D1Database, row: BillRow): Promise<void> {
    await db
        .prepare(
            `INSERT OR REPLACE INTO bills (
                bill_id, congress, bill_type, bill_number, title, sponsor,
                introduced_date, latest_action_date, latest_action_text,
                source_url, summary_en, summary_zh,
                rights_impact, tax_impact, benefits_impact, tags,
                summarized_at, model
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
            row.bill_id,
            row.congress,
            row.bill_type,
            row.bill_number,
            row.title,
            row.sponsor,
            row.introduced_date,
            row.latest_action_date,
            row.latest_action_text,
            row.source_url,
            row.summary_en,
            row.summary_zh,
            row.rights_impact,
            row.tax_impact,
            row.benefits_impact,
            JSON.stringify(row.tags ?? []),
            row.summarized_at,
            row.model,
        )
        .run();
}

export interface ListBillsOptions {
    /** "introduced_date" (default) or "latest_action_date". */
    sortBy?: "introduced_date" | "latest_action_date";
    /** "desc" (default) or "asc". */
    order?: "desc" | "asc";
    limit?: number;
    offset?: number;
    /** Free-text search over title. */
    q?: string;
    /**
     * Restrict to bills whose `tags` JSON array contains this value
     * (case-insensitive exact match against one of the stored tags).
     */
    tag?: string;
}

export async function listBills(
    db: D1Database,
    opts: ListBillsOptions = {},
): Promise<BillRow[]> {
    // Whitelist sort columns — never interpolate user input into SQL.
    const sortCol = opts.sortBy === "latest_action_date" ? "latest_action_date" : "introduced_date";
    const order = opts.order === "asc" ? "ASC" : "DESC";
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);

    let sql = `SELECT * FROM bills`;
    const conds: string[] = [];
    const bindings: unknown[] = [];

    if (opts.q && opts.q.trim()) {
        conds.push(`title LIKE ?`);
        bindings.push(`%${opts.q.trim()}%`);
    }

    if (opts.tag && opts.tag.trim()) {
        // `json_each` expands the JSON array stored in the `tags` column into
        // virtual rows; EXISTS lets us check "does this bill contain that
        // tag?" without fetching every bill into memory. D1 ships SQLite with
        // the json1 extension enabled, so this works out of the box.
        conds.push(
            `EXISTS (SELECT 1 FROM json_each(bills.tags) WHERE LOWER(value) = LOWER(?))`,
        );
        bindings.push(opts.tag.trim());
    }

    if (conds.length) {
        sql += ` WHERE ` + conds.join(" AND ");
    }
    sql += ` ORDER BY ${sortCol} ${order} LIMIT ? OFFSET ?`;
    bindings.push(limit, offset);

    const res = await db
        .prepare(sql)
        .bind(...bindings)
        .all<RawBillRow>();
    return (res.results ?? []).map(toBillRow);
}

/**
 * Return bills that have any of the given tags (OR semantics across the
 * input list). Empty input short-circuits to an empty list without
 * hitting D1.
 *
 * Unlike `listBills({tag})` which filters by a single exact tag, this is
 * used by the /find route where Gemini returns 3–8 relevant tags and we
 * want the union.
 */
export async function listBillsByAnyTag(
    db: D1Database,
    tags: string[],
    opts: { limit?: number } = {},
): Promise<BillRow[]> {
    if (tags.length === 0) return [];
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    // Build a `LOWER(value) IN (?,?,…)` list. D1's prepare()/bind() only
    // takes scalars, so we expand the placeholders ourselves.
    const placeholders = tags.map(() => "?").join(",");
    const sql = `
        SELECT * FROM bills
         WHERE EXISTS (
           SELECT 1 FROM json_each(bills.tags)
            WHERE LOWER(value) IN (${placeholders})
         )
         ORDER BY introduced_date DESC
         LIMIT ?`;
    const bindings: unknown[] = [
        ...tags.map((t) => t.trim().toLowerCase()),
        limit,
    ];
    const res = await db.prepare(sql).bind(...bindings).all<RawBillRow>();
    return (res.results ?? []).map(toBillRow);
}

export async function getBill(db: D1Database, billId: string): Promise<BillRow | null> {
    const raw = await db
        .prepare("SELECT * FROM bills WHERE bill_id = ?")
        .bind(billId)
        .first<RawBillRow>();
    return raw ? toBillRow(raw) : null;
}

export async function countBills(db: D1Database): Promise<number> {
    const row = await db
        .prepare("SELECT COUNT(*) AS n FROM bills")
        .first<{ n: number }>();
    return row?.n ?? 0;
}

/**
 * Return every distinct tag currently stored across all cached bills,
 * sorted alphabetically. Used to render the filter chips on the index page.
 * Relies on the json1 extension (available in D1 / Cloudflare's SQLite).
 */
export async function listAllTags(db: D1Database): Promise<string[]> {
    const res = await db
        .prepare(
            `SELECT DISTINCT LOWER(value) AS tag
               FROM bills, json_each(bills.tags)
              WHERE bills.tags IS NOT NULL
              ORDER BY tag ASC`,
        )
        .all<{ tag: string }>();
    return (res.results ?? []).map((r) => r.tag).filter(Boolean);
}

function toBillRow(raw: RawBillRow): BillRow {
    return {
        bill_id: raw.bill_id,
        congress: raw.congress,
        bill_type: raw.bill_type,
        bill_number: raw.bill_number,
        title: raw.title,
        sponsor: raw.sponsor,
        introduced_date: raw.introduced_date,
        latest_action_date: raw.latest_action_date,
        latest_action_text: raw.latest_action_text,
        source_url: raw.source_url,
        summary_en: raw.summary_en,
        summary_zh: raw.summary_zh,
        rights_impact: normalizeImpact(raw.rights_impact),
        tax_impact: normalizeImpact(raw.tax_impact),
        benefits_impact: normalizeImpact(raw.benefits_impact),
        tags: parseTagsJson(raw.tags),
        summarized_at: raw.summarized_at,
        model: raw.model,
    };
}

function normalizeImpact(value: string | null): ImpactDirection | null {
    if (value == null) return null;
    if (value === "increase" || value === "decrease" || value === "none") return value;
    return null;
}

function parseTagsJson(value: string | null): string[] {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
            return parsed
                .filter((t): t is string => typeof t === "string")
                .map((t) => t.trim().toLowerCase())
                .filter((t) => t.length > 0);
        }
    } catch {
        // Fall through — legacy rows or corrupt data; treat as no tags.
    }
    return [];
}
