/**
 * Verification checks for F1 2026 grid mockup liveries, 6 retro liveries, and custom colour picker persistence (#139).
 *
 *   npx tsx scripts/verify-liveries.ts
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  buildCustomLivery,
  CUSTOM_LIVERY_PALETTE,
  DEFAULT_CUSTOM_LIVERY,
  LIVERIES,
  liveryForDriverCode,
  resolveLivery,
  sanitizeCustomLivery,
} from '../src/lib/track-data';
import {
  F1_ATLAS_SIZE,
  LIVERY_FINISH_PROFILES,
  installF1LiveryPaint,
  liverySwatchBackground,
  renderF1LiveryToContext,
  resolveLiveryVisual,
} from '../src/lib/render/livery-repaint';
import {
  GT3_ATLAS_SIZE,
  GT3_BODY_PROFILES,
  GT3_LIVERIES,
  gt3LiveryById,
  installGt3LiveryPaint,
  renderGt3LiveryToContext,
} from '../src/lib/render/gt3-livery-painter';
import {
  LMDH_ATLAS_SIZE,
  LMDH_LIVERIES,
  lmdhLiveryById,
  renderLmdhLiveryToContext,
} from '../src/lib/render/lmdh-livery-painter';
import {
  LIANA_ATLAS_SIZE,
  LIANA_LIVERIES,
  lianaLiveryById,
  renderLianaLiveryToContext,
} from '../src/lib/render/liana-livery-painter';
import {
  installPortedProceduralLivery,
  PROCEDURAL_BODY_PROFILES,
} from '../src/lib/render/ported-procedural-livery';
import { AMG_GT3_SKINS, BMW_M4_GT3_SKINS } from '../src/lib/cars/gt3-skins';
import { LC_LMDH_SKINS } from '../src/lib/cars/lmdh-skins';
import { LIANA_SKINS } from '../src/lib/cars/liana-skins';
import { carSkinSwatchBackground, portedSkinFor } from '../src/lib/cars/car-registry';
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
  /\b(ferrari|mercedes|mclaren|red\s*bull|aston\s*martin|alpine|williams|haas|sauber|audi|cadillac|racing\s*bulls|brawn|marlboro|john\s*player|camel|gulf|mild\s*seven|benetton|jordan|lotus|renault|honda|canon|telefonica|benson|hedges|petronas|aramco|shell|pirelli|oracle|crowdstrike|santander|vodafone|bwt|eni|msc|fia|hp|visit\s*rwanda|rwandair|f1|formula\s*1|silver\s*arrows|scuderia|woking|maranello|brackley|milton(?:\s*keynes)?|silverstone|enstone|grove|faenza|kannapolis|ingolstadt|hinwil|detroit)\b/i;
const CURRENT_F1_NUMBERS = new Set(['1', '3', '4', '5', '6', '10', '11', '12', '14', '16', '18', '23', '27', '30', '31', '33', '41', '43', '44', '55', '63', '77', '81', '87']);

function createMockCanvas2D(): {
  ctx: CanvasRenderingContext2D;
  drawOps: number;
  texts: string[];
} {
  const state = { drawOps: 0, texts: [] as string[] };
  const noop = () => {};
  const grad = { addColorStop: noop };
  const mock = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    arc: noop,
    rect: noop,
    clip: noop,
    createLinearGradient: () => grad,
    createPattern: () => ({}),
    measureText: (t: string) => ({ width: t.length * 14 }),
    fillRect: () => {
      state.drawOps++;
    },
    strokeRect: () => {
      state.drawOps++;
    },
    clearRect: noop,
    fill: () => {
      state.drawOps++;
    },
    stroke: () => {
      state.drawOps++;
    },
    fillText: (t: string) => {
      state.drawOps++;
      state.texts.push(String(t));
    },
    strokeText: (t: string) => {
      state.drawOps++;
      state.texts.push(String(t));
    },
  };
  return { ctx: mock as unknown as CanvasRenderingContext2D, get drawOps() { return state.drawOps; }, texts: state.texts };
}

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

check('every livery id across the whole list is unique, original and trademark-free', () => {
  const ids = new Set(LIVERIES.map((l) => l.id));
  assert.equal(ids.size, LIVERIES.length, 'duplicate livery id');
  assert.equal(LIVERIES.length, 20, `expected 20 original liveries (3 house + 11 grid2026 + 6 retro), got ${LIVERIES.length}`);
  assert.equal(LIVERIES[0].id, 'librecorsa');
  assert.equal(LIVERIES[1].id, 'aurora');
  assert.equal(LIVERIES[2].id, 'verdant');
  assert.ok(!LIVERIES.some((l) => (l.id as string) === 'oracle_red_bull'), 'oracle_red_bull must be removed');
  for (const liv of LIVERIES) {
    assert.match(liv.primary, HEX_RE, `${liv.id} primary`);
    assert.match(liv.secondary, HEX_RE, `${liv.id} secondary`);
    assert.match(liv.accent, HEX_RE, `${liv.id} accent`);
    assert.ok(!CURRENT_F1_NUMBERS.has(liv.number), `${liv.id} should use a neutral non-current F1 driver number, got #${liv.number}`);
    assert.ok(!TRADEMARK_RE.test(`${liv.id.replace(/_/g, ' ')} ${liv.name} ${liv.team}`), `${liv.id} must not use trademarked names or HQ towns: ${liv.name} / ${liv.team}`);
  }
  const nums = new Set(LIVERIES.map((l) => l.number));
  assert.equal(nums.size, LIVERIES.length, 'duplicate racing number across liveries');
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

  // Legacy IDs alias cleanly so previously saved player settings keep working
  assert.equal(resolveLivery('oracle_red_bull', custom).id, 'grid26_cobalt');
  assert.equal(resolveLivery('retro_tri_92', custom).id, 'retro_tri_93');
  assert.equal(resolveLivery('retro_emerald_91', custom).id, 'retro_fluoro_09');
  assert.equal(resolveLivery('retro_powder_69', custom).id, 'retro_hornet_99');
});

check('all 11 grid2026, 6 retro, 3 house and custom liveries have complete trademark-free visual specs & sponsors', () => {
  const targets = [
    ...LIVERIES,
    buildCustomLivery(DEFAULT_CUSTOM_LIVERY),
  ];
  const expectedRetroIds = new Set([
    'retro_red_white',
    'retro_black_gold',
    'retro_tri_93',
    'retro_sky_05',
    'retro_fluoro_09',
    'retro_hornet_99',
  ]);
  const actualRetroIds = new Set(LIVERIES.filter((l) => l.category === 'retro').map((l) => l.id));
  assert.deepEqual(actualRetroIds, expectedRetroIds, 'retro collection must include all 6 iconic historical liveries');

  for (const liv of targets) {
    assert.ok(liv.visual, `${liv.id} must define a visual spec`);
    const v = liv.visual!;
    assert.ok(v.finish in LIVERY_FINISH_PROFILES, `${liv.id} finish must be valid: ${v.finish}`);
    assert.match(v.bodyBase, HEX_RE, `${liv.id} bodyBase`);
    assert.match(v.bodySecondary, HEX_RE, `${liv.id} bodySecondary`);
    assert.match(v.stripePrimary, HEX_RE, `${liv.id} stripePrimary`);
    if (v.stripeSecondary) assert.match(v.stripeSecondary, HEX_RE, `${liv.id} stripeSecondary`);
    assert.ok(v.carbonExposure >= 0 && v.carbonExposure <= 1, `${liv.id} carbonExposure out of range`);

    const sponsorValues = [v.sponsors.title, v.sponsors.wing, v.sponsors.nose, v.sponsors.halo, v.sponsors.tech];
    for (const s of sponsorValues) {
      assert.ok(s.trim().length >= 2, `${liv.id} sponsor must be non-empty`);
      assert.ok(!TRADEMARK_RE.test(s), `${liv.id} sponsor must not contain real trademarks: "${s}"`);
    }
    const swatch = liverySwatchBackground(liv);
    assert.ok(swatch.includes('linear-gradient'), `${liv.id} swatch should produce a rich multi-colour gradient`);
  }
});

check('procedural 2048px livery canvas painter and tri-orthographic material installer run cleanly across all liveries', () => {
  const targets = [
    ...LIVERIES,
    buildCustomLivery({ primary: '#12ab34', secondary: '#0a0b0c', accent: '#ff8800' }),
  ];

  // Install shader controller onto sample LC26 zone + flap materials and verify switching never throws
  const bodyMat = new THREE.MeshPhysicalMaterial({ color: '#ffffff' });
  const flapMat = new THREE.MeshPhysicalMaterial({ color: '#ffffff' });
  const flapFrame = new THREE.Matrix4().makeTranslation(0, 0.811, -2.305);
  const controller = installF1LiveryPaint([
    { material: bodyMat },
    { material: flapMat, frameMatrix: flapFrame },
  ]);
  assert.ok(bodyMat.customProgramCacheKey().includes('f1-procedural-livery'));
  assert.ok(flapMat.customProgramCacheKey().includes('f1-procedural-livery'));

  for (const liv of targets) {
    const mock = createMockCanvas2D();
    renderF1LiveryToContext(mock.ctx, liv, F1_ATLAS_SIZE);
    assert.ok(mock.drawOps >= 40, `${liv.id} rendered too few draw operations (${mock.drawOps})`);
    const spec = resolveLiveryVisual(liv);
    assert.ok(mock.texts.includes(spec.sponsors.title), `${liv.id} did not draw title sponsor ${spec.sponsors.title}`);
    assert.ok(mock.texts.includes(spec.sponsors.wing), `${liv.id} did not draw wing sponsor ${spec.sponsors.wing}`);
    assert.ok(mock.texts.includes(liv.number), `${liv.id} did not draw racing number #${liv.number}`);
    // Calling controller.set in headless Node returns false gracefully without throwing
    assert.equal(controller.set(liv), false);
  }
  assert.equal(controller.set(null), false);
  bodyMat.dispose();
  flapMat.dispose();
});

check('AMG GT3 Evo and BMW M4 GT3 Evo have Verstappen Racing defaults, 8 skins each, synced swatches & valid resolution', () => {
  assert.equal(AMG_GT3_SKINS.length, 8, 'AMG GT3 Evo should have 8 liveries');
  assert.equal(BMW_M4_GT3_SKINS.length, 8, 'BMW M4 GT3 Evo should have 8 liveries');
  assert.equal(AMG_GT3_SKINS[0].id, 'verstappen_3', 'AMG GT3 Evo default skin must be #3 Verstappen Racing');
  assert.equal(BMW_M4_GT3_SKINS[0].id, 'bmw_verstappen_33', 'BMW M4 GT3 Evo default skin must be #33 Verstappen Racing');

  // AMG default keeps the GLB baked Verstappen texture; procedural AMG skins resolve to procedural PortedSkin
  assert.equal(portedSkinFor('amg-gt3', AMG_GT3_SKINS[0]), null);
  assert.equal(portedSkinFor('amg-gt3', AMG_GT3_SKINS[1])?.procedural, 'amg_mamba_48');

  // BMW default is procedural #33 Verstappen Racing; BMW factory stealth restores GLB paint (null)
  assert.equal(portedSkinFor('bmw-m4-gt3', BMW_M4_GT3_SKINS[0])?.procedural, 'bmw_verstappen_33');
  const stealth = BMW_M4_GT3_SKINS.find((s) => s.id === 'bmw_stealth_25');
  assert.ok(stealth, 'BMW M4 GT3 Evo should keep Factory Carbon Stealth option');
  assert.equal(portedSkinFor('bmw-m4-gt3', stealth), null);

  // Every procedural skin in gt3-skins.ts matches its painter spec 1:1 and produces a 3-colour CSS gradient swatch
  const allGt3Skins = [...AMG_GT3_SKINS, ...BMW_M4_GT3_SKINS];
  const seenIds = new Set<string>();
  for (const skin of allGt3Skins) {
    assert.ok(!seenIds.has(skin.id), `duplicate GT3 skin id: ${skin.id}`);
    seenIds.add(skin.id);
    assert.equal(skin.swatch.length, 3, `${skin.id} must have 3-colour swatch`);
    for (const c of skin.swatch) assert.match(c, HEX_RE, `${skin.id} invalid swatch hex ${c}`);
    const bg = carSkinSwatchBackground(skin);
    assert.ok(bg.includes('linear-gradient') && bg.includes(skin.swatch[2]!), `${skin.id} 3-colour swatch css`);
    if (skin.procedural) {
      const spec = gt3LiveryById(skin.procedural);
      assert.ok(spec, `missing GT3 painter spec for ${skin.procedural}`);
      assert.equal(spec.name, skin.name, `name mismatch for ${skin.id}`);
      assert.deepEqual(spec.swatch, skin.swatch, `swatch mismatch for ${skin.id}`);
    }
  }
});

check('all 14 procedural GT3 liveries render cleanly on 2048px canvas with valid PBR finishes and zero corporate trademarks', () => {
  assert.equal(GT3_LIVERIES.length, 14, 'expected 7 BMW + 7 AMG procedural GT3 liveries');
  const corpSponsorRe = /\b(red\s*bull|petronas|oracle|shell|pirelli|michelin|crowdstrike|viaplay|dekra|mann-?filter|mobil\s*1|schaeffler|totalenergies)\b/i;

  for (const car of ['amg-gt3', 'bmw-m4-gt3'] as const) {
    const mat = new THREE.MeshPhysicalMaterial({ color: '#111111', roughness: 0.5, metalness: 0.4 });
    const controller = installGt3LiveryPaint([{ material: mat }], GT3_BODY_PROFILES[car]);
    assert.ok(mat.customProgramCacheKey().includes('gt3-procedural-livery'));

    for (const spec of GT3_LIVERIES.filter((s) => s.car === car)) {
      assert.ok(spec.finish in LIVERY_FINISH_PROFILES, `${spec.id} invalid finish ${spec.finish}`);
      const mock = createMockCanvas2D();
      renderGt3LiveryToContext(mock.ctx, spec, GT3_ATLAS_SIZE);
      assert.ok(mock.drawOps >= 40, `${spec.id} rendered too few draw operations (${mock.drawOps})`);
      assert.ok(mock.texts.includes(spec.number), `${spec.id} did not draw racing number #${spec.number}`);
      assert.ok(mock.texts.includes(spec.sponsors.door), `${spec.id} did not draw door sponsor ${spec.sponsors.door}`);
      assert.ok(mock.texts.includes(spec.wingText), `${spec.id} did not draw wing banner ${spec.wingText}`);
      for (const drawn of mock.texts) {
        assert.ok(!corpSponsorRe.test(drawn), `${spec.id} drew unlicensed corporate trademark: "${drawn}"`);
      }
      // Headless Node gracefully returns false without throwing and preserves material state
      assert.equal(controller.set(spec.id), false);
    }
    assert.equal(controller.set(null), false);
    controller.dispose();
  }
});

check('LC-LMDH has 8 Hypercar liveries and Suzuki Liana has Factory + Middle Gear Special comedy livery', () => {
  assert.equal(LC_LMDH_SKINS.length, 8, 'LC-LMDH should have 8 liveries');
  assert.equal(LC_LMDH_SKINS[0].id, 'lmdh_factory_01');
  assert.equal(portedSkinFor('lc-lmdh', LC_LMDH_SKINS[0]), null, 'LC-LMDH factory default keeps GLB paint');
  assert.equal(portedSkinFor('lc-lmdh', LC_LMDH_SKINS[1])?.procedural, 'lmdh_rossa_51');

  assert.equal(LMDH_LIVERIES.length, 7, 'expected 7 procedural LC-LMDH Hypercar liveries');
  const lmdhMat = new THREE.MeshPhysicalMaterial({ color: '#ffffff' });
  const lmdhCtrl = installPortedProceduralLivery([{ material: lmdhMat }], PROCEDURAL_BODY_PROFILES['lc-lmdh']);
  assert.ok(lmdhMat.customProgramCacheKey().includes('ported-procedural-livery'));
  for (const skin of LC_LMDH_SKINS.slice(1)) {
    const spec = lmdhLiveryById(skin.procedural!);
    assert.ok(spec, `missing LMDH spec ${skin.procedural}`);
    assert.equal(spec.name, skin.name);
    assert.deepEqual(spec.swatch, skin.swatch);
    const mock = createMockCanvas2D();
    renderLmdhLiveryToContext(mock.ctx, spec, LMDH_ATLAS_SIZE);
    assert.ok(mock.drawOps >= 35, `${spec.id} rendered too few ops (${mock.drawOps})`);
    assert.ok(mock.texts.includes(spec.number), `${spec.id} missing number`);
    assert.ok(mock.texts.includes(spec.wingText), `${spec.id} missing wing banner`);
    assert.equal(lmdhCtrl.set(spec.id), false);
  }
  lmdhCtrl.dispose();

  // Suzuki Liana: Factory default + Middle Gear comedy livery
  assert.equal(LIANA_SKINS.length, 2, 'Suzuki Liana should have Factory + Middle Gear Special');
  assert.equal(LIANA_SKINS[0].id, 'liana_factory_silver');
  assert.equal(portedSkinFor('liana', LIANA_SKINS[0]), null);
  assert.equal(portedSkinFor('liana', LIANA_SKINS[1])?.procedural, 'liana_middle_gear');
  const lianaSpec = lianaLiveryById('liana_middle_gear');
  assert.ok(lianaSpec && LIANA_LIVERIES.length === 1);
  const mockLiana = createMockCanvas2D();
  renderLianaLiveryToContext(mockLiana.ctx, lianaSpec, LIANA_ATLAS_SIZE);
  assert.ok(mockLiana.drawOps >= 80, `Middle Gear livery drew too few ops (${mockLiana.drawOps})`);
  assert.ok(mockLiana.texts.includes('MIDDLE GEAR'), 'Middle Gear livery must draw MIDDLE GEAR');
  assert.ok(mockLiana.texts.includes('POWERRR!!'), 'Middle Gear livery must draw POWERRR!!');
  assert.ok(mockLiana.texts.includes('MY OTHER CAR IS A SANDERO'), 'Middle Gear livery must draw Sandero gag');
  assert.ok(mockLiana.texts.includes('0-60: EVENTUALLY'), 'Middle Gear livery must draw 0-60 gag');

  const lianaMat = new THREE.MeshPhysicalMaterial({ color: '#ffffff' });
  const lianaCtrl = installPortedProceduralLivery([{ material: lianaMat }], PROCEDURAL_BODY_PROFILES.liana);
  assert.equal(lianaCtrl.set('liana_middle_gear'), false);
  lianaCtrl.dispose();
});

console.log(`\n${passed} checks passed`);
