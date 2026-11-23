/**
 * Shared touch-control state. TouchControls writes it on pointer events and the
 * game loop reads it every frame, so nothing here goes through React.
 */

export interface TouchInputState {
  /** True while the TouchControls overlay is mounted */
  active: boolean;
  /** 0..1 (slider pedal) */
  throttle: number;
  /** 0..1 (slider pedal) */
  brake: number;
  /** -1 (full left) .. 1 (full right) (slider or tilt) */
  steer: number;
  /** True while an analogue steering control (slider or ready device tilt) is driving `steer` */
  analogSteerActive: boolean;
  /** Digital touch buttons (Buttons layout; routed through the same smooth ramps / steering assist as keys) */
  steerLeft: boolean;
  steerRight: boolean;
  throttleBtn: boolean;
  brakeBtn: boolean;
  /** set true for one frame by a button tap; the consumer clears them */
  shiftUp: boolean;
  /** set true for one frame by a button tap; the consumer clears them */
  shiftDown: boolean;
  /** set true for one frame by a button tap; the consumer clears them */
  boost: boolean;
  /** One-shot: use the Overtake earned in a race, or stop using it */
  overtake: boolean;
  /** set true for one frame by a button tap; the consumer clears them */
  aero: boolean;
}

/** Module singleton read by the game loop */
export const touchInput: TouchInputState = {
  active: false,
  throttle: 0,
  brake: 0,
  steer: 0,
  analogSteerActive: false,
  steerLeft: false,
  steerRight: false,
  throttleBtn: false,
  brakeBtn: false,
  shiftUp: false,
  shiftDown: false,
  boost: false,
  overtake: false,
  aero: false,
};

/** Zero every value and clear the active flag */
export function resetTouchInput(): void {
  touchInput.active = false;
  touchInput.throttle = 0;
  touchInput.brake = 0;
  touchInput.steer = 0;
  touchInput.analogSteerActive = false;
  touchInput.steerLeft = false;
  touchInput.steerRight = false;
  touchInput.throttleBtn = false;
  touchInput.brakeBtn = false;
  touchInput.shiftUp = false;
  touchInput.shiftDown = false;
  touchInput.boost = false;
  touchInput.overtake = false;
  touchInput.aero = false;
}

/** True on devices whose primary pointer is coarse (phones / tablets) */
export function isTouchDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

/** Tilt dead zone around the zero offset, in degrees */
const TILT_DEAD_ZONE_DEG = 2;

/**
 * Steering −1..1 from device tilt. Landscape uses beta (sign from the orientation angle),
 * portrait uses gamma. Full lock at ±rangeDeg, with a 2° dead zone. Returns 0 when the
 * axis is unavailable.
 */
export function tiltToSteer(
  e: { alpha: number | null; beta: number | null; gamma: number | null },
  orientationAngleDeg: number,
  rangeDeg: number,
): number {
  const angle = ((orientationAngleDeg % 360) + 360) % 360;
  const landscape = angle === 90 || angle === 270;
  const raw = landscape ? e.beta : e.gamma;
  const sign = landscape ? (angle === 90 ? 1 : -1) : angle === 180 ? -1 : 1;

  if (raw === null || !Number.isFinite(raw) || rangeDeg <= TILT_DEAD_ZONE_DEG) return 0;

  const magnitude = Math.abs(raw) - TILT_DEAD_ZONE_DEG;
  if (magnitude <= 0) return 0;

  const steer = sign * Math.sign(raw) * Math.min(1, magnitude / (rangeDeg - TILT_DEAD_ZONE_DEG));
  return steer;
}

interface DeviceOrientationEventWithPermission {
  requestPermission?: () => Promise<"granted" | "denied">;
}

/**
 * iOS requires DeviceOrientationEvent.requestPermission() from a user gesture. Resolves true
 * when tilt is usable (granted, or no permission step needed), false otherwise.
 */
export async function requestTiltPermission(): Promise<boolean> {
  if (typeof window === "undefined" || typeof DeviceOrientationEvent === "undefined") return false;
  const DOE = DeviceOrientationEvent as unknown as DeviceOrientationEventWithPermission;
  if (typeof DOE.requestPermission !== "function") return true;
  try {
    return (await DOE.requestPermission()) === "granted";
  } catch {
    return false;
  }
}
