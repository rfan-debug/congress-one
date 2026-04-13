// Claude API client.  We call this once per bill and cache the result in D1.
// Docs: https://docs.anthropic.com/en/api/messages

import type { BilingualSummary } from "./types";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

interface ClaudeTextBlock {
    type: "text";
    text: string;
}

interface ClaudeMessageResponse {
    content: ClaudeTextBlock[];
    stop_reason?: string;
}

/**
 * Summarize a single bill in plain English and Simplified Chinese.
 *
 * The prompt is designed to produce something an average reader can digest in
 * under a minute and that fits comfortably on one screen (≤ ~250 words per
 * language).
 */
export async function summarizeBill(
    apiKey: string,
    model: string,
    input: {
        title: string;
        billLabel: string;           // e.g. "H.R. 1234 (119th Congress)"
        sponsor: string | null;
        introducedDate: string;
        latestAction: string | null;
        officialSummary: string | null;
    },
): Promise<BilingualSummary> {
    const prompt = buildPrompt(input);

    const res = await fetch(API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": API_VERSION,
        },
        body: JSON.stringify({
            model,
            max_tokens: 1200,
            temperature: 0.2,
            system:
                "You are a non-partisan civics explainer. You translate dense legislative " +
                "text into short, neutral, plain-language summaries that a curious high-school " +
                "student can understand. Never editorialize, never predict outcomes, never " +
                "speculate about motives. If the source material is thin, say so explicitly.",
            messages: [{ role: "user", content: prompt }],
        }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Claude API ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as ClaudeMessageResponse;
    const text = (data.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

    return parseBilingual(text);
}

function buildPrompt(input: {
    title: string;
    billLabel: string;
    sponsor: string | null;
    introducedDate: string;
    latestAction: string | null;
    officialSummary: string | null;
}): string {
    const source = input.officialSummary?.trim()
        ? input.officialSummary.trim()
        : "(No official summary has been published yet. Summarize based only on the bill's title and metadata; be honest about the limited information.)";

    return [
        `Bill: ${input.billLabel}`,
        `Title: ${input.title}`,
        `Sponsor: ${input.sponsor ?? "Unknown"}`,
        `Introduced: ${input.introducedDate}`,
        `Latest action: ${input.latestAction ?? "None recorded"}`,
        "",
        "Official summary (may be empty or be written in dense legal English):",
        source,
        "",
        "Task: Write two short summaries of this bill — one in plain English, one in Simplified Chinese.",
        "",
        "Rules for BOTH languages:",
        "- Audience: an average adult with no legal training.",
        "- ≤ 220 words each. Must fit on one phone screen.",
        "- Structure as 3 short paragraphs or 4–6 bullet points:",
        "    1. What the bill would actually do, in concrete terms.",
        "    2. Who it affects and how.",
        "    3. What it does NOT do / common misconceptions, if any are obvious from the text.",
        "- Neutral tone. No opinions. No predictions. No partisan framing.",
        "- If the source material is too thin to summarize, say so in one sentence and stop.",
        "",
        "Output format — respond with EXACTLY this, no preamble, no closing remarks:",
        "",
        "<english>",
        "...plain English summary here...",
        "</english>",
        "<chinese>",
        "...简体中文摘要...",
        "</chinese>",
    ].join("\n");
}

function parseBilingual(text: string): BilingualSummary {
    const en = extractTag(text, "english");
    const zh = extractTag(text, "chinese");
    if (!en || !zh) {
        throw new Error(
            `Claude response missing <english>/<chinese> tags. Got: ${text.slice(0, 300)}`,
        );
    }
    return { english: en, chinese: zh };
}

function extractTag(text: string, tag: string): string | null {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
    const m = text.match(re);
    return m ? m[1].trim() : null;
}
