/**
 * Verification checks for F1 2026 grid mockup liveries, 6 retro liveries, and custom colour picker persistence (#139).
 *
 *   npx tsx scripts/verify-liveries.ts
 */
import assert from 'node:assert/strict';
import {
  buildCustomLivery,
  CUSTOM_LIVERY_PALETTE,
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
const CURRENT_F1_NUMBERS = new Set(['1', '3', '4', '5', '6', '10', '11', '12', '14', '16', '18', '23', '27', '30', '31', '33', '41', '43', '44', '55', '63', '77', '81', '87']);

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbDist(a: string, b: string): number {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return Math.hypot(ar - br, ag - bg, ab - bb);
}

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

check('all 11 AI drivers map to 11 distinct colour-aligned 2026 grid liveries with zero collisions', () => {
  const roster = [...AI_DRIVERS, ...AI_RESERVE_DRIVERS];
  const assigned = roster.map((d) => liveryForDriverCode(d.code));
  const ids = new Set(assigned.map((l) => l.id));
  assert.equal(ids.size, roster.length, `expected ${roster.length} distinct AI liveries, got ${ids.size}: ${assigned.map((l) => l.id).join(', ')}`);
  assert.ok(assigned.every((l) => l.category === 'grid2026'), 'all AI liveries should come from grid2026');
  // Every AI driver's HUD timing colour should align with its assigned livery's primary or accent colour
  for (let i = 0; i < roster.length; i++) {
    const d = roster[i];
    const liv = assigned[i];
    const bestDist = Math.min(rgbDist(d.teamColorHex, liv.primary), rgbDist(d.teamColorHex, liv.accent));
    assert.ok(
      bestDist < 175,
      `${d.code} (${d.teamColorHex}) does not match ${liv.id} (primary=${liv.primary}, accent=${liv.accent}, dist=${bestDist.toFixed(1)})`,
    );
  }
  // Unknown human peer code still resolves deterministically to a grid2026 livery
  const peerA = liveryForDriverCode('XYZ');
  const peerB = liveryForDriverCode('XYZ');
  assert.equal(peerA.id, peerB.id);
  assert.equal(peerA.category, 'grid2026');
});

check('custom colour palette swatches are unique valid hex colours', () => {
  assert.ok(CUSTOM_LIVERY_PALETTE.length >= 8, 'expected at least 8 custom swatches');
  const hexes = new Set<string>();
  for (const s of CUSTOM_LIVERY_PALETTE) {
    assert.match(s.hex, HEX_RE, `palette swatch ${s.name}`);
    assert.ok(s.name.trim().length > 0, 'palette swatch name required');
    hexes.add(s.hex.toLowerCase());
  }
  assert.equal(hexes.size, CUSTOM_LIVERY_PALETTE.length, 'palette swatches must be unique');
});

check('every livery id across the whole list is unique and house liveries stay first', () => {
  const ids = new Set(LIVERIES.map((l) => l.id));
  assert.equal(ids.size, LIVERIES.length, 'duplicate livery id');
  assert.equal(LIVERIES[0].id, 'librecorsa');
  assert.equal(LIVERIES[1].id, 'aurora');
  assert.equal(LIVERIES[2].id, 'verdant');
  const gridAndRetro = LIVERIES.filter((l) => l.category === 'grid2026' || l.category === 'retro');
  const nums = new Set(gridAndRetro.map((l) => l.number));
  assert.equal(nums.size, gridAndRetro.length, 'duplicate racing number across 2026 grid / retro liveries');
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
