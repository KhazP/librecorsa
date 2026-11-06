import type { CarTelemetry } from "@/types/f1";

/**
 * Gamepad rumble for the car: the pad's two motors are driven from the physics so the player
 * feels kerbs, tyre scrub, lock-up, wheelspin, rack load and rough surfaces without looking at the
 * HUD. The weak (high-frequency) motor carries texture and kerb strikes, the strong (low-frequency)
 * motor carries the heavier cues.
 *
 * Effects are short (90 ms) and re-sent only when they change, so a stationary car does not flood
 * the device with commands. The kerb, ABS and TC pulses are the exception: each on / off edge is sent when it
 * happens, with an effect that lasts one half-period, so the 12–25 Hz pulses are felt at their rate rather than
 * aliased by the 60 ms send gate.
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
const ABS_PULSE_HZ = 20;
const TC_PULSE_HZ = 25;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** clamp01, with a non-finite input read as no effect */
const magnitude01 = (v: number) => (Number.isFinite(v) ? clamp01(v) : 0);

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

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

/** Motor magnitudes (0..1) for the current car state; `timeS` drives the kerb pulse */
function hapticMagnitudes(t: CarTelemetry, timeS: number): { weak: number; strong: number } {
  const speedFactor = clamp01(t.speedKmh / 300);

  // Weak motor: kerb strikes pulse on and off, front-tyre scrub near the limit, faint road texture
  const onKerb = t.onKerbLeft || t.onKerbRight;
  const kerbPulseOn = (timeS * KERB_PULSE_HZ) % 1 < 0.5;
  const kerb = onKerb && kerbPulseOn ? 0.55 + 0.35 * speedFactor : 0;
  const frontSlip = Math.max(t.tireSlipRatio[0], t.tireSlipRatio[1]);
  const scrub = 0.4 * smoothstep(0.85, 1.15, frontSlip);
  const texture = 0.04 * speedFactor;
  const weak = clamp01(kerb + scrub + texture);

  // Strong motor: lock-up and wheelspin, a constant rack-load cue and rough surfaces
  const minSlip = Math.min(...t.wheelSlipRatios);
  const lockUp = t.speedKmh > 30 ? 0.8 * smoothstep(0.12, 0.45, -minSlip) : 0;
  const rearSlip = Math.max(t.wheelSlipRatios[2], t.wheelSlipRatios[3]);
  const wheelspin = 0.6 * smoothstep(0.12, 0.5, rearSlip);
  const rackLoad = 0.25 * Math.pow(clamp01(Math.abs(t.ffbTorqueNorm ?? 0)), 1.5);
  const roughSurface = t.surface === "grass" || t.surface === "runoff" ? 0.35 : 0;
  const strong = clamp01(lockUp + wheelspin + rackLoad + roughSurface);

  return { weak, strong };
}

/**
 * Impulse-trigger magnitudes (0..1) for the car: the left trigger (brake) feels ABS / lock-up as a 20 Hz pulse,
 * the right trigger (throttle) feels wheelspin, and traction control as a 25 Hz pulse. Zero when there is nothing to feel.
 */
export function triggerMagnitudes(t: CarTelemetry, timeS: number): { left: number; right: number } {
  // Left trigger: a locked or ABS-releasing front axle pushes back through the brake
  let left = 0;
  if (t.brake > 0.05) {
    const minSlip = Math.min(...t.wheelSlipRatios);
    const locking = t.f12026?.absActive === true || (t.speedKmh > 30 && minSlip < -0.12);
    if (locking) {
      const lockScale = clamp01(-minSlip / 0.45);
      const pulseOn = (timeS * ABS_PULSE_HZ) % 1 < 0.5;
      left = pulseOn ? 0.35 + 0.45 * lockScale : 0;
    }
  }

  // Right trigger: spinning rear wheels push back through the throttle; TC cuts the throttle in pulses
  let right = 0;
  if (t.throttle > 0.1) {
    const rearSlip = Math.max(t.wheelSlipRatios[2], t.wheelSlipRatios[3]);
    const spinning = t.f12026?.tcActive === true || rearSlip > 0.12;
    if (spinning) {
      const spinScale = clamp01(rearSlip / 0.5);
      const pulseOn = t.f12026?.tcActive === true ? (timeS * TC_PULSE_HZ) % 1 < 0.5 : true;
      right = pulseOn ? 0.25 + 0.45 * spinScale : 0;
    }
  }

  return { left: magnitude01(left), right: magnitude01(right) };
}

/** Every connected pad that exposes a vibration actuator */
function connectedPads(): ConnectedPad[] {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return [];
  const pads: ConnectedPad[] = [];
  navigator.getGamepads().forEach((pad, index) => {
    const actuator = (pad as { vibrationActuator?: VibrationActuatorLike | null } | null)?.vibrationActuator;
    if (actuator && typeof actuator.playEffect === "function") pads.push({ key: `${index}|${pad?.id ?? ""}`, actuator });
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

  /**
   * Call once per frame after the physics step; `enabled` is false while paused or when the toggle is off.
   * `options.triggerRumble` also drives the Xbox impulse triggers on pads that support them (default off).
   */
  update(t: CarTelemetry, dtSeconds: number, enabled: boolean, options?: { triggerRumble?: boolean }): void {
    this.timeS += dtSeconds;
    if (!enabled) {
      if (this.active) this.stop();
      return;
    }
    this.active = true;

    const { weak, strong } = hapticMagnitudes(t, this.timeS);
    const wantTriggers = options?.triggerRumble === true;
    const trig = wantTriggers ? triggerMagnitudes(t, this.timeS) : { left: 0, right: 0 };
    for (const { key, actuator } of connectedPads()) {
      const out = this.outputs.get(key) ?? {
        lastSentS: -Infinity,
        weak: 0,
        strong: 0,
        left: 0,
        right: 0,
        pulseKey: 0,
        durationS: EFFECT_DURATION_MS / 1000,
      };
      this.outputs.set(key, out);

      const useTriggers = wantTriggers && supportsTriggerRumble(actuator);
      const pulse = pulseState(t, this.timeS, useTriggers);
      // A pulse edge goes out when it happens: the gate below would otherwise alias 12-25 Hz pulses
      const edge = pulse.key !== out.pulseKey;
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
      out.durationS = durationMs / 1000;
      out.weak = weak;
      out.strong = strong;
      out.left = left;
      out.right = right;
    }
  }

  /** Silences every pad this instance has been driving (pause, toggle off, unmount) */
  stop(): void {
    this.active = false;
    for (const { key, actuator } of connectedPads()) {
      if (!this.outputs.has(key)) continue;
      if (actuator.reset) send(() => actuator.reset?.());
      else if (supportsTriggerRumble(actuator)) playTriggerRumble(actuator, 0, 0, 0, 0);
      else playDualRumble(actuator, 0, 0);
    }
    this.outputs.clear();
  }
}
