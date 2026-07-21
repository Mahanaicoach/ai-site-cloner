#!/usr/bin/env node
// Scored visual diff: original vs clone. Two modes:
//
// File mode:  node scripts/diff.mjs --a original.png --b clone.png [--out diff.png]
// Live mode:  node scripts/diff.mjs --original <url> --clone <url> [--selector css]
//               [--clone-selector css] [--viewport pc|ipad|phone|all|pc,phone] [--name hero]
//
// --selector applies to both sides; --clone-selector overrides it for the clone
// when your component's markup uses different hooks than the target's.
// --viewport takes one name, a comma list, or "all" (= pc,ipad,phone). Default: pc.
//
// Prints ONE JSON object to stdout: { name, viewports: { pc: {...}, ipad: {...} } }.
// Single-viewport and file-mode runs use the same shape with one key (file mode
// reports under "file") — a consistent shape is easier for the calling agent
// than a flat object that changes layout depending on how it was invoked.
// Each viewport carries a 10-band breakdown so the caller learns WHERE the
// mismatch lives, not just how much of it there is.
// Exit code 1 if --threshold given and ANY requested viewport is below it.
// Live-mode artifacts land in docs/research/qa/.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { VIEWPORTS, openPage, closeBrowser, gotoAndSettle, autoScroll, freezePage, slugify, parseArgs } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));

async function shoot(url, path, viewport, selector) {
  const { page, close } = await openPage(viewport);
  try {
    await gotoAndSettle(page, url);
    // Full-page shots must include lazy content; section shots need only the section.
    await autoScroll(page, { force: !selector });
    await freezePage(page); // deterministic pixels: no animations, paused videos
    if (selector) {
      const loc = page.locator(selector).first();
      await loc.scrollIntoViewIfNeeded();
      await loc.screenshot({ path });
    } else {
      await page.screenshot({ path, fullPage: true });
    }
  } finally {
    await close();
  }
  return path;
}

const BAND_COUNT = 10;

// Compare two PNGs cropped to their shared area (full-page heights rarely match
// exactly). The diff runs once per horizontal band instead of once overall:
// band-level numbers tell the caller WHICH tenth of the page drifted, and the
// total is the sum of the bands so both numbers always agree — a separate
// whole-image pass could disagree slightly at band seams, where pixelmatch's
// anti-aliasing detection loses its vertical neighbors.
function compare(pathA, pathB, outPath) {
  const imgA = PNG.sync.read(readFileSync(pathA));
  const imgB = PNG.sync.read(readFileSync(pathB));
  const width = Math.min(imgA.width, imgB.width);
  const height = Math.min(imgA.height, imgB.height);

  const diffImg = new PNG({ width, height });
  const bands = [];
  let mismatched = 0;
  for (let i = 0; i < BAND_COUNT; i++) {
    const y0 = Math.floor((height * i) / BAND_COUNT);
    const y1 = i === BAND_COUNT - 1 ? height : Math.floor((height * (i + 1)) / BAND_COUNT);
    const bandH = y1 - y0;
    const label = { band: `${i * 10}-${(i + 1) * 10}%`, yRange: `${y0}-${y1}px` };
    if (bandH <= 0) {
      // Image shorter than 10px: report the empty band as perfect instead of
      // handing pixelmatch a zero-height buffer.
      bands.push({ ...label, match: 100 });
      continue;
    }
    // bitblt straight out of the source images with a y offset — the shared-area
    // crop and the band slice are the same copy.
    const sliceA = new PNG({ width, height: bandH });
    const sliceB = new PNG({ width, height: bandH });
    const sliceDiff = new PNG({ width, height: bandH });
    PNG.bitblt(imgA, sliceA, 0, y0, width, bandH, 0, 0);
    PNG.bitblt(imgB, sliceB, 0, y0, width, bandH, 0, 0);
    const bandMismatch = pixelmatch(sliceA.data, sliceB.data, sliceDiff.data, width, bandH, { threshold: 0.1 });
    // Reassemble the band diffs into one full-size diff image at their offsets,
    // so the artifact looks identical to a single whole-image pass.
    PNG.bitblt(sliceDiff, diffImg, 0, 0, width, bandH, 0, y0);
    mismatched += bandMismatch;
    bands.push({ ...label, match: Number((100 - (bandMismatch / (width * bandH)) * 100).toFixed(2)) });
  }
  const match = 100 - (mismatched / (width * height)) * 100;
  if (outPath) writeFileSync(outPath, PNG.sync.write(diffImg));
  return {
    match: Number(match.toFixed(2)),
    mismatchedPixels: mismatched,
    width,
    height,
    originalHeight: imgA.height,
    cloneHeight: imgB.height,
    diffImage: outPath || null,
    bands,
  };
}

const results = {}; // viewport name -> compare() result
let name;

if (args.original && args.clone) {
  const vpArg = !args.viewport || args.viewport === true ? "pc" : String(args.viewport);
  const vpNames = vpArg === "all" ? ["pc", "ipad", "phone"] : vpArg.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = vpNames.filter((v) => !VIEWPORTS[v]);
  if (!vpNames.length || unknown.length) {
    console.error(`Unknown viewport(s): ${unknown.join(", ") || vpArg} — use ${Object.keys(VIEWPORTS).join(", ")}, a comma list, or "all"`);
    process.exit(1);
  }
  name = args.name || slugify(args.selector || "page");
  const dir = "docs/research/qa";
  mkdirSync(dir, { recursive: true });
  // Every (side × viewport) shot is an independent page in its own context, so
  // ALL of them run concurrently on the one shared browser — a 3-viewport run
  // costs barely more wall time than a 1-viewport run.
  await Promise.all(
    vpNames.flatMap((vp) => [
      shoot(args.original, `${dir}/${name}-${vp}-original.png`, VIEWPORTS[vp], args.selector),
      shoot(args.clone, `${dir}/${name}-${vp}-clone.png`, VIEWPORTS[vp], args["clone-selector"] || args.selector),
    ])
  );
  await closeBrowser();
  for (const vp of vpNames) {
    // --out keeps its old single-run meaning; multi-viewport runs would clobber
    // one file with every diff, so they always use the per-viewport path.
    const outPath = vpNames.length === 1 && args.out ? args.out : `${dir}/${name}-${vp}-diff.png`;
    results[vp] = compare(`${dir}/${name}-${vp}-original.png`, `${dir}/${name}-${vp}-clone.png`, outPath);
  }
} else if (args.a && args.b) {
  name = args.name || "file";
  results.file = compare(args.a, args.b, args.out || null);
} else {
  console.error("Usage: diff.mjs --a orig.png --b clone.png  OR  --original <url> --clone <url> [--selector css] [--viewport pc|ipad|phone|all|pc,phone]");
  process.exit(1);
}

console.log(JSON.stringify({ name, viewports: results }, null, 2));

for (const [vp, r] of Object.entries(results)) {
  const worst = r.bands.reduce((w, b) => (b.match < w.match ? b : w));
  const heightNote =
    r.originalHeight !== r.cloneHeight
      ? ` · HEIGHT MISMATCH: original ${r.originalHeight}px vs clone ${r.cloneHeight}px (compared top ${r.height}px)`
      : "";
  console.error(`[${vp}] Match: ${r.match.toFixed(2)}% · worst band: ${worst.band} (y ${worst.yRange}) at ${worst.match}%${heightNote}`);
}

if (args.threshold) {
  const t = Number(args.threshold);
  let failed = false;
  for (const [vp, r] of Object.entries(results)) {
    if (r.match < t) {
      console.error(`FAIL [${vp}]: ${r.match}% below threshold ${t}%`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
}
