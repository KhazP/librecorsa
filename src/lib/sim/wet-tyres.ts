/**
 * How a tyre copes with water on the road, shared by every tyre model (the VF26's `ac-tyre.ts` and the f12026-car /
 * GT3 `VehiclePhysics.ts`). Re-implemented from the general behaviour of wet racing tyres (Speed Dreams gives its
 * Wet / Extreme-wet compounds a water-clearing capacity; AC gives intermediates and wets their own grip and thermal
 * curves), not from any code:
 *
 *  - A water film lubricates the contact: every tyre loses grip as the road gets wet, a slick most (`wetGrip`).
 *  - Standing water has to be pushed out of the contact patch. The tread clears up to `clearMm` of it at 200 km/h,
 *    more at low speed (the patch has longer to drain). Beyond that the tyre rides up on the water and aquaplanes.
 *  - Treaded tyres are built softer for a cold, wet track: their peak grip in the dry is lower (`dryGrip`, baked into
 *    the compound's grip tables), their working window is lower (`tempShiftC`), and on a dry track the tread blocks
 *    squirm, overheat (`dryHeatScale`) and wear quickly (`dryWearScale`).
 */
import type { TireCompound } from '@/types/f1';

export interface WetTyreTraits {
  /** Peak grip in the dry relative to the slick the compound is derived from (already in the grip tables) */
  dryGrip: number;
  /** Grip kept on a fully wet road (a film, no standing water), relative to its own dry grip */
  wetGrip: number;
  /** Water depth the tread clears at 200 km/h (mm) */
  clearMm: number;
  /** Initial tread groove depth when new (mm; 0 for slicks) */
  treadDepthMm?: number;
  /** Working-window shift relative to the slick (°C, negative = cooler) */
  tempShiftC: number;
  /** Tread wear and heat generation multipliers on a dry road (they ease to 1 as the road gets wet) */
  dryWearScale: number;
  dryHeatScale: number;
  /** Wear multiplier on a fully wet road (water cools and lubricates the tread) */
  wetWearScale: number;
}

/** Slicks: a smooth tread that only squeezes a thin film out of the patch */
export const SLICK_TRAITS: WetTyreTraits = {
  dryGrip: 1,
  wetGrip: 0.54,
  clearMm: 0.42,
  treadDepthMm: 0,
  tempShiftC: 0,
  dryWearScale: 1,
  dryHeatScale: 1,
  wetWearScale: 0.5,
};

export const WET_TYRE_TRAITS: Record<TireCompound, WetTyreTraits> = {
  soft: SLICK_TRAITS,
  medium: SLICK_TRAITS,
  hard: SLICK_TRAITS,
  // Intermediate: shallow grooves, high-silica compound for a damp or lightly wet track
  intermediate: {
    dryGrip: 0.91,
    wetGrip: 0.89,
    clearMm: 1.3,
    treadDepthMm: 2.5,
    tempShiftC: -30,
    dryWearScale: 3,
    dryHeatScale: 1.35,
    wetWearScale: 1,
  },
  // Full wet (extreme wet): deep grooves and soft silica tread that clear standing water
  wet: {
    dryGrip: 0.84,
    wetGrip: 0.93,
    clearMm: 3.1,
    treadDepthMm: 5.5,
    tempShiftC: -42,
    dryWearScale: 4,
    dryHeatScale: 1.5,
    wetWearScale: 1,
  },
};

export const isWetCompound = (c: TireCompound): boolean => c === 'intermediate' || c === 'wet';

/** Water film depth (mm) at which the road counts as damp, wet and flooded, for labels */
export const DAMP_MM = 0.08;
export const WET_MM = 0.5;
export const STANDING_WATER_MM = 1.5;

/** Wetness threshold above which the polished rubbered-in racing line turns slicker than off-line asphalt */
export const GROOVE_WET_TRANSITION_FACTOR = 0.18;

/** Wetness threshold above which rear flap / active low-drag aero (DRS) is locked out for safety */
export const REAR_FLAP_WET_THRESHOLD = 0.25;

/** Whether active low-drag rear flap (DRS / X-mode) is permitted at the current track wetness (0..1) */
export function isRearFlapAllowedInWet(wetness: number): boolean {
  return !(wetness >= REAR_FLAP_WET_THRESHOLD);
}

/** How wet the surface acts (0 dry … 1 fully wet) for a water film of `waterMm` */
export function wetnessFromWater(waterMm: number): number {
  if (!(waterMm > 0)) return 0;
  return 1 - Math.exp(-waterMm / 0.4);
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Speed at which `clearMm` is quoted (m/s, 200 km/h) */
const CLEAR_REF_MS = 55.6;

/**
 * Thin-film boundary dampness lubrication factor (1 = dry, < 1 = damp micro-asperity film loss)
 * before bulk standing-water hydroplaning begins.
 */
export function dampnessGripEffect(traits: WetTyreTraits, waterMm: number): number {
  if (!(waterMm > 0)) return 1;
  const damp = 1 - Math.exp(-waterMm / DAMP_MM);
  const maxDampLoss = (1 - traits.wetGrip) * 0.22;
  return 1 - maxDampLoss * damp;
}

/** Remaining tread groove depth (mm) for a tyre with normalized `wear` (0 = new, 1 = worn to cords) */
export function remainingTreadDepthMm(traits: WetTyreTraits, wear = 0): number {
  const base = traits.treadDepthMm ?? 0;
  if (base <= 0) return 0;
  const w = Math.min(1, Math.max(0, Number.isFinite(wear) ? wear : 0));
  return base * (1 - 0.85 * w);
}

/** Share of its own (water-free) grip a tyre keeps that is aquaplaning on `waterMm` at `speedMs` (1 = none) */
export function aquaplaneFactor(traits: WetTyreTraits, waterMm: number, speedMs: number, wear = 0): number {
  if (!(waterMm > 0)) return 1;
  const w = Math.min(1, Math.max(0, Number.isFinite(wear) ? wear : 0));
  // Worn tread grooves lose up to 55 % of their standing-water evacuation capacity
  const wearClearScale = (traits.treadDepthMm ?? 0) > 0 ? 1 - 0.55 * w : 1 - 0.2 * w;
  const capacity = Math.max(0.15, traits.clearMm * wearClearScale) * Math.pow(CLEAR_REF_MS / Math.max(12, Math.abs(speedMs)), 0.7);
  const excess = waterMm / capacity;
  return 1 - 0.8 * smoothstep(0.7, 1.8, excess);
}

/**
 * Grip multiplier for water on the road: boundary dampness lubrication + water film + aquaplaning, relative to the
 * tyre's own dry grip. `severity` scales the whole effect (the realism setting; 1 = full).
 */
export function wetGripFactor(traits: WetTyreTraits, waterMm: number, speedMs: number, severity = 1, wear = 0): number {
  if (!(waterMm > 0) || !(severity > 0)) return 1;
  const wet = wetnessFromWater(waterMm);
  const film = 1 - (1 - traits.wetGrip) * wet;
  // Un-grooved slicks suffer an extra micro-asperity boundary lubrication loss once water exceeds a damp film
  const slickBoundaryLoss = (traits.treadDepthMm ?? 0) === 0 ? 1 - 0.14 * smoothstep(DAMP_MM, WET_MM, waterMm) : 1;
  const full = film * slickBoundaryLoss * aquaplaneFactor(traits, waterMm, speedMs, wear);
  return 1 - (1 - full) * Math.min(1, severity);
}

/**
 * Pneumatic trail multiplier under wet / hydroplaning conditions (0.25..1.0):
 * A hydrodynamic water wedge builds at the leading edge of the contact patch first, shifting the lateral force
 * centroid forward toward the wheel axis and lightening steering self-aligning torque (FFB) before full aquaplaning.
 */
export function wetPneumaticTrailScale(traits: WetTyreTraits, waterMm: number, speedMs: number, wear = 0): number {
  if (!(waterMm > 0)) return 1;
  const aqua = aquaplaneFactor(traits, waterMm, speedMs, wear);
  const filmShift = 1 - 0.12 * wetnessFromWater(waterMm) * ((traits.treadDepthMm ?? 0) === 0 ? 1 : 0.45);
  return Math.max(0.25, filmShift * (0.3 + 0.7 * aqua));
}

/**
 * Hydrodynamic water-displacement drag force (N) on a tyre rolling through standing water (`waterMm > 0.6 mm`):
 * `F_hydro = 0.5 * rho_water * C_d * width * h_eff * v^2`. When one side of the car hits a deeper puddle or gutter,
 * the asymmetric drag pulls the steering and yaws the car toward the flooded side.
 */
export function hydrodynamicDragN(waterMm: number, speedMs: number, tyreWidthM: number, fzN: number): number {
  if (!(waterMm > 0.6) || !(speedMs > 1) || !(fzN > 10)) return 0;
  const hEffM = Math.min(0.0045, (waterMm - 0.6) * 0.001);
  const v = Math.min(95, Math.abs(speedMs));
  const rawDragN = 0.5 * 1000 * 0.16 * Math.max(0.2, tyreWidthM) * hEffM * v * v;
  return Math.min(0.14 * fzN, rawDragN);
}

/**
 * Evaluates instantaneous contact-patch micro-asperity flash heating (`flashDeltaC`) and Williams-Landel-Ferry (WLF)
 * viscoelastic rubber master-curve friction (`viscoelasticMult`).
 *
 * - Flash temperature rises at sliding micro-asperity tips proportional to contact pressure × √(sliding speed),
 *   and is quenched by surface water (`1 - 0.62 * wetness`).
 * - WLF shift factor `log10(a_T) = -C1 * (T_eff - T_ref) / (C2 + (T_eff - T_ref))` shifts the rubber's glass-transition
 *   viscoelastic peak: silica-rich wet compounds (`tempShiftC < 0`) stay compliant at low wet temperatures where
 *   carbon-black dry slicks stiffen into their glassy regime.
 */
export function evaluateFlashTempAndWlfGrip(
  traits: WetTyreTraits,
  surfaceTempC: number,
  slipSpeedMs: number,
  fzN: number,
  wetness: number
): { flashDeltaC: number; viscoelasticMult: number } {
  const w = Math.min(1, Math.max(0, Number.isFinite(wetness) ? wetness : 0));
  const vs = Math.max(0, Number.isFinite(slipSpeedMs) ? slipSpeedMs : 0);
  const loadNorm = Math.min(2.2, Math.max(0, (Number.isFinite(fzN) ? fzN : 0) / 3800));
  // Water film quenches micro-asperity flash heating
  const quench = 1 - 0.62 * w;
  const flashDeltaC = Math.min(24, 3.2 * loadNorm * Math.sqrt(Math.min(25, vs)) * quench);
  const tEff = surfaceTempC + 0.35 * flashDeltaC;
  const tRef = 92 + traits.tempShiftC;
  const dT = Math.max(-75, Math.min(80, tEff - tRef));
  // WLF constants (C1 = 8.86, C2 = 101.6 K) mapped to reduced frequency log10(a_T * v_s)
  const logAt = (-8.86 * dT) / (101.6 + dT);
  const logFreq = logAt + Math.log10(Math.max(0.08, vs));
  // Master bell curve around optimal viscoelastic excitation frequency (logFreq0 ≈ -0.35)
  const dev = logFreq - -0.35;
  const wlfRaw = Math.exp(-0.028 * dev * dev);
  // Blended in with the water only: on a dry road the thermal grip curve already prices a cold tyre, and the
  // calibrated dry tests stay exact
  const activeBlend = Math.min(1, w * 0.85);
  const viscoelasticMult = 1 + (wlfRaw * (1 + 0.035 * (flashDeltaC / 12)) - 1) * activeBlend;
  return {
    flashDeltaC,
    viscoelasticMult: Math.min(1.05, Math.max(0.84, viscoelasticMult)),
  };
}

/**
 * 2D bristle/brush contact-patch relaxation length multiplier (`dynamicBristleRelaxationScale`):
 * Contact patch half-length grows with vertical load (`(Fz / Fz0)^0.18`), lengthening bristle relaxation at high load,
 * while water lubrication shortens the adhesive zone of the brush footprint (`1 - 0.14 * wetness`).
 */
export function dynamicBristleRelaxationScale(fzN: number, fzRefN: number, wetness: number): number {
  const w = Math.min(1, Math.max(0, Number.isFinite(wetness) ? wetness : 0));
  if (!(w > 0)) return 1;
  const loadRatio = Math.min(2.5, Math.max(0.35, fzN / Math.max(500, fzRefN)));
  const footprintStretch = Math.pow(loadRatio, 0.16);
  const wetAdhesiveShortening = 1 - 0.14 * w;
  return Math.min(1.22, Math.max(0.76, footprintStretch * wetAdhesiveShortening));
}

/**
 * Wet groove grip modifier (`grooveWetEffects` + `grooveWetSqrdEffects` gated by `GROOVE_WET_TRANSITION_FACTOR`):
 * Polished rubber laid on the dry racing line seals asphalt pores and becomes slicker than unrubbered off-line
 * tarmac once surface wetness passes the transition threshold, rewarding off-line "wet line" driving.
 */
export function wetGrooveGripEffect(
  rubberLevel: number,
  wetness: number,
  onLineWeight: number,
  severity = 1
): number {
  if (!(wetness > GROOVE_WET_TRANSITION_FACTOR) || !(rubberLevel > 0) || !(onLineWeight > 0) || !(severity > 0)) {
    return 0;
  }
  const r = Math.min(1, Math.max(0, rubberLevel));
  const w = Math.min(1, Math.max(0, wetness));
  const transition = smoothstep(GROOVE_WET_TRANSITION_FACTOR, 0.65, w);
  const linearLoss = -0.055 * r;
  const sqrdLoss = -0.03 * r * r;
  return (linearLoss + sqrdLoss) * transition * Math.min(1, Math.max(0, onLineWeight)) * Math.min(1, severity);
}

/** Surface multiplier at `wetness`: painted kerbs and grass get slicker than the asphalt in the same water */
export function surfaceWetMultiplier(wetFriction: number, wetness: number, severity = 1): number {
  const w = Math.min(1, Math.max(0, wetness * Math.min(1, severity)));
  return 1 + (wetFriction - 1) * w;
}

/** Tread wear multiplier for the compound at `wetness` */
export function wetWearScale(traits: WetTyreTraits, wetness: number): number {
  const w = Math.min(1, Math.max(0, wetness));
  return traits.dryWearScale + (traits.wetWearScale - traits.dryWearScale) * w;
}

/** Heat generation multiplier for the compound at `wetness` */
export function wetHeatScale(traits: WetTyreTraits, wetness: number): number {
  const w = Math.min(1, Math.max(0, wetness));
  return traits.dryHeatScale + (1 - traits.dryHeatScale) * w;
}

/**
 * Extra cooling of a rolling tread by the water on the road (W/K per contact patch): the film carries heat away and
 * spray soaks the tyre. Modest: a slick on a wet road still drops well out of its window, as it should.
 */
export function wetRoadCoolingWK(wetness: number, speedMs: number): number {
  const w = Math.min(1, Math.max(0, wetness));
  return w * (20 + 1.6 * Math.abs(speedMs));
}

/**
 * Convective spray & wet external air cooling on the tyre carcass/sidewall (W/K).
 */
export function wetExternalGasCoolingWK(wetness: number, speedMs: number): number {
  const w = Math.min(1, Math.max(0, wetness));
  const transition = smoothstep(0.05, 0.45, w);
  return transition * (2.5 + 0.18 * Math.abs(speedMs));
}

/**
 * Wet environment heat transfer on the wheel rim (W/K): water spray cools the alloy rim, which conducts
 * out of the internal inflation gas and reduces hot tyre pressure in wet conditions.
 */
export function rimWetEnvironmentCoolingWK(wetness: number, speedMs: number): number {
  const w = Math.min(1, Math.max(0, wetness));
  const transition = smoothstep(0.08, 0.5, w);
  return transition * (0.45 + 0.035 * Math.abs(speedMs));
}

/** Intermediates and full wets (the rest are slicks) */
export function isRainCompound(c: TireCompound): boolean {
  return c === 'intermediate' || c === 'wet';
}

/** The compound to fit for a water film of `waterMm` on the racing line (AI tyre choice) */
export function recommendedCompound(waterMm: number, dryChoice: TireCompound = 'medium'): TireCompound {
  if (waterMm > 1.1) return 'wet';
  if (waterMm > 0.14) return 'intermediate';
  return dryChoice;
}
