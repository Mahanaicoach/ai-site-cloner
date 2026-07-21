// Shared helpers for all extraction/QA scripts.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
// In-process response cache
//
// Every context has an isolated HTTP cache, so a 3-viewport run downloads every
// image, font and script three times — and page.mjs loads the same page many
// more. Cache static subresources once per process and replay them. GET-only,
// static resource types only (documents and XHR always hit the network).
// ---------------------------------------------------------------------------
const CACHEABLE = new Set(["image", "font", "stylesheet", "script"]);
const MAX_ENTRY = 4 * 1024 * 1024; // 4 MB per resource
const MAX_TOTAL = 256 * 1024 * 1024; // 256 MB overall
const _cache = new Map(); // url -> { body: Buffer, contentType: string }
let _cacheBytes = 0;

async function enableResponseCache(context) {
  await context.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() !== "GET" || !CACHEABLE.has(req.resourceType())) {
      return route.fallback();
    }
    const url = req.url();
    const hit = _cache.get(url);
    if (hit) {
      return route.fulfill({ status: 200, contentType: hit.contentType, body: hit.body });
    }
    let res;
    try {
      res = await route.fetch();
    } catch {
      return route.fallback(); // fetch aborted (navigation) — let the browser handle it
    }
    if (res.status() === 200) {
      try {
        const body = await res.body();
        if (body.length <= MAX_ENTRY && _cacheBytes + body.length <= MAX_TOTAL) {
          _cache.set(url, { body, contentType: res.headers()["content-type"] || "" });
          _cacheBytes += body.length;
        }
      } catch {
        /* body unavailable — just pass the response through */
      }
    }
    return route.fulfill({ response: res });
  });
}

export function getBrowser() {
  if (!_browserPromise) _browserPromise = chromium.launch({ headless: true });
  return _browserPromise;
}

// Every script must call this before exiting — the browser process keeps the
// Node event loop alive otherwise.
export async function closeBrowser() {
  if (!_browserPromise) return;
  const pending = _browserPromise;
  _browserPromise = null;
  await (await pending).close();
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
  if (cache) await enableResponseCache(context);
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

// Wait until every <img> currently in the DOM has finished loading (or errored).
// This is the signal networkidle was standing in for on image-heavy pages, and
// unlike networkidle it can't be held hostage by analytics beacons.
async function imagesSettled(page, { timeout = 4000 } = {}) {
  await page
    .evaluate(
      (timeout) =>
        Promise.race([
          Promise.all(
            [...document.images]
              .filter((img) => !img.complete)
              .map((img) => new Promise((r) => {
                img.addEventListener("load", r, { once: true });
                img.addEventListener("error", r, { once: true });
              }))
          ),
          new Promise((r) => setTimeout(r, timeout)),
        ]),
      timeout
    )
    .catch(() => {});
}

export async function gotoAndSettle(page, url) {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  // Four precise signals instead of one long networkidle gamble. Sites with
  // analytics/websocket chatter never reach networkidle and used to pay the
  // full 15s on EVERY load — the cap is now 4s and the other three signals
  // (fonts ready, images decoded, stable height) carry the real guarantee.
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await imagesSettled(page);
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
      // whether those images *arrive* is what the networkidle wait below covers.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
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
