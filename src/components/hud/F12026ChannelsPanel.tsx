"use client";

import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import type { F12026Channels } from "@/types/f1";
import { Badge } from "@/components/ui/Badge";
import { ClassTag } from "@/components/ui/badges/ClassTag";
import { CLASSIC_CAR_IDS, HUD_CAUTION, HUD_GLASS, HUD_LBL, HUD_LOSS, HUD_SLATE, PROTO_CAR_IDS, HUD_WELL, ROAD_CAR_IDS } from "./hud-format";
import type { AeroReadout } from "./aero-label";

const WHEELS = ["LF", "RF", "LR", "RR"] as const;

/** Remaining travel to the bump rubber: loss once on the rubber (the reading goes negative), caution within 2 mm */
const bumpColor = (m: number) => (m < 0 ? HUD_LOSS : m < 0.002 ? HUD_CAUTION : HUD_SLATE);

/** Friction-circle use: fog while there is grip to spare, caution from 85 %, loss past the limit */
const circleColor = (f: number) => (f >= 1 ? HUD_LOSS : f >= 0.85 ? HUD_CAUTION : "var(--color-lc-fog)");

/** Driver-aid lamp, lit solid caution while the aid is intervening */
export const AidLamp: React.FC<{ label: string; active: boolean }> = ({ label, active }) => {
  const tx = useTranslations("hud.f12026ChannelsPanel");
  return (
    <Badge
      tone={active ? "warn" : "neutral"}
      variant={active ? "solid" : "soft"}
      size="md"
      icon={label === "ABS" ? "abs" : "tractionControl"}
      aria-label={active ? tx("aidIntervening", { aid: label }) : label}
    >
      {label}
    </Badge>
  );
};

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
  const tx = useTranslations("hud.f12026ChannelsPanel");
  // The panel redraws with every telemetry tick: its fixed words are resolved once per language
  const lbl = useMemo(
    () => ({
      region: tx("region"),
      wheels: [tx("wheels.lf"), tx("wheels.rf"), tx("wheels.lr"), tx("wheels.rr")],
      wheelTitles: [
        tx("wheelTitle", { wheel: tx("wheels.lf") }),
        tx("wheelTitle", { wheel: tx("wheels.rf") }),
        tx("wheelTitle", { wheel: tx("wheels.lr") }),
        tx("wheelTitle", { wheel: tx("wheels.rr") }),
      ],
      slipRatio: tx("slipRatio"),
      aeroHeightTitle: tx("aeroHeightTitle"),
      aeroHeight: tx("aeroHeight"),
      aeroBalanceTitle: tx("aeroBalanceTitle"),
      aeroBalance: tx("aeroBalance"),
      lsdTitle: tx("lsdTitle"),
      lsd: tx("lsd"),
      straightModeTitle: tx("straightModeTitle"),
      drsTitle: tx("drsTitle"),
      xMode: tx("xMode"),
      open: tx("drsState.open"),
      armed: tx("drsState.armed"),
      zone: tx("drsState.zone"),
      off: tx("drsState.off"),
      overtakeEarned: tx("overtakeEarned"),
      overtakeLocked: tx("overtakeLocked"),
      noVerdict: tx("noVerdict"),
      noDetection: tx("noDetection"),
      wall: tx("wall"),
    }),
    [tx],
  );
  const sr = [c.WHEEL_SR_LF, c.WHEEL_SR_RF, c.WHEEL_SR_LR, c.WHEEL_SR_RR];
  const bump = [c.BUMPSTOPUP_TRAVEL_LF, c.BUMPSTOPUP_TRAVEL_RF, c.BUMPSTOPUP_TRAVEL_LR, c.BUMPSTOPUP_TRAVEL_RR];
  const drsState = aero.open ? lbl.open : aero.armed ? lbl.armed : c.drsZone ? lbl.zone : lbl.off;

  return (
    <section aria-label={lbl.region} className={`w-[320px] rounded-lc-card px-3.5 py-3 ${HUD_GLASS}`} data-testid="f12026-channels">
      <div className="flex items-center justify-between gap-2">
        <ClassTag
          carClass={
            c.carId === "amg-gt3"
              ? "gt3"
              : ROAD_CAR_IDS.has(c.carId)
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
              title={lbl.wheelTitles[i]}
            >
              <div className="flex items-baseline justify-between">
                <span className={HUD_LBL}>{lbl.wheels[i]}</span>
                <span className="lc-data text-[11px] text-lc-chalk">
                  {(sr[i] * 100).toFixed(1)}
                  <span className="text-[9px] text-lc-slate"> {lbl.slipRatio}</span>
                </span>
                <span className="lc-data text-[10px]" style={{ color: bumpColor(bump[i]) }}>
                  {(bump[i] * 1000).toFixed(1)}
                  <span className="text-[9px] text-lc-slate"> mm</span>
                </span>
              </div>
              <span className="relative h-1.5 overflow-hidden rounded-full bg-lc-titanium">
                {/* Slid in from the left by transform (no layout every tick); the right end stays round */}
                <span
                  className="absolute inset-0 rounded-full"
                  style={{
                    transform: `translateX(${(Math.max(0, Math.min(1, frac)) - 1) * 100}%)`,
                    backgroundColor: circleColor(frac),
                  }}
                />
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <div className={`flex flex-col rounded-lc-nub px-2 py-1.5 ${HUD_WELL}`} title={lbl.aeroHeightTitle}>
          <span className={`${HUD_LBL} tracking-[0.1em]`}>{lbl.aeroHeight}</span>
          <span className="lc-data mt-0.5 text-[12px] text-lc-chalk">{(c.AERO_HEIGHT * 1000).toFixed(0)} mm</span>
        </div>
        <div
          className={`flex flex-col rounded-lc-nub px-2 py-1.5 ${HUD_WELL}`}
          title={lbl.aeroBalanceTitle}
        >
          <span className={`${HUD_LBL} tracking-[0.1em]`}>{lbl.aeroBalance}</span>
          <span className="lc-data mt-0.5 text-[12px] text-lc-info">{c.AERO_BALANCE.toFixed(1)}%</span>
        </div>
        <div className={`flex flex-col rounded-lc-nub px-2 py-1.5 ${HUD_WELL}`} title={lbl.lsdTitle}>
          <span className={`${HUD_LBL} tracking-[0.1em]`}>{lbl.lsd}</span>
          <span className="lc-data mt-0.5 text-[12px] text-lc-chalk">{Math.round(c.LSD_LOCKING_TORQUE)} Nm</span>
        </div>
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-lc-line pt-2">
        {c.hasDrs ? (
          <>
            <span className="flex items-center gap-1.5" title={aero.straightMode ? lbl.straightModeTitle : lbl.drsTitle}>
              <span className={HUD_LBL}>{aero.straightMode ? lbl.xMode : "DRS"}</span>
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
              {/* A 2026 car's flaps need no detection: the 1 s verdict there is Overtake Mode's (races only) */}
              {aero.straightMode
                ? c.overtakeDetection
                  ? c.overtakeDetection.earned
                    ? lbl.overtakeEarned
                    : lbl.overtakeLocked
                  : lbl.noVerdict
                : c.drsDetection
                  ? tx(c.drsDetection.eligible ? "zoneEarned" : "zoneLocked", { zone: c.drsDetection.zone })
                  : lbl.noDetection}
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
            {lbl.wall}
          </Badge>
        ) : null}
      </div>
    </section>
  );
};
