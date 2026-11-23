"use client";

import React, { useMemo, useState } from "react";
import { useTranslations } from "use-intl/react";
import {
  freePedalButtons,
  matchPadLayout,
  matchPedalSet,
  PAD_ACTIONS,
  PAD_BRAKE_BUTTON,
  PAD_LAYOUT_IDS,
  PAD_LAYOUTS,
  PAD_THROTTLE_BUTTON,
  padButtonLabel,
  pedalOnButton,
  pedalSourceText,
  pedalStickClicks,
  rebindPadButton,
  withPedalSet,
  type PadAction,
  type PadLayout,
  type PadPedalSet,
} from "@/lib/input/bindings";
import { connectedPads, PAD_SENSITIVITY, padDisplayName, padPedals, type PadSensitivity } from "@/lib/input/device-input";
import { Button, SettingRow } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import type { PadButtonName } from "@/components/ui/prompts";
import { useSettingsEnv } from "@/components/settings/env";
import { choice, SettingsCard, type RowDef } from "@/components/settings/fields";
import { controllerFineTuning, triggerRumble, triggerSlip, vibration } from "@/components/settings/defs";
import { DEFAULT_PLAYER_SETTINGS, type DualSenseSettings } from "@/lib/settings/player-settings";
import { dualSenseHid } from "@/lib/input/webhid-dualsense";
import { useGamepads } from "../useMenuNav";
import { CAPTURE_TIMEOUT_S, useButtonCapture } from "./button-capture";
import { padButtonName, padFamilyOf, useInputMode } from "../input-mode";
import { PedalCurveBars, StickCurve } from "./TuningSlider";
import { PadMap } from "./PadMap";
import { Hint, StatusPill, TrackMeter } from "./setup-ui";
import { DualSenseCard, testDualSenseRumble } from "./DualSenseCard";
import { GyroSteeringCard, useGyroLive } from "./GyroSteeringCard";
import { combineStickAndGyro } from "@/lib/input/gyro-steer";
import { gyroSource, isGyroPadId } from "@/lib/input/gyro-source";

/** Standard-mapping buttons 0..11 as the glyphs name them */
const GLYPH: readonly PadButtonName[] = ["a", "b", "x", "y", "lb", "rb", "lt", "rt", "view", "menu", "l3", "r3"];

type VibratingPad = Gamepad & {
  vibrationActuator?: { playEffect?: (type: string, params: Record<string, number>) => Promise<unknown> } | null;
};

/** A short buzz through every pad; a paired DualSense plays its own test (left grip, right, both) */
function testRumble(dualSense: DualSenseSettings) {
  if (dualSenseHid.connected()) testDualSenseRumble(dualSense);
  for (const pad of connectedPads() as VibratingPad[]) {
    if (dualSenseHid.ownsPad(pad.id)) continue;
    try {
      void pad.vibrationActuator
        ?.playEffect?.("dual-rumble", { startDelay: 0, duration: 450, weakMagnitude: 0.6, strongMagnitude: 0.9 })
        ?.catch(() => {});
    } catch {
      // No rumble on this pad
    }
  }
}

/** The controller in use, live: the stick and the pedals (triggers or right stick) as the game reads them */
export function InputCheckCard() {
  const { settings } = useSettingsEnv();
  const tx = useTranslations("setup.inputCheck");
  const pads = useGamepads();
  const pad = pads.find((p) => p.mapping === "standard") ?? null;
  const pedals = pad ? padPedals(pad, settings.padTuning) : null;
  // With gyro steering on, the steer bar is the stick and the tilt together, as the car gets them
  const d = settings.dualSense;
  const gyro = useGyroLive(Boolean(pad && isGyroPadId(pad.id)) && d.gyroSteer && gyroSource.connected(), d.gyroLockDeg, d.gyroSensitivity, pad?.id);
  const steer = combineStickAndGyro(pad?.axes[0] ?? 0, gyro?.steer);
  return (
    <SettingsCard title={tx("title")} description={pad ? undefined : tx("noController")}>
      {pad ? (
        <div className="flex flex-col gap-3 py-1">
          <span className="flex items-center gap-2">
            <Badge tone="good" dot>
              {tx("connected")}
            </Badge>
            <span className="lc-body truncate" title={padDisplayName(pad.id)}>{padDisplayName(pad.id)}</span>
          </span>
          <TrackMeter label={tx("steer")} value={steer} color="var(--color-lc-info)" centered />
          <TrackMeter label={tx("throttle")} value={pedals?.throttle ?? 0} color="var(--lc-sem-throttle)" />
          <TrackMeter label={tx("brake")} value={pedals?.brake ?? 0} color="var(--lc-sem-brake)" />
          {settings.padTuning.pedalSources.clutch ? (
            <TrackMeter label={tx("clutch")} value={pedals?.clutch ?? 0} color="var(--color-lc-azure)" />
          ) : null}
        </div>
      ) : null}
    </SettingsCard>
  );
}

const steeringFeel = (label: string): RowDef => choice("tiles", {
  id: "padSensitivity",
  label,
  // Read when drawn, so the feels' names are in the current language
  options: () =>
    (Object.keys(PAD_SENSITIVITY) as PadSensitivity[]).map((id) => ({
      id,
      label: PAD_SENSITIVITY[id].label,
      detail: PAD_SENSITIVITY[id].detail,
    })),
  read: (env) => env.settings.padSensitivity,
  // A feel sets the steering speed and dead zone it stands for
  write: (env, id) => {
    const feel = PAD_SENSITIVITY[id as PadSensitivity];
    env.update((s) => ({
      ...s,
      padSensitivity: id as PadSensitivity,
      padTuning: { ...s.padTuning, steeringRate: feel.steeringRate, deadzone: feel.deadzone },
    }));
  },
  initial: () => DEFAULT_PLAYER_SETTINGS.padSensitivity,
});

export function SteeringFeelCard({ first }: { first?: boolean }) {
  const { settings } = useSettingsEnv();
  const tx = useTranslations("setup.steeringFeel");
  const feel = useMemo(() => steeringFeel(tx("feel")), [tx]);
  return (
    <SettingsCard title={tx("title")} rows={[feel, vibration]} first={first}>
      <SettingRow label={tx("testVibration")} hint={tx("testVibrationHint")}>
        <Button size="sm" variant="secondary" onClick={() => testRumble(settings.dualSense)}>
          {tx("test")}
        </Button>
      </SettingRow>
    </SettingsCard>
  );
}

/** Button layout and the action on every button: press a slot, then the controller button */
export function ControllerButtonsCard() {
  const { settings, update } = useSettingsEnv();
  const tx = useTranslations("setup.padButtons");
  const pads = useGamepads();
  const { family } = useInputMode();
  const pad = pads.find((p) => p.mapping === "standard") ?? null;
  const shownFamily = pad ? padFamilyOf(pad.id) : family;
  /** The action, or the clutch pedal, waiting for a button */
  const [capturing, setCapturing] = useState<PadAction | "clutch" | null>(null);
  /** A pedal's button pressed while capturing: it stays that pedal, and the capture keeps listening */
  const [refused, setRefused] = useState<number | null>(null);
  const [showMap, setShowMap] = useState(false);
  const sources = settings.padTuning.pedalSources;
  const pedalSet = matchPedalSet(sources);

  const capture = React.useCallback((action: PadAction | "clutch" | null) => {
    setRefused(null);
    setCapturing(action);
  }, []);
  const onButton = React.useCallback(
    (button: number) => {
      if (!capturing) return;
      const pedal = pedalOnButton(sources, button);
      if (capturing === "clutch") {
        // The clutch takes any button but the throttle's and the brake's; an action on it lets go of it
        if (pedal === "throttle" || pedal === "brake") {
          setRefused(button);
          return;
        }
        update((s) => {
          const pedalSources = { ...s.padTuning.pedalSources, clutch: { kind: "button" as const, button } };
          return { ...s, padButtons: freePedalButtons(s.padButtons, pedalSources), padTuning: { ...s.padTuning, pedalSources } };
        });
        capture(null);
        return;
      }
      if (pedal !== null) {
        setRefused(button);
        return;
      }
      update((s) => ({ ...s, padButtons: rebindPadButton(s.padButtons, capturing, button) }));
      capture(null);
    },
    [capturing, sources, update, capture],
  );
  const refusedPedal = refused === null ? null : pedalOnButton(sources, refused);
  const onCancel = React.useCallback(() => capture(null), [capture]);
  useButtonCapture(capturing, (b) => onButton(b.button), onCancel, { standardOnly: true });

  const name = (button: number | null) => padButtonName(button, shownFamily);
  // Gears with no button (the pedals moved back onto the triggers they shifted on, say): the manual box can't shift
  const noGearUp = settings.padButtons.shiftUp === null;
  const noGearDown = settings.padButtons.shiftDown === null;
  const gearHint =
    noGearUp && noGearDown ? tx("noGears") : noGearUp ? tx("noGearUp") : noGearDown ? tx("noGearDown") : undefined;
  const layout: RowDef = choice("tiles", {
    id: "padLayout",
    label: tx("layout"),
    columns: 3,
    hint: () =>
      gearHint ??
      (matchPadLayout(settings.padButtons, sources) === null ? tx("customLayout") : undefined),
    options: PAD_LAYOUT_IDS.map((id) => {
      const { buttons: b, pedals: p } = PAD_LAYOUTS[id];
      const gears = { up: name(b.shiftUp), down: name(b.shiftDown) };
      return {
        id,
        label: PAD_LAYOUTS[id].label,
        detail: p === "stick" ? tx("layoutStickPedals", gears) : tx("layoutTriggerPedals", { ...gears, boost: name(b.boost) }),
      };
    }),
    read: (env) => matchPadLayout(env.settings.padButtons, env.settings.padTuning.pedalSources) ?? "custom",
    write: (env, id) => {
      const picked = PAD_LAYOUTS[id as PadLayout];
      env.update((s) => {
        const pedalSources = withPedalSet(s.padTuning.pedalSources, picked.pedals);
        // Another pedal on a button the layout uses (a clutch) keeps it: the action there lets go
        return { ...s, padButtons: freePedalButtons({ ...picked.buttons }, pedalSources), padTuning: { ...s.padTuning, pedalSources } };
      });
    },
    initial: () => "gt",
  });
  // A pedal stick's click is under the pedal thumb: say what it still does there
  const clickHint = pedalStickClicks(sources)
    .map((click) => {
      const action = PAD_ACTIONS.find((a) => settings.padButtons[a.id] === click)?.label;
      return action ? tx("stickClick", { button: name(click), action }) : null;
    })
    .find((h) => h !== null);
  const pedalRow: RowDef = choice("tiles", {
    id: "padPedals",
    label: tx("pedals"),
    columns: 2,
    hint: () => clickHint ?? undefined,
    options: [
      { id: "triggers", label: tx("triggers"), detail: tx("triggersDetail", { throttle: name(PAD_THROTTLE_BUTTON), brake: name(PAD_BRAKE_BUTTON) }) },
      { id: "stick", label: tx("rightStick"), detail: tx("rightStickDetail", { throttle: name(PAD_THROTTLE_BUTTON), brake: name(PAD_BRAKE_BUTTON) }) },
    ],
    read: (env) => matchPedalSet(env.settings.padTuning.pedalSources) ?? "custom",
    // Back on the triggers, whatever was bound to them lets go: RT would shift up every time it was pressed
    write: (env, id) =>
      env.update((s) => {
        const pedalSources = withPedalSet(s.padTuning.pedalSources, id as PadPedalSet);
        return { ...s, padButtons: freePedalButtons(s.padButtons, pedalSources), padTuning: { ...s.padTuning, pedalSources } };
      }),
    initial: () => matchPedalSet(DEFAULT_PLAYER_SETTINGS.padTuning.pedalSources) ?? "triggers",
  });

  return (
    <SettingsCard
      title={tx("title")}
      description={
        pedalSet === "stick"
          ? tx("descriptionStick")
          : pedalSet === "triggers"
            ? tx("descriptionTriggers")
            : tx("descriptionCustom")
      }
      rows={[layout, pedalRow]}
    >
      <div className="grid gap-x-8 gap-y-1 xl:grid-cols-2">
      {PAD_ACTIONS.map(({ id, label }) => {
        const listening = capturing === id;
        const button = settings.padButtons[id];
        const bound = button !== null && button !== undefined;
        return (
          <SettingRow key={id} label={label} className={listening ? "bg-lc-volt/6" : undefined}>
            <Button
              size="sm"
              variant={listening ? "primary" : "secondary"}
              className="min-w-28"
              aria-label={
                listening
                  ? tx("pressFor", { action: label })
                  : bound
                    ? tx("boundAria", { action: label, button: name(button) })
                    : tx("unboundAria", { action: label })
              }
              onClick={() => capture(listening ? null : id)}
            >
              {listening ? tx("pressButton") : bound ? (button < GLYPH.length ? name(button) : padButtonLabel(button)) : tx("add")}
            </Button>
          </SettingRow>
        );
      })}
      </div>
      <SettingRow
        label={tx("clutch")}
        hint={sources.clutch ? tx("clutchHintSet") : tx("clutchHintUnset")}
        className={capturing === "clutch" ? "bg-lc-volt/6" : undefined}
      >
        <Button
          size="sm"
          variant={capturing === "clutch" ? "primary" : "secondary"}
          className="min-w-28"
          aria-label={
            capturing === "clutch"
              ? tx("pressForClutch")
              : sources.clutch
                ? tx("clutchAria", { source: pedalSourceText(sources.clutch) })
                : tx("clutchUnsetAria")
          }
          onClick={() => capture(capturing === "clutch" ? null : "clutch")}
        >
          {capturing === "clutch"
            ? tx("pressButton")
            : sources.clutch
              ? sources.clutch.kind === "button"
                ? name(sources.clutch.button)
                : pedalSourceText(sources.clutch)
              : tx("add")}
        </Button>
        {sources.clutch && capturing !== "clutch" ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update((s) => ({ ...s, padTuning: { ...s.padTuning, pedalSources: { ...s.padTuning.pedalSources, clutch: null } } }))}
          >
            {tx("remove")}
          </Button>
        ) : null}
      </SettingRow>
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        {capturing && refused !== null && refusedPedal ? (
          <StatusPill tone="live">
            {tx(pedalSet === "triggers" ? "refusedTriggers" : "refused", { button: name(refused), pedal: refusedPedal })}
          </StatusPill>
        ) : capturing ? (
          <StatusPill tone="live">{tx("capturing", { seconds: CAPTURE_TIMEOUT_S })}</StatusPill>
        ) : (
          <Hint>{tx("hint")}</Hint>
        )}
        <Button size="sm" variant="ghost" onClick={() => setShowMap((v) => !v)} aria-expanded={showMap}>
          {showMap ? tx("hideMap") : tx("buttonMap")}
        </Button>
      </div>
      {showMap ? (
        <div className="rounded-lc-row border border-lc-line bg-lc-well p-3">
          <PadMap family={shownFamily} bindings={settings.padButtons} pedalSources={sources} pad={pad} />
        </div>
      ) : null}
    </SettingsCard>
  );
}

/** Dead zones, curves and trigger rumble, with the live stick and trigger curves beside them (advanced) */
export function ControllerFineTuningCard() {
  const { settings } = useSettingsEnv();
  const tx = useTranslations("setup.fineTuning");
  const t = settings.padTuning;
  return (
    <SettingsCard title={tx("title")} rows={[...controllerFineTuning, triggerRumble, triggerSlip]}>
      <div className="grid gap-3 pt-2 sm:grid-cols-2">
        <StickCurve deadzone={t.deadzone} outerDeadzone={t.outerDeadzone} linearity={t.linearity} />
        <PedalCurveBars tuning={t} throttleGamma={t.throttleGamma} brakeGamma={t.brakeGamma} />
      </div>
    </SettingsCard>
  );
}

/** Settings > Controls > Controller, and the controller step of first-run setup */
export function ControllerSetup() {
  return (
    <>
      <SteeringFeelCard first />
      <InputCheckCard />
      <DualSenseCard />
      <GyroSteeringCard />
      <ControllerButtonsCard />
      <ControllerFineTuningCard />
    </>
  );
}

export const ControllerStep: React.FC = () => (
  <div className="flex flex-col gap-3">
    <ControllerSetup />
  </div>
);
