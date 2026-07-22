// Shared extraction collectors. Every in-page measurement payload lives here
// exactly once, so the thin CLI scripts (tokens/css/assets/responsive/section)
// and the one-shot page.mjs can never drift apart. Each collector takes a live
// Playwright page that has already been gotoAndSettle'd + autoScroll'ed.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Design tokens (colors, fonts, css vars, keyframes, global behaviors)
// ---------------------------------------------------------------------------
export async function collectTokens(page) {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll("body *")].slice(0, 3000);
    const count = (map, key) => key && map.set(key, (map.get(key) || 0) + 1);
    const colors = new Map();
    const bgs = new Map();
    const families = new Map();
    const radii = new Map();
    const shadows = new Map();
    const fontSizes = new Map();
    // Which animations are actually used on the page, and on how many elements —
    // read in the same pass as the token counts: getComputedStyle forces a style
    // resolution per element, so one walk instead of two halves that cost.
    const animationsInUse = {};

    for (const el of els) {
      const cs = getComputedStyle(el);
      count(colors, cs.color);
      if (cs.backgroundColor !== "rgba(0, 0, 0, 0)") count(bgs, cs.backgroundColor);
      count(families, cs.fontFamily);
      if (cs.borderRadius !== "0px") count(radii, cs.borderRadius);
      if (cs.boxShadow !== "none") count(shadows, cs.boxShadow);
      if (el.textContent?.trim()) count(fontSizes, `${cs.fontSize}/${cs.fontWeight}/${cs.lineHeight}`);
      if (cs.animationName && cs.animationName !== "none") {
        const key = `${cs.animationName} | ${cs.animationDuration} | ${cs.animationTimingFunction} | ${cs.animationIterationCount} | delay ${cs.animationDelay}`;
        animationsInUse[key] = (animationsInUse[key] || 0) + 1;
      }
    }
    const top = (map, n = 20) =>
      [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, uses]) => ({ value, uses }));

    // Typography of key elements
    const typo = {};
    for (const sel of ["h1", "h2", "h3", "h4", "p", "a", "button", "body"]) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const cs = getComputedStyle(el);
      typo[sel] = {
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        color: cs.color,
        textTransform: cs.textTransform,
      };
    }

    // :root custom properties + @keyframes bodies (same-origin stylesheets only).
    // Capturing keyframes matters: computed styles tell you `animation: slide-up-fade 1s`
    // but not what slide-up-fade DOES. Without the rule body a builder can only guess.
    const cssVars = {};
    const keyframes = {};
    const walkRules = (rules) => {
      for (const rule of rules) {
        if (rule.type === 7 || rule.constructor?.name === "CSSKeyframesRule") {
          const steps = {};
          for (const kf of rule.cssRules) steps[kf.keyText] = kf.style.cssText;
          keyframes[rule.name] = steps;
          continue;
        }
        if (rule.cssRules) {
          try {
            walkRules(rule.cssRules);
          } catch { /* ignore */ }
          continue;
        }
        if (rule.selectorText === ":root" || rule.selectorText === "html") {
          for (const prop of rule.style) {
            if (prop.startsWith("--")) cssVars[prop] = rule.style.getPropertyValue(prop).trim();
          }
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walkRules(sheet.cssRules);
      } catch {
        continue; // cross-origin sheet
      }
    }

    const fontLinks = [...document.querySelectorAll('link[rel="stylesheet"], link[rel="preload"][as="font"]')]
      .map((l) => l.href)
      .filter((h) => /fonts\.|font|\.woff/i.test(h));

    const htmlCs = getComputedStyle(document.documentElement);
    const bodyCs = getComputedStyle(document.body);
    const globalBehaviors = {
      smoothScrollLib: document.querySelector(".lenis, [data-lenis], .locomotive-scroll, [data-scroll-container]")
        ? "detected (Lenis or Locomotive — inspect manually)"
        : null,
      scrollBehavior: htmlCs.scrollBehavior,
      scrollSnapType: htmlCs.scrollSnapType !== "none" ? htmlCs.scrollSnapType : bodyCs.scrollSnapType !== "none" ? bodyCs.scrollSnapType : null,
      bodyBackground: bodyCs.backgroundColor,
      hasFixedHeader: !!document.querySelector("header, nav") &&
        ["fixed", "sticky"].includes(getComputedStyle(document.querySelector("header, nav")).position),
    };

    return {
      colors: top(colors),
      backgrounds: top(bgs),
      fontFamilies: top(families, 10),
      typography: typo,
      fontSizeCombos: top(fontSizes, 25),
      borderRadii: top(radii, 10),
      boxShadows: top(shadows, 10),
      cssVariables: cssVars,
      keyframes,
      animationsInUse,
      fontLinks,
      globalBehaviors,
    };
  });
}

// ---------------------------------------------------------------------------
// Stylesheet rules (hover/focus states, breakpoints, keyframe names)
// ---------------------------------------------------------------------------

// Light brace-matching parser: CSS is regular enough at this level, and this
// avoids taking a dependency just to find hover rules.
export function splitRules(css) {
  const out = [];
  let depth = 0, buf = "", atRule = null, atBuf = "";
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      depth++;
      if (depth === 1) {
        const head = buf.trim();
        buf = "";
        if (head.startsWith("@media") || head.startsWith("@supports") || head.startsWith("@layer") || head.startsWith("@container")) {
          atRule = head;
          atBuf = "";
          continue;
        }
        out.push({ selector: head, body: "", _open: true });
        continue;
      }
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        if (atRule) {
          for (const inner of splitRules(atBuf)) out.push({ ...inner, media: atRule });
          atRule = null;
          atBuf = "";
        } else {
          const last = out[out.length - 1];
          if (last?._open) {
            last.body = buf.trim();
            delete last._open;
          }
          buf = "";
        }
        continue;
      }
    }
    if (atRule && depth >= 1) atBuf += ch;
    else buf += ch;
  }
  return out.filter((r) => r.selector && !r.selector.startsWith("@"));
}

const STATE_RE = /:(hover|focus|focus-visible|focus-within|active|checked|disabled|target|open)\b/;

// Collect every stylesheet's text (fetching cross-origin ones directly), parse
// out interactive-state rules, real breakpoints, and keyframe names.
export async function collectCss(page, { selector = null } = {}) {
  const collected = await page.evaluate(() => {
    const sheets = [];
    for (const sheet of document.styleSheets) {
      let rules = null;
      try {
        rules = sheet.cssRules;
      } catch {
        sheets.push({ href: sheet.href, blocked: true, text: null });
        continue;
      }
      const text = [...rules].map((r) => r.cssText).join("\n");
      sheets.push({ href: sheet.href || "(inline <style>)", blocked: false, text });
    }
    return sheets;
  });

  // Fetch anything the browser refused to expose — all in parallel.
  await Promise.all(
    collected
      .filter((s) => s.blocked && s.href)
      .map(async (s) => {
        try {
          const res = await fetch(s.href, { signal: AbortSignal.timeout(20000), headers: { "User-Agent": "Mozilla/5.0" } });
          if (res.ok) {
            s.text = await res.text();
            s.blocked = false;
            s.fetched = true;
          }
        } catch {
          /* leave blocked — reported in the summary */
        }
      })
  );

  const allCss = collected.filter((s) => s.text).map((s) => s.text).join("\n");
  const rules = splitRules(allCss);

  const interactive = rules
    .filter((r) => STATE_RE.test(r.selector))
    .map((r) => ({ selector: r.selector.trim(), declarations: r.body, media: r.media || null }));

  const byState = {};
  for (const r of interactive) {
    const m = r.selector.match(STATE_RE);
    const k = m ? m[1] : "other";
    (byState[k] ||= []).push(r);
  }

  const breakpoints = [...new Set(
    (allCss.match(/@media[^{]+/g) || [])
      .flatMap((m) => m.match(/\(\s*(min|max)-width\s*:\s*[^)]+\)/g) || [])
      .map((s) => s.replace(/\s+/g, " ").trim())
  )].sort();

  const keyframeNames = [...new Set((allCss.match(/@keyframes\s+([\w-]+)/g) || []).map((s) => s.replace(/@keyframes\s+/, "")))];

  // Optional: exact matched rules for one element, via CDP — same data as the
  // DevTools Styles panel, including :hover rules.
  let matched = null;
  if (selector) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) {
      console.error(`Element not found: ${selector}`);
    } else {
      const styles = await cdp.send("CSS.getMatchedStylesForNode", { nodeId });
      matched = {
        selector,
        matchedRules: (styles.matchedCSSRules || []).map((m) => ({
          selector: m.rule.selectorList?.text,
          origin: m.rule.origin,
          media: m.rule.media?.map((x) => x.text) || null,
          declarations: (m.rule.style?.cssProperties || [])
            .filter((p) => !p.disabled && p.value)
            .map((p) => `${p.name}: ${p.value}`),
        })),
        pseudoRules: (styles.pseudoElements || []).map((p) => ({
          pseudoType: p.pseudoType,
          rules: p.matches?.map((m) => ({
            selector: m.rule.selectorList?.text,
            declarations: (m.rule.style?.cssProperties || []).filter((x) => !x.disabled && x.value).map((x) => `${x.name}: ${x.value}`),
          })),
        })),
        inherited: (styles.inherited || []).length,
      };
    }
  }

  return {
    stylesheets: collected.map((s) => ({ href: s.href, blocked: s.blocked, fetched: !!s.fetched, bytes: s.text?.length || 0 })),
    totalRules: rules.length,
    breakpoints,
    keyframeNames,
    interactiveStates: byState,
    interactiveCount: interactive.length,
    blockedCount: collected.filter((s) => s.blocked).length,
    matched,
  };
}

// ---------------------------------------------------------------------------
// Assets (enumerate on the page, then download in a worker pool)
// ---------------------------------------------------------------------------
export async function collectAssets(page) {
  const found = await page.evaluate(() => {
    const cssUrl = (bg) => {
      const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
      return m ? new URL(m[1], location.href).href : null;
    };
    return {
      images: [...document.querySelectorAll("img")].map((img) => ({
        src: img.currentSrc || img.src,
        srcset: img.srcset || null,
        alt: img.alt,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        // layered-composition hints: siblings + positioning
        siblingImgs: img.parentElement ? img.parentElement.querySelectorAll("img").length : 1,
        position: getComputedStyle(img).position,
        zIndex: getComputedStyle(img).zIndex,
        parentClasses: (img.parentElement?.className || "").toString().slice(0, 80),
      })),
      videos: [...document.querySelectorAll("video")].map((v) => ({
        src: v.currentSrc || v.src || v.querySelector("source")?.src || null,
        poster: v.poster || null,
        autoplay: v.autoplay,
        loop: v.loop,
        muted: v.muted,
        playsInline: v.playsInline,
      })),
      backgroundImages: [...document.querySelectorAll("*")]
        .map((el) => {
          const bg = getComputedStyle(el).backgroundImage;
          if (!bg || bg === "none" || !bg.includes("url(")) return null;
          const u = cssUrl(bg);
          return u && !u.startsWith("data:")
            ? { url: u, element: el.tagName.toLowerCase() + "." + (el.className?.toString().split(" ")[0] || "") }
            : null;
        })
        .filter(Boolean),
      inlineSvgs: [...document.querySelectorAll("svg")].map((s) => ({
        outerHTML: s.outerHTML.slice(0, 4000),
        width: s.getAttribute("width") || s.getBoundingClientRect().width,
        height: s.getAttribute("height") || s.getBoundingClientRect().height,
        context: (s.closest("a,button")?.textContent || s.parentElement?.className || "").toString().trim().slice(0, 60),
      })),
      // Rasters referenced from inside inline SVG (<image href>, <pattern><image>).
      // These are invisible to an <img> scan, yet sites use them for full-size
      // screenshots — miss one and a whole section renders empty.
      svgImages: [...document.querySelectorAll("image")]
        .map((im) => {
          const href = im.getAttribute("href") || im.getAttribute("xlink:href");
          if (!href || href.startsWith("data:")) return null;
          const r = im.getBoundingClientRect();
          return {
            url: new URL(href, location.href).href,
            renderedWidth: Math.round(r.width),
            renderedHeight: Math.round(r.height),
            insidePattern: !!im.closest("pattern"),
          };
        })
        .filter(Boolean),
      seo: {
        favicons: [...document.querySelectorAll('link[rel*="icon"]')].map((l) => ({ href: l.href, sizes: l.sizes?.toString() || "" })),
        ogImage: document.querySelector('meta[property="og:image"]')?.content || null,
        manifest: document.querySelector('link[rel="manifest"]')?.href || null,
        title: document.title,
        description: document.querySelector('meta[name="description"]')?.content || null,
      },
      fonts: performance
        .getEntriesByType("resource")
        .filter((r) => /\.(woff2?|ttf|otf)(\?|$)/i.test(r.name))
        .map((r) => r.name),
    };
  });

  // De-duplicate inline SVGs by content hash
  const svgSeen = new Set();
  found.inlineSvgs = found.inlineSvgs.filter((s) => {
    const h = createHash("md5").update(s.outerHTML).digest("hex");
    if (svgSeen.has(h)) return false;
    svgSeen.add(h);
    return true;
  });
  return found;
}

// Download every asset `found` references into public/, with a concurrency pool
// (not batch barriers — one slow file no longer stalls three fast ones) and a
// disk short-circuit: a file that already exists locally is not re-fetched, so
// multi-page runs and resumed runs only pay for what's new.
export async function downloadAssets(found, { pool = 8, skipExisting = true } = {}) {
  const manifest = [];
  const byRemote = new Map(); // remote url -> manifest entry (dedupe)
  const usedPaths = new Map(); // local path -> remote url (collision detect)

  const destFor = (remote, kind) => {
    const u = new URL(remote);
    const base = decodeURIComponent(u.pathname.split("/").pop() || "asset").replace(/[^a-zA-Z0-9.._-]/g, "_");
    const name = base.includes(".") ? base : base + ".bin";
    const dir = kind === "video" ? "public/videos" : kind === "seo" ? "public/seo" : kind === "font" ? "public/fonts" : "public/images";
    return { dir, path: `${dir}/${name}` };
  };

  async function fetchOne(remote, kind) {
    let { dir, path } = destFor(remote, kind);
    if (usedPaths.has(path) && usedPaths.get(path) !== remote) {
      // filename collision with a different asset — disambiguate with a short hash
      const h = createHash("md5").update(remote).digest("hex").slice(0, 6);
      const parts = path.split(".");
      parts[parts.length - 2] += `-${h}`;
      path = parts.join(".");
    }
    usedPaths.set(path, remote);
    if (skipExisting && !path.endsWith(".bin") && existsSync(path) && statSync(path).size > 0) {
      manifest.push({ remote, local: path, kind, ok: true, cached: true });
      return;
    }
    try {
      const res = await fetch(remote, { signal: AbortSignal.timeout(30000), headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // extension-less URLs (common for favicons/OG): derive extension from content-type
      if (path.endsWith(".bin")) {
        const ct = res.headers.get("content-type") || "";
        const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg", "image/gif": "gif", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/avif": "avif", "video/mp4": "mp4", "video/webm": "webm" }[ct.split(";")[0]];
        if (ext) path = path.replace(/\.bin$/, `.${ext}`);
        if (skipExisting && existsSync(path) && statSync(path).size > 0) {
          manifest.push({ remote, local: path, kind, ok: true, cached: true });
          return;
        }
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      manifest.push({ remote, local: path, kind, ok: true });
    } catch (e) {
      manifest.push({ remote, local: null, kind, ok: false, error: String(e.message || e) });
    }
  }

  const jobs = [
    ...found.images.map((i) => ({ url: i.src, kind: "image" })),
    ...found.backgroundImages.map((b) => ({ url: b.url, kind: "image" })),
    ...found.svgImages.map((b) => ({ url: b.url, kind: "image" })),
    ...found.videos.flatMap((v) => [v.src && { url: v.src, kind: "video" }, v.poster && { url: v.poster, kind: "image" }].filter(Boolean)),
    ...found.seo.favicons.map((f) => ({ url: f.href, kind: "seo" })),
    ...(found.seo.ogImage ? [{ url: found.seo.ogImage, kind: "seo" }] : []),
    ...found.fonts.map((f) => ({ url: f, kind: "font" })),
  ].filter((j) => j.url && !j.url.startsWith("data:"));

  // Dedupe by remote URL, then drain a shared queue with `pool` workers.
  const queue = [];
  for (const j of jobs) {
    if (byRemote.has(j.url)) continue;
    byRemote.set(j.url, true);
    queue.push(j);
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(pool, queue.length) }, async () => {
      while (next < queue.length) {
        const j = queue[next++];
        await fetchOne(j.url, j.kind);
      }
    })
  );

  // Attach local paths back onto the found entries
  const localFor = (remote) => manifest.find((m) => m.remote === remote)?.local || null;
  found.images.forEach((i) => (i.local = localFor(i.src)));
  found.backgroundImages.forEach((b) => (b.local = localFor(b.url)));
  found.svgImages.forEach((b) => (b.local = localFor(b.url)));
  found.videos.forEach((v) => {
    v.local = localFor(v.src);
    v.posterLocal = localFor(v.poster);
  });
  return manifest;
}

// ---------------------------------------------------------------------------
// Section detection + responsive signatures (batched: one evaluate per page)
// ---------------------------------------------------------------------------

// Auto-detect the page's top-level sections. Semantic elements are leaves;
// generic wrapper divs get expanded through; repeated collections stay whole.
export async function detectSections(page) {
  return page.evaluate(() => {
    const LEAF = new Set(["SECTION", "HEADER", "FOOTER", "NAV", "ASIDE", "ARTICLE", "MAIN"]);
    const MIN_H = 40; // site headers are often ~44px on phones
    const found = [];
    // Produce a selector that provably resolves back to this exact element.
    function selectorFor(el) {
      const tag = el.tagName.toLowerCase();
      const ok = (s) => {
        try {
          return document.querySelector(s) === el ? s : null;
        } catch {
          return null;
        }
      };
      if (el.id) {
        const s = ok(tag + "#" + CSS.escape(el.id));
        if (s) return s;
      }
      const classes = (el.className?.toString() || "").split(/\s+/).filter(Boolean).map((c) => CSS.escape(c));
      for (const n of [1, 2, 3]) {
        if (classes.length < n) break;
        const s = ok(tag + "." + classes.slice(0, n).join("."));
        if (s) return s;
      }
      // Guaranteed fallback: absolute nth-child path from <body>
      const parts = [];
      let cur = el;
      while (cur && cur !== document.body && cur.parentElement) {
        parts.unshift(":nth-child(" + ([...cur.parentElement.children].indexOf(cur) + 1) + ")");
        cur = cur.parentElement;
      }
      return "body > " + parts.join(" > ");
    }
    // A real section is roughly viewport-scale. Anything much taller is a
    // container holding several sections, so keep descending through it.
    const MAX_SECTION_H = Math.max(1400, window.innerHeight * 1.6);
    function walk(el, depth) {
      if (depth > 7 || found.length > 25) return;
      for (const child of el.children) {
        if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "svg", "SVG"].includes(child.tagName)) continue;
        const r = child.getBoundingClientRect();
        if (r.height < MIN_H) continue;
        const bigKids = [...child.children].filter((k) => k.getBoundingClientRect().height >= MIN_H);
        // A repeated collection (a card grid, a tile row) is ONE section — it
        // becomes one component fed by a data array, never N sections. Requires
        // same tag AND similar heights: three <div>s of 852/2161/974px is a page
        // scaffold, not a grid, and must still be descended into.
        const kidHeights = bigKids.map((k) => k.getBoundingClientRect().height);
        const minKid = Math.min(...kidHeights);
        const maxKid = Math.max(...kidHeights);
        const isCollection =
          bigKids.length >= 3 &&
          new Set(bigKids.map((k) => k.tagName)).size === 1 &&
          maxKid - minKid <= maxKid * 0.25 && // siblings are roughly equal
          r.height <= MAX_SECTION_H;
        // The rule: a section is the first element small enough to BE a section.
        if (!isCollection && bigKids.length >= 1) {
          if (r.height > MAX_SECTION_H) {
            walk(child, depth + 1);
            continue;
          }
          // A pure wrapper adds nothing of its own — unwrap it even at section
          // scale (common in React output: div > div > main > …).
          if (!LEAF.has(child.tagName) && !child.id && bigKids.length === 1 && bigKids[0].getBoundingClientRect().height >= r.height * 0.92) {
            walk(child, depth + 1);
            continue;
          }
          // A semantic element wrapping only other semantic sections.
          if (LEAF.has(child.tagName) && bigKids.length > 1 && bigKids.every((k) => LEAF.has(k.tagName))) {
            walk(child, depth + 1);
            continue;
          }
        }
        const sel = selectorFor(child);
        if (!found.some((f) => f.selector === sel) && document.querySelector(sel) === child) {
          found.push({ selector: sel, label: sel });
        }
      }
    }
    walk(document.body, 0);
    // Site chrome is always worth its own spec even when nested inside a wrapper
    for (const tag of ["header", "footer"]) {
      const el = document.querySelector(tag);
      if (!el || el.getBoundingClientRect().height < MIN_H) continue;
      const sel = selectorFor(el);
      if (!found.some((f) => f.selector === sel)) found.unshift({ selector: sel, label: sel });
    }
    return found;
  });
}

// Layout signatures for MANY selectors in ONE evaluate round-trip.
export async function measureSections(page, selectors) {
  return page.evaluate((sels) => {
    const signature = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return { error: "not found" };
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const kids = [...el.children];
      const visibleKids = kids.filter((k) => {
        const kcs = getComputedStyle(k);
        return kcs.display !== "none" && kcs.visibility !== "hidden";
      });
      // Find the container with the most visible children — that's the "grid" of
      // the section regardless of technique (grid, flex-wrap, floats, width %).
      const candidates = [el, ...el.querySelectorAll("*")].slice(0, 300);
      let gridEl = el, maxKids = 0;
      for (const c of candidates) {
        const vis = [...c.children].filter((k) => {
          const r = k.getBoundingClientRect();
          return r.width > 40 && r.height > 40 && getComputedStyle(k).display !== "none";
        });
        if (vis.length > maxKids) { maxKids = vis.length; gridEl = c; }
      }
      // Real column count = children sharing the first row (same top, ±10px)
      const gkids = [...gridEl.children].filter((k) => {
        const r = k.getBoundingClientRect();
        return r.width > 40 && r.height > 40 && getComputedStyle(k).display !== "none";
      });
      let realColumns = null;
      if (gkids.length >= 2) {
        const firstTop = gkids[0].getBoundingClientRect().top;
        realColumns = gkids.filter((k) => Math.abs(k.getBoundingClientRect().top - firstTop) < 10).length;
      }
      const gcs = getComputedStyle(gridEl);
      const h = el.querySelector("h1,h2,h3");
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        display: cs.display,
        flexDirection: cs.flexDirection,
        innerLayout: {
          display: gcs.display,
          flexDirection: gcs.flexDirection,
          flexWrap: gcs.flexWrap,
          gridColumns: gcs.gridTemplateColumns === "none" ? null : gcs.gridTemplateColumns.split(" ").length,
          realColumns,
          itemCount: gkids.length,
          gap: gcs.gap,
        },
        childCount: kids.length,
        visibleChildCount: visibleKids.length,
        hiddenChildren: kids.length - visibleKids.length,
        headingFontSize: h ? getComputedStyle(h).fontSize : null,
        paddingX: cs.paddingLeft + " / " + cs.paddingRight,
        fontSize: cs.fontSize,
      };
    };
    const out = {};
    for (const sel of sels) out[sel] = signature(sel);
    return out;
  }, selectors);
}

// Human-readable phone/ipad/pc change summary for one selector.
export function summarizeResponsive(results, sel) {
  const p = results.phone?.[sel] || {};
  const t = results.ipad?.[sel] || {};
  const d = results.pc?.[sel] || {};
  const changes = [];
  const cmp = (label, a, b, aName, bName) => {
    if (a != null && b != null && a !== b) changes.push(`${label}: ${b} (${bName}) → ${a} (${aName})`);
  };
  cmp("columns", p.innerLayout?.realColumns, d.innerLayout?.realColumns, "phone", "pc");
  cmp("grid-template columns", p.innerLayout?.gridColumns, d.innerLayout?.gridColumns, "phone", "pc");
  cmp("flex direction", p.innerLayout?.flexDirection, d.innerLayout?.flexDirection, "phone", "pc");
  cmp("heading size", p.headingFontSize, d.headingFontSize, "phone", "pc");
  cmp("visible children", p.visibleChildCount, d.visibleChildCount, "phone", "pc");
  cmp("hidden children", p.hiddenChildren, d.hiddenChildren, "phone", "pc");
  cmp("padding-x", p.paddingX, d.paddingX, "phone", "pc");
  const ipadLike =
    JSON.stringify(t.innerLayout) === JSON.stringify(d.innerLayout) ? "ipad matches pc layout"
    : JSON.stringify(t.innerLayout) === JSON.stringify(p.innerLayout) ? "ipad matches phone layout"
    : "ipad has its own intermediate layout";
  return { changes: changes.length ? changes : ["no layout change across viewports"], ipadBehavior: ipadLike };
}

// ---------------------------------------------------------------------------
// Deep section walk (batched: one evaluate for many selectors)
// ---------------------------------------------------------------------------

// Full computed-style DOM walk for MANY selectors in ONE evaluate. Rects carry
// both viewport coords (x/y) and absolute page coords (pageX/pageY) so geometry
// stays comparable across sections captured at different scroll positions.
export async function walkSections(page, selectors, { depth = 5 } = {}) {
  return page.evaluate(
    ({ selectors, maxDepth }) => {
      const PROPS = [
        "fontSize","fontWeight","fontFamily","lineHeight","letterSpacing","color","textAlign",
        "textTransform","textDecoration","backgroundColor","backgroundImage","backgroundSize","backgroundPosition",
        "paddingTop","paddingRight","paddingBottom","paddingLeft",
        "marginTop","marginRight","marginBottom","marginLeft",
        "width","height","maxWidth","minWidth","maxHeight","minHeight",
        "display","flexDirection","flexWrap","justifyContent","alignItems","gap","rowGap","columnGap",
        "gridTemplateColumns","gridTemplateRows","gridAutoFlow",
        "borderRadius","borderTopWidth","borderBottomWidth","borderLeftWidth","borderRightWidth","borderColor","borderStyle",
        "boxShadow","overflow","overflowX","overflowY",
        "position","top","right","bottom","left","zIndex","inset",
        "opacity","transform","transition","animation","cursor","pointerEvents","visibility",
        "objectFit","objectPosition","mixBlendMode","filter","backdropFilter",
        "whiteSpace","textOverflow","aspectRatio","order","flexGrow","flexShrink","flexBasis",
      ];
      const SKIP = new Set(["none","normal","auto","0px","rgba(0, 0, 0, 0)","visible","static","initial",""]);
      // CSS-inherited props are ALWAYS recorded, even at default-looking values:
      // the compact format prunes them against the parent Node-side, and pruning
      // is only exact when the raw value is known ("normal" under a parent with
      // letter-spacing set is a real override, not a default to drop).
      const INHERITED = new Set(["fontSize","fontWeight","fontFamily","lineHeight","letterSpacing","color","textAlign","textTransform","whiteSpace","cursor","visibility"]);
      function styles(element) {
        const cs = getComputedStyle(element);
        const out = {};
        for (const p of PROPS) {
          const v = cs[p];
          if (v !== undefined && (INHERITED.has(p) || !SKIP.has(v))) out[p] = v;
        }
        return out;
      }
      function directText(element) {
        return [...element.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent.trim())
          .filter(Boolean)
          .join(" ")
          .slice(0, 500) || null;
      }
      // ::before / ::after carry real visuals (underline bars, icon glyphs,
      // overlays) that getComputedStyle on the element itself never reveals.
      const PSEUDO_PROPS = [
        "content","width","height","backgroundColor","backgroundImage","backgroundSize","borderRadius",
        "position","top","right","bottom","left","transform","opacity","display",
        "borderBottomWidth","borderTopWidth","borderLeftWidth","borderRightWidth","borderColor","borderStyle",
        "margin","padding","zIndex","boxShadow","transition","mixBlendMode","filter",
      ];
      const PSEUDO_TEXT_PROPS = ["fontFamily","fontSize","fontWeight","color","lineHeight","letterSpacing","textAlign"];
      function pseudos(element) {
        const out = {};
        for (const pe of ["::before", "::after"]) {
          const cs = getComputedStyle(element, pe);
          if (!cs.content || cs.content === "none") continue;
          const hasText = cs.content !== '""' && cs.content !== "''" && !cs.content.startsWith("url(");
          const st = { content: cs.content };
          for (const p of [...PSEUDO_PROPS, ...(hasText ? PSEUDO_TEXT_PROPS : [])]) {
            const v = cs[p];
            if (v !== undefined && !SKIP.has(v)) st[p] = v;
          }
          // A pseudo with no box and no text renders nothing — skip it
          if (Object.keys(st).length > 1) out[pe] = st;
        }
        return Object.keys(out).length ? out : undefined;
      }
      const MAX_KIDS = 40;
      function walk(element, d) {
        if (d > maxDepth) return { truncated: true, tag: element.tagName.toLowerCase() };
        const kids = [...element.children];
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          classes: (element.className?.toString() || "").split(" ").filter(Boolean).slice(0, 6).join(" ") || null,
          text: directText(element),
          href: element.tagName === "A" ? element.getAttribute("href") : undefined,
          ariaLabel: element.getAttribute("aria-label") || undefined,
          img: element.tagName === "IMG"
            ? { src: element.currentSrc || element.src, alt: element.alt, w: element.naturalWidth, h: element.naturalHeight }
            : undefined,
          isSvg: element.tagName.toLowerCase() === "svg" || undefined,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            pageX: Math.round(rect.x + window.scrollX),
            pageY: Math.round(rect.y + window.scrollY),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
          styles: styles(element),
          pseudo: pseudos(element),
          childCount: kids.length,
          truncatedChildren: kids.length > MAX_KIDS ? kids.length - MAX_KIDS : undefined,
          children: kids.slice(0, MAX_KIDS).map((c) => walk(c, d + 1)),
        };
      }
      const out = {};
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        out[selector] = el ? walk(el, 0) : { error: "Element not found: " + selector };
      }
      return out;
    },
    { selectors, maxDepth: depth }
  );
}

// Style deltas between two captures of the same subtree, element by element.
// Both real styles and pseudo-element styles count: a hover effect built from a
// ::before overlay changes nothing on the element itself.
export function diffNode(a, b, path, out) {
  if (!a || !b || a.error || b.error) return;
  const keys = new Set([...Object.keys(a.styles || {}), ...Object.keys(b.styles || {})]);
  for (const k of keys) {
    if ((a.styles?.[k] || null) !== (b.styles?.[k] || null)) {
      out.push({ path, prop: k, before: a.styles?.[k] ?? "(unset)", after: b.styles?.[k] ?? "(unset)" });
    }
  }
  for (const pe of ["::before", "::after"]) {
    const pa = a.pseudo?.[pe] || {};
    const pb = b.pseudo?.[pe] || {};
    const pkeys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
    for (const k of pkeys) {
      if ((pa[k] || null) !== (pb[k] || null)) {
        out.push({ path: path + pe, prop: k, before: pa[k] ?? "(unset)", after: pb[k] ?? "(unset)" });
      }
    }
  }
  (a.children || []).forEach((c, i) => diffNode(c, b.children?.[i], `${path} > ${c.tag}[${i}]`, out));
}

// Short, readable section name from an auto-detected selector. Real ids and
// semantic tags make good names; Tailwind utility soup does not — `.flex` or an
// escaped `bg-\[\#150002\]` (whose \# would false-match a naive id regex) must
// fall through to section-N rather than become the section's identity.
const UTILITY_CLASS = /^(flex|grid|block|inline|relative|absolute|sticky|fixed|hidden|container|group|peer|isolate|w-|h-|max-|min-|size-|bg-|text-|font-|p[trblxyse]?-|m[trblxyse]?-|space-|gap-|items-|justify-|content-|self-|place-|overflow|rounded|border|ring|shadow|opacity-|z-|inset-|top-|left-|right-|bottom-|col-|row-|order-|grow|shrink|basis-|aspect-|object-|translate|scale|rotate|transition|duration-|ease-|delay-|animate-|cursor-|select-|pointer-|sr-only|not-sr|leading-|tracking-|whitespace-|break-|truncate|align-|list-|divide-|from-|via-|to-|backdrop-|blur|mix-blend|will-change|origin-|columns-|(sm|md|lg|xl|2xl|hover|focus|active|dark|group-hover)[:\\])/;
export function nameFromSelector(sel, index) {
  const id = sel.match(/(?<!\\)#([a-zA-Z][\w-]*)/);
  if (id) return id[1].toLowerCase();
  const tag = sel.match(/^([a-z]+)(?:[.#[:]|$)/)?.[1];
  if (tag && ["header", "footer", "nav", "main", "aside", "article", "form"].includes(tag)) return tag;
  const classes = [...sel.matchAll(/(?<!\\)\.([a-zA-Z][\w-]{2,})/g)].map((m) => m[1]);
  const meaningful = classes.find((c) => !UTILITY_CLASS.test(c));
  if (meaningful) return meaningful.toLowerCase().slice(0, 24);
  return `section-${index + 1}`;
}
