/**
 * Contact-patch, chassis and brake sounds that CarAudio's own layers do not cover: the rolling roar of the tyres on
 * asphalt, the dampers' thump and the chassis' rattle, brake squeal, and the clicks of stones thrown off dirty tyres
 * into the wheel arches. CarAudio owns the rig, feeds it the player car's telemetry once a frame and mixes it into
 * its compressor; tyre squeal, scrub, kerb rumble and the grass / gravel layers stay CarAudio's.
 */

import type { TelemetryData, VehicleModelId } from '@/types/f1';

/**
 * The closed-wheel cars: their shell muffles what reaches an interior camera, and their steel discs squeal far more
 * readily than the open-wheelers' carbon-ceramic ones
 */
const GT_MODELS: ReadonlySet<string> = new Set<VehicleModelId>([
  'amg-gt3',
  'liana',
  'mtr-496r',
  'lc-lmdh',
  'nissan-r33-jgtc',
  'nissan-r32-jtcc',
]);

/** Squeal pitch factor per wheel (FL, FR, RL, RR): the larger front discs ring a little lower */
const BRAKE_PITCH = [0.49, 0.49, 0.54, 0.54] as const;

/** 0 at `a`, 1 at `b`, clamped (0 for NaN) */
function ramp(x: number, a: number, b: number): number {
  const u = (x - a) / (b - a);
  return u > 0 ? (u < 1 ? u : 1) : 0;
}

/** A smoothing step `k` tuned per 60 Hz frame, for a frame of `dt` seconds (CarAudio's convention) */
const per60 = (k: number, dt: number) => 1 - Math.pow(1 - k, dt * 60);

/** A telemetry reading, `fallback` when absent or non-finite, so a physics blow-up cannot stick in the rig's state */
const num = (x: number | undefined, fallback = 0): number => (Number.isFinite(x) ? (x as number) : fallback);

/** AudioParams throw on non-finite values, which would take the frame loop down with them */
function setTarget(param: AudioParam, value: number, at: number, tau: number): void {
  if (Number.isFinite(value)) param.setTargetAtTime(value, at, tau);
}

export class ContactAcousticsRig {
  private readonly ctx: AudioContext;
  private readonly out: BiquadFilterNode;
  private readonly roarFilter: BiquadFilterNode;
  private readonly roarGain: GainNode;
  private readonly thumpOsc: OscillatorNode;
  private readonly thumpGain: GainNode;
  private readonly rattleGain: GainNode;
  private readonly debrisGain: GainNode;
  private readonly brakeOsc: OscillatorNode;
  private readonly brakeHarmonicOsc: OscillatorNode;
  private readonly brakeFilter: BiquadFilterNode;
  private readonly brakeGain: GainNode;

  private fresh = true;
  private lastTime = -Infinity;
  private lastDistanceM = NaN;
  private readonly prevShockVel = [0, 0, 0, 0];
  /** Smoothed |shock acceleration| per wheel (m/s²) */
  private readonly shockAccel = [0, 0, 0, 0];
  private readonly roarFade = [0, 0, 0, 0];
  private readonly brakeLevel = [0, 0, 0, 0];
  private readonly debrisPhase = [0, 0, 0, 0];

  constructor(ctx: AudioContext, destination: AudioNode, noise: AudioBuffer) {
    this.ctx = ctx;

    this.out = ctx.createBiquadFilter();
    this.out.type = 'lowpass';
    this.out.frequency.value = 14000;
    this.out.Q.value = 0.7;
    this.out.connect(destination);

    // CarAudio's scrub, gravel and wind loop this buffer from its start; these loops start elsewhere in it, since
    // sample-aligned copies of one noise add up coherently wherever their bands overlap (the roar's and the wind's)
    const noiseVoice = (hz: number, q: number, startAt: number): [BiquadFilterNode, GainNode] => {
      const source = ctx.createBufferSource();
      source.buffer = noise;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = hz;
      filter.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(filter).connect(gain).connect(this.out);
      source.start(0, startAt * noise.duration);
      return [filter, gain];
    };
    [this.roarFilter, this.roarGain] = noiseVoice(230, 1.1, 0.25);
    this.rattleGain = noiseVoice(2150, 3.6, 0.5)[1];
    this.debrisGain = noiseVoice(3400, 4.5, 0.75)[1];

    this.thumpOsc = ctx.createOscillator();
    this.thumpOsc.type = 'sine';
    this.thumpOsc.frequency.value = 64;
    const thumpFilter = ctx.createBiquadFilter();
    thumpFilter.type = 'lowpass';
    thumpFilter.frequency.value = 125;
    this.thumpGain = ctx.createGain();
    this.thumpGain.gain.value = 0;
    this.thumpOsc.connect(thumpFilter).connect(this.thumpGain).connect(this.out);
    this.thumpOsc.start();

    // A sine with an inharmonic partial a tritone above it, through a narrow band: the ring of a disc
    this.brakeOsc = ctx.createOscillator();
    this.brakeOsc.type = 'sine';
    this.brakeOsc.frequency.value = 3650;
    this.brakeHarmonicOsc = ctx.createOscillator();
    this.brakeHarmonicOsc.type = 'triangle';
    this.brakeHarmonicOsc.frequency.value = 5180;
    const harmonicGain = ctx.createGain();
    harmonicGain.gain.value = 0.39;
    this.brakeFilter = ctx.createBiquadFilter();
    this.brakeFilter.type = 'bandpass';
    this.brakeFilter.frequency.value = 3800;
    this.brakeFilter.Q.value = 11;
    this.brakeGain = ctx.createGain();
    this.brakeGain.gain.value = 0;
    this.brakeOsc.connect(this.brakeFilter);
    this.brakeHarmonicOsc.connect(harmonicGain).connect(this.brakeFilter);
    this.brakeFilter.connect(this.brakeGain).connect(this.out);
    this.brakeOsc.start();
    this.brakeHarmonicOsc.start();
  }

  /** Drop the history, for the breaks `update` cannot see itself (another car, a suspended context) */
  public reset(): void {
    this.fresh = true;
  }

  /** One frame: `dt` is the frame time (s), `interior` whether the camera sits in or on the car */
  public update(t: TelemetryData, dt: number, interior: boolean): void {
    const now = this.ctx.currentTime;
    dt = num(dt);
    const gt = GT_MODELS.has(t.f12026?.carId ?? '');
    const speed = Math.max(0, num(t.speedKmh) / 3.6);
    const pedal = Math.min(1, Math.max(0, num(t.brake)));
    const frontBias = Math.min(0.8, Math.max(0.3, num(t.liveTuner?.brakeBiasPct, 56) / 100));

    // Frames skipped (paused, muted) or a jump along the track (teleport, restart; the lap line too, harmlessly):
    // the history is another moment's, so start from this frame instead of differentiating across the gap
    const fresh =
      this.fresh ||
      now - this.lastTime > dt + 0.1 ||
      Math.abs(t.trackDistanceM - this.lastDistanceM) > 5 + 2 * speed * dt;
    this.fresh = false;
    this.lastTime = now;
    this.lastDistanceM = t.trackDistanceM;
    const ease = (k: number) => (fresh ? 1 : per60(k, dt));

    let roar = 0;
    let roarTone = 0;
    let thump = 0;
    let thumpWheel = 0;
    let rattle = 0;
    let brake = 0;
    let brakeWheel = 0;

    for (let i = 0; i < 4; i++) {
      // The tread's own speed: it runs ahead of the car in wheelspin and stops when the wheel locks
      const tread = speed * Math.abs(1 + num(t.wheelSlipRatios[i]));

      // Road roar on asphalt only: 'runoff' also stands for the gravel traps
      const onAsphalt = t.wheelSurfaces[i] === 'asphalt';
      this.roarFade[i] += ((onAsphalt ? 1 : 0) - this.roarFade[i]) * ease(onAsphalt ? 1 / 6 : 1 / 3);
      const roll = (Math.max(speed, tread) * 0.015) ** 1.1;
      const slide = ramp(num(t.tireSlipRatio[i]), 0, 5);
      const load = 0.2 + 0.2 * ramp(num(t.wheelLoadsN[i]), 0, 13000);
      roar += load * (1 - 0.33 * slide * slide) * roll * this.roarFade[i];
      roarTone += Math.min(1, roll ** 1.2);

      // Damper thump and chassis rattle
      const shockVel = num(t.suspensionVelocityMs[i]);
      const damper = Math.min(1, Math.abs(shockVel) / 10) ** 0.7;
      if (damper > thump) {
        thump = damper;
        thumpWheel = i;
      }
      if (fresh) {
        this.shockAccel[i] = 0;
      } else if (dt > 1e-6) {
        const accel = Math.abs((shockVel - this.prevShockVel[i]) / dt);
        this.shockAccel[i] += (accel - this.shockAccel[i]) * per60(accel > this.shockAccel[i] ? 0.5 : 0.06, dt);
      }
      this.prevShockVel[i] = shockVel;
      rattle = Math.max(rattle, Math.min(1, this.shockAccel[i] / 80) ** 2);

      // Brake squeal: a disc rings under light to moderate pressure, not clamped hard, and only within a band of
      // disc temperature
      const temp = num(t.brakeTempsC[i]);
      const tempGate =
        temp > 180 && temp < 750 ? Math.min(0.25 + 0.75 * ramp(temp, 180, 250), 1 - 0.75 * ramp(temp, 650, 750)) : 0;
      const rolling = ramp(tread, 0, 2.4);
      const pedalWindow = ((gt ? 2 : 0.8) * rolling * (1 - ramp(pedal, 0.2, 0.6))) ** 0.8 * ramp(pedal, 0.05, 0.2);
      const share = i < 2 ? frontBias : 1 - frontBias;
      const target = pedal * share * pedalWindow * tempGate;
      this.brakeLevel[i] = Math.min(1, Math.max(0, this.brakeLevel[i] + (target - this.brakeLevel[i]) * ease(1 / 6)));
      const level = this.brakeLevel[i];
      // Off the pedal the ring dies with the square of the level rather than hanging on
      const squeal = 0.6 * rolling * tempGate * level * (level + (1 - level) * ramp(pedal, 0, 0.05));
      if (squeal >= brake) {
        brake = squeal;
        brakeWheel = i;
      }

      // Debris: stones a tyre picked up off track flick into the wheel arch
      const dirt = Math.min(1, Math.max(0, num(t.tireDirtyLevel?.[i])));
      if (dirt > 0.05 && speed > 1) {
        const peak = Math.min(0.05, Math.max(0.004, ramp(dirt, 0.05, 1) * (0.15 + 0.85 * ramp(speed, 1, 55)) * 0.045));
        const rateHz = (3 + 35 * ramp(dirt, 0.05, 1)) * (0.2 + 0.8 * ramp(speed, 1, 60));
        let phase = (fresh ? 0 : this.debrisPhase[i]) + rateHz * dt;
        // Each stone at its own moment within the frame, played a frame late: the rate holds at any frame rate
        while (phase >= 1) {
          phase -= 1;
          const at = now + dt - phase / rateHz;
          this.debrisGain.gain.setValueAtTime(peak, at);
          this.debrisGain.gain.setTargetAtTime(0, at + 0.004, 0.008);
        }
        this.debrisPhase[i] = phase;
      } else {
        this.debrisPhase[i] = 0;
      }
    }

    setTarget(this.out.frequency, !interior ? 14000 : gt ? 3800 : 11960, now, 0.03);

    setTarget(this.roarFilter.frequency, 244 + 70 * (roarTone / 4), now, 0.03);
    setTarget(this.roarGain.gain, 0.25 * roar * (interior ? 0.65 : 1) * 0.042, now, 0.025);

    // 57–73 Hz by corner, so the four dampers are told apart
    setTarget(this.thumpOsc.frequency, 52 * (1.1 + 0.1 * thumpWheel), now, 0.018);
    setTarget(this.thumpGain.gain, thump * 0.055, now, 0.018);
    setTarget(this.rattleGain.gain, rattle * 0.048, now, 0.015);

    const pedalPitch = 0.015 * ramp(pedal, 0.2, 0.8);
    const brakeHz = Math.min(5200, Math.max(2600, 3400 + (BRAKE_PITCH[brakeWheel] + pedalPitch) * 1200));
    setTarget(this.brakeOsc.frequency, brakeHz, now, 0.022);
    setTarget(this.brakeHarmonicOsc.frequency, brakeHz * 1.414, now, 0.022);
    setTarget(this.brakeFilter.frequency, brakeHz, now, 0.022);
    setTarget(this.brakeGain.gain, brake * (interior ? 0.8 : 1) * 0.026, now, 0.022);
  }
}
