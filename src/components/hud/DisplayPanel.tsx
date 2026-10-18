"use client";

import React, { useState } from "react";
import {
  sanitizeColor,
  sanitizeDriverCode,
  sanitizeDriverName,
  type DriverProfile,
  type GraphicsQuality,
  type GraphicsSettings,
  type HudPreset,
  type HudSettings,
  type PlayerSettings,
  type TouchMode,
  type TouchSettings,
} from "@/lib/settings/player-settings";
import { Choice, Toggle } from "./PauseMenu";

export interface DisplayPanelProps {
  settings: PlayerSettings;
  onChangeSettings: (update: (prev: PlayerSettings) => PlayerSettings) => void;
  /** WebXR immersive-vr is available on this device */
  vrSupported: boolean;
  vrActive: boolean;
  onEnterVr: () => void;
}

const DRIVER_COLORS = ["#E10600", "#00D2BE", "#FF8700", "#0600EF", "#006F62", "#2B4562", "#B6BABD", "#CCFF00"] as const;

const HUD_PRESETS: { id: HudPreset; title: string; detail: string }[] = [
  { id: "broadcast", title: "Broadcast", detail: "TV graphics: tower, map, telemetry strip" },
  { id: "dash", title: "Wheel Dash", detail: "Steering-wheel screen, low and centred" },
  { id: "telemetry", title: "Telemetry", detail: "The dash plus tyres, G, power, inputs" },
  { id: "classic", title: "Classic", detail: "The original corner panels" },
  { id: "minimal", title: "Minimal", detail: "Speed, gear and lap only" },
];

const QUALITY_CHOICES: { id: GraphicsQuality; title: string; detail: string }[] = [
  { id: "low", title: "Low", detail: "No shadows or bloom, lower resolution — for laptops and phones" },
  { id: "medium", title: "Medium", detail: "Shadows, no bloom" },
  { id: "high", title: "High", detail: "Everything on" },
];

const TOUCH_CHOICES: { id: TouchMode; title: string; detail: string }[] = [
  { id: "auto", title: "Auto", detail: "Phones and tablets" },
  { id: "on", title: "On", detail: "Always" },
  { id: "off", title: "Off", detail: "Never" },
];

const CARD = "f1-panel f1-corner-tr rounded-lg border border-[#262B3D] bg-[#11131A] p-4 text-[#F5F7FA]";
const LABEL = "font-f1-mono text-[11px] font-bold tracking-[0.16em] text-[#8E96AA]";
const INPUT =
  "w-full rounded border border-[#262B3D] bg-[#08090D] px-2.5 py-2 font-f1-mono text-sm text-[#F5F7FA] outline-none focus:border-[#CCFF00]";

/** Card header: coloured bar + small mono label, as in the pause menu's session card */
const CardHeader: React.FC<{ label: string; color: string }> = ({ label, color }) => (
  <div className={`mb-2.5 flex items-center gap-2 ${LABEL}`}>
    <span className="h-2.5 w-1 rounded-full" style={{ backgroundColor: color }} />
    {label}
  </div>
);

/** Labelled range slider with a live value, rounded to its step */
const RangeRow: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  hint?: string;
  onChange: (value: number) => void;
}> = ({ label, value, min, max, step, format, hint, onChange }) => (
  <label className="block rounded px-1.5 py-1.5 hover:bg-white/5">
    <span className="flex items-center justify-between gap-3">
      <span className="font-f1-italic text-[15px] text-[#F5F7FA] uppercase">{label}</span>
      <span className="font-f1-mono text-sm font-bold text-[#CCFF00] tabular-nums">{format(value)}</span>
    </span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(Number(e.target.value).toFixed(2)))}
      className="mt-1 w-full cursor-pointer accent-[#CCFF00]"
    />
    {hint ? <span className="block font-f1-mono text-[11px] text-[#8E96AA]">{hint}</span> : null}
  </label>
);

const formatPercent = (value: number) => `${Math.round(value * 100)}%`;

/** Driver identity, HUD layout, graphics and touch / ghost options, saved to the player's settings */
export const DisplayPanel: React.FC<DisplayPanelProps> = ({ settings, onChangeSettings, vrSupported, vrActive, onEnterVr }) => {
  // Live text while the name or code field is being edited; null shows the saved value
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [codeDraft, setCodeDraft] = useState<string | null>(null);

  const { profile, hud, graphics, touch } = settings;

  const setProfile = (patch: Partial<DriverProfile>) =>
    onChangeSettings((prev) => ({ ...prev, profile: { ...prev.profile, ...patch } }));
  const setHud = (patch: Partial<HudSettings>) => onChangeSettings((prev) => ({ ...prev, hud: { ...prev.hud, ...patch } }));
  const setGraphics = (patch: Partial<GraphicsSettings>) =>
    onChangeSettings((prev) => ({ ...prev, graphics: { ...prev.graphics, ...patch } }));
  const setTouch = (patch: Partial<TouchSettings>) =>
    onChangeSettings((prev) => ({ ...prev, touch: { ...prev.touch, ...patch } }));

  const commitName = () => {
    setProfile({ name: sanitizeDriverName(nameDraft ?? profile.name) });
    setNameDraft(null);
  };
  const commitCode = () => {
    setProfile({ code: sanitizeDriverCode(codeDraft ?? profile.code) });
    setCodeDraft(null);
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* DRIVER */}
      <div className={CARD}>
        <CardHeader label="DRIVER" color="#CCFF00" />
        <div className="grid grid-cols-[1fr_96px] gap-2">
          <label className="block">
            <span className={`mb-1 block ${LABEL}`}>NAME</span>
            <input
              type="text"
              maxLength={16}
              value={nameDraft ?? profile.name}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              className={INPUT}
            />
          </label>
          <label className="block">
            <span className={`mb-1 block ${LABEL}`}>CODE</span>
            <input
              type="text"
              maxLength={3}
              value={codeDraft ?? profile.code}
              onChange={(e) => setCodeDraft(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3))}
              onBlur={commitCode}
              className={`${INPUT} uppercase`}
            />
          </label>
        </div>

        <div className={`mt-4 mb-2 ${LABEL}`}>COLOUR</div>
        <div className="flex flex-wrap items-center gap-2">
          {DRIVER_COLORS.map((c) => {
            const active = profile.color === c;
            return (
              <button
                key={c}
                type="button"
                aria-label={`Colour ${c}`}
                aria-pressed={active}
                onClick={() => setProfile({ color: sanitizeColor(c) })}
                style={{ backgroundColor: c }}
                className={`h-7 w-7 cursor-pointer rounded-full border-2 transition-transform hover:scale-110 ${
                  active ? "border-[#F5F7FA] ring-2 ring-[#CCFF00]" : "border-[#262B3D]"
                }`}
              />
            );
          })}
          <label className="ml-1 flex cursor-pointer items-center gap-2 font-f1-mono text-[11px] text-[#8E96AA]">
            <input
              type="color"
              value={profile.color.toLowerCase()}
              onChange={(e) => setProfile({ color: sanitizeColor(e.target.value) })}
              className="h-7 w-9 cursor-pointer rounded border border-[#262B3D] bg-[#08090D] p-0.5"
            />
            Custom
          </label>
        </div>
        <p className="mt-3 font-f1-mono text-[11px] text-[#8E96AA]">Shown to other players in multiplayer and on leaderboards.</p>
      </div>

      {/* HUD */}
      <div className={CARD}>
        <CardHeader label="HUD" color="#00E5FF" />
        <div className={`mb-2 ${LABEL}`}>LAYOUT</div>
        <div className="grid grid-cols-2 gap-2">
          {HUD_PRESETS.map((p) => (
            <Choice key={p.id} active={hud.preset === p.id} onClick={() => setHud({ preset: p.id })}>
              <span className="block font-f1-italic text-sm text-[#F5F7FA] uppercase">{p.title}</span>
              <span className="block font-f1-mono text-[11px] opacity-80">{p.detail}</span>
            </Choice>
          ))}
        </div>

        <div className="mt-4">
          <RangeRow
            label="HUD size"
            value={hud.scale}
            min={0.75}
            max={1.5}
            step={0.05}
            format={formatPercent}
            onChange={(scale) => setHud({ scale })}
          />
        </div>

        <div className="mt-2">
          <Toggle
            label="Input trace"
            detail="Rolling throttle, brake and steering trace"
            checked={hud.inputTrace}
            onChange={() => setHud({ inputTrace: !hud.inputTrace })}
          />
          <Toggle
            label="Delta bar"
            detail="Live gap bar in Classic and Minimal (the other styles show the delta)"
            checked={hud.deltaBar}
            onChange={() => setHud({ deltaBar: !hud.deltaBar })}
          />
          <Toggle
            label="Lap summary card"
            detail="Sectors, corner speeds and theoretical best after each lap"
            checked={hud.lapSummary}
            onChange={() => setHud({ lapSummary: !hud.lapSummary })}
          />
        </div>
      </div>

      {/* GRAPHICS */}
      <div className={CARD}>
        <CardHeader label="GRAPHICS" color="#FF8700" />
        <div className={`mb-2 ${LABEL}`}>QUALITY</div>
        <div className="grid gap-2">
          {QUALITY_CHOICES.map((q) => (
            <Choice key={q.id} active={graphics.quality === q.id} onClick={() => setGraphics({ quality: q.id })}>
              <span className="block font-f1-italic text-sm text-[#F5F7FA] uppercase">{q.title}</span>
              <span className="block font-f1-mono text-[11px] opacity-80">{q.detail}</span>
            </Choice>
          ))}
        </div>

        <div className="mt-4">
          <RangeRow
            label="Render resolution"
            value={graphics.renderScale}
            min={0.5}
            max={1.5}
            step={0.05}
            format={formatPercent}
            hint="Lower is faster"
            onChange={(renderScale) => setGraphics({ renderScale })}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[#262B3D]/60 pt-3">
          <span className="font-f1-italic text-[15px] text-[#F5F7FA] uppercase">VR</span>
          {vrSupported ? (
            <button
              type="button"
              disabled={vrActive}
              onClick={onEnterVr}
              className="cursor-pointer rounded border border-[#CCFF00] bg-[#CCFF00]/15 px-3 py-1.5 font-f1-mono text-xs font-bold text-[#CCFF00] uppercase hover:bg-[#CCFF00]/25 disabled:cursor-default disabled:opacity-60"
            >
              {vrActive ? "In VR" : "Enter VR (WebXR)"}
            </button>
          ) : (
            <span className="font-f1-mono text-[11px] text-[#8E96AA]">
              VR headset not detected (needs a WebXR browser, e.g. Quest Browser or Chrome with SteamVR/OpenXR)
            </span>
          )}
        </div>
      </div>

      {/* TOUCH & GHOST */}
      <div className={CARD}>
        <CardHeader label="TOUCH & GHOST" color="#00D2BE" />
        <div className={`mb-2 ${LABEL}`}>TOUCH CONTROLS</div>
        <div className="grid grid-cols-3 gap-2">
          {TOUCH_CHOICES.map((t) => (
            <Choice key={t.id} active={touch.mode === t.id} onClick={() => setTouch({ mode: t.id })}>
              <span className="block text-center font-f1-italic text-sm text-[#F5F7FA] uppercase">{t.title}</span>
              <span className="block text-center font-f1-mono text-[11px] opacity-80">{t.detail}</span>
            </Choice>
          ))}
        </div>

        <div className="mt-3">
          <Toggle
            label="Tilt to steer"
            detail="Tilt the device instead of the on-screen slider"
            checked={touch.tiltSteer}
            onChange={() => setTouch({ tiltSteer: !touch.tiltSteer })}
          />
          <RangeRow
            label="Tilt range"
            value={touch.tiltRangeDeg}
            min={10}
            max={60}
            step={1}
            format={(v) => `${v}°`}
            hint="Tilt angle for full lock"
            onChange={(tiltRangeDeg) => setTouch({ tiltRangeDeg })}
          />
        </div>

        <div className="mt-3 border-t border-[#262B3D]/60 pt-2">
          <Toggle
            label="Race my best-lap ghost"
            detail="Your personal-best lap races alongside you on this circuit"
            checked={settings.ghost}
            onChange={() => onChangeSettings((prev) => ({ ...prev, ghost: !prev.ghost }))}
          />
        </div>
      </div>
    </div>
  );
};
