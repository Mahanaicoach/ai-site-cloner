#!/usr/bin/env node
// Responsive check: load the page at phone (390) / iPad (768) / PC (1440) and
// record each section's layout signature at every width, plus a human-readable
// summary of what changes. Spec files fill their Responsive section from this —
// never from guessing.
//
// Usage: node scripts/extract/responsive.mjs <url> [--selector "css"]
//   (no --selector = auto-detect top-level sections: header, main children, footer)
// Output: docs/research/<host>/responsive.json
import { VIEWPORTS, launchPage, gotoAndSettle, autoScroll, hostOf, writeJson, parseArgs } from "../lib.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args._[0];
if (!url) {
  console.error('Usage: node scripts/extract/responsive.mjs <url> [--selector "css"]');
  process.exit(1);
}

// Layout signature of a section at the current viewport — runs in the page.
const SIGNATURE = `(function (selector) {
  const el = document.querySelector(selector);
  if (!el) return { error: "not found" };
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const kids = [...el.children];
  const visibleKids = kids.filter((k) => {
    const kcs = getComputedStyle(k);
    return kcs.display !== "none" && kcs.visibility !== "hidden";
  });
  // Find the container with the most visible children — that's the "grid" of the
  // section regardless of technique (grid, flex-wrap, floats, width %).
  const candidates = [el, ...el.querySelectorAll("*")].slice(0, 300);
  let gridEl = el, maxKids = 0;
  for (const c of candidates) {
    const vis = [...c.children].filter((k) => {
      const r = k.getBoundingClientRect();
      return r.width > 40 && r.height > 40 && getComputedStyle(k).display !== "none";
    });
    if (vis.length > maxKids) { maxKids = vis.length; gridEl = c; }
  }
  // Real column count = children sharing the first row (same top, ±10px)
  const gkids = [...gridEl.children].filter((k) => {
    const r = k.getBoundingClientRect();
    return r.width > 40 && r.height > 40 && getComputedStyle(k).display !== "none";
  });
  let realColumns = null;
  if (gkids.length >= 2) {
    const firstTop = gkids[0].getBoundingClientRect().top;
    realColumns = gkids.filter((k) => Math.abs(k.getBoundingClientRect().top - firstTop) < 10).length;
  }
  const gcs = getComputedStyle(gridEl);
  const h = el.querySelector("h1,h2,h3");
  return {
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    display: cs.display,
    flexDirection: cs.flexDirection,
    innerLayout: {
      display: gcs.display,
      flexDirection: gcs.flexDirection,
      flexWrap: gcs.flexWrap,
      gridColumns: gcs.gridTemplateColumns === "none" ? null : gcs.gridTemplateColumns.split(" ").length,
      realColumns,
      itemCount: gkids.length,
      gap: gcs.gap,
    },
    childCount: kids.length,
    visibleChildCount: visibleKids.length,
    hiddenChildren: kids.length - visibleKids.length,
    headingFontSize: h ? getComputedStyle(h).fontSize : null,
    paddingX: cs.paddingLeft + " / " + cs.paddingRight,
    fontSize: cs.fontSize,
  };
})`;

// Auto-detect the page's top-level sections — runs in the page.
const DETECT = `(function () {
  const sels = [];
  const push = (el, s) => { if (el && !sels.some((x) => x.selector === s)) sels.push({ selector: s, label: s }); };
  if (document.querySelector("header")) push(document.querySelector("header"), "header");
  const main = document.querySelector("main") || document.body;
  const kids = [...main.children].filter((el) => el.getBoundingClientRect().height > 80);
  kids.slice(0, 15).forEach((el, i) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + CSS.escape(el.id);
    else {
      const cls = (el.className?.toString() || "").split(" ").filter(Boolean)[0];
      if (cls) s += "." + CSS.escape(cls);
      else s = (document.querySelector("main") ? "main" : "body") + " > :nth-child(" + (i + 1) + ")";
    }
    if (document.querySelectorAll(s).length >= 1) push(el, s);
  });
  if (document.querySelector("footer")) push(document.querySelector("footer"), "footer");
  return sels;
})`;

const results = {};
let sections = null;

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  const { browser, page } = await launchPage(vp);
  await gotoAndSettle(page, url);
  await autoScroll(page);
  if (!sections) {
    sections = args.selector
      ? [{ selector: args.selector, label: args.selector }]
      : await page.evaluate(`(${DETECT})()`);
  }
  results[vpName] = {};
  for (const s of sections) {
    results[vpName][s.selector] = await page.evaluate(`(${SIGNATURE})(${JSON.stringify(s.selector)})`);
  }
  await browser.close();
  console.error(`  ✓ measured ${sections.length} sections @ ${vpName} (${vp.width}px)`);
}

// Build human-readable change summaries per section
const summarize = (sel) => {
  const p = results.phone[sel] || {};
  const t = results.ipad[sel] || {};
  const d = results.pc[sel] || {};
  const changes = [];
  const cmp = (label, a, b, aName, bName) => {
    if (a != null && b != null && a !== b) changes.push(`${label}: ${b} (${bName}) → ${a} (${aName})`);
  };
  cmp("columns", p.innerLayout?.realColumns, d.innerLayout?.realColumns, "phone", "pc");
  cmp("grid-template columns", p.innerLayout?.gridColumns, d.innerLayout?.gridColumns, "phone", "pc");
  cmp("flex direction", p.innerLayout?.flexDirection, d.innerLayout?.flexDirection, "phone", "pc");
  cmp("heading size", p.headingFontSize, d.headingFontSize, "phone", "pc");
  cmp("visible children", p.visibleChildCount, d.visibleChildCount, "phone", "pc");
  cmp("hidden children", p.hiddenChildren, d.hiddenChildren, "phone", "pc");
  cmp("padding-x", p.paddingX, d.paddingX, "phone", "pc");
  // does tablet match desktop or phone?
  const ipadLike =
    JSON.stringify(t.innerLayout) === JSON.stringify(d.innerLayout) ? "ipad matches pc layout"
    : JSON.stringify(t.innerLayout) === JSON.stringify(p.innerLayout) ? "ipad matches phone layout"
    : "ipad has its own intermediate layout";
  return { changes: changes.length ? changes : ["no layout change across viewports"], ipadBehavior: ipadLike };
};

const out = {
  url,
  generatedAt: new Date().toISOString(),
  viewports: { phone: 390, ipad: 768, pc: 1440 },
  sections: sections.map((s) => ({
    selector: s.selector,
    phone: results.phone[s.selector],
    ipad: results.ipad[s.selector],
    pc: results.pc[s.selector],
    summary: summarize(s.selector),
  })),
};
writeJson(`docs/research/${hostOf(url)}/responsive.json`, out);
console.log(
  out.sections.map((s) => `${s.selector}: ${s.summary.changes[0]}${s.summary.changes.length > 1 ? ` (+${s.summary.changes.length - 1} more)` : ""}`).join("\n")
);
