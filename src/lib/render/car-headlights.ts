import * as THREE from "three";
import { anyCarById, type CarClassId, type CarId } from "@/lib/cars/car-registry";
import type { GraphicsQuality } from "@/lib/settings/player-settings";
import { SKY_COVER_SPECS, type SessionConditions } from "@/lib/sim/weather";

export type HeadlightMode = "auto" | "on" | "off";
export type HeadlightSpotCount = 0 | 1 | 2;

/** A car's headlight beam in world space, for a lighting pass with no SpotLight for it (opponent-beams.ts) */
export interface HeadlightBeam {
  /** Where the beam starts (between the lamps) and its unit direction */
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  /** Intensity as a SpotLight's with decay 1 (cd-scaled), and its reach (m) */
  intensity: number;
  range: number;
}

export interface CarHeadlightsOptions {
  /**
   * Number of SpotLights to allocate for forward road beams:
   * - `0`: flares + emissive lenses only (Low quality, daytime-only sessions, or `lightsOnly` opponent rigs)
   * - `1`: single merged centre SpotLight (Medium quality)
   * - `2`: twin left/right SpotLights (High quality; default when not `lightsOnly`)
   */
  spotCount?: HeadlightSpotCount;
  /** Shorthand for `spotCount: 0` (opponent rigs: front/rear flares + cloned emissive lenses, zero SpotLights) */
  lightsOnly?: boolean;
}

/** High beam (a flash) against the low beam: SpotLight intensity and reach, front flare size */
export const HIGH_BEAM_GAIN = 2.2;
export const HIGH_BEAM_REACH = 1.6;
export const HIGH_BEAM_FLARE = 2.4;
/**
 * Brightness of the front flare on high beam against the low beam's (an HDR colour): a flash has to read in full
 * daylight, where a plain white additive sprite vanishes against a sunlit car, and it blooms where there is bloom
 */
export const HIGH_BEAM_FLARE_GAIN = 7;
/** Running tail light and brake light glow of a lamp material (its own emissive map / a plain red one) */
const TAIL_GLOW = { own: 1.1, plain: 0.85 } as const;
const BRAKE_GLOW = { own: 4.2, plain: 3.6 } as const;
/** Lens glow of the headlight materials: low beam, high beam */
const LENS_GLOW_LOW = 4.5;
const LENS_GLOW_HIGH = 10;

/** Sun elevation below which automatic headlights switch on (deg; covers dusk, night, early dawn) */
export const AUTO_HEADLIGHT_SUN_DEG = 4;
/** Rain intensity above which automatic headlights switch on (0..1) */
export const AUTO_HEADLIGHT_RAIN = 0.35;

export interface LampPlacement {
  /** Lateral offset from the car centreline (+X = left, m) */
  x: number;
  /** Height above the chassis floor (m) */
  y: number;
  /** Longitudinal position (+Z = forward, -Z = rear, m) */
  z: number;
  /** Visual lens flare diameter override (m) */
  size?: number;
}

export interface HeadlightProfile {
  /**
   * False for a car with no headlights (an F1 car: only its rear rain light). It then has no beams, no front flares
   * and no flash, and lights nothing ahead; its rear light still runs at night and in rain
   */
  frontLamps?: boolean;
  /** Lateral half-spacing of the left and right beams from the car centreline (m) */
  halfWidthM: number;
  /** Lamp height above the chassis floor (m) */
  heightM: number;
  /** Longitudinal lamp position (+Z = forward, m) */
  frontZM: number;
  /** Rear tail-light longitudinal position (-Z = rear, m) */
  rearZM: number;
  /** Rear tail-light lateral half-spacing (0 = single centre rain/tail lamp) */
  rearHalfWidthM: number;
  /** Rear tail-light height (m) */
  rearHeightM: number;
  /** Beam and lens colour (hex) */
  color: number;
  /** SpotLight peak intensity per lamp (cd-scaled for AgX with decay = 1.4) */
  intensity: number;
  /** Maximum illumination distance (m) */
  distanceM: number;
  /** Cone half-angle (rad) */
  angleRad: number;
  /** Soft edge fraction (0..1) */
  penumbra: number;
  /** Outward toe of each lamp's aim point at 48 m ahead (m) */
  aimSpreadM: number;
  /** Visual front lens flare diameter (m) */
  flareSizeM: number;
  /** Visual rear tail-light flare diameter when running (m; scaled up under braking) */
  rearFlareSizeM?: number;
  /** Optional explicit rear lamp placements (e.g. quad Skyline tails, twin proto pods, LMDh endplates) */
  rearLamps?: readonly LampPlacement[];
  /** True when lamp coordinates are measured from the car's GLB (skip coarse bounding-box Z clamping) */
  measured?: boolean;
}

/** Helper to build symmetric left/right rear lamp pairs */
const rearPairs = (pairs: readonly (readonly [number, number, number, number?])[]): LampPlacement[] =>
  pairs.flatMap(([x, y, z, size]) =>
    x > 0.01
      ? [
          { x, y, z, size },
          { x: -x, y, z, size },
        ]
      : [{ x: 0, y, z, size }],
  );

const CLASS_PROFILES: Readonly<Record<CarClassId, HeadlightProfile>> = {
  // F1 cars carry no headlights, only the rear rain light (the front values only place nothing)
  f1: {
    frontLamps: false,
    halfWidthM: 0.16,
    heightM: 0.6,
    frontZM: 2.25,
    rearZM: -2.31,
    rearHalfWidthM: 0,
    rearHeightM: 0.31,
    color: 0xf4f8ff,
    intensity: 175,
    distanceM: 175,
    angleRad: 0.54,
    penumbra: 0.62,
    aimSpreadM: 2.8,
    flareSizeM: 0.20,
    rearFlareSizeM: 0.18,
  },
  gt3: {
    halfWidthM: 0.72,
    heightM: 0.52,
    frontZM: 2.08,
    rearZM: -2.18,
    rearHalfWidthM: 0.60,
    rearHeightM: 0.72,
    color: 0xf8fbff,
    intensity: 215,
    distanceM: 200,
    angleRad: 0.56,
    penumbra: 0.58,
    aimSpreadM: 3.2,
    flareSizeM: 0.32,
    rearFlareSizeM: 0.22,
  },
  proto: {
    halfWidthM: 0.64,
    heightM: 0.42,
    frontZM: 2.25,
    rearZM: -2.10,
    rearHalfWidthM: 0.64,
    rearHeightM: 0.62,
    color: 0xf4f9ff,
    intensity: 240,
    distanceM: 210,
    angleRad: 0.58,
    penumbra: 0.56,
    aimSpreadM: 3.4,
    flareSizeM: 0.32,
    rearFlareSizeM: 0.20,
  },
  classic: {
    halfWidthM: 0.58,
    heightM: 0.54,
    frontZM: 1.98,
    rearZM: -1.96,
    rearHalfWidthM: 0.54,
    rearHeightM: 0.58,
    color: 0xffe4b0,
    intensity: 180,
    distanceM: 165,
    angleRad: 0.56,
    penumbra: 0.62,
    aimSpreadM: 2.8,
    flareSizeM: 0.28,
    rearFlareSizeM: 0.20,
  },
  road: {
    halfWidthM: 0.54,
    heightM: 0.62,
    frontZM: 1.70,
    rearZM: -2.28,
    rearHalfWidthM: 0.60,
    rearHeightM: 0.74,
    color: 0xfff0d4,
    intensity: 160,
    distanceM: 155,
    angleRad: 0.58,
    penumbra: 0.64,
    aimSpreadM: 2.6,
    flareSizeM: 0.28,
    rearFlareSizeM: 0.22,
  },
};

/**
 * Per-car lamp coordinates measured in chassisGroup space (with each car's bodyOffset applied) directly from the
 * GLBs' headlight/taillight meshes so flares sit on the actual lenses rather than behind rear wings or ahead of noses.
 */
const CAR_PROFILE_OVERRIDES: Partial<Record<CarId, Partial<HeadlightProfile>>> = {
  // No front lamps (an F1 car, see the class); the front values sit on the nose top of the Qvist body all the same
  lc26: {
    halfWidthM: 0.16,
    heightM: 0.6,
    frontZM: 2.25,
    rearHalfWidthM: 0,
    rearHeightM: 0.31,
    rearZM: -2.31,
    flareSizeM: 0.20,
    rearFlareSizeM: 0.18,
    measured: true,
  },
  "amg-gt3": {
    halfWidthM: 0.74,
    heightM: 0.50,
    frontZM: 1.98,
    rearHalfWidthM: 0.58,
    rearHeightM: 0.695,
    rearZM: -2.18,
    flareSizeM: 0.30,
    rearFlareSizeM: 0.19,
    rearLamps: rearPairs([
      [0.52, 0.695, -2.20, 0.19],
      [0.66, 0.695, -2.14, 0.18],
    ]),
    measured: true,
  },
  "bmw-m4-gt3": {
    halfWidthM: 0.70,
    heightM: 0.50,
    frontZM: 2.18,
    rearHalfWidthM: 0.59,
    rearHeightM: 0.77,
    rearZM: -2.35,
    flareSizeM: 0.30,
    rearFlareSizeM: 0.19,
    rearLamps: rearPairs([
      [0.48, 0.77, -2.36, 0.18],
      [0.66, 0.76, -2.32, 0.19],
    ]),
    measured: true,
  },
  "mtr-496r": {
    halfWidthM: 0.58,
    heightM: 0.52,
    frontZM: 2.12,
    rearHalfWidthM: 0.56,
    rearHeightM: 0.65,
    rearZM: -2.04,
    flareSizeM: 0.30,
    rearFlareSizeM: 0.18,
    rearLamps: rearPairs([
      [0.561, 0.65, -2.04, 0.18],
      [0.73, 0.65, -1.94, 0.18],
    ]),
    measured: true,
  },
  "lc-lmdh": {
    halfWidthM: 0.65,
    heightM: 0.365,
    frontZM: 2.61,
    rearHalfWidthM: 0.958,
    rearHeightM: 0.95,
    rearZM: -2.37,
    flareSizeM: 0.30,
    rearFlareSizeM: 0.16,
    rearLamps: rearPairs([
      [0.958, 0.95, -2.37, 0.15],
      [0.78, 0.40, -2.27, 0.17],
    ]),
    measured: true,
  },
  liana: {
    halfWidthM: 0.56,
    heightM: 0.66,
    frontZM: 1.54,
    rearHalfWidthM: 0.66,
    rearHeightM: 0.80,
    rearZM: -2.35,
    flareSizeM: 0.28,
    rearFlareSizeM: 0.22,
    measured: true,
  },
  "nissan-r33-jgtc": {
    halfWidthM: 0.35,
    heightM: 0.50,
    frontZM: 2.45,
    rearHalfWidthM: 0.525,
    rearHeightM: 0.68,
    rearZM: -2.09,
    flareSizeM: 0.24,
    rearFlareSizeM: 0.17,
    rearLamps: rearPairs([
      [0.44, 0.68, -2.09, 0.17],
      [0.61, 0.68, -2.07, 0.17],
    ]),
    measured: true,
  },
  "nissan-r32-jtcc": {
    halfWidthM: 0.48,
    heightM: 0.56,
    frontZM: 1.95,
    rearHalfWidthM: 0.545,
    rearHeightM: 0.70,
    rearZM: -2.43,
    flareSizeM: 0.26,
    rearFlareSizeM: 0.17,
    rearLamps: rearPairs([
      [0.46, 0.70, -2.43, 0.17],
      [0.63, 0.70, -2.42, 0.17],
    ]),
    measured: true,
  },
  "bmw-m1-procar": {
    halfWidthM: 0.57,
    heightM: 0.40,
    frontZM: 2.30,
    rearHalfWidthM: 0.58,
    rearHeightM: 0.66,
    rearZM: -1.99,
    flareSizeM: 0.24,
    rearFlareSizeM: 0.22,
    measured: true,
  },
  "vw-scirocco-gtx": {
    halfWidthM: 0.47,
    heightM: 0.58,
    frontZM: 1.74,
    rearHalfWidthM: 0.54,
    rearHeightM: 0.70,
    rearZM: -2.21,
    flareSizeM: 0.26,
    rearFlareSizeM: 0.22,
    measured: true,
  },
  "chaparral-2d": {
    halfWidthM: 0.58,
    heightM: 0.50,
    frontZM: 1.84,
    rearHalfWidthM: 0.52,
    rearHeightM: 0.50,
    rearZM: -1.88,
    flareSizeM: 0.26,
    rearFlareSizeM: 0.14,
    rearLamps: rearPairs([
      [0.461, 0.498, -1.88, 0.14],
      [0.585, 0.498, -1.88, 0.14],
    ]),
    measured: true,
  },
  "chaparral-2d-67": {
    halfWidthM: 0.58,
    heightM: 0.50,
    frontZM: 1.99,
    rearHalfWidthM: 0.55,
    rearHeightM: 0.43,
    rearZM: -1.73,
    flareSizeM: 0.26,
    rearFlareSizeM: 0.14,
    rearLamps: rearPairs([
      [0.547, 0.498, -1.73, 0.14],
      [0.547, 0.364, -1.73, 0.14],
    ]),
    measured: true,
  },
  "porsche-934-rsr": {
    halfWidthM: 0.63,
    heightM: 0.63,
    frontZM: 2.03,
    rearHalfWidthM: 0.54,
    rearHeightM: 0.46,
    rearZM: -1.84,
    flareSizeM: 0.28,
    rearFlareSizeM: 0.16,
    rearLamps: rearPairs([
      [0.48, 0.46, -1.84, 0.16],
      [0.59, 0.46, -1.83, 0.16],
    ]),
    measured: true,
  },
};

/** Headlight beam and visual placement profile for any car in the registry */
export function headlightProfileFor(carId: CarId): HeadlightProfile {
  const cls = anyCarById(carId)?.classId ?? "gt3";
  const base = CLASS_PROFILES[cls] ?? CLASS_PROFILES.gt3;
  const override = CAR_PROFILE_OVERRIDES[carId];
  return override ? { ...base, ...override } : base;
}

/** Whether a car has headlights at all (an F1 car has only its rear rain light) */
export const carHasHeadlights = (carId: CarId): boolean => headlightProfileFor(carId).frontLamps !== false;

/** Whether headlights should illuminate under the current mode and sky/weather state */
export function shouldHeadlightsBeOn(mode: HeadlightMode, sunElevationDeg: number, rainIntensity: number): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return sunElevationDeg < AUTO_HEADLIGHT_SUN_DEG || rainIntensity > AUTO_HEADLIGHT_RAIN;
}

export interface HeadlightStates {
  /** Whether the player's car headlights are illuminated (honours manual on/off override) */
  player: boolean;
  /** Whether AI / online opponent headlights are illuminated (always automatic so the player's toggle never darkens them) */
  opponents: boolean;
}

/**
 * Resolves both player and opponent headlight states for a rendered frame.
 * Opponents always follow automatic sky/rain lighting so a manual player toggle never darkens AI / online cars at
 * night or switches them on in clear daylight.
 */
export function resolveHeadlightStates(
  mode: HeadlightMode,
  sunElevationDeg: number,
  rainIntensity: number,
): HeadlightStates {
  const opponents = shouldHeadlightsBeOn("auto", sunElevationDeg, rainIntensity);
  return {
    player: mode === "auto" ? opponents : mode === "on",
    opponents,
  };
}

/** Whether a session's conditions can ever become dark or rainy enough to need real road-beam SpotLights */
export function canSessionGetDark(conditions: SessionConditions): boolean {
  if (conditions.timeScale > 0) return true;
  if (conditions.timeOfDay === "night" || conditions.timeOfDay === "dusk" || conditions.timeOfDay === "dawn") return true;
  if (
    conditions.weather === "light_rain" ||
    conditions.weather === "heavy_rain" ||
    conditions.weather === "dynamic" ||
    conditions.weather === "drying"
  ) {
    return true;
  }
  return conditions.weatherNodes?.some((n) => (SKY_COVER_SPECS[n.sky]?.rain ?? 0) > 0) ?? false;
}

/**
 * SpotLight budget for the player's car headlights: three.js iterates every SpotLight in the scene on every lit
 * fragment even at intensity 0, so daytime-only sessions skip SpotLights entirely (keeping flares and emissive lenses
 * only). Low and Medium use 1 merged centre SpotLight, High 2 twin SpotLights. Low used to have none, and an unlit
 * circuit at night was then undrivable on it: one light is a few ALU ops a fragment.
 */
export function headlightSpotCountFor(conditions: SessionConditions, quality: GraphicsQuality): HeadlightSpotCount {
  if (!canSessionGetDark(conditions)) return 0;
  return quality === "high" ? 2 : 1;
}

let sharedFlareTexture: THREE.CanvasTexture | null = null;

/** Soft radial glow texture shared across headlight and tail-light sprites (created lazily in browser) */
function getFlareTexture(): THREE.CanvasTexture | null {
  if (sharedFlareTexture) return sharedFlareTexture;
  if (typeof document === "undefined") return null;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const half = size / 2;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, "rgba(255, 255, 255, 1)");
  grad.addColorStop(0.28, "rgba(255, 255, 255, 0.75)");
  grad.addColorStop(0.6, "rgba(255, 255, 255, 0.18)");
  grad.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  sharedFlareTexture = tex;
  return tex;
}

/** The beam's cone against the profile's, and its soft edge: a narrower cone with a wide falloff reads as a real beam */
const BEAM_ANGLE = 0.86;
const BEAM_PENUMBRA = 0.86;
/** Where the low beam's middle meets the road, and the high beam's aim (m ahead of the lamps) */
const LOW_BEAM_AIM_M = 75;
const HIGH_BEAM_AIM_M = 140;

const HEADLIGHT_MAT_RE = /(?:head_?light|front_?light|lamp_?front|hl_glass|light_?front|farol|scheinwerfer)/i;
const TAILLIGHT_MAT_RE = /(?:tail_?light|rear_?light|brake_?light|stop_?light|lamp_?rear)/i;
/** Generic light materials on ported/GT3 GLBs (e.g. `light_004`, `BMWMAT_Lights1`, `MI_..._Lights`) — gated by Z end */
const GENERIC_LIGHT_MAT_RE = /(?:^|_)lights?(?:_?\d+)?$|interactive_lights/i;
const EXCLUDED_FRONT_LIGHT_RE = /(?:tail|brake|reverse|indicator|dash|wheel|interior|clearled|glass|caliper|disc|drum|reflector)/i;
const EXCLUDED_REAR_LIGHT_RE = /(?:head_?light|front_?light|reverse|indicator|amber|dash|wheel|interior|clearled|glass|caliper|disc|drum|reflector)/i;

const _flarePos = new THREE.Vector3();
const _carFwd = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _box = new THREE.Box3();
const _invRoot = new THREE.Matrix4();
const _relMat = new THREE.Matrix4();

interface BoostedMaterial {
  mat: THREE.MeshStandardMaterial;
  baseEmissive: THREE.Color;
  baseIntensity: number;
  hasOwnEmissiveMap: boolean;
}

interface ReplacedMaterialSlot {
  mesh: THREE.Mesh;
  index: number | null;
  original: THREE.MeshStandardMaterial;
  clone: THREE.MeshStandardMaterial;
}

/**
 * Forward-facing car headlights (0, 1 or 2 SpotLights + directional lens flares + rear tail/brake-light glow +
 * cloned emissive headlight and taillight lenses) mounted directly to a car's chassisGroup so beams follow body
 * pitch, roll and bumps. No shadow maps are allocated, keeping frame cost low.
 */
export class CarHeadlights {
  readonly group = new THREE.Group();
  readonly spotCount: HeadlightSpotCount;
  private readonly spots: THREE.SpotLight[] = [];
  private readonly spotIntensity: number;
  private readonly frontFlares: THREE.Sprite[] = [];
  private readonly rearFlares: THREE.Sprite[] = [];
  private readonly rearFlareBaseSizes: number[] = [];
  private readonly frontMat: THREE.SpriteMaterial;
  private readonly rearMat: THREE.SpriteMaterial;
  private readonly profile: HeadlightProfile;
  private readonly frontBoosted: BoostedMaterial[] = [];
  private readonly rearBoosted: BoostedMaterial[] = [];
  private readonly frontCloneByOriginal = new Map<THREE.MeshStandardMaterial, THREE.MeshStandardMaterial>();
  private readonly rearCloneByOriginal = new Map<THREE.MeshStandardMaterial, THREE.MeshStandardMaterial>();
  private readonly replacedSlots: ReplacedMaterialSlot[] = [];
  private scannedRoot: THREE.Object3D | null = null;
  private scannedChildren: THREE.Object3D[] = [];
  private enabled = false;
  private flashing = false;
  /** The car has headlights (not an F1 car) */
  private readonly hasFront: boolean;
  /** 0 dark, 1 low beam, 2 high beam (a flash): what the front lamps last showed */
  private frontLevel: 0 | 1 | 2 = 0;
  /** Where each SpotLight aims on low beam and on high beam (chassis space) */
  private readonly lowAims: THREE.Vector3[] = [];
  private readonly highAims: THREE.Vector3[] = [];
  private braking = false;
  private rearActive = false;

  constructor(carId: CarId, options?: CarHeadlightsOptions) {
    this.group.name = "CarHeadlights";
    this.profile = headlightProfileFor(carId);
    const p = this.profile;
    this.hasFront = p.frontLamps !== false;
    this.spotCount = options?.lightsOnly || !this.hasFront ? 0 : (options?.spotCount ?? 2);

    if (this.spotCount === 2) {
      this.spotIntensity = p.intensity;
      const makeSpot = (side: 1 | -1): THREE.SpotLight => {
        // Decay 1.0 + slightly raised virtual beam origin avoids grazing-angle Lambertian collapse on flat asphalt
        // past 30 m while keeping near-nose intensity balanced under AgX tone mapping.
        const spot = new THREE.SpotLight(p.color, 0, p.distanceM, p.angleRad * BEAM_ANGLE, Math.max(p.penumbra, BEAM_PENUMBRA), 1.0);
        spot.castShadow = false;
        spot.position.set(side * p.halfWidthM, p.heightM + 0.3, p.frontZM);
        // Low beam: aimed far down the road, nearly level, gently outward for corner apexes, so the hot middle of
        // the beam lies 30..80 m ahead and the road just ahead of the nose sits in its soft lower edge (a real low
        // beam's pattern; aimed close it painted a hard bright trapezoid in front of the car and little beyond).
        // High beam: level, further out
        this.lowAims.push(new THREE.Vector3(side * (p.halfWidthM + p.aimSpreadM), 0, p.frontZM + LOW_BEAM_AIM_M));
        this.highAims.push(new THREE.Vector3(side * (p.halfWidthM + 0.6 * p.aimSpreadM), p.heightM + 0.6, p.frontZM + HIGH_BEAM_AIM_M));
        spot.target.position.copy(this.lowAims[this.lowAims.length - 1]);
        this.group.add(spot, spot.target);
        return spot;
      };
      this.spots.push(makeSpot(1), makeSpot(-1));
    } else if (this.spotCount === 1) {
      // Medium quality: single merged centre SpotLight with a slightly wider cone and boosted intensity
      this.spotIntensity = p.intensity * 1.65;
      const spot = new THREE.SpotLight(
        p.color,
        0,
        p.distanceM,
        Math.min(Math.PI * 0.45, p.angleRad * 1.18 * BEAM_ANGLE),
        Math.max(p.penumbra, BEAM_PENUMBRA),
        1.0
      );
      spot.castShadow = false;
      spot.position.set(0, p.heightM + 0.3, p.frontZM);
      this.lowAims.push(new THREE.Vector3(0, 0, p.frontZM + LOW_BEAM_AIM_M));
      this.highAims.push(new THREE.Vector3(0, p.heightM + 0.6, p.frontZM + HIGH_BEAM_AIM_M));
      spot.target.position.copy(this.lowAims[0]);
      this.group.add(spot, spot.target);
      this.spots.push(spot);
    } else {
      this.spotIntensity = 0;
    }

    const tex = getFlareTexture();
    this.frontMat = new THREE.SpriteMaterial({
      color: p.color,
      map: tex,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.rearMat = new THREE.SpriteMaterial({
      color: 0xff1e12,
      map: tex,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });

    const frontZ = p.measured ? p.frontZM : p.frontZM + 0.04;
    for (const side of this.hasFront ? ([1, -1] as const) : []) {
      const flare = new THREE.Sprite(this.frontMat);
      flare.position.set(side * p.halfWidthM, p.heightM, frontZ);
      flare.scale.setScalar(p.flareSizeM);
      flare.visible = false;
      this.frontFlares.push(flare);
      this.group.add(flare);
    }

    const defaultRearSize = p.rearFlareSizeM ?? (p.rearHalfWidthM > 0.01 ? 0.22 : 0.18);
    const rearLamps: readonly LampPlacement[] =
      p.rearLamps ??
      (p.rearHalfWidthM > 0.01
        ? [
            { x: p.rearHalfWidthM, y: p.rearHeightM, z: p.rearZM, size: defaultRearSize },
            { x: -p.rearHalfWidthM, y: p.rearHeightM, z: p.rearZM, size: defaultRearSize },
          ]
        : [{ x: 0, y: p.rearHeightM, z: p.rearZM, size: defaultRearSize }]);
    for (const lamp of rearLamps) {
      const size = lamp.size ?? defaultRearSize;
      const rear = new THREE.Sprite(this.rearMat);
      rear.position.set(lamp.x, lamp.y, lamp.z);
      rear.scale.setScalar(size);
      rear.visible = false;
      this.rearFlares.push(rear);
      this.rearFlareBaseSizes.push(size);
      this.group.add(rear);
    }
  }

  /** Attach to a car's chassisGroup */
  attach(chassisGroup: THREE.Group): void {
    chassisGroup.add(this.group);
    this.scannedRoot = chassisGroup;
    this.scannedChildren = [];
  }

  /**
   * Lazily discovers GLB headlight/taillight materials (and body bounds for unmeasured fallback profiles) whenever
   * the chassisGroup's child list changes (including when an async loader replaces its placeholder with the real
   * `bodyGroup` keeping child count equal).
   * Each matched material is cloned separately for front vs rear meshes so shared template materials (other cars,
   * ghosts, previews, and front/rear lamps sharing a generic `light_*` material) are never mutated.
   */
  private scanMaterials(): void {
    const root = this.scannedRoot;
    if (!root) return;
    const kids = root.children;
    if (kids.length === this.scannedChildren.length && kids.every((c, i) => c === this.scannedChildren[i])) return;
    this.scannedChildren = kids.slice();

    root.updateMatrixWorld(true);
    _invRoot.copy(root.matrixWorld).invert();

    const frontBandMinY = this.profile.heightM - 0.16;
    const frontBandMaxY = this.profile.heightM + 0.16;
    const rearBandMinY = this.profile.rearHeightM - 0.16;
    const rearBandMaxY = this.profile.rearHeightM + 0.16;
    let bodyMaxZ = -Infinity;
    let bodyMinZ = Infinity;

    const acquireClone = (
      m: THREE.MeshStandardMaterial,
      side: "front" | "rear",
    ): THREE.MeshStandardMaterial => {
      const map = side === "front" ? this.frontCloneByOriginal : this.rearCloneByOriginal;
      let clone = map.get(m);
      if (!clone) {
        clone = m.clone();
        clone.userData = { ...m.userData, __headlightClone: true };
        const hasOwnEmissiveMap = Boolean(m.emissiveMap);
        // Reuse the diffuse map as an emissive mask once at clone time when the material has no emissiveMap and starts
        // dark: textured light housings keep black bezels unlit without triggering per-frame shader recompiles.
        if (!hasOwnEmissiveMap && clone.map && m.emissiveIntensity === 0) {
          clone.emissiveMap = clone.map;
        }
        map.set(m, clone);
        const list = side === "front" ? this.frontBoosted : this.rearBoosted;
        list.push({
          mat: clone,
          baseEmissive: m.emissive.clone(),
          baseIntensity: m.emissiveIntensity,
          hasOwnEmissiveMap,
        });
      }
      return clone;
    };

    for (const child of kids) {
      if (child === this.group) continue;
      child.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        const geo = obj.geometry;
        let hasBox = false;
        if (geo) {
          if (!geo.boundingBox) geo.computeBoundingBox();
          if (geo.boundingBox) {
            // Compose relative to chassisGroup BEFORE transforming the AABB so world-space yaw never inflates Z bounds.
            _relMat.multiplyMatrices(_invRoot, obj.matrixWorld);
            _box.copy(geo.boundingBox).applyMatrix4(_relMat);
            hasBox = Number.isFinite(_box.min.z) && Number.isFinite(_box.max.z);
            if (hasBox && _box.max.z - _box.min.z < 8) {
              if (_box.max.y >= frontBandMinY && _box.min.y <= frontBandMaxY && _box.max.z > bodyMaxZ) {
                bodyMaxZ = _box.max.z;
              }
              if (_box.max.y >= rearBandMinY && _box.min.y <= rearBandMaxY && _box.min.z < bodyMinZ) {
                bodyMinZ = _box.min.z;
              }
            }
          }
        }

        const isStrictlyFront = hasBox && _box.min.z > 0.5;
        const isStrictlyRear = hasBox && _box.max.z < -0.5;

        const isArr = Array.isArray(obj.material);
        const mats = isArr ? obj.material : [obj.material];
        let nextArr: THREE.Material[] | null = null;
        for (let i = 0; i < mats.length; i++) {
          const m = mats[i];
          if (!(m instanceof THREE.MeshStandardMaterial) || m.userData.__headlightClone) continue;

          const explicitFront = !isStrictlyRear && (HEADLIGHT_MAT_RE.test(m.name) || HEADLIGHT_MAT_RE.test(obj.name));
          const genericFront =
            !explicitFront &&
            isStrictlyFront &&
            !EXCLUDED_FRONT_LIGHT_RE.test(m.name) &&
            !EXCLUDED_FRONT_LIGHT_RE.test(obj.name) &&
            (GENERIC_LIGHT_MAT_RE.test(m.name) || GENERIC_LIGHT_MAT_RE.test(obj.name));

          const explicitRear =
            !explicitFront &&
            !genericFront &&
            isStrictlyRear &&
            !EXCLUDED_REAR_LIGHT_RE.test(m.name) &&
            !EXCLUDED_REAR_LIGHT_RE.test(obj.name) &&
            (TAILLIGHT_MAT_RE.test(m.name) || TAILLIGHT_MAT_RE.test(obj.name));
          const genericRear =
            !explicitFront &&
            !genericFront &&
            !explicitRear &&
            isStrictlyRear &&
            !EXCLUDED_REAR_LIGHT_RE.test(m.name) &&
            !EXCLUDED_REAR_LIGHT_RE.test(obj.name) &&
            (GENERIC_LIGHT_MAT_RE.test(m.name) || GENERIC_LIGHT_MAT_RE.test(obj.name));

          const side: "front" | "rear" | null =
            explicitFront || genericFront ? "front" : explicitRear || genericRear ? "rear" : null;
          if (!side) continue;

          const clone = acquireClone(m, side);
          if (isArr) {
            const arr = nextArr ?? (nextArr = mats.slice());
            arr[i] = clone;
            this.replacedSlots.push({ mesh: obj, index: i, original: m, clone });
          } else {
            obj.material = clone;
            this.replacedSlots.push({ mesh: obj, index: null, original: m, clone });
          }
        }
        if (nextArr) obj.material = nextArr;
      });
    }

    // For unmeasured fallback profiles only, keep flares outside lamp-height body geometry (ignoring wings/splitters).
    if (!this.profile.measured) {
      if (bodyMaxZ > 1.2 && bodyMaxZ < 4.0) {
        const frontZ = Math.max(this.profile.frontZM, bodyMaxZ - 0.04);
        for (const f of this.frontFlares) f.position.z = frontZ + 0.06;
      }
      if (bodyMinZ < -1.2 && bodyMinZ > -4.0) {
        const rearZ = Math.min(this.profile.rearZM, bodyMinZ + 0.04);
        for (const r of this.rearFlares) r.position.z = rearZ - 0.06;
      }
    }
    if (this.frontLevel > 0) this.applyFrontBoost(this.frontLevel);
    if (this.rearActive) this.applyRearBoost(true, this.braking);
  }

  private applyFrontBoost(level: 0 | 1 | 2): void {
    for (const b of this.frontBoosted) {
      if (level > 0) {
        b.mat.emissive.setHex(b.hasOwnEmissiveMap ? 0xffffff : this.profile.color);
        b.mat.emissiveIntensity = Math.max(b.baseIntensity, level === 2 ? LENS_GLOW_HIGH : LENS_GLOW_LOW);
      } else {
        b.mat.emissive.copy(b.baseEmissive);
        b.mat.emissiveIntensity = b.baseIntensity;
      }
    }
  }

  private applyRearBoost(active: boolean, braking: boolean): void {
    for (const b of this.rearBoosted) {
      if (active) {
        b.mat.emissive.setHex(b.hasOwnEmissiveMap ? 0xffffff : 0xff1e12);
        const glow = braking ? BRAKE_GLOW : TAIL_GLOW;
        const target = b.hasOwnEmissiveMap ? glow.own : glow.plain;
        b.mat.emissiveIntensity = Math.max(b.baseIntensity, target);
      } else {
        b.mat.emissive.copy(b.baseEmissive);
        b.mat.emissiveIntensity = b.baseIntensity;
      }
    }
  }

  /**
   * Toggle headlights on/off, update rear brake-light brightening (including daytime braking when headlights are off),
   * and gate each front/rear flare sprite against the camera position so front headlight flares never leak into
   * onboard (cockpit / dash / nose) or behind-car views.
   */
  setEnabled(on: boolean, braking = false, camera?: THREE.Camera, hideFrontFlares = false): void {
    this.scanMaterials();
    this.enabled = on;
    // The front lamps: dark, low beam, or the high beam while flashing (day or night, lights on or off)
    const level: 0 | 1 | 2 = !this.hasFront ? 0 : this.flashing ? 2 : on ? 1 : 0;
    if (level !== this.frontLevel) {
      this.frontLevel = level;
      const high = level === 2;
      for (let i = 0; i < this.spots.length; i++) {
        const s = this.spots[i];
        s.intensity = level === 0 ? 0 : this.spotIntensity * (high ? HIGH_BEAM_GAIN : 1);
        s.distance = this.profile.distanceM * (high ? HIGH_BEAM_REACH : 1);
        s.target.position.copy(high ? this.highAims[i] : this.lowAims[i]);
      }
      const flareSize = this.profile.flareSizeM * (high ? HIGH_BEAM_FLARE : 1);
      this.frontMat.color.setHex(this.profile.color).multiplyScalar(high ? HIGH_BEAM_FLARE_GAIN : 1);
      for (const f of this.frontFlares) {
        f.scale.setScalar(flareSize);
        f.visible = level > 0 && !hideFrontFlares;
      }
      this.applyFrontBoost(level);
    }
    const lit = level > 0;
    const frontOpacity = level === 2 ? 1 : 0.9;
    const rearActive = on || braking;
    const baseRearOpacity = braking ? 0.92 : 0.36;
    if (rearActive !== this.rearActive || braking !== this.braking) {
      this.rearActive = rearActive;
      this.braking = braking;
      const scaleMult = braking ? 1.32 : 1.0;
      for (let i = 0; i < this.rearFlares.length; i++) {
        this.rearFlares[i].scale.setScalar(this.rearFlareBaseSizes[i] * scaleMult);
      }
      this.applyRearBoost(rearActive, braking);
    }
    if (!lit) {
      this.frontMat.opacity = 0;
      for (const f of this.frontFlares) f.visible = false;
    }
    if (!rearActive) {
      this.rearMat.opacity = 0;
      for (const r of this.rearFlares) r.visible = false;
    }
    if (!lit && !rearActive) return;
    if (camera) {
      this.group.updateWorldMatrix(true, true);
      // Local +Z is forward in every car rig's chassisGroup
      _carFwd.set(0, 0, 1).transformDirection(this.group.matrixWorld);
      camera.getWorldPosition(_camPos);

      if (lit) {
        let maxFrontVis = 0;
        for (const f of this.frontFlares) {
          if (hideFrontFlares) {
            f.visible = false;
            continue;
          }
          _flarePos.setFromMatrixPosition(f.matrixWorld);
          _toCam.subVectors(_camPos, _flarePos);
          const lenSq = _toCam.lengthSq();
          if (lenSq <= 1e-6) {
            f.visible = false;
            continue;
          }
          const alongFwd = _toCam.dot(_carFwd);
          const vis = alongFwd > 0.1 ? THREE.MathUtils.smoothstep(alongFwd / Math.sqrt(lenSq), 0.12, 0.55) : 0;
          f.visible = vis > 0.01;
          if (vis > maxFrontVis) maxFrontVis = vis;
        }
        this.frontMat.opacity = frontOpacity * maxFrontVis;
      }

      if (rearActive) {
        let maxRearVis = 0;
        for (const r of this.rearFlares) {
          _flarePos.setFromMatrixPosition(r.matrixWorld);
          _toCam.subVectors(_camPos, _flarePos);
          const lenSq = _toCam.lengthSq();
          if (lenSq <= 1e-6) {
            r.visible = false;
            continue;
          }
          const alongBack = -_toCam.dot(_carFwd);
          const vis = alongBack > 0.1 ? THREE.MathUtils.smoothstep(alongBack / Math.sqrt(lenSq), 0.05, 0.45) : 0;
          r.visible = vis > 0.01;
          if (vis > maxRearVis) maxRearVis = vis;
        }
        this.rearMat.opacity = baseRearOpacity * maxRearVis;
      }
    } else {
      if (lit) {
        this.frontMat.opacity = hideFrontFlares ? 0 : frontOpacity;
        for (const f of this.frontFlares) f.visible = !hideFrontFlares;
      }
      if (rearActive) {
        this.rearMat.opacity = baseRearOpacity;
        for (const r of this.rearFlares) r.visible = true;
      }
    }
  }

  /**
   * The beam as one merged light between the lamps (as Medium's single SpotLight), in world space at the car's last
   * drawn pose: low or high beam, false while the front lamps are dark. For the opponents, whose rigs carry no
   * SpotLight: opponent-beams.ts lights the road with it
   */
  beam(out: HeadlightBeam): boolean {
    if (this.frontLevel === 0) return false;
    const p = this.profile;
    const high = this.frontLevel === 2;
    const m = this.group.matrixWorld;
    out.pos.set(0, p.heightM + 0.3, p.frontZM).applyMatrix4(m);
    out.dir
      .set(0, high ? p.heightM + 0.6 : 0, p.frontZM + (high ? HIGH_BEAM_AIM_M : LOW_BEAM_AIM_M))
      .applyMatrix4(m)
      .sub(out.pos)
      .normalize();
    out.intensity = p.intensity * 1.65 * (high ? HIGH_BEAM_GAIN : 1);
    out.range = p.distanceM * (high ? HIGH_BEAM_REACH : 1);
    return true;
  }

  /**
   * The high beam on (a flash) or off; it shows from the next `setEnabled`. A flash lights the front lamps whether
   * the headlights are on or not, and never changes the headlight mode.
   */
  setFlash(on: boolean): void {
    this.flashing = on;
  }

  get isOn(): boolean {
    return this.enabled;
  }

  get isFlashing(): boolean {
    return this.hasFront && this.flashing;
  }

  get isBraking(): boolean {
    return this.braking;
  }

  dispose(): void {
    this.applyFrontBoost(0);
    this.applyRearBoost(false, false);
    for (const slot of this.replacedSlots) {
      if (slot.index === null) {
        if (slot.mesh.material === slot.clone) slot.mesh.material = slot.original;
      } else if (Array.isArray(slot.mesh.material) && slot.mesh.material[slot.index] === slot.clone) {
        const restored = slot.mesh.material.slice();
        restored[slot.index] = slot.original;
        slot.mesh.material = restored;
      }
    }
    this.replacedSlots.length = 0;
    for (const b of this.frontBoosted) b.mat.dispose();
    for (const b of this.rearBoosted) b.mat.dispose();
    this.frontBoosted.length = 0;
    this.rearBoosted.length = 0;
    this.frontCloneByOriginal.clear();
    this.rearCloneByOriginal.clear();
    this.group.removeFromParent();
    this.frontMat.dispose();
    this.rearMat.dispose();
  }
}
