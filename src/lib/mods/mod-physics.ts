import type { CarSimProfile } from "@/lib/sim/f12026-car/F12026CarSim";

/**
 * A mod car's own physics: a patch on one of the game's vehicle models (`physics.base` in mod.json), written as the
 * parts of that model's `CarSimProfile` it changes: its config (mass, engine, gearbox, aero, tyres, suspension…), its
 * electronics, its braking envelope and the rest. The game's one car simulation (F12026CarSim) runs it, on the page or
 * in the simulation worker, exactly as it runs the game's own cars. Its garage, AI and HUD are the base model's.
 *
 * The patch can only change what the base model has, value for value of the same kind: a number for a number, a list
 * for a list, an object merged key by key. A key the base hasn't got, or a value of another kind, is a problem named by
 * its path, so a typo never passes as a car that drives like the base. Numbers must be finite.
 *
 *   {
 *     "format": 1,
 *     "profile": {
 *       "config": { "chassis": { "mass_kg": 1180 }, "engine": { "torque_curve": [[1000, 300], [7500, 520]] } },
 *       "turbo": true
 *     }
 *   }
 */

export const MOD_PHYSICS_FORMAT = 1;

/** Top-level profile keys a patch may set even when the base model leaves them out (their defaults apply there) */
const OPTIONAL_PROFILE_KEYS: ReadonlySet<string> = new Set([
  "understeerRadPerMs2",
  "fuelFlowKgS",
  "fuelLPerS1000Rpm",
  "steerRatio",
  "setupPressureRefC",
  "aiMaxKerbRiseM",
]);

/** What a patch may never set: the profile's identity and the body outline (mod.json's `bodyPlan`) */
const LOCKED_PROFILE_KEYS: ReadonlySet<string> = new Set(["id", "model", "bodyPlan"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const kindOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "list" : typeof v);

function mergeValue(base: unknown, patch: unknown, path: string, problems: string[]): unknown {
  if (problems.length >= 50) return base;
  if (typeof patch === "number") {
    if (!Number.isFinite(patch)) problems.push(`${path}: must be a finite number`);
    else if (typeof base !== "number") problems.push(`${path}: is a ${kindOf(base)} in the base model, not a number`);
    // A mass, a length, a rate or a stiffness stays above zero: the simulation divides by them
    else if (base > 0 && patch <= 0) problems.push(`${path}: must stay above 0, as the base model's is`);
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
    if (patch.length === 0 || patch.length > 4096) {
      problems.push(`${path}: must hold 1 to 4096 values`);
      return base;
    }
    // Every element is checked against the base's first, the shape a table (a torque curve, gear ratios) keeps
    const template = base[0];
    return patch.map((item, i) => (template === undefined ? item : mergeValue(template, item, `${path}[${i}]`, problems)));
  }
  if (isRecord(patch)) {
    if (!isRecord(base)) {
      problems.push(`${path}: is a ${kindOf(base)} in the base model, not an object`);
      return base;
    }
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in base)) {
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
    if (LOCKED_PROFILE_KEYS.has(key)) {
      problems.push(`profile.${key}: set by the game (bodyPlan goes in mod.json)`);
      continue;
    }
    if (!(key in out)) {
      if (OPTIONAL_PROFILE_KEYS.has(key) && typeof value === "number" && Number.isFinite(value)) out[key] = value;
      else problems.push(`profile.${key}: the base model has no such value`);
      continue;
    }
    out[key] = mergeValue(out[key], value, `profile.${key}`, problems);
  }
  if (problems.length) return { ok: false, errors: problems.slice(0, 50) };
  out.id = id;
  // It drives as the base model everywhere but its own plans: setups, fuel, wing steps, AI, HUD
  out.model = (base.model ?? base.id) as CarSimProfile["model"];
  if (bodyPlan) out.bodyPlan = bodyPlan;
  return { ok: true, profile: out as unknown as CarSimProfile };
}
