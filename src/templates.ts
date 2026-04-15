// Server-rendered HTML. Kept deliberately minimal — no framework, no build step.

import type { BillRow, ImpactDirection } from "./types";

export function renderLayout(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --impact-up-bg: #1a7f371a;
    --impact-up-fg: #1a7f37;
    --impact-up-border: #1a7f3755;
    --impact-down-bg: #c22d2d1a;
    --impact-down-fg: #c22d2d;
    --impact-down-border: #c22d2d55;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --impact-up-fg: #4ade80;
      --impact-up-border: #4ade8055;
      --impact-down-fg: #f87171;
      --impact-down-border: #f8717155;
    }
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         max-width: 860px; margin: 0 auto; padding: 1.5rem 1rem 4rem; line-height: 1.55; }
  h1 { margin: 0 0 .25rem; font-size: 1.6rem; }
  .tagline { color: #888; margin: 0 0 1.5rem; }
  form.controls { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1.25rem; }
  form.controls input[type=text], form.controls select {
    padding: .45rem .6rem; border: 1px solid #ccc; border-radius: 6px; font-size: .95rem;
    background: transparent; color: inherit;
  }
  form.controls button { padding: .45rem .9rem; border: 1px solid #888; border-radius: 6px;
    background: transparent; color: inherit; cursor: pointer; font-size: .95rem; }

  /* Tag filter bar (above the bill list) */
  .tag-filter { margin: 0 0 1.25rem; }
  .tag-filter-label { color: #888; font-size: .82rem; margin: 0 0 .4rem; }
  .tag-filter-chips { display: flex; flex-wrap: wrap; gap: .35rem; }
  .tag-chip { display: inline-block; padding: .2rem .65rem; border-radius: 999px;
    border: 1px solid #8886; background: transparent; color: inherit; text-decoration: none;
    font-size: .78rem; line-height: 1.4; white-space: nowrap; }
  .tag-chip:hover { background: #8881; }
  .tag-chip.active { background: #3b82f6; color: white; border-color: #3b82f6; font-weight: 600; }
  .tag-chip.clear { border-style: dashed; }

  article.bill { border: 1px solid #ddd3; border-radius: 10px; padding: 1rem 1.1rem;
    margin-bottom: 1rem; background: #fff1; }
  article.bill h2 { margin: 0 0 .25rem; font-size: 1.15rem; }
  article.bill h2 a { color: inherit; text-decoration: none; }
  article.bill h2 a:hover { text-decoration: underline; }
  .meta { color: #888; font-size: .85rem; margin-bottom: .65rem; }

  /* Citizen-impact alert badges */
  .alerts { display: flex; flex-wrap: wrap; gap: .4rem; margin: 0 0 .7rem; }
  .alert { display: inline-flex; align-items: center; gap: .25rem;
    padding: .2rem .55rem; border-radius: 6px; font-size: .78rem; font-weight: 600;
    line-height: 1.4; border: 1px solid transparent; }
  .alert.up   { background: var(--impact-up-bg);   color: var(--impact-up-fg);
                border-color: var(--impact-up-border); }
  .alert.down { background: var(--impact-down-bg); color: var(--impact-down-fg);
                border-color: var(--impact-down-border); }
  .alert .arrow { font-weight: 700; }

  /* Per-card content tag chips (clickable to filter) */
  .card-tags { display: flex; flex-wrap: wrap; gap: .3rem; margin: 0 0 .7rem; }
  .card-tags .tag-chip { font-size: .72rem; padding: .15rem .55rem; }

  .tabs { display: flex; gap: .25rem; margin: .4rem 0 .6rem; }
  .tabs button { padding: .25rem .7rem; border: 1px solid #8886; border-radius: 999px;
    background: transparent; color: inherit; cursor: pointer; font-size: .8rem; }
  .tabs button[aria-selected=true] { background: #8882; font-weight: 600; }
  .summary { white-space: pre-wrap; font-size: .95rem; }
  .summary.zh { display: none; font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif; }
  article.bill[data-lang=zh] .summary.en { display: none; }
  article.bill[data-lang=zh] .summary.zh { display: block; }
  .empty { color: #888; text-align: center; padding: 3rem 1rem; }
  footer { color: #888; font-size: .8rem; margin-top: 3rem; text-align: center; }
  footer a { color: inherit; }
</style>
</head>
<body>
${body}
<script>
  // Per-card language toggle.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".tabs button");
    if (!btn) return;
    const card = btn.closest("article.bill");
    if (!card) return;
    const lang = btn.dataset.lang;
    card.dataset.lang = lang;
    card.querySelectorAll(".tabs button").forEach((b) => {
      b.setAttribute("aria-selected", b.dataset.lang === lang ? "true" : "false");
    });
  });
</script>
</body>
</html>`;
}

export interface RenderIndexOptions {
    bills: BillRow[];
    sortBy: "introduced_date" | "latest_action_date";
    order: "desc" | "asc";
    q: string;
    /** Currently-active tag filter, or empty string for none. */
    tag: string;
    /** All distinct tags present in the cache — used for the filter chips. */
    allTags: string[];
    total: number;
}

export function renderIndex(opts: RenderIndexOptions): string {
    const { bills, sortBy, order, q, tag, allTags, total } = opts;

    const cards = bills.length
        ? bills.map(renderBillCard).join("\n")
        : `<div class="empty">No bills match. ${tag ? `Try clearing the "${esc(tag)}" tag filter.` : "The weekly pipeline will populate this page, or an admin can trigger <code>/admin/ingest</code>."}</div>`;

    const body = `
<h1>Congress One</h1>
<p class="tagline">Plain-English &amp; 简体中文 summaries of recent U.S. Congress bills. Cached, non-partisan, one screen each.</p>

<form class="controls" method="get" action="/">
  <input type="text" name="q" placeholder="Search title…" value="${esc(q)}">
  <select name="sort">
    <option value="introduced_date" ${sortBy === "introduced_date" ? "selected" : ""}>Sort: Introduced date</option>
    <option value="latest_action_date" ${sortBy === "latest_action_date" ? "selected" : ""}>Sort: Latest action</option>
  </select>
  <select name="order">
    <option value="desc" ${order === "desc" ? "selected" : ""}>Newest first</option>
    <option value="asc" ${order === "asc" ? "selected" : ""}>Oldest first</option>
  </select>
  ${tag ? `<input type="hidden" name="tag" value="${esc(tag)}">` : ""}
  <button type="submit">Apply</button>
</form>

${renderTagFilter(allTags, tag, sortBy, order, q)}

<p class="meta">${bills.length} shown · ${total} total cached${tag ? ` · filtered by tag <strong>${esc(tag)}</strong>` : ""}</p>

${cards}

<footer>
  Source: <a href="https://api.congress.gov/">api.congress.gov</a> · Summaries generated by
  Google Gemini and cached in Cloudflare D1 · <a href="/api/bills">JSON feed</a>
</footer>
`;

    return renderLayout("Congress One — plain-language bill summaries", body);
}

/**
 * Tag filter bar. Each chip is a link that sets (or toggles off) the `tag`
 * query param while preserving the other controls (sort, order, search).
 * If nothing is tagged yet, the whole bar is hidden.
 */
function renderTagFilter(
    allTags: string[],
    activeTag: string,
    sortBy: "introduced_date" | "latest_action_date",
    order: "desc" | "asc",
    q: string,
): string {
    if (allTags.length === 0) return "";

    const base = new URLSearchParams();
    if (sortBy !== "introduced_date") base.set("sort", sortBy);
    if (order !== "desc") base.set("order", order);
    if (q) base.set("q", q);

    const linkFor = (tag: string | null): string => {
        const params = new URLSearchParams(base);
        if (tag) params.set("tag", tag);
        const qs = params.toString();
        return qs ? `/?${qs}` : "/";
    };

    const clearChip = activeTag
        ? `<a class="tag-chip clear" href="${esc(linkFor(null))}">× clear filter</a>`
        : "";

    const chips = allTags
        .map((t) => {
            const cls = t === activeTag ? "tag-chip active" : "tag-chip";
            return `<a class="${cls}" href="${esc(linkFor(t === activeTag ? null : t))}">${esc(t)}</a>`;
        })
        .join("");

    return `<div class="tag-filter">
  <p class="tag-filter-label">Filter by topic${activeTag ? ` — showing <strong>${esc(activeTag)}</strong>` : ""}:</p>
  <div class="tag-filter-chips">${clearChip}${chips}</div>
</div>`;
}

function renderBillCard(b: BillRow): string {
    const label = formatLabel(b);
    const action = b.latest_action_text
        ? `${esc(b.latest_action_date ?? "")} · ${esc(truncate(b.latest_action_text, 140))}`
        : "No recorded action yet";
    return `<article class="bill" data-lang="en">
  <h2><a href="${esc(b.source_url)}" target="_blank" rel="noopener">${esc(label)}: ${esc(b.title)}</a></h2>
  <div class="meta">
    Introduced ${esc(b.introduced_date)}${b.sponsor ? " · Sponsor: " + esc(b.sponsor) : ""}
    <br>Latest action: ${action}
  </div>
  ${renderAlerts(b)}
  ${renderCardTags(b)}
  <div class="tabs" role="tablist">
    <button data-lang="en" aria-selected="true">English</button>
    <button data-lang="zh" aria-selected="false">中文</button>
  </div>
  <div class="summary en">${esc(b.summary_en)}</div>
  <div class="summary zh">${esc(b.summary_zh)}</div>
</article>`;
}

/**
 * Citizen-impact alerts for a single bill. Returns one or more colored
 * badges (green "up" for `increase`, red "down" for `decrease`). Impacts
 * that are `null` (legacy row) or `"none"` are hidden entirely, so bills
 * with no classified impact just don't show this row at all.
 */
function renderAlerts(b: BillRow): string {
    const items: string[] = [];
    pushAlert(items, b.rights_impact, "Your rights");
    pushAlert(items, b.tax_impact, "Your taxes");
    pushAlert(items, b.benefits_impact, "Your benefits");
    if (items.length === 0) return "";
    return `<div class="alerts">${items.join("")}</div>`;
}

function pushAlert(
    sink: string[],
    direction: ImpactDirection | null,
    label: string,
): void {
    if (direction === "increase") {
        sink.push(
            `<span class="alert up" title="${esc(label)} goes up under this bill"><span class="arrow">↑</span> ${esc(label)}</span>`,
        );
    } else if (direction === "decrease") {
        sink.push(
            `<span class="alert down" title="${esc(label)} goes down under this bill"><span class="arrow">↓</span> ${esc(label)}</span>`,
        );
    }
    // "none" and null → render nothing
}

/**
 * Per-card content tag chips. Each is a link that applies that tag as the
 * page filter. Hidden when the bill has no tags (e.g. legacy rows).
 */
function renderCardTags(b: BillRow): string {
    if (!b.tags || b.tags.length === 0) return "";
    const chips = b.tags
        .map(
            (t) =>
                `<a class="tag-chip" href="/?tag=${encodeURIComponent(t)}">${esc(t)}</a>`,
        )
        .join("");
    return `<div class="card-tags">${chips}</div>`;
}

function formatLabel(b: BillRow): string {
    const t = b.bill_type.toUpperCase();
    const pretty = ({
        HR: "H.R.",
        S: "S.",
        HJRES: "H.J.Res.",
        SJRES: "S.J.Res.",
        HCONRES: "H.Con.Res.",
        SCONRES: "S.Con.Res.",
        HRES: "H.Res.",
        SRES: "S.Res.",
    } as Record<string, string>)[t] ?? t;
    return `${pretty} ${b.bill_number}`;
}

function truncate(s: string, n: number): string {
    return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

function esc(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
