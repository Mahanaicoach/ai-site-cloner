#!/usr/bin/env node
// Scrape the target's ACTUAL CSS rules — not just computed styles.
//
// Computed styles only tell you how an element looks right now. The stylesheet
// tells you every state it can be in: :hover, :focus, :active, media queries,
// keyframes. Reading the rules catches interactions you'd never think to probe.
// All the parsing lives in collectors.mjs — this file is just the CLI.
//
// Usage:
//   node scripts/extract/css.mjs <url>                      # whole-page rule dump
//   node scripts/extract/css.mjs <url> --selector "nav a"   # + exact matched rules
//                                                             for that element (via CDP,
//                                                             same data as the DevTools
//                                                             Styles panel, incl. :hover)
// Output: docs/research/<host>/css.json  (+ a summary to stdout)
import { launchPage, gotoAndSettle, autoScroll, hostOf, writeJson, parseArgs } from "../lib.mjs";
import { collectCss } from "./collectors.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args._[0];
if (!url) {
  console.error('Usage: node scripts/extract/css.mjs <url> [--selector "css"]');
  process.exit(1);
}

const { browser, page } = await launchPage();
await gotoAndSettle(page, url);
await autoScroll(page);

const css = await collectCss(page, { selector: args.selector || null });
await browser.close();

// The counts drive the stdout summary only — they're derivable from the JSON,
// so persisting them would just be two more fields to keep in sync.
const { interactiveCount, blockedCount, ...persisted } = css;
writeJson(`docs/research/${hostOf(url)}/css.json`, {
  url,
  generatedAt: new Date().toISOString(),
  ...persisted,
});

console.log(
  `Stylesheets: ${css.stylesheets.length} (${blockedCount} unreadable) · rules: ${css.totalRules} · interactive-state rules: ${interactiveCount}`
);
console.log(`States found: ${Object.entries(css.interactiveStates).map(([k, v]) => `${k}=${v.length}`).join(" · ") || "none"}`);
console.log(`Breakpoints: ${css.breakpoints.join(", ") || "none"}`);
if (css.keyframeNames.length) console.log(`@keyframes: ${css.keyframeNames.join(", ")}`);
if (blockedCount) console.log(`NOTE: ${blockedCount} stylesheet(s) could not be read or fetched — hover rules from those are missing.`);
if (css.matched) console.log(`Matched rules for "${args.selector}": ${css.matched.matchedRules.length}`);
