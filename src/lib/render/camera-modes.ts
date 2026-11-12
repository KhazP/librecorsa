import type { CameraMode } from "@/types/f1";

/** The car model's onboard camera anchors (`SimCarRig.getCameraAnchors()`) */
export type OnboardAnchor = "cockpit" | "shoulder" | "tcam" | "bumper";

/**
 * Where a view sits: one of the model's anchors, or "overWheel", placed per car from the driver's eye
 * (`onboard-views.ts`; the models' own "dash" anchors are forward-facing dashboard cameras that leave the dash out)
 */
export type ViewAnchor = OnboardAnchor | "overWheel";

/**
 * What each view does. Every view-dependent choice in the game reads a flag here rather than testing the mode, so a
 * new view is one row. The flags are separate because the views really do differ: the nose camera hears the cabin
 * but has no steering wheel in shot, and the shoulder view moves with the driver's neck but sees no visor.
 */
export interface CameraModeSpec {
  /** In the pause menu, the HUD and the touch controls */
  label: string;
  /** Under the label where the setup screen offers this as a starting view */
  blurb?: string;
  /** The car model's anchor this view sits on (placed by the camera code when the rig has none); null outside the car */
  anchor: ViewAnchor | null;
  /** From inside the helmet: the driver's head is left out of the frame, rain lands on the visor, wing mirrors render */
  driverEye: boolean;
  /** At the driver's head: the neck moves it, unless head movement is "static" */
  driverHead: boolean;
  /** The steering wheel is in shot, so its display redraws */
  wheelInShot: boolean;
  /** The player's field-of-view setting shifts it (onboard views only) */
  playerFov: boolean;
  /** Plays the mod's interior engine event; outside views hear the exterior one */
  interiorAudio: boolean;
  /**
   * When the virtual mirror strip shows: "always" where no wing mirror is on screen, "noSideMirrors" in a cockpit
   * whose wing mirrors don't cover the sides, "onRequest" only when the player set it to always, "never" in the
   * views far from the car
   */
  virtualMirror: "always" | "noSideMirrors" | "onRequest" | "never";
}

export const CAMERA_MODES: Readonly<Record<CameraMode, CameraModeSpec>> = {
  chase: {
    label: "Chase",
    blurb: "Behind the car",
    anchor: null,
    driverEye: false,
    driverHead: false,
    wheelInShot: false,
    playerFov: false,
    interiorAudio: false,
    virtualMirror: "onRequest",
  },
  tv_pod: {
    label: "T-cam",
    blurb: "Over the helmet",
    anchor: "tcam",
    driverEye: false,
    driverHead: false,
    wheelInShot: true,
    playerFov: true,
    interiorAudio: true,
    virtualMirror: "always",
  },
  cockpit_shoulder: {
    label: "Shoulder",
    anchor: "shoulder",
    driverEye: false,
    driverHead: true,
    wheelInShot: true,
    playerFov: true,
    interiorAudio: true,
    virtualMirror: "always",
  },
  cockpit: {
    label: "Cockpit",
    blurb: "Driver's eye",
    anchor: "cockpit",
    driverEye: true,
    driverHead: true,
    wheelInShot: true,
    playerFov: true,
    interiorAudio: true,
    virtualMirror: "noSideMirrors",
  },
  dash: {
    label: "Dash",
    blurb: "Over the wheel, the dash in shot",
    anchor: "overWheel",
    driverEye: false,
    driverHead: false,
    wheelInShot: true,
    playerFov: true,
    interiorAudio: true,
    virtualMirror: "always",
  },
  nose: {
    label: "Nose",
    anchor: "bumper",
    driverEye: false,
    driverHead: false,
    wheelInShot: false,
    playerFov: false,
    interiorAudio: true,
    virtualMirror: "always",
  },
  helicopter: {
    label: "Helicopter",
    anchor: null,
    driverEye: false,
    driverHead: false,
    wheelInShot: false,
    playerFov: false,
    interiorAudio: false,
    virtualMirror: "never",
  },
  tv_side: {
    label: "Trackside TV",
    anchor: null,
    driverEye: false,
    driverHead: false,
    wheelInShot: false,
    playerFov: false,
    interiorAudio: false,
    virtualMirror: "never",
  },
};

export const ALL_CAMERA_MODES = Object.keys(CAMERA_MODES) as CameraMode[];

export const isCameraMode = (value: unknown): value is CameraMode =>
  typeof value === "string" && Object.hasOwn(CAMERA_MODES, value);

/** Views the camera key (and the pause menu's camera button) cycles through */
export const CAMERA_CYCLE: readonly CameraMode[] = ["cockpit", "dash", "tv_pod", "chase", "tv_side"];

/** Views the setup screen offers to start in */
export const STARTING_CAMERAS: readonly CameraMode[] = ["cockpit", "tv_pod", "chase"];

/** The view after `mode` in the cycle (views outside the cycle return to its start) */
export function nextCameraMode(mode: CameraMode): CameraMode {
  return CAMERA_CYCLE[(CAMERA_CYCLE.indexOf(mode) + 1) % CAMERA_CYCLE.length];
}

/** Driver's-eye FOV of a car with no model camera anchors (the procedural car); the FOV setting shifts every onboard view from it */
export const FALLBACK_COCKPIT_FOV_DEG = 62;
