/**
 * Aerodynamic Slipstream, Dirty Air Vortex Wake, Roll Floor Asymmetry & Wind Coupling
 * (`src/lib/sim/aero-wake.ts`)
 *
 * Implements:
 * - Multi-car trailing vortex wake & slipstream deficit (`evaluateAeroWakeDeficit`):
 *   - Straight-line slipstream tow (`dragMultiplier` down to 0.78 behind a leading car).
 *   - Cornering "dirty air" downforce loss with differential front-wing vs. rear-diffuser deficit
 *     (`frontDownforceMultiplier` down to 0.72, `rearDownforceMultiplier` down to 0.84), shifting
 *     the aerodynamic Centre of Pressure (CoP) rearward and inducing realistic high-speed understeer.
 * - Roll-angle ground-effect Venturi floor seal leakage & asymmetric downforce (`evaluateRollAeroFactor`).
 * - Ambient wind vector coupling (`computeRelativeAirspeed`) for true headwind/tailwind dynamic pressure
 *   and crosswind aerodynamic yaw angle β_aero.
 */

export interface WakeEmitterCar {
  /** Track arc-length position s (m) */
  sMeters: number;
  /** Signed lateral offset from track centreline (m, + = right) */
  lateralOffsetM: number;
  /** Forward ground speed (m/s) */
  speedMs: number;
}

export interface AeroWakeState {
  /** Multiplier on aerodynamic drag (1.0 in clean air, down to ~0.78 in full slipstream tow) */
  dragMultiplier: number;
  /** Multiplier on front-axle downforce (1.0 in clean air, down to ~0.72 in dirty air) */
  frontDownforceMultiplier: number;
  /** Multiplier on rear-axle / diffuser downforce (1.0 in clean air, down to ~0.84 in dirty air) */
  rearDownforceMultiplier: number;
  /** Mean downforce multiplier across the car (0.76..1.0) */
  totalDownforceMultiplier: number;
  /** Shift in front aero balance percentage due to dirty air (negative = rearward shift / understeer) */
  copFrontShiftPct: number;
  /** Normalized wake intensity (0 = clean air, 1 = deep in core wake) */
  wakeIntensity: number;
}

export const CLEAN_AIR_WAKE_STATE: AeroWakeState = {
  dragMultiplier: 1,
  frontDownforceMultiplier: 1,
  rearDownforceMultiplier: 1,
  totalDownforceMultiplier: 1,
  copFrontShiftPct: 0,
  wakeIntensity: 0,
};

export const DEFAULT_AERO_WAKE: AeroWakeState = CLEAN_AIR_WAKE_STATE;

/**
 * Evaluates the cumulative aerodynamic slipstream (drag reduction) and dirty-air downforce loss
 * experienced by a car at `(myS, myLatOffsetM, mySpeedMs)` behind `emitters` on a circuit of length `trackLengthM`.
 * `skipIndex` is the car's own entry in `emitters`, if it is in the list.
 *
 * The wake is laid along the leader's path (the air stays roughly where it was shed), so in track coordinates it
 * sits at the leader's lateral offset in corners too; `_localCurvature` is kept for callers but no longer drifts it
 * (a −0.35·κ·ds² drift put it 2.8 m wide of a 50 m-radius corner at a 20 m gap, so dirty air vanished in corners).
 */
export function evaluateAeroWakeDeficit(
  myS: number,
  myLatOffsetM: number,
  mySpeedMs: number,
  emitters: ReadonlyArray<WakeEmitterCar>,
  trackLengthM: number,
  _localCurvature = 0,
  skipIndex = -1
): AeroWakeState {
  if (emitters.length === 0 || mySpeedMs < 8 || !(trackLengthM > 0)) {
    return CLEAN_AIR_WAKE_STATE;
  }

  let totalDragLoss = 0;
  let totalFrontDfLoss = 0;
  let totalRearDfLoss = 0;
  let peakIntensity = 0;

  for (let i = 0; i < emitters.length; i++) {
    if (i === skipIndex) continue;
    const lead = emitters[i];
    if (!(lead.speedMs >= 10)) continue;

    // Signed distance ahead along the circuit
    let ds = (lead.sMeters - myS) % trackLengthM;
    if (ds < 0) ds += trackLengthM;
    if (ds < 2.2 || ds > 130) continue;

    const dLat = myLatOffsetM - lead.lateralOffsetM;

    // Turbulent wake half-width expands downstream from 1.05 m at the rear wing
    const wakeHalfWidthM = 1.05 + 0.026 * ds;
    const latGaussian = Math.exp(-(dLat * dLat) / (2 * wakeHalfWidthM * wakeHalfWidthM));
    if (latGaussian < 0.02) continue;

    // Speed scaling: wake strength scales with leading car speed (full strength above 55 m/s ≈ 200 km/h)
    const speedScale = Math.min(1.15, Math.max(0, (lead.speedMs - 10) / 50));

    // Near-wake build-up (peaks around 6–14 m behind the gearbox) and far-wake exponential decay
    const nearEnvelope = Math.min(1, (ds - 1.5) / 4.5);
    const dragDecay = Math.exp(-Math.max(0, ds - 8) / 46);
    const dfDecay = Math.exp(-Math.max(0, ds - 8) / 56); // Dirty air vortices persist slightly longer than drag tow

    const dragIntensity = nearEnvelope * dragDecay * latGaussian * speedScale;
    const dfIntensity = nearEnvelope * dfDecay * latGaussian * speedScale;

    // Accumulate deficits in quadrature so multiple cars ahead saturate smoothly
    totalDragLoss += (0.22 * dragIntensity) ** 2;
    totalFrontDfLoss += (0.28 * dfIntensity) ** 2;
    totalRearDfLoss += (0.16 * dfIntensity) ** 2;
    if (dfIntensity > peakIntensity) peakIntensity = dfIntensity;
  }

  const dragDeficit = Math.min(0.26, Math.sqrt(totalDragLoss));
  const frontDfDeficit = Math.min(0.32, Math.sqrt(totalFrontDfLoss));
  const rearDfDeficit = Math.min(0.20, Math.sqrt(totalRearDfLoss));

  const dragMultiplier = 1 - dragDeficit;
  const frontDownforceMultiplier = 1 - frontDfDeficit;
  const rearDownforceMultiplier = 1 - rearDfDeficit;
  const totalDownforceMultiplier = 0.46 * frontDownforceMultiplier + 0.54 * rearDownforceMultiplier;
  const copFrontShiftPct = -100 * (frontDfDeficit - rearDfDeficit) * 0.25;

  return {
    dragMultiplier,
    frontDownforceMultiplier,
    rearDownforceMultiplier,
    totalDownforceMultiplier,
    copFrontShiftPct,
    wakeIntensity: Math.min(1, peakIntensity),
  };
}

/**
 * Evaluates the Venturi floor ground-effect downforce multiplier under chassis roll (`rollRad`).
 * Rolling lifts the inside floor edge and drops the outside floor edge, leaking the underfloor
 * vortex seal when roll angle becomes large.
 */
export function evaluateRollAeroFactor(rollRad: number): number {
  const r = Math.min(0.12, Math.abs(rollRad));
  return Math.max(0.86, 1 - 1.8 * r * r);
}

export interface RelativeAirspeed {
  /** Air velocity relative to the car along its forward / left axes (m/s) */
  vxAirMs: number;
  vyAirMs: number;
  airspeedMs: number;
  airspeedSq: number;
  /** Aerodynamic sideslip atan2(vyAir, |vxAir|) (rad) */
  aeroBetaRad: number;
}

/**
 * Computes the relative airspeed components `(vxAirMs, vyAirMs, airspeedMs, aeroBetaRad)` in the car's horizontal
 * frame (vx forward, vy + left; heading ψ = atan2(forward.x, forward.z) in the Three.js world) given the wind's world
 * velocity components `(windWorldXMs, windWorldZMs)` (where the air moves to). Pass `out` to avoid an allocation.
 */
export function computeRelativeAirspeed(
  vxBodyMs: number,
  vyBodyMs: number,
  carHeadingRad: number,
  windWorldXMs = 0,
  windWorldZMs = 0,
  out: RelativeAirspeed = { vxAirMs: 0, vyAirMs: 0, airspeedMs: 0, airspeedSq: 0, aeroBetaRad: 0 }
): RelativeAirspeed {
  let vxAirMs = vxBodyMs;
  let vyAirMs = vyBodyMs;
  if (windWorldXMs !== 0 || windWorldZMs !== 0) {
    // World wind into the body frame: forward (sin ψ, cos ψ), left (cos ψ, −sin ψ)
    const s = Math.sin(carHeadingRad);
    const c = Math.cos(carHeadingRad);
    vxAirMs -= windWorldXMs * s + windWorldZMs * c;
    vyAirMs -= windWorldXMs * c - windWorldZMs * s;
  }
  const airspeedSq = vxAirMs * vxAirMs + vyAirMs * vyAirMs;
  const airspeedMs = Math.sqrt(airspeedSq);
  out.vxAirMs = vxAirMs;
  out.vyAirMs = vyAirMs;
  out.airspeedMs = airspeedMs;
  out.airspeedSq = airspeedSq;
  out.aeroBetaRad = airspeedMs > 1 ? Math.atan2(vyAirMs, Math.abs(vxAirMs)) : 0;
  return out;
}
