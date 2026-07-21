#!/usr/bin/env node
// Scored visual diff: original vs clone. Two modes:
//
// File mode:  node scripts/diff.mjs --a original.png --b clone.png [--out diff.png]
// Live mode:  node scripts/diff.mjs --original <url> --clone <url> [--selector css]
//               [--viewport pc|ipad|phone] [--name hero]
//
// Prints a match % (higher = closer). Exit code 1 if --threshold given and not met.
// Live-mode artifacts land in docs/research/qa/.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { VIEWPORTS, launchPage, gotoAndSettle, autoScroll, freezePage, slugify, parseArgs } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));

async function shoot(url, path, viewport, selector) {
  const { browser, page } = await launchPage(viewport);
  await gotoAndSettle(page, url);
  await autoScroll(page);
  await freezePage(page); // deterministic pixels: no animations, paused videos
  if (selector) {
    const loc = page.locator(selector).first();
    await loc.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await loc.screenshot({ path });
  } else {
    await page.screenshot({ path, fullPage: true });
  }
  await browser.close();
  return path;
}

let fileA = args.a;
let fileB = args.b;
let outPath = args.out;

if (args.original && args.clone) {
  const vp = args.viewport || "pc";
  const name = args.name || slugify(args.selector || "page");
  const dir = "docs/research/qa";
  mkdirSync(dir, { recursive: true });
  fileA = await shoot(args.original, `${dir}/${name}-${vp}-original.png`, VIEWPORTS[vp], args.selector);
  fileB = await shoot(args.clone, `${dir}/${name}-${vp}-clone.png`, VIEWPORTS[vp], args.selector);
  outPath = outPath || `${dir}/${name}-${vp}-diff.png`;
}
if (!fileA || !fileB) {
  console.error("Usage: diff.mjs --a orig.png --b clone.png  OR  --original <url> --clone <url> [--selector css] [--viewport pc]");
  process.exit(1);
}

const imgA = PNG.sync.read(readFileSync(fileA));
const imgB = PNG.sync.read(readFileSync(fileB));

// Crop both to the shared area (full-page heights rarely match exactly)
const width = Math.min(imgA.width, imgB.width);
const height = Math.min(imgA.height, imgB.height);
function crop(img) {
  if (img.width === width && img.height === height) return img;
  const out = new PNG({ width, height });
  PNG.bitblt(img, out, 0, 0, width, height, 0, 0);
  return out;
}
const a = crop(imgA);
const b = crop(imgB);
const diffImg = new PNG({ width, height });
const mismatched = pixelmatch(a.data, b.data, diffImg.data, width, height, { threshold: 0.1 });
const match = 100 - (mismatched / (width * height)) * 100;

if (outPath) {
  writeFileSync(outPath, PNG.sync.write(diffImg));
}
const heightNote =
  imgA.height !== imgB.height ? ` · HEIGHT MISMATCH: original ${imgA.height}px vs clone ${imgB.height}px (compared top ${height}px)` : "";
console.log(
  JSON.stringify(
    { match: Number(match.toFixed(2)), mismatchedPixels: mismatched, width, height, originalHeight: imgA.height, cloneHeight: imgB.height, diffImage: outPath || null },
    null,
    2
  )
);
console.error(`Match: ${match.toFixed(2)}%${heightNote}`);

if (args.threshold && match < Number(args.threshold)) {
  console.error(`FAIL: below threshold ${args.threshold}%`);
  process.exit(1);
}
