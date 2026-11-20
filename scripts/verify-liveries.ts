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
  resolveLivery,
  sanitizeCustomLivery,
} from '../src/lib/track-data';
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
  /\b(ferrari|mercedes|mclaren|red\s*bull|aston\s*martin|alpine|williams|haas|sauber|audi|cadillac|racing\s*bulls|marlboro|john\s*player|camel|gulf|mild\s*seven|benetton|jordan|lotus|renault|f1|formula\s*1)\b/i;

console.log('F1 liveries & custom colour picker');

check('11 original 2026 grid mockup liveries with unique ids and valid hex colours', () => {
  const grid = LIVERIES.filter((l) => l.category === 'grid2026');
  assert.equal(grid.length, 11, `expected 11 grid2026 liveries, got ${grid.length}`);
  const ids = new Set(grid.map((l) => l.id));
  assert.equal(ids.size, 11, 'all grid2026 ids must be unique');
  for (const liv of grid) {
    assert.match(liv.primary, HEX_RE, `${liv.id} primary`);
    assert.match(liv.secondary, HEX_RE, `${liv.id} secondary`);
    assert.match(liv.accent, HEX_RE, `${liv.id} accent`);
    assert.ok(!liv.notInStoreBuild, `${liv.id} should be available in store builds too`);
    assert.ok(!TRADEMARK_RE.test(`${liv.id.replace(/_/g, ' ')} ${liv.name} ${liv.team}`), `${liv.id} must not use trademarked names: ${liv.name} / ${liv.team}`);
  }
});

check('6 original retro liveries with unique ids, valid hex colours and no trademarked names', () => {
  const retro = LIVERIES.filter((l) => l.category === 'retro');
  assert.equal(retro.length, 6, `expected 6 retro liveries, got ${retro.length}`);
  const ids = new Set(retro.map((l) => l.id));
  assert.equal(ids.size, 6, 'all retro ids must be unique');
  for (const liv of retro) {
    assert.match(liv.primary, HEX_RE, `${liv.id} primary`);
    assert.match(liv.secondary, HEX_RE, `${liv.id} secondary`);
    assert.match(liv.accent, HEX_RE, `${liv.id} accent`);
    assert.ok(!liv.notInStoreBuild, `${liv.id} should be available in store builds too`);
    assert.ok(!TRADEMARK_RE.test(`${liv.id.replace(/_/g, ' ')} ${liv.name} ${liv.team}`), `${liv.id} must not use trademarked names: ${liv.name} / ${liv.team}`);
  }
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
