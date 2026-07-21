#!/usr/bin/env node
// Capture <canvas> content so it can actually be cloned.
//
// A canvas is pixels painted by JavaScript — there is no DOM to copy, so a
// clone that ignores it renders an empty box where the target's hero art was.
// This script closes that gap:
//
//   static canvas   → one PNG, drop it in as an <img>
//   animated canvas → a looping .webm recorded from the live page, drop it in
//                     as <video autoplay loop muted playsinline>
//
// The recording isolates the canvas (pins it to a 1:1 viewport, hides
// everything else) so the file contains the artwork and nothing else.
//
// Usage:
//   node scripts/extract/canvas.mjs <url> [--seconds 6] [--index 0] [--all]
// Output: public/images/canvas-<n>.png or public/videos/canvas-<n>.webm
//         + docs/research/<host>/canvas.json
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { VIEWPORTS, hostOf, writeJson, parseArgs } from "../lib.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args._[0];
if (!url) {
  console.error("Usage: node scripts/extract/canvas.mjs <url> [--seconds 6] [--index 0] [--all]");
  process.exit(1);
}
const SECONDS = Number(args.seconds ?? 6);
const TMP = "temp/canvas-rec";

// ── 1. Inventory every canvas on the page ─────────────────────────────
const browser = await chromium.launch();
let ctx = await browser.newContext({ viewport: VIEWPORTS.pc });
let page = await ctx.newPage();
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(3000);

const inventory = await page.evaluate(() =>
  [...document.querySelectorAll("canvas")].map((c, i) => {
    const r = c.getBoundingClientRect();
    return {
      index: i,
      cssWidth: Math.round(r.width),
      cssHeight: Math.round(r.height),
      bufferWidth: c.width,
      bufferHeight: c.height,
      x: Math.round(r.x + window.scrollX),
      y: Math.round(r.y + window.scrollY),
      className: c.className?.toString() || null,
      id: c.id || null,
      parentClasses: (c.parentElement?.className || "").toString().slice(0, 120),
    };
  })
);

if (!inventory.length) {
  console.log("No <canvas> elements on this page.");
  await browser.close();
  process.exit(0);
}
console.error(`Found ${inventory.length} canvas element(s)`);

// ── 2. Animated or static? Hash a few frames ──────────────────────────
const targets = args.all ? inventory : [inventory[Number(args.index ?? 0)]].filter(Boolean);

for (const t of targets) {
  const loc = page.locator("canvas").nth(t.index);
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(600);
  const hashes = [];
  for (let i = 0; i < 4; i++) {
    const buf = await loc.screenshot();
    hashes.push(createHash("md5").update(buf).digest("hex"));
    await page.waitForTimeout(900);
  }
  t.animated = new Set(hashes).size > 1;
  console.error(`  canvas[${t.index}] ${t.cssWidth}x${t.cssHeight} — ${t.animated ? "ANIMATED" : "static"}`);

  if (!t.animated) {
    mkdirSync("public/images", { recursive: true });
    t.output = `public/images/canvas-${t.index}.png`;
    await loc.screenshot({ path: t.output });
    t.embedAs = "img";
    console.error(`    ✓ ${t.output}`);
  }
}
await ctx.close();

// ── 3. Record the animated ones ───────────────────────────────────────
// Isolating the canvas keeps the recording free of surrounding page chrome.
const ISOLATE = `(index) => {
  const c = document.querySelectorAll("canvas")[index];
  if (!c) return null;
  const bg = getComputedStyle(document.body).backgroundColor;
  document.documentElement.style.background = bg;
  document.body.style.cssText = "margin:0;padding:0;overflow:hidden;background:" + bg;
  for (const el of document.body.querySelectorAll("*")) {
    if (el !== c && !el.contains(c)) el.style.visibility = "hidden";
  }
  c.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;visibility:visible;z-index:2147483647";
  return true;
}`;

for (const t of targets.filter((x) => x.animated)) {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const size = { width: t.cssWidth || 700, height: t.cssHeight || 700 };
  ctx = await browser.newContext({ viewport: size, recordVideo: { dir: TMP, size } });
  page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(3000);
  const ok = await page.evaluate(`(${ISOLATE})(${t.index})`);
  if (!ok) {
    console.error(`    canvas[${t.index}] vanished before recording — skipped`);
    await ctx.close();
    continue;
  }
  await page.waitForTimeout(SECONDS * 1000);
  await ctx.close(); // finalizes the video file

  const file = readdirSync(TMP).find((f) => f.endsWith(".webm"));
  if (file) {
    mkdirSync("public/videos", { recursive: true });
    t.output = `public/videos/canvas-${t.index}.webm`;
    renameSync(`${TMP}/${file}`, t.output);
    t.embedAs = "video";
    t.recordedSeconds = SECONDS;
    console.error(`    ✓ ${t.output} (${SECONDS}s loop)`);
  }
  // a poster frame keeps the first paint from being blank
  const ctx2 = await browser.newContext({ viewport: VIEWPORTS.pc });
  const p2 = await ctx2.newPage();
  await p2.goto(url, { waitUntil: "load", timeout: 60000 });
  await p2.waitForTimeout(3000);
  const l2 = p2.locator("canvas").nth(t.index);
  await l2.scrollIntoViewIfNeeded().catch(() => {});
  mkdirSync("public/images", { recursive: true });
  t.poster = `public/images/canvas-${t.index}-poster.png`;
  await l2.screenshot({ path: t.poster }).catch(() => (t.poster = null));
  await ctx2.close();
}

rmSync(TMP, { recursive: true, force: true });
await browser.close();

writeJson(`docs/research/${hostOf(url)}/canvas.json`, { url, generatedAt: new Date().toISOString(), canvases: inventory });

console.log("\nEmbed these in the component:");
for (const t of targets) {
  if (t.embedAs === "video") {
    console.log(`  canvas[${t.index}] → <video src="/${t.output.replace(/^public\//, "")}" poster="/${(t.poster || "").replace(/^public\//, "")}" autoPlay loop muted playsInline className="w-full h-full object-contain" />`);
  } else if (t.embedAs === "img") {
    console.log(`  canvas[${t.index}] → <img src="/${t.output.replace(/^public\//, "")}" alt="" className="w-full h-full object-contain" />`);
  }
}
