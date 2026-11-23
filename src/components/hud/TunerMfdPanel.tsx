"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import { connectedPads } from "@/lib/input/device-input";
import { HUD_TOGGLE_EVENT } from "@/lib/input/bindings";
import { notePadInput } from "@/components/menu/input-mode";
import type { CarTelemetry, DiffPhase, LiveTunerPatch, LiveTunerState } from "@/types/f1";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import { HUD_CAUTION, HUD_GLASS, HUD_INFO, HUD_LBL, aidsActive } from "./hud-format";
import { HUD_CHOSEN, HUD_CONTROL, HUD_IDLE } from "./styles/hud-style-parts";
import { SkinButton, skinCss, SkinPanel, skinRootClass, SkinTag, useHudSkin } from "./styles/third-party-skin";

/** Every dial draws in chalk: the dial's name says which it is, so colour carries no meaning here */
const DIAL_ACCENT = "var(--color-lc-chalk)";
import { useHudModeRef } from "./hud-mode";

export type MfdCategoryId = "tc" | "abs" | "bias" | "diff" | "pwr";

export type MfdDialId = "tc1" | "tc2" | "abs" | "bias" | "diff_entry" | "diff_mid" | "diff_exit" | "engine_map" | "ers_mode";

interface DialMeta {
  id: MfdDialId;
  category: MfdCategoryId;
  accent: string;
}

/** A dial's words (see `useTunerText`) */
interface DialText {
  /** Pill label */
  label: string;
  /** Name over the value */
  title: string;
  /** What lowering / raising it does (button tooltips) */
  lowHint: string;
  highHint: string;
}

const CATEGORIES: { id: MfdCategoryId }[] = [{ id: "tc" }, { id: "abs" }, { id: "bias" }, { id: "diff" }, { id: "pwr" }];

const ALL_DIALS: DialMeta[] = [
  { id: "tc1", category: "tc", accent: DIAL_ACCENT },
  { id: "tc2", category: "tc", accent: DIAL_ACCENT },
  { id: "abs", category: "abs", accent: DIAL_ACCENT },
  { id: "bias", category: "bias", accent: DIAL_ACCENT },
  { id: "diff_entry", category: "diff", accent: DIAL_ACCENT },
  { id: "diff_mid", category: "diff", accent: DIAL_ACCENT },
  { id: "diff_exit", category: "diff", accent: DIAL_ACCENT },
  { id: "engine_map", category: "pwr", accent: DIAL_ACCENT },
  { id: "ers_mode", category: "pwr", accent: DIAL_ACCENT },
];

const ENGINE_MAPS: Record<number, { tag: "quali" | "race" | "smooth" | "lean" | "wet"; torquePct: number }> = {
  1: { tag: "quali", torquePct: 100 },
  2: { tag: "race", torquePct: 100 },
  3: { tag: "smooth", torquePct: 96 },
  4: { tag: "lean", torquePct: 92 },
  5: { tag: "wet", torquePct: 88 },
};

const ERS_MODES = ["CHR", "LIC", "BAL", "RAC", "PSH"] as const;

/**
 * The tuner's words in the current language, resolved once per language: the tuner redraws with every telemetry tick.
 * TC, ABS and ERS are kept as they are in every language.
 */
function useTunerText() {
  const tx = useTranslations("hud.tunerMfdPanel");
  return useMemo(() => {
    const dial = (label: string, key: "tc1" | "tc2" | "abs" | "bias" | "diffEntry" | "diffMid" | "diffExit" | "engineMap" | "ersMode", title?: string): DialText => ({
      label,
      title: title ?? tx(`dials.${key}.title`),
      lowHint: tx(`dials.${key}.low`),
      highHint: tx(`dials.${key}.high`),
    });
    return {
      categories: { tc: "TC", abs: "ABS", bias: tx("categories.bias"), diff: tx("categories.diff"), pwr: tx("categories.pwr") } satisfies Record<MfdCategoryId, string>,
      dials: {
        tc1: dial("TC1", "tc1"),
        tc2: dial("TC2", "tc2"),
        abs: dial("ABS", "abs", "ABS"),
        bias: dial(tx("dials.bias.label"), "bias"),
        diff_entry: dial(tx("dials.diffEntry.label"), "diffEntry"),
        diff_mid: dial(tx("dials.diffMid.label"), "diffMid"),
        diff_exit: dial(tx("dials.diffExit.label"), "diffExit"),
        engine_map: dial(tx("dials.engineMap.label"), "engineMap"),
        ers_mode: dial("ERS", "ersMode"),
      } satisfies Record<MfdDialId, DialText>,
      engineMaps: {
        quali: tx("engineMaps.quali"),
        race: tx("engineMaps.race"),
        smooth: tx("engineMaps.smooth"),
        lean: tx("engineMaps.lean"),
        wet: tx("engineMaps.wet"),
      },
      ersModes: {
        CHR: tx("ersModes.charge"),
        LIC: tx("ersModes.lowSpeed"),
        BAL: tx("ersModes.balanced"),
        RAC: tx("ersModes.race"),
        PSH: tx("ersModes.attack"),
      } satisfies Record<(typeof ERS_MODES)[number], string>,
      phases: { ENTRY: tx("phases.entry"), MID: tx("phases.mid"), EXIT: tx("phases.exit") } satisfies Record<DiffPhase, string>,
      tcOff: tx("chips.tcOff"),
      absOff: tx("chips.absOff"),
      off: tx("hero.off"),
      ofMax: tx("hero.ofMax", { max: 12 }),
      front: tx("hero.front"),
      cut: tx("live.cut"),
      wheels: [tx("live.wheelFl"), tx("live.wheelFr"), tx("live.wheelRl"), tx("live.wheelRr")],
      torque: tx("live.torque"),
      battery: tx("live.battery"),
      previousDial: tx("previousDial"),
      previousDialHint: tx("previousDialHint"),
      nextDial: tx("nextDial"),
      nextDialHint: tx("nextDialHint"),
      openTuner: tx("openTuner"),
      foldTuner: tx("foldTuner"),
      tx,
    };
  }, [tx]);
}

const FALLBACK_TUNER: LiveTunerState = {
  tcLevel: 5,
  tc2Level: 6,
  tcSlipAngleLevel: 0,
  hasTcSlipAngle: false,
  motorDeployKw: null,
  regenKw: null,
  motorDeployStepsKw: [],
  regenStepsKw: [],
  absAllowed: true,
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

const MFD_ROUND_BTN = `flex shrink-0 items-center justify-center rounded-full border ${HUD_CONTROL}`;
const MFD_ROUND_IDLE = "border-lc-line bg-lc-carbon";
/** The D-pad pressed this button: it lights as chosen for a moment (never the volt cursor) */
const MFD_ROUND_FLASH = `border-transparent ${HUD_CHOSEN}`;
const MFD_LBL = HUD_LBL;

/** A thin live bar (0..1), scaled from the left (transform only) */
const LiveBar: React.FC<{ frac: number; color?: string; skinned?: boolean; fillClass?: string }> = ({
  frac,
  color,
  skinned = false,
  fillClass,
}) => {
  const scale = `scaleX(${Math.min(1, Math.max(0, frac))})`;
  if (skinned) {
    return (
      <span className={`h-1.25 min-w-0 flex-1 overflow-hidden ${skinCss.bgDeep} ${skinCss.radiusSm}`}>
        <span
          className={`block h-full origin-left ${skinCss.radiusSm} ${fillClass ?? ""}`}
          style={fillClass ? { transform: scale } : { transform: scale, backgroundColor: color }}
        />
      </span>
    );
  }
  return (
    <span className="h-1.25 min-w-0 flex-1 overflow-hidden rounded-full bg-lc-titanium">
      <span className="block h-full origin-left rounded-full" style={{ transform: scale, backgroundColor: color }} />
    </span>
  );
};

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
  const skin = useHudSkin();
  const text = useTunerText();
  const tuner = telemetry.liveTuner ?? FALLBACK_TUNER;
  const { tc: tcActive, abs: absActive } = aidsActive(telemetry);
  const tc = tuner.tcLevel > 0 ? text.tx("chips.tc", { level: tuner.tcLevel, cut: tuner.tc2Level }) : text.tcOff;
  const abs = tuner.absLevel > 0 ? text.tx("chips.abs", { level: tuner.absLevel }) : text.absOff;
  const bias = text.tx("chips.bias", { bias: tuner.brakeBiasPct.toFixed(1) });
  if (skin !== null) {
    return (
      <div className="flex items-center gap-1">
        <SkinTag tone={tcActive ? "caution" : "default"} filled={tcActive} className="px-1.5 py-0.5 text-[10px] font-semibold">
          {tc}
        </SkinTag>
        <SkinTag tone={absActive ? "caution" : "default"} filled={absActive} className="px-1.5 py-0.5 text-[10px] font-semibold">
          {abs}
        </SkinTag>
        <SkinTag className="lc-mono px-1.5 py-0.5 text-[10px] font-semibold">{bias}</SkinTag>
        <SkinTag className="px-1.5 py-0.5 text-[10px] font-semibold">{text.phases[tuner.diffActivePhase]}</SkinTag>
      </div>
    );
  }
  return (
    // An aid lights solid caution while it intervenes; the rest are neutral read-outs
    <div className="flex items-center gap-1">
      <Badge tone={tcActive ? "warn" : "neutral"} variant={tcActive ? "solid" : "soft"} size="sm">
        {tc}
      </Badge>
      <Badge tone={absActive ? "warn" : "neutral"} variant={absActive ? "solid" : "soft"} size="sm">
        {abs}
      </Badge>
      <Badge size="sm" className="lc-mono">
        {bias}
      </Badge>
      <Badge size="sm">{text.phases[tuner.diffActivePhase]}</Badge>
    </div>
  );
};

/**
 * Live electronics tuner (TC, ABS, brake bias, diff, engine map, ERS), laid out for one thumb on the D-pad while
 * driving: left / right picks the dial, up / down changes it (keys , . and − =). Every dial draws the same blocks at the same size,
 * so nothing moves while you step through them. [ and ] are the cockpit FOV's keys, not the tuner's. The D-pad and keys
 * act only while the HUD is live (not under the pause menu, a replay or the results card).
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
  const skin = useHudSkin();
  const text = useTunerText();
  const tuner = telemetry.liveTuner ?? FALLBACK_TUNER;

  const dials = useMemo(() => ALL_DIALS.filter((d) => (d.id === "ers_mode" ? tuner.hasErs : true)), [tuner.hasErs]);

  // The dial by id: on a car without ERS the list is shorter, and an index would land on a different dial
  const [dialId, setDialId] = useState<MfdDialId>("tc1");
  const [ownCollapsed, setCollapsed] = useState(defaultCollapsed);
  const hudModeRef = useHudModeRef();
  // Embedded, the multi-page MFD folds and unfolds; this panel is then always open
  const collapsed = embedded ? false : ownCollapsed;
  const interactRef = useRef(onInteract);
  interactRef.current = onInteract;
  const mfdStateRef = useRef({ embedded, folded, hidden, onWake, onCyclePage });
  mfdStateRef.current = { embedded, folded, hidden, onWake, onCyclePage };
  // The MFD pad button (L3 by default) opens and closes it
  useEffect(() => {
    if (embedded) return;
    const toggle = () => {
      if (hudModeRef.current !== "hidden") setCollapsed((c) => !c);
    };
    window.addEventListener(HUD_TOGGLE_EVENT.mfd, toggle);
    return () => window.removeEventListener(HUD_TOGGLE_EVENT.mfd, toggle);
  }, [embedded, hudModeRef]);
  const [flashDir, setFlashDir] = useState<"up" | "down" | "left" | "right" | null>(null);

  // A dial this car lacks (ERS) shows the first one of its group until the player picks another
  const activeDial =
    dials.find((d) => d.id === dialId) ??
    dials.find((d) => d.category === ALL_DIALS.find((a) => a.id === dialId)?.category) ??
    dials[0];
  const activeText = text.dials[activeDial.id];
  const categoryDials = useMemo(() => dials.filter((d) => d.category === activeDial.category), [dials, activeDial.category]);

  const tcActive = aidsActive(telemetry).tc;

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

  // Folded or hidden, a press wakes the MFD or steps its pages, never a dial: the guard is the state itself, not
  // whether the optional callbacks were passed
  const cycleDial = useCallback(
    (delta: -1 | 1) => {
      const m = mfdStateRef.current;
      if (m.embedded && m.folded) {
        m.onWake?.();
        return;
      }
      if (m.embedded && m.hidden) {
        m.onCyclePage?.(delta);
        return;
      }
      setCollapsed(false);
      interactRef.current?.();
      // From the dial on screen (the fallback one when the stored dial is not on this car)
      const at = Math.max(0, dials.findIndex((d) => d.id === activeDial.id));
      setDialId(dials[(at + delta + dials.length) % dials.length].id);
      triggerFlash(delta < 0 ? "left" : "right");
    },
    [dials, activeDial.id, triggerFlash]
  );

  const pickDial = useCallback(
    (id: MfdDialId) => {
      if (!dials.some((d) => d.id === id)) return;
      interactRef.current?.();
      setDialId(id);
    },
    [dials]
  );

  const adjustActiveDial = useCallback(
    (dir: -1 | 1) => {
      const m = mfdStateRef.current;
      if (m.embedded && m.folded) {
        m.onWake?.();
        return;
      }
      if (m.embedded && m.hidden) {
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

    /** Forget the buttons: the next frame only records them, so one held through a menu fires nothing */
    const disarm = () => {
      prev = null;
      repeatAt.fill(Infinity);
    };

    const poll = (nowMs: number) => {
      raf = requestAnimationFrame(poll);
      // The pause menu, a replay and the results card own the D-pad (the HUD is only mounted while driving)
      if (hudModeRef.current !== "live") {
        disarm();
        return;
      }
      const pads = connectedPads();
      const pad = pads.find((p) => p.mapping === "standard") ?? pads[0];
      if (!pad) {
        disarm();
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
  }, [hudModeRef]);

  // Keyboard shortcuts: , / . cycle MFD dials; - / = adjust value ([ / ] belong to the cockpit FOV)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // With Alt held these keys move the camera instead (drive-session)
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || hudModeRef.current !== "live" || e.altKey) {
        return;
      }
      if (e.key === "," || e.key === "<") {
        e.preventDefault();
        actionsRef.current.cycleDial(-1);
      } else if (e.key === "." || e.key === ">") {
        e.preventDefault();
        actionsRef.current.cycleDial(1);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        actionsRef.current.adjustActiveDial(-1);
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        actionsRef.current.adjustActiveDial(1);
      }
    };
    // Added once: the actions come from the ref, so a new tuner state each physics step doesn't re-add it
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hudModeRef]);

  // The active dial's value, a short tag beside its name, and its segment bar
  const hero = useMemo((): { text: string; tag: string; segments: number; filled: number; off: boolean } => {
    const lvl = (v: number, offAtZero: boolean) => ({
      text: offAtZero && v <= 0 ? text.off : String(v),
      tag: offAtZero && v <= 0 ? "" : text.ofMax,
      segments: 12,
      filled: v,
      off: offAtZero && v <= 0,
    });
    const lock = (v: number) => ({ ...lvl(v, false), tag: text.tx("hero.lock", { pct: Math.round(((v - 1) / 11) * 100) }) });
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
          tag: text.front,
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
        return {
          text: text.tx("hero.map", { map: tuner.engineMap }),
          tag: ENGINE_MAPS[tuner.engineMap] ? text.engineMaps[ENGINE_MAPS[tuner.engineMap].tag] : "",
          segments: 5,
          filled: tuner.engineMap,
          off: false,
        };
      case "ers_mode": {
        const idx = Math.max(0, ERS_MODES.indexOf(tuner.ersMode as (typeof ERS_MODES)[number]));
        return {
          text: tuner.ersMode,
          tag: text.ersModes[tuner.ersMode as (typeof ERS_MODES)[number]] ?? "",
          segments: 5,
          filled: idx + 1,
          off: tuner.ersMode === "CHR",
        };
      }
    }
  }, [activeDial.id, tuner, text]);

  if (embedded && hidden) return null;

  // One live line under the dial: what that dial is doing right now
  const live = (skinned = false): React.ReactNode => {
    switch (activeDial.category) {
      case "tc":
        return (
          <>
            <span className={skinned ? skinCss.label : MFD_LBL}>{text.cut}</span>
            {skinned ? <LiveBar frac={tuner.tcCutFraction} skinned fillClass={skinCss.fillCaution} /> : <LiveBar frac={tuner.tcCutFraction} color={HUD_CAUTION} />}
            <span
              className={`lc-data w-9.5 text-end text-[12px] ${skinned ? (tcActive ? skinCss.inkCaution : skinCss.ink) : ""}`}
              style={skinned ? undefined : { color: tcActive ? HUD_CAUTION : "var(--color-lc-chalk)" }}
            >
              {Math.round(tuner.tcCutFraction * 100)}%
            </span>
          </>
        );
      case "abs":
        return (["FL", "FR", "RL", "RR"] as const).map((c, i) => (
          <span key={c} className="flex min-w-0 flex-1 items-center gap-1">
            <span className={skinned ? skinCss.label : `${HUD_LBL} tracking-normal`}>{text.wheels[i]}</span>
            {skinned ? (
              <LiveBar frac={tuner.absCutPerWheel[i] ?? 0} skinned fillClass={skinCss.fillCaution} />
            ) : (
              <LiveBar frac={tuner.absCutPerWheel[i] ?? 0} color={HUD_CAUTION} />
            )}
          </span>
        ));
      case "bias":
        return (
          <>
            <span className={`lc-data text-[12px] ${skinned ? skinCss.ink : "text-lc-chalk"}`}>{text.tx("live.front", { bias: tuner.brakeBiasPct.toFixed(1) })}</span>
            <span className={`flex h-1.25 min-w-0 flex-1 gap-px overflow-hidden ${skinned ? skinCss.radiusSm : "rounded-full"}`}>
              <span className={`h-full ${skinned ? skinCss.fillAccent : "bg-lc-chalk"}`} style={{ width: `${tuner.brakeBiasPct}%` }} />
              <span className={`h-full flex-1 ${skinned ? skinCss.fillDim : "bg-lc-keyline"}`} />
            </span>
            <span className={`lc-data text-[12px] ${skinned ? skinCss.inkSoft : "text-lc-fog"}`}>{text.tx("live.rear", { bias: (100 - tuner.brakeBiasPct).toFixed(1) })}</span>
          </>
        );
      case "diff":
        return (
          <>
            {(["ENTRY", "MID", "EXIT"] as const).map((ph) =>
              skinned ? (
                <SkinTag
                  key={ph}
                  tone={tuner.diffActivePhase === ph ? "accent" : "default"}
                  filled={tuner.diffActivePhase === ph}
                  className="px-1.5 py-0.5 text-[9px] font-bold uppercase"
                >
                  {text.phases[ph]}
                </SkinTag>
              ) : (
                <Badge key={ph} size="hud" variant={tuner.diffActivePhase === ph ? "solid" : "soft"} dot={tuner.diffActivePhase === ph ? true : undefined}>
                  {text.phases[ph]}
                </Badge>
              ),
            )}
            <span className={`lc-data ms-auto text-[12px] ${skinned ? skinCss.ink : "text-lc-chalk"}`}>{tuner.diffLockingTorqueNm} Nm</span>
          </>
        );
      case "pwr":
        return activeDial.id === "engine_map" ? (
          <>
            <span className={skinned ? `text-[10px] font-semibold uppercase ${skinCss.inkDim}` : MFD_LBL}>{text.torque}</span>
            <span className={`lc-data ms-auto text-[12px] ${skinned ? skinCss.ink : "text-lc-chalk"}`}>{ENGINE_MAPS[tuner.engineMap]?.torquePct ?? 100}%</span>
          </>
        ) : (
          <>
            <span className={skinned ? `text-[10px] font-semibold uppercase ${skinCss.inkDim}` : MFD_LBL}>{text.battery}</span>
            {skinned ? (
              <LiveBar frac={telemetry.ersBatteryPercent / 100} skinned fillClass={skinCss.fillInfo} />
            ) : (
              <LiveBar frac={telemetry.ersBatteryPercent / 100} color={HUD_INFO} />
            )}
            <span className={`lc-data w-9.5 text-end text-[12px] ${skinned ? skinCss.inkInfo : "text-lc-info"}`}>
              {Math.round(telemetry.ersBatteryPercent)}%
            </span>
          </>
        );
    }
  };

  if (skin !== null) {
    const skinnedBody = (
      <div className={`flex h-53 flex-col gap-1.5 ${skinRootClass(skin) ?? ""}`}>
        <div className="flex h-7 items-center gap-1">
          <SkinButton
            active={flashDir === "left"}
            onClick={() => cycleDial(-1)}
            className="size-7 shrink-0"
            title={text.previousDialHint}
            aria-label={text.previousDial}
          >
            <Icon name="previous" size="sm" />
          </SkinButton>
          <div className={`flex min-w-0 flex-1 gap-0.5 ${skinCss.tablist}`}>
            {CATEGORIES.map((cat) => (
              <SkinButton
                key={cat.id}
                active={activeDial.category === cat.id}
                onClick={() => {
                  const first = dials.find((d) => d.category === cat.id);
                  if (first) pickDial(first.id);
                }}
                className="h-7 min-w-0 flex-1 text-[10px] font-bold tracking-[0.06em] uppercase"
              >
                {text.categories[cat.id]}
              </SkinButton>
            ))}
          </div>
          <SkinButton
            active={flashDir === "right"}
            onClick={() => cycleDial(1)}
            className="size-7 shrink-0"
            title={text.nextDialHint}
            aria-label={text.nextDial}
          >
            <Icon name="next" size="sm" />
          </SkinButton>
        </div>

        <div className={`flex h-5.5 gap-1 ${skinCss.tablist}`}>
          {categoryDials.map((d) => {
            const selected = d.id === activeDial.id;
            return (
              <SkinButton
                key={d.id}
                active={selected}
                soft
                onClick={() => pickDial(d.id)}
                className="h-5.5 min-w-0 flex-1 text-[9px] font-bold tracking-[0.06em] uppercase"
              >
                {text.dials[d.id].label}
              </SkinButton>
            );
          })}
        </div>

        <div className={`flex min-h-0 flex-1 flex-col justify-between px-2.5 py-2 ${skinCss.deepBox}`}>
          <div className="flex items-baseline justify-between">
            <span className={`${skinCss.label} ${skinCss.ink}`}>{activeText.title}</span>
            <span className={skinCss.label}>{hero.tag}</span>
          </div>
          <div className="flex items-center justify-between">
            <SkinButton
              active={flashDir === "down"}
              onClick={() => adjustActiveDial(-1)}
              className="size-9 shrink-0"
              aria-label={text.tx("lower", { dial: activeText.title })}
              title={text.tx("lowerHint", { hint: activeText.lowHint })}
            >
              <Icon name="remove" size="sm" />
            </SkinButton>
            <span className={`lc-data text-[36px] leading-none ${skinCss.readout} ${hero.off ? skinCss.inkDim : skinCss.ink}`}>{hero.text}</span>
            <SkinButton
              active={flashDir === "up"}
              onClick={() => adjustActiveDial(1)}
              className="size-9 shrink-0"
              aria-label={text.tx("raise", { dial: activeText.title })}
              title={text.tx("raiseHint", { hint: activeText.highHint })}
            >
              <Icon name="add" size="sm" />
            </SkinButton>
          </div>
          <div className="flex h-1.25 gap-0.5" aria-hidden>
            {Array.from({ length: hero.segments }, (_, k) => (
              <span
                key={k}
                className={`h-full flex-1 ${skinCss.radiusSm} ${!hero.off && k < hero.filled ? skinCss.fillAccent : skinCss.fillDim}`}
              />
            ))}
          </div>
        </div>

        <div className={`flex h-7.5 items-center gap-2 px-2.5 ${skinCss.subBar} ${skinCss.radiusSm}`}>{live(true)}</div>
      </div>
    );

    if (embedded) return <div className={`w-full ${className}`}>{skinnedBody}</div>;

    return (
      <SkinPanel
        cut={collapsed ? "sm" : "md"}
        className={`pointer-events-auto select-none ${collapsed ? "w-max" : "w-75"} ${className}`}
        innerClassName={collapsed ? "p-1.5" : "flex flex-col gap-2 p-2.5"}
      >
        <div className="flex items-center justify-between gap-1">
          <MfdStatusChips telemetry={telemetry} />
          <SkinButton
            onClick={() => setCollapsed((c) => !c)}
            className="size-6.5 shrink-0"
            aria-label={collapsed ? text.openTuner : text.foldTuner}
          >
            <Icon name={collapsed ? "collapse" : "expand"} size="xs" />
          </SkinButton>
        </div>
        {collapsed ? null : skinnedBody}
      </SkinPanel>
    );
  }

  const body = (
    <div className="flex h-53 flex-col gap-1.5">
      {/* Category strip with the previous / next dial buttons */}
      <div className="flex h-7 items-center gap-1">
        <button
          type="button"
          onClick={() => cycleDial(-1)}
          className={`${MFD_ROUND_BTN} size-7 ${flashDir === "left" ? MFD_ROUND_FLASH : `${MFD_ROUND_IDLE} text-lc-slate`}`}
          title={text.previousDialHint}
          aria-label={text.previousDial}
        >
          <Icon name="previous" size="sm" />
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
              className={`lc-chip-text h-7 min-w-0 flex-1 rounded-lc-nub text-[10px] ${HUD_CONTROL} ${
                // Chosen is chalk on line with a hairline (UI standard §4); volt stays the cursor
                activeDial.category === cat.id ? HUD_CHOSEN : HUD_IDLE
              }`}
            >
              {text.categories[cat.id]}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => cycleDial(1)}
          className={`${MFD_ROUND_BTN} size-7 ${flashDir === "right" ? MFD_ROUND_FLASH : `${MFD_ROUND_IDLE} text-lc-slate`}`}
          title={text.nextDialHint}
          aria-label={text.nextDial}
        >
          <Icon name="next" size="sm" />
        </button>
      </div>

      {/* The dials in this group: always one row, so the layout never jumps */}
      <div className="flex h-5.5 gap-1">
        {categoryDials.map((d) => {
          const selected = d.id === activeDial.id;
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => pickDial(d.id)}
              className={`lc-chip-text h-5.5 min-w-0 flex-1 rounded-lc-nub border text-[9px] ${HUD_CONTROL} ${
                selected ? `border-transparent ${HUD_CHOSEN}` : `border-lc-line ${HUD_IDLE}`
              }`}
            >
              {text.dials[d.id].label}
            </button>
          );
        })}
      </div>

      {/* Value card */}
      <div className="flex min-h-0 flex-1 flex-col justify-between rounded-lc-tile border border-lc-titanium bg-lc-well px-2.5 py-2">
        <div className="flex items-baseline justify-between">
          <span className="lc-chip-text text-lc-chalk">{activeText.title}</span>
          <span className={MFD_LBL}>{hero.tag}</span>
        </div>
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => adjustActiveDial(-1)}
            className={`${MFD_ROUND_BTN} size-9 ${flashDir === "down" ? MFD_ROUND_FLASH : `${MFD_ROUND_IDLE} text-lc-chalk`}`}
            aria-label={text.tx("lower", { dial: activeText.title })}
            title={text.tx("lowerHint", { hint: activeText.lowHint })}
          >
            <Icon name="remove" size="sm" />
          </button>
          <span className="lc-data text-[38px] leading-none" style={{ color: hero.off ? "var(--color-lc-slate)" : activeDial.accent }}>
            {hero.text}
          </span>
          <button
            type="button"
            onClick={() => adjustActiveDial(1)}
            className={`${MFD_ROUND_BTN} size-9 ${flashDir === "up" ? MFD_ROUND_FLASH : `${MFD_ROUND_IDLE} text-lc-chalk`}`}
            aria-label={text.tx("raise", { dial: activeText.title })}
            title={text.tx("raiseHint", { hint: activeText.highHint })}
          >
            <Icon name="add" size="sm" />
          </button>
        </div>
        <div className="flex h-1.25 gap-0.5" aria-hidden>
          {Array.from({ length: hero.segments }, (_, k) => (
            <span
              key={k}
              className="h-full flex-1 rounded-full"
              style={{ backgroundColor: !hero.off && k < hero.filled ? activeDial.accent : "var(--color-lc-titanium)" }}
            />
          ))}
        </div>
      </div>

      {/* Live line */}
      <div className="flex h-7.5 items-center gap-2 rounded-lc-row bg-white/3 px-2.5">{live()}</div>
    </div>
  );

  if (embedded) return <div className={`w-full ${className}`}>{body}</div>;

  return (
    <div
      className={`pointer-events-auto select-none overflow-hidden ${HUD_GLASS} ${
        collapsed ? "w-max rounded-lc-row p-1.5" : "flex w-75 flex-col gap-2 rounded-lc-card p-2.5"
      } ${className}`}
    >
      <div className="flex items-center justify-between gap-1">
        <MfdStatusChips telemetry={telemetry} />
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className={`flex size-6.5 shrink-0 items-center justify-center rounded-lc-nub ${HUD_IDLE} ${HUD_CONTROL}`}
          aria-label={collapsed ? text.openTuner : text.foldTuner}
        >
          <Icon name={collapsed ? "collapse" : "expand"} size="xs" />
        </button>
      </div>
      {collapsed ? null : body}
    </div>
  );
};
