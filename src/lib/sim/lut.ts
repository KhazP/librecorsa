/**
 * 1D piecewise-linear lookup table (`Lut`).
 *
 * Evaluates piecewise-linear interpolation over sorted `(x, y)` pairs, clamped to the
 * boundary values outside the defined domain.
 */
export type LutPoints = ReadonlyArray<readonly [number, number]>;

export class Lut {
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  private readonly slopes: Float64Array;

  constructor(points: LutPoints) {
    if (points.length === 0) {
      throw new Error('Lut requires at least one point');
    }
    const sorted = [...points].sort((a, b) => a[0] - b[0]);
    const n = sorted.length;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.slopes = new Float64Array(Math.max(1, n - 1));
    for (let i = 0; i < n; i++) {
      this.xs[i] = sorted[i][0];
      this.ys[i] = sorted[i][1];
    }
    for (let i = 0; i < n - 1; i++) {
      const dx = this.xs[i + 1] - this.xs[i];
      this.slopes[i] = dx !== 0 ? (this.ys[i + 1] - this.ys[i]) / dx : 0;
    }
  }

  get minX(): number {
    return this.xs[0];
  }

  get maxX(): number {
    return this.xs[this.xs.length - 1];
  }

  /** Maximum Y value in the table (e.g. peak of a torque curve). */
  get maxY(): number {
    let m = -Infinity;
    for (let i = 0; i < this.ys.length; i++) m = Math.max(m, this.ys[i]);
    return m;
  }

  evaluate(x: number): number {
    const xs = this.xs;
    const ys = this.ys;
    const n = xs.length;
    if (n === 1 || x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];

    // Binary search for the bracketing segment
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    return ys[lo] + (x - xs[lo]) * this.slopes[lo];
  }
}
