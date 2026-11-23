"use client";

import React, { useRef } from "react";
import { useTranslations } from "use-intl/react";
import { Button, Card, Disclosure, SettingRow } from "@/components/ui";
import { PadGlyph } from "@/components/ui/prompts";
import { useInputMode } from "./input-mode";
import { focusables, useMoveHandler } from "./useFocusNav";
import type { CarDefinition } from "@/lib/cars/car-registry";
import type { TrackInfo } from "@/lib/track-registry";
import { aiDriversFor, aiRaceCodes } from "@/lib/sim/ai-opponents";
import { AI_SKILL_DEFAULT, aiSkillLabel } from "@/lib/sim/ai-tuning";
import { raceStartSuffix, type RaceSetup } from "@/lib/sim/race-setup";
import { RaceRules, useRaceDistance } from "./RaceRules";

export interface RaceSetupPanelProps {
  setup: RaceSetup;
  onChange: (patch: Partial<RaceSetup>) => void;
  aiSkill?: number;
  onChangeAiSkill?: (skill: number) => void;
  track: TrackInfo;
  /** Weather and time of day, as a line */
  conditionsLabel?: string;
  car: Pick<CarDefinition, "id" | "quality" | "title" | "badge"> & { color: string };
  /** The player's driver code and colour on the grid (Settings > Display > Driver) */
  playerCode?: string;
  playerColor?: string;
  onOpenCircuit: () => void;
  onOpenConditions?: () => void;
  /** Opens the car browser (named for the Event row it once sat behind) */
  onOpenGarage: () => void;
  onStart: () => void;
}

interface GridSlot {
  code: string;
  /** The team's own colour, the player's own (data); absent: the player's volt */
  color?: string;
  player?: boolean;
}

/**
 * The grid as it will line up: AI by pace (qualifying shuffles it a little), under the codes they race with beside the
 * player's (`aiRaceCodes`), and the player in the chosen slot
 */
function gridPreview(setup: RaceSetup, playerCode: string, playerColor: string | undefined): GridSlot[] {
  const drivers = aiDriversFor(setup.opponents);
  const codes = aiRaceCodes(drivers.map((d) => d.code), playerCode);
  const ai: GridSlot[] = drivers
    .map((d, i) => ({ code: codes[i], color: d.teamColorHex, pace: d.pace }))
    .sort((a, b) => b.pace - a.pace)
    .map(({ code, color }) => ({ code, color }));
  if (setup.aiGrid === "reversed") ai.reverse();
  const n = ai.length + 1;
  const slot = setup.grid === "front" ? 0 : setup.grid === "middle" ? Math.floor((n - 1) / 2) : setup.grid === "random" ? -1 : n - 1;
  const out = [...ai];
  if (slot >= 0) out.splice(slot, 0, { code: playerCode, color: playerColor, player: true });
  return out;
}

/** A summary row that opens another panel (circuit, conditions, car); `changeLabel` names its button for screen readers */
const LinkRow: React.FC<{ label: string; value: string; changeLabel?: string; onClick?: () => void; navDefault?: boolean }> = ({
  label,
  value,
  changeLabel,
  onClick,
  navDefault,
}) => {
  const tx = useTranslations("menu.raceSetup");
  return (
    <SettingRow label={label} hint={value}>
      {onClick ? (
        <Button size="sm" variant="secondary" onClick={onClick} data-nav-default={navDefault ? "" : undefined} aria-label={changeLabel}>
          {tx("change")}
        </Button>
      ) : null}
    </SettingRow>
  );
};

const GridList: React.FC<{ grid: GridSlot[]; drawn: boolean; drawnNote: string }> = ({ grid, drawn, drawnNote }) => (
  <div className="flex flex-col gap-2 pb-1">
    <ol className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-1 p-0 sm:grid-cols-3">
      {grid.map((g, i) => (
        <li key={g.code} className={`flex items-center gap-2 rounded-lc-nub px-2 py-1 ${g.player ? "bg-lc-volt/10" : ""}`}>
          <span className="lc-data w-[2.5ch] text-end text-[12px] text-lc-slate">{i + 1}</span>
          <span
            aria-hidden
            className={`h-3 w-1 shrink-0 rounded-full ${g.player && !g.color ? "bg-lc-volt" : ""}`}
            // ui-allow: hex-in-style a team's own colour is data, as is the player's
            style={g.color ? { background: g.color } : undefined}
          />
          <span className={`lc-data text-[13px] ${g.player ? "text-lc-volt" : "text-lc-chalk"}`}>{g.code}</span>
        </li>
      ))}
    </ol>
    {drawn ? <p className="lc-hint m-0">{drawnNote}</p> : null}
  </div>
);

/** The race before the lights: the event, the rules (shared with pause), the grid it makes, and the start */
export const RaceSetupPanel: React.FC<RaceSetupPanelProps> = ({
  setup,
  onChange,
  aiSkill = AI_SKILL_DEFAULT,
  onChangeAiSkill,
  track,
  conditionsLabel,
  car,
  playerCode = "YOU",
  playerColor,
  onOpenCircuit,
  onOpenConditions,
  onOpenGarage,
  onStart,
}) => {
  const { mode, family } = useInputMode();
  const tx = useTranslations("menu.raceSetup");
  const circuitValue = track.layout ? `${track.name} · ${track.layout}` : track.name;
  const conditionsValue = conditionsLabel ?? tx("conditionsAsSet");
  const carValue = tx("carForField", { car: car.title });
  const grid = gridPreview(setup, playerCode, playerColor);
  const fieldSize = grid.length + (setup.grid === "random" ? 1 : 0);
  const distance = useRaceDistance(setup.laps, track.lengthM);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<HTMLButtonElement | null>(null);
  // The start bar is pinned over the bottom of the setup, so it is never "below" the last rows on screen: down from
  // the lowest row of the setup goes to Start race
  useMoveHandler((dir) => {
    const root = rootRef.current;
    const start = startRef.current;
    const active = document.activeElement as HTMLElement | null;
    if (dir !== "down" || !root || !start || !active || !root.contains(active) || active === start) return false;
    const a = active.getBoundingClientRect();
    const below = focusables(root).some((el) => el !== start && el.getBoundingClientRect().top >= a.bottom - 2);
    if (below) return false;
    start.focus({ preventScroll: true });
    return true;
  });

  return (
    // Rows the cursor lands on scroll clear of the pinned start bar
    <div ref={rootRef} className="flex flex-col gap-3 [&_button]:scroll-mb-28 [&_input]:scroll-mb-28">
      <Card title={tx("event")}>
        <LinkRow navDefault label={tx("circuit")} value={circuitValue} changeLabel={tx("changeCircuit", { value: circuitValue })} onClick={onOpenCircuit} />
        <LinkRow
          label={tx("conditions")}
          value={conditionsValue}
          changeLabel={tx("changeConditions", { value: conditionsValue })}
          onClick={onOpenConditions}
        />
        <LinkRow label={tx("car")} value={carValue} changeLabel={tx("changeCar", { value: carValue })} onClick={onOpenGarage} />
        {/* Qualifying sets the grid, so there is no order to preview. A random slot leaves the player out of the
            preview, not out of the field */}
        {setup.qualifying ? (
          <LinkRow label={tx("grid")} value={tx("gridByQualifying", { count: fieldSize })} />
        ) : (
          <Disclosure moreLabel={tx("showGrid", { count: fieldSize })} lessLabel={tx("hideGrid")}>
            <GridList grid={grid} drawn={setup.grid === "random"} drawnNote={tx("slotDrawn")} />
          </Disclosure>
        )}
      </Card>

      <RaceRules context="title" setup={setup} onChange={onChange} aiSkill={aiSkill} onChangeAiSkill={onChangeAiSkill} trackLengthM={track.lengthM} />

      {/* Pinned to the bottom of the screen while the setup scrolls under it: the start is never below the fold. The
          scrim hides the rows passing behind and below the bar, so nothing shows in the gap under it */}
      <div className="pointer-events-none sticky -bottom-5 z-10 -mt-3 rounded-b-lc-card bg-linear-to-t from-lc-carbon from-70% to-transparent pt-6 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div data-nav-pinned="" className="pointer-events-auto flex items-center justify-between gap-x-4 rounded-lc-card border border-lc-line bg-lc-carbon py-2.5 pe-2.5 ps-4.5 shadow-lc-pop phone:gap-x-3">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="lc-row-label truncate">
              {distance
                ? tx("summaryDistance", { laps: setup.laps, distance, opponents: setup.opponents })
                : tx("summary", { laps: setup.laps, opponents: setup.opponents })}
            </span>
            <span className="lc-hint truncate phone:hidden">
              {tx(setup.startMode !== "rolling" && setup.launch === "manual" ? "aiLineManual" : "aiLine", {
                skill: aiSkillLabel(aiSkill),
                start: raceStartSuffix(setup.startMode, ", "),
              })}
            </span>
          </span>
          <Button ref={startRef} variant="primary" size="lg" onClick={onStart} prompt={mode === "pad" ? <PadGlyph button="menu" family={family} /> : undefined}>
            {tx("startRace")}
          </Button>
        </div>
      </div>
    </div>
  );
};
