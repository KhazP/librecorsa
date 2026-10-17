"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { getRwandaTrackData, LIVERIES } from "@/lib/track-data";
import { F1Physics2026, type ControlInputs } from "@/lib/f1-physics-2026";
import { F12026CarSim } from "@/lib/sim/f12026-car/F12026CarSim";
import type { SimulatorCar } from "@/lib/sim/simulator-car";
import { F1AudioEngine2026 } from "@/lib/f1-audio-2026";
import { createF1Car2026, type SimCarRig } from "@/lib/car-builder-2026";
import { createGt3CarRig } from "@/lib/gt3-car-model";
import { AMG_GT3_SOUND, createAmgGt3Sim } from "@/lib/sim/gt3/AmgGt3Sim";
import { VF26_SOUND, type CarSoundSource } from "@/lib/sim/CarAudio";
import { buildRwandaCircuitScene } from "@/lib/scene-builder";
import {
  configureRenderer,
  createGoldenHourEnvironment,
  createPostFx,
} from "@/lib/render/golden-hour-environment";
import { SteeringWheelDisplay } from "@/lib/render/steering-display";
import { WingMirrors } from "@/lib/render/wing-mirrors";
import { CockpitMicroShake, TracksideBroadcastDirector } from "@/lib/render/camera-rig";
import { LapDeltaTracker } from "@/components/hud/useLapDelta";
import { SimVisualFxManager } from "@/lib/sim/visual-fx";
import { AiOpponentField } from "@/lib/sim/ai-opponents";
import { GamepadHaptics } from "@/lib/sim/gamepad-haptics";
import {
  MultiplayerSyncManager,
  type P2PConnectionStatus,
} from "@/lib/sim/multiplayer-sync";
import { F1TelemetryHud, roomFromUrl } from "@/components/F1TelemetryHud";
import { nextCameraMode, TYRE_SETUP_LIMITS } from "@/components/hud/PauseMenu";
import { LoadingScreen } from "@/components/menu/LoadingScreen";
import { TitleMenu } from "@/components/menu/TitleMenu";
import { FirstRunWizard, type WizardMode, type WizardStepId } from "@/components/menu/FirstRunWizard";
import { assetProgress } from "@/lib/loading/asset-progress";
import { buildKeyLookup, keyLabel, padButtonLabel, type KeyAction } from "@/lib/input/bindings";
import { connectedPads, DeviceInputReader, PAD_SENSITIVITY } from "@/lib/input/device-input";
import { wheelFfb } from "@/lib/input/wheel-ffb";
import { DEFAULT_GAMEPAD_ASSIST, type GamepadAssistSettings } from "@/lib/sim/gamepad-assist";
import {
  clampFov,
  DEFAULT_PLAYER_SETTINGS,
  loadOnboarded,
  loadPlayerSettings,
  saveOnboarded,
  savePlayerSettings,
  type PlayerSettings,
} from "@/lib/settings/player-settings";
import type {
  AeroSetupPreset,
  AssistPreset,
  CameraMode,
  CarTelemetry,
  LiveryConfig,
  TireCompound,
  TyreSetup,
  VehicleModelId,
} from "@/types/f1";

/** Matches the aero package the track's target speeds / braking markers are computed for */
const DEFAULT_AERO_PRESET: AeroSetupPreset = "balanced";
const DEFAULT_ASSIST_PRESET: AssistPreset = "semi_pro";

// Keyboard-only input shaping: a key press becomes a pedal squeeze, not a step
const KB_THROTTLE_RISE_S = 0.25;
const KB_THROTTLE_FALL_S = 0.1;
const KB_BRAKE_RISE_S = 0.17;
const KB_BRAKE_FALL_S = 0.08;
/** Time for keyboard steering to reach its speed-dependent limit, and to recentre */
// Rotates a camera (which looks down -Z) to look along the car's +Z forward axis
const CAM_FORWARD_FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const CAM_X_AXIS = new THREE.Vector3(1, 0, 0);
/** Driver's-eye FOV of the procedural car (no model camera anchors); the FOV setting shifts every onboard camera from it */
const FALLBACK_COCKPIT_FOV_DEG = 62;
/** Most the chase camera's boom may trail the car's nose (rad): a spin swings the camera round instead of leaving it side-on */
const CHASE_MAX_LAG_RAD = 0.35;
const KB_STEER_RISE_S = 0.22;
const KB_STEER_RETURN_S = 0.14;
/** Keyboard steering limit: road-wheel angle for this lateral acceleration (m/s²) plus a peak slip allowance (rad) */
const KB_STEER_LIMIT_ACCEL = 38;
const KB_STEER_LIMIT_SLIP_RAD = 0.12;

/**
 * Session flow: assets loading → "press any key" → title menu → (first-run / controls setup) → driving.
 * Physics only runs while driving; the menus show the car idling on the grid under an orbiting camera.
 */
type AppPhase = "loading" | "title" | "wizard" | "driving";

/** Key actions that act while held (the rest are one-shot toggles) */
const HELD_KEY_ACTIONS: ReadonlySet<KeyAction> = new Set(["throttle", "brake", "steerLeft", "steerRight", "boostHold"]);

/** A loading task with no progress for this long is given up on (the procedural stand-in stays) */
const ASSET_STALL_MS = 25_000;

const approach = (value: number, target: number, maxStep: number) =>
  value + Math.max(-maxStep, Math.min(maxStep, target - value));

/** Tyre setups are saved per car (the VF26 keeps the original key) */
const TYRE_SETUP_STORAGE_KEYS: Record<VehicleModelId, string> = {
  vf26: "bugesera.tyreSetup",
  "f12026-car": "bugesera.tyreSetup.f12026-car",
  "amg-gt3": "bugesera.tyreSetup.amg-gt3",
};
const VEHICLE_STORAGE_KEY = "bugesera.vehicle";
const RUMBLE_STORAGE_KEY = "bugesera.rumble";

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Reads a front/rear pair, keeping each value inside its slider range; null when the shape is wrong */
function readAxlePair(
  value: unknown,
  front: { min: number; max: number },
  rear: { min: number; max: number }
): { front: number; rear: number } | null {
  if (!value || typeof value !== "object") return null;
  const pair = value as { front?: unknown; rear?: unknown };
  if (!isFiniteNumber(pair.front) || !isFiniteNumber(pair.rear)) return null;
  return {
    front: Math.min(front.max, Math.max(front.min, pair.front)),
    rear: Math.min(rear.max, Math.max(rear.min, pair.rear)),
  };
}

/** The tyre setup saved from an earlier session, or null when none is saved or it is unusable */
function loadStoredTyreSetup(vehicle: VehicleModelId): TyreSetup | null {
  try {
    const raw = localStorage.getItem(TYRE_SETUP_STORAGE_KEYS[vehicle]);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { coldPressurePsi?: unknown; camberDeg?: unknown } | null;
    const limits = TYRE_SETUP_LIMITS[vehicle];
    const coldPressurePsi = readAxlePair(saved?.coldPressurePsi, limits.pressurePsi, limits.pressurePsi);
    const camberDeg = readAxlePair(saved?.camberDeg, limits.camberFrontDeg, limits.camberRearDeg);
    return coldPressurePsi && camberDeg ? { coldPressurePsi, camberDeg } : null;
  } catch {
    // Storage unavailable or corrupt JSON: fall back to the physics defaults
    return null;
  }
}

function saveTyreSetup(vehicle: VehicleModelId, setup: TyreSetup) {
  try {
    localStorage.setItem(TYRE_SETUP_STORAGE_KEYS[vehicle], JSON.stringify(setup));
  } catch {
    // Storage unavailable: the setup still applies for this session
  }
}

/** The sound bank each car plays (the VF26 and the f12026-car share the VF26's) */
const soundFor = (vehicle: VehicleModelId): CarSoundSource => (vehicle === "amg-gt3" ? AMG_GT3_SOUND : VF26_SOUND);

const isVehicleModel = (value: unknown): value is VehicleModelId =>
  value === "vf26" || value === "f12026-car" || value === "amg-gt3";

/** The car to drive: `?car=` in the URL, else the last choice, else the VF26 */
function loadStoredVehicle(): VehicleModelId {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("car");
    if (isVehicleModel(fromUrl)) return fromUrl;
    const saved = localStorage.getItem(VEHICLE_STORAGE_KEY);
    return isVehicleModel(saved) ? saved : "vf26";
  } catch {
    return "vf26";
  }
}

function saveVehicle(vehicle: VehicleModelId) {
  try {
    localStorage.setItem(VEHICLE_STORAGE_KEY, vehicle);
  } catch {
    // Storage unavailable: the choice lasts for this session only
  }
}

/** Gamepad rumble is on unless it was switched off last time */
function loadStoredRumble(): boolean {
  try {
    return localStorage.getItem(RUMBLE_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

function saveRumble(enabled: boolean) {
  try {
    localStorage.setItem(RUMBLE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Storage unavailable: the choice lasts for this session only
  }
}

export const RwandaF1Simulator: React.FC = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const track = useMemo(() => getRwandaTrackData(1200), []);
  /** The player's car: the VF26 (F1Physics2026) or the f12026-car (F12026CarSim) */
  const physicsRef = useRef<SimulatorCar | null>(null);
  const [vehicleModel, setVehicleModel] = useState<VehicleModelId>(loadStoredVehicle);
  const vehicleModelRef = useRef(vehicleModel);
  /** Swaps the player's car in the running scene (set by the scene effect) */
  const swapCarRef = useRef<((vehicle: VehicleModelId) => void) | null>(null);
  const audioRef = useRef<F1AudioEngine2026 | null>(null);
  const carRigRef = useRef<SimCarRig | null>(null);
  const liveryRef = useRef<LiveryConfig>(LIVERIES[0]);
  const racingLineMeshRef = useRef<THREE.Mesh | null>(null);
  const multiplayerRef = useRef<MultiplayerSyncManager | null>(null);
  /** The AI race field while "AI opponents" is enabled */
  const aiFieldRef = useRef<AiOpponentField | null>(null);

  const [telemetry, setTelemetry] = useState<CarTelemetry>(() => {
    const tempPhys = new F1Physics2026(track);
    return { ...tempPhys.telemetry };
  });

  const [aeroPreset, setAeroPreset] =
    useState<AeroSetupPreset>(DEFAULT_AERO_PRESET);
  const [assistPreset, setAssistPreset] = useState<AssistPreset>(
    DEFAULT_ASSIST_PRESET
  );
  const [cameraMode, setCameraMode] = useState<CameraMode>("chase");
  const [tireCompound, setTireCompound] = useState<TireCompound>("soft");
  // Starts from the physics defaults (read from a throwaway instance, as the telemetry seed does)
  // until the real physics exists; the effect below then swaps in the physics defaults and any saved setup
  const [defaultTyreSetup, setDefaultTyreSetup] = useState<TyreSetup>(() =>
    new F1Physics2026(track).getTyreSetup()
  );
  const [tyreSetup, setTyreSetup] = useState<TyreSetup>(defaultTyreSetup);
  const [selectedLivery, setSelectedLivery] = useState<LiveryConfig>(
    LIVERIES[0]
  );
  const [showRacingLine, setShowRacingLine] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [boostLatch, setBoostLatch] = useState(false);
  const [mouseSteerEnabled, setMouseSteerEnabled] = useState(false);
  const [gamepadAssist, setGamepadAssist] = useState(true);
  const [gamepadRumble, setGamepadRumble] = useState<boolean>(loadStoredRumble);
  const rumbleEnabledRef = useRef(gamepadRumble);
  rumbleEnabledRef.current = gamepadRumble;
  /** Pad rumble driven from the physics; created with the physics and silenced on pause / unmount */
  const hapticsRef = useRef<GamepadHaptics | null>(null);
  const [aiOpponents, setAiOpponents] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const [phase, setPhaseState] = useState<AppPhase>("loading");
  const phaseRef = useRef<AppPhase>("loading");
  const setPhase = useCallback((next: AppPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  /** Track, car and shaders are loaded (or given up on): the loading screen offers to continue */
  const [assetsReady, setAssetsReady] = useState(false);
  /** The loading screen stays mounted while it fades out over the title menu */
  const [loadingVisible, setLoadingVisible] = useState(true);
  const [settings, setSettings] = useState<PlayerSettings>(DEFAULT_PLAYER_SETTINGS);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  /** Player's driver's-eye FOV (null = the car's own), read by the render loop */
  const cockpitFovRef = useRef<number | null>(settings.cockpitFovDeg);
  cockpitFovRef.current = settings.cockpitFovDeg;
  /** The current car's own driver's-eye FOV, for the FOV slider's default and the [ / ] keys */
  const [carCockpitFov, setCarCockpitFov] = useState(60);
  const carCockpitFovRef = useRef(carCockpitFov);
  /** Saved settings have been read and applied (saving before that would overwrite them with defaults) */
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [onboarded, setOnboarded] = useState(false);
  const [wizardMode, setWizardMode] = useState<WizardMode>("first-run");
  /** Where the controls setup returns to */
  const wizardReturnRef = useRef<"title" | "pause">("title");
  const wizardStepRef = useRef<WizardStepId>("device");
  /** First-run setup started from "Race AI" rather than "Drive" */
  const pendingRaceRef = useRef(false);
  const [launchHint, setLaunchHint] = useState(false);
  const [inviteRoom, setInviteRoom] = useState<string | null>(null);
  const keyLookupRef = useRef(buildKeyLookup(settings.keys));
  keyLookupRef.current = useMemo(() => buildKeyLookup(settings.keys), [settings.keys]);
  const assistSettingsRef = useRef<GamepadAssistSettings>(DEFAULT_GAMEPAD_ASSIST);
  assistSettingsRef.current = useMemo(
    () => ({
      ...DEFAULT_GAMEPAD_ASSIST,
      steeringRate: PAD_SENSITIVITY[settings.padSensitivity].steeringRate,
      deadzone: PAD_SENSITIVITY[settings.padSensitivity].deadzone,
    }),
    [settings.padSensitivity]
  );
  const [p2pStatus, setP2pStatus] = useState<P2PConnectionStatus>({
    mode: "local",
    roomCode: "",
    state: "idle",
    connectedWebRtcPeers: 0,
    statusText: "BroadcastChannel Active (Same-Browser) • Ready for WebRTC P2P",
  });

  const cameraModeRef = useRef<CameraMode>("chase");
  cameraModeRef.current = cameraMode;

  const boostLatchRef = useRef<boolean>(false);
  boostLatchRef.current = boostLatch;

  const mouseSteerEnabledRef = useRef<boolean>(false);
  mouseSteerEnabledRef.current = mouseSteerEnabled;
  const mouseSteerValueRef = useRef<number>(0);
  const slashCommandBufferRef = useRef<string>("");

  const keysRef = useRef<{
    up: boolean;
    down: boolean;
    left: boolean;
    right: boolean;
    boostHold: boolean;
    shiftUp: boolean;
    shiftDown: boolean;
    toggleX: boolean;
  }>({
    up: false,
    down: false,
    left: false,
    right: false,
    boostHold: false,
    shiftUp: false,
    shiftDown: false,
    toggleX: false,
  });
  /** Shaped keyboard inputs (pedals 0..1, steering -1..1, + = right) */
  const kbInputRef = useRef({ throttle: 0, brake: 0, steer: 0 });

  // Read through a ref so unlockAudio stays stable: the scene effect depends on it and must not rebuild on mute
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;
  const unlockAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new F1AudioEngine2026();
      audioRef.current.setCar(soundFor(vehicleModelRef.current));
    }
    if (!audioRef.current.isInitialized) {
      audioRef.current.init();
      audioRef.current.setMuted(isMutedRef.current);
    } else {
      audioRef.current.resume();
    }
  }, []);

  const handleAeroPresetChange = useCallback((preset: AeroSetupPreset) => {
    setAeroPreset(preset);
    if (physicsRef.current) {
      physicsRef.current.aeroPreset = preset;
    }
  }, []);

  const handleAssistPresetChange = useCallback((preset: AssistPreset) => {
    setAssistPreset(preset);
    if (physicsRef.current) {
      physicsRef.current.assistPreset = preset;
    }
  }, []);

  const handleToggleGamepadAssist = useCallback(() => {
    setGamepadAssist((prev) => {
      const next = !prev;
      if (physicsRef.current) {
        physicsRef.current.gamepadAssistEnabled = next;
      }
      return next;
    });
  }, []);

  const handleToggleGamepadRumble = useCallback(() => {
    const next = !gamepadRumble;
    setGamepadRumble(next);
    saveRumble(next);
  }, [gamepadRumble]);

  const handleTireCompoundChange = useCallback((compound: TireCompound) => {
    setTireCompound(compound);
    if (physicsRef.current) {
      physicsRef.current.tireCompound = compound;
    }
    carRigRef.current?.setTireCompound(compound);
  }, []);

  const handleChangeTyreSetup = useCallback((next: TyreSetup) => {
    setTyreSetup(next);
    physicsRef.current?.setTyreSetup(next);
    saveTyreSetup(vehicleModelRef.current, next);
  }, []);

  const handleChangeVehicle = useCallback(
    (next: VehicleModelId) => {
      unlockAudio();
      if (next === vehicleModelRef.current) return;
      vehicleModelRef.current = next;
      setVehicleModel(next);
      saveVehicle(next);
      swapCarRef.current?.(next);
      audioRef.current?.setCar(soundFor(next));
    },
    [unlockAudio]
  );

  const handleLiveryChange = useCallback((livery: LiveryConfig) => {
    setSelectedLivery(livery);
    liveryRef.current = livery;
    carRigRef.current?.setLivery(livery);
  }, []);

  const handleToggleRacingLine = useCallback(() => {
    setShowRacingLine((prev) => {
      const next = !prev;
      if (racingLineMeshRef.current) {
        racingLineMeshRef.current.visible = next;
      }
      return next;
    });
  }, []);

  const handleToggleMute = useCallback(() => {
    unlockAudio();
    setIsMuted((prev) => {
      const next = !prev;
      audioRef.current?.setMuted(next);
      return next;
    });
  }, [unlockAudio]);

  const handleToggleAiAutopilot = useCallback(() => {
    unlockAudio();
    if (physicsRef.current) {
      physicsRef.current.aiAutopilot = !physicsRef.current.aiAutopilot;
      if (physicsRef.current.aiAutopilot && physicsRef.current.vxMs < 5) {
        physicsRef.current.vxMs = 45;
      }
    }
  }, [unlockAudio]);

  const handleToggleXMode = useCallback(() => {
    unlockAudio();
    if (physicsRef.current) {
      physicsRef.current.autoXMode = false;
      physicsRef.current.activeAeroMode =
        physicsRef.current.activeAeroMode === "Z_MODE" ? "X_MODE" : "Z_MODE";
    }
  }, [unlockAudio]);

  const handleToggleBoostLatch = useCallback(() => {
    unlockAudio();
    setBoostLatch((prev) => !prev);
  }, [unlockAudio]);

  const handleToggleMouseSteer = useCallback(() => {
    unlockAudio();
    setMouseSteerEnabled((prev) => {
      const next = !prev;
      if (!next) {
        mouseSteerValueRef.current = 0;
      }
      return next;
    });
  }, [unlockAudio]);

  const handleResetCar = useCallback(
    (flyingStart: boolean) => {
      unlockAudio();
      if (physicsRef.current) {
        physicsRef.current.aiAutopilot = false;
        if (aiFieldRef.current) aiFieldRef.current.startRace(!flyingStart);
        else physicsRef.current.resetToStartGrid(flyingStart);
      }
    },
    [unlockAudio]
  );

  const handleToggleAiOpponents = useCallback(() => {
    unlockAudio();
    const physics = physicsRef.current;
    if (!physics) return;
    if (aiFieldRef.current) {
      aiFieldRef.current = null;
      setAiOpponents(false);
      return;
    }
    physics.aiAutopilot = false;
    const field = new AiOpponentField(track, physics);
    field.startRace(true);
    aiFieldRef.current = field;
    setAiOpponents(true);
  }, [track, unlockAudio]);

  const handleSelectTurn = useCallback(
    (turnNumber: number) => {
      unlockAudio();
      // Corner practice leaves the race: the field would otherwise lose track of the player's distance
      if (aiFieldRef.current) {
        aiFieldRef.current = null;
        setAiOpponents(false);
      }
      if (physicsRef.current) {
        physicsRef.current.aiAutopilot = false;
        physicsRef.current.teleportToTurn(turnNumber);
      }
    },
    [unlockAudio]
  );

  const handleHostP2PRoom = useCallback((customCode?: string) => {
    return multiplayerRef.current?.hostRoom(customCode) ?? "";
  }, []);

  const handleJoinP2PRoom = useCallback((roomCode: string) => {
    multiplayerRef.current?.joinRoom(roomCode);
  }, []);

  const handleCreateManualOffer = useCallback(async () => {
    if (!multiplayerRef.current) return "";
    return multiplayerRef.current.createManualOffer();
  }, []);

  const handleAcceptManualOffer = useCallback(async (offerToken: string) => {
    if (!multiplayerRef.current) return "";
    return multiplayerRef.current.acceptManualOfferAndCreateAnswer(offerToken);
  }, []);

  const handleAcceptManualAnswer = useCallback(async (answerToken: string) => {
    if (!multiplayerRef.current) return false;
    await multiplayerRef.current.acceptManualAnswer(answerToken);
    return true;
  }, []);

  /** Esc / pad Menu: open or close the pause menu, releasing every held key */
  const togglePause = useCallback(() => {
    setPaused((prev) => {
      const next = !prev;
      pausedRef.current = next;
      if (next) {
        keysRef.current.up = false;
        keysRef.current.down = false;
        keysRef.current.left = false;
        keysRef.current.right = false;
        keysRef.current.boostHold = false;
        kbInputRef.current.throttle = 0;
        kbInputRef.current.brake = 0;
        kbInputRef.current.steer = 0;
      }
      return next;
    });
  }, []);
  const togglePauseRef = useRef(togglePause);
  togglePauseRef.current = togglePause;

  const setRacingLineVisible = useCallback((visible: boolean) => {
    setShowRacingLine(visible);
    if (racingLineMeshRef.current) racingLineMeshRef.current.visible = visible;
  }, []);

  const setGamepadAssistEnabled = useCallback((enabled: boolean) => {
    setGamepadAssist(enabled);
    if (physicsRef.current) physicsRef.current.gamepadAssistEnabled = enabled;
  }, []);

  const setMouseSteer = useCallback((enabled: boolean) => {
    setMouseSteerEnabled(enabled);
    if (!enabled) mouseSteerValueRef.current = 0;
  }, []);

  const handleChangeSettings = useCallback((update: (prev: PlayerSettings) => PlayerSettings) => {
    setSettings((prev) => update(prev));
  }, []);

  /** null returns to the car's own FOV */
  const handleCockpitFovChange = useCallback((fovDeg: number | null) => {
    setSettings((prev) => ({ ...prev, cockpitFovDeg: fovDeg === null ? null : Math.round(clampFov(fovDeg)) }));
  }, []);

  /** Leaves the menus for the car: a practice run from the grid, or a race against the AI field */
  const startDriving = useCallback(
    (race: boolean) => {
      const physics = physicsRef.current;
      if (physics) {
        physics.aiAutopilot = false;
        if (race) {
          if (!aiFieldRef.current) aiFieldRef.current = new AiOpponentField(track, physics);
          aiFieldRef.current.startRace(true);
        } else {
          aiFieldRef.current = null;
          physics.resetToStartGrid(false);
        }
      }
      setAiOpponents(race);
      kbInputRef.current.throttle = 0;
      kbInputRef.current.brake = 0;
      kbInputRef.current.steer = 0;
      pausedRef.current = false;
      setPaused(false);
      setLaunchHint(true);
      setPhase("driving");
    },
    [track, setPhase]
  );

  const openControls = useCallback(
    (from: "title" | "pause") => {
      wizardReturnRef.current = from;
      setWizardMode("controls");
      setPhase("wizard");
    },
    [setPhase]
  );

  /** Title "Drive" / "Race AI": the first time through, the setup comes first */
  const handleTitleStart = useCallback(
    (race: boolean) => {
      if (onboarded) {
        startDriving(race);
        return;
      }
      pendingRaceRef.current = race;
      wizardReturnRef.current = "title";
      setWizardMode("first-run");
      setPhase("wizard");
    },
    [onboarded, startDriving, setPhase]
  );

  const leaveWizard = useCallback(() => {
    // The controls setup opened from the pause menu goes back to it (still paused)
    setPhase(wizardReturnRef.current === "pause" ? "driving" : "title");
  }, [setPhase]);

  const finishWizard = useCallback(() => {
    if (wizardMode === "first-run") {
      saveOnboarded();
      setOnboarded(true);
      startDriving(pendingRaceRef.current);
    } else {
      leaveWizard();
    }
  }, [wizardMode, startDriving, leaveWizard]);

  const handleWizardStep = useCallback((step: WizardStepId) => {
    wizardStepRef.current = step;
  }, []);

  const exitToTitle = useCallback(() => {
    aiFieldRef.current = null;
    setAiOpponents(false);
    physicsRef.current?.resetToStartGrid(false);
    pausedRef.current = false;
    setPaused(false);
    setPhase("title");
  }, [setPhase]);

  /** "Press any key" on the loading screen: the user gesture that unlocks audio */
  const handleLoadingStart = useCallback(() => {
    unlockAudio();
    setPhase("title");
    if (inviteRoom) multiplayerRef.current?.joinRoom(inviteRoom);
  }, [unlockAudio, setPhase, inviteRoom]);
  const handleLoadingDone = useCallback(() => setLoadingVisible(false), []);

  // The first-drive hint clears once the car is moving (or after a while)
  useEffect(() => {
    if (!launchHint) return;
    const id = window.setTimeout(() => setLaunchHint(false), 15_000);
    return () => window.clearTimeout(id);
  }, [launchHint]);
  useEffect(() => {
    if (launchHint && telemetry.speedKmh > 15) setLaunchHint(false);
  }, [launchHint, telemetry.speedKmh]);

  // Silence the pad and FFB as soon as the pause menu opens or the car is left for the menus
  useEffect(() => {
    if (paused || phase !== "driving") {
      hapticsRef.current?.stop();
      wheelFfb.stop();
    }
  }, [paused, phase]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    /** The authored track once the GLB is loaded: the f12026-car drives on its Track_Collider_* meshes */
    let trackRoot: THREE.Object3D | null = null;

    /**
     * A car of the chosen model on the start grid, with the session's presets carried over from `prev`
     * (defaults for the first car) and that car's saved tyre setup
     */
    const createCar = (vehicle: VehicleModelId, prev: SimulatorCar | null): SimulatorCar => {
      let car: SimulatorCar;
      if (vehicle === "amg-gt3") {
        car = createAmgGt3Sim(track, trackRoot);
      } else if (vehicle === "f12026-car") {
        const f12026 = new F12026CarSim(track, trackRoot);
        // DRS is earned at a detection point within 1 s of the car ahead when racing; always in practice
        f12026.drsEligibility = () => {
          const field = aiFieldRef.current;
          if (!field) return true;
          const gap = field.playerGapAheadS();
          return gap !== null && gap <= 1;
        };
        car = f12026;
      } else {
        car = new F1Physics2026(track);
      }
      car.aiAutopilot = false;
      car.assistPreset = prev?.assistPreset ?? DEFAULT_ASSIST_PRESET;
      car.aeroPreset = prev?.aeroPreset ?? DEFAULT_AERO_PRESET;
      if (prev) {
        car.gamepadAssistEnabled = prev.gamepadAssistEnabled;
        car.tireCompound = prev.tireCompound;
      }
      car.resetToStartGrid(false);

      // Capture the car's defaults first, then apply its saved tyre setup (if any)
      const tyreDefaults = car.getTyreSetup();
      const initialTyreSetup = loadStoredTyreSetup(vehicle) ?? tyreDefaults;
      car.setTyreSetup(initialTyreSetup);
      setDefaultTyreSetup(tyreDefaults);
      setTyreSetup(initialTyreSetup);
      return car;
    };

    let physics = createCar(vehicleModelRef.current, null);
    physicsRef.current = physics;

    swapCarRef.current = (vehicle) => {
      physics = createCar(vehicle, physics);
      physicsRef.current = physics;
      swapCarRig(vehicle);
      kbInputRef.current.throttle = 0;
      kbInputRef.current.brake = 0;
      kbInputRef.current.steer = 0;
      // A running race restarts from the lights with the new car
      if (aiFieldRef.current) {
        const field = new AiOpponentField(track, physics);
        field.startRace(true);
        aiFieldRef.current = field;
      }
      setTelemetry({ ...physics.telemetry });
    };

    const haptics = new GamepadHaptics();
    hapticsRef.current = haptics;

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(
      62,
      container.clientWidth / Math.max(1, container.clientHeight),
      0.12,
      5500
    );

    const renderer = new THREE.WebGLRenderer({
      // MSAA happens in the post-processing composer's half-float target instead
      antialias: false,
      stencil: false,
      powerPreference: "high-performance",
    });
    // AgX exposure, pixel ratio clamp and shadow type; set before the composer is created
    configureRenderer(renderer);
    renderer.setSize(container.clientWidth, container.clientHeight);

    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    // Golden-hour sky dome, its baked PMREM environment, horizon fog and the car-tracking sun shadow
    const env = createGoldenHourEnvironment(renderer, scene);
    // Scene render + one merged effect pass (mipmap bloom, then AgX tone mapping)
    const postFx = createPostFx(renderer, scene, camera);

    const builtCircuit = buildRwandaCircuitScene(track);
    scene.add(builtCircuit.sceneGroup);
    racingLineMeshRef.current = builtCircuit.racingLineMesh;
    // Track_Collider_Road / surface colliders and Track_Collider_Wall_* barriers for the f12026-car
    void builtCircuit.trackRoot.then((root) => {
      if (disposed) return;
      trackRoot = root;
      if (physics instanceof F12026CarSim) physics.attachTrackRoot(root);
      // Move broadcast cameras that would film the inside of a grandstand
      tvDirector.resolveOcclusion(root);
    });

    /** The 3D car for a model: the GT3 has its own; the VF26 and the f12026-car share the F1 rig */
    const isGt3Rig = (vehicle: VehicleModelId) => vehicle === "amg-gt3";
    const createCarRig = (vehicle: VehicleModelId): SimCarRig => {
      const rig = isGt3Rig(vehicle) ? createGt3CarRig() : createF1Car2026(liveryRef.current, physics.tireCompound);
      rig.setLivery(liveryRef.current);
      scene.add(rig.root);
      carRigRef.current = rig;
      return rig;
    };
    let carRig = createCarRig(vehicleModelRef.current);
    let carRigIsGt3 = isGt3Rig(vehicleModelRef.current);
    const swapCarRig = (vehicle: VehicleModelId) => {
      if (isGt3Rig(vehicle) === carRigIsGt3) return;
      // The VF26 cockpit extras belong to the old body
      wheelDisplay?.dispose();
      wheelDisplay = null;
      wingMirrors?.dispose();
      wingMirrors = null;
      carRig.dispose();
      carRig = createCarRig(vehicle);
      carRigIsGt3 = isGt3Rig(vehicle);
    };

    // Persistent 4-Wheel Skidmarks, Instanced Tire Smoke/Gravel & Multiplayer/AI Opponent Renderer
    const visualFx = new SimVisualFxManager();
    scene.add(visualFx.group);
    const multiplayerSync = new MultiplayerSyncManager();
    multiplayerSync.onStatusChange = (st) => {
      setP2pStatus(st);
    };
    multiplayerRef.current = multiplayerSync;

    // Underbody Titanium Skid-Block Sparks
    const sparkCount = 48;
    const sparkGeom = new THREE.BufferGeometry();
    const sparkPositions = new Float32Array(sparkCount * 3);
    const sparkVelocities: THREE.Vector3[] = [];
    const sparkLives = new Float32Array(sparkCount);

    for (let i = 0; i < sparkCount; i++) {
      sparkVelocities.push(new THREE.Vector3());
      sparkLives[i] = 0;
    }
    sparkGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(sparkPositions, 3)
    );
    const sparkPoints = new THREE.Points(
      sparkGeom,
      new THREE.PointsMaterial({
        color: 0xfbbf24,
        size: 0.22,
        transparent: true,
        opacity: 0.9,
      })
    );
    scene.add(sparkPoints);
    let nextSparkIdx = 0;

    const onMouseMove = (e: MouseEvent) => {
      if (!mouseSteerEnabledRef.current) return;
      const w = Math.max(1, window.innerWidth);
      // Center 65% of screen maps smoothly to [-1, 1] steering lock with slight precision curve
      const rawNorm = ((e.clientX / w) * 2 - 1) / 0.65;
      const clamped = THREE.MathUtils.clamp(rawNorm, -1, 1);
      mouseSteerValueRef.current =
        Math.sign(clamped) * Math.pow(Math.abs(clamped), 1.18);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      // The loading screen, title menu and setup own the keyboard outside the car
      if (phaseRef.current !== "driving") return;
      unlockAudio();
      const code = e.code;

      if (code === "Escape") {
        e.preventDefault();
        togglePauseRef.current();
        return;
      }
      if (pausedRef.current) return;

      // [ / ] narrow / widen the onboard FOV live, unless the player bound those keys to a control
      if ((code === "BracketLeft" || code === "BracketRight") && !keyLookupRef.current.has(code)) {
        const step = code === "BracketLeft" ? -1 : 1;
        setSettings((prev) => ({
          ...prev,
          cockpitFovDeg: Math.round(clampFov((prev.cockpitFovDeg ?? carCockpitFovRef.current) + step)),
        }));
        return;
      }

      // Support typing "/boost" anywhere to latch 350kW MGU-K + 425kW ICE Overboost
      if (e.key && e.key.length === 1) {
        if (e.key === "/") {
          slashCommandBufferRef.current = "/";
          return;
        } else if (slashCommandBufferRef.current.startsWith("/")) {
          slashCommandBufferRef.current = (
            slashCommandBufferRef.current + e.key.toLowerCase()
          ).slice(-6);
          if (slashCommandBufferRef.current === "/boost") {
            physics.activateBoostOverride();
            setBoostLatch((prev) => !prev);
            slashCommandBufferRef.current = "";
            return;
          }
          if ("/boost".startsWith(slashCommandBufferRef.current)) {
            return;
          } else {
            slashCommandBufferRef.current = "";
          }
        }
      }

      const action = keyLookupRef.current.get(code);
      if (!action) return;
      // Held controls ignore auto-repeat anyway; toggles must not flicker while a key is held
      if (e.repeat && !HELD_KEY_ACTIONS.has(action)) return;
      switch (action) {
        case "throttle":
          keysRef.current.up = true;
          if (physics.aiAutopilot) physics.aiAutopilot = false;
          break;
        case "brake":
          keysRef.current.down = true;
          if (physics.aiAutopilot) physics.aiAutopilot = false;
          break;
        case "steerLeft":
          keysRef.current.left = true;
          if (physics.aiAutopilot) physics.aiAutopilot = false;
          break;
        case "steerRight":
          keysRef.current.right = true;
          if (physics.aiAutopilot) physics.aiAutopilot = false;
          break;
        case "boostHold":
          keysRef.current.boostHold = true;
          break;
        case "boostLatch":
          setBoostLatch((prev) => !prev);
          break;
        case "mouseSteer":
          setMouseSteerEnabled((prev) => {
            const next = !prev;
            if (!next) mouseSteerValueRef.current = 0;
            return next;
          });
          break;
        case "aero":
          keysRef.current.toggleX = true;
          break;
        case "shiftUp":
          keysRef.current.shiftUp = true;
          break;
        case "shiftDown":
          keysRef.current.shiftDown = true;
          break;
        case "camera":
          setCameraMode(nextCameraMode(cameraModeRef.current));
          break;
        case "racingLine":
          handleToggleRacingLine();
          break;
        case "mute":
          handleToggleMute();
          break;
        case "autopilot":
          physics.aiAutopilot = !physics.aiAutopilot;
          if (physics.aiAutopilot && physics.vxMs < 5) {
            physics.vxMs = 45;
          }
          break;
        case "restart":
          restartRun();
          break;
      }
    };

    const restartRun = () => {
      physics.aiAutopilot = false;
      if (aiFieldRef.current) aiFieldRef.current.startRace(true);
      else physics.resetToStartGrid(true);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      const action = keyLookupRef.current.get(e.code);
      if (action === "throttle") keysRef.current.up = false;
      else if (action === "brake") keysRef.current.down = false;
      else if (action === "steerLeft") keysRef.current.left = false;
      else if (action === "steerRight") keysRef.current.right = false;
      else if (action === "boostHold") keysRef.current.boostHold = false;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const onResize = () => {
      if (!container) return;
      camera.aspect =
        container.clientWidth / Math.max(1, container.clientHeight);
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
      postFx.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener("resize", onResize);

    let animFrameId = 0;
    let lastTimeMs = performance.now();
    let lastHudSyncMs = 0;

    // Horizon-Stabilized Sim Camera State
    let smoothedCamDist = 5.35;
    let smoothedApexLookYaw = 0;
    const smoothedChaseDir = new THREE.Vector3(0, 0, 1);
    const chaseCross = new THREE.Vector3();
    const smoothedCamUp = new THREE.Vector3(0, 1, 0);
    const smoothedHeliPos = new THREE.Vector3();
    const smoothedHeliLook = new THREE.Vector3();
    // Cockpit extras, created once the VF26 model has loaded: the wheel's LCD and the live wing mirrors
    let wheelDisplay: SteeringWheelDisplay | null = null;
    let wingMirrors: WingMirrors | null = null;
    const lapDelta = new LapDeltaTracker(track.totalLengthM);
    const displayExtra: { deltaMs: number | null } = { deltaMs: null };
    // Spring-damped onboard camera shake from the suspension and kerbs
    const cockpitShake = new CockpitMicroShake();
    const shakeQuat = new THREE.Quaternion();
    const shakeEuler = new THREE.Euler();
    // Automatic trackside broadcast cameras on dolly splines (telephoto, zooming in over kerbs)
    const tvDirector = new TracksideBroadcastDirector(track);
    let frameIndex = 0;
    const deviceInput = new DeviceInputReader();
    let menuOrbitRad = 0.6;
    let menuViewOffset = false;

    // Loading: once both GLBs have settled (loaded or given up), compile every shader before the
    // first frame is drawn, then let the loading screen offer to continue
    const loadStartMs = performance.now();
    let warmupStarted = false;
    const checkAssets = () => {
      if (warmupStarted || disposed) return;
      const tasks = assetProgress.get().tasks;
      const settled = tasks
        .filter((t) => t.id !== "shaders")
        .every((t) => t.status === "done" || t.status === "failed");
      if (!settled) return;
      warmupStarted = true;
      assetProgress.begin("shaders");
      // One frame later the car model has been swapped in by its own (earlier) listener
      requestAnimationFrame(() => {
        if (disposed) return;
        renderer
          .compileAsync(scene, camera)
          .then(
            () => assetProgress.done("shaders"),
            () => assetProgress.fail("shaders")
          )
          .finally(() => {
            if (!disposed) setAssetsReady(true);
          });
      });
    };
    const unsubscribeAssets = assetProgress.subscribe(checkAssets);
    const assetWatchdog = window.setInterval(() => {
      assetProgress.failStalled(ASSET_STALL_MS);
      // A load that never even started (no network request made) is given up on too
      if (performance.now() - loadStartMs > ASSET_STALL_MS) {
        for (const t of assetProgress.get().tasks) {
          if (t.id !== "shaders" && t.status === "pending") assetProgress.fail(t.id);
        }
      }
    }, 2000);
    checkAssets();

    const animate = (nowMs: number) => {
      animFrameId = requestAnimationFrame(animate);
      const dtSeconds = Math.min((nowMs - lastTimeMs) / 1000, 0.05);
      lastTimeMs = nowMs;

      // Optional Gamepad / Sim Racing Wheel Polling. Controllers with the standard mapping (Xbox,
      // DualShock, DualSense …) send the raw thumbstick through the physics' gamepad steering
      // assist every frame (also when centred: it self-aligns); other devices (wheels) drive the
      // rack directly.
      // Read every frame (also in menus / paused) so button edges never fire on a stale press
      const pads = connectedPads();
      const device = deviceInput.read(pads, settingsRef.current, dtSeconds);
      const appPhase = phaseRef.current;
      const inMenu = appPhase !== "driving";
      const driving = !inMenu && !pausedRef.current;
      const gamepadThrottle = driving ? device.throttle : 0;
      const gamepadBrake = driving ? device.brake : 0;
      const gamepadSteer = device.analogSteer;
      const gamepadStick = device.padSteer;
      const gamepadBoost = driving && device.boostHeld;
      if (!inMenu) {
        for (const action of device.pressed) {
          if (action === "pause") {
            // Opening only: in the pause menu, B / Menu resume through the menu's own navigation
            if (!pausedRef.current) togglePauseRef.current();
            continue;
          }
          if (!driving) continue;
          if (action === "shiftUp") keysRef.current.shiftUp = true;
          else if (action === "shiftDown") keysRef.current.shiftDown = true;
          else if (action === "aero") keysRef.current.toggleX = true;
          else if (action === "camera") setCameraMode(nextCameraMode(cameraModeRef.current));
          else if (action === "racingLine") handleToggleRacingLine();
          else if (action === "restart") restartRun();
        }
      }

      // Keyboard-only input shaping: keys become ramped pedals and a rate- and speed-limited
      // steering angle (about what keeps the front tyres near peak slip at this speed).
      // Wheel and mouse inputs are passed through untouched.
      const keys = keysRef.current;
      const kb = kbInputRef.current;
      kb.throttle = approach(
        kb.throttle,
        keys.up ? 1 : 0,
        dtSeconds / (keys.up ? KB_THROTTLE_RISE_S : KB_THROTTLE_FALL_S)
      );
      kb.brake = approach(
        kb.brake,
        keys.down ? 1 : 0,
        dtSeconds / (keys.down ? KB_BRAKE_RISE_S : KB_BRAKE_FALL_S)
      );
      const vFwd = Math.max(0, physics.vxMs);
      const kbSteerLimit = Math.min(
        1,
        ((physics.wheelbaseM * KB_STEER_LIMIT_ACCEL) / Math.max(1, vFwd * vFwd) +
          KB_STEER_LIMIT_SLIP_RAD) /
          physics.maxSteerAngleRad
      );
      const kbSteerTarget =
        ((keys.right ? 1 : 0) - (keys.left ? 1 : 0)) * kbSteerLimit;
      const kbRecentring =
        kbSteerTarget === 0 || kbSteerTarget * kb.steer < 0;
      kb.steer = approach(
        kb.steer,
        kbSteerTarget,
        (kbSteerLimit / (kbRecentring ? KB_STEER_RETURN_S : KB_STEER_RISE_S)) *
          dtSeconds
      );
      const kbSteerActive = keys.left || keys.right || Math.abs(kb.steer) > 1e-3;
      const activeAnalogSteer = mouseSteerEnabledRef.current
        ? mouseSteerValueRef.current
        : gamepadSteer;

      const inputs: ControlInputs = {
        throttle: Math.max(kb.throttle, gamepadThrottle),
        brake: Math.max(kb.brake, gamepadBrake),
        steerLeft: 0,
        steerRight: 0,
        analogSteer: kbSteerActive ? kb.steer : activeAnalogSteer,
        padSteer:
          kbSteerActive || mouseSteerEnabledRef.current ? undefined : gamepadStick,
        manualOverride:
          keysRef.current.boostHold || boostLatchRef.current || gamepadBoost,
        toggleXMode: keysRef.current.toggleX,
        shiftUp: keysRef.current.shiftUp,
        shiftDown: keysRef.current.shiftDown,
      };
      keysRef.current.toggleX = false;
      keysRef.current.shiftUp = false;
      keysRef.current.shiftDown = false;

      // The AI field holds the player on the grid until the lights go out, then runs its cars
      const aiField = aiFieldRef.current;
      if (physics.gamepadAssist.settings !== assistSettingsRef.current) {
        physics.gamepadAssist.settings = assistSettingsRef.current;
      }
      if (driving) {
        if (!aiField?.playerFrozen) physics.step(dtSeconds, inputs);
        aiField?.update(dtSeconds);
      }
      haptics.update(physics.telemetry, dtSeconds, rumbleEnabledRef.current && driving);
      // Forces only while driving with the wheel: on a pad or the keyboard a plugged-in wheel stays limp
      wheelFfb.update(physics.telemetry, settingsRef.current.wheel, pads, nowMs, driving && settingsRef.current.device === "wheel");
      physics.telemetry.race = aiField?.status();
      builtCircuit.setStartLights(aiField?.phase === "lights" ? aiField.lightsOn : null);

      // Update 3D Dashed Dynamic Braking Line colors (green/yellow/red) ahead of the car (Reference Image 4)
      builtCircuit.updateDynamicRacingLine(physics.sMeters, physics.vxMs, physics.brakingGuide);

      // Update 25 Hz BroadcastChannel + Cubic Hermite/Slerp Multiplayer & AI Opponents
      const carVelocityWorld = new THREE.Vector3(
        physics.vyMs,
        0,
        physics.vxMs
      ).applyQuaternion(physics.worldQuaternion);
      const interpolatedPeers = multiplayerSync.update(
        nowMs,
        {
          driverCode: "RWA",
          teamColorHex: "#E10600",
          pos: [
            physics.worldPosition.x,
            physics.worldPosition.y,
            physics.worldPosition.z,
          ],
          quat: [
            physics.worldQuaternion.x,
            physics.worldQuaternion.y,
            physics.worldQuaternion.z,
            physics.worldQuaternion.w,
          ],
          linVel: [carVelocityWorld.x, carVelocityWorld.y, carVelocityWorld.z],
          angVel: [0, physics.yawRateRadS, 0],
          steerAngle: physics.steerAngleNorm * 0.36,
          wheelRPMs: [
            physics.wheels[0].spinVel * 9.549296,
            physics.wheels[1].spinVel * 9.549296,
            physics.wheels[2].spinVel * 9.549296,
            physics.wheels[3].spinVel * 9.549296,
          ],
          throttle: physics.telemetry.throttle,
          brake: physics.telemetry.brake,
          trackS: physics.sMeters,
          speedKmh: physics.telemetry.speedKmh,
        }
      );

      const renderPeers = aiField ? [...interpolatedPeers, ...aiField.peers()] : interpolatedPeers;

      physics.telemetry.peers = renderPeers.map((p) => {
        let deltaS = p.trackS - physics.sMeters;
        if (deltaS > track.totalLengthM * 0.5) deltaS -= track.totalLengthM;
        if (deltaS < -track.totalLengthM * 0.5) deltaS += track.totalLengthM;
        const refSpeedMs = Math.max(25, physics.vxMs, p.speedKmh / 3.6);
        return {
          peerId: p.peerId,
          driverCode: p.driverCode,
          teamColorHex: p.teamColorHex,
          trackDistanceM: p.trackS,
          speedKmh: p.speedKmh,
          gapSeconds: Number((deltaS / refSpeedMs).toFixed(2)),
          isAiPeer: p.isAiPeer,
        };
      });

      // Keep mouseSteerValueRef synchronized with actual steering angle while keyboard A/D override is held
      // so releasing A/D mid-corner at 300+ km/h transitions seamlessly without a step jump
      if (mouseSteerEnabledRef.current && kbSteerActive) {
        mouseSteerValueRef.current = kb.steer;
      }

      // Auto-disengage latched /boost if ERS battery is completely depleted
      if (boostLatchRef.current && physics.ersEnergyJ <= 2_500) {
        boostLatchRef.current = false;
        setBoostLatch(false);
      }

      // The menus film the car from outside, whatever the player's camera is
      const mode: CameraMode = inMenu ? "chase" : cameraModeRef.current;
      const vf26Cams = carRig.getCameraAnchors();
      const carFovDeg = vf26Cams ? vf26Cams.cockpit.fovDeg : FALLBACK_COCKPIT_FOV_DEG;
      if (carFovDeg !== carCockpitFovRef.current) {
        carCockpitFovRef.current = carFovDeg;
        setCarCockpitFov(carFovDeg);
      }
      const onboardFovShift = cockpitFovRef.current === null ? 0 : cockpitFovRef.current - carFovDeg;
      // Hide driver helmet mesh only when inside first-person cockpit view so it never clips the camera
      // (the procedural driver is hidden entirely once the VF26 model has replaced the procedural car)
      carRig.helmetGroup.visible = mode !== "cockpit" && !vf26Cams;
      carRig.setCockpitView(mode === "cockpit");

      carRig.root.position.copy(physics.worldPosition);
      carRig.root.quaternion.copy(physics.worldQuaternion);
      carRig.chassisGroup.position.y = physics.rideHeightOffsetM;
      carRig.updateFromTelemetry(
        physics.telemetry,
        physics.pitchRad,
        physics.rollRad,
        physics.wheelRotationRad,
        dtSeconds,
        physics.tyreVisuals
      );

      const vf26Body = carRig.getVf26Body();
      if (vf26Body && !wheelDisplay) {
        const steerBase = vf26Body.getObjectByName("STEER_BASE");
        if (steerBase) wheelDisplay = new SteeringWheelDisplay(steerBase);
        wingMirrors = new WingMirrors(renderer, scene, vf26Body);
      }
      lapDelta.update(physics.telemetry);
      // The wheel is only in shot from the onboard views; the display redraws itself at 30 Hz
      if (wheelDisplay && (mode === "cockpit" || mode === "tv_pod" || mode === "cockpit_shoulder")) {
        const delta = lapDelta.delta(physics.telemetry);
        displayExtra.deltaMs = delta === null ? null : delta * 1000;
        wheelDisplay.update(physics.telemetry, nowMs, displayExtra);
      }
      const shake = cockpitShake.update(dtSeconds, physics.telemetry);

      // Update persistent 4-wheel skidmark ribbons, tire smoke/gravel particles & opponent 3D cars
      visualFx.update(
        dtSeconds,
        physics.worldQuaternion,
        physics.vxMs,
        physics.wheels,
        renderPeers
      );


      // Titanium Floor Sparks
      if (
        !carRigIsGt3 &&
        ((physics.telemetry.speedKmh > 280 &&
          (physics.telemetry.verticalG ?? 1.0) > 1.15) ||
          physics.telemetry.onKerbLeft ||
          physics.telemetry.onKerbRight)
      ) {
        const carForward = new THREE.Vector3(0, 0, 1).applyQuaternion(
          physics.worldQuaternion
        );
        const carRight = new THREE.Vector3(-1, 0, 0).applyQuaternion(
          physics.worldQuaternion
        );
        for (let s = 0; s < 2; s++) {
          const idx = nextSparkIdx % sparkCount;
          nextSparkIdx++;
          const spawnPos = physics.worldPosition
            .clone()
            .addScaledVector(carForward, -1.9)
            .addScaledVector(carRight, (Math.random() - 0.5) * 0.7)
            .add(new THREE.Vector3(0, 0.08, 0));

          sparkPositions[idx * 3] = spawnPos.x;
          sparkPositions[idx * 3 + 1] = spawnPos.y;
          sparkPositions[idx * 3 + 2] = spawnPos.z;

          sparkVelocities[idx]
            .copy(carForward)
            .multiplyScalar(-physics.vxMs * 0.35)
            .add(
              new THREE.Vector3(
                (Math.random() - 0.5) * 6,
                1.8 + Math.random() * 3.5,
                (Math.random() - 0.5) * 6
              )
            );
          sparkLives[idx] = 0.25 + Math.random() * 0.2;
        }
      }

      for (let i = 0; i < sparkCount; i++) {
        if (sparkLives[i] > 0) {
          sparkLives[i] -= dtSeconds;
          sparkPositions[i * 3] += sparkVelocities[i].x * dtSeconds;
          sparkPositions[i * 3 + 1] += sparkVelocities[i].y * dtSeconds;
          sparkPositions[i * 3 + 2] += sparkVelocities[i].z * dtSeconds;
          sparkVelocities[i].y -= 9.81 * dtSeconds;
        } else {
          sparkPositions[i * 3 + 1] = -999;
        }
      }
      sparkGeom.attributes.position.needsUpdate = true;

      // Right-handed car basis: +X is carLeft, -X is carRight, +Y is carUp, +Z is carForward
      const carRight = new THREE.Vector3(-1, 0, 0).applyQuaternion(
        physics.worldQuaternion
      );
      const carUp = new THREE.Vector3(0, 1, 0).applyQuaternion(
        physics.worldQuaternion
      );
      const carForward = new THREE.Vector3(0, 0, 1).applyQuaternion(
        physics.worldQuaternion
      );

      const speedNorm = THREE.MathUtils.clamp(
        physics.telemetry.speedKmh / 350,
        0,
        1
      );
      const kerbShake =
        physics.telemetry.onKerbLeft || physics.telemetry.onKerbRight
          ? Math.sin(nowMs * 0.095) * 0.018
          : 0;
      const highSpeedBuffet =
        speedNorm > 0.72
          ? Math.sin(nowMs * 0.07) * 0.007 * (speedNorm - 0.72)
          : 0;

      // True vehicle chassis slip angle beta = atan2(vy, vx) (+X is left, so -vy is rightward slip)
      const bodySlipAngleRad =
        physics.vxMs > 3
          ? Math.atan2(-physics.vyMs, Math.max(3, physics.vxMs))
          : 0;

      const vf26Cam =
        vf26Cams &&
        (mode === "cockpit"
          ? vf26Cams.cockpit
          : mode === "cockpit_shoulder"
            ? vf26Cams.shoulder
            : mode === "tv_pod"
              ? vf26Cams.tcam
              : mode === "nose"
                ? vf26Cams.bumper
                : null);
      if (vf26Cam) {
        // Onboard camera anchors from the car model: bolted to the sprung chassis at the
        // model's position, pitch and field of view
        carRig.chassisGroup.updateWorldMatrix(true, false);
        camera.position.copy(vf26Cam.pos).applyMatrix4(carRig.chassisGroup.matrixWorld);
        carRig.chassisGroup.getWorldQuaternion(camera.quaternion);
        camera.quaternion
          .multiply(CAM_FORWARD_FLIP)
          .multiply(new THREE.Quaternion().setFromAxisAngle(CAM_X_AXIS, vf26Cam.pitchRad));
        if (mode === "cockpit" || mode === "tv_pod") {
          // Micro-shake: pitch about the lens' X axis, roll about its view axis, heave along the car's up
          shakeEuler.set(shake.pitchRad, 0, shake.rollRad);
          camera.quaternion.multiply(shakeQuat.setFromEuler(shakeEuler));
          camera.position.addScaledVector(carUp, shake.heaveM);
        }
        camera.up.copy(carUp);
        // The player's FOV shifts the driver's-eye cameras together, keeping the model's framing between them
        const targetOnboardFov = mode === "nose" ? vf26Cam.fovDeg : clampFov(vf26Cam.fovDeg + onboardFovShift);
        if (camera.fov !== targetOnboardFov) {
          camera.fov = targetOnboardFov;
          camera.updateProjectionMatrix();
        }
      } else if (mode === "chase") {
        // World-space trajectory-following Chase Rig:
        // smoothedChaseDir trails the car's velocity + heading in world space so that when the driver
        // steers into a corner, the car visibly rotates (yaws) inside the camera frame rather than
        // appearing locked to the screen axis ("strafing").
        const velHoriz = new THREE.Vector3(carVelocityWorld.x, 0, carVelocityWorld.z);
        const velSpeed = velHoriz.length();
        const targetBoomDir =
          velSpeed > 4
            ? velHoriz.multiplyScalar(1 / velSpeed).lerp(carForward, 0.38).normalize()
            : carForward.clone();
        if (smoothedChaseDir.lengthSq() < 0.01) smoothedChaseDir.copy(carForward);
        smoothedChaseDir.lerp(targetBoomDir, Math.min(1, dtSeconds * 6.8));
        // Bound the lag about the car's up: the boom stays behind the car through a spin or a respawn, no snap
        const lagRad = Math.atan2(
          chaseCross.crossVectors(carForward, smoothedChaseDir).dot(carUp),
          smoothedChaseDir.dot(carForward)
        );
        if (!(Math.abs(lagRad) <= CHASE_MAX_LAG_RAD)) {
          smoothedChaseDir
            .copy(carForward)
            .applyAxisAngle(carUp, Number.isFinite(lagRad) ? Math.sign(lagRad) * CHASE_MAX_LAG_RAD : 0);
        }
        smoothedChaseDir.normalize();

        const boostExtraDist = physics.telemetry.manualOverrideActive ? 0.24 : 0;
        const targetDist =
          5.25 +
          THREE.MathUtils.clamp(
            physics.telemetry.longitudinalG * 0.11,
            -0.22,
            0.26
          ) +
          boostExtraDist;
        smoothedCamDist = THREE.MathUtils.lerp(
          smoothedCamDist,
          targetDist,
          Math.min(1, dtSeconds * 12)
        );

        camera.position
          .copy(physics.worldPosition)
          .addScaledVector(smoothedChaseDir, -smoothedCamDist)
          .addScaledVector(
            carUp,
            1.78 + physics.rideHeightOffsetM * 0.5 + kerbShake
          );

        const horizonBlendedUp = new THREE.Vector3(0, 1, 0)
          .lerp(carUp, 0.55)
          .normalize();
        smoothedCamUp
          .lerp(horizonBlendedUp, Math.min(1, dtSeconds * 14))
          .normalize();
        camera.up.copy(smoothedCamUp);

        const targetApexLook = THREE.MathUtils.clamp(
          physics.yawRateRadS * 0.35,
          -0.45,
          0.45
        );
        smoothedApexLookYaw = THREE.MathUtils.lerp(
          smoothedApexLookYaw,
          targetApexLook,
          Math.min(1, dtSeconds * 8)
        );

        const lookDir = smoothedChaseDir.clone().lerp(carForward, 0.62).normalize();
        const lookPoint = physics.worldPosition
          .clone()
          .addScaledVector(lookDir, 14.5)
          .addScaledVector(carRight, -smoothedApexLookYaw)
          .addScaledVector(
            carUp,
            0.52 - physics.pitchRad * 3.2 + highSpeedBuffet
          );
        camera.lookAt(lookPoint);

        const boostFovKick = physics.telemetry.manualOverrideActive ? 3.5 : 0;
        camera.fov = THREE.MathUtils.lerp(
          camera.fov,
          56 + speedNorm * 11 + boostFovKick,
          Math.min(1, dtSeconds * 10)
        );
        camera.updateProjectionMatrix();
      } else if (mode === "tv_pod") {
        // Broadcast Roll-Hoop T-Cam mounted at front lens of T-Cam pod looking down over painted helmet #16, butterfly wheel + gloved hand, Halo arch, mirrors, wheel brows & nose cone
        camera.position
          .copy(physics.worldPosition)
          .addScaledVector(carForward, -0.06)
          .addScaledVector(carRight, -0.02 - physics.rollRad * 0.3)
          .addScaledVector(
            carUp,
            0.905 + physics.rideHeightOffsetM + kerbShake * 0.4
          );
        camera.up
          .copy(carUp)
          .addScaledVector(carRight, -physics.rollRad * 0.25)
          .normalize();
        camera.lookAt(
          physics.worldPosition
            .clone()
            .addScaledVector(carForward, 3.6)
            .addScaledVector(carRight, -physics.yawRateRadS * 0.12)
            .addScaledVector(
              carUp,
              0.22 - physics.pitchRad * 2.2 + highSpeedBuffet
            )
        );
        camera.fov = 60 + speedNorm * 5 + onboardFovShift;
        camera.updateProjectionMatrix();
      } else if (mode === "cockpit_shoulder") {
        // Reference Image 2: Left Over-the-Shoulder Cockpit Bolster Camera showing helmet on right, yellow gloved hand on butterfly steering wheel, Halo arch & left mirror/wheel brow
        camera.position
          .copy(physics.worldPosition)
          .addScaledVector(carForward, 0.06)
          .addScaledVector(carRight, -0.24 - physics.rollRad * 0.22)
          .addScaledVector(
            carUp,
            0.715 + physics.rideHeightOffsetM + kerbShake * 0.35
          );
        camera.up
          .copy(carUp)
          .addScaledVector(carRight, -physics.rollRad * 0.22)
          .normalize();
        camera.lookAt(
          physics.worldPosition
            .clone()
            .addScaledVector(carForward, 5.5)
            .addScaledVector(carRight, 0.13 - physics.yawRateRadS * 0.25)
            .addScaledVector(
              carUp,
              0.40 - physics.pitchRad * 2.8 + highSpeedBuffet
            )
        );
        camera.fov = 58 + speedNorm * 5 + onboardFovShift;
        camera.updateProjectionMatrix();
      } else if (mode === "cockpit") {
        // Reference Image 3: Driver Eye-Point Camera inside cockpit framing full Butterfly Steering Wheel OLED, Labeled Buttons, Rotary Dials, 3D Gloved Hands, Wing Mirrors & Wheel Brows under Halo
        camera.position
          .copy(physics.worldPosition)
          .addScaledVector(carForward, 0.21 - physics.pitchRad * 0.2)
          .addScaledVector(carRight, -physics.rollRad * 0.22)
          .addScaledVector(
            carUp,
            0.675 + physics.rideHeightOffsetM + kerbShake * 0.32
          );
        camera.up
          .copy(carUp)
          .addScaledVector(carRight, -physics.rollRad * 0.2)
          .normalize();
        camera.lookAt(
          physics.worldPosition
            .clone()
            .addScaledVector(carForward, 8.0)
            .addScaledVector(
              carUp,
              0.50 - physics.pitchRad * 3.5 + highSpeedBuffet
            )
            .addScaledVector(carRight, -physics.yawRateRadS * 0.3)
        );
        camera.fov = 62 + speedNorm * 4 + onboardFovShift;
        camera.updateProjectionMatrix();
      } else if (mode === "nose") {
        // Reference Image 4: Forward Nose-Cone Camera showing narrow Nose Tip, delicate Y-Pitot Probe, curved vertical Front Wing Endplates at bottom corners & 3D Dashed Braking Line
        camera.position
          .copy(physics.worldPosition)
          .addScaledVector(carForward, 1.66)
          .addScaledVector(
            carUp,
            0.455 + physics.rideHeightOffsetM + kerbShake * 0.32
          );
        camera.up.copy(carUp);
        camera.lookAt(
          physics.worldPosition
            .clone()
            .addScaledVector(carForward, 18.0)
            .addScaledVector(carUp, 0.25 - physics.pitchRad * 5.0)
        );
        camera.fov = 64 + speedNorm * 4;
        camera.updateProjectionMatrix();
      } else if (mode === "helicopter") {
        const heliTarget = physics.worldPosition
          .clone()
          .addScaledVector(carForward, -28)
          .add(new THREE.Vector3(14, 24, 14));
        if (smoothedHeliPos.distanceTo(heliTarget) > 80) {
          smoothedHeliPos.copy(heliTarget);
          smoothedHeliLook.copy(physics.worldPosition);
        } else {
          smoothedHeliPos.lerp(heliTarget, Math.min(1, dtSeconds * 6));
        }
        smoothedHeliLook.lerp(
          physics.worldPosition.clone().addScaledVector(carForward, 14),
          Math.min(1, dtSeconds * 12)
        );
        camera.position.copy(smoothedHeliPos);
        camera.up.set(0, 1, 0);
        camera.lookAt(smoothedHeliLook);
        camera.fov = 52;
        camera.updateProjectionMatrix();
      } else if (mode === "tv_side") {
        // Trackside broadcast: telephoto spline cameras that pan with the car and zoom in over kerbs
        const tv = tvDirector.update(
          dtSeconds,
          physics.worldPosition,
          physics.sMeters,
          carVelocityWorld,
          physics.telemetry.onKerbLeft || physics.telemetry.onKerbRight
        );
        camera.position.copy(tv.position);
        camera.up.set(0, 1, 0);
        camera.lookAt(tv.lookAt);
        camera.fov = tv.fovDeg;
        camera.updateProjectionMatrix();
      }

      if (inMenu) {
        // Attract camera: a slow telephoto orbit of the car on the grid (closer on the car-select step)
        const close = appPhase === "wizard" && wizardStepRef.current === "car";
        menuOrbitRad += dtSeconds * (close ? 0.2 : 0.08);
        const radius = close ? 6.2 : 9.5;
        const p = physics.worldPosition;
        camera.position.set(
          p.x + Math.sin(menuOrbitRad) * radius,
          p.y + (close ? 1.35 : 2.2),
          p.z + Math.cos(menuOrbitRad) * radius
        );
        camera.up.set(0, 1, 0);
        camera.lookAt(p.x, p.y + 0.55, p.z);
        camera.fov = close ? 36 : 32;
        // Push the car right of centre so the menu panel on the left does not cover it
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w >= 1024) camera.setViewOffset(w, h, -w * (close ? 0.2 : 0.16), 0, w, h);
        else camera.clearViewOffset();
        camera.updateProjectionMatrix();
        menuViewOffset = true;
      } else if (menuViewOffset) {
        camera.clearViewOffset();
        camera.updateProjectionMatrix();
        menuViewOffset = false;
      }

      builtCircuit.updateEnvironment(nowMs * 0.001);
      audioRef.current?.setCameraMode(mode);
      audioRef.current?.update(physics.telemetry, dtSeconds);

      // Nothing to draw behind the opaque loading screen (the shaders are compiled separately)
      if (appPhase === "loading") return;

      env.update(physics.worldPosition, camera);
      // Rear view into the mirrors' render target (cockpit only, every 2nd frame), then the main frame
      wingMirrors?.update(frameIndex++, mode === "cockpit", carRig.chassisGroup);
      postFx.render(dtSeconds);

      if (nowMs - lastHudSyncMs > 33) {
        lastHudSyncMs = nowMs;
        setTelemetry({
          ...physics.telemetry,
          tireTempsC: [...physics.telemetry.tireTempsC],
          brakeTempsC: [...physics.telemetry.brakeTempsC],
          wheelSlipRatios: [...physics.telemetry.wheelSlipRatios],
          wheelSlipAnglesDeg: [...physics.telemetry.wheelSlipAnglesDeg],
          wheelLoadsN: [...physics.telemetry.wheelLoadsN],
          wheelRideHeightsMm: [...physics.telemetry.wheelRideHeightsMm],
          suspensionTravelMm: [...physics.telemetry.suspensionTravelMm],
          tireWearPct: [...physics.telemetry.tireWearPct],
          tireGripFactor: [...physics.telemetry.tireGripFactor],
          wheelSurfaces: [...physics.telemetry.wheelSurfaces],
          peers: [...(physics.telemetry.peers ?? [])],
        });
      }
    };

    animFrameId = requestAnimationFrame(animate);

    return () => {
      disposed = true;
      unsubscribeAssets();
      window.clearInterval(assetWatchdog);
      swapCarRef.current = null;
      cancelAnimationFrame(animFrameId);
      haptics.stop();
      hapticsRef.current = null;
      wheelFfb.dispose();
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("resize", onResize);
      multiplayerSync.dispose();
      wheelDisplay?.dispose();
      wingMirrors?.dispose();
      postFx.dispose();
      env.dispose();
      renderer.dispose();
      audioRef.current?.dispose();
    };
  }, [track, unlockAudio, handleToggleMute, handleToggleRacingLine]);

  // Saved settings and the first-run flag are read after mount (the page is prerendered without
  // storage), once the scene effect above has created the car they apply to
  useEffect(() => {
    const saved = loadPlayerSettings();
    setSettings(saved);
    cockpitFovRef.current = saved.cockpitFovDeg;
    setOnboarded(loadOnboarded());
    handleAssistPresetChange(saved.assistPreset);
    setRacingLineVisible(saved.racingLine);
    setGamepadAssistEnabled(saved.gamepadAssist);
    setMouseSteer(saved.mouseSteer);
    const livery = LIVERIES.find((l) => l.id === saved.liveryId);
    if (livery) handleLiveryChange(livery);
    if (saved.camera) setCameraMode(saved.camera);
    setInviteRoom(roomFromUrl());
    setSettingsHydrated(true);
  }, [handleAssistPresetChange, setRacingLineVisible, setGamepadAssistEnabled, setMouseSteer, handleLiveryChange]);

  useEffect(() => {
    if (!settingsHydrated) return;
    savePlayerSettings({
      ...settings,
      assistPreset,
      racingLine: showRacingLine,
      gamepadAssist,
      mouseSteer: mouseSteerEnabled,
      liveryId: selectedLivery.id,
      camera: cameraMode,
    });
  }, [settingsHydrated, settings, assistPreset, showRacingLine, gamepadAssist, mouseSteerEnabled, selectedLivery, cameraMode]);

  /** The pause menu's controls list, from the player's bindings */
  const controlsCheatSheet = useMemo(() => {
    const keys = (codes: string[]) => codes.map(keyLabel).join(" · ") || "—";
    const k = settings.keys;
    const rows: [string, string][] = [
      ["Throttle / brake", `${keys(k.throttle)} / ${keys(k.brake)}`],
      ["Steer", `${keys(k.steerLeft)} / ${keys(k.steerRight)}`],
      ["Boost (manual override)", `${keys(k.boostHold)} · ${keys(k.boostLatch)}`],
      ["Active aero X / Z", keys(k.aero)],
      ["Gear up / down", `${keys(k.shiftUp)} / ${keys(k.shiftDown)}`],
      ["Camera", keys(k.camera)],
      ["Cockpit FOV", "[ / ]"],
      ["Racing line", keys(k.racingLine)],
      ["Restart", keys(k.restart)],
    ];
    const pb = settings.padButtons;
    rows.push([
      "Pad",
      `RT / LT · stick · ${padButtonLabel(pb.boost)} boost · ${padButtonLabel(pb.shiftUp)}/${padButtonLabel(pb.shiftDown)} gears`,
    ]);
    return rows;
  }, [settings.keys, settings.padButtons]);

  const keyNames = useMemo(() => {
    const first = (codes: string[]) => (codes[0] ? keyLabel(codes[0]) : "—");
    const k = settings.keys;
    return {
      camera: first(k.camera),
      racingLine: first(k.racingLine),
      mute: first(k.mute),
      mouseSteer: first(k.mouseSteer),
      autopilot: first(k.autopilot),
      restart: first(k.restart),
    };
  }, [settings.keys]);

  const launchHintText =
    settings.device === "wheel"
      ? "Press the throttle to launch · pause button or Esc for menu"
      : settings.device === "controller"
        ? `Hold RT to launch · ${padButtonLabel(settings.padButtons.pause)} for menu`
        : `Hold ${keyLabel(settings.keys.throttle[0])} to launch · Esc for menu`;

  const menuProps = {
    telemetry,
    aeroPreset,
    assistPreset,
    cameraMode,
    tireCompound,
    selectedLivery,
    showRacingLine,
    isMuted,
    mouseSteerEnabled,
    gamepadAssist,
    gamepadRumble,
    aiOpponents,
    onToggleAiOpponents: handleToggleAiOpponents,
    vehicleModel,
    onChangeVehicle: handleChangeVehicle,
    onToggleGamepadAssist: handleToggleGamepadAssist,
    onToggleGamepadRumble: handleToggleGamepadRumble,
    p2pStatus,
    onChangeAeroPreset: handleAeroPresetChange,
    onChangeAssistPreset: handleAssistPresetChange,
    onChangeTireCompound: handleTireCompoundChange,
    tyreSetup,
    defaultTyreSetup,
    onChangeTyreSetup: handleChangeTyreSetup,
    onChangeLivery: handleLiveryChange,
    onToggleRacingLine: handleToggleRacingLine,
    onToggleMute: handleToggleMute,
    onToggleAiAutopilot: handleToggleAiAutopilot,
    onToggleMouseSteer: handleToggleMouseSteer,
    onResetCar: handleResetCar,
    onSelectTurn: handleSelectTurn,
    onHostP2PRoom: handleHostP2PRoom,
    onJoinP2PRoom: handleJoinP2PRoom,
    onCreateManualOffer: handleCreateManualOffer,
    onAcceptManualOffer: handleAcceptManualOffer,
    onAcceptManualAnswer: handleAcceptManualAnswer,
    onTogglePause: togglePause,
    keyNames,
  };

  return (
    <div
      className="relative h-screen w-screen overflow-hidden bg-[#0B0B10] supports-[height:100dvh]:h-dvh"
      onPointerDown={() => {
        if (phaseRef.current !== "loading") unlockAudio();
      }}
    >
      <div ref={containerRef} className="h-full w-full" />

      {phase === "driving" ? (
        <F1TelemetryHud
          {...menuProps}
          track={track}
          boostLatch={boostLatch}
          showLaunchHint={launchHint}
          launchHintText={launchHintText}
          wheelUncalibrated={
            settings.device === "wheel" && (!settings.wheel.throttle || !settings.wheel.brake)
          }
          onChangeCameraMode={setCameraMode}
          cockpitFovDeg={settings.cockpitFovDeg}
          cockpitFovDefaultDeg={carCockpitFov}
          onChangeCockpitFov={handleCockpitFovChange}
          onToggleXMode={handleToggleXMode}
          onToggleBoostLatch={handleToggleBoostLatch}
          paused={paused}
          onOpenControls={() => openControls("pause")}
          onExitToTitle={exitToTitle}
          controlsCheatSheet={controlsCheatSheet}
        />
      ) : null}

      {phase === "title" ? (
        <TitleMenu
          {...menuProps}
          onCycleCamera={() => setCameraMode(nextCameraMode(cameraMode))}
          initialRoomCode={inviteRoom ?? ""}
          initialPanel={inviteRoom ? "multiplayer" : null}
          firstRun={!onboarded}
          onDrive={() => handleTitleStart(false)}
          onRaceAi={() => handleTitleStart(true)}
          onControls={() => openControls("title")}
        />
      ) : null}

      {phase === "wizard" ? (
        <FirstRunWizard
          mode={wizardMode}
          settings={settings}
          onChangeSettings={handleChangeSettings}
          vehicleModel={vehicleModel}
          onChangeVehicle={handleChangeVehicle}
          selectedLivery={selectedLivery}
          onChangeLivery={handleLiveryChange}
          assistPreset={assistPreset}
          onChangeAssistPreset={handleAssistPresetChange}
          showRacingLine={showRacingLine}
          onSetRacingLine={setRacingLineVisible}
          gamepadAssist={gamepadAssist}
          onSetGamepadAssist={setGamepadAssistEnabled}
          gamepadRumble={gamepadRumble}
          onToggleGamepadRumble={handleToggleGamepadRumble}
          mouseSteerEnabled={mouseSteerEnabled}
          onSetMouseSteer={setMouseSteer}
          cameraMode={cameraMode}
          onChangeCameraMode={setCameraMode}
          onFinish={finishWizard}
          onExit={leaveWizard}
          onSkip={wizardMode === "first-run" ? finishWizard : undefined}
          onStepChange={handleWizardStep}
        />
      ) : null}

      {loadingVisible ? (
        <LoadingScreen track={track} ready={assetsReady} onStart={handleLoadingStart} onDone={handleLoadingDone} />
      ) : null}
    </div>
  );
};
