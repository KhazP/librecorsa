"use client";

import React from "react";
import type { F12026Channels } from "@/types/f1";
import { HUD_GREEN, HUD_RED, HUD_YELLOW } from "./hud-format";

const WHEELS = ["LF", "RF", "LR", "RR"] as const;

/** Remaining travel to the bump rubber: red once on the rubber, yellow within 2 mm */
const bumpColor = (m: number) => (m < 0 ? HUD_RED : m < 0.002 ? HUD_YELLOW : "rgba(255,255,255,0.45)");

/** Friction-circle use: green below 85 %, yellow to the limit, red past it */
const circleColor = (f: number) => (f >= 1 ? HUD_RED : f >= 0.85 ? HUD_YELLOW : HUD_GREEN);

/** Driver-aid lamp, lit while the aid is intervening */
export const AidLamp: React.FC<{ label: string; active: boolean }> = ({ label, active }) => (
  <span
    className="hud-num rounded px-1.5 py-0.5 text-[11px]"
    style={{
      backgroundColor: active ? HUD_YELLOW : "rgba(255,255,255,0.1)",
      color: active ? "#0B0B10" : "rgba(255,255,255,0.6)",
    }}
  >
    {label}
  </span>
);

/**
 * f12026-car live engineering telemetry channels: per-wheel slip ratio, travel left to the bump rubber and
 * friction-circle use, aero height / balance, LSD locking torque and the DRS state (TC / ABS activity on a car
 * without DRS, the GT3).
 */
export const F12026ChannelsPanel: React.FC<{ channels: F12026Channels }> = ({ channels: c }) => {
  const sr = [c.WHEEL_SR_LF, c.WHEEL_SR_RF, c.WHEEL_SR_LR, c.WHEEL_SR_RR];
  const bump = [c.BUMPSTOPUP_TRAVEL_LF, c.BUMPSTOPUP_TRAVEL_RF, c.BUMPSTOPUP_TRAVEL_LR, c.BUMPSTOPUP_TRAVEL_RR];
  const drsState = c.CHANGED_DRS_OPEN ? "OPEN" : c.drsAvailable ? "ARMED" : c.drsZone ? "ZONE" : "OFF";
  const drsColor = c.CHANGED_DRS_OPEN ? HUD_GREEN : c.drsAvailable ? "#FFFFFF" : "rgba(255,255,255,0.4)";

  return (
    <div className="hud-panel w-[300px] rounded-md px-3 py-2.5" data-testid="f12026-channels">
      <div className="flex items-baseline justify-between">
        <span className="hud-label !text-white">{c.carId === "amg-gt3" ? "AMG GT3" : "f12026-car"}</span>
        <span className="hud-label !text-[10px]">{c.performanceMode}</span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
        {WHEELS.map((name, i) => {
          const frac = c.circleFraction[i];
          return (
            <div
              key={name}
              className="flex flex-col gap-0.5"
              title={`WHEEL_SR_${name} · BUMPSTOPUP_TRAVEL_${name} (travel left to the bump rubber) · circleFraction`}
            >
              <div className="flex items-baseline justify-between">
                <span className="hud-label !text-[10px]">{name}</span>
                <span className="hud-num text-[12px] text-white">
                  {(sr[i] * 100).toFixed(1)}
                  <span className="text-[9px] text-white/50"> %SR</span>
                </span>
                <span className="hud-num text-[11px]" style={{ color: bumpColor(bump[i]) }}>
                  {(bump[i] * 1000).toFixed(1)}
                  <span className="text-[9px] text-white/50"> mm</span>
                </span>
              </div>
              <span className="relative h-1.5 overflow-hidden rounded bg-white/10">
                <span
                  className="absolute inset-y-0 left-0 rounded"
                  style={{
                    width: `${Math.min(100, frac * 100)}%`,
                    backgroundColor: circleColor(frac),
                  }}
                />
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 border-t border-white/10 pt-2">
        <div className="flex flex-col" title="AERO_HEIGHT">
          <span className="hud-label !text-[9px]">Aero height</span>
          <span className="hud-num text-[13px] text-white">{(c.AERO_HEIGHT * 1000).toFixed(0)} mm</span>
        </div>
        <div className="flex flex-col" title="AERO_BALANCE (front share of downforce)">
          <span className="hud-label !text-[9px]">Aero bal.</span>
          <span className="hud-num text-[13px] text-white">{c.AERO_BALANCE.toFixed(1)} %</span>
        </div>
        <div className="flex flex-col" title="LSD_LOCKING_TORQUE">
          <span className="hud-label !text-[9px]">LSD lock</span>
          <span className="hud-num text-[13px] text-white">{Math.round(c.LSD_LOCKING_TORQUE)} Nm</span>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/10 pt-2">
        {c.hasDrs ? (
          <>
            <span className="flex items-center gap-1.5" title="CHANGED_DRS_OPEN">
              <span className="hud-label !text-[10px]">DRS</span>
              <span
                className="hud-num rounded px-1.5 py-0.5 text-[11px] text-[#0B0B10]"
                style={{ backgroundColor: drsColor }}
              >
                {drsState}
              </span>
              <span className="hud-num text-[10px] text-white/45">×{c.drsOpenEvents}</span>
            </span>
            <span className="hud-label truncate !text-[9px]">
              {c.drsDetection
                ? `${c.drsDetection.zone} ${c.drsDetection.eligible ? "earned" : "not earned"}`
                : "no detection yet"}
            </span>
          </>
        ) : (
          <span className="flex items-center gap-1.5">
            <AidLamp label="TC" active={c.tcActive} />
            <AidLamp label="ABS" active={c.absActive} />
          </span>
        )}
        {c.wallContact ? (
          <span className="hud-num rounded px-1.5 py-0.5 text-[10px] text-white" style={{ backgroundColor: HUD_RED }}>
            WALL
          </span>
        ) : null}
      </div>
    </div>
  );
};
