/**
 * Verification checks for F1 2026 grid mockup liveries, 6 retro liveries, and custom colour picker persistence (#139).
 *
 *   npx tsx scripts/verify-liveries.ts
 */
import assert from 'node:assert/strict';
import {
  buildCustomLivery,
  DEFAULT_CUSTOM_LIVERY,
  LIVERIES,
  liveryForDriverCode,
  resolveLivery,
  sanitizeCustomLivery,
} from '../src/lib/track-data';
import { AI_DRIVERS, AI_RESERVE_DRIVERS } from '../src/lib/sim/ai-opponents';
import { DEFAULT_PLAYER_SETTINGS, parsePlayerSettings } from '../src/lib/settings/player-settings';
import { resetAllSettings } from '../src/components/settings/storage';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const HEX_RE = /^#[0-9a-f]{6}$/i;
const TRADEMARK_RE =
  /\b(ferrari|mercedes|mclaren|red\s*bull|aston\s*martin|alpine|williams|haas|sauber|audi|cadillac|racing\s*bulls|marlboro|john\s*player|camel|gulf|mild\s*seven|benetton|jordan|lotus|renault|f1|formula\s*1|silver\s*arrows|scuderia|woking|maranello|brackley|milton(?:\s*keynes)?|silverstone|enstone|grove|faenza|kannapolis|ingolstadt|hinwil|detroit)\b/i;
const CURRENT_F1_NUMBERS = new Set(['1', '3', '4', '5', '6', '7', '10', '11', '12', '14', '16', '18', '22', '23', '27', '30', '31', '43', '44', '55', '63', '77', '81', '87']);

console.log('F1 liveries & custom colour picker');

check('11 original 2026 grid mockup liveries with unique ids, neutral numbers and valid hex colours', () => {
  const grid = LIVERIES.filter((l) => l.category === 'grid2026');
  assert.equal(grid.length, 11, `expected 11 grid2026 liveries, got ${grid.length}`);
  const ids = new Set(grid.map((l) => l.id));
  assert.equal(ids.size, 11, 'all grid2026 ids must be unique');
  for (const liv of grid) {
    assert.match(liv.primary, HEX_RE, `${liv.id} primary`);
    assert.match(liv.secondary, HEX_RE, `${liv.id} secondary`);
    assert.match(liv.accent, HEX_RE, `${liv.id} accent`);
    assert.ok(!liv.notInStoreBuild, `${liv.id} should be available in store builds too`);
    assert.ok(!CURRENT_F1_NUMBERS.has(liv.number), `${liv.id} should use a neutral non-current F1 driver number, got #${liv.number}`);
    assert.ok(!TRADEMARK_RE.test(`${liv.id.replace(/_/g, ' ')} ${liv.name} ${liv.team}`), `${liv.id} must not use trademarked names or HQ towns: ${liv.name} / ${liv.team}`);
  }
});

check('6 original retro liveries with unique ids, neutral numbers, valid hex colours and no trademarked names', () => {
  const retro = LIVERIES.filter((l) => l.category === 'retro');
  assert.equal(retro.length, 6, `expected 6 retro liveries, got ${retro.length}`);
  const ids = new Set(retro.map((l) => l.id));
  assert.equal(ids.size, 6, 'all retro ids must be unique');
  for (const liv of retro) {
    assert.match(liv.primary, HEX_RE, `${liv.id} primary`);
    assert.match(liv.secondary, HEX_RE, `${liv.id} secondary`);
    assert.match(liv.accent, HEX_RE, `${liv.id} accent`);
    assert.ok(!liv.notInStoreBuild, `${liv.id} should be available in store builds too`);
    assert.ok(!CURRENT_F1_NUMBERS.has(liv.number), `${liv.id} should use a neutral number, got #${liv.number}`);
    assert.ok(!TRADEMARK_RE.test(`${liv.id.replace(/_/g, ' ')} ${liv.name} ${liv.team}`), `${liv.id} must not use trademarked names or HQ towns: ${liv.name} / ${liv.team}`);
  }
});

check('all 11 AI drivers map to 11 distinct 2026 grid liveries with zero collisions', () => {
  const roster = [...AI_DRIVERS, ...AI_RESERVE_DRIVERS];
  const assigned = roster.map((d) => liveryForDriverCode(d.code));
  const ids = new Set(assigned.map((l) => l.id));
  assert.equal(ids.size, roster.length, `expected ${roster.length} distinct AI liveries, got ${ids.size}: ${assigned.map((l) => l.id).join(', ')}`);
  assert.ok(assigned.every((l) => l.category === 'grid2026'), 'all AI liveries should come from grid2026');
  // Unknown human peer code still resolves deterministically to a grid2026 livery
  const peerA = liveryForDriverCode('XYZ');
  const peerB = liveryForDriverCode('XYZ');
  assert.equal(peerA.id, peerB.id);
  assert.equal(peerA.category, 'grid2026');
});

check('every livery id across the whole list is unique and house liveries stay first', () => {
  const ids = new Set(LIVERIES.map((l) => l.id));
  assert.equal(ids.size, LIVERIES.length, 'duplicate livery id');
  assert.equal(LIVERIES[0].id, 'librecorsa');
  assert.equal(LIVERIES[1].id, 'aurora');
  assert.equal(LIVERIES[2].id, 'verdant');
});

check('custom colour picker builds, resolves, sanitizes and persists cleanly', () => {
  const custom = { primary: '#12AB34', secondary: '#0A0B0C', accent: '#FF8800' };
  const built = buildCustomLivery(custom);
  assert.equal(built.id, 'custom');
  assert.equal(built.primary, '#12ab34');
  assert.equal(built.secondary, '#0a0b0c');
  assert.equal(built.accent, '#ff8800');

  const resolved = resolveLivery('custom', custom);
  assert.deepEqual(
    { id: resolved.id, primary: resolved.primary, secondary: resolved.secondary, accent: resolved.accent },
    { id: 'custom', primary: '#12ab34', secondary: '#0a0b0c', accent: '#ff8800' },
  );
  assert.equal(resolveLivery('nonexistent_livery', custom).id, 'librecorsa');

  const sanitized = sanitizeCustomLivery({ primary: 'red', secondary: '#112233', accent: 42 });
  assert.equal(sanitized.primary, DEFAULT_CUSTOM_LIVERY.primary);
  assert.equal(sanitized.secondary, '#112233');
  assert.equal(sanitized.accent, DEFAULT_CUSTOM_LIVERY.accent);

  const saved = parsePlayerSettings({ liveryId: 'custom', customLivery: custom });
  assert.equal(saved.liveryId, 'custom');
  assert.deepEqual(saved.customLivery, { primary: '#12ab34', secondary: '#0a0b0c', accent: '#ff8800' });

  const afterReset = resetAllSettings({ ...DEFAULT_PLAYER_SETTINGS, liveryId: 'custom', customLivery: saved.customLivery });
  assert.equal(afterReset.liveryId, 'custom');
  assert.deepEqual(afterReset.customLivery, saved.customLivery);
});

console.log(`\n${passed} checks passed`);
