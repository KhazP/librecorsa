"use client";

import React from "react";
import type { F12026Channels } from "@/types/f1";
import { HUD_CYAN, HUD_GREEN, HUD_RED, HUD_VOLT, HUD_YELLOW } from "./hud-format";

const WHEELS = ["LF", "RF", "LR", "RR"] as const;

/** Remaining travel to the bump rubber: red once on the rubber, yellow within 2 mm */
const bumpColor = (m: number) => (m < 0 ? HUD_RED : m < 0.002 ? HUD_YELLOW : "#8E96AA");

/** Friction-circle use: green below 85 %, yellow to the limit, red past it */
const circleColor = (f: number) => (f >= 1 ? HUD_RED : f >= 0.85 ? HUD_YELLOW : HUD_GREEN);

/** Driver-aid lamp, lit while the aid is intervening */
export const AidLamp: React.FC<{ label: string; active: boolean }> = ({ label, active }) => (
  <span
    className="hud-num rounded border px-2 py-0.5 text-[11px] tracking-wider transition-colors"
    style={{
      backgroundColor: active ? HUD_YELLOW : "rgba(27, 31, 43, 0.9)",
      color: active ? "#08090D" : "#8E96AA",
      borderColor: active ? HUD_YELLOW : "#262B3D",
    }}
  >
    {label}
  </span>
);

/**
 * Live 6-DOF engineering telemetry channels: per-wheel slip ratio, travel left to the bump rubber and
 * friction-circle use, aero height / balance, LSD locking torque and DRS / TC / ABS state.
 */
export const F12026ChannelsPanel: React.FC<{ channels: F12026Channels }> = ({ channels: c }) => {
  const sr = [c.WHEEL_SR_LF, c.WHEEL_SR_RF, c.WHEEL_SR_LR, c.WHEEL_SR_RR];
  const bump = [c.BUMPSTOPUP_TRAVEL_LF, c.BUMPSTOPUP_TRAVEL_RF, c.BUMPSTOPUP_TRAVEL_LR, c.BUMPSTOPUP_TRAVEL_RR];
  const drsState = c.CHANGED_DRS_OPEN ? "OPEN" : c.drsAvailable ? "ARMED" : c.drsZone ? "ZONE" : "OFF";
  const drsColor = c.CHANGED_DRS_OPEN ? HUD_CYAN : c.drsAvailable ? HUD_VOLT : "rgba(255,255,255,0.22)";

  return (
    <div className="hud-panel w-[312px] rounded-lg px-3.5 py-2.5" data-testid="f12026-channels">
      <div className="flex items-center justify-between border-b border-[#262B3D] pb-1.5">
        <div className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: c.carId === "amg-gt3" ? HUD_CYAN : HUD_VOLT }}
          />
          <span className="hud-label !text-[#F5F7FA]">
            {c.carId === "amg-gt3" ? "AMG GT3 · CHANNELS" : "FA-26 · CHANNELS"}
          </span>
        </div>
        <span className="rounded bg-[#08090D] border border-[#262B3D] px-1.5 py-0.5 font-f1-mono text-[9px] font-bold uppercase text-[#CCFF00]">
          {c.performanceMode}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
        {WHEELS.map((name, i) => {
          const frac = c.circleFraction[i];
          return (
            <div
              key={name}
              className="flex flex-col gap-1 rounded bg-[#08090D] border border-[#262B3D] px-2 py-1"
              title={`WHEEL_SR_${name} · BUMPSTOPUP_TRAVEL_${name} · circleFraction`}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-f1-mono text-[9px] font-extrabold text-[#8E96AA]">{name}</span>
                <span className="hud-num text-[11px] text-[#F5F7FA]">
                  {(sr[i] * 100).toFixed(1)}
                  <span className="text-[8px] text-[#8E96AA]"> %SR</span>
                </span>
                <span className="hud-num text-[10px]" style={{ color: bumpColor(bump[i]) }}>
                  {(bump[i] * 1000).toFixed(1)}
                  <span className="text-[8px] text-[#8E96AA]"> mm</span>
                </span>
              </div>
              <span className="relative h-1.5 overflow-hidden rounded-full bg-white/10">
                <span
                  className="absolute inset-y-0 left-0 rounded-full"
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

      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <div className="flex flex-col rounded bg-[#08090D] border border-[#262B3D] px-2 py-1" title="AERO_HEIGHT">
          <span className="hud-label !text-[8px]">AERO HGT</span>
          <span className="hud-num mt-0.5 text-[12px] text-[#F5F7FA]">{(c.AERO_HEIGHT * 1000).toFixed(0)} mm</span>
        </div>
        <div
          className="flex flex-col rounded bg-[#08090D] border border-[#262B3D] px-2 py-1"
          title="AERO_BALANCE (front share of downforce)"
        >
          <span className="hud-label !text-[8px]">AERO BAL</span>
          <span className="hud-num mt-0.5 text-[12px] text-[#00E5FF]">{c.AERO_BALANCE.toFixed(1)}%</span>
        </div>
        <div className="flex flex-col rounded bg-[#08090D] border border-[#262B3D] px-2 py-1" title="LSD_LOCKING_TORQUE">
          <span className="hud-label !text-[8px]">LSD LOCK</span>
          <span className="hud-num mt-0.5 text-[12px] text-[#F5F7FA]">{Math.round(c.LSD_LOCKING_TORQUE)} Nm</span>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-[#262B3D] pt-1.5">
        {c.hasDrs ? (
          <>
            <span className="flex items-center gap-1.5" title="CHANGED_DRS_OPEN">
              <span className="hud-label !text-[9px]">DRS</span>
              <span
                className="hud-num rounded px-1.5 py-0.5 text-[10px]"
                style={{
                  backgroundColor: drsColor,
                  color: c.CHANGED_DRS_OPEN || c.drsAvailable ? "#08090D" : "#F5F7FA",
                }}
              >
                {drsState}
              </span>
              <span className="hud-num text-[10px] text-[#8E96AA]">×{c.drsOpenEvents}</span>
            </span>
            <span className="hud-label truncate !text-[9px]">
              {c.drsDetection
                ? `${c.drsDetection.zone} ${c.drsDetection.eligible ? "EARNED" : "LOCKED"}`
                : "NO DETECTION"}
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
