// Thin D1 access layer.

import type { BillRow } from "./types";

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
                source_url, summary_en, summary_zh, summarized_at, model
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    const bindings: unknown[] = [];
    if (opts.q && opts.q.trim()) {
        sql += ` WHERE title LIKE ?`;
        bindings.push(`%${opts.q.trim()}%`);
    }
    sql += ` ORDER BY ${sortCol} ${order} LIMIT ? OFFSET ?`;
    bindings.push(limit, offset);

    const res = await db
        .prepare(sql)
        .bind(...bindings)
        .all<BillRow>();
    return res.results ?? [];
}

export async function getBill(db: D1Database, billId: string): Promise<BillRow | null> {
    return await db
        .prepare("SELECT * FROM bills WHERE bill_id = ?")
        .bind(billId)
        .first<BillRow>();
}

export async function countBills(db: D1Database): Promise<number> {
    const row = await db
        .prepare("SELECT COUNT(*) AS n FROM bills")
        .first<{ n: number }>();
    return row?.n ?? 0;
}
