# Example: cloning uploadthing.com

A real end-to-end run of `/clone-website` against **https://uploadthing.com** — used to validate the pipeline and kept here as a reference for what good output looks like.

> UploadThing is an open-source product by Ping Labs. Cloned here as a technical exercise only. Don't republish someone else's brand.

![original vs clone](comparison.png)

## Result

One page, 7 components, built by **4 builder agents running in parallel**, each given only its spec plus instructions to verify against the live site.

| Section | PC (1440) | iPad (768) | Phone (390) |
|---|---|---|---|
| header + footer | **99.8%** | **99.6%** | **99.4%** |
| pricing | **96.3%** | **97.6%** | **99.5%** |

Full-page diffs land at 83–87%; the residual is cumulative vertical drift, not visual error — which is exactly why the pipeline scores per section.

## The interesting part: the `<canvas>`

UploadThing paints its entire hero illustration — floating `.MP4`/`.PNG`/`.PDF` chips over a browser mockup — on a `<canvas>`. Canvas is JS-painted pixels, so there is no DOM to copy and a naive clone renders an empty box where the hero should be.

`scripts/extract/canvas.mjs` closes that gap: it inventories every canvas, hashes four frames to decide static vs animated, then records the animated ones through `canvas.captureStream()` + `MediaRecorder` and emits a looping `.webm` plus a poster frame, along with the exact JSX to paste in.

Getting there took three tries, and each failure is now a comment in the script:
1. Playwright's `recordVideo` starts when the browser context opens, so every recording led with seconds of page-load chrome before the artwork.
2. Sizing the recording viewport to the canvas (700×700) put the site into its mobile layout — where the hero canvas is `display:none`, so the capture was of ordinary page content.
3. Seeking a video to `t=0` for a deterministic QA screenshot lands on a blank first frame.

## What this run taught the template

Every item below became a committed fix:

| Finding | Fix |
|---|---|
| Hero canvas was unclonable — an empty box in the clone | `canvas.mjs`: animated canvases become looping `.webm`, static ones become PNG |
| Extraction saw `animation: slide-up-fade 1s` but never what the animation *did* | `tokens.mjs` now captures `@keyframes` bodies + an animations-in-use census |
| Hover states were guessed by triggering one element at a time | `css.mjs` scrapes the real stylesheets — every `:hover`/`:focus`/`:active` rule, the real `@media` breakpoints, and per-element matched rules via CDP |
| The dashboard screenshot lives inside an inline `<svg><image>` and was never downloaded | `assets.mjs` now scans SVG rasters too |
| Section detection returned 1 usable section out of 8 on this class-only React DOM | 4 separate fixes in `responsive.mjs` — verified selectors, PC-first detection, height-aware collection rule, descent floor |
| A shared-browser refactor removed `launchPage` and broke 5 scripts | compat shim in `lib.mjs` |

## Where the target's stack matters

Scraping the CSS of a **Tailwind**-built site returns hover rules that *are* the class names a builder needs (`.hover\:scale-105:hover`). The same scrape against a **Framer**-built site returns 22 rules of `var(--framer-link-hover-…)` indirection. Target stack materially affects clone fidelity — prefer Tailwind/hand-written targets.

## Honest limits

- Full-page pixel scores are dominated by cumulative vertical offset. Trust the per-section numbers.
- The canvas is reproduced as video, so it is visually faithful but not interactive.
- Framework logo strips were rendered as neutral placeholder marks rather than reproducing each brand mark.

## Reproducing

```bash
npm install && npx playwright install chromium
claude --chrome
/clone-website https://uploadthing.com
```
