#!/usr/bin/env node
// Responsive check: load the page at phone (390) / iPad (768) / PC (1440) and
// record each section's layout signature at every width, plus a human-readable
// summary of what changes. Spec files fill their Responsive section from this —
// never from guessing.
//
// Usage: node scripts/extract/responsive.mjs <url> [--selector "css"]
//   (no --selector = auto-detect top-level sections: header, main children, footer)
// Output: docs/research/<host>/responsive.json
import { VIEWPORTS, openPage, closeBrowser, gotoAndSettle, autoScroll, hostOf, writeJson, parseArgs } from "../lib.mjs";

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
// Walk the page top-down collecting real sections. Semantic elements
// (section/header/footer/nav/main/aside/article) are leaves; generic wrapper
// divs (body > #wrapper > #main > section...) get expanded through.
const DETECT = `(function () {
  const LEAF = new Set(["SECTION", "HEADER", "FOOTER", "NAV", "ASIDE", "ARTICLE", "MAIN"]);
  const MIN_H = 40; // site headers are often ~44px on phones
  const found = [];
  // Produce a selector that provably resolves back to this exact element.
  // Class-based selectors are preferred (readable in specs), but Tailwind
  // classes are rarely unique, so there's a guaranteed positional fallback.
  function selectorFor(el) {
    const tag = el.tagName.toLowerCase();
    const ok = (s) => {
      try {
        return document.querySelector(s) === el ? s : null;
      } catch {
        return null;
      }
    };
    if (el.id) {
      const s = ok(tag + "#" + CSS.escape(el.id));
      if (s) return s;
    }
    const classes = (el.className?.toString() || "").split(/\s+/).filter(Boolean).map((c) => CSS.escape(c));
    for (const n of [1, 2, 3]) {
      if (classes.length < n) break;
      const s = ok(tag + "." + classes.slice(0, n).join("."));
      if (s) return s;
    }
    // Guaranteed fallback: absolute nth-child path from <body>
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && cur.parentElement) {
      parts.unshift(":nth-child(" + ([...cur.parentElement.children].indexOf(cur) + 1) + ")");
      cur = cur.parentElement;
    }
    return "body > " + parts.join(" > ");
  }
  // A real section is roughly viewport-scale. Anything much taller is a
  // container holding several sections, so keep descending through it.
  const MAX_SECTION_H = Math.max(1400, window.innerHeight * 1.6);
  function walk(el, depth) {
    if (depth > 7 || found.length > 25) return;
    for (const child of el.children) {
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "svg", "SVG"].includes(child.tagName)) continue;
      const r = child.getBoundingClientRect();
      if (r.height < MIN_H) continue;
      const bigKids = [...child.children].filter((k) => k.getBoundingClientRect().height >= MIN_H);
      // A repeated collection (a card grid, a tile row) is ONE section — it
      // becomes one component fed by a data array, never N sections. Requires
      // same tag AND similar heights: three <div>s of 852/2161/974px is a page
      // scaffold, not a grid, and must still be descended into.
      const kidHeights = bigKids.map((k) => k.getBoundingClientRect().height);
      const minKid = Math.min(...kidHeights);
      const maxKid = Math.max(...kidHeights);
      const isCollection =
        bigKids.length >= 3 &&
        new Set(bigKids.map((k) => k.tagName)).size === 1 &&
        maxKid - minKid <= maxKid * 0.25 && // siblings are roughly equal
        r.height <= MAX_SECTION_H;
      // The rule: a section is the first element small enough to BE a section.
      // Anything taller is a container to descend through. Without this, sites
      // with no semantic tags recurse all the way down to individual paragraphs.
      if (!isCollection && bigKids.length >= 1) {
        if (r.height > MAX_SECTION_H) {
          walk(child, depth + 1);
          continue;
        }
        // A pure wrapper adds nothing of its own — unwrap it even at section
        // scale (common in React output: div > div > main > …).
        if (!LEAF.has(child.tagName) && !child.id && bigKids.length === 1 && bigKids[0].getBoundingClientRect().height >= r.height * 0.92) {
          walk(child, depth + 1);
          continue;
        }
        // A semantic element wrapping only other semantic sections.
        if (LEAF.has(child.tagName) && bigKids.length > 1 && bigKids.every((k) => LEAF.has(k.tagName))) {
          walk(child, depth + 1);
          continue;
        }
      }
      const sel = selectorFor(child);
      if (!found.some((f) => f.selector === sel) && document.querySelector(sel) === child) {
        found.push({ selector: sel, label: sel });
      }
    }
  }
  walk(document.body, 0);
  // Site chrome is always worth its own spec even when nested inside a wrapper
  for (const tag of ["header", "footer"]) {
    const el = document.querySelector(tag);
    if (!el || el.getBoundingClientRect().height < MIN_H) continue;
    const sel = selectorFor(el);
    if (!found.some((f) => f.selector === sel)) found.unshift({ selector: sel, label: sel });
  }
  return found;
})`;

const results = {};
let sections = null;

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
sections = args.selector
  ? [{ selector: args.selector, label: args.selector }]
  : await pcPage.evaluate(`(${DETECT})()`);

await Promise.all(
  loaded.map(async ({ vpName, page, close }) => {
    const measured = {};
    for (const s of sections) {
      measured[s.selector] = await page.evaluate(`(${SIGNATURE})(${JSON.stringify(s.selector)})`);
    }
    results[vpName] = measured;
    await close();
    console.error(`  ✓ measured ${sections.length} sections @ ${vpName} (${VIEWPORTS[vpName].width}px)`);
  })
);
await closeBrowser();

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
