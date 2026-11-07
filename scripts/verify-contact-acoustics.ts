/**
 * Verification suite for the Contact Patch, Suspension & Brake Acoustics Engine
 * (`src/lib/sim/contact-acoustics.ts` and `src/lib/sim/CarAudio.ts`).
 *
 * Run with: npx tsx scripts/verify-contact-acoustics.ts
 */

import {
  ContactAcousticsRig,
  createContactAcousticsFrame,
  createContactAcousticsState,
  evaluateContactAcoustics,
  fbmNoise1D,
  GT3_ACOUSTICS_PROFILE,
  mapRange,
  OPEN_WHEELER_ACOUSTICS_PROFILE,
  profileForCarSoundId,
  type ContactAcousticsInput,
  type CornerContactInput,
} from "../src/lib/sim/contact-acoustics";

let passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}${detail ? `  (${detail})` : ""}`);
}

function makeCornerInput(overrides: Partial<CornerContactInput> = {}): CornerContactInput {
  return {
    ndSlip: 0.0,
    slipRatio: 0.0,
    slipAngleDeg: 0.0,
    loadN: 4000,
    pressurePsi: 23.0,
    angularSpeedRadS: 120,
    groundSpeedMs: 42,
    suspensionTravelM: 0.025,
    surface: "asphalt",
    brakeTempC: 420,
    tireDirtyLevel: 0.0,
    ...overrides,
  };
}

function makeVehicleInput(
  cornerOverrides: Partial<CornerContactInput> = {},
  topOverrides: Partial<Omit<ContactAcousticsInput, "corners">> = {}
): ContactAcousticsInput {
  return {
    corners: [
      makeCornerInput(cornerOverrides),
      makeCornerInput(cornerOverrides),
      makeCornerInput(cornerOverrides),
      makeCornerInput(cornerOverrides),
    ],
    brakePedal: 0.0,
    cameraMode: "chase",
    dt: 1 / 60,
    timeSec: 1.0,
    ...topOverrides,
  };
}

console.log("1. Per-Corner & Axle Tyre Scrub & Skid Modulation");
{
  const state = createContactAcousticsState();

  // Below scrub onset (ndSlip < 0.4) -> volume is 0
  const fZero = evaluateContactAcoustics(makeVehicleInput({ ndSlip: 0.25 }), state);
  check(
    "Below ndSlip=0.4 threshold: skid volume is 0",
    fZero.corners[0].skid.volume === 0,
    `vol=${fZero.corners[0].skid.volume.toFixed(4)}`
  );

  // Pre-peak scrub onset (ndSlip = 0.6 in 0.4..3.2 with 0.25 power curve) -> audible scrub
  const fPrePeak = evaluateContactAcoustics(makeVehicleInput({ ndSlip: 0.6 }), state);
  const fPeak = evaluateContactAcoustics(makeVehicleInput({ ndSlip: 1.2 }), state);
  const fFullSlide = evaluateContactAcoustics(makeVehicleInput({ ndSlip: 3.2 }), state);
  check(
    "Pre-peak scrub onset (ndSlip=0.6) > 0 and monotonic up to ndSlip=3.2 (exponent 0.25)",
    fPrePeak.corners[0].skid.volume > 0.4 &&
      fPeak.corners[0].skid.volume > fPrePeak.corners[0].skid.volume &&
      fFullSlide.corners[0].skid.volume > fPeak.corners[0].skid.volume,
    `v(0.6)=${fPrePeak.corners[0].skid.volume.toFixed(3)}, v(1.2)=${fPeak.corners[0].skid.volume.toFixed(3)}, v(3.2)=${fFullSlide.corners[0].skid.volume.toFixed(3)}`
  );

  // Vertical load factor (Fz / 500)^0.5
  const fUnloaded = evaluateContactAcoustics(makeVehicleInput({ ndSlip: 1.5, loadN: 0 }), state);
  const fLightLoad = evaluateContactAcoustics(makeVehicleInput({ ndSlip: 1.5, loadN: 125 }), state);
  const fFullLoad = evaluateContactAcoustics(makeVehicleInput({ ndSlip: 1.5, loadN: 1000 }), state);
  check(
    "Vertical load factor (Fz / 500)^0.5 scales skid volume from 0 at Fz=0 to 0.5 at Fz=125N",
    fUnloaded.corners[0].skid.volume === 0 &&
      Math.abs(fLightLoad.corners[0].skid.volume / fFullLoad.corners[0].skid.volume - 0.5) < 1e-4,
    `ratio=${(fLightLoad.corners[0].skid.volume / fFullLoad.corners[0].skid.volume).toFixed(4)}`
  );

  // Hard-surface mask & low-speed roll-off
  const fGrassSkid = evaluateContactAcoustics(
    makeVehicleInput({ ndSlip: 2.0, surface: "grass" }),
    state
  );
  const fStoppedSkid = evaluateContactAcoustics(
    makeVehicleInput({ ndSlip: 2.0, groundSpeedMs: 0.01, angularSpeedRadS: 0.2 }),
    state
  );
  check(
    "Hard-surface mask mutes asphalt skid on grass and low-speed roll-off mutes stationary wheel",
    fGrassSkid.corners[0].skid.volume === 0 && fStoppedSkid.corners[0].skid.volume === 0
  );

  // Multi-factor pitch synthesis: base ndSlip drop, load drop, slipAngle drop, psi offset, slipRatio rise, noise
  const fPitchLowSlip = evaluateContactAcoustics(
    makeVehicleInput({
      ndSlip: 1.0,
      loadN: 2000,
      slipAngleDeg: 1.0,
      pressurePsi: 28,
      slipRatio: 0.0,
    }),
    state
  );
  const fPitchHighSlip = evaluateContactAcoustics(
    makeVehicleInput({
      ndSlip: 6.0,
      loadN: 2000,
      slipAngleDeg: 1.0,
      pressurePsi: 28,
      slipRatio: 0.0,
    }),
    state
  );
  const fPitchHighLoad = evaluateContactAcoustics(
    makeVehicleInput({
      ndSlip: 1.0,
      loadN: 11000,
      slipAngleDeg: 1.0,
      pressurePsi: 28,
      slipRatio: 0.0,
    }),
    state
  );
  const fPitchLowPsi = evaluateContactAcoustics(
    makeVehicleInput({
      ndSlip: 1.0,
      loadN: 2000,
      slipAngleDeg: 1.0,
      pressurePsi: 12,
      slipRatio: 0.0,
    }),
    state
  );
  const fPitchHighSlipRatio = evaluateContactAcoustics(
    makeVehicleInput({
      ndSlip: 4.0,
      loadN: 2000,
      slipAngleDeg: 1.0,
      pressurePsi: 28,
      slipRatio: 2.5,
    }),
    state
  );
  check(
    "Pitch drops with higher ndSlip (1..8), higher vertical load ((Fz/FzMax)^1.5 * 0.6), and lower psi",
    fPitchHighSlip.corners[0].skid.basePitch < fPitchLowSlip.corners[0].skid.basePitch &&
      fPitchHighLoad.corners[0].skid.loadPitchDrop > fPitchLowSlip.corners[0].skid.loadPitchDrop &&
      fPitchLowPsi.corners[0].skid.psiPitchDrop > fPitchLowSlip.corners[0].skid.psiPitchDrop,
    `baseDrop=${(fPitchLowSlip.corners[0].skid.basePitch - fPitchHighSlip.corners[0].skid.basePitch).toFixed(3)}, loadDrop=${fPitchHighLoad.corners[0].skid.loadPitchDrop.toFixed(3)}`
  );
  check(
    "Longitudinal slip-ratio pitch rise ((|0.5 * ndSlip * slipRatio| / 10)^0.35 * 0.3) increases pitch",
    fPitchHighSlipRatio.corners[0].skid.slipRatioPitchAdd > 0.15,
    `add=${fPitchHighSlipRatio.corners[0].skid.slipRatioPitchAdd.toFixed(3)}`
  );

  // Perlin/gradient noise modulation active for slipAngle in 8..16 deg
  const fNoiseT1 = evaluateContactAcoustics(
    makeVehicleInput({ ndSlip: 2.0, slipAngleDeg: 14.0 }, { timeSec: 1.12 }),
    state
  );
  const fNoiseT2 = evaluateContactAcoustics(
    makeVehicleInput({ ndSlip: 2.0, slipAngleDeg: 14.0 }, { timeSec: 1.49 }),
    state
  );
  check(
    "Deterministic Perlin/gradient noise modulates skid pitch at high slip angle (8..16 deg)",
    Math.abs(fNoiseT1.corners[0].skid.pitchNoiseOffset - fNoiseT2.corners[0].skid.pitchNoiseOffset) >
      1e-4 && Math.abs(fbmNoise1D(2.34, 4)) <= 1.0,
    `n1=${fNoiseT1.corners[0].skid.pitchNoiseOffset.toFixed(4)}, n2=${fNoiseT2.corners[0].skid.pitchNoiseOffset.toFixed(4)}`
  );

  // Waveshaper distortion drive (2000..12000 N and 1.2..4.0 * optSlip) & filter timbre (psi + angVel 0..200)
  const fLowDist = evaluateContactAcoustics(
    makeVehicleInput({
      loadN: 1800,
      slipAngleDeg: 2.0,
      pressurePsi: 14,
      angularSpeedRadS: 20,
    }),
    state
  );
  const fHighDist = evaluateContactAcoustics(
    makeVehicleInput({
      loadN: 11500,
      slipAngleDeg: 24.0,
      pressurePsi: 31,
      angularSpeedRadS: 190,
    }),
    state
  );
  check(
    "Distortion drive scales with high vertical load (2000..12000N) & post-peak slip angle; timbre scales with psi & angVel",
    fLowDist.corners[0].skid.distort === 0 &&
      fHighDist.corners[0].skid.distort > 0.32 &&
      fHighDist.corners[0].skid.timbre > fLowDist.corners[0].skid.timbre + 0.4,
    `dist=${fHighDist.corners[0].skid.distort.toFixed(3)}, timbre=${fLowDist.corners[0].skid.timbre.toFixed(3)}`
  );
}

console.log("\n2. Wavelength-Linked Curb Rumble");
{
  const state = createContactAcousticsState();

  // Attack on kerb (40 /s) vs release off kerb (30 /s)
  const dt = 0.01;
  const fAttack = evaluateContactAcoustics(
    makeVehicleInput(
      { surface: "kerb", groundSpeedMs: 40.5, suspensionTravelM: 0.04, ndSlip: 0.8 },
      { dt, timeSec: 0.1 }
    ),
    state
  );
  const attackStep = fAttack.corners[0].curb.fade; // should be 40 * 0.01 = 0.40

  // Saturate curb fade to 1.0
  for (let k = 0; k < 20; k++) {
    evaluateContactAcoustics(
      makeVehicleInput({ surface: "kerb", groundSpeedMs: 40.5 }, { dt, timeSec: 0.2 + k * dt }),
      state
    );
  }
  const fRelease = evaluateContactAcoustics(
    makeVehicleInput({ surface: "asphalt", groundSpeedMs: 40.5 }, { dt, timeSec: 0.5 }),
    state
  );
  const releaseDrop = 1.0 - fRelease.corners[0].curb.fade; // should be 30 * 0.01 = 0.30

  check(
    "Asymmetric curb envelope fade: 40 /s attack on kerb vs 30 /s release off kerb",
    Math.abs(attackStep - 0.4) < 1e-4 && Math.abs(releaseDrop - 0.3) < 1e-4,
    `attackStep=${attackStep.toFixed(3)}, releaseDrop=${releaseDrop.toFixed(3)}`
  );

  // Wavelength-linked pitch rate (v_ground / 0.81 m)
  const expectedBaseRate = 40.5 / 0.81; // 50 Hz
  check(
    "Curb pitch rate tracks v_ground / 0.81m wavelength within noise tolerance",
    Math.abs(fAttack.corners[0].curb.pitchRateHz - expectedBaseRate) <= 0.11,
    `rate=${fAttack.corners[0].curb.pitchRateHz.toFixed(2)} Hz (expected ~${expectedBaseRate.toFixed(2)} Hz)`
  );

  // Volume modulated by |v_susp|^1.2 and roughness by ndSlip
  check(
    "Curb volume modulated by vertical suspension velocity (|v_susp|^1.2) and roughness by ndSlip",
    fAttack.corners[0].curb.volume > fRelease.corners[0].curb.volume &&
      Math.abs(fAttack.corners[0].curb.roughness - mapRange(0.8, 0, 1, 0.6, 1.0, true)) < 1e-5,
    `vol=${fAttack.corners[0].curb.volume.toFixed(3)}, rough=${fAttack.corners[0].curb.roughness.toFixed(3)}`
  );
}

console.log("\n3. Suspension Stroke & High-G Chassis Rattle");
{
  const state = createContactAcousticsState();
  const dt = 0.01;

  // Step 1: initial travel 0.02 m -> velocity = (0 - 0.02) / 0.01 = -2.0 m/s
  const fStep1 = evaluateContactAcoustics(
    makeVehicleInput({ suspensionTravelM: 0.02, loadN: 5000 }, { dt }),
    state
  );
  // Step 2: sharp bump to 0.06 m -> velocity = (0.02 - 0.06) / 0.01 = -4.0 m/s, accel = (-4 - (-2)) / 0.01 = -200 m/s^2
  const fBump = evaluateContactAcoustics(
    makeVehicleInput({ suspensionTravelM: 0.06, loadN: 7000 }, { dt }),
    state
  );
  // Step 3: steady travel 0.06 m -> velocity = 0, accel decays slowly with 0.06 decay factor
  const fSteady1 = evaluateContactAcoustics(
    makeVehicleInput({ suspensionTravelM: 0.06, loadN: 7000 }, { dt }),
    state
  );
  const fSteady2 = evaluateContactAcoustics(
    makeVehicleInput({ suspensionTravelM: 0.06, loadN: 7000 }, { dt }),
    state
  );

  check(
    "Suspension travel differentiates into velocity (EMA 0.4), asymmetric accel (0.5 buildup / 0.06 decay), and load (EMA 0.1)",
    Math.abs(fStep1.corners[0].suspension.rawVelocityMs - -2.0) < 1e-5 &&
      Math.abs(fStep1.corners[0].suspension.smoothedVelocityMs - 0.8) < 1e-5 &&
      Math.abs(fStep1.corners[0].suspension.smoothedLoadN - 500) < 1e-5 &&
      fBump.corners[0].suspension.smoothedAccelerationMs2 > 40 &&
      Math.abs(
        fSteady2.corners[0].suspension.smoothedAccelerationMs2 -
          fSteady1.corners[0].suspension.smoothedAccelerationMs2 * (1 - 0.06)
      ) < 1e-4,
    `vSmooth=${fStep1.corners[0].suspension.smoothedVelocityMs.toFixed(2)}, aSmooth=${fBump.corners[0].suspension.smoothedAccelerationMs2.toFixed(1)}`
  );

  check(
    "Damper compression thump ((|v_susp|/10)^0.7) and mechanical rattle ((|a_susp|/80)^2.0) follow power laws",
    Math.abs(fBump.corners[0].suspension.damperVelocity - (4 / 10) ** 0.7) < 1e-5 &&
      fBump.corners[0].suspension.rattle > 0.35 &&
      fSteady2.corners[0].suspension.damperVelocity === 0,
    `damper=${fBump.corners[0].suspension.damperVelocity.toFixed(3)}, rattle=${fBump.corners[0].suspension.rattle.toFixed(3)}`
  );
}

console.log("\n4. Surface Rolling & Off-Line Texture (Asphalt, Grass, Gravel/Sand & Debris)");
{
  const state = createContactAcousticsState();
  const dt = 0.05;

  // Saturate asphalt fade
  for (let i = 0; i < 15; i++) {
    evaluateContactAcoustics(
      makeVehicleInput({ surface: "asphalt", groundSpeedMs: 50, loadN: 1000, ndSlip: 0.1 }, { dt }),
      state
    );
  }
  const fAsphaltLight = evaluateContactAcoustics(
    makeVehicleInput(
      { surface: "asphalt", groundSpeedMs: 50, loadN: 500, ndSlip: 0.0 },
      { dt, timeSec: 3.1 }
    ),
    state
  );
  const fAsphaltHeavy = evaluateContactAcoustics(
    makeVehicleInput(
      { surface: "asphalt", groundSpeedMs: 50, loadN: 12000, ndSlip: 0.0 },
      { dt, timeSec: 3.1 }
    ),
    state
  );
  const fAsphaltHighSlip = evaluateContactAcoustics(
    makeVehicleInput(
      { surface: "asphalt", groundSpeedMs: 50, loadN: 12000, ndSlip: 4.5 },
      { dt, timeSec: 3.1 }
    ),
    state
  );

  check(
    "Asphalt roar scales with speed^1.1, vertical load offset (-0.1..+0.1), and high-slip chop (1 - noise * slip^2.5)",
    fAsphaltHeavy.corners[0].asphalt.loadOffset > 0.08 &&
      fAsphaltLight.corners[0].asphalt.loadOffset < -0.08 &&
      fAsphaltHeavy.corners[0].asphalt.volume > fAsphaltLight.corners[0].asphalt.volume &&
      fAsphaltHighSlip.corners[0].asphalt.slipVolumeChop > 0.1 &&
      fAsphaltHighSlip.corners[0].asphalt.volume < fAsphaltHeavy.corners[0].asphalt.volume,
    `volLight=${fAsphaltLight.corners[0].asphalt.volume.toFixed(3)}, volHeavy=${fAsphaltHeavy.corners[0].asphalt.volume.toFixed(3)}, chop=${fAsphaltHighSlip.corners[0].asphalt.slipVolumeChop.toFixed(3)}`
  );

  // Grass & Gravel/Sand asymmetric fade (10 /s in, 20 /s out) + pebble/marble scatter when tireDirtyLevel > 0.05
  const stateOff = createContactAcousticsState();
  const fGrassIn = evaluateContactAcoustics(
    makeVehicleInput(
      { surface: "grass", ndSlip: 2.5, tireDirtyLevel: 0.02 },
      { dt: 0.02, timeSec: 1.0 }
    ),
    stateOff
  );
  check(
    "Grass fade-in rate is 10 /s (0.20 in 20ms) and clean tyre (dirty<=0.05) triggers no debris scatter",
    Math.abs(fGrassIn.corners[0].grass.fade - 0.2) < 1e-5 && !fGrassIn.corners[0].debris.active,
    `grassFade=${fGrassIn.corners[0].grass.fade.toFixed(3)}`
  );

  let anyClickTriggered = false;
  for (let step = 0; step < 20; step++) {
    const fDirty = evaluateContactAcoustics(
      makeVehicleInput(
        { surface: "runoff", ndSlip: 2.0, tireDirtyLevel: 0.65, groundSpeedMs: 45 },
        { dt: 0.02, timeSec: 2.0 + step * 0.02 }
      ),
      stateOff
    );
    if (fDirty.debrisAggregate.triggerClick) anyClickTriggered = true;
  }
  check(
    "Gravel/sand layer activates on runoff and tireDirtyLevel > 0.05 triggers wheel-arch pebble/marble scatter clicks",
    stateOff.corners[0].sandFade > 0.95 && anyClickTriggered,
    `sandFade=${stateOff.corners[0].sandFade.toFixed(2)}, clickTriggered=${anyClickTriggered}`
  );
}

console.log("\n5. High-Performance Brake Squeal & Interior/Exterior Camera Mix");
{
  const state = createContactAcousticsState();
  const dt = 0.05;

  // Cold brakes (100 degC < 180 degC) -> gated off
  const fColdBrakes = evaluateContactAcoustics(
    makeVehicleInput({ brakeTempC: 100, angularSpeedRadS: 100 }, { brakePedal: 0.35, dt }),
    state
  );
  // Overheated brakes (820 degC > 750 degC) -> gated off
  const fOverheatedBrakes = evaluateContactAcoustics(
    makeVehicleInput({ brakeTempC: 820, angularSpeedRadS: 100 }, { brakePedal: 0.35, dt }),
    state
  );
  // Stationary wheel (angularSpeed = 0) -> gated off by low-speed fadeout
  const fStoppedBrakes = evaluateContactAcoustics(
    makeVehicleInput({ brakeTempC: 420, angularSpeedRadS: 0 }, { brakePedal: 0.35, dt }),
    state
  );
  check(
    "Brake squeal is gated off outside 180..750 degC window and at zero wheel angular speed",
    fColdBrakes.brakeAggregate.effectiveGain === 0 &&
      fOverheatedBrakes.brakeAggregate.effectiveGain === 0 &&
      fStoppedBrakes.brakeAggregate.effectiveGain === 0
  );

  // Active in partial-to-firm brake pedal window (0.2..0.6 with 0.8 exponent) vs full lock (>0.6)
  const fPartialPedal = evaluateContactAcoustics(
    makeVehicleInput({ brakeTempC: 420, angularSpeedRadS: 110 }, { brakePedal: 0.32, dt: 0.1 }),
    state
  );
  const fFirmPedal = evaluateContactAcoustics(
    makeVehicleInput({ brakeTempC: 420, angularSpeedRadS: 110 }, { brakePedal: 0.5, dt: 0.1 }),
    state
  );
  const fMashedPedal = evaluateContactAcoustics(
    makeVehicleInput({ brakeTempC: 420, angularSpeedRadS: 110 }, { brakePedal: 0.85, dt: 0.1 }),
    state
  );
  check(
    "Brake squeal is active in 0.2..0.6 pedal window, pitch rises with pedal pressure, and drops off at full clamp (>0.6)",
    fPartialPedal.brakeAggregate.intensity > 0.05 &&
      fFirmPedal.brakeAggregate.pitch > fPartialPedal.brakeAggregate.pitch &&
      fMashedPedal.brakeAggregate.intensity === 0,
    `int(0.32)=${fPartialPedal.brakeAggregate.intensity.toFixed(3)}, int(0.85)=${fMashedPedal.brakeAggregate.intensity.toFixed(3)}`
  );

  // Interior vs Exterior camera mix scaling
  const fExt = evaluateContactAcoustics(
    makeVehicleInput({ ndSlip: 2.0, brakeTempC: 420 }, { brakePedal: 0.35, cameraMode: "chase" }),
    state,
    GT3_ACOUSTICS_PROFILE
  );
  const fInt = evaluateContactAcoustics(
    makeVehicleInput(
      { ndSlip: 2.0, brakeTempC: 420 },
      { brakePedal: 0.35, cameraMode: "cockpit" }
    ),
    state,
    GT3_ACOUSTICS_PROFILE
  );
  check(
    "Interior camera (cockpit) applies interiorMix and interiorVolumeMultiplier vs exterior camera (chase)",
    !fExt.isInteriorCamera &&
      fInt.isInteriorCamera &&
      fExt.corners[0].skid.insideMix === 0 &&
      fInt.corners[0].skid.insideMix === 1.0 &&
      fInt.peakSkid.volume < fExt.peakSkid.volume,
    `extVol=${fExt.peakSkid.volume.toFixed(3)}, intVol=${fInt.peakSkid.volume.toFixed(3)}`
  );
}

console.log("\n6. Zero-Allocation WebAudio ContactAcousticsRig & Profile Wiring");
{
  let createdNodes = 0;
  const makeMockParam = (initial = 0) => ({
    value: initial,
    setValueAtTime(v: number) {
      this.value = v;
    },
    setTargetAtTime(v: number) {
      this.value = v;
    },
    linearRampToValueAtTime(v: number) {
      this.value = v;
    },
  });
  const mockNode = () => {
    createdNodes++;
    return {
      connect() {
        return this;
      },
      disconnect() {},
      start() {},
      stop() {},
      frequency: makeMockParam(440),
      Q: makeMockParam(1),
      gain: makeMockParam(0),
      playbackRate: makeMockParam(1),
      type: "sine",
      buffer: null,
      loop: false,
      curve: null,
    };
  };
  const mockCtx = {
    currentTime: 0,
    sampleRate: 48000,
    state: "running",
    destination: mockNode(),
    createGain: () => mockNode(),
    createOscillator: () => mockNode(),
    createBiquadFilter: () => mockNode(),
    createWaveShaper: () => mockNode(),
    createBufferSource: () => mockNode(),
    createBuffer: (_ch: number, len: number, sr: number) => ({
      length: len,
      sampleRate: sr,
      duration: len / sr,
      getChannelData: () => new Float32Array(len),
    }),
  } as unknown as AudioContext;

  const rig = new ContactAcousticsRig(
    mockCtx,
    mockCtx.destination,
    undefined,
    profileForCarSoundId("fa26")
  );
  const nodesAfterInit = createdNodes;

  for (let frameIdx = 0; frameIdx < 30; frameIdx++) {
    rig.update(
      makeVehicleInput(
        {
          ndSlip: 1.8,
          surface: frameIdx % 2 === 0 ? "asphalt" : "kerb",
          tireDirtyLevel: 0.4,
        },
        { brakePedal: 0.35, cameraMode: "cockpit", dt: 1 / 60, timeSec: frameIdx / 60 }
      )
    );
  }
  const nodesAfterUpdates = createdNodes;
  check(
    "ContactAcousticsRig performs zero WebAudio node allocations across 30 update frames",
    nodesAfterInit > 10 && nodesAfterUpdates === nodesAfterInit,
    `initNodes=${nodesAfterInit}, after30Frames=${nodesAfterUpdates}`
  );

  const reusableFrame = createContactAcousticsFrame();
  const state = createContactAcousticsState();
  const out = evaluateContactAcoustics(
    makeVehicleInput({ ndSlip: 1.4 }),
    state,
    OPEN_WHEELER_ACOUSTICS_PROFILE,
    reusableFrame
  );
  check("evaluateContactAcoustics reuses pre-allocated output frame in-place", out === reusableFrame);

  rig.dispose();
}

console.log(`\nContact acoustics verification: all ${passed} checks passed.`);
