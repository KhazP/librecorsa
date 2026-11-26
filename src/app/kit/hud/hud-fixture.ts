import { F1Physics2026 } from "@/lib/f1-physics-2026";
import { TURN_METADATA, type BuiltTrackData } from "@/lib/track-data";
import type { CarTelemetry, F12026Channels, PitTelemetry, RaceStandingEntry, TireCompound } from "@/types/f1";
import type { WeatherHudState } from "@/components/hud/WeatherBadge";

/**
 * A still moment of a session for the HUD test page (/kit/hud): every layout drawn from the same numbers, so they
 * compare like for like and a change shows in a screenshot without driving the game. Development only.
 *
 * - race: lap 4 of 5, P3 of 8, 0.466 s behind the car ahead, 0.214 s up on the best lap, rear right tyre hot
 * - practice: the same car and lap alone, no race
 * - gt3: the race in a GT3 (no ERS, no aero flaps)
 * - lights: the race on the grid, the lights coming on
 * - final: the race on its last lap, lap 5 of 5, the leader and the player on it
 *
 * Every race has pit stops (one required, none made, the medium tyres chosen for the stop, the car 6 % damaged), as an
 * offline race with a pit lane does: the MFD shows its Pit page.
 */
export type HudScenario = "race" | "practice" | "gt3" | "lights" | "final";
export const HUD_SCENARIOS: readonly HudScenario[] = ["race", "practice", "gt3", "lights", "final"];

export interface HudFixture {
  t: CarTelemetry;
  /** Live delta to the best lap (s, − = faster) */
  deltaS: number | null;
  compound: TireCompound;
  /** The weather readings the HUD gets beside the telemetry: dry, late afternoon, a light breeze */
  weather: WeatherHudState;
}

const WEATHER: WeatherHudState = {
  airC: 27,
  trackC: 41,
  waterMm: 0,
  rain: 0,
  clockH: 17.6,
  timeMoving: false,
  humidityPct: 48,
  windSpeedMs: 2.2,
  windDirection: "E",
  headlightsOn: false,
  headlightMode: "auto",
  headlightsAutoOn: false,
};

const FIELD: { code: string; name: string; color: string; gap: number; interval: number; best: number; last: number; compound: TireCompound; penaltyS?: number }[] = [
  { code: "KIG", name: "A. Kagabo", color: "#FF8A1F", gap: 0, interval: 0, best: 101_120, last: 101_512, compound: "soft" },
  { code: "MUS", name: "L. Musoni", color: "#FF2A3C", gap: 1.204, interval: 1.204, best: 101_402, last: 101_650, compound: "soft" },
  { code: "YOU", name: "You", color: "#CCFF00", gap: 1.67, interval: 0.466, best: 101_377, last: 101_902, compound: "soft" },
  { code: "RUB", name: "T. Rubin", color: "#4DA6FF", gap: 2.141, interval: 0.471, best: 101_640, last: 101_871, compound: "soft" },
  { code: "NYA", name: "S. Nyandwi", color: "#00E5FF", gap: 4.91, interval: 2.769, best: 102_010, last: 102_330, compound: "medium" },
  { code: "GIS", name: "D. Gisa", color: "#00E676", gap: 6.102, interval: 1.192, best: 102_204, last: 102_518, compound: "medium" },
  { code: "KAR", name: "P. Karera", color: "#FF6B8A", gap: 9.83, interval: 3.728, best: 102_480, last: 102_744, compound: "soft", penaltyS: 5 },
  { code: "HUY", name: "J. Huynh", color: "#C5CBD8", gap: 13.214, interval: 3.384, best: 102_790, last: 103_020, compound: "soft" },
];

/** The pit lane's state in a race: on the track, nothing called yet */
const PIT: PitTelemetry = {
  phase: "track",
  limiterOn: false,
  limiterAuto: false,
  limitKmh: 80,
  overLimit: false,
  speedingCount: 0,
  toBoxM: null,
  boxSideM: null,
  boxIndex: 3,
  serviceLeftS: 0,
  serviceTotalS: 0,
  tyreS: 0,
  repairS: 2.3,
  damage: 0.06,
  strategy: { nextCompound: "medium", repairDamage: true, boxRequested: false },
  stopsMade: 0,
  stopsRequired: 1,
};

const GT3_CHANNELS: F12026Channels = {
  WHEEL_SR_LF: 0, WHEEL_SR_RF: 0, WHEEL_SR_LR: 0, WHEEL_SR_RR: 0,
  BUMPSTOPUP_TRAVEL_LF: 0, BUMPSTOPUP_TRAVEL_RF: 0, BUMPSTOPUP_TRAVEL_LR: 0, BUMPSTOPUP_TRAVEL_RR: 0,
  AERO_HEIGHT: 0, AERO_BALANCE: 0, LSD_LOCKING_TORQUE: 0,
  CHANGED_DRS_OPEN: false, drsOpenEvents: 0, drsZone: false, drsAvailable: false, drsQueued: false,
  drsDetection: null, straightModeAhead: null, overtakeDetection: null,
  circleFraction: [0.4, 0.5, 0.3, 0.6], performanceMode: "race",
  carId: "amg-gt3", hasErs: false, hasDrs: false, tcActive: false, absActive: false,
  wallContact: false, wallContactS: 0, wallImpact: null,
};

export function hudFixture(track: BuiltTrackData, scenario: HudScenario): HudFixture {
  const base = new F1Physics2026(track).telemetry;
  const gt3 = scenario === "gt3";
  const lights = scenario === "lights";
  const lap = lights ? 0 : scenario === "final" ? 5 : 4;
  // 72.4 s into a 101.4 s lap: about 0.7 round, in the last sector
  const progress = lights ? 0.995 : 0.7;
  const t: CarTelemetry = {
    ...base,
    speedKmh: lights ? 0 : gt3 ? 236 : 274,
    speedMs: lights ? 0 : (gt3 ? 236 : 274) / 3.6,
    rpm: lights ? 4200 : gt3 ? 7120 : 11_480,
    gear: lights ? 1 : gt3 ? 5 : 7,
    throttle: lights ? 0.2 : 1,
    brake: 0,
    clutch: 1,
    steering: 0.12,
    longitudinalG: 0.4,
    lateralG: 1.6,
    ersBatteryPercent: 44,
    // The lap's energy left under the 2026 rules: 5.1 of the lap's 8.5 MJ recharged by here (none on the grid), and the
    // store's 44 % of 4 MJ to deploy
    ersRechargeLeftJ: gt3 ? undefined : lights ? 8_500_000 : 3_400_000,
    ersRechargeLimitJ: gt3 ? undefined : 8_500_000,
    ersDeployLeftJ: gt3 ? undefined : 1_760_000,
    mgukPowerKw: 180,
    fuelKg: 18.4,
    trackProgress: progress,
    trackDistanceM: progress * track.totalLengthM,
    currentSector: 3,
    currentTurnNumber: 7,
    // The corner's own name, as the track gives it (else the start pose's would show under turn 7)
    currentTurnName: TURN_METADATA.find((c) => c.number === 7)?.name ?? "",
    lapCount: lap,
    currentLapTimeMs: lights ? 0 : 72_408,
    lastLapTimeMs: lights ? null : 101_902,
    bestLapTimeMs: lights ? null : 101_377,
    sectorTimesMs: lights ? [0, 0, 0] : [31_204, 34_870, 6_334],
    bestSectorTimesMs: lights ? [null, null, null] : [31_316, 34_972, 35_089],
    topSpeedThisLapKmh: 296,
    allTimeTopSpeedKmh: 301,
    tireTempsC: [96, 98, 104, 112],
    tireBandTempsC: [[94, 96, 98], [99, 98, 97], [101, 104, 107], [115, 112, 108]],
    tirePressuresPsi: [23.1, 23.3, 21.8, 22.0],
    tireOptimalPsi: [23.0, 23.0, 21.0, 21.0],
    tireOptimalTempC: [85, 105],
    tireWearPct: [12, 14, 18, 21],
    brakeTempsC: [540, 552, 410, 418],
    tireGripFactor: [1, 1, 0.98, 0.93],
    lapInvalid: false,
    outLap: false,
    radar: lights ? [] : [{ x: 2.4, z: -1.8, yaw: 0, color: "#4DA6FF" }],
    trackLimits: { warnings: 1, strikesPerPenalty: 3, totalStrikes: 1, penaltyS: 0, pending: null, message: null },
    f12026: gt3 ? GT3_CHANNELS : base.f12026,
    liveTuner: base.liveTuner
      ? { ...base.liveTuner, tcLevel: 5, absLevel: 3, brakeBiasPct: 56.5, engineMap: 2, ersMode: "BAL", hasErs: !gt3 }
      : base.liveTuner,
  };
  if (scenario !== "practice") {
    const standings: RaceStandingEntry[] = FIELD.map((f, i) => ({
      driverCode: f.code,
      name: f.name,
      teamColorHex: f.color,
      isPlayer: f.code === "YOU",
      lap,
      gapToLeaderS: lights ? 0 : f.gap,
      intervalS: lights ? 0 : f.interval,
      bestLapMs: lights ? null : f.best,
      lastLapMs: lights ? null : f.last,
      // Spaced on the road by their gaps at about 75 m/s (on the grid, a car length and a half apart)
      trackS: (progress * track.totalLengthM - (lights ? i * 8 : (f.gap - 1.67) * 75) + track.totalLengthM) % track.totalLengthM,
      compound: f.compound,
      penaltyS: f.penaltyS,
    }));
    t.race = {
      phase: lights ? "lights" : "racing",
      lightsOn: lights ? 3 : 0,
      totalLaps: 5,
      position: 3,
      fieldSize: 8,
      lap,
      standings,
      splits: lights
        ? undefined
        : {
            ahead: { driverCode: "MUS", teamColorHex: "#FF2A3C", gapS: 0.466, changeS: -0.08 },
            behind: { driverCode: "RUB", teamColorHex: "#4DA6FF", gapS: 0.471, changeS: 0.03 },
          },
    };
    t.pit = PIT;
  }
  return { t, deltaS: lights ? null : -0.214, compound: "soft", weather: WEATHER };
}
