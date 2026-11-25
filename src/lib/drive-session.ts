import { setDriverBodyShown } from "@/lib/render/driver-figure";
import * as THREE from "three";
import { text as tx } from "@/lib/text";
import { perLanguage } from "@/lib/per-language";
import { TURN_METADATA, getActiveTrackMetadata, inDeadZone, resolveLivery, type BuiltTrackData } from "@/lib/track-data";
import { AUTOPILOT_REF_BASE, LINE_CHECK_REF_BASE, QualifyingSession } from "@/lib/sim/qualifying";
import { F1Physics2026, type ControlInputs } from "@/lib/f1-physics-2026";
import { trackColliders } from "@/lib/sim/track-colliders";
import type { SimulatorCar } from "@/lib/sim/simulator-car";
import type { WheelSeating } from "@/lib/render/corner-rig";
import { F1AudioEngine2026 } from "@/lib/f1-audio-2026";
import { createF1Car2026, type PortedSkin, type SimCarRig } from "@/lib/car-builder-2026";
import { createGt3CarRig, gt3RigCameraAnchors } from "@/lib/gt3-car-model";
import { disposeTree } from "@/lib/render/dispose-tree";
import { setKtx2Renderer } from "@/lib/render/ktx2";
import { Gt3DashDisplay, gt3MirrorPatches } from "@/lib/render/gt3-dash-display";
import { createPortedCarRig } from "@/lib/ported-car-model";
import { defaultGtTyreBrand, resolveGtTyreBrand } from "@/lib/render/gt-tyre-sidewall";
import { staticFloorOf } from "@/lib/render/body-floor";
import { FloorSparks } from "@/lib/render/floor-sparks";
import {
  CarHeadlights,
  canSessionGetDark,
  carHasHeadlights,
  headlightSpotCountFor,
  resolveHeadlightStates,
  shouldHeadlightsBeOn,
  type HeadlightBeam,
  type HeadlightMode,
} from "@/lib/render/car-headlights";
import { vehicleModelSpec } from "@/lib/cars/vehicle-models";
import type { CarSoundSource } from "@/lib/sim/CarAudio";
import { OpponentAudio } from "@/lib/sim/opponent-audio";
import { carById, carForVehicle, carOvertakingRules, portedSkinFor, type CarId } from "@/lib/cars/car-registry";
import { carSkinFor, subscribeCarSkins } from "@/lib/cars/car-skins";
import { trackGeometryKey } from "@/lib/sim/ghost-align";
import type { GuardBody } from "@/lib/sim/contact-guard";
import { carPhysics } from "@/lib/cars/f1-mod-physics";
import { buildCircuitScene } from "@/lib/scene-builder";
import {
  applyGraphicsQuality,
  configureRenderer,
  createGoldenHourEnvironment,
  createPostFx,
  nightShareOf,
} from "@/lib/render/golden-hour-environment";
import { createVenueNightLighting, type VenueNightLighting } from "@/lib/render/venue-night-lighting";
import { applyCircuitNightLights, circuitNightSpec } from "@/lib/render/circuit-night-lights";
import { FlashTimer, HeadlightButton } from "@/lib/input/headlight-button";
import { lightCarByLamps, prepareCarForLamps } from "@/lib/render/car-lamp-light";
import { createOpponentBeams, MAX_BEAMS, type OpponentBeams } from "@/lib/render/opponent-beams";
import { sameConditions, type SessionConditions } from "@/lib/sim/weather";
import { SteeringWheelDisplay } from "@/lib/render/steering-display";
import { PortedWheelDash } from "@/lib/render/ported-wheel-dash";
import { revRangeFor, SHIFT_BEEP_BELOW_LIMITER_RPM } from "@/lib/sim/rev-range";
import { WingMirrors } from "@/lib/render/wing-mirrors";
import { VirtualMirror } from "@/lib/render/virtual-mirror";
import { MirrorClock } from "@/lib/render/mirror-clock";
import { type ChassisSetup, DEFAULT_CHASSIS_SETUP, loadChassisSetup } from "@/lib/sim/car-setup";
import { clampChassisToCarSheet } from "@/lib/sim/setup-sheet";
import { buildSharedSetup, garageTunerFrom } from "@/lib/sim/setup-share";
import { CameraRig, type CameraRigCar } from "@/lib/render/camera-rig";
import { LapDeltaTracker } from "@/lib/sim/lap-delta";
import { LEGACY_TRACK_LIMITS, TrackLimitsMonitor, type TrackLimitsRules } from "@/lib/sim/track-limits";
import { stretchTimeS } from "@/lib/sim/course-limits";
import { SimVisualFxManager } from "@/lib/sim/visual-fx";
import { AiOpponentField, aiDriversFor, resolvePlayerVsRemoteCar } from "@/lib/sim/ai-opponents";
import { resolveRaceRules } from "@/lib/sim/race-rules";
import { rulesForSetup, startAiRace, type RaceSetup } from "@/lib/sim/race-setup";
import { JumpStartWatch, ReactionWatch } from "@/lib/sim/race-start";
import { peerWakeEmitters, TrackEnvironment } from "@/lib/sim/track-environment";
import type { WakeEmitterCar } from "@/lib/sim/aero-wake";
import { GamepadHaptics } from "@/lib/sim/gamepad-haptics";
import { DualSenseDriver } from "@/lib/input/dualsense-driver";
import { dualSenseHid } from "@/lib/input/webhid-dualsense";
import { getMultiplayerManager, type InterpolatedPeerState, type P2PConnectionStatus } from "@/lib/sim/multiplayer-sync";
import { flagMultiplayerRace } from "@/lib/sim/mp-flags"; // polish:D
import { MultiplayerRace, placePeersWhereDrawn, type MultiplayerRaceFrame } from "@/lib/sim/race-session";
import { CarDamage } from "@/lib/sim/car-damage";
import { damageStatusOf, PlayerDamageFeed, PLAYER_HALF_LENGTH_M, PLAYER_HALF_WIDTH_M } from "@/lib/sim/player-damage";
import { CoolDown } from "@/lib/sim/cool-down";
import { PodiumDirector } from "@/lib/render/podium-shot";
import { NameplateBadgeCache, OverheadNameplateProjector, type OverheadNameplatesSink } from "@/lib/render/overhead-nameplates";
import type { BadgeContext } from "@/lib/net/awards";
import { isVehicleModelId } from "@/types/f1";
import { GhostPlayer, LapRecorder } from "@/lib/sim/lap-recorder";
import { canFlashback, isInOnlineRoom, poseFromReplayCar, ReplayBuffer, type ReplayLapMarker } from "@/lib/sim/replay-buffer";
import { GHOST_CAR_COLOR, steerAngleOf, steerNormOf, wheelRpmAtSpeed, wheelRpmOf } from "@/lib/sim/car-pose";
import { drivingInputOf, lapConditionsNow, type LapInput, type LapRecording, type LapSummaryData, type ReplayCarState } from "@/lib/sim/lap-types";
import { MIN_QUALIFYING_LAP_MS } from "@/lib/net/wire";
import { buildTelemetryPacket } from "@/lib/input/telemetry-out";
import { isTouchDevice, touchInput } from "@/lib/input/touch-input";
import { ScreenWakeLock } from "@/lib/screen-wake-lock";
import { createRainFx, RAIN_VISOR_LAYER } from "@/lib/render/rain-fx";
import { DETAIL_LAYER, DRIVER_HEAD_LAYER, OVERLAY_LAYER } from "@/lib/render/layers";
import { KeyboardPedalAssist } from "@/lib/input/keyboard-pedals";
import { HELD_KEYS, heldActionsOf, isHeldKeyAction, PhysicalKeys, type HeldKeyAction } from "@/lib/input/held-keys";
import { shapeStick } from "@/lib/input/stick-shape";
import { combineStickAndGyro, gyroSteerValue } from "@/lib/input/gyro-steer";
import { gyroSource } from "@/lib/input/gyro-source";
import { advanceAsphaltRain, setAsphaltWetness } from "@/lib/render/asphalt-sheen";
import {
  isRainCompound,
  recommendedCompound,
  wetnessFromWater,
} from "@/lib/sim/wet-tyres";
import type { WeatherHudState } from "@/components/hud/WeatherBadge";
import { CAMERA_MODES, FALLBACK_COCKPIT_FOV_DEG } from "@/lib/render/camera-modes";
import type { FreeCameraInput } from "@/lib/render/free-camera";
import { createGroundHit } from "@/lib/sim/f12026-car/TrackColliderQuery";
import { OnboardViews } from "@/lib/render/onboard-views";
import { isNudgeView, NUDGE_FOV_STEP_DEG, nudgeStepForKey, stepNudge } from "@/lib/settings/camera-nudges";
import { loadTyreSetup } from "@/lib/sim/tyre-setup";
import { assetProgress } from "@/lib/loading/asset-progress";
import { prefetchSoundBank } from "@/lib/sim/lc26-audio";
import { CarReflectionProbe } from "@/lib/render/car-reflection-probe";
import { StartupMonitor } from "@/lib/render/startup-monitor";
import { browserStore, classifyRenderer, noteRenderer, readLossMemory, recordContextLoss, rendererName, safeStartPlan } from "@/lib/render/gpu-health";
import { gpuFinished, partsByNewKeys, slicesByBytes, textureBytes } from "@/lib/render/gpu-pace";
import { SessionPerfMonitor, type PerfPhase } from "@/lib/render/session-perf";
import { FramePacer } from "@/lib/render/frame-pacer";
import {
  carriedLevel,
  DisplayRate,
  frameBudgetMs,
  ladderFor,
  loweredSummary,
  planAt,
  presetPlan,
  QualityGovernor,
  rememberLevel,
  type GovernorEvent,
  type PlanOptions,
} from "@/lib/render/adaptive-quality";
import { pageBuild } from "@/lib/build-id";
import { addContactShadow, seatContactShadow } from "@/lib/render/contact-shadow";
import {
  buildKeyLookup,
  HUD_TOGGLE_EVENT,
  keyLabel,
  PAD_BRAKE_BUTTON,
  PAD_THROTTLE_BUTTON,
  pedalsOnTriggers,
  resolveActiveClutchBinding,
  type KeyAction,
} from "@/lib/input/bindings";
import { carWheelLockDeg, connectedPads, DeviceInputReader, findPad, isLikelyWheel } from "@/lib/input/device-input";
import { MenuIdleWatch } from "@/lib/input/menu-idle";
import { AERIAL_IDLE_MS } from "@/lib/render/menu-aerial";
import { webHidFfb, wheelFfb } from "@/lib/input/wheel-ffb";
import { simMode } from "@/lib/sim/runtime/sim-mode";
import { createSimHost } from "@/lib/sim/runtime/sim-host";
import { WorkerAiField } from "@/lib/sim/runtime/worker-ai-field";
import type { AiRace, FieldCarRestorePose } from "@/lib/sim/ai-race";
import { startSimWorker } from "@/lib/sim/runtime/worker-sim-host";
import { steeringAssistSettings } from "@/lib/sim/steering-assist";
import { applyTimeTrial, lowestFuelSetup, timeTrialRealism, type TimeTrialRules } from "@/lib/sim/time-trial";
import { axleSlipFromTelemetry, createAxleSlipSample } from "@/lib/sim/tyre-slip";
import { clampFov, DEFAULT_KEYBOARD_TUNING, type PlayerSettings } from "@/lib/settings/player-settings";
import { sharedMusic, type NowPlaying } from "@/lib/audio/bgm-controller";
import { MusicDirector } from "@/lib/audio/music-director";
import { noteDrivingFrame, noteDrivingInput, noteFrameGraphics } from "@/lib/render/frame-stats";
import type {
  AeroSetupPreset,
  CameraMode,
  CarTelemetry,
  LiveTunerPatch,
  RadarBlip,
  StartClutchControl,
  TireCompound,
  TyreSetup,
  VehicleModelId,
} from "@/types/f1";

/** What the start cue names as the clutch when no clutch is bound: the controller's Gear up, a wheel's paddle */
const startClutchNames = perLanguage(() => ({ gearUp: tx("game.session.clutchGearUp"), paddle: tx("game.session.clutchPaddle") }));

/** Matches the aero package the track's target speeds / braking markers are computed for */
export const DEFAULT_AERO_PRESET: AeroSetupPreset = "balanced";
/** Longest frame (s) simulated in full; must not exceed the physics' own F1Physics2026.MAX_CATCH_UP_S */
const MAX_FRAME_CATCH_UP_S = F1Physics2026.MAX_CATCH_UP_S;

// Keyboard-only input shaping: a key press becomes a pedal squeeze, not a step
/** A replay opens this far before the present, paused (s) */
const REPLAY_OPEN_BACK_S = 3;
const KB_THROTTLE_RISE_S = DEFAULT_KEYBOARD_TUNING.throttleRiseS;
const KB_THROTTLE_FALL_S = 0.1;
const KB_BRAKE_RISE_S = DEFAULT_KEYBOARD_TUNING.brakeRiseS;
const KB_BRAKE_FALL_S = 0.08;
/** A clutch key presses the pedal at once and lets it out over this long: a launch on it slips, it doesn't dump */
const KB_CLUTCH_IN_S = 0.08;
const KB_CLUTCH_OUT_S = 0.4;
/** Holding the camera key or button this long opens the seat panel; a shorter press changes the view */
const SEAT_PANEL_HOLD_MS = 450;

/**
 * Session flow: assets loading → "press any key" → title menu → (first-run / controls setup) → driving.
 * Physics only runs while driving; the menus show the car idling on the grid under an orbiting camera.
 */
export type AppPhase = "loading" | "title" | "wizard" | "driving";

/** The race on track with the player: none (practice), the AI field, or a multiplayer race; never two at once */
export type SessionRace =
  | { kind: "practice" }
  /** `rules`: sporting rules fixed for this race (the weekly challenge's), over the player's race setup */
  | { kind: "ai"; field: AiRace; rules?: Pick<RaceSetup, "rulePreset" | "trackLimits"> }
  | { kind: "mp"; race: MultiplayerRace };
/** The AI field on track, when the session is a race against it */
export const aiFieldOf = (race: SessionRace): AiRace | null => (race.kind === "ai" ? race.field : null);
/** The multiplayer race on track, when the session is an online race */
export const mpRaceOf = (race: SessionRace): MultiplayerRace | null => (race.kind === "mp" ? race.race : null);
/** Why the run on track starts over (see resetRun) */
export type RunResetReason = "session" | "restart" | "teleport" | "car" | "race";
/** The VR headset: off, being asked for a session, or presenting */
export type VrState = "off" | "requesting" | "on";

/** Held keys that take the car back from the autopilot (holding boost does not) */
const DRIVER_KEYS: ReadonlySet<HeldKeyAction> = new Set(["throttle", "brake", "steerLeft", "steerRight", "throttleHalf", "brakeHalf"]);

/** One-shot driving actions: the same whether they come from a key, a pad button or a touch pad */
export type DriveAction = Exclude<KeyAction, HeldKeyAction> | "mfd" | "hud";

/** How long a car put out by damage in practice stays put before it starts a flying lap, repaired (s of driving) */
const PRACTICE_WRECK_HOLD_S = 1.5;

/** Telemetry-out rate (Hz) */
const TELEMETRY_OUT_HZ = 60;

/** A multiplayer race while this guest has not yet measured the host's clock: the grid is held, the lights off */
const MP_CLOCK_UNSYNCED_FRAME: MultiplayerRaceFrame = { phase: "countdown", lightsOn: 0, countdownS: 0, raceTimeS: 0 };

/** A loading task with no progress for this long is given up on (the procedural stand-in stays) */
const ASSET_STALL_MS = 25_000;
/**
 * The loading warm-up's texture uploads go to the GPU in runs of about this many bytes, each finished before the next:
 * a few runs for a circuit on a fast GPU, smaller ones on a gentle start
 */
const WARMUP_UPLOAD_BYTES = 96 * 1024 * 1024;
const WARMUP_UPLOAD_BYTES_GENTLE = 24 * 1024 * 1024;
/** A context loss heard of this soon after the page came back into view counts as one in the background (ms) */
const BACKGROUND_LOSS_GRACE_MS = 5000;
/** On a gentle start the warm-up frame is drawn in parts first, each with this many materials' first draws at most */
const WARMUP_GENTLE_NEW_MATERIALS = 3;

/** The HUD says the graphics were lowered at most this often (ms); later steps in the meantime go by quietly */
const QUALITY_NOTICE_GAP_MS = 60_000;

/** Slicks or rain tyres for the line's water; a car on slicks keeps its own slick */
export const autoCompoundFor = (lineWaterMm: number, current: TireCompound | undefined): TireCompound =>
  recommendedCompound(lineWaterMm, current && !isRainCompound(current) ? current : "soft");

const approach = (value: number, target: number, maxStep: number) =>
  value + Math.max(-maxStep, Math.min(maxStep, target - value));

/** The sound bank each car plays (the F1 cars share one bank) */
const soundFor = (car: CarId): CarSoundSource => carById(car).sound;
/**
 * Runs `fn` when the browser is idle (Safari has no requestIdleCallback: a timer instead, `fallbackDelayMs` from now,
 * a frame by default)
 */
const scheduleIdle = (fn: (deadline?: IdleDeadline) => void, fallbackDelayMs = 16) => {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(fn, { timeout: 500 });
  else window.setTimeout(() => fn(), fallbackDelayMs);
};
/** Safari's wait between the spare AI field's build steps (a few frames for the menus between two AI cars) */
const AI_PREP_GAP_MS = 150;

/** Rare structural telemetry fields read outside the live HUD (root simulator, TitleMenu, race history) */
function telemetryStructKeyOf(t: CarTelemetry): string {
  const r = t.race;
  const results = r?.results;
  const me = results?.find((row) => row.isPlayer);
  const resKey =
    me && results
      ? `${r?.resultsFinal ? 1 : 0}:${results.length}:${me.position}:${me.finishTimeS ?? ""}:${me.dnf ? 1 : 0}:${me.gridPosition ?? ""}:${me.bestLapMs ?? ""}:${me.penaltyS ?? ""}`
      : "";
  return `${t.runId ?? ""}|${r?.phase ?? ""}|${r?.multiplayer ? 1 : 0}|${t.liveTuner?.absAllowed === false ? 0 : 1}|${resKey}`;
}

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
  /** The seat panel is open (hold the camera button): the car waits while the player moves the onboard view */
  seatPanel: boolean;
  /** The manual-override boost is latched on */
  boostLatch: boolean;
  /** The car's setup as the garage shows it */
  tireCompound: TireCompound;
  tyreSetup: TyreSetup;
  /** The car's own tyre setup, before the player's saved one */
  defaultTyreSetup: TyreSetup;
  chassisSetup: ChassisSetup;
  /** The time trial being driven (the weekly challenge's fixed conditions), or none */
  timeTrial: TimeTrialRules | null;
  /**
   * What the automatic quality has lowered on top of the player's graphics ("resolution 70%, car reflections off"),
   * or null with nothing lowered
   */
  autoQualityLowered: string | null;
  /**
   * The HUD's quiet note about it, a new `id` each time: "lowered" after a step down (at most one a minute), "floor"
   * once when every step is taken and the frames are still slow
   */
  qualityNotice: { id: number; kind: "lowered" | "floor" } | null;
  /**
   * The browser took the WebGL context away (a GPU reset, a driver crash, or a phone reclaiming a background tab): the
   * drive is frozen and draws nothing until the component remounts it. `hidden`: it went while the page was hidden
   */
  gpuLost: GpuLoss | null;
  /** The music track playing, as last announced (the toast shows each new one, the pause menu names it) */
  nowPlaying: NowPlaying | null;
  /** Transient camera override (e.g. "free" fly camera) that does not overwrite the player's saved default camera */
  cameraOverride: CameraMode | null;
  /** True once at least 1 s of driving has been recorded in the replay buffer */
  replayAvailable: boolean;
}

/** A lost WebGL context: whether the page was hidden at the time, and where the player was */
export interface GpuLoss {
  hidden: boolean;
  phase: AppPhase;
}

/** The snapshot before the drive exists: a throwaway LC26's numbers, as the menus need something to show */
export function idleDriveSnapshot(track: BuiltTrackData): DriveSnapshot {
  const car = new F1Physics2026(track);
  return {
    telemetry: { ...car.telemetry },
    replay: { active: false, timeS: 0, startS: 0, endS: 0, playing: true, speed: 1, canFlashback: false, focusedCarId: "player", cars: [], lapMarkers: [] },
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
      get statusText() {
        return tx("game.connection.ready");
      },
    },
    vr: "off",
    muted: false,
    paused: false,
    pauseNotice: null,
    seatPanel: false,
    boostLatch: false,
    tireCompound: "soft",
    tyreSetup: car.getTyreSetup(),
    defaultTyreSetup: car.getTyreSetup(),
    chassisSetup: DEFAULT_CHASSIS_SETUP,
    timeTrial: null,
    autoQualityLowered: null,
    qualityNotice: null,
    gpuLost: null,
    nowPlaying: null,
    cameraOverride: null,
    replayAvailable: false,
  };
}

/** The browser gave no WebGL context: switched off, unsupported, or refused for the page after a GPU reset */
export class WebGLUnavailableError extends Error {
  constructor(reason: unknown) {
    super(`WebGL is not available: ${reason instanceof Error ? reason.message : String(reason)}`);
    this.name = "WebGLUnavailableError";
  }
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
  /** The Overtake key pressed since the last frame */
  overtake: boolean;
  shiftUp: boolean;
  shiftDown: boolean;
  toggleX: boolean;
  half: boolean;
  /** The Half brake key */
  halfBrake: boolean;
  clutch: boolean;
  neutral: boolean;
  /** The Gear up key is down (it is one-shot, but a manual start holds it as the clutch) */
  gearUpHeld: boolean;
  /** The flash key: the high beam while it is held */
  headlightFlash: boolean;
}

/** A car the replay camera can focus on */
export interface ReplayCarOption {
  id: string;
  label: string;
  color: string;
  isPlayer: boolean;
}

/** The instant replay: the recording, and where it is shown from while open */
export interface ReplayState {
  buffer: ReplayBuffer;
  active: boolean;
  playing: boolean;
  timeS: number;
  prevTimeS: number;
  speed: number;
  focusedCarId: string;
  wheelRotRad: number;
  cars: ReplayCarOption[];
  lapMarkers: ReplayLapMarker[];
}

/** The replay bar's view of the replay */
export interface ReplayUi {
  active: boolean;
  timeS: number;
  startS: number;
  endS: number;
  playing: boolean;
  speed: number;
  /** True only in solo Practice and active regular AI races (never online rooms, Weekly Challenge, or Qualifying) */
  canFlashback: boolean;
  /** Which car the replay camera is currently following ("player" or an AI/peer ID) */
  focusedCarId: string;
  /** Cars recorded in this replay, ordered with player first */
  cars: readonly ReplayCarOption[];
  /** Lap transition timestamps for timeline markers */
  lapMarkers: readonly ReplayLapMarker[];
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
  /**
   * The player's saved settings at the start. The renderer, the sky and the warm-up are built for their graphics
   * preset: started on the defaults (High on a desktop) the physical sky's GPU precompute ran even on Low (issue #123)
   */
  settings: PlayerSettings;
  /** Optional ref to the DOM-pooled overhead nameplate overlay, updated directly in the render loop */
  nameplatesRef?: { readonly current: OverheadNameplatesSink | null };
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
  /** High-frequency driving telemetry channel so the HUD updates without re-rendering the root simulator component */
  private telemetrySnapshot: CarTelemetry;
  private telemetryStructKey = "";
  private readonly telemetryListeners = new Set<() => void>();
  readonly subscribeTelemetry = (listener: () => void): (() => void) => {
    this.telemetryListeners.add(listener);
    return () => this.telemetryListeners.delete(listener);
  };
  readonly getTelemetry = (): CarTelemetry => this.telemetrySnapshot;
  /** The race on track with the player: practice, the AI field or an online race (setRace is its only writer) */
  private currentRace: SessionRace = { kind: "practice" };
  /**
   * The run starts over: a new session, a restart or reset, a corner jump, a car change, AI opponents on or off. It
   * never moves the car: the caller places it afterwards, so leaving the replay (which puts the drawn car back where
   * the replay found it) comes first and can't undo the move.
   */
  readonly resetRun: (reason: RunResetReason) => void;
  /** Puts a race on track with the player (or none): the AI field and a multiplayer race never run together */
  readonly setRace: (next: SessionRace) => void;
  /** The autopilot takes or hands back the player's car; never in a multiplayer race */
  readonly toggleAutopilot: () => void;
  /** The player's car: the LC26 (F1Physics2026) or the f12026-car (F12026CarSim); a car swap replaces it */
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
  /** Opens the seat panel over the driver's view (a cockpit or dash view), the car waiting meanwhile */
  readonly openSeatPanel: () => void;
  readonly closeSeatPanel: () => void;
  readonly setBoostLatch: (on: boolean) => void;
  /** A one-shot driving action, as from a key, a pad button or a touch pad */
  readonly runAction: (action: DriveAction) => void;
  /** Creates and starts the car audio on a user gesture (the browser keeps audio locked until one) */
  readonly unlockAudio: () => void;
  readonly toggleMute: () => void;
  /** The next track of the music playing (the music key, the pause menu's Skip track) */
  readonly nextTrack: () => void;
  /** Builds the next race's AI field while the browser is idle in the menus (never while driving or loading) */
  readonly prepareAiField: () => void;
  /**
   * The AI field for a race: in the simulation worker when it can run one, else on the page (the one built ahead when
   * it was built for this car, or a new one)
   */
  readonly takeAiField: () => AiRace;
  /**
   * Qualifying for an AI race (qualifying.ts): the player drives alone, on a flying lap, for `minutes`; then the field
   * lines up from it and the race starts. Anything else that sets the session (another race, practice, a car change)
   * ends it
   */
  readonly startQualifying: (field: AiRace, minutes: number) => void;
  /** The player's preferences: kept for the frame loop, and the ones that act on the car or the scene applied */
  readonly applySettings: (settings: PlayerSettings) => void;
  /** Puts the tyre compound on the car and its model */
  readonly setTireCompound: (compound: TireCompound) => void;
  /** The garage's tyre and chassis setup, and the live tuner, on the car */
  readonly setTyreSetup: (setup: TyreSetup) => void;
  readonly setChassisSetup: (setup: ChassisSetup) => void;
  readonly setLiveTuner: (patch: LiveTunerPatch) => void;
  /**
   * The time trial's fixed conditions (tyre, lowest fuel, a road at full grip) on the car and the road from now and at
   * every flying restart, or none (null: the player's own back). A new race or session, or another car, ends it.
   */
  readonly setTimeTrial: (rules: TimeTrialRules | null) => void;
  /** Outside a race: the run starts over on a flying lap, under the time trial's conditions when one is driven */
  readonly restartFlyingLap: () => void;
  /** The replay bar's play / pause (from the start again once at the end), seek, speed, frame step, and car focus */
  readonly replayTogglePlay: () => void;
  readonly replaySeek: (timeS: number) => void;
  readonly replaySpeed: (speed: number) => void;
  readonly replayStepFrame: (dir: 1 | -1) => void;
  readonly replayFocusCar: (carId: string) => void;
  readonly replayCycleCar: (dir: 1 | -1) => void;
  /** Opens the replay (optionally from the start of the race, playing immediately) */
  readonly openReplay: (opts?: { fromStart?: boolean; play?: boolean }) => boolean;
  /** Swaps the player's car in the running scene (the run starts over with it) */
  readonly setCar: (car: CarId) => void;
  /** Applies the player's graphics to the running renderer, with what the automatic quality has lowered on top */
  readonly applyGraphics: () => void;
  /** The HUD's off-track edge glow, drawn in the last render pass in the HUD's loss colour (the palette's) */
  readonly setOffTrackGlow: (on: boolean) => void;
  /** `?perf=1`: the whole-session performance report as text, to copy or save; null without `?perf=1` */
  readonly perfReport: (() => string) | null;
  /**
   * The next drawn frame as a PNG, at most `maxWidth` pixels wide, for a bug report (the scene only: the HUD and the
   * menus are page elements on top of it). Null with no frame drawn within 1.5 s (a lost GPU context, a headset).
   */
  readonly captureFrame: (maxWidth?: number) => Promise<Blob | null>;
  /** Asks the headset for a VR session (one request at a time) */
  readonly enterVr: () => void;
  /** Opens the instant replay a moment back, paused, or closes it */
  readonly toggleReplay: () => void;
  /** Leaves the replay: the drawn car goes back to the live pose */
  readonly exitReplay: () => void;
  /** Resumes driving from the scrubbed replay timestamp (Practice & regular AI races only; invalidates current lap) */
  readonly flashbackReplay: () => boolean;
  /** Sets or clears a transient camera override (e.g. Free camera) without persisting to settings */
  readonly setCameraOverride: (mode: CameraMode | null) => void;
  /** Toggles Free camera on/off without altering the player's saved driving view */
  readonly toggleFreeCamera: () => void;
  /** Trackside TV in and out (its own key, out of the camera key's cycle), back to the driving view */
  readonly toggleTvCamera: () => void;
  /** Repositions Free camera near the currently focused car */
  readonly resetFreeCamera: () => void;
  /** polish:B the podium shot after a race, and the overlay's view of it */
  readonly podium: PodiumDirector;

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
      settings: initialSettings,
    } = host;

    let disposed = false;
    // High-frequency telemetry goes to HUD subscribers only; the top-level snapshot updates only on structural changes
    const setTelemetry = (telemetry: CarTelemetry) => this.publishTelemetry(telemetry);
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
    /**
     * A point-to-point course (a hill climb): how long the car has stood still past the finish, and a hold after
     * putting it back on the start line (the worker's car reports its new place a frame or two later)
     */
    const runEnd = { stoppedS: 0, holdS: 0 };
    // polish:B the cool-down lap after the player's flag: the autopilot has the car, the player's inputs are ignored
    const coolDown = new CoolDown();
    /** The boost latch, for the frame loop and the HUD at once */
    const setLatch = (boostLatch: boolean) => this.publish({ boostLatch });
    /** The latched boost has seen full throttle since it was latched: a lift from it lets the latch go */
    let latchSawFull = false;
    this.setBoostLatch = setLatch;

    /** The driving keys held down, and the one-shot presses waiting for the next frame */
    const heldKeys: DriveKeys = {
      up: false,
      down: false,
      left: false,
      right: false,
      boostHold: false,
      overtake: false,
      shiftUp: false,
      shiftDown: false,
      toggleX: false,
      half: false,
      halfBrake: false,
      clutch: false,
      neutral: false,
      gearUpHeld: false,
      headlightFlash: false,
    };
    /** Ramped keyboard pedals 0..1 (the steering keys are shaped by the car's steering assist) */
    const kbInput = { throttle: 0, brake: 0, clutch: 0, padClutch: 0 };
    /** A manual start: the clutch watched through the lights, and Gear up held as the clutch when none is bound */
    const jumpWatch = new JumpStartWatch();
    /** The reaction to the lights going out, for the HUD */
    const reactionWatch = new ReactionWatch();
    const startClutch = { active: false };
    let gridHeldLastFrame = false;
    /** Last device that actually sent driving/clutch input; lets an idle plugged-in pad coexist with keyboard clutch. */
    let lastDrivingInput: LapInput | null = null;
    let prevSettingsDevice = initialSettings.device;
    /** Keeps the screen awake via `navigator.wakeLock` while actively driving (for tilt steering & Android TWA). */
    const wakeLock = new ScreenWakeLock();
    /** How far the player held the clutch in on the last step (0..1), for the start cue */
    let startClutchIn = 0;
    /** Slip help on the keyboard's pedals while the car's ABS / traction control is off */
    const kbPedalAssist = new KeyboardPedalAssist();
    /** The mouse's steering, -1..1, while mouse steering is on */
    let mouseSteerValue = 0;
    /** Typed "/boost" so far */
    let slashCommandBuffer = "";
    /** Transient camera override (e.g. Free camera); never persisted to saved settings */
    let cameraOverride: CameraMode | null = null;
    const freeCamKeys = new Set<string>();
    let freeCamDrag: { id: number; x: number; y: number } | null = null;
    const freeCamInput: FreeCameraInput = { forward: 0, right: 0, up: 0, fast: false, slow: false, lookYawRate: 0, lookPitchRate: 0 };
    const freeCamGroundHit = createGroundHit();
    // ControlLeft/ControlRight intentionally omitted: Ctrl+W closes browser/Electron tabs and Ctrl+Arrows switches macOS desktops
    const FREE_CAM_MOVE_CODES = new Set([
      "KeyW", "KeyS", "KeyA", "KeyD",
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "KeyQ", "KeyE", "Space",
      "ShiftLeft", "ShiftRight", "AltLeft", "AltRight",
    ]);
    /** Lets go of every held driving key: on pause, and when the window loses focus (its keyups never arrive) */
    const releaseHeldKeys = () => {
      for (const flag of Object.values(HELD_KEYS)) heldKeys[flag] = false;
      heldKeys.gearUpHeld = false;
      kbInput.throttle = 0;
      kbInput.brake = 0;
      kbInput.clutch = 0;
      kbInput.padClutch = 0;
      kbPedalAssist.reset();
      freeCamKeys.clear();
      freeCamDrag = null;
    };
    /** The keys physically down, kept through the pause menu and the seat panel: the drive holds them again after */
    const physicalKeys = new PhysicalKeys();
    this.togglePause = () => {
      if (disposed) return;
      const paused = !this.snapshot.paused;
      this.publish(paused ? { paused } : { paused, pauseNotice: null });
      if (paused) {
        wheelFfb.stop();
        releaseHeldKeys();
      }
    };
    this.endPause = () => this.publish({ paused: false, pauseNotice: null, seatPanel: false });
    this.openSeatPanel = () => {
      if (disposed || this.snapshot.seatPanel || appPhaseNow !== "driving") return;
      if (cameraOverride !== null) {
        cameraOverride = null;
        this.publish({ cameraOverride: null });
      }
      // The seat moves the views from the driver's seat: from any other view the panel starts in the cockpit
      if (!isNudgeView(settings.camera)) setSettings((prev) => ({ ...prev, camera: "cockpit" }));
      this.publish({ seatPanel: true, paused: false });
      wheelFfb.stop();
      releaseHeldKeys();
    };
    this.closeSeatPanel = () => {
      if (disposed || !this.snapshot.seatPanel) return;
      this.publish({ seatPanel: false });
    };

    /** The car sounds: created by the first unlockAudio, then paused and resumed by the frame loop alone */
    let audio: F1AudioEngine2026 | null = null;
    /**
     * The music: one player for the page (it plays on across circuits, which each get a new session), told each frame
     * what to play (music-director.ts); this session shows what it announces
     */
    const music = sharedMusic();
    const musicDirector = new MusicDirector();
    const applyMusicSettings = (s: PlayerSettings) => {
      const a = s.audio;
      music.setLevels({
        volume: a.volume,
        muted: a.muted,
        musicMuted: a.musicMuted,
        menu: a.menuMusic,
        race: a.raceMusicOn ? a.raceMusic : 0,
        results: a.replayMusic,
      });
      music.setDisabled(new Set(a.musicOff));
    };
    const stopNowPlaying = music.subscribe((nowPlaying) => this.publish({ nowPlaying }));
    this.nextTrack = () => music.playNextInPool();
    this.unlockAudio = () => {
      if (disposed) return;
      // The music unlocks on the same press, apart from the car audio (which a browser can refuse on its own)
      try {
        music.unlock();
        applyMusicSettings(settings);
      } catch (err) {
        console.warn("Music could not start", err);
      }
      // Called inside the press that leaves the loading screen or starts a race: a browser that refuses Web Audio
      // leaves the game silent, never stuck on that press
      try {
        if (!audio) {
          audio = new F1AudioEngine2026();
          audio.setCar(soundFor(carIdNow));
          // Created paused unless the car is being driven; from then on the frame loop alone pauses and resumes it
          audio.setPaused(this.snapshot.paused || appPhaseNow !== "driving");
        }
        if (!audio.isInitialized) {
          audio.init();
          // Master volume and mute are saved settings (Settings > Audio)
          audio.setMuted(settings.audio.muted);
          audio.setVolume(settings.audio.volume);
          audio.setKerbVolume(settings.audio.kerbs);
        } else {
          audio.resume();
        }
      } catch (err) {
        console.warn("Audio could not start; driving without sound", err);
      }
    };
    // The Mute key flips the saved mute; applySettings passes it to the sound and the snapshot
    this.toggleMute = () => {
      this.unlockAudio();
      setSettings((prev) => ({ ...prev, audio: { ...prev.audio, muted: !prev.audio.muted } }));
    };
    /** The player's preferences (applySettings), and what the frame loop derives from them: the saved ones at first */
    let settings: PlayerSettings = initialSettings;
    let keyLookup = buildKeyLookup(settings.keys);
    let assistSettings = steeringAssistSettings(settings.padTuning, settings.keyboardTuning);
    let livery = resolveLivery(settings.liveryId, settings.customLivery);
    const raceNow = (): SessionRace => this.currentRace;
    /**
     * Bumped whenever the run on track starts over (see resetRun) and written into the telemetry every frame, so
     * anything holding lap- or run-scoped state (race control's track limits) starts over with it.
     */
    let runId = 0;
    /** The instant / full-race replay: compact typed-array buffer up to 20 min @ 20 Hz */
    const REPLAY_HZ = 20;
    const replay: ReplayState = {
      buffer: new ReplayBuffer({ maxSeconds: 1200, hz: REPLAY_HZ }),
      active: false,
      playing: true,
      timeS: 0,
      prevTimeS: 0,
      speed: 1,
      focusedCarId: "player",
      wheelRotRad: 0,
      cars: [],
      lapMarkers: [],
    };
    /** The time trial being driven, and the tyre the player had on before it */
    let timeTrial: TimeTrialRules | null = null;
    let ownCompound: TireCompound | null = null;
    /** The time trial applies to this car, outside a race */
    const timeTrialOn = () => timeTrial !== null && timeTrial.vehicle === vehicleNow && raceNow().kind === "practice";
    /** The time trial's tyre, fuel and road, before the car is placed */
    const putTimeTrialOn = () => {
      if (timeTrial && timeTrialOn()) applyTimeTrial(physics, timeTrial, this.snapshot.chassisSetup, getTrackEnv().trackEvolution, this.setTireCompound);
    };
    /** The player's own fuel and tyre back on the car, and the road free to evolve (from the next session's reset) */
    const endTimeTrial = () => {
      if (!timeTrial) return;
      timeTrial = null;
      getTrackEnv().trackEvolution.holdFullGrip(false);
      physics.applyChassisSetup?.(this.snapshot.chassisSetup);
      if (ownCompound && physics.tireCompound !== ownCompound) this.setTireCompound(ownCompound);
      ownCompound = null;
      this.publish({ timeTrial: null });
    };
    /**
     * The time trial burns no fuel: the car and the session realism it was last given that (the track environment
     * hands every car the session's realism again whenever that changes, so it is re-asserted after each update)
     */
    let fuelHeld: { car: SimulatorCar; flags: object } | null = null;
    /** The energy session last given the car (`setEnergySession`) */
    let energyHeld: { car: SimulatorCar | null; quali: boolean } = { car: null, quali: false };
    const holdTimeTrialFuel = () => {
      const flags = getTrackEnv().simRealism;
      if (!timeTrialOn() || !flags.fuelUse) {
        if (fuelHeld?.car === physics) physics.setSimRealism?.(flags);
        fuelHeld = null;
        return;
      }
      if (fuelHeld?.car === physics && fuelHeld.flags === flags) return;
      physics.setSimRealism?.(timeTrialRealism(flags));
      fuelHeld = { car: physics, flags };
    };
    /** Race control's session for a race on track (or practice) */
    /**
     * Qualifying before an AI race: the field waiting for its grid, the session's clock and laps, and the reference lap
     * the AI cars' times are taken from (a circuit's AI line check where it has one for this car, else a lone autopilot
     * lap of a copy of the car, driven a slice per frame while the player qualifies)
     */
    let quali: {
      field: AiRace;
      session: QualifyingSession;
      ref: { lapMs: number | null; base: number; car: SimulatorCar | null; lap0: number; simS: number };
    } | null = null;
    /** Page time per frame for the reference lap (ms), and the step it is driven at (s) */
    const QUALI_REF_BUDGET_MS = 1.5;
    const QUALI_REF_DT_S = 1 / 120;
    /** A reference lap that takes longer than this is given up (s of simulated time) */
    const QUALI_REF_GIVE_UP_S = 600;
    /** Page time the reference lap gets at the end of qualifying (ms): one not done by then is given up */
    const QUALI_REF_FINISH_MS = 200;
    const endQualifying = () => {
      quali = null;
    };
    /** Drives the reference lap on for up to `budgetMs` of page time (Infinity: to its end) */
    const stepQualifyingRef = (budgetMs: number) => {
      const ref = quali?.ref;
      const car = ref?.car;
      if (!ref || !car) return;
      const until = performance.now() + budgetMs;
      while (performance.now() < until) {
        car.step(QUALI_REF_DT_S, {});
        ref.simS += QUALI_REF_DT_S;
        if (car.telemetry.lapCount > ref.lap0) {
          ref.lapMs = car.telemetry.lastLapTimeMs ?? null;
        } else if (ref.simS < QUALI_REF_GIVE_UP_S) {
          continue;
        }
        ref.car = null;
        return;
      }
    };
    const finishQualifying = () => {
      const q = quali;
      if (!q) return;
      // A reference lap not yet done is driven on now (the moment between qualifying and the grid), for a moment only:
      // one still not over the line gives no reference, and the race lines up as its setup says (the AI cars by pace)
      stepQualifyingRef(QUALI_REF_FINISH_MS);
      quali = null;
      // In the rain the AI cars lap slower, as they race (the reference laps are dry)
      const weather = Math.max(0.5, getTrackEnv().weatherPaceScale(physics));
      q.field.qualifying = {
        playerMs: q.session.bestMs,
        refLapMs: q.ref.lapMs !== null ? Math.round(q.ref.lapMs / weather) : null,
        refBase: q.ref.base,
      };
      this.resetRun("race");
      this.setRace({ kind: "ai", field: q.field });
      startAiRace(q.field, settings.race, settings.profile);
    };
    this.startQualifying = (field, minutes) => {
      if (disposed) return;
      this.setRace({ kind: "practice" });
      const check = getActiveTrackMetadata().aiPlans?.[vehicleNow];
      let ref: NonNullable<typeof quali>["ref"];
      if (check?.ok && check.physicsLapS > 0) {
        ref = { lapMs: Math.round(check.physicsLapS * 1000), base: LINE_CHECK_REF_BASE, car: null, lap0: 0, simS: 0 };
      } else {
        // A copy of the car on the page, on its autopilot at full pace, alone on a flying lap
        const car = vehicleModelSpec(vehicleNow).createSim(track, trackRoot, carById(carIdNow).bodyPlan);
        car.resetToStartGrid(true);
        car.aiAutopilot = true;
        if (car.aiPaceScale !== undefined) car.aiPaceScale = 1;
        ref = { lapMs: null, base: AUTOPILOT_REF_BASE, car, lap0: car.telemetry.lapCount, simS: 0 };
      }
      quali = { field, session: new QualifyingSession(minutes * 60), ref };
      physics.resetToStartGrid(true);
    };
    const limitsSessionOf = (race: SessionRace) => (race.kind === "practice" ? "practice" : "race");
    /** The AI race's rules close the overtaking aids inside a yellow zone (set with the track-limits ladder) */
    let aidsLockInYellow = true;
    /**
     * Race control's track-limits ladder: an AI race's from its rules (the player's car class and the race setup),
     * and a multiplayer race's from the room's wire rules (defaulting to the classic strike ladder for older hosts)
     */
    const limitsRulesOf = (race: SessionRace): TrackLimitsRules => {
      if (race.kind === "mp") {
        const r = race.race.start.rules;
        if (!r) return LEGACY_TRACK_LIMITS;
        if (r.penalties === false || r.trackLimits === "off") return { scoring: "disabled", pointsAllowed: 0 };
        if (r.preset === "classic") return LEGACY_TRACK_LIMITS;
        const resolved = resolveRaceRules(vehicleModelSpec(vehicleNow).classId, { rulePreset: r.preset, trackLimits: r.trackLimits });
        aidsLockInYellow = resolved.lockAidsInYellow;
        return { scoring: resolved.trackLimits, pointsAllowed: resolved.pointsAllowed };
      }
      if (race.kind !== "ai") return LEGACY_TRACK_LIMITS;
      const rules = rulesForSetup(vehicleModelSpec(vehicleNow).classId, { ...settings.race, ...race.rules });
      aidsLockInYellow = rules.lockAidsInYellow;
      return { scoring: rules.trackLimits, pointsAllowed: rules.pointsAllowed };
    };
    /** MP qualifying & practice valid-lap tracking (broadcast in PeerRaceProgress.best and reported to room qualifying) */
    let mpQualiId: string | null = null;
    let mpQualiBestMs: number | null = null;
    let mpQualiSeenLap: number | null = null;
    let mpPracticeBestMs: number | null = null;
    let mpPracticeSeenLap: number | null = null;
    /**
     * The player's car damage judged on the page: barrier hits from the car's telemetry into an online race's damage
     * (the room's rules) or practice's (the Practice damage setting), each change handed to the car once
     */
    const damageFeed = new PlayerDamageFeed();
    /** Practice and time-trial damage, driven alone; repaired with every new run (resetRun) */
    const practiceDamage = new CarDamage(settings.practiceDamage, PLAYER_HALF_LENGTH_M, PLAYER_HALF_WIDTH_M);
    /** Driving time since a hit put the car out in practice (s): the car starts a flying lap, repaired, after a moment */
    let practiceWreckS = 0;
    this.setRace = (next) => {
      endQualifying();
      endTimeTrial();
      const prev = this.currentRace;
      // A race the worker runs ends there when the session leaves it; release any grid-hold / lane-bias cap on the player
      if (prev.kind === "ai" && (next.kind !== "ai" || next.field !== prev.field)) {
        prev.field.dispose?.();
        physics.aiSpeedCapMs = Infinity;
        physics.aiLineBiasM = 0;
      }
      this.currentRace = next;
      setRaceKind(next.kind);
      trackLimits.reset(limitsSessionOf(next), limitsRulesOf(next));
      wallDeletedLaps.clear();
      if (next.kind === "practice" && physics.telemetry.race !== undefined) {
        physics.telemetry.race = undefined;
        setTelemetry({ ...physics.telemetry });
      }
    };
    this.toggleAutopilot = () => {
      if (disposed || raceNow().kind === "mp" || coolDown.active) return;
      physics.aiAutopilot = !physics.aiAutopilot;
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
     * The simulation worker (`sim-mode.ts`): it drives the player's car in practice and runs AI races, through a
     * stand-in the rest of the session uses as the car (`sim-host.ts`, `worker-ai-field.ts`). Online races and a
     * steering wheel's races run on the page, and so does everything where a worker cannot be started.
     */
    let simWorker: ReturnType<typeof startSimWorker> | null = null;
    if (simMode() === "worker") {
      try {
        simWorker = startSimWorker();
      } catch (reason) {
        console.warn("[sim] worker unavailable, simulating on the page:", reason);
      }
    }
    // The time on the simulation's clock that the frame being made is drawn for: its animation-frame timestamp, not the
    // moment the frame's code reads the clock. The worker's cars are carried to it, so a frame whose callback starts a
    // few milliseconds late (other work on the page) draws them where they are at the frame's time, as the page's own
    // physics does (#160)
    let frameWallMs = performance.timeOrigin + performance.now();
    const simHost = simWorker ? createSimHost(simWorker, () => frameWallMs) : null;
    simWorker?.ping().then(
      (ms) => console.info(`[sim] worker round trip ${ms.toFixed(1)} ms`),
      (reason) => console.warn("[sim] worker unavailable, simulating on the page:", reason)
    );
    const createCar = (vehicle: VehicleModelId, prev: SimulatorCar | null, carId: CarId = carIdNow): SimulatorCar => {
      // A body that is not its vehicle model's own brings its own outline for the barriers
      const bodyPlan = carById(carId).bodyPlan;
      const built = vehicleModelSpec(vehicle).createSim(track, trackRoot, bodyPlan);
      const car = simHost ? simHost.adopt(built, vehicle, trackRoot, bodyPlan) : built;
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
          get aidsLocked() {
            const race = raceNow();
            return race.kind === "ai" ? (race.field.aidsLockedFor?.(self) ?? false) : false;
          },
        };
      }
      car.aiAutopilot = false;
      // The player's preferences from their settings; the aero package and the tyre on from the car before
      const prefs = settings;
      car.assistPreset = prefs.assistPreset;
      car.gamepadAssistEnabled = prefs.gamepadAssist;
      car.autoGearbox = prefs.autoGearbox;
      car.autoOvertake = prefs.autoOvertake;
      car.autoClutch = prefs.autoClutch;
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
      // and its garage chassis setup (clamped to this car's own setup sheet)
      const chassis = clampChassisToCarSheet(vehicle, loadChassisSetup(vehicle));
      car.applyChassisSetup?.(chassis);
      carSetup = { tireCompound: car.tireCompound, tyreSetup: initialTyreSetup, defaultTyreSetup: tyreDefaults, chassisSetup: chassis };
      return car;
    };
    /** The last car's setup as the garage shows it (createCar's) */
    let carSetup!: Pick<DriveSnapshot, "tireCompound" | "tyreSetup" | "defaultTyreSetup" | "chassisSetup">;

    let physics = createCar(vehicleNow, null);
    this.carNow = () => physics;
    const initialTelemetry: CarTelemetry = { ...physics.telemetry };
    this.telemetrySnapshot = initialTelemetry;
    this.telemetryStructKey = telemetryStructKeyOf(initialTelemetry);
    this.snapshot = {
      telemetry: initialTelemetry,
      replay: { active: false, timeS: 0, startS: 0, endS: 0, playing: true, speed: 1, canFlashback: false, focusedCarId: "player", cars: [], lapMarkers: [] },
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
      seatPanel: false,
      boostLatch: false,
      ...carSetup,
      timeTrial: null,
      autoQualityLowered: null,
      qualityNotice: null,
      gpuLost: null,
      nowPlaying: sharedMusic().current,
      cameraOverride: null,
      replayAvailable: false,
    };

    /**
     * An AI field built ahead, while the player is in the menus: building five AI cars (physics, autopilot plans) takes
     * a few hundred ms, which would otherwise be the first frame of the race. Only valid for the car and the field size
     * it was built for.
     */
    let aiFieldSpare: { field: AiOpponentField; physics: SimulatorCar; opponents: number } | null = null;
    /**
     * The AI cars of the next spare field, made one per idle slice before the field goes round them: each settles on
     * the grid as it is made (the first for real, the rest are given its settle, `settle-memo.ts`). Under `next dev` a
     * settle took half a second on Safari, so five in one task froze the menus for seconds
     */
    let sparePeers: { physics: SimulatorCar; cars: SimulatorCar[] } | null = null;
    /** The spare AI cars made for this car, used up */
    const takeSparePeers = (car: SimulatorCar) => {
      const peers = sparePeers?.physics === car ? sparePeers.cars : undefined;
      sparePeers = null;
      return peers;
    };
    /** A new AI field round the player's car, of the race setup's size, at the player's chosen skill */
    const buildAiField = (car: SimulatorCar) =>
      new AiOpponentField(track, car, aiDriversFor(settings.race.opponents), getTrackEnv(), {
        skill: settings.aiSkill,
        peers: takeSparePeers(car),
      });
    /**
     * The next race's grid slots, settled ahead on a throwaway AI car each, one per idle slice once the spare field is
     * built. A new field's AI cars are all alike, so the start then copies these settles (`settle-memo.ts`) instead of
     * running one per car at the click: only the player's own car still settles there
     */
    let gridWarm: { physics: SimulatorCar; key: string; next: number } | null = null;
    /** One build of the spare field at a time (each call while it runs would start another) */
    let aiPrepQueued = false;
    /**
     * The worker can run the next race: it has the car ready, and the player is not on a wheel (whose force feedback
     * still goes from the page a frame at a time)
     */
    const workerRaceLink = () => (simHost && settings.device !== "wheel" ? simHost.raceLink() : null);
    /** The car and field size the worker was last asked to build a spare field for */
    let workerPrepared: { physics: SimulatorCar; opponents: number } | null = null;
    this.prepareAiField = () => {
      if (aiPrepQueued) return;
      aiPrepQueued = true;
      const run = () => {
        aiPrepQueued = false;
        // Never while driving: the build would be a hitch on track instead
        if (disposed || appPhaseNow === "driving" || appPhaseNow === "loading") return;
        const opponents = settings.race.opponents;
        // A race in the worker is built there, off this thread: only the request goes from here
        const link = workerRaceLink();
        if (link) {
          if (workerPrepared?.physics !== physics || workerPrepared.opponents !== opponents) {
            workerPrepared = { physics, opponents };
            link.post({ type: "race", op: "prepare", opponents: aiDriversFor(opponents).length, skill: settings.aiSkill });
          }
          return;
        }
        if (aiFieldSpare?.physics === physics && aiFieldSpare.opponents === opponents) {
          // The field, the player in it, on the race setup's start
          const cars = aiDriversFor(opponents).length + 1;
          const rolling = settings.race.startMode === "rolling";
          const key = `${cars}:${rolling}`;
          if (gridWarm?.physics !== physics || gridWarm.key !== key) gridWarm = { physics, key, next: 0 };
          if (!physics.createAiPeerCar || gridWarm.next >= cars) return;
          physics.createAiPeerCar().resetToStartGrid(rolling, gridWarm.next, rolling ? cars : undefined, true);
          gridWarm.next++;
          aiPrepQueued = true;
          scheduleIdle(run, AI_PREP_GAP_MS);
          return;
        }
        if (sparePeers?.physics !== physics) sparePeers = { physics, cars: [] };
        if (physics.createAiPeerCar && sparePeers.cars.length < aiDriversFor(opponents).length) {
          sparePeers.cars.push(physics.createAiPeerCar());
          // A gap between the cars, for the menus to draw and take input (Safari has no idle callback to wait for)
          aiPrepQueued = true;
          scheduleIdle(run, AI_PREP_GAP_MS);
          return;
        }
        aiFieldSpare = { field: buildAiField(physics), physics, opponents };
        // Then its grid slots
        aiPrepQueued = true;
        scheduleIdle(run, AI_PREP_GAP_MS);
      };
      scheduleIdle(run, AI_PREP_GAP_MS);
    };
    this.takeAiField = () => {
      const link = workerRaceLink();
      if (link) {
        // The worker's spare field goes with this race: the menus ask for another after it
        workerPrepared = null;
        aiFieldSpare = null;
        const car = physics;
        return new WorkerAiField(link, getTrackEnv(), car, aiDriversFor(settings.race.opponents).length, settings.aiSkill, () => car.groundQuery ?? null);
      }
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
      // The field waiting on qualifying was built round the old car
      endQualifying();
      const newCar = car !== carRigCar;
      endTimeTrial();
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
        startAiRace(field, settings.race, settings.profile);
      }
      setTelemetry({ ...physics.telemetry });
      // In the menus, the next race's field is built for the new car
      this.prepareAiField();
      // Another car's sound (the physics switch keeps the car, and its sound)
      if (newCar) audio?.setCar(soundFor(car));
    };

    const haptics = new GamepadHaptics();
    const dualSense = new DualSenseDriver();
    const ownedByDualSense = (padId: string) => dualSenseHid.ownsPad(padId);
    this.silenceFeedback = () => {
      haptics.stop();
      dualSense.stop();
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
    // The view camera also draws the driving aids (the racing line) and close-range details left out of probe/mirrors
    camera.layers.enable(OVERLAY_LAYER);
    camera.layers.enable(DETAIL_LAYER);
    const nameplateProjector = new OverheadNameplateProjector();
    const nameplateBadges = new NameplateBadgeCache();
    let latestRemotePeers: readonly InterpolatedPeerState[] = [];

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        // MSAA happens in the post-processing composer's half-float target instead
        antialias: false,
        stencil: false,
        powerPreference: "high-performance",
        // Float precision across the 0.12 m .. 5.5 km depth range (kerbs, lines and decals stop z-fighting at
        // distance). three falls back to the standard buffer without EXT_clip_control; ?depth=standard forces it.
        reversedDepthBuffer: new URLSearchParams(window.location.search).get("depth") !== "standard",
      });
    } catch (reason) {
      // No WebGL (switched off, or refused after a GPU reset): the worker started above goes with the session
      simHost?.dispose();
      throw new WebGLUnavailableError(reason);
    }
    // The GPU for the bug form, read now: after a context loss the browser may refuse to tell
    const gpuName = rendererName(renderer.getContext());
    noteRenderer(gpuName);
    /**
     * A gentle start on a CPU rasteriser, an older Intel HD / UHD chip, or within two weeks of a context loss: no
     * physical sky (its GPU precompute), and a loading warm-up of what the camera sees rather than the whole circuit
     */
    const gpuClass = classifyRenderer(gpuName);
    const { gentle } = safeStartPlan(readLossMemory(browserStore(), Date.now()), gpuClass);
    console.info(`[gpu] ${gpuName ?? "renderer not named"} (${gpuClass})${gentle ? ": gentle start" : ""}`);
    /**
     * The context is gone: the frame loop keeps the network and the menus going but draws nothing and moves nothing,
     * and the component offers to load the circuit again on a new context. The old one is never reused: the sky's
     * lookup tables, the environment bake, the probe and the post-processing targets exist only on the GPU, and no
     * library here rebuilds its own.
     */
    let gpuLost = false;
    /** When the page last came back into view (performance.now()): a suspended tab may only hear of its loss then */
    let shownAtMs = -Infinity;
    const onContextLost = (event: Event) => {
      // The browser may give the context back only when asked to (three asks too)
      event.preventDefault();
      if (disposed || gpuLost) return;
      gpuLost = true;
      // Lost in the background (or heard of just after coming back): the browser reclaimed it, nothing to remember
      const hidden = document.visibilityState === "hidden" || performance.now() - shownAtMs < BACKGROUND_LOSS_GRACE_MS;
      recordContextLoss(browserStore(), Date.now(), hidden);
      console.warn(`[gpu] WebGL context lost (${appPhaseNow}${hidden ? ", page hidden" : ""}): the drive is paused`);
      releaseHeldKeys();
      this.silenceFeedback();
      this.publish({ gpuLost: { hidden, phase: appPhaseNow } });
    };
    const onContextRestored = () => {
      if (!disposed) console.info("[gpu] WebGL context restored; the circuit loads again on a new one when the player asks");
    };
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);
    renderer.domElement.addEventListener("webglcontextrestored", onContextRestored);
    // AgX exposure, pixel ratio clamp and shadow type; set before the composer is created
    configureRenderer(renderer);
    // The GPU formats the circuit's KTX2 textures transcode to (render/ktx2.ts)
    setKtx2Renderer(renderer);
    renderer.setSize(container.clientWidth, container.clientHeight);

    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    // Golden-hour sky dome, its baked PMREM environment, horizon fog and the cascaded sun shadow. On Medium and High
    // the physically based sky with volumetric clouds replaces the dome (physical-sky.ts); `?sky=classic` keeps the
    // dome on every preset, and so does a gentle start. It is built once the loading's warm-up is done (settleWarmup),
    // so its precompute never shares the GPU with the circuit's uploads
    const env = createGoldenHourEnvironment(renderer, scene, {
      physicalSky: !gentle && new URLSearchParams(window.location.search).get("sky") !== "classic",
      deferPhysicalSky: true,
    });
    // Rain streaks around the camera (one GPU-animated draw, hidden in the dry)
    const rainFx = createRainFx(scene);
    // Scene render + one merged effect pass (mipmap bloom on High, then AgX tone mapping and the grade);
    // applyGraphicsQuality puts the physical sky's clouds in front of it.
    // Read the phone profile once per session so MSAA, the reflection probe, the step-down order and the
    // HUD rate always agree (and phones never allocate a 4x MSAA renderbuffer at startup).
    const touchGraphics = isTouchDevice();
    const postFx = createPostFx(renderer, scene, camera, {
      multisampling: touchGraphics ? 0 : undefined,
    });
    // Live reflections of the world on the cars (High / Medium); Low keeps the sky's
    const reflectionProbe = new CarReflectionProbe(renderer, scene, { mobile: touchGraphics });
    // `?perf=1`: a report of the first 30 s on track (startup-monitor.ts), and a line every 10 s for the whole session
    // (session-perf.ts) with the simulation worker's own timing in it
    const startupMonitor = StartupMonitor.requested() ? new StartupMonitor(renderer) : null;
    const sessionPerf = SessionPerfMonitor.requested() ? new SessionPerfMonitor(renderer) : null;
    if (sessionPerf) {
      (window as unknown as { __lcPerfReport?: SessionPerfMonitor }).__lcPerfReport = sessionPerf;
      simWorker?.listen((event) => {
        if (event.type === "perf") sessionPerf.worker(event.spanMs, event.busyMs, event.maxWakeMs);
      });
      simWorker?.post({ type: "perf", on: true });
    }
    this.perfReport = sessionPerf ? () => sessionPerf.report(pageBuild()) : null;
    /** A capture waiting for the next drawn frame: read in the same task as the draw (the buffer is not preserved) */
    let captureWaiting: ((source: HTMLCanvasElement) => void) | null = null;
    /** The capture under way: a second request meanwhile gets the same picture */
    let capturePending: Promise<Blob | null> | null = null;
    this.captureFrame = (maxWidth = 1280) => {
      if (disposed) return Promise.resolve(null);
      if (capturePending) return capturePending;
      capturePending = new Promise<Blob | null>((resolve) => {
        const timer = setTimeout(() => {
          captureWaiting = null;
          resolve(null);
        }, 1500);
        captureWaiting = (source) => {
          clearTimeout(timer);
          try {
            const scale = Math.min(1, maxWidth / Math.max(1, source.width));
            const out = document.createElement("canvas");
            out.width = Math.max(1, Math.round(source.width * scale));
            out.height = Math.max(1, Math.round(source.height * scale));
            const ctx = out.getContext("2d");
            if (!ctx) return resolve(null);
            ctx.drawImage(source, 0, 0, out.width, out.height);
            out.toBlob((blob) => resolve(blob), "image/png");
          } catch {
            resolve(null);
          }
        };
      }).finally(() => {
        capturePending = null;
      });
      return capturePending;
    };
    reflectionProbe.setSky(env.probeSky);
    // Top-centre virtual rear-view mirror for the views without wing mirrors in shot
    const virtualMirror = new VirtualMirror(renderer, scene);
    let virtualMirrorShown = false;

    const builtCircuit = buildCircuitScene(track);
    scene.add(builtCircuit.sceneGroup);
    /**
     * The racing line is a driving aid: never drawn behind the title menu, the setup screens or Settings over them
     * (paused and in a replay the car is still being driven). Behind the opaque loading screen nothing is drawn, and it
     * stays on there so the shader warm-up compiles it (three's compile skips hidden meshes). The player's setting is
     * left as it is; each frame sets the line from it and the phase
     */
    const racingLineShown = (on: boolean) => on && (appPhaseNow === "driving" || appPhaseNow === "loading");
    builtCircuit.racingLineMesh.visible = racingLineShown(settings.racingLine);
    // A circuit raced under lights: its floodlit night (masts, lit tunnels, the model's glowing light sources),
    // or one whose own model has lamps (street lamps, light poles): they glow and light the ground round them
    let venueNight: VenueNightLighting | null = null;
    const lampSpec = track.nightLighting ? null : circuitNightSpec(trackId);
    /**
     * Sets the night lighting up once the circuit's model is in. A circuit with lamps of its own waits until its
     * session can get dark: the lighting costs a map, a texture read on every circuit material and a shader compile
     * of each, all wasted on a day that stays day
     */
    const ensureVenueNight = (root: THREE.Object3D) => {
      if (venueNight || disposed) return;
      if (!track.nightLighting && !(lampSpec && canSessionGetDark(getTrackEnv().weather.conditions))) return;
      const modelLamps = lampSpec ? applyCircuitNightLights(root, track, lampSpec) : [];
      const mode = lampSpec?.mode ?? "floodlit";
      venueNight = createVenueNightLighting(root, track, track.nightLighting ?? {}, { mode, modelLamps });
      venueNight.setQuality(settings.graphics.quality);
      venueNight.setNight(nightShareOf(getTrackEnv().weather.sun.elevationDeg));
      scene.add(venueNight.group);
      if (mode === "floodlit") env.setFloodlitNight(venueNight.look);
      // the cars take the lamps' light too (car-lamp-light.ts): their materials compile for it now, not under a lamp
      else {
        prepareCarForLamps(carRig.root);
        visualFx.forEachRigRoot(prepareCarForLamps);
      }
    };
    // The other cars' headlights on the road (opponent-beams.ts): set up with the night, on every circuit
    let opponentBeams: OpponentBeams | null = null;
    const beamScratch: HeadlightBeam[] = [];
    const ensureOpponentBeams = (root: THREE.Object3D) => {
      if (opponentBeams || disposed || !canSessionGetDark(getTrackEnv().weather.conditions)) return;
      opponentBeams = createOpponentBeams(root, MAX_BEAMS[settings.graphics.quality]);
    };
    const lampLight = new THREE.Color();
    const lightOpponentByLamps = (root: THREE.Object3D) => {
      if (venueNight) lightCarByLamps(root, venueNight.lightAt(root.position.x, root.position.z, lampLight), performance.now());
    };
    // Track_Collider_Road / surface colliders and Track_Collider_Wall_* barriers for the f12026-car
    void builtCircuit.trackRoot.then((root) => {
      if (disposed) return;
      trackRoot = root;
      ensureVenueNight(root);
      ensureOpponentBeams(root);
      physics.attachTrackRoot?.(root);
      aiFieldOf(raceNow())?.attachTrackRoot(root);
      aiFieldSpare?.field.attachTrackRoot(root);
      for (const peer of sparePeers?.cars ?? []) peer.attachTrackRoot?.(root);
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
    // The body follows the car's registry model, not `carPhysics`: a ported F1 car switched to the LC26 physics
    // keeps the geometry it was fitted to
    const rigModel = (car: CarId) => vehicleModelSpec(carById(car).physics);
    /** The livery the player picked for a car with its own (null: the paint its model was made in) */
    const skinFor = (car: CarId): PortedSkin | null => portedSkinFor(car, carSkinFor(car));
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
            // Non-F1 racing cars wear sagatron918's GT sidewall packs (optional `?tyres=<brand>` override for testing)
            gtSidewall:
              def.classId === "f1" || def.classId === "road"
                ? null
                : (resolveGtTyreBrand(typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tyres") : null) ??
                  defaultGtTyreBrand(def.id, def.classId)),
            skin: skinFor(car),
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
    const initialHeadlightConditions = canSessionGetDark(getTrackEnv().weather.conditions)
      ? getTrackEnv().weather.conditions
      : settings.conditions;
    // (a car without headlights, an F1 car, has no beam to build)
    const desiredHeadlightSpots = () =>
      carHasHeadlights(carRigCar) ? headlightSpotCountFor(getTrackEnv().weather.conditions, settings.graphics.quality) : 0;
    let carHeadlights = new CarHeadlights(carIdNow, {
      spotCount: headlightSpotCountFor(initialHeadlightConditions, settings.graphics.quality),
    });
    carHeadlights.attach(carRig.chassisGroup);
    let headlightMode: HeadlightMode = "auto";
    const syncHeadlightSpots = () => {
      const wanted = desiredHeadlightSpots();
      if (wanted === carHeadlights.spotCount) return;
      carHeadlights.dispose();
      carHeadlights = new CarHeadlights(carRigCar, { spotCount: wanted });
      carHeadlights.attach(carRig.chassisGroup);
    };
    // A livery picked in the menus goes onto the car at once
    const unsubscribeCarSkins = subscribeCarSkins(() => carRig.setSkin?.(skinFor(carRigCar)));
    const swapCarRig = (car: CarId) => {
      if (car === carRigCar) return;
      // The cockpit extras belong to the old body
      wheelDisplay?.dispose();
      wheelDisplay = null;
      wingMirrors?.dispose();
      wingMirrors = null;
      lc26ExtrasFor = null;
      gt3Dash?.dispose();
      gt3Dash = null;
      portedDash?.dispose();
      portedDash = null;
      carHeadlights.dispose();
      reflectionProbe.untrack(carRig.root);
      carRig.dispose();
      // Free the old car's GPU memory: switching cars otherwise stacks every model's textures on the GPU
      disposeTree(carRig.root);
      carRig = createCarRig(car);
      carRigCar = car;
      carHeadlights = new CarHeadlights(car, { spotCount: desiredHeadlightSpots() });
      carHeadlights.attach(carRig.chassisGroup);
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
    const syncNameplateBadges = () => {
      if (disposed) return;
      const lobbySettings = multiplayerSync.lobby?.settings;
      const badgeCtx: BadgeContext =
        lobbySettings?.vehicle && isVehicleModelId(lobbySettings.vehicle)
          ? { scope: "vehicle", vehicle: lobbySettings.vehicle }
          : lobbySettings?.carClass && lobbySettings.carClass !== "any"
            ? { scope: "class", classId: lobbySettings.carClass }
            : { scope: "all" };
      nameplateBadges.setContext(badgeCtx);
      if (latestRemotePeers.length > 0) void nameplateBadges.syncPeers(latestRemotePeers);
      const lobbyPlayers = multiplayerSync.lobby?.players;
      if (lobbyPlayers && lobbyPlayers.length > 0) {
        const localId = multiplayerSync.localPeerId;
        void nameplateBadges.syncNames(lobbyPlayers.filter((p) => p.peerId !== localId).map((p) => p.name));
      }
    };
    const nameplateBadgeTimer = window.setInterval(syncNameplateBadges, 1000);
    multiplayerSync.onStatusChange = (st) => {
      setP2pStatus(st);
      syncNameplateBadges();
    };
    setP2pStatus(multiplayerSync.status);
    syncNameplateBadges();

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

    // Automatic quality (adaptive-quality.ts): steps down on top of the player's graphics while the frames stay slow on
    // track, never touching the saved settings or the simulation. The frame-rate cap (frame-pacer.ts) picks the
    // frames that draw; input, the simulation, the network and the laps run on every frame.
    const pacer = new FramePacer(settings.graphics.fpsCap);
    const displayRate = new DisplayRate();
    const planOpts = (g: PlayerSettings["graphics"]): PlanOptions => ({
      touch: touchGraphics,
      sharpLow: g.sharpLow,
      sharpen: g.sharpen,
      // The player's Lowest resolution: the resolution rungs stop there (the effects rungs still run)
      minScale: g.autoQualityMinScale,
    });
    const autoQualityText = (g: PlayerSettings["graphics"]) =>
      g.autoQuality ? `auto quality on (lowest ${Math.round(g.autoQualityMinScale * 100)}%)` : "auto quality off";
    const ladderLength = (g: PlayerSettings["graphics"]) => ladderFor(g.quality, g.renderScale, planOpts(g)).length;
    const startLevel = settings.graphics.autoQuality
      ? carriedLevel(settings.graphics.quality, settings.graphics.renderScale, performance.now(), planOpts(settings.graphics))
      : 0;
    const governor = new QualityGovernor(ladderLength(settings.graphics), startLevel);
    // Carried in from the last session: this one ending without a step leaves the next one rung better again
    if (startLevel > 0) {
      rememberLevel(settings.graphics.quality, settings.graphics.renderScale, startLevel, performance.now(), planOpts(settings.graphics));
    }
    /** The governor was fed last frame (driving), so the frame that stops driving restarts its grace once */
    let governorFed = false;
    let qualityNoticeId = 0;
    let lastQualityNoticeMs = -Infinity;
    const graphicsLine = (g: PlayerSettings["graphics"], lowered: string | null) =>
      [
        `${g.quality[0].toUpperCase()}${g.quality.slice(1)}`,
        `render ${Math.round(g.renderScale * 100)}%`,
        touchGraphics ? "phone profile" : "desktop profile",
        ...(g.quality === "low" && g.sharpLow ? ["Sharp Low"] : []),
        `sharpen ${g.sharpen ? "on" : "off"}`,
        autoQualityText(g),
        g.fpsCap ? `${g.fpsCap} fps cap` : "no fps cap",
        `lowered: ${lowered ?? "nothing"}`,
        `pixel ratio ${renderer.getPixelRatio().toFixed(2)}`,
        simWorker ? "sim worker" : "sim on the page",
      ].join(" · ");
    this.setOffTrackGlow = (on) => {
      if (disposed) return;
      // The colour-blind palettes move loss from crimson to tangerine on the page root (palette.css)
      postFx.setEdgeGlow(on ? getComputedStyle(document.documentElement).getPropertyValue("--lc-sem-loss") || "#ff2a3c" : null);
    };
    this.applyGraphics = () => {
      if (disposed) return;
      const g = settings.graphics;
      const opts = planOpts(g);
      const level = g.autoQuality ? governor.level : 0;
      const plan = level > 0 ? planAt(g.quality, g.renderScale, level, opts) : presetPlan(g.quality, g.renderScale, opts);
      applyGraphicsQuality(renderer, postFx, env, plan);
      venueNight?.setQuality(g.quality);
      visualFx.setGraphicsQuality(g.quality);
      reflectionProbe.setQuality(plan.reflections && g.quality !== "low" ? g.quality : "off");
      postFx.setSize(container.clientWidth, container.clientHeight);
      const lowered = level > 0 ? loweredSummary(g.quality, g.renderScale, level, opts) : null;
      if (lowered !== this.snapshot.autoQualityLowered) this.publish({ autoQualityLowered: lowered });
      sessionPerf?.setRenderState({ settings: graphicsLine(g, lowered), level });
      noteFrameGraphics(graphicsLine(g, lowered));
    };
    this.applyGraphics();
    /** The governor's decision on a frame: take the step (and say so, quietly), or note that every step is taken */
    const onQualityEvent = (event: GovernorEvent, nowMs: number) => {
      const g = settings.graphics;
      const why = `90% of frames within ${event.p90Ms.toFixed(1)} ms against a ${event.budgetMs.toFixed(1)} ms budget`;
      if (event.kind === "floor") {
        sessionPerf?.note(nowMs, `still slow with every step taken (${why})`);
        // The one thing left is the player's: 30 fps
        if (g.fpsCap === 0) this.publish({ qualityNotice: { id: ++qualityNoticeId, kind: "floor" } });
        return;
      }
      const opts = planOpts(g);
      rememberLevel(g.quality, g.renderScale, event.level, nowMs, opts);
      this.applyGraphics();
      const lowered = loweredSummary(g.quality, g.renderScale, event.level, opts);
      console.info(`[quality] stepped down (${event.level}/${governor.floor}): ${lowered}; ${why}`);
      sessionPerf?.note(nowMs, `stepped down ${event.level}/${governor.floor}: ${lowered} (${why})`);
      if (nowMs - lastQualityNoticeMs >= QUALITY_NOTICE_GAP_MS) {
        lastQualityNoticeMs = nowMs;
        this.publish({ qualityNotice: { id: ++qualityNoticeId, kind: "lowered" } });
      }
    };
    setDriverBodyShown(settings.graphics.driverBody);
    this.applySettings = (next) => {
      const prev = settings;
      if (disposed || next === prev) return;
      settings = next;
      // From the next hit (switched off, the frame loop repairs the car)
      practiceDamage.level = next.practiceDamage;
      if (next.audio !== prev.audio) {
        if (next.audio.muted !== this.snapshot.muted) this.publish({ muted: next.audio.muted });
        audio?.setMuted(next.audio.muted);
        audio?.setVolume(next.audio.volume);
        audio?.setKerbVolume(next.audio.kerbs);
        applyMusicSettings(next);
      }
      if (next.keys !== prev.keys) keyLookup = buildKeyLookup(next.keys);
      if (next.padTuning !== prev.padTuning || next.keyboardTuning !== prev.keyboardTuning) {
        assistSettings = steeringAssistSettings(next.padTuning, next.keyboardTuning);
      }
      // The preferences the game applies to the car (a new car takes them in createCar)
      if (next.assistPreset !== prev.assistPreset) physics.assistPreset = next.assistPreset;
      if (next.gamepadAssist !== prev.gamepadAssist) physics.gamepadAssistEnabled = next.gamepadAssist;
      if (next.autoGearbox !== prev.autoGearbox) physics.autoGearbox = next.autoGearbox;
      if (next.autoOvertake !== prev.autoOvertake) physics.autoOvertake = next.autoOvertake;
      if (next.autoClutch !== prev.autoClutch) physics.autoClutch = next.autoClutch;
      builtCircuit.racingLineMesh.visible = racingLineShown(next.racingLine);
      if (prev.mouseSteer && !next.mouseSteer) mouseSteerValue = 0;
      const customChanged =
        next.customLivery.primary !== prev.customLivery.primary ||
        next.customLivery.secondary !== prev.customLivery.secondary ||
        next.customLivery.accent !== prev.customLivery.accent;
      if (next.liveryId !== prev.liveryId || (next.liveryId === "custom" && customChanged)) {
        livery = resolveLivery(next.liveryId, next.customLivery);
        carRig.setLivery(livery);
      }
      const g = next.graphics;
      const pg = prev.graphics;
      if (
        g.quality !== pg.quality ||
        g.renderScale !== pg.renderScale ||
        g.autoQuality !== pg.autoQuality ||
        g.sharpLow !== pg.sharpLow ||
        g.autoQualityMinScale !== pg.autoQualityMinScale
      ) {
        // The player's own choice: the automatic steps start over from it
        governor.reset(ladderLength(g), 0);
        rememberLevel(g.quality, g.renderScale, 0, performance.now(), planOpts(g));
        this.applyGraphics();
        if (g.quality !== pg.quality) syncHeadlightSpots();
        sessionPerf?.note(performance.now(), `graphics set to ${g.quality}, render ${Math.round(g.renderScale * 100)}%, ${autoQualityText(g)}`);
      } else if (g.sharpen !== pg.sharpen) {
        this.applyGraphics();
      }
      if (g.fpsCap !== pg.fpsCap) {
        pacer.setCap(g.fpsCap);
        // A new frame budget: judged afresh
        governor.interrupt();
        sessionPerf?.setRenderState({ settings: graphicsLine(g, this.snapshot.autoQualityLowered), level: g.autoQuality ? governor.level : 0 });
        sessionPerf?.note(performance.now(), g.fpsCap ? `frame rate capped at ${g.fpsCap} fps` : "frame rate cap off");
      }
      if (g.driverBody !== pg.driverBody) setDriverBodyShown(g.driverBody);
      // Another field size needs another field: a race running restarts from the lights with it
      if (next.race.opponents !== prev.race.opponents) {
        aiFieldSpare = null;
        if (raceNow().kind === "ai") {
          this.resetRun("race");
          const field = this.takeAiField();
          if (trackRoot) field.attachTrackRoot(trackRoot);
          this.setRace({ kind: "ai", field });
          startAiRace(field, next.race, next.profile);
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
      const safe = clampChassisToCarSheet(vehicleNow, setup);
      // The garage keeps the player's own setup; the time trial's fuel stays on the car
      physics.applyChassisSetup?.(timeTrialOn() ? lowestFuelSetup(safe) : safe);
      this.publish({ chassisSetup: safe });
    };
    this.setTimeTrial = (rules) => {
      if (disposed) return;
      if (!rules) return endTimeTrial();
      if (!timeTrial) ownCompound = physics.tireCompound;
      timeTrial = rules;
      putTimeTrialOn();
      this.publish({ timeTrial: rules });
    };
    this.restartFlyingLap = () => {
      if (disposed || raceNow().kind !== "practice") return;
      // Out of a replay first (the reset does that), then the conditions, then the car moves
      this.resetRun("restart");
      putTimeTrialOn();
      physics.resetToStartGrid(true);
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
    xrCamera.layers.enable(DETAIL_LAYER);
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
          if (renderer.xr.isPresenting) clearCameraOverride();
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

    /** Keys pressed with Alt to move the camera, until they are let go */
    const cameraNudgeCodes = new Set<string>();
    /** Alt keys held that the player bound to a control: while one is down, Alt moves no camera */
    const boundAltsHeld = new Set<string>();
    /** The camera key's hold timer (a hold opens the seat panel) and the pad camera button's press time */
    let cameraKeyHold: number | null = null;
    let padCameraHeldSinceMs: number | null = null;
    /** The controller's headlight button (a tap flashes, a hold switches the lights) and the flash's least length */
    const headlightButton = new HeadlightButton();
    const flashTimer = new FlashTimer();
    let playerFlashing = false;
    const clearCameraOverride = () => {
      if (cameraOverride === null) return;
      cameraOverride = null;
      freeCamKeys.clear();
      freeCamDrag = null;
      renderer.domElement.style.touchAction = "";
      this.publish({ cameraOverride: null });
    };
    this.setCameraOverride = (next: CameraMode | null) => {
      if (disposed) return;
      if (cameraOverride === next) return;
      if (next === null) {
        clearCameraOverride();
        return;
      }
      cameraOverride = next;
      if (next === "free") {
        cameraRig.freeCamera.reset();
        releaseHeldKeys();
        renderer.domElement.style.touchAction = "none";
      } else {
        freeCamKeys.clear();
        freeCamDrag = null;
        renderer.domElement.style.touchAction = "";
      }
      this.publish({ cameraOverride: next });
    };
    this.toggleFreeCamera = () => {
      if (disposed) return;
      this.setCameraOverride(cameraOverride === "free" ? null : "free");
    };
    this.toggleTvCamera = () => {
      if (disposed) return;
      this.setCameraOverride(cameraOverride === "tv_side" ? null : "tv_side");
    };
    this.resetFreeCamera = () => {
      if (!disposed) cameraRig.freeCamera.reset();
    };

    const isFreeCamInteractive = () =>
      cameraOverride === "free" &&
      !renderer.xr.isPresenting &&
      appPhaseNow === "driving" &&
      !this.snapshot.paused &&
      !this.snapshot.seatPanel &&
      !podium.playing;

    const onFreeCamPointerDown = (e: PointerEvent) => {
      if (!isFreeCamInteractive()) return;
      if (e.button !== 0 && e.button !== 2) return;
      freeCamDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      try {
        renderer.domElement.setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture failure on synthetic events
      }
    };
    const onFreeCamPointerMove = (e: PointerEvent) => {
      if (!freeCamDrag || e.pointerId !== freeCamDrag.id) return;
      if (!isFreeCamInteractive()) {
        freeCamDrag = null;
        return;
      }
      const dx = e.clientX - freeCamDrag.x;
      const dy = e.clientY - freeCamDrag.y;
      freeCamDrag.x = e.clientX;
      freeCamDrag.y = e.clientY;
      cameraRig.freeCamera.lookDelta(-dx * 0.0042, -dy * 0.0042);
    };
    const onFreeCamPointerUp = (e: PointerEvent) => {
      if (freeCamDrag && e.pointerId === freeCamDrag.id) freeCamDrag = null;
    };
    const onFreeCamWheel = (e: WheelEvent) => {
      if (!isFreeCamInteractive()) return;
      if (e.deltaY === 0) return;
      e.preventDefault();
      // Scale smoothly by deltaY so trackpad swipes don't jump straight to min/max
      const mag = Math.min(1.5, Math.abs(e.deltaY) / 100);
      const dir = Math.sign(e.deltaY);
      if (e.altKey) cameraRig.freeCamera.adjustFov(dir * 2 * Math.max(0.25, mag));
      else cameraRig.freeCamera.adjustSpeed(Math.pow(1.18, -dir * Math.max(0.2, mag)));
    };
    const onFreeCamContextMenu = (e: MouseEvent) => {
      if (isFreeCamInteractive() || freeCamDrag !== null) e.preventDefault();
    };
    renderer.domElement.addEventListener("pointerdown", onFreeCamPointerDown);
    renderer.domElement.addEventListener("pointermove", onFreeCamPointerMove);
    renderer.domElement.addEventListener("pointerup", onFreeCamPointerUp);
    renderer.domElement.addEventListener("pointercancel", onFreeCamPointerUp);
    renderer.domElement.addEventListener("wheel", onFreeCamWheel, { passive: false });
    window.addEventListener("contextmenu", onFreeCamContextMenu);

    const onKeyDown = (e: KeyboardEvent) => {
      const isRangeInput = e.target instanceof HTMLInputElement && e.target.type === "range";
      if (
        (!isRangeInput && e.target instanceof HTMLInputElement) ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return;
      }
      // Every key down is noted, the ones the screens below take too: a driving key held as they close drives at once
      physicalKeys.keyDown(
        e,
        this.snapshot.seatPanel ? "seatPanel" : appPhaseNow !== "driving" || this.snapshot.paused || gpuLost ? "menu" : "drive"
      );
      // The loading screen, title menu and setup own the keyboard outside the car
      if (appPhaseNow !== "driving") return;
      this.unlockAudio();
      // polish:B any key skips the podium shot (not a key held over the line) and does nothing else
      if (podium.playing) {
        if (!e.repeat) podium.skip();
        return;
      }
      // The seat panel owns the keyboard while it is open (SeatPanel.tsx)
      if (this.snapshot.seatPanel) return;
      const code = e.code;

      if (code === "Escape") {
        e.preventDefault();
        // A held Esc pauses once: its repeats would resume again, or unpause after closing a screen opened from pause
        if (!e.repeat) this.togglePause();
        return;
      }
      if (this.snapshot.paused) return;

      // Free camera mode: capture flight keys, R to reset near car, and [ / ] for FOV while keeping global hotkeys working
      if (isFreeCamInteractive()) {
        // Honour a rebound freeCamera toggle key (e.g. Q, R, or Space) before capturing flight keys
        if (keyLookup.get(code) === "freeCamera") {
          e.preventDefault();
          if (!e.repeat) this.toggleFreeCamera();
          return;
        }
        if (code === "KeyR") {
          e.preventDefault();
          if (!e.repeat) cameraRig.freeCamera.reset();
          return;
        }
        if (code === "BracketLeft" || code === "BracketRight") {
          e.preventDefault();
          cameraRig.freeCamera.adjustFov(code === "BracketLeft" ? -2 : 2);
          return;
        }
        if (FREE_CAM_MOVE_CODES.has(code)) {
          e.preventDefault();
          freeCamKeys.add(code);
          return;
        }
        // Alt is the slow-fly modifier in Free cam: never let Alt combos fall through to cockpit seat-nudge
        if (e.altKey) {
          e.preventDefault();
          return;
        }
      }

      // Alt + arrows, − / = (Page Up / Down) and [ / ] move the cockpit or dash view, saved for this car; Alt + 0 puts
      // it back. Nothing else sees a key pressed with Alt (the arrows don't drive, Alt + ← / → don't leave the page),
      // nor its repeats once Alt is let go before it. While an Alt key the player bound to a control is held, Alt is
      // that control and nothing else: it and the keys pressed with it drive as bound
      if ((code === "AltLeft" || code === "AltRight") && keyLookup.has(code)) boundAltsHeld.add(code);
      const altNudges = e.altKey && boundAltsHeld.size === 0;
      if (altNudges || cameraNudgeCodes.has(code)) {
        e.preventDefault();
        const step = altNudges ? nudgeStepForKey(code) : undefined;
        if (step !== undefined) {
          cameraNudgeCodes.add(code);
          const view = settings.camera;
          const car = carRigCar;
          if (isNudgeView(view)) setSettings((prev) => ({ ...prev, cameraNudges: stepNudge(prev.cameraNudges, car, view, step) }));
        }
        return;
      }

      // [ / ] narrow / widen the onboard FOV live, unless the player bound those keys to a control
      // In the cockpit and dash views they set this car's FOV for the view (the seat panel's FOV row); elsewhere the
      // base FOV every car shares
      if ((code === "BracketLeft" || code === "BracketRight") && !keyLookup.has(code)) {
        const step = code === "BracketLeft" ? -1 : 1;
        const view = settings.camera;
        const car = carRigCar;
        if (isNudgeView(view)) {
          setSettings((prev) => ({ ...prev, cameraNudges: stepNudge(prev.cameraNudges, car, view, { fovDeg: step * NUDGE_FOV_STEP_DEG }) }));
          return;
        }
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
      // Prevent browser built-in shortcuts (F7 caret browsing; Space activating a focused HUD button or scrolling, and
      // arrows scrolling while actively driving — never intercepting ReplayBar, RaceResults, or open dialogs/menus)
      const inOverlayNav =
        e.target instanceof Element && e.target.closest('[role="dialog"], [role="listbox"], [role="menu"]') !== null;
      if (
        action === "freeCamera" ||
        /^F\d+$/.test(code) ||
        (!replay.active && !coolDown.active && !inOverlayNav && (code === "Space" || code.startsWith("Arrow")))
      ) {
        e.preventDefault();
      }
      // The camera key: a tap changes the view (on release), held it opens the seat panel (no seat panel during replay)
      if (action === "camera") {
        if (replay.active) {
          if (!e.repeat) cycleCamera();
          return;
        }
        if (!e.repeat && cameraKeyHold === null) {
          cameraKeyHold = window.setTimeout(() => {
            cameraKeyHold = null;
            this.openSeatPanel();
          }, SEAT_PANEL_HOLD_MS);
        }
        return;
      }
      // Held controls ignore auto-repeat anyway; toggles must not flicker while a key is held
      if (isHeldKeyAction(action)) return holdKey(action);
      if (action === "shiftUp") heldKeys.gearUpHeld = true;
      // Held controls ignore auto-repeat anyway; one-shot actions must not flicker while a key is held
      if (e.repeat) return;
      runAction(action);
    };
    /** A held control's key is down */
    const holdKey = (action: HeldKeyAction) => {
      // During replay, driving keys (e.g. arrow keys used for timeline seek) must not steer or cancel autopilot
      if (replay.active) return;
      heldKeys[HELD_KEYS[action]] = true;
      if (DRIVER_KEYS.has(action) && physics.aiAutopilot && !coolDown.active) physics.aiAutopilot = false;
    };
    /**
     * The pause menu or the seat panel hands the car back: the keys still down hold again now, as their keydowns were
     * dropped while it was open and the browser repeats a held key only after the system's repeat delay (#171). Held
     * controls only, sorted as a keydown would: Free camera flies on its keys, Alt combos stay view nudges
     */
    const restoreHeldKeys = () => {
      const freeCam = isFreeCamInteractive();
      const driveCodes: string[] = [];
      for (const code of physicalKeys.restorable(keyLookup)) {
        if (cameraNudgeCodes.has(code)) continue;
        if (freeCam && FREE_CAM_MOVE_CODES.has(code)) freeCamKeys.add(code);
        else driveCodes.push(code);
      }
      const { actions, gearUpHeld } = heldActionsOf(driveCodes, keyLookup);
      for (const action of actions) holdKey(action);
      if (gearUpHeld) heldKeys.gearUpHeld = true;
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
        case "neutral":
          heldKeys.neutral = true;
          break;
        case "aero":
          heldKeys.toggleX = true;
          break;
        case "boostLatch":
          setLatch(!this.snapshot.boostLatch);
          break;
        case "overtake":
          heldKeys.overtake = true;
          break;
        case "camera":
          cycleCamera();
          break;
        case "freeCamera":
          this.toggleFreeCamera();
          break;
        case "tvCamera":
          this.toggleTvCamera();
          break;
        case "racingLine":
          handleToggleRacingLine();
          break;
        case "restart":
          restartRun();
          break;
        case "flyingLap":
          this.restartFlyingLap();
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
        case "nextTrack":
          this.nextTrack();
          break;
        case "autopilot":
          this.toggleAutopilot();
          break;
        case "headlights": {
          const onNow = shouldHeadlightsBeOn(headlightMode, skyConditions.elevationDeg, getTrackEnv().weather.rainIntensity);
          headlightMode = onNow ? "off" : "on";
          lastWeatherHudMs = -Infinity;
          break;
        }
        // The HUD owns these panels
        case "mfd":
        case "mfdPage":
        case "hud":
        case "board":
          window.dispatchEvent(new Event(HUD_TOGGLE_EVENT[action]));
          break;
      }
    };

    const restartRun = () => {
      // A multiplayer race is restarted by the host, from the pause menu
      const race = raceNow();
      if (race.kind === "mp") return;
      if (race.kind === "practice") return this.restartFlyingLap();
      // Out of a replay first (the reset does that), then the car moves
      this.resetRun("restart");
      startAiRace(race.field, settings.race, settings.profile);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      physicalKeys.keyUp(e.code);
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      cameraNudgeCodes.delete(e.code);
      boundAltsHeld.delete(e.code);
      freeCamKeys.delete(e.code);
      const action = keyLookup.get(e.code);
      if (action === "camera" && cameraKeyHold !== null) {
        window.clearTimeout(cameraKeyHold);
        cameraKeyHold = null;
        if (!this.snapshot.paused && !this.snapshot.seatPanel) cycleCamera();
      }
      if (action === "shiftUp") heldKeys.gearUpHeld = false;
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
      if (!document.hidden) {
        shownAtMs = performance.now();
        return;
      }
      wheelFfb.stop();
      releaseHeldKeys();
      physicalKeys.clear();
      // The first frames back are no measure of the frame rate
      governor.interrupt();
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
    const onWindowBlur = () => {
      releaseHeldKeys();
      physicalKeys.clear();
      // Their keyups go to another window: the keys would stay swallowed, and a held camera key would open the panel
      cameraNudgeCodes.clear();
      boundAltsHeld.clear();
      if (cameraKeyHold !== null) window.clearTimeout(cameraKeyHold);
      cameraKeyHold = null;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("blur", onWindowBlur);

    let lastTimeMs = performance.now();
    /** The frame-rate cap: when the scene was last drawn, and the time since that the next drawn frame shows */
    let lastDrawMs = lastTimeMs;
    let pendingDrawS = 0;
    /** `?perf=1`: the page's own simulation in this frame (ms) */
    let frameSimMs = 0;
    let lastHudSyncMs = 0;
    let lastTelemetryOutMs = 0;
    // Instant / full-race replay: session clock while driving, live pose saved while replaying, and camera target adapter
    let replayClockS = 0;
    let lastReplayPushS = -1;
    const replaySaved = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    const replayPlayerVel = new THREE.Vector3();
    const replayFocusVel = new THREE.Vector3();
    let replayPlayerS = 0;
    let replayPlayerTelemetry: CarTelemetry = { ...physics.telemetry };
    let replayFocusTelemetry: CarTelemetry = { ...physics.telemetry };
    let replayFocusCarFrame: ReplayCarState | null = null;
    const replayCamCar: { -readonly [K in keyof CameraRigCar]: CameraRigCar[K] } = {
      telemetry: replayFocusTelemetry,
      worldPosition: new THREE.Vector3(),
      worldQuaternion: new THREE.Quaternion(),
      wheelbaseM: physics.wheelbaseM,
      cgHeightM: physics.cgHeightM,
      rideHeightOffsetM: 0,
      pitchRad: 0,
      rollRad: 0,
      yawRateRadS: 0,
      vxMs: 0,
      vyMs: 0,
      sMeters: 0,
      lateralOffsetM: 0,
    };
    const replayPeerState = (car: ReplayCarState, timeS: number, wheelDir: number): InterpolatedPeerState => {
      const vel = replay.buffer.velocityAt(timeS, car.id, new THREE.Vector3());
      const rpm = wheelDir === 0 ? 0 : wheelDir * wheelRpmAtSpeed(car.speedKmh);
      return {
        peerId: car.id,
        driverCode: replayNames.get(car.id)?.code ?? "",
        teamColorHex: replayNames.get(car.id)?.color ?? GHOST_CAR_COLOR,
        vehicle: replayNames.get(car.id)?.vehicle,
        position: new THREE.Vector3(car.x, car.y, car.z),
        quaternion: new THREE.Quaternion(car.qx, car.qy, car.qz, car.qw),
        linearVelocity: vel,
        steerAngle: steerAngleOf(car.steer),
        wheelRPMs: [rpm, rpm, rpm, rpm],
        throttle: car.throttle,
        brake: car.brake,
        trackS: car.s ?? 0,
        speedKmh: car.speedKmh,
        gear: car.gear,
        rpm: car.rpm,
        isAiPeer: true,
        // The frames hold the body's pose: the rig rests the wheels on the road under each corner
        wheels: { ground: physics.groundQuery ?? null },
      };
    };
    /** Look of every car seen in the replay window (the frames only hold poses) */
    const replayNames = new Map<string, { code: string; color: string; vehicle?: VehicleModelId }>();
    const buildReplayCarOptions = (): ReplayCarOption[] => {
      const playerCode = (settings.profile.code || "YOU").slice(0, 3).toUpperCase();
      const playerColor = settings.profile.color || "#CCFF00";
      return replay.buffer.carIds().map((id) => {
        if (id === "player") return { id, label: playerCode, color: playerColor, isPlayer: true };
        const info = replayNames.get(id);
        return {
          id,
          label: info?.code || id.slice(0, 3).toUpperCase(),
          color: info?.color ?? GHOST_CAR_COLOR,
          isPlayer: false,
        };
      });
    };
    const publishReplayUi = () => {
      const rp = replay;
      setReplayUi({
        active: rp.active,
        timeS: rp.timeS,
        startS: rp.buffer.startS,
        endS: rp.buffer.endS,
        playing: rp.playing,
        speed: rp.speed,
        canFlashback: rp.active && canFlashbackNow(),
        focusedCarId: rp.focusedCarId,
        cars: rp.cars,
        lapMarkers: rp.lapMarkers,
      });
    };
    const canFlashbackNow = (): boolean => {
      const race = raceNow();
      return canFlashback({
        raceKind: race.kind,
        weeklyChallengeRace: race.kind === "ai" && race.rules !== undefined,
        timeTrialActive: timeTrial !== null,
        qualifyingActive: quali !== null || multiplayerSync.activeQualifying !== null,
        inOnlineRoom: isInOnlineRoom(multiplayerSync.status, peersOnTrack),
        aiRacePhase: race.kind === "ai" ? race.field.phase : undefined,
      });
    };
    const replayLastFocusPos = new THREE.Vector3();
    const replayLastFocusQuat = new THREE.Quaternion();
    let replayLastFocusId: string | null = null;
    const exitReplay = () => {
      const rp = replay;
      if (!rp.active) return;
      rp.active = false;
      rp.focusedCarId = "player";
      replayLastFocusId = null;
      clearCameraOverride();
      // The replay only moved the drawn car (the physics never left the live pose): put the drawing back
      physics.worldPosition.copy(replaySaved.pos);
      physics.worldQuaternion.copy(replaySaved.quat);
      cameraRig.reset();
      publishReplayUi();
    };
    const openReplay = (opts: { fromStart?: boolean; play?: boolean } = {}): boolean => {
      if (disposed) return false;
      const rp = replay;
      // Not in a multiplayer race or active online room (where replayed poses would broadcast to peers)
      if (
        raceNow().kind === "mp" ||
        isInOnlineRoom(multiplayerSync.status, peersOnTrack) ||
        rp.buffer.durationS < 1 ||
        appPhaseNow !== "driving"
      ) {
        return false;
      }
      if (!rp.active) {
        replaySaved.pos.copy(physics.worldPosition);
        replaySaved.quat.copy(physics.worldQuaternion);
      }
      rp.active = true;
      rp.playing = opts.play ?? false;
      rp.speed = 1;
      rp.timeS = opts.fromStart
        ? rp.buffer.startS
        : Math.max(rp.buffer.startS, rp.buffer.endS - REPLAY_OPEN_BACK_S);
      rp.prevTimeS = rp.timeS;
      rp.wheelRotRad = physics.wheelRotationRad;
      rp.focusedCarId = "player";
      replayLastFocusId = null;
      rp.cars = buildReplayCarOptions();
      rp.lapMarkers = rp.buffer.lapMarkers();
      // Neutralise live G-forces & boost flag so chase cameras don't stay locked sideways from the frame replay opened
      replayPlayerTelemetry = {
        ...physics.telemetry,
        longitudinalG: 0,
        lateralG: 0,
        verticalG: 1,
        manualOverrideActive: false,
      };
      replayFocusTelemetry = {
        ...physics.telemetry,
        longitudinalG: 0,
        lateralG: 0,
        verticalG: 1,
        manualOverrideActive: false,
      };
      cameraRig.reset();
      publishReplayUi();
      return true;
    };
    const flashbackReplay = (): boolean => {
      const rp = replay;
      if (!rp.active || !canFlashbackNow()) return false;
      const frame = rp.buffer.frameAt(rp.timeS);
      const car = frame?.cars.find((c) => c.id === "player");
      if (!car) return false;
      const rewindS = Math.max(0, replayClockS - rp.timeS);
      const prevLapCount = physics.telemetry.lapCount;
      const crossedLine = (car.lap !== undefined && car.lap < prevLapCount) || (Boolean(car.outLap) && !physics.telemetry.outLap);
      const targetS = car.s ?? physics.sMeters;
      const inLastSector = !track.pointToPoint && track.getSampleAtDistance(targetS).sector === 3;
      // Invalidate before and after restoring pose so both the worker's immediate placement report and local twin see it
      physics.invalidateLap?.();
      const playerPose = poseFromReplayCar(car);
      if (physics.restorePose) physics.restorePose(playerPose);
      else physics.teleportToDistance(targetS, playerPose.speedMs);
      physics.invalidateLap?.();
      // Invalidate the current lap in LapRecorder & reconcile TrackLimitsMonitor watches for the rewound window
      lapRecorder.invalidateCurrentLap();
      trackLimits.noteFlashback(performance.now(), rewindS, { crossedLine, inLastSector });
      // In an AI race, rewind every AI car and race clock together so there are no teleport glitches
      const field = aiFieldOf(raceNow());
      if (field?.restoreField && frame) {
        const poses: FieldCarRestorePose[] = [];
        for (const c of frame.cars) {
          const p = poseFromReplayCar(c);
          poses.push({
            id: c.id,
            x: c.x,
            y: c.y,
            z: c.z,
            qx: c.qx,
            qy: c.qy,
            qz: c.qz,
            qw: c.qw,
            yawRad: p.yawRad,
            speedMs: p.speedMs,
            ...(c.s !== undefined ? { s: c.s } : {}),
            ...(c.distM !== undefined ? { distM: c.distM } : {}),
          });
        }
        field.restoreField(poses, rewindS);
      }
      // Practice damage goes back to what it was then (an AI race's field keeps the player's own)
      if (raceNow().kind === "practice") damageFeed.rewind(practiceDamage, rp.timeS);
      // Truncate the replay buffer from the flashback point forward so future replays stay coherent
      rp.buffer.truncateAfter(rp.timeS);
      replayClockS = rp.timeS;
      lastReplayPushS = rp.timeS;
      rp.active = false;
      rp.focusedCarId = "player";
      replayLastFocusId = null;
      clearCameraOverride();
      cameraRig.reset();
      physics.aiAutopilot = false;
      // Release any held keys (e.g. F = Flashback & half throttle) so resuming driving has no throttle blip
      releaseHeldKeys();
      publishReplayUi();
      return true;
    };
    this.exitReplay = () => {
      if (!disposed) exitReplay();
    };
    this.openReplay = (opts) => openReplay(opts);
    this.flashbackReplay = () => (disposed ? false : flashbackReplay());
    this.toggleReplay = () => {
      if (disposed) return;
      if (replay.active) return exitReplay();
      openReplay({ fromStart: false, play: false });
    };

    this.resetRun = (reason) => {
      if (disposed) return;
      runId++;
      exitReplay();
      clearCameraOverride();
      replay.buffer.clear();
      replayNames.clear();
      if (this.snapshot.replayAvailable) this.publish({ replayAvailable: false });
      onRunReset(reason);
      jumpWatch.reset();
      reactionWatch.reset();
      startClutch.active = false;
      gridHeldLastFrame = false;
      startClutchIn = 0;
      kbInput.padClutch = 0;
      // Race control and the cameras start over with the run (the car is about to be put somewhere else)
      if (reason === "session") {
        mpPracticeBestMs = null;
        mpPracticeSeenLap = null;
      }
      // The car is repaired: practice's damage starts over, an online race's is handed to the car again next frame
      damageFeed.restart(physics.telemetry);
      physics.setDamageEffects?.(null);
      practiceDamage.reset();
      practiceWreckS = 0;
      trackLimits.reset(limitsSessionOf(raceNow()), limitsRulesOf(raceNow()));
      wallDeletedLaps.clear();
      cameraRig.reset();
      lapRecorder.reset();
      physics.aiAutopilot = false;
      physics.aiSpeedCapMs = Infinity;
      physics.aiLineBiasM = 0;
      kbInput.throttle = 0;
      kbInput.brake = 0;
      kbInput.clutch = 0;
      kbPedalAssist.reset();
    };
    this.replayTogglePlay = () => {
      if (!replay.playing) {
        if (replay.speed > 0 && replay.timeS >= replay.buffer.endS - 0.05) {
          replay.timeS = replay.buffer.startS;
          replay.prevTimeS = replay.timeS;
        } else if (replay.speed < 0 && replay.timeS <= replay.buffer.startS + 0.05) {
          replay.timeS = replay.buffer.endS;
          replay.prevTimeS = replay.timeS;
        }
      }
      replay.playing = !replay.playing;
      publishReplayUi();
    };
    this.replaySeek = (tS) => {
      replay.timeS = THREE.MathUtils.clamp(tS, replay.buffer.startS, replay.buffer.endS);
      publishReplayUi();
    };
    this.replaySpeed = (speed) => {
      replay.speed = speed;
      // Shuttle behavior: picking a playback speed while paused starts playing unless already pinned at that boundary
      if (!replay.playing && ((speed < 0 && replay.timeS > replay.buffer.startS + 0.05) || (speed > 0 && replay.timeS < replay.buffer.endS - 0.05))) {
        replay.playing = true;
      }
      publishReplayUi();
    };
    this.replayStepFrame = (dir) => {
      if (!replay.active) return;
      replay.playing = false;
      replay.timeS = THREE.MathUtils.clamp(replay.timeS + dir / REPLAY_HZ, replay.buffer.startS, replay.buffer.endS);
      publishReplayUi();
    };
    this.replayFocusCar = (carId) => {
      if (!replay.active || replay.focusedCarId === carId) return;
      if (!replay.cars.some((c) => c.id === carId)) return;
      replay.focusedCarId = carId;
      cameraRig.reset();
      publishReplayUi();
    };
    this.replayCycleCar = (dir) => {
      if (!replay.active || replay.cars.length <= 1) return;
      const idx = Math.max(0, replay.cars.findIndex((c) => c.id === replay.focusedCarId));
      const next = replay.cars[(idx + dir + replay.cars.length) % replay.cars.length];
      if (next) this.replayFocusCar(next.id);
    };

    // Horizon-Stabilized Sim Camera State
    /** The player car drawn at the frame time (its physics pose carried forward by the unstepped remainder) */
    const renderCarPos = new THREE.Vector3();
    /** The player car's tyres on its ground, at the pose it is drawn at (refreshed in place every frame) */
    const playerWheels: WheelSeating = { ground: null, position: renderCarPos, quaternion: new THREE.Quaternion() };
    // Cockpit extras, created once the LC26 model has loaded: the wheel's LCD and the live wing mirrors
    let wheelDisplay: SteeringWheelDisplay | null = null;
    let wingMirrors: WingMirrors | null = null;
    /** The LC26 body the wheel display and mirrors above were built for */
    let lc26ExtrasFor: THREE.Object3D | null = null;
    // The AMG GT3 Evo body's dash screen, shift lights, mirrors and rear-view monitor, once its GLB has loaded
    let gt3Dash: Gt3DashDisplay | null = null;
    // A ported body's wheel screen and shift lights (the 496R's), once its GLB has loaded under the rig
    let portedDash: PortedWheelDash | null = null;
    let portedProbeFrame = 0;
    let cockpitProbeFrame = 0;
    const lapDelta = new LapDeltaTracker(track.totalLengthM);
    // Race control measures what a course cut saved against this: the best lap, else the car's own speed profile
    const stretchRefS = (fromM: number, toM: number): number | null => {
      const best = lapDelta.referenceGapS(fromM, toM, track.totalLengthM);
      if (best !== null) return best;
      const guide = physics.brakingGuide?.speedMs;
      return guide ? stretchTimeS(guide, track.totalLengthM, fromM, toM) : null;
    };
    // The dash view's placement and the player's moves of the onboard views
    const onboardViews = new OnboardViews();
    // Race control: judges every excursion past the track limits (see TrackLimitsMonitor); resetRun and setRace start
    // its session over
    const trackLimits = new TrackLimitsMonitor();
    /** Laps race control deleted for barrier contact: the lap card says so */
    const wallDeletedLaps = new Set<number>();
    /** The wheel went while it could not pause the game (menus, loading): it pauses once the car is driven again */
    let wheelLostPending = false;
    /** The player drove last frame: gyro steering takes its centre again when the car is handed back */
    let gyroWasDriving = false;
    /** The pause menu, the seat panel or a lost GPU context held the car last frame */
    let frozenLastFrame = false;
    const displayExtra: { deltaMs: number | null } = { deltaMs: null };
    // The view camera: every view's placement, the menus' orbit and the driver's neck; told to start over when the
    // run does and when the replay moves the drawn car
    const cameraRig = new CameraRig(camera, track);
    // The title screen left alone this long tours the circuit from the air (menu-aerial.ts); reduced motion holds one frame
    const menuIdle = new MenuIdleWatch(window);
    const reducedMotion = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    let aerialOverlayOff = false;
    // polish:B the podium shot takes the camera for a few seconds after a race; the drive's cameras start over after it
    const podium = new PodiumDirector(track, () => {
      cameraRig.reset();
      camera.layers.enable(OVERLAY_LAYER);
    });
    this.podium = podium;
    // Which drawn frames render the live mirrors (every second one, every one at a low frame rate)
    const mirrorClock = new MirrorClock();
    const deviceInput = new DeviceInputReader();
    /** Per-axle tyre slip read from the car's telemetry each frame, for the keyboard pedal help */
    const kbAxleSlip = createAxleSlipSample();
    // The other cars, heard where they are from the active camera
    const opponentAudio = new OpponentAudio();
    const opponentSound = (p: InterpolatedPeerState): CarSoundSource => carForVehicle(p.vehicle ?? "lc26").sound;
    const trackEnv = getTrackEnv();
    // Time of day / weather look: the sky follows the session's WeatherState at 10 Hz, the HUD badge at 2 Hz
    let lastSkyMs = -Infinity;
    let lastWeatherHudMs = -Infinity;
    let weatherHudKey = "";
    const skyConditions = { elevationDeg: 14, azimuthDeg: 127, cloud: 0, rain: 0, windVxMs: 0, windVzMs: 0 };
    // Each session's clouds come from a seed of their own, new whenever the weather's conditions change. Only the look
    // depends on it, so it stays on this client. `?cloudseed=N` fixes it (and logs the cloud types each one picks)
    const cloudSeedParam = new URLSearchParams(window.location.search).get("cloudseed");
    const fixedCloudSeed = cloudSeedParam !== null && Number.isFinite(Number(cloudSeedParam)) ? Math.floor(Number(cloudSeedParam)) : null;
    let cloudConditions: SessionConditions | null = null;
    if (cloudSeedParam !== null) {
      (window as unknown as { __lcCloudSeed?: (seed: number) => string[] }).__lcCloudSeed = (seed) => {
        env.setCloudSeed(seed);
        env.setConditions(skyConditions);
        return env.cloudTypes;
      };
    }
    const rainCamPos = new THREE.Vector3();
    const rainCamPrev = new THREE.Vector3();
    const rainCamVel = new THREE.Vector3();
    const soloCars: SimulatorCar[] = [];
    const remoteWake: WakeEmitterCar[] = [];
    /** Other players on this circuit last frame (a room's lobby included): the mirror's auto mode shows for them */
    let peersOnTrack = 0;
    const ghostPos = new THREE.Vector3();
    const guardSelf: GuardBody = { x: 0, z: 0, vx: 0, vz: 0 };
    const guardOther: GuardBody = { x: 0, z: 0, vx: 0, vz: 0 };
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
    const carVelWorldScratch = new THREE.Vector3();
    const telemetryPeersScratch: NonNullable<CarTelemetry["peers"]> = [];

    // Loading: once both GLBs have settled (loaded or given up), compile every shader before the
    // first frame is drawn, then let the loading screen offer to continue
    const loadStartMs = performance.now();
    let warmupStarted = false;
    /** The warm-up has let the loading screen go: done, failed, or given up on by the watchdog */
    let warmupSettled = false;
    const settleWarmup = () => {
      if (warmupSettled || disposed) return;
      warmupSettled = true;
      setAssetsReady(true);
      // The loading's GPU work is done: the physical sky may start its precompute (Medium and High)
      if (!gpuLost) {
        env.startPhysicalSky();
        this.applyGraphics();
      }
    };
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
        // No context to compile on: the circuit loads again on a new one (a compile started on a lost context polls
        // for programs that never finish)
        if (disposed || gpuLost) return;
        // The scene is drawn into the composer's half-float target (no tone mapping, linear output), and three keys
        // its programs on the bound target: compiled with none bound, every shader would be the wrong variant and
        // recompile on the first frame after the player presses start. The program build runs synchronously inside
        // compileAsync, so the target only has to be bound for the call itself.
        let compiled: Promise<unknown>;
        try {
          compiled = compileForComposer();
        } catch (err) {
          compiled = Promise.reject(err);
        }
        compiled
          .then(
            async () => {
              // Given up on already: the first frames compile what is left
              if (disposed || warmupSettled || gpuLost) return;
              await warmUpGpu();
              if (disposed) return;
              visualFx.hidePrewarmed();
              assetProgress.done("shaders");
            },
            (err) => {
              console.warn("Shader warm-up failed (the first frames will compile instead)", err);
              assetProgress.fail("shaders");
            }
          )
          .finally(settleWarmup);
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
     * Behind the opaque loading screen: upload the textures of everything shown, give the reflection probe its first
     * turn, then draw one full frame through the composer, so the shadow-map and post-processing programs and every
     * vertex buffer are ready before the first visible frame instead of stalling it. Handed to the GPU in pieces, each
     * finished before the next goes (gpu-pace.ts): the textures in runs of WARMUP_UPLOAD_BYTES, then the probe, then
     * the frame. The probe and the frame have frustum culling off, the whole circuit at once, except on a gentle start:
     * there they draw what the camera sees, the frame in parts of a few materials each, and the rest comes in as it
     * shows. It stops where it is once the session goes, the context is lost or the loading screen was let go anyway.
     */
    const warmUpGpu = async (): Promise<void> => {
      const t0 = performance.now();
      const gl = renderer.getContext();
      const stop = () => disposed || gpuLost || warmupSettled;
      const textures = new Set<THREE.Texture>();
      // What this frame draws: a hidden object (or one under a hidden parent) is left for the frame that shows it,
      // rather than putting its textures on the GPU for nothing
      scene.traverseVisible((o) => {
        const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) {
          for (const v of Object.values(m)) if (v instanceof THREE.Texture) textures.add(v);
        }
      });
      /** Runs `draw` with every shown object's frustum culling off (not on a gentle start) */
      const unculled = (draw: () => void) => {
        const objects: THREE.Object3D[] = [];
        if (!gentle) {
          scene.traverseVisible((o) => {
            if (!o.frustumCulled) return;
            o.frustumCulled = false;
            objects.push(o);
          });
        }
        try {
          draw();
        } finally {
          for (const o of objects) o.frustumCulled = true;
        }
      };
      const slices = slicesByBytes([...textures], textureBytes, gentle ? WARMUP_UPLOAD_BYTES_GENTLE : WARMUP_UPLOAD_BYTES);
      let step = "textures";
      try {
        for (const slice of slices) {
          if (stop()) return;
          for (const tex of slice) renderer.initTexture(tex);
          await gpuFinished(gl);
        }
        if (stop()) return;
        // The reflection probe's first full turn and prefilter: their programs differ from the main view's (another
        // target), so they compile here, not on lap one
        step = "probe";
        unculled(() => reflectionProbe.update(physics.worldPosition, carRig.root, scene.environmentIntensity));
        await gpuFinished(gl);
        if (stop()) return;
        // A gentle start draws the camera's view in parts first, each finished before the next: an object's first draw
        // with a material is the costly one (its shader specialised, its textures bound), so each part holds a few
        // materials' first draws at most rather than one submission holding them all
        if (gentle) {
          step = "parts";
          const drawn: THREE.Object3D[] = [];
          scene.traverseVisible((o) => {
            if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) drawn.push(o);
          });
          const materialsOf = (o: THREE.Object3D) => {
            const m = (o as THREE.Mesh).material;
            return Array.isArray(m) ? m : m ? [m] : [];
          };
          for (const run of partsByNewKeys(drawn, materialsOf, WARMUP_GENTLE_NEW_MATERIALS)) {
            if (stop()) return;
            const part = new Set(run);
            const hidden = drawn.filter((o) => !part.has(o));
            for (const o of hidden) o.visible = false;
            const prevTarget = renderer.getRenderTarget();
            try {
              renderer.setRenderTarget(postFx.composer.inputBuffer);
              renderer.render(scene, camera);
            } finally {
              renderer.setRenderTarget(prevTarget);
              for (const o of hidden) o.visible = true;
            }
            await gpuFinished(gl);
          }
          if (stop()) return;
        }
        step = "frame";
        unculled(() => postFx.render(0));
        await gpuFinished(gl);
      } catch (err) {
        console.warn(`GPU warm-up failed at the ${step} (the first frames will do it instead)`, err);
      }
      if (process.env.NODE_ENV !== "production") {
        console.info(
          `[load] GPU warm-up: ${textures.size} textures in ${slices.length} run(s)${gentle ? ", camera's view only" : ""}, ${(performance.now() - t0).toFixed(0)} ms`
        );
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
      // A shader compile that never finishes (a lost GPU context polls forever) has been given up on: continue anyway
      if (warmupStarted && assetProgress.get().tasks.some((t) => t.id === "shaders" && t.status === "failed")) settleWarmup();
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
      displayRate.add(nowMs - lastTimeMs);
      lastTimeMs = nowMs;
      frameWallMs = performance.timeOrigin + nowMs;
      // The frame-rate cap: this frame draws, or only runs input, the simulation, the network and the laps. The
      // drawing catches up with the time since the last drawn frame. Never in a headset, which sets its own rate. With
      // the GPU context lost nothing is drawn at all.
      const draw = !gpuLost && (renderer.xr.isPresenting || pacer.shouldDraw(nowMs));
      pendingDrawS += dtSeconds;
      const drawDtS = draw ? pendingDrawS : 0;
      const drawIntervalMs = draw ? nowMs - lastDrawMs : 0;
      if (draw) {
        pendingDrawS = 0;
        lastDrawMs = nowMs;
      }
      if (appPhaseNow === "driving" && draw) startupMonitor?.frame(nowMs);

      // Optional Gamepad / Sim Racing Wheel Polling. Controllers with the standard mapping (Xbox,
      // DualShock, DualSense …) send the raw thumbstick through the physics' gamepad steering
      // assist every frame (also when centred: it self-aligns); other devices (wheels) drive the
      // rack directly.
      // Read every frame (also in menus / paused) so button edges never fire on a stale press
      const pads = connectedPads();
      // Gyro steering: the DualSense's or DualShock 4's lean, tracked at the pad's own report rate (gyro-source.ts). The
      // reader asks for the pad that steers, which gets its own lean, never another Sony pad's
      const gyroSettings = settings.dualSense;
      gyroSource.setMotionWanted(gyroSettings.gyroSteer);
      const gyroSteer = gyroSettings.gyroSteer
        ? (padId: string) => {
            const deg = gyroSource.steerDeg(padId);
            return deg === null ? undefined : gyroSteerValue(deg, gyroSettings.gyroLockDeg, gyroSettings.gyroSensitivity);
          }
        : undefined;
      const device = deviceInput.read(pads, settings, dtSeconds, vehicleNow, gyroSteer);
      const appPhase = appPhaseNow;
      const inMenu = appPhase !== "driving";
      // Only the title screen counts its idle time: back on it from anywhere else, the clock starts over
      const menuIdleMs = menuIdle.idleMs(nowMs, pads);
      if (appPhase !== "title") menuIdle.reset(nowMs);
      // Never in a headset: a climb of a hundred metres is no backdrop there
      const menuAerial = appPhase === "title" && menuIdleMs >= AERIAL_IDLE_MS && !renderer.xr.isPresenting;
      const rp = replay;
      if (rp.active && inMenu) exitReplay();
      const replaying = rp.active;
      const settingsNow = settings;
      // Off behind the title menu and the setup screens (racingLineShown); the player's setting is left as it is
      builtCircuit.racingLineMesh.visible = racingLineShown(settingsNow.racingLine);
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
        setPauseNotice(tx("game.session.wheelDisconnected"));
      }
      // The pause menu, the seat panel or a lost GPU context: the car waits
      const frozen = this.snapshot.paused || this.snapshot.seatPanel || gpuLost;
      const driving = !inMenu && !frozen && !replaying && !device.wheelLost;
      // Handed back: the driving keys still down hold from this frame, not from the browser's first key repeat
      if (frozenLastFrame && !frozen && driving && !podium.playing) restoreHeldKeys();
      frozenLastFrame = frozen;
      const freeCamControl = !inMenu && !frozen && !podium.playing && !renderer.xr.isPresenting && cameraOverride === "free";
      wakeLock.setDesired(driving);
      const padTuning = settingsNow.padTuning;
      const kbTuning = settingsNow.keyboardTuning;
      const isPad = device.source === "controller";
      const gamepadThrottle = driving && !freeCamControl ? (isPad ? Math.pow(device.throttle, padTuning.throttleGamma) : device.throttle) : 0;
      const gamepadBrake = driving && !freeCamControl ? (isPad ? Math.pow(device.brake, padTuning.brakeGamma) : device.brake) : 0;
      const gamepadSteer = freeCamControl ? undefined : device.analogSteer;
      // The whole curve the setup screen previews (inner and outer dead zone, then linearity), here once: the assist
      // used to apply the inner dead zone after the curve, and without the assist it was never applied
      const padStick =
        freeCamControl || device.padSteer === undefined
          ? undefined
          : shapeStick(device.padSteer, padTuning.deadzone, padTuning.outerDeadzone, padTuning.linearity);
      // The gyro steers only while driving, added to the stick so either one (or both) steers through the same assist.
      // The pad's lean as the car is handed back (the start, unpausing, the seat panel closed) is straight ahead
      if (driving && !gyroWasDriving) gyroSource.recentre();
      const gyroStick = driving && !freeCamControl && gyroWasDriving ? device.gyroSteer : undefined;
      gyroWasDriving = driving;
      const gamepadStick = padStick === undefined ? undefined : combineStickAndGyro(padStick, gyroStick);
      const gamepadBoost = driving && !freeCamControl && device.boostHeld;
      // With the GPU lost the notice over the game has the buttons: the pad's Menu must not open the pause menu under it
      let lightsPressed = false;
      if (!inMenu && !gpuLost) {
        for (const action of device.pressed) {
          // polish:B any pad button skips the podium shot
          if (podium.playing) {
            podium.skip();
            break;
          }
          if (action === "pause") {
            // The seat panel's Menu closes it (its own buttons are read by SeatPanel.tsx)
            if (this.snapshot.seatPanel) this.closeSeatPanel();
            // Opening only: in the pause menu, B / Menu resume through the menu's own navigation
            else if (!this.snapshot.paused) this.togglePause();
            continue;
          }
          if (!driving) continue;
          // The camera button, like the key: a tap changes the view on release, held it opens the seat panel
          if (action === "camera") {
            padCameraHeldSinceMs = nowMs;
            continue;
          }
          // The headlight button carries both jobs (headlight-button.ts): a tap flashes, a hold switches the lights
          if (action === "headlights") {
            lightsPressed = true;
            continue;
          }
          // Boost and the flash act while held (`boostHeld`, `device.held`); the MFD and HUD buttons go to the HUD
          if (action !== "boost" && action !== "headlightFlash") runAction(action);
        }

        if (padCameraHeldSinceMs !== null) {
          if (!driving) padCameraHeldSinceMs = null;
          else if (!device.held?.has("camera")) {
            padCameraHeldSinceMs = null;
            cycleCamera();
          } else if (nowMs - padCameraHeldSinceMs >= SEAT_PANEL_HOLD_MS) {
            padCameraHeldSinceMs = null;
            this.openSeatPanel();
          }
        }
      }

      // The flash: the high beam while the flash key or button is held, or the headlight button is still short of a
      // hold (which switches the lights instead); a tap still lights it for MIN_FLASH_MS
      const buttonsLive = driving && !inMenu && !gpuLost;
      const lightsButton = headlightButton.update(lightsPressed, device.held?.has("headlights") === true, nowMs, buttonsLive);
      if (lightsButton.toggle) runAction("headlights");
      // (an F1 car has no headlights to flash)
      const flashing = flashTimer.update(
        heldKeys.headlightFlash || device.held?.has("headlightFlash") === true || lightsButton.flash,
        nowMs,
        driving && carHasHeadlights(carRigCar)
      );
      if (flashing !== playerFlashing) {
        playerFlashing = flashing;
        // the HUD's headlight mark shows the flash at once
        lastWeatherHudMs = -Infinity;
      }

      // Keyboard-only input shaping: keys become ramped pedals, eased back while the tyres pass their grip when the
      // car's ABS / traction control is off. The steering keys' direction goes to the car's steering assist, which
      // ramps it to the front tyres' grip limit, self-aligns the car when they are let go and caps a countersteer.
      // Digital touch buttons (Touch style = Buttons) share this ramped/assisted path so tapping buttons feels smooth.
      // Wheel and mouse inputs are passed through untouched.
      const keys = heldKeys;
      const kb = kbInput;
      const touch = touchInput.active && driving && !freeCamControl ? touchInput : null;
      // Half-throttle key: a fixed part throttle for wet-like traction or slow corners
      const kbThrottleTarget = keys.up || touch?.throttleBtn ? 1 : keys.half ? kbTuning.halfThrottle : 0;
      const throttleRising = kbThrottleTarget > kb.throttle;
      kb.throttle = approach(
        kb.throttle,
        kbThrottleTarget,
        dtSeconds / (throttleRising ? kbTuning.throttleRiseS || KB_THROTTLE_RISE_S : KB_THROTTLE_FALL_S)
      );
      // Half-brake key: a fixed part brake, for trail braking or a light lift
      const kbBrakeTarget = keys.down || touch?.brakeBtn ? 1 : keys.halfBrake ? kbTuning.halfBrake : 0;
      const brakeRising = kbBrakeTarget > kb.brake;
      kb.brake = approach(
        kb.brake,
        kbBrakeTarget,
        dtSeconds / (brakeRising ? kbTuning.brakeRiseS || KB_BRAKE_RISE_S : KB_BRAKE_FALL_S)
      );
      kb.clutch = approach(kb.clutch, keys.clutch ? 1 : 0, dtSeconds / (keys.clutch ? KB_CLUTCH_IN_S : KB_CLUTCH_OUT_S));
      // What drives the car this frame (also checked before clutch resolution so an idle plugged-in gamepad never
      // disables a keyboard player's manual clutch, while actually driving on the pad switches to pad clutch rules)
      if (settingsNow.device !== prevSettingsDevice) {
        prevSettingsDevice = settingsNow.device;
        lastDrivingInput = null;
      }
      if (
        (lastDrivingInput === "touch" && !touchInput.active) ||
        ((lastDrivingInput === "controller" || lastDrivingInput === "wheel") && device.source === null)
      ) {
        lastDrivingInput = null;
      }
      const wheelClutchBound = settingsNow.wheel.clutch !== null && device.wheelClutchConnected === true;
      const legacyAsWheel = device.source === "legacy" && (settingsNow.device === "wheel" || wheelClutchBound);
      const inputNow = drivingInputOf({
        touch,
        source: device.source,
        mouseSteer: settings.mouseSteer,
        keys: keys.left || keys.right || keys.up || keys.down || keys.half || keys.halfBrake,
        pad: { throttle: gamepadThrottle, brake: gamepadBrake, steer: gamepadStick ?? gamepadSteer ?? 0 },
        setting: legacyAsWheel ? "wheel" : settingsNow.device,
      });
      if (driving) {
        if (inputNow) {
          lastDrivingInput = inputNow;
          noteDrivingInput(inputNow);
        } else if (keys.clutch || heldKeys.gearUpHeld) {
          lastDrivingInput = "keyboard";
        } else if (
          device.source !== null &&
          (device.clutch > 0.05 || (device.held?.size ?? 0) > 0)
        ) {
          lastDrivingInput = device.source === "wheel" || legacyAsWheel ? "wheel" : "controller";
        }
      }
      // A manual start with no clutch bound: Gear up is the clutch from the lights until it is let go after them, as in
      // the F1 games, and its presses are not shifts meanwhile
      const padClutchSource = settingsNow.padTuning.pedalSources.clutch;
      const { bound: clutchBound, control: boundClutchControl, activeDevice: activeClutchDevice } =
        resolveActiveClutchBinding({
          deviceSource: device.source,
          touchActive: touchInput.active,
          keyClutchCodes: settingsNow.keys.clutch,
          padClutchSource,
          wheelClutchBound,
          settingsDevice: settingsNow.device,
          lastDrivingInput,
        });
      if (gridHeldLastFrame && !clutchBound) startClutch.active = true;
      // What the start cue (and stall recovery banner) tells the player to hold
      const padGearUp = settingsNow.padButtons.shiftUp;
      const startClutchControl: StartClutchControl =
        boundClutchControl ??
        (activeClutchDevice === "controller"
          ? padGearUp !== null
            ? { pad: padGearUp }
            : { name: startClutchNames().gearUp }
          : activeClutchDevice === "wheel"
            ? { name: startClutchNames().paddle }
            : { key: keyLabel(settingsNow.keys.shiftUp[0]) });
      const gearUpHeld = heldKeys.gearUpHeld || device.held?.has("shiftUp") === true;
      // A button as the clutch (a controller button other than a trigger, Gear up at a start) presses at once and lets
      // out over the key clutch's time: letting go slips the clutch, it does not dump it
      const digitalPadClutch =
        activeClutchDevice === "controller" &&
        device.source === "controller" &&
        padClutchSource?.kind === "button" &&
        padClutchSource.button !== PAD_THROTTLE_BUTTON &&
        padClutchSource.button !== PAD_BRAKE_BUTTON;
      const buttonClutchTarget = startClutch.active ? (gearUpHeld ? 1 : 0) : digitalPadClutch ? device.clutch : null;
      kb.padClutch =
        buttonClutchTarget === null
          ? 0
          : approach(kb.padClutch, buttonClutchTarget, dtSeconds / (buttonClutchTarget > kb.padClutch ? KB_CLUTCH_IN_S : KB_CLUTCH_OUT_S));
      if (startClutch.active && !gridHeldLastFrame && !gearUpHeld && kb.padClutch === 0) startClutch.active = false;
      // The clutch pedal from the key, a controller or the wheel's pedal set; none bound leaves the car's own clutch
      const clutchPedal = driving ? Math.max(kb.clutch, buttonClutchTarget === null ? device.clutch : kb.padClutch) : 0;
      const carAids = physics.telemetry.liveTuner;
      const tyreSlip = axleSlipFromTelemetry(physics.telemetry, kbAxleSlip);
      const kbBrakeScale = kbPedalAssist.brakeScale(
        kbBrakeTarget > 0,
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
      const kbSteerDir = (keys.right || touch?.steerRight ? 1 : 0) - (keys.left || touch?.steerLeft ? 1 : 0);
      // On-screen controls: sliders, four hold buttons, or device tilt. Digital touch buttons steer via `kbSteer`
      // (speed-sensitive steering assist) instead of `analogSteer`, so `touchSteering` is only active when an analogue
      // steering control (slider or ready device tilt) owns `touch.steer` — including when tilt falls back to buttons.
      const touchSteering =
        touch !== null &&
        touch.analogSteerActive &&
        !touch.steerLeft &&
        !touch.steerRight &&
        ((gamepadStick === undefined && gamepadSteer === undefined) || Math.abs(touch.steer) > 0.01);
      if (touchInput.active) {
        if (driving) {
          if (touchInput.shiftUp) runAction("shiftUp");
          if (touchInput.shiftDown) runAction("shiftDown");
          if (touchInput.aero) runAction("aero");
          if (touchInput.boost) runAction("boostLatch");
          if (touchInput.overtake) runAction("overtake");
        }
        touchInput.shiftUp = touchInput.shiftDown = touchInput.aero = touchInput.boost = touchInput.overtake = false;
      }
      // Wheel, mouse and touch steer the rack directly; the car's steering assist picks between them, the keys and the
      // stick (steering-assist.ts: a pressed key takes over, and hands back once its ramp is at centre)
      const directSteer = freeCamControl
        ? undefined
        : settings.mouseSteer
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
        overtake: heldKeys.overtake,
        toggleXMode: heldKeys.toggleX,
        shiftUp: heldKeys.shiftUp && !startClutch.active,
        shiftDown: heldKeys.shiftDown,
        neutral: heldKeys.neutral,
        clutchBound,
        ...(clutchPedal > 0 ? { clutch: clutchPedal } : {}),
      };
      heldKeys.toggleX = false;
      heldKeys.overtake = false;
      heldKeys.shiftUp = false;
      heldKeys.shiftDown = false;
      heldKeys.neutral = false;
      // The driver takes the car back from the autopilot with any device (the keys do it on key down): a pedal, the
      // stick, the touch steering pad or touch buttons. Not the wheel's rim, which its force feedback turns on its own.
      if (driving && physics.aiAutopilot && !coolDown.active) {
        const pedal = Math.max(gamepadThrottle, gamepadBrake, touch?.throttle ?? 0, touch?.brake ?? 0);
        // The stick alone: a pad held at a slant would otherwise hand the car back as soon as the autopilot took it
        const stick = Math.abs(padStick ?? 0);
        const touchSteer = touchSteering && !settingsNow.touch.tiltSteer ? Math.abs(touch.steer) : 0;
        const touchBtn = Boolean(touch?.throttleBtn || touch?.brakeBtn || touch?.steerLeft || touch?.steerRight);
        if (pedal > 0.15 || stick > 0.3 || touchSteer > 0.2 || touchBtn) physics.aiAutopilot = false;
      }

      // The AI field holds the player on the grid until the lights go out, then runs its cars
      if (aiFieldOf(raceNow())?.worker?.failed) {
        // The worker stopped mid-race: the race starts over from the lights on the page, which drives the car now
        console.warn("[sim] the worker stopped: the race restarts on the page");
        const field = this.takeAiField();
        if (trackRoot) field.attachTrackRoot(trackRoot);
        this.setRace({ kind: "ai", field });
        startAiRace(field, settings.race, settings.profile);
      }
      const aiField = aiFieldOf(raceNow());
      /** The race runs in the worker, the player's car with it: this page only sends the controls and draws it */
      const raceInWorker = aiField?.worker !== undefined;
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
      // polish:B on the player's flag (last frame's status, of this run) the cool-down takes the car
      const coolStatus = physics.telemetry.runId === runId ? physics.telemetry.race : undefined;
      coolDown.update(
        physics,
        {
          finished: raceNow().kind !== "practice" && coolStatus?.phase === "finished",
          retired: coolStatus?.results?.find((r) => r.isPlayer)?.dnf === true,
          roadHalfWidthM: track.getSampleAtDistance(physics.sMeters).width / 2,
        },
        driving ? dtSeconds : 0
      );
      if (driving) {
        // The evolving road and the wake of the cars around: the player's car always, the AI field's too when racing,
        // with the remote players placed from last frame's interpolated poses
        soloCars[0] = physics;
        trackEnv.update(dtSeconds, aiField ? aiField.sims() : soloCars, remoteWake);
        holdTimeTrialFuel();
        // A 2026 F1 car's energy allowances: qualifying's in a time trial or a qualifying session, practice's otherwise
        // (a race's come from race control)
        const qualiEnergy = timeTrialOn() || quali !== null || multiplayerSync.activeQualifying !== null;
        if (energyHeld.car !== physics || energyHeld.quali !== qualiEnergy) {
          physics.setEnergySession?.(qualiEnergy);
          energyHeld = { car: physics, quali: qualiEnergy };
        }
        // The autopilot backs off for rain like the AI field does, from the car's own pace
        if (physics.aiPaceScale !== undefined) {
          const base = autopilotPace;
          if (base.car !== physics) autopilotPace = { car: physics, pace: physics.aiPaceScale };
          physics.aiPaceScale = autopilotPace.pace * (physics.aiAutopilot ? trackEnv.weatherPaceScale(physics) : 1) * coolDown.paceScale;
        }
        startupMonitor?.begin();
        const simStartMs = sessionPerf ? performance.now() : 0;
        // A manual start holds the car on the grid through the lights with its engine live (a race in the worker holds
        // its car there: the controls go on, which keep its clock running); an assisted one stops it
        // (not while an AI race's grid stands before its lights, after qualifying: the car waits still)
        const mpManualStart = mpRace
          ? mpRace.start.startType !== "rolling" && (mpRace.start.manualStart ?? settingsNow.race.launch === "manual")
          : false;
        const gridHeld = raceInWorker
          ? aiField.playerFrozen && aiField.manualStart && !aiField.gridStanding
          : (aiField?.playerFrozen === true && aiField.manualStart && !aiField.gridStanding) || (mpFrozen && mpManualStart);
        if (!raceInWorker) physics.gridHold = gridHeld;
        // A jump start: race control's call once the lights are out (+5 s, +10 s for a big one), into an AI race's
        // ledger and feed; an online race serves it with the player's own penalties below
        const startCall = jumpWatch.update(
          dtSeconds,
          gridHeld,
          physics.telemetry.speedMs,
          physics.telemetry.race?.position,
          physics.sMeters,
          track.totalLengthM
        );
        if (startCall === "jump") console.info(`[race] jump start`);
        if (startCall === "verdict") {
          console.info(`[race] jump start: +${jumpWatch.penaltyS} s at the flag`);
          aiField?.penalisePlayer(jumpWatch.penaltyS, "jump_start", jumpWatch.big ? tx("game.session.bigJumpStart") : tx("game.session.jumpStart"));
        }
        gridHeldLastFrame = gridHeld;
        startClutchIn = inputs.clutch ?? 0;
        if (raceInWorker || (!aiField?.playerFrozen && !mpFrozen) || gridHeld) physics.step(dtSeconds, coolDown.active ? coolDown.inputs() : inputs);
        aiField?.update(dtSeconds);
        if (sessionPerf) frameSimMs = performance.now() - simStartMs;
        startupMonitor?.end("sim");
        // A hill climb: off the end of its road, or stopped past the finish, the car goes back to the start line
        const p2p = track.pointToPoint;
        if (p2p && raceNow().kind === "practice") {
          runEnd.holdS = Math.max(0, runEnd.holdS - dtSeconds);
          const s = physics.sMeters;
          const pastFinish = s > p2p.finishS && s <= p2p.endS;
          runEnd.stoppedS = pastFinish && Math.abs(physics.vxMs) < 1 ? runEnd.stoppedS + dtSeconds : 0;
          if (runEnd.holdS === 0 && (inDeadZone(p2p, s) || runEnd.stoppedS > 2)) {
            runEnd.stoppedS = 0;
            runEnd.holdS = 1;
            queueMicrotask(() => this.restartFlyingLap());
          }
        }
      }
      // The worker drives the car in practice and in an AI race it runs; another race steps it here, with the field
      // around it
      if (simHost) {
        const was = simHost.remote;
        // Not with a steering wheel yet: its force feedback is still sent from the page, a frame at a time (a race
        // that started in the worker stays there)
        simHost.endFrame(raceInWorker || (raceNow().kind === "practice" && settingsNow.device !== "wheel"));
        if (simHost.remote !== was) console.info(simHost.remote ? "[sim] the worker drives the car" : "[sim] the page drives the car");
      }
      if (mpRace && mpFrame && mpFrame.phase === "racing" && !frozen) {
        mpRace.lapClock.update(physics.sMeters, mpFrame.raceTimeS, mpRace.start.laps, mpRace.flagOut);
      }
      // With the pedals off the triggers (stick pedals) they shift gears: no ABS or wheelspin in them, no brake-pedal
      // resistance in L2
      const triggerPedals = pedalsOnTriggers(padTuning.pedalSources);
      haptics.update(physics.telemetry, dtSeconds, rumbleEnabled && driving, {
        triggerRumble: padTuning.triggerRumble && triggerPedals,
        triggerSlipAlwaysOn: padTuning.triggerSlipAlwaysOn,
        skipPad: ownedByDualSense,
      });
      dualSense.update(physics.telemetry, dtSeconds, {
        driving,
        rumbleOn: rumbleEnabled,
        settings: settingsNow.dualSense,
        triggerSlipAlwaysOn: padTuning.triggerSlipAlwaysOn,
        triggerPedals,
        driverColor: settingsNow.profile.color,
        vehicle: vehicleNow,
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
      // The reaction to the lights: from the frame they go out, as this frame's status has it (a rolling start has none)
      {
        const status = physics.telemetry.race;
        reactionWatch.update(
          driving ? dtSeconds : 0,
          status?.phase === "lights" && !status.rollingFormation,
          gridHeldLastFrame,
          inputs.throttle,
          inputs.clutch ?? 0
        );
        // A jump start has no reaction to show (a clutch let out and pressed again before the lights went out)
        physics.telemetry.startReactionMs = jumpWatch.jumped ? undefined : (reactionWatch.ms ?? undefined);
      }
      // Qualifying: the clock, the reference lap behind it, and the race once the session is over
      if (quali && driving) {
        const t = physics.telemetry;
        stepQualifyingRef(QUALI_REF_BUDGET_MS);
        const state = quali.session.update(dtSeconds, {
          lapCount: t.lapCount,
          lastLapTimeMs: t.lastLapTimeMs ?? null,
          lastLapValid: t.lastLapValid !== false,
          currentLapTimeMs: t.currentLapTimeMs,
          lapInvalid: t.lapInvalid === true,
          autopilot: physics.aiAutopilot,
        });
        if (state === "done") finishQualifying();
      }
      const mpQualiLobbyTrack = multiplayerSync.lobby?.settings.trackId;
      const mpQuali =
        !mpRace && !aiField && !quali && (!mpQualiLobbyTrack || mpQualiLobbyTrack === trackId)
          ? multiplayerSync.activeQualifying
          : null;
      if (mpQuali) {
        const t = physics.telemetry;
        if (mpQualiId !== mpQuali.id) {
          mpQualiId = mpQuali.id;
          mpQualiBestMs = null;
          mpQualiSeenLap = t.lapCount;
        }
        if (
          driving &&
          mpQualiSeenLap !== null &&
          t.lapCount > mpQualiSeenLap &&
          t.lastLapTimeMs !== null &&
          t.lastLapTimeMs !== undefined &&
          t.lastLapTimeMs >= MIN_QUALIFYING_LAP_MS &&
          t.lastLapValid !== false &&
          !physics.aiAutopilot
        ) {
          const lapMs = Math.round(t.lastLapTimeMs);
          if (mpQualiBestMs === null || lapMs < mpQualiBestMs) {
            mpQualiBestMs = lapMs;
            multiplayerSync.reportQualifyingLap(mpQualiBestMs);
          }
        }
        mpQualiSeenLap = t.lapCount;
      } else {
        mpQualiId = null;
        mpQualiBestMs = null;
        mpQualiSeenLap = null;
        if (driving && !mpRace && !aiField && !quali) {
          const t = physics.telemetry;
          if (
            mpPracticeSeenLap !== null &&
            t.lapCount > mpPracticeSeenLap &&
            t.lastLapTimeMs !== null &&
            t.lastLapTimeMs !== undefined &&
            t.lastLapTimeMs >= 1000 &&
            t.lastLapValid !== false &&
            !physics.aiAutopilot
          ) {
            const lapMs = Math.round(t.lastLapTimeMs);
            if (mpPracticeBestMs === null || lapMs < mpPracticeBestMs) mpPracticeBestMs = lapMs;
          }
          mpPracticeSeenLap = t.lapCount;
        }
      }
      physics.telemetry.timeTrial = timeTrialOn() || undefined;
      physics.telemetry.drivingInput = lastDrivingInput ?? undefined;
      physics.telemetry.qualifying = quali
        ? {
            remainingS: quali.session.remainingS,
            lastLap: quali.session.state === "last_lap",
            lapCounts: quali.session.lapCounts,
            bestMs: quali.session.bestMs,
          }
        : mpQuali
          ? {
              remainingS:
                mpQuali.endsAtHostMs !== undefined
                  ? Math.max(0, (mpQuali.endsAtHostMs - multiplayerSync.hostNowMs(nowMs)) / 1000)
                  : 0,
              lastLap: false,
              lapCounts: physics.telemetry.lapInvalid !== true && !physics.aiAutopilot,
              bestMs: mpQualiBestMs,
            }
          : undefined;
      physics.telemetry.runId = runId;
      physics.telemetry.clutchControl = boundClutchControl;
      // The manual start's cue: what to hold as the clutch, and a jump start once there is one
      physics.telemetry.start =
        gridHeldLastFrame || jumpWatch.jumped || startClutch.active
          ? { held: gridHeldLastFrame, jumped: jumpWatch.jumped, penaltyS: jumpWatch.penaltyS, clutch: startClutchControl, clutchIn: startClutchIn }
          : undefined;

      // Track limits: in a race, race control judges each excursion once the car is back on the asphalt (warnings,
      // and every third one is a time penalty served at the flag). Any other driving is strict: off is a deleted lap.
      {
        const t = physics.telemetry;
        const raceNow = t.race;
        physics.trackLimitsMode = trackLimits.mode === "race" ? "judged" : "strict";
        if (driving) {
          const here = track.getSampleAtDistance(physics.sMeters);
          const tlEvent = trackLimits.update({
            nowMs,
            dtS: dtSeconds,
            lapCount: t.lapCount,
            lapTimeMs: t.currentLapTimeMs,
            sector: t.currentSector,
            distM: t.trackDistanceM,
            lapLengthM: track.totalLengthM,
            stretchRefS,
            offTrack: t.offTrack,
            throttle: t.throttle,
            brake: t.brake,
            lateralM: physics.lateralOffsetM,
            curvature: here.curvature,
            halfWidthM: here.width / 2,
            deltaS: lapDelta.delta(t),
            racePosition: raceNow?.position,
            speedMs: physics.vxMs,
            posX: physics.worldPosition.x,
            posZ: physics.worldPosition.z,
            active: !physics.aiAutopilot && !mpFrozen && raceNow?.phase !== "lights" && raceNow?.phase !== "finished",
            // Barriers: a hill climb's run is done on any touch (judged up to its finish line), a circuit's lap only by
            // riding the wall
            wallContactS: t.f12026?.wallContactS,
            wallRule: !track.pointToPoint
              ? "ride"
              : physics.sMeters > track.pointToPoint.finishS && physics.sMeters <= track.pointToPoint.endS
                ? undefined
                : "touch",
          });
          // A strike also deletes the lap time (it never counts as a best lap)
          if (tlEvent && tlEvent.kind !== "cleared" && tlEvent.kind !== "no_advantage" && tlEvent.lap === t.lapCount) {
            physics.invalidateLap?.();
            if (tlEvent.reason === "wall_contact") wallDeletedLaps.add(tlEvent.lap);
          }
        }
        physics.trackLimitsHold = trackLimits.judging;
        // The player's own calls, served at the flag: track limits, and online a jump start too (in an AI race race
        // control's calls, a jump start and a pass under yellow among them, are in the field's ledger)
        const startPenaltyS = jumpWatch.penaltyS;
        if (aiField) {
          aiField.lockAidsInYellow = aidsLockInYellow;
          aiField.playerPenaltyS = trackLimits.penaltyTotalS;
          if (trackLimits.disqualified) aiField.playerDisqualified = true;
        }
        if (mpRace) {
          const penaltiesOn = mpRace.start.rules?.penalties !== false;
          mpRace.penaltyS = penaltiesOn ? trackLimits.penaltyTotalS + startPenaltyS : 0;
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
      if (driving && !aiField && !mpRace && !quali) {
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
              trackId,
            }),
            autopilot: physics.aiAutopilot,
          },
          input: inputNow,
        });
        if (done) {
          if (!done.summary.valid && wallDeletedLaps.has(done.summary.lapNumber)) done.summary.wallContact = true;
          for (const lap of wallDeletedLaps) if (lap <= done.summary.lapNumber) wallDeletedLaps.delete(lap);
          // Omit fuel load (stint / time-trial strategy) so applying another player's lap setup never strands a receiver on low fuel
          done.recording.setup = buildSharedSetup({
            vehicle: vehicleNow,
            chassis: { ...this.snapshot.chassisSetup, fuelDeltaKg: 0 },
            tyre: this.snapshot.tyreSetup,
            compound: this.snapshot.tireCompound,
            aero: physics.aeroPreset,
            tuner: garageTunerFrom(physics.telemetry.liveTuner),
          });
          for (const listener of lapListeners) listener(done.summary, done.recording);
        }
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
        ? carVelWorldScratch.copy(physics.worldVelocity)
        : carVelWorldScratch.set(physics.vyMs, 0, physics.vxMs).applyQuaternion(physics.worldQuaternion);
      // An open race's fair-play rule: this car judges itself a hazard and says so with its state
      const guard = mpRace && mpFrame?.phase === "racing" ? mpRace.guard : null;
      guard?.self.update(dtSeconds, {
        speedMs: physics.telemetry.speedKmh / 3.6,
        trackS: physics.sMeters,
        lapLengthM: track.totalLengthM,
        offTrack: physics.telemetry.offTrack,
      });
      // With the GPU lost no state goes out: the others see this car go, not parked where it stopped
      const interpolatedPeers = multiplayerSync.update(
        nowMs,
        gpuLost ? null : {
          driverCode: settingsNow.profile.code,
          teamColorHex: settingsNow.profile.color,
          liveryId: settingsNow.liveryId,
          ...(settingsNow.liveryId === "custom" ? { customLivery: settingsNow.customLivery } : {}),
          name: settingsNow.profile.name,
          race: mpRace
            ? mpRace.progress()
            : mpQuali
              ? { id: mpQuali.id, dist: Math.round(physics.sMeters * 10) / 10, fin: null, best: mpQualiBestMs, cmp: physics.tireCompound }
              : multiplayerSync.lobby
                ? { id: "practice", dist: Math.round(physics.sMeters * 10) / 10, fin: null, best: mpPracticeBestMs, cmp: physics.tireCompound }
                : undefined,
          hz: guard?.self.flag || undefined,
          fl: playerFlashing || undefined,
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
      latestRemotePeers = samePeers;
      peersOnTrack = samePeers.length;
      // On the lap where they are drawn, not where their newest packet put them (the tower, the relative, the gaps)
      placePeersWhereDrawn(samePeers, track.projectWorldToTrack, track.totalLengthM);
      peerWakeEmitters(track, samePeers, remoteWake);
      if (mpRace && mpFrame) {
        mpRace.ingestPeers(samePeers, mpFrame.phase === "racing" ? mpFrame.raceTimeS : 0);
        // Contact with the other players (one-sided: each client resolves its own car)
        guardSelf.x = physics.worldPosition.x;
        guardSelf.z = physics.worldPosition.z;
        guardSelf.vx = carVelocityWorld.x;
        guardSelf.vz = carVelocityWorld.z;
        for (const p of samePeers) {
          let solid = !p.isAiPeer && p.race?.id === mpRace.start.id && mpRace.collisionsActiveWith(mpFrame, p.peerId);
          let through = false;
          if (guard && solid) {
            guardOther.x = p.position.x;
            guardOther.z = p.position.z;
            guardOther.vx = p.linearVelocity.x;
            guardOther.vz = p.linearVelocity.z;
            solid = !guard.blocks(p.peerId, guardSelf, guardOther, p.hazard === true);
            through = p.hazard === true || guard.rammed(p.peerId);
          }
          // polish:B a car that has taken the flag passes through (collisionsActiveWith), drawn as a ghost
          if (mpFrame.phase === "racing" && p.race?.id === mpRace.start.id && (mpRace.lapClock.finishTimeS !== null || p.race.fin !== null)) through = true;
          p.passThrough = through;
          if (driving && solid) {
            const hit = resolvePlayerVsRemoteCar(physics, p, dtSeconds);
            if (hit && mpRace.damage && mpFrame.phase === "racing") {
              const closingMs = Math.hypot(carVelocityWorld.x - p.linearVelocity.x, carVelocityWorld.z - p.linearVelocity.z);
              if (closingMs > 2) mpRace.damage.registerImpact({ localX: 0, localZ: 2.0, speedMs: closingMs, source: "car" });
            }
          }
        }
        // Multiplayer car damage from walls and car contact when enabled by the room rules
        if (mpRace.damage && driving && mpFrame.phase === "racing") damageFeed.update(mpRace.damage, physics);
        // polish:D yellow flags: a car stopped, off or going the wrong way on the road ahead (mp-flags.ts)
        if (physics.telemetry.race && mpFrame.phase === "racing") {
          flagMultiplayerRace(mpRace, physics.telemetry.race, track, samePeers, dtSeconds, mpFrame.raceTimeS, physics.sMeters);
        }
      } else {
        for (const p of samePeers) p.passThrough = false;
      }
      // Practice damage (the player's setting): practice and time trials driven alone, not qualifying for an AI race nor
      // anything in an online room, where restarts are not the player's alone (as for Flashback)
      const soloDamage =
        raceNow().kind === "practice" &&
        !quali &&
        !mpQuali &&
        !isInOnlineRoom(multiplayerSync.status, peersOnTrack) &&
        settingsNow.practiceDamage !== "off"
          ? practiceDamage
          : null;
      if (soloDamage) {
        if (driving) {
          damageFeed.update(soloDamage, physics);
          damageFeed.record(soloDamage, replayClockS);
          // Put out (a big hit, a wheel torn off): a moment to see it, then a flying lap with the car repaired, as the
          // restart key gives in practice
          practiceWreckS = soloDamage.terminal ? practiceWreckS + dtSeconds : 0;
          if (practiceWreckS >= PRACTICE_WRECK_HOLD_S) {
            practiceWreckS = 0;
            queueMicrotask(() => this.restartFlyingLap());
          }
        }
      } else {
        // No damage judged here (an online race's is fed above): a hit now is never counted once damage is on
        if (!(mpRace?.damage && mpFrame?.phase === "racing")) damageFeed.skip(physics.telemetry);
        // Practice damage switched off, or the session turned into one it does not apply to: the car is repaired
        if (!practiceDamage.pristine && raceNow().kind === "practice") {
          practiceDamage.reset();
          practiceWreckS = 0;
          damageFeed.apply(practiceDamage, physics);
        }
      }
      physics.telemetry.practiceDamage = damageStatusOf(soloDamage);
      let renderPeers = aiField ? [...samePeers, ...aiField.peers()] : samePeers;
      // polish:B the podium shot once the top three are known (this frame's race status, before the HUD sees it)
      podium.update({
        race: physics.telemetry.race,
        dt: frozen ? 0 : dtSeconds,
        allowed: !inMenu && !replaying && !renderer.xr.isPresenting,
        peers: renderPeers,
        ground: physics.groundQuery ?? null,
      });

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

      // Instant / full-race replay: record the field while driving (never during post-race cool-down or podium),
      // and reconstruct full vehicle telemetry, wheel spin, velocities, and focused-car targeting during playback
      if (driving && !coolDown.active && !podium.playing) {
        replayClockS += dtSeconds;
        if (replayClockS - lastReplayPushS >= 1 / REPLAY_HZ) {
          lastReplayPushS = replayClockS;
          const standings = aiField ? physics.telemetry.race?.standings : undefined;
          const playerDistM = standings?.find((st) => st.isPlayer)?.raceDistM;
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
              lap: physics.telemetry.lapCount,
              ...(physics.telemetry.outLap ? { outLap: true } : {}),
              ...(playerDistM !== undefined ? { distM: playerDistM } : {}),
            },
          ];
          for (const p of renderPeers) {
            if (p.ghost) continue;
            replayNames.set(p.peerId, { code: p.driverCode, color: p.teamColorHex, vehicle: p.vehicle });
            const peerDistM = standings?.find((st) => !st.isPlayer && st.driverCode === p.driverCode)?.raceDistM;
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
              gear: p.gear ?? 0,
              rpm: p.rpm ?? 0,
              s: p.trackS,
              ...(peerDistM !== undefined ? { distM: peerDistM } : {}),
            });
          }
          rp.buffer.push(replayClockS, cars);
          if (!this.snapshot.replayAvailable && rp.buffer.durationS >= 1) {
            this.publish({ replayAvailable: true });
          }
        }
      } else if (replaying) {
        if (rp.playing && !frozen) {
          rp.timeS = THREE.MathUtils.clamp(rp.timeS + dtSeconds * rp.speed, rp.buffer.startS, rp.buffer.endS);
          if ((rp.speed > 0 && rp.timeS >= rp.buffer.endS) || (rp.speed < 0 && rp.timeS <= rp.buffer.startS)) {
            rp.playing = false;
          }
        }
        const replayDeltaT = rp.timeS - rp.prevTimeS;
        rp.prevTimeS = rp.timeS;
        const wheelDir = rp.playing && !frozen ? Math.sign(rp.speed) * Math.min(Math.abs(rp.speed), 4) : 0;
        const frame = rp.buffer.frameAt(rp.timeS);
        replayFocusCarFrame = null;
        if (frame) {
          const peers: InterpolatedPeerState[] = [];
          for (const car of frame.cars) {
            if (car.id === rp.focusedCarId) replayFocusCarFrame = car;
            if (car.id === "player") {
              // Only the drawn pose: the car's physics stays where it is
              physics.worldPosition.set(car.x, car.y, car.z);
              physics.worldQuaternion.set(car.qx, car.qy, car.qz, car.qw);
              rp.buffer.velocityAt(rp.timeS, "player", replayPlayerVel);
              rp.wheelRotRad += ((car.speedKmh / 3.6) / 0.34) * replayDeltaT;
              replayPlayerS = car.s ?? physics.sMeters;
              replayPlayerTelemetry.speedKmh = car.speedKmh;
              replayPlayerTelemetry.steering = car.steer;
              replayPlayerTelemetry.throttle = car.throttle;
              replayPlayerTelemetry.brake = car.brake;
              replayPlayerTelemetry.gear = car.gear;
              replayPlayerTelemetry.rpm = car.rpm;
              replayPlayerTelemetry.onKerbLeft = false;
              replayPlayerTelemetry.onKerbRight = false;
              if (car.lap !== undefined) replayPlayerTelemetry.lapCount = car.lap;
            } else {
              peers.push(replayPeerState(car, rp.timeS, wheelDir));
            }
          }
          renderPeers = peers;
        }
      }

      telemetryPeersScratch.length = 0;
      for (let i = 0; i < renderPeers.length; i++) {
        const p = renderPeers[i];
        if (p.ghost) continue;
        let deltaS = p.trackS - physics.sMeters;
        if (deltaS > track.totalLengthM * 0.5) deltaS -= track.totalLengthM;
        if (deltaS < -track.totalLengthM * 0.5) deltaS += track.totalLengthM;
        const refSpeedMs = Math.max(25, physics.vxMs, p.speedKmh / 3.6);
        telemetryPeersScratch.push({
          peerId: p.peerId,
          driverCode: p.driverCode,
          teamColorHex: p.teamColorHex,
          trackDistanceM: p.trackS,
          speedKmh: p.speedKmh,
          gapSeconds: Number((deltaS / refSpeedMs).toFixed(2)),
          isAiPeer: p.isAiPeer,
        });
      }
      physics.telemetry.peers = telemetryPeersScratch;

      // While the keys steer, the mouse follows the steering, so it takes over (once the keys' ramp is at centre)
      // where the steering is instead of where the mouse was
      if (settings.mouseSteer && physics.steeringAssist.source === "keyboard") {
        mouseSteerValue = physics.steerAngleNorm;
      }

      // The latched boost lets go once the battery is empty (where the cars stop deploying it), and on the brake or a
      // lift from full throttle (iRacing's push-to-pass rule: a latch never stays on into the next straight unasked)
      if (!this.snapshot.boostLatch) latchSawFull = false;
      else {
        const t = physics.telemetry;
        if (t.throttle >= 0.9) latchSawFull = true;
        if (physics.ersEnergyJ <= 0 || (driving && (t.brake > 0.05 || (latchSawFull && t.throttle < 0.5)))) setLatch(false);
      }

      // The menus film the car from outside, whatever the player's camera is
      const inVr = renderer.xr.isPresenting;
      const mode: CameraMode = inMenu || podium.playing ? "chase" : inVr ? "cockpit" : (cameraOverride ?? settings.camera ?? "chase");
      const view = CAMERA_MODES[mode];
      const lc26Cams = carRig.getCameraAnchors();
      const carFovDeg = lc26Cams ? lc26Cams.cockpit.fovDeg : FALLBACK_COCKPIT_FOV_DEG;
      if (carFovDeg !== this.snapshot.carCockpitFovDeg) setCarCockpitFov(carFovDeg);
      const onboardFovShift = settings.cockpitFovDeg === null ? 0 : settings.cockpitFovDeg - carFovDeg;
      // The procedural helmet goes once the LC26 model (with its own driver) has replaced the procedural car
      carRig.helmetGroup.visible = !lc26Cams;
      // From the driver's eye point the helmet would fill the view: the camera leaves its layer out, while the
      // sun's shadow camera keeps it so the head still shadows the cockpit
      if (view.driverEye) camera.layers.disable(DRIVER_HEAD_LAYER);
      else camera.layers.enable(DRIVER_HEAD_LAYER);

      lapDelta.update(physics.telemetry);
      // The cars as drawn this frame (the podium shot parks them); the opponents' engines play from where they are drawn
      const drawnPeers = podium.drawPeers(renderPeers);

      // Everything from here to the cameras only moves what is drawn: a frame the cap skips leaves it for the next
      // drawn one, which moves it on by the time since the last (drawDtS)
      if (draw) {
        // The fixed-step physics leaves up to 2 ms unstepped each frame: draw the car (and the cameras on it) where it
        // is at the frame's time, the pose carried forward by its velocity over that remainder. During replay, use the
        // exact interpolated replay pose without physics lead extrapolation.
        if (replaying) {
          renderCarPos.copy(physics.worldPosition);
        } else {
          renderCarPos
            .copy(carVelocityWorld)
            .multiplyScalar(physics.renderLeadS ?? 0)
            .add(physics.worldPosition);
        }
        carRig.root.position.copy(renderCarPos);
        carRig.root.quaternion.copy(physics.worldQuaternion);
        carRig.chassisGroup.position.y = replaying ? 0 : physics.rideHeightOffsetM;
        if (physics.tyreVisuals) {
          playerWheels.tyres = physics.tyreVisuals;
          playerWheels.ground = physics.groundQuery ?? null;
          playerWheels.quaternion = physics.worldQuaternion;
        }
        const drawPlayerTelemetry = replaying ? replayPlayerTelemetry : physics.telemetry;
        carRig.updateFromTelemetry(
          drawPlayerTelemetry,
          replaying ? 0 : physics.pitchRad,
          replaying ? 0 : physics.rollRad,
          replaying ? rp.wheelRotRad : physics.wheelRotationRad,
          drawDtS,
          physics.tyreVisuals ? playerWheels : undefined
        );
        seatContactShadow(carRig.root, physics.tyreVisuals ? playerWheels : undefined);
        podium.drawPlayer(carRig, physics.telemetry, physics.groundQuery ?? null, drawDtS);

        const lc26Body = carRig.getLc26Body();
        // Built once per body (keyed on the body, not on the wheel display: a body without STEER_BASE has no display,
        // and keying on it rebuilt the mirrors' render target every frame)
        if (lc26Body && lc26ExtrasFor !== lc26Body) {
          lc26ExtrasFor = lc26Body;
          const steerBase = lc26Body.getObjectByName("STEER_BASE");
          if (steerBase) wheelDisplay = new SteeringWheelDisplay(steerBase);
          wingMirrors = new WingMirrors(renderer, scene, lc26Body);
        }
        if (!lc26Body && !portedDash && carById(carRigCar).modelUrl && portedProbeFrame++ % 30 === 0) {
          portedDash = PortedWheelDash.from(carRig.chassisGroup, revRangeFor(carById(carRigCar).physics));
        }
        // A ported body's anchors are set once its GLB has loaded; a body without the Evo's screen or mirror glass
        // gets an empty display and no mirrors, so it is probed once
        if (!lc26Body && !gt3Dash && carById(carRigCar).modelUrl && cockpitProbeFrame++ % 30 === 0) {
          const anchors = carRig.getCameraAnchors();
          if (anchors) {
            gt3Dash = new Gt3DashDisplay(carRig.chassisGroup, revRangeFor(carById(carRigCar).physics));
            const glassPatches = gt3MirrorPatches(carRig.chassisGroup);
            if (glassPatches.length) {
              wingMirrors = new WingMirrors(renderer, scene, carRig.chassisGroup, {
                materials: [],
                eyeInModel: anchors.cockpit.pos,
                glassPatches,
              });
            }
          }
        }
        // The wheel is only in shot from the onboard views; the display redraws itself at 30 Hz
        if (view.wheelInShot && (wheelDisplay || gt3Dash?.found || portedDash?.found)) {
          const delta = lapDelta.delta(physics.telemetry);
          const deltaMs = delta === null ? null : delta * 1000;
          if (wheelDisplay) {
            displayExtra.deltaMs = deltaMs;
            wheelDisplay.update(physics.telemetry, nowMs, displayExtra);
          }
          if (gt3Dash?.found) gt3Dash.update(physics.telemetry, nowMs, { deltaMs });
          if (portedDash?.found) portedDash.update(physics.telemetry, nowMs, { deltaMs });
        }

        // Update persistent 4-wheel skidmark ribbons, tire smoke/gravel/rooster-tail particles & opponent 3D cars
        // The player's car only lays skidmarks and throws smoke / spray while it is simulated: paused, in menus or in a
        // replay its wheel state is the last driven frame, which would keep emitting on the spot
        visualFx.update(
          drawDtS,
          physics.worldQuaternion,
          physics.vxMs,
          physics.wheels,
          drawnPeers,
          driving
        );

        floorSparks.update(drawDtS, driving && rigModel(carRigCar).floorSparks ? physics : null);

        let freeMinY: number | undefined;
        if (mode === "free") {
          if (freeCamControl) {
            let fwd = (freeCamKeys.has("KeyW") || freeCamKeys.has("ArrowUp") ? 1 : 0) - (freeCamKeys.has("KeyS") || freeCamKeys.has("ArrowDown") ? 1 : 0);
            let right = (freeCamKeys.has("KeyD") || freeCamKeys.has("ArrowRight") ? 1 : 0) - (freeCamKeys.has("KeyA") || freeCamKeys.has("ArrowLeft") ? 1 : 0);
            let up = (freeCamKeys.has("KeyE") || freeCamKeys.has("Space") ? 1 : 0) - (freeCamKeys.has("KeyQ") ? 1 : 0);
            let lookYaw = 0;
            let lookPitch = 0;
            // Only fly with a standard non-wheel controller when the player isn't using a steering wheel device
            const pad = settingsNow.device !== "wheel" ? pads.find((p) => p.mapping === "standard" && !isLikelyWheel(p)) : undefined;
            if (pad) {
              const dz = (v: number) => (Math.abs(v) > 0.14 ? v : 0);
              right += dz(pad.axes[0] ?? 0);
              fwd -= dz(pad.axes[1] ?? 0);
              lookYaw -= dz(pad.axes[2] ?? 0) * 2.0;
              lookPitch -= dz(pad.axes[3] ?? 0) * 1.5;
              const rt = pad.buttons[7]?.value ?? 0;
              const lt = pad.buttons[6]?.value ?? 0;
              if (rt > 0.1) up += rt;
              if (lt > 0.1) up -= lt;
            }
            freeCamInput.forward = THREE.MathUtils.clamp(fwd, -1, 1);
            freeCamInput.right = THREE.MathUtils.clamp(right, -1, 1);
            freeCamInput.up = THREE.MathUtils.clamp(up, -1, 1);
            freeCamInput.fast = freeCamKeys.has("ShiftLeft") || freeCamKeys.has("ShiftRight");
            freeCamInput.slow = freeCamKeys.has("AltLeft") || freeCamKeys.has("AltRight");
            freeCamInput.lookYawRate = lookYaw;
            freeCamInput.lookPitchRate = lookPitch;
          } else {
            freeCamInput.forward = 0;
            freeCamInput.right = 0;
            freeCamInput.up = 0;
            freeCamInput.fast = false;
            freeCamInput.slow = false;
            freeCamInput.lookYawRate = 0;
            freeCamInput.lookPitchRate = 0;
          }
          if (cameraRig.freeCamera.initialised && physics.groundQuery) {
            const p = cameraRig.freeCamera.position;
            if (physics.groundQuery.query(p.x, p.z, p.y + 4, freeCamGroundHit)) {
              freeMinY = freeCamGroundHit.height + 0.35;
            }
          }
        }
        // Resolve camera target: during replay, allow focusing any car (player or AI opponent) with full camera switching
        let camCar: CameraRigCar = physics;
        let camCarPos: THREE.Vector3 = renderCarPos;
        let camCarVel: THREE.Vector3 = carVelocityWorld;
        let camChassis: THREE.Object3D = carRig.chassisGroup;
        let camAnchors = lc26Cams;
        let camCarId: CarId = carRigCar;
        let camNudges = settingsNow.cameraNudges;
        if (replaying) {
          const fc = replayFocusCarFrame;
          if (fc && fc.id !== "player") {
            const oppRig = visualFx.getOpponentRig(fc.id);
            const focusInfo = replayNames.get(fc.id);
            replayCamCar.worldPosition.set(fc.x, fc.y, fc.z);
            replayCamCar.worldQuaternion.set(fc.qx, fc.qy, fc.qz, fc.qw);
            replayLastFocusId = fc.id;
            replayLastFocusPos.copy(replayCamCar.worldPosition);
            replayLastFocusQuat.copy(replayCamCar.worldQuaternion);
            replayCamCar.sMeters = fc.s ?? 0;
            replayCamCar.vxMs = fc.speedKmh / 3.6;
            replayCamCar.vyMs = 0;
            replayCamCar.wheelbaseM = physics.wheelbaseM;
            replayCamCar.cgHeightM = physics.cgHeightM;
            replayFocusTelemetry.speedKmh = fc.speedKmh;
            replayFocusTelemetry.steering = fc.steer;
            replayFocusTelemetry.throttle = fc.throttle;
            replayFocusTelemetry.brake = fc.brake;
            replayFocusTelemetry.gear = fc.gear;
            replayFocusTelemetry.rpm = fc.rpm;
            replayFocusTelemetry.onKerbLeft = false;
            replayFocusTelemetry.onKerbRight = false;
            replayCamCar.telemetry = replayFocusTelemetry;
            rp.buffer.velocityAt(rp.timeS, fc.id, replayFocusVel);
            camCar = replayCamCar;
            camCarPos = replayCamCar.worldPosition;
            camCarVel = replayFocusVel;
            if (focusInfo?.vehicle) camCarId = carForVehicle(focusInfo.vehicle).id;
            camNudges = {};
            if (oppRig) {
              camChassis = oppRig.chassisGroup;
              camAnchors = oppRig.getCameraAnchors();
            } else {
              camAnchors = null;
            }
          } else if (rp.focusedCarId !== "player" && replayLastFocusId === rp.focusedCarId) {
            // Focused AI car retired or left this frame: hold its last pose cleanly instead of silently snapping to player
            replayCamCar.worldPosition.copy(replayLastFocusPos);
            replayCamCar.worldQuaternion.copy(replayLastFocusQuat);
            replayCamCar.vxMs = 0;
            replayCamCar.vyMs = 0;
            replayFocusVel.set(0, 0, 0);
            replayFocusTelemetry.speedKmh = 0;
            replayCamCar.telemetry = replayFocusTelemetry;
            camCar = replayCamCar;
            camCarPos = replayCamCar.worldPosition;
            camCarVel = replayFocusVel;
            const focusInfo = replayNames.get(rp.focusedCarId);
            if (focusInfo?.vehicle) camCarId = carForVehicle(focusInfo.vehicle).id;
            camNudges = {};
            camAnchors = null;
          } else {
            if (rp.focusedCarId !== "player") {
              // Scrubbed to a timestamp before this car existed: visibly switch focus back to player so UI matches camera
              rp.focusedCarId = "player";
              publishReplayUi();
            }
            replayCamCar.worldPosition.copy(physics.worldPosition);
            replayCamCar.worldQuaternion.copy(physics.worldQuaternion);
            replayCamCar.sMeters = replayPlayerS;
            replayCamCar.vxMs = replayPlayerTelemetry.speedKmh / 3.6;
            replayCamCar.vyMs = 0;
            replayCamCar.wheelbaseM = physics.wheelbaseM;
            replayCamCar.cgHeightM = physics.cgHeightM;
            replayCamCar.telemetry = replayPlayerTelemetry;
            camCar = replayCamCar;
            camCarPos = renderCarPos;
            camCarVel = replayPlayerVel;
          }
        }
        if (!podium.placeCamera(camera)) cameraRig.update({
          dt: drawDtS,
          nowMs,
          mode,
          car: camCar,
          carPos: camCarPos,
          carVelocity: camCarVel,
          anchor: onboardViews.resolve(camAnchors, mode, camCarId, camNudges),
          chassis: camChassis,
          onboardFovShift,
          headMovement: settingsNow.hud.headMovement,
          driving,
          inVr,
          freeInput: mode === "free" ? freeCamInput : undefined,
          freeMinY,
          menu: inMenu
            ? {
                close: appPhase === "wizard" && wizardStep === "car",
                width: container.clientWidth,
                height: container.clientHeight,
                aerial: menuAerial,
                still: reducedMotion?.matches ?? false,
                fogDensity: scene.fog instanceof THREE.FogExp2 ? scene.fog.density : undefined,
              }
            : null,
        });
        // The driving aids' overlay (the racing line) is not drawn from the air: the tour is a broadcast shot
        if (cameraRig.aerialUp !== aerialOverlayOff) {
          aerialOverlayOff = cameraRig.aerialUp;
          if (aerialOverlayOff) camera.layers.disable(OVERLAY_LAYER);
          else camera.layers.enable(OVERLAY_LAYER);
        }

        builtCircuit.updateEnvironment(nowMs * 0.001);
        // (a race in the worker lays its rubber there)
        builtCircuit.setGrooveRubber(aiFieldOf(raceNow())?.worker?.rubber ?? getTrackEnv().trackEvolution.meanRacingLineRubber());
      }
      opponentAudio.update({
        context: audio?.context ?? null,
        output: audio?.output ?? null,
        active: driving,
        camera,
        cameraMode: mode,
        peers: drawnPeers,
        soundFor: opponentSound,
        dt: dtSeconds,
        lowQuality: settingsNow.graphics.quality === "low",
      });
      audio?.setCameraMode(mode);
      audio?.setPaused(!driving);
      // The music follows where the player is: the menus, the grid, the race, the flag, a replay, the pause menu
      if (music.unlocked) {
        music.setCue(
          musicDirector.cue({
            phase: appPhase,
            racePhase: physics.telemetry.race?.phase,
            replaying,
            frozen: frozen || Boolean(device.wheelLost),
            speedMs: physics.vxMs,
            engineLoad:
              physics.telemetry.throttle * Math.min(1, physics.telemetry.rpm / vehicleModelSpec(vehicleNow).telemetryMaxRpm),
          }),
        );
      }
      if (driving) {
        audio?.update(physics.telemetry, dtSeconds);
        // Cues: DRS enabled (two-tone), flap open (chime; LC26: X-mode), shift point (150 rpm short of the limiter)
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
        if (cues.shiftBeep && cueShiftArmed && tc.gear > 0 && tc.rpm >= limiter - SHIFT_BEEP_BELOW_LIMITER_RPM) {
          audio?.cue("shift");
          cueShiftArmed = false;
        }
      }

      // Nothing to draw behind the opaque loading screen (the shaders are compiled separately), or with no GPU context
      if (appPhase === "loading" || gpuLost) return;

      // Weather: sun, sky, fill and fog, the wet look of the road, spray, and rain around the camera
      const wx = trackEnv.weather;
      // The sky updates at 10 Hz; the ripples' clock and the rain around the camera with each drawn frame, below
      if (nowMs - lastSkyMs > 100) {
        lastSkyMs = nowMs;
        const sun = wx.sun;
        skyConditions.elevationDeg = sun.elevationDeg;
        skyConditions.azimuthDeg = sun.azimuthDeg;
        skyConditions.cloud = wx.cloudCover;
        skyConditions.rain = wx.rainIntensity;
        skyConditions.windVxMs = wx.windVxMs;
        skyConditions.windVzMs = wx.windVzMs;
        if (!cloudConditions || !sameConditions(cloudConditions, wx.conditions)) {
          if (cloudConditions && cloudConditions.timeOfDay !== wx.conditions.timeOfDay) {
            headlightMode = "auto";
            lastWeatherHudMs = -Infinity;
          }
          cloudConditions = { ...wx.conditions };
          syncHeadlightSpots();
          // a session that turns to night (or rain) on a circuit with lamps: they light up from now on
          if (trackRoot) {
            ensureVenueNight(trackRoot);
            ensureOpponentBeams(trackRoot);
          }
          env.setCloudSeed(fixedCloudSeed ?? Math.floor(Math.random() * 2 ** 31));
        }
        env.setConditions(skyConditions);
        venueNight?.setNight(nightShareOf(skyConditions.elevationDeg));
        setAsphaltWetness(wetnessFromWater(wx.waterMm), wetnessFromWater(wx.lineWaterMm), wx.rainIntensity);
        // The water under the player's own wheels, not the lap's mean line water
        // (in a race the worker runs, its road under the car)
        const workerRace = aiFieldOf(raceNow())?.worker;
        visualFx.setWetness((workerRace ? workerRace.playerWetness : trackEnv.weatherSampleFor(physics)?.wetness) ?? wetnessFromWater(wx.lineWaterMm));
      }
      if (nowMs - lastWeatherHudMs > 500) {
        lastWeatherHudMs = nowMs;
        const hudLights = resolveHeadlightStates(headlightMode, skyConditions.elevationDeg, wx.rainIntensity);
        const next: WeatherHudState = {
          airC: Math.round(wx.ambientC),
          trackC: Math.round(wx.trackTempC),
          waterMm: Math.round(wx.lineWaterMm * 100) / 100,
          rain: Math.round(wx.rainIntensity * 20) / 20,
          clockH: Math.round(wx.clockH * 60) / 60,
          timeMoving: wx.conditions.timeScale > 0, humidityPct: Math.round(wx.humidityPct), windSpeedMs: Math.round((wx.windSpeedKmh / 3.6) * 10) / 10, windDirection: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round((((wx.windDirectionDeg % 360) + 360) % 360) / 45) % 8],
          headlightsOn: hudLights.player,
          headlightMode,
          headlightsAutoOn: hudLights.opponents,
          headlightFlash: playerFlashing,
        };
        const key = JSON.stringify(next);
        if (key !== weatherHudKey) {
          weatherHudKey = key;
          setWeatherHud(next);
        }
      }
      // The drawing itself (a frame the cap skips draws nothing)
      if (draw) {
        advanceAsphaltRain(drawDtS);
        camera.getWorldPosition(rainCamPos);
        if (drawDtS > 0) rainCamVel.subVectors(rainCamPos, rainCamPrev).divideScalar(drawDtS).clampLength(0, 110);
        rainCamPrev.copy(rainCamPos);
        // Spray thrown up by the cars ahead (the wake model's, from their speed, gap and the water)
        const workerRace = aiFieldOf(raceNow())?.worker;
        const sprayWake = workerRace ? workerRace.playerSpray : (trackEnv.weatherSampleFor(physics)?.sprayIntensity ?? 0);
        // Droplets on the visor only from the driver's eye (the mirrors render without this layer)
        if (view.driverEye && !inVr) camera.layers.enable(RAIN_VISOR_LAYER);
        else camera.layers.disable(RAIN_VISOR_LAYER);
        const skyLight = THREE.MathUtils.clamp((skyConditions.elevationDeg + 3) / 17, 0, 1) * (1 - 0.4 * wx.cloudCover);
        const headlights = resolveHeadlightStates(headlightMode, skyConditions.elevationDeg, wx.rainIntensity);
        // Onboard views (cockpit, dash, nose, shoulder, T-cam) sit on/behind the nose; hide the player's own front flares
        const playerBrakingNow = (replaying ? replayPlayerTelemetry.brake : physics.telemetry.brake) > 0.05;
        // Under a street lamp the cars are lit as the road is
        if (venueNight?.mode === "lamps") {
          const p = carRig.root.position;
          lightCarByLamps(carRig.root, venueNight.lightAt(p.x, p.z, lampLight), nowMs);
          visualFx.forEachOpponentRoot(lightOpponentByLamps);
        }
        carHeadlights.setFlash(playerFlashing && !replaying);
        carHeadlights.setEnabled(headlights.player, playerBrakingNow, camera, view.anchor !== null && (!replaying || rp.focusedCarId === "player"));
        visualFx.setHeadlights(headlights.opponents, camera);
        if (opponentBeams) opponentBeams.update(beamScratch, visualFx.collectBeams(beamScratch), rainCamPos);
        visualFx.setLightLevel(skyLight);
        rainFx.update(
          drawDtS,
          wx.rainIntensity,
          camera,
          rainCamVel,
          skyLight,
          wx.windVxMs,
          wx.windVzMs,
          THREE.MathUtils.clamp(sprayWake, 0, 1)
        );
        env.update(physics.worldPosition, camera);
        startupMonitor?.begin();
        // Not in the aerial tour or while paused (once primed): reflections are static when the scene is frozen
        if (!cameraRig.aerialUp && (!frozen || reflectionProbe.texture === null)) {
          reflectionProbe.update(podium.focus ?? physics.worldPosition, carRig.root, scene.environmentIntensity);
        }
        startupMonitor?.end("probe");
        // Virtual mirror: on its own in the views whose wing mirrors are off screen (or that have none), and in the
        // chase view too when the player asked for it always. Auto shows it only with other cars about: an AI race, an
        // online race, or other players in the room (practice, the hotlap and qualifying are driven alone)
        const vmSetting = settingsNow.hud.virtualMirror;
        const lowQuality = settingsNow.graphics.quality === "low";
        const wingMirrorsActive = !lowQuality && Boolean(wingMirrors?.found && wingMirrors.coversSides);
        const vmView =
          view.virtualMirror === "always" ||
          (view.virtualMirror === "noSideMirrors" && !wingMirrorsActive) ||
          (view.virtualMirror === "onRequest" && vmSetting === "always");
        const othersAbout = raceNow().kind !== "practice" || peersOnTrack > 0;
        // On Low graphics wing mirrors are disabled (saving 2 passes), so keep the single virtual mirror available in cockpit/dash
        const vmOn =
          driving &&
          !inVr &&
          !podium.playing &&
          container.clientWidth >= 640 &&
          vmView &&
          (vmSetting === "always" || (vmSetting === "auto" && othersAbout));
        // The mirrors render every second drawn frame (30 times a second at 60 fps), and every drawn frame once the game
        // draws under about 45 fps (the 30 fps cap included), so they never drop below about 25 Hz. Low's every fourth
        // frame showed a 7-10 Hz mirror on a 30-40 fps machine (#186)
        const mirrorRefresh = mirrorClock.tick(drawIntervalMs);
        virtualMirror.update(mirrorRefresh, vmOn, carRig.chassisGroup, carRig.root);
        if (vmOn !== virtualMirrorShown) {
          virtualMirrorShown = vmOn;
          setVirtualMirrorOn(vmOn);
        }
        // Rear view into the mirrors' render target (cockpit only; skipped on Low graphics)
        wingMirrors?.update(mirrorRefresh, view.driverEye && !inVr && !lowQuality, carRig.chassisGroup);
        if (inVr) {
          // The head pose is added on top of the driver's eye point (a "local" space starts at the head)
          xrRig.position.copy(camera.position);
          xrRig.quaternion.copy(camera.quaternion);
          renderer.render(scene, xrCamera);
        } else {
          const t0 = loggedFirstFrame ? 0 : performance.now();
          startupMonitor?.begin();
          postFx.render(drawDtS);
          virtualMirror.draw();
          startupMonitor?.end("render");
          if (captureWaiting) {
            const take = captureWaiting;
            captureWaiting = null;
            take(renderer.domElement);
          }
          if (!loggedFirstFrame) {
            loggedFirstFrame = true;
            if (process.env.NODE_ENV !== "production") {
              // The frame right after the loading screen: it stalls when the warm-up missed something
              renderer.getContext().finish();
              console.info(`[load] first visible frame: ${(performance.now() - t0).toFixed(0)} ms`);
            }
          }
        }
        const nameplates = host.nameplatesRef?.current;
        if (nameplates) {
          if (!inMenu && !inVr && !podium.playing && settingsNow.hud.showPlayerNames && drawnPeers.length > 0) {
            const localBestLapMs = physics.telemetry.qualifying ? physics.telemetry.qualifying.bestMs : physics.telemetry.bestLapTimeMs;
            nameplates.update(
              nameplateProjector.project(drawnPeers, camera, container.clientWidth, container.clientHeight, {
                race: physics.telemetry.race,
                localBestLapMs,
                badgesByNameKey: nameplateBadges.map,
              })
            );
          } else {
            nameplates.hideAll();
          }
        }
      }

      // Automatic quality: judged on the frames drawn while driving (not paused, in a menu or a replay)
      if (driving && settingsNow.graphics.autoQuality && !inVr) {
        governorFed = true;
        if (draw) {
          const event = governor.frame(nowMs, drawIntervalMs, frameBudgetMs(pacer.cap, displayRate.intervalMs));
          if (event) onQualityEvent(event, nowMs);
        }
      } else if (governorFed) {
        governorFed = false;
        governor.interrupt();
      }
      // The bug report's frame rate: the same frames, whether or not the automatic quality is on
      if (driving && draw && !inVr) noteDrivingFrame(drawIntervalMs, nowMs);

      // Paused or in menus: 4 Hz keeps remote players current without burning 30 Hz HUD commits.
      // Driving: 30 Hz on desktop, 20 Hz on touch devices to reduce mobile main-thread React overhead.
      const hudIntervalMs = frozen || inMenu ? 250 : touchGraphics ? 50 : 33;
      if (nowMs - lastHudSyncMs > hudIntervalMs) {
        lastHudSyncMs = nowMs;
        // What the player steered with against what the wheels did, for the input trace
        const steerSource = physics.steeringAssist.source;
        const steerInput = !driving
          ? undefined
          : steerSource === "keyboard"
            ? kbSteerDir
            : steerSource === "controller"
              ? (gamepadStick ?? 0)
              : (directSteer ?? 0);
        setTelemetry({
          ...physics.telemetry,
          steerInput,
          steerLockDeg: physics.maxSteerAngleRad * (180 / Math.PI),
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
          ...(physics.telemetry.tireBandTempsC
            ? {
                tireBandTempsC: physics.telemetry.tireBandTempsC.map(
                  (b) => [b[0], b[1], b[2]] as [number, number, number],
                ) as [[number, number, number], [number, number, number], [number, number, number], [number, number, number]],
              }
            : {}),
          ...(physics.telemetry.tirePressuresPsi
            ? { tirePressuresPsi: [...physics.telemetry.tirePressuresPsi] as [number, number, number, number] }
            : {}),
          ...(physics.telemetry.tireOptimalPsi
            ? { tireOptimalPsi: [...physics.telemetry.tireOptimalPsi] as [number, number, number, number] }
            : {}),
          ...(physics.telemetry.tireFlatSpotSeverity
            ? { tireFlatSpotSeverity: [...physics.telemetry.tireFlatSpotSeverity] as [number, number, number, number] }
            : {}),
          ...(physics.telemetry.tireGrainLevel
            ? { tireGrainLevel: [...physics.telemetry.tireGrainLevel] as [number, number, number, number] }
            : {}),
          ...(physics.telemetry.tireBlisterLevel
            ? { tireBlisterLevel: [...physics.telemetry.tireBlisterLevel] as [number, number, number, number] }
            : {}),
          ...(physics.telemetry.tireDirtyLevel
            ? { tireDirtyLevel: [...physics.telemetry.tireDirtyLevel] as [number, number, number, number] }
            : {}),
          ...(physics.telemetry.brakeCoreTempsC
            ? { brakeCoreTempsC: [...physics.telemetry.brakeCoreTempsC] as [number, number, number, number] }
            : {}),
          ...(physics.telemetry.brakePadMuFactor
            ? { brakePadMuFactor: [...physics.telemetry.brakePadMuFactor] as [number, number, number, number] }
            : {}),
          peers: [...(physics.telemetry.peers ?? [])],
        });
        if (replaying) {
          publishReplayUi();
        }
      }
    };

    // `?perf=1`: each frame's own time on the page, whether it drew, and what the game was doing, for the report
    const timedAnimate = (nowMs: number) => {
      const startMs = performance.now();
      frameSimMs = 0;
      animate(nowMs);
      if (!sessionPerf) return;
      const phase: PerfPhase =
        appPhaseNow === "loading"
          ? "load"
          : appPhaseNow !== "driving"
            ? "menu"
            : replay.active
              ? "replay"
              : this.snapshot.paused || this.snapshot.seatPanel
                ? "pause"
                : "drive";
      sessionPerf.frame(nowMs, lastDrawMs === nowMs, phase, performance.now() - startMs, frameSimMs);
    };
    // setAnimationLoop runs on window rAF normally and on the headset's frame loop in VR
    renderer.setAnimationLoop(sessionPerf ? timedAnimate : animate);

    this.teardown = () => {
      disposed = true;
      // A context the browser gave back after a loss holds none of this session's GPU objects: let go of it first, and
      // the disposals below are no-ops instead of a WebGL warning each
      const gl = renderer.getContext();
      if (gpuLost && !gl.isContextLost()) gl.getExtension("WEBGL_lose_context")?.loseContext();
      unsubscribeAssets();
      window.clearInterval(assetWatchdog);
      renderer.setAnimationLoop(null);
      void renderer.xr.getSession()?.end();
      wakeLock.dispose();
      haptics.stop();
      dualSense.stop();
      opponentAudio.dispose();
      menuIdle.dispose();
      wheelFfb.dispose();
      simHost?.dispose();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      renderer.domElement.removeEventListener("webglcontextrestored", onContextRestored);
      renderer.domElement.removeEventListener("pointerdown", onFreeCamPointerDown);
      renderer.domElement.removeEventListener("pointermove", onFreeCamPointerMove);
      renderer.domElement.removeEventListener("pointerup", onFreeCamPointerUp);
      renderer.domElement.removeEventListener("pointercancel", onFreeCamPointerUp);
      renderer.domElement.removeEventListener("wheel", onFreeCamWheel);
      window.removeEventListener("contextmenu", onFreeCamContextMenu);
      renderer.domElement.style.touchAction = "";
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
      carHeadlights.dispose();
      visualFx.disposeHeadlights();
      unsubscribeCarSkins();
      postFx.dispose();
      reflectionProbe.dispose();
      venueNight?.dispose();
      opponentBeams?.dispose();
      env.dispose();
      rainFx.dispose();
      virtualMirror.dispose();
      floorSparks.dispose();
      setKtx2Renderer(null);
      renderer.dispose();
      window.clearInterval(nameplateBadgeTimer);
      nameplateBadges.dispose();
      host.nameplatesRef?.current?.hideAll();
      audio?.dispose();
      // The music plays on into the next circuit's session (or the menus)
      stopNowPlaying();
    };
  }

  private publish(patch: Partial<DriveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private publishTelemetry(telemetry: CarTelemetry): void {
    this.telemetrySnapshot = telemetry;
    for (const listener of this.telemetryListeners) listener();
    const key = telemetryStructKeyOf(telemetry);
    if (key !== this.telemetryStructKey) {
      this.telemetryStructKey = key;
      this.publish({ telemetry });
    }
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
