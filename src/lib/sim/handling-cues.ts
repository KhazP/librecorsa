import { type AxleSlipTelemetry, axleSlipFromTelemetry, createAxleSlipSample } from './tyre-slip';

/** Understeer and oversteer (0..1 each): an axle past its tyres' peak while the other still has grip in hand */
export interface HandlingCues {
  understeer: number;
  oversteer: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Horizontal g past which a hit is a crash (a wall), well beyond any car's grip or braking */
export const CRASH_G = 10;

/** How far a tyre's normalised slip (1 = its peak) is past the peak: 0 below 0.85, 1 from 1.15 */
export function pastPeak(ndSlip: number): number {
  const x = clamp01((ndSlip - 0.85) / 0.3);
  return x * x * (3 - 2 * x);
}

/** Slip one axle carries beyond the other (normalised) for the cue to count fully as that axle's */
const BALANCE_SPAN = 0.2;

const _slip = createAxleSlipSample();

/**
 * The car's balance at the limit from its tyres' own slip, as the controller's rumble and the telemetry-out shakers
 * report it: no second tyre model, so the cues and the physics always agree
 */
export function handlingCues(t: AxleSlipTelemetry, out: HandlingCues = { understeer: 0, oversteer: 0 }): HandlingCues {
  const s = axleSlipFromTelemetry(t, _slip);
  out.understeer = pastPeak(s.frontNdSlip) * clamp01((s.frontNdSlip - s.rearNdSlip) / BALANCE_SPAN);
  out.oversteer = pastPeak(s.rearNdSlip) * clamp01((s.rearNdSlip - s.frontNdSlip) / BALANCE_SPAN);
  return out;
}
