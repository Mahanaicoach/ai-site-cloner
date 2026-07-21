---
name: clone-website
description: Reverse-engineer and clone a full multi-page website into this Next.js codebase — crawls pages, runs scripted extraction (tokens, assets, computed styles, responsive layout at phone/iPad/PC), writes auditable component specs, dispatches parallel builder agents in worktrees, and loops a scored pixel-diff QA until every section passes. Use whenever the user wants to clone, replicate, rebuild, reverse-engineer, or copy any website. Resumable — safe to re-run after an interruption.
argument-hint: "<url> [extra instructions]"
user-invocable: true
---

# Clone Website

Reverse-engineer and rebuild **$ARGUMENTS** as a pixel-accurate, multi-page Next.js clone.

You are a **foreman walking the job site**: scripts do the measuring, you do the judgment, specs are the contract, builder agents do the construction, and the pixel-diff score decides when you're done. Extraction and construction overlap — dispatch builders as soon as a section's spec passes lint, then keep extracting.

## Resume Check (ALWAYS FIRST)

```bash
node scripts/manifest.mjs status
```

If a manifest exists, this is a **resumed run**: skip everything already done (`node scripts/manifest.mjs next` tells you where to continue). If not, this is a fresh run — start at Phase 0.

## Scope Defaults

- **Fidelity:** pixel-accurate — colors, spacing, typography, animations, interactions
- **In scope:** every confirmed page, visual layout, component structure, interactions, responsive behavior (phone 390 / iPad 768 / PC 1440), real content and assets
- **Out of scope:** real backend, auth, databases, forms that actually submit (mock them)
- **Content goes in `src/data/*.ts`** — components take props; page files wire data to components. This keeps the clone restylable later (see `/restyle`).

User-provided instructions override these defaults.

## Tooling

Ten scripts do the mechanical work — **use them instead of hand-measuring via browser MCP**:

| Script | Purpose |
|---|---|
| `node scripts/extract/crawl.mjs <url> [--max 25]` | Discover pages (sitemap + nav links) → `docs/research/<host>/sitemap.json` |
| `node scripts/extract/tokens.mjs <url>` | Colors, fonts, :root CSS vars, shadows, global scroll behaviors → `tokens.json` |
| `node scripts/extract/assets.mjs <url>` | Enumerate + download all images/videos/SVGs/favicons/fonts → `public/`, `assets.json` |
| `node scripts/extract/section.mjs <url> --selector "css" [--name x] [--state scroll:600\|click:sel\|hover:sel] [--viewport pc\|ipad\|phone]` | Full computed-style DOM walk. **`--selector`/`--name` repeat — pass every section in one call and they all extract from a single page load.** `--state` captures a second state and diffs them (element styles *and* `::before`/`::after`), waiting for the section's real transition duration |
| `node scripts/extract/screenshot.mjs <url> [--selector css] [--name x]` | Screenshots at phone/iPad/PC → `docs/design-references/<host>/` |
| `node scripts/extract/responsive.mjs <url> [--selector css]` | Auto-detects sections and measures each one's real layout (actual column counts, hidden elements, font sizes) at all 3 viewports → `responsive.json` |
| `node scripts/extract/probe.mjs <url> --selector "css" [--selector "css2"] [--props a,b,c]` | Exact computed values for specific selectors at all 3 viewports, as a markdown table with a **varies** column — paste straight into a spec's Responsive section |
| `node scripts/diff.mjs --original <url> --clone <url> [--selector css] [--viewport pc] [--threshold 95]` | Scored pixel diff, original vs clone |
| `node scripts/lint-spec.mjs <spec.md\|dir>` | Mechanical spec-completeness gate — must pass before ANY builder dispatch |
| `node scripts/manifest.mjs <cmd>` | Pipeline state: init / add-page / add-section / set / status / next |

Browser MCP (Chrome MCP, Playwright MCP — if available) is for **judgment work only**: watching how the page behaves while scrolling, exploring what's clickable, understanding an animation. Numbers always come from the scripts. If no browser MCP is available, the scripts alone are sufficient — use extra `screenshot.mjs` and `section.mjs --state` calls to observe behavior.

## Guiding Principles

1. **Completeness beats speed.** A builder that has to guess a color, font size, or padding value means extraction failed. Extract one more property rather than ship an incomplete spec.
2. **Small tasks, perfect results.** One focused component per builder. Spec body over 150 lines = split the section (lint-spec enforces this).
3. **Real content, real assets.** Actual text via the section walker, actual files via `assets.mjs`. Watch for **layered images** — a hero that looks like one image is often background + overlay + foreground; `assets.json` records sibling counts and z-index for exactly this reason.
4. **Foundation first.** Tokens, fonts, types, icons, and shared chrome (header/footer) before any page section.
5. **Extract how it looks AND how it behaves.** Every interactive element needs before/after states with exact values — `section.mjs --state` produces the diff mechanically.
6. **Identify the interaction model before building.** Scroll-driven vs click-driven confusion is the most expensive mistake in cloning — a wrong call means a rewrite, not a CSS fix. Scroll first without clicking and watch; only then click. Record the model in the spec frontmatter.
7. **Responsive is measured, never guessed — at all three widths.** Fill every spec's Responsive section from `responsive.json` + `probe.mjs`, with real numbers for phone AND iPad AND pc. Never write "iPad: same as desktop": most production sites step their root font-size at breakpoints, so *every* padding, margin, and font size changes even when the layout looks identical. A spec that only nails desktop produces a clone that scores ~98% at 1440px and ~91% at 390px. `lint-spec.mjs` rejects vague responsive sections.

8. **The extraction JSON is ground truth; the spec is a summary of it.** If a builder finds the spec disagreeing with `sections/<name>.json` or `responsive.json`, the JSON wins — say so explicitly in every builder prompt and have the builder report the discrepancy so you can correct the spec.
9. **Spec files are the contract.** No spec → no builder. lint-spec must pass → then dispatch.
10. **The build must always compile.** Builders verify `npx tsc --noEmit`; you verify `npm run build` after every merge.
11. **The manifest is updated at every stage transition.** That's what makes the run resumable.

## Phase 0 — Crawl & Scope

1. Verify the base builds: `npm run build`.
2. `node scripts/extract/crawl.mjs <url> --max 25`
3. Show the user the discovered pages (route + source). **Ask which to clone** — recommend: start page + nav pages, skip legal/utility pages unless asked. Default cap ~10.
4. Initialize state:
   ```bash
   node scripts/manifest.mjs init <url>
   node scripts/manifest.mjs add-page --url <url> --route /        # per confirmed page
   ```

## Phase 1 — Recon (per site, then per page)

**Site-wide (once):**
1. `tokens.mjs` on the start page → read `tokens.json`
2. `assets.mjs` on every confirmed page (it dedupes downloads across pages)
3. `screenshot.mjs` full-page on every confirmed page — these are the master references
4. `responsive.mjs` on every confirmed page → real layout changes per section
5. **Interaction sweep** (judgment work — browser MCP if available): scroll each page slowly top to bottom. Does the header change? Do elements animate in? Auto-switching tabs? Scroll-snap? Smooth-scroll lib (`tokens.json` flags `.lenis`/Locomotive)? Then click every tab/pill/accordion and note what changes. Then hover. Record findings in `docs/research/<host>/BEHAVIORS.md`.
6. **Shared chrome detection:** compare screenshots across pages — header/nav/footer that repeat become SHARED components (`SiteHeader`, `SiteFooter`), extracted once from the page where they're most complete.

**Per page — topology:** map every distinct section top to bottom with a working name, its selector, its interaction model (static / click-driven / scroll-driven / hover-driven / time-driven / mixed), and layer notes (sticky? overlay? z-index?). Save `docs/research/<host>/PAGE_TOPOLOGY.md`, then register each section:
```bash
node scripts/manifest.mjs add-section --route / --name hero --selector "section.hero"
```

## Phase 2 — Foundation (sequential, you do it yourself)

1. **Fonts** in `src/app/layout.tsx` via `next/font/google` or `next/font/local` (downloaded fonts are in `public/fonts/`) — families/weights from `tokens.json`
2. **`globals.css`**: map the target's palette onto the shadcn `:root` token names; add custom properties for colors that don't map; add global keyframes, scroll-snap, smooth-scroll setup found in recon
3. **TypeScript interfaces** in `src/types/` for the content structures you observed
4. **Icons**: convert the deduplicated `inlineSvgs` from `assets.json` into named components in `src/components/icons.tsx` (named by function: `LogoIcon`, `ArrowRightIcon`…)
5. **SEO**: favicons/OG from `public/seo/` wired into `layout.tsx` metadata
6. Verify `npm run build`, then build **shared chrome** (header/footer) first — full spec → lint → builder cycle like any section, since every page depends on them.

## Phase 3 — Per-Section Loop (extract → spec → lint → dispatch → merge)

Work through `manifest.mjs next` until no sections remain. For each section:

### 3a. Extract

**Batch the default-state walk once per page, not once per section.** Every `--selector`
shares a single page load, so this is one navigation instead of N:

```bash
# ONE call covering every section on the page — do this before the per-section loop
node scripts/extract/section.mjs <page-url> \
  --selector "<sel-1>" --name <name-1> \
  --selector "<sel-2>" --name <name-2> \
  --selector "<sel-3>" --name <name-3>
```

Then per section:
```bash
node scripts/extract/screenshot.mjs <page-url> --selector "<sel>" --name <name>          # all 3 viewports, in parallel
node scripts/extract/probe.mjs <page-url> --selector "<sel>" --selector "<sel> h2"        # per-viewport table for the Responsive section
# per discovered behavior — one call per state:
node scripts/extract/section.mjs <page-url> --selector "<sel>" --name <name>-hover --state hover:".card"
node scripts/extract/section.mjs <page-url> --selector "<sel>" --name <name>-scrolled --state scroll:600
# per tab/pill state: --state click:".tab-2" etc. EVERY state, not just the default.
```
State captures wait for the section's actual transition duration, so a slow fade is
recorded at its end value, not mid-flight — check `settleMs` in the output if a diff
looks wrong. The `diff` array covers `::before`/`::after` too, which is where hover
overlays usually live.

Mark: `manifest.mjs set --route <r> --section <name> --stage extracted`

### 3b. Write the spec — `docs/research/components/<route-slug>/<name>.spec.md`

```markdown
---
component: HeroSection
target: src/components/HeroSection.tsx
page: /
screenshot: docs/design-references/<host>/<name>-pc.png
interaction_model: static | click-driven | scroll-driven | hover-driven | time-driven | mixed
states: default, hover, scrolled…
assets: public/images/x.webp, icons:ArrowRightIcon
responsive: phone, ipad, pc
---

# <Component> Specification

## DOM Structure
<hierarchy from the section walker — what contains what>

## Computed Styles
<exact values from sections/<name>.json, per element. Never estimated.>

## States & Behaviors
<per behavior: Trigger / State A / State B / Transition — from the --state diffs.
 Include the implementation approach (CSS transition, IntersectionObserver, etc.)>

## Per-State Content
<for tabbed/stateful sections: full content per state. "N/A — static" otherwise>

## Assets
<local public/ paths + icon components used. Note layered compositions explicitly.>

## Text Content
<verbatim from the walker output — never paraphrased>

## Responsive Behavior
<from responsive.json: real column counts and changes at 390 / 768 / 1440 + breakpoint>
```

### 3c. Lint gate
```bash
node scripts/lint-spec.mjs docs/research/components/<route-slug>/<name>.spec.md
```
Fails → extract more. Passes → `manifest.mjs set … --stage specd` and dispatch.

### 3d. Dispatch builder agent (worktree)

Every builder receives IN ITS PROMPT (never "go read the file"):
- The **full spec file contents inline**
- The screenshot paths (all 3 viewports)
- Shared imports available: `cn()`, `icons.tsx` components, shadcn `ui/` primitives, types from `src/types/`
- The target file path, and the data file to create in `src/data/` if the section has content collections
- The rule: verify `npx tsc --noEmit` passes before finishing
- **The ground-truth rule:** "`docs/research/<host>/sections/<name>.json` and `responsive.json` are ground truth. If this spec contradicts them, follow the JSON and report the discrepancy." Builders reliably catch spec errors this way — treat their reports as corrections to make to the spec file.

Complex section (3+ distinct sub-components) → one builder per sub-component + one for the wrapper, sub-components first. **Don't wait** — while builders run, extract the next section.

### 3e. Merge
As builders finish: merge worktree → `npm run build` → fix type errors immediately → `manifest.mjs set … --stage merged`.

## Phase 4 — Page Assembly

Per page: create `src/app/<route>/page.tsx` importing its section components with data from `src/data/`, plus page-level behaviors (scroll-snap, observers, smooth scroll). Shared chrome mounts in `layout.tsx` or a route group layout. Wire internal nav links to the cloned routes. `npm run build` must pass.

## Phase 5 — Scored QA Loop

Start the clone: `npm run dev` (background). Then for **every section × every viewport**:

```bash
node scripts/diff.mjs --original <orig-page-url> --clone http://localhost:3000<route> --selector "<sel>" --viewport pc   # then ipad, then phone
node scripts/manifest.mjs set --route <r> --section <name> --score pc=<match>
```

- **Pass = ≥95% on all three viewports** → `--stage qa_passed`
- Below 95% → open the diff image in `docs/research/qa/`, find the discrepancy, check the spec (wrong extraction → re-extract and fix; right spec, wrong build → fix component), re-diff
- A large height mismatch reported by diff.mjs = missing content or wrong spacing — fix before pixel-tweaking
- Max 3 fix iterations per section, then record the gap honestly and move on
- **Text-heavy sections at phone width often plateau at 90–95%** when the target's font isn't available on Google Fonts (e.g. Source Sans Pro → Source Sans 3). Different metrics = different wrap points = unavoidable pixel drift. Confirm the layout matches, note the substitution, and accept it.
- **A score that's high at pc but low at ipad/phone is always a responsive-spec problem**, not a styling bug. Re-run `probe.mjs` on the section and fill in the values the spec was missing.
- Finally, test behaviors manually: scroll, click every tab, hover — screenshots can't verify motion; you must

Whole-page diffs (`--selector` omitted) at all 3 viewports close out each page.

## What NOT to Do

- **Don't build click-tabs when the original is scroll-driven** (or vice versa). Scroll first, watch, then click. Wrong model = rewrite.
- **Don't extract only the default state.** Every tab clicked, every hover captured, header at scroll 0 AND past the trigger.
- **Don't miss layered/overlay images** — check `siblingImgs` and z-index hints in `assets.json`.
- **Don't build HTML mockups of things that are actually `<video>`, Lottie, or canvas.** Check first.
- **Don't approximate ("looks like text-lg").** Use the walker's exact computed values; use arbitrary values (`text-[17px]`) when Tailwind's scale doesn't match.
- **Don't dispatch a builder without a lint-passing spec.** No exceptions — that's the whole quality model.
- **Don't reference docs from builder prompts** — spec contents go inline.
- **Don't skip the manifest updates.** An untracked run can't resume.
- **Don't hardcode content in components.** Content → `src/data/`, components take props.
- **Don't write "same as desktop" in a Responsive section.** Root font-size steps at breakpoints on most real sites, so every number changes. Run `probe.mjs` and write the real values for all three widths — lint-spec now rejects vague responsive sections.
- **Don't forget `::before` / `::after`.** They carry hero overlays, heading underline bars, and icon glyphs. `section.mjs` captures them under a `pseudo` key — if a spec has none and the screenshot shows decorations, extraction was incomplete.
- **Don't trust the spec over the extraction JSON.** Specs are hand-written summaries and drift; `sections/*.json` is machine-measured.
- **Don't declare done without QA scores.** "Looks right" is not a number.

## Completion Report

- Pages cloned (routes) · sections built · spec files written (must match section count)
- Assets downloaded (from `assets.json` download log, including failures)
- Final QA score table per section × viewport (from `manifest.mjs status`)
- `npm run build` result
- Known gaps and any section that couldn't reach 95%
- Suggest next step: `/restyle` to rebrand the clone with your own identity
