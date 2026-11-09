"use client";

import React from "react";
import { ChevronRight, CloudSun, Flag, Minus, Plus, Route, Wrench, type LucideIcon } from "lucide-react";
import { CarQualityBadge, CHOSEN_PILL, Chip, CURSOR_PILL, CURSOR_TILE, PrimaryButton, Segmented, TrackQualityBadge } from "./menu-ui";
import type { CarDefinition } from "@/lib/cars/car-registry";
import { focusOnHover } from "./useFocusNav";
import type { TrackInfo } from "@/lib/track-registry";
import { aiDriversFor } from "@/lib/sim/ai-opponents";
import { AI_SKILL_DEFAULT, AI_SKILL_LEVELS, aiSkillLabel } from "@/lib/sim/ai-tuning";
import { DAMAGE_LEVEL_LABELS, DAMAGE_LEVELS } from "@/lib/sim/car-damage";
import {
  AI_GRID_LABELS,
  MAX_RACE_OPPONENTS,
  PLAYER_GRID_LABELS,
  RACE_AGGRESSION_LABELS,
  RACE_LAP_OPTIONS,
  RACE_START_LABELS,
  type AiGridOrder,
  type PlayerGridSlot,
  type RaceAggression,
  type RaceSetup,
  type RaceStartKind,
} from "@/lib/sim/race-setup";

export interface RaceSetupPanelProps {
  setup: RaceSetup;
  onChange: (patch: Partial<RaceSetup>) => void;
  aiSkill?: number;
  onChangeAiSkill?: (skill: number) => void;
  track: TrackInfo;
  /** Weather and time of day, as a line */
  conditionsLabel?: string;
  car: Pick<CarDefinition, "id" | "quality" | "title" | "badge"> & { color: string };
  /** The player's driver code on the grid */
  playerCode?: string;
  onOpenCircuit: () => void;
  onOpenConditions?: () => void;
  onOpenGarage: () => void;
  onStart: () => void;
}

const CARD =
  "flex min-w-0 flex-col gap-3.5 rounded-[24px] border border-white/[0.07] bg-[#0D0F15]/[0.82] p-[18px] text-[#F5F7FA] [.lc-title-frame_&]:rounded-[22px] [.lc-title-frame_&]:border-[#262B3D] [.lc-title-frame_&]:bg-[#08090D]/60";

/** Above this many AI cars, slower machines lose frame rate: every car runs the full vehicle model */
const HEAVY_FIELD = 7;

const CardHeader: React.FC<{ label: string; color?: string; right?: React.ReactNode }> = ({ label, color = "#CCFF00", right }) => (
  <div className="flex items-center justify-between gap-2">
    <div className="flex items-center gap-2">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="lc-lbl">{label}</span>
    </div>
    {right}
  </div>
);

const Row: React.FC<{ label: string; hint?: React.ReactNode; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="flex flex-col gap-1.5">
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[13px] font-semibold text-[#C5CBD8]">{label}</span>
      {hint ? <span className="text-right text-[12px] text-[#8E96AA]">{hint}</span> : null}
    </div>
    {children}
  </div>
);

/** − value + with quick picks beside it */
const Stepper: React.FC<{
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
  quick?: readonly number[];
}> = ({ value, min, max, onChange, label, quick }) => {
  const step = (d: number) => onChange(Math.min(max, Math.max(min, value + d)));
  const btn = `flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-[#262B3D] bg-[#08090D] text-[#C5CBD8] transition-[background-color,border-color,box-shadow,color] duration-200 hover:border-[#3A4157] hover:text-[#F5F7FA] disabled:cursor-not-allowed disabled:opacity-40 ${CURSOR_PILL} focus:border-transparent`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" aria-label={`Fewer ${label}`} className={btn} disabled={value <= min} onClick={() => step(-1)} onPointerEnter={focusOnHover}>
        <Minus size={16} aria-hidden />
      </button>
      <span className="min-w-[3ch] text-center font-f1-mono text-[22px] font-extrabold tabular-nums" aria-live="polite">
        {value}
      </span>
      <button type="button" aria-label={`More ${label}`} className={btn} disabled={value >= max} onClick={() => step(1)} onPointerEnter={focusOnHover}>
        <Plus size={16} aria-hidden />
      </button>
      {quick ? (
        <div className="ml-auto flex flex-wrap gap-1.5">
          {quick.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onChange(q)}
              onPointerEnter={focusOnHover}
              aria-pressed={q === value}
              className={`min-h-[32px] cursor-pointer rounded-full px-3 font-f1-mono text-[12px] font-extrabold transition-[background-color,box-shadow,color] duration-200 ${CURSOR_PILL} ${
                q === value ? CHOSEN_PILL : "border border-[#262B3D] text-[#8E96AA] hover:border-[#3A4157] hover:text-[#F5F7FA]"
              }`}
            >
              {q}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};

/** A summary line that opens another panel (circuit, conditions, garage) */
const LinkRow: React.FC<{ icon: LucideIcon; label: string; value: React.ReactNode; onClick?: () => void; navDefault?: boolean }> = ({
  icon: Icon,
  label,
  value,
  onClick,
  navDefault,
}) => (
  <button
    type="button"
    data-nav-default={navDefault ? "" : undefined}
    disabled={!onClick}
    onClick={onClick}
    onPointerEnter={focusOnHover}
    className={`flex min-h-[52px] w-full cursor-pointer items-center gap-3 rounded-[16px] border border-[#262B3D] bg-[#08090D]/50 px-3.5 text-left transition-[background-color,border-color,box-shadow] duration-200 hover:border-[#3A4157] hover:bg-[#1B1F2B] disabled:cursor-default ${CURSOR_TILE}`}
  >
    <Icon size={18} aria-hidden className="shrink-0 text-[#8E96AA]" />
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="lc-lbl">{label}</span>
      <span className="truncate text-[14px] font-semibold text-[#F5F7FA]">{value}</span>
    </span>
    {onClick ? <ChevronRight size={16} aria-hidden className="shrink-0 text-[#8E96AA]" /> : null}
  </button>
);

/** The grid as it will line up: AI by pace (qualifying shuffles it a little), the player in the chosen slot */
function gridPreview(setup: RaceSetup, playerCode: string): { code: string; color: string; player?: boolean }[] {
  const ai = aiDriversFor(setup.opponents)
    .slice()
    .sort((a, b) => b.pace - a.pace)
    .map((d) => ({ code: d.code, color: d.teamColorHex }));
  if (setup.aiGrid === "reversed") ai.reverse();
  const n = ai.length + 1;
  const slot = setup.grid === "front" ? 0 : setup.grid === "middle" ? Math.floor((n - 1) / 2) : setup.grid === "random" ? -1 : n - 1;
  const out: { code: string; color: string; player?: boolean }[] = [...ai];
  if (slot >= 0) out.splice(slot, 0, { code: playerCode, color: "#CCFF00", player: true });
  return out;
}

/** The race before the lights: event, field, race and rules, the grid it makes, and the start */
export const RaceSetupPanel: React.FC<RaceSetupPanelProps> = ({
  setup,
  onChange,
  aiSkill = AI_SKILL_DEFAULT,
  onChangeAiSkill,
  track,
  conditionsLabel,
  car,
  playerCode = "YOU",
  onOpenCircuit,
  onOpenConditions,
  onOpenGarage,
  onStart,
}) => {
  const grid = gridPreview(setup, playerCode);
  const distanceKm = (setup.laps * track.lengthM) / 1000;
  const skillPreset = AI_SKILL_LEVELS.find((l) => l.value === Math.round(aiSkill))?.id ?? "custom";

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(360px,100%),1fr))] items-start gap-4">
        <div className="flex min-w-0 flex-col gap-4">
          <div className={CARD}>
            <CardHeader label="Event" />
            <LinkRow
              navDefault
              icon={Route}
              label="Circuit"
              value={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">
                    {track.name}
                    {track.layout ? ` · ${track.layout}` : ""}
                  </span>
                  <TrackQualityBadge track={track} size="xs" />
                </span>
              }
              onClick={onOpenCircuit}
            />
            <LinkRow icon={CloudSun} label="Conditions" value={conditionsLabel ?? "As set"} onClick={onOpenConditions} />
            <LinkRow
              icon={Wrench}
              label="Car · the field drives the same car"
              value={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 rounded-full px-1.5 py-0.5 font-f1-mono text-[9px] font-extrabold text-[#08090D]" style={{ background: car.color }}>
                    {car.badge}
                  </span>
                  <span className="truncate">{car.title}</span>
                  <CarQualityBadge car={car} size="xs" />
                </span>
              }
              onClick={onOpenGarage}
            />
          </div>

          <div className={CARD}>
            <CardHeader label="Field" />
            <Row label="AI cars" hint={setup.opponents > HEAVY_FIELD ? "A big field costs frame rate on slower machines" : undefined}>
              <Stepper label="AI cars" value={setup.opponents} min={1} max={MAX_RACE_OPPONENTS} onChange={(opponents) => onChange({ opponents })} quick={[3, 5, 7, 9, 11]} />
            </Row>
            {onChangeAiSkill ? (
              <Row label="AI difficulty" hint={skillPreset === "custom" ? `${aiSkillLabel(aiSkill)} · ${Math.round(aiSkill)}` : `${Math.round(aiSkill)} / 100`}>
                <Segmented<string>
                  label="AI difficulty"
                  options={AI_SKILL_LEVELS.map((l) => ({ id: l.id, label: l.label }))}
                  value={skillPreset}
                  onChange={(id) => onChangeAiSkill(AI_SKILL_LEVELS.find((l) => l.id === id)?.value ?? AI_SKILL_DEFAULT)}
                />
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(aiSkill)}
                  aria-label="AI difficulty, fine"
                  onChange={(e) => onChangeAiSkill(Number(e.target.value))}
                  className="lc-range mt-2.5"
                  style={{ "--lc-fill": `${Math.round(aiSkill)}%` } as React.CSSProperties}
                />
              </Row>
            ) : null}
            <Row
              label="Racing"
              hint={{ clean: "More room, fewer lunges", normal: "Each driver as they are", hard: "Late dives, firm defence" }[setup.aggression]}
            >
              <Segmented<RaceAggression>
                label="Racing"
                options={(["clean", "normal", "hard"] as const).map((id) => ({ id, label: RACE_AGGRESSION_LABELS[id] }))}
                value={setup.aggression}
                onChange={(aggression) => onChange({ aggression })}
              />
            </Row>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <div className={CARD}>
            <CardHeader label="Race" right={<span className="font-f1-mono text-[11px] font-bold text-[#8E96AA]">{distanceKm.toFixed(1)} KM</span>} />
            <Row label="Laps">
              <Stepper label="laps" value={setup.laps} min={1} max={50} onChange={(laps) => onChange({ laps })} quick={RACE_LAP_OPTIONS} />
            </Row>
            <Row label="Start">
              <Segmented<RaceStartKind>
                label="Start"
                options={(["standing", "rolling"] as const).map((id) => ({ id, label: RACE_START_LABELS[id] }))}
                value={setup.start}
                onChange={(start) => onChange({ start })}
              />
            </Row>
            <Row label="Your grid slot">
              <Segmented<PlayerGridSlot>
                label="Your grid slot"
                options={(["front", "middle", "back", "random"] as const).map((id) => ({ id, label: PLAYER_GRID_LABELS[id] }))}
                value={setup.grid}
                onChange={(g) => onChange({ grid: g })}
              />
            </Row>
            <Row label="AI grid" hint={setup.aiGrid === "qualifying" ? "Pace order, shuffled a little by a qualifying lap" : undefined}>
              <Segmented<AiGridOrder>
                label="AI grid"
                options={(["qualifying", "pace", "reversed"] as const).map((id) => ({ id, label: AI_GRID_LABELS[id] }))}
                value={setup.aiGrid}
                onChange={(aiGrid) => onChange({ aiGrid })}
              />
            </Row>
            <Row label="Damage">
              <Segmented
                label="Damage"
                options={DAMAGE_LEVELS.map((id) => ({ id, label: DAMAGE_LEVEL_LABELS[id] }))}
                value={setup.damage}
                onChange={(damage) => onChange({ damage })}
              />
            </Row>
          </div>

          <div className={CARD}>
            <CardHeader
              label="Grid"
              right={setup.grid === "random" ? <Chip size="sm">Your slot drawn at the start</Chip> : <Chip size="sm">{grid.length} cars</Chip>}
            />
            <ol className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-1.5 p-0">
              {grid.map((g, i) => (
                <li
                  key={g.code}
                  className={`flex items-center gap-2 rounded-[10px] px-2 py-1 ${i % 2 === 1 ? "translate-y-2" : ""} ${g.player ? "bg-[#CCFF00]/[0.1]" : ""}`}
                >
                  <span className="w-[2.5ch] text-right font-f1-mono text-[11px] font-bold text-[#8E96AA]">{i + 1}</span>
                  <span aria-hidden className="h-3 w-1 shrink-0 rounded-full" style={{ background: g.color }} />
                  <span className={`font-f1-mono text-[13px] font-extrabold ${g.player ? "text-[#CCFF00]" : "text-[#F5F7FA]"}`}>{g.code}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[13px] text-[#8E96AA]">
          {setup.laps} {setup.laps === 1 ? "lap" : "laps"} · {setup.opponents} AI · {aiSkillLabel(aiSkill)} · {RACE_START_LABELS[setup.start].toLowerCase()} start
        </span>
        <PrimaryButton onClick={onStart} prompt={<Flag size={18} aria-hidden />}>
          Start race
        </PrimaryButton>
      </div>
    </div>
  );
};
