#!/usr/bin/env node
// Screenshot a page (or one section) at phone/iPad/PC viewports.
// Usage:
//   node scripts/extract/screenshot.mjs <url> [--name hero] [--selector "css"]
//     [--viewports phone,ipad,pc] [--no-freeze] [--out-dir docs/design-references]
// Output: <out-dir>/<host>/<name>-<viewport>.png
import { mkdirSync } from "node:fs";
import { VIEWPORTS, launchPage, gotoAndSettle, autoScroll, freezePage, hostOf, slugify, parseArgs } from "../lib.mjs";

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

for (const vp of wanted) {
  const { browser, page } = await launchPage(VIEWPORTS[vp]);
  await gotoAndSettle(page, url);
  await autoScroll(page); // lazy content must be loaded before a full-page shot
  if (!args["no-freeze"]) await freezePage(page);
  const path = `${outDir}/${name}-${vp}.png`;
  if (args.selector) {
    const loc = page.locator(args.selector).first();
    await loc.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await loc.screenshot({ path });
  } else {
    await page.screenshot({ path, fullPage: true });
  }
  console.log(`  ✓ ${path}`);
  await browser.close();
}
