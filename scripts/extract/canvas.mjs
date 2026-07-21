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
// Recording uses canvas.captureStream(), so the file holds the canvas's own
// pixels only — no page chrome, no page-load frames before the artwork appears.
//
// Usage:
//   node scripts/extract/canvas.mjs <url> [--seconds 6] [--index 0] [--all]
// Output: public/images/canvas-<n>.png or public/videos/canvas-<n>.webm
//         + docs/research/<host>/canvas.json
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { VIEWPORTS, hostOf, writeJson, parseArgs } from "../lib.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args._[0];
if (!url) {
  console.error("Usage: node scripts/extract/canvas.mjs <url> [--seconds 6] [--index 0] [--all]");
  process.exit(1);
}
const SECONDS = Number(args.seconds ?? 6);

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
// Record the canvas's own output stream rather than the viewport. Playwright's
// recordVideo starts when the context opens, so it always captures the page load
// and pre-isolation chrome ahead of the artwork; captureStream() yields exactly
// the canvas pixels, starting exactly when we say.
const CAPTURE = `async (index, ms) => {
  const c = document.querySelectorAll("canvas")[index];
  if (!c || typeof c.captureStream !== "function") return null;
  const stream = c.captureStream(30);
  const types = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mimeType) return null;
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start();
  await new Promise((r) => setTimeout(r, ms));
  rec.stop();
  await stopped;
  const bytes = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}`;

for (const t of targets.filter((x) => x.animated)) {
  // The page must render at a width where the canvas is actually visible —
  // responsive rules commonly hide hero artwork below the `lg` breakpoint.
  ctx = await browser.newContext({ viewport: VIEWPORTS.pc });
  page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(3000);
  const loc = page.locator("canvas").nth(t.index);
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(800); // let it paint before the first frame

  const b64 = await page.evaluate(`(${CAPTURE})(${t.index}, ${SECONDS * 1000})`);
  await ctx.close();

  if (b64) {
    mkdirSync("public/videos", { recursive: true });
    t.output = `public/videos/canvas-${t.index}.webm`;
    writeFileSync(t.output, Buffer.from(b64, "base64"));
    t.embedAs = "video";
    t.recordedSeconds = SECONDS;
    console.error(`    ✓ ${t.output} (${SECONDS}s loop, canvas stream)`);
  } else {
    console.error(`    canvas[${t.index}] could not be stream-captured — falling back to a still PNG`);
    const ctxF = await browser.newContext({ viewport: VIEWPORTS.pc });
    const pF = await ctxF.newPage();
    await pF.goto(url, { waitUntil: "load", timeout: 60000 });
    await pF.waitForTimeout(3000);
    mkdirSync("public/images", { recursive: true });
    t.output = `public/images/canvas-${t.index}.png`;
    await pF.locator("canvas").nth(t.index).screenshot({ path: t.output }).catch(() => (t.output = null));
    t.embedAs = t.output ? "img" : null;
    await ctxF.close();
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
