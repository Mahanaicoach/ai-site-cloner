#!/usr/bin/env node
// Enumerate and download every asset on a page: <img> (incl. layered/overlay),
// <video>, CSS background images, inline SVGs, favicons/OG images, fonts.
// Usage: node scripts/extract/assets.mjs <url> [--no-download]
// Output: docs/research/<host>/assets.json + files in public/
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { launchPage, gotoAndSettle, autoScroll, hostOf, writeJson, parseArgs } from "../lib.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args._[0];
if (!url) {
  console.error("Usage: node scripts/extract/assets.mjs <url> [--no-download]");
  process.exit(1);
}
const doDownload = !args["no-download"];

const { browser, page } = await launchPage();
await gotoAndSettle(page, url);
await autoScroll(page); // trigger lazy loading

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
await browser.close();

// De-duplicate inline SVGs by content hash
const svgSeen = new Set();
found.inlineSvgs = found.inlineSvgs.filter((s) => {
  const h = createHash("md5").update(s.outerHTML).digest("hex");
  if (svgSeen.has(h)) return false;
  svgSeen.add(h);
  return true;
});

// ---- Download ----
const host = hostOf(url);
const manifest = [];
const destFor = (remote, kind) => {
  const u = new URL(remote);
  const base = decodeURIComponent(u.pathname.split("/").pop() || "asset").replace(/[^a-zA-Z0-9.._-]/g, "_");
  const name = base.includes(".") ? base : base + ".bin";
  const dir = kind === "video" ? "public/videos" : kind === "seo" ? "public/seo" : kind === "font" ? "public/fonts" : "public/images";
  return { dir, path: `${dir}/${name}`, name };
};

async function download(remote, kind) {
  if (!remote || remote.startsWith("data:")) return null;
  const { dir, path } = destFor(remote, kind);
  if (manifest.some((m) => m.local === path && m.remote !== remote)) {
    // filename collision with a different asset — disambiguate with a short hash
    const h = createHash("md5").update(remote).digest("hex").slice(0, 6);
    const parts = path.split(".");
    parts[parts.length - 2] += `-${h}`;
    return downloadTo(remote, kind, dir, parts.join("."));
  }
  return downloadTo(remote, kind, dir, path);
}
async function downloadTo(remote, kind, dir, path) {
  if (manifest.some((m) => m.remote === remote)) return manifest.find((m) => m.remote === remote).local;
  try {
    const res = await fetch(remote, { signal: AbortSignal.timeout(30000), headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // extension-less URLs (common for favicons/OG): derive extension from content-type
    if (path.endsWith(".bin")) {
      const ct = res.headers.get("content-type") || "";
      const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg", "image/gif": "gif", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/avif": "avif", "video/mp4": "mp4", "video/webm": "webm" }[ct.split(";")[0]];
      if (ext) path = path.replace(/\.bin$/, `.${ext}`);
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    manifest.push({ remote, local: path, kind, ok: true });
    return path;
  } catch (e) {
    manifest.push({ remote, local: null, kind, ok: false, error: String(e.message || e) });
    return null;
  }
}

if (doDownload) {
  const jobs = [
    ...found.images.map((i) => ({ url: i.src, kind: "image" })),
    ...found.backgroundImages.map((b) => ({ url: b.url, kind: "image" })),
    ...found.svgImages.map((b) => ({ url: b.url, kind: "image" })),
    ...found.videos.flatMap((v) => [v.src && { url: v.src, kind: "video" }, v.poster && { url: v.poster, kind: "image" }].filter(Boolean)),
    ...found.seo.favicons.map((f) => ({ url: f.href, kind: "seo" })),
    ...(found.seo.ogImage ? [{ url: found.seo.ogImage, kind: "seo" }] : []),
    ...found.fonts.map((f) => ({ url: f, kind: "font" })),
  ];
  // batched 4-way parallel downloads
  for (let i = 0; i < jobs.length; i += 4) {
    await Promise.all(jobs.slice(i, i + 4).map((j) => download(j.url, j.kind)));
  }
}

// Attach local paths back onto the found entries
const localFor = (remote) => manifest.find((m) => m.remote === remote)?.local || null;
found.images.forEach((i) => (i.local = localFor(i.src)));
found.backgroundImages.forEach((b) => (b.local = localFor(b.url)));
found.svgImages.forEach((b) => (b.local = localFor(b.url)));
found.videos.forEach((v) => {
  v.local = localFor(v.src);
  v.posterLocal = localFor(v.poster);
});

writeJson(`docs/research/${host}/assets.json`, {
  url,
  generatedAt: new Date().toISOString(),
  ...found,
  downloads: manifest,
});
const okCount = manifest.filter((m) => m.ok).length;
const failCount = manifest.filter((m) => !m.ok).length;
console.log(
  `Images: ${found.images.length} · BG images: ${found.backgroundImages.length} · SVG rasters: ${found.svgImages.length} · Videos: ${found.videos.length} · SVGs: ${found.inlineSvgs.length} · Fonts: ${found.fonts.length}` +
    (doDownload ? ` · Downloaded: ${okCount} ok, ${failCount} failed` : " · (download skipped)")
);
if (failCount > 0) console.log("Failed downloads listed in assets.json — retry or fetch manually.");
