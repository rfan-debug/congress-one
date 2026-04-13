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

/** A cached, already-summarized bill as it lives in D1. */
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
    summarized_at: string;
    model: string;
}

/** Minimal bill shape returned by the Congress list endpoint. */
export interface CongressListBill {
    congress: number;
    type: string;           // e.g. "HR", "S", "HJRES"
    number: number;
    title: string;
    introducedDate?: string;
    updateDate?: string;
    latestAction?: { actionDate?: string; text?: string };
    url: string;            // API URL for the bill detail
}

/** Bill detail (the interesting bits we actually use). */
export interface CongressBillDetail {
    congress: number;
    type: string;
    number: number;
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

/** Output of the Gemini summarization call. */
export interface BilingualSummary {
    english: string;
    chinese: string;
}
