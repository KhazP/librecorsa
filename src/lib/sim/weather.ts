/**
 * Weather and time of day for a session: the sun's path, cloud cover, rain, air and track temperature, and the water
 * on the road, which rain lays down and which drains, evaporates and is swept off the racing line by the cars.
 *
 * Re-implemented conceptually after Speed Dreams 2.4 (weather generated from a formula of the session time rather
 * than records) and AC's dynamic track; nothing is copied. Everything is deterministic from the session's
 * conditions and seed, so every client of a multiplayer race that starts from the host's snapshot evolves the same.
 *
 * Water is a film depth (mm) over the asphalt. One global depth (rain in, drainage + evaporation out) plus, per track
 * sector, the share of it still on the racing line (`lineWater`, cars squeeze it out, rain refills it), so the line
 * dries first. `wetnessFromWater` turns a depth into how wet the road acts for grip and visuals.
 */
import { wetnessFromWater } from './wet-tyres';
import {
  SURFACE_GRIP_PRESETS,
  SURFACE_TIME_SCALES,
  type SurfaceGripPresetId,
} from './track-evolution';

export type WeatherPresetId = 'clear' | 'overcast' | 'light_rain' | 'heavy_rain' | 'drying' | 'dynamic';
export type TimeOfDayId = 'dawn' | 'morning' | 'noon' | 'afternoon' | 'golden_hour' | 'dusk';

/** 11-level sky cover classification (indices 0..10) */
export type SkyCoverId =
  | 'clear'
  | 'light_clouds'
  | 'partially_cloudy'
  | 'mostly_cloudy'
  | 'overcast'
  | 'cloudy_drizzle'
  | 'cloudy_light_rain'
  | 'overcast_light_rain'
  | 'overcast_rain'
  | 'overcast_heavy_rain'
  | 'overcast_storm';

export const SKY_COVER_IDS: readonly SkyCoverId[] = [
  'clear',
  'light_clouds',
  'partially_cloudy',
  'mostly_cloudy',
  'overcast',
  'cloudy_drizzle',
  'cloudy_light_rain',
  'overcast_light_rain',
  'overcast_rain',
  'overcast_heavy_rain',
  'overcast_storm',
];

export interface SkyCoverSpec {
  index: number;
  label: string;
  cloud: number;
  rain: number;
  defaultRainChance: number;
  defaultHumidityPct: number;
}

export const SKY_COVER_SPECS: Record<SkyCoverId, SkyCoverSpec> = {
  clear: { index: 0, label: 'Clear', cloud: 0.0, rain: 0.0, defaultRainChance: 0, defaultHumidityPct: 45 },
  light_clouds: { index: 1, label: 'Light Clouds', cloud: 0.22, rain: 0.0, defaultRainChance: 0, defaultHumidityPct: 50 },
  partially_cloudy: { index: 2, label: 'Partially Cloudy', cloud: 0.45, rain: 0.0, defaultRainChance: 5, defaultHumidityPct: 55 },
  mostly_cloudy: { index: 3, label: 'Mostly Cloudy', cloud: 0.7, rain: 0.0, defaultRainChance: 15, defaultHumidityPct: 62 },
  overcast: { index: 4, label: 'Overcast', cloud: 0.85, rain: 0.0, defaultRainChance: 25, defaultHumidityPct: 70 },
  cloudy_drizzle: { index: 5, label: 'Cloudy & Drizzle', cloud: 0.78, rain: 0.15, defaultRainChance: 60, defaultHumidityPct: 78 },
  cloudy_light_rain: { index: 6, label: 'Cloudy & Light Rain', cloud: 0.85, rain: 0.28, defaultRainChance: 75, defaultHumidityPct: 84 },
  overcast_light_rain: { index: 7, label: 'Overcast & Light Rain', cloud: 0.92, rain: 0.35, defaultRainChance: 85, defaultHumidityPct: 88 },
  overcast_rain: { index: 8, label: 'Overcast & Rain', cloud: 0.96, rain: 0.58, defaultRainChance: 95, defaultHumidityPct: 92 },
  overcast_heavy_rain: { index: 9, label: 'Overcast & Heavy Rain', cloud: 1.0, rain: 0.85, defaultRainChance: 100, defaultHumidityPct: 96 },
  overcast_storm: { index: 10, label: 'Overcast & Storm', cloud: 1.0, rain: 1.0, defaultRainChance: 100, defaultHumidityPct: 99 },
};

/** 8 compass wind octants (0 = N, 1 = NE, 2 = E, 3 = SE, 4 = S, 5 = SW, 6 = W, 7 = NW) */
export type WindDirectionOctant = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const WIND_OCTANT_LABELS: readonly string[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** 5-node session weather schedule checkpoints (Start, 25%, 50%, 75%, Finish) */
export const WEATHER_NODE_FRACTIONS = [0, 0.25, 0.5, 0.75, 1] as const;
export const WEATHER_NODE_LABELS = ['Start', '25%', '50%', '75%', 'Finish'] as const;

export interface WeatherNode {
  sky: SkyCoverId;
  /** Probability of precipitation at this node (0..100 %) */
  rainChance: number;
  /** Ambient air temperature (°C) */
  temperatureC: number;
  /** Relative humidity (0..100 %) */
  humidityPct: number;
  /** Wind speed (km/h) */
  windSpeedKmh: number;
  /** Wind compass octant (0..7: N, NE, E, SE, S, SW, W, NW) */
  windDirectionOctant: WindDirectionOctant;
}

export const WEATHER_PRESETS: readonly WeatherPresetId[] = ['clear', 'overcast', 'light_rain', 'heavy_rain', 'drying', 'dynamic'];
export const TIME_OF_DAY_PRESETS: readonly TimeOfDayId[] = ['dawn', 'morning', 'noon', 'afternoon', 'golden_hour', 'dusk'];
/** Time progression multipliers offered in the menu (0 = the clock stands still) */
export const TIME_SCALES: readonly number[] = [0, 1, 5, 15, 60];

export interface SessionConditions {
  weather: WeatherPresetId;
  timeOfDay: TimeOfDayId;
  /** Sim clock multiplier for the sun and the weather (0 = frozen clock; the weather then runs in real time) */
  timeScale: number;
  /** Seed of the dynamic weather */
  seed: number;
  /** Optional 5-node scripted weather timeline (Start, 25%, 50%, 75%, Finish) */
  weatherNodes?: readonly WeatherNode[];
  /** Duration of the 5-node weather cycle in weather-clock seconds (default 1800 s = 30 min) */
  weatherDurationS?: number;
  /** Optional initial dynamic road rubber preset ('green' | 'light' | 'medium' | 'natural' | 'heavy' | 'saturated') */
  surfacePreset?: SurfaceGripPresetId;
  /** Optional dynamic road rubber & drying progression multiplier (0 = static, 1 = 1x, etc.) */
  surfaceTimeScale?: number;
}

export const DEFAULT_SESSION_CONDITIONS: Readonly<SessionConditions> = {
  weather: 'clear',
  timeOfDay: 'golden_hour',
  timeScale: 0,
  seed: 1,
};

export const WEATHER_LABELS: Record<WeatherPresetId, { label: string; detail: string }> = {
  clear: { label: 'Clear', detail: 'Dry, sunny' },
  overcast: { label: 'Overcast', detail: 'Dry, grey sky, cooler track' },
  light_rain: { label: 'Light rain', detail: 'Wet track, intermediates' },
  heavy_rain: { label: 'Heavy rain', detail: 'Standing water, full wets' },
  drying: { label: 'Drying', detail: 'Rain has stopped, a dry line appears' },
  dynamic: { label: 'Dynamic', detail: 'Changes during the session' },
};

export const TIME_OF_DAY_LABELS: Record<TimeOfDayId, string> = {
  dawn: 'Dawn',
  morning: 'Morning',
  noon: 'Noon',
  afternoon: 'Afternoon',
  golden_hour: 'Golden hour',
  dusk: 'Dusk',
};

// ---------------------------------------------------------------------------
// Sun
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
/** A generic near-equatorial site (Kigali is 2° S) with the sun 12° north: the circuits share one sky */
const LATITUDE_DEG = -2;
const DECLINATION_DEG = 12;
/** The look the sim was built around: the sun 14° up at bearing 127° (three.js Sky azimuth) */
export const GOLDEN_HOUR_ELEVATION_DEG = 14;
export const GOLDEN_HOUR_AZIMUTH_DEG = 127;

/** Sun elevation (deg) and compass azimuth (deg from north toward east) at local solar time `clockH` */
function solarAngles(clockH: number): { elevationDeg: number; compassDeg: number } {
  const lat = LATITUDE_DEG * DEG;
  const dec = DECLINATION_DEG * DEG;
  const H = (clockH - 12) * 15 * DEG;
  const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  // Azimuth from north, clockwise
  const az = Math.atan2(-Math.sin(H) * Math.cos(dec), Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(H));
  return { elevationDeg: alt / DEG, compassDeg: ((az / DEG) % 360 + 360) % 360 };
}

/** Afternoon clock (h) at which the sun stands at the golden-hour elevation (bisection, once) */
function solveGoldenHourClock(): number {
  let lo = 12.5;
  let hi = 18.5;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (solarAngles(mid).elevationDeg > GOLDEN_HOUR_ELEVATION_DEG) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export const GOLDEN_HOUR_CLOCK_H = solveGoldenHourClock();
const AZIMUTH_OFFSET_DEG = GOLDEN_HOUR_AZIMUTH_DEG + solarAngles(GOLDEN_HOUR_CLOCK_H).compassDeg;

export const TIME_OF_DAY_HOURS: Record<TimeOfDayId, number> = {
  dawn: 6.3,
  morning: 9,
  noon: 12.2,
  afternoon: 15,
  golden_hour: GOLDEN_HOUR_CLOCK_H,
  dusk: 17.95,
};

/** The progressing clock stops in the late twilight, so a long session never goes fully dark (h) */
export const CLOCK_MIN_H = 5.9;
export const CLOCK_MAX_H = 18.35;

/** The sun at `clockH`: elevation (deg) and azimuth in the three.js Sky convention (deg; 0 = +Z, 90 = +X) */
export function sunPosition(clockH: number): { elevationDeg: number; azimuthDeg: number } {
  const a = solarAngles(clockH);
  return { elevationDeg: a.elevationDeg, azimuthDeg: (((AZIMUTH_OFFSET_DEG - a.compassDeg) % 360) + 360) % 360 };
}

// ---------------------------------------------------------------------------
// Temperatures
// ---------------------------------------------------------------------------

/** Air and track at golden hour under a clear sky: the sim's long-standing 27 / 41 °C */
const GOLDEN_AMBIENT_C = 27;
const GOLDEN_TRACK_C = 41;
const AMBIENT_SWING_C = 5;
const ambientDay = (clockH: number) => Math.cos((2 * Math.PI * (clockH - 15)) / 24);
const AMBIENT_MEAN_C = GOLDEN_AMBIENT_C - AMBIENT_SWING_C * ambientDay(GOLDEN_HOUR_CLOCK_H);
/** Solar heating of the asphalt through the day: a bump from 07:00 to 20:00, its lag puts the peak after noon */
const dayHeat = (clockH: number) => Math.pow(Math.max(0, Math.sin((Math.PI * (clockH - 7)) / 13)), 1.2);
const TRACK_SOLAR_GAIN_C = (GOLDEN_TRACK_C - GOLDEN_AMBIENT_C) / dayHeat(GOLDEN_HOUR_CLOCK_H);

/** Air temperature (°C) at `clockH` under `cloud` cover and `rain` */
export function ambientTempC(clockH: number, cloud: number, rain: number): number {
  return AMBIENT_MEAN_C + AMBIENT_SWING_C * (1 - 0.6 * cloud) * ambientDay(clockH) - 2.5 * rain;
}

/** Track surface temperature (°C) the asphalt settles toward */
export function trackTargetTempC(clockH: number, cloud: number, rain: number, wetness: number): number {
  const air = ambientTempC(clockH, cloud, rain);
  return air + 1 + (TRACK_SOLAR_GAIN_C * dayHeat(clockH) * (1 - 0.8 * cloud) - 1) * (1 - 0.85 * wetness);
}

// ---------------------------------------------------------------------------
// Presets & dynamic weather
// ---------------------------------------------------------------------------

interface PresetState {
  cloud: number;
  rain: number;
  /** Water on the road at the start (mm) */
  waterMm: number;
  /** Share of the water still on the racing line at the start */
  lineWater: number;
}

const PRESET_STATE: Record<Exclude<WeatherPresetId, 'dynamic'>, PresetState> = {
  clear: { cloud: 0, rain: 0, waterMm: 0, lineWater: 1 },
  overcast: { cloud: 0.85, rain: 0, waterMm: 0, lineWater: 1 },
  light_rain: { cloud: 0.9, rain: 0.3, waterMm: 0.5, lineWater: 1 },
  heavy_rain: { cloud: 1, rain: 0.85, waterMm: 2.4, lineWater: 1 },
  drying: { cloud: 0.45, rain: 0, waterMm: 0.9, lineWater: 0.55 },
};

/** Seeded 0..1 hash */
function hash01(seed: number, k: number): number {
  const x = Math.sin(seed * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Dynamic weather: cloud cover from three slow, seeded waves over the session clock (periods 31, 17 and 7 min), and
 * rain whenever the cover passes 65 %. Deterministic, so a replay or a peer with the same seed sees the same sky.
 */
export function dynamicWeatherAt(seed: number, weatherS: number): { cloud: number; rain: number } {
  const periodsS = [31 * 60, 17 * 60, 7 * 60];
  const amps = [0.55, 0.3, 0.15];
  let x = 0;
  for (let i = 0; i < 3; i++) x += amps[i] * Math.sin((2 * Math.PI * weatherS) / periodsS[i] + 2 * Math.PI * hash01(seed, i));
  // Seeds lean dry or wet a little
  const bias = (hash01(seed, 7) - 0.5) * 0.3;
  const cloud = Math.min(1, Math.max(0, 0.55 + bias + 0.75 * x));
  const rain = Math.pow(Math.min(1, Math.max(0, (cloud - 0.65) / 0.35)), 1.3);
  return { cloud, rain };
}

/** Smooth interpolation exponent between consecutive weather nodes (`fWeatherLerpPower`) */
export const WEATHER_LERP_POWER = 1.35;
/** Default 5-node weather schedule duration in weather-clock seconds (30 min) */
export const DEFAULT_WEATHER_DURATION_S = 1800;
/** Spacing of the 3x3 spatial weather cell grid around the circuit origin (m) */
export const TRACK_WEATHER_NODE_SIZE_M = 600;

/** Builds a default 5-node weather timeline (`Start`, `25%`, `50%`, `75%`, `Finish`) for a preset */
export function defaultWeatherNodesForPreset(
  preset: WeatherPresetId,
  timeOfDay: TimeOfDayId = 'golden_hour',
  seed = 1
): WeatherNode[] {
  const clockH = TIME_OF_DAY_HOURS[timeOfDay] ?? GOLDEN_HOUR_CLOCK_H;
  const makeNode = (
    sky: SkyCoverId,
    rainChance: number,
    humidityPct: number,
    windSpeedKmh: number,
    windDirectionOctant: WindDirectionOctant
  ): WeatherNode => {
    const spec = SKY_COVER_SPECS[sky];
    const temp = Math.round(ambientTempC(clockH, spec.cloud, spec.rain));
    return {
      sky,
      rainChance,
      temperatureC: temp,
      humidityPct,
      windSpeedKmh,
      windDirectionOctant,
    };
  };

  switch (preset) {
    case 'clear':
      return [
        makeNode('clear', 0, 45, 8, 2),
        makeNode('clear', 0, 45, 9, 2),
        makeNode('light_clouds', 0, 48, 10, 2),
        makeNode('clear', 0, 46, 9, 2),
        makeNode('clear', 0, 45, 8, 2),
      ];
    case 'overcast':
      return [
        makeNode('mostly_cloudy', 10, 65, 14, 6),
        makeNode('overcast', 15, 70, 16, 6),
        makeNode('overcast', 20, 72, 18, 6),
        makeNode('overcast', 15, 70, 15, 6),
        makeNode('mostly_cloudy', 10, 66, 13, 6),
      ];
    case 'light_rain':
      return [
        makeNode('overcast_light_rain', 85, 86, 18, 5),
        makeNode('cloudy_light_rain', 80, 84, 20, 5),
        makeNode('overcast_light_rain', 90, 88, 22, 5),
        makeNode('cloudy_light_rain', 75, 83, 18, 5),
        makeNode('cloudy_drizzle', 65, 80, 15, 5),
      ];
    case 'heavy_rain':
      return [
        makeNode('overcast_rain', 95, 92, 26, 6),
        makeNode('overcast_heavy_rain', 100, 96, 32, 6),
        makeNode('overcast_storm', 100, 98, 38, 7),
        makeNode('overcast_heavy_rain', 100, 96, 30, 6),
        makeNode('overcast_rain', 90, 92, 24, 6),
      ];
    case 'drying':
      return [
        makeNode('overcast', 10, 78, 16, 3),
        makeNode('mostly_cloudy', 5, 68, 18, 3),
        makeNode('partially_cloudy', 0, 58, 16, 3),
        makeNode('light_clouds', 0, 50, 14, 3),
        makeNode('clear', 0, 45, 12, 3),
      ];
    case 'dynamic': {
      const skies: SkyCoverId[] = [
        'light_clouds',
        'partially_cloudy',
        'overcast',
        'cloudy_light_rain',
        'overcast_rain',
        'overcast_heavy_rain',
      ];
      return WEATHER_NODE_FRACTIONS.map((_, idx) => {
        const h = hash01(seed, idx + 11);
        const sky = skies[Math.min(skies.length - 1, Math.floor(h * skies.length))];
        const spec = SKY_COVER_SPECS[sky];
        const oct = (Math.floor(hash01(seed, idx + 31) * 8) % 8) as WindDirectionOctant;
        return makeNode(
          sky,
          spec.defaultRainChance,
          spec.defaultHumidityPct,
          Math.round(10 + 24 * hash01(seed, idx + 21)),
          oct
        );
      });
    }
  }
}

export interface InterpolatedNodeWeather {
  sky: SkyCoverId;
  cloud: number;
  rain: number;
  rainChance: number;
  ambientC: number;
  humidityPct: number;
  windSpeedKmh: number;
  windDirectionDeg: number;
  windVxMs: number;
  windVzMs: number;
}

/**
 * Evaluates the 5-node weather schedule at normalized progress `progress01` (0..1) using power-lerp blending
 * (`WEATHER_LERP_POWER`) and deterministic rain-chance activation per node.
 */
export function interpolateWeatherNodes(
  nodes: readonly WeatherNode[],
  progress01: number,
  seed = 1
): InterpolatedNodeWeather {
  const count = nodes.length;
  if (count === 0) {
    return {
      sky: 'clear',
      cloud: 0,
      rain: 0,
      rainChance: 0,
      ambientC: GOLDEN_AMBIENT_C,
      humidityPct: 45,
      windSpeedKmh: 8,
      windDirectionDeg: 90,
      windVxMs: 8 / 3.6,
      windVzMs: 0,
    };
  }
  const u = Math.min(1, Math.max(0, Number.isFinite(progress01) ? progress01 : 0)) * Math.max(1, count - 1);
  const idx0 = Math.min(count - 1, Math.floor(u));
  const idx1 = Math.min(count - 1, idx0 + 1);
  const rawT = u - idx0;
  // Power-lerp S-curve (`fWeatherLerpPower`) for natural meteorological front transitions
  const t =
    rawT < 0.5
      ? 0.5 * Math.pow(2 * rawT, WEATHER_LERP_POWER)
      : 1 - 0.5 * Math.pow(2 * (1 - rawT), WEATHER_LERP_POWER);

  const n0 = nodes[idx0];
  const n1 = nodes[idx1];
  const s0 = SKY_COVER_SPECS[n0.sky] ?? SKY_COVER_SPECS.clear;
  const s1 = SKY_COVER_SPECS[n1.sky] ?? SKY_COVER_SPECS.clear;

  // Deterministic stochastic rain realization at each node from `rainChance` (0..100%)
  const nodeRain = (node: WeatherNode, spec: SkyCoverSpec, nodeIdx: number): number => {
    const chance01 = Math.min(1, Math.max(0, node.rainChance / 100));
    if (chance01 <= 0 || spec.rain <= 0) return 0;
    if (chance01 >= 0.99) return spec.rain;
    const roll = hash01(seed, 101 + nodeIdx * 17);
    if (roll <= chance01) {
      return spec.rain * (0.65 + 0.35 * (chance01 - roll) / Math.max(0.05, chance01));
    }
    return 0;
  };

  const r0 = nodeRain(n0, s0, idx0);
  const r1 = nodeRain(n1, s1, idx1);
  const cloud = s0.cloud + (s1.cloud - s0.cloud) * t;
  const rain = r0 + (r1 - r0) * t;
  const rainChance = n0.rainChance + (n1.rainChance - n0.rainChance) * t;
  const ambientC = n0.temperatureC + (n1.temperatureC - n0.temperatureC) * t;
  const humidityPct = n0.humidityPct + (n1.humidityPct - n0.humidityPct) * t;
  const windSpeedKmh = n0.windSpeedKmh + (n1.windSpeedKmh - n0.windSpeedKmh) * t;

  // Circular interpolation of wind direction octant (0 = N = 0 deg, 1 = NE = 45 deg, ...)
  const a0 = (n0.windDirectionOctant % 8) * 45 * DEG;
  const a1 = (n1.windDirectionOctant % 8) * 45 * DEG;
  const vx = (1 - t) * Math.sin(a0) + t * Math.sin(a1);
  const vz = (1 - t) * Math.cos(a0) + t * Math.cos(a1);
  const windDirectionDeg = (((Math.atan2(vx, vz) / DEG) % 360) + 360) % 360;
  const windSpeedMs = windSpeedKmh / 3.6;

  return {
    sky: t < 0.5 ? n0.sky : n1.sky,
    cloud: Math.min(1, Math.max(0, cloud)),
    rain: Math.min(1, Math.max(0, rain)),
    rainChance: Math.min(100, Math.max(0, rainChance)),
    ambientC,
    humidityPct: Math.min(100, Math.max(0, humidityPct)),
    windSpeedKmh: Math.max(0, windSpeedKmh),
    windDirectionDeg,
    windVxMs: windSpeedMs * Math.sin(windDirectionDeg * DEG),
    windVzMs: windSpeedMs * Math.cos(windDirectionDeg * DEG),
  };
}

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

/** Rain rate at intensity 1 (mm/h); rate ∝ intensity² */
const RAIN_RATE_MM_H = 12;
/** Run-off of the film off the cambered road: k·h^1.67 (mm/h), so heavy rain stands at ~2.4 mm, light at ~0.7 */
const DRAIN_K = 2.0;
const DRAIN_EXP = 1.67;
/** Racing-line water squeezed out per car pass at full speed (share of what is there) */
const LINE_CLEAR_PER_PASS = 0.045;
/** Half-width of the line the cars dry (m) and of its Gaussian blend into the wet track */
const LINE_HALF_WIDTH_M = 2.4;
const LINE_SIGMA_M = 2.1;
export const WEATHER_SECTORS = 64;
/** Time constant of the track surface temperature (s of weather clock) */
const TRACK_TEMP_TAU_S = 600;

/** Weather state as the host sends it to the other clients */
export interface WeatherSyncState {
  conditions: SessionConditions;
  clockH: number;
  weatherS: number;
  cloud: number;
  rain: number;
  waterMm: number;
  trackTempC: number;
}

export class WeatherState {
  public conditions: SessionConditions;
  /** Local solar time (h) */
  public clockH = GOLDEN_HOUR_CLOCK_H;
  /** Weather clock (s): real seconds × max(1, timeScale) since the session started */
  public weatherS = 0;
  public cloudCover = 0;
  public rainIntensity = 0;
  public ambientC = GOLDEN_AMBIENT_C;
  public trackTempC = GOLDEN_TRACK_C;
  /** Relative humidity (0..100 %) */
  public humidityPct = 45;
  /** Wind speed (km/h) and compass bearing (deg, 0 = N, 90 = E) */
  public windSpeedKmh = 8;
  public windDirectionDeg = 90;
  /** Wind velocity components in world XZ (m/s) */
  public windVxMs = 8 / 3.6;
  public windVzMs = 0;
  /** Active sky classification */
  public skyCover: SkyCoverId = 'clear';
  /** 3x3 spatial rain intensity grid around the circuit origin (`mRaining[3][3]`, center at index 4) */
  public readonly rainGrid3x3 = new Float64Array(9);
  /** Water film over the asphalt away from the racing line (mm) */
  public waterMm = 0;
  /** Per sector: share of `waterMm` still on the racing line (0..1) */
  public readonly lineWater = new Float64Array(WEATHER_SECTORS);
  private readonly trackLengthM: number;

  constructor(trackLengthM: number, conditions: SessionConditions = DEFAULT_SESSION_CONDITIONS) {
    this.trackLengthM = Math.max(100, trackLengthM);
    this.conditions = { ...conditions };
    this.reset(conditions);
  }

  /** Back to the start of a session with `conditions` (or the current ones) */
  public reset(conditions: SessionConditions = this.conditions): void {
    this.conditions = sanitizeConditions(conditions);
    this.clockH = TIME_OF_DAY_HOURS[this.conditions.timeOfDay];
    this.weatherS = 0;
    const nodes = this.conditions.weatherNodes;
    if (nodes && nodes.length >= 2) {
      const w0 = interpolateWeatherNodes(nodes, 0, this.conditions.seed);
      this.skyCover = w0.sky;
      this.cloudCover = w0.cloud;
      this.rainIntensity = w0.rain;
      this.humidityPct = w0.humidityPct;
      this.windSpeedKmh = w0.windSpeedKmh;
      this.windDirectionDeg = w0.windDirectionDeg;
      this.windVxMs = w0.windVxMs;
      this.windVzMs = w0.windVzMs;
      this.waterMm = equilibriumWaterMm(w0.rain);
      this.lineWater.fill(1);
      this.ambientC = w0.ambientC;
      this.trackTempC = trackTargetTempC(this.clockH, this.cloudCover, this.rainIntensity, this.wetness);
    } else {
      const p = this.presetNow();
      this.cloudCover = p.cloud;
      this.rainIntensity = p.rain;
      this.waterMm = p.waterMm;
      this.lineWater.fill(p.lineWater);
      this.ambientC = ambientTempC(this.clockH, this.cloudCover, this.rainIntensity);
      this.trackTempC = trackTargetTempC(this.clockH, this.cloudCover, this.rainIntensity, this.wetness);
      const defNode = defaultWeatherNodesForPreset(this.conditions.weather, this.conditions.timeOfDay, this.conditions.seed)[0];
      this.skyCover = defNode.sky;
      this.humidityPct = defNode.humidityPct;
      this.windSpeedKmh = defNode.windSpeedKmh;
      this.windDirectionDeg = (defNode.windDirectionOctant % 8) * 45;
      this.windVxMs = (this.windSpeedKmh / 3.6) * Math.sin(this.windDirectionDeg * DEG);
      this.windVzMs = (this.windSpeedKmh / 3.6) * Math.cos(this.windDirectionDeg * DEG);
    }
    this.updateRainGrid3x3();
  }

  private presetNow(): PresetState {
    const c = this.conditions;
    if (c.weather !== 'dynamic') return PRESET_STATE[c.weather];
    const d = dynamicWeatherAt(c.seed, this.weatherS);
    // Start on the water the rain of the minutes before would have left
    return { cloud: d.cloud, rain: d.rain, waterMm: equilibriumWaterMm(d.rain), lineWater: 1 };
  }

  /** Updates the 3x3 spatial rain cell grid (`mRaining[3][3]`) advected by the wind vector */
  private updateRainGrid3x3(): void {
    const baseRain = this.rainIntensity;
    if (baseRain <= 0.001) {
      this.rainGrid3x3.fill(0);
      return;
    }
    const windSpeedMs = Math.max(1.5, Math.hypot(this.windVxMs, this.windVzMs));
    const ux = this.windVxMs / windSpeedMs;
    const uz = this.windVzMs / windSpeedMs;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const dx = (col - 1) * TRACK_WEATHER_NODE_SIZE_M;
        const dz = (row - 1) * TRACK_WEATHER_NODE_SIZE_M;
        // Phase lag along the wind direction so rain fronts sweep across the 3x3 grid
        const phaseLagS = (dx * ux + dz * uz) / windSpeedMs;
        const wave = 1 + 0.14 * Math.sin((this.weatherS - phaseLagS) * 0.015 + (row * 3 + col) * 0.7);
        this.rainGrid3x3[row * 3 + col] = Math.min(1, Math.max(0, baseRain * wave));
      }
    }
    // Center cell [1][1] is the reference circuit rain intensity
    this.rainGrid3x3[4] = baseRain;
  }

  /** Bilinearly samples the 3x3 spatial rain cell grid at world coordinates `(x, z)` */
  public rainAtWorldPos(x: number, z: number): number {
    if (this.rainIntensity <= 0) return 0;
    const gx = Math.min(2, Math.max(0, (x / TRACK_WEATHER_NODE_SIZE_M) + 1));
    const gz = Math.min(2, Math.max(0, (z / TRACK_WEATHER_NODE_SIZE_M) + 1));
    const c0 = Math.min(1, Math.floor(gx));
    const r0 = Math.min(1, Math.floor(gz));
    const tx = gx - c0;
    const tz = gz - r0;
    const g = this.rainGrid3x3;
    const top = g[r0 * 3 + c0] * (1 - tx) + g[r0 * 3 + c0 + 1] * tx;
    const bot = g[(r0 + 1) * 3 + c0] * (1 - tx) + g[(r0 + 1) * 3 + c0 + 1] * tx;
    return top * (1 - tz) + bot * tz;
  }

  /** How wet the road acts away from the line (0..1) (`OffpathWetness`) */
  get wetness(): number {
    return wetnessFromWater(this.waterMm);
  }

  /** Off-path wetness (0..1) away from the dried racing line */
  get offPathWetness(): number {
    return wetnessFromWater(this.waterMm);
  }

  /** Minimum racing-line wetness across all track sectors (0..1) (`mMinPathWetness`) */
  get minPathWetness(): number {
    if (!(this.waterMm > 0)) return 0;
    let minShare = 1;
    for (let i = 0; i < WEATHER_SECTORS; i++) {
      if (this.lineWater[i] < minShare) minShare = this.lineWater[i];
    }
    return wetnessFromWater(this.waterMm * minShare);
  }

  /** Average racing-line wetness across all track sectors (0..1) (`mAvgPathWetness`) */
  get avgPathWetness(): number {
    return wetnessFromWater(this.lineWaterMm);
  }

  /** Maximum racing-line wetness across all track sectors (0..1) (`mMaxPathWetness`) */
  get maxPathWetness(): number {
    if (!(this.waterMm > 0)) return 0;
    let maxShare = 0;
    for (let i = 0; i < WEATHER_SECTORS; i++) {
      if (this.lineWater[i] > maxShare) maxShare = this.lineWater[i];
    }
    return wetnessFromWater(this.waterMm * maxShare);
  }

  /** Mean water on the racing line (mm) */
  get lineWaterMm(): number {
    let sum = 0;
    for (let i = 0; i < WEATHER_SECTORS; i++) sum += this.lineWater[i];
    return (this.waterMm * sum) / WEATHER_SECTORS;
  }

  /** Sun position now */
  get sun(): { elevationDeg: number; azimuthDeg: number } {
    return sunPosition(this.clockH);
  }

  /** Advances the clock, the sky and the water by `dt` real seconds */
  public step(dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    const c = this.conditions;
    const scale = Math.max(1, c.timeScale);
    const dtW = dt * scale;
    this.weatherS += dtW;
    if (c.timeScale > 0) this.clockH = Math.min(CLOCK_MAX_H, Math.max(CLOCK_MIN_H, this.clockH + (dt * c.timeScale) / 3600));

    const nodes = c.weatherNodes;
    const hasCustomNodes = Boolean(nodes && nodes.length >= 2);
    if (hasCustomNodes && nodes) {
      const durationS = Math.max(300, c.weatherDurationS ?? DEFAULT_WEATHER_DURATION_S);
      const progress01 = Math.min(1, this.weatherS / durationS);
      const wNow = interpolateWeatherNodes(nodes, progress01, c.seed);
      this.skyCover = wNow.sky;
      this.cloudCover = wNow.cloud;
      this.rainIntensity = wNow.rain;
      this.humidityPct = wNow.humidityPct;
      this.windSpeedKmh = wNow.windSpeedKmh;
      this.windDirectionDeg = wNow.windDirectionDeg;
      this.windVxMs = wNow.windVxMs;
      this.windVzMs = wNow.windVzMs;
    } else if (c.weather === 'dynamic') {
      const d = dynamicWeatherAt(c.seed, this.weatherS);
      this.cloudCover = d.cloud;
      this.rainIntensity = d.rain;
    } else {
      const p = PRESET_STATE[c.weather];
      this.cloudCover = p.cloud;
      this.rainIntensity = p.rain;
    }
    this.updateRainGrid3x3();
    const rain = this.rainIntensity;

    // Water film: rain in, run-off and evaporation out (mm/h). Evaporation grows with track heat, sun, wind and dry air
    const rainIn = RAIN_RATE_MM_H * rain * rain;
    const h = this.waterMm;
    const drain = DRAIN_K * Math.pow(Math.max(0, h), DRAIN_EXP);
    const sunUp = Math.max(0, Math.sin(this.sun.elevationDeg * DEG));
    const humidityWindMult = hasCustomNodes
      ? (1.35 - 0.7 * (this.humidityPct / 100)) * (0.85 + 0.012 * this.windSpeedKmh)
      : 1;
    const evap =
      h > 0
        ? (0.25 + 0.025 * Math.max(0, this.trackTempC - 10) + 0.9 * sunUp * (1 - this.cloudCover)) *
          (1 - 0.8 * rain) *
          humidityWindMult
        : 0;
    this.waterMm = Math.max(0, h + ((rainIn - drain - evap) * dtW) / 3600);

    // Rain refills the racing line: a wet line is back to the wet track's depth within a minute or so of heavy rain
    if (rain > 0) {
      const refill = 1 - Math.exp(-0.04 * rain * dtW);
      for (let i = 0; i < WEATHER_SECTORS; i++) this.lineWater[i] += (1 - this.lineWater[i]) * refill;
    }
    // A bone-dry track has no line to speak of: reset it so the next shower starts uniform
    if (this.waterMm <= 0) this.lineWater.fill(1);

    if (hasCustomNodes && nodes) {
      const durationS = Math.max(300, c.weatherDurationS ?? DEFAULT_WEATHER_DURATION_S);
      const wNow = interpolateWeatherNodes(nodes, Math.min(1, this.weatherS / durationS), c.seed);
      this.ambientC = wNow.ambientC;
    } else {
      this.ambientC = ambientTempC(this.clockH, this.cloudCover, rain);
    }
    const target = trackTargetTempC(this.clockH, this.cloudCover, rain, this.wetness);
    this.trackTempC += (target - this.trackTempC) * (1 - Math.exp(-dtW / TRACK_TEMP_TAU_S));
  }

  private sectorIndex(sMeters: number): number {
    const u = (((sMeters / this.trackLengthM) % 1) + 1) % 1;
    return Math.min(WEATHER_SECTORS - 1, Math.floor(u * WEATHER_SECTORS));
  }

  /** A car rolling at `speedMs`, `distFromLineM` off the racing line, squeezes water off it */
  public depositCarPass(sMeters: number, distFromLineM: number, speedMs: number, dt: number): void {
    if (!(this.waterMm > 0) || ![sMeters, distFromLineM, speedMs, dt].every(Number.isFinite) || dt <= 0) return;
    if (Math.abs(distFromLineM) > LINE_HALF_WIDTH_M || speedMs < 5) return;
    const sectorM = this.trackLengthM / WEATHER_SECTORS;
    // One pass over the sector lasts sectorM / v: clear LINE_CLEAR_PER_PASS of the water over it
    const i = this.sectorIndex(sMeters);
    this.lineWater[i] *= Math.exp((-LINE_CLEAR_PER_PASS * Math.min(speedMs, 80) * dt) / sectorM);
  }

  /** Water film (mm) at `(sMeters, lateralOffsetM)` given the racing line's offset there */
  public waterAt(sMeters: number, lateralOffsetM: number, racingLineLatM: number): number {
    if (!(this.waterMm > 0)) return 0;
    if (![sMeters, lateralOffsetM, racingLineLatM].every(Number.isFinite)) return this.waterMm;
    const d = lateralOffsetM - racingLineLatM;
    const onLine = Math.exp(-(d * d) / (2 * LINE_SIGMA_M * LINE_SIGMA_M));
    const line = this.lineWater[this.sectorIndex(sMeters)];
    return this.waterMm * (1 - onLine * (1 - line));
  }

  /**
   * Topographical water film depth (mm) at `(sMeters, lateralOffsetM)` accounting for camber/banking cross-fall
   * drainage, longitudinal grade run-off, flat compression basin puddles, and kerb-edge gutter pooling.
   */
  public waterAtTopography(
    sMeters: number,
    lateralOffsetM: number,
    racingLineLatM: number,
    bankingDeg = 0,
    slopePercent = 0,
    halfWidthM = 7.5
  ): number {
    const baseMm = this.waterAt(sMeters, lateralOffsetM, racingLineLatM);
    if (!(baseMm > 0)) return 0;
    return baseMm * topographicalPuddleFactor(sMeters, lateralOffsetM, bankingDeg, slopePercent, halfWidthM);
  }

  public snapshot(): WeatherSyncState {
    return {
      conditions: { ...this.conditions },
      clockH: this.clockH,
      weatherS: this.weatherS,
      cloud: this.cloudCover,
      rain: this.rainIntensity,
      waterMm: this.waterMm,
      trackTempC: this.trackTempC,
    };
  }

  /**
   * Takes the host's weather. A change of conditions restarts from the host's state; otherwise the local state is
   * eased toward it, so a guest's sky and water never jump between the 3 s lobby updates.
   */
  public applySync(s: WeatherSyncState): void {
    const c = sanitizeConditions(s.conditions);
    const same =
      c.weather === this.conditions.weather &&
      c.timeOfDay === this.conditions.timeOfDay &&
      c.timeScale === this.conditions.timeScale &&
      c.seed === this.conditions.seed;
    if (!same) this.reset(c);
    const k = same ? 0.5 : 1;
    this.clockH += (s.clockH - this.clockH) * k;
    this.weatherS += (s.weatherS - this.weatherS) * k;
    this.cloudCover += (s.cloud - this.cloudCover) * k;
    this.rainIntensity += (s.rain - this.rainIntensity) * k;
    this.waterMm += (s.waterMm - this.waterMm) * k;
    this.trackTempC += (s.trackTempC - this.trackTempC) * k;
  }
}

/** Water depth (mm) steady rain of intensity `rain` stands at (run-off = rain in) */
export function equilibriumWaterMm(rain: number): number {
  const rainIn = RAIN_RATE_MM_H * rain * rain;
  return rainIn > 0 ? Math.pow(rainIn / DRAIN_K, 1 / DRAIN_EXP) : 0;
}

/**
 * Topographical puddle & drainage multiplier (0.55..1.55) at `(sMeters, lateralOffsetM)`:
 * - Cambered/banked corners shed water from the high side toward the low inside gutter.
 * - Steep longitudinal climbs/descents drain faster, while flat compression basins and kerb gutters pool standing water.
 */
export function topographicalPuddleFactor(
  sMeters: number,
  lateralOffsetM: number,
  bankingDeg = 0,
  slopePercent = 0,
  halfWidthM = 7.5
): number {
  const hw = Math.max(3.5, Number.isFinite(halfWidthM) ? halfWidthM : 7.5);
  const latNorm = Math.max(-1.2, Math.min(1.2, lateralOffsetM / hw));
  const bankStrength = Math.min(1, Math.abs(bankingDeg) / 6);
  // High side of banking drains, low side collects cross-fall run-off
  const bankSign = bankingDeg >= 0 ? 1 : -1;
  const crossFall = 1 - 0.16 * bankStrength + 0.22 * bankStrength * Math.max(-0.8, Math.min(1, latNorm * bankSign));
  // Steep longitudinal slopes shed water; flat basins (< 1.2% grade) retain puddles
  const absSlope = Math.abs(slopePercent);
  const gradeDrain = absSlope > 2.2 ? 1 - 0.18 * Math.min(1, (absSlope - 2.2) / 10) : 1 + 0.12 * (1 - absSlope / 2.2);
  // Kerb-edge gutters and deterministic asphalt crown depressions
  const edgeFrac = Math.max(0, (Math.abs(latNorm) - 0.68) / 0.32);
  const gutterPool = 0.26 * edgeFrac * edgeFrac;
  const basinWave =
    absSlope < 2.5
      ? 0.18 *
        (1 - absSlope / 2.5) *
        Math.max(0, Math.sin(sMeters * 0.037 + 1.1) * Math.cos(lateralOffsetM * 0.55))
      : 0;
  return Math.min(1.55, Math.max(0.55, crossFall * gradeDrain + gutterPool + basinWave));
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function sanitizeWeatherNode(v: unknown): WeatherNode | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const sky = SKY_COVER_IDS.includes(o.sky as SkyCoverId) ? (o.sky as SkyCoverId) : 'clear';
  const spec = SKY_COVER_SPECS[sky];
  return {
    sky,
    rainChance: isNum(o.rainChance) ? Math.min(100, Math.max(0, Math.round(o.rainChance))) : spec.defaultRainChance,
    temperatureC: isNum(o.temperatureC) ? Math.min(50, Math.max(-5, o.temperatureC)) : GOLDEN_AMBIENT_C,
    humidityPct: isNum(o.humidityPct) ? Math.min(100, Math.max(0, Math.round(o.humidityPct))) : spec.defaultHumidityPct,
    windSpeedKmh: isNum(o.windSpeedKmh) ? Math.min(100, Math.max(0, o.windSpeedKmh)) : 10,
    windDirectionOctant: (isNum(o.windDirectionOctant)
      ? (((Math.round(o.windDirectionOctant) % 8) + 8) % 8)
      : 2) as WindDirectionOctant,
  };
}

/** Validated conditions (unknown values take the defaults): for saves and network input */
export function sanitizeConditions(v: unknown): SessionConditions {
  const d = DEFAULT_SESSION_CONDITIONS;
  if (!v || typeof v !== 'object') return { ...d };
  const o = v as Record<string, unknown>;
  const out: SessionConditions = {
    weather: WEATHER_PRESETS.includes(o.weather as WeatherPresetId) ? (o.weather as WeatherPresetId) : d.weather,
    timeOfDay: TIME_OF_DAY_PRESETS.includes(o.timeOfDay as TimeOfDayId) ? (o.timeOfDay as TimeOfDayId) : d.timeOfDay,
    timeScale: isNum(o.timeScale) ? Math.min(120, Math.max(0, o.timeScale)) : d.timeScale,
    seed: isNum(o.seed) ? Math.round(Math.min(1e6, Math.max(0, o.seed))) : d.seed,
  };
  if (Array.isArray(o.weatherNodes) && o.weatherNodes.length >= 2 && o.weatherNodes.length <= 8) {
    const clean = o.weatherNodes.map(sanitizeWeatherNode).filter((n): n is WeatherNode => n !== null);
    if (clean.length >= 2) out.weatherNodes = clean;
  }
  if (isNum(o.weatherDurationS)) {
    out.weatherDurationS = Math.min(86400, Math.max(300, o.weatherDurationS));
  }
  if (SURFACE_GRIP_PRESETS.includes(o.surfacePreset as SurfaceGripPresetId)) {
    out.surfacePreset = o.surfacePreset as SurfaceGripPresetId;
  }
  if (isNum(o.surfaceTimeScale) && SURFACE_TIME_SCALES.includes(o.surfaceTimeScale)) {
    out.surfaceTimeScale = o.surfaceTimeScale;
  }
  return out;
}

/** Validated weather snapshot from the network; null when it is not one */
export function sanitizeWeatherSync(v: unknown): WeatherSyncState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (![o.clockH, o.weatherS, o.cloud, o.rain, o.waterMm, o.trackTempC].every(isNum)) return null;
  const clamp = (x: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, x as number));
  return {
    conditions: sanitizeConditions(o.conditions),
    clockH: clamp(o.clockH, 0, 24),
    weatherS: clamp(o.weatherS, 0, 1e7),
    cloud: clamp(o.cloud, 0, 1),
    rain: clamp(o.rain, 0, 1),
    waterMm: clamp(o.waterMm, 0, 10),
    trackTempC: clamp(o.trackTempC, -20, 80),
  };
}

/** What a car needs from the weather at its position */
export interface WeatherContactSample {
  /** Water film under the car (mm) */
  waterMm: number;
  /** Per-wheel water film depth [FR, FL, RR, RL] (mm) including topographical puddles & gutters */
  wheelWaterMm?: [number, number, number, number];
  /** How wet the road acts there (0..1) */
  wetness: number;
  /** Air temperature (°C) */
  ambientC: number;
  /** Rain intensity (0..1) */
  rain: number;
  /** Relative humidity (0..100 %) */
  humidityPct?: number;
  /** Wind velocity components in world XZ (m/s) */
  windVxMs?: number;
  windVzMs?: number;
  /** Airborne rooster-tail water spray intensity from leading cars ahead (0..1) */
  sprayIntensity?: number;
}

export const DRY_WEATHER_SAMPLE: Readonly<WeatherContactSample> = {
  waterMm: 0,
  wetness: 0,
  ambientC: GOLDEN_AMBIENT_C,
  rain: 0,
  humidityPct: 45,
  windVxMs: 0,
  windVzMs: 0,
};
