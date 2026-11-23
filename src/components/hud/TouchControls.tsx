"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import {
  requestTiltPermission,
  resetTouchInput,
  tiltToSteer,
  touchInput,
} from "@/lib/input/touch-input";
import type { TouchLayout } from "@/lib/settings/player-settings";
import { Icon } from "@/components/ui/icons/Icon";
import { HUD_BRAKE, HUD_GAIN, HUD_INFO, HUD_THROTTLE, HUD_VOID, HUD_VOLT, HUD_WHITE } from "./hud-format";
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
type Digital = "steerLeft" | "steerRight" | "throttleBtn" | "brakeBtn";
type TiltStatus = "off" | "asking" | "ready" | "denied" | "unsupported";
interface Visual {
  steer: number;
  throttle: number;
  brake: number;
  steerLeft: boolean;
  steerRight: boolean;
  throttleBtn: boolean;
  brakeBtn: boolean;
}

const ZERO_VISUAL: Visual = {
  steer: 0,
  throttle: 0,
  brake: 0,
  steerLeft: false,
  steerRight: false,
  throttleBtn: false,
  brakeBtn: false,
};

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
  /** Accessible name */
  label: string;
  value: number;
  onChange: (v: number) => void;
  /** Hidden under the pause menu or a replay: a finger still down is let go */
  suspended: boolean;
}

/** Releases pointer capture safely if the element still holds it (no-op if the browser already released it) */
function releaseCapture(el: Element | null, id: number): void {
  if (!el?.hasPointerCapture?.(id)) return;
  try {
    el.releasePointerCapture(id);
  } catch {
    // ignore if the browser already released capture
  }
}

/** Horizontal steering slider: the finger's travel from its touch-down point maps to −1..1 */
const SteerPad: React.FC<SteerPadProps> = ({ label, value, onChange, suspended }) => {
  const pid = useRef<number | null>(null);
  const padRef = useRef<HTMLDivElement | null>(null);
  const origin = useRef(0);

  useEffect(() => {
    if (!suspended) return;
    if (pid.current !== null) {
      releaseCapture(padRef.current, pid.current);
      pid.current = null;
    }
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

  // Fill and knob move by transform only, so steering redraws without a layout every frame
  const frac = (value + 1) / 2;
  const travel = { left: KNOB / 2, right: KNOB / 2 };
  const held = value !== 0;

  return (
    <div
      ref={padRef}
      role="slider"
      aria-label={label}
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
        {/* Fill from the centre to the knob: a half each way, slid in from the centre */}
        <span className="absolute inset-y-0" style={travel}>
          <span className="absolute top-1/2 left-1/2 h-1 w-1/2 -translate-y-1/2 overflow-hidden">
            <span
              className="block h-full rounded-e-full"
              style={{ backgroundColor: HUD_VOLT, transform: `translateX(${(Math.max(0, value) - 1) * 100}%)` }}
            />
          </span>
          <span className="absolute top-1/2 right-1/2 h-1 w-1/2 -translate-y-1/2 overflow-hidden">
            <span
              className="block h-full rounded-s-full"
              style={{ backgroundColor: HUD_VOLT, transform: `translateX(${(1 - Math.max(0, -value)) * 100}%)` }}
            />
          </span>
        </span>
        {/* Centre reference */}
        <span className="absolute top-1/2 left-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/40" />
        {/* Knob */}
        <span className="absolute inset-y-0" style={travel}>
          <span className="absolute inset-0" style={{ transform: `translateX(${frac * 100}%)` }}>
            <span
              className="absolute top-1/2 start-0 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] phone:scale-[0.82]"
              style={{
                width: KNOB,
                height: KNOB,
                borderColor: held ? HUD_VOLT : "rgb(255 255 255 / 0.7)",
                backgroundColor: tint(HUD_VOID, held ? 70 : 45),
              }}
            />
          </span>
        </span>
      </div>
    </div>
  );
};

/** Tilt steering's only readout while driving: a slim bar along the bottom edge, its tick where the steering is */
const TiltMeter: React.FC<{ value: number }> = ({ value }) => {
  // A half each way slid in from the centre (transform only, no layout every frame)
  return (
    <div aria-hidden className="relative h-1 w-[min(36vw,168px)] rounded-full bg-white/24 shadow-[0_0_0_1px_rgb(0_0_0/0.16)]">
      <span className="absolute inset-y-0 left-1/2 w-1/2 overflow-hidden">
        <span
          className="block h-full rounded-e-full"
          style={{ backgroundColor: HUD_VOLT, transform: `translateX(${(Math.max(0, value) - 1) * 100}%)` }}
        />
      </span>
      <span className="absolute inset-y-0 right-1/2 w-1/2 overflow-hidden">
        <span
          className="block h-full rounded-s-full"
          style={{ backgroundColor: HUD_VOLT, transform: `translateX(${(1 - Math.max(0, -value)) * 100}%)` }}
        />
      </span>
      <span className="absolute -inset-y-1 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-white/70" />
    </div>
  );
};

/** One line about tilt while it is not steering: off, being asked for, refused or missing */
const TiltNote: React.FC<{ children: React.ReactNode; onRetry?: () => void; maxWidth: string }> = ({ children, onRetry, maxWidth }) => {
  // Capped to the room it has on a portrait phone (between the pedals, or over the slider)
  const cls = `inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-full bg-lc-void/62 pe-3.5 ps-2.5 text-[12px] font-bold text-lc-chalk ${maxWidth}`;
  const body = (
    <>
      <Icon name="tilt" size="xs" />
      <span className="truncate">{children}</span>
    </>
  );
  // A retry asks for permission as the finger lifts: iOS takes a pointerup as a user gesture, not a pointerdown
  return onRetry ? (
    <button type="button" className={`${cls} pointer-events-auto relative touch-none before:absolute before:inset-x-0 before:-inset-y-1.5 active:scale-95`} style={{ touchAction: "none" }} onPointerUp={onRetry}>
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
  const pedalRef = useRef<HTMLDivElement | null>(null);
  // The pedal never moves while held: read its box once per press, not on every pointer move
  const box = useRef<DOMRect | null>(null);

  useEffect(() => {
    if (!suspended) return;
    if (pid.current !== null) {
      releaseCapture(pedalRef.current, pid.current);
      pid.current = null;
    }
    onChange(0);
  }, [suspended, onChange]);

  useEffect(
    () => () => {
      if (pid.current !== null) onChange(0);
    },
    [onChange],
  );

  const measure = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = box.current ?? e.currentTarget.getBoundingClientRect();
    return clamp((r.bottom - e.clientY) / Math.max(1, r.height), 0, 1);
  };
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (pid.current !== null) return;
    pid.current = e.pointerId;
    box.current = e.currentTarget.getBoundingClientRect();
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
      ref={pedalRef}
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

interface HoldButtonProps {
  label: string;
  color: string;
  icon: "keyLeft" | "keyRight" | "brake" | "keyUp";
  pressed: boolean;
  onChange: (down: boolean) => void;
  /** Hidden under the pause menu or a replay: a finger still down is let go */
  suspended: boolean;
  className: string;
}

/**
 * Multi-touch hold button for the four-button mobile layout (left, right, brake, throttle).
 * Tracks its own pointerId so steering and pedals can be held together without interference.
 */
const HoldButton: React.FC<HoldButtonProps> = ({
  label,
  color,
  icon,
  pressed,
  onChange,
  suspended,
  className,
}) => {
  const pid = useRef<number | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!suspended) return;
    if (pid.current !== null) {
      releaseCapture(btnRef.current, pid.current);
      pid.current = null;
    }
    onChange(false);
  }, [suspended, onChange]);

  useEffect(
    () => () => {
      if (pid.current !== null) onChange(false);
    },
    [onChange],
  );

  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (pid.current !== null) return;
    pid.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    onChange(true);
  };
  const release = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerId !== pid.current) return;
    pid.current = null;
    onChange(false);
  };

  return (
    <button
      ref={btnRef}
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      className={`pointer-events-auto touch-none relative flex items-center justify-center rounded-lc-sheet phone:rounded-lc-card transition-transform duration-75 ${pressed ? "scale-95" : ""} ${className}`}
      style={{
        touchAction: "none",
        backgroundColor: pressed ? tint(color, 55) : GHOST_BG,
        boxShadow: pressed
          ? `inset 0 0 0 2px ${color}, 0 0 0 1px rgb(0 0 0 / 0.16)`
          : `inset 0 0 0 1.5px ${tint(color, 55)}, 0 0 0 1px rgb(0 0 0 / 0.16)`,
        color: pressed ? HUD_WHITE : color,
      }}
      onPointerDown={down}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      <Icon name={icon} size="lg" />
    </button>
  );
};

interface PairButtonSpec {
  label: string;
  color: string;
  icon: "keyLeft" | "keyRight" | "brake" | "keyUp";
  pressed: boolean;
  onChange: (down: boolean) => void;
}

/**
 * Paired multi-touch hold buttons (Left/Right steering, or Brake/Throttle pedals).
 * Supports independent multi-touch fingers AND smooth thumb-rolling across the midline between the two buttons
 * without lifting, while tolerating slight thumb drift off the outer edges until pointer release.
 */
const HoldButtonPair: React.FC<{
  left: PairButtonSpec;
  right: PairButtonSpec;
  suspended: boolean;
  buttonClassName: string;
  gapClassName: string;
}> = ({ left, right, suspended, buttonClassName, gapClassName }) => {
  const pointers = useRef(new Map<number, "left" | "right">());
  const pairRef = useRef<HTMLDivElement | null>(null);
  const leftOnChange = left.onChange;
  const rightOnChange = right.onChange;

  const sync = useCallback(() => {
    let l = false;
    let r = false;
    for (const side of pointers.current.values()) {
      if (side === "left") l = true;
      else r = true;
    }
    leftOnChange(l);
    rightOnChange(r);
  }, [leftOnChange, rightOnChange]);

  useEffect(() => {
    if (!suspended) return;
    if (pointers.current.size > 0) {
      for (const id of pointers.current.keys()) releaseCapture(pairRef.current, id);
      pointers.current.clear();
      sync();
    }
  }, [suspended, sync]);

  useEffect(
    () => () => {
      if (pointers.current.size > 0) {
        pointers.current.clear();
        leftOnChange(false);
        rightOnChange(false);
      }
    },
    [leftOnChange, rightOnChange],
  );

  const sideForX = (clientX: number): "left" | "right" => {
    const rect = pairRef.current?.getBoundingClientRect();
    if (!rect) return "left";
    return clientX < rect.left + rect.width * 0.5 ? "left" : "right";
  };

  const onDown = (side: "left" | "right") => (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    pointers.current.set(e.pointerId, side);
    pairRef.current?.setPointerCapture(e.pointerId);
    sync();
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const next = sideForX(e.clientX);
    if (next !== prev) {
      pointers.current.set(e.pointerId, next);
      sync();
    }
  };

  const onRelease = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    sync();
  };

  const renderBtn = (spec: PairButtonSpec, side: "left" | "right") => (
    <button
      type="button"
      aria-label={spec.label}
      aria-pressed={spec.pressed}
      className={`pointer-events-auto touch-none relative flex items-center justify-center rounded-lc-sheet phone:rounded-lc-card transition-transform duration-75 ${spec.pressed ? "scale-95" : ""} ${buttonClassName}`}
      style={{
        touchAction: "none",
        backgroundColor: spec.pressed ? tint(spec.color, 55) : GHOST_BG,
        boxShadow: spec.pressed
          ? `inset 0 0 0 2px ${spec.color}, 0 0 0 1px rgb(0 0 0 / 0.16)`
          : `inset 0 0 0 1.5px ${tint(spec.color, 55)}, 0 0 0 1px rgb(0 0 0 / 0.16)`,
        color: spec.pressed ? HUD_WHITE : spec.color,
      }}
      onPointerDown={onDown(side)}
    >
      <Icon name={spec.icon} size="lg" />
    </button>
  );

  return (
    <div
      ref={pairRef}
      className={`pointer-events-auto touch-none flex ${gapClassName}`}
      style={{ touchAction: "none" }}
      onPointerMove={onMove}
      onPointerUp={onRelease}
      onPointerCancel={onRelease}
      onLostPointerCapture={onRelease}
    >
      {renderBtn(left, "left")}
      {renderBtn(right, "right")}
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
const ChromeButton: React.FC<{
  label: string;
  icon: "pause" | "camera" | "tilt";
  onTap: () => void;
}> = ({ label, icon, onTap }) => (
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
  /** Overtake not earned this lap (an older car's override under the 2026 rules in a race) */
  boostLocked: boolean;
  /** A 2026 F1 car's Overtake in a race (`ers-buttons.ts`): null outside one */
  overtake: "on" | "auto" | "available" | "locked" | "lowGrip" | null;
  gear: number;
  speedKmh: number;
  /** Changes on every restart */
  runId: number;
  /** Start lights are on */
  lights: boolean;
}

export interface TouchControlsProps {
  /** Sliders for analogue steering/pedals, or four hold buttons (left, right, brake, throttle) */
  layout?: TouchLayout;
  /** Steer from device tilt instead of the on-screen slider or steering buttons */
  tiltSteer: boolean;
  /** Tilt angle that gives full steering lock, in degrees */
  tiltRangeDeg: number;
  /** Automatic gearbox: no shift buttons, only reverse (or drive) once the car has stopped */
  autoGearbox: boolean;
  onPause: () => void;
  onCycleCamera: () => void;
  /** Show the headlamp toggle in the driving button cluster (dark / night / heavy rain or manually toggled) */
  showHeadlights?: boolean;
  /** Player headlights are currently lit */
  headlightsOn?: boolean;
  onToggleHeadlights?: () => void;
}

/**
 * Phone touch overlay: steering (slider, left/right buttons, or tilt), brake and throttle pedals (sliders or buttons),
 * the driving buttons the car and gearbox use, plus pause and camera. With tilt steering the pedals split, brake under
 * the left thumb and throttle under the right. Writes into the `touchInput` singleton.
 */
const TouchControlsView: React.FC<TouchControlsProps & { car: TouchCarState }> = ({
  layout = "sliders",
  tiltSteer,
  tiltRangeDeg,
  autoGearbox,
  onPause,
  onCycleCamera,
  showHeadlights,
  headlightsOn,
  onToggleHeadlights,
  car,
}) => {
  const [vis, setVis] = useState<Visual>(ZERO_VISUAL);
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
  const tx = useTranslations("hud.touchControls");
  // Redrawn with the steering and the car's state: the words are resolved once per language
  const lbl = useMemo(
    () => ({
      steering: tx("steering"),
      drive: tx("drive"),
      reverse: tx("reverse"),
      shiftDown: tx("shiftDown"),
      shiftUp: tx("shiftUp"),
      boost: tx("boost"),
      overtake: tx("overtake"),
      overtakeShort: tx("overtakeShort"),
      activeAero: tx("activeAero"),
      headlights: tx("headlights"),
      brake: tx("brake"),
      throttle: tx("throttle"),
      steerLeft: tx("steerLeft"),
      steerRight: tx("steerRight"),
      pause: tx("pause"),
      camera: tx("camera"),
      recentreTilt: tx("recentreTilt"),
      allowMotion: tx("allowMotion"),
      tapForTilt: tx("tapForTilt"),
      tiltBlocked: tx("tiltBlocked"),
      noTiltSensor: tx("noTiltSensor"),
    }),
    [tx],
  );

  const live = useRef<Visual>({ ...ZERO_VISUAL });
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
        p.steer === l.steer &&
        p.throttle === l.throttle &&
        p.brake === l.brake &&
        p.steerLeft === l.steerLeft &&
        p.steerRight === l.steerRight &&
        p.throttleBtn === l.throttleBtn &&
        p.brakeBtn === l.brakeBtn
          ? p
          : { ...l },
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

  const writeDigital = useCallback(
    (key: Digital, down: boolean) => {
      live.current[key] = down;
      touchInput[key] = down;
      schedule();
    },
    [schedule],
  );

  const setSteer = useCallback((v: number) => write("steer", v), [write]);
  const setThrottle = useCallback((v: number) => write("throttle", v), [write]);
  const setBrake = useCallback((v: number) => write("brake", v), [write]);
  const setSteerLeft = useCallback((d: boolean) => writeDigital("steerLeft", d), [writeDigital]);
  const setSteerRight = useCallback((d: boolean) => writeDigital("steerRight", d), [writeDigital]);
  const setThrottleBtn = useCallback((d: boolean) => writeDigital("throttleBtn", d), [writeDigital]);
  const setBrakeBtn = useCallback((d: boolean) => writeDigital("brakeBtn", d), [writeDigital]);

  /** Mark the overlay active for the game loop while it is shown; clear everything when hidden or unmounted */
  useEffect(() => {
    if (suspended) {
      live.current = { ...ZERO_VISUAL };
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

  /** Switching between Sliders and Buttons clears any live input from the previous layout */
  useEffect(() => {
    live.current = { ...ZERO_VISUAL };
    touchInput.steer = 0;
    touchInput.throttle = 0;
    touchInput.brake = 0;
    touchInput.steerLeft = false;
    touchInput.steerRight = false;
    touchInput.throttleBtn = false;
    touchInput.brakeBtn = false;
    schedule();
  }, [layout, schedule]);

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
    <GhostButton key="drive" label={lbl.drive} onTap={() => { touchInput.shiftUp = true; }}>
      <span className="lc-disp text-[20px] leading-none">D</span>
    </GhostButton>
  ) : drivenOff && speed < REVERSE_OFFER_KMH ? (
    <GhostButton key="reverse" label={lbl.reverse} onTap={() => { touchInput.shiftDown = true; }}>
      <span className="lc-disp text-[20px] leading-none">R</span>
    </GhostButton>
  ) : null;

  const shiftDown = autoGearbox ? null : (
    <GhostButton key="down" label={lbl.shiftDown} onTap={() => { touchInput.shiftDown = true; }}>
      <Icon name="shiftDown" size="md" />
    </GhostButton>
  );
  const shiftUp = autoGearbox ? null : (
    <GhostButton key="up" label={lbl.shiftUp} onTap={() => { touchInput.shiftUp = true; }}>
      <Icon name="shiftUp" size="md" />
    </GhostButton>
  );
  const boost = car.hasErs ? (
    <GhostButton key="boost" label={lbl.boost} on={car.boostOn} dim={car.boostLocked} onTap={() => { touchInput.boost = true; }}>
      <Icon name="overtake" size="md" />
    </GhostButton>
  ) : null;
  // A 2026 F1 car's Overtake in a race: a press uses it for the rest of the lap once earned
  const overtake =
    car.hasErs && car.overtake !== null ? (
      <GhostButton
        key="overtake"
        label={lbl.overtake}
        on={car.overtake === "on" || car.overtake === "auto"}
        dim={car.overtake === "locked" || car.overtake === "lowGrip"}
        onTap={() => { touchInput.overtake = true; }}
      >
        <span className="text-[11px] font-semibold leading-none">{lbl.overtakeShort}</span>
      </GhostButton>
    ) : null;
  const aero = car.hasAero ? (
    <GhostButton
      key="aero"
      label={lbl.activeAero}
      on={car.aeroOpen}
      armed={car.aeroArmed}
      dim={!car.aeroOpen && !car.aeroArmed}
      onTap={() => { touchInput.aero = true; }}
    >
      <Icon name={car.aeroOpen ? "drsOpen" : "drsClosed"} size="md" />
    </GhostButton>
  ) : null;

  const headlights =
    onToggleHeadlights && (showHeadlights || headlightsOn) ? (
      <GhostButton
        key="headlights"
        label={lbl.headlights}
        on={Boolean(headlightsOn)}
        tone={HUD_GAIN}
        onTap={onToggleHeadlights}
      >
        <Icon name="headlights" size="md" />
      </GhostButton>
    ) : null;

  const buttonsMode = layout === "buttons";

  /** Tell the game loop whether an analogue steering source (slider or active tilt) currently owns `touchInput.steer` */
  useEffect(() => {
    touchInput.analogSteerActive = !suspended && (!buttonsMode || (tilt && tiltStatus === "ready"));
  }, [suspended, buttonsMode, tilt, tiltStatus]);

  // Size classes use mutually exclusive `short:` (landscape phones) and `max-sm:portrait:` (portrait phones)
  // so the `phone:` variant never overrides the narrower portrait widths and causes button overlap on 360–375 px screens.
  const pedalBtnCls =
    "h-32 w-24 short:h-24 short:w-21 max-sm:portrait:h-24 max-sm:portrait:w-16";
  const steerBtnCls =
    "h-22 w-24 short:h-18 short:w-21 max-sm:portrait:h-18 max-sm:portrait:w-16";

  const brakePedal = buttonsMode ? (
    <HoldButton
      label={lbl.brake}
      color={HUD_BRAKE}
      icon="brake"
      pressed={vis.brakeBtn}
      onChange={setBrakeBtn}
      suspended={suspended}
      className={pedalBtnCls}
    />
  ) : (
    <Pedal label={lbl.brake} color={HUD_BRAKE} icon="brake" value={vis.brake} onChange={setBrake} suspended={suspended} />
  );
  const throttlePedal = buttonsMode ? (
    <HoldButton
      label={lbl.throttle}
      color={HUD_THROTTLE}
      icon="keyUp"
      pressed={vis.throttleBtn}
      onChange={setThrottleBtn}
      suspended={suspended}
      className={pedalBtnCls}
    />
  ) : (
    <Pedal label={lbl.throttle} color={HUD_THROTTLE} icon="keyUp" value={vis.throttle} onChange={setThrottle} suspended={suspended} />
  );
  const pedalPair = buttonsMode ? (
    <HoldButtonPair
      left={{ label: lbl.brake, color: HUD_BRAKE, icon: "brake", pressed: vis.brakeBtn, onChange: setBrakeBtn }}
      right={{ label: lbl.throttle, color: HUD_THROTTLE, icon: "keyUp", pressed: vis.throttleBtn, onChange: setThrottleBtn }}
      suspended={suspended}
      buttonClassName={pedalBtnCls}
      gapClassName="gap-3 short:gap-2 max-sm:portrait:gap-2"
    />
  ) : (
    <div className="flex gap-3 phone:gap-2">
      {brakePedal}
      {throttlePedal}
    </div>
  );
  const steerControl = buttonsMode ? (
    <HoldButtonPair
      left={{ label: lbl.steerLeft, color: HUD_VOLT, icon: "keyLeft", pressed: vis.steerLeft, onChange: setSteerLeft }}
      right={{ label: lbl.steerRight, color: HUD_VOLT, icon: "keyRight", pressed: vis.steerRight, onChange: setSteerRight }}
      suspended={suspended}
      buttonClassName={steerBtnCls}
      gapClassName="gap-3 short:gap-2 max-sm:portrait:gap-2"
    />
  ) : (
    <SteerPad label={lbl.steering} value={vis.steer} onChange={setSteer} suspended={suspended} />
  );
  /**
   * Driving buttons over a pedal; nothing at all when the car and gearbox use none.
   * Right-aligned clusters (`align === "end"`) expect buttons in right-to-left priority order so `flex-row-reverse`
   * keeps the primary buttons anchored to the right edge and `flex-wrap-reverse` wraps overflow upward on narrow
   * portrait phones (`< 640 px`, max 3 per row = 160 px) — keeping clear of `TiltNote` and never shifting existing
   * buttons when `Headlights` appears or disappears.
   */
  const buttonRow = (buttons: React.ReactNode[], align: "start" | "end") => {
    const shown = buttons.filter(Boolean);
    if (!shown.length) return null;
    if (align === "end") {
      return (
        <div className="flex flex-row-reverse flex-wrap-reverse justify-start gap-2 max-sm:portrait:max-w-42">
          {shown}
        </div>
      );
    }
    return <div className="flex justify-start gap-2">{shown}</div>;
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-30 touch-none select-none">
      {/* Top-left: pause, camera and (tilt steering) recentre — max 3 buttons (164 px) so it stays clear of PhoneHud */}
      <div className="absolute flex gap-2" style={{ top: edge("top", 12), left: edge("left", 16) }}>
        <ChromeButton label={lbl.pause} icon="pause" onTap={onPause} />
        <ChromeButton label={lbl.camera} icon="camera" onTap={onCycleCamera} />
        {tilt && tiltStatus === "ready" ? <ChromeButton label={lbl.recentreTilt} icon="tilt" onTap={onRecentre} /> : null}
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
              <TiltNote maxWidth="max-w-[calc(100vw-232px)]">{tiltStatus === "asking" ? lbl.allowMotion : lbl.tapForTilt}</TiltNote>
            )}
          </div>
          {/* Bottom-right: throttle under the right thumb, the other buttons over it (right-to-left so headlights never shift existing buttons) */}
          <div
            className="absolute flex flex-col items-end gap-3 phone:gap-2"
            style={{ right: edge("right", 16), bottom: edge("bottom", 16) }}
          >
            {buttonRow([aero, boost, overtake, shiftUp, headlights], "end")}
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
                <TiltNote maxWidth="max-w-[calc(100vw-216px)]" onRetry={onRetryTilt}>{lbl.tiltBlocked}</TiltNote>
              ) : (
                <TiltNote maxWidth="max-w-[calc(100vw-216px)]">{lbl.noTiltSensor}</TiltNote>
              )
            ) : null}
            {steerControl}
          </div>
          {/* Bottom-right: driving buttons above the pedals (right-to-left: shift paddles stay adjacent on the bottom row in portrait wrap, headlights last so toggling never shifts existing buttons) */}
          <div
            className="absolute flex flex-col items-end gap-3 phone:gap-2"
            style={{ right: edge("right", 16), bottom: edge("bottom", 16) }}
          >
            {buttonRow([shiftUp, shiftDown, aero, boost, overtake, gearButton, headlights], "end")}
            {pedalPair}
          </div>
        </>
      )}
    </div>
  );
};

export const TouchControls = React.memo(TouchControlsView);
