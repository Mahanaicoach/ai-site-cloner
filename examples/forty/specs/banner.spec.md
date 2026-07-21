---
component: Banner
target: src/components/Banner.tsx
page: /
screenshot: docs/design-references/html5up.net/home-pc.png
interaction_model: static
states: default, button-hover
assets: public/images/banner.jpg
responsive: phone, ipad, pc
---

# Banner Specification

## DOM Structure
`section#banner.major` (bg image, full-bleed) > `div.inner` (max-width container) > `header.major` > `h1`, then `div.content` > `p` + `ul.actions` > `li` > `a.button`

## Computed Styles

### section#banner
- height: 675px (desktop), display: flex, alignItems: center, position: relative
- backgroundImage: url(/images/banner.jpg), backgroundSize: cover, backgroundPosition: center
- **`::after` overlay (CRITICAL — without it the hero is far too bright):**
  content: "", position: absolute, inset: 0, backgroundColor: rgb(36, 41, 67), opacity: 0.85, zIndex: 1

### div.inner
- maxWidth: 1213.33px, width: 100%, margin: 0 auto, position: relative, zIndex: 2
- padding: 0 with the container centered; content is left-aligned

### h1
- fontSize: 60.6667px, fontWeight: 600, lineHeight: 100.1px, letterSpacing: 0.466667px, color: rgb(255, 255, 255)
- **`::after` underline:** content: "", display: block, width: 100%, height: 2px, backgroundColor: rgb(255,255,255), margin: 19.7167px 0px 30.3333px

### div.content
- display: flex, alignItems: center, gap between text and button

### p
- fontSize: 13.0667px, fontWeight: 600, letterSpacing: 3.26667px, textTransform: uppercase, lineHeight: 1.65, maxWidth: ~473px
- Use the `.label-caps` utility already in globals.css

### a.button (Get Started)
- display: inline-block, padding: 0 22.4px, height: 52.2656px, lineHeight: 52.2656px
- border: 2px solid rgba(255,255,255,0.2), color: rgb(255,255,255), backgroundColor: transparent
- fontSize: 14.9333px, fontWeight: 600, letterSpacing: 4.66667px, textTransform: uppercase
- paddingRight: 58px to leave room for the arrow
- **`::before` arrow icon:** an inline SVG right-arrow (36x24) positioned absolute right: 22.4px, white strokes, transition: opacity 0.2s ease-in-out
- **hover:** border/text color → rgb(155, 241, 255), arrow swaps to the cyan variant

## States & Behaviors
### Button hover
- **Trigger:** hover on `a.button`
- **State A:** color rgb(255,255,255), borderColor rgba(255,255,255,0.2)
- **State B:** color rgb(155,241,255), borderColor rgb(155,241,255)
- **Transition:** color/border 0.2s ease-in-out
- **Implementation:** Tailwind `hover:` classes + a CSS transition

## Per-State Content
N/A — single static state.

## Assets
- Background: `public/images/banner.jpg`
- Arrow icon: inline SVG in the component (stroke: currentColor so hover recolors it)

## Text Content
- h1: "Hi, my name is Forty"
- p: "A responsive site template designed by HTML5 UP and released under the Creative Commons."
- button: "Get Started"

## Responsive Behavior
Measured values (responsive.json + per-viewport probe) — the target scales with root font-size,
so every number changes even where the layout looks identical:
- **PC (1440px):** h1 60.6667px, label 13.0667px, section height 675px, padding-top 112px, inner max-width 1213.33px, flex-direction row
- **iPad (768px):** h1 52px, label 11.2px, section height 768px, padding-top 96px, inner width 672px, still row
- **Phone (390px):** h1 32px, label 11.2px, section height 444px, padding-top 128px, inner width 342px (24px gutters), still row (does NOT stack)
- **Breakpoints:** values step at 1280px and 736px
