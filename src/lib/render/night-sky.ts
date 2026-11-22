/*
 * The night sky shared by the physical sky (Medium / High) and the classic sky (Low): with the sun well under the
 * horizon the atmosphere models give black, but a real night sky never is. Airglow and starlight give it a faint
 * navy, the horizon glows a little brighter (the haze holds the glow of towns), and on a clear night there are stars.
 * Without it an unlit circuit at night was a black screen with two headlight cones in it.
 *
 * Cost: a few ALU ops per sky pixel, and a hash for the stars only where a star cell could hold one.
 */

/** Linear scene radiance of the night sky at the horizon and overhead (before exposure, which is ~1.6 at night) */
export const NIGHT_SKY_HORIZON = [0.02, 0.026, 0.045] as const;
export const NIGHT_SKY_ZENITH = [0.0045, 0.0062, 0.015] as const;
/** A night cloud's underside, lit by the glow of the ground: greyer than the clear sky, as bright as its horizon */
export const NIGHT_CLOUD_GLOW = [0.019, 0.021, 0.028] as const;

const vec3 = (c: readonly number[]) => `vec3(${c.map((v) => v.toFixed(4)).join(", ")})`;

/**
 * GLSL adding the night sky to `out` (a vec3 of scene radiance). `dir` is the unit view ray, `up` the local up in the
 * same frame; `night` (0..1) fades the whole sky in, `stars` (0..1) the stars; `pixelAngle` is the angle a pixel
 * spans (rad), so a star is drawn a pixel or two wide at any resolution.
 */
export function nightSkyGlsl(out: string, dir: string, up: string, night: string, stars: string, pixelAngle: string): string {
  return /* glsl */ `
  {
    float lcSkyH = dot(${dir}, ${up});
    ${out} += mix(${vec3(NIGHT_SKY_HORIZON)}, ${vec3(NIGHT_SKY_ZENITH)}, smoothstep(-0.04, 0.55, lcSkyH)) * ${night};
    if (${stars} > 0.002 && lcSkyH > 0.03) {
      // one star in about one cell in seventy, on a lattice of cells over the sphere of directions
      vec3 lcCell = floor(${dir} * 360.0);
      vec3 lcRnd = fract(sin(vec3(
        dot(lcCell, vec3(127.1, 311.7, 74.7)),
        dot(lcCell, vec3(269.5, 183.3, 246.1)),
        dot(lcCell, vec3(113.5, 271.9, 124.6))
      )) * 43758.5453);
      if (lcRnd.x > 0.989) {
        vec3 lcStar = normalize((lcCell + 0.15 + 0.7 * fract(lcRnd * 7.31)) / 360.0);
        float lcPx = length(${dir} - lcStar) / max(${pixelAngle}, 1e-6);
        // most stars faint, a few bright; warmer and cooler ones; thinned out toward the hazy horizon
        float lcMag = 0.05 + 0.9 * pow(lcRnd.y, 9.0);
        vec3 lcTint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.88, 0.72), lcRnd.z);
        ${out} += lcTint * (lcMag * exp(-lcPx * lcPx * 1.4) * smoothstep(0.03, 0.25, lcSkyH) * ${stars});
      }
    }
  }`;
}

/** The night share of a sun elevation (deg): 0 until 3 deg under the horizon, 1 from 13 deg under (as nightShareOf) */
export const nightShareOfElevation = (elevationDeg: number): number => Math.min(1, Math.max(0, (-elevationDeg - 3) / 10));

/** How much of the starfield a sky shows: none under cloud or in rain */
export function starShare(night: number, cloud: number, rain: number): number {
  const clear = 1 - Math.min(1, Math.max(0, (cloud - 0.2) / 0.5));
  return night * night * clear * (1 - Math.min(1, rain * 2));
}
