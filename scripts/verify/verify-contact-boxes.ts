/**
 * Checks for each car's own box for car-to-car contact (`contact-box.ts`, `f12026-car/body-outline.ts`).
 *
 *   npx tsx scripts/verify/verify-contact-boxes.ts
 *
 * Every car used to meet the others as the same 5 × 1.95 m box centred on its CG, so small cars touched early: two
 * Lianas ~0.7 m apart nose to tail, ~0.15 m apart side by side.
 *
 *  1. Each vehicle model's box is its barrier outline's extents (the body's plan and the tyres), the same from its
 *     simulation, from its config alone and for another player's car of that model; a body worn on another model
 *     (the GT3's) is boxed by that body's plan; a model without a measured plan keeps the old box
 *  2. Sizes: a Liana ~4.3 × 1.8 m, the LC26 ~5.4 m, the AMG GT3 ~4.6 m, every box centred within 0.5 m of its CG
 *  3. Two Lianas 1.8 m apart side by side, or 4.5 m nose to tail, don't touch (as the old boxes they did); two
 *     GT3s 4.5 m apart nose to tail do
 *  4. The solver offsets each box from its CG: two boxes meet where their outlines do, and a side hit level with a
 *     car's CG turns it not at all (its lever arms are from the CG, not the box's centre)
 *  5. Against an exact polygon test over random poses, the solver finds every overlap of offset boxes, and the
 *     field's broad phase (the boxes' reach from their CGs) never drops one
 *  6. Another player's car (`resolvePlayerVsRemoteCar`): a Liana beside a Liana, and an unknown model's old box
 *  7. Damage is placed from the box's centre: the box's front and rear edges are the front and rear
 */
import { getActiveTrackData } from '../../src/lib/track-data';
import { VEHICLE_MODELS } from '../../src/lib/cars/vehicle-models';
import { F12026CarSim } from '../../src/lib/sim/f12026-car/F12026CarSim';
import { compoundData } from '../../src/lib/sim/f12026-car/F12026CarConfig';
import { contactBoxOfConfig } from '../../src/lib/sim/f12026-car/body-outline';
import { DEFAULT_CONTACT_BOX, type ContactBox } from '../../src/lib/sim/contact-box';
import { remoteContactBox, resolvePlayerVsRemoteCar } from '../../src/lib/sim/ai-opponents';
import { resolveCarToCarObbCollision, type RigidBodyCollisionCar } from '../../src/lib/sim/track-evolution';
import { CarDamage } from '../../src/lib/sim/car-damage';
import type { InterpolatedPeerState } from '../../src/lib/sim/multiplayer-sync';
import type { VehicleModelId } from '../../src/types/f1';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(70)} ${detail}`);
  if (!ok) failures.push(name);
};
const f = (v: number, d = 3) => v.toFixed(d);
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;
const sameBox = (a: ContactBox, b: ContactBox) =>
  near(a.halfLengthM, b.halfLengthM) && near(a.halfWidthM, b.halfWidthM) && near(a.centreAheadM, b.centreAheadM) && near(a.reachM, b.reachM);

const track = getActiveTrackData();
const ids = Object.keys(VEHICLE_MODELS) as VehicleModelId[];
const sims = new Map<VehicleModelId, F12026CarSim>();
for (const id of ids) {
  const car = VEHICLE_MODELS[id].createSim(track, null);
  if (car instanceof F12026CarSim) sims.set(id, car);
}

// ---- 1. The box is the outline's extents, the same however it is reached
console.log('\n1. Each model\'s box from its outline');
for (const id of ids) {
  const sim = sims.get(id);
  if (!sim) {
    check(`${id}: on the rigid-body engine`, false, 'no F12026CarSim');
    continue;
  }
  const box = sim.contactBox;
  const cfg = sim.config;
  const ch = cfg.chassis;
  const a = ch.wheelbase * (1 - ch.frontWeightFraction);
  const b = ch.wheelbase * ch.frontWeightFraction;
  const tyres = compoundData(cfg, cfg.compoundSlots.soft);
  const halfF = 0.5 * ch.trackWidthFront + 0.5 * tyres.front.width;
  const halfR = 0.5 * ch.trackWidthRear + 0.5 * tyres.rear.width;
  const detail = `${f(2 * box.halfLengthM, 2)} × ${f(2 * box.halfWidthM, 2)} m, centre ${f(box.centreAheadM, 2)} m ahead of the CG`;
  if (ch.bodyPlan?.length) {
    // The outline's extents worked out here from the config: the plan's (z from the axles' midpoint) and the tyres'
    const mid = 0.5 * (a - b);
    const front = Math.max(...ch.bodyPlan.map(([, z]) => z + mid), a + tyres.front.radius);
    const rear = Math.min(...ch.bodyPlan.map(([, z]) => z + mid), -b - tyres.rear.radius);
    const halfW = Math.max(...ch.bodyPlan.map(([x]) => x), halfF, halfR);
    check(
      `${id}: box = outline extents`,
      near(box.halfLengthM, 0.5 * (front - rear)) && near(box.centreAheadM, 0.5 * (front + rear)) && near(box.halfWidthM, halfW),
      detail
    );
  } else {
    // No measured plan: the barrier outline is the axles and wings, short of the body, so the old box stays
    check(`${id}: no body plan, the old box`, sameBox(box, DEFAULT_CONTACT_BOX), detail);
  }
  check(`${id}: the same from the config alone and for a remote car`, sameBox(contactBoxOfConfig(cfg), box) && sameBox(remoteContactBox(id), box));
  check(`${id}: an AI car of the model has the same box`, sameBox(sim.createAiPeerCar().contactBox, box));
}
{
  // The BMW M4 GT3's body on the AMG's model: 28 cm longer, its tail 18 cm further back (`car-registry.ts`)
  const bmwPlan = [[0.0, 2.32], [0.61, 2.24], [0.94, 2.01], [1.02, 1.84], [1.02, 0.8], [1.02, -1.83], [0.87, -2.27], [0.61, -2.46], [0.48, -2.52], [0.0, -2.52]] as const;
  const worn = VEHICLE_MODELS['amg-gt3'].createSim(track, null, bmwPlan).contactBox;
  const own = sims.get('amg-gt3')!.contactBox;
  check(
    'a body worn on another model is boxed by that body',
    !!worn && near(2 * worn.halfLengthM, 2.32 + 2.52, 1e-9) && worn.halfWidthM >= 1.02 && worn.halfLengthM > own.halfLengthM,
    worn ? `${f(2 * worn.halfLengthM, 2)} m long against the AMG's ${f(2 * own.halfLengthM, 2)} m` : 'none'
  );
}
check('an unknown model keeps the old 5 × 1.95 m box', sameBox(remoteContactBox(undefined), DEFAULT_CONTACT_BOX) && DEFAULT_CONTACT_BOX.halfLengthM === 2.5 && DEFAULT_CONTACT_BOX.halfWidthM === 0.975);

// ---- 2. Sizes
console.log('\n2. Sizes');
const box = (id: VehicleModelId) => sims.get(id)!.contactBox;
const liana = box('liana');
const lc26 = box('lc26');
const gt3 = box('amg-gt3');
check('Liana ~4.2-4.4 m long', 2 * liana.halfLengthM > 4.2 && 2 * liana.halfLengthM < 4.4, `${f(2 * liana.halfLengthM, 2)} m`);
check('Liana ~1.7-1.85 m wide with its tyres', 2 * liana.halfWidthM > 1.7 && 2 * liana.halfWidthM <= 1.85, `${f(2 * liana.halfWidthM, 2)} m`);
check('LC26 ~5.3-5.7 m long', 2 * lc26.halfLengthM > 5.3 && 2 * lc26.halfLengthM < 5.7, `${f(2 * lc26.halfLengthM, 2)} m`);
check('AMG GT3 ~4.5-4.8 m long', 2 * gt3.halfLengthM > 4.5 && 2 * gt3.halfLengthM < 4.8, `${f(2 * gt3.halfLengthM, 2)} m`);
for (const id of ids) {
  const b = box(id);
  check(`${id}: centre within 0.5 m of the CG, the CG inside the box`, Math.abs(b.centreAheadM) < 0.5 && Math.abs(b.centreAheadM) < b.halfLengthM, `${f(b.centreAheadM, 2)} m`);
}

// ---- 3. Side by side and nose to tail
console.log('\n3. Side by side and nose to tail');
/** A box for the solver: CG at (x, z), heading h (rad from +Z towards +X), as the field fills it */
function obb(b: ContactBox, x: number, z: number, h = 0, vx = 0, vz = 0): RigidBodyCollisionCar {
  return {
    x, y: 0, z, fwdX: Math.sin(h), fwdZ: Math.cos(h), vx, vz, yawRateRadS: 0, massKg: 1000, yawInertiaKgM2: 1500,
    halfLengthM: b.halfLengthM, halfWidthM: b.halfWidthM, centreAheadM: b.centreAheadM,
  };
}
const touch = (b1: ContactBox, b2: ContactBox, dx: number, dz: number) => resolveCarToCarObbCollision(obb(b1, 0, 0), obb(b2, dx, dz)).collided;
check('two Lianas 1.8 m apart side by side: no contact', !touch(liana, liana, 1.8, 0));
check('  ... as the old boxes: contact', touch(DEFAULT_CONTACT_BOX, DEFAULT_CONTACT_BOX, 1.8, 0));
check('two Lianas 1.7 m apart side by side: contact', touch(liana, liana, 1.7, 0));
check('two Lianas 4.5 m apart nose to tail: no contact', !touch(liana, liana, 0, 4.5));
check('  ... as the old boxes: contact', touch(DEFAULT_CONTACT_BOX, DEFAULT_CONTACT_BOX, 0, 4.5));
check('two GT3s 4.5 m apart nose to tail: contact', touch(gt3, gt3, 0, 4.5));

// ---- 4. The offset in the solver
console.log('\n4. Boxes offset from the CG');
{
  // A Liana (box behind its CG) with an LC26 (box ahead of its CG) ahead of it: they meet where the Liana's nose
  // reaches the LC26's tail
  const meet = liana.centreAheadM + liana.halfLengthM - (lc26.centreAheadM - lc26.halfLengthM);
  check(
    'Liana behind an LC26: contact where the outlines meet',
    touch(liana, lc26, 0, meet - 0.01) && !touch(liana, lc26, 0, meet + 0.01),
    `${f(meet, 2)} m between CGs (centred boxes: ${f(liana.halfLengthM + lc26.halfLengthM, 2)} m)`
  );
  // An LC26 moving across into a Liana's side, level with the Liana's CG: a push, no turn
  const side = resolveCarToCarObbCollision(obb(liana, 0, 0), obb(lc26, liana.halfWidthM + lc26.halfLengthM + lc26.centreAheadM - 0.02, 0, -Math.PI / 2, -5, 0));
  check(
    'a side hit level with the CG pushes without turning',
    side.collided && side.impactSpeedMs > 4 && Math.abs(side.yawDeltaA) < 1e-9,
    `impact ${f(side.impactSpeedMs, 1)} m/s, yaw ${side.yawDeltaA.toExponential(1)} rad/s`
  );
}

// ---- 5. Against an exact polygon test
console.log('\n5. Random poses');
type P = [number, number];
function corners(o: RigidBodyCollisionCar): P[] {
  const c = o.centreAheadM ?? 0;
  const cx = o.x + o.fwdX * c;
  const cz = o.z + o.fwdZ * c;
  const lx = o.fwdZ;
  const lz = -o.fwdX;
  return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([s, t]) => [cx + s * o.halfLengthM * o.fwdX + t * o.halfWidthM * lx, cz + s * o.halfLengthM * o.fwdZ + t * o.halfWidthM * lz] as P);
}
const cross = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function inside(p: P, poly: P[]): boolean {
  let pos = false;
  let neg = false;
  for (let i = 0; i < poly.length; i++) {
    const c = cross(poly[i], poly[(i + 1) % poly.length], p);
    if (c > 0) pos = true;
    if (c < 0) neg = true;
  }
  return !(pos && neg);
}
function segmentsCross(a: P, b: P, c: P, d: P): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
function overlapExact(p: P[], q: P[]): boolean {
  if (p.some((x) => inside(x, q)) || q.some((x) => inside(x, p))) return true;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (segmentsCross(p[i], p[(i + 1) % 4], q[j], q[(j + 1) % 4])) return true;
  return false;
}
{
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const pool = [liana, lc26, gt3, box('lc-lmdh'), box('vw-scirocco-gtx'), DEFAULT_CONTACT_BOX];
  let overlaps = 0;
  let mismatch = 0;
  let dropped = 0;
  for (let k = 0; k < 40000; k++) {
    const b1 = pool[Math.floor(rnd() * pool.length)];
    const b2 = pool[Math.floor(rnd() * pool.length)];
    const A = obb(b1, 0, 0, rnd() * 2 * Math.PI);
    const B = obb(b2, (rnd() - 0.5) * 12, (rnd() - 0.5) * 12, rnd() * 2 * Math.PI);
    const exact = overlapExact(corners(A), corners(B));
    // A pose within a millimetre of touching can fall either way
    const grazing = overlapExact(corners({ ...A, halfLengthM: A.halfLengthM + 0.001, halfWidthM: A.halfWidthM + 0.001 }), corners(B)) !==
      overlapExact(corners({ ...A, halfLengthM: A.halfLengthM - 0.001, halfWidthM: A.halfWidthM - 0.001 }), corners(B));
    if (exact) overlaps++;
    if (!grazing && resolveCarToCarObbCollision(A, B).collided !== exact) mismatch++;
    // The field's broad phase: CGs within the two boxes' reach
    const reach = b1.reachM + b2.reachM;
    if (exact && B.x * B.x + B.z * B.z > reach * reach) dropped++;
  }
  check('the solver agrees with an exact polygon test', mismatch === 0, `${mismatch} of 40000 poses (${overlaps} overlapping)`);
  check('the broad phase never drops an overlap', dropped === 0, `${dropped}`);
}
for (const id of ids) {
  const b = box(id);
  const far = Math.max(...corners(obb(b, 0, 0)).map(([x, z]) => Math.hypot(x, z)));
  if (!near(far, b.reachM)) check(`${id}: reach is the farthest corner`, false, `${f(b.reachM)} against ${f(far)}`);
}

// ---- 6. Another player's car
console.log('\n6. Another player\'s car');
{
  const me = sims.get('liana')!;
  me.teleportToDistance(300, 0, 0);
  const q = me.worldQuaternion;
  let fx = 2 * (q.x * q.z + q.w * q.y);
  let fz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const l = Math.hypot(fx, fz);
  fx /= l;
  fz /= l;
  const p0 = me.worldPosition.clone();
  const beside = (vehicle: VehicleModelId | undefined, apart: number): boolean => {
    me.teleportToDistance(300, 0, 0);
    const state = {
      vehicle,
      contactReady: true,
      // left is (fz, −fx)
      position: p0.clone().set(p0.x + fz * apart, p0.y, p0.z - fx * apart),
      quaternion: q.clone(),
      linearVelocity: p0.clone().set(0, 0, 0),
      yawRateRadS: 0,
    } as unknown as InterpolatedPeerState;
    return resolvePlayerVsRemoteCar(me, state);
  };
  check('a Liana 1.8 m beside another player\'s Liana: no contact', !beside('liana', 1.8));
  check('a Liana 1.7 m beside another player\'s Liana: contact', beside('liana', 1.7));
  check('an unknown model 1.8 m beside: contact (its old 1.95 m box)', beside(undefined, 1.8));
}

// ---- 7. Damage placed from the box's centre
console.log('\n7. Damage');
{
  const zone = (localX: number, localZ: number) =>
    new CarDamage('full', liana.halfLengthM, liana.halfWidthM, () => 0.5, liana.centreAheadM).registerImpact({ localX, localZ, speedMs: 12, source: 'car' })?.zone;
  const c = liana.centreAheadM;
  check('the box\'s front edge is the front', zone(0, c + liana.halfLengthM) === 'front');
  check('the box\'s rear edge is the rear', zone(0, c - liana.halfLengthM) === 'rear', `rear edge ${f(c - liana.halfLengthM, 2)} m from the CG`);
  check('the box\'s side at its centre is the side', zone(liana.halfWidthM, c) === 'left' && zone(-liana.halfWidthM, c) === 'right');
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nAll contact-box checks passed');
process.exit(failures.length ? 1 : 0);
