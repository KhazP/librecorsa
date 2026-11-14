# LibreCorsa design: "Racing Line"

The visual language of every LibreCorsa screen: the site pages, title menu, Settings, pause menu, first-run setup,
Garage, results and the in-race HUD. The code that carries it: tokens and role classes in `src/app/globals.css`,
semantic colours in `src/app/palette.css`, and one set of parts in `src/components/ui/` (shown, every part, size and
state, on the development-only page `/kit`). `node scripts/check-ui.mjs` counts what a typecheck cannot see: a hex in
a class, a hand-typed glyph standing in for an icon, text under the size floor, a radius off the scale. When the code
and this file disagree, fix one of them; don't let a third look appear.

## 1. Principles

1. **The track is the hero.** UI floats on frosted glass over the live 3D scene. Menus dim and blur the scene, they never replace it with a flat page.
2. **One focus colour.** Acid volt `#CCFF00` means "you are here": the focused entry fills volt with void ink. Nothing else uses a volt fill except the primary button, the player's own row and the gear tile. What a setting is *on* is lit white, never volt (§6 "Chosen"), so on a busy panel the cursor is the one bright thing.
3. **Words are italic, numbers are mono.** Display text is Chakra Petch bold italic in capitals, UI text is Geist. Every number, label and key cap is Geist Mono with tabular figures.
4. **Every input, always.** Each screen works with a controller, the keyboard and the mouse, and shows the prompts for the input last used.
5. **Colour is never alone.** Every coloured state also carries a sign, a drawn arrow or a word (− / +, a `Trend` arrow, Hot, PB, +1 lap).
6. **Lists grow.** Any picker that holds content (cars, circuits, liveries, presets) is a browser: search, category filters with counts, sort, a scrolling grid with sticky group headers, favourites, recents and download state. Categories come from the data, never from hard-coded tabs.

## 2. Colour

Tokens are Tailwind theme colours (`bg-lc-volt`, `text-lc-slate`, `border-lc-line`; in CSS `var(--color-lc-*)`). No
hex or `rgb()` belongs in a component.

| Token | Hex | Use |
|---|---|---|
| `lc-volt` | `#CCFF00` | The cursor, the screen's one main action, the player (own row, own map dot, gear tile) |
| `lc-volt-hi` / `lc-volt-dim` | `#D9FF33` / `#99BF00` | Hovered and pressed volt |
| `lc-crimson` | `#FF2A3C` | Raw hue: soft compound, danger actions |
| `lc-cyan` | `#00E5FF` | Raw hue: GT3 class, wet compound and wet track, sector 1 |
| `lc-purple` | `#B845FF` | Raw hue: prototype class |
| `lc-green` | `#00E676` | Raw hue: intermediate compound |
| `lc-amber` | `#FFB300` | Raw hue: medium compound, road class |
| `lc-pink` | `#FF6B8A` | Raw hue: open-wheel class, sector 3 |
| `lc-azure`, `lc-tangerine`, `lc-copper` | `#4DA6FF`, `#FF8A1F`, `#D98162` | Colour-blind palettes only |
| `lc-crimson-hi`, `lc-purple-hi` | `#FC5D6C`, `#C772FE` | Text on a crimson or purple 12 % fill (soft and outline badges); `lc-best-ink` / `lc-loss-ink` follow the palette |
| `lc-well` | `#050608` | Inset wells inside a card (inputs, stat tiles) |
| `lc-void` | `#08090D` | Canvas, ink on volt |
| `lc-carbon` | `#11131A` | Panels, cards |
| `lc-titanium` | `#1B1F2B` | Raised controls, slider track, inactive switch |
| `lc-line` | `#262B3D` | Hairlines inside a sheet, the chosen fill |
| `lc-keyline` | `#3A4157` | Key caps, prompt outlines, hovered hairlines |
| `lc-dim` | `#5B6275` | Placeholders, disabled text, neutral chart lines |
| `lc-slate` | `#8E96AA` | Labels, secondary text |
| `lc-fog` | `#C5CBD8` | Body copy on dark sheets |
| `lc-chalk` | `#F5F7FA` | Primary text, the chosen state |

**Meaning has its own tokens** (`palette.css`), so a colour-blind palette moves every use at once. A colour that
says a state uses these, never the raw hue:

| Token | Standard | Means |
|---|---|---|
| `lc-gain` | green | Faster, personal best in a race, connected, success |
| `lc-loss` | crimson | Slower, invalid lap, error |
| `lc-best` | purple | Session or overall best (driving alone, a personal best is the session best) |
| `lc-caution` | amber | Warnings, yellow flag |
| `lc-info` | cyan | Information, ERS and aero, DRS open |
| `lc-cold` / `lc-ideal` / `lc-hot` | cyan / green / crimson | Tyre and brake temperatures |
| `--lc-sem-throttle` / `--lc-sem-brake` | green / crimson | Pedal traces |

`html[data-palette="protan" | "deutan"]` moves gain and loss to azure and tangerine, best to copper and the working
window to chalk; `tritan` moves caution, info and cold (best stays purple there, apart from info). Volt is never part of this: the cursor stays volt in every
palette. Raw hues stay only where the colour is identity, not state (a car class, a tyre compound, a flag, a
driver's own colour). Canvas, three.js and SVG built in code cannot read a CSS variable: they call
`tokenColor("gain")` (`src/components/ui/token-color.ts`) where they draw.

Signed-off identities: classes are open-wheel pink, GT3 cyan, prototype purple, road amber (no class wears volt);
compounds are soft crimson, medium amber, hard chalk, intermediate green, wet cyan; a wet track is cyan, never the
green of a personal best; the blue flag carries a diagonal chalk stripe.

## 3. Type

Loaded in `src/app/layout.tsx`, self-hosted through `next/font/local` (`src/app/fonts/`). A squared motorsport
face for display (Chakra Petch), a neutral grotesk for UI text (Geist), a mono for timing (Geist Mono). Sizes are
fixed px, one class per role:

| Role | Class | Spec |
|---|---|---|
| Screen title | `lc-h1` | Chakra Petch 700 italic caps, 44 px / 0.95 (phones 28) |
| Panel title | `lc-h2` | Same, 34 px / 1 (phones 24) |
| Card title | `lc-h3` | Same, 18 px / 1.1, chalk |
| Display, button and tab text | `lc-disp`, `lc-title` | Chakra Petch 700 italic caps; hero sizes, buttons, tabs, the gear |
| Row label | `lc-row-label` | Geist 600, 15 px / 1.25, chalk |
| Body | `lc-body` | Geist 400, 14 px / 1.45, fog (reading pages 16 px, about 68 characters a line) |
| Hint | `lc-hint` | Geist 400, 12 px / 1.4, slate |
| Field label | `lc-field-label` | Geist 500, 13 px, sentence case, fog. The name above a field |
| Label | `lc-lbl` | Geist Mono 600, 11 px, 0.16em, caps, slate. Table headers and inline meter names only, never a line above a field or block |
| Chip text | `lc-chip-text` | Geist Mono 800, 11 px, 0.08em, caps |
| Data | `lc-data`, `lc-mono` | Geist Mono with tabular figures: lap times, gaps, speeds, values |
| HUD label | `lc-hud-lbl` | Geist Mono 700, 9 px, 0.18em, caps, slate |

Floors: nothing under 11 px in a menu or on a page, nothing under 9 px in the HUD. Geist has no true italic, so
nothing set in Geist is italicised. Copy is sentence case; capitals come from the display classes, not from typed
capitals. The wordmark's letters are outlined paths (`src/components/ui/logo/geometry.ts`), not a font.

## 4. Shape

| Token | Radius | Use |
|---|---|---|
| `rounded-lc-sheet` | 28 px | A sheet over the scene |
| `rounded-lc-card` | 24 px | A card inside a sheet |
| `rounded-lc-tile` | 18 px | Choice tiles, picture tiles, HUD panels |
| `rounded-lc-row` | 14 px | Setting rows, wells, text fields |
| `rounded-lc-nub` | 10 px | Small tiles and thumbnails inside a panel |
| `rounded-full` | pill | Buttons, segmented controls, tabs, badges, key caps, switches |

Heights: button 52 / 44 / 36 (`lg` / `md` / `sm`), setting row 52, tab and segment 40 (36 small), badge 28 / 24 /
20 (16 in the HUD), key cap 22, switch 30. Anything a finger presses is at least 44 px, whatever its drawing.

Layers, lowest first (`--z-lc-*`): HUD, touch pads, toasts, overlays, menus, results, loading, notices.

## 5. Surfaces

- **Sheet** (`Sheet`, `.lc-glass`): `rgba(14,16,22,0.72)`, 1 px `white/7` border, `blur(22px)`, `shadow-lc-sheet`.
  One per screen region, over the live scene.
- **Card** (`Card`): carbon at 80 %, `white/7` border, no blur, no shadow. Content inside a sheet. Named by a plain
  heading (`title=`), never a dot plus tracked caps. Never a card inside a card: a group inside a card is a well.
- **Well** (`Well`): `lc-well` with an `lc-line` hairline. Inputs, stat tiles, read-outs.
- **HUD glass**: void at 74 %, `white/7` border, `blur(14px)`, `shadow-lc-pop`. One glass for every HUD panel.
- Over the scene use the `white/7` hairline; inside a sheet use `lc-line`.

## 6. Components (`src/components/ui/`)

One part per job; a screen does not draw its own button, chip, toggle, tab, slider, key cap, badge or icon.

- **Chosen and cursor.** What a setting is on is chalk text on `lc-line` with a white hairline (pills, segments,
  tabs) or a 1.5 px white edge with a check (tiles). The cursor is the volt fill on pills and the volt edge plus
  halo on tiles and rows, and wins over chosen. A main action that is already done ("Current car") is a neutral
  status with a check, not a dimmed volt button.
- **Button** / **IconButton**: `primary` (volt, one per view), `secondary`, `ghost`, `danger`; a key cap or pad
  glyph inside on the left; `loading` keeps the width; `disabledReason` keeps a blocked action reachable and says
  why. With `href` it is a link (`native` for files, mail and the game entry).
- **SettingRow**: label and one-line hint on the left, one control on the right, the whole row ringed by the
  cursor. A changed row shows a dot and can be reset (pointer or Tab: its reset button; in Settings and the Garage also Delete and pad X, named in the prompt bar while the cursor is on such a row).
  `advanced` rows hide in Simple (`SettingsDetailProvider`).
- **Toggle**, **Slider**, **Stepper**, **Segmented** (2 to 5 short options), **Select** (longer lists),
  **OptionTile** (choices that need a description or a picture), **TextField** (label above; `multiline`).
  A choice that is costly to apply uses tiles or a select, which commit once.
- **Tabs** (LB / RB or Q / E at the ends; `wrap` for many tabs in a narrow pane), **NavList** (a vertical category
  list), **Disclosure** (secondary detail, its title says what is inside or how much is on).
- **MediaTile**: the one picture tile for cars, circuits and liveries, on the site and in the game.
- **Badge** and its family (`src/components/ui/badges/`): `FlagBadge`, `CompoundBadge`, `ClassTag`,
  `PositionBadge`, `PlayerTag`, `PenaltyBadge`, `QualityBadge`, `SessionBadge`, `DeltaBadge`, `StateBadge`,
  `SurfaceBadge`, `StatusDot`. Tones are named by meaning (`good`, `bad`, `best`, `warn`, `info`, `neutral`,
  `player`) and follow the palette; a data colour is passed as `{ color }`. Default variant `soft`.
- **Icon** (`<Icon name>`): one drawing per concept, lucide where it has one, the project's own where racing needs
  it (`icons/custom/`). No direct `lucide-react` import in a screen, no Unicode glyph or emoji as an icon.
  `Trend` draws gain and loss arrows.
- **Prompts** (`src/components/ui/prompts/`): `KeyCap` (arrows are drawn), `PadGlyph` (monochrome; Xbox,
  PlayStation and generic families; system buttons are words), `PromptBar` at the foot of a screen, showing the
  glyphs of the input in use and fewer of them on phones.
- **Meter** (8 px track; `stacked` for long names), **Skeleton**, **EmptyState** (one sentence and the action that
  fills the list), **Toast** (`ToastRegion` inside the menu root it belongs to), **ConfirmDialog** (every
  destructive or session-restarting action asks; the safe choice has the focus. Its `info` tone explains instead,
  as the Install app steps do: an info icon, the acknowledgement as the primary button with the focus, the other
  choice ghost, and `onDismiss` for Esc, B and the backdrop when the other choice does more than close).
- **Logo** (`LibreCorsaLogo`, `public/branding/`): built from one geometry by `npm run brand`; on a light
  background the wordmark is one colour and the emblem carries the colour.

## 7. Focus and navigation

- One focus model for all inputs: the mouse focuses what it hovers (`focusOnHover`), arrows / d-pad move it, Enter / A activates. A control that slides under a resting pointer (a panel opening reflows the rail) does not take the focus; only real pointer movement does.
- Entering a panel or zone resumes where it was left, else starts on its `data-nav-default` (the loaded circuit's card, the Garage's car, the race's Circuit row), never a text field. A segmented row is entered on the option it is set to.
- Menu / Start is the screen's main action (Drive on the title screen, Start race on the race setup).
- Leaving a screen that replaces the menu (Controls, a circuit reload) comes back to the panel and entry it was opened from.
- Up / down moves between rows; left / right changes the focused row's value, at once. In Settings and the Garage, Delete / X puts the focused row back to its default (elsewhere they do nothing; Tab reaches a row's reset button everywhere). Y (key and pad) is a screen's one extra action (Settings: Simple / Advanced). A switch must always show what it did: a Simple page that hides settings ends with a line saying so and a Show advanced button, and a page with nothing more says that in a notice. Tab stays the browser's focus key.
- LB / RB (Q / E) switch tabs or categories. B / Esc goes back exactly one level, never more.
- Rows that hold an input ring the whole row: 2 px volt outline, 14 px radius, volt 6% tint.
- With a controller, the focused element also gets a 5 px volt halo and a soft glow (`html[data-input="pad"]`).
- The prompt bar always shows the glyphs of the input in use.

## 8. HUD

- Corner groups are anchored to their corner and scale about it (`anchor()`), so HUD size never pushes a group off-screen.
- With the touch controls up, every preset gives way to the Phone HUD at any screen size: the pads take both bottom corners and the top-left, where the other presets put their panels.
- Past 2.4:1 (a 32:9 screen) the HUD keeps to a centred 2.4:1 frame instead of the far edges. Anything the renderer places in window pixels (the virtual mirror's frame) is `fixed` to the window, not placed in the HUD layer.
- Labels are `lc-hud-lbl` (9 px mono); values are `lc-data`; the gear sits in a volt tile in display italic. Every layout draws flags, compounds, positions, penalties, deltas and class tags with the same badges (§6).
- The player's own row in any table is volt with void ink.
- Semantics come from the semantic tokens (§2) and follow the colour-blind palette, in CSS and on canvas. Speeds, temperatures, pressures, distances and heights go through `src/lib/settings/units.ts`.
- Text over the scene gets `.hud-text-shadow` only when it is not on glass.

## 9. Screen size

- Menus and HUD are drawn for a 1080p-class window. `--lc-ui-zoom` (`globals.css`) scales them up on bigger ones: 1.25 from 2200 × 1300, 1.5 from 2700 × 1600, 2 from 3400 × 1900 (both sides must clear a step, so 21:9 and 32:9 scale by height). Menu and overlay roots take it as CSS `zoom` (`.lc-ui-zoom`); the HUD multiplies its corner-group scale by it (`useUiZoom()`).
- Inside a zoomed root, `vw` / `vh` resolve before the zoom: keep them inside `clamp()` / `min()` with a px cap. A position measured in window pixels and set on a zoomed element is divided by the zoom.
- Short screens (`short:`, under 512 px tall, i.e. landscape phones) drop secondary chrome before the primary action leaves the screen. Touch screens hide key prompts until a controller is used.
- Phones (`phone:`, under 640 px wide or 512 px tall, either way up) are as dense as a mobile racer: menu rows 46 px (the main action 52–58), row labels 16–18 px display, details 11–12 px, headings 22–24 px, primary buttons 44 px. Setup cards become rows (icon beside the title), and a landscape phone puts the title screen's setup beside its actions, so it fits one screen. The Phone HUD shrinks its numbers and panels and the steer pad narrows, but no label goes under 9 px and no touch target under 44 px.
- Below `lg` an open panel takes the screen: the rail hides (it would stack thirteen rows above the panel), Close and Ⓑ / Esc go straight back to the title screen.
- On phones a segmented row tightens (13 px, 6 px padding) and wraps a long label rather than clipping it; the browsers' sort scrolls sideways in its own row; content cards are picture tiles in two or three columns and long names wrap anywhere. Nothing may widen the page past the screen.
- Safe area: the page draws under the notch, Dynamic Island and home indicator (`viewportFit: "cover"`), so no text or control may sit in `env(safe-area-inset-*)`. The scene, glows and letterbox bars run to the true edge.
  - The HUD layer is a `.lc-safe-frame` (`globals.css`): groups anchored inside it clear the insets with plain offsets. Never add `env()` inside it.
  - Every other fixed root adds the inset itself. Menu roots pad with `max(<padding>, env(safe-area-inset-<side>))` on every side and at every breakpoint; touch pads, toasts and portalled panels offset with `calc(env(safe-area-inset-<side>, 0px) + <gap>)`.
  - Centre a bottom pill between `left` / `right` of `max(1rem, env(…))` with `mx-auto`, not with `left-1/2` and a `100vw` width: the insets need not be equal.
  - Scrolling content may pass under the top and bottom insets, but must clear them at each end of the scroll.

## 10. Motion

- Focus, hover and value changes: 200 ms `ease-lc` (`cubic-bezier(0.2, 0.8, 0.2, 1)`). Animate transform and opacity, not width or height.
- Panels enter with `lc-panel-in` (180 ms, 10 px slide).
- Status loops (`lc-ping`, `lc-breathe`, `lc-alert`, `lc-listen`) only for live states.
- `prefers-reduced-motion` turns every loop and entrance off.

## 11. Don't

- Square or small-radius cards for sheets, or flat opaque pages over the scene.
- Upright or non-italic display headings; sans-serif labels; proportional numbers.
- A second focus colour, or volt used for decoration or for "selected".
- A kicker or eyebrow: a small label line above a heading, a card or a block. The heading speaks for itself; a panel about one circuit names it in a line under the heading. (A field's label and a table's header are not kickers.)
- A hex, an off-scale radius, a hand-drawn chip or a second control for a setting that already has a home.
- Colour as the only signal.
- Emoji, gradient washes, coloured left-border cards.
