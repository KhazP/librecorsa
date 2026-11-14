import type { CarTelemetry } from "@/types/f1";
import { CRASH_G, handlingCues, pastPeak } from "./handling-cues";
import { axleSlipFromTelemetry, brakeSlipMargin, createAxleSlipSample, throttleSlipAllowance } from "./tyre-slip";
import { DEFAULT_SURFACE_TABLE } from "./track-surfaces";

/**
 * Gamepad rumble for the car: the pad's two motors are driven from the physics so the player
 * feels kerbs, tyre scrub, lock-up, wheelspin, the rear sliding, rack load and rough surfaces without looking at the
 * HUD. The weak (high-frequency) motor carries texture and kerb strikes, the strong (low-frequency)
 * motor carries the heavier cues.
 *
 * Each motor's cues are layered into the headroom the ones before them left (`layerRumble`), after rbrpad's
 * `RumbleMapper`, rather than summed and clipped: however many cues stack (a kerb strike under a lock-up and
 * wheelspin), the motor stays below full and each cue still moves it. Rough ground is felt per wheel from its
 * shock velocity, gated by the wheel's load so a wheel going light over a crest stops contributing. A hit (a landing,
 * a hard kerb strike, a wall) is a short pulse on the strong motor that rings out over ~0.3 s. Both are also after
 * rbrpad.
 *
 * Effects are short (90 ms) and re-sent only when they change, so a stationary car does not flood
 * the device with commands. The kerb, ABS and TC pulses are the exception: each on / off edge is sent when it
 * happens, with an effect that lasts one half-period, so the 12–25 Hz pulses are felt at their rate rather than
 * aliased by the 60 ms send gate. So does the onset of a hit, so it lands when it happens.
 *
 * The triggers' grip-limit buzz with ABS / traction control off is adapted from AC-Advanced-Gamepad-Assist v1.5.5 by
 * Adam D. (https://github.com/adam10603/AC-Advanced-Gamepad-Assist), MIT License — see CREDITS.md.
 */

/** Gamepad Haptics API surface used here (the DOM lib types vibrationActuator only loosely) */
interface VibrationActuatorLike {
  /** Effect types the pad supports (Chrome: "dual-rumble", "trigger-rumble"); may be missing */
  effects?: readonly string[];
  playEffect: (
    type: "dual-rumble" | "trigger-rumble",
    params: {
      startDelay: number;
      duration: number;
      weakMagnitude: number;
      strongMagnitude: number;
      /** Xbox impulse triggers (trigger-rumble only), 0..1 */
      leftTrigger?: number;
      rightTrigger?: number;
    }
  ) => Promise<unknown> | undefined;
  reset?: () => Promise<unknown> | undefined;
}

interface ConnectedPad {
  /** Slot and device id together: a different pad reconnecting into the same slot must not inherit its state */
  key: string;
  actuator: VibrationActuatorLike;
}

interface PadOutput {
  /** Physics time (s) of the last effect sent to this pad */
  lastSentS: number;
  weak: number;
  strong: number;
  /** Last impulse-trigger magnitudes sent (0 when the pad has no trigger motors) */
  left: number;
  /** Pulse state (bitmask of active pulses and their phases) the last effect was sent for */
  pulseKey: number;
  /** Impact envelope the last effect was sent with */
  impact: number;
  /** Duration of the last effect sent (s) */
  durationS: number;
  right: number;
}

/** Minimum time between effect calls on one pad */
const SEND_INTERVAL_S = 0.06;
const EFFECT_DURATION_MS = 90;
/** Magnitude change that counts as a new effect while the previous one is still running */
const MAGNITUDE_EPS = 0.03;
const KERB_PULSE_HZ = 12;
/** Whether the kerb pulse is in its on half at `timeS` */
export const kerbPulseOn = (timeS: number) => (timeS * KERB_PULSE_HZ) % 1 < 0.5;
const ABS_PULSE_HZ = 20;
const TC_PULSE_HZ = 25;

/**
 * Surface roughness, per wheel, from its shock velocity (rbrpad `SurfaceRoughness`). Silent below the floor: smooth
 * asphalt peaks near 0.08 m/s over a lap, braking dive included, while kerbs reach 0.2-0.5 m/s and grass 0.5-0.9.
 * The squared response keeps light chatter quiet and lets real bumps stand out.
 */
const ROUGH_VEL_FLOOR_MS = 0.08;
const ROUGH_VEL_FULL_MS = 0.9;
/** Wheel load (N) at which a wheel's roughness is fully gated out / fully in; corners carry ~1.7-4 kN at rest */
const ROUGH_LOAD_GATE_LOW_N = 200;
const ROUGH_LOAD_GATE_HIGH_N = 1000;
/** Peak hold on each wheel's roughness: one shock-velocity sample per frame aliases a kerb's 50-80 Hz ripple */
const ROUGH_HOLD_S = 0.05;
/**
 * Light off-track texture from the surface table's rumble gain (AC `VIBRATION_GAIN`), so painted run-off, which the
 * physics keeps flat, is still felt. Kerbs are left out: they have their own pulse on the weak motor.
 */
const OFFTRACK_TEXTURE_GAIN = 0.4;
/**
 * Impact pulse (rbrpad `Impact`): the body's vertical jolt, gravity and downforce taken out, from the tyres' total
 * load against the car's weight. Silent below the floor: a clean lap on Rwanda's crests and compressions peaks near
 * 1.1 g, while landings over kerbs and run-off edges reach 1.5-3 g. Only compression counts: a wheel leaving the
 * ground reads as negative heave, and the landing after it is the hit.
 */
const IMPACT_HEAVE_FLOOR_G = 1.4;
const IMPACT_HEAVE_FULL_G = 3;
/** Below this speed a settling car (a reset onto the grid) is not a hit */
const IMPACT_MIN_SPEED_KMH = 10;
/** A wall hit (horizontal g above CRASH_G) starts the pulse at this level, full at twice the threshold */
const IMPACT_CRASH_FLOOR = 0.6;
/** Impact envelope decay time constant (s): how long a hit rings out */
const IMPACT_DECAY_S = 0.1;
/** Time constant (s) of the running estimate of the car's weight from its tyre loads */
const WEIGHT_TAU_S = 2;
/** Rise of the impact envelope that goes out at once, past the send gate */
const IMPACT_ONSET_EDGE = 0.2;
/** Above this gap between frames (s, a pause or a dropped tab) the held envelopes start again */
const MAX_MIX_DT_S = 0.25;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** clamp01, with a non-finite input read as no effect */
const magnitude01 = (v: number) => (Number.isFinite(v) ? clamp01(v) : 0);

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/** Carried between frames by the rumble mix: the held envelopes need the time since the last frame */
export interface RumbleMixState {
  /** Physics time of the previous mix (s); NaN before the first */
  lastTimeS: number;
  /** Peak-held roughness per wheel (FL, FR, RL, RR), 0..1 */
  roughHold: [number, number, number, number];
  /** Decaying level of the current hit, 0..1 */
  impactEnvelope: number;
  /** Running estimate of the car's weight m·g (N): Σ wheel load / verticalG, which steadies on it; 0 until learnt */
  weightN: number;
  /** The last car-to-car contact felt (`CarTelemetry.carContact.seq`) */
  contactSeq: number;
}

export function createRumbleMixState(): RumbleMixState {
  return { lastTimeS: NaN, roughHold: [0, 0, 0, 0], impactEnvelope: 0, weightN: 0, contactSeq: 0 };
}

/** Back to a fresh state (pause, toggle off, unmount) */
export function resetRumbleMixState(state: RumbleMixState): void {
  state.lastTimeS = NaN;
  state.roughHold.fill(0);
  state.impactEnvelope = 0;
  state.weightN = 0;
}

const finiteOr = (v: number | undefined, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/**
 * Rough ground on the strong motor (0..1): each wheel's shock velocity, plus the surface table's off-track texture,
 * gated by its load and averaged across the four wheels. `hold` (with `decay`, the hold's per-frame factor) keeps the
 * per-wheel peaks; without it each frame stands alone.
 */
function surfaceRoughness(t: CarTelemetry, hold: number[] | undefined, decay: number, perWheel?: number[]): number {
  const texSpeed = smoothstep(10, 90, t.speedKmh);
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const vel = Math.abs(finiteOr(t.suspensionVelocityMs?.[i], 0));
    let rough = clamp01((vel - ROUGH_VEL_FLOOR_MS) / (ROUGH_VEL_FULL_MS - ROUGH_VEL_FLOOR_MS));
    rough *= rough;
    if (hold) {
      rough = Math.max(rough, hold[i] * decay);
      hold[i] = rough;
    }
    const surface = t.wheelSurfaces?.[i];
    const vibration = surface === "grass" || surface === "runoff" ? DEFAULT_SURFACE_TABLE[surface].vibration : 0;
    const gate = smoothstep(ROUGH_LOAD_GATE_LOW_N, ROUGH_LOAD_GATE_HIGH_N, finiteOr(t.wheelLoadsN?.[i], 0));
    const wheel = gate * layerRumble(rough, OFFTRACK_TEXTURE_GAIN * vibration * texSpeed);
    if (perWheel) perWheel[i] = wheel;
    sum += wheel;
  }
  return sum / 4;
}

/**
 * The body's vertical jolt (g, + = pressed down, 0 when steady): the tyres' total load against the car's weight,
 * less `verticalG` (1 + downforce / weight, which carries no bumps of its own). The weight is learnt from the loads
 * while every wheel is down, so it needs `mix`; 0 without it or before it has been learnt.
 */
function bodyHeaveG(t: CarTelemetry, mix: RumbleMixState | undefined, dt: number): number {
  const loads = t.wheelLoadsN;
  if (!mix || !loads) return 0;
  let sum = 0;
  let min = Infinity;
  for (let i = 0; i < 4; i++) {
    const n = finiteOr(loads[i], 0);
    sum += n;
    min = Math.min(min, n);
  }
  const verticalG = Math.max(0.2, finiteOr(t.verticalG, 1));
  const heaveG = mix.weightN > 0 ? sum / mix.weightN - verticalG : 0;
  // Learnt while every wheel is down, and not from a frame that is itself a hit
  if (min > ROUGH_LOAD_GATE_LOW_N && heaveG < IMPACT_HEAVE_FLOOR_G) {
    const weightN = sum / verticalG;
    if (mix.weightN <= 0) mix.weightN = weightN;
    else if (dt > 0) mix.weightN += (weightN - mix.weightN) * (1 - Math.exp(-dt / WEIGHT_TAU_S));
  }
  return heaveG;
}

/**
 * A hit on the strong motor (0..1): a vertical jolt (landing, hard kerb strike) or a wall hit (horizontal g past the
 * high-impact threshold) sets the level, which then rings out with `IMPACT_DECAY_S`. The raw spike lasts a frame or
 * two; the envelope makes it land. With `mix` the envelope carries over; without it only this frame's hit counts.
 */
function impactPulse(
  t: CarTelemetry,
  horizontalG: number,
  crash: boolean,
  mix: RumbleMixState | undefined,
  dt: number
): number {
  const heaveG = bodyHeaveG(t, mix, dt);
  let hit = 0;
  if (t.speedKmh > IMPACT_MIN_SPEED_KMH) {
    hit = clamp01((heaveG - IMPACT_HEAVE_FLOOR_G) / (IMPACT_HEAVE_FULL_G - IMPACT_HEAVE_FLOOR_G));
  }
  if (crash) {
    const over = clamp01((horizontalG - CRASH_G) / CRASH_G);
    hit = Math.max(hit, IMPACT_CRASH_FLOOR + (1 - IMPACT_CRASH_FLOOR) * over);
  }
  // Another car's hit: the contact impulse moves the car between physics steps, so it never shows in the g-forces
  if (mix && t.carContact && t.carContact.seq !== mix.contactSeq) {
    mix.contactSeq = t.carContact.seq;
    hit = Math.max(hit, IMPACT_CRASH_FLOOR + (1 - IMPACT_CRASH_FLOOR) * clamp01(t.carContact.speedMs / 12));
  }
  if (!mix) return hit;
  const decay = dt > 0 ? Math.exp(-dt / IMPACT_DECAY_S) : 0;
  mix.impactEnvelope = Math.max(hit, mix.impactEnvelope * decay);
  return mix.impactEnvelope;
}

/**
 * Adds a cue into the headroom the cues layered before it left: `acc + e·(1 − acc)` (rbrpad `RumbleMapper.Layer`).
 * The result never exceeds 1 and grows with every cue, so a strong cue cannot drown the rest out by clipping.
 * The result is the same in any order; cues are listed by priority for the reader.
 */
export function layerRumble(acc: number, effect: number): number {
  return acc + magnitude01(effect) * (1 - acc);
}

/**
 * Which pulses are running and in which half of their cycle (a bitmask that changes on every pulse edge), and the
 * shortest running half-period (s; 0 with no pulse)
 */
function pulseState(t: CarTelemetry, timeS: number, triggers: boolean): { key: number; halfS: number } {
  let key = 0;
  let halfS = 0;
  const add = (bit: number, hz: number) => {
    key |= 1 << (2 * bit);
    if ((timeS * hz) % 1 < 0.5) key |= 1 << (2 * bit + 1);
    const h = 0.5 / hz;
    halfS = halfS === 0 ? h : Math.min(halfS, h);
  };
  if (t.onKerbLeft || t.onKerbRight) add(0, KERB_PULSE_HZ);
  if (triggers) {
    const minSlip = Math.min(...t.wheelSlipRatios);
    if (t.brake > 0.05 && (t.f12026?.absActive === true || (t.speedKmh > 30 && minSlip < -0.12))) add(1, ABS_PULSE_HZ);
    if (t.throttle > 0.1 && t.f12026?.tcActive === true) add(2, TC_PULSE_HZ);
  }
  return { key, halfS };
}

/** The cues behind the two motor levels, for a pad that plays them apart (the DualSense's haptics) */
export interface RumbleCues {
  /** Kerb level under the car while on one (unpulsed), 0..1 */
  kerb: number;
  scrub: number;
  texture: number;
  impact: number;
  lockUp: number;
  wheelspin: number;
  rearSlide: number;
  rackLoad: number;
  /** Rough ground per wheel (FL, FR, RL, RR), 0..1 */
  roughWheels: [number, number, number, number];
}

export const createRumbleCues = (): RumbleCues => ({
  kerb: 0,
  scrub: 0,
  texture: 0,
  impact: 0,
  lockUp: 0,
  wheelspin: 0,
  rearSlide: 0,
  rackLoad: 0,
  roughWheels: [0, 0, 0, 0],
});

/**
 * Motor magnitudes (0..1) for the current car state; `timeS` drives the kerb pulse. `mix` carries the held envelopes
 * from frame to frame (one per pad driver); without it each call stands alone. `cues`, when given, receives the
 * separate cues the two levels are layered from.
 */
export function hapticMagnitudes(
  t: CarTelemetry,
  timeS: number,
  mix?: RumbleMixState,
  cues?: RumbleCues
): { weak: number; strong: number } {
  let decayDt = 0;
  if (mix) {
    const dt = timeS - mix.lastTimeS;
    decayDt = dt > 0 && dt <= MAX_MIX_DT_S ? dt : 0;
    mix.lastTimeS = timeS;
  }
  const gLat = typeof t.lateralG === "number" && Number.isFinite(t.lateralG) ? Math.abs(t.lateralG) : 0;
  const gLon = typeof t.longitudinalG === "number" && Number.isFinite(t.longitudinalG) ? Math.abs(t.longitudinalG) : 0;
  const horizontalG = Math.hypot(gLat, gLon);
  // A crash does not mute the pad: it is the impact pulse below, and the slide cue stands down under it
  const crash = horizontalG > CRASH_G;

  const speedFactor = clamp01(t.speedKmh / 300);

  // Weak motor: kerb strikes pulse on and off, front-tyre scrub near the limit, faint road texture
  const onKerb = t.onKerbLeft || t.onKerbRight;
  const kerbLevel = onKerb ? 0.55 + 0.35 * speedFactor : 0;
  const kerb = kerbPulseOn(timeS) ? kerbLevel : 0;
  const scrub = 0.4 * pastPeak(Math.max(t.tireSlipRatio[0], t.tireSlipRatio[1]));
  const texture = 0.04 * speedFactor;
  let weak = layerRumble(0, kerb);
  weak = layerRumble(weak, scrub);
  weak = layerRumble(weak, texture);

  // Strong motor: a hit, lock-up, the rear letting go (wheelspin, or sliding past the fronts), a rack-load cue and rough
  // ground under each wheel
  const impact = impactPulse(t, horizontalG, crash, mix, decayDt);
  const minSlip = Math.min(...t.wheelSlipRatios);
  const lockUp = t.speedKmh > 30 ? 0.8 * smoothstep(0.12, 0.45, -minSlip) : 0;
  const rearSlip = Math.max(t.wheelSlipRatios[2], t.wheelSlipRatios[3]);
  const wheelspin = 0.6 * smoothstep(0.12, 0.5, rearSlip);
  const rearSlide = crash ? 0 : 0.45 * handlingCues(t, _cues).oversteer;
  // The rack-load cue is the corner's weight: parked, the steering torque is the tyres twisted in place, which would
  // otherwise hum on through the pad after a wiggle of the stick. It eases in over the first few km/h, as the wheel's
  // minimum force does
  const rolling = clamp01((t.speedKmh - 1) * 0.2);
  const rackLoad = 0.25 * rolling * Math.pow(clamp01(Math.abs(t.ffbTorqueNorm ?? 0)), 1.5);
  const roughSurface = surfaceRoughness(
    t,
    mix?.roughHold,
    decayDt > 0 ? Math.exp(-decayDt / ROUGH_HOLD_S) : 0,
    cues?.roughWheels
  );
  if (cues) {
    cues.kerb = kerbLevel;
    cues.scrub = scrub;
    cues.texture = texture;
    cues.impact = impact;
    cues.lockUp = lockUp;
    cues.wheelspin = wheelspin;
    cues.rearSlide = rearSlide;
    cues.rackLoad = rackLoad;
  }
  let strong = layerRumble(0, impact);
  strong = layerRumble(strong, lockUp);
  strong = layerRumble(strong, Math.max(wheelspin, rearSlide));
  strong = layerRumble(strong, rackLoad);
  strong = layerRumble(strong, roughSurface);

  return { weak, strong };
}

const _cues = { understeer: 0, oversteer: 0 };

/** Trigger buzz while the tyres approach their grip with the aid off: none under half the peak, firming up to it */
function limitBuzz(ndSlip: number): number {
  if (!(ndSlip > 0.5)) return 0;
  return (Math.pow(clamp01((ndSlip - 0.5) / 0.5), 4) * 0.95 + 0.05) * 0.4;
}

const _triggerSlip = createAxleSlipSample();

/** What the triggers have to say, before any pulsing: shared by the Xbox impulse triggers and the DualSense's */
export interface TriggerCues {
  /** A locked or ABS-releasing front axle under braking, and how far (0..1) */
  locking: boolean;
  absActive: boolean;
  lockScale: number;
  /** Spinning rear wheels under throttle (or traction control cutting), and how far (0..1) */
  spinning: boolean;
  tcActive: boolean;
  spinScale: number;
  /**
   * Grip-limit buzz (0..0.4) as the tyres approach their peak with ABS / traction control off (or always, with
   * `triggerSlipAlwaysOn`); 0 when there is nothing to feel
   */
  brakeLimit: number;
  throttleLimit: number;
}

/**
 * The trigger cues for the car. The brake cue reads only the braking part of the tyres' slip, so cornering at the
 * limit does not buzz it, and only one of the two limit cues is live at a time (wheelspin picks the throttle's).
 */
export function triggerCues(t: CarTelemetry, options?: { triggerSlipAlwaysOn?: boolean }): TriggerCues {
  const minSlip = Math.min(...t.wheelSlipRatios);
  const absActive = t.f12026?.absActive === true;
  const locking = t.brake > 0.05 && (absActive || (t.speedKmh > 30 && minSlip < -0.12));
  const rearSlip = Math.max(t.wheelSlipRatios[2], t.wheelSlipRatios[3]);
  const tcActive = t.f12026?.tcActive === true;
  const spinning = t.throttle > 0.1 && (tcActive || rearSlip > 0.12);
  let brakeLimit = 0;
  let throttleLimit = 0;
  const aids = t.liveTuner;
  const alwaysOn = options?.triggerSlipAlwaysOn === true;
  if ((alwaysOn || (aids && (aids.absLevel === 0 || aids.tcLevel === 0))) && t.speedKmh > 2) {
    const slip = axleSlipFromTelemetry(t, _triggerSlip);
    const wheelspin = rearSlip > 0.02;
    if ((alwaysOn || aids?.absLevel === 0) && t.brake > 0.2 && !wheelspin) {
      // Braking slip only: a car cornering at its limit while braking lightly is not about to lock a wheel
      brakeLimit = limitBuzz(slip.brakeNdSlip + brakeSlipMargin());
    }
    if ((alwaysOn || aids?.tcLevel === 0) && t.throttle > 0.2 && wheelspin) {
      throttleLimit = limitBuzz(slip.rearNdSlip - throttleSlipAllowance(t.speedKmh));
    }
  }
  return {
    locking,
    absActive,
    lockScale: clamp01(-minSlip / 0.45),
    spinning,
    tcActive,
    spinScale: clamp01(rearSlip / 0.5),
    brakeLimit: magnitude01(brakeLimit),
    throttleLimit: magnitude01(throttleLimit),
  };
}

/**
 * Impulse-trigger magnitudes (0..1) for the car: the left trigger (brake) feels ABS / lock-up as a 20 Hz pulse,
 * the right trigger (throttle) feels wheelspin, and traction control as a 25 Hz pulse. With ABS (traction control)
 * off, the brake (throttle) trigger also buzzes lightly as the tyres approach their grip, firming up toward the peak,
 * so the player feels the limit coming before a lock-up or a spin; only one trigger buzzes at a time. The brake
 * trigger reads only the braking part of the tyres' slip, so cornering at the limit does not buzz it. Zero when there
 * is nothing to feel.
 */
export function triggerMagnitudes(
  t: CarTelemetry,
  timeS: number,
  options?: { triggerSlipAlwaysOn?: boolean }
): { left: number; right: number } {
  const cues = triggerCues(t, options);
  // Left trigger: a locked or ABS-releasing front axle pushes back through the brake
  let left = 0;
  if (cues.locking) {
    const pulseOn = (timeS * ABS_PULSE_HZ) % 1 < 0.5;
    left = pulseOn ? 0.35 + 0.45 * cues.lockScale : 0;
  }
  // Right trigger: spinning rear wheels push back through the throttle; TC cuts the throttle in pulses
  let right = 0;
  if (cues.spinning) {
    const pulseOn = cues.tcActive ? (timeS * TC_PULSE_HZ) % 1 < 0.5 : true;
    right = pulseOn ? 0.25 + 0.45 * cues.spinScale : 0;
  }
  // Approaching the grip limit, between the pulses or with nothing else on that trigger
  if (left === 0) left = cues.brakeLimit;
  if (right === 0) right = cues.throttleLimit;
  return { left: magnitude01(left), right: magnitude01(right) };
}

/** Every connected pad that exposes a vibration actuator, less those `skip` names (driven another way) */
function connectedPads(skip?: (padId: string) => boolean): ConnectedPad[] {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return [];
  const pads: ConnectedPad[] = [];
  navigator.getGamepads().forEach((pad, index) => {
    if (!pad || skip?.(pad.id)) return;
    const actuator = (pad as { vibrationActuator?: VibrationActuatorLike | null }).vibrationActuator;
    if (actuator && typeof actuator.playEffect === "function") pads.push({ key: `${index}|${pad.id}`, actuator });
  });
  return pads;
}

/** Best-effort device call: unsupported or disconnected pads must never break the frame loop */
function send(call: () => Promise<unknown> | undefined) {
  try {
    void Promise.resolve(call()).catch(() => {});
  } catch {
    // Device rejected the call; ignore
  }
}

function playDualRumble(actuator: VibrationActuatorLike, weak: number, strong: number, durationMs = EFFECT_DURATION_MS) {
  send(() =>
    actuator.playEffect("dual-rumble", {
      startDelay: 0,
      duration: durationMs,
      weakMagnitude: weak,
      strongMagnitude: strong,
    })
  );
}

/** Pad exposes Xbox impulse triggers (missing effects list → unsupported) */
function supportsTriggerRumble(actuator: VibrationActuatorLike): boolean {
  return actuator.effects?.includes("trigger-rumble") === true;
}

/** Body motors and both impulse triggers in one effect */
function playTriggerRumble(
  actuator: VibrationActuatorLike,
  weak: number,
  strong: number,
  left: number,
  right: number,
  durationMs = EFFECT_DURATION_MS
) {
  send(() =>
    actuator.playEffect("trigger-rumble", {
      startDelay: 0,
      duration: durationMs,
      weakMagnitude: weak,
      strongMagnitude: strong,
      leftTrigger: left,
      rightTrigger: right,
    })
  );
}

export class GamepadHaptics {
  private timeS = 0;
  private active = false;
  private outputs = new Map<string, PadOutput>();
  private mix = createRumbleMixState();

  /**
   * Call once per frame after the physics step; `enabled` is false while paused or when the toggle is off.
   * `options.triggerRumble` also drives the Xbox impulse triggers on pads that support them (default off).
   * `options.skipPad` leaves out pads another driver writes to (a DualSense over WebHID).
   */
  update(
    t: CarTelemetry,
    dtSeconds: number,
    enabled: boolean,
    options?: { triggerRumble?: boolean; triggerSlipAlwaysOn?: boolean; skipPad?: (padId: string) => boolean }
  ): void {
    this.timeS += dtSeconds;
    if (!enabled) {
      if (this.active) this.stop();
      return;
    }
    this.active = true;

    const { weak, strong } = hapticMagnitudes(t, this.timeS, this.mix);
    const wantTriggers = options?.triggerRumble === true;
    const trig = wantTriggers ? triggerMagnitudes(t, this.timeS, options) : { left: 0, right: 0 };
    const pads = connectedPads(options?.skipPad);
    for (const { key, actuator } of pads) {
      const out = this.outputs.get(key) ?? {
        lastSentS: -Infinity,
        weak: 0,
        strong: 0,
        left: 0,
        right: 0,
        pulseKey: 0,
        impact: 0,
        durationS: EFFECT_DURATION_MS / 1000,
      };
      this.outputs.set(key, out);

      const useTriggers = wantTriggers && supportsTriggerRumble(actuator);
      const pulse = pulseState(t, this.timeS, useTriggers);
      // A pulse edge or a hit goes out when it happens: the gate below would otherwise alias 12-25 Hz pulses and
      // hold a hit back by up to a send interval
      const impact = this.mix.impactEnvelope;
      const edge = pulse.key !== out.pulseKey || impact - out.impact >= IMPACT_ONSET_EDGE;
      const sinceS = this.timeS - out.lastSentS;
      if (sinceS < SEND_INTERVAL_S && !edge) continue;

      const left = useTriggers ? trig.left : 0;
      const right = useTriggers ? trig.right : 0;
      const changed =
        Math.abs(weak - out.weak) >= MAGNITUDE_EPS ||
        Math.abs(strong - out.strong) >= MAGNITUDE_EPS ||
        Math.abs(left - out.left) >= MAGNITUDE_EPS ||
        Math.abs(right - out.right) >= MAGNITUDE_EPS;
      const running = sinceS < out.durationS;
      if (!changed && running && !edge) continue;
      // Nothing to feel and the motors are already off: no need to send zeros
      if (weak === 0 && strong === 0 && left === 0 && right === 0 && out.weak === 0 && out.strong === 0 && out.left === 0 && out.right === 0) continue;

      // While a pulse runs, each effect lasts one half-period, so the motors stop at the off edge by themselves
      const durationMs = pulse.halfS > 0 ? Math.round(pulse.halfS * 1000) : EFFECT_DURATION_MS;
      if (useTriggers) playTriggerRumble(actuator, weak, strong, left, right, durationMs);
      else playDualRumble(actuator, weak, strong, durationMs);
      out.lastSentS = this.timeS;
      out.pulseKey = pulse.key;
      out.impact = impact;
      out.durationS = durationMs / 1000;
      out.weak = weak;
      out.strong = strong;
      out.left = left;
      out.right = right;
    }
    // Every connected pad has its record by now: any beyond them are pads since unplugged (a reconnect comes back
    // under a new slot or id), dropped so the map does not grow with each one
    if (this.outputs.size > pads.length) {
      for (const key of this.outputs.keys()) {
        if (!pads.some((p) => p.key === key)) this.outputs.delete(key);
      }
    }
  }

  /** Silences every pad this instance has been driving (pause, toggle off, unmount) */
  stop(): void {
    this.active = false;
    resetRumbleMixState(this.mix);
    for (const { key, actuator } of connectedPads()) {
      if (!this.outputs.has(key)) continue;
      if (actuator.reset) send(() => actuator.reset?.());
      else if (supportsTriggerRumble(actuator)) playTriggerRumble(actuator, 0, 0, 0, 0);
      else playDualRumble(actuator, 0, 0);
    }
    this.outputs.clear();
  }
}
