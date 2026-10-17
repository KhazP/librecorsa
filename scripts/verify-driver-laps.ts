/**
 * Player-style laps on the Rwanda circuit for both cars (VF26 and f12026-car) in every assist preset.
 *
 * The driver is deliberately not the game AI: no knowledge of tyre loads or ABS internals, only what a player
 * feels. It steers by pursuit on the racing line with an integral trim, countersteers body slip, eases the lock
 * when the wheel goes light (fronts well past their peak slip angle), comes off the brake when a tyre locks, and
 * plans its braking points at 80 % of the car's deceleration. Each lap must finish without a spin and without the
 * car's centre leaving the asphalt by more than 0.5 m.
 *
 * Usage: npx tsx scripts/verify-driver-laps.ts [pace list, default 1] (pace = fraction of the circuit's speed profile)
 * DBG=<s> prints a trace of the 120 m from s.
 */
import * as THREE from 'three';
import { getRwandaTrackData } from '../src/lib/track-data';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { aiLineOffsetM } from '../src/lib/sim/speed-profile';
import type { DriverAssistPreset } from '../src/types/f1';
import { loadGlbGeometry } from './lib/glb-geometry';

const track = getRwandaTrackData(1200);
const root = loadGlbGeometry('public/tracks/rwanda/rwanda_2026.glb');
const L = track.totalLengthM;
const wrap = (s: number) => ((s % L) + L) % L;
const DT = 1 / 120;
const RAD2DEG = 180 / Math.PI;

function curvature(s: number): number {
  const a = track.getSampleAtDistance(wrap(s - 6));
  const b = track.getSampleAtDistance(wrap(s + 6));
  const ta = new THREE.Vector2(a.tangent.x, a.tangent.z).normalize();
  const tb = new THREE.Vector2(b.tangent.x, b.tangent.z).normalize();
  const bn = track.getSampleAtDistance(wrap(s)).binormal;
  return tb.sub(ta).dot(new THREE.Vector2(bn.x, bn.z).normalize()) / 12;
}

/** Deceleration the driver plans braking points with (m/s²): 80 % of an F1 car's, rising with downforce */
const plannedDecel = (u: number) => 0.8 * 9.81 * (1.6 + 3.5 * Math.min(1, (u / 83) ** 2));

interface LapResult {
  finished: boolean;
  timeS: number;
  maxSlipDeg: number;
  spins: number;
  maxBeyondEdgeM: number;
  notes: string[];
}

function driveLap(car: 'vf26' | 'f12026', preset: DriverAssistPreset, pace: number): LapResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = car === 'vf26' ? new F1Physics2026(track) : new F12026CarSim(track, root);
  c.assistPreset = preset;
  c.setAssistPreset?.(preset);
  c.teleportToDistance(200, 60 / 3.6);
  let steerLimit = 1, latRateF = 0, thr = 0, brakeCap = 1, iLat = 0;
  let prevLat = c.lateralOffsetM, prevS = c.sMeters, dist = 0, t = 0;
  let maxSlip = 0, maxOff = 0, spins = 0, inSpin = false;
  const notes: string[] = [];
  while (dist < L + 100 && t < 200) {
    const s = c.sMeters;
    const v = Math.max(5, c.vxMs);
    // ---- steering: pursuit + lateral-rate damping + curvature feed-forward + slip countersteer + trim
    const latT = aiLineOffsetM(track.getSampleAtDistance(wrap(s + v * 0.35)));
    latRateF += ((c.lateralOffsetM - prevLat) / DT - latRateF) * 0.6;
    prevLat = c.lateralOffsetM;
    const want = Math.atan2(latT - c.lateralOffsetM, 12 + 0.7 * v);
    const cur = Math.atan2(latRateF, v);
    const beta = Math.atan2(c.vyMs, Math.max(1, c.vxMs));
    iLat = THREE.MathUtils.clamp(iLat + (aiLineOffsetM(track.getSampleAtDistance(wrap(s))) - c.lateralOffsetM) * 0.02 * DT, -0.08, 0.08);
    const fronts = (c.vehicle?.wheels ?? c.wheels).slice(0, 2);
    const frontSlipDeg = Math.max(...fronts.map((w: { slipAngleRad?: number }) => Math.abs(w.slipAngleRad ?? 0))) * RAD2DEG;
    // the wheel goes light well past the fronts' peak: ease off the lock
    steerLimit = THREE.MathUtils.clamp(steerLimit + (frontSlipDeg > 10 ? -2.5 : 1.0) * DT, 0.3, 1);
    const steer = THREE.MathUtils.clamp(
      15 * curvature(s + v * 0.15) + ((4.4 * 30) / (30 + v)) * (want - cur) + 0.6 * beta + iLat,
      -steerLimit,
      steerLimit
    );
    // ---- speed: the circuit profile × pace, with braking points planned at a trusted deceleration
    let vTarget = (pace * track.getSampleAtDistance(wrap(s + v * 0.4)).optimalSpeedKmh) / 3.6;
    for (let d = 0; d <= 300; d += 5) {
      const vc = (pace * track.getSampleAtDistance(wrap(s + v * 0.15 + d)).optimalSpeedKmh) / 3.6;
      if (vc < vTarget) vTarget = Math.min(vTarget, Math.sqrt(vc * vc + 2 * plannedDecel(vc) * d));
    }
    const e = vTarget - v;
    const sr: number[] = c.telemetry.wheelSlipRatios ?? [0, 0, 0, 0];
    const rearSpin = Math.max(sr[2], sr[3]);
    const lock = Math.min(...sr);
    const thrCap = THREE.MathUtils.clamp(1.15 - 5 * Math.abs(steer), 0.25, 1) * (Math.abs(beta) > 0.06 ? 0.4 : 1);
    thr = Math.min(thrCap, e >= 0 ? Math.min(thr + 2.5 * DT, 0.3 + e * 0.5) : 0);
    if (rearSpin > 0.12) thr = Math.max(0, thr - 6 * DT);
    // feels the lock-up and comes off the pedal, then squeezes back on
    brakeCap = THREE.MathUtils.clamp(brakeCap + (lock < -0.14 ? -8 : 4) * DT, 0.1, 1);
    const brake = e < 0 ? Math.min(brakeCap, THREE.MathUtils.clamp(-e * 0.25, 0, 1)) : 0;
    c.step(DT, e >= 0 ? { throttle: thr, analogSteer: steer } : { brake, analogSteer: steer });
    t += DT;
    if (process.env.DBG && Math.round(t * 120) % 6 === 0 && s > +process.env.DBG && s < +process.env.DBG + 120) {
      console.log(
        `s ${s.toFixed(0)} v ${(v * 3.6).toFixed(0)} lat ${c.lateralOffsetM.toFixed(2)} line ${latT.toFixed(2)} ` +
          `vT ${(vTarget * 3.6).toFixed(0)} steer ${steer.toFixed(2)} thr ${thr.toFixed(2)} brk ${brake.toFixed(2)} ` +
          `sr ${sr.map((x) => x.toFixed(2)).join('/')} slip ${(beta * RAD2DEG).toFixed(1)} fsa ${frontSlipDeg.toFixed(1)}`
      );
    }
    let ds = c.sMeters - prevS;
    if (ds < -L / 2) ds += L;
    if (ds > L / 2) ds -= L;
    dist += ds;
    prevS = c.sMeters;
    const slip = Math.abs(Math.atan2(c.vyMs, Math.max(1, Math.abs(c.vxMs)))) * RAD2DEG;
    maxSlip = Math.max(maxSlip, slip);
    if (slip > 25 && !inSpin) {
      spins++;
      inSpin = true;
      notes.push(`spin at s ${s.toFixed(0)} (${(v * 3.6).toFixed(0)} km/h)`);
    }
    if (slip < 10) inSpin = false;
    const off = Math.abs(c.lateralOffsetM) - track.getSampleAtDistance(wrap(s)).width / 2;
    if (off > maxOff) maxOff = off;
    if (off > 1 && !notes.some((n) => n.startsWith('off'))) notes.push(`off at s ${s.toFixed(0)} (${(v * 3.6).toFixed(0)} km/h)`);
  }
  return { finished: dist >= L, timeS: t, maxSlipDeg: maxSlip, spins, maxBeyondEdgeM: Math.max(0, maxOff), notes };
}

const paces = (process.argv[2] ?? '1').split(',').map(Number);
let failed = 0;
for (const car of ['vf26', 'f12026'] as const) {
  for (const preset of ['assisted', 'semi_pro', 'pro'] as const) {
    for (const pace of paces) {
      const r = driveLap(car, preset, pace);
      const ok = r.finished && r.spins === 0 && r.maxBeyondEdgeM <= 0.5;
      if (!ok) failed++;
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${car === 'vf26' ? 'VF26' : 'f12026-car'} ${preset} pace ${pace}: ` +
          `${r.finished ? `lap ${r.timeS.toFixed(2)} s` : 'did not finish'}, max body slip ${r.maxSlipDeg.toFixed(1)}°, ` +
          `${r.spins} spins, centre ${r.maxBeyondEdgeM.toFixed(1)} m past the edge ${r.notes.slice(0, 2).join('; ')}`
      );
    }
  }
}
console.log(failed ? `${failed} driver lap(s) failed.` : 'All driver laps clean.');
process.exit(failed ? 1 : 0);
