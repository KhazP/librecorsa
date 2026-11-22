"use client";

import React from "react";
import { Card, Disclosure, Segmented, Select, SettingRow, Slider, Stepper } from "@/components/ui";
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

/** The field sizes on offer, the same list on the title's Race panel and in pause */
const OPPONENT_OPTIONS = Array.from({ length: MAX_RACE_OPPONENTS }, (_, i) => {
  const n = i + 1;
  return { id: String(n), label: `${n} ${n === 1 ? "car" : "cars"}` };
});
/** Pause in practice or an AI race: the same list, with no field at all first */
const OFF = "off";
const OPPONENT_OPTIONS_OR_OFF = [{ id: OFF, label: "Off" }, ...OPPONENT_OPTIONS];

export interface RaceRulesProps {
  /** Where the rules are shown: the title's Race panel, or the pause menu while a session runs */
  context: "title" | "pause";
  setup?: RaceSetup;
  onChange: (patch: Partial<RaceSetup>) => void;
  /** AI level, 0 (Rookie) to 100 (Alien); applies at once, mid-race too */
  aiSkill?: number;
  onChangeAiSkill?: (skill: number) => void;
  /**
   * Pause only: AI opponents on or off (turning them on or off restarts the run). With the switch, the AI opponents
   * row offers Off beside the field sizes, and in practice the race and its rules wait behind a fold
   */
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
  // Pause with the switch at hand (not online, not on a hill climb): one row says whether there is a field and how big
  const canSwitch = pause && onToggleAiOpponents !== undefined;
  const racing = aiOpponents === true;
  const fieldOff = canSwitch && !racing;
  // In practice the race and its rules are for an AI race that is not running: they wait behind a fold
  const folded = fieldOff;
  const heavy = !fieldOff && setup.opponents > HEAVY_FIELD ? "Large field may reduce frame rate" : null;
  const fieldHint =
    [
      // Any change of field restarts: the shell rebuilds a running AI race from the lights, and the switch restarts
      // the session either way
      canSwitch ? (racing ? "Changing it restarts the race" : "Picking a field restarts the session as an AI race") : null,
      heavy,
    ]
      .filter(Boolean)
      .join(". ") || undefined;

  const pickField = (id: string) => {
    if (id === OFF) {
      if (racing) onToggleAiOpponents?.();
      return;
    }
    const opponents = Number(id);
    // The title, an online race, or an AI race running (the shell restarts it with the new field)
    if (!fieldOff) {
      onChange({ opponents });
      return;
    }
    if (opponents === setup.opponents) {
      onToggleAiOpponents?.();
      return;
    }
    // From practice to a field of another size. The switch builds the field from the settings the session holds, which
    // take the new size in the shell's effect after this render: switched at once, the race would start at the old
    // size and then again at the new one. A task later the session has it, and the race starts once
    onChange({ opponents });
    window.setTimeout(() => onToggleAiOpponents?.(), 0);
  };

  const raceRows = (
    <>
      <SettingRow label="Laps" hint={distance ?? undefined}>
        <Stepper value={setup.laps} min={1} max={50} onChange={(laps) => onChange({ laps })} />
      </SettingRow>
      <SettingRow label="Qualifying" hint={setup.qualifying ? "Solo session; best clean lap sets grid position" : undefined}>
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
          <SettingRow label="AI grid" hint={setup.aiGrid === "qualifying" ? "Pace order with qualifying variance" : undefined}>
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
      <SettingRow label="Launch" hint={setup.startMode !== "rolling" ? RACE_START_MODE_HINTS[setup.launch] : "Standing starts only"}>
        <Segmented<RaceStartMode>
          options={RACE_START_MODES.map((id) => ({ id, label: RACE_START_MODE_LABELS[id] }))}
          value={setup.launch}
          onChange={(launch) => onChange({ launch })}
        />
      </SettingRow>
    </>
  );

  const rulesRows = (
    <>
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
    </>
  );

  return (
    // data-nav-columns: up / down read down the field card, the race card, then the rules (menu-shell's reading order).
    // Two columns once there is room: the rules under the short field card, the race beside both
    <div className={className ?? "@container"}>
      <div
        data-nav-columns=""
        className="grid grid-cols-1 items-start gap-3 @min-[732px]:grid-cols-2 @min-[732px]:[grid-template-areas:'field_race'_'rules_race']"
      >
        <Card title="Field" className="@min-[732px]:[grid-area:field]">
          {/* One control for the field on both screens: a list, which commits once (in pause a new field restarts the
              race, where a stepper would restart it on every step). Pause adds Off, for practice */}
          <SettingRow label="AI opponents" hint={fieldHint}>
            <Select
              options={canSwitch ? OPPONENT_OPTIONS_OR_OFF : OPPONENT_OPTIONS}
              value={fieldOff ? OFF : String(setup.opponents)}
              onChange={pickField}
              className="w-32"
            />
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

        {folded ? (
          // Every row still one press away, in the same order, without two cards of them for a race that is not on
          <Card title="AI race" description="Used once AI opponents are on" className="@min-[732px]:[grid-area:race]">
            <Disclosure moreLabel="Show laps, start and rules" lessLabel="Hide laps, start and rules">
              {raceRows}
              {rulesRows}
            </Disclosure>
          </Card>
        ) : (
          <>
            <Card title="Race" description={pause ? "Applies from next start" : undefined} className="@min-[732px]:[grid-area:race]">
              {raceRows}
            </Card>
            <Card title="Rules" description={pause ? "Applies from next start" : undefined} className="@min-[732px]:[grid-area:rules]">
              {rulesRows}
            </Card>
          </>
        )}
      </div>
    </div>
  );
};
