/**
 * Road micro-unevenness the tyres roll over (`src/lib/sim/road-texture.ts`).
 *
 * The track colliders are flat triangles, so on the road the tyre would otherwise roll on a glass-smooth surface. This
 * is a deterministic function of world position (never of time), added to the ground height under each tyre, so the
 * tyre's vertical spring, its forces, and through them the steering rack all feel the same bumps (a parked car feels
 * none).
 *
 * The spectrum is ISO 8608's road displacement PSD Gd(n) = Gd(n0)·(n/n0)^-w with n0 = 0.1 cycles/m and w = 2, at a
 * smooth class A level (see ROAD_GD0): about 0.5 mm RMS between 0.2 m and 5 m wavelength. Longer waves are the
 * track mesh's own; shorter ones the contact patch swallows. It is synthesised as one plane wave per band
 * (amplitude √(2·Gd(n)·Δn), the standard sum-of-sinusoids road model) at spread headings, so along any path the
 * profile has the spectrum's variance and the left and right tyres see different bumps. Surfaces that carry their own
 * ripple data (kerbs, grass, gravel: `SurfaceProps.bumpHeightM`) keep it on top, through the ground query.
 *
 * The tyre averages the road over its contact length: a wave of wavenumber k under a patch of half-length a reaches
 * the tyre attenuated by sin(k·a)/(k·a), the box average of a sinusoid (the tyre's geometric enveloping filter).
 */

/** ISO 8608 reference spatial frequency (cycles/m) */
const ISO8608_N0 = 0.1;
/**
 * Displacement PSD at n0 (m³): a smooth class A surface, a quarter of the class's geometric mean (16·10⁻⁶, a good
 * road; class A runs up to 32·10⁻⁶). A circuit is laid smoother than a road: this is ≈ 0.5 mm RMS over 0.2–5 m
 */
const ROAD_GD0 = 4e-6;
/** Band edges of the synthesised texture: wavelengths (m), about one octave per band */
const LONGEST_WAVELENGTH_M = 5;
const SHORTEST_WAVELENGTH_M = 0.2;
const BANDS = 6;
/** Golden angle (rad): spreads the bands' headings evenly without repeating */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** sin(x)/x tabulated over [0, SINC_MAX] (the hot loop's patch envelope without a sine per band) */
const SINC_MAX = 12;
const SINC_STEPS = 1024;
const sincTable = new Float64Array(SINC_STEPS + 2);
for (let i = 0; i <= SINC_STEPS + 1; i++) {
  const x = (i * SINC_MAX) / SINC_STEPS;
  sincTable[i] = x > 0 ? Math.sin(x) / x : 1;
}
function sinc(x: number): number {
  if (x >= SINC_MAX) return Math.sin(x) / x;
  const u = (x * SINC_STEPS) / SINC_MAX;
  const i = u | 0;
  return sincTable[i] + (sincTable[i + 1] - sincTable[i]) * (u - i);
}

const bandK = new Float64Array(BANDS);
const bandKx = new Float64Array(BANDS);
const bandKz = new Float64Array(BANDS);
const bandAmp = new Float64Array(BANDS);
const bandPhase = new Float64Array(BANDS);
{
  const ratio = Math.pow(LONGEST_WAVELENGTH_M / SHORTEST_WAVELENGTH_M, 1 / (BANDS - 1));
  const halfBand = Math.sqrt(ratio);
  for (let i = 0; i < BANDS; i++) {
    const n = 1 / (LONGEST_WAVELENGTH_M / Math.pow(ratio, i));
    // Each band covers the log-spaced interval around its centre frequency
    const dn = n * (halfBand - 1 / halfBand);
    const gd = ROAD_GD0 * (ISO8608_N0 / n) ** 2;
    const k = 2 * Math.PI * n;
    const heading = (i + 0.5) * GOLDEN_ANGLE;
    bandK[i] = k;
    bandKx[i] = k * Math.cos(heading);
    bandKz[i] = k * Math.sin(heading);
    bandAmp[i] = Math.sqrt(2 * gd * dn);
    // Fixed, irrational phase offsets: deterministic, but no two bands line up
    bandPhase[i] = 2 * Math.PI * ((i * Math.SQRT2) % 1);
  }
}

/** Slope of the texture (dh/dx, dh/dz), written by `roadTextureHeightM` when asked */
export interface RoadTextureSlope {
  dhdx: number;
  dhdz: number;
}

/**
 * Road height perturbation (m, + = up) at world (x, z), as a tyre with contact half-length `patchHalfLengthM` (m)
 * feels it. Pass 0 for the point height (a multi-point contact patch that samples several points itself). With
 * `slope`, also its gradient, so the road's vertical speed under a moving tyre is slope · velocity.
 */
export function roadTextureHeightM(worldX: number, worldZ: number, patchHalfLengthM = 0, slope?: RoadTextureSlope): number {
  let h = 0;
  let dx = 0;
  let dz = 0;
  for (let i = 0; i < BANDS; i++) {
    const amp = bandAmp[i] * sinc(bandK[i] * Math.max(0, patchHalfLengthM));
    const arg = bandKx[i] * worldX + bandKz[i] * worldZ + bandPhase[i];
    h += amp * Math.sin(arg);
    if (slope) {
      const c = amp * Math.cos(arg);
      dx += c * bandKx[i];
      dz += c * bandKz[i];
    }
  }
  if (slope) {
    slope.dhdx = dx;
    slope.dhdz = dz;
  }
  return h;
}

/** RMS of the unfiltered texture (m): the variance the bands carry */
export const ROAD_TEXTURE_RMS_M = Math.sqrt(bandAmp.reduce((s, a) => s + 0.5 * a * a, 0));
