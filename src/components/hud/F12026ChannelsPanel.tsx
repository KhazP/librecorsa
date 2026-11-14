"use client";

import React from "react";
import type { F12026Channels } from "@/types/f1";
import { Badge } from "@/components/ui/Badge";
import { ClassTag } from "@/components/ui/badges/ClassTag";
import { CLASSIC_CAR_IDS, HUD_CAUTION, HUD_GLASS, HUD_LBL, HUD_LOSS, HUD_SLATE, PROTO_CAR_IDS, HUD_WELL } from "./hud-format";
import type { AeroReadout } from "./aero-label";

const WHEELS = ["LF", "RF", "LR", "RR"] as const;

/** Remaining travel to the bump rubber: loss once on the rubber (the reading goes negative), caution within 2 mm */
const bumpColor = (m: number) => (m < 0 ? HUD_LOSS : m < 0.002 ? HUD_CAUTION : HUD_SLATE);

/** Friction-circle use: fog while there is grip to spare, caution from 85 %, loss past the limit */
const circleColor = (f: number) => (f >= 1 ? HUD_LOSS : f >= 0.85 ? HUD_CAUTION : "var(--color-lc-fog)");

/** Driver-aid lamp, lit (caution, with a live dot) while the aid is intervening */
export const AidLamp: React.FC<{ label: string; active: boolean }> = ({ label, active }) => (
  <Badge
    tone={active ? "warn" : "neutral"}
    variant={active ? "solid" : "soft"}
    size="md"
    dot={active ? "live" : undefined}
    icon={label === "ABS" ? "abs" : "tractionControl"}
    aria-label={`${label}${active ? ", intervening" : ""}`}
  >
    {label}
  </Badge>
);

/**
 * Live 6-DOF engineering telemetry channels: per-wheel slip ratio, travel left to the bump rubber and
 * friction-circle use, aero height / balance, LSD locking torque and DRS / TC / ABS state. The flap and aid states
 * come from the readings every other panel shows (`aeroReadout`, `aidsActive`), so they never disagree.
 */
export const F12026ChannelsPanel: React.FC<{
  channels: F12026Channels;
  aero: AeroReadout;
  aids: { tc: boolean; abs: boolean };
}> = ({ channels: c, aero, aids }) => {
  const sr = [c.WHEEL_SR_LF, c.WHEEL_SR_RF, c.WHEEL_SR_LR, c.WHEEL_SR_RR];
  const bump = [c.BUMPSTOPUP_TRAVEL_LF, c.BUMPSTOPUP_TRAVEL_RF, c.BUMPSTOPUP_TRAVEL_LR, c.BUMPSTOPUP_TRAVEL_RR];
  const drsState = aero.open ? "Open" : aero.armed ? "Armed" : c.drsZone ? "Zone" : "Off";

  return (
    <section aria-label="Engineering channels" className={`w-[320px] rounded-lc-card px-3.5 py-3 ${HUD_GLASS}`} data-testid="f12026-channels">
      <div className="flex items-center justify-between gap-2">
        <ClassTag
          carClass={
            c.carId === "amg-gt3"
              ? "gt3"
              : c.carId === "liana"
                ? "road"
                : PROTO_CAR_IDS.has(c.carId)
                  ? "proto"
                  : CLASSIC_CAR_IDS.has(c.carId)
                    ? "classic"
                    : "openWheel"
          }
          size="hud"
        />
        <Badge size="hud">{c.performanceMode}</Badge>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
        {WHEELS.map((name, i) => {
          const frac = c.circleFraction[i];
          return (
            <div
              key={name}
              className={`flex flex-col gap-1 rounded-lc-nub px-2 py-1.5 ${HUD_WELL}`}
              title={`${name}: slip ratio, travel left to the bump rubber, grip used`}
            >
              <div className="flex items-baseline justify-between">
                <span className={HUD_LBL}>{name}</span>
                <span className="lc-data text-[11px] text-lc-chalk">
                  {(sr[i] * 100).toFixed(1)}
                  <span className="text-[9px] text-lc-slate"> %SR</span>
                </span>
                <span className="lc-data text-[10px]" style={{ color: bumpColor(bump[i]) }}>
                  {(bump[i] * 1000).toFixed(1)}
                  <span className="text-[9px] text-lc-slate"> mm</span>
                </span>
              </div>
              <span className="relative h-1.5 overflow-hidden rounded-full bg-lc-titanium">
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
        <div className={`flex flex-col rounded-lc-nub px-2 py-1.5 ${HUD_WELL}`} title="Aero ride height">
          <span className={`${HUD_LBL} tracking-[0.1em]`}>Aero hgt</span>
          <span className="lc-data mt-0.5 text-[12px] text-lc-chalk">{(c.AERO_HEIGHT * 1000).toFixed(0)} mm</span>
        </div>
        <div
          className={`flex flex-col rounded-lc-nub px-2 py-1.5 ${HUD_WELL}`}
          title="Aero balance (front share of downforce)"
        >
          <span className={`${HUD_LBL} tracking-[0.1em]`}>Aero bal</span>
          <span className="lc-data mt-0.5 text-[12px] text-lc-info">{c.AERO_BALANCE.toFixed(1)}%</span>
        </div>
        <div className={`flex flex-col rounded-lc-nub px-2 py-1.5 ${HUD_WELL}`} title="Differential locking torque">
          <span className={`${HUD_LBL} tracking-[0.1em]`}>LSD lock</span>
          <span className="lc-data mt-0.5 text-[12px] text-lc-chalk">{Math.round(c.LSD_LOCKING_TORQUE)} Nm</span>
        </div>
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-lc-line pt-2">
        {c.hasDrs ? (
          <>
            <span className="flex items-center gap-1.5" title="DRS state and openings this session">
              <span className={HUD_LBL}>DRS</span>
              <Badge
                tone={aero.open || aero.armed ? "info" : "neutral"}
                variant={aero.open ? "solid" : aero.armed ? "outline" : "soft"}
                size="hud"
                icon={aero.open ? "drsOpen" : "drsClosed"}
              >
                {drsState}
              </Badge>
              <span className="lc-data text-[10px] text-lc-slate">×{c.drsOpenEvents}</span>
            </span>
            <span className={`${HUD_LBL} truncate`}>
              {c.drsDetection
                ? `${c.drsDetection.zone} ${c.drsDetection.eligible ? "EARNED" : "LOCKED"}`
                : "NO DETECTION"}
            </span>
          </>
        ) : (
          <span className="flex items-center gap-1.5">
            <AidLamp label="TC" active={aids.tc} />
            <AidLamp label="ABS" active={aids.abs} />
          </span>
        )}
        {c.wallContact ? (
          <Badge tone="bad" variant="solid" size="hud" icon="warning">
            Wall
          </Badge>
        ) : null}
      </div>
    </section>
  );
};
