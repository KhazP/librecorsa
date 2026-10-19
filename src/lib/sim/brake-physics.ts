/**
 * Physical Brake System (`src/lib/sim/brake-physics.ts`)
 *
 * Implements:
 * - 2-node (surface + core) brake disc thermal network per corner (`BrakeDiscState`).
 * - Speed-dependent vane convection + Stefan-Boltzmann T^4 radiative heat dissipation.
 * - Double-sigmoid pad/disc friction efficiency curve `evaluateBrakePadMuFactor(tempC, compound)`
 *   capturing cold bite loss ("green" / cold carbon discs) and high-temperature thermal fade:
 *   - `'carbon-ceramic'` (F1 carbon-carbon discs: soft cold bite below ~130 °C, full from ~180 °C, fade > 950 °C)
 *   - `'endurance-steel'` (GT3 cast-iron discs: cold bite below 75 °C, optimal 95–680 °C, fade > 720 °C)
 * - Cumulative pad glazing degradation (`padGlazingFactor`) under sustained extreme overheating.
 * - WEC / F1 Dynamic Brake Migration (`computeDynamicBrakeMigration`) that shifts effective brake
 *   bias forward at high hydraulic pressure and rearward during trail-braking release.
 */

export type BrakeCompoundKind = 'carbon-ceramic' | 'endurance-steel';

export interface BrakeDiscState {
  /** Friction face surface temperature (°C) */
  surfaceTempC: number;
  /** Internal disc vane / bell core temperature (°C) */
  coreTempC: number;
  /** Cumulative pad glazing degradation from severe overheating (0 = fresh, 1 = heavily glazed) */
  padGlazingFactor: number;
  /** Current effective pad friction multiplier (0.55..1.0) */
  muFactor: number;
}

const STEFAN_BOLTZMANN = 5.670374419e-8;
const KELVIN = 273.15;

export function createBrakeDiscState(
  initialTempC = 350,
  compound: BrakeCompoundKind = 'carbon-ceramic'
): BrakeDiscState {
  const s: BrakeDiscState = {
    surfaceTempC: initialTempC,
    coreTempC: initialTempC,
    padGlazingFactor: 0,
    muFactor: 1,
  };
  s.muFactor = evaluateBrakePadMuFactor(initialTempC, compound, 0);
  return s;
}

export function resetBrakeDiscState(
  state: BrakeDiscState,
  tempC: number,
  compound: BrakeCompoundKind = 'carbon-ceramic'
): void {
  state.surfaceTempC = tempC;
  state.coreTempC = tempC;
  state.padGlazingFactor = 0;
  state.muFactor = evaluateBrakePadMuFactor(tempC, compound, 0);
}

function sigmoid(x: number): number {
  if (x >= 12) return 1;
  if (x <= -12) return 0;
  return 1 / (1 + Math.exp(-x));
}

/**
 * Evaluates the double-sigmoid brake pad/disc friction efficiency multiplier:
 * - Returns `1.0` inside the compound's optimal operating window (e.g., 240–920 °C for F1 carbon,
 *   95–680 °C for GT3 steel) so hot-spawn track tests maintain exact reference deceleration.
 * - Drops off smoothly when cold (cold carbon bite loss) or when overheated (thermal fade + glazing).
 */
export function evaluateBrakePadMuFactor(
  surfaceTempC: number,
  compound: BrakeCompoundKind = 'carbon-ceramic',
  padGlazingFactor = 0
): number {
  const glazePenalty = 1 - 0.15 * Math.max(0, Math.min(1, padGlazingFactor));
  if (compound === 'carbon-ceramic') {
    // Cold ramp: ≈0.79 at 20–30 °C -> 0.95 at 120 °C -> ~1.00 by 180 °C. Kept mild on purpose: the AI's and the
    // braking guide's planning assume full bite, and the discs of a car driven normally stay above ~150 °C
    const coldRamp = 0.78 + 0.22 * sigmoid((surfaceTempC - 90) / 22);
    // Hot fade: ~1.00 below 920 °C -> 0.60 at 1200 °C
    const hotFade = 1 - 0.40 * sigmoid((surfaceTempC - 1030) / 42);
    // Normalize plateau in [250..880 °C] to 1.00
    const raw = Math.min(1, coldRamp * hotFade * 1.004);
    return Math.max(0.55, raw * glazePenalty);
  } else {
    // GT3 endurance steel: 0.80 at 20 °C -> ~1.00 by 95 °C, fades above 720 °C
    const coldRamp = 0.78 + 0.22 * sigmoid((surfaceTempC - 48) / 14);
    const hotFade = 1 - 0.42 * sigmoid((surfaceTempC - 790) / 36);
    const raw = Math.min(1, coldRamp * hotFade * 1.003);
    return Math.max(0.55, raw * glazePenalty);
  }
}

/**
 * Steps the 2-node brake disc thermal network for one wheel over `dt` seconds.
 *
 * @param state Mutable `BrakeDiscState` for the corner
 * @param frictionTorqueNm Mechanical friction brake torque applied to the disc (Nm)
 * @param wheelOmegaRadS Wheel angular velocity (rad/s)
 * @param carSpeedMs Longitudinal airspeed for cooling duct convection (m/s)
 * @param ambientC Ambient air temperature (°C)
 * @param dt Integration step (s)
 * @param compound Brake disc/pad material ('carbon-ceramic' | 'endurance-steel')
 * @param coolingScale Brake duct opening: forced-air convection relative to the baseline duct (1)
 */
export function stepBrakeDiscThermal(
  state: BrakeDiscState,
  frictionTorqueNm: number,
  wheelOmegaRadS: number,
  carSpeedMs: number,
  ambientC: number,
  dt: number,
  compound: BrakeCompoundKind = 'carbon-ceramic',
  coolingScale = 1
): void {
  const isCarbon = compound === 'carbon-ceramic';
  // Heat capacities (J/K): carbon friction ring + pad face (~1150 J/K) and core vanes/bell (~1450 J/K)
  const cSurface = isCarbon ? 1150 : 2100;
  const cCore = isCarbon ? 1450 : 3600;
  const gSurfCore = isCarbon ? 160 : 220; // W/K conduction between friction face and core vanes

  const brakePowerW = Math.max(0, frictionTorqueNm) * Math.abs(wheelOmegaRadS);
  const v = Math.abs(carSpeedMs);

  // Forced-air cooling duct convection (W/K). Carbon: ≈120 W/K in all at 300 km/h, a ≈22 s time constant with the
  // 2600 J/K of the two nodes, so a disc leaves a 15 s straight at ≈300 °C instead of going stone cold
  const hSurf = (isCarbon ? 6.0 + 0.55 * v : 10.0 + 1.35 * v) * coolingScale;
  const hCore = (isCarbon ? 8.0 + 0.7 * v : 14.0 + 1.65 * v) * coolingScale;

  // Stefan-Boltzmann T^4 thermal radiation from glowing rotor faces
  const emissivity = isCarbon ? 0.88 : 0.78;
  const discAreaM2 = isCarbon ? 0.135 : 0.165;
  const tSurfK = Math.max(250, state.surfaceTempC + KELVIN);
  const tAmbK = Math.max(250, ambientC + KELVIN);
  const qRadW =
    emissivity *
    STEFAN_BOLTZMANN *
    discAreaM2 *
    (tSurfK * tSurfK * tSurfK * tSurfK - tAmbK * tAmbK * tAmbK * tAmbK);

  const qCondW = gSurfCore * (state.surfaceTempC - state.coreTempC);
  const qConvSurfW = hSurf * (state.surfaceTempC - ambientC);
  const qConvCoreW = hCore * (state.coreTempC - ambientC);

  // 62% of friction heat enters the surface node immediately, 38% conducts into the core/pad backing
  const dSurf = ((0.62 * brakePowerW - qCondW - qConvSurfW - qRadW) / cSurface) * dt;
  const dCore = ((0.38 * brakePowerW + qCondW - qConvCoreW) / cCore) * dt;

  const maxTemp = isCarbon ? 1280 : 1020;
  state.surfaceTempC = Math.max(ambientC, Math.min(maxTemp, state.surfaceTempC + dSurf));
  state.coreTempC = Math.max(ambientC, Math.min(maxTemp, state.coreTempC + dCore));

  // Pad glazing accumulation when braking hard above the compound's glazing temperature threshold
  const glazeThresholdC = isCarbon ? 980 : 750;
  if (state.surfaceTempC > glazeThresholdC && brakePowerW > 15_000) {
    const excess = (state.surfaceTempC - glazeThresholdC) / 200;
    state.padGlazingFactor = Math.min(1, state.padGlazingFactor + excess * 0.025 * dt);
  }

  state.muFactor = evaluateBrakePadMuFactor(state.surfaceTempC, compound, state.padGlazingFactor);
}

/**
 * Brake-by-wire brake migration, in the shape of the VF26 mod's `ebb_controller_migration_N.curve` (`0|0  1|N/100`,
 * brake pedal in, additive front-share shift out; setup default Mig6): the set bias at a light pedal, moving
 * linearly forward to `base + migrationRange` at full pedal, so the bias comes back rearward as the driver releases
 * into the corner. The data do not label the sign; forward-at-high-pressure is the F1 convention. Continuous in the
 * pedal (no step as it leaves zero) and never rearward of the set bias. With `rampStart` the shift only begins past
 * that share of the travel (`BMIG_RAMP`): base + (pedal - ramp) / (1 - ramp) x range above it.
 */
export function computeDynamicBrakeMigration(
  baseFrontBias: number,
  brakePedal: number,
  migrationRange = 0.06,
  rampStart = 0
): number {
  const pedal = Math.max(0, Math.min(1, brakePedal));
  const p = rampStart > 0 ? Math.max(0, (pedal - rampStart) / Math.max(1e-6, 1 - rampStart)) : pedal;
  return Math.max(0.35, Math.min(0.75, baseFrontBias + migrationRange * p));
}
