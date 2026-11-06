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
import { DEFAULT_KEYBOARD_TUNING, type KeyboardTuning } from "@/lib/settings/player-settings";
import { suspendMenuNav } from "../useMenuNav";
import { TuningSlider } from "./TuningSlider";
import { AutoGrid, BindRow, bindKeyClass, PillAction, SetupCard, StatusPill } from "./setup-ui";
import type { SetupStepProps } from "./types";

/** Keyboard rebinding: click a slot, press a key. Taking a key from another action swaps the two. */
export const KeyboardStep: React.FC<SetupStepProps> = ({ settings, onChangeSettings, mouseSteerEnabled, onSetMouseSteer }) => {
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
        setCapture(null);
        return;
      }
      if (RESERVED_CODES.has(e.code)) {
        setNotice(`${keyLabel(e.code)} is reserved`);
        return;
      }
      const owner = KEY_ACTIONS.find((a) => settings.keys[a.id].includes(e.code) && a.id !== capture.action);
      onChangeSettings((s) => ({ ...s, keys: rebindKey(s.keys, capture.action, capture.slot, e.code) }));
      setNotice(owner ? `${keyLabel(e.code)} moved from ${owner.label}` : null);
      setCapture(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      // Let the key-up of the captured key pass before menus listen again
      window.setTimeout(resume, 0);
    };
  }, [capture, settings.keys, onChangeSettings]);

  const tuning = settings.keyboardTuning;
  const setTuning = (patch: Partial<KeyboardTuning>) =>
    onChangeSettings((prev) => ({ ...prev, keyboardTuning: { ...prev.keyboardTuning, ...patch } }));
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
                    const code = codes[slot];
                    return (
                      <span key={slot} className="group relative">
                        <button
                          type="button"
                          aria-label={code || listening ? undefined : `Add a key for ${label}`}
                          onClick={() => {
                            setNotice(null);
                            setCapture({ action: id, slot: Math.min(slot, codes.length) });
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
          {capture ? "Press a key · Esc cancels" : (notice ?? "Esc always opens the menu.")}
        </StatusPill>
      </SetupCard>

      <SetupCard
        label="Keyboard feel"
        action={
          <PillAction
            onClick={() =>
              setTuning({
                throttleRiseS: DEFAULT_KEYBOARD_TUNING.throttleRiseS,
                brakeRiseS: DEFAULT_KEYBOARD_TUNING.brakeRiseS,
                steerRiseS: DEFAULT_KEYBOARD_TUNING.steerRiseS,
                steerReturnS: DEFAULT_KEYBOARD_TUNING.steerReturnS,
                halfThrottle: DEFAULT_KEYBOARD_TUNING.halfThrottle,
              })
            }
          >
            Reset
          </PillAction>
        }
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
            label="Steering rise"
            value={tuning.steerRiseS}
            min={0.05}
            max={1}
            step={0.01}
            format={ms}
            hint="How quickly a held key steers in to the tyres' grip limit (shorter = sharper)"
            onChange={(v) => setTuning({ steerRiseS: v })}
          />
          <TuningSlider
            label="Steering return"
            value={tuning.steerReturnS}
            min={0.05}
            max={1}
            step={0.01}
            format={ms}
            hint="How quickly the steering lets go when the key is released (shorter = sharper)"
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
      </SetupCard>

      <SetupCard
        label="Keyboard assist options"
        action={
          <PillAction
            onClick={() =>
              setTuning({
                selfSteerStrength: DEFAULT_KEYBOARD_TUNING.selfSteerStrength,
                dampingStrength: DEFAULT_KEYBOARD_TUNING.dampingStrength,
                speedSensitivity: DEFAULT_KEYBOARD_TUNING.speedSensitivity,
                slipLimitMargin: DEFAULT_KEYBOARD_TUNING.slipLimitMargin,
                maxSelfSteerAngleDeg: DEFAULT_KEYBOARD_TUNING.maxSelfSteerAngleDeg,
                pedalAssistStrength: DEFAULT_KEYBOARD_TUNING.pedalAssistStrength,
                exitAssist: DEFAULT_KEYBOARD_TUNING.exitAssist,
                brakeAssist: DEFAULT_KEYBOARD_TUNING.brakeAssist,
              })
            }
          >
            Reset assist
          </PillAction>
        }
      >
        <AutoGrid min={220} className="gap-x-[22px] gap-y-3">
          <TuningSlider
            label="Self-steer & countersteer"
            value={tuning.selfSteerStrength}
            min={0}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)} %`}
            hint="How strongly the wheels follow the car's travel direction and catch rear slides"
            onChange={(v) => setTuning({ selfSteerStrength: v })}
          />
          <TuningSlider
            label="Yaw damping"
            value={tuning.dampingStrength}
            min={0}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)} %`}
            hint="Calms snap-back and pendulum oscillations when recovering from a slide"
            onChange={(v) => setTuning({ dampingStrength: v })}
          />
          <TuningSlider
            label="High-speed calm"
            value={tuning.speedSensitivity}
            min={0}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)} %`}
            hint="How much WASD steering slows down at high speed so quick taps stay gentle"
            onChange={(v) => setTuning({ speedSensitivity: v })}
          />
          <TuningSlider
            label="Tyre slip margin"
            value={tuning.slipLimitMargin}
            min={-0.25}
            max={0.25}
            step={0.01}
            format={(v) => `${v > 0 ? "+" : ""}${Math.round(v * 100)} %`}
            hint="Negative: safer understeer cushion · Positive: lets you push past peak slip"
            onChange={(v) => setTuning({ slipLimitMargin: v })}
          />
          <TuningSlider
            label="Max countersteer lock"
            value={tuning.maxSelfSteerAngleDeg}
            min={5}
            max={30}
            step={1}
            format={(v) => `${Math.round(v)}°`}
            hint="Maximum road-wheel angle the assist holds automatically when catching a slide"
            onChange={(v) => setTuning({ maxSelfSteerAngleDeg: v })}
          />
          <TuningSlider
            label="Pedal assist strength"
            value={tuning.pedalAssistStrength}
            min={0}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)} %`}
            hint="How early and deeply Throttle help and Brake help trim wheelspin and lock-ups"
            onChange={(v) => setTuning({ pedalAssistStrength: v })}
          />
        </AutoGrid>
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
