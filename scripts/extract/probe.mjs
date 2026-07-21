#!/usr/bin/env node
// Probe exact computed values for specific selectors at all three viewports.
// This is what you paste into a spec's "Responsive Behavior" section — it exists
// because writing "iPad: same as desktop" makes builders guess, and guesses cost
// QA points on any site whose spacing scales with root font-size.
//
// Usage:
//   node scripts/extract/probe.mjs <url> --selector "section#two" [--selector "h2" ...]
//   node scripts/extract/probe.mjs <url> --selector "#two" --props fontSize,paddingTop,marginBottom
//
// Output: a markdown table per selector (stdout) + docs/research/<host>/probe-<name>.json
import { VIEWPORTS, launchPage, gotoAndSettle, autoScroll, hostOf, slugify, writeJson } from "../lib.mjs";

// --selector can repeat, so parse args manually rather than with parseArgs()
const argv = process.argv.slice(2);
const url = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true);
const selectors = [];
let props = null;
let name = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--selector") selectors.push(argv[++i]);
  else if (argv[i] === "--props") props = argv[++i].split(",");
  else if (argv[i] === "--name") name = argv[++i];
}
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

const results = {};
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  const { browser, page } = await launchPage(vp);
  await gotoAndSettle(page, url);
  await autoScroll(page);
  results[vpName] = await page.evaluate(`(${PROBE})(${JSON.stringify(selectors)}, ${JSON.stringify(USE)})`);
  await browser.close();
  console.error(`  ✓ probed @ ${vpName} (${vp.width}px)`);
}

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
