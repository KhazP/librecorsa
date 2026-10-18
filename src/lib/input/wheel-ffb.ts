/**
 * Wheel force feedback through the local bridge.
 *
 * A browser cannot play DirectInput force feedback, so `npm run ffb` runs a small bridge on the PC
 * (scripts/ffb-bridge.ts → FfbHelper.exe) that owns the wheel's constant-force effect, as a native sim does. This
 * client streams one packet per frame over a localhost WebSocket: the shaped rim force (the physics' steering torque
 * with the player's gain, minimum force and the soft lock past the car's steering lock) plus kerb / ABS vibration
 * levels. The helper upsamples to ~333 Hz, synthesises the vibrations, rate-limits, and fades to zero by itself
 * when packets stop (paused tab, closed sim).
 */
import type { CarTelemetry } from "@/types/f1";
import { CAR_WHEEL_LOCK_DEG, findPad, type PadLike, wheelRimAngleDeg, type WheelSettings } from "./device-input";

export const FFB_BRIDGE_PORT = 18500;
const BRIDGE_URL = `ws://127.0.0.1:${FFB_BRIDGE_PORT}`;
const RECONNECT_MS = 5000;
/** Degrees past the car's steering lock over which the soft-lock spring builds to full force */
const SOFT_LOCK_RAMP_DEG = 8;
/** Below this the minimum force eases in, so the rim does not notch across the centre */
const MIN_FORCE_EASE = 0.02;

/** "replaced": another tab took the bridge over; this one stays off it until FFB is switched off and on again */
export type FfbConnection = "off" | "connecting" | "connected" | "unreachable" | "replaced";

export interface FfbStatus {
  connection: FfbConnection;
  /** Wheel the bridge drives, once it reports one */
  device: string | null;
  /** Bridge-side problem (no force-feedback wheel, another program owns it, …) */
  error: string | null;
}

/** Steering torque → rim force (+ = right): gain, then AC-style minimum force */
export function shapeFfbForce(torque: number, wheel: Pick<WheelSettings, "ffbGain" | "ffbMinForce">): number {
  const f = torque * wheel.ffbGain;
  const a = Math.abs(f);
  if (wheel.ffbMinForce <= 0 || a === 0) return f;
  const u = Math.min(1, a / MIN_FORCE_EASE);
  return Math.sign(f) * (wheel.ffbMinForce * u * u * (3 - 2 * u) + (1 - wheel.ffbMinForce) * a);
}

/** Soft-lock spring (+ = right) once the rim turns past the car's steering lock: the end stop a real rack has */
export function softLockForce(rimDeg: number): number {
  const over = Math.abs(rimDeg) - CAR_WHEEL_LOCK_DEG / 2;
  return over > 0 ? -Math.sign(rimDeg) * Math.min(1, over / SOFT_LOCK_RAMP_DEG) : 0;
}

/** The gain and minimum force for a car: its own (set from the meter) or the global ones */
export function ffbStrengthFor(
  wheel: Pick<WheelSettings, "ffbGain" | "ffbMinForce" | "ffbPerCar">,
  vehicle: string | undefined
): Pick<WheelSettings, "ffbGain" | "ffbMinForce"> {
  const own = vehicle ? wheel.ffbPerCar?.[vehicle] : undefined;
  return own ? { ffbGain: own.gain, ffbMinForce: own.minForce } : { ffbGain: wheel.ffbGain, ffbMinForce: wheel.ffbMinForce };
}

/** Rim speed (deg/s) at which the damper reaches its full force */
const DAMPING_FULL_DEG_S = 600;
/** Share of full force the damper may add at most */
const DAMPING_MAX_FORCE = 0.35;
/** Force history for the gain suggestion: about a lap at 60 fps */
const METER_WINDOW = 4800;

export interface FfbMeterState {
  /** Force sent this frame, before the bridge's clip (+ = right) */
  force: number;
  clipping: boolean;
  /** Decaying peak of |force| */
  peak: number;
  /** Gain that would put the 98th-percentile force at 90 % for this car; null when the current gain is fine or no data */
  suggestedGain: number | null;
}

export class WheelFfbClient {
  /** Alternative force output (the WebHID driver); when set and WebHID FFB is on, forces go there instead of the bridge */
  hidSink: ((force: number) => void) | null = null;
  meter: FfbMeterState = { force: 0, clipping: false, peak: 0, suggestedGain: null };
  private lastRimDeg: number | null = null;
  private lastUpdateMs = 0;
  private filtered = 0;
  private history = new Float32Array(METER_WINDOW);
  private historyCount = 0;
  private historyIdx = 0;
  private lastSuggestMs = 0;
  private hidTimeS = 0;

  private ws: WebSocket | null = null;
  private replaced = false;
  private lastAttemptMs = -Infinity;
  private listeners = new Set<() => void>();
  status: FfbStatus = { connection: "off", device: null, error: null };
  /** Force sent this frame (+ = right; |v| > 1 is clipped by the bridge) */
  force = 0;

  /**
   * Every frame, menus included: keeps the bridge connection while FFB is on and sends the force (zero outside the
   * car, so the wheel goes limp in the menus as it does in a native sim).
   */
  update(
    telemetry: CarTelemetry,
    wheelSettings: WheelSettings,
    pads: readonly PadLike[],
    nowMs: number,
    driving: boolean,
    vehicle?: string
  ): void {
    const useHid = wheelSettings.hidFfb && this.hidSink !== null;
    // The bridge also carries telemetry out; with WebHID force feedback it is only needed for that
    this.keepConnection((wheelSettings.ffbEnabled && !useHid) || wheelSettings.telemetryOut, nowMs);
    const wheel: WheelSettings = { ...wheelSettings, ...ffbStrengthFor(wheelSettings, vehicle) };
    const dtS = this.lastUpdateMs > 0 ? Math.min(0.1, Math.max(0, (nowMs - this.lastUpdateMs) / 1000)) : 0;
    this.lastUpdateMs = nowMs;
    let force = 0;
    let kerb = 0;
    let abs = 0;
    let subframes: number[] | undefined;
    if (driving && wheel.ffbEnabled) {
      const torque = Number.isFinite(telemetry.ffbTorqueNorm) ? (telemetry.ffbTorqueNorm as number) : 0;
      const steerPad = wheel.steer ? findPad(pads, wheel.steer.padId) : undefined;
      const rimDeg =
        wheel.steer && steerPad
          ? wheelRimAngleDeg(steerPad.axes[wheel.steer.axis] ?? wheel.steer.center, wheel.steer, wheel.rotationDeg)
          : null;
      const softLock = rimDeg !== null ? softLockForce(rimDeg) : 0;
      // Damper: opposes rim speed (+ = right), so a direct-drive base does not oscillate when released
      let damping = 0;
      if (rimDeg !== null && this.lastRimDeg !== null && dtS > 0 && wheel.ffbDamping > 0) {
        const rimSpeed = (rimDeg - this.lastRimDeg) / dtS;
        damping = -wheel.ffbDamping * DAMPING_MAX_FORCE * Math.max(-1, Math.min(1, rimSpeed / DAMPING_FULL_DEG_S));
      }
      this.lastRimDeg = rimDeg;
      let shaped = shapeFfbForce(torque, wheel);
      // Optional smoothing of the physics torque (the soft lock and damper stay immediate)
      if (wheel.ffbFilterS > 0 && dtS > 0) {
        this.filtered += (shaped - this.filtered) * (1 - Math.exp(-dtS / wheel.ffbFilterS));
        shaped = this.filtered;
      } else {
        this.filtered = shaped;
      }
      this.recordMeter(shaped, wheel.ffbGain, nowMs);
      force = shaped + softLock + damping;
      if (wheel.ffbInvert) force = -force;

      const rawSub = telemetry.ffbSubframeSamples;
      if (rawSub && rawSub.length > 0) {
        subframes = rawSub.map((sample) => {
          let sf = shapeFfbForce(Number.isFinite(sample) ? sample : 0, wheel) + softLock;
          if (wheel.ffbInvert) sf = -sf;
          return Math.round(sf * 1e4) / 1e4;
        });
      }

      const fronts = telemetry.wheelSurfaces;
      if (telemetry.speedKmh > 15 && fronts && (fronts[0] === "kerb" || fronts[1] === "kerb")) kerb = wheel.ffbKerb;
      if (telemetry.speedKmh > 5 && telemetry.f12026?.absActive) abs = wheel.ffbAbs;
    } else {
      this.lastRimDeg = null;
      this.filtered = 0;
    }
    this.force = force;
    this.meter = {
      ...this.meter,
      force,
      clipping: Math.abs(force) > 1,
      peak: Math.max(Math.abs(force), this.meter.peak * Math.exp(-dtS / 1.5)),
    };
    if (useHid) {
      // WebHID has no vibration channel: kerbs and ABS are mixed into the force as a 40 Hz / 25 Hz buzz
      this.hidTimeS += dtS;
      const buzz =
        0.12 * kerb * Math.sin(2 * Math.PI * 40 * this.hidTimeS) +
        0.1 * abs * Math.sign(Math.sin(2 * Math.PI * 25 * this.hidTimeS));
      this.hidSink?.(Math.max(-1, Math.min(1, force + (force !== 0 ? buzz : 0))));
      return;
    }
    this.send(
      subframes && subframes.length > 0
        ? { t: "f", f: Math.round(force * 1e4) / 1e4, k: kerb, a: abs, s: subframes }
        : { t: "f", f: Math.round(force * 1e4) / 1e4, k: kerb, a: abs }
    );
  }

  /** Zero the wheel now (pause menu opened) instead of waiting for the next frame */
  stop(): void {
    this.force = 0;
    this.hidSink?.(0);
    this.send({ t: "f", f: 0, k: 0, a: 0 });
  }

  /** Forwards a telemetry packet to the bridge, which sends it as one UDP datagram to 127.0.0.1:<port> */
  sendTelemetry(port: number, packet: object): void {
    this.send({ t: "tel", port, d: packet });
  }

  /** Forget the force history (car or gain changed) */
  resetMeter(): void {
    this.historyCount = 0;
    this.historyIdx = 0;
    this.meter = { force: 0, clipping: false, peak: 0, suggestedGain: null };
  }

  /** Keeps |force| history and, once a second, works out a gain that uses the wheel's range without clipping */
  private recordMeter(shaped: number, gain: number, nowMs: number): void {
    this.history[this.historyIdx] = Math.abs(shaped);
    this.historyIdx = (this.historyIdx + 1) % METER_WINDOW;
    this.historyCount = Math.min(METER_WINDOW, this.historyCount + 1);
    if (nowMs - this.lastSuggestMs < 1000 || this.historyCount < 600 || gain <= 0) return;
    this.lastSuggestMs = nowMs;
    const sorted = Array.from(this.history.subarray(0, this.historyCount)).sort((a, b) => a - b);
    const p98 = sorted[Math.floor(sorted.length * 0.98)];
    let suggested: number | null = null;
    if (p98 > 0.02 && (p98 > 1 || p98 < 0.55)) {
      suggested = Math.round(Math.min(2, Math.max(0.1, (gain * 0.9) / p98)) * 20) / 20;
      if (Math.abs(suggested - gain) < 0.05) suggested = null;
    }
    this.meter = { ...this.meter, suggestedGain: suggested };
  }

  /**
   * Plays the bridge's direction test: a held pull right, then left (left first when inverted, as the game's forces
   * will be); false when the bridge is not connected
   */
  test(invert: boolean): boolean {
    return this.send({ t: "test", inv: invert });
  }

  /** useSyncExternalStore pair (bound, so they can be passed as they are) */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getStatus = (): FfbStatus => this.status;

  dispose(): void {
    this.keepConnection(false, 0);
  }

  private send(msg: object): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private setStatus(next: FfbStatus) {
    const s = this.status;
    if (s.connection === next.connection && s.device === next.device && s.error === next.error) return;
    this.status = next;
    for (const l of this.listeners) l();
  }

  private keepConnection(on: boolean, nowMs: number) {
    if (!on) {
      if (this.ws) {
        const ws = this.ws;
        this.ws = null;
        ws.close();
      }
      this.lastAttemptMs = -Infinity;
      this.replaced = false;
      this.setStatus({ connection: "off", device: null, error: null });
      return;
    }
    if (this.replaced || this.ws || typeof WebSocket === "undefined" || nowMs - this.lastAttemptMs < RECONNECT_MS) return;
    this.lastAttemptMs = nowMs;
    // Each failed attempt logs a connection error in the console; hence the slow retry, and only while FFB is on
    const ws = new WebSocket(BRIDGE_URL);
    this.ws = ws;
    if (this.status.connection === "off") this.setStatus({ connection: "connecting", device: null, error: null });
    ws.onopen = () => {
      if (this.ws === ws) this.setStatus({ connection: "connected", device: null, error: null });
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws || typeof e.data !== "string") return;
      try {
        const m = JSON.parse(e.data) as { type?: string; ok?: boolean; device?: string | null; error?: string | null };
        if (m.type === "replaced") {
          this.replaced = true;
          this.setStatus({ connection: "replaced", device: null, error: null });
        } else if (m.type === "status") {
          this.setStatus({ connection: "connected", device: m.device ?? null, error: m.ok ? null : (m.error ?? "Wheel not ready") });
        }
      } catch {
        // not ours
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.replaced) this.setStatus({ connection: "unreachable", device: null, error: null });
    };
  }
}

/** One client for the app: the simulator loop streams through it, the wheel setup screen shows its status */
export const wheelFfb = new WheelFfbClient();
