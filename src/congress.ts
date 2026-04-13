// Thin client for api.congress.gov (the Library of Congress API).
// Docs: https://api.congress.gov/  •  https://www.loc.gov/apis/json-and-yaml/

import type {
    CongressBillDetail,
    CongressBillSummary,
    CongressListBill,
} from "./types";

const API_ROOT = "https://api.congress.gov/v3";

/** Bill types we fetch. HR/S are by far the most common; the rest are joint/simple resolutions. */
const BILL_TYPES = ["hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"] as const;

async function getJson<T>(url: string, apiKey: string): Promise<T> {
    const u = new URL(url);
    u.searchParams.set("api_key", apiKey);
    u.searchParams.set("format", "json");
    const res = await fetch(u.toString(), {
        headers: { "User-Agent": "congress-one/0.1 (+https://github.com/rfan-debug/congress-one)" },
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Congress API ${res.status} for ${u.pathname}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
}

/**
 * List recent bills across all chambers, filtered to those introduced on/after
 * `minDate`. Results are sorted newest-first by the API.
 *
 * The list endpoint uses `fromDateTime`/`toDateTime` on *updateDate*, not
 * introducedDate, so we over-fetch a little and filter client-side.
 *
 * Per-type failures are collected into `listErrors` rather than thrown, so one
 * flaky chamber doesn't poison the whole run — but the caller can (and should)
 * surface them so a totally-broken key doesn't silently look like "no bills".
 */
export async function listRecentBills(
    apiKey: string,
    limit: number,
): Promise<{ bills: CongressListBill[]; listErrors: Array<{ type: string; error: string }> }> {
    // Round-robin the bill types so we don't bias toward HR.
    const perType = Math.max(5, Math.ceil(limit / BILL_TYPES.length));

    const results: CongressListBill[] = [];
    const listErrors: Array<{ type: string; error: string }> = [];
    for (const type of BILL_TYPES) {
        // The list endpoint does NOT include `introducedDate` per bill — that
        // field only exists on the detail response. Every bill in the 119th
        // Congress was introduced on/after 2025-01-03 by definition, so we
        // accept everything this endpoint gives us and let the detail-stage
        // filter in runIngest enforce MIN_BILL_DATE.
        //
        // We also intentionally don't send fromDateTime: the api.congress.gov
        // spec requires it to be paired with toDateTime, and some endpoints
        // silently return empty arrays when only one is set.
        const url = `${API_ROOT}/bill/119/${type}?limit=${perType}&sort=updateDate+desc`;
        try {
            const page = await getJson<{ bills?: CongressListBill[] }>(url, apiKey);
            const bills = page.bills;
            if (!Array.isArray(bills)) {
                listErrors.push({
                    type,
                    error: `response had no 'bills' array; top-level keys=${Object.keys(page).join(",") || "(none)"}`,
                });
                continue;
            }
            if (bills.length === 0) {
                listErrors.push({ type, error: "API returned 0 bills (empty array)" });
                continue;
            }
            results.push(...bills);
        } catch (err) {
            const message = (err as Error).message;
            console.warn(`listRecentBills: failed for type=${type}: ${message}`);
            listErrors.push({ type, error: message });
        }
    }

    // Sort newest-updated first (best proxy we have at the list stage) and
    // cap at `limit`.
    results.sort((a, b) => (b.updateDate ?? "").localeCompare(a.updateDate ?? ""));
    return { bills: results.slice(0, limit), listErrors };
}

/** Fetch the full detail record for a single bill. */
export async function getBillDetail(
    apiKey: string,
    congress: number,
    type: string,
    number: string | number,
): Promise<CongressBillDetail> {
    const t = type.toLowerCase();
    const url = `${API_ROOT}/bill/${congress}/${t}/${number}`;
    const data = await getJson<{ bill: CongressBillDetail }>(url, apiKey);
    const bill = data.bill;
    bill.publicUrl = `https://www.congress.gov/bill/${congress}th-congress/${humanChamber(t)}/${number}`;
    return bill;
}

/**
 * Fetch the most recent CRS/official summary for a bill, if one exists.
 * Many newly-introduced bills have no summary yet — callers must tolerate null.
 */
export async function getBillSummary(
    apiKey: string,
    congress: number,
    type: string,
    number: string | number,
): Promise<CongressBillSummary | null> {
    const t = type.toLowerCase();
    const url = `${API_ROOT}/bill/${congress}/${t}/${number}/summaries`;
    try {
        const data = await getJson<{ summaries: CongressBillSummary[] }>(url, apiKey);
        const list = data.summaries ?? [];
        if (list.length === 0) return null;
        // Prefer the most recent by actionDate.
        list.sort((a, b) => (b.actionDate ?? "").localeCompare(a.actionDate ?? ""));
        return list[0];
    } catch (err) {
        console.warn(`getBillSummary: ${(err as Error).message}`);
        return null;
    }
}

function humanChamber(type: string): string {
    // Map API type codes to the path segments congress.gov uses.
    switch (type) {
        case "hr":
            return "house-bill";
        case "s":
            return "senate-bill";
        case "hjres":
            return "house-joint-resolution";
        case "sjres":
            return "senate-joint-resolution";
        case "hconres":
            return "house-concurrent-resolution";
        case "sconres":
            return "senate-concurrent-resolution";
        case "hres":
            return "house-resolution";
        case "sres":
            return "senate-resolution";
        default:
            return type;
    }
}

/** Deterministic primary key. */
export function billKey(congress: number, type: string, number: string | number): string {
    return `${congress}-${type.toLowerCase()}-${number}`;
}

/** Strip HTML tags from the CRS summary so we can feed plain text to Gemini. */
export function stripHtml(html: string): string {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}
