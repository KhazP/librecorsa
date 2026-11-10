/**
 * Fair-play contact in an open race (collision rule 'protected'): a car that is a danger to the others can't touch
 * them, so parking on the racing line, driving the wrong way, rejoining blind or ramming someone gains nothing.
 *
 * Each client resolves contact for its own car only (`resolvePlayerVsRemoteCar`), so two clients that judge a
 * moment differently give one-sided contact. Every rule here is therefore biased one way: where the two sides can
 * disagree, the car that moves is the one that caused the danger, never the car it endangered.
 *
 *  - Hazard: a car that is slow, going the wrong way or off the track judges itself (`HazardState`) and says so in
 *    its packets (`hz`). It raises that flag a little before it stops taking contact itself and lowers it a little
 *    after it takes contact again, so in between the others already pass through it while it can still be moved.
 *  - Ram: a car closing on another much faster than racing contact ever is passes through it (`PairGuard`). The car
 *    being hit protects itself from a lower closing speed than the one at which the striker passes through, so in
 *    the band between the two the striker bounces off a car that is not moved.
 *  - A pair that was kept apart turns solid again only once the two cars are clear of each other.
 *
 * The speeds and times are starting values, not yet tuned in races between people. No three.js, no DOM.
 */

/**
 * Under this speed a car is standing on the track as far as the others are concerned (m/s, ~40 km/h): above the
 * ~29 km/h a car left in gear creeps along at, below the slowest corners
 */
export const SLOW_MS = 11;
/** Going backwards along the track faster than this is the wrong way (m/s) */
export const WRONG_WAY_MS = 3;
/** A hazard this long is flagged to the others, and a little later the car stops taking contact itself (s) */
export const FLAG_AFTER_S = 0.4;
export const GHOST_AFTER_S = 0.7;
/** Back to normal this long and the car takes contact again; the flag comes down a little after that (s) */
export const SOLID_AFTER_S = 1.5;
export const FLAG_OFF_AFTER_S = 1.9;
/** Closing speed from which a hit is a ram: for the car being hit, and (higher) for the car hitting (m/s) */
export const RAM_VICTIM_MS = 11;
export const RAM_STRIKER_MS = 14;
/** A ram is called this long before the cars would touch, and never from further away than this (s, m) */
export const RAM_HORIZON_S = 0.4;
export const RAM_MAX_RANGE_M = 30;
/** Centres further apart than this can't be touching: a pair kept apart is solid again from here (m) */
export const CLEAR_DIST_M = 6;
/** Centre distance at which two cars in line touch (m) */
const TOUCH_DIST_M = 5;

/** One frame of the player's own car */
export interface SelfMotion {
  speedMs: number;
  /** Track arc-length (m) and the lap's length, for the direction of travel */
  trackS: number;
  lapLengthM: number;
  /** Every wheel off the track */
  offTrack: boolean;
}

/** A car on the ground plane: position and velocity (m, m/s) */
export interface GuardBody {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

/** Whether the player's own car is a hazard: what it tells the others, and whether it still takes contact */
export class HazardState {
  private causeS = 0;
  private clearS = 0;
  private prevS: number | null = null;
  private alongMs = 0;
  /** Sent with every packet: the others pass through this car */
  flag = false;
  /** This car takes no contact */
  ghost = false;

  update(dtS: number, m: SelfMotion): void {
    if (!(dtS > 0)) return;
    if (this.prevS !== null && m.lapLengthM > 0) {
      let ds = m.trackS - this.prevS;
      if (ds > m.lapLengthM / 2) ds -= m.lapLengthM;
      else if (ds < -m.lapLengthM / 2) ds += m.lapLengthM;
      const along = ds / dtS;
      // The projection onto the track can jump (a crossover, a teleport): such a step says nothing about direction
      if (Math.abs(along) <= m.speedMs * 1.5 + 5) this.alongMs = along;
    }
    this.prevS = m.trackS;

    const cause = m.offTrack || m.speedMs < SLOW_MS || this.alongMs < -WRONG_WAY_MS;
    if (cause) {
      this.causeS += dtS;
      this.clearS = 0;
      if (this.causeS >= FLAG_AFTER_S) this.flag = true;
      if (this.causeS >= GHOST_AFTER_S) this.ghost = true;
    } else {
      this.clearS += dtS;
      this.causeS = 0;
      if (this.clearS >= SOLID_AFTER_S) this.ghost = false;
      if (this.clearS >= FLAG_OFF_AFTER_S) this.flag = false;
    }
  }
}

/** Contact between the player and one other car */
export class PairGuard {
  /** Kept apart; a new pair starts that way until it is first seen clear */
  blocked = true;
  /** Kept apart because of a ram (for drawing the other car as passing through) */
  ram = false;

  /** True when the other car is not to be touched this frame */
  update(self: GuardBody, other: GuardBody, selfGhost: boolean, otherHazard: boolean): boolean {
    const dx = other.x - self.x;
    const dz = other.z - self.z;
    const dist = Math.hypot(dx, dz);
    let ram = false;
    if (dist > 0.01 && dist < RAM_MAX_RANGE_M) {
      const nx = dx / dist;
      const nz = dz / dist;
      // Each car's speed toward the other; the one driving in harder is the striker
      const mine = self.vx * nx + self.vz * nz;
      const theirs = -(other.vx * nx + other.vz * nz);
      const closing = mine + theirs;
      const limit = mine > theirs ? RAM_STRIKER_MS : RAM_VICTIM_MS;
      // Called before the cars touch: once contact is resolved the closing speed is gone
      ram = closing > limit && dist - TOUCH_DIST_M < closing * RAM_HORIZON_S;
    }
    if (ram) this.ram = true;
    if (ram || selfGhost || otherHazard) this.blocked = true;
    else if (dist > CLEAR_DIST_M) {
      this.blocked = false;
      this.ram = false;
    }
    return this.blocked;
  }
}

/** One race's fair-play state for the player's car: its own hazard state and a guard per other car */
export class ContactGuard {
  readonly self = new HazardState();
  private readonly pairs = new Map<string, PairGuard>();

  /** True when the car `peerId` is not to be touched this frame; `otherHazard` is the flag from its packets */
  blocks(peerId: string, self: GuardBody, other: GuardBody, otherHazard: boolean): boolean {
    let pair = this.pairs.get(peerId);
    if (!pair) {
      pair = new PairGuard();
      this.pairs.set(peerId, pair);
    }
    return pair.update(self, other, this.self.ghost, otherHazard);
  }

  /** The car `peerId` is passing through because it rammed, or was rammed by, the player */
  rammed(peerId: string): boolean {
    return this.pairs.get(peerId)?.ram === true;
  }
}
