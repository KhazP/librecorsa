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
import { createPortedCarRig } from "@/lib/ported-car-model";
import { createAmgGt3Sim } from "@/lib/sim/gt3/AmgGt3Sim";
import { AMG_GT3_CONFIG } from "@/lib/sim/gt3/AmgGt3Config";
import { F12026_CAR_CONFIG } from "@/lib/sim/f12026-car/F12026CarConfig";
import type { CarSoundSource } from "@/lib/sim/CarAudio";
import { CARS, carById, carForVehicle, isCarId, type CarId } from "@/lib/cars/car-registry";
import { buildRwandaCircuitScene } from "@/lib/scene-builder";
import {
  configureRenderer,
  createGoldenHourEnvironment,
  createPostFx,
} from "@/lib/render/golden-hour-environment";
import { SteeringWheelDisplay } from "@/lib/render/steering-display";
import { WingMirrors } from "@/lib/render/wing-mirrors";
import { VirtualMirror } from "@/lib/render/virtual-mirror";
import { type ChassisSetup, DEFAULT_CHASSIS_SETUP, loadChassisSetup, saveChassisSetup } from "@/lib/sim/car-setup";
import { CockpitMicroShake, TracksideBroadcastDirector } from "@/lib/render/camera-rig";
import { LapDeltaTracker } from "@/lib/sim/lap-delta";
import { TrackLimitsMonitor } from "@/lib/sim/track-limits";
import { SimVisualFxManager } from "@/lib/sim/visual-fx";
import { AiOpponentField, AI_DRIVERS, resolvePlayerVsRemoteCar } from "@/lib/sim/ai-opponents";
import { peerWakeEmitters, TrackEnvironment } from "@/lib/sim/track-environment";
import type { WakeEmitterCar } from "@/lib/sim/aero-wake";
import { GamepadHaptics } from "@/lib/sim/gamepad-haptics";
import {
  getMultiplayerManager,
  type CarClassRule,
  type InterpolatedPeerState,
  type LobbySettings,
  type LobbyState,
  type MultiplayerSyncManager,
  type P2PConnectionStatus,
  type PeerNetStats,
  type RaceStartInfo,
} from "@/lib/sim/multiplayer-sync";
import { MultiplayerRace } from "@/lib/sim/race-session";
import { GhostPlayer, LapRecorder } from "@/lib/sim/lap-recorder";
import { ReplayBuffer } from "@/lib/sim/replay-buffer";
import type { LapRecording, LapSummaryData, LeaderboardEntry, ReplayCarState } from "@/lib/sim/lap-types";
import { exportLapFile, importLapFile, loadBestLap, saveBestLapIfFaster } from "@/lib/sim/ghost-store";
import {
  fetchRemoteGhost,
  fetchRemoteLeaderboard,
  localLeaderboard,
  remoteLeaderboardEnabled,
  submitLap,
} from "@/lib/net/leaderboard";
import { exportDriverKeyFile, importDriverKeyFile } from "@/lib/net/driver-key";
import { buildTelemetryPacket } from "@/lib/input/telemetry-out";
import { touchInput, isTouchDevice, resetTouchInput } from "@/lib/input/touch-input";
import { isFatalHidStatus } from "@/lib/input/webhid-ffb";
import { applyGraphicsQuality } from "@/lib/render/golden-hour-environment";
import { createRainFx } from "@/lib/render/rain-fx";
import { setAsphaltWetness } from "@/lib/render/asphalt-sheen";
import { SIM_REALISM_FLAGS, type SimRealism } from "@/lib/sim/sim-realism";
import {
  recommendedCompound,
  SLICK_TRAITS,
  WET_TYRE_TRAITS,
  wetGripFactor,
  wetnessFromWater,
} from "@/lib/sim/wet-tyres";
import type { SessionConditions } from "@/lib/sim/weather";
import type { WeatherHudState } from "@/components/hud/WeatherBadge";
import { TURN_METADATA } from "@/lib/track-data";
import { getTrackInfo } from "@/lib/track-registry";
import { TouchControls } from "@/components/hud/TouchControls";
import { ReplayBar } from "@/components/hud/ReplayBar";
import { F1TelemetryHud, roomFromUrl } from "@/components/F1TelemetryHud";
import { CAMERA_LABELS, nextCameraMode, TYRE_SETUP_LIMITS } from "@/components/hud/PauseMenu";
import { LoadingScreen } from "@/components/menu/LoadingScreen";
import { TitleMenu } from "@/components/menu/TitleMenu";
import { FirstRunWizard, type WizardMode, type WizardStepId } from "@/components/menu/FirstRunWizard";
import { assetProgress } from "@/lib/loading/asset-progress";
import { buildKeyLookup, HUD_TOGGLE_EVENT, keyLabel, padButtonLabel, type KeyAction } from "@/lib/input/bindings";
import { carWheelLockDeg, connectedPads, DeviceInputReader } from "@/lib/input/device-input";
import { webHidFfb, wheelFfb } from "@/lib/input/wheel-ffb";
import { DEFAULT_GAMEPAD_ASSIST, type GamepadAssistSettings } from "@/lib/sim/gamepad-assist";
import {
  clampFov,
  codeFromName,
  DEFAULT_PLAYER_SETTINGS,
  loadOnboarded,
  loadPlayerSettings,
  saveOnboarded,
  sanitizeDriverName,
  savePlayerSettings,
  type PlayerSettings,
} from "@/lib/settings/player-settings";
import type {
  AeroSetupPreset,
  AssistPreset,
  CameraMode,
  CarTelemetry,
  LiveTunerPatch,
  LiveryConfig,
  RadarBlip,
  TireCompound,
  TyreSetup,
  VehicleModelId,
} from "@/types/f1";

/** Matches the aero package the track's target speeds / braking markers are computed for */
const DEFAULT_AERO_PRESET: AeroSetupPreset = "balanced";
const DEFAULT_ASSIST_PRESET: AssistPreset = "semi_pro";

// Keyboard-only input shaping: a key press becomes a pedal squeeze, not a step
/** A replay / flashback opens this far before the present, paused (s) */
const REPLAY_OPEN_BACK_S = 3;
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
const HELD_KEY_ACTIONS: ReadonlySet<KeyAction> = new Set(["throttle", "brake", "steerLeft", "steerRight", "boostHold", "throttleHalf"]);

/** Rear slip ratio where the keyboard exit assist starts to hold the throttle back */
const KB_EXIT_ASSIST_SLIP = 0.1;
/** Telemetry-out rate (Hz) */
const TELEMETRY_OUT_HZ = 60;
/** Rev limit for the telemetry-out packet's rpm bar */
const MAX_RPM: Record<VehicleModelId, number> = { vf26: 15000, "f12026-car": 15000, "amg-gt3": 8250 };
/** Rev limiter of each car (rpm): the shift beep sounds 150 rpm short of it */
const LIMITER_RPM: Record<VehicleModelId, number> = { vf26: 12500, "f12026-car": 13050, "amg-gt3": 7900 };
/** A lap record's car: records are per vehicle model, named after its first car */
const vehicleLabel = (id: string) => CARS.find((c) => c.physics === id)?.title ?? id;

/** A race the host started on another circuit: picked up after the scene for that circuit has loaded */
let pendingRaceStart: RaceStartInfo | null = null;

/** Applies an outer dead zone and a response curve to a stick that already had its inner dead zone */
function shapeStick(x: number, outerDeadzone: number, linearity: number): number {
  const mag = Math.min(1, Math.abs(x) / Math.max(0.5, 1 - outerDeadzone));
  return Math.sign(x) * Math.pow(mag, linearity);
}

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

/** The sound bank each car plays (the F1 cars share one bank) */
const soundFor = (car: CarId): CarSoundSource => carById(car).sound;

/** The car to drive: `?car=` in the URL, else the last choice, else the VF26 */
function loadStoredCar(): CarId {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("car");
    if (isCarId(fromUrl)) return fromUrl;
    const saved = localStorage.getItem(VEHICLE_STORAGE_KEY);
    return isCarId(saved) ? saved : "vf26";
  } catch {
    return "vf26";
  }
}

function saveCar(car: CarId) {
  try {
    localStorage.setItem(VEHICLE_STORAGE_KEY, car);
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

export interface LibreCorsaSimulatorProps {
  /** Active circuit (already set with `setActiveTrack`; the gate remounts this component on a change) */
  trackId?: string;
  /** Title menu circuit picker */
  onSelectTrack?: (id: string) => void;
}

export const LibreCorsaSimulator: React.FC<LibreCorsaSimulatorProps> = ({ trackId = "rwanda", onSelectTrack }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const track = useMemo(() => getRwandaTrackData(1200), []);
  /** The player's car: the VF26 (F1Physics2026) or the f12026-car (F12026CarSim) */
  const physicsRef = useRef<SimulatorCar | null>(null);
  /** The chosen car, and the vehicle model it drives on */
  const [carId, setCarId] = useState<CarId>(loadStoredCar);
  const carIdRef = useRef(carId);
  const [vehicleModel, setVehicleModel] = useState<VehicleModelId>(() => carById(carId).physics);
  const vehicleModelRef = useRef(vehicleModel);
  /** Swaps the player's car in the running scene (set by the scene effect) */
  const swapCarRef = useRef<((car: CarId) => void) | null>(null);
  const audioRef = useRef<F1AudioEngine2026 | null>(null);
  const carRigRef = useRef<SimCarRig | null>(null);
  const liveryRef = useRef<LiveryConfig>(LIVERIES[0]);
  const racingLineMeshRef = useRef<THREE.Mesh | null>(null);
  const multiplayerRef = useRef<MultiplayerSyncManager | null>(null);
  /** The AI race field while "AI opponents" is enabled */
  const aiFieldRef = useRef<AiOpponentField | null>(null);
  /** Track evolution and aero wake for every car on the circuit (the player's in every mode); an AI field shares it */
  const trackEnvRef = useRef<TrackEnvironment | null>(null);
  const getTrackEnv = useCallback(
    () => (trackEnvRef.current ??= new TrackEnvironment(track, settingsRef.current.conditions)),
    [track]
  );
  /** Air / track temperature and wetness for the HUD badge and the conditions panel (sampled twice a second) */
  const [weatherHud, setWeatherHud] = useState<WeatherHudState | null>(null);
  /** The player car's dry autopilot pace, which the weather scales each frame */
  const autopilotPaceRef = useRef<{ car: unknown; pace: number }>({ car: null, pace: 1 });

  const [virtualMirrorOn, setVirtualMirrorOn] = useState(false);
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
  const [chassisSetup, setChassisSetup] = useState<ChassisSetup>(DEFAULT_CHASSIS_SETUP);
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
      steeringRate: settings.padTuning.steeringRate,
      deadzone: settings.padTuning.deadzone,
    }),
    [settings.padTuning.steeringRate, settings.padTuning.deadzone]
  );
  const [p2pStatus, setP2pStatus] = useState<P2PConnectionStatus>({
    mode: "local",
    roomCode: "",
    state: "idle",
    connectedWebRtcPeers: 0,
    statusText: "BroadcastChannel Active (Same-Browser) • Ready for WebRTC P2P",
  });

  // ---- Multiplayer lobby and races
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [peerStats, setPeerStats] = useState<PeerNetStats[]>([]);
  /** The multiplayer race in progress (this client's view of it) */
  const mpRaceRef = useRef<MultiplayerRace | null>(null);
  const [mpRaceRunning, setMpRaceRunning] = useState(false);
  /** The results card was closed for this race */
  const [resultsClosed, setResultsClosed] = useState(false);

  // ---- Laps, ghosts, leaderboards
  const lapRecorderRef = useRef<LapRecorder | null>(null);
  const [lapSummary, setLapSummary] = useState<{ summary: LapSummaryData; recording: LapRecording } | null>(null);
  const [submitState, setSubmitState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [submitRank, setSubmitRank] = useState<number | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [driverKeyNotice, setDriverKeyNotice] = useState<string | null>(null);
  /** Ghost being raced: the personal best (default) or a downloaded / imported lap */
  const ghostRef = useRef<GhostPlayer | null>(null);
  const ghostSourceRef = useRef<"pb" | "other">("pb");
  const [leaderboard, setLeaderboard] = useState<{ local: LeaderboardEntry[]; remote: LeaderboardEntry[]; loading: boolean }>({
    local: [],
    remote: [],
    loading: false,
  });

  // ---- Instant replay
  const replayRef = useRef({ buffer: new ReplayBuffer({ maxSeconds: 90, hz: 30 }), active: false, playing: true, timeS: 0, speed: 1 });
  const [replayUi, setReplayUi] = useState<{ active: boolean; timeS: number; startS: number; endS: number; playing: boolean; speed: number }>({
    active: false,
    timeS: 0,
    startS: 0,
    endS: 0,
    playing: true,
    speed: 1,
  });

  // ---- VR, FFB meter
  const [vrSupported, setVrSupported] = useState(false);
  const [vrActive, setVrActive] = useState(false);
  const enterVrRef = useRef<(() => void) | null>(null);
  const [ffbMeter, setFfbMeter] = useState(wheelFfb.meter);
  const [touchVisible, setTouchVisible] = useState(false);
  const vrActiveRef = useRef(false);
  vrActiveRef.current = vrActive;
  /** Applies the graphics preset to the running renderer (set by the scene effect) */
  const applyGraphicsRef = useRef<((quality: "low" | "medium" | "high", renderScale: number) => void) | null>(null);
  /** Enters / leaves / flashbacks the instant replay (set by the scene effect) */
  const toggleReplayRef = useRef<() => void>(() => {});
  const exitReplayRef = useRef<() => void>(() => {});
  const flashbackReplayRef = useRef<() => void>(() => {});

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
    half: boolean;
  }>({
    up: false,
    down: false,
    left: false,
    right: false,
    boostHold: false,
    shiftUp: false,
    shiftDown: false,
    toggleX: false,
    half: false,
  });
  /** Shaped keyboard inputs (pedals 0..1, steering -1..1, + = right) */
  const kbInputRef = useRef({ throttle: 0, brake: 0, steer: 0 });

  // Read through a ref so unlockAudio stays stable: the scene effect depends on it and must not rebuild on mute
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;
  const unlockAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new F1AudioEngine2026();
      audioRef.current.setCar(soundFor(carIdRef.current));
    }
    audioRef.current.setPaused(pausedRef.current || phaseRef.current !== "driving");
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

  const handleChangeChassisSetup = useCallback((next: ChassisSetup) => {
    setChassisSetup(next);
    physicsRef.current?.applyChassisSetup?.(next);
    saveChassisSetup(vehicleModelRef.current, next);
  }, []);

  const handleChangeCar = useCallback(
    (next: CarId) => {
      unlockAudio();
      if (next === carIdRef.current) return;
      carIdRef.current = next;
      setCarId(next);
      vehicleModelRef.current = carById(next).physics;
      setVehicleModel(vehicleModelRef.current);
      saveCar(next);
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

  const handleChangeLiveTuner = useCallback((patch: LiveTunerPatch) => {
    const car = physicsRef.current;
    if (!car) return;
    car.setLiveTuner?.(patch);
    const updated = car.getLiveTunerState?.() ?? car.telemetry.liveTuner;
    if (updated) {
      setTelemetry((prev) => ({
        ...prev,
        liveTuner: { ...updated },
      }));
    }
  }, []);

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
      // In a multiplayer race only the host can restart it (for everyone); others keep their place
      if (mpRaceRef.current) {
        if (getMultiplayerManager().isHost && !flyingStart) getMultiplayerManager().startRace();
        return;
      }
      if (physicsRef.current) {
        physicsRef.current.aiAutopilot = false;
        lapRecorderRef.current?.reset();
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
    const field = new AiOpponentField(track, physics, AI_DRIVERS, getTrackEnv(), { skill: settingsRef.current.aiSkill });
    field.startRace(true);
    aiFieldRef.current = field;
    setAiOpponents(true);
  }, [track, getTrackEnv, unlockAudio]);

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

  const handleHostLocal = useCallback(() => getMultiplayerManager().hostLocal(), []);
  const handleSetLobbySettings = useCallback((patch: Partial<LobbySettings>) => getMultiplayerManager().setLobbySettings(patch), []);
  const handleSetReady = useCallback((ready: boolean) => getMultiplayerManager().setReady(ready), []);
  const handleStartMpRace = useCallback(() => {
    getMultiplayerManager().startRace();
  }, []);
  const handleAbortMpRace = useCallback(() => getMultiplayerManager().abortRace(), []);
  const vehiclesForClass = useCallback(
    (rule: CarClassRule): string[] =>
      rule === "f1" ? ["vf26", "f12026-car"] : rule === "gt3" ? ["amg-gt3"] : ["vf26", "f12026-car", "amg-gt3"],
    []
  );

  /** Esc / pad Menu: open or close the pause menu, releasing every held key */
  const togglePause = useCallback(() => {
    setPaused((prev) => {
      const next = !prev;
      pausedRef.current = next;
      audioRef.current?.setPaused(next);
      if (next) {
        wheelFfb.stop();
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

  /** AI opponents' level: saved, and a running field drives to it at once */
  const handleChangeAiSkill = useCallback((aiSkill: number) => {
    setSettings((prev) => ({ ...prev, aiSkill }));
    aiFieldRef.current?.setSkill(aiSkill);
  }, []);

  /** Weather and time of day: saved, and the session on track switches to them (the weather starts over) */
  const handleChangeConditions = useCallback((conditions: SessionConditions) => {
    setSettings((prev) => ({ ...prev, conditions }));
  }, []);
  /** Simulation realism: saved, and every car on track takes it on its next step */
  const handleChangeRealism = useCallback((realism: SimRealism) => {
    setSettings((prev) => ({ ...prev, realism }));
  }, []);
  const conditionsKey = JSON.stringify(settings.conditions);
  useEffect(() => {
    const env = getTrackEnv();
    const next = settingsRef.current.conditions;
    if (JSON.stringify(env.weather.conditions) !== JSON.stringify(next)) {
      env.setConditions(next);
      const autoCompound = recommendedCompound(env.weather.lineWaterMm, "soft");
      if (physicsRef.current && physicsRef.current.tireCompound !== autoCompound) {
        physicsRef.current.tireCompound = autoCompound;
        setTireCompound(autoCompound);
        carRigRef.current?.setTireCompound(autoCompound);
      }
    }
  }, [conditionsKey, getTrackEnv]);
  useEffect(() => {
    getTrackEnv().setSimRealism(SIM_REALISM_FLAGS[settings.realism]);
  }, [settings.realism, getTrackEnv]);

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
          if (!aiFieldRef.current) aiFieldRef.current = new AiOpponentField(track, physics, AI_DRIVERS, getTrackEnv(), { skill: settingsRef.current.aiSkill });
          aiFieldRef.current.startRace(true);
        } else {
          aiFieldRef.current = null;
          physics.resetToStartGrid(false);
        }
      }
      setAiOpponents(race);
      setResultsClosed(false);
      lapRecorderRef.current?.reset();
      kbInputRef.current.throttle = 0;
      kbInputRef.current.brake = 0;
      kbInputRef.current.steer = 0;
      pausedRef.current = false;
      setPaused(false);
      audioRef.current?.setPaused(false);
      setLaunchHint(true);
      setPhase("driving");
    },
    [track, getTrackEnv, setPhase]
  );

  /** A multiplayer race was started (by us as host, or by the host): line up in our grid slot behind the lights */
  const startMpRace = useCallback(
    (start: RaceStartInfo) => {
      const mp = getMultiplayerManager();
      // The class may rule out the current car: take the first allowed one
      const allowed = vehiclesForClass(start.carClass) as VehicleModelId[];
      if (!allowed.includes(vehicleModelRef.current)) handleChangeCar(carForVehicle(allowed[0]).id);
      exitReplayRef.current();
      const physics = physicsRef.current;
      const roster = mp.lobby?.players ?? [];
      const profile = settingsRef.current.profile;
      const race = new MultiplayerRace(start, track.totalLengthM, mp.localPeerId, profile, roster);
      mpRaceRef.current = race;
      aiFieldRef.current = null;
      getTrackEnv().reset();
      setAiOpponents(false);
      if (physics) {
        physics.aiAutopilot = false;
        physics.resetToStartGrid(false, race.gridSlot);
        race.lapClock.reset(physics.sMeters);
      }
      lapRecorderRef.current?.reset();
      replayRef.current.buffer.clear();
      kbInputRef.current.throttle = 0;
      kbInputRef.current.brake = 0;
      kbInputRef.current.steer = 0;
      pausedRef.current = false;
      setPaused(false);
      audioRef.current?.setPaused(false);
      setResultsClosed(false);
      setMpRaceRunning(true);
      setPhase("driving");
    },
    [track, getTrackEnv, setPhase, vehiclesForClass, handleChangeCar]
  );
  const startMpRaceRef = useRef(startMpRace);
  startMpRaceRef.current = startMpRace;

  const leaveMpRace = useCallback(() => {
    mpRaceRef.current = null;
    setMpRaceRunning(false);
    setResultsClosed(false);
  }, []);

  // ---- Laps, ghosts, leaderboards
  const refreshLeaderboard = useCallback(async () => {
    setLeaderboard((l) => ({ ...l, loading: true }));
    const vehicle = vehicleModelRef.current;
    const [local, remote] = await Promise.all([
      localLeaderboard(trackId, vehicle).catch((): LeaderboardEntry[] => []),
      remoteLeaderboardEnabled
        ? fetchRemoteLeaderboard(trackId, vehicle).catch((): LeaderboardEntry[] => [])
        : Promise.resolve<LeaderboardEntry[]>([]),
    ]);
    setLeaderboard({ local, remote, loading: false });
  }, [trackId]);

  /** Races the personal best of this car as the ghost (force: also when another lap was chosen) */
  const loadPbGhost = useCallback(
    async (force: boolean) => {
      if (!force && ghostSourceRef.current !== "pb") return;
      const rec = await loadBestLap(trackId, vehicleModelRef.current).catch(() => null);
      ghostSourceRef.current = "pb";
      ghostRef.current = rec ? new GhostPlayer(rec) : null;
      lapRecorderRef.current?.setContext({ personalBestMs: rec?.lapTimeMs ?? null });
    },
    [trackId]
  );

  const onLapCompleted = useCallback(
    (summary: LapSummaryData, recording: LapRecording) => {
      if (settingsRef.current.hud.lapSummary) {
        setLapSummary({ summary, recording });
        setSubmitState("idle");
        setSubmitRank(null);
        setSubmitError(null);
      }
      if (!summary.valid) return;
      void saveBestLapIfFaster(recording)
        .then((saved) => {
          if (!saved) return;
          if (ghostSourceRef.current === "pb") ghostRef.current = new GhostPlayer(recording);
          void refreshLeaderboard();
        })
        .catch(() => {});
    },
    [refreshLeaderboard]
  );
  const onLapCompletedRef = useRef(onLapCompleted);
  onLapCompletedRef.current = onLapCompleted;

  /**
   * Uploads the shown lap. `name` comes from the lap card's name prompt (first upload under a generated
   * name): it becomes the player's own name, and the lap goes up under it rather than the one it was recorded with.
   */
  const handleSubmitLap = useCallback(async (name?: string) => {
    const recorded = lapSummary?.recording;
    if (!recorded) return;
    let rec = recorded;
    if (name !== undefined) {
      const profile = settingsRef.current.profile;
      const clean = sanitizeDriverName(name);
      // A code the game derived from the generated name follows the new name; one the player set stays
      const code = profile.generated && clean !== profile.name ? codeFromName(clean) : profile.code;
      setSettings((prev) => ({ ...prev, profile: { ...prev.profile, name: clean, code, generated: false } }));
      rec = { ...recorded, driverName: clean, driverCode: code };
    }
    setSubmitState("sending");
    const res = await submitLap(rec).catch((): { ok: boolean; rank?: number; error?: string } => ({ ok: false }));
    setSubmitState(res.ok ? "sent" : "error");
    setSubmitRank(res.ok ? (res.rank ?? null) : null);
    setSubmitError(res.ok ? null : (res.error ?? null));
    if (res.ok) void refreshLeaderboard();
  }, [lapSummary, refreshLeaderboard]);

  /** Uses a lap from the leaderboard (or a file) as the ghost */
  const raceGhost = useCallback((rec: LapRecording | null) => {
    if (!rec) return;
    ghostRef.current = new GhostPlayer(rec);
    ghostSourceRef.current = "other";
    setSettings((prev) => (prev.ghost ? prev : { ...prev, ghost: true }));
  }, []);

  const handleRaceGhostEntry = useCallback(
    async (entry: LeaderboardEntry) => {
      const rec =
        entry.source === "remote" && entry.id
          ? await fetchRemoteGhost(entry.id).catch(() => null)
          : await loadBestLap(entry.trackId, entry.vehicle).catch(() => null);
      raceGhost(rec);
    },
    [raceGhost]
  );

  const handleImportGhost = useCallback(
    async (file: File) => {
      const rec = await importLapFile(file).catch(() => null);
      if (rec && rec.trackId === trackId) raceGhost(rec);
    },
    [raceGhost, trackId]
  );

  const handleExportDriverKey = useCallback(() => {
    setDriverKeyNotice(
      exportDriverKeyFile(settingsRef.current.profile.name)
        ? "Key saved. Anyone with the file can post as you."
        : "No key yet: your first upload creates it."
    );
  }, []);

  const handleImportDriverKey = useCallback(async (file: File) => {
    const res = await importDriverKeyFile(file);
    setDriverKeyNotice(res.ok ? `Key imported${res.name ? ` for ${res.name}` : ""}. Uploads from here use it.` : res.error);
  }, []);

  const handleExportBest = useCallback(async () => {
    const rec = await loadBestLap(trackId, vehicleModelRef.current).catch(() => null);
    if (rec) exportLapFile(rec);
  }, [trackId]);

  // ---- Instant replay transport
  const handleReplayTogglePlay = useCallback(() => {
    const rp = replayRef.current;
    if (!rp.playing && rp.timeS >= rp.buffer.endS - 0.05) rp.timeS = rp.buffer.startS;
    rp.playing = !rp.playing;
    setReplayUi((u) => ({ ...u, playing: rp.playing, timeS: rp.timeS }));
  }, []);
  const handleReplaySeek = useCallback((tS: number) => {
    replayRef.current.timeS = tS;
    setReplayUi((u) => ({ ...u, timeS: tS }));
  }, []);
  const handleReplaySpeed = useCallback((speed: number) => {
    replayRef.current.speed = speed;
    setReplayUi((u) => ({ ...u, speed }));
  }, []);

  // ---- Wheel force meter
  const handleApplySuggestedGain = useCallback(() => {
    const gain = wheelFfb.meter.suggestedGain;
    if (gain === null) return;
    const vehicle = vehicleModelRef.current;
    setSettings((prev) => ({
      ...prev,
      wheel: {
        ...prev.wheel,
        ffbPerCar: {
          ...prev.wheel.ffbPerCar,
          [vehicle]: { gain, minForce: prev.wheel.ffbPerCar?.[vehicle]?.minForce ?? prev.wheel.ffbMinForce },
        },
      },
    }));
    wheelFfb.resetMeter();
  }, []);

  const [localPeerId, setLocalPeerId] = useState("");
  const [titleInitialPanel, setTitleInitialPanel] = useState<"multiplayer" | null>(null);
  const handleBackToLobby = useCallback(() => {
    leaveMpRace();
    setTitleInitialPanel("multiplayer");
    exitToTitleRef.current();
  }, [leaveMpRace]);
  const exitToTitleRef = useRef<() => void>(() => {});

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
    exitReplayRef.current();
    mpRaceRef.current = null;
    setMpRaceRunning(false);
    aiFieldRef.current = null;
    setAiOpponents(false);
    physicsRef.current?.resetToStartGrid(false);
    pausedRef.current = false;
    setPaused(false);
    audioRef.current?.setPaused(true);
    setPhase("title");
  }, [setPhase]);
  exitToTitleRef.current = exitToTitle;

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

  // Silence the car audio, pad rumble, and FFB as soon as the pause menu opens or the car is left for the menus
  useEffect(() => {
    const silence = paused || phase !== "driving";
    audioRef.current?.setPaused(silence);
    if (silence) {
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
      } else {
        const autoCompound = recommendedCompound(getTrackEnv().weather.lineWaterMm, "soft");
        car.tireCompound = autoCompound;
        setTireCompound(autoCompound);
      }
      car.resetToStartGrid(false);

      // Capture the car's defaults first, then apply its saved tyre setup (if any)
      const tyreDefaults = car.getTyreSetup();
      const initialTyreSetup = loadStoredTyreSetup(vehicle) ?? tyreDefaults;
      car.setTyreSetup(initialTyreSetup);
      setDefaultTyreSetup(tyreDefaults);
      setTyreSetup(initialTyreSetup);
      // and its garage chassis setup
      const chassis = loadChassisSetup(vehicle);
      car.applyChassisSetup?.(chassis);
      setChassisSetup(chassis);
      return car;
    };

    let physics = createCar(vehicleModelRef.current, null);
    physicsRef.current = physics;

    swapCarRef.current = (car) => {
      const vehicle = carById(car).physics;
      physics = createCar(vehicle, physics);
      physicsRef.current = physics;
      swapCarRig(car);
      kbInputRef.current.throttle = 0;
      kbInputRef.current.brake = 0;
      kbInputRef.current.steer = 0;
      lapRecorderRef.current?.setContext({ vehicle });
      lapRecorderRef.current?.reset();
      // A running race restarts from the lights with the new car
      if (aiFieldRef.current) {
        const field = new AiOpponentField(track, physics, AI_DRIVERS, getTrackEnv(), { skill: settingsRef.current.aiSkill });
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
    // Rain streaks around the camera (one GPU-animated draw, hidden in the dry)
    const rainFx = createRainFx(scene);
    // Scene render + one merged effect pass (mipmap bloom, then AgX tone mapping)
    const postFx = createPostFx(renderer, scene, camera);
    // Top-centre virtual rear-view mirror for the views without wing mirrors in shot
    const virtualMirror = new VirtualMirror(renderer, scene);
    let virtualMirrorShown = false;

    const builtCircuit = buildRwandaCircuitScene(track);
    scene.add(builtCircuit.sceneGroup);
    racingLineMeshRef.current = builtCircuit.racingLineMesh;
    // Track_Collider_Road / surface colliders and Track_Collider_Wall_* barriers for the f12026-car
    void builtCircuit.trackRoot.then((root) => {
      if (disposed) return;
      trackRoot = root;
      physics.attachTrackRoot?.(root);
      aiFieldRef.current?.attachTrackRoot(root);
      // Move broadcast cameras that would film the inside of a grandstand
      tvDirector.resolveOcclusion(root);
    });

    /**
     * The 3D car: a ported car's own GLB on the generic rig, else the vehicle model's own car
     */
    const isGt3Rig = (car: CarId) => carById(car).physics === "amg-gt3";
    const createCarRig = (car: CarId): SimCarRig => {
      const def = carById(car);
      const rig = def.modelUrl
        ? createPortedCarRig({
            url: def.modelUrl,
            chassis: (def.physics === "amg-gt3" ? AMG_GT3_CONFIG : F12026_CAR_CONFIG).chassis,
            steerLockDeg: carWheelLockDeg(def.physics) / 2,
          })
        : isGt3Rig(car)
          ? createGt3CarRig()
          : createF1Car2026(liveryRef.current, physics.tireCompound);
      rig.setLivery(liveryRef.current);
      scene.add(rig.root);
      carRigRef.current = rig;
      return rig;
    };
    let carRig = createCarRig(carIdRef.current);
    let carRigCar: CarId = carIdRef.current;
    const swapCarRig = (car: CarId) => {
      if (car === carRigCar) return;
      // The cockpit extras belong to the old body
      wheelDisplay?.dispose();
      wheelDisplay = null;
      wingMirrors?.dispose();
      wingMirrors = null;
      carRig.dispose();
      carRig = createCarRig(car);
      carRigCar = car;
    };

    // Persistent 4-Wheel Skidmarks, Instanced Tire Smoke/Gravel & Multiplayer/AI Opponent Renderer
    const visualFx = new SimVisualFxManager();
    scene.add(visualFx.group);
    // One connection for the page: it survives a circuit switch (which remounts this component)
    const multiplayerSync = getMultiplayerManager();
    multiplayerSync.onStatusChange = (st) => {
      setP2pStatus(st);
    };
    setP2pStatus(multiplayerSync.status);
    multiplayerRef.current = multiplayerSync;

    // Lap recording for the summary card, the personal-best ghost and the leaderboards
    const lapRecorder = new LapRecorder({
      trackLengthM: track.totalLengthM,
      turns: TURN_METADATA.map((t) => ({ number: t.number, name: t.name, sApprox: t.sApprox })),
      trackId,
      vehicle: vehicleModelRef.current,
      driverName: settingsRef.current.profile.name,
      driverCode: settingsRef.current.profile.code,
    });
    lapRecorderRef.current = lapRecorder;

    applyGraphicsRef.current = (quality, renderScale) => {
      applyGraphicsQuality(renderer, postFx, env, quality, renderScale);
      postFx.setSize(container.clientWidth, container.clientHeight);
    };
    applyGraphicsRef.current(settingsRef.current.graphics.quality, settingsRef.current.graphics.renderScale);

    // WebXR: the headset's pose is added to a rig placed at the driver's eye every frame
    renderer.xr.enabled = true;
    const xrRig = new THREE.Group();
    const xrCamera = new THREE.PerspectiveCamera(70, 1, 0.05, 5500);
    xrRig.add(xrCamera);
    scene.add(xrRig);
    enterVrRef.current = () => {
      const xr = (navigator as Navigator & { xr?: { requestSession: (mode: string, init?: object) => Promise<XRSession> } }).xr;
      if (!xr || renderer.xr.isPresenting) return;
      void xr
        .requestSession("immersive-vr", { optionalFeatures: ["local-floor"] })
        .then(async (session) => {
          renderer.xr.setReferenceSpaceType("local");
          await renderer.xr.setSession(session);
          setVrActive(true);
          session.addEventListener("end", () => setVrActive(false));
        })
        .catch(() => setVrActive(false));
    };

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
        case "throttleHalf":
          keysRef.current.half = true;
          if (physics.aiAutopilot) physics.aiAutopilot = false;
          break;
        case "replay":
          toggleReplayRef.current();
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
        case "mfdPage":
          window.dispatchEvent(new Event(HUD_TOGGLE_EVENT.mfdPage));
          break;
      }
    };

    const restartRun = () => {
      // A multiplayer race is restarted by the host, from the pause menu
      if (mpRaceRef.current) return;
      if (replayRef.current.active) return;
      lapRecorder.reset();
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
      else if (action === "throttleHalf") keysRef.current.half = false;
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

    // A hidden tab stops the frame loop: zero the wheel rather than leave it holding the last force
    const onVisibilityChange = () => {
      if (document.hidden) wheelFfb.stop();
    };
    const onPageHide = () => wheelFfb.stop();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);

    let lastTimeMs = performance.now();
    let lastHudSyncMs = 0;
    let lastTelemetryOutMs = 0;
    // Instant replay: session clock while driving, and the live pose saved while a replay plays
    let replayClockS = 0;
    let lastReplayPushS = -1;
    const replaySaved = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    const replayFwd = new THREE.Vector3();
    const replayQuat = new THREE.Quaternion();
    const replayPeerState = (car: ReplayCarState): InterpolatedPeerState => ({
      peerId: car.id,
      driverCode: replayNames.get(car.id)?.code ?? "",
      teamColorHex: replayNames.get(car.id)?.color ?? "#9CA3AF",
      vehicle: replayNames.get(car.id)?.vehicle,
      position: new THREE.Vector3(car.x, car.y, car.z),
      quaternion: new THREE.Quaternion(car.qx, car.qy, car.qz, car.qw),
      linearVelocity: new THREE.Vector3(),
      steerAngle: car.steer * 0.36,
      wheelRPMs: [0, 0, 0, 0].map(() => (car.speedKmh / 3.6 / 0.36) * 9.549296) as [number, number, number, number],
      throttle: car.throttle,
      brake: car.brake,
      trackS: 0,
      speedKmh: car.speedKmh,
      isAiPeer: true,
    });
    /** Look of every car seen in the replay window (the frames only hold poses) */
    const replayNames = new Map<string, { code: string; color: string; vehicle?: VehicleModelId }>();
    const exitReplay = () => {
      const rp = replayRef.current;
      if (!rp.active) return;
      rp.active = false;
      // The replay only moved the drawn car (the physics never left the live pose): put the drawing back
      physics.worldPosition.copy(replaySaved.pos);
      physics.worldQuaternion.copy(replaySaved.quat);
      setReplayUi((u) => ({ ...u, active: false }));
    };
    const flashbackReplay = () => {
      const rp = replayRef.current;
      if (!rp.active) return;
      const frame = rp.buffer.frameAt(rp.timeS);
      const car = frame?.cars.find((c) => c.id === "player");
      if (car) {
        // Re-seat the car on the ground at that pose (heading from the recorded orientation), rolling at its speed
        replayFwd.set(0, 0, 1).applyQuaternion(replayQuat.set(car.qx, car.qy, car.qz, car.qw));
        const pose = { x: car.x, z: car.z, yawRad: Math.atan2(replayFwd.x, replayFwd.z), speedMs: car.speedKmh / 3.6, s: car.s };
        if (physics.restorePose) physics.restorePose(pose);
        else physics.teleportToDistance(car.s ?? physics.sMeters, pose.speedMs);
      }
      physics.invalidateLap?.();
      rp.buffer.truncateAfter(rp.timeS);
      replayClockS = rp.timeS;
      lastReplayPushS = rp.timeS;
      rp.active = false;
      setReplayUi((u) => ({ ...u, active: false }));
    };
    exitReplayRef.current = exitReplay;
    flashbackReplayRef.current = flashbackReplay;
    toggleReplayRef.current = () => {
      const rp = replayRef.current;
      if (rp.active) return exitReplay();
      // Not in a multiplayer race (the field keeps racing) and only with something recorded
      if (mpRaceRef.current || rp.buffer.durationS < 1 || phaseRef.current !== "driving") return;
      replaySaved.pos.copy(physics.worldPosition);
      replaySaved.quat.copy(physics.worldQuaternion);
      // Opens paused a moment back, showing the car there: scrub back to the point to flash back to, or play
      rp.active = true;
      rp.playing = false;
      rp.speed = 1;
      rp.timeS = Math.max(rp.buffer.startS, rp.buffer.endS - REPLAY_OPEN_BACK_S);
      setReplayUi({ active: true, timeS: rp.timeS, startS: rp.buffer.startS, endS: rp.buffer.endS, playing: false, speed: 1 });
    };

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
    // Race control: judges every excursion past the track limits (see TrackLimitsMonitor)
    const trackLimits = new TrackLimitsMonitor();
    let tlCar: SimulatorCar | null = null;
    let tlLastDist: number | null = null;
    let tlLastLap = 0;
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
    const trackEnv = getTrackEnv();
    // Time of day / weather look: the sky follows the session's WeatherState at 10 Hz, the HUD badge at 2 Hz
    let lastSkyMs = -Infinity;
    let lastWeatherHudMs = -Infinity;
    let weatherHudKey = "";
    const skyConditions = { elevationDeg: 14, azimuthDeg: 127, cloud: 0, rain: 0 };
    const rainCamPos = new THREE.Vector3();
    const rainCamPrev = new THREE.Vector3();
    const rainCamVel = new THREE.Vector3();
    const soloCars: SimulatorCar[] = [];
    const remoteWake: WakeEmitterCar[] = [];
    const ghostPos = new THREE.Vector3();
    const radarInvQ = new THREE.Quaternion();
    // Audio cue edges: DRS available / open last frame, shift beep armed for this gear
    let cueDrsAvail = false;
    let cueDrsOpen = false;
    let cueShiftArmed = true;
    let cueGear = 0;
    // Neck FX: velocity-aligned slide look, steering look, 20 m track-spline apex lookahead, and horizon roll stabilization
    let neckYaw = 0;
    let neckPitch = 0;
    let neckRoll = 0;
    let neckDriftState = 1;
    const neckQuat = new THREE.Quaternion();
    const neckPitchQuat = new THREE.Quaternion();
    const neckRollQuat = new THREE.Quaternion();
    const neckLookDelta = new THREE.Vector3();
    const radarRel = new THREE.Vector3();
    const radarFwd = new THREE.Vector3();
    const ghostQuat = new THREE.Quaternion();
    const ghostVel = new THREE.Vector3();
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
      const dtSeconds = Math.min((nowMs - lastTimeMs) / 1000, 0.05);
      lastTimeMs = nowMs;

      // Optional Gamepad / Sim Racing Wheel Polling. Controllers with the standard mapping (Xbox,
      // DualShock, DualSense …) send the raw thumbstick through the physics' gamepad steering
      // assist every frame (also when centred: it self-aligns); other devices (wheels) drive the
      // rack directly.
      // Read every frame (also in menus / paused) so button edges never fire on a stale press
      const pads = connectedPads();
      const device = deviceInput.read(pads, settingsRef.current, dtSeconds, vehicleModelRef.current);
      const appPhase = phaseRef.current;
      const inMenu = appPhase !== "driving";
      const rp = replayRef.current;
      if (rp.active && inMenu) exitReplay();
      const replaying = rp.active;
      const driving = !inMenu && !pausedRef.current && !replaying;
      const settingsNow = settingsRef.current;
      const padTuning = settingsNow.padTuning;
      const kbTuning = settingsNow.keyboardTuning;
      const isPad = device.source === "controller";
      const gamepadThrottle = driving ? (isPad ? Math.pow(device.throttle, padTuning.throttleGamma) : device.throttle) : 0;
      const gamepadBrake = driving ? (isPad ? Math.pow(device.brake, padTuning.brakeGamma) : device.brake) : 0;
      const gamepadSteer = device.analogSteer;
      const gamepadStick =
        device.padSteer === undefined ? undefined : shapeStick(device.padSteer, padTuning.outerDeadzone, padTuning.linearity);
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
          // The HUD owns these panels: L3 folds the Live Tuner MFD, R3 clears the whole HUD off the screen
          else if (action === "mfd" || action === "mfdPage" || action === "hud") window.dispatchEvent(new Event(HUD_TOGGLE_EVENT[action]));
        }
      }

      // Keyboard-only input shaping: keys become ramped pedals and a rate- and speed-limited
      // steering angle (about what keeps the front tyres near peak slip at this speed).
      // Wheel and mouse inputs are passed through untouched.
      const keys = keysRef.current;
      const kb = kbInputRef.current;
      // Half-throttle key: a fixed part throttle for wet-like traction or slow corners
      let kbThrottleTarget = keys.up ? 1 : keys.half ? kbTuning.halfThrottle : 0;
      // Exit assist: hold the keyboard throttle back while the rear tyres spin up
      if (kbThrottleTarget > 0 && kbTuning.exitAssist) {
        const slip = physics.telemetry.wheelSlipRatios;
        const rearSlip = Math.max(slip[2] ?? 0, slip[3] ?? 0);
        if (rearSlip > KB_EXIT_ASSIST_SLIP) {
          kbThrottleTarget *= Math.max(0.35, 1 - (rearSlip - KB_EXIT_ASSIST_SLIP) * 4);
        }
      }
      const throttleRising = kbThrottleTarget > kb.throttle;
      kb.throttle = approach(
        kb.throttle,
        kbThrottleTarget,
        dtSeconds / (throttleRising ? kbTuning.throttleRiseS || KB_THROTTLE_RISE_S : KB_THROTTLE_FALL_S)
      );
      kb.brake = approach(
        kb.brake,
        keys.down ? 1 : 0,
        dtSeconds / (keys.down ? kbTuning.brakeRiseS || KB_BRAKE_RISE_S : KB_BRAKE_FALL_S)
      );
      const vFwd = Math.max(0, physics.vxMs);
      const lineWaterMm = getTrackEnv().weather.lineWaterMm;
      const wetTraits =
        physics.tireCompound === "wet" || physics.tireCompound === "intermediate"
          ? WET_TYRE_TRAITS[physics.tireCompound]
          : SLICK_TRAITS;
      const wetGripScale =
        lineWaterMm > 0
          ? wetGripFactor(
              wetTraits,
              lineWaterMm,
              vFwd,
              SIM_REALISM_FLAGS[settingsRef.current.realism].wetSeverity
            ) / wetTraits.dryGrip
          : 1;
      const speedAeroFrac = Math.min(1, (vFwd * vFwd) / (55 * 55));
      const kbMaxLatAccel = (21 + (KB_STEER_LIMIT_ACCEL - 21) * speedAeroFrac) * wetGripScale;
      const kbSteerLimit = Math.min(
        1,
        ((physics.wheelbaseM * kbMaxLatAccel) / Math.max(1, vFwd * vFwd) +
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
        (kbSteerLimit /
          (kbRecentring ? kbTuning.steerReturnS || KB_STEER_RETURN_S : kbTuning.steerRiseS || KB_STEER_RISE_S)) *
          dtSeconds
      );
      const kbSteerActive = keys.left || keys.right || Math.abs(kb.steer) > 1e-3;
      // On-screen controls: pedals and a steering pad (or the tilt of the device)
      const touch = touchInput.active && driving ? touchInput : null;
      const touchSteerActive = touch !== null && Math.abs(touch.steer) > 0.01;
      if (touchInput.active) {
        if (driving) {
          if (touchInput.shiftUp) keysRef.current.shiftUp = true;
          if (touchInput.shiftDown) keysRef.current.shiftDown = true;
          if (touchInput.aero) keysRef.current.toggleX = true;
          if (touchInput.boost) setBoostLatch((prev) => !prev);
        }
        touchInput.shiftUp = touchInput.shiftDown = touchInput.aero = touchInput.boost = false;
      }
      const activeAnalogSteer = mouseSteerEnabledRef.current
        ? mouseSteerValueRef.current
        : touchSteerActive
          ? touch.steer
          : gamepadSteer;

      const inputs: ControlInputs = {
        throttle: Math.max(kb.throttle, gamepadThrottle, touch?.throttle ?? 0),
        brake: Math.max(kb.brake, gamepadBrake, touch?.brake ?? 0),
        steerLeft: 0,
        steerRight: 0,
        analogSteer: kbSteerActive ? kb.steer : activeAnalogSteer,
        padSteer:
          kbSteerActive || mouseSteerEnabledRef.current || touchSteerActive ? undefined : gamepadStick,
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
      // A multiplayer race runs on the host's clock: the grid is held until the shared lights-out
      const mpRace = mpRaceRef.current;
      const mpFrame = mpRace ? mpRace.frame(multiplayerSync.hostNowMs(nowMs)) : null;
      const mpFrozen = mpFrame !== null && mpFrame.phase !== "racing";
      if (driving) {
        // The evolving road and the wake of the cars around: the player's car always, the AI field's too when racing,
        // with the remote players placed from last frame's interpolated poses
        soloCars[0] = physics;
        trackEnv.update(dtSeconds, aiField ? aiField.sims() : soloCars, remoteWake);
        // The autopilot backs off for rain like the AI field does, from the car's own pace
        if (physics.aiPaceScale !== undefined) {
          const base = autopilotPaceRef.current;
          if (base.car !== physics) autopilotPaceRef.current = { car: physics, pace: physics.aiPaceScale };
          physics.aiPaceScale = autopilotPaceRef.current.pace * (physics.aiAutopilot ? trackEnv.weatherPaceScale(physics) : 1);
        }
        if (!aiField?.playerFrozen && !mpFrozen) physics.step(dtSeconds, inputs);
        aiField?.update(dtSeconds);
      }
      if (mpRace && mpFrame && mpFrame.phase === "racing" && !pausedRef.current) {
        mpRace.lapClock.update(physics.sMeters, mpFrame.raceTimeS, mpRace.start.laps);
      }
      haptics.update(physics.telemetry, dtSeconds, rumbleEnabledRef.current && driving, {
        triggerRumble: padTuning.triggerRumble,
      });
      // Forces only while driving with the wheel: on a pad or the keyboard a plugged-in wheel stays limp
      wheelFfb.update(
        physics.telemetry,
        settingsNow.wheel,
        pads,
        nowMs,
        driving && settingsNow.device === "wheel",
        vehicleModelRef.current
      );
      physics.telemetry.race = mpRace && mpFrame ? mpRace.status(mpFrame, physics.vxMs) : aiField?.status();

      // Track limits: race control judges each excursion once the car is back on the asphalt. Practice deletes
      // the lap; a race gives warnings, and every third one is a time penalty served at the flag.
      {
        const t = physics.telemetry;
        const raceNow = t.race;
        const session = aiField || mpRace ? "race" : "practice";
        const myDist = raceNow?.standings.find((e) => e.isPlayer)?.raceDistM ?? null;
        const restarted =
          raceNow?.phase === "lights" ||
          (myDist !== null && tlLastDist !== null && myDist < tlLastDist - 200) ||
          t.lapCount < tlLastLap;
        if (session !== trackLimits.mode || physics !== tlCar || restarted) {
          trackLimits.reset(session);
          tlCar = physics;
        }
        tlLastDist = myDist;
        tlLastLap = t.lapCount;
        physics.trackLimitsMode = "judged";
        if (driving) {
          const tlEvent = trackLimits.update({
            nowMs,
            dtS: dtSeconds,
            lapCount: t.lapCount,
            distM: t.trackDistanceM,
            offTrack: t.offTrack,
            throttle: t.throttle,
            brake: t.brake,
            lateralM: physics.lateralOffsetM,
            curvature: track.getSampleAtDistance(physics.sMeters).curvature,
            deltaS: lapDelta.delta(t),
            racePosition: raceNow?.position,
            active: !physics.aiAutopilot && !mpFrozen && raceNow?.phase !== "lights" && raceNow?.phase !== "finished",
          });
          // A strike also deletes the lap time (it never counts as a best lap)
          if (tlEvent && tlEvent.kind !== "cleared" && tlEvent.kind !== "no_advantage" && tlEvent.lap === t.lapCount) {
            physics.invalidateLap?.();
          }
        }
        physics.trackLimitsHold = trackLimits.judging;
        if (aiField) aiField.playerPenaltyS = trackLimits.penaltyTotalS;
        if (mpRace) {
          mpRace.penaltyS = trackLimits.penaltyTotalS;
          mpRace.compound = physics.tireCompound;
        }
        t.trackLimits = trackLimits.snapshot(nowMs);
      }
      builtCircuit.setStartLights(
        mpFrame
          ? mpFrame.phase === "lights"
            ? mpFrame.lightsOn
            : null
          : aiField?.phase === "lights"
            ? aiField.lightsOn
            : null
      );

      // Laps: summary card, personal best (saved, and raced as the ghost) — practice only
      if (driving && !aiField && !mpRace) {
        const done = lapRecorder.update({
          telemetry: physics.telemetry,
          position: physics.worldPosition,
          quaternion: physics.worldQuaternion,
        });
        if (done) onLapCompletedRef.current(done.summary, done.recording);
      }

      // Telemetry out (UDP via the bridge) for dashboards and motion rigs
      if (settingsNow.wheel.telemetryOut && nowMs - lastTelemetryOutMs >= 1000 / TELEMETRY_OUT_HZ) {
        lastTelemetryOutMs = nowMs;
        wheelFfb.sendTelemetry(
          settingsNow.wheel.telemetryPort,
          buildTelemetryPacket(physics.telemetry, {
            car: vehicleModelRef.current,
            track: trackId,
            maxRpm: MAX_RPM[vehicleModelRef.current],
            yawRateRadS: physics.yawRateRadS,
            pitchRad: physics.pitchRad,
            rollRad: physics.rollRad,
            nowMs,
          })
        );
      }

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
          driverCode: settingsNow.profile.code,
          teamColorHex: settingsNow.profile.color,
          name: settingsNow.profile.name,
          race: mpRace?.progress(),
          vehicle: vehicleModelRef.current,
          trackId,
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

      // A peer on another circuit has coordinates that mean nothing here
      const samePeers = interpolatedPeers.filter((p) => !p.trackId || p.trackId === trackId);
      peerWakeEmitters(track, samePeers, remoteWake);
      if (mpRace && mpFrame) {
        mpRace.ingestPeers(samePeers);
        // Contact with the other players (one-sided: each client resolves its own car)
        if (driving && mpRace.collisionsActive(mpFrame)) {
          for (const p of samePeers) {
            if (!p.isAiPeer && p.race?.id === mpRace.start.id) resolvePlayerVsRemoteCar(physics, p, dtSeconds);
          }
        }
      }
      let renderPeers = aiField ? [...samePeers, ...aiField.peers()] : samePeers;

      // Proximity radar: every car within 30 m in the player's frame (model +X is the car's left)
      {
        const blips: RadarBlip[] = [];
        radarInvQ.copy(physics.worldQuaternion).invert();
        for (const p of renderPeers) {
          if (p.ghost) continue;
          radarRel.copy(p.position).sub(physics.worldPosition);
          if (radarRel.lengthSq() > 900) continue;
          radarRel.applyQuaternion(radarInvQ);
          radarFwd.set(0, 0, 1).applyQuaternion(p.quaternion).applyQuaternion(radarInvQ);
          blips.push({ x: -radarRel.x, z: radarRel.z, yaw: Math.atan2(-radarFwd.x, radarFwd.z), color: p.teamColorHex });
        }
        physics.telemetry.radar = blips;
      }

      // Personal-best (or chosen) ghost, in practice only, timed against the lap in progress
      const ghost = ghostRef.current;
      if (ghost && settingsNow.ghost && !aiField && !mpRace && !replaying && !inMenu) {
        const g = ghost.sampleAt(physics.telemetry.currentLapTimeMs / 1000);
        if (g) {
          const wheelRpm = (g.speedKmh / 3.6 / 0.36) * 9.549296;
          renderPeers = [
            ...renderPeers,
            {
              peerId: "ghost",
              driverCode: ghost.recording.driverCode,
              teamColorHex: "#9CA3AF",
              vehicle: ghost.recording.vehicle,
              position: ghostPos.set(g.x, g.y, g.z),
              quaternion: ghostQuat.set(g.qx, g.qy, g.qz, g.qw),
              linearVelocity: ghostVel,
              steerAngle: g.steer * 0.36,
              wheelRPMs: [wheelRpm, wheelRpm, wheelRpm, wheelRpm],
              throttle: g.throttle,
              brake: g.brake,
              trackS: g.s,
              speedKmh: g.speedKmh,
              isAiPeer: true,
              ghost: true,
            },
          ];
        }
      }

      // Instant replay: record the field while driving, show the recorded poses while replaying
      if (driving) {
        replayClockS += dtSeconds;
        if (replayClockS - lastReplayPushS >= 1 / 30) {
          lastReplayPushS = replayClockS;
          const cars: ReplayCarState[] = [
            {
              id: "player",
              x: physics.worldPosition.x,
              y: physics.worldPosition.y,
              z: physics.worldPosition.z,
              qx: physics.worldQuaternion.x,
              qy: physics.worldQuaternion.y,
              qz: physics.worldQuaternion.z,
              qw: physics.worldQuaternion.w,
              speedKmh: physics.telemetry.speedKmh,
              steer: physics.steerAngleNorm,
              throttle: physics.telemetry.throttle,
              brake: physics.telemetry.brake,
              gear: physics.telemetry.gear,
              rpm: physics.telemetry.rpm,
              s: physics.sMeters,
              vyMs: physics.vyMs,
              yawRateRadS: physics.yawRateRadS,
            },
          ];
          for (const p of renderPeers) {
            if (p.ghost) continue;
            replayNames.set(p.peerId, { code: p.driverCode, color: p.teamColorHex, vehicle: p.vehicle });
            cars.push({
              id: p.peerId,
              x: p.position.x,
              y: p.position.y,
              z: p.position.z,
              qx: p.quaternion.x,
              qy: p.quaternion.y,
              qz: p.quaternion.z,
              qw: p.quaternion.w,
              speedKmh: p.speedKmh,
              steer: p.steerAngle / 0.36,
              throttle: p.throttle,
              brake: p.brake,
              gear: 0,
              rpm: 0,
            });
          }
          rp.buffer.push(replayClockS, cars);
        }
      } else if (replaying) {
        if (rp.playing && !pausedRef.current) {
          rp.timeS = Math.min(rp.buffer.endS, rp.timeS + dtSeconds * rp.speed);
          if (rp.timeS >= rp.buffer.endS) rp.playing = false;
        }
        const frame = rp.buffer.frameAt(rp.timeS);
        if (frame) {
          const peers: InterpolatedPeerState[] = [];
          for (const car of frame.cars) {
            if (car.id === "player") {
              // Only the drawn pose: the car's physics stays as it was until a flashback places it
              physics.worldPosition.set(car.x, car.y, car.z);
              physics.worldQuaternion.set(car.qx, car.qy, car.qz, car.qw);
            } else {
              peers.push(replayPeerState(car));
            }
          }
          renderPeers = peers;
        }
      }

      physics.telemetry.peers = renderPeers.filter((p) => !p.ghost).map((p) => {
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
      const inVr = renderer.xr.isPresenting;
      const mode: CameraMode = inMenu ? "chase" : inVr ? "cockpit" : cameraModeRef.current;
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

      // Update persistent 4-wheel skidmark ribbons, tire smoke/gravel/rooster-tail particles & opponent 3D cars
      visualFx.update(
        dtSeconds,
        physics.worldQuaternion,
        physics.vxMs,
        physics.wheels,
        renderPeers
      );


      // Titanium Floor Sparks
      if (
        !isGt3Rig(carRigCar) &&
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

      // Cockpit Neck FX: 4-part driver head orientation model (not active in VR where the headset tracks the player's head)
      // 1. Velocity-vector slide alignment with driftState hysteresis
      // 2. Steering-angle look-in attenuated by front wheelspin and slide state
      // 3. 20 m track-spline apex lookahead (yaw into apexes, pitch into crests/dips)
      // 4. 30% horizon roll stabilization against chassis banking
      const neckOn = settingsNow.hud.neckFx && driving && !inVr && (mode === "cockpit" || mode === "cockpit_shoulder");
      let neckYawTarget = 0;
      let neckPitchTarget = 0;
      let neckRollTarget = 0;
      if (neckOn) {
        const speedMs = Math.hypot(physics.vxMs, physics.vyMs);
        // 1. Velocity alignment (+X is carLeft, so +vyMs means sliding toward carLeft -> positive yaw around carUp)
        const sliding = speedMs > 3 ? physics.vyMs / Math.max(3, speedMs) : 0;
        const slidingMult = Math.min(Math.abs(sliding) * 0.8, 1);
        if (slidingMult > 0.2) {
          neckDriftState = Math.max(0, neckDriftState - 0.5 * dtSeconds);
        } else {
          neckDriftState = Math.min(1, neckDriftState + 0.25 * dtSeconds);
        }
        const thMult = Math.max(slidingMult - 0.16 * neckDriftState, 0) * Math.sign(sliding);
        const velYaw = THREE.MathUtils.clamp(thMult * 0.65, -0.45, 0.45);

        // 2. Steering look-in (+steerAngleNorm is right turn -> negative yaw around carUp)
        const frontSpin = Math.max(
          0,
          physics.telemetry.wheelSlipRatios[0] ?? 0,
          physics.telemetry.wheelSlipRatios[1] ?? 0
        );
        const steerFade =
          (THREE.MathUtils.clamp(speedMs / 10 - 0.1, 0, 1) / (1 + frontSpin)) *
          (neckDriftState * neckDriftState);
        const steerYaw = THREE.MathUtils.clamp(
          -physics.steerAngleNorm * physics.maxSteerAngleRad * 0.45 * steerFade,
          -0.26,
          0.26
        );

        // 3. 20 m track-spline apex lookahead
        const aheadSample = track.getSampleAtDistance(
          (physics.sMeters + 20) % Math.max(1, track.totalLengthM)
        );
        neckLookDelta.copy(aheadSample.position).sub(physics.worldPosition);
        const chordLen = neckLookDelta.length();
        let apexYaw = 0;
        let apexPitch = 0;
        if (chordLen > 1) {
          const latDot = neckLookDelta.dot(carRight) / chordLen;
          const vertDot = neckLookDelta.dot(carUp) / chordLen;
          const fwdDot = neckLookDelta.dot(carForward) / chordLen;
          const trackWeight =
            THREE.MathUtils.clamp((15 - Math.abs(physics.lateralOffsetM)) / 7, 0, 1) *
            THREE.MathUtils.clamp(fwdDot, 0, 1) *
            (neckDriftState * neckDriftState) *
            THREE.MathUtils.clamp((speedMs - 4) / 12, 0, 1);
          apexYaw = THREE.MathUtils.clamp(-latDot * 0.38, -0.26, 0.26) * trackWeight;
          apexPitch = THREE.MathUtils.clamp(vertDot * 0.30, -0.14, 0.14) * trackWeight;
        }

        neckYawTarget = THREE.MathUtils.clamp(velYaw + steerYaw + apexYaw, -0.52, 0.52);
        neckPitchTarget = apexPitch;
        // 4. Horizon roll lock (30% stabilization against chassis roll)
        neckRollTarget = THREE.MathUtils.clamp(-physics.rollRad * 0.30, -0.18, 0.18);
      } else {
        neckDriftState = 1;
      }
      neckYaw += (neckYawTarget - neckYaw) * Math.min(1, dtSeconds * 8);
      neckPitch += (neckPitchTarget - neckPitch) * Math.min(1, dtSeconds * 8);
      neckRoll += (neckRollTarget - neckRoll) * Math.min(1, dtSeconds * 12);
      if (
        (Math.abs(neckYaw) > 1e-4 || Math.abs(neckPitch) > 1e-4 || Math.abs(neckRoll) > 1e-4) &&
        (mode === "cockpit" || mode === "cockpit_shoulder")
      ) {
        if (Math.abs(neckYaw) > 1e-4) {
          camera.quaternion.premultiply(neckQuat.setFromAxisAngle(carUp, neckYaw));
        }
        if (Math.abs(neckPitch) > 1e-4) {
          camera.quaternion.premultiply(neckPitchQuat.setFromAxisAngle(carRight, neckPitch));
        }
        if (Math.abs(neckRoll) > 1e-4) {
          camera.quaternion.premultiply(neckRollQuat.setFromAxisAngle(carForward, neckRoll));
        }
      }

      builtCircuit.updateEnvironment(nowMs * 0.001);
      audioRef.current?.setCameraMode(mode);
      audioRef.current?.setPaused(!driving);
      if (driving) {
        audioRef.current?.update(physics.telemetry, dtSeconds);
        // Cues: DRS enabled (two-tone), flap open (chime; VF26: X-mode), shift point (150 rpm short of the limiter)
        const tc = physics.telemetry;
        const cues = settingsNow.hud;
        const drsAvail = Boolean(
          tc.f12026 ? tc.f12026.drsAvailable : track.getSampleAtDistance(physics.sMeters).drsZone
        );
        const drsOpen = tc.f12026 ? tc.f12026.CHANGED_DRS_OPEN : tc.activeAeroMode === "X_MODE";
        if (cues.drsBeep && !tc.aiAutopilot) {
          if (drsAvail && !cueDrsAvail) audioRef.current?.cue("drs_available");
          if (drsOpen && !cueDrsOpen) audioRef.current?.cue("drs_open");
        }
        cueDrsAvail = drsAvail;
        cueDrsOpen = drsOpen;
        const limiter = LIMITER_RPM[vehicleModelRef.current];
        if (tc.gear !== cueGear || tc.rpm < limiter - 600) {
          cueGear = tc.gear;
          cueShiftArmed = true;
        }
        if (cues.shiftBeep && cueShiftArmed && tc.gear > 0 && tc.rpm >= limiter - 150) {
          audioRef.current?.cue("shift");
          cueShiftArmed = false;
        }
      }

      // Nothing to draw behind the opaque loading screen (the shaders are compiled separately)
      if (appPhase === "loading") return;

      // Weather: sun, sky, fill and fog, the wet look of the road, spray, and rain around the camera
      const wx = trackEnv.weather;
      if (nowMs - lastSkyMs > 100) {
        lastSkyMs = nowMs;
        const sun = wx.sun;
        skyConditions.elevationDeg = sun.elevationDeg;
        skyConditions.azimuthDeg = sun.azimuthDeg;
        skyConditions.cloud = wx.cloudCover;
        skyConditions.rain = wx.rainIntensity;
        env.setConditions(skyConditions);
        setAsphaltWetness(wetnessFromWater(wx.waterMm), wetnessFromWater(wx.lineWaterMm), wx.rainIntensity, 0.1);
        visualFx.setWetness(wetnessFromWater(wx.lineWaterMm));
      }
      camera.getWorldPosition(rainCamPos);
      if (dtSeconds > 0) rainCamVel.subVectors(rainCamPos, rainCamPrev).divideScalar(dtSeconds).clampLength(0, 110);
      rainCamPrev.copy(rainCamPos);
      const sprayWake =
        (1 - (physics.telemetry.aeroWakeDownforceMult ?? 1)) * 3.2 * wetnessFromWater(wx.lineWaterMm);
      rainFx.update(
        dtSeconds,
        wx.rainIntensity,
        camera,
        rainCamVel,
        THREE.MathUtils.clamp((skyConditions.elevationDeg + 3) / 17, 0, 1) * (1 - 0.4 * wx.cloudCover),
        wx.windVxMs,
        wx.windVzMs,
        THREE.MathUtils.clamp(sprayWake, 0, 1)
      );
      if (nowMs - lastWeatherHudMs > 500) {
        lastWeatherHudMs = nowMs;
        const next: WeatherHudState = {
          airC: Math.round(wx.ambientC),
          trackC: Math.round(wx.trackTempC),
          waterMm: Math.round(wx.lineWaterMm * 100) / 100,
          rain: Math.round(wx.rainIntensity * 20) / 20,
          clockH: Math.round(wx.clockH * 60) / 60,
          timeMoving: wx.conditions.timeScale > 0, humidityPct: Math.round(wx.humidityPct), windSpeedMs: Math.round((wx.windSpeedKmh / 3.6) * 10) / 10, windDirection: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round((((wx.windDirectionDeg % 360) + 360) % 360) / 45) % 8],
        };
        const key = JSON.stringify(next);
        if (key !== weatherHudKey) {
          weatherHudKey = key;
          setWeatherHud(next);
        }
      }
      env.update(physics.worldPosition, camera);
      // Virtual mirror: on its own in the views whose wing mirrors are off screen (or that have none), and in the
      // chase view too when the player asked for it always
      const vmSetting = settingsNow.hud.virtualMirror;
      const vmView =
        mode === "tv_pod" || mode === "nose" || mode === "cockpit_shoulder" || (mode === "cockpit" && !wingMirrors?.found);
      const vmOn =
        driving && !inVr && container.clientWidth >= 640 && vmSetting !== "off" && (vmView || (vmSetting === "always" && mode === "chase"));
      virtualMirror.update(frameIndex, vmOn, carRig.chassisGroup, carRig.root);
      if (vmOn !== virtualMirrorShown) {
        virtualMirrorShown = vmOn;
        setVirtualMirrorOn(vmOn);
      }
      // Rear view into the mirrors' render target (cockpit only, every 2nd frame), then the main frame
      wingMirrors?.update(frameIndex++, mode === "cockpit" && !inVr, carRig.chassisGroup);
      if (inVr) {
        // The head pose is added on top of the driver's eye point (a "local" space starts at the head)
        xrRig.position.copy(camera.position);
        xrRig.quaternion.copy(camera.quaternion);
        renderer.render(scene, xrCamera);
      } else {
        postFx.render(dtSeconds);
        virtualMirror.draw();
      }

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
        if (replaying) {
          setReplayUi({
            active: true,
            timeS: rp.timeS,
            startS: rp.buffer.startS,
            endS: rp.buffer.endS,
            playing: rp.playing,
            speed: rp.speed,
          });
        }
      }
    };

    // setAnimationLoop runs on window rAF normally and on the headset's frame loop in VR
    renderer.setAnimationLoop(animate);

    return () => {
      disposed = true;
      unsubscribeAssets();
      window.clearInterval(assetWatchdog);
      swapCarRef.current = null;
      renderer.setAnimationLoop(null);
      void renderer.xr.getSession()?.end();
      enterVrRef.current = null;
      applyGraphicsRef.current = null;
      exitReplayRef.current = () => {};
      flashbackReplayRef.current = () => {};
      toggleReplayRef.current = () => {};
      lapRecorderRef.current = null;
      haptics.stop();
      hapticsRef.current = null;
      wheelFfb.dispose();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("resize", onResize);
      // The shared connection stays up (a circuit switch remounts this component)
      multiplayerSync.onStatusChange = undefined;
      wheelDisplay?.dispose();
      wingMirrors?.dispose();
      postFx.dispose();
      env.dispose();
      rainFx.dispose();
      virtualMirror.dispose();
      renderer.dispose();
      audioRef.current?.dispose();
    };
  }, [track, getTrackEnv, unlockAudio, handleToggleMute, handleToggleRacingLine]);

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

  // Multiplayer: lobby, race start / abort from the host, link quality
  useEffect(() => {
    const mp = getMultiplayerManager();
    setLocalPeerId(mp.localPeerId);
    setLobby(mp.lobby);
    mp.onLobbyChange = (l) => {
      setLobby(l ? { ...l, players: [...l.players] } : null);
      // The host's weather and clock: a guest's session eases to them (a different preset restarts it)
      if (l?.weather && l.hostId !== mp.localPeerId) trackEnvRef.current?.weather.applySync(l.weather);
    };
    mp.weatherProvider = () => trackEnvRef.current?.weather.snapshot() ?? null;
    mp.onRaceStart = (start) => {
      // A race on another circuit: switch to it, and pick the race up once that scene has loaded
      if (start.trackId && start.trackId !== trackId && onSelectTrack) {
        pendingRaceStart = start;
        onSelectTrack(start.trackId);
        return;
      }
      startMpRaceRef.current(start);
    };
    mp.onRaceAbort = (id) => {
      if (mpRaceRef.current?.start.id === id) leaveMpRace();
    };
    const timer = window.setInterval(() => setPeerStats(mp.getPeerStats()), 1000);
    return () => {
      mp.onLobbyChange = undefined;
      mp.weatherProvider = undefined;
      mp.onRaceStart = undefined;
      mp.onRaceAbort = undefined;
      window.clearInterval(timer);
    };
  }, [trackId, onSelectTrack, leaveMpRace]);

  // The race the host started before this circuit loaded
  useEffect(() => {
    if (!assetsReady || !pendingRaceStart) return;
    const start = pendingRaceStart;
    pendingRaceStart = null;
    if (start.trackId !== trackId) return;
    unlockAudio();
    setLoadingVisible(false);
    startMpRaceRef.current(start);
  }, [assetsReady, trackId, unlockAudio]);

  // Name, code, colour and car as other players see them
  useEffect(() => {
    getMultiplayerManager().setIdentity(settings.profile, vehicleModel, trackId);
    lapRecorderRef.current?.setContext({ driverName: settings.profile.name, driverCode: settings.profile.code });
  }, [settings.profile, vehicleModel, trackId]);

  // A car change brings back that car's personal-best ghost and leaderboard
  useEffect(() => {
    void loadPbGhost(true);
    void refreshLeaderboard();
    wheelFfb.resetMeter();
  }, [vehicleModel, loadPbGhost, refreshLeaderboard]);

  useEffect(() => {
    applyGraphicsRef.current?.(settings.graphics.quality, settings.graphics.renderScale);
  }, [settings.graphics.quality, settings.graphics.renderScale]);

  const ffbMeterOn = phase === "driving" && settings.device === "wheel" && settings.wheel.ffbEnabled;
  useEffect(() => {
    if (!ffbMeterOn) return;
    const id = window.setInterval(() => setFfbMeter({ ...wheelFfb.meter }), 100);
    return () => window.clearInterval(id);
  }, [ffbMeterOn]);

  useEffect(() => {
    const mode = settings.touch.mode;
    const visible = mode === "on" || (mode === "auto" && isTouchDevice());
    setTouchVisible(visible);
    if (!visible) resetTouchInput();
  }, [settings.touch.mode]);

  useEffect(() => {
    const xr = (navigator as Navigator & { xr?: { isSessionSupported?: (mode: string) => Promise<boolean> } }).xr;
    if (!xr?.isSessionSupported) return;
    xr.isSessionSupported("immersive-vr").then(setVrSupported, () => setVrSupported(false));
  }, []);

  // WebHID force feedback (HID PID wheels) instead of the native bridge, while switched on. Only a wheel granted
  // before reopens here: pairing needs requestDevice inside a click, which the wheel setup's toggle / Connect does.
  const hidFfbWanted = settings.wheel.ffbEnabled && settings.wheel.hidFfb;
  useEffect(() => {
    if (!hidFfbWanted) {
      void webHidFfb.dispose();
      return;
    }
    void webHidFfb.reconnect();
  }, [hidFfbWanted]);
  // A fatal driver error (unsupported wheel, failed setup, writes failing) switches WebHID off: the force goes back
  // to the bridge and the wheel setup shows the reason under the toggle
  useEffect(
    () =>
      webHidFfb.subscribe(() => {
        if (!isFatalHidStatus(webHidFfb.status)) return;
        setSettings((prev) => (prev.wheel.hidFfb ? { ...prev, wheel: { ...prev.wheel, hidFfb: false } } : prev));
      }),
    []
  );

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
      ["Half throttle", keys(k.throttleHalf)],
      ["Instant replay", keys(k.replay)],
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
    aiSkill: settings.aiSkill,
    onChangeAiSkill: handleChangeAiSkill,
    carId,
    vehicleModel,
    onChangeCar: handleChangeCar,
    onToggleGamepadAssist: handleToggleGamepadAssist,
    onToggleGamepadRumble: handleToggleGamepadRumble,
    p2pStatus,
    onChangeAeroPreset: handleAeroPresetChange,
    onChangeAssistPreset: handleAssistPresetChange,
    onChangeTireCompound: handleTireCompoundChange,
    tyreSetup,
    defaultTyreSetup,
    onChangeTyreSetup: handleChangeTyreSetup,
    chassisSetup,
    onChangeChassisSetup: handleChangeChassisSetup,
    onChangeLiveTuner: handleChangeLiveTuner,
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
    lobby,
    localPeerId,
    isHost: lobby !== null && lobby.hostId === localPeerId,
    peerStats,
    profile: settings.profile,
    currentTrackId: trackId,
    currentVehicle: vehicleModel,
    vehicleLabel,
    vehiclesForClass,
    raceRunning: mpRaceRunning,
    onHostLocal: handleHostLocal,
    onSetLobbySettings: handleSetLobbySettings,
    onSetReady: handleSetReady,
    onStartRace: handleStartMpRace,
    onAbortRace: handleAbortMpRace,
    onSwitchTrack: onSelectTrack,
    onSwitchVehicle: (v: string) => handleChangeCar(carForVehicle(v as VehicleModelId).id),
    displayPanel: {
      settings,
      onChangeSettings: handleChangeSettings,
      vrSupported,
      vrActive,
      onEnterVr: () => enterVrRef.current?.(),
    },
    leaderboardPanel: {
      trackName: getTrackInfo(trackId).name,
      vehicleLabel,
      local: leaderboard.local,
      remote: leaderboard.remote,
      remoteEnabled: remoteLeaderboardEnabled,
      loading: leaderboard.loading,
      onRefresh: () => void refreshLeaderboard(),
      onRaceGhost: (entry: LeaderboardEntry) => void handleRaceGhostEntry(entry),
      onImportGhost: (file: File) => void handleImportGhost(file),
      onExportBest: () => void handleExportBest(),
      onExportDriverKey: handleExportDriverKey,
      onImportDriverKey: (file: File) => void handleImportDriverKey(file),
      driverKeyNotice,
    },
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
          weather={weatherHud}
          boostLatch={boostLatch}
          showLaunchHint={launchHint}
          launchHintText={launchHintText}
          hudToggleButton={settings.padButtons.hud === null ? undefined : padButtonLabel(settings.padButtons.hud)}
          wheelUncalibrated={
            settings.device === "wheel" && (!settings.wheel.throttle || !settings.wheel.brake)
          }
          onChangeCameraMode={setCameraMode}
          cockpitFovDeg={settings.cockpitFovDeg}
          cockpitFovDefaultDeg={carCockpitFov}
          onChangeCockpitFov={handleCockpitFovChange}
          onToggleXMode={handleToggleXMode}
          onToggleBoostLatch={handleToggleBoostLatch}
          onChangeLiveTuner={handleChangeLiveTuner}
          paused={paused}
          onOpenControls={() => openControls("pause")}
          onExitToTitle={exitToTitle}
          controlsCheatSheet={controlsCheatSheet}
          hud={settings.hud}
          virtualMirror={virtualMirrorOn}
          ffbMeter={
            ffbMeterOn
              ? {
                  force: ffbMeter.force,
                  clipping: ffbMeter.clipping,
                  peak: ffbMeter.peak,
                  suggestedGain: ffbMeter.suggestedGain,
                  onApplySuggestedGain: handleApplySuggestedGain,
                }
              : null
          }
          lapSummary={
            lapSummary
              ? {
                  summary: lapSummary.summary,
                  onClose: () => setLapSummary(null),
                  onSaveGhost: () => exportLapFile(lapSummary.recording),
                  onSubmit:
                    remoteLeaderboardEnabled && lapSummary.summary.valid
                      ? (name?: string) => void handleSubmitLap(name)
                      : undefined,
                  driverName: settings.profile.name,
                  askName: settings.profile.generated,
                  submitState,
                  submitRank,
                  submitError,
                }
              : null
          }
          resultsClosed={resultsClosed}
          onCloseResults={() => setResultsClosed(true)}
          onRestartRace={
            mpRaceRunning && !(lobby !== null && lobby.hostId === localPeerId) ? undefined : () => handleResetCar(false)
          }
          onBackToLobby={mpRaceRunning ? handleBackToLobby : undefined}
          replay={
            replayUi.active
              ? {
                  timeS: replayUi.timeS,
                  startS: replayUi.startS,
                  endS: replayUi.endS,
                  playing: replayUi.playing,
                  speed: replayUi.speed,
                  cameraLabel: CAMERA_LABELS[cameraMode],
                  onTogglePlay: handleReplayTogglePlay,
                  onSeek: handleReplaySeek,
                  onSpeed: handleReplaySpeed,
                  onCycleCamera: () => setCameraMode(nextCameraMode(cameraMode)),
                  onExit: () => exitReplayRef.current(),
                  onFlashback: () => flashbackReplayRef.current(),
                  exitKeyLabel: settings.keys.replay[0] ? keyLabel(settings.keys.replay[0]) : "T",
                }
              : null
          }
          touchControls={
            touchVisible && !vrActive
              ? {
                  tiltSteer: settings.touch.tiltSteer,
                  tiltRangeDeg: settings.touch.tiltRangeDeg,
                  onPause: togglePause,
                  onCycleCamera: () => setCameraMode(nextCameraMode(cameraMode)),
                }
              : null
          }
        />
      ) : null}

      {phase === "title" ? (
        <TitleMenu
          {...menuProps}
          onCycleCamera={() => setCameraMode(nextCameraMode(cameraMode))}
          initialRoomCode={inviteRoom ?? ""}
          initialPanel={titleInitialPanel ?? (inviteRoom ? "multiplayer" : null)}
          firstRun={!onboarded}
          onDrive={() => handleTitleStart(false)}
          onRaceAi={() => handleTitleStart(true)}
          onControls={() => openControls("title")}
          trackId={trackId}
          onSelectTrack={onSelectTrack}
          conditionsPanel={{
            conditions: settings.conditions,
            realism: settings.realism,
            onChangeConditions: handleChangeConditions,
            onChangeRealism: handleChangeRealism,
            hostControlled: lobby !== null && lobby.hostId !== localPeerId,
            readout: weatherHud,
          }}
        />
      ) : null}

      {phase === "wizard" ? (
        <FirstRunWizard
          mode={wizardMode}
          settings={settings}
          onChangeSettings={handleChangeSettings}
          carId={carId}
          vehicleModel={vehicleModel}
          onChangeCar={handleChangeCar}
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
