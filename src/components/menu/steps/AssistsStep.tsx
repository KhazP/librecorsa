"use client";

import React from "react";
import type { AssistPreset } from "@/types/f1";
import { Choice, Toggle } from "@/components/hud/PauseMenu";
import { keyLabel } from "@/lib/input/bindings";
import { useMenuNav } from "../useMenuNav";
import { Card, SectionLabel } from "../menu-ui";
import type { SetupStepProps } from "./types";

type Level = "beginner" | "intermediate" | "sim";

const LEVELS: { id: Level; title: string; preset: AssistPreset; racingLine: boolean; points: string[] }[] = [
  {
    id: "beginner",
    title: "Beginner",
    preset: "assisted",
    racingLine: true,
    points: ["Full traction control and ABS", "Racing line with braking zones", "Steering assist on a controller"],
  },
  {
    id: "intermediate",
    title: "Intermediate",
    preset: "semi_pro",
    racingLine: true,
    points: ["Light traction control and ABS", "Racing line shown", "Mistakes are yours to catch"],
  },
  {
    id: "sim",
    title: "Sim",
    preset: "pro",
    racingLine: false,
    points: ["No traction control, no ABS", "No racing line", "Real F1 power on cold tyres: be gentle"],
  },
];

const levelOf = (preset: AssistPreset): Level => (preset === "assisted" ? "beginner" : preset === "pro" ? "sim" : "intermediate");

/** Step 3: one-click assist levels, with the individual switches below */
export const AssistsStep: React.FC<SetupStepProps> = (p) => {
  const level = levelOf(p.assistPreset);
  const apply = (id: Level) => {
    const l = LEVELS.find((x) => x.id === id)!;
    p.onChangeAssistPreset(l.preset);
    p.onSetRacingLine(l.racingLine);
    if (id === "beginner") p.onSetGamepadAssist(true);
  };
  const idx = LEVELS.findIndex((l) => l.id === level);
  useMenuNav({
    keyboardSelect: false,
    onLeft: () => apply(LEVELS[Math.max(0, idx - 1)].id),
    onRight: () => apply(LEVELS[Math.min(LEVELS.length - 1, idx + 1)].id),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2 sm:grid-cols-3">
        {LEVELS.map((l) => {
          const active = level === l.id;
          return (
            <button
              key={l.id}
              type="button"
              onClick={() => apply(l.id)}
              className={`flex cursor-pointer flex-col items-start gap-2 rounded-md border-2 p-4 text-left transition-colors ${
                active ? "border-[#E10600] bg-[#E10600]/15" : "border-white/10 bg-[#14141c] hover:bg-[#1c1c26]"
              }`}
            >
              <span className="font-f1-italic text-lg uppercase">{l.title}</span>
              <ul className="flex flex-col gap-1 font-f1-mono text-[11px] leading-snug text-zinc-400">
                {l.points.map((pt) => (
                  <li key={pt}>· {pt}</li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>

      <Card>
        <SectionLabel>Fine tune</SectionLabel>
        <div className="mb-2 font-f1-italic text-[14px] uppercase">Traction control & ABS</div>
        <div className="mb-3 grid grid-cols-3 gap-2">
          {(
            [
              { id: "pro", label: "Off" },
              { id: "semi_pro", label: "TC + ABS" },
              { id: "assisted", label: "Full" },
            ] as const
          ).map((a) => (
            <Choice key={a.id} active={p.assistPreset === a.id} onClick={() => p.onChangeAssistPreset(a.id)}>
              <div className="text-center font-f1-italic text-sm uppercase">{a.label}</div>
            </Choice>
          ))}
        </div>
        <Toggle
          label="Racing line"
          detail={`Green to red braking guide on the track (${keyLabel(p.settings.keys.racingLine[0])})`}
          checked={p.showRacingLine}
          onChange={() => p.onSetRacingLine(!p.showRacingLine)}
        />
        {p.settings.device === "controller" ? (
          <Toggle
            label="Controller steering assist"
            detail="Keeps the front tyres at their grip limit"
            checked={p.gamepadAssist}
            onChange={() => p.onSetGamepadAssist(!p.gamepadAssist)}
          />
        ) : null}
        <p className="mt-2 font-f1-mono text-[11px] text-zinc-500">Change any of these later from the pause menu (Esc).</p>
      </Card>
    </div>
  );
};
