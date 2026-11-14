"use client";

import React, { useState } from "react";
import { Button, ConfirmDialog, SettingRow } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { isTouchDevice } from "@/lib/input/touch-input";
import { keyLabel, padButtonLabel } from "@/lib/input/bindings";
import type { HudPreset } from "@/lib/settings/player-settings";
import {
  deltaBar,
  defaultView,
  driverBody,
  fieldOfView,
  headMovement,
  HUD_LAYOUTS,
  hudAdvanced,
  hudSize,
  lapSummary,
  mirror,
  palette,
  pressureUnit,
  quality,
  radar,
  renderScale,
  speedUnit,
  temperatureUnit,
  uiScale,
} from "../defs";
import { useSettingsEnv } from "../env";
import { choice, hud, SettingsCard } from "../fields";

/** Where each HUD layout puts its panels: a diagram, drawn in the text colour of its tile */
function HudThumb({ preset, chosen }: { preset: HudPreset; chosen: boolean }) {
  const boxes: Record<HudPreset, [number, number, number, number][]> = {
    broadcast: [[3, 3, 13, 15], [50, 3, 11, 9], [18, 28, 28, 5]],
    dash: [[3, 3, 9, 5], [51, 3, 10, 8], [20, 21, 24, 12]],
    telemetry: [[3, 3, 11, 14], [50, 3, 11, 14], [3, 22, 11, 11], [50, 20, 11, 13], [21, 23, 22, 10]],
    classic: [[3, 3, 12, 12], [49, 3, 12, 10], [3, 23, 12, 10], [47, 21, 14, 12], [26, 3, 12, 3]],
    minimal: [[3, 3, 12, 8], [47, 23, 14, 10]],
  };
  return (
    <svg viewBox="0 0 64 36" aria-hidden className={`block h-14 w-full bg-lc-void ${chosen ? "text-lc-chalk" : "text-lc-slate"}`}>
      {boxes[preset].map(([x, y, w, h]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} rx={2} fill="currentColor" />
      ))}
    </svg>
  );
}

const hudLayout = choice("tiles", {
  id: "hudPreset",
  label: "Layout",
  hint: () => (isTouchDevice() ? "With the touch controls on, the HUD uses its touch layout" : undefined),
  options: HUD_LAYOUTS,
  columns: 3,
  media: (id, chosen) => <HudThumb preset={id as HudPreset} chosen={chosen} />,
  ...hud("preset"),
});

export function GraphicsTab() {
  const env = useSettingsEnv();
  const vrOff = env.vrSupported
    ? null
    : "No headset found. VR needs a browser with WebXR and a headset connected";
  return (
    <SettingsCard title="Graphics" rows={[quality, renderScale, driverBody]} first>
      <SettingRow
        label="VR"
        hint="Drive in a headset. Still experimental: expect rough edges"
        disabled={vrOff !== null}
        disabledReason={vrOff ?? undefined}
      >
        <Badge tone="warn" size="sm">
          Experimental
        </Badge>
        <Button size="sm" variant="secondary" disabled={vrOff !== null || env.vrActive} onClick={() => env.onEnterVr?.()}>
          {env.vrActive ? "In VR" : "Enter VR"}
        </Button>
      </SettingRow>
    </SettingsCard>
  );
}

export function HudTab() {
  return (
    <SettingsCard title="What the HUD shows" rows={[hudLayout, hudSize, deltaBar, lapSummary, mirror, radar, ...hudAdvanced]} first />
  );
}

export function CameraTab() {
  const env = useSettingsEnv();
  const [asking, setAsking] = useState(false);
  const nudged = Object.keys(env.settings.cameraNudges).length > 0;
  const cameraKey = keyLabel(env.settings.keys.camera[0]);
  const cameraButton = padButtonLabel(env.settings.padButtons.camera);
  return (
    <SettingsCard title="Camera" rows={[defaultView, fieldOfView, headMovement]} first>
      <SettingRow
        label="Adjust seat"
        hint={`Moves the cockpit and dash views of this car. While driving, hold ${cameraKey} or ${cameraButton}`}
        disabled={!env.onOpenSeatPanel}
        disabledReason={`Only while driving: hold ${cameraKey} or ${cameraButton} in the car`}
      >
        <Button size="sm" variant="secondary" disabled={!env.onOpenSeatPanel} onClick={() => env.onOpenSeatPanel?.()}>
          Adjust now
        </Button>
      </SettingRow>
      <SettingRow
        label="Reset seat positions"
        hint="Puts every car's cockpit and dash views back where the car has them"
        disabled={!nudged}
        disabledReason="Every car is at its own seat position"
      >
        <Button size="sm" variant="danger" disabled={!nudged} onClick={() => setAsking(true)}>
          Reset
        </Button>
      </SettingRow>
      <ConfirmDialog
        open={asking}
        title="Reset seat positions?"
        confirmLabel="Reset every car"
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          env.update((s) => ({ ...s, cameraNudges: {} }));
          setAsking(false);
        }}
      >
        Every car&apos;s cockpit and dash views go back to where the car has them, with their field of view.
      </ConfirmDialog>
    </SettingsCard>
  );
}

export function InterfaceTab() {
  return (
    <>
      <SettingsCard title="Units" rows={[speedUnit, temperatureUnit, pressureUnit]} first />
      <SettingsCard title="Size and colour" rows={[uiScale, palette]} />
    </>
  );
}
