import * as THREE from "three";
import { anyCarById, type CarClassId, type CarId } from "@/lib/cars/car-registry";
import type { GraphicsQuality } from "@/lib/settings/player-settings";
import { SKY_COVER_SPECS, type SessionConditions } from "@/lib/sim/weather";

export type HeadlightMode = "auto" | "on" | "off";
export type HeadlightSpotCount = 0 | 1 | 2;

export interface CarHeadlightsOptions {
  /**
   * Number of SpotLights to allocate for forward road beams:
   * - `0`: flares + emissive lenses only (Low quality, daytime-only sessions, or `lightsOnly` opponent rigs)
   * - `1`: single merged centre SpotLight (Medium quality)
   * - `2`: twin left/right SpotLights (High quality; default when not `lightsOnly`)
   */
  spotCount?: HeadlightSpotCount;
  /** Shorthand for `spotCount: 0` (opponent rigs: front/rear flares + cloned emissive lenses, zero SpotLights) */
  lightsOnly?: boolean;
}

/** Sun elevation below which automatic headlights switch on (deg; covers dusk, night, early dawn) */
export const AUTO_HEADLIGHT_SUN_DEG = 4;
/** Rain intensity above which automatic headlights switch on (0..1) */
export const AUTO_HEADLIGHT_RAIN = 0.35;

export interface HeadlightProfile {
  /** Lateral half-spacing of the left and right beams from the car centreline (m) */
  halfWidthM: number;
  /** Lamp height above the chassis floor (m) */
  heightM: number;
  /** Longitudinal lamp position (+Z = forward, m) */
  frontZM: number;
  /** Rear tail-light longitudinal position (-Z = rear, m) */
  rearZM: number;
  /** Rear tail-light lateral half-spacing (0 = single centre rain/tail lamp) */
  rearHalfWidthM: number;
  /** Rear tail-light height (m) */
  rearHeightM: number;
  /** Beam and lens colour (hex) */
  color: number;
  /** SpotLight peak intensity per lamp (cd-scaled for AgX with decay = 1.4) */
  intensity: number;
  /** Maximum illumination distance (m) */
  distanceM: number;
  /** Cone half-angle (rad) */
  angleRad: number;
  /** Soft edge fraction (0..1) */
  penumbra: number;
  /** Outward toe of each lamp's aim point at 48 m ahead (m) */
  aimSpreadM: number;
  /** Visual lens flare diameter (m) */
  flareSizeM: number;
}

const CLASS_PROFILES: Readonly<Record<CarClassId, HeadlightProfile>> = {
  f1: {
    halfWidthM: 0.26,
    heightM: 0.44,
    frontZM: 2.15,
    rearZM: -2.42,
    rearHalfWidthM: 0,
    rearHeightM: 0.46,
    color: 0xf4f8ff,
    intensity: 175,
    distanceM: 175,
    angleRad: 0.54,
    penumbra: 0.62,
    aimSpreadM: 2.8,
    flareSizeM: 0.24,
  },
  gt3: {
    halfWidthM: 0.72,
    heightM: 0.56,
    frontZM: 2.08,
    rearZM: -2.18,
    rearHalfWidthM: 0.70,
    rearHeightM: 0.68,
    color: 0xf8fbff,
    intensity: 215,
    distanceM: 200,
    angleRad: 0.56,
    penumbra: 0.58,
    aimSpreadM: 3.2,
    flareSizeM: 0.34,
  },
  proto: {
    halfWidthM: 0.66,
    heightM: 0.48,
    frontZM: 2.15,
    rearZM: -2.25,
    rearHalfWidthM: 0.68,
    rearHeightM: 0.62,
    color: 0xf4f9ff,
    intensity: 240,
    distanceM: 210,
    angleRad: 0.58,
    penumbra: 0.56,
    aimSpreadM: 3.4,
    flareSizeM: 0.36,
  },
  classic: {
    halfWidthM: 0.64,
    heightM: 0.56,
    frontZM: 1.98,
    rearZM: -2.05,
    rearHalfWidthM: 0.62,
    rearHeightM: 0.64,
    color: 0xffe4b0,
    intensity: 180,
    distanceM: 165,
    angleRad: 0.56,
    penumbra: 0.62,
    aimSpreadM: 2.8,
    flareSizeM: 0.30,
  },
  road: {
    halfWidthM: 0.62,
    heightM: 0.64,
    frontZM: 1.92,
    rearZM: -1.98,
    rearHalfWidthM: 0.60,
    rearHeightM: 0.72,
    color: 0xfff0d4,
    intensity: 160,
    distanceM: 155,
    angleRad: 0.58,
    penumbra: 0.64,
    aimSpreadM: 2.6,
    flareSizeM: 0.28,
  },
};

/** Headlight beam and visual placement profile for any car in the registry */
export function headlightProfileFor(carId: CarId): HeadlightProfile {
  const cls = anyCarById(carId)?.classId ?? "gt3";
  return CLASS_PROFILES[cls] ?? CLASS_PROFILES.gt3;
}

/** Whether headlights should illuminate under the current mode and sky/weather state */
export function shouldHeadlightsBeOn(mode: HeadlightMode, sunElevationDeg: number, rainIntensity: number): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return sunElevationDeg < AUTO_HEADLIGHT_SUN_DEG || rainIntensity > AUTO_HEADLIGHT_RAIN;
}

export interface HeadlightStates {
  /** Whether the player's car headlights are illuminated (honours manual on/off override) */
  player: boolean;
  /** Whether AI / online opponent headlights are illuminated (always automatic so the player's toggle never darkens them) */
  opponents: boolean;
}

/**
 * Resolves both player and opponent headlight states for a rendered frame.
 * Opponents always follow automatic sky/rain lighting so a manual player toggle never darkens AI / online cars at
 * night or switches them on in clear daylight.
 */
export function resolveHeadlightStates(
  mode: HeadlightMode,
  sunElevationDeg: number,
  rainIntensity: number,
): HeadlightStates {
  const opponents = shouldHeadlightsBeOn("auto", sunElevationDeg, rainIntensity);
  return {
    player: mode === "auto" ? opponents : mode === "on",
    opponents,
  };
}

/** Whether a session's conditions can ever become dark or rainy enough to need real road-beam SpotLights */
export function canSessionGetDark(conditions: SessionConditions): boolean {
  if (conditions.timeScale > 0) return true;
  if (conditions.timeOfDay === "night" || conditions.timeOfDay === "dusk" || conditions.timeOfDay === "dawn") return true;
  if (
    conditions.weather === "light_rain" ||
    conditions.weather === "heavy_rain" ||
    conditions.weather === "dynamic" ||
    conditions.weather === "drying"
  ) {
    return true;
  }
  return conditions.weatherNodes?.some((n) => (SKY_COVER_SPECS[n.sky]?.rain ?? 0) > 0) ?? false;
}

/**
 * SpotLight budget for the player's car headlights: three.js iterates every SpotLight in the scene on every lit
 * fragment even at intensity 0, so daytime-only sessions and Low quality skip SpotLights entirely (keeping flares and
 * emissive lenses only). Medium uses 1 merged centre SpotLight; High uses 2 twin SpotLights.
 */
export function headlightSpotCountFor(conditions: SessionConditions, quality: GraphicsQuality): HeadlightSpotCount {
  if (quality === "low" || !canSessionGetDark(conditions)) return 0;
  return quality === "medium" ? 1 : 2;
}

let sharedFlareTexture: THREE.CanvasTexture | null = null;

/** Soft radial glow texture shared across headlight and tail-light sprites (created lazily in browser) */
function getFlareTexture(): THREE.CanvasTexture | null {
  if (sharedFlareTexture) return sharedFlareTexture;
  if (typeof document === "undefined") return null;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const half = size / 2;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, "rgba(255, 255, 255, 1)");
  grad.addColorStop(0.28, "rgba(255, 255, 255, 0.75)");
  grad.addColorStop(0.6, "rgba(255, 255, 255, 0.18)");
  grad.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  sharedFlareTexture = tex;
  return tex;
}

const HEADLIGHT_MAT_RE = /(?:head_?light|front_?light|lamp_?front|hl_glass|light_?front|farol|scheinwerfer)/i;
/** Generic light materials on ported/GT3 GLBs (e.g. `light_004`, `BMWMAT_Lights1`, `MI_..._Lights`) — gated by front Z */
const GENERIC_LIGHT_MAT_RE = /(?:^|_)lights?(?:_?\d+)?$|interactive_lights/i;
const EXCLUDED_LIGHT_RE = /(?:tail|brake|reverse|indicator|dash|wheel|interior|clearled|glass)/i;

const _flarePos = new THREE.Vector3();
const _carFwd = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _box = new THREE.Box3();
const _center = new THREE.Vector3();
const _invRoot = new THREE.Matrix4();

interface BoostedMaterial {
  mat: THREE.MeshStandardMaterial;
  baseEmissive: THREE.Color;
  baseIntensity: number;
}

interface ReplacedMaterialSlot {
  mesh: THREE.Mesh;
  index: number | null;
  original: THREE.MeshStandardMaterial;
  clone: THREE.MeshStandardMaterial;
}

/**
 * Forward-facing car headlights (0, 1 or 2 SpotLights + directional lens flares + rear tail-light glow + cloned
 * emissive headlight lenses) mounted directly to a car's chassisGroup so beams follow body pitch, roll and bumps.
 * No shadow maps are allocated, keeping frame cost low.
 */
export class CarHeadlights {
  readonly group = new THREE.Group();
  readonly spotCount: HeadlightSpotCount;
  private readonly spots: THREE.SpotLight[] = [];
  private readonly spotIntensity: number;
  private readonly frontFlares: THREE.Sprite[] = [];
  private readonly rearFlares: THREE.Sprite[] = [];
  private readonly frontMat: THREE.SpriteMaterial;
  private readonly rearMat: THREE.SpriteMaterial;
  private readonly profile: HeadlightProfile;
  private readonly boosted: BoostedMaterial[] = [];
  private readonly cloneByOriginal = new Map<THREE.MeshStandardMaterial, THREE.MeshStandardMaterial>();
  private readonly replacedSlots: ReplacedMaterialSlot[] = [];
  private scannedRoot: THREE.Object3D | null = null;
  private scannedChildren: THREE.Object3D[] = [];
  private enabled = false;
  private braking = false;

  constructor(carId: CarId, options?: CarHeadlightsOptions) {
    this.group.name = "CarHeadlights";
    this.profile = headlightProfileFor(carId);
    const p = this.profile;
    this.spotCount = options?.lightsOnly ? 0 : (options?.spotCount ?? 2);

    if (this.spotCount === 2) {
      this.spotIntensity = p.intensity;
      const makeSpot = (side: 1 | -1): THREE.SpotLight => {
        // Decay 1.0 + slightly raised virtual beam origin avoids grazing-angle Lambertian collapse on flat asphalt
        // past 30 m while keeping near-nose intensity balanced under AgX tone mapping.
        const spot = new THREE.SpotLight(p.color, 0, p.distanceM, p.angleRad, p.penumbra, 1.0);
        spot.castShadow = false;
        spot.position.set(side * p.halfWidthM, p.heightM + 0.3, p.frontZM);
        // Aimed ~52 m down the road, slightly down onto the asphalt and gently outward for corner apexes
        spot.target.position.set(side * (p.halfWidthM + p.aimSpreadM), 0, p.frontZM + 52);
        this.group.add(spot, spot.target);
        return spot;
      };
      this.spots.push(makeSpot(1), makeSpot(-1));
    } else if (this.spotCount === 1) {
      // Medium quality: single merged centre SpotLight with a slightly wider cone and boosted intensity
      this.spotIntensity = p.intensity * 1.65;
      const spot = new THREE.SpotLight(
        p.color,
        0,
        p.distanceM,
        Math.min(Math.PI * 0.45, p.angleRad * 1.18),
        p.penumbra,
        1.0
      );
      spot.castShadow = false;
      spot.position.set(0, p.heightM + 0.3, p.frontZM);
      spot.target.position.set(0, 0, p.frontZM + 52);
      this.group.add(spot, spot.target);
      this.spots.push(spot);
    } else {
      this.spotIntensity = 0;
    }

    const tex = getFlareTexture();
    this.frontMat = new THREE.SpriteMaterial({
      color: p.color,
      map: tex,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.rearMat = new THREE.SpriteMaterial({
      color: 0xff1e12,
      map: tex,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });

    for (const side of [1, -1] as const) {
      const flare = new THREE.Sprite(this.frontMat);
      flare.position.set(side * p.halfWidthM, p.heightM, p.frontZM + 0.04);
      flare.scale.setScalar(p.flareSizeM);
      flare.visible = false;
      this.frontFlares.push(flare);
      this.group.add(flare);
    }

    const rearOffsets = p.rearHalfWidthM > 0.01 ? [p.rearHalfWidthM, -p.rearHalfWidthM] : [0];
    for (const x of rearOffsets) {
      const rear = new THREE.Sprite(this.rearMat);
      rear.position.set(x, p.rearHeightM, p.rearZM);
      rear.scale.setScalar(p.rearHalfWidthM > 0.01 ? 0.28 : 0.22);
      rear.visible = false;
      this.rearFlares.push(rear);
      this.group.add(rear);
    }
  }

  /** Attach to a car's chassisGroup */
  attach(chassisGroup: THREE.Group): void {
    chassisGroup.add(this.group);
    this.scannedRoot = chassisGroup;
    this.scannedChildren = [];
  }

  /**
   * Lazily discovers GLB headlight materials and body bounds whenever the chassisGroup's child list changes
   * (including when an async loader replaces its placeholder with the real `bodyGroup` keeping child count equal).
   * Each matched material is cloned and assigned only to matched front meshes so shared template materials (other
   * cars, ghosts, previews, and rear lamps sharing a generic `light_*` material) are never mutated.
   */
  private scanMaterials(): void {
    const root = this.scannedRoot;
    if (!root) return;
    const kids = root.children;
    if (kids.length === this.scannedChildren.length && kids.every((c, i) => c === this.scannedChildren[i])) return;
    this.scannedChildren = kids.slice();

    root.updateMatrixWorld(true);
    _invRoot.copy(root.matrixWorld).invert();

    let bodyMaxZ = -Infinity;
    let bodyMinZ = Infinity;

    for (const child of kids) {
      if (child === this.group) continue;
      child.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        const geo = obj.geometry;
        if (geo) {
          if (!geo.boundingBox) geo.computeBoundingBox();
          if (geo.boundingBox) {
            _box.copy(geo.boundingBox).applyMatrix4(obj.matrixWorld).applyMatrix4(_invRoot);
            if (Number.isFinite(_box.max.z) && _box.max.z - _box.min.z < 8) {
              if (_box.max.z > bodyMaxZ) bodyMaxZ = _box.max.z;
              if (_box.min.z < bodyMinZ) bodyMinZ = _box.min.z;
            }
            _box.getCenter(_center);
          } else {
            _center.set(0, 0, 0);
          }
        } else {
          _center.set(0, 0, 0);
        }

        const isArr = Array.isArray(obj.material);
        const mats = isArr ? obj.material : [obj.material];
        let nextArr: THREE.Material[] | null = null;
        for (let i = 0; i < mats.length; i++) {
          const m = mats[i];
          if (!(m instanceof THREE.MeshStandardMaterial) || m.userData.__headlightClone) continue;
          const explicit = HEADLIGHT_MAT_RE.test(m.name) || HEADLIGHT_MAT_RE.test(obj.name);
          const genericFront =
            !explicit &&
            _center.z > 0.75 &&
            !EXCLUDED_LIGHT_RE.test(m.name) &&
            !EXCLUDED_LIGHT_RE.test(obj.name) &&
            (GENERIC_LIGHT_MAT_RE.test(m.name) || GENERIC_LIGHT_MAT_RE.test(obj.name));
          if (!explicit && !genericFront) continue;

          let clone = this.cloneByOriginal.get(m);
          if (!clone) {
            clone = m.clone();
            clone.userData = { ...m.userData, __headlightClone: true };
            this.cloneByOriginal.set(m, clone);
            this.boosted.push({
              mat: clone,
              baseEmissive: m.emissive.clone(),
              baseIntensity: m.emissiveIntensity,
            });
          }
          if (isArr) {
            const arr = nextArr ?? (nextArr = mats.slice());
            arr[i] = clone;
            this.replacedSlots.push({ mesh: obj, index: i, original: m, clone });
          } else {
            obj.material = clone;
            this.replacedSlots.push({ mesh: obj, index: null, original: m, clone });
          }
        }
        if (nextArr) obj.material = nextArr;
      });
    }

    // Keep front/rear lens flare sprites just outside real GLB noses/tails when the car is longer than the class default
    if (bodyMaxZ > 1.2 && bodyMaxZ < 4.0) {
      const frontZ = Math.max(this.profile.frontZM, bodyMaxZ - 0.08);
      for (const f of this.frontFlares) f.position.z = frontZ + 0.06;
    }
    if (bodyMinZ < -1.2 && bodyMinZ > -4.0) {
      const rearZ = Math.min(this.profile.rearZM, bodyMinZ + 0.08);
      for (const r of this.rearFlares) r.position.z = rearZ - 0.06;
    }
    if (this.enabled) this.applyMaterialBoost(true);
  }

  private applyMaterialBoost(on: boolean): void {
    for (const b of this.boosted) {
      if (on) {
        b.mat.emissive.setHex(this.profile.color);
        b.mat.emissiveIntensity = Math.max(b.baseIntensity, 4.5);
      } else {
        b.mat.emissive.copy(b.baseEmissive);
        b.mat.emissiveIntensity = b.baseIntensity;
      }
    }
  }

  /**
   * Toggle headlights on/off, update rear brake-light brightening (including daytime braking when headlights are off),
   * and gate each front/rear flare sprite against the camera position so front headlight flares never leak into
   * onboard (cockpit / dash / nose) or behind-car views.
   */
  setEnabled(on: boolean, braking = false, camera?: THREE.Camera, hideFrontFlares = false): void {
    this.scanMaterials();
    if (on !== this.enabled) {
      this.enabled = on;
      const intensity = on ? this.spotIntensity : 0;
      for (const s of this.spots) s.intensity = intensity;
      for (const f of this.frontFlares) f.visible = on && !hideFrontFlares;
      this.applyMaterialBoost(on);
    }
    const rearActive = on || braking;
    const baseRearOpacity = braking ? 0.95 : 0.55;
    if (braking !== this.braking) {
      this.braking = braking;
      const s = this.profile.rearHalfWidthM > 0.01 ? (braking ? 0.36 : 0.28) : (braking ? 0.28 : 0.22);
      for (const r of this.rearFlares) r.scale.setScalar(s);
    }
    if (!on) {
      this.frontMat.opacity = 0;
      for (const f of this.frontFlares) f.visible = false;
    }
    if (!rearActive) {
      this.rearMat.opacity = 0;
      for (const r of this.rearFlares) r.visible = false;
      return;
    }
    if (camera) {
      this.group.updateWorldMatrix(true, true);
      // Local +Z is forward in every car rig's chassisGroup
      _carFwd.set(0, 0, 1).transformDirection(this.group.matrixWorld);
      camera.getWorldPosition(_camPos);

      if (on) {
        let maxFrontVis = 0;
        for (const f of this.frontFlares) {
          if (hideFrontFlares) {
            f.visible = false;
            continue;
          }
          _flarePos.setFromMatrixPosition(f.matrixWorld);
          _toCam.subVectors(_camPos, _flarePos);
          const lenSq = _toCam.lengthSq();
          if (lenSq <= 1e-6) {
            f.visible = false;
            continue;
          }
          const alongFwd = _toCam.dot(_carFwd);
          const vis = alongFwd > 0.1 ? THREE.MathUtils.smoothstep(alongFwd / Math.sqrt(lenSq), 0.12, 0.55) : 0;
          f.visible = vis > 0.01;
          if (vis > maxFrontVis) maxFrontVis = vis;
        }
        this.frontMat.opacity = 0.9 * maxFrontVis;
      }

      let maxRearVis = 0;
      for (const r of this.rearFlares) {
        _flarePos.setFromMatrixPosition(r.matrixWorld);
        _toCam.subVectors(_camPos, _flarePos);
        const lenSq = _toCam.lengthSq();
        if (lenSq <= 1e-6) {
          r.visible = false;
          continue;
        }
        const alongBack = -_toCam.dot(_carFwd);
        const vis = alongBack > 0.1 ? THREE.MathUtils.smoothstep(alongBack / Math.sqrt(lenSq), 0.05, 0.45) : 0;
        r.visible = vis > 0.01;
        if (vis > maxRearVis) maxRearVis = vis;
      }
      this.rearMat.opacity = baseRearOpacity * maxRearVis;
    } else {
      if (on) {
        this.frontMat.opacity = hideFrontFlares ? 0 : 0.9;
        for (const f of this.frontFlares) f.visible = !hideFrontFlares;
      }
      this.rearMat.opacity = baseRearOpacity;
      for (const r of this.rearFlares) r.visible = true;
    }
  }

  get isOn(): boolean {
    return this.enabled;
  }

  get isBraking(): boolean {
    return this.braking;
  }

  dispose(): void {
    this.applyMaterialBoost(false);
    for (const slot of this.replacedSlots) {
      if (slot.index === null) {
        if (slot.mesh.material === slot.clone) slot.mesh.material = slot.original;
      } else if (Array.isArray(slot.mesh.material) && slot.mesh.material[slot.index] === slot.clone) {
        const restored = slot.mesh.material.slice();
        restored[slot.index] = slot.original;
        slot.mesh.material = restored;
      }
    }
    this.replacedSlots.length = 0;
    for (const b of this.boosted) b.mat.dispose();
    this.boosted.length = 0;
    this.cloneByOriginal.clear();
    this.group.removeFromParent();
    this.frontMat.dispose();
    this.rearMat.dispose();
  }
}
