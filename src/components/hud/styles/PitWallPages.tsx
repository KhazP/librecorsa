"use client";

import React, { useState } from "react";
import type { CarTelemetry, PlayerDamageStatus, TireCompound } from "@/types/f1";
import { Icon } from "@/components/ui/icons/Icon";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { useUnits } from "@/lib/settings/ui-prefs";
import { temperatureIn } from "@/lib/settings/units";
import {
  aidsActive,
  formatGap,
  formatLapTime,
  formatPressureDeltaPsi,
  formatPressurePsi,
  formatSectorTime,
  formatSpeed,
  formatTemp,
  pressureUnit,
  speedUnit,
} from "../hud-format";
import { aeroReadout } from "../aero-label";
import { ersButtons } from "../ers-buttons";
import { driverLabel, fuelLapsLeft, leaderboardWindow } from "../third-party-data";
import { useFuelPerLap, useLapHistory, useStartFuel } from "./third-party-parts";
import { HUD_CONTROL } from "./hud-style-parts";
import { fastestLap } from "./game-style-parts";
import { BOX, COLS, HEAD, LBL, LBL_UNIT, NONE, NUM, NUMB, TAG, lbl, type PitWallWords } from "./PitWallParts";

/**
 * The Pit wall layout's paged box: one page at a time (the order in a race or the run's laps outside one, fuel, tyres,
 * car, damage), chosen on its tabs with the pointer, and under every page the fuel and energy line and the electronics
 * line. It opens on the tyres. No key turns its pages: the live tuner above it keeps the keys and the D-pad.
 */

type PageId = "first" | "fuel" | "tyres" | "car" | "damage";
const PAGES: readonly PageId[] = ["first", "fuel", "tyres", "car", "damage"];

/** Every page is this tall (7 rows of 29 px), so the box never jumps as the page turns */
const PAGE = "h-[204px] border-b border-white/9";
const ROWS = "flex flex-col divide-y divide-white/9";

const signed = (v: number, digits = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}`;

/** A label and its reading: one row of a page */
const Row: React.FC<{ label: string; children: React.ReactNode; lit?: boolean }> = ({ label, children, lit = false }) => (
  <div className="flex h-[29px] items-center justify-between gap-2 px-3">
    <span className={lit ? lbl("text-lc-chalk") : LBL}>{label}</span>
    <span className={`${NUM} inline-flex items-baseline gap-1.5 text-[14px]`}>{children}</span>
  </div>
);

const Unit: React.FC<{ children: React.ReactNode }> = ({ children }) => <span className={LBL}>{children}</span>;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Fuel: what is on board, what a lap takes, and whether it reaches the flag                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

interface FuelFigures {
  perLapKg: number | null;
  /** Laps the fuel on board lasts */
  lapsLeft: number | null;
  /** Race laps still to run; null outside a race with a set length */
  toGo: number | null;
  /** Laps of fuel over (+) or short (−) at the flag */
  marginLaps: number | null;
}

function useFuelFigures(t: CarTelemetry, lengthM: number): FuelFigures {
  const perLapKg = useFuelPerLap();
  const lapsLeft = fuelLapsLeft(t.fuelKg, perLapKg);
  const race = t.race;
  let toGo: number | null = null;
  if (race?.totalLaps && race.phase !== "finished") {
    const me = race.standings.find((e) => e.isPlayer);
    const done = me?.raceDistM !== undefined && lengthM > 0 ? me.raceDistM / lengthM : race.lap - 1 + t.trackProgress;
    toGo = Math.max(0, race.totalLaps - Math.max(0, done));
  }
  return { perLapKg, lapsLeft, toGo, marginLaps: lapsLeft !== null && toGo !== null ? lapsLeft - toGo : null };
}

const hasErs = (t: CarTelemetry) => t.f12026?.hasErs !== false;

/** Below this the MGU-K counts as idle (kW) */
const MGUK_IDLE_KW = 6;

const FuelPage: React.FC<{ t: CarTelemetry; fuel: FuelFigures; w: PitWallWords }> = ({ t, fuel, w }) => {
  const startKg = useStartFuel();
  const ers = hasErs(t);
  const race = fuel.toGo !== null;
  const kw = t.mgukPowerKw;
  return (
    <div className={`${PAGE} ${ROWS}`}>
      <Row label={w.fuel.onBoard}>
        {t.fuelKg.toFixed(1)}
        <Unit>{w.fuel.kg}</Unit>
      </Row>
      <Row label={w.fuel.perLap}>
        {fuel.perLapKg !== null ? fuel.perLapKg.toFixed(2) : NONE}
        <Unit>{w.fuel.kg}</Unit>
      </Row>
      <Row label={w.fuel.lapsOfFuel}>
        {fuel.lapsLeft !== null ? fuel.lapsLeft.toFixed(1) : NONE}
        <Unit>{w.fuel.laps}</Unit>
      </Row>
      {race && ers ? null : (
        <Row label={w.fuel.used}>
          {Math.max(0, startKg - t.fuelKg).toFixed(1)}
          <Unit>{w.fuel.kg}</Unit>
        </Row>
      )}
      {race ? (
        <>
          <Row label={w.fuel.lapsToGo}>
            {(fuel.toGo ?? 0).toFixed(1)}
            <Unit>{w.fuel.laps}</Unit>
          </Row>
          <Row label={w.fuel.margin}>
            <span className={fuel.marginLaps === null ? "" : fuel.marginLaps >= 0 ? "text-lc-gain" : "text-lc-loss"}>
              {fuel.marginLaps !== null ? signed(fuel.marginLaps) : NONE}
            </span>
            <Unit>{w.fuel.laps}</Unit>
          </Row>
        </>
      ) : null}
      {ers ? (
        <>
          <Row label={w.fuel.battery}>
            {Math.round(t.ersBatteryPercent)}
            <Unit>%</Unit>
          </Row>
          <Row label={w.fuel.mguk}>
            <span className={lbl(kw > MGUK_IDLE_KW ? "text-lc-info" : kw < -MGUK_IDLE_KW ? "text-lc-gain" : "text-lc-slate")}>
              {kw > MGUK_IDLE_KW ? w.fuel.deploy : kw < -MGUK_IDLE_KW ? w.fuel.harvest : w.fuel.idle}
            </span>
            {signed(kw, 0)}
            <Unit>{w.fuel.kw}</Unit>
          </Row>
        </>
      ) : null}
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Tyres: the three tread bands of each tyre, tread left, pressure against its best, brake discs                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A tread band against the compound's working window: cold under it, warm over it, hot from 10 °C over */
function bandClass(tempC: number, window: readonly [number, number]): string {
  if (tempC < window[0]) return "bg-lc-cold";
  if (tempC <= window[1]) return "bg-lc-ideal";
  if (tempC < window[1] + 10) return "bg-lc-caution";
  return "bg-lc-hot";
}

/** The damage status lists its corners FR, FL, RR, RL; the HUD draws FL, FR, RL, RR */
const DAMAGE_CORNER = [1, 0, 3, 2] as const;
const DEFAULT_WINDOW: readonly [number, number] = [85, 105];
/** A pressure within this of its best reads as on target (psi) */
const PRESSURE_OK_PSI = 0.5;

const TyresPage: React.FC<{ t: CarTelemetry; damage: PlayerDamageStatus | undefined; w: PitWallWords }> = ({ t, damage, w }) => {
  const units = useUnits();
  const window = t.tireOptimalTempC ?? DEFAULT_WINDOW;
  const temp = (c: number) => Math.round(temperatureIn(c, units.temperature));
  return (
    <div className={`${PAGE} grid grid-cols-2`}>
      {w.tyre.corners.map((corner, i) => {
        const left = i % 2 === 0;
        const flat = Boolean(damage?.punctured[DAMAGE_CORNER[i]]);
        const core = t.tireTempsC[i];
        const state = flat ? w.tyre.puncture : core > window[1] ? w.tyre.hot : core < window[0] ? w.tyre.cold : null;
        const stateTone = flat || core > window[1] ? "text-lc-loss" : "text-lc-cold";
        const bands = t.tireBandTempsC?.[i];
        // Left to right as seen from behind: the outer band is on the left of a left tyre, on the right of a right one
        const letters = left ? [w.tyre.outer, w.tyre.middle, w.tyre.inner] : [w.tyre.inner, w.tyre.middle, w.tyre.outer];
        const psi = t.tirePressuresPsi?.[i];
        const bestPsi = t.tireOptimalPsi?.[i];
        const offPsi = psi !== undefined && bestPsi !== undefined ? psi - bestPsi : null;
        return (
          <div
            key={i}
            role="group"
            aria-label={corner}
            className={`flex h-[101.5px] flex-col justify-between px-3 pt-[9px] pb-[9px] ${left ? "border-r border-white/9" : ""} ${i < 2 ? "border-b border-white/9" : ""}`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className={state ? lbl(stateTone) : LBL}>{state ? `${corner} · ${state}` : corner}</span>
              <span className={`${NUMB} text-[13px]`} title={w.tyre.tread}>
                {Math.round(Math.max(0, 100 - t.tireWearPct[i]))}%
              </span>
            </div>
            <div className={`grid gap-0.5 ${bands ? "grid-cols-3" : "grid-cols-1"}`}>
              {(bands ?? [core]).map((c, k) => (
                <span key={k} className={`lc-mono relative grid h-[30px] place-items-center text-[15px] leading-none font-extrabold text-lc-void ${bandClass(c, window)}`}>
                  {bands ? <span className="absolute top-[3px] left-1 text-[9px] leading-none font-bold opacity-70">{letters[k]}</span> : null}
                  {temp(c)}
                </span>
              ))}
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="inline-flex items-baseline gap-1">
                <span className={`${NUM} text-[14px]`}>{psi !== undefined ? formatPressurePsi(psi, units) : NONE}</span>
                <span className={LBL_UNIT}>{pressureUnit(units)}</span>
                {offPsi !== null ? (
                  <span className={`${NUM} ml-1 text-[12px] ${Math.abs(offPsi) <= PRESSURE_OK_PSI ? "text-lc-gain" : "text-lc-caution"}`}>{formatPressureDeltaPsi(offPsi, units)}</span>
                ) : null}
              </span>
              <span className="inline-flex items-baseline gap-1.5">
                <span className={LBL_UNIT}>{w.tyre.brake}</span>
                <span className={`${NUM} text-[14px]`}>{formatTemp(t.brakeTempsC[i], units)}</span>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* The order (a race) and the run's laps (outside one)                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

const ORDER_COLS = "grid grid-cols-[32px_10px_1fr_26px_70px_100px] items-center";

const OrderPage: React.FC<{ t: CarTelemetry; compound: TireCompound; towerGaps: "interval" | "leader" | undefined; w: PitWallWords }> = ({ t, compound, towerGaps, w }) => {
  const race = t.race;
  if (!race) return null;
  const toLeader = towerGaps === "leader";
  const racing = race.phase !== "lights";
  const fastest = fastestLap(t);
  return (
    <div role="table" className={`${PAGE} ${ROWS}`}>
      <div role="row" className={`${ORDER_COLS} h-[21px] ${COLS}`}>
        <span className={`${LBL} text-center`}>{w.order.pos}</span>
        <span />
        <span className={LBL}>{w.order.driver}</span>
        <span />
        <span className={`${LBL} text-right`}>{toLeader ? w.order.gap : w.order.interval}</span>
        <span className={`${LBL} pr-3 text-right`}>{w.order.best}</span>
      </div>
      {leaderboardWindow(race.standings, 7).map((e) => {
        const pos = race.standings.indexOf(e) + 1;
        const tyre = e.isPlayer ? (e.compound ?? compound) : e.compound;
        const gap = toLeader ? e.gapToLeaderS : e.intervalS;
        const holds = fastest?.entry === e;
        return (
          <div key={e.driverCode} role="row" className={`${ORDER_COLS} h-[26px] ${e.isPlayer ? "bg-lc-volt text-lc-void" : ""} ${e.retired ? "text-lc-dim" : ""}`}>
            <span className={`${NUMB} text-center text-[13px] ${e.isPlayer || e.retired ? "" : "text-lc-fog"}`}>{pos}</span>
            <i aria-hidden className="block h-[14px] w-1" style={{ backgroundColor: e.isPlayer ? "var(--color-lc-void)" : e.teamColorHex }} />
            <span className="flex min-w-0 items-center gap-1.5 pr-1">
              <span className="truncate text-[14px] leading-none font-semibold">{driverLabel(e)}</span>
              {e.penaltyS ? <span className={`${TAG} ${e.isPlayer ? "bg-lc-void text-lc-volt" : "bg-lc-loss text-lc-void"}`}>{w.penalty(e.penaltyS)}</span> : null}
            </span>
            <span className="flex justify-center">{tyre ? <CompoundGlyph compound={tyre} size={16} /> : null}</span>
            <span className={`${NUM} flex justify-end text-[13px]`}>
              {e.retired ? (
                <span className={LBL}>{w.order.out}</span>
              ) : e.finished ? (
                <Icon name="chequered" size="xs" label={w.order.finished} className="size-3.5" />
              ) : pos === 1 ? (
                <span className={e.isPlayer ? lbl("text-lc-void") : LBL}>{w.order.leader}</span>
              ) : racing && gap !== undefined ? (
                `+${formatGap(gap, true)}`
              ) : (
                NONE
              )}
            </span>
            <span className={`${NUM} flex items-center justify-end gap-1 pr-3 text-[13px] ${holds && !e.isPlayer ? "text-lc-best" : ""}`}>
              {holds ? <Icon name="time" size="xs" label={w.order.fastest} className="size-3" /> : null}
              {e.bestLapMs ? formatLapTime(e.bestLapMs) : NONE}
            </span>
          </div>
        );
      })}
    </div>
  );
};

const LAP_COLS = "grid grid-cols-[52px_1fr_78px_78px_78px] items-center px-3";

const LapsPage: React.FC<{ t: CarTelemetry; w: PitWallWords }> = ({ t, w }) => {
  const laps = useLapHistory(7);
  const best = t.bestLapTimeMs;
  return (
    <div role="table" className={`${PAGE} ${ROWS}`}>
      <div role="row" className={`${LAP_COLS} h-[21px] ${COLS}`}>
        <span className={LBL}>{w.laps.lap}</span>
        <span className={`${LBL} text-right`}>{w.time}</span>
        {w.sectorShort.map((s) => (
          <span key={s} className={`${LBL} text-right`}>
            {s}
          </span>
        ))}
      </div>
      {laps.length === 0 ? <p className="px-3 pt-3 text-[13px] leading-none text-lc-fog">{w.laps.none}</p> : null}
      {laps.map((lap) => {
        const isBest = lap.valid && best !== null && lap.ms <= best + 0.5;
        return (
          <div key={lap.lap} role="row" className={`${LAP_COLS} h-[26px]`}>
            <span className={`${NUMB} text-[13px] text-lc-fog`}>{lap.lap}</span>
            <span className={`${NUM} flex items-center justify-end gap-1.5 text-[13px] ${lap.valid ? (isBest ? "text-lc-best" : "") : "text-lc-loss"}`}>
              {lap.valid ? isBest ? <Icon name="time" size="xs" label={w.best} className="size-3" /> : null : <Icon name="trackLimits" size="xs" label={w.invalid} className="size-3" />}
              {formatLapTime(lap.ms)}
            </span>
            {lap.sectorsMs.map((ms, i) => (
              <span key={i} className={`${NUM} text-right text-[13px] text-lc-fog`}>
                {formatSectorTime(ms)}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Car: the electronics as they are set, the differential, the hybrid and the aero                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A dial's setting, or "off" at zero: a car without the aid shows it as off, never as a number */
const dial = (level: number, w: PitWallWords) => (level > 0 ? String(level) : w.car.off);

/** The ERS mode's three-letter code, as the tuner names it */
const ersModeCode = (mode: string) => mode.slice(0, 3).toUpperCase();

const CarPage: React.FC<{ t: CarTelemetry; w: PitWallWords }> = ({ t, w }) => {
  const units = useUnits();
  const tuner = t.liveTuner;
  const aids = aidsActive(t);
  const aero = aeroReadout(t);
  const flaps = (t.f12026?.hasDrs ?? false) && t.overtakingRules !== "none";
  const right: React.ReactNode[] = [];
  if (tuner) {
    (["ENTRY", "MID", "EXIT"] as const).forEach((phase, i) => {
      const lit = tuner.diffActivePhase === phase;
      right.push(
        <Row key={phase} label={[w.car.diffEntry, w.car.diffMid, w.car.diffExit][i]} lit={lit}>
          {lit ? <span aria-hidden className="size-1.5 self-center bg-lc-chalk" /> : null}
          {[tuner.diffEntry, tuner.diffMid, tuner.diffExit][i]}
        </Row>,
      );
    });
    if (tuner.hasErs && hasErs(t))
      right.push(
        <Row key="ers" label={w.car.ersMode}>
          <span className="text-lc-info">{ersModeCode(tuner.ersMode)}</span>
        </Row>,
      );
    if (tuner.motorDeployKw !== null)
      right.push(
        <Row key="motor" label={w.car.motor}>
          {Math.round(tuner.motorDeployKw)}
          <Unit>{w.fuel.kw}</Unit>
        </Row>,
      );
    if (tuner.regenKw !== null)
      right.push(
        <Row key="regen" label={w.car.regen}>
          {Math.round(tuner.regenKw)}
          <Unit>{w.fuel.kw}</Unit>
        </Row>,
      );
  }
  if (flaps)
    right.push(
      <Row key="aero" label={w.car.aero}>
        <span className={aero.open ? "text-lc-info" : ""}>{aero.label}</span>
      </Row>,
    );
  right.push(
    <Row key="df" label={w.car.downforce}>
      {Math.round(t.downforceKgf)}
      <Unit>{w.car.kgf}</Unit>
    </Row>,
  );
  if (t.aeroCopFrontPct !== undefined)
    right.push(
      <Row key="bal" label={w.car.aeroBalance}>
        {t.aeroCopFrontPct.toFixed(1)}
        <Unit>{w.car.front}</Unit>
      </Row>,
    );
  right.push(
    <Row key="top" label={w.car.topSpeed}>
      {formatSpeed(t.topSpeedThisLapKmh, units)}
      <Unit>{speedUnit(units)}</Unit>
    </Row>,
  );
  return (
    <div className={`${PAGE} grid grid-cols-2`}>
      <div className={`${ROWS} border-r border-white/9`}>
        <Row label={w.car.tc} lit={aids.tc}>
          {aids.tc ? <span className={`${TAG} self-center bg-lc-caution text-lc-void`}>{w.car.active}</span> : null}
          {tuner ? dial(tuner.tcLevel, w) : NONE}
        </Row>
        <Row label={w.car.tcCut}>{tuner && tuner.tcLevel > 0 ? tuner.tc2Level : NONE}</Row>
        {tuner?.hasTcSlipAngle ? <Row label={w.car.tcSlip}>{dial(tuner.tcSlipAngleLevel, w)}</Row> : null}
        <Row label={w.car.abs} lit={aids.abs}>
          {aids.abs ? <span className={`${TAG} self-center bg-lc-caution text-lc-void`}>{w.car.active}</span> : null}
          {tuner ? dial(tuner.absLevel, w) : NONE}
        </Row>
        <Row label={w.car.brakeBias}>
          {tuner ? tuner.brakeBiasPct.toFixed(1) : NONE}
          <Unit>{w.car.front}</Unit>
        </Row>
        <Row label={w.car.migration}>
          {tuner ? tuner.brakeMigrationPct.toFixed(1) : NONE}
          <Unit>%</Unit>
        </Row>
        <Row label={w.car.engineMap}>{tuner ? tuner.engineMap : NONE}</Row>
      </div>
      <div className={ROWS}>{right.slice(0, 7)}</div>
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Damage: the bodywork by side, the suspension by corner, the tyres                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

const damageTone = (level: number) => (level >= 0.4 ? "text-lc-loss" : level >= 0.1 ? "text-lc-caution" : "");
const damageFill = (level: number) => (level >= 0.4 ? "bg-lc-loss" : level >= 0.1 ? "bg-lc-caution" : "bg-lc-slate");

const DamageRow: React.FC<{ label: string; level: number }> = ({ label, level }) => {
  const share = Math.max(0, Math.min(1, level));
  return (
    <Row label={label}>
      <span aria-hidden className="relative h-1.5 w-[52px] self-center overflow-hidden bg-lc-titanium">
        <span className={`absolute inset-0 origin-left ${damageFill(level)}`} style={{ transform: `scaleX(${share.toFixed(3)})` }} />
      </span>
      <span className={`w-[4ch] text-right ${damageTone(level)}`}>{Math.round(share * 100)}%</span>
    </Row>
  );
};

const DamagePage: React.FC<{ damage: PlayerDamageStatus | undefined; w: PitWallWords }> = ({ damage, w }) => {
  const flats = w.damage.corners.filter((_, i) => damage?.punctured[DAMAGE_CORNER[i]]);
  return (
    <div className={`${PAGE} grid grid-cols-2`}>
      <div className={`${ROWS} border-r border-white/9`}>
        <DamageRow label={w.damage.overall} level={damage?.overall ?? 0} />
        <DamageRow label={w.damage.front} level={damage?.front ?? 0} />
        <DamageRow label={w.damage.rear} level={damage?.rear ?? 0} />
        <DamageRow label={w.damage.left} level={damage?.left ?? 0} />
        <DamageRow label={w.damage.right} level={damage?.right ?? 0} />
        <Row label={w.damage.status}>
          <span className={lbl(damage?.terminal ? "text-lc-loss" : "text-lc-chalk")}>{damage?.terminal ? w.damage.terminal : w.damage.running}</span>
        </Row>
      </div>
      <div className={ROWS}>
        {w.damage.corners.map((corner, i) => (
          <DamageRow key={corner} label={`${w.damage.suspension} ${corner}`} level={damage?.suspension[DAMAGE_CORNER[i]] ?? 0} />
        ))}
        <Row label={w.damage.tyres}>
          <span className={lbl(flats.length ? "text-lc-loss" : "text-lc-chalk")}>{flats.length ? `${flats.join(" ")} ${w.damage.flat}` : w.damage.ok}</span>
        </Row>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* The two status lines under every page                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

const Stat: React.FC<{ label?: string; children: React.ReactNode }> = ({ label, children }) => (
  <span className="inline-flex items-baseline gap-1.5">
    {label ? <span className={LBL}>{label}</span> : null}
    <span className={`${NUMB} inline-flex items-baseline gap-1.5 text-[15px]`}>{children}</span>
  </span>
);

const StatusLines: React.FC<{ t: CarTelemetry; fuel: FuelFigures; w: PitWallWords }> = ({ t, fuel, w }) => {
  const tuner = t.liveTuner;
  const aids = aidsActive(t);
  const ers = hasErs(t);
  const soc = Math.max(0, Math.min(1, t.ersBatteryPercent / 100));
  const buttons = ers ? ersButtons(t) : null;
  const pushing = buttons ? buttons.overtake === "on" || buttons.overtake === "auto" || buttons.boostOn : false;
  const ersWord = buttons && (buttons.overtake === "on" || buttons.overtake === "auto") ? w.car.overtake : buttons?.boostOn ? w.car.boost : w.car.ers;
  const lit = "bg-lc-caution px-1 text-lc-void";
  return (
    <div role="group" aria-label={w.region.status}>
      <div className="flex h-8 items-center justify-between gap-2 border-b border-white/9 px-3">
        <Stat label={w.fuel.short}>
          {t.fuelKg.toFixed(1)}
          <Unit>{w.fuel.kg}</Unit>
        </Stat>
        <Stat>
          {fuel.lapsLeft !== null ? fuel.lapsLeft.toFixed(1) : NONE}
          <Unit>{w.fuel.laps}</Unit>
          {fuel.marginLaps !== null ? <span className={fuel.marginLaps >= 0 ? "text-lc-gain" : "text-lc-loss"}>{signed(fuel.marginLaps)}</span> : null}
        </Stat>
        {ers ? (
          <span className="inline-flex items-center gap-1.5">
            <span className={pushing ? `${TAG} bg-lc-info text-lc-void` : lbl("text-lc-info")}>{ersWord}</span>
            <span className={`${NUMB} text-[15px]`}>{Math.round(t.ersBatteryPercent)}%</span>
            <span aria-hidden className="relative h-1.5 w-[70px] overflow-hidden bg-lc-titanium">
              <span className="absolute inset-0 origin-left bg-lc-info" style={{ transform: `scaleX(${soc.toFixed(3)})` }} />
            </span>
          </span>
        ) : (
          <Stat label={w.fuel.perLapShort}>
            {fuel.perLapKg !== null ? fuel.perLapKg.toFixed(2) : NONE}
            <Unit>{w.fuel.kg}</Unit>
          </Stat>
        )}
      </div>
      <div className="flex h-8 items-center justify-between gap-2 px-3">
        <Stat label={w.car.tc}>
          <span className={aids.tc ? lit : ""}>{tuner ? dial(tuner.tcLevel, w) : NONE}</span>
        </Stat>
        <Stat label={w.car.abs}>
          <span className={aids.abs ? lit : ""}>{tuner ? dial(tuner.absLevel, w) : NONE}</span>
        </Stat>
        <Stat label={w.car.bias}>{tuner ? tuner.brakeBiasPct.toFixed(1) : NONE}</Stat>
        <Stat label={w.car.map}>{tuner ? tuner.engineMap : NONE}</Stat>
        {tuner?.hasErs && ers ? (
          <Stat label={w.car.ersMode}>
            <span className="text-lc-info">{ersModeCode(tuner.ersMode)}</span>
          </Stat>
        ) : null}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */

export const PitWallDetail: React.FC<{
  t: CarTelemetry;
  lengthM: number;
  compound: TireCompound;
  towerGaps: "interval" | "leader" | undefined;
  w: PitWallWords;
}> = ({ t, lengthM, compound, towerGaps, w }) => {
  const [page, setPage] = useState<PageId>("tyres");
  const fuel = useFuelFigures(t, lengthM);
  const damage = t.race?.damage ?? t.practiceDamage;
  const hurt = damage ? damage.overall : 0;
  const label: Record<PageId, string> = { first: t.race ? w.tab.order : w.tab.laps, fuel: w.tab.fuel, tyres: w.tab.tyres, car: w.tab.car, damage: w.tab.damage };
  return (
    <section data-hud-avoid aria-label={w.region.detail} className={`w-[452px] ${BOX}`}>
      <div role="tablist" aria-label={w.region.pages} className={`pointer-events-auto flex h-8 ${HEAD}`}>
        {PAGES.map((id) => {
          const on = id === page;
          const flagged = id === "damage" && hurt >= 0.01;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={-1}
              // The pointer turns the page without taking the focus: a driving key must never press a tab
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setPage(id)}
              className={`lc-mono flex items-center justify-center gap-1.5 border-r border-lc-line text-[11px] leading-none font-bold tracking-[0.08em] whitespace-nowrap uppercase last:border-r-0 ${HUD_CONTROL} ${
                flagged ? "flex-[1.45]" : "flex-1"
              } ${on ? "bg-lc-line shadow-[inset_0_-2px_0_var(--color-lc-chalk)]" : ""} ${
                flagged ? (hurt >= 0.4 ? "text-lc-loss" : "text-lc-caution") : on ? "text-lc-chalk" : "text-lc-slate"
              }`}
            >
              {flagged ? <Icon name="damage" size="xs" className="size-3" /> : null}
              {label[id]}
              {flagged ? <span className="tracking-normal">{Math.round(hurt * 100)}%</span> : null}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" aria-label={label[page]}>
        {page === "first" ? (
          t.race ? (
            <OrderPage t={t} compound={compound} towerGaps={towerGaps} w={w} />
          ) : (
            <LapsPage t={t} w={w} />
          )
        ) : page === "fuel" ? (
          <FuelPage t={t} fuel={fuel} w={w} />
        ) : page === "tyres" ? (
          <TyresPage t={t} damage={damage} w={w} />
        ) : page === "car" ? (
          <CarPage t={t} w={w} />
        ) : (
          <DamagePage damage={damage} w={w} />
        )}
      </div>
      <StatusLines t={t} fuel={fuel} w={w} />
    </section>
  );
};
