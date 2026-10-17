"use client";

import React from "react";
import type { CarTelemetry } from "@/types/f1";
import { HUD_CYAN, HUD_GREEN, HUD_PURPLE, HUD_RED } from "./hud-format";
import { AidLamp } from "./F12026ChannelsPanel";

/** Rev lights: 15 LEDs over the last part of the rev range (green → red → blue) */
const REV_LEDS = 15;
/** First LED and all-lit rpm per car (the F1 cars by default; the GT3's 7700 rpm limiter) */
const REV_RANGE: Record<string, [number, number]> = { "amg-gt3": [6200, 7500] };
const F1_REV_RANGE: [number, number] = [10_800, 14_600];
const ledColor = (i: number) => (i < 5 ? HUD_GREEN : i < 10 ? HUD_RED : "#3B82F6");

interface SpeedClusterProps {
  telemetry: CarTelemetry;
  boostLatch: boolean;
  onToggleBoostLatch: () => void;
  onToggleXMode: () => void;
}

/** Bottom-right cluster: rev lights, gear, speed, pedals, ERS and active-aero state */
export const SpeedCluster: React.FC<SpeedClusterProps> = ({
  telemetry,
  boostLatch,
  onToggleBoostLatch,
  onToggleXMode,
}) => {
  const channels = telemetry.f12026;
  const [revStart, revFull] = (channels && REV_RANGE[channels.carId]) ?? F1_REV_RANGE;
  const hasErs = channels?.hasErs ?? true;
  const lit = Math.round(((telemetry.rpm - revStart) / (revFull - revStart)) * REV_LEDS);
  const flash = telemetry.rpm > revFull;
  const gear = telemetry.gear === 0 ? "N" : telemetry.gear < 0 ? "R" : String(telemetry.gear);
  const xMode = telemetry.activeAeroMode === "X_MODE";
  // The f12026-car has driver-operated DRS (X_MODE = flap open) instead of active aero; the GT3 has neither
  const drs = channels?.hasDrs ? channels : null;
  const hasAero = !channels || channels.hasDrs;
  const aeroBg = drs
    ? xMode
      ? HUD_GREEN
      : drs.drsAvailable
        ? "rgba(255,255,255,0.85)"
        : "rgba(255,255,255,0.25)"
    : xMode
      ? HUD_GREEN
      : "rgba(255,255,255,0.85)";
  const boost = telemetry.manualOverrideActive || boostLatch;
  const ers = Math.max(0, Math.min(100, telemetry.ersBatteryPercent));
  const deploying = telemetry.mgukPowerKw > 5;

  return (
    <div className="hud-panel w-[300px] rounded-md px-3 pt-2.5 pb-3">
      {/* Rev lights */}
      <div className="flex justify-between gap-[3px]">
        {Array.from({ length: REV_LEDS }, (_, i) => (
          <span
            key={i}
            className="h-2.5 flex-1 rounded-full"
            style={{
              backgroundColor: flash ? "#3B82F6" : i < lit ? ledColor(i) : "rgba(255,255,255,0.1)",
              boxShadow: flash || i < lit ? `0 0 6px ${flash ? "#3B82F6" : ledColor(i)}` : "none",
            }}
          />
        ))}
      </div>

      <div className="mt-2 grid grid-cols-[28px_1fr_auto_18px] items-end gap-3">
        {/* Throttle / brake / FFB torque & clipping bar */}
        <div className="flex flex-col items-center gap-0.5">
          <div className="flex h-[68px] gap-[3px]">
            <div className="relative w-[6px] overflow-hidden rounded-sm bg-white/10" title="Brake">
              <div className="absolute inset-x-0 bottom-0" style={{ height: `${telemetry.brake * 100}%`, backgroundColor: HUD_RED }} />
            </div>
            <div className="relative w-[6px] overflow-hidden rounded-sm bg-white/10" title="Throttle">
              <div className="absolute inset-x-0 bottom-0" style={{ height: `${telemetry.throttle * 100}%`, backgroundColor: HUD_GREEN }} />
            </div>
            <div className="relative w-[6px] overflow-hidden rounded-sm bg-white/10" title="Steering torque (what wheel force feedback plays) · red = clipping">
              <div
                className="absolute inset-x-0 bottom-0 transition-[height]"
                style={{
                  height: `${Math.min(100, Math.abs(telemetry.ffbTorqueNorm ?? 0) * 100)}%`,
                  backgroundColor: telemetry.ffbClipping ? HUD_RED : HUD_CYAN,
                }}
              />
            </div>
          </div>
          <span
            className="font-f1-mono text-[8px] leading-none font-bold tracking-wider uppercase"
            style={{ color: telemetry.ffbClipping ? HUD_RED : "rgba(255,255,255,0.45)" }}
          >
            FFB
          </span>
        </div>

        <div>
          <div className="hud-num text-[56px] text-white">{Math.round(telemetry.speedKmh)}</div>
          <div className="hud-label mt-1">km/h</div>
        </div>

        <div className="flex h-[78px] w-[64px] flex-col items-center justify-center rounded-md border-2 border-white/80 bg-black/40">
          <span className="hud-num text-[56px] text-white">{gear}</span>
        </div>

        {/* ERS battery (none on the GT3) */}
        <div className="flex h-[78px] flex-col items-center">
          {hasErs ? (
            <div className="relative w-[9px] flex-1 overflow-hidden rounded-sm bg-white/10">
              <div
                className="absolute inset-x-0 bottom-0 transition-[height]"
                style={{ height: `${ers}%`, backgroundColor: boost ? HUD_PURPLE : "#FACC15" }}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-1.5">
        {channels && !hasAero ? (
          <>
            <AidLamp label="TC" active={channels.tcActive} />
            <AidLamp label="ABS" active={channels.absActive} />
          </>
        ) : (
          <button
            type="button"
            onClick={onToggleXMode}
            className="hud-num pointer-events-auto cursor-pointer rounded px-2 py-1 text-[13px] text-[#0B0B10]"
            style={{ backgroundColor: aeroBg }}
            title={drs ? "DRS (X): opens in a DRS zone once its detection point is crossed" : "Active aero (X)"}
          >
            {drs ? "DRS" : xMode ? "X-MODE" : "Z-MODE"}
          </button>
        )}
        {hasErs ? (
          <button
            type="button"
            onClick={onToggleBoostLatch}
            className="hud-num pointer-events-auto cursor-pointer rounded px-2 py-1 text-[13px]"
            style={{
              backgroundColor: boost ? HUD_PURPLE : "rgba(255,255,255,0.1)",
              color: boost ? "#fff" : "rgba(255,255,255,0.7)",
            }}
            title="Manual override boost (Space / B)"
          >
            BOOST
          </button>
        ) : null}
        {hasErs ? (
          <span className="ml-auto flex items-baseline gap-1">
            <span className="hud-label !text-[10px]">ERS</span>
            <span className="hud-num text-[18px]" style={{ color: deploying ? HUD_CYAN : "#FACC15" }}>
              {ers.toFixed(0)}%
            </span>
          </span>
        ) : (
          <span className="ml-auto flex items-baseline gap-1">
            <span className="hud-label !text-[10px]">RPM</span>
            <span className="hud-num text-[18px] text-white">{Math.round(telemetry.rpm)}</span>
          </span>
        )}
      </div>
    </div>
  );
};
