// Worker entry point.
//
// Routes:
//   GET  /                   HTML page with cached, sortable bills
//   GET  /api/bills          JSON feed
//   GET  /api/bills/:id      Single bill JSON
//   POST /admin/ingest       Manually kick off an ingest (Authorization: Bearer $ADMIN_TOKEN)
//
// Scheduled:
//   weekly cron -> runIngest()

import { countBills, getBill, listBills } from "./db";
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
            if (request.method === "POST" && url.pathname === "/admin/ingest") {
                return await handleAdminIngest(request, env, ctx);
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
    const sortBy =
        sortParam === "latest_action_date" ? "latest_action_date" : "introduced_date";
    const order = orderParam === "asc" ? "asc" : "desc";

    const [bills, total] = await Promise.all([
        listBills(env.DB, { sortBy, order, limit: 50, q }),
        countBills(env.DB),
    ]);

    const html = renderIndex({ bills, sortBy, order, q, total });
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
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
    const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);

    const sortBy =
        sortParam === "latest_action_date" ? "latest_action_date" : "introduced_date";
    const order = orderParam === "asc" ? "asc" : "desc";

    const bills = await listBills(env.DB, { sortBy, order, limit, offset, q });
    return json({ count: bills.length, bills });
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
    const auth = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${env.ADMIN_TOKEN}`;
    if (!env.ADMIN_TOKEN || auth !== expected) {
        return new Response("unauthorized", { status: 401 });
    }

    // Run synchronously so the caller sees the result, but keep waitUntil alive
    // in case the client disconnects early.
    const resultPromise = runIngest(env);
    ctx.waitUntil(resultPromise);
    const result = await resultPromise;
    return json(result);
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}
