#!/usr/bin/env node
// Deep-extract one section: full computed-style DOM walk + verbatim text + assets.
// Optionally capture a second state (scroll/click/hover) and diff the two.
//
// Usage:
//   node scripts/extract/section.mjs <url> --selector "header" [--name header]
//     [--viewport pc|ipad|phone] [--depth 5]
//     [--state scroll:600 | click:.tab-btn | hover:.card]
//
// Output: docs/research/<host>/sections/<name>.json  (stateA/stateB/diff when --state used)
import { VIEWPORTS, launchPage, gotoAndSettle, autoScroll, hostOf, slugify, writeJson, parseArgs } from "../lib.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args._[0];
const selector = args.selector;
if (!url || !selector) {
  console.error('Usage: node scripts/extract/section.mjs <url> --selector "css" [--name x] [--state scroll:600|click:sel|hover:sel]');
  process.exit(1);
}
const viewport = VIEWPORTS[args.viewport || "pc"];
const depth = Number(args.depth ?? 5);
const name = args.name || slugify(selector);

const { browser, page } = await launchPage(viewport);
await gotoAndSettle(page, url);
await autoScroll(page);
await page.locator(selector).first().scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(600);

// The walker runs in the page. Captures every relevant computed property per element.
const WALKER = `(function (selector, maxDepth) {
  const el = document.querySelector(selector);
  if (!el) return { error: "Element not found: " + selector };
  const PROPS = [
    "fontSize","fontWeight","fontFamily","lineHeight","letterSpacing","color","textAlign",
    "textTransform","textDecoration","backgroundColor","backgroundImage","backgroundSize","backgroundPosition",
    "paddingTop","paddingRight","paddingBottom","paddingLeft",
    "marginTop","marginRight","marginBottom","marginLeft",
    "width","height","maxWidth","minWidth","maxHeight","minHeight",
    "display","flexDirection","flexWrap","justifyContent","alignItems","gap","rowGap","columnGap",
    "gridTemplateColumns","gridTemplateRows","gridAutoFlow",
    "borderRadius","borderTopWidth","borderBottomWidth","borderLeftWidth","borderRightWidth","borderColor","borderStyle",
    "boxShadow","overflow","overflowX","overflowY",
    "position","top","right","bottom","left","zIndex","inset",
    "opacity","transform","transition","animation","cursor","pointerEvents","visibility",
    "objectFit","objectPosition","mixBlendMode","filter","backdropFilter",
    "whiteSpace","textOverflow","aspectRatio","order","flexGrow","flexShrink","flexBasis",
  ];
  const SKIP = new Set(["none","normal","auto","0px","rgba(0, 0, 0, 0)","visible","static","initial",""]);
  function styles(element) {
    const cs = getComputedStyle(element);
    const out = {};
    for (const p of PROPS) {
      const v = cs[p];
      if (v !== undefined && !SKIP.has(v)) out[p] = v;
    }
    return out;
  }
  function directText(element) {
    return [...element.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .filter(Boolean)
      .join(" ")
      .slice(0, 500) || null;
  }
  function walk(element, d) {
    if (d > maxDepth) return { truncated: true, tag: element.tagName.toLowerCase() };
    const kids = [...element.children];
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      classes: (element.className?.toString() || "").split(" ").filter(Boolean).slice(0, 6).join(" ") || null,
      text: directText(element),
      href: element.tagName === "A" ? element.getAttribute("href") : undefined,
      ariaLabel: element.getAttribute("aria-label") || undefined,
      img: element.tagName === "IMG"
        ? { src: element.currentSrc || element.src, alt: element.alt, w: element.naturalWidth, h: element.naturalHeight }
        : undefined,
      isSvg: element.tagName.toLowerCase() === "svg" || undefined,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      styles: styles(element),
      childCount: kids.length,
      children: kids.slice(0, 25).map((c) => walk(c, d + 1)),
    };
  }
  return walk(el, 0);
})`;

const capture = () => page.evaluate(`(${WALKER})(${JSON.stringify(selector)}, ${depth})`);

const stateA = await capture();
if (stateA.error) {
  console.error(stateA.error);
  await browser.close();
  process.exit(1);
}

let result = { url, selector, viewport: args.viewport || "pc", generatedAt: new Date().toISOString() };

if (args.state) {
  const [kind, ...rest] = String(args.state).split(":");
  const target = rest.join(":");
  // trigger state B
  if (kind === "scroll") await page.evaluate((y) => window.scrollTo(0, Number(y)), target || "600");
  else if (kind === "click") await page.locator(target).first().click({ timeout: 5000 }).catch((e) => console.error("click failed:", e.message));
  else if (kind === "hover") await page.locator(target).first().hover({ timeout: 5000 }).catch((e) => console.error("hover failed:", e.message));
  await page.waitForTimeout(800); // let transitions finish
  const stateB = await capture();

  // diff styles per element path
  function diffNode(a, b, path, out) {
    if (!a || !b || a.error || b.error) return;
    const keys = new Set([...Object.keys(a.styles || {}), ...Object.keys(b.styles || {})]);
    for (const k of keys) {
      if ((a.styles?.[k] || null) !== (b.styles?.[k] || null)) {
        out.push({ path, prop: k, before: a.styles?.[k] ?? "(unset)", after: b.styles?.[k] ?? "(unset)" });
      }
    }
    (a.children || []).forEach((c, i) => diffNode(c, b.children?.[i], `${path} > ${c.tag}[${i}]`, out));
  }
  const diff = [];
  diffNode(stateA, stateB, stateA.tag, diff);
  result = { ...result, trigger: args.state, stateA, stateB, diff };
  console.log(`State diff: ${diff.length} properties changed after "${args.state}"`);
} else {
  result = { ...result, tree: stateA };
}

await browser.close();
writeJson(`docs/research/${hostOf(url)}/sections/${name}.json`, result);
