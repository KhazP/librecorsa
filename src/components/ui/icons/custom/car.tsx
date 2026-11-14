import { bandPath, defineSymbol, dot, FILLED } from "./define";

/** A full-face helmet from the side, visor towards the front */
export const Helmet = defineSymbol("helmet", [
  ["path", { d: "M3 19v-5a9 9 0 0 1 18 0v2a3 3 0 0 1-3 3Z" }],
  ["path", { d: "M20.5 11H14a2.5 2.5 0 0 0 0 5h7" }],
]);

/** The H pattern of a manual gearbox: five gates and the knob's track */
export const Gearbox = defineSymbol("gearbox", [
  ["circle", { cx: 5, cy: 4.5, r: 2.5, ...FILLED }],
  ["circle", { cx: 12, cy: 4.5, r: 2.5, ...FILLED }],
  ["circle", { cx: 19, cy: 4.5, r: 2.5, ...FILLED }],
  ["circle", { cx: 5, cy: 19.5, r: 2.5, ...FILLED }],
  ["circle", { cx: 12, cy: 19.5, r: 2.5, ...FILLED }],
  ["path", { d: "M5 5v14" }],
  ["path", { d: "M12 5v14" }],
  ["path", { d: "M19 5v7H5" }],
]);

/** Traction control: a car from behind over two sliding tracks */
export const TractionControl = defineSymbol("traction-control", [
  ["path", { d: "m5 8 1.4-3.7A2 2 0 0 1 8.3 3h7.4a2 2 0 0 1 1.9 1.3L19 8" }],
  ["rect", { x: 3, y: 8, width: 18, height: 6, rx: 2 }],
  ["path", { d: "M7 17c-1.5 1 1.5 2.5 0 4" }],
  ["path", { d: "M17 17c-1.5 1 1.5 2.5 0 4" }],
  ["path", { d: "M7 14v1" }],
  ["path", { d: "M17 14v1" }],
]);

/** Anti-lock brakes: a wheel in brackets, pulsing */
export const Abs = defineSymbol("abs", [
  ["circle", { cx: 12, cy: 12, r: 6 }],
  ["path", { d: "M5 5.5a9.5 9.5 0 0 0 0 13" }],
  ["path", { d: "M19 5.5a9.5 9.5 0 0 1 0 13" }],
  ["path", { d: "m9 12.5 1.5-2 1.5 3 1.5-3 1.5 2" }],
]);

/** Rear wing from behind: endplates, pylon, the flap closed down onto the main plane */
export const DrsClosed = defineSymbol("drs-closed", [
  ["path", { d: "M3 3.5v13" }],
  ["path", { d: "M21 3.5v13" }],
  ["path", { d: "M3 13.5h18" }],
  ["path", { d: "M3 9.5h18" }],
  ["path", { d: "M12 13.5v7" }],
]);

/** Rear wing from behind with the flap opened: the slot between the planes is wide */
export const DrsOpen = defineSymbol("drs-open", [
  ["path", { d: "M3 3.5v13" }],
  ["path", { d: "M21 3.5v13" }],
  ["path", { d: "M3 13.5h18" }],
  ["path", { d: "M3 5.5h18" }],
  ["path", { d: "M12 13.5v7" }],
]);

/** Energy store: a battery with a bolt */
export const Ers = defineSymbol("ers", [
  ["rect", { x: 2, y: 6, width: 17, height: 12, rx: 2 }],
  ["path", { d: "M22 10v4" }],
  ["path", { d: "m11.5 8.5-3 3.5h4l-3 3.5" }],
]);

/** A wheel from the side: tyre, hub and wheel nuts */
export const Tyre = defineSymbol("tyre", [
  ["circle", { cx: 12, cy: 12, r: 10 }],
  ["circle", { cx: 12, cy: 12, r: 3.5 }],
  dot(12, 5),
  dot(18.66, 9.84),
  dot(16.11, 17.66),
  dot(7.89, 17.66),
  dot(5.34, 9.84),
]);

/** A brake disc with its caliper */
export const BrakeDisc = defineSymbol("brake-disc", [
  ["circle", { cx: 9.5, cy: 14.5, r: 6.5 }],
  ["circle", { cx: 9.5, cy: 14.5, r: 2 }],
  ["path", { d: bandPath(9.5, 14.5, 9.25, 11.5, -78, -12) }],
]);

/** The wheel gone flat on the road */
export const Puncture = defineSymbol("puncture", [
  ["path", { d: "M7 19.37A8.5 8.5 0 1 1 17 19.37Z" }],
  ["path", { d: "M2 19.37h20" }],
  ["circle", { cx: 12, cy: 12.5, r: 2.5 }],
  dot(12, 7),
  dot(17.23, 10.8),
  dot(15.23, 16.95),
  dot(8.77, 16.95),
  dot(6.77, 10.8),
]);

/** Damage: a car from above with a crack across it */
export const Damage = defineSymbol("damage", [
  ["rect", { x: 7, y: 2, width: 10, height: 20, rx: 3 }],
  ["path", { d: "M4 6v3" }],
  ["path", { d: "M20 6v3" }],
  ["path", { d: "M4 15v3" }],
  ["path", { d: "M20 15v3" }],
  ["path", { d: "m7 13 3.5-3 2 3.5L17 10" }],
]);
