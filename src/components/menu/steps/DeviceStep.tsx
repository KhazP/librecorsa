"use client";

import React, { useEffect, useRef } from "react";
import type { InputDevice } from "@/lib/input/device-input";
import { isLikelyWheel, padDisplayName } from "@/lib/input/device-input";
import { useGamepads } from "../useMenuNav";
import { Card, SectionLabel } from "../menu-ui";
import type { SetupStepProps } from "./types";

const DEVICES: { id: InputDevice; title: string; detail: string; icon: string }[] = [
  { id: "keyboard", title: "Keyboard", detail: "Arrows / WASD with smoothed steering. Rebind any key.", icon: "⌨" },
  { id: "controller", title: "Controller", detail: "Xbox, PlayStation and other pads, with a steering assist.", icon: "🎮" },
  { id: "wheel", title: "Wheel", detail: "Direct drive or belt / gear wheels with pedals. Calibrated 1:1.", icon: "◎" },
];

/** Step 1: how the player drives. A connected controller or wheel is detected and preselected. */
export const DeviceStep: React.FC<SetupStepProps & { autoDetect: boolean }> = ({ settings, onChangeSettings, autoDetect }) => {
  const pads = useGamepads();
  const choose = (device: InputDevice) => onChangeSettings((s) => ({ ...s, device }));
  const touched = useRef(!autoDetect);

  // Preselect what is plugged in, until the player picks something themselves
  const detected: InputDevice | null = pads.length ? (pads.some(isLikelyWheel) ? "wheel" : "controller") : null;
  useEffect(() => {
    if (!touched.current && detected && detected !== settings.device) {
      onChangeSettings((s) => ({ ...s, device: detected }));
    }
  }, [detected, settings.device, onChangeSettings]);

  const pick = (device: InputDevice) => {
    touched.current = true;
    choose(device);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2 sm:grid-cols-3">
        {DEVICES.map((d) => {
          const active = settings.device === d.id;
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => pick(d.id)}
              aria-pressed={active}
              className={`flex cursor-pointer flex-col items-start gap-1 rounded-lg border-2 p-4 text-left transition-all ${
                active
                  ? "border-[#CCFF00] bg-[#CCFF00]/15 shadow-[inset_0_0_12px_rgba(204,255,0,0.12)]"
                  : "border-[#262B3D] bg-[#11131A] hover:border-[#8E96AA]/40 hover:bg-[#1B1F2B]"
              }`}
            >
              <span className="text-2xl leading-none" aria-hidden>
                {d.icon}
              </span>
              <span className="font-f1-italic text-lg text-[#F5F7FA] uppercase">{d.title}</span>
              <span className="font-f1-mono text-[11px] leading-snug text-[#8E96AA]">{d.detail}</span>
              {detected === d.id ? (
                <span className="mt-1 rounded-sm bg-[#CCFF00] px-1.5 py-0.5 font-f1-mono text-[10px] font-black text-[#08090D]">
                  DETECTED
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <Card>
        <SectionLabel>Connected devices</SectionLabel>
        {pads.length === 0 ? (
          <p className="font-f1-mono text-[12px] text-[#8E96AA]">
            None yet. Browsers only show a controller or wheel after you press one of its buttons, so press any
            button now.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {pads.map((p) => (
              <li key={`${p.index}-${p.id}`} className="flex items-center justify-between gap-3 font-f1-mono text-[12px]">
                <span className="truncate text-[#F5F7FA]">
                  <span className="mr-2 text-[#CCFF00]">●</span>
                  {padDisplayName(p.id)}
                </span>
                <span className="shrink-0 text-[#8E96AA]">
                  {isLikelyWheel(p) ? "WHEEL / PEDALS" : "CONTROLLER"} · {p.axes.length} AXES · {p.buttons.length} BUTTONS
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
};
