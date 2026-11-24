# Racing online and lap boards

LibreCorsa includes three connected online features: private peer-to-peer rooms with friends, scheduled open races every 20 minutes, and global lap boards with a weekly challenge.

On `librecorsa.org`, these features are backed by the site's Cloudflare Worker (see [Self-hosting and the online backend](SELF-HOSTING.md) to run your own). Self-hosted copies without that backend still support peer-to-peer private rooms (via the public PeerJS broker) and save personal best laps locally in the browser.

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
| Rules | **Collisions** | **On**, **Ghosted lap 1** (no contact on lap 1), or **Off** |

How the track-limits rule sets score off-track strikes:

- **Classic:** Every third strike incurs a time penalty (`+3 s`, then `+5 s`).
- **Open-wheel:** Counts strikes—4 strikes = `+5 s`, 8 = `+10 s`, 12 = disqualification.
- **Endurance:** Uses weighted severity points—5 points = `+5 s`, 10 = `+10 s`, 15 = disqualification.
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
- When the weekly challenge visits Dunsfold (a time-trial-only venue), open races run at **RISE Motordrome (Grand Prix layout)** in the **2026 Prototype** instead.
- Click **Join next race** to register; the card previews the number of waiting drivers and a sample of their names. Click **Leave race** to withdraw at any time before entry closes.
- Registration locks **15 seconds before lights out** (joining later places you in the following race), with a grid cap of 16 cars.

### Grid, start, and results

- Ten seconds before lights out, the grid locks. Drivers who have posted a time on the current weekly challenge board line up in order of pace, followed by unranked entrants in join order. If no other human drivers join, you race against the AI field.
- Everyone spawns in the scheduled car on a dry track with the week's fixed assists and realism settings. Five red lights illuminate one second apart and extinguish after a random hold.
- Open races enforce **Protected** collisions: all cars are ghosted on lap 1, and from lap 2 onward any car that is stopped, crawling, driving the wrong way, off-track, or attempting to ram passes harmlessly through other cars. Across all online modes, cars that have crossed the finish line also become ghosts.
- If you disconnect mid-race, the client automatically attempts to reconnect; only drivers who started on the grid can rejoin an active race.
- Each car submits its finish time. Official results finalize once every car finishes or 90 seconds after the winner crosses the line.
- The open-races card tracks **This week's top drivers** (top five ranked by wins, then podiums) alongside your personal record (races, wins, podiums, and best finish).
- Results only count toward your standings if your client proves ownership of your driver name with its driver key—meaning you must first claim your name by posting a lap to any leaderboard.

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

Outside of races, track-limits enforcement is strict:

- **Off-track:** Putting all four wheels outside track limits invalidates the lap immediately with no option to give time back. Going off-track in the final sector also invalidates the following lap (to prevent gaining an illegal launch onto the main straight); restarting clears that flag.
- **Course cuts:** Skipping part of the circuit triggers `"Course cut · lap deleted"`.
- **Wall contact:** Grinding or riding a barrier triggers `"Wall contact · lap deleted"` (light glancing brushes are allowed). On hill climbs, any wall contact ends the run.
- **Autopilot:** Any lap where autopilot was engaged at any point is displayed locally but never ranked.

Invalid laps display **Invalid: track limits** or **Invalid: wall contact** on the lap card. Before accepting an upload, the server also validates that the lap starts and ends at the timing line (except hill climbs), sector times sum to the total lap time, the lap time matches the ghost telemetry duration, recorded speeds match distance covered without exceeding `420 km/h` or teleporting, and the lap was set on the current physics version.

> **Honest limitation:** Server checks catch casual tampering—such as pasting a faster lap time onto a genuine ghost—but browser-side telemetry cannot cryptographically prove a lap was genuinely driven. A carefully fabricated payload can still pass validation. If you spot a cheated time on a board, please report it on [GitHub Issues](https://github.com/librecorsa/librecorsa/issues).

### Driver name and identity key

- Your first uploaded lap claims your driver name using a randomly generated **driver key** stored locally in your browser. Future uploads under the same name (case-insensitive, ignoring extra whitespace) must present that matching key.
- Uploading under someone else's claimed name returns `"This name is taken. Import your driver key under Lap Times, or race under another name"`.
- To race under your name on another device or browser, back up the key under **Settings > Profile and data > Data > Identity key > Save**, then **Load** it on the other device (also available as **Export key** and **Import key** inside **Lap times**). Treat this file like a password.
- Running **Clear saved data**—or wiping site storage in your browser—permanently deletes your driver key. Back it up first.
- Changing your name (in Settings or via **Rename** on the lap card) migrates your existing laps and race results to the new name and releases the old one. If you already hold times under the target name, the fastest lap in each category is kept. Ghosts retain the driver name they were recorded under.
- Claimed names expire after **6 months** without an upload; once someone else claims an inactive name, the previous laps under it are cleared.

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
- Under **Lap times > Your best laps**, any local best missing from the online board is flagged with `"Not on the online board yet"` (**Post**) or `"Not on the online board"` with the rejection reason (**Retry**)—including laps set with auto-upload off or before online boards launched.

## Weekly challenge

- The **Weekly challenge** card on the main menu shows the active event and remaining time. Weeks run from **Monday 00:00 UTC** to the next Monday, following a curated schedule through the week of **4 October 2027** before looping.
- Every driver runs the same circuit, car, assists, and realism preset: every fourth week enforces **Pro** assists with **Full** realism; all other weeks use **Semi** assists with **Standard** realism.
- Conditions are standardized: a dry, fully rubbered-in track, the car's softest dry tyre compound, and minimum permitted fuel (`"Dry track · Soft tyres · Low fuel"` for most cars).
- Clicking **Drive challenge** applies these rules automatically and puts you on track; your personal assists, realism, and weather settings are restored afterward.
- **This week's times** displays the challenge's dedicated leaderboard (including the physics version picker), and valid challenge laps also count on the circuit's regular open board.
- Laps only qualify for the weekly challenge if driven under that week's rules and submitted before the week closes; late uploads still post to the regular open board.
- The **Hall of Fame** tracks **Fastest Lap record holders**, **Weekly podiums**, and **Most decorated** drivers.

## Sharing car setups

- Open the **Garage** (see [Garage and car setups](DRIVING.md#garage-and-car-setups)) and click **Share code** to copy a portable `LC1-` setup string for your current configuration. Saved setups also have individual **Copy share code** buttons.
- Click **Import** to open **Paste share code or JSON**, where you can paste an `LC1-` string or click **Load .json** to import a file. Click **Export setup (.json)** to download your current setup.
- Before applying an imported setup, LibreCorsa previews its name, target car, and key changes. Choose **Apply** to load it immediately or **Save & apply** to store it in your saved list as well.
- Importing a setup built for a different car displays `"Built for ..."` and safely clamps chassis offsets, electronics, and tyre values to your current car's valid ranges while preserving your fuel load.
- Every uploaded lap embeds its car setup (stripped of setup name and fuel load), which is what **Apply setup** loads from the leaderboards.

## Data and privacy

See the full [privacy policy](https://librecorsa.org/privacy) for complete details. Specifically for online racing and leaderboards:

- **Posted laps** publicly store your driver name, 3-letter code, lap/sector times, circuit, car, assists, realism, tyre compound, input type, setup parameters, and ghost recording. Your driver key is stored only as a one-way cryptographic hash and cannot be recovered from the database.
- **Open races** store final race results: driver name, finishing position, total race time, and best lap.
- **Rate limiting** keeps a salted hash of your IP address for up to 2 hours; raw IP addresses are never stored in the database.
- **Data access and deletion:** To inspect what is stored under your driver name—or to have your name, laps, and race results deleted—email `contact@alpyalay.org` or open a GitHub issue with your driver name (you will be asked to confirm ownership).
