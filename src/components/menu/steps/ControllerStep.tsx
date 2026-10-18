"use client";

import React, { useEffect, useState } from "react";
import {
  DEFAULT_PAD_BUTTONS,
  PAD_ACTIONS,
  PAD_BRAKE_BUTTON,
  PAD_THROTTLE_BUTTON,
  padButtonLabel,
  rebindPadButton,
  type PadAction,
} from "@/lib/input/bindings";
import {
  connectedPads,
  newlyPressedButton,
  PAD_SENSITIVITY,
  padDisplayName,
  snapshotButtons,
  type PadSensitivity,
} from "@/lib/input/device-input";
import { Choice, Toggle } from "@/components/hud/PauseMenu";
import { DEFAULT_PAD_TUNING, type PadTuning } from "@/lib/settings/player-settings";
import { suspendMenuNav, useGamepads } from "../useMenuNav";
import { Card, CenterMeter, Meter, SectionLabel } from "../menu-ui";
import { StickCurve, TriggerBars, TuningSlider } from "./TuningSlider";
import type { SetupStepProps } from "./types";

type VibratingPad = Gamepad & {
  vibrationActuator?: { playEffect?: (type: string, params: Record<string, number>) => Promise<unknown> } | null;
};

function testRumble() {
  for (const pad of connectedPads() as VibratingPad[]) {
    try {
      void pad.vibrationActuator
        ?.playEffect?.("dual-rumble", { startDelay: 0, duration: 450, weakMagnitude: 0.6, strongMagnitude: 0.9 })
        ?.catch(() => {});
    } catch {
      // No rumble on this pad
    }
  }
}

/** Waits for the next button press on a standard controller and reports its index */
function useButtonCapture(active: boolean, onButton: (button: number) => void, onCancel: () => void) {
  useEffect(() => {
    if (!active) return;
    const resume = suspendMenuNav();
    let prev = snapshotButtons(connectedPads());
    let raf = 0;
    const poll = () => {
      raf = requestAnimationFrame(poll);
      const pads = connectedPads().filter((p) => p.mapping === "standard");
      const hit = newlyPressedButton(prev, pads);
      prev = snapshotButtons(connectedPads());
      if (hit) onButton(hit.button);
    };
    raf = requestAnimationFrame(poll);
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, { capture: true });
      // Hold the menus until the captured button is released
      const wait = () => {
        if (connectedPads().some((p) => p.buttons.some((b) => b.pressed))) requestAnimationFrame(wait);
        else resume();
      };
      wait();
    };
  }, [active, onButton, onCancel]);
}

/** Controller: live input check, steering feel, rumble and button layout */
export const ControllerStep: React.FC<SetupStepProps> = ({
  settings,
  onChangeSettings,
  gamepadAssist,
  onSetGamepadAssist,
  gamepadRumble,
  onToggleGamepadRumble,
}) => {
  const pads = useGamepads();
  const pad = pads.find((p) => p.mapping === "standard") ?? null;
  const [capturing, setCapturing] = useState<PadAction | null>(null);

  const onButton = React.useCallback(
    (button: number) => {
      if (!capturing) return;
      onChangeSettings((s) => ({ ...s, padButtons: rebindPadButton(s.padButtons, capturing, button) }));
      setCapturing(null);
    },
    [capturing, onChangeSettings]
  );
  const onCancel = React.useCallback(() => setCapturing(null), []);
  useButtonCapture(capturing !== null, onButton, onCancel);

  const tuning = settings.padTuning;
  const setTuning = (patch: Partial<PadTuning>) =>
    onChangeSettings((prev) => ({ ...prev, padTuning: { ...prev.padTuning, ...patch } }));
  // Back to the defaults, keeping the steering rate and dead zone of the chosen feel preset
  const resetTuning = () =>
    onChangeSettings((prev) => ({
      ...prev,
      padTuning: {
        ...DEFAULT_PAD_TUNING,
        steeringRate: PAD_SENSITIVITY[prev.padSensitivity].steeringRate,
        deadzone: PAD_SENSITIVITY[prev.padSensitivity].deadzone,
      },
    }));
  const curveLabel = (v: number) => (Math.abs(v - 1) < 0.025 ? "Linear" : v > 1 ? `Progressive ${v.toFixed(2)}` : `Aggressive ${v.toFixed(2)}`);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <SectionLabel>Input check</SectionLabel>
        {pad ? (
          <div className="flex flex-col gap-2">
            <p className="mb-1 truncate font-f1-mono text-[12px] text-[#CCFF00]">● {padDisplayName(pad.id)}</p>
            <CenterMeter label="Steer" value={pad.axes[0] ?? 0} />
            <Meter label="Throttle" value={pad.buttons[PAD_THROTTLE_BUTTON]?.value ?? 0} detail="RT" />
            <Meter label="Brake" value={pad.buttons[PAD_BRAKE_BUTTON]?.value ?? 0} color="#FF2A3C" detail="LT" />
          </div>
        ) : (
          <p className="font-f1-mono text-[12px] text-[#8E96AA]">
            No controller found. Connect it and press any button. Pads with a non-standard layout are set up on the
            Wheel screen.
          </p>
        )}
      </Card>

      <Card>
        <SectionLabel>Steering feel</SectionLabel>
        <div className="mb-3 grid grid-cols-3 gap-2">
          {(Object.keys(PAD_SENSITIVITY) as PadSensitivity[]).map((id) => (
            <Choice
              key={id}
              active={settings.padSensitivity === id}
              onClick={() =>
                onChangeSettings((s) => ({
                  ...s,
                  padSensitivity: id,
                  padTuning: { ...s.padTuning, steeringRate: PAD_SENSITIVITY[id].steeringRate, deadzone: PAD_SENSITIVITY[id].deadzone },
                }))
              }
            >
              <div className="font-f1-italic text-sm text-[#F5F7FA] uppercase">{PAD_SENSITIVITY[id].label}</div>
              <div className="font-f1-mono text-[11px] opacity-75">{PAD_SENSITIVITY[id].detail}</div>
            </Choice>
          ))}
        </div>
        <Toggle
          label="Steering assist"
          detail="The stick steers up to the front tyres' grip limit and helps catch slides"
          checked={gamepadAssist}
          onChange={() => onSetGamepadAssist(!gamepadAssist)}
        />
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <Toggle
              label="Rumble"
              detail="Kerbs, lock-ups, wheelspin and grass"
              checked={gamepadRumble}
              onChange={onToggleGamepadRumble}
            />
          </div>
          <button
            type="button"
            onClick={testRumble}
            className="cursor-pointer rounded border border-[#262B3D] bg-[#08090D] px-3 py-1.5 font-f1-mono text-[11px] font-bold text-[#8E96AA] uppercase hover:border-[#CCFF00] hover:text-[#CCFF00]"
          >
            Test
          </button>
        </div>
      </Card>

      <Card>
        <div className="mb-2 flex items-center justify-between">
          <SectionLabel className="!mb-0">Buttons · RT throttle · LT brake · left stick steers</SectionLabel>
          <button
            type="button"
            onClick={() => onChangeSettings((s) => ({ ...s, padButtons: DEFAULT_PAD_BUTTONS }))}
            className="cursor-pointer rounded border border-[#262B3D] bg-[#08090D] px-2 py-1 font-f1-mono text-[11px] font-bold text-[#8E96AA] uppercase hover:border-[#CCFF00] hover:text-[#CCFF00]"
          >
            Reset
          </button>
        </div>
        <div className="grid gap-x-6 sm:grid-cols-2">
          {PAD_ACTIONS.map(({ id, label }) => {
            const listening = capturing === id;
            return (
              <div key={id} className="flex items-center justify-between gap-3 border-b border-[#262B3D]/60 py-1.5">
                <span className="font-f1-italic text-[14px] text-[#F5F7FA] uppercase">{label}</span>
                <button
                  type="button"
                  onClick={() => setCapturing(listening ? null : id)}
                  className={`min-w-[5rem] cursor-pointer rounded px-2 py-1 font-f1-mono text-[12px] font-bold transition-colors ${
                    listening
                      ? "animate-pulse bg-[#CCFF00] text-[#08090D]"
                      : "bg-[#F5F7FA] text-[#08090D] hover:bg-[#CCFF00]"
                  }`}
                >
                  {listening ? "PRESS…" : padButtonLabel(settings.padButtons[id])}
                </button>
              </div>
            );
          })}
        </div>
        <p className="mt-2 font-f1-mono text-[11px] text-zinc-500">
          {capturing ? "Press a controller button · Esc cancels" : "Click a button, then press the one you want."}
        </p>
      </Card>

      <Card>
        <div className="mb-2 flex items-center justify-between gap-2">
          <SectionLabel className="!mb-0">Fine tuning</SectionLabel>
          <button
            type="button"
            onClick={resetTuning}
            className="cursor-pointer rounded border border-[#262B3D] bg-[#08090D] px-2 py-1 font-f1-mono text-[11px] font-bold text-[#8E96AA] uppercase hover:border-[#CCFF00] hover:text-[#CCFF00]"
          >
            Reset tuning
          </button>
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <div className="flex flex-col">
            <TuningSlider
              label="Steering speed"
              value={tuning.steeringRate}
              min={0.1}
              max={1.5}
              step={0.05}
              format={(v) => `×${v.toFixed(2)}`}
              hint="How quickly the stick turns the steering assist"
              onChange={(v) => setTuning({ steeringRate: v })}
            />
            <TuningSlider
              label="Inner dead zone"
              value={tuning.deadzone}
              min={0}
              max={0.3}
              step={0.01}
              format={(v) => `${Math.round(v * 100)} %`}
              hint="Stick travel ignored around centre"
              onChange={(v) => setTuning({ deadzone: v })}
            />
            <TuningSlider
              label="Outer dead zone"
              value={tuning.outerDeadzone}
              min={0}
              max={0.3}
              step={0.01}
              format={(v) => `${Math.round(v * 100)} %`}
              hint="Full lock is reached before the stick's physical stop"
              onChange={(v) => setTuning({ outerDeadzone: v })}
            />
            <TuningSlider
              label="Stick linearity"
              value={tuning.linearity}
              min={0.5}
              max={3}
              step={0.05}
              format={(v) => (Math.abs(v - 1) < 0.025 ? "1.00 = linear" : v.toFixed(2))}
              hint="Above 1 gives finer control near centre"
              onChange={(v) => setTuning({ linearity: v })}
            />
            <TuningSlider
              label="Throttle curve"
              value={tuning.throttleGamma}
              min={0.5}
              max={3}
              step={0.05}
              format={curveLabel}
              hint="Above 1 keeps light presses gentler"
              onChange={(v) => setTuning({ throttleGamma: v })}
            />
            <TuningSlider
              label="Brake curve"
              value={tuning.brakeGamma}
              min={0.5}
              max={3}
              step={0.05}
              format={curveLabel}
              hint="Above 1 gives finer brake control at light pressure"
              onChange={(v) => setTuning({ brakeGamma: v })}
            />
          </div>
          <div className="flex flex-col gap-3">
            <StickCurve deadzone={tuning.deadzone} outerDeadzone={tuning.outerDeadzone} linearity={tuning.linearity} />
            <TriggerBars throttleGamma={tuning.throttleGamma} brakeGamma={tuning.brakeGamma} />
          </div>
        </div>
        <div className="mt-2">
          <Toggle
            label="Impulse-trigger rumble (Xbox)"
            detail="ABS pulses in LT, wheelspin in RT"
            checked={tuning.triggerRumble}
            onChange={() => setTuning({ triggerRumble: !tuning.triggerRumble })}
          />
        </div>
      </Card>
    </div>
  );
};
