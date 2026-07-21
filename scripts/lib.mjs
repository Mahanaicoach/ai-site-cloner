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

export async function launchPage(viewport = VIEWPORTS.pc) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport,
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  return { browser, page };
}

export async function gotoAndSettle(page, url) {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(1500);
}

// Scroll to bottom in steps (triggers lazy-loaded images/animations), then back to top.
export async function autoScroll(page) {
  await page.evaluate(async () => {
    const step = window.innerHeight / 2;
    const max = document.body.scrollHeight;
    for (let y = 0; y <= max; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(800);
}

// Kill animations/transitions/videos so screenshots are deterministic (for QA diffs).
export async function freezePage(page) {
  await page.addStyleTag({
    content:
      "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}",
  });
  await page.evaluate(() => {
    document.querySelectorAll("video").forEach((v) => {
      v.pause();
      v.currentTime = 0;
    });
  });
}

// Tiny CLI arg parser: --key value / --flag  ->  { _: [positionals], key: value, flag: true }
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}
