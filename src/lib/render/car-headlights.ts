import * as THREE from "three";
import { anyCarById, type CarClassId, type CarId } from "@/lib/cars/car-registry";

export type HeadlightMode = "auto" | "on" | "off";

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
const GENERIC_LIGHT_MAT_RE = /(?:^|_)lights?\d*$|interactive_lights/i;
const EXCLUDED_LIGHT_RE = /(?:tail|brake|reverse|indicator|dash|wheel|interior|clearled|glass)/i;

const _carPos = new THREE.Vector3();
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

/**
 * Twin forward-facing car headlights (SpotLights + directional lens flares + rear tail-light glow) mounted directly to
 * a car's chassisGroup so the beams follow body pitch, roll and bumps. No shadow maps are allocated, keeping frame
 * cost low.
 */
export class CarHeadlights {
  readonly group = new THREE.Group();
  private readonly spots: [THREE.SpotLight, THREE.SpotLight];
  private readonly frontFlares: THREE.Sprite[] = [];
  private readonly rearFlares: THREE.Sprite[] = [];
  private readonly frontMat: THREE.SpriteMaterial;
  private readonly rearMat: THREE.SpriteMaterial;
  private readonly profile: HeadlightProfile;
  private readonly boosted: BoostedMaterial[] = [];
  private scannedRoot: THREE.Object3D | null = null;
  private scannedChildren: THREE.Object3D[] = [];
  private enabled = false;
  private braking = false;

  constructor(carId: CarId) {
    this.group.name = "CarHeadlights";
    this.profile = headlightProfileFor(carId);
    const p = this.profile;

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
    this.spots = [makeSpot(1), makeSpot(-1)];

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
   */
  private scanMaterials(): void {
    const root = this.scannedRoot;
    if (!root) return;
    const kids = root.children;
    if (kids.length === this.scannedChildren.length && kids.every((c, i) => c === this.scannedChildren[i])) return;
    this.scannedChildren = kids.slice();

    root.updateMatrixWorld(true);
    _invRoot.copy(root.matrixWorld).invert();

    const seen = new Set(this.boosted.map((b) => b.mat));
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

        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (!(m instanceof THREE.MeshStandardMaterial) || seen.has(m)) continue;
          const explicit = HEADLIGHT_MAT_RE.test(m.name) || HEADLIGHT_MAT_RE.test(obj.name);
          const genericFront =
            !explicit &&
            _center.z > 0.75 &&
            !EXCLUDED_LIGHT_RE.test(m.name) &&
            !EXCLUDED_LIGHT_RE.test(obj.name) &&
            (GENERIC_LIGHT_MAT_RE.test(m.name) || GENERIC_LIGHT_MAT_RE.test(obj.name));
          if (!explicit && !genericFront) continue;
          seen.add(m);
          this.boosted.push({
            mat: m,
            baseEmissive: m.emissive.clone(),
            baseIntensity: m.emissiveIntensity,
          });
        }
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
   * Toggle headlights on/off, update rear brake-light brightening, and gate front/rear flare sprites by camera side
   * so front headlight flares never float around the nose when viewed from behind (chase / cockpit / hood).
   */
  setEnabled(on: boolean, braking = false, camera?: THREE.Camera): void {
    this.scanMaterials();
    if (on !== this.enabled) {
      this.enabled = on;
      const intensity = on ? this.profile.intensity : 0;
      this.spots[0].intensity = intensity;
      this.spots[1].intensity = intensity;
      for (const f of this.frontFlares) f.visible = on;
      for (const r of this.rearFlares) r.visible = on;
      this.applyMaterialBoost(on);
    }
    const baseRearOpacity = braking ? 0.95 : 0.55;
    if (on && braking !== this.braking) {
      this.braking = braking;
      this.rearMat.opacity = baseRearOpacity;
      const s = this.profile.rearHalfWidthM > 0.01 ? (braking ? 0.36 : 0.28) : (braking ? 0.28 : 0.22);
      for (const r of this.rearFlares) r.scale.setScalar(s);
    }
    if (on && camera) {
      this.group.updateWorldMatrix(true, false);
      _carPos.setFromMatrixPosition(this.group.matrixWorld);
      // Local +Z is forward in every car rig's chassisGroup
      _carFwd.set(0, 0, 1).transformDirection(this.group.matrixWorld);
      camera.getWorldPosition(_camPos);
      _toCam.subVectors(_camPos, _carPos);
      const lenSq = _toCam.lengthSq();
      if (lenSq > 1e-6) {
        _toCam.multiplyScalar(1 / Math.sqrt(lenSq));
        const dot = _toCam.dot(_carFwd);
        const frontVis = THREE.MathUtils.smoothstep(dot, 0.12, 0.55);
        const rearVis = THREE.MathUtils.smoothstep(-dot, 0.05, 0.45);
        this.frontMat.opacity = 0.9 * frontVis;
        for (const f of this.frontFlares) f.visible = frontVis > 0.01;
        this.rearMat.opacity = baseRearOpacity * rearVis;
        for (const r of this.rearFlares) r.visible = rearVis > 0.01;
      }
    } else if (on) {
      this.frontMat.opacity = 0.9;
      this.rearMat.opacity = baseRearOpacity;
      for (const f of this.frontFlares) f.visible = true;
      for (const r of this.rearFlares) r.visible = true;
    }
  }

  get isOn(): boolean {
    return this.enabled;
  }

  dispose(): void {
    this.applyMaterialBoost(false);
    this.boosted.length = 0;
    this.group.removeFromParent();
    this.frontMat.dispose();
    this.rearMat.dispose();
  }
}
