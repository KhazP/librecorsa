"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  requestTiltPermission,
  resetTouchInput,
  tiltToSteer,
  touchInput,
} from "@/lib/input/touch-input";
import { Icon } from "@/components/ui/icons/Icon";
import { HUD_BRAKE, HUD_GLASS, HUD_INFO, HUD_LBL, HUD_SLATE, HUD_THROTTLE, HUD_VOID, HUD_VOLT, HUD_WHITE } from "./hud-format";
import { useHudMode } from "./hud-mode";

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

/**
 * Width of the steering / tilt card: on a portrait phone it ends a gap short of the pedal column
 * (16 px edges, two 80 px pedals and their 12 px gap, 12 px between); on a landscape phone it stays
 * a thumb's sweep wide instead of taking a third of the screen
 */
const STICK_WIDTH = "w-[min(clamp(200px,38vw,400px),calc(100vw-216px))] phone:w-[min(clamp(180px,30vw,280px),calc(100vw-216px))]";

/** Steering knob diameter (px) */
const KNOB = 52;
/** The HUD glass card the steering / tilt controls sit on */
const STICK_CARD = `rounded-lc-sheet ${HUD_GLASS}`;
/** The HUD label (Steer, Brake…) */
const LABEL = HUD_LBL;

/** Safe-area-aware offset from a viewport edge */
const edge = (side: "top" | "right" | "bottom" | "left", px: number) =>
  `calc(env(safe-area-inset-${side}, 0px) + ${px}px)`;

/** True where the browser asks the player before it sends tilt (iOS); elsewhere tilt simply arrives */
function tiltNeedsPermission(): boolean {
  return (
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof (DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission === "function"
  );
}

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
  /** Hidden under the pause menu or a replay: a finger still down is let go */
  suspended: boolean;
}

/** Horizontal steering slider: the finger's travel from its touch-down point maps to −1..1 */
const SteerPad: React.FC<SteerPadProps> = ({ value, onChange, suspended }) => {
  const pid = useRef<number | null>(null);
  const origin = useRef(0);

  useEffect(() => {
    if (!suspended) return;
    pid.current = null;
    onChange(0);
  }, [suspended, onChange]);
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

  const frac = ((value + 1) / 2).toFixed(4);
  const knobLeft = `calc(${KNOB / 2}px + (100% - ${KNOB}px) * ${frac})`;
  const fillWidth = `calc((100% - ${KNOB}px) * ${(Math.abs(value) / 2).toFixed(4)})`;

  return (
    <div
      role="slider"
      aria-label="Steering"
      aria-valuemin={-100}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className={`${STICK_CARD} ${STICK_WIDTH} pointer-events-auto touch-none relative flex flex-col gap-2.5 overflow-hidden px-4 pt-3.5 pb-4.5 phone:gap-1.5 phone:pt-2.5 phone:pb-3`}
      style={{ touchAction: "none" }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      <div className="pointer-events-none flex items-center justify-between">
        <span className={LABEL}>Steer</span>
        <span className="lc-data text-[14px] text-lc-chalk">{Math.round(value * 100)}</span>
      </div>
      <div className="pointer-events-none relative h-14 phone:h-11">
        {/* Track */}
        <span className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-lc-titanium" />
        {/* Fill from the centre to the knob */}
        <span
          className="absolute top-1/2 h-1.5 -translate-y-1/2"
          style={{
            width: fillWidth,
            backgroundColor: HUD_VOLT,
            ...(value < 0
              ? { right: "50%", borderRadius: "999px 0 0 999px" }
              : { left: "50%", borderRadius: "0 999px 999px 0" }),
          }}
        />
        {/* Centre reference */}
        <span className="absolute inset-y-2 left-1/2 w-0.5 -translate-x-1/2 bg-lc-chalk/40" />
        {/* Knob */}
        <span
          className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] phone:scale-[0.85]"
          style={{
            left: knobLeft,
            width: KNOB,
            height: KNOB,
            borderColor: HUD_VOLT,
            backgroundColor: HUD_VOID,
          }}
        />
      </div>
    </div>
  );
};

interface TiltIndicatorProps {
  value: number;
  status: TiltStatus;
  onRecentre: (e: React.PointerEvent<HTMLButtonElement>) => void;
  /** The finger leaving Recentre: asks for tilt again while it is off or was refused */
  onRecentreRelease: () => void;
}

const TILT_LABEL: Record<TiltStatus, string> = {
  off: "TILT: TAP TO ENABLE",
  asking: "TILT: ASKING",
  ready: "TILT",
  denied: "TILT DENIED",
  unsupported: "NO TILT SENSOR",
};

/** Tilt-steer readout with a Recentre button that stores the current tilt as the zero offset */
const TiltIndicator: React.FC<TiltIndicatorProps> = ({ value, status, onRecentre, onRecentreRelease }) => {
  const half = Math.abs(value) * 50;
  const fillLeft = value < 0 ? 50 - half : 50;

  return (
    <div
      className={`${STICK_CARD} ${STICK_WIDTH} pointer-events-auto touch-none flex flex-col gap-2.5 px-4 pt-3.5 pb-4 phone:gap-2 phone:pt-2.5 phone:pb-3`}
      style={{ touchAction: "none" }}
    >
      <div className="flex items-center justify-between">
        <span className={LABEL}>{TILT_LABEL[status]}</span>
        <span className="lc-data text-[14px] text-lc-chalk">{Math.round(value * 100)}</span>
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-lc-titanium">
        <div
          className="absolute inset-y-0 rounded-full"
          style={{ left: `${fillLeft}%`, width: `${half}%`, backgroundColor: HUD_VOLT }}
        />
        <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-lc-chalk/40" />
      </div>
      <button
        type="button"
        aria-label="Recentre tilt"
        className="pointer-events-auto touch-none h-11 rounded-full border border-lc-line bg-lc-carbon text-[14px] font-bold active:scale-95"
        style={{ color: HUD_WHITE, touchAction: "none" }}
        onPointerDown={onRecentre}
        onPointerUp={onRecentreRelease}
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
  /** Hidden under the pause menu or a replay: a finger still down is let go */
  suspended: boolean;
}

/** Vertical pedal: the finger's height on the pedal (bottom 0 → top 1) is the input */
const Pedal: React.FC<PedalProps> = ({ label, color, value, onChange, suspended }) => {
  const pid = useRef<number | null>(null);

  useEffect(() => {
    if (!suspended) return;
    pid.current = null;
    onChange(0);
  }, [suspended, onChange]);

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
      className="pointer-events-auto touch-none relative flex h-37.5 w-25 flex-col justify-between overflow-hidden rounded-lc-sheet border-2 bg-lc-void/74 p-3 backdrop-blur-[14px] max-sm:portrait:w-20 short:w-22 phone:h-29 phone:rounded-lc-card"
      style={{ borderColor: color, touchAction: "none" }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      {/* The pedal's travel, scaled from the bottom (transform only) */}
      <div
        className="pointer-events-none absolute inset-0 origin-bottom"
        style={{ transform: `scaleY(${value})`, backgroundColor: color }}
      />
      <span
        className={`${LABEL} pointer-events-none relative`}
        style={{ color: value > 0.82 ? HUD_VOID : color }}
      >
        {label}
      </span>
      <span
        className="lc-data pointer-events-none relative text-[15px]"
        style={{ color: value > 0.14 ? HUD_VOID : HUD_WHITE }}
      >
        {Math.round(value * 100)}
      </span>
    </div>
  );
};

interface TapButtonProps {
  label: string;
  ariaLabel?: string;
  /** Ring colour (and text colour unless `textColor` is set) */
  color: string;
  textColor?: string;
  /** 84px wide pill instead of a round 56px button */
  wide?: boolean;
  /** Frosted text pill (Menu / Cam) instead of a coloured ring */
  small?: boolean;
  /** Drawn instead of the label text (the label stays as the accessible name) */
  icon?: React.ReactNode;
  onTap: () => void;
}

/** One-shot button: fires on pointer down */
const TapButton: React.FC<TapButtonProps> = ({ label, ariaLabel, color, textColor, wide, small, icon, onTap }) => (
  <button
    type="button"
    aria-label={ariaLabel ?? label}
    className={`pointer-events-auto touch-none flex items-center justify-center rounded-full active:scale-95 ${
      small
        ? `h-11 min-w-18 px-4 text-[14px] font-bold ${HUD_GLASS}`
        : `lc-chip-text h-14 border-2 bg-lc-void/74 text-[13px] backdrop-blur-[14px] phone:h-12 ${wide ? "w-21 phone:w-18" : "w-14 phone:w-12"}`
    }`}
    style={{
      color: small ? HUD_WHITE : (textColor ?? color),
      borderColor: small ? undefined : color,
      touchAction: "none",
    }}
    onPointerDown={(e) => {
      e.preventDefault();
      onTap();
    }}
  >
    {icon ?? label}
  </button>
);

/** The shift buttons' arrows: the kit's shift icons */
const ShiftArrow: React.FC<{ up?: boolean }> = ({ up }) => <Icon name={up ? "shiftUp" : "shiftDown"} size="md" />;

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
  // The one source for tilt: the label shows it and the orientation listener only steers while it is "ready".
  // `statusRef` mirrors it for the same-event guard (a first tap on Recentre reaches both tap handlers before a render)
  const [tiltStatus, setTiltStatusState] = useState<TiltStatus>("off");
  const statusRef = useRef<TiltStatus>("off");
  const setTiltStatus = useCallback((s: TiltStatus) => {
    statusRef.current = s;
    setTiltStatusState(s);
  }, []);
  // Paused or in a replay the overlay stays mounted (tilt keeps its permission) but drives nothing
  const suspended = useHudMode() === "hidden";

  const live = useRef<Visual>({ steer: 0, throttle: 0, brake: 0 });
  const frame = useRef<number | null>(null);
  const tiltOffset = useRef({ beta: 0, gamma: 0 });
  const tiltNeedsZero = useRef(true);

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

  /** Mark the overlay active for the game loop while it is shown; clear everything when hidden or unmounted */
  useEffect(() => {
    if (suspended) {
      live.current = { steer: 0, throttle: 0, brake: 0 };
      resetTouchInput();
      schedule();
    } else {
      touchInput.active = true;
    }
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      resetTouchInput();
    };
  }, [suspended, schedule]);

  /** Ask for tilt permission (iOS needs a user gesture); a request already under way, or granted, is not repeated */
  const enableTilt = useCallback(async () => {
    if (statusRef.current === "asking" || statusRef.current === "ready") return;
    if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) {
      setTiltStatus("unsupported");
      return;
    }
    setTiltStatus("asking");
    const ok = await requestTiltPermission();
    setTiltStatus(ok ? "ready" : "denied");
  }, [setTiltStatus]);

  /** Where no prompt is needed (Android), tilt is ready at once; with no sensor API it is unsupported */
  useEffect(() => {
    if (!tiltSteer || statusRef.current !== "off") return;
    if (!("DeviceOrientationEvent" in window)) setTiltStatus("unsupported");
    else if (!tiltNeedsPermission()) setTiltStatus("ready");
  }, [tiltSteer, setTiltStatus]);

  /**
   * Until tilt is enabled, the first tap anywhere requests permission (not taps on the pause menu), as the finger
   * lifts: iOS only shows its prompt to a request made inside a user gesture, and a touch's pointerdown is not one (its
   * pointerup is). Asked on the press, iOS refused it without asking and tilt never came on.
   */
  useEffect(() => {
    if (!tiltSteer || tiltStatus !== "off" || suspended) return;
    const onFirstTap = () => {
      void enableTilt();
    };
    window.addEventListener("pointerup", onFirstTap, { capture: true, once: true });
    return () => window.removeEventListener("pointerup", onFirstTap, { capture: true });
  }, [tiltSteer, tiltStatus, suspended, enableTilt]);

  /** Tilt listener, only while tilt is ready and shown: the first sample after enabling (or Recentre) becomes the zero */
  useEffect(() => {
    if (!tiltSteer || tiltStatus !== "ready" || suspended) return;
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
  }, [tiltSteer, tiltStatus, suspended, tiltRangeDeg, setSteer]);

  const onRecentre = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    tiltNeedsZero.current = true;
  };
  // On the release, like the first tap: the press is no user gesture to iOS
  const onRecentreRelease = () => {
    if (statusRef.current === "off" || statusRef.current === "denied") void enableTilt();
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-30 touch-none select-none">
      {/* Top-left: Menu and Cam */}
      <div
        className="absolute flex gap-2"
        style={{ top: edge("top", 12), left: edge("left", 16) }}
      >
        <TapButton label="Menu" color={HUD_SLATE} small onTap={onPause} />
        <TapButton label="Cam" color={HUD_SLATE} small onTap={onCycleCamera} />
      </div>

      {/* Bottom-left: steering */}
      <div className="absolute" style={{ left: edge("left", 16), bottom: edge("bottom", 16) }}>
        {tiltSteer ? (
          <TiltIndicator value={vis.steer} status={tiltStatus} onRecentre={onRecentre} onRecentreRelease={onRecentreRelease} />
        ) : (
          <SteerPad value={vis.steer} onChange={setSteer} suspended={suspended} />
        )}
      </div>

      {/* Bottom-right: shift / boost / aero buttons above the pedals */}
      <div
        className="absolute flex flex-col items-end gap-3 phone:gap-2"
        style={{ right: edge("right", 16), bottom: edge("bottom", 16) }}
      >
        <div className="flex gap-2">
          <TapButton
            label="Shift up"
            color={HUD_WHITE}
            icon={<ShiftArrow up />}
            onTap={() => {
              touchInput.shiftUp = true;
            }}
          />
          <TapButton
            label="Shift down"
            color={HUD_WHITE}
            icon={<ShiftArrow />}
            onTap={() => {
              touchInput.shiftDown = true;
            }}
          />
          <TapButton
            label="Boost"
            color={HUD_INFO}
            wide
            onTap={() => {
              touchInput.boost = true;
            }}
          />
          <TapButton
            label="X/Z"
            ariaLabel="Active aero"
            color={HUD_INFO}
            onTap={() => {
              touchInput.aero = true;
            }}
          />
        </div>
        <div className="flex gap-3 phone:gap-2">
          <Pedal label="Brake" color={HUD_BRAKE} value={vis.brake} onChange={setBrake} suspended={suspended} />
          <Pedal label="Throttle" color={HUD_THROTTLE} value={vis.throttle} onChange={setThrottle} suspended={suspended} />
        </div>
      </div>
    </div>
  );
};
