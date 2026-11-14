"use client";

import React, { useRef } from "react";
import { Button, Card, Disclosure, SettingRow } from "@/components/ui";
import { PadGlyph } from "@/components/ui/prompts";
import { useInputMode } from "./input-mode";
import { focusables, useMoveHandler } from "./useFocusNav";
import type { CarDefinition } from "@/lib/cars/car-registry";
import type { TrackInfo } from "@/lib/track-registry";
import { aiDriversFor } from "@/lib/sim/ai-opponents";
import { AI_SKILL_DEFAULT, aiSkillLabel } from "@/lib/sim/ai-tuning";
import { RACE_START_LABELS, type RaceSetup } from "@/lib/sim/race-setup";
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
  /** The player's driver code on the grid */
  playerCode?: string;
  onOpenCircuit: () => void;
  onOpenConditions?: () => void;
  /** Opens the car browser (named for the Event row it once sat behind) */
  onOpenGarage: () => void;
  onStart: () => void;
}

interface GridSlot {
  code: string;
  /** The team's own colour (data), absent for the player */
  color?: string;
  player?: boolean;
}

/** The grid as it will line up: AI by pace (qualifying shuffles it a little), the player in the chosen slot */
function gridPreview(setup: RaceSetup, playerCode: string): GridSlot[] {
  const ai: GridSlot[] = aiDriversFor(setup.opponents)
    .slice()
    .sort((a, b) => b.pace - a.pace)
    .map((d) => ({ code: d.code, color: d.teamColorHex }));
  if (setup.aiGrid === "reversed") ai.reverse();
  const n = ai.length + 1;
  const slot = setup.grid === "front" ? 0 : setup.grid === "middle" ? Math.floor((n - 1) / 2) : setup.grid === "random" ? -1 : n - 1;
  const out = [...ai];
  if (slot >= 0) out.splice(slot, 0, { code: playerCode, player: true });
  return out;
}

/** A summary row that opens another panel (circuit, conditions, car) */
const LinkRow: React.FC<{ label: string; value: string; onClick?: () => void; navDefault?: boolean }> = ({
  label,
  value,
  onClick,
  navDefault,
}) => (
  <SettingRow label={label} hint={value}>
    {onClick ? (
      <Button size="sm" variant="secondary" onClick={onClick} data-nav-default={navDefault ? "" : undefined} aria-label={`Change ${label.toLowerCase()}: ${value}`}>
        Change
      </Button>
    ) : null}
  </SettingRow>
);

const GridList: React.FC<{ grid: GridSlot[]; drawn: boolean }> = ({ grid, drawn }) => (
  <div className="flex flex-col gap-2 pb-1">
    <ol className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-1 p-0 sm:grid-cols-3">
      {grid.map((g, i) => (
        <li key={g.code} className={`flex items-center gap-2 rounded-lc-nub px-2 py-1 ${g.player ? "bg-lc-volt/10" : ""}`}>
          <span className="lc-data w-[2.5ch] text-right text-[12px] text-lc-slate">{i + 1}</span>
          <span
            aria-hidden
            className={`h-3 w-1 shrink-0 rounded-full ${g.player ? "bg-lc-volt" : ""}`}
            // ui-allow: hex-in-style a team's own colour is data
            style={g.color ? { background: g.color } : undefined}
          />
          <span className={`lc-data text-[13px] ${g.player ? "text-lc-volt" : "text-lc-chalk"}`}>{g.code}</span>
        </li>
      ))}
    </ol>
    {drawn ? <p className="lc-hint m-0">Your slot is drawn at the start.</p> : null}
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
  onOpenCircuit,
  onOpenConditions,
  onOpenGarage,
  onStart,
}) => {
  const { mode, family } = useInputMode();
  const grid = gridPreview(setup, playerCode);
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
      <Card title="Event">
        <LinkRow navDefault label="Circuit" value={track.layout ? `${track.name} · ${track.layout}` : track.name} onClick={onOpenCircuit} />
        <LinkRow label="Conditions" value={conditionsLabel ?? "As set"} onClick={onOpenConditions} />
        <LinkRow label="Car" value={`${car.title}, for the whole field`} onClick={onOpenGarage} />
        <Disclosure moreLabel={`Show the grid (${grid.length} cars)`} lessLabel="Hide the grid">
          <GridList grid={grid} drawn={setup.grid === "random"} />
        </Disclosure>
      </Card>

      <RaceRules context="title" setup={setup} onChange={onChange} aiSkill={aiSkill} onChangeAiSkill={onChangeAiSkill} trackLengthM={track.lengthM} />

      {/* Pinned to the bottom of the screen while the setup scrolls under it: the start is never below the fold. The
          scrim hides the rows passing behind and below the bar, so nothing shows in the gap under it */}
      <div className="pointer-events-none sticky -bottom-5 z-10 -mt-3 rounded-b-lc-card bg-linear-to-t from-lc-carbon from-70% to-transparent pt-6 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div data-nav-pinned="" className="pointer-events-auto flex items-center justify-between gap-x-4 rounded-lc-card border border-lc-line bg-lc-carbon py-2.5 pr-2.5 pl-4.5 shadow-lc-pop phone:gap-x-3">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="lc-row-label truncate">
              {setup.laps} {setup.laps === 1 ? "lap" : "laps"}
              {distance ? `, ${distance}` : ""}, {setup.opponents} AI {setup.opponents === 1 ? "car" : "cars"}
            </span>
            <span className="lc-hint truncate phone:hidden">
              {aiSkillLabel(aiSkill)} AI, {RACE_START_LABELS[setup.start].toLowerCase()} start
            </span>
          </span>
          <Button ref={startRef} variant="primary" size="lg" onClick={onStart} prompt={mode === "pad" ? <PadGlyph button="menu" family={family} /> : undefined}>
            Start race
          </Button>
        </div>
      </div>
    </div>
  );
};
