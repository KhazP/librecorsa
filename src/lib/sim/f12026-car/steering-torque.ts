/**
 * Steering-axis torque of a front tyre (`src/lib/sim/f12026-car/steering-torque.ts`), used by `VehiclePhysics` for
 * the rack / force-feedback torque.
 *
 * As rFactor 2 and the textbooks (Milliken, Race Car Vehicle Dynamics ch. 19; Pacejka, Tire and Vehicle Dynamics
 * ch. 3) do it, the torque on the steering is the moment of everything the road puts on the tyre about the kingpin
 * axis: the contact-patch forces Fx, Fy, Fz at their lever arms (scrub radius, caster trail, and for Fz the rise of the
 * contact point as the wheel swings about an inclined axis: KPI and caster weight-jacking), plus the tyre's own
 * moments Mz and Mx projected onto that axis. The rack sums both wheels; the column sees that sum divided by the
 * steering ratio.
 *
 * The contact patch comes from the brush model with a rectangular patch of half-length a and half-width b:
 * - pneumatic trail at zero slip t0 = a/3 (parabolic pressure),
 * - tread stiffness per unit area k = C_Fα / (4a²b) (from the cornering stiffness C_Fα = 4ka²b),
 * - twist (spin) stiffness of the tread kφ·J = C_Fα·(a² + b²)/(3a), J = 4ab(a² + b²)/3 its polar moment, in series
 *   with the carcass's,
 * - Coulomb spin friction moment μ·Fz·r̄, r̄ the mean distance of the patch from its centre,
 * which together give the parking torque of a tyre twisted in place (elastic, then sliding) and its decay once it
 * rolls (the twisted rubber leaves the patch over about its half-length a).
 */
import type { CornerKinematicsState } from '../suspension-kinematics';

interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Tread half-width as a share of the section width: the tread is ≈ 84 % of the section, as the contact patch sampler
 * (`sample5PointContactPatch`, 0.42 × width) already takes it
 */
export const PATCH_HALF_WIDTH_SHARE = 0.42;
/** Floor on the patch half-length (m): keeps the brush-model divisions finite on a barely loaded tyre */
const MIN_PATCH_HALF_LENGTH_M = 0.005;
/**
 * Viscous time constant of the twisted tyre (s): the tread rubber's hysteresis, a loss factor ωτ ≈ 0.5 at the 2–4 Hz
 * a parked rim rocks at (racing compounds run ≈ 0.3–0.6). It is also what lets a direct-drive rim settle on a parked
 * tyre's twist through the frame-rate input delay (60 fps, hands off) instead of rocking on it
 */
export const PATCH_TWIST_DAMPING_S = 0.03;

/** Contact-patch half-length (m) of a tyre of radius `radiusM` pressed `deflectionM` into the road: the chord √(2Rδ − δ²) */
export function contactHalfLengthM(radiusM: number, deflectionM: number): number {
  const d = Math.min(Math.max(0, deflectionM), radiusM);
  return Math.sqrt(2 * radiusM * d - d * d);
}

/**
 * Mean distance (m) of a uniformly loaded 2a × 2b rectangle from its centre: the lever arm of Coulomb friction when
 * the patch spins about its centre (the exact integral of √(x² + y²) over the rectangle)
 */
export function spinFrictionArmM(a: number, b: number): number {
  const A = Math.max(MIN_PATCH_HALF_LENGTH_M, a);
  const B = Math.max(MIN_PATCH_HALF_LENGTH_M, b);
  const d = Math.sqrt(A * A + B * B);
  return (2 * A * B * d + A * A * A * Math.log((B + d) / A) + B * B * B * Math.log((A + d) / B)) / (6 * A * B);
}

/**
 * Twist stiffness of the tyre about the contact normal (Nm/rad): the tread brush, C_Fα(a² + b²)/(3a), in series with
 * the carcass. The carcass's lateral and longitudinal stiffness at the patch follow from the relaxation lengths
 * (σ = slip stiffness / carcass stiffness, Pacejka's stretched string), and spread along / across the patch they
 * resist a yaw of the belt by (C_Fα·a²/σy + C_Fκ·b²/σx)/3.
 *
 * `cfa` cornering stiffness (N/rad), `cfk` longitudinal slip stiffness (N per unit slip), `sigmaY` / `sigmaX` the
 * relaxation lengths (m), `a` / `b` the patch half-length / half-width (m).
 */
export function patchTwistStiffness(cfa: number, cfk: number, sigmaY: number, sigmaX: number, a: number, b: number): number {
  const A = Math.max(MIN_PATCH_HALF_LENGTH_M, a);
  const tread = (cfa * (A * A + b * b)) / (3 * A);
  const carcass = ((cfa * A * A) / Math.max(1e-3, sigmaY) + (cfk * b * b) / Math.max(1e-3, sigmaX)) / 3;
  return tread > 0 && carcass > 0 ? (tread * carcass) / (tread + carcass) : 0;
}

/**
 * One step of the patch twist (rad, + = wheel turned left of the rubber stuck to the road): the wheel's yaw over the
 * ground `dPsiRad` winds it up, rolling `rollDistM` lets it out over the half-length `a`, and past `maxTwistRad`
 * (spin friction / twist stiffness) the patch slides instead (elastic-plastic). Implicit in the roll-out, so any
 * speed and step size stay stable.
 */
export function stepPatchTwist(twistRad: number, dPsiRad: number, rollDistM: number, a: number, maxTwistRad: number): number {
  const t = (twistRad + dPsiRad) / (1 + rollDistM / Math.max(MIN_PATCH_HALF_LENGTH_M, a));
  return t > maxTwistRad ? maxTwistRad : t < -maxTwistRad ? -maxTwistRad : t;
}

/**
 * Moment (Nm, + = turns the wheel left) of a front tyre's road loads about its kingpin axis.
 *
 * Body axes `ex` (left), `ey` (up), `ez` (forward); the contact normal `n` and the wheel's forward / left axes `fw`,
 * `lw` (world); `inboardSign` −1 for a left wheel, +1 for a right one (along `ex`); `steerRad` the wheel's angle
 * about the kingpin; forces Fx (along fw), Fy (along lw), Fz (along n) at the contact point; Mz about n, Mx about fw.
 * The kingpin's inclination, caster, ground trail and scrub come from the suspension solver. The contact point is the
 * lowest point of the steered wheel (a disc of the loaded radius), so the Fz term carries the full weight-jacking
 * of the inclined axis, not only the contact point's swing.
 */
export function kingpinMomentNm(
  ex: Vec3Like,
  ey: Vec3Like,
  ez: Vec3Like,
  n: Vec3Like,
  fw: Vec3Like,
  lw: Vec3Like,
  inboardSign: number,
  steerRad: number,
  loadedRadiusM: number,
  kin: Pick<CornerKinematicsState, 'kpiRad' | 'casterRad' | 'casterTrailM' | 'scrubRadiusM'>,
  fx: number,
  fy: number,
  fz: number,
  mz: number,
  mx: number
): number {
  // Road loads in body axes (X left, Y up, Z forward)
  const nx = n.x * ex.x + n.y * ex.y + n.z * ex.z;
  const ny = n.x * ey.x + n.y * ey.y + n.z * ey.z;
  const nz = n.x * ez.x + n.y * ez.y + n.z * ez.z;
  const fwx = fw.x * ex.x + fw.y * ex.y + fw.z * ex.z;
  const fwy = fw.x * ey.x + fw.y * ey.y + fw.z * ey.z;
  const fwz = fw.x * ez.x + fw.y * ez.y + fw.z * ez.z;
  const lwx = lw.x * ex.x + lw.y * ex.y + lw.z * ex.z;
  const lwy = lw.x * ey.x + lw.y * ey.y + lw.z * ey.z;
  const lwz = lw.x * ez.x + lw.y * ez.y + lw.z * ez.z;
  const Fx = fx * fwx + fy * lwx + fz * nx;
  const Fy = fx * fwy + fy * lwy + fz * ny;
  const Fz = fx * fwz + fy * lwz + fz * nz;

  // Kingpin axis: top leaning inboard by the KPI and rearward by the caster
  let kx = inboardSign * Math.tan(kin.kpiRad);
  let ky = 1;
  let kz = -Math.tan(kin.casterRad);
  const kl = Math.sqrt(kx * kx + ky * ky + kz * kz);
  kx /= kl;
  ky /= kl;
  kz /= kl;

  // Unsteered wheel centre and spin axis relative to the kingpin's ground point A (the contact centre sits the scrub
  // radius outboard of A and the caster trail behind it), swung by the steer angle about the axis (Rodrigues)
  const R = loadedRadiusM;
  const c0x = -inboardSign * kin.scrubRadiusM;
  const c0y = R;
  const c0z = -kin.casterTrailM;
  const co = Math.cos(steerRad);
  const si = Math.sin(steerRad);
  const kc = kx * c0x + ky * c0y + kz * c0z;
  const cx = c0x * co + (ky * c0z - kz * c0y) * si + kx * kc * (1 - co);
  const cy = c0y * co + (kz * c0x - kx * c0z) * si + ky * kc * (1 - co);
  const cz = c0z * co + (kx * c0y - ky * c0x) * si + kz * kc * (1 - co);
  // Spin axis (1, 0, 0) swung the same way
  const ks = kx;
  const sx = co + kx * ks * (1 - co);
  const sy = kz * si + ky * ks * (1 - co);
  const sz = -ky * si + kz * ks * (1 - co);

  // Lowest point of the wheel toward the road: from the centre, along the wheel plane's most road-ward direction
  const ns = nx * sx + ny * sy + nz * sz;
  let gx = -nx + ns * sx;
  let gy = -ny + ns * sy;
  let gz = -nz + ns * sz;
  const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
  gx /= gl;
  gy /= gl;
  gz /= gl;
  const px = cx + R * gx;
  const py = cy + R * gy;
  const pz = cz + R * gz;

  // ((P − A) × F) · k, plus Mz and Mx projected onto the axis
  const mFx = py * Fz - pz * Fy;
  const mFy = pz * Fx - px * Fz;
  const mFz = px * Fy - py * Fx;
  return (
    mFx * kx + mFy * ky + mFz * kz +
    mz * (nx * kx + ny * ky + nz * kz) +
    mx * (fwx * kx + fwy * ky + fwz * kz)
  );
}
