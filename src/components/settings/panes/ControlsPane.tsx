"use client";

import React from "react";
import { useTranslations } from "use-intl/react";
import { Button, SettingRow } from "@/components/ui";
import { ConnectedDevicesCard, detectedDevice, DeviceTiles, DEVICES } from "@/components/menu/steps/DeviceStep";
import { KeyboardSetup } from "@/components/menu/steps/KeyboardStep";
import { ControllerSetup } from "@/components/menu/steps/ControllerStep";
import { WheelSetup } from "@/components/menu/steps/WheelStep";
import { useGamepads } from "@/components/menu/useMenuNav";
import type { InputDevice } from "@/lib/input/device-input";
import { tiltRange, tiltSteer, touchLayout, touchMode } from "../defs";
import { useSettingsEnv } from "../env";
import { SettingsCard } from "../fields";

/**
 * Settings > Controls > Device: the device the game drives with is chosen here and only here (bug F02: looking at
 * another device's tab never changes it)
 */
export function DeviceTab() {
  const env = useSettingsEnv();
  const tx = useTranslations("settings.controls");
  const pads = useGamepads();
  return (
    <>
      <SettingsCard title={tx("activeDevice")}>
        <DeviceTiles
          choices={DEVICES}
          value={env.settings.device}
          detected={detectedDevice(pads)}
          onPick={(d) => env.update((s) => ({ ...s, device: d as InputDevice }))}
          first
        />
      </SettingsCard>
      <ConnectedDevicesCard />
      {env.onRunSetup ? (
        <SettingsCard title={tx("quickSetup")}>
          <SettingRow label={tx("runSetupWizard")}>
            <Button size="sm" variant="secondary" onClick={env.onRunSetup}>
              {tx("runSetup")}
            </Button>
          </SettingRow>
        </SettingsCard>
      ) : null}
    </>
  );
}

export const KeyboardTab = KeyboardSetup;
export const ControllerTab = ControllerSetup;
export const WheelTab = () => <WheelSetup first />;

export function TouchTab() {
  const tx = useTranslations("settings.controls");
  return <SettingsCard title={tx("touch")} rows={[touchMode, touchLayout, tiltSteer, tiltRange]} first />;
}
