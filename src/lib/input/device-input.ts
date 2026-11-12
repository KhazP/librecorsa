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
import { logitechClassicModel, logitechHidppModel } from "./wheel-support";

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
  /** Minimum force 0..0.2: lifts small torques over a belt / gear wheel's static friction */
  ffbMinForce: number;
  /**
   * Force curve exponent 0.5..2 on the physics torque (see applyFfbCurve in wheel-ffb.ts): 1 linear, below 1 lifts
   * light forces, above 1 keeps them light for more detail in the big loads
   */
  ffbCurve: number;
  /** Kerb vibration 0..1 */
  ffbKerb: number;
  /** ABS vibration 0..1 */
  ffbAbs: number;
  /** Tyre slide / wheelspin vibration 0..1, from just before the tyres' peak slip (WebHID wheels) */
  ffbSlip: number;
  /** Shift-warning vibration 0..1 as the revs reach the shift lights (WebHID wheels); 0 = off */
  ffbShift: number;
  /** Reverse the force (for a wheel whose driver pushes the other way) */
  ffbInvert: boolean;
  /** Rim damping 0..1: resists fast rim movement (calms a direct-drive base, adds weight to a belt wheel) */
  ffbDamping: number;
  /** Force low-pass time constant (s, 0..0.05); 0 = unfiltered */
  ffbFilterS: number;
  /** Friction 0..1 the wheel runs itself (HID PID bases that offer it, over WebHID); 0 = off, and not set up */
  ffbFriction: number;
  /** Inertia 0..1 the wheel runs itself (HID PID bases that offer it, over WebHID); 0 = off, and not set up */
  ffbInertia: number;
  /**
   * Downforce compensation 0..1: the exponent k of (static front load / current front load)^k on the physics torque,
   * so the aero load at speed does not make the rim heavier. 0 = off, 1 = the full aero share taken out
   */
  ffbDownforceComp: number;
  /** Collision protection: slew-limits the force through a hit so its spike never reaches the rim */
  ffbCollisionGuard: boolean;
  /** Strength per car (gain, minimum force) set from the FFB panel; a car without one uses ffbGain / ffbMinForce */
  ffbPerCar: Partial<Record<string, { gain: number; minForce: number }>>;
  /**
   * Steering-wheel lock to lock (deg) per vehicle model, for a quicker rack than the real car's: full lock comes this
   * far round the rim. A car without one steers 1:1 with its real lock (`CAR_WHEEL_LOCKS_DEG`)
   */
  steerLockPerCar: Partial<Record<string, number>>;
  /**
   * Experimental: force feedback straight from the browser over WebHID, no bridge. Drives HID PID bases, and the
   * Logitech G25 / G27 / G29 / Driving Force GT with the classic Logitech commands (webhid-ffb.ts). Other Logitech
   * wheels start on the bridge (see autoConfigureWheel), since WebHID cannot drive them
   */
  hidFfb: boolean;
  /** Rev lights on the rim (Logitech G27 / G29 over WebHID force feedback), from the car's shift-light range */
  revLeds: boolean;
  /** Stream telemetry over UDP through the bridge (SimHub, bass shakers, dashboards) */
  telemetryOut: boolean;
  /** UDP port the bridge sends telemetry to on this PC */
  telemetryPort: number;
  buttons: Record<PadAction, ButtonBinding | null>;
}

/** Default steering-wheel rotation of Formula cars, lock to lock (1:1 soft lock) */
export const CAR_WHEEL_LOCK_DEG = 360;

/**
 * Per-car real steering-wheel rotation lock-to-lock (degrees): 360° for Formula cars, 640° for the GT3 (320° each way),
 * 1080° for the Liana (540° each way), 480° for the 496R (240° each way)
 */
export const CAR_WHEEL_LOCKS_DEG: Readonly<Record<string, number>> = {
  vf26: 360,
  "f12026-car": 360,
  "amg-gt3": 640,
  liana: 1080,
  "mtr-496r": 480,
};

/** Range of a player-set steering lock (deg, lock to lock): never slower than the real car's */
export const STEER_LOCK_MIN_DEG = 180;

/**
 * Steering-wheel lock-to-lock rotation (degrees) for a vehicle model: the player's own lock for it when set (and
 * quicker than the real car's), else the real car's
 */
export function carWheelLockDeg(vehicle?: string, playerLocks?: WheelSettings["steerLockPerCar"]): number {
  const real = (vehicle && CAR_WHEEL_LOCKS_DEG[vehicle]) || CAR_WHEEL_LOCK_DEG;
  const own = vehicle ? playerLocks?.[vehicle] : undefined;
  return typeof own === "number" && Number.isFinite(own) && own >= STEER_LOCK_MIN_DEG && own < real ? own : real;
}

export const WHEEL_ROTATION_PRESETS = [360, 540, 900, 1080] as const;

/** Direct-drive bases are precise and noise-free; belt / gear wheels get a small dead zone and filter */
export const WHEEL_TYPE_DEFAULTS: Record<WheelType, Pick<WheelSettings, "steerDeadzone" | "steerSmoothingS" | "rotationDeg">> = {
  direct_drive: { steerDeadzone: 0, steerSmoothingS: 0, rotationDeg: 1080 },
  belt_gear: { steerDeadzone: 0.01, steerSmoothingS: 0.025, rotationDeg: 900 },
};

export const emptyWheelButtons = (): Record<PadAction, ButtonBinding | null> =>
  Object.fromEntries(PAD_ACTIONS.map((a) => [a.id, null])) as Record<PadAction, ButtonBinding | null>;

/**
 * Default UDP port of telemetry out. Not 20777: that is the F1 games' binary telemetry port, and tools listening there
 * (SimHub's F1 plugin, dashboards) would try to parse our JSON as F1 packets.
 */
export const DEFAULT_TELEMETRY_PORT = 20790;
/** Telemetry-out ports another sim's tools listen on, with what they expect there */
export const CLAIMED_TELEMETRY_PORTS: Readonly<Record<number, string>> = { 20777: "the F1 games' telemetry" };

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
  ffbCurve: 1,
  ffbKerb: 0.35,
  ffbAbs: 0.2,
  ffbSlip: 1,
  ffbShift: 0,
  ffbInvert: false,
  ffbDamping: 0.1,
  ffbFilterS: 0,
  ffbFriction: 0,
  ffbInertia: 0,
  ffbDownforceComp: 0,
  ffbCollisionGuard: true,
  ffbPerCar: {},
  steerLockPerCar: {},
  hidFfb: true,
  revLeds: true,
  telemetryOut: false,
  telemetryPort: DEFAULT_TELEMETRY_PORT,
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
  /** Button actions held down this frame (a held camera button opens the seat panel) */
  held?: ReadonlySet<PadAction>;
  source: "wheel" | "controller" | "legacy" | null;
  /**
   * The bound steering wheel, or a separate pedal set bound to it, was there last frame and is gone now (unplugged,
   * asleep): pause, don't hand over
   */
  wheelLost?: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Connected Gamepad API devices. Two identical devices (two of the same pedal set or button box) report the same
 * Gamepad.id, and bindings and calibration are keyed by id: the second and later ones get " #2", " #3" … appended
 * (in slot order), so each can be bound on its own. A lone device keeps its plain id, as saved bindings expect.
 */
export function connectedPads(): PadLike[] {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return [];
  const pads = navigator.getGamepads().filter((p): p is Gamepad => Boolean(p && p.connected !== false));
  const seen = new Map<string, number>();
  return pads.map((p) => {
    const n = (seen.get(p.id) ?? 0) + 1;
    seen.set(p.id, n);
    if (n === 1) return p;
    return {
      id: `${p.id} #${n}`,
      index: p.index,
      mapping: p.mapping,
      connected: p.connected,
      axes: p.axes,
      buttons: p.buttons,
      vibrationActuator: (p as { vibrationActuator?: unknown }).vibrationActuator,
    } as PadLike;
  });
}

export function findPad(pads: readonly PadLike[], padId: string): PadLike | undefined {
  return pads.find((p) => p.id === padId);
}

const WHEEL_ID = /wheel|pxn|v99|fanatec|moza|simucube|simagic|thrustmaster|logitech g(2|9)|g29|g920|g923|g pro|t300|t150|t248|tmx|csl|podium|clubsport|asetek|cammus|accuforce|vrs/i;

/** USB ids in a Gamepad.id: Chrome appends "(… Vendor: 046d Product: c29a)", Firefox starts with "046d-c29a-" */
function padUsbIds(id: string): { vendorId: number; productId: number } | null {
  const m = /vendor:\s*([0-9a-f]{4})\b.*?product:\s*([0-9a-f]{4})\b/i.exec(id) ?? /^([0-9a-f]{4})-([0-9a-f]{4})-/i.exec(id);
  return m ? { vendorId: parseInt(m[1] as string, 16), productId: parseInt(m[2] as string, 16) } : null;
}

/** One of the gear-driven Logitech wheels in LOGITECH_CLASSIC_WHEELS (wheel-support.ts), by its USB ids */
function isLogitechClassicPad(id: string): boolean {
  const ids = padUsbIds(id);
  return ids !== null && logitechClassicModel(ids.vendorId, ids.productId) !== null;
}

/** One of the HID++ Logitech wheels in LOGITECH_HIDPP_WHEELS (G920, G923 for Xbox), by its USB ids */
function isLogitechHidppPad(id: string): boolean {
  const ids = padUsbIds(id);
  return ids !== null && logitechHidppModel(ids.vendorId, ids.productId) !== null;
}

const isWheelId = (id: string) => WHEEL_ID.test(id) || isLogitechClassicPad(id) || isLogitechHidppPad(id);

/** Sim wheels rarely report the standard mapping; names (or a listed Logitech's USB ids) give the rest away */
export function isLikelyWheel(pad: Pick<PadLike, "id" | "mapping">): boolean {
  return isWheelId(pad.id) || pad.mapping !== "standard";
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
 * wheel (soft lock): a 900° wheel turned 180° gives full lock on a 360° car, or 320° on a 640° GT3 car.
 * When the base is set narrower than the car's lock (e.g. 540° on a 640° GT3), full base travel maps to full lock.
 */
export function wheelSteerValue(
  raw: number,
  binding: Pick<AxisBinding, "center" | "invert">,
  rotationDeg: number,
  deadzone = 0,
  carLockDeg: number = CAR_WHEEL_LOCK_DEG
): number {
  let c = clamp((raw - binding.center) * (binding.invert ? -1 : 1), -1, 1);
  if (deadzone > 0) {
    const a = Math.abs(c);
    c = a <= deadzone ? 0 : (Math.sign(c) * (a - deadzone)) / (1 - deadzone);
  }
  const lock = carLockDeg > 0 ? carLockDeg : CAR_WHEEL_LOCK_DEG;
  const effectiveLock = rotationDeg > 0 ? Math.min(rotationDeg, lock) : lock;
  return clamp((c * rotationDeg) / effectiveLock, -1, 1);
}

/** Rim angle from centre (degrees, + = right) of a calibrated steering axis, before the car's lock clamps it */
export function wheelRimAngleDeg(raw: number, binding: Pick<AxisBinding, "center" | "invert">, rotationDeg: number): number {
  return (clamp((raw - binding.center) * (binding.invert ? -1 : 1), -1, 1) * rotationDeg) / 2;
}

const buttonDown = (pad: PadLike | undefined, button: number) => {
  const b = pad?.buttons[button];
  return Boolean(b && (b.pressed || b.value > 0.5));
};

/** The devices a wheel binding names (the steering's, then any separate pedals'); null without a steering binding */
function boundWheelDevices(wheel: WheelSettings): string | null {
  return wheel.steer ? [wheel.steer.padId, wheel.throttle?.padId ?? "", wheel.brake?.padId ?? ""].join("\n") : null;
}

/** Per-frame reader: holds the button edge state and the steering filter */
export class DeviceInputReader {
  private prevHeld = new Set<PadAction>();
  /** The device the buttons were read from last frame ("wheel", or the source and pad id); null with none */
  private prevSource: string | null = null;
  private smoothedSteer = 0;
  /** The bound wheel devices last frame ({@link boundWheelDevices}) and whether they were all connected */
  private wheelDevices: string | null = null;
  private wheelPresent = false;

  read(pads: readonly PadLike[], settings: DeviceInputSettings, dtSeconds: number, vehicle?: string): DeviceFrame {
    const held = new Set<PadAction>();
    const frame: DeviceFrame = { throttle: 0, brake: 0, boostHeld: false, pressed: new Set(), source: null };
    const wheel = settings.wheel;
    const wheelPad = wheel.steer ? findPad(pads, wheel.steer.padId) : undefined;
    // Pedals on their own USB device count too: losing the brake pedal silently is worse than losing the wheel
    const present =
      wheelPad !== undefined &&
      (!wheel.throttle || findPad(pads, wheel.throttle.padId) !== undefined) &&
      (!wheel.brake || findPad(pads, wheel.brake.padId) !== undefined);
    // Lost means the same bound devices were all connected last frame and one is gone now: clearing or rebinding the
    // steering (or the pedals) with everything plugged in is a settings change, not an unplug
    const devices = boundWheelDevices(wheel);
    if (devices !== null && devices === this.wheelDevices && this.wheelPresent && !present) frame.wheelLost = true;
    this.wheelDevices = devices;
    this.wheelPresent = present;
    let source: string | null = null;

    if (wheel.steer && wheelPad) {
      frame.source = "wheel";
      source = "wheel";
      const target = wheelSteerValue(
        wheelPad.axes[wheel.steer.axis] ?? wheel.steer.center,
        wheel.steer,
        wheel.rotationDeg,
        wheel.steerDeadzone,
        carWheelLockDeg(vehicle, wheel.steerLockPerCar)
      );
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
          // 4 % dead zone, then a short ramp that rejoins the raw value at 8 %: the output no longer jumps from 0 to
          // 0.04 at the edge, and past the ramp the axis stays 1:1 (this path is often an uncalibrated wheel)
          const a = Math.abs(rawStickX);
          if (a > 0.04) frame.analogSteer = Math.sign(rawStickX) * (a >= 0.08 ? a : (a - 0.04) * 2);
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
        source = `${frame.source}:${pad.id}`;
      }
    }

    // The input moved to another device (wheel unplugged, a second pad took over): what is already held there is the
    // new baseline, not a press. From no device at all it counts: a browser shows a pad only once a button is pressed
    const switched = this.prevSource !== null && source !== null && source !== this.prevSource;
    if (!switched) for (const a of held) if (!this.prevHeld.has(a)) frame.pressed.add(a);
    this.prevHeld = held;
    this.prevSource = source;
    frame.held = held;
    frame.boostHeld = held.has("boost");
    return frame;
  }
}

/** Belt / gear-driven bases (the rest are taken as direct drive); the CSL Elite is belt-driven, the CSL DD is not */
const BELT_GEAR_ID = /pxn|v99|g25|g27|g29|g920|g923|t150|t248|t300|tmx|csl elite/i;
/** Logitech devices, by name or by the vendor id Chrome puts in Gamepad.id ("Vendor: 046d") */
const LOGITECH_ID = /logitech|\b046d\b/i;
/** Pedal sets, shifters and handbrakes share the wheel brands' names but never steer */
const NOT_A_WHEEL_BASE = /pedal|srp|sr-p|handbrake|shifter|hgp|sequential/i;
/** Virtual joysticks (vJoy / SimHub Control Mapper) mirror physical devices and should yield to real hardware */
export const isVirtualPad = (padId: string): boolean => /vjoy|virtual joystick/i.test(padId);

/**
 * Steering binding for a wheel recognised by name (or a listed Logitech by its USB ids) that has none yet: axis 0,
 * centred where it rests, with the base type's rotation / filter defaults. Null when there is nothing to bind (already
 * bound, or no named wheel: an unknown non-standard device may be pedals or a button box, so it is never bound blindly).
 */
export function autoConfigureWheel(pads: readonly PadLike[], current: WheelSettings): Partial<WheelSettings> | null {
  if (current.steer) return null;
  const wheelPad = pads.find((p) => isWheelId(p.id) && !NOT_A_WHEEL_BASE.test(p.id) && !isVirtualPad(p.id) && p.axes.length > 0);
  if (!wheelPad) return null;
  const type: WheelType =
    BELT_GEAR_ID.test(wheelPad.id) || isLogitechClassicPad(wheelPad.id) || isLogitechHidppPad(wheelPad.id) ? "belt_gear" : "direct_drive";
  const rest = wheelPad.axes[0] ?? 0;
  return {
    type,
    ...WHEEL_TYPE_DEFAULTS[type],
    ffbEnabled: true,
    // WebHID unless it is a Logitech wheel WebHID cannot drive (G923 for PlayStation, G PRO): those start on the local bridge
    hidFfb: !LOGITECH_ID.test(wheelPad.id) || isLogitechClassicPad(wheelPad.id) || isLogitechHidppPad(wheelPad.id),
    steer: { padId: wheelPad.id, axis: 0, center: Math.abs(rest) < 0.25 ? rest : 0, invert: false },
  };
}

// ---- Calibration helpers for the setup screens ----

export type AxisSnapshot = Map<string, number[]>;

export function snapshotAxes(pads: readonly PadLike[]): AxisSnapshot {
  const m: AxisSnapshot = new Map();
  for (const p of pads) {
    if (!m.has(p.id) || (m.get(p.id)?.length === 0 && p.axes.length > 0)) {
      m.set(p.id, [...p.axes]);
    }
  }
  return m;
}

export interface AxisChange {
  padId: string;
  axis: number;
  base: number;
  value: number;
  delta: number;
}

/**
 * The axis that moved furthest from `baseline`, skipping `exclude`d axes. A real device wins over a virtual one
 * (vJoy mirrors it) when it moved too; an axis that only exists on the virtual device is still found.
 */
export function strongestAxisChange(
  baseline: AxisSnapshot,
  pads: readonly PadLike[],
  exclude?: (padId: string, axis: number) => boolean
): AxisChange | null {
  let bestPhysical: AxisChange | null = null;
  let bestAny: AxisChange | null = null;
  for (const pad of pads) {
    const base = baseline.get(pad.id);
    if (!base) continue;
    const virtual = isVirtualPad(pad.id);
    for (let axis = 0; axis < pad.axes.length; axis++) {
      if (exclude?.(pad.id, axis)) continue;
      const value = pad.axes[axis] ?? 0;
      const cand: AxisChange = { padId: pad.id, axis, base: base[axis] ?? 0, value, delta: value - (base[axis] ?? 0) };
      if (!bestAny || Math.abs(cand.delta) > Math.abs(bestAny.delta)) bestAny = cand;
      if (!virtual && (!bestPhysical || Math.abs(cand.delta) > Math.abs(bestPhysical.delta))) bestPhysical = cand;
    }
  }
  if (bestPhysical && bestAny) {
    const moved = Math.abs(bestPhysical.delta);
    if (moved >= 0.1 || moved >= Math.abs(bestAny.delta) * 0.8) return bestPhysical;
  }
  return bestAny;
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
