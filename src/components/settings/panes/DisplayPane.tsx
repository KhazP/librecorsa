"use client";

import React, { useState } from "react";
import { useTranslations } from "use-intl/react";
import { Button, ConfirmDialog, SettingRow } from "@/components/ui";
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
  engineeringTelemetry,
  fieldOfView,
  frameRate,
  fullPodium,
  headMovement,
  hudAdvanced,
  hudSize,
  lapSummary,
  mirror,
  language,
  palette,
  playerNames,
  preRaceShow,
  raceEventCards,
  pressureUnit,
  quality,
  radar,
  renderScale,
  sharpLow,
  sharpen,
  speedUnit,
  temperatureUnit,
  uiScale,
  screensMode,
  screenSize,
  screenDistance,
  screenBezel,
  sideAngle,
  eyeHeight,
  trueFov,
  sideScale,
  screenAspectNow,
} from "../defs";
import { ScreensDiagram } from "../ScreensDiagram";
import {
  looksLikeTriple,
  physicalVerticalFovDeg,
  screenRig,
  totalHorizontalFovDeg,
  tripleViews,
} from "@/lib/display/screen-layout";
import { clampFov } from "@/lib/settings/player-settings";
import { PHONE_HUD_PARTS, layoutMoved, withLayoutParts } from "@/lib/settings/hud-parts";
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

/** The HUD's size, and where the layout in use puts its panels: the live layout editor moves and resizes them */
function HudPlacementCard() {
  const env = useSettingsEnv();
  const tx = useTranslations("settings.display.placement");
  // The layout chosen, and the Phone HUD a phone or the touch pads draw in its place
  const moved = layoutMoved(env.settings.hud.parts, env.settings.hud.preset) || layoutMoved(env.settings.hud.parts, PHONE_HUD_PARTS);
  return (
    <SettingsCard
      title={tx("title")}
      rows={[hudSize]}
      extraReset={{
        changed: moved,
        reset: () =>
          env.update((s) => ({
            ...s,
            hud: { ...s.hud, parts: withLayoutParts(withLayoutParts(s.hud.parts, s.hud.preset, {}), PHONE_HUD_PARTS, {}) },
          })),
      }}
      resetWhat={tx("resetWhat")}
    >
      {env.onEditHudLayout ? (
        <SettingRow label={tx("edit")} hint={tx("editHint")}>
          <Button size="sm" variant="secondary" onClick={env.onEditHudLayout}>
            {tx("editButton")}
          </Button>
        </SettingRow>
      ) : null}
    </SettingsCard>
  );
}

export function HudTab() {
  const tx = useTranslations("settings.display.hud");
  return (
    <>
      <HudLayoutCard />
      <HudPlacementCard />
      <SettingsCard title={tx("title")} rows={[deltaBar, lapSummary, mirror, radar, playerNames, preRaceShow, fullPodium, raceEventCards, boardWidget, engineeringTelemetry, ...hudAdvanced]} />
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

/** The window's size, kept current (the screens' shape comes from it) */
function useWindowShape(): { w: number; h: number } {
  const [shape, setShape] = useState(() =>
    typeof window === "undefined" ? { w: 1920, h: 1080 } : { w: window.innerWidth, h: window.innerHeight }
  );
  React.useEffect(() => {
    const read = () => setShape({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);
  return shape;
}

/**
 * One screen or three: the screens' size, distance, frames and angle (what the views are drawn from), a drawing of
 * them from above with the field of view they give, and the view settings that go with three screens
 */
export function ScreensTab() {
  const env = useSettingsEnv();
  const tx = useTranslations("settings.display.screens");
  const shape = useWindowShape();
  const screens = env.settings.screens;
  const triple = screens.mode === "triple";
  // Read after a resize too: one screen's shape is the window's, or a third of it
  void shape;
  const aspect = screenAspectNow(screens.mode);
  const rig = screenRig(screens, aspect);
  const trueFovDeg = physicalVerticalFovDeg(rig);
  const total = triple ? totalHorizontalFovDeg(tripleViews(rig, { x: 0, y: rig.eyeHeight, distance: rig.distance })) : null;
  const wide = looksLikeTriple(shape.w, shape.h);
  const notice = triple && !wide ? tx("notWide") : !triple && wide ? tx("looksTriple") : null;
  const fovNow = Math.round(env.settings.cockpitFovDeg ?? env.carFovDeg ?? 60);
  const fovTarget = Math.round(clampFov(trueFovDeg));
  const cm = (m: number) => (m * 100).toFixed(1);
  return (
    <>
      <SettingsCard
        title={tx("title")}
        rows={[screensMode, screenSize, screenDistance, screenBezel, sideAngle, eyeHeight]}
        first
        before={
          notice ? (
            <p role="status" className="rounded-lc-row border border-lc-caution/40 bg-lc-caution/10 px-3.5 py-2.5 text-[13px] leading-snug text-lc-chalk">
              {notice}
            </p>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-3 px-1 pt-1">
          <ScreensDiagram screens={screens} aspect={aspect} label={tx("diagramLabel")} />
          <ul className="flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-lc-slate tabular-nums">
            <li>{tx("picture", { width: cm(rig.w), height: cm(rig.h) })}</li>
            <li>{tx("trueFov", { degrees: trueFovDeg.toFixed(1) })}</li>
            {total !== null ? <li>{tx("total", { degrees: Math.round(total) })}</li> : null}
          </ul>
        </div>
        {!triple ? (
          <SettingRow label={tx("trueFov", { degrees: fovTarget })} hint={`${tx("useFovHint")} · ${tx("fovNow", { degrees: fovNow })}`}>
            <Button
              size="sm"
              variant="secondary"
              disabled={fovNow === fovTarget}
              onClick={() => env.update((s) => ({ ...s, cockpitFovDeg: fovTarget }))}
            >
              {tx("useFov", { degrees: fovTarget })}
            </Button>
          </SettingRow>
        ) : null}
      </SettingsCard>
      <SettingsCard title={tx("viewTitle")} rows={[trueFov, sideScale]} />
    </>
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
