/**
 * A converted car's aero matched by driving it: another game states its downforce and drag in its own terms (body lift
 * coefficients, wing areas at an angle), and the base model's aero is a set of elements with their own tables (wings
 * with angle and ride-height curves, or a ride-height map). Rather than translate one model into the other, this keeps
 * the base's elements and their shape and scales them until the car, driven straight at a steady speed on the flat test
 * pad in the game's own simulation, makes the source's downforce on each axle and its drag:
 *
 *  - element aero (wings, floor): the elements ahead of the CG and the body's front lift by one factor, those behind by
 *    another, found from three runs (a linear model of each axle's downforce in the two factors); what they can't give
 *    (a lift, a share past them) goes into the body's front and rear lift, and the drag that is left into its drag;
 *  - a ride-height map: its downforce scaled to the total, its balance grid moved to the front share, its drag scaled,
 *    and the wings with it, a few times over until the runs agree.
 *
 * Targets are in N per (m/s)² on each axle (+ = down) and of drag.
 */
import { F12026CarSim, type CarSimProfile } from "../../../src/lib/sim/f12026-car/F12026CarSim";
import type { WingData } from "../../../src/lib/sim/f12026-car/F12026CarConfig";
import { createFlatTestTrack } from "../../lib/flat-track";

export interface AeroTargets {
  front: number;
  rear: number;
  drag: number;
}

export interface AeroFit {
  /** The patch's `config.aero` changes */
  aero: Record<string, unknown>;
  measured: AeroTargets;
  /** What the fit could not reach, if anything */
  notes: string[];
}

const DT = 1 / 120;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Downforce on each axle and drag per (m/s)², averaged over a second of straight running at about `speed` */
export function measureAero(profile: CarSimProfile, speed = 50): AeroTargets {
  const pad = createFlatTestTrack(20_000);
  const car = new F12026CarSim(pad, null, profile);
  car.assistPreset = "pro";
  car.autoGearbox = true;
  car.teleportToDistance(500, speed, 0);
  let integ = 0.5;
  const sum = { front: 0, rear: 0, drag: 0 };
  let n = 0;
  for (let t = 0; t < 4; t += DT) {
    const e = speed - car.vxMs;
    integ = Math.min(1, Math.max(0, integ + 0.3 * e * DT));
    const throttle = Math.min(1, Math.max(0, integ + 0.4 * e));
    car.step(DT, { throttle, brake: 0, analogSteer: Math.max(-0.2, Math.min(0.2, -0.08 * car.lateralOffsetM - 0.15 * car.yawRateRadS)) });
    if (t > 2.5) {
      const v2 = Math.max(1, car.vxMs * car.vxMs);
      const tel = car.telemetry;
      sum.front += tel.frontDownforceN / v2;
      sum.rear += tel.rearDownforceN / v2;
      sum.drag += tel.dragN / v2;
      n++;
    }
  }
  return { front: sum.front / n, rear: sum.rear / n, drag: sum.drag / n };
}

/** `b` merged over `a`, objects key by key (lists and numbers replaced) */
function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isRecord(v) && isRecord(a[k]) ? deepMerge(a[k] as Record<string, unknown>, v) : v;
  return out;
}

/** `patch` with `aero` merged into its `config.aero` */
export function withAero(patch: Record<string, unknown>, aero: Record<string, unknown>): Record<string, unknown> {
  return deepMerge(patch, { config: { aero } });
}

/**
 * The aero changes that make the car (`patch` on `base`, made a profile by `profileOf`) meet `targets` at `speed`.
 * `profileOf` returns null for a patch the game would refuse
 */
export function fitAero(
  base: CarSimProfile,
  patch: Record<string, unknown>,
  targets: AeroTargets,
  profileOf: (patch: Record<string, unknown>) => CarSimProfile,
  speed = 50
): AeroFit {
  const a = base.config.aero;
  const rho = a.airDensity;
  const q = 0.5 * rho;
  const notes: string[] = [];
  const isFront = (w: WingData) => w.positionZ > 0;
  const run = (aero: Record<string, unknown>) => measureAero(profileOf(withAero(patch, aero)), speed);

  if (!a.rhMap) {
    const scaled = (kF: number, kR: number) => ({
      wings: a.wings.map((w) => ({ area: w.area * (isFront(w) ? kF : kR) })),
      front_lift: a.front_lift * kF,
      rear_lift: a.rear_lift * kR,
    });
    const m00 = run(scaled(0, 0));
    const m10 = run(scaled(1, 0));
    const m01 = run(scaled(0, 1));
    // front = f00 + kF (f10 − f00) + kR (f01 − f00), the same for the rear: two equations in kF, kR
    const a11 = m10.front - m00.front;
    const a12 = m01.front - m00.front;
    const a21 = m10.rear - m00.rear;
    const a22 = m01.rear - m00.rear;
    const b1 = targets.front - m00.front;
    const b2 = targets.rear - m00.rear;
    const det = a11 * a22 - a12 * a21;
    let kF = Math.abs(det) > 1e-9 ? (b1 * a22 - a12 * b2) / det : 0;
    let kR = Math.abs(det) > 1e-9 ? (a11 * b2 - a21 * b1) / det : 0;
    kF = Math.max(0, kF);
    kR = Math.max(0, kR);
    const aero: Record<string, unknown> = scaled(kF, kR);
    // What the elements leave on each axle goes into the body's lift (m² of CL·A at the axles, + = down)
    const front = m00.front + kF * a11 + kR * a12;
    const rear = m00.rear + kF * a21 + kR * a22;
    aero.front_lift = (aero.front_lift as number) + (targets.front - front) / q;
    aero.rear_lift = (aero.rear_lift as number) + (targets.rear - rear) / q;
    const drag = m00.drag + kF * (m10.drag - m00.drag) + kR * (m01.drag - m00.drag);
    let body = a.drag + (targets.drag - drag) / q;
    if (body < 0) {
      notes.push(`the base's wings drag more than the car does at its downforce: the body's drag at 0 (${((-body * q) / targets.drag * 100).toFixed(0)} % over)`);
      body = 0;
    }
    aero.drag = body;
    return { aero, measured: run(aero), notes };
  }

  // A ride-height map: its downforce, balance and drag, and the wings with the downforce
  const map = a.rhMap;
  const total = targets.front + targets.rear;
  const share = total !== 0 ? targets.front / total : 0.5;
  let k = 1;
  let shift = 0;
  let kd = 1;
  let aero: Record<string, unknown> = {};
  let m = run(aero);
  for (let i = 0; i < 4; i++) {
    const got = m.front + m.rear;
    if (Math.abs(got) > 1e-6 && total > 0) k *= total / got;
    if (got > 1e-6) shift += share - m.front / got;
    if (m.drag > 1e-6) kd *= targets.drag / m.drag;
    k = Math.max(0, k);
    aero = {
      wings: a.wings.map((w) => ({ area: w.area * k })),
      rhMap: {
        clA: map.clA * k,
        cdA: map.cdA * kd,
        balance: map.balance.map((row) => row.map((b) => Math.min(0.95, Math.max(0.05, b + shift)))),
      },
    };
    m = run(aero);
  }
  if (total <= 0) notes.push("the car makes lift overall: the map's downforce at 0");
  return { aero, measured: m, notes };
}
