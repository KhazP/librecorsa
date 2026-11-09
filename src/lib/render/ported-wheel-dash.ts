import * as THREE from "three";
import type { CarTelemetry } from "@/types/f1";
import { SteeringWheelDisplay } from "./steering-display";

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
 * The live steering wheel of a ported car: its screen (the `INT_DISPLAY` mesh under `STEER`, drawn by
 * `SteeringWheelDisplay` with the car's own LED range) and its shift lights (the `STEER` children the CAR node's
 * `revLeds` extras list, which the rig puts on `STEER`: each lit in its colour from its rpm, all blinking past
 * `blinkRpm`). The rig shares the GLB template's materials between cars, so each LED gets its own material copy;
 * `dispose` puts the template's back.
 */
export class PortedWheelDash {
  readonly found: boolean;
  private readonly screen: SteeringWheelDisplay | null = null;
  private readonly leds: { led: RevLed; meshes: THREE.Mesh[]; originals: THREE.Material[]; mat: THREE.MeshStandardMaterial }[] = [];
  private readonly blinkRpm: number = Infinity;
  private readonly blinkHz: number = 5;

  /**
   * The dash of the ported body under `root`, once its GLB has loaded (null until then); `found` is false for a car
   * whose wheel has neither a screen nor shift lights
   */
  static from(root: THREE.Object3D, revRange: readonly [number, number]): PortedWheelDash | null {
    // The rig moves the model's STEER node onto the body, with the CAR node's revLeds extras on it
    const steer = root.getObjectByName("STEER");
    if (!steer) return null;
    return new PortedWheelDash(steer, (steer.userData?.revLeds as RevLedTable | undefined) ?? null, revRange);
  }

  private constructor(steer: THREE.Object3D, table: RevLedTable | null, revRange: readonly [number, number]) {
    const screen = new SteeringWheelDisplay(steer, revRange);
    this.screen = screen.found ? screen : null;
    if (table) {
      this.blinkRpm = table.blinkRpm ?? Infinity;
      this.blinkHz = table.blinkHz ?? 5;
      for (const led of table.leds) {
        const node = steer.getObjectByName(led.node);
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
    this.found = this.screen !== null || this.leds.length > 0;
  }

  update(t: CarTelemetry, nowMs: number, extra?: { deltaMs?: number | null }): void {
    this.screen?.update(t, nowMs, extra);
    const rpm = Number.isFinite(t.rpm) ? t.rpm : 0;
    const blinkOff = rpm >= this.blinkRpm && Math.floor((nowMs / 1000) * this.blinkHz * 2) % 2 === 1;
    for (const { led, mat } of this.leds) mat.emissiveIntensity = rpm >= led.rpm && !blinkOff ? LED_INTENSITY : 0;
  }

  dispose(): void {
    this.screen?.dispose();
    for (const { meshes, originals, mat } of this.leds) {
      meshes.forEach((m, i) => (m.material = originals[i]));
      mat.dispose();
    }
    this.leds.length = 0;
  }
}
