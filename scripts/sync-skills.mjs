#!/usr/bin/env node
// Skill/rules sync generator — WHY: ~12 AI coding tools each want the same instructions
// in their own folder and format, and hand-maintained copies always drift. The only
// sources of truth are .claude/skills/*/SKILL.md (the two workflows) and AGENTS.md
// (project rules); everything else here is a generated, committed artifact.
//
// Usage: node scripts/sync-skills.mjs            regenerate every per-tool file
//        node scripts/sync-skills.mjs --check    exit 1 listing stale files (CI gate)
//
// Placeholder conventions per tool (mirrors JCodesMore/ai-website-cloner-template):
//   Claude/Codex/Copilot skills . . $ARGUMENTS (native, file copied verbatim)
//   OpenCode / Augment / Continue . $ARGUMENTS (native, body kept as-is)
//   Gemini CLI  . . . . . . . . . . {{args}}
//   Cursor / Windsurf / Amazon Q  . no substitution — $ARGUMENTS becomes prose
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

// Per-skill metadata that can't be derived from SKILL.md itself:
// - shortDesc: one-liner for tools whose description field is a single string
// - argsProse: what replaces $ARGUMENTS in tools with no argument substitution
// - fileContext: extra context files for the Amazon Q agent definition
const SKILL_META = {
  "clone-website": {
    shortDesc: "Reverse-engineer and clone a full multi-page website as a pixel-accurate Next.js replica",
    argsProse: "the target URL (plus any extra instructions) provided by the user",
    fileContext: ["AGENTS.md", "docs/research/**"],
  },
  restyle: {
    shortDesc: "Rebrand a cloned website with your own colors, fonts, logo, and copy while keeping the layout pixel-intact",
    argsProse: "Honor any extra instructions the user provided when invoking this command.",
    fileContext: ["AGENTS.md", "BRAND.md", "docs/research/**"],
  },
};

const fail = (msg) => {
  console.error(`Error: ${msg}`);
  process.exit(1);
};

// All outputs are built in memory first so --check can diff without touching disk.
const outputs = new Map(); // relPath -> content
const emit = (relPath, content) => outputs.set(relPath, content);

const header = (source) =>
  `<!-- GENERATED from ${source} by scripts/sync-skills.mjs — edit the source,\n` +
  `     then run: node scripts/sync-skills.mjs -->\n\n`;

// --- Skills: .claude/skills/*/SKILL.md → per-tool command/skill files ---

const skillsDir = join(ROOT, ".claude", "skills");
const skillNames = readdirSync(skillsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, "SKILL.md")))
  .map((e) => e.name)
  .sort();
if (!skillNames.length) fail("no skills found under .claude/skills/");

for (const name of skillNames) {
  const sourceRel = `.claude/skills/${name}/SKILL.md`;
  const raw = readFileSync(join(ROOT, sourceRel), "utf8").replace(/\r\n/g, "\n");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) fail(`could not parse frontmatter in ${sourceRel}`);

  // Frontmatter is flat key: value lines — a full YAML parser would be a dependency.
  const fm = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2];
  }
  const body = match[2].replace(/^\n+/, "").replace(/\n*$/, "\n");
  const meta = SKILL_META[name] ?? {};
  const shortDesc = meta.shortDesc ?? (fm.description ?? name).split(". ")[0];
  const argsProse = meta.argsProse ?? "the arguments provided by the user";
  const noArgs = (text) => text.replace(/\$ARGUMENTS/g, argsProse);
  const mark = header(sourceRel);

  // 1. Codex CLI — reads the same SKILL.md format, $ARGUMENTS native. Verbatim copy:
  //    a marker comment before the YAML frontmatter would break parsing, so none here.
  emit(`.codex/skills/${name}/SKILL.md`, raw);

  // 2. GitHub Copilot coding agent — same SKILL.md format, verbatim copy.
  emit(`.github/skills/${name}/SKILL.md`, raw);

  // 3. Cursor — plain markdown command, no argument substitution.
  //    H1 title (lifted from the body) + description line, then the prose-args body.
  const h1 = body.match(/^# (.+)\n/);
  const title = h1 ? h1[1] : name;
  const afterH1 = h1 ? body.slice(h1[0].length).replace(/^\n+/, "") : body;
  emit(
    `.cursor/commands/${name}.md`,
    `${mark}# ${title}\n\n> ${shortDesc}\n\n${noArgs(afterH1)}`
  );

  // 4. Windsurf — markdown workflow, no argument substitution.
  emit(`.windsurf/workflows/${name}.md`, mark + noArgs(body));

  // 5. Gemini CLI — TOML command, {{args}} placeholder. The body goes in a multi-line
  //    literal string ('''), which no escape sequence can break — but it cannot itself
  //    contain ''' so guard against that ever appearing in a skill body.
  const geminiBody = body.replace(/\$ARGUMENTS/g, "{{args}}");
  if (geminiBody.includes("'''")) fail(`${sourceRel} contains ''' — breaks Gemini TOML literal string`);
  const tomlStr = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  emit(
    `.gemini/commands/${name}.toml`,
    `# GENERATED from ${sourceRel} by scripts/sync-skills.mjs — edit the source,\n` +
      `# then run: node scripts/sync-skills.mjs\n\n` +
      `description = ${tomlStr(shortDesc)}\n` +
      `name = ${tomlStr(name)}\n\n` +
      `prompt = '''\n${geminiBody}'''\n`
  );

  // 6. OpenCode — markdown + YAML frontmatter, $ARGUMENTS works natively.
  emit(
    `.opencode/commands/${name}.md`,
    `---\ndescription: "${shortDesc}"\n---\n${mark}${body}`
  );

  // 7. Augment Code — markdown + YAML frontmatter, keeps the source argument-hint.
  const argHint = fm["argument-hint"] ? `argument-hint: ${fm["argument-hint"]}\n` : "";
  emit(
    `.augment/commands/${name}.md`,
    `---\ndescription: "${shortDesc}"\n${argHint}---\n${mark}${body}`
  );

  // 8. Continue — prompt file with invokable: true.
  emit(
    `.continue/commands/${name}.md`,
    `---\nname: ${name}\ndescription: "${shortDesc}"\ninvokable: true\n---\n${mark}${body}`
  );

  // 9. Amazon Q Developer CLI — JSON agent definition (JSON allows no comment marker).
  emit(
    `.amazonq/cli-agents/${name}.json`,
    JSON.stringify(
      { name, description: shortDesc, prompt: noArgs(body).trim(), fileContext: meta.fileContext ?? ["AGENTS.md"] },
      null,
      2
    ) + "\n"
  );
}

// --- Rules: AGENTS.md → copies for tools that don't read AGENTS.md natively ---
// (Codex, OpenCode, Cursor, Windsurf, Aider & co. read AGENTS.md or a thin pointer;
//  Copilot Chat, Cline/Roo, Continue, and Amazon Q need their own committed copy.)

const agentsPath = join(ROOT, "AGENTS.md");
if (!existsSync(agentsPath)) fail("AGENTS.md not found at repo root");

// Resolve @path imports (Claude Code / Gemini syntax) into inline content so tools
// without import support still get the full text.
const resolveImports = (text) =>
  text
    .split("\n")
    .map((line) => {
      const m = line.match(/^@(.+)$/);
      if (!m) return line;
      const imported = join(ROOT, m[1].trim());
      if (!existsSync(imported)) return `<!-- Import not found: ${m[1].trim()} -->`;
      return readFileSync(imported, "utf8").replace(/\r\n/g, "\n").trimEnd();
    })
    .join("\n");

const rules = resolveImports(readFileSync(agentsPath, "utf8").replace(/\r\n/g, "\n")).replace(/\n*$/, "\n");
const rulesMark = header("AGENTS.md");

emit(".github/copilot-instructions.md", rulesMark + rules);
emit(".clinerules", rulesMark + rules);
emit(
  ".continue/rules/project.md",
  `---\ndescription: Project conventions for the site-cloner template\nalwaysApply: true\n---\n${rulesMark}${rules}`
);
emit(".amazonq/rules/project.md", rulesMark + rules);

// --- Write or check ---

if (CHECK) {
  const stale = [];
  for (const [rel, content] of outputs) {
    let current = null;
    try {
      current = readFileSync(join(ROOT, rel), "utf8");
    } catch {
      // missing file counts as stale
    }
    if (current !== content) stale.push(rel);
  }
  if (stale.length) {
    console.error("Stale generated files — run `node scripts/sync-skills.mjs` and commit:");
    for (const rel of stale) console.error(`  ✗ ${rel}`);
    process.exit(1);
  }
  console.log(`✓ All ${outputs.size} generated files are up to date.`);
} else {
  console.log(`Syncing ${skillNames.length} skills + AGENTS.md to all platforms...\n`);
  for (const [rel, content] of outputs) {
    const full = join(ROOT, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
    console.log(`  ✓ ${rel}`);
  }
  console.log(`\nDone — ${outputs.size} files generated. Sources: .claude/skills/*/SKILL.md, AGENTS.md.`);
}
