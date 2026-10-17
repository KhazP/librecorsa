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

export class WheelFfbClient {
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
  update(telemetry: CarTelemetry, wheel: WheelSettings, pads: readonly PadLike[], nowMs: number, driving: boolean): void {
    this.keepConnection(wheel.ffbEnabled, nowMs);
    let force = 0;
    let kerb = 0;
    let abs = 0;
    if (driving && wheel.ffbEnabled) {
      const torque = Number.isFinite(telemetry.ffbTorqueNorm) ? (telemetry.ffbTorqueNorm as number) : 0;
      force = shapeFfbForce(torque, wheel);
      const steerPad = wheel.steer ? findPad(pads, wheel.steer.padId) : undefined;
      if (wheel.steer && steerPad) {
        force += softLockForce(wheelRimAngleDeg(steerPad.axes[wheel.steer.axis] ?? wheel.steer.center, wheel.steer, wheel.rotationDeg));
      }
      if (wheel.ffbInvert) force = -force;
      const fronts = telemetry.wheelSurfaces;
      if (telemetry.speedKmh > 15 && fronts && (fronts[0] === "kerb" || fronts[1] === "kerb")) kerb = wheel.ffbKerb;
      if (telemetry.speedKmh > 5 && telemetry.f12026?.absActive) abs = wheel.ffbAbs;
    }
    this.force = force;
    this.send({ t: "f", f: Math.round(force * 1e4) / 1e4, k: kerb, a: abs });
  }

  /** Zero the wheel now (pause menu opened) instead of waiting for the next frame */
  stop(): void {
    this.force = 0;
    this.send({ t: "f", f: 0, k: 0, a: 0 });
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
