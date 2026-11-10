import * as THREE from "three";
import { LIVERIES, TURN_METADATA, type BuiltTrackData } from "@/lib/track-data";
import { F1Physics2026, type ControlInputs } from "@/lib/f1-physics-2026";
import { trackColliders } from "@/lib/sim/track-colliders";
import type { SimulatorCar } from "@/lib/sim/simulator-car";
import type { WheelSeating } from "@/lib/render/corner-rig";
import { F1AudioEngine2026 } from "@/lib/f1-audio-2026";
import { createF1Car2026, type SimCarRig } from "@/lib/car-builder-2026";
import { createGt3CarRig, gt3RigCameraAnchors } from "@/lib/gt3-car-model";
import { disposeTree } from "@/lib/render/dispose-tree";
import { GT3_DASH_MESH, GT3_WING_MIRROR_MATERIAL, Gt3DashDisplay } from "@/lib/render/gt3-dash-display";
import { createPortedCarRig } from "@/lib/ported-car-model";
import { staticFloorOf } from "@/lib/render/body-floor";
import { FloorSparks } from "@/lib/render/floor-sparks";
import { vehicleModelSpec } from "@/lib/cars/vehicle-models";
import type { CarSoundSource } from "@/lib/sim/CarAudio";
import { OpponentAudio } from "@/lib/sim/opponent-audio";
import { carById, carForVehicle, carOvertakingRules, carSkinBaseUrl, type CarId } from "@/lib/cars/car-registry";
import { carSkinFor, subscribeCarSkins } from "@/lib/cars/car-skins";
import { trackGeometryKey } from "@/lib/sim/ghost-align";
import { carPhysics } from "@/lib/cars/f1-mod-physics";
import { buildCircuitScene } from "@/lib/scene-builder";
import {
  applyGraphicsQuality,
  configureRenderer,
  createGoldenHourEnvironment,
  createPostFx,
} from "@/lib/render/golden-hour-environment";
import { SteeringWheelDisplay } from "@/lib/render/steering-display";
import { PortedWheelDash } from "@/lib/render/ported-wheel-dash";
import { revRangeFor } from "@/lib/sim/rev-range";
import { WingMirrors } from "@/lib/render/wing-mirrors";
import { VirtualMirror } from "@/lib/render/virtual-mirror";
import { type ChassisSetup, DEFAULT_CHASSIS_SETUP, loadChassisSetup } from "@/lib/sim/car-setup";
import { CameraRig } from "@/lib/render/camera-rig";
import { LapDeltaTracker } from "@/lib/sim/lap-delta";
import { TrackLimitsMonitor } from "@/lib/sim/track-limits";
import { SimVisualFxManager } from "@/lib/sim/visual-fx";
import { AiOpponentField, aiDriversFor, resolvePlayerVsRemoteCar } from "@/lib/sim/ai-opponents";
import { startAiRace } from "@/lib/sim/race-setup";
import { peerWakeEmitters, TrackEnvironment } from "@/lib/sim/track-environment";
import type { WakeEmitterCar } from "@/lib/sim/aero-wake";
import { GamepadHaptics } from "@/lib/sim/gamepad-haptics";
import { getMultiplayerManager, type InterpolatedPeerState, type P2PConnectionStatus } from "@/lib/sim/multiplayer-sync";
import { MultiplayerRace, type MultiplayerRaceFrame } from "@/lib/sim/race-session";
import { GhostPlayer, LapRecorder } from "@/lib/sim/lap-recorder";
import { ReplayBuffer } from "@/lib/sim/replay-buffer";
import { GHOST_CAR_COLOR, steerAngleOf, steerNormOf, wheelRpmAtSpeed, wheelRpmOf } from "@/lib/sim/car-pose";
import { lapConditionsNow, type LapRecording, type LapSummaryData, type ReplayCarState } from "@/lib/sim/lap-types";
import { buildTelemetryPacket } from "@/lib/input/telemetry-out";
import { touchInput } from "@/lib/input/touch-input";
import { createRainFx, RAIN_VISOR_LAYER } from "@/lib/render/rain-fx";
import { DRIVER_HEAD_LAYER, OVERLAY_LAYER } from "@/lib/render/layers";
import { KeyboardPedalAssist } from "@/lib/input/keyboard-pedals";
import { shapeStick } from "@/lib/input/stick-shape";
import { advanceAsphaltRain, setAsphaltWetness } from "@/lib/render/asphalt-sheen";
import {
  isRainCompound,
  recommendedCompound,
  wetnessFromWater,
} from "@/lib/sim/wet-tyres";
import type { WeatherHudState } from "@/components/hud/WeatherBadge";
import { CAMERA_MODES, FALLBACK_COCKPIT_FOV_DEG } from "@/lib/render/camera-modes";
import { loadTyreSetup } from "@/lib/sim/tyre-setup";
import { assetProgress } from "@/lib/loading/asset-progress";
import { prefetchSoundBank } from "@/lib/sim/vf26-audio";
import { CarReflectionProbe } from "@/lib/render/car-reflection-probe";
import { StartupMonitor } from "@/lib/render/startup-monitor";
import { addContactShadow, seatContactShadow } from "@/lib/render/contact-shadow";
import { buildKeyLookup, HUD_TOGGLE_EVENT, type KeyAction } from "@/lib/input/bindings";
import { carWheelLockDeg, connectedPads, DeviceInputReader, findPad } from "@/lib/input/device-input";
import { webHidFfb, wheelFfb } from "@/lib/input/wheel-ffb";
import { simMode } from "@/lib/sim/runtime/sim-mode";
import { createSimHost } from "@/lib/sim/runtime/sim-host";
import { startSimWorker } from "@/lib/sim/runtime/worker-sim-host";
import { steeringAssistSettings } from "@/lib/sim/steering-assist";
import { axleSlipFromTelemetry, createAxleSlipSample } from "@/lib/sim/tyre-slip";
import { clampFov, DEFAULT_KEYBOARD_TUNING, DEFAULT_PLAYER_SETTINGS, type PlayerSettings } from "@/lib/settings/player-settings";
import type { AeroSetupPreset, CameraMode, CarTelemetry, LiveTunerPatch, RadarBlip, TireCompound, TyreSetup, VehicleModelId } from "@/types/f1";

/** Matches the aero package the track's target speeds / braking markers are computed for */
export const DEFAULT_AERO_PRESET: AeroSetupPreset = "balanced";
/** Longest frame (s) simulated in full; must not exceed the physics' own F1Physics2026.MAX_CATCH_UP_S */
const MAX_FRAME_CATCH_UP_S = F1Physics2026.MAX_CATCH_UP_S;

// Keyboard-only input shaping: a key press becomes a pedal squeeze, not a step
/** A replay / flashback opens this far before the present, paused (s) */
const REPLAY_OPEN_BACK_S = 3;
const KB_THROTTLE_RISE_S = DEFAULT_KEYBOARD_TUNING.throttleRiseS;
const KB_THROTTLE_FALL_S = 0.1;
const KB_BRAKE_RISE_S = DEFAULT_KEYBOARD_TUNING.brakeRiseS;
const KB_BRAKE_FALL_S = 0.08;

/**
 * Session flow: assets loading → "press any key" → title menu → (first-run / controls setup) → driving.
 * Physics only runs while driving; the menus show the car idling on the grid under an orbiting camera.
 */
export type AppPhase = "loading" | "title" | "wizard" | "driving";

/** The race on track with the player: none (practice), the AI field, or a multiplayer race; never two at once */
export type SessionRace = { kind: "practice" } | { kind: "ai"; field: AiOpponentField } | { kind: "mp"; race: MultiplayerRace };
/** The AI field on track, when the session is a race against it */
export const aiFieldOf = (race: SessionRace): AiOpponentField | null => (race.kind === "ai" ? race.field : null);
/** The multiplayer race on track, when the session is an online race */
export const mpRaceOf = (race: SessionRace): MultiplayerRace | null => (race.kind === "mp" ? race.race : null);
/** Why the run on track starts over (see resetRun) */
export type RunResetReason = "session" | "restart" | "teleport" | "car" | "race" | "flashback";
/** The VR headset: off, being asked for a session, or presenting */
export type VrState = "off" | "requesting" | "on";

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
export type DriveAction = Exclude<KeyAction, HeldKeyAction> | "mfd" | "hud";

/** Telemetry-out rate (Hz) */
const TELEMETRY_OUT_HZ = 60;

/** A multiplayer race while this guest has not yet measured the host's clock: the grid is held, the lights off */
const MP_CLOCK_UNSYNCED_FRAME: MultiplayerRaceFrame = { phase: "countdown", lightsOn: 0, countdownS: 0, raceTimeS: 0 };

/** A loading task with no progress for this long is given up on (the procedural stand-in stays) */
const ASSET_STALL_MS = 25_000;

/** Slicks or rain tyres for the line's water; a car on slicks keeps its own slick */
export const autoCompoundFor = (lineWaterMm: number, current: TireCompound | undefined): TireCompound =>
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

/** What the drive shows the UI: one snapshot, replaced whenever any part changes (see DriveSession.subscribe) */
export interface DriveSnapshot {
  telemetry: CarTelemetry;
  replay: ReplayUi;
  /** The car's steering lock (road-wheel degrees, after the garage's ratio), for the assist menus' countersteer slider */
  steerLockDeg: number | undefined;
  /** The current car's own driver's-eye FOV, for the FOV slider's default */
  carCockpitFovDeg: number;
  /** The virtual mirror strip is on screen */
  virtualMirror: boolean;
  /** Air / track temperature and wetness for the HUD badge and the conditions panel (sampled twice a second) */
  weather: WeatherHudState | null;
  /** Track, car and shaders are loaded (or given up on): the loading screen offers to continue */
  assetsReady: boolean;
  p2pStatus: P2PConnectionStatus;
  /** The headset session; the render loop itself follows renderer.xr.isPresenting, which this tracks */
  vr: VrState;
  /** The car sounds are muted */
  muted: boolean;
  /** The pause menu is open, and why the game paused itself (cleared on resume) */
  paused: boolean;
  pauseNotice: string | null;
  /** The manual-override boost is latched on */
  boostLatch: boolean;
  /** The car's setup as the garage shows it */
  tireCompound: TireCompound;
  tyreSetup: TyreSetup;
  /** The car's own tyre setup, before the player's saved one */
  defaultTyreSetup: TyreSetup;
  chassisSetup: ChassisSetup;
}

/** The snapshot before the drive exists: a throwaway VF26's numbers, as the menus need something to show */
export function idleDriveSnapshot(track: BuiltTrackData): DriveSnapshot {
  const car = new F1Physics2026(track);
  return {
    telemetry: { ...car.telemetry },
    replay: { active: false, timeS: 0, startS: 0, endS: 0, playing: true, speed: 1 },
    steerLockDeg: undefined,
    carCockpitFovDeg: FALLBACK_COCKPIT_FOV_DEG,
    virtualMirror: false,
    weather: null,
    assetsReady: false,
    p2pStatus: {
      mode: "local",
      roomCode: "",
      state: "idle",
      connectedWebRtcPeers: 0,
      statusText: "Ready. Tabs in this browser find each other; other devices join with a room code.",
    },
    vr: "off",
    muted: false,
    paused: false,
    pauseNotice: null,
    boostLatch: false,
    tireCompound: "soft",
    tyreSetup: car.getTyreSetup(),
    defaultTyreSetup: car.getTyreSetup(),
    chassisSetup: DEFAULT_CHASSIS_SETUP,
  };
}

/** A React state setter */
type SetState<T> = (value: T | ((prev: T) => T)) => void;

/** The driving keys held down, and the one-shot presses waiting for the next frame */
export interface DriveKeys {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  boostHold: boolean;
  shiftUp: boolean;
  shiftDown: boolean;
  toggleX: boolean;
  half: boolean;
}

/** The instant replay: the recording, and where it is shown from while open */
export interface ReplayState {
  buffer: ReplayBuffer;
  active: boolean;
  playing: boolean;
  timeS: number;
  speed: number;
}

/** The replay bar's view of the replay */
export interface ReplayUi {
  active: boolean;
  timeS: number;
  startS: number;
  endS: number;
  playing: boolean;
  speed: number;
}

/**
 * What the session needs from the component: the circuit, the car to start with, and the few callbacks it reports
 * back through (settings changes the keys ask for, the race kind, a new run). Everything else goes in through methods
 * and comes back out through the snapshot.
 */
export interface DriveSessionHost {
  /** The car to start with (setCar swaps it later) */
  car: CarId;
  cycleCamera: () => void;
  getTrackEnv: () => TrackEnvironment;
  handleToggleRacingLine: () => void;
  setSettings: SetState<PlayerSettings>;
  /** The session's kind changed (setRace), for the menus */
  setRaceKind: (kind: SessionRace["kind"]) => void;
  /** The run started over (resetRun), for what the component keeps per run */
  onRunReset: (reason: RunResetReason) => void;
  track: BuiltTrackData;
  trackId: string;
}

/**
 * The drive: the renderer, the scene and the player's car, input, cameras, replay, race control, the weather's look,
 * audio cues and the HUD sync, run by one frame loop. The component creates one per mounted circuit.
 */
export class DriveSession {
  private readonly teardown: () => void;
  private snapshot: DriveSnapshot;
  private readonly listeners = new Set<() => void>();
  /** Calls `listener` whenever the snapshot changes (useSyncExternalStore's subscribe); returns the unsubscribe */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** What the drive shows the UI now: the same object until something in it changes */
  readonly getSnapshot = (): DriveSnapshot => this.snapshot;
  /** The race on track with the player: practice, the AI field or an online race (setRace is its only writer) */
  private currentRace: SessionRace = { kind: "practice" };
  /**
   * The run starts over: a new session, a restart or reset, a corner jump, a car change, AI opponents on or off, a
   * flashback. It never moves the car: the caller places it afterwards, so leaving the replay (which puts the drawn
   * car back where the replay found it) comes first and can't undo the move. A flashback keeps its own trimmed
   * replay and the race results.
   */
  readonly resetRun: (reason: RunResetReason) => void;
  /** Puts a race on track with the player (or none): the AI field and a multiplayer race never run together */
  readonly setRace: (next: SessionRace) => void;
  /** The autopilot takes or hands back the player's car; never in a multiplayer race */
  readonly toggleAutopilot: () => void;
  /** The player's car: the VF26 (F1Physics2026) or the f12026-car (F12026CarSim); a car swap replaces it */
  get car(): SimulatorCar {
    return this.carNow();
  }
  private readonly carNow: () => SimulatorCar;
  /** Lap recording for the summary card, the personal-best ghost and the leaderboards */
  readonly lapRecorder: LapRecorder;
  /** The ghost raced in practice (the personal best or a chosen lap), or none */
  readonly setGhost: (ghost: GhostPlayer | null) => void;
  /** Calls `listener` with every lap completed in practice; returns the unsubscribe */
  readonly onLapCompleted: (listener: (summary: LapSummaryData, recording: LapRecording) => void) => () => void;
  /** Where the player is: loading, the title menu, the setup screens or driving (the menus film the car orbiting) */
  readonly setPhase: (phase: AppPhase) => void;
  /** The setup screen's step (the car-select step orbits closer) */
  readonly setWizardStep: (step: string) => void;
  /** Pad rumble on or off */
  readonly setRumble: (on: boolean) => void;
  /** Stops the pad rumble and the wheel's force at once (the pause menu, the menus) */
  readonly silenceFeedback: () => void;
  /** Esc / pad Menu: opens or closes the pause menu, releasing every held key */
  readonly togglePause: () => void;
  /** Closes the pause menu and its notice (a new session) */
  readonly endPause: () => void;
  readonly setBoostLatch: (on: boolean) => void;
  /** A one-shot driving action, as from a key, a pad button or a touch pad */
  readonly runAction: (action: DriveAction) => void;
  /** Creates and starts the car audio on a user gesture (the browser keeps audio locked until one) */
  readonly unlockAudio: () => void;
  readonly toggleMute: () => void;
  /** Builds the next race's AI field while the browser is idle in the menus (never while driving or loading) */
  readonly prepareAiField: () => void;
  /** The AI field for a race: the one built ahead when it was built for this car, else a new one */
  readonly takeAiField: () => AiOpponentField;
  /** The player's preferences: kept for the frame loop, and the ones that act on the car or the scene applied */
  readonly applySettings: (settings: PlayerSettings) => void;
  /** Puts the tyre compound on the car and its model */
  readonly setTireCompound: (compound: TireCompound) => void;
  /** The garage's tyre and chassis setup, and the live tuner, on the car */
  readonly setTyreSetup: (setup: TyreSetup) => void;
  readonly setChassisSetup: (setup: ChassisSetup) => void;
  readonly setLiveTuner: (patch: LiveTunerPatch) => void;
  /** The replay bar's play / pause (from the start again once at the end), seek and speed */
  readonly replayTogglePlay: () => void;
  readonly replaySeek: (timeS: number) => void;
  readonly replaySpeed: (speed: number) => void;
  /** Swaps the player's car in the running scene (the run starts over with it) */
  readonly setCar: (car: CarId) => void;
  /** Applies the graphics preset to the running renderer */
  readonly applyGraphics: (quality: "low" | "medium" | "high", renderScale: number) => void;
  /** Asks the headset for a VR session (one request at a time) */
  readonly enterVr: () => void;
  /** Opens the instant replay a moment back, paused, or closes it */
  readonly toggleReplay: () => void;
  /** Leaves the replay: the drawn car goes back to the live pose */
  readonly exitReplay: () => void;
  /** Starts the run over from the replay's current point */
  readonly flashbackReplay: () => void;

  constructor(container: HTMLDivElement, host: DriveSessionHost) {
    const {
      car: initialCar,
      cycleCamera,
      getTrackEnv,
      handleToggleRacingLine,
      setSettings,
      setRaceKind,
      onRunReset,
      track,
      trackId,
    } = host;

    let disposed = false;
    // What the UI shows goes out through the snapshot (see subscribe)
    const setTelemetry = (telemetry: CarTelemetry) => this.publish({ telemetry });
    const setReplayUi = (next: ReplayUi | ((prev: ReplayUi) => ReplayUi)) =>
      this.publish({ replay: typeof next === "function" ? next(this.snapshot.replay) : next });
    const setSteerLockDeg = (steerLockDeg: number) => this.publish({ steerLockDeg });
    const setCarCockpitFov = (carCockpitFovDeg: number) => this.publish({ carCockpitFovDeg });
    const setVirtualMirrorOn = (virtualMirror: boolean) => this.publish({ virtualMirror });
    const setWeatherHud = (weather: WeatherHudState) => this.publish({ weather });
    const setAssetsReady = (assetsReady: boolean) => this.publish({ assetsReady });
    const setP2pStatus = (p2pStatus: P2PConnectionStatus) => this.publish({ p2pStatus });
    const setVrState = (vr: VrState) => this.publish({ vr });
    const setPauseNotice = (pauseNotice: string) => this.publish({ pauseNotice });
    /** The app phase, the setup screen's step and the rumble switch, as the component last set them */
    let appPhaseNow: AppPhase = "loading";
    let wizardStep = "device";
    let rumbleEnabled = false;
    this.setPhase = (phase) => {
      appPhaseNow = phase;
    };
    this.setWizardStep = (step) => {
      wizardStep = step;
    };
    this.setRumble = (on) => {
      rumbleEnabled = on;
    };
    /** The car being driven and the vehicle model it drives on (setCar changes both) */
    let carIdNow: CarId = initialCar;
    let vehicleNow: VehicleModelId = carPhysics(initialCar);
    let ghostPlayer: GhostPlayer | null = null;
    this.setGhost = (ghost) => {
      ghostPlayer = ghost;
    };
    const lapListeners = new Set<(summary: LapSummaryData, recording: LapRecording) => void>();
    this.onLapCompleted = (listener) => {
      lapListeners.add(listener);
      return () => lapListeners.delete(listener);
    };
    /** The player car's dry autopilot pace, which the weather scales each frame */
    let autopilotPace: { car: unknown; pace: number } = { car: null, pace: 1 };
    /** The boost latch, for the frame loop and the HUD at once */
    const setLatch = (boostLatch: boolean) => this.publish({ boostLatch });
    this.setBoostLatch = setLatch;

    /** The driving keys held down, and the one-shot presses waiting for the next frame */
    const heldKeys: DriveKeys = {
      up: false,
      down: false,
      left: false,
      right: false,
      boostHold: false,
      shiftUp: false,
      shiftDown: false,
      toggleX: false,
      half: false,
    };
    /** Ramped keyboard pedals 0..1 (the steering keys are shaped by the car's steering assist) */
    const kbInput = { throttle: 0, brake: 0 };
    /** Slip help on the keyboard's pedals while the car's ABS / traction control is off */
    const kbPedalAssist = new KeyboardPedalAssist();
    /** The mouse's steering, -1..1, while mouse steering is on */
    let mouseSteerValue = 0;
    /** Typed "/boost" so far */
    let slashCommandBuffer = "";
    /** Lets go of every held driving key: on pause, and when the window loses focus (its keyups never arrive) */
    const releaseHeldKeys = () => {
      for (const flag of Object.values(HELD_KEYS)) heldKeys[flag] = false;
      kbInput.throttle = 0;
      kbInput.brake = 0;
      kbPedalAssist.reset();
    };
    this.togglePause = () => {
      if (disposed) return;
      const paused = !this.snapshot.paused;
      this.publish(paused ? { paused } : { paused, pauseNotice: null });
      if (paused) {
        wheelFfb.stop();
        releaseHeldKeys();
      }
    };
    this.endPause = () => this.publish({ paused: false, pauseNotice: null });

    /** The car sounds: created by the first unlockAudio, then paused and resumed by the frame loop alone */
    let audio: F1AudioEngine2026 | null = null;
    this.unlockAudio = () => {
      if (disposed) return;
      if (!audio) {
        audio = new F1AudioEngine2026();
        audio.setCar(soundFor(carIdNow));
        // Created paused unless the car is being driven; from then on the frame loop alone pauses and resumes it
        audio.setPaused(this.snapshot.paused || appPhaseNow !== "driving");
      }
      if (!audio.isInitialized) {
        audio.init();
        audio.setMuted(this.snapshot.muted);
      } else {
        audio.resume();
      }
    };
    this.toggleMute = () => {
      this.unlockAudio();
      const muted = !this.snapshot.muted;
      this.publish({ muted });
      audio?.setMuted(muted);
    };
    /** The player's preferences (applySettings), and what the frame loop derives from them */
    let settings: PlayerSettings = DEFAULT_PLAYER_SETTINGS;
    let keyLookup = buildKeyLookup(settings.keys);
    let assistSettings = steeringAssistSettings(settings.padTuning, settings.keyboardTuning);
    const liveryFor = (id: string | null) => LIVERIES.find((l) => l.id === id) ?? LIVERIES[0];
    let livery = liveryFor(settings.liveryId);
    const raceNow = (): SessionRace => this.currentRace;
    /**
     * Bumped whenever the run on track starts over (see resetRun) and written into the telemetry every frame, so
     * anything holding lap- or run-scoped state (race control's track limits) starts over with it.
     */
    let runId = 0;
    /** The instant replay: the recording, and where it is shown from while open */
    const replay: ReplayState = { buffer: new ReplayBuffer({ maxSeconds: 90, hz: 30 }), active: false, playing: true, timeS: 0, speed: 1 };
    /** Race control's session for a race on track (or practice) */
    const limitsSessionOf = (race: SessionRace) => (race.kind === "practice" ? "practice" : "race");
    this.setRace = (next) => {
      this.currentRace = next;
      setRaceKind(next.kind);
      trackLimits.reset(limitsSessionOf(next));
    };
    this.toggleAutopilot = () => {
      if (disposed || raceNow().kind === "mp") return;
      physics.aiAutopilot = !physics.aiAutopilot;
      if (physics.aiAutopilot && physics.vxMs < 5) physics.vxMs = 45;
    };
    // A circuit switch remounts this component: its track and warm-up load again (the car models stay cached)
    assetProgress.reset(["track", "opponents", "shaders"]);
    // The engine sound downloads alongside (decoded once the first key press unlocks audio)
    prefetchSoundBank(soundFor(carIdNow).assetDir);
    /** The authored track once the GLB is loaded: the f12026-car drives on its Track_Collider_* meshes */
    let trackRoot: THREE.Object3D | null = null;

    /**
     * A car of the chosen model on the start grid, with the session's presets carried over from `prev`
     * (defaults for the first car) and that car's saved tyre setup
     */
    /**
     * The simulation worker, while it is opt-in (`sim-mode.ts`): it drives the player's car in practice, through a
     * stand-in the rest of the session uses as the car (`sim-host.ts`). AI and online races run on the page.
     */
    const simWorker = simMode() === "worker" ? startSimWorker() : null;
    const simHost = simWorker ? createSimHost(simWorker) : null;
    simWorker?.ping().then(
      (ms) => console.info(`[sim] worker round trip ${ms.toFixed(1)} ms`),
      (reason) => console.warn("[sim] worker unavailable, simulating on the page:", reason)
    );
    const createCar = (vehicle: VehicleModelId, prev: SimulatorCar | null, carId: CarId = carIdNow): SimulatorCar => {
      const built = vehicleModelSpec(vehicle).createSim(track, trackRoot);
      const car = simHost ? simHost.adopt(built, vehicle, trackRoot) : built;
      // An F1 car's overtaking aids by its year, and race control for them while a race is on (free in practice);
      // other classes have none
      const rules = carOvertakingRules(carById(carId));
      if (rules !== undefined) car.setOvertakingRules?.(rules);
      if (car.overtakingRules) {
        const self = car;
        car.raceControl = {
          get racing() {
            const race = raceNow();
            return race.kind === "mp" ? race.race.raceRulesActive : race.kind === "ai" ? race.field.raceRulesActive : false;
          },
          earnedAtDetection: () => {
            const race = raceNow();
            return race.kind === "mp" ? race.race.detectionEarnedFor(self) : race.kind === "ai" ? race.field.detectionEarnedFor(self) : true;
          },
        };
      }
      car.aiAutopilot = false;
      // The player's preferences from their settings; the aero package and the tyre on from the car before
      const prefs = settings;
      car.assistPreset = prefs.assistPreset;
      car.gamepadAssistEnabled = prefs.gamepadAssist;
      car.autoGearbox = prefs.autoGearbox;
      car.aeroPreset = prev?.aeroPreset ?? DEFAULT_AERO_PRESET;
      if (prev) {
        car.tireCompound = prev.tireCompound;
      } else {
        car.tireCompound = autoCompoundFor(getTrackEnv().weather.lineWaterMm, car.tireCompound);
      }
      car.resetToStartGrid(false);

      // Capture the car's defaults first, then apply its saved tyre setup (if any)
      const tyreDefaults = car.getTyreSetup();
      const initialTyreSetup = loadTyreSetup(vehicle) ?? tyreDefaults;
      car.setTyreSetup(initialTyreSetup);
      // and its garage chassis setup
      const chassis = loadChassisSetup(vehicle);
      car.applyChassisSetup?.(chassis);
      carSetup = { tireCompound: car.tireCompound, tyreSetup: initialTyreSetup, defaultTyreSetup: tyreDefaults, chassisSetup: chassis };
      return car;
    };
    /** The last car's setup as the garage shows it (createCar's) */
    let carSetup!: Pick<DriveSnapshot, "tireCompound" | "tyreSetup" | "defaultTyreSetup" | "chassisSetup">;

    let physics = createCar(vehicleNow, null);
    this.carNow = () => physics;
    this.snapshot = {
      telemetry: { ...physics.telemetry },
      replay: { active: false, timeS: 0, startS: 0, endS: 0, playing: true, speed: 1 },
      steerLockDeg: undefined,
      carCockpitFovDeg: FALLBACK_COCKPIT_FOV_DEG,
      virtualMirror: false,
      weather: null,
      assetsReady: false,
      p2pStatus: getMultiplayerManager().status,
      vr: "off",
      muted: false,
      paused: false,
      pauseNotice: null,
      boostLatch: false,
      ...carSetup,
    };

    /**
     * An AI field built ahead, while the player is in the menus: building five AI cars (physics, autopilot plans) takes
     * a few hundred ms, which would otherwise be the first frame of the race. Only valid for the car and the field size
     * it was built for.
     */
    let aiFieldSpare: { field: AiOpponentField; physics: SimulatorCar; opponents: number } | null = null;
    /** A new AI field round the player's car, of the race setup's size, at the player's chosen skill */
    const buildAiField = (car: SimulatorCar) =>
      new AiOpponentField(track, car, aiDriversFor(settings.race.opponents), getTrackEnv(), { skill: settings.aiSkill });
    this.prepareAiField = () => {
      const run = () => {
        // Never while driving: the build would be a hitch on track instead
        if (disposed || appPhaseNow === "driving" || appPhaseNow === "loading") return;
        const opponents = settings.race.opponents;
        if (aiFieldSpare?.physics === physics && aiFieldSpare.opponents === opponents) return;
        aiFieldSpare = { field: buildAiField(physics), physics, opponents };
      };
      scheduleIdle(run);
    };
    this.takeAiField = () => {
      const spare = aiFieldSpare;
      aiFieldSpare = null;
      const skill = settings.aiSkill;
      if (spare && spare.physics === physics && spare.opponents === settings.race.opponents) {
        if (spare.field.skill !== skill) spare.field.setSkill(skill);
        return spare.field;
      }
      return buildAiField(physics);
    };

    this.setCar = (car) => {
      if (disposed) return;
      const newCar = car !== carRigCar;
      // The run starts over before the old car goes: leaving the replay writes its saved pose into `physics`, which
      // must still be the old car then. The replay and the live delta belong to the old car.
      this.resetRun("car");
      const vehicle = carPhysics(car);
      carIdNow = car;
      vehicleNow = vehicle;
      physics = createCar(vehicle, physics, car);
      this.publish(carSetup);
      swapCarRig(car);
      prefetchSoundBank(soundFor(car).assetDir);
      lapRecorder.setContext({ vehicle });
      lapDelta.reset();
      // A running race restarts from the lights with the new car
      if (raceNow().kind === "ai") {
        const field = this.takeAiField();
        if (trackRoot) field.attachTrackRoot(trackRoot);
        this.setRace({ kind: "ai", field });
        startAiRace(field, settings.race);
      }
      setTelemetry({ ...physics.telemetry });
      // In the menus, the next race's field is built for the new car
      this.prepareAiField();
      // Another car's sound (the physics switch keeps the car, and its sound)
      if (newCar) audio?.setCar(soundFor(car));
    };

    const haptics = new GamepadHaptics();
    this.silenceFeedback = () => {
      haptics.stop();
      wheelFfb.stop();
    };

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

    // Golden-hour sky dome, its baked PMREM environment, horizon fog and the cascaded sun shadow. On Medium and High
    // the physically based sky with volumetric clouds replaces the dome (physical-sky.ts); `?sky=classic` keeps the
    // dome on every preset
    const env = createGoldenHourEnvironment(renderer, scene, {
      physicalSky: new URLSearchParams(window.location.search).get("sky") !== "classic",
    });
    // Rain streaks around the camera (one GPU-animated draw, hidden in the dry)
    const rainFx = createRainFx(scene);
    // Scene render + one merged effect pass (mipmap bloom, then AgX tone mapping); applyGraphicsQuality puts the
    // physical sky's clouds in front of it
    const postFx = createPostFx(renderer, scene, camera);
    // Live reflections of the world on the cars (High / Medium); Low keeps the sky's
    const reflectionProbe = new CarReflectionProbe(renderer, scene);
    // `?perf=1`: a report of the first 30 s on track (startup-monitor.ts)
    const startupMonitor = StartupMonitor.requested() ? new StartupMonitor(renderer) : null;
    reflectionProbe.setSky(env.probeSky);
    // Top-centre virtual rear-view mirror for the views without wing mirrors in shot
    const virtualMirror = new VirtualMirror(renderer, scene);
    let virtualMirrorShown = false;

    const builtCircuit = buildCircuitScene(track);
    scene.add(builtCircuit.sceneGroup);
    builtCircuit.racingLineMesh.visible = settings.racingLine;
    // Track_Collider_Road / surface colliders and Track_Collider_Wall_* barriers for the f12026-car
    void builtCircuit.trackRoot.then((root) => {
      if (disposed) return;
      trackRoot = root;
      physics.attachTrackRoot?.(root);
      aiFieldOf(raceNow())?.attachTrackRoot(root);
      aiFieldSpare?.field.attachTrackRoot(root);
      // Move broadcast cameras that would film the inside of a grandstand: about a second of raycasts on a scan,
      // spread over idle slices so neither the loading screen nor the menus freeze (until done, the TV view uses
      // the stations as built)
      const occlusion = cameraRig.occlusionSteps(root);
      const occlusionSlice = (deadline?: IdleDeadline) => {
        if (disposed) return;
        // On track only true idle time counts: a slice the browser forces after its timeout would be a hitch
        const driving = appPhaseNow === "driving";
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
    /** The livery files the player picked for a car with its own (null: the paint its model was made in) */
    const skinUrlFor = (car: CarId): string | null => {
      const skins = carById(car).skins;
      const skin = carSkinFor(car);
      return skin && skins && skin.id !== skins[0].id ? carSkinBaseUrl(car, skin.id) : null;
    };
    const createCarRig = (car: CarId): SimCarRig => {
      const def = carById(car);
      const model = rigModel(car);
      const rig = def.modelUrl
        ? createPortedCarRig({
            url: def.modelUrl,
            chassis: model.rigConfig.chassis,
            // the rim on screen turns with the player's own (its lock is the player's when they set one)
            steerLockDeg: carWheelLockDeg(def.physics, settings.wheel.steerLockPerCar) / 2,
            floor: staticFloorOf(model.rigConfig),
            // every GT3 uses the AMG GT3's onboard and chase views, framed on its own steering wheel and front axle
            cameraAnchors: model.gt3Cockpit ? gt3RigCameraAnchors : undefined,
            // F1 cars from 2018 on wear the 2026 Pirelli sidewall (the SF71H on its 13" tyres too; the models' own are poor)
            pirelliSidewall: def.classId === "f1" && def.year >= 2018,
            skinBaseUrl: skinUrlFor(car),
          })
        : model.gt3Cockpit
          ? createGt3CarRig()
          : createF1Car2026(livery, physics.tireCompound);
      rig.setLivery(livery);
      rig.setTireCompound(physics.tireCompound);
      reflectionProbe.track(rig.root);
      addContactShadow(rig.root, def.physics);
      scene.add(rig.root);
      return rig;
    };
    let carRig = createCarRig(carIdNow);
    let carRigCar: CarId = carIdNow;
    // A livery picked in the menus goes onto the car at once
    const unsubscribeCarSkins = subscribeCarSkins(() => carRig.setSkin?.(skinUrlFor(carRigCar)));
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
      portedDash?.dispose();
      portedDash = null;
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
    void visualFx.prewarm(carPhysics(carIdNow));
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
      vehicle: vehicleNow,
      driverName: settings.profile.name,
      driverCode: settings.profile.code,
    });
    this.lapRecorder = lapRecorder;

    this.applyGraphics = (quality, renderScale) => {
      if (disposed) return;
      applyGraphicsQuality(renderer, postFx, env, quality, renderScale);
      reflectionProbe.setQuality(quality === "low" ? "off" : quality);
      postFx.setSize(container.clientWidth, container.clientHeight);
    };
    this.applyGraphics(settings.graphics.quality, settings.graphics.renderScale);
    this.applySettings = (next) => {
      const prev = settings;
      if (disposed || next === prev) return;
      settings = next;
      if (next.keys !== prev.keys) keyLookup = buildKeyLookup(next.keys);
      if (next.padTuning !== prev.padTuning || next.keyboardTuning !== prev.keyboardTuning) {
        assistSettings = steeringAssistSettings(next.padTuning, next.keyboardTuning);
      }
      // The preferences the game applies to the car (a new car takes them in createCar)
      if (next.assistPreset !== prev.assistPreset) physics.assistPreset = next.assistPreset;
      if (next.gamepadAssist !== prev.gamepadAssist) physics.gamepadAssistEnabled = next.gamepadAssist;
      if (next.autoGearbox !== prev.autoGearbox) physics.autoGearbox = next.autoGearbox;
      builtCircuit.racingLineMesh.visible = next.racingLine;
      if (prev.mouseSteer && !next.mouseSteer) mouseSteerValue = 0;
      if (next.liveryId !== prev.liveryId) {
        livery = liveryFor(next.liveryId);
        carRig.setLivery(livery);
      }
      if (next.graphics.quality !== prev.graphics.quality || next.graphics.renderScale !== prev.graphics.renderScale) {
        this.applyGraphics(next.graphics.quality, next.graphics.renderScale);
      }
      // Another field size needs another field: a race running restarts from the lights with it
      if (next.race.opponents !== prev.race.opponents) {
        aiFieldSpare = null;
        if (raceNow().kind === "ai") {
          this.resetRun("race");
          const field = this.takeAiField();
          if (trackRoot) field.attachTrackRoot(trackRoot);
          this.setRace({ kind: "ai", field });
          startAiRace(field, next.race);
        }
      }
    };
    this.setTireCompound = (compound) => {
      if (disposed) return;
      physics.tireCompound = compound;
      carRig.setTireCompound(compound);
      this.publish({ tireCompound: compound });
    };
    this.setTyreSetup = (setup) => {
      if (disposed) return;
      physics.setTyreSetup(setup);
      this.publish({ tyreSetup: setup });
    };
    this.setChassisSetup = (setup) => {
      if (disposed) return;
      physics.applyChassisSetup?.(setup);
      this.publish({ chassisSetup: setup });
    };
    this.setLiveTuner = (patch) => {
      if (disposed) return;
      physics.setLiveTuner?.(patch);
      const updated = physics.getLiveTunerState?.() ?? physics.telemetry.liveTuner;
      if (updated) this.publish({ telemetry: { ...this.snapshot.telemetry, liveTuner: { ...updated } } });
    };

    // WebXR: the headset's pose is added to a rig placed at the driver's eye every frame
    renderer.xr.enabled = true;
    const xrRig = new THREE.Group();
    const xrCamera = new THREE.PerspectiveCamera(70, 1, 0.05, 5500);
    xrCamera.layers.enable(OVERLAY_LAYER);
    xrRig.add(xrCamera);
    scene.add(xrRig);
    this.enterVr = () => {
      if (disposed) return;
      const xr = (navigator as Navigator & { xr?: { requestSession: (mode: string, init?: object) => Promise<XRSession> } }).xr;
      // One request at a time: a second click while the headset is being asked does nothing
      if (!xr || this.snapshot.vr !== "off" || renderer.xr.isPresenting) return;
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
      if (!settings.mouseSteer) return;
      const w = Math.max(1, window.innerWidth);
      // Center 65% of screen maps smoothly to [-1, 1] steering lock with slight precision curve
      const rawNorm = ((e.clientX / w) * 2 - 1) / 0.65;
      const clamped = THREE.MathUtils.clamp(rawNorm, -1, 1);
      mouseSteerValue =
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
      if (appPhaseNow !== "driving") return;
      this.unlockAudio();
      const code = e.code;

      if (code === "Escape") {
        e.preventDefault();
        this.togglePause();
        return;
      }
      if (this.snapshot.paused) return;

      // [ / ] narrow / widen the onboard FOV live, unless the player bound those keys to a control
      if ((code === "BracketLeft" || code === "BracketRight") && !keyLookup.has(code)) {
        const step = code === "BracketLeft" ? -1 : 1;
        setSettings((prev) => ({
          ...prev,
          cockpitFovDeg: Math.round(clampFov((prev.cockpitFovDeg ?? this.snapshot.carCockpitFovDeg) + step)),
        }));
        return;
      }

      // Support typing "/boost" anywhere to latch 350kW MGU-K + 425kW ICE Overboost ("/" starts it unless a control
      // is bound to that key)
      if (e.key && e.key.length === 1) {
        if (e.key === "/" && !keyLookup.has(code)) {
          slashCommandBuffer = "/";
          return;
        } else if (slashCommandBuffer.startsWith("/")) {
          slashCommandBuffer = (
            slashCommandBuffer + e.key.toLowerCase()
          ).slice(-6);
          if (slashCommandBuffer === "/boost") {
            // Latches on (never off), and only when the car grants the override
            if (physics.activateBoostOverride()) setLatch(true);
            slashCommandBuffer = "";
            return;
          }
          if ("/boost".startsWith(slashCommandBuffer)) {
            return;
          } else {
            slashCommandBuffer = "";
          }
        }
      }

      const action = keyLookup.get(code);
      if (!action) return;
      // Held controls ignore auto-repeat anyway; toggles must not flicker while a key is held
      if (isHeldKeyAction(action)) {
        heldKeys[HELD_KEYS[action]] = true;
        if (DRIVER_KEYS.has(action) && physics.aiAutopilot) physics.aiAutopilot = false;
        return;
      }
      // Held controls ignore auto-repeat anyway; one-shot actions must not flicker while a key is held
      if (e.repeat) return;
      runAction(action);
    };

    this.runAction = (action) => {
      if (!disposed) runAction(action);
    };
    /** Every one-shot driving action, from the keyboard, a pad or the touch pads */
    const runAction = (action: DriveAction) => {
      switch (action) {
        case "shiftUp":
          heldKeys.shiftUp = true;
          break;
        case "shiftDown":
          heldKeys.shiftDown = true;
          break;
        case "aero":
          heldKeys.toggleX = true;
          break;
        case "boostLatch":
          setLatch(!this.snapshot.boostLatch);
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
          this.toggleReplay();
          break;
        case "mouseSteer":
          setSettings((prev) => ({ ...prev, mouseSteer: !prev.mouseSteer }));
          break;
        case "mute":
          this.toggleMute();
          break;
        case "autopilot":
          this.toggleAutopilot();
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
      const race = raceNow();
      if (race.kind === "mp") return;
      // Out of a replay first (the reset does that), then the car moves
      this.resetRun("restart");
      if (race.kind === "ai") startAiRace(race.field, settings.race);
      else physics.resetToStartGrid(true);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      const action = keyLookup.get(e.code);
      if (action && isHeldKeyAction(action)) heldKeys[HELD_KEYS[action]] = false;
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
      const rp = replay;
      if (!rp.active) return;
      rp.active = false;
      // The replay only moved the drawn car (the physics never left the live pose): put the drawing back
      physics.worldPosition.copy(replaySaved.pos);
      physics.worldQuaternion.copy(replaySaved.quat);
      cameraRig.reset();
      setReplayUi((u) => ({ ...u, active: false }));
    };
    const flashbackReplay = () => {
      const rp = replay;
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
      this.resetRun("flashback");
    };
    this.exitReplay = () => {
      if (!disposed) exitReplay();
    };
    this.flashbackReplay = () => {
      if (!disposed) flashbackReplay();
    };
    this.toggleReplay = () => {
      if (disposed) return;
      const rp = replay;
      if (rp.active) return exitReplay();
      // Not in a multiplayer race (the field keeps racing) and only with something recorded
      if (raceNow().kind === "mp" || rp.buffer.durationS < 1 || appPhaseNow !== "driving") return;
      replaySaved.pos.copy(physics.worldPosition);
      replaySaved.quat.copy(physics.worldQuaternion);
      // Opens paused a moment back, showing the car there: scrub back to the point to flash back to, or play
      rp.active = true;
      rp.playing = false;
      rp.speed = 1;
      rp.timeS = Math.max(rp.buffer.startS, rp.buffer.endS - REPLAY_OPEN_BACK_S);
      cameraRig.reset();
      setReplayUi({ active: true, timeS: rp.timeS, startS: rp.buffer.startS, endS: rp.buffer.endS, playing: false, speed: 1 });
    };

    this.resetRun = (reason) => {
      if (disposed) return;
      runId++;
      if (reason !== "flashback") {
        exitReplay();
        replay.buffer.clear();
      }
      onRunReset(reason);
      // Race control and the cameras start over with the run (the car is about to be put somewhere else)
      trackLimits.reset(limitsSessionOf(raceNow()));
      cameraRig.reset();
      lapRecorder.reset();
      physics.aiAutopilot = false;
      kbInput.throttle = 0;
      kbInput.brake = 0;
      kbPedalAssist.reset();
    };
    this.replayTogglePlay = () => {
      if (!replay.playing && replay.timeS >= replay.buffer.endS - 0.05) replay.timeS = replay.buffer.startS;
      replay.playing = !replay.playing;
      setReplayUi((u) => ({ ...u, playing: replay.playing, timeS: replay.timeS }));
    };
    this.replaySeek = (tS) => {
      replay.timeS = tS;
      setReplayUi((u) => ({ ...u, timeS: tS }));
    };
    this.replaySpeed = (speed) => {
      replay.speed = speed;
      setReplayUi((u) => ({ ...u, speed }));
    };

    // Horizon-Stabilized Sim Camera State
    /** The player car drawn at the frame time (its physics pose carried forward by the unstepped remainder) */
    const renderCarPos = new THREE.Vector3();
    /** The player car's tyres on its ground, at the pose it is drawn at (refreshed in place every frame) */
    const playerWheels: WheelSeating = { ground: null, position: renderCarPos, quaternion: new THREE.Quaternion() };
    // Cockpit extras, created once the VF26 model has loaded: the wheel's LCD and the live wing mirrors
    let wheelDisplay: SteeringWheelDisplay | null = null;
    let wingMirrors: WingMirrors | null = null;
    /** The VF26 body the wheel display and mirrors above were built for */
    let vf26ExtrasFor: THREE.Object3D | null = null;
    // The AMG GT3's MoTeC dash and rear-view mirror, once its cockpit model has loaded
    let gt3Dash: Gt3DashDisplay | null = null;
    // A ported body's wheel screen and shift lights (the 496R's), once its GLB has loaded under the rig
    let portedDash: PortedWheelDash | null = null;
    let portedProbeFrame = 0;
    let cockpitProbeFrame = 0;
    const lapDelta = new LapDeltaTracker(track.totalLengthM);
    // Race control: judges every excursion past the track limits (see TrackLimitsMonitor); resetRun and setRace start
    // its session over
    const trackLimits = new TrackLimitsMonitor();
    /** The wheel went while it could not pause the game (menus, loading): it pauses once the car is driven again */
    let wheelLostPending = false;
    const displayExtra: { deltaMs: number | null } = { deltaMs: null };
    // The view camera: every view's placement, the menus' orbit and the driver's neck; told to start over when the
    // run does and when the replay moves the drawn car
    const cameraRig = new CameraRig(camera, track);
    let frameIndex = 0;
    const deviceInput = new DeviceInputReader();
    /** Per-axle tyre slip read from the car's telemetry each frame, for the keyboard pedal help */
    const kbAxleSlip = createAxleSlipSample();
    // The other cars, heard where they are from the active camera
    const opponentAudio = new OpponentAudio();
    const opponentSound = (p: InterpolatedPeerState): CarSoundSource => carForVehicle(p.vehicle ?? "vf26").sound;
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
    const radarRel = new THREE.Vector3();
    const radarFwd = new THREE.Vector3();
    const ghostQuat = new THREE.Quaternion();
    const ghostVel = new THREE.Vector3();

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
      if (process.env.NODE_ENV !== "production" && lastTimeMs > 0 && nowMs - lastTimeMs > 120 && appPhaseNow !== "loading") {
        console.info(`[load] long frame: ${(nowMs - lastTimeMs).toFixed(0)} ms (${appPhaseNow})`);
      }
      // A hitch (GC, shader compile, a slow commit) is caught up in full, up to a quarter second, so the car never
      // drops into slow motion; a longer stall (hidden tab, debugger) is not
      const dtSeconds = Math.min((nowMs - lastTimeMs) / 1000, MAX_FRAME_CATCH_UP_S);
      lastTimeMs = nowMs;
      if (appPhaseNow === "driving") startupMonitor?.frame(nowMs);

      // Optional Gamepad / Sim Racing Wheel Polling. Controllers with the standard mapping (Xbox,
      // DualShock, DualSense …) send the raw thumbstick through the physics' gamepad steering
      // assist every frame (also when centred: it self-aligns); other devices (wheels) drive the
      // rack directly.
      // Read every frame (also in menus / paused) so button edges never fire on a stale press
      const pads = connectedPads();
      const device = deviceInput.read(pads, settings, dtSeconds, vehicleNow);
      const appPhase = appPhaseNow;
      const inMenu = appPhase !== "driving";
      const rp = replay;
      if (rp.active && inMenu) exitReplay();
      const replaying = rp.active;
      const settingsNow = settings;
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
        if (!this.snapshot.paused) this.togglePause();
        setPauseNotice("Steering wheel disconnected. Reconnect it, or resume to drive with what's left.");
      }
      const driving = !inMenu && !this.snapshot.paused && !replaying && !device.wheelLost;
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
            if (!this.snapshot.paused) this.togglePause();
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
      const keys = heldKeys;
      const kb = kbInput;
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
      const kbBrakeScale = kbPedalAssist.brakeScale(
        keys.down,
        kb.brake,
        tyreSlip.totalNdSlip,
        dtSeconds,
        driving && kbTuning.brakeAssist && carAids?.absLevel === 0,
        kbTuning.pedalAssistStrength
      );
      const kbThrottleScale = kbPedalAssist.throttleScale(
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
      const directSteer = settings.mouseSteer
        ? mouseSteerValue
        : touchSteering
          ? touch.steer
          : gamepadSteer;

      const inputs: ControlInputs = {
        throttle: Math.max(kb.throttle * kbThrottleScale, gamepadThrottle, touch?.throttle ?? 0),
        brake: Math.max(kb.brake * kbBrakeScale, gamepadBrake, touch?.brake ?? 0),
        steerLeft: 0,
        steerRight: 0,
        analogSteer: directSteer,
        // A bound steering wheel's rim turns the rack at the speed of the driver's hands; a mouse, the touch pad and
        // an unbound device keep the car's limit on how fast the rack turns
        steerRim: device.source === "wheel" && !settings.mouseSteer && !touchSteering,
        kbSteer: kbSteerDir,
        padSteer: directSteer === undefined ? gamepadStick : undefined,
        manualOverride:
          heldKeys.boostHold || this.snapshot.boostLatch || gamepadBoost,
        toggleXMode: heldKeys.toggleX,
        shiftUp: heldKeys.shiftUp,
        shiftDown: heldKeys.shiftDown,
      };
      heldKeys.toggleX = false;
      heldKeys.shiftUp = false;
      heldKeys.shiftDown = false;
      // The driver takes the car back from the autopilot with any device (the keys do it on key down): a pedal, the
      // stick, the touch steering pad. Not the wheel's rim, which its force feedback turns on its own.
      if (driving && physics.aiAutopilot) {
        const pedal = Math.max(gamepadThrottle, gamepadBrake, touch?.throttle ?? 0, touch?.brake ?? 0);
        const stick = Math.abs(gamepadStick ?? 0);
        const touchSteer = touchSteering && !settingsNow.touch.tiltSteer ? Math.abs(touch.steer) : 0;
        if (pedal > 0.15 || stick > 0.3 || touchSteer > 0.2) physics.aiAutopilot = false;
      }

      // The AI field holds the player on the grid until the lights go out, then runs its cars
      const aiField = aiFieldOf(raceNow());
      if (physics.steeringAssist.settings !== assistSettings) {
        physics.steeringAssist.settings = assistSettings;
      }
      const lockDeg = Math.round(physics.maxSteerAngleRad * (1800 / Math.PI)) / 10;
      if (lockDeg !== this.snapshot.steerLockDeg) setSteerLockDeg(lockDeg);
      // A multiplayer race runs on the host's clock: the grid is held until the shared lights-out, and until this
      // guest has measured that clock (lights off, no countdown)
      const mpRace = mpRaceOf(raceNow());
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
          const base = autopilotPace;
          if (base.car !== physics) autopilotPace = { car: physics, pace: physics.aiPaceScale };
          physics.aiPaceScale = autopilotPace.pace * (physics.aiAutopilot ? trackEnv.weatherPaceScale(physics) : 1);
        }
        startupMonitor?.begin();
        if (!aiField?.playerFrozen && !mpFrozen) physics.step(dtSeconds, inputs);
        aiField?.update(dtSeconds);
        startupMonitor?.end("sim");
      }
      // The worker drives the car in practice; an AI or online race steps it here, with the field around it
      if (simHost) {
        const was = simHost.remote;
        // Not with a steering wheel yet: its force feedback is still sent from the page, a frame at a time
        simHost.endFrame(raceNow().kind === "practice" && settingsNow.device !== "wheel");
        if (simHost.remote !== was) console.info(simHost.remote ? "[sim] the worker drives the car" : "[sim] the page drives the car");
      }
      if (mpRace && mpFrame && mpFrame.phase === "racing" && !this.snapshot.paused) {
        mpRace.lapClock.update(physics.sMeters, mpFrame.raceTimeS, mpRace.start.laps, mpRace.flagOut);
      }
      haptics.update(physics.telemetry, dtSeconds, rumbleEnabled && driving, {
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
        vehicleNow
      );
      physics.telemetry.race = mpRace && mpFrame ? mpRace.status(mpFrame, physics.vxMs) : aiField?.status();
      physics.telemetry.runId = runId;

      // Track limits: race control judges each excursion once the car is back on the asphalt. Practice deletes
      // the lap; a race gives warnings, and every third one is a time penalty served at the flag.
      {
        const t = physics.telemetry;
        const raceNow = t.race;
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
        if (done) for (const listener of lapListeners) listener(done.summary, done.recording);
      }

      // Telemetry out (UDP via the bridge) for dashboards and motion rigs
      if (settingsNow.wheel.telemetryOut && nowMs - lastTelemetryOutMs >= 1000 / TELEMETRY_OUT_HZ) {
        lastTelemetryOutMs = nowMs;
        wheelFfb.sendTelemetry(
          settingsNow.wheel.telemetryPort,
          buildTelemetryPacket(physics.telemetry, {
            car: vehicleNow,
            track: trackId,
            maxRpm: vehicleModelSpec(vehicleNow).telemetryMaxRpm,
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
          vehicle: vehicleNow,
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
      const ghost = ghostPlayer;
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
        if (rp.playing && !this.snapshot.paused) {
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
      if (settings.mouseSteer && physics.steeringAssist.source === "keyboard") {
        mouseSteerValue = physics.steerAngleNorm;
      }

      // The latched boost lets go once the battery is empty (where the cars stop deploying it)
      if (this.snapshot.boostLatch && physics.ersEnergyJ <= 0) setLatch(false);

      // The menus film the car from outside, whatever the player's camera is
      const inVr = renderer.xr.isPresenting;
      const mode: CameraMode = inMenu ? "chase" : inVr ? "cockpit" : (settings.camera ?? "chase");
      const view = CAMERA_MODES[mode];
      const vf26Cams = carRig.getCameraAnchors();
      const carFovDeg = vf26Cams ? vf26Cams.cockpit.fovDeg : FALLBACK_COCKPIT_FOV_DEG;
      if (carFovDeg !== this.snapshot.carCockpitFovDeg) setCarCockpitFov(carFovDeg);
      const onboardFovShift = settings.cockpitFovDeg === null ? 0 : settings.cockpitFovDeg - carFovDeg;
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
      if (!vf26Body && !portedDash && carById(carRigCar).modelUrl && portedProbeFrame++ % 30 === 0) {
        portedDash = PortedWheelDash.from(carRig.chassisGroup, revRangeFor(carById(carRigCar).physics));
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
      if (view.wheelInShot && (wheelDisplay || gt3Dash || portedDash?.found)) {
        const delta = lapDelta.delta(physics.telemetry);
        const deltaMs = delta === null ? null : delta * 1000;
        if (wheelDisplay) {
          displayExtra.deltaMs = deltaMs;
          wheelDisplay.update(physics.telemetry, nowMs, displayExtra);
        }
        gt3Dash?.update(physics.telemetry, nowMs, { deltaMs });
        if (portedDash?.found) portedDash.update(physics.telemetry, nowMs, { deltaMs });
      }

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

      cameraRig.update({
        dt: dtSeconds,
        nowMs,
        mode,
        car: physics,
        carPos: renderCarPos,
        carVelocity: carVelocityWorld,
        anchor: vf26Cams && view.anchor ? vf26Cams[view.anchor] : null,
        chassis: carRig.chassisGroup,
        onboardFovShift,
        headMovement: settingsNow.hud.headMovement,
        driving,
        inVr,
        menu: inMenu
          ? { close: appPhase === "wizard" && wizardStep === "car", width: container.clientWidth, height: container.clientHeight }
          : null,
      });

      builtCircuit.updateEnvironment(nowMs * 0.001);
      builtCircuit.setGrooveRubber(getTrackEnv().trackEvolution.meanRacingLineRubber());
      opponentAudio.update({
        context: audio?.context ?? null,
        output: audio?.output ?? null,
        active: driving,
        camera,
        cameraMode: mode,
        peers: renderPeers,
        soundFor: opponentSound,
        dt: dtSeconds,
      });
      audio?.setCameraMode(mode);
      audio?.setPaused(!driving);
      if (driving) {
        audio?.update(physics.telemetry, dtSeconds);
        // Cues: DRS enabled (two-tone), flap open (chime; VF26: X-mode), shift point (150 rpm short of the limiter)
        const tc = physics.telemetry;
        const cues = settingsNow.hud;
        const drsAvail = Boolean(
          tc.f12026 ? tc.f12026.drsAvailable : track.getSampleAtDistance(physics.sMeters).drsZone
        );
        const drsOpen = tc.f12026 ? tc.f12026.CHANGED_DRS_OPEN : tc.activeAeroMode === "X_MODE";
        if (cues.drsBeep && !tc.aiAutopilot) {
          if (drsAvail && !cueDrsAvail) audio?.cue("drs_available");
          if (drsOpen && !cueDrsOpen) audio?.cue("drs_open");
        }
        cueDrsAvail = drsAvail;
        cueDrsOpen = drsOpen;
        const limiter = vehicleModelSpec(vehicleNow).limiterRpm;
        if (tc.gear !== cueGear || tc.rpm < limiter - 600) {
          cueGear = tc.gear;
          cueShiftArmed = true;
        }
        if (cues.shiftBeep && cueShiftArmed && tc.gear > 0 && tc.rpm >= limiter - 150) {
          audio?.cue("shift");
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
      if (nowMs - lastHudSyncMs > (this.snapshot.paused ? 250 : 33)) {
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

    this.teardown = () => {
      disposed = true;
      unsubscribeAssets();
      window.clearInterval(assetWatchdog);
      renderer.setAnimationLoop(null);
      void renderer.xr.getSession()?.end();
      haptics.stop();
      opponentAudio.dispose();
      wheelFfb.dispose();
      simHost?.dispose();
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
      portedDash?.dispose();
      unsubscribeCarSkins();
      postFx.dispose();
      reflectionProbe.dispose();
      env.dispose();
      rainFx.dispose();
      virtualMirror.dispose();
      floorSparks.dispose();
      renderer.dispose();
      audio?.dispose();
    };
  }

  private publish(patch: Partial<DriveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** The race on track with the player */
  get race(): SessionRace {
    return this.currentRace;
  }

  /** Stops the frame loop and frees the renderer, the scene and the listeners */
  dispose(): void {
    this.teardown();
  }
}
