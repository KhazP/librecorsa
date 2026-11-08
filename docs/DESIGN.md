# LibreCorsa design: "Racing Line"

The visual language of every LibreCorsa screen: title menu, pause menu, setup wizard, garage and the in-race HUD.
It is written down from what the code already does (`src/app/globals.css`, `src/components/menu/menu-ui.tsx`,
`src/components/hud/styles/hud-style-parts.tsx`, `src/components/hud/hud-format.ts`). When the code and this
file disagree, fix one of them; don't let a third look appear.

## 1. Principles

1. **The track is the hero.** UI floats on frosted glass over the live 3D scene. Menus dim and blur the scene, they never replace it with a flat page.
2. **One focus colour.** Acid volt `#CCFF00` means "you are here": the focused entry fills volt with void ink. Nothing else uses a volt fill except the primary button, the player's own row and the gear tile.
3. **Words are italic, numbers are mono.** Display text is Chakra Petch bold italic in capitals, UI text is Geist. Every number, label and key cap is Geist Mono with tabular figures.
4. **Every input, always.** Each screen works with a controller, the keyboard and the mouse, and shows the prompts for the input last used.
5. **Colour is never alone.** Every coloured state also carries a sign, glyph or word (− / +, ▲ ▼, HOT, PB, +1 LAP).
6. **Lists grow.** Any picker that holds content (cars, circuits, liveries, presets) is a browser: search, category filters with counts, sort, a scrolling grid with sticky group headers, favourites, recents and download state. Categories come from the data, never from hard-coded tabs.

## 2. Colour

| Token | Hex | Use |
|---|---|---|
| `--lc-volt` | `#CCFF00` | Focus, primary action, the player (own row, own map dot, gear tile) |
| `--lc-volt-dim` | `#99BF00` | Pressed volt |
| `--lc-crimson` | `#FF2A3C` | Losing time, invalid lap, braking, alerts |
| `--lc-cyan` | `#00E5FF` | Information, open panel edge, ERS / aero, sector 1 |
| `--lc-sector-purple` | `#B845FF` | Overall fastest |
| `--lc-sector-green` | `#00E676` | Personal best, gaining time |
| `--lc-sector-amber` | `#FFB300` | Caution, warnings, spotter |
| `--lc-void` | `#08090D` | Canvas, ink on volt |
| `--lc-carbon` | `#11131A` | Panels, cards |
| `--lc-titanium` | `#1B1F2B` | Raised wells, slider track, inactive switch |
| `--lc-border` | `#262B3D` | Hairlines inside a sheet |
| `--lc-keyline` | `#3A4157` | Key caps, prompt outlines |
| `--lc-slate` | `#8E96AA` | Labels, secondary text |
| `--lc-fog` | `#C5CBD8` | Body copy on dark sheets |
| `--lc-white` | `#F5F7FA` | Primary text, timing-tower cap |
| (dim) | `#5B6275` | Placeholders, disabled text, neutral chart lines |
| (well) | `#050608` | Inset wells inside a card (inputs, stat tiles) |

Rules: no colour outside this table. Sector colours on maps are cyan, volt and pink `#FF6B8A` (`SECTOR_COLORS`).
Colour-blind palettes swap the *semantic* pairs (gain/loss, cold/hot, lapped ahead/behind), never the brand volt focus.

## 3. Type

Target type system (the proposal boards use it; the code still ships Titillium Web and JetBrains Mono).
Each layer borrows from where racing sims put it: a squared motorsport face for display (Chakra Petch, as in
AC EVO's menus and the RaceLab / SimHub overlays), a neutral grotesk for UI text, a mono for timing.

| Role | Class | Spec |
|---|---|---|
| Display | `.lc-disp` | Chakra Petch 700 italic, uppercase, line-height 0.95. Sizes 72 / 44 / 28 / 18. Headings, rail labels, buttons, gear |
| Title | `.lc-title` | Chakra Petch 700 italic, uppercase. 13–20 px. Tabs, secondary buttons |
| Body | – | Geist 400 / 500 / 600, 13–17 px, fog on dark. All sentence-case UI text, inputs |
| Label | `.lc-lbl` | Geist Mono 600, 11 px, tracking 0.16em, uppercase, slate. HUD: 9 px, 0.18em (`HUD_LBL`) |
| Data | `.lc-data` | Geist Mono 700, tabular figures. Lap times, gaps, speeds, values |
| Logo | `.font-f1-display` | Orbitron, only in the wordmark |

Geist has no true italic, so nothing set in Geist is italicised; italic display always uses Chakra Petch.
Migration: load Geist and Geist Mono with the `geist` package (`next/font`), Chakra Petch through `next/font/local`
like the current fonts, then swap the families in `.lc-disp`, `.lc-title`, `.lc-lbl`, `.lc-data` and `body`.

## 4. Shape

| Thing | Radius |
|---|---|
| Sheet over the scene (`.lc-glass`, `.lc-sheet`) | 26 px |
| Card, choice tile (`.lc-card`) | 18 px |
| Rail entry | 20 px (primary 22 px) |
| HUD panel | 20–22 px |
| Tiles inside a panel | 8–12 px |
| Buttons, segmented controls, chips, key caps, switches | fully round (pill) |

Heights: primary button 52, rail entry 58 (primary 64), segmented option 40, chip 26, key cap 22, switch 30.

## 5. Surfaces

- **Glass** (`.lc-glass`): `rgba(14,16,22,0.72)`, 1 px `white/7%` border, `blur(22px)`, shadow `0 30px 80px rgba(0,0,0,.45)`, top inner highlight `white/5%`.
- **HUD glass** (`HUD_GLASS`): `#08090D` at 74%, `white/7%` border, `blur(14px)`, shadow `0 14px 40px rgba(0,0,0,.5)`.
- **Card** (`.lc-card`): solid carbon with a `#262B3D` hairline, for content inside a sheet.
- **Timing-tower cap**: a white `#F5F7FA` header bar with void display text, the one light surface in the HUD.
- Over the scene use the `white/7%` hairline; inside a sheet use `#262B3D`.

## 6. Components (in `menu-ui.tsx`)

- **SectionLabel**: a 6 px volt dot, then `.lc-lbl`.
- **RailItem**: icon, display label, one slate detail line. Focus: volt fill, void ink, 5 px volt halo, chevron appears. Open panel: cyan inset hairline and a glowing cyan dot.
- **TabStrip**: pill track on void, active tab volt; LB / RB glyphs (or Q / E caps) at either end.
- **Segmented**: pill track on void, active option volt. Use for 2–4 choices.
- **Chip**: 26 px pill, mono 11 px 800; `solid`, `soft` (12% tint) or `outline`.
- **KeyCap**: 22 px round cap, void with keyline; `volt` and `ink` tones inside buttons.
- **PadGlyph**: face buttons in their own colours (Xbox A `#5DC21E`, B `#E5413A`, X `#2F8BE5`, Y `#F4C21B`); LB / RB outlined pills.
- **PromptBar**: no container; glyph or key cap + 13 px 600 fog label, 22 px gaps, on a hairline at the bottom of the screen.
- **PrimaryButton**: 52 px volt pill, display label, a void key chip inside on the left; secondary tone is titanium with a hairline.
- **Range** (`.lc-range`): 6 px track, volt fill to the value, white thumb with a 4 px volt ring.
- **Switch**: 30 × 64 pill, ON / OFF written inside. On = volt fill, void knob.
- **Meter / CenterMeter**: slate label, 8 px titanium track, mono value.

## 7. Focus and navigation

- One focus model for all inputs: the mouse focuses what it hovers (`focusOnHover`), arrows / d-pad move it, Enter / A activates.
- Up / down moves between rows; left / right changes the focused row's value.
- LB / RB (Q / E) switch tabs or categories. B / Esc goes back exactly one level, never more.
- Rows that hold an input ring the whole row: 2 px volt outline, 14 px radius, volt 6% tint.
- With a controller, the focused element also gets a 5 px volt halo and a soft glow (`html[data-input="pad"]`).
- The prompt bar always shows the glyphs of the input in use.

## 8. HUD

- Corner groups are anchored to their corner and scale about it (`anchor()`), so HUD size never pushes a group off-screen.
- With the touch controls up, every preset gives way to the Phone HUD at any screen size: the pads take both bottom corners and the top-left, where the other presets put their panels.
- Past 2.4:1 (a 32:9 screen) the HUD keeps to a centred 2.4:1 frame instead of the far edges. Anything the renderer places in window pixels (the virtual mirror's frame) is `fixed` to the window, not placed in the HUD layer.
- Labels are 9 px mono; values are `.lc-data`; the gear sits in a volt tile in display italic.
- The player's own row in any table is volt with void ink.
- Semantics: purple overall best, green PB / gaining, crimson losing / invalid, amber caution, cyan info / ERS.
- Text over the scene gets `.hud-text-shadow` only when it is not on glass.

## 9. Screen size

- Menus and HUD are drawn for a 1080p-class window. `--lc-ui-zoom` (`globals.css`) scales them up on bigger ones: 1.25 from 2200 × 1300, 1.5 from 2700 × 1600, 2 from 3400 × 1900 (both sides must clear a step, so 21:9 and 32:9 scale by height). Menu and overlay roots take it as CSS `zoom` (`.lc-ui-zoom`); the HUD multiplies its corner-group scale by it (`useUiZoom()`).
- Inside a zoomed root, `vw` / `vh` resolve before the zoom: keep them inside `clamp()` / `min()` with a px cap. A position measured in window pixels and set on a zoomed element is divided by the zoom.
- Short screens (`short:`, under 512 px tall, i.e. landscape phones) drop secondary chrome before the primary action leaves the screen. Touch screens hide key prompts until a controller is used.
- Phones (`phone:`, under 640 px wide or 512 px tall, either way up) are as dense as a mobile racer: menu rows 46 px (the main action 52–58), row labels 16–18 px display, details 11–12 px, headings 22–24 px, primary buttons 44 px. Setup cards become rows (icon beside the title), and a landscape phone puts the title screen's setup beside its actions, so it fits one screen. The Phone HUD shrinks its numbers and panels and the steer pad narrows, but no label goes under 9 px and no touch target under 44 px.
- Safe area: the page draws under the notch, Dynamic Island and home indicator (`viewportFit: "cover"`), so no text or control may sit in `env(safe-area-inset-*)`. The scene, glows and letterbox bars run to the true edge.
  - The HUD layer is a `.lc-safe-frame` (`globals.css`): groups anchored inside it clear the insets with plain offsets. Never add `env()` inside it.
  - Every other fixed root adds the inset itself. Menu roots pad with `max(<padding>, env(safe-area-inset-<side>))` on every side and at every breakpoint; touch pads, toasts and portalled panels offset with `calc(env(safe-area-inset-<side>, 0px) + <gap>)`.
  - Centre a bottom pill between `left` / `right` of `max(1rem, env(…))` with `mx-auto`, not with `left-1/2` and a `100vw` width: the insets need not be equal.
  - Scrolling content may pass under the top and bottom insets, but must clear them at each end of the scroll.

## 10. Motion

- Focus, hover and value changes: 220 ms `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- Panels enter with `lc-panel-in` (180 ms, 10 px slide).
- Status loops (`lc-ping`, `lc-breathe`, `lc-alert`, `lc-listen`) only for live states.
- `prefers-reduced-motion` turns every loop and entrance off.

## 11. Don't

- Square or 4–10 px-radius cards for sheets, or flat opaque pages over the scene.
- Upright or non-italic display headings; sans-serif labels; proportional numbers.
- A second focus colour, or volt used for decoration.
- Colour as the only signal.
- Emoji, gradient washes, coloured left-border cards.
