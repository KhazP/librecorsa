"use client";

import React from "react";
import { CloudRain, CloudSun, Sun, Sunrise, Sunset, Cloud, CloudDrizzle, Shuffle, type LucideIcon } from "lucide-react";
import { Segmented } from "./menu-ui";
import { focusOnHover } from "./useFocusNav";
import {
  defaultWeatherNodesForPreset,
  SKY_COVER_SPECS,
  TIME_OF_DAY_LABELS,
  TIME_OF_DAY_PRESETS,
  TIME_SCALES,
  WEATHER_LABELS,
  WEATHER_NODE_LABELS,
  WEATHER_PRESETS,
  type SessionConditions,
  type TimeOfDayId,
  type WeatherPresetId,
} from "@/lib/sim/weather";
import {
  SURFACE_GRIP_PRESET_LABELS,
  SURFACE_GRIP_PRESETS,
  SURFACE_TIME_SCALES,
  type SurfaceGripPresetId,
} from "@/lib/sim/track-evolution";
import { SIM_REALISM_LABELS, SIM_REALISM_LEVELS, type SimRealism } from "@/lib/sim/sim-realism";

/** Live readout of the session's weather (HUD numbers), shown under the choices while a session runs */
export interface ConditionsReadout {
  airC: number;
  trackC: number;
  /** Water on the racing line (mm) */
  waterMm: number;
  /** Rain intensity 0..1 */
  rain: number;
  /** Clock (hours) */
  clockH: number;
}

export interface ConditionsPanelProps {
  conditions: SessionConditions;
  realism: SimRealism;
  onChangeConditions: (next: SessionConditions) => void;
  onChangeRealism: (next: SimRealism) => void;
  /** A multiplayer guest: the host's weather applies, the choices are read-only */
  hostControlled?: boolean;
  readout?: ConditionsReadout | null;
}

const CARD =
  "flex min-w-0 flex-col gap-3.5 rounded-[24px] border border-white/[0.07] bg-[#0D0F15]/[0.82] p-[18px] text-[#F5F7FA] [.lc-title-frame_&]:rounded-[22px] [.lc-title-frame_&]:border-[#262B3D] [.lc-title-frame_&]:bg-[#08090D]/60";

const WEATHER_ICONS: Record<WeatherPresetId, LucideIcon> = {
  clear: Sun,
  overcast: Cloud,
  light_rain: CloudDrizzle,
  heavy_rain: CloudRain,
  drying: CloudSun,
  dynamic: Shuffle,
};

const TIME_ICONS: Partial<Record<TimeOfDayId, LucideIcon>> = { dawn: Sunrise, golden_hour: Sunset, dusk: Sunset, noon: Sun };

const CardHeader: React.FC<{ label: string; color: string; right?: React.ReactNode }> = ({ label, color, right }) => (
  <div className="flex items-center justify-between gap-2">
    <div className="flex items-center gap-2">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="lc-lbl">{label}</span>
    </div>
    {right}
  </div>
);

/** Selectable card in a grid (weather / time of day) */
const ChoiceCard: React.FC<{
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon?: LucideIcon;
  title: string;
  sub?: string;
}> = ({ active, disabled, onClick, icon: Icon, title, sub }) => (
  <button
    type="button"
    aria-pressed={active}
    disabled={disabled}
    onClick={onClick}
    onPointerEnter={focusOnHover}
    className={`flex min-h-[64px] cursor-pointer flex-col items-start justify-center gap-1 rounded-[18px] px-3.5 py-2.5 text-left transition-[background-color,border-color,color] duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${
      active
        ? "border-[1.5px] border-[#CCFF00] bg-[#CCFF00]/[0.07] text-[#F5F7FA]"
        : "border border-[#262B3D] bg-[#08090D]/50 text-[#C5CBD8] hover:border-[#3A4157] hover:bg-[#1B1F2B] hover:text-[#F5F7FA]"
    }`}
  >
    <span className="flex items-center gap-2 text-[14px] leading-tight font-bold">
      {Icon ? <Icon aria-hidden size={16} className={active ? "text-[#CCFF00]" : "text-[#8E96AA]"} /> : null}
      {title}
    </span>
    {sub ? <span className={`text-[12px] ${active ? "text-[#C5CBD8]" : "text-[#8E96AA]"}`}>{sub}</span> : null}
  </button>
);

const clock = (h: number) => {
  const m = Math.round(h * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** Track wetness as a word, from the water on the racing line */
export function trackStateLabel(waterMm: number): string {
  if (waterMm < 0.03) return "Dry";
  if (waterMm < 0.14) return "Damp";
  if (waterMm < 1.1) return "Wet";
  return "Flooded";
}

/** Weather, time of day, time multiplier and simulation realism */
export const ConditionsPanel: React.FC<ConditionsPanelProps> = ({
  conditions,
  realism,
  onChangeConditions,
  onChangeRealism,
  hostControlled,
  readout,
}) => {
  const set = (patch: Partial<SessionConditions>) => onChangeConditions({ ...conditions, ...patch });
  const locked = Boolean(hostControlled);

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(380px,100%),1fr))] items-start gap-4">
      <div className="flex min-w-0 flex-col gap-4">
        <div className={CARD}>
          <CardHeader
            label="Weather"
            color="#00E5FF"
            right={locked ? <span className="lc-lbl text-[9px] text-[#00E5FF]">Set by the host</span> : null}
          />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {WEATHER_PRESETS.map((id) => (
              <ChoiceCard
                key={id}
                active={conditions.weather === id}
                disabled={locked}
                onClick={() => set({ weather: id, seed: id === "dynamic" ? 1 + Math.floor(Math.random() * 9999) : conditions.seed })}
                icon={WEATHER_ICONS[id]}
                title={WEATHER_LABELS[id].label}
                sub={WEATHER_LABELS[id].detail}
              />
            ))}
          </div>
          <div className="flex flex-col gap-1.5 pt-1">
            <span className="lc-lbl text-[9px]">5-node session forecast</span>
            <div className="grid grid-cols-5 gap-1.5">
              {(conditions.weatherNodes ?? defaultWeatherNodesForPreset(conditions.weather, conditions.timeOfDay, conditions.seed)).map((node, idx) => {
                const sky = SKY_COVER_SPECS[node.sky];
                return (
                  <div
                    key={WEATHER_NODE_LABELS[idx]}
                    className="flex flex-col gap-0.5 rounded-[12px] border border-[#262B3D] bg-[#08090D]/60 px-2 py-1.5 text-center"
                  >
                    <span className="lc-lbl text-[8px] text-[#8E96AA]">{WEATHER_NODE_LABELS[idx]}</span>
                    <span className="truncate text-[11px] font-bold text-[#F5F7FA]">{sky.label}</span>
                    <span className="font-f1-mono text-[10px] text-[#00E5FF]">
                      {node.rainChance > 0 ? `${Math.round(node.rainChance)}% rain` : `${node.temperatureC.toFixed(0)}°C`}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className={CARD}>
          <CardHeader label="Time of day" color="#FFB300" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {TIME_OF_DAY_PRESETS.map((id) => (
              <ChoiceCard
                key={id}
                active={conditions.timeOfDay === id}
                disabled={locked}
                onClick={() => set({ timeOfDay: id })}
                icon={TIME_ICONS[id]}
                title={TIME_OF_DAY_LABELS[id]}
              />
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <span className="lc-lbl text-[9px]">Time progression</span>
            <Segmented
              label="Time progression"
              value={String(conditions.timeScale)}
              onChange={(v) => !locked && set({ timeScale: Number(v) })}
              options={TIME_SCALES.map((s) => ({ id: String(s), label: s === 0 ? "Fixed" : `${s}×`, disabled: locked }))}
            />
          </div>
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <div className={CARD}>
          <CardHeader label="Track surface rubber" color="#3CCB4A" />
          <Segmented
            label="Track surface rubber"
            value={conditions.surfacePreset ?? "natural"}
            onChange={(v) => !locked && set({ surfacePreset: v as SurfaceGripPresetId })}
            options={SURFACE_GRIP_PRESETS.map((id) => ({
              id,
              label: SURFACE_GRIP_PRESET_LABELS[id].label,
              disabled: locked,
            }))}
          />
          <p className="m-0 text-[12px] leading-normal text-[#C5CBD8]">
            {SURFACE_GRIP_PRESET_LABELS[conditions.surfacePreset ?? "natural"].detail}
          </p>
          <div className="flex flex-col gap-2">
            <span className="lc-lbl text-[9px]">Surface evolution rate</span>
            <Segmented
              label="Surface evolution rate"
              value={String(conditions.surfaceTimeScale ?? 1)}
              onChange={(v) => !locked && set({ surfaceTimeScale: Number(v) })}
              options={SURFACE_TIME_SCALES.map((s) => ({
                id: String(s),
                label: s === 0 ? "Static" : `${s}×`,
                disabled: locked,
              }))}
            />
          </div>
        </div>

        <div className={CARD}>
          <CardHeader label="Simulation realism" color="#CCFF00" />
          <Segmented
            label="Simulation realism"
            value={realism}
            onChange={onChangeRealism}
            options={SIM_REALISM_LEVELS.map((id) => ({ id, label: SIM_REALISM_LABELS[id].label }))}
          />
          <p className="m-0 text-[13px] leading-normal text-[#C5CBD8]">{SIM_REALISM_LABELS[realism].detail}</p>
        </div>

        {readout ? (
          <div className={CARD}>
            <CardHeader label="Now on track" color="#3CCB4A" />
            <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
              {[
                ["Clock", clock(readout.clockH)],
                ["Air", `${readout.airC.toFixed(0)} °C`],
                ["Track", `${readout.trackC.toFixed(0)} °C`],
                ["Surface", `${trackStateLabel(readout.waterMm)}${readout.rain > 0.05 ? " · rain" : ""}`],
              ].map(([k, v]) => (
                <div key={k} className="flex min-w-0 flex-col gap-1">
                  <dt className="lc-lbl text-[9px]">{k}</dt>
                  <dd className="m-0 font-f1-mono text-[15px] font-extrabold text-[#F5F7FA]">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}

        <p className="m-0 px-1 text-[12px] leading-normal text-[#8E96AA]">
          Rain needs rain tyres: intermediates on a wet track, full wets in standing water. The cars dry a line as the
          rain stops. AI opponents choose their own tyres.
        </p>
      </div>
    </div>
  );
};
