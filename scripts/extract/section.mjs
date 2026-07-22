#!/usr/bin/env node
// Deep-extract one or more sections: full computed-style DOM walk + verbatim
// text + assets. Optionally capture a second state (scroll/click/hover) and
// diff the two. The walker and differ live in collectors.mjs.
//
// Usage:
//   node scripts/extract/section.mjs <url> --selector "header" [--name header]
//     [--viewport pc|ipad|phone] [--depth 5]
//     [--state scroll:600 | click:.tab-btn | hover:.card]
//     [--legacy]   emit the old full-blob walk format (default: compact-v1)
//
//   --selector and --name repeat, and every section is walked from a SINGLE
//   page load. Extracting five sections is one navigation, not five:
//     node scripts/extract/section.mjs <url> \
//       --selector "#banner" --name banner \
//       --selector "#one"    --name tiles
//
// Output: docs/research/<host>/sections/<name>.json  (stateA/stateB/diff when --state used)
import {
  VIEWPORTS,
  openPage,
  closeBrowser,
  gotoAndSettle,
  autoScroll,
  transitionMs,
  hostOf,
  slugify,
  writeJson,
  parseArgs,
  toList,
} from "../lib.mjs";
import { walkSections, diffNode } from "./collectors.mjs";
import { compactWalk, toLegacy } from "./walk-format.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args._[0];
const selectors = toList(args.selector);
if (!url || !selectors.length) {
  console.error('Usage: node scripts/extract/section.mjs <url> --selector "css" [--name x] [--state scroll:600|click:sel|hover:sel]');
  console.error("       --selector/--name repeat; all sections extract from one page load.");
  process.exit(1);
}
const names = toList(args.name);
const viewport = VIEWPORTS[args.viewport || "pc"];
const depth = Number(args.depth ?? 5);
const targets = selectors.map((selector, i) => ({ selector, name: names[i] || slugify(selector) }));

const { page, close } = await openPage(viewport);
await gotoAndSettle(page, url);
await autoScroll(page);

const meta = { url, viewport: args.viewport || "pc", generatedAt: new Date().toISOString() };

// Bring every target into view first (in-view rendering settles), then walk
// them ALL in one evaluate — N sections cost one round-trip, not N.
for (const { selector } of targets) {
  await page.locator(selector).first().scrollIntoViewIfNeeded().catch(() => {});
}
const stateA = await walkSections(page, selectors, { depth });
for (const { selector } of targets) {
  if (stateA[selector].error) {
    console.error(stateA[selector].error);
    await close();
    await closeBrowser();
    process.exit(1);
  }
}

if (args.state) {
  const [kind, ...rest] = String(args.state).split(":");
  const target = rest.join(":");
  // trigger state B
  if (kind === "scroll") await page.evaluate((y) => window.scrollTo(0, Number(y)), target || "600");
  else if (kind === "click") await page.locator(target).first().click({ timeout: 5000 }).catch((e) => console.error("click failed:", e.message));
  else if (kind === "hover") await page.locator(target).first().hover({ timeout: 5000 }).catch((e) => console.error("hover failed:", e.message));

  // Wait exactly as long as the slowest transition among the targets, not a
  // flat guess. A 2.5s overlay fade used to get captured mid-flight and
  // recorded as final.
  const settle = Math.max(...(await Promise.all(targets.map((t) => transitionMs(page, t.selector)))));
  await page.waitForTimeout(settle);

  const stateB = await walkSections(page, selectors, { depth });
  for (const { selector, name } of targets) {
    const diff = [];
    diffNode(stateA[selector], stateB[selector], stateA[selector].tag, diff);
    writeJson(`docs/research/${hostOf(url)}/sections/${name}.json`, {
      ...meta,
      selector,
      trigger: args.state,
      settleMs: settle,
      stateA: stateA[selector],
      stateB: stateB[selector],
      diff,
    });
    console.log(`${name}: ${diff.length} properties changed after "${args.state}" (waited ${settle}ms)`);
  }
} else {
  for (const { selector, name } of targets) {
    const base = { ...meta, selector };
    if (args.legacy || stateA[selector]?.error) {
      writeJson(`docs/research/${hostOf(url)}/sections/${name}.json`, { ...base, tree: args.legacy ? toLegacy(stateA[selector]) : stateA[selector] });
    } else {
      const { tree, styleTable } = compactWalk(stateA[selector]);
      writeJson(`docs/research/${hostOf(url)}/sections/${name}.json`, { ...base, format: "compact-v1", tree, styleTable });
    }
  }
  console.log(`Extracted ${targets.length} section(s) from one page load.`);
}

await close();
await closeBrowser();
