"use client";

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PAD_ACTIONS, type PadAction } from "@/lib/input/bindings";
import {
  autoConfigureWheel,
  CAR_WHEEL_LOCK_DEG,
  connectedPads,
  emptyWheelButtons,
  findPad,
  newlyPressedButton,
  padDisplayName,
  pedalValue,
  snapshotAxes,
  snapshotButtons,
  type PadLike,
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
import { type FfbStatus, wheelFfb } from "@/lib/input/wheel-ffb";
import { Choice, TyreSlider } from "@/components/hud/PauseMenu";
import { suspendMenuNav, useGamepads, type PadState } from "../useMenuNav";
import { Card, CenterMeter, Meter, SectionLabel } from "../menu-ui";
import type { SetupStepProps } from "./types";

type CalTarget = "steer" | "throttle" | "brake";

const STEER_DETECT = 0.12;
const PEDAL_DETECT = 0.3;

/** The axis that moved furthest from the resting snapshot, skipping axes already bound elsewhere */
function bestChange(
  base: AxisSnapshot,
  pads: readonly PadLike[],
  excluded: (padId: string, axis: number) => boolean
): { padId: string; axis: number; base: number; value: number; delta: number } | null {
  let best: { padId: string; axis: number; base: number; value: number; delta: number } | null = null;
  for (const pad of pads) {
    const b = base.get(pad.id);
    if (!b) continue;
    pad.axes.forEach((value, axis) => {
      if (excluded(pad.id, axis)) return;
      const delta = value - (b[axis] ?? 0);
      if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { padId: pad.id, axis, base: b[axis] ?? 0, value, delta };
    });
  }
  return best;
}

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
  const [stage, setStage] = useState<"rest" | "act">("rest");
  const [meter, setMeter] = useState(0);
  const baseline = useRef<AxisSnapshot | null>(null);
  const locked = useRef<{ padId: string; axis: number; base: number; peak: number } | null>(null);
  // Reports once: a frame can still run after the result, before this calibrator unmounts
  const reported = useRef(false);
  const heldSince = useRef(0);

  useEffect(() => {
    if (stage !== "act") return;
    let raf = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const pads = connectedPads();
      const base = baseline.current;
      if (!base || reported.current) return;
      const excluded = (padId: string, axis: number) => exclude.some((e) => e.padId === padId && e.axis === axis);

      if (target === "steer") {
        const best = bestChange(base, pads, excluded);
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
        const found = bestChange(base, pads, excluded);
        if (found && Math.abs(found.delta) > PEDAL_DETECT) {
          locked.current = { padId: found.padId, axis: found.axis, base: found.base, peak: found.value };
        }
        setMeter(found ? Math.min(1, Math.abs(found.delta) / 1.6) : 0);
        return;
      }
      const l = locked.current;
      const value = findPad(pads, l.padId)?.axes[l.axis] ?? l.base;
      if (Math.abs(value - l.base) > Math.abs(l.peak - l.base)) l.peak = value;
      const peakDelta = Math.abs(l.peak - l.base);
      setMeter(Math.min(1, Math.abs(value - l.base) / Math.max(0.5, peakDelta)));
      if (peakDelta > 0.5 && Math.abs(value - l.base) < peakDelta * 0.25) {
        reported.current = true;
        onPedal(target, { padId: l.padId, axis: l.axis, idle: l.base, full: l.peak });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stage, target, exclude, onSteer, onPedal]);

  return (
    <div className="mt-2 rounded border border-[#E10600]/60 bg-[#E10600]/10 p-3">
      <p className="font-f1-italic text-sm uppercase">{stage === "rest" ? PROMPTS[target].rest : PROMPTS[target].act}</p>
      {stage === "act" ? (
        <span className="mt-2 block h-1.5 overflow-hidden rounded bg-black/50">
          <span className="block h-full bg-[#E10600] transition-[width]" style={{ width: `${Math.round(meter * 100)}%` }} />
        </span>
      ) : null}
      <div className="mt-2 flex gap-2">
        {stage === "rest" ? (
          <button
            type="button"
            onClick={() => {
              baseline.current = snapshotAxes(connectedPads());
              locked.current = null;
              heldSince.current = 0;
              setStage("act");
            }}
            className="cursor-pointer rounded bg-[#E10600] px-3 py-1 font-f1-mono text-[11px] font-bold uppercase text-white"
          >
            Continue
          </button>
        ) : null}
        <button
          type="button"
          onClick={onCancel}
          className="cursor-pointer rounded bg-black/40 px-3 py-1 font-f1-mono text-[11px] font-bold uppercase text-zinc-300 hover:bg-white/10"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

/** Next button press on any device (wheel rim, button box, shifter) */
function useAnyButtonCapture(active: boolean, onButton: (b: ButtonBinding) => void, onCancel: () => void) {
  useEffect(() => {
    if (!active) return;
    const resume = suspendMenuNav();
    let prev = snapshotButtons(connectedPads());
    let raf = 0;
    const poll = () => {
      raf = requestAnimationFrame(poll);
      const pads = connectedPads();
      const hit = newlyPressedButton(prev, pads);
      prev = snapshotButtons(pads);
      if (hit) onButton(hit);
    };
    raf = requestAnimationFrame(poll);
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, { capture: true });
      const wait = () => {
        if (connectedPads().some((p) => p.buttons.some((b) => b.pressed))) requestAnimationFrame(wait);
        else resume();
      };
      wait();
    };
  }, [active, onButton, onCancel]);
}

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

/** Where the force-feedback bridge stands, and how to start it when it is not running */
function FfbBridgeStatus({ status }: { status: FfbStatus }) {
  if (status.connection === "replaced") {
    return (
      <p className="mb-2 rounded bg-[#FFD700]/10 px-2.5 py-1.5 font-f1-mono text-[11px] leading-relaxed text-[#FFD700]">
        Another tab took over the wheel. Close it, or switch force feedback off and on here to take it back.
      </p>
    );
  }
  if (status.connection === "unreachable") {
    return (
      <p className="mb-2 rounded bg-[#FFD700]/10 px-2.5 py-1.5 font-f1-mono text-[11px] leading-relaxed text-[#FFD700]">
        Bridge not running. In a terminal in the project folder run <code className="text-white">npm run ffb</code>{" "}
        (Windows) and keep it open; this page connects within a few seconds.
      </p>
    );
  }
  const [color, text] =
    status.connection !== "connected"
      ? ["#A1A1AA", "Looking for the bridge on this PC…"]
      : status.error
        ? ["#FFD700", status.error]
        : status.device
          ? ["#22C55E", `Driving ${status.device}`]
          : ["#A1A1AA", "Bridge connected · waiting for the wheel…"];
  return (
    <p className="mb-2 font-f1-mono text-[11px] font-bold" style={{ color }}>
      {text}
    </p>
  );
}

/** Wheel: type, steering calibration and rotation, pedal calibration, button mapping */
export const WheelStep: React.FC<SetupStepProps> = ({ settings, onChangeSettings }) => {
  const pads = useGamepads();
  const w = settings.wheel;
  const [calibrating, setCalibrating] = useState<CalTarget | null>(null);
  const [calAllSeq, setCalAllSeq] = useState(false);
  const [capturing, setCapturing] = useState<PadAction | null>(null);
  const [customRotation, setCustomRotation] = useState(false);
  const ffb = useSyncExternalStore(wheelFfb.subscribe, wheelFfb.getStatus, wheelFfb.getStatus);
  const ffbReady = ffb.connection === "connected" && ffb.device !== null && ffb.error === null;

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

  const calAllRef = useRef(calAllSeq);
  calAllRef.current = calAllSeq;

  const calibratingRef = useRef(calibrating);
  calibratingRef.current = calibrating;
  const onSteer = useCallback((steer: AxisBinding) => {
    if (calibratingRef.current !== "steer") return;
    setWheel({ steer });
    if (calAllRef.current) {
      setCalibrating("throttle");
    } else {
      setCalibrating(null);
    }
  }, [setWheel]);
  const onPedal = useCallback(
    (target: "throttle" | "brake", b: PedalBinding) => {
      // The result belongs to the calibrator that measured it: a late frame from the throttle step must never land on
      // the brake once the wizard has moved on (that bound both pedals to the throttle's axis)
      if (target !== calibratingRef.current) return;
      if (target === "throttle") {
        setWheel({ throttle: b });
        if (calAllRef.current) {
          setCalibrating("brake");
          return;
        }
      }
      if (target === "brake") {
        setWheel({ brake: b });
        setCalAllSeq(false);
      }
      setCalibrating(null);
    },
    [setWheel]
  );
  const onCancelCal = useCallback(() => {
    setCalAllSeq(false);
    setCalibrating(null);
  }, []);

  const onButton = useCallback(
    (b: ButtonBinding) => {
      if (!capturing) return;
      onChangeSettings((s) => {
        const buttons = { ...s.wheel.buttons };
        for (const k of Object.keys(buttons) as PadAction[]) {
          const cur = buttons[k];
          if (cur && cur.padId === b.padId && cur.button === b.button) buttons[k] = null;
        }
        buttons[capturing] = b;
        return { ...s, wheel: { ...s.wheel, buttons } };
      });
      setCapturing(null);
    },
    [capturing, onChangeSettings]
  );
  const onCancelCapture = useCallback(() => setCapturing(null), []);
  useAnyButtonCapture(capturing !== null, onButton, onCancelCapture);

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
    <div className="border-b border-white/5 py-2 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <span className="font-f1-italic text-[14px] uppercase">{label}</span>
        <span className="flex items-center gap-2">
          <span className="font-f1-mono text-[11px] text-zinc-500">
            {bound ? `${shortPad(bound.padId)} · axis ${bound.axis}` : "not set"}
          </span>
          <button
            type="button"
            disabled={calibrating !== null && calibrating !== target}
            onClick={() => {
              setCalAllSeq(false);
              setCalibrating(calibrating === target ? null : target);
            }}
            className="cursor-pointer rounded bg-white/90 px-2 py-1 font-f1-mono text-[11px] font-bold uppercase text-[#111] hover:bg-white disabled:opacity-30"
          >
            {bound ? "Recalibrate" : "Calibrate"}
          </button>
        </span>
      </div>
      {calibrating === target ? (
        <AxisCalibrator key={target} target={target} exclude={exclude} onSteer={onSteer} onPedal={onPedal} onCancel={onCancelCal} />
      ) : bound ? (
        <div className="mt-1.5">{live}</div>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <SectionLabel>Wheel base</SectionLabel>
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
              <div className="font-f1-italic text-sm uppercase">{t.title}</div>
              <div className="font-f1-mono text-[11px] opacity-75">{t.sub}</div>
            </Choice>
          ))}
        </div>
      </Card>

      <Card>
        <div className="mb-2 flex items-center justify-between gap-2">
          <SectionLabel className="!mb-0">Force feedback</SectionLabel>
          <button
            type="button"
            onClick={() => setWheel({ ffbEnabled: !w.ffbEnabled })}
            className={`cursor-pointer rounded px-2.5 py-1 font-f1-mono text-[11px] font-bold uppercase ${
              w.ffbEnabled ? "bg-[#22C55E] text-[#0B0B10]" : "bg-white/10 text-zinc-300 hover:bg-white/15"
            }`}
          >
            {w.ffbEnabled ? "On" : "Off"}
          </button>
        </div>
        {w.ffbEnabled ? (
          <>
            <FfbBridgeStatus status={ffb} />
            <TyreSlider
              label="Strength"
              value={Math.round(w.ffbGain * 100)}
              limits={{ min: 0, max: 200, step: 5 }}
              format={(v) => `${v.toFixed(0)} %`}
              onChange={(v) => setWheel({ ffbGain: v / 100 })}
            />
            <TyreSlider
              label="Minimum force"
              value={Math.round(w.ffbMinForce * 100)}
              limits={{ min: 0, max: 20, step: 1 }}
              format={(v) => (v === 0 ? "Off" : `${v.toFixed(0)} %`)}
              onChange={(v) => setWheel({ ffbMinForce: v / 100 })}
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
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!ffbReady}
                onClick={() => wheelFfb.test(w.ffbInvert)}
                className="cursor-pointer rounded bg-white/90 px-2.5 py-1 font-f1-mono text-[11px] font-bold uppercase text-[#111] hover:bg-white disabled:cursor-default disabled:opacity-30"
              >
                Test direction
              </button>
              <button
                type="button"
                onClick={() => setWheel({ ffbInvert: !w.ffbInvert })}
                className={`cursor-pointer rounded px-2.5 py-1 font-f1-mono text-[11px] font-bold uppercase ${
                  w.ffbInvert ? "bg-[#E10600] text-white" : "bg-white/10 text-zinc-300 hover:bg-white/15"
                }`}
              >
                {w.ffbInvert ? "Inverted" : "Invert"}
              </button>
            </div>
            <p className="mt-2 font-f1-mono text-[11px] leading-relaxed text-zinc-500">
              Hold the rim and press Test: it should pull right for a second, then left. If it pulls left first,
              switch on Invert. The wheel&apos;s overall strength and damping stay in its own software (Moza Pit House, Fanatec
              control panel…); turn its centring spring off there.
            </p>
          </>
        ) : (
          <p className="font-f1-mono text-[11px] leading-relaxed text-zinc-500">
            A browser cannot play force feedback by itself. Switch this on and run the small bridge program on this PC
            for the car&apos;s real steering torque. Without it, set a light spring and damper in your wheel software
            (Moza Pit House, Fanatec control panel, Simucube Tuner…) so the wheel self-centres.
          </p>
        )}
      </Card>

      <Card>
        <div className="mb-2 flex items-center justify-between gap-2">
          <SectionLabel className="!mb-0">Steering</SectionLabel>
          <button
            type="button"
            onClick={() => {
              setCalAllSeq(true);
              setCalibrating("steer");
            }}
            className="cursor-pointer rounded bg-[#E10600] px-2.5 py-1 font-f1-mono text-[11px] font-bold uppercase text-white hover:bg-[#ff1a14]"
          >
            Calibrate all
          </button>
        </div>
        {pads.length === 0 ? (
          <p className="mb-2 font-f1-mono text-[12px] text-zinc-400">No wheel found yet. Press a button on the wheel to wake it up.</p>
        ) : (!w.throttle || !w.brake) ? (
          <p className="mb-2 rounded bg-[#FFD700]/10 px-2.5 py-1.5 font-f1-mono text-[11px] text-[#FFD700]">
            Pedals not set up yet: press <strong>Calibrate all</strong> to set steering, throttle and brake in one go.
          </p>
        ) : null}
        {calRow(
          "steer",
          "Steering axis",
          w.steer,
          steer ? (
            <CenterMeter label="Wheel" value={steer.norm} detail={`${steer.deg >= 0 ? "" : "−"}${Math.abs(Math.round(steer.deg))}°`} />
          ) : (
            <p className="font-f1-mono text-[11px] text-zinc-500">Device not connected</p>
          )
        )}
        <div className="mt-3">
          <div className="mb-1.5 font-f1-italic text-[14px] uppercase">Rotation · lock to lock</div>
          <div className="grid grid-cols-5 gap-2">
            {WHEEL_ROTATION_PRESETS.map((deg) => (
              <Choice
                key={deg}
                active={!customRotation && w.rotationDeg === deg}
                onClick={() => {
                  setCustomRotation(false);
                  setWheel({ rotationDeg: deg });
                }}
              >
                <div className="text-center font-f1-mono text-xs font-bold">{deg}°</div>
              </Choice>
            ))}
            <Choice
              active={customRotation || !(WHEEL_ROTATION_PRESETS as readonly number[]).includes(w.rotationDeg)}
              onClick={() => setCustomRotation(true)}
            >
              <div className="text-center font-f1-mono text-xs font-bold">Custom</div>
            </Choice>
          </div>
          {customRotation || !(WHEEL_ROTATION_PRESETS as readonly number[]).includes(w.rotationDeg) ? (
            <TyreSlider
              label="Rotation"
              value={w.rotationDeg}
              limits={{ min: 180, max: 2520, step: 10 }}
              format={(v) => `${v.toFixed(0)}°`}
              onChange={(v) => setWheel({ rotationDeg: v })}
            />
          ) : null}
          <p className="mt-2 font-f1-mono text-[11px] leading-relaxed text-zinc-500">
            Match the rotation set in your wheel&apos;s driver. Steering is 1:1 with the car&apos;s {CAR_WHEEL_LOCK_DEG}°
            wheel: the base turns {Math.round(CAR_WHEEL_LOCK_DEG / 2)}° each way, the rest is a soft lock.
          </p>
        </div>
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
      </Card>

      <Card>
        <SectionLabel>Pedals</SectionLabel>
        {calRow(
          "throttle",
          "Throttle",
          w.throttle,
          throttle !== null ? <Meter label="Throttle" value={throttle} /> : <p className="font-f1-mono text-[11px] text-zinc-500">Device not connected</p>
        )}
        {calRow(
          "brake",
          "Brake",
          w.brake,
          brake !== null ? <Meter label="Brake" value={brake} color="#E10600" /> : <p className="font-f1-mono text-[11px] text-zinc-500">Device not connected</p>
        )}
        <TyreSlider
          label="Brake curve"
          value={w.brakeGamma}
          limits={{ min: 0.5, max: 2.5, step: 0.1 }}
          format={(v) => (Math.abs(v - 1) < 0.05 ? "Linear" : v > 1 ? `Progressive ${v.toFixed(1)}` : `Aggressive ${v.toFixed(1)}`)}
          onChange={(v) => setWheel({ brakeGamma: v })}
        />
        <p className="font-f1-mono text-[11px] text-zinc-500">
          Load-cell brakes usually feel best linear; potentiometer pedals often like 1.3–1.6. A clutch is not needed.
        </p>
      </Card>

      <Card>
        <div className="mb-2 flex items-center justify-between">
          <SectionLabel className="!mb-0">Buttons · paddles, rim, button box</SectionLabel>
          <button
            type="button"
            onClick={() => setWheel({ buttons: emptyWheelButtons() })}
            className="cursor-pointer rounded bg-black/40 px-2 py-1 font-f1-mono text-[11px] font-bold uppercase text-zinc-300 hover:bg-white/10"
          >
            Clear
          </button>
        </div>
        <div className="grid gap-x-6 sm:grid-cols-2">
          {PAD_ACTIONS.map(({ id, label }) => {
            const listening = capturing === id;
            const b = w.buttons[id];
            return (
              <div key={id} className="flex items-center justify-between gap-3 border-b border-white/5 py-1.5">
                <span className="font-f1-italic text-[14px] uppercase">{label}</span>
                <button
                  type="button"
                  onClick={() => setCapturing(listening ? null : id)}
                  className={`min-w-[5.5rem] cursor-pointer rounded px-2 py-1 font-f1-mono text-[11px] font-bold ${
                    listening
                      ? "animate-pulse bg-[#E10600] text-white"
                      : b
                        ? "bg-white/90 text-[#111] hover:bg-white"
                        : "bg-black/40 text-zinc-500 hover:bg-white/10"
                  }`}
                >
                  {listening ? "PRESS…" : b ? `Button ${b.button}` : "+"}
                </button>
              </div>
            );
          })}
        </div>
        <p className="mt-2 font-f1-mono text-[11px] text-zinc-500">
          {capturing ? "Press a button on any device · Esc cancels" : "Gear paddles and a pause button are the essentials."}
        </p>
      </Card>
    </div>
  );
};
