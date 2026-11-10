/**
 * Headless checks for an open race's fair-play contact rule (src/lib/sim/contact-guard.ts).
 *
 *   npx tsx scripts/verify-contact-guard.ts
 *
 *  1. A car judging itself: slow, wrong way and off the track make it a hazard, with the flag up before it stops
 *     taking contact and down after it takes contact again; racing speeds, kerb touches and the lap line do not
 *  2. One pair: a ram is called before the cars touch, the car being hit from a lower speed than the striker;
 *     racing contact is left alone; a pair kept apart is solid again only once clear
 *  3. Two clients, each seeing the other late: whenever they disagree about a contact, the car that is moved is the
 *     one that caused the danger, never the car it endangered
 */
import {
  CLEAR_DIST_M,
  ContactGuard,
  FLAG_AFTER_S,
  FLAG_OFF_AFTER_S,
  GHOST_AFTER_S,
  HazardState,
  PairGuard,
  RAM_STRIKER_MS,
  RAM_VICTIM_MS,
  SOLID_AFTER_S,
  type GuardBody,
} from '../src/lib/sim/contact-guard';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(66)} ${detail}`);
  if (!ok) failures.push(name);
};

const DT = 1 / 60;
const LAP = 5000;

// ---- 1. A car judging itself -----------------------------------------------------------------------------------------
{
  /** Runs a car for `seconds` at `speedMs` (negative: backwards along the track); returns when flag and ghost changed */
  const run = (h: HazardState, s0: number, seconds: number, speedMs: number, offTrack = false) => {
    let s = s0;
    let flagAt: number | null = null;
    let ghostAt: number | null = null;
    const flag0 = h.flag;
    const ghost0 = h.ghost;
    for (let t = DT; t <= seconds + 1e-9; t += DT) {
      s = (((s + speedMs * DT) % LAP) + LAP) % LAP;
      h.update(DT, { speedMs: Math.abs(speedMs), trackS: s, lapLengthM: LAP, offTrack });
      if (flagAt === null && h.flag !== flag0) flagAt = t;
      if (ghostAt === null && h.ghost !== ghost0) ghostAt = t;
    }
    return { s, flagAt, ghostAt };
  };
  const near = (v: number | null, want: number) => v !== null && Math.abs(v - want) < 0.05;

  let h = new HazardState();
  let r = run(h, 100, 3, 60);
  check('racing speed is no hazard', !h.flag && !h.ghost);
  r = run(h, r.s, 2, 3);
  check('a stopped car: flag first, then no contact', near(r.flagAt, FLAG_AFTER_S) && near(r.ghostAt, GHOST_AFTER_S), `flag ${r.flagAt?.toFixed(2)} s, ghost ${r.ghostAt?.toFixed(2)} s`);
  r = run(h, r.s, 3, 40);
  check('moving again: contact first, then the flag down', near(r.ghostAt, SOLID_AFTER_S) && near(r.flagAt, FLAG_OFF_AFTER_S), `solid ${r.ghostAt?.toFixed(2)} s, flag off ${r.flagAt?.toFixed(2)} s`);

  h = new HazardState();
  r = run(h, 100, 1, 50);
  r = run(h, r.s, 1.5, -30);
  check('the wrong way is a hazard', h.flag && h.ghost, `flag after ${r.flagAt?.toFixed(2)} s`);

  h = new HazardState();
  r = run(h, 100, 1, 50);
  r = run(h, r.s, 1.2, 50, true);
  check('off the track is a hazard', h.flag && h.ghost);
  r = run(h, r.s, 1.0, 50);
  check('still one just after the rejoin', h.flag && h.ghost);
  r = run(h, r.s, 1.0, 50);
  check('and not once settled back on the track', !h.flag && !h.ghost);

  h = new HazardState();
  r = run(h, 100, 1, 50);
  for (let i = 0; i < 6; i++) {
    r = run(h, r.s, 0.25, 50, true);
    r = run(h, r.s, 0.25, 50);
  }
  check('kerb touches are not', !h.flag && !h.ghost);

  h = new HazardState();
  r = run(h, 100, 4, 11.5);
  check('a slow hairpin (41 km/h) is not', !h.flag && !h.ghost);

  h = new HazardState();
  r = run(h, 100, 2, 60);
  r = run(h, r.s, 2, 8.1);
  check('a car left creeping in gear (29 km/h) is', h.flag && h.ghost);

  h = new HazardState();
  r = run(h, LAP - 80, 3, 70);
  check('crossing the lap line is not the wrong way', !h.flag && !h.ghost && r.s < 200, `s ${r.s.toFixed(0)} m`);

  h = new HazardState();
  r = run(h, 100, 1, 60);
  h.update(DT, { speedMs: 60, trackS: r.s - 900, lapLengthM: LAP, offTrack: false });
  r = run(h, r.s - 900, 1, 60);
  check('a jump of the track position is not the wrong way', !h.flag && !h.ghost);
}

// ---- 2. One pair ------------------------------------------------------------------------------------------------------
{
  const body = (z: number, vz: number, x = 0, vx = 0): GuardBody => ({ x, z, vx, vz });
  /** A fresh pair that has been seen clear */
  const clearPair = () => {
    const p = new PairGuard();
    p.update(body(0, 50), body(40, 50), false, false);
    return p;
  };

  const fresh = new PairGuard();
  check('a new pair on top of each other is kept apart', fresh.update(body(0, 50), body(3, 50), false, false));
  check('and solid once clear', !fresh.update(body(0, 50), body(CLEAR_DIST_M + 1, 50), false, false));

  // The car behind closes at `closing`; who is blocked just before the touch (centres 5.6 m apart)
  const atTouch = (closing: number) => {
    const behind = clearPair();
    const ahead = clearPair();
    return {
      striker: behind.update(body(0, 50 + closing), body(5.6, 50), false, false),
      victim: ahead.update(body(5.6, 50), body(0, 50 + closing), false, false),
    };
  };
  const tap = atTouch(6);
  check('a tap from behind (22 km/h) is racing contact', !tap.striker && !tap.victim);
  const band = atTouch((RAM_VICTIM_MS + RAM_STRIKER_MS) / 2);
  check('between the limits only the car being hit is protected', band.victim && !band.striker);
  const ram = atTouch(RAM_STRIKER_MS + 3);
  check('a ram passes through, for both', ram.victim && ram.striker);

  const early = clearPair();
  check('a ram is called before the cars touch', early.update(body(0, 90), body(18, 50), false, false), 'closing 40 m/s at 18 m');
  check('but not from far away', !clearPair().update(body(0, 90), body(60, 50), false, false));

  const side = clearPair();
  check('leaning on a car alongside is racing contact', !side.update(body(0, 60, 0, 1.5), body(0.5, 60, 2.1, -1.5), false, false));

  const latch = clearPair();
  latch.update(body(0, 80), body(8, 50), false, false);
  check('a ram stays a pass-through while the cars overlap', latch.update(body(0, 52), body(1, 50), false, false) && latch.ram);
  check('and ends once they are clear', !latch.update(body(0, 52), body(-CLEAR_DIST_M - 1, 50), false, false) && !latch.ram);

  const hz = clearPair();
  check('a car flagged a hazard is not touched', hz.update(body(0, 60), body(5.2, 2), false, true));
  check('nor anyone by a car that takes no contact', clearPair().update(body(0, 2), body(5.2, 2), true, false));
}

// ---- 3. Two clients ---------------------------------------------------------------------------------------------------
interface Car {
  /** Position along a straight (m) and speed (m/s) at time t */
  z: (t: number) => number;
  v: (t: number) => number;
}
interface Outcome {
  /** A client resolved contact for its own car at least once */
  movedA: boolean;
  movedB: boolean;
  /** The cars were truly in contact at some point */
  touched: boolean;
}

/** Two cars on a straight, each client seeing the other `latencyS` late and predicted to the present, as the game does */
function twoClients(A: Car, B: Car, seconds: number, latencyS: number): Outcome {
  const gA = new ContactGuard();
  const gB = new ContactGuard();
  const flagsA: boolean[] = [];
  const flagsB: boolean[] = [];
  const lag = Math.round(latencyS / DT);
  const out: Outcome = { movedA: false, movedB: false, touched: false };
  const seen = (c: Car, t: number): GuardBody => {
    const t0 = Math.max(0, t - latencyS);
    return { x: 0, z: c.z(t0) + c.v(t0) * (t - t0), vx: 0, vz: c.v(t0) };
  };
  const me = (c: Car, t: number): GuardBody => ({ x: 0, z: c.z(t), vx: 0, vz: c.v(t) });
  for (let i = 0, t = 0; t <= seconds; i++, t += DT) {
    gA.self.update(DT, { speedMs: Math.abs(A.v(t)), trackS: ((A.z(t) % LAP) + LAP) % LAP, lapLengthM: LAP, offTrack: false });
    gB.self.update(DT, { speedMs: Math.abs(B.v(t)), trackS: ((B.z(t) % LAP) + LAP) % LAP, lapLengthM: LAP, offTrack: false });
    flagsA.push(gA.self.flag);
    flagsB.push(gB.self.flag);
    const bSeen = seen(B, t);
    const aSeen = seen(A, t);
    const blockedA = gA.blocks('B', me(A, t), bSeen, flagsB[Math.max(0, i - lag)]);
    const blockedB = gB.blocks('A', me(B, t), aSeen, flagsA[Math.max(0, i - lag)]);
    if (Math.abs(A.z(t) - B.z(t)) < 5) out.touched = true;
    // Each client resolves its own car against the other as it sees it
    if (!blockedA && Math.abs(bSeen.z - A.z(t)) < 5) out.movedA = true;
    if (!blockedB && Math.abs(aSeen.z - B.z(t)) < 5) out.movedB = true;
  }
  return out;
}

const steady = (z0: number, v: number): Car => ({ z: (t) => z0 + v * t, v: () => v });
const LATENCIES = [0.02, 0.05, 0.09, 0.14];

{
  // A car parked on the racing line, another arriving at 216 km/h
  let bad = 0;
  for (const L of LATENCIES) {
    const o = twoClients(steady(600, 0), steady(300, 60), 10, L);
    if (!o.touched || o.movedA || o.movedB) bad++;
  }
  check('a parked car is driven through, and is not moved itself', bad === 0, `${LATENCIES.length} latencies`);
}
{
  // A car coming the wrong way at speed
  let bad = 0;
  for (const L of LATENCIES) {
    const o = twoClients(steady(900, -50), steady(100, 60), 12, L);
    if (!o.touched || o.movedA || o.movedB) bad++;
  }
  check('a car coming the wrong way is driven through', bad === 0);
}
{
  // The car behind (B) runs into the car ahead (A) at every closing speed and latency
  let victimOnly = 0;
  let racing = 0;
  let through = 0;
  let strikerOnly = 0;
  let worst = '';
  for (let closing = 2; closing <= 40; closing += 0.5) {
    for (const L of LATENCIES) {
      const o = twoClients(steady(400, 50), steady(300, 50 + closing), 200 / closing + 2, L);
      if (o.movedA && !o.movedB) {
        victimOnly++;
        worst ||= `closing ${closing} m/s, ${L * 1000} ms`;
      } else if (o.movedA && o.movedB) racing++;
      else if (o.movedB) strikerOnly++;
      else through++;
    }
  }
  check('a hit from behind never moves only the car that was hit', victimOnly === 0, worst || `${racing} racing, ${strikerOnly} striker only, ${through} through`);
  const slow = twoClients(steady(400, 50), steady(300, 56), 40, 0.05);
  check('a 22 km/h tap is contact for both', slow.movedA && slow.movedB);
  const hard = twoClients(steady(400, 50), steady(300, 75), 12, 0.05);
  check('a 90 km/h ram is a pass-through for both', hard.touched && !hard.movedA && !hard.movedB);
}
{
  // A car spins to a stop 25 m ahead of one following at 180 km/h: it is hit before its own flag could go up
  let bad = 0;
  for (const L of LATENCIES) {
    const spun: Car = { z: (t) => 425 + (t < 0.5 ? 50 * t - 50 * t * t : 12.5), v: (t) => (t < 0.5 ? 50 - 100 * t : 0) };
    const o = twoClients(spun, steady(400, 50), 8, L);
    if (!o.touched || o.movedA || o.movedB) bad++;
  }
  check('a car that has just spun is not collected', bad === 0);
}
{
  // A stopped car (A) pulls away while another (B) catches it at 43 km/h, arriving at every moment of A's recovery:
  // while the two clients disagree about A, only A may be moved
  let bad = 0;
  let oneSided = 0;
  let cases = 0;
  // (from 26 m back, so that A has been standing long enough to be flagged when B arrives)
  for (let gap = 26; gap <= 70; gap += 2) {
    for (const L of LATENCIES) {
      const away: Car = { z: (t) => 400 + (t < 2 ? 0 : 0.5 * 4 * (t - 2) ** 2), v: (t) => (t < 2 ? 0 : 4 * (t - 2)) };
      const o = twoClients(away, steady(400 - gap, 12), 9, L);
      cases++;
      if (o.movedB && !o.movedA) bad++;
      if (o.movedA && !o.movedB) oneSided++;
    }
  }
  check('a car recovering from a stop is never the one that moves another', bad === 0, `${cases} cases, ${oneSided} where only it was moved`);
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nAll contact-guard checks passed.');
process.exit(failures.length ? 1 : 0);
