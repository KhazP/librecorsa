# Driving, setups, weather, and 2026 rules

LibreCorsa models tyre thermodynamics, standing water and aquaplaning, evolving track rubber, FIA 2026 active aerodynamics and hybrid deployment, and class-specific garage setups on top of its 500 Hz rigid-body simulation.

## Realism levels

Choose your realism level in the session menu or under **Driving**. All races are sprints: cars carry their chosen fuel load as fixed ballast and do not burn fuel at any realism level.

| Level | Tyre wear & flat-spotting | Tyre temperature grip loss | Wet-weather severity | Cold garage starts |
| :-- | :-- | :-- | :-- | :-- |
| **Casual** | Off (`0%`) | `25%` of full thermal loss | `50%` | Off (always starts warm) |
| **Standard** | On (`100%`) | `50%` of full thermal loss | `75%` | Off (always starts warm) |
| **Full** (default) | On (`100%`) | `100%` (full thermal model) | `100%` | On for non-blanket cars |

Under **Full** realism, cars whose regulations do not use tyre blankets leave the garage on cold tyres and cold brakes. Standing and rolling race starts follow a formation lap, so tyres and brakes start warm on the grid.

## Tyres, temperatures, and wet grip

Each tyre evaluates grip across three lateral tread strips (inner, middle, outer) driven by vertical load, tread surface/bulk/carcass temperature, hot inflation pressure, camber, wear, and water film depth.

### Compounds and water-clearing capacity

| Compound | Dry grip (vs. slick) | Wet film grip | Water cleared at 200 km/h | Initial groove depth | Working window shift | Dry wear / heat penalty |
| :-- | --: | --: | --: | --: | --: | :-- |
| **Slicks** (Soft / Medium / Hard) | `100%` | `54%` | `0.42 mm` | `0 mm` | Baseline | `1.0×` wear · `1.0×` heat |
| **Intermediate** | `90%` | `78%` | `1.25 mm` | `2.5 mm` | `-30 °C` (F1 peak `75 °C`) | `3.0×` wear · `1.35×` heat |
| **Full wet** | `82%` | `79%` | `2.65 mm` | `5.5 mm` | `-42 °C` (F1 peak `70 °C`) | `4.0×` wear · `1.50×` heat |

Key wet-tyre behaviours on track:

- **Water thresholds:** The track transitions from **Damp** (`> 0.08 mm`) to **Wet** (`> 0.5 mm`) to **Standing water** (`> 1.5 mm`). As a rule of thumb, the game's tyre calls put intermediates on above `0.2 mm` of water on the racing line, and full wets above `1.15 mm`.
- **Aquaplaning and tread wear:** Every tyre clears more water at lower speed (the contact patch has longer to drain) and less as speed rises. Once water depth exceeds a tyre's clearing capacity, it rides up onto the film and loses up to 80% of its grip. Worn rain grooves lose up to 55% of their water-clearing capacity.
- **Steering feel in standing water:** Before full aquaplaning begins, a hydrodynamic water wedge builds at the leading edge of the contact patch, shortening pneumatic trail and lightening steering self-aligning torque in your wheel. Above `0.6 mm` of water, rolling drag through puddles also creates asymmetric pull if one side of the car hits deeper water.
- **Dry track penalty on rain tyres:** Running intermediates or full wets on drying asphalt overheats the soft silica blocks and accelerates tread wear (`3×`–`4×`) until you find damp off-line patches or pit for slicks.
- **Tyre blankets:** Cars that race with blankets pre-heat tyres (up to `80 °C` depending on compound) before leaving the garage; you can toggle **Tyre blankets** directly in the Garage's **Tyres** tab.

## Weather and dynamic track evolution

### Weather and time of day

- **Weather presets:** `Clear`, `Overcast`, `Light rain`, `Heavy rain`, `Drying`, and `Dynamic` (deterministic from the session seed so multiplayer clients experience identical weather transitions). Sessions also support 5-node scripted weather schedules (`Start`, `25%`, `50%`, `75%`, `Finish`) spanning 11 sky cover states from `Clear` to `Overcast storm`, with ambient temperature, humidity, and 8-point compass wind.
- **Time of day:** Seven presets (`Dawn`, `Morning`, `Noon`, `Afternoon`, `Golden hour`, `Dusk`, and `Night`) with clock multipliers of `0×` (frozen sun, weather still advances in real time), `1×`, `5×`, `15×`, and `60×`. Circuits flagged as night venues (such as Qiddiya Speed Park) start at night automatically unless you explicitly choose another time.

### Surface grip, marbles, and the wet line

The road surface is tracked across 64 sectors around the lap:

- **Starting rubber presets:** `Green` (`8%` rubber), `Light` (`30%`), `Medium` (`50%`), `Natural` (`65%`, default), `Heavy` (`80%`), and `Saturated` (`95%`), with progression rates of `0×` (static), `0.5×`, `1×`, `2×`, and `5×`. Time trials and the weekly challenge lock the track to fully rubbered-in dry grip with no marbles or wash-off.
- **Rubber buildup and marbles:** Cars driving on-line lay rubber into the racing groove, increasing dry grip, while shedding rubber marbles off-line that reduce off-line grip and temporarily coat tyres if you run wide.
- **Rain wash-off and drying line:** Heavy rain gradually rinses rubber back down toward `35%`. When rain eases, cars squeeze water out of the racing line first, creating a visibly darker, higher-grip dry ribbon before the rest of the asphalt drains.
- **Wet groove inversion ("the wet line"):** Once track wetness exceeds `0.18`, polished rubber laid along the dry racing line seals the asphalt pores and becomes *slicker* than unrubbered tarmac beside it, rewarding wider wet-line entries and exits in the rain.

## 2026 F1 active aero and hybrid rules

Open-wheel cars follow era-appropriate overtaking rules based on their model year:

- **2026 onward (`straight-mode-2026`):** Active aero **Straight Mode** plus **Overtake Mode** hybrid deployment (`lc26`, `f12026-car`).
- **2011–2025 (`drs-rear`):** Traditional rear-flap DRS inside DRS zones only (`lc25`, which also models 2025 MGU-H and ground-effect ride-height maps): free in practice, and in races restricted to cars within `1.0 s` at the detection point after the leader completes 2 laps.
- **Pre-2011 (`none`):** Fixed wings; flaps stay closed.

### Active aero: Z-Mode and X-Mode (Straight Mode)

On 2026 cars, pressing the **Active aero** button (`X` on keyboard, `Y` / `△` on controller) switches between **Z-Mode** (high downforce for cornering) and **X-Mode** (low-drag Straight Mode):

- **Where flaps open:** Both front and rear wing flaps open on every designated straight at least `250 m` long (radius `≥ 800 m`, bridging gentle kinks up to `100 m` long with radius `≥ 500 m`) with **no gap requirement** to the car ahead.
- **Pre-queueing:** A HUD notice appears `150 m` before a straight-mode zone. Pressing the flap button up to `250 m` before the zone queues activation (held for up to `12 s`) and opens the flaps the instant you cross the activation line.
- **Low Grip Conditions and wet lockout:** When racing-line water exceeds `0.2 mm`, race control declares **Low Grip Conditions** (cleared once water falls below `0.08 mm`). Under Low Grip Conditions, rear flaps stay locked out above `0.25` wetness, only the **front flaps** open, and activation zones shift `50 m` further down the straight. Under open-wheel race rules, local yellow-flag zones also lock out flaps and Overtake Mode.

### 350 kW MGU-K, 4 MJ battery, and Overtake Mode

The 2026 power unit pairs a 1.6 L V6 turbo with a `350 kW` MGU-K, a `4 MJ` usable battery state-of-charge window, and an `8.5 MJ` per-lap recharge limit (with full-throttle superclipping up to `350 kW` at the end of long straights). From a standing start, MGU-K deployment unlocks once the car reaches `50 km/h`. Power delivery follows the FIA 2026 speed taper rules:

- **Standard deployment:** Delivers up to `350 kW` up to `290 km/h`, tapers linearly down to `100 kW` at `340 km/h`, and ramps to `0 kW` at `345 km/h`. In races on circuits with designated `250 kW` power-limited sectors, electrical output caps at `250 kW` up to `310 km/h` before tapering to `0 kW` at `345 km/h`.
- **Overtake Mode (`Z` on keyboard; Automatic Overtake on by default):** Holds full `350 kW` deployment all the way to `337.5 km/h` before tapering to `0 kW` at `355 km/h`, and increases the lap's energy harvest allowance by **`+0.5 MJ`** (to `9.0 MJ`).
- **Boost (`Space` / `Shift` hold, or `B` latch):** Overrides automatic energy-management cuts and superclipping to deploy or hold MGU-K power on demand. In a race, Boost is capped at the car's current power at activation or `150 kW` (whichever is higher); under **Low Grip Conditions**, Boost only holds current deployment without raising it.
- **Low-speed street circuits (Rev 1 curves, e.g., Monaco):** Standard deployment tapers from `350 kW` at `200 km/h` to `0 kW` at `300 km/h`; Overtake Mode tapers more gently from `200 km/h` to `150 kW` at `300 km/h` and `0 kW` at `310 km/h`.
- **Earning Overtake Mode in a race:** Cross the circuit's Overtake Detection Line within `1.0 s` of the car directly ahead on track (lapped cars included) to unlock Overtake Mode from the Activation Line through the entire following lap. In practice and qualifying, Overtake Mode is available freely at any time.

## Garage and car setups

Open the **Garage** from the menu or pause screen to tune your car, save named setups, or exchange setups via `LC1-` share codes and `.json` files (see [Sharing a car setup](ONLINE.md#sharing-a-car-setup)). Every car uses one of two class setup sheets anchored to that car's real physical baseline:

### F1 setup sheet (`lc26`, `lc25`, `f12026-car`, and F1 mods)

| Tab | Adjustable parameters |
| :-- | :-- |
| **Aerodynamics** | Aero package selector, front wing (`0`–`50`), rear wing (`0`–`50`) |
| **Transmission** | On-throttle diff (`1`–`12`), off-throttle diff (`1`–`12`), engine braking (`50%`–`100%`) |
| **Suspension geometry** | Front & rear camber, front toe (`-0.50°` to `+0.30°`), rear toe (`-0.10°` to `+0.50°`) |
| **Suspension** | Front & rear springs (`1`–`41`), front & rear anti-roll bars (`1`–`21`), front & rear ride height (mm) |
| **Dampers** | Slow & fast bump and rebound dampers (front & rear) |
| **Brakes** | Brake pressure (`80%`–`100%`), front brake bias (`50%`–`70%`), brake migration (`0%`–`6%`) |
| **Tyres** | Compound selector, live tyre readouts, tyre blankets toggle, cold tyre pressures (psi) |
| **Electronics** | Starting assists and electronic tuning dials |
| **Fuel** | Starting fuel ballast (kg) |

### GT3 and closed-wheel setup sheet (GT3, prototypes, classics, road cars)

Closed-wheel cars share a unified sheet that automatically exposes only the hardware each car actually has (for example, wings and aero packages appear only on winged cars, third/heave springs appear only on prototypes equipped with heave elements, and gear sets appear only on cars with selectable ratios):

| Tab | Adjustable parameters |
| :-- | :-- |
| **Tyres** | Compound selector, live tyre readouts, tyre blankets toggle, cold pressures (psi), front & rear toe, front & rear camber |
| **Electronics** | Starting ABS, TC, and slip-angle traction dials (where fitted) |
| **Mechanical grip** | Front & rear ARBs (`1`–`21`, plus `0` = Detached where supported), brake power (`80%`–`100%`), brake bias, brake-by-wire migration (where fitted), engine braking (where fitted), steering ratio, wheel rates (N/mm), bump-stop rates & ranges, corner packers (mm), diff preload (Nm), and gear ratio set (where fitted) |
| **Third elements** *(prototypes with heave springs)* | Front & rear third springs, third packers (mm), and slow/fast third bump & rebound dampers |
| **Dampers** | Slow & fast bump and rebound dampers (front & rear) |
| **Aero** | Aero package & rear wing clicks (`0`–`10`, winged cars only), front & rear ride height (mm), front & rear brake ducts (`0`–`6`), radiator opening (`1`–`7`, where fitted) |
| **Fuel** | Starting fuel ballast (litres and kg) |

You can also adjust live in-car dials on track, such as brake bias and the differential's `entry`, `mid` and `exit` settings, through the **MFD** (`O` to toggle, `I` or `Insert` to cycle pages).

## Race starts, pit stops, and Virtual Safety Car

- **Standing starts:** Under **Assisted** launch, the car is held on the grid until lights out. Under **Manual** launch, hold the clutch and target launch revs through the lights and release at lights out; your reaction time is measured on launch, and moving early triggers a `+5 s` or `+10 s` jump-start penalty.
- **Rolling starts:** An automatic formation speed limiter holds pace (~`65 km/h`) while preserving full braking, paired with a live rolling-start pace bar across every HUD (`slow` / `hold` / `fast`), a `"GET READY"` notice, and a `3-2-1` countdown as the leader approaches the start/finish line.
- **Pit stops:** Circuits with a pit lane support full pit stops in practice, AI races, and Career mode. The pit speed limiter (`\`) engages automatically inside the speed-limit zone (speeding draws a `+5 s` penalty). Use the MFD **Pit** page (`O` / `I` on keyboard, or controller D-pad) to pick your next tyre compound and toggle damage repairs. Stopping on the same compound still fits a fresh set of tyres, and mandatory pit stops can be required in race setup and career series.
- **Virtual Safety Car (VSC):** In AI races, retired cars on track or persistent double-yellow hazards automatically trigger a VSC. Every car paces to ~`65%` of its own racing speed (`65`–`216 km/h`) against a live delta with overtaking and aero/overtake aids locked out; sustained speeding draws a `+5 s` penalty, and green resumes `10`–`15 s` after `"VSC ending"`.

## Career mode

Career mode is a merit-based championship progression across two separate disciplines, each with its own ladder, regional calendars, persistent AI rivals, test days, bonus objectives, and season-by-season promotion. There is no in-game currency, budget, or contract negotiation system — finishing inside a series' promotion places unlocks the next tier directly.

### Disciplines and progression ladders

Every series uses circuits with pit lanes. In two-car series (**GT3** and **Can-Am Legends**), you choose your car in pre-season and the entire AI field races that same car. Regional tiers offer separate **Americas**, **Europe**, and **Asia-Pacific** calendars.

#### Road ladder

| Tier | Series | Region | Car(s) | Default grid | Full distance | Promotion cutoff | Mandatory pit stops |
| :-- | :-- | :-- | :-- | --: | --: | :-- | :-- |
| **0** | **Club Cup** | Americas / Europe / Asia-Pacific | Suzuki Liana 1.6 | 8 | 40 km | Top 3 | None |
| **0** | **Coupé Cup** | Americas / Europe / Asia-Pacific | VW Scirocco GTX 16V | 8 | 40 km | Top 3 | None |
| **1** | **Touring Cup** | Americas / Europe / Asia-Pacific | Nissan R32 JTCC | 8 | 60 km | Top 3 | None |
| **2** | **Classic GT** | Global | Nissan R33 JGTC | 10 | 90 km | Top 4 | 1 stop on Long / Full |
| **2** | **Prototype Cup** | Global | MTRacing 496R | 10 | 80 km | Top 4 | 1 stop on Long / Full |
| **3** | **GT3** | Americas / Europe / Asia-Pacific | BMW M4 GT3 Evo or Mercedes-AMG GT3 Evo | 10 | 120 km | Top 4 | 1 stop on Medium / Long / Full |
| **4** | **Endurance Prototypes** | Global | LC-LMDH | 10 | 240 km | Top 4 | 1 stop on Short / Medium; 2 on Long / Full |
| **5** *(Final)* | **Grand Prix** | Global | LC26 Prototype | 12 | 305 km | Top 3 | 1 stop on Medium / Long / Full |

Both **Club Cup** and **Coupé Cup** promote into **Touring Cup**, which branches into **Classic GT** (leading to **GT3**) or **Prototype Cup** (which opens both **GT3** and direct entry into **Endurance Prototypes**).

#### Historic ladder

| Tier | Series | Car(s) | Default grid | Full distance | Promotion cutoff | Mandatory pit stops |
| :-- | :-- | :-- | --: | --: | :-- | :-- |
| **0** | **Procar Series** | BMW M1 Procar | 8 | 60 km | Top 3 | None |
| **1** | **Group 4 Classic** | Porsche 934 Turbo RSR | 10 | 100 km | Top 4 | 1 stop on Long / Full |
| **2** *(Final)* | **Can-Am Legends** | Chaparral 2D or Chaparral 2D 427 | 10 | 150 km | Top 3 | 1 stop on Long / Full |

Mandatory pit stops are capped by race lap count so the field has room to spread its stops: a race needs at least **5 laps** for 1 mandatory stop and at least **8 laps** for 2 stops.

### Season setup, race settings, and weather

Each season starts in **pre-season**. Until you click to start the season, you can switch freely among any unlocked series at your current tier (for example, changing region or switching between Club Cup and Coupé Cup at Tier 0) and configure the settings that lock once round 1 opens:

- **Locked at season start:** Series, car (in two-car series), **Season length** (`Short` 40%, `Medium` 60% default, `Long` 80%, `Full` 100% of the calendar, minimum 3 rounds), custom circuit picks from the series calendar, **Grid size** (`4`–`12`, up to the series default), and **Mulligans** (`0`–`6`, default `3`).
- **Adjustable before any round:**
  - **Race length:** `Short` (`25%`, default), `Medium` (`50%`), `Long` (`75%`), or `Full` (`100%`) of the series' full race distance (clamped to `3`–`60` laps).
  - **AI level:** `Low` (`-16` skill), `Medium` (`-8`), `High` (series baseline), or **`Expert`** (`+7`, default for new careers).
  - **Damage:** `Off`, `Reduced` (default), or `Full`.
  - **Qualifying:** `Off`, `3`, `5` (default), or `10` minutes, with free flying-lap restarts and **End qualifying** in the pause menu. If qualifying is turned off, you start from the back of the grid.

Round weather and time of day are seeded deterministically from your career seed so re-running a round keeps identical conditions: most rounds are clear daytime sessions, **Touring Cup**, **GT3**, **Endurance Prototypes**, and **Grand Prix** also include occasional overcast or light-rain rounds, and night circuits always run at night.

### Test days

Before starting a season (on round 1's circuit) or before any upcoming round, you can launch an optional **Test day** in that season's car. Test days track total laps completed and your best clean lap against a **promotion-pace target lap** — computed from the qualifying pace of the AI rival occupying the last promotion spot at your current AI difficulty. Test-day results stay saved on the season per circuit and car.

### Points, persistent rivals, and promotion

- **Championship points:** Top-10 F1 scale (`25, 18, 15, 12, 10, 8, 6, 4, 2, 1`; DNFs and disqualifications score `0`). Ties break by wins, then podiums, then best single race finish.
- **Persistent rivals:** Starting a career generates a pool of **48 fictional AI drivers**, each with their own pace rating, aggression, consistency, race number, and three-letter code (never clashing with your own code). When you earn promotion, up to **3 top-finishing rivals** are promoted alongside you into the next tier.
- **Promotion, retries, and career end:** Promotion places scale proportionally if you reduce grid size. Finishing inside the promotion cutoff unlocks the next tier's series; earning promotion in the final series (**Grand Prix** or **Can-Am Legends**) completes the career. Missing promotion starts another attempt in the same series (up to **3 attempts** total); missing promotion three times in one series ends the career.

### Mulligans, bonus objectives, and career score

- **Mulligans:** Restarting a round or retiring early spends a mulligan to race the round again without recording a result. Leaving an active career round (including closing the tab mid-race) settles the round on your next visit as a mulligan if one remains, or as a retirement (DNF, last place, `0` points, with the field simulated) if none are left. Allowing fewer mulligans earns a season score bonus (`(6 − allowed) × 300`).
- **Bonus objectives:** Starting a season draws **3 objectives** from distinct skill categories (qualifying pace, finishing/consistency, leading laps or fastest lap, and clean races or ≥ 90% lap completion; qualifying objectives are excluded when qualifying is off).
- **Career score:** Every race awards points for finishing position, grid spot, laps led, lap completion, clean driving (`0 s` penalty full bonus; `≤ 3 s` partial), and podium finishes, multiplied by a challenge multiplier combining **AI level** (`8` / `14` / `20` / `26`), **Damage** (`0` / `1` / `3`), and **Race length** (`0` / `2` / `4` / `6`). At season end, your championship position, points, completed bonus objectives (`2,000` each), first-attempt promotion bonus (`10,000`), and mulligan bonus are added and multiplied by an attempt multiplier (`6×` on attempt 1, `5×` on attempt 2, `4×` on attempt 3).

### Saving and resuming

You can maintain multiple active careers at once (across both Road and Historic ladders). Progress saves automatically in your browser (`librecorsa.career`) after every setting change, test day, round start, and race finish, and syncs across devices when signed in to an optional [account](ONLINE.md#accounts). Completed seasons are stored in your career's **History** tab with full round results, standings, objectives, and score breakdowns.

## Cameras, HUD, replay, and voice spotter

- **Cameras:** The default driving camera is **T-Cam (`tv_pod`)**. Press `C` to cycle driving views (`F7` for free camera, `F8` for trackside TV camera), or hold `C` (or press `Alt` + arrow keys) to adjust cockpit seating.
- **HUD layouts:** 15 layouts ship out of the box with **Blade** as the default (including a bottom-left live input trace when no force-feedback wheel is active) plus a layout editor to move, resize, or hide widgets. Career pre-race shows, offline AI full-screen podiums, and broadcast event cards can each be toggled under **Settings > Display > HUD**.
- **Instant replay and Flashback:** Press `T` to open instant replay. In offline sessions, press `F` (or click **Flashback**) inside replay to rewind and resume driving from that moment (which invalidates the current lap in practice and time trials).
- **Voice spotter:** Off by default under **Settings > Audio**. When enabled, it calls cars alongside (`"car left"`, `"car right"`, `"three wide"`, `"still there"`, `"clear"`) using three **Kokoro-82M** (Apache-2.0) voices (**George**, **Emma**, and **Adam**) with an optional pit-wall radio filter.
