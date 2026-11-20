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
    intensity: 260,
    distanceM: 165,
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
    intensity: 340,
    distanceM: 185,
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
    intensity: 380,
    distanceM: 195,
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
    intensity: 270,
    distanceM: 155,
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
    intensity: 240,
    distanceM: 145,
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

interface BoostedMaterial {
  mat: THREE.MeshStandardMaterial;
  baseEmissive: THREE.Color;
  baseIntensity: number;
}

/**
 * Twin forward-facing car headlights (SpotLights + lens flares + rear tail-light glow) mounted directly to a car's
 * chassisGroup so the beams follow body pitch, roll and bumps. No shadow maps are allocated, keeping frame cost low.
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
  private scannedChildCount = -1;
  private enabled = false;
  private braking = false;

  constructor(carId: CarId) {
    this.group.name = "CarHeadlights";
    this.profile = headlightProfileFor(carId);
    const p = this.profile;

    const makeSpot = (side: 1 | -1): THREE.SpotLight => {
      const spot = new THREE.SpotLight(p.color, 0, p.distanceM, p.angleRad, p.penumbra, 1.4);
      spot.castShadow = false;
      spot.position.set(side * p.halfWidthM, p.heightM, p.frontZM);
      // Aimed ~48 m down the road, slightly down onto the asphalt and gently outward for corner apexes
      spot.target.position.set(side * (p.halfWidthM + p.aimSpreadM), 0, p.frontZM + 48);
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
    this.scannedChildCount = -1;
  }

  /** Lazily discovers any ported GLB headlight materials once the async model finishes attaching */
  private scanMaterials(): void {
    const root = this.scannedRoot;
    if (!root) return;
    if (root.children.length === this.scannedChildCount) return;
    this.scannedChildCount = root.children.length;
    const seen = new Set(this.boosted.map((b) => b.mat));
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!(m instanceof THREE.MeshStandardMaterial) || seen.has(m)) continue;
        if (!HEADLIGHT_MAT_RE.test(m.name) && !HEADLIGHT_MAT_RE.test(obj.name)) continue;
        seen.add(m);
        this.boosted.push({
          mat: m,
          baseEmissive: m.emissive.clone(),
          baseIntensity: m.emissiveIntensity,
        });
      }
    });
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

  /** Toggle headlights on/off and update rear tail-light brightness on braking */
  setEnabled(on: boolean, braking = false): void {
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
    if (on && braking !== this.braking) {
      this.braking = braking;
      this.rearMat.opacity = braking ? 0.95 : 0.55;
      const s = this.profile.rearHalfWidthM > 0.01 ? (braking ? 0.36 : 0.28) : (braking ? 0.28 : 0.22);
      for (const r of this.rearFlares) r.scale.setScalar(s);
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
