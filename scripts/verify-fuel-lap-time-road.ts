/**
 * More fuel is a slower lap, for the road cars (scripts/lib/fuel-lap-time.ts has the checks and the groups; the
 * rest of the fuel setting is verify-setup-sheet.ts).
 * Run: npx tsx scripts/verify-fuel-lap-time-road.ts
 */
import { runFuelLapChecks } from "./lib/fuel-lap-time";

runFuelLapChecks("road");
