"use client";

import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Button, SettingRow } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { useSettingsEnv } from "@/components/settings/env";
import { choice, lens, pct, pctOrOff, SettingsCard, slider, toggle, type RowDef } from "@/components/settings/fields";
import { dualSenseHid } from "@/lib/input/webhid-dualsense";
import { dualSenseAudioHaptics } from "@/lib/input/dualsense-audio-haptics";
import { isDualSensePadId, slopeZones, TRIGGER_OFF } from "@/lib/input/dualsense-protocol";
import type { DualSenseSettings } from "@/lib/settings/player-settings";
import { useGamepads } from "../useMenuNav";
import { StatusPill } from "./setup-ui";

/** A field of the DualSense settings */
const ds = <K extends keyof DualSenseSettings>(key: K) =>
  lens<DualSenseSettings[K]>(
    (s) => s.dualSense[key],
    (s, value) => ({ ...s, dualSense: { ...s.dualSense, [key]: value } }),
  );

/** Trigger stiffness: each sets the trigger strength the brake ramp and the throttle resistance scale with */
const TRIGGER_FEELS = [
  { id: "soft", strength: 0.35, label: "Soft", detail: "Light brake, throttle almost free" },
  { id: "medium", strength: 0.6, label: "Medium", detail: "Firm brake, light throttle" },
  { id: "hard", strength: 1, label: "Hard", detail: "Stiff brake, firmer throttle" },
] as const;

const needsTriggers = (on: boolean) => (on ? null : "Needs Adaptive triggers on");

const adaptiveTriggers = toggle({
  id: "dualSenseTriggers",
  label: "Adaptive triggers",
  hint: "L2 firms up like a brake pedal; ABS, lock-ups and wheelspin buzz in L2 and R2",
  ...ds("adaptiveTriggers"),
});

const triggerFeel: RowDef = choice("tiles", {
  id: "dualSenseTriggerFeel",
  label: "Trigger stiffness",
  options: TRIGGER_FEELS.map(({ id, label, detail }) => ({ id, label, detail })),
  read: (env) => TRIGGER_FEELS.find((f) => Math.abs(env.settings.dualSense.triggerStrength - f.strength) < 0.05)?.id ?? "custom",
  write: (env, id) => {
    const feel = TRIGGER_FEELS.find((f) => f.id === id);
    if (feel) env.update((s) => ({ ...s, dualSense: { ...s.dualSense, triggerStrength: feel.strength } }));
  },
  initial: () => "medium",
  off: (env) => needsTriggers(env.settings.dualSense.adaptiveTriggers),
});

const rumbleStrength = slider({
  id: "dualSenseRumble",
  label: "Rumble strength",
  min: 0.1,
  max: 1.5,
  step: 0.05,
  format: pct,
  ...ds("rumbleStrength"),
});

const hapticStrength = slider({
  id: "dualSenseHapticStrength",
  label: "Haptics strength",
  min: 0.1,
  max: 1.5,
  step: 0.05,
  format: pct,
  ...ds("hapticStrength"),
});

const engineHaptics = slider({
  id: "dualSenseEngine",
  label: "Engine vibration",
  min: 0,
  max: 1,
  step: 0.05,
  format: pctOrOff,
  ...ds("engineHaptics"),
});

const lightbar: RowDef = choice("segmented", {
  id: "dualSenseLightbar",
  label: "Lightbar",
  hint: "Revs: green to red, flashing blue at the shift point",
  options: [
    { id: "revs", label: "Revs" },
    { id: "driver", label: "Driver colour" },
    { id: "off", label: "Off" },
  ],
  ...ds("lightbar"),
});

const revLeds = toggle({
  id: "dualSenseRevLeds",
  label: "Rev lights",
  hint: "The five player LEDs fill up to the shift point; the mic LED shows the overtake boost",
  ...ds("revLeds"),
});

/** Brake resistance, then the ABS buzz, in L2; throttle resistance, then the wheelspin buzz, in R2 */
function testTriggers(strength: number) {
  const s = Math.max(0.3, strength);
  dualSenseHid.playTest([
    {
      ms: 1600,
      output: {
        leftTrigger: { mode: "zones", strengths: slopeZones(1, 7, 1 + 2 * s, 2 + 6 * s) },
        rightTrigger: { mode: "zones", strengths: slopeZones(3, 9, 1, 1 + 2 * s) },
      },
    },
    {
      ms: 1400,
      output: {
        leftTrigger: { mode: "vibration", position: 1, amplitude: Math.round(2 + 5 * s), frequencyHz: 20 },
        rightTrigger: { mode: "vibration", position: 1, amplitude: Math.round(2 + 5 * s), frequencyHz: 35 },
      },
    },
    { ms: 50, output: { leftTrigger: TRIGGER_OFF, rightTrigger: TRIGGER_OFF } },
  ]);
}

/** Left grip, then right, then both: through the HD haptics when they run, else the rumble emulation */
export function testDualSenseRumble(settings: DualSenseSettings) {
  if (dualSenseAudioHaptics.running()) {
    const amp = 0.6 * settings.hapticStrength;
    dualSenseAudioHaptics.pulse("left", 0.3, 70, amp);
    setTimeout(() => dualSenseAudioHaptics.pulse("right", 0.3, 70, amp), 450);
    setTimeout(() => dualSenseAudioHaptics.pulse("both", 0.25, 160, amp), 900);
    return;
  }
  const g = Math.max(0.3, settings.rumbleStrength);
  dualSenseHid.playTest([
    { ms: 350, output: { rumble: { low: Math.min(1, 0.8 * g), high: 0 } } },
    { ms: 350, output: { rumble: { low: 0, high: Math.min(1, 0.8 * g) } } },
    { ms: 50, output: { rumble: { low: 0, high: 0 } } },
  ]);
}

/**
 * The DualSense's own settings: pairing over WebHID, adaptive triggers, rumble or HD haptics, the lightbar and the rev
 * lights. Drawn once a DualSense is plugged in (or paired), in Settings > Controls > Controller and first-run setup.
 */
export function DualSenseCard() {
  const { settings } = useSettingsEnv();
  const d = settings.dualSense;
  const status = useSyncExternalStore(dualSenseHid.subscribe, dualSenseHid.getStatus, dualSenseHid.getStatus);
  const audio = useSyncExternalStore(dualSenseAudioHaptics.subscribe, dualSenseAudioHaptics.getStatus, dualSenseAudioHaptics.getStatus);
  const pads = useGamepads();
  // WebHID is read on the client only, so the first render matches the server's
  const [supported, setSupported] = useState(false);
  useEffect(() => setSupported(dualSenseHid.supported()), []);

  const connected = status.state === "connected";
  const seen = pads.some((p) => isDualSensePadId(p.id));
  if (!connected && !seen) return null;

  if (!supported) {
    return (
      <SettingsCard
        title="DualSense"
        description="Adaptive triggers, HD haptics and the lightbar need Chrome or Edge. Rumble still works here."
      />
    );
  }

  if (!connected) {
    return (
      <SettingsCard
        title="DualSense"
        description="Pair it for adaptive triggers, rumble sent straight to the pad, HD haptics over USB and rev lights. The browser keeps it paired until you unplug it or quit the browser."
      >
        <SettingRow label="Pair the controller" hint={status.message ?? "The browser lists it; pick it and press Connect"}>
          <Button size="sm" variant="primary" onClick={() => void dualSenseHid.connect()}>
            Connect DualSense
          </Button>
        </SettingRow>
      </SettingsCard>
    );
  }

  const usb = status.transport === "usb";
  const hd = d.hdHaptics && usb;
  const battery = status.battery ? `, ${Math.round(status.battery.level * 100)}%${status.battery.charging ? " charging" : ""}` : "";

  const hdHaptics = toggle({
    id: "dualSenseHaptics",
    label: "HD haptics",
    hint: usb
      ? "Kerbs, slides and the engine, felt on the side they happen. The browser asks once to list audio devices; nothing is recorded"
      : undefined,
    off: () => (usb ? null : "Needs the USB cable: over Bluetooth the pad uses rumble"),
    read: (env) => env.settings.dualSense.hdHaptics && usb,
    write: (env, on) => {
      const set = (v: boolean) => env.update((s) => ({ ...s, dualSense: { ...s.dualSense, hdHaptics: v } }));
      if (!on) {
        set(false);
        void dualSenseAudioHaptics.stop();
        return;
      }
      // From the click: the browser may ask once to list audio devices, and the audio starts on this gesture
      void dualSenseAudioHaptics.start(true).then((ok) => {
        if (ok) set(true);
      });
    },
    initial: () => false,
  });

  const rows: RowDef[] = [
    adaptiveTriggers,
    ...(d.adaptiveTriggers ? [triggerFeel] : []),
    hdHaptics,
    ...(hd ? [hapticStrength, engineHaptics] : [rumbleStrength]),
    lightbar,
    revLeds,
  ];

  return (
    <SettingsCard
      title="DualSense"
      rows={rows}
      before={
        <span className="flex items-center gap-2 pb-1">
          <Badge tone="good" dot>
            Connected
          </Badge>
          <span className="lc-body truncate">
            {status.name ?? "DualSense"}, {usb ? "USB" : "Bluetooth"}
            {battery}
          </span>
        </span>
      }
    >
      {audio.state === "error" && audio.message ? <StatusPill tone="info">{audio.message}</StatusPill> : null}
      {d.adaptiveTriggers ? (
        <SettingRow label="Test triggers" hint="L2 and R2 stiffen, then buzz">
          <Button size="sm" variant="secondary" onClick={() => testTriggers(d.triggerStrength)}>
            Test
          </Button>
        </SettingRow>
      ) : null}
      <SettingRow label={hd ? "Test haptics" : "Test rumble"} hint="Left grip, then right, then both">
        <Button size="sm" variant="secondary" onClick={() => testDualSenseRumble(d)}>
          Test
        </Button>
      </SettingRow>
    </SettingsCard>
  );
}
