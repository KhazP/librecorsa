# FAQ

Short answers to what people ask most, with links to the full pages.

## About LibreCorsa

### Is LibreCorsa free? Will it stay free?

Yes, for good. There are no ads, no paid content and no paid tiers. Donations pay for the servers and help me keep working on it, and they don't unlock anything in the game.

### Who makes it?

I do, Alp Yalay, as a side project next to my job. I write it with the help of AI coding tools. Most cars and circuits were made by modders who let me use their work, and every one of them is credited in the game and in [CREDITS.md](../CREDITS.md).

### Why is it called LibreCorsa?

"Libre" as in free and open, and "corsa" is Italian for race.

### How often is it updated?

When I have time. LibreCorsa is a hobby next to my job, so updates come in bursts. What's new on the home page at [librecorsa.org](https://librecorsa.org/) lists every one. The game tells you when a new version is ready, and a reload gets it.

### Is it affiliated with Formula 1, the FIA or any team?

No. LibreCorsa is an independent fan project, not affiliated with Formula 1, the FIA, any team or any circuit.

## Playing

### What can I play it on?

- **In a browser** on Windows, macOS or Linux: any browser with WebGL2 and hardware acceleration turned on.
- **Desktop apps** for Windows, macOS and Linux, and an **Android app** (Android 7 or later, with Chrome). They open the same site, so updates arrive without reinstalling. See [Checking a download](DOWNLOADS.md).
- **iPhone and iPad** in Safari. Share, then Add to Home Screen, gives you full screen.
- **VR headsets** through WebXR (Quest Browser, or Chrome with SteamVR or OpenXR), from Settings > Display > Graphics. It's a work in progress, so expect rough edges.

### Can I play offline?

Not yet, and I'd like to add it. If you clone the repository, you can run RISE Motordrome with the 2026 Prototype on your own machine without a connection. Every other circuit and car is only served from librecorsa.org, because their makers allowed LibreCorsa to host them, not for the files to be passed around.

### Which wheels and controllers work?

- **Controllers**: Xbox and PlayStation pads, with rumble. A DualSense paired in Chrome or Edge also gets adaptive triggers, haptics and its lights. Phones and tablets have touch controls or tilt to steer.
- **Wheels**: any wheel your computer sees as a game controller can steer, brake and accelerate. Force feedback works straight from Chrome or Edge on many bases, or through a small bridge on Windows for the rest.
- I've only driven a MOZA R9, so the rest of the list is what the code should do. [Which wheels work](CONTROLS.md) has the table, and a wheel report on GitHub moves your wheel into it.

### How do I race my friends?

Open Multiplayer and press Host a room. Send your friends the invite link or the six-character code. A room takes you and up to 15 friends, and everyone needs the same version of the game. There's also an open race every 20 minutes that anyone can join. See [Racing online](ONLINE.md).

### It's slow, the screen went black, or it crashed. What do I do?

- **Slow**: lower Quality in Settings > Display > Graphics, or turn on Automatic quality. On a phone, the 30 fps frame rate keeps it cooler.
- **Black or blank screen**: usually the browser lost its connection to the graphics card. The game shows what to press. If it says 3D graphics are off, turn on hardware acceleration in your browser and reload.
- [Performance and troubleshooting](PERFORMANCE.md) has the rest, and how to send me a bug report with the details I need.

### How are lap times checked? Are there cheaters?

The board checks every lap for plausibility, but it can't prove a lap was driven. If a time looks wrong, report that entry in a GitHub issue and I'll look at it.

### Do I need an account? What do you collect?

No account is needed, and you don't have to give a name to play. When you stop driving, the game sends what you drove and for how long, and the site only adds it to daily totals. No player id, cookie or address is kept. The [privacy page](https://librecorsa.org/privacy) has the details.

Accounts are optional, and you sign in with Discord, Google, Steam or a passkey. An account keeps your driver names, settings, setups, liveries, race history and personal bests the same on every device you sign in on. If you only play on one device, you don't need one. Without one, your name is held by a driver key saved in your browser, so save the key to a file (Settings > Profile and data > Data) before clearing site data.

## Cars and circuits

### Why isn't Monza, Spa or Silverstone in the game?

I add circuits that are freely licensed or whose maker said yes. Famous circuits come in when a modder who built their own version gives permission.

### Can I request a car or circuit?

Yes, but a request alone rarely gets one in, since I can only add what I have permission for. The ways that work:

- **Ask the modder.** If you know a mod you'd like, ask its author to let LibreCorsa use it, and post their answer in a [request](https://github.com/librecorsa/librecorsa/issues/new?template=content-request.yml).
- **Port it yourself.** With the author's permission, convert it with the [circuit](PORTING-TRACKS.md) or [car](PORTING-CARS.md) guide and open a pull request. [Get involved](GET-INVOLVED.md) explains how.
- **Make your own.** Your own circuit or car, under a licence that lets LibreCorsa host it, goes in the same way.

### Will you add real F1 teams, drivers or liveries?

No. What I add myself needs the rights to it. Some cars ported from mods carry real brand names and liveries. Those are their makers' work, and their responsibility.

### Will LibreCorsa come to Steam or consoles?

No plans right now.

## Open source

### Can I use the code or host my own copy?

Yes. The code is under the [GNU Affero General Public License v3.0](../LICENSE), so you can run it, change it and host it. If you run a changed version for other people, you share its source under the same licence. A clone carries RISE Motordrome and the 2026 Prototype. Every other car and circuit stays on librecorsa.org.

### Can I use the cars and circuits in my own game or mod?

It depends on each one, and [CREDITS.md](../CREDITS.md) lists every maker and licence.

- **Under a Creative Commons licence**, you can use it on that licence's terms. That includes the 2026 Prototype's and the LC-LMDH's bodies (CC BY 4.0) and RISE Motordrome, which is mine ([CC BY-NC-SA 4.0](../public/tracks/rwanda_official/LICENSE.md): with credit, non-commercially, under the same licence).
- **Used with permission**, as most modders' cars and circuits are, means the permission is for LibreCorsa only. Ask the maker yourself.

### How can I support LibreCorsa?

- **Donate** at [Buy Me a Coffee](https://buymeacoffee.com/alpyalayg). It pays for the servers and helps development.
- **Support the modders.** Each car and circuit's Source panel in the game links its maker's Patreon or PayPal where they have one.
- **Play, report and share.** Bug reports, wheel reports and telling people about the game all help.

### Is there a Discord?

No. Questions, setups and ideas go in [GitHub Discussions](https://github.com/librecorsa/librecorsa/discussions), and bugs in [issues](https://github.com/librecorsa/librecorsa/issues/new/choose).
