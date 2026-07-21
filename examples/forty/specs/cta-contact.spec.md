---
component: CtaSection + ContactSection
target: src/components/CtaSection.tsx
page: /
screenshot: docs/design-references/html5up.net/home-pc.png
interaction_model: static
states: default, input-focus, button-hover
assets: none (inline SVG icons)
responsive: phone, ipad, pc
---

# CtaSection + ContactSection Specification

Two adjacent sections, both plain-background content blocks on the dark page.

## DOM Structure
`section#two` > `div.inner` > `h2` + `p` + `ul.actions` > `a.button`.
`section#contact` > `div.inner` (2-column split) > left: contact `form`; right: `section.split` with 3 icon+text blocks.

## Computed Styles

### section#two > div.inner
- maxWidth: 1213.33px, margin: 0 auto, padding: 74.6667px 0px 37.3333px

### h2 ("Massa libero")
- fontSize: 32.6667px, fontWeight: 600, letterSpacing: 0.466667px, color: rgb(255,255,255)
- **`::after` underline:** content: "", display: block, width: 100%, height: 2px, backgroundColor: rgb(255,255,255), margin: 10.6167px 0px 16.3333px
  (the `.heading-rule` utility in globals.css does exactly this)

### section#two p
- fontSize: 18.6667px, fontWeight: 300, lineHeight: 1.65, color: rgb(255,255,255), marginBottom: 32px

### a.button (Get Started)
- Same as the banner button: padding 0 22.4px, height 52.2656px, border 2px solid rgba(255,255,255,0.2)
- fontSize: 14.9333px, fontWeight: 600, letterSpacing: 4.66667px, uppercase, inline arrow SVG on the right
- **hover:** border + text → rgb(155, 241, 255)

### section#contact > div.inner
- maxWidth: 1213.33px, margin: 0 auto, display: flex, gap: 0
- borderTop: 1px solid rgba(244,244,255,0.2)
- Left column (form) ~58%, right column (details) ~42% with a 1px left border rgba(244,244,255,0.2) and paddingLeft ~48px

### Form fields
- Name + Email side by side (each ~50% with a ~24px gap), Message full-width textarea (height ~150px)
- input/textarea: backgroundColor: rgba(212,212,255,0.035), border: 1px solid rgba(244,244,255,0.2), borderRadius: 0
- color: rgb(255,255,255), padding: 0 16px, height: 48px, fontSize: 16px
- **focus:** borderColor → rgb(155, 241, 255)
- Field labels above inputs: `.label-caps` (13.0667px, 600, letterSpacing 3.26667px, uppercase)

### Form buttons
- "Send Message": backgroundColor rgb(255,255,255), color rgb(36,41,67), height 48px, padding 0 22.4px
- "Clear": transparent with 2px solid rgba(255,255,255,0.2) border, white text
- Both: fontSize 14.9333px, fontWeight 600, letterSpacing 4.66667px, uppercase; gap ~13px

### Contact detail blocks (right column)
- 3 blocks (Email, Phone, Address), each: circular icon (40px, 1px border rgba(244,244,255,0.2), inline SVG ~16px) + `h3` (fontSize 18.6667px, fontWeight 600) + value text
- Separated by borderTop: 1px solid rgba(244,244,255,0.2), padding ~32px 0
- Links: color rgb(255,255,255), borderBottom: 1px dotted; hover → rgb(155,241,255)

## States & Behaviors
### Input focus
- **Trigger:** focus on input/textarea
- **State A:** borderColor rgba(244,244,255,0.2)
- **State B:** borderColor rgb(155,241,255)
- **Transition:** border-color 0.2s ease-in-out
- **Implementation:** Tailwind `focus:` classes

### Button hover
- Same as the banner button: colors → rgb(155,241,255), transition 0.2s ease-in-out

## Per-State Content
N/A — static content; form is non-submitting (mock, `onSubmit` prevented).

## Assets
Inline SVG icons: envelope, phone, home. Add to `src/components/icons.tsx`.
Content from `src/data/home.ts` (`cta`, `contact`).

## Text Content
- h2: "Massa libero"
- p: "Nullam et orci eu lorem consequat tincidunt vivamus et sagittis libero. Mauris aliquet magna magna sed nunc rhoncus pharetra. Pellentesque condimentum sem. In efficitur ligula tate urna. Maecenas laoreet massa vel lacinia pellentesque lorem ipsum dolor. Nullam et orci eu lorem consequat tincidunt. Vivamus et sagittis libero. Mauris aliquet magna magna sed nunc rhoncus amet pharetra et feugiat tempus."
- Form labels: "Name", "Email", "Message"; buttons "Send Message", "Clear"
- Email: information@untitled.tld · Phone: (000) 000-0000 x12387
- Address: "1234 Somewhere Road #5432 / Nashville, TN 00000 / United States of America"

## Responsive Behavior
- **PC (1440px):** contact is 2 columns (form left, details right with left border)
- **iPad (768px):** still 2 columns, narrower gap
- **Phone (390px):** 1 column — form on top, details below (left border becomes a top border); Name/Email stack
- **Breakpoint:** single column at ~980px; form fields stack at ~736px
