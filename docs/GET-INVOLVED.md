# Get involved

LibreCorsa is one person's side project, so any help shows. Here's what you can do, from five minutes to a weekend. Questions about any of it go in [GitHub Discussions](https://github.com/librecorsa/librecorsa/discussions).

## Play it and tell me what's wrong

- **Bugs**: press Feedback on the title menu, or the Feedback tab in the pause menu, and choose Bug. It opens a GitHub issue with the circuit, car, device and error log filled in. You can also use the [bug report form](https://github.com/librecorsa/librecorsa/issues/new?template=bug-report.yml).
- **Stutter or low frame rate**: play with [librecorsa.org/play?perf=1](https://librecorsa.org/play?perf=1) and attach the performance report from the pause menu. See [Performance](PERFORMANCE.md).
- **How a car drives**: say what you drove with (keyboard, controller or wheel), which car and circuit, and how it felt. Comparisons with other sims help.
- **Your wheel**: a [wheel report](https://github.com/librecorsa/librecorsa/issues/new?template=wheel-report.yml) says whether steering, pedals and force feedback work, and moves your wheel into the [table](CONTROLS.md).

## Bring a circuit or a car

I can only host what I have the right to: your own work, something under an open licence (CC BY, CC BY-SA, CC0 or the Free Art License), a non-commercial one (CC BY-NC or CC BY-NC-SA), or a mod whose author has said yes in writing. A mod built from another game's models would also need that game's maker to agree, so in practice it can't come in.

1. **Get permission.** Ask the mod's author whether LibreCorsa may host their work, and keep their answer: a message or a post you can link or screenshot. For your own work, say which licence you're releasing it under.
2. **Port it.** Follow [Porting circuits](PORTING-TRACKS.md) or [Porting cars](PORTING-CARS.md), including their compression and racing-line steps, and drive it.
3. **Open a pull request** with the code side only. For a circuit, that's its entries in `scripts/tracks/tracks.json` and `public/tracks/index.json`, any change it needs in `src/lib/track-registry.ts`, and its credit in [CREDITS.md](../CREDITS.md). The model files stay out of git: `public/tracks/` and `public/cars/` are gitignored.
4. **In the pull request**, post the author's permission, a link to the original, and a download link to your converted folder. I check it, drive it, upload the files to the site and merge.

If you can't port it yourself, asking the author is still the biggest step: post their answer in a [content request](https://github.com/librecorsa/librecorsa/issues/new?template=content-request.yml).

## Translate

The game's text lives in `src/i18n/messages/`, one folder per language. A new language, or a fix to one, is a pull request on those files. [Translating](TRANSLATING.md) explains the steps, including how to translate with an AI model and check the result.

## Write code

- [CONTRIBUTING.md](../CONTRIBUTING.md) has the setup: Node.js 24, `npm install`, `npm run dev`. Or skip the setup and [open it in GitHub Codespaces](https://codespaces.new/librecorsa/librecorsa). Run `npm run typecheck` and `npm run verify` before you open a pull request.
- Keep a pull request to one change, and say what a player would notice.
- Issues marked [good first issue](https://github.com/librecorsa/librecorsa/issues?q=is%3Aopen+label%3A%22good+first+issue%22) or [help wanted](https://github.com/librecorsa/librecorsa/issues?q=is%3Aopen+label%3A%22help+wanted%22) are good places to start.
- Where things are in the code: [How the code fits together](ARCHITECTURE.md). How the physics and the AI work: [Physics validation](physics/README.md) and [Race AI](race-ai.md).

## Fix the docs

These pages are the Markdown files in `docs/`. A fix to one is a pull request on that file, and it reaches [docs.librecorsa.org](https://docs.librecorsa.org/) once it's merged.

## Spread the word

Clips, streams and posts bring in most new players. I'm [@alpyalay](https://x.com/alpyalay) on X. To support the game with money, see [How can I support LibreCorsa?](FAQ.md#how-can-i-support-librecorsa)

## Report a security problem

Report it privately, as [SECURITY.md](../SECURITY.md) explains, not in a public issue.
