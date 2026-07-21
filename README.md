# site-cloner

![site-cloner](docs/cover.png)

Clone any multi-page website into a clean Next.js codebase with Claude Code — then rebrand it as your own.

Point it at a URL. `/clone-website` crawls the site, measures everything with scripted Playwright extraction (no eyeballing), writes auditable component specs, dispatches parallel builder agents in git worktrees, and loops a scored pixel-diff QA at phone/iPad/PC widths until every section passes. Then `/restyle` swaps in your brand — colors, fonts, logo, copy — without touching the cloned layout.

## Quick Start

1. Create your own repository from this template (**Use this template** on GitHub), then clone it.
2. Install:
   ```bash
   npm install
   npx playwright install chromium
   ```
3. Start Claude Code (Chrome integration recommended for interaction discovery):
   ```bash
   claude --chrome
   ```
4. Clone a site:
   ```
   /clone-website https://example.com
   ```
5. Make it yours: fill in `BRAND.md`, then:
   ```
   /restyle
   ```

## What's Better Than Eyeball Cloning

| Problem | Solution here |
|---|---|
| Agent guesses CSS values from screenshots | `scripts/extract/section.mjs` — full `getComputedStyle()` DOM walk, exact values |
| Responsive behavior guessed from desktop | `scripts/extract/responsive.mjs` — measures real column counts at 390/768/1440px |
| "Looks close enough" QA | `scripts/diff.mjs` — pixel-diff score per section per viewport; 95% threshold to pass |
| Incomplete specs slip through | `scripts/lint-spec.mjs` — mechanical completeness gate before any builder runs |
| Long runs die and restart from zero | `docs/research/manifest.json` — every section's stage tracked; runs resume where they stopped |
| Single-page only | `scripts/extract/crawl.mjs` — sitemap + nav discovery, shared header/footer extracted once |
| Clone is a dead-end copy | Content in `src/data/*.ts` + `/restyle` skill = rebrand without breaking layout |

## Example

[`examples/uploadthing/`](examples/uploadthing/) is a real end-to-end run against **uploadthing.com** — side-by-side screenshots, the per-viewport score table (96–99.8% per section), and the tooling bugs that run exposed and fixed.

![original vs clone](examples/uploadthing/comparison.png)

Its hero illustration is painted on a `<canvas>` — normally unclonable, since there's no DOM to copy. The pipeline records it through `canvas.captureStream()` and embeds a looping video, so the clone keeps the artwork *and* its motion.

## Pipeline

```
Phase 0  Crawl        sitemap + nav discovery → you confirm the page list
Phase 1  Recon        tokens, assets, screenshots, responsive measurements, interaction sweep
Phase 2  Foundation   fonts, color tokens, types, extracted SVG icons, shared header/footer
Phase 3  Sections     extract → spec file → lint gate → parallel builders in worktrees → merge
Phase 4  Assembly     one route per page, data wired to components
Phase 5  QA loop      pixel-diff every section × 3 viewports until ≥95% match
```

## Scripts

All plain Playwright — run standalone, no MCP needed:

```bash
node scripts/extract/crawl.mjs <url> [--max 25]        # discover pages
node scripts/extract/tokens.mjs <url>                  # colors, fonts, CSS vars
node scripts/extract/assets.mjs <url>                  # download all images/videos/SVGs/fonts
node scripts/extract/section.mjs <url> --selector "x"  # computed styles (+ --state for hover/scroll/click diffs)
node scripts/extract/screenshot.mjs <url>              # phone/iPad/PC screenshots
node scripts/extract/responsive.mjs <url>              # real layout changes across viewports
node scripts/extract/probe.mjs <url> --selector "x"    # per-viewport value table for specs
node scripts/extract/css.mjs <url>                     # real :hover/:focus rules + breakpoints from the stylesheets
node scripts/extract/canvas.mjs <url>                  # capture <canvas> artwork as video/PNG
node scripts/diff.mjs --original <url> --clone <url>   # scored pixel diff
node scripts/lint-spec.mjs docs/research/components    # spec completeness gate
node scripts/manifest.mjs status                       # pipeline state / resume point
```

## Stack

Next.js 16 (App Router, React 19, TS strict) · Tailwind CSS v4 · shadcn/ui · Playwright + pixelmatch (dev)

Requires Node 22+.

## Intended Use

Platform migration of sites you own · recovering lost source code · learning how production sites are built.

**Not for** phishing, impersonation, or passing off someone else's design as your own. Check a site's terms before cloning it.

## License

MIT
