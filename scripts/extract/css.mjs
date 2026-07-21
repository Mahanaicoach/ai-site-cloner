#!/usr/bin/env node
// Scrape the target's ACTUAL CSS rules — not just computed styles.
//
// Computed styles only tell you how an element looks right now. The stylesheet
// tells you every state it can be in: :hover, :focus, :active, media queries,
// keyframes. Reading the rules catches interactions you'd never think to probe.
//
// Sources handled:
//   - inline <style> blocks
//   - same-origin stylesheets (via cssRules)
//   - cross-origin stylesheets (cssRules throws → fetched directly by URL)
//
// Usage:
//   node scripts/extract/css.mjs <url>                      # whole-page rule dump
//   node scripts/extract/css.mjs <url> --selector "nav a"   # + exact matched rules
//                                                             for that element (via CDP,
//                                                             same data as the DevTools
//                                                             Styles panel, incl. :hover)
// Output: docs/research/<host>/css.json  (+ a summary to stdout)
import { launchPage, gotoAndSettle, autoScroll, hostOf, writeJson, parseArgs } from "../lib.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args._[0];
if (!url) {
  console.error('Usage: node scripts/extract/css.mjs <url> [--selector "css"]');
  process.exit(1);
}

const { browser, page } = await launchPage();
await gotoAndSettle(page, url);
await autoScroll(page);

// ── 1. Collect stylesheet text from inside the page ───────────────────
const collected = await page.evaluate(() => {
  const sheets = [];
  for (const sheet of document.styleSheets) {
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch {
      // cross-origin: record the href so we can fetch it outside the page
      sheets.push({ href: sheet.href, blocked: true, text: null });
      continue;
    }
    const text = [...rules].map((r) => r.cssText).join("\n");
    sheets.push({ href: sheet.href || "(inline <style>)", blocked: false, text });
  }
  return sheets;
});

// ── 2. Fetch anything the browser refused to expose ───────────────────
for (const s of collected) {
  if (!s.blocked || !s.href) continue;
  try {
    const res = await fetch(s.href, { signal: AbortSignal.timeout(20000), headers: { "User-Agent": "Mozilla/5.0" } });
    if (res.ok) {
      s.text = await res.text();
      s.blocked = false;
      s.fetched = true;
    }
  } catch {
    /* leave blocked — reported in the summary */
  }
}

const allCss = collected.filter((s) => s.text).map((s) => s.text).join("\n");

// ── 3. Parse out the parts that matter for cloning ────────────────────
// A light brace-matching parser: CSS is regular enough at this level, and this
// avoids taking a dependency just to find hover rules.
function splitRules(css) {
  const out = [];
  let depth = 0, buf = "", atRule = null, atBuf = "";
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      depth++;
      if (depth === 1) {
        const head = buf.trim();
        buf = "";
        if (head.startsWith("@media") || head.startsWith("@supports") || head.startsWith("@layer") || head.startsWith("@container")) {
          atRule = head;
          atBuf = "";
          continue;
        }
        out.push({ selector: head, body: "", _open: true });
        continue;
      }
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        if (atRule) {
          // recurse into the group, tagging each inner rule with its condition
          for (const inner of splitRules(atBuf)) out.push({ ...inner, media: atRule });
          atRule = null;
          atBuf = "";
        } else {
          const last = out[out.length - 1];
          if (last?._open) {
            last.body = buf.trim();
            delete last._open;
          }
          buf = "";
        }
        continue;
      }
    }
    if (atRule && depth >= 1) atBuf += ch;
    else buf += ch;
  }
  return out.filter((r) => r.selector && !r.selector.startsWith("@"));
}

const rules = splitRules(allCss);

const STATE_RE = /:(hover|focus|focus-visible|focus-within|active|checked|disabled|target|open)\b/;
const interactive = rules
  .filter((r) => STATE_RE.test(r.selector))
  .map((r) => ({ selector: r.selector.trim(), declarations: r.body, media: r.media || null }));

const byState = {};
for (const r of interactive) {
  const m = r.selector.match(STATE_RE);
  const k = m ? m[1] : "other";
  (byState[k] ||= []).push(r);
}

// Real breakpoint values, straight from the source
const breakpoints = [...new Set(
  (allCss.match(/@media[^{]+/g) || [])
    .flatMap((m) => m.match(/\(\s*(min|max)-width\s*:\s*[^)]+\)/g) || [])
    .map((s) => s.replace(/\s+/g, " ").trim())
)].sort();

const keyframeNames = [...new Set((allCss.match(/@keyframes\s+([\w-]+)/g) || []).map((s) => s.replace(/@keyframes\s+/, "")))];

const host = hostOf(url);

// ── 4. Optional: exact matched rules for one element, via CDP ─────────
let matched = null;
if (args.selector) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: args.selector });
  if (!nodeId) {
    console.error(`Element not found: ${args.selector}`);
  } else {
    const styles = await cdp.send("CSS.getMatchedStylesForNode", { nodeId });
    matched = {
      selector: args.selector,
      // every rule that applies, in cascade order — same list DevTools shows
      matchedRules: (styles.matchedCSSRules || []).map((m) => ({
        selector: m.rule.selectorList?.text,
        origin: m.rule.origin,
        media: m.rule.media?.map((x) => x.text) || null,
        declarations: (m.rule.style?.cssProperties || [])
          .filter((p) => !p.disabled && p.value)
          .map((p) => `${p.name}: ${p.value}`),
      })),
      // :hover / :focus / etc. rules Chrome knows about for this element
      pseudoRules: (styles.pseudoElements || []).map((p) => ({
        pseudoType: p.pseudoType,
        rules: p.matches?.map((m) => ({
          selector: m.rule.selectorList?.text,
          declarations: (m.rule.style?.cssProperties || []).filter((x) => !x.disabled && x.value).map((x) => `${x.name}: ${x.value}`),
        })),
      })),
      inherited: (styles.inherited || []).length,
    };
  }
}

await browser.close();

writeJson(`docs/research/${host}/css.json`, {
  url,
  generatedAt: new Date().toISOString(),
  stylesheets: collected.map((s) => ({ href: s.href, blocked: s.blocked, fetched: !!s.fetched, bytes: s.text?.length || 0 })),
  totalRules: rules.length,
  breakpoints,
  keyframeNames,
  interactiveStates: byState,
  matched,
});

const blocked = collected.filter((s) => s.blocked);
console.log(
  `Stylesheets: ${collected.length} (${blocked.length} unreadable) · rules: ${rules.length} · interactive-state rules: ${interactive.length}`
);
console.log(`States found: ${Object.entries(byState).map(([k, v]) => `${k}=${v.length}`).join(" · ") || "none"}`);
console.log(`Breakpoints: ${breakpoints.join(", ") || "none"}`);
if (keyframeNames.length) console.log(`@keyframes: ${keyframeNames.join(", ")}`);
if (blocked.length) console.log(`NOTE: ${blocked.length} stylesheet(s) could not be read or fetched — hover rules from those are missing.`);
if (matched) console.log(`Matched rules for "${args.selector}": ${matched.matchedRules.length}`);
