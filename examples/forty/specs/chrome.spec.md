---
component: SiteHeader + SiteFooter
target: src/components/SiteHeader.tsx
page: /
screenshot: docs/design-references/html5up.net/home-pc.png
interaction_model: click-driven
states: default, menu-open
assets: none (icons are inline SVG)
responsive: phone, ipad, pc
---

# SiteHeader + SiteFooter Specification

Shared chrome — used by every page. Two components, one spec (they're small and both are site-wide).

## DOM Structure
`header#header` > `a.logo` (strong "Forty" + span "by HTML5 UP") + `nav` > `a` ("Menu").
`nav#menu` is a full-screen overlay panel, hidden until the Menu button is clicked.
`footer#footer` > `div.inner` > `ul.icons` (5 social links) + `p.copyright`.

## Computed Styles

### header#header
- height: 61px desktop / 44px phone, position: absolute (top of page, over the banner), zIndex: 10
- width: 100%, display: flex, alignItems: center, justifyContent: space-between
- paddingLeft/Right: 37.3333px desktop, 32px phone
- backgroundColor: transparent

### a.logo
- fontSize: 14.9333px, fontWeight: 600, letterSpacing: 4.66667px, textTransform: uppercase, color: rgb(255,255,255)
- `strong` (the word "Forty"): backgroundColor: rgb(255,255,255), color: rgb(36,41,67), padding: 0px 1.86667px 0px 5.6px, marginRight: 4.85333px

### nav a ("Menu")
- fontSize: 14.9333px, fontWeight: 600, letterSpacing: 4.66667px, textTransform: uppercase, color: rgb(255,255,255)
- Followed by a hamburger icon: 3 stacked 2px white bars, ~24px wide, gap ~5px, marginLeft ~13px

### nav#menu (overlay panel)
- position: fixed, top: 0, right: 0, height: 100vh, width: 350px (100% on phone), zIndex: 50
- backgroundColor: rgba(36, 41, 67, 0.9) with a backdrop blur feel; padding: 48px 37.3333px
- Menu links: fontSize: 18.6667px, borderBottom: 1px solid rgba(244,244,255,0.2), padding: 12px 0
- A "Close" X button top-right of the panel

### footer#footer
- padding: 74.6667px 0 37.3333px, backgroundColor: transparent
- `div.inner`: maxWidth: 1213.33px, margin: 0 auto
- borderTop: 1px solid rgba(244,244,255,0.2) above the footer content

### ul.icons li a (social)
- Circular: width/height 40px, borderRadius: 9999px, border: 1px solid rgba(244,244,255,0.2)
- display: inline-flex, alignItems/justifyContent: center, icon fontSize/size ~16px, color: rgb(255,255,255)
- gap between icons: ~13px
- **hover:** borderColor and icon color → rgb(155, 241, 255)

### p.copyright
- fontSize: 14.9333px, letterSpacing: 0.466667px, color: rgba(255,255,255,0.5), marginTop: 32px

## States & Behaviors
### Menu open/close
- **Trigger:** click on the "Menu" button opens `nav#menu`; click the X or the backdrop closes it
- **State A (closed):** panel translated off-screen right (transform: translateX(100%)), not focusable
- **State B (open):** transform: translateX(0), page content behind gets a slight dim
- **Transition:** transform 0.5s ease
- **Implementation:** `"use client"` component with a `useState` boolean; Escape key also closes

### Social icon hover
- **<a>:** color rgb(255,255,255) → rgb(155,241,255), borderColor likewise, transition 0.2s ease-in-out

## Per-State Content
Menu links (all states identical): Home /, Landing /landing, Generic /generic, Elements /elements

## Assets
Inline SVG icons only — hamburger, X, and 5 social glyphs (Twitter, Facebook, Instagram, GitHub, LinkedIn).
Add them to `src/components/icons.tsx`. Content comes from `src/data/home.ts` (`nav`, `footer`).

## Text Content
- Logo: "Forty" + "by HTML5 UP"
- Menu button: "Menu"
- Copyright: "© Untitled. Design: HTML5 UP. Demo Images: Unsplash."

## Responsive Behavior
Measured — root font-size steps (14pt above 1280px, 12pt below), so heights and gutters all change:
- **PC (1440px):** header 61px tall, logo padding-left 22.4px, hamburger inset 30px, footer padding-top 74.6667px, inner gutter 113px, menu panel 350px wide
- **iPad (768px):** header 52px tall, logo padding-left 19.2px, hamburger inset 26px, footer padding-top 64px, inner gutter 48px, panel 350px wide
- **Phone (390px):** header 44px tall, logo padding-left 12.8px, hamburger inset 14px, footer padding-top 48px, inner gutter 24px, panel 100% wide; "by HTML5 UP" and the "Menu" label are hidden
- **Breakpoints:** 1280px (font step) and 736px (panel full-width, labels hidden)
