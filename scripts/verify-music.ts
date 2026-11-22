/**
 * Checks the soundtrack's catalogue and the music director (src/lib/audio): what plays on the title, the grid, at the
 * lights out, at the flag, in a replay and in the pause menu; practice music from the first metres, kept through
 * restarts; the race's first track loaded while the grid waits; the engine load under the race music; the shuffle; the
 * saved settings (levels, switched-off tracks, music while driving) round-tripping through the parser; and the player's
 * two decks on a stand-in audio graph (handovers that wait for the new track, track ends, fades, skips, refused plays,
 * switched-off tracks, the race compressor).
 * Run: npx tsx scripts/verify-music.ts
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ARM_LEAD_S, AudioBGMController, CROSSFADE_S, HANDOVER_WAIT_S } from '../src/lib/audio/bgm-controller';
import { MUSIC_TRACKS, MUSIC_TRACK_IDS, musicTrack, type MusicPool } from '../src/lib/audio/music-catalog';
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
  const badTrim = MUSIC_TRACKS.filter((t) => !(Math.abs(t.gainDb) <= 3) || (t.startS ?? 0) < 0 || (t.endS !== undefined && t.endS <= (t.startS ?? 0) + 30));
  check('every track has a level trim within 3 dB and its music between start and end', badTrim.length === 0, badTrim.map((t) => t.id).join(', '));
  const lateStart = MUSIC_TRACKS.filter((t) => t.pool !== 'race' && (t.startS ?? 0) > 5);
  check('only a race track skips its opening (the others trim head silence)', lateStart.length === 0, lateStart.map((t) => t.id).join(', '));
  // The files are hosted, not committed: checked only where this checkout has them
  const dir = join(__dirname, '../public/music');
  if (existsSync(dir)) {
    const missing = MUSIC_TRACKS.filter((t) => !existsSync(join(dir, `${t.id}.mp3`))).map((t) => t.id);
    check('every track has its file', missing.length === 0, missing.join(', '));
  } else console.log('  SKIP the files (public/music is not in this checkout)');
  check('the music key is not neutral\'s', !DEFAULT_KEY_BINDINGS.nextTrack.some((k) => DEFAULT_KEY_BINDINGS.neutral.includes(k)));
}

const base: MusicInputs = { phase: 'driving', racePhase: undefined, replaying: false, frozen: false, speedMs: 0, engineLoad: 0 };

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
  check('the grid at the lights: the race music loads beforehand', d.cue({ ...base, racePhase: 'lights' }).arm === 'race');
  check('racing: nothing to load beforehand', d.cue({ ...base, racePhase: 'racing' }).arm === null);
  check('the menus: nothing to load beforehand', d.cue({ ...base, phase: 'title' }).arm === null);
  check('racing: the engine load passes', d.cue({ ...base, racePhase: 'racing', engineLoad: 0.8 }).load === 0.8);
  check('the load is clamped', d.cue({ ...base, racePhase: 'racing', engineLoad: 3 }).load === 1 && d.cue({ ...base, racePhase: 'racing', engineLoad: NaN }).load === 0);
  check('paused, a replay, the results: no load', [{ frozen: true }, { replaying: true }, { racePhase: 'finished' as const }].every((x) => d.cue({ ...base, racePhase: 'racing', engineLoad: 1, ...x }).load === 0));
}

console.log('Practice');
{
  const d = new MusicDirector();
  check('on the grid: silence', d.cue(base).pool === null);
  check('on the grid: the race music loads beforehand', d.cue(base).arm === 'race');
  check('creeping: still silence', d.cue({ ...base, speedMs: PRACTICE_START_MS * 0.5 }).pool === null);
  check('paused on the grid: silence, ducked', d.cue({ ...base, frozen: true }).pool === null);
  check('moving: the race pool', d.cue({ ...base, speedMs: PRACTICE_START_MS + 1 }).pool === 'race');
  check('moving: nothing to load beforehand', d.cue({ ...base, speedMs: PRACTICE_START_MS + 1 }).arm === null);
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
  check('an old save has no music while driving', old.audio.raceMusicOn === false && DEFAULT_AUDIO_SETTINGS.raceMusicOn === false);
  check('music while driving, switched on, is kept', parsePlayerSettings({ audio: { raceMusicOn: true } }).audio.raceMusicOn === true);
  check('an old save gets the music key', parsePlayerSettings({ keys: { mute: ['KeyM'] } }).keys.nextTrack[0] === 'KeyK');
}

/**
 * The player on a stand-in audio graph: each gain reads where it is headed, each deck is an <audio> whose play() the
 * check plays at once, holds until the file "starts", or refuses (no press), and the stop timers run on a clock of the
 * check's own
 */
class FakeParam {
  constructor(public value = 0) {}
  cancelAndHoldAtTime(): void {}
  cancelScheduledValues(): void {}
  setValueAtTime(v: number): void {
    this.value = v;
  }
  linearRampToValueAtTime(v: number): void {
    this.value = v;
  }
  exponentialRampToValueAtTime(v: number): void {
    this.value = v;
  }
  /** The last curve set on any parameter: the fades' shape */
  static lastCurve: Float32Array | null = null;
  /** Firefox-like: setValueCurveAtTime refuses (the player falls back to a linear ramp) */
  static refuseCurves = false;
  setValueCurveAtTime(curve: Float32Array): void {
    if (FakeParam.refuseCurves) throw new DOMException('overlap', 'NotSupportedError');
    FakeParam.lastCurve = curve;
    this.value = curve[curve.length - 1];
  }
}

const fakeNode = () => ({ connect(): void {} });

class FakeContext {
  /** The check's clock, in seconds: fades run on it */
  static now = 0;
  state = 'running';
  get currentTime(): number {
    return FakeContext.now;
  }
  destination = {};
  createGain() {
    return { ...fakeNode(), gain: new FakeParam(1) };
  }
  createBiquadFilter() {
    return { ...fakeNode(), type: '', frequency: new FakeParam(), Q: new FakeParam(), gain: new FakeParam() };
  }
  createMediaElementSource() {
    return fakeNode();
  }
  createDynamicsCompressor() {
    return { ...fakeNode(), threshold: new FakeParam(), knee: new FakeParam(), ratio: new FakeParam(), attack: new FakeParam(), release: new FakeParam() };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

class FakeAudio {
  /** How play() answers for a track's file: at once, once the check calls start(), or refused */
  static mode: 'play' | 'wait' | 'refuse' = 'play';
  /** iOS-like: a track's file gives its length only once the check says (loaded()), even while it plays */
  static lazy = false;
  static made: FakeAudio[] = [];
  preload = '';
  crossOrigin: string | null = null;
  paused = true;
  currentTime = 0;
  readyState = 0;
  seeking = false;
  duration = NaN;
  /** How many files the deck was given */
  srcSets = 0;
  private srcAttr: string | null = null;
  private pending: { resolve: () => void; reject: (err: unknown) => void } | null = null;
  private readonly listeners: { type: string; fn: () => void; once: boolean }[] = [];
  constructor() {
    FakeAudio.made.push(this);
  }
  get src(): string {
    return this.srcAttr ?? '';
  }
  set src(v: string) {
    this.abort();
    this.srcAttr = v;
    this.srcSets++;
    this.paused = true;
    this.currentTime = 0;
    // The silent clip is all there at once; a track's file has its length at once, its frames when the check says
    this.readyState = v.startsWith('data:') ? 4 : FakeAudio.lazy ? 0 : 1;
  }
  getAttribute(name: string): string | null {
    return name === 'src' ? this.srcAttr : null;
  }
  removeAttribute(): void {
    this.srcAttr = null;
  }
  load(): void {}
  play(): Promise<void> {
    const mode = this.src.startsWith('data:') ? 'play' : FakeAudio.mode;
    if (mode === 'refuse') return Promise.reject(new DOMException('no press yet', 'NotAllowedError'));
    this.paused = false;
    if (mode === 'play') return Promise.resolve();
    return new Promise<void>((resolve, reject) => (this.pending = { resolve, reject }));
  }
  pause(): void {
    this.paused = true;
    this.abort();
  }
  /** The file starts playing: a held play() resolves */
  start(): void {
    const p = this.pending;
    this.pending = null;
    p?.resolve();
  }
  /** The file's length and first frames are in */
  loaded(): void {
    this.readyState = 4;
    for (const l of [...this.listeners]) {
      if (l.type !== 'loadedmetadata') continue;
      if (l.once) this.listeners.splice(this.listeners.indexOf(l), 1);
      l.fn();
    }
  }
  /** The file plays on to `t`: the element's timeupdate */
  tick(t: number): void {
    this.currentTime = t;
    this.fire('timeupdate');
  }
  fire(type: string): void {
    for (const l of [...this.listeners]) {
      if (l.type !== type) continue;
      if (l.once) this.listeners.splice(this.listeners.indexOf(l), 1);
      l.fn();
    }
  }
  addEventListener(type: string, fn: () => void, opts?: { once?: boolean }): void {
    this.listeners.push({ type, fn, once: opts?.once === true });
  }
  private abort(): void {
    this.pending?.reject(new DOMException('a newer load took over', 'AbortError'));
    this.pending = null;
  }
}

async function playerChecks(): Promise<void> {
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = { AudioContext: FakeContext };
  const doc = {
    hidden: false,
    handlers: [] as (() => void)[],
    addEventListener(type: string, fn: () => void): void {
      if (type === 'visibilitychange') doc.handlers.push(fn);
    },
    removeEventListener(): void {},
  };
  g.document = doc;
  const setHidden = (hidden: boolean) => {
    doc.hidden = hidden;
    for (const fn of doc.handlers) fn();
  };
  g.Audio = FakeAudio;
  let clockMs = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let timerId = 0;
  g.setTimeout = (fn: () => void, ms: number) => {
    timers.set(++timerId, { at: clockMs + ms, fn });
    return timerId;
  };
  g.clearTimeout = (id: number) => timers.delete(id);
  const advance = (ms: number) => {
    clockMs += ms;
    FakeContext.now = clockMs / 1000;
    for (const [id, t] of [...timers]) {
      if (t.at > clockMs) continue;
      timers.delete(id);
      t.fn();
    }
  };
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const levels = { volume: 1, muted: false, musicMuted: false, menu: 1, race: 0.5, results: 1 };
  const cue = (pool: MusicPool | null) => ({ pool, duck: false, driveEq: false, arm: null, load: 0 });
  const menuIds = MUSIC_TRACKS.filter((t) => t.pool === 'menu').map((t) => t.id);
  /** A player unlocked by a press, both decks primed */
  const player = async () => {
    FakeAudio.made = [];
    FakeAudio.mode = 'play';
    FakeAudio.lazy = false;
    FakeParam.refuseCurves = false;
    doc.handlers.length = 0;
    doc.hidden = false;
    const c = new AudioBGMController();
    c.setLevels(levels);
    c.unlock();
    await settle();
    return { c, decks: FakeAudio.made };
  };

  console.log('The player');
  {
    const { c, decks } = await player();
    FakeAudio.mode = 'wait';
    c.setCue(cue('menu'));
    const d = c.debugState().active;
    c.setCue(cue(null));
    decks[d].start();
    await settle();
    check('a track that starts playing inside its fade-out stays faded', c.debugState().decks[d].gain === 0, `gain ${c.debugState().decks[d].gain}`);
    advance(CROSSFADE_S * 1000 + 100);
    check('and stops at the end of it', decks[d].paused);
  }
  {
    const { c, decks } = await player();
    c.setCue(cue('menu'));
    FakeAudio.mode = 'wait';
    c.playNextInPool();
    const d = c.debugState().active;
    c.playNextInPool();
    decks[d].start();
    await settle();
    check('skip twice in a second: the skipped track stays faded', c.debugState().decks[d].gain === 0, `gain ${c.debugState().decks[d].gain}`);
  }
  {
    const { c } = await player();
    FakeAudio.mode = 'wait';
    c.setCue(cue('menu'));
    const d = c.debugState().active;
    c.setLevels({ ...levels });
    check('a press that sets the same levels leaves a fade-in alone', c.debugState().decks[d].gain === 0, `gain ${c.debugState().decks[d].gain}`);
    c.setLevels({ ...levels, menu: 0.4 });
    check('a new level still moves it', c.debugState().decks[d].gain === 0.4, `gain ${c.debugState().decks[d].gain}`);
  }
  {
    const { c, decks } = await player();
    FakeAudio.mode = 'refuse';
    c.setCue(cue('race'));
    await settle();
    c.setCue(cue('results'));
    await settle();
    const st = c.debugState();
    check('both plays refused without a press', st.decks.every((x) => x.blocked), JSON.stringify(st.decks.map((x) => x.blocked)));
    FakeAudio.mode = 'play';
    c.unlock();
    await settle();
    const after = c.debugState();
    check('the next press plays the results track', !decks[after.active].paused && after.decks[after.active].pool === 'results');
    check('and not the race track left behind', decks[1 - after.active].paused, `race deck paused: ${decks[1 - after.active].paused}`);
  }
  {
    const { c, decks } = await player();
    const two = ['air', 'clair-de-lune'];
    c.setDisabled(new Set(menuIds.filter((id) => !two.includes(id))));
    c.setCue(cue('menu'));
    await settle();
    const d = c.debugState().active;
    const first = c.debugState().decks[d].track!;
    decks[d].currentTime = 40;
    c.playNextInPool();
    await settle();
    advance(CROSSFADE_S * 1000 + 100);
    c.playNextInPool();
    await settle();
    const back = c.debugState();
    check('two tracks alternate on the two decks', back.active === d && back.decks[d].track === first);
    const startS = musicTrack(first)?.startS ?? 0;
    check('a track picked afresh on the deck that had it starts at its start point', decks[d].currentTime === startS, `at ${decks[d].currentTime} s, start ${startS} s`);
  }
  {
    const { c } = await player();
    const others = new Set(menuIds.filter((id) => id !== 'air'));
    c.setDisabled(others);
    c.setCue(cue('menu'));
    check('one menu track on: it plays', c.current?.id === 'air');
    c.setDisabled(new Set(menuIds));
    check('that one switched off too: silence', c.current === null);
    let told = 0;
    c.subscribe(() => told++);
    c.setDisabled(new Set(menuIds));
    check('a press with every track still off tells nobody', told === 0);
    c.setDisabled(others);
    check('a track switched back on starts the music again', c.current?.id === 'air', `${c.current?.id}`);
  }

  console.log('Handovers');
  {
    const { c, decks } = await player();
    c.setCue(cue('menu'));
    await settle();
    advance(500);
    const a = c.debugState().active;
    FakeAudio.mode = 'wait';
    c.playNextInPool();
    const b = c.debugState().active;
    let st = c.debugState();
    check('a skip loads the next track on the other deck', b !== a);
    check('the track playing stays at its level until the next one sounds', !decks[a].paused && st.decks[a].gain > 0.5 && st.decks[b].gain === 0, `old ${st.decks[a].gain}, new ${st.decks[b].gain}`);
    FakeParam.lastCurve = null;
    decks[b].start();
    await settle();
    st = c.debugState();
    check('once it sounds, the old track fades and the new one comes in', st.decks[a].gain === 0 && st.decks[b].gain === 1, `old ${st.decks[a].gain}, new ${st.decks[b].gain}`);
    const curve = FakeParam.lastCurve as Float32Array | null;
    // The old deck's fade-out was the last curve set: cos-shaped, at 0.707 of its level halfway
    const mid = curve ? curve[Math.round((curve.length - 1) / 2)] : NaN;
    check('the fades are equal-power curves', Math.abs(mid - Math.SQRT1_2) < 0.03, `halfway ${mid.toFixed(3)}`);
    advance(CROSSFADE_S * 1000 + 100);
    check('and the old deck stops', decks[a].paused);
  }
  {
    const { c, decks } = await player();
    c.setCue(cue('menu'));
    await settle();
    const a = c.debugState().active;
    FakeAudio.mode = 'wait';
    c.playNextInPool();
    advance(HANDOVER_WAIT_S * 1000 - 100);
    check('a stalled stream: the old track plays on meanwhile', c.debugState().decks[a].gain > 0.5 && !decks[a].paused);
    advance(200);
    check('past the wait it fades anyway', c.debugState().decks[a].gain === 0);
  }
  {
    const { c, decks } = await player();
    c.setCue(cue('menu'));
    await settle();
    const a = c.debugState().active;
    FakeAudio.mode = 'wait';
    c.playNextInPool();
    const b = c.debugState().active;
    c.setLevels({ ...levels, musicMuted: true });
    decks[b].start();
    await settle();
    advance(CROSSFADE_S * 1000 + 100);
    const st = c.debugState();
    check('the music switched off inside a handover: both decks fall silent and stop', st.decks.every((x) => x.gain === 0) && decks[a].paused && decks[b].paused, JSON.stringify(st.decks.map((x) => [x.gain, x.paused])));
  }
  {
    const { c, decks } = await player();
    const others = new Set(menuIds.filter((id) => id !== 'air'));
    c.setDisabled(others);
    c.setCue(cue('menu'));
    await settle();
    const a = c.debugState().active;
    const end = musicTrack('air')!.endS!;
    decks[a].tick(end - ARM_LEAD_S - 5);
    check('mid-track: nothing loads yet', !c.debugState().decks[1 - a].armed);
    decks[a].tick(end - ARM_LEAD_S + 1);
    let st = c.debugState();
    check('near the end the next track loads on the other deck, paused', Boolean(st.decks[1 - a].armed) && decks[1 - a].paused);
    const sets = decks[1 - a].srcSets;
    decks[a].tick(end - 0.1);
    st = c.debugState();
    check('at the music\'s measured end the next track takes over, without loading again', st.active === 1 - a && decks[1 - a].srcSets === sets);
    await settle();
    st = c.debugState();
    check('it comes in at full level and the old tail fades', st.decks[1 - a].gain === 1 && st.decks[a].gain === 0);
    check('a menu track plays straight, not through the compressor', !st.decks[1 - a].compressed);
  }


  console.log('Browsers');
  {
    const { c, decks } = await player();
    FakeAudio.lazy = true;
    c.setCue(cue('menu'));
    await settle();
    const a = c.debugState().active;
    const id = c.debugState().decks[a].track!;
    check('iOS-like: the deck plays before its file gives its length', !decks[a].paused && c.debugState().decks[a].gain === 0);
    decks[a].loaded();
    await settle();
    const startS = musicTrack(id)?.startS ?? 0;
    check('and sounds once it is seeked to its start point', decks[a].currentTime === startS && c.debugState().decks[a].gain === 1, `${id} at ${decks[a].currentTime} s`);
  }
  {
    const { c, decks } = await player();
    const proto = FakeParam.prototype as unknown as { cancelAndHoldAtTime?: () => void };
    const hold = proto.cancelAndHoldAtTime;
    delete proto.cancelAndHoldAtTime;
    FakeParam.refuseCurves = true;
    try {
      c.setCue(cue('menu'));
      await settle();
      advance(500);
      const a = c.debugState().active;
      c.playNextInPool();
      await settle();
      const st = c.debugState();
      check('Firefox-like (no cancelAndHoldAtTime, curves refused): a skip still crossfades', st.active !== a && st.decks[a].gain === 0 && st.decks[st.active].gain === 1);
      advance(CROSSFADE_S * 1000 + 100);
      check('and stops the old deck', decks[a].paused);
    } finally {
      proto.cancelAndHoldAtTime = hold;
    }
  }
  {
    const { c, decks } = await player();
    c.setCue(cue('menu'));
    await settle();
    advance(500);
    const a = c.debugState().active;
    c.playNextInPool();
    await settle();
    const b = c.debugState().active;
    advance(300);
    // Both decks sound (0.3 s into a 1 s crossfade): a second skip takes the quieter one after a short fade
    const quieter = Math.cos(0.3 * (Math.PI / 2)) < Math.sin(0.3 * (Math.PI / 2)) ? a : b;
    const sets = decks[quieter].srcSets;
    c.playNextInPool();
    check('a skip inside a crossfade does not cut a sounding deck at once', decks[quieter].srcSets === sets);
    advance(100);
    await settle();
    check('it takes the quieter deck after a short fade', decks[quieter].srcSets === sets + 1 && c.debugState().active === quieter, `quieter ${quieter}, active ${c.debugState().active}`);
  }
  {
    const { c, decks } = await player();
    c.setCue(cue('menu'));
    await settle();
    advance(500);
    const a = c.debugState().active;
    FakeAudio.mode = 'wait';
    c.playNextInPool();
    const b = c.debugState().active;
    setHidden(true);
    check('a hidden tab inside a handover pauses both decks', decks[a].paused && decks[b].paused);
    FakeAudio.mode = 'play';
    setHidden(false);
    await settle();
    const st = c.debugState();
    check('back: only the new track plays on', !decks[b].paused && decks[a].paused && st.decks[b].gain === 1 && st.decks[a].gain === 0);
  }

  console.log('Race music');
  {
    const { c } = await player();
    c.setLevels({ ...levels, race: 0 });
    c.setCue({ ...cue(null), arm: 'race' });
    check('music while driving off: nothing loads at the lights', c.debugState().decks.every((x) => !x.armed));
    c.setCue(cue('race'));
    check('music while driving off: the race is silent', c.current === null);
    c.setCue(cue('results'));
    await settle();
    check('the flag still brings the results music', c.current?.pool === 'results');
  }
  {
    const { c, decks } = await player();
    // Egmont alone: a race track that skips its quiet opening
    c.setDisabled(new Set(MUSIC_TRACKS.filter((t) => t.pool === 'race' && t.id !== 'egmont-overture').map((t) => t.id)));
    c.setCue(cue('menu'));
    await settle();
    c.setCue(cue(null));
    advance(CROSSFADE_S * 1000 + 100);
    c.setCue({ ...cue(null), arm: 'race' });
    let st = c.debugState();
    const i = st.decks.findIndex((x) => x.armed);
    check('at the lights the race\'s first track loads beforehand, paused', i >= 0 && st.decks[i].pool === 'race' && decks[i].paused);
    const id = st.decks[i].track!;
    const startS = musicTrack(id)?.startS ?? 0;
    check('seeked to its start point', startS > 0 && decks[i].currentTime === startS, `${id} at ${decks[i].currentTime} s, start ${startS} s`);
    const sets = decks[i].srcSets;
    c.setCue(cue('race'));
    st = c.debugState();
    check('lights out: that track plays without loading again', st.active === i && c.current?.id === id && decks[i].srcSets === sets);
    await settle();
    st = c.debugState();
    check('and comes straight in', !decks[i].paused && st.decks[i].gain === levels.race);
    check('through the compressor', st.decks[i].compressed);
  }
  {
    const { c, decks } = await player();
    c.setCue(cue('race'));
    await settle();
    const a = c.debugState().active;
    decks[a].currentTime = 61;
    c.setCue({ ...cue(null), arm: 'race' });
    advance(CROSSFADE_S * 1000 + 100);
    check('a restart at the lights loads nothing new: the held track waits on its deck', c.debugState().decks.every((x) => !x.armed));
    c.setCue(cue('race'));
    await settle();
    check('and picks up where it stopped', c.debugState().active === a && !decks[a].paused && decks[a].currentTime === 61);
  }
}

playerChecks().then(
  () => console.log(`\n${passed} checks passed`),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
