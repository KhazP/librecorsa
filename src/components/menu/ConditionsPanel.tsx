"use client";

import React from "react";
import { Badge } from "@/components/ui/Badge";
import { Button, Card, Disclosure, OptionTile, OptionTileGroup, Segmented, Select, SettingRow, Well } from "@/components/ui";
import { Icon } from "@/components/ui/icons";
import type { IconName } from "@/components/ui/icons/registry";
import { useUnits } from "@/lib/settings/ui-prefs";
import { TEMPERATURE_LABEL, temperatureIn } from "@/lib/settings/units";
import {
  defaultWeatherNodesForPreset,
  SKY_COVER_SPECS,
  TIME_OF_DAY_HOURS,
  TIME_OF_DAY_LABELS,
  TIME_OF_DAY_PRESETS,
  TIME_SCALES,
  WEATHER_LABELS,
  WEATHER_NODE_LABELS,
  WEATHER_PRESETS,
  type SessionConditions,
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
  /**
   * Opens Settings at a category. Simulation realism lives in Settings > Driving: with this the panel shows its value
   * and a link there; without it the panel keeps the control.
   */
  onOpenSettings?: (category: "driving") => void;
  /**
   * A session is on track (the pause menu): every change restarts the weather and the rubber there, so the rows with
   * several steps become lists that change once, and the panel says so.
   */
  session?: boolean;
}

const WEATHER_ICONS: Record<WeatherPresetId, IconName> = {
  clear: "weatherClear",
  overcast: "weatherCloud",
  light_rain: "weatherDrizzle",
  heavy_rain: "weatherRain",
  drying: "weatherDrying",
  dynamic: "random",
};

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

/**
 * Weather, time of day and the track's grip. Everything applies live, so the panel works the same from the title
 * menu and from pause; a multiplayer guest sees the host's choices, read-only.
 */
export const ConditionsPanel: React.FC<ConditionsPanelProps> = ({
  conditions,
  realism,
  onChangeConditions,
  onChangeRealism,
  hostControlled,
  readout,
  onOpenSettings,
  session = false,
}) => {
  const units = useUnits();
  const set = (patch: Partial<SessionConditions>) => onChangeConditions({ ...conditions, ...patch });
  const locked = Boolean(hostControlled);
  // A row of steps changes value on every left / right. With a session on track each change restarts the weather, so
  // there the same choices are a list that changes once
  const steps = (p: { value: string; onChange: (v: string) => void; options: { id: string; label: string }[] }) =>
    session ? <Select<string> {...p} /> : <Segmented {...p} />;
  const temp = (c: number) => `${Math.round(temperatureIn(c, units.temperature))} ${TEMPERATURE_LABEL[units.temperature]}`;
  const hostBadge = locked ? (
    <Badge tone="info" icon="host">
      Set by the host
    </Badge>
  ) : undefined;
  const forecast = conditions.weatherNodes ?? defaultWeatherNodesForPreset(conditions.weather, conditions.timeOfDay, conditions.seed);
  const grip = conditions.surfacePreset ?? "natural";

  return (
    // data-nav-columns: up / down read down the first column, then the second (menu-shell's reading order)
    <div data-nav-columns="" className="grid grid-cols-[repeat(auto-fit,minmax(min(400px,100%),1fr))] items-start gap-3">
      <div className="flex min-w-0 flex-col gap-3">
        <Card title="Weather" action={hostBadge}>
          <OptionTileGroup aria-label="Weather" columns={3}>
            {WEATHER_PRESETS.map((id) => (
              <OptionTile
                key={id}
                // A custom forecast (weatherNodes) overrides the preset, so then no preset is the chosen one
                checked={conditions.weather === id && !conditions.weatherNodes}
                navDefault={conditions.weather === id}
                disabled={locked}
                // A preset replaces any custom forecast (the sim prefers weatherNodes over the preset when both exist)
                onSelect={() =>
                  set({ weather: id, weatherNodes: undefined, seed: id === "dynamic" ? 1 + Math.floor(Math.random() * 9999) : conditions.seed })
                }
                title={
                  <span className="flex items-center gap-2">
                    <Icon name={WEATHER_ICONS[id]} className="text-lc-slate" />
                    {WEATHER_LABELS[id].label}
                  </span>
                }
                description={WEATHER_LABELS[id].detail}
              />
            ))}
          </OptionTileGroup>
          <Disclosure moreLabel="Forecast through the session" lessLabel="Hide the forecast">
            <ol className="m-0 grid list-none grid-cols-5 gap-1.5 p-0">
              {forecast.map((node, idx) => (
                <li key={WEATHER_NODE_LABELS[idx]}>
                  <Well className="flex h-full flex-col items-center gap-0.5 px-1.5 py-2 text-center">
                    <span className="lc-hint">{WEATHER_NODE_LABELS[idx]}</span>
                    <span className="text-[12px] leading-tight font-semibold text-lc-chalk">{SKY_COVER_SPECS[node.sky].label}</span>
                    <span className="lc-mono text-[11px] text-lc-fog">
                      {node.rainChance > 0 ? `${Math.round(node.rainChance)}% rain` : temp(node.temperatureC)}
                    </span>
                  </Well>
                </li>
              ))}
            </ol>
          </Disclosure>
        </Card>

        {readout ? (
          <Card title="On track now">
            <dl className="m-0 grid grid-cols-4 gap-x-4 py-1">
              {[
                ["Clock", clock(readout.clockH)],
                ["Air", temp(readout.airC)],
                ["Track", temp(readout.trackC)],
                ["Surface", `${trackStateLabel(readout.waterMm)}${readout.rain > 0.05 ? ", raining" : ""}`],
              ].map(([k, v]) => (
                <div key={k} className="flex min-w-0 flex-col gap-0.5">
                  <dt className="lc-hint">{k}</dt>
                  <dd className="lc-data m-0 truncate text-[15px] text-lc-chalk">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <Card title="Time of day" action={hostBadge}>
          <OptionTileGroup aria-label="Time of day" columns={3}>
            {TIME_OF_DAY_PRESETS.map((id) => (
              <OptionTile
                key={id}
                checked={conditions.timeOfDay === id}
                navDefault={conditions.timeOfDay === id}
                disabled={locked}
                onSelect={() => set({ timeOfDay: id })}
                title={TIME_OF_DAY_LABELS[id]}
                description={<span className="lc-mono">{clock(TIME_OF_DAY_HOURS[id])}</span>}
              />
            ))}
          </OptionTileGroup>
          <SettingRow label="Time progression" hint="How fast the clock runs" disabled={locked}>
            {steps({
              value: String(conditions.timeScale),
              onChange: (v) => set({ timeScale: Number(v) }),
              options: TIME_SCALES.map((s) => ({ id: String(s), label: s === 0 ? "Fixed" : `${s}x` })),
            })}
          </SettingRow>
        </Card>

        <Card title="Track">
          <SettingRow label="Grip" hint={SURFACE_GRIP_PRESET_LABELS[grip].detail} disabled={locked}>
            <Select<SurfaceGripPresetId>
              value={grip}
              onChange={(v) => set({ surfacePreset: v })}
              options={SURFACE_GRIP_PRESETS.map((id) => ({
                id,
                label: SURFACE_GRIP_PRESET_LABELS[id].label,
                detail: SURFACE_GRIP_PRESET_LABELS[id].detail,
              }))}
            />
          </SettingRow>
          <SettingRow label="Grip change" hint="How fast rubber builds up on the line" disabled={locked}>
            {steps({
              value: String(conditions.surfaceTimeScale ?? 1),
              onChange: (v) => set({ surfaceTimeScale: Number(v) }),
              options: SURFACE_TIME_SCALES.map((s) => ({ id: String(s), label: s === 0 ? "Static" : `${s}x` })),
            })}
          </SettingRow>
          {onOpenSettings ? (
            <SettingRow label="Simulation realism" hint={`${SIM_REALISM_LABELS[realism].label}: ${SIM_REALISM_LABELS[realism].detail}`}>
              <Button size="sm" variant="secondary" onClick={() => onOpenSettings("driving")} icon={<Icon name="settings" />}>
                Settings
              </Button>
            </SettingRow>
          ) : (
            <SettingRow label="Simulation realism" hint={SIM_REALISM_LABELS[realism].detail}>
              <Segmented<SimRealism>
                value={realism}
                onChange={onChangeRealism}
                options={SIM_REALISM_LEVELS.map((id) => ({ id, label: SIM_REALISM_LABELS[id].label }))}
              />
            </SettingRow>
          )}
        </Card>

        <p className="lc-hint m-0 px-1">
          {session ? "A change here restarts the weather and the rubber on the track. " : null}
          Rain needs rain tyres: intermediates on a wet track, full wets in standing water. The cars dry a line as the rain
          stops. AI opponents choose their own tyres.
        </p>
      </div>
    </div>
  );
};
