/**
 * Controller and sim-wheel input: reads every connected Gamepad API device through the player's
 * bindings and calibration. Wheel, pedals and a button box may be separate USB devices, so each
 * binding names its device by `Gamepad.id`.
 *
 * Without a wheel calibration the behaviour matches the original input code: a standard-mapping
 * controller sends its stick through the physics' steering assist, any other device steers the rack
 * from axis 0 with buttons 7 / 6 as throttle / brake.
 */
import {
  DEFAULT_PAD_BUTTONS,
  PAD_ACTIONS,
  PAD_BRAKE_BUTTON,
  PAD_THROTTLE_BUTTON,
  type PadAction,
  type PadButtonBindings,
} from "./bindings";

export type InputDevice = "keyboard" | "controller" | "wheel";
export type WheelType = "direct_drive" | "belt_gear";

export interface AxisBinding {
  padId: string;
  axis: number;
  /** Raw value with the wheel centred */
  center: number;
  /** True when turning left raises the raw value (steering must be + = right) */
  invert: boolean;
}

export interface PedalBinding {
  padId: string;
  axis: number;
  /** Raw value released / fully pressed (full < idle for inverted pedals) */
  idle: number;
  full: number;
}

export interface ButtonBinding {
  padId: string;
  button: number;
}

export interface WheelSettings {
  type: WheelType;
  /** Rotation the wheel's driver is set to (degrees lock to lock) */
  rotationDeg: number;
  steer: AxisBinding | null;
  throttle: PedalBinding | null;
  brake: PedalBinding | null;
  /** Brake response curve: 1 linear, > 1 finer control at light pressure */
  brakeGamma: number;
  /** Steering dead zone around centre (fraction of half the rotation) */
  steerDeadzone: number;
  /** Steering low-pass time constant (s); 0 = raw */
  steerSmoothingS: number;
  /** Force feedback through the local DirectInput bridge (`npm run ffb`); off until the player turns it on */
  ffbEnabled: boolean;
  /** FFB strength 0..2 (1 = the physics' steering torque at full scale) */
  ffbGain: number;
  /** Minimum force 0..0.2: lifts small torques over a belt / gear wheel's friction (AC's MIN_FF) */
  ffbMinForce: number;
  /** Kerb vibration 0..1 */
  ffbKerb: number;
  /** ABS vibration 0..1 */
  ffbAbs: number;
  /** Reverse the force (for a wheel whose driver pushes the other way) */
  ffbInvert: boolean;
  /** Rim damping 0..1: resists fast rim movement (calms a direct-drive base, adds weight to a belt wheel) */
  ffbDamping: number;
  /** Force low-pass time constant (s, 0..0.05); 0 = unfiltered */
  ffbFilterS: number;
  /** Strength per car (gain, minimum force) set from the FFB panel; a car without one uses ffbGain / ffbMinForce */
  ffbPerCar: Partial<Record<string, { gain: number; minForce: number }>>;
  /** Experimental: drive a HID PID (direct-drive) wheel straight from the browser over WebHID, no bridge */
  hidFfb: boolean;
  /** Stream telemetry over UDP through the bridge (SimHub, bass shakers, dashboards) */
  telemetryOut: boolean;
  /** UDP port the bridge sends telemetry to on this PC */
  telemetryPort: number;
  buttons: Record<PadAction, ButtonBinding | null>;
}

/** Steering-wheel rotation of the cars, lock to lock (1:1 soft lock) */
export const CAR_WHEEL_LOCK_DEG = 360;

export const WHEEL_ROTATION_PRESETS = [360, 540, 900, 1080] as const;

/** Direct-drive bases are precise and noise-free; belt / gear wheels get a small dead zone and filter */
export const WHEEL_TYPE_DEFAULTS: Record<WheelType, Pick<WheelSettings, "steerDeadzone" | "steerSmoothingS" | "rotationDeg">> = {
  direct_drive: { steerDeadzone: 0, steerSmoothingS: 0, rotationDeg: 1080 },
  belt_gear: { steerDeadzone: 0.01, steerSmoothingS: 0.025, rotationDeg: 900 },
};

export const emptyWheelButtons = (): Record<PadAction, ButtonBinding | null> =>
  Object.fromEntries(PAD_ACTIONS.map((a) => [a.id, null])) as Record<PadAction, ButtonBinding | null>;

export const DEFAULT_WHEEL_SETTINGS: WheelSettings = {
  type: "direct_drive",
  ...WHEEL_TYPE_DEFAULTS.direct_drive,
  steer: null,
  throttle: null,
  brake: null,
  brakeGamma: 1,
  ffbEnabled: false,
  ffbGain: 1,
  ffbMinForce: 0,
  ffbKerb: 0.35,
  ffbAbs: 0.2,
  ffbInvert: false,
  ffbDamping: 0.1,
  ffbFilterS: 0,
  ffbPerCar: {},
  hidFfb: false,
  telemetryOut: false,
  telemetryPort: 20777,
  buttons: emptyWheelButtons(),
};

/** Stick feel presets for the controller steering assist */
export type PadSensitivity = "smooth" | "default" | "sharp";
export const PAD_SENSITIVITY: Record<PadSensitivity, { steeringRate: number; deadzone: number; label: string; detail: string }> = {
  smooth: { steeringRate: 0.35, deadzone: 0.07, label: "Smooth", detail: "Slower, calmer steering" },
  default: { steeringRate: 0.5, deadzone: 0.05, label: "Default", detail: "Balanced response" },
  sharp: { steeringRate: 0.75, deadzone: 0.04, label: "Sharp", detail: "Quick turn-in" },
};

/** What the simulator needs from the device layer */
export interface DeviceInputSettings {
  wheel: WheelSettings;
  padButtons: PadButtonBindings;
}

/** Minimal Gamepad shape (the real Gamepad satisfies it; tests pass plain objects) */
export interface PadLike {
  id: string;
  index: number;
  mapping: string;
  connected?: boolean;
  axes: readonly number[];
  buttons: readonly { value: number; pressed: boolean }[];
}

export interface DeviceFrame {
  throttle: number;
  brake: number;
  /** Steering straight to the rack (wheel), −1..1, + = right */
  analogSteer?: number;
  /** Raw controller stick for the physics' steering assist */
  padSteer?: number;
  boostHeld: boolean;
  /** Button actions pressed this frame (rising edges) */
  pressed: Set<PadAction>;
  source: "wheel" | "controller" | "legacy" | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function connectedPads(): PadLike[] {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return [];
  return navigator.getGamepads().filter((p): p is Gamepad => Boolean(p && p.connected !== false));
}

export function findPad(pads: readonly PadLike[], padId: string): PadLike | undefined {
  return pads.find((p) => p.id === padId);
}

const WHEEL_ID = /wheel|fanatec|moza|simucube|simagic|thrustmaster|logitech g(2|9)|g29|g920|g923|g pro|t300|t150|t248|tmx|csl|podium|clubsport|asetek|cammus|accuforce|vrs/i;

/** Sim wheels rarely report the standard mapping; names give the rest away */
export function isLikelyWheel(pad: Pick<PadLike, "id" | "mapping">): boolean {
  return WHEEL_ID.test(pad.id) || pad.mapping !== "standard";
}

/** Short readable device name from a Gamepad.id ("Xbox Wireless Controller (STANDARD GAMEPAD …)") */
export function padDisplayName(id: string): string {
  const cleaned = id
    .replace(/\(.*?(vendor|product|standard gamepad).*?\)/gi, "")
    .replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, "")
    .trim();
  return cleaned || id;
}

/** Calibrated pedal 0..1 (inversion falls out of idle / full) */
export function pedalValue(raw: number, binding: Pick<PedalBinding, "idle" | "full">, gamma = 1): number {
  const span = binding.full - binding.idle;
  if (Math.abs(span) < 1e-3) return 0;
  const n = clamp((raw - binding.idle) / span, 0, 1);
  // 2 % slack at the idle end hides sensor noise on a resting pedal
  const v = n < 0.02 ? 0 : (n - 0.02) / 0.98;
  return gamma === 1 ? v : Math.pow(v, gamma);
}

/**
 * Wheel axis → rack command −1..1 (+ = right). The device angle maps 1:1 onto the car's steering
 * wheel (soft lock): a 900° wheel turned 180° gives full lock on a 360° car.
 */
export function wheelSteerValue(
  raw: number,
  binding: Pick<AxisBinding, "center" | "invert">,
  rotationDeg: number,
  deadzone = 0
): number {
  let c = clamp((raw - binding.center) * (binding.invert ? -1 : 1), -1, 1);
  if (deadzone > 0) {
    const a = Math.abs(c);
    c = a <= deadzone ? 0 : (Math.sign(c) * (a - deadzone)) / (1 - deadzone);
  }
  return clamp((c * rotationDeg) / CAR_WHEEL_LOCK_DEG, -1, 1);
}

/** Rim angle from centre (degrees, + = right) of a calibrated steering axis, before the car's lock clamps it */
export function wheelRimAngleDeg(raw: number, binding: Pick<AxisBinding, "center" | "invert">, rotationDeg: number): number {
  return (clamp((raw - binding.center) * (binding.invert ? -1 : 1), -1, 1) * rotationDeg) / 2;
}

const buttonDown = (pad: PadLike | undefined, button: number) => {
  const b = pad?.buttons[button];
  return Boolean(b && (b.pressed || b.value > 0.5));
};

/** Per-frame reader: holds the button edge state and the steering filter */
export class DeviceInputReader {
  private prevHeld = new Set<PadAction>();
  private smoothedSteer = 0;

  read(pads: readonly PadLike[], settings: DeviceInputSettings, dtSeconds: number): DeviceFrame {
    const held = new Set<PadAction>();
    const frame: DeviceFrame = { throttle: 0, brake: 0, boostHeld: false, pressed: new Set(), source: null };
    const wheel = settings.wheel;
    const wheelPad = wheel.steer ? findPad(pads, wheel.steer.padId) : undefined;

    if (wheel.steer && wheelPad) {
      frame.source = "wheel";
      const target = wheelSteerValue(wheelPad.axes[wheel.steer.axis] ?? wheel.steer.center, wheel.steer, wheel.rotationDeg, wheel.steerDeadzone);
      if (wheel.steerSmoothingS > 0 && dtSeconds > 0) {
        this.smoothedSteer += (target - this.smoothedSteer) * (1 - Math.exp(-dtSeconds / wheel.steerSmoothingS));
      } else {
        this.smoothedSteer = target;
      }
      frame.analogSteer = this.smoothedSteer;

      const pedal = (b: PedalBinding | null, gamma: number, fallbackButton: number) => {
        if (b) {
          const p = findPad(pads, b.padId);
          return p ? pedalValue(p.axes[b.axis] ?? b.idle, b, gamma) : 0;
        }
        return wheelPad.buttons[fallbackButton]?.value ?? 0;
      };
      frame.throttle = pedal(wheel.throttle, 1, PAD_THROTTLE_BUTTON);
      frame.brake = pedal(wheel.brake, wheel.brakeGamma, PAD_BRAKE_BUTTON);

      for (const { id } of PAD_ACTIONS) {
        const b = wheel.buttons[id];
        if (b && buttonDown(findPad(pads, b.padId), b.button)) held.add(id);
      }
    } else {
      const controller = pads.find((p) => p.mapping === "standard");
      const pad = controller ?? pads[0];
      if (pad) {
        const rawStickX = pad.axes[0] || 0;
        if (pad.mapping === "standard") {
          frame.source = "controller";
          frame.padSteer = rawStickX;
          frame.throttle = pad.buttons[PAD_THROTTLE_BUTTON]?.value ?? 0;
          frame.brake = pad.buttons[PAD_BRAKE_BUTTON]?.value ?? 0;
        } else {
          frame.source = "legacy";
          if (Math.abs(rawStickX) > 0.04) frame.analogSteer = rawStickX;
          const tPad = wheel.throttle ? findPad(pads, wheel.throttle.padId) : undefined;
          const bPad = wheel.brake ? findPad(pads, wheel.brake.padId) : undefined;
          frame.throttle =
            wheel.throttle && tPad
              ? pedalValue(tPad.axes[wheel.throttle.axis] ?? wheel.throttle.idle, wheel.throttle, 1)
              : (pad.buttons[PAD_THROTTLE_BUTTON]?.value ?? 0);
          frame.brake =
            wheel.brake && bPad
              ? pedalValue(bPad.axes[wheel.brake.axis] ?? wheel.brake.idle, wheel.brake, wheel.brakeGamma)
              : (pad.buttons[PAD_BRAKE_BUTTON]?.value ?? 0);
        }
        const map = pad.mapping === "standard" ? settings.padButtons : DEFAULT_PAD_BUTTONS;
        for (const { id } of PAD_ACTIONS) {
          const button = map[id];
          if (button !== null && buttonDown(pad, button)) held.add(id);
        }
      }
    }

    for (const a of held) if (!this.prevHeld.has(a)) frame.pressed.add(a);
    this.prevHeld = held;
    frame.boostHeld = held.has("boost");
    return frame;
  }
}

/** Pedal sets, shifters and handbrakes share the wheel brands' names but never steer */
const NOT_A_WHEEL_BASE = /pedal|srp|sr-p|handbrake|shifter|hgp|sequential/i;

/**
 * Steering binding for a wheel recognised by name that has none yet: axis 0, centred where it rests, with the
 * base type's rotation / filter defaults. Null when there is nothing to bind (already bound, or no named wheel:
 * an unknown non-standard device may be pedals or a button box, so it is never bound blindly).
 */
export function autoConfigureWheel(pads: readonly PadLike[], current: WheelSettings): Partial<WheelSettings> | null {
  if (current.steer) return null;
  const wheelPad = pads.find((p) => WHEEL_ID.test(p.id) && !NOT_A_WHEEL_BASE.test(p.id) && p.axes.length > 0);
  if (!wheelPad) return null;
  const type: WheelType = /g29|g920|g923|t150|t248|t300|tmx/i.test(wheelPad.id) ? "belt_gear" : "direct_drive";
  const rest = wheelPad.axes[0] ?? 0;
  return {
    type,
    ...WHEEL_TYPE_DEFAULTS[type],
    ffbEnabled: true,
    steer: { padId: wheelPad.id, axis: 0, center: Math.abs(rest) < 0.25 ? rest : 0, invert: false },
  };
}

// ---- Calibration helpers for the setup screens ----

export type AxisSnapshot = Map<string, number[]>;

export function snapshotAxes(pads: readonly PadLike[]): AxisSnapshot {
  return new Map(pads.map((p) => [p.id, [...p.axes]]));
}

/** The axis that moved furthest from `baseline` (any device) */
export function strongestAxisChange(
  baseline: AxisSnapshot,
  pads: readonly PadLike[],
  exclude?: { padId: string; axis: number } | null
): { padId: string; axis: number; base: number; value: number; delta: number } | null {
  let best: { padId: string; axis: number; base: number; value: number; delta: number } | null = null;
  for (const pad of pads) {
    const base = baseline.get(pad.id);
    if (!base) continue;
    pad.axes.forEach((value, axis) => {
      if (exclude && exclude.padId === pad.id && exclude.axis === axis) return;
      const delta = value - (base[axis] ?? 0);
      if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { padId: pad.id, axis, base: base[axis] ?? 0, value, delta };
    });
  }
  return best;
}

export type ButtonSnapshot = Map<string, boolean[]>;

export function snapshotButtons(pads: readonly PadLike[]): ButtonSnapshot {
  return new Map(pads.map((p) => [p.id, p.buttons.map((b) => b.pressed || b.value > 0.5)]));
}

/** First button that is down now but was up in `prev` */
export function newlyPressedButton(prev: ButtonSnapshot, pads: readonly PadLike[]): ButtonBinding | null {
  for (const pad of pads) {
    const before = prev.get(pad.id) ?? [];
    for (let i = 0; i < pad.buttons.length; i++) {
      const b = pad.buttons[i];
      if ((b.pressed || b.value > 0.5) && !before[i]) return { padId: pad.id, button: i };
    }
  }
  return null;
}
