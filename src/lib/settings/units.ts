import type { PressureUnit, SpeedUnit, TemperatureUnit, UnitSettings } from "./player-settings";

/**
 * Unit conversion for everything the UI prints. The simulation works in km/h, °C and bar; these turn a value into
 * the player's unit at the last moment, so no component converts by hand.
 */
export const DEFAULT_UNITS: UnitSettings = { speed: "kmh", temperature: "c", pressure: "bar" };

export const SPEED_LABEL: Record<SpeedUnit, string> = { kmh: "km/h", mph: "mph" };
export const TEMPERATURE_LABEL: Record<TemperatureUnit, string> = { c: "°C", f: "°F" };
export const PRESSURE_LABEL: Record<PressureUnit, string> = { bar: "bar", psi: "psi" };

const KMH_PER_MPH = 1.609344;
const PSI_PER_BAR = 14.5037738;

/** A speed in km/h, in the player's unit */
export const speedIn = (kmh: number, unit: SpeedUnit): number => (unit === "mph" ? kmh / KMH_PER_MPH : kmh);
/** A temperature in °C, in the player's unit */
export const temperatureIn = (celsius: number, unit: TemperatureUnit): number => (unit === "f" ? (celsius * 9) / 5 + 32 : celsius);
/** A temperature difference in °C (a delta, not a reading), in the player's unit */
export const temperatureDeltaIn = (celsius: number, unit: TemperatureUnit): number => (unit === "f" ? (celsius * 9) / 5 : celsius);
/** A pressure in bar, in the player's unit */
export const pressureIn = (bar: number, unit: PressureUnit): number => (unit === "psi" ? bar * PSI_PER_BAR : bar);
/** Decimal places a pressure is shown with: 2 in bar, 1 in psi */
export const pressureDecimals = (unit: PressureUnit): number => (unit === "psi" ? 1 : 2);
/** A distance in km, in the unit that goes with the speed unit */
export const distanceIn = (km: number, unit: SpeedUnit): number => (unit === "mph" ? km / KMH_PER_MPH : km);
export const DISTANCE_LABEL: Record<SpeedUnit, string> = { kmh: "km", mph: "mi" };

const FEET_PER_METRE = 3.280839895;
/** A height or short length in metres (elevation, altitude, a gap in metres), in the unit that goes with the speed unit */
export const heightIn = (metres: number, unit: SpeedUnit): number => (unit === "mph" ? metres * FEET_PER_METRE : metres);
export const HEIGHT_LABEL: Record<SpeedUnit, string> = { kmh: "m", mph: "ft" };

const CM_PER_INCH = 2.54;
/** A small length in centimetres (a seat offset), in the unit that goes with the speed unit */
export const smallLengthIn = (cm: number, unit: SpeedUnit): number => (unit === "mph" ? cm / CM_PER_INCH : cm);
export const SMALL_LENGTH_LABEL: Record<SpeedUnit, string> = { kmh: "cm", mph: "in" };
