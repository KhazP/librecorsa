/**
 * Headless checks for F1 2007 (`src/lib/sim/f1-2007/`, `src/lib/cars/f1-2007-skins.ts`): Cimmerian Iter's eleven 2007
 * Formula 1 cars under one entry, every team on the Ferrari F2007's data (2.4 L V8 to 19,000 rpm, seven speeds, 680 kg).
 *
 *   npx tsx scripts/verify/verify-f1-2007.ts
 *
 * The liveries (one per driver, each naming its team's body), what a livery resolves to on the rig, the bodies and
 * livery files (when this copy has them), a 2007 car's overtaking rules (no DRS), the straight line through the
 * adapter (0-100 and 0-200 km/h from a clutch start and the top speed on the default wings), the four dry compounds
 * (the Super Soft in the fourth slot only this car has, and its default), and the tyres' warm-up round RISE on the
 * autopilot from cold and from blankets (when this copy has the circuit). The data's own values, the warm-up's rates
 * among them, are checked by verify-mod-parity.ts.
 *
 * Each body's mirrors (mirrors.ini's mesh, MIRROR_0): two flat glasses, a mirrored pair ahead of the driver facing back
 * at him and aimed at the road behind, each showing a mirror image (its outboard edge farther out than its inboard
 * one), and the rear view's lookup (`mirror-reflection.ts`) landing where its camera sees what the glass reflects, at
 * least as sharp as the planar mirrors' 256 px over 35 degrees.
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { F12007_CONFIG } from '../../src/lib/sim/f1-2007/F12007Config';
import { createF12007Sim } from '../../src/lib/sim/f1-2007/F12007Sim';
import { compoundData, type CarPhysicsConfig } from '../../src/lib/sim/f12026-car/F12026CarConfig';
import { F12026CarSim } from '../../src/lib/sim/f12026-car/F12026CarSim';
import { carTyreCompounds, switchedCarCompound } from '../../src/lib/cars/vehicle-models';
import { challengeCompound } from '../../src/lib/net/weekly-challenge';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../../src/lib/track-data';
import { loadGlbGeometry } from '../lib/glb-geometry';
import { F1_2007_SKINS, f12007BodyUrl } from '../../src/lib/cars/f1-2007-skins';
import { anyCarById, carOvertakingRules, portedSkinFor } from '../../src/lib/cars/car-registry';
import { carListed } from '../../src/lib/hosted-content';
import { carTakesPhysicsSwitch } from '../../src/lib/cars/f1-mod-physics';
import { createFlatTestTrack } from '../lib/flat-track';
import { hasFile, noteSkip } from '../lib/hosted-files';
import { aimMirrorCamera, fitMirrorView, mirrorLookup, MIRROR_AIM_DEG, MIRROR_FOCUS_M, MIRROR_INNER_EDGE_DEG, MIRROR_PIXEL_BUDGET, portedMirrorMeshes, reflectingGeometry } from '../../src/lib/render/mirror-reflection';

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

/** A body's mirrors, as the game finds and draws them */
function checkMirrors(team: string, glb: string): void {
  const model = loadGlbGeometry(glb);
  model.updateMatrixWorld(true);
  let car: THREE.Object3D | undefined;
  model.traverse((o) => {
    if (!car && (o.userData as { wheelCentres?: unknown }).wheelCentres) car = o;
  });
  const extras = (car?.userData ?? {}) as { mirrors?: { node: string }[]; cameras?: { cockpit?: { pos: [number, number, number] } } };
  const meshes = portedMirrorMeshes(model);
  const listed = (extras.mirrors ?? []).map((m) => m.node);
  check(
    `${team}: mirrors.ini's mirror, MIRROR_0 under BODY, listed in CAR's extras`,
    JSON.stringify(listed) === '["MIRROR_0"]' && meshes.length === 1 && meshes[0].name === 'MIRROR_0' && meshes[0].parent?.name === 'BODY',
    `${JSON.stringify(listed)}, ${meshes.map((m) => `${m.parent?.name}/${m.name}`).join(' ')}`,
  );
  const eyeAt = extras.cameras?.cockpit?.pos;
  if (!car || !eyeAt || meshes.length !== 1) return;
  const eye = new THREE.Vector3(...eyeAt);
  const toModel = car.matrixWorld.clone().invert().multiply(meshes[0].matrixWorld);
  const built = reflectingGeometry(meshes[0], toModel, eye);
  const islands = (built?.islands ?? []).filter((i) => i.normal).sort((a, b) => b.centre.x - a.centre.x);
  const [left, right] = islands;
  const pair =
    islands.length === 2 &&
    left.centre.x > 0.2 &&
    Math.abs(left.centre.x + right.centre.x) < 0.01 &&
    Math.abs(left.centre.y - right.centre.y) < 0.01 &&
    Math.abs(left.centre.z - right.centre.z) < 0.01 &&
    left.centre.z > eye.z;
  check(
    `${team}: two glasses, a mirrored pair ahead of the driver's eye`,
    pair,
    islands.map((i) => `(${i.centre.toArray().map((v) => fmt(v)).join(', ')})`).join(' ') || `${built?.islands.length ?? 0} islands`,
  );
  if (!pair) return;
  // Each faces back and in toward the driver; the two show mirror-image views (where each looks, in degrees off
  // straight back, the car's left +), and each a mirror's image: across its glass, the outboard edge looks farther out
  const view = fitMirrorView([built!], eye)!;
  const t = new THREE.Vector2();
  const looks = islands.map((i) => (mirrorLookup(i.centre, i.normal!, eye, view.camera, t) ? THREE.MathUtils.radToDeg(Math.atan(t.x)) : NaN));
  const unflipped = islands.every((isl) => {
    let lo = { x: Infinity, t: NaN };
    let hi = { x: -Infinity, t: NaN };
    for (const tri of isl.tris) {
      for (let k = 0; k < 3; k++) {
        const v = new THREE.Vector3().fromArray(built!.model, tri * 9 + k * 3);
        if (!mirrorLookup(v, isl.normal!, eye, view.camera, t)) return false;
        if (v.x < lo.x) lo = { x: v.x, t: t.x };
        if (v.x > hi.x) hi = { x: v.x, t: t.x };
      }
    }
    return hi.t > lo.t;
  });
  // The glass is modelled upright, above the eye: aimed as a driver would, its centre's reflection just below level
  const pitch = islands.map((i) => {
    const r = i.centre.clone().sub(eye).normalize();
    r.addScaledVector(i.normal!, -2 * r.dot(i.normal!));
    return THREE.MathUtils.radToDeg(Math.asin(r.y));
  });
  check(`${team}: each glass aimed at the road, ${MIRROR_AIM_DEG}° below level through its centre`, pitch.every((p) => Math.abs(p + MIRROR_AIM_DEG) < 0.01), pitch.map((p) => fmt(p)).join(' / '));
  // ... and its view starting near straight back: its inner edge (deg out from the car) inside the limits, so a car
  // behind or one lane over is in a mirror (the McLaren's and Red Bull's, modelled 23-27 out, are turned in)
  const range = islands.map((i) => {
    const side = Math.sign(i.centre.x);
    let lo = Infinity;
    let hi = -Infinity;
    for (const tri of i.tris) {
      for (let k = 0; k < 3; k++) {
        const r = new THREE.Vector3().fromArray(built!.model, tri * 9 + k * 3).sub(eye).normalize();
        r.addScaledVector(i.normal!, -2 * r.dot(i.normal!));
        const a = THREE.MathUtils.radToDeg(Math.atan2(r.x * side, -r.z));
        lo = Math.min(lo, a);
        hi = Math.max(hi, a);
      }
    }
    return [lo, hi];
  });
  check(
    `${team}: each glass looks from ${MIRROR_INNER_EDGE_DEG.min}..${MIRROR_INNER_EDGE_DEG.max}° out to past 8°`,
    range.every(([lo, hi]) => lo >= MIRROR_INNER_EDGE_DEG.min - 0.05 && lo <= MIRROR_INNER_EDGE_DEG.max + 0.05 && hi > 8),
    range.map(([lo, hi]) => `${fmt(lo, 1)}..${fmt(hi, 1)}°`).join(' / '),
  );
  check(
    `${team}: each glass faces back at the driver, the pair's views mirror images, neither flipped`,
    islands.every((i) => i.normal!.z < -0.5 && Math.sign(i.normal!.x) === -Math.sign(i.centre.x)) && Math.abs(looks[0] + looks[1]) < 0.5 && unflipped,
    `n (${islands[0].normal!.toArray().map((v) => fmt(v)).join(', ')}), looking ${looks.map((a) => fmt(a, 1)).join(' / ')}°`,
  );
  // The lookup at every glass vertex lands where the rear view's camera sees the point the glass reflects
  const cam = new THREE.PerspectiveCamera();
  cam.position.copy(view.camera);
  cam.updateMatrixWorld(true);
  aimMirrorCamera(cam, view, 0.3, 250);
  // As the renderer rebuilds it for its reversed depth buffer: the window must survive that
  (cam as unknown as { _reversedDepth: boolean })._reversedDepth = true;
  cam.updateProjectionMatrix();
  let worst = 0;
  let outside = 0;
  const p = new THREE.Vector3();
  const d = new THREE.Vector3();
  for (const isl of islands) {
    for (const tri of isl.tris) {
      for (let k = 0; k < 3; k++) {
        p.fromArray(built!.model, tri * 9 + k * 3);
        if (!mirrorLookup(p, isl.normal!, eye, view.camera, t)) {
          outside++;
          continue;
        }
        const u = (t.x - view.left) / (view.right - view.left);
        const v = (t.y - view.bottom) / (view.top - view.bottom);
        if (u < 0 || u > 1 || v < 0 || v > 1) outside++;
        d.subVectors(p, eye).normalize();
        d.addScaledVector(isl.normal!, -2 * d.dot(isl.normal!));
        const seen = p.clone().addScaledVector(d, MIRROR_FOCUS_M).project(cam);
        worst = Math.max(worst, Math.abs((seen.x + 1) / 2 - u), Math.abs((seen.y + 1) / 2 - v));
      }
    }
  }
  const hDeg = THREE.MathUtils.radToDeg(Math.atan(view.right) - Math.atan(view.left));
  // Pixels per unit of tangent across and up the window, against the planar mirrors' 256 over 2 tan 17.5°
  const planar = 256 / (2 * Math.tan(THREE.MathUtils.degToRad(17.5)));
  const sharp = Math.min(view.width / (view.right - view.left), view.height / (view.top - view.bottom));
  check(
    `${team}: the lookup lands where the rear view sees the reflection, all glass inside it, as sharp as before`,
    worst < 1e-4 && outside === 0 && view.width * view.height <= MIRROR_PIXEL_BUDGET * 1.05 && sharp >= planar * 0.98,
    `off by ${worst.toExponential(1)}, ${fmt(hDeg, 1)}° wide, ${view.width}×${view.height}, ${fmt(sharp / planar)}× the planar's pixels`,
  );
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
      // Each corner's hub parts (its fixed hub fairing and callipers) ride and steer with the wheel without spinning
      const rig = ['CAR', 'BODY', 'STEER', 'WHEEL_LF', 'WHEEL_RF', 'WHEEL_LR', 'WHEEL_RR', 'HUB_LF', 'HUB_RF', 'HUB_LR', 'HUB_RR'].every((n) => byName.has(n));
      // The mod's wheelbases run from the Toyota's 2.96 m to the Super Aguri's 3.17 m round the Ferrari's 3.13
      const wb = extras?.wheelbaseM ?? NaN;
      check(
        `${team}: rig and hub nodes, a 2.9–3.2 m wheelbase, tyres near the physics' radius`,
        rig && wb > 2.9 && wb < 3.2 && Math.abs((extras?.tyreRadius?.LR ?? 0) - F12007_CONFIG.tyreCompounds[F12007_CONFIG.compoundSlots.soft].rear.radius) < 0.02,
        `${fmt(wb, 3)} m, rear tyre ${fmt(extras?.tyreRadius?.LR ?? NaN, 3)} m`,
      );
      checkMirrors(team, glb);
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

console.log('\n== Compounds: the Super Soft in the fourth dry slot');
{
  const config = F12007_CONFIG as unknown as CarPhysicsConfig;
  const list = carTyreCompounds('f1-2007');
  check(
    'Super Soft, Soft, Medium, Hard, Intermediate, Wet, softest first',
    list.join() === 'supersoft,soft,medium,hard,intermediate,wet',
    list.join(' '),
  );
  check('no other car has a super soft (the LC25, the GT3, the 934)', (['lc25', 'amg-gt3', 'porsche-934-rsr'] as const).every((v) => !carTyreCompounds(v).includes('supersoft')));
  const pad = createFlatTestTrack(3000, 200);
  const sim = createF12007Sim(pad);
  check("a new car starts on the data's default, the Super Soft", sim.tireCompound === 'supersoft', sim.tireCompound);
  check("the weekly challenge and time trial run it on the Super Soft", challengeCompound('f1-2007') === 'supersoft');
  const other = new F12026CarSim(pad);
  other.tireCompound = 'supersoft';
  const fitted: string = other.tireCompound;
  check("another car told to fit a super soft fits its soft", fitted === 'soft', fitted);
  // Switching car in the garage (drive-session's createCar): a car left on its softest starts the next on its softest
  const lc25 = carTyreCompounds('lc25');
  const f07 = carTyreCompounds('f1-2007');
  check(
    'switching car: Soft on the LC25 → Super Soft on the F1 2007, and back; a chosen Medium stays a Medium',
    switchedCarCompound('soft', lc25, f07) === 'supersoft' &&
      switchedCarCompound('supersoft', f07, lc25) === 'soft' &&
      switchedCarCompound('medium', lc25, f07) === 'medium' &&
      switchedCarCompound('soft', lc25, carTyreCompounds('amg-gt3')) === 'soft' &&
      switchedCarCompound('soft', f07, lc25) === 'soft',
  );
  // ≈ 1 % more grip than the Soft at a static corner's load, full from 85 °C where the Soft is from 90
  const ss = compoundData(config, config.compoundSlots.supersoft!);
  const s = compoundData(config, config.compoundSlots.soft);
  const mu = (c: typeof ss, fz: number) => {
    const t = c.modelData.dyCurve!;
    for (let i = 1; i < t.length; i++) if (fz <= t[i][0]) return t[i - 1][1] + ((t[i][1] - t[i - 1][1]) * (fz - t[i - 1][0])) / (t[i][0] - t[i - 1][0]);
    return t[t.length - 1][1];
  };
  const gain = mu(ss, 1600) / mu(s, 1600) - 1;
  check('Super Soft: 0.8–1.2 % more front grip than the Soft at 1.6 kN', gain > 0.008 && gain < 0.012, `${fmt(gain * 100)} %`);
  check('Super Soft: its grip curve full from 85 °C (the Soft from 90)', ss.thermalData.optimalTempC[0] === 85 && s.thermalData.optimalTempC[0] === 90);
  check('Super Soft: shown as SS', ss.shortName === 'SS' && ss.name === 'Bridgestone Super Soft');
}

console.log('\n== Warm-up round RISE on the autopilot (the full layout)');
{
  const glb = 'public/tracks/rwanda_official/rwanda_official.glb';
  const data = 'public/tracks/rwanda_official/track_data.json';
  if (!hasFile(glb) || !hasFile(data)) {
    noteSkip('F1 2007 warm-up at RISE', hasFile(glb) ? data : glb);
  } else {
    setActiveTrack('rwanda_official', JSON.parse(readFileSync(data, 'utf8')) as RawTrackJson);
    const track = getActiveTrackData();
    const root = loadGlbGeometry(glb);
    /**
     * From a flying start on the Soft with the tyres at `start` throughout (the air's, or the blankets' 90 °C): the
     * grip temperature (the bulk, the surface weighed 0.3, by strip load) per axle as the line comes up, and the laps
     */
    const run = (start: number | 'air', laps: number) => {
      const sim = createF12007Sim(track, root);
      sim.tireCompound = 'soft';
      sim.aiAutopilot = true;
      sim.aiPaceScale = 1;
      sim.resetToStartGrid(true);
      const startC = start === 'air' ? sim.vehicle.ambientC : start;
      const W = sim.vehicle.wheels;
      for (const w of W) {
        w.surfaceTempC = w.coreTempC = w.gasTempC = w.rimTempC = startC;
        w.bandTempsC = [startC, startC, startC];
        w.bandCarcassTempsC = [startC, startC, startC];
        w.bandCoreTempsC = [startC, startC, startC];
        w.circumferentialTempsC.fill(startC);
      }
      sim.vehicle.refreshTyrePressures();
      const grip = (front: boolean) =>
        W.filter((w) => w.isFront === front).reduce((sum, w) => sum + [0, 1, 2].reduce((g, b) => g + w.bandLoadShares[b] * (w.bandCarcassTempsC[b] + 0.3 * (w.bandTempsC[b] - w.bandCarcassTempsC[b])), 0), 0) / 2;
      const psi = (front: boolean) => W.filter((w) => w.isFront === front).reduce((sum, w) => sum + w.pressurePsi, 0) / 2;
      const lap0 = sim.telemetry.lapCount;
      const atLine: { front: number; rear: number; psiF: number; psiR: number; lapS: number }[] = [];
      for (let t = 0; t < 200 * (laps + 1) && sim.telemetry.lapCount < lap0 + laps + 1; t += 1 / 60) {
        const before = sim.telemetry.lapCount;
        sim.step(1 / 60, {});
        if (sim.telemetry.lapCount !== before) atLine.push({ front: grip(true), rear: grip(false), psiF: psi(true), psiR: psi(false), lapS: (sim.telemetry.lastLapTimeMs ?? NaN) / 1000 });
      }
      return atLine;
    };
    const cold = run('air', 1);
    const blankets = run(90, 0);
    const out = cold[0];
    const lap = cold[1];
    // The data's intent, replayed on these laps: from the air's 27 °C the grip temperature is ≈ 64 °C front and
    // 78 °C rear by the end of the out-lap and settles at ≈ 66 / 81 °C on the autopilot's pace; off the blankets it
    // falls to that within the out-lap (≈ 67 / 81 °C at the line)
    check(
      'out-lap from cold: grip temperature 59–69 °C front, 73–83 °C rear at the line',
      out !== undefined && out.front > 59 && out.front < 69 && out.rear > 73 && out.rear < 83,
      out ? `${fmt(out.front, 1)} / ${fmt(out.rear, 1)} °C` : 'no line',
    );
    check(
      'flying lap: 62–70 °C front, 76–86 °C rear, the pressures 18.3–19.8 / 19.6–21.0 psi',
      lap !== undefined && lap.front > 62 && lap.front < 70 && lap.rear > 76 && lap.rear < 86 && lap.psiF > 18.3 && lap.psiF < 19.8 && lap.psiR > 19.6 && lap.psiR < 21,
      lap ? `${fmt(lap.front, 1)} / ${fmt(lap.rear, 1)} °C, ${fmt(lap.psiF)} / ${fmt(lap.psiR)} psi, ${fmt(lap.lapS, 3)} s` : 'no lap',
    );
    const b = blankets[0];
    check(
      "out-lap off 90 °C blankets: down to within 3 °C of the cold run's flying lap at the line",
      b !== undefined && lap !== undefined && Math.abs(b.front - lap.front) < 3 && Math.abs(b.rear - lap.rear) < 3,
      b ? `${fmt(b.front, 1)} / ${fmt(b.rear, 1)} °C` : 'no line',
    );
  }
}

if (failures.length) {
  console.log(`\n${failures.length} F1 2007 check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll F1 2007 checks passed.');
