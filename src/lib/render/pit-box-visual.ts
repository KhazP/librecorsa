/**
 * The player's pit box on the ground (after PR #183 by adamikoo): a painted bay with its stop line and a lollipop at the
 * front, in the box's own spot of the lane (pit-lane.ts). It shows only in a race with the pit lane in use, once the
 * player has called the stop or is in the lane: a pit box painted on every lap of a hot-lap session would be noise.
 *
 * Its colour says what to do: amber on the way in, green to stop, red while the crew works, green again to go.
 */
import * as THREE from "three";
import type { PitBox } from "@/lib/sim/pit/pit-lane";
import type { PitTelemetry } from "@/types/f1";

export interface PitBoxVisual {
  readonly group: THREE.Group;
  /** `shown`: a race with the pit lane in use */
  update(pit: PitTelemetry | undefined, shown: boolean, timeS: number): void;
  /** Sit it on the ground (the circuit's colliders, once loaded) */
  seatOnGround(heightAt: (x: number, z: number) => number | null): void;
  dispose(): void;
}

const BAY_LENGTH_M = 6;
const BAY_WIDTH_M = 3;
const AMBER = 0xf5a524;
const GREEN = 0x22c55e;
const RED = 0xef4444;

export function createPitBoxVisual(box: PitBox): PitBoxVisual {
  const group = new THREE.Group();
  group.name = "player-pit-box";
  group.position.set(box.x, box.y + 0.03, box.z);
  group.rotation.y = box.yawRad;
  group.visible = false;
  const disposables: { dispose(): void }[] = [];
  const halfW = BAY_WIDTH_M / 2;
  const halfL = BAY_LENGTH_M / 2;

  // The bay: a painted outline (four thin strips) and a faint fill
  const paint = new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.85, depthWrite: false });
  const fill = new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.08, depthWrite: false });
  disposables.push(paint, fill);
  const strip = (w: number, l: number, x: number, z: number) => {
    const g = new THREE.PlaneGeometry(w, l);
    g.rotateX(-Math.PI / 2);
    disposables.push(g);
    const m = new THREE.Mesh(g, paint);
    m.position.set(x, 0.02, z);
    m.renderOrder = 2;
    group.add(m);
  };
  strip(0.12, BAY_LENGTH_M, -halfW, 0);
  strip(0.12, BAY_LENGTH_M, halfW, 0);
  strip(BAY_WIDTH_M, 0.12, 0, -halfL);
  // The stop line where the front wheels go
  strip(BAY_WIDTH_M * 0.8, 0.3, 0, halfL - 0.8);
  const fillGeo = new THREE.PlaneGeometry(BAY_WIDTH_M, BAY_LENGTH_M);
  fillGeo.rotateX(-Math.PI / 2);
  disposables.push(fillGeo);
  const fillMesh = new THREE.Mesh(fillGeo, fill);
  fillMesh.position.y = 0.01;
  fillMesh.renderOrder = 1;
  group.add(fillMesh);

  // The lollipop, held out in front of the bay
  const pole = new THREE.MeshStandardMaterial({ color: 0x1b1f29, roughness: 0.5, metalness: 0.5 });
  const sign = new THREE.MeshStandardMaterial({ color: AMBER, emissive: AMBER, emissiveIntensity: 0.9, roughness: 0.4 });
  const poleGeo = new THREE.CylinderGeometry(0.03, 0.03, 1.6, 8);
  const signGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.04, 20);
  signGeo.rotateX(Math.PI / 2);
  disposables.push(pole, sign, poleGeo, signGeo);
  const lollipop = new THREE.Group();
  lollipop.position.set(0, 0, halfL + 0.6);
  const poleMesh = new THREE.Mesh(poleGeo, pole);
  poleMesh.position.y = 0.8;
  const signMesh = new THREE.Mesh(signGeo, sign);
  signMesh.position.y = 1.6;
  lollipop.add(poleMesh, signMesh);
  group.add(lollipop);

  const setColour = (hex: number, glow: number) => {
    paint.color.setHex(hex);
    fill.color.setHex(hex);
    sign.color.setHex(hex);
    sign.emissive.setHex(hex);
    sign.emissiveIntensity = glow;
  };

  return {
    group,
    update(pit, shown, timeS) {
      const visible = Boolean(shown && pit && (pit.strategy.boxRequested || pit.phase !== "track"));
      group.visible = visible;
      if (!visible || !pit) return;
      const pulse = 0.5 + 0.5 * Math.sin(timeS * 6);
      if (pit.phase === "servicing") setColour(RED, 1.2);
      else if (pit.phase === "box" || pit.phase === "released") setColour(GREEN, 1.2 + pulse * 0.6);
      else setColour(AMBER, 0.8 + pulse * 0.4);
      fill.opacity = pit.phase === "box" ? 0.16 + pulse * 0.08 : 0.08;
    },
    seatOnGround(heightAt) {
      const y = heightAt(box.x, box.z);
      if (y !== null && Number.isFinite(y)) group.position.y = y + 0.03;
    },
    dispose() {
      group.removeFromParent();
      for (const d of disposables) d.dispose();
    },
  };
}
