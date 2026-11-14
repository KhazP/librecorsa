"use client";

import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Choice, PanelSection, Toggle } from "@/components/hud/PauseMenu";
import { dualSenseHid } from "@/lib/input/webhid-dualsense";
import { dualSenseAudioHaptics } from "@/lib/input/dualsense-audio-haptics";
import { isDualSensePadId, slopeZones, TRIGGER_OFF } from "@/lib/input/dualsense-protocol";
import type { DualSenseLightbar, DualSenseSettings } from "@/lib/settings/player-settings";
import { useGamepads } from "../useMenuNav";
import { TuningSlider } from "./TuningSlider";
import { AutoGrid, ChoiceText, Hint, PillAction, SetupCard, StatusPill } from "./setup-ui";

const LIGHTBAR_CHOICES: { id: DualSenseLightbar; title: string; detail: string }[] = [
  { id: "revs", title: "Revs", detail: "Green to red, blue at the shift" },
  { id: "driver", title: "Driver colour", detail: "Your profile colour" },
  { id: "off", title: "Off", detail: "Lightbar dark" },
];

/** Trigger stiffness: each sets the trigger strength the brake ramp and the throttle resistance scale with */
const TRIGGER_FEELS: { strength: number; title: string; detail: string }[] = [
  { strength: 0.35, title: "Soft", detail: "Light brake, throttle almost free" },
  { strength: 0.6, title: "Medium", detail: "Firm brake, light throttle" },
  { strength: 1, title: "Hard", detail: "Stiff brake, firmer throttle" },
];

const pct = (v: number) => `${Math.round(v * 100)} %`;

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
 * lights. Shown once a DualSense is plugged in (or paired); `variant` picks the setup screen's card or the pause menu's.
 */
export const DualSenseCard: React.FC<{
  settings: DualSenseSettings;
  onChange: (patch: Partial<DualSenseSettings>) => void;
  variant?: "setup" | "pause";
}> = ({ settings, onChange, variant = "setup" }) => {
  const status = useSyncExternalStore(dualSenseHid.subscribe, dualSenseHid.getStatus, dualSenseHid.getStatus);
  const audio = useSyncExternalStore(dualSenseAudioHaptics.subscribe, dualSenseAudioHaptics.getStatus, dualSenseAudioHaptics.getStatus);
  const pads = useGamepads();
  // WebHID is read on the client only, so the first render matches the server's
  const [supported, setSupported] = useState(false);
  useEffect(() => setSupported(dualSenseHid.supported()), []);

  const connected = status.state === "connected";
  const seen = pads.some((p) => isDualSensePadId(p.id));
  if (!connected && !seen) return null;

  const usb = status.transport === "usb";
  const name = status.name ?? "DualSense";
  const battery = status.battery ? ` · ${Math.round(status.battery.level * 100)} %${status.battery.charging ? " charging" : ""}` : "";
  const statusText = connected ? `${name} · ${usb ? "USB" : "Bluetooth"}${battery}` : null;

  const connect = (
    <PillAction onClick={() => void dualSenseHid.connect()} className="h-[34px]! border-[#CCFF00]! text-[#CCFF00]!">
      Connect DualSense
    </PillAction>
  );

  const toggleHaptics = () => {
    if (settings.hdHaptics) {
      onChange({ hdHaptics: false });
      void dualSenseAudioHaptics.stop();
      return;
    }
    // From the click: the browser may ask once to list audio devices, and the audio starts on this gesture
    void dualSenseAudioHaptics.start(true).then((ok) => {
      if (ok) onChange({ hdHaptics: true });
    });
  };

  const body = !supported ? (
    <Hint>Adaptive triggers, HD haptics and the lightbar need Chrome or Edge. Rumble still works here.</Hint>
  ) : !connected ? (
    <div className="flex flex-col gap-2.5">
      <Hint>
        Pair it once for adaptive triggers, rumble sent straight to the pad, HD haptics over USB and rev lights on the
        LEDs. The browser keeps it paired until you unplug it or quit the browser.
      </Hint>
      {status.message ? <StatusPill tone="info">{status.message}</StatusPill> : null}
      <div>{connect}</div>
    </div>
  ) : (
    <div className="flex flex-col gap-2">
      <AutoGrid min={280} className="gap-x-5 gap-y-0.5">
        <Toggle
          label="Adaptive triggers"
          detail="L2 firms up like a brake pedal; ABS, lock-ups and wheelspin buzz in L2 / R2"
          checked={settings.adaptiveTriggers}
          onChange={() => onChange({ adaptiveTriggers: !settings.adaptiveTriggers })}
        />
        <Toggle
          label="HD haptics"
          detail={
            usb
              ? "Kerbs, slides and the engine, felt on the side they happen. The browser asks once to list audio devices; nothing is recorded"
              : "Needs the USB cable: over Bluetooth the pad uses rumble"
          }
          checked={settings.hdHaptics && usb}
          disabled={!usb || audio.state === "starting"}
          onChange={toggleHaptics}
        />
      </AutoGrid>
      <AutoGrid min={200} className="gap-x-5 gap-y-1">
        {settings.hdHaptics && usb ? (
          <>
            <TuningSlider
              label="Haptics strength"
              value={settings.hapticStrength}
              min={0.1}
              max={1.5}
              step={0.05}
              format={pct}
              onChange={(v) => onChange({ hapticStrength: v })}
            />
            <TuningSlider
              label="Engine vibration"
              value={settings.engineHaptics}
              min={0}
              max={1}
              step={0.05}
              format={(v) => (v === 0 ? "Off" : pct(v))}
              onChange={(v) => onChange({ engineHaptics: v })}
            />
          </>
        ) : (
          <TuningSlider
            label="Rumble strength"
            value={settings.rumbleStrength}
            min={0.1}
            max={1.5}
            step={0.05}
            format={pct}
            onChange={(v) => onChange({ rumbleStrength: v })}
          />
        )}
      </AutoGrid>
      {audio.state === "error" && audio.message ? <StatusPill tone="info">{audio.message}</StatusPill> : null}
      {settings.adaptiveTriggers ? (
        <div className="grid grid-cols-3 gap-2">
          {TRIGGER_FEELS.map((f) => (
            <Choice
              key={f.title}
              active={Math.abs(settings.triggerStrength - f.strength) < 0.05}
              onClick={() => onChange({ triggerStrength: f.strength })}
            >
              <ChoiceText title={f.title} detail={f.detail} />
            </Choice>
          ))}
        </div>
      ) : null}
      <div className="grid grid-cols-3 gap-2">
        {LIGHTBAR_CHOICES.map((c) => (
          <Choice key={c.id} active={settings.lightbar === c.id} onClick={() => onChange({ lightbar: c.id })}>
            <ChoiceText title={c.title} detail={c.detail} />
          </Choice>
        ))}
      </div>
      <Toggle
        label="Rev lights"
        detail="The five player LEDs fill up to the shift point; the mic LED shows the overtake boost"
        checked={settings.revLeds}
        onChange={() => onChange({ revLeds: !settings.revLeds })}
      />
      <div className="flex flex-wrap gap-2">
        <PillAction onClick={() => testTriggers(settings.triggerStrength)} disabled={!settings.adaptiveTriggers}>
          Test triggers
        </PillAction>
        <PillAction onClick={() => testDualSenseRumble(settings)}>{settings.hdHaptics && usb ? "Test haptics" : "Test rumble"}</PillAction>
      </div>
    </div>
  );

  const chip = statusText ? (
    <span className="flex min-w-0 items-center gap-2 font-f1-mono text-[12px] font-bold text-[#CCFF00]">
      <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#CCFF00] shadow-[0_0_8px_#CCFF00]" />
      <span className="truncate">{statusText}</span>
    </span>
  ) : undefined;

  if (variant === "pause") {
    return (
      <section
        aria-label="DualSense"
        className="flex flex-col gap-3 rounded-[24px] border border-white/[0.07] bg-[#0D0F15]/82 px-5 py-[18px] text-[#F5F7FA]"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <PanelSection color="#00E5FF">DualSense</PanelSection>
          {chip}
        </div>
        {body}
      </section>
    );
  }
  return (
    <SetupCard label="DualSense" action={chip}>
      {body}
    </SetupCard>
  );
};
