"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  requestTiltPermission,
  resetTouchInput,
  tiltToSteer,
  touchInput,
} from "@/lib/input/touch-input";
import { Icon } from "@/components/ui/icons/Icon";
import { HUD_BRAKE, HUD_INFO, HUD_THROTTLE, HUD_VOID, HUD_VOLT, HUD_WHITE } from "./hud-format";
import { useHudMode } from "./hud-mode";

/** Finger travel from the touch-down point that gives full steering lock, as a fraction of window width */
const STEER_SPAN_VW = 0.18;
/** With tilt on and no reading in this long, the device has no tilt sensor and the slider takes over (ms) */
const TILT_SILENT_MS = 2000;
/** Under this speed, once the car has driven off, an automatic gearbox offers reverse (km/h) */
const REVERSE_OFFER_KMH = 5;
/** The car counts as having driven off once past this speed (km/h): no reverse button on the grid */
const DRIVEN_OFF_KMH = 15;

type Analog = "steer" | "throttle" | "brake";
type TiltStatus = "off" | "asking" | "ready" | "denied" | "unsupported";
interface Visual {
  steer: number;
  throttle: number;
  brake: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Width of the steering slider: on a portrait phone it ends a gap short of the pedal column
 * (16 px edges, two 80 px pedals and their 12 px gap, 12 px between); on a landscape phone it stays
 * a thumb's sweep wide instead of taking a third of the screen
 */
const STICK_WIDTH = "w-[min(clamp(200px,38vw,400px),calc(100vw-216px))] phone:w-[min(clamp(180px,30vw,280px),calc(100vw-216px))]";

/** Steering knob diameter (px) */
const KNOB = 52;
/**
 * The touch pads are drawn as ghosts over the driving view: a faint wash and a thin ring, no card, no blur, lighting
 * up only under a finger. The dark hairline keeps them visible over a bright sky or a white kerb.
 */
const GHOST_BG = "rgb(0 0 0 / 0.2)";
const GHOST_RING = "inset 0 0 0 1.5px rgb(255 255 255 / 0.26), 0 0 0 1px rgb(0 0 0 / 0.16)";
/** Mixes a CSS colour with transparency (the pedal colours are theme variables) */
const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

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
  const held = value !== 0;

  return (
    <div
      role="slider"
      aria-label="Steering"
      aria-valuemin={-100}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className={`${STICK_WIDTH} pointer-events-auto touch-none relative h-20 rounded-full px-3 phone:h-16`}
      style={{ touchAction: "none", backgroundColor: GHOST_BG, boxShadow: GHOST_RING }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      <div className="pointer-events-none relative h-full">
        {/* Track */}
        <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/24" />
        {/* Fill from the centre to the knob */}
        <span
          className="absolute top-1/2 h-1 -translate-y-1/2"
          style={{
            width: fillWidth,
            backgroundColor: HUD_VOLT,
            ...(value < 0
              ? { right: "50%", borderRadius: "999px 0 0 999px" }
              : { left: "50%", borderRadius: "0 999px 999px 0" }),
          }}
        />
        {/* Centre reference */}
        <span className="absolute top-1/2 left-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/40" />
        {/* Knob */}
        <span
          className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] phone:scale-[0.82]"
          style={{
            left: knobLeft,
            width: KNOB,
            height: KNOB,
            borderColor: held ? HUD_VOLT : "rgb(255 255 255 / 0.7)",
            backgroundColor: tint(HUD_VOID, held ? 70 : 45),
          }}
        />
      </div>
    </div>
  );
};

/** Tilt steering's only readout while driving: a slim bar along the bottom edge, its tick where the steering is */
const TiltMeter: React.FC<{ value: number }> = ({ value }) => {
  const half = Math.abs(value) * 50;
  return (
    <div aria-hidden className="relative h-1 w-[min(36vw,168px)] rounded-full bg-white/24 shadow-[0_0_0_1px_rgb(0_0_0/0.16)]">
      <span
        className="absolute inset-y-0 rounded-full"
        style={{ left: `${value < 0 ? 50 - half : 50}%`, width: `${half}%`, backgroundColor: HUD_VOLT }}
      />
      <span className="absolute -inset-y-1 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-white/70" />
    </div>
  );
};

/** One line about tilt while it is not steering: off, being asked for, refused or missing */
const TiltNote: React.FC<{ children: React.ReactNode; onRetry?: () => void; maxWidth: string }> = ({ children, onRetry, maxWidth }) => {
  // Capped to the room it has on a portrait phone (between the pedals, or over the slider)
  const cls = `inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-full bg-lc-void/62 pr-3.5 pl-2.5 text-[12px] font-bold text-lc-chalk ${maxWidth}`;
  const body = (
    <>
      <Icon name="tilt" size="xs" />
      <span className="truncate">{children}</span>
    </>
  );
  // A retry asks for permission as the finger lifts: iOS takes a pointerup as a user gesture, not a pointerdown
  return onRetry ? (
    <button type="button" className={`${cls} pointer-events-auto touch-none active:scale-95`} style={{ touchAction: "none" }} onPointerUp={onRetry}>
      {body}
    </button>
  ) : (
    <span role="status" className={cls}>
      {body}
    </span>
  );
};

interface PedalProps {
  label: string;
  color: string;
  icon: "brake" | "keyUp";
  value: number;
  onChange: (v: number) => void;
  /** Hidden under the pause menu or a replay: a finger still down is let go */
  suspended: boolean;
}

/** Vertical pedal: the finger's height on the pedal (bottom 0 → top 1) is the input */
const Pedal: React.FC<PedalProps> = ({ label, color, icon, value, onChange, suspended }) => {
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

  const pressed = value > 0;

  // The visible pedal is the whole hit area: the travel is measured over its height
  return (
    <div
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className="pointer-events-auto touch-none relative flex h-37.5 w-25 items-end justify-center overflow-hidden rounded-lc-sheet pb-3 max-sm:portrait:w-20 short:w-22 phone:h-29 phone:rounded-lc-card phone:pb-2.5"
      style={{
        touchAction: "none",
        backgroundColor: pressed ? tint(color, 14) : GHOST_BG,
        boxShadow: `inset 0 0 0 1.5px ${tint(color, pressed ? 95 : 55)}, 0 0 0 1px rgb(0 0 0 / 0.16)`,
      }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      {/* The pedal's travel, scaled from the bottom (transform only) */}
      <div
        className="pointer-events-none absolute inset-0 origin-bottom"
        style={{ transform: `scaleY(${value})`, backgroundColor: tint(color, 62) }}
      />
      <span className="pointer-events-none relative" style={{ color: pressed ? HUD_WHITE : color }}>
        <Icon name={icon} size="md" />
      </span>
    </div>
  );
};

interface GhostButtonProps {
  /** Accessible name */
  label: string;
  /** Icon or glyph */
  children: React.ReactNode;
  onTap: () => void;
  /** A toggle that is on: filled */
  on?: boolean;
  /** Usable here (a DRS zone, say): a brighter ring */
  armed?: boolean;
  /** Not usable right now */
  dim?: boolean;
  /** Fill / ring colour when on or armed */
  tone?: string;
}

/** Round one-shot driving button (shift, boost, aero, reverse): fires on pointer down */
const GhostButton: React.FC<GhostButtonProps> = ({ label, children, onTap, on, armed, dim, tone = HUD_INFO }) => (
  <button
    type="button"
    aria-label={label}
    aria-pressed={on === undefined ? undefined : on}
    className={`pointer-events-auto touch-none flex size-13 items-center justify-center rounded-full active:scale-95 phone:size-12 ${dim ? "opacity-45" : ""}`}
    style={{
      touchAction: "none",
      color: on ? HUD_VOID : HUD_WHITE,
      backgroundColor: on ? tone : GHOST_BG,
      boxShadow: on ? undefined : armed ? `inset 0 0 0 2px ${tone}, 0 0 0 1px rgb(0 0 0 / 0.16)` : GHOST_RING,
    }}
    onPointerDown={(e) => {
      e.preventDefault();
      onTap();
    }}
  >
    {children}
  </button>
);

/** Small round icon button for the top corner (pause, camera, recentre): 44 px to the touch */
const ChromeButton: React.FC<{ label: string; icon: "pause" | "camera" | "tilt"; onTap: () => void }> = ({ label, icon, onTap }) => (
  <button
    type="button"
    aria-label={label}
    className="pointer-events-auto touch-none flex size-11 items-center justify-center rounded-full bg-lc-void/45 text-lc-chalk shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)] active:scale-95"
    style={{ touchAction: "none" }}
    onPointerDown={(e) => {
      e.preventDefault();
      onTap();
    }}
  >
    <Icon name={icon} size="md" />
  </button>
);

/** What the car can do right now, from its telemetry: which driving buttons to show and how lit */
export interface TouchCarState {
  hasErs: boolean;
  /** DRS / X-mode flaps (and rules that allow them) */
  hasAero: boolean;
  aeroOpen: boolean;
  aeroArmed: boolean;
  /** Boost / Overtake latched on */
  boostOn: boolean;
  /** Overtake not earned this lap (2026 rules in a race) */
  boostLocked: boolean;
  gear: number;
  speedKmh: number;
  /** Changes on every restart */
  runId: number;
  /** Start lights are on */
  lights: boolean;
}

export interface TouchControlsProps {
  /** Steer from device tilt instead of the on-screen slider */
  tiltSteer: boolean;
  /** Tilt angle that gives full steering lock, in degrees */
  tiltRangeDeg: number;
  /** Automatic gearbox: no shift buttons, only reverse (or drive) once the car has stopped */
  autoGearbox: boolean;
  onPause: () => void;
  onCycleCamera: () => void;
}

/**
 * Phone touch overlay: steering (slider or tilt), brake and throttle pedals, the driving buttons the car and gearbox
 * use, plus pause and camera. With tilt steering the pedals split, brake under the left thumb and throttle under the
 * right. Writes into the `touchInput` singleton.
 */
export const TouchControls: React.FC<TouchControlsProps & { car: TouchCarState }> = ({
  tiltSteer,
  tiltRangeDeg,
  autoGearbox,
  onPause,
  onCycleCamera,
  car,
}) => {
  const [vis, setVis] = useState<Visual>({ steer: 0, throttle: 0, brake: 0 });
  // The one source for tilt: the note shows it and the orientation listener only steers while it is "ready".
  // `statusRef` mirrors it for the same-event guard (a first tap on a retry reaches both tap handlers before a render)
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

  /**
   * Tilt listener, only while tilt is ready and shown: the first sample after enabling (or unpausing, or Recentre)
   * becomes the zero. A browser with the API but no sensor (a laptop, the iOS simulator, some tablets) sends nothing,
   * or only empty readings: after a quiet spell the slider takes over.
   */
  useEffect(() => {
    if (!tiltSteer || tiltStatus !== "ready" || suspended) return;
    tiltNeedsZero.current = true;
    let heard = false;
    const silent = window.setTimeout(() => {
      if (!heard) setTiltStatus("unsupported");
    }, TILT_SILENT_MS);
    const onOrientation = (ev: DeviceOrientationEvent) => {
      if (ev.beta === null && ev.gamma === null) return;
      heard = true;
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
      window.clearTimeout(silent);
      window.removeEventListener("deviceorientation", onOrientation);
      setSteer(0);
    };
  }, [tiltSteer, tiltStatus, suspended, tiltRangeDeg, setSteer, setTiltStatus]);

  /** Taken for sensorless after a quiet start: a real reading arriving later still hands steering back to tilt */
  useEffect(() => {
    if (!tiltSteer || tiltStatus !== "unsupported" || suspended || !("DeviceOrientationEvent" in window)) return;
    const onOrientation = (ev: DeviceOrientationEvent) => {
      if (ev.beta !== null || ev.gamma !== null) setTiltStatus("ready");
    };
    window.addEventListener("deviceorientation", onOrientation);
    return () => window.removeEventListener("deviceorientation", onOrientation);
  }, [tiltSteer, tiltStatus, suspended, setTiltStatus]);

  const onRecentre = () => {
    tiltNeedsZero.current = true;
  };
  // On the release, like the first tap: the press is no user gesture to iOS
  const onRetryTilt = () => {
    if (statusRef.current === "off" || statusRef.current === "denied") void enableTilt();
  };

  // Tilt steers (or is about to): the pedals split. Refused or missing: the slider takes over, pedals on the right
  const tiltFallback = tiltSteer && (tiltStatus === "denied" || tiltStatus === "unsupported");
  const tilt = tiltSteer && !tiltFallback;

  // An automatic gearbox needs one gear button: reverse once the car has driven off and stopped (never on the grid),
  // or drive while in reverse. Downshifting from first at a standstill selects reverse in every car.
  const [drivenOffRun, setDrivenOffRun] = useState<number | null>(null);
  const speed = Math.abs(car.speedKmh);
  useEffect(() => {
    if (speed > DRIVEN_OFF_KMH && drivenOffRun !== car.runId) setDrivenOffRun(car.runId);
  }, [speed, car.runId, drivenOffRun]);
  const drivenOff = drivenOffRun === car.runId;
  const gearButton = !autoGearbox || car.lights ? null : car.gear < 0 ? (
    <GhostButton key="drive" label="Drive" onTap={() => { touchInput.shiftUp = true; }}>
      <span className="lc-disp text-[20px] leading-none">D</span>
    </GhostButton>
  ) : drivenOff && speed < REVERSE_OFFER_KMH ? (
    <GhostButton key="reverse" label="Reverse" onTap={() => { touchInput.shiftDown = true; }}>
      <span className="lc-disp text-[20px] leading-none">R</span>
    </GhostButton>
  ) : null;

  const shiftDown = autoGearbox ? null : (
    <GhostButton key="down" label="Shift down" onTap={() => { touchInput.shiftDown = true; }}>
      <Icon name="shiftDown" size="md" />
    </GhostButton>
  );
  const shiftUp = autoGearbox ? null : (
    <GhostButton key="up" label="Shift up" onTap={() => { touchInput.shiftUp = true; }}>
      <Icon name="shiftUp" size="md" />
    </GhostButton>
  );
  const boost = car.hasErs ? (
    <GhostButton key="boost" label="Boost" on={car.boostOn} dim={car.boostLocked} onTap={() => { touchInput.boost = true; }}>
      <Icon name="overtake" size="md" />
    </GhostButton>
  ) : null;
  const aero = car.hasAero ? (
    <GhostButton
      key="aero"
      label="Active aero"
      on={car.aeroOpen}
      armed={car.aeroArmed}
      dim={!car.aeroOpen && !car.aeroArmed}
      onTap={() => { touchInput.aero = true; }}
    >
      <Icon name={car.aeroOpen ? "drsOpen" : "drsClosed"} size="md" />
    </GhostButton>
  ) : null;

  const brakePedal = (
    <Pedal label="Brake" color={HUD_BRAKE} icon="brake" value={vis.brake} onChange={setBrake} suspended={suspended} />
  );
  const throttlePedal = (
    <Pedal label="Throttle" color={HUD_THROTTLE} icon="keyUp" value={vis.throttle} onChange={setThrottle} suspended={suspended} />
  );
  /** A row of driving buttons over a pedal; nothing at all when the car and gearbox use none */
  const buttonRow = (buttons: React.ReactNode[], align: "start" | "end") => {
    const shown = buttons.filter(Boolean);
    return shown.length ? (
      <div className={`flex gap-2 ${align === "end" ? "justify-end" : "justify-start"}`}>{shown}</div>
    ) : null;
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-30 touch-none select-none">
      {/* Top-left: pause, camera and (tilt steering) recentre */}
      <div className="absolute flex gap-2" style={{ top: edge("top", 12), left: edge("left", 16) }}>
        <ChromeButton label="Pause" icon="pause" onTap={onPause} />
        <ChromeButton label="Camera" icon="camera" onTap={onCycleCamera} />
        {tilt && tiltStatus === "ready" ? <ChromeButton label="Recentre tilt" icon="tilt" onTap={onRecentre} /> : null}
      </div>

      {tilt ? (
        <>
          {/* Bottom-left: brake under the left thumb (and the gear buttons that go down) */}
          <div
            className="absolute flex flex-col items-start gap-3 phone:gap-2"
            style={{ left: edge("left", 16), bottom: edge("bottom", 16) }}
          >
            {buttonRow([shiftDown, gearButton], "start")}
            {brakePedal}
          </div>
          {/* Bottom-centre: the steering readout, or why tilt is not steering yet */}
          <div className="absolute left-1/2 -translate-x-1/2" style={{ bottom: edge("bottom", 18) }}>
            {tiltStatus === "ready" ? (
              <TiltMeter value={vis.steer} />
            ) : (
              <TiltNote maxWidth="max-w-[calc(100vw-232px)]">{tiltStatus === "asking" ? "Allow motion access" : "Tap to turn on tilt"}</TiltNote>
            )}
          </div>
          {/* Bottom-right: throttle under the right thumb, the other buttons over it */}
          <div
            className="absolute flex flex-col items-end gap-3 phone:gap-2"
            style={{ right: edge("right", 16), bottom: edge("bottom", 16) }}
          >
            {buttonRow([shiftUp, boost, aero], "end")}
            {throttlePedal}
          </div>
        </>
      ) : (
        <>
          {/* Bottom-left: steering slider (and why tilt is not steering, when it was chosen) */}
          <div
            className="absolute flex flex-col items-start gap-2"
            style={{ left: edge("left", 16), bottom: edge("bottom", 16) }}
          >
            {tiltFallback ? (
              tiltStatus === "denied" ? (
                <TiltNote maxWidth="max-w-[calc(100vw-216px)]" onRetry={onRetryTilt}>Tilt blocked · Retry</TiltNote>
              ) : (
                <TiltNote maxWidth="max-w-[calc(100vw-216px)]">No tilt sensor</TiltNote>
              )
            ) : null}
            <SteerPad value={vis.steer} onChange={setSteer} suspended={suspended} />
          </div>
          {/* Bottom-right: driving buttons above the pedals */}
          <div
            className="absolute flex flex-col items-end gap-3 phone:gap-2"
            style={{ right: edge("right", 16), bottom: edge("bottom", 16) }}
          >
            {buttonRow([gearButton, shiftDown, shiftUp, boost, aero], "end")}
            <div className="flex gap-3 phone:gap-2">
              {brakePedal}
              {throttlePedal}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
