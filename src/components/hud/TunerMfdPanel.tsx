"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { connectedPads } from "@/lib/input/device-input";
import { HUD_TOGGLE_EVENT } from "@/lib/input/bindings";
import { notePadInput } from "@/components/menu/input-mode";
import type { CarTelemetry, DiffPhase, LiveTunerPatch, LiveTunerState } from "@/types/f1";
import { HUD_CYAN, HUD_GREEN, HUD_RED, HUD_VOLT, HUD_YELLOW } from "./hud-format";

export type MfdCategoryId = "tc" | "abs" | "bias" | "diff" | "pwr";

export type MfdDialId = "tc1" | "tc2" | "abs" | "bias" | "diff_entry" | "diff_mid" | "diff_exit" | "engine_map" | "ers_mode";

interface DialMeta {
  id: MfdDialId;
  category: MfdCategoryId;
  /** Pill label */
  label: string;
  /** Name over the value */
  title: string;
  /** What lowering / raising it does (button tooltips) */
  lowHint: string;
  highHint: string;
  accent: string;
}

const CATEGORIES: { id: MfdCategoryId; label: string }[] = [
  { id: "tc", label: "TC" },
  { id: "abs", label: "ABS" },
  { id: "bias", label: "BIAS" },
  { id: "diff", label: "DIFF" },
  { id: "pwr", label: "PWR" },
];

const ALL_DIALS: DialMeta[] = [
  { id: "tc1", category: "tc", label: "TC1", title: "Traction control", lowHint: "More slip", highHint: "Safer", accent: HUD_YELLOW },
  { id: "tc2", category: "tc", label: "TC2", title: "TC cut", lowHint: "Smoother cut", highHint: "Harder cut", accent: HUD_VOLT },
  { id: "abs", category: "abs", label: "ABS", title: "ABS", lowHint: "Later", highHint: "Earlier", accent: HUD_CYAN },
  { id: "bias", category: "bias", label: "BIAS", title: "Brake bias", lowHint: "Rearward", highHint: "Forward", accent: HUD_RED },
  { id: "diff_entry", category: "diff", label: "ENTRY", title: "Diff entry", lowHint: "Agile", highHint: "Stable", accent: HUD_CYAN },
  { id: "diff_mid", category: "diff", label: "MID", title: "Diff mid", lowHint: "Rotates", highHint: "Locked", accent: HUD_VOLT },
  { id: "diff_exit", category: "diff", label: "EXIT", title: "Diff exit", lowHint: "Less snap", highHint: "More drive", accent: HUD_GREEN },
  { id: "engine_map", category: "pwr", label: "MAP", title: "Engine map", lowHint: "Sharper", highHint: "Smoother", accent: HUD_GREEN },
  { id: "ers_mode", category: "pwr", label: "ERS", title: "ERS deploy", lowHint: "Harvest", highHint: "Attack", accent: HUD_CYAN },
];

const ENGINE_MAPS: Record<number, { tag: string; torquePct: number }> = {
  1: { tag: "QUALI", torquePct: 100 },
  2: { tag: "RACE", torquePct: 100 },
  3: { tag: "SMOOTH", torquePct: 96 },
  4: { tag: "LEAN", torquePct: 92 },
  5: { tag: "WET", torquePct: 88 },
};

const ERS_MODES = ["CHR", "LIC", "BAL", "RAC", "PSH"] as const;
const ERS_TAG: Record<(typeof ERS_MODES)[number], string> = {
  CHR: "CHARGE",
  LIC: "LOW SPEED",
  BAL: "BALANCED",
  RAC: "RACE",
  PSH: "ATTACK",
};

const PHASE_COLORS: Record<DiffPhase, string> = {
  ENTRY: HUD_CYAN,
  MID: HUD_VOLT,
  EXIT: HUD_GREEN,
};

const FALLBACK_TUNER: LiveTunerState = {
  tcLevel: 5,
  tc2Level: 6,
  absLevel: 5,
  brakeBiasPct: 56.0,
  brakeMigrationPct: 2.5,
  diffEntry: 3,
  diffMid: 5,
  diffExit: 5,
  diffActivePhase: "MID",
  diffLockingTorqueNm: 0,
  engineMap: 2,
  ersMode: "RAC",
  hasErs: true,
  tcCutFraction: 0,
  absCutPerWheel: [0, 0, 0, 0],
  mgukGearClipFraction: 1,
};

const REPEAT_DELAY_MS = 320;
const REPEAT_RATE_MS = 95;

const MFD_CHIP =
  "inline-flex h-[26px] shrink-0 items-center rounded-full px-[9px] font-f1-mono text-[10px] font-extrabold whitespace-nowrap transition-colors";
const MFD_ROUND_BTN =
  "flex shrink-0 cursor-pointer items-center justify-center rounded-full border font-f1-mono font-extrabold transition-colors";
const MFD_ROUND_IDLE = "border-[#262B3D] bg-[#11131A] hover:border-[#CCFF00] hover:text-[#CCFF00]";
const MFD_ROUND_FLASH = "border-[#CCFF00] bg-[#CCFF00] text-[#08090D]";
const MFD_LBL = "font-f1-mono text-[10px] font-extrabold tracking-[0.14em] text-[#8E96AA] uppercase";

/** A thin live bar (0..1) */
const LiveBar: React.FC<{ frac: number; color: string }> = ({ frac, color }) => (
  <span className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-[#1B1F2B]">
    <span className="block h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, frac * 100))}%`, backgroundColor: color }} />
  </span>
);

export interface TunerMfdPanelProps {
  telemetry: CarTelemetry;
  onChangeTuner?: (patch: LiveTunerPatch) => void;
  className?: string;
  /** Start as the status pill only; any D-Pad dial / value press still expands it */
  defaultCollapsed?: boolean;
  /** Rendered as a page of the multi-page MFD: no frame or status bar, and the MFD owns folding */
  embedded?: boolean;
  /** Embedded: the MFD is currently folded to its compact status pill */
  folded?: boolean;
  /** Embedded: draw nothing (another page shows, or the MFD is folded) */
  hidden?: boolean;
  /** Embedded: wake the MFD from its folded pill without mutating a dial on the first press */
  onWake?: () => void;
  /** Embedded: step MFD pages with D-Pad Left / Right while viewing a non-electronics page */
  onCyclePage?: (delta: -1 | 1) => void;
  /** Embedded: the driver turned a dial or changed a value (D-pad, keys or a click) */
  onInteract?: () => void;
}

/** TC / ABS / bias / diff phase chips: the MFD's one-line status */
export const MfdStatusChips: React.FC<{ telemetry: CarTelemetry }> = ({ telemetry }) => {
  const tuner = telemetry.liveTuner ?? FALLBACK_TUNER;
  const tcActive = tuner.tcCutFraction > 0.02 || Boolean(telemetry.f12026?.tcActive);
  const absActive = tuner.absCutPerWheel.some((c) => c > 0.02) || Boolean(telemetry.f12026?.absActive);
  return (
    <div className="flex items-center gap-1">
      <span
        className={`${MFD_CHIP} ${
          tcActive ? "bg-[#FFB300] text-[#08090D]" : tuner.tcLevel > 0 ? "bg-[#1B1F2B] text-[#F5F7FA]" : "bg-[#1B1F2B] text-[#8E96AA]"
        }`}
      >
        TC {tuner.tcLevel > 0 ? `${tuner.tcLevel}/${tuner.tc2Level}` : "OFF"}
      </span>
      <span
        className={`${MFD_CHIP} ${
          absActive ? "bg-[#00E5FF] text-[#08090D]" : tuner.absLevel > 0 ? "bg-[#1B1F2B] text-[#F5F7FA]" : "bg-[#1B1F2B] text-[#8E96AA]"
        }`}
      >
        ABS {tuner.absLevel > 0 ? tuner.absLevel : "OFF"}
      </span>
      <span className={`${MFD_CHIP} bg-[#1B1F2B] text-[#CCFF00]`}>BB {tuner.brakeBiasPct.toFixed(1)}</span>
      <span className={`${MFD_CHIP} text-[#08090D]`} style={{ backgroundColor: PHASE_COLORS[tuner.diffActivePhase] }}>
        {tuner.diffActivePhase}
      </span>
    </div>
  );
};

/**
 * Live electronics tuner (TC, ABS, brake bias, diff, engine map, ERS), laid out for one thumb on the D-pad while
 * driving: ◀ ▶ picks the dial, ▲ ▼ changes it (keys , . and − =). Every dial draws the same blocks at the same size,
 * so nothing moves while you step through them.
 */
export const TunerMfdPanel: React.FC<TunerMfdPanelProps> = ({
  telemetry,
  onChangeTuner,
  className = "",
  defaultCollapsed = false,
  embedded = false,
  folded = false,
  hidden = false,
  onWake,
  onCyclePage,
  onInteract,
}) => {
  const tuner = telemetry.liveTuner ?? FALLBACK_TUNER;

  const dials = useMemo(() => ALL_DIALS.filter((d) => (d.id === "ers_mode" ? tuner.hasErs : true)), [tuner.hasErs]);

  const [dialIdx, setDialIdx] = useState(0);
  const [ownCollapsed, setCollapsed] = useState(defaultCollapsed);
  // Embedded, the multi-page MFD folds and unfolds; this panel is then always open
  const collapsed = embedded ? false : ownCollapsed;
  const interactRef = useRef(onInteract);
  interactRef.current = onInteract;
  const mfdStateRef = useRef({ embedded, folded, hidden, onWake, onCyclePage });
  mfdStateRef.current = { embedded, folded, hidden, onWake, onCyclePage };
  // The MFD pad button (L3 by default) opens and closes it
  useEffect(() => {
    if (embedded) return;
    const toggle = () => setCollapsed((c) => !c);
    window.addEventListener(HUD_TOGGLE_EVENT.mfd, toggle);
    return () => window.removeEventListener(HUD_TOGGLE_EVENT.mfd, toggle);
  }, [embedded]);
  const [flashDir, setFlashDir] = useState<"up" | "down" | "left" | "right" | null>(null);

  const safeIdx = Math.min(dialIdx, dials.length - 1);
  const activeDial = dials[safeIdx] ?? dials[0];
  const categoryDials = useMemo(() => dials.filter((d) => d.category === activeDial.category), [dials, activeDial.category]);

  const tcActive = tuner.tcCutFraction > 0.02 || Boolean(telemetry.f12026?.tcActive);

  const emit = useCallback(
    (patch: LiveTunerPatch) => {
      onChangeTuner?.(patch);
    },
    [onChangeTuner]
  );

  const triggerFlash = useCallback((dir: "up" | "down" | "left" | "right") => {
    setFlashDir(dir);
  }, []);

  useEffect(() => {
    if (!flashDir) return;
    const id = window.setTimeout(() => setFlashDir(null), 150);
    return () => window.clearTimeout(id);
  }, [flashDir]);

  const cycleDial = useCallback(
    (delta: -1 | 1) => {
      const m = mfdStateRef.current;
      if (m.embedded && m.folded && m.onWake) {
        m.onWake();
        return;
      }
      if (m.embedded && !m.folded && m.hidden && m.onCyclePage) {
        m.onCyclePage(delta);
        return;
      }
      setCollapsed(false);
      interactRef.current?.();
      setDialIdx((prev) => (prev + delta + dials.length) % dials.length);
      triggerFlash(delta < 0 ? "left" : "right");
    },
    [dials.length, triggerFlash]
  );

  const pickDial = useCallback(
    (id: MfdDialId) => {
      const idx = dials.findIndex((d) => d.id === id);
      if (idx === -1) return;
      interactRef.current?.();
      setDialIdx(idx);
    },
    [dials]
  );

  const adjustActiveDial = useCallback(
    (dir: -1 | 1) => {
      const m = mfdStateRef.current;
      if (m.embedded && m.folded && m.onWake) {
        m.onWake();
        return;
      }
      if (m.embedded && !m.folded && m.hidden) {
        interactRef.current?.();
        return;
      }
      setCollapsed(false);
      interactRef.current?.();
      triggerFlash(dir > 0 ? "up" : "down");
      switch (activeDial.id) {
        case "tc1":
          emit({ tcLevel: Math.max(0, Math.min(12, tuner.tcLevel + dir)) });
          break;
        case "tc2":
          emit({ tc2Level: Math.max(1, Math.min(12, tuner.tc2Level + dir)) });
          break;
        case "abs":
          emit({ absLevel: Math.max(0, Math.min(12, tuner.absLevel + dir)) });
          break;
        case "bias":
          emit({ brakeBiasPct: Number(Math.max(47, Math.min(75, tuner.brakeBiasPct + dir * 0.5)).toFixed(1)) });
          break;
        case "diff_entry":
          emit({ diffEntry: Math.max(1, Math.min(12, tuner.diffEntry + dir)) });
          break;
        case "diff_mid":
          emit({ diffMid: Math.max(1, Math.min(12, tuner.diffMid + dir)) });
          break;
        case "diff_exit":
          emit({ diffExit: Math.max(1, Math.min(12, tuner.diffExit + dir)) });
          break;
        case "engine_map":
          emit({ engineMap: Math.max(1, Math.min(5, tuner.engineMap + dir)) });
          break;
        case "ers_mode": {
          const cur = Math.max(0, ERS_MODES.indexOf(tuner.ersMode as (typeof ERS_MODES)[number]));
          emit({ ersMode: ERS_MODES[Math.max(0, Math.min(ERS_MODES.length - 1, cur + dir))] });
          break;
        }
      }
    },
    [activeDial.id, emit, triggerFlash, tuner]
  );

  // Keep latest callbacks in a ref for the 60 Hz Gamepad D-Pad polling loop
  const actionsRef = useRef({ cycleDial, adjustActiveDial });
  useEffect(() => {
    actionsRef.current = { cycleDial, adjustActiveDial };
  }, [cycleDial, adjustActiveDial]);

  // Controller D-Pad polling:
  // Button 12 = D-Pad Up (+), 13 = D-Pad Down (-), 14 = D-Pad Left (prev dial / page), 15 = D-Pad Right (next dial / page)
  useEffect(() => {
    let raf = 0;
    let prev: [boolean, boolean, boolean, boolean] | null = null;
    const repeatAt: [number, number, number, number] = [Infinity, Infinity, Infinity, Infinity];

    const poll = (nowMs: number) => {
      raf = requestAnimationFrame(poll);
      // Do not intercept D-Pad while a full-screen menu / modal (PauseMenu, TitleMenu, Wizard) is open
      if (document.querySelector("[data-nav-zone]")) {
        prev = null;
        return;
      }
      const pads = connectedPads();
      const pad = pads.find((p) => p.mapping === "standard") ?? pads[0];
      if (!pad) {
        prev = null;
        return;
      }
      const down = (btnIdx: number) => Boolean(pad.buttons[btnIdx]?.pressed);
      const cur: [boolean, boolean, boolean, boolean] = [down(12), down(13), down(14), down(15)];

      if (prev === null) {
        prev = cur;
        return;
      }

      const fire = (idx: number) => {
        notePadInput(pad.id);
        if (idx === 0) actionsRef.current.adjustActiveDial(1);
        else if (idx === 1) actionsRef.current.adjustActiveDial(-1);
        else if (idx === 2) actionsRef.current.cycleDial(-1);
        else if (idx === 3) actionsRef.current.cycleDial(1);
      };

      for (let i = 0; i < 4; i++) {
        if (cur[i] && !prev[i]) {
          fire(i);
          repeatAt[i] = nowMs + REPEAT_DELAY_MS;
        } else if (cur[i] && nowMs >= repeatAt[i]) {
          fire(i);
          repeatAt[i] = nowMs + REPEAT_RATE_MS;
        } else if (!cur[i]) {
          repeatAt[i] = Infinity;
        }
      }

      prev = cur;
    };

    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Keyboard shortcuts: , / . (or [ / ]) cycle MFD dials; - / = adjust value
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || document.querySelector("[data-nav-zone]")) {
        return;
      }
      if (e.key === "," || e.key === "<" || e.key === "[") {
        e.preventDefault();
        cycleDial(-1);
      } else if (e.key === "." || e.key === ">" || e.key === "]") {
        e.preventDefault();
        cycleDial(1);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        adjustActiveDial(-1);
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        adjustActiveDial(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycleDial, adjustActiveDial]);

  // The active dial's value, a short tag beside its name, and its segment bar
  const hero = useMemo((): { text: string; tag: string; segments: number; filled: number; off: boolean } => {
    const lvl = (v: number, offAtZero: boolean) => ({
      text: offAtZero && v <= 0 ? "OFF" : String(v),
      tag: offAtZero && v <= 0 ? "" : "OF 12",
      segments: 12,
      filled: v,
      off: offAtZero && v <= 0,
    });
    const lock = (v: number) => ({ ...lvl(v, false), tag: `${Math.round(((v - 1) / 11) * 100)}% LOCK` });
    switch (activeDial.id) {
      case "tc1":
        return lvl(tuner.tcLevel, true);
      case "tc2":
        return lvl(tuner.tc2Level, false);
      case "abs":
        return lvl(tuner.absLevel, true);
      case "bias":
        return {
          text: tuner.brakeBiasPct.toFixed(1),
          tag: "% FRONT",
          segments: 14,
          filled: Math.round(Math.max(0, Math.min(1, (tuner.brakeBiasPct - 47) / (75 - 47))) * 14),
          off: false,
        };
      case "diff_entry":
        return lock(tuner.diffEntry);
      case "diff_mid":
        return lock(tuner.diffMid);
      case "diff_exit":
        return lock(tuner.diffExit);
      case "engine_map":
        return { text: `M${tuner.engineMap}`, tag: ENGINE_MAPS[tuner.engineMap]?.tag ?? "", segments: 5, filled: tuner.engineMap, off: false };
      case "ers_mode": {
        const idx = Math.max(0, ERS_MODES.indexOf(tuner.ersMode as (typeof ERS_MODES)[number]));
        return {
          text: tuner.ersMode,
          tag: ERS_TAG[tuner.ersMode as (typeof ERS_MODES)[number]] ?? "",
          segments: 5,
          filled: idx + 1,
          off: tuner.ersMode === "CHR",
        };
      }
    }
  }, [activeDial.id, tuner]);

  if (embedded && hidden) return null;

  // One live line under the dial: what that dial is doing right now
  const live = (): React.ReactNode => {
    switch (activeDial.category) {
      case "tc":
        return (
          <>
            <span className={MFD_LBL}>Cut</span>
            <LiveBar frac={tuner.tcCutFraction} color={HUD_YELLOW} />
            <span className="w-[38px] text-right font-f1-mono text-[12px] font-extrabold tabular-nums" style={{ color: tcActive ? HUD_YELLOW : "#F5F7FA" }}>
              {Math.round(tuner.tcCutFraction * 100)}%
            </span>
          </>
        );
      case "abs":
        return (["FL", "FR", "RL", "RR"] as const).map((c, i) => (
          <span key={c} className="flex min-w-0 flex-1 items-center gap-1">
            <span className="font-f1-mono text-[9px] font-extrabold text-[#8E96AA]">{c}</span>
            <LiveBar frac={tuner.absCutPerWheel[i] ?? 0} color={HUD_CYAN} />
          </span>
        ));
      case "bias":
        return (
          <>
            <span className="font-f1-mono text-[12px] font-extrabold text-[#FF2A3C] tabular-nums">F {tuner.brakeBiasPct.toFixed(1)}</span>
            <span className="flex h-[5px] min-w-0 flex-1 overflow-hidden rounded-full">
              <span className="h-full bg-[#FF2A3C]" style={{ width: `${tuner.brakeBiasPct}%` }} />
              <span className="h-full flex-1 bg-[#00E5FF]" />
            </span>
            <span className="font-f1-mono text-[12px] font-extrabold text-[#00E5FF] tabular-nums">R {(100 - tuner.brakeBiasPct).toFixed(1)}</span>
          </>
        );
      case "diff":
        return (
          <>
            {(["ENTRY", "MID", "EXIT"] as const).map((ph) => (
              <span
                key={ph}
                className={`${MFD_CHIP} h-[20px] px-2 text-[9px]`}
                style={{
                  backgroundColor: tuner.diffActivePhase === ph ? PHASE_COLORS[ph] : "#1B1F2B",
                  color: tuner.diffActivePhase === ph ? "#08090D" : "#8E96AA",
                }}
              >
                {ph}
              </span>
            ))}
            <span className="ml-auto font-f1-mono text-[12px] font-extrabold text-[#F5F7FA] tabular-nums">{tuner.diffLockingTorqueNm} Nm</span>
          </>
        );
      case "pwr":
        return activeDial.id === "engine_map" ? (
          <>
            <span className={MFD_LBL}>Torque</span>
            <span className="ml-auto font-f1-mono text-[12px] font-extrabold text-[#F5F7FA] tabular-nums">{ENGINE_MAPS[tuner.engineMap]?.torquePct ?? 100}%</span>
          </>
        ) : (
          <>
            <span className={MFD_LBL}>Battery</span>
            <LiveBar frac={telemetry.ersBatteryPercent / 100} color={HUD_CYAN} />
            <span className="w-[38px] text-right font-f1-mono text-[12px] font-extrabold text-[#00E5FF] tabular-nums">
              {Math.round(telemetry.ersBatteryPercent)}%
            </span>
          </>
        );
    }
  };

  const body = (
    <div className="flex h-[212px] flex-col gap-1.5">
      {/* Category strip with ◀ ▶ */}
      <div className="flex h-[28px] items-center gap-1">
        <button
          type="button"
          onClick={() => cycleDial(-1)}
          className={`${MFD_ROUND_BTN} h-[28px] w-[28px] ${flashDir === "left" ? MFD_ROUND_FLASH : `${MFD_ROUND_IDLE} text-[#8E96AA]`}`}
          title="Previous dial (D-pad ◀ or ,)"
          aria-label="Previous dial"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={2.6} />
        </button>
        <div className="flex min-w-0 flex-1 gap-0.5">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => {
                const first = dials.find((d) => d.category === cat.id);
                if (first) pickDial(first.id);
              }}
              className={`h-[28px] min-w-0 flex-1 cursor-pointer rounded-full font-f1-mono text-[10px] font-extrabold transition-colors ${
                activeDial.category === cat.id ? "bg-[#CCFF00] text-[#08090D]" : "text-[#8E96AA] hover:bg-white/5 hover:text-[#F5F7FA]"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => cycleDial(1)}
          className={`${MFD_ROUND_BTN} h-[28px] w-[28px] ${flashDir === "right" ? MFD_ROUND_FLASH : `${MFD_ROUND_IDLE} text-[#8E96AA]`}`}
          title="Next dial (D-pad ▶ or .)"
          aria-label="Next dial"
        >
          <ChevronRight className="h-4 w-4" strokeWidth={2.6} />
        </button>
      </div>

      {/* The dials in this group: always one row, so the layout never jumps */}
      <div className="flex h-[22px] gap-1">
        {categoryDials.map((d) => {
          const selected = d.id === activeDial.id;
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => pickDial(d.id)}
              className={`h-[22px] min-w-0 flex-1 cursor-pointer rounded-full border font-f1-mono text-[9px] font-extrabold tracking-[0.1em] transition-colors ${
                selected ? "" : "border-[#262B3D] text-[#8E96AA] hover:text-[#F5F7FA]"
              }`}
              style={selected ? { borderColor: d.accent, color: d.accent } : undefined}
            >
              {d.label}
            </button>
          );
        })}
      </div>

      {/* Value card */}
      <div className="flex min-h-0 flex-1 flex-col justify-between rounded-[18px] border border-[#1B1F2B] bg-[#050608] px-2.5 py-2">
        <div className="flex items-baseline justify-between">
          <span className="font-f1-mono text-[11px] font-extrabold tracking-[0.12em] text-[#F5F7FA] uppercase">{activeDial.title}</span>
          <span className={MFD_LBL}>{hero.tag}</span>
        </div>
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => adjustActiveDial(-1)}
            className={`${MFD_ROUND_BTN} h-9 w-9 text-[14px] ${flashDir === "down" ? MFD_ROUND_FLASH : `${MFD_ROUND_IDLE} text-[#F5F7FA]`}`}
            aria-label={`Lower ${activeDial.title}`}
            title={`${activeDial.lowHint} (D-pad ▼ or −)`}
          >
            −
          </button>
          <span
            className="font-f1-mono text-[38px] leading-none font-extrabold tabular-nums"
            style={{ color: hero.off ? "#8E96AA" : activeDial.accent, textShadow: hero.off ? undefined : `0 0 14px ${activeDial.accent}44` }}
          >
            {hero.text}
          </span>
          <button
            type="button"
            onClick={() => adjustActiveDial(1)}
            className={`${MFD_ROUND_BTN} h-9 w-9 text-[14px] ${flashDir === "up" ? MFD_ROUND_FLASH : `${MFD_ROUND_IDLE} text-[#F5F7FA]`}`}
            aria-label={`Raise ${activeDial.title}`}
            title={`${activeDial.highHint} (D-pad ▲ or =)`}
          >
            +
          </button>
        </div>
        <div className="flex h-[5px] gap-[2px]" aria-hidden>
          {Array.from({ length: hero.segments }, (_, k) => (
            <span
              key={k}
              className="h-full flex-1 rounded-full"
              style={{ backgroundColor: !hero.off && k < hero.filled ? activeDial.accent : "#1B1F2B" }}
            />
          ))}
        </div>
      </div>

      {/* Live line */}
      <div className="flex h-[30px] items-center gap-2 rounded-[14px] bg-white/[0.03] px-2.5">{live()}</div>
    </div>
  );

  if (embedded) return <div className={`w-full ${className}`}>{body}</div>;

  return (
    <div
      className={`pointer-events-auto select-none overflow-hidden border border-white/[0.08] bg-[#0A0B10]/92 shadow-[0_20px_50px_rgba(0,0,0,0.55)] backdrop-blur-md ${
        collapsed ? "w-max rounded-full p-1.5" : "flex w-[300px] flex-col gap-2 rounded-[24px] p-2.5"
      } ${className}`}
    >
      <div className="flex items-center justify-between gap-1">
        <MfdStatusChips telemetry={telemetry} />
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex h-[26px] w-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full text-[#8E96AA] transition-colors hover:bg-white/10 hover:text-[#CCFF00]"
          aria-label={collapsed ? "Open the tuner" : "Fold the tuner"}
        >
          {collapsed ? <ChevronUp className="h-3.5 w-3.5" strokeWidth={2.6} /> : <ChevronDown className="h-3.5 w-3.5" strokeWidth={2.6} />}
        </button>
      </div>
      {collapsed ? null : body}
    </div>
  );
};
