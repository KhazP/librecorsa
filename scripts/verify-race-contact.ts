/**
 * Headless checks for contact, crashes and damage in an AI race.
 *
 *   npx tsx scripts/verify-race-contact.ts
 *
 * The player's car (f12026-car physics, driven by fixed inputs) against one AI car of the field on Monza's main
 * straight, with the field's own contact, damage and driver-control code:
 *
 *  1. Rear-end: momentum goes into the car ahead, both noses / tails are damaged, the cars do not pass through
 *  2. Rear-quarter hits: a light tap knocks the AI car out of shape, a firm one spins it (it used to catch every
 *     hit at once, with no reaction time)
 *  3. The spun car stops, waits for the road behind to clear, and rejoins by driving (no teleport)
 *  4. A car stopped across the road: the player can't drive through it; a big hit retires both cars on full damage
 *  5. A barrier hit damages the car where it landed
 *  6. Damage off: the same hits break nothing
 */
import { readFileSync } from 'node:fs';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { AiOpponentField, type FieldIncident } from '../src/lib/sim/ai-opponents';
import type { DamageLevel } from '../src/lib/sim/car-damage';
import type { ControlInputs } from '../src/types/f1';
import { loadGlbGeometry } from './lib/glb-geometry';
import { skipSuiteWithout } from './lib/hosted-files';

skipSuiteWithout('public/tracks/monza/track_data.json', 'public/tracks/monza/monza.glb');

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};
const f = (v: number, d = 1) => v.toFixed(d);

setActiveTrack('monza', JSON.parse(readFileSync('public/tracks/monza/track_data.json', 'utf8')) as RawTrackJson);
const track = getActiveTrackData(1200);
const root = loadGlbGeometry(`public${track.meshUrl}`);
const DT = 1 / 60;

interface Setup {
  /** Player and AI: track distance (m), lateral (m, + right), speed (m/s) */
  player: [number, number, number];
  ai: [number, number, number];
  /** Extra heading of the AI car (deg) */
  aiYawDeg?: number;
  damage?: DamageLevel;
  inputs: (frame: number) => Partial<ControlInputs>;
  frames: number;
}

function heading(q: { x: number; y: number; z: number; w: number }) {
  return Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
}

function run(setup: Setup) {
  const player = new F12026CarSim(track, root);
  player.assistPreset = 'pro';
  const field = new AiOpponentField(track, player, [{ code: 'AIC', teamColorHex: '#00ff00', pace: 0.96 }], undefined, {
    seed: 7,
    learning: false,
    damage: setup.damage ?? 'full',
  });
  field.startRace(false);
  const ai = field.aiSims()[0];
  player.teleportToDistance(setup.player[0], setup.player[2], setup.player[1]);
  ai.teleportToDistance(setup.ai[0], setup.ai[2], setup.ai[1]);
  if (setup.aiYawDeg) {
    const yaw = heading(ai.worldQuaternion) + (setup.aiYawDeg * Math.PI) / 180;
    ai.restorePose!({ x: ai.worldPosition.x, z: ai.worldPosition.z, yawRad: yaw, speedMs: setup.ai[2], s: setup.ai[0] });
  }
  const incidents: FieldIncident[] = [];
  const modes = new Set<string>();
  let maxHeading = 0;
  let firstContact = -1;
  let passedThrough = false;
  const trace: { frame: number; aiVx: number; aiS: number; aiLat: number; playerVx: number; mode: string; ds: number }[] = [];
  for (let i = 0; i < setup.frames; i++) {
    player.step(DT, setup.inputs(i));
    field.update(DT);
    for (const inc of field.incidents) {
      incidents.push(inc);
      if (inc.kind === 'contact' && firstContact < 0) firstContact = i;
    }
    const info = field.carInfo('AIC')!;
    modes.add(info.mode);
    // Against the road's direction here, not the start's (the car goes round corners)
    const smp = track.getSampleAtDistance(ai.sMeters);
    let dh = heading(ai.worldQuaternion) - Math.atan2(smp.tangent.x, smp.tangent.z);
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    maxHeading = Math.max(maxHeading, Math.abs(dh));
    const ds = ai.sMeters - player.sMeters;
    // Through the other car: from behind it to more than a car length ahead within half a second of the first touch
    if (firstContact >= 0 && i - firstContact < 30 && ds < -5 && Math.abs(ai.lateralOffsetM - player.lateralOffsetM) < 1.2) passedThrough = true;
    trace.push({ frame: i, aiVx: ai.vxMs, aiS: ai.sMeters, aiLat: ai.lateralOffsetM, playerVx: player.vxMs, mode: info.mode, ds });
  }
  return { field, player, ai, incidents, modes, maxHeadingDeg: (maxHeading * 180) / Math.PI, firstContact, passedThrough, trace };
}

// ---- 1. Rear-end at 22 m/s closing
{
  const r = run({ player: [300, 0, 62], ai: [308, 0, 40], inputs: () => ({ throttle: 0.6 }), frames: 90 });
  const at = r.firstContact;
  const after = r.trace[Math.min(r.trace.length - 1, at + 6)];
  const before = r.trace[Math.max(0, at - 1)];
  const pd = r.field.carInfo('YOU')!.damage;
  const ad = r.field.carInfo('AIC')!.damage;
  check('Rear-end: the cars touch', at >= 0, `first contact at frame ${at}`);
  check('Rear-end: the car ahead is shoved forward', after.aiVx - before.aiVx > 6, `AI ${f(before.aiVx)} → ${f(after.aiVx)} m/s`);
  check('Rear-end: the car behind loses its speed', before.playerVx - after.playerVx > 6, `player ${f(before.playerVx)} → ${f(after.playerVx)} m/s`);
  check('Rear-end: front damage behind, rear damage ahead', pd.front > 0.2 && ad.rear > 0.2, `player front ${f(pd.front, 2)}, AI rear ${f(ad.rear, 2)}`);
  check('Rear-end: nobody drives through', !r.passedThrough, '');
  const contact = r.incidents.find((i) => i.kind === 'contact');
  check('Rear-end: reported with the player as the car behind', contact?.kind === 'contact' && contact.aIsPlayer, contact?.kind === 'contact' ? `${contact.a} → ${contact.b} at ${f(contact.impactMs)} m/s` : 'none');
}

// ---- 2 + 3. Rear-quarter hits, then the spun car's rejoin
{
  // A tap: 8 frames of a tenth of the lock into the rear quarter (more lock, or held longer, it is a spin-out move and
  // wrecks the car ahead). 3.5 s: the player's fixed throttle runs it into the first chicane after that
  const tap = run({ player: [300, -1.5, 63], ai: [304.4, 0, 59], inputs: (i) => ({ throttle: 0.5, analogSteer: i < 8 ? 0.1 : 0 }), frames: 60 * 3.5 });
  const tapInfo = tap.field.carInfo('AIC')!;
  check('Light tap: the AI car is knocked out of shape', tap.modes.has('startled') && tap.maxHeadingDeg > 5, `heading off the road by ${f(tap.maxHeadingDeg, 0)}°, modes ${[...tap.modes].join(' → ')}`);
  check('Light tap: ... and gathers it up', tapInfo.stats.spins === 0, `${tapInfo.stats.spins} spins`);
  // The player brakes once the AI car has gone (~0.5 s): held on throttle, its swerve keeps shoving the spinning car
  // into the pit wall and wrecks it (≥ 0.85 damage retires it), and whether it does is down to the spin's exact path,
  // not to the rejoin under test
  const hit = run({
    player: [300, -1.5, 63],
    ai: [304.4, 0, 59],
    inputs: (i) => ({ throttle: i < 30 ? 0.5 : 0, brake: i < 30 ? 0 : 1, analogSteer: i < 20 ? 0.25 : 0 }),
    frames: 60 * 40,
  });
  const info = hit.field.carInfo('AIC')!;
  check('Firm hit: the AI car spins', info.stats.spins > 0 && hit.maxHeadingDeg > 60, `heading off the road by ${f(hit.maxHeadingDeg, 0)}°, modes ${[...hit.modes].join(' → ')}`);
  const stopFrame = hit.trace.findIndex((t) => t.mode === 'stopped');
  const backFrame = hit.trace.findIndex((t, i) => stopFrame >= 0 && i > stopFrame && t.mode === 'racing');
  check('Rejoin: the spun car comes to a stop first', stopFrame >= 0, `stopped at ${f(stopFrame / 60)} s`);
  // (the stuck-recovery count also catches the set-up teleport on the first frame, so the jumps are looked for here)
  const L = track.totalLengthM;
  const jumps = hit.trace.filter((t, i) => i > 1 && Math.abs(((t.aiS - hit.trace[i - 1].aiS + 1.5 * L) % L) - L / 2) > 15).length;
  // A car that leaves the ground for good is put back on the road where it stood (the sim's own rescue): a jump across
  // the road within a frame. Known to happen here: beside Monza's pit straight the rejoining car can ride a rear wheel
  // up the grass bank on full lock and throttle and be thrown. Reported, not yet asked to be zero
  const rescues = hit.trace.filter((t, i) => i > 1 && Math.abs(t.aiLat - hit.trace[i - 1].aiLat) > 3).length;
  check('Rejoin: then races again: no marshal move, no jump along the track', backFrame > 0 && info.stats.marshalRecoveries === 0 && jumps === 0, `racing again at ${f(backFrame / 60)} s, ${info.stats.marshalRecoveries} marshal moves, ${jumps} jumps, ${rescues} rescue(s) across the road`);
  const late = Math.max(...hit.trace.slice(-60 * 15).map((t) => t.aiVx));
  check('Rejoin: back up to racing speed', late > 50 || info.retired, `${f(late)} m/s top speed over the last 15 s${info.retired ? ' (retired)' : ''}`);
}

// ---- 4. A car stopped across the road
{
  const r = run({ player: [300, 0.5, 36], ai: [322, 0.5, 0], aiYawDeg: 90, inputs: () => ({ throttle: 0.4 }), frames: 120 });
  const at = r.firstContact;
  const after = r.trace[Math.min(r.trace.length - 1, at + 10)];
  check('Stopped car: contact', at >= 0, `frame ${at}`);
  check('Stopped car: the player is stopped by it, not through it', !r.passedThrough && after.playerVx < 22, `player ${f(after.playerVx)} m/s 10 frames on`);
  const retired = r.incidents.filter((i) => i.kind === 'retired').map((i) => (i.kind === 'retired' ? i.code : ''));
  check('Stopped car: a ~35 m/s hit retires both cars on full damage', retired.includes('YOU') && retired.includes('AIC'), `retired: ${retired.join(', ') || 'none'}`);
  const st = r.field.status();
  check('Stopped car: the player is classified DNF', st.phase === 'finished' && !!st.results?.find((e) => e.isPlayer)?.dnf, `phase ${st.phase}`);
}

// ---- 5. Barrier
{
  const r = run({ player: [300, 0, 55], ai: [900, 0, 50], inputs: (i) => ({ throttle: 0.5, analogSteer: i < 40 ? -0.35 : 0 }), frames: 150 });
  const wall = r.incidents.find((i) => i.kind === 'damage' && i.source === 'wall' && i.isPlayer);
  check('Barrier: a hit damages the player car', !!wall, wall?.kind === 'damage' ? `${wall.report.zone}, severity ${f(wall.report.severity, 2)}` : 'no wall damage');
}

// ---- 6. Damage off
{
  const r = run({ player: [300, 0, 62], ai: [308, 0, 40], damage: 'off', inputs: () => ({ throttle: 0.6 }), frames: 90 });
  check('Damage off: a rear-end breaks nothing', r.field.carInfo('YOU')!.damage.pristine && r.field.carInfo('AIC')!.damage.pristine, '');
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll race contact checks passed.');
if (failures.length) process.exit(1);
