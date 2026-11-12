"use client";

import React, { useEffect, useState } from "react";
import {
  clearKey,
  DEFAULT_KEY_BINDINGS,
  KEY_ACTIONS,
  KEY_SLOTS,
  keyLabel,
  rebindKey,
  RESERVED_CODES,
  type KeyAction,
} from "@/lib/input/bindings";
import { Toggle } from "@/components/hud/PauseMenu";
import {
  KEYBOARD_FEEL_FIELDS,
  KEYBOARD_PEDAL_HELP_FIELDS,
  resetKeyboardTuning,
  type KeyboardTuning,
} from "@/lib/settings/player-settings";
import { suspendMenuNav } from "../useMenuNav";
import { CAPTURE_TIMEOUT_S } from "./button-capture";
import { TuningSlider } from "./TuningSlider";
import { AssistTuningCard, AutoGrid, BindRow, bindKeyClass, PillAction, SetupCard, StatusPill } from "./setup-ui";
import type { SetupStepProps } from "./types";

/** Keyboard rebinding: click a slot, press a key. Taking a key from another action swaps the two. */
export const KeyboardStep: React.FC<SetupStepProps & { steerLockDeg?: number }> = ({
  settings,
  onChangeSettings,
  mouseSteerEnabled,
  onSetMouseSteer,
  steerLockDeg,
}) => {
  const [capture, setCapture] = useState<{ action: KeyAction; slot: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!capture) return;
    const resume = suspendMenuNav();
    const onKey = (e: KeyboardEvent) => {
      // Capture phase + stopImmediatePropagation: the menu and the simulator never see this key
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === "Escape") {
        setNotice(null);
        setCapture(null);
        return;
      }
      if (RESERVED_CODES.has(e.code)) {
        // Still listening: the prompt shows this until another key is pressed
        setNotice(`${keyLabel(e.code)} is reserved · press another key`);
        return;
      }
      const owner = KEY_ACTIONS.find((a) => settings.keys[a.id].includes(e.code) && a.id !== capture.action);
      onChangeSettings((s) => ({ ...s, keys: rebindKey(s.keys, capture.action, capture.slot, e.code) }));
      setNotice(owner ? `${keyLabel(e.code)} moved from ${owner.label}` : null);
      setCapture(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    // Gives up like the controller and wheel captures, so a controller that opened it is never stuck here
    const timeout = window.setTimeout(() => {
      setNotice(null);
      setCapture(null);
    }, CAPTURE_TIMEOUT_S * 1000);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("keydown", onKey, { capture: true });
      // Let the key-up of the captured key pass before menus listen again
      window.setTimeout(resume, 0);
    };
  }, [capture, settings.keys, onChangeSettings]);

  const tuning = settings.keyboardTuning;
  const setTuning = (patch: Partial<KeyboardTuning>) =>
    onChangeSettings((prev) => ({ ...prev, keyboardTuning: { ...prev.keyboardTuning, ...patch } }));
  const reset = (fields: readonly (keyof KeyboardTuning)[]) =>
    onChangeSettings((prev) => ({ ...prev, keyboardTuning: resetKeyboardTuning(prev.keyboardTuning, fields) }));
  const ms = (v: number) => `${Math.round(v * 1000)} ms`;

  return (
    <div className="flex flex-col gap-4">
      <SetupCard
        label="Key bindings"
        action={<PillAction onClick={() => onChangeSettings((s) => ({ ...s, keys: DEFAULT_KEY_BINDINGS }))}>Reset</PillAction>}
      >
        <AutoGrid min={330} className="gap-x-[18px] gap-y-0.5">
          {KEY_ACTIONS.map(({ id, label }) => {
            const codes = settings.keys[id];
            const slots = Math.max(KEY_SLOTS, codes.length);
            return (
              <BindRow key={id} label={label} listening={capture?.action === id}>
                <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  {Array.from({ length: slots }, (_, slot) => {
                    const listening = capture?.action === id && capture.slot === slot;
                    // An empty slot binds the next free one, so the clicked chip and the one listening can differ
                    const target = Math.min(slot, codes.length);
                    const code = codes[slot];
                    return (
                      <span key={slot} className="group relative">
                        <button
                          type="button"
                          aria-label={code || listening ? undefined : `Add a key for ${label}`}
                          onClick={() => {
                            setNotice(null);
                            // Clicking the chip that is listening stops listening, as on the controller and wheel
                            setCapture(capture?.action === id && capture.slot === target ? null : { action: id, slot: target });
                          }}
                          className={bindKeyClass(listening ? "listening" : code ? "bound" : "empty")}
                        >
                          {listening ? "PRESS…" : code ? keyLabel(code) : "+"}
                        </button>
                        {code && !listening ? (
                          <button
                            type="button"
                            aria-label={`Unbind ${keyLabel(code)}`}
                            onClick={() => onChangeSettings((s) => ({ ...s, keys: clearKey(s.keys, id, slot) }))}
                            className="absolute -top-1.5 -right-1.5 hidden h-[18px] w-[18px] cursor-pointer items-center justify-center rounded-full border border-[#08090D] bg-[#3A4157] text-[11px] leading-none text-[#F5F7FA] group-hover:flex hover:bg-[#FF2A3C]"
                          >
                            ×
                          </button>
                        ) : null}
                      </span>
                    );
                  })}
                </span>
              </BindRow>
            );
          })}
        </AutoGrid>
        <StatusPill tone={capture ? "live" : notice ? "info" : "idle"}>
          {capture ? (notice ?? `Press a key · Esc cancels · stops after ${CAPTURE_TIMEOUT_S} s`) : (notice ?? "Esc always opens the menu.")}
        </StatusPill>
      </SetupCard>

      <SetupCard
        label="Keyboard feel"
        action={<PillAction onClick={() => reset(KEYBOARD_FEEL_FIELDS)}>Reset</PillAction>}
      >
        <AutoGrid min={220} className="gap-x-[22px] gap-y-3">
          <TuningSlider
            label="Throttle rise"
            value={tuning.throttleRiseS}
            min={0}
            max={1}
            step={0.01}
            format={ms}
            hint="Time for the throttle key to reach full throttle"
            onChange={(v) => setTuning({ throttleRiseS: v })}
          />
          <TuningSlider
            label="Brake rise"
            value={tuning.brakeRiseS}
            min={0}
            max={1}
            step={0.01}
            format={ms}
            hint="Time for the brake key to reach full brake"
            onChange={(v) => setTuning({ brakeRiseS: v })}
          />
          <TuningSlider
            label="Steering smoothing"
            value={tuning.steerRiseS}
            min={0.05}
            max={1}
            step={0.01}
            format={ms}
            hint="How gently a held key steers in, on top of each car's own curve (quicker in slow corners, gentler at speed). Shorter = sharper"
            onChange={(v) => setTuning({ steerRiseS: v })}
          />
          <TuningSlider
            label="Steering return"
            value={tuning.steerReturnS}
            min={0.05}
            max={1}
            step={0.01}
            format={ms}
            hint="How quickly the steering returns to centre when the key is let go (shorter = quicker)"
            onChange={(v) => setTuning({ steerReturnS: v })}
          />
          <TuningSlider
            label="Half throttle"
            value={tuning.halfThrottle}
            min={0.2}
            max={0.9}
            step={0.01}
            format={(v) => `${Math.round(v * 100)} %`}
            hint="Throttle while the Half throttle key is held with throttle"
            onChange={(v) => setTuning({ halfThrottle: v })}
          />
        </AutoGrid>
        <div className="border-t border-[#262B3D] pt-2.5">
          <Toggle
            label="Input trace on the HUD"
            detail="Your keys dashed against the road-wheel angle, with throttle and brake (always on in the Telemetry HUD)"
            checked={settings.hud.inputTrace}
            onChange={() => onChangeSettings((s) => ({ ...s, hud: { ...s.hud, inputTrace: !s.hud.inputTrace } }))}
          />
        </div>
      </SetupCard>

      <AssistTuningCard device="keyboard" tuning={tuning} onChange={setTuning} lockDeg={steerLockDeg} />

      <SetupCard
        label="Pedal help"
        action={<PillAction onClick={() => reset(KEYBOARD_PEDAL_HELP_FIELDS)}>Reset</PillAction>}
      >
        <TuningSlider
          label="Pedal help strength"
          value={tuning.pedalAssistStrength}
          min={0}
          max={1}
          step={0.05}
          format={(v) => `${Math.round(v * 100)} %`}
          hint="How early and how far Throttle help and Brake help ease the keys back"
          onChange={(v) => setTuning({ pedalAssistStrength: v })}
        />
        <div className="border-t border-[#262B3D] pt-2.5">
          <Toggle
            label="Throttle help"
            detail="With traction control off, eases the throttle key back while the rear tyres pass their grip"
            checked={tuning.exitAssist}
            onChange={() => setTuning({ exitAssist: !tuning.exitAssist })}
          />
          <Toggle
            label="Brake help"
            detail="With ABS off, eases the brake key back while the tyres pass their grip"
            checked={tuning.brakeAssist}
            onChange={() => setTuning({ brakeAssist: !tuning.brakeAssist })}
          />
        </div>
      </SetupCard>

      <SetupCard ariaLabel="Mouse steering">
        <Toggle
          label="Mouse steering"
          detail="Steer with the mouse across the screen; throttle and brake stay on the keys"
          checked={mouseSteerEnabled}
          onChange={() => onSetMouseSteer(!mouseSteerEnabled)}
        />
      </SetupCard>
    </div>
  );
};
