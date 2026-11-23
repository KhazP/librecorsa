/**
 * The minimum-lap-time line of scripts/ai/mintime/solve.py (optimal control of a single-track car with yaw inertia and
 * load transfer, CasADi + IPOPT) as a start for scripts/ai/optimize-lines.ts: writes the problem from the AI grid, the
 * line's bounds and the car, runs the solver through uv, and reads the line back onto the grid.
 *
 * Needs `uv` on PATH; the solver's packages (scripts/ai/mintime/requirements.txt) are fetched on the first run.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiTrack } from '../../../src/lib/sim/ai/ai-track';
import { GGV_TABLES } from '../../../src/lib/sim/ai/ggv';
import type { VehicleModelId } from '../../../src/types/f1';
import type { LineBounds, RunSpec } from './line-opt';

/** The chassis values the solver's car needs (`CarPhysicsConfig.chassis`) */
export interface MintimeChassis {
  totalMassKg: number;
  frontWeightFraction: number;
  wheelbase: number;
  cgHeight: number;
  inertia: { yaw: number };
  maxRoadWheelDeg: number;
}

export interface MintimeOptions {
  /** Grid points per optimal-control interval (2 on a 2 m grid: 4 m intervals) */
  step?: number;
  /** Plan grip: the share of the measured limits planned on, as the speed plan's `gripScale` */
  grip?: number;
  run?: RunSpec;
  /** Peak-grip slip angle of the lateral tyre curve (rad) */
  alphaPeak?: number;
  maxIter?: number;
  verbose?: boolean;
  log?: (msg: string) => void;
}

export interface MintimeLine {
  /** Lateral offset per grid point (m, + right, the AI grid's sign) */
  n: Float64Array;
  /** The solver's speed per grid point (m/s) */
  v: Float64Array;
  lapS: number;
  solved: boolean;
  status: string;
}

/** The solver's problem (problem.json of scripts/ai/mintime/solve.py); null for a car with no measured limits */
export function mintimeProblem(
  t: AiTrack,
  bounds: LineBounds,
  start: ArrayLike<number>,
  startV: ArrayLike<number>,
  vehicle: VehicleModelId,
  chassis: MintimeChassis,
  opts: MintimeOptions = {}
): Record<string, unknown> | null {
  const table = GGV_TABLES[vehicle];
  if (!table) return null;
  // The solver's frame: + left, curvature + turning left (the AI grid's are + right)
  const neg = (a: ArrayLike<number>) => Array.from(a, (x) => -x);
  return {
    ds: t.ds,
    kappa: neg(t.kappa),
    lo: neg(bounds.hi),
    hi: neg(bounds.lo),
    slope: Array.from(t.slope),
    bank: Array.from(t.bank),
    vcurv: Array.from(t.vcurv),
    n0: neg(start),
    v0: Array.from(startV),
    step: opts.step ?? 2,
    closed: !opts.run,
    ...(opts.run ? { finishI: opts.run.finishI } : {}),
    maxIter: opts.maxIter ?? 3000,
    verbose: !!opts.verbose,
    car: {
      mass: chassis.totalMassKg,
      frontWeightFraction: chassis.frontWeightFraction,
      wheelbase: chassis.wheelbase,
      cgHeight: chassis.cgHeight,
      yawInertia: chassis.inertia.yaw,
      // Full lock less the slip a hairpin needs and room to correct, as the speed plan's `maxKappa`
      deltaMax: Math.atan(table.lockKappa * 0.85 * chassis.wheelbase),
      speeds: table.speedsMs,
      latG: table.latG,
      brakeG: table.brakeG,
      accelG: table.accelG,
      grip: opts.grip ?? 0.95,
      alphaPeak: opts.alphaPeak ?? 0.1,
    },
  };
}

export function mintimeLine(
  t: AiTrack,
  bounds: LineBounds,
  start: ArrayLike<number>,
  startV: ArrayLike<number>,
  vehicle: VehicleModelId,
  chassis: MintimeChassis,
  opts: MintimeOptions = {}
): MintimeLine | null {
  const problem = mintimeProblem(t, bounds, start, startV, vehicle, chassis, opts);
  if (!problem) return null;
  const dir = mkdtempSync(join(tmpdir(), 'mintime-'));
  try {
    const inPath = join(dir, 'problem.json'), outPath = join(dir, 'line.json');
    writeFileSync(inPath, JSON.stringify(problem));
    const r = spawnSync(
      'uv',
      ['run', '--no-project', '--python', '3.12', '--with-requirements', 'scripts/ai/mintime/requirements.txt', 'python', '-I', 'scripts/ai/mintime/solve.py', inPath, outPath],
      { encoding: 'utf8', stdio: ['ignore', opts.verbose ? 'inherit' : 'pipe', 'pipe'], maxBuffer: 64 << 20 }
    );
    const tail = (r.stderr ?? '').split('\n').filter((l) => l.startsWith('mintime:'));
    for (const l of tail) (opts.log ?? console.log)(l);
    if (r.status !== 0) {
      (opts.log ?? console.log)(`mintime: the solver failed (${r.error?.message ?? `exit ${r.status}`}): ${(r.stderr ?? '').slice(-600)}`);
      return null;
    }
    const out = JSON.parse(readFileSync(outPath, 'utf8')) as { n: number[]; v: number[]; lapS: number; status: string };
    return { n: Float64Array.from(out.n, (x) => -x), v: Float64Array.from(out.v), lapS: out.lapS, solved: out.status === 'solved', status: out.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
