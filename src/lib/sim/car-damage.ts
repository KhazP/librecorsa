/**
 * Car damage from contact and barrier hits: what an impact breaks, and what the broken parts cost on the road.
 *
 * Impacts are judged by the speed along the contact normal (the closing speed the crash structure has to soak up),
 * at the point of contact in the car's frame. Each impact adds damage to the body zone it lands on (front: wing and
 * nose, rear: wing and diffuser, sides: floor and sidepods), to the suspension corner it lands near, and may puncture
 * the tyre there. The thresholds are starting values tuned against the feel of a drive, not measured figures:
 *
 *   - under ~2 m/s (7 km/h): a touch, nothing breaks
 *   - 2–20 m/s: aero parts go a piece at a time (a lost front wing costs ~40 % of the front downforce)
 *   - from ~6 m/s on a wheel: bent suspension (toe out of line, so the car pulls and that tyre scrubs grip)
 *   - from ~4 m/s on a tyre: a chance of a puncture
 *   - one impact past the terminal speed (full damage ~24 m/s ≈ 86 km/h into the hit), or a wheel torn off: retired
 *
 * Wheel arrays are in the simulator's wheel order: FR, FL, RR, RL. Car frame: +X left, +Z forward (model axes).
 */
import { CLEAN_AIR_WAKE_STATE, type AeroWakeState } from './aero-wake';

export type DamageLevel = 'off' | 'reduced' | 'full';

export const DAMAGE_LEVELS: readonly DamageLevel[] = ['off', 'reduced', 'full'];

export const DAMAGE_LEVEL_LABELS: Record<DamageLevel, string> = {
  off: 'Off',
  reduced: 'Reduced',
  full: 'Full',
};

/** What the damage costs the car; all 1 / 0 on an undamaged car */
export interface CarDamageEffects {
  frontDownforceMult: number;
  rearDownforceMult: number;
  dragMult: number;
  /** Per-wheel grip multiplier (FR, FL, RR, RL): bent suspension, punctures */
  wheelGripMult: [number, number, number, number];
  /** Extra toe per wheel (rad, + toe-in, FR, FL, RR, RL) from bent suspension */
  wheelToeRad: [number, number, number, number];
  /** Engine torque multiplier (0 once the car is out) */
  powerMult: number;
}

export const NO_DAMAGE_EFFECTS: Readonly<CarDamageEffects> = Object.freeze({
  frontDownforceMult: 1,
  rearDownforceMult: 1,
  dragMult: 1,
  wheelGripMult: [1, 1, 1, 1] as [number, number, number, number],
  wheelToeRad: [0, 0, 0, 0] as [number, number, number, number],
  powerMult: 1,
});

export interface DamageImpact {
  /** Contact point in the car frame (m): + left, + forward */
  localX: number;
  localZ: number;
  /** Closing speed along the contact normal (m/s) */
  speedMs: number;
  source: 'car' | 'wall';
}

/** One impact's outcome, for race control's messages and the HUD */
export interface DamageReport {
  /** Biggest damage added to any one part (0..1) */
  severity: number;
  zone: DamageZone;
  /** A tyre went down with this impact */
  puncture: boolean;
  /** This impact put the car out */
  terminal: boolean;
}

export type DamageZone = 'front' | 'rear' | 'left' | 'right';

/** What a level does: damage scale, the terminal impact speed (m/s), whether punctures happen */
const LEVEL: Record<DamageLevel, { scale: number; terminalMs: number; punctures: boolean }> = {
  off: { scale: 0, terminalMs: Infinity, punctures: false },
  reduced: { scale: 0.5, terminalMs: 34, punctures: true },
  full: { scale: 1, terminalMs: 24, punctures: true },
};

/** Barriers do not give like another car's bodywork */
const WALL_SEVERITY = 1.25;
const AERO_FROM_MS = 2;
const AERO_FULL_MS = 20;
const SUSPENSION_FROM_MS = 6;
const SUSPENSION_FULL_MS = 22;
const PUNCTURE_FROM_MS = 4;
/** Toe a fully bent corner gets (rad): ~2.3°, a car that pulls hard */
const BENT_TOE_RAD = 0.04;

export class CarDamage {
  /** Body zones 0..1 */
  public front = 0;
  public rear = 0;
  public left = 0;
  public right = 0;
  /** Suspension per corner 0..1 (FR, FL, RR, RL); 1 = the wheel is gone */
  public readonly suspension: [number, number, number, number] = [0, 0, 0, 0];
  /** Toe direction of each bent corner (+1 in, −1 out), chosen on the first hit to it */
  private readonly toeSign: [number, number, number, number] = [0, 0, 0, 0];
  public readonly punctured: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  /** Out of the race */
  public terminal = false;
  /** Damage changed since effects() was last read */
  private dirty = true;
  private cached: CarDamageEffects = { ...NO_DAMAGE_EFFECTS, wheelGripMult: [1, 1, 1, 1], wheelToeRad: [0, 0, 0, 0] };

  constructor(
    public level: DamageLevel = 'reduced',
    /** Half length / half width of the car (m), to place an impact on a corner */
    private readonly halfLengthM = 2.5,
    private readonly halfWidthM = 0.975,
    private readonly rng: () => number = Math.random
  ) {}

  public reset(): void {
    this.front = this.rear = this.left = this.right = 0;
    this.suspension.fill(0);
    this.toeSign.fill(0);
    this.punctured.fill(false);
    this.terminal = false;
    this.dirty = true;
  }

  /** Nothing broken */
  get pristine(): boolean {
    return (
      !this.terminal &&
      this.front + this.rear + this.left + this.right === 0 &&
      this.suspension.every((s) => s === 0) &&
      !this.punctured.some(Boolean)
    );
  }

  /** Overall state for a HUD (0 = as new, 1 = out) */
  get overall(): number {
    if (this.terminal) return 1;
    const worst = Math.max(this.front, this.rear, this.left, this.right, ...this.suspension);
    return Math.min(1, worst * 0.8 + (this.punctured.some(Boolean) ? 0.25 : 0));
  }

  /** Records an impact; null when it broke nothing */
  public registerImpact(hit: DamageImpact): DamageReport | null {
    const L = LEVEL[this.level];
    if (L.scale === 0 || this.terminal || !(hit.speedMs > AERO_FROM_MS)) return null;
    const v = hit.speedMs * (hit.source === 'wall' ? WALL_SEVERITY : 1);
    const zone = zoneOf(hit.localX, hit.localZ, this.halfLengthM, this.halfWidthM);
    const aero = L.scale * Math.pow(Math.min(1, (v - AERO_FROM_MS) / (AERO_FULL_MS - AERO_FROM_MS)), 1.3);
    let severity = aero;
    this[zone] = Math.min(1, this[zone] + aero);

    // A corner: within the outer 40 % of the length and the outer half of the width (wheels stick out on an open-wheeler)
    const corner = cornerOf(hit.localX, hit.localZ, this.halfLengthM, this.halfWidthM);
    let puncture = false;
    if (corner >= 0) {
      if (v > SUSPENSION_FROM_MS) {
        const bend = L.scale * Math.min(1, (v - SUSPENSION_FROM_MS) / (SUSPENSION_FULL_MS - SUSPENSION_FROM_MS));
        if (this.toeSign[corner] === 0) this.toeSign[corner] = this.rng() < 0.6 ? -1 : 1;
        this.suspension[corner] = Math.min(1, this.suspension[corner] + bend);
        severity = Math.max(severity, bend);
      }
      if (L.punctures && !this.punctured[corner] && v > PUNCTURE_FROM_MS && this.rng() < Math.min(0.6, (v - PUNCTURE_FROM_MS) / 14)) {
        this.punctured[corner] = true;
        puncture = true;
      }
    }
    const terminal = hit.speedMs >= L.terminalMs || this.suspension.some((s) => s >= 1);
    if (terminal) this.terminal = true;
    this.dirty = true;
    if (severity < 0.02 && !puncture && !terminal) return null;
    return { severity, zone, puncture, terminal };
  }

  /** What the damage costs on the road now */
  public effects(): Readonly<CarDamageEffects> {
    if (!this.dirty) return this.cached;
    this.dirty = false;
    const side = 0.5 * (this.left + this.right);
    const e = this.cached;
    // Front wing and nose: the front downforce; rear wing / diffuser: the rear; sidepods and floor edges: both
    e.frontDownforceMult = Math.max(0.45, 1 - 0.4 * this.front - 0.12 * side);
    e.rearDownforceMult = Math.max(0.45, 1 - 0.3 * this.rear - 0.15 * side);
    e.dragMult = 1 + 0.06 * this.front + 0.08 * this.rear + 0.05 * side;
    for (let i = 0; i < 4; i++) {
      const s = this.suspension[i];
      e.wheelToeRad[i] = this.toeSign[i] * BENT_TOE_RAD * s;
      e.wheelGripMult[i] = (1 - 0.3 * s) * (this.punctured[i] ? 0.45 : 1);
    }
    e.powerMult = this.terminal ? 0 : 1;
    return e;
  }
}

function zoneOf(x: number, z: number, hl: number, hw: number): DamageZone {
  // Compare against the box's own proportions, so a hit near the nose corner counts as the front
  const nz = z / hl;
  const nx = x / hw;
  if (Math.abs(nz) * 1.4 >= Math.abs(nx)) return nz >= 0 ? 'front' : 'rear';
  return nx >= 0 ? 'left' : 'right';
}

/** Wheel index (FR, FL, RR, RL) an impact lands on, or −1 mid-body */
function cornerOf(x: number, z: number, hl: number, hw: number): number {
  if (Math.abs(z) < 0.45 * hl || Math.abs(x) < 0.45 * hw) return -1;
  const left = x > 0;
  if (z > 0) return left ? 1 : 0;
  return left ? 3 : 2;
}

/** A world (X, Z) point into the frame of a car at (cx, cz) heading (fwdX, fwdZ): + left, + forward */
export function worldToCarLocal(px: number, pz: number, cx: number, cz: number, fwdX: number, fwdZ: number): { x: number; z: number } {
  const dx = px - cx;
  const dz = pz - cz;
  // left = (fwdZ, −fwdX)
  return { x: dx * fwdZ - dz * fwdX, z: dx * fwdX + dz * fwdZ };
}

/**
 * The wake state a damaged car's aero runs on: the cars read downforce and drag through the wake multipliers, so a
 * broken wing is the wake's multipliers times the damage's. The wake as given when there is no damage.
 */
export function withDamage(wake: AeroWakeState | null, damage: Readonly<CarDamageEffects> | null): AeroWakeState | null {
  if (!damage || (damage.frontDownforceMult === 1 && damage.rearDownforceMult === 1 && damage.dragMult === 1)) return wake;
  const w = wake ?? CLEAN_AIR_WAKE_STATE;
  const front = w.frontDownforceMultiplier * damage.frontDownforceMult;
  const rear = w.rearDownforceMultiplier * damage.rearDownforceMult;
  return {
    ...w,
    dragMultiplier: w.dragMultiplier * damage.dragMult,
    frontDownforceMultiplier: front,
    rearDownforceMultiplier: rear,
    totalDownforceMultiplier: 0.5 * (front + rear),
  };
}
