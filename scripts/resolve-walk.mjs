#!/usr/bin/env node
// Print fully resolved computed styles for any node of a section walk — the
// human/builder-facing reader for the compact-v1 format (works on legacy files
// too). The compact format stores each style object once in a styleTable and
// prunes inherited props that match the parent; this script undoes both so a
// builder can see every effective value for one node without mentally chasing
// the ancestor chain.
//
// Usage:
//   node scripts/resolve-walk.mjs docs/research/<host>/sections/hero.json
//       # indexed outline: one line per node with its index path
//   node scripts/resolve-walk.mjs docs/research/<host>/sections/hero.json --node 0.2.1
//       # fully resolved styles (+ pseudo, rect, text) for that node
import { readFileSync } from "node:fs";
import { parseArgs } from "./lib.mjs";
import { walkNodes, nodeAtPath, resolveStyles, nodeLabel } from "./extract/walk-format.mjs";

const args = parseArgs(process.argv.slice(2));
const file = args._[0];
if (!file) {
  console.error("Usage: node scripts/resolve-walk.mjs <sections-json> [--node 0.2.1]");
  process.exit(1);
}
const doc = JSON.parse(readFileSync(file, "utf8"));
const tree = doc.tree || doc.stateA; // state-capture audits keep stateA/stateB
if (!tree) {
  console.error(`${file} has no walk tree (a diff-only state capture?) — resolve the base section file instead.`);
  process.exit(1);
}

if (args.node) {
  const { node, ancestors } = nodeAtPath(tree, String(args.node));
  if (!node) {
    console.error(`No node at path "${args.node}" — run without --node to list paths.`);
    process.exit(1);
  }
  console.log(`# ${nodeLabel(node)}  (path ${args.node})`);
  if (node.rect) console.log(`rect: ${node.rect.w}×${node.rect.h} @ page ${node.rect.pageX},${node.rect.pageY}`);
  if (node.text) console.log(`text: "${node.text}"`);
  if (node.href) console.log(`href: ${node.href}`);
  if (node.img) console.log(`img: ${node.img.src} (${node.img.w}×${node.img.h})`);
  console.log("\nresolved styles:");
  const styles = resolveStyles(node, ancestors, doc);
  for (const k of Object.keys(styles).sort()) console.log(`  ${k}: ${styles[k]}`);
  for (const [pe, st] of Object.entries(node.pseudo || {})) {
    console.log(`\n${pe}:`);
    for (const k of Object.keys(st).sort()) console.log(`  ${k}: ${st[k]}`);
  }
} else {
  console.log(`# ${file}  (${doc.format || "legacy"})`);
  for (const { node, indexPath, ancestors } of walkNodes(tree)) {
    const depth = ancestors.length;
    const text = node.text ? `  "${node.text.length > 40 ? node.text.slice(0, 39) + "…" : node.text}"` : "";
    const dims = node.rect ? `  [${node.rect.w}×${node.rect.h}]` : "";
    console.log(`${indexPath.padEnd(12)}${"  ".repeat(depth)}${nodeLabel(node)}${dims}${text}`);
  }
  console.log(`\nResolve a node: node scripts/resolve-walk.mjs ${file} --node <path>`);
}
