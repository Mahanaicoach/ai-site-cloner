#!/usr/bin/env node
// Extract design tokens: colors (by frequency), fonts, :root CSS variables,
// radii/shadows, and global scroll behaviors (Lenis, scroll-snap, etc).
// Usage: node scripts/extract/tokens.mjs <url>
// Output: docs/research/<host>/tokens.json
// (page.mjs produces the same file as part of its one-shot recon.)
import { launchPage, gotoAndSettle, autoScroll, hostOf, writeJson, parseArgs } from "../lib.mjs";
import { collectTokens } from "./collectors.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args._[0];
if (!url) {
  console.error("Usage: node scripts/extract/tokens.mjs <url>");
  process.exit(1);
}

const { browser, page } = await launchPage();
await gotoAndSettle(page, url);
await autoScroll(page);
const tokens = await collectTokens(page);
await browser.close();

writeJson(`docs/research/${hostOf(url)}/tokens.json`, { url, generatedAt: new Date().toISOString(), ...tokens });
console.log(`Colors: ${tokens.colors.length} · Fonts: ${tokens.fontFamilies.length} · CSS vars: ${Object.keys(tokens.cssVariables).length} · @keyframes: ${Object.keys(tokens.keyframes).length} · animations in use: ${Object.keys(tokens.animationsInUse).length}`);
