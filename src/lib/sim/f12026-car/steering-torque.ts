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
 * - pneumatic trail at zero slip t0 = a/3 (parabolic pressure).
 */
import type { CornerKinematicsState } from '../suspension-kinematics';

interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Contact-patch half-length (m) of a tyre of radius `radiusM` pressed `deflectionM` into the road: the chord √(2Rδ − δ²) */
export function contactHalfLengthM(radiusM: number, deflectionM: number): number {
  const d = Math.min(Math.max(0, deflectionM), radiusM);
  return Math.sqrt(2 * radiusM * d - d * d);
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
