"use client";

import React, { useState } from "react";
import { Button, ConfirmDialog, SettingRow, Toggle } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { KeyCap } from "@/components/ui/prompts";
import { isTouchDevice } from "@/lib/input/touch-input";
import { keyLabel, padButtonLabel } from "@/lib/input/bindings";
import { DEFAULT_HUD_PRESET, type HudPreset } from "@/lib/settings/hud-layouts";
import {
  autoQuality,
  autoQualityMinScale,
  boardWidget,
  deltaBar,
  defaultView,
  driverBody,
  fieldOfView,
  frameRate,
  headMovement,
  hudAdvanced,
  hudSize,
  lapSummary,
  mirror,
  palette,
  playerNames,
  pressureUnit,
  quality,
  radar,
  renderScale,
  sharpLow,
  sharpen,
  speedUnit,
  temperatureUnit,
  uiScale,
} from "../defs";
import {
  DEFAULT_HUD_PART,
  HUD_PART_OFFSET_MAX,
  HUD_PART_SCALE_MAX,
  HUD_PART_SCALE_MIN,
  type HudPart,
} from "@/lib/settings/player-settings";
import { useSettingsEnv } from "../env";
import { SettingsCard } from "../fields";
import { HUD_TOUCH_NOTE, HudLayoutPicker } from "../HudLayoutPicker";

/** The HUD layout card: every layout as a picture, one tap to choose (the same picker as the pause menu and setup) */
function HudLayoutCard() {
  const env = useSettingsEnv();
  const preset = env.settings.hud.preset;
  const setPreset = (id: HudPreset) => env.update((s) => ({ ...s, hud: { ...s.hud, preset: id } }));
  return (
    <SettingsCard
      title="Layout"
      description={isTouchDevice() ? HUD_TOUCH_NOTE : undefined}
      extraReset={{ changed: preset !== DEFAULT_HUD_PRESET, reset: () => setPreset(DEFAULT_HUD_PRESET) }}
      resetWhat="the HUD layout"
    >
      <HudLayoutPicker value={preset} onChange={setPreset} navDefault />
    </SettingsCard>
  );
}

export function GraphicsTab() {
  const env = useSettingsEnv();
  const vrOff = env.vrSupported ? null : "Requires WebXR headset";
  return (
    <SettingsCard title="Graphics" rows={[quality, sharpLow, renderScale, sharpen, frameRate, autoQuality, autoQualityMinScale, driverBody]} first>
      <SettingRow
        label="VR"
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

/** Button that opens the live in-game HUD layout editor: drag each part to move it, drag the corner or scroll to scale it. */
function HudEditModeRow() {
  const env = useSettingsEnv();
  return (
    <SettingRow label="Edit HUD layout" hint="Shows the live in-game HUD so you can drag and rescale every panel.">
      <Button
        size="sm"
        variant="secondary"
        onClick={() => env. update((s) => ({ ...s, hud: { ...s.hud, editMode: true } }))}
      >
        Edit layout
      </Button>
    </SettingRow>
  );
}

/** Reset every saved HUD part offset and scale back to its default spot. */
function HudResetRow() {
  const env = useSettingsEnv();
  const changed = Object.values(env.settings.hud.parts).some(
    (p) => p.x !== 0 || p.y !== 0 || p.scale !== 1,
  );
  return (
    <SettingRow
      label="Reset HUD positions"
      disabled={!changed}
      disabledReason="Already at default"
    >
      <Button size="sm" variant="danger" disabled={!changed} onClick={() => env.update((s) => ({ ...s, hud: { ...s.hud, parts: {} } }))}>
        Reset
      </Button>
    </SettingRow>
  );
}

export function HudTab() {
  return (
    <>
      <HudLayoutCard />
      <SettingsCard title="HUD layout" rows={[hudSize]}>
        <HudEditModeRow />
        <HudResetRow />
      </SettingsCard>
      <SettingsCard title="What the HUD shows" rows={[deltaBar, lapSummary, mirror, radar, playerNames, boardWidget, ...hudAdvanced]} />
    </>
  );
}



export function CameraTab() {
  const env = useSettingsEnv();
  const [asking, setAsking] = useState(false);
  const nudged = Object.keys(env.settings.cameraNudges).length > 0;
  const cameraKey = keyLabel(env.settings.keys.camera[0]);
  const freeCameraKey = env.settings.keys.freeCamera[0] ? keyLabel(env.settings.keys.freeCamera[0]) : null;
  const tvCameraKey = env.settings.keys.tvCamera[0] ? keyLabel(env.settings.keys.tvCamera[0]) : null;
  const cameraButton = padButtonLabel(env.settings.padButtons.camera);
  return (
    <SettingsCard title="Camera" rows={[defaultView, fieldOfView, headMovement]} first>
      <SettingRow label="Free camera" hint="Drag look · WASD fly · Q/E height · Scroll speed · R reset">
        {freeCameraKey ? <KeyCap>{freeCameraKey}</KeyCap> : <span className="lc-hint">Unbound</span>}
      </SettingRow>
      <SettingRow label="Trackside TV">
        {tvCameraKey ? <KeyCap>{tvCameraKey}</KeyCap> : <span className="lc-hint">Unbound</span>}
      </SettingRow>
      <SettingRow
        label="Adjust seat"
        hint={`Hold ${cameraKey} or ${cameraButton} on track`}
        disabled={!env.onOpenSeatPanel}
        disabledReason={`Available while driving (hold ${cameraKey} or ${cameraButton})`}
      >
        <Button size="sm" variant="secondary" disabled={!env.onOpenSeatPanel} onClick={() => env.onOpenSeatPanel?.()}>
          Adjust
        </Button>
      </SettingRow>
      <SettingRow
        label="Reset seat positions"
        disabled={!nudged}
        disabledReason="Already at default"
      >
        <Button size="sm" variant="danger" disabled={!nudged} onClick={() => setAsking(true)}>
          Reset
        </Button>
      </SettingRow>
      <ConfirmDialog
        open={asking}
        title="Reset seat positions?"
        confirmLabel="Reset all"
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          env.update((s) => ({ ...s, cameraNudges: {} }));
          setAsking(false);
        }}
      >
        Resets cockpit and dash seat offsets for all cars.
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
