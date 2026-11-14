"use client";

import React, { useEffect, useState } from "react";
import type { InputDevice } from "@/lib/input/device-input";
import { isLikelyWheel, padDisplayName } from "@/lib/input/device-input";
import { requestTiltPermission } from "@/lib/input/touch-input";
import { Button, OptionTile, OptionTileGroup } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon, type IconName } from "@/components/ui/icons";
import { useSettingsEnv } from "@/components/settings/env";
import { SettingsCard } from "@/components/settings/fields";
import { useGamepads } from "../useMenuNav";
import { Hint } from "./setup-ui";
import { PadMap } from "./PadMap";
import { padFamilyOf } from "../input-mode";

type Choice = InputDevice | "touch" | "tilt";

interface DeviceChoice {
  id: Choice;
  title: string;
  detail: string;
  icon: IconName;
}

export const DEVICES: readonly DeviceChoice[] = [
  { id: "keyboard", title: "Keyboard", detail: "Arrows or WASD with smoothed steering. Every key can be changed", icon: "keyboard" },
  { id: "controller", title: "Controller", detail: "Any standard controller, with a steering assist", icon: "controller" },
  { id: "wheel", title: "Wheel", detail: "Direct drive, belt or gear wheels with pedals, calibrated one to one", icon: "wheel" },
];

/** On a touch screen, ahead of the rest: the on-screen controls, steered with the slider or by tilting the device */
const TOUCH_CHOICES: readonly DeviceChoice[] = [
  { id: "touch", title: "Touch", detail: "A steering slider and pedals on the screen", icon: "touch" },
  { id: "tilt", title: "Tilt", detail: "Tilt the device to steer, with the pedals on the screen", icon: "tilt" },
];

/** The device a connected pad or wheel suggests */
export const detectedDevice = (pads: readonly Gamepad[] | readonly { id: string; axes: readonly number[] }[]): InputDevice | null =>
  pads.length ? ((pads as readonly Gamepad[]).some(isLikelyWheel) ? "wheel" : "controller") : null;

/** The device tiles: picking one is the choice, the cursor passing over them changes nothing */
export function DeviceTiles({
  choices,
  value,
  detected,
  onPick,
  first,
}: {
  choices: readonly DeviceChoice[];
  value: Choice;
  detected: InputDevice | null;
  onPick: (choice: Choice) => void;
  first?: boolean;
}) {
  return (
    <OptionTileGroup aria-label="Input device" columns={3}>
      {choices.map((d) => (
        <OptionTile
          key={d.id}
          checked={value === d.id}
          onSelect={() => onPick(d.id)}
          navDefault={first && value === d.id}
          media={
            <span className="flex h-12 items-center text-lc-fog [&_svg]:size-7">
              <Icon name={d.icon} size="lg" />
            </span>
          }
          title={
            <span className="flex flex-wrap items-center gap-2">
              {d.title}
              {detected === d.id ? (
                <Badge tone="good" size="sm" dot>
                  Connected
                </Badge>
              ) : null}
            </span>
          }
          description={d.detail}
        />
      ))}
    </OptionTileGroup>
  );
}

/** Every controller and wheel the browser can see, with the button map of a standard controller */
export function ConnectedDevicesCard() {
  const { settings } = useSettingsEnv();
  const pads = useGamepads();
  // The controller whose button map is open (by pad id), if any
  const [mapFor, setMapFor] = useState<string | null>(null);
  return (
    <SettingsCard
      title="Connected devices"
      description={pads.length === 0 ? "None yet. A browser only shows a controller or wheel after one of its buttons is pressed: press one now" : undefined}
    >
      {pads.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {pads.map((p) => {
            // Only a standard-layout pad has a known button map
            const mappable = p.mapping === "standard" && !isLikelyWheel(p);
            const open = mappable && mapFor === p.id;
            return (
              <li key={`${p.index}-${p.id}`} className="flex flex-col gap-3 rounded-lc-row border border-lc-line bg-lc-well px-3.5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Badge tone="good" dot size="sm">
                      {isLikelyWheel(p) ? "Wheel" : "Controller"}
                    </Badge>
                    <span className="lc-row-label truncate">{padDisplayName(p.id)}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="lc-mono text-[12px] text-lc-slate">
                      {p.axes.length} axes, {p.buttons.length} buttons
                    </span>
                    {mappable ? (
                      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setMapFor(open ? null : p.id)}>
                        {open ? "Hide map" : "Button map"}
                      </Button>
                    ) : null}
                  </span>
                </div>
                {open ? <PadMap family={padFamilyOf(p.id)} bindings={settings.padButtons} pad={p} /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </SettingsCard>
  );
}

/** The touch choice, where the screen is one (null elsewhere): owned by the wizard, which skips the key setup for it */
export interface TouchPick {
  picked: boolean;
  onPick: (picked: boolean) => void;
}

/** First-run setup's first step: how the player drives. A connected controller or wheel is detected and preselected. */
export const DeviceStep: React.FC<{
  /** Set once the player picks a device; owned by the wizard, so it survives this step unmounting (Next, Back) */
  pickedRef: React.MutableRefObject<boolean>;
  touch: TouchPick | null;
}> = ({ pickedRef, touch }) => {
  const { settings, update } = useSettingsEnv();
  const pads = useGamepads();
  const detected = detectedDevice(pads);

  // Preselect what is plugged in, until the player picks something themselves (first run only: in Settings the
  // device is the player's explicit choice)
  useEffect(() => {
    if (!pickedRef.current && detected && (detected !== settings.device || touch?.picked)) {
      touch?.onPick(false);
      update((s) => ({ ...s, device: detected }));
    }
  }, [detected, settings.device, update, touch, pickedRef]);

  const pick = (choice: Choice) => {
    pickedRef.current = true;
    if (choice === "touch" || choice === "tilt") {
      const tiltSteer = choice === "tilt";
      // iOS asks before it sends tilt, and only from inside a tap: asked here, the prompt comes with the choice
      if (tiltSteer) void requestTiltPermission();
      touch?.onPick(true);
      update((s) => ({ ...s, touch: { ...s.touch, mode: s.touch.mode === "off" ? "auto" : s.touch.mode, tiltSteer } }));
      return;
    }
    touch?.onPick(false);
    update((s) => ({ ...s, device: choice }));
  };
  // Browsers only send tilt to a secure page (https, or localhost): over plain http on the LAN it never arrives
  const [tiltAvailable] = useState(
    () => typeof window !== "undefined" && window.isSecureContext !== false && "DeviceOrientationEvent" in window,
  );
  const activeChoice: Choice = touch?.picked ? (settings.touch.tiltSteer && tiltAvailable ? "tilt" : "touch") : settings.device;
  const choices = touch ? [...TOUCH_CHOICES.filter((c) => c.id !== "tilt" || tiltAvailable), ...DEVICES] : DEVICES;

  return (
    <div className="flex flex-col gap-3">
      <DeviceTiles choices={choices} value={activeChoice} detected={detected} onPick={pick} first />
      {/* Driving by touch, the call to press a pad's button is noise until one is connected */}
      {touch?.picked && pads.length === 0 ? null : <ConnectedDevicesCard />}
      {touch?.picked ? <Hint>The touch controls can be changed later in Settings, under Controls.</Hint> : null}
    </div>
  );
};
