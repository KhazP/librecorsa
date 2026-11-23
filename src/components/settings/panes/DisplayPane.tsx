"use client";

import React, { useState } from "react";
import { useTranslations } from "use-intl/react";
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
  language,
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
  const tx = useTranslations("settings.display.layout");
  const preset = env.settings.hud.preset;
  const setPreset = (id: HudPreset) => env.update((s) => ({ ...s, hud: { ...s.hud, preset: id } }));
  return (
    <SettingsCard
      title={tx("title")}
      description={isTouchDevice() ? HUD_TOUCH_NOTE : undefined}
      extraReset={{ changed: preset !== DEFAULT_HUD_PRESET, reset: () => setPreset(DEFAULT_HUD_PRESET) }}
      resetWhat={tx("resetWhat")}
    >
      <HudLayoutPicker value={preset} onChange={setPreset} navDefault />
    </SettingsCard>
  );
}

export function GraphicsTab() {
  const env = useSettingsEnv();
  const tx = useTranslations("settings.display.graphics");
  const vrOff = env.vrSupported ? null : tx("vrOff");
  return (
    <SettingsCard title={tx("title")} rows={[quality, sharpLow, renderScale, sharpen, frameRate, autoQuality, autoQualityMinScale, driverBody]} first>
      <SettingRow
        label={tx("vr")}
        disabled={vrOff !== null}
        disabledReason={vrOff ?? undefined}
      >
        <Badge tone="warn" size="sm">
          {tx("experimental")}
        </Badge>
        <Button size="sm" variant="secondary" disabled={vrOff !== null || env.vrActive} onClick={() => env.onEnterVr?.()}>
          {env.vrActive ? tx("inVr") : tx("enterVr")}
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
  const tx = useTranslations("settings.display.hud");
  return (
    <>
      <HudLayoutCard />
      <SettingsCard title="HUD layout" rows={[hudSize]}>
        <HudEditModeRow />
        <HudResetRow />
      </SettingsCard>
      <SettingsCard title={tx("title")} rows={[deltaBar, lapSummary, mirror, radar, playerNames, boardWidget, ...hudAdvanced]} />
    </>
  );
}



export function CameraTab() {
  const env = useSettingsEnv();
  const tx = useTranslations("settings.display.camera");
  const [asking, setAsking] = useState(false);
  const nudged = Object.keys(env.settings.cameraNudges).length > 0;
  const cameraKey = keyLabel(env.settings.keys.camera[0]);
  const freeCameraKey = env.settings.keys.freeCamera[0] ? keyLabel(env.settings.keys.freeCamera[0]) : null;
  const tvCameraKey = env.settings.keys.tvCamera[0] ? keyLabel(env.settings.keys.tvCamera[0]) : null;
  const cameraButton = padButtonLabel(env.settings.padButtons.camera);
  return (
    <SettingsCard title={tx("title")} rows={[defaultView, fieldOfView, headMovement]} first>
      <SettingRow label={tx("freeCamera")} hint={tx("freeCameraHint")}>
        {freeCameraKey ? <KeyCap>{freeCameraKey}</KeyCap> : <span className="lc-hint">{tx("freeCameraUnbound")}</span>}
      </SettingRow>
      <SettingRow label={tx("tvCamera")}>
        {tvCameraKey ? <KeyCap>{tvCameraKey}</KeyCap> : <span className="lc-hint">{tx("tvCameraUnbound")}</span>}
      </SettingRow>
      <SettingRow
        label={tx("adjustSeat")}
        hint={tx("adjustSeatHint", { key: cameraKey, button: cameraButton })}
        disabled={!env.onOpenSeatPanel}
        disabledReason={tx("adjustSeatOff", { key: cameraKey, button: cameraButton })}
      >
        <Button size="sm" variant="secondary" disabled={!env.onOpenSeatPanel} onClick={() => env.onOpenSeatPanel?.()}>
          {tx("adjust")}
        </Button>
      </SettingRow>
      <SettingRow
        label={tx("resetSeats")}
        disabled={!nudged}
        disabledReason={tx("resetSeatsOff")}
      >
        <Button size="sm" variant="danger" disabled={!nudged} onClick={() => setAsking(true)}>
          {tx("resetSeatsButton")}
        </Button>
      </SettingRow>
      <ConfirmDialog
        open={asking}
        title={tx("resetSeatsTitle")}
        confirmLabel={tx("resetSeatsConfirm")}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          env.update((s) => ({ ...s, cameraNudges: {} }));
          setAsking(false);
        }}
      >
        {tx("resetSeatsBody")}
      </ConfirmDialog>
    </SettingsCard>
  );
}

export function InterfaceTab() {
  const tx = useTranslations("settings.display.interface");
  return (
    <>
      <SettingsCard title={tx("language")} rows={[language]} first />
      <SettingsCard title={tx("units")} rows={[speedUnit, temperatureUnit, pressureUnit]} />
      <SettingsCard title={tx("sizeColour")} rows={[uiScale, palette]} />
    </>
  );
}
