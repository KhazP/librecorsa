# Race AI, contact, and damage

LibreCorsa's AI field drives the same 500 Hz rigid-body vehicle physics as the player, layered with racecraft planning, human-like reaction delays after collisions, zone-based damage, and automated race control. All numeric thresholds below are tuning constants validated against headless race simulations rather than regulatory figures.

## Architecture layers

| Layer | Source files | Responsibility |
| :-- | :-- | :-- |
| **Line and speed** | `speed-profile.ts`, `ai-tuning.ts`, `public/ai/*.json` | Computes each car's speed profile along its racing line, scaled by skill, per-lap error, and corner-by-corner learning |
| **Vehicle control** | `F12026CarSim.autopilot` / `F1Physics2026` | Pure-pursuit steering with a yaw-rate feedback loop running on the full 500 Hz vehicle model. A road, classic or prototype car driving a drive plan turns its wheel at up to `3600°/s` at the rim; F1 and GT3 cars keep the player's `900°/s` |
| **Driver reaction** | `ai-car-control.ts` | Post-impact reaction latency, catch-or-spin logic, braking to a stop, waiting for a safe gap, rejoining, and marshal recovery |
| **Racecraft** | `ai-racecraft.ts`, `AiOpponentField.planTraffic` | Chooses lateral lane offsets and speed caps based on surrounding traffic and flags |
| **Contact solver** | `track-evolution.ts` (OBB solver), `AiOpponentField.resolveContacts` | World-space broad phase plus oriented-bounding-box impulse solver with off-centre yaw torque and impact-scaled caps |
| **Damage** | `car-damage.ts` | Per-zone structural damage from impact normal velocity and contact point: aero loss, toe bend, grip loss, punctures, and retirements |
| **Race control** | `race-incidents.ts` | Fault attribution, time penalties, warnings, local yellow flags, and HUD steward notifications |

## Racecraft rules

- **Safe following:** A car caps its closing speed behind traffic ahead so it can always brake cleanly into corners: `v ≤ v_ahead + √(2·6·(gap − 2.5))`. This prevents pack pile-ups in heavy braking zones.
- **Overtaking:** Attacking cars stay in the slipstream until nose-to-tail distance drops to `3 + (0.9 + t)·closing` metres (where `t` is the lateral lane-change time, plus an extra `6 m` when approaching a corner), then pull out to pass. Once initiated, the move is held even after leaving the tow. The car commits to a side approaching the braking zone and pushes slightly harder once alongside. Moves are gated by `passFeasible`, which cancels speculative lunges that cannot get alongside before turn-in plus part of the braking zone.
- **Corner ownership:** An inside car with its nose at least level with the outside car's midpoint owns the corner. The outside car yields only if it does not hold ownership.
- **Defending:** Limited to one defensive move per straight while on throttle: never against a car already alongside, never against a lapping car, and never under yellow flags. A car on a drive plan defends within `0.5 m` of its line, so it doesn't sit on the inside while its line swings out for the corner and the attacker's line cuts back to the apex.
- **Blue flags:** Cars about to be lapped concede the inside line at the upcoming corner.
- **Hazards and local yellows:** Spinning, stopped, crawling, or retired cars are treated as obstacles rather than cars to draft: AI steers to whichever side offers clear space and slows when gaps are tight. Each hazard projects a yellow-flag zone from `350 m` before to `40 m` after the incident, within which AI drivers lift and hold position.
- **Side-by-side clearance:** Cars leave roughly `0.9 m` of daylight between bodies (`2.9 m` centre-to-centre).
- **Default AI skill:** Offline races default to skill `95` (almost Alien), and new career seasons default to **Expert**.
- **Pit stops and wet tyres:** On circuits with a pit lane (`src/lib/sim/pit/ai-pit.ts`, `ai-weather-tyres.ts`), AI cars pit for intermediates (`> 0.2 mm` racing-line water), full wets (`> 1.15 mm`), and back to slicks (`< 0.13 mm`), as well as for mandatory race stops and damage repairs.
- **Virtual Safety Car:** When a retired car on track or a persistent double-yellow hazard triggers a VSC (`src/lib/sim/vsc.ts`), every car paces to ~`65%` of its own racing speed (`65`–`216 km/h`) with overtaking locked out until green resumes `10`–`15 s` after `"VSC ending"`.

## Contact and driver reaction

A raw autopilot has zero reaction latency and would catch virtually every slide instantly. To produce realistic incidents, LibreCorsa inserts a human reaction layer whenever a car takes a significant knock (yaw-rate delta `> 0.18 rad/s`, lateral velocity delta `> 0.9 m/s`, or a barrier impact `> 4 m/s`):

1. **Reaction hold:** The AI freezes steering and lifts off the throttle for a skill-dependent reaction window of `0.17`–`0.36 s`.
2. **Catch or spin:** Once the window expires, the autopilot recovers the car only if body slip angle and yaw error remain within the driver's catch envelope.
3. **Recovery and rejoin:** Beyond that limit, the car locks all four brakes and spins to a halt, waits for oncoming traffic to clear, rotates back onto the track direction if facing the wrong way, and rejoins at walking pace. Track marshals relocate a car only if it is permanently stranded.

## Damage model

Structural damage scales with closing speed along the contact normal. Barrier impacts are weighted `1.25×` heavier than car-to-car contact.

| Component / outcome | Reduced damage | Full damage |
| :-- | :-- | :-- |
| Aero bodywork (`2` → `20 m/s`) | 50% scale | 100% scale |
| Suspension near a wheel (from `6 m/s`) | 50% scale | 100% scale |
| Tyre puncture chance on wheel impact (from `4 m/s`) | Enabled | Enabled |
| Single-impact terminal retirement | `34 m/s` | `24 m/s` |

On the `f12026-car` rigid-body engine (also used by the LC26), damage degrades downforce and drag multipliers, individual wheel grip and toe alignment, and engine torque output. On the legacy LC26 engine, damage applies aerodynamic loss only.

## Race control

Glancing contacts below `1.5 m/s` are ignored. Harder collisions are classified from the cars' relative geometry at impact:

- **Rear-end:** Trailing car is inline and not yet alongside → trailing car is at fault.
- **Side-to-side:** Cars are already alongside → whichever car moved laterally across into the other is at fault.
- **All other cases:** Recorded as a racing incident with no blame assigned.

Stewards wait **3 seconds** to assess consequences:

- If the innocent car spun, took damage, or retired, the at-fault driver receives a **causing a collision** penalty: `+5 s`, or `+10 s` if the victim retired.
- If no lasting consequence occurred, a human driver at fault receives a warning.
- Any AI driver judged at fault drives more conservatively for the next `20 s`.

## Running the verification suites

```bash
# Contact physics, spins, rejoins, stopped cars, barriers, and damage-off checks
npx tsx scripts/verify/verify-race-contact.ts

# Steward decisions, grid behavior, duels, and stopped-car avoidance
npx tsx scripts/verify/verify-race-craft.ts

# Full headless race benchmark with results summary
npm run race:headless -- --track rwanda_official_short --car f12026-car --laps 3 --cars 8 --grid qualifying --damage full
```
