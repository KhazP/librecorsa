"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { getActiveTrackData, LIVERIES } from "@/lib/track-data";
import { F1Physics2026 } from "@/lib/f1-physics-2026";
import type { SimulatorCar } from "@/lib/sim/simulator-car";
import { F1AudioEngine2026 } from "@/lib/f1-audio-2026";
import { type SimCarRig } from "@/lib/car-builder-2026";
import { FfbPairPrompt } from "@/components/hud/FfbPairPrompt";
import { isVehicleModelId, vehicleModelsFor } from "@/lib/cars/vehicle-models";
import { carForVehicle, type CarId } from "@/lib/cars/car-registry";
import { alignGhostToTrack } from "@/lib/sim/ghost-align";
import { carPhysics, carTakesPhysicsSwitch, subscribeF1ModPhysics } from "@/lib/cars/f1-mod-physics";
import { type ChassisSetup, DEFAULT_CHASSIS_SETUP, saveChassisSetup } from "@/lib/sim/car-setup";
import { AiOpponentField, AI_DRIVERS } from "@/lib/sim/ai-opponents";
import { TrackEnvironment } from "@/lib/sim/track-environment";
import { GamepadHaptics } from "@/lib/sim/gamepad-haptics";
import { getMultiplayerManager, type LobbySettings, type LobbyState, type P2PConnectionStatus, type PeerNetStats, type RaceStartInfo } from "@/lib/sim/multiplayer-sync";
import { MultiplayerRace } from "@/lib/sim/race-session";
import { GhostPlayer, LapRecorder } from "@/lib/sim/lap-recorder";
import { ReplayBuffer } from "@/lib/sim/replay-buffer";
import { lapBoardClass, lapConditionsNow, type LapConditions, type LapRecording, type LapSummaryData, type LeaderboardEntry } from "@/lib/sim/lap-types";
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
import { isTouchDevice, resetTouchInput } from "@/lib/input/touch-input";
import { isFatalHidStatus } from "@/lib/input/webhid-ffb";
import { KeyboardPedalAssist } from "@/lib/input/keyboard-pedals";
import { SIM_REALISM_FLAGS, type SimRealism } from "@/lib/sim/sim-realism";
import type { SessionConditions } from "@/lib/sim/weather";
import type { WeatherHudState } from "@/components/hud/WeatherBadge";
import { getTrackInfo } from "@/lib/track-registry";
import { F1TelemetryHud } from "@/components/F1TelemetryHud";
import { roomFromUrl } from "@/lib/net/invite-room";
import { CAMERA_MODES, FALLBACK_COCKPIT_FOV_DEG, nextCameraMode } from "@/lib/render/camera-modes";
import { saveTyreSetup } from "@/lib/sim/tyre-setup";
import { LoadingScreen } from "@/components/menu/LoadingScreen";
import { TitleMenu } from "@/components/menu/TitleMenu";
import { FirstRunWizard, type WizardMode, type WizardStepId } from "@/components/menu/FirstRunWizard";
import { buildKeyLookup, keyLabel, padButtonLabel } from "@/lib/input/bindings";
import { autoConfigureWheel, connectedPads } from "@/lib/input/device-input";
import { webHidFfb, wheelFfb } from "@/lib/input/wheel-ffb";
import { DEFAULT_STEERING_ASSIST, steeringAssistSettings, type SteeringAssistSettings } from "@/lib/sim/steering-assist";
import { clampFov, codeFromName, DEFAULT_PLAYER_SETTINGS, loadCarChoice, loadOnboarded, loadPlayerSettings, loadRumble, pushLibraryRecent, saveCarChoice, saveOnboarded, toggleLibraryFavorite, type LibraryKind, sanitizeDriverName, savePlayerSettings, saveRumble, type PlayerSettings } from "@/lib/settings/player-settings";
import type { AeroSetupPreset, AssistPreset, CameraMode, CarTelemetry, LiveTunerPatch, LiveryConfig, TireCompound, TyreSetup, VehicleModelId } from "@/types/f1";
import {
  aiFieldOf,
  autoCompoundFor,
  DEFAULT_AERO_PRESET,
  DriveSession,
  HELD_KEYS,
  mpRaceOf,
  scheduleIdle,
  soundFor,
  type AppPhase,
  type RunResetReason,
  type SessionRace,
  type VrState,
} from "@/lib/drive-session";

const DEFAULT_ASSIST_PRESET: AssistPreset = DEFAULT_PLAYER_SETTINGS.assistPreset;
/** A lap record's car: records are per vehicle model, named after its first car */
const vehicleLabel = (id: string) => (isVehicleModelId(id) ? carForVehicle(id).title : id);
/** A race the host started before this circuit was loaded (or on another one): picked up once the scene has loaded */
let pendingRaceStart: RaceStartInfo | null = null;

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
  /** The session on track: practice, a race against the AI field, or an online race (written only by setRace) */
  const raceRef = useRef<SessionRace>({ kind: "practice" });
  /** Its kind, for the menus */
  const [raceKind, setRaceKind] = useState<SessionRace["kind"]>("practice");
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
    raceRef.current = next;
    setRaceKind(next.kind);
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
      if (raceRef.current.kind !== "mp") return;
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
      if (raceRef.current.kind === "mp") return;
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
    if (!physics || raceRef.current.kind === "mp") return;
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
      const race = raceRef.current;
      if (race.kind === "mp") {
        if (isMpHostRef.current && !flyingStart) getMultiplayerManager().startRace();
        return;
      }
      const physics = physicsRef.current;
      if (!physics) return;
      resetRun("restart");
      if (race.kind === "ai") race.field.startRace(!flyingStart);
      else physics.resetToStartGrid(flyingStart);
    },
    [unlockAudio, resetRun]
  );

  const handleToggleAiOpponents = useCallback(() => {
    unlockAudio();
    const physics = physicsRef.current;
    // Not in a multiplayer race: the AI field would run alongside it
    if (!physics || raceRef.current.kind === "mp") return;
    resetRun("race");
    if (raceRef.current.kind === "ai") {
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
      if (!physics || raceRef.current.kind === "mp") return;
      resetRun("teleport");
      // Corner practice leaves the race: the field would otherwise lose track of the player's distance
      if (raceRef.current.kind === "ai") setRace({ kind: "practice" });
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
    aiFieldOf(raceRef.current)?.setSkill(aiSkill);
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
      const field = race && physics ? (aiFieldOf(raceRef.current) ?? takeAiField(physics)) : null;
      startSession(field ? { kind: "ai", field } : { kind: "practice" });
      if (field) field.startRace(true);
      else physics?.resetToStartGrid(false);
      setLaunchHint(true);
    },
    [takeAiField, startSession]
  );

  // In the menus (after loading, after a race): have the next race's AI field ready (a car swap asks for its own)
  useEffect(() => {
    if (phase === "loading" || phase === "driving" || !assetsReady) return;
    prepareAiField();
  }, [phase, assetsReady, prepareAiField]);

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
    const session = new DriveSession(container, {
      aiFieldSpareRef,
      applyGraphicsRef,
      assistSettingsRef,
      audioRef,
      autopilotPaceRef,
      boostLatchRef,
      cameraModeRef,
      carCockpitFovRef,
      carIdRef,
      carRigRef,
      cockpitFovRef,
      cycleCamera,
      enterVrRef,
      exitReplayRef,
      flashbackReplayRef,
      getTrackEnv,
      ghostRef,
      handleToggleMute,
      handleToggleRacingLine,
      hapticsRef,
      kbInputRef,
      kbPedalAssistRef,
      keyLookupRef,
      keysRef,
      lapRecorderRef,
      liveryRef,
      mouseSteerEnabledRef,
      mouseSteerValueRef,
      onLapCompletedRef,
      pausedRef,
      phaseRef,
      physicsRef,
      prepareAiField,
      raceRef,
      racingLineMeshRef,
      releaseHeldKeys,
      replayRef,
      resetRunRef,
      rumbleEnabledRef,
      runIdRef,
      setAssetsReady,
      setCarCockpitFov,
      setChassisSetup,
      setDefaultTyreSetup,
      setLatch,
      setMouseSteerRef,
      setP2pStatus,
      setPauseNotice,
      setRaceRef,
      setReplayUi,
      setSettings,
      setSteerLockDeg,
      setTelemetry,
      setTireCompound,
      setTyreSetup,
      setVirtualMirrorOn,
      setVrState,
      setWeatherHud,
      settingsRef,
      slashCommandBufferRef,
      steerLockDegRef,
      swapCarRef,
      takeAiField,
      toggleAutopilot,
      togglePauseRef,
      toggleReplayRef,
      track,
      trackId,
      unlockAudio,
      vehicleModelRef,
      vrStateRef,
      wizardStepRef,
    });
    return () => session.dispose();
  }, [track, getTrackEnv, takeAiField, prepareAiField, unlockAudio, handleToggleMute, handleToggleRacingLine, releaseHeldKeys, toggleAutopilot, setLatch, setVrState]);

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
      if (mpRaceOf(raceRef.current)?.start.id === id) endMpRace(false);
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
    aiOpponents: raceKind === "ai",
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
    raceRunning: raceKind === "mp",
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
            raceKind === "mp" && !isMpHost ? undefined : () => handleResetCar(false)
          }
          onBackToLobby={raceKind === "mp" ? handleBackToLobby : undefined}
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
