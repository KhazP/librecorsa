import * as THREE from "three";
import type { PitBoxPose } from "@/lib/sim/pit-stop";
import type { PitTelemetry } from "@/types/f1";

export interface PitBoxVisual {
  readonly group: THREE.Group;
  update(pit: PitTelemetry | undefined, timeS: number): void;
  seatOnGround(sampleHeight: (x: number, z: number) => number | null): void;
  dispose(): void;
}

const BOX_LENGTH_M = 6.2;
const BOX_WIDTH_M = 3.2;

/**
 * 3D pit box bay marker, wheel-stop lines, approach chevron, and team lollipop gantry
 * anchored at the player's assigned pit slot along the pit lane.
 */
export function createPitBoxVisual(pose: PitBoxPose, accentHex = "#ff7a00"): PitBoxVisual {
  const group = new THREE.Group();
  group.name = "player-pit-box";
  group.position.set(pose.x, pose.y + 0.03, pose.z);
  group.rotation.y = pose.yawRad;

  const disposables: { dispose(): void }[] = [];
  const halfW = BOX_WIDTH_M * 0.5;
  const halfL = BOX_LENGTH_M * 0.5;

  const accentColor = new THREE.Color(accentHex);

  // Outer perimeter box lines
  const borderMat = new THREE.LineBasicMaterial({
    color: accentColor,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });
  disposables.push(borderMat);

  const borderPts = [
    new THREE.Vector3(-halfW, 0.02, -halfL),
    new THREE.Vector3(halfW, 0.02, -halfL),
    new THREE.Vector3(halfW, 0.02, halfL),
    new THREE.Vector3(-halfW, 0.02, halfL),
    new THREE.Vector3(-halfW, 0.02, -halfL),
  ];
  const borderGeo = new THREE.BufferGeometry().setFromPoints(borderPts);
  disposables.push(borderGeo);
  const borderLine = new THREE.Line(borderGeo, borderMat);
  borderLine.renderOrder = 2;
  group.add(borderLine);

  // Subtle translucent tarmac tint pad inside bay
  const padGeo = new THREE.PlaneGeometry(BOX_WIDTH_M - 0.16, BOX_LENGTH_M - 0.16);
  padGeo.rotateX(-Math.PI / 2);
  const padMat = new THREE.MeshBasicMaterial({
    color: accentColor,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  disposables.push(padGeo, padMat);
  const padMesh = new THREE.Mesh(padGeo, padMat);
  padMesh.position.y = 0.01;
  padMesh.renderOrder = 1;
  group.add(padMesh);

  // Front & rear painted stop-bars (bright white/cyan wheel targets)
  const stopBarGeo = new THREE.PlaneGeometry(BOX_WIDTH_M * 0.84, 0.22);
  stopBarGeo.rotateX(-Math.PI / 2);
  const stopBarMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  disposables.push(stopBarGeo, stopBarMat);

  const frontStop = new THREE.Mesh(stopBarGeo, stopBarMat);
  frontStop.position.set(0, 0.025, halfL - 0.75);
  frontStop.renderOrder = 2;
  group.add(frontStop);

  // Entry lead-in chevron behind the bay (-Z)
  const chevPts = [
    new THREE.Vector3(-halfW * 0.65, 0.02, -halfL - 2.4),
    new THREE.Vector3(0, 0.02, -halfL - 0.6),
    new THREE.Vector3(halfW * 0.65, 0.02, -halfL - 2.4),
  ];
  const chevGeo = new THREE.BufferGeometry().setFromPoints(chevPts);
  disposables.push(chevGeo);
  const chevLine = new THREE.Line(chevGeo, borderMat);
  chevLine.renderOrder = 2;
  group.add(chevLine);

  // Driver-side / pit-wall illuminated lollipop gantry post ahead-right of the bay
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x1b1f29,
    roughness: 0.45,
    metalness: 0.65,
  });
  const beaconMat = new THREE.MeshStandardMaterial({
    color: accentColor,
    emissive: accentColor,
    emissiveIntensity: 1.5,
    roughness: 0.25,
    metalness: 0.1,
  });
  const postGeo = new THREE.CylinderGeometry(0.055, 0.065, 2.35, 10);
  const armGeo = new THREE.BoxGeometry(0.85, 0.05, 0.05);
  const boardGeo = new THREE.BoxGeometry(0.76, 0.42, 0.08);
  disposables.push(postMat, beaconMat, postGeo, armGeo, boardGeo);

  const gantry = new THREE.Group();
  gantry.position.set(halfW + 0.55, 0, halfL - 0.4);
  const post = new THREE.Mesh(postGeo, postMat);
  post.position.y = 1.175;
  const arm = new THREE.Mesh(armGeo, postMat);
  arm.position.set(-0.42, 2.28, 0);
  const board = new THREE.Mesh(boardGeo, beaconMat);
  board.position.set(-0.78, 2.1, 0);
  gantry.add(post, arm, board);
  group.add(gantry);

  // Corner vertical marker pylons for instant readability from cockpit & chase cams
  const pylonGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.72, 8);
  disposables.push(pylonGeo);
  const corners: [number, number][] = [
    [-halfW, halfL],
    [halfW, halfL],
  ];
  for (const [cx, cz] of corners) {
    const pylon = new THREE.Mesh(pylonGeo, beaconMat);
    pylon.position.set(cx, 0.36, cz);
    group.add(pylon);
  }

  return {
    group,
    update(pit: PitTelemetry | undefined, timeS: number) {
      if (!pit) {
        borderMat.color.copy(accentColor);
        padMat.color.copy(accentColor);
        padMat.opacity = 0.1;
        beaconMat.color.copy(accentColor);
        beaconMat.emissive.copy(accentColor);
        beaconMat.emissiveIntensity = 1.1;
        return;
      }

      const pulse = 0.5 + 0.5 * Math.sin(timeS * 8);
      if (pit.phase === "servicing") {
        // Red / HOLD during active tyre & repair work
        borderMat.color.setHex(0xff3b30);
        padMat.color.setHex(0xff3b30);
        padMat.opacity = 0.18 + pulse * 0.1;
        beaconMat.color.setHex(0xff3b30);
        beaconMat.emissive.setHex(0xff3b30);
        beaconMat.emissiveIntensity = 2.0 + pulse * 0.8;
      } else if (pit.alignedInBox || pit.phase === "in_box") {
        // Bright cyan/green STOP NOW inside bay
        borderMat.color.setHex(0x10b981);
        padMat.color.setHex(0x10b981);
        padMat.opacity = 0.24 + pulse * 0.12;
        beaconMat.color.setHex(0x10b981);
        beaconMat.emissive.setHex(0x10b981);
        beaconMat.emissiveIntensity = 2.2 + pulse * 0.9;
      } else if (pit.phase === "released") {
        // Green GO!
        borderMat.color.setHex(0x22c55e);
        padMat.color.setHex(0x22c55e);
        padMat.opacity = 0.22;
        beaconMat.color.setHex(0x22c55e);
        beaconMat.emissive.setHex(0x22c55e);
        beaconMat.emissiveIntensity = 2.4;
      } else if (pit.strategy.boxRequested || pit.phase === "lane" || pit.phase === "entry_warning") {
        // Active bright pit beacon when boxing or driving down pit lane
        borderMat.color.setHex(0xf59e0b);
        padMat.color.setHex(0xf59e0b);
        padMat.opacity = 0.16 + pulse * 0.08;
        beaconMat.color.setHex(0xf59e0b);
        beaconMat.emissive.setHex(0xf59e0b);
        beaconMat.emissiveIntensity = 1.6 + pulse * 0.6;
      } else {
        borderMat.color.copy(accentColor);
        padMat.color.copy(accentColor);
        padMat.opacity = 0.11;
        beaconMat.color.copy(accentColor);
        beaconMat.emissive.copy(accentColor);
        beaconMat.emissiveIntensity = 1.1;
      }
    },
    seatOnGround(sampleHeight) {
      const y = sampleHeight(pose.x, pose.z);
      if (y !== null && Number.isFinite(y)) {
        group.position.y = y + 0.02;
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
