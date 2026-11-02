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
