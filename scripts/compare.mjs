#!/usr/bin/env node
// Property-level diff between the ORIGINAL site and the CLONE for one section.
// The pixel diff (diff.mjs) says THAT a band mismatches; this says WHAT: it
// walks both live DOMs with the same collector, aligns the trees structurally
// (tag+classes, then tag-only — clone markup rarely shares the original's
// class names), and prints the differing computed properties ordered by visual
// impact (geometry > typography > color > the rest). Run it on a failing
// section BEFORE touching the spec or the component.
//
// Usage:
//   node scripts/compare.mjs --original <url> --clone <url> --selector "css"
//     [--clone-selector "css"]      when the clone uses different hooks
//     [--viewport pc|ipad|phone|all|pc,phone]   default pc
//     [--tolerance 1]               suppress px diffs ≤ this (subpixel noise)
//     [--depth 5]
//
// Output: a table per viewport (stdout) + docs/research/qa/compare-<name>-<vp>.json
import { mkdirSync } from "node:fs";
import {
  VIEWPORTS,
  openPage,
  closeBrowser,
  gotoAndSettle,
  autoScroll,
  freezePage,
  slugify,
  writeJson,
  parseArgs,
} from "./lib.mjs";
import { walkSections } from "./extract/collectors.mjs";
import { diffTrees } from "./extract/walk-format.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.original || !args.clone || !args.selector) {
  console.error('Usage: node scripts/compare.mjs --original <url> --clone <url> --selector "css" [--clone-selector css] [--viewport pc] [--tolerance 1]');
  process.exit(1);
}
const selector = String(args.selector);
const cloneSelector = args["clone-selector"] ? String(args["clone-selector"]) : selector;
const tolerance = args.tolerance !== undefined ? Number(args.tolerance) : 1;
const depth = Number(args.depth ?? 5);
const name = args.name || slugify(selector);
const vpArg = !args.viewport || args.viewport === true ? "pc" : String(args.viewport);
const vpNames = vpArg === "all" ? ["pc", "ipad", "phone"] : vpArg.split(",").map((s) => s.trim()).filter((v) => VIEWPORTS[v]);

const GEOMETRY = new Set([
  "width","height","maxWidth","minWidth","maxHeight","minHeight","aspectRatio",
  "paddingTop","paddingRight","paddingBottom","paddingLeft",
  "marginTop","marginRight","marginBottom","marginLeft",
  "top","right","bottom","left","inset","position","display",
  "flexDirection","flexWrap","justifyContent","alignItems","gap","rowGap","columnGap",
  "gridTemplateColumns","gridTemplateRows","gridAutoFlow","order","flexGrow","flexShrink","flexBasis",
  "borderTopWidth","borderBottomWidth","borderLeftWidth","borderRightWidth",
  "overflow","overflowX","overflowY","(text)",
]);
const TYPOGRAPHY = new Set([
  "fontSize","fontWeight","fontFamily","lineHeight","letterSpacing",
  "textAlign","textTransform","textDecoration","whiteSpace","textOverflow",
]);
const COLOR = new Set([
  "color","backgroundColor","backgroundImage","backgroundSize","backgroundPosition",
  "borderColor","borderStyle","boxShadow","opacity","filter","backdropFilter","mixBlendMode","borderRadius",
]);
const rank = (prop) => (GEOMETRY.has(prop) ? 0 : TYPOGRAPHY.has(prop) ? 1 : COLOR.has(prop) ? 2 : 3);
const RANK_LABEL = ["geometry", "typography", "color", "other"];

const PX = /^-?\d+(\.\d+)?px$/;
const firstFamily = (v) => String(v).split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();

// Noise filters: subpixel drift and fallback-chain-only font differences don't
// cost visible pixels — the signal is what's left.
function keep(d) {
  if (d.prop === "(classes)") return false; // clone class names legitimately differ
  const { before, after } = d;
  if (PX.test(before) && PX.test(after) && Math.abs(parseFloat(before) - parseFloat(after)) <= tolerance) return false;
  if (d.prop === "fontFamily" && firstFamily(before) === firstFamily(after)) return false;
  return true;
}

async function walkOne(url, sel, viewport) {
  const { page, close } = await openPage(viewport);
  try {
    await gotoAndSettle(page, url);
    await autoScroll(page);
    await freezePage(page); // end-state animations on both sides — deterministic values
    await page.locator(sel).first().scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    const walks = await walkSections(page, [sel], { depth });
    return walks[sel];
  } finally {
    await close();
  }
}

mkdirSync("docs/research/qa", { recursive: true });
let anyDiff = false;

for (const vp of vpNames) {
  const [orig, clone] = await Promise.all([
    walkOne(args.original, selector, VIEWPORTS[vp]),
    walkOne(args.clone, cloneSelector, VIEWPORTS[vp]),
  ]);
  if (orig?.error || clone?.error) {
    console.error(`[${vp}] ${orig?.error ? `original: ${orig.error}` : ""} ${clone?.error ? `clone: ${clone.error}` : ""}`.trim());
    anyDiff = true;
    continue;
  }
  const { changed, added, removed } = diffTrees(orig, clone);
  const diffs = changed.filter(keep).sort((a, b) => rank(a.prop) - rank(b.prop));

  console.log(`\n## ${name} @ ${vp} — ${diffs.length} differing propert${diffs.length === 1 ? "y" : "ies"}, +${added.length}/-${removed.length} nodes`);
  for (const r of removed) console.log(`- MISSING in clone: ${r.path} (${r.node.tag}${r.node.classes ? "." + r.node.classes.split(" ")[0] : ""})`);
  for (const a of added) console.log(`- EXTRA in clone: ${a.path} (${a.node.tag}${a.node.classes ? "." + a.node.classes.split(" ")[0] : ""})`);
  if (diffs.length) {
    console.log(`\n| impact | property | original | clone | node |`);
    console.log(`| --- | --- | --- | --- | --- |`);
    const cell = (s) => String(s).replace(/\|/g, "\\|").slice(0, 60);
    for (const d of diffs) {
      console.log(`| ${RANK_LABEL[rank(d.prop)]} | ${d.prop} | ${cell(d.before)} | ${cell(d.after)} | ${cell(d.path)} |`);
    }
  } else if (!added.length && !removed.length) {
    console.log(`(no property differences above ${tolerance}px tolerance — if pixels still mismatch, check images/fonts rendering, not CSS)`);
  }
  writeJson(`docs/research/qa/compare-${name}-${vp}.json`, {
    original: args.original,
    clone: args.clone,
    selector,
    cloneSelector,
    viewport: vp,
    tolerance,
    generatedAt: new Date().toISOString(),
    diffs,
    added,
    removed,
  });
  if (diffs.length || added.length || removed.length) anyDiff = true;
}

await closeBrowser();
process.exit(anyDiff ? 1 : 0);
