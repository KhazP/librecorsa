/**
 * Positional sound of the other cars on the track: the AI field and the remote players (`opponent-audio.ts`).
 *
 * A fixed pool of voices is handed each frame to the cars nearest the camera, so a car keeps its voice while it stays
 * among them, and the pool never grows with the field (nothing to leak across restarts, car swaps or lobbies):
 *
 * - engine: the exterior on/off-load loops of that car's sound bank (`vf26-audio.ts` grid), crossfaded by its rpm and
 *   throttle. The decoded buffers are shared by every voice on the same bank; only the exterior grid is loaded.
 *   The AI field reports rpm and gear; a remote player's rpm comes from its rear-wheel speed through a nominal gearbox.
 * - tyres: the bank's exterior skid loop (or band-passed noise) when the car slides, from the angle between its heading
 *   and its velocity, and from the wheel speeds against the road speed (wheelspin, lock-ups).
 * - contact: a short scrape when the AI contact solver reports a touch.
 *
 * Each voice goes through a `PannerNode`, placed in the camera's frame (the listener stays at the origin facing -Z), so
 * the listener follows whichever camera is active. The nearest `HRTF_VOICES` use HRTF, the rest equal-power panning.
 * Distance: inverse roll-off plus an air-absorption low-pass. Doppler: Web Audio dropped its own, so the playback rate
 * of every loop is scaled by (c + v_listener) / (c - v_source) along the line between them.
 *
 * Everything goes into the player engine's master gain, so mute and pause apply; cockpit cameras hear the field
 * through a low-pass (the helmet and the bodywork in between).
 */

import * as THREE from 'three';
import type { CameraMode } from '@/types/f1';
import { withBasePath } from '@/lib/base-path';
import type { InterpolatedPeerState } from './multiplayer-sync';
import { INTERIOR_CAMERAS, type CarSoundSource } from './CarAudio';
import { LoopGrid, LoopVoice, lerpTable, type Vf26AudioManifest } from './vf26-audio';

/** Voices in the pool: the nearest cars get one, the rest are not heard */
export const OPPONENT_VOICES = 8;
/** The nearest voices pan with HRTF; the rest use the cheaper equal-power panner and play the on-load grid only */
export const HRTF_VOICES = 4;
/** Beyond this distance (m) a car is not heard at all */
const CULL_DISTANCE_M = 450;
/** Inverse roll-off: full level within this distance (m) */
const REF_DISTANCE_M = 7;
const SPEED_OF_SOUND_MS = 343;
/** Camera moves faster than this (m/s) are cuts (TV cameras, camera change): no Doppler from them, no glide */
const CAMERA_CUT_SPEED_MS = 140;
/** Most candidates looked at in a frame (preallocated) */
const MAX_CANDIDATES = 64;
/** Wheel radius used to turn wheel rpm into road speed (m) */
const WHEEL_RADIUS_M = 0.34;
const RPM_TO_RADS = (2 * Math.PI) / 60;

/** The exterior engine grid (and skid loop) of one bank, decoded once per audio context */
interface SharedBank {
  ready: boolean;
  onKeys: number[];
  onBuffers: AudioBuffer[];
  offKeys: number[];
  offBuffers: AudioBuffer[];
  skid: AudioBuffer | null;
  throttleCurve: [number, number][];
  rpmMin: number;
  rpmMax: number;
}

async function loadSharedBank(ctx: AudioContext, assetDir: string, bank: SharedBank): Promise<void> {
  try {
    const res = await fetch(withBasePath(`${assetDir}manifest.json`));
    if (!res.ok) throw new Error('no manifest');
    const m = (await res.json()) as Vf26AudioManifest;
    const ext = m.engine?.ext ?? [];
    if (ext.length === 0) throw new Error('no exterior engine');
    const decode = async (file: string): Promise<AudioBuffer> => {
      const r = await fetch(withBasePath(assetDir + file));
      if (!r.ok) throw new Error(file);
      return ctx.decodeAudioData(await r.arrayBuffer());
    };
    const on = ext.filter((e) => e.layer === 'on').sort((a, b) => a.rpm - b.rpm);
    const off = ext.filter((e) => e.layer === 'off').sort((a, b) => a.rpm - b.rpm);
    const [onBuffers, offBuffers, skid] = await Promise.all([
      Promise.all(on.map((e) => decode(e.file))),
      Promise.all(off.map((e) => decode(e.file))),
      m.skid?.ext ? decode(m.skid.ext.file).catch(() => null) : Promise.resolve(null),
    ]);
    const rpms = ext.map((e) => e.rpm);
    bank.onKeys = on.map((e) => e.rpm);
    bank.onBuffers = onBuffers;
    bank.offKeys = off.map((e) => e.rpm);
    bank.offBuffers = offBuffers;
    bank.skid = skid;
    bank.throttleCurve = m.throttleCurve?.ext ?? [];
    bank.rpmMin = Math.min(...rpms) * 0.75;
    bank.rpmMax = Math.max(...rpms) * 1.35;
    bank.ready = true;
  } catch {
    // Stays not ready: its voices keep to the synthetic skid and stay silent otherwise
  }
}

function pinkNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
  }
  return buf;
}

/** One pooled voice: engine grids, skid loop and scrape into a mono bus, an air-absorption low-pass and a panner */
class OpponentVoice {
  /** The car it plays (null: free) */
  public peerId: string | null = null;
  public sound: CarSoundSource | null = null;
  public rank = OPPONENT_VOICES;
  private bank: SharedBank | null = null;
  /** Whether the grids were built from the bank after it finished loading (built before that, they are empty) */
  private boundReady = false;
  private onGrid: LoopGrid | null = null;
  private offGrid: LoopGrid | null = null;
  private readonly input: GainNode;
  private readonly engineGain: GainNode;
  private readonly skidFilter: BiquadFilterNode;
  private skidVoice: LoopVoice | null = null;
  private readonly air: BiquadFilterNode;
  public readonly panner: PannerNode;
  private hrtf = false;

  // Per-car state, reset when the voice changes car
  private throttle = 0;
  private rpm = 0;
  private estGear = 1;
  private prevGear = 0;
  private shiftTimer = 0;
  private doppler = 1;
  private skid = 0;
  private prevContact = false;
  private scrapeCooldown = 0;
  private placed = false;

  constructor(
    private readonly ctx: AudioContext,
    destination: AudioNode,
    private readonly noise: AudioBuffer
  ) {
    // Mono point source: stereo loops are folded down before the panner
    this.input = ctx.createGain();
    this.input.channelCount = 1;
    this.input.channelCountMode = 'explicit';
    this.input.channelInterpretation = 'speakers';
    this.engineGain = ctx.createGain();
    this.engineGain.connect(this.input);
    this.skidFilter = ctx.createBiquadFilter();
    this.skidFilter.connect(this.input);
    this.air = ctx.createBiquadFilter();
    this.air.type = 'lowpass';
    this.air.frequency.value = 18000;
    this.air.Q.value = 0.5;
    this.panner = ctx.createPanner();
    this.panner.panningModel = 'equalpower';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = REF_DISTANCE_M;
    this.panner.rolloffFactor = 1;
    this.panner.maxDistance = 10000;
    this.input.connect(this.air);
    this.air.connect(this.panner);
    this.panner.connect(destination);
  }

  /** Hands the voice to a car (or frees it with null); the loops of the previous car fade out on their own */
  public assign(peerId: string | null): void {
    this.peerId = peerId;
    this.throttle = 0;
    // A freed voice keeps its last rpm so the fading loops hold their pitch (silence() plays them at this.rpm);
    // a new car starts from 0, which snaps to its first target
    if (peerId !== null) this.rpm = 0;
    this.estGear = 1;
    this.prevGear = 0;
    this.shiftTimer = 0;
    this.doppler = 1;
    this.skid = 0;
    this.prevContact = false;
    this.placed = false;
  }

  /** The bank this voice plays; rebuilds its grids when it changes (car swap, another player's car) */
  public bind(sound: CarSoundSource, bank: SharedBank): void {
    // Also rebuilt once a bank bound while loading becomes ready: its keys and buffers were empty at the first bind
    if (this.bank === bank && this.boundReady === bank.ready) return;
    this.sound = sound;
    this.bank = bank;
    this.boundReady = bank.ready;
    this.onGrid?.dispose();
    this.offGrid?.dispose();
    this.skidVoice?.dispose();
    this.onGrid = new LoopGrid(this.ctx, this.engineGain, bank.onKeys);
    this.offGrid = new LoopGrid(this.ctx, this.engineGain, bank.offKeys);
    bank.onKeys.forEach((k, i) => {
      const v = this.onGrid?.voiceFor(k);
      if (v) v.buffer = bank.onBuffers[i];
    });
    bank.offKeys.forEach((k, i) => {
      const v = this.offGrid?.voiceFor(k);
      if (v) v.buffer = bank.offBuffers[i];
    });
    this.skidVoice = new LoopVoice(this.ctx, this.skidFilter, 0);
    this.skidVoice.buffer = bank.skid ?? this.noise;
    if (bank.skid) {
      this.skidFilter.type = 'lowpass';
      this.skidFilter.frequency.value = 9000;
      this.skidFilter.Q.value = 0.5;
    } else {
      this.skidFilter.type = 'bandpass';
      this.skidFilter.frequency.value = 950;
      this.skidFilter.Q.value = 2.2;
    }
  }

  public setHrtf(on: boolean): void {
    if (on === this.hrtf) return;
    this.hrtf = on;
    this.panner.panningModel = on ? 'HRTF' : 'equalpower';
  }

  /**
   * Drives the voice for one frame.
   * @param rel     the car's position in the listener's frame (m; -Z ahead)
   * @param cut     the camera jumped: place the source at once instead of gliding there
   * @param doppler target playback-rate factor
   */
  public drive(
    p: InterpolatedPeerState,
    rel: THREE.Vector3,
    dist: number,
    doppler: number,
    cut: boolean,
    now: number,
    dt: number
  ): void {
    const bank = this.bank;
    const sound = this.sound;
    if (!bank?.ready || !sound || !this.onGrid || !this.offGrid) return;

    // Position (listener-relative, so the glide only smooths the frame steps)
    const pn = this.panner;
    if (pn.positionX) {
      if (cut || !this.placed) {
        pn.positionX.cancelScheduledValues(now);
        pn.positionY.cancelScheduledValues(now);
        pn.positionZ.cancelScheduledValues(now);
        pn.positionX.setValueAtTime(rel.x, now);
        pn.positionY.setValueAtTime(rel.y, now);
        pn.positionZ.setValueAtTime(rel.z, now);
      } else {
        pn.positionX.setTargetAtTime(rel.x, now, 0.015);
        pn.positionY.setTargetAtTime(rel.y, now, 0.015);
        pn.positionZ.setTargetAtTime(rel.z, now, 0.015);
      }
    } else {
      pn.setPosition(rel.x, rel.y, rel.z);
    }
    // Air absorption: the far car loses its top end first
    this.air.frequency.setTargetAtTime(Math.max(1400, 18000 / (1 + dist / 70)), now, 0.05);

    this.doppler = cut || !this.placed ? doppler : this.doppler + (doppler - this.doppler) * Math.min(1, dt / 0.06);
    this.placed = true;

    // Pedal: fast attack, slower release (as the player's bank smooths it)
    const thr = THREE.MathUtils.clamp(p.throttle, 0, 1);
    this.throttle += (thr - this.throttle) * Math.min(1, dt * (thr > this.throttle ? 18 : 10));

    // Road speed from the driven (rear) wheels, so wheelspin revs the engine
    const v = Math.hypot(p.linearVelocity.x, p.linearVelocity.z);
    const rearWheelMs = 0.5 * (Math.abs(p.wheelRPMs[2]) + Math.abs(p.wheelRPMs[3])) * RPM_TO_RADS * WHEEL_RADIUS_M;

    // Engine rpm in the recording's range: the car's own when it reports it, else a nominal gearbox
    let targetRpm: number;
    let gear: number;
    if (p.rpm !== undefined && p.rpm > 0) {
      targetRpm = p.rpm * (sound.physicsLimiterRpm ? sound.limiterRpm / sound.physicsLimiterRpm : 1);
      gear = p.gear ?? 0;
    } else {
      targetRpm = this.estimateRpm(Math.max(v, rearWheelMs), sound.limiterRpm);
      gear = this.estGear;
    }
    if (gear !== this.prevGear) {
      if (this.prevGear > 0 && gear > this.prevGear) this.shiftTimer = 0.06;
      this.prevGear = gear;
    }
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    targetRpm = THREE.MathUtils.clamp(targetRpm, bank.rpmMin, bank.rpmMax);
    this.rpm = this.rpm === 0 ? targetRpm : this.rpm + (targetRpm - this.rpm) * Math.min(1, dt / 0.03);

    const onness = bank.throttleCurve.length ? lerpTable(bank.throttleCurve, this.throttle) : this.throttle;
    const cut01 = this.shiftTimer > 0 ? 0.55 : 1;
    const full = this.rank < HRTF_VOICES;
    // A far voice plays the on-load grid only, held up a little off throttle so a lift does not drop it out
    const wOn = (full ? Math.sin(onness * Math.PI * 0.5) : Math.max(0.6, Math.sin(onness * Math.PI * 0.5))) * cut01;
    const wOff = full ? Math.cos(onness * Math.PI * 0.5) * (this.shiftTimer > 0 ? 0.75 : 1) : 0;
    // (Cars past CULL_DISTANCE_M never get a voice: they are dropped when the candidates are gathered)
    this.onGrid.update(this.rpm, wOn, true, now, dt, 0.03, 0.02, this.doppler);
    this.offGrid.update(this.rpm, wOff, true, now, dt, 0.03, 0.02, this.doppler);

    // Tyres: slip angle between heading and travel, and the wheels against the road (wheelspin, lock-ups)
    let skidTarget = 0;
    if (v > 6) {
      const fx = 2 * (p.quaternion.x * p.quaternion.z + p.quaternion.w * p.quaternion.y);
      const fz = 1 - 2 * (p.quaternion.x * p.quaternion.x + p.quaternion.y * p.quaternion.y);
      const fl = Math.hypot(fx, fz) || 1;
      const cosA = (fx * p.linearVelocity.x + fz * p.linearVelocity.z) / (fl * v);
      const slipAngle = Math.acos(THREE.MathUtils.clamp(Math.abs(cosA), -1, 1));
      let longSlip = 0;
      for (let i = 0; i < 4; i++) {
        const wheelMs = Math.abs(p.wheelRPMs[i]) * RPM_TO_RADS * WHEEL_RADIUS_M;
        longSlip = Math.max(longSlip, Math.abs(wheelMs - v) / Math.max(8, v));
      }
      skidTarget = Math.max(
        THREE.MathUtils.clamp((slipAngle - 0.07) / 0.18, 0, 1),
        THREE.MathUtils.clamp((longSlip - 0.12) / 0.3, 0, 1)
      ) * Math.min(1, v / 15);
    }
    this.skid += (skidTarget - this.skid) * Math.min(1, dt / (skidTarget > this.skid ? 0.04 : 0.12));
    const skidLevel = (bank.skid ? 0.5 : 0.9) * Math.sqrt(this.skid);
    this.skidVoice?.set(full ? skidLevel : 0, (0.9 + 0.2 * this.skid) * this.doppler, now, dt, 0.05);

    // Contact scrape on the first frame of a touch
    this.scrapeCooldown = Math.max(0, this.scrapeCooldown - dt);
    const contact = p.contact === true;
    if (contact && !this.prevContact && this.scrapeCooldown === 0 && dist < 120) {
      this.scrape(Math.min(1, 0.35 + v / 70), now);
      this.scrapeCooldown = 0.35;
    }
    this.prevContact = contact;
  }

  /** Lets the loops fade and stop (free voice, car out of range, sound off) */
  public silence(now: number, dt: number): void {
    this.onGrid?.update(this.rpm || 1, 0, true, now, dt, 0.05, 0.02, this.doppler);
    this.offGrid?.update(this.rpm || 1, 0, true, now, dt, 0.05, 0.02, this.doppler);
    this.skidVoice?.set(0, 1, now, dt, 0.05);
  }

  /** A remote player's engine speed from its road speed through a nominal gearbox (F1: 8 gears, GT3: 6) */
  private estimateRpm(speedMs: number, limiterRpm: number): number {
    const gt3 = limiterRpm < 9500;
    const gears = gt3 ? 6 : 8;
    const vMax = gt3 ? 78 : 95;
    const step = gt3 ? 0.786 : 0.82;
    const topOf = (g: number) => vMax * Math.pow(step, gears - g);
    let g = THREE.MathUtils.clamp(this.estGear, 1, gears);
    if (g < gears && speedMs / topOf(g) > 0.96) g++;
    else if (g > 1 && speedMs / topOf(g) < 0.62) g--;
    this.estGear = g;
    return limiterRpm * Math.max(0.32, Math.min(1, speedMs / topOf(g)));
  }

  /** Short band-passed noise burst with a thud under it */
  private scrape(intensity: number, now: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.5;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400 + Math.random() * 900;
    bp.Q.value = 1.3;
    const g = ctx.createGain();
    const len = 0.18 + 0.25 * intensity;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(1.6 * intensity, now + 0.008);
    g.gain.setTargetAtTime(0, now + 0.03, len / 3);
    src.connect(bp).connect(g).connect(this.input);
    src.start(now, Math.random() * (this.noise.duration - 1));
    src.stop(now + len + 0.3);
    const thud = ctx.createOscillator();
    thud.frequency.setValueAtTime(95, now);
    thud.frequency.exponentialRampToValueAtTime(45, now + 0.12);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.9 * intensity, now);
    tg.gain.setTargetAtTime(0, now + 0.01, 0.04);
    thud.connect(tg).connect(this.input);
    thud.start(now);
    thud.stop(now + 0.3);
    src.onended = () => {
      src.disconnect();
      bp.disconnect();
      g.disconnect();
    };
    thud.onended = () => {
      thud.disconnect();
      tg.disconnect();
    };
  }

  public dispose(): void {
    this.onGrid?.dispose();
    this.offGrid?.dispose();
    this.skidVoice?.dispose();
    this.onGrid = this.offGrid = null;
    this.skidVoice = null;
    this.bank = null;
    this.engineGain.disconnect();
    this.skidFilter.disconnect();
    this.input.disconnect();
    this.air.disconnect();
    this.panner.disconnect();
  }
}

/** What the opponent sound needs from the frame */
export interface OpponentAudioFrame {
  /** The player's audio context and master gain (`CarAudioEngine.context` / `.output`); null before the first key */
  context: AudioContext | null;
  output: AudioNode | null;
  /** False while the sound is off (muted, paused, menus, replay): every voice fades out */
  active: boolean;
  camera: THREE.Camera;
  cameraMode: CameraMode;
  /** The cars to hear: AI field and remote players (ghosts are skipped) */
  peers: readonly InterpolatedPeerState[];
  /** The sound bank of a car */
  soundFor: (peer: InterpolatedPeerState) => CarSoundSource;
  dt: number;
}

export interface OpponentVoiceStats {
  peerId: string;
  dist: number;
  /** Pan -1 (left) .. 1 (right) and the side it is on (ahead / behind) */
  pan: number;
  behind: boolean;
  doppler: number;
  hrtf: boolean;
}

export class OpponentAudio {
  private ctx: AudioContext | null = null;
  private output: AudioNode | null = null;
  private bus: GainNode | null = null;
  private interiorFilter: BiquadFilterNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private voices: OpponentVoice[] = [];
  private banks = new Map<string, SharedBank>();
  private interiorMix = 0;

  // Listener state
  private readonly listenerPos = new THREE.Vector3();
  private readonly listenerVel = new THREE.Vector3();
  private readonly invQ = new THREE.Quaternion();
  private hasListener = false;

  // Frame scratch (no allocations per frame)
  private readonly cand: (InterpolatedPeerState | null)[] = new Array(MAX_CANDIDATES).fill(null);
  private readonly candD = new Float64Array(MAX_CANDIDATES);
  private readonly taken = new Uint8Array(MAX_CANDIDATES);
  private readonly rel = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly stats: OpponentVoiceStats[] = [];

  /** Per-frame update; one call drives every voice */
  public update(f: OpponentAudioFrame): void {
    if (f.context !== this.ctx || f.output !== this.output) this.rebuild(f.context, f.output);
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.bus) return;
    const now = ctx.currentTime;
    const dt = THREE.MathUtils.clamp(f.dt, 1e-4, 0.1);

    // Listener: the active camera. A jump faster than any car is a cut (TV camera switch, camera change).
    const cam = f.camera;
    let cut = false;
    if (!this.hasListener) {
      this.listenerPos.copy(cam.position);
      this.listenerVel.set(0, 0, 0);
      this.hasListener = true;
      cut = true;
    } else {
      this.tmp.copy(cam.position).sub(this.listenerPos).divideScalar(dt);
      if (this.tmp.lengthSq() > CAMERA_CUT_SPEED_MS * CAMERA_CUT_SPEED_MS) {
        cut = true;
        this.listenerVel.set(0, 0, 0);
      } else {
        this.listenerVel.lerp(this.tmp, Math.min(1, dt / 0.12));
      }
      this.listenerPos.copy(cam.position);
    }
    this.invQ.copy(cam.quaternion).invert();

    // Cockpit cameras hear the field through the helmet and the bodywork
    const interior = INTERIOR_CAMERAS.has(f.cameraMode) ? 1 : 0;
    this.interiorMix += (interior - this.interiorMix) * Math.min(1, dt / 0.12);
    this.interiorFilter?.frequency.setTargetAtTime(18000 - this.interiorMix * 15000, now, 0.03);
    this.bus.gain.setTargetAtTime(0.85 - this.interiorMix * 0.35, now, 0.03);

    // The nearest cars, nearest first (insertion into a fixed-size list)
    let n = 0;
    if (f.active) {
      for (const p of f.peers) {
        if (p.ghost) continue;
        const d = p.position.distanceTo(this.listenerPos);
        if (!(d < CULL_DISTANCE_M)) continue;
        if (n < OPPONENT_VOICES) n++;
        else if (d >= this.candD[n - 1]) continue;
        let i = n - 1;
        while (i > 0 && this.candD[i - 1] > d) {
          this.cand[i] = this.cand[i - 1];
          this.candD[i] = this.candD[i - 1];
          i--;
        }
        this.cand[i] = p;
        this.candD[i] = d;
      }
    }

    // A voice keeps its car while that car stays among the nearest; the others are freed and handed out again
    this.taken.fill(0, 0, n);
    for (const v of this.voices) {
      let found = -1;
      if (v.peerId !== null) {
        for (let i = 0; i < n; i++) {
          if (!this.taken[i] && this.cand[i]?.peerId === v.peerId) {
            found = i;
            break;
          }
        }
      }
      if (found >= 0) {
        this.taken[found] = 1;
        v.rank = found;
      } else if (v.peerId !== null) {
        v.assign(null);
        v.rank = OPPONENT_VOICES;
      }
    }
    for (let i = 0; i < n; i++) {
      if (this.taken[i]) continue;
      const free = this.voices.find((v) => v.peerId === null);
      if (!free) break;
      free.assign(this.cand[i]?.peerId ?? null);
      free.rank = i;
      this.taken[i] = 1;
    }

    this.stats.length = 0;
    for (const v of this.voices) {
      const idx = v.peerId === null ? -1 : v.rank;
      const p = idx >= 0 ? this.cand[idx] : null;
      if (!p) {
        v.silence(now, dt);
        continue;
      }
      const sound = f.soundFor(p);
      const bank = this.bankFor(sound.assetDir);
      v.bind(sound, bank);
      v.setHrtf(v.rank < HRTF_VOICES);
      if (!bank.ready) continue;

      const dist = this.candD[idx];
      this.rel.copy(p.position).sub(this.listenerPos);
      // Doppler along the line from the listener to the car
      let doppler = 1;
      if (dist > 0.5) {
        const ux = this.rel.x / dist, uy = this.rel.y / dist, uz = this.rel.z / dist;
        const vSrc = -(p.linearVelocity.x * ux + p.linearVelocity.y * uy + p.linearVelocity.z * uz);
        const vLis = this.listenerVel.x * ux + this.listenerVel.y * uy + this.listenerVel.z * uz;
        doppler = THREE.MathUtils.clamp(
          (SPEED_OF_SOUND_MS + vLis) / (SPEED_OF_SOUND_MS - Math.min(vSrc, SPEED_OF_SOUND_MS * 0.8)),
          0.6,
          1.7
        );
      }
      this.rel.applyQuaternion(this.invQ);
      v.drive(p, this.rel, dist, doppler, cut, now, dt);
      if (this.debug) {
        this.stats.push({
          peerId: p.peerId,
          dist: Math.round(dist * 10) / 10,
          pan: Math.round((this.rel.x / Math.max(1, Math.hypot(this.rel.x, this.rel.z))) * 100) / 100,
          behind: this.rel.z > 0,
          doppler: Math.round(doppler * 1000) / 1000,
          hrtf: v.rank < HRTF_VOICES,
        });
      }
    }
  }

  /** Collects `voiceStats()` each frame (dev tooling) */
  public debug = false;

  /** The voices in use last frame (with `debug` on) */
  public voiceStats(): readonly OpponentVoiceStats[] {
    return this.stats;
  }

  /** Number of banks decoded and voices in the pool (dev tooling) */
  public get footprint(): { banks: number; voices: number; busy: number } {
    return { banks: this.banks.size, voices: this.voices.length, busy: this.voices.filter((v) => v.peerId).length };
  }

  private bankFor(assetDir: string): SharedBank {
    let bank = this.banks.get(assetDir);
    if (!bank) {
      bank = {
        ready: false,
        onKeys: [],
        onBuffers: [],
        offKeys: [],
        offBuffers: [],
        skid: null,
        throttleCurve: [],
        rpmMin: 3000,
        rpmMax: 16000,
      };
      this.banks.set(assetDir, bank);
      if (this.ctx) void loadSharedBank(this.ctx, assetDir, bank);
    }
    return bank;
  }

  /** (Re)builds the graph on a new audio context; the old one's nodes and decoded banks are dropped */
  private rebuild(ctx: AudioContext | null, output: AudioNode | null): void {
    this.teardown();
    this.ctx = ctx;
    this.output = output;
    if (!ctx || !output) return;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 10;
    limiter.ratio.value = 4;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.15;
    limiter.connect(output);
    const interiorFilter = ctx.createBiquadFilter();
    interiorFilter.type = 'lowpass';
    interiorFilter.frequency.value = 18000;
    interiorFilter.Q.value = 0.6;
    interiorFilter.connect(limiter);
    const bus = ctx.createGain();
    bus.gain.value = 0.85;
    bus.connect(interiorFilter);
    this.limiter = limiter;
    this.interiorFilter = interiorFilter;
    this.bus = bus;
    // The listener sits at the origin facing -Z; the voices are placed in the camera's frame
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = 0;
      l.positionY.value = 0;
      l.positionZ.value = 0;
      l.forwardX.value = 0;
      l.forwardY.value = 0;
      l.forwardZ.value = -1;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      l.setPosition(0, 0, 0);
      l.setOrientation(0, 0, -1, 0, 1, 0);
    }
    const noise = pinkNoise(ctx, 3);
    for (let i = 0; i < OPPONENT_VOICES; i++) this.voices.push(new OpponentVoice(ctx, bus, noise));
  }

  private teardown(): void {
    for (const v of this.voices) v.dispose();
    this.voices = [];
    this.banks.clear();
    this.bus?.disconnect();
    this.interiorFilter?.disconnect();
    this.limiter?.disconnect();
    this.bus = null;
    this.interiorFilter = null;
    this.limiter = null;
    this.hasListener = false;
    this.cand.fill(null);
  }

  /** Frees every voice at once (track switch, leaving a lobby); the decoded banks are kept for the next race */
  public reset(): void {
    for (const v of this.voices) v.assign(null);
    this.hasListener = false;
    this.cand.fill(null);
  }

  public dispose(): void {
    this.teardown();
    this.ctx = null;
    this.output = null;
  }
}
