// Google Gemini client (via Google AI Studio).
// Docs: https://ai.google.dev/gemini-api/docs/text-generation
//
// Get a free key at https://aistudio.google.com/ -> "Get API key".
// The key is passed as a query parameter on every request.

import type { BillEnrichment, ImpactDirection } from "./types";

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
 * Summarize + classify + tag a single bill in one Gemini call.
 *
 * One call per bill. The result is cached in D1 so this never runs twice
 * for the same `bill_id`.
 *
 * Returns a {@link BillEnrichment}: bilingual summaries, three citizen-impact
 * directions (rights / taxes / benefits), and a small set of content tags
 * that the filter UI lets users browse by.
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
): Promise<BillEnrichment> {
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

    return parseEnrichment(text);
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
        "Task: Produce SIX outputs for this bill — two summaries, three impact",
        "classifications, and a tag list.",
        "",
        "(1) Plain-English summary and (2) Simplified Chinese summary.",
        "Rules for BOTH languages:",
        "- Audience: an average adult with no legal training.",
        "- ≤ 220 words each. Must fit on one phone screen.",
        "- Structure as 3 short paragraphs or 4–6 bullet points:",
        "    a. What the bill would actually do, in concrete terms.",
        "    b. Who it affects and how.",
        "    c. What it does NOT do / common misconceptions, if any are obvious.",
        "- Neutral tone. No opinions. No predictions. No partisan framing.",
        "- If the source material is too thin to summarize, say so in one sentence and stop.",
        "",
        "(3) rights_impact  — Does this bill EXPAND or RESTRICT what an ordinary",
        "    U.S. resident is legally allowed to do (speech, privacy, due process,",
        "    voting, firearms, bodily autonomy, immigration status, etc.)?",
        "    Answer exactly one of: increase, decrease, none.",
        "    Use `increase` if the bill creates/broadens a right or protection.",
        "    Use `decrease` if it removes/narrows a right or protection.",
        "    Use `none`     if the bill is not about individual rights at all,",
        "                   or if the direction is genuinely unclear.",
        "",
        "(4) tax_impact — Does this bill raise or lower taxes that an ordinary",
        "    person pays (income, payroll, sales, tariffs passed to consumers,",
        "    property, estate, capital gains for non-wealthy households)?",
        "    Answer exactly one of: increase, decrease, none.",
        "    `increase` = taxes go up; `decrease` = taxes go down;",
        "    `none` = not a tax bill, or it's tax-neutral for ordinary people.",
        "",
        "(5) benefits_impact — Does this bill expand or cut social benefits and",
        "    public services ordinary people receive (Social Security, Medicare,",
        "    Medicaid, SNAP, unemployment, student aid, veterans' benefits, child",
        "    tax credit, disability, housing assistance, disaster relief, etc.)?",
        "    Answer exactly one of: increase, decrease, none.",
        "",
        "(6) tags — 3 to 6 short lowercase content tags describing the bill's",
        "    subject matter. Think topical categories a news reader would browse:",
        "    examples include farm, culture, economy, tax change, benefits change,",
        "    healthcare, housing, education, immigration, defense, veterans,",
        "    energy, climate, technology, civil rights, labor, small business,",
        "    rural, urban, transportation, elections, criminal justice,",
        "    foreign policy, trade, public lands. Invent new tags when none fit,",
        "    but keep them short (1-3 words), lowercase, and topical — NOT",
        "    partisan. Separate tags with commas.",
        "",
        "Output format — respond with EXACTLY this, no preamble, no closing",
        "remarks, no code fences:",
        "",
        "<english>",
        "...plain English summary here...",
        "</english>",
        "<chinese>",
        "...简体中文摘要...",
        "</chinese>",
        "<rights>increase|decrease|none</rights>",
        "<taxes>increase|decrease|none</taxes>",
        "<benefits>increase|decrease|none</benefits>",
        "<tags>tag1, tag2, tag3</tags>",
    ].join("\n");
}

function parseEnrichment(text: string): BillEnrichment {
    // Gemini sometimes wraps the whole thing in ```...``` fences; strip them.
    const cleaned = text
        .replace(/^```[a-zA-Z]*\n?/m, "")
        .replace(/\n?```\s*$/m, "")
        .trim();

    const english = extractTag(cleaned, "english");
    const chinese = extractTag(cleaned, "chinese");
    if (!english || !chinese) {
        throw new Error(
            `Gemini response missing <english>/<chinese> tags. Got: ${cleaned.slice(0, 300)}`,
        );
    }

    // The classification fields are best-effort. If Gemini drops them or
    // returns something unexpected, fall back to "none" rather than failing
    // the whole bill — the summary itself is still valuable.
    const rightsImpact = parseImpact(extractTag(cleaned, "rights"));
    const taxImpact = parseImpact(extractTag(cleaned, "taxes"));
    const benefitsImpact = parseImpact(extractTag(cleaned, "benefits"));
    const tags = parseTags(extractTag(cleaned, "tags"));

    return { english, chinese, rightsImpact, taxImpact, benefitsImpact, tags };
}

function parseImpact(raw: string | null): ImpactDirection {
    if (!raw) return "none";
    const s = raw.trim().toLowerCase();
    if (s === "increase" || s === "decrease" || s === "none") return s;
    // Defensive: the model sometimes hedges ("mostly none", "slight increase").
    if (s.includes("increase")) return "increase";
    if (s.includes("decrease") || s.includes("reduce") || s.includes("cut")) {
        return "decrease";
    }
    return "none";
}

function parseTags(raw: string | null): string[] {
    if (!raw) return [];
    return raw
        .split(/[,\n]/)
        .map((t) => t.trim().toLowerCase())
        // strip stray quotes, brackets, leading dashes/bullets from the model
        .map((t) => t.replace(/^["'\-*•\[]+|["'\]\s]+$/g, "").trim())
        .filter((t) => t.length > 0 && t.length <= 40)
        // dedupe while preserving order
        .filter((t, i, arr) => arr.indexOf(t) === i)
        .slice(0, 8);
}

function extractTag(text: string, tag: string): string | null {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
    const m = text.match(re);
    return m ? m[1].trim() : null;
}

/**
 * Map a user's free-text profile to a subset of the tag vocabulary we
 * already use on bills. One small Gemini call: the prompt contains only
 * the tag list + the profile text (no bill summaries), and we ask the
 * model to emit a JSON array of at most 8 tags. That gives the /find
 * feature a semantic "what should I care about?" layer at a fraction of
 * the token cost of feeding bill summaries through the model.
 *
 * Returns tags drawn from `tagVocabulary` (case-folded to lowercase).
 * Anything the model hallucinates outside the vocabulary is dropped.
 */
export async function findTagsForProfile(
    apiKey: string,
    model: string,
    profile: string,
    tagVocabulary: string[],
): Promise<string[]> {
    // Defensive cap on vocabulary size so the prompt stays predictable
    // even if the cache ever grows a huge long tail of tags.
    const vocab = tagVocabulary.slice(0, 300);
    if (vocab.length === 0 || !profile.trim()) return [];

    const prompt = [
        "A user shared a short profile describing who they are and what they",
        "care about. From the list of known tags below, return the ones most",
        "relevant to this user. Pick at most 8. Only use tags from the list —",
        "do not invent new ones. If nothing fits, return an empty array.",
        "Return ONLY a JSON array of lowercase strings, no prose.",
        "",
        "Known tags:",
        vocab.map((t) => `- ${t}`).join("\n"),
        "",
        "User profile:",
        profile.slice(0, 1000),
    ].join("\n");

    const url = `${API_ROOT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 200,
                responseMimeType: "application/json",
            },
        }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Gemini tag-match ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as GeminiResponse;
    if (data.error) {
        throw new Error(`Gemini error ${data.error.code}: ${data.error.message}`);
    }

    const text = (data.candidates ?? [])
        .flatMap((c) => c.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("")
        .trim();
    if (!text) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];

    const known = new Set(vocab.map((t) => t.toLowerCase()));
    const out: string[] = [];
    for (const item of parsed) {
        if (typeof item !== "string") continue;
        const norm = item.trim().toLowerCase();
        if (!norm || !known.has(norm) || out.includes(norm)) continue;
        out.push(norm);
        if (out.length >= 8) break;
    }
    return out;
}
