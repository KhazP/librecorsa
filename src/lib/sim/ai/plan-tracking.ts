/**
 * How a car tracks its drive plan, where it differs from the F1 cars' and the GT3's (F12026CarSim.ts `planCurvature`):
 * the pure-pursuit look-ahead, in seconds of travel.
 *
 * The default 0.22 s (about 6 m at 100 km/h) was tuned on the F1 cars and the AMG. The road and classic cars, softer and
 * slower to answer the wheel, weaved on it and spun in long corners below their plan's speed (the Liana in Istanbul's
 * Turn 8 at 99 km/h on a plan of 111): on all 37 layouts in Nov 2026 their plans stayed on the road at grip 0.95 on 14-18
 * layouts each with it, on 32-35 with a look-ahead of 0.4 s (scripts/ai/check-lines.ts).
 *
 * A car listed here tracks plans differently from the build its circuit's `aiPlans` checks were made on, so its checks
 * live under `aiPlansByLine` (made on this tracking, ignored by older builds) and its `aiPlans` entries, if any, are not
 * used: an older build tracks a plan its own way and keeps its own checks.
 */
import type { VehicleModelId } from '@/types/f1';

/** The default look-ahead (s of travel) */
export const PLAN_LOOK_S_DEFAULT = 0.22;

/** Look-ahead (s of travel) per car where it is not the default */
export const PLAN_LOOK_S: Readonly<Partial<Record<VehicleModelId, number>>> = {
  liana: 0.4,
  'vw-scirocco-gtx': 0.4,
  'nissan-r32-jtcc': 0.4,
  'nissan-r33-jgtc': 0.4,
  'bmw-m1-procar': 0.4,
  'porsche-934-rsr': 0.4,
  'chaparral-2d': 0.4,
  'chaparral-2d-67': 0.4,
  'mtr-496r': 0.4,
  'lc-lmdh': 0.4,
};

/** The look-ahead a car tracks its plan with (s of travel) */
export const planLookS = (vehicleId: string | undefined): number =>
  (vehicleId !== undefined ? PLAN_LOOK_S[vehicleId as VehicleModelId] : undefined) ?? PLAN_LOOK_S_DEFAULT;

/** Whether a car's plan checks are this build's own (`aiPlansByLine`) rather than the hosted `aiPlans` */
export const tracksOwnPlanChecks = (vehicleId: string): boolean => PLAN_LOOK_S[vehicleId as VehicleModelId] !== undefined;
