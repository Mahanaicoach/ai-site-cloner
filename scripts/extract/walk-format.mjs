// Reading, resolving and iterating section-walk JSON — the single place that
// understands both walk formats:
//
//   legacy:      { tree: { styles: {…}, children: […] } }         (full blob per node)
//   compact-v1:  { format: "compact-v1", styleTable: { s1: {…} },
//                  tree: { style: "s1", children: […] } }
//
// In compact-v1 a node's `style` key points into the styleTable; the stored
// object holds only (a) non-inherited props that survive the walker's SKIP
// filter and (b) CSS-inherited props that DIFFER from the parent's value.
// Resolution therefore is: inherited props fall back up the ancestor chain,
// everything else is absent-means-default — exactly the semantics consumers
// already assumed for legacy files.
import { createHash } from "node:crypto";

// CSS-inherited properties among the walker's PROPS list. Only these may be
// pruned against the parent: a non-inherited prop that happens to equal the
// parent's (say, both padding 16px) is a coincidence, and pruning it would
// make "absent" ambiguous between "default" and "same as parent".
export const INHERITED_PROPS = [
  "fontSize", "fontWeight", "fontFamily", "lineHeight", "letterSpacing",
  "color", "textAlign", "textTransform", "whiteSpace", "cursor", "visibility",
];
const INHERITED = new Set(INHERITED_PROPS);

// Mirrors the walker's SKIP set (collectors.mjs) — used when compacting the
// root node, where inherited props have no parent to diff against.
export const SKIP_VALUES = new Set(["none", "normal", "auto", "0px", "rgba(0, 0, 0, 0)", "visible", "static", "initial", ""]);

export function isCompact(doc) {
  return doc?.format === "compact-v1";
}

// The raw style object stored on a node, whichever format.
export function storedStyles(node, doc) {
  if (!node) return {};
  if (node.styles) return node.styles;
  if (node.style && doc?.styleTable) return doc.styleTable[node.style] || {};
  return {};
}

// Fully resolved styles for a node: its own stored props plus, for compact
// files, inherited props filled in from the nearest ancestor that recorded
// them. `ancestors` is root-first. Legacy nodes come back as-is.
export function resolveStyles(node, ancestors, doc) {
  const own = storedStyles(node, doc);
  if (!isCompact(doc)) return { ...own };
  const out = { ...own };
  for (const prop of INHERITED_PROPS) {
    if (prop in out) continue;
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const v = storedStyles(ancestors[i], doc)[prop];
      if (v !== undefined) {
        out[prop] = v;
        break;
      }
    }
  }
  return out;
}

// Depth-first iteration with everything a consumer needs to address or resolve
// a node: `indexPath` ("0.2.1" = child indices from the root), `ancestors`
// (root-first), and a short human label.
export function* walkNodes(tree, { ancestors = [], indexPath = "" } = {}) {
  if (!tree || tree.error) return;
  yield { node: tree, indexPath: indexPath || "root", ancestors, label: nodeLabel(tree) };
  const kids = tree.children || [];
  for (let i = 0; i < kids.length; i++) {
    yield* walkNodes(kids[i], {
      ancestors: [...ancestors, tree],
      indexPath: indexPath ? `${indexPath}.${i}` : String(i),
    });
  }
}

export function nodeLabel(node) {
  const cls = (node.classes || "").split(" ").filter(Boolean).slice(0, 2).join(".");
  return node.tag + (cls ? "." + cls : "");
}

// Look a node up by its "0.2.1" index path (as printed by resolve-walk.mjs).
export function nodeAtPath(tree, path) {
  if (!path || path === "root") return { node: tree, ancestors: [] };
  const ancestors = [];
  let cur = tree;
  for (const part of String(path).split(".")) {
    const i = Number(part);
    if (!cur?.children?.[i]) return { node: null, ancestors };
    ancestors.push(cur);
    cur = cur.children[i];
  }
  return { node: cur, ancestors };
}

// ---------------------------------------------------------------------------
// Compaction: legacy tree -> { tree, styleTable }
//
// Two passes of savings, measured on the plausible.io fixture run where 45 of
// 63 nodes carried byte-identical style blobs:
//   1. inherited-prop pruning — fontFamily/color/… stop repeating on every node
//   2. style dictionary — the (now much smaller) per-node objects dedupe into
//      a shared table; nodes reference entries by key
// ---------------------------------------------------------------------------

export function compactWalk(tree) {
  const table = new Map(); // styles-JSON -> key
  const styleTable = {};

  const keyFor = (styles) => {
    const json = JSON.stringify(styles);
    let key = table.get(json);
    if (!key) {
      key = `s${table.size + 1}`;
      table.set(json, key);
      styleTable[key] = styles;
    }
    return key;
  };

  const compactNode = (node, parentStyles) => {
    if (!node || node.error) return node;
    const src = node.styles || {};
    const pruned = {};
    for (const [prop, v] of Object.entries(src)) {
      if (INHERITED.has(prop)) {
        if (parentStyles) {
          if (v !== parentStyles[prop]) pruned[prop] = v; // differs -> record
        } else if (!SKIP_VALUES.has(v)) {
          pruned[prop] = v; // root: keep non-default inherited values
        }
      } else {
        pruned[prop] = v;
      }
    }
    // Effective inherited values this node passes down (own overrides parent's)
    const passDown = { ...(parentStyles || {}) };
    for (const prop of INHERITED_PROPS) if (src[prop] !== undefined) passDown[prop] = src[prop];

    const { styles: _drop, children, ...rest } = node;
    const out = { ...rest };
    if (Object.keys(pruned).length) out.style = keyFor(pruned);
    if (children) out.children = children.map((c) => compactNode(c, passDown));
    return out;
  };

  const compacted = compactNode(tree, null);
  return { tree: compacted, styleTable };
}

// The subset of a styleTable a single tree actually references — per-section
// files carry only their own entries.
export function usedStyleTable(tree, styleTable) {
  const used = {};
  for (const { node } of walkNodes(tree)) {
    if (node.style && styleTable[node.style]) used[node.style] = styleTable[node.style];
  }
  return used;
}

// Stable content hash of a node's identity (tag + classes) — used by the
// structural differ to align children across two captures.
export function nodeKey(node) {
  return createHash("md5").update(`${node.tag}|${node.classes || ""}`).digest("hex").slice(0, 8);
}
