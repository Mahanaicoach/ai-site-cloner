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
import { mkdirSync } from "node:fs";
import {
  VIEWPORTS,
  openPage,
  closeBrowser,
  gotoAndSettle,
  autoScroll,
  freezePage,
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

const t0 = Date.now();
const args = parseArgs(process.argv.slice(2));
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
  const { interactiveCount, blockedCount, ...cssOut } = css;
  writeJson(`docs/research/${host}/css.json`, { ...meta, ...cssOut });
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
  writeJson(`docs/research/${host}/sections/${s.name}.json`, {
    ...meta,
    viewport: "pc",
    selector: s.selector,
    tree: walks[s.selector],
  });
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
      await page.screenshot({ path: `${shotDir}/${pageSlug}-${vp}.png`, fullPage: true });
      if (doSectionShots) {
        for (const s of sections) {
          const loc = page.locator(s.selector).first();
          try {
            await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
            await loc.screenshot({ path: `${shotDir}/${s.name}-${vp}.png`, timeout: 5000 });
          } catch {
            console.error(`  ! section shot failed: ${s.name} @ ${vp}`);
          }
        }
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
