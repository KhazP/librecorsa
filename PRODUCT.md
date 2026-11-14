# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two groups, both first-class (confirmed 13 Nov 2026):

- **Newcomers.** Someone who opened a link and drives on a keyboard, a gamepad or a phone. They want to be on track in seconds and change a few obvious things (car, circuit, assists, HUD).
- **Sim racers.** People with a wheel and pedals who expect every option a PC sim has: force feedback, calibration, bindings, car setup, telemetry out.

Settings serve both through a Simple / Advanced switch: Simple shows the short list, Advanced shows everything.

## Product Purpose

LibreCorsa is an open-source racing simulator that runs entirely in the browser, with nothing to install. It has 500 Hz vehicle dynamics, a thermal tyre model, open-wheelers, GT3 cars, a prototype and a road car, circuits and hill climbs, AI races, ghosts and replays, and peer-to-peer multiplayer.

## Positioning

A real simulator (500 Hz physics, force feedback, car setup) that starts from a link. Free, MIT-licensed, made by one developer.

## Operating Context

- Played with a keyboard, gamepad, touch screen or force-feedback wheel. Every screen works with all of them and shows the prompts of the input last used.
- The UI sits over a live 3D scene: title menu, pause menu and HUD float on it.
- Window sizes run from a landscape phone to a 32:9 monitor.
- Surfaces: home page, the game (`/play`: loading, title menu, first-run setup, HUD, pause menu, results), press page, privacy page, admin stats.

## Capabilities and Constraints

- Next.js 16, React 19, Tailwind 4, three.js. No component library.
- The game must stay controllable by pad and keyboard alone; Esc is the pause key in a session.
- Settings (decided 13 Nov 2026): one Settings screen shared by the title menu and pause, with six categories (Driving, Controls, Force feedback, Display, Audio, Profile and data) and tabs inside them. Race rules stay under Race, weather under Conditions, car setup under Garage (one name on both sides).
- To be built with it: master volume and saved mute, units, UI scale, a colour-blind palette, reset all settings, clear saved data, run first-time setup again, and a visible per-car force feedback gain.

## Brand Commitments

- The name is LibreCorsa. An independent fan project, not affiliated with any series, team, manufacturer or other game; it carries none of their marks or names as branding.
- Kept (confirmed 13 Nov 2026): the logo design, the fonts (Chakra Petch, Geist, Geist Mono, Orbitron in the wordmark) and the colours of `docs/DESIGN.md`.
- To be remade as one family: icons, badges and chips, racing symbols (flags, tyre compounds, car classes, penalties, track types) and controller prompts. The logo's renditions are brought into line with the one design.
- Voice: first person singular, plain, no em dashes.
- No small label lines above titles or blocks that only name them.

## Evidence on Hand

- `docs/DESIGN.md`: the documented visual system.
- Audit reports of 13 Nov 2026 (brand, symbols, settings inventory, tokens, HUD, pages), kept outside the repo.

## Product Principles

1. The track is the hero: UI never replaces the scene with a flat page.
2. Every input, always.
3. One way to draw each thing: one icon per concept, one badge system, one control per setting.
4. A setting lives in one place, under a name that says what it changes, reachable from the title menu and from pause when it applies live.
5. Short by default, complete on request.

## Accessibility & Inclusion

- Colour never carries meaning alone.
- A colour-blind palette is documented in `docs/DESIGN.md` but not built; building it is in scope.
- Touch targets of at least 44 px on phones; HUD text of at least 9 px, menu labels of at least 11 px.
