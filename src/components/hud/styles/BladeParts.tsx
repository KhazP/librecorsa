"use client";

import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useTranslations } from "use-intl/react";
import type { TireCompound } from "@/types/f1";
import { formatOnce } from "./hud-style-parts";

/** What the Blade layout's files share: its plate, its label, its fit to the window and its words */

export const EDGE = "clamp(14px,1.67vw,32px)";
/** The bottom corners sit a little closer to the side, to leave a gap to the blade's end */
export const CORNER_EDGE = "clamp(10px,1.04vw,20px)";
/** The plate every panel is cut from, and the darker strip of its column heads and footers */
export const PLATE = "bg-lc-void/90";
export const DEEP = "bg-lc-void/96";
/** The instrument's own label: mono caps, a step above the 9 px HUD label so it holds on a smaller window */
export const LBL_TYPE = "lc-mono text-[10px] leading-none font-bold tracking-[0.16em] whitespace-nowrap uppercase";
/** The label in its resting slate. A label that takes a state colour uses `LBL_TYPE` and its own colour: never two */
export const LBL = `${LBL_TYPE} text-lc-slate`;
/** The shared panels placed inside the layout (split gaps, damage, lap board, MFD) lose their radius and blur here */
export const HARD = "[&_*]:rounded-none! [&_*]:backdrop-blur-none!";
export const NONE = "--";

export const BLADE_W = 1192;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Fit: the layout is drawn for a 1080p window and draws itself smaller on a smaller one                                */
/* ------------------------------------------------------------------------------------------------------------------ */

// No further than 0.9: the smallest labels are 10 px, and the HUD floor is 9 px (docs/DESIGN.md)
const FIT_MIN = 0.9;
const subscribeResize = (listener: () => void) => {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
};
// In steps of 16 px, so dragging a window edge re-renders the HUD a few times, not on every pixel
const windowW = () => Math.round(window.innerWidth / 16) * 16;
const windowH = () => Math.round(window.innerHeight / 16) * 16;

/**
 * The size the layout's groups are drawn at (the HUD size times the fit to a window smaller than 1080p: the blade is
 * 1192 px wide), and the width from the middle of the screen to where a bottom corner's panels start (px)
 */
export function useBladeFit(scale: number | undefined): { s: number; half: number } {
  const w = useSyncExternalStore(subscribeResize, windowW, () => 1920);
  const h = useSyncExternalStore(subscribeResize, windowH, () => 1080);
  // Past 2.4:1 the HUD keeps to a centred frame
  const frameW = Math.min(w, h * 2.4);
  const fit = Math.round(Math.min(1, Math.max(FIT_MIN, Math.min(frameW / 1920, h / 900))) * 50) / 50;
  // CORNER_EDGE in pixels
  const edge = Math.min(20, Math.max(10, w * 0.0104));
  return { s: (scale ?? 1) * fit, half: frameW / 2 - edge };
}

/** The size `anchor()` draws a group at: the HUD size times the player's own resize of that part */
export function scaleOf(style: CSSProperties): number {
  const m = /scale\(([\d.]+)\)/.exec(String(style.transform ?? ""));
  return m ? Number(m[1]) : 1;
}

/** An element's own width (before any scaling), followed as it changes: what a bottom corner's panels need of `room` */
export function useOwnWidth(): [(el: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.offsetWidth));
    ro.observe(el);
    observer.current = ro;
    setWidth(el.offsetWidth);
  }, []);
  return [ref, width];
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Words                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

export type Words = ReturnType<typeof useBladeWords>;
const ERS_MODES = ["CHR", "LIC", "BAL", "RAC", "PSH"] as const;

export function useBladeWords() {
  const tx = useTranslations("hudStyles.blade");
  const txCompound = useTranslations("common.compounds.short");
  return useMemo(
    () => ({
      order: tx("order"),
      session: tx("session"),
      race: tx("race"),
      lap: formatOnce((lap: number) => tx("lap", { lap })),
      run: formatOnce((lap: number) => tx("run", { lap })),
      outLap: tx("outLap"),
      raceLaps: formatOnce((laps: number) => tx("raceLaps", { laps })),
      positionOf: formatOnce((position: number, total: number) => tx("positionOf", { position, total })),
      cols: { driver: tx("cols.driver"), int: tx("cols.int"), gap: tx("cols.gap"), last: tx("cols.last") },
      flags: {
        green: tx("flags.green"),
        yellow: tx("flags.yellow"),
        doubleYellow: tx("flags.doubleYellow"),
        vsc: tx("flags.vsc"),
        vscEnding: tx("flags.vscEnding"),
        blue: tx("flags.blue"),
        finalLap: tx("flags.finalLap"),
        finish: tx("flags.finish"),
      },
      invalid: tx("invalid"),
      out: tx("out"),
      gapToYou: tx("gapToYou"),
      gapToLeader: tx("gapToLeader"),
      closing: tx("closing"),
      dropping: tx("dropping"),
      air: tx("air"),
      track: tx("track"),
      rain: tx("rain"),
      limits: tx("limits"),
      limitsSpoken: formatOnce((count: number, of: number) => tx("limitsSpoken", { count, of })),
      penalty: formatOnce((seconds: number) => tx("penalty", { seconds })),
      map: tx("map"),
      timing: tx("timing"),
      lapTime: tx("lapTime"),
      onPb: tx("onPb"),
      last: tx("last"),
      best: tx("best"),
      optimal: tx("optimal"),
      pred: tx("pred"),
      sector: [1, 2, 3].map((sector) => tx("sector", { sector })),
      sectorBest: [1, 2, 3].map((sector) => tx("sectorBest", { sector })),
      sectorPb: [1, 2, 3].map((sector) => tx("sectorPb", { sector })),
      instrument: tx("instrument"),
      tyres: tx("tyres"),
      life: formatOnce((pct: number) => tx("life", { pct })),
      tyre: formatOnce((corner: string, temp: string) => tx("tyre", { corner, temp })),
      corners: [tx("corners.fl"), tx("corners.fr"), tx("corners.rl"), tx("corners.rr")] as const,
      punctured: tx("punctured"),
      compound: {
        soft: txCompound("soft"),
        medium: txCompound("medium"),
        hard: txCompound("hard"),
        intermediate: txCompound("intermediate"),
        wet: txCompound("wet"),
      } satisfies Record<TireCompound, string>,
      fuel: tx("fuel"),
      kg: tx("kg"),
      fuelLaps: formatOnce((laps: string) => tx("fuelLaps", { laps })),
      fuelMargin: tx("fuelMargin"),
      gear: formatOnce((gear: string) => tx("gear", { gear })),
      speed: tx("speed"),
      deltaBest: tx("deltaBest"),
      ers: tx("ers"),
      ersMode: Object.fromEntries(ERS_MODES.map((m) => [m, tx("ersMode", { mode: tx(`ersModes.${m}`) })])) as Record<string, string | undefined>,
      ersModeRaw: formatOnce((mode: string) => tx("ersMode", { mode })),
      overtake: tx("overtake"),
      overtakeOn: tx("overtakeOn"),
      overtakeReady: tx("overtakeReady"),
      overtakeLocked: tx("overtakeLocked"),
      boost: tx("boost"),
      lowGrip: tx("lowGrip"),
      deploy: tx("deploy"),
      harvest: tx("harvest"),
      clip: tx("clip"),
      rpm: tx("rpm"),
      tc: tx("tc"),
      abs: tx("abs"),
      bias: tx("bias"),
      engineMap: tx("engineMap"),
      off: tx("off"),
      cutting: formatOnce((aid: string) => tx("cutting", { aid })),
    }),
    [tx, txCompound],
  );
}
