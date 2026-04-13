// Google Gemini client (via Google AI Studio).
// Docs: https://ai.google.dev/gemini-api/docs/text-generation
//
// Get a free key at https://aistudio.google.com/ -> "Get API key".
// The key is passed as a query parameter on every request.

import type { BilingualSummary } from "./types";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiPart {
    text?: string;
}

interface GeminiContent {
    role?: string;
    parts: GeminiPart[];
}

interface GeminiCandidate {
    content?: GeminiContent;
    finishReason?: string;
}

interface GeminiResponse {
    candidates?: GeminiCandidate[];
    promptFeedback?: { blockReason?: string };
    error?: { code: number; message: string; status?: string };
}

/**
 * Summarize a single bill in plain English and Simplified Chinese.
 *
 * One call per bill. The result is cached in D1 so this never runs twice
 * for the same `bill_id`.
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

    const url = `${API_ROOT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            systemInstruction: {
                parts: [
                    {
                        text:
                            "You are a non-partisan civics explainer. You translate dense " +
                            "legislative text into short, neutral, plain-language summaries that " +
                            "a curious high-school student can understand. Never editorialize, " +
                            "never predict outcomes, never speculate about motives. If the source " +
                            "material is thin, say so explicitly.",
                    },
                ],
            },
            contents: [
                {
                    role: "user",
                    parts: [{ text: prompt }],
                },
            ],
            generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 1200,
                responseMimeType: "text/plain",
            },
        }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Gemini API ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as GeminiResponse;

    if (data.error) {
        throw new Error(`Gemini API error ${data.error.code}: ${data.error.message}`);
    }
    if (data.promptFeedback?.blockReason) {
        throw new Error(`Gemini blocked prompt: ${data.promptFeedback.blockReason}`);
    }

    const text = (data.candidates ?? [])
        .flatMap((c) => c.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("\n")
        .trim();

    if (!text) {
        throw new Error("Gemini response contained no text");
    }

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
        "Output format — respond with EXACTLY this, no preamble, no closing remarks, no code fences:",
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
    // Gemini sometimes wraps the whole thing in ```...``` fences; strip them.
    const cleaned = text
        .replace(/^```[a-zA-Z]*\n?/m, "")
        .replace(/\n?```\s*$/m, "")
        .trim();

    const en = extractTag(cleaned, "english");
    const zh = extractTag(cleaned, "chinese");
    if (!en || !zh) {
        throw new Error(
            `Gemini response missing <english>/<chinese> tags. Got: ${cleaned.slice(0, 300)}`,
        );
    }
    return { english: en, chinese: zh };
}

function extractTag(text: string, tag: string): string | null {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
    const m = text.match(re);
    return m ? m[1].trim() : null;
}
