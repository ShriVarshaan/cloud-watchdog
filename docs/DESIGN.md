# Design (M13)

Cloud Watchdog should feel like a first-party Apple utility (System Settings,
Activity Monitor, Weather) while running on Windows 10 and 11. This file is the
spec the renderer follows. It was written from the `hig-*` skills and
`frontend-design`, which are listed in `docs/SKILLS.md`.

The look is built from Apple's published guidelines only. No Apple artwork,
logos, SF Pro or SF Symbols are copied into the app (PLAN.md open questions 13
and 14).

## What the app is for, and so what the design does

One person checking whether a forgotten AWS resource is about to eat their
credits. They glance at it from the tray many times and open the main window
rarely. So:

- **The runway is the hero.** "How long do my credits last" is the one number
  the app exists for. It gets the only bold visual: a ring gauge with a large
  numeral. Everything else stays quiet (`frontend-design`: spend boldness in one
  place).
- **Content before chrome** (`hig-foundations`, key principle 1). Hairline
  separators and grouped boxes instead of borders on everything. No decorative
  gradients, no coloured section headers.
- **Words carry meaning, colour repeats it.** Unchanged from M9: every badge
  says its word, and an unknown price never shows a number.

## HIG rules applied, and where

| Rule (skill, reference) | Where it applies |
|---|---|
| Translucent materials belong to window chrome, never the content layer (`hig-foundations`, materials.md) | Only the sidebar is translucent (Mica). Lists, the inspector and the summary are opaque. |
| Sidebar for top-level navigation on the desktop; don't put critical information at the bottom; don't colour every sidebar icon (`hig-components-layout`, sidebars.md) | Resources, Scan Problems and Settings move from a tab strip to a sidebar. The account is shown at the top. Icons use the label colour; the selected row uses the accent. |
| Hide the sidebar when the window gets narrow (sidebars.md) | Below 900px the sidebar collapses to icons; the names stay as accessible names. |
| Alternating row colours in a multicolumn table (`hig-components-layout`, lists-and-tables.md) | The resource table. |
| Switches in grouped-form rows; checkboxes for a hierarchy of settings (`hig-components-controls`, toggles.md) | Notifications and start-at-login are switches. Rules, which have sub-settings, stay checkboxes. |
| Outside a list, use a button that behaves like a toggle, not a switch; a segmented control for closely related choices, labelled with nouns (toggles.md, segmented-controls.md) | "Only with warnings" becomes a segmented control: All / With Warnings. |
| A tab view, not a segmented control, for switching views (segmented-controls.md) | The sidebar keeps tab semantics (`role="tablist"`, vertical). |
| A push button that opens another window ends with an ellipsis (`hig-components-menus`, buttons.md) | "Switch On Stopping…", "Stop Instance…", "Open in AWS Console…": each opens a native dialog or the browser. |
| Never give a destructive action the default (primary) style (buttons.md) | The Stop button is red text on a neutral fill, not the blue default button. |
| Title-style capitalisation for buttons, tabs and sidebar items on macOS (`hig-foundations`, writing.md) | Buttons and navigation labels. Body text stays sentence case. |
| Gauges: change the fill colour across significant parts of the range; labels describe the current value (`hig-components-controls`, gauges.md) | The runway ring: green, then orange under 14 days, red under 7, with the days as text. |
| Motion communicates, and has a Reduce Motion alternative (`hig-foundations`, motion.md) | Inspector and preview fade and rise; with reduced motion they only fade. Nothing moves on its own. |
| Increase Contrast support (`hig-foundations`, accessibility.md) | `prefers-contrast: more` darkens secondary text and separators; Windows high contrast (`forced-colors`) drops translucency and tints and uses system colours. |

## Tokens

All colours are CSS custom properties in `src/renderer/styles.css`. The values
are Apple's system colours, picked from the accessible variants where the plain
ones fail WCAG for small text.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f5f5f7` | `#1c1c1e` | Window content background |
| `--surface` | `#ffffff` | `#2c2c2e` | Grouped boxes, table, inspector |
| `--label` | `#1d1d1f` | `#f5f5f7` | Primary text |
| `--secondary` | `#6e6e73` | `#a1a1a6` | Secondary text (4.6:1 or better on every surface) |
| `--separator` | `rgba(60,60,67,.18)` | `rgba(235,235,245,.14)` | Hairlines |
| `--fill` | `rgba(120,120,128,.12)` | `rgba(120,120,128,.26)` | Control and badge fills |
| `--accent` | `#0071e3` | `#0071e3` | Filled default button (white text 4.6:1) |
| `--accent-text` | `#0066cc` | `#409cff` | Links, selection, focus ring |
| `--green` | `#248a3d` | `#30d158` | OK / covered |
| `--orange` | `#b25000` | `#ff9f0a` | Warning / estimate |
| `--red` | `#d70015` | `#ff453a` | Critical / destructive |

Type: **Inter** (variable, optical sizes), bundled. Apple's SF Pro cannot be
shipped on Windows, and Inter is the closest open font. Sizes follow the macOS
text styles:

| Style | Size / weight | Use |
|---|---|---|
| Large title | 26 / 700, tracking −0.022em | Section title |
| Hero numeral | 34 / 600, tabular figures | Runway, burn rate |
| Title 3 | 15 / 600 | Inspector title |
| Headline | 13 / 600 | Group headings |
| Body | 13 / 400, line height 18px | Everything else |
| Caption | 11 / 400 | Notes, secondary rows |

Spacing is a 4px scale (4, 8, 12, 16, 20, 24, 32). Radii: 6 for controls, 10
for grouped boxes, 14 for the popover. Shadows are two soft layers, used only
for things that float (the inspector on narrow windows, the segmented control's
thumb). One easing curve, `cubic-bezier(0.32, 0.72, 0, 1)`, at 120, 200 and
320ms.

Icons: **Lucide** (ISC licence), stroke 1.75, 16px, which sits closest to SF
Symbols at regular weight. Every icon is decorative (`aria-hidden`) and sits
next to a word.

## Layout

```
Main window
┌ sidebar (Mica) ─┬ toolbar (drag region) ─────────────────── [– □ ×]
│ Cloud Watchdog  │ Resources          Scanned just now  [⟳ Scan Now]
│ Account 1111…   ├──────────────────────────────────────────────────
│                 │ ┌ runway ring + days │ running now │ plan ┐
│ ▣ Resources   7 │ └───────────────────────────────────────┘
│ ⚠ Scan Problems │ banners
│ ⚙ Settings      │ [🔍 search] [kind ▾] [All | With Warnings]
│                 │ ┌ table ────────────────────┐ ┌ inspector ┐
│                 │ │ zebra rows, hairlines     │ │ grouped   │
└─────────────────┴─┴───────────────────────────┴─┴───────────┴

Popover (360 × 480)
┌──────────────────────────────┐
│ Cloud Watchdog  Scanned 2m   │
│        ╭───────╮             │
│        │ 5 days│  ring hero  │
│        ╰───────╯             │
│  Running now $0.66/h · Plan  │
│ ┌ Warnings (grouped list) ┐  │
│ └─────────────────────────┘  │
│ [        Scan Now         ]  │
└──────────────────────────────┘
```

Text is left aligned everywhere except the popover hero, which is centred.

## Windows specifics

- The main window hides the Windows title bar (`titleBarStyle: 'hidden'`) and
  keeps the native minimise, maximise and close buttons as an overlay whose
  colours follow light and dark mode. The toolbar is the drag region.
- On Windows 11 (build 22621 or later) the window uses the Mica material and
  the sidebar is transparent over it. On Windows 10 the sidebar is a solid
  grey. The main process tells the page which one through `?material=mica`.
- The popover stays an opaque, frameless window. Mica does not apply to
  frameless windows reliably, and a transparent window would be needed to draw
  rounded corners in CSS, so its corners are left to Windows.

## Deliberate deviations from the M13 plan

- **No collapsing large title.** macOS windows keep the title in the toolbar;
  the collapsing title is an iOS pattern. The section title sits in the toolbar.
- **The stop preview stays inside the inspector**, styled as an inset group,
  instead of a sheet. The native confirmation dialog in the main process is
  already the modal step, and a second modal on top of it would be noise.
- **Stopping stays a button, not a switch.** A switch implies the change
  happens the moment it flips; this one goes through a native confirmation
  naming the extra IAM policy, so it is a push button with an ellipsis.
