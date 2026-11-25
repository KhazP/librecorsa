/**
 * The music player: two decks, each an <audio> element streaming one MP3 (a decoded 10-minute track would hold some
 * 200 MB of samples), on an audio context of its own. One for the page (`sharedMusic`): a drive session lasts one
 * circuit and closes its car audio with it, and the menu music plays on across circuit changes.
 *
 *   deck A / deck B: MediaElementSource → trim (the track's gainDb) → dry, or compressor → wet (race tracks) → fade
 *   → peaking EQ → low-pass → duck → engine duck → master → speakers
 *
 * It plays what the music director cues (music-director.ts):
 * - A change of music loads the new track on the idle deck and keeps the old one at its level until the new one really
 *   sounds (or HANDOVER_WAIT_S pass), then crossfades on equal-power curves: no hole while a stream loads.
 * - A track hands over to the next of its pool at its measured end (music-catalog.ts endS): the next one loads
 *   ARM_LEAD_S before and comes in at full level, so there is no silent tail and no fade over its opening.
 * - A fresh track starts at its start point (head silence trimmed; a race track with a quiet opening at its first loud
 *   section), seeked before it sounds. While the grid waits, the race's first track loads beforehand, so it starts on
 *   the lights out.
 * - A held pool (silence) remembers where it stopped, so a restart or a trip through the menus picks it up there.
 * - Race tracks go through a compressor (the orchestral recordings swing 10 LU and more, and their quiet passages
 *   vanish under an engine) and dip up to 4 dB under a working engine, on an envelope seconds long so gear changes
 *   and lifts do not pump it.
 * - The pause duck (-6 dB through a 600 Hz low-pass over 150 ms) and the race carve (-3 dB at 1 kHz) move the shared
 *   filters, which stay in the chain.
 * Volume, mute and each pool's level come from the saved settings; a pool at zero plays nothing at all.
 */
import { MUSIC_TRACKS, musicTrack, musicUrl, type MusicPool, type MusicTrack } from "./music-catalog";
import { TrackBag, type MusicCue } from "./music-director";

export interface NowPlaying {
  id: string;
  title: string;
  composer: string;
  performer: string;
  pool: MusicPool;
  /** A new value for every track started (the toast shows each one once) */
  seq: number;
}

export interface MusicLevels {
  /** Master volume and mute (Settings > Audio): they apply to the music as to every sound */
  volume: number;
  muted: boolean;
  /** The music alone is off: nothing plays, and each pool picks up where it was when it comes back on */
  musicMuted: boolean;
  /** Each pool's level, 0 to 1 (0: that pool plays nothing) */
  menu: number;
  race: number;
  results: number;
}

/**
 * The music's level with every slider at full, over the -16 LUFS files. Not measured against the car: the race
 * pool's default slider sits 12 dB under the menus' so the engine and tyres stay on top, and the player tunes the rest
 */
export const MUSIC_BASE = 0.5;
export const CROSSFADE_S = 1;
/** The race music's fade at the player's flag */
export const FINISH_FADE_S = 1.5;
/** A fresh track from its start point, out of silence or at the end of the one before: in at once, its attack intact */
export const ENTRY_S = 0.05;
/** A deck taken while it still sounds (two changes inside one crossfade) fades this fast before its new file goes in */
export const STEAL_S = 0.05;
/** The music playing waits this long for the new track to sound, then fades anyway */
export const HANDOVER_WAIT_S = 2.5;
/** The next track of a pool loads this long before the playing one's end */
export const ARM_LEAD_S = 20;
/** The handover fires this close to a track's end (an element's timeupdate comes some four times a second) */
export const END_LEAD_S = 0.3;
/** The track ending fades over this once the next one sounds: its tail is all but silent by then */
export const TAIL_FADE_S = 1;
/** The pre-race show's cue jumping with its picture (a skip): a quick crossfade, under a cut */
export const SHOW_JUMP_S = 0.25;
export const DUCK_S = 0.15;
/** -6 dB */
export const DUCK_GAIN = 0.5;
export const DUCK_LOWPASS_HZ = 600;
export const OPEN_LOWPASS_HZ = 20000;
export const DRIVE_EQ_HZ = 1000;
export const DRIVE_EQ_DB = -3;
/** The engine duck at full load, and its envelope: down over about a second, back up over about four */
export const ENGINE_DUCK_DB = -4;
export const LOAD_ATTACK_S = 1;
export const LOAD_RELEASE_S = 4;
/**
 * The race tracks' compressor, and the trim after it that keeps their loudness where the dry files sit (the node adds
 * make-up gain of its own, 0.7-1.5 dB here). Rendered through the real node in Chromium (scripts/audio/music-comp.ts), it
 * takes the race tracks' loudness range from 5.5-13.2 LU to 3.8-8.2 LU
 */
export const RACE_COMP = { threshold: -28, knee: 12, ratio: 2, attack: 0.05, release: 0.5 } as const;
export const RACE_COMP_TRIM_DB = -0.9;

interface Deck {
  el: HTMLAudioElement;
  /** The fades */
  gain: GainNode;
  /** The track's level trim (gainDb) */
  trim: GainNode;
  /** Straight through (menu, results), or through the compressor (race) */
  dry: GainNode;
  wet: GainNode;
  track: MusicTrack | null;
  pool: MusicPool | null;
  /** Bumped whenever the deck takes new work: a timer or event left from earlier work does nothing */
  gen: number;
  /** Fading out (and paused at the end of it), or left behind paused */
  leaving: boolean;
  stopTimer: ReturnType<typeof setTimeout> | null;
  /** play() was refused (no user gesture yet): prime() retries it inside the next press */
  blocked: boolean;
  primed: boolean;
  /** Loaded beforehand and seeked to `atS`, paused at gain 0, for a play to come */
  armed: { atS: number } | null;
  /** Seeked to where it plays from: it may sound */
  ready: boolean;
  /** Its play() went through: it runs, at gain 0 until it is ready */
  started: boolean;
  /** Its fade-in once it sounds */
  entryS: number;
}

/** A short silent WAV: each deck plays it once inside a press, which unlocks it for later plays (iOS) */
function silentWav(): string {
  const samples = 256;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 16000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples * 2, true);
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(bin)}`;
}

const OPENERS = MUSIC_TRACKS.filter((t) => t.opener).map((t) => t.id);
const dbToGain = (db: number) => 10 ** (db / 20);

export class AudioBGMController {
  private ctx: AudioContext | null = null;
  private decks: Deck[] = [];
  /** The deck the music is on (playing, starting, or played last) */
  private active = 0;
  private eq: BiquadFilterNode | null = null;
  private lowpass: BiquadFilterNode | null = null;
  private duckGain: GainNode | null = null;
  private loadGain: GainNode | null = null;
  private master: GainNode | null = null;
  private silent = "";

  /** What the director asked for last, and the pool playing for it (null where its level is zero) */
  private wanted: MusicCue = { pool: null, duck: false, driveEq: false, arm: null, load: 0 };
  private playing: MusicPool | null = null;
  private ducked = false;
  private carved = false;
  private levels: MusicLevels = { volume: 1, muted: false, musicMuted: false, menu: 1, race: 1, results: 1 };
  private disabled: ReadonlySet<string> = new Set();
  /** Tracks whose file would not load (absent in this checkout, or a network error): left out until a reload */
  private readonly unavailable = new Set<string>();
  private readonly bags: Record<MusicPool, TrackBag> = { menu: new TrackBag(), race: new TrackBag(), results: new TrackBag(), show: new TrackBag() };
  /** Where a held pool's track stopped, to pick up from there */
  private readonly held: Partial<Record<MusicPool, { id: string; timeS: number }>> = {};
  private openerPlayed = false;
  private seq = 0;
  /** The page is hidden: every deck pauses, and the one the music is on plays on when the page is back */
  private pausedForHidden = false;
  /** A new track waiting to sound: the music before it fades once it does, or once the wait runs out */
  private handover: { deck: Deck; gen: number; outS: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The engine duck's envelope (0 to 1), when it last moved and when its gain was last set (the context's clock) */
  private loadEnv = 0;
  private loadAt = 0;
  private loadSetAt = -1;
  private warned = false;
  /**
   * Each parameter's last scheduled move, to know its value mid-fade without reading AudioParam.value back (browsers
   * differ on what it returns during automation)
   */
  private readonly moves = new WeakMap<AudioParam, { from: number; to: number; t0: number; s: number; shape: "lin" | "eq" | "exp" }>();

  private readonly listeners = new Set<(now: NowPlaying | null) => void>();
  /** The track playing (null while the music is held or has nothing to play) */
  current: NowPlaying | null = null;
  /** Each track as last announced: picked up again, it is the same announcement (the toast does not show it twice) */
  private readonly announced = new Map<string, NowPlaying>();

  /** Calls `listener` with each track started; returns the unsubscribe */
  subscribe(listener: (now: NowPlaying | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get unlocked(): boolean {
    return this.ctx !== null;
  }

  /** The music can sound for `pool` now: unlocked, its level above zero, a track of it playable */
  canPlay(pool: MusicPool): boolean {
    return this.ctx !== null && this.levelOf(pool) > 0 && MUSIC_TRACKS.some((t) => t.pool === pool && this.playable(t.id));
  }

  /** Where the pre-race show's cue is (s into the cue, from its start point), while it sounds; null otherwise */
  showPositionS(): number | null {
    const deck = this.decks[this.active];
    if (!deck?.track || deck.pool !== "show" || deck.leaving || !deck.started || deck.el.paused) return null;
    return deck.el.currentTime - (deck.track.startS ?? 0);
  }

  /**
   * The pre-race show moved on (a press to its next graphic or its start card): its cue goes to `cueS` (s into the cue,
   * from its start point) with the picture, crossfaded on the other deck. The show's clock follows the music, so without
   * this it would wait for the music to catch up. Nothing when the show's cue is not what plays.
   */
  jumpShow(cueS: number): void {
    const deck = this.decks[this.active];
    const track = deck?.track;
    if (this.playing !== "show" || !deck || !track || deck.pool !== "show" || deck.leaving) return;
    const atS = (track.startS ?? 0) + Math.max(0, cueS);
    if (Math.abs(deck.el.currentTime - atS) < SHOW_JUMP_S) return;
    this.play(track, "show", atS, false, SHOW_JUMP_S, SHOW_JUMP_S, true);
  }

  /**
   * Inside a user's press (the browser keeps audio locked until one): creates the context the first time, resumes it,
   * and lets each deck play later on its own
   */
  unlock(): void {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      try {
        this.build(new AudioCtx());
      } catch (err) {
        console.warn("[music] could not start; playing without music", err);
        return;
      }
    }
    const ctx = this.ctx;
    if (ctx && ctx.state === "suspended") {
      try {
        void Promise.resolve(ctx.resume()).catch(() => {});
      } catch {
        // Ignore: the next press tries again
      }
    }
    this.prime();
  }

  private onTrack(now: NowPlaying | null): void {
    this.current = now;
    for (const listener of this.listeners) listener(now);
  }

  /** The graph, once */
  private build(ctx: AudioContext): void {
    this.silent = silentWav();
    const eq = ctx.createBiquadFilter();
    eq.type = "peaking";
    eq.frequency.value = DRIVE_EQ_HZ;
    eq.Q.value = 1;
    eq.gain.value = 0;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = OPEN_LOWPASS_HZ;
    lowpass.Q.value = 0.707;
    const duckGain = ctx.createGain();
    const loadGain = ctx.createGain();
    const master = ctx.createGain();
    master.gain.value = this.masterLevel();
    eq.connect(lowpass);
    lowpass.connect(duckGain);
    duckGain.connect(loadGain);
    loadGain.connect(master);
    master.connect(ctx.destination);
    for (let i = 0; i < 2; i++) {
      const el = new Audio();
      el.preload = "auto";
      el.crossOrigin = "anonymous";
      const trim = ctx.createGain();
      const dry = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = RACE_COMP.threshold;
      comp.knee.value = RACE_COMP.knee;
      comp.ratio.value = RACE_COMP.ratio;
      comp.attack.value = RACE_COMP.attack;
      comp.release.value = RACE_COMP.release;
      const wet = ctx.createGain();
      wet.gain.value = 0;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      ctx.createMediaElementSource(el).connect(trim);
      trim.connect(dry);
      trim.connect(comp);
      comp.connect(wet);
      dry.connect(gain);
      wet.connect(gain);
      gain.connect(eq);
      const deck: Deck = {
        el,
        gain,
        trim,
        dry,
        wet,
        track: null,
        pool: null,
        gen: 0,
        leaving: false,
        stopTimer: null,
        blocked: false,
        primed: false,
        armed: null,
        ready: true,
        started: false,
        entryS: CROSSFADE_S,
      };
      el.addEventListener("ended", () => this.onEnded(deck));
      el.addEventListener("error", () => this.onError(deck));
      el.addEventListener("timeupdate", () => this.onTime(deck));
      this.decks.push(deck);
    }
    this.ctx = ctx;
    this.eq = eq;
    this.lowpass = lowpass;
    this.duckGain = duckGain;
    this.loadGain = loadGain;
    this.master = master;
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  /** Each deck plays once inside the press (a silent clip, or a play the browser refused earlier) */
  private prime(): void {
    for (const deck of this.decks) {
      if (deck.blocked) {
        deck.blocked = false;
        if (deck === this.decks[this.active] && !deck.leaving && deck.pool === this.playing) this.startDeck(deck, deck.gen);
        else {
          // A track the music has moved on from: the deck plays only to take the press (iOS), silent at gain 0
          const gen = deck.gen;
          void deck.el
            .play()
            .then(() => {
              if (gen === deck.gen) deck.el.pause();
            })
            .catch((err: unknown) => {
              // Refused again (the call did not come from a press): the next press tries this deck again
              if (gen === deck.gen && err instanceof DOMException && err.name === "NotAllowedError") deck.blocked = true;
            });
        }
        continue;
      }
      if (deck.primed || deck.track) continue;
      deck.primed = true;
      deck.el.src = this.silent;
      void deck.el
        .play()
        .then(() => {
          if (!deck.track) deck.el.pause();
        })
        .catch((err: unknown) => {
          // Refused (the call did not come from a press): the next press primes it
          if (err instanceof DOMException && err.name === "NotAllowedError") deck.primed = false;
        });
    }
  }

  /** What should play now (every frame from the session's loop: it acts on changes only, and never throws into it) */
  setCue(cue: MusicCue): void {
    try {
      this.wanted = cue;
      if (cue.duck !== this.ducked) {
        this.ducked = cue.duck;
        if (this.duckGain && this.lowpass) {
          this.ramp(this.duckGain.gain, cue.duck ? DUCK_GAIN : 1, DUCK_S);
          this.ramp(this.lowpass.frequency, cue.duck ? DUCK_LOWPASS_HZ : OPEN_LOWPASS_HZ, DUCK_S, true);
        }
      }
      if (cue.driveEq !== this.carved) {
        this.carved = cue.driveEq;
        if (this.eq) this.ramp(this.eq.gain, cue.driveEq ? DRIVE_EQ_DB : 0, CROSSFADE_S);
      }
      this.moveLoad(cue.load);
      this.reconcile();
      // While nothing plays, the pool coming next loads beforehand (the race's first track while the grid waits)
      if (!this.playing && cue.arm && this.levelOf(cue.arm) > 0) this.armPool(cue.arm);
    } catch (err) {
      if (!this.warned) console.warn("[music] cue failed", err);
      this.warned = true;
    }
  }

  setLevels(levels: MusicLevels): void {
    const deck = this.decks[this.active];
    const was = deck?.pool ? this.levelOf(deck.pool) : null;
    this.levels = levels;
    if (this.master) this.ramp(this.master.gain, this.masterLevel(), 0.05);
    // Only a new level moves the deck: every press sets the same levels again, and a fade-in under way carries on
    if (deck && !deck.leaving && deck.pool && deck.pool === this.playing && this.levelOf(deck.pool) !== was) {
      this.ramp(deck.gain.gain, this.levelOf(deck.pool), 0.1);
    }
    this.reconcile();
  }

  /** The tracks the player switched off (Settings > Audio): the one playing moves on if it is among them */
  setDisabled(ids: ReadonlySet<string>): void {
    this.disabled = ids;
    for (const pool of Object.keys(this.held) as MusicPool[]) {
      if (ids.has(this.held[pool]!.id)) delete this.held[pool];
    }
    // A track loaded beforehand and now off is let go
    for (const d of this.decks) if (d.armed && d.track && ids.has(d.track.id)) d.armed = null;
    const deck = this.decks[this.active];
    const pool = this.playing;
    if (deck?.track && !deck.leaving && ids.has(deck.track.id) && pool) this.playNext(pool);
    // The pool had nothing to play (every track of it off): one switched back on starts the music again
    else if (pool && !this.current && MUSIC_TRACKS.some((t) => t.pool === pool && this.playable(t.id))) this.playNext(pool);
  }

  /** Skip: the next track of the pool playing, crossfaded (nothing while the music is held) */
  playNextInPool(): void {
    if (!this.playing) return;
    delete this.held[this.playing];
    this.playNext(this.playing);
  }

  /** What the dev tools read in the browser: the decks, their gains and the shared filters */
  debugState() {
    return {
      wanted: this.wanted,
      playing: this.playing,
      active: this.active,
      context: this.ctx?.state,
      master: this.master?.gain.value,
      duck: this.duckGain?.gain.value,
      engineDuck: this.loadGain?.gain.value,
      lowpassHz: this.lowpass?.frequency.value,
      eqDb: this.eq?.gain.value,
      unavailable: [...this.unavailable],
      held: { ...this.held },
      handover: this.handover ? { deck: this.decks.indexOf(this.handover.deck), outS: this.handover.outS } : null,
      decks: this.decks.map((d) => ({
        track: d.track?.id ?? null,
        pool: d.pool,
        gain: d.gain.gain.value,
        compressed: d.wet.gain.value > 0,
        timeS: d.el.currentTime,
        paused: d.el.paused,
        leaving: d.leaving,
        blocked: d.blocked,
        armed: d.armed,
        ready: d.ready,
      })),
    };
  }

  /** Stops for good (a hot reload in development replaces the module) */
  dispose(): void {
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    this.dropHandover();
    for (const deck of this.decks) {
      this.claim(deck);
      try {
        deck.el.pause();
        deck.el.removeAttribute("src");
        deck.el.load();
      } catch {
        // Ignore
      }
    }
    this.decks = [];
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) void Promise.resolve(ctx.close()).catch(() => {});
  }

  private masterLevel(): number {
    return this.levels.muted ? 0 : MUSIC_BASE * Math.min(1, Math.max(0, this.levels.volume));
  }

  private levelOf(pool: MusicPool): number {
    // The pre-race show has no slider of its own: the cars are silent under it, so it sits at the menus' level
    const level = pool === "show" ? this.levels.menu : this.levels[pool];
    return this.levels.musicMuted ? 0 : Math.min(1, Math.max(0, level));
  }

  private playable(id: string): boolean {
    return !this.disabled.has(id) && !this.unavailable.has(id);
  }

  /** Audible now: playing above silence (a fade-out under way still counts) */
  private sounding(deck: Deck): boolean {
    return !deck.el.paused && this.gainOf(deck) > 1e-3;
  }

  private gainOf(deck: Deck): number {
    return this.valueAt(deck.gain.gain, this.ctx?.currentTime ?? 0);
  }

  /** Moves the music to the pool the cue and the levels call for */
  private reconcile(): void {
    if (!this.ctx) return;
    const want = this.wanted.pool;
    const pool = want && this.levelOf(want) > 0 ? want : null;
    if (pool === this.playing) return;
    const from = this.playing;
    this.playing = pool;
    const cur = this.decks[this.active];
    if (from && cur.track && cur.pool === from && !cur.leaving) {
      // The menus always pick up where they were; another pool only when it was held (a restart at the lights). The
      // show's cue never: each show plays it from its own start
      if (from !== "show" && (pool === null || from === "menu")) this.held[from] = { id: cur.track.id, timeS: cur.el.currentTime };
      else delete this.held[from];
    }
    if (pool === null) {
      this.silence(CROSSFADE_S);
      this.onTrack(null);
      return;
    }
    const outS = from === "race" && pool === "results" ? FINISH_FADE_S : CROSSFADE_S;
    if (pool === "show") {
      // The show's cue from its start, or from the grid's section (the one loaded beforehand when it is there)
      const armed = this.decks.find((d) => d.armed && d.pool === pool && d.track && this.playable(d.track.id));
      const track = armed?.track ?? this.pick(pool);
      if (!track) {
        this.silence(outS);
        this.onTrack(null);
        return;
      }
      this.play(track, pool, (track.startS ?? 0) + Math.max(0, this.wanted.fromS ?? 0), true, outS, ENTRY_S);
      return;
    }
    const resume = this.held[pool];
    delete this.held[pool];
    const track = resume && this.playable(resume.id) ? musicTrack(resume.id) : undefined;
    if (track && resume) this.play(track, pool, resume.timeS, false, outS, CROSSFADE_S);
    // A fresh track out of silence comes in at once (the lights out); over other music, it crossfades
    else this.playNext(pool, outS, from === null ? ENTRY_S : CROSSFADE_S);
  }

  /** The next track of `pool`: the one loaded beforehand when there is one, else the shuffle's next */
  private playNext(pool: MusicPool, outS = CROSSFADE_S, entryS = CROSSFADE_S): void {
    const armed = this.decks.find((d) => d.armed && d.pool === pool && d.track && this.playable(d.track.id));
    if (armed?.track && armed.armed) {
      this.play(armed.track, pool, armed.armed.atS, true, outS, entryS);
      return;
    }
    const track = this.pick(pool);
    if (!track) {
      this.silence(outS);
      this.onTrack(null);
      return;
    }
    this.play(track, pool, track.startS ?? 0, true, outS, entryS);
  }

  /** The shuffle's next track of `pool` (the first menu track of all is an opener) */
  private pick(pool: MusicPool): MusicTrack | undefined {
    const ids = MUSIC_TRACKS.filter((t) => t.pool === pool && this.playable(t.id)).map((t) => t.id);
    const opener = pool === "menu" && !this.openerPlayed ? OPENERS : undefined;
    const id = this.bags[pool].next(ids, opener);
    if (id && pool === "menu") this.openerPlayed = true;
    return id ? musicTrack(id) : undefined;
  }

  /**
   * Plays `track` from `atS`: picked up on a deck that still holds it (a resume), or loaded on a silent deck (the one
   * loaded beforehand when it is this track), with the music before it fading once it sounds
   */
  private play(track: MusicTrack, pool: MusicPool, atS: number, announce: boolean, outS: number, entryS: number, seek = false): void {
    const url = musicUrl(track);
    // A seek (the show's cue jumping) takes the other deck even though this one holds the track, and is no new track
    if (!announce && !seek) {
      const holder = this.decks.find(
        (d) => d.track?.id === track.id && d.pool === pool && !d.armed && d.ready && d.el.getAttribute("src") === url
      );
      if (holder) {
        // It carries on from where it is (fading still, or paused at the fade's end)
        const gen = this.claim(holder);
        this.active = this.decks.indexOf(holder);
        holder.entryS = entryS;
        this.announce(track, pool, false);
        if (holder.el.paused) {
          this.beginHandover(holder, gen, outS);
          this.startDeck(holder, gen);
        } else {
          this.dropHandover();
          this.fade(holder.gain.gain, this.levelOf(pool), entryS);
          this.fadeOthers(holder, outS);
        }
        return;
      }
    }
    const deck =
      this.decks.find((d) => d.armed && d.track?.id === track.id && d.pool === pool && Math.abs(d.armed.atS - atS) < 0.1) ??
      this.decks.find((d, i) => i !== this.active && !this.sounding(d)) ??
      this.decks.find((d) => !this.sounding(d)) ??
      this.decks.reduce((a, b) => (this.gainOf(b) < this.gainOf(a) ? b : a));
    this.active = this.decks.indexOf(deck);
    this.announce(track, pool, announce);
    if (!this.sounding(deck)) {
      this.begin(deck, track, pool, atS, outS, entryS);
      return;
    }
    // Still audible (two changes inside one crossfade): a short fade before its new file goes in
    const gen = this.claim(deck);
    this.ramp(deck.gain.gain, 0, STEAL_S);
    deck.stopTimer = setTimeout(() => {
      deck.stopTimer = null;
      if (gen === deck.gen && !deck.leaving && this.playing === pool) this.begin(deck, track, pool, atS, outS, entryS);
    }, STEAL_S * 1000 + 20);
  }

  /**
   * Loads the track on the deck and plays it at once, at gain 0 (a browser may fetch nothing for a paused element:
   * iOS), seeking it to its start as soon as its length is known; it sounds once both are done, and the music before
   * it waits for that
   */
  private begin(deck: Deck, track: MusicTrack, pool: MusicPool, atS: number, outS: number, entryS: number): void {
    const gen = this.load(deck, track, pool);
    deck.entryS = entryS;
    this.beginHandover(deck, gen, outS);
    this.seekThen(deck, gen, atS, () => this.sound(deck, gen));
    this.startDeck(deck, gen);
  }

  /** Puts `track` on `deck`, paused at gain 0 (the file stays when the deck has it already); the caller seeks it */
  private load(deck: Deck, track: MusicTrack, pool: MusicPool): number {
    const gen = this.claim(deck);
    deck.track = track;
    deck.pool = pool;
    const race = pool === "race";
    this.ramp(deck.gain.gain, 0, 0);
    this.ramp(deck.trim.gain, dbToGain(track.gainDb), 0);
    this.ramp(deck.dry.gain, race ? 0 : 1, 0);
    this.ramp(deck.wet.gain, race ? dbToGain(RACE_COMP_TRIM_DB) : 0, 0);
    const url = musicUrl(track);
    if (deck.el.getAttribute("src") !== url) deck.el.src = url;
    return gen;
  }

  /** The pool's next track, loaded and seeked on the idle deck (the race's first while the grid waits) */
  private armPool(pool: MusicPool): void {
    // A held track resumes on the deck that kept it; one loaded already waits
    if (this.held[pool] || this.decks.some((d) => d.armed && d.pool === pool)) return;
    const deck = this.decks[1 - this.active];
    // Still fading: the next frame tries again
    if (!deck || this.sounding(deck)) return;
    const track = this.pick(pool);
    if (!track) return;
    const atS = track.startS ?? 0;
    const gen = this.load(deck, track, pool);
    deck.armed = { atS };
    this.seekThen(deck, gen, atS, () => {});
  }

  /** The next track of the playing deck's pool, loaded on the idle deck before the playing one ends */
  private armNext(playing: Deck): void {
    const deck = this.decks[1 - this.active];
    if (!playing.pool || !deck || (deck.armed && deck.pool === playing.pool) || this.sounding(deck)) return;
    const track = this.pick(playing.pool);
    if (!track) return;
    const atS = track.startS ?? 0;
    const gen = this.load(deck, track, playing.pool);
    deck.armed = { atS };
    this.seekThen(deck, gen, atS, () => {});
  }

  /** Seeks the deck to `atS` once its file's length is known, then calls `then` (seeked already: at once) */
  private seekThen(deck: Deck, gen: number, atS: number, then: () => void): void {
    const el = deck.el;
    const done = () => {
      if (gen !== deck.gen) return;
      deck.ready = true;
      then();
    };
    const go = () => {
      if (gen !== deck.gen) return;
      if (Math.abs(el.currentTime - atS) < 0.05 && !el.seeking) return done();
      try {
        el.currentTime = atS;
      } catch {
        // Ignore: it plays from where it is
        return done();
      }
      if (el.seeking) el.addEventListener("seeked", done, { once: true });
      else done();
    };
    if (deck.ready && Math.abs(el.currentTime - atS) < 0.05 && !el.seeking) return done();
    deck.ready = false;
    if (el.readyState >= 1) go();
    else el.addEventListener("loadedmetadata", go, { once: true });
  }

  /** Tells the listeners: a new announcement, or (picking a track up again) the one it had */
  private announce(track: MusicTrack, pool: MusicPool, fresh: boolean): void {
    const known = this.announced.get(track.id);
    const now =
      !fresh && known && known.pool === pool
        ? known
        : { id: track.id, title: track.title, composer: track.composer, performer: track.performer, pool, seq: ++this.seq };
    this.announced.set(track.id, now);
    this.onTrack(now);
  }

  /** Plays the deck; it fades in once it really plays and sits where it should (sound) */
  private startDeck(deck: Deck, gen: number): void {
    if (this.pausedForHidden) return;
    // The music moved on meanwhile: it stays paused
    if (gen !== deck.gen || deck.leaving || deck !== this.decks[this.active] || deck.pool !== this.playing) return;
    void deck.el
      .play()
      .then(() => {
        if (gen !== deck.gen) return;
        deck.started = true;
        this.sound(deck, gen);
      })
      .catch((err: unknown) => {
        if (gen !== deck.gen) return;
        // Refused for want of a press: the next press plays it (prime). An abort is a newer src taking over.
        if (err instanceof DOMException && err.name === "NotAllowedError") deck.blocked = true;
        // The music before it goes either way
        this.finishHandover(deck, gen);
      });
  }

  /** Playing and seeked: the deck fades in and the music before it fades out */
  private sound(deck: Deck, gen: number): void {
    // A deck the music has left since (a stop, or a skip within the second) stays on its fade-out
    if (gen !== deck.gen || !deck.started || !deck.ready || !deck.pool || deck.leaving || deck !== this.decks[this.active]) return;
    this.fade(deck.gain.gain, this.levelOf(deck.pool), deck.entryS);
    this.finishHandover(deck, gen);
  }

  /** The music sounding now waits for `deck` (its new track) to sound, or for HANDOVER_WAIT_S */
  private beginHandover(deck: Deck, gen: number, outS: number): void {
    this.dropHandover();
    const timer = setTimeout(() => this.finishHandover(deck, gen), HANDOVER_WAIT_S * 1000);
    this.handover = { deck, gen, outS, timer };
  }

  private finishHandover(deck: Deck, gen: number): void {
    const h = this.handover;
    if (!h || h.deck !== deck || h.gen !== gen) return;
    this.dropHandover();
    this.fadeOthers(deck, h.outS);
  }

  private dropHandover(): void {
    if (this.handover) clearTimeout(this.handover.timer);
    this.handover = null;
  }

  private fadeOthers(keep: Deck, s: number): void {
    for (const d of this.decks) if (d !== keep) this.fadeOut(d, s);
  }

  /** Every deck fades out (the music held, or a pool with nothing to play) */
  private silence(s: number): void {
    this.dropHandover();
    for (const d of this.decks) this.fadeOut(d, s);
  }

  /** The deck takes new work: its pending stop, its loaded-beforehand state and old events are dropped */
  private claim(deck: Deck): number {
    deck.gen++;
    deck.leaving = false;
    deck.blocked = false;
    deck.armed = null;
    deck.started = false;
    if (deck.stopTimer !== null) clearTimeout(deck.stopTimer);
    deck.stopTimer = null;
    return deck.gen;
  }

  private fadeOut(deck: Deck, s: number): void {
    if (!deck || deck.leaving) return;
    if (deck.el.paused) {
      // Silent already; one loaded beforehand stays ready
      if (!deck.armed) deck.leaving = true;
      return;
    }
    deck.leaving = true;
    if (deck.stopTimer !== null) clearTimeout(deck.stopTimer);
    this.fade(deck.gain.gain, 0, s);
    const gen = deck.gen;
    deck.stopTimer = setTimeout(() => {
      if (gen !== deck.gen) return;
      deck.stopTimer = null;
      deck.el.pause();
    }, s * 1000 + 80);
  }

  /** Near the end of the track playing: the next one loads, then takes over at the music's measured end */
  private onTime(deck: Deck): void {
    if (deck !== this.decks[this.active] || deck.leaving || !deck.track || !deck.pool || deck.pool !== this.playing) return;
    if (deck.el.paused || this.handover) return;
    const end = deck.track.endS ?? (Number.isFinite(deck.el.duration) ? deck.el.duration : Infinity);
    const left = end - deck.el.currentTime;
    // The show's cue is played once: at its end it fades, and the start card waits in silence
    if (deck.pool === "show") {
      if (left <= END_LEAD_S) this.silence(TAIL_FADE_S);
      return;
    }
    if (left <= END_LEAD_S) this.playNext(deck.pool, TAIL_FADE_S, ENTRY_S);
    else if (left <= ARM_LEAD_S) this.armNext(deck);
  }

  /** The file ran out before the handover (a missed timeupdate, a short file): the next track now */
  private onEnded(deck: Deck): void {
    if (deck !== this.decks[this.active] || deck.leaving || !deck.pool || deck.pool !== this.playing) return;
    if (deck.pool === "show") return this.silence(TAIL_FADE_S);
    this.playNext(deck.pool, TAIL_FADE_S, ENTRY_S);
  }

  private onError(deck: Deck): void {
    if (!deck.track || deck.el.getAttribute("src") === this.silent) return;
    this.unavailable.add(deck.track.id);
    if (deck.armed) {
      deck.armed = null;
      return;
    }
    if (deck === this.decks[this.active] && !deck.leaving && deck.pool && deck.pool === this.playing) {
      console.warn(`[music] ${deck.track.id} would not load: skipped`);
      this.playNext(deck.pool);
    }
  }

  private readonly onVisibility = () => {
    if (!this.decks.length) return;
    if (document.hidden) {
      this.pausedForHidden = true;
      this.dropHandover();
      const keep = this.decks[this.active];
      for (const d of this.decks) {
        if (d.el.paused) continue;
        d.el.pause();
        // Only the deck the music is on comes back: one fading out is done
        if (d !== keep) {
          d.leaving = true;
          if (d.stopTimer !== null) clearTimeout(d.stopTimer);
          d.stopTimer = null;
          this.ramp(d.gain.gain, 0, 0);
        }
      }
    } else if (this.pausedForHidden) {
      this.pausedForHidden = false;
      const deck = this.decks[this.active];
      if (deck.track && deck.pool && deck.pool === this.playing && !deck.leaving) this.startDeck(deck, deck.gen);
    }
  };

  /** The engine duck: an envelope of the cue's load (fast down, slow back), its gain set ten times a second */
  private moveLoad(load: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.loadGain) return;
    const now = ctx.currentTime;
    const dt = Math.min(0.5, Math.max(0, now - this.loadAt));
    this.loadAt = now;
    const target = Number.isFinite(load) ? Math.min(1, Math.max(0, load)) : 0;
    const tau = target > this.loadEnv ? LOAD_ATTACK_S : LOAD_RELEASE_S;
    this.loadEnv += (target - this.loadEnv) * (1 - Math.exp(-dt / tau));
    if (this.loadSetAt >= 0 && now - this.loadSetAt < 0.1) return;
    this.loadSetAt = now;
    this.ramp(this.loadGain.gain, dbToGain(ENGINE_DUCK_DB * this.loadEnv), 0.1);
  }

  /** A parameter's value at `t` from its last scheduled move (its plain value when none was scheduled) */
  private valueAt(p: AudioParam, t: number): number {
    const m = this.moves.get(p);
    if (!m) return p.value;
    if (!(m.s > 0) || t >= m.t0 + m.s) return m.to;
    const x = Math.max(0, (t - m.t0) / m.s);
    if (m.shape === "exp") return m.from * (m.to / m.from) ** x;
    if (m.shape === "eq") {
      const a = (x * Math.PI) / 2;
      return m.to > m.from ? m.from + (m.to - m.from) * Math.sin(a) : m.to + (m.from - m.to) * Math.cos(a);
    }
    return m.from + (m.to - m.from) * x;
  }

  /** Holds a parameter where it is now (an interrupted fade carries on from its current value, not its target) */
  private hold(p: AudioParam, t: number): number {
    const v = this.valueAt(p, t);
    if (typeof p.cancelAndHoldAtTime === "function") p.cancelAndHoldAtTime(t);
    else {
      p.cancelScheduledValues(t);
      p.setValueAtTime(v, t);
    }
    return v;
  }

  /** Ramps a parameter from wherever it is now: linear for gains, exponential for a filter's frequency */
  private ramp(p: AudioParam, target: number, s: number, exponential = false): void {
    const ctx = this.ctx;
    if (!ctx || !Number.isFinite(target)) return;
    const t = ctx.currentTime;
    const from = this.hold(p, t);
    const to = exponential ? Math.max(1e-4, target) : target;
    if (!(s > 0)) p.setValueAtTime(target, t);
    else if (exponential) p.exponentialRampToValueAtTime(to, t + s);
    else p.linearRampToValueAtTime(target, t + s);
    this.moves.set(p, { from: exponential ? Math.max(1e-4, from) : from, to, t0: t, s: s > 0 ? s : 0, shape: exponential ? "exp" : "lin" });
  }

  /**
   * A deck's fade on an equal-power curve (sine in, cosine out), so two decks crossing hold their summed power instead
   * of dipping 3 dB halfway; a linear ramp where the curve cannot go in
   */
  private fade(p: AudioParam, target: number, s: number): void {
    const ctx = this.ctx;
    if (!ctx || !Number.isFinite(target)) return;
    if (!(s > 0.02) || typeof p.setValueCurveAtTime !== "function" || typeof p.cancelAndHoldAtTime !== "function") {
      return this.ramp(p, target, s);
    }
    const t = ctx.currentTime;
    const from = this.hold(p, t);
    if (!Number.isFinite(from)) return this.ramp(p, target, s);
    const n = 32;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = ((i / (n - 1)) * Math.PI) / 2;
      curve[i] = target > from ? from + (target - from) * Math.sin(x) : target + (from - target) * Math.cos(x);
    }
    curve[n - 1] = target;
    try {
      p.setValueCurveAtTime(curve, t, s);
      this.moves.set(p, { from, to: target, t0: t, s, shape: "eq" });
    } catch {
      this.ramp(p, target, s);
    }
  }
}

/** The page's music player (kept on globalThis, so a hot reload in development hands over instead of doubling it) */
export function sharedMusic(): AudioBGMController {
  const g = globalThis as unknown as { __lcMusic?: AudioBGMController };
  return (g.__lcMusic ??= new AudioBGMController());
}
