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

import { Lut } from './lut';
import type { Vf26TyreSpec } from './vf26-data';

/** Thermal node index: band (0 inner, 1 middle, 2 outer) × layer (0 surface, 1 bulk, 2 carcass) */
export const TYRE_BANDS = 3;
const node = (band: number, layer: number) => band * 3 + layer;

export interface MagicFormulaShape {
  B: number;
  C: number;
  E: number;
}

export interface TyreRuntime {
  spec: Vf26TyreSpec;
  thermal: Lut;
  tanPeakAngle: number;
  mf: MagicFormulaShape;
  /** Carcass deflection states (m) */
  deflX: number;
  deflY: number;
  /** Thermal nodes (°C), see `node()` */
  nodes: Float64Array;
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
  dt: number;
}

export interface TyreForceOutput {
  /** Longitudinal force in the wheel frame (N, + forward) */
  fx: number;
  /** Lateral force in the wheel frame (N, + left) */
  fy: number;
  /** Self-aligning moment about the vertical axis (Nm, + CCW from above) */
  mz: number;
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
    tanPeakAngle: Math.tan(spec.frictionLimitAngleDeg * DEG2RAD),
    mf: fitMagicFormula(spec.falloffLevel),
    deflX: 0,
    deflY: 0,
    nodes: new Float64Array(9),
    gasTempC: initialTempC,
    coldPressurePsi: coldPressureFor(spec.pressureRefPsi),
    pressurePsi: spec.pressureRefPsi,
    verticalRate: spec.rate,
    bandLoad: [1 / 3, 1 / 3, 1 / 3],
    surfaceTempC: initialTempC,
    coreTempC: initialTempC,
    wear: 0,
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
  t.tanPeakAngle = Math.tan(spec.frictionLimitAngleDeg * DEG2RAD);
  t.mf = fitMagicFormula(spec.falloffLevel);
  updateInflation(t);
}

/** Sets the cold inflation pressure (psi at COLD_REF_C) and updates the hot pressure and radial rate */
export function setTyreColdPressure(t: TyreRuntime, coldPsi: number): void {
  t.coldPressurePsi = coldPsi;
  updateInflation(t);
}

/** Sets every node and the gas to one temperature (tyre blankets) */
export function setTyreTemperature(t: TyreRuntime, tempC: number): void {
  t.nodes.fill(tempC);
  t.gasTempC = tempC;
  t.surfaceTempC = tempC;
  t.coreTempC = tempC;
  updateInflation(t);
}

/** Surface temperature of one band (0 inner, 1 middle, 2 outer) */
export function tyreBandSurfaceTempC(t: TyreRuntime, band: number): number {
  return t.nodes[node(band, 0)];
}

function updateInflation(t: TyreRuntime): void {
  t.pressurePsi = (t.coldPressurePsi * (t.gasTempC + KELVIN)) / (COLD_REF_C + KELVIN);
  const rel = t.pressurePsi / t.spec.pressureRefPsi;
  t.verticalRate = t.spec.rate * (1 - RATE_PRESSURE_SHARE + RATE_PRESSURE_SHARE * rel);
}

/**
 * Effective rolling radius under load. The tyre squashes by δ = Fz / k; a radial tyre's rolling
 * radius drops by about δ/3. The mod radius is taken as the rolling radius at the reference load.
 */
export function tyreRollingRadius(t: TyreRuntime, fz: number): number {
  const spec = t.spec;
  const delta = Math.min(0.06, Math.max(0, fz) / t.verticalRate);
  const deltaRef = spec.fz0 / spec.rate;
  return spec.radius - (delta - deltaRef) / 3;
}

/**
 * Free (unloaded) radius (m). The rolling radius is R_unloaded − δ/3 (see `tyreRollingRadius`) and the mod
 * radius is the rolling radius at the reference load, so R_unloaded = spec.radius + (FZ0/rate)/3. This is the
 * nominal value; the geometry of the rendered tyre is taken from the mesh instead.
 */
export function tyreUnloadedRadius(t: TyreRuntime): number {
  return t.spec.radius + t.spec.fz0 / t.spec.rate / 3;
}

/** Radial deflection δ (m) under vertical load `fz` = Fz / current radial rate, clamped to [0, 0.06] as above */
export function tyreVerticalDeflection(t: TyreRuntime, fz: number): number {
  return Math.min(0.06, Math.max(0, fz) / t.verticalRate);
}

/** Loaded radius (m) = R_unloaded − δ, where δ = Fz / radial rate (see `tyreVerticalDeflection`) */
export function tyreLoadedRadius(t: TyreRuntime, fz: number): number {
  return tyreUnloadedRadius(t) - tyreVerticalDeflection(t, fz);
}

/** Grip from temperature: the performance curve per band, weighted by each band's contact share */
function thermalGrip(t: TyreRuntime): number {
  let g = 0;
  for (let b = 0; b < TYRE_BANDS; b++) {
    const gripTemp = 0.6 * t.nodes[node(b, 0)] + 0.4 * t.nodes[node(b, 1)];
    g += t.bandLoad[b] * t.thermal.evaluate(gripTemp);
  }
  return g;
}

/**
 * Advances the carcass deflection states and returns the contact forces.
 */
export function computeTyreForces(t: TyreRuntime, inp: TyreForceInput): TyreForceOutput {
  const spec = t.spec;
  const sigmaY = spec.relaxationLength;
  const sigmaX = spec.relaxationLength * 0.7;
  const absVx = Math.abs(inp.vx);
  const slipVelX = inp.rimSpeed - inp.vx; // + when the tyre is driving
  const slipVelY = inp.vy;

  // Relaxation-length carcass dynamics, integrated exactly over dt:
  //   d(defl)/dt = slipVel − |vx|/σ · defl
  const decayX = absVx / sigmaX;
  const decayY = absVx / sigmaY;
  if (decayX > 1e-6) {
    const ssX = slipVelX / decayX;
    const ssY = slipVelY / decayY;
    const ex = Math.exp(-decayX * inp.dt);
    const ey = Math.exp(-decayY * inp.dt);
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
      fx: 0, fy: 0, mz: 0, slipRatio: 0, slipAngle: 0, normSlip: 0, mu: 0, gripFactor: 1, slipPower: 0,
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

  // Load sensitivity (AC: D = D_REF · (Fz/FZ0)^(LS_EXP − 1))
  const loadRatio = Math.max(0.15, inp.fz / spec.fz0);
  let muY = spec.dyRef * Math.pow(loadRatio, spec.lsExpY - 1);
  let muX = spec.dxRef * Math.pow(loadRatio, spec.lsExpX - 1);

  // Temperature (per band) and inflation pressure
  const thermal = thermalGrip(t);
  const pRel = t.pressurePsi / spec.pressureRefPsi - 1;
  const pressureGrip = Math.max(0.8, 1 - PRESSURE_GRIP_LOSS * pRel * pRel);
  const wearMult = wearGripMultiplier(t.wear);

  // Camber (γ positive when leaning into the lateral force direction)
  const dirY = s > 1e-9 ? -sa / s : 0;
  const gamma = inp.camberLeftRad;
  const camberLat = 1 + spec.dcamber0 * gamma * Math.sign(dirY) * Math.min(1, Math.abs(dirY) * 4) + spec.dcamber1 * gamma * gamma;
  const camberLong = 1 + spec.dcamber1 * gamma * gamma;

  // Sliding-speed sensitivity
  const slideSpeed = Math.hypot(slipVelX, slipVelY) * Math.min(1, Math.max(0, s - 0.6));
  const speedSens = 1 / (1 + spec.speedSensitivity * slideSpeed);

  const common = thermal * pressureGrip * wearMult * speedSens * inp.surfaceGrip;
  muY *= common * Math.max(0.75, camberLat);
  muX *= common * Math.max(0.75, camberLong);

  const f = magicFormula(s, t.mf);
  let fx = 0;
  let fy = 0;
  if (s > 1e-9) {
    fx = (inp.fz * muX * f * sk) / s;
    fy = (-inp.fz * muY * f * sa) / s;
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
  // peak, so the steering goes light at the limit
  const contactLength = 2 * Math.sqrt(Math.max(1e-4, spec.radius * (inp.fz / t.verticalRate)));
  const trail0 = contactLength / 6;
  const absSa = Math.abs(sa);
  const trail = absSa <= 1 ? trail0 * (1 - absSa) * (1 - Math.min(0.6, Math.abs(sk) * 0.3)) : -trail0 * 0.08 * Math.min(1, absSa - 1);
  const mz = -trail * fy;

  // Contact pressure across the tread: camber leaning toward the car loads the inner shoulder,
  // the lateral force rolls the patch onto the shoulder away from the force, over-inflation crowns it
  const inward = inp.inwardSign ?? 1;
  const camberIn = inward * gamma;
  const fyIn = (inward * fy) / inp.fz;
  const shift = Math.max(-0.85, Math.min(0.85, BAND_CAMBER_SHIFT * camberIn - BAND_LATERAL_SHIFT * fyIn));
  const crown = Math.max(0.6, Math.min(1.6, 1 + BAND_CROWN * pRel));
  const norm = 1 / (2 + crown);
  t.bandLoad[0] = (1 + shift) * norm;
  t.bandLoad[1] = crown * norm;
  t.bandLoad[2] = (1 - shift) * norm;

  const slipPower = Math.abs(fx * slipVelX) + Math.abs(fy * slipVelY);

  return {
    fx,
    fy,
    mz,
    slipRatio: (t.deflX / sigmaX),
    slipAngle: Math.atan(t.deflY / sigmaY),
    normSlip: s,
    mu: muY,
    gripFactor: thermal * pressureGrip * wearMult * Math.max(0.75, camberLat),
    slipPower,
  };
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
 * 9-node tyre thermal model plus the inflation gas, with ideal-gas pressure.
 *
 * - Sliding friction heat (|Fx·vsx| + |Fy·vsy|) goes into the surface layer, and rolling hysteresis
 *   (∝ Fz·v) into the bulk and carcass, both spread over the bands by contact pressure.
 * - The surface is cooled by the air (speed-dependent convection) and the track, the carcass by the
 *   sidewalls (edge bands) and the gas. Heat conducts through the layers and across the bands.
 * - The gas follows the carcass and the brake-heated rim; its temperature sets the pressure.
 *
 * The coefficients are assumed (the mod's thermal block is in an undocumented format), calibrated on
 * AI laps at Rwanda: the soft compound settles in its 95–110 °C window over a stint.
 */
export function updateTyreThermal(
  t: TyreRuntime,
  slipPowerW: number,
  fz: number,
  rollSpeedMs: number,
  ambientC: number,
  trackC: number,
  dt: number,
  brakeTempC: number = ambientC
): void {
  const v = Math.abs(rollSpeedMs);
  const n = t.nodes;
  const q = heatFlow;
  q.fill(0);
  const loaded = fz > 1;

  const slipHeat = 0.45 * slipPowerW;
  const rollingHeat = 0.0105 * fz * v;
  const airSurface = (4 + 0.9 * v) / 3;
  const sidewall = 0.5 * (4 + 0.3 * v);

  let gasIn = G_RIM_GAS * (brakeTempC - t.gasTempC);
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
    if (loaded) q[iS] -= 12 * w * (n[iS] - trackC);
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
  t.wear = Math.min(1, t.wear + slipPowerW * dt * t.spec.wearPerJ);
}
