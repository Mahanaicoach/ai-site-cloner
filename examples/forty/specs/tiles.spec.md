---
component: Tiles
target: src/components/Tiles.tsx
page: /
screenshot: docs/design-references/html5up.net/home-pc.png
interaction_model: hover-driven
states: default, hover
assets: public/images/pic01.jpg … pic06.jpg
responsive: phone, ipad, pc
---

# Tiles Specification

## DOM Structure
`section#one.tiles` (display: flex, flexWrap: wrap, width: 100%) > 6 × `article`.
Each article: bg image + two overlay pseudo-elements + `header.major` (h3 + p) + a full-size absolute link.

## Computed Styles

### section#one
- display: flex, flexDirection: row, flexWrap: wrap, width: 100%

### article (each tile)
- position: relative, display: flex, alignItems: center, justifyContent: center
- height: 429.328px (desktop), backgroundImage per tile, backgroundSize: cover, backgroundPosition: center
- **Widths alternate**: 576px and 864px at 1440px viewport → flex-basis 40% and 60%
  Order: narrow(576), wide(864), wide(864), narrow(576), narrow(576), wide(864)
- **`::before` color overlay:** content: "", position: absolute, inset: 0, backgroundColor: per-tile color, opacity: 0.85, zIndex: 2, transition: opacity 0.5s
- **`::after` dark overlay:** content: "", position: absolute, inset: 0, backgroundColor: rgba(36, 41, 67, 0.25), zIndex: 1

### header.major (inside each tile)
- position: relative, zIndex: 3, textAlign: left

### h3
- fontSize: 32.6667px, fontWeight: 600, letterSpacing: 0.466667px, color: rgb(255,255,255)
- **`::after` underline:** content: "", display: block, width: 100%, height: 2px, backgroundColor: rgb(255,255,255), margin: 10.6167px 0px 16.3333px

### p
- fontSize: 13.0667px, fontWeight: 600, letterSpacing: 3.26667px, textTransform: uppercase (use `.label-caps`)

### a.link.primary
- position: absolute, inset: 0, width: 100%, height: 100%, zIndex: 4, text hidden (accessible label only)

## States & Behaviors
### Tile hover
- **Trigger:** hover anywhere on the article
- **State A:** h3/link color rgb(255, 255, 255)
- **State B:** h3/link color rgb(155, 241, 255); the `::before` color overlay fades (opacity 0.85 → ~0.35) revealing more of the photo
- **Transition:** color 0.2s ease-in-out, overlay opacity 0.5s ease
- **Implementation:** group-hover on the article wrapper

## Per-State Content
N/A — content is identical across states; only styling changes.

## Assets
Content comes from `src/data/home.ts` → `tiles` array (title, subtitle, image, color, href, span).
Images: public/images/pic01.jpg … pic06.jpg. Colors: #6fc3df, #8d82c4, #ec8d81, #e7b788, #8ea9e8, #87c5a4.

## Text Content
1. Aliquam / "Ipsum dolor sit amet"
2. Tempus / "feugiat amet tempus"
3. Magna / "Lorem etiam nullam"
4. Ipsum / "Nisl sed aliquam"
5. Consequat / "Ipsum dolor sit amet"
6. Etiam / "Feugiat amet tempus"

## Responsive Behavior
- **PC (1440px):** 2 tiles per row, alternating 40%/60% widths, height 429px
- **iPad (768px):** still 2 per row, equal 50/50 widths, height ~330px
- **Phone (390px):** 1 tile per row (100% width), heading 24px, height ~330px
- **Breakpoint:** 50/50 at ~980px; single column at ~736px
