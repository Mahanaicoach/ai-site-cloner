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
//   node scripts/extract/probe.mjs --route /        # every section of that manifest route, 3 loads TOTAL
//
// --route pulls each registered section's selector from docs/research/manifest.json
// (and the page URL, if no url argument is given), so one invocation probes the
// whole page instead of paying 3 page loads per section. Combines with --selector.
//
// Output: a markdown table per selector (stdout) + docs/research/<host>/probe-<name>.json
// (--route additionally writes one probe-<section>.json per section, for specs to cite)
import { readFileSync } from "node:fs";
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
const explicitSelectors = toList(args.selector);
const props = args.props ? String(args.props).split(",") : null;
const name = typeof args.name === "string" ? args.name : null;

// --route: probe every registered section of a manifest route in this one call.
let routeSections = [];
let routeUrl = null;
if (typeof args.route === "string") {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync("docs/research/manifest.json", "utf8"));
  } catch {
    console.error("No readable docs/research/manifest.json — --route needs an initialized manifest");
    process.exit(1);
  }
  const p = manifest.pages.find((p) => p.route === args.route);
  if (!p) {
    console.error(`Route ${args.route} not in manifest. Routes: ${manifest.pages.map((p) => p.route).join(", ")}`);
    process.exit(1);
  }
  routeSections = p.sections.map((s) => ({ name: s.name, selector: s.selector }));
  routeUrl = p.url;
}

const url = args._[0] || routeUrl;
const selectors = [...new Set([...explicitSelectors, ...routeSections.map((s) => s.selector)])];
if (!url || !selectors.length) {
  console.error('Usage: node scripts/extract/probe.mjs <url> --selector "css" [--selector "css2"] [--props a,b,c]  OR  probe.mjs --route </r>');
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

// One stable file per manifest section (specs cite these), plus the combined
// file when explicit selectors were passed — unchanged behavior for old callers.
for (const s of routeSections) {
  const per = Object.fromEntries(
    Object.entries(results).map(([vp, bySel]) => [vp, { [s.selector]: bySel[s.selector] }])
  );
  writeJson(`docs/research/${hostOf(url)}/probe-${slugify(s.name)}.json`, {
    url,
    selectors: [s.selector],
    generatedAt: new Date().toISOString(),
    results: per,
  });
}
if (explicitSelectors.length || !routeSections.length) {
  writeJson(`docs/research/${hostOf(url)}/probe-${name || slugify(selectors[0])}.json`, {
    url,
    selectors,
    generatedAt: new Date().toISOString(),
    results,
  });
}
