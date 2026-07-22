#!/usr/bin/env node
// Scored visual diff: original vs clone. Three modes:
//
// File mode:    node scripts/diff.mjs --a original.png --b clone.png [--out diff.png]
// Live mode:    node scripts/diff.mjs --original <url> --clone <url> [--selector css]
//                 [--clone-selector css] [--viewport pc|ipad|phone|all|pc,phone] [--name hero]
// Batched mode: node scripts/diff.mjs --original <url> --clone <url> --viewport all
//                 --section hero=section.hero --section features=#features
//                 (or --route / to pull every section of that route from the manifest)
//
// Triage mode:  node scripts/diff.mjs --original <url> --clone <url> --route /
//                 --triage --viewport all
//               Whole-page diff FIRST per viewport; a passing viewport (match +
//               every band ≥ threshold, heights agree) skips its per-section
//               diffs entirely, a failing one per-section-diffs ONLY the
//               sections overlapping the failing bands. Sections it never
//               touched get an inferred score (worst overlapping page band).
//               This is the default QA sweep — a good clone costs 2 loads per
//               viewport instead of 2 + 2×N.
//
// Batched mode loads each side ONCE per viewport and screenshots every section
// from that load — an 8-section sweep costs 6 page loads instead of 48. Use it
// when you want individual scores for every section regardless of page result;
// fix iterations should stay single-section.
//
// The original side of a live/batched run is cached: a PNG + .meta.json sidecar
// under docs/research/qa/ is reused when the url/selector/viewport match and the
// shot is <24h old, so fix iterations only re-render the clone. --fresh-original
// forces a re-shoot (use it if the live site itself changed mid-run).
//
// --selector applies to both sides; --clone-selector overrides it for the clone
// when your component's markup uses different hooks than the target's. Batched
// mode applies each section's selector to both sides (fall back to single mode
// for per-side selector overrides).
// --viewport takes one name, a comma list, or "all" (= pc,ipad,phone). Default: pc.
//
// Prints ONE JSON object to stdout:
//   live/file:  { name, viewports: { pc: {...}, ipad: {...} } }
//   batched:    { route, sections: { hero: { viewports: {...} }, ... } }
// Each viewport carries a 10-band breakdown so the caller learns WHERE the
// mismatch lives, not just how much of it there is.
// Exit code 1 if --threshold given and ANY requested viewport (any section) is below it.
// Live-mode artifacts land in docs/research/qa/.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import {
  VIEWPORTS,
  openPage,
  closeBrowser,
  gotoAndSettle,
  autoScroll,
  freezePage,
  shootSectionsFromFullPage,
  writeReviewPng,
  reviewPathFor,
  slugify,
  parseArgs,
  toList,
} from "./lib.mjs";
import { selfReport, findPage, findSection, advanceStage, updatePageStatus } from "./manifest-lib.mjs";

const args = parseArgs(process.argv.slice(2));

const DIR = "docs/research/qa";
const ORIGINAL_FRESH_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------------------
// Original-side shot cache. The original site never changes between QA fix
// iterations, so re-rendering it every time was pure waste. The sidecar (not
// the filename) is the invalidation key — it catches a reused --name pointing
// at a different url/selector/viewport.
// ---------------------------------------------------------------------------
const metaPathFor = (pngPath) => pngPath.replace(/\.png$/, ".meta.json");

function originalCached(pngPath, url, viewport, selector) {
  if (args["fresh-original"]) return false;
  try {
    const m = JSON.parse(readFileSync(metaPathFor(pngPath), "utf8"));
    return (
      existsSync(pngPath) &&
      m.url === url &&
      (m.selector || null) === (selector || null) &&
      m.viewport?.width === viewport.width &&
      m.viewport?.height === viewport.height &&
      Date.now() - m.capturedAt < ORIGINAL_FRESH_MS
    );
  } catch {
    return false;
  }
}

function writeOriginalMeta(pngPath, url, viewport, selector) {
  writeFileSync(
    metaPathFor(pngPath),
    JSON.stringify({ url, selector: selector || null, viewport, capturedAt: Date.now() }, null, 2) + "\n"
  );
}

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

// Whole-page shot for triage mode; optionally measures each selector's page-Y
// box from the same load, so failing diff bands can be mapped to the sections
// that occupy them without any extra navigation.
async function shootPageWithBoxes(url, path, viewport, selectors = null) {
  const { page, close } = await openPage(viewport);
  try {
    await gotoAndSettle(page, url);
    await autoScroll(page, { force: true });
    await freezePage(page);
    await page.screenshot({ path, fullPage: true });
    if (!selectors) return null;
    return await page.evaluate((sels) => {
      window.scrollTo(0, 0);
      const out = {};
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) {
          out[sel] = null;
          continue;
        }
        const r = el.getBoundingClientRect();
        out[sel] = { y: Math.round(r.y + scrollY), h: Math.round(r.height) };
      }
      return out;
    }, selectors);
  } finally {
    await close();
  }
}

// Batched capture: one load, one forced scroll, one freeze — then every section
// cropped out of ONE full-page screenshot (pixel-identical to a per-section
// locator chain, minus N scroll+shoot round-trips). A section the crop can't
// produce falls back to a locator shot inside the helper; anything neither
// path captures is reported and skipped, not fatal.
async function shootSectionsOnce(url, viewport, sections, pathFor) {
  const { page, close } = await openPage(viewport);
  const captured = {};
  try {
    await gotoAndSettle(page, url);
    await autoScroll(page, { force: true });
    await freezePage(page);
    const { failed } = await shootSectionsFromFullPage(page, sections, {
      pathFor: (s) => pathFor(s.name),
      review: false, // QA captures feed pixelmatch, not eyes
    });
    for (const { name } of sections) captured[name] = !failed.includes(name);
    for (const name of failed) console.error(`  ! section shot failed: ${name} @ ${viewport.width}px`);
  } finally {
    await close();
  }
  return captured;
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

// --section name=css (repeatable) plus --route </r> (reads the manifest).
function parseSections() {
  const out = [];
  for (const item of toList(args.section).map(String)) {
    const eq = item.indexOf("=");
    if (eq < 1) {
      console.error(`Bad --section "${item}" — use --section name=css-selector`);
      process.exit(1);
    }
    out.push({ name: slugify(item.slice(0, eq).trim()), selector: item.slice(eq + 1).trim() });
  }
  if (args.route && args.route !== true) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync("docs/research/manifest.json", "utf8"));
    } catch {
      console.error("No readable docs/research/manifest.json — --route needs an initialized manifest");
      process.exit(1);
    }
    const p = manifest.pages.find((p) => p.route === args.route);
    if (!p) {
      console.error(`Route ${args.route} not in manifest. Routes: ${manifest.pages.map((p) => p.route).join(", ")}`);
      process.exit(1);
    }
    for (const s of p.sections) {
      const name = slugify(s.name);
      if (!out.some((o) => o.name === name)) out.push({ name, selector: s.selector });
    }
  }
  return out;
}

function parseViewports() {
  const vpArg = !args.viewport || args.viewport === true ? "pc" : String(args.viewport);
  const vpNames = vpArg === "all" ? ["pc", "ipad", "phone"] : vpArg.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = vpNames.filter((v) => !VIEWPORTS[v]);
  if (!vpNames.length || unknown.length) {
    console.error(`Unknown viewport(s): ${unknown.join(", ") || vpArg} — use ${Object.keys(VIEWPORTS).join(", ")}, a comma list, or "all"`);
    process.exit(1);
  }
  return vpNames;
}

let output; // final stdout JSON
const flat = []; // [scope, viewportName, result] for the stderr summary + threshold

// Manifest self-report shared by batched and triage modes: record per-viewport
// scores and advance qa_passed when all three viewports clear the threshold.
function reportScores(route, sections, sectionResults, vpNames) {
  if (!route) return;
  const qaThreshold = args.threshold ? Number(args.threshold) : 95;
  let scored = 0, passed = 0;
  selfReport((m) => {
    const p = findPage(m, route);
    if (!p) return false;
    let changed = false;
    for (const s of sections) {
      const sec = findSection(p, s.name);
      if (!sec) continue;
      for (const vp of vpNames) {
        const r = sectionResults[s.name]?.viewports[vp];
        if (r && !r.error && typeof r.match === "number") {
          sec.scores[vp] = r.match;
          changed = true;
          scored++;
        }
      }
      if (["pc", "ipad", "phone"].every((v) => typeof sec.scores[v] === "number" && sec.scores[v] >= qaThreshold)) {
        if (advanceStage(sec, "qa_passed")) passed++;
        changed = true;
      }
    }
    if (changed) updatePageStatus(p);
    return changed;
  });
  if (scored) console.error(`  ✓ manifest: ${scored} score(s) recorded${passed ? `, ${passed} section(s) → qa_passed` : ""}`);
}

if (args.original && args.clone) {
  const vpNames = parseViewports();
  mkdirSync(DIR, { recursive: true });
  const sections = parseSections();

  if (args.triage && sections.length) {
    // ── Triage mode: whole-page first, sections only where the page fails ──
    // A passing viewport (match ≥ threshold, every band ≥ threshold, heights
    // agree) proves its sections without N per-section diffs. A failing one
    // names the bands that failed; only sections overlapping those bands get
    // individually diffed. Untouched sections receive an inferred score (the
    // worst page band they overlap) so the manifest still fills in.
    const thr = args.threshold ? Number(args.threshold) : 95;
    const routeSlug = slugify(String(args.route || "page"));
    const sectionResults = {};
    for (const s of sections) sectionResults[s.name] = { viewports: {} };
    const triage = {};

    await Promise.all(
      vpNames.map(async (vp) => {
        const viewport = VIEWPORTS[vp];
        const origPath = `${DIR}/page-${routeSlug}-${vp}-original.png`;
        const clonePath = `${DIR}/page-${routeSlug}-${vp}-clone.png`;
        const cloneJob = shootPageWithBoxes(args.clone, clonePath, viewport, sections.map((s) => s.selector));
        let origJob = Promise.resolve();
        if (originalCached(origPath, args.original, viewport, null)) {
          console.error(`  reusing cached original page shot [${vp}]`);
        } else {
          origJob = shootPageWithBoxes(args.original, origPath, viewport).then(() =>
            writeOriginalMeta(origPath, args.original, viewport, null)
          );
        }
        const [boxes] = await Promise.all([cloneJob, origJob]);
        const r = compare(origPath, clonePath, `${DIR}/page-${routeSlug}-${vp}-diff.png`);
        flat.push([`page${args.route && args.route !== true ? args.route : ""}`, vp, r]);

        const heightOk = Math.abs(r.originalHeight - r.cloneHeight) <= Math.max(8, r.originalHeight * 0.005);
        const bandY = (i) => [
          Math.floor((r.height * i) / BAND_COUNT),
          i === BAND_COUNT - 1 ? r.height : Math.floor((r.height * (i + 1)) / BAND_COUNT),
        ];
        const failing = r.bands.map((b, i) => ({ ...b, i })).filter((b) => b.match < thr);
        const pass = r.match >= thr && heightOk && !failing.length;

        const overlapsFailing = (sel) => {
          const box = boxes?.[sel];
          // Not locatable — or matching a zero-height element (Next.js injects
          // empty divs at the top of <body>, so a positional selector can hit
          // one) — means the box proves nothing: don't guess, diff the section.
          if (!box || box.h < 1) return true;
          return failing.some((b) => {
            const [y0, y1] = bandY(b.i);
            return box.y < y1 && box.y + box.h > y0;
          });
        };
        const need = pass ? [] : sections.filter((s) => overlapsFailing(s.selector));
        triage[vp] = { page: r, pass, heightOk, failingBands: failing.map((b) => b.band), sectionsDiffed: need.map((s) => s.name) };

        const needNames = new Set(need.map((s) => s.name));
        for (const s of sections) {
          if (needNames.has(s.name)) continue;
          const box = boxes?.[s.selector];
          if (!box || box.h < 1) continue;
          const overlapped = r.bands.filter((_, i) => {
            const [y0, y1] = bandY(i);
            return box.y < y1 && box.y + box.h > y0;
          });
          if (!overlapped.length) continue;
          sectionResults[s.name].viewports[vp] = {
            match: Math.min(...overlapped.map((b) => b.match)),
            inferred: "worst overlapping page band",
          };
        }

        if (need.length) {
          const origPathFor = (n) => `${DIR}/${n}-${vp}-original.png`;
          const jobs = [shootSectionsOnce(args.clone, viewport, need, (n) => `${DIR}/${n}-${vp}-clone.png`)];
          const missing = need.filter((s) => !originalCached(origPathFor(s.name), args.original, viewport, s.selector));
          if (missing.length) {
            jobs.push(
              shootSectionsOnce(args.original, viewport, need, origPathFor).then((captured) => {
                for (const s of need) {
                  if (captured[s.name]) writeOriginalMeta(origPathFor(s.name), args.original, viewport, s.selector);
                }
              })
            );
          }
          await Promise.all(jobs);
          for (const s of need) {
            const a = origPathFor(s.name);
            const b = `${DIR}/${s.name}-${vp}-clone.png`;
            if (!existsSync(a) || !existsSync(b)) {
              sectionResults[s.name].viewports[vp] = { error: `missing ${!existsSync(a) ? "original" : "clone"} shot` };
              flat.push([s.name, vp, null]);
              continue;
            }
            const sr = compare(a, b, `${DIR}/${s.name}-${vp}-diff.png`);
            sectionResults[s.name].viewports[vp] = sr;
            flat.push([s.name, vp, sr]);
          }
        }
      })
    );
    await closeBrowser();
    output = { route: args.route && args.route !== true ? args.route : null, triage, sections: sectionResults };
    reportScores(output.route, sections, sectionResults, vpNames);
  } else if (sections.length) {
    // Batched mode: per (side × viewport) ONE load covers every section. All six
    // loads run concurrently on the shared browser.
    await Promise.all(
      vpNames.flatMap((vp) => {
        const origPathFor = (n) => `${DIR}/${n}-${vp}-original.png`;
        const jobs = [
          shootSectionsOnce(args.clone, VIEWPORTS[vp], sections, (n) => `${DIR}/${n}-${vp}-clone.png`),
        ];
        const missing = sections.filter((s) => !originalCached(origPathFor(s.name), args.original, VIEWPORTS[vp], s.selector));
        if (missing.length) {
          // Re-shoot ALL sections from the one load (marginal cost ~0) so every
          // sidecar carries the same capture time.
          jobs.push(
            shootSectionsOnce(args.original, VIEWPORTS[vp], sections, origPathFor).then((captured) => {
              for (const s of sections) {
                if (captured[s.name]) writeOriginalMeta(origPathFor(s.name), args.original, VIEWPORTS[vp], s.selector);
              }
            })
          );
        } else {
          console.error(`  reusing ${sections.length} cached original shots [${vp}]`);
        }
        return jobs;
      })
    );
    await closeBrowser();
    const sectionResults = {};
    for (const s of sections) {
      sectionResults[s.name] = { viewports: {} };
      for (const vp of vpNames) {
        const a = `${DIR}/${s.name}-${vp}-original.png`;
        const b = `${DIR}/${s.name}-${vp}-clone.png`;
        if (!existsSync(a) || !existsSync(b)) {
          sectionResults[s.name].viewports[vp] = { error: `missing ${!existsSync(a) ? "original" : "clone"} shot` };
          flat.push([s.name, vp, null]);
          continue;
        }
        const r = compare(a, b, `${DIR}/${s.name}-${vp}-diff.png`);
        sectionResults[s.name].viewports[vp] = r;
        flat.push([s.name, vp, r]);
      }
    }
    output = { route: args.route && args.route !== true ? args.route : null, sections: sectionResults };
    reportScores(output.route, sections, sectionResults, vpNames);
  } else {
    // Single live mode.
    const name = args.name || slugify(args.selector || "page");
    await Promise.all(
      vpNames.flatMap((vp) => {
        const origPath = `${DIR}/${name}-${vp}-original.png`;
        const jobs = [shoot(args.clone, `${DIR}/${name}-${vp}-clone.png`, VIEWPORTS[vp], args["clone-selector"] || args.selector)];
        if (originalCached(origPath, args.original, VIEWPORTS[vp], args.selector)) {
          console.error(`  reusing original ${name}-${vp}-original.png`);
        } else {
          jobs.push(
            shoot(args.original, origPath, VIEWPORTS[vp], args.selector).then(() =>
              writeOriginalMeta(origPath, args.original, VIEWPORTS[vp], args.selector)
            )
          );
        }
        return jobs;
      })
    );
    await closeBrowser();
    const results = {};
    for (const vp of vpNames) {
      // --out keeps its old single-run meaning; multi-viewport runs would clobber
      // one file with every diff, so they always use the per-viewport path.
      const outPath = vpNames.length === 1 && args.out ? args.out : `${DIR}/${name}-${vp}-diff.png`;
      results[vp] = compare(`${DIR}/${name}-${vp}-original.png`, `${DIR}/${name}-${vp}-clone.png`, outPath);
      flat.push([name, vp, results[vp]]);
    }
    output = { name, viewports: results };
  }
} else if (args.a && args.b) {
  const name = args.name || "file";
  const r = compare(args.a, args.b, args.out || null);
  flat.push([name, "file", r]);
  output = { name, viewports: { file: r } };
} else {
  console.error(
    "Usage: diff.mjs --a orig.png --b clone.png  OR  --original <url> --clone <url> [--selector css | --section name=css ... | --route /] [--viewport pc|ipad|phone|all|pc,phone]"
  );
  process.exit(1);
}

console.log(JSON.stringify(output, null, 2));

for (const [scope, vp, r] of flat) {
  if (!r) {
    console.error(`[${scope} ${vp}] NOT CAPTURED`);
    continue;
  }
  const worst = r.bands.reduce((w, b) => (b.match < w.match ? b : w));
  const heightNote =
    r.originalHeight !== r.cloneHeight
      ? ` · HEIGHT MISMATCH: original ${r.originalHeight}px vs clone ${r.cloneHeight}px (compared top ${r.height}px)`
      : "";
  // Failing diffs get a 640px review copy — that's the image an agent opens to
  // inspect the failing band; the full-res artifact stays for pixel work.
  let reviewNote = "";
  if (r.match < 95 && r.diffImage && writeReviewPng(r.diffImage, reviewPathFor(r.diffImage))) {
    reviewNote = ` · review: ${reviewPathFor(r.diffImage)}`;
  }
  console.error(`[${scope} ${vp}] Match: ${r.match.toFixed(2)}% · worst band: ${worst.band} (y ${worst.yRange}) at ${worst.match}%${heightNote}${reviewNote}`);
}

if (args.threshold) {
  const t = Number(args.threshold);
  let failed = false;
  for (const [scope, vp, r] of flat) {
    if (!r || r.match < t) {
      console.error(`FAIL [${scope} ${vp}]: ${r ? `${r.match}%` : "not captured"} below threshold ${t}%`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
}
