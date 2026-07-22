# Handoff: TheraChart — Logo, Buttons, Nav Icons & Sidebar

## Overview
This package delivers a visual refresh for **TheraChart**, a clinic EMR for physical
therapists and the wider medical community (data organization, AI-assisted dictation
logging, and highlighting/scanning of prior patient history). It covers four things:
the app **logo + icon**, the **button system** (CTAs), the **sidebar navigation icons**,
and a **full sidebar** layout. The direction is a *lighter, cleaner clinical* look while
retaining the brand's teal DNA.

The user's selected/locked choices are:
- **Logo:** "Vertebrae" mark — spine segments as a stacked data column (option `1b`).
- **Buttons:** the full button system (option `1d`).
- **Dashboard nav icon:** "Overview panel" — framed board with trend read (from `2a`).
- **Facility Admin nav icon:** "Access control" — padlock (from `3a`).

## About the Design Files
The file in this bundle (`TheraChart Branding.dc.html`) is a **design reference created
in HTML** — a prototype showing intended look and behavior, **not production code to copy
directly**. The task is to **recreate these designs in TheraChart's existing codebase**
using its established framework, component library, and conventions (React/Vue/etc.). If no
component environment exists yet, choose the most appropriate framework for the project and
implement there. All SVG icon paths below can be lifted verbatim into your icon components.

The HTML is authored as a "Design Component" and is organized as anchored option cards
(ids like `1b`, `2a`, `3a`). Ignore the card scaffolding/chrome — only the marks, buttons,
and sidebar inside each card are the deliverable.

## Fidelity
**High-fidelity (hifi).** Final colors, typography, spacing, radii, and states are all
specified. Recreate pixel-accurately using your codebase's libraries. Fonts used are
**Sora** (logo/wordmark + display) and **Figtree** (UI text) — both Google Fonts; swap for
your app's equivalents if you already have a type system.

---

## Design Tokens

### Colors
| Token | Hex | Use |
|---|---|---|
| Brand teal (primary) | `#0F8A80` | Primary buttons, active rail indicator, accent word "Chart" |
| Brand teal hover | `#0B6B63` | Primary button hover |
| Deep teal | `#0B4F4A` | Logo tile bg (1b), strong text on light |
| Ink | `#122B29` | Primary text |
| Slate text | `#4E6663` | Nav rest label, secondary text |
| Muted | `#7B928F` / `#8FA6A3` | Section labels, captions, placeholders |
| Icon gradient | `linear-gradient(135deg,#14B8A6,#0E7490)` | Active nav icon chip, AI/app-icon |
| Surface | `#FAFCFB` | Sidebar background |
| Surface alt | `#F4F8F7` / `#EEF4F3` / `#F1F6F5` | Icon chip rest bg, hover row |
| Soft teal fill | `#E6F5F2` | Secondary button bg, badge bg |
| Border | `#E4ECEA` | Sidebar/card borders |
| Border strong | `#C9DAD7` | Secondary button outline |
| AI cyan (outline) | `#A5DCE4` border, `#0E7490` text | Dictate/AI outline button |
| Spine light→dark | `#5EEAD4` / `#2DD4BF` / `#14B8A6` / `#0D9488` | Logo 1b segments (top→bottom) |
| Destructive soft | bg `#FBEDEB`, text `#B3382E` | Soft destructive button |
| Destructive solid | bg `#C2453A`, hover `#A93A30`, text `#fff` | Delete button |
| Badge (count) | bg `#E6F5F2`, text `#0B6B63` | e.g. "24" patients pill |

### Typography
- **Sora** — logo wordmark & display. Weights 500/600/700. Wordmark: 600, 24px, `letter-spacing:-0.02em`. Sidebar wordmark: 700, 17px, `-0.01em`.
- **Figtree** — all UI. Body/nav 14–14.5px. Buttons 14.5px/600. Section labels 10px/700, `letter-spacing:0.16em`, uppercase, muted. Sub-label under logo: 9.5–11px/600, `letter-spacing:0.2–0.22em`, uppercase.

### Spacing / radii / shadows
- Radii: icon chip `11px`, nav row `9px`, buttons `10px` (small `8px`), pill buttons `999px`, logo tile `14px`, cards `10–12px`, avatar `99px`.
- Nav row padding: `10px 12px`; icon→label gap `12px`.
- Primary button: `padding:11px 20px`; shadow `0 1px 2px rgba(11,79,74,.25), inset 0 1px 0 rgba(255,255,255,.14)`.
- Active nav icon chip shadow: `0 3px 8px rgba(14,116,144,.3)`.
- Card/surface shadow: `0 1px 2px rgba(18,43,41,.06)`.
- Transitions: `.15s` on button bg/border/color.

---

## Components

### Logo — "Vertebrae" (locked, `1b`)
Rounded-square tile, `border-radius:14px`, fill `#0B4F4A`. Four horizontally-centered
rounded bars stacked top→bottom, tapering in width and darkening in teal — reads as a spine
/ a data column. On a 56×56 viewBox:
```html
<svg viewBox="0 0 56 56">
  <rect width="56" height="56" rx="14" fill="#0B4F4A"/>
  <rect x="20" y="10" width="16" height="7" rx="3.5" fill="#5EEAD4"/>
  <rect x="17" y="20" width="22" height="7" rx="3.5" fill="#2DD4BF"/>
  <rect x="20" y="30" width="16" height="7" rx="3.5" fill="#14B8A6"/>
  <rect x="23" y="40" width="10" height="7" rx="3.5" fill="#0D9488"/>
</svg>
```
Wordmark beside it: "TheraChart" in Sora 600; sub-label "CLINIC EMR" muted, tracked, uppercase.
The mark is legible down to 24px; at small app-icon sizes widen the bars slightly and use
`rx:16`. For a monochrome/dark surface, keep the tile teal and render bars in the teal ramp.

### Button system (locked, `1d`)
All buttons Figtree 600, radius 10px (pills 999px), transition `.15s`.
- **Primary:** text `#fff`, bg `#0F8A80`, hover `#0B6B63`, shadow as token above. Sizes: default `11px 20px / 14.5px`; small `8px 14px / 13px`, radius 8px. Icon variant: leading 15px stroke-2.4 icon, gap 8px.
- **Disabled:** text `#8FA6A3`, bg `#E4ECEA`, `cursor:not-allowed`, no shadow.
- **Secondary (outline):** text `#0B4F4A`, bg `#fff`, `1.5px solid #C9DAD7`; hover border+text → `#0F8A80`.
- **Secondary (soft):** text `#0F8A80`, bg `#E6F5F2`, hover bg `#D3EEE8`.
- **Ghost:** text `#4E6663`, transparent; hover bg `#EEF4F3`, text `#0B4F4A`.
- **Icon button:** 40×40, `1.5px solid #C9DAD7`, radius 10px; hover border+icon `#0F8A80`.
- **AI action (primary):** pill, text `#fff`, bg `linear-gradient(120deg,#0F8A80,#0E7490)`, shadow `0 2px 10px rgba(14,116,144,.28)` → hover `0 3px 14px rgba(14,116,144,.4)`; leading sparkle icon. (Used for "Summarize History".)
- **AI action (outline):** pill, text `#0E7490`, bg `#fff`, `1.5px solid #A5DCE4`, hover bg `#F0FAFB`; leading mic icon. (Used for "Dictate Note".)
- **Destructive soft:** text `#B3382E`, bg `#FBEDEB`, hover `#F6DBD7`.
- **Destructive solid:** text `#fff`, bg `#C2453A`, hover `#A93A30`.

### Nav icons (all 24×24 viewBox, stroke = currentColor, round caps/joins)
Rest state: icon color `#4E6663` (in a `44×44` chip, bg `#EEF4F3`, radius 11px — or inline at 17–18px in the sidebar). Active state: white icon in gradient chip (`linear-gradient(135deg,#14B8A6,#0E7490)`, shadow `0 3px 8px rgba(14,116,144,.3)`).

- **Dashboard — "Overview panel" (locked):** stroke-width 1.9
  ```
  <rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18"/><path d="M7 14l2.5 2.5L12 13l2 2 3-4"/>
  ```
- **Facility Admin — "Access control" padlock (locked):** stroke-width 1.8
  ```
  <rect x="4" y="8" width="16" height="13" rx="2"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/><circle cx="12" cy="14" r="1.6"/><path d="M12 15.6V18"/>
  ```
- **Patients:** `<path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>` (stroke 2)
- **Calendar:** `<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>` (stroke 2)
- **Privacy & Security:** shield+check `<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z"/><path d="m9 12 2 2 4-4"/>` (stroke 2)

---

## Screen: Sidebar (full)
Vertical flex column, fixed width **276px**, `100%` height, bg `#FAFCFB`, right border `1px #E4ECEA`.
Top → bottom:
1. **Brand row** — `padding:20px 18px 16px`, gap 11px: 38px Vertebrae logo tile + wordmark stack ("TheraChart" Sora 700 17px; "CLINIC EMR" 9.5px muted tracked).
2. *(optional)* **Search field** — `#fff` bg, `1px #E4ECEA`, radius 10px, search icon + "Search patients…" placeholder + `⌘K` chip.
3. **Section "CLINIC"** (label style above) → nav rows: **Dashboard** (active), **Patients** (with count pill "24"), **Calendar**.
4. **Section "ACCOUNT"** → **Privacy & Security**, **Facility Admin**.
5. *(optional)* **AI card** — pinned near bottom (`margin-top:auto`): soft teal gradient card with sparkle, short highlight message ("AI found 3 highlights in recent charts") and a Review button.
6. **User row** — top border, 36px gradient avatar ("DR"), name "Dr. Dana Reyes" 13.5px/600, role "Lead PT · Northside" 11.5px muted.

### Nav row (rest)
Flex, `align-items:center`, gap 12px, `padding:10px 12px`, radius 9px, label Figtree 500 14px `#4E6663`, 17–18px icon. Hover: bg `#F1F6F5`, text `#122B29`.

### Nav row (active) — "rail indicator" treatment
Same row, but: bg `#fff`, shadow `0 1px 2px rgba(18,43,41,.06)`, label 600 `#0B4F4A`, and a left **rail**: absolutely-positioned bar `left:0; top:9px; bottom:9px; width:3.5px; border-radius:99px; background:#0F8A80`. The icon is nudged right (`margin-left:6px`) to clear the rail. (An alternate "soft pill" active style — bg `#E6F5F2`, text `#0B6B63`, no rail — is also in the file as `1e`-A if preferred.)

There is also a **dark** sidebar variant (`1g`) that keeps the original teal-gradient background if the team wants to retain dark mode; same structure, colors inverted (labels `#9DB8B4`, active `#5EEAD4` on `rgba(94,234,212,.1)`).

---

## Interactions & Behavior
- Nav rows: hover transitions (`.15s`), active row shows rail + white surface. Clicking routes to the corresponding view; only one active at a time.
- Buttons: hover per states above; disabled non-interactive. AI buttons deepen their shadow on hover.
- "Summarize History" → triggers AI summarization of the patient's prior history/scan; "Dictate Note" → starts voice dictation logging. Wire to your existing AI/dictation services.
- Count pill ("24") reflects live patient count.

## State Management
- `activeNav` — current route/section (drives active styling).
- Patient count for the badge.
- AI highlight count for the sidebar AI card ("3 highlights") — from your history-scan service.
- User identity (name/role/initials) for the footer row.

## Assets
No raster assets — everything is inline SVG (copyable above) + two Google Fonts (Sora, Figtree). No third-party brand assets are used; all marks are original.

## Files
- `TheraChart Branding.dc.html` — the full design reference. Relevant anchors: logo `1b`, buttons `1d`, nav icon sets `2a`/`2b`/`3a`, full sidebars `1f` (light) & `1g` (dark), in-context sidebar with the locked icons `2c`.
