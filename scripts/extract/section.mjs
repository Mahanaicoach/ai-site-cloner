#!/usr/bin/env node
// Deep-extract one or more sections: full computed-style DOM walk + verbatim
// text + assets. Optionally capture a second state (scroll/click/hover) and
// diff the two.
//
// Usage:
//   node scripts/extract/section.mjs <url> --selector "header" [--name header]
//     [--viewport pc|ipad|phone] [--depth 5]
//     [--state scroll:600 | click:.tab-btn | hover:.card]
//
//   --selector and --name repeat, and every section is walked from a SINGLE
//   page load. Extracting five sections is one navigation, not five:
//     node scripts/extract/section.mjs <url> \
//       --selector "#banner" --name banner \
//       --selector "#one"    --name tiles
//
// Output: docs/research/<host>/sections/<name>.json  (stateA/stateB/diff when --state used)
import {
  VIEWPORTS,
  openPage,
  closeBrowser,
  gotoAndSettle,
  autoScroll,
  transitionMs,
  hostOf,
  slugify,
  writeJson,
  parseArgs,
  toList,
} from "../lib.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args._[0];
const selectors = toList(args.selector);
if (!url || !selectors.length) {
  console.error('Usage: node scripts/extract/section.mjs <url> --selector "css" [--name x] [--state scroll:600|click:sel|hover:sel]');
  console.error("       --selector/--name repeat; all sections extract from one page load.");
  process.exit(1);
}
const names = toList(args.name);
const viewport = VIEWPORTS[args.viewport || "pc"];
const depth = Number(args.depth ?? 5);
const targets = selectors.map((selector, i) => ({ selector, name: names[i] || slugify(selector) }));

const { page, close } = await openPage(viewport);
await gotoAndSettle(page, url);
await autoScroll(page);

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
  // ::before / ::after carry real visuals (underline bars, icon glyphs, overlays)
  // that getComputedStyle on the element itself never reveals. Miss these and the
  // clone silently loses decorations.
  const PSEUDO_PROPS = [
    "content","width","height","backgroundColor","backgroundImage","backgroundSize","borderRadius",
    "position","top","right","bottom","left","transform","opacity","display",
    "borderBottomWidth","borderTopWidth","borderLeftWidth","borderRightWidth","borderColor","borderStyle",
    "margin","padding","zIndex","boxShadow","transition","mixBlendMode","filter",
  ];
  // Typography only matters when the pseudo actually renders text (icon fonts, glyphs)
  const PSEUDO_TEXT_PROPS = ["fontFamily","fontSize","fontWeight","color","lineHeight","letterSpacing","textAlign"];
  function pseudos(element) {
    const out = {};
    for (const pe of ["::before", "::after"]) {
      const cs = getComputedStyle(element, pe);
      if (!cs.content || cs.content === "none") continue;
      const hasText = cs.content !== '""' && cs.content !== "''" && !cs.content.startsWith("url(");
      const styles = { content: cs.content };
      for (const p of [...PSEUDO_PROPS, ...(hasText ? PSEUDO_TEXT_PROPS : [])]) {
        const v = cs[p];
        if (v !== undefined && !SKIP.has(v)) styles[p] = v;
      }
      // A pseudo with no box and no text renders nothing — skip it
      if (Object.keys(styles).length > 1) out[pe] = styles;
    }
    return Object.keys(out).length ? out : undefined;
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
      pseudo: pseudos(element),
      childCount: kids.length,
      children: kids.slice(0, 25).map((c) => walk(c, d + 1)),
    };
  }
  return walk(el, 0);
})`;

async function capture(selector) {
  await page.locator(selector).first().scrollIntoViewIfNeeded().catch(() => {});
  return page.evaluate(`(${WALKER})(${JSON.stringify(selector)}, ${depth})`);
}

// Style deltas between two captures of the same subtree, element by element.
// Both real styles and pseudo-element styles count: a hover effect built from a
// ::before overlay changes nothing on the element itself.
function diffNode(a, b, path, out) {
  if (!a || !b || a.error || b.error) return;
  const keys = new Set([...Object.keys(a.styles || {}), ...Object.keys(b.styles || {})]);
  for (const k of keys) {
    if ((a.styles?.[k] || null) !== (b.styles?.[k] || null)) {
      out.push({ path, prop: k, before: a.styles?.[k] ?? "(unset)", after: b.styles?.[k] ?? "(unset)" });
    }
  }
  for (const pe of ["::before", "::after"]) {
    const pa = a.pseudo?.[pe] || {};
    const pb = b.pseudo?.[pe] || {};
    const pkeys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
    for (const k of pkeys) {
      if ((pa[k] || null) !== (pb[k] || null)) {
        out.push({ path: path + pe, prop: k, before: pa[k] ?? "(unset)", after: pb[k] ?? "(unset)" });
      }
    }
  }
  (a.children || []).forEach((c, i) => diffNode(c, b.children?.[i], `${path} > ${c.tag}[${i}]`, out));
}

const meta = { url, viewport: args.viewport || "pc", generatedAt: new Date().toISOString() };
const stateA = {};
for (const { selector } of targets) {
  const tree = await capture(selector);
  if (tree.error) {
    console.error(tree.error);
    await close();
    await closeBrowser();
    process.exit(1);
  }
  stateA[selector] = tree;
}

if (args.state) {
  const [kind, ...rest] = String(args.state).split(":");
  const target = rest.join(":");
  // trigger state B
  if (kind === "scroll") await page.evaluate((y) => window.scrollTo(0, Number(y)), target || "600");
  else if (kind === "click") await page.locator(target).first().click({ timeout: 5000 }).catch((e) => console.error("click failed:", e.message));
  else if (kind === "hover") await page.locator(target).first().hover({ timeout: 5000 }).catch((e) => console.error("hover failed:", e.message));

  // Wait exactly as long as this section's slowest transition, not a flat guess.
  // A 2.5s overlay fade used to get captured mid-flight and recorded as final.
  const settle = Math.max(...(await Promise.all(targets.map((t) => transitionMs(page, t.selector)))));
  await page.waitForTimeout(settle);

  for (const { selector, name } of targets) {
    const stateB = await capture(selector);
    const diff = [];
    diffNode(stateA[selector], stateB, stateA[selector].tag, diff);
    writeJson(`docs/research/${hostOf(url)}/sections/${name}.json`, {
      ...meta,
      selector,
      trigger: args.state,
      settleMs: settle,
      stateA: stateA[selector],
      stateB,
      diff,
    });
    console.log(`${name}: ${diff.length} properties changed after "${args.state}" (waited ${settle}ms)`);
  }
} else {
  for (const { selector, name } of targets) {
    writeJson(`docs/research/${hostOf(url)}/sections/${name}.json`, { ...meta, selector, tree: stateA[selector] });
  }
  console.log(`Extracted ${targets.length} section(s) from one page load.`);
}

await close();
await closeBrowser();
