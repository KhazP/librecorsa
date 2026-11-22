"use client";

import React from "react";
import { Card, Segmented, Select, SettingRow, Slider, Stepper, Toggle } from "@/components/ui";
import { AI_SKILL_DEFAULT, aiSkillLabel } from "@/lib/sim/ai-tuning";
import { DAMAGE_LEVEL_LABELS, DAMAGE_LEVELS, type DamageLevel } from "@/lib/sim/car-damage";
import {
  AI_GRID_LABELS,
  DEFAULT_RACE_SETUP,
  MAX_RACE_OPPONENTS,
  PLAYER_GRID_LABELS,
  RACE_AGGRESSION_LABELS,
  RACE_START_LABELS,
  type AiGridOrder,
  type PlayerGridSlot,
  type RaceAggression,
  type RaceSetup,
} from "@/lib/sim/race-setup";
import { RACE_START_MODE_HINTS, RACE_START_MODE_LABELS, RACE_START_MODES, type RaceStartMode } from "@/lib/sim/race-start";
import {
  RULE_PRESET_HINTS,
  RULE_PRESET_LABELS,
  TRACK_LIMITS_CHOICE_LABELS,
  type RaceStartChoice,
  type RulePresetId,
  type TrackLimitsChoice,
} from "@/lib/sim/race-rules";
import { QUALIFYING_MINUTES, type QualifyingMinutes } from "@/lib/sim/qualifying";
import { useUnits } from "@/lib/settings/ui-prefs";

/** The segmented control's ids are strings: "0" (off), "5", "10", "15" */
type QualifyingOption = `${QualifyingMinutes}`;
const qualifyingOption = (m: QualifyingMinutes): QualifyingOption => `${m}`;
import { DISTANCE_LABEL, distanceIn } from "@/lib/settings/units";

/** Above this many AI cars, slower machines lose frame rate: every car runs the full vehicle model */
const HEAVY_FIELD = 7;

const AGGRESSION_HINT: Record<RaceAggression, string> = {
  clean: "More room, fewer lunges",
  normal: "Each driver as they are",
  hard: "Late dives, firm defence",
};

/** The field sizes on offer in pause's list (the same range as the title's stepper) */
const OPPONENT_OPTIONS = Array.from({ length: MAX_RACE_OPPONENTS }, (_, i) => {
  const n = i + 1;
  return { id: String(n), label: `${n} AI ${n === 1 ? "car" : "cars"}` };
});

export interface RaceRulesProps {
  /** Where the rules are shown: the title's Race panel, or the pause menu while a session runs */
  context: "title" | "pause";
  setup?: RaceSetup;
  onChange: (patch: Partial<RaceSetup>) => void;
  /** AI level, 0 (Rookie) to 100 (Alien); applies at once, mid-race too */
  aiSkill?: number;
  onChangeAiSkill?: (skill: number) => void;
  /** Pause only: AI opponents on or off (turning them on or off restarts the run) */
  aiOpponents?: boolean;
  onToggleAiOpponents?: () => void;
  /** Circuit length in metres, for the race distance under Laps */
  trackLengthM?: number;
  /** Rows to add at the end of the field card (pause: Autopilot) */
  extraFieldRows?: React.ReactNode;
  className?: string;
}

/** "26.7 km" in the player's units */
export function useRaceDistance(laps: number, trackLengthM: number | undefined): string | null {
  const units = useUnits();
  if (!trackLengthM) return null;
  return `${distanceIn((laps * trackLengthM) / 1000, units.speed).toFixed(1)} ${DISTANCE_LABEL[units.speed]}`;
}

/**
 * The rules of an AI race, the same rows, labels, controls and ranges wherever they are shown: the title's Race panel
 * and the pause menu's session. In pause a row that restarts the race says so; the rest apply from the next start.
 */
export const RaceRules: React.FC<RaceRulesProps> = ({
  context,
  setup = DEFAULT_RACE_SETUP,
  onChange,
  aiSkill = AI_SKILL_DEFAULT,
  onChangeAiSkill,
  aiOpponents,
  onToggleAiOpponents,
  trackLengthM,
  extraFieldRows,
  className,
}) => {
  const distance = useRaceDistance(setup.laps, trackLengthM);
  const pause = context === "pause";
  // Only a change of field size restarts a running AI race (the shell rebuilds the field and starts from the lights)
  const restartsNow = pause && aiOpponents === true;
  const startNote = setup.startMode === "auto" ? "" : ` (${RACE_START_LABELS[setup.startMode].toLowerCase()})`;
  const heavy = setup.opponents > HEAVY_FIELD ? "Large field may reduce frame rate" : null;

  return (
    // data-nav-columns: up / down read down the field card, the race card, then the rules (menu-shell's reading order).
    // Two columns once there is room: the rules under the short field card, the race beside both
    <div className={className ?? "@container"}>
      <div
        data-nav-columns=""
        className="grid grid-cols-1 items-start gap-3 @min-[732px]:grid-cols-2 @min-[732px]:[grid-template-areas:'field_race'_'rules_race']"
      >
        <Card title="Field" className="@min-[732px]:[grid-area:field]">
          {onToggleAiOpponents ? (
            <SettingRow
              label="AI opponents"
              hint={`${setup.opponents} AI ${setup.opponents === 1 ? "car" : "cars"}${startNote}. Toggling restarts the session.`}
            >
              <Toggle checked={aiOpponents === true} onChange={() => onToggleAiOpponents()} />
            </SettingRow>
          ) : null}
          <SettingRow
            label="Opponents"
            hint={[restartsNow ? "Restarts the race" : null, heavy].filter(Boolean).join(". ") || undefined}
          >
            {pause ? (
              // In pause a new field size restarts the race: a list commits once, on confirm, where a stepper would
              // restart on every step
              <Select
                options={OPPONENT_OPTIONS}
                value={String(setup.opponents)}
                onChange={(n) => onChange({ opponents: Number(n) })}
                className="w-32"
              />
            ) : (
              <Stepper value={setup.opponents} min={1} max={MAX_RACE_OPPONENTS} onChange={(opponents) => onChange({ opponents })} />
            )}
          </SettingRow>
          {onChangeAiSkill ? (
            <SettingRow label="AI level">
              <Slider
                value={Math.round(aiSkill)}
                min={0}
                max={100}
                step={1}
                bigStep={5}
                defaultValue={AI_SKILL_DEFAULT}
                format={(v) => `${aiSkillLabel(v)} ${v}`}
                onChange={onChangeAiSkill}
              />
            </SettingRow>
          ) : null}
          <SettingRow label="AI aggression" hint={AGGRESSION_HINT[setup.aggression]}>
            <Segmented<RaceAggression>
              options={(["clean", "normal", "hard"] as const).map((id) => ({ id, label: RACE_AGGRESSION_LABELS[id] }))}
              value={setup.aggression}
              onChange={(aggression) => onChange({ aggression })}
            />
          </SettingRow>
          {extraFieldRows}
        </Card>

        <Card title="Race" description={pause ? "Applies from next start" : undefined} className="@min-[732px]:[grid-area:race]">
          <SettingRow label="Laps" hint={distance ?? undefined}>
            <Stepper value={setup.laps} min={1} max={50} onChange={(laps) => onChange({ laps })} />
          </SettingRow>
          <SettingRow
            label="Qualifying"
            hint={setup.qualifying ? "Solo session; best clean lap sets grid position" : undefined}
          >
            <Segmented<QualifyingOption>
              options={QUALIFYING_MINUTES.map((m) => ({ id: qualifyingOption(m), label: m ? `${m} min` : "Off" }))}
              value={qualifyingOption(setup.qualifying)}
              onChange={(m) => onChange({ qualifying: Number(m) as QualifyingMinutes })}
            />
          </SettingRow>
          {/* Qualifying sets the grid: the slot and the AI order are the setup's only without it */}
          {setup.qualifying ? null : (
            <>
              <SettingRow label="Grid slot">
                <Segmented<PlayerGridSlot>
                  options={(["front", "middle", "back", "random"] as const).map((id) => ({ id, label: PLAYER_GRID_LABELS[id] }))}
                  value={setup.grid}
                  onChange={(grid) => onChange({ grid })}
                />
              </SettingRow>
              <SettingRow
                label="AI grid"
                hint={setup.aiGrid === "qualifying" ? "Pace order with qualifying variance" : undefined}
              >
                <Segmented<AiGridOrder>
                  options={(["qualifying", "pace", "reversed"] as const).map((id) => ({ id, label: AI_GRID_LABELS[id] }))}
                  value={setup.aiGrid}
                  onChange={(aiGrid) => onChange({ aiGrid })}
                />
              </SettingRow>
            </>
          )}
          <SettingRow label="Start" hint={setup.startMode === "auto" ? "Set by rules" : undefined}>
            <Segmented<RaceStartChoice>
              options={(["auto", "standing", "rolling"] as const).map((id) => ({ id, label: RACE_START_LABELS[id] }))}
              value={setup.startMode}
              onChange={(startMode) => onChange({ startMode })}
            />
          </SettingRow>
          {/* The same choice as Settings > Driving > Launch */}
          <SettingRow
            label="Launch"
            hint={setup.startMode !== "rolling" ? RACE_START_MODE_HINTS[setup.launch] : "Standing starts only"}
          >
            <Segmented<RaceStartMode>
              options={RACE_START_MODES.map((id) => ({ id, label: RACE_START_MODE_LABELS[id] }))}
              value={setup.launch}
              onChange={(launch) => onChange({ launch })}
            />
          </SettingRow>
        </Card>

        <Card title="Rules" description={pause ? "Applies from next start" : undefined} className="@min-[732px]:[grid-area:rules]">
          <SettingRow label="Rules" hint={RULE_PRESET_HINTS[setup.rulePreset]}>
            <Segmented<RulePresetId>
              options={(["auto", "open_wheel", "endurance_sprint"] as const).map((id) => ({ id, label: RULE_PRESET_LABELS[id] }))}
              value={setup.rulePreset}
              onChange={(rulePreset) => onChange({ rulePreset })}
            />
          </SettingRow>
          <SettingRow label="Track limits" hint={setup.trackLimits === "off" ? "Course cuts only" : undefined}>
            <Segmented<TrackLimitsChoice>
              options={(["auto", "off"] as const).map((id) => ({ id, label: TRACK_LIMITS_CHOICE_LABELS[id] }))}
              value={setup.trackLimits}
              onChange={(trackLimits) => onChange({ trackLimits })}
            />
          </SettingRow>
          <SettingRow label="Damage">
            <Segmented<DamageLevel>
              options={DAMAGE_LEVELS.map((id) => ({ id, label: DAMAGE_LEVEL_LABELS[id] }))}
              value={setup.damage}
              onChange={(damage) => onChange({ damage })}
            />
          </SettingRow>
        </Card>
      </div>
    </div>
  );
};
