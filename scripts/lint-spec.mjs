#!/usr/bin/env node
// Spec linter — the mechanical gate before any builder agent is dispatched.
// A spec that fails here means extraction is incomplete. No builder until it passes.
//
// Usage: node scripts/lint-spec.mjs <spec.md> [more.spec.md ...]
//        node scripts/lint-spec.mjs docs/research/components   (lints every *.spec.md inside)
// Exit 1 if any spec fails.
//
// Tiers: a spec may declare `tier: light` in its frontmatter (spec-scaffold
// sets it mechanically). The full template is overkill for a static CTA — both
// agents in the head-to-head benchmark said so — so a section whose walk shows
// ≤ LIGHT_TIER_MAX_NODES (15) nodes AND has zero captured states may ship the
// lighter schema: same headings, but States & Behaviors / Per-State Content
// may be a single "N/A — static" line and the minimum-length warning is
// waived. 15 nodes ≈ heading + paragraph + a couple of CTAs — anything with a
// grid, tabs, or captured states is past it. The linter cross-checks the walk
// JSON when it can find it, so the tier can't be claimed to dodge rigor.
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, basename, dirname, relative, isAbsolute } from "node:path";
import { selfReport, findPage, findSection, advanceStage } from "./manifest-lib.mjs";
import { walkNodes } from "./extract/walk-format.mjs";

const LIGHT_TIER_MAX_NODES = 15;

// Ground-truth check for `tier: light`: locate the section's walk JSON under
// any research host dir and verify the claim. Returns null when unverifiable.
function lightTierViolation(name) {
  const root = "docs/research";
  if (!existsSync(root)) return null;
  for (const host of readdirSync(root)) {
    const walkPath = join(root, host, "sections", `${name}.json`);
    if (!existsSync(walkPath)) continue;
    try {
      const doc = JSON.parse(readFileSync(walkPath, "utf8"));
      if (doc.tree) {
        const n = [...walkNodes(doc.tree)].length;
        if (n > LIGHT_TIER_MAX_NODES) return `walk has ${n} nodes (max ${LIGHT_TIER_MAX_NODES} for light tier)`;
      }
      for (const f of readdirSync(join(root, host, "sections"))) {
        if (f.startsWith(`${name}-`) && f.endsWith(".json")) {
          const cap = JSON.parse(readFileSync(join(root, host, "sections", f), "utf8"));
          if (cap.trigger) return `captured state exists (${f}) — light tier is for stateless sections`;
        }
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

const REQUIRED_FRONTMATTER = ["component", "target", "page", "screenshot", "interaction_model", "states", "assets", "responsive"];
const INTERACTION_MODELS = ["static", "click-driven", "scroll-driven", "hover-driven", "time-driven", "mixed"];
const REQUIRED_HEADINGS = [
  "## DOM Structure",
  "## Computed Styles",
  "## States & Behaviors",
  "## Text Content",
  "## Responsive Behavior",
];
const MAX_BODY_LINES = 150; // complexity budget — bigger spec = split the section
const MIN_BODY_LINES = 25; // thinner than this = extraction was lazy

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error("Usage: node scripts/lint-spec.mjs <spec.md|dir> ...");
  process.exit(1);
}

// Expand directories to *.spec.md files
const files = inputs.flatMap((p) => {
  if (statSync(p).isDirectory()) {
    const found = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".spec.md")) found.push(full);
      }
    };
    walk(p);
    return found;
  }
  return [p];
});

if (!files.length) {
  console.error("No .spec.md files found.");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const raw = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const errors = [];
  const warnings = [];

  // --- frontmatter ---
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fm) {
    errors.push("Missing YAML frontmatter (--- ... ---) at top of file");
  } else {
    const meta = {};
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
      if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
    for (const key of REQUIRED_FRONTMATTER) {
      if (!meta[key]) errors.push(`Frontmatter missing or empty: "${key}"`);
    }
    const light = meta.tier === "light";
    if (meta.tier && !light) {
      errors.push(`tier must be "light" or omitted (got "${meta.tier}")`);
    }
    if (light) {
      const violation = lightTierViolation(basename(file).replace(/\.spec\.md$/, ""));
      if (violation) errors.push(`tier: light rejected — ${violation}. Use the full schema.`);
    }
    if (meta.interaction_model && !INTERACTION_MODELS.includes(meta.interaction_model)) {
      errors.push(`interaction_model must be one of: ${INTERACTION_MODELS.join(", ")} (got "${meta.interaction_model}")`);
    }
    if (meta.target && !meta.target.startsWith("src/")) {
      errors.push(`target should be a path under src/ (got "${meta.target}")`);
    }
    if (meta.screenshot && !existsSync(meta.screenshot)) {
      errors.push(`screenshot file does not exist: ${meta.screenshot}`);
    }
    if (meta.responsive) {
      for (const vp of ["phone", "ipad", "pc"]) {
        if (!meta.responsive.includes(vp)) errors.push(`responsive must cover all three viewports — missing "${vp}"`);
      }
    }

    // --- body ---
    const body = fm[2];
    for (const h of REQUIRED_HEADINGS) {
      if (!body.includes(h)) errors.push(`Missing required heading: "${h}"`);
      else {
        // heading exists but is its section empty?
        const idx = body.indexOf(h);
        const next = body.indexOf("\n## ", idx + h.length);
        const content = body.slice(idx + h.length, next === -1 ? undefined : next).trim();
        if (content.length < 10) errors.push(`Section "${h}" is empty — fill it or write "N/A" with a reason`);
      }
    }
    // Fenced code blocks (the generated Source Markup on utility-CSS sites) are
    // machine-quoted, not hand-written — they don't count against the
    // complexity budget, which exists to bound what a BUILDER has to reason
    // through, and markup is what the builder translates, not extra reasoning.
    let inFence = false;
    let bodyLines = 0;
    for (const line of body.split("\n")) {
      if (/^```/.test(line.trim())) {
        inFence = !inFence;
        continue;
      }
      if (!inFence) bodyLines++;
    }
    if (bodyLines > MAX_BODY_LINES) {
      errors.push(`Spec body is ${bodyLines} lines outside code fences (max ${MAX_BODY_LINES}). Complexity budget exceeded — SPLIT this section into smaller components.`);
    }
    if (bodyLines < MIN_BODY_LINES && !light) {
      warnings.push(`Spec body is only ${bodyLines} lines — is extraction really complete?`);
    }
    if (!/getComputedStyle|px|rem|rgb|oklch/.test(body)) {
      errors.push("No concrete CSS values found in body — computed styles must be extracted, not described");
    }

    // The Responsive section must carry MEASURED NUMBERS for all three viewports,
    // not prose. Real-site testing showed that specs saying "iPad: same layout"
    // make builders guess intermediate values, and every guess costs QA points on
    // sites whose spacing scales with root font-size.
    const rIdx = body.indexOf("## Responsive Behavior");
    if (rIdx !== -1) {
      const rEnd = body.indexOf("\n## ", rIdx + 1);
      const rBody = body.slice(rIdx, rEnd === -1 ? undefined : rEnd);
      const perViewport = { phone: /phone|390/i, ipad: /ipad|tablet|768/i, pc: /pc|desktop|1440/i };
      for (const [vp, re] of Object.entries(perViewport)) {
        const line = rBody.split("\n").find((l) => re.test(l));
        if (!line) {
          errors.push(`Responsive Behavior has no line for "${vp}" — all three viewports must be documented`);
          continue;
        }
        // Strip the viewport width itself, then demand at least two real measurements
        const measurements = line.replace(/\b(390|768|1440)\b/g, "").match(/\d+(\.\d+)?\s*(px|rem|%|col)/gi) || [];
        if (measurements.length < 2) {
          errors.push(
            `Responsive Behavior "${vp}" needs at least 2 measured values with units (e.g. "h2 28px, padding 48px, 2 cols") — got ${measurements.length}. Copy real numbers from responsive.json instead of describing the layout.`
          );
        }
        if (/\b(same|unchanged|identical|as above|no change)\b/i.test(line) && measurements.length < 3) {
          errors.push(
            `Responsive Behavior "${vp}" says "same/unchanged" — spell out the actual values. Sites that scale with root font-size change every number between breakpoints even when the layout looks identical.`
          );
        }
      }
    }
  }

  if (errors.length) {
    failed++;
    console.log(`✗ ${file}`);
    errors.forEach((e) => console.log(`    ERROR: ${e}`));
  } else {
    console.log(`✓ ${file}`);
    markSpecd(file);
  }
  warnings.forEach((w) => console.log(`    warn: ${w}`));
}

// A passing lint IS the "specd" stage transition — report it to the manifest
// instead of relying on a separate agent command. Spec paths follow
// components/<route-slug>/<name>.spec.md; when the slug doesn't invert to a
// route cleanly (nested routes), fall back to the unique section name.
function markSpecd(file) {
  const name = basename(file).replace(/\.spec\.md$/, "");
  const slug = basename(dirname(file));
  const specPath = isAbsolute(file) ? relative(process.cwd(), file) : file;
  const reported = selfReport((m) => {
    let page = findPage(m, slug === "home" ? "/" : `/${slug}`);
    let sec = findSection(page, name);
    if (!sec) {
      const hits = m.pages.flatMap((p) => p.sections.filter((s) => s.name === name).map((s) => [p, s]));
      if (hits.length === 1) [page, sec] = hits[0];
    }
    if (!sec) return false;
    const advanced = advanceStage(sec, "specd");
    const pathChanged = sec.spec !== specPath;
    sec.spec = specPath;
    return advanced || pathChanged;
  });
  if (reported) console.log(`    manifest: ${name} → specd`);
}

console.log(`\n${files.length - failed}/${files.length} specs pass`);
process.exit(failed ? 1 : 0);
