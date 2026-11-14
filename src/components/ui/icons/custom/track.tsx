import { bandPath, defineSymbol, FILLED, polar, type SymbolPart } from "./define";
import { CLOTH, chequerCells, clothPath, polePath } from "./flag-geometry";

/** The line through a corner, its apex marked */
export const RacingLine = defineSymbol("racing-line", [
  ["path", { d: "M4 19.5c0-6.5 2.5-11 7-13s7-2 9-2" }],
  ["circle", { cx: 9, cy: 8.1, r: 2.5, ...FILLED }],
]);

/** A closed circuit: a long straight, a hairpin and a kink */
export const TrackCircuit = defineSymbol("track-circuit", [
  ["path", { d: "M6 20h12a3 3 0 0 0 2.6-4.5L15.3 6a3 3 0 0 0-5.2 0L8.6 8.7a1.5 1.5 0 0 0 1.3 2.3h.6a1.5 1.5 0 0 1 0 3H6a3 3 0 0 0 0 6Z" }],
]);

/** A road climbing to a summit marker */
export const TrackHillClimb = defineSymbol("track-hill-climb", [
  ["path", { d: "M2 21l5-5 3 2 6-8" }],
  ["path", { d: "M16 10V3l5 2.5-5 2.5" }],
]);

/** A road from a start point to a finish line */
export const TrackPointToPoint = defineSymbol("track-point-to-point", [
  ["circle", { cx: 5, cy: 19, r: 2 }],
  ["path", { d: "M7 19h5a3 3 0 0 0 3-3V8a3 3 0 0 1 3-3h1" }],
  ["path", { d: "M20 2v6" }],
]);

const KERB_C = [12, 27.5] as const;
const kerbBlock = (a0: number, a1: number): SymbolPart => ["path", { d: bandPath(KERB_C[0], KERB_C[1], 13, 20, a0, a1) }];
/** A kerb on the inside of a corner: alternating blocks */
export const Kerb = defineSymbol("kerb", [
  kerbBlock(240, 300),
  ["path", { d: bandPath(KERB_C[0], KERB_C[1], 13, 20, 240, 255), ...FILLED }],
  ["path", { d: bandPath(KERB_C[0], KERB_C[1], 13, 20, 270, 285), ...FILLED }],
  ["path", { d: `M${polar(KERB_C[0], KERB_C[1], 13, 270).join(" ")}L${polar(KERB_C[0], KERB_C[1], 20, 270).join(" ")}` }],
]);

/** The pit lane leaving the track, with the garage boxes along it */
export const PitLane = defineSymbol("pit-lane", [
  ["path", { d: "M2 6h20" }],
  ["path", { d: "M3 6c3.5 0 4 6 7.5 6H22" }],
  ["path", { d: "M13 12v6" }],
  ["path", { d: "M17.5 12v6" }],
  ["path", { d: "M22 12v6" }],
]);

/** A stopwatch with a plus: time added */
export const Penalty = defineSymbol("penalty", [
  ["path", { d: "M10 2h4" }],
  ["circle", { cx: 12, cy: 14, r: 8 }],
  ["path", { d: "M12 10.5v7" }],
  ["path", { d: "M8.5 14h7" }],
]);

/** Track limits: the white line and a car's path across it */
export const TrackLimits = defineSymbol("track-limits", [
  ["path", { d: "M9 2v20" }],
  ["path", { d: "M4 19 18 7" }],
  ["path", { d: "M13 6.5h5.5V12" }],
]);

/** Slipstream: the car ahead and the wake behind it */
export const Slipstream = defineSymbol("slipstream", [
  ["path", { d: "m15 6 6 6-6 6" }],
  ["path", { d: "M2 8h9" }],
  ["path", { d: "M5 12h11" }],
  ["path", { d: "M2 16h9" }],
]);

/** Start slots on a grid, staggered */
export const StartGrid = defineSymbol("start-grid", [
  ["path", { d: "M3 7V3h7v4" }],
  ["path", { d: "M3 17v-4h7v4" }],
  ["path", { d: "M14 11V7h7v4" }],
  ["path", { d: "M14 21v-4h7v4" }],
]);

/** Three podium steps */
export const Podium = defineSymbol("podium", [
  ["path", { d: "M3 19v-7h6V6h6v8h6v5Z" }],
  ["path", { d: "M9 12v7" }],
  ["path", { d: "M15 14v5" }],
]);

/** The chequered flag: the shared flag shape with its chequers filled */
export const Chequered = defineSymbol("chequered", [
  ["path", { d: polePath(CLOTH) }],
  ["path", { d: chequerCells(CLOTH), ...FILLED }],
  ["path", { d: clothPath(CLOTH) }],
]);
