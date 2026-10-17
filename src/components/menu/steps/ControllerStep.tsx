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
import { suspendMenuNav, useGamepads } from "../useMenuNav";
import { Card, CenterMeter, Meter, SectionLabel } from "../menu-ui";
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

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <SectionLabel>Input check</SectionLabel>
        {pad ? (
          <div className="flex flex-col gap-2">
            <p className="mb-1 truncate font-f1-mono text-[12px] text-[#00D26A]">● {padDisplayName(pad.id)}</p>
            <CenterMeter label="Steer" value={pad.axes[0] ?? 0} />
            <Meter label="Throttle" value={pad.buttons[PAD_THROTTLE_BUTTON]?.value ?? 0} detail="RT" />
            <Meter label="Brake" value={pad.buttons[PAD_BRAKE_BUTTON]?.value ?? 0} color="#E10600" detail="LT" />
          </div>
        ) : (
          <p className="font-f1-mono text-[12px] text-zinc-400">
            No controller found. Connect it and press any button. Pads with a non-standard layout are set up on the
            Wheel screen.
          </p>
        )}
      </Card>

      <Card>
        <SectionLabel>Steering feel</SectionLabel>
        <div className="mb-3 grid grid-cols-3 gap-2">
          {(Object.keys(PAD_SENSITIVITY) as PadSensitivity[]).map((id) => (
            <Choice key={id} active={settings.padSensitivity === id} onClick={() => onChangeSettings((s) => ({ ...s, padSensitivity: id }))}>
              <div className="font-f1-italic text-sm uppercase">{PAD_SENSITIVITY[id].label}</div>
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
            className="cursor-pointer rounded bg-black/40 px-3 py-1.5 font-f1-mono text-[11px] font-bold uppercase text-zinc-300 hover:bg-white/10"
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
            className="cursor-pointer rounded bg-black/40 px-2 py-1 font-f1-mono text-[11px] font-bold uppercase text-zinc-300 hover:bg-white/10"
          >
            Reset
          </button>
        </div>
        <div className="grid gap-x-6 sm:grid-cols-2">
          {PAD_ACTIONS.map(({ id, label }) => {
            const listening = capturing === id;
            return (
              <div key={id} className="flex items-center justify-between gap-3 border-b border-white/5 py-1.5">
                <span className="font-f1-italic text-[14px] uppercase">{label}</span>
                <button
                  type="button"
                  onClick={() => setCapturing(listening ? null : id)}
                  className={`min-w-[5rem] cursor-pointer rounded px-2 py-1 font-f1-mono text-[12px] font-bold ${
                    listening ? "animate-pulse bg-[#E10600] text-white" : "bg-white/90 text-[#111] hover:bg-white"
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
    </div>
  );
};
