"use client";

import React from "react";
import type { AssistPreset } from "@/types/f1";
import { Toggle } from "@/components/hud/PauseMenu";
import { keyLabel } from "@/lib/input/bindings";
import { Check } from "lucide-react";
import { Segmented } from "../menu-ui";
import { AutoGrid, Hint, SetupCard } from "./setup-ui";
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

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <div className="grid gap-3 sm:grid-cols-3">
        {LEVELS.map((l, index) => {
          const active = level === l.id;
          const barColor = active ? "#CCFF00" : l.id === "sim" ? "#FF2A3C" : "#8E96AA";
          return (
            <button
              key={l.id}
              type="button"
              onClick={() => apply(l.id)}
              aria-pressed={active}
              className={`lc-glass relative flex cursor-pointer flex-col items-start gap-3 rounded-[24px] p-5 text-left transition-[background-color,border-color,box-shadow] duration-200 short:gap-2 short:p-3.5 ${
                active
                  ? "border-[1.5px]! border-[#CCFF00]! bg-[#CCFF00]/[0.07]! shadow-[0_0_0_6px_rgba(204,255,0,0.08)]!"
                  : "hover:border-[#3A4157]!"
              }`}
            >
              <span aria-hidden className="flex items-end gap-1">
                {[10, 16, 22].map((h, i) => (
                  <span key={h} className="w-2 rounded-full" style={{ height: h, background: i <= index ? barColor : "#262B3D" }} />
                ))}
              </span>
              <span className={`lc-disp text-[30px] short:text-[22px] ${active ? "text-[#F5F7FA]" : "text-[#C5CBD8]"}`}>{l.title}</span>
              <ul
                className={`m-0 flex list-none flex-col gap-1.5 p-0 text-[14px] leading-[1.4] short:hidden ${
                  active ? "text-[#C5CBD8]" : "text-[#8E96AA]"
                }`}
              >
                {l.points.map((pt) => (
                  <li key={pt} className="flex gap-2">
                    <span aria-hidden className="mt-2 h-[5px] w-[5px] shrink-0 rounded-full bg-[#3A4157]" />
                    {pt}
                  </li>
                ))}
              </ul>
              {active ? (
                <span
                  aria-hidden
                  className="absolute top-4 right-4 inline-flex h-[26px] w-[26px] items-center justify-center rounded-full bg-[#CCFF00]"
                >
                  <Check className="h-[15px] w-[15px] text-[#08090D]" strokeWidth={3.2} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <SetupCard label="Fine tune" className="gap-3!">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="lc-title text-[15px] text-[#F5F7FA]">Traction control &amp; ABS</span>
          <Segmented
            label="Traction control and ABS"
            className="w-full sm:w-auto sm:flex-[0_1_380px]"
            value={p.assistPreset}
            onChange={(id) => p.onChangeAssistPreset(id)}
            options={[
              { id: "pro", label: "Off" },
              { id: "semi_pro", label: "TC + ABS" },
              { id: "assisted", label: "Full" },
            ]}
          />
        </div>
        <AutoGrid min={300} className="gap-x-7 gap-y-1">
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
        </AutoGrid>
        <Hint>Change any of these later from the pause menu (Esc).</Hint>
      </SetupCard>
    </div>
  );
};
