// Shared manifest IO — used by the manifest.mjs CLI and by the scripts that
// self-report pipeline progress (page.mjs -> extracted, lint-spec.mjs -> specd,
// diff.mjs -> scores + qa_passed). During the benchmark the manifest lagged
// reality because every update was a separate agent command; the scripts now do
// their own bookkeeping at the moment the work happens.
//
// Deliberately dependency-free (no lib.mjs import): lint-spec must not pay a
// playwright module load just to flip a stage.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

export const MANIFEST_FILE = "docs/research/manifest.json";
export const STAGES = ["discovered", "extracted", "specd", "built", "merged", "qa_passed"];

export function loadManifest() {
  if (!existsSync(MANIFEST_FILE)) return null;
  return JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
}

export function saveManifest(m) {
  m.updatedAt = new Date().toISOString();
  mkdirSync("docs/research", { recursive: true });
  writeFileSync(MANIFEST_FILE, JSON.stringify(m, null, 2) + "\n");
}

export function findPage(m, route) {
  return m?.pages?.find((p) => p.route === route) || null;
}

export function findSection(page, name) {
  return page?.sections?.find((s) => s.name === name) || null;
}

// URL pathname -> route, mirroring lib.mjs routeOf without importing it.
export function routeOfUrl(url) {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, "");
    return p === "" ? "/" : p;
  } catch {
    return null;
  }
}

// Auto-reporters only ever move a section FORWARD. A re-run of an early-phase
// script must not demote a section a human (or a later script) already
// advanced — manual `manifest.mjs set` remains the override for that.
export function advanceStage(section, stage) {
  if (STAGES.indexOf(stage) > STAGES.indexOf(section.stage)) {
    section.stage = stage;
    return true;
  }
  return false;
}

export function updatePageStatus(page) {
  page.status =
    page.sections.length && page.sections.every((s) => s.stage === "qa_passed") ? "done" : "in_progress";
}

// Wrapper for self-reporting scripts: no manifest -> silent no-op; a broken
// manifest must never take down the actual work. `fn(m)` returns truthy when
// it changed something worth saving.
export function selfReport(fn) {
  try {
    const m = loadManifest();
    if (!m) return false;
    const changed = fn(m);
    if (changed) saveManifest(m);
    return !!changed;
  } catch (e) {
    console.error(`  (manifest self-report skipped: ${e.message})`);
    return false;
  }
}
