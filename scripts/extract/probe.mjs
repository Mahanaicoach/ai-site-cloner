#!/usr/bin/env node
// Probe exact computed values for specific selectors at all three viewports.
// This is what you paste into a spec's "Responsive Behavior" section — it exists
// because writing "iPad: same as desktop" makes builders guess, and guesses cost
// QA points on any site whose spacing scales with root font-size.
//
// All three viewports load concurrently on one browser.
//
// Usage:
//   node scripts/extract/probe.mjs <url> --selector "section#two" [--selector "h2" ...]
//   node scripts/extract/probe.mjs <url> --selector "#two" --props fontSize,paddingTop,marginBottom
//
// Output: a markdown table per selector (stdout) + docs/research/<host>/probe-<name>.json
import {
  VIEWPORTS,
  forEachViewport,
  closeBrowser,
  gotoAndSettle,
  autoScroll,
  hostOf,
  slugify,
  writeJson,
  parseArgs,
  toList,
} from "../lib.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args._[0];
const selectors = toList(args.selector);
const props = args.props ? String(args.props).split(",") : null;
const name = typeof args.name === "string" ? args.name : null;
if (!url || !selectors.length) {
  console.error('Usage: node scripts/extract/probe.mjs <url> --selector "css" [--selector "css2"] [--props a,b,c]');
  process.exit(1);
}

const DEFAULT_PROPS = [
  "fontSize", "fontWeight", "lineHeight", "letterSpacing",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "marginTop", "marginBottom", "width", "maxWidth",
  "display", "flexDirection", "gap", "gridTemplateColumns",
];
const USE = props || DEFAULT_PROPS;

const PROBE = `(function (selectors, props) {
  const out = {};
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) { out[sel] = { error: "not found" }; continue; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const v = { _height: Math.round(r.height) + "px", _width: Math.round(r.width) + "px" };
    for (const p of props) v[p] = cs[p];
    out[sel] = v;
  }
  return out;
})`;

const results = await forEachViewport(Object.keys(VIEWPORTS), async (page, vpName) => {
  await gotoAndSettle(page, url);
  await autoScroll(page);
  const r = await page.evaluate(`(${PROBE})(${JSON.stringify(selectors)}, ${JSON.stringify(USE)})`);
  console.error(`  ✓ probed @ ${vpName} (${VIEWPORTS[vpName].width}px)`);
  return r;
});
await closeBrowser();

// Markdown tables — only rows that actually differ across viewports are interesting,
// but print everything so the spec author can copy what matters.
for (const sel of selectors) {
  console.log(`\n### \`${sel}\`\n`);
  console.log("| property | phone (390) | ipad (768) | pc (1440) | varies |");
  console.log("| --- | --- | --- | --- | --- |");
  const keys = Object.keys(results.pc[sel] || {});
  for (const k of keys) {
    const p = results.phone[sel]?.[k] ?? "—";
    const t = results.ipad[sel]?.[k] ?? "—";
    const d = results.pc[sel]?.[k] ?? "—";
    const varies = new Set([p, t, d]).size > 1 ? "**yes**" : "";
    console.log(`| ${k} | ${p} | ${t} | ${d} | ${varies} |`);
  }
}

writeJson(`docs/research/${hostOf(url)}/probe-${name || slugify(selectors[0])}.json`, {
  url,
  selectors,
  generatedAt: new Date().toISOString(),
  results,
});
