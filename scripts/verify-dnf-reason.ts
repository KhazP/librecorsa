/**
 * Headless checks for DNF / disqualification cause propagation and labels:
 *   - CarDamage records whether terminal damage came from a barrier impact, a car collision, or suspension failure,
 *     and preserves/restores that cause across Flashback snapshots.
 *   - race-session `classify()` preserves explicit `dnfReason`, infers `track_limits` for disqualifications, and
 *     infers `time_limit` when classification closes with a car still on track.
 *   - `MultiplayerRaceSession` tags a peer that drops mid-race as `disconnected` and keeps that cause once final.
 *   - `dnfReasonLabel()` resolves every `DnfReason` to a non-empty localized label.
 *
 *   npx tsx scripts/verify-dnf-reason.ts
 */
import { CarDamage } from '../src/lib/sim/car-damage';
import { classify, MultiplayerRace } from '../src/lib/sim/race-session';
import { dnfReasonLabel } from '../src/components/hud/hud-format';
import type { DnfReason } from '../src/types/f1';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};

// ---- CarDamage terminal causes

{
  const wallCar = new CarDamage('full');
  wallCar.registerImpact({ localX: 0, localZ: 2.4, speedMs: 28, source: 'wall' });
  check('terminal wall hit records wall_impact', wallCar.terminal && wallCar.terminalReason === 'wall_impact', String(wallCar.terminalReason));

  const snap = wallCar.snapshot();
  wallCar.reset();
  check('reset clears terminalReason', !wallCar.terminal && wallCar.terminalReason === null);
  wallCar.restore(snap);
  check('snapshot/restore preserves terminalReason', wallCar.terminal && wallCar.terminalReason === 'wall_impact', String(wallCar.terminalReason));

  const crashCar = new CarDamage('full');
  crashCar.registerImpact({ localX: 0, localZ: 2.4, speedMs: 28, source: 'car' });
  check('terminal car contact records collision', crashCar.terminal && crashCar.terminalReason === 'collision', String(crashCar.terminalReason));

  const suspCar = new CarDamage('full', 2.5, 0.975, () => 0.99);
  // Two sub-terminal corner impacts bend suspension past 100 % without reaching terminal impact speed
  suspCar.registerImpact({ localX: 0.9, localZ: 2.0, speedMs: 16, source: 'car' });
  suspCar.registerImpact({ localX: 0.9, localZ: 2.0, speedMs: 16, source: 'car' });
  check('wheel/suspension collapse below terminal speed records suspension', suspCar.terminal && suspCar.terminalReason === 'suspension', String(suspCar.terminalReason));
}

// ---- classify() propagation & inference

{
  const rows = classify(
    [
      { id: 'w', code: 'WIN', name: 'Winner', color: '#fff', isPlayer: false, distM: 15000, speedMs: 60, finishTimeS: 240, bestLapMs: 80000 },
      { id: 't', code: 'TIM', name: 'Still Out', color: '#fff', isPlayer: false, distM: 12000, speedMs: 40, finishTimeS: null, bestLapMs: 82000 },
      { id: 'c', code: 'COL', name: 'Crashed', color: '#fff', isPlayer: true, distM: 9000, speedMs: 0, finishTimeS: null, bestLapMs: 81000, dnf: true, dnfReason: 'collision' },
      { id: 'q', code: 'DSQ', name: 'Cut', color: '#fff', isPlayer: false, distM: 10000, speedMs: 0, finishTimeS: null, bestLapMs: null, dnf: true, dq: true },
    ],
    5000,
    3,
    true,
  );
  const byCode = new Map(rows.map((r) => [r.driverCode, r]));
  check('finisher has no dnfReason', !byCode.get('WIN')?.dnf && byCode.get('WIN')?.dnfReason === undefined);
  check('runner left out at close gets time_limit', byCode.get('TIM')?.dnf === true && byCode.get('TIM')?.dnfReason === 'time_limit', String(byCode.get('TIM')?.dnfReason));
  check('explicit collision reason is preserved', byCode.get('COL')?.dnf === true && byCode.get('COL')?.dnfReason === 'collision', String(byCode.get('COL')?.dnfReason));
  check('disqualified car defaults to track_limits', byCode.get('DSQ')?.dq === true && byCode.get('DSQ')?.dnfReason === 'track_limits', String(byCode.get('DSQ')?.dnfReason));
}

// ---- MultiplayerRace disconnected peer

{
  const mp = new MultiplayerRace(
    {
      id: 'race-1',
      trackId: 'monza',
      laps: 1,
      grid: ['me', 'peer1'],
      lightsStartHostMs: 0,
      holdMs: 1000,
      collisions: 'on',
      carClass: 'any',
    },
    5000,
    'me',
    { code: 'ME', name: 'Player', color: '#CCFF00' },
    [
      { peerId: 'me', code: 'ME', name: 'Player', color: '#CCFF00' },
      { peerId: 'peer1', code: 'P1', name: 'Peer One', color: '#FF0000' },
    ],
  );
  mp.setPresent(['me', 'peer1']);
  mp.ingestPeers(
    [
      {
        peerId: 'peer1',
        driverCode: 'P1',
        name: 'Peer One',
        teamColorHex: '#FF0000',
        speedKmh: 200,
        race: { id: 'race-1', dist: 1200, fin: null, best: null, last: null },
      } as never,
    ],
    15,
  );
  // Peer disconnects before finishing; player crosses the line
  mp.setPresent(['me']);
  mp.lapClock.distM = 5050;
  mp.lapClock.finishTimeS = 85;
  mp.lapClock.finishLaps = 1;
  const st = mp.status({ phase: 'racing', lightsOn: 0, countdownS: 0, raceTimeS: 86 }, 60);
  const p1 = st.results?.find((r) => r.driverCode === 'P1');
  check('dropped multiplayer peer is classified DNF with disconnected reason', p1?.dnf === true && p1?.dnfReason === 'disconnected', String(p1?.dnfReason));
}

// ---- Localized labels

const ALL_REASONS: readonly DnfReason[] = [
  'track_limits',
  'collision',
  'wall_impact',
  'suspension',
  'damage',
  'disconnected',
  'time_limit',
];
for (const reason of ALL_REASONS) {
  const label = dnfReasonLabel(reason);
  check(`dnfReasonLabel("${reason}") resolves cleanly`, typeof label === 'string' && label.length > 0 && !label.includes('hud.raceResults'), String(label));
}
check('dnfReasonLabel(undefined, true) falls back to track limits label', dnfReasonLabel(undefined, true) === dnfReasonLabel('track_limits'));
check('dnfReasonLabel(undefined, false) returns null', dnfReasonLabel(undefined, false) === null);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll DNF reason checks passed.');
