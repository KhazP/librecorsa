import * as THREE from "three";
import type { InterpolatedPeerState } from "./multiplayer-sync";

export type SpotterSideState = "clear" | "left" | "right" | "both";
export type SpotterVoiceId = "jim" | "clare" | "geoffrey";
export type SpotterClipKey =
  | "car_left"
  | "car_right"
  | "three_wide"
  | "clear_left"
  | "clear_right"
  | "clear"
  | "still_there";

export interface SpotterConfig {
  enabled: boolean;
  volume: number; // 0..1
  voice?: SpotterVoiceId;
  radioFilter?: boolean;
}

const ENTER_LONG_M = 5.4;
const EXIT_LONG_M = 6.2;
const ENTER_LAT_M = 3.6;
const EXIT_LAT_M = 4.3;
const MIN_CALLOUT_GAP_MS = 1600;
const STILL_THERE_MS = 2800;

function clipPath(voice: SpotterVoiceId, key: SpotterClipKey): string {
  const prefix = voice === "jim" ? "/audio/spotter" : `/audio/spotter/${voice}`;
  return `${prefix}/${key}.wav`;
}

/**
 * iRacing-style contextual racing spotter.
 * Uses relative 3D vehicle position projected into the player's local car frame
 * with hysteresis and cooldowns to avoid flickering or repetitive callouts.
 * Plays pre-recorded MIT-licensed spotter voice clips with an optional Web Audio pit-radio filter.
 */
export class SpotterEngine {
  private state: SpotterSideState = "clear";
  private lastCalloutMs = 0;
  private alongsideSinceMs = 0;
  private saidStillThere = false;
  private readonly rel = new THREE.Vector3();
  private readonly invQ = new THREE.Quaternion();

  private audioCtx: AudioContext | null = null;
  private radioChain: { input: AudioNode; gain: GainNode } | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly loading = new Set<string>();
  private activeSource: AudioBufferSourceNode | null = null;
  private activeFallback: HTMLAudioElement | null = null;

  private ensureAudioContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.audioCtx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return null;
      this.audioCtx = new Ctx();
    }
    if (this.audioCtx.state === "suspended") {
      void this.audioCtx.resume().catch(() => {});
    }
    if (!this.radioChain && this.audioCtx) {
      const ctx = this.audioCtx;
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
      gain.connect(ctx.destination);
      this.radioChain = { input: hp, gain };
    }
    return this.audioCtx;
  }

  private playRadioClick(ctx: AudioContext, dest: AudioNode, volume: number): void {
    const dur = 0.032;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      ch[i] = (Math.random() * 2 - 1) * (1 - i / len) * 0.25;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = Math.max(0, Math.min(1, volume)) * 0.35;
    src.connect(g);
    g.connect(dest);
    src.start();
  }

  private preloadClip(url: string, ctx: AudioContext): void {
    if (this.buffers.has(url) || this.loading.has(url)) return;
    this.loading.add(url);
    void fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("fetch failed"))))
      .then((ab) => ctx.decodeAudioData(ab))
      .then((decoded) => {
        this.buffers.set(url, decoded);
      })
      .catch(() => {})
      .finally(() => {
        this.loading.delete(url);
      });
  }

  reset(): void {
    this.state = "clear";
    this.alongsideSinceMs = 0;
    this.saidStillThere = false;
    try {
      this.activeSource?.stop();
    } catch {
      // ignore already stopped
    }
    this.activeSource = null;
    if (this.activeFallback) {
      this.activeFallback.pause();
      this.activeFallback.currentTime = 0;
      this.activeFallback = null;
    }
  }

  update(
    nowMs: number,
    playerPos: THREE.Vector3,
    playerQuat: THREE.Quaternion,
    playerSpeedMs: number,
    peers: readonly InterpolatedPeerState[],
    config: SpotterConfig,
  ): SpotterSideState {
    if (!config.enabled || playerSpeedMs < 5) {
      if (this.state !== "clear") this.state = "clear";
      return this.state;
    }

    this.invQ.copy(playerQuat).invert();
    const longThresh = this.state === "clear" ? ENTER_LONG_M : EXIT_LONG_M;
    const latThresh = this.state === "clear" ? ENTER_LAT_M : EXIT_LAT_M;

    let hasLeft = false;
    let hasRight = false;

    for (let i = 0; i < peers.length; i++) {
      const p = peers[i];
      if (p.ghost || p.stale || p.passThrough) continue;
      this.rel.copy(p.position).sub(playerPos).applyQuaternion(this.invQ);
      if (Math.abs(this.rel.z) <= longThresh && Math.abs(this.rel.x) <= latThresh) {
        if (this.rel.x >= 0) hasLeft = true;
        else hasRight = true;
      }
    }

    const next: SpotterSideState =
      hasLeft && hasRight ? "both" : hasLeft ? "left" : hasRight ? "right" : "clear";

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

  private play(clipKey: SpotterClipKey, config: SpotterConfig): void {
    const vol = Math.max(0, Math.min(1, config.volume));
    if (vol <= 0 || typeof window === "undefined") return;
    const voice = config.voice ?? "jim";
    const url = clipPath(voice, clipKey);
    const ctx = this.ensureAudioContext();
    const buf = this.buffers.get(url);

    if (ctx && buf) {
      try {
        try {
          this.activeSource?.stop();
        } catch {
          // ignore
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        if (config.radioFilter !== false && this.radioChain) {
          this.radioChain.gain.gain.value = vol;
          this.playRadioClick(ctx, ctx.destination, vol);
          src.connect(this.radioChain.input);
        } else {
          const g = ctx.createGain();
          g.gain.value = vol;
          src.connect(g);
          g.connect(ctx.destination);
        }
        this.activeSource = src;
        src.start();
        return;
      } catch {
        // fall through to HTMLAudioElement
      }
    }

    if (ctx) this.preloadClip(url, ctx);
    if (typeof Audio === "undefined") return;
    try {
      if (this.activeFallback) {
        this.activeFallback.pause();
        this.activeFallback.currentTime = 0;
      }
      const audio = new Audio(url);
      audio.volume = vol;
      this.activeFallback = audio;
      void audio.play().catch(() => {});
    } catch {
      // ignore audio errors
    }
  }
}
