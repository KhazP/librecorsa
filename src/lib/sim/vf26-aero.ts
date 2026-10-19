/**
 * VF26 aero helpers shared by the vehicle model and the speed-profile / AI planner.
 */

import type { AeroSetupPreset } from '@/types/f1';
import { Lut } from './lut';
import { VF26_CHASSIS, VF26_TYRES, VF26_WINGS, type Vf26WingSpec } from './vf26-data';

/** Wing-angle setup offsets (deg) for the three aero packages */
export const AERO_PACKAGES: Record<AeroSetupPreset, { front: number; rear: number; flap: number }> = {
  low_downforce: { front: -1.5, rear: -3, flap: -4 },
  balanced: { front: 0, rear: 0, flap: 0 },
  high_downforce: { front: 2, rear: 3, flap: 0 },
};

const NO_TRIM = { front: 0, rear: 0 };

/** CG height above the road (m): wheel radius + BASEY, averaged over the axles */
export const VF26_CG_HEIGHT_M =
  0.5 * (VF26_TYRES.soft.front.radius + VF26_CHASSIS.front.baseY + VF26_TYRES.soft.rear.radius + VF26_CHASSIS.rear.baseY);

export interface WingRuntime {
  spec: Vf26WingSpec;
  area: number;
  aoaCl: Lut;
  aoaCd: Lut;
  ghCl: Lut | null;
  ghCd: Lut | null;
}

export function createWingRuntimes(): WingRuntime[] {
  return VF26_WINGS.map((spec) => ({
    spec,
    area: spec.chord * spec.span,
    aoaCl: new Lut(spec.aoaCl),
    aoaCd: new Lut(spec.aoaCd),
    ghCl: spec.ghCl ? new Lut(spec.ghCl) : null,
    ghCd: spec.ghCd ? new Lut(spec.ghCd) : null,
  }));
}

/** Element angle of attack (deg) for an aero package, blended toward the 2026 X-mode angle */
export function wingAngleDeg(
  spec: Vf26WingSpec,
  preset: AeroSetupPreset,
  xModeBlend: number,
  /** Garage wing clicks on top of the package (deg) */
  trim: { front: number; rear: number } = NO_TRIM
): number {
  const pkg = AERO_PACKAGES[preset];
  let offset = 0;
  if (spec.name.startsWith('FRONT')) offset = pkg.front + trim.front;
  else if (spec.name === 'REAR') offset = pkg.rear + trim.rear;
  else if (spec.name === 'DRS') offset = pkg.flap;
  const z = spec.angleDeg + offset;
  // Elements that move in X-mode open to a mechanical stop regardless of the setup offset (the
  // flap's drag LUT has a sharp minimum there; going past it adds drag). Fixed elements keep
  // their setup angle.
  const x = spec.xModeAngleDeg === spec.angleDeg ? z : spec.xModeAngleDeg;
  return z + (x - z) * xModeBlend;
}

/**
 * Downforce and drag per unit dynamic pressure scaled to ρ: F = coef · v² (N per (m/s)²),
 * evaluated with the body at a given heave / pitch over flat ground, zero yaw.
 */
export function estimateAeroCoefficients(
  preset: AeroSetupPreset,
  airDensity: number,
  heaveM: number,
  pitchRad: number,
  xModeBlend = 0,
  wings: WingRuntime[] = createWingRuntimes()
): { downforceCoef: number; dragCoef: number; frontShare: number } {
  let down = 0;
  let drag = 0;
  let front = 0;
  const L = VF26_CHASSIS.wheelbase;
  const b = L * VF26_CHASSIS.frontWeightFraction;
  for (const w of wings) {
    const s = w.spec;
    const angle = wingAngleDeg(s, preset, xModeBlend);
    const h = Math.max(0, VF26_CG_HEIGHT_M + s.position[1] + heaveM + s.position[2] * pitchRad);
    const ghCl = w.ghCl ? w.ghCl.evaluate(h) : 1;
    const ghCd = w.ghCd ? w.ghCd.evaluate(h) : 1;
    const fd = w.area * w.aoaCl.evaluate(angle) * s.clGain * ghCl;
    down += fd;
    drag += w.area * w.aoaCd.evaluate(angle) * s.cdGain * ghCd;
    front += fd * Math.min(1.5, Math.max(-0.5, (s.position[2] + b) / L));
  }
  const q = 0.5 * airDensity;
  return { downforceCoef: q * down, dragCoef: q * drag, frontShare: down !== 0 ? front / down : 0.5 };
}
