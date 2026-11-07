# Race AI, contact and damage

How an AI race works: who drives what, what happens when cars touch, and how race control judges it. The numbers
in this file are tuning values checked against headless races. They are not measured or regulatory figures.

## Layers

| Layer | File | What it does |
|---|---|---|
| Line and speed | `speed-profile.ts`, `ai-tuning.ts`, `public/ai/*.json` | Each car's limit speed along its racing line, scaled by skill, per-lap errors and what it has learnt per corner |
| Driving | `F12026CarSim.autopilot` / `F1Physics2026` | Pure pursuit plus a yaw-rate loop on the full vehicle model, at 500 Hz |
| The driver's hands | `ai-car-control.ts` | Reaction time after a knock, the catch-or-spin decision, stopping, waiting for a gap, rejoining, marshals |
| Racecraft | `ai-racecraft.ts` + `AiOpponentField.planTraffic` | Lateral target and speed cap per car from the cars around it |
| Contact | `track-evolution.ts` (OBB solver) + `AiOpponentField.resolveContacts` | Impulse with off-centre yaw, impact-scaled caps, world-space broad phase |
| Damage | `car-damage.ts` | Per-zone damage from impact speed and contact point; aero, toe, grip, punctures, retirement |
| Race control | `race-incidents.ts` | Blame, penalties, warnings, yellow flags, the HUD messages |

## Racecraft rules

- **Following.** A car never closes on the car in its path faster than it could still stop behind it:
  `v ≤ v_ahead + √(2·7·(gap − 1.5))`. Without this, the pack ran into each other going into braking zones.
- **Passing.** The car stays in the tow until it is close (nose to tail `3 + 0.9·closing` m), then pulls out. Once
  started, the pass is held even after the car leaves the other car's wake. It commits to a side when the braking
  zone is near, and pushes a little harder once alongside. A pass is only started if the car can draw alongside
  before the turn-in plus part of the braking zone (`passFeasible`). That rules out lunges.
- **Corner ownership.** The car on the inside, with its nose at least at the other car's middle, owns the corner.
  The outside car yields only if it doesn't own the corner.
- **Defending.** One move per straight, made on the throttle, never against a car already alongside or one lapping
  us, and never under a yellow.
- **Blue flags.** A car about to be lapped gives up the inside of the next corner.
- **Hazards.** A car that is spinning, stopped, crawling or retired is an obstacle to pass on the side with room. If
  the gap is tight the car slows down for it, and it is never followed into. The yellow zone runs from 350 m before
  the hazard to 40 m after it. Cars in it lift and don't overtake.
- **Side by side.** Cars keep about 0.9 m of air (2.9 m centre to centre).

## Contact and the driver

The autopilot has no reaction time, so on its own it caught every slide at once. When a car is knocked (yaw
change > 0.18 rad/s, lateral speed change > 0.9 m/s, or a barrier hit > 4 m/s), the driver holds the wheel and lifts
for their reaction time, which is 0.17 to 0.36 s depending on skill. After that, the autopilot gets the car back only
if body slip and yaw error are inside the driver's catch. Otherwise the car spins with both feet in, stops, waits
for the road behind to clear, and rejoins at walking pace. If it faces the wrong way, it turns round first. The
marshals move a car only when it can't get going on its own.

## Damage

Damage is judged by the closing speed along the contact normal. Barrier hits count 1.25× as hard.

| | Reduced | Full |
|---|---|---|
| Aero parts (2 → 20 m/s) | half | full |
| Suspension near a wheel (from 6 m/s) | half | full |
| Puncture chance on a wheel (from 4 m/s) | yes | yes |
| One hit that retires the car | 34 m/s | 24 m/s |

On the f12026-car physics, damage reaches the car through the wake multipliers (downforce, drag), per-wheel grip
and toe, and engine torque. On the VF26 model it only takes the aero loss.

## Race control

Contacts under 1.5 m/s are ignored. The others are judged on the facts at the moment of contact:

- **From behind** (cars in line, the car behind not yet alongside): the car behind is at fault.
- **Alongside:** the car that moved across into the other is at fault.
- **Anything else** is a racing incident.

Three seconds later race control looks at the consequences. If the at-fault car spun, damaged or retired the other
car, that is causing a collision: 5 s, or 10 s if the other car is out. Without a consequence, the player gets a
warning. An AI driver at fault races with more caution for 20 s.

## Checking it

```
npx tsx scripts/verify-race-contact.ts     # rear-end, taps, spins, rejoin, a stopped car, barriers, damage off
npx tsx scripts/verify-race-craft.ts       # judgements, race control, grid, a duel, a stopped car on the line
npm run race:headless -- --track monza --car f12026-car --laps 3 --cars 8 --grid qualifying --damage full
```
