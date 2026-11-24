import type { CarSimProfile } from "@/lib/sim/f12026-car/F12026CarSim";

/**
 * A mod car's own physics: a patch on one of the game's vehicle models (`physics.base` in mod.json), written as the
 * parts of that model's `CarSimProfile` it changes: its config (mass, engine, gearbox, aero, tyres, suspension…), its
 * electronics, its braking envelope and the rest. The game's one car simulation (F12026CarSim) runs it, on the page or
 * in the simulation worker, exactly as it runs the game's own cars. Its garage, AI and HUD are the base model's.
 *
 * The patch can only change what the base model has, value for value of the same kind: a number for a number, a list
 * for a list, an object merged key by key. A key the base hasn't got, or a value of another kind, is a problem named by
 * its path, so a typo never passes as a car that drives like the base. Numbers must be finite, and what the simulation
 * divides by (a mass, an inertia, the car's and the wheels' dimensions, a gear ratio, a limiter) stays above zero;
 * anything else may be zero (a part switched off) or negative (a position, a camber). Tables keep their shape: a
 * curve's points stay [x, y] pairs in rising x, a suspension point stays [x, y, z], a two-value range stays two values.
 *
 *   {
 *     "format": 1,
 *     "profile": {
 *       "config": { "chassis": { "totalMassKg": 1180 }, "engine": { "powerCurve": [[1000, 90], [7500, 420]] } },
 *       "turbo": true
 *     }
 *   }
 */

export const MOD_PHYSICS_FORMAT = 1;

/**
 * Top-level profile keys a patch may set even when the base model leaves them out (their defaults apply there): each
 * a rate, a ratio or a temperature the simulation divides by or scales with, so above zero
 */
const OPTIONAL_PROFILE_KEYS: ReadonlySet<string> = new Set([
  "understeerRadPerMs2",
  "fuelFlowKgS",
  "fuelLPerS1000Rpm",
  "steerRatio",
  "setupPressureRefC",
  "aiMaxKerbRiseM",
]);

/** What a patch may never set: the profile's identity and the body outline (mod.json's `bodyPlan`) */
const LOCKED_PATHS: ReadonlySet<string> = new Set(["profile.id", "profile.model", "profile.bodyPlan", "profile.config.chassis.bodyPlan"]);

/**
 * Lists whose length is the car's to choose (gears, a height map's breakpoints, a dial's steps). Any other list of two
 * or three numbers is a fixed pair or triple (a range, an [x, y] point, an [x, y, z] position) and keeps its length
 */
const FREE_LENGTH_LISTS: ReadonlySet<string> = new Set(["ratios", "frontRh", "rearRh", "deployStepsKw", "regenStepsKw"]);

/**
 * What the simulation divides by, or can't run without: these stay above zero when the base's are. The rest may be
 * zero or negative, as other models have them (no anti-roll bar, no preload, a roll centre below the ground)
 */
const POSITIVE_KEYS: ReadonlySet<string> = new Set([
  "totalMassKg",
  "unsprungMassFront",
  "unsprungMassRear",
  "wheelInertiaFront",
  "wheelInertiaRear",
  "wheelbase",
  "trackWidthFront",
  "trackWidthRear",
  "cgHeight",
  "radius",
  "rimRadius",
  "width",
  "ratios",
  "finalDrive",
  "redline_rpm",
  "upshift_rpm",
  "downshift_rpm",
  "maxRoadWheelDeg",
  // The engine's inertia (the chassis' is an object, `/\.inertia\./` below), a tyre's peak slip ratio, a turbo's spool
  // times and the speed its boost law is referred to
  "inertia",
  "slip_ratio_limit",
  "spoolUpS",
  "spoolDownS",
  "referenceRpm",
]);
const mustStayPositive = (path: string): boolean => POSITIVE_KEYS.has(keyOf(path)) || /\.inertia\./.test(path) || /[Mm]ass(Kg)?$/.test(keyOf(path));

const MAX_PROBLEMS = 50;

const LOCKED = (path: string): string => `${path}: set by the game (a car's outline is mod.json's bodyPlan)`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const kindOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "list" : typeof v);

const keyOf = (path: string): string => path.slice(path.lastIndexOf(".") + 1).replace(/\[\d+\]$/, "");

/** Every row a list of [x, y] pairs, with x rising: a curve the simulation looks values up in */
const isRisingCurve = (v: readonly unknown[]): boolean =>
  v.length > 1 &&
  v.every((row, i) => Array.isArray(row) && row.length === 2 && typeof row[0] === "number" && (i === 0 || row[0] > (v[i - 1] as number[])[0]));

function mergeList(base: readonly unknown[], patch: readonly unknown[], path: string, problems: string[]): unknown {
  if (patch.length === 0 || patch.length > 4096) {
    problems.push(`${path}: must hold 1 to 4096 values`);
    return base;
  }
  if (base.length === 0) {
    problems.push(`${path}: is empty in the base model, so there is nothing to change`);
    return base;
  }
  const numbers = base.every((x) => typeof x === "number");
  if (numbers && (base.length === 2 || base.length === 3) && !FREE_LENGTH_LISTS.has(keyOf(path)) && patch.length !== base.length) {
    problems.push(`${path}: must hold ${base.length} numbers, as the base model's does`);
    return base;
  }
  // Each item against the base's own at that place (the rear wing against the rear wing), past its end against the first
  const out = patch.map((item, i) => mergeValue(base[i] ?? base[0], item, `${path}[${i}]`, problems));
  if (isRisingCurve(base) && !isRisingCurve(out)) problems.push(`${path}: must be [x, y] points with x rising, as the base model's are`);
  return out;
}

function mergeValue(base: unknown, patch: unknown, path: string, problems: string[]): unknown {
  if (problems.length >= MAX_PROBLEMS) return base;
  if (LOCKED_PATHS.has(path)) {
    problems.push(LOCKED(path));
    return base;
  }
  if (typeof patch === "number") {
    if (!Number.isFinite(patch)) problems.push(`${path}: must be a finite number`);
    else if (typeof base !== "number") problems.push(`${path}: is a ${kindOf(base)} in the base model, not a number`);
    // A mass, a length, a rate or a stiffness stays above zero: the simulation divides by them
    else if (base > 0 && patch <= 0 && mustStayPositive(path)) problems.push(`${path}: must stay above 0, as the base model's is`);
    else return patch;
    return base;
  }
  if (typeof patch === "boolean" || typeof patch === "string") {
    if (typeof base !== typeof patch) {
      problems.push(`${path}: is a ${kindOf(base)} in the base model, not a ${typeof patch}`);
      return base;
    }
    return patch;
  }
  if (Array.isArray(patch)) {
    if (!Array.isArray(base)) {
      problems.push(`${path}: is a ${kindOf(base)} in the base model, not a list`);
      return base;
    }
    return mergeList(base, patch, path, problems);
  }
  if (isRecord(patch)) {
    if (!isRecord(base)) {
      problems.push(`${path}: is a ${kindOf(base)} in the base model, not an object`);
      return base;
    }
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      // Its own keys only: `__proto__`, `constructor` and the like are no value of a profile
      if (!Object.hasOwn(base, key)) {
        problems.push(`${path}.${key}: the base model has no such value`);
        continue;
      }
      out[key] = mergeValue(base[key], value, `${path}.${key}`, problems);
    }
    return out;
  }
  problems.push(`${path}: ${kindOf(patch)} is not a value a profile holds`);
  return base;
}

/** Values that must agree with one another, each fine on its own: what the simulation needs of the whole */
function profileProblems(profile: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const config = isRecord(profile.config) ? profile.config : {};
  const chassis = isRecord(config.chassis) ? config.chassis : {};
  const n = (v: unknown): number => (typeof v === "number" ? v : NaN);
  const front = n(chassis.frontWeightFraction);
  if (!(front > 0 && front < 1)) problems.push("profile.config.chassis.frontWeightFraction: must be between 0 and 1");
  const sprung = n(chassis.totalMassKg) - 2 * n(chassis.unsprungMassFront) - 2 * n(chassis.unsprungMassRear);
  if (!(sprung > 0)) problems.push("profile.config.chassis: totalMassKg must be more than the four wheels' unsprung mass (2 × front + 2 × rear)");
  // A ride-height map: one row per rear height, one value per front height
  const aero = isRecord(config.aero) ? config.aero : {};
  const map = isRecord(aero.rhMap) ? aero.rhMap : null;
  const rising = (v: unknown[]) => v.every((x, i) => typeof x === "number" && (i === 0 || x > (v[i - 1] as number)));
  if (map && Array.isArray(map.frontRh) && Array.isArray(map.rearRh)) {
    for (const axis of ["frontRh", "rearRh"] as const) {
      if (!rising(map[axis] as unknown[])) problems.push(`profile.config.aero.rhMap.${axis}: the heights must rise`);
    }
    for (const grid of ["cl", "cd", "balance"]) {
      const rows = map[grid];
      if (rows === undefined) continue;
      if (!Array.isArray(rows) || rows.length !== map.rearRh.length || !rows.every((r) => Array.isArray(r) && r.length === (map.frontRh as unknown[]).length)) {
        problems.push(`profile.config.aero.rhMap.${grid}: must be ${map.rearRh.length} rows (rearRh) of ${map.frontRh.length} values (frontRh)`);
      }
    }
  }
  return problems;
}

export type ModPhysicsResult = { ok: true; profile: CarSimProfile } | { ok: false; errors: string[] };

/**
 * The profile a mod car drives on: `base` with the physics file's patch made, named `id` (the simulation keeps plans
 * and guides per profile id, so each car's, and each version's, must be its own), wearing `bodyPlan` when given
 */
export function modSimProfile(base: CarSimProfile, file: unknown, id: string, bodyPlan?: readonly (readonly [number, number])[]): ModPhysicsResult {
  if (!isRecord(file)) return { ok: false, errors: ["physics file: must be a JSON object"] };
  if (file.format !== MOD_PHYSICS_FORMAT) return { ok: false, errors: [`physics file: format must be ${MOD_PHYSICS_FORMAT}`] };
  const patch = file.profile;
  if (!isRecord(patch)) return { ok: false, errors: ['physics file: "profile" must be an object of the values it changes'] };
  const problems: string[] = [];
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    const path = `profile.${key}`;
    if (LOCKED_PATHS.has(path)) {
      problems.push(LOCKED(path));
      continue;
    }
    if (!Object.hasOwn(out, key)) {
      if (!OPTIONAL_PROFILE_KEYS.has(key)) problems.push(`${path}: the base model has no such value`);
      else if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) problems.push(`${path}: must be a number above 0`);
      else out[key] = value;
      continue;
    }
    out[key] = mergeValue(out[key], value, path, problems);
  }
  if (!problems.length) problems.push(...profileProblems(out));
  if (problems.length) return { ok: false, errors: problems.slice(0, MAX_PROBLEMS) };
  out.id = id;
  // It drives as the base model everywhere but its own plans: setups, fuel, wing steps, AI, HUD
  out.model = (base.model ?? base.id) as CarSimProfile["model"];
  if (bodyPlan) out.bodyPlan = bodyPlan;
  return { ok: true, profile: out as unknown as CarSimProfile };
}
