#!/usr/bin/env node
// Extract design tokens: colors (by frequency), fonts, :root CSS variables,
// radii/shadows, and global scroll behaviors (Lenis, scroll-snap, etc).
// Usage: node scripts/extract/tokens.mjs <url>
// Output: docs/research/<host>/tokens.json
import { launchPage, gotoAndSettle, autoScroll, hostOf, writeJson, parseArgs } from "../lib.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args._[0];
if (!url) {
  console.error("Usage: node scripts/extract/tokens.mjs <url>");
  process.exit(1);
}

const { browser, page } = await launchPage();
await gotoAndSettle(page, url);
await autoScroll(page);

const tokens = await page.evaluate(() => {
  const els = [...document.querySelectorAll("body *")].slice(0, 3000);
  const count = (map, key) => key && map.set(key, (map.get(key) || 0) + 1);
  const colors = new Map();
  const bgs = new Map();
  const families = new Map();
  const radii = new Map();
  const shadows = new Map();
  const fontSizes = new Map();

  for (const el of els) {
    const cs = getComputedStyle(el);
    count(colors, cs.color);
    if (cs.backgroundColor !== "rgba(0, 0, 0, 0)") count(bgs, cs.backgroundColor);
    count(families, cs.fontFamily);
    if (cs.borderRadius !== "0px") count(radii, cs.borderRadius);
    if (cs.boxShadow !== "none") count(shadows, cs.boxShadow);
    if (el.textContent?.trim()) count(fontSizes, `${cs.fontSize}/${cs.fontWeight}/${cs.lineHeight}`);
  }
  const top = (map, n = 20) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, uses]) => ({ value, uses }));

  // Typography of key elements
  const typo = {};
  for (const sel of ["h1", "h2", "h3", "h4", "p", "a", "button", "body"]) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const cs = getComputedStyle(el);
    typo[sel] = {
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      color: cs.color,
      textTransform: cs.textTransform,
    };
  }

  // :root custom properties + @keyframes bodies (same-origin stylesheets only).
  // Capturing keyframes matters: computed styles tell you `animation: slide-up-fade 1s`
  // but not what slide-up-fade DOES. Without the rule body a builder can only guess.
  const cssVars = {};
  const keyframes = {};
  const walkRules = (rules) => {
    for (const rule of rules) {
      // CSSKeyframesRule
      if (rule.type === 7 || rule.constructor?.name === "CSSKeyframesRule") {
        const steps = {};
        for (const kf of rule.cssRules) steps[kf.keyText] = kf.style.cssText;
        keyframes[rule.name] = steps;
        continue;
      }
      // nested groups: @media, @supports, @layer
      if (rule.cssRules) {
        try {
          walkRules(rule.cssRules);
        } catch { /* ignore */ }
        continue;
      }
      if (rule.selectorText === ":root" || rule.selectorText === "html") {
        for (const prop of rule.style) {
          if (prop.startsWith("--")) cssVars[prop] = rule.style.getPropertyValue(prop).trim();
        }
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walkRules(sheet.cssRules);
    } catch {
      continue; // cross-origin sheet
    }
  }

  // Which animations are actually used on the page, and on how many elements
  const animationsInUse = {};
  for (const el of els) {
    const cs = getComputedStyle(el);
    if (cs.animationName && cs.animationName !== "none") {
      const key = `${cs.animationName} | ${cs.animationDuration} | ${cs.animationTimingFunction} | ${cs.animationIterationCount} | delay ${cs.animationDelay}`;
      animationsInUse[key] = (animationsInUse[key] || 0) + 1;
    }
  }

  // Font sources
  const fontLinks = [...document.querySelectorAll('link[rel="stylesheet"], link[rel="preload"][as="font"]')]
    .map((l) => l.href)
    .filter((h) => /fonts\.|font|\.woff/i.test(h));

  // Global scroll behavior detection
  const htmlCs = getComputedStyle(document.documentElement);
  const bodyCs = getComputedStyle(document.body);
  const globalBehaviors = {
    smoothScrollLib: document.querySelector(".lenis, [data-lenis], .locomotive-scroll, [data-scroll-container]")
      ? "detected (Lenis or Locomotive — inspect manually)"
      : null,
    scrollBehavior: htmlCs.scrollBehavior,
    scrollSnapType: htmlCs.scrollSnapType !== "none" ? htmlCs.scrollSnapType : bodyCs.scrollSnapType !== "none" ? bodyCs.scrollSnapType : null,
    bodyBackground: bodyCs.backgroundColor,
    hasFixedHeader: !!document.querySelector("header, nav") &&
      ["fixed", "sticky"].includes(getComputedStyle(document.querySelector("header, nav")).position),
  };

  return {
    colors: top(colors),
    backgrounds: top(bgs),
    fontFamilies: top(families, 10),
    typography: typo,
    fontSizeCombos: top(fontSizes, 25),
    borderRadii: top(radii, 10),
    boxShadows: top(shadows, 10),
    cssVariables: cssVars,
    keyframes,
    animationsInUse,
    fontLinks,
    globalBehaviors,
  };
});
await browser.close();

writeJson(`docs/research/${hostOf(url)}/tokens.json`, { url, generatedAt: new Date().toISOString(), ...tokens });
console.log(`Colors: ${tokens.colors.length} · Fonts: ${tokens.fontFamilies.length} · CSS vars: ${Object.keys(tokens.cssVariables).length} · @keyframes: ${Object.keys(tokens.keyframes).length} · animations in use: ${Object.keys(tokens.animationsInUse).length}`);
