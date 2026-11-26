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

- **2026 onward (`straight-mode-2026`):** Active aero **Straight Mode** plus **Overtake Mode** hybrid deployment.
- **2011–2025 (`drs-rear`):** Traditional rear-flap DRS inside DRS zones only: free in practice, and in races restricted to cars within `1.0 s` at the detection point after the leader completes 2 laps.
- **Pre-2011 (`none`):** Fixed wings; flaps stay closed.

### Active aero: Z-Mode and X-Mode (Straight Mode)

On 2026 cars, pressing the **Active aero** button (`X` on keyboard, `Y` / `△` on controller) switches between **Z-Mode** (high downforce for cornering) and **X-Mode** (low-drag Straight Mode):

- **Where flaps open:** Both front and rear wing flaps open on every designated straight at least `250 m` long (radius `≥ 800 m`, bridging gentle kinks up to `100 m` long with radius `≥ 500 m`) with **no gap requirement** to the car ahead.
- **Pre-queueing:** A HUD notice appears `150 m` before a straight-mode zone. Pressing the flap button up to `250 m` before the zone queues activation (held for up to `12 s`) and opens the flaps the instant you cross the activation line.
- **Low Grip Conditions and wet lockout:** When racing-line water exceeds `0.2 mm`, race control declares **Low Grip Conditions** (cleared once water falls below `0.08 mm`). Under Low Grip Conditions, rear flaps stay locked out above `0.25` wetness, only the **front flaps** open, and activation zones shift `50 m` further down the straight. Under open-wheel race rules, local yellow-flag zones also lock out flaps and Overtake Mode.

### 350 kW MGU-K, 4 MJ battery, and Overtake Mode

The 2026 power unit pairs a 1.6 L V6 turbo with a `350 kW` MGU-K and a `4 MJ` usable battery state-of-charge window. Power delivery follows the FIA 2026 speed taper rules:

- **Standard deployment:** Delivers up to `350 kW` up to `290 km/h`, tapers linearly down to `100 kW` at `340 km/h`, and ramps to `0 kW` at `345 km/h`. In races on circuits with designated `250 kW` power-limited sectors, electrical output caps at `250 kW` up to `310 km/h` before tapering to `0 kW` at `345 km/h`.
- **Overtake Mode (`Space` / `Shift` hold, or `B` latch):** Holds full `350 kW` deployment all the way to `337.5 km/h` before tapering to `0 kW` at `355 km/h`, and increases the lap's energy harvest allowance by **`+0.5 MJ`**.
- **Low-speed street circuits (Rev 1 curves, e.g., Monaco):** Standard deployment tapers from `350 kW` at `200 km/h` to `0 kW` at `300 km/h`; Overtake Mode tapers more gently from `200 km/h` to `150 kW` at `300 km/h` and `0 kW` at `310 km/h`.
- **Earning Overtake Mode in a race:** Cross the circuit's Overtake Detection Line within `1.0 s` of the car directly ahead on track (lapped cars included) to unlock Overtake Mode from the Activation Line through the entire following lap. In practice and qualifying, Overtake Mode is available freely at any time.

## Garage and car setups

Open the **Garage** from the menu or pause screen to tune your car, save named setups, or exchange setups via `LC1-` share codes and `.json` files (see [Sharing a car setup](ONLINE.md#sharing-a-car-setup)). Every car uses one of two class setup sheets anchored to that car's real physical baseline:

### F1 setup sheet (`lc26`, `f12026-car`, and F1 mods)

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
