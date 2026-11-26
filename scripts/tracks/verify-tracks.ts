/**
 * Checks every converted circuit (public/tracks/index.json) through the real track-data / physics code:
 * track data builds without NaNs, the grid sits on the road, the GLB carries the collider nodes, and a
 * player-style driver completes a lap in both F1 cars on the F1 line and in the GT3 on its own line, paced from
 * its own speed guide. The driver sees only what a player does: the drawn line (and how it bends), the guide speed,
 * the road's crests, the yaw and slide it feels, the wheel going light and wheels locking or spinning.
 *
 * Usage: npx tsx scripts/tracks/verify-tracks.ts [id,id,...] [pace, default 0.9]
 *        TRACK_JSON_DIR=<dir> reads <dir>/<id>.json in place of each circuit's track_data.json
 */
import * as THREE from 'three';
import { existsSync, readFileSync } from 'node:fs';
import { getActiveTrackData, setActiveTrack, RWANDA_DRS_ZONES, BASE_ALTITUDE_M, type BuiltTrackData, type RawTrackJson } from '../../src/lib/track-data';
import { F1Physics2026 } from '../../src/lib/f1-physics-2026';
import { F12026CarSim } from '../../src/lib/sim/f12026-car/F12026CarSim';
import { aiLineOffsetM, computeSpeedProfile, createLc26ProfileCarModel, sampleProfile } from '../../src/lib/sim/speed-profile';
import { createAmgGt3Sim } from '../../src/lib/sim/gt3/AmgGt3Sim';
import { loadGlbGeometry, trackModelFiles } from '../lib/glb-geometry';

const DT = 1 / 120;
const RAD2DEG = 180 / Math.PI;
const plannedDecel = (u: number) => 0.8 * 9.81 * (1.6 + 3.5 * Math.min(1, (u / 83) ** 2));

interface LapResult {
  finished: boolean;
  timeS: number;
  maxSlipDeg: number;
  spins: number;
  maxBeyondEdgeM: number;
  notes: string[];
}

function driveLap(track: BuiltTrackData, root: THREE.Object3D, car: 'lc26' | 'f12026' | 'gt3', pace: number): LapResult {
  const L = track.totalLengthM;
  const wrap = (s: number) => ((s % L) + L) % L;
  // the line the driver follows, as drawn: its offset and its own path curvature (+ right), not the centreline's
  const line = car === 'gt3' ? 'gt3' : 'f1';
  const lineGeo = computeSpeedProfile(track.samples, createLc26ProfileCarModel(), line);
  const lineAt = (s: number) => sampleProfile(lineGeo.lineOffsetM, wrap(s), L);
  const lineCurvature = (s: number) => sampleProfile(lineGeo.curvature, wrap(s), L);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = car === 'lc26' ? new F1Physics2026(track) : car === 'gt3' ? createAmgGt3Sim(track, root) : new F12026CarSim(track, root);
  if (car === 'lc26') c.attachTrackRoot(root);
  // the GT3 paces off its own guide (target speeds and braking envelope on its line), the F1 cars off the circuit's
  const guide = car === 'gt3' ? c.brakingGuide : null;
  const guideAt = (s: number) =>
    guide ? sampleProfile(guide.speedMs, wrap(s), L) : track.getSampleAtDistance(wrap(s)).optimalSpeedKmh / 3.6;
  // The guide is flat-road; a driver lifts for a crest in a corner. Over a crest (vertical curvature kv < 0) the
  // tyres lose m·v²·|kv| of load, so the lateral grip the guide planned with, a = v²κ, shrinks by the share of the
  // mechanical + aero load that goes: a' = a·(1 + v²kv / (g + aero)). Solved for v at the paced speed.
  const aeroG = car === 'gt3' ? 0.6 : 2.4; // rough downforce per weight at 250 km/h
  const nT = track.samples.length;
  const paceTarget = new Float64Array(nT);
  for (let i = 0; i < nT; i++) {
    const si = (i / nT) * L;
    const y = (d: number) => track.getSampleAtDistance(wrap(si + d)).position.y;
    const kv = (y(-20) - 2 * y(0) + y(20)) / 400;
    const k = Math.abs(lineCurvature(si));
    let vp = pace * guideAt(si);
    if (kv < 0 && k > 5e-4) {
      for (let it = 0; it < 4; it++) {
        const support = 9.81 * (1 + aeroG * (vp / 69.4) ** 2);
        const need = (pace * guideAt(si)) ** 2 * k;
        vp = Math.min(pace * guideAt(si), Math.sqrt((need * Math.max(0.3, 1 + (vp * vp * kv) / support)) / k));
      }
    }
    paceTarget[i] = vp;
  }
  const targetAt = (s: number) => sampleProfile(paceTarget, wrap(s), L);
  const decelOf = (u: number) => (guide ? 0.8 * 9.81 * (1.0 + 0.35 * Math.min(1, (u / 70) ** 2)) : plannedDecel(u));
  c.assistPreset = 'assisted';
  c.setAssistPreset?.('assisted');
  c.teleportToDistance(60, 60 / 3.6);
  const wheelbase: number = c.wheelbaseM ?? 3.4;
  const maxLock: number = c.maxSteerAngleRad ?? 0.34;
  let steerLimit = 1, thr = 0, brakeCap = 1, yawI = 0, yawF = 0;
  let eRate = 0, prevE = c.lateralOffsetM - lineAt(c.sMeters), prevS = c.sMeters, dist = 0, t = 0;
  let maxSlip = 0, maxOff = 0, spins = 0, inSpin = false;
  const notes: string[] = [];
  // DIAG: rolling 2 s history, dumped with the track data under the car at the first incident
  const hist: string[] = [];
  let dumped = !process.env.DIAG;
  const dump = (why: string) => {
    if (dumped) return;
    dumped = true;
    console.log(`  --- ${car} first incident: ${why}`);
    for (const h of hist) console.log(h);
    const s0 = c.sMeters;
    for (let d = -60; d <= 40; d += 10) {
      const sp = track.getSampleAtDistance(wrap(s0 + d));
      const ud = sp as unknown as { yProfile?: number[]; latProfile?: number[] };
      console.log(`    track s ${wrap(s0 + d).toFixed(0)} k ${(sp.curvature * 1000).toFixed(1)}e-3 w ${sp.width.toFixed(1)} bank ${(sp.bankingRad * RAD2DEG).toFixed(1)}° y ${sp.position.y.toFixed(2)} vopt ${sp.optimalSpeedKmh.toFixed(0)} line ${aiLineOffsetM(sp, line).toFixed(1)} ${ud.yProfile ? 'prof ' + ud.yProfile.map((v) => (v - sp.position.y).toFixed(2)).join(' ') : ''}`);
    }
  };
  while (dist < L + 100 && t < 300) {
    const s = c.sMeters;
    const v = Math.max(5, c.vxMs);
    // ---- steering: follow the line as a yaw rate. Feed-forward from the line's own curvature (it bends across the
    // full width, so the centreline's says little), a second-order pull-in on the distance to the line and its rate,
    // then the steer that gives that yaw rate: kinematic, plus feedback on the yaw rate the driver feels (smoothed
    // over bumps), plus a slow trim for the car's understeer at speed
    const eLine = c.lateralOffsetM - lineAt(s); // + = right of the line
    eRate += ((eLine - prevE) / DT - eRate) * 0.5;
    prevE = eLine;
    const beta = Math.atan2(c.vyMs, Math.max(1, c.vxMs));
    const fronts = (c.vehicle?.wheels ?? c.wheels).slice(0, 2);
    const frontSlipDeg = Math.max(...fronts.map((w: { slipAngleRad?: number }) => Math.abs(w.slipAngleRad ?? 0))) * RAD2DEG;
    // the wheel goes light well past the fronts' peak: ease off the lock
    steerLimit = THREE.MathUtils.clamp(steerLimit + (frontSlipDeg > 10 ? -2.5 : 1.0) * DT, 0.3, 1);
    const omega = THREE.MathUtils.clamp(2.2 - v * 0.008, 1.4, 2.2);
    const zeta = 0.9;
    const course = THREE.MathUtils.clamp(eRate / v, -0.35, 0.35);
    const yawRef =
      v * lineCurvature(s + Math.max(2, v * 0.12)) - 2 * zeta * omega * course - (omega * omega * THREE.MathUtils.clamp(eLine, -3.5, 3.5)) / v;
    yawF += (c.yawRateRadS - yawF) * Math.min(1, DT / 0.05);
    const yawErr = yawRef - yawF;
    const lv = wheelbase / v;
    if (frontSlipDeg < 6) yawI = THREE.MathUtils.clamp(yawI + (0.5 + 3 * lv) * yawErr * DT, -0.05, 0.05);
    const steerWant = (Math.atan(lv * yawRef) + 3 * lv * yawErr + yawI) / maxLock - 0.3 * beta;
    // the light-wheel limit is for understeer; a countersteer (against the slide, β + = sliding left) keeps its lock
    const lim = steerWant * beta < 0 && Math.abs(beta) > 0.05 ? 1 : steerLimit;
    const steer = THREE.MathUtils.clamp(steerWant, -lim, lim);
    let vTarget = targetAt(s + v * 0.4);
    for (let d = 0; d <= 300; d += 5) {
      const vc = targetAt(s + v * 0.15 + d);
      if (vc < vTarget) vTarget = Math.min(vTarget, Math.sqrt(vc * vc + 2 * decelOf(vc) * d));
    }
    const e = vTarget - v;
    const sr: number[] = c.telemetry.wheelSlipRatios ?? [0, 0, 0, 0];
    const rearSpin = Math.max(sr[2], sr[3]);
    const lock = Math.min(...sr);
    const thrCap = THREE.MathUtils.clamp(1.15 - 5 * Math.abs(steer), 0.25, 1) * (Math.abs(beta) > 0.06 ? 0.4 : 1);
    thr = Math.min(thrCap, e >= 0 ? Math.min(thr + 2.5 * DT, 0.3 + e * 0.5) : 0);
    if (rearSpin > 0.12) thr = Math.max(0, thr - 6 * DT);
    brakeCap = THREE.MathUtils.clamp(brakeCap + (lock < -0.14 ? -8 : 4) * DT, 0.1, 1);
    const brake = e < 0 ? Math.min(brakeCap, THREE.MathUtils.clamp(-e * 0.25, 0, 1)) : 0;
    try {
      c.step(DT, e >= 0 ? { throttle: thr, analogSteer: steer } : { brake, analogSteer: steer });
    } catch (err) {
      notes.push(`threw at t ${t.toFixed(2)} s ${s.toFixed(0)} v ${(v * 3.6).toFixed(0)} km/h lat ${c.lateralOffsetM?.toFixed?.(1)}: ${String(err).slice(0, 80)}`);
      break;
    }
    t += DT;
    let ds = c.sMeters - prevS;
    if (ds < -L / 2) ds += L;
    if (ds > L / 2) ds -= L;
    dist += ds;
    prevS = c.sMeters;
    if (!Number.isFinite(c.sMeters) || !Number.isFinite(c.vxMs)) {
      notes.push(`NaN state at t ${t.toFixed(1)}`);
      break;
    }
    if (process.env.TRACE && Math.abs(wrap(s) - Number(process.env.TRACE)) < 150 && Math.round(t * 120) % 12 === 0) {
      const sp = track.getSampleAtDistance(wrap(s));
      console.log(`  s ${s.toFixed(0)} v ${(v * 3.6).toFixed(0)} lat ${c.lateralOffsetM.toFixed(2)} tgt ${lineAt(s).toFixed(2)} yaw ${c.yawRateRadS.toFixed(2)}/${yawRef.toFixed(2)} ff ${(v * lineCurvature(s)).toFixed(2)} yI ${yawI.toFixed(3)} hw ${(sp.width / 2).toFixed(2)} steer ${steer.toFixed(3)} lim ${steerLimit.toFixed(2)} fslip ${frontSlipDeg.toFixed(1)} beta ${(beta * RAD2DEG).toFixed(1)} y ${c.position?.y?.toFixed?.(2) ?? ''} bank ${(sp.bankingRad ?? 0).toFixed(3)}`);
    }
    if (!dumped && Math.round(t * 120) % 6 === 0) {
      const sp = track.getSampleAtDistance(wrap(s));
      hist.push(`    t ${t.toFixed(2)} s ${s.toFixed(0)} v ${(v * 3.6).toFixed(0)} lat ${c.lateralOffsetM.toFixed(2)}/${lineAt(s).toFixed(2)} hw ${(sp.width / 2).toFixed(1)} steer ${steer.toFixed(3)} thr ${thr.toFixed(2)} brk ${brake.toFixed(2)} fslip ${frontSlipDeg.toFixed(1)} beta ${(beta * RAD2DEG).toFixed(1)} sr ${sr.map((x) => x.toFixed(2)).join(',')} yaw ${c.yawRateRadS.toFixed(2)}`);
      if (hist.length > 24) hist.shift();
    }
    const slip = Math.abs(Math.atan2(c.vyMs, Math.max(1, Math.abs(c.vxMs)))) * RAD2DEG;
    maxSlip = Math.max(maxSlip, slip);
    if (slip > 25 && !inSpin) {
      spins++;
      inSpin = true;
      notes.push(`spin at s ${s.toFixed(0)} (${(v * 3.6).toFixed(0)} km/h)`);
      dump('spin');
    }
    if (slip < 10) inSpin = false;
    const off = Math.abs(c.lateralOffsetM) - track.getSampleAtDistance(wrap(s)).width / 2;
    if (off > maxOff) maxOff = off;
    if (off > 1) dump('off');
    if (off > 1 && notes.filter((n) => n.startsWith('off')).length < 3) notes.push(`off at s ${s.toFixed(0)} (${(v * 3.6).toFixed(0)} km/h)`);
  }
  return { finished: dist >= L, timeS: t, maxSlipDeg: maxSlip, spins, maxBeyondEdgeM: Math.max(0, maxOff), notes };
}

// RISE Motordrome comes first in the index: the baseline the thresholds are judged against
const index = JSON.parse(readFileSync('public/tracks/index.json', 'utf8')) as { id: string; name: string }[];
const only = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : null;
const entries = only
  ? only.map((id) => {
      const found = index.find((e) => e.id === id);
      if (found) return found;
      const standalone = `public/tracks/${id}/circuit.json`;
      if (existsSync(standalone)) return JSON.parse(readFileSync(standalone, 'utf8')) as { id: string; name: string };
      return { id, name: id };
    })
  : index;
const pace = Number(process.argv[3] ?? 0.9);
let failed = 0;
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};

for (const entry of entries) {
  // TRACK_JSON_DIR=<dir> reads <dir>/<id>.json instead (e.g. saved copies, to compare against a baseline)
  const raw = process.env.TRACK_JSON_DIR
    ? (JSON.parse(readFileSync(`${process.env.TRACK_JSON_DIR}/${entry.id}.json`, 'utf8')) as RawTrackJson)
    : (JSON.parse(readFileSync(`public/tracks/${entry.id}/track_data.json`, 'utf8')) as RawTrackJson);
  setActiveTrack(entry.id, raw);
  const track = getActiveTrackData(1200);
  const L = track.totalLengthM;
  console.log(`\n== ${entry.name} (${entry.id}): ${(L / 1000).toFixed(3)} km, ${raw.turns.length} turns, ${RWANDA_DRS_ZONES.length} DRS zones, base altitude ${BASE_ALTITUDE_M} m`);
  const bad = track.samples.filter(
    (s) => ![s.position.x, s.position.y, s.position.z, s.width, s.optimalSpeedKmh, s.curvature].every(Number.isFinite)
  );
  if (bad.length) fail(`${entry.id}: ${bad.length} samples with NaN`);
  let est = 0;
  for (const s of track.samples) est += (L / track.samples.length) / Math.max(5, s.optimalSpeedKmh / 3.6);
  console.log(`      speed-profile lap ${est.toFixed(1)} s, v ${Math.min(...track.samples.map((s) => s.optimalSpeedKmh)).toFixed(0)}..${Math.max(...track.samples.map((s) => s.optimalSpeedKmh)).toFixed(0)} km/h`);
  for (const slot of track.spawnGrid.slice(0, 4)) {
    const p = track.projectWorldToTrack(slot.position[0], slot.position[2], slot.s);
    if (Math.abs(p.lateralOffset) > p.sample.width / 2) fail(`${entry.id}: grid slot ${slot.slot} off the road (${p.lateralOffset.toFixed(1)} m)`);
  }
  const t0 = Date.now();
  // What the game loads: a venue's split pair (src/lib/venue-models.ts) when this copy has it, else the circuit's GLB
  const files = trackModelFiles({ id: entry.id, meshUrl: track.meshUrl });
  const root = loadGlbGeometry(files.path, files.shared);
  const names = new Set<string>();
  root.traverse((o) => names.add(o.name));
  for (const n of ['Track_Collider_Road', 'Track_Collider_Wall_Left', 'Track_Collider_Wall_Right', 'Track_Surface_Road']) {
    if (!names.has(n) && !entry.id.startsWith('rwanda_official')) fail(`${entry.id}: GLB has no ${n}`);
  }
  console.log(`      ${files.shared ? 'split pair' : 'GLB'} loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const car of ['lc26', 'f12026', 'gt3'] as const) {
    const r = driveLap(track, root, car, pace);
    const ok = r.finished && r.spins === 0 && r.maxBeyondEdgeM <= 1.0;
    if (!ok) failed++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${{ lc26: 'LC26', f12026: 'f12026-car', gt3: 'GT3' }[car]} pace ${pace}: ` +
        `${r.finished ? `lap ${r.timeS.toFixed(2)} s` : 'did not finish'}, max body slip ${r.maxSlipDeg.toFixed(1)}°, ` +
        `${r.spins} spins, centre ${r.maxBeyondEdgeM.toFixed(1)} m past the edge ${r.notes.slice(0, 3).join('; ')}`
    );
  }
}
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll circuits OK.');
process.exit(failed ? 1 : 0);
