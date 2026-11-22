import type { CarSkin } from "./car-registry";

/**
 * Mercedes-AMG GT3 Evo liveries:
 * Default (`skins[0]`) is `#3 Verstappen Racing` using the GLB's own baked CC-BY-NC-SA texture,
 * followed by 7 current-grid procedural 2048px GT3 team liveries (`src/lib/render/gt3-livery-painter.ts`).
 */
export const AMG_GT3_SKINS: readonly CarSkin[] = [
  {
    id: "verstappen_3",
    name: "#3 Verstappen Racing",
    swatch: ["#0d1c45", "#dc143c", "#f6c915"],
    useModelPaint: true,
  },
  {
    id: "amg_mamba_48",
    name: "#48 Mamba Racing",
    swatch: ["#e8cc00", "#007c36", "#111318"],
    procedural: "amg_mamba_48",
  },
  {
    id: "amg_iron_lynx_61",
    name: "#61 Iron Lynx (WEC)",
    swatch: ["#11141a", "#b0ea00", "#eef3f8"],
    procedural: "amg_iron_lynx_61",
  },
  {
    id: "amg_iron_lynx_79",
    name: "#79 Iron Lynx Cobalt",
    swatch: ["#0042b0", "#10141d", "#29ccf5"],
    procedural: "amg_iron_lynx_79",
  },
  {
    id: "amg_getspeed_17",
    name: "#17 GetSpeed Performance",
    swatch: ["#f2f5f9", "#131720", "#e11d2e"],
    procedural: "amg_getspeed_17",
  },
  {
    id: "amg_gruppem_99",
    name: "#99 GruppeM Racing",
    swatch: ["#dde4ec", "#d60024", "#0d2042"],
    procedural: "amg_gruppem_99",
  },
  {
    id: "amg_express_75",
    name: "#75 75 Express",
    swatch: ["#ff5a00", "#0e1117", "#f5c542"],
    procedural: "amg_express_75",
  },
  {
    id: "amg_silver_arrow_00",
    name: "#00 Affalterbach Works",
    swatch: ["#c7d0da", "#10141a", "#00d4be"],
    procedural: "amg_silver_arrow_00",
  },
];

/**
 * BMW M4 GT3 Evo liveries:
 * Default (`skins[0]`) is `#33 Verstappen Racing` (procedural 2048px matte navy/crimson/gold wrap),
 * followed by 6 current-grid procedural GT3 team liveries plus the original factory carbon stealth finish.
 */
export const BMW_M4_GT3_SKINS: readonly CarSkin[] = [
  {
    id: "bmw_verstappen_33",
    name: "#33 Verstappen Racing",
    swatch: ["#0d1c45", "#dc143c", "#f6c915"],
    procedural: "bmw_verstappen_33",
  },
  {
    id: "bmw_wrt_32",
    name: "#32 Team WRT Works",
    swatch: ["#f3f6fa", "#009fe3", "#e11d2e"],
    procedural: "bmw_wrt_32",
  },
  {
    id: "bmw_wrt_46",
    name: "#46 WRT \"Il Dottore\"",
    swatch: ["#0b2363", "#d8ec00", "#f4f7fb"],
    procedural: "bmw_wrt_46",
  },
  {
    id: "bmw_rowe_98",
    name: "#98 ROWE Racing",
    swatch: ["#13161d", "#f2f5f9", "#f2cf00"],
    procedural: "bmw_rowe_98",
  },
  {
    id: "bmw_schubert_11",
    name: "#11 Schubert Motorsport",
    swatch: ["#f5f7fa", "#008f36", "#13171f"],
    procedural: "bmw_schubert_11",
  },
  {
    id: "bmw_paul_miller_1",
    name: "#1 Paul Miller Racing",
    swatch: ["#f6f8fb", "#008e42", "#004da8"],
    procedural: "bmw_paul_miller_1",
  },
  {
    id: "bmw_turner_96",
    name: "#96 Turner Motorsport",
    swatch: ["#ebb800", "#003fa8", "#f8fafc"],
    procedural: "bmw_turner_96",
  },
  {
    id: "bmw_stealth_25",
    name: "#25 Factory Carbon Stealth",
    swatch: ["#14171d", "#2c333f", "#009fe3"],
    useModelPaint: true,
  },
];
