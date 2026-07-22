# ai-site-cloner

![ai-site-cloner](docs/cover.png)

**Point AI at any website. Get a pixel-accurate Next.js clone back — measured, not eyeballed.**

`/clone-website` turns Claude Code (or Cursor, Copilot, Gemini CLI — 12 tools supported) into a full cloning pipeline: it crawls the site, extracts every computed style with scripted Playwright measurement, generates auditable component specs, dispatches parallel builder agents in git worktrees, and loops a scored pixel-diff QA at phone/tablet/desktop widths until every section clears 95%. Then `/restyle` swaps in your own brand — colors, fonts, logo, copy — without touching the cloned layout.

Screenshot-to-code tools guess. This one measures.

## Proof: plausible.io, cloned

Original on the left. AI clone on the right.

![original vs clone](examples/plausible/comparison.png)

9 sections × 3 viewports, scored by pixelmatch against the live site: **6 of 9 sections hit 100% on every viewport**, nothing below 97.5%. That includes the working nav dropdowns, the mobile menu overlay, and the 9-tier pricing slider with its monthly/yearly toggle and recomputing prices.

| Section | PC | iPad | Phone |  | Section | PC | iPad | Phone |
|---|---|---|---|---|---|---|---|---|
| hero | 100% | 100% | 100% |  | story | 99.98% | 99.97% | 100% |
| dashboard | 100% | 100% | 100% |  | nav | 99.2% | 98.8% | 100% |
| features | 100% | 100% | 100% |  | cta | 99.6% | 99.3% | 100% |
| testimonials | 100% | 100% | 100% |  | footer | 100% | 97.7% | 100% |
| pricing | 100% | 100% | 97.5% |  |  |  |  |  |

Full-page and phone side-by-sides, the data file, and how the run went: [`examples/plausible/`](examples/plausible/)

**Second example:** [`examples/uploadthing/`](examples/uploadthing/) — its hero artwork is painted on a `<canvas>`, normally unclonable since there's no DOM to copy. The pipeline records it via `canvas.captureStream()` and embeds a looping video, so the clone keeps the artwork *and* its motion.

## Quick Start

1. Create your own repository from this template (**Use this template** on GitHub), then clone it.
2. Install:
   ```bash
   npm install   # Chromium auto-installs on the first extraction run (or: npm run setup)
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

## How it works

```
Phase 0  Crawl        sitemap + nav discovery → you confirm the page list
Phase 1  Recon        tokens, assets, screenshots, responsive measurements, interaction sweep
Phase 2  Foundation   fonts, color tokens, types, extracted SVG icons, shared header/footer
Phase 3  Sections     extract → spec scaffolded from JSON → lint gate → parallel builders in worktrees → merge
Phase 4  Assembly     one route per page, data wired to components
Phase 5  QA loop      whole-page triage first, then pixel-diff failing sections × 3 viewports until ≥95%
```

The AI never invents a value. Every number a builder uses — font sizes, padding, colors, column counts, hover states, transition durations — comes from a script that measured the live page. Specs are generated from that JSON, a linter blocks incomplete ones, and the pixel score decides when a section is done.

## Why this beats screenshot-to-code

| Problem with "look at a screenshot and code it" | What happens here instead |
|---|---|
| AI guesses CSS values from pixels | `scripts/extract/section.mjs` — full `getComputedStyle()` DOM walk, exact values (stored compact; `resolve-walk.mjs` reads any node) |
| Responsive behavior guessed from desktop | `scripts/extract/responsive.mjs` — real column counts and font steps measured at 390/768/1440px |
| Only the default state gets cloned | `--state` captures diff the DOM before/after every click/hover/scroll — dropdowns, toggles, tab panels, with the appeared nodes and their styles |
| "Looks close enough" QA | `scripts/diff.mjs` — pixel-diff score per section per viewport, 95% to pass; `--triage` diffs the whole page first and touches only sections in failing bands |
| QA says WHERE but not WHAT | `scripts/compare.mjs` — walks original + clone, prints the differing computed properties ordered by visual impact |
| AI mis-transcribes values into specs | `scripts/spec-scaffold.mjs` — mechanical spec sections generated straight from the extraction JSON (Tailwind sites quote the source markup itself) |
| Incomplete specs slip through | `scripts/lint-spec.mjs` — mechanical completeness gate before any builder runs |
| Long runs die and restart from zero | `docs/research/manifest.json` — scripts self-report their stage transitions; `manifest.mjs resume` prints the exact next commands |
| Single-page only | `scripts/extract/crawl.mjs` — sitemap + nav discovery, shared header/footer extracted once |
| `<canvas>` artwork is unclonable | `scripts/extract/canvas.mjs` — records it with `captureStream()`, embeds a looping video |
| Clone is a dead-end copy | Content lives in `src/data/*.ts` + the `/restyle` skill = rebrand without breaking layout |

## Scripts

All plain Playwright — run standalone, no MCP needed:

```bash
node scripts/extract/page.mjs <url>                    # ONE-SHOT recon: tokens, css, assets, responsive,
                                                       #   section walks + every screenshot — 3 page loads, ~15s
node scripts/extract/crawl.mjs <url> [--max 25]        # discover pages
node scripts/extract/page.mjs --rename section-3=hero  # rename auto-detected sections in place (no browser)
node scripts/extract/section.mjs <url> --selector "x" --state hover:".card"   # hover/scroll/click state diffs
node scripts/extract/probe.mjs <url> --selector "x"    # per-viewport value table for specs
node scripts/spec-scaffold.mjs --route / --all         # generate the mechanical spec sections from the
                                                       #   extraction JSON; agent fills judgment blocks only
node scripts/resolve-walk.mjs <sections.json> --node 0.2.1   # resolved styles for any walk node (walks are
                                                       #   stored compact: style dict + inheritance pruning)
node scripts/extract/canvas.mjs <url>                  # capture <canvas> artwork as video/PNG
node scripts/extract/tokens.mjs / css.mjs / assets.mjs / responsive.mjs / screenshot.mjs   # single-purpose re-runs
node scripts/diff.mjs --original <url> --clone <url> --route / --triage --viewport all
                                                       # scored pixel diff QA: whole-page first, per-section
                                                       #   only where bands fail; 10-band breakdown names
                                                       #   WHERE it mismatches; scores land in the manifest
node scripts/compare.mjs --original <url> --clone <url> --selector "x"   # WHAT differs on a failing section:
                                                       #   computed-property table, geometry > typography > color
node scripts/lint-spec.mjs docs/research/components    # spec completeness gate
node scripts/manifest.mjs resume                       # one-screen digest: stage table + exact next commands
```

## Supported agents

The two skills are written once in `.claude/skills/` and synced to every other tool's native format (`node scripts/sync-skills.mjs`; CI fails if generated configs go stale):

**Claude Code** (native) · **Cursor** · **Windsurf** · **GitHub Copilot** · **Gemini CLI** · **Amazon Q** · **Codex** · **Cline** · **Continue** · **opencode** · **Augment** · **Aider** — plus a generic [`AGENTS.md`](AGENTS.md) that most other tools pick up automatically.

The extraction scripts are plain Node CLIs, so any agent can run them. Tools without subagent/worktree support build sections sequentially from the same lint-gated specs — every quality gate still applies.

## Docker

```bash
docker compose up dev    # dev server on :3000, Playwright preinstalled (extraction works in-container)
docker compose up app    # production: slim standalone build of the finished clone
```

## Stack

Next.js 16 (App Router, React 19, TS strict) · Tailwind CSS v4 · shadcn/ui · Playwright + pixelmatch (dev)

Requires Node 22+ (auto via `.nvmrc`).

## Intended Use

Platform migration of sites you own · recovering lost source code · learning how production sites are built.

**Not for** phishing, impersonation, or passing off someone else's design as your own. Check a site's terms before cloning it. The example clones in this repo (plausible.io, uploadthing.com) are technical demonstrations — don't republish anyone's brand.

## License

MIT
