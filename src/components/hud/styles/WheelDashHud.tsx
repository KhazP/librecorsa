"use client";

import React from "react";
import { SessionBadge } from "@/components/ui/badges/SessionBadge";
import { useUnits } from "@/lib/settings/ui-prefs";
import {
  atShiftPoint,
  formatGap,
  formatLapTime,
  formatSectorTime,
  formatSpeed,
  HUD_BEST,
  HUD_GREEN,
  HUD_INFO,
  HUD_LOSS,
  HUD_RED,
  HUD_SHIFT,
  speedUnit,
} from "../hud-format";
import { TyreMini } from "../TyreBrakeWidget";
import {
  AeroBadge,
  anchor,
  arcPoints,
  DeltaReadout,
  deltaColor,
  gearLabel,
  HUD_GLASS,
  HUD_LBL,
  InvalidTag,
  LapMarkGlyph,
  MiniMap,
  raceNeighbours,
  useSectorFlash,
  type HudDesignProps,
} from "./hud-style-parts";
import { PedalBars } from "../PedalBars";
import { aeroReadout } from "../aero-label";

const LEDS = 15;
/** Green, red, then the shift colour: identity bands of the rev lights, not state */
const LED_COLORS = [...Array(5).fill(HUD_GREEN), ...Array(5).fill(HUD_RED), ...Array(5).fill(HUD_SHIFT)] as string[];
/** Shift lights along the top of the wheel screen, in a 320 × 52 box starting at x = 160 */
const LED_ARC = arcPoints(LEDS, 320, 300.2, 290.2, 56);

/** Rounded cell of the dash screen */
const Cell: React.FC<{ label: React.ReactNode; children: React.ReactNode; className?: string; tone?: string; style?: React.CSSProperties }> = ({
  label,
  children,
  className = "",
  tone,
  style,
}) => (
  <div
    className={`flex min-w-0 flex-col justify-between gap-1 rounded-lc-nub border border-lc-titanium bg-lc-well px-2.5 py-1.5 @max-[600px]:px-2 ${className}`}
    style={style}
  >
    <span className={HUD_LBL} style={tone ? { color: tone } : undefined}>
      {label}
    </span>
    {children}
  </div>
);

/** Slim pill bar inside a cell */
const Bar: React.FC<{ pct: number; color: string; className?: string }> = ({ pct, color, className = "h-1.5" }) => (
  <span className={`relative overflow-hidden rounded-full bg-lc-carbon ${className}`}>
    <span className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, backgroundColor: color }} />
  </span>
);


/** The steering-wheel screen: shift lights, gear, speed, delta, energy, pedals, tyres and brakes. Fills its parent's width. */
export const WheelDash: React.FC<Pick<HudDesignProps, "t" | "deltaS" | "revRange" | "lapInvalid">> = ({
  t,
  deltaS,
  revRange,
  lapInvalid,
}) => {
  const [revStart, revFull] = revRange;
  const lit = Math.round(Math.min(1, Math.max(0, (t.rpm - revStart) / (revFull - revStart))) * LEDS);
  const shift = atShiftPoint(t.rpm, revFull);
  const aero = aeroReadout(t);
  const units = useUnits();
  const flash = useSectorFlash(t);
  const nb = raceNeighbours(t);
  const hasErs = t.f12026?.hasErs ?? true;

  return (
    <section
      aria-label="Wheel dash"
      className="@container rounded-[96px_96px_24px_24px/48px_48px_24px_24px] border border-lc-keyline bg-lc-carbon px-3 pt-2.5 pb-2.5 shadow-lc-pop"
    >
      {/* Shift lights: all lit in the shift colour at the shift point (solid, never a strobe) */}
      <svg viewBox="160 0 320 52" className="mx-auto mb-1 block h-auto w-[40%]" aria-label={`Shift lights: ${shift ? LEDS : lit} of ${LEDS} lit`}>
        {LED_ARC.map(([x, y], i) => {
          const on = shift || i < lit;
          return <circle key={i} cx={x} cy={y} r={7.5} fill={on ? (shift ? HUD_SHIFT : LED_COLORS[i]) : "var(--color-lc-titanium)"} />;
        })}
      </svg>

      {/* Screen */}
      <div className="grid grid-cols-[1fr_112px_1fr] gap-1.5 rounded-lc-tile border border-lc-titanium bg-black p-1.5 @max-[600px]:grid-cols-[1fr_92px_1fr]">
        <div className="grid grid-rows-[1fr_auto] gap-1.5">
          <Cell label={`Speed · ${speedUnit(units)}`}>
            <span className="flex items-end justify-between gap-2">
              <PedalBars t={t} size="compact" showClutch={false} />
              <span className="lc-data text-[32px] leading-none text-lc-chalk @max-[600px]:text-[28px]">{formatSpeed(t.speedKmh, units)}</span>
            </span>
          </Cell>
          {hasErs ? (
            <Cell label="ERS · battery" tone={HUD_INFO}>
              <span className="lc-data flex items-center gap-2 text-[12px] @max-[600px]:text-[11px]">
                <span className="text-lc-chalk">{Math.round(t.ersBatteryPercent)}%</span>
                <Bar pct={t.ersBatteryPercent} color={HUD_INFO} className="h-1.5 flex-1" />
                <span className={t.mgukPowerKw > 0 ? "text-lc-info" : t.mgukPowerKw < 0 ? "text-lc-chalk" : "text-lc-slate"}>
                  {t.mgukPowerKw > 0 ? "DEP" : t.mgukPowerKw < 0 ? "HRV" : "Idle"}
                </span>
              </span>
            </Cell>
          ) : (
            <Cell label="Top speed">
              <span className="lc-data self-end text-[14px] text-lc-chalk">{Math.round(t.topSpeedThisLapKmh)}</span>
            </Cell>
          )}
        </div>

        <div className="flex flex-col items-center justify-between rounded-lc-row border border-lc-titanium bg-lc-well py-1.5">
          <span className={HUD_LBL}>Gear</span>
          <span className="lc-data text-[68px] leading-[0.9] @max-[600px]:text-[58px]" style={{ color: shift ? HUD_SHIFT : "var(--color-lc-chalk)" }}>
            {gearLabel(t.gear)}
          </span>
          {hasErs ? (
            <AeroBadge open={aero.open} armed={aero.armed} label={aero.label} />
          ) : (
            <span className="lc-data text-[10px] text-lc-slate">{Math.round(t.rpm)}</span>
          )}
        </div>

        <div className="grid grid-rows-[1fr_auto] gap-1.5">
          <Cell label="Delta" tone={deltaColor(deltaS)}>
            <span className="self-end" style={{ color: deltaColor(deltaS) }}>
              <DeltaReadout deltaS={deltaS} className="text-[32px] @max-[600px]:text-[28px]" />
            </span>
          </Cell>
          <div className="grid grid-cols-2 gap-1.5">
            <Cell
              label={flash ? (flash.sector ? `S${flash.sector}` : "Lap") : lapInvalid ? <InvalidTag /> : "Lap time"}
              tone={flash?.color}
              style={
                flash
                  ? {
                      borderColor: `color-mix(in srgb, ${flash.color} 50%, transparent)`,
                      backgroundColor: `color-mix(in srgb, ${flash.color} 8%, transparent)`,
                    }
                  : undefined
              }
            >
              <span
                className="lc-data flex items-center gap-1 text-[12px] whitespace-nowrap @max-[600px]:text-[11px]"
                style={{ color: flash?.color ?? (lapInvalid ? HUD_LOSS : "var(--color-lc-chalk)") }}
              >
                {flash ? (flash.sector ? formatSectorTime(flash.ms) : formatLapTime(flash.ms)) : formatLapTime(t.currentLapTimeMs)}
                {flash ? <LapMarkGlyph mark={flash.mark} /> : null}
              </span>
            </Cell>
            <div className="flex min-w-0 flex-col justify-center gap-1 rounded-lc-nub border border-lc-titanium bg-lc-well px-2.5 py-1.5 @max-[600px]:px-2">
              <span className="flex items-baseline justify-between gap-2">
                <span className={HUD_LBL}>Best</span>
                <span
                  className="lc-data text-[12px] whitespace-nowrap @max-[600px]:text-[11px]"
                  style={{ color: t.bestLapTimeMs ? HUD_BEST : "var(--color-lc-chalk)" }}
                >
                  {formatLapTime(t.bestLapTimeMs)}
                </span>
              </span>
              <span className="flex items-baseline justify-between gap-2">
                <span className={HUD_LBL}>{nb ? "Ahead" : "Last"}</span>
                <span className="lc-data text-[12px] whitespace-nowrap text-lc-chalk @max-[600px]:text-[11px]">
                  {nb ? (nb.ahead ? `+${formatGap(nb.ahead.gap, true)}` : "Lead") : formatLapTime(t.lastLapTimeMs)}
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Tyres, brakes, fuel */}
      <div className={`mt-1.5 grid gap-1.5 ${t.fuelKg > 0 ? "grid-cols-[1fr_auto]" : "grid-cols-1"}`}>
        <div className="grid grid-cols-4 gap-1.5">
          {[0, 1, 2, 3].map((i) => (
            <TyreMini key={i} t={t} i={i} />
          ))}
        </div>
        {t.fuelKg > 0 ? (
          <div className="flex items-center gap-1.5 rounded-lc-nub border border-lc-titanium bg-lc-well px-2">
            <span className={HUD_LBL}>Fuel</span>
            <span className="lc-data text-[12px] text-lc-chalk">{t.fuelKg.toFixed(1)} kg</span>
          </div>
        ) : null}
      </div>
    </section>
  );
};

/** Position / lap tag */
export const PositionTag: React.FC<{ t: HudDesignProps["t"] }> = ({ t }) => {
  const race = t.race;
  return (
    <div className={`flex items-center gap-2.5 rounded-full py-1.5 pr-4 pl-1.5 lc-mono ${HUD_GLASS}`}>
      {race ? (
        <span className="lc-data flex h-9 items-center rounded-full bg-lc-volt px-3 text-[18px] text-lc-void">P{race.position}</span>
      ) : (
        <SessionBadge session="practice" size="lg" />
      )}
      <span className="flex flex-col leading-[1.05]">
        <span className={HUD_LBL}>Lap</span>
        <span className="lc-data text-[18px] text-lc-chalk">
          {race ? `${race.lap}${race.totalLaps ? `/${race.totalLaps}` : ""}` : Math.max(1, t.lapCount)}
        </span>
      </span>
    </div>
  );
};

/**
 * Wheel Dash: the car's own steering-wheel display, centred low where a wheel's screen sits.
 * Shift lights across the top, the gear dead centre, delta and pace to the right, energy and
 * tyres below. Everything the engineer would show you in one place, nothing in the corners.
 */
export const WheelDashHud: React.FC<HudDesignProps> = ({ t, deltaS, map, revRange, scale, mfd, lapInvalid, mapMode, leftExtra, rightExtra }) => (
  <div className="pointer-events-none absolute inset-0 select-none">
    <div className="absolute top-[clamp(14px,2.2vw,24px)] left-[clamp(14px,2.2vw,24px)] flex flex-col items-start gap-2" style={anchor(scale, "top left")}>
      <PositionTag t={t} />
      {leftExtra ? <div className="w-[264px]">{leftExtra}</div> : null}
    </div>

    <div className="absolute top-[clamp(14px,2.2vw,24px)] right-[clamp(14px,2.2vw,24px)] hidden w-[180px] md:block" style={anchor(scale, "top right")}>
      <MiniMap map={map} t={t} local={mapMode === "local"} className="block h-[130px] w-full drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]" stroke={18} />
      {rightExtra ? <div className="mt-2">{rightExtra}</div> : null}
    </div>

    {mfd ? (
      <div className="absolute right-[clamp(14px,2.2vw,24px)] bottom-[clamp(14px,2.2vw,24px)] hidden lg:block" style={anchor(scale, "bottom right")}>
        {mfd}
      </div>
    ) : null}

    <div
      data-hud-avoid
      className="absolute bottom-[clamp(14px,2.2vw,24px)] left-1/2 w-[min(660px,calc(100vw-24px))] -translate-x-1/2"
      style={anchor(scale, "bottom center")}
    >
      <WheelDash t={t} deltaS={deltaS} revRange={revRange} lapInvalid={lapInvalid} />
    </div>
  </div>
);
