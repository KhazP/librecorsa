/**
 * Wheel force feedback through the local bridge.
 *
 * A browser cannot play DirectInput force feedback, so `npm run ffb` runs a small bridge on the PC
 * (scripts/ffb-bridge.ts → FfbHelper.exe) that owns the wheel's constant-force effect, as a native sim does. This
 * client streams one packet per frame over a localhost WebSocket: the shaped rim force (the physics' steering torque
 * with the player's gain, minimum force and the soft lock past the car's steering lock), the frame's 500 Hz physics
 * samples, plus kerb / ABS vibration levels. The helper plays the samples out at 500 Hz, synthesises the vibrations,
 * rate-limits, and fades to zero by itself when packets stop (paused tab, closed sim).
 *
 * In-browser WebHID force feedback does the same here: each frame's samples are played out to the wheel over the next
 * frame on a 2 ms timer (as fast as the browser's timers and the wheel's writes allow), with the vibrations
 * synthesised on that clock rather than at the frame rate.
 */
import type { CarTelemetry } from "@/types/f1";
import { CAR_WHEEL_LOCK_DEG, carWheelLockDeg, findPad, type PadLike, wheelRimAngleDeg, type WheelSettings } from "./device-input";
import { WebHidFfb } from "./webhid-ffb";

export const FFB_BRIDGE_PORT = 18500;
const BRIDGE_URL = `ws://127.0.0.1:${FFB_BRIDGE_PORT}`;
const RECONNECT_MS = 5000;
/** Degrees past the car's steering lock over which the soft-lock spring builds to full force */
const SOFT_LOCK_RAMP_DEG = 12;
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

/**
 * Steering torque → rim force (+ = right): gain, then minimum force.
 * When `speedKmh` is provided (live driving), minimum force is gated off at standstill (≤ 1 km/h) and ramps in up to
 * 6 km/h (`clamp((speedKmh - 1) * 0.2, 0, 1)`) so a parked direct-drive wheel never jumps or oscillates at rest.
 */
export function shapeFfbForce(
  torque: number,
  wheel: Pick<WheelSettings, "ffbGain" | "ffbMinForce">,
  speedKmh?: number
): number {
  const f = torque * wheel.ffbGain;
  const a = Math.abs(f);
  const speedGate =
    speedKmh !== undefined && Number.isFinite(speedKmh) ? Math.max(0, Math.min(1, (speedKmh - 1.0) * 0.2)) : 1;
  const minForce = wheel.ffbMinForce * speedGate;
  if (minForce <= 0 || a === 0) return f;
  const u = Math.min(1, a / MIN_FORCE_EASE);
  return Math.sign(f) * (minForce * u * u * (3 - 2 * u) + (1 - minForce) * a);
}

/** Soft-lock spring (+ = right) once the rim turns past the car's steering lock: the end stop a real rack has */
export function softLockForce(rimDeg: number, carLockDeg: number = CAR_WHEEL_LOCK_DEG): number {
  const lock = carLockDeg > 0 ? carLockDeg : CAR_WHEEL_LOCK_DEG;
  const over = Math.abs(rimDeg) - lock / 2;
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

/** Direction test, as the bridge helper plays it: a held pull each way (s, s between, share of full force) */
const TEST_PULL_S = 1.0;
const TEST_GAP_S = 0.3;
const TEST_LEVEL = 0.25;
export const DIRECTION_TEST_S = 2 * TEST_PULL_S + TEST_GAP_S;
const smoothStep = (e0: number, e1: number, x: number) => {
  const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return u * u * (3 - 2 * u);
};
const pull = (x: number) => smoothStep(0, 0.2, x) * (1 - smoothStep(0.8, 1, x));

/**
 * Direction-test force (+ = right) `tS` seconds in: right then left, the other way round when inverted (as the game's
 * forces will be). Zero before the start and once {@link DIRECTION_TEST_S} has passed.
 */
export function directionTestForce(tS: number, invert: boolean): number {
  const sign = invert ? -1 : 1;
  const second = TEST_PULL_S + TEST_GAP_S;
  if (tS < 0 || tS >= DIRECTION_TEST_S) return 0;
  if (tS < TEST_PULL_S) return sign * TEST_LEVEL * pull(tS / TEST_PULL_S);
  if (tS < second) return 0;
  return -sign * TEST_LEVEL * pull((tS - second) / TEST_PULL_S);
}
const TEST_STEP_MS = 10;
/** If WebHID frame updates stop arriving (hidden tab, stalled loop), zero the wheel's constant-force effect after 150 ms */
export const HID_WATCHDOG_MS = 150;
/** WebHID playback timer (ms); the physics samples it plays are 2 ms apart */
const HID_TICK_MS = 2;
const PHYSICS_SAMPLE_MS = 2;
/** Vibrations mixed into the WebHID force (no separate channel): kerb buzz, ABS pulse and grass rumble, Hz and share of full force */
const HID_KERB_HZ = 40;
const HID_KERB_AMPLITUDE = 0.12;
const HID_ABS_HZ = 25;
const HID_ABS_AMPLITUDE = 0.1;
const HID_ROUGH_HZ = 18;
const HID_ROUGH_AMPLITUDE = 0.12;
const clockMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Rim speed (deg/s) at which the damper reaches its full force */
const DAMPING_FULL_DEG_S = 600;
/** Share of full force the damper may add at most */
const DAMPING_MAX_FORCE = 0.35;
/** Force history for the gain suggestion: about a lap at 60 fps */
const METER_WINDOW = 4800;
/** Histogram bins for the meter's percentile: 0.01 wide, the last one catching everything from 2 up */
const METER_BINS = 201;

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
  /** Linked WebHID driver (for hardware damper forwarding) */
  hidDriver: WebHidFfb | null = null;
  meter: FfbMeterState = { force: 0, clipping: false, peak: 0, suggestedGain: null };
  private lastRimDeg: number | null = null;
  private lastUpdateMs = 0;
  private filtered = 0;
  private history = new Float32Array(METER_WINDOW);
  private meterBins = new Uint32Array(METER_BINS);
  private historyCount = 0;
  private historyIdx = 0;
  private lastSuggestMs = 0;
  /** WebHID playback: the frame's samples still to play, the force held once they run out, vibration levels */
  private hidQueue: number[] = [];
  private hidHold = 0;
  private hidActiveDriving = false;
  private hidKerb = 0;
  private hidAbs = 0;
  private hidRough = 0;
  private hidNoise = 0;
  private hidPlayer: ReturnType<typeof setInterval> | null = null;
  /** Clock (ms) of the last played sample slot and of the last frame update */
  private hidSlotMs = 0;
  private hidPushMs = 0;
  /** WebHID direction test in progress: it owns the force until it ends */
  private hidTest: { timer: ReturnType<typeof setInterval> } | null = null;

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
    const activeHid = this.hidDriver;
    const hwDamper = useHid && activeHid !== null && activeHid.hasHardwareDamper();
    let force = 0;
    let kerb = 0;
    let abs = 0;
    let rough = 0;
    let subframes: number[] | undefined;
    if (driving && wheel.ffbEnabled) {
      const torque = Number.isFinite(telemetry.ffbTorqueNorm) ? (telemetry.ffbTorqueNorm as number) : 0;
      const speedKmh = Number.isFinite(telemetry.speedKmh) ? telemetry.speedKmh : 0;
      const gyroFactor = Math.max(0, Math.min(1, (speedKmh - 10) / 180));
      if (hwDamper) {
        activeHid.setDamper(wheel.ffbDamping * (0.4 + 0.6 * gyroFactor));
      }
      const steerPad = wheel.steer ? findPad(pads, wheel.steer.padId) : undefined;
      const rimDeg =
        wheel.steer && steerPad
          ? wheelRimAngleDeg(steerPad.axes[wheel.steer.axis] ?? wheel.steer.center, wheel.steer, wheel.rotationDeg)
          : null;
      const carLockDeg = carWheelLockDeg(vehicle, wheel.steerLockPerCar);
      const softLock = rimDeg !== null ? softLockForce(rimDeg, carLockDeg) : 0;
      // Damper: static wheel damper + speed-scaled gyroscopic self-aligning damper + cushioned soft-lock stop damper
      let damping = 0;
      if (rimDeg !== null && this.lastRimDeg !== null && dtS > 0) {
        const rimSpeed = (rimDeg - this.lastRimDeg) / dtS;
        const rawBaseDamp =
          wheel.ffbDamping > 0
            ? wheel.ffbDamping * DAMPING_MAX_FORCE + 0.12 * gyroFactor * Math.min(1, wheel.ffbDamping * 1.5)
            : 0;
        // With the wheel's own damper on, the damper worked out here from the frame-rate rim angle keeps 30 %
        const baseDamp = hwDamper ? rawBaseDamp * 0.3 : rawBaseDamp;
        // Inside the soft-lock zone, damp motion pushing deeper into the stop so the rim never bounces off lock
        const inSoftLock = Math.abs(rimDeg) > carLockDeg / 2 && rimSpeed * rimDeg > 0;
        const lockDamp = inSoftLock ? 0.45 : 0;
        damping = -(baseDamp + lockDamp) * Math.max(-1, Math.min(1, rimSpeed / DAMPING_FULL_DEG_S));
      }
      this.lastRimDeg = rimDeg;
      // Optional smoothing of the physics torque (the soft lock and damper stay immediate). It has to run over the
      // 500 Hz subframes too, since those (not `force`) are what the wheel plays whenever the physics supplies them
      const filterS = wheel.ffbFilterS > 0 && dtS > 0 ? wheel.ffbFilterS : 0;
      const smooth = (x: number, h: number): number => {
        if (filterS > 0) this.filtered += (x - this.filtered) * (1 - Math.exp(-h / filterS));
        else this.filtered = x;
        return this.filtered;
      };
      const rawSub = telemetry.ffbSubframeSamples;
      let shaped: number;
      if (rawSub && rawSub.length > 0) {
        const h = dtS / rawSub.length;
        subframes = rawSub.map((sample) => {
          let sf = smooth(shapeFfbForce(Number.isFinite(sample) ? sample : 0, wheel, telemetry.speedKmh), h) + softLock + damping;
          if (wheel.ffbInvert) sf = -sf;
          return Math.round(sf * 1e4) / 1e4;
        });
        // The held value once the subframes run out: the filtered end of this frame (unfiltered, the frame's torque)
        shaped = filterS > 0 ? this.filtered : smooth(shapeFfbForce(torque, wheel, telemetry.speedKmh), dtS);
      } else {
        shaped = smooth(shapeFfbForce(torque, wheel, telemetry.speedKmh), dtS);
      }
      this.recordMeter(shaped, wheel.ffbGain, nowMs);
      force = shaped + softLock + damping;
      if (wheel.ffbInvert) force = -force;

      const fronts = telemetry.wheelSurfaces;
      if (speedKmh > 15 && fronts && (fronts[0] === "kerb" || fronts[1] === "kerb")) kerb = wheel.ffbKerb;
      if (speedKmh > 5 && telemetry.f12026?.absActive) abs = wheel.ffbAbs;
      // Off the track the grass shakes the rim, as the surface effects level sets for the kerbs
      if (speedKmh > 10 && fronts && (fronts[0] === "grass" || fronts[1] === "grass")) {
        rough = Math.min(1, (speedKmh - 10) / 80) * wheel.ffbKerb;
      }
    } else {
      if (hwDamper) activeHid.setDamper(0);
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
      if (this.hidTest) return;
      this.hidPlay(subframes, force, driving && wheel.ffbEnabled, kerb, abs, rough);
      return;
    }
    this.hidStopPlayer();
    this.send(
      subframes && subframes.length > 0
        ? { t: "f", f: Math.round(force * 1e4) / 1e4, k: kerb, a: abs, s: subframes }
        : { t: "f", f: Math.round(force * 1e4) / 1e4, k: kerb, a: abs }
    );
  }

  /**
   * WebHID: queues this frame's 500 Hz samples (or just its force) and plays the first at once; the timer plays the
   * rest over the next frame, one per 2 ms slot, as the bridge helper does
   */
  private hidPlay(
    samples: number[] | undefined,
    force: number,
    activeDriving: boolean,
    kerb: number,
    abs: number,
    rough: number
  ): void {
    const now = clockMs();
    this.hidQueue = samples && samples.length > 0 ? samples.slice() : [];
    this.hidHold = this.hidQueue.length > 0 ? this.hidQueue[this.hidQueue.length - 1] : force;
    this.hidActiveDriving = activeDriving;
    this.hidKerb = kerb;
    this.hidAbs = abs;
    this.hidRough = rough;
    this.hidPushMs = now;
    this.hidSlotMs = now;
    this.hidEmit(now, 1);
    const hasBuzz = kerb > 0 || abs > 0 || rough > 0;
    const active = activeDriving && (this.force !== 0 || this.hidQueue.length > 0 || hasBuzz);
    if (active && this.hidPlayer === null) {
      const timer = setInterval(() => this.hidTick(), HID_TICK_MS);
      (timer as { unref?: () => void }).unref?.();
      this.hidPlayer = timer;
    } else if (!active) {
      this.hidStopPlayer();
    }
  }

  /** Timer: plays the samples due since the last tick (the latest of them), or zeroes the wheel once frames stop */
  private hidTick(): void {
    const now = clockMs();
    if (now - this.hidPushMs > HID_WATCHDOG_MS) {
      // Frame updates stopped (hidden tab, stalled loop): let go of the wheel
      this.hidStopPlayer();
      this.force = 0;
      this.hidSink?.(0);
      return;
    }
    const slots = Math.floor((now - this.hidSlotMs) / PHYSICS_SAMPLE_MS);
    if (slots < 1) return;
    this.hidSlotMs += slots * PHYSICS_SAMPLE_MS;
    this.hidEmit(now, slots);
  }

  /** Advances `slots` samples and sends the force with the vibrations, synthesised on the real clock */
  private hidEmit(nowMs: number, slots: number): void {
    let f = this.hidHold;
    if (this.hidQueue.length > 0) {
      const take = Math.min(slots, this.hidQueue.length);
      f = this.hidQueue[take - 1];
      this.hidQueue.splice(0, take);
    }
    const t = nowMs / 1000;
    if (this.hidRough > 0) {
      this.hidNoise += (Math.random() * 2 - 1 - this.hidNoise) * 0.18;
    } else {
      this.hidNoise = 0;
    }
    const buzz =
      HID_KERB_AMPLITUDE * this.hidKerb * Math.sin(2 * Math.PI * HID_KERB_HZ * t) +
      HID_ABS_AMPLITUDE * this.hidAbs * Math.sign(Math.sin(2 * Math.PI * HID_ABS_HZ * t)) +
      HID_ROUGH_AMPLITUDE * this.hidRough * (0.65 * Math.sin(2 * Math.PI * HID_ROUGH_HZ * t) + 0.35 * this.hidNoise);
    this.hidSink?.(Math.max(-1, Math.min(1, f + (this.hidActiveDriving ? buzz : 0))));
  }

  private hidStopPlayer(): void {
    if (this.hidPlayer !== null) {
      clearInterval(this.hidPlayer);
      this.hidPlayer = null;
    }
    this.hidQueue = [];
    this.hidActiveDriving = false;
  }

  /** Zero the wheel now (pause menu opened, hidden tab, blurred window) instead of waiting for the next frame */
  stop(): void {
    this.cancelHidTest();
    this.hidStopPlayer();
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
    // 98th percentile of |force| from a histogram (0.01 bins up to 2): no copy and sort of the 4800-sample window
    const bins = this.meterBins.fill(0);
    for (let i = 0; i < this.historyCount; i++) bins[Math.min(METER_BINS - 1, Math.floor(this.history[i] * 100))]++;
    const rank = Math.floor(this.historyCount * 0.98);
    let seen = 0;
    let bin = 0;
    while (bin < METER_BINS - 1 && seen + bins[bin] <= rank) seen += bins[bin++];
    const p98 = (bin + 0.5) / 100;
    let suggested: number | null = null;
    if (p98 > 0.02 && (p98 > 1 || p98 < 0.55)) {
      suggested = Math.round(Math.min(2, Math.max(0.1, (gain * 0.9) / p98)) * 20) / 20;
      if (Math.abs(suggested - gain) < 0.05) suggested = null;
    }
    this.meter = { ...this.meter, suggestedGain: suggested };
  }

  /**
   * Plays the direction test: a held pull right, then left (left first when inverted, as the game's forces will be).
   * Through the WebHID wheel while it is the force output, otherwise the bridge's; false when neither is connected.
   */
  test(invert: boolean): boolean {
    if (!this.hidSink) return this.send({ t: "test", inv: invert });
    this.cancelHidTest();
    this.hidStopPlayer();
    const start = Date.now();
    const timer = setInterval(() => {
      const tS = (Date.now() - start) / 1000;
      if (tS >= DIRECTION_TEST_S || !this.hidSink) {
        this.cancelHidTest();
        return;
      }
      this.hidSink(directionTestForce(tS, invert));
    }, TEST_STEP_MS);
    this.hidTest = { timer };
    this.hidSink(directionTestForce(0, invert));
    return true;
  }

  private cancelHidTest(): void {
    if (!this.hidTest) return;
    clearInterval(this.hidTest.timer);
    this.hidTest = null;
    this.hidSink?.(0);
  }

  /** useSyncExternalStore pair (bound, so they can be passed as they are) */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getStatus = (): FfbStatus => this.status;

  dispose(): void {
    this.stop();
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

/**
 * The app's WebHID driver. Pairing (connect) runs from the wheel setup's click; on load the simulator only reopens a
 * wheel granted before (reconnect). While it is ready it is wheelFfb's force output; any other state hands the force
 * back to the bridge.
 */
export const webHidFfb = new WebHidFfb();
linkHidSink(wheelFfb, webHidFfb);

/**
 * Keeps `client.hidSink` pointing at `hid` exactly while it is ready; returns the unsubscribe. The client's forces are
 * + = right, a PID magnitude along +X is + = left (the direction a force comes from), so the sign flips here.
 */
export function linkHidSink(client: WheelFfbClient, hid: WebHidFfb): () => void {
  const sync = () => {
    const ready = hid.status.state === "ready";
    client.hidDriver = ready ? hid : null;
    client.hidSink = ready ? (f) => hid.setForce(-f) : null;
  };
  sync();
  return hid.subscribe(sync);
}
