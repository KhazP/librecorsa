/**
 * Headless checks for weather, time of day, wet tyres and the realism levels.
 *
 *   npx tsx scripts/verify-weather.ts
 *
 *  1. Wet tyre model (`wet-tyres.ts`): slick / intermediate / full-wet grip vs water depth and speed
 *  2. Weather state (`weather.ts`): golden-hour default unchanged, rain wets / drying dries, cars dry the line,
 *     dynamic weather is deterministic, host sync round-trips
 *  3. f12026-car (`VehiclePhysics`): peak lateral g and braking dry vs wet per compound, rain tyres overheat in the dry
 *  4. LC26 tyre (`ac-tyre.ts`): peak lateral force per compound dry vs wet, rain tyres overheat in the dry
 *  5. Realism levels: casual has no wear / fuel use, full is the default
 *  6. AI: weather pace and tyre call
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { getActiveTrackData } from '../src/lib/track-data';
import { parsePlayerSettings } from '../src/lib/settings/player-settings';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { F12026_CAR_CONFIG } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { computeTyreForces, createTyreRuntime, updateTyreThermal } from '../src/lib/sim/ac-tyre';
import { LC26_TYRES } from '../src/lib/sim/lc26-data';
import {
  dynamicBristleRelaxationScale,
  evaluateFlashTempAndWlfGrip,
  isRearFlapAllowedInWet,
  recommendedCompound,
  remainingTreadDepthMm,
  SLICK_TRAITS,
  WET_TYRE_TRAITS,
  wetGripFactor,
  wetGrooveGripEffect,
  wetnessFromWater,
  wetPneumaticTrailScale,
} from '../src/lib/sim/wet-tyres';
import {
  applyConditionsChoice,
  DEFAULT_SESSION_CONDITIONS,
  defaultWeatherNodesForPreset,
  effectiveConditions,
  resolveTimeOfDay,
  dynamicWeatherAt,
  GOLDEN_HOUR_CLOCK_H,
  interpolateWeatherNodes,
  nearestSkyCover,
  sanitizeConditions,
  sanitizeWeatherSync,
  type SessionConditions,
  sunPosition,
  TIME_OF_DAY_HOURS,
  TIME_OF_DAY_PRESETS,
  topographicalPuddleFactor,
  WeatherState,
} from '../src/lib/sim/weather';
import {
  AUTO_HEADLIGHT_RAIN,
  AUTO_HEADLIGHT_SUN_DEG,
  CarHeadlights,
  carHasHeadlights,
  headlightProfileFor,
  headlightSpotCountFor,
  resolveHeadlightStates,
  shouldHeadlightsBeOn,
} from '../src/lib/render/car-headlights';
import { evaluateAeroWakeDeficit } from '../src/lib/sim/aero-wake';
import { stepWindscreenWipers } from '../src/lib/render/rain-fx';
import { TrackEvolutionState } from '../src/lib/sim/track-evolution';
import { SIM_REALISM_FLAGS } from '../src/lib/sim/sim-realism';
import { TrackEnvironment } from '../src/lib/sim/track-environment';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { DEFAULT_PLAYER_SETTINGS } from '../src/lib/settings/player-settings';
import type { TireCompound } from '../src/types/f1';
import type { SimulatorCar } from '../src/lib/sim/simulator-car';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);
const COMPOUNDS: TireCompound[] = ['medium', 'intermediate', 'wet'];
const grip = (c: TireCompound, mm: number, kmh: number) => WET_TYRE_TRAITS[c].dryGrip * wetGripFactor(WET_TYRE_TRAITS[c], mm, kmh / 3.6);

// ---------------------------------------------------------------------------
// 1. Wet tyre model
// ---------------------------------------------------------------------------
console.log('\n== Wet tyre model (grip relative to a dry slick)');
for (const mm of [0, 0.1, 0.3, 0.6, 1.2, 2.4]) {
  console.log(`      ${fmt(mm, 1)} mm   ` + COMPOUNDS.map((c) => `${c.padEnd(12)} ${fmt(grip(c, mm, 120))} @120 ${fmt(grip(c, mm, 250))} @250`).join('   '));
}
check('Dry: slick > intermediate > wet', grip('medium', 0, 200) > grip('intermediate', 0, 200) && grip('intermediate', 0, 200) > grip('wet', 0, 200), COMPOUNDS.map((c) => fmt(grip(c, 0, 200))).join(' / '));
check('Damp (0.05 mm): slicks still the quickest', grip('medium', 0.05, 200) > grip('intermediate', 0.05, 200), `${fmt(grip('medium', 0.05, 200))} vs ${fmt(grip('intermediate', 0.05, 200))}`);
check('Wet (0.5 mm): intermediate the quickest', grip('intermediate', 0.5, 200) > grip('wet', 0.5, 200) && grip('intermediate', 0.5, 200) > grip('medium', 0.5, 200) + 0.2, COMPOUNDS.map((c) => fmt(grip(c, 0.5, 200))).join(' / '));
check('Standing water (2.4 mm): full wet the quickest', grip('wet', 2.4, 200) > grip('intermediate', 2.4, 200) + 0.2, COMPOUNDS.map((c) => fmt(grip(c, 2.4, 200))).join(' / '));
check('Slicks aquaplane at speed in standing water', grip('medium', 2.4, 250) < 0.2, fmt(grip('medium', 2.4, 250)));
check('Aquaplaning grows with speed (inters, 1.5 mm)', grip('intermediate', 1.5, 280) < grip('intermediate', 1.5, 100) - 0.2, `${fmt(grip('intermediate', 1.5, 100))} @100 → ${fmt(grip('intermediate', 1.5, 280))} @280`);
check('Recommended tyre follows the water', recommendedCompound(0) === 'medium' && recommendedCompound(0.5) === 'intermediate' && recommendedCompound(2) === 'wet', `${recommendedCompound(0)} / ${recommendedCompound(0.5)} / ${recommendedCompound(2)}`);

// ---------------------------------------------------------------------------
// 2. Weather state
// ---------------------------------------------------------------------------
console.log('\n== Weather & time of day');
{
  const sun = sunPosition(GOLDEN_HOUR_CLOCK_H);
  const w = new WeatherState(5300);
  check('Default is clear golden hour', DEFAULT_SESSION_CONDITIONS.weather === 'clear' && DEFAULT_SESSION_CONDITIONS.timeOfDay === 'golden_hour', `${DEFAULT_SESSION_CONDITIONS.weather}, ${DEFAULT_SESSION_CONDITIONS.timeOfDay}`);
  check('Golden hour keeps the 14° / 127° sun', Math.abs(sun.elevationDeg - 14) < 1e-6 && Math.abs(sun.azimuthDeg - 127) < 1e-6, `${fmt(sun.elevationDeg, 3)}° / ${fmt(sun.azimuthDeg, 3)}°`);
  for (let i = 0; i < 600; i++) w.step(1);
  check('Default stays 27 °C air / 41 °C track, dry', Math.abs(w.ambientC - 27) < 1e-6 && Math.abs(w.trackTempC - 41) < 1e-6 && w.waterMm === 0, `${fmt(w.ambientC, 3)} / ${fmt(w.trackTempC, 3)} °C, ${w.waterMm} mm`);
  check('Noon sun is high', sunPosition(TIME_OF_DAY_HOURS.noon).elevationDeg > 70, `${fmt(sunPosition(TIME_OF_DAY_HOURS.noon).elevationDeg, 1)}°`);

  const rain = new WeatherState(5300, { ...DEFAULT_SESSION_CONDITIONS, weather: 'heavy_rain' });
  check('Heavy rain: standing water, cool track', rain.waterMm > 1.5 && rain.trackTempC < rain.ambientC + 2, `${fmt(rain.waterMm)} mm, ${fmt(rain.ambientC, 1)} / ${fmt(rain.trackTempC, 1)} °C`);

  const dry = new WeatherState(5300, { ...DEFAULT_SESSION_CONDITIONS, weather: 'drying', timeOfDay: 'afternoon' });
  const lineCar = new WeatherState(5300, { ...DEFAULT_SESSION_CONDITIONS, weather: 'drying', timeOfDay: 'afternoon' });
  const w0 = dry.waterMm;
  // 6 cars at 60 m/s on the line for 8 min
  for (let t = 0; t < 480; t += 0.05) {
    dry.step(0.05);
    lineCar.step(0.05);
    for (let c = 0; c < 6; c++) lineCar.depositCarPass((t * 60 + c * 400) % 5300, 0, 60, 0.05);
  }
  const onLine = lineCar.waterAt(1000, 0, 0);
  const offLine = lineCar.waterAt(1000, 6, 0);
  check('Drying: the track dries', dry.waterMm < w0 * 0.75, `${fmt(w0)} → ${fmt(dry.waterMm)} mm in 8 min`);
  check('Drying: the cars dry the racing line first', onLine < offLine * 0.6, `line ${fmt(onLine)} mm vs ${fmt(offLine)} mm off it`);

  const a = dynamicWeatherAt(7, 1234);
  const b = dynamicWeatherAt(7, 1234);
  let rained = false;
  for (let s = 0; s < 3600 * 2; s += 30) if (dynamicWeatherAt(7, s).rain > 0.2) rained = true;
  check('Dynamic weather is deterministic and rains at times', a.cloud === b.cloud && a.rain === b.rain && rained, `cloud ${fmt(a.cloud)} rain ${fmt(a.rain)}`);

  const host = new WeatherState(5300, { ...DEFAULT_SESSION_CONDITIONS, weather: 'light_rain', timeScale: 5 });
  for (let i = 0; i < 100; i++) host.step(1);
  const guest = new WeatherState(5300);
  const snap = sanitizeWeatherSync(JSON.parse(JSON.stringify(host.snapshot())));
  if (snap) guest.applySync(snap);
  check('Host weather sync round-trips', !!snap && guest.conditions.weather === 'light_rain' && Math.abs(guest.waterMm - host.waterMm) < 1e-9 && Math.abs(guest.clockH - host.clockH) < 1e-9, `${guest.conditions.weather}, ${fmt(guest.waterMm, 3)} mm, ${fmt(guest.clockH, 3)} h`);
  check('Garbage sync is refused', sanitizeWeatherSync({ clockH: 'x' }) === null, 'null');

  // Night preset & car headlights (#142)
  const nightSun = sunPosition(TIME_OF_DAY_HOURS.night);
  const nightW = new WeatherState(5300, { ...DEFAULT_SESSION_CONDITIONS, timeOfDay: 'night', timeScale: 60 });
  check('Night preset is listed and puts the sun well below the horizon', TIME_OF_DAY_PRESETS.includes('night') && nightSun.elevationDeg < -15, `clock ${TIME_OF_DAY_HOURS.night} h, elev ${fmt(nightSun.elevationDeg, 1)}°`);
  check('Night survives sanitizeConditions', sanitizeConditions({ timeOfDay: 'night' }).timeOfDay === 'night', 'night');
  // Advance 3 hours of sim time across midnight (21.5 -> 0.5)
  for (let i = 0; i < 180; i++) nightW.step(1);
  check('Night clock wraps cleanly across midnight with timeScale > 0', nightW.clockH > 0 && nightW.clockH < 1.5, `${fmt(nightW.clockH, 2)} h`);
  // Online sync across the 0/24 h midnight wrap must blend through midnight (~0 h), never jump through noon (~12 h)
  const nightCond = { ...DEFAULT_SESSION_CONDITIONS, timeOfDay: 'night' as const, timeScale: 60 };
  const guestPre = new WeatherState(5300, nightCond);
  guestPre.clockH = 23.95;
  const hostPost = new WeatherState(5300, nightCond);
  hostPost.clockH = 0.05;
  guestPre.applySync(hostPost.snapshot());
  const distToMidnightFwd = Math.min(guestPre.clockH, 24 - guestPre.clockH);
  const guestPost = new WeatherState(5300, nightCond);
  guestPost.clockH = 0.05;
  const hostPre = new WeatherState(5300, nightCond);
  hostPre.clockH = 23.95;
  guestPost.applySync(hostPre.snapshot());
  const distToMidnightRev = Math.min(guestPost.clockH, 24 - guestPost.clockH);
  check(
    'Online sync blends across 0/24 h midnight without jumping to noon',
    distToMidnightFwd < 0.05 && distToMidnightRev < 0.05,
    `23.95→0.05 => ${fmt(guestPre.clockH, 3)} h, 0.05→23.95 => ${fmt(guestPost.clockH, 3)} h`,
  );
  check(
    'Auto headlights turn on at night / dusk / heavy rain and stay off in clear daylight',
    shouldHeadlightsBeOn('auto', nightSun.elevationDeg, 0) &&
      shouldHeadlightsBeOn('auto', 2, 0) &&
      shouldHeadlightsBeOn('auto', 40, 0.6) &&
      !shouldHeadlightsBeOn('auto', 14, 0) &&
      shouldHeadlightsBeOn('on', 60, 0) &&
      !shouldHeadlightsBeOn('off', nightSun.elevationDeg, 1),
    'auto/on/off',
  );
  check(
    'SpotLight budget skips daytime-only sessions, uses 1 on Low and Medium and 2 on High',
    headlightSpotCountFor({ ...DEFAULT_SESSION_CONDITIONS, timeOfDay: 'noon', weather: 'clear', timeScale: 0 }, 'high') === 0 &&
      headlightSpotCountFor({ ...DEFAULT_SESSION_CONDITIONS, timeOfDay: 'night' }, 'low') === 1 &&
      headlightSpotCountFor({ ...DEFAULT_SESSION_CONDITIONS, timeOfDay: 'night' }, 'medium') === 1 &&
      headlightSpotCountFor({ ...DEFAULT_SESSION_CONDITIONS, timeOfDay: 'night' }, 'high') === 2 &&
      headlightSpotCountFor({ ...DEFAULT_SESSION_CONDITIONS, timeOfDay: 'noon', timeScale: 10 }, 'medium') === 1 &&
      headlightSpotCountFor({ ...DEFAULT_SESSION_CONDITIONS, timeOfDay: 'noon', weather: 'light_rain' }, 'high') === 2,
    'day=0, low=1, med=1, high=2',
  );
  const hlRoot = new THREE.Group();
  const placeholder = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshStandardMaterial({ name: 'placeholder' }));
  hlRoot.add(placeholder);
  const hl = new CarHeadlights('amg-gt3', { spotCount: 2 });
  hl.attach(hlRoot);
  hl.setEnabled(true, true);
  // Simulate async GLB load replacing placeholder with bodyGroup (same direct child count: 2 === 2)
  placeholder.removeFromParent();
  const bodyGroup = new THREE.Group();
  // Shared `light_004` material on both front and rear meshes (and another car): must clone separately for front
  // (white headlight) and rear (red taillight/brake) without mutating the shared template material
  const sharedLight004 = new THREE.MeshStandardMaterial({ name: 'light_004', emissive: new THREE.Color(0x000000), emissiveIntensity: 0 });
  const frontMesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), sharedLight004);
  frontMesh.position.set(0.6, 0.5, 2.4);
  const rearMesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), sharedLight004);
  rearMesh.position.set(0.6, 0.6, -2.3);
  const gt3LightMat = new THREE.MeshStandardMaterial({ name: 'MI_Mercedes_AMG_GT3_Evo_Lights', emissive: new THREE.Color(0x000000), emissiveIntensity: 0 });
  const frontMesh2 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), gt3LightMat);
  frontMesh2.position.set(-0.6, 0.5, 2.4);
  // Span mesh across both front and rear must NEVER be misclassified as front-only or rear-only
  const spanLightMat = new THREE.MeshStandardMaterial({ name: 'light_025', emissive: new THREE.Color(0x000000), emissiveIntensity: 0 });
  const spanMesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 3.8), spanLightMat);
  spanMesh.position.set(0, 0.5, 0);
  bodyGroup.add(frontMesh, rearMesh, frontMesh2, spanMesh);
  hlRoot.add(bodyGroup);
  hl.setEnabled(true, true);
  const spots = hl.group.children.filter((c): c is THREE.SpotLight => c instanceof THREE.SpotLight);
  const sprites = hl.group.children.filter((c): c is THREE.Sprite => c instanceof THREE.Sprite);
  const frontSprites = sprites.filter((s) => s.position.z > 0);
  const rearSprites = sprites.filter((s) => s.position.z < 0);
  const allForward = spots.length === 2 && spots.every((s) => s.intensity > 0 && s.target.position.z > s.position.z + 20);
  const frontClonedMat = frontMesh.material as THREE.MeshStandardMaterial;
  const frontClonedMat2 = frontMesh2.material as THREE.MeshStandardMaterial;
  const rearClonedMat = rearMesh.material as THREE.MeshStandardMaterial;
  const clonedAndIsolated =
    frontClonedMat !== sharedLight004 &&
    frontClonedMat.emissiveIntensity > 1 &&
    frontClonedMat2 !== gt3LightMat &&
    frontClonedMat2.emissiveIntensity > 1 &&
    rearClonedMat !== sharedLight004 &&
    rearClonedMat !== frontClonedMat &&
    rearClonedMat.emissiveIntensity > 2 &&
    rearClonedMat.emissive.r > 0.8 &&
    rearClonedMat.emissive.g < 0.3 &&
    spanMesh.material === spanLightMat &&
    sharedLight004.emissiveIntensity === 0 &&
    gt3LightMat.emissiveIntensity === 0 &&
    spanLightMat.emissiveIntensity === 0;
  // Measured per-car profiles keep their exact GLB-measured lens Z (not pushed back by rear wings or test boxes)
  const amgProfile = headlightProfileFor('amg-gt3');
  const measuredPlacementOk =
    amgProfile.measured === true &&
    frontSprites.every((s) => Math.abs(s.position.z - amgProfile.frontZM) < 1e-4) &&
    rearSprites.length === (amgProfile.rearLamps?.length ?? 2) &&
    rearSprites.every((s, i) => Math.abs(s.position.z - (amgProfile.rearLamps?.[i].z ?? amgProfile.rearZM)) < 1e-4);
  // Directional per-flare visibility: behind car hides front; nose/dash cam (z=1.5 > 0 but behind flares) hides front too; ahead shows front unless onboard-hidden
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(0, 1.2, -6);
  hl.setEnabled(true, false, cam);
  const chaseOk = frontSprites.every((s) => !s.visible) && rearSprites.every((s) => s.visible);
  const rearRunningIntensity = rearClonedMat.emissiveIntensity;
  cam.position.set(0, 0.7, 1.5);
  hl.setEnabled(true, false, cam);
  const noseCamOk = frontSprites.every((s) => !s.visible) && rearSprites.every((s) => !s.visible);
  cam.position.set(0, 1.2, 10);
  hl.setEnabled(true, false, cam, false);
  const frontViewOk = frontSprites.every((s) => s.visible) && rearSprites.every((s) => !s.visible);
  hl.setEnabled(true, false, cam, true);
  const onboardHideOk = frontSprites.every((s) => !s.visible);
  hl.setEnabled(false);
  const restored = spots.every((s) => s.intensity === 0) && frontClonedMat.emissiveIntensity === 0 && rearClonedMat.emissiveIntensity === 0;
  // Daytime brake lights: rear sprites and rear emissive lenses light up under braking behind the car even when
  // headlights are off, while front flares, spots and boosted lenses stay off, and releasing brake turns them back off
  cam.position.set(0, 1.2, -6);
  hl.setEnabled(false, true, cam);
  const daytimeBrakeBehind =
    spots.every((s) => s.intensity === 0) &&
    frontClonedMat.emissiveIntensity === 0 &&
    rearClonedMat.emissiveIntensity > rearRunningIntensity &&
    frontSprites.every((s) => !s.visible) &&
    rearSprites.every((s) => s.visible) &&
    (rearSprites[0].material as THREE.SpriteMaterial).opacity > 0.7;
  cam.position.set(0, 1.2, 10);
  hl.setEnabled(false, true, cam);
  const daytimeBrakeFrontHidden = rearSprites.every((s) => !s.visible) && frontSprites.every((s) => !s.visible);
  cam.position.set(0, 1.2, -6);
  hl.setEnabled(false, false, cam);
  const daytimeCoastOff =
    !hl.isBraking &&
    rearClonedMat.emissiveIntensity === 0 &&
    rearSprites.every((s) => !s.visible) &&
    frontSprites.every((s) => !s.visible);
  // Toggling headlights off while braking keeps rear brake lights lit while shutting down beams, front flares and lenses
  hl.setEnabled(true, true, cam);
  hl.setEnabled(false, true, cam);
  const toggleOffWhileBrakingOk =
    !hl.isOn &&
    hl.isBraking &&
    spots.every((s) => s.intensity === 0) &&
    frontClonedMat.emissiveIntensity === 0 &&
    rearClonedMat.emissiveIntensity > rearRunningIntensity &&
    frontSprites.every((s) => !s.visible) &&
    rearSprites.every((s) => s.visible) &&
    (rearSprites[0].material as THREE.SpriteMaterial).opacity > 0.7;
  // Flash (high beam): lights the front lamps in daylight with the headlights off, brighter, further and aimed higher
  // than the low beam; the rear lamps and the headlight state are left alone, and it ends cleanly
  hl.setEnabled(false, false, cam);
  hl.setEnabled(true, false, cam);
  const lowBeamIntensity = spots[0].intensity;
  const lowBeamAimY = spots[0].target.position.y;
  hl.setEnabled(false, false, cam);
  cam.position.set(0, 1.2, 10);
  hl.setFlash(true);
  hl.setEnabled(false, false, cam);
  const flashDayOk =
    !hl.isOn &&
    hl.isFlashing &&
    spots.every((s) => s.intensity > lowBeamIntensity * 1.5) &&
    spots[0].target.position.y > lowBeamAimY &&
    frontSprites.every((s) => s.visible && s.scale.x > amgProfile.flareSizeM * 1.5) &&
    (frontSprites[0].material as THREE.SpriteMaterial).opacity > 0.5 &&
    frontClonedMat.emissiveIntensity > 4.5 &&
    rearSprites.every((s) => !s.visible) &&
    rearClonedMat.emissiveIntensity === 0;
  hl.setFlash(false);
  hl.setEnabled(false, false, cam);
  const flashEndOk =
    !hl.isFlashing &&
    spots.every((s) => s.intensity === 0) &&
    frontSprites.every((s) => !s.visible) &&
    frontClonedMat.emissiveIntensity === 0;
  hl.setEnabled(false, false, cam);
  hl.dispose();
  const originalRestored =
    frontMesh.material === sharedLight004 &&
    rearMesh.material === sharedLight004 &&
    frontMesh2.material === gt3LightMat &&
    spanMesh.material === spanLightMat;
  check(
    'CarHeadlights clones front/rear lights separately, skips spanning meshes, gates per-flare and restores on dispose',
    allForward && clonedAndIsolated && measuredPlacementOk && chaseOk && noseCamOk && frontViewOk && onboardHideOk && restored && originalRestored,
    `${spots.length} spots, frontZ=${frontSprites[0]?.position.z.toFixed(2)}, rearZ=${rearSprites[0]?.position.z.toFixed(2)}`,
  );
  // Regression check: rotating a car 45 deg in world space (e.g. diagonal start grid) must NEVER inflate AABB Z bounds
  // or misclassify front/rear meshes, and high rear wings must not push fallback rear flares backwards.
  const makeRotatedRig = (yaw: number) => {
    const root = new THREE.Group();
    root.position.set(123, 0, -456);
    root.rotation.y = yaw;
    const body = new THREE.Group();
    // Wide, long chassis block at lamp height (2.0 x 0.4 x 4.4 m) + high rear wing extending to z = -2.8 m
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.4, 4.4), new THREE.MeshStandardMaterial({ name: 'paint' }));
    chassis.position.set(0, 0.65, 0);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.2, 0.4), new THREE.MeshStandardMaterial({ name: 'wing' }));
    wing.position.set(0, 1.25, -2.6);
    body.add(chassis, wing);
    root.add(body);
    const fallbackHl = new CarHeadlights('unmeasured-fallback' as never, { lightsOnly: true });
    fallbackHl.attach(root);
    fallbackHl.setEnabled(true, true);
    const rearZ = fallbackHl.group.children.find((c): c is THREE.Sprite => c instanceof THREE.Sprite && c.position.z < 0)!.position.z;
    const frontZ = fallbackHl.group.children.find((c): c is THREE.Sprite => c instanceof THREE.Sprite && c.position.z > 0)!.position.z;
    fallbackHl.dispose();
    return { frontZ, rearZ };
  };
  const rot0 = makeRotatedRig(0);
  const rot45 = makeRotatedRig(Math.PI / 4);
  const rotationInvariantOk =
    Math.abs(rot0.rearZ - rot45.rearZ) < 1e-4 &&
    Math.abs(rot0.frontZ - rot45.frontZ) < 1e-4 &&
    rot45.rearZ > -2.35 &&
    rot45.frontZ < 2.35;
  check(
    'CarHeadlights bounds scan is invariant to 45 deg world yaw and ignores high rear wings',
    rotationInvariantOk,
    `yaw0=(${rot0.frontZ.toFixed(2)}, ${rot0.rearZ.toFixed(2)}), yaw45=(${rot45.frontZ.toFixed(2)}, ${rot45.rearZ.toFixed(2)})`,
  );
  // An F1 car has no headlights: no beam, no front flare, no flash; its rear rain light still runs
  const f1Hl = new CarHeadlights('lc26', { spotCount: 2 });
  const f1Spots = f1Hl.group.children.filter((c) => c instanceof THREE.SpotLight);
  const f1Sprites = f1Hl.group.children.filter((c): c is THREE.Sprite => c instanceof THREE.Sprite);
  f1Hl.setFlash(true);
  f1Hl.setEnabled(true, false);
  const f1NoFrontOk =
    !carHasHeadlights('lc26') &&
    carHasHeadlights('amg-gt3') &&
    f1Hl.spotCount === 0 &&
    f1Spots.length === 0 &&
    !f1Hl.isFlashing &&
    f1Sprites.length === (headlightProfileFor('lc26').rearLamps?.length ?? 1) &&
    f1Sprites.every((s) => s.position.z < 0 && s.visible);
  f1Hl.dispose();
  check('an F1 car has no headlights: no beam, no front flare, no flash, rear rain light only', f1NoFrontOk, `spots=${f1Hl.spotCount}`);
  check(
    'CarHeadlights flash: high beam in daylight with the headlights off, then back to dark',
    flashDayOk && flashEndOk,
    `flashDay=${flashDayOk}, flashEnd=${flashEndOk}`,
  );
  check(
    'CarHeadlights illuminates brake lights in daylight while keeping running lights and front beams off',
    daytimeBrakeBehind && daytimeBrakeFrontHidden && daytimeCoastOff && toggleOffWhileBrakingOk,
    `brakeBehind=${daytimeBrakeBehind}, frontHidden=${daytimeBrakeFrontHidden}, coastOff=${daytimeCoastOff}, toggleOffBraking=${toggleOffWhileBrakingOk}`,
  );
  // Medium 1-spot and lightsOnly (opponent) 0-spot modes
  const hlMed = new CarHeadlights('amg-gt3', { spotCount: 1 });
  const hlOpp = new CarHeadlights('amg-gt3', { lightsOnly: true });
  const medSpots = hlMed.group.children.filter((c): c is THREE.SpotLight => c instanceof THREE.SpotLight);
  const oppSpots = hlOpp.group.children.filter((c): c is THREE.SpotLight => c instanceof THREE.SpotLight);
  const oppSprites = hlOpp.group.children.filter((c): c is THREE.Sprite => c instanceof THREE.Sprite);
  // resolveHeadlightStates (used directly by drive-session) keeps opponents on auto even when player toggles on/off
  const nightManualOff = resolveHeadlightStates('off', nightSun.elevationDeg, 0);
  const rainManualOff = resolveHeadlightStates('off', 40, 0.6);
  const dayManualOn = resolveHeadlightStates('on', 40, 0);
  const nightManualOn = resolveHeadlightStates('on', nightSun.elevationDeg, 0);
  const duskAuto = resolveHeadlightStates('auto', 2, 0);
  const rainAuto = resolveHeadlightStates('auto', 40, 0.6);
  const dayAuto = resolveHeadlightStates('auto', 40, 0);
  const atThresholdAuto = resolveHeadlightStates('auto', AUTO_HEADLIGHT_SUN_DEG, AUTO_HEADLIGHT_RAIN);
  hlMed.setEnabled(nightManualOff.player, false);
  hlOpp.setEnabled(nightManualOff.opponents, false);
  const nightAppliedOk = !hlMed.isOn && hlOpp.isOn;
  hlMed.setEnabled(dayManualOn.player, false);
  hlOpp.setEnabled(dayManualOn.opponents, false);
  const dayAppliedOk = hlMed.isOn && !hlOpp.isOn;
  const driveSessionSrc = readFileSync(resolve(process.cwd(), 'src/lib/drive-session.ts'), 'utf8');
  const driveSessionWiredOk =
    /resolveHeadlightStates\(headlightMode,\s*skyConditions\.elevationDeg,\s*wx\.rainIntensity\)/.test(driveSessionSrc) &&
    /carHeadlights\.setEnabled\(headlights\.player,/.test(driveSessionSrc) &&
    /visualFx\.setHeadlights\(headlights\.opponents,/.test(driveSessionSrc);
  const oppIndependentOfPlayerToggle =
    !nightManualOff.player &&
    nightManualOff.opponents &&
    !rainManualOff.player &&
    rainManualOff.opponents &&
    dayManualOn.player &&
    !dayManualOn.opponents &&
    nightManualOn.player &&
    nightManualOn.opponents &&
    duskAuto.player &&
    duskAuto.opponents &&
    rainAuto.player &&
    rainAuto.opponents &&
    !dayAuto.player &&
    !dayAuto.opponents &&
    !atThresholdAuto.player &&
    !atThresholdAuto.opponents &&
    nightAppliedOk &&
    dayAppliedOk &&
    driveSessionWiredOk;
  hlMed.dispose();
  hlOpp.dispose();
  check(
    'CarHeadlights supports 1-spot Medium and lightsOnly (0-spot) opponent modes',
    medSpots.length === 1 && medSpots[0].position.x === 0 && oppSpots.length === 0 && oppSprites.length >= 3,
    `med=${medSpots.length} spot, opp=${oppSpots.length} spots / ${oppSprites.length} flares`,
  );
  check(
    'resolveHeadlightStates & drive-session wiring keep opponents on auto regardless of player toggle',
    oppIndependentOfPlayerToggle,
    `nightOff={p:${nightManualOff.player},o:${nightManualOff.opponents}}, rainOff={p:${rainManualOff.player},o:${rainManualOff.opponents}}, dayOn={p:${dayManualOn.player},o:${dayManualOn.opponents}}, wired=${driveSessionWiredOk}`,
  );
  const allCarIds = [
    'lc26',
    'amg-gt3',
    'bmw-m4-gt3',
    'mtr-496r',
    'lc-lmdh',
    'liana',
    'nissan-r33-jgtc',
    'nissan-r32-jtcc',
    'bmw-m1-procar',
    'vw-scirocco-gtx',
    'chaparral-2d',
    'chaparral-2d-67',
    'porsche-934-rsr',
  ] as const;
  check(
    'Every car in the registry resolves a measured headlight and taillight profile',
    allCarIds.every((id) => {
      const p = headlightProfileFor(id);
      const lampsOk = !p.rearLamps || p.rearLamps.every((l) => l.z < -1.5 && l.y > 0.2 && l.y < 1.2);
      return p.measured === true && p.intensity > 0 && p.distanceM >= 100 && p.frontZM > 1.3 && p.rearZM < -1.5 && lampsOk;
    }) && headlightProfileFor('amg-gt3').halfWidthM > headlightProfileFor('lc26').halfWidthM,
    `${allCarIds.length} cars`,
  );
}

// ---------------------------------------------------------------------------
// 3. f12026-car / GT3 (VehiclePhysics)
// ---------------------------------------------------------------------------
console.log('\n== VehiclePhysics: peak lateral g at 150 km/h and braking 200→80 km/h');
const DT = 1 / 120;
const flat = new FlatGroundQuery();
/**
 * Best lateral g held for half a second on a slow steer ramp at `kmh`: a held mean, not the largest single sample,
 * which the speed-hold pedal's kicks and the road texture move by more than the tyres differ
 */
function peakLateralG(config: typeof F12026_CAR_CONFIG | typeof AMG_GT3_CONFIG, compound: TireCompound, waterMm: number, kmh: number): number {
  const car = new VehiclePhysics({ ground: flat, config, airDensity: 1.06, compound: config.compoundSlots[compound] });
  car.waterMm = waterMm;
  car.wetness = wetnessFromWater(waterMm);
  car.reset(0, 0, 0, kmh / 3.6);
  let pedal = 0.3;
  let best = 0;
  const window: number[] = [];
  let sum = 0;
  const held = Math.round(0.5 / DT);
  for (let t = 0; t < 8; t += DT) {
    pedal = THREE.MathUtils.clamp(pedal + (car.telemetry.speedKmh < kmh ? 0.02 : -0.02), 0, 1);
    car.step(DT, { throttle: pedal, brake: 0, steer: -Math.min(1, t / 8) * 0.9 });
    const lat = Math.abs(car.telemetry.latG);
    window.push(lat);
    sum += lat;
    if (window.length > held) sum -= window.shift()!;
    if (window.length === held) best = Math.max(best, sum / held);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(car.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(car.quaternion);
    if (Math.abs(Math.atan2(car.velocity.dot(right), car.velocity.dot(fwd))) > 0.35) break;
  }
  return best;
}
function brakingDistance(config: typeof F12026_CAR_CONFIG, compound: TireCompound, waterMm: number): number {
  const car = new VehiclePhysics({ ground: flat, config, airDensity: 1.06, compound: config.compoundSlots[compound] });
  car.waterMm = waterMm;
  car.wetness = wetnessFromWater(waterMm);
  car.reset(0, 0, 0, 200 / 3.6);
  let pedal = 1;
  const z0 = car.position.z;
  for (let t = 0; t < 15 && car.telemetry.speedKmh > 80; t += DT) {
    const sr = Math.min(...car.wheels.map((w) => w.slipRatio));
    pedal = THREE.MathUtils.clamp(pedal + (sr < -0.12 ? -0.1 : 0.05), 0.05, 1);
    const inp: VehicleInputs = { throttle: 0, brake: pedal, steer: 0 };
    car.step(DT, inp);
  }
  return car.position.z - z0;
}
for (const [label, cfg] of [['f12026-car', F12026_CAR_CONFIG], ['AMG GT3', AMG_GT3_CONFIG]] as const) {
  const g = (c: TireCompound, mm: number) => peakLateralG(cfg, c, mm, 150);
  const dry = { s: g('medium', 0), i: g('intermediate', 0), w: g('wet', 0) };
  const wet = { s: g('medium', 0.6), i: g('intermediate', 0.6), w: g('wet', 0.6) };
  const flood = { s: g('medium', 2.4), i: g('intermediate', 2.4), w: g('wet', 2.4) };
  console.log(`      ${label}: dry ${fmt(dry.s)} / ${fmt(dry.i)} / ${fmt(dry.w)} g · 0.6 mm ${fmt(wet.s)} / ${fmt(wet.i)} / ${fmt(wet.w)} g · 2.4 mm ${fmt(flood.s)} / ${fmt(flood.i)} / ${fmt(flood.w)} g (slick / inter / wet)`);
  check(`${label}: rain tyres slower in the dry`, dry.s > dry.i && dry.i > dry.w, `${fmt(dry.s)} > ${fmt(dry.i)} > ${fmt(dry.w)} g`);
  check(`${label}: wet road costs slicks most of their grip`, wet.s < 0.75 * dry.s && wet.i > wet.s, `${fmt(wet.s)} vs dry ${fmt(dry.s)}, inter ${fmt(wet.i)} g`);
  check(`${label}: standing water needs full wets`, flood.w > flood.i && flood.w > flood.s * 1.5, `${fmt(flood.w)} vs ${fmt(flood.i)} / ${fmt(flood.s)} g`);
}
{
  const dDry = brakingDistance(F12026_CAR_CONFIG, 'medium', 0);
  const dWetSlick = brakingDistance(F12026_CAR_CONFIG, 'medium', 1.2);
  const dWetWet = brakingDistance(F12026_CAR_CONFIG, 'wet', 1.2);
  check('f12026-car braking: wet road on slicks is far longer', dWetSlick > dDry * 1.6, `dry ${fmt(dDry, 1)} m, 1.2 mm slicks ${fmt(dWetSlick, 1)} m`);
  check('f12026-car braking: full wets stop shorter than slicks in rain', dWetWet < dWetSlick, `wets ${fmt(dWetWet, 1)} m vs slicks ${fmt(dWetSlick, 1)} m`);
}
// Rain tyres in the dry run hot for their window: 90 s of steady 1.7 g cornering at 150 km/h
{
  const soak = (compound: TireCompound, waterMm: number) => {
    const car = new VehiclePhysics({ ground: flat, config: F12026_CAR_CONFIG, airDensity: 1.06, compound: F12026_CAR_CONFIG.compoundSlots[compound] });
    car.waterMm = waterMm;
    car.wetness = wetnessFromWater(waterMm);
    car.reset(0, 0, 0, 150 / 3.6);
    let pedal = 0.3;
    for (let t = 0; t < 90; t += DT) {
      pedal = THREE.MathUtils.clamp(pedal + (car.telemetry.speedKmh < 150 ? 0.02 : -0.02), 0, 1);
      car.step(DT, { throttle: pedal, brake: 0, steer: -0.12 });
    }
    const td = F12026_CAR_CONFIG.tyreCompounds[F12026_CAR_CONFIG.compoundSlots[compound]]!.thermalData;
    const surf = Math.max(...car.wheels.map((w) => w.surfaceTempC));
    return { surf, over: surf - (td.optimalTempC[0] + td.optimalTempC[1]) / 2, window: td.optimalTempC };
  };
  const slick = soak('medium', 0);
  const inter = soak('intermediate', 0);
  const interWet = soak('intermediate', 0.6);
  check('f12026-car: inters run hot for their window in the dry', inter.over > slick.over + 15, `inter ${fmt(inter.surf, 0)} °C (window ${inter.window.join('–')}), slick ${fmt(slick.surf, 0)} °C (${slick.window.join('–')})`);
  check('f12026-car: a wet road cools the tyres', interWet.surf < inter.surf - 8, `inter wet ${fmt(interWet.surf, 0)} vs dry ${fmt(inter.surf, 0)} °C`);
}

// ---------------------------------------------------------------------------
// 4. LC26 tyre (ac-tyre)
// ---------------------------------------------------------------------------
console.log('\n== LC26 tyre (ac-tyre): peak lateral force at 4 kN, 55 m/s');
{
  const peakFy = (c: TireCompound, waterMm: number) => {
    let best = 0;
    for (let deg = 1; deg <= 14; deg += 0.5) {
      const t = createTyreRuntime(LC26_TYRES[c].front, c === 'medium' ? 95 : 95 + (LC26_TYRES[c].front.wet?.tempShiftC ?? 0));
      t.waterMm = waterMm;
      t.wetness = wetnessFromWater(waterMm);
      let fy = 0;
      const vx = 55;
      const vy = -vx * Math.tan((deg * Math.PI) / 180);
      for (let i = 0; i < 200; i++) fy = computeTyreForces(t, { fz: 4000, vx, vy, rimSpeed: vx, camberLeftRad: 0, surfaceGrip: 1, dt: 1 / 2000 }).fy;
      best = Math.max(best, Math.abs(fy));
    }
    return best;
  };
  const d = { s: peakFy('medium', 0), i: peakFy('intermediate', 0), w: peakFy('wet', 0) };
  const r = { s: peakFy('medium', 1), i: peakFy('intermediate', 1), w: peakFy('wet', 1) };
  console.log(`      dry ${fmt(d.s, 0)} / ${fmt(d.i, 0)} / ${fmt(d.w, 0)} N · 1 mm ${fmt(r.s, 0)} / ${fmt(r.i, 0)} / ${fmt(r.w, 0)} N (slick / inter / wet)`);
  check('LC26: rain tyres slower in the dry', d.s > d.i && d.i > d.w, `${fmt(d.s, 0)} > ${fmt(d.i, 0)} > ${fmt(d.w, 0)} N`);
  check('LC26: rain tyres beat slicks on 1 mm of water', r.i > 2 * r.s && r.w > 2 * r.s, `${fmt(r.i, 0)} / ${fmt(r.w, 0)} vs ${fmt(r.s, 0)} N`);

  // Thermal: 5 min of sliding at 6 kW on a dry road (to equilibrium)
  const heat = (c: TireCompound, wetness: number) => {
    const t = createTyreRuntime(LC26_TYRES[c].front, 80);
    t.wetness = wetness;
    for (let i = 0; i < 300 * 200; i++) updateTyreThermal(t, 6000, 4000, 55, 27, 41, 1 / 200);
    return t.surfaceTempC;
  };
  const sDry = heat('medium', 0);
  const wDry = heat('wet', 0);
  const wWet = heat('wet', 1);
  check('LC26: full wets run hotter than slicks on a dry road', wDry > sDry + 10, `wet ${fmt(wDry, 0)} vs slick ${fmt(sDry, 0)} °C`);
  check('LC26: water on the road cools the tread', wWet < wDry - 15, `wet road ${fmt(wWet, 0)} vs dry ${fmt(wDry, 0)} °C`);
}

// ---------------------------------------------------------------------------
// 5. Realism
// ---------------------------------------------------------------------------
console.log('\n== Simulation realism');
{
  check('Default realism is Full', DEFAULT_PLAYER_SETTINGS.realism === 'full', DEFAULT_PLAYER_SETTINGS.realism);
  const t = createTyreRuntime(LC26_TYRES.soft.front, 95);
  t.wearScale = SIM_REALISM_FLAGS.casual.tyreWearScale;
  for (let i = 0; i < 2000; i++) updateTyreThermal(t, 30000, 4000, 55, 27, 41, 1 / 200);
  const full = createTyreRuntime(LC26_TYRES.soft.front, 95);
  for (let i = 0; i < 2000; i++) updateTyreThermal(full, 30000, 4000, 55, 27, 41, 1 / 200);
  check('Casual: no tyre wear', t.wear === 0 && full.wear > 0, `casual ${t.wear}, full ${fmt(full.wear * 100, 3)} %`);

  const track = getActiveTrackData();
  const fuel = (level: 'casual' | 'full') => {
    const sim = new F1Physics2026(track);
    sim.setSimRealism(SIM_REALISM_FLAGS[level]);
    sim.aiAutopilot = true;
    sim.resetToStartGrid(true);
    const f0 = sim.telemetry.fuelKg;
    for (let i = 0; i < 300; i++) sim.step(1 / 60, {});
    return f0 - sim.telemetry.fuelKg;
  };
  const burnt = { casual: fuel('casual'), full: fuel('full') };
  // Sprints on a fixed fuel load: no level burns any
  check('No fuel use at any level (sprint ballast)', burnt.casual === 0 && burnt.full === 0, `casual ${fmt(burnt.casual, 3)} kg, full ${fmt(burnt.full, 3)} kg in 5 s`);
}

// ---------------------------------------------------------------------------
// 6. AI
// ---------------------------------------------------------------------------
console.log('\n== AI in the wet');
{
  const track = getActiveTrackData();
  const env = new TrackEnvironment(track, { ...DEFAULT_SESSION_CONDITIONS, weather: 'heavy_rain' });
  const ai = new F1Physics2026(track).createAiPeerCar();
  ai.aiAutopilot = true;
  ai.tireCompound = 'soft';
  env.update(1 / 60, [ai]);
  const fitted = ai.tireCompound as TireCompound;
  check('AI fits full wets in heavy rain', fitted === 'wet', fitted);
  // The LC26 plans its corner speeds and braking points on its wet grip
  const planGrip = ai.aiPlanGrip();
  ai.tireCompound = 'soft';
  const slickPlanGrip = ai.aiPlanGrip();
  const dryAi = new F1Physics2026(track).createAiPeerCar();
  check('LC26 AI plans on its wet grip, less on slicks', planGrip < 0.9 && slickPlanGrip < planGrip && dryAi.aiPlanGrip() === 1, `wets ${fmt(planGrip, 2)}, slicks ${fmt(slickPlanGrip, 2)}, dry ${fmt(dryAi.aiPlanGrip(), 2)}`);
  // A car without its own wet plan gets a pace factor instead
  const plain = (tireCompound: TireCompound) => ({ sMeters: 100, lateralOffsetM: 0, tireCompound }) as unknown as SimulatorCar;
  const pace = env.weatherPaceScale(plain('wet'));
  const slickPace = env.weatherPaceScale(plain('soft'));
  const dryEnv = new TrackEnvironment(track);
  check('AI pace drops in the wet, more on slicks', pace < 0.95 && slickPace < pace && dryEnv.weatherPaceScale(plain('soft')) === 1, `wets ${fmt(pace, 3)}, slicks ${fmt(slickPace, 3)}, dry 1`);
  const player = new F1Physics2026(track);
  player.tireCompound = 'soft';
  env.update(1 / 60, [player]);
  check("The player's tyres are left alone", player.tireCompound === 'soft', player.tireCompound);
}

// ---------------------------------------------------------------------------
// 7. RealRoad wet groove inversion, worn tread aquaplaning, 5-node weather & wet rim cooling
// ---------------------------------------------------------------------------
console.log('\n== RealRoad wet surface evolution, tread depth & 5-node weather');
{
  // Worn rain tyre loses tread depth and aquaplanes earlier
  const freshInter = wetGripFactor(WET_TYRE_TRAITS.intermediate, 1.4, 65, 1, 0);
  const wornInter = wetGripFactor(WET_TYRE_TRAITS.intermediate, 1.4, 65, 1, 0.8);
  const remMm = remainingTreadDepthMm(WET_TYRE_TRAITS.intermediate, 0.8);
  check(
    'Worn intermediate tread clears less water and aquaplanes earlier',
    wornInter < freshInter - 0.15 && remMm < (WET_TYRE_TRAITS.intermediate.treadDepthMm ?? 2.5) * 0.4,
    `fresh ${fmt(freshInter, 2)} vs 80% worn ${fmt(wornInter, 2)} (${fmt(remMm, 2)} mm tread left)`
  );

  // Wet groove inversion: above 0.18 wetness, the rubbered-in racing line has less grip than the unrubbered off-line tarmac
  const evo = new TrackEvolutionState(5300);
  evo.reset('saturated');
  const dryOnLine = evo.sample(1000, 0, 0, 0).gripMultiplier;
  const dryOffLine = evo.sample(1000, 5, 0, 0).gripMultiplier;
  const wetOnLine = evo.sample(1000, 0, 0, 0.85);
  const wetOffLine = evo.sample(1000, 5, 0, 0.85);
  check(
    'Dry rubbered line has more grip than off-line; wet rubbered line inverts and loses grip',
    dryOnLine > dryOffLine && wetOnLine.gripMultiplier < wetOffLine.gripMultiplier && wetGrooveGripEffect(0.95, 0.85, 1) < 0,
    `dry line ${fmt(dryOnLine, 3)} > off ${fmt(dryOffLine, 3)} · wet line ${fmt(wetOnLine.gripMultiplier, 3)} < off ${fmt(wetOffLine.gripMultiplier, 3)}`
  );

  // 4-channel surface state export/import round-trip
  const snap = evo.exportSurfaceState();
  const evo2 = new TrackEvolutionState(5300);
  evo2.reset('green');
  evo2.importSurfaceState(snap);
  check(
    '4-channel surface state snapshot round-trips',
    Math.abs(evo2.sample(500, 0, 0).rubberLevel - evo.sample(500, 0, 0).rubberLevel) < 1e-6,
    `rubber ${fmt(evo2.sample(500, 0, 0).rubberLevel, 3)}`
  );

  // 5-node weather schedule interpolation & 3x3 spatial rain cell grid
  const nodes = defaultWeatherNodesForPreset('heavy_rain', 'afternoon', 42);
  const midNode = interpolateWeatherNodes(nodes, 0.5, 42);
  const wx = new WeatherState(5300, { ...DEFAULT_SESSION_CONDITIONS, weather: 'heavy_rain', weatherNodes: nodes });
  wx.step(120);
  const centerRain = wx.rainAtWorldPos(0, 0);
  const edgeRain = wx.rainAtWorldPos(450, -450);
  check(
    '5-node weather schedule & 3x3 spatial rain grid evaluate cleanly',
    nodes.length === 5 && midNode.rain > 0.5 && centerRain > 0.5 && edgeRain > 0.3,
    `mid rain ${fmt(midNode.rain, 2)}, grid center ${fmt(centerRain, 2)}, edge ${fmt(edgeRain, 2)}`
  );

  // Wet rim & internal gas cooling drops hot tyre pressure in the wet
  const dryTyre = createTyreRuntime(LC26_TYRES.intermediate.front, 85);
  const wetTyre = createTyreRuntime(LC26_TYRES.intermediate.front, 85);
  wetTyre.wetness = 0.9;
  for (let i = 0; i < 60 * 200; i++) {
    updateTyreThermal(dryTyre, 4000, 3800, 60, 22, 26, 1 / 200, 320);
    updateTyreThermal(wetTyre, 4000, 3800, 60, 22, 26, 1 / 200, 320);
  }
  check(
    'Wet spray cools wheel rim and internal gas, lowering hot inflation pressure',
    wetTyre.gasTempC < dryTyre.gasTempC - 5 && wetTyre.pressurePsi < dryTyre.pressurePsi - 0.3,
    `wet ${fmt(wetTyre.pressurePsi, 2)} psi (${fmt(wetTyre.gasTempC, 1)} °C) vs dry ${fmt(dryTyre.pressurePsi, 2)} psi (${fmt(dryTyre.gasTempC, 1)} °C)`
  );

  // Wet rear-flap (DRS / X-mode) lockout above wetness 0.25
  check(
    'Rear flap (DRS / X-mode) locked out when wetness >= 0.25',
    isRearFlapAllowedInWet(0.1) && !isRearFlapAllowedInWet(0.35),
    `wetness 0.10 → ${isRearFlapAllowedInWet(0.1)}, wetness 0.35 → ${isRearFlapAllowedInWet(0.35)}`
  );

  // 8. Topographical puddle pooling, WLF viscoelastic contact patch, pneumatic trail collapse & spray wake
  console.log('\n== Topographical puddles, WLF viscoelasticity, hydroplaning FFB & rooster-tail spray');
  const highSideBank = topographicalPuddleFactor(400, -5, 6, 0, 7.5);
  const lowSideGutter = topographicalPuddleFactor(400, 6.5, 6, 0, 7.5);
  const steepSlope = topographicalPuddleFactor(800, 0, 0, 12, 7.5);
  const flatBasin = topographicalPuddleFactor(800, 0, 0, 0, 7.5);
  check(
    'Topographical drainage: banked high side & steep slopes drain; low inside gutter & flat basins pool water',
    lowSideGutter > highSideBank + 0.25 && flatBasin > steepSlope + 0.15,
    `gutter ${fmt(lowSideGutter, 2)}x > high bank ${fmt(highSideBank, 2)}x · flat basin ${fmt(flatBasin, 2)}x > steep slope ${fmt(steepSlope, 2)}x`
  );

  // Per-wheel puddle hydrodynamic drag yaw pull on VehiclePhysics
  const puddleCar = new VehiclePhysics({
    ground: new FlatGroundQuery(0),
    config: F12026_CAR_CONFIG,
    compound: F12026_CAR_CONFIG.compoundSlots.soft,
  });
  puddleCar.reset(0, 0, 0);
  puddleCar.velocity.set(0, 0, 65);
  for (const w of puddleCar.wheels) w.omega = 65 / 0.36;
  // Right wheels (RF=1, RR=3) hit a 3.0 mm standing puddle while left wheels (LF=0, LR=2) are on 0.05 mm damp tarmac
  puddleCar.waterMm = 0.5;
  puddleCar.wheelWaterMm = [0.05, 3.0, 0.05, 3.0];
  puddleCar.wetness = 0.5;
  for (let i = 0; i < 60; i++) puddleCar.step(1 / 120, { throttle: 0, brake: 0, steer: 0, clutch: 1 });
  // The wheels now steer to the hardpoints' bump steer: squatting under the aero load the fronts toe out and the
  // rears toe in by ≈0.4 mrad, and the dry side's toe force resists part of the pull (−0.24 °/s at 0.5 s; −0.73 °/s
  // with no toe). It still pulls toward the flooded side. Bound −0.01 → −0.002 rad/s
  check(
    'Per-wheel standing puddle pulls car yaw toward the flooded side',
    puddleCar.angularVelocity.y < -0.002,
    `yawRate ${fmt(puddleCar.angularVelocity.y * (180 / Math.PI), 2)} °/s (pulled right toward 3.0 mm puddle)`
  );

  // Flash temperature quenching & WLF viscoelastic compliance on cold wet tarmac
  const dryFlash = evaluateFlashTempAndWlfGrip(SLICK_TRAITS, 38, 6, 4200, 0);
  const wetSlickWlf = evaluateFlashTempAndWlfGrip(SLICK_TRAITS, 38, 6, 4200, 0.9);
  const wetFullWlf = evaluateFlashTempAndWlfGrip(WET_TYRE_TRAITS.wet, 38, 6, 4200, 0.9);
  const bristleHighLoad = dynamicBristleRelaxationScale(6500, 3500, 0.2);
  const bristleLowLoadWet = dynamicBristleRelaxationScale(2000, 3500, 0.9);
  check(
    'Water quenches asperity flash heating and silica wet compound retains higher WLF viscoelastic grip at 38 °C',
    wetSlickWlf.flashDeltaC < dryFlash.flashDeltaC * 0.5 &&
      wetFullWlf.viscoelasticMult > wetSlickWlf.viscoelasticMult &&
      bristleHighLoad > bristleLowLoadWet,
    `flash dry ${fmt(dryFlash.flashDeltaC, 1)} °C vs wet ${fmt(wetSlickWlf.flashDeltaC, 1)} °C · WLF wet ${fmt(wetFullWlf.viscoelasticMult, 3)} > slick ${fmt(wetSlickWlf.viscoelasticMult, 3)}`
  );

  // Hydroplaning pneumatic trail collapse (FFB lightening)
  const trailLowSpeed = wetPneumaticTrailScale(WET_TYRE_TRAITS.intermediate, 1.6, 20, 0);
  const trailHydroplane = wetPneumaticTrailScale(WET_TYRE_TRAITS.intermediate, 1.6, 82, 0);
  check(
    'Pneumatic trail collapses at hydroplaning speed to lighten steering FFB',
    trailHydroplane < trailLowSpeed * 0.65,
    `trail @20 m/s ${fmt(trailLowSpeed, 2)} → @82 m/s ${fmt(trailHydroplane, 2)}`
  );

  // Airborne rooster-tail spray wake & visor droplet accumulation
  const emitters = [
    { sMeters: 500, lateralOffsetM: 0, speedMs: 65 },
    { sMeters: 518, lateralOffsetM: 0.2, speedMs: 65 },
  ];
  const wakeDry = evaluateAeroWakeDeficit(500, 0, 65, emitters, 5300, 0, 0, 0);
  const wakeWet = evaluateAeroWakeDeficit(500, 0, 65, emitters, 5300, 0, 0, 0.9);
  const visor = { dropletDensity: 0, wiperPhase: 0, wiperMode: 'off' as const };
  for (let i = 0; i < 30; i++) stepWindscreenWipers(visor, 0.05, 0.4, wakeWet.sprayIntensity ?? 0, 60, true);
  check(
    'Rooster-tail spray wake builds behind leading cars in the wet and wets the visor/windscreen',
    (wakeDry.sprayIntensity ?? 0) === 0 && (wakeWet.sprayIntensity ?? 0) > 0.35 && visor.dropletDensity > 0.05,
    `spray dry ${fmt(wakeDry.sprayIntensity ?? 0, 2)}, wet ${fmt(wakeWet.sprayIntensity ?? 0, 2)}, visor droplets ${fmt(visor.dropletDensity, 2)} (wiper: ${visor.wiperMode})`
  );
}

// ---------------------------------------------------------------------------
// 9. Weather regime, host sync of the whole conditions, AI tyre call
// ---------------------------------------------------------------------------
console.log('\n== Weather regime, host sync & AI tyre call');
{
  // Dynamic weather: the sky classification follows the cloud and rain instead of staying at its start
  const dyn = new WeatherState(5300, { ...DEFAULT_SESSION_CONDITIONS, weather: 'dynamic', seed: 7, timeScale: 60 });
  const skies = new Set<string>([dyn.skyCover]);
  let skyMatches = true;
  for (let i = 0; i < 240; i++) {
    dyn.step(1);
    skies.add(dyn.skyCover);
    if (dyn.skyCover !== nearestSkyCover(dyn.cloudCover, dyn.rainIntensity)) skyMatches = false;
  }
  check('Dynamic weather: the sky follows the cloud and rain', dyn.regime === 'dynamic' && skyMatches && skies.size > 1, `${skies.size} skies over 4 h of weather clock`);

  // A forecast made from the drying preset starts on the drying preset's water, not on a bone-dry track
  const dryingNodes = defaultWeatherNodesForPreset('drying', 'afternoon', 3);
  const dryingSchedule = new WeatherState(5300, { ...DEFAULT_SESSION_CONDITIONS, weather: 'drying', timeOfDay: 'afternoon', weatherNodes: dryingNodes });
  const dryingPreset = new WeatherState(5300, { ...DEFAULT_SESSION_CONDITIONS, weather: 'drying', timeOfDay: 'afternoon' });
  check(
    'Drying forecast starts wet with a part-dried line',
    dryingSchedule.regime === 'schedule' && Math.abs(dryingSchedule.waterMm - dryingPreset.waterMm) < 1e-9 && Math.abs(dryingSchedule.lineWaterMm - dryingPreset.lineWaterMm) < 1e-9 && dryingSchedule.waterMm > 0.5,
    `${fmt(dryingSchedule.waterMm)} mm, line ${fmt(dryingSchedule.lineWaterMm)} mm (preset ${fmt(dryingPreset.waterMm)} / ${fmt(dryingPreset.lineWaterMm)})`
  );

  // A guest on the same preset takes the host's forecast and rubber settings too, and restarts its track with them
  const track = getActiveTrackData();
  const hostConditions = {
    ...DEFAULT_SESSION_CONDITIONS,
    weather: 'clear' as const,
    weatherNodes: defaultWeatherNodesForPreset('heavy_rain', 'golden_hour', 1),
    weatherDurationS: 900,
    surfacePreset: 'green' as const,
    surfaceTimeScale: 0,
  };
  const hostEnv = new TrackEnvironment(track, hostConditions);
  for (let i = 0; i < 60; i++) hostEnv.update(1, []);
  const guestEnv = new TrackEnvironment(track, { ...DEFAULT_SESSION_CONDITIONS, weather: 'clear' });
  guestEnv.trackEvolution.timeScale = 3;
  const hostSnap = sanitizeWeatherSync(JSON.parse(JSON.stringify(hostEnv.weather.snapshot())));
  if (hostSnap) guestEnv.applyWeatherSync(hostSnap);
  const gw = guestEnv.weather;
  check(
    'Guest takes the host forecast and rubber settings (same preset)',
    !!hostSnap &&
      gw.regime === 'schedule' &&
      gw.conditions.weatherNodes?.length === 5 &&
      gw.conditions.weatherDurationS === 900 &&
      gw.conditions.surfacePreset === 'green' &&
      guestEnv.trackEvolution.timeScale === 0 &&
      Math.abs(gw.waterMm - hostEnv.weather.waterMm) < 1e-9 &&
      Math.abs(guestEnv.trackEvolution.baseTrackTempC - hostEnv.weather.trackTempC) < 1e-9,
    `${gw.regime}, ${gw.conditions.weatherNodes?.length ?? 0} nodes, ${gw.conditions.surfacePreset}, rubber ×${guestEnv.trackEvolution.timeScale}, ${fmt(gw.waterMm)} mm`
  );
  // The next snapshot, conditions unchanged, only eases (no second restart)
  for (let i = 0; i < 30; i++) hostEnv.update(1, []);
  const easeSnap = sanitizeWeatherSync(JSON.parse(JSON.stringify(hostEnv.weather.snapshot())));
  const restarted = easeSnap ? gw.applySync(easeSnap) : true;
  check('Unchanged host conditions ease, not restart', !restarted, `restarted: ${restarted}`);

  // An AI car that went onto rain tyres goes back onto its own slick, not a medium
  const env = new TrackEnvironment(track, { ...DEFAULT_SESSION_CONDITIONS, weather: 'heavy_rain' });
  const ai = new F1Physics2026(track).createAiPeerCar();
  ai.aiAutopilot = true;
  ai.tireCompound = 'soft';
  env.update(1 / 60, [ai]);
  const inRain = ai.tireCompound as TireCompound;
  env.setConditions({ ...DEFAULT_SESSION_CONDITIONS, weather: 'clear' });
  env.update(1 / 60, [ai]);
  const back = ai.tireCompound as TireCompound;
  check('AI comes off rain tyres onto the slick it had', inRain === 'wet' && back === 'soft', `soft → ${inRain} → ${back}`);

  // Regression (#12): effectiveConditions overlays room weather/time without mutating saved SP conditions or weatherNodes,
  // preserves custom weatherNodes when only time/scale changes, and guest applyWeatherSync -> leave restores SP conditions cleanly
  const ownNodes = defaultWeatherNodesForPreset('dynamic', 'morning', 7);
  const ownCond = { ...DEFAULT_SESSION_CONDITIONS, weather: 'dynamic' as const, timeOfDay: 'morning' as const, timeScale: 5, weatherNodes: ownNodes };
  const sameWeatherTimeOnly = effectiveConditions(ownCond, { weather: 'dynamic', timeOfDay: 'night', timeScale: 0 });
  const inRoom = effectiveConditions(ownCond, { weather: 'heavy_rain', timeOfDay: 'night', timeScale: 0 });
  const backSolo = effectiveConditions(ownCond, null);
  const guestLeaveEnv = new TrackEnvironment(track, ownCond);
  const hostRainEnv = new TrackEnvironment(track, { ...DEFAULT_SESSION_CONDITIONS, weather: 'heavy_rain', timeOfDay: 'night', seed: 99 });
  hostRainEnv.update(5, []);
  guestLeaveEnv.applyWeatherSync(hostRainEnv.weather.snapshot());
  const syncedRain = guestLeaveEnv.weather.conditions.weather === 'heavy_rain' && guestLeaveEnv.weather.conditions.seed === 99;
  guestLeaveEnv.setConditions(ownCond);
  const restoredOwn =
    guestLeaveEnv.weather.conditions.weather === 'dynamic' &&
    guestLeaveEnv.weather.conditions.weatherNodes?.length === 5 &&
    guestLeaveEnv.weather.conditions.seed === ownCond.seed;
  check(
    'effectiveConditions preserves weatherNodes on same-weather override and guest leave restores SP conditions',
    sameWeatherTimeOnly.weatherNodes === ownNodes &&
      sameWeatherTimeOnly.timeOfDay === 'night' &&
      inRoom.weather === 'heavy_rain' &&
      inRoom.timeOfDay === 'night' &&
      inRoom.timeScale === 0 &&
      inRoom.weatherNodes === undefined &&
      ownCond.weather === 'dynamic' &&
      ownCond.weatherNodes === ownNodes &&
      backSolo === ownCond &&
      syncedRain &&
      restoredOwn,
    `sameWxNodes=${sameWeatherTimeOnly.weatherNodes?.length ?? 0}, inRoom=${inRoom.weather}/${inRoom.timeOfDay}, syncedRain=${syncedRain}, restored=${restoredOwn}`
  );
}

// ---------------------------------------------------------------------------
// 10. A circuit's own time of day (a night race) against the player's pick
// ---------------------------------------------------------------------------
console.log('\nCircuit default time of day');
{
  const saved: SessionConditions = { ...DEFAULT_SESSION_CONDITIONS };
  const NIGHT = 'night' as const;
  // A first visit: the night circuit starts at night, the others at golden hour, and the save is not touched
  const atNight = resolveTimeOfDay(saved, false, NIGHT);
  check(
    'Night circuit starts at night until the player picks a time; other circuits keep golden hour',
    atNight.timeOfDay === 'night' && saved.timeOfDay === 'golden_hour' && resolveTimeOfDay(saved, false, undefined) === saved,
    `${atNight.timeOfDay} / ${resolveTimeOfDay(saved, false, undefined).timeOfDay}`
  );
  // A weather change on the night circuit (the panel hands back what it showed, night included) saves no time of day
  const rainAtNight = applyConditionsChoice(saved, false, atNight, { ...atNight, weather: 'light_rain' }, NIGHT);
  check(
    'A weather change at the night circuit does not save night for the other circuits',
    rainAtNight.conditions.weather === 'light_rain' &&
      rainAtNight.conditions.timeOfDay === 'golden_hour' &&
      !rainAtNight.timeOfDayChosen &&
      resolveTimeOfDay(rainAtNight.conditions, rainAtNight.timeOfDayChosen, undefined).timeOfDay === 'golden_hour' &&
      resolveTimeOfDay(rainAtNight.conditions, rainAtNight.timeOfDayChosen, NIGHT).timeOfDay === 'night',
    `${rainAtNight.conditions.timeOfDay}, chosen=${rainAtNight.timeOfDayChosen}`
  );
  // The player picks noon at the night circuit: theirs everywhere, the night circuit included
  const noon = applyConditionsChoice(saved, false, atNight, { ...atNight, timeOfDay: 'noon' }, NIGHT);
  check(
    'A picked time of day applies on every circuit',
    noon.timeOfDayChosen &&
      resolveTimeOfDay(noon.conditions, noon.timeOfDayChosen, NIGHT).timeOfDay === 'noon' &&
      resolveTimeOfDay(noon.conditions, noon.timeOfDayChosen, undefined).timeOfDay === 'noon',
    `${noon.conditions.timeOfDay}, chosen=${noon.timeOfDayChosen}`
  );
  // Night picked on a day circuit is the player's own: it stays on the day circuits
  const nightPick = applyConditionsChoice(saved, false, saved, { ...saved, timeOfDay: 'night' }, undefined);
  check(
    'Night picked on a day circuit stays the player\'s pick',
    nightPick.timeOfDayChosen && resolveTimeOfDay(nightPick.conditions, true, undefined).timeOfDay === 'night',
    `${nightPick.conditions.timeOfDay}, chosen=${nightPick.timeOfDayChosen}`
  );
  // Picking the time the circuit starts at anyway goes back to following the circuits
  const shownNoon = resolveTimeOfDay(noon.conditions, noon.timeOfDayChosen, NIGHT);
  const backToNight = applyConditionsChoice(noon.conditions, noon.timeOfDayChosen, shownNoon, { ...shownNoon, timeOfDay: 'night' }, NIGHT);
  const backToGolden = applyConditionsChoice(noon.conditions, noon.timeOfDayChosen, noon.conditions, { ...noon.conditions, timeOfDay: 'golden_hour' }, undefined);
  check(
    'Picking the circuit\'s own time follows the circuits again',
    !backToNight.timeOfDayChosen &&
      resolveTimeOfDay(backToNight.conditions, false, undefined).timeOfDay === 'golden_hour' &&
      resolveTimeOfDay(backToNight.conditions, false, NIGHT).timeOfDay === 'night' &&
      !backToGolden.timeOfDayChosen &&
      resolveTimeOfDay(backToGolden.conditions, false, NIGHT).timeOfDay === 'night',
    `night: chosen=${backToNight.timeOfDayChosen}, golden: chosen=${backToGolden.timeOfDayChosen}`
  );
  // Saves from before the flag: another time than the default was the player's pick; the default was not
  const oldNoon = parsePlayerSettings({ conditions: { weather: 'clear', timeOfDay: 'noon', timeScale: 0, seed: 1 } });
  const oldDefault = parsePlayerSettings({ conditions: { weather: 'clear', timeOfDay: 'golden_hour', timeScale: 0, seed: 1 } });
  const kept = parsePlayerSettings({ conditions: { weather: 'clear', timeOfDay: 'golden_hour', timeScale: 0, seed: 1 }, timeOfDayChosen: true });
  check(
    'Older saves: a saved noon is the player\'s, a saved golden hour follows the circuits, a saved flag is kept',
    oldNoon.timeOfDayChosen &&
      !oldDefault.timeOfDayChosen &&
      kept.timeOfDayChosen &&
      resolveTimeOfDay(oldDefault.conditions, oldDefault.timeOfDayChosen, NIGHT).timeOfDay === 'night' &&
      resolveTimeOfDay(kept.conditions, kept.timeOfDayChosen, NIGHT).timeOfDay === 'golden_hour',
    `noon=${oldNoon.timeOfDayChosen}, default=${oldDefault.timeOfDayChosen}, kept=${kept.timeOfDayChosen}`
  );
  // A room's override sits on top of the resolved conditions, as before
  const inRoom = effectiveConditions(atNight, { timeOfDay: 'dusk' });
  check('A room\'s time of day overrides the circuit\'s', inRoom.timeOfDay === 'dusk' && atNight.timeOfDay === 'night', inRoom.timeOfDay);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll weather checks passed.');
if (failures.length) process.exit(1);
