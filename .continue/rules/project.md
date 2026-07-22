---
description: Project conventions for the site-cloner template
alwaysApply: true
---
<!-- GENERATED from AGENTS.md by scripts/sync-skills.mjs — edit the source,
     then run: node scripts/sync-skills.mjs -->

# ai-site-cloner

Template for cloning any multi-page website into this Next.js codebase, then rebranding it as your own. Two commands drive everything: `/clone-website <url>` and `/restyle`.

## Tech Stack

- **Next.js 16** — App Router, React 19, TypeScript strict
- **Tailwind CSS v4** + shadcn/ui (base-ui primitives), oklch tokens in `src/app/globals.css`
- **Lucide React** icons (replaced by extracted SVGs in `src/components/icons.tsx` during cloning)
- **Playwright** (devDependency) powers all extraction/QA scripts

## Commands

- `npm run dev` / `npm run build` / `npm run lint` / `npm run typecheck`
- `npm run check` — lint + typecheck + build (must pass before any commit)

## Architecture Rules

- **Content lives in `src/data/*.ts`, never hardcoded in components.** Components take props. This is what makes `/restyle` possible — copy swaps without touching layout.
- Pages: `src/app/<route>/page.tsx` wires data → components. Shared header/footer mount in layouts.
- `docs/research/` holds extraction artifacts (JSON, specs, manifest) — auditable, never hand-edited except spec files.
- `docs/research/manifest.json` is the pipeline state. Update it at every stage transition; check it first on any clone-related task (`node scripts/manifest.mjs status`).
- Specs (`docs/research/components/**/*.spec.md`) must pass `node scripts/lint-spec.mjs` before any builder agent is dispatched.
- All extraction numbers come from `scripts/` (computed styles, real column counts, pixel diffs) — never estimated by eye.

## Code Style

- TypeScript strict, no `any`
- Named exports, PascalCase components, camelCase utils
- Tailwind utility classes; arbitrary values (`text-[17px]`) when the extracted value doesn't match Tailwind's scale
- 2-space indentation

## Skills / Commands

Two workflows, each with a single source of truth in `.claude/skills/<name>/SKILL.md`:

| Command | Purpose |
|---|---|
| `/clone-website <url>` | Crawl, extract, spec, build, and pixel-diff QA a full multi-page clone |
| `/restyle` | Swap colors, fonts, logo, and copy for your brand — layout stays intact |

Where your tool finds them (all generated from the same source):

- **Claude Code:** `.claude/skills/<name>/SKILL.md`
- **Codex CLI:** `.codex/skills/<name>/SKILL.md`
- **GitHub Copilot coding agent:** `.github/skills/<name>/SKILL.md`
- **Cursor:** `.cursor/commands/<name>.md`
- **Windsurf:** `.windsurf/workflows/<name>.md`
- **Gemini CLI:** `.gemini/commands/<name>.toml`
- **OpenCode:** `.opencode/commands/<name>.md`
- **Continue:** `.continue/commands/<name>.md`
- **Augment Code:** `.augment/commands/<name>.md`
- **Amazon Q Developer CLI:** `.amazonq/cli-agents/<name>.json`
- **Cline / Roo Code, Aider, anything else:** open `.claude/skills/<name>/SKILL.md` and follow it as a prompt.

The extraction scripts are plain Node CLIs any agent can run; Chromium auto-installs on first use (or `npm run setup`). No subagent support in your tool? Build sections sequentially from the same lint-passing specs.

## Ethics

Clone sites you own or have permission to rebuild (platform migration, lost source, learning). Never for phishing, impersonation, or passing off someone's design as your own.

## Keeping Agent Configs in Sync

- `.claude/skills/*/SKILL.md` and this file (`AGENTS.md`) are the only sources of truth for per-tool configs.
- After editing either, run `node scripts/sync-skills.mjs` to regenerate every per-tool copy.
- Generated files are committed; CI runs `node scripts/sync-skills.mjs --check` and fails if any are stale.
