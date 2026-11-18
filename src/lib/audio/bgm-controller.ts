/**
 * The music player: two decks that crossfade, each an <audio> element streaming one MP3 (a decoded 10-minute track
 * would hold some 200 MB of samples), on an audio context of its own. One for the page (`sharedMusic`): a drive session
 * lasts one circuit and closes its car audio with it, and the menu music plays on across circuit changes.
 *
 *   deck A / deck B (MediaElementSource → GainNode) → peaking EQ → low-pass → duck → master → speakers
 *
 * It plays what the music director cues (music-director.ts): a change of pool crossfades over a second (the race's
 * fade at the flag takes 1.5 s), a held pool (silence) remembers where it stopped so a restart or a trip through the
 * menus picks it up there, and a track that ends hands over to the next one of its pool. The pause duck (-6 dB through
 * a 600 Hz low-pass over 150 ms) and the race carve (-3 dB at 1 kHz) move the shared filters, which stay in the chain.
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
export const DUCK_S = 0.15;
/** -6 dB */
export const DUCK_GAIN = 0.5;
export const DUCK_LOWPASS_HZ = 600;
export const OPEN_LOWPASS_HZ = 20000;
export const DRIVE_EQ_HZ = 1000;
export const DRIVE_EQ_DB = -3;

interface Deck {
  el: HTMLAudioElement;
  gain: GainNode;
  track: MusicTrack | null;
  pool: MusicPool | null;
  /** Bumped whenever the deck takes new work: a timer or event left from earlier work does nothing */
  gen: number;
  /** Fading out (and paused at the end of it) */
  leaving: boolean;
  stopTimer: ReturnType<typeof setTimeout> | null;
  /** play() was refused (no user gesture yet): prime() retries it inside the next press */
  blocked: boolean;
  primed: boolean;
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

export class AudioBGMController {
  private ctx: AudioContext | null = null;
  private decks: Deck[] = [];
  /** The deck that plays, or played last */
  private active = 0;
  private eq: BiquadFilterNode | null = null;
  private lowpass: BiquadFilterNode | null = null;
  private duckGain: GainNode | null = null;
  private master: GainNode | null = null;
  private silent = "";

  /** What the director asked for last, and the pool playing for it (null where its level is zero) */
  private wanted: MusicCue = { pool: null, duck: false, driveEq: false };
  private playing: MusicPool | null = null;
  private ducked = false;
  private carved = false;
  private levels: MusicLevels = { volume: 1, muted: false, musicMuted: false, menu: 1, race: 1, results: 1 };
  private disabled: ReadonlySet<string> = new Set();
  /** Tracks whose file would not load (absent in this checkout, or a network error): left out until a reload */
  private readonly unavailable = new Set<string>();
  private readonly bags: Record<MusicPool, TrackBag> = { menu: new TrackBag(), race: new TrackBag(), results: new TrackBag() };
  /** Where a held pool's track stopped, to pick up from there */
  private readonly held: Partial<Record<MusicPool, { id: string; timeS: number }>> = {};
  private openerPlayed = false;
  private seq = 0;
  /** The page was hidden while a deck played: it pauses, and plays on when the page is back */
  private pausedForHidden = false;

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
    const master = ctx.createGain();
    master.gain.value = this.masterLevel();
    eq.connect(lowpass);
    lowpass.connect(duckGain);
    duckGain.connect(master);
    master.connect(ctx.destination);
    for (let i = 0; i < 2; i++) {
      const el = new Audio();
      el.preload = "auto";
      el.crossOrigin = "anonymous";
      const gain = ctx.createGain();
      gain.gain.value = 0;
      ctx.createMediaElementSource(el).connect(gain);
      gain.connect(eq);
      const deck: Deck = { el, gain, track: null, pool: null, gen: 0, leaving: false, stopTimer: null, blocked: false, primed: false };
      el.addEventListener("ended", () => this.onEnded(deck));
      el.addEventListener("error", () => this.onError(deck));
      this.decks.push(deck);
    }
    this.ctx = ctx;
    this.eq = eq;
    this.lowpass = lowpass;
    this.duckGain = duckGain;
    this.master = master;
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  /** Each deck plays once inside the press (a silent clip, or a play the browser refused earlier) */
  private prime(): void {
    for (const deck of this.decks) {
      if (deck.blocked) {
        deck.blocked = false;
        this.startDeck(deck, deck.gen);
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
        .catch(() => {});
    }
  }

  /** What should play now (every frame; it acts on changes only) */
  setCue(cue: MusicCue): void {
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
    this.reconcile();
  }

  setLevels(levels: MusicLevels): void {
    this.levels = levels;
    if (this.master) this.ramp(this.master.gain, this.masterLevel(), 0.05);
    const deck = this.decks[this.active];
    if (deck && !deck.leaving && deck.pool && deck.pool === this.playing) this.ramp(deck.gain.gain, this.levelOf(deck.pool), 0.1);
    this.reconcile();
  }

  /** The tracks the player switched off (Settings > Audio): the one playing moves on if it is among them */
  setDisabled(ids: ReadonlySet<string>): void {
    this.disabled = ids;
    for (const pool of Object.keys(this.held) as MusicPool[]) {
      if (ids.has(this.held[pool]!.id)) delete this.held[pool];
    }
    const deck = this.decks[this.active];
    if (deck?.track && !deck.leaving && ids.has(deck.track.id) && this.playing) this.playNext(this.playing, true);
  }

  /** Skip: the next track of the pool playing, at once (nothing while the music is held) */
  playNextInPool(): void {
    if (!this.playing) return;
    delete this.held[this.playing];
    this.playNext(this.playing, true);
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
      lowpassHz: this.lowpass?.frequency.value,
      eqDb: this.eq?.gain.value,
      unavailable: [...this.unavailable],
      held: { ...this.held },
      decks: this.decks.map((d) => ({
        track: d.track?.id ?? null,
        pool: d.pool,
        gain: d.gain.gain.value,
        timeS: d.el.currentTime,
        paused: d.el.paused,
        leaving: d.leaving,
        blocked: d.blocked,
      })),
    };
  }

  /** Stops for good (a hot reload in development replaces the module) */
  dispose(): void {
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
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
    return this.levels.musicMuted ? 0 : Math.min(1, Math.max(0, this.levels[pool]));
  }

  private playable(id: string): boolean {
    return !this.disabled.has(id) && !this.unavailable.has(id);
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
      // The menus always pick up where they were; another pool only when it was held (a restart at the lights)
      if (pool === null || from === "menu") this.held[from] = { id: cur.track.id, timeS: cur.el.currentTime };
      else delete this.held[from];
    }
    if (pool === null) {
      this.fadeOut(cur, CROSSFADE_S);
      this.onTrack(null);
      return;
    }
    const outS = from === "race" && pool === "results" ? FINISH_FADE_S : CROSSFADE_S;
    const resume = this.held[pool];
    delete this.held[pool];
    const track = resume && this.playable(resume.id) ? musicTrack(resume.id) : undefined;
    if (track && resume) this.play(track, pool, resume.timeS, false, outS);
    else this.playNext(pool, true, outS);
  }

  private playNext(pool: MusicPool, announce: boolean, outS = CROSSFADE_S): void {
    const ids = MUSIC_TRACKS.filter((t) => t.pool === pool && this.playable(t.id)).map((t) => t.id);
    const opener = pool === "menu" && !this.openerPlayed ? OPENERS : undefined;
    const id = this.bags[pool].next(ids, opener);
    const track = id ? musicTrack(id) : undefined;
    if (!track) {
      this.fadeOut(this.decks[this.active], outS);
      this.onTrack(null);
      return;
    }
    if (pool === "menu") this.openerPlayed = true;
    this.play(track, pool, 0, announce, outS);
  }

  private play(track: MusicTrack, pool: MusicPool, atS: number, announce: boolean, outS: number): void {
    const cur = this.decks[this.active];
    // Picking up the track this deck held: it carries on from where it is (fading still, or paused at the fade's end)
    if (!announce && cur.track?.id === track.id && cur.pool === pool) {
      const gen = this.claim(cur);
      if (cur.el.paused) this.startDeck(cur, gen);
      else this.ramp(cur.gain.gain, this.levelOf(pool), CROSSFADE_S);
      this.announce(track, pool, false);
      return;
    }
    this.fadeOut(cur, outS);
    this.active = 1 - this.active;
    const deck = this.decks[this.active];
    const gen = this.claim(deck);
    deck.track = track;
    deck.pool = pool;
    this.ramp(deck.gain.gain, 0, 0);
    const url = musicUrl(track);
    if (deck.el.getAttribute("src") !== url) deck.el.src = url;
    const seek = () => {
      if (gen !== deck.gen || atS <= 0) return;
      try {
        deck.el.currentTime = atS;
      } catch {
        // Ignore: it starts from the top
      }
    };
    if (deck.el.readyState >= 1) seek();
    else deck.el.addEventListener("loadedmetadata", seek, { once: true });
    this.startDeck(deck, gen);
    this.announce(track, pool, announce);
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

  /** Plays the deck and fades it in once it really plays */
  private startDeck(deck: Deck, gen: number): void {
    if (this.pausedForHidden) return;
    void deck.el
      .play()
      .then(() => {
        // A deck the music has left since (a stop, or a skip within the second) stays on its fade-out
        if (gen !== deck.gen || !deck.pool || deck.leaving || deck !== this.decks[this.active]) return;
        this.ramp(deck.gain.gain, this.levelOf(deck.pool), CROSSFADE_S);
      })
      .catch((err: unknown) => {
        if (gen !== deck.gen) return;
        // Refused for want of a press: the next press plays it (prime). An abort is a newer src taking over.
        if (err instanceof DOMException && err.name === "NotAllowedError") deck.blocked = true;
      });
  }

  /** The deck takes new work: its pending stop and old events are dropped */
  private claim(deck: Deck): number {
    deck.gen++;
    deck.leaving = false;
    deck.blocked = false;
    if (deck.stopTimer !== null) clearTimeout(deck.stopTimer);
    deck.stopTimer = null;
    return deck.gen;
  }

  private fadeOut(deck: Deck, s: number): void {
    if (!deck || deck.leaving || deck.el.paused) return;
    deck.leaving = true;
    this.ramp(deck.gain.gain, 0, s);
    const gen = deck.gen;
    deck.stopTimer = setTimeout(() => {
      if (gen !== deck.gen) return;
      deck.stopTimer = null;
      deck.el.pause();
    }, s * 1000 + 80);
  }

  private onEnded(deck: Deck): void {
    if (deck !== this.decks[this.active] || deck.leaving || !deck.pool || deck.pool !== this.playing) return;
    this.playNext(deck.pool, true);
  }

  private onError(deck: Deck): void {
    if (!deck.track || deck.el.getAttribute("src") === this.silent) return;
    this.unavailable.add(deck.track.id);
    if (deck === this.decks[this.active] && !deck.leaving && deck.pool && deck.pool === this.playing) {
      console.warn(`[music] ${deck.track.id} would not load: skipped`);
      this.playNext(deck.pool, true);
    }
  }

  private readonly onVisibility = () => {
    const deck = this.decks[this.active];
    if (!deck) return;
    if (document.hidden) {
      if (!deck.el.paused) {
        this.pausedForHidden = true;
        deck.el.pause();
      }
    } else if (this.pausedForHidden) {
      this.pausedForHidden = false;
      if (deck.pool && deck.pool === this.playing && !deck.leaving) this.startDeck(deck, deck.gen);
    }
  };

  /**
   * Ramps a parameter from wherever it is now (an interrupted fade carries on from its current value, not from where
   * it was headed): linear for gains, exponential for a filter's frequency
   */
  private ramp(p: AudioParam, target: number, s: number, exponential = false): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (typeof p.cancelAndHoldAtTime === "function") p.cancelAndHoldAtTime(t);
    else {
      const v = p.value;
      p.cancelScheduledValues(t);
      p.setValueAtTime(v, t);
    }
    if (s <= 0) p.setValueAtTime(target, t);
    else if (exponential) p.exponentialRampToValueAtTime(Math.max(1e-4, target), t + s);
    else p.linearRampToValueAtTime(target, t + s);
  }
}

/** The page's music player (kept on globalThis, so a hot reload in development hands over instead of doubling it) */
export function sharedMusic(): AudioBGMController {
  const g = globalThis as unknown as { __lcMusic?: AudioBGMController };
  return (g.__lcMusic ??= new AudioBGMController());
}
