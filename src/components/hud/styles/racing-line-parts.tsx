"use client";

import React, { useMemo, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl/react";
import type { TireCompound } from "@/types/f1";
import type { ErsState } from "./game-style-parts";
import { formatOnce } from "./hud-style-parts";
import { onUiViewportChange, uiViewportWidth } from "@/lib/display/ui-frame";

/**
 * What the Racing line layout's files share (RacingLineHud.tsx, racing-line-pages.tsx): its one shape, its label, its
 * words and the size it draws at where the window is too small for it.
 */

/** The one shape: a hard void plate, no radius, no blur, no border */
export const PLATE = "bg-lc-void/90";
/** Hairline between the rows of a plate */
export const HAIR = "border-white/8";
/** The plate's one 45 degree cut, bottom right or bottom left (16 px) */
export const CUT_BR = "[clip-path:polygon(0_0,100%_0,100%_calc(100%_-_16px),calc(100%_-_16px)_100%,0_100%)]";
export const CUT_BL = "[clip-path:polygon(0_0,100%_0,100%_100%,16px_100%,0_calc(100%_-_16px))]";
/** The logo's 12 degree slant, and its inverse for what sits inside a slanted plate */
export const SLANT = "-skew-x-12";
export const UNSLANT = "skew-x-12";
/** Field label in the colour its place gives it: mono 700, 10 px, tracked caps */
export const LBL_INK = "lc-mono text-[10px] leading-none font-bold tracking-[0.16em] whitespace-nowrap uppercase";
/** Field label: slate */
export const LBL = `${LBL_INK} text-lc-slate`;
/** A word in a block or on a tab: mono 800, 11 px, tracked caps */
export const TAG = "lc-mono text-[11px] leading-none font-extrabold tracking-[0.14em] whitespace-nowrap uppercase";
/** No value yet */
export const NONE = "--";

/**
 * The room the layout needs at 100 % (px): across, the cluster with the paged box beside it, mirrored (the widest
 * row); down, the timing plate and map over the folded MFD and the paged box
 */
const NEED_W = 1552;
const NEED_H = 780;

const readCap = () => {
  const h = window.innerHeight;
  // The HUD keeps to a centred 2.4:1 frame on an ultrawide screen
  const w = Math.min(uiViewportWidth(), h * 2.4);
  // In steps of 2 %, so dragging a window edge re-renders the HUD a few times, not on every pixel
  return Math.floor(Math.min(w / NEED_W, h / NEED_H) * 50) / 50;
};
// The window, or the centre screen of three
const onResize = onUiViewportChange;

/**
 * The size the layout draws at: the HUD size, held to what the window has room for. Its groups are wide (it is drawn
 * for a 1080p window), so on a 720p-class window, or at a large HUD size, they would meet at their full size.
 */
export function useRacingLineScale(scale = 1): number {
  const cap = useSyncExternalStore(onResize, readCap, () => 4);
  return Math.min(scale, cap);
}

export type PageId = "tyres" | "fuel" | "car" | "order";
export type TyreState = "hot" | "cold" | "flat";
/** What the energy line of the cluster says: the driver's Overtake where the car has one, else what the store is doing */
export type EnergyWord = ErsState | "overtakeOn" | "overtakeAuto" | "overtakeReady" | "overtakeLocked" | "lowGrip";

/** The figure of a lap or field count, set larger than the words round it */
const strong = (chunks: React.ReactNode) => <b className="text-[17px] font-bold text-lc-chalk">{chunks}</b>;

/** The layout's words, resolved once per language: it re-renders with every telemetry frame */
export function useRacingLineWords() {
  const tx = useTranslations("hudStyles.racingLine");
  const txCompound = useTranslations("common.compounds.name");
  return useMemo(
    () => ({
      race: tx("race"),
      session: tx("session"),
      positionOf: formatOnce((position: number, total: number) => tx("positionOf", { position, total })),
      position: formatOnce((position: number) => tx("position", { position })),
      fieldOf: formatOnce((total: number) => tx.rich("fieldOf", { total, n: strong })),
      lapOf: formatOnce((lap: number, total: number) => tx.rich("lapOf", { lap, total, n: strong })),
      lap: formatOnce((lap: number) => tx.rich("lap", { lap, n: strong })),
      run: formatOnce((lap: number) => tx.rich("run", { lap, n: strong })),
      outLap: tx("outLap"),
      flag: {
        grid: tx("flag.grid"),
        green: tx("flag.green"),
        yellow: tx("flag.yellow"),
        doubleYellow: tx("flag.doubleYellow"),
        blue: tx("flag.blue"),
        vsc: tx("flag.vsc"),
        vscEnding: tx("flag.vscEnding"),
        finalLap: tx("flag.finalLap"),
        finished: tx("flag.finished"),
      },
      closing: tx("closing"),
      losing: tx("losing"),
      steady: tx("steady"),
      out: tx("out"),
      penalty: formatOnce((seconds: number) => tx("penalty", { seconds })),
      weather: tx("weather"),
      rain: tx("rain"),
      radar: tx("radar"),
      limits: tx("limits"),
      time: tx("time"),
      delta: tx("delta"),
      deltaBest: tx("deltaBest"),
      pred: tx("pred"),
      timing: tx("timing"),
      lapTime: tx("lapTime"),
      onPb: tx("onPb"),
      invalid: tx("invalid"),
      sectors: [tx("sector", { sector: 1 }), tx("sector", { sector: 2 }), tx("sector", { sector: 3 })] as const,
      last: tx("last"),
      best: tx("best"),
      sessionBest: tx("sessionBest"),
      circuit: tx("circuit"),
      cluster: tx("cluster"),
      brake: tx("brake"),
      throttle: tx("throttle"),
      gear: formatOnce((gear: string) => tx("gear", { gear })),
      ers: tx("ers"),
      rpm: tx("rpm"),
      top: tx("top"),
      shift: tx("shift"),
      ersModes: {
        CHR: tx("ersModes.CHR"),
        LIC: tx("ersModes.LIC"),
        BAL: tx("ersModes.BAL"),
        RAC: tx("ersModes.RAC"),
        PSH: tx("ersModes.PSH"),
      } as Record<string, string | undefined>,
      energy: {
        overtakeOn: tx("ersState.overtakeOn"),
        overtakeAuto: tx("ersState.overtakeAuto"),
        overtakeReady: tx("ersState.overtakeReady"),
        overtakeLocked: tx("ersState.overtakeLocked"),
        lowGrip: tx("ersState.lowGrip"),
        boost: tx("ersState.boost"),
        overtake: tx("ersState.overtakeOn"),
        deploy: tx("ersState.deploy"),
        clipped: tx("ersState.clipped"),
        superclip: tx("ersState.superclip"),
        braking: tx("ersState.braking"),
        liftCoast: tx("ersState.liftCoast"),
        trickle: tx("ersState.trickle"),
        neutral: tx("ersState.neutral"),
      } satisfies Record<EnergyWord, string>,
      electronics: tx("electronics"),
      tc: tx("tc"),
      abs: tx("abs"),
      bias: tx("bias"),
      map: tx("map"),
      fuel: tx("fuel"),
      kg: tx("kg"),
      laps: tx("laps"),
      off: tx("off"),
      pagesLabel: tx("pages.label"),
      pages: {
        tyres: tx("pages.tyres"),
        fuel: tx("pages.fuel"),
        car: tx("pages.car"),
        order: tx("pages.order"),
      } satisfies Record<PageId, string>,
      compounds: {
        supersoft: txCompound("supersoft"),
        soft: txCompound("soft"),
        medium: txCompound("medium"),
        hard: txCompound("hard"),
        intermediate: txCompound("intermediate"),
        wet: txCompound("wet"),
      } satisfies Record<TireCompound, string>,
      tyreLife: formatOnce((pct: number) => tx("tyres.life", { pct })),
      tyreWindow: formatOnce((low: string, high: string) => tx("tyres.window", { low, high })),
      tyreState: { hot: tx("tyres.hot"), cold: tx("tyres.cold"), flat: tx("tyres.flat") } satisfies Record<TyreState, string>,
      tyreCorner: formatOnce((corner: string, temp: string, pressure: string, brake: string) => tx("tyres.corner", { corner, temp, pressure, brake })),
      corners: [tx("tyres.fl"), tx("tyres.fr"), tx("tyres.rl"), tx("tyres.rr")] as const,
      fuelPage: {
        onBoard: tx("fuelPage.onBoard"),
        perLap: tx("fuelPage.perLap"),
        lapsOfFuel: tx("fuelPage.lapsOfFuel"),
        lapsToGo: tx("fuelPage.lapsToGo"),
        atFlag: tx("fuelPage.atFlag"),
        spare: tx("fuelPage.spare"),
        short: tx("fuelPage.short"),
        used: tx("fuelPage.used"),
        noFuel: tx("fuelPage.noFuel"),
      },
      carPage: {
        noDamage: tx("carPage.noDamage"),
        damage: formatOnce((pct: number) => tx("carPage.damage", { pct })),
        zones: [tx("carPage.front"), tx("carPage.rear"), tx("carPage.left"), tx("carPage.right")] as const,
        puncture: tx("carPage.puncture"),
        topSpeed: tx("carPage.topSpeed"),
        diagram: tx("carPage.diagram"),
      },
      orderPage: {
        title: tx("orderPage.title"),
        interval: tx("orderPage.interval"),
        toLeader: tx("orderPage.toLeader"),
        lead: tx("orderPage.lead"),
        out: tx("orderPage.out"),
      },
    }),
    [tx, txCompound],
  );
}

export type Words = ReturnType<typeof useRacingLineWords>;
