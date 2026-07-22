#!/usr/bin/env node
// ONE-SHOT page recon: everything Phase 1 + the default-state part of Phase 3a
// need, from THREE page loads total (one per viewport, all concurrent).
//
// From those three live pages this produces:
//   docs/research/<host>/tokens.json          design tokens          (pc)
//   docs/research/<host>/css.json             real CSS rules/states  (pc)
//   docs/research/<host>/assets.json          asset inventory + downloads to public/
//   docs/research/<host>/responsive.json      per-section signatures @ all 3 viewports
//   docs/research/<host>/sections/<name>.json full computed-style walk per section (pc)
//   docs/design-references/<host>/page-{pc,ipad,phone}.png        full-page shots
//   docs/design-references/<host>/<name>-{pc,ipad,phone}.png      per-section shots
//
// Replaces running tokens.mjs + css.mjs + assets.mjs + responsive.mjs +
// screenshot.mjs + a batched section.mjs one after another (~15 page loads).
// Every measurement also comes from the SAME page state, so numbers, walks and
// screenshots can never disagree about what the page looked like.
//
// Usage:
//   node scripts/extract/page.mjs <url>
//     [--selector "css" --name x ...]   explicit sections (skips auto-detect)
//     [--depth 5] [--no-download] [--no-shots] [--no-section-shots]
//     [--no-site-files]                 skip tokens.json/css.json (they're
//                                       site-wide — only the first page needs them)
//     [--legacy]                        emit the old full-blob walk format
//                                       (default is compact-v1: style dictionary
//                                       + inherited-prop pruning, ~70% smaller;
//                                       resolve any node with resolve-walk.mjs)
//
//   node scripts/extract/page.mjs --rename section-3=hero,section-4=features [--host <h>]
//     NO browser: renames the section JSONs (incl. state captures), probe files,
//     screenshots, responsive.json and manifest entries in place. Use when
//     detection got the sections right but the auto-names wrong — re-running the
//     extraction just to rename costs 3 page loads for nothing.
import { mkdirSync, existsSync, renameSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import {
  VIEWPORTS,
  openPage,
  closeBrowser,
  gotoAndSettle,
  autoScroll,
  freezePage,
  shootSectionsFromFullPage,
  hostOf,
  writeJson,
  parseArgs,
  toList,
} from "../lib.mjs";
import {
  collectTokens,
  collectCss,
  collectAssets,
  downloadAssets,
  detectSections,
  measureSections,
  summarizeResponsive,
  walkSections,
  nameFromSelector,
} from "./collectors.mjs";
import { compactWalk, toLegacy } from "./walk-format.mjs";

const t0 = Date.now();
const args = parseArgs(process.argv.slice(2));

// ── rename mode: pure file/manifest surgery, exits before any browser work ──
if (args.rename) {
  const pairs = String(args.rename).split(",").map((s) => s.trim()).filter(Boolean).map((p) => {
    const eq = p.indexOf("=");
    if (eq < 1) {
      console.error(`Bad --rename "${p}" — use old=new[,old2=new2]`);
      process.exit(1);
    }
    return { from: p.slice(0, eq).trim(), to: p.slice(eq + 1).trim() };
  });
  const manifestPath = "docs/research/manifest.json";
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  let renameHost = typeof args.host === "string" ? args.host : manifest?.site ? hostOf(manifest.site) : null;
  if (!renameHost) {
    const dirs = existsSync("docs/research")
      ? readdirSync("docs/research").filter((d) => existsSync(`docs/research/${d}/sections`))
      : [];
    if (dirs.length === 1) renameHost = dirs[0];
  }
  if (!renameHost) {
    console.error("--rename needs --host <host> (no manifest or single research dir to derive it from)");
    process.exit(1);
  }
  const sectionsDir = `docs/research/${renameHost}/sections`;
  const shotsDir = `docs/design-references/${renameHost}`;
  const mv = (from, to) => {
    if (!existsSync(from)) return false;
    renameSync(from, to);
    console.log(`  ✓ ${from} → ${to}`);
    return true;
  };

  for (const { from, to } of pairs) {
    if (existsSync(`${sectionsDir}/${to}.json`)) {
      console.error(`  ! target name "${to}" already exists in ${sectionsDir} — skipping "${from}"`);
      continue;
    }
    let any = mv(`${sectionsDir}/${from}.json`, `${sectionsDir}/${to}.json`);
    if (existsSync(sectionsDir)) {
      for (const f of readdirSync(sectionsDir)) {
        // state captures follow their base section (hero-hover.json etc.)
        if (f.startsWith(`${from}-`) && f.endsWith(".json")) {
          any = mv(`${sectionsDir}/${f}`, `${sectionsDir}/${to}-${f.slice(from.length + 1)}`) || any;
        }
      }
    }
    mv(`docs/research/${renameHost}/probe-${from}.json`, `docs/research/${renameHost}/probe-${to}.json`);
    if (existsSync(shotsDir)) {
      for (const f of readdirSync(shotsDir)) {
        if (f.startsWith(`${from}-`) && /^(pc|ipad|phone)(-review)?\.png$/.test(f.slice(from.length + 1))) {
          mv(`${shotsDir}/${f}`, `${shotsDir}/${to}-${f.slice(from.length + 1)}`);
        }
      }
    }
    const respPath = `docs/research/${renameHost}/responsive.json`;
    if (existsSync(respPath)) {
      const resp = JSON.parse(readFileSync(respPath, "utf8"));
      let hits = 0;
      for (const s of resp.sections || []) if (s.name === from) (s.name = to), hits++;
      if (hits) {
        writeFileSync(respPath, JSON.stringify(resp, null, 2) + "\n");
        console.log(`  ✓ responsive.json: "${from}" → "${to}"`);
      }
    }
    if (manifest) {
      for (const p of manifest.pages || []) {
        for (const s of p.sections || []) {
          if (s.name !== from) continue;
          s.name = to;
          if (s.spec?.includes(`/${from}.spec.md`)) {
            const ns = s.spec.replace(`/${from}.spec.md`, `/${to}.spec.md`);
            mv(s.spec, ns);
            s.spec = ns;
          }
          console.log(`  ✓ manifest: ${p.route} "${from}" → "${to}"`);
        }
      }
    }
    if (!any) console.error(`  ! no files found for section "${from}" under ${sectionsDir}`);
  }
  if (manifest) {
    manifest.updatedAt = new Date().toISOString();
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  process.exit(0);
}

const url = args._[0];
if (!url) {
  console.error('Usage: node scripts/extract/page.mjs <url> [--selector "css" --name x ...] [--depth 5] [--no-download] [--no-shots] [--no-site-files]');
  process.exit(1);
}
const host = hostOf(url);
const depth = Number(args.depth ?? 5);
const explicit = toList(args.selector);
const explicitNames = toList(args.name);
const doDownload = !args["no-download"];
const doShots = !args["no-shots"];
const doSectionShots = doShots && !args["no-section-shots"];
const doSiteFiles = !args["no-site-files"]; // tokens.json + css.json are site-wide — skip on later pages
const shotDir = `docs/design-references/${host}`;
const pageSlug = new URL(url).pathname.replace(/\/+$/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "page";

// ── 1. Load all three viewports concurrently (the only page loads) ──────────
const loaded = Object.fromEntries(
  await Promise.all(
    ["pc", "ipad", "phone"].map(async (vp) => {
      const { page, close } = await openPage(VIEWPORTS[vp]);
      await gotoAndSettle(page, url);
      await autoScroll(page, { force: true }); // full-page shots need lazy content everywhere
      return [vp, { page, close }];
    })
  )
);
const pc = loaded.pc.page;
console.error(`  ✓ loaded @ pc/ipad/phone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ── 2. Sections: explicit or auto-detected on the desktop layout ────────────
let sections;
if (explicit.length) {
  sections = explicit.map((selector, i) => ({ selector, name: explicitNames[i] || nameFromSelector(selector, i) }));
} else {
  const detected = await detectSections(pc);
  const used = new Set();
  sections = detected.map((s, i) => {
    let name = nameFromSelector(s.selector, i);
    while (used.has(name)) name += "-2";
    used.add(name);
    return { selector: s.selector, name };
  });
}

// ── 3. Measure everything (order matters: measure BEFORE freeze/screenshots) ─
const selectors = sections.map((s) => s.selector);
const [signatures, walks, tokens, css, assetsFound] = await Promise.all([
  // signatures at all three viewports — one evaluate per page
  (async () => {
    const out = {};
    await Promise.all(
      Object.entries(loaded).map(async ([vp, { page }]) => {
        out[vp] = await measureSections(page, selectors);
      })
    );
    return out;
  })(),
  walkSections(pc, selectors, { depth }),
  doSiteFiles ? collectTokens(pc) : null,
  doSiteFiles ? collectCss(pc) : null,
  collectAssets(pc),
]);

// ── 4. Write research files ─────────────────────────────────────────────────
const meta = { url, generatedAt: new Date().toISOString() };
if (tokens) writeJson(`docs/research/${host}/tokens.json`, { ...meta, ...tokens });
if (css) {
  // interactiveCount/blockedCount are stdout-summary fields, not research data
  const cssOut = { ...meta, ...css };
  delete cssOut.interactiveCount;
  delete cssOut.blockedCount;
  writeJson(`docs/research/${host}/css.json`, cssOut);
}
writeJson(`docs/research/${host}/responsive.json`, {
  ...meta,
  viewports: { phone: 390, ipad: 768, pc: 1440 },
  sections: sections.map((s) => ({
    selector: s.selector,
    name: s.name,
    phone: signatures.phone[s.selector],
    ipad: signatures.ipad[s.selector],
    pc: signatures.pc[s.selector],
    summary: summarizeResponsive(signatures, s.selector),
  })),
});
for (const s of sections) {
  const walk = walks[s.selector];
  const base = { ...meta, viewport: "pc", selector: s.selector };
  if (args.legacy || walk?.error) {
    writeJson(`docs/research/${host}/sections/${s.name}.json`, { ...base, tree: args.legacy ? toLegacy(walk) : walk });
  } else {
    const { tree, styleTable } = compactWalk(walk);
    writeJson(`docs/research/${host}/sections/${s.name}.json`, { ...base, format: "compact-v1", tree, styleTable });
  }
}

// ── 5. Downloads + screenshots overlap (network vs browser work) ────────────
const jobs = [];

if (doDownload) {
  jobs.push(
    downloadAssets(assetsFound, { pool: 8 }).then((manifest) => {
      writeJson(`docs/research/${host}/assets.json`, { ...meta, ...assetsFound, downloads: manifest });
      const ok = manifest.filter((m) => m.ok).length;
      const cached = manifest.filter((m) => m.cached).length;
      const fail = manifest.filter((m) => !m.ok).length;
      console.error(`  ✓ assets: ${ok} ok (${cached} already on disk), ${fail} failed`);
    })
  );
} else {
  writeJson(`docs/research/${host}/assets.json`, { ...meta, ...assetsFound, downloads: [] });
}

if (doShots) {
  mkdirSync(shotDir, { recursive: true });
  jobs.push(
    ...Object.entries(loaded).map(async ([vp, { page }]) => {
      await freezePage(page); // deterministic pixels — safe now, measuring is done
      if (doSectionShots) {
        // One full-page capture yields the page shot AND every section crop —
        // no per-section scroll+shoot chain.
        const { failed } = await shootSectionsFromFullPage(page, sections, {
          fullPagePath: `${shotDir}/${pageSlug}-${vp}.png`,
          pathFor: (s) => `${shotDir}/${s.name}-${vp}.png`,
        });
        for (const name of failed) console.error(`  ! section shot failed: ${name} @ ${vp}`);
      } else {
        await page.screenshot({ path: `${shotDir}/${pageSlug}-${vp}.png`, fullPage: true });
      }
      console.error(`  ✓ screenshots @ ${vp}`);
    })
  );
}

await Promise.all(jobs);
await Promise.all(Object.values(loaded).map((l) => l.close()));
await closeBrowser();

// ── 6. Summary the foreman can read at a glance ─────────────────────────────
console.log(
  JSON.stringify(
    {
      url,
      seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
      sections: sections.map((s) => ({
        name: s.name,
        selector: s.selector,
        pcHeight: signatures.pc[s.selector]?.height ?? null,
        responsive: summarizeResponsive(signatures, s.selector).changes[0],
      })),
      siteFiles: doSiteFiles ? ["tokens.json", "css.json"] : [],
      files: {
        research: `docs/research/${host}/`,
        screenshots: doShots ? shotDir : null,
      },
    },
    null,
    2
  )
);
