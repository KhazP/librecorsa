# Racing online and the lap boards

LibreCorsa has four online parts: private rooms for racing friends, open races that start every 20 minutes, lap boards with a weekly challenge, and optional accounts that keep your names and your save on all your devices. On librecorsa.org they run on the site's own server. A copy of the game without that server still has peer-to-peer rooms, paired through the public PeerJS service, and keeps your lap times in your browser.

## Your driver

- Rooms and races show your name, a three-letter code and a colour. The boards show the name and code. A new player gets a random name, such as Apex Falcon 27 with the code FAL.
- Change them under **Settings > Profile and data > Driver**: **Name** (up to 16 characters), **Code** (three letters) and **Colour**.
- The boards refuse slurs, profanity and names that pass for the game's own. The game tells you "Pick another name".

## Private rooms

### Hosting and joining

- Open **Multiplayer** from the main menu, or from the pause menu while you drive.
- **Host a room** gives you a six-character room code, made of letters and digits without I, O, 0 or 1. **Copy invite link** copies a link to the room, and **Share** opens your device's share sheet where it has one. **New room** opens another room with a fresh code.
- To join, type the code under **Join a friend's room** and press **Join**. Or open the host's invite link: the game joins the room once you're past the loading screen.
- The host has to keep the game open. If the game can't find a room, it asks you to check the code and to ask the host to keep the game open on screen.
- On librecorsa.org a room takes the host and up to 15 guests. If the host's connection drops, their game opens the room again under the same code.
- Everyone needs the same version of the game. A player on another version sees "This room runs another version of LibreCorsa. Everyone in it needs to reload the page."
- There are no races on a hill climb, since a run is one car at a time.

### The lobby

- The **Drivers** card lists everyone with their code, name and car, the **Host** badge, and **Ready** or **Not ready**. Beside other players it shows the ping and the packet loss.
- On another circuit than the host's, you see "The host is on" that circuit, with **Switch circuit**. If your car isn't in the room's class, the game lists the cars that are, and the others see **Wrong class** beside your name.
- Guests press **Ready up**. The host presses **Start race**. With qualifying on, that button starts qualifying instead (**Start 5 min qualifying**, for example), and during qualifying **Start race now** cuts it short.
- **End qualifying** and **End race for everyone** send every driver back to the lobby. The host's settings are locked while qualifying or a race runs.
- When the race ends, the host's game sends one result to everyone. Nothing from a room is stored.

### What the host sets

| Card | Setting | Choices |
|---|---|---|
| Event | **Circuit** | Picked with **Change** from the main menu |
| Event | **Cars** | **Any car** (classes mixed) or one class |
| Event | **Weather**, **Time of day**, **Time speed** | The presets; time speed is **Fixed** or a multiple |
| Race | **Laps** | 1 to 50 |
| Race | **Qualifying** | **Off**, 3, 5 or 10 min: the best clean lap sets the grid |
| Race | **Grid order** | **Qualifying**, **Reverse** or **Random** (set by qualifying when it is on) |
| Race | **Start** | **Standing** or **Rolling** |
| Race | **Launch** | **Assisted** or **Manual**, for a standing start only |
| Rules | **Rules** | **Classic**, **Auto**, **Open-wheel** or **Endurance** |
| Rules | **Track limits** | **On** or **Off** |
| Rules | **Penalties** | On or off: time added for track limits and jump starts |
| Rules | **Damage** | **Off**, **Reduced** or **Full** |
| Rules | **Collisions** | **On**, **Ghosted lap 1** (no contact on the opening lap) or **Off** |

Under **Classic**, every third track-limits strike is +3 s, then +5 s. **Open-wheel** counts strikes (4 is +5 s, 8 is +10 s, 12 is a disqualification) and **Endurance** weighted points (5 is +5 s, 10 is +10 s, 15 is a disqualification). **Auto** uses open-wheel rules for single-seaters and endurance rules for the rest.

### How players connect

- The site's room server pairs the players of a room code. After that the cars go straight between your browsers, 60 times a second.
- Guests connect to the host, and the host passes each car on to the others. The **Relayed** badge beside a driver means their car reaches you through the host.
- Some networks block a direct link (strict routers, mobile data). For those, the room server hands out relay servers run by Cloudflare. If a link still fails, the game suggests trying again, or using the same Wi-Fi.
- A car that hasn't been heard from for half a second turns see-through and can't be touched. After two seconds it disappears until it is heard from again.
- Under **More ways to connect**:
  - **Local tabs**: **Connect local tab** races another tab in the same browser.
  - **Manual WebRTC**: no server at all. The host presses **1. Create offer (host)** and sends the token, the guest pastes it into **Remote token** and presses **2. Accept offer**, and the host pastes the guest's answer and presses **3. Accept answer (host)**.
  - **Custom TURN relay**: your own relay server. The **Relay address** must start with `turn:` or `turns:`, with a **Username** and **Password** if it needs them.

## Open races

### Joining

- Under **Multiplayer** on the main menu, a card named after the week's circuit counts down to the next race. It shows the car, the laps and how often a race starts.
- A race starts every 20 minutes, on the weekly challenge's circuit and car, for whoever has joined. The laps are set so a race lasts about ten minutes, and never fewer than three.
- In a week whose challenge is at Dunsfold (time trials only), the races are on RISE Motordrome's Grand Prix layout in the 2026 Prototype.
- Press **Join next race**. Before you join, the card shows how many drivers are waiting and some of their names. Once you're in, **Leave race** takes you out.
- Entries close 15 seconds before the lights: join later and you're in the next race. A race takes up to 16 cars.

### The start and the result

- Ten seconds before the lights, the grid is set. The fastest driver on this week's challenge board starts on pole, and drivers with no time there line up behind in the order they joined. If nobody else joins, you race the AI.
- The game puts you in the race's car, with the week's assists and realism and a dry track. Five red lights come on a second apart, and they go out after a random hold.
- Collisions are **Protected**: cars are ghosts on the opening lap. After it, a car that is stopped or crawling, going the wrong way, off the track or ramming another passes through the others. In every online race, a car that has taken the flag neither gives nor takes contact.
- If your connection drops, the game tries a few times to get you back in. Only a car on the grid can rejoin a race under way.
- Each car reports its finish. The result is final once the whole grid is in, or 90 seconds after the first car finishes.
- The card shows **This week's top drivers** (the top five by wins, then podiums) and your own line: races, wins, podiums and best finish.
- A result counts for your name only when your game proved the name with its driver key, so it needs a name you have claimed on the lap boards.

## The lap boards

### Reading a board

- Open **Lap times** from the main menu or the pause menu. The home page shows the same boards.
- There is one board per circuit and car. Every driver appears once, with their fastest lap and how it was driven: realism (**Full**, **Standard** or **Casual**), assists (**Pro**, **Semi** or **Assisted**), **Wet** for a wet line, and an icon for the input.
- **My car** shows the board of the car you're driving, **All cars** every driver's fastest lap in any car. **Filters** narrows it to **No assists**, **Full realism** or **Wet laps**. A page holds 20 places, and **Jump to me** goes to yours.
- **Race ghost** races any lap on the circuit you have loaded. **Apply setup** loads the setup a lap was driven with, on rows in the car you're driving.

### How a lap gets on

- Laps go up from **Drive** (practice) and the weekly challenge. Laps in a race, and in qualifying for an AI race, don't.
- A valid lap that beats your best on its board goes up by itself, under your name. So does your best lap of the week's challenge. **Auto-upload best laps** in **Settings > Profile and data > Driver** turns this off.
- With it off, the lap card has **Post online**. After a failed upload it has **Retry upload**.
- A lap keeps the most-aided assists and the least realistic level you used during it, and counts as wet if it met any wet surface.
- The board keeps one lap per driver for each mix of assists, realism and dry or wet. That way the filters still show everyone's best of that kind.
- The board takes up to 30 uploads and name changes an hour from one IP address.

### What makes a lap invalid

Outside a race the rule is strict:

- All four wheels off the track deletes the lap at once, with no way to give the time back. Off in the last sector deletes the next lap too, since it gave you a run onto the straight. A restart clears that.
- Jumping round the lap off its road is a course cut: "Course cut · lap deleted".
- Riding a barrier deletes the lap ("Wall contact · lap deleted"). A brush off a barrier doesn't. On a hill climb any touch ends the run.
- A lap the autopilot drove any part of is shown but never ranks.

The lap card says **Invalid: track limits** or **Invalid: wall contact**. The board then checks every upload. The lap must end where it started (except on a hill climb), and its sector times must add up to the lap time. The time must match the recording, and the recorded speeds must match the distance driven. Nothing may go over 420 km/h or jump from place to place, and the lap must be on the current physics.

These checks stop careless fakes, such as a short time pasted onto a real recording. They can't prove a lap was driven, and a lap built with care can pass them. Fake lap times are a known limit of the boards. If you see a cheated entry, open an issue on [GitHub](https://github.com/librecorsa/librecorsa/issues).

### Your name and the driver key

- The first lap you post claims your name with your driver key, a random code kept in your browser. Later laps under that name, ignoring case and extra spaces, need the same key.
- Without it the board answers "This name is taken. Sign in to the account that holds it, import your driver key under Lap Times, or race under another name".
- With an account, every device that joined it posts under its names (see [Accounts](#accounts)).
- To use your name in another browser, save the key to a file: **Settings > Profile and data > Data**, **Identity key**, **Save**. Then **Load** it in the other browser. **Lap times** has the same pair as **Export key** and **Import key**. Keep the file private.
- **Clear saved data**, or clearing the site's data in your browser, deletes the key. Save it first.
- Renaming (in the settings, or **Rename** on the lap card) moves your laps and race results to the new name and frees the old one. If you already had laps under the new name, the fastest of each kind stays. Ghosts keep the name they were driven under.
- After six months without an upload, someone else can claim the name. The laps left under it are removed when they do. A name on an account doesn't lapse.

### Input icons

- The icon beside a name shows what the lap was driven with: keyboard, controller, wheel or touch screen. Hover over it for "Driven with" and its name.
- A lap keeps the input used most. Only what you actually use counts: on-screen controls you touch, a bound wheel, keys or mouse steering, a pad's pedals or stick.
- A pad without the standard layout counts as a wheel when you have picked **Wheel** as your device. Laps posted before the boards kept the input show no icon.

### When the physics changes

- When I change the physics in a way that makes older lap times incomparable, the physics version goes up and the boards start again. Laps only go on the board of the current version.
- Older boards stay readable as they were, with the picker on every board: **Physics V2 (New)** for the current one, **Physics V1** for the one before.
- A lap from an older version, say from a tab left open across an update, is refused: "This lap is from an older version of the physics or the circuit. Reload the game to drive on the new one".
- A change to one circuit (its kerbs, walls, track limits or surface) can restart that circuit's boards alone, without a new physics version. Its older board stays in the picker.
- Ghosts, personal bests and the weekly challenge go by the same versions.

### A best that didn't go up

- If the board can't be reached, the lap waits and goes up once it answers. In a session the game sends each waiting lap up to five times. After a reload it sends your saved best when that is the lap. A lap the board turns down isn't sent again by itself.
- **Your best laps** in **Lap times** marks a best that isn't on its board: "Not on the online board yet" with **Post**, or "Not on the online board" with the reason and **Retry**. That covers bests set with posting off, or before the boards began.

## The weekly challenge

- **Weekly challenge** on the main menu shows the time left. A week runs from Monday 00:00 UTC to the next. The circuits and cars follow a list of weeks I wrote by hand, up to the week of 4 October 2027, then the list starts again.
- One circuit and car for everyone, with fixed assists and realism: every fourth week **Pro** with **Full** realism, the other weeks **Semi** with **Standard**.
- The track is dry and fully rubbered in, each car runs its softest dry tyre, and the tank holds the lightest fuel load it allows ("Dry track · Soft tyres · Low fuel" for most cars).
- **Drive challenge** sets all of this up and takes you out on track. Your own assists, realism and weather come back afterwards.
- **This week's times** is the challenge's own board, with the same physics picker. A challenge lap also counts on the circuit's open board.
- A lap counts for the challenge only when it was driven to the week's rules. One sent after the week ended goes on the open board only.
- **Hall of Fame** has the **Fastest Lap record holders**, the **Weekly podiums** and the **Most decorated** drivers.

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

- The account keeps one save for all your devices: your best laps and their ghosts, race history, setups, liveries, your last car and circuit, and the settings that are about you, such as assists, profile, sessions and music.
- Controls, graphics, field of view, the HUD, volumes and the driver key stay on each device.
- When this device and the account both have a save, the game asks: **Combine** (the default), **Use the cloud save** or **Keep this device's save**. Combining keeps both sets of best laps, the faster one where both have the same, and both race histories and setup lists.

### Deleting your account

- **Delete account** removes the account with its sign-ins, passkeys, devices and save. Your names go back to the driver keys that hold them, and lapse after six months like any other.
- Tick **Also remove my laps and race results from the boards** to also take your laps and badges off the boards and your name off your race results.

## Sharing a car setup

- In the **Garage**, **Share code** copies a code for your current setup that starts with `LC1-`. Each saved setup has its own **Copy share code** button.
- **Import** opens **Paste share code or JSON**. Paste a code there, or press **Load .json** for a setup file. **Export setup (.json)** saves your current setup as a file.
- Before you apply it, the game shows the setup's name, car and main changes. **Apply** loads it, and **Save & apply** also keeps it in your list.
- A setup built for another car shows "Built for" that car: its chassis offsets, electronics and tyres are clamped to yours. Every value is checked and kept inside your car's limits, and your own fuel load stays.
- Every lap you post carries the setup it was driven with, without its fuel load or name. That is what **Apply setup** loads from a board.

## What the boards keep

The [privacy page](https://librecorsa.org/privacy) has the full list. For the boards and races:

- A posted lap stores your driver name and code, the lap (times, circuit, car, assists, realism, tyre, and whether it was driven on a keyboard, controller, wheel or touch screen) and a recording others can race as a ghost. Names and laps on a board are public. The board also stores a scrambled form of your driver key, which can't be turned back into the key.
- An open race stores its result: the name you raced under, your place, times and best lap.
- To limit uploads, a scrambled form of your IP address is kept for up to two hours. The site's database stores no IP address.
- An account keeps the id each of its sign-ins gives it, its passkeys' public keys, what each device called itself when it joined (like "Chrome on macOS"), and your save. It never has your email or user name. Delete it from the account page or in the game at any time.
- To see what is stored under your name, or to have your name, laps and race results deleted, email me at contact@alpyalay.org or open an issue on GitHub. Tell me the driver name, and I'll ask you to confirm it's yours.
