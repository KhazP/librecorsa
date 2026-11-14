import React from "react";
import {
  CLOTH,
  chequerCells,
  clothDiagonalBand,
  clothDiagonalHoist,
  clothPath,
  polePath,
  type ClothFrame,
} from "../icons/custom/flag-geometry";
import type { BadgeTone } from "../Badge";

/** The race-control flags the game shows */
export type FlagKind =
  | "green"
  | "yellow"
  | "doubleYellow"
  | "blue"
  | "red"
  | "white"
  | "black"
  | "blackWhite"
  | "chequered";

/** Each flag's word and badge tone: one table for the HUD, the incident feed and the results */
export const FLAGS: Record<FlagKind, { label: string; tone: BadgeTone }> = {
  green: { label: "Green flag", tone: "good" },
  yellow: { label: "Yellow flag", tone: "warn" },
  doubleYellow: { label: "Double yellow", tone: "warn" },
  blue: { label: "Blue flag", tone: "info" },
  red: { label: "Red flag", tone: "bad" },
  white: { label: "White flag", tone: "neutral" },
  black: { label: "Black flag", tone: "bad" },
  blackWhite: { label: "Black and white", tone: "warn" },
  chequered: { label: "Chequered flag", tone: "neutral" },
};

/*
 * Cloth fill and edge per flag, written out for Tailwind. The patterned cloths take the keyline edge; the black cloth
 * takes a slate edge, the lightest that still reads as black, because a keyline edge vanishes at 16 px on dark glass.
 */
const CLOTH_CLASS: Record<FlagKind, string> = {
  green: "fill-lc-green stroke-lc-green",
  yellow: "fill-lc-amber stroke-lc-amber",
  doubleYellow: "fill-lc-amber stroke-lc-amber",
  blue: "fill-lc-cyan stroke-lc-cyan",
  red: "fill-lc-crimson stroke-lc-crimson",
  white: "fill-lc-chalk stroke-lc-chalk",
  black: "fill-lc-void stroke-lc-slate",
  blackWhite: "fill-lc-chalk stroke-lc-keyline",
  chequered: "fill-lc-chalk stroke-lc-keyline",
};

/** Two narrower flags side by side for the double yellow */
const PAIR: readonly ClothFrame[] = [
  { x0: 2.5, x1: 9.5, top: 5, h: 8, amp: 0.8 },
  { x0: 13, x1: 20.5, top: 5, h: 8, amp: 0.8 },
];

const OneFlag: React.FC<{ kind: FlagKind; frame: ClothFrame }> = ({ kind, frame }) => {
  const outline = clothPath(frame);
  const dark = kind === "black" || kind === "blackWhite" || kind === "chequered";
  return (
    <>
      <path d={polePath(frame)} stroke="currentColor" strokeWidth={2} />
      <path d={outline} className={CLOTH_CLASS[kind]} strokeWidth={dark && kind !== "black" ? 2 : 1.5} />
      {kind === "blackWhite" ? <path d={clothDiagonalHoist(frame)} className="fill-lc-void" /> : null}
      {kind === "chequered" ? <path d={chequerCells(frame)} className="fill-lc-void" /> : null}
      {kind === "blue" ? <path d={clothDiagonalBand(frame, 3)} className="fill-lc-chalk" /> : null}
      {dark && kind !== "black" ? <path d={outline} fill="none" className="stroke-lc-keyline" strokeWidth={2} /> : null}
    </>
  );
};

/**
 * A drawn race-control flag: a short pole and a cloth with a gentle wave, in the flag's colour. Shown with its word
 * (`FlagBadge`) wherever it carries meaning; on its own it needs a `label`.
 */
export const FlagIcon: React.FC<{
  flag: FlagKind;
  /** Pixels (16 is the smallest it is drawn for) */
  size?: number;
  /** Spoken name, when no word is shown beside it */
  label?: string;
  className?: string;
}> = ({ flag, size = 16, label, className = "" }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    strokeLinecap="round"
    strokeLinejoin="round"
    focusable="false"
    {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    className={`shrink-0 ${className}`}
  >
    {flag === "doubleYellow" ? (
      PAIR.map((frame) => <OneFlag key={frame.x0} kind={flag} frame={frame} />)
    ) : (
      <OneFlag kind={flag} frame={CLOTH} />
    )}
  </svg>
);
