#!/usr/bin/env node
// Screenshot a page (or one or more sections) at phone/iPad/PC viewports.
// All viewports render concurrently on one browser, and each viewport loads
// the page ONCE — every requested section is shot from that single load.
// Usage:
//   node scripts/extract/screenshot.mjs <url> [--selector "css" [--name hero]]...
//     [--viewports phone,ipad,pc] [--no-freeze] [--out-dir docs/design-references]
// --selector/--name are repeatable and pair up in order; a missing --name
// defaults to slugify(selector). No --selector = full-page shot per viewport.
// Output: <out-dir>/<host>/<name>-<viewport>.png
import { mkdirSync } from "node:fs";
import {
  VIEWPORTS,
  forEachViewport,
  closeBrowser,
  gotoAndSettle,
  autoScroll,
  freezePage,
  shootSectionsFromFullPage,
  writeReviewPng,
  reviewPathFor,
  hostOf,
  slugify,
  parseArgs,
  toList,
} from "../lib.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args._[0];
if (!url) {
  console.error("Usage: node scripts/extract/screenshot.mjs <url> [--selector css --name x]... [--viewports phone,ipad,pc]");
  process.exit(1);
}
const wanted = String(args.viewports || "phone,ipad,pc").split(",").filter((v) => VIEWPORTS[v]);
const selectors = toList(args.selector);
const names = toList(args.name);
// (selector, name) pairs in argv order — unnamed selectors fall back to their slug.
const shots = selectors.map((selector, i) => ({ selector, name: names[i] || slugify(selector) }));
const outDir = `${args["out-dir"] || "docs/design-references"}/${hostOf(url)}`;
mkdirSync(outDir, { recursive: true });

await forEachViewport(wanted, async (page, vp) => {
  await gotoAndSettle(page, url);
  // A full-page shot must include lazy content, so force the scroll pass here
  // even when the page shows no lazy-loading signals.
  await autoScroll(page, { force: shots.length === 0 });
  if (!args["no-freeze"]) await freezePage(page);
  if (shots.length === 0) {
    const path = `${outDir}/${names[0] || "page"}-${vp}.png`;
    await page.screenshot({ path, fullPage: true });
    writeReviewPng(path, reviewPathFor(path));
    console.log(`  ✓ ${path}`);
    return;
  }
  // One full-page capture, every section cropped from it — no per-section
  // scroll+shoot chain, and one bad selector can't slow down the others.
  const { failed } = await shootSectionsFromFullPage(page, shots, {
    pathFor: (s) => `${outDir}/${s.name}-${vp}.png`,
  });
  for (const { name } of shots) {
    if (failed.includes(name)) console.warn(`  ⚠ ${vp}: section "${name}" failed`);
    else console.log(`  ✓ ${outDir}/${name}-${vp}.png`);
  }
});

await closeBrowser();
