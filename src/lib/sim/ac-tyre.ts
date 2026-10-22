/**
 * Tyre model driven by the VF26 `.tyre` data.
 *
 * - Slip curve:                Pacejka Magic Formula F = D·sin(C·atan(Bx − E(Bx − atan Bx))) on the
 *                              normalised slip x. B, C, E are fitted per compound so the curve keeps the
 *                              mod's cornering stiffness, peaks at its FRICTION_LIMIT_ANGLE / peak slip
 *                              ratio, and has fallen to FALLOFF_LEVEL by x = 3.
 * - Combined slip:             normalised slip vector s = |(κ/κpk, tanα/tanαpk)| on a friction ellipse
 * - Load-sensitive friction:   μ = D_REF · (Fz / FZ0)^(LS_EXP − 1)   (separate X / Y, degressive in Fz)
 * - Camber:                    1 + DCAMBER_0·γ + DCAMBER_1·γ² (γ = camber leaning into the force)
 * - Transient:                 relaxation-length carcass deflection states (x and y), i.e. a first-order
 *                              lag of the slip. It also holds the car by static friction at standstill.
 * - Contact patch:             radial deflection δ = Fz / k sets the patch length (pneumatic trail, which
 *                              collapses toward the limit so Mz = −Fy·tp lightens the steering) and the
 *                              effective rolling radius.
 * - Inflation:                 ideal-gas pressure P = P_cold · T_gas / T_cold. Pressure sets the radial
 *                              stiffness, crowns the tread (more load on the centre band) and moves grip
 *                              away from its optimum.
 * - Temperature:               9-node thermal model, inner / middle / outer bands × surface / bulk /
 *                              carcass layers, plus the inflation gas. Grip is the compound's performance
 *                              curve evaluated per band and weighted by each band's share of the contact
 *                              pressure (camber and lateral load move it across the tread).
 */

import {
  dynamicBristleRelaxationScale,
  evaluateFlashTempAndWlfGrip,
  rimWetEnvironmentCoolingWK,
  SLICK_TRAITS,
  wetExternalGasCoolingWK,
  wetGripFactor,
  wetHeatScale,
  wetPneumaticTrailScale,
  wetRoadCoolingWK,
  wetWearScale,
} from './wet-tyres';
import { Lut } from './lut';
import type { Vf26TyreSpec } from './vf26-data';

/** Thermal node index: band (0 inner, 1 middle, 2 outer) × layer (0 surface, 1 bulk, 2 carcass) */
export const TYRE_BANDS = 3;
/** Circumferential sectors around the tyre perimeter for localized lockup heat and flat-spots */
export const TYRE_CIRCUMFERENTIAL_SECTORS = 16;
/** Centrifugal belt growth coefficient (m per rad/s of wheel spin: ≈2.4 mm at 330 km/h, ω ≈ 280 rad/s) */
export const TYRE_CENTRIFUGAL_RADIUS_K = 8.6e-6;
const node = (band: number, layer: number) => band * 3 + layer;

export interface MagicFormulaShape {
  B: number;
  C: number;
  E: number;
}

export interface ContactPatch5PointResult {
  /** Effective road height under the 5-point cambered footprint (m) */
  effectiveHeightM: number;
  /** Effective 3D contact normal (unit vector, world frame Y-up or Z-up depending on caller) */
  nx: number;
  ny: number;
  nz: number;
  /** Additional camber angle induced by lateral kerb/road slope across the tread (rad) */
  kerbCamberRad: number;
  /** Lateral shift of the vertical pressure centroid across the contact patch (-1..+1, + = inner band) */
  centroidShiftInwardNorm: number;
  /** Lateral shift of the vertical pressure centroid in metres (+ = left in wheel frame) */
  centroidShiftLeftM: number;
  /** Overturning moment Mx = Fz * centroidShiftLeftM (Nm) */
  overturningMomentPerN: number;
  /** High-frequency road micro-roughness height at patch center (m) */
  microRoughnessM: number;
  /** Whether the tyre deflection reached the rim bottoming stop */
  rimBottomed: boolean;
}

export interface TyreRuntime {
  spec: Vf26TyreSpec;
  thermal: Lut;
  dyLut: Lut | null;
  dxLut: Lut | null;
  tanPeakAngle: number;
  mf: MagicFormulaShape;
  /** Carcass deflection states (m) */
  deflX: number;
  deflY: number;
  /** Thermal nodes (°C), see `node()` */
  nodes: Float64Array;
  /** 16-sector circumferential surface temperature offset (°C) */
  circumferentialTempsC: Float64Array;
  /** 16-sector circumferential tread/cord wear (0..1) */
  circumferentialWear: Float64Array;
  /** Current wheel angular phase (rad, 0..2π) */
  wheelAngleRad: number;
  /** Current wheel angular velocity (rad/s) for centrifugal radius growth */
  angularVelRadS: number;
  /** Flat-spot severity (0 = round, 1 = severe cord flat-spot) */
  flatSpotSeverity: number;
  /** Instantaneous radius drop at current wheel angle from flat-spotting (m) */
  flatSpotRadiusDropM: number;
  /** Surface graining level (0..1) from cold-core high-slip tearing */
  grainLevel: number;
  /** Internal blistering level (0..1) from overheated core rubber boiling */
  blisterLevel: number;
  /** Off-track grass/gravel/marble surface contamination (0..1) */
  dirtyLevel: number;
  /** Inflation gas temperature (°C) */
  gasTempC: number;
  /** Cold inflation pressure at COLD_REF_C (psi) */
  coldPressurePsi: number;
  /** Current inflation pressure (psi) */
  pressurePsi: number;
  /** Radial stiffness at the current pressure (N/m) */
  verticalRate: number;
  /** Share of the contact pressure on the inner / middle / outer band (sums to 1) */
  bandLoad: [number, number, number];
  /** Mean surface / bulk temperature across the tread (°C) */
  surfaceTempC: number;
  coreTempC: number;
  /** Tread wear (0 = new, 1 = destroyed) */
  wear: number;
  /** Water film under the tyre (mm) and how wet the road acts (0..1), set by the car from the weather */
  waterMm: number;
  wetness: number;
  /** Realism: strength of the wet grip loss, tread wear multiplier and share of the temperature grip loss */
  wetSeverity: number;
  wearScale: number;
  thermalGripScale: number;
}

export interface TyreForceInput {
  /** Vertical load (N) */
  fz: number;
  /** Contact-patch velocity in the wheel frame (m/s): x along the wheel heading, y to the left */
  vx: number;
  vy: number;
  /** Rim speed ω·R_e (m/s) */
  rimSpeed: number;
  /** Camber leaning toward +y (left) relative to the road (rad) */
  camberLeftRad: number;
  /** Surface friction multiplier (asphalt 1.0, kerb, grass …) */
  surfaceGrip: number;
  /** Which wheel-frame y direction points at the car's centreline (+1 = left, i.e. a right-hand wheel) */
  inwardSign?: 1 | -1;
  /** Optional 5-point contact patch lateral centroid shift toward inner shoulder (-1..+1) */
  contactCentroidShiftInward?: number;
  /** Optional lateral centroid shift in metres (+left) for overturning moment Mx */
  contactCentroidShiftLeftM?: number;
  dt: number;
}

export interface TyreForceOutput {
  /** Longitudinal force in the wheel frame (N, + forward) */
  fx: number;
  /** Lateral force in the wheel frame (N, + left) */
  fy: number;
  /** Self-aligning moment about the vertical axis (Nm, + CCW from above) */
  mz: number;
  /** Overturning moment about the longitudinal axis (Nm) from 5-point contact centroid shift */
  mx: number;
  /** Harmonic vertical/rack vibration torque from flat-spots (Nm) */
  flatSpotVibrationNm: number;
  /** Signed longitudinal slip ratio (+ traction) */
  slipRatio: number;
  /** Slip angle (rad, + when the patch moves left) */
  slipAngle: number;
  /** Combined normalised slip (1.0 = at the peak of the grip curve) */
  normSlip: number;
  /** Effective friction coefficient actually available (lateral) */
  mu: number;
  /** Grip multiplier from temperature × pressure × camber × wear (diagnostics) */
  gripFactor: number;
  /** Power dissipated in the contact patch (W) */
  slipPower: number;
}

const DEG2RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const KELVIN = 273.15;
/** Maximum stored normalised slip — beyond this the patch is fully sliding */
const MAX_NORM_SLIP = 5;
/** Below this speed the carcass damping term blends in */
const LOW_SPEED_BLEND_MS = 3;
/** Slope of the normalised slip curve at zero slip (the mod's cornering / longitudinal stiffness) */
const MF_SLOPE = 2;
/** Normalised slip at which the Magic Formula has fallen to the mod's FALLOFF_LEVEL */
const MF_FALLOFF_AT = 3;
/** Cold pressures are quoted at this temperature (°C) */
export const COLD_REF_C = 20;
/** Gas temperature at which the tyre reaches its reference (optimum) pressure (°C) */
const GAS_REF_C = 95;
/** Radial stiffness: share that scales with inflation pressure (the rest is the sidewall structure) */
const RATE_PRESSURE_SHARE = 0.4;
/** Grip lost per (ΔP / P_ref)² away from the optimum pressure */
const PRESSURE_GRIP_LOSS = 1.5;
/** Contact-pressure shift toward the inner band per rad of camber leaning toward the car */
const BAND_CAMBER_SHIFT = 7;
/** Contact-pressure shift toward the outer band per unit of inward lateral force / load */
const BAND_LATERAL_SHIFT = 0.22;
/** Extra centre-band load per unit of relative over-inflation (crowned tread) */
const BAND_CROWN = 2;
/** Grip lost per unit of tread wear (linear part) and extra loss per unit wear past the half-worn point */
const WEAR_GRIP_LINEAR = 0.06;
const WEAR_GRIP_KNEE = 0.5;
const WEAR_GRIP_QUAD = 0.5;

/**
 * Deterministic multi-octave ISO 8608 spatial road micro-roughness height (m).
 * Synthesizes repeatable laser-scan-like road texture across wavelengths 0.22 m – 4.5 m.
 */
export function evaluateIso8608RoadRoughness(
  worldX: number,
  worldZ: number,
  surface: 'asphalt' | 'road' | 'pitlane' | 'kerb' | 'runoff' | 'grass' | 'gravel' = 'asphalt'
): number {
  const w1 = Math.sin(worldX * 2.13 + worldZ * 1.79) * 0.45;
  const w2 = Math.sin(worldX * 6.41 - worldZ * 5.87 + 1.1) * 0.30;
  const w3 = Math.cos(worldX * 14.8 + worldZ * 13.2 - 0.7) * 0.17;
  const w4 = Math.sin(worldX * 28.5 - worldZ * 26.1 + 2.3) * 0.08;
  const raw = w1 + w2 + w3 + w4; // in [-1, 1]
  if (surface === 'kerb') {
    // Rumble strip sawtooth harmonic + micro-roughness
    const rumble = Math.sin((worldX + worldZ) * 18.85) * 0.0022;
    return raw * 0.0012 + rumble;
  }
  if (surface === 'grass' || surface === 'gravel' || surface === 'runoff') {
    return raw * 0.0038;
  }
  // FIA Grade 1 asphalt micro-roughness (±0.55 mm)
  return raw * 0.00055;
}

/**
 * 5-point 3D cambered & steered contact patch sampler.
 * Evaluates road height at Center, Front, Rear, Inner, and Outer tread points,
 * returning the effective road height, 3D surface normal, kerb-induced camber angle,
 * lateral pressure centroid shift, and overturning moment lever arm.
 */
export function sample5PointContactPatch(
  centerX: number,
  centerZ: number,
  headingCos: number,
  headingSin: number,
  inwardSign: 1 | -1,
  camberLeftRad: number,
  tyreWidthM: number,
  tyreRadiusM: number,
  approxDeflectionM: number,
  sampleHeightAt: (x: number, z: number) => number,
  surfaceKind: 'asphalt' | 'road' | 'pitlane' | 'kerb' | 'runoff' | 'grass' | 'gravel' = 'asphalt',
  out: ContactPatch5PointResult = createContactPatchResult()
): ContactPatch5PointResult {
  const halfLen = Math.max(0.045, Math.min(0.14, Math.sqrt(Math.max(1e-4, tyreRadiusM * Math.max(0.004, approxDeflectionM)))));
  const halfWid = 0.42 * tyreWidthM;
  // Left unit vector in horizontal plane (for Y-up Three.js or Z-up track coordinates):
  // If forward is (headingSin, headingCos) in (X, Z), left is (headingCos, -headingSin).
  const leftX = headingCos;
  const leftZ = -headingSin;
  const fwdX = headingSin;
  const fwdZ = headingCos;

  const microC = evaluateIso8608RoadRoughness(centerX, centerZ, surfaceKind);
  const hC = sampleHeightAt(centerX, centerZ) + microC;
  const hF = sampleHeightAt(centerX + fwdX * halfLen, centerZ + fwdZ * halfLen) +
    evaluateIso8608RoadRoughness(centerX + fwdX * halfLen, centerZ + fwdZ * halfLen, surfaceKind);
  const hR = sampleHeightAt(centerX - fwdX * halfLen, centerZ - fwdZ * halfLen) +
    evaluateIso8608RoadRoughness(centerX - fwdX * halfLen, centerZ - fwdZ * halfLen, surfaceKind);

  // Inner point is in direction `inwardSign * left`, Outer point is `-inwardSign * left`
  const inX = centerX + inwardSign * leftX * halfWid;
  const inZ = centerZ + inwardSign * leftZ * halfWid;
  const outX = centerX - inwardSign * leftX * halfWid;
  const outZ = centerZ - inwardSign * leftZ * halfWid;
  const hI = sampleHeightAt(inX, inZ) + evaluateIso8608RoadRoughness(inX, inZ, surfaceKind);
  const hO = sampleHeightAt(outX, outZ) + evaluateIso8608RoadRoughness(outX, outZ, surfaceKind);

  // Camber tilt raises one shoulder and lowers the other relative to the wheel center:
  // camberLeftRad > 0 means top leans left, so bottom (tread) is lower on the right (-left) and higher on the left
  // (used for the footprint envelope only: the tyre model shifts the bands for camber itself)
  const camberInRad = inwardSign * camberLeftRad;
  const treadDropIn = halfWid * Math.sin(camberInRad);

  // Effective contact height envelopes the 5 points
  const effectiveHeightM = 0.40 * hC + 0.15 * hF + 0.15 * hR + 0.15 * Math.max(hC, hI + treadDropIn) + 0.15 * Math.max(hC, hO - treadDropIn);

  // Longitudinal and lateral road slopes across the footprint
  const slopeFwd = (hF - hR) / (2 * halfLen);
  const slopeIn = (hI - hO) / (2 * halfWid);
  const slopeLeft = inwardSign * slopeIn;

  // Construct unit normal (nx, ny, nz) where ny is vertical up
  const rawNx = -(fwdX * slopeFwd + leftX * slopeLeft);
  const rawNz = -(fwdZ * slopeFwd + leftZ * slopeLeft);
  const invLen = 1 / Math.hypot(rawNx, 1, rawNz);
  const nx = rawNx * invLen;
  const ny = invLen;
  const nz = rawNz * invLen;

  const kerbCamberRad = Math.atan(slopeLeft);
  // Road (and micro-roughness) height difference across the tread only: camber is already a band shift in
  // computeTyreForces (BAND_CAMBER_SHIFT), so counting the cambered tread drop here would apply it twice
  const penDiffIn = (hI - hO) / Math.max(0.008, approxDeflectionM + 0.006);
  const centroidShiftInwardNorm = Math.max(-0.85, Math.min(0.85, penDiffIn * 0.35));
  const centroidShiftLeftM = inwardSign * centroidShiftInwardNorm * halfWid * 0.5;

  out.effectiveHeightM = effectiveHeightM;
  out.nx = nx;
  out.ny = ny;
  out.nz = nz;
  out.kerbCamberRad = kerbCamberRad;
  out.centroidShiftInwardNorm = centroidShiftInwardNorm;
  out.centroidShiftLeftM = centroidShiftLeftM;
  out.overturningMomentPerN = centroidShiftLeftM;
  out.microRoughnessM = microC;
  out.rimBottomed = false;
  return out;
}

/** A zeroed patch result for `sample5PointContactPatch` to write into (avoids per-step allocation) */
export function createContactPatchResult(): ContactPatch5PointResult {
  return {
    effectiveHeightM: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    kerbCamberRad: 0,
    centroidShiftInwardNorm: 0,
    centroidShiftLeftM: 0,
    overturningMomentPerN: 0,
    microRoughnessM: 0,
    rimBottomed: false,
  };
}

/**
 * Grip multiplier from tread wear (0 = new, 1 = destroyed). Progressive: a worn-in tyre loses little
 * grip early, then the rubber thins out and the loss accelerates past the half-worn point.
 * Roughly 1.8 % at 30 % wear and 9 % at 80 % wear.
 */
export function wearGripMultiplier(wear: number): number {
  const w = Math.min(1, Math.max(0, wear));
  return 1 - WEAR_GRIP_LINEAR * w - WEAR_GRIP_QUAD * Math.max(0, w - WEAR_GRIP_KNEE) ** 2;
}

export function magicFormula(x: number, m: MagicFormulaShape): number {
  const bx = m.B * x;
  return Math.sin(m.C * Math.atan(bx - m.E * (bx - Math.atan(bx))));
}

/**
 * Magic Formula shape with slope `MF_SLOPE` at zero slip and its peak (1.0) at x = 1, that has
 * fallen to `falloffLevel` at x = `MF_FALLOFF_AT`.
 */
export function fitMagicFormula(falloffLevel: number): MagicFormulaShape {
  const shape = (C: number): MagicFormulaShape => {
    const B = MF_SLOPE / C;
    // Peak at x = 1: C · atan(B − E(B − atan B)) = π/2
    const phi = Math.tan(Math.PI / (2 * C));
    return { B, C, E: (B - phi) / (B - Math.atan(B)) };
  };
  // A larger shape factor C drops further past the peak
  let lo = 1.3;
  let hi = 1.95;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (magicFormula(MF_FALLOFF_AT, shape(mid)) > falloffLevel) lo = mid;
    else hi = mid;
  }
  return shape(0.5 * (lo + hi));
}

/** Cold pressure that reaches `refPsi` when the gas is at the reference running temperature */
export function coldPressureFor(refPsi: number): number {
  return (refPsi * (COLD_REF_C + KELVIN)) / (GAS_REF_C + KELVIN);
}

export function createTyreRuntime(spec: Vf26TyreSpec, initialTempC: number): TyreRuntime {
  const t: TyreRuntime = {
    spec,
    thermal: new Lut(spec.thermalCurve),
    dyLut: spec.dyCurve ? new Lut(spec.dyCurve) : null,
    dxLut: spec.dxCurve ? new Lut(spec.dxCurve) : null,
    tanPeakAngle: Math.tan(spec.frictionLimitAngleDeg * DEG2RAD),
    mf: fitMagicFormula(spec.falloffLevel),
    deflX: 0,
    deflY: 0,
    nodes: new Float64Array(9),
    circumferentialTempsC: new Float64Array(TYRE_CIRCUMFERENTIAL_SECTORS),
    circumferentialWear: new Float64Array(TYRE_CIRCUMFERENTIAL_SECTORS),
    wheelAngleRad: 0,
    angularVelRadS: 0,
    flatSpotSeverity: 0,
    flatSpotRadiusDropM: 0,
    grainLevel: 0,
    blisterLevel: 0,
    dirtyLevel: 0,
    gasTempC: initialTempC,
    coldPressurePsi: coldPressureFor(spec.pressureRefPsi),
    pressurePsi: spec.pressureRefPsi,
    verticalRate: spec.rate,
    bandLoad: [1 / 3, 1 / 3, 1 / 3],
    surfaceTempC: initialTempC,
    coreTempC: initialTempC,
    wear: 0,
    waterMm: 0,
    wetness: 0,
    wetSeverity: 1,
    wearScale: 1,
    thermalGripScale: 1,
  };
  setTyreTemperature(t, initialTempC);
  return t;
}

/**
 * Switches the compound / section. The cold inflation pressure is left as set (the driver's setup), it is
 * not reset to the compound default.
 */
export function setTyreSpec(t: TyreRuntime, spec: Vf26TyreSpec): void {
  if (t.spec === spec) return;
  t.spec = spec;
  t.thermal = new Lut(spec.thermalCurve);
  t.dyLut = spec.dyCurve ? new Lut(spec.dyCurve) : null;
  t.dxLut = spec.dxCurve ? new Lut(spec.dxCurve) : null;
  t.tanPeakAngle = Math.tan(spec.frictionLimitAngleDeg * DEG2RAD);
  t.mf = fitMagicFormula(spec.falloffLevel);
  updateInflation(t);
}

/** Sets the cold inflation pressure (psi at COLD_REF_C) and updates the hot pressure and radial rate */
export function setTyreColdPressure(t: TyreRuntime, coldPsi: number): void {
  t.coldPressurePsi = coldPsi;
  updateInflation(t);
}

/** Sets every node and the gas to one temperature (tyre blankets) and resets surface degradation states */
export function setTyreTemperature(t: TyreRuntime, tempC: number): void {
  t.nodes.fill(tempC);
  t.circumferentialTempsC.fill(tempC);
  t.circumferentialWear.fill(0);
  t.wheelAngleRad = 0;
  t.angularVelRadS = 0;
  t.flatSpotSeverity = 0;
  t.flatSpotRadiusDropM = 0;
  t.grainLevel = 0;
  t.blisterLevel = 0;
  t.dirtyLevel = 0;
  t.gasTempC = tempC;
  t.surfaceTempC = tempC;
  t.coreTempC = tempC;
  updateInflation(t);
}

/** Surface temperature of one band (0 inner, 1 middle, 2 outer) */
export function tyreBandSurfaceTempC(t: TyreRuntime, band: number): number {
  return t.nodes[node(band, 0)];
}

function hotPressureRefPsi(spec: Vf26TyreSpec): number {
  const shift = spec.wet?.tempShiftC ?? 0;
  if (shift === 0) return spec.pressureRefPsi;
  const refGasC = GAS_REF_C + 0.75 * shift;
  return (spec.pressureRefPsi * (refGasC + KELVIN)) / (GAS_REF_C + KELVIN);
}

function updateInflation(t: TyreRuntime): void {
  t.pressurePsi = (t.coldPressurePsi * (t.gasTempC + KELVIN)) / (COLD_REF_C + KELVIN);
  const rel = t.pressurePsi / hotPressureRefPsi(t.spec);
  t.verticalRate = t.spec.rate * (1 - RATE_PRESSURE_SHARE + RATE_PRESSURE_SHARE * rel);
}

/** Centrifugal radial growth ΔR = k_ω · |ω| (m), capped at 4.5 mm */
export function tyreCentrifugalGrowthM(omegaRadS: number): number {
  return Math.min(0.0045, TYRE_CENTRIFUGAL_RADIUS_K * Math.abs(omegaRadS));
}

/**
 * Effective rolling radius under load. The tyre squashes by δ = Fz / k; a radial tyre's rolling
 * radius drops by about δ/3 and grows centrifugally with wheel spin speed ω.
 * When `omegaRadS` is omitted, uses `t.angularVelRadS` (0 at rest).
 */
export function tyreRollingRadius(t: TyreRuntime, fz: number, omegaRadS = t.angularVelRadS): number {
  const spec = t.spec;
  const delta = Math.min(0.06, Math.max(0, fz) / t.verticalRate);
  const deltaRef = spec.fz0 / spec.rate;
  return spec.radius - (delta - deltaRef) / 3 + tyreCentrifugalGrowthM(omegaRadS) - t.flatSpotRadiusDropM * 0.35;
}

/**
 * Free (unloaded) radius (m), including centrifugal belt growth when spinning.
 */
export function tyreUnloadedRadius(t: TyreRuntime, omegaRadS = t.angularVelRadS): number {
  return t.spec.radius + t.spec.fz0 / t.spec.rate / 3 + tyreCentrifugalGrowthM(omegaRadS);
}

/** Radial deflection δ (m) under vertical load `fz` = Fz / current radial rate, clamped to [0, 0.06] as above */
export function tyreVerticalDeflection(t: TyreRuntime, fz: number): number {
  return Math.min(0.06, Math.max(0, fz) / t.verticalRate);
}

/** Loaded radius (m) = R_unloaded − δ − ΔR_flatSpot */
export function tyreLoadedRadius(t: TyreRuntime, fz: number, omegaRadS = t.angularVelRadS): number {
  return tyreUnloadedRadius(t, omegaRadS) - tyreVerticalDeflection(t, fz) - t.flatSpotRadiusDropM;
}

/** Harmonic flat-spot vibration torque (Nm) for a wheel with given flat-spot severity, rotation phase, angular speed, and vertical load */
export function flatSpotVibrationNm(
  flatSpotSeverity: number,
  wheelAngleRad: number,
  omegaRadS: number,
  fz: number,
  fz0 = 3500
): number {
  const absVx = Math.abs(omegaRadS) * 0.36;
  if (flatSpotSeverity <= 0.005 || absVx <= 2 || fz <= 1) return 0;
  return flatSpotSeverity * (fz / Math.max(500, fz0)) * Math.min(1, absVx / 35) * 16 * Math.sin(wheelAngleRad * 2);
}

/** Grip from temperature: the performance curve per band, weighted by each band's contact share */
function thermalGrip(t: TyreRuntime, slideSpeedMs = 0): number {
  // WLF (Williams-Landel-Ferry) viscoelastic frequency-temperature shift when sliding:
  const logFreq = slideSpeedMs > 0.05 ? Math.log10(1 + slideSpeedMs * 0.12) : 0;
  const wlfShiftC = -1.8 * (logFreq / (2.0 + logFreq));
  let g = 0;
  for (let b = 0; b < TYRE_BANDS; b++) {
    const gripTemp = 0.6 * t.nodes[node(b, 0)] + 0.4 * t.nodes[node(b, 1)] + wlfShiftC;
    g += t.bandLoad[b] * t.thermal.evaluate(gripTemp);
  }
  return g;
}

/**
 * Advances the carcass deflection states and returns the contact forces.
 */
export function computeTyreForces(t: TyreRuntime, inp: TyreForceInput): TyreForceOutput {
  const spec = t.spec;
  const bristleScale = dynamicBristleRelaxationScale(inp.fz, spec.fz0, t.wetness);
  const sigmaY = spec.relaxationLength * bristleScale;
  const sigmaX = spec.relaxationLength * 0.7 * bristleScale;
  const absVx = Math.abs(inp.vx);
  const slipVelX = inp.rimSpeed - inp.vx; // + when the tyre is driving
  const slipVelY = inp.vy;

  // Update wheel spin angular velocity and angular phase for centrifugal growth & flat-spot sector tracking
  t.angularVelRadS = inp.rimSpeed / Math.max(0.2, spec.radius);
  t.wheelAngleRad = (((t.wheelAngleRad + t.angularVelRadS * inp.dt) % TWO_PI) + TWO_PI) % TWO_PI;

  const secIdx = Math.floor((t.wheelAngleRad / TWO_PI) * TYRE_CIRCUMFERENTIAL_SECTORS) % TYRE_CIRCUMFERENTIAL_SECTORS;
  let minSecWear = t.circumferentialWear[0];
  for (let i = 1; i < TYRE_CIRCUMFERENTIAL_SECTORS; i++) {
    if (t.circumferentialWear[i] < minSecWear) minSecWear = t.circumferentialWear[i];
  }
  const localFlatWear = Math.max(0, t.circumferentialWear[secIdx] - minSecWear);
  t.flatSpotRadiusDropM = Math.min(0.004, localFlatWear * 0.016);

  // Relaxation-length carcass dynamics, integrated exactly over dt:
  //   d(defl)/dt = slipVel − |vx|/σ · defl
  // At high slip, carcass relaxation rate tightens so countersteering and limit corrections respond crisply
  const prevSlipSq = (t.deflX / sigmaX / spec.peakSlipRatio) ** 2 + (t.deflY / sigmaY / t.tanPeakAngle) ** 2;
  const relaxRateMult = 1 / (0.68 + 0.32 / (1 + 0.65 * Math.min(25, prevSlipSq)));
  const decayX = absVx / sigmaX;
  const decayY = absVx / sigmaY;
  if (decayX > 1e-6) {
    const ssX = slipVelX / decayX;
    const ssY = slipVelY / decayY;
    const ex = Math.exp(-decayX * relaxRateMult * inp.dt);
    const ey = Math.exp(-decayY * relaxRateMult * inp.dt);
    t.deflX = ssX + (t.deflX - ssX) * ex;
    t.deflY = ssY + (t.deflY - ssY) * ey;
  } else {
    t.deflX += slipVelX * inp.dt;
    t.deflY += slipVelY * inp.dt;
  }

  if (inp.fz <= 1) {
    // Airborne: carcass relaxes, no force
    t.deflX *= 0.5;
    t.deflY *= 0.5;
    return {
      fx: 0,
      fy: 0,
      mz: 0,
      mx: 0,
      flatSpotVibrationNm: 0,
      slipRatio: 0,
      slipAngle: 0,
      normSlip: 0,
      mu: 0,
      gripFactor: 1,
      slipPower: 0,
    };
  }

  // Normalised slip components
  let sk = t.deflX / sigmaX / spec.peakSlipRatio;
  let sa = t.deflY / sigmaY / t.tanPeakAngle;
  let s = Math.hypot(sk, sa);
  if (s > MAX_NORM_SLIP) {
    const k = MAX_NORM_SLIP / s;
    t.deflX *= k;
    t.deflY *= k;
    sk *= k;
    sa *= k;
    s = MAX_NORM_SLIP;
  }

  // Load sensitivity (16-point non-power-law DY_CURVE / DX_CURVE when available, else D = D_REF · (Fz/FZ0)^(LS_EXP − 1))
  const loadRatio = Math.max(0.15, inp.fz / spec.fz0);
  let muY = t.dyLut ? t.dyLut.evaluate(inp.fz) : spec.dyRef * Math.pow(loadRatio, spec.lsExpY - 1);
  let muX = t.dxLut ? t.dxLut.evaluate(inp.fz) : spec.dxRef * Math.pow(loadRatio, spec.lsExpX - 1);
  if (sk < 0 && spec.brakeDxMod) {
    muX *= 1 + spec.brakeDxMod;
  }

  // Sliding-speed sensitivity
  const slideSpeed = Math.hypot(slipVelX, slipVelY) * Math.min(1, Math.max(0, s - 0.6));
  const speedSens = 1 / (1 + spec.speedSensitivity * slideSpeed);

  // Temperature (per band with WLF shift), inflation pressure, wear, graining, blistering, dirt & flat-spot
  // (the realism level may apply only part of the temperature loss)
  const thermal = 1 - (1 - thermalGrip(t, slideSpeed)) * t.thermalGripScale;
  const pRel = t.pressurePsi / hotPressureRefPsi(spec) - 1;
  const pressureGrip = Math.max(0.8, 1 - PRESSURE_GRIP_LOSS * pRel * pRel);
  const wearMult = wearGripMultiplier(t.wear);
  const degradationMult =
    (1 - 0.08 * t.grainLevel) *
    (1 - 0.12 * t.blisterLevel) *
    (1 - 0.18 * t.dirtyLevel) *
    (1 - 0.05 * t.flatSpotSeverity);

  // Camber (γ positive when leaning into the lateral force direction)
  const dirY = s > 1e-9 ? -sa / s : 0;
  const gamma = inp.camberLeftRad;
  const camberLat = 1 + spec.dcamber0 * gamma * Math.sign(dirY) * Math.min(1, Math.abs(dirY) * 4) + spec.dcamber1 * gamma * gamma;
  const camberLong = 1 + spec.dcamber1 * gamma * gamma;

  // Water on the road: the film's lubrication and, past what the tread clears at this speed, aquaplaning (worn tread clears less water)
  const traits = spec.wet ?? SLICK_TRAITS;
  const waterGrip = t.waterMm > 0 ? wetGripFactor(traits, t.waterMm, absVx, t.wetSeverity, t.wear) : 1;
  const wlf = evaluateFlashTempAndWlfGrip(traits, t.surfaceTempC, Math.hypot(slipVelX, slipVelY), inp.fz, t.wetness);
  const common =
    thermal * wlf.viscoelasticMult * pressureGrip * wearMult * degradationMult * speedSens * inp.surfaceGrip * waterGrip;
  muY *= common * Math.max(0.75, camberLat);
  muX *= common * Math.max(0.75, camberLong);

  // Elliptical combined-slip coupling (k_xy = 0.94): smooths trail-braking and corner-exit power transitions
  // while keeping pure longitudinal (sa = 0) and pure lateral (sk = 0) slip curves exact
  const kComb = 0.94;
  const sxComb = Math.hypot(sk, kComb * sa);
  const syComb = Math.hypot(sa, kComb * sk);
  let fx = 0;
  let fy = 0;
  if (s > 1e-9) {
    fx = sxComb > 1e-9 ? (inp.fz * muX * magicFormula(sxComb, t.mf) * sk) / sxComb : 0;
    fy = syComb > 1e-9 ? (-inp.fz * muY * magicFormula(syComb, t.mf) * sa) / syComb : 0;
  }

  // Low-speed carcass damping (prevents the deflection spring from ringing at standstill)
  if (absVx < LOW_SPEED_BLEND_MS) {
    const blend = 1 - absVx / LOW_SPEED_BLEND_MS;
    const c = (inp.fz * 3.0) * blend; // N per (m/s) — ζ≈0.3 on the carcass spring, stable at 2 kHz
    fx += c * slipVelX;
    fy -= c * slipVelY;
    const limX = inp.fz * muX;
    const limY = inp.fz * muY;
    fx = Math.max(-limX, Math.min(limX, fx));
    fy = Math.max(-limY, Math.min(limY, fy));
  }

  // Self-aligning torque: pneumatic trail (≈ patch length / 6) collapses as the tyre reaches its
  // peak and as a hydrodynamic water wedge lifts the leading edge in standing water
  const contactLength = 2 * Math.sqrt(Math.max(1e-4, spec.radius * (inp.fz / t.verticalRate)));
  const wetTrailMult = t.waterMm > 0 ? wetPneumaticTrailScale(traits, t.waterMm, absVx, t.wear) : 1;
  const trail0 = (contactLength / 6) * wetTrailMult;
  const absSa = Math.abs(sa);
  const trail = absSa <= 1 ? trail0 * (1 - absSa) * (1 - Math.min(0.6, Math.abs(sk) * 0.3)) : -trail0 * 0.08 * Math.min(1, absSa - 1);
  const mz = -trail * fy;

  // Contact pressure across the tread: camber leaning toward the car loads the inner shoulder,
  // the lateral force rolls the patch onto the shoulder away from the force, 5-point kerb tilt shifts it,
  // and over-inflation crowns the middle band
  const inward = inp.inwardSign ?? 1;
  const camberIn = inward * gamma;
  const fyIn = (inward * fy) / inp.fz;
  const patchShiftIn = inp.contactCentroidShiftInward ?? 0;
  const shift = Math.max(-0.85, Math.min(0.85, BAND_CAMBER_SHIFT * camberIn - BAND_LATERAL_SHIFT * fyIn + 0.45 * patchShiftIn));
  const crown = Math.max(0.6, Math.min(1.6, 1 + BAND_CROWN * pRel));
  const norm = 1 / (2 + crown);
  t.bandLoad[0] = (1 + shift) * norm;
  t.bandLoad[1] = crown * norm;
  t.bandLoad[2] = (1 - shift) * norm;

  // Overturning moment Mx = Fz * Δy_cp
  const centroidLeftM = inp.contactCentroidShiftLeftM ?? (-0.12 * spec.width * gamma);
  const mx = inp.fz * centroidLeftM;

  // Harmonic flat-spot vibration torque proportional to flat-spot severity, vertical load, and wheel rotation
  const flatSpotVibrationNm =
    t.flatSpotSeverity > 0.005 && absVx > 2
      ? t.flatSpotSeverity * (inp.fz / spec.fz0) * Math.min(1, absVx / 35) * 16 * Math.sin(t.wheelAngleRad * 2)
      : 0;

  const slipPower = Math.abs(fx * slipVelX) + Math.abs(fy * slipVelY);

  return {
    fx,
    fy,
    mz,
    mx,
    flatSpotVibrationNm,
    slipRatio: (t.deflX / sigmaX),
    slipAngle: Math.atan(t.deflY / sigmaY),
    normSlip: s,
    mu: muY,
    gripFactor: thermal * pressureGrip * wearMult * degradationMult * waterGrip * Math.max(0.75, camberLat),
    slipPower,
  };
}

/**
 * Updates the 16-sector circumferential wear and temperature grid (`stepFlatSpot`).
 * Under wheel lockup (|ωR| << |vx|), sliding energy concentrates into the stationary grounded sector,
 * creating a localized thermal spike and cord flat-spot.
 */
export function stepFlatSpot(
  t: TyreRuntime,
  slipPowerW: number,
  rollSpeedMs: number,
  rimSpeedMs: number,
  dt: number
): void {
  const absVx = Math.abs(rollSpeedMs);
  const absRim = Math.abs(rimSpeedMs);
  const wearInc = slipPowerW * dt * t.spec.wearPerJ * t.wearScale;
  const sec = Math.floor((t.wheelAngleRad / TWO_PI) * TYRE_CIRCUMFERENTIAL_SECTORS) % TYRE_CIRCUMFERENTIAL_SECTORS;

  if (absVx > 4.0 && absRim < 0.35 * absVx) {
    // Locked / heavily dragging wheel: concentrate heat and abrasion on the grounded sector and its neighbors
    const lockFrac = (0.35 * absVx - absRim) / (0.35 * absVx);
    const prevSec = (sec + TYRE_CIRCUMFERENTIAL_SECTORS - 1) % TYRE_CIRCUMFERENTIAL_SECTORS;
    const nextSec = (sec + 1) % TYRE_CIRCUMFERENTIAL_SECTORS;
    const localizedWear = wearInc * (1 + 11 * lockFrac);
    t.circumferentialWear[sec] = Math.min(1, t.circumferentialWear[sec] + localizedWear * 0.6);
    t.circumferentialWear[prevSec] = Math.min(1, t.circumferentialWear[prevSec] + localizedWear * 0.2);
    t.circumferentialWear[nextSec] = Math.min(1, t.circumferentialWear[nextSec] + localizedWear * 0.2);

    const tempSpike = (0.45 * slipPowerW * dt * lockFrac) / (C_SURFACE / 4);
    t.circumferentialTempsC[sec] = Math.min(260, t.circumferentialTempsC[sec] + tempSpike * 0.6);
    t.circumferentialTempsC[prevSec] = Math.min(260, t.circumferentialTempsC[prevSec] + tempSpike * 0.2);
    t.circumferentialTempsC[nextSec] = Math.min(260, t.circumferentialTempsC[nextSec] + tempSpike * 0.2);
  } else {
    // Normal rolling: distribute wear around all 16 sectors and equalize circumferential temperatures
    for (let i = 0; i < TYRE_CIRCUMFERENTIAL_SECTORS; i++) {
      t.circumferentialWear[i] = Math.min(1, t.circumferentialWear[i] + wearInc);
      t.circumferentialTempsC[i] += (t.surfaceTempC - t.circumferentialTempsC[i]) * Math.min(1, dt * 3.5);
    }
  }

  let minW = t.circumferentialWear[0];
  let maxW = t.circumferentialWear[0];
  for (let i = 1; i < TYRE_CIRCUMFERENTIAL_SECTORS; i++) {
    const w = t.circumferentialWear[i];
    if (w < minW) minW = w;
    if (w > maxW) maxW = w;
  }
  t.flatSpotSeverity = Math.min(1, Math.max(0, (maxW - minW) * 18));
}

/**
 * Advances surface graining (`grainLevel`) and internal blistering (`blisterLevel`).
 * - Graining occurs when high sliding power shears a hot tread surface over a cold bulk/core (< 78 °C),
 *   and slowly scrubs clean when rolling with the core inside its optimal window.
 * - Blistering occurs when the internal bulk/core temperature exceeds 128 °C.
 */
export function stepGrainBlister(
  t: TyreRuntime,
  slipPowerW: number,
  fz: number,
  dt: number
): void {
  // A rain tyre's thresholds sit lower with its working window
  const shift = (t.spec.wet ?? SLICK_TRAITS).tempShiftC;
  const core = t.coreTempC - shift;
  const surfCoreDelta = t.surfaceTempC - t.coreTempC;
  if (core < 78 && surfCoreDelta > 10 && slipPowerW > 6000) {
    const coldFactor = (78 - core) / 30;
    const rate = (slipPowerW / 100000) * coldFactor * 0.25;
    t.grainLevel = Math.min(1, t.grainLevel + rate * dt);
  } else if (core >= 82 && core <= 120 && fz > 500 && slipPowerW < 25000) {
    t.grainLevel = Math.max(0, t.grainLevel - 0.035 * dt);
  }

  if (core > 128) {
    const overheat = core - 128;
    t.blisterLevel = Math.min(1, t.blisterLevel + overheat * 0.0035 * dt);
  }
}

/**
 * Advances surface contamination (`dirtyLevel`) from off-track excursions (grass/runoff/gravel)
 * or off-line rubber marbles, and cleans the tread via rolling contact and shear work on clean asphalt.
 */
export function stepDirtyLevel(
  t: TyreRuntime,
  surface: 'asphalt' | 'road' | 'pitlane' | 'kerb' | 'runoff' | 'grass' | 'gravel',
  slipPowerW: number,
  rollSpeedMs: number,
  dt: number,
  marbleLevel = 0
): void {
  t.dirtyLevel = advanceDirtyLevel(t.dirtyLevel, surface, slipPowerW, rollSpeedMs, dt, marbleLevel);
}

/**
 * Next tread contamination level (0..1). Grass / gravel / run-off load the tread toward fully dirty; on asphalt it
 * settles at a level set by the marbles under it (0.6 × marble density): it picks marbles up toward that level when
 * cleaner, and rolling plus shear work scrub it progressively down to it when dirtier, so off-line marbles do
 * accumulate while the racing line (no marbles, as at the start of a session) cleans the tyre.
 */
export function advanceDirtyLevel(
  level: number,
  surface: string,
  slipPowerW: number,
  rollSpeedMs: number,
  dt: number,
  marbleLevel = 0
): number {
  const v = Math.abs(rollSpeedMs);
  const lv = Number.isFinite(level) ? level : 0;
  if (surface === 'grass' || surface === 'gravel') return Math.min(1, lv + (0.18 + v * 0.045) * dt);
  if (surface === 'runoff') return Math.min(1, lv + (0.05 + v * 0.015) * dt);
  const target = 0.6 * Math.max(0, Math.min(1, Number.isFinite(marbleLevel) ? marbleLevel : 0));
  if (lv < target) {
    const pickup = (0.02 + (v / 35) * 0.25) * target;
    return Math.min(target, lv + pickup * dt);
  }
  const clean = (v / 25) * 0.14 + (Math.max(0, slipPowerW) / 50000) * 0.45;
  return Math.max(target, lv - clean * dt);
}

// Thermal network (per band; the totals match the earlier calibrated two-node model:
// surface 2600 J/K, core = bulk + carcass 21000 J/K, surface → core 95 W/K)
const C_SURFACE = 2600 / 3;
const C_BULK = 14000 / 3;
const C_CARCASS = 7000 / 3;
/** Inflation gas (≈0.1 kg of air) */
const C_GAS = 80;
const G_SURFACE_BULK = 95 / 3;
const G_BULK_CARCASS = 60 / 3;
const G_CARCASS_GAS = 10;
/** Lateral conduction between neighbouring bands, per layer */
const G_LATERAL = [2, 6, 4];
/** Brake heat soaking through the rim into the gas */
const G_RIM_GAS = 0.6;
/** Scratch heat-flow buffer (W per node) */
const heatFlow = new Float64Array(9);

/**
 * 9-node tyre thermal model plus the inflation gas, with ideal-gas pressure, 16-sector flat-spotting,
 * graining, blistering, and dirt pickup.
 */
export function updateTyreThermal(
  t: TyreRuntime,
  slipPowerW: number,
  fz: number,
  rollSpeedMs: number,
  ambientC: number,
  trackC: number,
  dt: number,
  brakeTempC: number = ambientC,
  rimSpeedMs: number = rollSpeedMs,
  surface: 'asphalt' | 'road' | 'pitlane' | 'kerb' | 'runoff' | 'grass' | 'gravel' = 'asphalt',
  marbleLevel: number = 0
): void {
  const v = Math.abs(rollSpeedMs);
  const n = t.nodes;
  const q = heatFlow;
  q.fill(0);
  const loaded = fz > 1;

  // A rain tyre on a dry road squirms its tread blocks and runs hot; water on the road cools every tread
  const traits = t.spec.wet ?? SLICK_TRAITS;
  const heatScale = wetHeatScale(traits, t.wetness);
  const slipHeat = 0.45 * slipPowerW * heatScale;
  const rollingHeat = 0.0105 * fz * v * heatScale;
  const wetCool = loaded ? wetRoadCoolingWK(t.wetness, v) : 0;
  const wetExtCool = wetExternalGasCoolingWK(t.wetness, v);
  const wetRimGasCool = rimWetEnvironmentCoolingWK(t.wetness, v);
  const airSurface = (4 + 0.9 * v + wetExtCool * 0.4) / 3;
  const sidewall = 0.5 * (4 + 0.3 * v + wetExtCool);

  let gasIn = G_RIM_GAS * (brakeTempC - t.gasTempC) - wetRimGasCool * (t.gasTempC - ambientC);
  for (let b = 0; b < TYRE_BANDS; b++) {
    const w = t.bandLoad[b];
    const iS = node(b, 0);
    const iB = node(b, 1);
    const iC = node(b, 2);
    // Inputs
    q[iS] += slipHeat * w;
    q[iB] += 0.7 * rollingHeat * w;
    q[iC] += 0.3 * rollingHeat * w;
    // Surface: air, track contact, conduction into the bulk
    q[iS] -= airSurface * (n[iS] - ambientC);
    if (loaded) q[iS] -= (12 + wetCool) * w * (n[iS] - trackC);
    const sb = G_SURFACE_BULK * (n[iS] - n[iB]);
    q[iS] -= sb;
    q[iB] += sb;
    // Bulk → carcass
    const bc = G_BULK_CARCASS * (n[iB] - n[iC]);
    q[iB] -= bc;
    q[iC] += bc;
    // Carcass → sidewall air (edge bands) and the gas
    if (b !== 1) q[iC] -= sidewall * (n[iC] - ambientC);
    const cg = G_CARCASS_GAS * (n[iC] - t.gasTempC);
    q[iC] -= cg;
    gasIn += cg;
  }
  // Lateral conduction between neighbouring bands
  for (let layer = 0; layer < 3; layer++) {
    for (let b = 0; b < TYRE_BANDS - 1; b++) {
      const i = node(b, layer);
      const j = node(b + 1, layer);
      const flow = G_LATERAL[layer] * (n[i] - n[j]);
      q[i] -= flow;
      q[j] += flow;
    }
  }

  const caps = [C_SURFACE, C_BULK, C_CARCASS];
  let sumS = 0;
  let sumB = 0;
  for (let i = 0; i < 9; i++) {
    const layer = i % 3;
    n[i] = Math.max(ambientC - 5, Math.min(layer === 0 ? 220 : 180, n[i] + (q[i] / caps[layer]) * dt));
    if (layer === 0) sumS += n[i];
    else if (layer === 1) sumB += n[i];
  }
  t.gasTempC = Math.max(ambientC - 5, Math.min(180, t.gasTempC + (gasIn / C_GAS) * dt));
  t.surfaceTempC = sumS / 3;
  t.coreTempC = sumB / 3;
  updateInflation(t);

  // Abrasive wear proportional to sliding energy (rate per compound, see the tyre spec)
  t.wear = Math.min(1, t.wear + slipPowerW * dt * t.spec.wearPerJ * t.wearScale * wetWearScale(traits, t.wetness));

  // Circumferential flat-spot grid, graining/blistering, and surface contamination
  stepFlatSpot(t, slipPowerW, rollSpeedMs, rimSpeedMs, dt);
  stepGrainBlister(t, slipPowerW, fz, dt);
  stepDirtyLevel(t, surface, slipPowerW, rollSpeedMs, dt, marbleLevel);
}

