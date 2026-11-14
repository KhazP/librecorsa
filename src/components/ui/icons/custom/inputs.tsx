import { defineSymbol } from "./define";

/** A round wheel, hub and three spokes */
export const SteeringWheel = defineSymbol("steering-wheel", [
  ["circle", { cx: 12, cy: 12, r: 10 }],
  ["circle", { cx: 12, cy: 12, r: 2 }],
  ["path", { d: "M2 12h8" }],
  ["path", { d: "M14 12h8" }],
  ["path", { d: "M12 14v8" }],
]);

/** Brake and throttle hanging from their arms */
export const Pedals = defineSymbol("pedals", [
  ["path", { d: "M7 3v6" }],
  ["rect", { x: 3, y: 9, width: 8, height: 7, rx: 2 }],
  ["path", { d: "M17.5 3v3" }],
  ["rect", { x: 14.5, y: 6, width: 6, height: 15, rx: 2 }],
]);

/** A phone held sideways and turned like a wheel, the turn marked at its ends */
export const Tilt = defineSymbol("tilt", [
  ["rect", { x: 3.5, y: 8, width: 17, height: 8, rx: 2, transform: "rotate(-20 12 12)" }],
  ["path", { d: "M3 6.5A10 10 0 0 1 6.5 3" }],
  ["path", { d: "M21 17.5a10 10 0 0 1-3.5 3.5" }],
]);
