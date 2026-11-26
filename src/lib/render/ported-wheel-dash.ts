import * as THREE from "three";
import type { CarTelemetry } from "@/types/f1";
import { SteeringWheelDisplay, type WheelScreenSpec } from "./steering-display";
import { AcDigitalItems, type AcDigitalItem } from "./ac-digital-items";
import {
  createLmdhWheelScreen,
  LMDH_WHEEL_HIDE_MATERIALS,
  LMDH_WHEEL_SCREEN_MATERIAL,
  type LiveWheelScreen,
} from "./gt3-dash-display";

/** One shift light: its node under `STEER`, the rpm it comes on at and its colour (0..1 RGB) */
interface RevLed {
  node: string;
  rpm: number;
  color: [number, number, number];
}

/** The CAR node's `revLeds` extras (scripts/cars/port_ac_car.py, from the mod's digital_instruments.ini) */
interface RevLedTable {
  leds: RevLed[];
  /** Past this rpm every lit LED blinks at `blinkHz` */
  blinkRpm?: number;
  blinkHz?: number;
}

/** How bright a lit LED glows over its bulb texture */
const LED_INTENSITY = 2.4;

/**
 * Wheels whose screen is not an `INT_DISPLAY` mesh, by car: where the screen is, whether it uses a custom prototype
 * page, and the materials of the still pictures printed over it that the live page replaces (hidden)
 */
interface PortedWheelScreenConfig extends WheelScreenSpec {
  hide?: readonly string[];
  kind?: "lmdh";
}

const WHEEL_SCREENS: Readonly<Record<string, PortedWheelScreenConfig>> = {
  // The LC-LMDH body's wheel: a 102 x 66 mm screen (1.54 : 1) running the Bosch/Cosworth prototype dash page,
  // with a still green / amber / red bar down the right edge that the live page replaces
  "lc-lmdh": {
    material: LMDH_WHEEL_SCREEN_MATERIAL,
    kind: "lmdh",
    hide: LMDH_WHEEL_HIDE_MATERIALS,
  },
};

/**
 * The live steering wheel of a ported car: its screen (the `INT_DISPLAY` mesh under `STEER`, drawn by
 * `SteeringWheelDisplay` with the car's own LED range, or a dedicated prototype page for `lc-lmdh`) and its shift
 * lights (the `STEER` children the CAR node's `revLeds` extras list, which the rig puts on `STEER`: each lit in its
 * colour from its rpm, all blinking past `blinkRpm`), and the texts an Assetto Corsa car's digital_instruments.ini
 * writes in its LCD windows (the `digitalItems` extras, `AcDigitalItems`). The rig shares the GLB template's materials
 * between cars, so each LED gets its own material copy; `dispose` puts the template's back.
 */
export class PortedWheelDash {
  readonly found: boolean;
  private readonly screen: LiveWheelScreen | null = null;
  private readonly hiddenOverlays: { mesh: THREE.Object3D; visible: boolean }[] = [];
  private readonly leds: { led: RevLed; meshes: THREE.Mesh[]; originals: THREE.Material[]; mat: THREE.MeshStandardMaterial }[] = [];
  private readonly blinkRpm: number = Infinity;
  private readonly blinkHz: number = 5;
  /** The texts the mod's digital_instruments.ini writes in the wheel's LCD windows (the CAR node's `digitalItems`) */
  private readonly items: AcDigitalItems | null = null;

  /**
   * The dash of the ported body under `root`, once its GLB has loaded (null until then); `found` is false for a car
   * whose wheel has neither a screen nor shift lights
   */
  static from(root: THREE.Object3D, revRange: readonly [number, number], carId?: string): PortedWheelDash | null {
    // The rig moves the model's STEER node onto the body, with the CAR node's revLeds extras on it
    const steer = root.getObjectByName("STEER");
    if (!steer) return null;
    const table = (steer.userData?.revLeds as RevLedTable | undefined) ?? null;
    return new PortedWheelDash(steer, table, revRange, carId === undefined ? undefined : WHEEL_SCREENS[carId]);
  }

  private constructor(
    steer: THREE.Object3D,
    table: RevLedTable | null,
    revRange: readonly [number, number],
    spec?: PortedWheelScreenConfig
  ) {
    if (spec?.kind === "lmdh") {
      this.screen = createLmdhWheelScreen(steer, revRange);
    } else {
      const screen = new SteeringWheelDisplay(steer, revRange, spec);
      this.screen = screen.found ? screen : null;
    }
    if (spec?.hide?.length) {
      const hide = new Set(spec.hide);
      steer.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || Array.isArray(m.material) || !hide.has(m.material.name)) return;
        this.hiddenOverlays.push({ mesh: m, visible: m.visible });
        m.visible = false;
      });
    }
    if (this.screen) {
      // Hide leftover AC LCD overlay quads (e.g. MTRacing 496R's STEER_wheel_lcd) that sit in front of INT_DISPLAY
      steer.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || Array.isArray(m.material)) return;
        if (m.material.name === "wheel_lcd") {
          this.hiddenOverlays.push({ mesh: m, visible: m.visible });
          m.visible = false;
        }
      });
    }
    if (table) {
      this.blinkRpm = table.blinkRpm ?? Infinity;
      this.blinkHz = table.blinkHz ?? 5;
      for (const led of table.leds) {
        // On the wheel, or on the body beside it (a dash's lights)
        const node = steer.getObjectByName(led.node) ?? steer.parent?.getObjectByName(led.node);
        if (!node) continue;
        const meshes: THREE.Mesh[] = [];
        node.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && !Array.isArray(m.material)) meshes.push(m);
        });
        const base = meshes[0]?.material as THREE.MeshStandardMaterial | undefined;
        if (!base?.isMeshStandardMaterial) continue;
        const mat = base.clone();
        mat.emissive.setRGB(led.color[0], led.color[1], led.color[2]);
        mat.emissiveIntensity = 0;
        mat.emissiveMap = null;
        const originals = meshes.map((m) => m.material as THREE.Material);
        for (const m of meshes) m.material = mat;
        this.leds.push({ led, meshes, originals, mat });
      }
    }
    const items = steer.userData?.digitalItems as AcDigitalItem[] | undefined;
    if (items?.length) {
      const live = new AcDigitalItems(steer, items);
      this.items = live.found ? live : null;
    }
    this.found = this.screen !== null || this.leds.length > 0 || this.items !== null;
  }

  update(t: CarTelemetry, nowMs: number, extra?: { deltaMs?: number | null }): void {
    this.screen?.update(t, nowMs, extra);
    this.items?.update(t, nowMs, extra);
    const rpm = Number.isFinite(t.rpm) ? t.rpm : 0;
    const blinkOff = rpm >= this.blinkRpm && Math.floor((nowMs / 1000) * this.blinkHz * 2) % 2 === 1;
    for (const { led, mat } of this.leds) mat.emissiveIntensity = rpm >= led.rpm && !blinkOff ? LED_INTENSITY : 0;
  }

  dispose(): void {
    this.screen?.dispose();
    this.items?.dispose();
    for (const h of this.hiddenOverlays) h.mesh.visible = h.visible;
    this.hiddenOverlays.length = 0;
    for (const { meshes, originals, mat } of this.leds) {
      meshes.forEach((m, i) => (m.material = originals[i]));
      mat.dispose();
    }
    this.leds.length = 0;
  }
}
