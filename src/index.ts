// Worker entry point.
//
// Routes:
//   GET  /                   HTML page with cached, sortable, tag-filterable bills
//   GET  /api/bills          JSON feed (supports ?q, ?sort, ?order, ?tag, ?limit, ?offset)
//   GET  /api/bills/:id      Single bill JSON
//   GET  /api/tags           All distinct content tags currently cached
//   POST /admin/ingest       Manually kick off an ingest (Authorization: Bearer $ADMIN_TOKEN)
//   GET  /admin/diag         Upstream-API diagnostic (same auth)
//
// Scheduled:
//   weekly cron -> runIngest()

import { countBills, getBill, listAllTags, listBills } from "./db";
import { runIngest } from "./ingest";
import { renderIndex } from "./templates";
import type { Env } from "./types";

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        try {
            if (request.method === "GET" && url.pathname === "/") {
                return await handleIndex(url, env);
            }
            if (request.method === "GET" && url.pathname === "/api/bills") {
                return await handleApiList(url, env);
            }
            if (request.method === "GET" && url.pathname.startsWith("/api/bills/")) {
                const id = decodeURIComponent(url.pathname.slice("/api/bills/".length));
                return await handleApiDetail(id, env);
            }
            if (request.method === "GET" && url.pathname === "/api/tags") {
                return await handleApiTags(env);
            }
            if (request.method === "POST" && url.pathname === "/admin/ingest") {
                return await handleAdminIngest(request, env, ctx);
            }
            if (request.method === "GET" && url.pathname === "/admin/diag") {
                return await handleAdminDiag(request, env);
            }
            if (request.method === "GET" && url.pathname === "/healthz") {
                return new Response("ok", { status: 200 });
            }
            return new Response("Not found", { status: 404 });
        } catch (err) {
            console.error("unhandled error:", err);
            return new Response(
                `Internal error: ${(err as Error).message}`,
                { status: 500 },
            );
        }
    },

    async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
        // Cloudflare gives scheduled handlers a short wall-clock budget, so we
        // hand the work off to waitUntil and return immediately.
        ctx.waitUntil(
            (async () => {
                const result = await runIngest(env);
                console.log(
                    `cron ingest: scanned=${result.scanned} inserted=${result.inserted} ` +
                        `cached=${result.alreadyCached} skipped=${result.skipped} ` +
                        `errors=${result.errors.length}`,
                );
                if (result.errors.length) {
                    for (const e of result.errors.slice(0, 10)) {
                        console.warn(`  ${e.billId}: ${e.error}`);
                    }
                }
            })(),
        );
    },
};

async function handleIndex(url: URL, env: Env): Promise<Response> {
    const sortParam = url.searchParams.get("sort");
    const orderParam = url.searchParams.get("order");
    const q = url.searchParams.get("q") ?? "";
    const tag = (url.searchParams.get("tag") ?? "").trim().toLowerCase();
    const sortBy =
        sortParam === "latest_action_date" ? "latest_action_date" : "introduced_date";
    const order = orderParam === "asc" ? "asc" : "desc";

    const [bills, total, allTags] = await Promise.all([
        listBills(env.DB, { sortBy, order, limit: 50, q, tag }),
        countBills(env.DB),
        listAllTags(env.DB),
    ]);

    const html = renderIndex({ bills, sortBy, order, q, tag, allTags, total });
    return new Response(html, {
        headers: {
            "content-type": "text/html; charset=utf-8",
            // Short edge cache — the data only changes on cron or admin ingest.
            "cache-control": "public, max-age=300",
        },
    });
}

async function handleApiList(url: URL, env: Env): Promise<Response> {
    const sortParam = url.searchParams.get("sort");
    const orderParam = url.searchParams.get("order");
    const q = url.searchParams.get("q") ?? "";
    const tag = (url.searchParams.get("tag") ?? "").trim().toLowerCase();
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
    const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);

    const sortBy =
        sortParam === "latest_action_date" ? "latest_action_date" : "introduced_date";
    const order = orderParam === "asc" ? "asc" : "desc";

    const bills = await listBills(env.DB, { sortBy, order, limit, offset, q, tag });
    return json({ count: bills.length, bills });
}

async function handleApiTags(env: Env): Promise<Response> {
    const tags = await listAllTags(env.DB);
    return json({ count: tags.length, tags });
}

async function handleApiDetail(id: string, env: Env): Promise<Response> {
    const bill = await getBill(env.DB, id);
    if (!bill) return json({ error: "not found" }, 404);
    return json(bill);
}

async function handleAdminIngest(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
): Promise<Response> {
    if (!isAdmin(request, env)) {
        return new Response("unauthorized", { status: 401 });
    }

    // Run synchronously so the caller sees the result, but keep waitUntil alive
    // in case the client disconnects early.
    const resultPromise = runIngest(env);
    ctx.waitUntil(resultPromise);
    const result = await resultPromise;
    return json(result);
}

/**
 * Diagnostic: hit both upstream APIs with the minimum possible payload and
 * return the raw status / first chunk of body for each. Useful when
 * `/admin/ingest` returns all zeros and we need to know whether the problem is
 * in the Worker's code, the Congress key, the Gemini key, or the network.
 *
 * We deliberately do NOT touch D1 or the ingest pipeline.
 */
async function handleAdminDiag(request: Request, env: Env): Promise<Response> {
    if (!isAdmin(request, env)) {
        return new Response("unauthorized", { status: 401 });
    }

    const report: Record<string, unknown> = {
        env: {
            MIN_BILL_DATE: env.MIN_BILL_DATE ?? null,
            INGEST_LIMIT: env.INGEST_LIMIT ?? null,
            GEMINI_MODEL: env.GEMINI_MODEL ?? null,
            CONGRESS_API_KEY_present: Boolean(env.CONGRESS_API_KEY),
            CONGRESS_API_KEY_length: env.CONGRESS_API_KEY?.length ?? 0,
            GEMINI_API_KEY_present: Boolean(env.GEMINI_API_KEY),
            GEMINI_API_KEY_length: env.GEMINI_API_KEY?.length ?? 0,
            ADMIN_TOKEN_present: Boolean(env.ADMIN_TOKEN),
        },
    };

    // --- Congress API probe ------------------------------------------------
    if (env.CONGRESS_API_KEY) {
        const probeUrl = new URL("https://api.congress.gov/v3/bill/119/hr");
        probeUrl.searchParams.set("api_key", env.CONGRESS_API_KEY);
        probeUrl.searchParams.set("format", "json");
        probeUrl.searchParams.set("limit", "2");
        probeUrl.searchParams.set("sort", "updateDate desc");
        try {
            const res = await fetch(probeUrl.toString(), {
                headers: { "User-Agent": "congress-one/0.1 (diagnostic)" },
            });
            const text = await res.text();
            let parsedBills: number | null = null;
            let parsedKeys: string[] | null = null;
            try {
                const j = JSON.parse(text);
                parsedKeys = Object.keys(j);
                if (Array.isArray(j.bills)) parsedBills = j.bills.length;
            } catch {
                /* leave null */
            }
            report.congress = {
                // Strip the api_key from what we report back so the log is safe.
                url: probeUrl.toString().replace(/api_key=[^&]*/, "api_key=REDACTED"),
                status: res.status,
                ok: res.ok,
                bodyPreview: text.slice(0, 400),
                parsedTopLevelKeys: parsedKeys,
                parsedBillsCount: parsedBills,
            };
        } catch (err) {
            report.congress = { error: (err as Error).message };
        }
    } else {
        report.congress = { error: "CONGRESS_API_KEY is empty" };
    }

    // --- Gemini API probe --------------------------------------------------
    if (env.GEMINI_API_KEY) {
        const model = env.GEMINI_MODEL || "gemini-2.5-flash";
        const url =
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent` +
            `?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: "Reply with the single word: pong" }] }],
                    generationConfig: { temperature: 0, maxOutputTokens: 8 },
                }),
            });
            const text = await res.text();
            report.gemini = {
                model,
                status: res.status,
                ok: res.ok,
                bodyPreview: text.slice(0, 400),
            };
        } catch (err) {
            report.gemini = { error: (err as Error).message };
        }
    } else {
        report.gemini = { error: "GEMINI_API_KEY is empty" };
    }

    return json(report);
}

function isAdmin(request: Request, env: Env): boolean {
    const auth = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${env.ADMIN_TOKEN}`;
    return Boolean(env.ADMIN_TOKEN) && auth === expected;
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}
