/*
 * The session's clouds: which cloud types share the sky, and how the volumetric clouds' four layers are set up to draw
 * them (physical-sky.ts, Medium and High).
 *
 * The clouds library has no cloud types of its own. It draws up to four layers, each a slab between two heights whose
 * coverage comes from one channel of a weather texture and whose shape comes from shared 3D noise. Each layer here
 * keeps one job and one channel for the whole session (a channel change would rebuild the shaders):
 *   0  r  cumulus: small cells. Fair-weather humilis on a clear day, taller mediocris and congestus as the cover grows,
 *         ragged scud under a rain deck
 *   1  g  the mid layer, bigger cells: altocumulus or altostratus, or nothing
 *   2  b  the high layer, streaky noise: cirrus, cirrostratus or cirrocumulus, or nothing
 *   3  a  the deck: the texture's alpha is a constant 1, so this layer covers the whole sky and only the shape noise
 *         breaks it up. Broken stratocumulus as it forms, a stratus sheet when overcast, a thick nimbostratus in rain
 *
 * A session picks its types and their heights from a seed (pickCloudRecipe), weighted by the weather it starts in.
 * After that every setting follows the cloud cover and rain as continuous curves (cloudSkyFor), so a dynamic or
 * forecast sky changes without anything popping in or out.
 *
 * How much of a layer shows: the library has one coverage for every layer. A layer's texture value v is raised to its
 * weather exponent e, and the layer shows (at mid-height) where v^e > 1 - coverage / (1 - filterWidth). exponentFor
 * picks e so that the layer shows where v passes 1 - cover instead, which gives each layer its own cover. That needs
 * coverage < 1 - filterWidth on the r, g and b layers (MAX_COVERAGE and TEXTURED_MAX_FILTER below). The deck's v is
 * always 1, so its density at mid-height is coverage / filterWidth, and its filter width sets it.
 */

export type MidCloud = "none" | "altocumulus" | "altostratus";
export type HighCloud = "none" | "cirrus" | "cirrostratus" | "cirrocumulus";

export interface CloudRecipe {
  seed: number;
  /** Weather-texture repeats per cube-sphere face: the size of the cloud cells (more repeats, smaller cells) */
  repeat: number;
  /** Where the weather pattern starts, in texture repeats (0..1 each) */
  offset: readonly [number, number];
  /** Where the 3D shape noise starts (0..1 each): the same pattern of cells gets different shapes */
  shapeOffset: readonly [number, number, number];
  /** Drift direction when the session has no wind (rad, scene XZ) */
  calmDriftRad: number;
  /** Cumulus base (m) in the dry */
  cumulusBase: number;
  /** How many cumulus a clear day keeps (0 none .. 1 scattered) */
  fairWeather: number;
  /** How tall the cumulus grow as the cover builds (0 flat humilis .. 1 congestus) */
  growth: number;
  mid: MidCloud;
  midAltitude: number;
  midThickness: number;
  /** How much of its layer the mid cloud covers (0..1) */
  midAmount: number;
  high: HighCloud;
  highAltitude: number;
  highAmount: number;
  /** Deck base (m) in the dry */
  deckBase: number;
  /** Cloud cover at which the deck starts to form */
  deckOnset: number;
  /** How broken the deck stays once it has closed (0 a stratus sheet with a soft texture .. 1 lumpy stratocumulus) */
  deckLumps: number;
}

/** One layer's settings, the numeric part of the library's CloudLayer */
export interface CloudLayerSetup {
  altitude: number;
  height: number;
  densityScale: number;
  shapeAmount: number;
  shapeDetailAmount: number;
  weatherExponent: number;
  shapeAlteringBias: number;
  coverageFilterWidth: number;
  shadow: boolean;
}

export interface CloudSkySetup {
  /** The library's global coverage (it also sets the clouds' haze and their ground bounce) */
  coverage: number;
  layers: [CloudLayerSetup, CloudLayerSetup, CloudLayerSetup, CloudLayerSetup];
}

/** Global coverage range: low under a clear sky, high under a grey one */
export const MIN_COVERAGE = 0.24;
export const MAX_COVERAGE = 0.38;
/** Widest filter the r, g and b layers may use: their cover control needs coverage < 1 - filter width */
export const TEXTURED_MAX_FILTER = 0.6;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const clamp01 = (x: number) => clamp(x, 0, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Mulberry32: a small seeded generator, the same sequence for a seed on every client */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted<T>(u: number, table: ReadonlyArray<readonly [T, number]>): T {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let x = u * total;
  for (const [value, w] of table) {
    if (x < w) return value;
    x -= w;
  }
  return table[table.length - 1][0];
}

type Band = "clear" | "broken" | "grey";

const MID_ODDS: Record<Band, ReadonlyArray<readonly [MidCloud, number]>> = {
  clear: [["none", 0.6], ["altocumulus", 0.4], ["altostratus", 0]],
  broken: [["none", 0.3], ["altocumulus", 0.45], ["altostratus", 0.25]],
  grey: [["none", 0.2], ["altocumulus", 0.3], ["altostratus", 0.5]],
};
const HIGH_ODDS: Record<Band, ReadonlyArray<readonly [HighCloud, number]>> = {
  clear: [["none", 0.25], ["cirrus", 0.45], ["cirrocumulus", 0.15], ["cirrostratus", 0.15]],
  broken: [["none", 0.3], ["cirrus", 0.4], ["cirrocumulus", 0.1], ["cirrostratus", 0.2]],
  grey: [["none", 0.5], ["cirrus", 0.2], ["cirrocumulus", 0], ["cirrostratus", 0.3]],
};

/** The session's cloud types and heights, from its seed and the weather it starts in */
export function pickCloudRecipe(seed: number, cloud: number, rain: number): CloudRecipe {
  const u = rng(seed);
  const band: Band = cloud < 0.12 ? "clear" : cloud < 0.6 && rain < 0.05 ? "broken" : "grey";
  // Every draw happens in the same order whatever the band, so a seed's heights and positions hold across weathers
  const repeat = lerp(80, 140, u());
  const offset = [u(), u()] as const;
  const shapeOffset = [u(), u(), u()] as const;
  const calmDriftRad = u() * 2 * Math.PI;
  const cumulusBase = lerp(750, 1500, u());
  // A fifth of clear days have no cumulus at all
  const fw = u();
  const fairWeather = fw < 0.2 ? 0 : (fw - 0.2) / 0.8;
  const growth = u();
  const mid = weighted(u(), MID_ODDS[band]);
  const midAltitude = lerp(2600, 4600, u());
  const midThickness = u();
  const midAmount = u();
  const high = weighted(u(), HIGH_ODDS[band]);
  const highAltitude = lerp(6500, 8000, u());
  const highAmount = u();
  const deckBase = lerp(600, 1200, u());
  const deckOnset = lerp(0.5, 0.65, u());
  const deckLumps = u();
  return {
    seed,
    repeat,
    offset,
    shapeOffset,
    calmDriftRad,
    cumulusBase,
    fairWeather,
    growth,
    mid,
    midAltitude,
    midThickness: mid === "altostratus" ? lerp(700, 1500, midThickness) : lerp(250, 600, midThickness),
    midAmount,
    high,
    highAltitude,
    highAmount,
    deckBase,
    deckOnset,
    deckLumps,
  };
}

/** Weather exponent that shows a textured layer where its value passes 1 - cover, under the global coverage */
export function exponentFor(cover: number, coverage: number, filterWidth: number): number {
  const threshold = clamp(1 - coverage / (1 - filterWidth), 1e-3, 1 - 1e-3);
  const target = clamp(1 - cover, 1e-3, 1 - 1e-3);
  return clamp(Math.log(threshold) / Math.log(target), 0.05, 40);
}

const OFF: Readonly<CloudLayerSetup> = {
  altitude: 0,
  height: 0,
  densityScale: 0,
  shapeAmount: 1,
  shapeDetailAmount: 1,
  weatherExponent: 1,
  shapeAlteringBias: 0.35,
  coverageFilterWidth: 0.6,
  shadow: false,
};

/** A layer with nothing to draw is switched off (height 0), so the clouds' ray march does not span it */
function layer(out: CloudLayerSetup, s: CloudLayerSetup): CloudLayerSetup {
  return Object.assign(out, s.densityScale > 1e-5 && s.height > 1 ? s : OFF);
}

function emptySetup(): CloudSkySetup {
  return { coverage: MIN_COVERAGE, layers: [{ ...OFF }, { ...OFF }, { ...OFF }, { ...OFF }] };
}

/** How far the deck has formed (0 none .. 1 closed) */
function deckFormed(r: CloudRecipe, cloud: number, rain: number): number {
  return Math.max(smooth(r.deckOnset, Math.min(1, r.deckOnset + 0.3), cloud), smooth(0, 0.25, rain));
}

/** The four layers for this weather: every value a continuous function of `cloud` and `rain` (0..1) */
export function cloudSkyFor(r: CloudRecipe, cloudIn: number, rainIn: number, out: CloudSkySetup = emptySetup()): CloudSkySetup {
  const cloud = clamp01(cloudIn);
  const rain = clamp01(rainIn);
  const coverage = lerp(MIN_COVERAGE, MAX_COVERAGE, smooth(0.3, 0.95, cloud));
  out.coverage = coverage;
  const deck = deckFormed(r, cloud, rain);

  // 0: cumulus. A clear day keeps its fair-weather share; they spread and grow as the cover builds, and under a formed
  // deck shrink to scud below it
  {
    const clearCover = r.fairWeather > 0 ? 0.12 + 0.43 * r.fairWeather : 0;
    const cover = lerp(clearCover, 0.9, smooth(0, 0.75, cloud));
    const grow = clamp01(r.growth * lerp(0.55, 1.25, smooth(0.15, 0.7, cloud)));
    const height = lerp(350, 3000, Math.pow(grow, 1.4)) * lerp(1, 0.45, deck);
    const filter = lerp(0.6, 0.45, deck);
    layer(out.layers[0], {
      altitude: lerp(r.cumulusBase, 450, Math.max(rain, 0.5 * deck)),
      height,
      densityScale: cover > 0.01 ? lerp(0.2, 0.3, rain) : 0,
      shapeAmount: 1,
      shapeDetailAmount: 1,
      weatherExponent: exponentFor(cover, coverage, filter),
      shapeAlteringBias: 0.35,
      coverageFilterWidth: filter,
      shadow: true,
    });
  }

  // 1: mid layer. Thickens with the cover, then sits hidden above the deck in rain
  {
    const hidden = smooth(0.3, 0.75, rain);
    if (r.mid === "altocumulus") {
      const cover = clamp(lerp(0.25, 0.8, r.midAmount) * lerp(0.75, 1.15, smooth(0.1, 0.8, cloud)), 0, 0.95);
      layer(out.layers[1], {
        altitude: r.midAltitude,
        height: r.midThickness,
        densityScale: lerp(0.08, 0.14, r.midAmount) * (1 - hidden),
        shapeAmount: 1,
        shapeDetailAmount: 1,
        weatherExponent: exponentFor(cover, coverage, 0.5),
        shapeAlteringBias: 0.45,
        coverageFilterWidth: 0.5,
        shadow: true,
      });
    } else if (r.mid === "altostratus") {
      // A thin sheet the sun shows through, as through frosted glass, until the cover thickens it
      const cover = lerp(0.85, 0.97, r.midAmount);
      layer(out.layers[1], {
        altitude: r.midAltitude,
        height: r.midThickness,
        densityScale: lerp(0.025, 0.05, r.midAmount) * lerp(0.6, 2.2, smooth(0.2, 0.9, cloud)) * (1 - hidden),
        shapeAmount: 0.35,
        shapeDetailAmount: 0.5,
        weatherExponent: exponentFor(cover, coverage, 0.6),
        shapeAlteringBias: 0.5,
        coverageFilterWidth: 0.6,
        shadow: true,
      });
    } else {
      layer(out.layers[1], OFF);
    }
  }

  // 2: high layer. Out of sight once the deck has closed
  {
    const fade = 1 - smooth(0.6, 0.95, deck);
    if (r.high === "cirrus") {
      const cover = lerp(0.35, 0.75, r.highAmount);
      layer(out.layers[2], {
        altitude: r.highAltitude,
        height: 450,
        densityScale: lerp(0.003, 0.007, r.highAmount) * fade,
        shapeAmount: 0.4,
        shapeDetailAmount: 0,
        weatherExponent: exponentFor(cover, coverage, 0.5),
        shapeAlteringBias: 0.35,
        coverageFilterWidth: 0.5,
        shadow: false,
      });
    } else if (r.high === "cirrostratus") {
      layer(out.layers[2], {
        altitude: r.highAltitude,
        height: 600,
        densityScale: lerp(0.0016, 0.0032, r.highAmount) * fade,
        shapeAmount: 0.15,
        shapeDetailAmount: 0,
        weatherExponent: exponentFor(0.95, coverage, 0.6),
        shapeAlteringBias: 0.5,
        coverageFilterWidth: 0.6,
        shadow: false,
      });
    } else if (r.high === "cirrocumulus") {
      const cover = lerp(0.4, 0.7, r.highAmount);
      layer(out.layers[2], {
        altitude: r.highAltitude,
        height: 300,
        densityScale: lerp(0.007, 0.012, r.highAmount) * fade,
        shapeAmount: 1,
        shapeDetailAmount: 1,
        weatherExponent: exponentFor(cover, coverage, 0.45),
        shapeAlteringBias: 0.45,
        coverageFilterWidth: 0.45,
        shadow: false,
      });
    } else {
      layer(out.layers[2], OFF);
    }
  }

  // 3: the deck. It forms as broken patches (only the shape noise's peaks pass at a low density), closes, and in rain
  // lowers and thickens into a dark nimbostratus
  {
    const closed = lerp(lerp(0.85, 0.6, r.deckLumps), 1, Math.max(smooth(0.8, 1, cloud) * 0.6, rain));
    const density = deck * closed;
    layer(out.layers[3], {
      altitude: lerp(r.deckBase, 420, rain),
      height: lerp(450, 900, smooth(0.6, 1, cloud)) + 2400 * Math.pow(rain, 0.8),
      // Optically thin in the dry, so its thinner parts let more light through and an overcast shows light and dark
      // patches (as dense as a cumulus, it was a flat grey); rain makes it an opaque, dark nimbostratus
      densityScale: density > 0.02 ? lerp(lerp(0.015, 0.04, r.deckLumps), 0.3, smooth(0, 0.6, rain)) : 0,
      shapeAmount: 1,
      shapeDetailAmount: 1,
      weatherExponent: 1,
      shapeAlteringBias: 0.5,
      coverageFilterWidth: coverage / Math.max(density, 0.02),
      shadow: true,
    });
  }
  return out;
}

/** The cloud types on show (for the `?cloudseed` console line and the verify suite), lowest first */
export function describeClouds(r: CloudRecipe, cloud: number, rain: number): string[] {
  const s = cloudSkyFor(r, cloud, rain);
  const [cu, mid, high, deck] = s.layers;
  const names: string[] = [];
  const deckOn = deck.height > 0;
  if (deckOn) {
    const formed = deckFormed(r, cloud, rain);
    names.push(rain > 0.25 ? "nimbostratus" : formed > 0.9 && r.deckLumps < 0.35 ? "stratus" : "stratocumulus");
  }
  if (cu.height > 0) {
    if (deckOn && rain > 0.25) names.push("scud");
    else names.push(cu.height > 2000 ? "cumulus congestus" : cu.height > 800 ? "cumulus mediocris" : "cumulus humilis");
  }
  if (mid.height > 0) names.push(r.mid);
  if (high.height > 0) names.push(r.high);
  return names;
}
