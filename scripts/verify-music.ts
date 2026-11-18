/**
 * Checks the soundtrack's catalogue and the music director (src/lib/audio): what plays on the title, the grid, at the
 * lights out, at the flag, in a replay and in the pause menu; practice music from the first metres, kept through
 * restarts; the shuffle; and the saved settings (levels, switched-off tracks) round-tripping through the parser.
 * Run: npx tsx scripts/verify-music.ts
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MUSIC_TRACKS, MUSIC_TRACK_IDS, type MusicPool } from '../src/lib/audio/music-catalog';
import { MusicDirector, PRACTICE_START_MS, TrackBag, type MusicInputs } from '../src/lib/audio/music-director';
import { DEFAULT_AUDIO_SETTINGS, parsePlayerSettings } from '../src/lib/settings/player-settings';
import { DEFAULT_KEY_BINDINGS } from '../src/lib/input/bindings';

let passed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
}

console.log('Catalogue');
{
  check('ids are unique', MUSIC_TRACK_IDS.size === MUSIC_TRACKS.length);
  for (const pool of ['menu', 'race', 'results'] as MusicPool[]) {
    const n = MUSIC_TRACKS.filter((t) => t.pool === pool).length;
    check(`the ${pool} pool has tracks`, n >= 2, `${n}`);
  }
  check('the menus have an opener', MUSIC_TRACKS.some((t) => t.opener && t.pool === 'menu'));
  check('every track is CC0 or public domain', MUSIC_TRACKS.every((t) => t.licence === 'CC0' || t.licence === 'Public domain'));
  // The files are hosted, not committed: checked only where this checkout has them
  const dir = join(__dirname, '../public/music');
  if (existsSync(dir)) {
    const missing = MUSIC_TRACKS.filter((t) => !existsSync(join(dir, `${t.id}.mp3`))).map((t) => t.id);
    check('every track has its file', missing.length === 0, missing.join(', '));
  } else console.log('  SKIP the files (public/music is not in this checkout)');
  check('the music key is not neutral\'s', !DEFAULT_KEY_BINDINGS.nextTrack.some((k) => DEFAULT_KEY_BINDINGS.neutral.includes(k)));
}

const base: MusicInputs = { phase: 'driving', racePhase: undefined, replaying: false, frozen: false, speedMs: 0 };

console.log('A race');
{
  const d = new MusicDirector();
  check('loading: silence', d.cue({ ...base, phase: 'loading' }).pool === null);
  check('the title: the menus', d.cue({ ...base, phase: 'title' }).pool === 'menu');
  check('the setup screens: the same pool', d.cue({ ...base, phase: 'wizard' }).pool === 'menu');
  check('the grid at the lights: silence', d.cue({ ...base, racePhase: 'lights' }).pool === null);
  const green = d.cue({ ...base, racePhase: 'racing', speedMs: 5 });
  check('lights out: the race pool', green.pool === 'race');
  check('racing: the mid-range carve on', green.driveEq && !green.duck);
  const paused = d.cue({ ...base, racePhase: 'racing', frozen: true });
  check('paused: the race music, ducked', paused.pool === 'race' && paused.duck && !paused.driveEq);
  check('the flag: the results pool', d.cue({ ...base, racePhase: 'finished' }).pool === 'results');
  check('a replay: the results pool', d.cue({ ...base, racePhase: 'racing', replaying: true }).pool === 'results');
  check('a replay: no carve', !d.cue({ ...base, racePhase: 'racing', replaying: true }).driveEq);
  check('a restart: back to silence at the lights', d.cue({ ...base, racePhase: 'lights' }).pool === null);
  check('a rolling start (racing from its first frame): the race pool', new MusicDirector().cue({ ...base, racePhase: 'racing' }).pool === 'race');
  check('back to the menus', d.cue({ ...base, phase: 'title', racePhase: 'finished' }).pool === 'menu');
}

console.log('Practice');
{
  const d = new MusicDirector();
  check('on the grid: silence', d.cue(base).pool === null);
  check('creeping: still silence', d.cue({ ...base, speedMs: PRACTICE_START_MS * 0.5 }).pool === null);
  check('paused on the grid: silence, ducked', d.cue({ ...base, frozen: true }).pool === null);
  check('moving: the race pool', d.cue({ ...base, speedMs: PRACTICE_START_MS + 1 }).pool === 'race');
  check('a restart onto the grid: the music plays on', d.cue(base).pool === 'race');
  check('qualifying status-less frames keep it', d.cue({ ...base, speedMs: 0 }).pool === 'race');
  d.cue({ ...base, phase: 'title' });
  check('after the menus: it waits for the car again', d.cue(base).pool === null);
  const fly = new MusicDirector();
  check('a flying lap (moving at once): the race pool', fly.cue({ ...base, speedMs: 60 }).pool === 'race');
  const frozenFly = new MusicDirector();
  check('a speed seen only while frozen does not start it', frozenFly.cue({ ...base, speedMs: 60, frozen: true }).pool === null);
}

console.log('Shuffle');
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const bag = new TrackBag(rnd);
  const ids = ['a', 'b', 'c', 'd'];
  const run1 = [0, 1, 2, 3].map(() => bag.next(ids)!);
  check('each track once per run', new Set(run1).size === 4, run1.join(''));
  const next = bag.next(ids)!;
  check('a new run never repeats the last track', next !== run1[3], `${run1[3]} then ${next}`);
  let repeats = 0;
  let prev = next;
  for (let i = 0; i < 400; i++) {
    const id = bag.next(ids)!;
    if (id === prev) repeats++;
    prev = id;
  }
  check('no track twice in a row over 400 picks', repeats === 0);
  check('a switched-off track is skipped', [0, 1, 2, 3, 4, 5].every(() => bag.next(['a', 'b']) !== 'c'));
  check('nothing playable: null', bag.next([]) === null);
  check('one track: it repeats', bag.next(['a']) === 'a' && bag.next(['a']) === 'a');
  const opener = new TrackBag(rnd);
  check('the opener comes first', ['x', 'y'].includes(opener.next(['a', 'b', 'x', 'y', 'c'], ['x', 'y'])!));
}

console.log('Settings');
{
  const parsed = parsePlayerSettings({ audio: { volume: 0.5, muted: true, menuMusic: 0.3, raceMusic: 2, replayMusic: -1, musicOff: ['air', 'air', 'nope', 3] } });
  const a = parsed.audio;
  check('volume and mute kept', a.volume === 0.5 && a.muted);
  check('levels kept and clamped', a.menuMusic === 0.3 && a.raceMusic === 1 && a.replayMusic === 0);
  check('switched-off tracks: known ids, once each', a.musicOff.length === 1 && a.musicOff[0] === 'air', JSON.stringify(a.musicOff));
  const old = parsePlayerSettings({ audio: { volume: 0.7, muted: false } });
  check('an old save gets the music defaults', old.audio.menuMusic === DEFAULT_AUDIO_SETTINGS.menuMusic && old.audio.musicOff.length === 0);
  check('the race music sits 12 dB under the menus by default', Math.abs(20 * Math.log10(DEFAULT_AUDIO_SETTINGS.raceMusic / DEFAULT_AUDIO_SETTINGS.menuMusic) + 12) < 0.1);
  check('the music switch is kept', parsePlayerSettings({ audio: { musicMuted: true } }).audio.musicMuted === true);
  check('an old save has the music on', old.audio.musicMuted === false);
  check('an old save gets the music key', parsePlayerSettings({ keys: { mute: ['KeyM'] } }).keys.nextTrack[0] === 'KeyK');
}

console.log(`\n${passed} checks passed`);
