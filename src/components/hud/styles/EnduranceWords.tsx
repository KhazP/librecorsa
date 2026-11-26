"use client";

import { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import { formatOnce, liveMessage } from "./hud-style-parts";

/**
 * What the Endurance layout's four corners share: the hard plate, its hairline and label, the ink that reads on a
 * team colour, and the words.
 */

/** Distance of each corner group from the HUD frame's edge */
export const EDGE = "clamp(12px,1.3cqw,24px)";
/** The layout's plate: void at 90 %, square, no blur */
export const PLATE = "bg-lc-void/90";
/** A hairline between two rows of a plate */
export const HAIR = "border-white/8";
/** The layout's field label: the HUD label one step up (10 px), as its plates are read at a glance */
export const LBL = "lc-hud-lbl text-[10px] leading-none tracking-[0.16em]";
/** A small solid tag inside a row (a penalty, an invalid lap) */
export const TAG = "lc-mono inline-flex h-4 shrink-0 items-center px-1.5 text-[10px] leading-none font-extrabold tracking-[0.06em] uppercase";

const inks = new Map<string, string>();

/** The ink that reads on a team colour from the data: void on a light colour, chalk on a dark one */
export function inkOn(hex: string): string {
  let ink = inks.get(hex);
  if (ink === undefined) {
    const m = /^#?([0-9a-f]{6})/i.exec(hex);
    const n = m ? Number.parseInt(m[1], 16) : 0xffffff;
    const luma = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    ink = luma > 0.42 ? "var(--color-lc-void)" : "var(--color-lc-chalk)";
    if (inks.size > 64) inks.clear();
    inks.set(hex, ink);
  }
  return ink;
}

/** ERS deployment modes as the tuner names them (`LiveTunerState.ersMode`) */
export type ErsModeCode = "CHR" | "LIC" | "BAL" | "RAC" | "PSH";

/** The Endurance layout's words in the current language, resolved once per language */
export function useEnduranceWords() {
  const tx = useTranslations("hudStyles.endurance");
  return useMemo(
    () => ({
      // Top left: the order
      order: tx("order"),
      session: tx("session"),
      race: tx("race"),
      lapOf: formatOnce((lap: number, total: number) => tx("lapOf", { lap: String(lap), total: String(total) })),
      lap: formatOnce((lap: number) => tx("lap", { lap: String(lap) })),
      run: formatOnce((lap: number) => tx("run", { lap: String(lap) })),
      outLap: tx("outLap"),
      flag: {
        green: tx("flag.green"),
        yellow: tx("flag.yellow"),
        doubleYellow: tx("flag.doubleYellow"),
        blue: tx("flag.blue"),
        vsc: tx("flag.vsc"),
        vscEnding: tx("flag.vscEnding"),
        finalLap: tx("flag.finalLap"),
        finished: tx("flag.finished"),
        grid: tx("flag.grid"),
      },
      leader: tx("leader"),
      interval: tx("interval"),
      out: tx("out"),
      disqualified: tx("disqualified"),
      finished: tx("finished"),
      penalty: formatOnce((seconds: number) => tx("penalty", { seconds: String(seconds) })),
      penaltyTitle: formatOnce((seconds: number) => tx("penaltyTitle", { seconds: String(seconds) })),
      fastestLap: tx("fastestLap"),
      row: formatOnce((position: number, driver: string) => tx("row", { position: String(position), driver })),
      map: tx("map"),
      // Top right: timing
      timing: tx("timing"),
      last: tx("last"),
      best: tx("best"),
      current: tx("current"),
      invalid: tx("invalid"),
      lapCut: tx("lapCut"),
      sectors: [1, 2, 3].map((sector) => tx("sector", { sector: String(sector) })),
      markBest: tx("mark.best"),
      markPb: tx("mark.pb"),
      vsBest: tx("vsBest"),
      faster: tx("faster"),
      slower: tx("slower"),
      level: tx("level"),
      limits: tx("limits"),
      limitsOf: formatOnce((count: number, of: number) => tx("limitsOf", { count: String(count), of: String(of) })),
      weather: tx("weather.label"),
      airTrack: formatOnce((air: string, track: string) => tx("weather.airTrack", { air, track })),
      rain: tx("weather.rain"),
      heavyRain: tx("weather.heavyRain"),
      // Bottom left: the pages
      pages: tx("pages.label"),
      tyres: tx("pages.tyres"),
      relative: tx("pages.relative"),
      laps: tx("pages.laps"),
      window: formatOnce((low: string, high: string) => tx("window", { low, high })),
      corners: [tx("corner.fl"), tx("corner.fr"), tx("corner.rl"), tx("corner.rr")] as const,
      tyre: liveMessage(["corner", "tread", "temp", "pressure", "brake"] as const, (m) => tx("tyre", m)),
      brake: tx("brake"),
      hot: tx("hot"),
      cold: tx("cold"),
      flat: tx("flat"),
      noCars: tx("noCars"),
      lapsUp: formatOnce((count: number) => tx("lapsUp", { count: String(count) })),
      lapsDown: formatOnce((count: number) => tx("lapsDown", { count: String(count) })),
      noLaps: tx("noLaps"),
      lapShort: formatOnce((lap: number) => tx("lapShort", { lap: String(lap) })),
      lapHead: tx("lapHead"),
      timeHead: tx("timeHead"),
      // Bottom right: dial, car, tanks
      dial: tx("dial"),
      rpm: tx("rpm"),
      car: tx("car"),
      noDamage: tx("damage.none"),
      damageOut: tx("damage.out"),
      damageLine: formatOnce((part: string, level: string) => tx("damage.line", { part, level })),
      damageMinor: tx("damage.minor"),
      damageHeavy: tx("damage.heavy"),
      damagePart: {
        front: tx("damage.front"),
        rear: tx("damage.rear"),
        left: tx("damage.left"),
        right: tx("damage.right"),
        suspension: tx("damage.suspension"),
        puncture: tx("damage.puncture"),
      },
      fuel: tx("fuel"),
      fuelLaps: formatOnce((laps: string) => tx("fuelLaps", { laps })),
      fuelShort: formatOnce((laps: string) => tx("fuelShort", { laps })),
      fuelKg: formatOnce((kg: string) => tx("fuelKg", { kg })),
      ers: tx("ers"),
      ersMode: {
        CHR: tx("ersMode.charge"),
        LIC: tx("ersMode.lowSpeed"),
        BAL: tx("ersMode.balanced"),
        RAC: tx("ersMode.race"),
        PSH: tx("ersMode.attack"),
      } satisfies Record<ErsModeCode, string>,
      overtakeReady: tx("overtake.ready"),
      overtakeOn: tx("overtake.on"),
      overtakeLocked: tx("overtake.locked"),
      boostOn: tx("overtake.boost"),
      lowGrip: tx("overtake.lowGrip"),
      electronics: tx("electronics.label"),
      tc: tx("electronics.tc"),
      abs: tx("electronics.abs"),
      bias: tx("electronics.bias"),
      engineMap: tx("electronics.map"),
      off: tx("electronics.off"),
      aidWorking: formatOnce((aid: string) => tx("electronics.working", { aid })),
    }),
    [tx],
  );
}

export type EnduranceWords = ReturnType<typeof useEnduranceWords>;
