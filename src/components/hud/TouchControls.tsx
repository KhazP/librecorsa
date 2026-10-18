"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  requestTiltPermission,
  resetTouchInput,
  tiltToSteer,
  touchInput,
} from "@/lib/input/touch-input";
import {
  HUD_CYAN,
  HUD_GREEN,
  HUD_PURPLE,
  HUD_RED,
  HUD_SLATE,
  HUD_VOID,
  HUD_VOLT,
  HUD_WHITE,
} from "./hud-format";

/** Finger travel from the touch-down point that gives full steering lock, as a fraction of window width */
const STEER_SPAN_VW = 0.18;

type Analog = "steer" | "throttle" | "brake";
type TiltStatus = "off" | "asking" | "ready" | "denied" | "unsupported";
interface Visual {
  steer: number;
  throttle: number;
  brake: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Safe-area-aware offset from a viewport edge */
const edge = (side: "top" | "right" | "bottom" | "left", px: number) =>
  `calc(env(safe-area-inset-${side}, 0px) + ${px}px)`;

/** Screen orientation angle in degrees, with the legacy window.orientation fallback */
function currentOrientationAngle(): number {
  if (typeof window === "undefined") return 0;
  const screenAngle = window.screen?.orientation?.angle;
  if (typeof screenAngle === "number") return screenAngle;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === "number" ? legacy : 0;
}

interface SteerPadProps {
  value: number;
  onChange: (v: number) => void;
}

/** Horizontal steering slider: the finger's travel from its touch-down point maps to −1..1 */
const SteerPad: React.FC<SteerPadProps> = ({ value, onChange }) => {
  const pid = useRef<number | null>(null);
  const origin = useRef(0);

  useEffect(
    () => () => {
      if (pid.current !== null) onChange(0);
    },
    [onChange],
  );

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (pid.current !== null) return;
    pid.current = e.pointerId;
    origin.current = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
    onChange(0);
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== pid.current) return;
    const span = Math.max(1, window.innerWidth * STEER_SPAN_VW);
    onChange(clamp((e.clientX - origin.current) / span, -1, 1));
  };
  const release = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== pid.current) return;
    pid.current = null;
    onChange(0);
  };

  const knobLeft = `calc(20px + (100% - 40px) * ${((value + 1) / 2).toFixed(4)})`;

  return (
    <div
      role="slider"
      aria-label="Steering"
      aria-valuemin={-100}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className="hud-panel pointer-events-auto touch-none relative h-24 overflow-hidden rounded-lg"
      style={{ width: "42vw", minWidth: 180, maxWidth: 360, touchAction: "none" }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      <span className="hud-label pointer-events-none absolute left-2.5 top-1.5 !text-[9px]">STEER</span>
      <span
        className="font-f1-mono pointer-events-none absolute right-2.5 top-1.5 text-[11px] font-bold tabular-nums"
        style={{ color: HUD_VOLT }}
      >
        {Math.round(value * 100)}
      </span>
      {/* Centre reference */}
      <div className="pointer-events-none absolute bottom-3 left-1/2 top-7 w-px -translate-x-1/2 bg-[#262B3D]" />
      {/* Track */}
      <div className="pointer-events-none absolute inset-x-5 bottom-[38px] h-px bg-[#262B3D]" />
      {/* Knob */}
      <div
        className="pointer-events-none absolute top-[60%] h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
        style={{
          left: knobLeft,
          borderColor: HUD_VOLT,
          backgroundColor: HUD_VOID,
          boxShadow: `0 0 10px ${HUD_VOLT}66`,
        }}
      />
    </div>
  );
};

interface TiltIndicatorProps {
  value: number;
  status: TiltStatus;
  onRecentre: (e: React.PointerEvent<HTMLButtonElement>) => void;
}

const TILT_LABEL: Record<TiltStatus, string> = {
  off: "TILT: TAP TO ENABLE",
  asking: "TILT: ASKING",
  ready: "TILT",
  denied: "TILT DENIED",
  unsupported: "NO TILT SENSOR",
};

/** Tilt-steer readout with a Recentre button that stores the current tilt as the zero offset */
const TiltIndicator: React.FC<TiltIndicatorProps> = ({ value, status, onRecentre }) => {
  const half = Math.abs(value) * 50;
  const fillLeft = value < 0 ? 50 - half : 50;

  return (
    <div
      className="hud-panel pointer-events-auto touch-none flex flex-col gap-1.5 rounded-lg px-2.5 py-2"
      style={{ width: "42vw", minWidth: 180, maxWidth: 360, touchAction: "none" }}
    >
      <div className="flex items-center justify-between">
        <span className="hud-label !text-[9px]">{TILT_LABEL[status]}</span>
        <span className="font-f1-mono text-[11px] font-bold tabular-nums" style={{ color: HUD_VOLT }}>
          {Math.round(value * 100)}
        </span>
      </div>
      <div className="relative h-2.5 overflow-hidden rounded-sm border border-[#262B3D] bg-[#08090D]">
        <div className="absolute inset-y-0 left-1/2 w-px bg-[#8E96AA]" />
        <div
          className="absolute inset-y-0"
          style={{ left: `${fillLeft}%`, width: `${half}%`, backgroundColor: HUD_VOLT }}
        />
      </div>
      <button
        type="button"
        aria-label="Recentre tilt"
        className="pointer-events-auto touch-none rounded border border-[#262B3D] bg-[#08090D] py-1 font-f1-mono text-[11px] font-bold tracking-wider active:scale-95"
        style={{ color: HUD_WHITE, touchAction: "none" }}
        onPointerDown={onRecentre}
      >
        Recentre
      </button>
    </div>
  );
};

interface PedalProps {
  label: string;
  color: string;
  value: number;
  onChange: (v: number) => void;
}

/** Vertical pedal: the finger's height on the pedal (bottom 0 → top 1) is the input */
const Pedal: React.FC<PedalProps> = ({ label, color, value, onChange }) => {
  const pid = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (pid.current !== null) onChange(0);
    },
    [onChange],
  );

  const measure = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return clamp((r.bottom - e.clientY) / Math.max(1, r.height), 0, 1);
  };
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (pid.current !== null) return;
    pid.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    onChange(measure(e));
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== pid.current) return;
    onChange(measure(e));
  };
  const release = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== pid.current) return;
    pid.current = null;
    onChange(0);
  };

  return (
    <div
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className="hud-panel pointer-events-auto touch-none relative overflow-hidden rounded-lg"
      style={{ width: 96, height: 140, borderColor: color, touchAction: "none" }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0"
        style={{
          height: `${value * 100}%`,
          backgroundColor: color,
          boxShadow: value > 0 ? `0 0 14px ${color}` : "none",
        }}
      />
      <span className="hud-label pointer-events-none absolute inset-x-0 top-2 text-center !text-[9px]">
        {label}
      </span>
      <span
        className="font-f1-mono pointer-events-none absolute inset-x-0 bottom-2 text-center text-[13px] font-extrabold tabular-nums"
        style={{ color: value > 0.5 ? HUD_VOID : HUD_WHITE }}
      >
        {Math.round(value * 100)}
      </span>
    </div>
  );
};

interface TapButtonProps {
  label: string;
  ariaLabel?: string;
  color: string;
  /** 64px wide instead of round 48px */
  wide?: boolean;
  /** 36px tall instead of 48px */
  small?: boolean;
  onTap: () => void;
}

/** One-shot button: fires on pointer down */
const TapButton: React.FC<TapButtonProps> = ({ label, ariaLabel, color, wide, small, onTap }) => (
  <button
    type="button"
    aria-label={ariaLabel ?? label}
    className="hud-panel pointer-events-auto touch-none flex items-center justify-center rounded-full border font-f1-mono text-[13px] font-extrabold tracking-wider active:scale-95"
    style={{
      width: wide ? 64 : 48,
      height: small ? 36 : 48,
      color,
      borderColor: color,
      touchAction: "none",
    }}
    onPointerDown={(e) => {
      e.preventDefault();
      onTap();
    }}
  >
    {label}
  </button>
);

export interface TouchControlsProps {
  /** Steer from device tilt instead of the on-screen slider */
  tiltSteer: boolean;
  /** Tilt angle that gives full steering lock, in degrees */
  tiltRangeDeg: number;
  onPause: () => void;
  onCycleCamera: () => void;
}

/**
 * Landscape-phone touch overlay: steering (slider or tilt), brake and throttle pedals, shift,
 * boost and aero buttons, plus Menu and Cam. Writes into the `touchInput` singleton.
 */
export const TouchControls: React.FC<TouchControlsProps> = ({
  tiltSteer,
  tiltRangeDeg,
  onPause,
  onCycleCamera,
}) => {
  const [vis, setVis] = useState<Visual>({ steer: 0, throttle: 0, brake: 0 });
  const [tiltStatus, setTiltStatus] = useState<TiltStatus>("off");

  const live = useRef<Visual>({ steer: 0, throttle: 0, brake: 0 });
  const frame = useRef<number | null>(null);
  const tiltOffset = useRef({ beta: 0, gamma: 0 });
  const tiltNeedsZero = useRef(true);
  const requesting = useRef(false);

  /** Coalesce visual updates into one React render per animation frame */
  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const l = live.current;
      setVis((p) =>
        p.steer === l.steer && p.throttle === l.throttle && p.brake === l.brake ? p : { ...l },
      );
    });
  }, []);

  const write = useCallback(
    (key: Analog, value: number) => {
      live.current[key] = value;
      touchInput[key] = value;
      schedule();
    },
    [schedule],
  );

  const setSteer = useCallback((v: number) => write("steer", v), [write]);
  const setThrottle = useCallback((v: number) => write("throttle", v), [write]);
  const setBrake = useCallback((v: number) => write("brake", v), [write]);

  /** Mark the overlay active for the game loop; clear everything on unmount */
  useEffect(() => {
    touchInput.active = true;
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      resetTouchInput();
    };
  }, []);

  /** Ask for tilt permission (iOS needs a user gesture); guarded so overlapping taps ask once */
  const enableTilt = useCallback(async () => {
    if (requesting.current) return;
    if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) {
      setTiltStatus("unsupported");
      return;
    }
    requesting.current = true;
    setTiltStatus("asking");
    const ok = await requestTiltPermission();
    requesting.current = false;
    setTiltStatus(ok ? "ready" : "denied");
  }, []);

  /** Until tilt is enabled, the first tap anywhere requests permission */
  useEffect(() => {
    if (!tiltSteer || tiltStatus !== "off") return;
    const onFirstTap = () => {
      void enableTilt();
    };
    window.addEventListener("pointerdown", onFirstTap, { capture: true, once: true });
    return () => window.removeEventListener("pointerdown", onFirstTap, { capture: true });
  }, [tiltSteer, tiltStatus, enableTilt]);

  /** Tilt listener: the first sample after enabling (or Recentre) becomes the zero offset */
  useEffect(() => {
    if (!tiltSteer) return;
    tiltNeedsZero.current = true;
    const onOrientation = (ev: DeviceOrientationEvent) => {
      if (tiltNeedsZero.current) {
        tiltOffset.current = { beta: ev.beta ?? 0, gamma: ev.gamma ?? 0 };
        tiltNeedsZero.current = false;
      }
      const off = tiltOffset.current;
      setSteer(
        tiltToSteer(
          {
            alpha: ev.alpha,
            beta: ev.beta === null ? null : ev.beta - off.beta,
            gamma: ev.gamma === null ? null : ev.gamma - off.gamma,
          },
          currentOrientationAngle(),
          tiltRangeDeg,
        ),
      );
    };
    window.addEventListener("deviceorientation", onOrientation);
    return () => {
      window.removeEventListener("deviceorientation", onOrientation);
      setSteer(0);
    };
  }, [tiltSteer, tiltRangeDeg, setSteer]);

  const onRecentre = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    tiltNeedsZero.current = true;
    if (tiltStatus !== "ready") void enableTilt();
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-30 touch-none select-none">
      {/* Top-left: Menu and Cam */}
      <div
        className="absolute flex gap-2"
        style={{ top: edge("top", 8), left: edge("left", 12) }}
      >
        <TapButton label="Menu" color={HUD_SLATE} wide small onTap={onPause} />
        <TapButton label="Cam" color={HUD_SLATE} wide small onTap={onCycleCamera} />
      </div>

      {/* Bottom-left: steering */}
      <div className="absolute" style={{ left: edge("left", 16), bottom: edge("bottom", 12) }}>
        {tiltSteer ? (
          <TiltIndicator value={vis.steer} status={tiltStatus} onRecentre={onRecentre} />
        ) : (
          <SteerPad value={vis.steer} onChange={setSteer} />
        )}
      </div>

      {/* Bottom-right: shift / boost / aero buttons above the pedals */}
      <div
        className="absolute flex flex-col items-end gap-2"
        style={{ right: edge("right", 16), bottom: edge("bottom", 12) }}
      >
        <div className="flex gap-2">
          <TapButton
            label="▲"
            ariaLabel="Shift up"
            color={HUD_VOLT}
            onTap={() => {
              touchInput.shiftUp = true;
            }}
          />
          <TapButton
            label="▼"
            ariaLabel="Shift down"
            color={HUD_VOLT}
            onTap={() => {
              touchInput.shiftDown = true;
            }}
          />
          <TapButton
            label="BOOST"
            color={HUD_PURPLE}
            wide
            onTap={() => {
              touchInput.boost = true;
            }}
          />
          <TapButton
            label="X/Z"
            ariaLabel="Active aero"
            color={HUD_CYAN}
            onTap={() => {
              touchInput.aero = true;
            }}
          />
        </div>
        <div className="flex gap-2">
          <Pedal label="BRAKE" color={HUD_RED} value={vis.brake} onChange={setBrake} />
          <Pedal label="THROTTLE" color={HUD_GREEN} value={vis.throttle} onChange={setThrottle} />
        </div>
      </div>
    </div>
  );
};
