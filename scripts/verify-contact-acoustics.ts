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

console.log("\n4. Asphalt Road Roar");
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

}

console.log("\n5. High-Performance Brake Squeal");
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
