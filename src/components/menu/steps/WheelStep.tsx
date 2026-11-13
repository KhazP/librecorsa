"use client";

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PAD_ACTIONS, type PadAction } from "@/lib/input/bindings";
import {
  autoConfigureWheel,
  CAR_WHEEL_LOCKS_DEG,
  connectedPads,
  emptyWheelButtons,
  findPad,
  padDisplayName,
  pedalValue,
  snapshotAxes,
  CLAIMED_TELEMETRY_PORTS,
  DEFAULT_TELEMETRY_PORT,
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
import {
  LOGITECH_WEBHID_NAMES,
  SUPPORT_LABEL,
  type SupportLevel,
  THRUSTMASTER_NAMES,
  WHEEL_SUPPORT,
  WHEEL_SUPPORT_SUMMARY,
} from "@/lib/input/wheel-support";
import { Choice, Toggle, TyreSlider } from "@/components/hud/PauseMenu";
import { padPressTracker, suspendMenuNav, useGamepads, type PadState } from "../useMenuNav";
import { CAPTURE_TIMEOUT_S, useButtonCapture } from "./button-capture";
import { TuningSlider } from "./TuningSlider";
import { AutoGrid, BindRow, bindKeyClass, ChoiceText, Hint, PillAction, SetupCard, SolidPill, StatusPill, SubHead, TrackMeter } from "./setup-ui";
import type { SetupStepProps } from "./types";

type CalTarget = "steer" | "throttle" | "brake";

const STEER_DETECT = 0.12;
const PEDAL_DETECT = 0.2;

const PROMPTS: Record<CalTarget, { rest: string; act: string }> = {
  steer: { rest: "Hold the wheel straight ahead, then press Continue.", act: "Now turn the wheel about 90° to the LEFT and hold it." },
  throttle: { rest: "Take your foot off the throttle, then press Continue.", act: "Press the throttle all the way down, then release it." },
  brake: { rest: "Take your foot off the brake, then press Continue.", act: "Press the brake all the way down, then release it." },
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
    // move the focus or change the setup step, ending this). Esc and a controller's Ⓑ still cancel.
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
    <div className="flex flex-col gap-2.5 rounded-2xl border border-[#CCFF00]/60 bg-[#CCFF00]/[0.08] p-3.5">
      <p className="lc-title m-0 text-[14px] text-[#F5F7FA]">{stage === "rest" ? PROMPTS[target].rest : PROMPTS[target].act}</p>
      {measuring ? (
        <span className="block h-1.5 overflow-hidden rounded-full bg-[#08090D]">
          <span className="block h-full rounded-full bg-[#CCFF00] transition-[width]" style={{ width: `${Math.round(meter * 100)}%` }} />
        </span>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {stage === "rest" ? (
          <SolidPill
            tone="volt"
            onClick={() => {
              baseline.current = snapshotAxes(connectedPads());
              locked.current = null;
              heldSince.current = 0;
              setStage("act");
            }}
          >
            Continue
          </SolidPill>
        ) : stage === "locked" && target !== "steer" ? (
          <SolidPill
            tone="volt"
            onClick={() => {
              const l = locked.current;
              if (!l || reported.current) return;
              reported.current = true;
              onPedal(target, { padId: l.padId, axis: l.axis, idle: l.base, full: l.peak });
            }}
          >
            Save
          </SolidPill>
        ) : null}
        <PillAction onClick={onCancel} className="h-[34px]!">
          Cancel
        </PillAction>
      </div>
    </div>
  );
};


/** Cars that share a steering lock in the wheel setup */
const STEER_LOCK_CLASSES = [
  { label: "Formula cars", models: ["vf26", "f12026-car"] },
  { label: "GT3", models: ["amg-gt3"] },
  { label: "Prototypes", models: ["mtr-496r"] },
  // The classic class's cars turn through different locks
  { label: "JGTC GT500", models: ["nissan-r33-jgtc"] },
  { label: "Group A touring", models: ["nissan-r32-jtcc"] },
  { label: "Road cars", models: ["liana"] },
] as const;

const shortPad = (padId: string) => padDisplayName(padId).slice(0, 18);

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

/** Where the force-feedback bridge stands, and how to start it when it is not running */
function FfbBridgeStatus({ status }: { status: FfbStatus }) {
  const remoteOrigin = useRemoteOrigin();
  if (status.connection === "replaced") {
    return (
      <p role="status" className="m-0 rounded-[14px] bg-[#FFB300]/10 px-3.5 py-2.5 text-[13px] leading-relaxed text-[#FFB300]">
        Another tab took over the wheel. Close it, or switch force feedback off and on here to take it back.
      </p>
    );
  }
  if (status.connection === "unreachable") {
    return (
      <p role="status" className="m-0 rounded-[14px] bg-[#FFB300]/10 px-3.5 py-2.5 text-[13px] leading-relaxed text-[#FFB300]">
        Bridge not running. It runs on Windows from a copy of the project: in a terminal in that folder run{" "}
        <code className="font-f1-mono text-[12px] font-bold text-[#F5F7FA]">npm run ffb</code> and keep it open; this
        page connects within a few seconds.
        {remoteOrigin ? (
          <>
            {" "}
            This page is not on this PC, so start the bridge with{" "}
            <code className="font-f1-mono text-[12px] font-bold break-all text-[#F5F7FA]">
              FFB_ALLOW_ORIGIN={remoteOrigin}
            </code>{" "}
            set, or it turns the page away and this message stays.
          </>
        ) : null}
      </p>
    );
  }
  const [color, text] =
    status.connection !== "connected"
      ? ["#8E96AA", "Looking for the bridge on this PC…"]
      : status.error
        ? ["#FFB300", status.error]
        : status.device
          ? ["#00E676", `Driving ${status.device}`]
          : ["#8E96AA", "Bridge connected · waiting for the wheel…"];
  return (
    <p role="status" className="m-0 flex items-center gap-2 font-f1-mono text-[12px] font-bold" style={{ color }}>
      <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
      {text}
    </p>
  );
}

const SUPPORT_COLOR: Record<SupportLevel, string> = {
  tested: "#00E676",
  expected: "#8E96AA",
  unknown: "#FFB300",
  no: "#FF2A3C",
};

function SupportCell({ path, level }: { path: string; level: SupportLevel }) {
  const color = SUPPORT_COLOR[level];
  return (
    <span className="flex items-center gap-1.5 font-f1-mono text-[11px] font-bold" style={{ color }}>
      <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: color }} />
      {path} · {SUPPORT_LABEL[level]}
    </span>
  );
}

/** What has actually been driven, and what each wheel family can expect from the two force-feedback paths */
function SupportedWheels() {
  const [open, setOpen] = useState(false);
  return (
    <SetupCard
      title="Supported wheels"
      action={<PillAction onClick={() => setOpen((v) => !v)}>{open ? "Hide list" : "Show list"}</PillAction>}
    >
      <Hint>{WHEEL_SUPPORT_SUMMARY} Steering, pedals and buttons work through the browser for any wheel.</Hint>
      {open ? (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {WHEEL_SUPPORT.map((row) => (
            <li key={row.wheel} className="flex flex-col gap-1 border-t border-[#262B3D] pt-2.5">
              <span className="text-[13px] font-bold text-[#F5F7FA]">{row.wheel}</span>
              <span className="flex flex-wrap gap-x-4 gap-y-1">
                <SupportCell path="Browser (WebHID)" level={row.webHid} />
                <SupportCell path="Bridge (Windows)" level={row.bridge} />
              </span>
              <Hint>{row.note}</Hint>
            </li>
          ))}
        </ul>
      ) : null}
    </SetupCard>
  );
}

/** Settings most players never touch, folded away under a full-width row that opens them */
function MoreSettings({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3 border-t border-[#262B3D] pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[40px] w-full cursor-pointer items-center justify-between gap-3 rounded-[12px] border-0 bg-transparent px-1 text-left text-[14px] font-bold text-[#F5F7FA] transition-colors duration-200 hover:bg-[#F5F7FA]/[0.04]"
      >
        {label}
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className={`h-4 w-4 shrink-0 text-[#8E96AA] transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        >
          <path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? children : null}
    </div>
  );
}

const connectHidWheel = () => {
  // requestDevice must run inside the click itself (it needs the click's user activation)
  void webHidFfb.connect();
};

/** Where the WebHID driver stands: pairing, the wheel it drives, or why it stopped */
function HidFfbStatusLine({ status, on }: { status: WebHidFfbStatus; on: boolean }) {
  const fatal = isFatalHidStatus(status);
  if (!on && !fatal) return null;
  const browserUnsupported = status.state === "unsupported" && status.device === null;
  const [color, text] =
    status.state === "ready"
      ? ["#00E676", `Driving ${status.device ?? "the wheel"} over WebHID`]
      : status.state === "connecting"
        ? ["#8E96AA", status.device ? `Connecting to ${status.device}…` : "Connecting…"]
        : fatal
          ? ["#FF2A3C", `${status.device ? `${status.device}: ` : ""}${status.message ?? "WebHID force feedback failed"}`]
          : ["#FFB300", status.message ?? "No wheel paired yet: click Connect to pick it"];
  const canConnect = !browserUnsupported && status.state !== "ready" && status.state !== "connecting";
  return (
    <div className="flex flex-col items-start gap-1.5 px-2 pt-1">
      <p role="status" className="m-0 flex items-center gap-2 font-f1-mono text-[12px] leading-relaxed font-bold" style={{ color }}>
        <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: color }} />
        {text}
      </p>
      {fatal && !browserUnsupported ? (
        <Hint>WebHID switched off; force feedback goes through the bridge.{on ? "" : " Switch it on again to retry."}</Hint>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {on && canConnect ? (
          <SolidPill tone="volt" onClick={connectHidWheel}>
            Connect wheel
          </SolidPill>
        ) : null}
        {browserUnsupported ? null : <CopyHidDiagnostics />}
      </div>
    </div>
  );
}

/**
 * Copies the WebHID driver's diagnostics (the wheel's report descriptor, its HID PID reports, the setup traffic) for
 * a bug report. Where the clipboard is refused, the text is shown to copy by hand.
 */
function CopyHidDiagnostics() {
  // failed: the clipboard was refused, so the report is shown to copy by hand
  const [state, setState] = useState<{ kind: "idle" | "busy" | "copied" } | { kind: "failed"; report: string }>({ kind: "idle" });
  // The awaits below can outlive this button (WebHID switched off, the step left)
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
      <button
        type="button"
        onClick={() => void copy()}
        disabled={state.kind === "busy"}
        className="inline-flex h-[34px] shrink-0 cursor-pointer items-center rounded-full border border-[#262B3D] bg-[#F5F7FA]/[0.08] px-3.5 text-[13px] font-bold whitespace-nowrap text-[#F5F7FA] transition-colors duration-200 hover:border-[#3A4157] disabled:cursor-wait disabled:opacity-60"
      >
        <span aria-live="polite">{state.kind === "copied" ? "Copied" : "Copy diagnostics"}</span>
      </button>
      {state.kind === "failed" ? (
        <div className="flex w-full flex-col gap-1">
          <Hint>The browser refused the clipboard: select the text below and copy it.</Hint>
          <textarea
            readOnly
            value={state.report}
            rows={8}
            aria-label="WebHID diagnostics"
            onFocus={(e) => e.currentTarget.select()}
            className="w-full resize-y rounded-[10px] border border-[#262B3D] bg-[#050608] p-2 font-f1-mono text-[11px] leading-snug text-[#C9D1E0]"
          />
        </div>
      ) : null}
    </>
  );
}

/**
 * What the wheel step is waiting on: nothing, an axis being calibrated (`all`: steering, throttle then brake in one
 * go), or a button press to bind. One at a time, so a rim button pressed during a calibration is never bound.
 */
type WheelMode =
  | { kind: "idle" }
  | { kind: "calibrating"; target: CalTarget; all: boolean }
  | { kind: "capturing"; action: PadAction };
const IDLE: WheelMode = { kind: "idle" };

/** Wheel: type, steering calibration and rotation, pedal calibration, button mapping */
export const WheelStep: React.FC<SetupStepProps> = ({ settings, onChangeSettings }) => {
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
  const ffb = useSyncExternalStore(wheelFfb.subscribe, wheelFfb.getStatus, wheelFfb.getStatus);
  const hid = useSyncExternalStore(webHidFfb.subscribe, webHidFfb.getStatus, webHidFfb.getStatus);
  const hidBrowserUnsupported = hid.state === "unsupported" && hid.device === null;
  // WebHID drives the wheel only while it is switched on and ready; otherwise the bridge does
  const hidActive = w.hidFfb && hid.state === "ready";
  const ffbReady = hidActive || (ffb.connection === "connected" && ffb.device !== null && ffb.error === null);
  // The port field edits as text: a half-typed number must not snap to the range's edge while typing
  const [portText, setPortText] = useState(String(w.telemetryPort));
  const portRef = useRef<HTMLInputElement | null>(null);
  // The port can change elsewhere: follow it, unless the field is being edited
  useEffect(() => {
    if (document.activeElement !== portRef.current) setPortText(String(w.telemetryPort));
  }, [w.telemetryPort]);

  const setWheel = useCallback(
    (patch: Partial<WheelSettings>) => onChangeSettings((s) => ({ ...s, wheel: { ...s.wheel, ...patch } })),
    [onChangeSettings]
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
    [setWheel, setMode]
  );
  const onPedal = useCallback(
    (target: "throttle" | "brake", b: PedalBinding) => {
      // The result belongs to the calibrator that measured it: a late frame from the throttle step must never land on
      // the brake once the wizard has moved on (that bound both pedals to the throttle's axis)
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
    [setWheel, setMode]
  );
  const onCancelCal = useCallback(() => {
    if (modeRef.current.kind === "calibrating") setMode(IDLE);
  }, [setMode]);

  const onButton = useCallback(
    (b: ButtonBinding) => {
      const m = modeRef.current;
      if (m.kind !== "capturing") return;
      onChangeSettings((s) => {
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
    [onChangeSettings, setMode]
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
    [w.steer, w.throttle, w.brake]
  );
  const exclude = React.useMemo(() => (calibrating ? excludeFor(calibrating) : []), [calibrating, excludeFor]);

  const steer = liveSteer(pads, w);
  const throttle = livePedal(pads, w.throttle);
  const brake = livePedal(pads, w.brake, w.brakeGamma);

  const calRow = (target: CalTarget, label: string, bound: AxisBinding | PedalBinding | null, live: React.ReactNode) => (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <SubHead>{label}</SubHead>
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="truncate font-f1-mono text-[11px] font-bold text-[#8E96AA]">
            {bound ? `${shortPad(bound.padId)} · axis ${bound.axis}` : "not set"}
          </span>
          <SolidPill
            disabled={capturing !== null || (calibrating !== null && calibrating !== target)}
            onClick={() => setMode(calibrating === target ? IDLE : { kind: "calibrating", target, all: false })}
            className={calibrating === target ? "lc-listen" : ""}
          >
            {bound ? "Recalibrate" : "Calibrate"}
          </SolidPill>
        </span>
      </div>
      {calibrating === target ? (
        <AxisCalibrator key={target} target={target} exclude={exclude} onSteer={onSteer} onPedal={onPedal} onCancel={onCancelCal} />
      ) : bound ? (
        live
      ) : null}
    </div>
  );

  const notConnected = <Hint>Device not connected</Hint>;
  const customActive = customRotation || !(WHEEL_ROTATION_PRESETS as readonly number[]).includes(w.rotationDeg);
  const rotationPill = (active: boolean) =>
    `min-h-[40px] flex-1 cursor-pointer rounded-full border px-1.5 font-f1-mono text-[12px] font-extrabold transition-colors duration-200 ${
      active
        ? "border-[#CCFF00] bg-[#CCFF00] text-[#08090D]"
        : "border-[#262B3D] bg-transparent text-[#8E96AA] hover:border-[#3A4157] hover:text-[#F5F7FA]"
    }`;

  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-5">
        <SetupCard
          title="Wheel"
          action={
            <SolidPill
              tone="volt"
              disabled={mode.kind !== "idle"}
              onClick={() => setMode({ kind: "calibrating", target: "steer", all: true })}
            >
              Calibrate all
            </SolidPill>
          }
        >
          {pads.length === 0 ? (
            <Hint className="text-[13px]!">No wheel found yet. Press a button on the wheel to wake it up.</Hint>
          ) : !w.throttle || !w.brake ? (
            <p className="m-0 rounded-[14px] bg-[#FFB300]/10 px-3.5 py-2.5 text-[13px] text-[#FFB300]">
              Pedals not set up yet: press <strong>Calibrate all</strong> to set steering, throttle and brake in one go.
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { id: "direct_drive", title: "Direct drive", sub: "Fanatec DD, Moza, Simucube, Simagic… · raw, unfiltered" },
                { id: "belt_gear", title: "Belt / gear", sub: "Logitech, Thrustmaster, CSL Elite… · light filter" },
              ] as const
            ).map((t) => (
              <Choice
                key={t.id}
                active={w.type === t.id}
                onClick={() => setWheel({ type: t.id as WheelType, ...WHEEL_TYPE_DEFAULTS[t.id] })}
              >
                <ChoiceText title={t.title} detail={t.sub} size={14} />
              </Choice>
            ))}
          </div>
          {calRow(
            "steer",
            "Steering axis",
            w.steer,
            steer ? (
              <TrackMeter
                compact
                centered
                label="Wheel"
                value={steer.norm}
                color="#00E5FF"
                detail={`${steer.deg >= 0 ? "" : "−"}${Math.abs(Math.round(steer.deg))}°`}
              />
            ) : (
              notConnected
            )
          )}
          <div className="flex flex-col gap-2.5 border-t border-[#262B3D] pt-3">
            <SubHead>Rotation · lock to lock</SubHead>
            <div className="flex gap-1.5">
              {WHEEL_ROTATION_PRESETS.map((deg) => (
                <button
                  key={deg}
                  type="button"
                  aria-pressed={!customRotation && w.rotationDeg === deg}
                  onClick={() => {
                    setCustomRotation(false);
                    setWheel({ rotationDeg: deg });
                  }}
                  className={rotationPill(!customRotation && w.rotationDeg === deg)}
                >
                  {deg}°
                </button>
              ))}
              <button
                type="button"
                aria-pressed={customActive}
                onClick={() => setCustomRotation(true)}
                className={rotationPill(customActive)}
              >
                Custom
              </button>
            </div>
            {customActive ? (
              <TyreSlider
                label="Rotation"
                value={w.rotationDeg}
                limits={{ min: 180, max: 2520, step: 10 }}
                format={(v) => `${v.toFixed(0)}°`}
                onChange={(v) => setWheel({ rotationDeg: v })}
              />
            ) : null}
            <Hint>
              Match your wheel driver&apos;s rotation. Steering is 1:1 up to the car&apos;s lock ({CAR_WHEEL_LOCKS_DEG.vf26}°
              open-wheelers, {CAR_WHEEL_LOCKS_DEG["amg-gt3"]}° GT3, {CAR_WHEEL_LOCKS_DEG["mtr-496r"]}° prototypes,{" "}
              {CAR_WHEEL_LOCKS_DEG["nissan-r33-jgtc"]}–{CAR_WHEEL_LOCKS_DEG["nissan-r32-jtcc"]}° classic racers,{" "}
              {CAR_WHEEL_LOCKS_DEG.liana}° road cars); a base with less rotation
              still reaches full lock.
            </Hint>
          </div>
          <MoreSettings label="More steering settings">
            <div className="flex flex-col gap-2.5 border-t border-[#262B3D] pt-3">
              <SubHead>Steering lock · per car</SubHead>
              <AutoGrid min={180} className="gap-x-4 gap-y-1">
                {STEER_LOCK_CLASSES.map((c) => {
                  const real = CAR_WHEEL_LOCKS_DEG[c.models[0]];
                  const own = w.steerLockPerCar?.[c.models[0]];
                  const value = typeof own === "number" && own < real ? own : real;
                  return (
                    <TyreSlider
                      key={c.label}
                      label={c.label}
                      value={value}
                      limits={{ min: STEER_LOCK_MIN_DEG, max: real, step: 20 }}
                      format={(v) => (v >= real ? `${v.toFixed(0)}° real` : `${v.toFixed(0)}°`)}
                      onChange={(v) => {
                        const next = { ...w.steerLockPerCar };
                        for (const m of c.models) {
                          if (v >= real) delete next[m];
                          else next[m] = v;
                        }
                        setWheel({ steerLockPerCar: next });
                      }}
                    />
                  );
                })}
              </AutoGrid>
              <Hint>
                How far round the rim full lock is. The real car&apos;s lock is the most realistic; a smaller one gives a
                quicker rack, which suits a wheel without force feedback, above all in the GT3.
              </Hint>
            </div>
            <AutoGrid min={180} className="gap-x-4 gap-y-1">
              <TyreSlider
                label="Centre dead zone"
                value={Math.round(w.steerDeadzone * 1000) / 10}
                limits={{ min: 0, max: 10, step: 0.5 }}
                format={(v) => `${v.toFixed(1)} %`}
                onChange={(v) => setWheel({ steerDeadzone: v / 100 })}
              />
              <TyreSlider
                label="Input filter"
                value={Math.round(w.steerSmoothingS * 1000)}
                limits={{ min: 0, max: 80, step: 5 }}
                format={(v) => (v === 0 ? "Off" : `${v.toFixed(0)} ms`)}
                onChange={(v) => setWheel({ steerSmoothingS: v / 1000 })}
              />
            </AutoGrid>
          </MoreSettings>
        </SetupCard>

        <SetupCard title="Pedals">
          {calRow(
            "throttle",
            "Throttle",
            w.throttle,
            throttle !== null ? <TrackMeter compact label="Throttle" value={throttle} /> : notConnected
          )}
          {calRow(
            "brake",
            "Brake",
            w.brake,
            brake !== null ? <TrackMeter compact label="Brake" value={brake} color="#FF2A3C" /> : notConnected
          )}
          <div className="flex flex-col gap-1 border-t border-[#262B3D] pt-2.5">
            <TyreSlider
              label="Brake curve"
              value={w.brakeGamma}
              limits={{ min: 0.5, max: 2.5, step: 0.1 }}
              format={(v) => (Math.abs(v - 1) < 0.05 ? "Linear" : v > 1 ? `Progressive ${v.toFixed(1)}` : `Aggressive ${v.toFixed(1)}`)}
              onChange={(v) => setWheel({ brakeGamma: v })}
            />
            <Hint className="px-2">
              Load-cell brakes usually feel best linear; potentiometer pedals often like 1.3–1.6. A clutch is not needed.
            </Hint>
          </div>
        </SetupCard>

        <SetupCard
          title="Buttons"
          action={<PillAction onClick={() => setWheel({ buttons: emptyWheelButtons() })}>Clear</PillAction>}
        >
          <AutoGrid min={260} className="gap-x-4 gap-y-0.5">
            {PAD_ACTIONS.map(({ id, label }) => {
              const listening = capturing === id;
              const b = w.buttons[id];
              return (
                <BindRow key={id} label={label} listening={listening}>
                  <button
                    type="button"
                    aria-label={b || listening ? undefined : `Bind ${label}`}
                    disabled={calibrating !== null}
                    onClick={() => setMode(listening ? IDLE : { kind: "capturing", action: id })}
                    className={`${bindKeyClass(listening ? "listening" : b ? "bound" : "empty", "min-w-[96px]")} h-[32px]! text-[11px]! disabled:cursor-not-allowed disabled:opacity-30`}
                  >
                    {listening ? "PRESS…" : b ? `Button ${b.button}` : "+"}
                  </button>
                </BindRow>
              );
            })}
          </AutoGrid>
          {capturing ? (
            <StatusPill tone="live">Press a button on any device · Esc cancels · stops after {CAPTURE_TIMEOUT_S} s</StatusPill>
          ) : (
            <Hint>Gear paddles and a pause button are the essentials.</Hint>
          )}
        </SetupCard>
      </div>

      <div className="flex min-w-0 flex-col gap-5">
        <SetupCard
          title="Force feedback"
          action={
            <button
              type="button"
              role="switch"
              aria-checked={w.ffbEnabled}
              aria-label="Force feedback"
              onClick={() => setWheel({ ffbEnabled: !w.ffbEnabled })}
              className={`relative h-[30px] w-16 shrink-0 cursor-pointer rounded-full border-0 transition-colors duration-200 ${
                w.ffbEnabled ? "bg-[#CCFF00]" : "bg-[#1B1F2B] shadow-[inset_0_0_0_1px_#262B3D]"
              }`}
            >
              <span
                aria-hidden
                className={`absolute top-1/2 -translate-y-1/2 font-f1-mono text-[11px] font-extrabold ${
                  w.ffbEnabled ? "left-2.5 text-[#08090D]" : "right-2.5 text-[#8E96AA]"
                }`}
              >
                {w.ffbEnabled ? "ON" : "OFF"}
              </span>
              <span
                aria-hidden
                className={`absolute top-[5px] h-5 w-5 rounded-full transition-[left] duration-[220ms] ease-[cubic-bezier(.2,.8,.2,1)] ${
                  w.ffbEnabled ? "left-[39px] bg-[#08090D]" : "left-[5px] bg-[#8E96AA]"
                }`}
              >
                {""}
              </span>
            </button>
          }
        >
          {w.ffbEnabled ? (
            <>
              <div className="flex flex-col gap-2">
                <Toggle
                  label="Browser force feedback over WebHID (experimental · USB HID PID bases, listed Logitech wheels, Thrustmaster)"
                  detail={
                    hidBrowserUnsupported
                      ? (hid.message ?? "WebHID is not available in this browser")
                      : `Drives USB HID PID wheels and the Logitech ${LOGITECH_WEBHID_NAMES} directly from Chrome/Edge with no external helper (the G920 and G923 for Xbox once Logitech G HUB has put them in PC mode), and tries the Thrustmaster ${THRUSTMASTER_NAMES} (untested). Other Logitech and Thrustmaster wheels need the bridge. Falls back to the local bridge when off.`
                  }
                  checked={w.hidFfb && !hidBrowserUnsupported}
                  disabled={hidBrowserUnsupported}
                  onChange={() => {
                    if (w.hidFfb) {
                      setWheel({ hidFfb: false });
                      return;
                    }
                    connectHidWheel();
                    setWheel({ hidFfb: true });
                  }}
                />
                {hidBrowserUnsupported ? null : <HidFfbStatusLine status={hid} on={w.hidFfb} />}
                {hidActive && webHidFfb.hasRevLeds() ? (
                  <Toggle
                    label="Rev lights on the wheel"
                    detail="The rim's five LEDs light up with the revs and flash at the shift point"
                    checked={w.revLeds}
                    onChange={() => setWheel({ revLeds: !w.revLeds })}
                  />
                ) : null}
              </div>
              {!w.hidFfb || hidBrowserUnsupported || ffb.connection === "connected" ? <FfbBridgeStatus status={ffb} /> : null}
              <div className="flex flex-col gap-2.5 border-t border-[#262B3D] pt-3">
                <SubHead>Strength and effects</SubHead>
                <AutoGrid min={220} className="gap-x-[18px] gap-y-1">
                  <TyreSlider
                    label="Strength"
                    value={Math.round(w.ffbGain * 100)}
                    limits={{ min: 0, max: 200, step: 5 }}
                    format={(v) => `${v.toFixed(0)} %`}
                    onChange={(v) => setWheel({ ffbGain: v / 100 })}
                  />
                  <TuningSlider
                    label="Damping"
                    value={Math.round(w.ffbDamping * 100)}
                    min={0}
                    max={100}
                    step={1}
                    format={(v) => (v === 0 ? "Off" : `${v} %`)}
                    hint="Resists fast rim movement and steadies the wheel at speed"
                    onChange={(v) => setWheel({ ffbDamping: v / 100 })}
                  />
                  <TyreSlider
                    label="Kerb vibration"
                    value={Math.round(w.ffbKerb * 100)}
                    limits={{ min: 0, max: 100, step: 5 }}
                    format={(v) => (v === 0 ? "Off" : `${v.toFixed(0)} %`)}
                    onChange={(v) => setWheel({ ffbKerb: v / 100 })}
                  />
                  <TyreSlider
                    label="ABS vibration"
                    value={Math.round(w.ffbAbs * 100)}
                    limits={{ min: 0, max: 100, step: 5 }}
                    format={(v) => (v === 0 ? "Off" : `${v.toFixed(0)} %`)}
                    onChange={(v) => setWheel({ ffbAbs: v / 100 })}
                  />
                  <TuningSlider
                    label="Slip vibration"
                    value={Math.round(w.ffbSlip * 100)}
                    min={0}
                    max={100}
                    step={5}
                    format={(v) => (v === 0 ? "Off" : `${v} %`)}
                    hint="Buzzes from just before the tyres' grip peak: understeer, lock-ups, wheelspin. WebHID wheels"
                    onChange={(v) => setWheel({ ffbSlip: v / 100 })}
                  />
                  <TuningSlider
                    label="Shift warning"
                    value={Math.round(w.ffbShift * 100)}
                    min={0}
                    max={100}
                    step={5}
                    format={(v) => (v === 0 ? "Off" : `${v} %`)}
                    hint="Buzzes as the revs reach the shift lights, until the next gear. WebHID wheels"
                    onChange={(v) => setWheel({ ffbShift: v / 100 })}
                  />
                </AutoGrid>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <SolidPill disabled={!ffbReady} onClick={() => wheelFfb.test(w.ffbInvert)} className="h-10!">
                  Test direction
                </SolidPill>
                <button
                  type="button"
                  onClick={() => setWheel({ ffbInvert: !w.ffbInvert })}
                  className={`inline-flex h-10 cursor-pointer items-center rounded-full px-4 text-[13px] font-bold transition-colors duration-200 ${
                    w.ffbInvert
                      ? "border border-[#CCFF00] bg-[#CCFF00] text-[#08090D]"
                      : "border border-[#262B3D] bg-[#F5F7FA]/[0.08] text-[#F5F7FA] hover:border-[#3A4157]"
                  }`}
                >
                  {w.ffbInvert ? "Inverted" : "Invert"}
                </button>
              </div>
              <Hint>
                Hold the rim and press Test: it should pull right for a second, then left. If it pulls left first, switch
                on Invert. The wheel&apos;s overall strength stays in its own software (Moza Pit House, Fanatec control
                panel…); turn its centring spring off there. Damping, friction and inertia set here add to the
                wheel&apos;s own.
              </Hint>
              <MoreSettings label="Fine tuning">
                <AutoGrid min={220} className="gap-x-[18px] gap-y-1">
                  <TuningSlider
                    label="Force curve"
                    value={Math.round(50 * Math.log2(w.ffbCurve))}
                    min={-50}
                    max={50}
                    step={5}
                    format={(v) => (v === 0 ? "Linear" : `${v > 0 ? "+" : ""}${v}`)}
                    hint="Below 0 lifts light forces (belt and gear wheels); above 0 keeps them light and saves the strength for the big loads"
                    onChange={(v) => setWheel({ ffbCurve: 2 ** (v / 50) })}
                  />
                  <TyreSlider
                    label="Minimum force"
                    value={Math.round(w.ffbMinForce * 100)}
                    limits={{ min: 0, max: 20, step: 1 }}
                    format={(v) => (v === 0 ? "Off" : `${v.toFixed(0)} %`)}
                    onChange={(v) => setWheel({ ffbMinForce: v / 100 })}
                  />
                  {w.hidFfb && webHidFfb.offersCondition("friction") ? (
                    <TuningSlider
                      label="Friction"
                      value={Math.round(w.ffbFriction * 100)}
                      min={0}
                      max={100}
                      step={5}
                      format={(v) => (v === 0 ? "Off" : `${v} %`)}
                      hint="A steady drag on the rim, run by the wheel itself. Up to 30 % of its strength"
                      onChange={(v) => setWheel({ ffbFriction: v / 100 })}
                    />
                  ) : null}
                  {w.hidFfb && webHidFfb.offersCondition("inertia") ? (
                    <TuningSlider
                      label="Inertia"
                      value={Math.round(w.ffbInertia * 100)}
                      min={0}
                      max={100}
                      step={5}
                      format={(v) => (v === 0 ? "Off" : `${v} %`)}
                      hint="Weight that resists quick changes of direction, run by the wheel itself. Up to 30 % of its strength"
                      onChange={(v) => setWheel({ ffbInertia: v / 100 })}
                    />
                  ) : null}
                  <TuningSlider
                    label="Smoothing"
                    value={Math.round(w.ffbFilterS * 1000)}
                    min={0}
                    max={50}
                    step={1}
                    format={(v) => (v === 0 ? "0 = raw" : `${v} ms`)}
                    hint="Low-pass filter on the force. 0 = raw"
                    onChange={(v) => setWheel({ ffbFilterS: v / 1000 })}
                  />
                  <TuningSlider
                    label="Downforce compensation"
                    value={Math.round(w.ffbDownforceComp * 100)}
                    min={0}
                    max={100}
                    step={5}
                    format={(v) => (v === 0 ? "Off" : `${v} %`)}
                    hint="Takes the aero load out of the steering weight, so fast corners do not clip. Raise Strength to match"
                    onChange={(v) => setWheel({ ffbDownforceComp: v / 100 })}
                  />
                </AutoGrid>
                <Toggle
                  label="Collision protection"
                  detail="Holds back the force spike of a hit so it never yanks the rim"
                  checked={w.ffbCollisionGuard}
                  onChange={() => setWheel({ ffbCollisionGuard: !w.ffbCollisionGuard })}
                />
              </MoreSettings>
            </>
          ) : (
            <Hint className="text-[13px]!">
              Switch Force Feedback on and click <strong>Connect wheel</strong> to drive your wheel directly over WebHID
              in Chrome/Edge, including the Logitech {LOGITECH_WEBHID_NAMES} (the G920 and G923 for Xbox once Logitech
              G HUB has put them in PC mode) and, untested, the Thrustmaster {THRUSTMASTER_NAMES}. A wheel WebHID cannot
              drive (Logitech G923 for PlayStation, G PRO; Thrustmaster T150, TMX) uses the local bridge on Windows (
              <code className="font-f1-mono text-[12px] font-bold text-[#F5F7FA]">npm run ffb</code>).
            </Hint>
          )}
        </SetupCard>

        <SetupCard title="Telemetry out">
          <Toggle
            label="Send UDP telemetry through the bridge (SimHub, dashboards, bass shakers)"
            checked={w.telemetryOut}
            onChange={() => setWheel({ telemetryOut: !w.telemetryOut })}
          />
          <div className={`flex items-center justify-between gap-3 px-2 ${w.telemetryOut ? "" : "opacity-40"}`}>
            <span className="font-f1-mono text-[11px] font-bold text-[#8E96AA]">UDP port</span>
            <input
              ref={portRef}
              type="number"
              inputMode="numeric"
              min={1024}
              max={65535}
              step={1}
              disabled={!w.telemetryOut}
              value={portText}
              onChange={(e) => {
                setPortText(e.target.value);
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 1024 && n <= 65535) setWheel({ telemetryPort: n });
              }}
              onBlur={() => setPortText(String(w.telemetryPort))}
              className="h-[34px] w-28 rounded-full border border-[#262B3D] bg-[#11131A] px-3 text-right font-f1-mono text-[13px] font-extrabold text-[#F5F7FA] tabular-nums disabled:cursor-not-allowed"
            />
          </div>
          <Hint>
            Needs the bridge running: <span className="font-f1-mono text-[#F5F7FA]">npm run ffb</span>. No wheel
            needed: without one it relays telemetry only.
          </Hint>
          {CLAIMED_TELEMETRY_PORTS[w.telemetryPort] ? (
            <Hint>
              Port {w.telemetryPort} is {CLAIMED_TELEMETRY_PORTS[w.telemetryPort]}: tools listening there will misread
              this JSON. The default is {DEFAULT_TELEMETRY_PORT}.
            </Hint>
          ) : null}
        </SetupCard>

        <SupportedWheels />
      </div>
    </div>
  );
};
