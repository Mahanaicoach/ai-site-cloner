#!/usr/bin/env node
// Generate the MECHANICAL parts of a component spec straight from extraction
// JSON — frontmatter skeleton, DOM Structure, Computed Styles, Assets, Text
// Content, Responsive Behavior — leaving clearly marked <!-- AGENT: fill -->
// blocks for the judgment sections (interaction_model, States & Behaviors,
// Per-State Content, implementation notes).
//
// Specs used to be hand-transcribed from sections/<name>.json; agents
// mis-transcribe, which is why the skill has the rule "if the spec disagrees
// with the JSON, the JSON wins". This script kills the transcription step: the
// mechanical sections are now generated from the same JSON they used to be
// copied from, and the agent only writes the parts that need judgment.
//
// Usage:
//   node scripts/spec-scaffold.mjs --route / --section hero [--section pricing]
//   node scripts/spec-scaffold.mjs --route / --all          # every section of the route
//     [--host plausible.io]       host dir under research/ (from manifest when omitted)
//     [--research docs/research]  research root (default docs/research)
//     [--out <research>/components]
//
// Reads:  <research>/<host>/sections/<name>.json   (walk — legacy or compact)
//         <research>/<host>/responsive.json, probe-<name>.json, assets.json
//         <research>/<host>/sections/<name>-*.json (state captures -> listed as states)
// Writes: <out>/<route-slug>/<name>.spec.md
//
// The output passes lint-spec.mjs once the agent fills the marked blocks —
// until then interaction_model is invalid on purpose, so an unfilled scaffold
// can never be dispatched to a builder.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { hostOf, slugify, parseArgs, toList } from "./lib.mjs";
import { walkNodes, resolveStyles, nodeLabel } from "./extract/walk-format.mjs";

const args = parseArgs(process.argv.slice(2));
const research = typeof args.research === "string" ? args.research : "docs/research";
const outRoot = typeof args.out === "string" ? args.out : join(research, "components");
const route = typeof args.route === "string" ? args.route : "/";
const routeSlug = route === "/" ? "home" : slugify(route.replace(/^\//, ""));

let host = typeof args.host === "string" ? args.host : null;
let sections = toList(args.section).map(String);

const manifestPath = join(research, "manifest.json");
if (existsSync(manifestPath)) {
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!host && m.site) host = hostOf(m.site);
  if (args.all) {
    const p = m.pages.find((p) => p.route === route);
    if (!p) {
      console.error(`Route ${route} not in manifest. Routes: ${m.pages.map((p) => p.route).join(", ")}`);
      process.exit(1);
    }
    sections = p.sections.map((s) => s.name);
  }
}
if (!host) {
  // fall back to the only host dir that has extraction output
  const candidates = existsSync(research)
    ? readdirSync(research).filter((d) => existsSync(join(research, d, "sections")))
    : [];
  if (candidates.length === 1) host = candidates[0];
}
if (!host || !sections.length) {
  console.error("Usage: node scripts/spec-scaffold.mjs --route / --section hero [--section x ...] | --all  [--host h] [--research dir] [--out dir]");
  process.exit(1);
}

const hostDir = join(research, host);
const sectionsDir = join(hostDir, "sections");
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const responsive = readJson(join(hostDir, "responsive.json"));
const assetsDoc = readJson(join(hostDir, "assets.json"));

const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const AGENT = (hint) => `<!-- AGENT: fill — ${hint} -->`;
// script/style nodes are in the walk (ground truth) but are noise in a spec
const isNoise = (node) => ["script", "style", "noscript", "template"].includes(node.tag);

// ── naming ──────────────────────────────────────────────────────────────────
function componentName(name) {
  if (/^(nav|header)$/.test(name)) return "SiteHeader";
  if (name === "footer") return "SiteFooter";
  const pascal = name.split(/[^a-z0-9]+/i).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  return pascal.endsWith("Section") ? pascal : pascal + "Section";
}

// ── DOM structure (collapsed wrapper chains, grouped sibling runs) ──────────
const MAX_DOM_LINES = 18;
function domStructure(tree) {
  const lines = [];
  let truncated = false;
  const rec = (node, depth, countPrefix) => {
    if (!node || node.error) return;
    if (lines.length >= MAX_DOM_LINES) {
      truncated = true;
      return;
    }
    let label = nodeLabel(node);
    let cur = node;
    // a chain of lone wrappers is one line: div.container > div.mx-auto > …
    while ((cur.children || []).length === 1 && !cur.text && !cur.img && label.length < 80) {
      cur = cur.children[0];
      label += " > " + nodeLabel(cur);
    }
    const text = cur.text ? ` — "${trunc(cur.text, 48)}"` : "";
    const dims = cur.rect && depth <= 1 ? ` [${cur.rect.w}×${cur.rect.h}]` : "";
    lines.push(`${"  ".repeat(depth)}- ${countPrefix}${label}${dims}${text}`);
    const kids = (cur.children || []).filter((k) => k && !k.error && !k.truncated && !isNoise(k));
    const sig = (k) => `${k.tag}|${k.classes || ""}`;
    let i = 0;
    while (i < kids.length) {
      let j = i + 1;
      while (j < kids.length && sig(kids[j]) === sig(kids[i])) j++;
      rec(kids[i], depth + 1, j - i >= 2 ? `×${j - i} ` : "");
      i = j;
    }
    if (cur.truncatedChildren) lines.push(`${"  ".repeat(depth + 1)}- … +${cur.truncatedChildren} more children (see JSON)`);
  };
  rec(tree, 0, "");
  if (truncated) lines.push(`- … truncated — full tree in the section JSON (ground truth)`);
  return lines;
}

// ── computed styles (selective + deduplicated) ──────────────────────────────
const MAX_STYLE_LINES = 26;
function summarizeStyles(s, hasText) {
  const parts = [];
  if (hasText && s.fontSize) {
    let t = `${s.fontSize}/${s.fontWeight || "400"}/${s.lineHeight || "-"}`;
    if (s.letterSpacing) t += ` ${s.letterSpacing}`;
    if (s.color) t += ` ${s.color}`;
    parts.push(t);
    if (s.textAlign && !["start", "left"].includes(s.textAlign)) parts.push(s.textAlign);
    if (s.textTransform) parts.push(s.textTransform);
  }
  if (s.backgroundColor) parts.push(`bg ${s.backgroundColor}`);
  if (s.backgroundImage) parts.push(`bg-img ${trunc(s.backgroundImage, 42)}`);
  if (s.borderRadius) parts.push(`radius ${s.borderRadius}`);
  const bw = s.borderTopWidth || s.borderBottomWidth || s.borderLeftWidth || s.borderRightWidth;
  if (bw && s.borderStyle && s.borderStyle !== "none") parts.push(`border ${bw} ${s.borderStyle} ${s.borderColor || ""}`.trim());
  if (s.boxShadow) parts.push(`shadow ${trunc(s.boxShadow, 48)}`);
  const pads = [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map((v) => v || "0px");
  if (pads.some((v) => v !== "0px")) parts.push(`pad ${pads.join(" ")}`);
  const margins = [["mt", s.marginTop], ["mr", s.marginRight], ["mb", s.marginBottom], ["ml", s.marginLeft]].filter(([, v]) => v);
  if (margins.length) parts.push(margins.map(([k, v]) => `${k} ${v}`).join(" "));
  if (/flex/.test(s.display || "")) {
    let f = `flex ${s.flexDirection || "row"}`;
    if (s.gap) f += ` gap ${s.gap}`;
    if (s.justifyContent) f += ` justify ${s.justifyContent}`;
    if (s.alignItems) f += ` items ${s.alignItems}`;
    parts.push(f);
  } else if (/grid/.test(s.display || "")) {
    parts.push(`grid cols [${trunc(s.gridTemplateColumns || "", 40)}]${s.gap ? ` gap ${s.gap}` : ""}`);
  }
  if (s.maxWidth) parts.push(`max-w ${s.maxWidth}`);
  if (s.position && s.position !== "static") {
    parts.push(`${s.position}${s.zIndex && s.zIndex !== "auto" ? ` z${s.zIndex}` : ""}${s.top ? ` top ${s.top}` : ""}${s.bottom ? ` bottom ${s.bottom}` : ""}`);
  }
  if (s.opacity && s.opacity !== "1") parts.push(`opacity ${s.opacity}`);
  if (s.transform) parts.push(`transform ${trunc(s.transform, 36)}`);
  return parts.join("; ");
}

function styleLines(doc, tree, maxLines = MAX_STYLE_LINES) {
  const seen = new Map();
  const entries = [];
  for (const { node, ancestors } of walkNodes(tree)) {
    if (node.isSvg || isNoise(node)) continue;
    const styles = resolveStyles(node, ancestors, doc);
    const hasText = !!node.text;
    const visual = !!(styles.backgroundColor || styles.backgroundImage || styles.boxShadow || styles.borderRadius);
    const layout = /(flex|grid)/.test(styles.display || "");
    if (ancestors.length && !hasText && !visual && !layout && !node.img) continue;
    const summary = summarizeStyles(styles, hasText);
    if (!summary) continue;
    const sig = `${node.tag}|${summary}`;
    if (seen.has(sig)) {
      seen.get(sig).count++;
      continue;
    }
    const parent = ancestors[ancestors.length - 1];
    const label = (parent ? nodeLabel(parent) + " > " : "") + nodeLabel(node) + (hasText ? ` ("${trunc(node.text, 22)}")` : "");
    const entry = { label, summary, count: 1, size: node.rect ? ` [${node.rect.w}×${node.rect.h}]` : "" };
    seen.set(sig, entry);
    entries.push(entry);
  }
  const lines = entries.slice(0, maxLines).map(
    (e) => `- **${e.label}**${e.count > 1 ? ` ×${e.count}` : ""}${e.size}: ${e.summary}`
  );
  if (entries.length > maxLines) {
    lines.push(`- … +${entries.length - maxLines} more styled nodes — resolve any node with \`node scripts/resolve-walk.mjs\` (JSON is ground truth)`);
  }
  return lines;
}

// ── text content (verbatim) ─────────────────────────────────────────────────
const MAX_TEXT_LINES = 36;
function textLines(tree) {
  const all = [];
  for (const { node } of walkNodes(tree)) {
    if (node.text && !isNoise(node)) all.push(`- ${node.tag}: "${node.text}"`);
  }
  // collapse exact consecutive repeats
  const lines = [];
  for (let i = 0; i < all.length; i++) {
    let j = i + 1;
    while (j < all.length && all[j] === all[i]) j++;
    lines.push(j - i >= 2 ? `${all[i]} ×${j - i}` : all[i]);
    i = j - 1;
  }
  if (lines.length > MAX_TEXT_LINES) {
    const extra = lines.length - MAX_TEXT_LINES;
    lines.length = MAX_TEXT_LINES;
    lines.push(`- … +${extra} more text nodes — verbatim in the section JSON`);
  }
  return lines.length ? lines : ["None — no text nodes in this section."];
}

// ── assets ──────────────────────────────────────────────────────────────────
function assetInfo(doc, tree) {
  const localFor = (src) => assetsDoc?.downloads?.find((d) => d.remote === src)?.local || null;
  const seen = new Set();
  const lines = [];
  const locals = [];
  let svgCount = 0;
  for (const { node, ancestors } of walkNodes(tree)) {
    if (node.isSvg) svgCount++;
    if (node.img?.src && !seen.has(node.img.src)) {
      seen.add(node.img.src);
      const local = localFor(node.img.src);
      if (local) locals.push(local);
      lines.push(`- img ${basename(new URL(node.img.src, "https://x/").pathname)} (${node.img.w}×${node.img.h})${node.img.alt ? ` alt "${trunc(node.img.alt, 40)}"` : ""} → ${local || "NOT DOWNLOADED — check assets.json"}`);
    }
    const bg = resolveStyles(node, ancestors, doc).backgroundImage;
    const m = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
    if (m && !m[1].startsWith("data:") && !seen.has(m[1])) {
      seen.add(m[1]);
      const local = localFor(m[1]);
      if (local) locals.push(local);
      lines.push(`- background-image ${basename(m[1])} on ${nodeLabel(node)} → ${local || "NOT DOWNLOADED"}`);
    }
  }
  if (svgCount) lines.push(`- inline SVG ×${svgCount} — use/extend components in src/components/icons.tsx`);
  if (!lines.length) lines.push("None — text and CSS only.");
  const fmAssets = locals.length
    ? locals.slice(0, 4).join(", ") + (locals.length > 4 ? ` +${locals.length - 4} more` : "")
    : svgCount ? "icons only (icons.tsx)" : "none";
  return { lines, fmAssets };
}

// ── state captures (mechanical reference for the agent's judgment block) ────
function stateCaptures(name) {
  const out = [];
  if (!existsSync(sectionsDir)) return out;
  for (const f of readdirSync(sectionsDir)) {
    if (!f.startsWith(name + "-") || !f.endsWith(".json")) continue;
    const doc = readJson(join(sectionsDir, f));
    if (!doc?.trigger) continue;
    const byProp = {};
    for (const d of doc.diff || []) byProp[d.prop] = (byProp[d.prop] || 0) + 1;
    const top = Object.entries(byProp).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p]) => p);
    out.push({
      suffix: f.slice(name.length + 1, -5),
      file: f,
      trigger: doc.trigger,
      settleMs: doc.settleMs,
      changes: (doc.diff || []).length,
      added: (doc.added || []).length,
      removed: (doc.removed || []).length,
      topProps: top,
    });
  }
  return out;
}

// ── responsive behavior ─────────────────────────────────────────────────────
function responsiveLines(name, selector) {
  const entry = responsive?.sections?.find((s) => s.name === name) || responsive?.sections?.find((s) => s.selector === selector);
  const probe = readJson(join(hostDir, `probe-${slugify(name)}.json`));
  const probeFor = (vp) => {
    const bySel = probe?.results?.[vp];
    if (!bySel) return null;
    return bySel[selector] || Object.values(bySel)[0] || null;
  };
  const lines = [];
  for (const [vp, px] of [["phone", 390], ["ipad", 768], ["pc", 1440]]) {
    const sig = entry?.[vp];
    const pr = probeFor(vp);
    if (!sig && !pr) continue;
    const parts = [];
    if (sig) {
      parts.push(`section ${sig.width}×${sig.height}px`);
      if (sig.paddingX && sig.paddingX !== "0px / 0px") parts.push(`pad-x ${sig.paddingX}`);
      if (sig.headingFontSize) parts.push(`heading ${sig.headingFontSize}`);
      if (sig.fontSize) parts.push(`body ${sig.fontSize}`);
      const cols = sig.innerLayout?.realColumns;
      if (cols) parts.push(`${cols} col${cols > 1 ? "s" : ""} (${sig.innerLayout.itemCount} items, gap ${sig.innerLayout.gap})`);
      if (sig.hiddenChildren) parts.push(`${sig.hiddenChildren} hidden children`);
    }
    if (pr) {
      const p = [];
      if (pr.paddingTop && pr.paddingTop !== "0px") p.push(`pt ${pr.paddingTop}`);
      if (pr.paddingBottom && pr.paddingBottom !== "0px") p.push(`pb ${pr.paddingBottom}`);
      if (pr.marginTop && pr.marginTop !== "0px") p.push(`mt ${pr.marginTop}`);
      if (pr.maxWidth && pr.maxWidth !== "none") p.push(`max-w ${pr.maxWidth}`);
      if (pr.lineHeight) p.push(`lh ${pr.lineHeight}`);
      if (pr.gridTemplateColumns && pr.gridTemplateColumns !== "none") p.push(`grid [${trunc(pr.gridTemplateColumns, 36)}]`);
      if (p.length) parts.push(p.join(", "));
    }
    lines.push(`- ${vp} ${px}: ${parts.join("; ")}`);
  }
  if (!lines.length) {
    return [AGENT(`no responsive.json entry for "${name}" — run probe.mjs --route ${route} and fill measured values for phone/ipad/pc`)];
  }
  for (const c of entry?.summary?.changes || []) lines.push(`- change: ${c}`);
  if (entry?.summary?.ipadBehavior) lines.push(`- ${entry.summary.ipadBehavior}`);
  lines.push(`- exact per-property values: probe-${slugify(name)}.json + responsive.json (ground truth)`);
  return lines;
}

// ── main ────────────────────────────────────────────────────────────────────
let failed = 0;
for (const name of sections) {
  const doc = readJson(join(sectionsDir, `${name}.json`));
  if (!doc) {
    console.error(`✗ ${name}: no ${join(sectionsDir, `${name}.json`)} — extract it first (page.mjs)`);
    failed++;
    continue;
  }
  if (!doc.tree) {
    console.error(`✗ ${name}: ${name}.json is a state capture, not a section walk — scaffold the base section`);
    failed++;
    continue;
  }
  const tree = doc.tree;
  const captures = stateCaptures(name);
  const comp = componentName(name);
  const { lines: assetLines, fmAssets } = assetInfo(doc, tree);
  const statesFm = ["default", ...captures.map((c) => c.suffix)].join(", ");

  const captureLines = captures.length
    ? captures.map((c) =>
        `- state "${c.suffix}" (${c.file}): trigger \`${c.trigger}\`, settle ${c.settleMs}ms — ${c.changes} props changed` +
        (c.added || c.removed ? `, +${c.added}/-${c.removed} nodes` : "") +
        (c.topProps.length ? ` (top: ${c.topProps.join(", ")})` : "")
      )
    : [`- No state captures on disk. Cross-check css.json interactiveStates — a :hover/:focus rule for this section with no capture means extraction is not done.`];

  // Utility-CSS fast path: when the extraction captured cleaned markup, the
  // class list IS the spec — quote it and keep computed styles down to a few
  // key anchors for verification instead of an exhaustive dump.
  const markupBlock = doc.html
    ? `
## Source Markup
Utility CSS detected — translate this markup first, verify with probe values second.
\`\`\`html
${doc.html}
\`\`\`
`
    : "";
  const stylesBlock = doc.html
    ? styleLines(doc, tree, 8).join("\n") + "\n- Key anchors only — the Source Markup above is the primary spec; resolve any node via resolve-walk.mjs."
    : styleLines(doc, tree).join("\n");

  const md = `---
component: ${comp}
target: src/components/${comp}.tsx
page: ${route}
screenshot: docs/design-references/${host}/${name}-pc.png
interaction_model: ${AGENT("one of: static | click-driven | scroll-driven | hover-driven | time-driven | mixed")}
states: ${statesFm}
assets: ${fmAssets}
responsive: phone, ipad, pc
---

# ${comp} Specification

## DOM Structure
${domStructure(tree).join("\n")}
${markupBlock}
## Computed Styles
${stylesBlock}

## States & Behaviors
${AGENT("per behavior: Trigger / State A / State B / Transition + implementation approach (CSS transition, IntersectionObserver, …). Mechanical capture data below is reference, not a substitute.")}
${captureLines.join("\n")}

## Per-State Content
${AGENT('full content per state for tabbed/stateful sections; write "N/A — static" if the section has one state')}

## Assets
${assetLines.join("\n")}

## Text Content
${textLines(tree).join("\n")}

## Responsive Behavior
${responsiveLines(name, doc.selector).join("\n")}

## Notes
${AGENT("implementation notes for the builder: component split, data file shape for src/data/, gotchas. Delete this section if nothing to add.")}
`;

  const outDir = join(outRoot, routeSlug);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${name}.spec.md`);
  writeFileSync(outPath, md);
  const bodyLines = md.split("\n").length;
  console.log(`✓ ${outPath} (${bodyLines} lines, ${captures.length} captured state(s)) — fill the <!-- AGENT: fill --> blocks, then lint`);
}
process.exit(failed ? 1 : 0);
