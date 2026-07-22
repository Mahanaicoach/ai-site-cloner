#!/usr/bin/env node
// Pipeline state tracker — makes long clone runs resumable.
// The manifest records every page and section and its stage. The skill reads
// `status` at start and skips anything already done.
//
// Stages: discovered → extracted → specd → built → merged → qa_passed
//
// Usage:
//   node scripts/manifest.mjs init <site-url>
//   node scripts/manifest.mjs add-page --url <url> --route /about
//   node scripts/manifest.mjs add-section --route / --name hero --selector "section.hero"
//   node scripts/manifest.mjs set --route / --section hero --stage built
//   node scripts/manifest.mjs set --route / --section hero --score pc=96.2
//   node scripts/manifest.mjs status
//   node scripts/manifest.mjs next
import { existsSync, rmSync } from "node:fs";
import { parseArgs, CACHE_DIR } from "./lib.mjs";
import { MANIFEST_FILE as FILE, STAGES, loadManifest, saveManifest as save, findPage as findPageIn } from "./manifest-lib.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

const load = () => {
  const m = loadManifest();
  if (!m) {
    console.error(`No manifest at ${FILE} — run: node scripts/manifest.mjs init <url>`);
    process.exit(1);
  }
  return m;
};
const findPage = (m, route) => {
  const p = findPageIn(m, route);
  if (!p) {
    console.error(`Page not found: ${route}. Pages: ${m.pages.map((p) => p.route).join(", ") || "(none)"}`);
    process.exit(1);
  }
  return p;
};

switch (cmd) {
  case "init": {
    const url = rest.find((a) => !a.startsWith("--"));
    if (!url) {
      console.error("Usage: manifest.mjs init <site-url>");
      process.exit(1);
    }
    if (existsSync(FILE) && !args.force) {
      console.error(`Manifest already exists (${FILE}). This is a resumable run — use "status". Pass --force to start over.`);
      process.exit(1);
    }
    // A fresh run starts with a cold response cache — resumed runs keep it.
    if (args.force) rmSync(CACHE_DIR, { recursive: true, force: true });
    save({ site: url, createdAt: new Date().toISOString(), pages: [] });
    console.log(`Initialized ${FILE} for ${url}`);
    break;
  }
  case "add-page": {
    const m = load();
    if (!args.url || !args.route) {
      console.error("Usage: manifest.mjs add-page --url <url> --route </route>");
      process.exit(1);
    }
    if (m.pages.some((p) => p.route === args.route)) {
      console.log(`Page ${args.route} already tracked — skipping`);
      break;
    }
    m.pages.push({ url: args.url, route: args.route, status: "pending", sections: [] });
    save(m);
    console.log(`Added page ${args.route}`);
    break;
  }
  case "add-section": {
    const m = load();
    if (!args.route || !args.name || !args.selector) {
      console.error('Usage: manifest.mjs add-section --route / --name hero --selector "css"');
      process.exit(1);
    }
    const p = findPage(m, args.route);
    if (p.sections.some((s) => s.name === args.name)) {
      console.log(`Section ${args.name} already tracked on ${args.route} — skipping`);
      break;
    }
    p.sections.push({ name: args.name, selector: args.selector, stage: "discovered", spec: null, component: null, scores: {} });
    save(m);
    console.log(`Added section ${args.name} to ${args.route}`);
    break;
  }
  case "set": {
    const m = load();
    const p = findPage(m, args.route);
    const s = p.sections.find((s) => s.name === args.section);
    if (!s) {
      console.error(`Section not found: ${args.section}. Sections: ${p.sections.map((s) => s.name).join(", ")}`);
      process.exit(1);
    }
    if (args.stage) {
      if (!STAGES.includes(args.stage)) {
        console.error(`Invalid stage "${args.stage}". Valid: ${STAGES.join(" → ")}`);
        process.exit(1);
      }
      s.stage = args.stage;
    }
    if (args.spec) s.spec = args.spec;
    if (args.component) s.component = args.component;
    if (args.score) {
      const [vp, val] = String(args.score).split("=");
      s.scores[vp] = Number(val);
    }
    // page auto-status
    p.status = p.sections.every((x) => x.stage === "qa_passed") ? "done" : "in_progress";
    save(m);
    console.log(`${args.route} ${s.name}: stage=${s.stage} scores=${JSON.stringify(s.scores)}`);
    break;
  }
  case "status": {
    const m = load();
    console.log(`Site: ${m.site}\n`);
    for (const p of m.pages) {
      console.log(`${p.route}  [${p.status}]`);
      for (const s of p.sections) {
        const bar = STAGES.map((st) => (STAGES.indexOf(s.stage) >= STAGES.indexOf(st) ? "█" : "·")).join("");
        const scores = Object.entries(s.scores).map(([k, v]) => `${k}:${v}%`).join(" ");
        console.log(`  ${bar}  ${s.name.padEnd(24)} ${s.stage.padEnd(11)} ${scores}`);
      }
      if (!p.sections.length) console.log("  (no sections yet)");
    }
    break;
  }
  case "next": {
    const m = load();
    for (const p of m.pages) {
      const s = p.sections.find((s) => s.stage !== "qa_passed");
      if (s) {
        console.log(JSON.stringify({ route: p.route, url: p.url, section: s.name, selector: s.selector, stage: s.stage, spec: s.spec }, null, 2));
        process.exit(0);
      }
    }
    const pendingPage = m.pages.find((p) => !p.sections.length);
    if (pendingPage) {
      console.log(JSON.stringify({ route: pendingPage.route, url: pendingPage.url, note: "page has no sections yet — run topology/extraction" }, null, 2));
    } else {
      console.log("ALL DONE — every section is qa_passed");
    }
    break;
  }
  default:
    console.error("Commands: init | add-page | add-section | set | status | next");
    process.exit(1);
}
