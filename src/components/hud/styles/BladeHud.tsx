"use client";

import React, { useRef } from "react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { Icon } from "@/components/ui/icons/Icon";
import { Trend } from "@/components/ui/icons/Trend";
import { useUnits } from "@/lib/settings/ui-prefs";
import {
  HUD_CAUTION,
  HUD_INFO,
  HUD_LOSS,
  HUD_RED,
  HUD_SHIFT,
  LAP_MARK_COLOR,
  atShiftPoint,
  aidsActive,
  formatDeltaFit,
  formatLapClock,
  formatLapTime,
  formatSectorTime,
  formatSpeed,
  formatTemp,
  lapClockMs,
  lapMark,
  sectorDone,
  speedUnit,
  tyreHeatColor,
} from "../hud-format";
import { aeroReadout } from "../aero-label";
import { InputTrace } from "../InputTrace";
import { PedalBars, pedalLayers } from "../PedalBars";
import { ersButtons } from "../ers-buttons";
import { fuelLapsLeft, idealLapMs, predictedLapMs, sessionBestLapMs } from "../third-party-data";
import { revLights, useFuelPerLap } from "./third-party-parts";
import { useErsState, type ErsState } from "./game-style-parts";
import { anchor, gearLabel, type HudDesignProps, type HudStyleOptions } from "./hud-style-parts";
import { BLADE_W, CORNER_EDGE, DEEP, EDGE, HARD, LBL, LBL_TYPE, NONE, PLATE, scaleOf, useBladeFit, useBladeWords, useOwnWidth, type Words } from "./BladeParts";
import { BladeMap, BladeOrder } from "./BladeOrder";

/**
 * Blade, the default layout: one low slanted instrument across the bottom centre carries the whole car (tyres, fuel,
 * speed, the raised gear tile with the rev lights closing in on it, delta to the best lap, energy, electronics), and
 * the corners carry the race: a compact order window top left with the flag state in its header and the weather and
 * track-limits count in its footer, the circuit as bare numbered dots under it, and lap timing top right. Bottom left,
 * the driver's inputs (a short trace of throttle, brake and steering beside the pedal bars), or with a force-feedback
 * wheel its force meter, and both when the player's Input trace setting is on.
 * Hard plates only: no radius, no blur.
 */
export const BLADE_STYLE: HudStyleOptions = { bottomClearance: 176, ownsBottomLeft: true, mfdFolded: true, ownDeltaBar: true, ownTrace: true };

const REV_LEDS = 8;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Top right: lap timing                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

const TIME_TYPE = "lc-mono text-[11px] leading-none font-bold tracking-[0.18em] whitespace-nowrap uppercase";
const TIME_LBL = `${TIME_TYPE} text-lc-slate`;
const TIME_CELL = "flex items-baseline justify-between gap-2 border-t border-white/7 px-4 py-2";
const TIME_VAL = "lc-mono text-[16px] leading-none font-semibold whitespace-nowrap";

const LapTiming: React.FC<{ t: CarTelemetry; deltaS: number | null; lapInvalid: boolean; w: Words }> = ({ t, deltaS, lapInvalid, w }) => {
  const solo = !t.race;
  const sessionBest = sessionBestLapMs(t);
  const bestIsSession = t.bestLapTimeMs !== null && sessionBest !== null && t.bestLapTimeMs <= sessionBest + 0.5;
  const optimal = idealLapMs(t);
  const predicted = t.outLap ? null : predictedLapMs(t.bestLapTimeMs, deltaS);
  const clock = lapClockMs(t);
  // The running sector's own clock: the lap's, less the sectors already done
  let doneMs = 0;
  for (let i = 0; i < 3; i++) if (sectorDone(t, i)) doneMs += t.sectorTimesMs[i];
  const runningMs = Math.max(0, clock - doneMs);

  return (
    <section aria-label={w.timing} className={`w-full text-lc-chalk ${PLATE}`}>
      <div className="flex items-end justify-between gap-3 px-4 pt-[13px] pb-[11px]">
        <span className={`lc-mono text-[40px] leading-[0.9] font-semibold tracking-[-0.02em] whitespace-nowrap ${lapInvalid ? "text-lc-loss" : ""}`}>
          {formatLapClock(t)}
        </span>
        <span className="flex flex-col items-end gap-[7px] pb-px">
          <span className={TIME_LBL}>{w.lapTime}</span>
          {lapInvalid ? (
            <span className={`${TIME_TYPE} inline-flex items-center gap-1 text-lc-loss`}>
              <Icon name="trackLimits" size="xs" className="size-3" />
              {w.invalid}
            </span>
          ) : t.outLap && !t.race ? (
            <span className={TIME_LBL}>{w.outLap}</span>
          ) : deltaS !== null && deltaS < 0 && !t.outLap ? (
            <span className={`${TIME_TYPE} inline-flex items-center gap-1 text-lc-gain`}>
              <Trend direction="up" size={9} />
              {w.onPb}
            </span>
          ) : (
            <span className={TIME_LBL} aria-hidden>
              &nbsp;
            </span>
          )}
        </span>
      </div>
      <div className="grid grid-cols-2">
        <div className={`${TIME_CELL} border-r`}>
          <span className={TIME_LBL}>{w.last}</span>
          <b className={`${TIME_VAL} inline-flex items-center gap-1 ${t.lastLapValid === false ? "text-lc-loss" : ""}`}>
            {t.lastLapValid === false && t.lastLapTimeMs ? <Icon name="trackLimits" size="xs" label={w.invalid} className="size-3" /> : null}
            {formatLapTime(t.lastLapTimeMs)}
          </b>
        </div>
        <div className={TIME_CELL}>
          <span className={TIME_LBL}>{w.best}</span>
          <b className={`${TIME_VAL} ${t.bestLapTimeMs ? (bestIsSession ? "text-lc-best" : "text-lc-gain") : "text-lc-slate"}`}>{formatLapTime(t.bestLapTimeMs)}</b>
        </div>
        <div className={`${TIME_CELL} border-r`}>
          <span className={TIME_LBL}>{w.optimal}</span>
          <b className={`${TIME_VAL} ${optimal ? "" : "text-lc-slate"}`}>{formatLapTime(optimal)}</b>
        </div>
        <div className={TIME_CELL}>
          <span className={TIME_LBL}>{w.pred}</span>
          <b
            className={`${TIME_VAL} inline-flex items-center gap-1 ${
              predicted === null || deltaS === null ? "text-lc-slate" : deltaS <= 0 ? "text-lc-gain" : "text-lc-loss"
            }`}
          >
            {predicted !== null && deltaS !== null ? <Trend direction={deltaS <= 0 ? "up" : "down"} size={9} /> : null}
            {formatLapTime(predicted)}
          </b>
        </div>
      </div>
      <div className={`grid grid-cols-3 gap-0.5 border-t border-white/7 ${DEEP}`}>
        {[0, 1, 2].map((i) => {
          const done = sectorDone(t, i);
          const current = !t.outLap && i + 1 === t.currentSector;
          const ms = t.sectorTimesMs[i];
          const best = t.bestSectorTimesMs[i];
          const mark = done ? lapMark(ms, best, solo) : null;
          const color = mark ? LAP_MARK_COLOR[mark] : undefined;
          const tag = !mark
            ? w.sector[i]
            : mark === "best"
              ? w.sectorBest[i]
              : mark === "pb"
                ? w.sectorPb[i]
                : `${w.sector[i]} +${((ms - (best ?? ms)) / 1000).toFixed(2)}`;
          // How far through the running sector the car is, against its best time there
          const fill = current && best ? Math.min(1, runningMs / best) : 0;
          return (
            <div key={i} className="min-w-0 pb-[7px]">
              <i aria-hidden className="relative mb-[7px] block h-[5px] overflow-hidden bg-lc-titanium" style={color ? { backgroundColor: color } : undefined}>
                {current ? <u className="absolute inset-0 origin-left bg-lc-fog" style={{ transform: `scaleX(${fill.toFixed(3)})` }} /> : null}
              </i>
              <p className="flex items-baseline justify-between gap-1.5 px-2.5" style={color ? { color } : undefined}>
                <b className={`lc-mono text-[13px] leading-none font-semibold ${done || (current && clock > 0) ? "" : "text-lc-dim"}`}>
                  {done ? formatSectorTime(ms) : current && clock > 0 ? formatSectorTime(runningMs) : NONE}
                </b>
                <em className={`lc-mono text-[10px] leading-none font-extrabold tracking-[0.06em] whitespace-nowrap uppercase not-italic ${mark ? "" : "text-lc-slate"}`}>
                  {tag}
                </em>
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Bottom centre: the blade                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

const CELL = "relative flex min-w-0 flex-col justify-center px-4";
/** A cell of label, value and a bottom row: the labels share one top line, the bottom rows one bottom line */
const STACK = `${CELL} justify-start! pt-2.5 pb-2.5`;
const VAL = "lc-mono leading-none font-semibold";
const UNIT = "lc-mono text-[11px] leading-none font-semibold text-lc-slate uppercase";
/** The slanted hairline between two cells */
const Rule: React.FC = () => <i aria-hidden className="absolute top-3 bottom-3 left-0 w-px -skew-x-12 bg-white/12" />;

/** One lit rev light's colour and glow, kept per colour so a frame makes no new style */
const ledStyles = new Map<string, React.CSSProperties>();
function ledStyle(color: string): React.CSSProperties {
  let st = ledStyles.get(color);
  if (!st) {
    st = { backgroundColor: color, boxShadow: `0 0 10px color-mix(in srgb, ${color} 65%, transparent)` };
    ledStyles.set(color, st);
  }
  return st;
}

const LED_INDEX = Array.from({ length: REV_LEDS }, (_, i) => i);

const TyreCell: React.FC<{ t: CarTelemetry; compound: TireCompound; w: Words }> = ({ t, compound, w }) => {
  const units = useUnits();
  const window = t.tireOptimalTempC ?? ([85, 105] as const);
  const life = Math.max(0, Math.round(100 - Math.max(...t.tireWearPct)));
  const punctured = (t.race?.damage ?? t.practiceDamage)?.punctured;
  return (
    <div role="group" aria-label={w.tyres} className={`${CELL} flex-row! items-center justify-start! gap-3 pl-[30px]!`}>
      <div className="flex flex-col gap-[7px]">
        <span className="flex items-center gap-1.5">
          <CompoundGlyph compound={compound} size={17} />
          <b className="lc-mono text-[13px] leading-none font-bold whitespace-nowrap uppercase">{w.compound[compound]}</b>
        </span>
        <span className={`${LBL_TYPE} ${life < 25 ? "text-lc-loss" : life < 50 ? "text-lc-caution" : "text-lc-slate"}`}>{w.life(life)}</span>
      </div>
      <div className="grid grid-cols-[auto_auto] gap-x-[11px] gap-y-1.5">
        {t.tireTempsC.map((temp, i) => {
          // The damage lists its corners FR, FL, RR, RL; the temperatures go FL, FR, RL, RR
          const flat = Boolean(punctured?.[i ^ 1]);
          const heat = flat ? HUD_LOSS : tyreHeatColor(temp, window);
          // Inside the window the number stays chalk; outside it takes the bar's colour
          const out = flat || temp > window[1] || temp < window[0] - 25;
          const text = formatTemp(temp, units);
          return (
            <span
              key={i}
              aria-label={flat ? `${w.corners[i]}: ${w.punctured}` : w.tyre(w.corners[i], text)}
              className={`${VAL} flex items-center gap-1.5 text-[16px]`}
              style={out ? { color: heat } : undefined}
            >
              <i aria-hidden className="block h-[22px] w-[9px]" style={{ backgroundColor: heat }} />
              {flat ? <Icon name="puncture" size="xs" className="size-4" /> : text}
            </span>
          );
        })}
      </div>
    </div>
  );
};

const FuelCell: React.FC<{ t: CarTelemetry; w: Words }> = ({ t, w }) => {
  const perLap = useFuelPerLap();
  const laps = fuelLapsLeft(t.fuelKg, perLap);
  const race = t.race;
  // Laps of fuel beyond the flag, once a lap's use has been measured: the race's laps to go from where the car is
  const toGo = race && race.phase === "racing" && race.totalLaps ? Math.max(0, race.totalLaps - (race.lap - 1 + t.trackProgress)) : null;
  const margin = laps !== null && toGo !== null ? laps - toGo : null;
  const short = margin !== null ? margin < 0 : laps !== null && laps < 1;
  return (
    <div className={STACK}>
      <Rule />
      <span className={LBL}>{w.fuel}</span>
      <div className="mt-[7px] flex items-baseline gap-[5px]">
        <span className={`${VAL} text-[27px] ${short ? "text-lc-loss" : ""}`}>{t.fuelKg.toFixed(1)}</span>
        <span className={UNIT}>{w.kg}</span>
      </div>
      <div className="lc-mono mt-auto flex items-baseline gap-2 text-[11px] leading-none font-bold whitespace-nowrap uppercase">
        <span className={laps === null ? "text-lc-slate" : ""}>{w.fuelLaps(laps === null ? NONE : laps.toFixed(1))}</span>
        {margin !== null ? (
          <span className={margin < 0 ? "text-lc-loss" : "text-lc-gain"} title={w.fuelMargin}>
            {margin < 0 ? "−" : "+"}
            {Math.abs(margin).toFixed(1)}
          </span>
        ) : null}
      </div>
    </div>
  );
};

const SpeedCell: React.FC<{ t: CarTelemetry; w: Words }> = ({ t, w }) => {
  const units = useUnits();
  const aero = aeroReadout(t);
  // The flaps' state, while there is something to say: open, or armed or queued for the zone ahead (a car without the
  // channel still has flaps, and only reports them open)
  const showAero = (!t.f12026 || t.f12026.hasDrs) && t.overtakingRules !== "none" && (aero.open || aero.armed || aero.queued);
  return (
    <div className={`${CELL} items-end pr-[22px]!`} aria-label={w.speed}>
      <Rule />
      <span className={`${VAL} text-[52px] tracking-[-0.03em]`}>{formatSpeed(t.speedKmh, units)}</span>
      <div className="mt-[5px] flex items-center gap-2">
        {showAero ? (
          <span
            className={`lc-mono text-[10px] leading-none font-extrabold tracking-[0.08em] whitespace-nowrap uppercase ${
              aero.open ? "bg-lc-info px-1 py-0.5 text-lc-void" : "px-1 py-0.5 text-lc-info inset-ring inset-ring-lc-info"
            }`}
          >
            {aero.label}
          </span>
        ) : null}
        <span className={LBL}>{speedUnit(units)}</span>
      </div>
    </div>
  );
};

const DeltaCell: React.FC<{ deltaS: number | null; showBar: boolean; w: Words }> = ({ deltaS, showBar, w }) => {
  const known = deltaS !== null && Number.isFinite(deltaS);
  // ±1 s fills a side of the bar
  const side = known ? Math.min(1, Math.abs(deltaS)) : 0;
  return (
    <div className={`${STACK} pl-6!`}>
      <span className={LBL}>{w.deltaBest}</span>
      <span className={`${VAL} mt-[5px] text-[33px] tracking-[-0.02em] whitespace-nowrap ${!known ? "text-lc-slate" : deltaS <= 0 ? "text-lc-gain" : "text-lc-loss"}`}>
        {known ? formatDeltaFit(deltaS) : "--.---"}
      </span>
      {showBar ? (
        <div aria-hidden className="relative mt-auto h-1 w-28 bg-lc-titanium">
          {known && side > 0.004 ? (
            <i
              className={`absolute inset-y-0 w-1/2 ${deltaS <= 0 ? "right-1/2 origin-right bg-lc-gain" : "left-1/2 origin-left bg-lc-loss"}`}
              style={{ transform: `scaleX(${side.toFixed(3)})` }}
            />
          ) : null}
          <i className="absolute -top-[3px] left-1/2 h-2.5 w-px bg-lc-fog" />
        </div>
      ) : null}
    </div>
  );
};

const HARVESTING: ReadonlySet<ErsState> = new Set(["braking", "liftCoast", "superclip", "trickle"]);
const TAG = "lc-mono min-w-0 truncate text-[10px] leading-none font-extrabold tracking-[0.08em] uppercase";

/** The energy cell's tag: Overtake or the Boost as the driver has them, else what the store is doing */
const EnergyTag: React.FC<{ t: CarTelemetry; state: ErsState; w: Words }> = ({ t, state, w }) => {
  const ctl = ersButtons(t);
  const solid = `${TAG} bg-lc-info px-1 py-0.5 text-lc-void`;
  if (ctl.overtake === "lowGrip") return <span className={`${TAG} text-lc-caution`}>{w.lowGrip}</span>;
  if (ctl.overtake === "on" || ctl.overtake === "auto") {
    return (
      <span className={solid} title={w.overtakeOn}>
        {w.overtake}
      </span>
    );
  }
  if (ctl.boostOn) return <span className={solid}>{t.ersBoostActive !== undefined ? w.boost : w.overtake}</span>;
  if (ctl.overtake === "available") {
    return (
      <span className={`${TAG} px-1 py-0.5 text-lc-info inset-ring inset-ring-lc-info`} title={w.overtakeReady}>
        {w.overtake}
      </span>
    );
  }
  if (ctl.overtake === "locked" || ctl.boostLocked) {
    return (
      <span className={`${TAG} text-lc-dim line-through`} title={w.overtakeLocked}>
        {w.overtake}
      </span>
    );
  }
  if (state === "deploy" || state === "boost" || state === "overtake") return <span className={`${TAG} text-lc-info`}>{w.deploy}</span>;
  if (HARVESTING.has(state)) return <span className={`${TAG} text-lc-gain`}>{w.harvest}</span>;
  if (state === "clipped") return <span className={`${TAG} text-lc-caution`}>{w.clip}</span>;
  return null;
};

const EnergyCell: React.FC<{ t: CarTelemetry; w: Words }> = ({ t, w }) => {
  const state = useErsState(t);
  const soc = Math.min(1, Math.max(0, t.ersBatteryPercent / 100));
  const mode = t.liveTuner?.hasErs !== false ? t.liveTuner?.ersMode : undefined;
  const color = soc < 0.1 ? HUD_LOSS : soc < 0.2 ? HUD_CAUTION : HUD_INFO;
  return (
    <div className={STACK}>
      <Rule />
      <span className={`${LBL_TYPE} truncate text-lc-info`}>{mode ? (w.ersMode[mode] ?? w.ersModeRaw(mode)) : w.ers}</span>
      <div className="mt-[7px] flex items-baseline gap-[5px]">
        <span className={`${VAL} text-[27px]`}>{Math.round(t.ersBatteryPercent)}</span>
        <span className={UNIT}>%</span>
        <span className="ml-auto flex min-w-0 self-center">
          <EnergyTag t={t} state={state} w={w} />
        </span>
      </div>
      <div aria-hidden className="relative mt-auto h-[5px] overflow-hidden bg-lc-titanium">
        <i className="absolute inset-0 origin-left" style={{ backgroundColor: color, transform: `scaleX(${soc.toFixed(3)})` }} />
      </div>
    </div>
  );
};

/** A car without a hybrid: the engine speed takes the energy cell */
const RpmCell: React.FC<{ t: CarTelemetry; revFull: number; w: Words }> = ({ t, revFull, w }) => {
  const frac = Math.min(1, Math.max(0, t.rpm / Math.max(1, revFull)));
  const color = atShiftPoint(t.rpm, revFull) ? HUD_SHIFT : frac >= 0.94 ? HUD_RED : frac >= 0.86 ? HUD_CAUTION : "var(--color-lc-chalk)";
  return (
    <div className={STACK}>
      <Rule />
      <span className={LBL}>{w.rpm}</span>
      <div className="mt-[7px] flex items-baseline">
        <span className={`${VAL} text-[27px]`}>{Math.round(t.rpm)}</span>
      </div>
      <div aria-hidden className="relative mt-auto h-[5px] overflow-hidden bg-lc-titanium">
        <i className="absolute inset-0 origin-left" style={{ backgroundColor: color, transform: `scaleX(${frac.toFixed(3)})` }} />
      </div>
    </div>
  );
};

/** One dial of the electronics cell: its level, "off" for an aid the car is running without, a lit label while it cuts */
const Dial: React.FC<{ label: string; value: string | null; active?: boolean; title?: string; off: string }> = ({ label, value, active, title, off }) => (
  <span className="flex flex-col items-start gap-[7px]" title={active ? title : undefined}>
    <span className={active ? `${LBL_TYPE} -mx-1 -my-0.5 bg-lc-caution px-1 py-0.5 text-lc-void` : LBL}>{label}</span>
    {value === null ? (
      <span className="lc-mono text-[15px] leading-[22px] font-bold text-lc-slate uppercase">{off}</span>
    ) : (
      <span className={`${VAL} text-[22px] leading-[22px]! whitespace-nowrap`}>{value}</span>
    )}
  </span>
);

const ElectronicsCell: React.FC<{ t: CarTelemetry; w: Words }> = ({ t, w }) => {
  const tuner = t.liveTuner;
  const aids = aidsActive(t);
  return (
    <div className={`${CELL} flex-row! items-center justify-between! pr-[34px]! pl-[20px]!`}>
      <Rule />
      <Dial label={w.tc} value={!tuner ? NONE : tuner.tcLevel > 0 ? String(tuner.tcLevel) : null} active={aids.tc} title={w.cutting(w.tc)} off={w.off} />
      <Dial label={w.abs} value={!tuner ? NONE : tuner.absLevel > 0 ? String(tuner.absLevel) : null} active={aids.abs} title={w.cutting(w.abs)} off={w.off} />
      <Dial label={w.bias} value={tuner ? tuner.brakeBiasPct.toFixed(1) : NONE} off={w.off} />
      <Dial label={w.engineMap} value={tuner ? String(tuner.engineMap) : NONE} off={w.off} />
    </div>
  );
};

const Blade: React.FC<{
  t: CarTelemetry;
  deltaS: number | null;
  compound: TireCompound;
  revRange: [number, number];
  showDeltaBar: boolean;
  w: Words;
}> = ({ t, deltaS, compound, revRange, showDeltaBar, w }) => {
  const revFull = revRange[1];
  const shift = atShiftPoint(t.rpm, revFull);
  const lights = revLights(t.rpm, revRange, REV_LEDS);
  const hasErs = t.f12026?.hasErs !== false;
  const led = (i: number) => (
    <i key={i} className={`block h-2.5 w-[31px] -skew-x-12 ${lights.on(i) ? "" : "bg-lc-void/80"}`} style={lights.on(i) ? ledStyle(lights.color(i)) : undefined} />
  );
  return (
    <div role="group" aria-label={w.instrument} data-hud-avoid className="relative h-[132px] w-[1192px] text-lc-chalk">
      {/* Rev lights: two strips that fill from the ends in towards the gear */}
      <div aria-hidden className="absolute right-[calc(50%+62px)] bottom-[87px] flex gap-1">
        {LED_INDEX.map(led)}
      </div>
      <div aria-hidden className="absolute bottom-[87px] left-[calc(50%+72px)] flex flex-row-reverse gap-1">
        {LED_INDEX.map(led)}
      </div>

      <div
        className={`absolute inset-x-0 bottom-0 grid h-20 grid-cols-[238px_150px_152px_112px_152px_162px_226px] [clip-path:polygon(17px_0,100%_0,calc(100%-17px)_100%,0_100%)] ${PLATE}`}
      >
        <TyreCell t={t} compound={compound} w={w} />
        <FuelCell t={t} w={w} />
        <SpeedCell t={t} w={w} />
        <div />
        <DeltaCell deltaS={deltaS} showBar={showDeltaBar} w={w} />
        {hasErs ? <EnergyCell t={t} w={w} /> : <RpmCell t={t} revFull={revFull} w={w} />}
        <ElectronicsCell t={t} w={w} />
      </div>

      {/* The gear: a raised slanted tile, volt, the shift colour at the shift point */}
      <div
        role="img"
        aria-label={w.gear(gearLabel(t.gear))}
        className={`absolute bottom-0 left-1/2 z-[2] -ml-[58px] grid h-[132px] w-[116px] -skew-x-12 place-items-center text-lc-void ${shift ? "bg-lc-cyan" : "bg-lc-volt"}`}
      >
        <b className="lc-disp -mt-0.5 skew-x-12 text-[116px] leading-none">{gearLabel(t.gear)}</b>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Bottom left: the driver's inputs                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The trace's width (px): the panel comes out as wide as the MFD's in the other corner */
const INPUTS_TRACE_W = 216;

/**
 * Throttle, brake and steering over the last five seconds, the pedal bars beside them (what TC and ABS cut, striped),
 * on a plate: how smooth a controller's triggers and stick really are, which a wheel's force meter cannot say
 */
const BladeInputs: React.FC<{ t: CarTelemetry }> = ({ t }) => {
  const p = pedalLayers(t);
  return (
    <div className={`px-3.5 pt-2.5 pb-3 ${PLATE}`}>
      <InputTrace
        frameless
        width={INPUTS_TRACE_W}
        sample={{
          throttle: t.throttle,
          brake: t.brake,
          steering: t.steering,
          steerInput: t.steerInput,
          throttleOut: p.throttleOut,
          brakeOut: p.brakeOut,
        }}
        steerLockDeg={t.steerLockDeg}
        aside={<PedalBars t={t} showFfb={false} showClutch={false} />}
      />
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */

export const BladeHud: React.FC<HudDesignProps> = ({
  t,
  deltaS,
  map,
  compound = "soft",
  revRange,
  scale,
  mfd,
  channels,
  ffb,
  touch,
  lapInvalid,
  towerGaps,
  mapMode,
  leftExtra,
  weather,
  showDeltaBar,
  showTrace,
}) => {
  const w = useBladeWords();
  const { s, half } = useBladeFit(scale);
  const [leftRef, leftW] = useOwnWidth();
  const inputs = !ffb || Boolean(showTrace);
  const [rightRef, rightW] = useOwnWidth();
  const centre = anchor(s, "bottom center");
  const left = anchor(s, "bottom left");
  const right = anchor(s, "bottom right");
  // A panel in a bottom corner sits beside the blade where there is the room for it at the sizes the player has set
  // (the blade's end slants away from a low panel, so touching widths still leave a gap), else above the blade's bar
  const bladeK = scaleOf(centre);
  const beside = useRef({ left: true, right: true });
  const cornerBottom = (side: "left" | "right", width: number, style: React.CSSProperties) => {
    // 8 px either way of the limit keeps a panel whose width breathes (the MFD's status line) from hopping up and down
    const spare = half - (BLADE_W / 2) * bladeK - width * scaleOf(style);
    beside.current[side] = spare >= (beside.current[side] ? -8 : 8);
    return beside.current[side] ? EDGE : `calc(${EDGE} + ${Math.round(108 * bladeK)}px)`;
  };

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/* Top left: the order window, the circuit under it, then the split gaps, damage and lap board */}
      <div className="absolute flex w-[408px] flex-col items-start" style={{ top: EDGE, left: EDGE, ...anchor(s, "top left") }}>
        <BladeOrder t={t} w={w} compound={compound} lapInvalid={lapInvalid} gaps={towerGaps === "leader" ? "leader" : "you"} weather={weather} />
        <BladeMap map={map} t={t} local={mapMode === "local"} label={w.map} className="mt-6 ml-2" />
        {leftExtra ? <div className={`mt-3 flex w-full flex-col gap-2 ${HARD}`}>{leftExtra}</div> : null}
      </div>

      {/* Top right: lap timing. The weather is in the order window's footer, so the shared weather panel is not drawn */}
      <div className="absolute flex w-[392px] flex-col items-end" style={{ top: EDGE, right: EDGE, ...anchor(s, "top right") }}>
        <LapTiming t={t} deltaS={deltaS} lapInvalid={lapInvalid} w={w} />
      </div>

      {/* Bottom left: the driver's inputs without a force-feedback wheel (or with the Input trace setting on), the
          wheel's force meter with one; under the touch controls, their steering pad's */}
      {!touch && (ffb || inputs) ? (
        <div ref={leftRef} className={`absolute flex flex-col items-start gap-2 ${HARD}`} style={{ bottom: cornerBottom("left", leftW, left), left: CORNER_EDGE, ...left }}>
          {inputs ? <BladeInputs t={t} /> : null}
          {ffb}
        </div>
      ) : null}

      {/* Bottom centre: the blade */}
      <div className="absolute left-1/2 -translate-x-1/2" style={{ bottom: EDGE, ...centre }}>
        <Blade t={t} deltaS={deltaS} compound={compound} revRange={revRange} showDeltaBar={showDeltaBar !== false} w={w} />
      </div>

      {/* Bottom right: the MFD (folded to its status line until opened) and the engineering channels */}
      {mfd || channels ? (
        <div ref={rightRef} className={`absolute flex flex-col items-end gap-2 ${HARD}`} style={{ bottom: cornerBottom("right", rightW, right), right: CORNER_EDGE, ...right }}>
          {mfd}
          {channels}
        </div>
      ) : null}
    </div>
  );
};
