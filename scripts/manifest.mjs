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
//   node scripts/manifest.mjs resume   # one-screen digest: stage table + the
//                                      # exact next commands and file paths
import { existsSync, rmSync, readFileSync } from "node:fs";
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
  case "resume": {
    // One-screen re-orientation after an interruption: the stage table PLUS the
    // exact command(s) to run next with real paths. Five mid-run interruptions
    // in the benchmark each cost minutes of "where was I?" — this answers it.
    const m = load();
    const host = (() => {
      try {
        return new URL(m.site).hostname.replace(/^www\./, "");
      } catch {
        return "<host>";
      }
    })();
    const slugOf = (route) => (route === "/" ? "home" : route.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase());
    const specPathFor = (p, s) => s.spec || `docs/research/components/${slugOf(p.route)}/${s.name}.spec.md`;
    const specTarget = (specPath) => {
      try {
        return readFileSync(specPath, "utf8").match(/^target:\s*(.+)$/m)?.[1]?.trim() || null;
      } catch {
        return null;
      }
    };

    console.log(`Site: ${m.site}  ·  updated ${m.updatedAt || m.createdAt}\n`);
    const actions = [];
    for (const p of m.pages) {
      console.log(`${p.route}  [${p.status}]`);
      if (!p.sections.length) {
        console.log("  (no sections yet)");
        actions.push({ what: `map ${p.route}: extract + register sections`, cmds: [`node scripts/extract/page.mjs ${p.url}${m.pages.indexOf(p) > 0 ? " --no-site-files" : ""}`] });
        continue;
      }
      for (const s of p.sections) {
        const bar = STAGES.map((st) => (STAGES.indexOf(s.stage) >= STAGES.indexOf(st) ? "█" : "·")).join("");
        const scores = Object.entries(s.scores).map(([k, v]) => `${k}:${v}%`).join(" ");
        console.log(`  ${bar}  ${s.name.padEnd(24)} ${s.stage.padEnd(11)} ${scores}`);
      }
      const byStage = (st) => p.sections.filter((s) => s.stage === st);
      for (const s of byStage("discovered")) {
        actions.push({
          what: `extract ${p.route} ${s.name}`,
          cmds: [`node scripts/extract/section.mjs ${p.url} --selector "${s.selector}" --name ${s.name}`],
        });
      }
      for (const s of byStage("extracted")) {
        const spec = specPathFor(p, s);
        actions.push({
          what: `spec ${p.route} ${s.name}`,
          cmds: [
            `node scripts/spec-scaffold.mjs --route ${p.route} --section ${s.name}`,
            `fill the <!-- AGENT: fill --> blocks in ${spec}`,
            `node scripts/lint-spec.mjs ${spec}`,
          ],
        });
      }
      for (const s of byStage("specd")) {
        const spec = specPathFor(p, s);
        const target = specTarget(spec);
        actions.push({
          what: `build ${p.route} ${s.name}`,
          cmds: [
            `dispatch builder — spec ${spec}${target ? ` → ${target}` : ""}, shots docs/design-references/${host}/${s.name}-{pc,ipad,phone}.png`,
          ],
        });
      }
      for (const s of byStage("built")) {
        actions.push({
          what: `merge ${p.route} ${s.name}`,
          cmds: [`merge worktree → npm run typecheck && npm run lint → node scripts/manifest.mjs set --route ${p.route} --section ${s.name} --stage merged`],
        });
      }
      const merged = byStage("merged");
      if (merged.length && merged.length === p.sections.length) {
        actions.push({
          what: `QA ${p.route} (all sections merged)`,
          cmds: [`node scripts/diff.mjs --original ${p.url} --clone http://localhost:3000${p.route === "/" ? "" : p.route} --route ${p.route} --viewport all`],
        });
      } else {
        for (const s of merged) {
          actions.push({
            what: `QA ${p.route} ${s.name}`,
            cmds: [`node scripts/diff.mjs --original ${p.url} --clone http://localhost:3000${p.route === "/" ? "" : p.route} --selector "${s.selector}" --viewport all --name ${s.name}`],
          });
        }
      }
    }

    if (!actions.length) {
      console.log("\nALL DONE — every section is qa_passed. Run the completion report.");
      break;
    }
    console.log(`\nNEXT (${actions.length} pending action(s), first ${Math.min(actions.length, 4)} shown):`);
    for (const a of actions.slice(0, 4)) {
      console.log(`\n▶ ${a.what}`);
      for (const c of a.cmds) console.log(`    ${c}`);
    }
    if (actions.length > 4) console.log(`\n(+${actions.length - 4} more — re-run resume as stages advance)`);
    break;
  }
  default:
    console.error("Commands: init | add-page | add-section | set | status | next | resume");
    process.exit(1);
}
