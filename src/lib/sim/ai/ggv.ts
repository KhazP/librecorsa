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
  // Measured 2026-11-18 on the endurance trim and its slicks fitted to the reference laps (the BMW M4 GT3 drives on
  // these physics and reads this table too). It tops out near 294 km/h, so it slows at 85 m/s
  'amg-gt3': {
    speedsMs: [15, 25, 35, 45, 55, 65, 75, 85],
    latG: [1.63, 1.711, 1.803, 1.937, 2.083, 2.247, 2.408, 2.487],
    brakeG: [1.68, 1.757, 1.86, 1.985, 2.129, 2.266, 2.337, 2.411],
    accelG: [0.805, 0.718, 0.551, 0.403, 0.272, 0.157, 0.046, -0.397],
    lockKappa: Math.tan((320 / 12.6) * (Math.PI / 180)) / 2.65,
  },
  // Measured 2026-11-12 on the rigid-body engine the LC26 ships on (`lc26-engine.ts`); traction again 2026-11-23 under
  // the 2026 F1 rules' energy (`ers-2026.ts`: the FIA's power curve, Overtake's in practice)
  lc26: {
    speedsMs: [15, 25, 35, 45, 55, 65, 75, 85],
    latG: [1.789, 2.072, 2.412, 2.913, 3.455, 4.036, 4.499, 4.655],
    brakeG: [1.977, 2.133, 2.447, 2.898, 3.481, 3.946, 4.397, 4.819],
    accelG: [1.12, 1.22, 1.35, 1.16, 0.86, 0.58, 0.3, 0.03],
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
  // Measured 2026-11-14
  'lc-lmdh': {
    speedsMs: [15, 25, 35, 45, 55, 65, 75, 85],
    latG: [1.59, 1.74, 1.91, 2.15, 2.43, 2.76, 3.13, 3.43],
    brakeG: [1.69, 1.77, 1.94, 2.16, 2.44, 2.77, 3.14, 3.42],
    accelG: [1.05, 0.99, 0.84, 0.68, 0.52, 0.37, 0.22, 0.08],
    lockKappa: Math.tan((225 / 12.5) * (Math.PI / 180)) / 3.148,
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
  // Measured 2026-11-16. Its accelG at 65 m/s read 0.11: an up-shift lands in the measuring window there, so it is taken
  // between its neighbours; at 85 m/s it is past the limiter in fifth (81 m/s)
  'bmw-m1-procar': {
    speedsMs: [15, 25, 35, 45, 55, 65, 75, 85],
    latG: [1.08, 1.09, 1.15, 1.18, 1.2, 1.21, 1.23, 1.24],
    brakeG: [1.35, 1.47, 1.5, 1.54, 1.59, 1.65, 1.72, 1.79],
    accelG: [0.87, 0.64, 0.46, 0.42, 0.28, 0.21, 0.14, -0.28],
    lockKappa: Math.tan((360 / 16) * (Math.PI / 180)) / 2.53,
  },
  // Measured 2026-11-16. Past its 207 km/h top speed (58 m/s) the traction row is the drag it can't beat
  'vw-scirocco-gtx': {
    speedsMs: [15, 25, 35, 45, 55, 65, 75, 85],
    latG: [0.91, 0.93, 0.93, 0.93, 0.94, 0.93, 0.92, 0.92],
    brakeG: [1.13, 1.16, 1.19, 1.2, 1.26, 1.29, 1.32, 1.36],
    accelG: [0.41, 0.29, 0.21, 0.11, 0.05, -0.28, -0.31, -0.34],
    lockKappa: Math.tan((450 / 14) * (Math.PI / 180)) / 2.41,
  },
  // Measured 2026-11-18. The body lifts, so its grip falls with speed; first gear runs to ≈ 170 km/h, so the traction row
  // drops at 45 m/s where second takes over; past its ≈ 300 km/h top speed (83 m/s) it is the drag it can't beat
  'chaparral-2d': {
    speedsMs: [15, 25, 35, 45, 55, 65, 75, 85],
    latG: [0.9, 0.93, 0.94, 0.92, 0.9, 0.86, 0.82, 0.79],
    brakeG: [1.17, 1.17, 1.18, 1.2, 1.22, 1.25, 1.29, 1.33],
    accelG: [0.59, 0.6, 0.57, 0.24, 0.25, 0.2, 0.12, -0.14],
    lockKappa: Math.tan((360 / 14.1) * (Math.PI / 180)) / 2.311,
  },
  // Measured 2026-11-18. The 427's three gears change at ≈ 165 and 245 km/h
  'chaparral-2d-67': {
    speedsMs: [15, 25, 35, 45, 55, 65, 75, 85],
    latG: [0.94, 0.98, 0.99, 0.94, 0.94, 0.93, 0.89, 0.87],
    brakeG: [1.16, 1.16, 1.18, 1.2, 1.22, 1.25, 1.29, 1.33],
    accelG: [0.65, 0.68, 0.62, 0.36, 0.35, 0.16, 0.15, 0.07],
    lockKappa: Math.tan((360 / 14.1) * (Math.PI / 180)) / 2.311,
  },
  // Measured 2026-11-18 on the slicks. Its accelG at 45 m/s read 0.16: the 2-3 up-shift (7200 rpm in second is 46 m/s)
  // lands in the measuring window there and the turbo has to spool again after it, so it is taken between its
  // neighbours; past its ≈ 305 km/h top speed (85 m/s) it is the drag it can't beat
  'porsche-934-rsr': {
    speedsMs: [15, 25, 35, 45, 55, 65, 75, 85],
    latG: [0.99, 1.0, 1.01, 1.01, 1.0, 0.99, 0.99, 1.0],
    brakeG: [1.1, 1.09, 1.11, 1.13, 1.16, 1.21, 1.26, 1.32],
    accelG: [0.47, 0.45, 0.44, 0.36, 0.28, 0.17, 0.13, -0.02],
    lockKappa: Math.tan((540 / 16.9) * (Math.PI / 180)) / 2.296,
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
