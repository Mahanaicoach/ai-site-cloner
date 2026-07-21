#!/usr/bin/env node
// Discover all pages of a site: sitemap.xml + same-origin links on the start page.
// Usage: node scripts/extract/crawl.mjs <url> [--max 25]
// Output: docs/research/<host>/sitemap.json
import { launchPage, gotoAndSettle, hostOf, routeOf, writeJson, parseArgs } from "../lib.mjs";

const args = parseArgs(process.argv.slice(2));
const startUrl = args._[0];
if (!startUrl) {
  console.error("Usage: node scripts/extract/crawl.mjs <url> [--max 25]");
  process.exit(1);
}
const MAX = Number(args.max ?? 25);
const origin = new URL(startUrl).origin;

// 1. Try sitemap.xml (no browser needed)
// Same-site check that tolerates www./non-www mismatches (very common)
const sameSite = (a, b) => {
  try {
    return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
};

const fromSitemap = new Set();
try {
  const res = await fetch(`${origin}/sitemap.xml`, { signal: AbortSignal.timeout(10000) });
  if (res.ok) {
    const xml = await res.text();
    let locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1].trim());
    // sitemap index → fetch child sitemaps (first 5)
    const children = locs.filter((u) => u.endsWith(".xml")).slice(0, 5);
    for (const child of children) {
      try {
        const r = await fetch(child, { signal: AbortSignal.timeout(10000) });
        if (r.ok) locs.push(...[...(await r.text()).matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1].trim()));
      } catch { /* skip broken child sitemap */ }
    }
    for (const u of locs) {
      if (sameSite(u, origin) && !u.endsWith(".xml")) fromSitemap.add(u);
    }
  }
} catch {
  // no sitemap — fine, nav links below are the primary source
}

// 2. Collect same-origin links from the rendered start page
const { browser, page } = await launchPage();
await gotoAndSettle(page, startUrl);
const links = await page.evaluate(() => {
  const inNav = (el) => !!el.closest("header, nav, footer");
  const host = location.hostname.replace(/^www\./, "");
  const seen = new Map();
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href.split("#")[0].split("?")[0];
    let linkHost;
    try {
      linkHost = new URL(href).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    if (linkHost !== host) continue;
    if (/\.(pdf|zip|jpg|jpeg|png|webp|svg|mp4|xml|ico)$/i.test(href)) continue;
    const prev = seen.get(href);
    const entry = {
      url: href,
      text: (a.textContent || "").trim().slice(0, 60),
      source: inNav(a) ? "nav" : "body",
    };
    // nav placement wins over body placement
    if (!prev || (prev.source === "body" && entry.source === "nav")) seen.set(href, entry);
  }
  return [...seen.values()];
});
await browser.close();

// 3. Merge: start page first, then nav links, then sitemap-only, then body links
const merged = new Map();
const add = (url, source, text = "") => {
  const clean = url.replace(/\/+$/, "") || origin;
  if (!merged.has(clean)) merged.set(clean, { url: clean, route: routeOf(clean), source, text });
};
add(startUrl, "start");
links.filter((l) => l.source === "nav").forEach((l) => add(l.url, "nav", l.text));
[...fromSitemap].forEach((u) => add(u, "sitemap"));
links.filter((l) => l.source === "body").forEach((l) => add(l.url, "body", l.text));

const all = [...merged.values()];
const pages = all.slice(0, MAX);
const out = {
  origin,
  startUrl,
  generatedAt: new Date().toISOString(),
  totalDiscovered: all.length,
  capped: all.length > MAX,
  pages,
  overflow: all.slice(MAX).map((p) => p.url),
};
writeJson(`docs/research/${hostOf(startUrl)}/sitemap.json`, out);
console.log(JSON.stringify({ totalDiscovered: all.length, kept: pages.length, pages: pages.map((p) => `${p.route} (${p.source})`) }, null, 2));
