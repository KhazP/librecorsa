/** A car's outline at barrier height, from its config alone: what its barrier probes follow (`VehiclePhysics`) */
import type { CarPhysicsConfig, TyresCompoundData } from './F12026CarConfig';
import { convexHullIndices } from './TrackColliderQuery';

/** A body's plan (`ChassisData.bodyPlan`): its right half, [half width, z from the axles' midpoint] (m) */
export type BodyPlan = readonly (readonly [number, number])[];

/**
 * The points a car's barrier probes sit at, in its frame (x left, z forward, from the centre of gravity), in the order
 * it probes them: round the convex hull of the body's plan and its tyres' corners (`tyres`: the compound it is built
 * on), or without a plan (an open-wheel car), nose, front wheels, sidepods, rear wheels and tail, right side then left
 */
export function bodyOutline(cfg: CarPhysicsConfig, tyres: TyresCompoundData, plan: BodyPlan | undefined): { x: number; z: number }[] {
  const ch = cfg.chassis;
  const a = ch.wheelbase * (1 - ch.frontWeightFraction);
  const b = ch.wheelbase * ch.frontWeightFraction;
  const halfF = ch.trackWidthFront * 0.5 + 0.5 * tyres.front.width;
  const halfR = ch.trackWidthRear * 0.5 + 0.5 * tyres.rear.width;
  if (plan?.length) {
    // The plan's z is from the axles' midpoint, which is 0.5 (a - b) ahead of the CG
    const mid = 0.5 * (a - b);
    const pts: { x: number; z: number }[] = [];
    for (const [x, z] of plan) {
      pts.push({ x, z: z + mid });
      if (x > 0) pts.push({ x: -x, z: z + mid });
    }
    for (const side of [1, -1]) {
      pts.push({ x: side * halfF, z: a + tyres.front.radius }, { x: side * halfF, z: a - tyres.front.radius });
      pts.push({ x: side * halfR, z: -b + tyres.rear.radius }, { x: side * halfR, z: -b - tyres.rear.radius });
    }
    return convexHullIndices(pts).map((i) => pts[i]);
  }
  const wingZ = cfg.aero.wings.map((wg) => wg.positionZ);
  const noseZ = Math.max(a, ...wingZ) + 0.3;
  const tailZ = Math.min(-b, ...wingZ) - 0.3;
  const out: { x: number; z: number }[] = [];
  for (const side of [1, -1]) {
    for (const [x, z] of [
      [halfF, noseZ],
      [halfF, a],
      [0.85, 0],
      [halfR, -b],
      [0.5, tailZ],
    ] as const) {
      out.push({ x: side * x, z });
    }
  }
  return out;
}
