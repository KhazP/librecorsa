"use client";

import React, { useState } from "react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { Icon } from "@/components/ui/icons/Icon";
import { useUnits } from "@/lib/settings/ui-prefs";
import { temperatureIn } from "@/lib/settings/units";
import {
  brakeGlowColor,
  formatGap,
  formatLapTime,
  formatPressurePsi,
  formatSpeed,
  formatTemp,
  pressureUnit,
  raceState,
  speedUnit,
  tyreHeatColor,
} from "../hud-format";
import { driverLabel, fuelLapsLeft, leaderboardWindow } from "../third-party-data";
import { useFuelPerLap, useStartFuel } from "./third-party-parts";
import { TopDownCar, carClassCode, damageZoneColor } from "./game-style-parts";
import { CUT_BR, HAIR, LBL, LBL_INK, NONE, PLATE, SLANT, TAG, UNSLANT, type PageId, type TyreState, type Words } from "./racing-line-parts";

/**
 * The Racing line layout's one paged box (bottom right): tyres, fuel, the car and the running order behind four
 * slanted tabs. The tabs are clicked; no key is bound to them. The page is remembered across sessions.
 */

const PAGE_KEY = "lc.hud.racing-line.page";
const PAGE_IDS: readonly PageId[] = ["tyres", "fuel", "car", "order"];
/** Outside a race there is no order to show */
const SOLO_PAGE_IDS: readonly PageId[] = ["tyres", "fuel", "car"];

const readPage = (): PageId => {
  try {
    const v = typeof window === "undefined" ? null : window.localStorage.getItem(PAGE_KEY);
    if (v && (PAGE_IDS as readonly string[]).includes(v)) return v as PageId;
  } catch {
    // Not remembered
  }
  return "tyres";
};

/** A tyre counts as hot or cold from this far outside its working window (°C) */
const WINDOW_MARGIN_C = 5;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/* ------------------------------------------------------------------------------------------------------------------ */
/* Tyres: each corner's tread temperature and pressure outside, its three tread bands and the brakes between them      */
/* ------------------------------------------------------------------------------------------------------------------ */

const Tread: React.FC<{ t: CarTelemetry; i: number }> = ({ t, i }) => {
  const bands = t.tireBandTempsC?.[i];
  const temp = t.tireTempsC[i];
  return (
    <span aria-hidden className="grid h-[56px] grid-cols-3 gap-[2px]">
      {[0, 1, 2].map((b) => (
        <i key={b} className="block" style={{ backgroundColor: tyreHeatColor(bands ? bands[b] : temp, t.tireOptimalTempC) }} />
      ))}
    </span>
  );
};

const CornerText: React.FC<{ t: CarTelemetry; i: number; w: Words; flat: boolean }> = ({ t, i, w, flat }) => {
  const units = useUnits();
  const left = i % 2 === 0;
  const temp = t.tireTempsC[i];
  const [lo, hi] = t.tireOptimalTempC ?? [85, 105];
  const state: TyreState | null = flat ? "flat" : temp > hi + WINDOW_MARGIN_C ? "hot" : temp < lo - WINDOW_MARGIN_C ? "cold" : null;
  const tone = state === "cold" ? "text-lc-cold" : state ? "text-lc-loss" : "text-lc-chalk";
  const psi = t.tirePressuresPsi?.[i];
  const word = state ? <span className={`${LBL_INK} ${tone}`}>{w.tyreState[state]}</span> : null;
  return (
    <span className={`flex min-w-0 flex-col ${left ? "items-end" : "items-start"}`}>
      <span className={`flex items-baseline gap-[6px] ${tone}`}>
        {left ? word : null}
        <span className="lc-mono text-[22px] leading-none font-semibold whitespace-nowrap">{formatTemp(temp, units)}</span>
        {left ? null : word}
      </span>
      <span className="lc-mono mt-[6px] text-[13px] leading-none font-semibold whitespace-nowrap text-lc-fog">
        {psi === undefined ? NONE : formatPressurePsi(psi, units)}
        <small className="ml-[3px] text-[10px] tracking-[0.08em] text-lc-slate uppercase">{pressureUnit(units)}</small>
      </span>
    </span>
  );
};

const Axle: React.FC<{ t: CarTelemetry; first: 0 | 2; w: Words; className?: string }> = ({ t, first, w, className = "" }) => {
  const units = useUnits();
  const punctured = (t.race?.damage ?? t.practiceDamage)?.punctured;
  const brake = (i: number) => String(Math.round(temperatureIn(t.brakeTempsC[i], units.temperature)));
  const label = [first, first + 1]
    .map((i) =>
      w.tyreCorner(
        w.corners[i],
        formatTemp(t.tireTempsC[i], units, true),
        t.tirePressuresPsi ? `${formatPressurePsi(t.tirePressuresPsi[i], units)} ${pressureUnit(units)}` : NONE,
        formatTemp(t.brakeTempsC[i], units, true),
      ),
    )
    .join(". ");
  return (
    <div role="img" aria-label={label} className={`grid grid-cols-[1fr_42px_74px_42px_1fr] items-center gap-x-[9px] ${className}`}>
      {/* The damage lists its corners FR, FL, RR, RL; the telemetry FL, FR, RL, RR */}
      <CornerText t={t} i={first} w={w} flat={Boolean(punctured?.[first ^ 1])} />
      <Tread t={t} i={first} />
      <span className="flex flex-col items-center">
        <span aria-hidden className="mb-[5px] flex justify-center gap-[22px]">
          <i className="block h-[26px] w-[6px]" style={{ backgroundColor: brakeGlowColor(t.brakeTempsC[first]) }} />
          <i className="block h-[26px] w-[6px]" style={{ backgroundColor: brakeGlowColor(t.brakeTempsC[first + 1]) }} />
        </span>
        <span className="lc-data text-[13px] leading-none whitespace-nowrap text-lc-chalk">
          {brake(first)} <span className="text-lc-slate">·</span> {brake(first + 1)}
        </span>
      </span>
      <Tread t={t} i={first + 1} />
      <CornerText t={t} i={first + 1} w={w} flat={Boolean(punctured?.[(first + 1) ^ 1])} />
    </div>
  );
};

const TyresPage: React.FC<{ t: CarTelemetry; compound: TireCompound; w: Words }> = ({ t, compound, w }) => {
  const units = useUnits();
  const life = Math.round(100 - Math.max(...t.tireWearPct));
  const range = t.tireOptimalTempC;
  return (
    <>
      <div className="mb-[11px] flex h-[18px] items-center gap-2">
        <CompoundGlyph compound={compound} size={18} decorative />
        <b className="lc-disp mr-0.5 text-[16px] text-lc-chalk">{w.compounds[compound]}</b>
        <span className={LBL}>{w.tyreLife(life)}</span>
        {range ? <span className={`${LBL} ml-auto`}>{w.tyreWindow(formatTemp(range[0], units).replace("°", ""), formatTemp(range[1], units))}</span> : null}
      </div>
      <Axle t={t} first={0} w={w} />
      <Axle t={t} first={2} w={w} className={`mt-3 border-t pt-3 ${HAIR}`} />
    </>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Fuel: what is on board, what a lap costs and what is left at the flag                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

const Reading: React.FC<{ label: string; value: string; unit?: string; note?: string; tone?: string; big?: boolean }> = ({
  label,
  value,
  unit,
  note,
  tone = "text-lc-chalk",
  big = false,
}) => (
  <span className="flex min-w-0 flex-col">
    <span className={LBL}>{label}</span>
    <span className={`lc-mono leading-none font-semibold whitespace-nowrap ${big ? "mt-[9px] text-[36px] tracking-[-0.02em]" : "mt-[8px] text-[17px]"} ${tone}`}>
      {value}
      {unit ? <small className={`ml-[4px] tracking-[0.08em] text-lc-slate uppercase ${big ? "text-[13px]" : "text-[10px]"}`}>{unit}</small> : null}
    </span>
    {note ? <span className={`${LBL_INK} mt-[6px] ${tone}`}>{note}</span> : null}
  </span>
);

const FuelPage: React.FC<{ t: CarTelemetry; w: Words }> = ({ t, w }) => {
  const perLap = useFuelPerLap();
  const startKg = useStartFuel();
  const f = w.fuelPage;
  if (!(t.fuelKg > 0.01) && !(startKg > 0.01)) {
    return <p className={`${LBL} flex h-full items-center justify-center`}>{f.noFuel}</p>;
  }
  const lapsOfFuel = fuelLapsLeft(t.fuelKg, perLap);
  const race = t.race;
  const lapsToGo = race?.totalLaps && !raceState(race).finished ? Math.max(0, race.totalLaps - (Math.max(1, race.lap) - 1 + t.trackProgress)) : null;
  const marginKg = perLap !== null && lapsToGo !== null ? t.fuelKg - perLap * lapsToGo : null;
  const short = marginKg !== null && marginKg < 0;
  const low = lapsOfFuel !== null && (lapsToGo !== null ? lapsOfFuel < lapsToGo : lapsOfFuel < 2);
  return (
    <div className="flex h-full flex-col">
      <div className="grid grid-cols-2 gap-x-4">
        <Reading big label={f.onBoard} value={t.fuelKg.toFixed(1)} unit={w.kg} />
        <Reading big label={f.lapsOfFuel} value={lapsOfFuel === null ? NONE : lapsOfFuel.toFixed(1)} unit={w.laps} tone={low ? "text-lc-caution" : undefined} />
      </div>
      {/* What is left of the load the run started on */}
      <span aria-hidden className="relative mt-[13px] block h-[6px] overflow-hidden bg-lc-titanium">
        <i
          className={`absolute inset-0 block origin-left ${low ? "bg-lc-caution" : "bg-lc-chalk"}`}
          style={{ transform: `scaleX(${startKg > 0 ? clamp01(t.fuelKg / startKg) : 0})` }}
        />
      </span>
      <div className={`mt-auto grid grid-cols-3 gap-x-4 border-t pt-[12px] ${HAIR}`}>
        <Reading label={f.perLap} value={perLap === null ? NONE : perLap.toFixed(2)} unit={w.kg} />
        {lapsToGo !== null ? (
          <>
            <Reading label={f.lapsToGo} value={lapsToGo.toFixed(1)} />
            <Reading
              label={f.atFlag}
              value={marginKg === null ? NONE : `${short ? "−" : "+"}${Math.abs(marginKg).toFixed(1)}`}
              unit={w.kg}
              note={marginKg === null ? undefined : short ? f.short : f.spare}
              tone={marginKg === null ? undefined : short ? "text-lc-loss" : "text-lc-gain"}
            />
          </>
        ) : (
          <Reading label={f.used} value={Math.max(0, startKg - t.fuelKg).toFixed(1)} unit={w.kg} />
        )}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Car: the damage by part, drawn on the car and as figures                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

const CarPage: React.FC<{ t: CarTelemetry; w: Words }> = ({ t, w }) => {
  const units = useUnits();
  const damage = t.race?.damage ?? t.practiceDamage;
  const c = w.carPage;
  const overall = damage ? Math.round(damage.overall * 100) : 0;
  const zones = [damage?.front ?? 0, damage?.rear ?? 0, damage?.left ?? 0, damage?.right ?? 0];
  const punctured = Boolean(damage?.punctured.some(Boolean));
  return (
    <div className="flex h-full gap-4">
      <svg viewBox="8 2 84 140" role="img" aria-label={c.diagram} className="h-full w-[100px] shrink-0">
        <TopDownCar openWheel={carClassCode(t) === "openWheel"} damage={damage} t={t} showWheels />
      </svg>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[18px] items-center gap-2">
          {overall > 0 ? (
            <span className={`inline-flex items-center gap-1.5 ${TAG} ${overall >= 40 ? "text-lc-loss" : "text-lc-caution"}`}>
              <Icon name="damage" size="xs" className="size-3.5" />
              {c.damage(overall)}
            </span>
          ) : (
            <span className={LBL}>{c.noDamage}</span>
          )}
          {punctured ? <span className={`${TAG} ml-auto bg-lc-loss px-1.5 py-[3px] text-lc-void`}>{c.puncture}</span> : null}
        </div>
        <div className="mt-[10px] flex flex-col gap-[9px]">
          {zones.map((level, i) => (
            <div key={i} className="grid grid-cols-[52px_1fr_38px] items-center gap-x-2">
              <span className={LBL}>{c.zones[i]}</span>
              <span aria-hidden className="relative block h-[6px] overflow-hidden bg-lc-titanium">
                <i className="absolute inset-0 block origin-left" style={{ transform: `scaleX(${clamp01(level)})`, backgroundColor: damageZoneColor(level) }} />
              </span>
              <span className={`lc-data text-right text-[13px] leading-none ${level >= 0.4 ? "text-lc-loss" : level >= 0.1 ? "text-lc-caution" : "text-lc-fog"}`}>
                {Math.round(level * 100)}%
              </span>
            </div>
          ))}
        </div>
        <div className={`mt-auto flex items-baseline justify-between border-t pt-[10px] ${HAIR}`}>
          <span className={LBL}>{c.topSpeed}</span>
          <span className="lc-mono text-[17px] leading-none font-semibold text-lc-chalk">
            {formatSpeed(t.topSpeedThisLapKmh, units)}
            <small className="ml-[4px] text-[10px] tracking-[0.08em] text-lc-slate uppercase">{speedUnit(units)}</small>
          </span>
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Order: the leader and the cars round the player, with each car's last lap and gap                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

const ORDER_ROWS = 6;

const OrderPage: React.FC<{ t: CarTelemetry; w: Words; gaps: "interval" | "leader" }> = ({ t, w, gaps }) => {
  const standings = t.race?.standings ?? [];
  const o = w.orderPage;
  const grid = t.race?.phase === "lights";
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[14px] items-start justify-between">
        <span className={LBL}>{o.title}</span>
        <span className={LBL}>{gaps === "leader" ? o.toLeader : o.interval}</span>
      </div>
      <ol className="mt-auto flex flex-col">
        {leaderboardWindow(standings, ORDER_ROWS).map((e) => {
          const pos = standings.indexOf(e) + 1;
          const gapS = gaps === "leader" ? e.gapToLeaderS : (e.intervalS ?? e.gapToLeaderS);
          return (
            <li
              key={e.driverCode}
              className={`grid h-[25px] grid-cols-[26px_4px_1fr_20px_78px_62px] items-center border-t ${HAIR} ${
                e.isPlayer ? "bg-lc-volt text-lc-void" : "text-lc-chalk"
              } ${e.retired ? "opacity-50" : ""}`}
            >
              <span className="lc-data text-center text-[12px]">{pos}</span>
              <i aria-hidden className="block h-[14px]" style={{ backgroundColor: e.isPlayer ? "var(--color-lc-void)" : e.teamColorHex }} />
              <span className="truncate pl-[9px] text-[13px] leading-none font-semibold">{driverLabel(e)}</span>
              {e.compound ? <CompoundGlyph compound={e.compound} size={16} /> : <span />}
              <span className={`lc-mono text-right text-[12px] font-semibold ${e.isPlayer ? "" : "text-lc-fog"}`}>{formatLapTime(e.lastLapMs)}</span>
              <span className="lc-data flex items-center justify-end pr-[8px] text-[12px]">
                {e.retired ? (
                  <span className={TAG}>{o.out}</span>
                ) : e.finished ? (
                  <Icon name="chequered" size="xs" className="size-3.5" />
                ) : pos === 1 ? (
                  <span className={TAG}>{o.lead}</span>
                ) : grid ? null : (
                  `+${formatGap(gapS, true)}`
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */

export const PagedBox: React.FC<{ t: CarTelemetry; compound: TireCompound; w: Words; towerGaps?: "interval" | "leader" }> = ({
  t,
  compound,
  w,
  towerGaps = "interval",
}) => {
  const [chosen, setChosen] = useState<PageId>(readPage);
  const ids = t.race ? PAGE_IDS : SOLO_PAGE_IDS;
  const page = ids.includes(chosen) ? chosen : "tyres";
  const choose = (id: PageId) => {
    setChosen(id);
    try {
      window.localStorage.setItem(PAGE_KEY, id);
    } catch {
      // Not remembered across sessions
    }
  };
  return (
    <section aria-label={w.pagesLabel} className="w-[404px]">
      <div role="tablist" aria-label={w.pagesLabel} className="mx-[5px] mb-[3px] flex h-[30px] gap-[3px]">
        {ids.map((id) => {
          const on = id === page;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={(e) => {
                choose(id);
                // A click with the mouse gives the keys back to the car
                if (e.detail > 0) e.currentTarget.blur();
              }}
              className={`pointer-events-auto grid flex-1 cursor-pointer place-items-center outline-none transition-colors duration-150 focus-visible:inset-ring-2 focus-visible:inset-ring-lc-volt ${SLANT} ${
                on ? "bg-lc-line text-lc-chalk inset-ring inset-ring-white/75" : `${PLATE} text-lc-slate hover:bg-lc-titanium hover:text-lc-chalk`
              }`}
            >
              <b className={`${TAG} ${UNSLANT}`}>{w.pages[id]}</b>
            </button>
          );
        })}
      </div>
      <div role="tabpanel" aria-label={w.pages[page]} className={`h-[194px] px-4 pt-3 pb-4 ${PLATE} ${CUT_BR}`}>
        {page === "tyres" ? (
          <TyresPage t={t} compound={compound} w={w} />
        ) : page === "fuel" ? (
          <FuelPage t={t} w={w} />
        ) : page === "car" ? (
          <CarPage t={t} w={w} />
        ) : (
          <OrderPage t={t} w={w} gaps={towerGaps} />
        )}
      </div>
    </section>
  );
};
