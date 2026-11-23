/**
 * Headless checks of the HUD layout list (src/lib/settings/hud-layouts.ts): a saved layout survives a reload, an old or
 * unknown one falls back to Broadcast, the renamed "engineer" still lands on Telemetry, and every third-party layout
 * carries a credit (author, source repository, licence) with player-facing text free of other games' names. Moved
 * and resized panels (hud-parts.ts) are kept per layout, clamped, and dropped where malformed or unmoved.
 *
 *   npx tsx scripts/verify-hud-layouts.ts
 */
import {
  BUILT_IN_HUD_LAYOUTS,
  DEFAULT_HUD_PRESET,
  HUD_LAYOUTS,
  HUD_PRESETS,
  THIRD_PARTY_HUD_LAYOUTS,
  HUD_LICENSE_URL,
  hudLayout,
  parseHudPreset,
  showsPhoneHud,
} from '../src/lib/settings/hud-layouts';
import { DEFAULT_PLAYER_SETTINGS, parsePlayerSettings } from '../src/lib/settings/player-settings';
import { HUD_PART_IDS, hudPartOfOrigin, hudPartsKey, layoutMoved, parseHudParts, withLayoutParts } from '../src/lib/settings/hud-parts';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};

// ---- Parsing a saved layout

for (const id of HUD_PRESETS) {
  check(`a saved "${id}" is kept`, parseHudPreset(id) === id);
  check(`a saved "${id}" survives the whole settings parse`, parsePlayerSettings({ hud: { preset: id } }).hud.preset === id);
}
check('the renamed "engineer" layout opens as Telemetry', parseHudPreset('engineer') === 'telemetry');
for (const bad of ['full', 'rennsport', 'Broadcast', 'irdashies ', '', 42, null, undefined, {}, ['dash']]) {
  check(`unknown ${JSON.stringify(bad) ?? 'undefined'} falls back to Broadcast`, parseHudPreset(bad) === 'broadcast');
}
check('a save without a HUD gets Broadcast', parsePlayerSettings({}).hud.preset === 'broadcast');
check('a save with a newer build\'s layout gets Broadcast', parsePlayerSettings({ hud: { preset: 'some-future-layout', scale: 1.2 } }).hud.preset === 'broadcast');
check('...and keeps its other HUD settings', parsePlayerSettings({ hud: { preset: 'some-future-layout', scale: 1.2 } }).hud.scale === 1.2);
check('a new player starts on Broadcast', DEFAULT_PLAYER_SETTINGS.hud.preset === 'broadcast' && DEFAULT_HUD_PRESET === 'broadcast');
check('an unknown id looks up as the default layout', hudLayout('nope').id === 'broadcast');

// ---- The list itself

const ids = HUD_LAYOUTS.map((l) => l.id);
check('layout ids are unique', new Set(ids).size === ids.length, ids.join(', '));
check('ids are lower-case words a save can keep', ids.every((id) => /^[a-z][a-z0-9-]*$/.test(id)));
check('the built-in layouts come first, Broadcast leading', HUD_LAYOUTS[0].id === 'broadcast' && HUD_LAYOUTS.slice(0, BUILT_IN_HUD_LAYOUTS.length).every((l) => !l.credit));
check('the game\'s own layouts carry no credit', BUILT_IN_HUD_LAYOUTS.every((l) => !('credit' in l)));

// Other games' and their makers' names never appear in what the player reads, nor in the saved ids
const BANNED = /i\s*racing|assetto|rennsport|kunos|simhub|le\s*mans\s*ultimate/i;
for (const l of HUD_LAYOUTS) {
  check(`"${l.id}": name and line are free of other games' names`, !BANNED.test(`${l.id} ${l.label} ${l.detail} ${l.credit?.author ?? ''}`));
  check(`"${l.id}": no em dash in its text`, !/[—]/.test(`${l.label} ${l.detail}`));
  check(`"${l.id}": name and line are short`, l.label.length <= 22 && l.detail.length <= 52, `${l.label.length} / ${l.detail.length}`);
}
/** Third-party layouts contributed to this repository rather than ported from one of their own */
const CONTRIBUTED_HERE = new Set(['grand-prix']);
for (const l of THIRD_PARTY_HUD_LAYOUTS as readonly (typeof HUD_LAYOUTS)[number][]) {
  const c = l.credit;
  check(`"${l.id}": credits its author`, Boolean(c?.author && c.author.trim() === c.author && c.author.length > 1));
  // A layout contributed straight to this repository (Grand Prix, #162) has no repository of its own: its author's profile
  const source = CONTRIBUTED_HERE.has(l.id) ? /^https:\/\/github\.com\/[^/]+$/ : /^https:\/\/github\.com\/[^/]+\/[^/]+$/;
  check(`"${l.id}": links its source repository`, Boolean(c && source.test(c.repoUrl)), c?.repoUrl);
  check(`"${l.id}": the author is the repository's owner`, Boolean(c && c.repoUrl.split('/')[3]?.toLowerCase() === c.author.toLowerCase()));
  check(`"${l.id}": names a licence the game can take in`, c?.license === 'MIT' || c?.license === 'GPL-3.0');
  check(`"${l.id}": its licence has a page to link`, Boolean(c && /^https:\/\//.test(HUD_LICENSE_URL[c.license])));
  if (c?.site) {
    check(`"${l.id}": the author's site has a short name free of other games' names`, c.site.name.trim() === c.site.name && c.site.name.length > 1 && c.site.name.length <= 20 && !BANNED.test(c.site.name), c.site.name);
    check(`"${l.id}": the author's site links over https`, /^https:\/\/[^/\s]+/.test(c.site.url), c.site.url);
  }
}
check('Grand Prix credits adamikoo\'s site, AvgSpots', THIRD_PARTY_HUD_LAYOUTS.some((l) => l.id === 'grand-prix' && 'site' in l.credit && l.credit.site.url === 'https://avgspots.com'));

// ---- Which screens show the chosen layout

const desktop = { phone: false, touchControls: false };
const tablet = { phone: false, touchControls: true };
const phoneScreen = { phone: true, touchControls: true };
const phoneWithPad = { phone: true, touchControls: false };
for (const l of HUD_LAYOUTS) {
  check(`"${l.id}": drawn as chosen on a desktop`, !showsPhoneHud(l.id, desktop));
  check(`"${l.id}": a phone-sized screen gets the Phone HUD`, showsPhoneHud(l.id, phoneScreen) && showsPhoneHud(l.id, phoneWithPad));
  check(
    `"${l.id}": on a tablet with touch, ${l.credit ? 'keeps its look' : 'gives way to the Phone HUD'}`,
    showsPhoneHud(l.id, tablet) === !l.credit,
  );
}

console.log(`\n${HUD_LAYOUTS.length} layouts (${THIRD_PARTY_HUD_LAYOUTS.length} third-party)`);
// ---- Moved and resized panels, per layout

{
  const parts = parseHudParts({
    classic: { 'top-left': { x: 12.5, y: -3, scale: 1.2 }, 'bottom-right': { x: 0, y: 0, scale: 1 }, nonsense: { x: 1, y: 1, scale: 1 } },
    broadcast: { 'top-right': { x: 500, y: -500, scale: 9 } },
    notALayout: { 'top-left': { x: 1, y: 1, scale: 1 } },
    telemetry: { 'top-left': 'junk' },
  });
  check('a moved panel is kept for its layout', parts.classic?.['top-left']?.x === 12.5 && parts.classic?.['top-left']?.scale === 1.2);
  check('an unmoved panel and an unknown part are dropped', parts.classic?.['bottom-right'] === undefined && Object.keys(parts.classic ?? {}).length === 1);
  check('offsets and sizes are clamped', parts.broadcast?.['top-right']?.x === 100 && parts.broadcast?.['top-right']?.y === -100 && parts.broadcast?.['top-right']?.scale === 2);
  check('an unknown layout and a malformed part are dropped', !('notALayout' in parts) && !('telemetry' in parts));
  check('a layout is moved only with a part off its spot', layoutMoved(parts, 'classic') && !layoutMoved(parts, 'minimal'));
  const reset = withLayoutParts(parts, 'classic', {});
  check('resetting one layout leaves the others', !('classic' in reset) && reset.broadcast !== undefined);
  check('every anchor origin names a part', ['top left', 'top center', 'top right', 'center right', 'center', 'bottom left', 'bottom center', 'bottom right'].every((o) => hudPartOfOrigin(o) !== null) && HUD_PART_IDS.length === 8);
  const saved = parsePlayerSettings(JSON.parse(JSON.stringify({ ...DEFAULT_PLAYER_SETTINGS, hud: { ...DEFAULT_PLAYER_SETTINGS.hud, parts: { classic: { center: { x: -4, y: 2, scale: 0.8 } } } } })));
  check('moved panels survive a save and reload', saved.hud.parts.classic?.center?.scale === 0.8);
  check('a save without them has none', Object.keys(parsePlayerSettings({}).hud.parts).length === 0);
  const phone = parseHudParts({ phone: { 'top-left': { x: 3, y: 0, scale: 1 } } });
  check('the Phone HUD keeps its own parts', phone.phone?.['top-left']?.x === 3 && hudPartsKey('broadcast', true) === 'phone' && hudPartsKey('broadcast', false) === 'broadcast');
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('All HUD layout checks passed.');
