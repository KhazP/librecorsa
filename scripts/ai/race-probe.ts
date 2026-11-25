/**
 * Where and why AI cars spin, leave the road or hit a wall in a headless race (`lib/stand-in-race.ts`): the race the A/B gate runs,
 * with a trace of every AI car kept for the last few seconds and printed at each spin and off, and a tally by lap, by
 * traffic (another car within 15 m along and 4 m across in the 2 s before) and by how far off its line the field had
 * moved it.
 *
 *   npx tsx scripts/ai/race-probe.ts --track rwanda_official_short --car liana [--seeds 0,1,2] [--laps 3] [--ai 7]
 *       [--stand-in line] [--plans '<plan checks json>'] [--racecraft '<json>'] [--skill 0-100] [--trace 0|1] [--json out.json]
 */
import { writeFileSync } from 'node:fs';
import { runStandInRace, type StandInProfile, type StandInRaceOptions } from './lib/stand-in-race';
import type { AiOpponentField } from '../../src/lib/sim/ai-opponents';
import type { SimulatorCar } from '../../src/lib/sim/simulator-car';
import { aiLineOffsetM } from '../../src/lib/sim/speed-profile';
import { sampleGrid } from '../../src/lib/sim/ai/ai-track';
import { getActiveTrackData } from '../../src/lib/track-data';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const trackId = opt('track', 'rwanda_official_short');
const car = opt('car', 'liana');
const seeds = opt('seeds', '0').split(',').map(Number);
const laps = Number(opt('laps', '3'));
const aiCars = Number(opt('ai', '7'));
const standIn = opt('stand-in', 'line') as StandInProfile;
const plans = argv.includes('--plans') ? (JSON.parse(opt('plans', '{}')) as StandInRaceOptions['plans']) : undefined;
const racecraft = JSON.parse(opt('racecraft', '{}'));
const trace = opt('trace', '1') !== '0';
const skill = argv.includes('--skill') ? Number(opt('skill', '70')) : undefined;

interface Frame {
  t: number;
  lap: number;
  s: number;
  v: number;
  lat: number;
  lineN: number;
  bias: number;
  biasTgt: number;
  cap: number;
  planV: number;
  head: number;
  steer: number;
  thr: number;
  brk: number;
  latG: number;
  near: string;
  nearDs: number;
  nearDl: number;
  mode: string;
  off: boolean;
}

interface Event {
  seed: number;
  kind: 'spin' | 'off' | 'wall' | 'contact';
  code: string;
  t: number;
  lap: number;
  s: number;
  v: number;
  traffic: boolean;
  maxBias: number;
  maxBiasStep: number;
  overPlan: number;
  frames: Frame[];
}

const events: Event[] = [];
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '-');

for (const k of seeds) {
  const o: StandInRaceOptions = { trackId, car, seed: 101 + k * 31, laps, aiCars, standIn, racecraft, plans, skill };
  const hist = new Map<string, Frame[]>();
  const offWas = new Map<string, number>();
  const wallWas = new Map<string, number>();
  const lastHit = new Map<string, number>();
  let nextS = 0;
  const r = runStandInRace(o, (field: AiOpponentField, t: number) => {
    const F = field as unknown as {
      cars: { code: string; ai: SimulatorCar | null; isPlayer: boolean; sim: SimulatorCar; biasM: number; biasTargetM: number; clock: { lapsDone: number }; control?: { mode: string } | null; stats: { offTracks: number; spins: number; wallHits: number }; removed: boolean }[];
      headingErr(s: SimulatorCar): number;
      incidents: { kind: string; code?: string; a?: string; b?: string; aIsPlayer?: boolean; bIsPlayer?: boolean; impactMs?: number }[];
    };
    const track = getActiveTrackData(1200);
    const L = track.totalLengthM;
    const sample = t >= nextS;
    if (sample) nextS = t + 0.1;
    const spun = new Set(F.incidents.filter((i) => i.kind === 'spin').map((i) => i.code as string));
    // Contacts with the stand-in: the AI car's side of it
    const hitPlayer = new Set(
      F.incidents.filter((i) => i.kind === 'contact' && (i.aIsPlayer || i.bIsPlayer)).map((i) => (i.aIsPlayer ? i.b : i.a) as string)
    );
    for (const c of F.cars) {
      if (!c.ai || c.removed) continue;
      const me = c.sim;
      const offNow = c.stats.offTracks > (offWas.get(c.code) ?? 0);
      offWas.set(c.code, c.stats.offTracks);
      const wallNow = c.stats.wallHits > (wallWas.get(c.code) ?? 0);
      wallWas.set(c.code, c.stats.wallHits);
      if (sample || spun.has(c.code) || offNow || wallNow || hitPlayer.has(c.code)) {
        let near = '', nearDs = Infinity, nearDl = Infinity;
        for (const o2 of F.cars) {
          if (o2 === c || o2.removed) continue;
          const ds = (((o2.sim.sMeters - me.sMeters) % L) + 1.5 * L) % L - L / 2;
          if (Math.abs(ds) < Math.abs(nearDs)) {
            near = o2.code;
            nearDs = ds;
            nearDl = o2.sim.lateralOffsetM - me.lateralOffsetM;
          }
        }
        const smp = track.getSampleAtDistance(me.sMeters);
        const plan = me.aiPlan;
        const lineN = plan ? sampleGrid(plan.n, me.sMeters, plan.track.ds) : aiLineOffsetM(smp, me.racingLineId);
        const planV = plan ? sampleGrid(plan.v, me.sMeters, plan.track.ds) : NaN;
        const tel = me.telemetry;
        const fr: Frame = {
          t, lap: c.clock.lapsDone, s: me.sMeters, v: me.vxMs, lat: me.lateralOffsetM, lineN, bias: c.biasM, biasTgt: c.biasTargetM,
          cap: me.aiSpeedCapMs ?? Infinity, planV, head: F.headingErr(me), steer: tel.steering, thr: tel.throttle, brk: tel.brake,
          latG: tel.lateralG, near, nearDs, nearDl, mode: c.control?.mode ?? '-', off: tel.offTrack,
        };
        const h = hist.get(c.code) ?? [];
        h.push(fr);
        while (h.length && t - h[0].t > 4) h.shift();
        hist.set(c.code, h);
        const touched = hitPlayer.has(c.code) && t - (lastHit.get(c.code) ?? -9) > 1;
        if (hitPlayer.has(c.code)) lastHit.set(c.code, t);
        for (const kind of [spun.has(c.code) ? 'spin' : null, offNow ? 'off' : null, wallNow ? 'wall' : null, touched ? 'contact' : null] as const) {
          if (!kind) continue;
          const pre = h.filter((x) => t - x.t <= 2);
          const traffic = pre.some((x) => Math.abs(x.nearDs) < 15 && Math.abs(x.nearDl) < 4);
          const maxBias = Math.max(0, ...pre.map((x) => Math.abs(x.bias)));
          let maxBiasStep = 0;
          for (let i = 1; i < pre.length; i++) maxBiasStep = Math.max(maxBiasStep, Math.abs(pre[i].bias - pre[i - 1].bias) / Math.max(1e-3, pre[i].t - pre[i - 1].t));
          const overPlan = Math.max(-Infinity, ...pre.map((x) => x.v - x.planV));
          events.push({ seed: k, kind, code: c.code, t, lap: fr.lap, s: me.sMeters, v: me.vxMs, traffic, maxBias, maxBiasStep, overPlan, frames: h.slice() });
        }
      }
    }
  });
  console.log(`seed ${k}: spins ${r.aiSpins}, offs ${r.aiOffs}, walls ${r.aiWalls}, AvA ${r.aiVsAi.events} (${r.aiVsAi.aiAtFault} at fault), vs stand-in AI-fault ${r.vsStandIn.aiAtFault}, AI lap ${f2(r.aiMeanLapS)}, finished ${r.finished}`);
}

const by = (key: (e: Event) => string) => {
  const m = new Map<string, number>();
  for (const e of events) m.set(key(e), (m.get(key(e)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join('  ');
};
console.log(`\n${events.filter((e) => e.kind === 'spin').length} spins, ${events.filter((e) => e.kind === 'off').length} offs, ${events.filter((e) => e.kind === 'wall').length} wall hits`);
console.log(`by kind/lap:     ${by((e) => `${e.kind}/L${e.lap + 1}`)}`);
console.log(`by traffic:      ${by((e) => `${e.kind}/${e.traffic ? 'traffic' : 'alone'}`)}`);
console.log(`by bias (2 s):   ${by((e) => `${e.kind}/${e.maxBias < 0.3 ? 'on line' : e.maxBias < 1.5 ? '<1.5 m' : e.maxBias < 3 ? '<3 m' : '3 m+'}`)}`);
console.log(`by place (100m): ${by((e) => `${e.kind}@${Math.floor(e.s / 100) * 100}`)}`);
console.log(`by over plan v:  ${by((e) => `${e.kind}/${!Number.isFinite(e.overPlan) ? 'no plan' : e.overPlan > 2 ? 'over 2+' : e.overPlan > 0 ? 'over <2' : 'under'}`)}`);
if (trace)
  for (const e of events) {
    console.log(`\n${e.kind.toUpperCase()} seed ${e.seed} ${e.code} t ${f1(e.t)} lap ${e.lap + 1} s ${f1(e.s)} v ${f1(e.v * 3.6)} km/h · traffic ${e.traffic} · max bias ${f2(e.maxBias)} m · max bias rate ${f2(e.maxBiasStep)} m/s`);
    console.log('   dt      s   v km/h planV   lat  lineN  bias  tgt   cap  head  steer thr  brk  latG near  ds    dl   mode');
    for (const x of e.frames.filter((_, i, a) => i % 3 === 0 || i === a.length - 1).slice(-14))
      console.log(
        `${f1(x.t - e.t).padStart(6)} ${f1(x.s).padStart(6)} ${f1(x.v * 3.6).padStart(6)} ${f1(x.planV * 3.6).padStart(5)} ${f2(x.lat).padStart(6)} ${f2(x.lineN).padStart(6)} ${f2(x.bias).padStart(5)} ${f2(x.biasTgt).padStart(5)} ${f1(Math.min(999, x.cap * 3.6)).padStart(5)} ${f2(x.head).padStart(5)} ${f2(x.steer).padStart(5)} ${f2(x.thr).padStart(4)} ${f2(x.brk).padStart(4)} ${f2(x.latG).padStart(5)} ${x.near.padStart(4)} ${f1(x.nearDs).padStart(5)} ${f1(x.nearDl).padStart(5)} ${x.mode}${x.off ? ' OFF' : ''}`
      );
  }
if (argv.includes('--json')) writeFileSync(opt('json', 'probe.json'), JSON.stringify(events.map(({ frames, ...e }) => ({ ...e, frames: frames.slice(-20) }))));
