import type { CarTelemetry } from "@/types/f1";
import type { DualSenseSettings } from "@/lib/settings/player-settings";
import { slopeZones, TRIGGER_OFF, type DualSenseOutput, type MicLed, type TriggerEffect } from "@/lib/input/dualsense-protocol";
import { SILENT_HAPTICS, type HapticParams } from "@/lib/input/dualsense-audio-haptics";
import {
  createRumbleCues,
  createRumbleMixState,
  hapticMagnitudes,
  kerbPulseOn,
  layerRumble,
  resetRumbleMixState,
  triggerCues,
} from "./gamepad-haptics";
import { revRangeFor } from "./rev-range";

/**
 * What the DualSense says about the car, frame by frame: the adaptive triggers, the rumble emulation, the HD haptics
 * (USB) and the lights. The cues are the ones the Gamepad API rumble uses (gamepad-haptics.ts); here each goes where
 * the DualSense can say it best.
 *
 * L2 is the brake pedal: a resistance that firms up through the travel, replaced by a vibration while ABS works or a
 * wheel locks, and by a light buzz as the tyres near their limit with ABS off. R2 is the throttle: a light resistance,
 * a buzz while the rears spin or traction control cuts, and a faint one nearing the limit with traction control off.
 * The HD haptics play each cue on the side it happens (left wheels in the left grip). The lightbar follows the revs
 * and the player LEDs are rev lights; the mic LED shows the overtake boost.
 */

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const level8 = (v: number) => Math.min(8, Math.max(1, Math.round(v)));

/** Trigger vibration rates (Hz): ABS pulsing, a locked wheel's judder, traction control cutting, wheelspin, the limit */
const ABS_TRIGGER_HZ = 20;
const LOCK_TRIGGER_HZ = 12;
const TC_TRIGGER_HZ = 18;
const SPIN_TRIGGER_HZ = 35;
const LIMIT_TRIGGER_HZ = 40;
/** Shift-light blink rate on the lightbar and LEDs past the shift point (ms per half period) */
const BLINK_MS = 125;
/** A trigger vibration is held this long (s) after its cue drops, so a cue flickering for a frame does not flip modes */
const TRIGGER_HOLD_S = 0.15;
/**
 * Share of the kerb pulse also sent to the low motor. The pad's rumble emulation is light on the high motor alone, so
 * kerbs there were easy to miss
 */
const KERB_LOW_MOTOR = 0.6;
/** Player 1's LED (the middle one), shown out of the car */
const IDLE_PLAYER_LEDS = 0b00100;

export interface DualSenseFrameInput {
  telemetry: CarTelemetry;
  dtS: number;
  /** In the car with the session running (not paused, not in the menus) */
  driving: boolean;
  /** The pad rumble switch: rumble and HD haptics */
  rumbleOn: boolean;
  settings: DualSenseSettings;
  /** Trigger limit buzz even with ABS / traction control on */
  triggerSlipAlwaysOn: boolean;
  /** The driver colour (#RRGGBB) */
  driverColor: string;
  /** The HD haptics synth is playing: the rumble emulation stays off so it does not take the actuators over */
  hdHaptics: boolean;
  /** The vehicle model, for the rev-light range when the telemetry names no car */
  vehicle?: string;
}

export interface DualSenseFrame {
  output: DualSenseOutput;
  haptics: HapticParams;
  /** A gear change this frame: a short knock in the HD haptics */
  shift: boolean;
}

export function hexColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [225, 6, 0];
  const v = parseInt(m[1] as string, 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Lightbar colour for the revs: green, through yellow to red across the rev-light range, blinking blue at the shift */
export function revLightbar(rpm: number, range: readonly [number, number], nowMs: number): [number, number, number] {
  const [lo, hi] = range;
  if (!Number.isFinite(rpm) || !(hi > lo)) return [0, 40, 10];
  if (rpm >= hi) return Math.floor(nowMs / BLINK_MS) % 2 === 0 ? [0, 60, 255] : [0, 0, 0];
  const f = (rpm - lo) / (hi - lo);
  if (f < 0) return [0, 40 + Math.round(60 * clamp01(rpm / lo)), 10];
  // Green → yellow over the first half, yellow → red over the second
  return f < 0.5 ? [Math.round(510 * f), 220, 0] : [255, Math.round(220 * (1 - (f - 0.5) * 2)), 0];
}

/** Five rev lights filling left to right across the range, all blinking past the shift point */
export function revPlayerLeds(rpm: number, range: readonly [number, number], nowMs: number): number {
  const [lo, hi] = range;
  if (!Number.isFinite(rpm) || rpm < lo || !(hi > lo)) return 0;
  if (rpm >= hi) return Math.floor(nowMs / BLINK_MS) % 2 === 0 ? 0b11111 : 0;
  const lit = Math.min(5, 1 + Math.floor(((rpm - lo) / (hi - lo)) * 5));
  return (1 << lit) - 1;
}

/** Brake trigger (L2) */
export function brakeTriggerEffect(
  t: CarTelemetry,
  strength: number,
  cues: ReturnType<typeof triggerCues>
): TriggerEffect {
  const s = clamp01(strength);
  if (s <= 0) return TRIGGER_OFF;
  if (cues.locking) {
    const amplitude = level8(2 + 6 * s * (0.4 + 0.6 * cues.lockScale));
    return { mode: "vibration", position: 1, amplitude, frequencyHz: cues.absActive ? ABS_TRIGGER_HZ : LOCK_TRIGGER_HZ };
  }
  if (cues.brakeLimit > 0) {
    return { mode: "vibration", position: 1, amplitude: level8(1 + 3 * s * (cues.brakeLimit / 0.4)), frequencyHz: LIMIT_TRIGGER_HZ };
  }
  // A pedal that firms up: free over the first tenth, then a ramp to its stiffest from about 70 % travel
  return { mode: "zones", strengths: slopeZones(1, 7, 1 + 2 * s, 2 + 6 * s) };
}

/** Throttle trigger (R2) */
export function throttleTriggerEffect(
  t: CarTelemetry,
  strength: number,
  cues: ReturnType<typeof triggerCues>
): TriggerEffect {
  const s = clamp01(strength);
  if (s <= 0) return TRIGGER_OFF;
  if (cues.spinning) {
    const amplitude = level8(1 + 7 * s * (0.3 + 0.7 * cues.spinScale));
    return { mode: "vibration", position: 1, amplitude, frequencyHz: cues.tcActive ? TC_TRIGGER_HZ : SPIN_TRIGGER_HZ };
  }
  if (cues.throttleLimit > 0) {
    return { mode: "vibration", position: 1, amplitude: level8(1 + 2 * s * (cues.throttleLimit / 0.4)), frequencyHz: LIMIT_TRIGGER_HZ };
  }
  // Light: free over the first 30 % of travel, then the faintest resistance, a touch more near the end
  return { mode: "zones", strengths: slopeZones(3, 9, 1, 1 + 2 * s) };
}

const leftKerb = (t: CarTelemetry) => t.onKerbLeft || t.wheelSurfaces?.[0] === "kerb" || t.wheelSurfaces?.[2] === "kerb";
const rightKerb = (t: CarTelemetry) => t.onKerbRight || t.wheelSurfaces?.[1] === "kerb" || t.wheelSurfaces?.[3] === "kerb";

export class DualSenseFeedback {
  private timeS = 0;
  private readonly mix = createRumbleMixState();
  private readonly cues = createRumbleCues();
  private lastGear = NaN;
  private readonly held = { left: { effect: null as TriggerEffect | null, untilS: 0 }, right: { effect: null as TriggerEffect | null, untilS: 0 } };

  reset(): void {
    resetRumbleMixState(this.mix);
    this.lastGear = NaN;
    this.held.left.effect = null;
    this.held.right.effect = null;
  }

  /** A vibration goes out at once and outlasts its cue by {@link TRIGGER_HOLD_S}; a resistance waits for it */
  private hold(side: "left" | "right", effect: TriggerEffect): TriggerEffect {
    const h = this.held[side];
    if (effect.mode === "vibration") {
      h.effect = effect;
      h.untilS = this.timeS + TRIGGER_HOLD_S;
      return effect;
    }
    if (h.effect && this.timeS < h.untilS) return h.effect;
    h.effect = null;
    return effect;
  }

  frame(input: DualSenseFrameInput): DualSenseFrame {
    const { telemetry: t, settings } = input;
    this.timeS += Math.max(0, input.dtS);
    const nowMs = this.timeS * 1000;
    const driverRgb = hexColor(input.driverColor);
    const idleLightbar = settings.lightbar === "off" ? ([0, 0, 0] as const) : driverRgb;

    if (!input.driving) {
      this.reset();
      return {
        output: {
          rumble: input.hdHaptics ? null : { low: 0, high: 0 },
          leftTrigger: TRIGGER_OFF,
          rightTrigger: TRIGGER_OFF,
          lightbar: idleLightbar,
          playerLeds: settings.revLeds ? IDLE_PLAYER_LEDS : 0,
          micLed: "off",
        },
        haptics: SILENT_HAPTICS,
        shift: false,
      };
    }

    const range = revRangeFor(t.f12026?.carId ?? input.vehicle);
    const { weak, strong } = hapticMagnitudes(t, this.timeS, this.mix, this.cues);
    const tc = triggerCues(t, { triggerSlipAlwaysOn: input.triggerSlipAlwaysOn });

    const rumbleGain = input.rumbleOn ? settings.rumbleStrength : 0;
    const kerbHit = this.cues.kerb > 0 && kerbPulseOn(this.timeS) ? this.cues.kerb : 0;
    const low = layerRumble(strong, KERB_LOW_MOTOR * kerbHit);
    const rumble = input.hdHaptics ? null : { low: clamp01(low * rumbleGain), high: clamp01(weak * rumbleGain) };

    const triggers = settings.adaptiveTriggers;
    const leftTrigger = triggers ? this.hold("left", brakeTriggerEffect(t, settings.triggerStrength, tc)) : TRIGGER_OFF;
    const rightTrigger = triggers ? this.hold("right", throttleTriggerEffect(t, settings.triggerStrength, tc)) : TRIGGER_OFF;

    const lightbar =
      settings.lightbar === "revs" ? revLightbar(t.rpm, range, nowMs) : settings.lightbar === "driver" ? driverRgb : ([0, 0, 0] as const);
    const playerLeds = settings.revLeds ? revPlayerLeds(t.rpm, range, nowMs) : 0;
    const micLed: MicLed = t.manualOverrideActive ? "on" : t.overtakeAvailable ? "pulse" : "off";

    const gear = t.gear;
    const shift = Number.isFinite(this.lastGear) && gear !== this.lastGear && t.speedKmh > 2;
    this.lastGear = gear;

    let haptics = SILENT_HAPTICS;
    if (input.hdHaptics && input.rumbleOn) {
      const c = this.cues;
      const slip = t.wheelSlipRatios;
      const lockAt = (i: number) => (t.speedKmh > 30 ? 0.8 * smoothstep(0.12, 0.45, -(slip[i] ?? 0)) : 0);
      const spinAt = (i: number) => 0.6 * smoothstep(0.12, 0.5, slip[i] ?? 0);
      const rough = c.roughWheels;
      const speedMs = Math.max(0, t.speedKmh / 3.6);
      const engineOn = t.rpm > 500 ? 1 : 0;
      haptics = {
        gain: settings.hapticStrength,
        kerbL: leftKerb(t) ? c.kerb : 0,
        kerbR: rightKerb(t) ? c.kerb : 0,
        kerbHz: Math.min(40, Math.max(5, speedMs / 1.4)),
        roughL: clamp01(((rough[0] + rough[2]) / 2) * 1.5 + c.texture * 0.6),
        roughR: clamp01(((rough[1] + rough[3]) / 2) * 1.5 + c.texture * 0.6),
        lockL: lockAt(0),
        lockR: lockAt(1),
        spinL: spinAt(2),
        spinR: spinAt(3),
        scrub: c.scrub,
        slide: c.rearSlide,
        impact: c.impact,
        engine: engineOn * settings.engineHaptics * (0.05 + 0.12 * clamp01(t.throttle)),
        engineHz: Math.min(160, Math.max(20, t.rpm / 80)),
      };
    }

    return { output: { rumble, leftTrigger, rightTrigger, lightbar, playerLeds, micLed }, haptics, shift: shift && input.hdHaptics && input.rumbleOn };
  }
}
