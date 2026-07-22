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

// Reproduce the pre-compact on-disk format exactly (for --legacy): the walker
// now always records inherited props, so the old SKIP filter is re-applied here.
export function toLegacy(tree) {
  if (!tree || tree.error) return tree;
  const styles = {};
  for (const [p, v] of Object.entries(tree.styles || {})) {
    if (!SKIP_VALUES.has(v)) styles[p] = v;
  }
  const out = { ...tree, styles };
  if (tree.children) out.children = tree.children.map(toLegacy);
  return out;
}

// ---------------------------------------------------------------------------
// Structural tree diff
//
// The old differ paired children by index (a.children[i] vs b.children[i]),
// which went blind the moment a node appeared or disappeared: every later
// sibling compared against the wrong twin, and conditionally-rendered nodes
// (dropdowns, mobile menus, toggled panels) never showed up at all. This one
// aligns children with an order-preserving LCS — first on tag+classes, then a
// second pass on tag alone so a class toggle (`tab` -> `tab active`) reads as
// a change on the same node, not a remove+add.
// ---------------------------------------------------------------------------

function lcsAlign(ka, kb, key) {
  const m = ka.length, n = kb.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = key(ka[i]) === key(kb[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matched = [], onlyA = [], onlyB = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (key(ka[i]) === key(kb[j])) matched.push([i++, j++]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) onlyA.push(i++);
    else onlyB.push(j++);
  }
  while (i < m) onlyA.push(i++);
  while (j < n) onlyB.push(j++);
  return { matched, onlyA, onlyB };
}

function alignChildren(ka, kb) {
  const strict = lcsAlign(ka, kb, (n) => `${n.tag}|${n.classes || ""}`);
  if (!strict.onlyA.length || !strict.onlyB.length) return strict;
  // Second pass: unmatched leftovers pair up by tag alone (class toggles).
  const loose = lcsAlign(strict.onlyA.map((i) => ka[i]), strict.onlyB.map((j) => kb[j]), (n) => n.tag);
  const matched = [...strict.matched, ...loose.matched.map(([x, y]) => [strict.onlyA[x], strict.onlyB[y]])];
  matched.sort((a, b) => a[0] - b[0]);
  return {
    matched,
    onlyA: loose.onlyA.map((x) => strict.onlyA[x]),
    onlyB: loose.onlyB.map((y) => strict.onlyB[y]),
  };
}

// Serialize an appeared/disappeared subtree for a diff report: styles inlined
// per node but pruned/deduped the same way compact files are, so the report is
// self-contained without carrying every inherited prop on every node.
function reportNode(sub) {
  const { tree, styleTable } = compactWalk(sub);
  const inline = (n) => {
    if (!n || n.error) return n;
    const { style, children, ...rest } = n;
    const out = { ...rest };
    if (style) out.styles = styleTable[style];
    if (children) out.children = children.map(inline);
    return out;
  };
  return inline(tree);
}

// Full structural diff of two same-selector walks (raw in-memory trees, as
// returned by walkSections). Returns:
//   changed — [{ path, prop, before, after }] on structurally matched nodes,
//             covering styles, ::before/::after, and direct text
//   added / removed — [{ path, node }] subtrees that exist in only one state,
//             with pruned inline styles (see reportNode)
export function diffTrees(a, b) {
  const changed = [], added = [], removed = [];
  const rec = (na, nb, path) => {
    if (!na || !nb || na.error || nb.error) return;
    const keys = new Set([...Object.keys(na.styles || {}), ...Object.keys(nb.styles || {})]);
    for (const k of keys) {
      if ((na.styles?.[k] ?? null) !== (nb.styles?.[k] ?? null)) {
        changed.push({ path, prop: k, before: na.styles?.[k] ?? "(unset)", after: nb.styles?.[k] ?? "(unset)" });
      }
    }
    for (const pe of ["::before", "::after"]) {
      const pa = na.pseudo?.[pe] || {};
      const pb = nb.pseudo?.[pe] || {};
      for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
        if ((pa[k] ?? null) !== (pb[k] ?? null)) {
          changed.push({ path: path + pe, prop: k, before: pa[k] ?? "(unset)", after: pb[k] ?? "(unset)" });
        }
      }
    }
    if ((na.text || null) !== (nb.text || null)) {
      changed.push({ path, prop: "(text)", before: na.text ?? "(none)", after: nb.text ?? "(none)" });
    }
    if ((na.classes || null) !== (nb.classes || null)) {
      changed.push({ path, prop: "(classes)", before: na.classes ?? "(none)", after: nb.classes ?? "(none)" });
    }
    const ka = na.children || [], kb = nb.children || [];
    const { matched, onlyA, onlyB } = alignChildren(ka, kb);
    for (const [i, j] of matched) rec(ka[i], kb[j], `${path} > ${ka[i].tag}[${i}]`);
    for (const i of onlyA) removed.push({ path: `${path} > ${ka[i].tag}[${i}]`, node: reportNode(ka[i]) });
    for (const j of onlyB) added.push({ path: `${path} > ${kb[j].tag}[${j}]`, node: reportNode(kb[j]) });
  };
  rec(a, b, a?.tag || "root");
  return { changed, added, removed };
}
