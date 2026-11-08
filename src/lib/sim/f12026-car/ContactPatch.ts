/**
 * The ground under a tyre as its contact patch feels it, for `VehiclePhysics`: five ground samples per wheel (the patch
 * centre, its leading and trailing ends, its two tread edges) folded into one enveloped effective road height and a
 * plane-fit normal, in place of a single vertical ray under the hub.
 *
 * A tyre does not follow the road at a point. Its patch (0.15–0.25 m long on a racing slick) bridges texture shorter
 * than itself, meets a step with its leading arc before the hub is over it, and stays up on an edge until it has
 * rolled off. The effective-road model of Zegelaar (1998), Schmeitz (2004) and Pacejka (Tire and Vehicle Dynamics,
 * ch. 10, the SWIFT enveloping model) reduces that to a height and a slope fed to an otherwise unchanged contact: a
 * tandem two-point follower spaced about the patch length, riding on cams the shape of the tyre's unloaded profile.
 * rFactor 2 / Le Mans Ultimate and iRacing likewise sample the road over the patch rather than at one point.
 *
 * Each outer sample is taken as its rise over the local road plane through the centre (the plane's slope along and
 * across: the gentler of each pair's one-sided slopes, zero where they disagree in sign, so a step, seam or hole under
 * one sample does not tilt the plane it is measured against). Then:
 *
 *  - Height: the centre height raised by the largest of
 *     · the fore-aft pair's mean rise: texture shorter than the patch is averaged out (the two-point follower),
 *     · the tread-edge pair's mean rise: one shoulder riding up a raised edge lifts the tyre,
 *     · the higher fore-aft rise less the unloaded tyre's rise c above its lowest point at the patch end (the cam, a
 *       circle of the tyre's radius, which sits a little inside Schmeitz's flatter ellipses): a step taller than c
 *       meets the tyre's arc and lifts it before the centre is over the step, and a trailing edge holds it up after,
 *    and by nothing when all of them are lower: a seam or hole under one sample cannot pull the tyre into it. On a
 *    plane every rise is zero, so the existing contact (deflection along the normal) is unchanged on smooth road.
 *  - Normal: the plane through the samples, its slope along from the fore-aft pair and across from the tread-edge
 *    pair. A sample in a hole or over a drop deeper than c counts at depth c (the tread reaches no further down), so a
 *    seam or edge under one sample does not tip the patch into it; the slope is capped at the steepest ground a car is
 *    seated on.
 *  - Surface, grip and the surface's physics come from the centre sample, as before.
 *
 * A ground with `queryMany` (the track colliders) answers all five samples in one pass over its grid cell's triangles;
 * a `smooth` one (flat, or the track samples' interpolated stand-in) has nothing to envelope and is probed at the centre.
 * Allocation-free: module-level scratch points and hits.
 */

import type { GroundHit, GroundQuery } from './TrackColliderQuery';
import { createGroundHit } from './TrackColliderQuery';

/** Scratch: the five sample points (centre, lead, trail, left, right) and hits for the outer four ([0] is the caller's) */
const _xs = new Float64Array(5);
const _zs = new Float64Array(5);
const _hits: GroundHit[] = [createGroundHit(), createGroundHit(), createGroundHit(), createGroundHit(), createGroundHit()];

/** The smaller-magnitude of two slopes when they agree in sign, else zero (the minmod limiter) */
function gentler(a: number, b: number): number {
  if (a > 0 && b > 0) return a < b ? a : b;
  if (a < 0 && b < 0) return a > b ? a : b;
  return 0;
}

/**
 * Ground under a tyre's contact patch, written into `out` (height, normal, surface tags). Returns false when nothing is
 * under the patch centre (the wheel is off the mesh: airborne), as a single query would.
 *
 * @param x, z         patch centre (world, m)
 * @param probeY       highest surface considered (world Y, m)
 * @param fwdX, fwdZ   unit horizontal heading of the wheel
 * @param halfLength   half the patch length (m): its leading and trailing samples sit this far ahead and behind
 * @param halfWidth    half the tread width (m): its edge samples sit this far left and right
 * @param tyreRadius   unloaded tyre radius (m), the cams' profile
 * @param maxSlope     steepest ground slope (rise over run) the normal may take
 */
export function queryContactPatch(
  ground: GroundQuery,
  x: number,
  z: number,
  probeY: number,
  fwdX: number,
  fwdZ: number,
  halfLength: number,
  halfWidth: number,
  tyreRadius: number,
  maxSlope: number,
  out: GroundHit
): boolean {
  if (ground.smooth || !(halfLength > 0) || !(halfWidth > 0)) return ground.query(x, z, probeY, out);
  // Left of the heading, horizontal (Y up: up × forward)
  const leftX = fwdZ;
  const leftZ = -fwdX;
  _xs[0] = x;
  _zs[0] = z;
  _xs[1] = x + fwdX * halfLength;
  _zs[1] = z + fwdZ * halfLength;
  _xs[2] = x - fwdX * halfLength;
  _zs[2] = z - fwdZ * halfLength;
  _xs[3] = x + leftX * halfWidth;
  _zs[3] = z + leftZ * halfWidth;
  _xs[4] = x - leftX * halfWidth;
  _zs[4] = z - leftZ * halfWidth;
  _hits[0] = out;
  let found: number;
  if (ground.queryMany) {
    // Only the centre needs its surface tags and normal; the outer samples give heights
    found = ground.queryMany(_xs, _zs, 5, probeY, _hits, 1);
  } else {
    found = 0;
    for (let i = 0; i < 5; i++) if (ground.query(_xs[i], _zs[i], probeY, _hits[i])) found |= 1 << i;
  }
  if (!(found & 1)) return false;
  const hC = out.height;

  // Heights at the patch's ends and tread edges; a sample with no ground under it takes the opposite one's slope
  const lead = found & 2 ? _hits[1].height : NaN;
  const trail = found & 4 ? _hits[2].height : NaN;
  const left = found & 8 ? _hits[3].height : NaN;
  const right = found & 16 ? _hits[4].height : NaN;
  const dLead = lead === lead ? lead - hC : trail === trail ? hC - trail : 0;
  const dTrail = trail === trail ? trail - hC : -dLead;
  const dLeft = left === left ? left - hC : right === right ? hC - right : 0;
  const dRight = right === right ? right - hC : -dLeft;

  // The local road plane through the centre, and each sample's rise over it (a hole or drop counts at most `cam` deep)
  const sAlong0 = gentler(dLead / halfLength, -dTrail / halfLength);
  const sAcross0 = gentler(dLeft / halfWidth, -dRight / halfWidth);
  const L = Math.min(halfLength, tyreRadius);
  const cam = tyreRadius - Math.sqrt(tyreRadius * tyreRadius - L * L);
  const rLead = Math.max(-cam, dLead - sAlong0 * halfLength);
  const rTrail = Math.max(-cam, dTrail + sAlong0 * halfLength);
  const rLeft = Math.max(-cam, dLeft - sAcross0 * halfWidth);
  const rRight = Math.max(-cam, dRight + sAcross0 * halfWidth);

  out.height = hC + Math.max(0, 0.5 * (rLead + rTrail), 0.5 * (rLeft + rRight), Math.max(rLead, rTrail) - cam);

  // Plane-fit slope (world XZ gradient of the height), capped
  const sAlong = sAlong0 + (rLead - rTrail) / (2 * halfLength);
  const sAcross = sAcross0 + (rLeft - rRight) / (2 * halfWidth);
  let gx = sAlong * fwdX + sAcross * leftX;
  let gz = sAlong * fwdZ + sAcross * leftZ;
  const g = Math.sqrt(gx * gx + gz * gz);
  if (g > maxSlope) {
    gx *= maxSlope / g;
    gz *= maxSlope / g;
  }
  const inv = 1 / Math.sqrt(1 + gx * gx + gz * gz);
  out.nx = -gx * inv;
  out.ny = inv;
  out.nz = -gz * inv;
  return true;
}
