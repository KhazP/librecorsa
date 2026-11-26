"use client";

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl/react";
import type { CarTelemetry } from "@/types/f1";
import { Trend } from "@/components/ui/icons/Trend";
import { formatOnce } from "./hud-style-parts";
import { onUiViewportChange, uiViewportWidth } from "@/lib/display/ui-frame";

/**
 * What the Pit wall layout's boxes share: the hard plate, its hairlines and type, the words, and how much of the
 * window there is to fill.
 */

/** Distance of each corner group from the HUD frame's edge: 32 px on a 1080p window, less on a small one */
export const EDGE = "clamp(12px,1.67cqw,32px)";
/** The one box: a hard void plate with a line edge, no radius and no blur */
export const BOX = "border border-lc-line bg-lc-void/93 text-lc-chalk";
/** A box's head bar */
export const HEAD = "border-b border-lc-line bg-lc-carbon";
/** The hairline under a table row */
export const HAIR = "border-b border-white/9";
/** A table's column heads */
export const COLS = "bg-lc-carbon/60";
const LBL_TYPE = "lc-mono text-[10px] leading-none font-bold uppercase whitespace-nowrap";
/** A field label: mono caps, tracked, slate */
export const LBL = `${LBL_TYPE} tracking-[0.16em] text-lc-slate`;
/** A field label in another ink (a class such as `text-lc-chalk`): a constant never carries two inks */
export const lbl = (ink: string) => `${LBL_TYPE} tracking-[0.16em] ${ink}`;
/** A unit beside a reading: the label, set tighter */
export const LBL_UNIT = `${LBL_TYPE} tracking-[0.04em] text-lc-slate`;
const NUM_TYPE = "lc-mono leading-none whitespace-nowrap";
/** A reading: mono, tabular figures */
export const NUM = `${NUM_TYPE} font-semibold`;
/** A reading that leads its row (a gap, a position) */
export const NUMB = `${NUM_TYPE} font-bold`;
/** A small word plate inside a row (invalid, a lap up, a penalty) */
export const TAG = "lc-mono inline-flex h-4 shrink-0 items-center gap-1 px-1 text-[10px] leading-none font-extrabold tracking-[0.08em] uppercase whitespace-nowrap";
/** The placeholder of a reading that does not exist yet */
export const NONE = "--";

export type PitWallWords = ReturnType<typeof usePitWallWords>;

/** The layout's words in the current language, resolved once per language */
export function usePitWallWords() {
  const tx = useTranslations("hudStyles.pitWall");
  return useMemo(
    () => ({
      region: {
        lapTiming: tx("region.lapTiming"),
        delta: tx("region.delta"),
        spotter: tx("region.spotter"),
        relative: tx("region.relative"),
        driver: tx("region.driver"),
        detail: tx("region.detail"),
        pages: tx("region.pages"),
        status: tx("region.status"),
      },
      positionShort: formatOnce((position: number) => tx("positionShort", { position: String(position) })),
      positionOf: formatOnce((position: number, total: number) => tx("positionOf", { position: String(position), total: String(total) })),
      ofField: formatOnce((total: number) => tx("ofField", { total: String(total) })),
      lapOf: formatOnce((lap: number, total: number) => tx("lapOf", { lap: String(lap), total: String(total) })),
      lap: formatOnce((lap: number) => tx("lap", { lap: String(lap) })),
      run: formatOnce((lap: number) => tx("run", { lap: String(lap) })),
      outLap: tx("outLap"),
      flag: {
        green: tx("flag.green"),
        yellow: tx("flag.yellow"),
        doubleYellow: tx("flag.doubleYellow"),
        vsc: tx("flag.vsc"),
        vscEnding: tx("flag.vscEnding"),
        blue: tx("flag.blue"),
        finalLap: tx("flag.finalLap"),
        finished: tx("flag.finished"),
        grid: tx("flag.grid"),
      },
      current: tx("current"),
      invalid: tx("invalid"),
      last: tx("last"),
      best: tx("best"),
      sessionBest: tx("sessionBest"),
      optimal: tx("optimal"),
      sector: tx("sector"),
      time: tx("time"),
      timeLeft: tx("timeLeft"),
      deltaBest: tx("deltaBest"),
      sectorShort: [1, 2, 3].map((sector) => tx("sectorShort", { sector: String(sector) })),
      markBest: tx("markBest"),
      markPb: tx("markPb"),
      live: tx("live"),
      ahead: tx("ahead"),
      behind: tx("behind"),
      limits: tx("limits"),
      penalty: formatOnce((seconds: number) => tx("penalty", { seconds: String(seconds) })),
      trend: { yourWay: tx("trend.yourWay"), against: tx("trend.against"), steady: tx("trend.steady") },
      carLeft: tx("carLeft"),
      carRight: tx("carRight"),
      carBoth: tx("carBoth"),
      relative: tx("relative"),
      gapToYou: tx("gapToYou"),
      lapsUp: formatOnce((laps: number) => tx("lapsUp", { laps: String(laps) })),
      lapsDown: formatOnce((laps: number) => tx("lapsDown", { laps: String(laps) })),
      rpm: tx("rpm"),
      shift: tx("shift"),
      pedal: {
        clutch: tx("pedal.clutch"),
        brake: tx("pedal.brake"),
        throttle: tx("pedal.throttle"),
        clutchShort: tx("pedal.clutchShort"),
        brakeShort: tx("pedal.brakeShort"),
        throttleShort: tx("pedal.throttleShort"),
      },
      steering: tx("steering"),
      tab: {
        order: tx("tab.order"),
        laps: tx("tab.laps"),
        fuel: tx("tab.fuel"),
        tyres: tx("tab.tyres"),
        car: tx("tab.car"),
        damage: tx("tab.damage"),
      },
      order: {
        pos: tx("order.pos"),
        driver: tx("order.driver"),
        interval: tx("order.interval"),
        gap: tx("order.gap"),
        leader: tx("order.leader"),
        best: tx("order.best"),
        fastest: tx("order.fastest"),
        out: tx("order.out"),
        finished: tx("order.finished"),
      },
      laps: { lap: tx("laps.lap"), none: tx("laps.none") },
      fuel: {
        short: tx("fuel.short"),
        onBoard: tx("fuel.onBoard"),
        perLap: tx("fuel.perLap"),
        perLapShort: tx("fuel.perLapShort"),
        lapsOfFuel: tx("fuel.lapsOfFuel"),
        used: tx("fuel.used"),
        lapsToGo: tx("fuel.lapsToGo"),
        margin: tx("fuel.margin"),
        battery: tx("fuel.battery"),
        mguk: tx("fuel.mguk"),
        deploy: tx("fuel.deploy"),
        harvest: tx("fuel.harvest"),
        idle: tx("fuel.idle"),
        kg: tx("fuel.kg"),
        laps: tx("fuel.laps"),
        kw: tx("fuel.kw"),
      },
      tyre: {
        corners: [tx("tyre.frontLeft"), tx("tyre.frontRight"), tx("tyre.rearLeft"), tx("tyre.rearRight")] as const,
        tread: tx("tyre.tread"),
        hot: tx("tyre.hot"),
        cold: tx("tyre.cold"),
        puncture: tx("tyre.puncture"),
        outer: tx("tyre.outer"),
        middle: tx("tyre.middle"),
        inner: tx("tyre.inner"),
        brake: tx("tyre.brake"),
      },
      car: {
        tc: tx("car.tc"),
        tcCut: tx("car.tcCut"),
        tcSlip: tx("car.tcSlip"),
        abs: tx("car.abs"),
        off: tx("car.off"),
        active: tx("car.active"),
        bias: tx("car.bias"),
        brakeBias: tx("car.brakeBias"),
        migration: tx("car.migration"),
        map: tx("car.map"),
        engineMap: tx("car.engineMap"),
        ers: tx("car.ers"),
        ersMode: tx("car.ersMode"),
        boost: tx("car.boost"),
        overtake: tx("car.overtake"),
        motor: tx("car.motor"),
        regen: tx("car.regen"),
        diffEntry: tx("car.diffEntry"),
        diffMid: tx("car.diffMid"),
        diffExit: tx("car.diffExit"),
        aero: tx("car.aero"),
        aeroBalance: tx("car.aeroBalance"),
        front: tx("car.front"),
        downforce: tx("car.downforce"),
        topSpeed: tx("car.topSpeed"),
        kgf: tx("car.kgf"),
      },
      damage: {
        overall: tx("damage.overall"),
        front: tx("damage.front"),
        rear: tx("damage.rear"),
        left: tx("damage.left"),
        right: tx("damage.right"),
        suspension: tx("damage.suspension"),
        tyres: tx("damage.tyres"),
        ok: tx("damage.ok"),
        flat: tx("damage.flat"),
        status: tx("damage.status"),
        running: tx("damage.running"),
        terminal: tx("damage.terminal"),
        corners: [tx("damage.cornerFL"), tx("damage.cornerFR"), tx("damage.cornerRL"), tx("damage.cornerRR")] as const,
      },
    }),
    [tx],
  );
}

/** A gap change smaller than this over the trend window reads as steady (s), as the split gaps read it */
const STEADY_S = 0.05;

/**
 * How the gap to the car directly ahead or behind moved: the arrow up when it went the player's way (closing on the
 * car ahead, pulling away from the car behind), down when it did not, and by how much. Blank until the race knows.
 */
export const GapTrend: React.FC<{ changeS: number | undefined; side: "ahead" | "behind"; w: PitWallWords; className?: string }> = ({
  changeS,
  side,
  w,
  className = "",
}) => {
  if (changeS === undefined) return <span className={className} />;
  const moving = Math.abs(changeS) >= STEADY_S;
  const good = moving && (side === "ahead" ? changeS < 0 : changeS > 0);
  return (
    <span
      className={`${NUMB} inline-flex items-center justify-end gap-[5px] text-[12px] ${moving ? (good ? "text-lc-gain" : "text-lc-loss") : "text-lc-slate"} ${className}`}
    >
      <Trend direction={moving ? (good ? "up" : "down") : "level"} size={9} label={moving ? (good ? w.trend.yourWay : w.trend.against) : w.trend.steady} />
      {Math.abs(changeS).toFixed(2)}
    </span>
  );
};

// The window, or the centre screen of three
const subscribeResize = onUiViewportChange;
const windowWidth = uiViewportWidth;
const windowHeight = () => window.innerHeight;

/** How much room the layout has, in its own pixels (the window over the HUD size) */
export interface PitWallFit {
  /** Under 850 px tall: the sectors fold to one row and the relative shows two cars each way */
  short: boolean;
  /** Under 620 px tall: the relative table goes, the speed block stays */
  tiny: boolean;
  /** Under 1240 px wide: the delta bar narrows to clear the lap timing box */
  narrow: boolean;
}

export function usePitWallFit(scale: number | undefined): PitWallFit {
  const width = useSyncExternalStore(subscribeResize, windowWidth, () => 1920);
  const height = useSyncExternalStore(subscribeResize, windowHeight, () => 1080);
  const s = scale && scale > 0 ? scale : 1;
  const h = height / s;
  // Past 2.4:1 the HUD keeps to a centred frame
  const wd = Math.min(width, height * 2.4) / s;
  return useMemo(() => ({ short: h < 850, tiny: h < 620, narrow: wd < 1240 }), [h, wd]);
}

/** An rpm as "11 480": a space between the thousands, no locale formatting on the frame */
export function formatRpm(rpm: number): string {
  const r = Math.max(0, Math.round(Number.isFinite(rpm) ? rpm : 0));
  return r >= 1000 ? `${Math.floor(r / 1000)} ${String(r % 1000).padStart(3, "0")}` : String(r);
}

type Bests = readonly [number | null, number | null, number | null];

/**
 * The player's best sectors as they stood when the running lap started. The sim's own bests take a new best the moment
 * its sector ends, so a sector compared with them would read level; compared with these it reads how much it took off.
 * A new run starts again from the bests it comes with.
 */
export function useLapStartBests(t: Pick<CarTelemetry, "bestSectorTimesMs" | "lapCount" | "runId">): Bests {
  const runId = t.runId ?? 0;
  const [held, setHeld] = useState<{ runId: number; lap: number; bests: Bests }>(() => ({ runId, lap: t.lapCount, bests: [...t.bestSectorTimesMs] }));
  const latest = useRef(t.bestSectorTimesMs);
  latest.current = t.bestSectorTimesMs;
  useEffect(() => {
    setHeld((h) => (h.runId === runId && h.lap === t.lapCount ? h : { runId, lap: t.lapCount, bests: [...latest.current] }));
  }, [runId, t.lapCount]);
  return held.bests;
}
