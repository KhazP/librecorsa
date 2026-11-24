/**
 * The player's car on its autopilot in traffic (`AiOpponentField.capPlayerAutopilot`), on RISE short's Turn 3, where
 * the racing line crosses the road from the outside to the apex:
 *   npx tsx scripts/verify-autopilot-traffic.ts
 *
 * It runs the AI cars' own path check: a car its line will close onto further down the road is followed though it is
 * out of the autopilot's lane now (it came down the outside into a pack braking for the hairpin at racing speed, and
 * turned in across it); a car beside it that its line would squeeze is given room or, with none, it lifts to drop in
 * behind. A clear road, and a car well off its path, leave it alone.
 */
import { readFileSync } from 'node:fs';
import { vehicleModelSpec } from '../src/lib/cars/vehicle-models';
import { AiOpponentField, aiDriversFor } from '../src/lib/sim/ai-opponents';
import type { SimulatorCar } from '../src/lib/sim/simulator-car';
import { aiLineOffsetM } from '../src/lib/sim/speed-profile';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { skipSuiteWithout } from './lib/hosted-files';

skipSuiteWithout('public/tracks/rwanda_official_short/track_data.json');

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(74)} ${detail}`);
  if (!ok) failures.push(name);
};
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : String(v));

setActiveTrack('rwanda_official_short', JSON.parse(readFileSync('public/tracks/rwanda_official_short/track_data.json', 'utf8')) as RawTrackJson);
const track = getActiveTrackData(1200);
const lineAt = (s: number) => aiLineOffsetM(track.getSampleAtDistance(s), 'gt3');

type Car = { isPlayer: boolean; sim: SimulatorCar; biasM: number; startLaneM: number | null };
/** A GT3 field of one AI car and the player's car on autopilot, racing; the cap and bias the autopilot is given */
function autopilotWith(me: [number, number, number], other: [number, number, number] | null): { capMs: number; biasM: number } {
  const player = vehicleModelSpec('amg-gt3').createSim(track, null);
  const field = new AiOpponentField(track, player, aiDriversFor(1), undefined, { seed: 5, learning: false, trackId: 'rwanda_official_short' });
  field.startRace(false);
  const f = field as unknown as { cars: Car[]; phase: string; raceTimeS: number; rollingFormation: boolean; capPlayerAutopilot(L: number, dt: number): void };
  f.phase = 'racing';
  f.raceTimeS = 60;
  f.rollingFormation = false;
  const mine = f.cars.find((c) => c.isPlayer) as Car;
  const ai = f.cars.find((c) => !c.isPlayer) as Car;
  mine.startLaneM = null;
  player.teleportToDistance(me[0], me[2], me[1]);
  ai.sim.teleportToDistance(other ? other[0] : 3000, other ? other[2] : 40, other ? other[1] : 0);
  player.aiAutopilot = true;
  f.capPlayerAutopilot(track.totalLengthM, 1 / 120);
  // (a few frames for the bias to move at its rate)
  for (let k = 0; k < 11; k++) f.capPlayerAutopilot(track.totalLengthM, 1 / 120);
  return { capMs: player.aiSpeedCapMs ?? Infinity, biasM: mine.biasM };
}

// Turn 3: the line runs down the outside and crosses to the apex (~1,316 m)
const S = 1262;
const outside = lineAt(S);
console.log(`line at ${S} m: ${f1(outside)} m, at ${S + 28} m: ${f1(lineAt(S + 28))} m, apex ${f1(lineAt(1316))} m`);

const clear = autopilotWith([S, outside, 28], null);
check('a clear road: no cap', clear.capMs === Infinity, `cap ${f1(clear.capMs)}`);

// A car braking into the hairpin 28 m ahead on the line, which is 3 m and more across from the autopilot's lane now
const ahead = autopilotWith([S, outside, 28], [S + 28, lineAt(S + 28), 12]);
const closer = autopilotWith([S, outside, 28], [S + 18, lineAt(S + 18), 12]);
check('a car its line closes onto, out of its lane now: followed', ahead.capMs < 28 && closer.capMs < ahead.capMs, `cap ${f1(ahead.capMs)} m/s 28 m behind it, ${f1(closer.capMs)} at 18 m (it at 12, the autopilot at 28)`);

// The same car on the far side of the road from where the line goes: not in its path, no cap
const away = autopilotWith([S, outside, 28], [S + 28, lineAt(S + 28) + (lineAt(S + 28) > 0 ? -5.5 : 5.5), 12]);
check('…and one well off its path is left alone', away.capMs === Infinity, `cap ${f1(away.capMs)}`);

// Beside it on the inside and a little ahead, at its speed, as the line turns in across that car: room, or a lift
const besideS = 1292;
const inside = lineAt(besideS) + (lineAt(besideS) > lineAt(S) ? 1 : -1) * 2.6;
const side = autopilotWith([besideS, lineAt(besideS), 16], [besideS + 2, inside, 16]);
const gaveRoom = Math.abs(side.biasM) > 0.2 && Math.sign(side.biasM) === Math.sign(lineAt(besideS) - inside);
check('a car beside it the line would squeeze: room on its side, or a lift', gaveRoom || side.capMs < 16, `bias ${f1(side.biasM)} m, cap ${f1(side.capMs)} m/s`);

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll autopilot traffic checks passed.');
if (failures.length) process.exit(1);
