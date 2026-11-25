/**
 * Targeted verification for the LC-LMDH cockpit/dash/physics overhaul and AMG GT3 exhaust pop toning:
 *  1. LC-LMDH Bosch/Cosworth steering-wheel LCD UV mapping, overlay hiding, and in-car dash damage banners (AMG GT3 + LC-LMDH)
 *  2. LC-LMDH cockpit framing, parked static wiper, and SeatPanel per-car persistence
 *  3. LC-LMDH prototype steering lock (360-420 deg) & ratio consistency
 *  4. LC-LMDH braking distance & peak decel vs F1 2026
 *  5. AMG GT3 downshift/lift-off exhaust pop gain toning and pitch/timing randomization
 */
import * as THREE from 'three';
import {
  drawDashPage,
  LMDH_WHEEL_HIDE_MATERIALS,
  LMDH_WHEEL_SCREEN_MATERIAL,
  lmdhSurface,
  resolveDashBanner,
} from '@/lib/render/gt3-dash-display';
import { PortedWheelDash } from '@/lib/render/ported-wheel-dash';
import { LC_LMDH_COCKPIT_FROM_STEER, lcLmdhCameraAnchors, parkLcLmdhWiper } from '@/lib/ported-car-model';
import { OnboardViews } from '@/lib/render/onboard-views';
import { nudgeOf, parseCameraNudges, stepNudge } from '@/lib/settings/camera-nudges';
import { CAR_WHEEL_LOCKS_DEG, carWheelLockDeg } from '@/lib/input/device-input';
import { STEER_RATIO_BASE } from '@/lib/sim/car-setup';
import { LC_LMDH_CONFIG } from '@/lib/sim/proto/LcLmdhConfig';
import { createLcLmdhSim, LC_LMDH_SIM_PROFILE } from '@/lib/sim/proto/LcLmdhSim';
import { F12026CarSim } from '@/lib/sim/f12026-car/F12026CarSim';
import { Lc26SoundBank, type Lc26AudioManifest } from '@/lib/sim/lc26-audio';
import { AMG_GT3_POP_TUNING, AMG_GT3_SOUND } from '@/lib/sim/gt3/AmgGt3Sim';
import { createFlatTestTrack } from '../lib/flat-track';
import type { CarTelemetry, PlayerDamageStatus } from '@/types/f1';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`${status}  ${name.padEnd(66)} ${detail}`);
  if (!ok) failed++;
}

function makeTelemetry(overrides: Partial<CarTelemetry> = {}): CarTelemetry {
  return {
    speedKmh: 248,
    rpm: 7400,
    gear: 4,
    throttle: 0.9,
    brake: 0,
    steering: 0,
    gLat: 0,
    gLong: 0,
    drsActive: false,
    drsAvailable: false,
    aeroMode: 'Z',
    activeAeroAvailable: false,
    ersMode: 'RAC',
    ersBatteryPercent: 68,
    ersDeployRemainingMj: 2.0,
    ersHarvestRemainingMj: 2.0,
    mgukPowerKw: 40,
    overtakeAvailable: false,
    overtakeActive: false,
    tireTempsC: [88, 91, 86, 89],
    tireWearPct: [22, 24, 19, 21],
    tireOptimalTempC: [70, 90],
    tireCompound: 'soft',
    fuelKg: 21.5,
    lapCount: 3,
    currentLapTimeMs: 84_321,
    lastLapTimeMs: 112_450,
    bestLapTimeMs: 111_800,
    lapValid: true,
    onTrack: true,
    surface: 'asphalt',
    liveTuner: {
      tcLevel: 10,
      tc2Level: 7,
      tcSlipAngleLevel: 10,
      absLevel: 6,
      brakeBiasPct: 60.0,
      engineMap: 1,
      ersMode: 'RAC',
    },
    f12026: {
      profileId: 'lc-lmdh',
      hasErs: true,
      hasDrs: false,
      tcActive: false,
      absActive: false,
      wheelSpeedsKmh: [248, 248, 248, 248],
      wheelSlipRatios: [0, 0, 0, 0],
      wheelSlipAnglesDeg: [0, 0, 0, 0],
      wheelLoadsN: [3500, 3500, 4200, 4200],
      rideHeightsMm: [32, 32, 40, 40],
      brakeTempsC: [420, 420, 390, 390],
      downforceN: 12000,
      dragN: 3100,
      aeroBalancePct: 47,
    },
    ...overrides,
  } as CarTelemetry;
}

function makeDamage(overrides: Partial<PlayerDamageStatus> = {}): PlayerDamageStatus {
  return {
    overall: 0,
    front: 0,
    rear: 0,
    left: 0,
    right: 0,
    suspension: [0, 0, 0, 0],
    punctured: [false, false, false, false],
    terminal: false,
    ...overrides,
  };
}

function createMockCanvas2d() {
  const texts: { text: string; color: string; x: number; y: number }[] = [];
  const rects: { x: number; y: number; w: number; h: number; color: string }[] = [];
  let fillStyle = '#000';
  let strokeStyle = '#fff';
  const ctx = {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(v: string) {
      fillStyle = v;
    },
    get strokeStyle() {
      return strokeStyle;
    },
    set strokeStyle(v: string) {
      strokeStyle = v;
    },
    lineWidth: 1,
    font: '',
    textAlign: 'center',
    textBaseline: 'middle',
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, color: fillStyle });
    },
    strokeRect() {},
    fillText(text: string, x: number, y: number) {
      texts.push({ text: String(text), color: fillStyle, x, y });
    },
    measureText(text: string) {
      return { width: text.length * 10 };
    },
    setTransform() {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, rects };
}

// ---------------------------------------------------------------------------
// 1. LC-LMDH steering-wheel LCD & in-car dash damage banners
// ---------------------------------------------------------------------------
console.log('\n== 1. LC-LMDH steering-wheel LCD & in-car dash damage banners');
{
  // Synthetic STEER group matching lc-lmdh.glb's light_004 (101.6 x 66.0 mm facing -Z) + light_005/006/007 bars
  const root = new THREE.Group();
  const steer = new THREE.Group();
  steer.name = 'STEER';
  root.add(steer);

  const lcdGeo = new THREE.PlaneGeometry(0.1016, 0.066);
  // PlaneGeometry lies in XY facing +Z; flip normals to -Z like lc-lmdh's light_004
  const lcdMat = new THREE.MeshStandardMaterial({ name: LMDH_WHEEL_SCREEN_MATERIAL, color: 0x777777 });
  const lcdMesh = new THREE.Mesh(lcdGeo, lcdMat);
  steer.add(lcdMesh);

  const overlayMeshes: THREE.Mesh[] = [];
  for (const name of LMDH_WHEEL_HIDE_MATERIALS) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.004, 0.06), new THREE.MeshStandardMaterial({ name }));
    steer.add(m);
    overlayMeshes.push(m);
  }

  const surf = lmdhSurface(steer);
  const uv = surf?.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const pos = surf?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  let uvValid = Boolean(surf && uv && pos);
  if (surf && uv && pos) {
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      const x = pos.getX(i);
      const y = pos.getY(i);
      // flipX: +X (driver's left) maps to u=0, -X maps to u=1; +Y maps to v=1
      if (x > 0 && Math.abs(u) > 1e-4) uvValid = false;
      if (x < 0 && Math.abs(u - 1) > 1e-4) uvValid = false;
      if (y > 0 && Math.abs(v - 1) > 1e-4) uvValid = false;
      if (y < 0 && Math.abs(v) > 1e-4) uvValid = false;
    }
    const testMat = new THREE.MeshStandardMaterial({ name: LMDH_WHEEL_SCREEN_MATERIAL });
    surf.attach(testMat);
    check('lmdhSurface renames attached LCD material to wheel_display', testMat.name === 'wheel_display', testMat.name);
    surf.detach();
    surf.geometry.dispose();
    testMat.dispose();
  }
  check('lmdhSurface maps planar UVs full-bleed across light_004 (+X->u=0, +Y->v=1)', uvValid);

  const dash = PortedWheelDash.from(root, [6800, 8100], 'lc-lmdh');
  const allHidden = overlayMeshes.every((m) => !m.visible);
  dash?.dispose();
  const allRestored = overlayMeshes.every((m) => m.visible);
  check('PortedWheelDash hides static light_005/006/007 bars on lc-lmdh and restores on dispose', allHidden && allRestored);

  // Render LC-LMDH full page and inspect drawn channels
  const lmdhCanvas = createMockCanvas2d();
  const tBase = makeTelemetry();
  drawDashPage('lmdh', lmdhCanvas.ctx, tBase, [6800, 8100], -420, 1000);
  const drawn = new Set(lmdhCanvas.texts.map((x) => x.text));
  const requiredTokens = ['4', '248', '-0.42', '88', '78%', '68%', 'RAC', '+40', '10', '6', '60.0', '1:24.321'];
  const missingTokens = requiredTokens.filter((tok) => !drawn.has(tok));
  check('LC-LMDH dash page renders gear, speed, delta, tyres+wear, ERS/SOC, TC/ABS/BB', missingTokens.length === 0, missingTokens.join(', ') || 'all present');

  // Verify resolveDashBanner priority and labels
  const yellowRace = {
    phase: 'racing',
    lightsOn: 0,
    lap: 2,
    totalLaps: 10,
    position: 1,
    fieldSize: 10,
    standings: [],
    yellow: true,
  } as unknown as CarTelemetry['race'];
  const bTerminal = resolveDashBanner(makeTelemetry({ practiceDamage: makeDamage({ terminal: true, overall: 1 }), race: yellowRace }));
  const bPuncture = resolveDashBanner(makeTelemetry({ practiceDamage: makeDamage({ punctured: [false, true, false, false], overall: 0.4 }) }));
  const bSteer = resolveDashBanner(makeTelemetry({ practiceDamage: makeDamage({ suspension: [0.3, 0, 0, 0], overall: 0.25 }) }));
  const bSusp = resolveDashBanner(makeTelemetry({ practiceDamage: makeDamage({ suspension: [0, 0, 0.35, 0], overall: 0.25 }) }));
  const bAero = resolveDashBanner(makeTelemetry({ practiceDamage: makeDamage({ front: 0.3, overall: 0.22 }) }));
  const bGeneric = resolveDashBanner(makeTelemetry({ practiceDamage: makeDamage({ overall: 0.1 }) }));
  const bYellowOverDamage = resolveDashBanner(makeTelemetry({
    practiceDamage: makeDamage({ front: 0.3, overall: 0.22 }),
    race: yellowRace,
  }));
  const bNone = resolveDashBanner(makeTelemetry());

  check(
    'In-car damage banners resolve terminal, puncture, steering, susp, aero, generic & yellow priority',
    bTerminal?.text === 'TERMINAL DAMAGE' &&
      bTerminal.tone === 'critical' &&
      bPuncture?.text === 'PUNCTURE FL' &&
      bPuncture.tone === 'critical' &&
      bSteer?.text === 'STEERING DAMAGE' &&
      bSteer.tone === 'warning' &&
      bSusp?.text === 'SUSP DAMAGE' &&
      bAero?.text === 'AERO DAMAGE' &&
      bGeneric?.text === 'DAMAGE' &&
      bYellowOverDamage?.text === 'YELLOW FLAG' &&
      bNone === null,
    [bTerminal?.text, bPuncture?.text, bSteer?.text, bSusp?.text, bAero?.text, bGeneric?.text, bYellowOverDamage?.text].join(' | ')
  );

  // Verify damage banner actually draws on BOTH AMG GT3 (ddu) and LC-LMDH (lmdh) pages
  const dduDmg = createMockCanvas2d();
  const lmdhDmg = createMockCanvas2d();
  const tDamaged = makeTelemetry({ practiceDamage: makeDamage({ punctured: [false, true, false, false], overall: 0.4 }) });
  drawDashPage('ddu', dduDmg.ctx, tDamaged, [6500, 7700], 0, 2000);
  drawDashPage('lmdh', lmdhDmg.ctx, tDamaged, [6800, 8100], 0, 2000);
  const dduHasBanner = dduDmg.texts.some((x) => x.text === 'PUNCTURE FL');
  const lmdhHasBanner = lmdhDmg.texts.some((x) => x.text === 'PUNCTURE FL');
  check('Damage warning banner renders on both AMG GT3 Bosch DDU and LC-LMDH wheel LCD', dduHasBanner && lmdhHasBanner);
}

// ---------------------------------------------------------------------------
// 2. LC-LMDH cockpit framing, static wiper parking & SeatPanel persistence
// ---------------------------------------------------------------------------
console.log('\n== 2. LC-LMDH cockpit framing, wiper parking & seat persistence');
{
  const steerCentre = new THREE.Vector3(0.173, 0.679, 0.727);
  const dummyAnchor = { pos: new THREE.Vector3(0, 1, 0), pitchRad: 0, fovDeg: 60 };
  const oldGlbAnchors = {
    cockpit: { pos: new THREE.Vector3(0.173, 0.879, 0.297), pitchRad: -4 * THREE.MathUtils.DEG2RAD, fovDeg: 60 },
    tcam: { ...dummyAnchor },
    dash: { ...dummyAnchor },
    bumper: { ...dummyAnchor },
    nearChase: { ...dummyAnchor },
    farChase: { ...dummyAnchor },
    shoulder: { ...dummyAnchor },
  };
  const tuned = lcLmdhCameraAnchors({ steerCentre, frontAxleZ: 1.57 }, oldGlbAnchors);
  const movedFwd = tuned.cockpit.pos.z - oldGlbAnchors.cockpit.pos.z;
  const lowered = oldGlbAnchors.cockpit.pos.y - tuned.cockpit.pos.y;
  check(
    'lcLmdhCameraAnchors opens cockpit sightline forward under roof visor',
    movedFwd > 0.14 && lowered > 0.02 && tuned.cockpit.fovDeg === 58 && LC_LMDH_COCKPIT_FROM_STEER[2] > -0.30,
    `Δz=+${movedFwd.toFixed(3)} m, Δy=-${lowered.toFixed(3)} m, fov=${tuned.cockpit.fovDeg}°`
  );

  const views = new OnboardViews();
  const dashView = views.resolve(tuned, 'dash', 'lc-lmdh', undefined);
  check(
    'LC-LMDH dash view sits ahead of tuned eye with clean pitch',
    Boolean(dashView && dashView.pos.z > tuned.cockpit.pos.z + 0.1 && Math.abs(dashView.pitchRad * THREE.MathUtils.RAD2DEG - -5) < 0.1),
    dashView ? `z=${dashView.pos.z.toFixed(3)}, pitch=${(dashView.pitchRad * THREE.MathUtils.RAD2DEG).toFixed(1)}°` : 'null'
  );

  // Synthetic BODY with a vertical center wiper triangle + a wide roof header triangle
  const body = new THREE.Group();
  const geo = new THREE.BufferGeometry();
  const verts = new Float32Array([
    // Wiper blade triangle (inside center wiper box)
    0.0, 0.76, 1.48,
    0.005, 0.96, 1.08,
    -0.005, 0.96, 1.08,
    // Wide roof header triangle (must NOT move)
    -0.30, 0.94, 1.10,
    0.30, 0.94, 1.10,
    0.0, 0.95, 1.12,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ name: 'carbon_weave' }));
  body.add(mesh);

  const movedCount = parkLcLmdhWiper(body);
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  const bladeTipX = posAttr.getX(1);
  const bladeTipY = posAttr.getY(1);
  const roofUntouched = Math.abs(posAttr.getX(3) - -0.3) < 1e-5 && Math.abs(posAttr.getY(5) - 0.95) < 1e-5;
  check(
    'parkLcLmdhWiper sweeps vertical center wiper onto lower passenger cowl without touching roof',
    movedCount === 3 && bladeTipX < -0.25 && bladeTipY < 0.76 && roofUntouched,
    `moved=${movedCount}, tip=(${bladeTipX.toFixed(3)}, ${bladeTipY.toFixed(3)}), roofOk=${roofUntouched}`
  );

  // Per-car seat persistence round-trip
  let nudges = stepNudge(undefined, 'lc-lmdh', 'cockpit', { up: 0.03, fwd: 0.05, tiltDeg: -1.5, fovDeg: 4 });
  nudges = stepNudge(nudges, 'amg-gt3', 'cockpit', { up: -0.02 });
  const reloaded = parseCameraNudges(JSON.parse(JSON.stringify(nudges)));
  const lmdhNudge = nudgeOf(reloaded, 'lc-lmdh', 'cockpit');
  const gt3Nudge = nudgeOf(reloaded, 'amg-gt3', 'cockpit');
  check(
    'Seat adjustments persist per-car cleanly across JSON round-trip',
    lmdhNudge.up === 0.03 && lmdhNudge.fwd === 0.05 && lmdhNudge.tiltDeg === -1.5 && lmdhNudge.fovDeg === 4 && gt3Nudge.up === -0.02 && gt3Nudge.fwd === 0
  );
}

// ---------------------------------------------------------------------------
// 3. LC-LMDH steering lock (360-420 deg)
// ---------------------------------------------------------------------------
console.log('\n== 3. LC-LMDH steering lock (360-420 deg)');
{
  const wheelLock = CAR_WHEEL_LOCKS_DEG['lc-lmdh'];
  const effectiveLock = carWheelLockDeg('lc-lmdh');
  const ratioCfg = LC_LMDH_CONFIG.chassis.powerSteering?.steeringRatio ?? NaN;
  const ratioSim = LC_LMDH_SIM_PROFILE.steerRatio;
  const ratioSetup = STEER_RATIO_BASE['lc-lmdh'];
  const physLock = 2 * LC_LMDH_CONFIG.chassis.maxRoadWheelDeg * ratioCfg;
  const hairpinRimDeg = 0.85 * (effectiveLock / 2);

  check(
    'LC-LMDH wheel lock-to-lock sits in prototype 360-420 deg window',
    wheelLock >= 360 && wheelLock <= 420 && effectiveLock === wheelLock,
    `${wheelLock}°`
  );
  check(
    'LC-LMDH steering ratio is unified across config, sim profile, and setup base',
    ratioCfg === ratioSim && ratioSim === ratioSetup,
    `cfg=${ratioCfg}, sim=${ratioSim}, setup=${ratioSetup}`
  );
  check(
    'LC-LMDH physics rim lock matches wheel lock within 2 deg and stays upright (<180 deg) at 85% lock',
    Math.abs(physLock - wheelLock) <= 2 && hairpinRimDeg < 180,
    `phys=${physLock.toFixed(1)}°, visual@85%=${hairpinRimDeg.toFixed(1)}°`
  );
}

// ---------------------------------------------------------------------------
// 4. LC-LMDH braking calibration vs F1 2026
// ---------------------------------------------------------------------------
console.log('\n== 4. LC-LMDH braking calibration vs F1 2026');
{
  const pad = createFlatTestTrack(4000, 60);
  const DT = 1 / 120;
  function measureStop300To100(sim: F12026CarSim) {
    sim.assistPreset = 'assisted';
    sim.teleportToDistance(200, 305 / 3.6);
    for (let t = 0; t < 0.25; t += DT) sim.step(DT, { throttle: 0.4 });
    let p0: THREE.Vector3 | null = null;
    let p1: THREE.Vector3 | null = null;
    let t0 = 0;
    let t1 = 0;
    let prevV = sim.telemetry.speedKmh / 3.6;
    const decels: number[] = [];
    for (let i = 0; i < 1200; i++) {
      sim.step(DT, { brake: 1 });
      const vMs = sim.telemetry.speedKmh / 3.6;
      const g = Math.max(0, (prevV - vMs) / DT / 9.81);
      prevV = vMs;
      if (p0 === null && sim.telemetry.speedKmh <= 300) {
        p0 = sim.vehicle.position.clone();
        t0 = i * DT;
      }
      if (p0 !== null) {
        decels.push(g);
        if (sim.telemetry.speedKmh <= 100) {
          p1 = sim.vehicle.position.clone();
          t1 = i * DT;
          break;
        }
      }
    }
    decels.sort((a, b) => a - b);
    const p98 = decels[Math.min(decels.length - 1, Math.floor(decels.length * 0.98))] ?? 0;
    const mean = decels.reduce((a, b) => a + b, 0) / Math.max(1, decels.length);
    return { distM: p0 && p1 ? p0.distanceTo(p1) : 0, timeS: t1 - t0, p98G: p98, meanG: mean };
  }

  const lmdhStop = measureStop300To100(createLcLmdhSim(pad));
  const f1Stop = measureStop300To100(new F12026CarSim(pad));
  check(
    'LC-LMDH peak braking decel sits in authentic LMH/LMDh 3.2-3.8 g band',
    lmdhStop.p98G >= 3.2 && lmdhStop.p98G <= 3.8 && lmdhStop.meanG >= 2.3 && lmdhStop.meanG <= 2.8,
    `p98=${lmdhStop.p98G.toFixed(2)} g, mean=${lmdhStop.meanG.toFixed(2)} g`
  );
  check(
    'LC-LMDH 300->100 km/h braking distance is notably longer than F1 2026 (>= +25 m)',
    lmdhStop.distM >= f1Stop.distM + 25 && lmdhStop.distM >= 115 && lmdhStop.distM <= 130,
    `LMDH ${lmdhStop.distM.toFixed(1)} m vs F1 2026 ${f1Stop.distM.toFixed(1)} m (+${(lmdhStop.distM - f1Stop.distM).toFixed(1)} m)`
  );
}

// ---------------------------------------------------------------------------
// 5. AMG GT3 downshift exhaust pop toning & randomization
// ---------------------------------------------------------------------------
console.log('\n== 5. AMG GT3 downshift exhaust pop toning & randomization');
{
  interface RecordedPop {
    bufferId: number;
    gain: number;
    rate: number;
    startTime: number;
    delay: number;
  }

  function makeMockAudioCtx() {
    let currentTime = 0;
    const pops: RecordedPop[] = [];
    const makeParam = (initial = 0) => ({
      value: initial,
      setTargetAtTime() {},
      setValueAtTime() {},
      cancelScheduledValues() {},
    });
    const ctx = {
      get currentTime() {
        return currentTime;
      },
      advance(dt: number) {
        currentTime += dt;
      },
      destination: {},
      createGain() {
        const gain = makeParam(1);
        return { gain, connect() {}, disconnect() {} };
      },
      createBiquadFilter() {
        return {
          type: 'lowpass',
          frequency: makeParam(1000),
          Q: makeParam(0.7),
          gain: makeParam(0),
          connect() {},
          disconnect() {},
        };
      },
      createBufferSource() {
        let gainNode: { gain: { value: number } } | null = null;
        const playbackRate = makeParam(1);
        const src = {
          buffer: null as ({ id: number; duration: number } | null),
          loop: false,
          playbackRate,
          onended: null as (() => void) | null,
          connect(dest: { gain?: { value: number } }) {
            if (dest.gain) gainNode = dest as { gain: { value: number } };
          },
          disconnect() {},
          start(when = currentTime) {
            if (!src.loop && src.buffer && src.buffer.id >= 100) {
              pops.push({
                bufferId: src.buffer.id,
                gain: gainNode?.gain.value ?? 1,
                rate: playbackRate.value,
                startTime: when,
                delay: when - currentTime,
              });
            }
          },
          stop() {},
        };
        return src;
      },
    };
    return { ctx, pops };
  }

  function makeSeededRng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
  }

  function runDownshiftSession(popTuning?: typeof AMG_GT3_POP_TUNING) {
    const { ctx, pops } = makeMockAudioCtx();
    const bank = new Lc26SoundBank(
      ctx as unknown as AudioContext,
      ctx.destination as AudioNode,
      '/gt3/audio/',
      popTuning,
      makeSeededRng(42)
    );
    const manifest: Lc26AudioManifest = {
      sampleRate: 48000,
      loopSeconds: 1,
      engine: { ext: [], int: [] },
      turbo: [],
      transmission: [],
      oneshots: [],
      throttleCurve: { ext: [[0, 0], [1, 1]], int: [[0, 0], [1, 1]] },
      lift: { popMinRpm: 4500, crackleMinRpm: 5000, downshiftPopChance: 0.5 },
    };
    // Wire internal state cleanly for headless deterministic testing
    const internal = bank as unknown as {
      ready: boolean;
      manifest: Lc26AudioManifest;
      engine: Record<'ext' | 'int', { on: { update(): void }; off: { update(): void } }>;
      oneshots: Map<string, AudioBuffer[]>;
    };
    internal.ready = true;
    internal.manifest = manifest;
    internal.engine = {
      ext: { on: { update() {} }, off: { update() {} } },
      int: { on: { update() {} }, off: { update() {} } },
    };
    internal.oneshots.set(
      'backfire_int',
      [101, 102, 103].map((id) => ({ id, duration: 0.6 }) as unknown as AudioBuffer)
    );

    const DT = 0.02;
    // Simulate 12 braking zones: full throttle -> lift -> rapid 6->5->4->3->2 downshifts
    for (let zone = 0; zone < 12; zone++) {
      // Approach flat out in 6th
      for (let i = 0; i < 15; i++) {
        ctx.advance(DT);
        bank.update({ rpm: 7200, throttle: 1, pedal: 1, gear: 6, speedKmh: 240, boostBarGauge: 0, view: 'int', limiterRpm: 7900 }, DT);
      }
      // Lift off & cascade downshifts every 0.22 s
      let gear = 6;
      for (let step = 0; step < 50; step++) {
        if (step > 0 && step % 11 === 0 && gear > 2) gear--;
        ctx.advance(DT);
        bank.update({ rpm: 6200, throttle: 0, pedal: 0, gear, speedKmh: 160, boostBarGauge: 0, view: 'int', limiterRpm: 7900 }, DT);
      }
    }
    return pops;
  }

  const defaultPops = runDownshiftSession(undefined);
  const gt3Pops = runDownshiftSession(AMG_GT3_SOUND.popTuning);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const defaultMeanGain = mean(defaultPops.map((p) => p.gain));
  const gt3MeanGain = mean(gt3Pops.map((p) => p.gain));
  const gt3MaxGain = Math.max(...gt3Pops.map((p) => p.gain), 0);
  const gt3Rates = gt3Pops.map((p) => p.rate);
  const rateSpread = Math.max(...gt3Rates) - Math.min(...gt3Rates);
  const distinctDelays = new Set(gt3Pops.map((p) => p.delay.toFixed(4))).size;
  let consecutiveRepeats = 0;
  for (let i = 1; i < gt3Pops.length; i++) {
    if (gt3Pops[i].bufferId === gt3Pops[i - 1].bufferId) consecutiveRepeats++;
  }

  check(
    'AMG GT3 pop gain is significantly toned down vs default (<= 0.24 peak)',
    gt3Pops.length >= 10 && gt3MaxGain <= 0.24 && gt3MeanGain < defaultMeanGain * 0.58,
    `GT3 mean=${gt3MeanGain.toFixed(3)} max=${gt3MaxGain.toFixed(3)} vs default mean=${defaultMeanGain.toFixed(3)}`
  );
  check(
    'AMG GT3 fires fewer pops than default (no rapid-fire machine-gun crackle)',
    gt3Pops.length < defaultPops.length * 0.72,
    `GT3 ${gt3Pops.length} pops vs default ${defaultPops.length} pops`
  );
  check(
    'AMG GT3 pops randomize pitch, timing, and avoid back-to-back identical buffer repeats',
    rateSpread >= 0.08 && distinctDelays >= 5 && consecutiveRepeats === 0,
    `rateSpread=${rateSpread.toFixed(3)}, distinctDelays=${distinctDelays}, repeats=${consecutiveRepeats}`
  );
}

console.log('');
if (failed > 0) {
  console.error(`${failed} check(s) failed.`);
  process.exit(1);
}
console.log('All LC-LMDH cockpit/physics & GT3 audio checks passed.');
