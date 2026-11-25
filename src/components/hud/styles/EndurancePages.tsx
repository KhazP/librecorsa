"use client";

import React, { useCallback, useState } from "react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { Icon } from "@/components/ui/icons/Icon";
import type { IconName } from "@/components/ui/icons/registry";
import { useUnits } from "@/lib/settings/ui-prefs";
import type { UnitSettings } from "@/lib/settings/player-settings";
import { formatGap, formatLapTime, formatPressurePsi, formatSectorTime, formatTemp, pressureUnit, tyreHeatColor } from "../hud-format";
import { cornerData } from "../TyreBrakeWidget";
import { driverLabel, relativeCars } from "../third-party-data";
import { useLapHistory } from "./third-party-parts";
import { HAIR, LBL, PLATE, TAG, inkOn, type EnduranceWords } from "./EnduranceWords";

/**
 * Bottom left of the Endurance layout: one plate, one page at a time, the tabs along its top. Tyres (wear rings, tread
 * temperature across the tyre, pressure, brake disc) is the page it opens on; Relative lists the cars nearest on the
 * road and Laps the laps of this run. The tabs take a click; no key is bound to them.
 */

type PageId = "tyres" | "relative" | "laps";
const PAGES: readonly { id: PageId; icon: IconName }[] = [
  { id: "tyres", icon: "tyre" },
  { id: "relative", icon: "slipstream" },
  { id: "laps", icon: "lapTimes" },
];
const PAGE_KEY = "lc.endurancePage";

function readPage(): PageId {
  try {
    const saved = window.localStorage.getItem(PAGE_KEY);
    if (saved === "relative" || saved === "laps") return saved;
  } catch {
    // Not remembered: the tyre page
  }
  return "tyres";
}

/** A car laps up is tangerine (let it by), laps down azure (you are lapping it), as on the MFD; the tag says it too */
const LAP_UP = "var(--color-lc-tangerine)";
const LAP_DOWN = "var(--color-lc-azure)";

/* ── Tyres ───────────────────────────────────────────────────────────────── */

const RING_R = 24;
/** The working window drawn when the car's telemetry carries none (the one `tyreHeatColor` assumes) */
const DEFAULT_WINDOW: readonly [number, number] = [85, 105];

const TyreCell: React.FC<{ t: CarTelemetry; i: number; punctured: boolean; units: UnitSettings; w: EnduranceWords }> = ({ t, i, punctured, units, w }) => {
  const c = cornerData(t, i);
  const range = t.tireOptimalTempC ?? DEFAULT_WINDOW;
  const tread = Math.round(punctured ? 0 : c.life);
  const hot = c.temp > range[1];
  const cold = c.temp < range[0];
  const ring = punctured || tread < 25 ? "var(--color-lc-loss)" : tread < 55 ? "var(--color-lc-caution)" : "var(--color-lc-chalk)";
  const temp = formatTemp(c.temp, units);
  const pressure = c.psi === null ? null : formatPressurePsi(c.psi, units);
  const brake = formatTemp(c.brake, units);
  // One word beside the temperature: out of the window first, else the tyre's worst condition (graining, a flat spot)
  const state = hot
    ? { word: w.hot, cls: "text-lc-loss" }
    : cold
      ? { word: w.cold, cls: "text-lc-cold" }
      : c.conditions[0]
        ? { word: c.conditions[0].label, cls: "text-lc-caution" }
        : null;
  return (
    <div
      role="group"
      aria-label={w.tyre({ corner: w.corners[i], tread: String(tread), temp, pressure: pressure === null ? "" : `${pressure} ${pressureUnit(units)}`, brake })}
      className={`grid grid-cols-[58px_1fr] items-center gap-3 px-3.5 py-2.5 ${i % 2 === 0 ? `border-r ${HAIR}` : ""} ${i < 2 ? `border-b ${HAIR}` : ""}`}
    >
      <div className="relative size-[58px]" aria-hidden>
        <svg viewBox="0 0 58 58" className="absolute inset-0 size-full" fill="none">
          <circle cx={29} cy={29} r={RING_R} stroke="var(--color-lc-titanium)" strokeWidth={6} />
          {punctured ? (
            <circle cx={29} cy={29} r={RING_R} stroke={ring} strokeWidth={6} strokeDasharray="5 4" />
          ) : tread > 0 ? (
            <circle cx={29} cy={29} r={RING_R} stroke={ring} strokeWidth={6} pathLength={100} strokeDasharray={`${tread} 100`} transform="rotate(-90 29 29)" />
          ) : null}
        </svg>
        <span className="absolute inset-0 flex items-center justify-center">
          {punctured ? (
            <span className="lc-mono text-[10px] leading-none font-extrabold tracking-[0.08em] text-lc-loss uppercase">{w.flat}</span>
          ) : (
            <span className="lc-data flex items-baseline text-[16px] leading-none text-lc-chalk">
              {tread}
              <span className="ml-px text-[9px] text-lc-slate">%</span>
            </span>
          )}
        </span>
      </div>
      <div className="min-w-0" aria-hidden>
        <div className="flex items-baseline gap-2">
          <span className={`lc-mono text-[20px] leading-none font-semibold ${hot ? "text-lc-loss" : cold ? "text-lc-cold" : "text-lc-chalk"}`}>{temp}</span>
          {state ? <span className={`lc-mono min-w-0 truncate text-[10px] leading-none font-extrabold tracking-[0.1em] uppercase ${state.cls}`}>{state.word}</span> : null}
        </div>
        <div className="mt-[7px] flex items-stretch justify-between gap-2">
          <div className="lc-mono grid gap-[4px] text-[13px] leading-none font-semibold whitespace-nowrap text-lc-chalk">
            <span>
              {pressure ?? "--"}
              <span className="ml-1 text-[10px] font-bold tracking-[0.1em] text-lc-slate uppercase">{pressureUnit(units)}</span>
            </span>
            <span>
              {brake}
              <span className="ml-1 text-[10px] font-bold tracking-[0.1em] text-lc-slate uppercase">{w.brake}</span>
            </span>
          </div>
          {/* The tread from behind: its three bands, each in its own temperature colour */}
          <span className="flex gap-[2px]">
            {c.bands.map((b, k) => (
              <span key={k} className="block w-[7px]" style={{ backgroundColor: tyreHeatColor(b, range) }} />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
};

const TyrePage: React.FC<{ t: CarTelemetry; w: EnduranceWords }> = ({ t, w }) => {
  const units = useUnits();
  // The damage lists its corners FR, FL, RR, RL; the tyres FL, FR, RL, RR
  const punctured = (t.race?.damage ?? t.practiceDamage)?.punctured;
  return (
    <div className="grid grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <TyreCell key={i} t={t} i={i} punctured={Boolean(punctured?.[i ^ 1])} units={units} w={w} />
      ))}
    </div>
  );
};

/* ── Relative ────────────────────────────────────────────────────────────── */

const RelativePage: React.FC<{ t: CarTelemetry; lengthM: number; w: EnduranceWords }> = ({ t, lengthM, w }) => {
  const cars = relativeCars(t, lengthM, 2);
  const standings = t.race?.standings;
  if (!standings || cars.length < 2) return <Empty word={w.noCars} />;
  return (
    <ol className="flex h-[156px] flex-col justify-center">
      {cars.map(({ entry: e, gapS, lapsAhead }) => {
        const pos = standings.indexOf(e) + 1;
        const name = driverLabel(e);
        return (
          <li
            key={e.driverCode}
            aria-label={w.row(pos, name)}
            className={`grid h-[31px] grid-cols-[38px_1fr_auto_74px] items-center border-b last:border-b-0 ${HAIR} ${e.isPlayer ? "bg-lc-volt text-lc-void" : "text-lc-chalk"}`}
          >
            <span
              className="lc-data ml-2 grid h-5 place-items-center text-[12px] leading-none"
              style={e.isPlayer ? { backgroundColor: "var(--color-lc-void)", color: "var(--color-lc-volt)" } : { backgroundColor: e.teamColorHex, color: inkOn(e.teamColorHex) }}
            >
              {pos}
            </span>
            <span className="truncate pl-2.5 text-[14px] leading-none font-semibold">{name}</span>
            {lapsAhead !== 0 ? (
              <span className="lc-mono mr-1 text-[10px] leading-none font-extrabold tracking-[0.06em]" style={{ color: lapsAhead > 0 ? LAP_UP : LAP_DOWN }}>
                {lapsAhead > 0 ? w.lapsUp(lapsAhead) : w.lapsDown(-lapsAhead)}
              </span>
            ) : (
              <span />
            )}
            <span className={`lc-data pr-3 text-right text-[13px] leading-none ${e.isPlayer ? "" : gapS > 0 ? "text-lc-chalk" : "text-lc-fog"}`}>
              {/* Ahead of the player is minus, behind is plus, as the split gaps count */}
              {e.isPlayer ? "" : `${gapS > 0 ? "−" : "+"}${formatGap(gapS, true)}`}
            </span>
          </li>
        );
      })}
    </ol>
  );
};

/* ── Laps ────────────────────────────────────────────────────────────────── */

const LAP_COLS = "grid grid-cols-[44px_1fr_1fr_1fr_92px] items-center px-3.5";

const LapsPage: React.FC<{ t: CarTelemetry; w: EnduranceWords }> = ({ t, w }) => {
  const laps = useLapHistory(4);
  if (laps.length === 0) return <Empty word={w.noLaps} />;
  return (
    <div className="h-[156px]">
      <div className={`${LAP_COLS} h-6 border-b ${HAIR}`}>
        <span className={LBL}>{w.lapHead}</span>
        {w.sectors.map((s) => (
          <span key={s} className={`${LBL} text-right`}>
            {s}
          </span>
        ))}
        <span className={`${LBL} text-right`}>{w.timeHead}</span>
      </div>
      {laps.map((lap) => {
        const best = lap.valid && t.bestLapTimeMs !== null && lap.ms <= t.bestLapTimeMs + 0.5;
        return (
          <div key={lap.lap} className={`${LAP_COLS} lc-mono h-[33px] border-b text-[13px] leading-none font-semibold text-lc-fog last:border-b-0 ${HAIR}`}>
            <span className="text-lc-chalk">{w.lapShort(lap.lap)}</span>
            {lap.sectorsMs.map((ms, k) => (
              <span key={k} className="text-right">
                {formatSectorTime(ms)}
              </span>
            ))}
            <span className={`flex items-center justify-end gap-1.5 font-bold ${!lap.valid ? "text-lc-loss" : best ? "text-lc-best" : "text-lc-chalk"}`}>
              {!lap.valid ? <span className={`${TAG} bg-lc-loss text-lc-void`}>{w.lapCut}</span> : best ? <Icon name="time" size="xs" label={w.best} className="size-3" /> : null}
              {formatLapTime(lap.ms)}
            </span>
          </div>
        );
      })}
    </div>
  );
};

const Empty: React.FC<{ word: string }> = ({ word }) => (
  <div className="grid h-[156px] place-items-center">
    <span className={LBL}>{word}</span>
  </div>
);

/* ── The plate ───────────────────────────────────────────────────────────── */

export const EndurancePages: React.FC<{ t: CarTelemetry; compound: TireCompound; lengthM: number; w: EnduranceWords }> = ({ t, compound, lengthM, w }) => {
  const [page, setPage] = useState<PageId>(readPage);
  const units = useUnits();
  const choose = useCallback((p: PageId) => {
    setPage(p);
    try {
      window.localStorage.setItem(PAGE_KEY, p);
    } catch {
      // Not remembered across sessions
    }
  }, []);
  const names: Record<PageId, string> = { tyres: w.tyres, relative: w.relative, laps: w.laps };
  const range = t.tireOptimalTempC ?? DEFAULT_WINDOW;
  return (
    <section aria-label={names[page]} className={`w-[388px] ${PLATE}`}>
      <div className={`flex h-[34px] border-b ${HAIR}`}>
        <div role="tablist" aria-label={w.pages} className="flex">
          {PAGES.map(({ id, icon }) => {
            const on = id === page;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={on}
                aria-label={names[id]}
                title={names[id]}
                tabIndex={-1}
                // A click must not take the keyboard from the car
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(id)}
                className={`pointer-events-auto grid w-[46px] cursor-pointer place-items-center border-r outline-none ${HAIR} ${
                  on ? "bg-lc-line text-lc-chalk shadow-[inset_0_3px_0_var(--color-lc-chalk)]" : "text-lc-slate hover:bg-white/6 hover:text-lc-chalk"
                }`}
              >
                <Icon name={icon} size="sm" />
              </button>
            );
          })}
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2 pr-3.5 pl-2">
          <span className="lc-disp text-[15px] leading-none text-lc-chalk">{names[page]}</span>
          {page === "tyres" ? (
            <>
              <CompoundGlyph compound={compound} size={18} />
              <span className={`${LBL} truncate`}>{w.window(formatTemp(range[0], units).replace("°", ""), formatTemp(range[1], units))}</span>
            </>
          ) : null}
        </div>
      </div>
      <div role="tabpanel">
        {page === "tyres" ? <TyrePage t={t} w={w} /> : page === "relative" ? <RelativePage t={t} lengthM={lengthM} w={w} /> : <LapsPage t={t} w={w} />}
      </div>
    </section>
  );
};
