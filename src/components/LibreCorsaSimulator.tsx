"use client";

import { CareerScreen } from "@/components/career/CareerScreen";
import { useCareerDrive } from "@/components/career/useCareerDrive";
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl/react";
import { t as tr } from "@/i18n/runtime";
import { DEFAULT_TRACK_ID, TURN_METADATA, getActivePointToPoint, getActiveTrackData, resolveLivery } from "@/lib/track-data";
import { FfbPairPrompt } from "@/components/hud/FfbPairPrompt";
import { DualSensePairPrompt } from "@/components/hud/DualSensePairPrompt";
import { OverheadNameplates } from "@/components/hud/OverheadNameplates";
import type { OverheadNameplatesSink } from "@/lib/render/overhead-nameplates";
import { isVehicleModelId, vehicleModelsFor } from "@/lib/cars/vehicle-models";
import { CARS, carById, carClass, carForVehicle, carsForClassRule, listedVehiclesForClassRule, type CarId } from "@/lib/cars/car-registry";
import { alignGhostToTrack } from "@/lib/sim/ghost-align";
import { carPhysics, carTakesPhysicsSwitch, subscribeF1ModPhysics } from "@/lib/cars/f1-mod-physics";
import { type ChassisSetup, saveChassisSetup } from "@/lib/sim/car-setup";
import { TrackEnvironment } from "@/lib/sim/track-environment";
import { installErrorLog } from "@/lib/diagnostics/error-log";
import { collectReportFacts } from "@/lib/diagnostics/report-facts";
import type { ReportFacts } from "@/lib/diagnostics/report-details";
import { carMaker, circuitMaker } from "@/lib/modders";
import { isStoreBuild } from "@/lib/store-mode";
import { markShown, markThanked, promptFor, readPromptState, writePromptState, type PromptItem } from "@/lib/support-prompt";
import {
  getMultiplayerManager,
  isVehicleAllowed,
  isVehicleRestricted,
  vehicleClassOf,
  type CarClassRule,
  type LobbySettings,
  type LobbyState,
  type PeerNetStats,
  type RaceStartInfo,
  type RoomSessionInfo,
  type ScheduledRaceStatus,
  type VehicleRule,
} from "@/lib/sim/multiplayer-sync";
import { boardStateOf, watchOnlineConfig, type BoardState } from "@/lib/net/online-config";
import { DEFAULT_RACE_SLOT_S } from "@/lib/net/race-schedule";
import { MultiplayerRace } from "@/lib/sim/race-session";
import { GhostPlayer } from "@/lib/sim/lap-recorder";
import { currentBoardBase, lapBoardClass, lapConditionsNow, lapGoesOnBoards, type LapConditions, type LapRecording, type LapSummaryData, type LeaderboardEntry } from "@/lib/sim/lap-types";
import { exportLapFile, importLapFile, listBestLaps, loadBestLap, loadLatestLap, saveBestLapIfFaster, saveLatestLap } from "@/lib/sim/ghost-store";
import { recordDrivingTime, recordLapDistance } from "@/lib/sim/driver-stats";
import { sectorSplitsFromSamples, selectCarBestLap, type SessionLapEntry } from "@/lib/sim/lap-analysis";
import { LapTelemetryModal } from "@/components/hud/LapTelemetryModal";
import {
  boardKeyOf,
  boardStatusOf,
  fetchRemoteBoard,
  fetchRemoteGhost,
  lapToEntry,
  loadBoardBest,
  loadChallengeBest,
  localLeaderboard,
  lookupDriverByKey,
  renameOnBoard,
  saveBoardMiss,
  MOD_LAP,
  type SubmitResult,
} from "@/lib/net/leaderboard";
import { boardWords } from "@/lib/net/board-words";
import { challengeOf, flushQueuedLaps, postLap } from "@/lib/net/board-queue";
import { applyImportedDriverIdentity, exportDriverKeyFile, importDriverKeyFile, resolveImportedDriverName } from "@/lib/net/driver-key";
import {
  MIDDLE_GEAR_CHALLENGE,
  challengeAt,
  isPermanentChallenge,
  timeTrialEventById,
  type TimeTrialEvent,
} from "@/lib/net/weekly-challenge";
import { countUsageLap, useUsageCounter } from "@/lib/net/use-usage-counter"; // polish:E
import { timeTrialRules } from "@/lib/sim/time-trial";
import { challengeTarget, type ChallengeTarget } from "@/lib/net/challenge-target";
import { isTouchDevice, resetTouchInput } from "@/lib/input/touch-input";
import { isFatalHidStatus } from "@/lib/input/webhid-ffb";
import { SIM_REALISM_FLAGS, type SimRealism } from "@/lib/sim/sim-realism";
import { applyConditionsChoice, effectiveConditions, resolveTimeOfDay, type RoomConditionsOverride, type SessionConditions } from "@/lib/sim/weather";
import { getTrackInfo, LISTED_TRACKS, trackDefaultTimeOfDay, TRACKS } from "@/lib/track-registry";
import { roomTrackStatus } from "@/lib/mods/room-content";
import { requestShellSync } from "@/lib/service-worker";
import { F1TelemetryHud } from "@/components/F1TelemetryHud";
import { roomFromUrl } from "@/lib/net/invite-room";
import { CAMERA_MODES, DEFAULT_DRIVING_CAMERA, nextCameraMode } from "@/lib/render/camera-modes";
import { clampTyreSetup, saveTyreSetup } from "@/lib/sim/tyre-setup";
import { garageTunerFrom, resolveSetupForCar, summarizeSharedSetup } from "@/lib/sim/setup-share";
import { LoadingScreen } from "@/components/menu/LoadingScreen";
import { TitleMenu } from "@/components/menu/TitleMenu";
import { useUpdateAutoReload } from "@/components/menu/UpdateReady";
import { carBoardTag } from "@/components/menu/menu-content-ui";
import { FirstRunWizard, type WizardMode, type WizardStepId } from "@/components/menu/FirstRunWizard";
import { SettingsScreen, type SettingsCategory } from "@/components/settings/SettingsScreen";
import type { SettingsEnv } from "@/components/settings/env";
import { applyInterfaceSettings } from "@/lib/settings/ui-prefs";
import { keyLabel, padButtonLabel, pressPedalText } from "@/lib/input/bindings";
import { useKeyLayout } from "@/lib/input/use-key-layout";
import { autoConfigureWheel, connectedPads } from "@/lib/input/device-input";
import { dualSenseHid } from "@/lib/input/webhid-dualsense";
import { dualShock4Hid } from "@/lib/input/webhid-dualshock4";
import { webHidFfb, wheelFfb } from "@/lib/input/wheel-ffb";
import { nameProblem } from "@/lib/net/name-filter";
import { loadCarChoice, saveCarChoice } from "@/lib/settings/car-choice";
import { clampFov, codeFromName, confirmDriverProfileName, DEFAULT_PLAYER_SETTINGS, loadOnboarded, loadPlayerSettings, loadRumble, needsDriverNamePrompt, parsePlayerSettings, pushLibraryRecent, saveOnboarded, toggleLibraryFavorite, type LibraryKind, sanitizeDriverName, savePlayerSettings, saveRumble, type BoardWidgetMode, type PlayerSettings } from "@/lib/settings/player-settings";
import { signalBoardLap } from "@/components/hud/BoardWidget";
import type { AeroSetupPreset, AssistPreset, CameraMode, LiveTunerPatch, LiveryConfig, PitStrategyState, TireCompound, TyreSetup, VehicleModelId } from "@/types/f1";
import { aiFieldOf, autoCompoundFor, DEFAULT_AERO_PRESET, DriveSession, idleDriveSnapshot, mpRaceOf, WebGLUnavailableError, type AppPhase, type SessionRace } from "@/lib/drive-session";
import { GpuLostNotice } from "@/components/menu/GpuLostNotice";
import { NowPlayingToast } from "@/components/hud/NowPlayingToast";
import { browserStore, lostRecently, probeRenderer, settleLoss } from "@/lib/render/gpu-health";
import { startAiRace, type RaceSetup } from "@/lib/sim/race-setup";
import type { PodiumUi } from "@/lib/render/podium-shot";
import { idleShowUi } from "@/lib/render/pre-race-show";
import { useRaceHistory } from "@/components/hud/useRaceHistory";
import { isNudgeView, markSeatHintSeen, nudgeOf, seatHintSeen, stepNudge, type CameraNudge, type NudgeView } from "@/lib/settings/camera-nudges";
import { dashViewFovDeg } from "@/lib/render/onboard-views";
import { SeatPanel } from "@/components/hud/SeatPanel";
import { TripleScreenPrompt } from "@/components/hud/TripleScreenPrompt";
import { centreFrame, setUiFrame, UI_FRAME_ID, type UiFrame } from "@/lib/display/ui-frame";
import { physicalVerticalFovDeg, screenRig, tripleFits } from "@/lib/display/screen-layout";
import { accountActions, useAccountState } from "@/lib/account/account-store";

const DEFAULT_ASSIST_PRESET: AssistPreset = DEFAULT_PLAYER_SETTINGS.assistPreset;
/** A lap record's car: records are per vehicle model, named after its first car */
// The rigid-body model's board holds the laps of every ported F1 car on it, and the model has no car of its own
const vehicleLabel = (id: string) =>
  id === "f12026-car" ? tr("game.simulator.formulaTeamCars") : isVehicleModelId(id) ? carForVehicle(id).title : id;
/** Every personal best in this browser (Lap times switches circuit and car without reloading the scene) */
const loadAllLocalLaps = () => listBestLaps().then((laps) => laps.map((lap) => lapToEntry(lap, "local")));
/** The place an upload's answer gives the lap on its board (and on the week's challenge); null when it failed or said none */
const placeOf = (res: SubmitResult): { rank: number; total: number | null; challengeRank: number | null } | null =>
  res.ok && res.rank !== undefined ? { rank: res.rank, total: res.total ?? null, challengeRank: res.eventRank ?? null } : null;
/** The car a week's challenge or its races are driven in: the one it names when this copy lists it, else the vehicle's */
const weekCar = (rules: { vehicle: VehicleModelId; car?: string }) => CARS.find((c) => c.id === rules.car && c.physics === rules.vehicle) ?? carForVehicle(rules.vehicle);
/** The car to take for a race in `vehicle`: the week's in a scheduled race, the vehicle's in any other */
const raceCarFor = (vehicle: VehicleModelId, scheduled: boolean) => {
  const race = challengeAt(Date.now()).race;
  return scheduled && race.vehicle === vehicle ? weekCar(race) : carForVehicle(vehicle);
};
/**
 * The car to take for a room's rule: null when the one driven is allowed, else the race's one car or the first listed
 * car the class lets in (null too when this copy lists none)
 */
const roomCarSwitch = (rule: { vehicle?: VehicleModelId; carClass: CarClassRule }, current: VehicleModelId): VehicleModelId | null => {
  if (rule.vehicle) return current === rule.vehicle ? null : rule.vehicle;
  if (vehicleModelsFor(rule.carClass).includes(current)) return null;
  return listedVehiclesForClassRule(rule.carClass)[0] ?? null;
};
/**
 * The game's own car to race in place of a mod car, or null when the car may race: the others see a car by its
 * vehicle model only, so no mod car runs in a scheduled race (an official result), and none with physics of its own
 * runs in any room
 */
const modCarSwap = (car: CarId, scheduled: boolean): CarId | null => {
  const def = carById(car);
  return def.mod && (scheduled || def.simProfile) ? raceCarFor(def.physics, scheduled).id : null;
};
/** Human-readable name for a room's car class or spec vehicle lock */
const vehicleRuleLabel = (rule: VehicleRule): string => {
  if (rule.vehicle) return vehicleLabel(rule.vehicle);
  return rule.carClass === "any" ? tr("hud.multiplayerPanel.anyCar") : carClass(rule.carClass).title;
};
/** The listed cars a room's class rule lets in, as the lobby offers them */
const classCars = (rule: CarClassRule) => carsForClassRule(rule).map((c) => ({ id: c.id, title: c.title }));
/** The lap card's upload state for a board answer: sent, nothing to show, waiting for the board, or turned down */
const cardStateOf = (res: SubmitResult, quietNotFaster: boolean): "idle" | "sent" | "error" | "waiting" =>
  res.ok ? "sent" : res.notFaster && quietNotFaster ? "idle" : res.unreachable ? "waiting" : "error";
// A lap on a circuit this build no longer lists keeps its id as its name (getTrackInfo would name it after another)
const trackNameOf = (id: string) => TRACKS.find((t) => t.id === id)?.name ?? id;
/** A circuit's name for the weekly challenge and its races, with the layout when the venue has more than one */
const challengeTrackName = (id: string) => {
  const t = getTrackInfo(id);
  return TRACKS.some((o) => o.id !== t.id && o.name === t.name) ? `${t.name} · ${t.layout}` : t.name;
};
/** Every listed circuit for the online board's picker, by name (the panel puts the loaded one first) */
const BOARD_CIRCUITS = LISTED_TRACKS.map((t) => ({ id: t.id, label: challengeTrackName(t.id) })).sort((a, b) => a.label.localeCompare(b.label));
/** The snapshot store before the session exists: nothing to subscribe to */
const noSubscribe = () => () => {};

// The bug report's error log starts with the game's page, before anything on it can fail
installErrorLog();
// polish:B the podium shot's view before the drive exists
const IDLE_PODIUM: PodiumUi = { stage: "idle", rows: [] };
const idlePodium = () => IDLE_PODIUM;
const idleShow = () => idleShowUi;
const noShowTime = () => 0;
/** A race the host started before this circuit was loaded (or on another one): picked up once the scene has loaded */
/** A career round's car and lap are its own: the pause menu's car picker and corner jumps do nothing in one */
const noCarChange = () => {};
const noTurnJump = () => {};
let pendingRaceStart: RaceStartInfo | null = null;
/** Private-room qualifying started before this circuit loaded (or while on another circuit) */
let pendingQualifying: { id: string; trackId: string } | null = null;
/**
 * The weekly challenge to go out on once its circuit has loaded (asked for from another circuit's menu): its id, and
 * whether as a race against the AI (a scheduled race nobody else entered) rather than practice
 */
let pendingChallenge: { id: string; race: boolean } | null = null;
/**
 * The player's own assists, realism and weather while a challenge, a scheduled race or a career round has its own in
 * their place: put back when they leave the car for the menus. (Outside the component: going to the week's circuit
 * reloads it.) A copy is kept in storage too: the drive's rules are saved as the settings, so a tab closed mid-drive
 * would otherwise keep them; the next start puts the player's own back (`takeOwnRules`)
 */
let ownRules: Pick<PlayerSettings, "assistPreset" | "realism" | "conditions"> | null = null;
const OWN_RULES_KEY = "librecorsa.ownRules";
/** Keeps the player's own rules (`own`: the settings before the drive's) unless they are kept already */
function keepOwnRules(own: PlayerSettings): void {
  if (ownRules) return;
  ownRules = { assistPreset: own.assistPreset, realism: own.realism, conditions: own.conditions };
  try {
    localStorage.setItem(OWN_RULES_KEY, JSON.stringify(ownRules));
  } catch {
    // Storage refused (private mode, full): kept for this page only
  }
}
/** The player's own rules to put back (this page's, or a closed tab's from storage), and forgets them */
function takeOwnRules(): Pick<PlayerSettings, "assistPreset" | "realism" | "conditions"> | null {
  let own = ownRules;
  ownRules = null;
  try {
    if (!own) {
      const raw = localStorage.getItem(OWN_RULES_KEY);
      own = raw ? (JSON.parse(raw) as typeof own) : null;
    }
    localStorage.removeItem(OWN_RULES_KEY);
  } catch {
    // Unreadable: nothing to put back
  }
  return own;
}
/** The circuit the simulator was last mounted on: a host's room follows the next circuit's own time of day from it */
let lastMountedTrackId: string | null = null;

export interface LibreCorsaSimulatorProps {
  /** Active circuit (already set with `setActiveTrack`; the gate remounts this component on a change) */
  trackId?: string;
  /** Title menu circuit picker */
  /** Switches circuit: settles once the load lands (the scene remounts) or fails (the old circuit stays) */
  /** `remember: false`: the circuit is for this drive only (a career round), not the one the game opens on next */
  onSelectTrack?: (id: string, opts?: { remember?: boolean }) => void | Promise<void>;
  /** Mounts the circuit again from scratch (a new canvas and WebGL context), after the GPU context was lost */
  onRestart?: () => void;
}

export const LibreCorsaSimulator: React.FC<LibreCorsaSimulatorProps> = ({ trackId = DEFAULT_TRACK_ID, onSelectTrack, onRestart }) => {
  const tx = useTranslations("game.simulator");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nameplatesRef = useRef<OverheadNameplatesSink | null>(null);
  /** The drive on the mounted circuit: the scene, the car and the frame loop (created once the container exists) */
  const [session, setSession] = useState<DriveSession | null>(null);
  const sessionRef = useRef<DriveSession | null>(null);
  sessionRef.current = session;
  /** The browser gave this page no WebGL context: only a page reload (or a browser restart) can bring it back */
  const [webglRefused, setWebglRefused] = useState(false);

  const track = useMemo(() => getActiveTrackData(1200), []);
  /** The chosen car, and the vehicle model it drives on */
  const [carId, setCarId] = useState<CarId>(loadCarChoice);
  const carIdRef = useRef(carId);
  const [vehicleModel, setVehicleModel] = useState<VehicleModelId>(() => carPhysics(carId));
  const vehicleModelRef = useRef(vehicleModel);
  /** The kind of session on track (practice, an AI race or an online race), for the menus; the session sets it */
  const [raceKind, setRaceKind] = useState<SessionRace["kind"]>("practice");
  /** Track evolution and aero wake for every car on the circuit (the player's in every mode); an AI field shares it */
  const trackEnvRef = useRef<TrackEnvironment | null>(null);
  /**
   * The player's own conditions on this circuit: a night circuit starts at night until they pick a time of day
   * themselves (`resolveTimeOfDay`). Everything that reads their conditions reads these; the saved ones stay as picked
   */
  const trackTimeOfDay = useMemo(() => trackDefaultTimeOfDay(trackId), [trackId]);
  const ownConditionsNow = useCallback(
    () => resolveTimeOfDay(settingsRef.current.conditions, settingsRef.current.timeOfDayChosen, trackTimeOfDay),
    [trackTimeOfDay]
  );
  const getTrackEnv = useCallback(
    () => (trackEnvRef.current ??= new TrackEnvironment(track, ownConditionsNow())),
    [track, ownConditionsNow]
  );

  /** What the drive shows the UI (telemetry, replay bar, weather, the car's setup …): one subscription to the session */
  const [idleSnapshot] = useState(() => idleDriveSnapshot(track));
  const {
    telemetry,
    replay: replayUi,
    steerLockDeg,
    carCockpitFovDeg: carCockpitFov,
    virtualMirror: virtualMirrorOn,
    weather: weatherHud,
    assetsReady,
    p2pStatus,
    vr: vrState,
    muted,
    paused,
    pauseNotice,
    seatPanel,
    boostLatch,
    tireCompound,
    tyreSetup,
    defaultTyreSetup,
    chassisSetup,
    timeTrial,
    autoQualityLowered,
    qualityNotice,
    gpuLost,
    nowPlaying,
    cameraOverride,
    replayAvailable,
    qualifying,
  } = useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.getSnapshot ?? (() => idleSnapshot), () => idleSnapshot);

  const [aeroPreset, setAeroPreset] =
    useState<AeroSetupPreset>(DEFAULT_AERO_PRESET);
  const [gamepadRumble, setGamepadRumble] = useState<boolean>(loadRumble);
  useEffect(() => {
    session?.setRumble(gamepadRumble);
  }, [session, gamepadRumble]);

  const [phase, setPhaseState] = useState<AppPhase>("loading");
  const phaseRef = useRef<AppPhase>("loading");
  const setPhase = useCallback(
    (next: AppPhase) => {
      phaseRef.current = next;
      setPhaseState(next);
      session?.setPhase(next);
    },
    [session]
  );
  // The session takes the phase on once it exists too (setPhase above tells it of every change at once)
  useEffect(() => {
    session?.setPhase(phaseRef.current);
  }, [session]);
  /** The loading screen stays mounted while it fades out over the title menu */
  const [loadingVisible, setLoadingVisible] = useState(true);
  const [settings, setSettings] = useState<PlayerSettings>(DEFAULT_PLAYER_SETTINGS);
  // Key names in hints follow the keyboard layout (AZERTY's KeyW is "Z"): re-render once it is read
  useKeyLayout();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // The preferences the game applies to the car and the camera: `settings` is their only copy
  const assistPreset = settings.assistPreset;
  const showRacingLine = settings.racingLine;
  const gamepadAssist = settings.gamepadAssist;
  const autoGearbox = settings.autoGearbox;
  const mouseSteerEnabled = settings.mouseSteer;
  const selectedLivery = useMemo(
    () => resolveLivery(settings.liveryId, settings.customLivery, carId),
    [settings.liveryId, settings.customLivery, carId]
  );
  const cameraMode: CameraMode = settings.camera ?? DEFAULT_DRIVING_CAMERA;
  const activeCameraMode: CameraMode = cameraOverride ?? cameraMode;
  const setPreference = useCallback(<K extends keyof PlayerSettings>(key: K, value: PlayerSettings[K]) => {
    setSettings((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);
  const setCameraMode = useCallback((mode: CameraMode) => {
    if (mode === "free") {
      sessionRef.current?.setCameraOverride("free");
      return;
    }
    sessionRef.current?.setCameraOverride(null);
    setPreference("camera", mode);
  }, [setPreference]);
  const toggleFreeCamera = useCallback(() => {
    sessionRef.current?.toggleFreeCamera();
  }, []);
  const toggleTvCamera = useCallback(() => {
    sessionRef.current?.toggleTvCamera();
  }, []);
  // The session takes the settings on whenever they change, and once it exists (whichever comes first)
  useEffect(() => {
    session?.applySettings(settings);
  }, [session, settings]);
  /** Saved settings have been read and applied (saving before that would overwrite them with defaults) */
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [onboarded, setOnboarded] = useState(false);
  const [wizardMode, setWizardMode] = useState<WizardMode>("first-run");
  /** Where the controls setup returns to */
  const wizardReturnRef = useRef<"title" | "pause">("title");
  /** First-run setup started from "Race AI" rather than "Drive" */
  const pendingRaceRef = useRef(false);
  const [launchHint, setLaunchHint] = useState(false);
  const [inviteRoom, setInviteRoom] = useState<string | null>(null);

  // ---- Multiplayer lobby and races
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [peerStats, setPeerStats] = useState<PeerNetStats[]>([]);
  /** Banner/toast shown when joining a class-locked lobby auto-switches the player's car or blocks a mismatched pick */
  const [mpCarNotice, setMpCarNotice] = useState<{ seq: number; text: string } | null>(null);
  const mpCarNoticeSeqRef = useRef(0);
  const showMpCarNotice = useCallback((text: string) => {
    setMpCarNotice({ seq: ++mpCarNoticeSeqRef.current, text });
  }, []);
  useEffect(() => {
    if (!mpCarNotice) return;
    const timer = window.setTimeout(() => setMpCarNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [mpCarNotice]);
  /** The results card was closed for this race */
  const [resultsClosed, setResultsClosed] = useState(false);

  // ---- Laps, ghosts, leaderboards
  const [lapSummary, setLapSummary] = useState<{ summary: LapSummaryData; recording: LapRecording } | null>(null);
  const [sessionLaps, setSessionLaps] = useState<SessionLapEntry[]>([]);
  const [allTimeBestLap, setAllTimeBestLap] = useState<LapRecording | null>(null);
  const [latestLap, setLatestLap] = useState<LapRecording | null>(null);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const trackTurns = useMemo(() => [...TURN_METADATA], [track]);
  const trackSectorSplitsM = useMemo(
    () => sectorSplitsFromSamples(track.samples, track.pointToPoint?.finishS ?? track.totalLengthM),
    [track],
  );
  const [submitState, setSubmitState] = useState<"idle" | "sending" | "sent" | "error" | "waiting">("idle");
  /** Place of the uploaded lap on its board, and how many drivers that board has */
  const [submitRank, setSubmitRank] = useState<ReturnType<typeof placeOf>>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** A name the board turned down (taken by another driver): laps under it are not sent again until it changes */
  const refusedNameRef = useRef<{ name: string; error: string } | null>(null);
  /** The uploads on their way, which a rename waits for (so their laps move with the rest) */
  const uploadingRef = useRef<Promise<unknown> | null>(null);
  /** Adds an upload or a flush to what a rename waits for, without dropping one still in flight */
  const trackUpload = (p: Promise<unknown>) => {
    const prev = uploadingRef.current;
    const all: Promise<unknown> = prev ? Promise.allSettled([prev, p]) : p;
    uploadingRef.current = all;
    const clear = () => {
      if (uploadingRef.current === all) uploadingRef.current = null;
    };
    all.then(clear, clear);
  };
  /** Bumped by every new or closed lap card and every upload: only the upload of the card still shown may land on it */
  const submitReqRef = useRef(0);
  /** The card's lap while it waits for the board (and the card's request then): sent later, its answer lands there */
  const waitingCardRef = useRef<{ req: number; recordedAt: number } | null>(null);
  const [driverKeyNotice, setDriverKeyNotice] = useState<string | null>(null);
  /** Bumped on every key import so a slower lookup from an earlier file never overwrites a newer import */
  const keyImportReqRef = useRef(0);
  const ghostSourceRef = useRef<"pb" | "other">("pb");
  /** Bumped by every ghost choice, so a slower PB load cannot replace a ghost picked after it started */
  const ghostReqRef = useRef(0);
  /** Bumped by every leaderboard refresh; only the latest one updates the panel */
  const leaderboardReqRef = useRef(0);
  /** This car's best laps on this circuit, saved in this browser */
  const [localLaps, setLocalLaps] = useState<LeaderboardEntry[]>([]);
  /** Bumped when the online board may have changed (a lap went up), so the panel reads it again */
  const [boardVersion, setBoardVersion] = useState(0);
  /**
   * The online lap board: on, turned off, or not reached yet (null before the first answer). Followed, not asked once:
   * a read that failed at start used to keep lap posting off for the whole session (issue #122)
   */
  const [boardState, setBoardState] = useState<BoardState | null>(null);
  const boardStateRef = useRef<BoardState | null>(null);
  const boardOn = boardState === "on";
  /** Scheduled races run on this site, and how often (seconds) */
  const [races, setRaces] = useState<{ on: boolean; slotS: number }>({ on: false, slotS: DEFAULT_RACE_SLOT_S });
  /** This player's entry in the next scheduled race */
  const [raceEntry, setRaceEntry] = useState<ScheduledRaceStatus>({ state: "idle", startsMs: null, text: "" });
  /** Sends the laps that couldn't reach the board (set below, once what it needs is there) */
  const flushQueuedRef = useRef<() => void>(() => {});
  useEffect(
    () =>
      watchOnlineConfig((online) => {
        const board = boardStateOf(online);
        boardStateRef.current = board;
        setBoardState(board);
        setRaces({ on: online.config.races, slotS: online.config.raceSlotS });
        // The board answers, at start or after it was out of reach: the laps waiting for it go up
        if (online.reach === "ok" && board === "on") flushQueuedRef.current();
      }),
    []
  );

  // ---- VR, FFB meter
  const [vrSupported, setVrSupported] = useState(false);
  const [ffbMeter, setFfbMeter] = useState(wheelFfb.meter);
  const [touchVisible, setTouchVisible] = useState(false);

  /** The next view in the camera cycle, from the key, the pad, the touch pads and the menus alike */
  const cycleCamera = useCallback(() => {
    const snap = sessionRef.current?.getSnapshot();
    if (snap?.replay.active) {
      // Replay camera cycling is transient and never overwrites the player's saved driving camera
      const cur = snap.cameraOverride ?? settingsRef.current.camera ?? DEFAULT_DRIVING_CAMERA;
      sessionRef.current?.setCameraOverride(cur === "free" ? (settingsRef.current.camera ?? DEFAULT_DRIVING_CAMERA) : nextCameraMode(cur));
      return;
    }
    if (snap && snap.cameraOverride !== null) {
      sessionRef.current?.setCameraOverride(null);
      return;
    }
    setSettings((prev) => ({ ...prev, camera: nextCameraMode(prev.camera ?? DEFAULT_DRIVING_CAMERA) }));
  }, []);

  // ---- Session and run: the one place that starts, restarts and leaves what is on track (the session resets the run)
  /** When replay was launched from RaceResults, exiting replay restores the results overlay */
  const returnToResultsRef = useRef(false);
  const prevReplayActiveRef = useRef(false);
  useEffect(() => {
    const wasActive = prevReplayActiveRef.current;
    prevReplayActiveRef.current = replayUi.active;
    if (wasActive && !replayUi.active && returnToResultsRef.current) {
      returnToResultsRef.current = false;
      setResultsClosed(false);
    }
  }, [replayUi.active]);
  const handleWatchRaceReplay = useCallback(() => {
    if (!sessionRef.current) return;
    if (sessionRef.current.openReplay({ fromStart: true, play: true })) {
      returnToResultsRef.current = true;
      setResultsClosed(true);
    }
  }, []);
  const handleOpenPauseReplay = useCallback(() => {
    const sess = sessionRef.current;
    if (!sess) return;
    // If already watching a replay, unpausing returns to the exact scrubbed position instead of resetting to the end
    if (sess.getSnapshot().replay.active) return;
    sess.openReplay({ fromStart: false, play: false });
  }, []);
  /** A new run re-opens the race results card */
  const onRunReset = useCallback(() => {
    returnToResultsRef.current = false;
    setResultsClosed(false);
  }, []);

  /** What belongs to a whole session: the lap card and its upload, the pause and its notice, the boost latch, the hint */
  const clearSessionState = useCallback(() => {
    submitReqRef.current++;
    setLapSummary(null);
    setSubmitState("idle");
    setSubmitRank(null);
    setSubmitError(null);
    setLaunchHint(false);
    session?.endPause();
    session?.setBoostLatch(false);
  }, [session]);

  /**
   * A session starts on track: practice, a race against the AI field, or a multiplayer race. The caller places the
   * car (and starts the field) afterwards.
   */
  const startSession = useCallback(
    (race: SessionRace) => {
      session?.resetRun("session");
      session?.setRace(race);
      // A fresh session on a fresh track: baseline rubber, no marbles, the weather from its start (an AI race's start
      // and restarts reset it again, as the field always has)
      getTrackEnv().reset();
      clearSessionState();
      setPhase("driving");
    },
    [session, getTrackEnv, clearSessionState, setPhase]
  );

  /**
   * The multiplayer race ends here: the host aborted it (the manager already knows), or the player left it
   * (`tellManager`). Driving goes on, alone.
   */
  const endMpRace = useCallback(
    (tellManager: boolean) => {
      if (session?.race.kind !== "mp") return;
      // A host who has taken the flag leaves the others to finish: their race goes on, only this client steps out.
      // A host leaving mid-race (or once everyone is classified) ends it for all, as an abort.
      const race = session.car.telemetry.race;
      const othersStillRacing = race?.phase === "finished" && !race.resultsFinal;
      const leaveForAll = tellManager && !(isMpHostRef.current && othersStillRacing);
      // Off the race before the manager hears: a host's leave comes back as an abort, which must find nothing to end
      session.setRace({ kind: "practice" });
      if (leaveForAll) getMultiplayerManager().leaveRace();
      session.resetRun("race");
    },
    [session]
  );

  /** Leaves the car for the title menu: out of any race (the multiplayer one properly), the car back on the grid */
  const leaveSession = useCallback(() => {
    endMpRace(true);
    // The week's rules were only for that drive: the player's own assists, realism and weather are back
    const own = takeOwnRules();
    if (own) setSettings((prev) => ({ ...prev, ...own }));
    session?.resetRun("session");
    session?.setRace({ kind: "practice" });
    clearSessionState();
    session?.car.resetToStartGrid(false);
    setPhase("title");
    accountActions.pushSoon();
  }, [session, endMpRace, clearSessionState, setPhase]);



  const handleAeroPresetChange = useCallback((preset: AeroSetupPreset) => {
    setAeroPreset(preset);
    if (session) session.car.aeroPreset = preset;
  }, [session]);

  // The preferences only change the settings: the session applies them to the car and the scene
  const handleAssistPresetChange = useCallback((preset: AssistPreset) => setPreference("assistPreset", preset), [setPreference]);

  const handleToggleGamepadAssist = useCallback(() => {
    setSettings((prev) => ({ ...prev, gamepadAssist: !prev.gamepadAssist }));
  }, []);

  const handleToggleGamepadRumble = useCallback(() => {
    const next = !gamepadRumble;
    setGamepadRumble(next);
    saveRumble(next);
  }, [gamepadRumble]);

  const handleTireCompoundChange = useCallback((compound: TireCompound) => session?.setTireCompound(compound), [session]);
  const handlePitStrategy = useCallback((patch: Partial<PitStrategyState>) => session?.setPitStrategy(patch), [session]);

  const handleChangeTyreSetup = useCallback((next: TyreSetup) => {
    session?.setTyreSetup(next);
    saveTyreSetup(vehicleModelRef.current, next);
  }, [session]);

  const handleChangeChassisSetup = useCallback((next: ChassisSetup) => {
    session?.setChassisSetup(next);
    saveChassisSetup(vehicleModelRef.current, next);
  }, [session]);

  /** Swaps the player's car (the run starts over with it); the player's own pick goes through handleChangeCar */
  const changeCar = useCallback(
    (next: CarId, opts?: { remember?: boolean }) => {
      session?.unlockAudio();
      if (next === carIdRef.current) return;
      carIdRef.current = next;
      setCarId(next);
      vehicleModelRef.current = carPhysics(next);
      setVehicleModel(vehicleModelRef.current);
      setSetupBoardNotice(null);
      // A career round's car is the round's: the player's own choice stays saved
      if (opts?.remember !== false) saveCarChoice(next);
      session?.setCar(next);
    },
    [session]
  );
  /** Auto-switches the player into an allowed car for a class/spec-locked lobby and shows a clear banner */
  const enforceLobbyCar = useCallback(
    (rule: VehicleRule, scheduled: boolean): boolean => {
      if (!isVehicleRestricted(rule)) return false;
      const switchTo = roomCarSwitch(rule, vehicleModelRef.current);
      if (!switchTo) return false;
      const target = raceCarFor(switchTo, scheduled);
      changeCar(target.id);
      showMpCarNotice(tr("game.simulator.carAutoSwitched", { car: target.title, rule: vehicleRuleLabel(rule) }));
      return true;
    },
    [changeCar, showMpCarNotice]
  );


  /** The career: its save, its screen and the rounds driven for it (career/useCareerDrive.ts) */
  const career = useCareerDrive({
    session,
    trackId,
    assetsReady,
    race: telemetry.race,
    pit: telemetry.pit,
    raceIsAi: raceKind === "ai",
    settingsRef,
    carIdRef,
    changeCar,
    startSession,
    leaveSession,
    onSelectTrack,
    leaveLoading: () => {
      if (phaseRef.current !== "loading") return;
      session?.unlockAudio();
      setLoadingVisible(false);
    },
    setLaunchHint,
    // As the week's challenge does: the player's own conditions are kept and come back on leaving (leaveSession)
    applyConditions: (c) => {
      keepOwnRules(settingsRef.current);
      setSettings((prev) => ({ ...prev, conditions: { ...prev.conditions, weather: c.weather, timeOfDay: c.timeOfDay, weatherNodes: undefined, timeScale: 0 } }));
    },
  });
  /** The car picker: fixed for a multiplayer race, and restricted to the lobby's car class/spec while in a locked room */
  const handleChangeCar = useCallback(
    (next: CarId) => {
      if (session?.race.kind === "mp") return;
      const activeSettings = getMultiplayerManager().lobby?.settings;
      if (activeSettings && isVehicleRestricted(activeSettings) && !isVehicleAllowed(carPhysics(next), activeSettings)) {
        showMpCarNotice(tr("game.simulator.carBlockedByLobby", { rule: vehicleRuleLabel(activeSettings) }));
        return;
      }
      changeCar(next);
    },
    [session, changeCar, showMpCarNotice]
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
        session?.setCar(car);
      }),
    [session]
  );

  const handleLiveryChange = useCallback((livery: LiveryConfig) => {
    if (livery.id === "custom") {
      setSettings((prev) => ({
        ...prev,
        liveryId: "custom",
        // Keep the user's saved custom colours when switching back to Custom from a preset;
        // overwrite them only while editing the colour pickers on Custom.
        customLivery:
          prev.liveryId === "custom"
            ? { primary: livery.primary, secondary: livery.secondary, accent: livery.accent }
            : prev.customLivery,
      }));
      return;
    }
    setPreference("liveryId", livery.id);
  }, [setPreference]);

  const handleToggleRacingLine = useCallback(() => {
    setSettings((prev) => ({ ...prev, racingLine: !prev.racingLine }));
  }, []);

  const handleToggleMute = useCallback(() => session?.toggleMute(), [session]);
  // The music alone: a press also unlocks the audio, so the first press on a silent menu starts the music
  const handleToggleMusicMute = useCallback(() => {
    session?.unlockAudio();
    setSettings((prev) => ({ ...prev, audio: { ...prev.audio, musicMuted: !prev.audio.musicMuted } }));
  }, [session]);

  const handleToggleAiAutopilot = useCallback(() => {
    session?.unlockAudio();
    session?.toggleAutopilot();
  }, [session]);

  // The on-screen aero button sends the same input as the key, pad and touch button (the car toggles on it)
  const handleToggleXMode = useCallback(() => {
    session?.unlockAudio();
    session?.runAction("aero");
  }, [session]);

  const handleToggleBoostLatch = useCallback(() => {
    session?.unlockAudio();
    session?.runAction("boostLatch");
  }, [session]);

  const handleOvertake = useCallback(() => {
    session?.unlockAudio();
    session?.runAction("overtake");
  }, [session]);

  const handleChangeLiveTuner = useCallback((patch: LiveTunerPatch) => session?.setLiveTuner(patch), [session]);

  const handleToggleMouseSteer = useCallback(() => {
    session?.unlockAudio();
    setSettings((prev) => ({ ...prev, mouseSteer: !prev.mouseSteer }));
  }, [session]);

  /** This client hosts the multiplayer lobby (the one derivation: the lobby's host is us) */
  const isMpHostRef = useRef(false);

  const handleResetCar = useCallback(
    (flyingStart: boolean) => {
      session?.unlockAudio();
      if (!session) return;
      // In a multiplayer race only the host can restart it (for everyone); others keep their place
      const race = session.race;
      if (race.kind === "mp") {
        if (isMpHostRef.current && !flyingStart && !getActivePointToPoint()) getMultiplayerManager().startRace();
        return;
      }
      // polish:A — a flying restart outside a race puts the time trial's conditions on first
      if (race.kind === "practice" && flyingStart) return session.restartFlyingLap();
      const physics = session.car;
      if (race.kind === "ai" && !session.allowRestart()) return;
      session.resetRun("restart");
      // A restart from the menu uses the race's own start; the flying-lap key always gives a rolling one
      if (race.kind === "ai") startAiRace(race.field, session.raceSetup(), settingsRef.current.profile, flyingStart ? false : undefined);
      else physics.resetToStartGrid(flyingStart);
    },
    [session]
  );

  const handleToggleAiOpponents = useCallback(() => {
    session?.unlockAudio();
    // Not in a multiplayer race: the AI field would run alongside it. Not on a hill climb: one car at a time
    if (!session || session.race.kind === "mp" || getActivePointToPoint()) return;
    session.resetRun("race");
    if (session.race.kind === "ai") {
      session.setRace({ kind: "practice" });
      return;
    }
    const field = session.takeAiField();
    session.setRace({ kind: "ai", field });
    startAiRace(field, settingsRef.current.race, settingsRef.current.profile);
  }, [session]);

  const handleSelectTurn = useCallback(
    (turnNumber: number) => {
      session?.unlockAudio();
      if (!session || session.race.kind === "mp") return;
      session.resetRun("teleport");
      // Corner practice leaves the race: the field would otherwise lose track of the player's distance
      if (session.race.kind === "ai") session.setRace({ kind: "practice" });
      session.car.teleportToTurn(turnNumber);
    },
    [session]
  );

  // The page's one multiplayer manager (it outlives this component across circuit switches)
  /** Host-only temporary weather/time override edited in the MP lobby (never mutates saved SP settings) */
  const [roomConditions, setRoomConditions] = useState<RoomConditionsOverride | null>(() => {
    const mp = getMultiplayerManager();
    if (!mp.isHost || mp.inScheduledRace || !mp.lobby) return null;
    const { weather, timeOfDay, timeScale } = mp.lobby.settings;
    return weather !== undefined || timeOfDay !== undefined || timeScale !== undefined
      ? { weather, timeOfDay, timeScale }
      : null;
  });
  /** True when a guest's TrackEnvironment was synced to a host's weather/time, so leaving restores SP conditions */
  const guestWeatherSyncedRef = useRef(false);
  const restoreOwnConditionsNow = useCallback(() => {
    const env = getTrackEnv();
    const own = ownConditionsNow();
    env.setConditions(own);
    const car = session?.car;
    const autoCompound = autoCompoundFor(env.weather.lineWaterMm, car?.tireCompound);
    if (car && car.tireCompound !== autoCompound) handleTireCompoundChange(autoCompound);
  }, [getTrackEnv, ownConditionsNow, session, handleTireCompoundChange]);
  const syncHostConditionsToLobby = useCallback(() => {
    setRoomConditions(null);
    if (guestWeatherSyncedRef.current) {
      guestWeatherSyncedRef.current = false;
      restoreOwnConditionsNow();
    }
    const c = ownConditionsNow();
    getMultiplayerManager().setLobbySettings({ weather: c.weather, timeOfDay: c.timeOfDay, timeScale: c.timeScale });
  }, [restoreOwnConditionsNow, ownConditionsNow]);
  const handleHostP2PRoom = useCallback(() => {
    const code = getMultiplayerManager().hostRoom();
    syncHostConditionsToLobby();
    return code;
  }, [syncHostConditionsToLobby]);
  const handleJoinP2PRoom = useCallback((roomCode: string) => getMultiplayerManager().joinRoom(roomCode), []);
  const handleCreateManualOffer = useCallback(() => {
    const offer = getMultiplayerManager().createManualOffer();
    syncHostConditionsToLobby();
    return offer;
  }, [syncHostConditionsToLobby]);
  const handleAcceptManualOffer = useCallback(
    (offerToken: string) => getMultiplayerManager().acceptManualOfferAndCreateAnswer(offerToken),
    []
  );
  const handleAcceptManualAnswer = useCallback(async (answerToken: string) => {
    await getMultiplayerManager().acceptManualAnswer(answerToken);
    return true;
  }, []);

  const handleHostLocal = useCallback(() => {
    getMultiplayerManager().hostLocal();
    syncHostConditionsToLobby();
  }, [syncHostConditionsToLobby]);
  const handleSetLobbySettings = useCallback((patch: Partial<LobbySettings>) => {
    const mp = getMultiplayerManager();
    mp.setLobbySettings(patch);
    const updated = mp.lobby?.settings;
    if (updated && (patch.carClass !== undefined || patch.vehicle !== undefined)) {
      enforceLobbyCar(updated, mp.inScheduledRace);
    }
    if (patch.weather !== undefined || patch.timeOfDay !== undefined || patch.timeScale !== undefined) {
      setRoomConditions((prev) => ({
        ...prev,
        ...(patch.weather !== undefined ? { weather: patch.weather } : {}),
        ...(patch.timeOfDay !== undefined ? { timeOfDay: patch.timeOfDay } : {}),
        ...(patch.timeScale !== undefined ? { timeScale: patch.timeScale } : {}),
      }));
    }
  }, [enforceLobbyCar]);
  const handleSetReady = useCallback((ready: boolean) => getMultiplayerManager().setReady(ready), []);
  const handleStartMpRace = useCallback(() => {
    // A hill climb has no races: one car at a time, start to finish
    if (getActivePointToPoint()) return;
    getMultiplayerManager().startSession();
  }, []);
  const handleAbortMpRace = useCallback(() => getMultiplayerManager().abortRace(), []);

  /** Esc / pad Menu: open or close the pause menu, releasing every held key */
  const togglePause = useCallback(() => session?.togglePause(), [session]);

  const setRacingLineVisible = useCallback((visible: boolean) => setPreference("racingLine", visible), [setPreference]);
  const setGamepadAssistEnabled = useCallback((enabled: boolean) => setPreference("gamepadAssist", enabled), [setPreference]);
  const setAutoGearbox = useCallback((enabled: boolean) => setPreference("autoGearbox", enabled), [setPreference]);
  const setMouseSteer = useCallback((enabled: boolean) => setPreference("mouseSteer", enabled), [setPreference]);

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
    if (session) aiFieldOf(session.race)?.setSkill(aiSkill);
  }, [session]);

  /**
   * The race setup: saved, and used from the next start. The session builds a field of the new size, and restarts a
   * race running from the lights with it
   */
  const handleChangeRaceSetup = useCallback((patch: Partial<RaceSetup>) => {
    setSettings((prev) => ({ ...prev, race: { ...prev.race, ...patch } }));
  }, []);

  /** Weather and time of day: saved, and the session on track switches to them (the weather starts over) */
  const handleChangeConditions = useCallback((conditions: SessionConditions) => {
    // The panel shows the circuit's own time of day until the player picks one: only that pick is saved as theirs
    setSettings((prev) => ({
      ...prev,
      ...applyConditionsChoice(
        prev.conditions,
        prev.timeOfDayChosen,
        resolveTimeOfDay(prev.conditions, prev.timeOfDayChosen, trackTimeOfDay),
        conditions,
        trackTimeOfDay
      ),
    }));
    // If currently hosting a private room, propagate updated own conditions to the lobby so start.weather stays in sync
    const mp = getMultiplayerManager();
    if (mp.isHost && !mp.inScheduledRace) {
      setRoomConditions(null);
      mp.setLobbySettings({ weather: conditions.weather, timeOfDay: conditions.timeOfDay, timeScale: conditions.timeScale });
    }
  }, [trackTimeOfDay]);
  /** Simulation realism: saved, and every car on track takes it on its next step */
  const handleChangeRealism = useCallback((realism: SimRealism) => {
    setSettings((prev) => ({ ...prev, realism }));
  }, []);
  const ownConditions = useMemo(
    () => resolveTimeOfDay(settings.conditions, settings.timeOfDayChosen, trackTimeOfDay),
    [settings.conditions, settings.timeOfDayChosen, trackTimeOfDay]
  );
  const activeConditions = useMemo(
    () => effectiveConditions(ownConditions, roomConditions),
    [ownConditions, roomConditions]
  );
  const activeConditionsRef = useRef(activeConditions);
  activeConditionsRef.current = activeConditions;
  // A host's room that was on the last circuit's own time of day moves to this circuit's: picking a night circuit for
  // the room makes it a night race, and going back makes it a day one. A time the host set for the room stays
  const cameFromTrackRef = useRef<{ to: string; from: string | null } | null>(null);
  useEffect(() => {
    // Noted once per circuit (the effect runs again when the saved settings arrive, which it waits for)
    if (cameFromTrackRef.current?.to !== trackId) {
      cameFromTrackRef.current = { to: trackId, from: lastMountedTrackId };
      lastMountedTrackId = trackId;
    }
    const previous = cameFromTrackRef.current.from;
    if (!settingsHydrated || previous === null || previous === trackId) return;
    cameFromTrackRef.current = { to: trackId, from: null };
    const mp = getMultiplayerManager();
    if (!mp.isHost || mp.inScheduledRace || !mp.lobby) return;
    const { conditions, timeOfDayChosen } = settingsRef.current;
    const before = resolveTimeOfDay(conditions, timeOfDayChosen, trackDefaultTimeOfDay(previous)).timeOfDay;
    const now = ownConditionsNow().timeOfDay;
    if (before === now || mp.lobby.settings.timeOfDay !== before) return;
    setRoomConditions((prev) => (prev ? { ...prev, timeOfDay: undefined } : prev));
    mp.setLobbySettings({ timeOfDay: now });
  }, [settingsHydrated, trackId, ownConditionsNow]);
  const conditionsKey = JSON.stringify(activeConditions);
  useEffect(() => {
    if (guestWeatherSyncedRef.current) return;
    const env = getTrackEnv();
    const next = activeConditionsRef.current;
    if (JSON.stringify(env.weather.conditions) !== JSON.stringify(next)) {
      env.setConditions(next);
      const car = session?.car;
      const autoCompound = autoCompoundFor(env.weather.lineWaterMm, car?.tireCompound);
      if (car && car.tireCompound !== autoCompound) handleTireCompoundChange(autoCompound);
    }
  }, [conditionsKey, getTrackEnv, session, handleTireCompoundChange]);
  useEffect(() => {
    getTrackEnv().setSimRealism(SIM_REALISM_FLAGS[settings.realism]);
  }, [settings.realism, getTrackEnv]);

  const handleOffTrackGlow = useCallback((on: boolean) => session?.setOffTrackGlow(on), [session]);

  /** null returns to the car's own FOV */
  const handleCockpitFovChange = useCallback((fovDeg: number | null) => {
    setSettings((prev) => ({
      ...prev,
      cockpitFovDeg: fovDeg === null ? null : Math.round(clampFov(fovDeg)),
      // Picking a field of view by hand on three screens leaves the true one the screens give
      screens: prev.screens.mode === "triple" && prev.screens.physicalFov ? { ...prev.screens, physicalFov: false } : prev.screens,
    }));
  }, []);

  /** The seat panel's view: the one on screen (the panel switches to the cockpit from any other) */
  const seatView: NudgeView = isNudgeView(cameraMode) ? cameraMode : "cockpit";
  /** The seat panel: moves that view for the car being driven a step, or puts it back where the car puts it */
  const handleSeatStep = useCallback(
    (step: Partial<CameraNudge> | null) => {
      setSettings((prev) => ({ ...prev, cameraNudges: stepNudge(prev.cameraNudges, carId, seatView, step) }));
    },
    [carId, seatView]
  );

  /** Leaves the menus for the car: a practice run from the grid, or a race against the AI field */
  const startDriving = useCallback(
    (race: boolean) => {
      // A hill climb has no races: one car at a time, start to finish
      if (getActivePointToPoint()) race = false;
      const field = race && session ? (aiFieldOf(session.race) ?? session.takeAiField()) : null;
      // Qualifying first when the race setup asks for it: the player alone on a flying lap, the field waiting
      const qualifyingMin = settingsRef.current.race.qualifying;
      startSession(field && !qualifyingMin ? { kind: "ai", field } : { kind: "practice" });
      if (field && qualifyingMin) session?.startQualifying(field, qualifyingMin);
      else if (field) startAiRace(field, settingsRef.current.race, settingsRef.current.profile);
      else session?.car.resetToStartGrid(false);
      setLaunchHint(true);
    },
    [session, startSession]
  );

  // In the menus (after loading, after a race): have the next race's AI field ready (a car swap asks for its own).
  // Not before the loading screen has gone: the press that leaves it shows the menus first
  useEffect(() => {
    if (phase === "loading" || phase === "driving" || !assetsReady || loadingVisible) return;
    session?.prepareAiField();
  }, [session, phase, assetsReady, loadingVisible]);

  /** A time trial's or scheduled race's rules: assists, realism, and a dry track (car and circuit are the caller's to set) */
  const applyTrialRules = useCallback((trial: Pick<TimeTrialEvent, "assists" | "realism">) => {
    keepOwnRules(settingsRef.current);
    setSettings((prev) => ({
      ...prev,
      assistPreset: trial.assists,
      realism: trial.realism,
      conditions: { ...prev.conditions, weather: "clear", weatherNodes: undefined },
    }));
  }, []);
  const applyWeekRules = useCallback(() => applyTrialRules(challengeAt(Date.now())), [applyTrialRules]);

  /** A multiplayer race was started (by us as host, or by the host): line up in our grid slot behind the lights */
  const startMpRace = useCallback(
    (start: RaceStartInfo) => {
      const mp = getMultiplayerManager();
      const roster = mp.lobby?.players ?? [];
      const profile = settingsRef.current.profile;
      const race = new MultiplayerRace(start, track.totalLengthM, mp.localPeerId, profile, roster);
      // The official result: the finish goes to the race server or the host; a room's host keeps the book itself
      race.onFinish = (finish) => mp.sendRaceFinish(finish);
      if (mp.isHost && !mp.inScheduledRace) race.collectResults((result) => mp.sendRaceResult(result));
      startSession({ kind: "mp", race });
      // The class may rule out the current car, or the race names one car for everyone (a scheduled race): take it,
      // or the first allowed one (after the session reset, so the swap finds no replay or AI field to carry over)
      const switchTo = roomCarSwitch(start, vehicleModelRef.current);
      const modSwap = switchTo ? null : modCarSwap(carIdRef.current, mp.inScheduledRace);
      if (switchTo) changeCar(raceCarFor(switchTo, mp.inScheduledRace).id);
      else if (modSwap) changeCar(modSwap);
      // A scheduled race is driven to the week's rules: its assists and realism, a dry track
      if (mp.inScheduledRace) applyWeekRules();
      else if (!mp.isHost && !guestWeatherSyncedRef.current && (start.weather || start.timeOfDay || start.timeScale !== undefined)) {
        // Fallback for guests if the host did not send a live WeatherSyncState snapshot before race start
        const env = getTrackEnv();
        const cur = env.weather.conditions;
        const nextCond = effectiveConditions(cur, {
          weather: start.weather,
          timeOfDay: start.timeOfDay,
          timeScale: start.timeScale,
        });
        if (nextCond.weather !== cur.weather || nextCond.timeOfDay !== cur.timeOfDay || nextCond.timeScale !== cur.timeScale) {
          guestWeatherSyncedRef.current = true;
          env.setConditions(nextCond);
        }
      }
      const physics = session?.car;
      if (physics) {
        const rolling = start.startType === "rolling";
        physics.resetToStartGrid(rolling, race.gridSlot, rolling ? start.grid.length : undefined, true);
        race.lapClock.reset(physics.sMeters);
        if (rolling) race.startRollingFormation(physics.vxMs);
      }
    },
    [session, track, changeCar, startSession, applyWeekRules, getTrackEnv]
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
        if (!session?.getSnapshot().assetsReady) {
          pendingRaceStart = start;
          return;
        }
        session?.unlockAudio();
        setLoadingVisible(false);
      }
      startMpRaceRef.current(start);
    },
    [session]
  );

  /**
   * Enters private-room qualifying on this circuit. If the circuit is still loading, parks the qualifying session id
   * so it starts as soon as `assetsReady` becomes true (mirroring `takeRaceStart`).
   */
  const takeQualifyingStart = useCallback(
    (quali: RoomSessionInfo, expectedTrackId: string) => {
      if (!session || phaseRef.current === "loading") {
        if (!session?.getSnapshot().assetsReady) {
          pendingQualifying = { id: quali.id, trackId: expectedTrackId };
          return;
        }
        session.unlockAudio();
        setLoadingVisible(false);
      }
      const mp = getMultiplayerManager();
      const lobbyNow = mp.lobby;
      if (lobbyNow) {
        // The race's rules hold in qualifying too: the class's car, and no mod car with physics of its own
        const switchTo = roomCarSwitch(lobbyNow.settings, vehicleModelRef.current);
        const modSwap = switchTo ? null : modCarSwap(carIdRef.current, mp.inScheduledRace);
        if (switchTo) changeCar(raceCarFor(switchTo, mp.inScheduledRace).id);
        else if (modSwap) changeCar(modSwap);
      }
      startSession({ kind: "practice" });
      session.car.resetToStartGrid(true);
    },
    [session, changeCar, startSession]
  );

  // ---- Laps, ghosts, leaderboards
  /** The board for what the player drives with now: their assists and realism, today's surface, this physics revision */
  const currentBoard = useCallback(
    (): LapConditions =>
      lapConditionsNow({
        assists: session?.car.assistPreset ?? DEFAULT_ASSIST_PRESET,
        compound: session?.car.tireCompound ?? "soft",
        lineWaterMm: getTrackEnv().weather.lineWaterMm,
        realism: settingsRef.current.realism,
        vehicle: vehicleModelRef.current,
        trackId,
      }),
    [session, getTrackEnv, trackId]
  );
  const refreshLeaderboard = useCallback(async () => {
    // Several refreshes can overlap (car change, a saved lap): only the latest may land
    const req = ++leaderboardReqRef.current;
    const vehicleNow = vehicleModelRef.current;
    const [local, all] = await Promise.all([
      localLeaderboard(trackId, vehicleNow).catch((): LeaderboardEntry[] => []),
      listBestLaps().catch((): LapRecording[] => []),
    ]);
    if (req !== leaderboardReqRef.current) return;
    setLocalLaps(local);
    setBoardVersion((v) => v + 1);
    // A mod car keeps no best (its laps would stand in its vehicle model's)
    setAllTimeBestLap(carById(carIdRef.current).mod ? null : selectCarBestLap(all, trackId, vehicleNow));
  }, [trackId]);

  /** Races the personal best of this car as the ghost, replacing whichever lap was chosen */
  const loadPbGhost = useCallback(async () => {
    // A ghost picked (or another car's PB requested) while this one loads wins over it
    const req = ++ghostReqRef.current;
    // A mod car keeps no best (its laps would stand in its vehicle model's): it starts the session with none
    if (carById(carIdRef.current).mod) {
      ghostSourceRef.current = "pb";
      session?.setGhost(null);
      session?.lapRecorder.setContext({ personalBestMs: null });
      return;
    }
    // The best on the board the player is driving now (an assisted best is not their pro reference)
    const rec = await loadBestLap(trackId, vehicleModelRef.current, lapBoardClass(currentBoard())).catch(() => null);
    if (req !== ghostReqRef.current) return;
    ghostSourceRef.current = "pb";
    // A best from an earlier version of the circuit is moved onto this one
    session?.setGhost(rec ? new GhostPlayer(alignGhostToTrack(rec, track).recording) : null);
    session?.lapRecorder.setContext({ personalBestMs: rec?.lapTimeMs ?? null });
  }, [session, trackId, currentBoard, track]);

  useEffect(() => {
    // This visit's laps are compared with this car's on this circuit only
    setSessionLaps([]);
    let cancelled = false;
    setAnalysisOpen(false);
    void loadLatestLap(trackId, vehicleModel)
      .then((rec) => {
        if (!cancelled) setLatestLap(rec);
      })
      .catch(() => {
        if (!cancelled) setLatestLap(null);
      });
    return () => {
      cancelled = true;
    };
  }, [trackId, vehicleModel]);

  const onLapCompleted = useCallback(
    (summary: LapSummaryData, recording: LapRecording) => {
      // Any lap can be analysed, a cut one too; the reference best is the saved one (refreshLeaderboard, after a save)
      if (recording.data.length > 0) {
        // The driver's totals (driver-stats.ts): the lap's distance
        recordLapDistance(recording.trackLengthM ?? 0);
        const valid = summary.valid && !summary.autopilot;
        setSessionLaps((prev) => [{ recording, valid, lapNumber: summary.lapNumber }, ...prev].slice(0, 20));
        setLatestLap(recording);
        // A mod car's laps would be kept as its vehicle model's
        if (!carById(carIdRef.current).mod) {
          if (valid) setAllTimeBestLap((prev) => (!prev || recording.lapTimeMs < prev.lapTimeMs ? recording : prev));
          void saveLatestLap(recording);
        }
      }
      if (settingsRef.current.hud.lapSummary) {
        // A new card: an upload still out for the last one must not land on it
        submitReqRef.current++;
        setLapSummary({ summary, recording });
        setSubmitState("idle");
        setSubmitRank(null);
        setSubmitError(null);
      }
      // Every lap the player drove counts towards the circuit's laps driven, a cut one too
      if (!summary.autopilot) countUsageLap();
      if (!summary.valid || summary.autopilot) return;
      // The lap board opens at a lap's end (its setting allowing) and shows the new place once the upload answers
      signalBoardLap({ kind: "lap" });
      // A ghost chosen (or another car's best requested) while this saves wins over it
      const ghostReq = ghostReqRef.current;
      // The upload this lap's card may show the result of (a later card, or a manual upload, takes over)
      const submitReq = submitReqRef.current;
      // A mod car shares its vehicle model's id: its laps (on another body, or physics of its own) would stand in that
      // model's bests and ghosts, so they stay this session's only. A mod circuit's laps keep their own id and are saved
      if (carById(carIdRef.current).mod) return;
      void saveBestLapIfFaster(recording)
        .then((saved) => {
          if (saved) {
            if (ghostSourceRef.current === "pb" && ghostReq === ghostReqRef.current && recording.vehicle === vehicleModelRef.current) {
              // Newer than any best still loading from before this lap
              ghostReqRef.current++;
              session?.setGhost(new GhostPlayer(recording));
            }
            void refreshLeaderboard();
            accountActions.pushSoon();
          }
          // A lap faster than this browser's lap on its online board goes up by itself, and so does the best lap of
          // this week's challenge (which an older, faster lap of the same kind doesn't stand in for), under the
          // player's name, the one the game picked included, unless they turned this off. Measured against the board,
          // not the local personal best: a best set before the board began never went up, and a returning driver's
          // slower laps still belong on it. A failure offers a retry on the lap card; a board out of reach is asked
          // again now, and if it still doesn't answer the lap waits and goes up once it does
          // A lap with mod content is the player's own: nothing goes up, and the card doesn't offer it
          if (!lapGoesOnBoards(recording)) return;
          const preferredEvent = session?.getSnapshot().timeTrial?.eventId;
          const week = challengeOf(recording, Date.now(), preferredEvent);
          const weekBest = week ? loadChallengeBest(week) : null;
          const board = boardKeyOf(recording);
          const boardBest = board ? loadBoardBest(board) : null;
          const beatsBoard = board !== null && (boardBest === null || recording.lapTimeMs < boardBest);
          if (!beatsBoard && !(week && (weekBest === null || recording.lapTimeMs < weekBest))) return;
          const profile = settingsRef.current.profile;
          // Only a board that said it is off keeps a lap here; one that hasn't answered yet is tried
          if (boardStateRef.current === "off" || !profile.autoUpload) return;
          const shown = () => submitReq === submitReqRef.current;
          // A name the board won't take is not sent again lap after lap: the card says why and offers another
          const refused = nameProblem(profile.name) ?? (refusedNameRef.current?.name === profile.name ? refusedNameRef.current.error : null);
          if (refused) {
            if (shown()) {
              setSubmitState("error");
              setSubmitError(refused);
            }
            return;
          }
          if (shown()) setSubmitState("sending");
          const upload = postLap(recording, profile, "auto", { event: preferredEvent });
          trackUpload(upload);
          return upload.then((res) => {
            if (res.ok) setBoardVersion((v) => v + 1);
            if (res.ok && res.rank !== undefined) signalBoardLap({ kind: "result", rank: res.rank, total: res.total ?? null });
            if (res.taken) refusedNameRef.current = { name: profile.name, error: res.error ?? "This name is taken" };
            if (!shown()) return;
            // The board holding a faster lap of this driver's (from another device) is no failure: nothing to show
            setSubmitState(cardStateOf(res, true));
            setSubmitRank(placeOf(res));
            setSubmitError(res.ok || res.notFaster ? null : (res.error ?? null));
            waitingCardRef.current = res.unreachable ? { req: submitReq, recordedAt: recording.recordedAt } : null;
          });
        })
        .catch(() => {});
    },
    [session, refreshLeaderboard]
  );
  useEffect(() => session?.onLapCompleted(onLapCompleted), [session, onLapCompleted]);

  /**
   * Uploads the shown lap: by hand with automatic posting off, or again after an upload failed. `driver`: the name
   * just changed to (the settings don't show it until the next render)
   */
  const handleSubmitLap = useCallback(async (driver?: { name: string; code: string }) => {
    const rec = lapSummary?.recording;
    if (!rec || !lapGoesOnBoards(rec)) return;
    const as = driver ?? settingsRef.current.profile;
    const req = ++submitReqRef.current;
    const problem = nameProblem(as.name);
    if (problem) {
      setSubmitState("error");
      setSubmitError(problem);
      return;
    }
    setSubmitState("sending");
    const upload = postLap(rec, as, "hand", { event: session?.getSnapshot().timeTrial?.eventId });
    trackUpload(upload);
    const res = await upload;
    if (res.ok) setBoardVersion((v) => v + 1);
    if (res.ok && res.rank !== undefined) signalBoardLap({ kind: "result", rank: res.rank, total: res.total ?? null });
    if (res.taken) refusedNameRef.current = { name: as.name, error: res.error ?? "This name is taken" };
    // The card was closed or replaced by another lap meanwhile: this answer is not about the one shown
    if (req !== submitReqRef.current) return;
    setSubmitState(cardStateOf(res, false));
    setSubmitRank(placeOf(res));
    setSubmitError(res.ok ? null : (res.error ?? null));
    waitingCardRef.current = res.unreachable ? { req, recordedAt: rec.recordedAt } : null;
  }, [lapSummary]);
  /**
   * Posts a saved best that isn't on its online board (Your best laps): one whose upload failed, set while posting was
   * off, or set before the board began. Resolves with the board's answer; a refusal is remembered with its reason
   */
  const handlePostBest = useCallback(async (entry: LeaderboardEntry): Promise<SubmitResult> => {
    const rec = entry.conditions ? await loadBestLap(entry.trackId, entry.vehicle, lapBoardClass(entry.conditions)).catch(() => null) : null;
    // A faster lap saved meanwhile replaced this one: the list reloads with it
    if (!rec || rec.lapTimeMs !== entry.lapTimeMs || rec.recordedAt !== entry.recordedAt) return { ok: false, error: tx("lapNoLongerSaved") };
    const as = settingsRef.current.profile;
    const refused = nameProblem(as.name) ?? (refusedNameRef.current?.name === as.name ? refusedNameRef.current.error : null);
    if (refused) {
      saveBoardMiss(rec, refused);
      return { ok: false, error: refused };
    }
    const res = await postLap(rec, as, "hand");
    if (res.ok) setBoardVersion((v) => v + 1);
    if (res.taken) refusedNameRef.current = { name: as.name, error: res.error ?? "This name is taken" };
    return res;
  }, [tx]);
  /**
   * Sends the laps that couldn't reach the board (board-queue.ts), when it answers again or the name changes. A lap the
   * card still shows gets the board's answer there. `as`: a name just taken (the settings don't show it until the next
   * render)
   */
  const flushQueued = useCallback((as?: { name: string; code: string }) => {
    const flush = flushQueuedLaps({
      driver: () => {
        const p = as ?? settingsRef.current.profile;
        return nameProblem(p.name) || refusedNameRef.current?.name === p.name ? null : { name: p.name, code: p.code };
      },
      autoUpload: () => settingsRef.current.profile.autoUpload,
      loadBest: (trackId, vehicle, board) => loadBestLap(trackId, vehicle, board),
      onPosted: (rec, res) => {
        if (res.ok) setBoardVersion((v) => v + 1);
        if (res.taken) refusedNameRef.current = { name: settingsRef.current.profile.name, error: res.error ?? "This name is taken" };
        const card = waitingCardRef.current;
        if (!card || card.recordedAt !== rec.recordedAt || card.req !== submitReqRef.current) return;
        if (!res.unreachable) waitingCardRef.current = null;
        setSubmitState(cardStateOf(res, true));
        setSubmitRank(placeOf(res));
        setSubmitError(res.ok || res.notFaster ? null : (res.error ?? null));
      },
    });
    // A rename waits for these too, so their laps move with the rest (and still for an upload already on its way)
    trackUpload(flush);
  }, []);
  flushQueuedRef.current = flushQueued;
  /**
   * A new driver name, from the Display settings or the lap card: checked, then claimed on the online board, where the
   * laps and race results under the old name move with it. The name and code once it has taken, else why it didn't.
   * Nothing changes here until the board has said yes.
   */
  const confirmDriverName = useCallback(() => {
    setSettings((s) => {
      const next = confirmDriverProfileName(s.profile);
      return next === s.profile ? s : { ...s, profile: next };
    });
  }, []);
  const renameDriver = useCallback(async (raw: string): Promise<{ error: string } | { name: string; code: string }> => {
    const name = sanitizeDriverName(raw);
    const prev = settingsRef.current.profile;
    if (name === prev.name) {
      if (prev.generated) confirmDriverName();
      return { name, code: prev.code };
    }
    const problem = nameProblem(name);
    if (problem) return { error: problem };
    // A code the game derived from its own made-up name follows the new name; one the player set stays
    const code = prev.generated ? codeFromName(name) : prev.code;
    // An upload still on its way goes up under the old name first, so its lap moves with the rest
    await uploadingRef.current?.catch(() => {});
    // A board that hasn't answered is asked now: the name doesn't change while it is out of reach (renameOnBoard)
    if (boardStateRef.current !== "off") {
      const res = await renameOnBoard(prev.name, name, code);
      if (!res.ok) return { error: res.error ?? tx("nameNotChanged") };
    }
    setSettings((s) => ({ ...s, profile: { ...s.profile, name, code, generated: false } }));
    refusedNameRef.current = null;
    // The boards (the challenge box among them) are read again under the new name, and laps held back by the old one go
    // up (under the new name: the settings don't show it until the next render)
    setBoardVersion((v) => v + 1);
    if (boardStateRef.current === "on") flushQueued({ name, code });
    return { name, code };
  }, [confirmDriverName, flushQueued, tx]);
  const renameFromSettings = useCallback(async (raw: string) => {
    const res = await renameDriver(raw);
    return "error" in res ? boardWords(res.error) : null;
  }, [renameDriver]);

  const closeLapSummary = useCallback(() => {
    submitReqRef.current++;
    setLapSummary(null);
  }, []);

  /** Uses a lap from the leaderboard (or a file) as the ghost */
  const raceGhost = useCallback((rec: LapRecording | null) => {
    if (!rec) return;
    ghostReqRef.current++;
    // A lap from another version of the circuit (a downloaded or older file) is moved onto this one
    session?.setGhost(new GhostPlayer(alignGhostToTrack(rec, track).recording));
    ghostSourceRef.current = "other";
    setSettings((prev) => (prev.ghost ? prev : { ...prev, ghost: true }));
  }, [session, track]);

  const [setupBoardNotice, setSetupBoardNotice] = useState<{ text: string; vehicle: VehicleModelId; undo?: () => void } | null>(null);
  useEffect(() => {
    setSetupBoardNotice(null);
  }, [trackId, vehicleModel, session]);
  const handleApplyLeaderboardSetup = useCallback(
    async (entry: LeaderboardEntry) => {
      const targetVehicle = vehicleModelRef.current;
      const startSession = sessionRef.current;
      let fetchFailed = false;
      let rec = null;
      if (!entry.setup) {
        if (entry.source === "remote" && entry.id) {
          try {
            rec = await fetchRemoteGhost(entry.id);
            if (!rec) fetchFailed = true;
          } catch {
            fetchFailed = true;
          }
        } else {
          rec = await loadBestLap(entry.trackId, entry.vehicle, entry.conditions ? lapBoardClass(entry.conditions) : null).catch(() => null);
        }
      }
      // Drop stale result if the player switched cars or sessions while downloading
      if (vehicleModelRef.current !== targetVehicle || sessionRef.current !== startSession) return;
      const setup = entry.setup ?? rec?.setup ?? null;
      if (!setup) {
        setSetupBoardNotice({
          text: fetchFailed ? tx("setupLoadFailed", { driver: entry.name }) : tx("setupMissing", { driver: entry.name }),
          vehicle: targetVehicle,
        });
        return;
      }
      const snap = sessionRef.current?.getSnapshot();
      const prevChassis = snap?.chassisSetup ?? chassisSetup;
      const prevTyre = snap?.tyreSetup ?? tyreSetup;
      const prevCompound = snap?.tireCompound ?? tireCompound;
      const prevAero = aeroPreset;
      const prevTuner = garageTunerFrom(snap?.telemetry.liveTuner ?? telemetry.liveTuner);
      const resolved = resolveSetupForCar(
        setup,
        targetVehicle,
        prevTyre,
        (t) => clampTyreSetup(targetVehicle, t),
        prevCompound,
        prevAero,
        prevTuner,
        prevChassis.fuelDeltaKg,
      );
      const keepChallengeCompound = snap?.timeTrial?.vehicle === targetVehicle;
      handleChangeChassisSetup(resolved.chassis);
      handleChangeTyreSetup(resolved.tyre);
      if (!keepChallengeCompound) handleTireCompoundChange(resolved.compound);
      handleAeroPresetChange(resolved.aero);
      handleChangeLiveTuner(resolved.tuner);
      setSetupBoardNotice({
        text: tx("setupApplied", { driver: entry.name, summary: summarizeSharedSetup(setup) }),
        vehicle: targetVehicle,
        undo: () => {
          if (vehicleModelRef.current !== targetVehicle || sessionRef.current !== startSession) return;
          handleChangeChassisSetup(prevChassis);
          handleChangeTyreSetup(prevTyre);
          if (!keepChallengeCompound) handleTireCompoundChange(prevCompound);
          handleAeroPresetChange(prevAero);
          handleChangeLiveTuner(prevTuner);
        },
      });
    },
    [
      aeroPreset,
      chassisSetup,
      defaultTyreSetup,
      handleAeroPresetChange,
      handleChangeChassisSetup,
      handleChangeLiveTuner,
      handleChangeTyreSetup,
      handleTireCompoundChange,
      telemetry.liveTuner,
      tireCompound,
      tx,
      tyreSetup,
    ],
  );

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
    const { name, code } = settingsRef.current.profile;
    setDriverKeyNotice(
      exportDriverKeyFile(name, code)
        ? tx("keySaved")
        : tx("noKeyYet")
    );
  }, [tx]);

  const handleImportDriverKey = useCallback(async (file: File) => {
    const req = ++keyImportReqRef.current;
    const res = await importDriverKeyFile(file);
    if (req !== keyImportReqRef.current) return;
    if (!res.ok) {
      setDriverKeyNotice(res.error);
      return;
    }
    // A previous "this name is taken" refusal was for the old key: clear it now that this browser holds the imported one
    refusedNameRef.current = null;
    const before = settingsRef.current.profile;
    const fileIdentity = { name: res.name, code: res.code };
    const fromFile = applyImportedDriverIdentity(before, fileIdentity);
    if (fromFile !== before) {
      setSettings((s) => ({ ...s, profile: applyImportedDriverIdentity(s.profile, fileIdentity) }));
    }
    const fileNoticeName = resolveImportedDriverName(fileIdentity);
    setDriverKeyNotice(fileNoticeName ? tx("keyImportedFor", { name: fileNoticeName }) : tx("keyImported"));
    setBoardVersion((v) => v + 1);

    let flushAs: { name: string; code: string } | undefined =
      fromFile !== before ? { name: fromFile.name, code: fromFile.code } : undefined;
    if (boardStateRef.current !== "off") {
      const looked = await lookupDriverByKey(res.name || undefined).catch(() => null);
      if (req !== keyImportReqRef.current) return;
      const cur = settingsRef.current.profile;
      const untouched =
        (cur.name === fromFile.name && cur.code === fromFile.code) ||
        (cur === before);
      if (!untouched) {
        flushAs = undefined;
      } else if (looked && (looked.name || looked.nameKey || looked.code)) {
        const resolved = applyImportedDriverIdentity(before, looked, fileIdentity);
        flushAs = { name: resolved.name, code: resolved.code };
        if (resolved.name !== fromFile.name || resolved.code !== fromFile.code || resolved.generated !== fromFile.generated) {
          setSettings((s) =>
            s.profile.name === fromFile.name && s.profile.code === fromFile.code
              ? { ...s, profile: { ...s.profile, name: resolved.name, code: resolved.code, generated: resolved.generated } }
              : s
          );
          if (resolved.name !== fromFile.name) setBoardVersion((v) => v + 1);
        }
        const resolvedNoticeName = resolveImportedDriverName(looked, fileIdentity);
        if (resolvedNoticeName) setDriverKeyNotice(tx("keyImportedFor", { name: resolvedNoticeName }));
      }
    }
    if (boardStateRef.current === "on") flushQueued(flushAs);
  }, [flushQueued, tx]);

  const handleExportBest = useCallback(async () => {
    const rec = await loadBestLap(trackId, vehicleModelRef.current, lapBoardClass(currentBoard())).catch(() => null);
    if (rec) exportLapFile(rec);
  }, [trackId, currentBoard]);

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
    // The room's lobby, or after a scheduled race the open races: both are on the Multiplayer panel
    setTitleInitialPanel("multiplayer");
    leaveSession();
  }, [leaveSession]);

  /** The Settings screen, over the title menu or the pause menu, and where it opens */
  const [settingsOpen, setSettingsOpen] = useState<{ from: "title" | "pause"; category?: SettingsCategory; tab?: string } | null>(null);
  // Settings > Display > HUD > Edit layout: the live HUD's layout editor stands in for Settings until Done or Cancel
  const [hudEditing, setHudEditing] = useState(false);
  useEffect(() => {
    if (phase !== "title" && phase !== "driving") setHudEditing(false);
  }, [phase]);
  const openSettings = useCallback(
    (from: "title" | "pause", category?: SettingsCategory, tab?: string) => {
      // Opened from the car (the HUD's "pedals not set up"): the session pauses under it, as from the pause menu
      if (from === "pause" && !session?.getSnapshot().paused) session?.togglePause();
      setSettingsOpen({ from, category, tab });
    },
    [session]
  );
  const closeSettings = useCallback(() => setSettingsOpen(null), []);
  // Signed out with accounts on: the Lap times panel and the first lap on a board offer Settings > Account
  const signedOut = useAccountState().phase === "signed-out";
  // Every way out of the pause (the touch pause button, a wheel's pause button, a race restart) closes it too
  const wasPausedRef = useRef(paused);
  useEffect(() => {
    const resumed = wasPausedRef.current && !paused;
    wasPausedRef.current = paused;
    if (settingsOpen?.from === "pause" && (resumed || phase !== "driving")) setSettingsOpen(null);
    if (settingsOpen?.from === "title" && phase !== "title") setSettingsOpen(null);
  }, [settingsOpen, paused, phase]);

  /** First-run setup again, from Settings > Controls > Device: back where Settings was opened from when done */
  const runSetupAgain = useCallback(() => {
    const from = settingsOpen?.from ?? "title";
    setSettingsOpen(null);
    wizardReturnRef.current = from;
    setWizardMode("again");
    setPhase("wizard");
  }, [settingsOpen, setPhase]);

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
    // Setup run again from pause goes back to it (still paused)
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

  const handleWizardStep = useCallback((step: WizardStepId) => session?.setWizardStep(step), [session]);

  /** "Press any key" on the loading screen: the user gesture that unlocks audio */
  const handleLoadingStart = useCallback(() => {
    session?.unlockAudio();
    // A race taken up from the loading screen has already left it: never send that session to the title
    if (phaseRef.current !== "loading") return;
    setPhase("title");
    if (inviteRoom) getMultiplayerManager().joinRoom(inviteRoom);
  }, [session, setPhase, inviteRoom]);
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
    if (!launchHint || !session) return;
    if (session.getTelemetry().speedKmh > 15) {
      setLaunchHint(false);
      return;
    }
    return session.subscribeTelemetry(() => {
      if (session.getTelemetry().speedKmh > 15) setLaunchHint(false);
    });
  }, [launchHint, session]);
  // A car's first drive also names the seat panel in the launch hint; once it has shown (or the panel opened), not again
  const [seatHintOn, setSeatHintOn] = useState(false);
  const showsSeatHint = settings.device === "wheel" || settings.device === "controller";
  useEffect(() => {
    if (launchHint && showsSeatHint) {
      setSeatHintOn(!seatHintSeen(carId));
      return;
    }
    setSeatHintOn((on) => {
      if (on) markSeatHintSeen(carId);
      return false;
    });
  }, [launchHint, carId, showsSeatHint]);
  useEffect(() => {
    if (!seatPanel) return;
    markSeatHintSeen(carId);
    setSeatHintOn(false);
  }, [seatPanel, carId]);

  // Silence the pad rumble and FFB as soon as the pause menu opens or the car is left for the menus (the car audio
  // follows the frame loop, which pauses it on every frame the car is not driven, in every phase)
  useEffect(() => {
    const silence = paused || phase !== "driving";
    if (silence) session?.silenceFeedback();
  }, [session, paused, phase]);

  // The GPU context is gone: an online race goes on without this car, as when the player leaves it (a guest drops out,
  // a host ends it for everyone rather than leave them waiting on a car that no longer moves)
  useEffect(() => {
    if (gpuLost) endMpRace(true);
  }, [gpuLost, endMpRace]);
  /**
   * The way back from a lost context: the circuit mounts again on a new canvas, with Low saved first when asked. A
   * browser that refuses WebGL to the page after a reset would only fail again: then the notice asks for a page reload.
   */
  const restartAfterGpuLoss = useCallback(
    (lower: boolean) => {
      if (probeRenderer() === null) {
        setWebglRefused(true);
        return;
      }
      // The player chose: the next start does not switch the preset by itself
      settleLoss(browserStore(), Date.now());
      // The circuit loads again on the title menu: as when leaving the car for it, the player's own assists, realism
      // and weather come back if a challenge or a scheduled race had the week's in their place
      let s = settingsRef.current;
      const own = takeOwnRules();
      if (own) s = { ...s, ...own };
      savePlayerSettings(lower ? { ...s, graphics: { ...s.graphics, quality: "low" } } : s);
      if (onRestart) onRestart();
      else window.location.reload();
    },
    [onRestart]
  );
  const gpuNoticeKind = webglRefused
    ? lostRecently()
      ? "blocked"
      : "unavailable"
    : gpuLost
      ? gpuLost.hidden
        ? "background"
        : "lost"
      : null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let session: DriveSession;
    try {
      session = new DriveSession(container, {
        car: carIdRef.current,
        cycleCamera,
        getTrackEnv,
        handleToggleRacingLine,
        setSettings,
        setRaceKind,
        onRunReset,
        track,
        trackId,
        // The save itself, read here as well as below: the state still holds the prerendered defaults at this point
        settings: loadPlayerSettings(),
        nameplatesRef,
      });
    } catch (err) {
      // No WebGL for this page (switched off, or refused after a GPU reset): say so rather than the error screen
      if (!(err instanceof WebGLUnavailableError)) throw err;
      console.warn("[gpu]", err.message);
      setWebglRefused(true);
      return;
    }
    setSession(session);
    return () => {
      session.dispose();
      setSession(null);
    };
  }, [track, getTrackEnv, handleToggleRacingLine, onRunReset]);

  // Saved settings and the first-run flag are read after mount (the page is prerendered without storage); the
  // session takes the settings on through applySettings, whether it exists yet or not
  useEffect(() => {
    // A drive on its own rules (the week's challenge, a career round) that never came back to the menus (the tab closed,
    // the circuit reloaded): the player's own come back, checked as a save is
    let loaded = loadPlayerSettings();
    const own = takeOwnRules();
    if (own) {
      const fixed = parsePlayerSettings({ ...loaded, ...own });
      loaded = { ...loaded, assistPreset: fixed.assistPreset, realism: fixed.realism, conditions: fixed.conditions };
      // Saved at once: the stored copy is gone, so a second run of this effect must read them from the save
      savePlayerSettings(loaded);
    }
    setSettings(loaded);
    setOnboarded(loadOnboarded());
    setInviteRoom(roomFromUrl());
    setSettingsHydrated(true);
  }, []);

  useEffect(() => {
    if (!settingsHydrated) return;
    savePlayerSettings(settings);
  }, [settingsHydrated, settings]);

  // Units, interface size and the colour-blind palette: once at start-up (the defaults, then the save) and on change
  useEffect(() => {
    applyInterfaceSettings(settings.ui);
  }, [settings.ui]);

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
    /**
     * Enforces the room's car class/spec lock immediately on join (in menus or while driving) with a clear toast,
     * and in the menus also follows the host's circuit automatically.
     */
    const follow = (l: LobbyState | null) => {
      if (!l) return;
      const switched = isVehicleRestricted(l.settings) && enforceLobbyCar(l.settings, mp.inScheduledRace);
      if (l.hostId === mp.localPeerId || (phaseRef.current !== "title" && phaseRef.current !== "loading")) return;
      if (l.settings.trackId !== trackId) {
        if (onSelectTrack && roomTrackStatus(l.settings.trackId, l.settings.trackMod) === "ok") onSelectTrack(l.settings.trackId);
        return;
      }
      if (!switched) {
        const modSwap = modCarSwap(carIdRef.current, mp.inScheduledRace);
        if (modSwap) changeCar(modSwap);
      }
    };
    mp.onRoomCarRule = (rule) => {
      enforceLobbyCar(rule, mp.inScheduledRace);
    };
    mp.onLobbyChange = (l) => {
      setLobby(l ? { ...l, players: [...l.players] } : null);
      // Who is still in the race is the lobby's word, the same on every screen
      if (l && session) mpRaceOf(session.race)?.setPresent(l.players.map((p) => p.peerId));
      if (!l) {
        setRoomConditions(null);
        if (guestWeatherSyncedRef.current) {
          guestWeatherSyncedRef.current = false;
          restoreOwnConditionsNow();
        }
      } else if (l.hostId !== mp.localPeerId && l.settings.trackId === trackId) {
        // Guests follow the host's full WeatherSyncState (weatherNodes, seed, surface preset, live clock & water)
        // directly without touching `roomConditions` so the React conditions effect never fights `applyWeatherSync`.
        if (l.weather) {
          guestWeatherSyncedRef.current = true;
          trackEnvRef.current?.applyWeatherSync(l.weather);
        }
      }
      follow(l);
    };
    // The lobby already here counts too: the scene that just loaded for its circuit still has its car to take
    follow(mp.lobby);
    setRaceEntry(mp.raceStatus);
    mp.onRaceStatusChange = setRaceEntry;
    mp.weatherProvider = () => trackEnvRef.current?.weather.snapshot() ?? null;
    mp.onQualifyingStart = (quali) => {
      const targetTrack = mp.lobby?.settings.trackId ?? trackId;
      // A mod circuit this copy hasn't got, or has in another version (another road): it sits this one out
      if (roomTrackStatus(targetTrack, mp.lobby?.settings.trackMod) !== "ok") return;
      if (targetTrack !== trackId && onSelectTrack) {
        pendingQualifying = { id: quali.id, trackId: targetTrack };
        onSelectTrack(targetTrack);
        return;
      }
      if (targetTrack !== trackId) return;
      takeQualifyingStart(quali, targetTrack);
    };
    mp.onQualifyingEnd = (id) => {
      if (pendingQualifying?.id === id) pendingQualifying = null;
    };
    mp.onRaceStart = (start) => {
      pendingQualifying = null;
      // A scheduled race nobody else entered: out of it, and the same race against the AI instead
      if (mp.inScheduledRace && start.grid.length <= 1) {
        mp.leaveScheduledRace();
        soloRaceRef.current();
        return;
      }
      // A mod circuit this copy hasn't got, or has in another version (another road): it sits this race out
      const lobbyTrack = mp.lobby?.settings;
      if (start.trackId && roomTrackStatus(start.trackId, lobbyTrack?.trackId === start.trackId ? lobbyTrack.trackMod : undefined) !== "ok") return;
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
      if (session && mpRaceOf(session.race)?.start.id === id) endMpRace(false);
    };
    mp.onRaceFinish = (peerId, finish) => {
      if (session) mpRaceOf(session.race)?.takeFinish(peerId, finish);
    };
    mp.onRaceResult = (result) => {
      if (session) mpRaceOf(session.race)?.applyResult(result);
    };
    const timer = window.setInterval(() => setPeerStats(mp.getPeerStats()), 1000);
    return () => {
      mp.onLobbyChange = undefined;
      mp.onRoomCarRule = undefined;
      mp.onRaceStatusChange = undefined;
      mp.weatherProvider = undefined;
      mp.onQualifyingStart = undefined;
      mp.onQualifyingEnd = undefined;
      mp.onRaceStart = undefined;
      mp.onRaceAbort = undefined;
      mp.onRaceFinish = undefined;
      mp.onRaceResult = undefined;
      window.clearInterval(timer);
    };
  }, [session, trackId, onSelectTrack, takeRaceStart, takeQualifyingStart, endMpRace, changeCar, enforceLobbyCar, restoreOwnConditionsNow]);

  // ---- Time trials (Weekly Time Trial + permanent Middle Gear Lap Board)
  // The week is read when the menus open (it only turns on Monday)
  const challengeWeek = challengeAt(Date.now()).id;
  const challenge = useMemo(() => challengeAt(Date.now()), [challengeWeek]);
  const challengeAvailable = TRACKS.some((t) => t.id === challenge.trackId) && CARS.some((c) => c.physics === challenge.vehicle);
  const middleGearAvailable =
    TRACKS.some((t) => t.id === MIDDLE_GEAR_CHALLENGE.trackId) && CARS.some((c) => c.physics === MIDDLE_GEAR_CHALLENGE.vehicle);
  // The week's races can be on another circuit and car than its time trial
  const racesAvailable = TRACKS.some((t) => t.id === challenge.race.trackId) && CARS.some((c) => c.physics === challenge.race.vehicle);
  /**
   * Any time trial's board: the one laps go on now (the time trial's target), or an older one the panel picked, by its
   * base revision
   */
  const loadTrialBoard = useCallback(
    (trial: TimeTrialEvent, version: number = currentBoardBase(trial.trackId)) =>
      fetchRemoteBoard(trial.trackId, trial.vehicle, { event: trial.id, name: settingsRef.current.profile.name, limit: 20, version }).catch(() => null),
    []
  );
  const loadWeeklyBoard = useCallback((version?: number) => loadTrialBoard(challenge, version), [loadTrialBoard, challenge]);
  const loadMiddleGearBoard = useCallback((version?: number) => loadTrialBoard(MIDDLE_GEAR_CHALLENGE, version), [loadTrialBoard]);

  // Which active time trial is currently being driven on track (for the HUD target card and diagnostics)
  const activeTrial: TimeTrialEvent | null = useMemo(() => {
    if (!timeTrial) return null;
    const byId = timeTrial.eventId ? timeTrialEventById(timeTrial.eventId) : null;
    if (byId && byId.trackId === trackId && byId.vehicle === timeTrial.vehicle) return byId;
    if (challenge.trackId === trackId && challenge.vehicle === timeTrial.vehicle) return challenge;
    if (MIDDLE_GEAR_CHALLENGE.trackId === trackId && MIDDLE_GEAR_CHALLENGE.vehicle === timeTrial.vehicle) return MIDDLE_GEAR_CHALLENGE;
    return null;
  }, [timeTrial, trackId, challenge]);

  // polish:A — the time trial's target on the HUD: the active trial's board, read again after each upload. Not without a board
  const [challengeTargetNow, setChallengeTargetNow] = useState<ChallengeTarget | null>(null);
  const targetShown = activeTrial !== null && boardOn;
  useEffect(() => {
    if (!activeTrial || !boardOn) return setChallengeTargetNow(null);
    let live = true;
    void loadTrialBoard(activeTrial).then((board) => {
      if (live && board) setChallengeTargetNow(challengeTarget(board, { permanent: isPermanentChallenge(activeTrial) }));
    });
    return () => {
      live = false;
    };
  }, [activeTrial, boardOn, loadTrialBoard, boardVersion, settings.profile.name]);
  /**
   * Out on track to a time trial's rules: its car, assists and realism, a dry track. `race`: against the AI in the car
   * and over the distance of the week's races (weekly challenge only; else time trial practice).
   */
  const driveChallenge = useCallback(
    (trial: TimeTrialEvent, race: boolean) => {
      applyTrialRules(trial);
      startSession({ kind: "practice" });
      // After the session reset, so the swap finds no replay or AI field to carry over (as a multiplayer race's)
      const weeklyRace = race && !isPermanentChallenge(trial) ? trial.race : null;
      const rules = weeklyRace ?? trial;
      // A mod car is never a challenge car, whatever its vehicle model
      if (vehicleModelRef.current !== rules.vehicle || rules.car !== undefined || carById(carIdRef.current).mod) changeCar(weekCar(rules).id);
      if (weeklyRace && session) {
        // The field for the car now on track, over the week's race distance
        const field = session.takeAiField();
        // The same rules for everyone: the car class's, with track limits on
        session.setRace({ kind: "ai", field, rules: { rulePreset: "auto", trackLimits: "auto" } });
        // No damage, as in an open race with other drivers (their cars take none)
        startAiRace(field, { ...settingsRef.current.race, laps: weeklyRace.laps, startMode: "standing", damage: "off" }, settingsRef.current.profile);
      } else {
        // polish:A — the time trial: its fixed tyre, fuel (and baseline setup when fixedSetup is set) and road, from a flying start
        session?.setTimeTrial(
          timeTrialRules(trial.vehicle, {
            eventId: trial.id,
            fixedSetup: isPermanentChallenge(trial) && trial.fixedSetup,
          })
        );
        session?.restartFlyingLap();
        return;
      }
      setLaunchHint(true);
    },
    [session, startSession, changeCar, applyTrialRules]
  );
  /**
   * A time trial (`race`: the week's race) from any circuit: on another one the scene loads the right one first,
   * then goes out
   */
  const goChallenge = useCallback(
    (trial: TimeTrialEvent, race: boolean) => {
      const circuit = race && !isPermanentChallenge(trial) ? trial.race.trackId : trial.trackId;
      if (circuit !== trackId) {
        if (!onSelectTrack) return;
        pendingChallenge = { id: trial.id, race };
        void onSelectTrack(circuit);
        return;
      }
      driveChallenge(trial, race);
    },
    [trackId, onSelectTrack, driveChallenge]
  );
  const handleDriveWeekly = useCallback(() => goChallenge(challengeAt(Date.now()), false), [goChallenge]);
  const handleDriveMiddleGear = useCallback(() => goChallenge(MIDDLE_GEAR_CHALLENGE, false), [goChallenge]);
  /** The scheduled race nobody else entered, as a race against the AI */
  const soloRaceRef = useRef(() => {});
  soloRaceRef.current = () => goChallenge(challengeAt(Date.now()), true);
  const handleJoinRace = useCallback(() => {
    session?.unlockAudio();
    // Auto-switch into this week's scheduled race car (e.g. LC-LMDH) before connecting so hello already carries it
    const weekRace = challengeAt(Date.now()).race;
    enforceLobbyCar({ carClass: vehicleClassOf(weekRace.vehicle), vehicle: weekRace.vehicle }, true);
    getMultiplayerManager().joinScheduledRace();
  }, [session, enforceLobbyCar]);
  const handleLeaveRace = useCallback(() => getMultiplayerManager().leaveScheduledRace(), []);
  // The time trial asked for from another circuit, now that this one has loaded
  useEffect(() => {
    if (!assetsReady || !pendingChallenge) return;
    const asked = pendingChallenge;
    pendingChallenge = null;
    const trial = timeTrialEventById(asked.id);
    if (!trial || (!isPermanentChallenge(trial) && trial.id !== challengeAt(Date.now()).id)) return;
    const expectedTrack = asked.race && !isPermanentChallenge(trial) ? trial.race.trackId : trial.trackId;
    if (expectedTrack !== trackId) return;
    if (phaseRef.current === "loading") {
      session?.unlockAudio();
      setLoadingVisible(false);
    }
    driveChallenge(trial, asked.race);
  }, [assetsReady, trackId, session, driveChallenge]);

  // The first circuit is in: the offline copy of the game may download now, without slowing it
  useEffect(() => {
    if (assetsReady) requestShellSync();
  }, [assetsReady]);

  // The race the host started before this circuit loaded
  useEffect(() => {
    if (!assetsReady || !pendingRaceStart) return;
    const start = pendingRaceStart;
    pendingRaceStart = null;
    if (start.trackId && start.trackId !== trackId) return;
    takeRaceStart(start);
  }, [assetsReady, trackId, takeRaceStart]);

  // Private-room qualifying started before this circuit finished loading (or while switching circuits)
  useEffect(() => {
    if (!assetsReady || !pendingQualifying) return;
    const asked = pendingQualifying;
    pendingQualifying = null;
    if (asked.trackId !== trackId) return;
    const active = getMultiplayerManager().activeQualifying;
    if (!active || active.id !== asked.id) return;
    takeQualifyingStart(active, trackId);
  }, [assetsReady, trackId, takeQualifyingStart]);

  // Name, code, colour and car as other players see them
  useEffect(() => {
    getMultiplayerManager().setIdentity(settings.profile, vehicleModel, trackId);
    session?.lapRecorder.setContext({ driverName: settings.profile.name, driverCode: settings.profile.code });
  }, [session, settings.profile, vehicleModel, trackId]);

  // A car change brings back that car's personal-best ghost and leaderboard. Bests are kept per vehicle model, so the
  // model's cars share one; a mod car (which keeps none) is a car of its own
  const pbOwner = carById(carId).mod ? carId : vehicleModel;
  useEffect(() => {
    void loadPbGhost();
    void refreshLeaderboard();
    wheelFfb.resetMeter();
  }, [pbOwner, loadPbGhost, refreshLeaderboard]);

  // The force meter only with a force-feedback wheel in use: the browser's WebHID driver ready, or the bridge driving a
  // wheel (as the force feedback settings read it). Without one the layout puts something else in its place (Blade: the
  // driver's inputs)
  const ffbBridge = useSyncExternalStore(wheelFfb.subscribe, wheelFfb.getStatus, wheelFfb.getStatus);

  // Three screens: the menus and the HUD keep to the centre one (the 3D view spans all three); a headset has its own
  const [windowSize, setWindowSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const read = () => setWindowSize({ w: window.innerWidth, h: window.innerHeight });
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);
  const uiFrameRect: UiFrame | null = useMemo(
    () =>
      settings.screens.mode === "triple" && vrState !== "on" && windowSize && tripleFits(windowSize.w, windowSize.h)
        ? centreFrame(windowSize.w, windowSize.h)
        : null,
    [settings.screens.mode, vrState, windowSize]
  );
  useEffect(() => {
    setUiFrame(uiFrameRect);
    return () => setUiFrame(null);
  }, [uiFrameRect]);
  /** On three screens with the true field of view: the driver's-eye field of view the screens give (degrees) */
  const trueFovDeg = useMemo(
    () =>
      uiFrameRect && windowSize && settings.screens.physicalFov
        ? physicalVerticalFovDeg(screenRig(settings.screens, uiFrameRect.w / Math.max(1, windowSize.h)))
        : null,
    [uiFrameRect, windowSize, settings.screens]
  );
  /** The driver's-eye field of view in use: the screens' true one, the player's own, or null for the car's own */
  const cockpitFovInUse = trueFovDeg !== null ? Math.round(clampFov(trueFovDeg)) : settings.cockpitFovDeg;
  const ffbHid = useSyncExternalStore(webHidFfb.subscribe, webHidFfb.getStatus, webHidFfb.getStatus);
  const ffbLive =
    (settings.wheel.hidFfb && ffbHid.state === "ready") ||
    (ffbBridge.connection === "connected" && ffbBridge.device !== null && ffbBridge.error === null);
  const ffbMeterOn = phase === "driving" && settings.device === "wheel" && settings.wheel.ffbEnabled && ffbLive;
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
  // Also before it: friction / inertia switched on are set up with the wheel (a running one is set up again for them)
  const wantFriction = settings.wheel.ffbFriction > 0;
  const wantInertia = settings.wheel.ffbInertia > 0;
  useEffect(() => webHidFfb.setWantedConditions({ friction: wantFriction, inertia: wantInertia }), [wantFriction, wantInertia]);
  useEffect(() => {
    if (!hidFfbWanted) {
      void webHidFfb.dispose();
      return;
    }
    void webHidFfb.reconnect();
  }, [hidFfbWanted]);
  // A DualSense paired on an earlier visit opens again without a prompt (adaptive triggers, rumble, lights), and so
  // does a DualShock 4 connected for gyro steering
  useEffect(() => {
    void dualSenseHid.restore();
    void dualShock4Hid.restore();
  }, []);
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

  const keyNames = useMemo(() => {
    const first = (codes: string[]) => (codes[0] ? keyLabel(codes[0]) : "—");
    const k = settings.keys;
    return {
      camera: first(k.camera),
      freeCamera: first(k.freeCamera),
      tvCamera: first(k.tvCamera),
      racingLine: first(k.racingLine),
      mute: first(k.mute),
      mouseSteer: first(k.mouseSteer),
      autopilot: first(k.autopilot),
      restart: first(k.restart),
      shiftUp: first(k.shiftUp),
      shiftDown: first(k.shiftDown),
      board: first(k.board),
      headlights: first(k.headlights),
      pitLimiter: first(k.pitLimiter),
    };
  }, [settings.keys]);
  /** The lap board's gear sets when it opens: the same HUD setting as in Settings */
  const handleChangeBoardWidget = useCallback(
    (mode: BoardWidgetMode) => handleChangeSettings((prev) => ({ ...prev, hud: { ...prev.hud, boardWidget: mode } })),
    [handleChangeSettings]
  );

  // With the touch pads up and no wheel or controller picked, the pads are what the player drives with
  const launchHintText =
    settings.device === "wheel"
      ? seatHintOn
        ? tx("launchWheelSeat")
        : tx("launchWheel")
      : settings.device === "controller"
        ? seatHintOn
          ? tx("launchPadSeat", { press: pressPedalText(settings.padTuning.pedalSources.throttle), button: padButtonLabel(settings.padButtons.camera) })
          : tx("launchPad", { press: pressPedalText(settings.padTuning.pedalSources.throttle) })
        : touchVisible && vrState !== "on"
          ? tx("launchTouch")
          : tx("launchKey", { key: keyLabel(settings.keys.throttle[0]) });

  // The one derivation of hosting: the lobby names this client as its host
  /** Entered in a scheduled race: its lobby is the race server's, shown on the Races card, not as a room */
  const inScheduledRace = raceEntry.state === "joining" || raceEntry.state === "joined";
  const roomLobby = inScheduledRace ? null : lobby;
  const isMpHost = roomLobby !== null && roomLobby.hostId === localPeerId;
  isMpHostRef.current = isMpHost;
  // polish:E the anonymous usage counter: what is driven, where, in which mode, for how long (nothing per player)
  useUsageCounter({
    driving: phase === "driving",
    paused,
    trackId,
    vehicle: vehicleModel,
    race: raceKind,
    scheduledRace: inScheduledRace,
    assists: assistPreset,
    realism: settings.realism,
    lineWaterMm: trackEnvRef.current?.weather.lineWaterMm ?? 0,
    raceOver: telemetry.race?.phase === "finished",
    input: settings.device === "keyboard" && touchVisible ? "touch" : settings.device,
  });
  // A newer build out while the game is open: the menus offer the reload (UpdateReady). It happens by itself only on
  // the first loading screen, or on the title screen with nothing open while the tab is out of view (build-update.ts)
  useUpdateAutoReload(
    phase === "loading" ? "loading" : phase === "title" && !settingsOpen && lobby === null && !inScheduledRace ? "idle" : "busy"
  );

  // polish:B after the flag: the podium shot, the race kept in this browser, the next open race
  const podiumUi = useSyncExternalStore(session?.podium.subscribe ?? noSubscribe, session?.podium.getSnapshot ?? idlePodium, idlePodium);
  // The career's pre-race show: its scenes as the drive plays them, and its three buttons
  const showUi = useSyncExternalStore(session?.preRaceShow.subscribe ?? noSubscribe, session?.preRaceShow.getSnapshot ?? idleShow, idleShow);
  const preRaceShow = useMemo(
    () => ({
      ui: showUi,
      timeS: session?.preRaceShow.timeS ?? noShowTime,
      onNext: () => session?.preRaceShow.next(),
      onSkip: () => session?.preRaceShow.skip(),
      onStart: () => session?.preRaceShow.startNow(),
    }),
    [showUi, session]
  );
  const raceHistory = useRaceHistory(telemetry.race, telemetry.runId, {
    trackId,
    carId,
    kind: raceKind === "ai" ? "ai_race" : raceKind === "mp" ? (inScheduledRace ? "open_race" : "room_race") : null,
  });
  /**
   * Out of this open race (the others finish without this player) and into the next one, waited for on the title's
   * Multiplayer panel, where its entry counts down
   */
  const handleJoinNextRace = useCallback(() => {
    handleBackToLobby();
    handleJoinRace();
  }, [handleBackToLobby, handleJoinRace]);

  // The note after a drive (support-prompt.ts): how long this circuit and car were driven, and, back on the main
  // menu after a real drive, who made them, for the makers who take donations
  const [supportNote, setSupportNote] = useState<PromptItem[] | null>(null);
  const driveTime = useRef<{ pair: string; ms: number; since: number | null }>({ pair: "", ms: 0, since: null });
  const lastPhase = useRef(phase);
  useEffect(() => {
    const pair = `${trackId}|${carId}`;
    const d = driveTime.current;
    const now = performance.now();
    if (d.since !== null) {
      const sliceMs = now - d.since;
      d.ms += sliceMs;
      // And to the driver's totals (driver-stats.ts), in the car and circuit it was driven in
      const [drivenTrack, drivenCar] = d.pair.split("|");
      recordDrivingTime(sliceMs / 1000, drivenCar || carId, drivenTrack || trackId);
    }
    d.since = phase === "driving" && !paused ? now : null;
    if (d.pair !== pair) {
      d.pair = pair;
      d.ms = 0;
    }
  }, [phase, paused, trackId, carId]);
  useEffect(() => {
    const was = lastPhase.current;
    lastPhase.current = phase;
    if (phase === "driving") setSupportNote(null);
    if (phase !== "title" || was !== "driving" || isStoreBuild()) return;
    // A room or a race entry takes the title's place: a note written as shown there would never have been seen
    if (roomLobby !== null || inScheduledRace) return;
    const items: PromptItem[] = [];
    const circuit = circuitMaker(trackId);
    const track = getTrackInfo(trackId);
    if (circuit?.support) items.push({ key: `circuit:${track.name}`, kind: "circuit", title: track.name, maker: circuit.name, role: circuit.role, support: circuit.support });
    const car = carMaker(carId);
    if (car.support) items.push({ key: `car:${carId}`, kind: "car", title: carById(carId).title, maker: car.name, role: car.role, support: car.support });
    let store: Storage | null = null;
    try {
      store = window.localStorage;
    } catch {
      store = null;
    }
    const state = readPromptState(store);
    const now = Date.now();
    const note = promptFor(items, driveTime.current.ms, state, now);
    if (!note) return;
    writePromptState(store, markShown(state, note, now));
    setSupportNote(note);
    // Read when the phase changes, with the circuit and car of that moment
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);
  const closeSupportNote = useCallback(() => setSupportNote(null), []);
  const supportThanked = useCallback((maker: string) => {
    try {
      writePromptState(window.localStorage, markThanked(readPromptState(window.localStorage), maker));
    } catch {
      // Storage blocked: the maker may be named again some week
    }
  }, []);

  /** The bug report's facts, read when it opens; from the pause menu with where the car is (`fromDrive`) */
  const reportFacts = (fromDrive: boolean): ReportFacts => {
    const snap = session?.getSnapshot();
    const mode =
      raceKind === "ai"
        ? "Race against AI"
        : raceKind === "mp"
          ? inScheduledRace
            ? "Open race"
            : "Room race"
          : activeTrial
            ? isPermanentChallenge(activeTrial)
              ? "Middle Gear Lap Board"
              : "Weekly challenge"
            : "Practice";
    return collectReportFacts({
      settings: settingsRef.current,
      touchVisible,
      lastLapInput: lapSummary?.recording.conditions?.input ?? null,
      boardState: boardStateRef.current,
      drive:
        fromDrive && snap
          ? { telemetry: session?.getTelemetry() ?? snap.telemetry, mode, replay: snap.replay.active, waterMm: trackEnvRef.current?.weather.lineWaterMm ?? 0 }
          : null,
    });
  };

  const telemetrySource = useMemo(
    () => (session ? { subscribe: session.subscribeTelemetry, getSnapshot: session.getTelemetry } : undefined),
    [session]
  );

  const menuProps = {
    telemetry,
    settings,
    onChangeSettings: handleChangeSettings,
    steerLockDeg,
    pauseNotice,
    aeroPreset,
    assistPreset,
    cameraMode: activeCameraMode,
    onSelectCamera: setCameraMode,
    onToggleFreeCamera: toggleFreeCamera,
    onToggleTvCamera: toggleTvCamera,
    tireCompound,
    selectedLivery,
    showRacingLine,
    isMuted: muted,
    mouseSteerEnabled,
    gamepadAssist,
    autoGearbox,
    onSetAutoGearbox: setAutoGearbox,
    gamepadRumble,
    aiOpponents: raceKind === "ai",
    // A career round is raced on its own terms: its field, skill, setup and car are not the pause menu's to change
    onToggleAiOpponents: career.driving ? undefined : handleToggleAiOpponents,
    aiSkill: settings.aiSkill,
    onChangeAiSkill: career.driving ? undefined : handleChangeAiSkill,
    raceSetup: settings.race,
    onChangeRaceSetup: career.driving ? undefined : handleChangeRaceSetup,
    carId,
    vehicleModel,
    onChangeCar: career.driving ? noCarChange : handleChangeCar,
    onToggleGamepadAssist: handleToggleGamepadAssist,
    onToggleGamepadRumble: handleToggleGamepadRumble,
    p2pStatus,
    onChangeAeroPreset: handleAeroPresetChange,
    onChangeAssistPreset: handleAssistPresetChange,
    onChangeTireCompound: handleTireCompoundChange,
    onChangePitStrategy: handlePitStrategy,
    tyreSetup,
    defaultTyreSetup,
    onChangeTyreSetup: handleChangeTyreSetup,
    chassisSetup,
    onChangeChassisSetup: handleChangeChassisSetup,
    onChangeLiveTuner: handleChangeLiveTuner,
    onChangeLivery: handleLiveryChange,
    onToggleRacingLine: handleToggleRacingLine,
    onToggleMute: handleToggleMute,
    nowPlaying,
    onSkipTrack: session ? session.nextTrack : undefined,
    musicMuted: settings.audio.musicMuted,
    onToggleMusicMute: handleToggleMusicMute,
    onToggleAiAutopilot: handleToggleAiAutopilot,
    onToggleMouseSteer: handleToggleMouseSteer,
    onResetCar: handleResetCar,
    // An AI race's qualifying (a career round's or the player's own race's): the pause menu ends it as the clock would
    onEndQualifying: qualifying && session ? session.finishQualifyingNow : undefined,
    challengeTarget: targetShown ? challengeTargetNow : null,
    // A round is raced from the lights; a test day is practice, round the circuit as the player likes
    onSelectTurn: career.racing ? noTurnJump : handleSelectTurn,
    careerRound: career.racing ? { restartNote: career.canRestart ? tx("restartMulligan", { count: career.mulligansLeft }) : null } : undefined,
    careerDrive: career.driving,
    onHostP2PRoom: handleHostP2PRoom,
    onJoinP2PRoom: handleJoinP2PRoom,
    onCreateManualOffer: handleCreateManualOffer,
    onAcceptManualOffer: handleAcceptManualOffer,
    onAcceptManualAnswer: handleAcceptManualAnswer,
    onTogglePause: togglePause,
    // `?perf=1`: the pause menu copies or saves the session's performance report
    perfReport: session?.perfReport ?? null,
    // The bug report: what the game knows when it opens, and a picture of the scene from the pause menu
    reportFacts,
    captureScreen: session ? session.captureFrame : undefined,
    keyNames,
    // The lap board while driving, with an online board only
    onChangeBoardWidget: boardOn ? handleChangeBoardWidget : undefined,
    lobby: roomLobby,
    localPeerId,
    isHost: isMpHost,
    peerStats,
    profile: settings.profile,
    currentTrackId: trackId,
    currentVehicle: vehicleModel,
    vehicleLabel,
    vehiclesForClass: vehicleModelsFor,
    carsForClass: classCars,
    raceRunning: raceKind === "mp",
    startBlocked: getActivePointToPoint() ? tx("noRacesOnHillClimb") : undefined,
    onHostLocal: handleHostLocal,
    onSetLobbySettings: handleSetLobbySettings,
    onSetReady: handleSetReady,
    onStartRace: handleStartMpRace,
    onAbortRace: handleAbortMpRace,
    onSwitchTrack: onSelectTrack,
    onSwitchCar: (id: string) => handleChangeCar(id as CarId),
    displayPanel: {
      settings,
      onChangeSettings: handleChangeSettings,
      onRenameDriver: renameFromSettings,
      vrSupported,
      vrActive: vrState === "on",
      onEnterVr: () => session?.enterVr(),
      onOpenSeatPanel: phase === "driving" ? () => session?.openSeatPanel() : undefined,
    },
    // Weather, time of day and the track's grip: the title's Conditions panel and the pause menu's Conditions tab
    conditionsPanel: {
      conditions: ownConditions,
      trackTimeOfDay,
      realism: settings.realism,
      onChangeConditions: handleChangeConditions,
      onChangeRealism: handleChangeRealism,
      hostControlled: roomLobby !== null && !isMpHost,
      // A career round's weather, time of day and grip are the round's own (its seed), not changed mid-round
      roundControlled: career.racing,
      readout: weatherHud,
    },
    library,
    leaderboardPanel: {
      trackName: getTrackInfo(trackId).name,
      trackId,
      trackNameOf,
      circuits: BOARD_CIRCUITS,
      loadAllLocal: loadAllLocalLaps,
      vehicleLabel,
      carTag: carBoardTag,
      local: localLaps,
      sessionLaps,
      allTimeBestLap,
      latestLap,
      turns: trackTurns,
      sectorSplitsM: trackSectorSplitsM,
      remoteEnabled: boardOn,
      remoteStatus: boardState === null ? ("unknown" as const) : boardState === "unreachable" ? ("unreachable" as const) : ("off" as const),
      boardVersion,
      vehicle: vehicleModel,
      driverName: settings.profile.name,
      onRaceGhost: (entry: LeaderboardEntry) => void handleRaceGhostEntry(entry),
      onApplySetup: handleApplyLeaderboardSetup,
      setupNotice: setupBoardNotice,
      onDismissSetupNotice: () => setSetupBoardNotice(null),
      boardStatus: boardStatusOf,
      onPostLap: handlePostBest,
      onImportGhost: (file: File) => void handleImportGhost(file),
      onExportBest: () => void handleExportBest(),
      onExportDriverKey: handleExportDriverKey,
      onImportDriverKey: (file: File) => void handleImportDriverKey(file),
      driverKeyNotice,
      onSignIn: signedOut ? () => openSettings(phase === "title" ? "title" : "pause", "profile", "account") : undefined,
    },
  };

  /** What the Settings screen reads and changes (the same rows first-run setup draws) */
  const settingsEnv: SettingsEnv = {
    settings,
    update: handleChangeSettings,
    rumble: gamepadRumble,
    onToggleRumble: handleToggleGamepadRumble,
    steerLockDeg,
    carId,
    vehicleModel,
    vehicleLabel,
    carFovDeg: carCockpitFov,
    vrSupported,
    vrActive: vrState === "on",
    onEnterVr: () => session?.enterVr(),
    autoQualityLowered,
    onRenameDriver: renameFromSettings,
    onOpenSeatPanel:
      phase === "driving"
        ? () => {
            setSettingsOpen(null);
            session?.openSeatPanel();
          }
        : undefined,
    // The live HUD's layout editor, over the title scene or the paused race: Settings comes back on its HUD tab after
    onEditHudLayout:
      phase === "title" || phase === "driving"
        ? () => {
            setSettingsOpen((open) => (open ? { ...open, category: "display", tab: "hud" } : open));
            setHudEditing(true);
          }
        : undefined,
    onRunSetup: runSetupAgain,
    driverKey: {
      onExport: handleExportDriverKey,
      onImport: (file: File) => void handleImportDriverKey(file),
      notice: driverKeyNotice,
    },
  };

  return (
    <div
      className="relative h-screen w-screen overflow-hidden bg-lc-void supports-[height:100dvh]:h-dvh"
      onPointerDown={() => {
        // Not for a press on the GPU notice: that session is about to go, and a sound bank loading then lands on its
        // closed audio context
        if (phaseRef.current !== "loading" && !gpuNoticeKind) session?.unlockAudio();
      }}
    >
      <div ref={containerRef} className="h-full w-full" />
      <OverheadNameplates overlayRef={nameplatesRef} />

      {/* Everything else: the whole window (no box of its own), or the centre screen of three. There its layout
          containment makes it the box the fixed layers inside place themselves in (and clips them to it), and as a
          size container their cqw widths measure it */}
      <div
        id={UI_FRAME_ID}
        className={uiFrameRect ? "absolute inset-y-0" : "contents"}
        style={uiFrameRect ? { left: uiFrameRect.x, width: uiFrameRect.w, containerType: "size", contain: "layout paint" } : undefined}
      >

      {phase === "driving" && seatPanel ? (
        <SeatPanel
          carTitle={carById(carId).title}
          view={seatView}
          nudge={nudgeOf(settings.cameraNudges, carId, seatView)}
          fovDeg={clampFov(
            (seatView === "dash" ? dashViewFovDeg(carId) : carCockpitFov) +
              (cockpitFovInUse === null ? 0 : cockpitFovInUse - carCockpitFov) +
              nudgeOf(settings.cameraNudges, carId, seatView).fovDeg
          )}
          onStep={handleSeatStep}
          onSetView={setCameraMode}
          onClose={() => session?.closeSeatPanel()}
          cameraKeys={settings.keys.camera}
          cameraButton={settings.padButtons.camera}
        />
      ) : null}

      {phase === "driving" || hudEditing ? (
        <F1TelemetryHud
          {...menuProps}
          telemetrySource={telemetrySource}
          hudEditor={hudEditing ? { onClose: () => setHudEditing(false) } : null}
          seatPanel={seatPanel}
          track={track}
          weather={weatherHud}
          boostLatch={boostLatch}
          qualityNotice={qualityNotice}
          showLaunchHint={launchHint}
          launchHintText={launchHintText}
          hudToggleButton={settings.padButtons.hud === null ? undefined : padButtonLabel(settings.padButtons.hud)}
          wheelUncalibrated={
            settings.device === "wheel" && (!settings.wheel.throttle || !settings.wheel.brake)
          }
          onCycleCamera={cycleCamera}
          onOffTrackGlow={handleOffTrackGlow}
          inviteRoom={inviteRoom}
          cockpitFovDeg={cockpitFovInUse}
          cockpitFovDefaultDeg={carCockpitFov}
          onChangeCockpitFov={handleCockpitFovChange}
          onToggleXMode={handleToggleXMode}
          onToggleBoostLatch={handleToggleBoostLatch}
          onOvertake={handleOvertake}
          onChangeLiveTuner={handleChangeLiveTuner}
          paused={paused}
          pauseMenuCovered={settingsOpen?.from === "pause"}
          onOpenControls={() =>
            // A wheel whose pedals are not set up yet opens on its calibration (the HUD's "pedals not set up" too)
            settings.device === "wheel" && (!settings.wheel.throttle || !settings.wheel.brake)
              ? openSettings("pause", "controls", "wheel")
              : openSettings("pause")
          }
          onExitToTitle={career.driving ? career.backToCareer : leaveSession}
          onOpenSettings={(category?: SettingsCategory, tab?: string) => openSettings("pause", category, tab)}
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
                  onAnalyze: sessionLaps.length > 0 || allTimeBestLap || latestLap ? () => setAnalysisOpen(true) : undefined,
                  // Laps post themselves: the button is there with that turned off, or to retry a failed upload (a board
                  // that hasn't answered yet is asked again by the press)
                  onSubmit:
                    (boardState === "on" || boardState === "unreachable") &&
                    lapGoesOnBoards(lapSummary.recording) &&
                    lapSummary.summary.valid &&
                    !lapSummary.summary.autopilot &&
                    (!settings.profile.autoUpload || submitState === "error" || submitState === "waiting")
                      ? () => void handleSubmitLap()
                      : undefined,
                  submitState,
                  submitRank,
                  // The boards answer in English: shown in the player's language
                  submitError: boardWords(submitError),
                  // A lap with a mod car or on a mod circuit never goes up: the card says so where Post would be
                  offBoards:
                    (boardState === "on" || boardState === "unreachable") && !lapGoesOnBoards(lapSummary.recording)
                      ? boardWords(MOD_LAP)
                      : undefined,
                  driverName: settings.profile.name,
                  // A name changed from the card: the lap the card couldn't post goes up again under it
                  onRename: boardOn
                    ? async (raw: string) => {
                        const res = await renameDriver(raw);
                        if ("error" in res) return boardWords(res.error);
                        if (submitState === "error") void handleSubmitLap(res);
                        return null;
                      }
                    : undefined,
                  // Settings pauses the session under it, which an online race can't do
                  onSignIn: signedOut && raceKind !== "mp" ? () => openSettings("pause", "profile", "account") : undefined,
                }
              : null
          }
          resultsClosed={resultsClosed}
          onCloseResults={() => setResultsClosed(true)}
          onRestartRace={
            (raceKind === "mp" && !isMpHost) || !career.canRestart ? undefined : () => handleResetCar(false)
          }
          onBackToLobby={raceKind === "mp" ? handleBackToLobby : career.driving ? career.backToCareer : undefined}
          backToLobbyLabel={inScheduledRace ? tx("backToRaces") : career.driving ? tx("backToCareer") : undefined}
          preRaceShow={preRaceShow}
          raceEnd={{
            podium: podiumUi,
            onSkipPodium: () => session?.podium.skip(),
            podiumTimeS: session?.podium.boardTimeS,
            history: raceHistory,
            nextRace: raceKind === "mp" && inScheduledRace && races.on ? { slotS: races.slotS, onJoin: handleJoinNextRace } : undefined,
          }}
          onWatchReplay={raceKind !== "mp" && p2pStatus.state !== "connected" && p2pStatus.roomCode.length === 0 && replayAvailable ? handleWatchRaceReplay : undefined}
          onOpenReplay={raceKind !== "mp" && p2pStatus.state !== "connected" && p2pStatus.roomCode.length === 0 && replayAvailable ? handleOpenPauseReplay : undefined}
          replay={
            replayUi.active
              ? {
                  timeS: replayUi.timeS,
                  startS: replayUi.startS,
                  endS: replayUi.endS,
                  playing: replayUi.playing,
                  speed: replayUi.speed,
                  cameraMode: activeCameraMode,
                  cameraLabel: CAMERA_MODES[activeCameraMode].label,
                  focusedCarId: replayUi.focusedCarId,
                  cars: replayUi.cars,
                  lapMarkers: replayUi.lapMarkers,
                  onTogglePlay: () => session?.replayTogglePlay(),
                  onSeek: (timeS: number) => session?.replaySeek(timeS),
                  onSpeed: (speed: number) => session?.replaySpeed(speed),
                  onStepFrame: (dir: 1 | -1) => session?.replayStepFrame(dir),
                  onSelectCamera: (mode: CameraMode) => session?.setCameraOverride(mode),
                  onCycleCamera: cycleCamera,
                  onCycleCar: replayUi.cars.length > 1 ? (dir: 1 | -1) => session?.replayCycleCar(dir) : undefined,
                  onExit: () => session?.exitReplay(),
                  onFlashback: replayUi.canFlashback ? () => { session?.flashbackReplay(); } : undefined,
                  exitKeyLabel: settings.keys.replay[0] ? keyLabel(settings.keys.replay[0]) : "T",
                }
              : null
          }
          touchControls={
            touchVisible && vrState !== "on"
              ? {
                  layout: settings.touch.layout,
                  tiltSteer: settings.touch.tiltSteer,
                  tiltRangeDeg: settings.touch.tiltRangeDeg,
                  autoGearbox,
                  onPause: togglePause,
                  onCycleCamera: cycleCamera,
                  showHeadlights: Boolean(
                    weatherHud?.headlightsAutoOn ||
                      weatherHud?.headlightsOn ||
                      (weatherHud?.headlightMode && weatherHud.headlightMode !== "auto"),
                  ),
                  headlightsOn: Boolean(weatherHud?.headlightsOn),
                  onToggleHeadlights: () => session?.runAction("headlights"),
                }
              : null
          }
        />
      ) : null}

      {phase === "title" && !hudEditing ? (
        <TitleMenu
          {...menuProps}
          // The note after a drive: on the main menu only, never over a room or a race entry
          supportNote={roomLobby === null && !inScheduledRace ? supportNote : null}
          onCloseSupportNote={closeSupportNote}
          onSupportThanked={supportThanked}
          onCycleCamera={cycleCamera}
          initialRoomCode={inviteRoom ?? ""}
          // The scheduled race's car rule: its lobby is not passed as a room's, but its car browser refuses the same cars
          carRule={inScheduledRace ? (lobby?.settings ?? null) : null}
          // Back where the player was when a race entry or a room moved the game to another circuit (the scene reloads)
          initialPanel={titleInitialPanel ?? (inScheduledRace || inviteRoom || (roomLobby && !isMpHost) ? "multiplayer" : null)}
          firstRun={!onboarded}
          onDrive={() => handleTitleStart(false)}
          onRaceAi={() => handleTitleStart(true)}
          onControls={() => openSettings("title")}
          onOpenSettings={(category?: SettingsCategory) => openSettings("title", category)}
          onOpenCareer={career.openScreen}
          careerStatus={career.status}
          trackId={trackId}
          onSelectTrack={onSelectTrack}
          challengePanel={
            boardOn
              ? {
                  trials: [
                    {
                      event: challenge,
                      title: tr("menu.challenge.weeklyTitle"),
                      trackName: challengeTrackName(challenge.trackId),
                      carTitle: weekCar(challenge).title,
                      available: challengeAvailable,
                      loadBoard: loadWeeklyBoard,
                      onDrive: handleDriveWeekly,
                      hasRaces: races.on && racesAvailable,
                    },
                    {
                      event: MIDDLE_GEAR_CHALLENGE,
                      title: tr("menu.challenge.middleGearTitle"),
                      trackName: challengeTrackName(MIDDLE_GEAR_CHALLENGE.trackId),
                      carTitle: weekCar(MIDDLE_GEAR_CHALLENGE).title,
                      available: middleGearAvailable,
                      loadBoard: loadMiddleGearBoard,
                      onDrive: handleDriveMiddleGear,
                    },
                  ],
                  boardVersion,
                  driverName: settings.profile.name,
                  driverNameGenerated: needsDriverNamePrompt(settings.profile),
                  onRenameDriver: renameFromSettings,
                  onConfirmDriverName: confirmDriverName,
                }
              : undefined
          }
          races={
            races.on && racesAvailable
              ? {
                  trackName: challengeTrackName(challenge.race.trackId),
                  carTitle: weekCar(challenge.race).title,
                  slotS: races.slotS,
                  laps: challenge.race.laps,
                  entry: raceEntry,
                  entrants: inScheduledRace ? (lobby?.players ?? []).map((p) => ({ id: p.peerId, name: p.name, code: p.code, me: p.peerId === localPeerId })) : [],
                  driverName: settings.profile.name,
                  onJoin: handleJoinRace,
                  onLeave: handleLeaveRace,
                }
              : undefined
          }
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
          onRenameDriver={renameFromSettings}
          onConfirmDriverName={confirmDriverName}
          onFinish={finishWizard}
          onExit={leaveWizard}
          onSkip={wizardMode === "first-run" ? finishWizard : undefined}
          onStepChange={handleWizardStep}
        />
      ) : null}

      {career.open && phase === "title" && !hudEditing ? (
        <CareerScreen
          save={career.save}
          content={career.content}
          playerCode={settings.profile.code}
          playerName={settings.profile.name}
          onSave={career.commit}
          onClose={career.closeScreen}
          onRaceNext={career.raceNext}
          onTestDay={career.testDay}
          summaries={career.summaries}
          onCloseSummary={career.closeSummary}
          unfinished={career.unfinished}
          onResolveUnfinished={career.resolveUnfinished}
        />
      ) : null}

      {settingsOpen && !hudEditing ? (
        <SettingsScreen
          env={settingsEnv}
          initialCategory={settingsOpen.category}
          initialTab={settingsOpen.tab}
          onClose={closeSettings}
        />
      ) : null}

      {/* Wheel force feedback over WebHID waits for one pairing click: offered on the title and the pause menu (not over
          Settings, which offers it itself), never mid-lap */}
      <FfbPairPrompt wanted={hidFfbWanted && settings.wheel.steer !== null && !settingsOpen && (phase === "title" || (phase === "driving" && paused))} />
      <DualSensePairPrompt wanted={phase === "title" && !settingsOpen && !(hidFfbWanted && settings.wheel.steer !== null)} />
      <TripleScreenPrompt
        wanted={phase === "title" && !settingsOpen && settings.screens.mode === "single" && vrState !== "on"}
        onSetUp={() => openSettings("title", "display", "screens")}
      />

      {loadingVisible ? (
        // Under the GPU notice it takes no press: the notice's own buttons would start it too
        <LoadingScreen
          track={track}
          carId={carId}
          ready={assetsReady && !gpuNoticeKind}
          cameraKey={settings.keys.camera[0]}
          freeCameraKey={settings.keys.freeCamera[0]}
          tvCameraKey={settings.keys.tvCamera[0]}
          lineKey={settings.keys.racingLine[0]}
          onStart={handleLoadingStart}
          onDone={handleLoadingDone}
        />
      ) : null}

      <NowPlayingToast nowPlaying={nowPlaying} />

      {mpCarNotice ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed top-[max(1rem,env(safe-area-inset-top))] left-1/2 z-(--z-lc-results) -translate-x-1/2 max-w-[min(480px,calc(100%-2rem))]"
        >
          <div
            key={mpCarNotice.seq}
            className="lc-toast-in flex items-center gap-2.5 rounded-lc-tile border border-lc-caution/40 bg-lc-carbon/95 px-4 py-2.5 text-[13px] leading-snug font-semibold text-lc-chalk shadow-lc-pop"
          >
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-lc-caution" />
            <span>{mpCarNotice.text}</span>
          </div>
        </div>
      ) : null}

      {gpuNoticeKind ? (
        <GpuLostNotice
          kind={gpuNoticeKind}
          canLower={settings.graphics.quality !== "low"}
          onLower={() => restartAfterGpuLoss(true)}
          onRetry={() => restartAfterGpuLoss(false)}
          onReloadPage={() => window.location.reload()}
        />
      ) : null}
      <LapTelemetryModal
        open={analysisOpen && (sessionLaps.length > 0 || Boolean(allTimeBestLap) || Boolean(latestLap))}
        sessionLaps={sessionLaps}
        bestLap={allTimeBestLap}
        latestLap={latestLap}
        turns={trackTurns}
        sectorSplitsM={trackSectorSplitsM}
        trackName={getTrackInfo(trackId).name}
        onClose={() => setAnalysisOpen(false)}
      />
      </div>
    </div>
  );
};
