/**
 * What each car can do, measured on its own physics (scripts/ai/measure-ggv.ts): steady cornering, braking (with the
 * AI's ABS) and traction (with TC) against speed, on level ground. The AI plans its speeds from these, so its plan is
 * the car's real limit rather than a separate hand-set model of it.
 *
 * Vertical load: the measured lateral and braking limits are μ·(g + downforce/m) on level ground. Over a crest or in
 * a compression the effective gravity g̃ differs from g; with μ taken as the low-speed limit / g the limit becomes
 * a(v) + μ·(g̃ − g) (TUM's 3D race-track work: the g-g diagram as a function of speed and g̃).
 */
import type { VehicleModelId } from '@/types/f1';

export interface GgvTable {
  speedsMs: readonly number[];
  latG: readonly number[];
  brakeG: readonly number[];
  accelG: readonly number[];
  /**
   * Share of the extra grip μ·(g̃ − g) a compression actually gives (1 = all of it; crests always cost the full loss).
   * Below 1 where the car loses downforce as the road squashes it onto its floor
   */
  compressionGain?: number;
  /** Tightest path at full steering lock, tan(lock) / wheelbase (1/m) */
  lockKappa: number;
}

/** Measured 2026-11-07 with scripts/ai/measure-ggv.ts (warm tyres, half fuel, default setup) */
export const GGV_TABLES: Record<VehicleModelId, GgvTable> = {
  'f12026-car': {
    speedsMs: [15, 25, 35, 45, 55, 65, 75, 85],
    latG: [1.817, 2.101, 2.41, 2.878, 3.447, 4.1, 4.831, 5.355],
    brakeG: [2.002, 2.237, 2.499, 2.856, 3.279, 3.652, 3.818, 3.933],
    accelG: [1.252, 1.327, 1.228, 1.009, 0.761, 0.506, 0.305, 0.015],
    lockKappa: Math.tan((250 / 12.6) * (Math.PI / 180)) / 3.382,
  },
  'amg-gt3': {
    speedsMs: [15, 25, 35, 45, 55, 65, 75, 85],
    latG: [1.579, 1.661, 1.747, 1.886, 2.046, 2.219, 2.404, 2.574],
    brakeG: [1.548, 1.837, 1.92, 2.015, 2.103, 2.176, 2.231, 2.295],
    accelG: [0.894, 0.82, 0.614, 0.462, 0.335, 0.227, 0.128, 0.02],
    lockKappa: Math.tan((320 / 12.6) * (Math.PI / 180)) / 2.65,
  },
  // Measured 2026-11-12 on the rigid-body engine the LC26 ships on (`lc26-engine.ts`)
  lc26: {
    speedsMs: [15, 25, 35, 45, 55, 65, 75, 85],
    latG: [1.789, 2.072, 2.412, 2.913, 3.455, 4.036, 4.499, 4.655],
    brakeG: [1.977, 2.133, 2.447, 2.898, 3.481, 3.946, 4.397, 4.819],
    accelG: [1.122, 1.207, 1.305, 1.146, 0.842, 0.555, 0.27, -0.078],
    // Rwanda's banked dip at s ≈ 640 m (g̃ ≈ 2.1 g at 262 km/h): front tyres saturated at ~4.5 g, barely above the
    // flat-road limit; the ride height lost to the load costs the floor most of what the load adds
    compressionGain: 0.15,
    lockKappa: Math.tan((270 / 14) * (Math.PI / 180)) / 3.4,
  },
  // Measured 2026-11-08 to its 50 m/s top end (the road car's own grid)
  liana: {
    speedsMs: [10, 15, 20, 25, 30, 35, 40, 45, 50],
    latG: [0.73, 0.73, 0.74, 0.74, 0.74, 0.73, 0.74, 0.74, 0.75],
    brakeG: [0.8, 0.81, 0.87, 0.87, 0.89, 0.92, 0.92, 0.94, 0.96],
    accelG: [0.37, 0.28, 0.24, 0.18, 0.15, 0.12, 0.08, 0.05, 0.02],
    lockKappa: Math.tan(36 * (Math.PI / 180)) / 2.46,
  },
  // Measured 2026-11-09
  'mtr-496r': {
    speedsMs: [15, 25, 35, 45, 55, 65, 75, 85],
    latG: [1.53, 1.62, 1.74, 1.9, 2.09, 2.29, 2.54, 2.78],
    brakeG: [1.68, 1.88, 2.02, 2.23, 2.52, 2.88, 3.29, 3.63],
    accelG: [1.01, 0.98, 0.81, 0.64, 0.46, 0.29, 0.14, 0],
    lockKappa: Math.tan((240 / 14) * (Math.PI / 180)) / 2.8,
  },
  // Measured 2026-11-13
  'nissan-r33-jgtc': {
    speedsMs: [15, 25, 35, 45, 55, 65, 75, 85],
    latG: [1.37, 1.46, 1.6, 1.77, 1.94, 2.14, 2.33, 2.49],
    brakeG: [1.27, 1.48, 1.53, 1.58, 1.62, 1.68, 1.74, 1.81],
    accelG: [0.78, 0.69, 0.43, 0.34, 0.24, 0.13, 0.01, -0.36],
    lockKappa: Math.tan((250 / 15) * (Math.PI / 180)) / 2.72,
  },
  // Measured 2026-11-13. Its brakeG at 15 and 35 m/s read 1.02 and 1.01: the auto box's 300 ms down-shift and blip
  // land in the measuring window there, so those two are taken between their neighbours (the brakes' own ≈ 1.25 g)
  'nissan-r32-jtcc': {
    speedsMs: [15, 25, 35, 45, 55, 65, 75, 85],
    latG: [1.14, 1.17, 1.18, 1.18, 1.17, 1.15, 1.15, 1.14],
    brakeG: [1.2, 1.22, 1.3, 1.37, 1.41, 1.48, 1.51, 1.59],
    accelG: [0.79, 0.57, 0.52, 0.37, 0.24, 0.17, 0.05, -0.02],
    lockKappa: Math.tan((360 / 12.4) * (Math.PI / 180)) / 2.62,
  },
};

export const G = 9.81;

function interp(xs: readonly number[], ys: readonly number[], x: number, extrapolateTail: boolean): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) {
    if (!extrapolateTail) return ys[n - 1];
    const slope = (ys[n - 1] - ys[n - 2]) / (xs[n - 1] - xs[n - 2]);
    return ys[n - 1] + slope * (x - xs[n - 1]);
  }
  let i = 1;
  while (xs[i] < x) i++;
  const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[i - 1] + (ys[i] - ys[i - 1]) * t;
}

/** A car's limits as functions of speed (m/s) and effective vertical gravity g̃ (m/s²), in m/s² */
export class CarLimits {
  private readonly muLat: number;
  private readonly muBrake: number;
  private readonly compression: number;

  constructor(
    readonly table: GgvTable,
    /** Share of the measured limits planned on (the driver's margin; skill moves it) */
    public gripScale = 0.97
  ) {
    this.muLat = table.latG[0];
    this.muBrake = table.brakeG[0];
    this.compression = table.compressionGain ?? 1;
  }

  /**
   * Tightest curvature a line may ask of the car: full lock less the front slip a hairpin needs and the tracker's
   * room to correct (a line inside a Monaco hairpin at 5 m radius left the cars 8 m wide of it)
   */
  get maxKappa(): number {
    return this.table.lockKappa * 0.85;
  }

  /** Extra vertical load over level ground (m/s²), as far as it turns into grip */
  private extraLoad(gEff: number): number {
    const d = gEff - G;
    return d > 0 ? d * this.compression : d;
  }

  lateral(v: number, gEff = G): number {
    return Math.max(0.5, interp(this.table.speedsMs, this.table.latG, v, false) * G + this.muLat * this.extraLoad(gEff)) * this.gripScale;
  }

  braking(v: number, gEff = G): number {
    return Math.max(0.5, interp(this.table.speedsMs, this.table.brakeG, v, false) * G + this.muBrake * this.extraLoad(gEff)) * this.gripScale;
  }

  /** Forward acceleration at full throttle on level ground (power, traction and drag); falls to 0 at top speed */
  traction(v: number): number {
    return Math.max(0, interp(this.table.speedsMs, this.table.accelG, v, true) * G);
  }

  /** Top speed on level ground (m/s): where traction reaches 0 */
  get topSpeedMs(): number {
    let v = this.table.speedsMs[0];
    while (v < 120 && this.traction(v) > 0.05) v += 0.5;
    return v;
  }
}

export const carLimitsFor = (vehicle: VehicleModelId | undefined, gripScale = 0.97) =>
  new CarLimits(GGV_TABLES[vehicle ?? 'f12026-car'] ?? GGV_TABLES['f12026-car'], gripScale);
