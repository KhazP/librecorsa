import * as THREE from "three";
import { text as tx } from "@/lib/text";
import {
  CustomLiveryColors,
  LiveryCategory,
  LiveryConfig,
  LiveryId,
  RunoffStyle,
  TrackSamplePoint,
  TurnMetadata,
} from "@/types/f1";
import rawTrackJson from "../../public/tracks/rwanda_official_short/track_data.json";
import { AI_LINE_WIDTH_SCALE, brakingZoneLevel, computeSpeedProfile, createLc26ProfileCarModel } from "./sim/speed-profile";
import { resolveSurfaceTable, type SurfaceTable, type SurfaceTableOverrides } from "./sim/track-surfaces";
import type { SceneryCutBox } from "./scenery-cuts";
import type { LapStretches } from "./sim/course-limits";
import { correctedDrsZones } from "./drs-zone-fixes";

/** Raw `track_data.json` layout shared by every circuit (the bundled circuit's file is the reference schema) */
export type RawTrackJson = typeof rawTrackJson;

/**
 * The circuit that ships inside the bundle and loads first: RISE Motordrome's short lap. The other circuits (its
 * Grand Prix lap among them) are fetched when the player picks one (track-registry.ts).
 */
export const DEFAULT_TRACK_ID = "rwanda_official_short";

/** The bundled circuit's track data (its outline in the circuit browser while another circuit is loaded) */
export const DEFAULT_TRACK_JSON: RawTrackJson = rawTrackJson;

/**
 * The circuit everything below describes. The bundled one by default; `setActiveTrack` swaps in another layout
 * before the simulator mounts. The exported constants are live bindings / arrays refilled in place, so modules that
 * imported them (menus, F12026CarSim's DRS zones) follow the switch without changes.
 */
let activeRaw: RawTrackJson = rawTrackJson;
export let ACTIVE_TRACK_ID = DEFAULT_TRACK_ID;

/** Altitude (m ASL) of world y = 0 on the active circuit (air density) */
export let BASE_ALTITUDE_M: number = rawTrackJson.metadata.baseAltitudeM;

/** Lap length of the active circuit (m) */
export let TRACK_TOTAL_LENGTH_M = rawTrackJson.metadata.lengthMeters;

export interface DrsZoneDef {
  id: string;
  detection: number;
  start: number;
  end: number;
}

export interface TracksideTvCameraDef {
  name: string;
  position: [number, number, number];
  forward: [number, number, number];
  up: [number, number, number];
  minFov: number;
  maxFov: number;
  inPoint: number;
  outPoint: number;
}

/**
 * A circuit raced under lights (track data `metadata.nightLighting`, written by scripts/tracks/night_lighting.py).
 * At night its road is floodlit, its light sources glow and its tunnels take their own light
 * (render/venue-night-lighting.ts).
 */
export interface NightLightingDef {
  /** Floodlight masts: foot x, y, z (world), lamp height (m), and the level unit vector from the mast to the road */
  lamps?: [x: number, y: number, z: number, heightM: number, towardX: number, towardZ: number][];
  /** Covered stretches of the lap (m, in lap order) and the colour of the light inside each */
  tunnels?: { s0: number; s1: number; color: string }[];
}

/**
 * A point-to-point course (a hill climb): one timed run from the start line to a finish line somewhere else.
 *
 * Its track data is still a closed loop, so everything built on a lap keeps working: the start line is s = 0, the
 * road runs on past the finish line to `endS`, and from there a line with no road under it closes the loop back to
 * `startS`, where the road begins a little before the start line. Between `endS` and `startS` there is nothing to
 * drive on: a car that gets there is put back on the start line (`inDeadZone`).
 */
export interface PointToPointDef {
  /** The finish line (m from the start line): the length of the timed run */
  finishS: number;
  /** Where the road past the finish ends (m from the start line) */
  endS: number;
  /** Where the road before the start line begins (m along the loop, a little short of its length) */
  startS: number;
}

/** Whether `s` (m along the loop) is on the stretch of a point-to-point course that has no road */
export const inDeadZone = (p: PointToPointDef, s: number): boolean => s > p.endS && s < p.startS;

export interface BuiltTrackData {
  /** Circuit id (a folder under public/tracks); absent on synthetic test tracks */
  id?: string;
  /** Set on a point-to-point course (a hill climb); absent on a circuit */
  pointToPoint?: PointToPointDef;
  /** Circuit GLB (relative to the base path); absent on synthetic test tracks */
  meshUrl?: string;
  /** Materials of the circuit GLB's scan that are the racing surface (asphalt shader); none for a circuit with its own road meshes */
  roadMaterials?: string[];
  /** World-space boxes of the scan's geometry to leave out (scenery-cuts.ts) */
  sceneryCuts?: SceneryCutBox[];
  /** Scan materials whose meshes are left out (scenery-cuts.ts) */
  sceneryCutMaterials?: string[];
  /** Scenery files drawn with the circuit (relative to the base path) */
  sceneryUrls?: string[];
  /** Mesh/node names whose meshes do not cast shadows (scene-builder.ts) */
  noShadowMeshes?: string[];
  /** Material names whose meshes do not cast shadows (scene-builder.ts) */
  noShadowMaterials?: string[];
  /** Floodlight masts and tunnels of a circuit raced at night (track data `nightLighting`; venue-night-lighting.ts) */
  nightLighting?: NightLightingDef;
  /** Start grid slots for this layout (behind the S/F line) */
  spawnGrid: GridSlotDef[];
  samples: TrackSamplePoint[];
  totalLengthM: number;
  /** Altitude (m ASL) of world y = 0 on this track, for the air density; absent: the active circuit's */
  baseAltitudeM?: number;
  /** Where another layout's road leaves this lap: there its own road edge and kerbs are the limit (course-limits.ts) */
  otherLayoutRoads?: LapStretches;
  spline: THREE.CatmullRomCurve3;
  getSampleAtDistance: (s: number) => TrackSamplePoint;
  /** Allocation-free variant of `getSampleAtDistance` writing into a caller-owned buffer (`createTrackSampleBuffer`). */
  getSampleAtDistanceInto?: (s: number, out: TrackSamplePoint) => TrackSamplePoint;
  /** Fast scalar curvature lookup at lap distance `s` (1/m), avoiding full `TrackSamplePoint` construction. */
  sampleCurvatureAtDistance?: (s: number) => number;
  projectWorldToTrack: (
    worldX: number,
    worldZ: number,
    hintS?: number
  ) => {
    sample: TrackSamplePoint;
    s: number;
    lateralOffset: number;
    distSq: number;
  };
  /** Allocation-free variant of `projectWorldToTrack` writing into a caller-owned result + `sample` buffer. */
  projectWorldToTrackInto?: (
    worldX: number,
    worldZ: number,
    out: TrackProjectionResult,
    hintS?: number
  ) => TrackProjectionResult;
  /**
   * Continuous world → track mapping: segment `i0 → i1` at parameter `t` (s = (i0 + t)·ds),
   * with the signed horizontal lateral offset `lateralH` (+ right) used by the height profiles.
   */
  locateWorldPoint: (
    worldX: number,
    worldZ: number,
    hintS?: number
  ) => { i0: number; i1: number; t: number; s: number; lateralH: number };
}

/** Reusable target for `BuiltTrackData.projectWorldToTrackInto` */
export interface TrackProjectionResult {
  sample: TrackSamplePoint;
  s: number;
  lateralOffset: number;
  distSq: number;
}

/** Allocates a reusable `TrackSamplePoint` buffer for zero-alloc `getSampleAtDistanceInto` / `projectWorldToTrackInto`. */
export function createTrackSampleBuffer(): TrackSamplePoint {
  return {
    index: 0,
    s: 0,
    t: 0,
    position: new THREE.Vector3(),
    racingLinePos: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, 1),
    normal: new THREE.Vector3(0, 1, 0),
    binormal: new THREE.Vector3(1, 0, 0),
    bankingRad: 0,
    width: 12,
    curvature: 0,
    verticalCurvature: 0,
    slopeSin: 0,
    sector: 1,
    turnNumber: 0,
    turnName: "",
    runoffStyle: "main_straight",
    kerbLeft: false,
    kerbRight: false,
    drsZone: false,
    racingLineOffset: 0,
    racingLineOffsetGt3: 0,
    optimalSpeedKmh: 0,
    brakeLimitKmh: 0,
    brakingZone: 0,
    gripMultiplier: 1,
    yProf: undefined,
  };
}

/** DRS zones of the active circuit (the name predates other circuits), with their corrections (`drs-zone-fixes.ts`) */
export const RWANDA_DRS_ZONES: DrsZoneDef[] = correctedDrsZones(
  DEFAULT_TRACK_ID,
  rawTrackJson.metadata.lengthMeters,
  rawTrackJson.drsZones as DrsZoneDef[]
);
/** Broadcast cameras of the active circuit */
export const RWANDA_TV_CAMERAS: TracksideTvCameraDef[] = [...(rawTrackJson.cameras as TracksideTvCameraDef[])];

export interface GridSlotDef {
  slot: number;
  /** Track distance of the car centre (behind the S/F line, so close to the lap length) */
  s: number;
  /** Signed lateral offset from the centreline (m, + right) */
  lateral: number;
  position: [number, number, number];
  yawRad: number;
  forward: [number, number, number];
}
/** Grid slots of the active circuit */
export const RWANDA_SPAWN_GRID: GridSlotDef[] = [...(rawTrackJson.spawnGrid as GridSlotDef[])];

/**
 * The F1 liveries:
 * - House originals (LibreCorsa, Aurora, Verdant)
 * - 2026 Grid: 11 broadcast-grade liveries inspired by the 11-team 2026 grid (100% original teams & fictional sponsors)
 * - Retro: 6 iconic classic-era inspired liveries (1988, 1978, 1993, 2005, 2009, 1999) with fictional retro sponsors
 */
export const LIVERIES: LiveryConfig[] = [
  // ---- House originals
  {
    id: "librecorsa",
    name: "LibreCorsa #26",
    team: "LibreCorsa",
    primary: "#ccff00",
    secondary: "#11131a",
    accent: "#ff2a3c",
    number: "26",
    category: "house",
    visual: {
      pattern: "librecorsa",
      finish: "satin",
      bodyBase: "#ccff00",
      bodySecondary: "#12151d",
      stripePrimary: "#ff2a3c",
      stripeSecondary: "#f4f7fb",
      noseTip: "#12151d",
      airbox: "#12151d",
      halo: "#12151d",
      wingMain: "#12151d",
      endplate: "#ccff00",
      numberBg: "#12151d",
      numberColor: "#ccff00",
      carbonExposure: 0.85,
      sponsors: {
        title: "LIBRECORSA",
        wing: "APEX LABS",
        nose: "VELOX",
        halo: "KRONOS",
        tech: "STRATA",
      },
      swatchCss:
        "linear-gradient(125deg, #ccff00 0 44%, #ff2a3c 44% 52%, #12151d 52% 86%, #ccff00 86% 100%)",
    },
  },
  {
    id: "aurora",
    name: "Aurora #7",
    team: "Aurora GP",
    primary: "#eef1f5",
    secondary: "#0b3d4a",
    accent: "#ff6a1a",
    number: "7",
    category: "house",
    visual: {
      pattern: "aurora",
      finish: "gloss",
      bodyBase: "#eef2f6",
      bodySecondary: "#0b3d4a",
      stripePrimary: "#ff6a1a",
      stripeSecondary: "#22d3ee",
      noseTip: "#0b3d4a",
      airbox: "#0b3d4a",
      halo: "#0b3d4a",
      wingMain: "#0b3d4a",
      endplate: "#ff6a1a",
      numberBg: "#0b3d4a",
      numberColor: "#eef2f6",
      carbonExposure: 0.55,
      sponsors: {
        title: "AURORA",
        wing: "NOVA CLOUD",
        nose: "HELIOS",
        halo: "PRISM",
        tech: "AETHER",
      },
      swatchCss:
        "linear-gradient(130deg, #eef2f6 0 46%, #ff6a1a 46% 55%, #22d3ee 55% 62%, #0b3d4a 62% 100%)",
    },
  },
  {
    id: "verdant",
    name: "Verdant #29",
    team: "Greenline Racing",
    primary: "#0d5c46",
    secondary: "#0a0f0d",
    accent: "#e8c35a",
    number: "29",
    category: "house",
    visual: {
      pattern: "verdant",
      finish: "metallic",
      bodyBase: "#0d5c46",
      bodySecondary: "#0b110f",
      stripePrimary: "#e8c35a",
      stripeSecondary: "#eef2f0",
      noseTip: "#e8c35a",
      airbox: "#0d5c46",
      halo: "#0b110f",
      wingMain: "#0b110f",
      endplate: "#0d5c46",
      numberBg: "#0b110f",
      numberColor: "#e8c35a",
      carbonExposure: 0.65,
      sponsors: {
        title: "GREENLINE",
        wing: "STRATA",
        nose: "KRONOS",
        halo: "MONOLITH",
        tech: "ZENITH",
      },
      swatchCss:
        "linear-gradient(135deg, #0d5c46 0 54%, #e8c35a 54% 63%, #0a0f0d 63% 100%)",
    },
  },

  // ---- 2026 Grid (11 real-life-inspired 2026 liveries, original teams, fake sponsors, neutral numbers)
  {
    // 1. Papaya Orange & exposed carbon + sky-blue accents
    id: "grid26_papaya",
    name: "Solaris Papaya #24",
    team: "Solaris GP",
    primary: "#ff7a00",
    secondary: "#14161c",
    accent: "#00b7ff",
    number: "24",
    category: "grid2026",
    visual: {
      pattern: "papaya26",
      finish: "satin",
      bodyBase: "#ff7a00",
      bodySecondary: "#14161c",
      stripePrimary: "#00c2ff",
      stripeSecondary: "#f8fafc",
      noseTip: "#ff7a00",
      airbox: "#14161c",
      halo: "#14161c",
      wingMain: "#14161c",
      endplate: "#ff7a00",
      numberBg: "#14161c",
      numberColor: "#ff7a00",
      carbonExposure: 1.0,
      sponsors: {
        title: "SOLARIS",
        wing: "NOVA CLOUD",
        nose: "APEX LABS",
        halo: "PRISM",
        tech: "VELOX",
      },
      swatchCss:
        "linear-gradient(122deg, #ff7a00 0 48%, #00c2ff 48% 55%, #14161c 55% 84%, #ff7a00 84% 100%)",
    },
  },
  {
    // 2. Gloss Rosso Crimson & crisp white engine-cover/wing blocks + blue/yellow accents
    id: "grid26_rosso",
    name: "Corsa Vermilion #19",
    team: "Corsa Italiana",
    primary: "#dc0000",
    secondary: "#f4f6f9",
    accent: "#ffd200",
    number: "19",
    category: "grid2026",
    visual: {
      pattern: "rosso26",
      finish: "gloss",
      bodyBase: "#d80008",
      bodySecondary: "#f5f7fa",
      stripePrimary: "#0088e8",
      stripeSecondary: "#ffd200",
      noseTip: "#d80008",
      airbox: "#f5f7fa",
      halo: "#d80008",
      wingMain: "#f5f7fa",
      endplate: "#d80008",
      numberBg: "#f5f7fa",
      numberColor: "#d80008",
      carbonExposure: 0.45,
      sponsors: {
        title: "CORTEX",
        wing: "CORSA PAY",
        nose: "VELOCE",
        halo: "AETHER",
        tech: "SOLIS",
      },
      swatchCss:
        "linear-gradient(128deg, #d80008 0 54%, #ffd200 54% 59%, #0088e8 59% 65%, #f5f7fa 65% 100%)",
    },
  },
  {
    // 3. Brushed Silver & Obsidian Black + vivid teal diagonal stripe + subtle star-field fade
    id: "grid26_silver",
    name: "Aether Alloy #42",
    team: "Aether Works",
    primary: "#c8d0d8",
    secondary: "#0d1115",
    accent: "#00d2be",
    number: "42",
    category: "grid2026",
    visual: {
      pattern: "silver26",
      finish: "metallic",
      bodyBase: "#cdd5dd",
      bodySecondary: "#0e1217",
      stripePrimary: "#00e0c6",
      stripeSecondary: "#e11d48",
      noseTip: "#d4dce4",
      airbox: "#0e1217",
      halo: "#0e1217",
      wingMain: "#0e1217",
      endplate: "#0e1217",
      numberBg: "#0e1217",
      numberColor: "#00e0c6",
      carbonExposure: 0.85,
      sponsors: {
        title: "AETHER",
        wing: "ZENITH",
        nose: "PRISM",
        halo: "NEXA",
        tech: "HELIOS",
      },
      swatchCss:
        "linear-gradient(124deg, #d5dde5 0 42%, #00e0c6 42% 52%, #0e1217 52% 90%, #e11d48 90% 100%)",
    },
  },
  {
    // 4. Deep Matte Navy + bright yellow nose-cone & sweeping crimson/gold sidepod charge motif
    id: "grid26_cobalt",
    name: "Apex Cobalt #52",
    team: "Apex Racing",
    primary: "#3c46c2",
    secondary: "#0d1018",
    accent: "#c91c34",
    number: "52",
    category: "grid2026",
    visual: {
      pattern: "cobalt26",
      finish: "matte",
      bodyBase: "#142052",
      bodySecondary: "#0d132e",
      stripePrimary: "#e01b36",
      stripeSecondary: "#ffd200",
      noseTip: "#ffd200",
      airbox: "#ffd200",
      halo: "#142052",
      wingMain: "#142052",
      endplate: "#e01b36",
      numberBg: "#ffd200",
      numberColor: "#142052",
      carbonExposure: 0.7,
      sponsors: {
        title: "ORBITAL",
        wing: "VORTEX",
        nose: "KRONOS",
        halo: "TURBOFIN",
        tech: "STRATA",
      },
      swatchCss:
        "linear-gradient(126deg, #ffd200 0 22%, #e01b36 22% 38%, #142052 38% 100%)",
    },
  },
  {
    // 5. Metallic British Racing Green + electric lime pinstripe along nose, sidepods, halo & wings
    id: "grid26_emerald",
    name: "Veridian GT #34",
    team: "Veridian Motorsport",
    primary: "#00594f",
    secondary: "#0c1412",
    accent: "#cedc00",
    number: "34",
    category: "grid2026",
    visual: {
      pattern: "emerald26",
      finish: "metallic",
      bodyBase: "#00594f",
      bodySecondary: "#0a1715",
      stripePrimary: "#d4ef00",
      stripeSecondary: "#f8fafc",
      noseTip: "#00594f",
      airbox: "#00594f",
      halo: "#00594f",
      wingMain: "#00473f",
      endplate: "#00594f",
      numberBg: "#00423a",
      numberColor: "#d4ef00",
      carbonExposure: 0.6,
      sponsors: {
        title: "HELIOS",
        wing: "VALKYRIE",
        nose: "MONOLITH",
        halo: "STRATA",
        tech: "KRONOS",
      },
      swatchCss:
        "linear-gradient(132deg, #00594f 0 58%, #d4ef00 58% 66%, #003a33 66% 100%)",
    },
  },
  {
    // 6. Metallic French Blue + electric pink swooshes & exposed carbon
    id: "grid26_bleu",
    name: "Azur Magenta #38",
    team: "Azur Motorsport",
    primary: "#0074c8",
    secondary: "#131620",
    accent: "#ff5fa2",
    number: "38",
    category: "grid2026",
    visual: {
      pattern: "bleu26",
      finish: "metallic",
      bodyBase: "#0074cc",
      bodySecondary: "#131620",
      stripePrimary: "#ff52a0",
      stripeSecondary: "#f8fafc",
      noseTip: "#ff52a0",
      airbox: "#0074cc",
      halo: "#131620",
      wingMain: "#131620",
      endplate: "#ff52a0",
      numberBg: "#131620",
      numberColor: "#ff52a0",
      carbonExposure: 0.95,
      sponsors: {
        title: "VALKYRIE",
        wing: "PRISM",
        nose: "NEXA",
        halo: "CORSA PAY",
        tech: "AETHER",
      },
      swatchCss:
        "linear-gradient(124deg, #0074cc 0 42%, #ff52a0 42% 62%, #131620 62% 100%)",
    },
  },
  {
    // 7. Royal Blue + navy gradient + signature copper/black top-intake airbox accent & sky pinstripes
    id: "grid26_royal",
    name: "Sovereign Blue #46",
    team: "Sovereign Racing",
    primary: "#168be8",
    secondary: "#0a1122",
    accent: "#f5a623",
    number: "46",
    category: "grid2026",
    visual: {
      pattern: "royal26",
      finish: "metallic",
      bodyBase: "#0d5bd6",
      bodySecondary: "#091430",
      stripePrimary: "#38c6ff",
      stripeSecondary: "#d97a1a",
      noseTip: "#168be8",
      airbox: "#d97a1a",
      halo: "#091430",
      wingMain: "#091430",
      endplate: "#0d5bd6",
      numberBg: "#091430",
      numberColor: "#f8fafc",
      carbonExposure: 0.7,
      sponsors: {
        title: "STRATA",
        wing: "ORBITAL",
        nose: "TURBOFIN",
        halo: "VELOX",
        tech: "NOVA CLOUD",
      },
      swatchCss:
        "linear-gradient(128deg, #168be8 0 38%, #091430 38% 68%, #d97a1a 68% 82%, #38c6ff 82% 100%)",
    },
  },
  {
    // 8. Crisp Pearl White + electric blue swooshes & yellow/crimson nose-to-engine-cover flashes
    id: "grid26_bianco",
    name: "Alba Sport #58",
    team: "Alba Corse",
    primary: "#eef2f6",
    secondary: "#182954",
    accent: "#c81e30",
    number: "58",
    category: "grid2026",
    visual: {
      pattern: "bianco26",
      finish: "gloss",
      bodyBase: "#f4f7fb",
      bodySecondary: "#1546d4",
      stripePrimary: "#e01b32",
      stripeSecondary: "#ffd200",
      noseTip: "#ffd200",
      airbox: "#1546d4",
      halo: "#182954",
      wingMain: "#f4f7fb",
      endplate: "#1546d4",
      numberBg: "#1546d4",
      numberColor: "#f4f7fb",
      carbonExposure: 0.5,
      sponsors: {
        title: "VELOX",
        wing: "TURBOFIN",
        nose: "PRISM",
        halo: "NEXA",
        tech: "CORTEX",
      },
      swatchCss:
        "linear-gradient(126deg, #f4f7fb 0 52%, #1546d4 52% 70%, #ffd200 70% 80%, #e01b32 80% 100%)",
    },
  },
  {
    // 9. Stark White & Carbon Black + bold crimson wing/sidepod/nose racing slashes
    id: "grid26_carbon",
    name: "Vanguard Carbon #64",
    team: "Vanguard GP",
    primary: "#1b1d23",
    secondary: "#eceff3",
    accent: "#cc2952",
    number: "64",
    category: "grid2026",
    visual: {
      pattern: "carbon26",
      finish: "satin",
      bodyBase: "#f2f4f8",
      bodySecondary: "#14161c",
      stripePrimary: "#d91c3a",
      stripeSecondary: "#14161c",
      noseTip: "#d91c3a",
      airbox: "#f2f4f8",
      halo: "#14161c",
      wingMain: "#14161c",
      endplate: "#d91c3a",
      numberBg: "#14161c",
      numberColor: "#f2f4f8",
      carbonExposure: 1.0,
      sponsors: {
        title: "MONOLITH",
        wing: "VORTEX",
        nose: "APEX LABS",
        halo: "KRONOS",
        tech: "STRATA",
      },
      swatchCss:
        "linear-gradient(122deg, #f2f4f8 0 42%, #d91c3a 42% 54%, #14161c 54% 100%)",
    },
  },
  {
    // 10. Titanium Silver & Matte Carbon + bold lava-red diagonal geometric split & interlocking rings
    id: "grid26_titanium",
    name: "Kestrel Titanium #72",
    team: "Kestrel Works",
    primary: "#b4b9c0",
    secondary: "#131418",
    accent: "#ff521b",
    number: "72",
    category: "grid2026",
    visual: {
      pattern: "titanium26",
      finish: "metallic",
      bodyBase: "#b8bec6",
      bodySecondary: "#14151a",
      stripePrimary: "#ff3b14",
      stripeSecondary: "#f8fafc",
      noseTip: "#b8bec6",
      airbox: "#ff3b14",
      halo: "#14151a",
      wingMain: "#14151a",
      endplate: "#ff3b14",
      numberBg: "#14151a",
      numberColor: "#ff3b14",
      carbonExposure: 0.95,
      sponsors: {
        title: "KRONOS",
        wing: "NEXA",
        nose: "AETHER",
        halo: "CORTEX",
        tech: "HELIOS",
      },
      swatchCss:
        "linear-gradient(135deg, #b8bec6 0 45%, #ff3b14 45% 58%, #14151a 58% 100%)",
    },
  },
  {
    // 11. Stealth Carbon Black & Chrome Silver + bold gold/blue geometric crest & angular flank stripes
    id: "grid26_crest",
    name: "Meridian Crest #86",
    team: "Meridian Racing",
    primary: "#141820",
    secondary: "#d6dbe2",
    accent: "#d4af37",
    number: "86",
    category: "grid2026",
    visual: {
      pattern: "crest26",
      finish: "chrome",
      bodyBase: "#12151d",
      bodySecondary: "#d8dee6",
      stripePrimary: "#dfb83c",
      stripeSecondary: "#1d6fe8",
      noseTip: "#d8dee6",
      airbox: "#12151d",
      halo: "#12151d",
      wingMain: "#12151d",
      endplate: "#d8dee6",
      rimColor: "#262b36",
      numberBg: "#12151d",
      numberColor: "#dfb83c",
      carbonExposure: 0.9,
      sponsors: {
        title: "ZENITH",
        wing: "NOVA CLOUD",
        nose: "CORSA PAY",
        halo: "ORBITAL",
        tech: "MONOLITH",
      },
      swatchCss:
        "linear-gradient(125deg, #12151d 0 44%, #d8dee6 44% 66%, #dfb83c 66% 78%, #1d6fe8 78% 100%)",
    },
  },

  // ---- Retro Classics (6 iconic historical-era liveries, 100% fake retro sponsors, neutral numbers)
  {
    // 1. 1988 Red & White Chevron
    id: "retro_red_white",
    name: "1988 Crimson Chevron #74",
    team: "Classic 1988",
    primary: "#f4f5f7",
    secondary: "#ff2418",
    accent: "#16181e",
    number: "74",
    category: "retro",
    visual: {
      pattern: "retro88_chevron",
      finish: "gloss",
      bodyBase: "#f5f6f8",
      bodySecondary: "#ff2418",
      stripePrimary: "#14161b",
      stripeSecondary: "#ffd200",
      noseTip: "#f5f6f8",
      airbox: "#ff2418",
      halo: "#14161b",
      wingMain: "#ff2418",
      endplate: "#f5f6f8",
      numberBg: "#f5f6f8",
      numberColor: "#14161b",
      carbonExposure: 0.0,
      sponsors: {
        title: "MARVEX",
        wing: "KAZE",
        nose: "SHIELD",
        halo: "CHRONO",
        tech: "APEX OIL",
      },
      swatchCss:
        "linear-gradient(118deg, #f5f6f8 0 46%, #ff2418 46% 88%, #14161b 88% 100%)",
    },
  },
  {
    // 2. 1978 Black & Gold Pinstripe
    id: "retro_black_gold",
    name: "1978 Imperial Black & Gold #68",
    team: "Classic 1978",
    primary: "#0e1014",
    secondary: "#1a1814",
    accent: "#dfba52",
    number: "68",
    category: "retro",
    visual: {
      pattern: "retro78_pinstripe",
      finish: "gloss",
      bodyBase: "#0c0e12",
      bodySecondary: "#161410",
      stripePrimary: "#e2bc54",
      stripeSecondary: "#f6dc84",
      noseTip: "#0c0e12",
      airbox: "#0c0e12",
      halo: "#0c0e12",
      wingMain: "#0c0e12",
      endplate: "#0c0e12",
      rimColor: "#d6ad42",
      numberBg: "#0c0e12",
      numberColor: "#e2bc54",
      carbonExposure: 0.0,
      sponsors: {
        title: "IMPERIAL GOLD",
        wing: "IMPERIAL",
        nose: "REGAL",
        halo: "CHRONO",
        tech: "AURELIA",
      },
      swatchCss:
        "linear-gradient(135deg, #0c0e12 0 38%, #e2bc54 38% 43%, #0c0e12 43% 50%, #e2bc54 50% 55%, #0c0e12 55% 100%)",
    },
  },
  {
    // 3. 1993 Blue, Yellow & White
    id: "retro_tri_93",
    name: "1993 Savanna Tricolore #82",
    team: "Classic 1993",
    primary: "#133294",
    secondary: "#f8cb0e",
    accent: "#f4f6f8",
    number: "82",
    category: "retro",
    visual: {
      pattern: "retro93_tri",
      finish: "gloss",
      bodyBase: "#123296",
      bodySecondary: "#f8cb0e",
      stripePrimary: "#f5f7fa",
      stripeSecondary: "#e01e24",
      noseTip: "#123296",
      airbox: "#123296",
      halo: "#123296",
      wingMain: "#123296",
      endplate: "#f8cb0e",
      numberBg: "#f5f7fa",
      numberColor: "#e01e24",
      carbonExposure: 0.0,
      sponsors: {
        title: "SAVANNA",
        wing: "OPTIX",
        nose: "KAZE",
        halo: "VELOCE",
        tech: "PRISM",
      },
      swatchCss:
        "linear-gradient(128deg, #123296 0 38%, #f8cb0e 38% 68%, #e01e24 68% 74%, #f5f7fa 74% 100%)",
    },
  },
  {
    // 4. 2005 Sky-Blue & Yellow
    id: "retro_sky_05",
    name: "2005 Zephyr Sky & Gold #98",
    team: "Classic 2005",
    primary: "#36a8e0",
    secondary: "#ffd400",
    accent: "#0f234a",
    number: "98",
    category: "retro",
    visual: {
      pattern: "retro05_sky",
      finish: "gloss",
      bodyBase: "#34a8e2",
      bodySecondary: "#ffd500",
      stripePrimary: "#0e224a",
      stripeSecondary: "#ffffff",
      noseTip: "#ffd500",
      airbox: "#ffd500",
      halo: "#0e224a",
      wingMain: "#34a8e2",
      endplate: "#ffd500",
      numberBg: "#0e224a",
      numberColor: "#ffd500",
      carbonExposure: 0.1,
      sponsors: {
        title: "ZEPHYR",
        wing: "SONIC",
        nose: "SOLAR",
        halo: "NEXA",
        tech: "AETHER",
      },
      swatchCss:
        "linear-gradient(124deg, #34a8e2 0 46%, #0e224a 46% 53%, #ffd500 53% 100%)",
    },
  },
  {
    // 5. 2009 White & Fluoro-Lime
    id: "retro_fluoro_09",
    name: "2009 Brawler Fluoro #91",
    team: "Classic 2009",
    primary: "#f5f7fa",
    secondary: "#d8ff00",
    accent: "#111318",
    number: "91",
    category: "retro",
    visual: {
      pattern: "retro09_fluoro",
      finish: "gloss",
      bodyBase: "#f6f8fb",
      bodySecondary: "#d8ff00",
      stripePrimary: "#111318",
      stripeSecondary: "#d8ff00",
      noseTip: "#d8ff00",
      airbox: "#f6f8fb",
      halo: "#111318",
      wingMain: "#f6f8fb",
      endplate: "#d8ff00",
      numberBg: "#111318",
      numberColor: "#d8ff00",
      carbonExposure: 0.15,
      sponsors: {
        title: "BRAWLER",
        wing: "VEX",
        nose: "STRATA",
        halo: "ORBITAL",
        tech: "CORTEX",
      },
      swatchCss:
        "linear-gradient(130deg, #f6f8fb 0 56%, #111318 56% 63%, #d8ff00 63% 88%, #111318 88% 100%)",
    },
  },
  {
    // 6. 1999 Buzzing Yellow & Black
    id: "retro_hornet_99",
    name: "1999 Hornet Sting #94",
    team: "Classic 1999",
    primary: "#f6c90e",
    secondary: "#121318",
    accent: "#ff3b1f",
    number: "94",
    category: "retro",
    visual: {
      pattern: "retro99_hornet",
      finish: "gloss",
      bodyBase: "#f6c90e",
      bodySecondary: "#121318",
      stripePrimary: "#ff3b1f",
      stripeSecondary: "#ffffff",
      noseTip: "#121318",
      airbox: "#f6c90e",
      halo: "#121318",
      wingMain: "#121318",
      endplate: "#121318",
      numberBg: "#121318",
      numberColor: "#f6c90e",
      carbonExposure: 0.05,
      sponsors: {
        title: "HORNET",
        wing: "BEACON",
        nose: "VORTEX",
        halo: "KRONOS",
        tech: "SHIELD",
      },
      swatchCss:
        "linear-gradient(122deg, #f6c90e 0 50%, #121318 50% 62%, #f6c90e 62% 72%, #121318 72% 88%, #ff3b1f 88% 100%)",
    },
  },
];

export const LIVERY_CATEGORY_LABELS: Readonly<Record<Exclude<LiveryCategory, "custom">, string>> = {
  house: "LibreCorsa",
  get grid2026() { return tx("game.livery.grid2026"); },
  get retro() { return tx("game.livery.retro"); },
};

export const DEFAULT_CUSTOM_LIVERY: Readonly<CustomLiveryColors> = {
  primary: "#00c8ff",
  secondary: "#12151e",
  accent: "#ff3355",
};

/** Curated motorsport swatches for controller / keyboard custom livery picking alongside the native colour input */
export const CUSTOM_LIVERY_PALETTE: readonly { hex: string; name: string }[] = [
  { hex: "#eef2f6", get name() { return tx("game.livery.colourChalk"); } },
  { hex: "#141820", get name() { return tx("game.livery.colourCarbon"); } },
  { hex: "#b4b9c0", get name() { return tx("game.livery.colourAlloy"); } },
  { hex: "#dc0000", get name() { return tx("game.livery.colourVermilion"); } },
  { hex: "#ff7a00", get name() { return tx("game.livery.colourPapaya"); } },
  { hex: "#f0b429", get name() { return tx("game.livery.colourGold"); } },
  { hex: "#cedc00", get name() { return tx("game.livery.colourVolt"); } },
  { hex: "#0d6e4f", get name() { return tx("game.livery.colourEmerald"); } },
  { hex: "#00c8ff", get name() { return tx("game.livery.colourCyan"); } },
  { hex: "#1d4ed8", get name() { return tx("game.livery.colourCobalt"); } },
  { hex: "#1c2e6b", get name() { return tx("game.livery.colourIndigo"); } },
  { hex: "#ff4d94", get name() { return tx("game.livery.colourMagenta"); } },
];

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Validates a custom livery's three hex colours, falling back field by field to DEFAULT_CUSTOM_LIVERY */
export function sanitizeCustomLivery(v: unknown): CustomLiveryColors {
  const d = DEFAULT_CUSTOM_LIVERY;
  if (!v || typeof v !== "object") return { ...d };
  const o = v as Record<string, unknown>;
  const pick = (raw: unknown, fb: string) => (typeof raw === "string" && HEX_COLOR_RE.test(raw) ? raw.toLowerCase() : fb);
  return {
    primary: pick(o.primary, d.primary),
    secondary: pick(o.secondary, d.secondary),
    accent: pick(o.accent, d.accent),
  };
}

/** Builds a LiveryConfig from custom user-picked colours */
export function buildCustomLivery(colors: CustomLiveryColors): LiveryConfig {
  const clean = sanitizeCustomLivery(colors);
  return {
    id: "custom",
    name: "Custom Paint",
    team: "Custom",
    primary: clean.primary,
    secondary: clean.secondary,
    accent: clean.accent,
    number: "26",
    category: "custom",
    visual: {
      pattern: "custom",
      finish: "satin",
      bodyBase: clean.primary,
      bodySecondary: clean.secondary,
      stripePrimary: clean.accent,
      stripeSecondary: "#f8fafc",
      noseTip: clean.secondary,
      airbox: clean.secondary,
      halo: clean.secondary,
      wingMain: clean.secondary,
      endplate: clean.primary,
      numberBg: clean.secondary,
      numberColor: clean.accent,
      carbonExposure: 0.75,
      sponsors: {
        title: "LIBRECORSA",
        wing: "APEX LABS",
        nose: "VELOX",
        halo: "KRONOS",
        tech: "STRATA",
      },
      swatchCss: `linear-gradient(126deg, ${clean.primary} 0 48%, ${clean.accent} 48% 60%, ${clean.secondary} 60% 100%)`,
    },
  };
}

/** Legacy livery IDs aliased smoothly so previously saved user settings resolve cleanly */
const LEGACY_LIVERY_ALIASES: Readonly<Record<string, LiveryId>> = {
  oracle_red_bull: "grid26_cobalt",
  retro_tri_92: "retro_tri_93",
  retro_emerald_91: "retro_fluoro_09",
  retro_powder_69: "retro_hornet_99",
};

/** Resolves a saved livery id (including "custom") into a paintable LiveryConfig */
export function resolveLivery(id: string | null | undefined, custom?: CustomLiveryColors | null): LiveryConfig {
  if (id === "custom") return buildCustomLivery(custom ?? DEFAULT_CUSTOM_LIVERY);
  const canonical = id ? (LEGACY_LIVERY_ALIASES[id] ?? id) : undefined;
  return LIVERIES.find((l) => l.id === canonical) ?? LIVERIES[0];
}

/**
 * 1-to-1 mapping from the 11 AI roster codes (`ai-opponents.ts` AI_DRIVERS + AI_RESERVE_DRIVERS) to distinct 2026 grid
 * liveries whose primary/accent colours align with each driver's HUD `teamColorHex`.
 */
const AI_DRIVER_LIVERY_ID: Readonly<Record<string, LiveryId>> = {
  KIG: "grid26_papaya",
  MUS: "grid26_rosso",
  NYA: "grid26_silver",
  RUB: "grid26_cobalt",
  HUY: "grid26_titanium",
  GIS: "grid26_emerald",
  KAR: "grid26_bleu",
  NYU: "grid26_royal",
  BUT: "grid26_crest",
  RUH: "grid26_bianco",
  KIB: "grid26_carbon",
};

/** Maps an AI driver code to its distinct colour-matched grid livery, with deterministic hash fallback for human peers */
export function liveryForDriverCode(code: string): LiveryConfig {
  const mappedId = AI_DRIVER_LIVERY_ID[code];
  if (mappedId) {
    const found = LIVERIES.find((l) => l.id === mappedId);
    if (found) return found;
  }
  const grid = LIVERIES.filter((l) => l.category === "grid2026");
  const pool = grid.length > 0 ? grid : LIVERIES;
  let hash = 0;
  for (let i = 0; i < code.length; i++) hash = (hash * 31 + code.charCodeAt(i)) >>> 0;
  return pool[hash % pool.length] ?? LIVERIES[0];
}

function turnsOf(raw: RawTrackJson): TurnMetadata[] {
  return (raw.turns as TurnMetadata[]).map((t) => ({ ...t, sector: t.sector as 1 | 2 | 3 }));
}

/** Corners of the active circuit, detected from the centreline curvature and exported with the track */
export const TURN_METADATA: TurnMetadata[] = turnsOf(rawTrackJson);

function isInDrsZone(t: number): boolean {
  const normT = ((t % 1) + 1) % 1;
  for (const z of RWANDA_DRS_ZONES) {
    if (z.start <= z.end) {
      if (normT >= z.start && normT <= z.end) return true;
    } else {
      if (normT >= z.start || normT <= z.end) return true;
    }
  }
  return false;
}

let LEFT_HAND_TURNS = new Set(
  TURN_METADATA.filter((t) => t.direction === "left").map((t) => t.number)
);
let TURN_NAMES = new Map(TURN_METADATA.map((t) => [t.number, t.name]));
let RAW_DS = rawTrackJson.metadata.lengthMeters / rawTrackJson.samples.length;

type RawTrackSample = (typeof rawTrackJson.samples)[number];

function rawSampleAtS(s: number): RawTrackSample {
  const n = activeRaw.samples.length;
  const i = ((Math.round(s / RAW_DS) % n) + n) % n;
  return activeRaw.samples[i];
}

/** Optional fields newer circuits add to the metadata block */
export interface TrackMetaExtras {
  shortName?: string;
  baseAltitudeM?: number;
  /**
   * `roadMaterials`: the scan's racing-surface materials (build_track.py), drawn with the asphalt shader;
   * `cutBoxes` / `cutMaterials`: scan geometry standing on the racing line, left out at load (scenery-cuts.ts);
   * `conformSurfaces`: the off-road collider bands and the visual road are fitted to `Track_Surface_Road` at load
   * (TrackColliderQuery.ts), for converted circuits whose surfaces don't meet the road edge as exported, and the bands
   * are taken off the road where they lie on it;
   * `scenery`: scenery files drawn with the circuit (instanced trees: scenery-instances.ts);
   * `barrierMeshes`: drawn barriers the converted circuit gives no collider (Monaco's Armco ends and orange blocks),
   * by mesh name: the cars hit them and the racing line keeps clear of them as of the `Track_Collider_Wall_*` walls
   */
  mesh?: {
    url?: string;
    roadMaterials?: string[];
    cutBoxes?: SceneryCutBox[];
    cutMaterials?: string[];
    conformSurfaces?: boolean;
    scenery?: string[];
    barrierMeshes?: string[];
    noShadowMeshes?: string[];
    noShadowMaterials?: string[];
  };
  credit?: { title: string; author: string; url: string; short?: string; license: string; licenseUrl: string };
  /** A point-to-point course (a hill climb): its finish line and the ends of its road */
  pointToPoint?: PointToPointDef;
  /** Per-kind overrides of the default surface table (track-surfaces.ts) */
  surfaceTable?: SurfaceTableOverrides;
  /**
   * A layout sharing its model with another: the stretches of this lap ([from, to], m) where the other layout's road
   * leaves it, beyond its edges. There this lap's road edge and kerbs are the track limits (course-limits.ts)
   */
  otherLayoutRoads?: [number, number][];
  /** A circuit raced under lights: its floodlight masts and covered stretches (scripts/tracks/night_lighting.py) */
  nightLighting?: NightLightingDef;
  /**
   * Drive-plan check per car (scripts/ai/check-lines.ts): a flying AI lap on the full physics tracking the stored line.
   * The field drives a car on plans only where its check passed (no barrier hit, on the road, on the line, near the
   * plan's time); elsewhere it keeps its own driver
   */
  aiPlans?: Partial<Record<string, AiPlanCheck>>;
}

export interface AiPlanCheck {
  ok: boolean;
  physicsLapS: number;
  planLapS: number;
  wallHits: number;
  offTrackFrames: number;
  maxErrM: number;
  /**
   * The highest plan grip (share of the car's measured limits) this car still drove cleanly here, with a margin: the
   * fastest AI level plans up to it. Absent: not searched (the field stays at its default plan grip)
   */
  maxGrip?: number;
  /** Date of the check (ISO) */
  checked: string;
}

/** The active circuit as it was given to `setActiveTrack`: what another thread needs to make it its own active circuit */
export function getActiveTrackSource(): { id: string; raw: RawTrackJson } {
  return { id: ACTIVE_TRACK_ID, raw: activeRaw };
}

/** Metadata of the active circuit */
export function getActiveTrackMetadata(): RawTrackJson["metadata"] & TrackMetaExtras {
  return activeRaw.metadata as RawTrackJson["metadata"] & TrackMetaExtras;
}

/** The active circuit's point-to-point course, or null on a circuit that laps */
export function getActivePointToPoint(): PointToPointDef | null {
  return getActiveTrackMetadata().pointToPoint ?? null;
}

/** What a timed lap is called on the active circuit: a hill climb's is a run */
export const activeLapWord = (): "Run" | "Lap" => (getActivePointToPoint() ? "Run" : "Lap");

/**
 * The distance a lap time is set over: the lap, or on a point-to-point course the run from the start line to the
 * finish line (`TRACK_TOTAL_LENGTH_M` there is the whole loop, most of it not road)
 */
export function getActiveTimedLengthM(): number {
  return getActivePointToPoint()?.finishS ?? TRACK_TOTAL_LENGTH_M;
}

/** The active circuit's surface table, with the track data it was resolved from (as cachedBuiltTrack keeps its id) */
let cachedSurfaceTable: { raw: RawTrackJson; table: SurfaceTable } | null = null;

/** Surface physics of the active circuit: the default table with its `metadata.surfaceTable` overrides */
export function getActiveSurfaceTable(): SurfaceTable {
  if (cachedSurfaceTable?.raw !== activeRaw) {
    cachedSurfaceTable = { raw: activeRaw, table: resolveSurfaceTable(getActiveTrackMetadata().surfaceTable) };
  }
  return cachedSurfaceTable.table;
}

function refill<T>(target: T[], items: T[]): void {
  target.length = 0;
  target.push(...items);
}

/**
 * Makes `raw` (a `public/tracks/<id>/track_data.json`) the circuit every track query, menu and car uses.
 * Call before the simulator mounts: built track data, physics and scenes made earlier keep the old layout.
 */
export function setActiveTrack(id: string, raw: RawTrackJson = rawTrackJson): void {
  // Everything is read from `raw` before anything changes: malformed data throws with the previous circuit whole
  const meta = raw.metadata as RawTrackJson["metadata"] & TrackMetaExtras;
  const rawDs = meta.lengthMeters / raw.samples.length;
  // Every car, the AI and the HUD read the zones from here: their corrections are made once, before anything sees them
  const drsZones = correctedDrsZones(id, meta.lengthMeters, raw.drsZones as DrsZoneDef[]);
  const cameras = [...(raw.cameras as TracksideTvCameraDef[])];
  const spawnGrid = [...(raw.spawnGrid as GridSlotDef[])];
  const turns = turnsOf(raw);
  if (meta.baseAltitudeM === undefined) {
    console.warn(`Circuit "${id}" has no baseAltitudeM: air density as at sea level`);
  }
  activeRaw = raw;
  ACTIVE_TRACK_ID = id;
  TRACK_TOTAL_LENGTH_M = meta.lengthMeters;
  BASE_ALTITUDE_M = meta.baseAltitudeM ?? 0;
  refill(RWANDA_DRS_ZONES, drsZones);
  refill(RWANDA_TV_CAMERAS, cameras);
  refill(RWANDA_SPAWN_GRID, spawnGrid);
  refill(TURN_METADATA, turns);
  LEFT_HAND_TURNS = new Set(TURN_METADATA.filter((t) => t.direction === "left").map((t) => t.number));
  TURN_NAMES = new Map(TURN_METADATA.map((t) => [t.number, t.name]));
  RAW_DS = rawDs;
  cachedBuiltTrack = null;
  cachedSurfaceTable = null;
}

function getTurnInfoAtS(
  s: number,
  totalLen: number
): {
  sector: 1 | 2 | 3;
  turnNumber: number;
  turnName: string;
  runoffStyle: RunoffStyle;
  minBankRad: number;
} {
  const wrapped = ((s % totalLen) + totalLen) % totalLen;
  const raw = rawSampleAtS(wrapped);
  const sector = raw.sec as 1 | 2 | 3;
  const turnNumber = raw.turn;
  const turnName =
    TURN_NAMES.get(turnNumber) ??
    (sector === 1 ? "Start / Finish Straight" : `Sector ${sector}`);
  return {
    sector,
    turnNumber,
    turnName,
    runoffStyle: raw.zone as RunoffStyle,
    minBankRad: (LEFT_HAND_TURNS.has(turnNumber) ? -1 : 1) * Math.abs(raw.b),
  };
}


let cachedBuiltTrack: BuiltTrackData | null = null;

export const LAT_PROFILE_OFFSETS = [-12, -8, -5, -2.5, 0, 2.5, 5, 8, 12] as const;

/**
 * A profile column counts as road once the road's edge is past it, and comes in over this far (m) as the edge moves out
 * past it; the column after it is eased in past the edge over the same distance (scripts/tracks/build_track.py
 * EDGE_COLUMN_RAMP_M)
 */
const EDGE_COLUMN_RAMP_M = 0.5;

const LAT_CENTRE = (LAT_PROFILE_OFFSETS.length - 1) >> 1;

/** The profile's height at `lat` (|lat| <= 12) by plain interpolation between its columns */
function profileBetweenColumns(yp: readonly number[], lat: number): number {
  for (let k = 0; k < LAT_PROFILE_OFFSETS.length - 1; k++) {
    const l0 = LAT_PROFILE_OFFSETS[k];
    const l1 = LAT_PROFILE_OFFSETS[k + 1];
    if (lat >= l0 && lat <= l1) return yp[k] + ((yp[k + 1] - yp[k]) * (lat - l0)) / (l1 - l0);
  }
  return yp[LAT_CENTRE];
}

/** |lateral offset| of the profile column `m` columns out from the centre on `side` (−1 left, +1 right) */
function columnLat(side: number, m: number): number {
  return Math.abs(LAT_PROFILE_OFFSETS[LAT_CENTRE + side * m]);
}

/** The line through columns `m0` and `m1` on `side`, at |offset| `x` */
function columnLine(yp: readonly number[], side: number, m0: number, m1: number, x: number): number {
  const y0 = yp[LAT_CENTRE + side * m0];
  const l0 = columnLat(side, m0);
  return y0 + ((yp[LAT_CENTRE + side * m1] - y0) * (x - l0)) / (columnLat(side, m1) - l0);
}

/** The road at |offset| `x` <= half width, `j` the outermost column the edge is past */
function roadSurface(yp: readonly number[], side: number, j: number, halfWidth: number, x: number): number {
  if (j <= 1) return columnLine(yp, side, 0, 1, x);
  if (x <= columnLat(side, j - 1)) return profileBetweenColumns(yp, side * x);
  const w = Math.min(1, (halfWidth - columnLat(side, j)) / EDGE_COLUMN_RAMP_M);
  return (1 - w) * columnLine(yp, side, j - 2, j - 1, x) + w * columnLine(yp, side, j - 1, j, x);
}

/** Past the edge: from the edge's height to column `m`, then on through the columns past it */
function easeToColumn(yp: readonly number[], side: number, m: number, yEdge: number, halfWidth: number, lat: number): number {
  const a = Math.abs(lat);
  if (m > LAT_CENTRE || a >= columnLat(side, m)) return profileBetweenColumns(yp, lat);
  return yEdge + ((yp[LAT_CENTRE + side * m] - yEdge) * (a - halfWidth)) / (columnLat(side, m) - halfWidth);
}

/**
 * Height at `lat` (|lat| <= 12, + right) of a road of half width `halfWidth` from its profile `yp`. The road keeps its own
 * crossfall out to its edge: the columns past the edge hold the ground beside the road (a bank, a ditch, the ground
 * under a bridge), so from the last road column on the height follows the line through the last two road columns, and
 * only past the edge does it ease to the next column out. A column counts as road once the edge is past it and comes in
 * over EDGE_COLUMN_RAMP_M as the edge moves on; past the edge the column after the next one out comes in the same way
 * while the next one is within that distance, so nothing steps as the road widens past a column. The converter builds
 * the road colliders by the same rule (scripts/tracks/build_track.py `road_profile_height`).
 */
function roadProfileHeight(yp: readonly number[], halfWidth: number, lat: number): number {
  const side = lat > 0 ? 1 : -1;
  const a = Math.abs(lat);
  // j: the outermost column the edge is past
  let j = 0;
  while (j < LAT_CENTRE && columnLat(side, j + 1) < halfWidth) j++;
  if (a <= halfWidth) return roadSurface(yp, side, j, halfWidth, a);
  if (j >= LAT_CENTRE) return profileBetweenColumns(yp, lat);
  const yEdge = roadSurface(yp, side, j, halfWidth, halfWidth);
  const u = Math.min(1, (columnLat(side, j + 1) - halfWidth) / EDGE_COLUMN_RAMP_M);
  const next = easeToColumn(yp, side, j + 1, yEdge, halfWidth, lat);
  if (u >= 1 || j + 2 > LAT_CENTRE) return next;
  return u * next + (1 - u) * easeToColumn(yp, side, j + 2, yEdge, halfWidth, lat);
}

/**
 * Evaluates the exact 3D track surface height `y` at a signed lateral offset `lateralOffsetM`
 * (`-left .. +right` along horizontal track binormal) for a `TrackSamplePoint`: on the road and up to 12 m out, the
 * profile read by `roadProfileHeight` for the sample's width; further out, the outermost columns' slope carried on.
 */
export function evaluateSampleLateralHeightM(
  sample: TrackSamplePoint,
  lateralOffsetM: number
): number {
  const yp = sample.yProf;
  if (!yp || yp.length !== LAT_PROFILE_OFFSETS.length) {
    return sample.position.y - Math.sin(sample.bankingRad) * lateralOffsetM;
  }
  const n = LAT_PROFILE_OFFSETS.length;
  if (lateralOffsetM <= LAT_PROFILE_OFFSETS[0]) {
    const slopeLeft =
      (yp[1] - yp[0]) / (LAT_PROFILE_OFFSETS[1] - LAT_PROFILE_OFFSETS[0]);
    return yp[0] + slopeLeft * (lateralOffsetM - LAT_PROFILE_OFFSETS[0]);
  }
  if (lateralOffsetM >= LAT_PROFILE_OFFSETS[n - 1]) {
    const slopeRight =
      (yp[n - 1] - yp[n - 2]) /
      (LAT_PROFILE_OFFSETS[n - 1] - LAT_PROFILE_OFFSETS[n - 2]);
    return yp[n - 1] + slopeRight * (lateralOffsetM - LAT_PROFILE_OFFSETS[n - 1]);
  }
  return roadProfileHeight(yp, sample.width / 2, lateralOffsetM);
}

/**
 * Uniform Catmull-Rom weights for samples [i−1, i, i+1, i+2] at parameter t ∈ [0, 1] between i and i+1.
 * Used for road heights so the surface is C1 along the track: linear interpolation between
 * profiles 4.4 m apart leaves slope kinks that hit the tyres like bumps at speed.
 */
export function catmullRomWeights(t: number): [number, number, number, number] {
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    0.5 * (-t3 + 2 * t2 - t),
    0.5 * (3 * t3 - 5 * t2 + 2),
    0.5 * (-3 * t3 + 4 * t2 + t),
    0.5 * (t3 - t2),
  ];
}

/**
 * Materials of converted circuits whose `Track_Model` meshes should not cast shadows.
 * Converted circuits merge objects by material across rolling terrain, so low barriers, tyre stacks, marshals,
 * workers, fence posts, parked cars, and ground surfaces can span tens of metres vertically and pass `size.y > 1.2`.
 * All layouts of the shared VIR venue (`venue-models.ts`) share this exclusion list.
 *
 * Checked against vir.glb on 19 Nov 2026 (share of each material's area in faces steeper than 60 degrees): no
 * building is on the list. PADDOCK MAIN (51,000 m2), CONCRETE BEIGE and CONCRETE-LIGHT are flat slabs (0-1 % steep);
 * "05 - Default" is the parked campers (55 % steep, up to 2.7 m tall, 99k triangles); barriers, tyre walls and parked
 * cars stand 1.1-1.5 m; the workers and marshals are 192k triangles over 166 m2. What the list costs to the look:
 * the barriers, tyre walls, campers, parked cars and people stand without a shadow of their own.
 */
const VIR_NO_SHADOW_MATERIALS: readonly string[] = [
  // Barriers, tyre walls, cones (keep PIT-WALL for pitlane grounding)
  "ARMCO GREEN",
  "ARMCO ORANGE",
  "TYRE01",
  "TYRE WALL1",
  "CONCRETE BARRIER",
  "BARRIER",
  "CONE",
  "CONCRETE BARRIER SOUTH PADDOCK",
  "CONCRETE WALL SOUTH PADDOCK",
  // Trackside workers, marshals, crowd
  "WORKERS",
  "MARSHALLS",
  "3DCROWD",
  "PeopleSit1",
  // Fence posts, paddock posts, bins
  "METALPOST02",
  "FENCE POST1",
  "PADDOCK POST",
  "RUBBISH BIN",
  // Distant off-track parked campers & spectator cars
  "05 - Default",
  "PARKED CARS",
  // Flat terrain, ground, water, edging, road, white lines spanning hill elevation
  "TERRAIN",
  "EDGING1",
  "WHITE-LINE",
  "WATER",
  "EARTH",
  "SKIDPAN",
  "PADDOCK MAIN",
  "ROAD",
  "ROAD_ALT1__asphalt-patriot_dds",
  "ASPHALT-PLAIN",
  "ROAD ALT1-3",
  "ROAD ALT1-2",
  "ASPHALT PLAIN DARK",
  "CONCRETE BEIGE",
  "CONCRETE-LIGHT",
];

const TRACK_NO_SHADOW_MATERIALS: Readonly<Record<string, readonly string[]>> = {
  vir: VIR_NO_SHADOW_MATERIALS,
  vir_grand_east: VIR_NO_SHADOW_MATERIALS,
  vir_grand_west: VIR_NO_SHADOW_MATERIALS,
  vir_north: VIR_NO_SHADOW_MATERIALS,
  vir_patriot: VIR_NO_SHADOW_MATERIALS,
  vir_patriot_reverse: VIR_NO_SHADOW_MATERIALS,
  vir_south: VIR_NO_SHADOW_MATERIALS,
};

/** Declarative per-circuit shadow-excluded materials, merged with any `metadata.mesh.noShadowMaterials` in JSON. */
export function trackNoShadowMaterials(trackId: string | undefined, extra?: readonly string[]): string[] {
  const builtIn = trackId ? TRACK_NO_SHADOW_MATERIALS[trackId] : undefined;
  if (!builtIn?.length && !extra?.length) return [];
  return [...new Set([...(builtIn ?? []), ...(extra ?? [])])];
}

/** Built data of the active circuit (the bundled one unless `setActiveTrack` chose another) */
export function getActiveTrackData(numSamples = 1200): BuiltTrackData {
  if (cachedBuiltTrack && cachedBuiltTrack.samples.length === numSamples && cachedBuiltTrack.id === ACTIVE_TRACK_ID) {
    return cachedBuiltTrack;
  }

  const rawSamples = activeRaw.samples;
  const rawCount = rawSamples.length;
  const totalLength = activeRaw.metadata.lengthMeters;

  const splinePts = rawSamples.map(
    (s) => new THREE.Vector3(s.p[0], s.p[1], s.p[2])
  );
  const spline = new THREE.CatmullRomCurve3(splinePts, true, "centripetal", 0.5);

  const NUM_SAMPLES = numSamples;
  const ds = totalLength / NUM_SAMPLES;

  const positions: THREE.Vector3[] = [];
  const racingOffsetsM: number[] = [];
  const gt3OffsetsM: number[] = [];
  const yProfs: number[][] = [];
  const widths: number[] = [];
  const bankings: number[] = [];
  const grips: number[] = [];
  const aiSpeedsKmh: number[] = [];
  // Per-side run-off / gravel / barrier extents and kerb flags exported with the 2026 layout
  const edges: {
    rL: number; rR: number; gL: number; gR: number; wL: number; wR: number; kL: boolean; kR: boolean;
  }[] = [];

  let rawIdx = 0;
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const targetS = i * ds;
    while (
      rawIdx < rawCount - 1 &&
      rawSamples[(rawIdx + 1) % rawCount].s <= targetS
    ) {
      rawIdx++;
    }
    const r0 = rawSamples[rawIdx] as typeof rawSamples[0] & { yProf?: number[] };
    const r1 = rawSamples[(rawIdx + 1) % rawCount] as typeof rawSamples[0] & {
      yProf?: number[];
    };
    const s0 = r0.s;
    const s1 = rawIdx + 1 < rawCount ? r1.s : totalLength;
    const span = Math.max(0.001, s1 - s0);
    const alpha = THREE.MathUtils.clamp((targetS - s0) / span, 0, 1);

    // Cubic (Catmull-Rom) resampling: linear interpolation of the ~4.9 m raw samples onto the
    // 4.4 m grid leaves slope kinks that the tyres feel as a periodic road ripple
    const rm1 = rawSamples[(rawIdx - 1 + rawCount) % rawCount] as typeof r0;
    const r2 = rawSamples[(rawIdx + 2) % rawCount] as typeof r0;
    const [cw0, cw1, cw2, cw3] = catmullRomWeights(alpha);
    const cubic = (a: number, b: number, c: number, d: number) => cw0 * a + cw1 * b + cw2 * c + cw3 * d;
    const cx = cubic(rm1.p[0], r0.p[0], r1.p[0], r2.p[0]);
    const cy = cubic(rm1.p[1], r0.p[1], r1.p[1], r2.p[1]);
    const cz = cubic(rm1.p[2], r0.p[2], r1.p[2], r2.p[2]);
    positions.push(new THREE.Vector3(cx, cy, cz));
    // Racing-line offset (m, + right): the one line the AI drives, the HUD draws and the speed profile uses
    racingOffsetsM.push(cubic(rm1.ro, r0.ro, r1.ro, r2.ro));
    // The GT3's own lap-time line (`roGt3`); a track without one gives it the F1 line
    const roGt3 = (r: typeof r0) => (r as { roGt3?: number }).roGt3 ?? r.ro;
    gt3OffsetsM.push(cubic(roGt3(rm1), roGt3(r0), roGt3(r1), roGt3(r2)));
    widths.push(THREE.MathUtils.lerp(r0.w, r1.w, alpha));

    const meshBank = THREE.MathUtils.lerp(r0.b, r1.b, alpha);
    bankings.push(meshBank);

    const nLat = LAT_PROFILE_OFFSETS.length;
    if (
      rm1.yProf?.length === nLat &&
      r0.yProf?.length === nLat &&
      r1.yProf?.length === nLat &&
      r2.yProf?.length === nLat
    ) {
      const yp = new Array<number>(nLat);
      for (let k = 0; k < nLat; k++) {
        yp[k] = cubic(rm1.yProf[k], r0.yProf[k], r1.yProf[k], r2.yProf[k]);
      }
      yProfs.push(yp);
    } else {
      yProfs.push(
        LAT_PROFILE_OFFSETS.map((lat) => cy - Math.sin(meshBank) * lat)
      );
    }

    grips.push(THREE.MathUtils.lerp(r0.g ?? 1.0, r1.g ?? 1.0, alpha));
    const v0 = (r0 as { v?: number }).v ?? 315;
    const v1 = (r1 as { v?: number }).v ?? 315;
    aiSpeedsKmh.push(THREE.MathUtils.lerp(v0, v1, alpha));
    const near = alpha < 0.5 ? r0 : r1;
    edges.push({
      rL: THREE.MathUtils.lerp(r0.rL, r1.rL, alpha),
      rR: THREE.MathUtils.lerp(r0.rR, r1.rR, alpha),
      gL: THREE.MathUtils.lerp(r0.gL, r1.gL, alpha),
      gR: THREE.MathUtils.lerp(r0.gR, r1.gR, alpha),
      wL: THREE.MathUtils.lerp(r0.wL, r1.wL, alpha),
      wR: THREE.MathUtils.lerp(r0.wR, r1.wR, alpha),
      kL: near.kL === 1,
      kR: near.kR === 1,
    });
  }

  // Light [1, 2, 1] smoothing of the surface heights along the lap removes the remaining
  // mesh-triangulation noise (±1–2 mm per sample) while keeping crests and compressions
  {
    const n = NUM_SAMPLES;
    const ys = positions.map((p) => p.y);
    const yp = yProfs.map((row) => row.slice());
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      positions[i].y = 0.25 * ys[a] + 0.5 * ys[i] + 0.25 * ys[b];
      for (let k = 0; k < yp[i].length; k++) {
        yProfs[i][k] = 0.25 * yp[a][k] + 0.5 * yp[i][k] + 0.25 * yp[b][k];
      }
    }
  }

  // Snap the starting grid straight (s = 15..195 m) onto an exact horizontal XZ chord so straight-line
  // acceleration has no sub-centimetre lateral / heading noise — but only where the road really is collinear
  // there. On a layout whose main straight bends, the snap would pull the centreline metres off the road mesh
  // (on its banking that reads as a ~15 cm dip in the surface heights).
  const idxStart = Math.round(15 / ds);
  const idxEnd = Math.round(195 / ds);
  const pStart = positions[idxStart].clone();
  const pEnd = positions[idxEnd].clone();
  const straightDirX = pEnd.x - pStart.x;
  const straightDirZ = pEnd.z - pStart.z;
  const straightLen = Math.hypot(straightDirX, straightDirZ) || 1;
  const ux = straightDirX / straightLen;
  const uz = straightDirZ / straightLen;
  let chordDeviationM = 0;
  for (let i = idxStart; i <= idxEnd; i++) {
    const dx = positions[i].x - pStart.x;
    const dz = positions[i].z - pStart.z;
    chordDeviationM = Math.max(chordDeviationM, Math.abs(dx * uz - dz * ux));
  }
  const snapStraight = chordDeviationM < 0.05;

  for (let i = 0; snapStraight && i < NUM_SAMPLES; i++) {
    const s = i * ds;
    if (s <= 230) {
      // Eased in over the first 15 m too: collinearity is only checked from 15 m, and pulling the line itself (s = 0)
      // onto the chord left a lateral step against the last samples of the lap, which are not snapped
      const blend =
        s < 15 ? THREE.MathUtils.smoothstep(s, 0, 15) : s <= 195 ? 1.0 : 1.0 - THREE.MathUtils.smoothstep(s, 195, 230);
      const dx = positions[i].x - pStart.x;
      const dz = positions[i].z - pStart.z;
      const projDist = dx * ux + dz * uz;
      const lineX = pStart.x + projDist * ux;
      const lineZ = pStart.z + projDist * uz;
      positions[i].x = THREE.MathUtils.lerp(positions[i].x, lineX, blend);
      positions[i].z = THREE.MathUtils.lerp(positions[i].z, lineZ, blend);
    }
  }

  // Racing-line points on the (banked) road surface: centreline + horizontal right · offset
  const racingPositions: THREE.Vector3[] = [];
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const a = positions[(i - 2 + NUM_SAMPLES) % NUM_SAMPLES];
    const b = positions[(i + 2) % NUM_SAMPLES];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    const e = racingOffsetsM[i];
    racingPositions.push(
      new THREE.Vector3(
        positions[i].x + (-tz / tl) * e,
        positions[i].y - Math.tan(bankings[i]) * e,
        positions[i].z + (tx / tl) * e
      )
    );
  }

  const tangents: THREE.Vector3[] = [];
  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  const curvatures: number[] = [];
  const verticalCurvatures: number[] = [];
  const slopeSins: number[] = [];
  const racingOffsetsNorm: number[] = [];
  const gt3OffsetsNorm: number[] = [];

  for (let i = 0; i < NUM_SAMPLES; i++) {
    const prev2 = positions[(i - 2 + NUM_SAMPLES) % NUM_SAMPLES];
    const next2 = positions[(i + 2) % NUM_SAMPLES];
    const curr = positions[i];

    const tangentRaw = next2.clone().sub(prev2);
    const segLen = Math.max(0.01, tangentRaw.length());
    const slopeSin = THREE.MathUtils.clamp(tangentRaw.y / segLen, -0.28, 0.28);
    slopeSins.push(slopeSin);

    const tangent = tangentRaw.clone().normalize();
    // Horizontal right-hand unit vector in XZ plane: (tangent.x, 0, tangent.z) x (0, 1, 0) = (-tangent.z, 0, tangent.x)
    const rightFlat = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    const upFlat = new THREE.Vector3()
      .crossVectors(rightFlat, tangent)
      .normalize();

    const bankRad = bankings[i];
    // Rotate surface normal around forward tangent by +bankRad so positive banking tilts right edge (binormal.y < 0) inward toward right-hand apex
    const normal = upFlat.clone().applyAxisAngle(tangent, bankRad).normalize();
    const binormal = new THREE.Vector3()
      .crossVectors(tangent, normal)
      .normalize();

    tangents.push(tangent);
    normals.push(normal);
    binormals.push(binormal);

    // Measure horizontal curvature blending the optimal racing line and centerline over a ±4 sample (±17.7m) chord
    const rPrev = racingPositions[(i - 4 + NUM_SAMPLES) % NUM_SAMPLES];
    const rCurr = racingPositions[i];
    const rNext = racingPositions[(i + 4) % NUM_SAMPLES];
    const vIn = new THREE.Vector2(
      rCurr.x - rPrev.x,
      rCurr.z - rPrev.z
    ).normalize();
    const vOut = new THREE.Vector2(
      rNext.x - rCurr.x,
      rNext.z - rCurr.z
    ).normalize();
    const cross = vIn.x * vOut.y - vIn.y * vOut.x;
    const dot = THREE.MathUtils.clamp(vIn.dot(vOut), -1, 1);
    const dThetaRace = Math.atan2(cross, dot);
    const chordLenRace = Math.max(
      1.0,
      Math.hypot(rNext.x - rPrev.x, rNext.z - rPrev.z)
    );
    const kRace = dThetaRace / (0.5 * chordLenRace);

    const cPrev = positions[(i - 4 + NUM_SAMPLES) % NUM_SAMPLES];
    const cNext = positions[(i + 4) % NUM_SAMPLES];
    const cIn = new THREE.Vector2(curr.x - cPrev.x, curr.z - cPrev.z).normalize();
    const cOut = new THREE.Vector2(cNext.x - curr.x, cNext.z - curr.z).normalize();
    const cCross = cIn.x * cOut.y - cIn.y * cOut.x;
    const cDot = THREE.MathUtils.clamp(cIn.dot(cOut), -1, 1);
    const dThetaCenter = Math.atan2(cCross, cDot);
    const chordLenCenter = Math.max(
      1.0,
      Math.hypot(cNext.x - cPrev.x, cNext.z - cPrev.z)
    );
    const kCenter = dThetaCenter / (0.5 * chordLenCenter);

    const kBlend =
      Math.abs(kCenter) > Math.abs(kRace)
        ? 0.55 * kCenter + 0.45 * kRace
        : 0.35 * kCenter + 0.65 * kRace;
    curvatures.push(kBlend);

    const prevSlope =
      (curr.y - prev2.y) / Math.max(0.5, prev2.distanceTo(curr));
    const nextSlope =
      (next2.y - curr.y) / Math.max(0.5, curr.distanceTo(next2));
    // The two slopes are centred on samples i−1 and i+1, 2·ds apart
    verticalCurvatures.push((nextSlope - prevSlope) / (2 * ds));

    // Normalised so that aiLineOffsetM(sample) returns the exported offset in metres
    racingOffsetsNorm.push(racingOffsetsM[i] / (widths[i] * AI_LINE_WIDTH_SCALE));
    gt3OffsetsNorm.push(gt3OffsetsM[i] / (widths[i] * AI_LINE_WIDTH_SCALE));
  }

  const samples: TrackSamplePoint[] = [];
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const s = i * ds;
    const t = i / NUM_SAMPLES;
    const turnInfo = getTurnInfoAtS(s, totalLength);

    samples.push({
      index: i,
      s,
      t,
      position: positions[i],
      racingLinePos: racingPositions[i],
      yProf: yProfs[i],
      tangent: tangents[i],
      normal: normals[i],
      binormal: binormals[i],
      bankingRad: bankings[i],
      width: widths[i],
      curvature: curvatures[i],
      verticalCurvature: verticalCurvatures[i],
      slopeSin: slopeSins[i],
      sector: turnInfo.sector,
      turnNumber: turnInfo.turnNumber,
      turnName: turnInfo.turnName,
      runoffStyle: turnInfo.runoffStyle,
      kerbLeft: edges[i].kL,
      kerbRight: edges[i].kR,
      runoffLeftM: edges[i].rL,
      runoffRightM: edges[i].rR,
      gravelLeftM: edges[i].gL,
      gravelRightM: edges[i].gR,
      wallLeftM: edges[i].wL,
      wallRightM: edges[i].wR,
      drsZone: isInDrsZone(t),
      racingLineOffset: racingOffsetsNorm[i],
      racingLineOffsetGt3: gt3OffsetsNorm[i],
      optimalSpeedKmh: 0,
      brakingZone: 0,
      gripMultiplier: grips[i],
    });
  }

  // Target speeds along the AI line from the LC26 vehicle model (balanced aero package)
  const nominalProfile = computeSpeedProfile(samples, createLc26ProfileCarModel('balanced'));
  for (let i = 0; i < NUM_SAMPLES; i++) {
    samples[i].optimalSpeedKmh = nominalProfile.speedMs[i] * 3.6;
    samples[i].brakeLimitKmh = nominalProfile.brakeEnvelopeMs[i] * 3.6;
    samples[i].brakingZone = brakingZoneLevel(nominalProfile.speedMs, i);
  }

  // Horizontal centreline between samples: a periodic C2 cubic spline through the sample positions
  // (uniform parameter u = s / ds). Lateral offsets measured from straight chords kink at every
  // sample (≈5 cm sag at R = 50 m); a C1 Hermite with independently estimated tangents still made
  // ds/dt jump by up to 18 % at some samples. Either turns the road slope under a wheel into a
  // step every 4.4 m, i.e. a periodic vertical-velocity kick. The C2 spline keeps the parametric
  // speed and curvature continuous across samples.
  const splineDX = new Float64Array(NUM_SAMPLES);
  const splineDZ = new Float64Array(NUM_SAMPLES);
  {
    // D[i−1] + 4·D[i] + D[i+1] = 3·(P[i+1] − P[i−1]); diagonally dominant, so Gauss-Seidel converges fast
    const rhsX = new Float64Array(NUM_SAMPLES);
    const rhsZ = new Float64Array(NUM_SAMPLES);
    for (let i = 0; i < NUM_SAMPLES; i++) {
      const pn = positions[(i + 1) % NUM_SAMPLES];
      const pp = positions[(i - 1 + NUM_SAMPLES) % NUM_SAMPLES];
      rhsX[i] = 3 * (pn.x - pp.x);
      rhsZ[i] = 3 * (pn.z - pp.z);
      splineDX[i] = rhsX[i] / 6;
      splineDZ[i] = rhsZ[i] / 6;
    }
    for (let iter = 0; iter < 60; iter++) {
      for (let i = 0; i < NUM_SAMPLES; i++) {
        const ip = (i - 1 + NUM_SAMPLES) % NUM_SAMPLES;
        const inx = (i + 1) % NUM_SAMPLES;
        splineDX[i] = (rhsX[i] - splineDX[ip] - splineDX[inx]) / 4;
        splineDZ[i] = (rhsZ[i] - splineDZ[ip] - splineDZ[inx]) / 4;
      }
    }
  }
  const samplePosX = new Float64Array(NUM_SAMPLES);
  const samplePosZ = new Float64Array(NUM_SAMPLES);
  const hTanX = new Float64Array(NUM_SAMPLES);
  const hTanZ = new Float64Array(NUM_SAMPLES);
  for (let i = 0; i < NUM_SAMPLES; i++) {
    samplePosX[i] = samples[i].position.x;
    samplePosZ[i] = samples[i].position.z;
    const len = Math.hypot(splineDX[i], splineDZ[i]) || 1;
    hTanX[i] = splineDX[i] / len;
    hTanZ[i] = splineDZ[i] / len;
  }

  // Reusable scratch buffers for zero-alloc spline evaluation & segment projection
  const _herm = { x: 0, z: 0, dx: 0, dz: 0, ddx: 0, ddz: 0 };
  const _segTmp = { i0: 0, i1: 0, t: 0, lateralH: 0 };
  const _segChosen = { i0: 0, i1: 0, t: 0, lateralH: 0 };
  const _segFallback = { i0: 0, i1: 0, t: 0, lateralH: 0 };
  const _locScratch = { i0: 0, i1: 0, t: 0, s: 0, lateralH: 0 };
  const SEG_OFFSETS = [-1, 0, -2, 1] as const;

  /** Spline centreline point (x, z), first and second derivative w.r.t. t on segment i0 → i0+1 into `_herm` */
  const hermiteXZInto = (i0: number, t: number): void => {
    const i1 = i0 + 1 < NUM_SAMPLES ? i0 + 1 : 0;
    const p0x = samplePosX[i0];
    const p0z = samplePosZ[i0];
    const p1x = samplePosX[i1];
    const p1z = samplePosZ[i1];
    const m0x = splineDX[i0];
    const m0z = splineDZ[i0];
    const m1x = splineDX[i1];
    const m1z = splineDZ[i1];
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const d00 = 6 * t2 - 6 * t;
    const d10 = 3 * t2 - 4 * t + 1;
    const d01 = -6 * t2 + 6 * t;
    const d11 = 3 * t2 - 2 * t;
    const e00 = 12 * t - 6;
    const e10 = 6 * t - 4;
    const e01 = -12 * t + 6;
    const e11 = 6 * t - 2;
    _herm.x = h00 * p0x + h10 * m0x + h01 * p1x + h11 * m1x;
    _herm.z = h00 * p0z + h10 * m0z + h01 * p1z + h11 * m1z;
    _herm.dx = d00 * p0x + d10 * m0x + d01 * p1x + d11 * m1x;
    _herm.dz = d00 * p0z + d10 * m0z + d01 * p1z + d11 * m1z;
    _herm.ddx = e00 * p0x + e10 * m0x + e01 * p1x + e11 * m1x;
    _herm.ddz = e00 * p0z + e10 * m0z + e01 * p1z + e11 * m1z;
  };

  const sampleCurvatureAtDistance = (s: number): number => {
    const n = samples.length;
    const wrappedS = Number.isFinite(s) ? ((s % totalLength) + totalLength) % totalLength : 0;
    const exactIdx = (wrappedS / totalLength) * n;
    const fIdx = Math.floor(exactIdx);
    const idx0 = fIdx % n;
    const idx1 = idx0 + 1 < n ? idx0 + 1 : 0;
    const alpha = exactIdx - fIdx;
    const c0 = samples[idx0].curvature;
    return c0 + (samples[idx1].curvature - c0) * alpha;
  };

  const getSampleAtDistanceInto = (s: number, out: TrackSamplePoint): TrackSamplePoint => {
    const n = samples.length;
    const wrappedS = Number.isFinite(s) ? ((s % totalLength) + totalLength) % totalLength : 0;
    const exactIdx = (wrappedS / totalLength) * n;
    const fIdx = Math.floor(exactIdx);
    const idx0 = fIdx % n;
    const idx1 = idx0 + 1 < n ? idx0 + 1 : 0;
    const alpha = exactIdx - fIdx;

    const s0 = samples[idx0];
    const s1 = samples[idx1];
    const sPrev = samples[idx0 > 0 ? idx0 - 1 : n - 1];
    const sNext = samples[idx1 + 1 < n ? idx1 + 1 : 0];

    const a2 = alpha * alpha;
    const a3 = a2 * alpha;
    const w0 = 0.5 * (-a3 + 2 * a2 - alpha);
    const w1 = 0.5 * (3 * a3 - 5 * a2 + 2);
    const w2 = 0.5 * (-3 * a3 + 4 * a2 + alpha);
    const w3 = 0.5 * (a3 - a2);

    if (s0.yProf && s1.yProf && sPrev.yProf && sNext.yProf) {
      const len = s0.yProf.length;
      let yp = out.yProf;
      if (!yp || yp.length !== len) {
        yp = new Array<number>(len);
        out.yProf = yp;
      }
      for (let k = 0; k < len; k++) {
        yp[k] = w0 * sPrev.yProf[k] + w1 * s0.yProf[k] + w2 * s1.yProf[k] + w3 * sNext.yProf[k];
      }
    } else {
      out.yProf = undefined;
    }

    hermiteXZInto(idx0, alpha);
    const posY = w0 * sPrev.position.y + w1 * s0.position.y + w2 * s1.position.y + w3 * sNext.position.y;
    out.position.set(_herm.x, posY, _herm.z);

    if (s0.racingLinePos && s1.racingLinePos) {
      (out.racingLinePos ??= new THREE.Vector3()).lerpVectors(s0.racingLinePos, s1.racingLinePos, alpha);
    } else {
      out.racingLinePos = undefined;
    }

    out.tangent.lerpVectors(s0.tangent, s1.tangent, alpha).normalize();
    out.normal.lerpVectors(s0.normal, s1.normal, alpha).normalize();
    out.binormal.lerpVectors(s0.binormal, s1.binormal, alpha).normalize();

    out.index = s0.index;
    out.s = wrappedS;
    out.t = wrappedS / totalLength;
    out.bankingRad = s0.bankingRad + (s1.bankingRad - s0.bankingRad) * alpha;
    out.width = s0.width + (s1.width - s0.width) * alpha;
    out.curvature = s0.curvature + (s1.curvature - s0.curvature) * alpha;
    out.verticalCurvature = s0.verticalCurvature + (s1.verticalCurvature - s0.verticalCurvature) * alpha;
    out.slopeSin = s0.slopeSin + (s1.slopeSin - s0.slopeSin) * alpha;
    out.sector = s0.sector;
    out.turnNumber = s0.turnNumber;
    out.turnName = s0.turnName;
    out.runoffStyle = s0.runoffStyle;
    out.kerbLeft = s0.kerbLeft;
    out.kerbRight = s0.kerbRight;
    out.drsZone = s0.drsZone;
    out.racingLineOffset = s0.racingLineOffset + (s1.racingLineOffset - s0.racingLineOffset) * alpha;
    const gt30 = s0.racingLineOffsetGt3 ?? s0.racingLineOffset;
    const gt31 = s1.racingLineOffsetGt3 ?? s1.racingLineOffset;
    out.racingLineOffsetGt3 = gt30 + (gt31 - gt30) * alpha;
    out.optimalSpeedKmh = s0.optimalSpeedKmh + (s1.optimalSpeedKmh - s0.optimalSpeedKmh) * alpha;
    const bl0 = s0.brakeLimitKmh ?? s0.optimalSpeedKmh;
    const bl1 = s1.brakeLimitKmh ?? s1.optimalSpeedKmh;
    out.brakeLimitKmh = bl0 + (bl1 - bl0) * alpha;
    out.brakingZone = s0.brakingZone;
    const g0 = s0.gripMultiplier ?? 1.0;
    const g1 = s1.gripMultiplier ?? 1.0;
    out.gripMultiplier = g0 + (g1 - g0) * alpha;
    out.runoffLeftM = s0.runoffLeftM;
    out.runoffRightM = s0.runoffRightM;
    out.gravelLeftM = s0.gravelLeftM;
    out.gravelRightM = s0.gravelRightM;
    out.wallLeftM = s0.wallLeftM;
    out.wallRightM = s0.wallRightM;
    return out;
  };

  const getSampleAtDistance = (s: number): TrackSamplePoint => {
    const n = samples.length;
    // A non-finite s (a car state that already went NaN) would index samples[NaN] and throw
    const wrappedS = Number.isFinite(s) ? ((s % totalLength) + totalLength) % totalLength : 0;
    const exactIdx = (wrappedS / totalLength) * n;
    const fIdx = Math.floor(exactIdx);
    const idx0 = fIdx % n;
    const idx1 = idx0 + 1 < n ? idx0 + 1 : 0;
    const alpha = exactIdx - fIdx;

    const s0 = samples[idx0];
    const s1 = samples[idx1];
    const sPrev = samples[idx0 > 0 ? idx0 - 1 : n - 1];
    const sNext = samples[idx1 + 1 < n ? idx1 + 1 : 0];

    const a2 = alpha * alpha;
    const a3 = a2 * alpha;
    const w0 = 0.5 * (-a3 + 2 * a2 - alpha);
    const w1 = 0.5 * (3 * a3 - 5 * a2 + 2);
    const w2 = 0.5 * (-3 * a3 + 4 * a2 + alpha);
    const w3 = 0.5 * (a3 - a2);

    let interpYProf: number[] | undefined;
    if (s0.yProf && s1.yProf && sPrev.yProf && sNext.yProf) {
      const len = s0.yProf.length;
      interpYProf = new Array<number>(len);
      for (let k = 0; k < len; k++) {
        interpYProf[k] =
          w0 * sPrev.yProf[k] + w1 * s0.yProf[k] + w2 * s1.yProf[k] + w3 * sNext.yProf[k];
      }
    }

    hermiteXZInto(idx0, alpha);
    const posY = w0 * sPrev.position.y + w1 * s0.position.y + w2 * s1.position.y + w3 * sNext.position.y;
    const gt30 = s0.racingLineOffsetGt3 ?? s0.racingLineOffset;
    const gt31 = s1.racingLineOffsetGt3 ?? s1.racingLineOffset;
    const bl0 = s0.brakeLimitKmh ?? s0.optimalSpeedKmh;
    const bl1 = s1.brakeLimitKmh ?? s1.optimalSpeedKmh;
    const g0 = s0.gripMultiplier ?? 1.0;
    const g1 = s1.gripMultiplier ?? 1.0;

    return {
      ...s0,
      s: wrappedS,
      t: wrappedS / totalLength,
      position: new THREE.Vector3(_herm.x, posY, _herm.z),
      racingLinePos:
        s0.racingLinePos && s1.racingLinePos
          ? new THREE.Vector3().lerpVectors(s0.racingLinePos, s1.racingLinePos, alpha)
          : undefined,
      yProf: interpYProf,
      tangent: new THREE.Vector3().lerpVectors(s0.tangent, s1.tangent, alpha).normalize(),
      normal: new THREE.Vector3().lerpVectors(s0.normal, s1.normal, alpha).normalize(),
      binormal: new THREE.Vector3().lerpVectors(s0.binormal, s1.binormal, alpha).normalize(),
      bankingRad: s0.bankingRad + (s1.bankingRad - s0.bankingRad) * alpha,
      width: s0.width + (s1.width - s0.width) * alpha,
      curvature: s0.curvature + (s1.curvature - s0.curvature) * alpha,
      verticalCurvature: s0.verticalCurvature + (s1.verticalCurvature - s0.verticalCurvature) * alpha,
      slopeSin: s0.slopeSin + (s1.slopeSin - s0.slopeSin) * alpha,
      racingLineOffset: s0.racingLineOffset + (s1.racingLineOffset - s0.racingLineOffset) * alpha,
      racingLineOffsetGt3: gt30 + (gt31 - gt30) * alpha,
      optimalSpeedKmh: s0.optimalSpeedKmh + (s1.optimalSpeedKmh - s0.optimalSpeedKmh) * alpha,
      brakeLimitKmh: bl0 + (bl1 - bl0) * alpha,
      gripMultiplier: g0 + (g1 - g0) * alpha,
    };
  };

  // Horizontal unit tangents per sample, used by the continuous inverse mapping below
  /**
   * Solves for the parameter t on segment i0 → i0+1 at which the world point lies on the
   * normal of the spline centreline, i.e. (P − C(t)) · C'(t) = 0. Writes t and the signed
   * horizontal lateral offset (+ right) into `out`.
   */
  const solveSegmentInto = (
    worldX: number,
    worldZ: number,
    i0: number,
    out: { i0: number; i1: number; t: number; lateralH: number }
  ): void => {
    const i1 = i0 + 1 < NUM_SAMPLES ? i0 + 1 : 0;
    const a0x = samplePosX[i0];
    const a0z = samplePosZ[i0];
    const dx = samplePosX[i1] - a0x;
    const dz = samplePosZ[i1] - a0z;
    const rx = worldX - a0x;
    const rz = worldZ - a0z;
    const t0x = hTanX[i0];
    const t0z = hTanZ[i0];
    const ex = hTanX[i1] - t0x;
    const ez = hTanZ[i1] - t0z;
    // Initial guess from the chord with linearly interpolated normals: c + b·t + a·t² = 0
    const c = rx * t0x + rz * t0z;
    const b = rx * ex + rz * ez - (dx * t0x + dz * t0z);
    const a = -(dx * ex + dz * ez);
    let t = Math.abs(b) > 1e-9 ? -c / b : 0;
    for (let k = 0; k < 3; k++) {
      const df = b + 2 * a * t;
      if (Math.abs(df) < 1e-9) break;
      t -= (c + b * t + a * t * t) / df;
    }
    // Newton on f(t) = (P − C(t)) · C'(t) along the spline
    hermiteXZInto(i0, t);
    for (let k = 0; k < 4; k++) {
      const px = worldX - _herm.x;
      const pz = worldZ - _herm.z;
      const f = px * _herm.dx + pz * _herm.dz;
      const df = -(_herm.dx * _herm.dx + _herm.dz * _herm.dz) + px * _herm.ddx + pz * _herm.ddz;
      if (Math.abs(df) < 1e-9) break;
      let step = f / df;
      if (step < -0.5) step = -0.5;
      else if (step > 0.5) step = 0.5;
      t -= step;
      hermiteXZInto(i0, t);
      if (Math.abs(step) < 1e-7) break;
    }
    const tLen = Math.hypot(_herm.dx, _herm.dz) || 1;
    // Horizontal right = (−tz, tx)
    const lateralH = ((worldX - _herm.x) * -_herm.dz + (worldZ - _herm.z) * _herm.dx) / tLen;
    out.i0 = i0;
    out.i1 = i1;
    out.t = t;
    out.lateralH = lateralH;
  };

  /**
   * Locates a world XZ point on the track into `out` without allocating. Segment boundaries are
   * the lines through each sample along its own normal, so (s, lateral) varies continuously.
   */
  const locateWorldPointInto = (
    worldX: number,
    worldZ: number,
    out: { i0: number; i1: number; t: number; s: number; lateralH: number },
    hintS?: number
  ): void => {
    const n = NUM_SAMPLES;
    let bestIdx = 0;
    let bestDistSq = Infinity;

    if (hintS !== undefined && Number.isFinite(hintS)) {
      const wrappedHint = ((hintS % totalLength) + totalLength) % totalLength;
      const centerIdx = Math.floor((wrappedHint / totalLength) * n) % n;
      const searchRadius = 40;
      for (let offset = -searchRadius; offset <= searchRadius; offset++) {
        let idx = centerIdx + offset;
        if (idx < 0) idx += n;
        else if (idx >= n) idx -= n;
        const dx = worldX - samplePosX[idx];
        const dz = worldZ - samplePosZ[idx];
        const dSq = dx * dx + dz * dz;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestIdx = idx;
        }
      }
    }

    if (bestDistSq > 1225) {
      bestDistSq = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = worldX - samplePosX[i];
        const dz = worldZ - samplePosZ[i];
        const dSq = dx * dx + dz * dz;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestIdx = i;
        }
      }
    }

    // The containing segment touches the nearest sample except far off-line in tight bends
    let hasChosen = false;
    let hasFallback = false;
    let fallbackOut = Infinity;
    for (let k = 0; k < 4; k++) {
      const off = SEG_OFFSETS[k];
      let segIdx = bestIdx + off;
      if (segIdx < 0) segIdx += n;
      else if (segIdx >= n) segIdx -= n;
      solveSegmentInto(worldX, worldZ, segIdx, _segTmp);
      if (_segTmp.t >= 0 && _segTmp.t <= 1) {
        if (!hasChosen || Math.abs(_segTmp.lateralH) < Math.abs(_segChosen.lateralH)) {
          _segChosen.i0 = _segTmp.i0;
          _segChosen.i1 = _segTmp.i1;
          _segChosen.t = _segTmp.t;
          _segChosen.lateralH = _segTmp.lateralH;
          hasChosen = true;
        }
      } else {
        const outDist = _segTmp.t < 0 ? -_segTmp.t : _segTmp.t - 1;
        if (outDist < fallbackOut) {
          fallbackOut = outDist;
          _segFallback.i0 = _segTmp.i0;
          _segFallback.i1 = _segTmp.i1;
          _segFallback.t = _segTmp.t;
          _segFallback.lateralH = _segTmp.lateralH;
          hasFallback = true;
        }
      }
      if (hasChosen && off === 0) break;
    }
    if (!hasChosen) {
      solveSegmentInto(worldX, worldZ, hasFallback ? _segFallback.i0 : bestIdx, _segChosen);
      const tVal = _segChosen.t;
      _segChosen.t = Number.isFinite(tVal) ? (tVal < 0 ? 0 : tVal > 1 ? 1 : tVal) : 0;
    }
    const s = (((( _segChosen.i0 + _segChosen.t) * ds) % totalLength) + totalLength) % totalLength;
    out.i0 = _segChosen.i0;
    out.i1 = _segChosen.i1;
    out.t = _segChosen.t;
    out.lateralH = _segChosen.lateralH;
    out.s = s;
  };

  const locateWorldPointFn = (worldX: number, worldZ: number, hintS?: number) => {
    locateWorldPointInto(worldX, worldZ, _locScratch, hintS);
    return {
      i0: _locScratch.i0,
      i1: _locScratch.i1,
      t: _locScratch.t,
      lateralH: _locScratch.lateralH,
      s: _locScratch.s,
    };
  };

  const projectWorldToTrackInto = (
    worldX: number,
    worldZ: number,
    out: TrackProjectionResult,
    hintS?: number
  ): TrackProjectionResult => {
    locateWorldPointInto(worldX, worldZ, _locScratch, hintS);
    const sample = getSampleAtDistanceInto(_locScratch.s, out.sample);
    const bHorizLen = Math.hypot(sample.binormal.x, sample.binormal.z) || 1;
    const cosBank = bHorizLen > 0.85 ? bHorizLen : 0.85;
    out.s = _locScratch.s;
    out.lateralOffset = _locScratch.lateralH / cosBank;
    out.distSq = _locScratch.lateralH * _locScratch.lateralH;
    return out;
  };

  const projectWorldToTrackFn = (
    worldX: number,
    worldZ: number,
    hintS?: number
  ) => {
    locateWorldPointInto(worldX, worldZ, _locScratch, hintS);
    const sample = getSampleAtDistance(_locScratch.s);
    const bHorizLen = Math.hypot(sample.binormal.x, sample.binormal.z) || 1;
    // Account for binormal 3D tilt (cos(bankingRad)) so position + binormal * lateralOffset matches XZ
    const cosBank = bHorizLen > 0.85 ? bHorizLen : 0.85;
    return {
      sample,
      s: _locScratch.s,
      lateralOffset: _locScratch.lateralH / cosBank,
      distSq: _locScratch.lateralH * _locScratch.lateralH,
    };
  };

  const meshMeta = getActiveTrackMetadata().mesh;
  const meshUrl = meshMeta?.url;
  if (!meshUrl) console.warn(`Circuit "${ACTIVE_TRACK_ID}" has no mesh url: drawing the procedural stand-in`);
  const noShadowMeshes = meshMeta?.noShadowMeshes?.length ? [...meshMeta.noShadowMeshes] : undefined;
  const mergedNoShadowMaterials = trackNoShadowMaterials(ACTIVE_TRACK_ID, meshMeta?.noShadowMaterials);
  const noShadowMaterials = mergedNoShadowMaterials.length ? mergedNoShadowMaterials : undefined;
  cachedBuiltTrack = {
    id: ACTIVE_TRACK_ID,
    pointToPoint: getActiveTrackMetadata().pointToPoint,
    meshUrl,
    roadMaterials: meshMeta?.roadMaterials,
    sceneryCuts: meshMeta?.cutBoxes,
    sceneryCutMaterials: meshMeta?.cutMaterials,
    sceneryUrls: meshMeta?.scenery,
    noShadowMeshes,
    noShadowMaterials,
    otherLayoutRoads: getActiveTrackMetadata().otherLayoutRoads,
    nightLighting: getActiveTrackMetadata().nightLighting,
    spawnGrid: [...RWANDA_SPAWN_GRID],
    samples,
    totalLengthM: totalLength,
    spline,
    getSampleAtDistance,
    getSampleAtDistanceInto,
    sampleCurvatureAtDistance,
    projectWorldToTrack: projectWorldToTrackFn,
    projectWorldToTrackInto,
    locateWorldPoint: locateWorldPointFn,
  };

  return cachedBuiltTrack;
}

export function getTrackData(): BuiltTrackData {
  return getActiveTrackData(1200);
}

export function sampleTrackAtDistance(s: number): TrackSamplePoint {
  return getActiveTrackData(1200).getSampleAtDistance(s);
}

export function projectWorldToTrack(
  worldX: number,
  worldZ: number,
  hintS?: number
) {
  return getActiveTrackData(1200).projectWorldToTrack(worldX, worldZ, hintS);
}

export function findClosestTrackSample(
  worldPos: THREE.Vector3,
  hintS?: number
): { sample: TrackSamplePoint; lateralOffset: number } {
  const proj = projectWorldToTrack(worldPos.x, worldPos.z, hintS);
  return {
    sample: proj.sample,
    lateralOffset: proj.lateralOffset,
  };
}

export function getTracksideTvCameras(): TracksideTvCameraDef[] {
  return RWANDA_TV_CAMERAS;
}

export function getActiveTvCamera(progress01: number): TracksideTvCameraDef {
  const p = ((progress01 % 1) + 1) % 1;
  for (const cam of RWANDA_TV_CAMERAS) {
    if (p >= cam.inPoint && p <= cam.outPoint) {
      return cam;
    }
  }
  return RWANDA_TV_CAMERAS[0];
}
