#!/usr/bin/env node
// Enumerate and download every asset on a page: <img> (incl. layered/overlay),
// <video>, CSS background images, inline SVGs, favicons/OG images, fonts.
// Enumeration and downloading live in collectors.mjs — this file is just the CLI.
// Usage: node scripts/extract/assets.mjs <url> [--no-download]
// Output: docs/research/<host>/assets.json + files in public/
import { launchPage, gotoAndSettle, autoScroll, hostOf, writeJson, parseArgs } from "../lib.mjs";
import { collectAssets, downloadAssets } from "./collectors.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args._[0];
if (!url) {
  console.error("Usage: node scripts/extract/assets.mjs <url> [--no-download]");
  process.exit(1);
}
const doDownload = !args["no-download"];

const { browser, page } = await launchPage();
await gotoAndSettle(page, url);
await autoScroll(page); // trigger lazy loading

const found = await collectAssets(page);
await browser.close(); // downloads go over plain fetch — no browser needed

const manifest = doDownload ? await downloadAssets(found, { pool: 8 }) : [];

writeJson(`docs/research/${hostOf(url)}/assets.json`, {
  url,
  generatedAt: new Date().toISOString(),
  ...found,
  downloads: manifest,
});

const okCount = manifest.filter((m) => m.ok).length;
const failCount = manifest.filter((m) => !m.ok).length;
const cachedCount = manifest.filter((m) => m.cached).length;
console.log(
  `Images: ${found.images.length} · BG images: ${found.backgroundImages.length} · SVG rasters: ${found.svgImages.length} · Videos: ${found.videos.length} · SVGs: ${found.inlineSvgs.length} · Fonts: ${found.fonts.length}` +
    (doDownload
      ? ` · Downloaded: ${okCount} ok${cachedCount ? ` (${cachedCount} already on disk)` : ""}, ${failCount} failed`
      : " · (download skipped)")
);
if (failCount > 0) console.log("Failed downloads listed in assets.json — retry or fetch manually.");
