# Contributing to LibreCorsa

Thanks for helping. Bug reports, handling feedback from sim racers, new content and code are all welcome.

## Where things go

- **Bugs**: open a [bug report](https://github.com/KhazP/librecorsa/issues/new?template=bug-report.yml).
- **A car or track you'd like**: use **Request a car or track** in the game's title menu, or the
  [request form](https://github.com/KhazP/librecorsa/issues/new?template=content-request.yml).
- **Questions, setups, lap times, ideas**: [Discussions](https://github.com/KhazP/librecorsa/discussions).
- **Security problems**: report them privately, as described in [SECURITY.md](SECURITY.md).
- **You own an asset we use**: open a [rights / takedown request](https://github.com/KhazP/librecorsa/issues/new?template=takedown-request.yml).

## Running it

You need Node.js 22 (what CI uses).

```bash
npm install
npm run dev            # http://localhost:3000
```

Before opening a pull request, run what CI runs:

```bash
npm run typecheck
npm run verify
```

`npm run verify` runs every `scripts/verify-*.ts` suite (physics, both car models, GT3, input, lap tools, race
session, realism, telemetry out, WebHID force feedback). It takes a few minutes. Physics changes must keep it
passing. If a change is meant to move a number, update the check and say why in the pull request.
`npm run verify:laps` is the slow full-pace lap check; run it when you touch tyres, aero, the drivetrain or the
racing-line optimiser.

## Pull requests

- Keep each one to one change, and describe what a player would notice.
- Commit messages follow the style in the history: `feat(scope): …`, `fix: …`, `build(tracks): …`, `docs: …`.
- For handling changes, say what you drove (keyboard, pad, wheel, and which car and track) and how it felt
  before and after. Comparisons with other sims are useful.
- Don't rename the `bugesera.*` localStorage keys or the `bugesera-laps` IndexedDB name. Players' saved
  settings and ghosts live there.
- Changes to the online leaderboard go in `scripts/leaderboard-supabase/schema.sql` and must stay safe to run
  again on the live database.

## Cars, tracks and sounds

LibreCorsa can only ship assets it may redistribute: an open license (CC BY, CC BY-SA, CC0) or written
permission from the creator. Assets taken from other games (Assetto Corsa, ACC, iRacing, F1 games…) need the
original creator's permission. Credit every asset in [CREDITS.md](CREDITS.md) with its author, link and
license.

- **Tracks** are converted with `scripts/tracks/build_track.py`, then compressed with
  `npm run compress-tracks`, which also checks the physics meshes come out bit-exact.
- **Big files**: compress models (meshopt, WebP textures) before committing. The whole site is downloaded by
  players.

By contributing you agree your code is released under the [MIT License](LICENSE).
