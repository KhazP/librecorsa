"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { getActiveTrackData, LIVERIES } from "@/lib/track-data";
import { F1Physics2026, type ControlInputs } from "@/lib/f1-physics-2026";
import { trackColliders } from "@/lib/sim/track-colliders";
import type { SimulatorCar } from "@/lib/sim/simulator-car";
import type { WheelSeating } from "@/lib/render/corner-rig";
import { F1AudioEngine2026 } from "@/lib/f1-audio-2026";
import { createF1Car2026, type SimCarRig } from "@/lib/car-builder-2026";
import { createGt3CarRig, gt3RigCameraAnchors } from "@/lib/gt3-car-model";
import { disposeTree } from "@/lib/render/dispose-tree";
import { FfbPairPrompt } from "@/components/hud/FfbPairPrompt";
import { GT3_DASH_MESH, GT3_WING_MIRROR_MATERIAL, Gt3DashDisplay } from "@/lib/render/gt3-dash-display";
import { createPortedCarRig } from "@/lib/ported-car-model";
import { staticFloorOf } from "@/lib/render/body-floor";
import { FloorSparks } from "@/lib/render/floor-sparks";
import { isVehicleModelId, vehicleModelSpec, vehicleModelsFor } from "@/lib/cars/vehicle-models";
import type { CarSoundSource } from "@/lib/sim/CarAudio";
import { OpponentAudio } from "@/lib/sim/opponent-audio";
import { carById, carForVehicle, isCarId, type CarId } from "@/lib/cars/car-registry";
import { overtakingRulesForSeason } from "@/lib/sim/overtaking-rules";
import { alignGhostToTrack, trackGeometryKey } from "@/lib/sim/ghost-align";
import { carPhysics, carTakesPhysicsSwitch, subscribeF1ModPhysics } from "@/lib/cars/f1-mod-physics";
import { buildCircuitScene } from "@/lib/scene-builder";
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
import { type ChaseCameraInput, DynamicChaseCamera } from "@/lib/render/chase-camera";
import { LapDeltaTracker } from "@/lib/sim/lap-delta";
import { TrackLimitsMonitor } from "@/lib/sim/track-limits";
import { SimVisualFxManager } from "@/lib/sim/visual-fx";
import { AiOpponentField, AI_DRIVERS, resolvePlayerVsRemoteCar } from "@/lib/sim/ai-opponents";
import { peerWakeEmitters, TrackEnvironment } from "@/lib/sim/track-environment";
import type { WakeEmitterCar } from "@/lib/sim/aero-wake";
import { GamepadHaptics } from "@/lib/sim/gamepad-haptics";
import {
  getMultiplayerManager,
  type InterpolatedPeerState,
  type LobbySettings,
  type LobbyState,
  type P2PConnectionStatus,
  type PeerNetStats,
  type RaceStartInfo,
} from "@/lib/sim/multiplayer-sync";
import { MultiplayerRace, type MultiplayerRaceFrame } from "@/lib/sim/race-session";
import { GhostPlayer, LapRecorder } from "@/lib/sim/lap-recorder";
import { ReplayBuffer } from "@/lib/sim/replay-buffer";
import { GHOST_CAR_COLOR, steerAngleOf, steerNormOf, wheelRpmAtSpeed, wheelRpmOf } from "@/lib/sim/car-pose";
import { lapBoardClass, lapConditionsNow, type LapConditions, type LapRecording, type LapSummaryData, type LeaderboardEntry, type ReplayCarState } from "@/lib/sim/lap-types";
import { exportLapFile, importLapFile, loadBestLap, saveBestLapIfFaster } from "@/lib/sim/ghost-store";
import {
  boardLabel,
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
import { createRainFx, RAIN_VISOR_LAYER } from "@/lib/render/rain-fx";
import { DRIVER_HEAD_LAYER, OVERLAY_LAYER } from "@/lib/render/layers";
import { KeyboardPedalAssist } from "@/lib/input/keyboard-pedals";
import { shapeStick } from "@/lib/input/stick-shape";
import { advanceAsphaltRain, setAsphaltWetness } from "@/lib/render/asphalt-sheen";
import { SIM_REALISM_FLAGS, type SimRealism } from "@/lib/sim/sim-realism";
import {
  isRainCompound,
  recommendedCompound,
  wetnessFromWater,
} from "@/lib/sim/wet-tyres";
import type { SessionConditions } from "@/lib/sim/weather";
import type { WeatherHudState } from "@/components/hud/WeatherBadge";
import { TURN_METADATA } from "@/lib/track-data";
import { getTrackInfo } from "@/lib/track-registry";
import { TouchControls } from "@/components/hud/TouchControls";
import { ReplayBar } from "@/components/hud/ReplayBar";
import { F1TelemetryHud } from "@/components/F1TelemetryHud";
import { roomFromUrl } from "@/lib/net/invite-room";
import { CAMERA_MODES, FALLBACK_COCKPIT_FOV_DEG, nextCameraMode } from "@/lib/render/camera-modes";
import { loadTyreSetup, saveTyreSetup } from "@/lib/sim/tyre-setup";
import { LoadingScreen } from "@/components/menu/LoadingScreen";
import { TitleMenu } from "@/components/menu/TitleMenu";
import { FirstRunWizard, type WizardMode, type WizardStepId } from "@/components/menu/FirstRunWizard";
import { assetProgress } from "@/lib/loading/asset-progress";
import { prefetchSoundBank } from "@/lib/sim/vf26-audio";
import { CarReflectionProbe } from "@/lib/render/car-reflection-probe";
import { StartupMonitor } from "@/lib/render/startup-monitor";
import { addContactShadow, seatContactShadow } from "@/lib/render/contact-shadow";
import { buildKeyLookup, HUD_TOGGLE_EVENT, keyLabel, padButtonLabel, type KeyAction } from "@/lib/input/bindings";
import { autoConfigureWheel, carWheelLockDeg, connectedPads, DeviceInputReader, findPad } from "@/lib/input/device-input";
import { webHidFfb, wheelFfb } from "@/lib/input/wheel-ffb";
import { DEFAULT_STEERING_ASSIST, steeringAssistSettings, type SteeringAssistSettings } from "@/lib/sim/steering-assist";
import { axleSlipFromTelemetry, createAxleSlipSample } from "@/lib/sim/tyre-slip";
import {
  clampFov,
  codeFromName,
  DEFAULT_KEYBOARD_TUNING,
  DEFAULT_PLAYER_SETTINGS,
  loadCarChoice,
  loadOnboarded,
  loadPlayerSettings,
  loadRumble,
  pushLibraryRecent,
  saveCarChoice,
  saveOnboarded,
  toggleLibraryFavorite,
  type LibraryKind,
  sanitizeDriverName,
  savePlayerSettings,
  saveRumble,
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
const DEFAULT_ASSIST_PRESET: AssistPreset = DEFAULT_PLAYER_SETTINGS.assistPreset;
/** Longest frame (s) simulated in full; must not exceed the physics' own F1Physics2026.MAX_CATCH_UP_S */
const MAX_FRAME_CATCH_UP_S = F1Physics2026.MAX_CATCH_UP_S;

// Keyboard-only input shaping: a key press becomes a pedal squeeze, not a step
/** A replay / flashback opens this far before the present, paused (s) */
const REPLAY_OPEN_BACK_S = 3;
const KB_THROTTLE_RISE_S = DEFAULT_KEYBOARD_TUNING.throttleRiseS;
const KB_THROTTLE_FALL_S = 0.1;
const KB_BRAKE_RISE_S = DEFAULT_KEYBOARD_TUNING.brakeRiseS;
const KB_BRAKE_FALL_S = 0.08;
// Rotates a camera (which looks down -Z) to look along the car's +Z forward axis
const CAM_FORWARD_FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const CAM_X_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * Session flow: assets loading → "press any key" → title menu → (first-run / controls setup) → driving.
 * Physics only runs while driving; the menus show the car idling on the grid under an orbiting camera.
 */
type AppPhase = "loading" | "title" | "wizard" | "driving";

/** The race on track with the player: none (practice), the AI field, or a multiplayer race; never two at once */
type SessionRace = { kind: "practice" } | { kind: "ai"; field: AiOpponentField } | { kind: "mp"; race: MultiplayerRace };
/** Why the run on track starts over (see resetRun) */
type RunResetReason = "session" | "restart" | "teleport" | "car" | "race" | "flashback";
/** The VR headset: off, being asked for a session, or presenting */
type VrState = "off" | "requesting" | "on";

/** Key actions that act while held, and the held-key flag each sets (the rest are one-shot actions) */
const HELD_KEYS = {
  throttle: "up",
  brake: "down",
  steerLeft: "left",
  steerRight: "right",
  throttleHalf: "half",
  boostHold: "boostHold",
} as const satisfies Partial<Record<KeyAction, string>>;
type HeldKeyAction = keyof typeof HELD_KEYS;
const isHeldKeyAction = (action: KeyAction): action is HeldKeyAction => Object.hasOwn(HELD_KEYS, action);
/** Held keys that take the car back from the autopilot (holding boost does not) */
const DRIVER_KEYS: ReadonlySet<HeldKeyAction> = new Set(["throttle", "brake", "steerLeft", "steerRight", "throttleHalf"]);

/** One-shot driving actions: the same whether they come from a key, a pad button or a touch pad */
type DriveAction = Exclude<KeyAction, HeldKeyAction> | "mfd" | "hud";

/** Telemetry-out rate (Hz) */
const TELEMETRY_OUT_HZ = 60;
/** A lap record's car: records are per vehicle model, named after its first car */
const vehicleLabel = (id: string) => (isVehicleModelId(id) ? carForVehicle(id).title : id);

/** A race the host started before this circuit was loaded (or on another one): picked up once the scene has loaded */
let pendingRaceStart: RaceStartInfo | null = null;
/** A multiplayer race while this guest has not yet measured the host's clock: the grid is held, the lights off */
const MP_CLOCK_UNSYNCED_FRAME: MultiplayerRaceFrame = { phase: "countdown", lightsOn: 0, countdownS: 0, raceTimeS: 0 };

/** A loading task with no progress for this long is given up on (the procedural stand-in stays) */
const ASSET_STALL_MS = 25_000;

/** Slicks or rain tyres for the line's water; a car on slicks keeps its own slick */
const autoCompoundFor = (lineWaterMm: number, current: TireCompound | undefined): TireCompound =>
  recommendedCompound(lineWaterMm, current && !isRainCompound(current) ? current : "soft");

const approach = (value: number, target: number, maxStep: number) =>
  value + Math.max(-maxStep, Math.min(maxStep, target - value));

/** The sound bank each car plays (the F1 cars share one bank) */
const soundFor = (car: CarId): CarSoundSource => carById(car).sound;
/** Runs `fn` when the browser is idle (Safari has no requestIdleCallback: a short timer instead) */
const scheduleIdle = (fn: (deadline?: IdleDeadline) => void) => {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(fn, { timeout: 500 });
  else window.setTimeout(() => fn(), 16);
};

export interface LibreCorsaSimulatorProps {
  /** Active circuit (already set with `setActiveTrack`; the gate remounts this component on a change) */
  trackId?: string;
  /** Title menu circuit picker */
  onSelectTrack?: (id: string) => void;
}

export const LibreCorsaSimulator: React.FC<LibreCorsaSimulatorProps> = ({ trackId = "rwanda", onSelectTrack }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const track = useMemo(() => getActiveTrackData(1200), []);
  /** The player's car: the VF26 (F1Physics2026) or the f12026-car (F12026CarSim) */
  const physicsRef = useRef<SimulatorCar | null>(null);
  /** The chosen car, and the vehicle model it drives on */
  const [carId, setCarId] = useState<CarId>(loadCarChoice);
  const carIdRef = useRef(carId);
  const [vehicleModel, setVehicleModel] = useState<VehicleModelId>(() => carPhysics(carId));
  const vehicleModelRef = useRef(vehicleModel);
  /** Swaps the player's car in the running scene (set by the scene effect) */
  const swapCarRef = useRef<((car: CarId) => void) | null>(null);
  const audioRef = useRef<F1AudioEngine2026 | null>(null);
  const carRigRef = useRef<SimCarRig | null>(null);
  const liveryRef = useRef<LiveryConfig>(LIVERIES[0]);
  const racingLineMeshRef = useRef<THREE.Mesh | null>(null);
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

  /**
   * An AI field built ahead, while the player is in the menus: building five AI cars (physics, autopilot plans) takes
   * a few hundred ms, which would otherwise be the first frame of the race. Only valid for the car it was built against.
   */
  const aiFieldSpareRef = useRef<{ field: AiOpponentField; physics: SimulatorCar } | null>(null);
  /** A new AI field round the player's car, at the player's chosen skill */
  const buildAiField = useCallback(
    (physics: SimulatorCar) => new AiOpponentField(track, physics, AI_DRIVERS, getTrackEnv(), { skill: settingsRef.current.aiSkill }),
    [track, getTrackEnv]
  );
  const prepareAiField = useCallback(() => {
    const run = () => {
      const physics = physicsRef.current;
      // Never while driving: the build would be a hitch on track instead
      if (!physics || phaseRef.current === "driving" || phaseRef.current === "loading") return;
      if (aiFieldSpareRef.current?.physics === physics) return;
      aiFieldSpareRef.current = { field: buildAiField(physics), physics };
    };
    scheduleIdle(run);
  }, [buildAiField]);
  /** The AI field for a race: the spare one when it was built for this car, else a new one */
  const takeAiField = useCallback(
    (physics: SimulatorCar) => {
      const spare = aiFieldSpareRef.current;
      aiFieldSpareRef.current = null;
      const skill = settingsRef.current.aiSkill;
      if (spare && spare.physics === physics) {
        if (spare.field.skill !== skill) spare.field.setSkill(skill);
        return spare.field;
      }
      return buildAiField(physics);
    },
    [buildAiField]
  );

  const [virtualMirrorOn, setVirtualMirrorOn] = useState(false);
  const [telemetry, setTelemetry] = useState<CarTelemetry>(() => {
    const tempPhys = new F1Physics2026(track);
    return { ...tempPhys.telemetry };
  });

  const [aeroPreset, setAeroPreset] =
    useState<AeroSetupPreset>(DEFAULT_AERO_PRESET);
  const [tireCompound, setTireCompound] = useState<TireCompound>("soft");
  // Starts from the physics defaults (read from a throwaway instance, as the telemetry seed does)
  // until the real physics exists; the effect below then swaps in the physics defaults and any saved setup
  const [defaultTyreSetup, setDefaultTyreSetup] = useState<TyreSetup>(() =>
    new F1Physics2026(track).getTyreSetup()
  );
  const [tyreSetup, setTyreSetup] = useState<TyreSetup>(defaultTyreSetup);
  const [chassisSetup, setChassisSetup] = useState<ChassisSetup>(DEFAULT_CHASSIS_SETUP);
  const [isMuted, setIsMuted] = useState(false);
  const [boostLatch, setBoostLatch] = useState(false);
  // The setters the toggle handlers call (defined further down)
  const setGamepadAssistEnabledRef = useRef<(enabled: boolean) => void>(() => {});
  const setRacingLineVisibleRef = useRef<(visible: boolean) => void>(() => {});
  const setMouseSteerRef = useRef<(enabled: boolean) => void>(() => {});
  const [gamepadRumble, setGamepadRumble] = useState<boolean>(loadRumble);
  const rumbleEnabledRef = useRef(gamepadRumble);
  rumbleEnabledRef.current = gamepadRumble;
  /** Pad rumble driven from the physics; created with the physics and silenced on pause / unmount */
  const hapticsRef = useRef<GamepadHaptics | null>(null);
  const [aiOpponents, setAiOpponents] = useState(false);
  const [paused, setPaused] = useState(false);
  /** Why the game paused itself (shown in the pause menu); cleared on resume */
  const [pauseNotice, setPauseNotice] = useState<string | null>(null);
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
  const assetsReadyRef = useRef(assetsReady);
  assetsReadyRef.current = assetsReady;
  /** The loading screen stays mounted while it fades out over the title menu */
  const [loadingVisible, setLoadingVisible] = useState(true);
  const [settings, setSettings] = useState<PlayerSettings>(DEFAULT_PLAYER_SETTINGS);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // The preferences the game applies to the car and the camera: `settings` is their only copy
  const assistPreset = settings.assistPreset;
  const showRacingLine = settings.racingLine;
  const gamepadAssist = settings.gamepadAssist;
  const autoGearbox = settings.autoGearbox;
  const mouseSteerEnabled = settings.mouseSteer;
  const selectedLivery = useMemo(() => LIVERIES.find((l) => l.id === settings.liveryId) ?? LIVERIES[0], [settings.liveryId]);
  const cameraMode: CameraMode = settings.camera ?? "chase";
  const setPreference = useCallback(<K extends keyof PlayerSettings>(key: K, value: PlayerSettings[K]) => {
    setSettings((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);
  const setCameraMode = useCallback((mode: CameraMode) => setPreference("camera", mode), [setPreference]);
  // Current values for the toggle handlers
  const gamepadAssistRef = useRef(gamepadAssist);
  gamepadAssistRef.current = gamepadAssist;
  const showRacingLineRef = useRef(showRacingLine);
  showRacingLineRef.current = showRacingLine;
  /** Player's driver's-eye FOV (null = the car's own), read by the render loop */
  const cockpitFovRef = useRef<number | null>(settings.cockpitFovDeg);
  cockpitFovRef.current = settings.cockpitFovDeg;
  /** The current car's own driver's-eye FOV, for the FOV slider's default and the [ / ] keys */
  const [carCockpitFov, setCarCockpitFov] = useState(FALLBACK_COCKPIT_FOV_DEG);
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
  const assistSettingsRef = useRef<SteeringAssistSettings>(DEFAULT_STEERING_ASSIST);
  assistSettingsRef.current = useMemo(
    () => steeringAssistSettings(settings.padTuning, settings.keyboardTuning),
    [settings.padTuning, settings.keyboardTuning]
  );
  /** The car's steering lock (road-wheel degrees, after the garage's ratio), for the assist menus' countersteer slider */
  const [steerLockDeg, setSteerLockDeg] = useState<number | undefined>(undefined);
  const steerLockDegRef = useRef(steerLockDeg);
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
  /** Bumped by every new or closed lap card and every upload: only the upload of the card still shown may land on it */
  const submitReqRef = useRef(0);
  const [driverKeyNotice, setDriverKeyNotice] = useState<string | null>(null);
  /** Ghost being raced: the personal best (default) or a downloaded / imported lap */
  const ghostRef = useRef<GhostPlayer | null>(null);
  const ghostSourceRef = useRef<"pb" | "other">("pb");
  /** Bumped by every ghost choice, so a slower PB load cannot replace a ghost picked after it started */
  const ghostReqRef = useRef(0);
  /** Bumped by every leaderboard refresh; only the latest one updates the panel */
  const leaderboardReqRef = useRef(0);
  const [leaderboard, setLeaderboard] = useState<{
    local: LeaderboardEntry[];
    remote: LeaderboardEntry[];
    loading: boolean;
    /** Label of the online board shown: the assists and surface it ranks */
    boardLabel?: string;
    /** The last online fetch failed (its list is empty for that reason, not because nobody has a time) */
    remoteError: boolean;
  }>({
    local: [],
    remote: [],
    loading: false,
    remoteError: false,
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
  /** The headset session for the menus; the render loop itself follows renderer.xr.isPresenting, which this tracks */
  const [vrState, setVrStateUi] = useState<VrState>("off");
  const vrStateRef = useRef<VrState>("off");
  const setVrState = useCallback((next: VrState) => {
    vrStateRef.current = next;
    setVrStateUi(next);
  }, []);
  const enterVrRef = useRef<(() => void) | null>(null);
  const [ffbMeter, setFfbMeter] = useState(wheelFfb.meter);
  const [touchVisible, setTouchVisible] = useState(false);
  /** Applies the graphics preset to the running renderer (set by the scene effect) */
  const applyGraphicsRef = useRef<((quality: "low" | "medium" | "high", renderScale: number) => void) | null>(null);
  /** Enters / leaves / flashbacks the instant replay (set by the scene effect) */
  const toggleReplayRef = useRef<() => void>(() => {});
  const exitReplayRef = useRef<() => void>(() => {});
  const flashbackReplayRef = useRef<() => void>(() => {});

  const cameraModeRef = useRef<CameraMode>("chase");
  cameraModeRef.current = cameraMode;
  /** The next view in the camera cycle, from the key, the pad, the touch pads and the menus alike */
  const cycleCamera = useCallback(() => setCameraMode(nextCameraMode(cameraModeRef.current)), []);

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
  /** Ramped keyboard pedals 0..1 (the steering keys are shaped by the car's steering assist) */
  const kbInputRef = useRef({ throttle: 0, brake: 0 });
  /** Slip help on the keyboard's pedals while the car's ABS / traction control is off */
  const kbPedalAssistRef = useRef(new KeyboardPedalAssist());
  /** Lets go of every held driving key: on pause, and when the window loses focus (its keyups never arrive) */
  const releaseHeldKeys = useCallback(() => {
    const k = keysRef.current;
    for (const flag of Object.values(HELD_KEYS)) k[flag] = false;
    kbInputRef.current.throttle = 0;
    kbInputRef.current.brake = 0;
    kbPedalAssistRef.current.reset();
  }, []);

  /** The boost latch, for the frame loop (ref) and the HUD (state) at once */
  const setLatch = useCallback((on: boolean) => {
    boostLatchRef.current = on;
    setBoostLatch(on);
  }, []);

  // ---- Session and run: the one place that starts, restarts and leaves what is on track
  /**
   * Bumped whenever the run on track starts over (see resetRun) and written into the telemetry every frame, so
   * anything holding lap- or run-scoped state (race control's track limits) starts over with it.
   */
  const runIdRef = useRef(0);

  /**
   * The run starts over: a new session, a restart or reset, a corner jump, a car change, AI opponents on or off, a
   * flashback. It never moves the car: the caller places it afterwards, so leaving the replay (which puts the drawn
   * car back where the replay found it) comes first and can't undo the move. A flashback keeps its own trimmed
   * replay and the race results.
   */
  const resetRun = useCallback((reason: RunResetReason) => {
    runIdRef.current++;
    if (reason !== "flashback") {
      exitReplayRef.current();
      replayRef.current.buffer.clear();
      setResultsClosed(false);
    }
    lapRecorderRef.current?.reset();
    if (physicsRef.current) physicsRef.current.aiAutopilot = false;
    kbInputRef.current.throttle = 0;
    kbInputRef.current.brake = 0;
    kbPedalAssistRef.current.reset();
  }, []);

  /** Puts a race on track with the player (or none): the AI field and a multiplayer race never run together */
  const setRace = useCallback((next: SessionRace) => {
    aiFieldRef.current = next.kind === "ai" ? next.field : null;
    mpRaceRef.current = next.kind === "mp" ? next.race : null;
    setAiOpponents(next.kind === "ai");
    setMpRaceRunning(next.kind === "mp");
  }, []);

  /** What belongs to a whole session: the lap card and its upload, the pause and its notice, the boost latch, the hint */
  const clearSessionState = useCallback(() => {
    submitReqRef.current++;
    setLapSummary(null);
    setSubmitState("idle");
    setSubmitRank(null);
    setSubmitError(null);
    setPauseNotice(null);
    setLatch(false);
    setLaunchHint(false);
    pausedRef.current = false;
    setPaused(false);
  }, [setLatch]);

  /**
   * A session starts on track: practice, a race against the AI field, or a multiplayer race. The caller places the
   * car (and starts the field) afterwards.
   */
  const startSession = useCallback(
    (race: SessionRace) => {
      resetRun("session");
      setRace(race);
      clearSessionState();
      setPhase("driving");
    },
    [resetRun, setRace, clearSessionState, setPhase]
  );

  /**
   * The multiplayer race ends here: the host aborted it (the manager already knows), or the player left it
   * (`tellManager`). Driving goes on, alone.
   */
  const endMpRace = useCallback(
    (tellManager: boolean) => {
      if (!mpRaceRef.current) return;
      // A host who has taken the flag leaves the others to finish: their race goes on, only this client steps out.
      // A host leaving mid-race (or once everyone is classified) ends it for all, as an abort.
      const race = physicsRef.current?.telemetry.race;
      const othersStillRacing = race?.phase === "finished" && !race.resultsFinal;
      const leaveForAll = tellManager && !(isMpHostRef.current && othersStillRacing);
      // Off the race before the manager hears: a host's leave comes back as an abort, which must find nothing to end
      setRace({ kind: "practice" });
      if (leaveForAll) getMultiplayerManager().leaveRace();
      resetRun("race");
    },
    [setRace, resetRun]
  );

  /** Leaves the car for the title menu: out of any race (the multiplayer one properly), the car back on the grid */
  const leaveSession = useCallback(() => {
    endMpRace(true);
    resetRun("session");
    setRace({ kind: "practice" });
    clearSessionState();
    physicsRef.current?.resetToStartGrid(false);
    setPhase("title");
  }, [endMpRace, resetRun, setRace, clearSessionState, setPhase]);

  // For the scene effect, which must not rebuild for them
  const resetRunRef = useRef(resetRun);
  resetRunRef.current = resetRun;
  const setRaceRef = useRef(setRace);
  setRaceRef.current = setRace;

  // Read through a ref so unlockAudio stays stable: the scene effect depends on it and must not rebuild on mute
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;
  const unlockAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new F1AudioEngine2026();
      audioRef.current.setCar(soundFor(carIdRef.current));
      // Created paused unless the car is being driven; from then on the frame loop alone pauses and resumes it
      audioRef.current.setPaused(pausedRef.current || phaseRef.current !== "driving");
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
    setPreference("assistPreset", preset);
    if (physicsRef.current) {
      physicsRef.current.assistPreset = preset;
    }
  }, []);

  // The toggles read the current value from a ref and apply their effects in the handler, not inside a state
  // updater (React may run those twice, or after the call)
  const handleToggleGamepadAssist = useCallback(() => {
    setGamepadAssistEnabledRef.current(!gamepadAssistRef.current);
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

  /** Swaps the player's car (the run starts over with it); the player's own pick goes through handleChangeCar */
  const changeCar = useCallback(
    (next: CarId) => {
      unlockAudio();
      if (next === carIdRef.current) return;
      carIdRef.current = next;
      setCarId(next);
      vehicleModelRef.current = carPhysics(next);
      setVehicleModel(vehicleModelRef.current);
      saveCarChoice(next);
      swapCarRef.current?.(next);
      audioRef.current?.setCar(soundFor(next));
    },
    [unlockAudio]
  );
  /** The car picker: the car is fixed for a multiplayer race (its start picks one the class allows) */
  const handleChangeCar = useCallback(
    (next: CarId) => {
      if (mpRaceRef.current) return;
      changeCar(next);
    },
    [changeCar]
  );

  // The car picker's physics switch: a ported F1 car moves onto the other vehicle model, in place (body kept)
  useEffect(
    () =>
      subscribeF1ModPhysics(() => {
        const car = carIdRef.current;
        if (!carTakesPhysicsSwitch(car)) return;
        const vehicle = carPhysics(car);
        if (vehicle === vehicleModelRef.current) return;
        vehicleModelRef.current = vehicle;
        setVehicleModel(vehicle);
        swapCarRef.current?.(car);
      }),
    []
  );

  const handleLiveryChange = useCallback((livery: LiveryConfig) => {
    setPreference("liveryId", livery.id);
    liveryRef.current = livery;
    carRigRef.current?.setLivery(livery);
  }, []);

  const handleToggleRacingLine = useCallback(() => {
    setRacingLineVisibleRef.current(!showRacingLineRef.current);
  }, []);

  const handleToggleMute = useCallback(() => {
    unlockAudio();
    const next = !isMutedRef.current;
    isMutedRef.current = next;
    setIsMuted(next);
    audioRef.current?.setMuted(next);
  }, [unlockAudio]);

  /** The autopilot drives the player's car; never in a multiplayer race */
  const toggleAutopilot = useCallback(() => {
    const physics = physicsRef.current;
    if (!physics || mpRaceRef.current) return;
    physics.aiAutopilot = !physics.aiAutopilot;
    if (physics.aiAutopilot && physics.vxMs < 5) physics.vxMs = 45;
  }, []);
  const handleToggleAiAutopilot = useCallback(() => {
    unlockAudio();
    toggleAutopilot();
  }, [unlockAudio, toggleAutopilot]);

  // The on-screen aero button sends the same input as the key, pad and touch button (the car toggles on it)
  const handleToggleXMode = useCallback(() => {
    unlockAudio();
    keysRef.current.toggleX = true;
  }, [unlockAudio]);

  const handleToggleBoostLatch = useCallback(() => {
    unlockAudio();
    setLatch(!boostLatchRef.current);
  }, [unlockAudio, setLatch]);

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
    setMouseSteerRef.current(!mouseSteerEnabledRef.current);
  }, [unlockAudio]);

  /** This client hosts the multiplayer lobby (the one derivation: the lobby's host is us) */
  const isMpHostRef = useRef(false);

  const handleResetCar = useCallback(
    (flyingStart: boolean) => {
      unlockAudio();
      // In a multiplayer race only the host can restart it (for everyone); others keep their place
      if (mpRaceRef.current) {
        if (isMpHostRef.current && !flyingStart) getMultiplayerManager().startRace();
        return;
      }
      const physics = physicsRef.current;
      if (!physics) return;
      resetRun("restart");
      if (aiFieldRef.current) aiFieldRef.current.startRace(!flyingStart);
      else physics.resetToStartGrid(flyingStart);
    },
    [unlockAudio, resetRun]
  );

  const handleToggleAiOpponents = useCallback(() => {
    unlockAudio();
    const physics = physicsRef.current;
    // Not in a multiplayer race: the AI field would run alongside it
    if (!physics || mpRaceRef.current) return;
    resetRun("race");
    if (aiFieldRef.current) {
      setRace({ kind: "practice" });
      return;
    }
    const field = takeAiField(physics);
    setRace({ kind: "ai", field });
    field.startRace(true);
  }, [takeAiField, unlockAudio, resetRun, setRace]);

  const handleSelectTurn = useCallback(
    (turnNumber: number) => {
      unlockAudio();
      const physics = physicsRef.current;
      if (!physics || mpRaceRef.current) return;
      resetRun("teleport");
      // Corner practice leaves the race: the field would otherwise lose track of the player's distance
      if (aiFieldRef.current) setRace({ kind: "practice" });
      physics.teleportToTurn(turnNumber);
    },
    [unlockAudio, resetRun, setRace]
  );

  // The page's one multiplayer manager (it outlives this component across circuit switches)
  const handleHostP2PRoom = useCallback((customCode?: string) => getMultiplayerManager().hostRoom(customCode), []);
  const handleJoinP2PRoom = useCallback((roomCode: string) => getMultiplayerManager().joinRoom(roomCode), []);
  const handleCreateManualOffer = useCallback(() => getMultiplayerManager().createManualOffer(), []);
  const handleAcceptManualOffer = useCallback(
    (offerToken: string) => getMultiplayerManager().acceptManualOfferAndCreateAnswer(offerToken),
    []
  );
  const handleAcceptManualAnswer = useCallback(async (answerToken: string) => {
    await getMultiplayerManager().acceptManualAnswer(answerToken);
    return true;
  }, []);

  const handleHostLocal = useCallback(() => getMultiplayerManager().hostLocal(), []);
  const handleSetLobbySettings = useCallback((patch: Partial<LobbySettings>) => getMultiplayerManager().setLobbySettings(patch), []);
  const handleSetReady = useCallback((ready: boolean) => getMultiplayerManager().setReady(ready), []);
  const handleStartMpRace = useCallback(() => {
    getMultiplayerManager().startRace();
  }, []);
  const handleAbortMpRace = useCallback(() => getMultiplayerManager().abortRace(), []);

  /** Esc / pad Menu: open or close the pause menu, releasing every held key */
  const togglePause = useCallback(() => {
    // From the ref the frame loop reads, with the side effects here rather than inside a state updater (which React
    // may run twice, or later than this call)
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (!next) setPauseNotice(null);
    if (next) {
      wheelFfb.stop();
      releaseHeldKeys();
    }
  }, [releaseHeldKeys]);
  const togglePauseRef = useRef(togglePause);
  togglePauseRef.current = togglePause;

  const setRacingLineVisible = useCallback((visible: boolean) => {
    showRacingLineRef.current = visible;
    setPreference("racingLine", visible);
    if (racingLineMeshRef.current) racingLineMeshRef.current.visible = visible;
  }, []);
  setRacingLineVisibleRef.current = setRacingLineVisible;

  const setGamepadAssistEnabled = useCallback((enabled: boolean) => {
    gamepadAssistRef.current = enabled;
    setPreference("gamepadAssist", enabled);
    if (physicsRef.current) physicsRef.current.gamepadAssistEnabled = enabled;
  }, []);
  setGamepadAssistEnabledRef.current = setGamepadAssistEnabled;

  const setAutoGearbox = useCallback((enabled: boolean) => {
    setPreference("autoGearbox", enabled);
    if (physicsRef.current) physicsRef.current.autoGearbox = enabled;
  }, []);

  const setMouseSteer = useCallback((enabled: boolean) => {
    mouseSteerEnabledRef.current = enabled;
    setPreference("mouseSteer", enabled);
    if (!enabled) mouseSteerValueRef.current = 0;
  }, []);
  setMouseSteerRef.current = setMouseSteer;

  const handleChangeSettings = useCallback((update: (prev: PlayerSettings) => PlayerSettings) => {
    setSettings((prev) => update(prev));
  }, []);

  /** Car and circuit browsers: stars, saved with the settings */
  const handleToggleFavorite = useCallback((kind: LibraryKind, ids: readonly string[]) => {
    setSettings((prev) => ({ ...prev, library: toggleLibraryFavorite(prev.library, kind, ids) }));
  }, []);
  const library = useMemo(() => ({ library: settings.library, onToggleFavorite: handleToggleFavorite }), [settings.library, handleToggleFavorite]);

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
      const car = physicsRef.current;
      const autoCompound = autoCompoundFor(env.weather.lineWaterMm, car?.tireCompound);
      if (car && car.tireCompound !== autoCompound) handleTireCompoundChange(autoCompound);
    }
  }, [conditionsKey, getTrackEnv, handleTireCompoundChange]);
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
      const field = race && physics ? (aiFieldRef.current ?? takeAiField(physics)) : null;
      startSession(field ? { kind: "ai", field } : { kind: "practice" });
      if (field) field.startRace(true);
      else physics?.resetToStartGrid(false);
      setLaunchHint(true);
    },
    [takeAiField, startSession]
  );

  // In the menus (after loading, after a race, after a car change): have the next race's AI field ready.
  // The car swap replaces the physics in an effect; the timer lets it land first.
  useEffect(() => {
    if (phase === "loading" || phase === "driving" || !assetsReady) return;
    const id = window.setTimeout(prepareAiField, 300);
    return () => window.clearTimeout(id);
  }, [phase, carId, assetsReady, prepareAiField]);

  /** A multiplayer race was started (by us as host, or by the host): line up in our grid slot behind the lights */
  const startMpRace = useCallback(
    (start: RaceStartInfo) => {
      const mp = getMultiplayerManager();
      const roster = mp.lobby?.players ?? [];
      const profile = settingsRef.current.profile;
      const race = new MultiplayerRace(start, track.totalLengthM, mp.localPeerId, profile, roster);
      startSession({ kind: "mp", race });
      // The class may rule out the current car: take the first allowed one (after the session reset, so the swap
      // finds no replay or AI field to carry over)
      const allowed = vehicleModelsFor(start.carClass);
      if (!allowed.includes(vehicleModelRef.current)) changeCar(carForVehicle(allowed[0]).id);
      getTrackEnv().reset();
      const physics = physicsRef.current;
      if (physics) {
        physics.resetToStartGrid(false, race.gridSlot);
        race.lapClock.reset(physics.sMeters);
      }
    },
    [track, getTrackEnv, changeCar, startSession]
  );
  const startMpRaceRef = useRef(startMpRace);
  startMpRaceRef.current = startMpRace;

  /**
   * Takes up a race the host started on this circuit. Before the circuit has loaded it waits (the scene picks it up
   * once ready); loaded but still on the loading screen, it starts straight away from there.
   */
  const takeRaceStart = useCallback(
    (start: RaceStartInfo) => {
      if (phaseRef.current === "loading") {
        if (!assetsReadyRef.current) {
          pendingRaceStart = start;
          return;
        }
        unlockAudio();
        setLoadingVisible(false);
      }
      startMpRaceRef.current(start);
    },
    [unlockAudio]
  );

  // ---- Laps, ghosts, leaderboards
  /** The board for what the player drives with now: their assists and realism, today's surface, this physics revision */
  const currentBoard = useCallback(
    (): LapConditions =>
      lapConditionsNow({
        assists: physicsRef.current?.assistPreset ?? DEFAULT_ASSIST_PRESET,
        compound: physicsRef.current?.tireCompound ?? "soft",
        lineWaterMm: getTrackEnv().weather.lineWaterMm,
        realism: settingsRef.current.realism,
      }),
    [getTrackEnv]
  );
  const refreshLeaderboard = useCallback(async () => {
    // Several refreshes can overlap (car change, realism change, a saved lap): only the latest may land
    const req = ++leaderboardReqRef.current;
    setLeaderboard((l) => ({ ...l, loading: true }));
    const vehicle = vehicleModelRef.current;
    const board = currentBoard();
    let remoteError = false;
    const [local, remote] = await Promise.all([
      localLeaderboard(trackId, vehicle, lapBoardClass(board)).catch((): LeaderboardEntry[] => []),
      remoteLeaderboardEnabled
        ? fetchRemoteLeaderboard(trackId, vehicle, lapBoardClass(board)).catch((): LeaderboardEntry[] => {
            remoteError = true;
            return [];
          })
        : Promise.resolve<LeaderboardEntry[]>([]),
    ]);
    if (req !== leaderboardReqRef.current) return;
    setLeaderboard({ local, remote, loading: false, boardLabel: boardLabel(board), remoteError });
  }, [trackId, currentBoard]);
  // Another realism level ranks on another board (the first fetch comes from the car effect below)
  const realismSeenRef = useRef(settings.realism);
  useEffect(() => {
    if (realismSeenRef.current === settings.realism) return;
    realismSeenRef.current = settings.realism;
    void refreshLeaderboard();
  }, [settings.realism, refreshLeaderboard]);

  /** Races the personal best of this car as the ghost, replacing whichever lap was chosen */
  const loadPbGhost = useCallback(async () => {
    // A ghost picked (or another car's PB requested) while this one loads wins over it
    const req = ++ghostReqRef.current;
    // The best on the board the player is driving now (an assisted best is not their pro reference)
    const rec = await loadBestLap(trackId, vehicleModelRef.current, lapBoardClass(currentBoard())).catch(() => null);
    if (req !== ghostReqRef.current) return;
    ghostSourceRef.current = "pb";
    // A best from an earlier version of the circuit is moved onto this one
    ghostRef.current = rec ? new GhostPlayer(alignGhostToTrack(rec, track).recording) : null;
    lapRecorderRef.current?.setContext({ personalBestMs: rec?.lapTimeMs ?? null });
  }, [trackId, currentBoard, track]);

  const onLapCompleted = useCallback(
    (summary: LapSummaryData, recording: LapRecording) => {
      if (settingsRef.current.hud.lapSummary) {
        // A new card: an upload still out for the last one must not land on it
        submitReqRef.current++;
        setLapSummary({ summary, recording });
        setSubmitState("idle");
        setSubmitRank(null);
        setSubmitError(null);
      }
      if (!summary.valid || summary.autopilot) return;
      // A ghost chosen (or another car's best requested) while this saves wins over it
      const ghostReq = ghostReqRef.current;
      void saveBestLapIfFaster(recording)
        .then((saved) => {
          if (!saved) return;
          if (ghostSourceRef.current === "pb" && ghostReq === ghostReqRef.current && recording.vehicle === vehicleModelRef.current) {
            // Newer than any best still loading from before this lap
            ghostReqRef.current++;
            ghostRef.current = new GhostPlayer(recording);
          }
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
    const req = ++submitReqRef.current;
    setSubmitState("sending");
    const res = await submitLap(rec).catch((): { ok: boolean; rank?: number; error?: string } => ({ ok: false }));
    if (res.ok) void refreshLeaderboard();
    // The card was closed or replaced by another lap meanwhile: this answer is not about the one shown
    if (req !== submitReqRef.current) return;
    setSubmitState(res.ok ? "sent" : "error");
    setSubmitRank(res.ok ? (res.rank ?? null) : null);
    setSubmitError(res.ok ? null : (res.error ?? null));
  }, [lapSummary, refreshLeaderboard]);
  const closeLapSummary = useCallback(() => {
    submitReqRef.current++;
    setLapSummary(null);
  }, []);

  /** Uses a lap from the leaderboard (or a file) as the ghost */
  const raceGhost = useCallback((rec: LapRecording | null) => {
    if (!rec) return;
    ghostReqRef.current++;
    // A lap from another version of the circuit (a downloaded or older file) is moved onto this one
    ghostRef.current = new GhostPlayer(alignGhostToTrack(rec, track).recording);
    ghostSourceRef.current = "other";
    setSettings((prev) => (prev.ghost ? prev : { ...prev, ghost: true }));
  }, [track]);

  const handleRaceGhostEntry = useCallback(
    async (entry: LeaderboardEntry) => {
      const rec =
        entry.source === "remote" && entry.id
          ? await fetchRemoteGhost(entry.id).catch(() => null)
          : await loadBestLap(entry.trackId, entry.vehicle, entry.conditions ? lapBoardClass(entry.conditions) : null).catch(() => null);
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
    const rec = await loadBestLap(trackId, vehicleModelRef.current, lapBoardClass(currentBoard())).catch(() => null);
    if (rec) exportLapFile(rec);
  }, [trackId, currentBoard]);

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
  /** The title menu's panel on its next visit (back to the lobby after a race); used up once the title is left */
  const [titleInitialPanel, setTitleInitialPanel] = useState<"multiplayer" | null>(null);
  const handleBackToLobby = useCallback(() => {
    setTitleInitialPanel("multiplayer");
    leaveSession();
  }, [leaveSession]);

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

  /** "Press any key" on the loading screen: the user gesture that unlocks audio */
  const handleLoadingStart = useCallback(() => {
    unlockAudio();
    // A race taken up from the loading screen has already left it: never send that session to the title
    if (phaseRef.current !== "loading") return;
    setPhase("title");
    if (inviteRoom) getMultiplayerManager().joinRoom(inviteRoom);
  }, [unlockAudio, setPhase, inviteRoom]);
  const handleLoadingDone = useCallback(() => setLoadingVisible(false), []);

  // The title opens on the lobby by itself once (back to the lobby, or a ?room= invite): used up when the title is left
  const prevPhaseRef = useRef(phase);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (prev === "title" && phase !== "title") {
      setTitleInitialPanel(null);
      setInviteRoom(null);
    }
  }, [phase]);

  // The first-drive hint clears once the car is moving (or after a while)
  useEffect(() => {
    if (!launchHint) return;
    const id = window.setTimeout(() => setLaunchHint(false), 15_000);
    return () => window.clearTimeout(id);
  }, [launchHint]);
  useEffect(() => {
    if (launchHint && telemetry.speedKmh > 15) setLaunchHint(false);
  }, [launchHint, telemetry.speedKmh]);

  // Silence the pad rumble and FFB as soon as the pause menu opens or the car is left for the menus (the car audio
  // follows the frame loop, which pauses it on every frame the car is not driven, in every phase)
  useEffect(() => {
    const silence = paused || phase !== "driving";
    if (silence) {
      hapticsRef.current?.stop();
      wheelFfb.stop();
    }
  }, [paused, phase]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    // A circuit switch remounts this component: its track and warm-up load again (the car models stay cached)
    assetProgress.reset(["track", "opponents", "shaders"]);
    // The engine sound downloads alongside (decoded once the first key press unlocks audio)
    prefetchSoundBank(soundFor(carIdRef.current).assetDir);
    /** The authored track once the GLB is loaded: the f12026-car drives on its Track_Collider_* meshes */
    let trackRoot: THREE.Object3D | null = null;

    /**
     * A car of the chosen model on the start grid, with the session's presets carried over from `prev`
     * (defaults for the first car) and that car's saved tyre setup
     */
    const createCar = (vehicle: VehicleModelId, prev: SimulatorCar | null, carId: CarId = carIdRef.current): SimulatorCar => {
      const car = vehicleModelSpec(vehicle).createSim(track, trackRoot);
      // The overtaking aids of the car's season, and race control for them while a race is on (free in practice)
      const season = carById(carId).season;
      if (season !== undefined) car.setOvertakingRules?.(overtakingRulesForSeason(season));
      if (car.overtakingRules) {
        const self = car;
        car.raceControl = {
          get racing() {
            const mpRace = mpRaceRef.current;
            return mpRace ? mpRace.raceRulesActive : (aiFieldRef.current?.raceRulesActive ?? false);
          },
          earnedAtDetection: () => {
            const mpRace = mpRaceRef.current;
            return mpRace ? mpRace.detectionEarnedFor(self) : (aiFieldRef.current?.detectionEarnedFor(self) ?? true);
          },
        };
      }
      car.aiAutopilot = false;
      // The player's preferences from their settings; the aero package and the tyre on from the car before
      const prefs = settingsRef.current;
      car.assistPreset = prefs.assistPreset;
      car.gamepadAssistEnabled = prefs.gamepadAssist;
      car.autoGearbox = prefs.autoGearbox;
      car.aeroPreset = prev?.aeroPreset ?? DEFAULT_AERO_PRESET;
      if (prev) {
        car.tireCompound = prev.tireCompound;
      } else {
        car.tireCompound = autoCompoundFor(getTrackEnv().weather.lineWaterMm, car.tireCompound);
        setTireCompound(car.tireCompound);
      }
      car.resetToStartGrid(false);

      // Capture the car's defaults first, then apply its saved tyre setup (if any)
      const tyreDefaults = car.getTyreSetup();
      const initialTyreSetup = loadTyreSetup(vehicle) ?? tyreDefaults;
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
      // The run starts over before the old car goes: leaving the replay writes its saved pose into `physics`, which
      // must still be the old car then. The replay and the live delta belong to the old car.
      resetRunRef.current("car");
      const vehicle = carPhysics(car);
      physics = createCar(vehicle, physics, car);
      physicsRef.current = physics;
      swapCarRig(car);
      prefetchSoundBank(soundFor(car).assetDir);
      lapRecorderRef.current?.setContext({ vehicle });
      lapDelta.reset();
      // A running race restarts from the lights with the new car
      if (aiFieldRef.current) {
        const field = takeAiField(physics);
        if (trackRoot) field.attachTrackRoot(trackRoot);
        setRaceRef.current({ kind: "ai", field });
        field.startRace(true);
      }
      setTelemetry({ ...physics.telemetry });
    };

    const haptics = new GamepadHaptics();
    hapticsRef.current = haptics;

    const scene = new THREE.Scene();
    // The scene root never moves: left to update its own matrix, it forced every object's world matrix to be
    // recomputed on every render call (static-scene.ts freezes the circuit itself)
    scene.matrixAutoUpdate = false;

    const camera = new THREE.PerspectiveCamera(
      FALLBACK_COCKPIT_FOV_DEG,
      container.clientWidth / Math.max(1, container.clientHeight),
      0.12,
      5500
    );
    // The view camera also draws the driving aids (the racing line), which the probe and mirrors leave out
    camera.layers.enable(OVERLAY_LAYER);

    const renderer = new THREE.WebGLRenderer({
      // MSAA happens in the post-processing composer's half-float target instead
      antialias: false,
      stencil: false,
      powerPreference: "high-performance",
      // Float precision across the 0.12 m .. 5.5 km depth range (kerbs, lines and decals stop z-fighting at
      // distance). three falls back to the standard buffer without EXT_clip_control; ?depth=standard forces it.
      reversedDepthBuffer: new URLSearchParams(window.location.search).get("depth") !== "standard",
    });
    // AgX exposure, pixel ratio clamp and shadow type; set before the composer is created
    configureRenderer(renderer);
    renderer.setSize(container.clientWidth, container.clientHeight);

    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    // Golden-hour sky dome, its baked PMREM environment, horizon fog and the cascaded sun shadow
    const env = createGoldenHourEnvironment(renderer, scene);
    // Rain streaks around the camera (one GPU-animated draw, hidden in the dry)
    const rainFx = createRainFx(scene);
    // Scene render + one merged effect pass (mipmap bloom, then AgX tone mapping)
    const postFx = createPostFx(renderer, scene, camera);
    // Live reflections of the world on the cars (High / Medium); Low keeps the sky's
    const reflectionProbe = new CarReflectionProbe(renderer, scene);
    // `?perf=1`: a report of the first 30 s on track (startup-monitor.ts)
    const startupMonitor = StartupMonitor.requested() ? new StartupMonitor(renderer) : null;
    reflectionProbe.setSky(env.sky);
    // Top-centre virtual rear-view mirror for the views without wing mirrors in shot
    const virtualMirror = new VirtualMirror(renderer, scene);
    let virtualMirrorShown = false;

    const builtCircuit = buildCircuitScene(track);
    scene.add(builtCircuit.sceneGroup);
    racingLineMeshRef.current = builtCircuit.racingLineMesh;
    // Track_Collider_Road / surface colliders and Track_Collider_Wall_* barriers for the f12026-car
    void builtCircuit.trackRoot.then((root) => {
      if (disposed) return;
      trackRoot = root;
      physics.attachTrackRoot?.(root);
      aiFieldRef.current?.attachTrackRoot(root);
      aiFieldSpareRef.current?.field.attachTrackRoot(root);
      // Move broadcast cameras that would film the inside of a grandstand: about a second of raycasts on a scan,
      // spread over idle slices so neither the loading screen nor the menus freeze (until done, the TV view uses
      // the stations as built)
      const occlusion = tvDirector.occlusionSteps(root);
      const occlusionSlice = (deadline?: IdleDeadline) => {
        if (disposed) return;
        // On track only true idle time counts: a slice the browser forces after its timeout would be a hitch
        const driving = phaseRef.current === "driving";
        const idleMs = deadline?.timeRemaining() ?? 8;
        if (!driving || idleMs >= 3) {
          const until = performance.now() + (driving ? Math.min(idleMs, 6) : Math.max(4, Math.min(12, idleMs)));
          startupMonitor?.begin();
          try {
            do {
              if (occlusion.next().done) return;
            } while (performance.now() < until);
          } finally {
            startupMonitor?.end("idle");
          }
        }
        if (driving && typeof window.requestIdleCallback === "function") window.requestIdleCallback(occlusionSlice);
        else scheduleIdle(occlusionSlice);
      };
      scheduleIdle(occlusionSlice);
      const ground = trackColliders(root).ground;
      if (ground) builtCircuit.seatRacingLine(ground);
    });

    /**
     * The 3D car: a ported car's own GLB on the generic rig, else the vehicle model's own car
     */
    // The body follows the car's registry model, not `carPhysics`: a ported F1 car switched to the VF26 physics
    // keeps the geometry it was fitted to
    const rigModel = (car: CarId) => vehicleModelSpec(carById(car).physics);
    const createCarRig = (car: CarId): SimCarRig => {
      const def = carById(car);
      const model = rigModel(car);
      const rig = def.modelUrl
        ? createPortedCarRig({
            url: def.modelUrl,
            chassis: model.rigConfig.chassis,
            // the rim on screen turns with the player's own (its lock is the player's when they set one)
            steerLockDeg: carWheelLockDeg(def.physics, settingsRef.current.wheel.steerLockPerCar) / 2,
            floor: staticFloorOf(model.rigConfig),
            // every GT3 uses the AMG GT3's onboard and chase views, framed on its own steering wheel and front axle
            cameraAnchors: model.gt3Cockpit ? gt3RigCameraAnchors : undefined,
            pirelliSidewall: def.season === 2026,
          })
        : model.gt3Cockpit
          ? createGt3CarRig()
          : createF1Car2026(liveryRef.current, physics.tireCompound);
      rig.setLivery(liveryRef.current);
      rig.setTireCompound(physics.tireCompound);
      reflectionProbe.track(rig.root);
      addContactShadow(rig.root, def.physics);
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
      vf26ExtrasFor = null;
      gt3Dash?.dispose();
      gt3Dash = null;
      reflectionProbe.untrack(carRig.root);
      carRig.dispose();
      // Free the old car's GPU memory: switching cars otherwise stacks every model's textures on the GPU
      disposeTree(carRig.root);
      carRig = createCarRig(car);
      carRigCar = car;
      // A different model for the opponents and the ghost: build and compile them now, not at the next race start
      void visualFx.prewarm(carPhysics(car)).then(() => {
        if (disposed) return;
        void compileForComposer().finally(() => visualFx.hidePrewarmed());
      });
    };

    // Persistent 4-Wheel Skidmarks, Instanced Tire Smoke/Gravel & Multiplayer/AI Opponent Renderer
    const visualFx = new SimVisualFxManager();
    scene.add(visualFx.group);
    // The opponents and the ghost reflect the world too
    reflectionProbe.track(visualFx.group);
    void visualFx.prewarm(carPhysics(carIdRef.current));
    // One connection for the page: it survives a circuit switch (which remounts this component)
    const multiplayerSync = getMultiplayerManager();
    multiplayerSync.onStatusChange = (st) => {
      setP2pStatus(st);
    };
    setP2pStatus(multiplayerSync.status);

    // Lap recording for the summary card, the personal-best ghost and the leaderboards
    const lapRecorder = new LapRecorder({
      trackLengthM: track.totalLengthM,
      trackGeometry: trackGeometryKey(track),
      turns: TURN_METADATA.map((t) => ({ number: t.number, name: t.name, sApprox: t.sApprox })),
      trackId,
      vehicle: vehicleModelRef.current,
      driverName: settingsRef.current.profile.name,
      driverCode: settingsRef.current.profile.code,
    });
    lapRecorderRef.current = lapRecorder;

    applyGraphicsRef.current = (quality, renderScale) => {
      applyGraphicsQuality(renderer, postFx, env, quality, renderScale);
      reflectionProbe.setQuality(quality === "low" ? "off" : quality);
      postFx.setSize(container.clientWidth, container.clientHeight);
    };
    applyGraphicsRef.current(settingsRef.current.graphics.quality, settingsRef.current.graphics.renderScale);

    // WebXR: the headset's pose is added to a rig placed at the driver's eye every frame
    renderer.xr.enabled = true;
    const xrRig = new THREE.Group();
    const xrCamera = new THREE.PerspectiveCamera(70, 1, 0.05, 5500);
    xrCamera.layers.enable(OVERLAY_LAYER);
    xrRig.add(xrCamera);
    scene.add(xrRig);
    enterVrRef.current = () => {
      const xr = (navigator as Navigator & { xr?: { requestSession: (mode: string, init?: object) => Promise<XRSession> } }).xr;
      // One request at a time: a second click while the headset is being asked does nothing
      if (!xr || vrStateRef.current !== "off" || renderer.xr.isPresenting) return;
      setVrState("requesting");
      void (async () => {
        let session: XRSession | null = null;
        try {
          session = await xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor"] });
          if (disposed) {
            void session.end().catch(() => {});
            return;
          }
          session.addEventListener("end", () => setVrState("off"));
          renderer.xr.setReferenceSpaceType("local");
          await renderer.xr.setSession(session);
          // The session may have ended while it was being set up
          setVrState(renderer.xr.isPresenting ? "on" : "off");
        } catch {
          void session?.end().catch(() => {});
          setVrState("off");
        }
      })();
    };

    // Sparks from under the floor of the cars that throw them
    const floorSparks = new FloorSparks();
    scene.add(floorSparks.points);

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

      // Support typing "/boost" anywhere to latch 350kW MGU-K + 425kW ICE Overboost ("/" starts it unless a control
      // is bound to that key)
      if (e.key && e.key.length === 1) {
        if (e.key === "/" && !keyLookupRef.current.has(code)) {
          slashCommandBufferRef.current = "/";
          return;
        } else if (slashCommandBufferRef.current.startsWith("/")) {
          slashCommandBufferRef.current = (
            slashCommandBufferRef.current + e.key.toLowerCase()
          ).slice(-6);
          if (slashCommandBufferRef.current === "/boost") {
            // Latches on (never off), and only when the car grants the override
            if (physics.activateBoostOverride()) setLatch(true);
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
      if (isHeldKeyAction(action)) {
        keysRef.current[HELD_KEYS[action]] = true;
        if (DRIVER_KEYS.has(action) && physics.aiAutopilot) physics.aiAutopilot = false;
        return;
      }
      // Held controls ignore auto-repeat anyway; one-shot actions must not flicker while a key is held
      if (e.repeat) return;
      runAction(action);
    };

    /** Every one-shot driving action, from the keyboard, a pad or the touch pads */
    const runAction = (action: DriveAction) => {
      switch (action) {
        case "shiftUp":
          keysRef.current.shiftUp = true;
          break;
        case "shiftDown":
          keysRef.current.shiftDown = true;
          break;
        case "aero":
          keysRef.current.toggleX = true;
          break;
        case "boostLatch":
          setLatch(!boostLatchRef.current);
          break;
        case "camera":
          cycleCamera();
          break;
        case "racingLine":
          handleToggleRacingLine();
          break;
        case "restart":
          restartRun();
          break;
        case "replay":
          toggleReplayRef.current();
          break;
        case "mouseSteer":
          setMouseSteerRef.current(!mouseSteerEnabledRef.current);
          break;
        case "mute":
          handleToggleMute();
          break;
        case "autopilot":
          toggleAutopilot();
          break;
        // The HUD owns these panels
        case "mfd":
        case "mfdPage":
        case "hud":
          window.dispatchEvent(new Event(HUD_TOGGLE_EVENT[action]));
          break;
      }
    };

    const restartRun = () => {
      // A multiplayer race is restarted by the host, from the pause menu
      if (mpRaceRef.current) return;
      // Out of a replay first (the reset does that), then the car moves
      resetRunRef.current("restart");
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
      if (action && isHeldKeyAction(action)) keysRef.current[HELD_KEYS[action]] = false;
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
      if (!document.hidden) return;
      wheelFfb.stop();
      releaseHeldKeys();
    };
    // Leaving the page: the WebHID wheel gets its stop commands now (emergencyStop), as no later promise may run
    const onPageHide = () => {
      wheelFfb.stop();
      webHidFfb.emergencyStop();
    };
    // Back from the back/forward cache: the wheel was stopped on the way out
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) void webHidFfb.resume();
    };
    // Keys held while focus leaves the window (Cmd-Tab, a system dialog) never get their keyup
    const onWindowBlur = () => releaseHeldKeys();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("blur", onWindowBlur);

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
      teamColorHex: replayNames.get(car.id)?.color ?? GHOST_CAR_COLOR,
      vehicle: replayNames.get(car.id)?.vehicle,
      position: new THREE.Vector3(car.x, car.y, car.z),
      quaternion: new THREE.Quaternion(car.qx, car.qy, car.qz, car.qw),
      linearVelocity: new THREE.Vector3(),
      steerAngle: steerAngleOf(car.steer),
      wheelRPMs: [0, 0, 0, 0].map(() => wheelRpmAtSpeed(car.speedKmh)) as [number, number, number, number],
      throttle: car.throttle,
      brake: car.brake,
      trackS: 0,
      speedKmh: car.speedKmh,
      isAiPeer: true,
      // The frames hold the body's pose: the rig rests the wheels on the road under each corner
      wheels: { ground: physics.groundQuery ?? null },
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
      // A flashback lap never counts
      physics.invalidateLap?.();
      rp.buffer.truncateAfter(rp.timeS);
      replayClockS = rp.timeS;
      lastReplayPushS = rp.timeS;
      rp.active = false;
      setReplayUi((u) => ({ ...u, active: false }));
      // A new run from here (the lap in progress is dropped; the trimmed replay stays)
      resetRunRef.current("flashback");
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
    /** The player car drawn at the frame time (its physics pose carried forward by the unstepped remainder) */
    const renderCarPos = new THREE.Vector3();
    /** The player car's tyres on its ground, at the pose it is drawn at (refreshed in place every frame) */
    const playerWheels: WheelSeating = { ground: null, position: renderCarPos, quaternion: new THREE.Quaternion() };
    const smoothedHeliPos = new THREE.Vector3();
    const smoothedHeliLook = new THREE.Vector3();
    // Cockpit extras, created once the VF26 model has loaded: the wheel's LCD and the live wing mirrors
    let wheelDisplay: SteeringWheelDisplay | null = null;
    let wingMirrors: WingMirrors | null = null;
    /** The VF26 body the wheel display and mirrors above were built for */
    let vf26ExtrasFor: THREE.Object3D | null = null;
    // The AMG GT3's MoTeC dash and rear-view mirror, once its cockpit model has loaded
    let gt3Dash: Gt3DashDisplay | null = null;
    let cockpitProbeFrame = 0;
    const lapDelta = new LapDeltaTracker(track.totalLengthM);
    // Race control: judges every excursion past the track limits (see TrackLimitsMonitor)
    const trackLimits = new TrackLimitsMonitor();
    // Its session starts over with every new run (runIdRef), a change of session kind and a new car
    let tlCar: SimulatorCar | null = null;
    let tlRunId = -1;
    /** The wheel went while it could not pause the game (menus, loading): it pauses once the car is driven again */
    let wheelLostPending = false;
    const displayExtra: { deltaMs: number | null } = { deltaMs: null };
    // Spring-damped onboard camera shake from the suspension and kerbs
    const cockpitShake = new CockpitMicroShake();
    const shakeQuat = new THREE.Quaternion();
    const shakeEuler = new THREE.Euler();
    const chaseCamera = new DynamicChaseCamera();
    const chaseInput: ChaseCameraInput = {
      carPos: renderCarPos,
      carQuaternion: new THREE.Quaternion(),
      carVelocity: new THREE.Vector3(),
      longitudinalG: 0,
      lateralG: 0,
      verticalG: 1,
      wheelbaseM: 0,
      cgHeightM: 0,
      rideHeightOffsetM: 0,
      kerbShakeM: 0,
      manualOverrideActive: false,
    };
    // Automatic trackside broadcast cameras on dolly splines (telephoto, zooming in over kerbs)
    const tvDirector = new TracksideBroadcastDirector(track);
    /** Where the cameras last saw the car: a jump further than it can drive (a teleport, a restart, a replay's end) starts them over */
    const cameraCarPos = new THREE.Vector3();
    let frameIndex = 0;
    const deviceInput = new DeviceInputReader();
    /** Per-axle tyre slip read from the car's telemetry each frame, for the keyboard pedal help */
    const kbAxleSlip = createAxleSlipSample();
    // The other cars, heard where they are from the active camera
    const opponentAudio = new OpponentAudio();
    const opponentSound = (p: InterpolatedPeerState): CarSoundSource => carForVehicle(p.vehicle ?? "vf26").sound;
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
    // The head's sense of "up": follows the car's up with a 0.4 s lag, so quick body pitch and roll are held off
    const headUp = new THREE.Vector3(0, 1, 0);
    const headCross = new THREE.Vector3();
    const radarRel = new THREE.Vector3();
    const radarFwd = new THREE.Vector3();
    const ghostQuat = new THREE.Quaternion();
    const ghostVel = new THREE.Vector3();
    let menuViewOffset = false;

    // Loading: once both GLBs have settled (loaded or given up), compile every shader before the
    // first frame is drawn, then let the loading screen offer to continue
    const loadStartMs = performance.now();
    let warmupStarted = false;
    let loggedFirstFrame = false;
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
        // The scene is drawn into the composer's half-float target (no tone mapping, linear output), and three keys
        // its programs on the bound target: compiled with none bound, every shader would be the wrong variant and
        // recompile on the first frame after the player presses start. The program build runs synchronously inside
        // compileAsync, so the target only has to be bound for the call itself.
        compileForComposer()
          .then(() => {
            if (disposed) return;
            warmUpGpu();
            visualFx.hidePrewarmed();
            assetProgress.done("shaders");
          }, () => assetProgress.fail("shaders"))
          .finally(() => {
            if (!disposed) setAssetsReady(true);
          });
      });
    };
    function compileForComposer(): Promise<THREE.Object3D> {
      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(postFx.composer.inputBuffer);
      try {
        return renderer.compileAsync(scene, camera);
      } finally {
        renderer.setRenderTarget(prevTarget);
      }
    }
    /**
     * Behind the opaque loading screen: upload every texture, then draw one full frame through the composer with frustum
     * culling off, so the shadow-map and post-processing programs and every vertex buffer are ready before the first
     * visible frame instead of stalling it
     */
    const warmUpGpu = () => {
      const t0 = performance.now();
      const textures = new Set<THREE.Texture>();
      const unculled: THREE.Object3D[] = [];
      scene.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) {
          for (const v of Object.values(m)) if (v instanceof THREE.Texture) textures.add(v);
        }
        if (o.frustumCulled) {
          o.frustumCulled = false;
          unculled.push(o);
        }
      });
      try {
        for (const tex of textures) renderer.initTexture(tex);
        // The reflection probe's first full turn and prefilter (their shaders compile here, not on lap one)
        reflectionProbe.update(physics.worldPosition, carRig.root, scene.environmentIntensity);
        postFx.render(0);
      } catch (err) {
        console.warn("GPU warm-up frame failed (the first frame will do it instead)", err);
      } finally {
        for (const o of unculled) o.frustumCulled = true;
      }
      if (process.env.NODE_ENV !== "production") {
        console.info(`[load] GPU warm-up: ${textures.size} textures, ${(performance.now() - t0).toFixed(0)} ms`);
      }
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
      // Dev: a frame that took far longer than a frame is a stall worth knowing about (shader compiles, uploads, builds)
      if (process.env.NODE_ENV !== "production" && lastTimeMs > 0 && nowMs - lastTimeMs > 120 && phaseRef.current !== "loading") {
        console.info(`[load] long frame: ${(nowMs - lastTimeMs).toFixed(0)} ms (${phaseRef.current})`);
      }
      // A hitch (GC, shader compile, a slow commit) is caught up in full, up to a quarter second, so the car never
      // drops into slow motion; a longer stall (hidden tab, debugger) is not
      const dtSeconds = Math.min((nowMs - lastTimeMs) / 1000, MAX_FRAME_CATCH_UP_S);
      lastTimeMs = nowMs;
      if (phaseRef.current === "driving") startupMonitor?.frame(nowMs);

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
      const settingsNow = settingsRef.current;
      // The wheel unplugged: pause rather than hand the car to whatever pad is left (no input this frame). In a replay
      // the replay pauses with it; in the menus it waits for the car, unless by then the wheel is back (or unbound) or
      // the player has picked another device to drive with.
      if (device.wheelLost) wheelLostPending = true;
      else if (wheelLostPending) {
        const w = settingsNow.wheel;
        const missing =
          w.steer !== null &&
          (!findPad(pads, w.steer.padId) ||
            (w.throttle !== null && !findPad(pads, w.throttle.padId)) ||
            (w.brake !== null && !findPad(pads, w.brake.padId)));
        if (!missing || settingsNow.device !== "wheel") wheelLostPending = false;
      }
      if (wheelLostPending && !inMenu) {
        wheelLostPending = false;
        if (!pausedRef.current) togglePauseRef.current();
        setPauseNotice("Steering wheel disconnected. Reconnect it, or resume to drive with what's left.");
      }
      const driving = !inMenu && !pausedRef.current && !replaying && !device.wheelLost;
      const padTuning = settingsNow.padTuning;
      const kbTuning = settingsNow.keyboardTuning;
      const isPad = device.source === "controller";
      const gamepadThrottle = driving ? (isPad ? Math.pow(device.throttle, padTuning.throttleGamma) : device.throttle) : 0;
      const gamepadBrake = driving ? (isPad ? Math.pow(device.brake, padTuning.brakeGamma) : device.brake) : 0;
      const gamepadSteer = device.analogSteer;
      // The whole curve the setup screen previews (inner and outer dead zone, then linearity), here once: the assist
      // used to apply the inner dead zone after the curve, and without the assist it was never applied
      const gamepadStick =
        device.padSteer === undefined
          ? undefined
          : shapeStick(device.padSteer, padTuning.deadzone, padTuning.outerDeadzone, padTuning.linearity);
      const gamepadBoost = driving && device.boostHeld;
      if (!inMenu) {
        for (const action of device.pressed) {
          if (action === "pause") {
            // Opening only: in the pause menu, B / Menu resume through the menu's own navigation
            if (!pausedRef.current) togglePauseRef.current();
            continue;
          }
          if (!driving) continue;
          // Boost acts while held (`boostHeld`); L3 folds the Live Tuner MFD, R3 clears the whole HUD off the screen
          if (action !== "boost") runAction(action);
        }
      }

      // Keyboard-only input shaping: keys become ramped pedals, eased back while the tyres pass their grip when the
      // car's ABS / traction control is off. The steering keys' direction goes to the car's steering assist, which
      // ramps it to the front tyres' grip limit, self-aligns the car when they are let go and caps a countersteer.
      // Wheel and mouse inputs are passed through untouched.
      const keys = keysRef.current;
      const kb = kbInputRef.current;
      // Half-throttle key: a fixed part throttle for wet-like traction or slow corners
      const kbThrottleTarget = keys.up ? 1 : keys.half ? kbTuning.halfThrottle : 0;
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
      const carAids = physics.telemetry.liveTuner;
      const tyreSlip = axleSlipFromTelemetry(physics.telemetry, kbAxleSlip);
      const kbBrakeScale = kbPedalAssistRef.current.brakeScale(
        keys.down,
        kb.brake,
        tyreSlip.totalNdSlip,
        dtSeconds,
        driving && kbTuning.brakeAssist && carAids?.absLevel === 0,
        kbTuning.pedalAssistStrength
      );
      const kbThrottleScale = kbPedalAssistRef.current.throttleScale(
        kbThrottleTarget > 0,
        kb.throttle,
        tyreSlip.rearNdSlip,
        Math.max(0, physics.vxMs),
        dtSeconds,
        driving && kbTuning.exitAssist && carAids?.tcLevel === 0,
        kbTuning.pedalAssistStrength
      );
      const kbSteerDir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      // On-screen controls: pedals and a steering pad (or the tilt of the device). With no wheel or controller the touch
      // steering is always the steering, centred too; with one, that device steers while the touch steering is centred
      const touch = touchInput.active && driving ? touchInput : null;
      const touchSteering =
        touch !== null && ((gamepadStick === undefined && gamepadSteer === undefined) || Math.abs(touch.steer) > 0.01);
      if (touchInput.active) {
        if (driving) {
          if (touchInput.shiftUp) runAction("shiftUp");
          if (touchInput.shiftDown) runAction("shiftDown");
          if (touchInput.aero) runAction("aero");
          if (touchInput.boost) runAction("boostLatch");
        }
        touchInput.shiftUp = touchInput.shiftDown = touchInput.aero = touchInput.boost = false;
      }
      // Wheel, mouse and touch steer the rack directly; the car's steering assist picks between them, the keys and the
      // stick (steering-assist.ts: a pressed key takes over, and hands back once its ramp is at centre)
      const directSteer = mouseSteerEnabledRef.current
        ? mouseSteerValueRef.current
        : touchSteering
          ? touch.steer
          : gamepadSteer;

      const inputs: ControlInputs = {
        throttle: Math.max(kb.throttle * kbThrottleScale, gamepadThrottle, touch?.throttle ?? 0),
        brake: Math.max(kb.brake * kbBrakeScale, gamepadBrake, touch?.brake ?? 0),
        steerLeft: 0,
        steerRight: 0,
        analogSteer: directSteer,
        kbSteer: kbSteerDir,
        padSteer: directSteer === undefined ? gamepadStick : undefined,
        manualOverride:
          keysRef.current.boostHold || boostLatchRef.current || gamepadBoost,
        toggleXMode: keysRef.current.toggleX,
        shiftUp: keysRef.current.shiftUp,
        shiftDown: keysRef.current.shiftDown,
      };
      keysRef.current.toggleX = false;
      keysRef.current.shiftUp = false;
      keysRef.current.shiftDown = false;
      // The driver takes the car back from the autopilot with any device (the keys do it on key down): a pedal, the
      // stick, the touch steering pad. Not the wheel's rim, which its force feedback turns on its own.
      if (driving && physics.aiAutopilot) {
        const pedal = Math.max(gamepadThrottle, gamepadBrake, touch?.throttle ?? 0, touch?.brake ?? 0);
        const stick = Math.abs(gamepadStick ?? 0);
        const touchSteer = touchSteering && !settingsNow.touch.tiltSteer ? Math.abs(touch.steer) : 0;
        if (pedal > 0.15 || stick > 0.3 || touchSteer > 0.2) physics.aiAutopilot = false;
      }

      // The AI field holds the player on the grid until the lights go out, then runs its cars
      const aiField = aiFieldRef.current;
      if (physics.steeringAssist.settings !== assistSettingsRef.current) {
        physics.steeringAssist.settings = assistSettingsRef.current;
      }
      const lockDeg = Math.round(physics.maxSteerAngleRad * (1800 / Math.PI)) / 10;
      if (lockDeg !== steerLockDegRef.current) {
        steerLockDegRef.current = lockDeg;
        setSteerLockDeg(lockDeg);
      }
      // A multiplayer race runs on the host's clock: the grid is held until the shared lights-out, and until this
      // guest has measured that clock (lights off, no countdown)
      const mpRace = mpRaceRef.current;
      const mpFrame = mpRace
        ? multiplayerSync.clockSynced
          ? mpRace.frame(multiplayerSync.hostNowMs(nowMs))
          : MP_CLOCK_UNSYNCED_FRAME
        : null;
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
        startupMonitor?.begin();
        if (!aiField?.playerFrozen && !mpFrozen) physics.step(dtSeconds, inputs);
        aiField?.update(dtSeconds);
        startupMonitor?.end("sim");
      }
      if (mpRace && mpFrame && mpFrame.phase === "racing" && !pausedRef.current) {
        mpRace.lapClock.update(physics.sMeters, mpFrame.raceTimeS, mpRace.start.laps, mpRace.flagOut);
      }
      haptics.update(physics.telemetry, dtSeconds, rumbleEnabledRef.current && driving, {
        triggerRumble: padTuning.triggerRumble,
        triggerSlipAlwaysOn: padTuning.triggerSlipAlwaysOn,
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
      const runId = runIdRef.current;
      physics.telemetry.runId = runId;

      // Track limits: race control judges each excursion once the car is back on the asphalt. Practice deletes
      // the lap; a race gives warnings, and every third one is a time penalty served at the flag.
      {
        const t = physics.telemetry;
        const raceNow = t.race;
        const session = aiField || mpRace ? "race" : "practice";
        if (session !== trackLimits.mode || physics !== tlCar || runId !== tlRunId) {
          trackLimits.reset(session);
          tlCar = physics;
          tlRunId = runId;
        }
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
          // Laps are ranked only against laps driven with the same assists, realism, surface and physics revision;
          // an autopilot lap never ranks
          conditions: {
            ...lapConditionsNow({
              assists: physics.assistPreset,
              compound: physics.tireCompound,
              lineWaterMm: trackEnv.weather.lineWaterMm,
              realism: settingsNow.realism,
            }),
            autopilot: physics.aiAutopilot,
          },
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
            maxRpm: vehicleModelSpec(vehicleModelRef.current).telemetryMaxRpm,
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
      const carVelocityWorld = physics.worldVelocity
        ? physics.worldVelocity.clone()
        : new THREE.Vector3(
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
          steerAngle: steerAngleOf(physics.steerAngleNorm),
          wheelRPMs: [
            wheelRpmOf(physics.wheels[0].spinVel),
            wheelRpmOf(physics.wheels[1].spinVel),
            wheelRpmOf(physics.wheels[2].spinVel),
            wheelRpmOf(physics.wheels[3].spinVel),
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
        mpRace.ingestPeers(samePeers, mpFrame.phase === "racing" ? mpFrame.raceTimeS : 0);
        // Contact with the other players (one-sided: each client resolves its own car)
        if (driving) {
          for (const p of samePeers) {
            if (!p.isAiPeer && p.race?.id === mpRace.start.id && mpRace.collisionsActiveWith(mpFrame, p.peerId)) {
              resolvePlayerVsRemoteCar(physics, p, dtSeconds);
            }
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
          const wheelRpm = wheelRpmAtSpeed(g.speedKmh);
          renderPeers = [
            ...renderPeers,
            {
              peerId: "ghost",
              driverCode: ghost.recording.driverCode,
              teamColorHex: GHOST_CAR_COLOR,
              vehicle: ghost.recording.vehicle,
              position: ghostPos.set(g.x, g.y, g.z),
              quaternion: ghostQuat.set(g.qx, g.qy, g.qz, g.qw),
              linearVelocity: ghostVel,
              steerAngle: steerAngleOf(g.steer),
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
              steer: steerNormOf(p.steerAngle),
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

      // While the keys steer, the mouse follows the steering, so it takes over (once the keys' ramp is at centre)
      // where the steering is instead of where the mouse was
      if (mouseSteerEnabledRef.current && physics.steeringAssist.source === "keyboard") {
        mouseSteerValueRef.current = physics.steerAngleNorm;
      }

      // The latched boost lets go once the battery is empty (where the cars stop deploying it)
      if (boostLatchRef.current && physics.ersEnergyJ <= 0) setLatch(false);

      // The menus film the car from outside, whatever the player's camera is
      const inVr = renderer.xr.isPresenting;
      const mode: CameraMode = inMenu ? "chase" : inVr ? "cockpit" : cameraModeRef.current;
      const view = CAMERA_MODES[mode];
      const vf26Cams = carRig.getCameraAnchors();
      const carFovDeg = vf26Cams ? vf26Cams.cockpit.fovDeg : FALLBACK_COCKPIT_FOV_DEG;
      if (carFovDeg !== carCockpitFovRef.current) {
        carCockpitFovRef.current = carFovDeg;
        setCarCockpitFov(carFovDeg);
      }
      const onboardFovShift = cockpitFovRef.current === null ? 0 : cockpitFovRef.current - carFovDeg;
      // The procedural helmet goes once the VF26 model (with its own driver) has replaced the procedural car
      carRig.helmetGroup.visible = !vf26Cams;
      // From the driver's eye point the helmet would fill the view: the camera leaves its layer out, while the
      // sun's shadow camera keeps it so the head still shadows the cockpit
      if (view.driverEye) camera.layers.disable(DRIVER_HEAD_LAYER);
      else camera.layers.enable(DRIVER_HEAD_LAYER);

      // The fixed-step physics leaves up to 2 ms unstepped each frame: draw the car (and the cameras on it) where it
      // is at the frame's time, the pose carried forward by its velocity over that remainder
      renderCarPos
        .copy(carVelocityWorld)
        .multiplyScalar(physics.renderLeadS ?? 0)
        .add(physics.worldPosition);
      if (cameraCarPos.distanceTo(renderCarPos) > Math.max(5, 2 * carVelocityWorld.length() * dtSeconds)) {
        cockpitShake.reset();
        chaseCamera.reset();
        tvDirector.reset();
      }
      cameraCarPos.copy(renderCarPos);
      carRig.root.position.copy(renderCarPos);
      carRig.root.quaternion.copy(physics.worldQuaternion);
      carRig.chassisGroup.position.y = physics.rideHeightOffsetM;
      if (physics.tyreVisuals) {
        playerWheels.tyres = physics.tyreVisuals;
        playerWheels.ground = physics.groundQuery ?? null;
        playerWheels.quaternion = physics.worldQuaternion;
      }
      carRig.updateFromTelemetry(
        physics.telemetry,
        physics.pitchRad,
        physics.rollRad,
        physics.wheelRotationRad,
        dtSeconds,
        physics.tyreVisuals ? playerWheels : undefined
      );
      seatContactShadow(carRig.root, physics.tyreVisuals ? playerWheels : undefined);

      const vf26Body = carRig.getVf26Body();
      // Built once per body (keyed on the body, not on the wheel display: a body without STEER_BASE has no display,
      // and keying on it rebuilt the mirrors' render target every frame)
      if (vf26Body && vf26ExtrasFor !== vf26Body) {
        vf26ExtrasFor = vf26Body;
        const steerBase = vf26Body.getObjectByName("STEER_BASE");
        if (steerBase) wheelDisplay = new SteeringWheelDisplay(steerBase);
        wingMirrors = new WingMirrors(renderer, scene, vf26Body);
      }
      if (!vf26Body && !gt3Dash && rigModel(carRigCar).gt3Cockpit && cockpitProbeFrame++ % 30 === 0) {
        const anchors = carRig.getCameraAnchors();
        if (anchors && carRig.chassisGroup.getObjectByName(GT3_DASH_MESH)) {
          gt3Dash = new Gt3DashDisplay(carRig.chassisGroup);
          // The body's wing-mirror glass is a rear-facing patch of its trim material, one each side
          const bodyFrame = carRig.chassisGroup.getObjectByName("BODY")?.parent ?? null;
          wingMirrors = new WingMirrors(renderer, scene, carRig.chassisGroup, {
            materials: ["MIRROR"],
            eyeInModel: anchors.cockpit.pos,
            coversSides: false,
            upAxis: "z",
            glassPatches: bodyFrame
              ? [1, -1].map((side) => ({
                  material: GT3_WING_MIRROR_MATERIAL,
                  frame: bodyFrame,
                  box: new THREE.Box3(
                    new THREE.Vector3(side > 0 ? 0.8 : -1.04, 0.84, -0.03),
                    new THREE.Vector3(side > 0 ? 1.04 : -0.8, 0.98, 0.15)
                  ),
                  facing: new THREE.Vector3(0, 0, -1),
                }))
              : undefined,
          });
        }
      }
      lapDelta.update(physics.telemetry);
      // The wheel is only in shot from the onboard views; the display redraws itself at 30 Hz
      if (view.wheelInShot && (wheelDisplay || gt3Dash)) {
        const delta = lapDelta.delta(physics.telemetry);
        const deltaMs = delta === null ? null : delta * 1000;
        if (wheelDisplay) {
          displayExtra.deltaMs = deltaMs;
          wheelDisplay.update(physics.telemetry, nowMs, displayExtra);
        }
        gt3Dash?.update(physics.telemetry, nowMs, { deltaMs });
      }
      const shake = cockpitShake.update(dtSeconds, physics.telemetry);

      // Update persistent 4-wheel skidmark ribbons, tire smoke/gravel/rooster-tail particles & opponent 3D cars
      // The player's car only lays skidmarks and throws smoke / spray while it is simulated: paused, in menus or in a
      // replay its wheel state is the last driven frame, which would keep emitting on the spot
      visualFx.update(
        dtSeconds,
        physics.worldQuaternion,
        physics.vxMs,
        physics.wheels,
        renderPeers,
        driving
      );


      floorSparks.update(dtSeconds, driving && rigModel(carRigCar).floorSparks ? physics : null);

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

      const vf26Cam = vf26Cams && view.anchor ? vf26Cams[view.anchor] : null;
      if (vf26Cam) {
        // Onboard camera anchors from the car model: bolted to the sprung chassis at the
        // model's position, pitch and field of view
        carRig.chassisGroup.updateWorldMatrix(true, false);
        camera.position.copy(vf26Cam.pos).applyMatrix4(carRig.chassisGroup.matrixWorld);
        carRig.chassisGroup.getWorldQuaternion(camera.quaternion);
        camera.quaternion
          .multiply(CAM_FORWARD_FLIP)
          .multiply(new THREE.Quaternion().setFromAxisAngle(CAM_X_AXIS, vf26Cam.pitchRad));
        const headLocked = view.driverHead && settingsNow.hud.headMovement === "static";
        if (!headLocked) {
          // Micro-shake: pitch about the lens' X axis, roll about its view axis, heave along the car's up
          shakeEuler.set(shake.pitchRad, 0, shake.rollRad);
          camera.quaternion.multiply(shakeQuat.setFromEuler(shakeEuler));
          camera.position.addScaledVector(carUp, shake.heaveM);
        }
        camera.up.copy(carUp);
        // The player's FOV shifts the driver's-eye cameras together, keeping the model's framing between them
        const targetOnboardFov = view.playerFov ? clampFov(vf26Cam.fovDeg + onboardFovShift) : vf26Cam.fovDeg;
        if (camera.fov !== targetOnboardFov) {
          camera.fov = targetOnboardFov;
          camera.updateProjectionMatrix();
        }
      } else if (mode === "chase") {
        chaseInput.carQuaternion = physics.worldQuaternion;
        chaseInput.carVelocity = carVelocityWorld;
        chaseInput.longitudinalG = physics.telemetry.longitudinalG;
        chaseInput.lateralG = physics.telemetry.lateralG;
        chaseInput.verticalG = physics.telemetry.verticalG;
        chaseInput.wheelbaseM = physics.wheelbaseM;
        chaseInput.cgHeightM = physics.cgHeightM;
        chaseInput.rideHeightOffsetM = physics.rideHeightOffsetM;
        chaseInput.kerbShakeM = kerbShake;
        chaseInput.manualOverrideActive = physics.telemetry.manualOverrideActive;
        const chase = chaseCamera.update(dtSeconds, chaseInput);
        camera.position.copy(chase.position);
        camera.up.copy(chase.up);
        camera.lookAt(chase.lookAt);
        camera.fov = chase.fovDeg;
        camera.updateProjectionMatrix();
      } else if (mode === "tv_pod") {
        // Broadcast Roll-Hoop T-Cam mounted at front lens of T-Cam pod looking down over painted helmet #16, butterfly wheel + gloved hand, Halo arch, mirrors, wheel brows & nose cone
        camera.position
          .copy(renderCarPos)
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
          renderCarPos
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
          .copy(renderCarPos)
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
          renderCarPos
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
          .copy(renderCarPos)
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
          renderCarPos
            .clone()
            .addScaledVector(carForward, 8.0)
            .addScaledVector(
              carUp,
              0.50 - physics.pitchRad * 3.5 + highSpeedBuffet
            )
            .addScaledVector(carRight, -physics.yawRateRadS * 0.3)
        );
        camera.fov = FALLBACK_COCKPIT_FOV_DEG + speedNorm * 4 + onboardFovShift;
        camera.updateProjectionMatrix();
      } else if (mode === "nose") {
        // Reference Image 4: Forward Nose-Cone Camera showing narrow Nose Tip, delicate Y-Pitot Probe, curved vertical Front Wing Endplates at bottom corners & 3D Dashed Braking Line
        camera.position
          .copy(renderCarPos)
          .addScaledVector(carForward, 1.66)
          .addScaledVector(
            carUp,
            0.455 + physics.rideHeightOffsetM + kerbShake * 0.32
          );
        camera.up.copy(carUp);
        camera.lookAt(
          renderCarPos
            .clone()
            .addScaledVector(carForward, 18.0)
            .addScaledVector(carUp, 0.25 - physics.pitchRad * 5.0)
        );
        camera.fov = 64 + speedNorm * 4;
        camera.updateProjectionMatrix();
      } else if (mode === "helicopter") {
        const heliTarget = renderCarPos
          .clone()
          .addScaledVector(carForward, -28)
          .add(new THREE.Vector3(14, 24, 14));
        if (smoothedHeliPos.distanceTo(heliTarget) > 80) {
          smoothedHeliPos.copy(heliTarget);
          smoothedHeliLook.copy(renderCarPos);
        } else {
          smoothedHeliPos.lerp(heliTarget, Math.min(1, dtSeconds * 6));
        }
        smoothedHeliLook.lerp(
          renderCarPos.clone().addScaledVector(carForward, 14),
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
          renderCarPos,
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
        const p = renderCarPos;
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

      // Driver's head (not in VR, where the headset is the head). A neck holds the eyes steady against the
      // chassis' suspension pitch and roll and turns them a little toward where the car is going; the road's own
      // camber and gradient stay in view. "Locked" leaves the camera bolted to the chassis.
      const neckOn =
        settingsNow.hud.headMovement === "natural" && driving && !inVr && view.driverHead;
      let neckYawTarget = 0;
      let neckPitchTarget = 0;
      let neckRollTarget = 0;
      if (neckOn) {
        const speedMs = Math.hypot(physics.vxMs, physics.vyMs);
        // Look toward the direction of travel in a slide (+vyMs is toward carLeft: positive yaw about carUp)
        const sliding = speedMs > 3 ? physics.vyMs / Math.max(3, speedMs) : 0;
        const slidingMult = Math.min(Math.abs(sliding) * 0.8, 1);
        if (slidingMult > 0.2) {
          neckDriftState = Math.max(0, neckDriftState - 0.5 * dtSeconds);
        } else {
          neckDriftState = Math.min(1, neckDriftState + 0.25 * dtSeconds);
        }
        const velYaw = THREE.MathUtils.clamp(Math.max(slidingMult - 0.2, 0) * Math.sign(sliding) * 0.35, -0.14, 0.14);

        // Look toward the corner 25 m ahead: a few degrees, faded out off the road and at walking pace
        const aheadSample = track.getSampleAtDistance(
          (physics.sMeters + 25) % Math.max(1, track.totalLengthM)
        );
        neckLookDelta.copy(aheadSample.position).sub(physics.worldPosition);
        const chordLen = neckLookDelta.length();
        let apexYaw = 0;
        if (chordLen > 1) {
          const latDot = neckLookDelta.dot(carRight) / chordLen;
          const fwdDot = neckLookDelta.dot(carForward) / chordLen;
          const trackWeight =
            THREE.MathUtils.clamp((15 - Math.abs(physics.lateralOffsetM)) / 7, 0, 1) *
            THREE.MathUtils.clamp(fwdDot, 0, 1) *
            neckDriftState *
            THREE.MathUtils.clamp((speedMs - 4) / 12, 0, 1);
          apexYaw = THREE.MathUtils.clamp(-latDot * 0.22, -0.1, 0.1) * trackWeight;
        }

        neckYawTarget = THREE.MathUtils.clamp(velYaw + apexYaw, -0.17, 0.17);
        // Hold the head against the body's quick pitch and roll. The VF26 reports its suspension pitch (about the
        // car's +X, carLeft) and roll (about carForward) apart from its pose; the rigid-body cars carry theirs in
        // the pose, which the lagging head-up takes out.
        headUp.lerp(carUp, Math.min(1, dtSeconds * 2.5)).normalize();
        headCross.crossVectors(carUp, headUp);
        const bodyPitch = Math.atan2(headCross.dot(carRight), carUp.dot(headUp));
        const bodyRoll = Math.atan2(headCross.dot(carForward), carUp.dot(headUp));
        neckPitchTarget = THREE.MathUtils.clamp((physics.pitchRad + bodyPitch) * 0.6, -0.06, 0.06);
        neckRollTarget = THREE.MathUtils.clamp((-physics.rollRad + bodyRoll) * 0.6, -0.08, 0.08);
      } else {
        neckDriftState = 1;
        headUp.copy(carUp);
      }
      // The yaw eases in like a turn of the head; the stabilisation follows the chassis closely
      neckYaw += (neckYawTarget - neckYaw) * Math.min(1, dtSeconds * 3);
      neckPitch += (neckPitchTarget - neckPitch) * Math.min(1, dtSeconds * 14);
      neckRoll += (neckRollTarget - neckRoll) * Math.min(1, dtSeconds * 14);
      if (
        (Math.abs(neckYaw) > 1e-4 || Math.abs(neckPitch) > 1e-4 || Math.abs(neckRoll) > 1e-4) &&
        view.driverHead
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
      builtCircuit.setGrooveRubber(getTrackEnv().trackEvolution.meanRacingLineRubber());
      opponentAudio.update({
        context: audioRef.current?.context ?? null,
        output: audioRef.current?.output ?? null,
        active: driving,
        camera,
        cameraMode: mode,
        peers: renderPeers,
        soundFor: opponentSound,
        dt: dtSeconds,
      });
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
        const limiter = vehicleModelSpec(vehicleModelRef.current).limiterRpm;
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
      // The ripples' clock runs every frame with the real frame time; the rest of the sky updates at 10 Hz below
      advanceAsphaltRain(dtSeconds);
      if (nowMs - lastSkyMs > 100) {
        lastSkyMs = nowMs;
        const sun = wx.sun;
        skyConditions.elevationDeg = sun.elevationDeg;
        skyConditions.azimuthDeg = sun.azimuthDeg;
        skyConditions.cloud = wx.cloudCover;
        skyConditions.rain = wx.rainIntensity;
        env.setConditions(skyConditions);
        setAsphaltWetness(wetnessFromWater(wx.waterMm), wetnessFromWater(wx.lineWaterMm), wx.rainIntensity);
        // The water under the player's own wheels, not the lap's mean line water
        visualFx.setWetness(trackEnv.weatherSampleFor(physics)?.wetness ?? wetnessFromWater(wx.lineWaterMm));
      }
      camera.getWorldPosition(rainCamPos);
      if (dtSeconds > 0) rainCamVel.subVectors(rainCamPos, rainCamPrev).divideScalar(dtSeconds).clampLength(0, 110);
      rainCamPrev.copy(rainCamPos);
      // Spray thrown up by the cars ahead (the wake model's, from their speed, gap and the water)
      const sprayWake = trackEnv.weatherSampleFor(physics)?.sprayIntensity ?? 0;
      // Droplets on the visor only from the driver's eye (the mirrors render without this layer)
      if (view.driverEye && !inVr) camera.layers.enable(RAIN_VISOR_LAYER);
      else camera.layers.disable(RAIN_VISOR_LAYER);
      const skyLight = THREE.MathUtils.clamp((skyConditions.elevationDeg + 3) / 17, 0, 1) * (1 - 0.4 * wx.cloudCover);
      visualFx.setLightLevel(skyLight);
      rainFx.update(
        dtSeconds,
        wx.rainIntensity,
        camera,
        rainCamVel,
        skyLight,
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
      startupMonitor?.begin();
      reflectionProbe.update(physics.worldPosition, carRig.root, scene.environmentIntensity);
      startupMonitor?.end("probe");
      // Virtual mirror: on its own in the views whose wing mirrors are off screen (or that have none), and in the
      // chase view too when the player asked for it always
      const vmSetting = settingsNow.hud.virtualMirror;
      const vmView =
        view.virtualMirror === "always" ||
        (view.virtualMirror === "noSideMirrors" && !(wingMirrors?.found && wingMirrors.coversSides)) ||
        (view.virtualMirror === "onRequest" && vmSetting === "always");
      const vmOn = driving && !inVr && container.clientWidth >= 640 && vmSetting !== "off" && vmView;
      virtualMirror.update(frameIndex, vmOn, carRig.chassisGroup, carRig.root);
      if (vmOn !== virtualMirrorShown) {
        virtualMirrorShown = vmOn;
        setVirtualMirrorOn(vmOn);
      }
      // Rear view into the mirrors' render target (cockpit only, every 2nd frame), then the main frame
      wingMirrors?.update(frameIndex, view.driverEye && !inVr, carRig.chassisGroup);
      // Counted here, not inside the optional call above: without wing mirrors it never advanced, which also
      // disabled the virtual mirror's every-other-frame throttle
      frameIndex++;
      if (inVr) {
        // The head pose is added on top of the driver's eye point (a "local" space starts at the head)
        xrRig.position.copy(camera.position);
        xrRig.quaternion.copy(camera.quaternion);
        renderer.render(scene, xrCamera);
      } else {
        const t0 = loggedFirstFrame ? 0 : performance.now();
        startupMonitor?.begin();
        postFx.render(dtSeconds);
        virtualMirror.draw();
        startupMonitor?.end("render");
        if (!loggedFirstFrame) {
          loggedFirstFrame = true;
          if (process.env.NODE_ENV !== "production") {
            // The frame right after the loading screen: it stalls when the warm-up missed something
            renderer.getContext().finish();
            console.info(`[load] first visible frame: ${(performance.now() - t0).toFixed(0)} ms`);
          }
        }
      }

      // Paused, the car is frozen but the pause menu (and the HUD under it) would still re-render at 30 Hz for nothing;
      // 4 Hz keeps what can still move there (remote players) current
      if (nowMs - lastHudSyncMs > (pausedRef.current ? 250 : 33)) {
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
      opponentAudio.dispose();
      hapticsRef.current = null;
      wheelFfb.dispose();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("resize", onResize);
      // The shared connection stays up (a circuit switch remounts this component)
      multiplayerSync.onStatusChange = undefined;
      wheelDisplay?.dispose();
      wingMirrors?.dispose();
      gt3Dash?.dispose();
      postFx.dispose();
      reflectionProbe.dispose();
      env.dispose();
      rainFx.dispose();
      virtualMirror.dispose();
      floorSparks.dispose();
      renderer.dispose();
      audioRef.current?.dispose();
    };
  }, [track, getTrackEnv, takeAiField, unlockAudio, handleToggleMute, handleToggleRacingLine, releaseHeldKeys, toggleAutopilot, setLatch, setVrState]);

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
    setAutoGearbox(saved.autoGearbox);
    setMouseSteer(saved.mouseSteer);
    const livery = LIVERIES.find((l) => l.id === saved.liveryId);
    if (livery) handleLiveryChange(livery);
    setInviteRoom(roomFromUrl());
    setSettingsHydrated(true);
  }, [handleAssistPresetChange, setRacingLineVisible, setGamepadAssistEnabled, setAutoGearbox, setMouseSteer, handleLiveryChange]);

  useEffect(() => {
    if (!settingsHydrated) return;
    savePlayerSettings(settings);
  }, [settingsHydrated, settings]);

  // Recently driven / raced, for the browsers: the car and circuit in use once the save is read, then every change
  useEffect(() => {
    if (!settingsHydrated) return;
    setSettings((prev) => {
      const next = pushLibraryRecent(pushLibraryRecent(prev.library, "cars", carId), "circuits", trackId);
      return next === prev.library ? prev : { ...prev, library: next };
    });
  }, [settingsHydrated, carId, trackId]);

  // Multiplayer: lobby, race start / abort from the host, link quality
  useEffect(() => {
    const mp = getMultiplayerManager();
    setLocalPeerId(mp.localPeerId);
    setLobby(mp.lobby);
    mp.onLobbyChange = (l) => {
      setLobby(l ? { ...l, players: [...l.players] } : null);
      // The host's weather and clock: a guest's session eases to them (a different preset restarts it)
      if (l?.weather && l.hostId !== mp.localPeerId) trackEnvRef.current?.applyWeatherSync(l.weather);
    };
    mp.weatherProvider = () => trackEnvRef.current?.weather.snapshot() ?? null;
    mp.onRaceStart = (start) => {
      // A race on another circuit: switch to it, and pick the race up once that scene has loaded
      if (start.trackId && start.trackId !== trackId && onSelectTrack) {
        pendingRaceStart = start;
        onSelectTrack(start.trackId);
        return;
      }
      takeRaceStart(start);
    };
    mp.onRaceAbort = (id) => {
      // Aborted before it could start here (this circuit still loading): it never starts
      if (pendingRaceStart?.id === id) pendingRaceStart = null;
      if (mpRaceRef.current?.start.id === id) endMpRace(false);
    };
    const timer = window.setInterval(() => setPeerStats(mp.getPeerStats()), 1000);
    return () => {
      mp.onLobbyChange = undefined;
      mp.weatherProvider = undefined;
      mp.onRaceStart = undefined;
      mp.onRaceAbort = undefined;
      window.clearInterval(timer);
    };
  }, [trackId, onSelectTrack, takeRaceStart, endMpRace]);

  // The race the host started before this circuit loaded
  useEffect(() => {
    if (!assetsReady || !pendingRaceStart) return;
    const start = pendingRaceStart;
    pendingRaceStart = null;
    if (start.trackId && start.trackId !== trackId) return;
    takeRaceStart(start);
  }, [assetsReady, trackId, takeRaceStart]);

  // Name, code, colour and car as other players see them
  useEffect(() => {
    getMultiplayerManager().setIdentity(settings.profile, vehicleModel, trackId);
    lapRecorderRef.current?.setContext({ driverName: settings.profile.name, driverCode: settings.profile.code });
  }, [settings.profile, vehicleModel, trackId]);

  // A car change brings back that car's personal-best ghost and leaderboard
  useEffect(() => {
    void loadPbGhost();
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

  // WebHID force feedback (HID PID wheels, listed Logitech wheels) instead of the bridge, while switched on. Only a
  // wheel granted before reopens here: pairing needs requestDevice inside a click, which the wheel setup's toggle /
  // Connect does.
  const hidFfbWanted = settings.wheel.ffbEnabled && settings.wheel.hidFfb;
  // Before the reconnect below: a classic Logitech wheel is set to this rotation as it connects
  useEffect(() => webHidFfb.setRotationDeg(settings.wheel.rotationDeg), [settings.wheel.rotationDeg]);
  useEffect(() => {
    if (!hidFfbWanted) {
      void webHidFfb.dispose();
      return;
    }
    void webHidFfb.reconnect();
  }, [hidFfbWanted]);
  // A recognised wheel with no steering bound (the wizard's wheel step skipped, or plugged in later) is set up as a
  // wheel straight away; otherwise it drives as a gamepad, through the stick steering assist
  useEffect(() => {
    const bindWheel = () =>
      setSettings((prev) => {
        if (prev.wheel.steer) return prev;
        const patch = autoConfigureWheel(connectedPads(), prev.wheel);
        return patch ? { ...prev, wheel: { ...prev.wheel, ...patch } } : prev;
      });
    bindWheel();
    window.addEventListener("gamepadconnected", bindWheel);
    return () => window.removeEventListener("gamepadconnected", bindWheel);
  }, []);
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
      shiftUp: first(k.shiftUp),
      shiftDown: first(k.shiftDown),
    };
  }, [settings.keys]);

  // With the touch pads up and no wheel or controller picked, the pads are what the player drives with
  const launchHintText =
    settings.device === "wheel"
      ? "Press the throttle to launch · pause button or Esc for menu"
      : settings.device === "controller"
        ? `Hold RT to launch · ${padButtonLabel(settings.padButtons.pause)} for menu`
        : touchVisible && vrState !== "on"
          ? "Hold Throttle to launch"
          : `Hold ${keyLabel(settings.keys.throttle[0])} to launch · Esc for menu`;

  // The one derivation of hosting: the lobby names this client as its host
  const isMpHost = lobby !== null && lobby.hostId === localPeerId;
  isMpHostRef.current = isMpHost;

  const menuProps = {
    telemetry,
    settings,
    onChangeSettings: handleChangeSettings,
    steerLockDeg,
    pauseNotice,
    aeroPreset,
    assistPreset,
    cameraMode,
    tireCompound,
    selectedLivery,
    showRacingLine,
    isMuted,
    mouseSteerEnabled,
    gamepadAssist,
    autoGearbox,
    onSetAutoGearbox: setAutoGearbox,
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
    isHost: isMpHost,
    peerStats,
    profile: settings.profile,
    currentTrackId: trackId,
    currentVehicle: vehicleModel,
    vehicleLabel,
    vehiclesForClass: vehicleModelsFor,
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
      vrActive: vrState === "on",
      onEnterVr: () => enterVrRef.current?.(),
    },
    library,
    leaderboardPanel: {
      trackName: getTrackInfo(trackId).name,
      vehicleLabel,
      local: leaderboard.local,
      remote: leaderboard.remote,
      remoteEnabled: remoteLeaderboardEnabled,
      remoteBoardLabel: leaderboard.boardLabel,
      loading: leaderboard.loading,
      error: leaderboard.remoteError,
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
          onCycleCamera={cycleCamera}
          inviteRoom={inviteRoom}
          cockpitFovDeg={settings.cockpitFovDeg}
          cockpitFovDefaultDeg={carCockpitFov}
          onChangeCockpitFov={handleCockpitFovChange}
          onToggleXMode={handleToggleXMode}
          onToggleBoostLatch={handleToggleBoostLatch}
          onChangeLiveTuner={handleChangeLiveTuner}
          paused={paused}
          onOpenControls={() => openControls("pause")}
          onExitToTitle={leaveSession}
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
                  onClose: closeLapSummary,
                  onSaveGhost: () => exportLapFile(lapSummary.recording),
                  onSubmit:
                    remoteLeaderboardEnabled && lapSummary.summary.valid && !lapSummary.summary.autopilot
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
            mpRaceRunning && !isMpHost ? undefined : () => handleResetCar(false)
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
                  cameraLabel: CAMERA_MODES[cameraMode].label,
                  onTogglePlay: handleReplayTogglePlay,
                  onSeek: handleReplaySeek,
                  onSpeed: handleReplaySpeed,
                  onCycleCamera: cycleCamera,
                  onExit: () => exitReplayRef.current(),
                  onFlashback: () => flashbackReplayRef.current(),
                  exitKeyLabel: settings.keys.replay[0] ? keyLabel(settings.keys.replay[0]) : "T",
                }
              : null
          }
          touchControls={
            touchVisible && vrState !== "on"
              ? {
                  tiltSteer: settings.touch.tiltSteer,
                  tiltRangeDeg: settings.touch.tiltRangeDeg,
                  onPause: togglePause,
                  onCycleCamera: cycleCamera,
                }
              : null
          }
        />
      ) : null}

      {phase === "title" ? (
        <TitleMenu
          {...menuProps}
          onCycleCamera={cycleCamera}
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
            hostControlled: lobby !== null && !isMpHost,
            readout: weatherHud,
          }}
        />
      ) : null}

      {phase === "wizard" ? (
        <FirstRunWizard
          mode={wizardMode}
          settings={settings}
          onChangeSettings={handleChangeSettings}
          steerLockDeg={steerLockDeg}
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
          autoGearbox={autoGearbox}
          onSetAutoGearbox={setAutoGearbox}
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

      {/* Wheel force feedback over WebHID waits for one pairing click: offered on the title and the pause menu (not over
          the controls setup opened from it), never mid-lap */}
      <FfbPairPrompt wanted={hidFfbWanted && settings.wheel.steer !== null && (phase === "title" || (phase === "driving" && paused))} />

      {loadingVisible ? (
        <LoadingScreen track={track} ready={assetsReady} onStart={handleLoadingStart} onDone={handleLoadingDone} />
      ) : null}
    </div>
  );
};
