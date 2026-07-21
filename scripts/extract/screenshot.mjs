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
    console.log(`  ✓ ${path}`);
    return;
  }
  for (const { selector, name } of shots) {
    const path = `${outDir}/${name}-${vp}.png`;
    try {
      const loc = page.locator(selector).first();
      // Short timeouts: a bad selector should cost 3s and a warning, not
      // Playwright's default 30s before the rest of the sections get shot.
      await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
      await loc.screenshot({ path, timeout: 5000 });
      console.log(`  ✓ ${path}`);
    } catch (err) {
      // One bad selector must not kill the other sections' shots.
      console.warn(`  ⚠ ${vp}: selector "${selector}" failed — ${String(err.message || err).split("\n")[0]}`);
    }
  }
});

await closeBrowser();
