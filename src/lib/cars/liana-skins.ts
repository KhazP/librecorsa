import type { CarSkin } from "./car-registry";

/**
 * Suzuki Liana 1.6 liveries:
 * Default (`skins[0]`) keeps the original factory Ice Blue Silver GLB finish,
 * joined by the `#106 Middle Gear Special` comedy livery.
 */
export const LIANA_SKINS: readonly CarSkin[] = [
  {
    id: "liana_factory_silver",
    name: "Factory Ice Blue",
    swatch: ["#b6c5dc", "#6f809b"],
    useModelPaint: true,
  },
  {
    id: "liana_middle_gear",
    name: "#106 Middle Gear Special",
    swatch: ["#0d5634", "#f0c800", "#ff5a00"],
    procedural: "liana_middle_gear",
  },
];
