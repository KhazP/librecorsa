"use client";

import React from "react";
import type { CarTelemetry } from "@/types/f1";
import {
  HUD_CYAN,
  HUD_GLASS,
  HUD_GREEN,
  HUD_LBL,
  HUD_PURPLE,
  HUD_RED,
  HUD_SLATE,
  HUD_VOLT,
  HUD_WHITE,
} from "./hud-format";
import { AidLamp } from "./F12026ChannelsPanel";

/** Rev lights: 15 LEDs over the top end of the rev range (Emerald → Corsa Volt → Monza Rosso → Cyan flash) */
const REV_LEDS = 15;
/** First LED and all-lit rpm per car (the Formula cars by default; the GT3's 7500 rpm shift point) */
const REV_RANGE: Record<string, [number, number]> = { "amg-gt3": [6200, 7500] };
const F1_REV_RANGE: [number, number] = [10_800, 14_600];
const LED_INDEXES = Array.from({ length: REV_LEDS }, (_, i) => i);

const ledColor = (i: number) =>
  i < 5 ? HUD_GREEN : i < 10 ? HUD_VOLT : i < 13 ? HUD_RED : HUD_CYAN;

interface SpeedClusterProps {
  telemetry: CarTelemetry;
  boostLatch: boolean;
  onToggleBoostLatch: () => void;
  onToggleXMode: () => void;
  /** Minimal HUD: a speed and gear pill under a slim status strip */
  variant?: "full" | "minimal";
}

/** Vertical input bar (brake / throttle / force) with its letter under it */
const InputBar: React.FC<{ label: string; pct: number; color: string; labelColor?: string; title: string; h: string }> = ({
  label,
  pct,
  color,
  labelColor,
  title,
  h,
}) => (
  <span className="flex flex-col items-center gap-[3px]" title={title}>
    <span className={`relative w-[7px] overflow-hidden rounded-full bg-[#1B1F2B] ${h}`}>
      <span className="absolute inset-x-0 bottom-0" style={{ height: `${pct}%`, backgroundColor: color }} />
    </span>
    <span className={`${HUD_LBL} !tracking-normal`} style={labelColor ? { color: labelColor } : undefined}>
      {label}
    </span>
  </span>
);

/** Bottom-right LibreCorsa MoTeC-style digital dash pod: rev lights, gear, speed, pedals/FFB, ERS and aero state */
export const SpeedCluster: React.FC<SpeedClusterProps> = ({
  telemetry,
  boostLatch,
  onToggleBoostLatch,
  onToggleXMode,
  variant = "full",
}) => {
  const channels = telemetry.f12026;
  const isGt3 = channels?.carId === "amg-gt3";
  const [revStart, revFull] = (channels && REV_RANGE[channels.carId]) ?? F1_REV_RANGE;
  const hasErs = channels?.hasErs ?? true;
  const lit = Math.round(((telemetry.rpm - revStart) / (revFull - revStart)) * REV_LEDS);
  const flash = telemetry.rpm > revFull;
  const gear = telemetry.gear === 0 ? "N" : telemetry.gear < 0 ? "R" : String(telemetry.gear);
  const xMode = telemetry.activeAeroMode === "X_MODE";
  const drs = channels?.hasDrs ? channels : null;
  const hasAero = !channels || channels.hasDrs;

  const boost = telemetry.manualOverrideActive || boostLatch;
  const ers = Math.max(0, Math.min(100, telemetry.ersBatteryPercent));
  const deploying = telemetry.mgukPowerKw > 5;
  const harvesting = telemetry.mgukPowerKw < -5;
  const ffbPct = Math.min(100, Math.abs(telemetry.ffbTorqueNorm ?? 0) * 100);
  const speed = Math.round(telemetry.speedKmh);
  const latG = Math.abs(telemetry.lateralG).toFixed(1);

  const aeroOn = (drs && (xMode || drs.drsAvailable)) || (!drs && xMode);
  const aeroBg = xMode ? HUD_CYAN : drs?.drsAvailable ? HUD_VOLT : "#1B1F2B";
  const aeroTextColor = aeroOn ? "#08090D" : HUD_SLATE;
  const aeroLabel = drs ? (xMode ? "DRS OPEN" : drs.drsAvailable ? "DRS ARMED" : "DRS") : xMode ? "X-MODE" : "Z-MODE";
  const ersColor = boost ? HUD_PURPLE : deploying ? HUD_VOLT : harvesting ? HUD_GREEN : HUD_WHITE;
  const ersLabel = harvesting ? "Harvest" : deploying ? "Deploy" : "ERS SOC";

  const leds = (cls: string, glow: boolean) =>
    LED_INDEXES.map((i) => {
      const active = flash || i < lit;
      const c = flash ? HUD_CYAN : ledColor(i);
      return (
        <span
          key={i}
          className={`flex-1 rounded-full transition-colors duration-75 ${cls}`}
          style={{
            backgroundColor: active ? c : "rgba(255,255,255,0.07)",
            boxShadow: glow && active ? `0 0 6px ${c}` : "none",
          }}
        />
      );
    });

  /** Aero / aids, boost and battery (or longitudinal G) controls shared by both layouts */
  const controls = (
    <>
      {channels && !hasAero ? (
        <>
          <AidLamp label="TC" active={channels.tcActive} />
          <AidLamp label="ABS" active={channels.absActive} />
        </>
      ) : (
        <button
          type="button"
          onClick={onToggleXMode}
          className="lc-data pointer-events-auto cursor-pointer rounded-full px-2.5 py-1 text-[11px] transition-colors"
          style={{ backgroundColor: aeroBg, color: aeroTextColor }}
          title={drs ? "DRS (X): opens in a DRS zone once its detection point is crossed" : "Active aero (X)"}
        >
          {aeroLabel}
        </button>
      )}
      {hasErs ? (
        <button
          type="button"
          onClick={onToggleBoostLatch}
          className="lc-data pointer-events-auto cursor-pointer rounded-full px-2.5 py-1 text-[11px] transition-colors"
          style={{
            backgroundColor: boost ? HUD_PURPLE : "#1B1F2B",
            color: boost ? HUD_WHITE : HUD_SLATE,
            boxShadow: boost ? `0 0 12px ${HUD_PURPLE}66` : "none",
          }}
          title="Manual override boost (Space / B)"
        >
          OVR BOOST
        </button>
      ) : null}
    </>
  );

  const readout = hasErs ? (
    <span className="flex items-baseline gap-1.5">
      <span className={HUD_LBL}>{ersLabel}</span>
      <span className="lc-data text-[17px] leading-none" style={{ color: ersColor }}>
        {ers.toFixed(0)}%
      </span>
    </span>
  ) : (
    <span className="flex items-baseline gap-1.5">
      <span className={HUD_LBL}>Lon G</span>
      <span className="lc-data text-[16px] leading-none text-[#F5F7FA]">
        {telemetry.longitudinalG >= 0 ? "+" : "−"}
        {Math.abs(telemetry.longitudinalG).toFixed(1)}G
      </span>
    </span>
  );

  const inputBars = (h: string) => (
    <div className="flex items-end gap-[5px]" aria-label="Brake, throttle, force">
      <InputBar label="B" pct={telemetry.brake * 100} color={HUD_RED} title="Brake Input" h={h} />
      <InputBar label="T" pct={telemetry.throttle * 100} color={HUD_GREEN} title="Throttle Input" h={h} />
      <InputBar
        label="F"
        pct={ffbPct}
        color={telemetry.ffbClipping ? HUD_RED : HUD_CYAN}
        labelColor={telemetry.ffbClipping ? HUD_RED : undefined}
        title="Steering Torque / Force Feedback (Red = Clipping)"
        h={h}
      />
    </div>
  );

  const gearRing = flash ? HUD_RED : xMode ? HUD_CYAN : HUD_VOLT;

  if (variant === "minimal") {
    return (
      <div className="flex flex-col items-end gap-2">
        {/* Slim status strip: rev lights, rpm, aero / boost and battery */}
        <div className={`flex items-center gap-2 rounded-full py-1.5 pr-3 pl-2 ${HUD_GLASS}`}>
          {controls}
          <span className="flex w-[90px] gap-[2px] rounded-full bg-[#050608] p-1" aria-label={`Shift lights: ${Math.max(0, Math.min(REV_LEDS, lit))} of ${REV_LEDS}`}>
            {leds("h-1.5", false)}
          </span>
          {readout}
        </div>
        <section aria-label="Speed and gear" className={`flex items-center gap-[18px] rounded-full py-2.5 pr-2.5 pl-6 ${HUD_GLASS}`}>
          {inputBars("h-[52px]")}
          <div className="flex flex-col items-end">
            <span className="lc-data text-[52px] leading-[0.9] tracking-[-0.02em] text-[#F5F7FA]">{speed}</span>
            <span className={HUD_LBL}>
              KM/H · {Math.round(telemetry.rpm).toLocaleString()} RPM · {latG}G
            </span>
          </div>
          <span
            className="flex h-[76px] w-[76px] items-center justify-center rounded-full text-[#08090D] transition-colors"
            style={{ backgroundColor: gearRing, boxShadow: flash ? `0 0 18px ${HUD_RED}88` : "none" }}
            aria-label={`Gear ${gear}`}
          >
            <span className="lc-disp text-[52px] leading-none">{gear}</span>
          </span>
        </section>
      </div>
    );
  }

  return (
    <section aria-label="Speed cluster" className={`w-[320px] rounded-[22px] px-3.5 py-3 ${HUD_GLASS}`}>
      {/* Car badge, shift call and rpm */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span
            className="lc-data rounded-full px-2 py-0.5 text-[9px] italic"
            style={{ backgroundColor: isGt3 ? HUD_CYAN : HUD_VOLT, color: "#08090D" }}
          >
            {isGt3 ? "GT3 PRO" : "FA-26"}
          </span>
          {flash ? (
            <span className="lc-data animate-pulse rounded-full bg-[#FF2A3C] px-2 py-0.5 text-[9px] text-[#F5F7FA]">
              SHIFT
            </span>
          ) : null}
        </div>
        <span className="lc-data text-[13px] text-[#F5F7FA]">
          {Math.round(telemetry.rpm).toLocaleString()} <span className={HUD_LBL}>RPM</span>
        </span>
      </div>

      {/* 15-LED shift lights */}
      <div
        className="my-2.5 flex gap-1 rounded-full bg-[#050608] px-2 py-1.5"
        aria-label={`Shift lights: ${Math.max(0, Math.min(REV_LEDS, lit))} of ${REV_LEDS}`}
      >
        {leds("h-2", true)}
      </div>

      {/* Inputs | speed | gear | battery */}
      <div className="flex items-center gap-3.5">
        {inputBars("h-16")}

        <div className="flex min-w-0 flex-1 flex-col items-end">
          <span className="lc-data text-[58px] leading-[0.9] tracking-[-0.02em] text-[#F5F7FA]">{speed}</span>
          <span className={`${HUD_LBL} !text-[#CCFF00]`}>
            KM/H · <span className="text-[#8E96AA]">{latG}G LAT</span>
          </span>
        </div>

        <div
          className="flex h-20 w-[70px] flex-none flex-col items-center justify-center rounded-[22px] border-2 bg-[#050608] transition-colors"
          style={{ borderColor: gearRing, boxShadow: flash ? `0 0 14px ${HUD_RED}55` : "none" }}
        >
          <span className={HUD_LBL}>Gear</span>
          <span className="lc-data text-[48px] leading-none text-[#F5F7FA]">{gear}</span>
        </div>

        {hasErs ? (
          <span
            className="relative h-20 w-2.5 flex-none overflow-hidden rounded-full bg-[#1B1F2B]"
            title="ERS Battery State of Charge"
          >
            <span
              className="absolute inset-x-0 bottom-0 transition-[height]"
              style={{ height: `${ers}%`, backgroundColor: boost ? HUD_PURPLE : harvesting ? HUD_GREEN : HUD_VOLT }}
            />
          </span>
        ) : (
          <span className="relative h-20 w-2.5 flex-none overflow-hidden rounded-full bg-[#1B1F2B]" title="Engine RPM Band">
            <span
              className="absolute inset-x-0 bottom-0"
              style={{
                height: `${Math.min(100, (telemetry.rpm / revFull) * 100)}%`,
                backgroundColor: flash ? HUD_RED : HUD_CYAN,
              }}
            />
          </span>
        )}
      </div>

      {/* Aero / aids, boost and battery */}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-[#262B3D] pt-2.5">
        <span className="flex items-center gap-1.5">{controls}</span>
        {readout}
      </div>
    </section>
  );
};
