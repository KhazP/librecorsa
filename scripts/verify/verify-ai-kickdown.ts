/**
 * The AI kickdown (VehiclePhysics `aiKickdown`, F12026CarSim `kickdownRoom`): the auto box keeps the gear the brakes
 * left it in unless the engine lugs, so an AI road car that braked lightly into a slow corner drove out of it a gear high
 * (a Liana in third at 3400 rpm out of Sachsenring's last corner: half a second a lap, and the field's quicker drivers
 * lapped slower than its slower ones). A race field's road, classic and prototype cars now take the gear below on the
 * way out; the player's car never does.
 *
 * 1. On the flat pad, a Liana on the autopilot eased from 95 to 67 km/h in third (too gently for the box to shift down)
 *    and then let go: with `aiKickdown` it is in second within a second, without it it stays in third.
 * 2. The player's car: the same Liana driven by its pedals (light braking, then flat out) stays in third, with the flag
 *    set on it too (it only acts while the autopilot drives).
 * 3. Not close to the upshift point: let go at 80 km/h (second would be within 20 % of the upshift point) it stays in
 *    third.
 * 4. The race field sets it on its road, classic and prototype cars, never on the player's car, the F1 cars or the GT3.
 *
 * Usage: npx tsx scripts/verify/verify-ai-kickdown.ts
 */
import { AI_DRIVERS, AiOpponentField } from '../../src/lib/sim/ai-opponents';
import { createSuzukiLianaSim } from '../../src/lib/sim/road/SuzukiLianaSim';
import { createAmgGt3Sim } from '../../src/lib/sim/gt3/AmgGt3Sim';
import type { F12026CarSim } from '../../src/lib/sim/f12026-car/F12026CarSim';
import type { SimulatorCar } from '../../src/lib/sim/simulator-car';
import { getActiveTrackData } from '../../src/lib/track-data';
import { createFlatTestTrack } from '../lib/flat-track';

const DT = 1 / 120;
const pad = createFlatTestTrack(30_000, 3000);

let failed = 0;
const check = (ok: boolean, line: string) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`);
};

/** A Liana on the pad at 95 km/h in third, the auto box on */
function liana(): F12026CarSim {
  const c = createSuzukiLianaSim(pad);
  c.assistPreset = 'pro';
  c.autoGearbox = true;
  c.teleportToDistance(1000, 95 / 3.6);
  return c;
}

/**
 * On the autopilot: held at 95 km/h, eased down to `toKmh` at 1 m/s² (a lift and a touch of brake, as an AI car braking
 * lightly into a corner), then let go. The gear when let go, and the lowest gear in the second after
 */
function autopilotRun(kickdown: boolean, toKmh: number): { atRelease: number; after: number } {
  const c = liana();
  c.aiAutopilot = true;
  c.aiSelfRecovery = false;
  c.aiPaceScale = 1;
  c.aiKickdown = kickdown;
  c.aiSpeedCapMs = 95 / 3.6;
  for (let t = 0; t < 2; t += DT) c.step(DT, {});
  while (c.aiSpeedCapMs > toKmh / 3.6) {
    c.aiSpeedCapMs = Math.max(toKmh / 3.6, c.aiSpeedCapMs - 1 * DT);
    c.step(DT, {});
  }
  for (let t = 0; t < 1.5; t += DT) c.step(DT, {});
  const atRelease = c.telemetry.gear;
  c.aiSpeedCapMs = Infinity;
  let after = atRelease;
  for (let t = 0; t < 1; t += DT) {
    c.step(DT, {});
    after = Math.min(after, c.telemetry.gear);
  }
  return { atRelease, after };
}

// ---- 1. The autopilot out of a slow corner a gear high
{
  const on = autopilotRun(true, 67);
  const off = autopilotRun(false, 67);
  check(
    on.atRelease === 3 && on.after === 2 && off.atRelease === 3 && off.after === 3,
    `autopilot eased to 67 km/h in third, then let go: with the kickdown ${on.atRelease} → ${on.after}, without ${off.atRelease} → ${off.after} (want 3 → 2, 3 → 3)`
  );
}

// ---- 2. The player's car: pedals only, the flag set on it too
{
  const c = liana();
  c.aiKickdown = true;
  for (let t = 0; t < 0.5; t += DT) c.step(DT, { throttle: 0.3, analogSteer: 0 });
  const start = c.telemetry.gear;
  while (c.vxMs > 67 / 3.6) c.step(DT, { brake: 0.15, analogSteer: 0 });
  let lowest = c.telemetry.gear;
  for (let t = 0; t < 1; t += DT) {
    c.step(DT, { throttle: 1, analogSteer: 0 });
    lowest = Math.min(lowest, c.telemetry.gear);
  }
  check(start === 3 && lowest === 3, `player's Liana braked lightly to 67 km/h in third, then flat out: gears ${start} → lowest ${lowest} (want 3 → 3)`);
}

// ---- 3. Not into a gear it would leave again at once
{
  const near = autopilotRun(true, 80);
  check(near.atRelease === 3 && near.after === 3, `autopilot let go at 80 km/h in third (second within 20 % of the upshift point): ${near.atRelease} → ${near.after} (want 3 → 3)`);
}

// ---- 4. Which cars the race field gives it
{
  const track = getActiveTrackData();
  const flags = (player: SimulatorCar) => {
    const field = new AiOpponentField(track, player, AI_DRIVERS.slice(0, 2), undefined, { skill: 70, seed: 1, learning: false });
    const sims = (field as unknown as { cars: { sim: SimulatorCar; isPlayer: boolean }[] }).cars;
    return { ai: sims.filter((c) => !c.isPlayer).map((c) => c.sim.aiKickdown === true), player: sims.find((c) => c.isPlayer)?.sim.aiKickdown === true };
  };
  const road = flags(createSuzukiLianaSim(track));
  const gt3 = flags(createAmgGt3Sim(track));
  check(
    road.ai.every(Boolean) && !road.player && gt3.ai.every((x) => !x) && !gt3.player,
    `race field: Liana AI cars ${road.ai.join('/')}, the player's Liana ${road.player}; AMG GT3 AI cars ${gt3.ai.join('/')}, the player's ${gt3.player}`
  );
}

console.log(failed ? `${failed} case(s) failed.` : 'AI road cars kick down out of slow corners; the player\'s car never does.');
process.exit(failed ? 1 : 0);
