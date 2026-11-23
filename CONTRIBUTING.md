# Contributing to LibreCorsa

Thanks for helping. Bug reports, handling feedback from sim racers, new content and code are all welcome.
[Get involved](docs/GET-INVOLVED.md) is the short version for players, and the [FAQ](docs/FAQ.md) answers the
common questions.

## Where things go

- **Bugs**: open a [bug report](https://github.com/librecorsa/librecorsa/issues/new?template=bug-report.yml).
- **A car or track you'd like**: I can only add what I have permission for, so ask the mod's author first and post
  their answer in the [request form](https://github.com/librecorsa/librecorsa/issues/new?template=content-request.yml),
  or port it yourself with their permission ([Get involved](docs/GET-INVOLVED.md#bring-a-circuit-or-a-car)).
- **Questions, setups, lap times, ideas**: [Discussions](https://github.com/librecorsa/librecorsa/discussions).
- **Guides** (porting cars, circuits and wheels, how the physics and the AI work): [docs.librecorsa.org](https://docs.librecorsa.org/).
  The pages are the Markdown in `docs/`, so a fix to a guide is a pull request on that file.
- **Translations**: see [Translating](docs/TRANSLATING.md). A new language, or a fix to one, is a pull request on its files in
  `src/i18n/messages/`.
- **Security problems**: report them privately, as described in [SECURITY.md](SECURITY.md).
- **You own an asset we use**: open a [rights / takedown request](https://github.com/librecorsa/librecorsa/issues/new?template=takedown-request.yml).

## Running it

You need Node.js 24 (what CI uses). [How the code fits together](docs/ARCHITECTURE.md) is a map of the code.

No setup on your machine? [Open it in GitHub Codespaces](https://codespaces.new/librecorsa/librecorsa): the dev container
in `.devcontainer/` installs Node.js 24 and the packages, so you only run `npm run dev`. VS Code's Dev Containers
extension uses the same file.

```bash
npm install
npm run dev            # http://localhost:3000
```

Before opening a pull request, run what CI runs:

```bash
npm run typecheck
npm run verify
```

`npm run verify` runs every `scripts/verify-*.ts` suite (physics, every car model, input, lap tools, race session,
realism, telemetry out, WebHID force feedback) but the slow lap check. It takes a few minutes, several suites at once,
longest first (`scripts/verify-timings.json`; `npm run verify -- --record` updates the times, and `VERIFY_JOBS=1` runs the
suites one after another). A failing suite doesn't stop the others: the run ends with every suite that failed and
the command that reruns it, such as `node scripts/run-verify.mjs tyre-thermal`. Physics changes must keep it
passing. If a change is meant to move a number, update the check and say why in the pull request.
`npm run verify:laps` is that slow full-pace lap check; run it when you touch tyres, aero, the drivetrain or the
racing-line optimiser.

## Pull requests

- Keep each one to one change, and describe what a player would notice.
- Commit messages follow the style in the history: `feat(scope): …`, `fix: …`, `build(tracks): …`, `docs: …`.
- For handling changes, say what you drove (keyboard, pad, wheel, and which car and track) and how it felt
  before and after. Comparisons with other sims are useful.
- Don't rename the `bugesera.*` localStorage keys or the `bugesera-laps` IndexedDB name. Players' saved
  settings and ghosts live there.
- The online side is the Worker in `cloudflare/` ([its README](cloudflare/README.md)). Changes to the lap boards'
  tables go in a new file under `cloudflare/migrations/`, never an edit to one already applied.

## Cars, tracks and sounds

LibreCorsa can only ship assets it may redistribute: an open license (CC BY, CC BY-SA, CC0, Free Art License), a
non-commercial one (CC BY-NC, CC BY-NC-SA: LibreCorsa is non-profit, and these assets stay under their own
terms, see the asset notice in CREDITS.md) or written permission from the creator. Assets taken from other games need the original
creator's permission. Credit every asset in [CREDITS.md](CREDITS.md) with its author, link and
license.

- **Tracks** are converted from a mod with `scripts/tracks/port_ac_track.py` or built from a Blender model with
  `scripts/tracks/build_blender_track.py` (see [Porting circuits](docs/PORTING-TRACKS.md)). Both compress what they
  write. `npm run compress-tracks` compresses any circuit that isn't yet and checks the physics meshes come out
  bit-exact. Then `npm run home-outlines` draws the new circuit's map for the home page.
- **Big files**: compress models (meshopt, WebP textures) before committing. The whole site is downloaded by
  players.

By contributing you agree your code is released under the [GNU Affero General Public License v3.0 or later](LICENSE) (AGPL-3.0-or-later).
