/**
 * Measures each car body's plan for its vehicle model's `chassis.bodyPlan` (the outline the barriers meet):
 *
 *   npx tsx scripts/cars/measure-car-plans.ts [carsDir]
 *
 * For every registry car's model found under `carsDir` (default public/cars; the models are hosted, so a clone may
 * have none): its BODY node's vertices from 8 cm to 0.8 m above the model's floor, placed as its rig places the model
 * on its vehicle model's chassis, folded onto the right half and hulled, then simplified to within 5 cm. Prints [half width, z from the axles' midpoint] points
 * from the nose round to the tail, ready to paste, and the outline the vehicle model has now.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { loadGlbGeometry } from '../lib/glb-geometry';
import { CARS } from '../../src/lib/cars/car-registry';
import { LC26_MODEL_URL } from '../../src/lib/lc26-car-model';
import { VEHICLE_MODELS } from '../../src/lib/cars/vehicle-models';
import { getActiveTrackData } from '../../src/lib/track-data';
import type { F12026CarSim } from '../../src/lib/sim/f12026-car/F12026CarSim';

type Pt = [number, number];
const carsDir = process.argv[2] ?? path.join('public', 'cars');
const BAND_M: [number, number] = [0.08, 0.8];
const TOLERANCE_M = 0.05;

function hull(ps: Pt[]): Pt[] {
  const p = [...ps].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Pt[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up: Pt[] = [];
  for (const q of p.reverse()) {
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Douglas–Peucker on an open chain */
function simplify(c: Pt[], tol: number): Pt[] {
  if (c.length <= 2) return c;
  const [a, b] = [c[0], c[c.length - 1]];
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l = Math.hypot(dx, dz) || 1;
  let worst = -1;
  let wi = 0;
  for (let i = 1; i < c.length - 1; i++) {
    const d = Math.abs((c[i][0] - a[0]) * dz - (c[i][1] - a[1]) * dx) / l;
    if (d > worst) {
      worst = d;
      wi = i;
    }
  }
  if (worst <= tol) return [a, b];
  return simplify(c.slice(0, wi + 1), tol).slice(0, -1).concat(simplify(c.slice(wi), tol));
}

const track = getActiveTrackData();
for (const car of CARS) {
  // The Prototype wears its own body (`lc26-car-model.ts`), fitted by its front axle; the ported cars by their axles'
  // midpoint (`ported-car-model.ts`)
  const url = car.modelUrl ?? (car.physics === 'lc26' ? LC26_MODEL_URL : null);
  if (!url) continue;
  const byFrontAxle = !car.modelUrl;
  const file = path.join(carsDir, url.replace(/^\/cars\//, ''));
  if (!fs.existsSync(file)) {
    console.log(`${car.id}: no model at ${file}`);
    continue;
  }
  const model = VEHICLE_MODELS[car.physics];
  const ch = model.rigConfig.chassis;
  const root = loadGlbGeometry(file);
  root.updateMatrixWorld(true);
  let carNode: THREE.Object3D | undefined;
  root.traverse((o) => {
    if (!carNode && (o.userData as { wheelCentres?: unknown }).wheelCentres) carNode = o;
  });
  const centres = (carNode?.userData as { wheelCentres?: Record<string, number[]> } | undefined)?.wheelCentres;
  const lf = centres?.WHEEL_LF ?? [0.8, 0.35, 1.5];
  const lr = centres?.WHEEL_LR ?? [0.8, 0.35, -1.5];
  // Where the physics' axle midpoint lands on the model: z here is from it
  const modelMid = byFrontAxle ? lf[2] - 0.5 * ch.wheelbase : 0.5 * (lf[2] + lr[2]);
  const body = root.getObjectByName('BODY') ?? root;
  const v = new THREE.Vector3();
  let floor = Infinity;
  body.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const pos = (o.geometry as THREE.BufferGeometry).getAttribute('position');
    for (let i = 0; i < pos.count; i++) floor = Math.min(floor, v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).y);
  });
  const half: Pt[] = [];
  body.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const pos = (o.geometry as THREE.BufferGeometry).getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.y < floor + BAND_M[0] || v.y > floor + BAND_M[1]) continue;
      half.push([Math.abs(v.x), v.z - modelMid]);
    }
  });
  let nose = -Infinity;
  let tail = Infinity;
  for (const q of half) {
    nose = Math.max(nose, q[1]);
    tail = Math.min(tail, q[1]);
  }
  half.push([0, nose], [0, tail]);
  // The hull's chain from the nose tip round the outer side to the tail tip
  const h = hull(half);
  const top = h.findIndex((q) => q[0] === 0 && q[1] === nose);
  const chain: Pt[] = [h[top]];
  for (let k = 1; k < h.length; k++) {
    const q = h[(top - k + h.length) % h.length];
    chain.push(q);
    if (q[0] === 0) break;
  }
  if (chain[1][0] === 0) chain.reverse();
  const plan = simplify(chain, TOLERANCE_M);
  const sim = model.createSim(track, null, car.bodyPlan) as unknown as Partial<F12026CarSim>;
  const probes = sim.vehicle?.wallProbePoints.map((p) => `(${p.x.toFixed(2)}, ${p.z.toFixed(2)})`).join(' ') ?? '(not on the rigid-body engine)';
  const mid = ch.wheelbase * (0.5 - ch.frontWeightFraction);
  console.log(`${car.id} on ${car.physics}: body ${(nose - tail).toFixed(2)} m long from ${(tail + mid).toFixed(2)} to ${(nose + mid).toFixed(2)} m off the CG`);
  console.log(`    bodyPlan: [${plan.map((q) => `[${q[0].toFixed(2)}, ${q[1].toFixed(2)}]`).join(', ')}],`);
  console.log(`    the model's outline now (x, z from the CG): ${probes}`);
}
