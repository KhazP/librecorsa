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

function relLuminance([r, g, b]: readonly [number, number, number]): number {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function compositeOver(
  fg: readonly [number, number, number],
  alpha: number,
  bg: readonly [number, number, number],
): [number, number, number] {
  return [
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  ];
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
  // Every AI driver's HUD timing colour should align tightly with its assigned livery's primary or accent colour
  // AND be strictly closer to its own livery than to any other AI car's livery
  for (let i = 0; i < roster.length; i++) {
    const d = roster[i];
    const liv = assigned[i];
    const ownPrimDist = rgbDist(d.teamColorHex, liv.primary);
    const ownAccDist = rgbDist(d.teamColorHex, liv.accent);
    const ownDist = Math.min(ownPrimDist, ownAccDist);
    assert.ok(
      ownDist < 100,
      `${d.code} (${d.teamColorHex}) does not match ${liv.id} (primary=${liv.primary}, accent=${liv.accent}, dist=${ownDist.toFixed(1)})`,
    );
    for (let j = 0; j < roster.length; j++) {
      if (i === j) continue;
      const other = assigned[j];
      const otherDist = Math.min(rgbDist(d.teamColorHex, other.primary), rgbDist(d.teamColorHex, other.accent));
      assert.ok(
        ownDist < otherDist,
        `${d.code} (${d.teamColorHex}) is closer to ${roster[j].code}'s ${other.id} (dist=${otherDist.toFixed(1)}) than to its own ${liv.id} (dist=${ownDist.toFixed(1)})`,
      );
      if (ownPrimDist <= ownAccDist) {
        const otherPrimDist = rgbDist(d.teamColorHex, other.primary);
        assert.ok(
          ownPrimDist < otherPrimDist,
          `${d.code} (${d.teamColorHex}) body colour is closer to ${roster[j].code}'s ${other.id} primary=${other.primary} (dist=${otherPrimDist.toFixed(1)}) than to its own ${liv.id} primary=${liv.primary} (dist=${ownPrimDist.toFixed(1)})`,
        );
      }
    }
  }
  // Unknown human peer code still resolves deterministically to a grid2026 livery
  const peerA = liveryForDriverCode('XYZ');
  const peerB = liveryForDriverCode('XYZ');
  assert.equal(peerA.id, peerB.id);
  assert.equal(peerA.category, 'grid2026');
});

check('all 11 AI drivers timing colours pass WCAG >= 3:1 on lc-void and HUD glass and stay visually distinct', () => {
  const roster = [...AI_DRIVERS, ...AI_RESERVE_DRIVERS];
  const voidBg = hexToRgb('#08090d'); // --color-lc-void
  const midTrack: [number, number, number] = [128, 128, 128];
  // HUD_GLASS / PHONE_GLASS use bg-lc-void/74; also verify against 72% alpha over mid-grey asphalt
  const hudGlassBg = compositeOver(voidBg, 0.74, midTrack);
  const hudGlass72Bg = compositeOver(voidBg, 0.72, midTrack);
  for (const d of roster) {
    assert.match(d.teamColorHex, HEX_RE, `${d.code} teamColorHex`);
    const rgb = hexToRgb(d.teamColorHex);
    const cVoid = contrastRatio(rgb, voidBg);
    const cGlass = contrastRatio(rgb, hudGlassBg);
    const cGlass72 = contrastRatio(rgb, hudGlass72Bg);
    assert.ok(cVoid >= 3.0, `${d.code} (${d.teamColorHex}) contrast on #08090d is ${cVoid.toFixed(2)}:1 (< 3.0:1)`);
    assert.ok(cGlass >= 3.0, `${d.code} (${d.teamColorHex}) contrast on HUD_GLASS (bg-lc-void/74 over mid-grey) is ${cGlass.toFixed(2)}:1 (< 3.0:1)`);
    assert.ok(cGlass72 >= 3.0, `${d.code} (${d.teamColorHex}) contrast on rgba(8,9,13,0.72) over mid-grey is ${cGlass72.toFixed(2)}:1 (< 3.0:1)`);
  }
  for (let i = 0; i < roster.length; i++) {
    for (let j = i + 1; j < roster.length; j++) {
      const dist = rgbDist(roster[i].teamColorHex, roster[j].teamColorHex);
      assert.ok(
        dist >= 60,
        `${roster[i].code} (${roster[i].teamColorHex}) and ${roster[j].code} (${roster[j].teamColorHex}) are too similar (RGB dist=${dist.toFixed(1)} < 60)`,
      );
    }
  }
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

check('every livery id across the whole list is unique and store-eligible house/grid/retro liveries stay neutral', () => {
  const ids = new Set(LIVERIES.map((l) => l.id));
  assert.equal(ids.size, LIVERIES.length, 'duplicate livery id');
  assert.equal(LIVERIES[0].id, 'librecorsa');
  assert.equal(LIVERIES[1].id, 'aurora');
  assert.equal(LIVERIES[2].id, 'verdant');
  // Every non-store-excluded livery (house originals, 2026 grid, retro) must have unique neutral numbers & clean names
  const storeEligible = LIVERIES.filter((l) => !l.notInStoreBuild);
  for (const liv of storeEligible) {
    assert.match(liv.primary, HEX_RE, `${liv.id} primary`);
    assert.match(liv.secondary, HEX_RE, `${liv.id} secondary`);
    assert.match(liv.accent, HEX_RE, `${liv.id} accent`);
    assert.ok(!CURRENT_F1_NUMBERS.has(liv.number), `${liv.id} should use a neutral non-current F1 driver number, got #${liv.number}`);
    assert.ok(!TRADEMARK_RE.test(`${liv.id.replace(/_/g, ' ')} ${liv.name} ${liv.team}`), `${liv.id} must not use trademarked names or HQ towns: ${liv.name} / ${liv.team}`);
  }
  const nums = new Set(storeEligible.map((l) => l.number));
  assert.equal(nums.size, storeEligible.length, 'duplicate racing number across store-eligible liveries');
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
