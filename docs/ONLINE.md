# Racing online and lap boards

LibreCorsa has four online parts: private rooms for racing friends, open races that start every 20 minutes, lap boards with Time Trials (the rotating weekly challenge plus the permanent Middle Gear Lap Board), and optional accounts that keep your names and your save across devices. On `librecorsa.org`, they run on the site's Cloudflare Worker (see [Self-hosting and the online backend](SELF-HOSTING.md) to run your own). Self-hosted copies without that backend still support peer-to-peer private rooms (via the public PeerJS broker) and save personal best laps locally in the browser.

## Driver profile

In rooms and open races, other drivers see your **Name**, three-letter **Code**, and **Colour**. The lap boards display your name and code. New players start with a randomly generated profile (such as `Apex Falcon 27` / `FAL`).

- Customize your identity under **Settings > Profile and data > Driver**: **Name** (up to 16 characters), **Code** (3 letters), and **Colour**.
- The lap boards reject slurs, profanity, and names that impersonate official LibreCorsa accounts, prompting `"Pick another name"`.

## Private rooms

### Hosting and joining

1. Open **Multiplayer** from the main menu or the pause menu.
2. Click **Host a room** to generate a 6-character room code (letters and digits, omitting `I`, `O`, `0`, and `1` to prevent typos). Use **Copy invite link** or **Share** (on devices with a native share sheet) to invite friends, or click **New room** to open a fresh lobby with a new code.
3. Guests can enter the code under **Join a friend's room** and click **Join**, or open the invite link directly to join automatically once the circuit finishes loading.

A few ground rules for rooms:

- **Host presence:** The host must keep the game tab open. If a room cannot be found, the client reminds guests to double-check the code and ensure the host still has the game open on screen.
- **Capacity and reconnects:** On `librecorsa.org`, a room supports the host plus up to 15 guests (16 cars total). If the host briefly loses connectivity, their client re-opens the room automatically under the same code.
- **Version matching:** Everyone in a room must run the same build. A mismatched client sees `"This room runs another version of LibreCorsa. Everyone in it needs to reload the page."`
- **Hill climbs:** Multiplayer races are disabled on hill-climb venues, which are single-car timed runs.

### The lobby

- The **Drivers** card lists every participant with their code, name, car, **Host** badge, **Ready** / **Not ready** status, and live ping and packet loss for remote players.
- If you are loaded onto a different circuit from the host, the lobby displays `"The host is on"` followed by that circuit and a **Switch circuit** button. If your car does not match the room's allowed class, eligible cars are listed and other drivers see a **Wrong class** badge next to your name.
- Guests click **Ready up**, and the host launches the session with **Start race**. If qualifying is enabled, that button launches qualifying instead (for example, **Start 5 min qualifying**), and the host can skip straight to the grid using **Start race now**.
- **End qualifying** and **End race for everyone** return the entire lobby to the waiting room. Host settings are locked once qualifying or a race is underway.
- At the checkered flag, the host distributes one canonical race result to all drivers. Private room results are ephemeral and never stored on the server.

### Host settings

| Card | Setting | Options |
| :-- | :-- | :-- |
| Event | **Circuit** | Selected via **Change** from the main menu |
| Event | **Cars** | **Any car** (multi-class) or a single car class |
| Event | **Weather**, **Time of day**, **Time speed** | Weather/time presets; time speed set to **Fixed** or a multiplier |
| Race | **Laps** | 1 to 50 |
| Race | **Qualifying** | **Off**, 3, 5, or 10 min (best clean lap sets the grid) |
| Race | **Grid order** | **Qualifying**, **Reverse**, or **Random** (overridden by qualifying when enabled) |
| Race | **Start** | **Standing** or **Rolling** |
| Race | **Launch** | **Assisted** or **Manual** (standing starts only) |
| Rules | **Rules** | **Classic**, **Auto**, **Open-wheel**, or **Endurance** |
| Rules | **Track limits** | **On** or **Off** |
| Rules | **Penalties** | **On** or **Off** (time penalties for track limits and jump starts) |
| Rules | **Damage** | **Off**, **Reduced**, or **Full** |
| Rules | **Collisions** | **On** (default, with safety guards), **Ghosted lap 1** (no contact on lap 1), or **Off** |

How the track-limits rule sets score off-track strikes:

- **Classic:** Every third strike incurs a time penalty (`+3 s`, then `+5 s`).
- **Open-wheel:** Counts strikes: 4 strikes = `+5 s`, 8 = `+10 s`, 12 = disqualification.
- **Endurance:** Uses weighted severity points: 5 points = `+5 s`, 10 = `+10 s`, 15 = disqualification.
- **Auto:** Applies **Open-wheel** rules to single-seaters and **Endurance** rules to all other classes.

### Connection architecture and fallbacks

- The room server handles initial matchmaking by room code; once paired, vehicle state streams directly between browsers at 60 Hz over WebRTC.
- Guests connect to the host, who relays traffic to any peers that cannot connect directly. A **Relayed** badge beside a driver indicates their state is routing through the host.
- When strict NATs, firewalls, or mobile carriers block direct peer-to-peer links, the room server issues Cloudflare TURN relay credentials. If a connection still fails, retrying or joining on the same Wi-Fi network usually resolves it.
- To prevent netcode warping, any car that stops sending packets for 0.5 seconds becomes translucent and non-collidable, and disappears entirely after 2 seconds until packets resume.
- Under **More ways to connect**, you can also use:
  - **Local tabs:** Click **Connect local tab** to race against another tab in the same browser.
  - **Manual WebRTC:** Serverless peer-to-peer pairing. The host clicks **1. Create offer (host)** and sends the token; the guest pastes it into **Remote token** and clicks **2. Accept offer**; the host pastes the guest's answer back and clicks **3. Accept answer (host)**.
  - **Custom TURN relay:** Supply your own relay server (**Relay address** starting with `turn:` or `turns:`, plus optional **Username** and **Password**).

## Open races

### Joining a scheduled race

- Under **Multiplayer** on the main menu, the featured event card counts down to the next open race and shows the circuit, car, lap count, and interval.
- Races start every **20 minutes** using the current weekly challenge's circuit and car. Lap counts are tuned for roughly 10 minutes of racing, with a minimum of 3 laps.
- When the weekly challenge visits Dunsfold (a time-trial-only venue), open races run at **RISE Motordrome (Grand Prix layout)** in the **LC26 Prototype** instead.
- Click **Join next race** to register; the card previews the number of waiting drivers and a sample of their names. Click **Leave race** to withdraw at any time before entry closes.
- Registration locks **15 seconds before lights out** (joining later places you in the following race), with a grid cap of 16 cars.

### Grid, start, and results

- Ten seconds before lights out, the grid locks. Drivers who have posted a time on the current weekly challenge board line up in order of pace, followed by unranked entrants in join order. If no other human drivers join, you race against the AI field.
- Everyone spawns in the scheduled car on a dry track with the week's fixed assists and realism settings. Five red lights illuminate one second apart and extinguish after a random hold.
- Open races enforce **Protected** collisions: all cars are ghosted on lap 1, and from lap 2 onward any car that is stopped, crawling, driving the wrong way, off-track, or attempting to ram passes harmlessly through other cars. Across all online modes, cars that have crossed the finish line also become ghosts.
- If you disconnect mid-race, the client automatically attempts to reconnect; only drivers who started on the grid can rejoin an active race.
- Each car submits its finish time. Official results finalize once every car finishes or 90 seconds after the winner crosses the line.
- The open-races card tracks **This week's top drivers** (top five ranked by wins, then podiums) alongside your personal record (races, wins, podiums, and best finish).
- Results only count toward your standings if your client proves ownership of your driver name with its driver key, meaning you must first claim your name by posting a lap to any leaderboard.

## Lap boards

### Browsing boards

- Open **Lap times** from the main menu or pause menu (the same boards are also visible on the home page).
- Each circuit and car combination has its own board. Every driver appears once with their fastest lap and metadata tags: realism (**Full**, **Standard**, or **Casual**), assists (**Pro**, **Semi**, or **Assisted**), **Wet** (if any part of the lap was wet), and an input-device icon.
- Switch between **My car** and **All cars** (every driver's fastest lap in any car), and use **Filters** to narrow results to **No assists**, **Full realism**, or **Wet laps**. Boards paginate 20 entries at a time, and **Jump to me** scrolls straight to your row.
- Click **Race ghost** on any entry for your loaded circuit to drive against their ghost, or click **Apply setup** (when viewing rows for your current car) to load the exact setup used on that lap.

### Uploading laps

- Laps are eligible for upload from **Drive** (practice) and the **Weekly challenge**. Laps set during races or AI qualifying sessions are excluded.
- Any valid lap that beats your current best uploads automatically under your name (as does your best weekly challenge lap). You can disable automatic uploads via **Auto-upload best laps** under **Settings > Profile and data > Driver**.
- When auto-upload is disabled, the lap summary card provides a **Post online** button; after a network error, it shows **Retry upload**.
- Each lap is tagged with the highest assist level and lowest realism level active at any point during that lap, and is marked **Wet** if the tyres touched any wet surface.
- The server stores one best lap per driver for every combination of assists, realism, and dry/wet conditions so filtered boards always show accurate category bests.
- Uploads and driver renames are rate-limited to 30 requests per hour per IP address.

### Lap validity and anti-cheat limits

Outside of races (in practice and Time Trials), track-limits enforcement is strict:

- **Off-track and kerb-hop probing:** Putting all four wheels outside track limits invalidates the running lap immediately with no option to give time back. When 1–3 wheels lift momentarily over a kerb or collider seam while the remaining grounded wheels sit on runoff or grass, the simulator probes straight down beneath each lifted wheel (falling back to its last contact only over a collider gap) so an aggressive kerb hop does not falsely invalidate the lap.
- **Final-corner forfeit zone:** Going off-track or wall-riding inside the final-corner zone (starting `120 m` before the final turn's apex, or `450 m` before start/finish on circuits without turn markers, also covering the flying-start run-up and never reaching back past Sector 3) through the timing line invalidates **both the current lap and the next lap** to prevent carrying an illegal launch onto the main straight. Restarting the run clears the next-lap forfeit. Using **Flashback** in practice or time trials also invalidates the current lap, and rewinding across Start/Finish or inside Sector 3 forfeits the next lap as well.
- **Course cuts:** Skipping part of the circuit triggers `"Course cut · lap deleted"`.
- **Wall contact:** Scraping or riding a barrier (`≥ 0.35 s` of cumulative moving contact within any `3 s` window) triggers `"Wall contact · lap deleted"` while allowing brief glancing brushes. On hill climbs, any barrier touch ends the run immediately.
- **Autopilot:** Any lap where autopilot was engaged at any point is displayed locally but never ranked.

Invalid laps display **Invalid: track limits** or **Invalid: wall contact** on the lap card. Before accepting an upload, the server also validates that the lap starts and ends at the timing line (except hill climbs), sector times sum to the total lap time, the lap time matches the ghost telemetry duration, recorded speeds match distance covered without exceeding `420 km/h` or teleporting, and the lap was set on the current physics version.

> **Honest limitation:** Server checks catch casual tampering (such as pasting a faster lap time onto a genuine ghost), but browser-side telemetry cannot cryptographically prove a lap was genuinely driven. A carefully fabricated payload can still pass validation. If you spot a cheated time on a board, please report it on [GitHub Issues](https://github.com/librecorsa/librecorsa/issues).

### Driver name and identity key

- The first lap you post claims your name with your driver key, a random code kept in your browser. Later laps under that name, ignoring case and extra spaces, need the same key.
- Without it the board answers "This name is taken. Sign in to the account that holds it, import your driver key under Lap Times, or race under another name".
- With an account, every device that joined it posts under its names (see [Accounts](#accounts)).
- To use your name in another browser, save the key to a file: **Settings > Profile and data > Data**, **Identity key**, **Save**. Then **Load** it in the other browser. **Lap times** has the same pair as **Export key** and **Import key**. Importing a key automatically looks up and restores the driver name and three-letter code claimed by that key. Keep the file private.
- **Clear saved data**, or clearing the site's data in your browser, deletes the key. Save it first.
- Renaming (in the settings, or **Rename** on the lap card) moves your laps and race results to the new name and frees the old one. If you already had laps under the new name, the fastest of each kind stays. Ghosts keep the name they were driven under.
- After six months without an upload, someone else can claim the name. The laps left under it are removed when they do. A name on an account doesn't lapse.

### Input icons

- Each leaderboard row shows an icon for the primary input used on that lap: keyboard, controller, wheel, or touch screen. Hover over the icon to view `"Driven with ..."` details.
- The tag reflects whichever input you actively drove with most during the lap (touch controls pressed, bound wheel axes, keys or mouse steering, or controller sticks/pedals).
- Non-standard gamepads count as a wheel when **Wheel** is selected as your active device. Older laps uploaded before input tracking existed display no icon.

### Physics and circuit version updates

- Whenever a physics update meaningfully alters lap times, the physics version increments and fresh boards open. New uploads are only accepted on the current version.
- Historical boards remain browsable via the version picker on every board (for example, **Physics V2 (New)** alongside **Physics V1**).
- Submitting a lap from a stale tab left open across an update returns `"This lap is from an older version of the physics or the circuit. Reload the game to drive on the new one"`.
- Changes to a specific circuit (kerbs, walls, track limits, or surface grip) can reset that circuit's boards independently without bumping the global physics version; its previous board remains accessible in the picker.
- Ghosts, personal bests, and weekly challenge entries follow the same versioning rules.

### Recovering unposted bests

- If the leaderboard server is temporarily unreachable, the game queues your lap and retries automatically once connectivity returns (up to 5 attempts per session, and again after a reload if the queued lap is your saved personal best). Laps explicitly rejected by the server are not retried automatically.
- Under **Lap times > Your best laps**, any local best missing from the online board is flagged with `"Not on the online board yet"` (**Post**) or `"Not on the online board"` with the rejection reason (**Retry**), including laps set with auto-upload off or before online boards launched.

## Time trials and weekly challenge

The **Time Trials** view pairs the rotating **Weekly challenge** with permanent time trials. Every time trial standardizes track and car conditions: dry, fully rubbered-in asphalt (no marbles or rain wash-off), the car's softest dry tyre compound (such as soft slicks, street tyres on the Liana/Scirocco, or vintage slicks/slicks on historic cars), and the car's minimum permitted fuel load with fuel burn disabled (`"Dry track · Soft tyres · Low fuel"` on most cars). Clicking **Drive challenge** (after confirming your driver name if you still have a generated one) applies those rules automatically and restores your personal assists, realism, and weather settings afterward.

### Rotating weekly challenge

- **Schedule:** Weeks run from **Monday 00:00 UTC** to the next Monday (`YYYY-Www` ISO week IDs), following a curated 48-week rotation through the week of **4 October 2027** before looping.
- **Fixed rules per week:** Every driver runs the same circuit, car, assists, and realism preset. Every fourth week enforces **Pro** assists with **Full** realism; all other weeks use **Semi** assists with **Standard** realism.
- **Dual board posting:** Valid weekly challenge laps post to both the dedicated weekly board (**This week's times**, with physics version picker) and the circuit's regular open board. Laps only qualify for the weekly board if driven under that week's rules and uploaded before the week closes; late uploads still post to the open board.
- **Custom setups:** Garage setups remain open on the weekly challenge (only fuel load and tyre compound are locked).

### Middle Gear Lap Board

- **Permanent benchmark:** Always active (`event: "middle-gear"`) in the **Suzuki Liana 1.6** around **Dunsfold Aerodrome**.
- **Fixed factory setup:** Unlike the rotating weekly challenge, Middle Gear locks chassis and tyre setup to the factory baseline (with lowest fuel), **Semi** assists, and **Standard** realism so every driver runs an identical car.
- **`S.T.I.G.` badge:** Middle Gear never expires and does not award rotating weekly medals. Instead, whoever holds **P1** on the current shipping physics revision wears the live **`S.T.I.G.`** badge everywhere on the boards; the badge moves automatically as soon as someone beats the record.

### Ghosts, setups, and lap telemetry

- **Racing ghosts:** Your personal best ghost can be toggled in Settings, and clicking **Race ghost** on any row of an open or time-trial board for your loaded circuit loads that driver's recorded lap onto the track. You can also export and import `.json` ghost files from the lap summary card or pause menu (**Lap times**).
- **Applying setups:** Every uploaded lap embeds its car setup (minus setup name and fuel load). Clicking **Apply setup** on a row for your current car loads that exact setup directly into your Garage (disabled on fixed-setup trials).
- **Driver profiles and telemetry analysis:** Click any driver on a board to open their **Driver Profile** (best laps, rankings, and cross-circuit ratings), and use the built-in **Lap telemetry analysis** view to compare speed, pedal traces, and sector splits against another lap.

### Hall of Fame and driver badges

- **Weekly medals:** Once a week finishes, P1, P2, and P3 earn **Gold**, **Silver**, and **Bronze** weekly medals (recorded per named physics version such as Physics V1 and V2, so medals survive across physics updates).
- **`GOAT` badge:** Awarded dynamically to the driver(s) at the top of **Most decorated** (most finished-week golds, then silvers, then bronzes; requires at least one gold; shared on exact ties).
- **`Fastest Lap` record holders:** Holding P1 on a contested open board (at least **5 unique drivers** on an official circuit and shipping physics revision) awards a Fastest Lap record and ranks you in the Hall of Fame overall and by car class.
- **`S.T.I.G.` and `OG` badges:** **`S.T.I.G.`** marks the live Middle Gear P1 holder; **`OG`** marks drivers who posted a lap on Physics V1.

## Public stats

LibreCorsa publishes live and 30-day aggregate statistics at [librecorsa.org/stats](https://librecorsa.org/stats). Everything shown on `/stats` comes from anonymous single-dimension daily totals or public lap board and open-race aggregates; no individual player names, accounts, IP addresses, or cross-tabulated slices are exposed.

The page covers:

- **Overview:** Live tabs currently on `/play` (updated every 30 seconds), all-time hours, laps, countries, and drivers on the boards, alongside 30-day totals.
- **Daily activity:** 30-day daily trends (hours, sessions, laps, countries) and average hours by day of the week.
- **Circuits & cars:** Top active circuits and cars (requiring at least **10 sessions** in the 30-day window), driving-mode shares (`practice`, `time_trial`, `ai_race`, `open_race`, `room_race`), and top 15 countries (`≥ 10` sessions).
- **How people play:** Independent 30-day hour shares by input device (`keyboard`, `controller`, `wheel`, `touch`), device class (`desktop`, `tablet`, `phone`), assists (`pro`, `semi_pro`, `assisted`), and weather (`dry`, `wet`).
- **Boards & races:** Standing lap counts, 30-day board realism/tyre splits, recent weekly challenge participation, and scheduled open-race volume, grid size, and finish rate.

### Public JSON endpoints

Community dashboards and tools can read the same read-only JSON endpoints directly (no authentication required, rate-limited per IP):

| Endpoint | Cache TTL | Query parameters | Returns |
| :-- | :-- | :-- | :-- |
| `GET /api/stats/public` | 1 hour (`3600 s`) | None *(query strings return `400`)* | Full `/stats` payload: `{ ok, days, from, to, allTime, totals, perDay, byCircuit, byCar, byMode, byCountry, extras, boards, races }` |
| `GET /api/stats` | 30 seconds | None | `{ ok, drivers, live }` (all-time verified drivers and live tabs currently on `/play`) |
| `GET /api/stats/totals` | 1 hour (`3600 s`) | None *(query strings return `400`)* | `{ ok, since, hours, laps, countries, drivers }` |
| `GET /api/stats/popular` | 6 hours (`21600 s`) | None *(query strings return `400`)* | `{ ok, days, circuits, cars }` (30-day ranked IDs with `≥ 50` sessions, most hours first, no counts) |
| `GET /api/stats/circuit` | 60 seconds | `track=<id>&vehicle=<id\|all>` (optional `physics` / `version`) | `{ ok, laps, drivers }` for one circuit and car (or all cars) |

All three aggregate endpoints (`/api/stats/public`, `/api/stats/totals`, `/api/stats/popular`) reject query strings so every caller shares a single edge-cached snapshot. `byCircuit`, `byCar`, and `byCountry` in `/api/stats/public` omit entries with fewer than 10 sessions in the 30-day window, and `boards` / `races` / `extras` return `null` on self-hosted instances where those features are disabled.

## Accounts

An account is optional. Without one, the game works as it always has: each browser keeps its own driver key and its own save.

### Signing in

- Sign in under **Settings > Profile and data > Account**, or on the [account page](https://librecorsa.org/account), with Discord, Google, Steam or a passkey. **Create an account with a passkey** needs nothing else.
- The game keeps the id Discord, Google or Steam gives it for you, and nothing else: no email, no user name, no picture. A passkey leaves only its public key.
- The desktop app, and the game added to an iPhone home screen, can't open those sign-in pages. On a device that is signed in, choose **Show a code for another device**, then type the code on the other one under **Use a code from another device**. A code works once, for 10 minutes, and the game shows whose account it joins before it does.
- Adding a second way in while signed in (Google on top of Discord, say) adds it to the account. If that sign-in already had an account of its own, the two become one account, with everything from both.

### Your devices and your names

- After you sign in, a device asks to join the account. Joining brings the names that device's driver key holds into the account.
- From then on, any device on the account posts laps and races under any of its names. Names on an account don't lapse after six months.
- If a name is on another of your accounts, sign in to that one with **Add** to bring the two together.
- The account lists your sign-ins, passkeys and devices, each with **Remove**. A device you remove can no longer post under the account's names. The last way into the account can't be removed.

### Your save

- The account keeps one save for all your devices: your best laps and their ghosts, race history, careers, setups, liveries, your last car and circuit, and the settings that are about you, such as assists, profile, sessions and music.
- Controls, graphics, field of view, the HUD, volumes and the driver key stay on each device.
- When this device and the account both have a save, the game asks: **Combine** (the default), **Use the cloud save** or **Keep this device's save**. Combining keeps both sets of best laps, the faster one where both have the same, both race histories and setup lists, and every career either device has (of the same career, the copy played last).

### Deleting your account

- **Delete account** removes the account with its sign-ins, passkeys, devices and save. Your names go back to the driver keys that hold them, and lapse after six months like any other.
- Tick **Also remove my laps and race results from the boards** to also take your laps and badges off the boards and your name off your race results.

## Sharing a car setup

- Open the **Garage** (see [Garage and car setups](DRIVING.md#garage-and-car-setups)) and click **Share code** to copy a portable `LC1-` setup string for your current configuration. Saved setups also have individual **Copy share code** buttons.
- Click **Import** to open **Paste share code or JSON**, where you can paste an `LC1-` string or click **Load .json** to import a file. Click **Export setup (.json)** to download your current setup.
- Before applying an imported setup, LibreCorsa previews its name, target car, and key changes. Choose **Apply** to load it immediately or **Save & apply** to store it in your saved list as well.
- Importing a setup built for a different car displays `"Built for ..."` and safely clamps chassis offsets, electronics, and tyre values to your current car's valid ranges while preserving your fuel load.
- Every uploaded lap embeds its car setup (stripped of setup name and fuel load), which is what **Apply setup** loads from the leaderboards.

## Data and privacy

See the full [privacy policy](https://librecorsa.org/privacy) for complete details. Specifically for online racing and leaderboards:

- A posted lap stores your driver name and code, the lap (times, circuit, car, assists, realism, tyre, and whether it was driven on a keyboard, controller, wheel or touch screen) and a recording others can race as a ghost. Names and laps on a board are public. The board also stores a scrambled form of your driver key, which can't be turned back into the key.
- An open race stores its result: the name you raced under, your place, times and best lap.
- To limit uploads, a scrambled form of your IP address is kept for up to two hours. The site's database stores no IP address.
- An account keeps the id each of its sign-ins gives it, its passkeys' public keys, what each device called itself when it joined (like "Chrome on macOS"), and your save. It never has your email or user name. Delete it from the account page or in the game at any time.
- To see what is stored under your name, or to have your name, laps and race results deleted, email me at contact@alpyalay.org or open an issue on GitHub. Tell me the driver name, and I'll ask you to confirm it's yours.
