import type { CarSkin } from "./car-registry";

/**
 * LC-LMDH Hypercar / GTP liveries:
 * Default (`skins[0]`) keeps the factory white/cyan/carbon LibreCorsa GLB finish,
 * followed by 7 current-era WEC Hypercar & IMSA GTP inspired 2048px procedural liveries.
 */
export const LC_LMDH_SKINS: readonly CarSkin[] = [
  {
    id: "lmdh_factory_01",
    name: "#01 LibreCorsa Factory",
    swatch: ["#eef2f6", "#00b3cc", "#12161e"],
    useModelPaint: true,
  },
  {
    id: "lmdh_rossa_51",
    name: "#51 Scuderia Rossa",
    swatch: ["#c40814", "#f2c200", "#111419"],
    procedural: "lmdh_rossa_51",
  },
  {
    id: "lmdh_penske_6",
    name: "#6 Stuttgart Penske",
    swatch: ["#f4f6fa", "#d91628", "#12151c"],
    procedural: "lmdh_penske_6",
  },
  {
    id: "lmdh_gold_12",
    name: "#12 Jota Gold",
    swatch: ["#cfa024", "#101319", "#f8fafc"],
    procedural: "lmdh_gold_12",
  },
  {
    id: "lmdh_alpine_36",
    name: "#36 Bleu Endurance",
    swatch: ["#004ec7", "#11151d", "#e11d2e"],
    procedural: "lmdh_alpine_36",
  },
  {
    id: "lmdh_bavaria_15",
    name: "#15 WRT Hybrid V8",
    swatch: ["#12161f", "#009fe3", "#e11d2e"],
    procedural: "lmdh_bavaria_15",
  },
  {
    id: "lmdh_valkyrie_009",
    name: "#009 British Racing Works",
    swatch: ["#004d3d", "#b4ee00", "#10141a"],
    procedural: "lmdh_valkyrie_009",
  },
  {
    id: "lmdh_gazoo_7",
    name: "#7 Matte Works Kuro",
    swatch: ["#13161c", "#e11d2e", "#f4f7fb"],
    procedural: "lmdh_gazoo_7",
  },
];
