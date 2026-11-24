/**
 * Headless checks for early driver display-name prompting on Weekly Challenge entry:
 *   - Fresh auto-generated profiles require a name prompt (`needsDriverNamePrompt` is true).
 *   - Explicitly confirming/keeping the auto-generated name clears `generated` (`confirmDriverProfileName`),
 *     preventing repeat prompts while preserving the name, code, color, and autoUpload flag.
 *   - Persisting and reloading via `parsePlayerSettings` retains `generated: false` (no repeat prompts) and
 *     retains `generated: true` until confirmed or edited.
 *   - Custom names chosen by the player (`generated: false`) do not trigger the prompt.
 *
 *   npx tsx scripts/verify-driver-name-prompt.ts
 */
import {
  confirmDriverProfileName,
  DEFAULT_PLAYER_SETTINGS,
  needsDriverNamePrompt,
  parsePlayerSettings,
  randomDriverProfile,
} from '../src/lib/settings/player-settings';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};

const fresh = randomDriverProfile(() => 0.25);
check('auto-generated profile starts with generated=true', fresh.generated === true, fresh.name);
check('auto-generated profile triggers early name prompt', needsDriverNamePrompt(fresh) === true);

const confirmed = confirmDriverProfileName(fresh);
check('confirming name clears generated flag', confirmed.generated === false);
check('confirming name preserves name, code, color, and autoUpload', confirmed.name === fresh.name && confirmed.code === fresh.code && confirmed.color === fresh.color && confirmed.autoUpload === fresh.autoUpload);
check('confirmed profile does not prompt again', needsDriverNamePrompt(confirmed) === false);
check('confirming an already confirmed profile returns the same reference', confirmDriverProfileName(confirmed) === confirmed);

const savedGenerated = parsePlayerSettings({ ...DEFAULT_PLAYER_SETTINGS, profile: fresh });
check('unconfirmed generated profile survives save/load and still prompts', needsDriverNamePrompt(savedGenerated.profile) === true);

const savedConfirmed = parsePlayerSettings({ ...DEFAULT_PLAYER_SETTINGS, profile: confirmed });
check('confirmed profile survives save/load without re-prompting', needsDriverNamePrompt(savedConfirmed.profile) === false && savedConfirmed.profile.name === fresh.name);

const custom = parsePlayerSettings({
  ...DEFAULT_PLAYER_SETTINGS,
  profile: { name: 'Senna', code: 'SEN', color: '#CCFF00', generated: false, autoUpload: true },
});
check('player-chosen custom name does not trigger prompt', needsDriverNamePrompt(custom.profile) === false && custom.profile.name === 'Senna');

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll driver name prompt checks passed.');
