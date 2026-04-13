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
    minDate: string,
    limit: number,
): Promise<{ bills: CongressListBill[]; listErrors: Array<{ type: string; error: string }> }> {
    // Round-robin the bill types so we don't bias toward HR.
    // We deliberately over-fetch per type because the API sorts by updateDate
    // and we filter by introducedDate client-side.
    const perType = Math.max(10, Math.ceil(limit / BILL_TYPES.length) * 3);

    const results: CongressListBill[] = [];
    const listErrors: Array<{ type: string; error: string }> = [];
    for (const type of BILL_TYPES) {
        // NOTE: intentionally NOT passing fromDateTime — api.congress.gov
        // requires fromDateTime and toDateTime to be provided *together*, and
        // some endpoints silently return empty arrays when only one is set.
        // We rely on `sort=updateDate desc` to put recent bills first and
        // filter by introducedDate client-side.
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
            let kept = 0;
            for (const b of bills) {
                if (b.introducedDate && b.introducedDate >= minDate) {
                    results.push(b);
                    kept += 1;
                }
            }
            if (kept === 0) {
                listErrors.push({
                    type,
                    error: `API returned ${bills.length} bills but none had introducedDate >= ${minDate}. Oldest returned: ${bills[bills.length - 1]?.introducedDate ?? "(unknown)"}, newest: ${bills[0]?.introducedDate ?? "(unknown)"}`,
                });
            }
        } catch (err) {
            const message = (err as Error).message;
            console.warn(`listRecentBills: failed for type=${type}: ${message}`);
            listErrors.push({ type, error: message });
        }
    }

    // Sort newest-introduced first and cap at `limit`.
    results.sort((a, b) => (b.introducedDate ?? "").localeCompare(a.introducedDate ?? ""));
    return { bills: results.slice(0, limit), listErrors };
}

/** Fetch the full detail record for a single bill. */
export async function getBillDetail(
    apiKey: string,
    congress: number,
    type: string,
    number: number,
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
    number: number,
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
export function billKey(congress: number, type: string, number: number): string {
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
