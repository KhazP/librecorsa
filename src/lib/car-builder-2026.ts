import * as THREE from "three";
import type { CarTelemetry, LiveryConfig, TireCompound } from "@/types/f1";
import { attachVf26Model, loadVf26Template, type Vf26ModelInstance } from "@/lib/vf26-car-model";
import type { TyreVisualState } from "@/lib/sim/simulator-car";

/** What the simulator drives on any car rig (the F1 rig below, or the GT3's in gt3-car-model) */
export interface SimCarRig {
  root: THREE.Group;
  chassisGroup: THREE.Group;
  helmetGroup: THREE.Group;
  setLivery: (livery: LiveryConfig) => void;
  setTireCompound: (compound: TireCompound) => void;
  /** Onboard camera anchors once the 3D model has loaded (null until then, or for the procedural car) */
  getCameraAnchors: () => Vf26ModelInstance["cameraAnchors"] | null;
  /** The VF26 body / cockpit group once the model has replaced the procedural car (null until then) */
  getVf26Body: () => THREE.Group | null;
  /** Hide the driver's helmet while the camera is at the eye point */
  setCockpitView: (inCockpit: boolean) => void;
  updateFromTelemetry: (
    telemetry: CarTelemetry,
    pitchRad: number,
    rollRad: number,
    wheelRotationRad: number,
    dtSeconds?: number,
    /** Per-wheel tyre deformation inputs (FR, FL, RR, RL), when the physics provides them */
    tyres?: readonly TyreVisualState[]
  ) => void;
  /** Detach from the scene and free per-instance resources */
  dispose: () => void;
}

export interface F1CarRig2026 extends SimCarRig {
  frontLeftSteerPivot: THREE.Group;
  frontRightSteerPivot: THREE.Group;
  wheelMeshes: THREE.Object3D[];
  frontWingFlapLeft: THREE.Mesh;
  frontWingFlapRight: THREE.Mesh;
  rearWingFlap: THREE.Mesh;
  steeringWheelGroup: THREE.Group;
  shiftLeds: THREE.Mesh[];
  ersLightMaterial: THREE.MeshStandardMaterial;
  brakeGlowMaterials: THREE.MeshStandardMaterial[];
}

export type F1Car2026Rig = F1CarRig2026;

const TIRE_STRIPE_COLORS: Record<TireCompound, number> = {
  soft: 0xe10600, // Pirelli Soft Red
  medium: 0xffd700, // Pirelli Medium Yellow
  hard: 0xf8fafc, // Pirelli Hard White
};

function createCarbonWeaveTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#14161d";
    ctx.fillRect(0, 0, 64, 64);
    for (let y = 0; y < 64; y += 4) {
      for (let x = 0; x < 64; x += 4) {
        const isLight = ((x + y) / 4) % 2 === 0;
        ctx.fillStyle = isLight ? "#222632" : "#0f1117";
        ctx.fillRect(x, y, 4, 2);
        ctx.fillStyle = isLight ? "#0f1117" : "#222632";
        ctx.fillRect(x, y + 2, 4, 2);
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(16, 16);
  return tex;
}

function createWingSponsorTexture(
  text: string,
  bgColor: string,
  textColor: string,
  accentColor: string
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = accentColor;
    ctx.fillRect(0, 0, 512, 10);
    ctx.fillRect(0, 118, 512, 10);

    // Draw twin HP-style blue roundels + central VISIT RWANDA text matching Reference Image 3
    for (const cx of [96, 416]) {
      ctx.fillStyle = "#0096d6";
      ctx.beginPath();
      ctx.arc(cx, 64, 34, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "italic 900 32px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("hp", cx, 65);
    }

    ctx.fillStyle = textColor;
    ctx.font = "italic 900 34px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 256, 66);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function createFrontWingFlapTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // Crisp white upper flap with geometric carbon chevrons & blue HP roundel (Reference Image 3)
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = "#14161d";
    ctx.fillRect(0, 96, 512, 32);
    for (let x = 24; x < 480; x += 76) {
      ctx.beginPath();
      ctx.moveTo(x, 96);
      ctx.lineTo(x + 22, 42);
      ctx.lineTo(x + 36, 96);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = "#0096d6";
    ctx.beginPath();
    ctx.arc(256, 50, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "italic 900 26px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("hp", 256, 51);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function createNoseDeckDecalTexture(driverNumber: string): {
  texture: THREE.CanvasTexture;
  redraw: (num: string) => void;
} {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const redraw = (num: string) => {
    if (!ctx) return;
    ctx.clearRect(0, 0, 256, 512);
    // Modena Yellow & White longitudinal racing stripes
    ctx.fillStyle = "#ffe600";
    ctx.fillRect(110, 0, 36, 512);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(98, 0, 8, 512);
    ctx.fillRect(150, 0, 8, 512);

    // Yellow Shield / Shell Crest near nose tip (top of canvas -> z ~ 2.15)
    ctx.fillStyle = "#ffe600";
    ctx.fillRect(96, 68, 64, 48);
    ctx.strokeStyle = "#d40000";
    ctx.lineWidth = 5;
    ctx.strokeRect(96, 68, 64, 48);

    // HP Blue Roundel at mid-nose (middle of canvas -> z ~ 1.65)
    ctx.fillStyle = "#0096d6";
    ctx.beginPath();
    ctx.arc(128, 195, 42, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = "italic 900 38px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("hp", 128, 197);

    // Driver Number Box on wide upper nose deck right in front of T-Cam (bottom-mid of canvas -> z ~ 1.15)
    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.arc(128, 345, 64, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#ffe600";
    ctx.lineWidth = 6;
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.font = "italic 900 72px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(num, 128, 349);

    tex.needsUpdate = true;
  };

  redraw(driverNumber);
  return { texture: tex, redraw };
}

function createLiveSteeringOled(): {
  texture: THREE.CanvasTexture;
  update: (telemetry: CarTelemetry) => void;
} {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 280;
  const ctx = canvas.getContext("2d");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  let lastKey = "";
  const update = (t: CarTelemetry) => {
    if (!ctx) return;
    const speedInt = Math.round(t.speedKmh);
    const socInt = Math.round(t.ersBatteryPercent);
    const lapSec = Math.floor((t.currentLapTimeMs || 0) / 100) / 10;
    const tFL = Math.round(t.tireTempsC?.[0] ?? 91);
    const tFR = Math.round(t.tireTempsC?.[1] ?? 91);
    const tRL = Math.round(t.tireTempsC?.[2] ?? 92);
    const tRR = Math.round(t.tireTempsC?.[3] ?? 92);
    const key = `${t.gear}_${Math.floor(speedInt / 2)}_${socInt}_${t.activeAeroMode}_${t.manualOverrideActive}_${tFL}_${tRL}_${Math.floor(lapSec * 2)}`;
    if (key === lastKey) return;
    lastKey = key;

    // Deep OLED background matching Reference Image 3
    ctx.fillStyle = "#080b11";
    ctx.fillRect(0, 0, 512, 280);

    // Subtle panel grid dividers (Reference Image 3 layout)
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 2;
    ctx.strokeRect(4, 4, 504, 272);

    // Top 3 telemetry cells: Speed (left) | Lap Time (center) | Delta (right, green highlight)
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(6, 6, 134, 62);
    ctx.fillRect(144, 6, 224, 62);
    ctx.fillStyle = "#064e3b";
    ctx.fillRect(372, 6, 134, 62);
    ctx.strokeStyle = "#10b981";
    ctx.strokeRect(372, 6, 134, 62);

    ctx.fillStyle = "#f8fafc";
    ctx.font = "900 32px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(speedInt), 73, 40);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "bold 14px monospace";
    ctx.fillText("KM/H", 73, 60);

    const mins = Math.floor(lapSec / 60);
    const remSec = (lapSec % 60).toFixed(3).padStart(6, "0");
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 28px monospace";
    ctx.fillText(`${mins > 0 ? `${mins}:` : ""}${remSec}`, 256, 44);

    ctx.fillStyle = "#34d399";
    ctx.font = "900 23px monospace";
    ctx.fillText(`${(socInt / 10).toFixed(1)}`, 439, 34);
    ctx.font = "bold 18px monospace";
    ctx.fillText("(+3.31)", 439, 58);

    // Middle Row: Left Status (`V1` + Tire Temps `91°C / 92°C`), Center Gear Box, Right Status (`P5` + `91°C / 92°C`)
    ctx.fillStyle = "#111827";
    ctx.fillRect(6, 72, 118, 40);
    ctx.fillRect(388, 72, 118, 40);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "900 24px Arial, sans-serif";
    ctx.fillText("V1", 65, 100);
    ctx.fillText(`P${Math.max(1, t.lapCount || 1)}`, 447, 100);

    // Small brake disc / caliper icon cells flanking center gear
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(128, 72, 54, 52);
    ctx.fillRect(128, 128, 54, 52);
    ctx.fillRect(330, 72, 54, 52);
    ctx.fillRect(330, 128, 54, 52);

    // Left & Right Dual Tire Temp Readouts (matching Reference Image 3's 91°C / 92°C)
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(6, 116, 118, 64);
    ctx.fillRect(388, 116, 118, 64);
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 24px Arial, sans-serif";
    ctx.fillText(`${tFL}°C`, 65, 143);
    ctx.fillText(`${tRL}°C`, 65, 172);
    ctx.fillText(`${tFR}°C`, 447, 143);
    ctx.fillText(`${tRR}°C`, 447, 172);

    // Center Gear Box
    ctx.fillStyle = "#0b0f19";
    ctx.fillRect(186, 72, 140, 108);
    ctx.strokeStyle = "#475569";
    ctx.strokeRect(186, 72, 140, 108);
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 92px Arial, sans-serif";
    ctx.fillText(t.gear === 0 ? "N" : t.gear < 0 ? "R" : String(t.gear), 256, 158);

    // Orange OVERTAKE / AERO Mode Banner (Reference Image 3 "ADELANTAR" bar)
    ctx.fillStyle = t.manualOverrideActive ? "#9333ea" : "#f97316";
    ctx.fillRect(6, 186, 500, 32);
    ctx.fillStyle = "#090a0f";
    ctx.font = "900 20px Arial, sans-serif";
    ctx.fillText(
      t.manualOverrideActive
        ? "350KW BOOST OVERRIDE"
        : t.activeAeroMode === "X_MODE"
          ? "X-MODE LOW DRAG"
          : "OVERTAKE READY",
      256,
      209
    );

    // Bottom Segmented ERS Battery Bar (Red left ticks | Yellow center `⚡ 100%` | Green right cap)
    ctx.fillStyle = "#450a0a";
    ctx.fillRect(6, 222, 82, 52);
    for (let sx = 14; sx < 82; sx += 16) {
      ctx.fillStyle = "#ef4444";
      ctx.fillRect(sx, 226, 8, 44);
    }
    ctx.fillStyle = "#eab308";
    ctx.fillRect(92, 222, 328, 52);
    ctx.fillStyle = "#16a34a";
    ctx.fillRect(424, 222, 82, 52);

    ctx.fillStyle = "#090a0f";
    ctx.font = "900 24px monospace";
    ctx.fillText(`⚡ ${socInt}%`, 256, 256);

    tex.needsUpdate = true;
  };

  return { texture: tex, update };
}

function createSteeringFaceplateTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 576;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // Rich dark carbon-fiber weave faceplate background
    ctx.fillStyle = "#10131b";
    ctx.fillRect(0, 0, 1024, 576);
    for (let y = 0; y < 576; y += 8) {
      for (let x = 0; x < 1024; x += 8) {
        ctx.fillStyle = ((x + y) / 8) % 2 === 0 ? "#1a1f2c" : "#0c0f16";
        ctx.fillRect(x, y, 8, 4);
        ctx.fillStyle = ((x + y) / 8) % 2 === 0 ? "#0c0f16" : "#1a1f2c";
        ctx.fillRect(x, y + 4, 8, 4);
      }
    }

    // Upper LED brow bezel & ORACLE / SCUDERIA HP branding strip
    ctx.fillStyle = "#080a0f";
    ctx.fillRect(230, 16, 564, 44);
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 3;
    ctx.strokeRect(230, 16, 564, 44);

    // Coordinate mapping helper: faceplatePlane is 0.22m wide x 0.132m tall centered at (0, -0.002)
    // Note: faceplatePlane is rotated by Math.PI around Y, so canvas u=0 is +X (Left) and u=1 is -X (Right)
    const toCanvasX = (wx: number) => 512 - (wx / 0.22) * 1024;
    const toCanvasY = (wy: number) => 288 - ((wy + 0.002) / 0.132) * 576;

    // Draw yellow/green numbered rotary encoder tick rings on lower bridge (matching Reference Image 3)
    const drawRotaryRing = (
      wx: number,
      wy: number,
      radiusPx: number,
      ringColor: string,
      title: string
    ) => {
      const cx = toCanvasX(wx);
      const cy = toCanvasY(wy);

      // Outer colored arc around the rotary knob
      ctx.strokeStyle = ringColor;
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(cx, cy, radiusPx, Math.PI * 0.72, Math.PI * 2.28);
      ctx.stroke();

      // Tick marks & numbers 1..9 outside the yellow arc
      ctx.fillStyle = "#f8fafc";
      ctx.font = "900 13px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let n = 1; n <= 9; n++) {
        const ang = Math.PI * 0.76 + ((n - 1) / 8) * Math.PI * 1.48;
        const tx = cx + Math.cos(ang) * (radiusPx + 14);
        const ty = cy + Math.sin(ang) * (radiusPx + 14);
        ctx.fillText(String(n), tx, ty);
      }

      // Label badge above/below ring
      ctx.fillStyle = "#090d16";
      ctx.fillRect(cx - 28, cy + radiusPx + 6, 56, 18);
      ctx.strokeStyle = ringColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - 28, cy + radiusPx + 6, 56, 18);
      ctx.fillStyle = "#ffffff";
      ctx.font = "900 13px Arial, sans-serif";
      ctx.fillText(title, cx, cy + radiusPx + 16);
    };

    // 3 Lower Rotary Dials (`DIFF`, `MODE`, `BIAS`) matching <original_task> & Reference Image 3
    drawRotaryRing(0.025, -0.036, 36, "#facc15", "DIFF");
    drawRotaryRing(0.0, -0.050, 34, "#22c55e", "MODE");
    drawRotaryRing(-0.025, -0.036, 36, "#facc15", "BIAS");

    // Printed white engineering labels (`DIFF`, `BIAS` tabs + `WING`, `OSD` outer horn labels)
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(toCanvasX(0.056) - 34, toCanvasY(-0.041) - 12, 68, 22);
    ctx.fillRect(toCanvasX(-0.056) - 34, toCanvasY(-0.041) - 12, 68, 22);
    ctx.strokeStyle = "#475569";
    ctx.lineWidth = 2;
    ctx.strokeRect(toCanvasX(0.056) - 34, toCanvasY(-0.041) - 12, 68, 22);
    ctx.strokeRect(toCanvasX(-0.056) - 34, toCanvasY(-0.041) - 12, 68, 22);

    ctx.fillStyle = "#f8fafc";
    ctx.font = "900 14px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("DIFF", toCanvasX(0.056), toCanvasY(-0.041));
    ctx.fillText("BIAS", toCanvasX(-0.056), toCanvasY(-0.041));

    ctx.font = "900 15px Arial, sans-serif";
    ctx.fillText("WING", toCanvasX(0.104), toCanvasY(0.033));
    ctx.fillText("OSD", toCanvasX(-0.104), toCanvasY(0.033));
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function createButtonCapTexture(
  label: string,
  bgColor: string,
  textColor = "#ffffff"
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = bgColor;
    ctx.beginPath();
    ctx.arc(64, 64, 54, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = 5;
    ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.font = "900 44px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 64, 67);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createHelmetCrownTexture(livery: LiveryConfig): {
  texture: THREE.CanvasTexture;
  redraw: (liv: LiveryConfig) => void;
} {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const redraw = (liv: LiveryConfig) => {
    if (!ctx) return;
    ctx.fillStyle = liv.primary;
    ctx.fillRect(0, 0, 512, 512);

    // Concentric geometric racing rings on helmet dome (Reference Image 1 style)
    ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
    ctx.lineWidth = 10;
    for (let r = 45; r <= 240; r += 26) {
      ctx.beginPath();
      ctx.arc(256, 256, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Accent racing stripes framing the crown
    ctx.strokeStyle = liv.accent;
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.arc(256, 256, 210, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(256, 256, 210, 1.15 * Math.PI, 1.85 * Math.PI);
    ctx.stroke();

    // Tricolor badge near front of crown (top of texture = +Z forward)
    ctx.fillStyle = "#0096d6";
    ctx.fillRect(226, 56, 20, 14);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(246, 56, 20, 14);
    ctx.fillStyle = "#e10600";
    ctx.fillRect(266, 56, 20, 14);

    // Large Driver Number in center-top of helmet dome (facing T-Cam, Reference Image 1)
    ctx.save();
    ctx.translate(256, 205);
    ctx.font = "italic 900 148px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 16;
    if (typeof ctx.strokeText === "function") {
      ctx.strokeText(liv.number, 0, 0);
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillText(liv.number, 0, 0);
    ctx.restore();

    // Sponsor logo ("hp" + "RWA") below the number on the helmet crown (matching "eni" in Reference Image 1)
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(148, 305, 216, 74);
    ctx.strokeStyle = "#0096d6";
    ctx.lineWidth = 5;
    ctx.strokeRect(148, 305, 216, 74);

    ctx.fillStyle = "#0f172a";
    ctx.font = "italic 900 44px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("hp • RWA", 256, 344);

    tex.needsUpdate = true;
  };

  redraw(livery);
  return { texture: tex, redraw };
}

function createHelmetSideTexture(livery: LiveryConfig): {
  texture: THREE.CanvasTexture;
  redraw: (liv: LiveryConfig) => void;
} {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const redraw = (liv: LiveryConfig) => {
    if (!ctx) return;
    ctx.fillStyle = liv.primary;
    ctx.fillRect(0, 0, 1024, 512);

    // High-contrast neon/Modena yellow & white dynamic aero swooshes on helmet sides (Reference Image 2)
    ctx.fillStyle = "#facc15";
    ctx.fillRect(0, 168, 1024, 34);
    ctx.fillRect(0, 290, 1024, 28);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 202, 1024, 14);
    ctx.fillRect(0, 318, 1024, 12);

    // Geometric chevrons along the temple/jawline
    ctx.fillStyle = "#0f172a";
    for (let x = 40; x < 1000; x += 160) {
      ctx.beginPath();
      ctx.moveTo(x, 220);
      ctx.lineTo(x + 75, 250);
      ctx.lineTo(x, 282);
      ctx.closePath();
      ctx.fill();
    }

    // Dark carbon visor brow strip with bold white sponsor text ("SCUDERIA HP" / "CROWDSTRIKE" in Reference Image 2)
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 120, 1024, 46);
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 28px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const cx of [180, 512, 844]) {
      ctx.fillText("SCUDERIA • HP • RWANDA", cx, 144);
    }

    tex.needsUpdate = true;
  };

  redraw(livery);
  return { texture: tex, redraw };
}

function createHaloSponsorTexture(livery: LiveryConfig): {
  texture: THREE.CanvasTexture;
  redraw: (liv: LiveryConfig) => void;
} {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const redraw = (liv: LiveryConfig) => {
    if (!ctx) return;
    // Upper band (y = 0..108, v = 0.58..1.0): Painted upper Halo fairing strip (like pink BWT/eni/MSC arch in Ref Image 1)
    ctx.fillStyle = liv.primary;
    ctx.fillRect(0, 0, 1024, 108);
    ctx.fillStyle = liv.accent;
    ctx.fillRect(0, 0, 1024, 10);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 98, 1024, 10);

    ctx.fillStyle = "#ffffff";
    ctx.font = "italic 900 40px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("SCUDERIA", 260, 54);
    ctx.fillText("hp • RWANDA", 512, 54);
    ctx.fillText("MSC • FIA", 764, 54);

    // Lower band (y = 108..256, v = 0.0..0.58): Dark carbon/titanium inner Halo hoop with white sponsor decals (Ref Images 1 & 2)
    ctx.fillStyle = "#141821";
    ctx.fillRect(0, 108, 1024, 148);
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 110, 1020, 144);

    ctx.fillStyle = "#f8fafc";
    ctx.font = "italic 900 32px Arial, sans-serif";
    ctx.fillText("PIRELLI", 150, 184);
    ctx.fillText("RS TURBO 26", 345, 184);
    ctx.fillStyle = "#38bdf8";
    ctx.fillText("VISIT RWANDA", 512, 184);
    ctx.fillStyle = "#f8fafc";
    ctx.fillText("RWANDAIR", 685, 184);
    ctx.fillText("SHELL", 874, 184);

    tex.needsUpdate = true;
  };

  redraw(livery);
  return { texture: tex, redraw };
}

function createMirrorGlassTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, "#0284c7");
    grad.addColorStop(0.52, "#7dd3fc");
    grad.addColorStop(0.58, "#334155");
    grad.addColorStop(1, "#1e293b");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 64);
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 252, 60);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createWheelBrowDecalTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#12151e";
    ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = "#e10600";
    ctx.fillRect(0, 0, 256, 14);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 14, 256, 6);
    ctx.font = "italic 900 34px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("hp • RWA", 128, 72);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

interface CrossSectionSlice {
  z: number;
  halfWidthBot: number;
  halfWidthMid: number;
  halfWidthTop: number;
  yBot: number;
  yMid: number;
  yTop: number;
}

/**
 * Builds a smooth, closed 3D lofted bodywork mesh from longitudinal cross-section slices.
 * Produces contoured F1 monocoque, sloped nose, and coke-bottle engine cover without boxy artifacts.
 */
function buildLoftedBodyGeometry(
  slices: CrossSectionSlice[]
): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  const ringPts = 8; // 8 points around each perimeter ring (counter-clockwise looking from +Z)
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < slices.length; i++) {
    const s = slices[i];
    const v = i / Math.max(1, slices.length - 1);
    const ring: [number, number, number][] = [
      [0, s.yTop, s.z], // 0: Top Center
      [s.halfWidthTop, s.yTop * 0.96 + s.yMid * 0.04, s.z], // 1: Top Right shoulder
      [s.halfWidthMid, s.yMid, s.z], // 2: Mid Right flank
      [s.halfWidthBot, s.yBot, s.z], // 3: Bottom Right chine
      [0, s.yBot, s.z], // 4: Bottom Center
      [-s.halfWidthBot, s.yBot, s.z], // 5: Bottom Left chine
      [-s.halfWidthMid, s.yMid, s.z], // 6: Mid Left flank
      [-s.halfWidthTop, s.yTop * 0.96 + s.yMid * 0.04, s.z], // 7: Top Left shoulder
    ];

    for (let j = 0; j < ringPts; j++) {
      positions.push(ring[j][0], ring[j][1], ring[j][2]);
      uvs.push(j / ringPts, v);
    }

    if (i < slices.length - 1) {
      const base0 = i * ringPts;
      const base1 = (i + 1) * ringPts;
      for (let j = 0; j < ringPts; j++) {
        const jNext = (j + 1) % ringPts;
        const a = base0 + j;
        const b = base0 + jNext;
        const c = base1 + j;
        const d = base1 + jNext;
        indices.push(a, b, c, b, d, c);
      }
    }
  }

  // Front cap (+Z normal) & Rear cap (-Z normal) so there are never open holes
  const firstBase = 0;
  for (let j = 1; j < ringPts - 1; j++) {
    indices.push(firstBase, firstBase + j + 1, firstBase + j);
  }
  const lastBase = (slices.length - 1) * ringPts;
  for (let j = 1; j < ringPts - 1; j++) {
    indices.push(lastBase, lastBase + j, lastBase + j + 1);
  }

  geom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3)
  );
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

/**
 * Builds an authentic 18-inch Pirelli P-Zero F1 tire with rounded shoulders using LatheGeometry.
 */
function buildRoundedF1TireGeometry(
  outerRadius: number,
  innerRimRadius: number,
  width: number
): THREE.BufferGeometry {
  const halfW = width * 0.5;
  const shoulderW = width * 0.14;
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(innerRimRadius, -halfW * 0.92),
    new THREE.Vector2(innerRimRadius + 0.03, -halfW),
    new THREE.Vector2(outerRadius - 0.038, -halfW),
    new THREE.Vector2(outerRadius - 0.012, -(halfW - shoulderW * 0.5)),
    new THREE.Vector2(outerRadius, -(halfW - shoulderW)),
    new THREE.Vector2(outerRadius, halfW - shoulderW),
    new THREE.Vector2(outerRadius - 0.012, halfW - shoulderW * 0.5),
    new THREE.Vector2(outerRadius - 0.038, halfW),
    new THREE.Vector2(innerRimRadius + 0.03, halfW),
    new THREE.Vector2(innerRimRadius, halfW * 0.92),
  ];
  const geom = new THREE.LatheGeometry(pts, 36);
  geom.rotateZ(Math.PI * 0.5);
  return geom;
}

export function createF1Car2026(
  initialLivery: LiveryConfig,
  initialCompound: TireCompound = "soft"
): F1CarRig2026 {
  const root = new THREE.Group();
  const chassisGroup = new THREE.Group();
  root.add(chassisGroup);
  /** VF26 mod model; replaces the procedural car once loaded (see the end of this function) */
  let vf26: Vf26ModelInstance | null = null;

  const carbonTex = createCarbonWeaveTexture();

  // Glossy Automotive Clearcoat Materials (2026 F1 Showcar finish)
  const primaryPaintMat = new THREE.MeshPhysicalMaterial({
    color: initialLivery.primary,
    roughness: 0.14,
    metalness: 0.28,
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
  });

  const secondaryPaintMat = new THREE.MeshPhysicalMaterial({
    color: initialLivery.secondary,
    roughness: 0.18,
    metalness: 0.25,
    clearcoat: 0.9,
    clearcoatRoughness: 0.08,
  });

  const accentPaintMat = new THREE.MeshPhysicalMaterial({
    color: initialLivery.accent,
    roughness: 0.2,
    metalness: 0.22,
    clearcoat: 0.85,
  });

  const carbonMat = new THREE.MeshPhysicalMaterial({
    color: 0x181b22,
    map: carbonTex,
    roughness: 0.34,
    metalness: 0.35,
    clearcoat: 0.45,
    clearcoatRoughness: 0.2,
  });

  const titaniumHaloMat = new THREE.MeshPhysicalMaterial({
    color: 0x1c2029,
    roughness: 0.25,
    metalness: 0.65,
    clearcoat: 0.7,
  });

  const tireRubberMat = new THREE.MeshPhysicalMaterial({
    color: 0x14161b,
    roughness: 0.48,
    metalness: 0.08,
    clearcoat: 0.22,
    clearcoatRoughness: 0.35,
  });

  const rimMat = new THREE.MeshStandardMaterial({
    color: 0x1e2430,
    roughness: 0.28,
    metalness: 0.82,
  });

  const tireStripeMat = new THREE.MeshStandardMaterial({
    color: TIRE_STRIPE_COLORS[initialCompound],
    emissive: TIRE_STRIPE_COLORS[initialCompound],
    emissiveIntensity: 0.45,
    roughness: 0.25,
  });

  // ============================================================================
  // 1. 2026 GROUND-EFFECT VENTURI FLOOR, PLANK & SCULPTED EDGE WINGS
  // ============================================================================
  const floorMain = new THREE.Mesh(
    new THREE.BoxGeometry(1.78, 0.032, 3.55),
    carbonMat
  );
  floorMain.position.set(0, 0.065, -0.18);
  floorMain.castShadow = true;
  floorMain.receiveShadow = true;
  chassisGroup.add(floorMain);

  // Sculpted carbon floor fences (bargeboard-style 2026 wake control)
  for (const side of [-1, 1]) {
    const floorEdgeStrake = new THREE.Mesh(
      new THREE.BoxGeometry(0.055, 0.075, 2.55),
      carbonMat
    );
    floorEdgeStrake.position.set(side * 0.88, 0.09, -0.12);
    chassisGroup.add(floorEdgeStrake);

    const floorAccentLine = new THREE.Mesh(
      new THREE.BoxGeometry(0.025, 0.02, 2.45),
      secondaryPaintMat
    );
    floorAccentLine.position.set(side * 0.9, 0.115, -0.12);
    chassisGroup.add(floorAccentLine);

    const inwashingWinglet = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.24, 0.42),
      carbonMat
    );
    inwashingWinglet.position.set(side * 0.78, 0.2, 0.86);
    inwashingWinglet.rotation.y = side * 0.24;
    chassisGroup.add(inwashingWinglet);
  }

  // ============================================================================
  // 2. LOFTED 2026 MONOCOQUE, SLOPED FLAT-TOP NOSE & COKE-BOTTLE ENGINE COVER
  // ============================================================================
  const mainBodyGeom = buildLoftedBodyGeometry([
    // Nose Tip above Front Wing (narrow sculpted 2026 nose tip - Reference Image 4)
    {
      z: 2.42,
      halfWidthBot: 0.058,
      halfWidthMid: 0.068,
      halfWidthTop: 0.052,
      yBot: 0.175,
      yMid: 0.215,
      yTop: 0.255,
    },
    // Mid Nose Cone
    {
      z: 1.75,
      halfWidthBot: 0.105,
      halfWidthMid: 0.118,
      halfWidthTop: 0.092,
      yBot: 0.19,
      yMid: 0.285,
      yTop: 0.365,
    },
    // Front Bulkhead / Suspension Mount
    {
      z: 1.05,
      halfWidthBot: 0.21,
      halfWidthMid: 0.25,
      halfWidthTop: 0.21,
      yBot: 0.18,
      yMid: 0.38,
      yTop: 0.53,
    },
    // Forward Cockpit Cowling (Halo Front V-Mount)
    {
      z: 0.72,
      halfWidthBot: 0.26,
      halfWidthMid: 0.31,
      halfWidthTop: 0.25,
      yBot: 0.12,
      yMid: 0.4,
      yTop: 0.55,
    },
    // Recessed Cockpit Instrument Well (below steering wheel & hands)
    {
      z: 0.58,
      halfWidthBot: 0.27,
      halfWidthMid: 0.32,
      halfWidthTop: 0.27,
      yBot: 0.11,
      yMid: 0.36,
      yTop: 0.47,
    },
    // Recessed Cockpit Seat Well (low coaming so steering wheel & helmet are unobstructed)
    {
      z: 0.16,
      halfWidthBot: 0.3,
      halfWidthMid: 0.34,
      halfWidthTop: 0.29,
      yBot: 0.1,
      yMid: 0.35,
      yTop: 0.44,
    },
    // Rear Cockpit Headrest Bulkhead (stays low behind helmet so T-Cam has 100% clear view)
    {
      z: -0.09,
      halfWidthBot: 0.31,
      halfWidthMid: 0.34,
      halfWidthTop: 0.22,
      yBot: 0.1,
      yMid: 0.38,
      yTop: 0.54,
    },
    // Roll Hoop / Airbox Base (set aft of z = -0.26 so T-Cam at z = -0.05 is completely clear)
    {
      z: -0.28,
      halfWidthBot: 0.32,
      halfWidthMid: 0.34,
      halfWidthTop: 0.17,
      yBot: 0.1,
      yMid: 0.45,
      yTop: 0.79,
    },
    // Mid Engine Cover
    {
      z: -0.95,
      halfWidthBot: 0.24,
      halfWidthMid: 0.26,
      halfWidthTop: 0.09,
      yBot: 0.1,
      yMid: 0.42,
      yTop: 0.69,
    },
    // Tapered Coke-Bottle Rear Gearbox Exit (completely enclosed, zero cylinders!)
    {
      z: -1.78,
      halfWidthBot: 0.12,
      halfWidthMid: 0.14,
      halfWidthTop: 0.06,
      yBot: 0.14,
      yMid: 0.34,
      yTop: 0.5,
    },
  ]);

  const mainBodyMesh = new THREE.Mesh(mainBodyGeom, primaryPaintMat);
  mainBodyMesh.castShadow = true;
  mainBodyMesh.receiveShadow = true;
  chassisGroup.add(mainBodyMesh);

  // Conformal 3D Crowned Nose Top-Deck Decal & Racing Stripe (matches nose center ridge & shoulder slope with zero clipping)
  const noseDecal = createNoseDeckDecalTexture(initialLivery.number);
  const noseDeckStations = [
    { z: 0.68, halfW: 0.19, yCenter: 0.568, yEdge: 0.561 },
    { z: 1.05, halfW: 0.165, yCenter: 0.538, yEdge: 0.531 },
    { z: 1.75, halfW: 0.086, yCenter: 0.373, yEdge: 0.368 },
    { z: 2.38, halfW: 0.048, yCenter: 0.268, yEdge: 0.263 },
  ];
  const noseDeckPos: number[] = [];
  const noseDeckUvs: number[] = [];
  const noseDeckIdx: number[] = [];
  for (let i = 0; i < noseDeckStations.length; i++) {
    const st = noseDeckStations[i];
    const v = i / (noseDeckStations.length - 1);
    // 3 vertices per station: Left (+X, u=0), Center (0, u=0.5), Right (-X, u=1)
    noseDeckPos.push(
      st.halfW,
      st.yEdge,
      st.z,
      0,
      st.yCenter,
      st.z,
      -st.halfW,
      st.yEdge,
      st.z
    );
    noseDeckUvs.push(0, v, 0.5, v, 1, v);
    if (i < noseDeckStations.length - 1) {
      const b0 = i * 3;
      const b1 = (i + 1) * 3;
      noseDeckIdx.push(
        b0,
        b0 + 1,
        b1,
        b0 + 1,
        b1 + 1,
        b1,
        b0 + 1,
        b0 + 2,
        b1 + 1,
        b0 + 2,
        b1 + 2,
        b1 + 1
      );
    }
  }
  const noseDeckGeom = new THREE.BufferGeometry();
  noseDeckGeom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(noseDeckPos, 3)
  );
  noseDeckGeom.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(noseDeckUvs, 2)
  );
  noseDeckGeom.setIndex(noseDeckIdx);
  noseDeckGeom.computeVertexNormals();

  const noseDecalMesh = new THREE.Mesh(
    noseDeckGeom,
    new THREE.MeshStandardMaterial({
      map: noseDecal.texture,
      transparent: true,
      roughness: 0.18,
      metalness: 0.15,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    })
  );
  chassisGroup.add(noseDecalMesh);

  // ============================================================================
  // 3. SCULPTED DOWNWASH SIDEPODS (Coke-Bottle Tapered — Outward Winding!)
  // ============================================================================
  for (const side of [-1, 1]) {
    const sidepodGeom = new THREE.BufferGeometry();
    // 5 longitudinal stations for each sculpted downwash sidepod
    const spStations = [
      // Station 0: High-Mounted Sidepod Inlet Lip (z = +0.58)
      {
        z: 0.58,
        xIn: side * 0.28,
        xOut: side * 0.72,
        yBot: 0.14,
        yMid: 0.34,
        yTop: 0.51,
      },
      // Station 1: Maximum Shoulder Width & Deep Undercut (z = +0.15)
      {
        z: 0.15,
        xIn: side * 0.28,
        xOut: side * 0.75,
        yBot: 0.12,
        yMid: 0.35,
        yTop: 0.5,
      },
      // Station 2: Downwash Waterslide Ramp (z = -0.48)
      {
        z: -0.48,
        xIn: side * 0.24,
        xOut: side * 0.66,
        yBot: 0.1,
        yMid: 0.3,
        yTop: 0.43,
      },
      // Station 3: Coke-Bottle Pinch (z = -1.12)
      {
        z: -1.12,
        xIn: side * 0.18,
        xOut: side * 0.44,
        yBot: 0.1,
        yMid: 0.25,
        yTop: 0.35,
      },
      // Station 4: Gearbox Tail Closure (z = -1.68)
      {
        z: -1.68,
        xIn: side * 0.11,
        xOut: side * 0.19,
        yBot: 0.12,
        yMid: 0.22,
        yTop: 0.29,
      },
    ];

    const spPos: number[] = [];
    const spIdx: number[] = [];
    const ptsPerRing = 6;

    for (let i = 0; i < spStations.length; i++) {
      const st = spStations[i];
      const ring: [number, number, number][] = [
        [st.xIn, st.yTop, st.z],
        [st.xOut * 0.92, st.yTop, st.z],
        [st.xOut, st.yMid, st.z],
        [st.xOut * 0.78, st.yBot, st.z], // Deep undercut!
        [st.xIn, st.yBot, st.z],
        [st.xIn, st.yMid, st.z],
      ];
      for (let j = 0; j < ptsPerRing; j++) {
        spPos.push(ring[j][0], ring[j][1], ring[j][2]);
      }
      if (i < spStations.length - 1) {
        const b0 = i * ptsPerRing;
        const b1 = (i + 1) * ptsPerRing;
        for (let j = 0; j < ptsPerRing; j++) {
          const jn = (j + 1) % ptsPerRing;
          if (side > 0) {
            spIdx.push(b0 + j, b0 + jn, b1 + j, b0 + jn, b1 + jn, b1 + j);
          } else {
            spIdx.push(b0 + j, b1 + j, b0 + jn, b0 + jn, b1 + j, b1 + jn);
          }
        }
      }
    }

    // Close front & back faces of sidepod with outward-facing normals
    const lastB = (spStations.length - 1) * ptsPerRing;
    for (let j = 1; j < ptsPerRing - 1; j++) {
      if (side > 0) {
        spIdx.push(0, j + 1, j);
        spIdx.push(lastB, lastB + j, lastB + j + 1);
      } else {
        spIdx.push(0, j, j + 1);
        spIdx.push(lastB, lastB + j + 1, lastB + j);
      }
    }

    sidepodGeom.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(spPos, 3)
    );
    sidepodGeom.setIndex(spIdx);
    sidepodGeom.computeVertexNormals();

    const sidepodMesh = new THREE.Mesh(sidepodGeom, primaryPaintMat);
    sidepodMesh.castShadow = true;
    sidepodMesh.receiveShadow = true;
    chassisGroup.add(sidepodMesh);

    // Recessed Dark Carbon Radiator Intake Mouth at front of Sidepod
    const intakeMouth = new THREE.Mesh(
      new THREE.BoxGeometry(0.36, 0.16, 0.08),
      carbonMat
    );
    intakeMouth.position.set(side * 0.5, 0.39, 0.57);
    chassisGroup.add(intakeMouth);

    // Sidepod Shoulder Accent Flash (White/Yellow Ferrari SF-26 beltline)
    const sideFlash = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.055, 1.32),
      secondaryPaintMat
    );
    sideFlash.position.set(side * 0.695, 0.38, -0.15);
    sideFlash.rotation.y = side * -0.14;
    sideFlash.rotation.x = 0.08;
    chassisGroup.add(sideFlash);
  }

  // ============================================================================
  // 4. AIRBOX INTAKE, F1 BROADCAST T-CAM POD & DORSAL SHARK FIN
  // ============================================================================
  // Sculpted Roll-Hoop Airbox Fairing set cleanly behind T-Cam lens (z <= -0.12)
  const airboxHood = new THREE.Mesh(
    new THREE.CylinderGeometry(0.095, 0.135, 0.34, 16),
    primaryPaintMat
  );
  airboxHood.rotation.x = Math.PI * 0.46;
  airboxHood.position.set(0, 0.77, -0.29);
  chassisGroup.add(airboxHood);

  const airboxIntakeMouth = new THREE.Mesh(
    new THREE.CylinderGeometry(0.062, 0.074, 0.06, 16),
    carbonMat
  );
  airboxIntakeMouth.rotation.x = Math.PI * 0.5;
  airboxIntakeMouth.position.set(0, 0.78, -0.13);
  chassisGroup.add(airboxIntakeMouth);

  // Official F1 T-Cam Broadcast Pod on Roll Hoop (camera mounts at front tip z = -0.05)
  const tCamStalk = new THREE.Mesh(
    new THREE.BoxGeometry(0.026, 0.085, 0.075),
    carbonMat
  );
  tCamStalk.position.set(0, 0.875, -0.22);
  chassisGroup.add(tCamStalk);

  const tCamWing = new THREE.Mesh(
    new THREE.BoxGeometry(0.26, 0.024, 0.085),
    carbonMat
  );
  tCamWing.position.set(0, 0.925, -0.19);
  chassisGroup.add(tCamWing);

  const tCamLed = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.028, 0.09),
    new THREE.MeshBasicMaterial({ color: 0xfacc15 })
  );
  tCamLed.position.set(0, 0.928, -0.19);
  chassisGroup.add(tCamLed);

  // Dorsal Shark Fin with Ferrari White/Yellow Top Edge Trim
  const sharkFinShape = new THREE.Shape();
  sharkFinShape.moveTo(-0.28, 0.79);
  sharkFinShape.lineTo(-1.48, 0.65);
  sharkFinShape.lineTo(-1.58, 0.44);
  sharkFinShape.lineTo(-0.28, 0.52);
  sharkFinShape.closePath();

  const sharkFinGeom = new THREE.ExtrudeGeometry(sharkFinShape, {
    depth: 0.022,
    bevelEnabled: false,
  });
  sharkFinGeom.rotateY(-Math.PI * 0.5);
  sharkFinGeom.translate(0.011, 0, 0);
  const sharkFinMesh = new THREE.Mesh(sharkFinGeom, primaryPaintMat);
  chassisGroup.add(sharkFinMesh);

  const sharkFinTrim = new THREE.Mesh(
    new THREE.BoxGeometry(0.026, 0.032, 1.2),
    secondaryPaintMat
  );
  sharkFinTrim.position.set(0, 0.725, -0.88);
  sharkFinTrim.rotation.x = -0.12;
  chassisGroup.add(sharkFinTrim);

  // ============================================================================
  // 5. TRUE SCULPTED 3D TITANIUM HALO (Continuous Hoop + Dual-Band Sponsor Arch)
  // ============================================================================
  const haloGroup = new THREE.Group();
  const haloSponsorTex = createHaloSponsorTexture(initialLivery);
  const haloSponsorMat = new THREE.MeshStandardMaterial({
    map: haloSponsorTex.texture,
    roughness: 0.22,
    metalness: 0.14,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });

  // Single continuous symmetric Halo curve from Left Rear (+X) through Front Apex (0) to Right Rear (-X) — zero center seam!
  const haloMainCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.252, 0.525, 0.01), // Left rear structural mount
    new THREE.Vector3(0.292, 0.685, 0.26), // Left side rising beside helmet
    new THREE.Vector3(0.258, 0.788, 0.52), // Left upper branch sweeping forward
    new THREE.Vector3(0.132, 0.835, 0.69), // Left approach to front V-junction
    new THREE.Vector3(0.0, 0.842, 0.752), // Center front apex (zero seam!)
    new THREE.Vector3(-0.132, 0.835, 0.69), // Right approach to front V-junction
    new THREE.Vector3(-0.258, 0.788, 0.52), // Right upper branch sweeping forward
    new THREE.Vector3(-0.292, 0.685, 0.26), // Right side rising beside helmet
    new THREE.Vector3(-0.252, 0.525, 0.01), // Right rear structural mount
  ]);
  const haloMainGeom = new THREE.TubeGeometry(
    haloMainCurve,
    64,
    0.022,
    16,
    false
  );
  const haloMainMesh = new THREE.Mesh(haloMainGeom, titaniumHaloMat);
  haloMainMesh.castShadow = true;
  haloGroup.add(haloMainMesh);

  // Conformal Dual-Band Halo Sponsor Arch Ribbon (u=0 Left +X -> u=1 Right -X, v=1 Painted Upper Fairing -> v=0 Dark Titanium Inner Hoop)
  const bannerSteps = 56;
  const bannerPos: number[] = [];
  const bannerUvs: number[] = [];
  const bannerIdx: number[] = [];
  for (let i = 0; i <= bannerSteps; i++) {
    const u = i / bannerSteps;
    // Span from uCurve = 0.13 (left side beside helmet) to uCurve = 0.87 (right side beside helmet)
    const uCurve = 0.13 + u * 0.74;
    const pt = haloMainCurve.getPointAt(uCurve);
    // Lower inner edge (v = 0) and Upper painted fairing crest (v = 1) facing driver & T-Cam (-Z/+Y)
    const xBot = pt.x * 0.945;
    const yBot = pt.y - 0.016;
    const zBot = pt.z - 0.021;

    const xTop = pt.x * 1.015;
    const yTop = pt.y + 0.021;
    const zTop = pt.z - 0.006;

    bannerPos.push(xBot, yBot, zBot, xTop, yTop, zTop);
    bannerUvs.push(u, 0, u, 1);

    if (i < bannerSteps) {
      const b0 = i * 2;
      const b1 = (i + 1) * 2;
      bannerIdx.push(b0, b1, b1 + 1, b0, b1 + 1, b0 + 1);
    }
  }
  const haloBannerGeom = new THREE.BufferGeometry();
  haloBannerGeom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(bannerPos, 3)
  );
  haloBannerGeom.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(bannerUvs, 2)
  );
  haloBannerGeom.setIndex(bannerIdx);
  haloBannerGeom.computeVertexNormals();
  const haloBannerMesh = new THREE.Mesh(haloBannerGeom, haloSponsorMat);
  haloGroup.add(haloBannerMesh);

  // Sculpted Halo Rear Transition Plinths & Front V-Transition Gussets
  for (const side of [-1, 1]) {
    const rearPlinth = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.026, 0.09, 10, 14),
      titaniumHaloMat
    );
    rearPlinth.position.set(side * 0.258, 0.545, 0.05);
    rearPlinth.rotation.x = 0.52;
    rearPlinth.rotation.z = side * -0.14;
    haloGroup.add(rearPlinth);

    const vGussetCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(side * 0.075, 0.832, 0.72),
      new THREE.Vector3(side * 0.025, 0.775, 0.745),
      new THREE.Vector3(0, 0.72, 0.76),
    ]);
    const vGussetMesh = new THREE.Mesh(
      new THREE.TubeGeometry(vGussetCurve, 10, 0.013, 10, false),
      titaniumHaloMat
    );
    haloGroup.add(vGussetMesh);
  }

  // Central Aerodynamic Teardrop Front Strut (slim 12mm profile)
  const centerStrutCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.835, 0.745),
    new THREE.Vector3(0, 0.68, 0.775),
    new THREE.Vector3(0, 0.54, 0.815),
  ]);
  const centerStrutGeom = new THREE.TubeGeometry(
    centerStrutCurve,
    12,
    0.011,
    10,
    false
  );
  centerStrutGeom.scale(0.62, 1.0, 1.45);
  const centerStrutMesh = new THREE.Mesh(centerStrutGeom, titaniumHaloMat);
  haloGroup.add(centerStrutMesh);

  chassisGroup.add(haloGroup);

  // Twin Thin Metallic Nose Telemetry / Pitot Antennas ahead of Halo V-Strut (Reference Images 1 & 2)
  const antennaMat = new THREE.MeshStandardMaterial({
    color: 0xcbd5e1,
    metalness: 0.9,
    roughness: 0.2,
  });
  for (const [ax, az, h] of [
    [0.024, 1.02, 0.095],
    [-0.024, 1.14, 0.082],
  ] as const) {
    const ant = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0012, 0.0022, h, 8),
      antennaMat
    );
    ant.position.set(ax, 0.54 + h * 0.5, az);
    chassisGroup.add(ant);
  }

  // ============================================================================
  // 6. COCKPIT RECESS, DRIVER HELMET & BUTTERFLY F1 STEERING WHEEL WITH OLED
  // ============================================================================
  const cockpitTub = new THREE.Mesh(
    new THREE.BoxGeometry(0.44, 0.12, 0.68),
    carbonMat
  );
  cockpitTub.position.set(0, 0.40, 0.36);
  chassisGroup.add(cockpitTub);

  // Left & Right Cockpit Side Coaming Bolsters with Carbon Padding
  for (const side of [-1, 1]) {
    const bolsterMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.058, 0.085, 0.64),
      primaryPaintMat
    );
    bolsterMesh.position.set(side * 0.245, 0.515, 0.36);
    chassisGroup.add(bolsterMesh);

    const bolsterPad = new THREE.Mesh(
      new THREE.BoxGeometry(0.026, 0.072, 0.56),
      carbonMat
    );
    bolsterPad.position.set(side * 0.212, 0.522, 0.36);
    chassisGroup.add(bolsterPad);
  }

  // Sculpted U-Shaped Carbon Headrest Collar around Driver Helmet (Reference Image 1)
  const headrestCollar = new THREE.Mesh(
    new THREE.TorusGeometry(0.205, 0.042, 12, 24, Math.PI),
    carbonMat
  );
  headrestCollar.rotation.x = Math.PI * 0.5;
  headrestCollar.rotation.z = Math.PI;
  headrestCollar.position.set(0, 0.555, 0.22);
  chassisGroup.add(headrestCollar);

  // Driver Torso / Racing Suit Shoulders & HANS Device Collar inside Cockpit
  const driverTorso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.11, 0.16, 10, 16),
    primaryPaintMat
  );
  driverTorso.rotation.z = Math.PI * 0.5;
  driverTorso.position.set(0, 0.45, 0.25);
  chassisGroup.add(driverTorso);

  const hansCollar = new THREE.Mesh(
    new THREE.TorusGeometry(0.095, 0.022, 10, 20, Math.PI * 1.15),
    carbonMat
  );
  hansCollar.rotation.x = Math.PI * 0.42;
  hansCollar.rotation.z = Math.PI * 0.92;
  hansCollar.position.set(0, 0.505, 0.25);
  chassisGroup.add(hansCollar);

  // Driver Helmet (Iconic Scarlet Red Shell with Planar-Mapped Crown Decal #16, Side Badges & Blue Visor)
  const helmetGroup = new THREE.Group();
  helmetGroup.position.set(0, 0.625, 0.24);

  const helmetShell = new THREE.Mesh(
    new THREE.SphereGeometry(0.136, 28, 24),
    primaryPaintMat
  );
  helmetShell.scale.set(0.95, 1.0, 1.08); // Authentic elongated F1 aero helmet profile
  helmetGroup.add(helmetShell);

  // Conformal Crown Decal Dome with Planar XZ UVs so #16, stripes & HP logo are crisp from T-Cam (Ref Image 1)
  const helmetCrownTex = createHelmetCrownTexture(initialLivery);
  const crownCapGeom = new THREE.SphereGeometry(
    0.1375,
    28,
    18,
    0,
    Math.PI * 2,
    0,
    Math.PI * 0.46
  );
  crownCapGeom.scale(0.95, 1.0, 1.08);
  const crownPosAttr = crownCapGeom.attributes.position;
  const crownUvArr = new Float32Array(crownPosAttr.count * 2);
  for (let i = 0; i < crownPosAttr.count; i++) {
    const vx = crownPosAttr.getX(i);
    const vz = crownPosAttr.getZ(i);
    // Planar top projection: +X is Left, +Z is Forward
    crownUvArr[i * 2] = THREE.MathUtils.clamp(0.5 - vx / 0.25, 0.02, 0.98);
    crownUvArr[i * 2 + 1] = THREE.MathUtils.clamp(0.5 + vz / 0.27, 0.02, 0.98);
  }
  crownCapGeom.setAttribute("uv", new THREE.BufferAttribute(crownUvArr, 2));
  const helmetCrownMesh = new THREE.Mesh(
    crownCapGeom,
    new THREE.MeshStandardMaterial({
      map: helmetCrownTex.texture,
      roughness: 0.16,
      metalness: 0.12,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    })
  );
  helmetGroup.add(helmetCrownMesh);

  // Helmet Side Temple Band with Driver Number & Sponsor Stripe (visible in Cockpit Shoulder Cam - Ref Image 2)
  const helmetSideTex = createHelmetSideTexture(initialLivery);
  const helmetSideBand = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1365, 0.1375, 0.068, 28, 1, true),
    new THREE.MeshStandardMaterial({
      map: helmetSideTex.texture,
      roughness: 0.18,
      metalness: 0.12,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    })
  );
  helmetSideBand.scale.set(0.95, 1.0, 1.08);
  helmetSideBand.position.set(0, -0.012, 0);
  helmetGroup.add(helmetSideBand);

  // Iridescent Blue-Cyan Mirrored Visor with White Top Sponsor Strip
  // Note: phiStart = Math.PI * 0.14 .. Math.PI * 0.86 centers the visor on +Z (phi = Math.PI * 0.5)
  // WITH rotation.y = 0 so non-uniform scale (0.95, 1.0, 1.08) matches helmetShell with zero temple protrusion!
  const visorMat = new THREE.MeshPhysicalMaterial({
    color: 0x0284c7,
    emissive: 0x0369a1,
    emissiveIntensity: 0.18,
    metalness: 0.92,
    roughness: 0.04,
    clearcoat: 1.0,
  });
  const visor = new THREE.Mesh(
    new THREE.SphereGeometry(
      0.1385,
      24,
      14,
      Math.PI * 0.14,
      Math.PI * 0.72,
      Math.PI * 0.28,
      Math.PI * 0.25
    ),
    visorMat
  );
  visor.scale.set(0.95, 1.0, 1.08);
  helmetGroup.add(visor);

  // White Visor Tear-Off Top Banner Strip
  const visorStrip = new THREE.Mesh(
    new THREE.SphereGeometry(
      0.1392,
      24,
      8,
      Math.PI * 0.15,
      Math.PI * 0.70,
      Math.PI * 0.25,
      Math.PI * 0.045
    ),
    secondaryPaintMat
  );
  visorStrip.scale.set(0.95, 1.0, 1.08);
  helmetGroup.add(visorStrip);

  chassisGroup.add(helmetGroup);

  // ============================================================================
  // 6B. SLEEK CARBON/SCARLET WING MIRRORS ON TWIN AERO VANES (Ref Images 1, 2, 3)
  // ============================================================================
  const mirrorGlassMat = new THREE.MeshStandardMaterial({
    map: createMirrorGlassTexture(),
    emissiveMap: createMirrorGlassTexture(),
    emissive: 0x38bdf8,
    emissiveIntensity: 0.35,
    metalness: 0.75,
    roughness: 0.08,
  });

  for (const side of [-1, 1]) {
    const mirrorGroup = new THREE.Group();
    // Mounted forward at z = 0.68, x = ±0.465, y = 0.635 (ahead of steering wheel & sidepod intake)
    // so both mirrors are clearly visible in T-Cam (Ref 1), Shoulder Cam (Ref 2), AND Cockpit Cam (Ref 3)!
    mirrorGroup.position.set(side * 0.465, 0.635, 0.68);
    mirrorGroup.rotation.y = side * -0.10;

    // Swept horizontal carbon aero stalk from forward cockpit coaming
    const innerStalk = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.011, 0.048),
      carbonMat
    );
    innerStalk.position.set(-side * 0.13, -0.028, -0.02);
    innerStalk.rotation.z = side * 0.16;
    mirrorGroup.add(innerStalk);

    // Twin vertical carbon support vanes rising from sidepod leading edge
    for (const zOff of [-0.022, 0.022]) {
      const verticalVane = new THREE.Mesh(
        new THREE.BoxGeometry(0.008, 0.11, 0.036),
        carbonMat
      );
      verticalVane.position.set(-side * 0.015, -0.068, zOff - 0.04);
      verticalVane.rotation.z = side * -0.08;
      verticalVane.rotation.x = 0.25;
      mirrorGroup.add(verticalVane);
    }

    // Streamlined rounded carbon/red aero mirror shell (Capsule + Carbon Shroud)
    const mirrorShell = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.024, 0.11, 10, 16),
      primaryPaintMat
    );
    mirrorShell.rotation.z = Math.PI * 0.5;
    mirrorShell.scale.set(1.0, 0.85, 1.35);
    mirrorGroup.add(mirrorShell);

    // Carbon fiber peripheral aero visor shroud around the mirror face
    const mirrorBezel = new THREE.Mesh(
      new THREE.BoxGeometry(0.152, 0.048, 0.052),
      carbonMat
    );
    mirrorBezel.position.set(0, 0, -0.012);
    mirrorGroup.add(mirrorBezel);

    // Reflective sky-blue tinted mirror glass facing driver & T-Cam (-Z)
    const mirrorGlass = new THREE.Mesh(
      new THREE.PlaneGeometry(0.138, 0.038),
      mirrorGlassMat
    );
    mirrorGlass.position.set(0, 0, -0.039);
    mirrorGlass.rotation.y = Math.PI;
    mirrorGroup.add(mirrorGlass);

    chassisGroup.add(mirrorGroup);
  }

  // ============================================================================
  // 6C. BUTTERFLY F1 STEERING WHEEL, LABELED 3D BUTTONS & SCULPTED 3D GLOVED HANDS
  // ============================================================================
  // Carbon Steering Column Shaft connecting bulkhead to Butterfly Steering Wheel
  const steeringColumn = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.018, 0.24, 14),
    carbonMat
  );
  steeringColumn.rotation.x = Math.PI * 0.5 - 0.16;
  steeringColumn.position.set(0, 0.598, 0.67);
  chassisGroup.add(steeringColumn);

  const steeringWheelGroup = new THREE.Group();
  steeringWheelGroup.position.set(0, 0.616, 0.565);
  steeringWheelGroup.rotation.x = 0.16;

  // Contoured Butterfly Carbon Chassis with Left & Right Enclosed Thumb Cutouts
  const wheelShape = new THREE.Shape();
  wheelShape.moveTo(-0.072, 0.068);
  wheelShape.lineTo(0.072, 0.068); // Top LED brow
  wheelShape.quadraticCurveTo(0.118, 0.066, 0.128, 0.038); // Upper left shoulder
  wheelShape.lineTo(0.132, -0.044); // Left grip outer edge
  wheelShape.quadraticCurveTo(0.122, -0.072, 0.086, -0.068); // Lower left grip horn
  wheelShape.lineTo(0.052, -0.058);
  wheelShape.quadraticCurveTo(0.0, -0.068, -0.052, -0.058); // Lower rotary hub bridge
  wheelShape.lineTo(-0.086, -0.068); // Lower right grip horn
  wheelShape.quadraticCurveTo(-0.122, -0.072, -0.132, -0.044); // Right grip outer edge
  wheelShape.lineTo(-0.128, 0.038); // Upper right shoulder
  wheelShape.quadraticCurveTo(-0.118, 0.066, -0.072, 0.068);
  wheelShape.closePath();

  // Left and Right Thumb Cutout Holes (positioned outboard of the inner button arc)
  for (const side of [-1, 1]) {
    const hole = new THREE.Path();
    hole.moveTo(side * 0.078, 0.038);
    hole.lineTo(side * 0.102, 0.034);
    hole.lineTo(side * 0.104, 0.004);
    hole.lineTo(side * 0.078, 0.006);
    hole.closePath();
    wheelShape.holes.push(hole);
  }

  const wheelBodyGeom = new THREE.ExtrudeGeometry(wheelShape, {
    depth: 0.018,
    bevelEnabled: true,
    bevelThickness: 0.003,
    bevelSize: 0.0025,
    bevelSegments: 3,
  });
  wheelBodyGeom.translate(0, 0, -0.009);
  const wheelPlate = new THREE.Mesh(wheelBodyGeom, carbonMat);
  steeringWheelGroup.add(wheelPlate);

  // High-Resolution Carbon & Rotary Scale Faceplate Overlay on Driver Side (-Z)
  const faceplateTex = createSteeringFaceplateTexture();
  const faceplatePlane = new THREE.Mesh(
    new THREE.PlaneGeometry(0.22, 0.132),
    new THREE.MeshStandardMaterial({
      map: faceplateTex,
      emissiveMap: faceplateTex,
      emissive: 0xffffff,
      emissiveIntensity: 0.32,
      roughness: 0.32,
      metalness: 0.18,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    })
  );
  faceplatePlane.position.set(0, -0.002, -0.0122);
  faceplatePlane.rotation.y = Math.PI;
  steeringWheelGroup.add(faceplatePlane);

  // Recessed Bezel & Multi-Panel F1 Telemetry OLED Screen
  const oledBezel = new THREE.Mesh(
    new THREE.BoxGeometry(0.102, 0.056, 0.004),
    new THREE.MeshStandardMaterial({ color: 0x090d16, roughness: 0.4 })
  );
  oledBezel.position.set(0, 0.015, -0.0125);
  steeringWheelGroup.add(oledBezel);

  const liveOled = createLiveSteeringOled();
  const oledScreen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.096, 0.050),
    new THREE.MeshBasicMaterial({ map: liveOled.texture })
  );
  oledScreen.position.set(0, 0.015, -0.0148);
  oledScreen.rotation.y = Math.PI;
  steeringWheelGroup.add(oledScreen);

  // 12 Labeled Colored 3D Pushbuttons arranged in ergonomic vertical arcs flanking the LCD screen (Reference Image 3)
  // Note: From driver's perspective (-Z looking toward +Z), +X is Left and -X is Right!
  const buttonSpecs: Array<{
    x: number;
    y: number;
    label: string;
    bg: string;
    fg: string;
  }> = [
    // Left button arc (+X: N, -1, R, F, OT, and lower Q)
    { x: 0.068, y: 0.049, label: "N", bg: "#16a34a", fg: "#ffffff" },
    { x: 0.063, y: 0.031, label: "-1", bg: "#38bdf8", fg: "#090a0f" },
    { x: 0.061, y: 0.013, label: "R", bg: "#f59e0b", fg: "#090a0f" },
    { x: 0.061, y: -0.005, label: "F", bg: "#9333ea", fg: "#ffffff" },
    { x: 0.063, y: -0.023, label: "OT", bg: "#16a34a", fg: "#ffffff" },
    { x: 0.050, y: -0.054, label: "Q", bg: "#38bdf8", fg: "#090a0f" },
    // Right button arc (-X: PL, +1, W, Y, +10, and lower OK)
    { x: -0.068, y: 0.049, label: "PL", bg: "#ef4444", fg: "#ffffff" },
    { x: -0.063, y: 0.031, label: "+1", bg: "#38bdf8", fg: "#090a0f" },
    { x: -0.061, y: 0.013, label: "W", bg: "#2563eb", fg: "#ffffff" },
    { x: -0.061, y: -0.005, label: "Y", bg: "#eab308", fg: "#090a0f" },
    { x: -0.063, y: -0.023, label: "+10", bg: "#64748b", fg: "#ffffff" },
    { x: -0.050, y: -0.054, label: "OK", bg: "#16a34a", fg: "#ffffff" },
  ];

  const bezelRingMat = new THREE.MeshStandardMaterial({
    color: 0xcbd5e1,
    metalness: 0.85,
    roughness: 0.25,
  });

  for (const btn of buttonSpecs) {
    // Raised metallic protective bezel ring around button
    const guardRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.0066, 0.0012, 8, 18),
      bezelRingMat
    );
    guardRing.position.set(btn.x, btn.y, -0.0135);
    steeringWheelGroup.add(guardRing);

    // 3D Colored Button Barrel
    const bodyMat = new THREE.MeshStandardMaterial({
      color: btn.bg,
      roughness: 0.35,
    });
    const btnCyl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0056, 0.0056, 0.0055, 16),
      bodyMat
    );
    btnCyl.rotation.x = Math.PI * 0.5;
    btnCyl.position.set(btn.x, btn.y, -0.0145);
    steeringWheelGroup.add(btnCyl);

    // Crisp Self-Lit Printed Button Cap Face facing driver (-Z)
    const btnCapFace = new THREE.Mesh(
      new THREE.CircleGeometry(0.0056, 20),
      new THREE.MeshBasicMaterial({
        map: createButtonCapTexture(btn.label, btn.bg, btn.fg),
      })
    );
    btnCapFace.position.set(btn.x, btn.y, -0.0175);
    btnCapFace.rotation.y = Math.PI;
    steeringWheelGroup.add(btnCapFace);
  }

  // 3 Lower Sculpted Rotary Dials (`DIFF`, `MODE`, `BIAS`) centered inside the yellow indicator tick rings!
  for (const [rx, ry, capColor] of [
    [0.025, -0.036, 0x1e293b],
    [0.0, -0.050, 0x1e293b],
    [-0.025, -0.036, 0x1e293b],
  ] as const) {
    const rotaryKnob = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0052, 0.0062, 0.0085, 16),
      new THREE.MeshStandardMaterial({
        color: capColor,
        roughness: 0.28,
        metalness: 0.65,
      })
    );
    rotaryKnob.rotation.x = Math.PI * 0.5;
    rotaryKnob.position.set(rx, ry, -0.0155);
    steeringWheelGroup.add(rotaryKnob);

    // Yellow/White pointer needle across the rotary switch
    const pointerBar = new THREE.Mesh(
      new THREE.BoxGeometry(0.0022, 0.0095, 0.0025),
      secondaryPaintMat
    );
    pointerBar.position.set(rx, ry + 0.001, -0.0202);
    steeringWheelGroup.add(pointerBar);
  }

  // 2 Outer-Horn Thumb-Wheel Encoders (`WING` on Left, `OSD` on Right — Reference Image 3)
  for (const side of [-1, 1]) {
    const thumbEncoder = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0075, 0.0075, 0.011, 16),
      new THREE.MeshStandardMaterial({
        color: 0x2563eb,
        metalness: 0.78,
        roughness: 0.22,
      })
    );
    thumbEncoder.rotation.z = Math.PI * 0.5;
    thumbEncoder.position.set(side * 0.108, 0.018, -0.011);
    steeringWheelGroup.add(thumbEncoder);

    // Carbon Fiber Shift Paddle on Front (+Z) of Steering Wheel
    const shiftPaddle = new THREE.Mesh(
      new THREE.BoxGeometry(0.028, 0.062, 0.005),
      carbonMat
    );
    shiftPaddle.position.set(side * 0.092, 0.008, 0.016);
    shiftPaddle.rotation.y = side * 0.18;
    steeringWheelGroup.add(shiftPaddle);
  }

  // 15 Top RPM Shift Light LEDs
  const shiftLeds: THREE.Mesh[] = [];
  const numLeds = 15;
  for (let i = 0; i < numLeds; i++) {
    const ledColor = i < 5 ? 0x00d26a : i < 10 ? 0xe10600 : 0x38bdf8;
    const ledMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      emissive: ledColor,
      emissiveIntensity: 0.35,
    });
    const ledMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.0058, 0.0058, 0.005),
      ledMat
    );
    const xPos = (0.5 - i / (numLeds - 1)) * 0.098;
    ledMesh.position.set(xPos, 0.056, -0.013);
    steeringWheelGroup.add(ledMesh);
    shiftLeds.push(ledMesh);
  }

  // Sculpted Suede Side Grips + Contoured 3D Driver Gloves, Curled Fingers & Dynamic Elbow-to-Wrist Forearms
  const suedeGripMat = new THREE.MeshStandardMaterial({
    color: 0x14161c,
    roughness: 0.88,
    metalness: 0.04,
  });
  const gloveYellowMat = new THREE.MeshStandardMaterial({
    color: 0xeab308,
    roughness: 0.48,
    metalness: 0.05,
  });
  const gloveBlackPadMat = new THREE.MeshStandardMaterial({
    color: 0x18181b,
    roughness: 0.68,
    metalness: 0.06,
  });

  const wristAnchors: THREE.Object3D[] = [];
  const dynamicForearms: THREE.Mesh[] = [];

  for (const side of [-1, 1]) {
    // Contoured Black Suede Grip Molded to Outer Rim
    const suedeGrip = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.0145, 0.066, 10, 16),
      suedeGripMat
    );
    suedeGrip.position.set(side * 0.116, -0.008, -0.002);
    suedeGrip.rotation.z = side * -0.06;
    steeringWheelGroup.add(suedeGrip);

    // 3D Sculpted Driver Hand Group gripping the lower-outer suede handle (leaving WING/OSD & inner buttons 100% clear)
    const handGroup = new THREE.Group();
    handGroup.position.set(side * 0.116, -0.014, -0.006);

    // Rounded Dorsal Hand / Metacarpal Shell
    const dorsalHand = new THREE.Mesh(
      new THREE.SphereGeometry(0.021, 18, 16),
      gloveYellowMat
    );
    dorsalHand.scale.set(0.82, 1.25, 0.92);
    dorsalHand.position.set(side * 0.004, -0.002, -0.005);
    handGroup.add(dorsalHand);

    // Black Nomex Knuckle & Palm Contrast Trim Pad (matches Reference Images 1, 2, 3)
    const knucklePad = new THREE.Mesh(
      new THREE.SphereGeometry(0.0185, 14, 12),
      gloveBlackPadMat
    );
    knucklePad.scale.set(0.75, 1.02, 0.82);
    knucklePad.position.set(side * 0.006, 0.002, -0.010);
    handGroup.add(knucklePad);

    // 4 Curled 3D Fingers wrapping around the front (+Z) of the suede grip
    for (let f = 0; f < 4; f++) {
      const fy = 0.016 - f * 0.011;
      const fingerProximal = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.0055, 0.018, 8, 12),
        gloveYellowMat
      );
      fingerProximal.rotation.x = Math.PI * 0.48;
      fingerProximal.rotation.y = side * -0.25;
      fingerProximal.position.set(side * 0.003, fy, 0.011);
      handGroup.add(fingerProximal);

      const fingerTip = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.0048, 0.013, 8, 12),
        gloveBlackPadMat
      );
      fingerTip.rotation.z = Math.PI * 0.5;
      fingerTip.position.set(-side * 0.007, fy, 0.018);
      handGroup.add(fingerTip);
    }

    // Sculpted 3D Thumb hooking inward into the Thumb Cutout (`x = ±0.088, y = +0.012`)
    const thumbProximal = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.0072, 0.020, 8, 12),
      gloveYellowMat
    );
    thumbProximal.position.set(-side * 0.013, 0.019, -0.004);
    thumbProximal.rotation.z = side * 0.62;
    thumbProximal.rotation.x = 0.28;
    handGroup.add(thumbProximal);

    const thumbTip = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.0062, 0.014, 8, 12),
      gloveBlackPadMat
    );
    thumbTip.position.set(-side * 0.023, 0.026, 0.004);
    thumbTip.rotation.x = Math.PI * 0.38;
    handGroup.add(thumbTip);

    // Compact Nomex Glove Wrist Cuff at bottom of hand
    const wristCuff = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.017, 0.026, 10, 14),
      gloveYellowMat
    );
    wristCuff.position.set(0, -0.026, -0.010);
    wristCuff.rotation.x = 0.42;
    handGroup.add(wristCuff);

    const cuffBand = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0178, 0.0182, 0.012, 16),
      secondaryPaintMat
    );
    cuffBand.position.set(0, -0.032, -0.013);
    cuffBand.rotation.x = 0.42;
    handGroup.add(cuffBand);

    // Wrist anchor point used to dynamically orient the forearm from the cockpit elbow
    const wristAnchor = new THREE.Object3D();
    wristAnchor.position.set(0, -0.036, -0.015);
    handGroup.add(wristAnchor);
    wristAnchors.push(wristAnchor);

    steeringWheelGroup.add(handGroup);

    // Dynamic Forearm Mesh in chassisGroup connecting fixed cockpit elbow to moving wristAnchor
    const forearmMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0175, 0.023, 1.0, 14),
      primaryPaintMat
    );
    chassisGroup.add(forearmMesh);
    dynamicForearms.push(forearmMesh);
  }

  chassisGroup.add(steeringWheelGroup);

  // Helper to keep driver forearms smoothly connected between cockpit elbows and moving steering-wheel wrists
  const syncDriverForearms = () => {
    steeringWheelGroup.updateMatrix();
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const wristLocal = wristAnchors[i].position
        .clone()
        .add(new THREE.Vector3(side * 0.116, -0.014, -0.006))
        .applyMatrix4(steeringWheelGroup.matrix);
      const elbowLocal = new THREE.Vector3(side * 0.165, 0.455, 0.32);
      const dir = new THREE.Vector3().subVectors(wristLocal, elbowLocal);
      const len = Math.max(0.05, dir.length());
      const forearm = dynamicForearms[i];
      forearm.scale.set(1, len, 1);
      forearm.position.copy(elbowLocal).addScaledVector(dir, 0.5);
      forearm.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        dir.normalize()
      );
    }
  };
  syncDriverForearms();

  // Delicate Metallic Y-Pitot Aero Sensor Probe on Nose Deck (Reference Image 4)
  const pitotMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    metalness: 0.94,
    roughness: 0.14,
  });
  const pitotBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0022, 0.0038, 0.075, 10),
    pitotMat
  );
  pitotBase.position.set(0, 0.348, 2.12);
  pitotBase.rotation.x = -0.08;
  chassisGroup.add(pitotBase);

  for (const side of [-1, 1]) {
    const pitotBranch = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0014, 0.0022, 0.032, 8),
      pitotMat
    );
    pitotBranch.position.set(side * 0.0055, 0.392, 2.126);
    pitotBranch.rotation.z = side * -0.28;
    chassisGroup.add(pitotBranch);

    const pitotTip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0011, 0.0014, 0.042, 8),
      pitotMat
    );
    pitotTip.rotation.x = Math.PI * 0.5;
    pitotTip.position.set(side * 0.0095, 0.405, 2.145);
    chassisGroup.add(pitotTip);
  }

  // ============================================================================
  // 7. 2026 ACTIVE FRONT WING (Low Spoon Mainplane + Curved Vertical Endplates)
  // ============================================================================
  const fwGroup = new THREE.Group();
  fwGroup.position.set(0, 0.088, 2.28);

  const fwMainPlane = new THREE.Mesh(
    new THREE.BoxGeometry(1.64, 0.022, 0.24),
    carbonMat
  );
  fwMainPlane.castShadow = true;
  fwGroup.add(fwMainPlane);

  const fwSecondElement = new THREE.Mesh(
    new THREE.BoxGeometry(1.60, 0.018, 0.15),
    primaryPaintMat
  );
  fwSecondElement.position.set(0, 0.020, -0.05);
  fwSecondElement.rotation.x = 0.12;
  fwGroup.add(fwSecondElement);

  const fwFlapMat = new THREE.MeshStandardMaterial({
    map: createFrontWingFlapTexture(),
    roughness: 0.22,
    metalness: 0.15,
  });

  // Active Flaps tucked low on mainplane so they don't block the Nose Cam bottom view
  const frontWingFlapLeft = new THREE.Mesh(
    new THREE.BoxGeometry(0.66, 0.016, 0.13),
    fwFlapMat
  );
  frontWingFlapLeft.position.set(0.43, 0.038, -0.11);
  frontWingFlapLeft.rotation.x = 0.24;
  fwGroup.add(frontWingFlapLeft);

  const frontWingFlapRight = new THREE.Mesh(
    new THREE.BoxGeometry(0.66, 0.016, 0.13),
    fwFlapMat
  );
  frontWingFlapRight.position.set(-0.43, 0.038, -0.11);
  frontWingFlapRight.rotation.x = 0.24;
  fwGroup.add(frontWingFlapRight);

  for (const side of [-1, 1]) {
    // Nose Pylons
    const pylon = new THREE.Mesh(
      new THREE.BoxGeometry(0.022, 0.14, 0.18),
      carbonMat
    );
    pylon.position.set(side * 0.072, 0.075, -0.02);
    fwGroup.add(pylon);

    // Sculpted Vertical 2026 Front-Wing Endplate at bottom-left/right corners of Nose Cam (Reference Image 4)
    const epGroup = new THREE.Group();
    epGroup.position.set(side * 0.80, 0.13, 0.06);
    epGroup.rotation.z = side * 0.16; // Curves slightly inward at the top
    epGroup.rotation.y = side * -0.06;

    const epBlade = new THREE.Mesh(
      new THREE.BoxGeometry(0.022, 0.28, 0.38),
      carbonMat
    );
    epBlade.castShadow = true;
    epGroup.add(epBlade);

    // Swept upper trailing corner fillet on endplate
    const epTopTip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.011, 0.011, 0.36, 12),
      carbonMat
    );
    epTopTip.rotation.x = Math.PI * 0.5;
    epTopTip.position.set(0, 0.14, 0);
    epGroup.add(epTopTip);

    // Outer Endplate Diveplane Canard & White Aero Trim
    const canard = new THREE.Mesh(
      new THREE.BoxGeometry(0.055, 0.014, 0.22),
      secondaryPaintMat
    );
    canard.position.set(side * 0.028, 0.02, 0.02);
    canard.rotation.x = 0.22;
    epGroup.add(canard);

    fwGroup.add(epGroup);
  }
  chassisGroup.add(fwGroup);

  // ============================================================================
  // 8. 2026 ACTIVE REAR WING, BEAM WING, DIFFUSER & ENDPLATE LED STRIPS
  // ============================================================================
  // Twin Swan-Neck Rear Wing Pylons
  for (const side of [-1, 1]) {
    const rwPylon = new THREE.Mesh(
      new THREE.BoxGeometry(0.022, 0.48, 0.2),
      carbonMat
    );
    rwPylon.position.set(side * 0.065, 0.56, -1.78);
    rwPylon.rotation.x = 0.16;
    chassisGroup.add(rwPylon);
  }

  // Lower Beam Wing (2026 Ground-Effect Extractor Aid)
  const beamWing = new THREE.Mesh(
    new THREE.BoxGeometry(0.96, 0.026, 0.22),
    carbonMat
  );
  beamWing.position.set(0, 0.36, -1.88);
  beamWing.rotation.x = 0.24;
  chassisGroup.add(beamWing);

  // Rear Wing Spoon Mainplane
  const rwMainPlane = new THREE.Mesh(
    new THREE.BoxGeometry(1.04, 0.034, 0.26),
    primaryPaintMat
  );
  rwMainPlane.position.set(0, 0.73, -1.86);
  rwMainPlane.rotation.x = 0.1;
  chassisGroup.add(rwMainPlane);

  // Pivoting 2026 X-Mode / Z-Mode Upper Rear Wing Flap with White + HP + VISIT RWANDA Banner
  const rwSponsorTex = createWingSponsorTexture(
    "VISIT RWANDA",
    "#f8fafc",
    "#0f172a",
    "#d40000"
  );
  const rwFlapFaceMat = new THREE.MeshStandardMaterial({
    map: rwSponsorTex,
    roughness: 0.22,
    metalness: 0.15,
  });
  const rearWingFlap = new THREE.Mesh(
    new THREE.BoxGeometry(1.02, 0.028, 0.22),
    [
      secondaryPaintMat,
      secondaryPaintMat,
      rwFlapFaceMat,
      carbonMat,
      rwFlapFaceMat,
      rwFlapFaceMat,
    ]
  );
  rearWingFlap.position.set(0, 0.825, -1.93);
  rearWingFlap.rotation.x = 0.42;
  chassisGroup.add(rearWingFlap);

  const ersLightMaterial = new THREE.MeshStandardMaterial({
    color: 0xe10600,
    emissive: 0xe10600,
    emissiveIntensity: 2.4,
  });

  // Sculpted Rear Wing Endplates with Vertical FIA Rain/Brake LED Strips
  for (const side of [-1, 1]) {
    const rwEndplate = new THREE.Mesh(
      new THREE.BoxGeometry(0.028, 0.56, 0.42),
      primaryPaintMat
    );
    rwEndplate.position.set(side * 0.52, 0.61, -1.87);
    chassisGroup.add(rwEndplate);

    const rwEndplateTrim = new THREE.Mesh(
      new THREE.BoxGeometry(0.032, 0.08, 0.43),
      secondaryPaintMat
    );
    rwEndplateTrim.position.set(side * 0.52, 0.84, -1.87);
    chassisGroup.add(rwEndplateTrim);

    // Glowing Rear Endplate Vertical LED Strip (visible from Chase Cam!)
    const epLedStrip = new THREE.Mesh(
      new THREE.BoxGeometry(0.018, 0.28, 0.02),
      ersLightMaterial
    );
    epLedStrip.position.set(side * 0.52, 0.56, -2.085);
    chassisGroup.add(epLedStrip);
  }

  // Structural Carbon Gearbox & Rear Differential Housing (anchors rear wishbones)
  const gearboxHousing = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.22, 0.52),
    carbonMat
  );
  gearboxHousing.position.set(0, 0.27, -1.62);
  chassisGroup.add(gearboxHousing);

  // Multi-Strake Venturi Rear Diffuser Tunnel & Central Inconel Exhaust
  const diffuserRoof = new THREE.Mesh(
    new THREE.BoxGeometry(1.12, 0.04, 0.46),
    carbonMat
  );
  diffuserRoof.position.set(0, 0.24, -1.9);
  diffuserRoof.rotation.x = 0.2;
  chassisGroup.add(diffuserRoof);

  for (const sx of [-0.54, -0.34, -0.16, 0.16, 0.34, 0.54]) {
    const strake = new THREE.Mesh(
      new THREE.BoxGeometry(0.022, 0.2, 0.44),
      carbonMat
    );
    strake.position.set(sx, 0.14, -1.9);
    chassisGroup.add(strake);
  }

  // Rear Crash Attenuator & Central FIA Rain Light Cluster
  const attenuator = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 0.14, 0.28),
    carbonMat
  );
  attenuator.position.set(0, 0.23, -1.98);
  chassisGroup.add(attenuator);

  const ersLightMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.055, 0.12, 0.03),
    ersLightMaterial
  );
  ersLightMesh.position.set(0, 0.23, -2.13);
  chassisGroup.add(ersLightMesh);

  // Central Titanium/Inconel Exhaust Shroud + Recessed Dark Turbine Ring
  const exhaustPipe = new THREE.Mesh(
    new THREE.CylinderGeometry(0.054, 0.06, 0.24, 18),
    new THREE.MeshStandardMaterial({
      color: 0x334155,
      metalness: 0.88,
      roughness: 0.24,
    })
  );
  exhaustPipe.rotation.x = Math.PI * 0.5;
  exhaustPipe.position.set(0, 0.39, -1.92);
  chassisGroup.add(exhaustPipe);

  const exhaustInnerCavity = new THREE.Mesh(
    new THREE.CircleGeometry(0.045, 16),
    new THREE.MeshBasicMaterial({
      color: 0x090a0f,
      side: THREE.DoubleSide,
    })
  );
  exhaustInnerCavity.position.set(0, 0.39, -2.041);
  chassisGroup.add(exhaustInnerCavity);

  const exhaustGlow = new THREE.Mesh(
    new THREE.RingGeometry(0.034, 0.046, 18),
    new THREE.MeshBasicMaterial({
      color: 0x9a3412,
      side: THREE.DoubleSide,
    })
  );
  exhaustGlow.position.set(0, 0.39, -2.042);
  chassisGroup.add(exhaustGlow);

  // ============================================================================
  // 9. 18-INCH PIRELLI P-ZERO WHEELS, WAKE DEFLECTORS & CARBON WISHBONES
  // ============================================================================
  const wheelMeshes: THREE.Object3D[] = [];
  const brakeGlowMaterials: THREE.MeshStandardMaterial[] = [];

  const frontLeftSteerPivot = new THREE.Group();
  const frontRightSteerPivot = new THREE.Group();

  const frontTireGeom = buildRoundedF1TireGeometry(0.355, 0.225, 0.315);
  const rearTireGeom = buildRoundedF1TireGeometry(0.365, 0.228, 0.395);

  const wheelInnerYellowMat = new THREE.MeshStandardMaterial({
    color: 0xffe600,
    emissive: 0xffe600,
    emissiveIntensity: 0.3,
    roughness: 0.25,
  });

  const wheelBrowMat = new THREE.MeshStandardMaterial({
    map: createWheelBrowDecalTexture(),
    roughness: 0.24,
    metalness: 0.22,
    side: THREE.DoubleSide,
  });

  const buildWheelAssembly = (isFront: boolean, isLeft: boolean) => {
    const outerGroup = new THREE.Group();
    const spinGroup = new THREE.Group();
    outerGroup.add(spinGroup);

    const width = isFront ? 0.315 : 0.395;
    const radius = isFront ? 0.355 : 0.365;
    const sideSign = isLeft ? 1 : -1;

    // Rounded-shoulder Pirelli tire carcass
    const tireMesh = new THREE.Mesh(
      isFront ? frontTireGeom : rearTireGeom,
      tireRubberMat
    );
    tireMesh.castShadow = true;
    tireMesh.receiveShadow = true;
    spinGroup.add(tireMesh);

    // 18-inch BBS Aero Wheel Cover & Rim
    const rimDrum = new THREE.Mesh(
      new THREE.CylinderGeometry(0.228, 0.228, width * 0.9, 24),
      rimMat
    );
    rimDrum.rotation.z = Math.PI * 0.5;
    spinGroup.add(rimDrum);

    // Outer & Inner Coloured Pirelli Sidewall Rings + BBS Yellow Inner Aero Ring (Reference Image 3)
    for (const ringSide of [-1, 1]) {
      const stripeRing = new THREE.Mesh(
        new THREE.RingGeometry(radius * 0.72, radius * 0.80, 32),
        tireStripeMat
      );
      stripeRing.rotation.y = ringSide * Math.PI * 0.5;
      stripeRing.position.x = ringSide * (width * 0.502);
      spinGroup.add(stripeRing);

      const innerYellowRing = new THREE.Mesh(
        new THREE.RingGeometry(radius * 0.42, radius * 0.54, 28),
        wheelInnerYellowMat
      );
      innerYellowRing.rotation.y = ringSide * Math.PI * 0.5;
      innerYellowRing.position.x = ringSide * (width * 0.462);
      spinGroup.add(innerYellowRing);
    }

    // Aero Wheel Cover Rotational Fin Graphics (visibly spin with wheel!)
    for (const bladeAngle of [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
      const fin = new THREE.Mesh(
        new THREE.BoxGeometry(0.015, 0.15, 0.042),
        bladeAngle === 0 ? secondaryPaintMat : carbonMat
      );
      fin.position.set(
        sideSign * (width * 0.46),
        Math.cos(bladeAngle) * 0.12,
        Math.sin(bladeAngle) * 0.12
      );
      fin.rotation.x = bladeAngle;
      spinGroup.add(fin);
    }

    // Center-Lock Wheel Nut Cone (Red/Blue anodized)
    const wheelNut = new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.042, 0.05, 12),
      new THREE.MeshStandardMaterial({
        color: isLeft ? 0xe10600 : 0x0284c7,
        metalness: 0.85,
        roughness: 0.2,
      })
    );
    wheelNut.rotation.z = Math.PI * 0.5;
    wheelNut.position.x = sideSign * (width * 0.47);
    spinGroup.add(wheelNut);

    // Non-spinning Upright: Glowing Carbon-Ceramic Brake Disc + 2026 Over-Wheel Wake Deflector Winglet
    const brakeGlowMat = new THREE.MeshStandardMaterial({
      color: 0x331108,
      emissive: 0xff3b00,
      emissiveIntensity: 0,
      roughness: 0.35,
    });
    brakeGlowMaterials.push(brakeGlowMat);

    const brakeDisc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.185, 0.185, width * 0.55, 20),
      brakeGlowMat
    );
    brakeDisc.rotation.z = Math.PI * 0.5;
    brakeDisc.position.x = -sideSign * 0.03;
    outerGroup.add(brakeDisc);

    // Prominent 2026 Sculpted Carbon Over-Wheel Wake Deflector ("Wheel Brow" - Reference Images 1, 2, 3)
    if (isFront) {
      // Inboard carbon brake drum shroud & upright shield
      const drumShroud = new THREE.Mesh(
        new THREE.CylinderGeometry(0.245, 0.245, 0.055, 24),
        carbonMat
      );
      drumShroud.rotation.z = Math.PI * 0.5;
      drumShroud.position.x = -sideSign * (width * 0.46);
      outerGroup.add(drumShroud);

      // True 3D Lofted Curved Carbon Wake Deflector Arching Outside & Above the Front Tire (r = 0.375m..0.415m > 0.355m tire radius!)
      const browSteps = 18;
      const browPos: number[] = [];
      const browUvs: number[] = [];
      const browIdx: number[] = [];
      for (let k = 0; k <= browSteps; k++) {
        const t = k / browSteps;
        // Angle around tire circumference from front-inboard (theta = 0.22 rad) up over top of tire (theta = 2.08 rad)
        const theta = THREE.MathUtils.lerp(0.22, 2.08, t);
        const rInner = THREE.MathUtils.lerp(0.368, 0.398, Math.sin(t * Math.PI * 0.65));
        const rOuter = rInner + 0.016;
        const yIn = Math.sin(theta) * rInner;
        const zIn = Math.cos(theta) * rInner;
        const yOut = Math.sin(theta) * rOuter;
        const zOut = Math.cos(theta) * rOuter;

        // Sweep laterally from inboard upright (-sideSign * 0.175) out across the top of the tire (+sideSign * 0.025)
        const xInboard = -sideSign * THREE.MathUtils.lerp(0.182, 0.145, t);
        const xOutboard = -sideSign * THREE.MathUtils.lerp(0.095, -0.025, Math.pow(t, 0.85));

        // 4 vertices per station (0: Inboard Bottom, 1: Outboard Bottom, 2: Outboard Top, 3: Inboard Top)
        browPos.push(
          xInboard, yIn, zIn,
          xOutboard, yIn, zIn - 0.018,
          xOutboard, yOut, zOut - 0.018,
          xInboard, yOut, zOut
        );
        browUvs.push(0, t, 1, t, 1, t, 0, t);

        if (k < browSteps) {
          const b0 = k * 4;
          const b1 = (k + 1) * 4;
          for (let j = 0; j < 4; j++) {
            const jn = (j + 1) % 4;
            browIdx.push(b0 + j, b1 + j, b1 + jn, b0 + j, b1 + jn, b0 + jn);
          }
        }
      }
      const browGeom = new THREE.BufferGeometry();
      browGeom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(browPos, 3)
      );
      browGeom.setAttribute("uv", new THREE.Float32BufferAttribute(browUvs, 2));
      browGeom.setIndex(browIdx);
      browGeom.computeVertexNormals();

      const deflectorMesh = new THREE.Mesh(browGeom, wheelBrowMat);
      deflectorMesh.castShadow = true;
      outerGroup.add(deflectorMesh);
    }

    wheelMeshes.push(spinGroup);
    return outerGroup;
  };

  // Double-Wishbone Carbon Fiber Suspension Arms
  const addSuspensionWishbones = (
    xChassis: number,
    xWheel: number,
    zCenter: number,
    yUpper: number,
    yLower: number
  ) => {
    for (const yArm of [yUpper, yLower]) {
      for (const zSpread of [-0.16, 0.16]) {
        const start = new THREE.Vector3(
          xChassis,
          yArm - 0.015,
          zCenter + zSpread
        );
        const end = new THREE.Vector3(xWheel, yArm, zCenter);
        const dir = new THREE.Vector3().subVectors(end, start);
        const len = dir.length();
        const arm = new THREE.Mesh(
          new THREE.CylinderGeometry(0.013, 0.013, len, 8),
          carbonMat
        );
        arm.position.copy(start).addScaledVector(dir, 0.5);
        arm.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          dir.normalize()
        );
        chassisGroup.add(arm);
      }
    }
    // Pullrod / Pushrod Diagonal Carbon Strut
    const rodStart = new THREE.Vector3(xChassis, yUpper + 0.05, zCenter + 0.04);
    const rodEnd = new THREE.Vector3(xWheel, yLower + 0.02, zCenter);
    const rodDir = new THREE.Vector3().subVectors(rodEnd, rodStart);
    const rodMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.01, 0.01, rodDir.length(), 8),
      carbonMat
    );
    rodMesh.position.copy(rodStart).addScaledVector(rodDir, 0.5);
    rodMesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      rodDir.normalize()
    );
    chassisGroup.add(rodMesh);
  };

  // Front Left (+X = +0.77, Z = +1.42) — attached to unsprung `root` so tire stays planted on asphalt!
  frontLeftSteerPivot.position.set(0.77, 0.355, 1.42);
  frontLeftSteerPivot.add(buildWheelAssembly(true, true));
  root.add(frontLeftSteerPivot);
  addSuspensionWishbones(0.2, 0.68, 1.42, 0.43, 0.24);

  // Front Right (-X = -0.77, Z = +1.42) — attached to unsprung `root`
  frontRightSteerPivot.position.set(-0.77, 0.355, 1.42);
  frontRightSteerPivot.add(buildWheelAssembly(true, false));
  root.add(frontRightSteerPivot);
  addSuspensionWishbones(-0.2, -0.68, 1.42, 0.43, 0.24);

  // Rear Left (+X = +0.76, Z = -1.48) — attached to unsprung `root`
  const rearLeftWheel = buildWheelAssembly(false, true);
  rearLeftWheel.position.set(0.76, 0.365, -1.48);
  root.add(rearLeftWheel);
  addSuspensionWishbones(0.12, 0.64, -1.48, 0.38, 0.22);

  // Rear Right (-X = -0.76, Z = -1.48) — attached to unsprung `root`
  const rearRightWheel = buildWheelAssembly(false, false);
  rearRightWheel.position.set(-0.76, 0.365, -1.48);
  root.add(rearRightWheel);
  addSuspensionWishbones(-0.12, -0.64, -1.48, 0.38, 0.22);

  let currentLivery = initialLivery;
  const setLivery = (livery: LiveryConfig) => {
    currentLivery = livery;
    vf26?.setLivery(livery);
    primaryPaintMat.color.set(livery.primary);
    secondaryPaintMat.color.set(livery.secondary);
    accentPaintMat.color.set(livery.accent);
    noseDecal.redraw(livery.number);
    helmetCrownTex.redraw(livery);
    helmetSideTex.redraw(livery);
    haloSponsorTex.redraw(livery);
  };

  let currentCompound = initialCompound;
  const setTireCompound = (compound: TireCompound) => {
    currentCompound = compound;
    vf26?.setTireCompound(compound);
    const col = TIRE_STRIPE_COLORS[compound];
    tireStripeMat.color.setHex(col);
    tireStripeMat.emissive.setHex(col);
  };

  const updateFromTelemetry = (
    telemetry: CarTelemetry,
    pitchRad: number,
    rollRad: number,
    wheelRotationRad: number,
    _dtOrOffset = 0,
    tyres?: readonly TyreVisualState[]
  ) => {
    chassisGroup.rotation.x = pitchRad;
    chassisGroup.rotation.z = rollRad;
    if (vf26) {
      vf26.update(telemetry, wheelRotationRad, _dtOrOffset > 0 && _dtOrOffset < 0.25 ? _dtOrOffset : 1 / 60, tyres);
      return;
    }

    const steerVisualAngle = -telemetry.steering * 0.38;
    // Ackermann steering geometry: inside wheel turns ~10% sharper than outside wheel
    const leftAckermann = telemetry.steering < 0 ? 1.06 : 0.94;
    const rightAckermann = telemetry.steering > 0 ? 1.06 : 0.94;
    frontLeftSteerPivot.rotation.y = steerVisualAngle * leftAckermann;
    frontRightSteerPivot.rotation.y = steerVisualAngle * rightAckermann;
    // telemetry.steering + = right turn; +rotation.z about the forward axis turns the rim clockwise as seen
    // from the seat (top of the rim moves toward -X = right)
    steeringWheelGroup.rotation.z = telemetry.steering * 1.45;
    syncDriverForearms();

    liveOled.update(telemetry);

    for (const w of wheelMeshes) {
      w.rotation.x = wheelRotationRad;
    }

    // 2026 Active Aerodynamics (X-Mode flattens both front and rear wing flaps!)
    const targetRwAngle = telemetry.activeAeroMode === "X_MODE" ? 0.04 : 0.42;
    const targetFwAngle = telemetry.activeAeroMode === "X_MODE" ? 0.04 : 0.24;
    rearWingFlap.rotation.x = THREE.MathUtils.lerp(
      rearWingFlap.rotation.x,
      targetRwAngle,
      0.24
    );
    frontWingFlapLeft.rotation.x = THREE.MathUtils.lerp(
      frontWingFlapLeft.rotation.x,
      targetFwAngle,
      0.24
    );
    frontWingFlapRight.rotation.x = THREE.MathUtils.lerp(
      frontWingFlapRight.rotation.x,
      targetFwAngle,
      0.24
    );

    // Steering Wheel Shift Light LEDs
    const rpmFrac = THREE.MathUtils.clamp(
      (telemetry.rpm - 8800) / (12850 - 8800),
      0,
      1
    );
    const activeCount = Math.round(rpmFrac * shiftLeds.length);
    for (let i = 0; i < shiftLeds.length; i++) {
      const mat = shiftLeds[i].material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = i < activeCount ? 3.2 : 0.15;
    }

    // Glowing Carbon-Ceramic Brake Discs under heavy braking (>550°C)
    for (let i = 0; i < 4; i++) {
      const temp = telemetry.brakeTempsC[i] || 300;
      const glow = THREE.MathUtils.clamp((temp - 520) / 480, 0, 1);
      brakeGlowMaterials[i].emissiveIntensity = glow * 3.5;
    }

    // Rear FIA Rain / ERS Harvest Light + Endplate LEDs
    const isHarvesting = telemetry.mgukPowerKw < -20 || telemetry.brake > 0.2;
    if (isHarvesting || telemetry.manualOverrideActive) {
      const pulse = Math.sin(performance.now() * 0.028) > 0 ? 3.8 : 0.6;
      ersLightMaterial.color.setHex(
        telemetry.manualOverrideActive ? 0xb138ff : 0xe10600
      );
      ersLightMaterial.emissive.setHex(
        telemetry.manualOverrideActive ? 0xb138ff : 0xe10600
      );
      ersLightMaterial.emissiveIntensity = pulse;
    } else {
      ersLightMaterial.color.setHex(0xe10600);
      ersLightMaterial.emissive.setHex(0xe10600);
      ersLightMaterial.emissiveIntensity = 0.85;
    }
  };

  // Swap in the VF26 mod model when it has been converted locally (public/vf26/model/vf26.glb)
  const proceduralParts = [...chassisGroup.children, ...root.children.filter((c) => c !== chassisGroup)];
  let rigDisposed = false;
  void loadVf26Template().then((template) => {
    if (!template || rigDisposed) return;
    vf26 = attachVf26Model(template, root, chassisGroup);
    vf26.setTireCompound(currentCompound);
    vf26.setLivery(currentLivery);
    for (const part of proceduralParts) part.visible = false;
  });

  return {
    root,
    chassisGroup,
    helmetGroup,
    frontLeftSteerPivot,
    frontRightSteerPivot,
    wheelMeshes,
    frontWingFlapLeft,
    frontWingFlapRight,
    rearWingFlap,
    steeringWheelGroup,
    shiftLeds,
    ersLightMaterial,
    brakeGlowMaterials,
    setLivery,
    setTireCompound,
    getCameraAnchors: () => vf26?.cameraAnchors ?? null,
    getVf26Body: () => vf26?.bodyGroup ?? null,
    setCockpitView: (inCockpit: boolean) => vf26?.setHeadVisible(!inCockpit),
    updateFromTelemetry,
    dispose: () => {
      rigDisposed = true;
      vf26?.dispose();
      root.removeFromParent();
    },
  };
}
