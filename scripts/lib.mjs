// Shared helpers for all extraction/QA scripts.
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

// The three viewports every extraction and QA step must cover.
export const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  ipad: { width: 768, height: 1024 },
  pc: { width: 1440, height: 900 },
};

export function hostOf(url) {
  return new URL(url).hostname.replace(/^www\./, "");
}

export function slugify(s) {
  return (
    s
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "index"
  );
}

// URL pathname -> Next.js route ("/about-us" stays "/about-us", "/" stays "/")
export function routeOf(url) {
  const p = new URL(url).pathname.replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.error(`  ✓ wrote ${path}`);
}

// ---------------------------------------------------------------------------
// Browser lifecycle
//
// One Chromium per process, shared by every context. Launching costs ~350ms;
// opening a context on a live browser costs ~40ms. Scripts that touch three
// viewports used to pay the launch three times — now they pay it once.
// ---------------------------------------------------------------------------

// Memoise the launch *promise*, not the resolved browser. Concurrent callers
// (forEachViewport opens three contexts at once) would otherwise all observe a
// null browser and each launch their own Chromium — closeBrowser() then closes
// only the last one and the orphans keep the Node event loop alive forever.
let _browserPromise = null;

const CONTEXT_OPTS = {
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  deviceScaleFactor: 1,
  // Service workers serve stale shells and bypass request interception — both
  // poison extraction determinism and the response cache below.
  serviceWorkers: "block",
};

// ---------------------------------------------------------------------------
// Response cache: memory -> disk -> network
//
// Every context has an isolated HTTP cache, so a 3-viewport run downloads every
// image, font and script three times — and a full clone run spawns ~100 separate
// script processes against the same site. The memory layer serves repeats within
// one process; the disk layer (docs/research/.cache/) survives across processes,
// so probe/section/diff runs after page.mjs load subresources from disk instead
// of the network. GET-only, static resource types only (documents and XHR always
// hit the network). `manifest.mjs init --force` wipes the disk layer, and stale
// entries expire after CACHE_TTL (SITE_CLONER_CACHE_TTL_H hours, default 24).
// Set SITE_CLONER_NO_CACHE=1 to bypass caching entirely.
// ---------------------------------------------------------------------------
const CACHEABLE = new Set(["image", "font", "stylesheet", "script"]);
const MAX_ENTRY = 4 * 1024 * 1024; // 4 MB per resource
const MAX_TOTAL = 256 * 1024 * 1024; // 256 MB overall (memory layer)
export const CACHE_DIR = "docs/research/.cache";
const CACHE_TTL_MS = (parseFloat(process.env.SITE_CLONER_CACHE_TTL_H) || 24) * 3600 * 1000;
const _cache = new Map(); // url -> { body: Buffer, contentType: string }
let _cacheBytes = 0;
const _cacheStats = { memHits: 0, diskHits: 0, misses: 0 };
let _cacheDirReady = false;

// The clone under QA serves /_next/static chunks whose CONTENT changes between
// fix iterations under stable names — disk-caching loopback origins would keep
// serving the old build and fake the diff scores. Memory (single process) is safe.
function isLoopback(url) {
  const h = new URL(url).hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

function diskPathsFor(url) {
  const key = createHash("sha256").update(url).digest("hex").slice(0, 24);
  return { bin: join(CACHE_DIR, `${key}.bin`), meta: join(CACHE_DIR, `${key}.json`) };
}

function diskRead(url) {
  try {
    const { bin, meta } = diskPathsFor(url);
    const m = JSON.parse(readFileSync(meta, "utf8"));
    if (m.url !== url) return null; // hash-prefix collision — treat as miss
    if (Date.now() - m.savedAt > CACHE_TTL_MS) return null;
    return { body: readFileSync(bin), contentType: m.contentType };
  } catch {
    return null; // missing/torn/corrupt entry — plain miss
  }
}

function diskWrite(url, body, contentType) {
  try {
    if (!_cacheDirReady) {
      mkdirSync(CACHE_DIR, { recursive: true });
      _cacheDirReady = true;
    }
    const { bin, meta } = diskPathsFor(url);
    // tmp + rename so a concurrent reader never sees a half-written file. The
    // body lands before the sidecar: a sidecar without its .bin reads as a miss.
    writeFileSync(`${bin}.${process.pid}.tmp`, body);
    renameSync(`${bin}.${process.pid}.tmp`, bin);
    writeFileSync(
      `${meta}.${process.pid}.tmp`,
      JSON.stringify({ url, contentType, savedAt: Date.now(), size: body.length })
    );
    renameSync(`${meta}.${process.pid}.tmp`, meta);
  } catch {
    /* disk cache is best-effort — a failed write is just a future miss */
  }
}

function memStore(url, body, contentType) {
  if (body.length <= MAX_ENTRY && _cacheBytes + body.length <= MAX_TOTAL) {
    _cache.set(url, { body, contentType });
    _cacheBytes += body.length;
  }
}

async function enableResponseCache(context) {
  await context.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() !== "GET" || !CACHEABLE.has(req.resourceType())) {
      return route.fallback();
    }
    const url = req.url();
    const hit = _cache.get(url);
    if (hit) {
      _cacheStats.memHits++;
      return route.fulfill({ status: 200, contentType: hit.contentType, body: hit.body });
    }
    if (!isLoopback(url)) {
      const disk = diskRead(url);
      if (disk) {
        _cacheStats.diskHits++;
        memStore(url, disk.body, disk.contentType);
        return route.fulfill({ status: 200, contentType: disk.contentType, body: disk.body });
      }
    }
    _cacheStats.misses++;
    let res;
    try {
      res = await route.fetch();
    } catch {
      return route.fallback(); // fetch aborted (navigation) — let the browser handle it
    }
    if (res.status() === 200) {
      try {
        const body = await res.body();
        const contentType = res.headers()["content-type"] || "";
        memStore(url, body, contentType);
        if (body.length <= MAX_ENTRY && !isLoopback(url)) diskWrite(url, body, contentType);
      } catch {
        /* body unavailable — just pass the response through */
      }
    }
    return route.fulfill({ response: res });
  });
}

// Launch Chromium, installing it on the fly if this is a fresh checkout.
// "npx playwright install chromium" as a manual first step is exactly the kind
// of setup friction that makes a template feel broken — the error Playwright
// throws names the fix, so apply it automatically and retry once.
async function launchInstallingIfMissing() {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    if (!/playwright install|Executable doesn't exist/i.test(String(err?.message))) throw err;
    console.error("  Chromium not installed — running `npx playwright install chromium` (one-time)…");
    const r = spawnSync("npx", ["playwright", "install", "chromium"], { stdio: "inherit" });
    if (r.status !== 0) throw err;
    return chromium.launch({ headless: true });
  }
}

export function getBrowser() {
  if (!_browserPromise) _browserPromise = launchInstallingIfMissing();
  return _browserPromise;
}

// Every script must call this before exiting — the browser process keeps the
// Node event loop alive otherwise.
export async function closeBrowser() {
  if (!_browserPromise) return;
  const pending = _browserPromise;
  _browserPromise = null;
  await (await pending).close();
  const { memHits, diskHits, misses } = _cacheStats;
  if (memHits + diskHits + misses > 0) {
    console.error(`  cache: ${memHits} mem, ${diskHits} disk, ${misses} network`);
  }
}

// Lazy-loading detection: count IntersectionObservers the page constructs, so
// autoScroll() can tell "this page reveals content on scroll" from "this page
// is fully painted already" instead of always paying the scroll cost.
async function instrumentLazySignals(context) {
  await context.addInitScript(() => {
    window.__ioCount = 0;
    const Native = window.IntersectionObserver;
    if (!Native) return;
    window.IntersectionObserver = class extends Native {
      constructor(...a) {
        super(...a);
        window.__ioCount++;
      }
    };
  });
}

// Open a page on the shared browser. `close()` disposes only this context.
// `cache: false` opts out of response caching (e.g. when probing live-changing pages).
export async function openPage(viewport = VIEWPORTS.pc, { cache = true } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport, ...CONTEXT_OPTS });
  await instrumentLazySignals(context);
  if (cache && !process.env.SITE_CLONER_NO_CACHE) await enableResponseCache(context);
  const page = await context.newPage();
  return { page, context, close: () => context.close() };
}

// Back-compat for single-page scripts written against the older API:
//   const { browser, page } = await launchPage();  …  await browser.close();
// `browser.close()` tears down the context AND the shared Chromium, matching the
// old semantics exactly. Deferring the teardown to a process exit hook would
// deadlock: Playwright's open socket keeps the event loop alive, so 'beforeExit'
// never fires and the script hangs instead of exiting.
export async function launchPage(viewport = VIEWPORTS.pc) {
  const { page, close } = await openPage(viewport);
  return {
    page,
    browser: {
      close: async () => {
        await close();
        await closeBrowser();
      },
    },
  };
}

// Run `fn(page, viewportName)` at several viewports concurrently on one browser.
// Returns results keyed by viewport name. Page loads are the expensive part and
// they overlap completely here.
export async function forEachViewport(names, fn) {
  const entries = await Promise.all(
    names.map(async (vpName) => {
      const { page, close } = await openPage(VIEWPORTS[vpName]);
      try {
        return [vpName, await fn(page, vpName)];
      } finally {
        await close();
      }
    })
  );
  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// Waiting — conditions, not sleeps
// ---------------------------------------------------------------------------

// Wait until the document stops growing. Replaces a fixed sleep with the signal
// the sleep was standing in for: late CSS, webfonts and hero images all change
// scrollHeight when they land.
export async function settleLayout(page, { timeout = 3000, quietMs = 150 } = {}) {
  await page
    .evaluate(
      async ({ timeout, quietMs }) => {
        const deadline = Date.now() + timeout;
        let last = -1;
        let stableSince = 0;
        while (Date.now() < deadline) {
          const h = document.documentElement.scrollHeight;
          if (h === last) {
            if (!stableSince) stableSince = Date.now();
            if (Date.now() - stableSince >= quietMs) return;
          } else {
            last = h;
            stableSince = 0;
          }
          await new Promise((r) => requestAnimationFrame(r));
        }
      },
      { timeout, quietMs }
    )
    .catch(() => {});
}

// Wait until every <img> in the DOM has finished loading (or errored). This is
// the signal networkidle was standing in for on image-heavy pages, and unlike
// networkidle it can't be held hostage by analytics beacons. Polls instead of
// snapshotting once so images inserted AFTER the call starts (late hydration,
// lazy-load) are still waited on — which is what lets it run concurrently with
// networkidle instead of after it.
async function imagesSettled(page, { timeout = 4000 } = {}) {
  await page
    .evaluate(async (timeout) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const pending = [...document.images].filter((img) => !img.complete);
        if (!pending.length) return;
        await Promise.race([
          Promise.all(
            pending.map(
              (img) =>
                new Promise((r) => {
                  img.addEventListener("load", r, { once: true });
                  img.addEventListener("error", r, { once: true });
                })
            )
          ),
          new Promise((r) => setTimeout(r, 100)), // tick: re-collect for new <img>s
        ]);
      }
    }, timeout)
    .catch(() => {});
}

export async function gotoAndSettle(page, url) {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  // Precise signals instead of one long networkidle gamble. The three
  // independent waits run concurrently — their caps race instead of summing —
  // and settleLayout goes last because stable height depends on fonts and
  // images having landed.
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {}),
    page.evaluate(() => document.fonts?.ready).catch(() => {}),
    imagesSettled(page),
  ]);
  await settleLayout(page);
}

// Scroll to bottom in steps (triggers lazy-loaded images/animations), then back
// to top. Skipped entirely when the page shows no sign of lazy content — pass
// `{ force: true }` to scroll regardless.
export async function autoScroll(page, { force = false } = {}) {
  const needed = force
    ? true
    : await page
        .evaluate(() => {
          if (window.__ioCount > 0) return true;
          return !!document.querySelector(
            'img[loading="lazy"],iframe[loading="lazy"],[data-src],[data-srcset],[data-bg],[data-lazy]'
          );
        })
        .catch(() => true); // if the probe fails, assume the worst and scroll

  if (!needed) return;

  await page.evaluate(async () => {
    // Half-viewport steps: IntersectionObserver thresholds commonly need an
    // element substantially in view, and a full-viewport jump can skip them.
    const step = window.innerHeight / 2;
    for (let y = 0; y <= document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      // Two frames is enough for observer callbacks to fire and request images;
      // whether those images *arrive* is what the waits below cover.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    window.scrollTo(0, 0);
  });
  // The real lazy-load guarantee is "the images the scroll requested have
  // decoded" — imagesSettled states that directly, so networkidle gets the same
  // 4s cap it has everywhere else instead of the old 10s gamble.
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {}),
    imagesSettled(page),
  ]);
  await settleLayout(page);
}

// How long the transitions inside `selector` actually take, in ms — so a state
// capture can wait exactly that long instead of guessing. Covers ::before and
// ::after, where hover overlays usually live.
export async function transitionMs(page, selector, { min = 150, max = 4000 } = {}) {
  const ms = await page
    .evaluate(
      ({ selector, max }) => {
        const root = document.querySelector(selector);
        if (!root) return 0;
        const els = [root, ...root.querySelectorAll("*")].slice(0, 500);
        const nums = (v) => String(v || "").split(",").map((s) => parseFloat(s) || 0);
        let worst = 0;
        for (const el of els) {
          for (const pe of [null, "::before", "::after"]) {
            const cs = getComputedStyle(el, pe);
            const dur = nums(cs.transitionDuration);
            const delay = nums(cs.transitionDelay);
            for (let i = 0; i < dur.length; i++) {
              worst = Math.max(worst, (dur[i] + (delay[i] || 0)) * 1000);
            }
          }
          if (worst >= max) return max;
        }
        return worst;
      },
      { selector, max }
    )
    .catch(() => 0);
  return Math.min(max, Math.max(min, Math.round(ms)));
}

// Park animations/transitions/videos so screenshots are deterministic (for QA diffs).
// Animations jump to their END state, not `animation: none`: killing them outright
// reverts `fill-mode: forwards` entry animations to their pre-animation frame, so
// scroll-revealed content screenshots at opacity 0 and QA penalizes a clone that
// is actually correct. A near-zero duration with iteration-count 1 lands every
// animation (including infinite spinners) on its final keyframe deterministically.
export async function freezePage(page) {
  await page.addStyleTag({
    content:
      "*,*::before,*::after{" +
      "animation-delay:-0.0001s!important;animation-duration:0.0001s!important;" +
      "animation-iteration-count:1!important;" +
      "transition-delay:0s!important;transition-duration:0s!important;" +
      "caret-color:transparent!important;scroll-behavior:auto!important}",
  });
  // Two frames so the jumped-to-end animation states actually paint.
  await page
    .evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    .catch(() => {});
  // Park videos on a frame that actually has content. Seeking to 0 lands on the
  // first encoded frame, which for a screen recording is often blank — that
  // renders as an empty box and costs the section real diff points.
  await page.evaluate(async () => {
    const vids = [...document.querySelectorAll("video")];
    await Promise.all(
      vids.map(
        (v) =>
          new Promise((resolve) => {
            v.pause();
            const target = Number.isFinite(v.duration) && v.duration > 1 ? 1 : 0;
            if (Math.abs(v.currentTime - target) < 0.05) return resolve();
            v.addEventListener("seeked", () => resolve(), { once: true });
            v.currentTime = target;
            setTimeout(resolve, 1000); // don't hang on a video that won't seek
          })
      )
    );
  });
}

// ---------------------------------------------------------------------------
// Review-size screenshots
//
// Full-res PNGs (a full clone run produces ~8.5MB of them) are what pixelmatch
// and builder agents need — but the FOREMAN opens screenshots dozens of times
// just to judge "does this look right", and every full-res view costs tokens.
// A 640px-wide -review.png next to each full-res file is visually sufficient
// for judgment work at a fraction of the size.
// ---------------------------------------------------------------------------
export const REVIEW_WIDTH = 640;

export function reviewPathFor(pngPath) {
  return pngPath.replace(/\.png$/i, "-review.png");
}

// Box-filter downscale to REVIEW_WIDTH wide. `src` is a PNG instance, a PNG
// buffer, or a file path. No-op (returns false) when already narrow enough.
export function writeReviewPng(src, destPath) {
  let img;
  try {
    img = src instanceof PNG ? src : PNG.sync.read(typeof src === "string" ? readFileSync(src) : src);
  } catch {
    return false; // unreadable source — review copy is best-effort
  }
  if (img.width <= REVIEW_WIDTH) return false;
  const scale = REVIEW_WIDTH / img.width;
  const w = REVIEW_WIDTH;
  const h = Math.max(1, Math.round(img.height * scale));
  const out = new PNG({ width: w, height: h });
  const sd = img.data, dd = out.data;
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y / scale);
    const sy1 = Math.min(img.height, Math.max(sy0 + 1, Math.floor((y + 1) / scale)));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x / scale);
      const sx1 = Math.min(img.width, Math.max(sx0 + 1, Math.floor((x + 1) / scale)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * img.width + sx) * 4;
          r += sd[i];
          g += sd[i + 1];
          b += sd[i + 2];
          a += sd[i + 3];
          n++;
        }
      }
      const j = (y * w + x) * 4;
      dd[j] = r / n;
      dd[j + 1] = g / n;
      dd[j + 2] = b / n;
      dd[j + 3] = a / n;
    }
  }
  writeFileSync(destPath, PNG.sync.write(out));
  return true;
}

// Screenshot every section from ONE full-page capture: measure each selector's
// page-coordinate box, take a single fullPage shot, and crop the sections out of
// it (deviceScaleFactor is 1, so CSS px == image px). Pixel-identical to a
// per-section locator.screenshot() chain — same bounding boxes, same frozen
// page — minus N sequential scroll+shoot round-trips. Bonus fidelity: sticky
// headers can no longer bleed into mid-page section shots, because nothing
// scrolls between captures. Call AFTER freezePage so boxes match the pixels.
//
// `sections` = [{ name, selector }]; `pathFor(section)` -> output PNG path;
// `fullPagePath` additionally saves the full-page shot itself.
// `review: true` (default) also writes a 640px -review.png beside every PNG —
// pass false for QA captures that only feed pixelmatch.
// Sections the crop can't produce (selector missing, zero box, page taller than
// Chromium's capture limit) fall back to a locator screenshot; returns
// { failed: [names] } for anything neither path could capture.
export async function shootSectionsFromFullPage(page, sections, { fullPagePath = null, pathFor, review = true }) {
  const boxes = await page
    .evaluate((sels) => {
      window.scrollTo(0, 0);
      const out = {};
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) {
          out[sel] = null;
          continue;
        }
        const r = el.getBoundingClientRect();
        // Round the EDGES, not width/height — for fractional boxes this matches
        // how the element screenshot clip lands on whole pixels.
        const x = Math.round(r.x + scrollX);
        const y = Math.round(r.y + scrollY);
        out[sel] = {
          x,
          y,
          width: Math.round(r.x + scrollX + r.width) - x,
          height: Math.round(r.y + scrollY + r.height) - y,
        };
      }
      return out;
    }, sections.map((s) => s.selector))
    .catch(() => ({}));

  const buf = await page.screenshot({ fullPage: true, ...(fullPagePath ? { path: fullPagePath } : {}) });
  let img = null;
  try {
    img = PNG.sync.read(buf);
  } catch {
    /* unreadable capture — every section falls back below */
  }
  if (review && img && fullPagePath) writeReviewPng(img, reviewPathFor(fullPagePath));

  const fallbacks = [];
  for (const s of sections) {
    const b = img && boxes[s.selector];
    const x = b ? Math.max(0, Math.min(b.x, img.width - 1)) : 0;
    const y = b ? Math.max(0, Math.min(b.y, img.height - 1)) : 0;
    const w = b ? Math.min(b.width, img.width - x) : 0;
    const h = b ? Math.min(b.height, img.height - y) : 0;
    if (!b || w < 1 || h < 1) {
      fallbacks.push(s);
      continue;
    }
    try {
      const out = new PNG({ width: w, height: h });
      PNG.bitblt(img, out, x, y, w, h, 0, 0);
      writeFileSync(pathFor(s), PNG.sync.write(out));
      if (review) writeReviewPng(out, reviewPathFor(pathFor(s)));
    } catch {
      fallbacks.push(s);
    }
  }

  const failed = [];
  for (const s of fallbacks) {
    try {
      const loc = page.locator(s.selector).first();
      await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
      await loc.screenshot({ path: pathFor(s), timeout: 5000 });
      if (review) writeReviewPng(pathFor(s), reviewPathFor(pathFor(s)));
    } catch {
      failed.push(s.name);
    }
  }
  return { failed };
}

// Tiny CLI arg parser: --key value / --flag  ->  { _: [positionals], key: value, flag: true }
// A repeated key collects into an array (--selector a --selector b -> ["a","b"]).
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const val = next !== undefined && !next.startsWith("--") ? (i++, next) : true;
      if (key in out) out[key] = [].concat(out[key], val);
      else out[key] = val;
    } else {
      out._.push(a);
    }
  }
  return out;
}

// Normalise a possibly-repeated arg into an array. `--selector x` and
// `--selector x --selector y` both come back as arrays.
export function toList(v) {
  if (v === undefined || v === true) return [];
  return [].concat(v);
}
