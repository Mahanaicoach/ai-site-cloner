#!/usr/bin/env node
// Screenshot a page (or one section) at phone/iPad/PC viewports.
// All viewports render concurrently on one browser.
// Usage:
//   node scripts/extract/screenshot.mjs <url> [--name hero] [--selector "css"]
//     [--viewports phone,ipad,pc] [--no-freeze] [--out-dir docs/design-references]
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
} from "../lib.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args._[0];
if (!url) {
  console.error("Usage: node scripts/extract/screenshot.mjs <url> [--selector css] [--name x] [--viewports phone,ipad,pc]");
  process.exit(1);
}
const wanted = String(args.viewports || "phone,ipad,pc").split(",").filter((v) => VIEWPORTS[v]);
const name = args.name || (args.selector ? slugify(args.selector) : "page");
const outDir = `${args["out-dir"] || "docs/design-references"}/${hostOf(url)}`;
mkdirSync(outDir, { recursive: true });

await forEachViewport(wanted, async (page, vp) => {
  await gotoAndSettle(page, url);
  // A full-page shot must include lazy content, so force the scroll pass here
  // even when the page shows no lazy-loading signals.
  await autoScroll(page, { force: !args.selector });
  if (!args["no-freeze"]) await freezePage(page);
  const path = `${outDir}/${name}-${vp}.png`;
  if (args.selector) {
    const loc = page.locator(args.selector).first();
    await loc.scrollIntoViewIfNeeded();
    await loc.screenshot({ path });
  } else {
    await page.screenshot({ path, fullPage: true });
  }
  console.log(`  ✓ ${path}`);
});

await closeBrowser();
