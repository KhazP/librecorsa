"use client";

import React from "react";
import type { CarTelemetry } from "@/types/f1";
import { Badge } from "@/components/ui/Badge";
import { ClassTag } from "@/components/ui/badges/ClassTag";
import { useUnits } from "@/lib/settings/ui-prefs";
import {
  aidsActive,
  atShiftPoint,
  formatSpeed,
  revRangeFor,
  speedUnit,
  HUD_BRAKE,
  PROTO_CAR_IDS,
  CLASSIC_CAR_IDS,
  HUD_GLASS,
  HUD_GREEN,
  HUD_INFO,
  HUD_LBL,
  HUD_LOSS,
  HUD_RED,
  HUD_SHIFT,
  HUD_THROTTLE,
  HUD_VOLT,
  HUD_WHITE,
  HUD_YELLOW,
} from "./hud-format";
import { AidLamp } from "./F12026ChannelsPanel";
import { aeroReadout } from "./aero-label";
import { AeroBadge } from "./styles/hud-style-parts";

/** Rev lights: 15 LEDs over the top end of the rev range (green, amber, red; all in the shift colour at the shift point) */
const REV_LEDS = 15;
const LED_INDEXES = Array.from({ length: REV_LEDS }, (_, i) => i);

const ledColor = (i: number) => (i < 5 ? HUD_GREEN : i < 10 ? HUD_YELLOW : i < 13 ? HUD_RED : HUD_SHIFT);

interface SpeedClusterProps {
  telemetry: CarTelemetry;
  /** The player's boost latch. The button shows what the physics reports (`manualOverrideActive`), not the request */
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
    <span className={`relative w-1.75 overflow-hidden rounded-full bg-lc-titanium ${h}`}>
      <span className="absolute inset-x-0 bottom-0" style={{ height: `${pct}%`, backgroundColor: color }} />
    </span>
    <span className={HUD_LBL} style={labelColor ? { color: labelColor } : undefined}>
      {label}
    </span>
  </span>
);

/** Bottom-right LibreCorsa MoTeC-style digital dash pod: rev lights, gear, speed, pedals/FFB, ERS and aero state */
export const SpeedCluster: React.FC<SpeedClusterProps> = ({
  telemetry,
  onToggleBoostLatch,
  onToggleXMode,
  variant = "full",
}) => {
  const channels = telemetry.f12026;
  const isGt3 = channels?.carId === "amg-gt3";
  const isRoad = channels?.carId === "liana";
  const isProto = PROTO_CAR_IDS.has(channels?.carId ?? "");
  const isClassic = CLASSIC_CAR_IDS.has(channels?.carId ?? "");
  const [revStart, revFull] = revRangeFor(channels?.carId);
  const hasErs = channels?.hasErs ?? true;
  const lit = Math.round(((telemetry.rpm - revStart) / (revFull - revStart)) * REV_LEDS);
  const flash = atShiftPoint(telemetry.rpm, revFull);
  const gear = telemetry.gear === 0 ? "N" : telemetry.gear < 0 ? "R" : String(telemetry.gear);
  // The flaps as every panel names them (era from the car's overtaking rules, "armed" from its DRS channel)
  const aero = aeroReadout(telemetry);
  const xMode = aero.open;
  // A 2026 car opens both flaps in every zone (X-mode) and earns Overtake; an older one has the rear-flap DRS
  const straightMode = telemetry.overtakingRules === "straight-mode-2026";
  const hasAero = !channels || channels.hasDrs;
  const aids = aidsActive(telemetry);

  /** In a race a 2026 car's override (Overtake Mode) is only there once earned within 1 s at the detection point */
  const overtakeLocked = straightMode && telemetry.overtakeAvailable === false;
  // What the physics reports, with locked first: a latch the physics refuses never lights the button
  const boost = !overtakeLocked && telemetry.manualOverrideActive;
  const ers = Math.max(0, Math.min(100, telemetry.ersBatteryPercent));
  const deploying = telemetry.mgukPowerKw > 5;
  const harvesting = telemetry.mgukPowerKw < -5;
  const ffbPct = Math.min(100, Math.abs(telemetry.ffbTorqueNorm ?? 0) * 100);
  const units = useUnits();
  const speed = formatSpeed(telemetry.speedKmh, units);
  const latG = Math.abs(telemetry.lateralG).toFixed(1);

  // Energy going out (deploy, boost) is information; harvesting and the plain charge are chalk
  const ersColor = boost || deploying ? HUD_INFO : HUD_WHITE;
  const ersLabel = harvesting ? "Harvest" : deploying ? "Deploy" : "ERS SOC";

  const leds = (cls: string) =>
    LED_INDEXES.map((i) => {
      const active = flash || i < lit;
      return (
        <span
          key={i}
          className={`flex-1 rounded-full bg-white/7 transition-colors duration-75 ${cls}`}
          style={active ? { backgroundColor: flash ? HUD_SHIFT : ledColor(i) } : undefined}
        />
      );
    });

  /** Aero / aids, boost and battery (or longitudinal G) controls shared by both layouts */
  const controls = (
    <>
      {channels && !hasAero ? (
        <>
          <AidLamp label="TC" active={aids.tc} />
          <AidLamp label="ABS" active={aids.abs} />
        </>
      ) : (
        <button
          type="button"
          onClick={onToggleXMode}
          className="pointer-events-auto cursor-pointer rounded-full outline-none focus-visible:shadow-lc-focus pointer-coarse:py-2.5"
          aria-label={`${aero.label}: toggle`}
          title={
            telemetry.overtakingRules === "drs-rear"
              ? "DRS (X): rear flap, in a DRS zone; in a race only within 1 s of the car ahead at the detection point, from lap 3"
              : "Straight Mode (X): both flaps open in any DRS zone"
          }
        >
          <AeroBadge open={aero.open} armed={aero.armed} label={aero.label} size="md" />
        </button>
      )}
      {hasErs ? (
        <button
          type="button"
          onClick={onToggleBoostLatch}
          className={`pointer-events-auto cursor-pointer rounded-full outline-none focus-visible:shadow-lc-focus pointer-coarse:py-2.5 ${
            overtakeLocked ? "opacity-40" : ""
          }`}
          aria-pressed={boost}
          title={
            straightMode
              ? overtakeLocked
                ? "Overtake Mode (Space / B): earned within 1 s of the car ahead at the detection point, for the next lap"
                : "Overtake Mode (Space / B)"
              : "Manual override boost (Space / B)"
          }
        >
          <Badge tone={boost ? "info" : "neutral"} variant={boost ? "solid" : "soft"} size="md" icon="overtake">
            {straightMode ? "Overtake" : "Boost"}
          </Badge>
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
      <span className="lc-data text-[16px] leading-none text-lc-chalk">
        {telemetry.longitudinalG >= 0 ? "+" : "\u2212"}
        {Math.abs(telemetry.longitudinalG).toFixed(1)} g
      </span>
    </span>
  );

  const inputBars = (h: string) => (
    <div className="flex items-end gap-[5px]" aria-label="Brake, throttle, force">
      <InputBar label="B" pct={telemetry.brake * 100} color={HUD_BRAKE} title="Brake input" h={h} />
      <InputBar label="T" pct={telemetry.throttle * 100} color={HUD_THROTTLE} title="Throttle input" h={h} />
      <InputBar
        label={telemetry.ffbClipping ? "Clip" : "F"}
        pct={ffbPct}
        color={telemetry.ffbClipping ? HUD_LOSS : HUD_INFO}
        labelColor={telemetry.ffbClipping ? HUD_LOSS : undefined}
        title="Steering Torque / Force Feedback (Red = Clipping)"
        h={h}
      />
    </div>
  );

  const gearRing = flash ? HUD_SHIFT : xMode ? HUD_INFO : HUD_VOLT;

  if (variant === "minimal") {
    return (
      <div className="flex flex-col items-end gap-2">
        {/* Slim status strip: rev lights, rpm, aero / boost and battery */}
        <div className={`flex items-center gap-2 rounded-full py-1.5 pr-3 pl-2 ${HUD_GLASS}`}>
          {controls}
          <span className="flex w-22.5 gap-0.5 rounded-full bg-lc-well p-1" aria-label={`Shift lights: ${Math.max(0, Math.min(REV_LEDS, lit))} of ${REV_LEDS}`}>
            {leds("h-1.5")}
          </span>
          {readout}
        </div>
        <section aria-label="Speed and gear" className={`flex items-center gap-4.5 rounded-full py-2.5 pr-2.5 pl-6 ${HUD_GLASS}`}>
          {inputBars("h-13")}
          <div className="flex flex-col items-end">
            <span className="lc-data text-[52px] leading-[0.9] tracking-[-0.02em] text-lc-chalk">{speed}</span>
            <span className={HUD_LBL}>
              {speedUnit(units)} · {Math.round(telemetry.rpm)} rpm · {latG} g
            </span>
          </div>
          <span
            className="flex size-19 items-center justify-center rounded-full text-lc-void transition-colors"
            style={{ backgroundColor: gearRing }}
            aria-label={`Gear ${gear}`}
          >
            <span className="lc-disp text-[52px] leading-none">{gear}</span>
          </span>
        </section>
      </div>
    );
  }

  return (
    <section aria-label="Speed cluster" className={`w-[320px] rounded-lc-card px-3.5 py-3 ${HUD_GLASS}`}>
      {/* Car badge, shift call and rpm */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <ClassTag carClass={isGt3 ? "gt3" : isRoad ? "road" : isProto ? "proto" : isClassic ? "classic" : "openWheel"} variant="solid" size="hud" />
          {flash ? (
            <Badge tone={{ color: "cyan" }} variant="solid" size="hud" icon="shiftUp">
              Shift
            </Badge>
          ) : null}
        </div>
        <span className="lc-data text-[13px] text-lc-chalk">
          {Math.round(telemetry.rpm)} <span className={HUD_LBL}>rpm</span>
        </span>
      </div>

      {/* 15-LED shift lights */}
      <div
        className="my-2.5 flex gap-1 rounded-full bg-lc-well px-2 py-1.5"
        aria-label={`Shift lights: ${Math.max(0, Math.min(REV_LEDS, lit))} of ${REV_LEDS}`}
      >
        {leds("h-2")}
      </div>

      {/* Inputs | speed | gear | battery */}
      <div className="flex items-center gap-3.5">
        {inputBars("h-16")}

        <div className="flex min-w-0 flex-1 flex-col items-end">
          <span className="lc-data text-[58px] leading-[0.9] tracking-[-0.02em] text-lc-chalk">{speed}</span>
          <span className={HUD_LBL}>
            <span className="text-lc-chalk">{speedUnit(units)}</span> · {latG} g lat
          </span>
        </div>

        <div
          className="flex h-20 w-17.5 flex-none flex-col items-center justify-center rounded-lc-card border-2 bg-lc-well transition-colors"
          style={{ borderColor: gearRing }}
        >
          <span className={HUD_LBL}>Gear</span>
          <span className="lc-data text-[48px] leading-none text-lc-chalk">{gear}</span>
        </div>

        {hasErs ? (
          <span
            className="relative h-20 w-2.5 flex-none overflow-hidden rounded-full bg-lc-titanium"
            title="ERS battery charge"
          >
            {/* Scales from the bottom (transform only, so the bar never re-lays out) */}
            <span
              className="absolute inset-0 origin-bottom bg-lc-info transition-transform"
              style={{ transform: `scaleY(${ers / 100})` }}
            />
          </span>
        ) : (
          <span className="relative h-20 w-2.5 flex-none overflow-hidden rounded-full bg-lc-titanium" title="Engine RPM Band">
            <span
              className="absolute inset-x-0 bottom-0"
              style={{
                height: `${Math.min(100, (telemetry.rpm / revFull) * 100)}%`,
                backgroundColor: flash ? HUD_SHIFT : HUD_INFO,
              }}
            />
          </span>
        )}
      </div>

      {/* Aero / aids, boost and battery */}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-lc-line pt-2.5">
        <span className="flex items-center gap-1.5">{controls}</span>
        {readout}
      </div>
    </section>
  );
};
