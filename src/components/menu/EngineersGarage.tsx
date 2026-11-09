"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChevronLeft, LayoutGrid, X } from "lucide-react";
import type { AeroSetupPreset, LiveTunerPatch, LiveTunerState, TireCompound } from "@/types/f1";
import { DEFAULT_CHASSIS_SETUP, loadGaragePresets, saveGaragePresets, type GaragePreset, type GarageTuner } from "@/lib/sim/car-setup";
import { setupSheet, type SetupEffect, type SetupGroup, type SetupParam, type SetupState } from "@/lib/sim/setup-sheet";
import { COMPOUNDS, PanelSection, type PauseMenuProps } from "@/components/hud/PauseMenu";
import { TYRE_SETUP_LIMITS } from "@/lib/sim/tyre-setup";
import { CarPhysicsSwitch } from "./CarPicker";
import { CarBrowser } from "./CarBrowser";
import { CarQualityBadge, CHOSEN_PILL, Chip, CURSOR_PILL, LiveryPicker, PadGlyph, Segmented } from "./menu-ui";
import { currentInputMode, useInputMode } from "./input-mode";
import { focusOnHover } from "./useFocusNav";
import { carTakesPhysicsSwitch } from "@/lib/cars/f1-mod-physics";
import { TyreBrakeGrid } from "@/components/hud/TyreBrakeWidget";
import { LIVERIES } from "@/lib/track-data";

const TIRE_COMPOUNDS: readonly TireCompound[] = ["soft", "medium", "hard", "intermediate", "wet"];
const AERO_PRESETS: readonly AeroSetupPreset[] = ["low_downforce", "balanced", "high_downforce"];
import { CARS, FACTORY_LIVERY_NOTE, carById, carClassYear, carTakesLivery } from "@/lib/cars/car-registry";
import { vehicleModelSpec } from "@/lib/cars/vehicle-models";

const FALLBACK_TUNER: Pick<
  LiveTunerState,
  "tcLevel" | "tc2Level" | "absLevel" | "brakeBiasPct" | "brakeMigrationPct" | "diffEntry" | "diffMid" | "diffExit" | "engineMap" | "hasErs"
> = { tcLevel: 5, tc2Level: 6, absLevel: 5, brakeBiasPct: 56, brakeMigrationPct: 2.5, diffEntry: 3, diffMid: 5, diffExit: 5, engineMap: 2, hasErs: true };

/** Changed from the car's baseline (the electronics have no fixed baseline: each car and assist level brings its own) */
const isChanged = (q: SetupParam, st: SetupState) => q.writes !== "tuner" && Math.abs(q.get(st) - q.base) > 1e-6;

/** The garage's segmented rows run a little tighter than the menus' */
const GARAGE_SEGMENTED = "[&>button]:min-h-[38px] [&>button]:px-2 [&>button]:text-[13px]";

/**
 * One setup row: label, readout, slider with the baseline marked, and a plain-English line on what the current
 * direction does (the full both-ways text sits in the info tooltip).
 */
const SetupRow: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  base?: number;
  format: (v: number) => string;
  fx?: SetupEffect;
  /** The effect text's "more" is the slider's left side (e.g. more negative camber) */
  invert?: boolean;
  disabled?: boolean;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, step, base, format, fx, invert = false, disabled = false, onChange }) => {
  const pct = ((value - min) / (max - min || 1)) * 100;
  const basePct = base === undefined ? null : ((base - min) / (max - min || 1)) * 100;
  // Without a baseline (the electronics' dials), the text follows the way the slider last moved
  const [moved, setMoved] = useState(0);
  const dir = (base === undefined ? moved : Math.sign(value - base)) * (invert ? -1 : 1);
  const text = fx ? (dir > 0 ? fx.more : dir < 0 ? fx.less : base === undefined ? `▲ ${fx.more}` : "Baseline.") : null;
  const change = (v: number) => {
    if (v !== value) setMoved(Math.sign(v - value));
    onChange(v);
  };
  return (
    <label className={`group/row flex flex-col gap-2 rounded-[14px] px-2 py-2 hover:bg-white/[0.04] ${disabled ? "opacity-45" : ""}`}>
      <span className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 text-[14px] leading-tight font-bold text-[#F5F7FA]">{label}</span>
          {fx ? (
            <span aria-hidden className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[#3A4157] font-f1-mono text-[9px] font-extrabold text-[#8E96AA]">
              i
            </span>
          ) : null}
        </span>
        <span className="shrink-0 font-f1-mono text-sm font-extrabold whitespace-nowrap text-[#F5F7FA] tabular-nums">{format(value)}</span>
      </span>
      <span className="relative">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => change(Number((Math.round(Number(e.target.value) / step) * step).toFixed(3)))}
          onDoubleClick={() => (base !== undefined ? change(base) : undefined)}
          className="lc-range w-full"
          style={{ "--lc-fill": `${pct}%` } as React.CSSProperties}
        />
        {basePct !== null ? (
          <span aria-hidden className="pointer-events-none absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full bg-[#F5F7FA]/40" style={{ left: `${basePct}%` }} />
        ) : null}
      </span>
      {text ? <span className={`text-[12px] leading-[1.4] ${dir === 0 ? "text-[#8E96AA]" : "text-[#C5CBD8]"}`}>{text}</span> : null}
      {/* Both ways, where a controller or keyboard can read it too: shown while the row is pointed at or focused */}
      {fx ? (
        <span className="hidden flex-col gap-0.5 rounded-[10px] bg-[#08090D]/70 px-2.5 py-2 text-[12px] leading-[1.4] text-[#C5CBD8] group-focus-within/row:flex group-hover/row:flex">
          <span>
            <span className="font-bold text-[#F5F7FA]">{invert ? "Left" : "Right"}:</span> {fx.more.replace(/^▲\s*/, "")}
          </span>
          <span>
            <span className="font-bold text-[#F5F7FA]">{invert ? "Right" : "Left"}:</span> {fx.less.replace(/^▼\s*/, "")}
          </span>
        </span>
      ) : null}
    </label>
  );
};

const GarageCard: React.FC<{ title: string; color?: string; children: React.ReactNode; aside?: React.ReactNode }> = ({ title, color, children, aside }) => (
  <div className="flex min-w-0 flex-col gap-2 rounded-[20px] border border-[#262B3D] bg-[#08090D]/55 p-4">
    <div className="flex items-center justify-between gap-3">
      <PanelSection color={color}>{title}</PanelSection>
      {aside}
    </div>
    {children}
  </div>
);

const SmallButton: React.FC<{ onClick: () => void; children: React.ReactNode; tone?: "volt" | "plain" | "danger"; disabled?: boolean; title?: string }> = ({
  onClick,
  children,
  tone = "plain",
  disabled,
  title,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    onPointerEnter={focusOnHover}
    className={`inline-flex h-9 shrink-0 cursor-pointer items-center rounded-full px-3.5 font-f1-mono text-[11px] font-extrabold tracking-[0.12em] uppercase transition-[background-color,border-color,box-shadow,color] duration-200 disabled:cursor-not-allowed disabled:opacity-40 ${CURSOR_PILL} focus:border-transparent ${
      tone === "volt"
        ? "border border-[#F5F7FA]/40 text-[#F5F7FA] hover:border-[#F5F7FA]"
        : tone === "danger"
          ? "border border-[#262B3D] text-[#8E96AA] hover:border-[#FF2A3C] hover:text-[#FF2A3C]"
          : "border border-[#262B3D] text-[#C5CBD8] hover:border-[#3A4157] hover:text-[#F5F7FA]"
    }`}
  >
    {children}
  </button>
);

/**
 * Engineer's Garage: the car's setup sheet (one layout for the F1 cars, another for the GT3s, shared by every car
 * of the class), and named presets saved per car. Opened from the title screen's Garage and from Pause → Car setup.
 */
export const EngineersGarage: React.FC<
  PauseMenuProps & {
    /** Change car opens this instead of the garage's own car browser (the title menu's Car panel) */
    onOpenCarBrowser?: () => void;
  }
> = (p) => {
  const sheet = useMemo(() => setupSheet(p.vehicleModel, TYRE_SETUP_LIMITS[p.vehicleModel], p.defaultTyreSetup), [p.vehicleModel, p.defaultTyreSetup]);
  const [tabId, setTab] = useState(sheet[0].id);
  const group: SetupGroup = sheet.find((g) => g.id === tabId) ?? sheet[0];
  const chassis = p.chassisSetup ?? DEFAULT_CHASSIS_SETUP;
  const tuner = { ...FALLBACK_TUNER, ...(p.telemetry.liveTuner ?? {}) };
  const canTune = Boolean(p.onChangeLiveTuner);
  const canChassis = Boolean(p.onChangeChassisSetup);

  // Presets, per car
  const [presets, setPresets] = useState<GaragePreset[]>([]);
  const [name, setName] = useState("");
  // Each note is its own toast: the same text twice (Reset, Reset) restarts its timer. One that can be undone stays longer
  const [note, setNoteState] = useState<{ text: string; seq: number; undo?: () => void } | null>(null);
  const noteSeq = useRef(0);
  const setNote = (text: string, undo?: () => void) => setNoteState({ text, seq: ++noteSeq.current, undo });
  useEffect(() => setPresets(loadGaragePresets(p.vehicleModel)), [p.vehicleModel]);
  useEffect(() => {
    if (!note) return;
    const id = window.setTimeout(() => setNoteState(null), note.undo ? 8000 : 2400);
    return () => window.clearTimeout(id);
  }, [note]);

  const currentTuner: GarageTuner = {
    tcLevel: tuner.tcLevel,
    tc2Level: tuner.tc2Level,
    absLevel: tuner.absLevel,
    brakeBiasPct: tuner.brakeBiasPct,
    brakeMigrationPct: tuner.brakeMigrationPct,
    diffEntry: tuner.diffEntry,
    diffMid: tuner.diffMid,
    diffExit: tuner.diffExit,
    engineMap: tuner.engineMap,
  };
  const st: SetupState = { chassis, tyre: p.tyreSetup, tuner: currentTuner };
  /** The whole setup as it stands, so an action that overwrites it can be undone */
  const snapshot = () => ({ chassis: { ...chassis }, tyre: p.tyreSetup, compound: p.tireCompound, aero: p.aeroPreset, tuner: { ...currentTuner } });
  const restore = (s: ReturnType<typeof snapshot>) => {
    p.onChangeChassisSetup?.(s.chassis);
    p.onChangeTyreSetup(s.tyre);
    p.onChangeTireCompound(s.compound);
    p.onChangeAeroPreset(s.aero);
    p.onChangeLiveTuner?.(s.tuner);
  };
  const canWrite = (q: SetupParam) => (q.writes === "chassis" ? canChassis : q.writes === "tuner" ? canTune : true);
  const apply = (q: SetupParam, v: number) => {
    const next = q.set(st, v);
    if (q.writes === "chassis") p.onChangeChassisSetup?.(next.chassis);
    else if (q.writes === "tyre") p.onChangeTyreSetup(next.tyre);
    else p.onChangeLiveTuner?.({ [q.id]: next.tuner[q.id as keyof GarageTuner] } as LiveTunerPatch);
  };
  /** The page's settings back at the car's baseline (the electronics stay as they are) */
  const resetGroup = (g: SetupGroup) => {
    const before = snapshot();
    let next = st;
    for (const q of g.params) if (q.writes !== "tuner") next = q.set(next, q.base);
    if (g.params.some((q) => q.writes === "chassis")) p.onChangeChassisSetup?.(next.chassis);
    if (g.params.some((q) => q.writes === "tyre")) p.onChangeTyreSetup(next.tyre);
    setNote(`${g.label} back to baseline`, () => restore(before));
  };

  const savePreset = () => {
    // An unnamed save gets the first free "Setup N": counting the list could land on a name already taken (after a
    // delete), and a matching name below means overwrite
    let label = name.trim();
    if (!label) {
      const taken = new Set(presets.map((x) => x.name.toLowerCase()));
      let n = presets.length + 1;
      while (taken.has(`setup ${n}`)) n++;
      label = `Setup ${n}`;
    }
    const existing = presets.find((x) => x.name.toLowerCase() === label.toLowerCase());
    const preset: GaragePreset = {
      id: existing?.id ?? `${Date.now().toString(36)}`,
      name: label.slice(0, 32),
      savedAt: Date.now(),
      vehicle: p.vehicleModel,
      chassis,
      tyre: p.tyreSetup,
      compound: p.tireCompound,
      aero: p.aeroPreset,
      tuner: currentTuner,
    };
    const next = [preset, ...presets.filter((x) => x.id !== preset.id)];
    setPresets(next);
    setName("");
    setNote(saveGaragePresets(p.vehicleModel, next) ? `Saved “${preset.name}”` : "Could not save: storage is blocked");
  };
  const loadPreset = (x: GaragePreset) => {
    const before = snapshot();
    // Saved presets come from storage: every value goes back through the sheet's own range (as the sliders would),
    // so a hand-edited or older preset cannot hand the car a value no slider can produce
    let loaded: SetupState = {
      chassis: x.chassis ?? chassis,
      tyre: x.tyre ?? p.tyreSetup,
      tuner: { ...currentTuner, ...(x.tuner ?? {}) },
    };
    for (const group of sheet) {
      for (const param of group.params) {
        const v = param.get(loaded);
        const safe = Number.isFinite(v) ? Math.min(param.max, Math.max(param.min, v)) : param.base;
        if (safe !== v) loaded = param.set(loaded, safe);
      }
    }
    p.onChangeChassisSetup?.(loaded.chassis);
    p.onChangeTyreSetup(loaded.tyre);
    if (TIRE_COMPOUNDS.includes(x.compound)) p.onChangeTireCompound(x.compound);
    if (AERO_PRESETS.includes(x.aero)) p.onChangeAeroPreset(x.aero);
    p.onChangeLiveTuner?.(loaded.tuner);
    setNote(`Loaded “${x.name}”`, () => restore(before));
  };
  const deletePreset = (x: GaragePreset) => {
    const before = presets;
    const next = presets.filter((y) => y.id !== x.id);
    setPresets(next);
    saveGaragePresets(p.vehicleModel, next);
    setNote(`Deleted “${x.name}”`, () => {
      setPresets(before);
      saveGaragePresets(p.vehicleModel, before);
    });
  };
  const resetAll = () => {
    const before = snapshot();
    p.onChangeChassisSetup?.({ ...DEFAULT_CHASSIS_SETUP });
    p.onChangeTyreSetup(p.defaultTyreSetup);
    p.onChangeAeroPreset("balanced");
    setNote("Every setting back to baseline", () => restore(before));
  };

  // The car browser takes the garage's place while it is open; Ⓑ / Esc (or Garage) comes back to the Change car button
  const [browsing, setBrowsing] = useState(false);
  const browseRef = useRef<HTMLButtonElement | null>(null);
  const { mode, family } = useInputMode();
  // The car is fixed for an online race (the shell refuses the swap too)
  const carLocked = p.telemetry.race?.multiplayer === true || p.raceRunning === true;
  const openBrowser = () => {
    if (carLocked) return;
    if (p.onOpenCarBrowser) return p.onOpenCarBrowser();
    flushSync(() => setBrowsing(true));
    if (currentInputMode() === "pointer") return;
    const card = document.querySelector<HTMLElement>(`[data-browser-item="${CSS.escape(p.carId)}"]`);
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: "nearest" });
  };
  const closeBrowser = () => {
    flushSync(() => setBrowsing(false));
    if (currentInputMode() !== "pointer") browseRef.current?.focus({ preventScroll: true });
  };
  const car = carById(p.carId);

  const changedIn = (g: SetupGroup) => g.params.filter((q) => isChanged(q, st)).length;
  const groupChanged = changedIn(group);
  const live = Boolean(group.extras?.includes("liveTyres"));

  const extra = (x: string) => {
    const onlyTyre = vehicleModelSpec(car.physics).onlyTyre;
    if (x === "compound" && onlyTyre)
      return (
        <div key={x} className="flex min-h-[46px] items-center rounded-full border border-[#262B3D] bg-[#08090D] px-4 text-[13px] font-bold text-[#C5CBD8]">
          {onlyTyre}
        </div>
      );
    if (x === "compound")
      return (
        <Segmented<TireCompound>
          key={x}
          label="Tyre compound"
          className={GARAGE_SEGMENTED}
          value={p.tireCompound}
          onChange={p.onChangeTireCompound}
          options={COMPOUNDS.map((c) => ({
            id: c.id,
            label: (
              <>
                <span aria-hidden className="h-3.5 w-3.5 rounded-full border-[3px] bg-[#08090D]" style={{ borderColor: c.ring }} />
                {c.label}
              </>
            ),
          }))}
        />
      );
    if (x === "aeroPackage")
      return (
        <Segmented<AeroSetupPreset>
          key={x}
          label="Aero package"
          className={GARAGE_SEGMENTED}
          value={p.aeroPreset}
          onChange={p.onChangeAeroPreset}
          options={[
            { id: "low_downforce", label: "Low downforce" },
            { id: "balanced", label: "Balanced" },
            { id: "high_downforce", label: "High downforce" },
          ]}
        />
      );
    if (x === "assists")
      return (
        <Segmented<typeof p.assistPreset>
          key={x}
          label="Assists"
          className={GARAGE_SEGMENTED}
          value={p.assistPreset}
          onChange={p.onChangeAssistPreset}
          options={[
            { id: "pro", label: "Assists off" },
            { id: "semi_pro", label: "TC + ABS" },
            { id: "assisted", label: "Full" },
          ]}
        />
      );
    return null;
  };

  const sheetClass =
    "lc-glass flex flex-col gap-[18px] rounded-[28px] p-5 text-[#F5F7FA] sm:px-7 sm:pt-6 sm:pb-[26px] short:p-4 [.lc-title-frame_&]:border-0 [.lc-title-frame_&]:bg-transparent [.lc-title-frame_&]:p-0 [.lc-title-frame_&]:shadow-none [.lc-title-frame_&]:[backdrop-filter:none]";

  if (browsing) {
    return (
      <div className={sheetClass}>
        <CarBrowser
          carId={p.carId}
          onChangeCar={p.onChangeCar}
          selectedLivery={p.selectedLivery}
          onChangeLivery={p.onChangeLivery}
          library={p.library}
          onClose={closeBrowser}
          toolbar={
            /* A pointer / touch affordance: a controller steps back with Ⓑ, so the focus skips it */
            <button
              type="button"
              data-nav-skip
              onClick={closeBrowser}
              aria-label="Back to the garage"
              className="inline-flex h-11 shrink-0 cursor-pointer items-center gap-2 rounded-full border border-[#262B3D] bg-[#08090D]/60 pr-4 pl-2.5 text-[13px] font-bold text-[#C5CBD8] transition-colors hover:border-[#3A4157] hover:text-[#F5F7FA]"
            >
              {mode === "pad" ? <PadGlyph button="b" family={family} /> : <ChevronLeft aria-hidden className="h-4 w-4" strokeWidth={2.4} />}
              Garage
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className={sheetClass}>
      {/* Car and presets */}
      <div className="flex flex-col gap-3">
        {/* The current car; the whole row opens the car browser (so the d-pad finds it from anywhere on its row) */}
        <button
          ref={browseRef}
          type="button"
          // Where the garage starts: the car, not the preset name field
          data-nav-default=""
          onClick={openBrowser}
          onPointerEnter={focusOnHover}
          disabled={carLocked}
          aria-label={carLocked ? `${car.title}: fixed for this race` : `Change car: ${car.title}`}
          className="group flex w-full cursor-pointer flex-wrap items-center gap-3 rounded-[18px] disabled:cursor-not-allowed disabled:opacity-60 border border-[#262B3D] bg-[#08090D]/55 py-3 pr-3 pl-4 text-left text-[#F5F7FA] outline-none transition-[border-color,box-shadow,background-color] duration-200 hover:border-[#3A4157] focus:border-[#CCFF00] focus:shadow-[0_0_0_5px_rgba(204,255,0,0.12)]"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex items-center gap-2">
              <Chip size="sm">{carClassYear(car)}</Chip>
              <span className="lc-data text-[11px] tracking-[0.12em] text-[#C5CBD8]">{car.badge}</span>
              <CarQualityBadge car={car} size="sm" />
            </span>
            <span className="lc-disp text-[22px] leading-[1.05]">{car.title}</span>
            <span className="truncate text-[12px] text-[#8E96AA]">{car.sub}</span>
          </span>
          <span className="inline-flex h-11 shrink-0 items-center gap-2.5 rounded-full border border-[#262B3D] bg-[#1B1F2B]/80 px-4 transition-colors group-hover:border-[#3A4157] group-focus:border-transparent group-focus:bg-[#CCFF00] group-focus:text-[#08090D]">
            <LayoutGrid aria-hidden className="h-4 w-4" strokeWidth={2.4} />
            <span className="lc-title text-[15px]">{carLocked ? "Fixed for this race" : "Change car"}</span>
            {carLocked ? null : <span className="lc-data text-[11px] opacity-70">{CARS.length}</span>}
          </span>
        </button>
        {carTakesPhysicsSwitch(p.carId) ? <CarPhysicsSwitch color="#CCFF00" /> : null}
        <div className="flex min-h-[54px] flex-wrap items-center gap-x-3 gap-y-2 rounded-[18px] border border-[#262B3D] bg-[#08090D]/55 px-3 py-2">
          <span className="lc-lbl w-[68px] shrink-0 text-[10px]">Livery</span>
          {!carTakesLivery(p.carId) ? (
            <p className="m-0 text-[13px] text-[#8E96AA]">{FACTORY_LIVERY_NOTE}</p>
          ) : (
            <LiveryPicker liveries={LIVERIES} value={p.selectedLivery} onChange={p.onChangeLivery} />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[18px] border border-[#262B3D] bg-[#08090D]/55 px-3 py-2">
          <span className="lc-lbl w-[68px] shrink-0 text-[10px]">Presets</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") savePreset();
            }}
            placeholder="Name this setup"
            maxLength={32}
            className="h-9 min-w-[160px] flex-1 rounded-full border border-[#262B3D] bg-[#08090D] px-3.5 text-[13px] text-[#F5F7FA] outline-none placeholder:text-[#8E96AA] focus:border-[#CCFF00]"
          />
          <SmallButton tone="volt" onClick={savePreset}>
            Save
          </SmallButton>
          <span aria-hidden className="mx-1 h-6 w-px bg-[#262B3D] max-sm:hidden" />
          <SmallButton tone="danger" onClick={resetAll} title="Every chassis setting, tyre pressure and camber back to the car's baseline">
            Reset all
          </SmallButton>
          {note ? (
            <div role="status" className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-[14px] border border-[#262B3D] bg-[#11131A] py-1.5 pr-1.5 pl-3.5">
              <span className="text-[14px] font-semibold text-[#F5F7FA]">{note.text}</span>
              {note.undo ? (
                <SmallButton
                  onClick={() => {
                    note.undo?.();
                    setNoteState(null);
                  }}
                >
                  Undo
                </SmallButton>
              ) : null}
            </div>
          ) : null}
          {presets.length > 0 ? (
            <div className="flex w-full flex-wrap gap-1.5">
              {presets.map((x) => (
                <span key={x.id} className="inline-flex items-center gap-1 rounded-full border border-[#262B3D] bg-[#11131A] py-0.5 pr-0.5 pl-3">
                  <button
                    type="button"
                    onClick={() => loadPreset(x)}
                    onPointerEnter={focusOnHover}
                    aria-label={`Load ${x.name}`}
                    className="cursor-pointer rounded-full px-1 text-[13px] font-bold text-[#F5F7FA] outline-none focus:bg-[#CCFF00] focus:text-[#08090D]"
                  >
                    {x.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => deletePreset(x)}
                    aria-label={`Delete ${x.name}`}
                    onPointerEnter={focusOnHover}
                    className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-[#8E96AA] outline-none hover:bg-white/10 hover:text-[#FF2A3C] focus:bg-[#CCFF00] focus:text-[#08090D]"
                  >
                    <X aria-hidden className="h-3.5 w-3.5" strokeWidth={2.6} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>


      {/* Sheet pages */}
      <div role="tablist" aria-label="Setup" className="flex flex-wrap gap-0.5 rounded-[24px] border border-[#262B3D] bg-[#08090D] p-1">
        {sheet.map((g) => {
          const n = changedIn(g);
          return (
            <button
              key={g.id}
              type="button"
              role="tab"
              aria-selected={group.id === g.id}
              onClick={() => setTab(g.id)}
              title={g.label}
              className={`group inline-flex min-h-[40px] flex-[1_0_auto] cursor-pointer items-center justify-center gap-1.5 rounded-full px-3 text-[13px] font-bold whitespace-nowrap transition-[background-color,box-shadow,color] duration-200 ${CURSOR_PILL} ${
                group.id === g.id ? CHOSEN_PILL : "text-[#8E96AA] hover:text-[#F5F7FA]"
              }`}
            >
              {/* Full names always: the strip wraps to a second row instead of shortening them to "Susp." and "Electr." */}
              <span>{g.label}</span>
              {n ? <span aria-label={`${n} changed`} className="h-1.5 w-1.5 rounded-full bg-[#00E5FF] group-focus:bg-[#08090D]" /> : null}
            </button>
          );
        })}
      </div>

      <div className={`grid items-start gap-3.5 ${live ? "lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]" : ""}`}>
        <GarageCard
          title={group.label}
          aside={
            groupChanged ? (
              <SmallButton onClick={() => resetGroup(group)} title="This page back to the car's baseline">
                Reset · {groupChanged}
              </SmallButton>
            ) : null
          }
        >
          {group.extras?.map(extra)}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-x-5">
            {group.params.map((q) => (
              <SetupRow
                key={q.id}
                label={q.label}
                value={q.get(st)}
                min={q.min}
                max={q.max}
                step={q.step}
                base={q.writes === "tuner" ? undefined : q.base}
                format={q.format}
                fx={q.fx}
                invert={q.invert}
                disabled={!canWrite(q)}
                onChange={(v) => apply(q, v)}
              />
            ))}
          </div>
        </GarageCard>
        {live ? (
          <GarageCard title="Current tyres & brakes" color="#00E5FF">
            <TyreBrakeGrid t={p.telemetry} compound={p.tireCompound} dense />
          </GarageCard>
        ) : null}
      </div>
    </div>
  );
};
