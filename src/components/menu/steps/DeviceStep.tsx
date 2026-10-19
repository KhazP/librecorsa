"use client";

import React, { useEffect, useRef, useState } from "react";
import type { InputDevice } from "@/lib/input/device-input";
import { isLikelyWheel, padDisplayName } from "@/lib/input/device-input";
import { useGamepads } from "../useMenuNav";
import { Check, Gamepad2, Keyboard } from "lucide-react";
import { Hint, PillAction, SetupCard } from "./setup-ui";
import { PadMap } from "./PadMap";
import { padFamilyOf } from "../input-mode";
import type { SetupStepProps } from "./types";

/** Steering wheel glyph in the lucide style (lucide has no wheel icon) */
const WheelIcon: React.FC<{ className?: string; strokeWidth?: number }> = ({ className, strokeWidth = 1.8 }) => (
  <svg
    viewBox="0 0 24 24"
    className={className}
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="2" />
    <path d="M12 14v8M10.2 11.1 2.5 9.5M13.8 11.1l7.7-1.6" />
  </svg>
);

const DEVICES: {
  id: InputDevice;
  title: string;
  detail: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
}[] = [
  { id: "keyboard", title: "Keyboard", detail: "Arrows / WASD with smoothed steering. Rebind any key.", icon: Keyboard },
  { id: "controller", title: "Controller", detail: "Xbox, PlayStation and other pads, with a steering assist.", icon: Gamepad2 },
  { id: "wheel", title: "Wheel", detail: "Direct drive or belt / gear wheels with pedals. Calibrated 1:1.", icon: WheelIcon },
];

/** Step 1: how the player drives. A connected controller or wheel is detected and preselected. */
export const DeviceStep: React.FC<SetupStepProps & { autoDetect: boolean }> = ({ settings, onChangeSettings, autoDetect }) => {
  const pads = useGamepads();
  const choose = (device: InputDevice) => onChangeSettings((s) => ({ ...s, device }));
  const touched = useRef(!autoDetect);
  // The controller whose button map is open (by pad id), if any
  const [mapFor, setMapFor] = useState<string | null>(null);

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
    <div className="flex flex-col gap-4 sm:gap-[22px]">
      <div className="grid gap-3 sm:grid-cols-3">
        {DEVICES.map((d) => {
          const active = settings.device === d.id;
          const Icon = d.icon;
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => pick(d.id)}
              aria-pressed={active}
              className={`lc-glass relative flex cursor-pointer flex-col items-start gap-3.5 rounded-[24px] p-5 text-left transition-[background-color,border-color,box-shadow] duration-200 not-compact:min-h-[220px] short:gap-2 short:p-3.5 ${
                active
                  ? "border-[1.5px]! border-[#CCFF00]! bg-[#CCFF00]/[0.07]! shadow-[0_0_0_6px_rgba(204,255,0,0.08)]!"
                  : "hover:border-[#3A4157]!"
              }`}
            >
              <span
                aria-hidden
                className={`inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-full short:h-10 short:w-10 ${
                  active ? "bg-[#CCFF00] text-[#08090D]" : "bg-[#1B1F2B] text-[#C5CBD8]"
                }`}
              >
                <Icon className="h-[26px] w-[26px] short:h-5 short:w-5" strokeWidth={1.8} />
              </span>
              <span className={`lc-disp text-[28px] short:text-[22px] ${active ? "text-[#F5F7FA]" : "text-[#C5CBD8]"}`}>
                {d.title}
              </span>
              <span className={`text-[14px] leading-[1.45] short:hidden ${active ? "text-[#C5CBD8]" : "text-[#8E96AA]"}`}>
                {d.detail}
              </span>
              {detected === d.id ? (
                <span className="mt-auto inline-flex h-6 items-center gap-1.5 rounded-full bg-[#CCFF00] px-2.5 font-f1-mono text-[10px] font-extrabold tracking-[0.1em] text-[#08090D]">
                  <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
                    <span className="lc-ping absolute inset-0 rounded-full bg-[#08090D]" />
                    <span className="relative h-1.5 w-1.5 rounded-full bg-[#08090D]" />
                  </span>
                  DETECTED
                </span>
              ) : null}
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

      <SetupCard label="Connected devices" className="gap-3!">
        {pads.length === 0 ? (
          <Hint className="text-[14px]!">
            None yet. Browsers only show a controller or wheel after you press one of its buttons, so press any
            button now.
          </Hint>
        ) : (
          <ul className="flex flex-col gap-2">
            {pads.map((p) => {
              // Only a standard-layout pad has a known button map
              const mappable = p.mapping === "standard" && !isLikelyWheel(p);
              const open = mappable && mapFor === p.id;
              return (
                <li
                  key={`${p.index}-${p.id}`}
                  className="flex flex-col gap-3 rounded-2xl border border-[#262B3D] bg-[#08090D] px-3.5 py-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <span className="flex min-w-0 items-center gap-2.5 text-[15px] font-bold text-[#F5F7FA]">
                      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-[#CCFF00] shadow-[0_0_8px_#CCFF00]" />
                      <span className="truncate">{padDisplayName(p.id)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="font-f1-mono text-[11px] font-bold tracking-[0.1em] text-[#8E96AA]">
                        {isLikelyWheel(p) ? "WHEEL / PEDALS" : "CONTROLLER"} · {p.axes.length} AXES · {p.buttons.length} BUTTONS
                      </span>
                      {mappable ? (
                        <PillAction onClick={() => setMapFor(open ? null : p.id)}>{open ? "Hide map" : "Button map"}</PillAction>
                      ) : null}
                    </span>
                  </div>
                  {open ? <PadMap family={padFamilyOf(p.id)} bindings={settings.padButtons} pad={p} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </SetupCard>
    </div>
  );
};
