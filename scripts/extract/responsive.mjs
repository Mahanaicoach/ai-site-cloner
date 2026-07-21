#!/usr/bin/env node
// Responsive check: load the page at phone (390) / iPad (768) / PC (1440) and
// record each section's layout signature at every width, plus a human-readable
// summary of what changes. Spec files fill their Responsive section from this —
// never from guessing. Detection/measurement live in collectors.mjs.
//
// Usage: node scripts/extract/responsive.mjs <url> [--selector "css"]
//   (no --selector = auto-detect top-level sections: header, main children, footer)
// Output: docs/research/<host>/responsive.json
import { VIEWPORTS, openPage, closeBrowser, gotoAndSettle, autoScroll, hostOf, writeJson, parseArgs } from "../lib.mjs";
import { detectSections, measureSections, summarizeResponsive } from "./collectors.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args._[0];
if (!url) {
  console.error('Usage: node scripts/extract/responsive.mjs <url> [--selector "css"]');
  process.exit(1);
}

// Detect sections at PC first — desktop is the canonical layout. At phone width
// everything stacks and grows tall, which makes containers and sections
// indistinguishable by height.
const ORDER = ["pc", "ipad", "phone"].filter((v) => VIEWPORTS[v]);

// Load all three viewports concurrently — that's the slow part and the three
// loads are independent. Detection still happens on PC alone, then every
// viewport measures the same section list.
const loaded = await Promise.all(
  ORDER.map(async (vpName) => {
    const { page, close } = await openPage(VIEWPORTS[vpName]);
    await gotoAndSettle(page, url);
    await autoScroll(page);
    return { vpName, page, close };
  })
);

const pcPage = (loaded.find((l) => l.vpName === "pc") || loaded[0]).page;
const sections = args.selector
  ? [{ selector: args.selector, label: args.selector }]
  : await detectSections(pcPage);
const selectors = sections.map((s) => s.selector);

// One evaluate per viewport measures ALL sections — not one round-trip each.
const results = {};
await Promise.all(
  loaded.map(async ({ vpName, page, close }) => {
    results[vpName] = await measureSections(page, selectors);
    await close();
    console.error(`  ✓ measured ${sections.length} sections @ ${vpName} (${VIEWPORTS[vpName].width}px)`);
  })
);
await closeBrowser();

const out = {
  url,
  generatedAt: new Date().toISOString(),
  viewports: { phone: 390, ipad: 768, pc: 1440 },
  sections: sections.map((s) => ({
    selector: s.selector,
    phone: results.phone[s.selector],
    ipad: results.ipad[s.selector],
    pc: results.pc[s.selector],
    summary: summarizeResponsive(results, s.selector),
  })),
};
writeJson(`docs/research/${hostOf(url)}/responsive.json`, out);
console.log(
  out.sections.map((s) => `${s.selector}: ${s.summary.changes[0]}${s.summary.changes.length > 1 ? ` (+${s.summary.changes.length - 1} more)` : ""}`).join("\n")
);
