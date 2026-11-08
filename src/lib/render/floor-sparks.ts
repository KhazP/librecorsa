import * as THREE from "three";
import type { CarTelemetry } from "@/types/f1";

const SPARK_COUNT = 48;
const SPARKS_PER_S = 120;
/** Where the plank scrapes: this far behind the car's centre (m) */
const EMIT_BEHIND_M = 1.9;

/** The car the sparks come from: its pose, forward speed and what it is touching */
export interface SparkingCar {
  worldPosition: THREE.Vector3;
  worldQuaternion: THREE.Quaternion;
  vxMs: number;
  telemetry: Pick<CarTelemetry, "speedKmh" | "verticalG" | "onKerbLeft" | "onKerbRight">;
}

/**
 * Titanium skid-block sparks from under a car's floor: thrown off while it bottoms out at speed (over 280 km/h
 * under more than 1.15 g of vertical load) or rides a kerb.
 */
export class FloorSparks {
  readonly points: THREE.Points;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly positions = new Float32Array(SPARK_COUNT * 3);
  private readonly velocities = Array.from({ length: SPARK_COUNT }, () => new THREE.Vector3());
  private readonly lives = new Float32Array(SPARK_COUNT);
  private next = 0;
  /** Sparks owed to the emitter, so the rate is per second rather than per rendered frame */
  private owed = 0;
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();

  constructor() {
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.points = new THREE.Points(
      this.geometry,
      new THREE.PointsMaterial({ color: 0xfbbf24, size: 0.22, transparent: true, opacity: 0.9 })
    );
  }

  /** Emits from `car` when it is scraping (null: nothing emits) and moves the sparks already in the air */
  update(dt: number, car: SparkingCar | null): void {
    const t = car?.telemetry;
    const scraping = !!t && ((t.speedKmh > 280 && (t.verticalG ?? 1.0) > 1.15) || t.onKerbLeft || t.onKerbRight);
    if (car && scraping) {
      const forward = this.fwd.set(0, 0, 1).applyQuaternion(car.worldQuaternion);
      const right = this.right.set(-1, 0, 0).applyQuaternion(car.worldQuaternion);
      this.owed = Math.min(SPARK_COUNT, this.owed + dt * SPARKS_PER_S);
      for (; this.owed >= 1; this.owed--) {
        const idx = this.next % SPARK_COUNT;
        this.next++;
        const side = (Math.random() - 0.5) * 0.7;
        const p = car.worldPosition;
        this.positions[idx * 3] = p.x - forward.x * EMIT_BEHIND_M + right.x * side;
        this.positions[idx * 3 + 1] = p.y - forward.y * EMIT_BEHIND_M + right.y * side + 0.08;
        this.positions[idx * 3 + 2] = p.z - forward.z * EMIT_BEHIND_M + right.z * side;
        const v = this.velocities[idx].copy(forward).multiplyScalar(-car.vxMs * 0.35);
        v.x += (Math.random() - 0.5) * 6;
        v.y += 1.8 + Math.random() * 3.5;
        v.z += (Math.random() - 0.5) * 6;
        this.lives[idx] = 0.25 + Math.random() * 0.2;
      }
    } else {
      this.owed = 0;
    }

    for (let i = 0; i < SPARK_COUNT; i++) {
      if (this.lives[i] > 0) {
        this.lives[i] -= dt;
        this.positions[i * 3] += this.velocities[i].x * dt;
        this.positions[i * 3 + 1] += this.velocities[i].y * dt;
        this.positions[i * 3 + 2] += this.velocities[i].z * dt;
        this.velocities[i].y -= 9.81 * dt;
      } else {
        this.positions[i * 3 + 1] = -999;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
