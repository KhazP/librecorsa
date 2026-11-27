/**
 * The spotter: a recorded voice that calls the cars alongside the player ("car left", "three wide", "clear"), as a
 * spotter does on the radio. Cars are placed in the player's car frame, with hysteresis and a gap between calls so a
 * car hovering at the edge doesn't chatter. The clips are Kokoro-82M spotter voices (Apache-2.0, public/audio/spotter); they
 * play through the car audio's master output, so the master volume, mute and pause apply, and can go through a team
 * radio filter (band-pass, presence peak and a squelch click).
 */
import * as THREE from "three";
import { withBasePath } from "@/lib/base-path";
import type { InterpolatedPeerState } from "./multiplayer-sync";

export type SpotterSideState = "clear" | "left" | "right" | "both";
export type SpotterVoiceId = "jim" | "clare" | "geoffrey";
export type SpotterClipKey = "car_left" | "car_right" | "three_wide" | "clear_left" | "clear_right" | "clear" | "still_there";

const CLIPS: readonly SpotterClipKey[] = ["car_left", "car_right", "three_wide", "clear_left", "clear_right", "clear", "still_there"];

export interface SpotterConfig {
  enabled: boolean;
  /** The spotter's own volume, 0 to 1 (the master volume and mute apply on the output) */
  volume: number;
  voice: SpotterVoiceId;
  radioFilter: boolean;
}

/** Where the calls go: the car audio's context and master output, once it has started */
export interface SpotterOutput {
  context: AudioContext | null;
  output: AudioNode | null;
}

/** A car this close along (m) and across (m) is alongside; it has to drop further back or out to be clear again */
const ENTER_LONG_M = 5.4;
const EXIT_LONG_M = 6.2;
const ENTER_LAT_M = 3.6;
const EXIT_LAT_M = 4.3;
/** Shortest gap between two calls (a "clear" is never held back) */
const MIN_CALLOUT_GAP_MS = 1600;
/** Alongside this long: "still there", once */
const STILL_THERE_MS = 2800;
/** Below this speed (m/s) nothing is called: the grid, the pit lane at a crawl, a spin */
const MIN_SPEED_MS = 5;
/** A gap this long between two updates is time away (a hidden tab stops the frames): the spotter starts from clear */
const MAX_UPDATE_GAP_MS = 500;

function clipPath(voice: SpotterVoiceId, key: SpotterClipKey): string {
  // George, the default voice (id "jim", kept from the first voice set), sits at the top of the folder
  return withBasePath(voice === "jim" ? `/audio/spotter/${key}.wav` : `/audio/spotter/${voice}/${key}.wav`);
}

export class SpotterEngine {
  private state: SpotterSideState = "clear";
  private lastCalloutMs = 0;
  private alongsideSinceMs = 0;
  private saidStillThere = false;
  private lastUpdateMs = -Infinity;
  private readonly rel = new THREE.Vector3();
  private readonly invQ = new THREE.Quaternion();

  /** The context the buffers and the radio chain below belong to: another one (the audio restarted) starts them again */
  private ctx: AudioContext | null = null;
  private radio: { input: AudioNode; gain: GainNode } | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly loading = new Set<string>();
  private readonly failed = new Set<string>();
  private activeSource: AudioBufferSourceNode | null = null;

  update(
    nowMs: number,
    playerPos: THREE.Vector3,
    playerQuat: THREE.Quaternion,
    playerSpeedMs: number,
    peers: readonly InterpolatedPeerState[],
    config: SpotterConfig,
    out: SpotterOutput,
  ): SpotterSideState {
    // Back from time away: what was alongside then is not known to be alongside now, nor for how long
    if (nowMs - this.lastUpdateMs > MAX_UPDATE_GAP_MS) this.reset();
    this.lastUpdateMs = nowMs;
    if (!config.enabled) {
      this.reset();
      return this.state;
    }
    if (Math.abs(playerSpeedMs) < MIN_SPEED_MS) {
      this.state = "clear";
      return this.state;
    }
    this.attach(out, config.voice);

    this.invQ.copy(playerQuat).invert();
    const longThresh = this.state === "clear" ? ENTER_LONG_M : EXIT_LONG_M;
    const latThresh = this.state === "clear" ? ENTER_LAT_M : EXIT_LAT_M;
    let hasLeft = false;
    let hasRight = false;
    for (const p of peers) {
      if (p.ghost || p.stale || p.passThrough) continue;
      // The car frame: +z ahead, +x to the left (as the proximity radar reads it)
      this.rel.copy(p.position).sub(playerPos).applyQuaternion(this.invQ);
      if (Math.abs(this.rel.z) <= longThresh && Math.abs(this.rel.x) <= latThresh) {
        if (this.rel.x >= 0) hasLeft = true;
        else hasRight = true;
      }
    }
    const next: SpotterSideState = hasLeft && hasRight ? "both" : hasLeft ? "left" : hasRight ? "right" : "clear";

    if (next !== this.state) {
      if (nowMs - this.lastCalloutMs >= MIN_CALLOUT_GAP_MS || next === "clear") {
        const prev = this.state;
        this.state = next;
        this.lastCalloutMs = nowMs;
        this.saidStillThere = false;
        this.alongsideSinceMs = next === "clear" ? 0 : nowMs;
        if (next === "both") this.play("three_wide", config);
        else if (next === "left") this.play("car_left", config);
        else if (next === "right") this.play("car_right", config);
        else if (prev === "left") this.play("clear_left", config);
        else if (prev === "right") this.play("clear_right", config);
        else this.play("clear", config);
      }
    } else if (next !== "clear" && !this.saidStillThere && nowMs - this.alongsideSinceMs >= STILL_THERE_MS) {
      this.saidStillThere = true;
      this.lastCalloutMs = nowMs;
      this.play("still_there", config);
    }
    return this.state;
  }

  /** Back to clear, the call in progress cut (a restart, a pause) */
  reset(): void {
    this.state = "clear";
    this.alongsideSinceMs = 0;
    this.saidStillThere = false;
    this.stopActive();
  }

  /** Follows the car audio's context, and loads the voice's clips the first time it is heard */
  private attach(out: SpotterOutput, voice: SpotterVoiceId): void {
    const ctx = out.context;
    if (ctx !== this.ctx) {
      this.stopActive();
      this.ctx = ctx;
      this.radio = null;
      this.buffers.clear();
      this.loading.clear();
      this.failed.clear();
    }
    if (!ctx || !out.output) return;
    if (!this.radio) this.radio = buildRadioChain(ctx, out.output);
    for (const key of CLIPS) this.preload(ctx, clipPath(voice, key));
  }

  private preload(ctx: AudioContext, url: string): void {
    if (this.buffers.has(url) || this.loading.has(url) || this.failed.has(url) || typeof fetch === "undefined") return;
    this.loading.add(url);
    void fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status} ${url}`))))
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => {
        // Kept only for the context it was decoded for
        if (ctx === this.ctx) this.buffers.set(url, buf);
      })
      .catch(() => {
        // Remember failed clips for this AudioContext so offline/missing clips aren't refetched every frame
        if (ctx === this.ctx) this.failed.add(url);
      })
      .finally(() => this.loading.delete(url));
  }

  private stopActive(): void {
    try {
      this.activeSource?.stop();
    } catch {
      // Already over
    }
    this.activeSource = null;
  }

  /** Says the clip, cutting the one before; a clip still loading is skipped (the next change of side is called) */
  private play(key: SpotterClipKey, config: SpotterConfig): void {
    const ctx = this.ctx;
    const radio = this.radio;
    const vol = Math.max(0, Math.min(1, config.volume));
    const buf = this.buffers.get(clipPath(config.voice, key));
    if (!ctx || !radio || !buf || vol <= 0 || ctx.state !== "running") return;
    this.stopActive();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = vol;
    src.connect(gain);
    if (config.radioFilter) {
      gain.connect(radio.input);
      playSquelch(ctx, radio.gain, vol);
    } else {
      gain.connect(radio.gain);
    }
    src.onended = () => {
      gain.disconnect();
      if (this.activeSource === src) this.activeSource = null;
    };
    this.activeSource = src;
    src.start();
  }
}

/** A team radio: 360 Hz to 3.1 kHz, a presence peak at 1.45 kHz, into a gain on the master output */
function buildRadioChain(ctx: AudioContext, output: AudioNode): { input: AudioNode; gain: GainNode } {
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 360;
  hp.Q.value = 0.8;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 3100;
  lp.Q.value = 0.9;
  const peak = ctx.createBiquadFilter();
  peak.type = "peaking";
  peak.frequency.value = 1450;
  peak.Q.value = 1.2;
  peak.gain.value = 4.5;
  const gain = ctx.createGain();
  hp.connect(lp);
  lp.connect(peak);
  peak.connect(gain);
  gain.connect(output);
  return { input: hp, gain };
}

/** The click of the radio opening: 32 ms of fading noise */
function playSquelch(ctx: AudioContext, dest: AudioNode, volume: number): void {
  const len = Math.floor(ctx.sampleRate * 0.032);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len) * 0.25;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = volume * 0.35;
  src.connect(g);
  g.connect(dest);
  src.onended = () => g.disconnect();
  src.start();
}
