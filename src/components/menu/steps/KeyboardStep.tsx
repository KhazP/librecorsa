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
import { Card, SectionLabel } from "../menu-ui";
import { TuningSlider } from "./TuningSlider";
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
      <Card>
        <div className="mb-2 flex items-center justify-between">
          <SectionLabel className="!mb-0">Key bindings</SectionLabel>
          <button
            type="button"
            onClick={() => onChangeSettings((s) => ({ ...s, keys: DEFAULT_KEY_BINDINGS }))}
            className="cursor-pointer rounded bg-black/40 px-2 py-1 font-f1-mono text-[11px] font-bold uppercase text-zinc-300 hover:bg-white/10"
          >
            Reset
          </button>
        </div>
        <div className="flex flex-col">
          {KEY_ACTIONS.map(({ id, label }) => {
            const codes = settings.keys[id];
            const slots = Math.max(KEY_SLOTS, codes.length);
            return (
              <div key={id} className="flex items-center justify-between gap-3 border-b border-white/5 py-1.5 last:border-0">
                <span className="font-f1-italic text-[14px] uppercase">{label}</span>
                <span className="flex gap-1.5">
                  {Array.from({ length: slots }, (_, slot) => {
                    const listening = capture?.action === id && capture.slot === slot;
                    const code = codes[slot];
                    return (
                      <span key={slot} className="group relative">
                        <button
                          type="button"
                          onClick={() => {
                            setNotice(null);
                            setCapture({ action: id, slot: Math.min(slot, codes.length) });
                          }}
                          className={`min-w-[4.5rem] cursor-pointer rounded px-2 py-1 font-f1-mono text-[12px] font-bold transition-colors ${
                            listening
                              ? "animate-pulse bg-[#CCFF00] text-[#08090D]"
                              : code
                                ? "bg-[#F5F7FA] text-[#08090D] hover:bg-[#CCFF00]"
                                : "border border-[#262B3D] bg-[#08090D] text-[#8E96AA] hover:border-[#8E96AA]"
                          }`}
                        >
                          {listening ? "PRESS…" : code ? keyLabel(code) : "+"}
                        </button>
                        {code && !listening ? (
                          <button
                            type="button"
                            aria-label={`Unbind ${keyLabel(code)}`}
                            onClick={() => onChangeSettings((s) => ({ ...s, keys: clearKey(s.keys, id, slot) }))}
                            className="absolute -top-1.5 -right-1.5 hidden h-4 w-4 cursor-pointer items-center justify-center rounded-full bg-zinc-700 text-[10px] leading-none text-white group-hover:flex"
                          >
                            ×
                          </button>
                        ) : null}
                      </span>
                    );
                  })}
                </span>
              </div>
            );
          })}
        </div>
        <p className="mt-2 min-h-[1rem] font-f1-mono text-[11px] text-zinc-500">
          {capture ? "Press a key · Esc cancels" : (notice ?? "Esc always opens the menu.")}
        </p>
      </Card>
      <Card>
        <div className="mb-2 flex items-center justify-between gap-2">
          <SectionLabel className="!mb-0">Keyboard feel</SectionLabel>
          <button
            type="button"
            onClick={() => onChangeSettings((s) => ({ ...s, keyboardTuning: DEFAULT_KEYBOARD_TUNING }))}
            className="cursor-pointer rounded bg-black/40 px-2 py-1 font-f1-mono text-[11px] font-bold uppercase text-zinc-300 hover:bg-white/10"
          >
            Reset
          </button>
        </div>
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
          hint="Time to steer from centre to the speed's lock"
          onChange={(v) => setTuning({ steerRiseS: v })}
        />
        <TuningSlider
          label="Steering return"
          value={tuning.steerReturnS}
          min={0.05}
          max={1}
          step={0.01}
          format={ms}
          hint="Time for the wheel to centre after the key is let go"
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
        <div className="mt-1">
          <Toggle
            label="Corner-exit throttle assist"
            detail="Eases the throttle in while the rear tyres are at their limit"
            checked={tuning.exitAssist}
            onChange={() => setTuning({ exitAssist: !tuning.exitAssist })}
          />
        </div>
      </Card>
      <Card>
        <Toggle
          label="Mouse steering"
          detail="Steer with the mouse across the screen; throttle and brake stay on the keys"
          checked={mouseSteerEnabled}
          onChange={() => onSetMouseSteer(!mouseSteerEnabled)}
        />
      </Card>
    </div>
  );
};
