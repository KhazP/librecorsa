/**
 * Fixed ambient pressure for tyre inflation (psi absolute). The sim exposes altitude/air density for
 * aero, but no shared atmospheric-pressure state; tyre gas calculations assume standard atmosphere.
 */
const ATMOSPHERIC_PRESSURE_PSI = 14.6959;
const KELVIN = 273.15;

/** Constant-volume ideal gas: input/output in psi gauge, temperatures in °C; only P_absolute/T is constant. */
export function tyreGaugePressureAtTemperature(pressurePsi: number, fromTempC: number, toTempC: number): number {
  return ((pressurePsi + ATMOSPHERIC_PRESSURE_PSI) * (toTempC + KELVIN)) / (fromTempC + KELVIN) - ATMOSPHERIC_PRESSURE_PSI;
}

/**
 * The gas's pressure as it heats from the garage's `fromTempC` to `gasC`, with the carcass stretching under the rise:
 * the ideal-gas rise ΔP shrinks by 1 / (1 + `stretchPerPsi` · ΔP) on the absolute pressure (psi gauge in and out)
 */
export function tyreGaugePressureOfGas(coldPsi: number, fromTempC: number, gasC: number, stretchPerPsi = 0): number {
  const cold = coldPsi + ATMOSPHERIC_PRESSURE_PSI;
  const raw = (cold * (gasC + KELVIN)) / (fromTempC + KELVIN);
  const abs = stretchPerPsi > 0 ? raw / (1 + stretchPerPsi * Math.max(0, raw - cold)) : raw;
  return abs - ATMOSPHERIC_PRESSURE_PSI;
}

/**
 * The inverse of `tyreGaugePressureOfGas`: the pressure to set at `coldTempC` for the tyre to reach `hotPsi` with its gas
 * at `gasC` (psi gauge in and out). With r the gas's temperature ratio and A the hot absolute pressure, the cold
 * absolute pressure is A / (r − A·β·(r − 1))
 */
export function tyreColdPressureForGas(hotPsi: number, coldTempC: number, gasC: number, stretchPerPsi = 0): number {
  const r = (gasC + KELVIN) / (coldTempC + KELVIN);
  const a = hotPsi + ATMOSPHERIC_PRESSURE_PSI;
  const denom = r - (r > 1 ? a * stretchPerPsi * (r - 1) : 0);
  return a / denom - ATMOSPHERIC_PRESSURE_PSI;
}
