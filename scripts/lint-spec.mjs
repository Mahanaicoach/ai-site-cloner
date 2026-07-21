#!/usr/bin/env node
// Spec linter — the mechanical gate before any builder agent is dispatched.
// A spec that fails here means extraction is incomplete. No builder until it passes.
//
// Usage: node scripts/lint-spec.mjs <spec.md> [more.spec.md ...]
//        node scripts/lint-spec.mjs docs/research/components   (lints every *.spec.md inside)
// Exit 1 if any spec fails.
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

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
    const bodyLines = body.split("\n").length;
    if (bodyLines > MAX_BODY_LINES) {
      errors.push(`Spec body is ${bodyLines} lines (max ${MAX_BODY_LINES}). Complexity budget exceeded — SPLIT this section into smaller components.`);
    }
    if (bodyLines < MIN_BODY_LINES) {
      warnings.push(`Spec body is only ${bodyLines} lines — is extraction really complete?`);
    }
    if (!/getComputedStyle|px|rem|rgb|oklch/.test(body)) {
      errors.push("No concrete CSS values found in body — computed styles must be extracted, not described");
    }
  }

  if (errors.length) {
    failed++;
    console.log(`✗ ${file}`);
    errors.forEach((e) => console.log(`    ERROR: ${e}`));
  } else {
    console.log(`✓ ${file}`);
  }
  warnings.forEach((w) => console.log(`    warn: ${w}`));
}

console.log(`\n${files.length - failed}/${files.length} specs pass`);
process.exit(failed ? 1 : 0);
