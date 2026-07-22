<!-- GENERATED from .claude/skills/clone-website/SKILL.md by scripts/sync-skills.mjs — edit the source,
     then run: node scripts/sync-skills.mjs -->

# Clone Website

> Reverse-engineer and clone a full multi-page website as a pixel-accurate Next.js replica

Reverse-engineer and rebuild **the target URL (plus any extra instructions) provided by the user** as a pixel-accurate, multi-page Next.js clone.

You are a **foreman walking the job site**: scripts do the measuring, you do the judgment, specs are the contract, builder agents do the construction, and the pixel-diff score decides when you're done. Extraction and construction overlap — dispatch builders as soon as a section's spec passes lint, then keep extracting.

## Resume Check (ALWAYS FIRST)

```bash
node scripts/manifest.mjs resume
```

If a manifest exists, this is a **resumed run**: the digest shows every section's stage AND the exact next commands with real file paths — run them instead of re-deriving where you were. If not, this is a fresh run — start at Phase 0. (`status` prints just the table, `next` the single next section.)

## Scope Defaults

- **Fidelity:** pixel-accurate — colors, spacing, typography, animations, interactions
- **In scope:** every confirmed page, visual layout, component structure, interactions, responsive behavior (phone 390 / iPad 768 / PC 1440), real content and assets
- **Out of scope:** real backend, auth, databases, forms that actually submit (mock them)
- **Content goes in `src/data/*.ts`** — components take props; page files wire data to components. This keeps the clone restylable later (see `/restyle`).

User-provided instructions override these defaults.

## Tooling

The scripts do the mechanical work — **use them instead of hand-measuring via browser MCP**:

| Script | Purpose |
|---|---|
| **`node scripts/extract/page.mjs <url> [--no-site-files]`** | **THE WORKHORSE — one call, 3 page loads total.** Auto-detects sections, then produces `tokens.json` + `css.json` (skip on later pages with `--no-site-files`), `assets.json` + downloads to `public/`, `responsive.json` (all 3 viewports), a full computed-style walk per section (`sections/<name>.json`), and full-page **and** per-section screenshots at phone/iPad/PC. Accepts explicit `--selector "css" --name x` pairs to override detection. Everything is measured from the SAME page state, so numbers, walks and screenshots can never disagree |
| `node scripts/extract/crawl.mjs <url> [--max 25]` | Discover pages (sitemap + nav links) → `docs/research/<host>/sitemap.json` |
| `node scripts/extract/section.mjs <url> --selector "css" [--name x] --state scroll:600\|click:sel\|hover:sel [--viewport pc\|ipad\|phone]` | **State captures** (page.mjs covers the default state). Captures a second state and diffs them (element styles *and* `::before`/`::after`), waiting for the section's real transition duration. `--selector`/`--name` repeat — one page load for all |
| `node scripts/extract/probe.mjs <url> --selector "css" [--selector "css2"] [--props a,b,c]` / `probe.mjs --route </r>` | Exact computed values for specific selectors at all 3 viewports, as a markdown table with a **varies** column — paste straight into a spec's Responsive section. **`--route` probes EVERY registered section of a page in one call (3 loads total, plus a `probe-<section>.json` per section) — never probe section-by-section** |
| `node scripts/extract/screenshot.mjs <url> [--selector css --name x ...]` | Extra screenshots at phone/iPad/PC (page.mjs already shot everything once). `--selector`/`--name` repeat — one call, 3 loads, N sections |
| `node scripts/extract/tokens.mjs` / `css.mjs` / `assets.mjs` / `responsive.mjs` | Single-purpose re-runs of one page.mjs output when something needs refreshing |
| `node scripts/resolve-walk.mjs <sections-json> [--node <path>]` | Reader for section-walk JSON (compact or legacy): indexed outline of the tree, and fully resolved computed styles for any one node. Use this instead of reading the raw JSON — walks are stored compact (style dictionary + inherited-prop pruning) |
| `node scripts/diff.mjs --original <url> --clone <url> [--selector css] --viewport all [--threshold 95]` | Scored pixel diff, original vs clone. **`--viewport all` scores pc+ipad+phone in one call**, and the per-viewport **band breakdown names the y-range where the mismatch lives** — read it before guessing at causes. **QA sweeps use `--route </r> --triage`: whole-page diff first, per-section diffs only for sections overlapping failing bands.** Plain `--route` (or repeated `--section name=css`) scores every section from ONE load per side per viewport. Original-side shots are cached 24h, so fix-iteration re-diffs only re-render the clone (`--fresh-original` to override) |
| **`node scripts/spec-scaffold.mjs --route <r> --section <name>`** (or `--all`) | **Generates the mechanical spec sections** (frontmatter, DOM, computed styles, assets, text, responsive) straight from the extraction JSON into `docs/research/components/<route-slug>/<name>.spec.md`, leaving `<!-- AGENT: fill -->` blocks for the judgment parts. Never transcribe JSON values by hand |
| `node scripts/compare.mjs --original <url> --clone <url> --selector "css" [--viewport vp]` | **Property-level diff for failing QA sections** — walks both live DOMs, aligns them structurally, prints differing computed properties ordered by visual impact (geometry > typography > color) plus missing/extra nodes. Run on a failing band BEFORE editing anything |
| `node scripts/lint-spec.mjs <spec.md\|dir>` | Mechanical spec-completeness gate — must pass before ANY builder dispatch |
| `node scripts/manifest.mjs <cmd>` | Pipeline state: init / add-page / add-section / set / status / next / **resume** (one-screen digest: stage table + exact next commands and file paths) |

**Screenshots come in two sizes.** Every screenshot the scripts produce gets a 640px-wide `-review.png` twin (when the full-res is wider). **Open the `-review.png` for judgment work** — reviewing sections, comparing pages, inspecting failing diff bands; it's visually sufficient at half the cost. Full-res files are for pixelmatch and for builder-agent prompts only.

Browser MCP (Chrome MCP, Playwright MCP — if available) is for **judgment work only**: watching how the page behaves while scrolling, exploring what's clickable, understanding an animation. Numbers always come from the scripts. If no browser MCP is available, the scripts alone are sufficient — use extra `screenshot.mjs` and `section.mjs --state` calls to observe behavior.

The scripts are plain Node CLIs — any coding agent can run them. Playwright's Chromium auto-installs on the first script run (or run `npm run setup` once). If your tool has no subagent/worktree support, skip the dispatch mechanics and build each section yourself, sequentially, from the same lint-passing specs — every quality gate still applies.

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
10. **The build must always compile.** Builders verify `npx tsc --noEmit`; you verify `npm run typecheck && npm run lint` after every merge. Full `npm run build` runs only at checkpoints (Phase 0, end of Phase 2, once mid-way through Phase 3, Phase 4, completion) — it takes 30–60s and running it per merge serializes otherwise-parallel builders.
11. **The manifest tracks every stage transition.** The scripts self-report the transitions they own — page.mjs marks `extracted` (and registers new sections), lint-spec marks `specd` on pass, diff.mjs `--route` sweeps record scores and `qa_passed`. You update only the stages no script can see: `built` and `merged` (via `manifest.mjs set`), which also remains the manual override for anything else.

## Phase 0 — Crawl & Scope

1. Verify the base builds: `npm run build`.
2. `node scripts/extract/crawl.mjs <url> --max 25`
3. Show the user the discovered pages (route + source). **Ask which to clone** — recommend: start page + nav pages, skip legal/utility pages unless asked. Default cap ~10.
4. Initialize state:
   ```bash
   node scripts/manifest.mjs init <url>
   node scripts/manifest.mjs add-page --url <url> --route /        # per confirmed page
   ```

## Phase 1 — Recon (one page.mjs call per page)

1. **First page:** `node scripts/extract/page.mjs <start-url>` — produces tokens, css, assets+downloads, responsive signatures, per-section walks, and every screenshot in one shot (3 page loads).
2. **Every other confirmed page:** `node scripts/extract/page.mjs <url> --no-site-files` (tokens/css are site-wide; everything else is per-page). Downloads dedupe across pages automatically — files already in `public/` are skipped.
3. **Review the detected sections** in each run's stdout summary (name, selector, pc height, headline responsive change). Detection is a heuristic: if a "section" is really two, or two are really one, re-run with explicit `--selector "css" --name x` pairs. Section names become spec/component names — when detection got the sections RIGHT but the names wrong (`section-3` fallbacks), **don't re-extract**: `node scripts/extract/page.mjs --rename section-3=hero,section-4=features` renames the JSONs, probe files, screenshots, responsive.json and manifest entries in place with zero page loads.
4. **Interaction sweep** (judgment work — browser MCP if available): scroll each page slowly top to bottom. Does the header change? Do elements animate in? Auto-switching tabs? Scroll-snap? Smooth-scroll lib (`tokens.json` flags `.lenis`/Locomotive)? Then click every tab/pill/accordion and note what changes. Then hover. `css.json`'s `interactiveStates` lists every :hover/:focus rule the stylesheet defines — use it as the checklist of what to probe. Record findings in `docs/research/<host>/BEHAVIORS.md`.
5. **Shared chrome detection:** compare screenshots across pages — header/nav/footer that repeat become SHARED components (`SiteHeader`, `SiteFooter`), extracted once from the page where they're most complete.

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

**The default state is already extracted** — Phase 1's page.mjs run wrote
`sections/<name>.json`, `responsive.json`, and all screenshots.

**First time you enter Phase 3 for a page, probe ALL its sections in ONE call** (3
page loads total instead of 3 per section — never probe section-by-section):

```bash
node scripts/extract/probe.mjs --route <r>   # every registered section + probe-<section>.json each
# add key children in the same call when a spec will need them:
node scripts/extract/probe.mjs --route <r> --selector "<sel> h2" --selector "<sel> .card"
```

Slice the per-section tables into each spec's Responsive section as you write it.
Per section, only one thing remains:

```bash
# Per discovered behavior — one call per state (batch selectors sharing a trigger):
node scripts/extract/section.mjs <page-url> --selector "<sel>" --name <name>-hover --state hover:".card"
node scripts/extract/section.mjs <page-url> --selector "<sel>" --name <name>-scrolled --state scroll:600
# per tab/pill state: --state click:".tab-2" etc. EVERY state, not just the default.
```
State captures wait for the section's actual transition duration, so a slow fade is
recorded at its end value, not mid-flight — check `settleMs` in the output if a diff
looks wrong. The `diff` array covers `::before`/`::after` too, which is where hover
overlays usually live. Captures are **diff-only**: `diff` lists changed props (plus
`(text)`/`(classes)` changes), and `added`/`removed` carry subtrees that exist in
only one state with their styles inline — conditionally-rendered dropdowns and
panels land there. Pass `--audit` to also store the full before/after trees. Cross-check discovered behaviors against `css.json`'s
`interactiveStates` — a :hover rule in the stylesheet with no captured state means
the extraction is not done.

(No manifest command needed — page.mjs already marked the section `extracted` when it wrote the walk.)

### 3b. Write the spec — scaffold first, judgment second

```bash
node scripts/spec-scaffold.mjs --route <r> --section <name>    # or --all for the whole route
```

This generates `docs/research/components/<route-slug>/<name>.spec.md` with every
**mechanical** section already filled from the extraction JSON — frontmatter, DOM
Structure, Computed Styles, Assets, Text Content, Responsive Behavior — and any
captured states listed as reference data. **Never transcribe values from the JSON
by hand**: the scaffold is generated from the same files and can't mistype.

You fill ONLY the `<!-- AGENT: fill -->` blocks — the judgment calls:

- `interaction_model:` in the frontmatter (static | click-driven | scroll-driven | hover-driven | time-driven | mixed)
- `## States & Behaviors` — per behavior: Trigger / State A / State B / Transition + the implementation approach (CSS transition, IntersectionObserver, …). The scaffold lists each captured state's trigger/settle/diff summary as reference
- `## Per-State Content` — full content per state for tabbed/stateful sections, or "N/A — static"
- `## Notes` — builder guidance: component split, `src/data/` shape, gotchas

An unfilled scaffold fails lint-spec on purpose (invalid interaction_model), so it
can never reach a builder. Correct a generated section only when it's wrong about
the page — don't restyle it.

**Light tier:** for tiny static sections (walk ≤15 nodes, zero captured states)
the scaffold sets `tier: light` — States & Behaviors / Per-State Content may
stay a single "N/A — static" line and the minimum-length warning is waived.
Don't set it by hand: lint-spec cross-checks the walk and rejects a light tier
the section doesn't qualify for.

**Utility-CSS sites (Tailwind and friends):** page.mjs detects them and captures
each section's cleaned markup; the scaffold then contains a `## Source Markup`
section — the class list IS the spec. Builders translate the markup first and
verify with probe values second; computed styles shrink to a few key anchors.

### 3c. Lint gate
```bash
node scripts/lint-spec.mjs docs/research/components/<route-slug>/<name>.spec.md
```
Fails → extract more. Passes → dispatch (lint-spec records the `specd` stage in the manifest itself).

### 3d. Dispatch builder agent (worktree)

Every builder receives IN ITS PROMPT (never "go read the file"):
- The **full spec file contents inline**
- The screenshot paths (all 3 viewports)
- Shared imports available: `cn()`, `icons.tsx` components, shadcn `ui/` primitives, types from `src/types/`
- The target file path, and the data file to create in `src/data/` if the section has content collections
- The rule: verify `npx tsc --noEmit` passes before finishing
- On utility-CSS sites (spec has `## Source Markup`): "translate the markup's class semantics first, then verify the result against the probe values — don't rebuild from computed styles alone"
- **The ground-truth rule:** "`docs/research/<host>/sections/<name>.json` and `responsive.json` are ground truth. If this spec contradicts them, follow the JSON and report the discrepancy." Builders reliably catch spec errors this way — treat their reports as corrections to make to the spec file. Walk JSON is stored compact — builders resolve any node's full styles with `node scripts/resolve-walk.mjs <json> --node <path>` instead of parsing the styleTable by hand.

Complex section (3+ distinct sub-components) → one builder per sub-component + one for the wrapper, sub-components first. **Don't wait** — while builders run, extract the next section.

### 3e. Merge
As builders finish: merge worktree → `npm run typecheck && npm run lint` → fix errors immediately → `manifest.mjs set … --stage merged`. tsc catches the cross-worktree breaks (imports, prop types) that per-merge builds used to catch, in a fraction of the time.

**Once, after roughly half the page's sections are merged: run a full `npm run build` checkpoint.** It catches build-only failures (server/client component violations, route exports, metadata) while they're still cheap to bisect. Don't build after every merge.

## Phase 4 — Page Assembly

Per page: create `src/app/<route>/page.tsx` importing its section components with data from `src/data/`, plus page-level behaviors (scroll-snap, observers, smooth scroll). Shared chrome mounts in `layout.tsx` or a route group layout. Wire internal nav links to the cloned routes. `npm run build` must pass.

## Phase 5 — Scored QA Loop

Start the clone: `npm run dev` (background). Then **triage whole-page first** — never open with 27 per-section diffs:

```bash
node scripts/diff.mjs --original <orig-page-url> --clone http://localhost:3000<route> --route <r> --triage --viewport all
```

Per viewport: one whole-page diff decides everything. A **passing viewport**
(match ≥95%, every band ≥95%, heights agree) proves all its sections at once —
no per-section diffs run, sections get the worst overlapping page band as their
score. A **failing viewport** names its failing bands, and ONLY the sections
overlapping those bands get individually diffed. On a good clone the whole QA
phase is a handful of page loads.

Scores and `qa_passed` stages land in the manifest automatically — no separate
manifest commands during QA. (Plain `--route` without `--triage` still scores
every section individually if you need the full table.)

**Fix iterations stay single-section** — the original-side shots captured by the sweep are cached, so a re-diff only re-renders the clone:

```bash
node scripts/diff.mjs --original <orig-page-url> --clone http://localhost:3000<route> --selector "<sel>" --viewport all --name <name>
```

- **Pass = ≥95% on all three viewports** (diff.mjs sets `qa_passed` automatically on a `--route` sweep)
- Below 95% → **read the band breakdown, then run compare.mjs — BEFORE touching the spec or component**:
  ```bash
  node scripts/compare.mjs --original <orig-page-url> --clone http://localhost:3000<route> --selector "<sel>" --viewport <failing-vp>
  ```
  The pixel diff says THAT a band mismatches; compare.mjs says WHAT — it walks both live DOMs, aligns them structurally, and prints the differing computed properties ordered by visual impact (geometry > typography > color), plus any nodes missing/extra in the clone. Fix exactly what it names (wrong extraction → correct spec; right spec → fix component), re-diff. The diff image's `-review.png` in `docs/research/qa/` is the visual companion
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
- **Don't skip the `built`/`merged` manifest updates.** Extraction, spec and QA stages self-report, but no script can see a merge — an untracked run can't resume.
- **Don't hardcode content in components.** Content → `src/data/`, components take props.
- **Don't write "same as desktop" in a Responsive section.** Root font-size steps at breakpoints on most real sites, so every number changes. Run `probe.mjs` and write the real values for all three widths — lint-spec now rejects vague responsive sections.
- **Don't forget `::before` / `::after`.** They carry hero overlays, heading underline bars, and icon glyphs. `section.mjs` captures them under a `pseudo` key — if a spec has none and the screenshot shows decorations, extraction was incomplete.
- **Don't trust the spec over the extraction JSON.** The judgment sections are hand-written and can drift; `sections/*.json` is machine-measured (and the mechanical spec sections are generated from it).
- **Don't declare done without QA scores.** "Looks right" is not a number.

## Completion Report

- Pages cloned (routes) · sections built · spec files written (must match section count)
- Assets downloaded (from `assets.json` download log, including failures)
- Final QA score table per section × viewport (from `manifest.mjs status`)
- `npm run build` result
- Known gaps and any section that couldn't reach 95%
- Suggest next step: `/restyle` to rebrand the clone with your own identity
