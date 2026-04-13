// Pipeline that turns recent Congress bills into cached bilingual summaries.
// Called from both the weekly cron trigger and the /admin/ingest HTTP route.

import { summarizeBill } from "./claude";
import {
    billKey,
    getBillDetail,
    getBillSummary,
    listRecentBills,
    stripHtml,
} from "./congress";
import { hasBill, insertBill } from "./db";
import type { Env } from "./types";

export interface IngestResult {
    scanned: number;
    alreadyCached: number;
    inserted: number;
    skipped: number;
    errors: Array<{ billId: string; error: string }>;
}

export async function runIngest(env: Env): Promise<IngestResult> {
    const minDate = env.MIN_BILL_DATE || "2025-01-01";
    const limit = Number.parseInt(env.INGEST_LIMIT || "50", 10) || 50;

    const result: IngestResult = {
        scanned: 0,
        alreadyCached: 0,
        inserted: 0,
        skipped: 0,
        errors: [],
    };

    const recent = await listRecentBills(env.CONGRESS_API_KEY, minDate, limit);
    result.scanned = recent.length;

    for (const listItem of recent) {
        const id = billKey(listItem.congress, listItem.type, listItem.number);

        try {
            if (await hasBill(env.DB, id)) {
                result.alreadyCached += 1;
                continue;
            }

            // Fetch the full detail + summary so Claude has useful context.
            const detail = await getBillDetail(
                env.CONGRESS_API_KEY,
                listItem.congress,
                listItem.type,
                listItem.number,
            );

            // Introduced before our cutoff? Skip. (Defensive — the list is
            // already filtered, but detail records can drift.)
            if (!detail.introducedDate || detail.introducedDate < minDate) {
                result.skipped += 1;
                continue;
            }

            const summaryRec = await getBillSummary(
                env.CONGRESS_API_KEY,
                listItem.congress,
                listItem.type,
                listItem.number,
            );
            const officialSummary = summaryRec?.text ? stripHtml(summaryRec.text) : null;

            const sponsor = detail.sponsors?.[0]?.fullName ?? null;
            const billLabel = `${formatType(detail.type)} ${detail.number} (${detail.congress}th Congress)`;

            const bilingual = await summarizeBill(
                env.ANTHROPIC_API_KEY,
                env.CLAUDE_MODEL || "claude-haiku-4-5-20251001",
                {
                    title: detail.title,
                    billLabel,
                    sponsor,
                    introducedDate: detail.introducedDate,
                    latestAction: detail.latestAction?.text ?? null,
                    officialSummary,
                },
            );

            await insertBill(env.DB, {
                bill_id: id,
                congress: detail.congress,
                bill_type: detail.type.toLowerCase(),
                bill_number: detail.number,
                title: detail.title,
                sponsor,
                introduced_date: detail.introducedDate,
                latest_action_date: detail.latestAction?.actionDate ?? null,
                latest_action_text: detail.latestAction?.text ?? null,
                source_url: detail.publicUrl ?? "",
                summary_en: bilingual.english,
                summary_zh: bilingual.chinese,
                summarized_at: new Date().toISOString(),
                model: env.CLAUDE_MODEL || "claude-haiku-4-5-20251001",
            });

            result.inserted += 1;
        } catch (err) {
            result.errors.push({ billId: id, error: (err as Error).message });
            // Keep going — one bad bill shouldn't fail the whole run.
        }
    }

    return result;
}

function formatType(type: string): string {
    const t = type.toUpperCase();
    switch (t) {
        case "HR":
            return "H.R.";
        case "S":
            return "S.";
        case "HJRES":
            return "H.J.Res.";
        case "SJRES":
            return "S.J.Res.";
        case "HCONRES":
            return "H.Con.Res.";
        case "SCONRES":
            return "S.Con.Res.";
        case "HRES":
            return "H.Res.";
        case "SRES":
            return "S.Res.";
        default:
            return t;
    }
}
