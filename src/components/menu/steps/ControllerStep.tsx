"use client";

import React, { useState } from "react";
import {
  matchPadLayout,
  PAD_ACTIONS,
  PAD_BRAKE_BUTTON,
  PAD_LAYOUT_IDS,
  PAD_LAYOUTS,
  PAD_THROTTLE_BUTTON,
  padButtonLabel,
  rebindPadButton,
  type PadAction,
} from "@/lib/input/bindings";
import { connectedPads, PAD_SENSITIVITY, padDisplayName, type PadSensitivity } from "@/lib/input/device-input";
import { Button, SettingRow } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import type { PadButtonName } from "@/components/ui/prompts";
import { useSettingsEnv } from "@/components/settings/env";
import { choice, SettingsCard, type RowDef } from "@/components/settings/fields";
import { controllerFineTuning, triggerRumble, triggerSlip, vibration } from "@/components/settings/defs";
import { DEFAULT_PLAYER_SETTINGS } from "@/lib/settings/player-settings";
import { useGamepads } from "../useMenuNav";
import { CAPTURE_TIMEOUT_S, useButtonCapture } from "./button-capture";
import { padButtonName, padFamilyOf, useInputMode } from "../input-mode";
import { StickCurve, TriggerBars } from "./TuningSlider";
import { PadMap } from "./PadMap";
import { Hint, StatusPill, TrackMeter } from "./setup-ui";

/** Standard-mapping buttons 0..11 as the glyphs name them */
const GLYPH: readonly PadButtonName[] = ["a", "b", "x", "y", "lb", "rb", "lt", "rt", "view", "menu", "l3", "r3"];

type VibratingPad = Gamepad & {
  vibrationActuator?: { playEffect?: (type: string, params: Record<string, number>) => Promise<unknown> } | null;
};

function testRumble() {
  for (const pad of connectedPads() as VibratingPad[]) {
    try {
      void pad.vibrationActuator
        ?.playEffect?.("dual-rumble", { startDelay: 0, duration: 450, weakMagnitude: 0.6, strongMagnitude: 0.9 })
        ?.catch(() => {});
    } catch {
      // No rumble on this pad
    }
  }
}

/** The controller in use, live: the stick and the triggers as the game reads them */
export function InputCheckCard() {
  const pads = useGamepads();
  const pad = pads.find((p) => p.mapping === "standard") ?? null;
  return (
    <SettingsCard
      title="Input check"
      description={pad ? undefined : "No controller found. Connect it and press any button"}
    >
      {pad ? (
        <div className="flex flex-col gap-3 py-1">
          <span className="flex items-center gap-2">
            <Badge tone="good" dot>
              Connected
            </Badge>
            <span className="lc-body truncate">{padDisplayName(pad.id)}</span>
          </span>
          <TrackMeter label="Steer" value={pad.axes[0] ?? 0} color="var(--color-lc-info)" centered />
          <TrackMeter label="Throttle" value={pad.buttons[PAD_THROTTLE_BUTTON]?.value ?? 0} color="var(--lc-sem-throttle)" />
          <TrackMeter label="Brake" value={pad.buttons[PAD_BRAKE_BUTTON]?.value ?? 0} color="var(--lc-sem-brake)" />
        </div>
      ) : null}
    </SettingsCard>
  );
}

const steeringFeel: RowDef = choice("tiles", {
  id: "padSensitivity",
  label: "Steering feel",
  options: (Object.keys(PAD_SENSITIVITY) as PadSensitivity[]).map((id) => ({
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
  return (
    <SettingsCard title="Feel and vibration" rows={[steeringFeel, vibration]} first={first}>
      <SettingRow label="Test vibration" hint="A short buzz through every connected controller">
        <Button size="sm" variant="secondary" onClick={testRumble}>
          Test
        </Button>
      </SettingRow>
    </SettingsCard>
  );
}

/** Button layout and the action on every button: press a slot, then the controller button */
export function ControllerButtonsCard() {
  const { settings, update } = useSettingsEnv();
  const pads = useGamepads();
  const { family } = useInputMode();
  const pad = pads.find((p) => p.mapping === "standard") ?? null;
  const shownFamily = pad ? padFamilyOf(pad.id) : family;
  const [capturing, setCapturing] = useState<PadAction | null>(null);
  const [showMap, setShowMap] = useState(false);

  const onButton = React.useCallback(
    (button: number) => {
      if (!capturing) return;
      update((s) => ({ ...s, padButtons: rebindPadButton(s.padButtons, capturing, button) }));
      setCapturing(null);
    },
    [capturing, update],
  );
  const onCancel = React.useCallback(() => setCapturing(null), []);
  useButtonCapture(capturing, (b) => onButton(b.button), onCancel, { standardOnly: true });

  const name = (button: number | null) => padButtonName(button, shownFamily);
  const layout: RowDef = choice("tiles", {
    id: "padLayout",
    label: "Button layout",
    columns: 4,
    hint: () => (matchPadLayout(settings.padButtons) === null ? "My own layout: press a layout to start from it" : undefined),
    options: PAD_LAYOUT_IDS.map((id) => {
      const b = PAD_LAYOUTS[id].buttons;
      return { id, label: PAD_LAYOUTS[id].label, detail: `${name(b.shiftUp)} / ${name(b.shiftDown)} gears, ${name(b.boost)} boost` };
    }),
    read: (env) => matchPadLayout(env.settings.padButtons) ?? "custom",
    write: (env, id) => env.update((s) => ({ ...s, padButtons: { ...PAD_LAYOUTS[id as keyof typeof PAD_LAYOUTS].buttons } })),
    initial: () => "default",
  });

  return (
    <SettingsCard
      title="Buttons"
      description="Right trigger throttle, left trigger brake, left stick steers"
      rows={[layout]}
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
              aria-label={listening ? `Press a button for ${label}` : `${label}: ${bound ? name(button) : "not set"}. Change`}
              onClick={() => setCapturing(listening ? null : id)}
            >
              {listening ? "Press a button" : bound ? (button < GLYPH.length ? name(button) : padButtonLabel(button)) : "Add"}
            </Button>
          </SettingRow>
        );
      })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        {capturing ? (
          <StatusPill tone="live">Press a controller button. Esc cancels; it stops after {CAPTURE_TIMEOUT_S} s</StatusPill>
        ) : (
          <Hint>Press a slot, then the button you want.</Hint>
        )}
        <Button size="sm" variant="ghost" onClick={() => setShowMap((v) => !v)} aria-expanded={showMap}>
          {showMap ? "Hide map" : "Button map"}
        </Button>
      </div>
      {showMap ? (
        <div className="rounded-lc-row border border-lc-line bg-lc-well p-3">
          <PadMap family={shownFamily} bindings={settings.padButtons} pad={pad} />
        </div>
      ) : null}
    </SettingsCard>
  );
}

/** Dead zones, curves and trigger rumble, with the live stick and trigger curves beside them (advanced) */
export function ControllerFineTuningCard() {
  const { settings } = useSettingsEnv();
  const t = settings.padTuning;
  return (
    <SettingsCard title="Fine tuning" rows={[...controllerFineTuning, triggerRumble, triggerSlip]}>
      <div className="grid gap-3 pt-2 sm:grid-cols-2">
        <StickCurve deadzone={t.deadzone} outerDeadzone={t.outerDeadzone} linearity={t.linearity} />
        <TriggerBars throttleGamma={t.throttleGamma} brakeGamma={t.brakeGamma} />
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
