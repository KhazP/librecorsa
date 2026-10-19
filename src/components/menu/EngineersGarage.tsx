"use client";

import React, { useEffect, useMemo, useState } from "react";
import type { LiveTunerPatch, LiveTunerState } from "@/types/f1";
import { DEFAULT_CHASSIS_SETUP, loadGaragePresets, saveGaragePresets, type GaragePreset, type GarageTuner } from "@/lib/sim/car-setup";
import { setupSheet, type SetupEffect, type SetupGroup, type SetupParam, type SetupState } from "@/lib/sim/setup-sheet";
import { COMPOUNDS, PanelSection, TYRE_SETUP_LIMITS, type PauseMenuProps } from "@/components/hud/PauseMenu";
import { CarPicker } from "./CarPicker";
import { TyreBrakeGrid } from "@/components/hud/TyreBrakeWidget";
import { LIVERIES } from "@/lib/track-data";

const FALLBACK_TUNER: Pick<
  LiveTunerState,
  "tcLevel" | "tc2Level" | "absLevel" | "brakeBiasPct" | "brakeMigrationPct" | "diffEntry" | "diffMid" | "diffExit" | "engineMap" | "hasErs"
> = { tcLevel: 5, tc2Level: 6, absLevel: 5, brakeBiasPct: 56, brakeMigrationPct: 2.5, diffEntry: 3, diffMid: 5, diffExit: 5, engineMap: 2, hasErs: true };

/** Changed from the car's baseline (the electronics have no fixed baseline: each car and assist level brings its own) */
const isChanged = (q: SetupParam, st: SetupState) => q.writes !== "tuner" && Math.abs(q.get(st) - q.base) > 1e-6;

const Segmented: React.FC<{ items: readonly { id: string; label: React.ReactNode }[]; active: string; onPick: (id: string) => void }> = ({ items, active, onPick }) => (
  <div className="flex rounded-full border border-[#262B3D] bg-[#08090D] p-1">
    {items.map((it) => (
      <button
        key={it.id}
        type="button"
        aria-pressed={active === it.id}
        onClick={() => onPick(it.id)}
        className={`inline-flex min-h-[38px] flex-1 cursor-pointer items-center justify-center gap-2 rounded-full text-[13px] font-bold ${
          active === it.id ? "bg-[#1B1F2B] text-[#F5F7FA] shadow-[inset_0_0_0_1px_#3A4157]" : "text-[#8E96AA] hover:text-[#F5F7FA]"
        }`}
      >
        {it.label}
      </button>
    ))}
  </div>
);

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
    <label className={`flex flex-col gap-2 rounded-[14px] px-2 py-2 hover:bg-white/[0.04] ${disabled ? "opacity-45" : ""}`} title={fx ? `▲ ${fx.more}\n▼ ${fx.less}` : undefined}>
      <span className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[14px] font-bold text-[#F5F7FA]">{label}</span>
          {fx ? (
            <span aria-hidden className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[#3A4157] font-f1-mono text-[9px] font-extrabold text-[#8E96AA]">
              i
            </span>
          ) : null}
        </span>
        <span className="shrink-0 font-f1-mono text-sm font-extrabold whitespace-nowrap text-[#CCFF00] tabular-nums">{format(value)}</span>
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
      {text ? <span className={`text-[12px] leading-[1.4] ${dir === 0 ? "text-[#5B6275]" : "text-[#C5CBD8]"}`}>{text}</span> : null}
    </label>
  );
};

const Card: React.FC<{ title: string; color?: string; children: React.ReactNode; aside?: React.ReactNode }> = ({ title, color, children, aside }) => (
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
    className={`inline-flex h-[30px] shrink-0 cursor-pointer items-center rounded-full px-3 font-f1-mono text-[10px] font-extrabold tracking-[0.12em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
      tone === "volt"
        ? "bg-[#CCFF00] text-[#08090D] hover:bg-[#D9FF40]"
        : tone === "danger"
          ? "border border-[#262B3D] text-[#8E96AA] hover:border-[#FF2A3C] hover:text-[#FF2A3C]"
          : "border border-[#262B3D] text-[#8E96AA] hover:border-[#CCFF00] hover:text-[#CCFF00]"
    }`}
  >
    {children}
  </button>
);

/**
 * Engineer's Garage: the car's setup sheet (one layout for the F1 cars, another for the GT3s, shared by every car
 * of the class), and named presets saved per car. Opened from the title screen's Garage and from Pause → Car setup.
 */
export const EngineersGarage: React.FC<PauseMenuProps> = (p) => {
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
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setPresets(loadGaragePresets(p.vehicleModel)), [p.vehicleModel]);
  useEffect(() => {
    if (!note) return;
    const id = window.setTimeout(() => setNote(null), 2400);
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
  const canWrite = (q: SetupParam) => (q.writes === "chassis" ? canChassis : q.writes === "tuner" ? canTune : true);
  const apply = (q: SetupParam, v: number) => {
    const next = q.set(st, v);
    if (q.writes === "chassis") p.onChangeChassisSetup?.(next.chassis);
    else if (q.writes === "tyre") p.onChangeTyreSetup(next.tyre);
    else p.onChangeLiveTuner?.({ [q.id]: next.tuner[q.id as keyof GarageTuner] } as LiveTunerPatch);
  };
  /** The page's settings back at the car's baseline (the electronics stay as they are) */
  const resetGroup = (g: SetupGroup) => {
    let next = st;
    for (const q of g.params) if (q.writes !== "tuner") next = q.set(next, q.base);
    if (g.params.some((q) => q.writes === "chassis")) p.onChangeChassisSetup?.(next.chassis);
    if (g.params.some((q) => q.writes === "tyre")) p.onChangeTyreSetup(next.tyre);
  };

  const savePreset = () => {
    const label = name.trim() || `Setup ${presets.length + 1}`;
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
    p.onChangeChassisSetup?.(x.chassis);
    p.onChangeTyreSetup(x.tyre);
    p.onChangeTireCompound(x.compound);
    p.onChangeAeroPreset(x.aero);
    p.onChangeLiveTuner?.(x.tuner);
    setNote(`Loaded “${x.name}”`);
  };
  const deletePreset = (x: GaragePreset) => {
    const next = presets.filter((y) => y.id !== x.id);
    setPresets(next);
    saveGaragePresets(p.vehicleModel, next);
  };
  const resetAll = () => {
    p.onChangeChassisSetup?.({ ...DEFAULT_CHASSIS_SETUP });
    p.onChangeTyreSetup(p.defaultTyreSetup);
    p.onChangeAeroPreset("balanced");
    setNote("Back to the baseline setup");
  };

  const changedIn = (g: SetupGroup) => g.params.filter((q) => isChanged(q, st)).length;
  const groupChanged = changedIn(group);
  const live = Boolean(group.extras?.includes("liveTyres"));

  const extra = (x: string) => {
    if (x === "compound")
      return (
        <Segmented
          key={x}
          active={p.tireCompound}
          onPick={(id) => p.onChangeTireCompound(id as typeof p.tireCompound)}
          items={COMPOUNDS.map((c) => ({
            id: c.id,
            label: (
              <>
                <span aria-hidden className="h-3 w-3 rounded-full border-[3px]" style={{ borderColor: c.ring }} />
                {c.label}
              </>
            ),
          }))}
        />
      );
    if (x === "aeroPackage")
      return (
        <Segmented
          key={x}
          active={p.aeroPreset}
          onPick={(id) => p.onChangeAeroPreset(id as typeof p.aeroPreset)}
          items={[
            { id: "low_downforce", label: "Low DF" },
            { id: "balanced", label: "Balanced" },
            { id: "high_downforce", label: "High DF" },
          ]}
        />
      );
    if (x === "assists")
      return (
        <Segmented
          key={x}
          active={p.assistPreset}
          onPick={(id) => p.onChangeAssistPreset(id as typeof p.assistPreset)}
          items={[
            { id: "pro", label: "Assists off" },
            { id: "semi_pro", label: "TC + ABS" },
            { id: "assisted", label: "Full" },
          ]}
        />
      );
    return null;
  };

  return (
    <div className="lc-glass flex flex-col gap-[18px] rounded-[28px] p-5 text-[#F5F7FA] sm:px-7 sm:pt-6 sm:pb-[26px] short:p-4 [.lc-title-frame_&]:border-0 [.lc-title-frame_&]:bg-transparent [.lc-title-frame_&]:p-0 [.lc-title-frame_&]:shadow-none [.lc-title-frame_&]:[backdrop-filter:none]">
      {/* Car and presets */}
      <div className="flex flex-col gap-3">
        <CarPicker carId={p.carId} onChangeCar={p.onChangeCar} compact />
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Livery">
          {LIVERIES.map((liv) => {
            const active = p.selectedLivery.id === liv.id;
            return (
              <button
                key={liv.id}
                type="button"
                aria-pressed={active}
                aria-label={liv.name}
                title={`${liv.name} · ${liv.team}`}
                onClick={() => p.onChangeLivery(liv)}
                className={`h-7 w-12 cursor-pointer rounded-[9px] transition-[box-shadow] ${active ? "shadow-[0_0_0_2px_#CCFF00]" : "shadow-[0_0_0_1px_#262B3D] hover:shadow-[0_0_0_1px_#8E96AA]"}`}
                style={{ background: `linear-gradient(135deg, ${liv.primary} 0 55%, ${liv.accent} 55% 65%, ${liv.secondary} 65% 100%)` }}
              />
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-[18px] border border-[#262B3D] bg-[#08090D]/55 p-2">
          <span className="px-1.5 font-f1-mono text-[10px] font-extrabold tracking-[0.14em] text-[#8E96AA] uppercase">Presets</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") savePreset();
            }}
            placeholder="Name this setup"
            maxLength={32}
            className="h-[30px] min-w-0 flex-1 rounded-full border border-[#262B3D] bg-[#050608] px-3 text-[13px] text-[#F5F7FA] outline-none placeholder:text-[#5B6275] focus:border-[#CCFF00]"
          />
          <SmallButton tone="volt" onClick={savePreset}>
            Save
          </SmallButton>
          <SmallButton onClick={resetAll} title="Every chassis setting, tyre pressure and camber back to the car's baseline">
            Baseline
          </SmallButton>
          {note ? <span className="font-f1-mono text-[10px] font-extrabold tracking-[0.08em] text-[#CCFF00]">{note}</span> : null}
          {presets.length > 0 ? (
            <div className="flex w-full flex-wrap gap-1.5">
              {presets.map((x) => (
                <span key={x.id} className="inline-flex items-center gap-1 rounded-full border border-[#262B3D] bg-[#11131A] py-0.5 pr-0.5 pl-3">
                  <button type="button" onClick={() => loadPreset(x)} className="cursor-pointer text-[12px] font-bold text-[#F5F7FA] hover:text-[#CCFF00]" title={`Load ${x.name}`}>
                    {x.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => deletePreset(x)}
                    aria-label={`Delete ${x.name}`}
                    className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-[#5B6275] hover:bg-white/10 hover:text-[#FF2A3C]"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>


      {/* Sheet pages */}
      <div role="tablist" aria-label="Setup" className="flex gap-0.5 overflow-x-auto rounded-full border border-[#262B3D] bg-[#08090D] p-1">
        {sheet.map((g) => {
          const n = changedIn(g);
          return (
            <button
              key={g.id}
              type="button"
              role="tab"
              aria-selected={group.id === g.id}
              onClick={() => setTab(g.id)}
              className={`inline-flex min-h-[40px] min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2.5 text-[13px] font-bold whitespace-nowrap transition-colors ${
                group.id === g.id ? "bg-[#CCFF00] text-[#08090D]" : "text-[#8E96AA] hover:text-[#F5F7FA]"
              }`}
            >
              <span className="hidden xl:inline">{g.label}</span>
              <span className="xl:hidden">{g.short}</span>
              {n ? <span aria-label={`${n} changed`} className={`h-1.5 w-1.5 rounded-full ${group.id === g.id ? "bg-[#08090D]" : "bg-[#CCFF00]"}`} /> : null}
            </button>
          );
        })}
      </div>

      <div className={`grid gap-3.5 ${live ? "lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]" : ""}`}>
        <Card
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
          <div className={`grid gap-x-4 ${live ? "2xl:grid-cols-2" : "md:grid-cols-2 2xl:grid-cols-3"}`}>
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
        </Card>
        {live ? (
          <Card title="Current tyres & brakes" color="#00E5FF">
            <TyreBrakeGrid t={p.telemetry} compound={p.tireCompound} dense />
          </Card>
        ) : null}
      </div>
    </div>
  );
};
