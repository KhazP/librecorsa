"use client";

import React from "react";
import { DEFAULT_DEVICE_ASSIST_TUNING, ASSIST_PRESETS, assistPresetDetail, matchingAssistPreset } from "@/lib/sim/steering-assist";
import { AssistCurve } from "@/components/menu/steps/setup-ui";
import {
  assistLevel,
  assistSliders,
  autoGearbox,
  brakeHelp,
  controllerSteerAssist,
  ghost,
  pedalHelpStrength,
  racingLine,
  realism,
  tcAbs,
  throttleHelp,
} from "../defs";
import { useSettingsEnv } from "../env";
import { choice, SettingsCard, type RowDef } from "../fields";

/** Settings > Driving > Assists: the first-run assist levels and every driving aid, in one place */
export function AssistsTab() {
  const env = useSettingsEnv();
  const onPad = env.settings.device === "controller";
  return (
    <>
      <SettingsCard
        title="Driving aids"
        first
        rows={[assistLevel, tcAbs, racingLine, autoGearbox, { ...controllerSteerAssist, advanced: !onPad }]}
      />
      <SettingsCard title="Pedal help" description="For the keyboard, where a key is all or nothing" rows={[throttleHelp, brakeHelp]} />
      <SettingsCard title="On track" rows={[realism, ghost]} />
    </>
  );
}

/** A device's steering assist preset, as a list chosen once (a preset replaces the tuning below it) */
function presetRow(device: "keyboard" | "controller"): RowDef {
  const tuningOf = (env: ReturnType<typeof useSettingsEnv>) =>
    device === "keyboard" ? env.settings.keyboardTuning : env.settings.padTuning;
  return choice("select", {
    id: `${device}-assistPreset`,
    label: "Preset",
    hint: (env) => {
      const p = matchingAssistPreset(tuningOf(env));
      return p ? assistPresetDetail(p.tuning, env.steerLockDeg) : "My own tuning";
    },
    advanced: true,
    options: (env) => [
      ...ASSIST_PRESETS.map((p) => ({ id: p.id, label: p.label, detail: assistPresetDetail(p.tuning, env.steerLockDeg) })),
      { id: "custom", label: "Custom", detail: "My own tuning", disabled: true },
    ],
    read: (env) => matchingAssistPreset(tuningOf(env))?.id ?? "custom",
    write: (env, id) => {
      const preset = ASSIST_PRESETS.find((p) => p.id === id);
      if (!preset) return;
      env.update((s) =>
        device === "keyboard"
          ? { ...s, keyboardTuning: { ...s.keyboardTuning, ...preset.tuning } }
          : { ...s, padTuning: { ...s.padTuning, ...preset.tuning } },
      );
    },
    initial: () => matchingAssistPreset(DEFAULT_DEVICE_ASSIST_TUNING)?.id ?? "balanced",
  });
}

const KEYBOARD_ROWS = [presetRow("keyboard"), ...assistSliders("keyboard"), pedalHelpStrength];
const CONTROLLER_ROWS = [presetRow("controller"), ...assistSliders("controller")];

/** Settings > Driving > Steering help: how the keyboard and controller steering assists catch the car (all advanced) */
export function SteeringHelpTab() {
  const env = useSettingsEnv();
  const lock = env.steerLockDeg ?? 30;
  return (
    <>
      <SettingsCard
        title="Keyboard steering"
        description="How the assist steers for a key that can only be on or off"
        rows={KEYBOARD_ROWS}
        first
      >
        <div className="max-w-[280px] pt-2">
          <AssistCurve tuning={env.settings.keyboardTuning} device="keyboard" lockDeg={lock} />
        </div>
      </SettingsCard>
      <SettingsCard title="Controller steering" description="How the assist steers for the stick" rows={CONTROLLER_ROWS}>
        <div className="max-w-[280px] pt-2">
          <AssistCurve tuning={env.settings.padTuning} device="controller" lockDeg={lock} />
        </div>
      </SettingsCard>
    </>
  );
}
