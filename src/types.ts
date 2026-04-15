// Shared Worker/DB types.

export interface Env {
    DB: D1Database;

    // vars (non-secret)
    MIN_BILL_DATE: string;
    INGEST_LIMIT: string;
    GEMINI_MODEL: string;

    // secrets
    CONGRESS_API_KEY: string;
    GEMINI_API_KEY: string;
    ADMIN_TOKEN: string;
}

/**
 * Direction of a citizen-facing impact. The UI maps `"increase"` to green
 * and `"decrease"` to red; `"none"` (and `null` for legacy rows) hides the
 * badge. Values are literal strings so they stringify cleanly into D1 and
 * out via the JSON API.
 */
export type ImpactDirection = "increase" | "decrease" | "none";

/** A cached, already-summarized bill as it lives in D1, after parsing. */
export interface BillRow {
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
    /**
     * Citizen-impact alerts. `null` for rows cached before these columns
     * existed; the UI treats `null` the same as `"none"` and hides the badge.
     */
    rights_impact: ImpactDirection | null;
    tax_impact: ImpactDirection | null;
    benefits_impact: ImpactDirection | null;
    /**
     * Content tags — lowercase short strings like `"farm"`, `"tax change"`,
     * `"healthcare"`. Empty array for rows cached before tagging was added.
     * Stored in D1 as a JSON-encoded string; `src/db.ts` parses on read.
     */
    tags: string[];
    summarized_at: string;
    model: string;
}

/**
 * Minimal bill shape returned by the Congress **list** endpoint.
 * Note: `number` is a string in the JSON payload (e.g. "6507"), and the list
 * endpoint does NOT include `introducedDate` — that only exists on the detail
 * response. Filter by introduced date at the detail stage, not here.
 */
export interface CongressListBill {
    congress: number;
    type: string;           // e.g. "HR", "S", "HJRES"
    number: string;
    title: string;
    updateDate?: string;
    latestAction?: { actionDate?: string; text?: string };
    url: string;            // API URL for the bill detail
}

/** Bill detail. `number` is also a string in the JSON payload. */
export interface CongressBillDetail {
    congress: number;
    type: string;
    number: string;
    title: string;
    introducedDate?: string;
    sponsors?: Array<{ fullName?: string; firstName?: string; lastName?: string }>;
    latestAction?: { actionDate?: string; text?: string };
    summaries?: { url?: string };
    textVersions?: { url?: string };
    policyArea?: { name?: string };
    /** human-facing congress.gov URL (we synthesize this ourselves). */
    publicUrl?: string;
}

/** An official CRS summary returned by the /bill/{c}/{t}/{n}/summaries endpoint. */
export interface CongressBillSummary {
    actionDate?: string;
    actionDesc?: string;
    text?: string;          // HTML
    updateDate?: string;
    versionCode?: string;
}

/**
 * Everything Gemini returns per bill in a single call: the two summaries,
 * the three citizen-impact directions, and a handful of content tags.
 */
export interface BillEnrichment {
    english: string;
    chinese: string;
    rightsImpact: ImpactDirection;
    taxImpact: ImpactDirection;
    benefitsImpact: ImpactDirection;
    tags: string[];
}
