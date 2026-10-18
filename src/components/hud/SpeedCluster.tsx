"use client";

import React from "react";
import type { CarTelemetry } from "@/types/f1";
import {
  HUD_CYAN,
  HUD_GREEN,
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

const ledColor = (i: number) =>
  i < 5 ? HUD_GREEN : i < 10 ? HUD_VOLT : i < 13 ? HUD_RED : HUD_CYAN;

interface SpeedClusterProps {
  telemetry: CarTelemetry;
  boostLatch: boolean;
  onToggleBoostLatch: () => void;
  onToggleXMode: () => void;
}

/** Bottom-right LibreCorsa MoTeC-style digital dash pod: rev lights, gear, speed, pedals/FFB, ERS and aero state */
export const SpeedCluster: React.FC<SpeedClusterProps> = ({
  telemetry,
  boostLatch,
  onToggleBoostLatch,
  onToggleXMode,
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

  const aeroBg = drs
    ? xMode
      ? HUD_CYAN
      : drs.drsAvailable
        ? HUD_VOLT
        : "rgba(27, 31, 43, 0.9)"
    : xMode
      ? HUD_CYAN
      : "rgba(27, 31, 43, 0.9)";

  const aeroTextColor =
    (drs && (xMode || drs.drsAvailable)) || (!drs && xMode) ? "#08090D" : HUD_WHITE;

  return (
    <div className="hud-panel f1-corner-tr w-[312px] rounded-lg px-3.5 pt-2.5 pb-3">
      {/* Top Class & RPM Header */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span
            className="rounded-sm px-1.5 py-0.5 font-f1-display text-[9px] font-black italic tracking-wider"
            style={{
              backgroundColor: isGt3 ? HUD_CYAN : HUD_VOLT,
              color: "#08090D",
            }}
          >
            {isGt3 ? "GT3 PRO" : "FA-26"}
          </span>
          {flash ? (
            <span className="animate-pulse rounded-sm bg-[#FF2A3C] px-1.5 py-0.5 font-f1-mono text-[9px] font-black tracking-wider text-white">
              SHIFT
            </span>
          ) : null}
        </div>
        <div className="flex items-baseline gap-1 font-f1-mono">
          <span className="text-[13px] font-extrabold tabular-nums text-[#F5F7FA]">
            {Math.round(telemetry.rpm).toLocaleString()}
          </span>
          <span className="text-[9px] font-bold tracking-widest text-[#8E96AA]">RPM</span>
        </div>
      </div>

      {/* 15-LED Shift Light Array in Carbon Trough */}
      <div className="flex justify-between gap-[3px] rounded bg-[#08090D] p-1.5 border border-[#262B3D]">
        {Array.from({ length: REV_LEDS }, (_, i) => {
          const active = flash || i < lit;
          const c = flash ? HUD_CYAN : ledColor(i);
          return (
            <span
              key={i}
              className="h-2.5 flex-1 rounded-[2px] transition-colors duration-75"
              style={{
                backgroundColor: active ? c : "rgba(255,255,255,0.07)",
                boxShadow: active ? `0 0 8px ${c}` : "none",
              }}
            />
          );
        })}
      </div>

      {/* Main Telemetry Core: Pedals/FFB | Speed | Gear | ERS Bar */}
      <div className="mt-2.5 grid grid-cols-[36px_1fr_auto_14px] items-center gap-3">
        {/* Left: Brake / Throttle / FFB Vertical Telemetry Bars */}
        <div className="flex flex-col items-center gap-1">
          <div className="flex h-[70px] gap-[4px] rounded bg-[#08090D] p-1 border border-[#262B3D]">
            <div className="relative w-[6px] overflow-hidden rounded-[1px] bg-white/8" title="Brake Input">
              <div
                className="absolute inset-x-0 bottom-0"
                style={{ height: `${telemetry.brake * 100}%`, backgroundColor: HUD_RED }}
              />
            </div>
            <div className="relative w-[6px] overflow-hidden rounded-[1px] bg-white/8" title="Throttle Input">
              <div
                className="absolute inset-x-0 bottom-0"
                style={{ height: `${telemetry.throttle * 100}%`, backgroundColor: HUD_GREEN }}
              />
            </div>
            <div
              className="relative w-[6px] overflow-hidden rounded-[1px] bg-white/8"
              title="Steering Torque / Force Feedback (Red = Clipping)"
            >
              <div
                className="absolute inset-x-0 bottom-0 transition-[height]"
                style={{
                  height: `${Math.min(100, Math.abs(telemetry.ffbTorqueNorm ?? 0) * 100)}%`,
                  backgroundColor: telemetry.ffbClipping ? HUD_RED : HUD_CYAN,
                }}
              />
            </div>
          </div>
          <div className="flex w-full justify-around font-f1-mono text-[8px] leading-none font-bold text-[#8E96AA]">
            <span>B</span>
            <span>T</span>
            <span style={{ color: telemetry.ffbClipping ? HUD_RED : HUD_SLATE }}>F</span>
          </div>
        </div>

        {/* Center-Left: Tabular Speed & G-Load */}
        <div className="flex flex-col justify-center">
          <div className="hud-num text-[58px] tracking-tight text-[#F5F7FA]">
            {Math.round(telemetry.speedKmh)}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="hud-label !text-[#CCFF00]">KM/H</span>
            <span className="font-f1-mono text-[10px] font-bold tabular-nums text-[#8E96AA]">
              {Math.abs(telemetry.lateralG).toFixed(1)}G LAT
            </span>
          </div>
        </div>

        {/* Center-Right: Chamfered Carbon Gear Indicator */}
        <div
          className="relative flex h-[78px] w-[66px] flex-col items-center justify-center rounded-md border-2 bg-[#08090D] transition-colors"
          style={{
            borderColor: flash ? HUD_RED : xMode ? HUD_CYAN : HUD_VOLT,
            boxShadow: flash ? `0 0 14px ${HUD_RED}55` : "inset 0 0 16px rgba(0,0,0,0.8)",
          }}
        >
          <span className="absolute top-1 font-f1-mono text-[8px] font-bold tracking-widest text-[#8E96AA]">
            GEAR
          </span>
          <span className="hud-num mt-2 text-[52px] text-[#F5F7FA]">{gear}</span>
        </div>

        {/* Right: ERS State of Charge Vertical Column */}
        <div className="flex h-[78px] flex-col items-center">
          {hasErs ? (
            <div
              className="relative w-[10px] flex-1 overflow-hidden rounded-sm border border-[#262B3D] bg-[#08090D]"
              title="ERS Battery State of Charge"
            >
              <div
                className="absolute inset-x-0 bottom-0 transition-[height]"
                style={{
                  height: `${ers}%`,
                  backgroundColor: boost ? HUD_PURPLE : harvesting ? HUD_GREEN : HUD_VOLT,
                }}
              />
            </div>
          ) : (
            <div
              className="relative w-[10px] flex-1 overflow-hidden rounded-sm border border-[#262B3D] bg-[#08090D]"
              title="Engine RPM Band"
            >
              <div
                className="absolute inset-x-0 bottom-0"
                style={{
                  height: `${Math.min(100, (telemetry.rpm / revFull) * 100)}%`,
                  backgroundColor: flash ? HUD_RED : HUD_CYAN,
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Bottom Electronics, Aero & Hybrid Strip */}
      <div className="mt-2.5 flex items-center gap-1.5 border-t border-[#262B3D] pt-2">
        {channels && !hasAero ? (
          <>
            <AidLamp label="TC" active={channels.tcActive} />
            <AidLamp label="ABS" active={channels.absActive} />
          </>
        ) : (
          <button
            type="button"
            onClick={onToggleXMode}
            className="hud-num pointer-events-auto cursor-pointer rounded border px-2.5 py-1 text-[12px] tracking-wider transition-colors"
            style={{
              backgroundColor: aeroBg,
              color: aeroTextColor,
              borderColor: xMode ? HUD_CYAN : drs?.drsAvailable ? HUD_VOLT : "#262B3D",
            }}
            title={drs ? "DRS (X): opens in a DRS zone once its detection point is crossed" : "Active aero (X)"}
          >
            {drs ? (xMode ? "DRS OPEN" : drs.drsAvailable ? "DRS ARMED" : "DRS") : xMode ? "X-MODE" : "Z-MODE"}
          </button>
        )}

        {hasErs ? (
          <button
            type="button"
            onClick={onToggleBoostLatch}
            className="hud-num pointer-events-auto cursor-pointer rounded border px-2.5 py-1 text-[12px] tracking-wider transition-colors"
            style={{
              backgroundColor: boost ? HUD_PURPLE : "rgba(27, 31, 43, 0.9)",
              color: boost ? "#FFFFFF" : HUD_SLATE,
              borderColor: boost ? HUD_PURPLE : "#262B3D",
              boxShadow: boost ? `0 0 12px ${HUD_PURPLE}66` : "none",
            }}
            title="Manual override boost (Space / B)"
          >
            OVR BOOST
          </button>
        ) : null}

        {hasErs ? (
          <span className="ml-auto flex items-baseline gap-1.5">
            <span className="hud-label !text-[9px]">
              {harvesting ? "HARVEST" : deploying ? "DEPLOY" : "ERS SOC"}
            </span>
            <span
              className="hud-num text-[17px]"
              style={{
                color: boost ? HUD_PURPLE : deploying ? HUD_VOLT : harvesting ? HUD_GREEN : HUD_WHITE,
              }}
            >
              {ers.toFixed(0)}%
            </span>
          </span>
        ) : (
          <span className="ml-auto flex items-baseline gap-1.5">
            <span className="hud-label !text-[9px]">LON G</span>
            <span className="hud-num text-[16px] text-[#F5F7FA]">
              {telemetry.longitudinalG >= 0 ? "+" : "−"}
              {Math.abs(telemetry.longitudinalG).toFixed(1)}G
            </span>
          </span>
        )}
      </div>
    </div>
  );
};
