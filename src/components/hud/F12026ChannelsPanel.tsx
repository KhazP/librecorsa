"use client";

import React from "react";
import type { F12026Channels } from "@/types/f1";
import { HUD_CYAN, HUD_GLASS, HUD_GREEN, HUD_LBL, HUD_RED, HUD_VOLT, HUD_WELL, HUD_YELLOW } from "./hud-format";

const WHEELS = ["LF", "RF", "LR", "RR"] as const;

/** Remaining travel to the bump rubber: red once on the rubber, yellow within 2 mm */
const bumpColor = (m: number) => (m < 0 ? HUD_RED : m < 0.002 ? HUD_YELLOW : "#8E96AA");

/** Friction-circle use: green below 85 %, yellow to the limit, red past it */
const circleColor = (f: number) => (f >= 1 ? HUD_RED : f >= 0.85 ? HUD_YELLOW : HUD_GREEN);

/** Driver-aid lamp, lit while the aid is intervening */
export const AidLamp: React.FC<{ label: string; active: boolean }> = ({ label, active }) => (
  <span
    className="lc-data inline-flex h-6 items-center rounded-full px-2.5 text-[11px] transition-colors"
    style={{
      backgroundColor: active ? HUD_YELLOW : "#1B1F2B",
      color: active ? "#08090D" : "#8E96AA",
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
    <section aria-label="Engineering channels" className={`w-[320px] rounded-[22px] px-3.5 py-3 ${HUD_GLASS}`} data-testid="f12026-channels">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className="h-[7px] w-[7px] rounded-full"
            style={{ backgroundColor: c.carId === "amg-gt3" ? HUD_CYAN : HUD_VOLT }}
          />
          <span className="lc-data text-[11px] tracking-[0.12em] text-[#F5F7FA]">
            {c.carId === "amg-gt3" ? "AMG GT3 · CHANNELS" : "FA-26 · CHANNELS"}
          </span>
        </div>
        <span className="lc-data rounded-full bg-[#1B1F2B] px-2 py-0.5 text-[9px] uppercase text-[#CCFF00]">
          {c.performanceMode}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
        {WHEELS.map((name, i) => {
          const frac = c.circleFraction[i];
          return (
            <div
              key={name}
              className={`flex flex-col gap-1 rounded-[12px] px-2 py-1.5 ${HUD_WELL}`}
              title={`WHEEL_SR_${name} · BUMPSTOPUP_TRAVEL_${name} · circleFraction`}
            >
              <div className="flex items-baseline justify-between">
                <span className={HUD_LBL}>{name}</span>
                <span className="lc-data text-[11px] text-[#F5F7FA]">
                  {(sr[i] * 100).toFixed(1)}
                  <span className="text-[8px] text-[#8E96AA]"> %SR</span>
                </span>
                <span className="lc-data text-[10px]" style={{ color: bumpColor(bump[i]) }}>
                  {(bump[i] * 1000).toFixed(1)}
                  <span className="text-[8px] text-[#8E96AA]"> mm</span>
                </span>
              </div>
              <span className="relative h-1.5 overflow-hidden rounded-full bg-[#1B1F2B]">
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
        <div className={`flex flex-col rounded-[12px] px-2 py-1.5 ${HUD_WELL}`} title="AERO_HEIGHT">
          <span className={`${HUD_LBL} !text-[8px]`}>AERO HGT</span>
          <span className="lc-data mt-0.5 text-[12px] text-[#F5F7FA]">{(c.AERO_HEIGHT * 1000).toFixed(0)} mm</span>
        </div>
        <div
          className={`flex flex-col rounded-[12px] px-2 py-1.5 ${HUD_WELL}`}
          title="AERO_BALANCE (front share of downforce)"
        >
          <span className={`${HUD_LBL} !text-[8px]`}>AERO BAL</span>
          <span className="lc-data mt-0.5 text-[12px] text-[#00E5FF]">{c.AERO_BALANCE.toFixed(1)}%</span>
        </div>
        <div className={`flex flex-col rounded-[12px] px-2 py-1.5 ${HUD_WELL}`} title="LSD_LOCKING_TORQUE">
          <span className={`${HUD_LBL} !text-[8px]`}>LSD LOCK</span>
          <span className="lc-data mt-0.5 text-[12px] text-[#F5F7FA]">{Math.round(c.LSD_LOCKING_TORQUE)} Nm</span>
        </div>
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-[#262B3D] pt-2">
        {c.hasDrs ? (
          <>
            <span className="flex items-center gap-1.5" title="CHANGED_DRS_OPEN">
              <span className={HUD_LBL}>DRS</span>
              <span
                className="lc-data rounded-full px-2 py-0.5 text-[10px]"
                style={{
                  backgroundColor: drsColor,
                  color: c.CHANGED_DRS_OPEN || c.drsAvailable ? "#08090D" : "#F5F7FA",
                }}
              >
                {drsState}
              </span>
              <span className="lc-data text-[10px] text-[#8E96AA]">×{c.drsOpenEvents}</span>
            </span>
            <span className={`${HUD_LBL} truncate`}>
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
          <span className="lc-data rounded-full px-2 py-0.5 text-[10px] text-[#F5F7FA]" style={{ backgroundColor: HUD_RED }}>
            WALL
          </span>
        ) : null}
      </div>
    </section>
  );
};
