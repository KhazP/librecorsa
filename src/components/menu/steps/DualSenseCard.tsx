"use client";

import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl/react";
import { Button, SettingRow } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { useSettingsEnv } from "@/components/settings/env";
import { choice, lens, pct, pctOrOff, SettingsCard, slider, toggle, type RowDef } from "@/components/settings/fields";
import { needsTriggerPedals } from "@/components/settings/defs";
import { pedalsOnTriggers } from "@/lib/input/bindings";
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
  { id: "soft", strength: 0.35 },
  { id: "medium", strength: 0.6 },
  { id: "hard", strength: 1 },
] as const;

/** The card's own rows, named in the current language */
function useDualSenseRows() {
  const tx = useTranslations("setup.dualSense");
  return useMemo(() => {
    const needsTriggers = (on: boolean) => (on ? null : tx("needsAdaptiveTriggers"));

    const adaptiveTriggers = toggle({
      id: "dualSenseTriggers",
      label: tx("adaptiveTriggers"),
      hint: tx("adaptiveTriggersHint"),
      // With stick pedals L2 / R2 shift gears: they stay free
      off: needsTriggerPedals,
      ...ds("adaptiveTriggers"),
    });

    const triggerFeel: RowDef = choice("tiles", {
      id: "dualSenseTriggerFeel",
      label: tx("triggerStiffness"),
      options: TRIGGER_FEELS.map(({ id }) => ({ id, label: tx(`feel.${id}`), detail: tx(`feelDetail.${id}`) })),
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
      label: tx("rumbleStrength"),
      min: 0.1,
      max: 1.5,
      step: 0.05,
      format: pct,
      ...ds("rumbleStrength"),
    });

    const hapticStrength = slider({
      id: "dualSenseHapticStrength",
      label: tx("hapticStrength"),
      min: 0.1,
      max: 1.5,
      step: 0.05,
      format: pct,
      ...ds("hapticStrength"),
    });

    const engineHaptics = slider({
      id: "dualSenseEngine",
      label: tx("engineVibration"),
      min: 0,
      max: 1,
      step: 0.05,
      format: pctOrOff,
      ...ds("engineHaptics"),
    });

    const lightbar: RowDef = choice("segmented", {
      id: "dualSenseLightbar",
      label: tx("lightbar"),
      hint: tx("lightbarHint"),
      options: [
        { id: "revs", label: tx("lightbarRevs") },
        { id: "driver", label: tx("lightbarDriver") },
        { id: "off", label: tx("lightbarOff") },
      ],
      ...ds("lightbar"),
    });

    const revLeds = toggle({
      id: "dualSenseRevLeds",
      label: tx("revLights"),
      hint: tx("revLightsHint"),
      ...ds("revLeds"),
    });

    return { adaptiveTriggers, triggerFeel, rumbleStrength, hapticStrength, engineHaptics, lightbar, revLeds };
  }, [tx]);
}

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
    { ms: 400, output: { rumble: { low: Math.min(1, 0.8 * g), high: Math.min(1, 0.8 * g) } } },
    { ms: 50, output: { rumble: { low: 0, high: 0 } } },
  ]);
}

/**
 * The DualSense's own settings: pairing over WebHID, adaptive triggers, rumble or HD haptics, the lightbar and the rev
 * lights. Drawn once a DualSense is plugged in (or paired), in Settings > Controls > Controller and first-run setup.
 */
export function DualSenseCard() {
  const { settings } = useSettingsEnv();
  const tx = useTranslations("setup.dualSense");
  const { adaptiveTriggers, triggerFeel, rumbleStrength, hapticStrength, engineHaptics, lightbar, revLeds } = useDualSenseRows();
  const d = settings.dualSense;
  /** The triggers firm up and buzz: switched on, and the pedals are on them */
  const triggerFeedback = d.adaptiveTriggers && pedalsOnTriggers(settings.padTuning.pedalSources);
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
      <SettingsCard title="DualSense" description={tx("needsChrome")} />
    );
  }

  if (!connected) {
    return (
      <SettingsCard title="DualSense" description={tx("description")}>
        <SettingRow label={tx("pair")} hint={status.message ?? undefined}>
          <Button size="sm" variant="primary" onClick={() => void dualSenseHid.connect()}>
            {tx("connect")}
          </Button>
        </SettingRow>
      </SettingsCard>
    );
  }

  const usb = status.transport === "usb";
  const hd = d.hdHaptics && usb;
  const padName = status.name ?? "DualSense";
  const transport = usb ? "USB" : "Bluetooth";
  const padLine = status.battery
    ? tx(status.battery.charging ? "padLineCharging" : "padLineBattery", {
        name: padName,
        transport,
        battery: Math.round(status.battery.level * 100),
      })
    : tx("padLine", { name: padName, transport });

  const hdHaptics = toggle({
    id: "dualSenseHaptics",
    label: tx("hdHaptics"),
    hint: usb ? tx("hdHapticsHint") : undefined,
    off: () => (usb ? null : tx("needsUsb")),
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
    ...(triggerFeedback ? [triggerFeel] : []),
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
            {tx("connected")}
          </Badge>
          <span className="lc-body truncate" title={padLine}>
            {padLine}
          </span>
        </span>
      }
    >
      {audio.state === "error" && audio.message ? <StatusPill tone="info">{audio.message}</StatusPill> : null}
      {triggerFeedback ? (
        <SettingRow label={tx("testTriggers")} hint={tx("testTriggersHint")}>
          <Button size="sm" variant="secondary" onClick={() => testTriggers(d.triggerStrength)}>
            {tx("test")}
          </Button>
        </SettingRow>
      ) : null}
      <SettingRow label={hd ? tx("testHaptics") : tx("testRumble")} hint={tx("testGripsHint")}>
        <Button size="sm" variant="secondary" onClick={() => testDualSenseRumble(d)}>
          {tx("test")}
        </Button>
      </SettingRow>
    </SettingsCard>
  );
}
