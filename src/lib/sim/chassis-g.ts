/**
 * The chassis's measured vertical acceleration (`CarTelemetry.chassisVerticalG`): the specific force along the car's own
 * up axis, what an accelerometer bolted to the tub at the CG reads. 1 g parked on flat ground, more over a kerb, a bump
 * or a compression, less over a crest, 0 in the air. Downforce does not show in it: the springs carry it, and at a
 * steady speed on flat ground the reading stays at 1 g however hard the car is pressed down.
 *
 * The physics steps at 500 Hz (2 kHz on the classic engine) and the telemetry packet goes out at 60 Hz. The step to
 * step value carries tyre and suspension chatter far above what a 60 Hz sample can hold, which would alias into random
 * kicks. A first-order low-pass at 20 Hz, stepped with the simulated time, keeps the heave a motion platform can play
 * (a kerb strike, a bump, a crest) and takes the chatter out; it lags by about 8 ms, half a packet.
 */
export const CHASSIS_G_CUTOFF_HZ = 20;
const TAU_S = 1 / (2 * Math.PI * CHASSIS_G_CUTOFF_HZ);

/** One low-pass step from `prevG` toward the raw `sampleG` over `dtS` of simulated time; a non-finite sample or step keeps `prevG` */
export function filterChassisG(prevG: number, sampleG: number, dtS: number): number {
  if (!Number.isFinite(sampleG) || !(dtS > 0)) return prevG;
  return prevG + (sampleG - prevG) * (1 - Math.exp(-dtS / TAU_S));
}
