"use client";

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PAD_ACTIONS, type PadAction } from "@/lib/input/bindings";
import {
  autoConfigureWheel,
  CAR_WHEEL_LOCKS_DEG,
  connectedPads,
  emptyWheelButtons,
  findPad,
  isLikelyWheel,
  padDisplayName,
  pedalValue,
  snapshotAxes,
  STEER_LOCK_MIN_DEG,
  strongestAxisChange,
  WHEEL_ROTATION_PRESETS,
  WHEEL_TYPE_DEFAULTS,
  wheelSteerValue,
  type AxisBinding,
  type AxisSnapshot,
  type ButtonBinding,
  type PedalBinding,
  type WheelSettings,
  type WheelType,
} from "@/lib/input/device-input";
import { type FfbStatus, webHidFfb, wheelFfb } from "@/lib/input/wheel-ffb";
import { isFatalHidStatus, type WebHidFfbStatus } from "@/lib/input/webhid-ffb";
import { SUPPORT_LABEL, type SupportLevel, WHEEL_SUPPORT, WHEEL_SUPPORT_SUMMARY } from "@/lib/input/wheel-support";
import { DEFAULT_PLAYER_SETTINGS } from "@/lib/settings/player-settings";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button, Segmented, SettingRow, Slider, useSettingsDetail } from "@/components/ui";
import { useSettingsEnv, type SettingsEnv } from "@/components/settings/env";
import { choice, pct, SettingField, SettingsCard, slider, toggle, wheel, type RowDef } from "@/components/settings/fields";
import {
  collisionGuard,
  ffbEffects,
  ffbFineTuning,
  ffbFriction,
  ffbInertia,
  ffbOn,
  ffbStrength,
  revLights,
  wheelBrakeCurve,
  wheelSteerFilters,
} from "@/components/settings/defs";
import { padPressTracker, suspendMenuNav, useGamepads, type PadState } from "../useMenuNav";
import { CAPTURE_TIMEOUT_S, useButtonCapture } from "./button-capture";
import { Hint, StatusPill, TrackMeter } from "./setup-ui";

type CalTarget = "steer" | "throttle" | "brake";

const STEER_DETECT = 0.12;
const PEDAL_DETECT = 0.2;

const PROMPTS: Record<CalTarget, { rest: string; act: string }> = {
  steer: { rest: "Hold the wheel straight ahead, then press Continue.", act: "Now turn the wheel about 90° to the left and hold it." },
  throttle: { rest: "Take your foot off the throttle, then press Continue.", act: "Press the throttle all the way down, then let it go." },
  brake: { rest: "Take your foot off the brake, then press Continue.", act: "Press the brake all the way down, then let it go." },
};

/**
 * Guided axis detection: a resting snapshot, then the axis that moves furthest. Steering records the
 * centre and direction; pedals record released and fully-pressed values (so inverted and combined-axis
 * pedals just work).
 */
const AxisCalibrator: React.FC<{
  target: CalTarget;
  exclude: { padId: string; axis: number }[];
  onSteer: (b: AxisBinding) => void;
  onPedal: (target: "throttle" | "brake", b: PedalBinding) => void;
  onCancel: () => void;
}> = ({ target, exclude, onSteer, onPedal, onCancel }) => {
  // rest: waiting for Continue · act: watching for the axis that moves · locked: a pedal's axis found, followed to its
  // peak (Save offered). The locked axis itself stays in a ref: the frame loop updates its peak every frame.
  const [stage, setStage] = useState<"rest" | "act" | "locked">("rest");
  const [meter, setMeter] = useState(0);
  const baseline = useRef<AxisSnapshot | null>(null);
  const locked = useRef<{ padId: string; axis: number; base: number; peak: number } | null>(null);
  // Reports once: a frame can still run after the result, before this calibrator unmounts
  const reported = useRef(false);
  const heldSince = useRef(0);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const measuring = stage !== "rest";

  useEffect(() => {
    if (!measuring) return;
    // The wheel and pedals are moving: neither they nor a pad may drive the menus meanwhile (a stick or LB / RB would
    // move the focus or change the tab, ending this). Esc and a controller's B still cancel.
    const resume = suspendMenuNav();
    const backPressed = padPressTracker([1]);
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onCancelRef.current();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    let raf = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const pads = connectedPads();
      if (backPressed(pads.filter((p) => p.mapping === "standard")) && !reported.current) {
        onCancelRef.current();
        return;
      }
      const base = baseline.current;
      if (!base || reported.current) return;
      const excluded = (padId: string, axis: number) => exclude.some((e) => e.padId === padId && e.axis === axis);

      if (target === "steer") {
        const best = strongestAxisChange(base, pads, excluded);
        if (!best) return;
        setMeter(Math.min(1, Math.abs(best.delta) / STEER_DETECT));
        if (Math.abs(best.delta) < STEER_DETECT) {
          heldSince.current = 0;
          return;
        }
        if (!heldSince.current) heldSince.current = t;
        if (t - heldSince.current > 250) {
          reported.current = true;
          onSteer({ padId: best.padId, axis: best.axis, center: best.base, invert: best.delta > 0 });
        }
        return;
      }

      // Pedals: lock onto the first axis that clearly moves, follow it to its peak and back
      if (!locked.current) {
        const found = strongestAxisChange(base, pads, excluded);
        if (found && Math.abs(found.delta) > PEDAL_DETECT) {
          locked.current = { padId: found.padId, axis: found.axis, base: found.base, peak: found.value };
          setStage("locked");
        }
        setMeter(found ? Math.min(1, Math.abs(found.delta) / 1.2) : 0);
        return;
      }
      const l = locked.current;
      const value = findPad(pads, l.padId)?.axes[l.axis] ?? l.base;
      if (Math.abs(value - l.base) > Math.abs(l.peak - l.base)) l.peak = value;
      const peakDelta = Math.abs(l.peak - l.base);
      setMeter(Math.min(1, Math.abs(value - l.base) / Math.max(0.35, peakDelta)));
      if (peakDelta > 0.25 && Math.abs(value - l.base) < peakDelta * 0.25) {
        reported.current = true;
        onPedal(target, { padId: l.padId, axis: l.axis, idle: l.base, full: l.peak });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, { capture: true });
      resume();
    };
  }, [measuring, target, exclude, onSteer, onPedal]);

  return (
    <div role="status" className="flex flex-col gap-2.5 rounded-lc-row border border-lc-info/50 bg-lc-info/8 p-3.5">
      <p className="lc-row-label m-0">{stage === "rest" ? PROMPTS[target].rest : PROMPTS[target].act}</p>
      {measuring ? (
        <span className="block h-1.5 overflow-hidden rounded-full bg-lc-void">
          <span className="block h-full origin-left rounded-full bg-lc-info" style={{ transform: `scaleX(${meter})` }} />
        </span>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {stage === "rest" ? (
          <Button
            size="sm"
            variant="primary"
            data-nav-default=""
            onClick={() => {
              baseline.current = snapshotAxes(connectedPads());
              locked.current = null;
              heldSince.current = 0;
              setStage("act");
            }}
          >
            Continue
          </Button>
        ) : stage === "locked" && target !== "steer" ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              const l = locked.current;
              if (!l || reported.current) return;
              reported.current = true;
              onPedal(target, { padId: l.padId, axis: l.axis, idle: l.base, full: l.peak });
            }}
          >
            Save
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
};

/** Cars that share a steering lock in the wheel setup */
const STEER_LOCK_CLASSES = [
  { label: "Formula cars", models: ["lc26", "f12026-car"] },
  { label: "GT3", models: ["amg-gt3"] },
  // The two prototypes turn through different locks
  { label: "Prototypes", models: ["mtr-496r"] },
  { label: "LMDh prototype", models: ["lc-lmdh"] },
  // The classic class's cars turn through different locks
  { label: "JGTC GT500", models: ["nissan-r33-jgtc"] },
  { label: "Group A touring", models: ["nissan-r32-jtcc"] },
  { label: "Road cars", models: ["liana"] },
] as const;

const shortPad = (padId: string) => padDisplayName(padId).slice(0, 24);

function liveSteer(pads: PadState[], w: WheelSettings) {
  if (!w.steer) return null;
  const pad = pads.find((p) => p.id === w.steer!.padId);
  if (!pad) return null;
  const raw = pad.axes[w.steer.axis] ?? w.steer.center;
  const norm = wheelSteerValue(raw, w.steer, w.rotationDeg, w.steerDeadzone);
  const deg = Math.max(-1, Math.min(1, (raw - w.steer.center) * (w.steer.invert ? -1 : 1))) * (w.rotationDeg / 2);
  return { norm, deg };
}

function livePedal(pads: PadState[], b: PedalBinding | null, gamma = 1) {
  if (!b) return null;
  const pad = pads.find((p) => p.id === b.padId);
  return pad ? pedalValue(pad.axes[b.axis] ?? b.idle, b, gamma) : null;
}

/** This page's origin when it is not served from this PC (the bridge only accepts other origins it is told about) */
function useRemoteOrigin(): string | null {
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    const { hostname, origin: o } = window.location;
    setOrigin(hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" ? null : o);
  }, []);
  return origin;
}

/** A status line: a badge for the state and one line of words */
const StatusLine: React.FC<{ tone: BadgeTone; state: string; children: React.ReactNode }> = ({ tone, state, children }) => (
  <p role="status" className="m-0 flex flex-wrap items-center gap-x-2.5 gap-y-1">
    <Badge tone={tone} dot size="sm">
      {state}
    </Badge>
    <span className="lc-hint text-lc-fog">{children}</span>
  </p>
);

/** Where the force feedback bridge stands, and how to start it when it is not running */
function FfbBridgeStatus({ status }: { status: FfbStatus }) {
  const remoteOrigin = useRemoteOrigin();
  if (status.connection === "replaced") {
    return <StatusLine tone="warn" state="Taken over">Another tab took over the wheel. Close it, or switch force feedback off and on here to take it back.</StatusLine>;
  }
  if (status.connection === "unreachable") {
    return (
      <StatusLine tone="warn" state="Bridge off">
        The bridge runs on Windows from a copy of the project: run <code className="lc-mono text-lc-chalk">npm run ffb</code> in a
        terminal there and keep it open.
        {remoteOrigin ? (
          <>
            {" "}This page is not on that PC, so start it with <code className="lc-mono break-all text-lc-chalk">FFB_ALLOW_ORIGIN={remoteOrigin}</code>.
          </>
        ) : null}
      </StatusLine>
    );
  }
  if (status.connection !== "connected") return <StatusLine tone="neutral" state="Looking">Looking for the bridge on this PC.</StatusLine>;
  if (status.error) return <StatusLine tone="warn" state="Bridge">{status.error}</StatusLine>;
  if (status.device) return <StatusLine tone="good" state="Connected">Driving {status.device} through the bridge.</StatusLine>;
  return <StatusLine tone="neutral" state="Bridge">Connected, waiting for the wheel.</StatusLine>;
}

const SUPPORT_TONE: Record<SupportLevel, BadgeTone> = { tested: "good", expected: "neutral", unknown: "warn", no: "bad" };

/** What has been driven, and what each wheel family can expect from the two force feedback paths */
export function SupportedWheels() {
  const [open, setOpen] = useState(false);
  return (
    <SettingsCard title="Supported wheels" description={`${WHEEL_SUPPORT_SUMMARY} Steering, pedals and buttons work for any wheel.`} advanced>
      <div className="flex">
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide the list" : "Show the list"}
        </Button>
      </div>
      {open ? (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {WHEEL_SUPPORT.map((row) => (
            <li key={row.wheel} className="flex flex-col gap-1.5 border-t border-lc-line pt-2.5">
              <span className="lc-row-label">{row.wheel}</span>
              <span className="flex flex-wrap gap-2">
                <Badge tone={SUPPORT_TONE[row.webHid]} size="sm">Browser: {SUPPORT_LABEL[row.webHid]}</Badge>
                <Badge tone={SUPPORT_TONE[row.bridge]} size="sm">Bridge: {SUPPORT_LABEL[row.bridge]}</Badge>
              </span>
              <Hint>{row.note}</Hint>
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsCard>
  );
}

const connectHidWheel = () => {
  // requestDevice must run inside the click itself (it needs the click's user activation)
  void webHidFfb.connect();
};

/**
 * Copies the WebHID driver's diagnostics for a bug report. Where the clipboard is refused, the text is shown to copy
 * by hand.
 */
function CopyHidDiagnostics() {
  const [state, setState] = useState<{ kind: "idle" | "busy" | "copied" } | { kind: "failed"; report: string }>({ kind: "idle" });
  // The awaits below can outlive this button (WebHID switched off, the tab left)
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (state.kind !== "copied") return;
    const t = setTimeout(() => setState({ kind: "idle" }), 2500);
    return () => clearTimeout(t);
  }, [state]);
  const copy = async () => {
    setState({ kind: "busy" });
    let report: string;
    try {
      report = await webHidFfb.diagnose();
    } catch (e) {
      report = `LibreCorsa WebHID diagnostics failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (!alive.current) return;
    try {
      await navigator.clipboard.writeText(report);
      if (alive.current) setState({ kind: "copied" });
    } catch {
      if (alive.current) setState({ kind: "failed", report });
    }
  };
  return (
    <>
      <Button size="sm" variant="ghost" loading={state.kind === "busy"} onClick={() => void copy()}>
        <span aria-live="polite">{state.kind === "copied" ? "Copied" : "Copy diagnostics"}</span>
      </Button>
      {state.kind === "failed" ? (
        <div className="flex w-full flex-col gap-1">
          <Hint>The browser refused the clipboard: select the text below and copy it.</Hint>
          <textarea
            readOnly
            value={state.report}
            rows={8}
            aria-label="WebHID diagnostics"
            onFocus={(e) => e.currentTarget.select()}
            className="lc-mono w-full resize-y rounded-lc-nub border border-lc-line bg-lc-well p-2 text-[11px] leading-snug text-lc-fog"
          />
        </div>
      ) : null}
    </>
  );
}

/** Where the browser's own force feedback driver stands: pairing, the wheel it drives, or why it stopped */
function HidFfbStatusLine({ status, on }: { status: WebHidFfbStatus; on: boolean }) {
  const fatal = isFatalHidStatus(status);
  if (!on && !fatal) return null;
  const browserUnsupported = status.state === "unsupported" && status.device === null;
  const line =
    status.state === "ready" ? (
      <StatusLine tone="good" state="Connected">Driving {status.device ?? "the wheel"} from the browser.</StatusLine>
    ) : status.state === "connecting" ? (
      <StatusLine tone="neutral" state="Connecting">{status.device ? `Connecting to ${status.device}.` : "Connecting."}</StatusLine>
    ) : fatal ? (
      <StatusLine tone="bad" state="Stopped">
        {`${status.device ? `${status.device}: ` : ""}${status.message ?? "Browser force feedback failed"}. Force feedback goes through the bridge.`}
      </StatusLine>
    ) : (
      <StatusLine tone="warn" state="Not paired">{status.message ?? "No wheel paired yet: press Connect wheel to pick it."}</StatusLine>
    );
  const canConnect = !browserUnsupported && status.state !== "ready" && status.state !== "connecting";
  return (
    <div className="flex flex-col items-start gap-2 py-1">
      {line}
      <div className="flex flex-wrap items-center gap-2">
        {on && canConnect ? (
          <Button size="sm" variant="primary" onClick={connectHidWheel}>
            Connect wheel
          </Button>
        ) : null}
        {browserUnsupported ? null : <CopyHidDiagnostics />}
      </div>
    </div>
  );
}

/**
 * What the wheel setup is waiting on: nothing, an axis being calibrated (`all`: steering, throttle then brake in one
 * go), or a button press to bind. One at a time, so a rim button pressed during a calibration is never bound.
 */
type WheelMode =
  | { kind: "idle" }
  | { kind: "calibrating"; target: CalTarget; all: boolean }
  | { kind: "capturing"; action: PadAction };
const IDLE: WheelMode = { kind: "idle" };

const NO_WHEEL = "No wheel found. Press a button on the wheel to wake it";
/** What each row says while no wheel is there (the card says the rest once) */
const NEEDS_WHEEL = "Needs a wheel";

const wheelType = choice("tiles", {
  id: "wheelType",
  label: "Wheel type",
  columns: 2,
  options: [
    { id: "direct_drive", label: "Direct drive", detail: "Raw and unfiltered, for direct drive bases" },
    { id: "belt_gear", label: "Belt or gear", detail: "A light filter, for belt and gear driven wheels" },
  ],
  read: (env) => env.settings.wheel.type,
  // A type brings its own rotation, filter and dead zone
  write: (env, id) => env.update((s) => ({ ...s, wheel: { ...s.wheel, type: id as WheelType, ...WHEEL_TYPE_DEFAULTS[id as WheelType] } })),
  initial: () => DEFAULT_PLAYER_SETTINGS.wheel.type,
});

/** Steering lock per car class: the real car's lock, or a smaller one for a quicker rack (advanced) */
const steerLockRows: RowDef[] = STEER_LOCK_CLASSES.map((c) => {
  const real = CAR_WHEEL_LOCKS_DEG[c.models[0]];
  return slider({
    id: `lock-${c.models[0]}`,
    label: `Steering lock: ${c.label.toLowerCase()}`,
    hint: "How far round the rim full lock is. The real car's lock is the most realistic",
    advanced: true,
    min: STEER_LOCK_MIN_DEG,
    max: real,
    step: 20,
    format: (v) => (v >= real ? `${Math.round(v)}°, real` : `${Math.round(v)}°`),
    read: (env) => {
      const own = env.settings.wheel.steerLockPerCar?.[c.models[0]];
      return typeof own === "number" && own < real ? own : real;
    },
    write: (env, v) =>
      env.update((s) => {
        const next = { ...s.wheel.steerLockPerCar };
        for (const m of c.models) {
          if (v >= real) delete next[m];
          else next[m] = v;
        }
        return { ...s, wheel: { ...s.wheel, steerLockPerCar: next } };
      }),
    initial: () => real,
  });
});

/** Settings > Controls > Wheel, and the wheel half of first-run setup: type, calibration, rotation, buttons */
export function WheelSetup({ first }: { first?: boolean }) {
  const env = useSettingsEnv();
  const { settings, update } = env;
  const pads = useGamepads();
  const w = settings.wheel;
  const [mode, setModeState] = useState<WheelMode>(IDLE);
  // Read by the calibrator and capture callbacks, which a late frame can still call after the mode has moved on
  const modeRef = useRef(mode);
  const setMode = useCallback((next: WheelMode) => {
    modeRef.current = next;
    setModeState(next);
  }, []);
  const calibrating = mode.kind === "calibrating" ? mode.target : null;
  const capturing = mode.kind === "capturing" ? mode.action : null;
  const [customRotation, setCustomRotation] = useState(false);
  const noWheel = pads.length === 0 ? NEEDS_WHEEL : null;

  const setWheel = useCallback(
    (patch: Partial<WheelSettings>) => update((s) => ({ ...s, wheel: { ...s.wheel, ...patch } })),
    [update],
  );

  // A recognised wheel base with no steering bound yet: bind its first axis and the type's defaults (calibrate to refine)
  useEffect(() => {
    if (w.steer || pads.length === 0) return;
    const patch = autoConfigureWheel(connectedPads(), w);
    if (patch) setWheel(patch);
  }, [pads.length, w, setWheel]);

  const onSteer = useCallback(
    (steer: AxisBinding) => {
      const m = modeRef.current;
      if (m.kind !== "calibrating" || m.target !== "steer") return;
      setWheel({ steer });
      setMode(m.all ? { kind: "calibrating", target: "throttle", all: true } : IDLE);
    },
    [setWheel, setMode],
  );
  const onPedal = useCallback(
    (target: "throttle" | "brake", b: PedalBinding) => {
      // The result belongs to the calibrator that measured it: a late frame from the throttle step must never land on
      // the brake once the setup has moved on (that bound both pedals to the throttle's axis)
      const m = modeRef.current;
      if (m.kind !== "calibrating" || m.target !== target) return;
      if (target === "throttle") {
        setWheel({ throttle: b });
        setMode(m.all ? { kind: "calibrating", target: "brake", all: true } : IDLE);
        return;
      }
      setWheel({ brake: b });
      setMode(IDLE);
    },
    [setWheel, setMode],
  );
  const onCancelCal = useCallback(() => {
    if (modeRef.current.kind === "calibrating") setMode(IDLE);
  }, [setMode]);

  const onButton = useCallback(
    (b: ButtonBinding) => {
      const m = modeRef.current;
      if (m.kind !== "capturing") return;
      update((s) => {
        const buttons = { ...s.wheel.buttons };
        for (const k of Object.keys(buttons) as PadAction[]) {
          const cur = buttons[k];
          if (cur && cur.padId === b.padId && cur.button === b.button) buttons[k] = null;
        }
        buttons[m.action] = b;
        return { ...s, wheel: { ...s.wheel, buttons } };
      });
      setMode(IDLE);
    },
    [update, setMode],
  );
  const onCancelCapture = useCallback(() => {
    if (modeRef.current.kind === "capturing") setMode(IDLE);
  }, [setMode]);
  useButtonCapture(capturing, onButton, onCancelCapture);

  // Axes already taken, so the next calibration ignores them
  const excludeFor = useCallback(
    (target: CalTarget) =>
      [target !== "steer" ? w.steer : null, target !== "throttle" ? w.throttle : null, target !== "brake" ? w.brake : null]
        .filter((b): b is AxisBinding | PedalBinding => Boolean(b))
        .map((b) => ({ padId: b.padId, axis: b.axis })),
    [w.steer, w.throttle, w.brake],
  );
  const exclude = React.useMemo(() => (calibrating ? excludeFor(calibrating) : []), [calibrating, excludeFor]);

  const steer = liveSteer(pads, w);
  const throttle = livePedal(pads, w.throttle);
  const brake = livePedal(pads, w.brake, w.brakeGamma);

  const calRow = (target: CalTarget, label: string, bound: AxisBinding | PedalBinding | null, live: React.ReactNode, nav?: boolean) => (
    <div className="flex flex-col gap-2">
      <SettingRow
        label={label}
        hint={bound ? `${shortPad(bound.padId)}, axis ${bound.axis}` : "Not calibrated yet"}
        disabled={noWheel !== null}
        disabledReason={noWheel ?? undefined}
      >
        <Button
          size="sm"
          variant="secondary"
          data-nav-default={nav ? "" : undefined}
          disabled={noWheel !== null || capturing !== null || (calibrating !== null && calibrating !== target)}
          onClick={() => setMode(calibrating === target ? IDLE : { kind: "calibrating", target, all: false })}
        >
          {calibrating === target ? "Calibrating" : bound ? "Recalibrate" : "Calibrate"}
        </Button>
      </SettingRow>
      {calibrating === target ? (
        <AxisCalibrator key={target} target={target} exclude={exclude} onSteer={onSteer} onPedal={onPedal} onCancel={onCancelCal} />
      ) : bound && live ? (
        <div className="px-2 pb-1">{live}</div>
      ) : null}
    </div>
  );

  const presetRotation = (WHEEL_ROTATION_PRESETS as readonly number[]).includes(w.rotationDeg);
  const customActive = customRotation || !presetRotation;
  const anyButton = PAD_ACTIONS.some(({ id }) => w.buttons[id]);

  return (
    <>
      <SettingsCard
        title="Wheel"
        description={
          pads.length === 0
            ? NO_WHEEL
            : !w.throttle || !w.brake
              ? "Pedals not set up yet: Calibrate all sets steering, throttle and brake in one go"
              : undefined
        }
        rows={[wheelType]}
        first={first}
        extraReset={{
          changed: w.rotationDeg !== DEFAULT_PLAYER_SETTINGS.wheel.rotationDeg,
          reset: () => setWheel({ rotationDeg: DEFAULT_PLAYER_SETTINGS.wheel.rotationDeg }),
        }}
      >
        <SettingRow label="All axes" hint="Steering, throttle and brake, one after the other" disabled={noWheel !== null} disabledReason={noWheel ?? undefined}>
          <Button
            size="sm"
            variant="secondary"
            disabled={noWheel !== null || mode.kind !== "idle"}
            onClick={() => setMode({ kind: "calibrating", target: "steer", all: true })}
          >
            Calibrate all
          </Button>
        </SettingRow>
        {calRow(
          "steer",
          "Steering",
          w.steer,
          steer ? (
            <TrackMeter compact centered label="Wheel" value={steer.norm} color="var(--color-lc-info)" detail={`${steer.deg >= 0 ? "" : "-"}${Math.abs(Math.round(steer.deg))}°`} />
          ) : null,
        )}
        <SettingRow
          label="Rotation"
          hint={`Match the wheel driver's lock to lock. Steering is one to one up to the car's lock (${CAR_WHEEL_LOCKS_DEG.lc26}° formula cars, ${CAR_WHEEL_LOCKS_DEG["amg-gt3"]}° GT3, ${CAR_WHEEL_LOCKS_DEG["lc-lmdh"]} to ${CAR_WHEEL_LOCKS_DEG["mtr-496r"]}° prototypes, ${CAR_WHEEL_LOCKS_DEG["nissan-r33-jgtc"]} to ${CAR_WHEEL_LOCKS_DEG["nissan-r32-jtcc"]}° classic racers, ${CAR_WHEEL_LOCKS_DEG.liana}° road cars)`}
          changed={w.rotationDeg !== DEFAULT_PLAYER_SETTINGS.wheel.rotationDeg}
          onReset={() => {
            setCustomRotation(false);
            setWheel({ rotationDeg: DEFAULT_PLAYER_SETTINGS.wheel.rotationDeg });
          }}
          stacked
        >
          <ChoiceRotation
            value={customActive ? "custom" : String(w.rotationDeg)}
            onChange={(id) => {
              if (id === "custom") return setCustomRotation(true);
              setCustomRotation(false);
              setWheel({ rotationDeg: Number(id) });
            }}
          />
        </SettingRow>
        {customActive ? (
          <SettingRow label="Custom rotation">
            <Slider value={w.rotationDeg} min={180} max={2520} step={10} format={(v) => `${Math.round(v)}°`} onChange={(v) => setWheel({ rotationDeg: v })} />
          </SettingRow>
        ) : null}
      </SettingsCard>

      <SettingsCard title="Pedals">
        {calRow("throttle", "Throttle", w.throttle, throttle !== null ? <TrackMeter compact label="Throttle" value={throttle} color="var(--lc-sem-throttle)" /> : null)}
        {calRow("brake", "Brake", w.brake, brake !== null ? <TrackMeter compact label="Brake" value={brake} color="var(--lc-sem-brake)" /> : null)}
        <SettingField def={wheelBrakeCurve} />
      </SettingsCard>

      <SettingsCard title="Steering filters" rows={[...steerLockRows, ...wheelSteerFilters]} />

      <SettingsCard
        title="Buttons"
        description="Gear paddles and a pause button are the essentials"
        extraReset={{ changed: anyButton, reset: () => setWheel({ buttons: emptyWheelButtons() }) }}
        resetWhat="every wheel button (they are cleared)"
      >
        <div className="grid gap-x-8 gap-y-1 xl:grid-cols-2">
        {PAD_ACTIONS.map(({ id, label }) => {
          const listening = capturing === id;
          const b = w.buttons[id];
          return (
            <SettingRow
              key={id}
              label={label}
              className={listening ? "bg-lc-volt/6" : undefined}
              disabled={noWheel !== null}
              disabledReason={noWheel ?? undefined}
            >
              <Button
                size="sm"
                variant={listening ? "primary" : "secondary"}
                className="min-w-28"
                disabled={noWheel !== null || calibrating !== null}
                aria-label={listening ? `Press a button for ${label}` : `${label}: ${b ? `button ${b.button}` : "not set"}. Change`}
                onClick={() => setMode(listening ? IDLE : { kind: "capturing", action: id })}
              >
                {listening ? "Press a button" : b ? `Btn ${b.button}` : "Add"}
              </Button>
            </SettingRow>
          );
        })}
        </div>
        {capturing ? (
          <div className="pt-2">
            <StatusPill tone="live">Press a button on any device. Esc cancels; it stops after {CAPTURE_TIMEOUT_S} s</StatusPill>
          </div>
        ) : null}
      </SettingsCard>
    </>
  );
}

const ROTATION_OPTIONS = [...WHEEL_ROTATION_PRESETS.map((d) => ({ id: String(d), label: `${d}°` })), { id: "custom", label: "Custom" }];

function ChoiceRotation({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  // Segmented: a cheap setting, it changes as the cursor moves
  return <Segmented size="sm" options={ROTATION_OPTIONS} value={value} onChange={onChange} aria-label="Rotation" />;
}

const needsFfb = (env: SettingsEnv) => (env.settings.wheel.ffbEnabled ? null : "Needs force feedback on");
const withFfb = (row: RowDef): RowDef => ({ ...row, off: (env) => needsFfb(env) ?? row.off?.(env) ?? null });
/**
 * The Forces card says once, under its title, that its rows need force feedback on: there each row is greyed out but
 * keeps its own hint (an empty reason disables the row without replacing the hint), so the line is not repeated.
 */
const offQuietly = (env: SettingsEnv) => (env.settings.wheel.ffbEnabled ? null : "");
const inForces = (row: RowDef): RowDef => ({ ...row, off: (env) => offQuietly(env) ?? row.off?.(env) ?? null });

const invert = toggle({
  id: "ffbInvert",
  label: "Invert",
  hint: "Hold the rim and press Test: it should pull right, then left. If it pulls left first, turn this on",
  off: offQuietly,
  ...wheel("ffbInvert"),
});

/** The browser's own force feedback driver (WebHID): switching it on pairs the wheel inside the click */
function useHidRow(): RowDef {
  const hid = useSyncExternalStore(webHidFfb.subscribe, webHidFfb.getStatus, webHidFfb.getStatus);
  const unsupported = hid.state === "unsupported" && hid.device === null;
  return toggle({
    id: "hidFfb",
    label: "Browser connection",
    hint: "Drives the wheel straight from the browser where it can. Off, or for a wheel it cannot drive, the bridge does",
    advanced: true,
    off: (env) => needsFfb(env) ?? (unsupported ? (hid.message ?? "This browser cannot talk to the wheel directly") : null),
    read: (env) => env.settings.wheel.hidFfb && !unsupported,
    write: (env, on) => {
      if (on) connectHidWheel();
      env.update((s) => ({ ...s, wheel: { ...s.wheel, hidFfb: on } }));
    },
    initial: () => DEFAULT_PLAYER_SETTINGS.wheel.hidFfb,
  });
}

/** The cars with their own strength from the force meter (bug F01): shown beside Strength, each one clearable */
function PerCarStrength() {
  const env = useSettingsEnv();
  const list = Object.entries(env.settings.wheel.ffbPerCar ?? {}).flatMap(([v, own]) => (own ? [[v, own] as const] : []));
  const clear = (vehicle?: string) =>
    env.update((s) => {
      if (!vehicle) return { ...s, wheel: { ...s.wheel, ffbPerCar: {} } };
      const next = { ...s.wheel.ffbPerCar };
      delete next[vehicle];
      return { ...s, wheel: { ...s.wheel, ffbPerCar: next } };
    });
  if (list.length === 0) {
    return (
      <SettingRow label="Per-car strength" hint="No car has its own. The force meter in the car can set one">
        <span className="lc-hint">None</span>
      </SettingRow>
    );
  }
  return (
    <>
      {list.map(([vehicle, own]) => (
        <SettingRow
          key={vehicle}
          label={`Per-car strength: ${env.vehicleLabel?.(vehicle) ?? vehicle}`}
          hint={`${pct(own.gain)} strength, ${pct(own.minForce)} minimum force. In use instead of Strength and Minimum force${vehicle === env.vehicleModel ? ", for this car" : ""}`}
        >
          <Button size="sm" variant="secondary" onClick={() => clear(vehicle)}>
            Clear
          </Button>
        </SettingRow>
      ))}
      {list.length > 1 ? (
        <SettingRow label="Clear every car's own strength">
          <Button size="sm" variant="secondary" onClick={() => clear()}>
            Clear all
          </Button>
        </SettingRow>
      ) : null}
    </>
  );
}

/** Settings > Force feedback, and the force feedback half of the wheel step in first-run setup */
export function ForceFeedbackSetup({ first }: { first?: boolean }) {
  const env = useSettingsEnv();
  const w = env.settings.wheel;
  const ffb = useSyncExternalStore(wheelFfb.subscribe, wheelFfb.getStatus, wheelFfb.getStatus);
  const hid = useSyncExternalStore(webHidFfb.subscribe, webHidFfb.getStatus, webHidFfb.getStatus);
  const hidRow = useHidRow();
  const detail = useSettingsDetail();
  const hidBrowserUnsupported = hid.state === "unsupported" && hid.device === null;
  // The browser drives the wheel only while it is switched on and ready; otherwise the bridge does
  const hidActive = w.hidFfb && hid.state === "ready";
  const ffbReady = hidActive || (ffb.connection === "connected" && ffb.device !== null && ffb.error === null);
  const extras: RowDef[] = [
    ...(w.hidFfb && webHidFfb.offersCondition("friction") ? [ffbFriction] : []),
    ...(w.hidFfb && webHidFfb.offersCondition("inertia") ? [ffbInertia] : []),
  ];
  // Off, the card's description already says why (an empty reason keeps the row's own hint)
  const testOff = !w.ffbEnabled ? "" : ffbReady ? null : "Needs a connected wheel";
  return (
    <>
      <SettingsCard
        title="Forces"
        description={w.ffbEnabled ? undefined : "Needs force feedback on: switch it on for the strength, the test and the effects"}
        rows={[ffbOn, inForces(ffbStrength)]}
        first={first}
      >
        {/* Pairing needs one click: offered here too, so Simple and first-run setup can connect the wheel */}
        {detail === "simple" && w.ffbEnabled && w.hidFfb && !hidBrowserUnsupported && hid.state !== "ready" ? (
          <HidFfbStatusLine status={hid} on />
        ) : null}
        <PerCarStrength />
        <SettingField def={invert} />
        <SettingRow label="Test direction" hint="A pull right for a second, then left" disabled={testOff !== null} disabledReason={testOff || undefined}>
          <Button size="sm" variant="secondary" disabled={testOff !== null} onClick={() => wheelFfb.test(w.ffbInvert)}>
            Test
          </Button>
        </SettingRow>
      </SettingsCard>
      {/* Off, the connection and the effects have nothing to say: they come back with the switch */}
      {w.ffbEnabled ? (
        <>
      <SettingsCard title="Connection" rows={[hidRow, ...(hidActive && webHidFfb.hasRevLeds() ? [withFfb(revLights)] : [])]}>
        {hidBrowserUnsupported ? null : <HidFfbStatusLine status={hid} on={w.hidFfb} />}
        {!w.hidFfb || hidBrowserUnsupported || ffb.connection === "connected" ? <FfbBridgeStatus status={ffb} /> : null}
      </SettingsCard>
      <SettingsCard
        title="Effects"
        description="The wheel's overall strength stays in its own software; turn its centring spring off there"
        rows={ffbEffects.map(withFfb)}
      />
      <SettingsCard title="Fine tuning" rows={[...ffbFineTuning, ...extras, collisionGuard].map(withFfb)} />
        </>
      ) : null}
    </>
  );
}

/** First-run setup's wheel step: the wheel and its force feedback side by side */
export const WheelStep: React.FC = () => {
  const pads = useGamepads();
  const wheels = pads.filter(isLikelyWheel);
  return (
    <div className="grid items-start gap-3 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-3">
        {wheels.length === 0 && pads.length === 0 ? <Hint>{NO_WHEEL}.</Hint> : null}
        <WheelSetup first />
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <ForceFeedbackSetup />
        <SupportedWheels />
      </div>
    </div>
  );
};
