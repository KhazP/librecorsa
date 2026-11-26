/**
 * Headless checks for F1 2007 (`src/lib/sim/f1-2007/`, `src/lib/cars/f1-2007-skins.ts`): Cimmerian Iter's eleven 2007
 * Formula 1 cars under one entry, every team on the Ferrari F2007's data (2.4 L V8 to 19,000 rpm, seven speeds, 680 kg).
 *
 *   npx tsx scripts/verify/verify-f1-2007.ts
 *
 * The liveries (one per driver, each naming its team's body), what a livery resolves to on the rig, the bodies and
 * livery files (when this copy has them), a 2007 car's overtaking rules (no DRS), and the straight line through the
 * adapter: 0-100 and 0-200 km/h from a clutch start and the top speed on the default wings. The data's own values are
 * checked by verify-mod-parity.ts.
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { F12007_CONFIG } from '../../src/lib/sim/f1-2007/F12007Config';
import { createF12007Sim } from '../../src/lib/sim/f1-2007/F12007Sim';
import { F1_2007_SKINS, f12007BodyUrl } from '../../src/lib/cars/f1-2007-skins';
import { anyCarById, carOvertakingRules, portedSkinFor } from '../../src/lib/cars/car-registry';
import { carListed } from '../../src/lib/hosted-content';
import { carTakesPhysicsSwitch } from '../../src/lib/cars/f1-mod-physics';
import { createFlatTestTrack } from '../lib/flat-track';
import { hasFile, noteSkip } from '../lib/hosted-files';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(72)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);
const DT = 1 / 120;

const TEAMS = ['ferrari', 'mclaren', 'renault', 'honda', 'bmw-sauber', 'toyota', 'red-bull', 'williams', 'toro-rosso', 'spyker', 'super-aguri'];
const teamOf = (id: string) => TEAMS.find((t) => id.startsWith(`${t}-`));
const bodyOf = (s: (typeof F1_2007_SKINS)[number]) => s.modelUrl ?? f12007BodyUrl('ferrari');

console.log('== The entry and its liveries');
{
  // The definition whether or not this copy lists the car (a hosted car is listed only where hosted content is on)
  const car = anyCarById('f1-2007')!;
  check('one entry, the Ferrari its own body', car?.id === 'f1-2007' && car.modelUrl === f12007BodyUrl('ferrari'), car?.modelUrl ?? '');
  check('a 2007 F1 car races without DRS', carOvertakingRules(car) === 'none', String(carOvertakingRules(car)));
  check("its own physics, not the ported F1 cars' switch", car.physics === 'f1-2007' && (!carListed('f1-2007') || !carTakesPhysicsSwitch('f1-2007')));

  const ids = new Set(F1_2007_SKINS.map((s) => s.id));
  check('26 liveries, each id once', F1_2007_SKINS.length === 26 && ids.size === 26, `${F1_2007_SKINS.length} liveries`);
  check('no livery in tobacco paint', F1_2007_SKINS.every((s) => !/marlboro/i.test(`${s.id} ${s.name}`)));
  check('every livery belongs to one of the eleven teams', F1_2007_SKINS.every((s) => teamOf(s.id) !== undefined));
  const bodies = new Set(F1_2007_SKINS.map(bodyOf));
  check('eleven bodies, one per team', bodies.size === 11 && TEAMS.every((t) => bodies.has(f12007BodyUrl(t))), `${bodies.size} bodies`);
  check(
    "each livery's body is its team's",
    F1_2007_SKINS.every((s) => bodyOf(s) === f12007BodyUrl(teamOf(s.id)!)),
  );
  // Each team's body is painted in one of its drivers: that livery changes no file, every other one lists its own
  const paintOnly = TEAMS.map((t) => F1_2007_SKINS.filter((s) => teamOf(s.id) === t && (s.files ?? []).length === 0));
  check(
    "each team has exactly one livery in its body's own paint",
    paintOnly.every((list, i) => list.length === 1 && (TEAMS[i] === 'ferrari' || list[0].useModelPaint === true)),
  );
  check('the first livery is the Ferrari body as painted', F1_2007_SKINS[0].id === 'ferrari-raikkonen' && !F1_2007_SKINS[0].modelUrl);

  // What the rig is handed: the first is the car's own paint, a team's own paint is that body with no files, and any
  // other livery is its files beside the car on its team's body
  const first = portedSkinFor('f1-2007', F1_2007_SKINS[0]);
  const alonso = portedSkinFor('f1-2007', F1_2007_SKINS.find((s) => s.id === 'mclaren-alonso'));
  const hamilton = portedSkinFor('f1-2007', F1_2007_SKINS.find((s) => s.id === 'mclaren-hamilton'));
  const massa = portedSkinFor('f1-2007', F1_2007_SKINS.find((s) => s.id === 'ferrari-massa'));
  check('Räikkönen: the model as painted', first === null);
  check(
    "Alonso: the McLaren's own paint",
    alonso?.modelUrl === f12007BodyUrl('mclaren') && alonso.files?.length === 0,
    JSON.stringify(alonso),
  );
  check(
    "Hamilton: his files on the McLaren",
    hamilton?.modelUrl === f12007BodyUrl('mclaren') && hamilton.baseUrl === '/cars/f1-2007/skins/mclaren-hamilton' && (hamilton.files?.length ?? 0) > 0,
    JSON.stringify(hamilton),
  );
  check('Massa: his files on the car\'s own Ferrari', massa !== null && massa.modelUrl === undefined && massa.baseUrl === '/cars/f1-2007/skins/ferrari-massa');
}

console.log('\n== Bodies and livery files');
{
  const ferrari = `public${f12007BodyUrl('ferrari')}`;
  if (!hasFile(ferrari)) {
    noteSkip('F1 2007 bodies', ferrari);
  } else {
    for (const team of TEAMS) {
      const glb = `public${f12007BodyUrl(team)}`;
      if (!hasFile(glb)) {
        check(`${team}: body present`, false, glb);
        continue;
      }
      const buf = readFileSync(glb);
      const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')) as {
        nodes: { name: string; extras?: Record<string, unknown> }[];
      };
      const byName = new Map(json.nodes.map((n) => [n.name, n]));
      const extras = byName.get('CAR')?.extras as { wheelbaseM?: number; tyreRadius?: Record<string, number> } | undefined;
      const rig = ['CAR', 'BODY', 'STEER', 'WHEEL_LF', 'WHEEL_RF', 'WHEEL_LR', 'WHEEL_RR'].every((n) => byName.has(n));
      // The mod's wheelbases run from the Toyota's 2.96 m to the Super Aguri's 3.17 m round the Ferrari's 3.13
      const wb = extras?.wheelbaseM ?? NaN;
      check(
        `${team}: rig nodes, a 2.9–3.2 m wheelbase, tyres near the physics' radius`,
        rig && wb > 2.9 && wb < 3.2 && Math.abs((extras?.tyreRadius?.LR ?? 0) - F12007_CONFIG.tyreCompounds[F12007_CONFIG.compoundSlots.soft].rear.radius) < 0.02,
        `${fmt(wb, 3)} m, rear tyre ${fmt(extras?.tyreRadius?.LR ?? NaN, 3)} m`,
      );
    }
    const missing = F1_2007_SKINS.flatMap((s) => (s.files ?? []).map((f) => `public/cars/f1-2007/skins/${s.id}/${f}`)).filter((f) => !hasFile(f));
    check(
      "every livery's files are beside the car",
      missing.length === 0,
      missing.length ? `missing ${missing.slice(0, 3).join(', ')}` : `${F1_2007_SKINS.reduce((n, s) => n + (s.files ?? []).length, 0)} files`,
    );
  }
}

console.log('\n== Launch and straight line through the adapter');
{
  // A driver's start on semi-pro (the data's 8 % traction control): 7000 rpm held on the clutch, where the rears don't
  // spin up yet, the clutch out over 0.3 s, then flat out on the auto shifter, on the default wings
  const pad = createFlatTestTrack(30_000, 3000);
  const sim = createF12007Sim(pad);
  sim.assistPreset = 'semi_pro';
  sim.teleportToDistance(1000, 0);
  let t100 = NaN;
  let t200 = NaN;
  let vmax = 0;
  let thr = 0.4;
  for (let t = 0; t < 62.5; t += DT) {
    const tel = sim.telemetry;
    let clutch = 1;
    if (t < 2.5) thr = THREE.MathUtils.clamp(thr + (tel.rpm < 7000 ? 0.05 : -0.05), 0, 1);
    else {
      clutch = Math.max(0, 1 - (t - 2.5) / 0.3);
      thr = 1;
    }
    sim.step(DT, { throttle: thr, clutch });
    const v = sim.telemetry.speedKmh;
    vmax = Math.max(vmax, v);
    if (Number.isNaN(t100) && v >= 100) t100 = t - 2.5;
    if (Number.isNaN(t200) && v >= 200) t200 = t - 2.5;
  }
  // A 2007 car ran 0-100 in about 2.5–3 s, 0-200 in about 5 s, and 300–320 km/h on its low-downforce wings
  check('0-100 km/h in 2.4–3.4 s from a clutch start', t100 > 2.4 && t100 < 3.4, `${fmt(t100)} s`);
  check('0-200 km/h in 4.8–6.4 s', t200 > 4.8 && t200 < 6.4, `${fmt(t200)} s`);
  check('285–315 km/h flat out on the default wings', vmax > 285 && vmax < 315, `${fmt(vmax, 1)} km/h`);
}

if (failures.length) {
  console.log(`\n${failures.length} F1 2007 check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll F1 2007 checks passed.');
