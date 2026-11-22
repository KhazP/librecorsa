/**
 * Browser half of `npm run venue-heroes` (scripts/render-venue-heroes.ts bundles and serves it).
 *
 * Loads one circuit with LibreCorsa's real desktop-High pipeline (`buildCircuitScene`, `createGoldenHourEnvironment`
 * with physical sky + volumetric clouds, `createPostFx` with 4x MSAA + bloom + AgX + display grade, and
 * `createVenueNightLighting` for night circuits), frames an unobstructed low-elevated scenic shot with no cars on
 * track, and signals readiness so the runner captures a crisp 1600x900 still.
 *
 *   /__venue-heroes/?track=<trackId>&tod=<optionalTimeOfDay>
 */
import * as THREE from "three";
import { getTrackData, inDeadZone, setActiveTrack, type BuiltTrackData, type RawTrackJson } from "@/lib/track-data";
import { buildCircuitScene } from "@/lib/scene-builder";
import { setKtx2Renderer } from "@/lib/render/ktx2";
import {
  applyGraphicsQuality,
  configureRenderer,
  createGoldenHourEnvironment,
  createPostFx,
  nightShareOf,
} from "@/lib/render/golden-hour-environment";
import { presetPlan } from "@/lib/render/adaptive-quality";
import { createVenueNightLighting, type VenueNightLighting } from "@/lib/render/venue-night-lighting";
import { VENUE_HERO_CAMERAS, type VenueHeroCameraOverride } from "./cameras";

export interface HeroShotInfo {
  trackId: string;
  source: "override" | "auto";
  uM: number;
  uFrac: number;
  side: 1 | -1;
  offsetM: number;
  heightM: number;
  lookAheadM: number;
  fovDeg: number;
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  physicalSkyReady: boolean;
  night: boolean;
  score: number;
}

declare global {
  interface Window {
    __heroReady?: boolean;
    __heroError?: string;
    __heroInfo?: HeroShotInfo;
    __heroDispose?: () => void;
  }
}

const WIDTH = 1600;
const HEIGHT = 900;
const LOAD_TIMEOUT_MS = 120_000;
const SKY_TIMEOUT_MS = 20_000;

interface RoadFrame {
  pos: THREE.Vector3;
  tangent: THREE.Vector3;
  right: THREE.Vector3;
  halfWidth: number;
  curvature: number;
}

interface CandidatePose {
  uM: number;
  uFrac: number;
  side: 1 | -1;
  offsetM: number;
  heightM: number;
  lookAheadM: number;
  lookHeightM: number;
  lookSideM: number;
  fovDeg: number;
  pos: THREE.Vector3;
  lookAt: THREE.Vector3;
  kind: "start" | "corner" | "crest";
  curvMag: number;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function createRoadSampler(track: BuiltTrackData) {
  const L = Math.max(1, track.totalLengthM);
  const samples = track.samples;
  const N = samples.length;
  const ds = L / Math.max(1, N);
  const p2p = track.pointToPoint;
  const closed = !p2p;
  const s0 = p2p ? p2p.startS : 0;
  const roadLen = p2p ? Math.max(1, L - p2p.startS + p2p.endS) : L;

  const sOf = (u: number): number => {
    const uu = closed ? ((u % roadLen) + roadLen) % roadLen : THREE.MathUtils.clamp(u, 0, roadLen);
    return (((s0 + uu) % L) + L) % L;
  };

  const uOf = (s: number): number => {
    const u = (((s - s0) % L) + L) % L;
    return closed ? u : Math.min(u, roadLen);
  };

  const frameAt = (u: number): RoadFrame => {
    const f = sOf(u) / ds;
    const i0 = Math.floor(f) % N;
    const i1 = (i0 + 1) % N;
    const a = f - Math.floor(f);
    const sA = samples[i0];
    const sB = samples[i1];
    const pos = new THREE.Vector3().lerpVectors(sA.position, sB.position, a);
    const tangent = new THREE.Vector3().lerpVectors(sA.tangent, sB.tangent, a).normalize();
    const right = new THREE.Vector3(-tangent.z, 0, tangent.x);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    else right.normalize();
    const halfWidth = THREE.MathUtils.lerp(sA.width, sB.width, a) * 0.5;
    const curvature = THREE.MathUtils.lerp(sA.curvature, sB.curvature, a);
    return { pos, tangent, right, halfWidth: Number.isFinite(halfWidth) && halfWidth > 2 ? halfWidth : 7, curvature };
  };

  const maxRoadYNear = (p: THREE.Vector3, radiusM: number): number => {
    let maxY = -Infinity;
    const r2 = radiusM * radiusM;
    for (let i = 0; i < N; i += 2) {
      const s = samples[i];
      if (p2p && inDeadZone(p2p, s.s)) continue;
      const dx = s.position.x - p.x;
      const dz = s.position.z - p.z;
      if (dx * dx + dz * dz <= r2) maxY = Math.max(maxY, s.position.y);
    }
    return maxY > -Infinity ? maxY : p.y;
  };

  return { L, N, ds, closed, roadLen, sOf, uOf, frameAt, maxRoadYNear };
}

function buildPoseFromSpec(
  sampler: ReturnType<typeof createRoadSampler>,
  uM: number,
  side: 1 | -1,
  offsetM: number,
  heightM: number,
  lookAheadM: number,
  lookHeightM: number,
  lookSideM: number,
  fovDeg: number,
  kind: CandidatePose["kind"],
  curvMag: number,
): CandidatePose {
  const fCam = sampler.frameAt(uM);
  const fLook = sampler.frameAt(uM + lookAheadM);
  const pos = fCam.pos.clone().addScaledVector(fCam.right, side * offsetM);
  const localFloor = sampler.maxRoadYNear(pos, 18);
  pos.y = Math.max(fCam.pos.y, localFloor) + heightM;
  const lookAt = fLook.pos.clone().addScaledVector(fLook.right, lookSideM);
  lookAt.y += lookHeightM;
  return {
    uM,
    uFrac: uM / sampler.roadLen,
    side,
    offsetM,
    heightM,
    lookAheadM,
    lookHeightM,
    lookSideM,
    fovDeg,
    pos,
    lookAt,
    kind,
    curvMag,
  };
}

interface OccluderEntry {
  mesh: THREE.Object3D;
  box: THREE.Box3;
}

function collectOccluderMeshes(root: THREE.Object3D): OccluderEntry[] {
  const entries: OccluderEntry[] = [];
  root.updateMatrixWorld(true);
  root.traverseVisible((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (obj.userData?.collider || obj.userData?.hidden) return;
    // Skip transparent decals / soft overlays that shouldn't reject a camera sightline
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const hasSolid = mats.some((m) => {
      if (!m) return false;
      const mat = m as THREE.Material & { opacity?: number; transparent?: boolean; alphaTest?: number };
      if (mat.depthWrite === false) return false;
      if (mat.transparent && (mat.opacity ?? 1) < 0.35 && (mat.alphaTest ?? 0) <= 0) return false;
      return true;
    });
    if (!hasSolid) return;
    let localBox: THREE.Box3 | null;
    if (obj instanceof THREE.InstancedMesh) {
      if (!obj.boundingBox) obj.computeBoundingBox();
      localBox = obj.boundingBox;
    } else {
      if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
      localBox = obj.geometry.boundingBox;
    }
    if (!localBox) return;
    const box = localBox.clone().applyMatrix4(obj.matrixWorld);
    entries.push({ mesh: obj, box });
  });
  return entries;
}

const _boxHit = new THREE.Vector3();
function rayHitsAny(raycaster: THREE.Raycaster, entries: readonly OccluderEntry[]): boolean {
  const origin = raycaster.ray.origin;
  const farSq = raycaster.far * raycaster.far;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e.box.containsPoint(origin)) {
      if (!raycaster.ray.intersectBox(e.box, _boxHit)) continue;
      if (_boxHit.distanceToSquared(origin) > farSq) continue;
    }
    if (raycaster.intersectObject(e.mesh, false).length > 0) return true;
  }
  return false;
}

function buildCandidates(track: BuiltTrackData, sampler: ReturnType<typeof createRoadSampler>): CandidatePose[] {
  const { samples } = track;
  const { N, ds, closed, roadLen, uOf } = sampler;
  const p2p = track.pointToPoint;
  const candidates: CandidatePose[] = [];

  // 1. Start/finish straight viewpoints (inside the road corridor so street/barrier tracks never clip walls)
  const startU = closed ? roadLen - 65 : Math.min(70, roadLen * 0.08);
  const sfFrame = sampler.frameAt(startU);
  for (const side of [1, -1] as const) {
    for (const [hwMult, h] of [
      [0.75, 4.2],
      [0.95, 6.2],
    ] as const) {
      candidates.push(
        buildPoseFromSpec(sampler, startU, side, sfFrame.halfWidth * hwMult, h, 95, 1.8, 0, 38, "start", 0.002),
      );
    }
  }

  // 2. Top distinct corners around the circuit
  const margin = closed ? 0 : 120;
  const half = Math.max(1, Math.round(35 / ds));
  const scored: { u: number; signedCurv: number; mag: number }[] = [];
  for (let i = 0; i < N; i += 2) {
    const s = samples[i];
    if (p2p && inDeadZone(p2p, s.s)) continue;
    const u = uOf(s.s);
    if (!closed && (u < margin || u > roadLen - margin)) continue;
    let sum = 0;
    for (let j = -half; j <= half; j++) sum += samples[(i + j + N) % N].curvature;
    const avg = sum / (2 * half + 1);
    scored.push({ u, signedCurv: avg, mag: Math.abs(avg) });
  }
  scored.sort((a, b) => b.mag - a.mag);

  const minGap = Math.min(320, roadLen / 8);
  const gap = (a: number, b: number) => {
    const d = Math.abs(a - b);
    return closed ? Math.min(d, roadLen - d) : d;
  };
  const corners: typeof scored = [];
  for (const c of scored) {
    if (corners.length >= 6) break;
    if (c.mag < 1 / 500 && corners.length >= 4) break;
    if (corners.every((p) => gap(p.u, c.u) >= minGap)) corners.push(c);
  }

  for (const corner of corners) {
    // Keep camera over the kerb / road edge (never deep behind single-sided barriers, fences, or tunnel shells)
    const outside: 1 | -1 = corner.signedCurv >= 0 ? -1 : 1;
    const inside: 1 | -1 = outside === 1 ? -1 : 1;
    const cf = sampler.frameAt(corner.u);

    const configs: Array<{ uOff: number; side: 1 | -1; hwMult: number; h: number; look: number }> = [
      { uOff: -38, side: outside, hwMult: 0.85, h: 4.2, look: 90 },
      { uOff: 36, side: outside, hwMult: 0.85, h: 4.8, look: -90 },
      { uOff: -26, side: inside, hwMult: 0.8, h: 5.0, look: 88 },
    ];
    for (const cfg of configs) {
      const u = closed ? ((corner.u + cfg.uOff) % roadLen + roadLen) % roadLen : THREE.MathUtils.clamp(corner.u + cfg.uOff, 50, roadLen - 95);
      candidates.push(
        buildPoseFromSpec(sampler, u, cfg.side, cf.halfWidth * cfg.hwMult, cfg.h, cfg.look, 1.8, 0, 38, "corner", corner.mag),
      );
    }
  }

  // 3. Highest elevation crest overlook (if venue has meaningful vertical relief)
  let minY = Infinity;
  let maxY = -Infinity;
  let crestU = roadLen * 0.5;
  for (let i = 0; i < N; i += 3) {
    const s = samples[i];
    if (p2p && inDeadZone(p2p, s.s)) continue;
    const u = uOf(s.s);
    if (!closed && (u < 100 || u > roadLen - 120)) continue;
    if (s.position.y < minY) minY = s.position.y;
    if (s.position.y > maxY) {
      maxY = s.position.y;
      crestU = u;
    }
  }
  if (maxY - minY > 12) {
    const f = sampler.frameAt(crestU);
    for (const side of [1, -1] as const) {
      candidates.push(buildPoseFromSpec(sampler, crestU, side, f.halfWidth * 0.85, 5.2, 100, 1.6, 0, 38, "crest", 0.004));
    }
  }

  return candidates;
}

function pickBestCandidate(
  track: BuiltTrackData,
  sampler: ReturnType<typeof createRoadSampler>,
  occluders: readonly OccluderEntry[],
): { pose: CandidatePose; score: number } {
  const candidates = buildCandidates(track, sampler);
  const raycaster = new THREE.Raycaster();
  const probe = new THREE.PerspectiveCamera(38, WIDTH / HEIGHT, 0.5, 4000);
  const dir = new THREE.Vector3();
  const targetPt = new THREE.Vector3();
  const proj = new THREE.Vector3();

  let bestPose = candidates[0];
  let bestScore = -Infinity;

  for (const cand of candidates) {
    probe.fov = cand.fovDeg;
    probe.position.copy(cand.pos);
    probe.lookAt(cand.lookAt);
    probe.updateProjectionMatrix();
    probe.updateMatrixWorld(true);

    // 1. Camera bubble clearance (reject cameras sitting inside buildings, trees, gantries, or terrain slopes)
    const fwd = new THREE.Vector3().subVectors(cand.lookAt, cand.pos).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, THREE.Object3D.DEFAULT_UP).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const bubbleDirs = [
      fwd,
      fwd.clone().addScaledVector(right, 0.5).normalize(),
      fwd.clone().addScaledVector(right, -0.5).normalize(),
      up,
      right,
      right.clone().negate(),
    ];
    let clipped = false;
    for (const bd of bubbleDirs) {
      raycaster.set(cand.pos, bd);
      raycaster.near = 0.05;
      raycaster.far = 4.5;
      if (rayHitsAny(raycaster, occluders)) {
        clipped = true;
        break;
      }
    }
    if (clipped) continue;

    // Also reject cameras directly under a tunnel roof, bridge deck, or thick overhead canopy
    raycaster.set(cand.pos, THREE.Object3D.DEFAULT_UP);
    raycaster.near = 0.1;
    raycaster.far = 22;
    if (rayHitsAny(raycaster, occluders)) continue;

    // 2. Road sightline clearance
    const sign = cand.lookAheadM >= 0 ? 1 : -1;
    const roadOffsets = [18, 42, 70, 102, 138];
    let clearRoadRays = 0;
    let coreBlocked = false;
    for (let idx = 0; idx < roadOffsets.length; idx++) {
      const f = sampler.frameAt(cand.uM + sign * roadOffsets[idx]);
      targetPt.copy(f.pos);
      targetPt.y += 1.4;
      dir.subVectors(targetPt, cand.pos);
      const dist = dir.length();
      if (dist < 4) continue;
      dir.divideScalar(dist);
      raycaster.set(cand.pos, dir);
      raycaster.near = 0.2;
      raycaster.far = Math.max(0.5, dist - 5.5);
      if (!rayHitsAny(raycaster, occluders)) {
        clearRoadRays++;
      } else if (idx === 1 || idx === 2) {
        coreBlocked = true;
      }
    }
    if (coreBlocked || clearRoadRays < 4) continue;

    // 3. Upper-frame sky openness & mid-ground scenery presence
    let skyOpen = 0;
    for (const nx of [-0.6, -0.3, 0, 0.3, 0.6]) {
      raycaster.setFromCamera(new THREE.Vector2(nx, 0.62), probe);
      raycaster.near = 0.5;
      raycaster.far = 450;
      if (!rayHitsAny(raycaster, occluders)) skyOpen++;
    }
    if (skyOpen < 3) continue;

    let midgroundScenery = 0;
    for (const nx of [-0.65, -0.25, 0.15, 0.55]) {
      raycaster.setFromCamera(new THREE.Vector2(nx, 0.14), probe);
      raycaster.near = 15;
      raycaster.far = 260;
      if (rayHitsAny(raycaster, occluders)) midgroundScenery++;
    }

    // 4. Project visible road ribbon to reward sweeping curves with clear Drive-text space bottom-left
    let inMidBand = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let ySpanMin = Infinity;
    let ySpanMax = -Infinity;
    for (let step = 8; step <= 240; step += 8) {
      const f = sampler.frameAt(cand.uM + sign * step);
      proj.copy(f.pos).project(probe);
      if (proj.z < -1 || proj.z > 1) continue;
      if (Math.abs(proj.x) <= 0.98 && proj.y >= -0.75 && proj.y <= 0.25) {
        inMidBand++;
        minX = Math.min(minX, proj.x);
        maxX = Math.max(maxX, proj.x);
      }
      ySpanMin = Math.min(ySpanMin, f.pos.y);
      ySpanMax = Math.max(ySpanMax, f.pos.y);
    }

    const horizSweep = maxX > minX ? maxX - minX : 0;
    const elevDrama = ySpanMax > ySpanMin ? Math.min(20, ySpanMax - ySpanMin) : 0;
    const curvBonus = Math.min(22, cand.curvMag * 2800);
    const sceneryBonus = midgroundScenery >= 1 && midgroundScenery <= 4 ? 10 + midgroundScenery * 3 : 0;
    const kindBonus = cand.kind === "start" ? 12 : cand.kind === "crest" ? 8 : 6;
    const lowHeightBonus = cand.heightM <= 8 ? 5 : 0;

    const score =
      clearRoadRays * 9 +
      skyOpen * 6 +
      Math.min(20, inMidBand) * 1.6 +
      horizSweep * 24 +
      curvBonus +
      elevDrama * 0.7 +
      sceneryBonus +
      kindBonus +
      lowHeightBonus;

    if (score > bestScore) {
      bestScore = score;
      bestPose = cand;
    }
  }

  return { pose: bestPose, score: bestScore };
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const trackId = params.get("track");
  if (!trackId) throw new Error("no ?track=");
  const isNight = params.get("tod") === "night";

  const res = await fetch(`/tracks/${encodeURIComponent(trackId)}/track_data.json`);
  if (!res.ok) throw new Error(`${trackId}: track_data.json HTTP ${res.status}`);
  const raw = (await res.json()) as RawTrackJson;
  setActiveTrack(trackId, raw);
  const track = getTrackData();

  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });
  configureRenderer(renderer);
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT);
  setKtx2Renderer(renderer);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, WIDTH / HEIGHT, 0.4, 8000);

  const env = createGoldenHourEnvironment(renderer, scene, {
    physicalSky: true,
    deferPhysicalSky: false,
  });
  const postFx = createPostFx(renderer, scene, camera, { multisampling: 4 });
  applyGraphicsQuality(renderer, postFx, env, presetPlan("high", 1));
  postFx.setSize(WIDTH, HEIGHT);

  const builtCircuit = buildCircuitScene(track);
  scene.add(builtCircuit.sceneGroup);
  builtCircuit.racingLineMesh.visible = false;

  // Wait for the circuit GLB + shared venue model + instanced scenery trees to finish loading
  const trackRoot = await Promise.race([
    builtCircuit.trackRoot,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${trackId}: trackRoot load timeout`)), LOAD_TIMEOUT_MS)),
  ]);

  let venueNight: VenueNightLighting | null = null;
  if (isNight && track.nightLighting) {
    venueNight = createVenueNightLighting(trackRoot, track, track.nightLighting);
    venueNight.setQuality("high");
    venueNight.setNight(1);
    scene.add(venueNight.group);
    env.setFloodlitNight(venueNight.look);
  }

  // Wait for physical atmosphere LUTs so real sky scattering & volumetric clouds render
  const skyStart = performance.now();
  while (env.physicalSky && !env.physicalSky.ready && performance.now() - skyStart < SKY_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (env.physicalSky) postFx.setClouds(env.physicalSky);

  const sampler = createRoadSampler(track);
  const override: VenueHeroCameraOverride | undefined = VENUE_HERO_CAMERAS[trackId];

  let chosen: CandidatePose;
  let score = 0;
  if (override) {
    const uM = override.uFrac !== undefined ? override.uFrac * sampler.roadLen : (override.uM ?? 0);
    chosen = buildPoseFromSpec(
      sampler,
      uM,
      override.side,
      override.offsetM,
      override.heightM,
      override.lookAheadM,
      override.lookHeightM ?? 1.8,
      override.lookSideM ?? 0,
      override.fovDeg ?? 38,
      "corner",
      0,
    );
  } else {
    const occluders = collectOccluderMeshes(trackRoot);
    const best = pickBestCandidate(track, sampler, occluders);
    chosen = best.pose;
    score = best.score;
  }

  camera.fov = chosen.fovDeg;
  camera.position.copy(chosen.pos);
  camera.lookAt(chosen.lookAt);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  // Position the sun at a cinematic 3/4 cross-light relative to the camera view unless overridden
  const viewDir = new THREE.Vector3().subVectors(chosen.lookAt, chosen.pos);
  const viewAzimuthDeg = ((Math.atan2(viewDir.x, viewDir.z) * 180) / Math.PI + 360) % 360;
  const sunAzimuthDeg = override?.sunAzimuthDeg ?? (viewAzimuthDeg + 68) % 360;
  const sunElevationDeg = override?.sunElevationDeg ?? (isNight ? -8 : 14);
  const cloud = override?.cloud ?? (isNight ? 0.18 : 0.30);
  const cloudSeed = override?.cloudSeed ?? (hashString(trackId) % 900) + 17;

  env.setCloudSeed(cloudSeed);
  env.setConditions({
    elevationDeg: sunElevationDeg,
    azimuthDeg: sunAzimuthDeg,
    cloud,
    rain: 0,
    windVxMs: 3,
    windVzMs: 1,
  });
  venueNight?.setNight(nightShareOf(sunElevationDeg));

  // Warm up shaders, async textures, shadow cascades, and volumetric cloud temporal accumulation
  for (let i = 0; i < 32; i++) {
    builtCircuit.updateEnvironment(i * (1 / 60));
    env.update(chosen.lookAt, camera);
    postFx.render(1 / 60);
    await new Promise((r) => requestAnimationFrame(r));
  }
  env.update(chosen.lookAt, camera);
  postFx.render(1 / 60);
  renderer.getContext().finish();

  window.__heroInfo = {
    trackId,
    source: override ? "override" : "auto",
    uM: Math.round(chosen.uM),
    uFrac: Number(chosen.uFrac.toFixed(3)),
    side: chosen.side,
    offsetM: Number(chosen.offsetM.toFixed(1)),
    heightM: Number(chosen.heightM.toFixed(1)),
    lookAheadM: Math.round(chosen.lookAheadM),
    fovDeg: chosen.fovDeg,
    sunAzimuthDeg: Math.round(sunAzimuthDeg),
    sunElevationDeg,
    physicalSkyReady: Boolean(env.physicalSky?.ready),
    night: isNight,
    score: Number(score.toFixed(1)),
  };
  window.__heroDispose = () => {
    venueNight?.dispose();
    postFx.dispose();
    env.dispose();
    setKtx2Renderer(null);
    renderer.renderLists.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  };
  window.__heroReady = true;
}

main().catch((err: unknown) => {
  window.__heroError = err instanceof Error ? err.message : String(err);
});
