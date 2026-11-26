"use client";

import React from "react";
import type { CarTelemetry, PlayerDamageStatus } from "@/types/f1";
import { useUnits } from "@/lib/settings/ui-prefs";
import { HUD_SHIFT, aidsActive, atShiftPoint, formatSpeed, speedUnit } from "../hud-format";
import { aeroReadout } from "../aero-label";
import { ersButtons } from "../ers-buttons";
import { fuelLapsLeft } from "../third-party-data";
import { useFuelPerLap, useStartFuel } from "./third-party-parts";
import { gearLabel } from "./hud-style-parts";
import { TopDownCar, arcPath, carClassCode } from "./game-style-parts";
import { HAIR, LBL, PLATE, type EnduranceWords, type ErsModeCode } from "./EnduranceWords";

/**
 * Bottom right of the Endurance layout: a round dial (rev arc, gear, speed) standing out of the top of a plate, the
 * car from above beside it carrying its damage and tyre temperatures, then fuel and energy as two bars with their
 * state written on them, and the electronics as one line.
 */

/* ── The dial ────────────────────────────────────────────────────────────── */

const DISC = 212;
const C = DISC / 2;
const ARC_R = 90;
const ARC = arcPath(C, C, ARC_R, -135, 135);
/** Where the shift point sits on the arc: the stretch after it is the red zone */
const SHIFT_AT = 0.92;
const RED = arcPath(C, C, ARC_R, -135 + 270 * SHIFT_AT, 135);

/** 11480 as "11 480": a thin space between the thousands */
const formatRpm = (rpm: number): string => {
  const r = Math.max(0, Math.round(rpm));
  return r >= 1000 ? `${Math.floor(r / 1000)} ${String(r % 1000).padStart(3, "0")}` : String(r);
};

const Dial: React.FC<{ t: CarTelemetry; revRange: [number, number]; w: EnduranceWords }> = ({ t, revRange, w }) => {
  const units = useUnits();
  const revFull = Math.max(1, revRange[1]);
  const shift = atShiftPoint(t.rpm, revFull);
  const frac = Math.min(1, Math.max(0, (t.rpm / revFull) * SHIFT_AT));
  const aero = aeroReadout(t);
  const showAero = (t.f12026?.hasDrs ?? false) && t.overtakingRules !== "none";
  return (
    <div role="group" aria-label={w.dial} className="absolute top-0 right-1 size-[212px] rounded-full bg-lc-void">
      <svg viewBox={`0 0 ${DISC} ${DISC}`} className="absolute inset-0 size-full" fill="none" aria-hidden>
        <path d={ARC} stroke="var(--color-lc-chalk)" strokeOpacity={0.2} strokeWidth={10} />
        <path d={RED} stroke="var(--color-lc-crimson)" strokeWidth={10} />
        {frac > 0.004 ? <path d={ARC} stroke={shift ? HUD_SHIFT : "var(--color-lc-chalk)"} strokeWidth={10} pathLength={100} strokeDasharray={`${(frac * 100).toFixed(2)} 100`} /> : null}
        {/* Ten segments: a dark cut every tenth of the arc */}
        <path d={ARC} stroke="var(--color-lc-void)" strokeWidth={11} pathLength={100} strokeDasharray="0.6 9.4" strokeDashoffset={-9.7} />
      </svg>
      <div className={`absolute top-[34px] left-1/2 grid h-[70px] w-[64px] -translate-x-1/2 place-items-center text-lc-void ${shift ? "bg-lc-cyan" : "bg-lc-volt"}`}>
        <span className="lc-disp text-[62px] leading-none">{gearLabel(t.gear)}</span>
      </div>
      <div className="absolute inset-x-0 top-[111px] flex items-baseline justify-center gap-1.5">
        <span className="lc-mono text-[34px] leading-none font-semibold tracking-[-0.03em] text-lc-chalk">{formatSpeed(t.speedKmh, units)}</span>
        <span className={LBL}>{speedUnit(units)}</span>
      </div>
      <div className="absolute inset-x-0 top-[151px] flex items-baseline justify-center gap-1.5">
        <span className="lc-mono text-[12px] leading-none font-bold text-lc-fog">{formatRpm(t.rpm)}</span>
        <span className={LBL}>{w.rpm}</span>
      </div>
      {showAero ? (
        <div className="absolute inset-x-0 top-[173px] flex justify-center">
          <span
            className={`lc-mono inline-flex h-4 items-center px-1.5 text-[9px] leading-none font-extrabold tracking-[0.12em] uppercase ${
              aero.open ? "bg-lc-info text-lc-void" : aero.armed || aero.queued ? "border border-lc-info text-lc-info" : "border border-white/14 text-lc-slate"
            }`}
          >
            {aero.label}
          </span>
        </div>
      ) : null}
    </div>
  );
};

/* ── The car ─────────────────────────────────────────────────────────────── */

/** From here a part counts as damaged, and from here heavily (the levels `damageZoneColor` draws) */
const MINOR = 0.1;
const HEAVY = 0.4;

/** The worst thing wrong with the car, in words: a puncture first, else the most damaged part and how bad */
function damageLine(d: PlayerDamageStatus | undefined, w: EnduranceWords): { text: string; cls: string } {
  if (!d) return { text: w.noDamage, cls: "text-lc-slate" };
  if (d.terminal) return { text: w.damageOut, cls: "text-lc-loss" };
  if (d.punctured.some(Boolean)) return { text: w.damagePart.puncture, cls: "text-lc-loss" };
  const p = w.damagePart;
  let part = p.front;
  let level = d.front;
  const take = (name: string, v: number) => {
    if (v > level) {
      part = name;
      level = v;
    }
  };
  take(p.rear, d.rear);
  take(p.left, d.left);
  take(p.right, d.right);
  take(p.suspension, Math.max(d.suspension[0], d.suspension[1], d.suspension[2], d.suspension[3]));
  if (level < MINOR) return { text: w.noDamage, cls: "text-lc-slate" };
  return level >= HEAVY ? { text: w.damageLine(part, w.damageHeavy), cls: "text-lc-loss" } : { text: w.damageLine(part, w.damageMinor), cls: "text-lc-caution" };
}

const CarCondition: React.FC<{ t: CarTelemetry; w: EnduranceWords }> = ({ t, w }) => {
  const damage = t.race?.damage ?? t.practiceDamage;
  const line = damageLine(damage, w);
  return (
    <div role="group" aria-label={`${w.car}: ${line.text}`} className="absolute top-[48px] left-0 flex h-[168px] w-[140px] flex-col items-center justify-between pt-2 pb-2.5">
      <svg viewBox="0 0 100 144" width={96} height={138} aria-hidden>
        <TopDownCar openWheel={carClassCode(t) === "openWheel"} damage={damage} t={t} showWheels />
      </svg>
      <span className={`lc-mono max-w-full truncate px-1 text-[10px] leading-none font-extrabold tracking-[0.12em] uppercase ${line.cls}`}>{line.text}</span>
    </div>
  );
};

/* ── Fuel and energy ─────────────────────────────────────────────────────── */

const Tank: React.FC<{ label: string; labelCls: string; fill: number; fillCls: string; text: string; value: string; textCls?: string }> = ({
  label,
  labelCls,
  fill,
  fillCls,
  text,
  value,
  textCls = "text-lc-chalk",
}) => (
  <div className={`col-span-2 grid h-[36px] grid-cols-subgrid items-center border-b px-3.5 ${HAIR}`}>
    <span className={`${LBL} ${labelCls}`}>{label}</span>
    <div className="relative h-[22px] bg-lc-titanium">
      <span aria-hidden className={`absolute inset-y-0 left-0 ${fillCls}`} style={{ width: `${(Math.min(1, Math.max(0, fill)) * 100).toFixed(1)}%` }} />
      <span className={`lc-mono absolute inset-0 flex items-center justify-between gap-2 px-2 text-[12px] leading-none font-bold [text-shadow:0_1px_2px_var(--color-lc-void)] ${textCls}`}>
        <span className="truncate">{text}</span>
        <span className="shrink-0 text-lc-chalk">{value}</span>
      </span>
    </div>
  </div>
);

const FuelTank: React.FC<{ t: CarTelemetry; w: EnduranceWords }> = ({ t, w }) => {
  const startKg = useStartFuel();
  const perLap = useFuelPerLap();
  const laps = fuelLapsLeft(t.fuelKg, perLap);
  const race = t.race;
  // Laps still to run in a race, the lap being driven counted from where the car is on it
  const toGo = race?.totalLaps && race.phase === "racing" ? Math.max(0, race.totalLaps - (race.lap - 1 + t.trackProgress)) : null;
  // Laps the fuel falls short of the flag by, or null while it lasts (or is not measured yet)
  const shortBy = laps !== null && toGo !== null && laps < toGo ? toGo - laps : null;
  const short = shortBy !== null;
  const text = laps === null ? "" : shortBy !== null ? w.fuelShort(shortBy.toFixed(1)) : w.fuelLaps(laps.toFixed(1));
  return (
    <Tank
      label={w.fuel}
      labelCls={short ? "text-lc-loss" : "text-lc-caution"}
      fill={startKg > 0 ? t.fuelKg / startKg : 0}
      fillCls={short ? "bg-lc-loss/70" : "bg-lc-caution/60"}
      text={text}
      value={w.fuelKg(t.fuelKg.toFixed(1))}
    />
  );
};

const ERS_CODES: readonly ErsModeCode[] = ["CHR", "LIC", "BAL", "RAC", "PSH"];

const ErsTank: React.FC<{ t: CarTelemetry; w: EnduranceWords }> = ({ t, w }) => {
  const b = ersButtons(t);
  const code = (t.liveTuner?.ersMode ?? "").slice(0, 3).toUpperCase() as ErsModeCode;
  const mode = ERS_CODES.includes(code) ? w.ersMode[code] : "";
  const state =
    b.overtake === "lowGrip"
      ? w.lowGrip
      : b.overtake === "on" || b.overtake === "auto"
        ? w.overtakeOn
        : b.boostOn
          ? t.ersBoostActive !== undefined
            ? w.boostOn
            : w.overtakeOn
          : b.overtake === "available"
            ? w.overtakeReady
            : b.overtake === "locked" || b.boostLocked
              ? w.overtakeLocked
              : "";
  const pct = Math.min(100, Math.max(0, t.ersBatteryPercent));
  const low = pct < 10;
  return (
    <Tank
      label={w.ers}
      labelCls={low ? "text-lc-loss" : "text-lc-info"}
      fill={pct / 100}
      fillCls={low ? "bg-lc-loss/70" : "bg-lc-info/55"}
      text={mode && state ? `${mode} · ${state}` : mode || state}
      value={`${Math.round(pct)}%`}
    />
  );
};

/* ── Electronics ─────────────────────────────────────────────────────────── */

const Aid: React.FC<{ label: string; value: string; working?: boolean; spoken?: string }> = ({ label, value, working = false, spoken }) => (
  <span className="relative flex h-full items-baseline gap-1.5 pt-[10px]" aria-label={working ? spoken : undefined}>
    <span className={LBL}>{label}</span>
    <span className={`lc-data text-[16px] leading-none ${working ? "text-lc-caution" : "text-lc-chalk"}`}>{value}</span>
    {/* The aid is cutting in: a bar under it as well as the colour */}
    {working ? <span aria-hidden className="absolute inset-x-0 bottom-0 h-[3px] bg-lc-caution" /> : null}
  </span>
);

const Electronics: React.FC<{ t: CarTelemetry; w: EnduranceWords }> = ({ t, w }) => {
  const tuner = t.liveTuner;
  if (!tuner) return null;
  const aids = aidsActive(t);
  return (
    <div role="group" aria-label={w.electronics} className="flex h-[34px] items-stretch justify-between px-3.5">
      <Aid label={w.tc} value={tuner.tcLevel > 0 ? String(tuner.tcLevel) : w.off} working={aids.tc} spoken={w.aidWorking(w.tc)} />
      <Aid label={w.abs} value={tuner.absLevel > 0 ? String(tuner.absLevel) : w.off} working={aids.abs} spoken={w.aidWorking(w.abs)} />
      <Aid label={w.bias} value={tuner.brakeBiasPct.toFixed(1)} />
      <Aid label={w.engineMap} value={String(tuner.engineMap)} />
    </div>
  );
};

/* ── The group ───────────────────────────────────────────────────────────── */

export const EnduranceDial: React.FC<{ t: CarTelemetry; revRange: [number, number]; w: EnduranceWords }> = ({ t, revRange, w }) => {
  const hasErs = t.f12026?.hasErs ?? t.liveTuner?.hasErs ?? false;
  return (
    <div className="w-[356px]">
      {/* The dial stands 48 px out of the plate's top */}
      <div className="relative h-[216px]">
        <div aria-hidden className={`absolute inset-x-0 top-[48px] bottom-0 ${PLATE}`} />
        <CarCondition t={t} w={w} />
        <Dial t={t} revRange={revRange} w={w} />
      </div>
      <div className={`border-t ${HAIR} ${PLATE}`}>
        {/* The two tanks share their label column, as wide as the longer label (German "Kraftstoff", Portuguese
            "Combustível"), so their bars start together and no label runs under a bar */}
        <div className="grid grid-cols-[minmax(38px,max-content)_1fr] gap-x-2.5">
          <FuelTank t={t} w={w} />
          {hasErs ? <ErsTank t={t} w={w} /> : null}
        </div>
        <Electronics t={t} w={w} />
      </div>
    </div>
  );
};
