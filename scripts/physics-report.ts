/**
 * Physics validation report: tyre curves, the GT3 against real-car telemetry, the VF26 against its reference data,
 * plausibility bands and the fixed-step integrator, all measured from the simulator's own code and written to
 * docs/physics/ (README.md, one SVG and one CSV per chart). Deterministic: re-running on the same commit gives the
 * same files.
 *
 *   npm run physics:report
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as THREE from 'three';
import { computeTyreForces, createTyreRuntime as createVf26Tyre } from '../src/lib/sim/ac-tyre';
import { VF26_AI_REFERENCE, VF26_TYRES } from '../src/lib/sim/vf26-data';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { compoundData, F12026_CAR_CONFIG, type CarPhysicsConfig } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import {
  combinedSlipForces,
  createTyreRuntime,
  tyrePeakMu,
  tyrePressureGrip,
  VehiclePhysics,
  type TyreRuntime,
} from '../src/lib/sim/f12026-car/VehiclePhysics';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { GT3_REF, measureGt3 } from './lib/gt3-reference';
import { createFlatTestTrack } from './lib/flat-track';
import { lineChart, seriesCsv, type ChartBand, type ChartSeries, type SeriesColor } from './lib/svg-chart';

const OUT = path.join(__dirname, '..', 'docs', 'physics');
fs.mkdirSync(OUT, { recursive: true });
const write = (name: string, body: string) => fs.writeFileSync(path.join(OUT, name), body);
const fmt = (v: number, d = 2) => v.toFixed(d);
const pct = (ours: number, ref: number) => `${ours >= ref ? '+' : ''}${(((ours - ref) / ref) * 100).toFixed(1)} %`;
const DEG = Math.PI / 180;
const sha = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();

const md: string[] = [];
const charts: string[] = [];
function chart(name: string, svg: string, csv: string): string {
  write(`${name}.svg`, svg);
  write(`${name}.csv`, csv);
  charts.push(name);
  return `![${name}](${name}.svg)\n\n<sub>Data: [${name}.csv](${name}.csv)</sub>`;
}

// ---------------------------------------------------------------------------
// 1. Tyres
// ---------------------------------------------------------------------------

/** The f12026-car / GT3 tyre at its working point: optimum temperature and pressure, no camber, new, dry */
interface RigidTyre {
  rt: TyreRuntime;
  tempC: number;
  /** Steady-state lateral force (N) at load fz (N) and slip angle α (rad), as VehiclePhysics computes it */
  fy(fz: number, alphaRad: number): number;
  peakMu(fz: number): number;
}

function rigidTyre(cfg: CarPhysicsConfig, rear = false): RigidTyre {
  const rt = createTyreRuntime(compoundData(cfg, cfg.compoundSlots.soft), rear);
  const th = rt.data.thermalData;
  const tempC = 0.5 * (th.optimalTempC[0] + th.optimalTempC[1]);
  const scale = rt.thermal.evaluate(tempC) * tyrePressureGrip(rt.data.pressureData, rt.data.pressureData.optimalPsi);
  const out = { fx: 0, fy: 0, sx: 0, sy: 0 };
  return {
    rt,
    tempC,
    peakMu: (fz) => tyrePeakMu(rt, fz, 'y') * scale,
    fy(fz, alpha) {
      combinedSlipForces(rt, rt.data.modelData, 0, Math.tan(alpha) / rt.tanPeakAngle, out);
      return tyrePeakMu(rt, fz, 'y') * scale * fz * out.fy;
    },
  };
}

/** The VF26 tyre (ac-tyre's model) at its optimum: fresh, in its window, steady state at 50 m/s */
function vf26Tyre() {
  const spec = VF26_TYRES.soft.front;
  const curve = spec.thermalCurve;
  const tempC = curve.reduce((best, p) => (p[1] > best[1] ? p : best))[0];
  return {
    spec,
    tempC,
    fy(fz: number, alphaRad: number) {
      const t = createVf26Tyre(spec, tempC);
      const v = 50;
      // One long step: the carcass relaxation is integrated exactly, so this is the steady state
      const r = computeTyreForces(t, { fz, vx: v, vy: v * Math.tan(alphaRad), rimSpeed: v, camberLeftRad: 0, surfaceGrip: 1, dt: 1 });
      return Math.abs(r.fy);
    },
  };
}

const gt3Front = rigidTyre(AMG_GT3_CONFIG);
const f1Front = rigidTyre(F12026_CAR_CONFIG);
const vf26Front = vf26Tyre();

const LOADS = [2000, 4000, 6000, 8000];
const LOAD_COLORS: SeriesColor[] = ['r1', 'r2', 'r3', 'r4'];
const alphas = Array.from({ length: 61 }, (_, i) => i * 0.25);

function fySeries(fy: (fz: number, a: number) => number): ChartSeries[] {
  return LOADS.map((fz, i) => {
    const points = alphas.map((a) => [a, fy(fz, a * DEG) / 1000] as const);
    const peak = points.reduce((b, p) => (p[1] > b[1] ? p : b));
    return { name: `${fz / 1000} kN`, color: LOAD_COLORS[i], points, highlight: peak };
  });
}

const tyreCars = [
  { id: 'gt3', label: 'Mercedes-AMG GT3', tyre: 'GT3 soft front', fy: (fz: number, a: number) => gt3Front.fy(fz, a) },
  { id: 'f12026', label: 'FA-26 Rigid-Body (f12026-car)', tyre: 'soft (C3) front', fy: (fz: number, a: number) => f1Front.fy(fz, a) },
  { id: 'vf26', label: 'FA-26 Prototype (VF26)', tyre: 'soft front', fy: (fz: number, a: number) => vf26Front.fy(fz, a) },
];
const fyMd: string[] = [];
for (const c of tyreCars) {
  const series = fySeries(c.fy);
  const yMax = Math.ceil(Math.max(...series.flatMap((s) => s.points.map((p) => p[1]))) + 1);
  const name = `tyre-fy-vs-slip-${c.id}`;
  fyMd.push(
    `**${c.label}**, ${c.tyre}\n\n` +
      chart(
        name,
        lineChart({
          title: `${c.label}: lateral force vs slip angle`,
          subtitle: `${c.tyre[0].toUpperCase()}${c.tyre.slice(1)} at its optimum temperature and pressure, no camber; dot = peak`,
          x: { min: 0, max: 15, step: 3, label: 'Slip angle (deg)' },
          y: { min: 0, max: yMax, step: yMax > 16 ? 4 : 2, label: 'Lateral force (kN)' },
          series,
          description: `Steady-state lateral force of the ${c.tyre} tyre of the ${c.label} against slip angle at 2, 4, 6 and 8 kN vertical load. Each curve rises to a peak near ${c.id === 'vf26' ? vf26Front.spec.frictionLimitAngleDeg.toFixed(1) : ((Math.atan((c.id === 'gt3' ? gt3Front : f1Front).rt.tanPeakAngle) / DEG).toFixed(1))} degrees and falls off gently past it; heavier loads give more force but less per newton (load sensitivity).`,
        }),
        seriesCsv('slip_angle_deg', 'fy_kN', series)
      )
  );
}

// Peak μ vs load, all three cars
const loadsMu = Array.from({ length: 37 }, (_, i) => 1000 + i * 250);
const vf26PeakMu = (fz: number) => {
  // ac-tyre's μ at the peak slip angle, read back from the force at the friction-limit angle
  return vf26Front.fy(fz, vf26Front.spec.frictionLimitAngleDeg * DEG) / fz;
};
const muSeries: ChartSeries[] = [
  { name: 'GT3', color: 's1', points: loadsMu.map((fz) => [fz / 1000, gt3Front.peakMu(fz)] as const) },
  { name: 'f12026-car', color: 's2', points: loadsMu.map((fz) => [fz / 1000, f1Front.peakMu(fz)] as const) },
  { name: 'VF26', color: 's3', points: loadsMu.map((fz) => [fz / 1000, vf26PeakMu(fz)] as const) },
];
const muChart = chart(
  'tyre-mu-vs-load',
  lineChart({
    title: 'Peak friction coefficient vs vertical load',
    subtitle: 'Soft front tyre of each car at its optimum; the drop with load is load sensitivity',
    x: { min: 0, max: 10, step: 2, label: 'Vertical load (kN)' },
    y: { min: 1.2, max: 2.6, step: 0.2, label: 'Peak lateral μ' },
    series: muSeries,
    description: 'Peak lateral friction coefficient of the soft front tyre of the GT3, the f12026-car and the VF26 from 0.5 to 10 kN. All three fall as the load rises, the property that makes weight transfer cost grip.',
  }),
  seriesCsv('fz_kN', 'peak_mu', muSeries)
);

// Grip vs temperature
const temps = Array.from({ length: 41 }, (_, i) => i * 5);
const tSeries: ChartSeries[] = [
  { name: 'GT3', color: 's1', points: temps.map((t) => [t, gt3Front.rt.thermal.evaluate(t)] as const) },
  { name: 'f12026-car', color: 's2', points: temps.map((t) => [t, f1Front.rt.thermal.evaluate(t)] as const) },
  { name: 'VF26', color: 's3', points: temps.map((t) => [t, interp(vf26Front.spec.thermalCurve, t)] as const) },
];
function interp(lut: readonly (readonly [number, number])[], x: number): number {
  if (x <= lut[0][0]) return lut[0][1];
  for (let i = 1; i < lut.length; i++) {
    if (x <= lut[i][0]) {
      const [x0, y0] = lut[i - 1];
      const [x1, y1] = lut[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return lut[lut.length - 1][1];
}
const tempChart = chart(
  'tyre-grip-vs-temperature',
  lineChart({
    title: 'Grip vs tread temperature',
    subtitle: 'Soft compound of each car; 1.0 = full grip in its working window',
    x: { min: 0, max: 200, step: 25, label: 'Tread temperature (°C)' },
    y: { min: 0.5, max: 1.05, step: 0.1, label: 'Grip multiplier' },
    series: tSeries,
    description: 'Grip multiplier against tread temperature for the soft compound of each car. The GT3 slick works from about 70 °C, the F1 tyres from about 90-100 °C; all lose grip cold and when overheated.',
  }),
  seriesCsv('temp_C', 'grip', tSeries)
);

const tyreTable = [
  '| Tyre (soft, front) | Peak slip angle | Peak μ at 4 kN | Working window | Optimum hot pressure |',
  '| :-- | --: | --: | :-- | --: |',
  `| GT3 | ${fmt(Math.atan(gt3Front.rt.tanPeakAngle) / DEG, 1)}° | ${fmt(gt3Front.peakMu(4000))} | ${gt3Front.rt.data.thermalData.optimalTempC.join('–')} °C | ${gt3Front.rt.data.pressureData.optimalPsi} psi |`,
  `| f12026-car | ${fmt(Math.atan(f1Front.rt.tanPeakAngle) / DEG, 1)}° | ${fmt(f1Front.peakMu(4000))} | ${f1Front.rt.data.thermalData.optimalTempC.join('–')} °C | ${f1Front.rt.data.pressureData.optimalPsi} psi |`,
  `| VF26 | ${fmt(vf26Front.spec.frictionLimitAngleDeg, 1)}° | ${fmt(vf26PeakMu(4000))} | peak at ${vf26Front.tempC} °C | ${vf26Front.spec.pressureRefPsi} psi |`,
].join('\n');

// ---------------------------------------------------------------------------
// 2. GT3 against real-car telemetry
// ---------------------------------------------------------------------------

const m = measureGt3();
function gt3Chart(name: string, title: string, rows: [number, number, number][], lo: number, hi: number, yAxis: { min: number; max: number; step: number; label: string }) {
  const sim: ChartSeries = { name: 'Simulator', color: 's1', points: rows.map(([k, o]) => [k, o] as const), markers: true };
  const ref: ChartSeries = { name: 'MoTeC (real car)', color: 's2', points: rows.map(([k, , r]) => [k, r] as const), line: false };
  const band: ChartBand = {
    lower: rows.map(([k, , r]) => [k, r * (1 + lo / 100)] as const),
    upper: rows.map(([k, , r]) => [k, r * (1 + hi / 100)] as const),
    color: 's2',
    label: `CI tolerance ${String(lo).replace('-', '−')}…+${hi} %`,
  };
  const xs = rows.map((r) => r[0]);
  return chart(
    name,
    lineChart({
      title,
      subtitle: 'Mercedes-AMG GT3 model vs reference GT3 Evo MoTeC logs (Valencia, 3 runs)',
      x: { min: Math.floor(Math.min(...xs) / 20) * 20, max: Math.ceil(Math.max(...xs) / 20) * 20, step: 20, label: 'Speed (km/h)' },
      y: yAxis,
      series: [sim, ref],
      bands: [band],
      description: `${title}: the simulator's GT3 against values extracted from real GT3 Evo telemetry at the same speeds, with the tolerance the verify-gt3-telemetry suite enforces on every commit.`,
    }),
    seriesCsv('speed_kmh', 'g', [sim, ref])
  );
}
const gt3Lat = gt3Chart('gt3-lateral-g', 'GT3 sustained lateral g', m.lateralG, -12, 12, { min: 1.2, max: 2.6, step: 0.2, label: 'Lateral acceleration (g)' });
const gt3Brk = gt3Chart('gt3-braking-g', 'GT3 braking g', m.brakingG, -12, 12, { min: 1.2, max: 2.6, step: 0.2, label: 'Deceleration (g)' });
const gt3Thr = gt3Chart('gt3-throttle-g', 'GT3 full-throttle g', m.throttleG, -15, 20, { min: 0, max: 1.2, step: 0.2, label: 'Acceleration (g)' });
const gt3Table = [
  '| Measurement | Speed / gear | Simulator | Real car | Difference |',
  '| :-- | --: | --: | --: | --: |',
  ...m.lateralG.map(([k, o, r]) => `| Sustained lateral g | ${k} km/h | ${fmt(o)} | ${fmt(r)} | ${pct(o, r)} |`),
  ...m.brakingG.map(([k, o, r]) => `| Braking g | ${k} km/h | ${fmt(o)} | ${fmt(r)} | ${pct(o, r)} |`),
  ...m.throttleG.map(([k, o, r]) => `| Full-throttle g | ${k} km/h | ${fmt(o)} | ${fmt(r)} | ${pct(o, r)} |`),
  `| Understeer gradient | – | ${fmt(m.understeerDegPerG)} °/g | ${fmt(GT3_REF.understeerDegPerG)} °/g | ${pct(m.understeerDegPerG, GT3_REF.understeerDegPerG)} |`,
  ...m.rpmPerMs.map(([g, o, r]) => `| Engine rpm per m/s | gear ${g} | ${fmt(o, 1)} | ${fmt(r, 1)} | ${pct(o, r)} |`),
  `| Limiter | – | ${m.limiterRpm} rpm | ${GT3_REF.limiterRpm} rpm | ${pct(m.limiterRpm, GT3_REF.limiterRpm)} |`,
].join('\n');

// ---------------------------------------------------------------------------
// 3. VF26 against its reference data; f12026-car against plausibility bands
// ---------------------------------------------------------------------------

const wideFlat = createFlatTestTrack(40_000, 3000);
/** Best 1 s average lateral g of the VF26 on a slow steer ramp at constant speed (no driver aids) */
function vf26Lateral(vMs: number): number {
  const sim = new F1Physics2026(wideFlat);
  sim.setAssistPreset('pro');
  sim.teleportToDistance(1500, vMs);
  const hist: number[] = [];
  let best = 0;
  const T = 12;
  for (let t = 0; t < T; t += 1 / 120) {
    const throttle = THREE.MathUtils.clamp(0.25 + 0.6 * (vMs - sim.vxMs), 0, 1);
    sim.step(1 / 120, { throttle, analogSteer: Math.min(1, t / T) * Math.min(1, (24 / vMs) ** 1.5) });
    hist.push(Math.abs(sim.telemetry.lateralG));
    if (hist.length > 120) hist.shift();
    if (hist.length === 120) best = Math.max(best, hist.reduce((a, b) => a + b, 0) / 120);
    if (Math.abs(Math.atan2(sim.vyMs, Math.max(1, Math.abs(sim.vxMs)))) > 0.35) break;
  }
  return best;
}
const vfRef = VF26_AI_REFERENCE.lateral.map(([v, a]) => [v * 3.6, a / 9.81] as const);
const vfSim = VF26_AI_REFERENCE.lateral.map(([v]) => [v * 3.6, vf26Lateral(v)] as const);
const vfSeries: ChartSeries[] = [
  { name: 'Simulator', color: 's1', points: vfSim, markers: true },
  { name: 'Reference data', color: 's2', points: vfRef, line: false },
];
const vfChart = chart(
  'vf26-lateral-g',
  lineChart({
    title: 'VF26 sustained lateral g vs speed',
    subtitle: "Simulator (no aids, steer ramp at constant speed) vs the car package's own cornering-limit table",
    x: { min: 80, max: 260, step: 30, label: 'Speed (km/h)' },
    y: { min: 1.6, max: 4.4, step: 0.4, label: 'Lateral acceleration (g)' },
    series: vfSeries,
    description: 'Best one-second lateral acceleration of the VF26 on a slow steering ramp at constant speed, against the cornering-limit table that ships with its reference car data. Downforce makes the limit rise with speed.',
  }),
  seriesCsv('speed_kmh', 'g', vfSeries)
);
const vfGaps = vfSim.map(([, o], i) => ((vfRef[i][1] - o) / vfRef[i][1]) * 100);
const vfGapMin = Math.min(...vfGaps).toFixed(0);
const vfGapMax = Math.max(...vfGaps).toFixed(0);
const vfTable = [
  '| Speed | Simulator | Reference data | Difference |',
  '| --: | --: | --: | --: |',
  ...vfSim.map(([k, o], i) => `| ${fmt(k, 0)} km/h | ${fmt(o)} g | ${fmt(vfRef[i][1])} g | ${pct(o, vfRef[i][1])} |`),
].join('\n');

/** f12026-car: peak lateral g on its CI steer ramp (verify-f12026-car), and 300→100 km/h braking */
function rigidLateral(cfg: CarPhysicsConfig, kmh: number): number {
  const car = new VehiclePhysics({ ground: new FlatGroundQuery(0), config: cfg });
  car.reset(0, 0, 0, kmh / 3.6);
  let maxLat = 0;
  let pedal = 0.3;
  for (let t = 0; t < 8; t += 1 / 120) {
    pedal = THREE.MathUtils.clamp(pedal + (car.telemetry.speedKmh < kmh ? 0.02 : -0.02), 0, 1);
    car.step(1 / 120, { throttle: pedal, brake: 0, steer: -Math.min(1, t / 8) * 0.9 });
    maxLat = Math.max(maxLat, Math.abs(car.telemetry.latG));
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(car.quaternion);
    const lat = new THREE.Vector3(1, 0, 0).applyQuaternion(car.quaternion);
    if (Math.abs(Math.atan2(car.velocity.dot(lat), car.velocity.dot(fwd))) > 0.35) break;
  }
  return maxLat;
}
const f1Lat120 = rigidLateral(F12026_CAR_CONFIG, 120);
const f1Lat240 = rigidLateral(F12026_CAR_CONFIG, 240);
const plausTable = [
  '| Car | Check | Simulator | Accepted range | Source of the range |',
  '| :-- | :-- | --: | :-- | :-- |',
  `| f12026-car | Peak lateral g at 120 km/h | ${fmt(f1Lat120)} g | 2.2–3.8 g | 2026 F1 cars, engineering band |`,
  `| f12026-car | Peak lateral g at 240 km/h | ${fmt(f1Lat240)} g | 3.4–5.5 g | 2026 F1 cars, engineering band |`,
].join('\n');

// ---------------------------------------------------------------------------
// 4. Fixed-step integrator: the same drive at different frame rates
// ---------------------------------------------------------------------------

interface FrameRateCar {
  step(dt: number, i: object): void;
  speed(): number;
  dist(): number;
}
const RATES = [30, 60, 144, 240];
function frameRateRow(label: string, make: () => FrameRateCar) {
  const res = RATES.map((hz) => {
    const car = make();
    for (let i = 0; i < hz * 3; i++) car.step(1 / hz, { throttle: 1, analogSteer: -0.05 });
    return { speed: car.speed(), dist: car.dist() };
  });
  const ref = res[res.length - 1];
  const dv = Math.max(...res.map((r) => Math.abs(r.speed - ref.speed))) * 3.6;
  const ds = Math.max(...res.map((r) => Math.abs(r.dist - ref.dist)));
  return `| ${label} | ${res.map((r) => fmt(r.speed * 3.6, 2)).join(' | ')} | ${fmt(dv, 2)} km/h | ${fmt(ds, 2)} m |`;
}
const track = createFlatTestTrack(20_000, 600);
const standing = (s: { resetToStartGrid(f?: boolean): void }) => s.resetToStartGrid(false);
const integratorTable = [
  '| Car (3 s from a standing start, full throttle, slight steer) | 30 Hz | 60 Hz | 144 Hz | 240 Hz | Largest speed difference | Largest distance difference |',
  '| :-- | --: | --: | --: | --: | --: | --: |',
  frameRateRow('VF26 (km/h)', () => {
    const s = new F1Physics2026(track);
    standing(s);
    return { step: (dt, i) => s.step(dt, i as never), speed: () => s.vxMs, dist: () => s.sMeters };
  }),
  frameRateRow('f12026-car (km/h)', () => {
    const s = new F12026CarSim(track);
    standing(s);
    return { step: (dt, i) => s.step(dt, i as never), speed: () => s.vxMs, dist: () => s.sMeters };
  }),
  frameRateRow('GT3 (km/h)', () => {
    const s = createAmgGt3Sim(track);
    standing(s);
    return { step: (dt, i) => s.step(dt, i as never), speed: () => s.vxMs, dist: () => s.sMeters };
  }),
].join('\n');

// ---------------------------------------------------------------------------
// 5. Where the numbers come from
// ---------------------------------------------------------------------------

const root = path.join(__dirname, '..');
function tagCounts(file: string): Record<string, number> {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const counts: Record<string, number> = {};
  for (const mm of text.matchAll(/\[(mod|setup|derived|assumed|spec|est|motec|ref_[a-z_]+\.ini)\b[^\]]*\]/g)) {
    const k = mm[1].startsWith('ref_') ? 'ref' : mm[1];
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}
const prov = {
  gt3: tagCounts('src/lib/sim/gt3/AmgGt3Config.ts'),
  f1: tagCounts('src/lib/sim/f12026-car/F12026CarConfig.ts'),
  vf: tagCounts('src/lib/sim/vf26-data.ts'),
};
const c = (r: Record<string, number>, ...k: string[]) => k.reduce((s, x) => s + (r[x] ?? 0), 0) || '–';
const provTable = [
  '| Car | Fit to real-car telemetry | Reference car data | Specification | Regulations baseline | Engineering estimate | Derived |',
  '| :-- | --: | --: | --: | --: | --: | --: |',
  `| GT3 (\`AmgGt3Config.ts\`) | ${c(prov.gt3, 'motec')} | – | ${c(prov.gt3, 'spec')} | – | ${c(prov.gt3, 'est')} | ${c(prov.gt3, 'derived')} |`,
  `| f12026-car (\`F12026CarConfig.ts\`) | – | ${c(prov.f1, 'ref')} | ${c(prov.f1, 'spec')} | – | ${c(prov.f1, 'est')} | ${c(prov.f1, 'derived')} |`,
  `| VF26 (\`vf26-data.ts\`) | – | ${c(prov.vf, 'mod', 'setup')} | – | ${c(prov.vf, 'assumed')} | – | ${c(prov.vf, 'derived')} |`,
].join('\n');

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

md.push(
  `# Physics validation`,
  '',
  `Generated by \`npm run physics:report\` from commit \`${sha}\`. Every number, chart and CSV here is measured from the simulator's own code: the same tyre functions and the same 500 Hz vehicle step the game runs. Re-run it after a physics change and the diff shows what moved.`,
  '',
  `How much each comparison proves differs, so each section says what it is compared against:`,
  '',
  `- **Real-car telemetry**: the Mercedes-AMG GT3 against values extracted from reference GT3 Evo MoTeC logs. This is the only comparison with a measured car.`,
  `- **Reference data**: the VF26 against the cornering-limit table that ships with its reference car data. This checks that the simulator reproduces its inputs, not that those inputs match a real car.`,
  `- **Plausibility bands**: ranges a car of the class should fall in. CI enforces them on every commit (\`npm run verify\`).`,
  '',
  `## Tyres`,
  '',
  `Steady-state lateral force against slip angle at four loads. The force rises almost linearly, peaks, then falls away gently as the contact patch slides. Heavier loads give more force but less per newton, which is load sensitivity and the reason weight transfer costs grip. The working point is the tyre's optimum temperature and pressure, with no camber, new and dry; in the game, temperature, pressure, camber, wear, graining and water all scale this curve.`,
  '',
  ...fyMd.flatMap((s) => [s, '']),
  muChart,
  '',
  tempChart,
  '',
  tyreTable,
  '',
  `## Mercedes-AMG GT3 against real-car telemetry`,
  '',
  `The reference values come from three runs (~24 minutes) of GT3 Evo MoTeC logs at Valencia: sustained lateral g by speed, braking g by speed (95th percentile above 60 % pedal), full-throttle g by speed, engine rpm per m/s by gear, and the understeer gradient. They were a quick driver's laps, so they are lower bounds of the car. The simulator runs the same manoeuvres on flat ground at sea-level air density, without driver aids, holding the slip the real car's ABS and TC allowed (\`scripts/lib/gt3-reference.ts\`). \`verify-gt3-telemetry\` fails the build if any point leaves the shaded tolerance.`,
  '',
  gt3Lat,
  '',
  gt3Brk,
  '',
  gt3Thr,
  '',
  gt3Table,
  '',
  `## VF26 against its reference data`,
  '',
  `The VF26's tyre, aero and chassis values come from reference data from a community car package, which also ships the cornering-limit table plotted here. The simulator is never given that table: it reaches its own limit from its tyres, aero and suspension.`,
  '',
  `It stays ${vfGapMin}–${vfGapMax} % below the table, most at the low-speed end. There the car runs out of front grip: the peak comes at about half lock and more steering adds nothing. Because the table comes from the same package, this gap is a known difference to look into, not a pass.`,
  '',
  vfChart,
  '',
  vfTable,
  '',
  `## Plausibility bands`,
  '',
  `The f12026-car has no measured reference, so its checks are ranges a 2026 F1 car should fall in. The same ramps run in \`verify-f12026-car\`.`,
  '',
  plausTable,
  '',
  `## The fixed-step integrator`,
  '',
  `Physics advances in fixed 2 ms steps (500 Hz), each split into four 0.5 ms substeps (2 kHz) for the tyres and suspension. Rendering runs at whatever rate the screen allows, and the simulation catches up in whole steps, so the same drive should end in the same place at any frame rate. The table shows the speed after three seconds at four frame rates, and the largest difference from the 240 Hz run.`,
  '',
  `What is left comes from two places. The simulation can end up to one 2 ms step ahead or behind, depending on how the frame times add up. And in the f12026-car and GT3 the driver aids (traction control, ABS) run in slices that follow the frame length, so on a launch with wheelspin they react a little differently at different frame rates. The vehicle physics underneath is the same fixed step.`,
  '',
  `This shows frame-rate independence. It is not a step-size convergence study: every run uses the same 500 Hz step.`,
  '',
  integratorTable,
  '',
  `## Where the numbers come from`,
  '',
  `Every value in the car data files carries a tag saying where it came from. These counts are read from the files when the report is generated; one tag can cover a group of related values.`,
  '',
  provTable,
  '',
  `- **Fit to real-car telemetry** (\`[motec]\`): tuned until the simulator reproduces the MoTeC table above.`,
  `- **Reference car data** (\`[mod]\`, \`[setup]\`, \`[ref_….ini]\`): taken from reference car data packages (see CREDITS.md).`,
  `- **Specification** (\`[spec]\`): car, engine, tyre and regulation figures, as tagged in each file.`,
  `- **Regulations baseline** (\`[assumed]\`): 2026 FIA technical-regulation values where the reference data had none.`,
  `- **Engineering estimate** (\`[est]\`) and **derived** (\`[derived]\`): inferred, or computed from other values in the same file.`,
  ''
);
write('README.md', md.join('\n'));
console.log(`docs/physics: README.md + ${charts.length} charts (${charts.join(', ')})`);
