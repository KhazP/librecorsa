"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DEFAULT_TRACK_ID, getActiveTrackData, LIVERIES } from "@/lib/track-data";
import { FfbPairPrompt } from "@/components/hud/FfbPairPrompt";
import { isVehicleModelId, vehicleModelsFor } from "@/lib/cars/vehicle-models";
import { CARS, carForVehicle, type CarId } from "@/lib/cars/car-registry";
import { alignGhostToTrack } from "@/lib/sim/ghost-align";
import { carPhysics, carTakesPhysicsSwitch, subscribeF1ModPhysics } from "@/lib/cars/f1-mod-physics";
import { type ChassisSetup, saveChassisSetup } from "@/lib/sim/car-setup";
import { TrackEnvironment } from "@/lib/sim/track-environment";
import { getMultiplayerManager, type LobbySettings, type LobbyState, type PeerNetStats, type RaceStartInfo, type ScheduledRaceStatus } from "@/lib/sim/multiplayer-sync";
import { getOnlineConfig } from "@/lib/net/online-config";
import { DEFAULT_RACE_SLOT_S } from "@/lib/net/race-schedule";
import { MultiplayerRace } from "@/lib/sim/race-session";
import { GhostPlayer } from "@/lib/sim/lap-recorder";
import { lapBoardClass, lapConditionsNow, type LapConditions, type LapRecording, type LapSummaryData, type LeaderboardEntry } from "@/lib/sim/lap-types";
import { exportLapFile, importLapFile, listBestLaps, loadBestLap, saveBestLapIfFaster } from "@/lib/sim/ghost-store";
import {
  boardOnline,
  fetchRemoteBoard,
  fetchRemoteGhost,
  lapToEntry,
  loadChallengeBest,
  localLeaderboard,
  saveChallengeBest,
  submitLap,
  type BoardFilter,
  type SubmitResult,
} from "@/lib/net/leaderboard";
import { exportDriverKeyFile, importDriverKeyFile } from "@/lib/net/driver-key";
import { challengeAt, fitsChallenge } from "@/lib/net/weekly-challenge";
import { useUsageCounter } from "@/lib/net/use-usage-counter"; // polish:E
import { timeTrialRules } from "@/lib/sim/time-trial";
import { challengeTarget, type ChallengeTarget } from "@/lib/net/challenge-target";
import { isTouchDevice, resetTouchInput } from "@/lib/input/touch-input";
import { isFatalHidStatus } from "@/lib/input/webhid-ffb";
import { SIM_REALISM_FLAGS, type SimRealism } from "@/lib/sim/sim-realism";
import type { SessionConditions } from "@/lib/sim/weather";
import { getTrackInfo, TRACKS } from "@/lib/track-registry";
import { F1TelemetryHud } from "@/components/F1TelemetryHud";
import { roomFromUrl } from "@/lib/net/invite-room";
import { CAMERA_MODES, nextCameraMode } from "@/lib/render/camera-modes";
import { saveTyreSetup } from "@/lib/sim/tyre-setup";
import { LoadingScreen } from "@/components/menu/LoadingScreen";
import { TitleMenu } from "@/components/menu/TitleMenu";
import { FirstRunWizard, type WizardMode, type WizardStepId } from "@/components/menu/FirstRunWizard";
import { keyLabel, padButtonLabel } from "@/lib/input/bindings";
import { autoConfigureWheel, connectedPads } from "@/lib/input/device-input";
import { webHidFfb, wheelFfb } from "@/lib/input/wheel-ffb";
import { clampFov, codeFromName, DEFAULT_PLAYER_SETTINGS, loadCarChoice, loadOnboarded, loadPlayerSettings, loadRumble, pushLibraryRecent, saveCarChoice, saveOnboarded, toggleLibraryFavorite, type LibraryKind, sanitizeDriverName, savePlayerSettings, saveRumble, type PlayerSettings } from "@/lib/settings/player-settings";
import type { AeroSetupPreset, AssistPreset, CameraMode, LiveTunerPatch, LiveryConfig, TireCompound, TyreSetup, VehicleModelId } from "@/types/f1";
import { aiFieldOf, autoCompoundFor, DEFAULT_AERO_PRESET, DriveSession, idleDriveSnapshot, mpRaceOf, type AppPhase, type RunResetReason, type SessionRace } from "@/lib/drive-session";
import { startAiRace, type RaceSetup } from "@/lib/sim/race-setup";

const DEFAULT_ASSIST_PRESET: AssistPreset = DEFAULT_PLAYER_SETTINGS.assistPreset;
/** A lap record's car: records are per vehicle model, named after its first car */
const vehicleLabel = (id: string) => (isVehicleModelId(id) ? carForVehicle(id).title : id);
/** Every personal best in this browser (Lap times switches circuit and car without reloading the scene) */
const loadAllLocalLaps = () => listBestLaps().then((laps) => laps.map((lap) => lapToEntry(lap, "local")));
/** The place an upload's answer gives the lap on its board (and on the week's challenge); null when it failed or said none */
const placeOf = (res: SubmitResult): { rank: number; total: number | null; challengeRank: number | null } | null =>
  res.ok && res.rank !== undefined ? { rank: res.rank, total: res.total ?? null, challengeRank: res.eventRank ?? null } : null;
/** The weekly challenge a lap was driven to (its id), if it fits this week's */
const challengeOf = (rec: LapRecording): string | undefined => {
  const week = challengeAt(Date.now());
  return fitsChallenge(rec, week) ? week.id : undefined;
};
/** Uploads a lap, to this week's challenge board too when it fits; remembers the lap the challenge board took */
const uploadLap = async (rec: LapRecording): Promise<SubmitResult> => {
  const event = challengeOf(rec);
  const res = await submitLap(rec, { event }).catch((): SubmitResult => ({ ok: false }));
  if (res.ok && event && res.eventRank !== undefined) saveChallengeBest(event, rec.lapTimeMs);
  return res;
};
// A lap on a circuit this build no longer lists keeps its id as its name (getTrackInfo would name it after another)
const trackNameOf = (id: string) => TRACKS.find((t) => t.id === id)?.name ?? id;
/** A circuit's name for the weekly challenge and its races, with the layout when the venue has more than one */
const challengeTrackName = (id: string) => {
  const t = getTrackInfo(id);
  return TRACKS.some((o) => o.id !== t.id && o.name === t.name) ? `${t.name} · ${t.layout}` : t.name;
};
/** The snapshot store before the session exists: nothing to subscribe to */
const noSubscribe = () => () => {};
/** A race the host started before this circuit was loaded (or on another one): picked up once the scene has loaded */
let pendingRaceStart: RaceStartInfo | null = null;
/**
 * The weekly challenge to go out on once its circuit has loaded (asked for from another circuit's menu): its id, and
 * whether as a race against the AI (a scheduled race nobody else entered) rather than practice
 */
let pendingChallenge: { id: string; race: boolean } | null = null;
/**
 * The player's own assists, realism and weather while a challenge or a scheduled race has the week's in their place:
 * put back when they leave the car for the menus. (Outside the component: going to the week's circuit reloads it.)
 */
let ownRules: Pick<PlayerSettings, "assistPreset" | "realism" | "conditions"> | null = null;

export interface LibreCorsaSimulatorProps {
  /** Active circuit (already set with `setActiveTrack`; the gate remounts this component on a change) */
  trackId?: string;
  /** Title menu circuit picker */
  /** Switches circuit: settles once the load lands (the scene remounts) or fails (the old circuit stays) */
  onSelectTrack?: (id: string) => void | Promise<void>;
}

export const LibreCorsaSimulator: React.FC<LibreCorsaSimulatorProps> = ({ trackId = DEFAULT_TRACK_ID, onSelectTrack }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** The drive on the mounted circuit: the scene, the car and the frame loop (created once the container exists) */
  const [session, setSession] = useState<DriveSession | null>(null);

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
  const getTrackEnv = useCallback(
    () => (trackEnvRef.current ??= new TrackEnvironment(track, settingsRef.current.conditions)),
    [track]
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
    boostLatch,
    tireCompound,
    tyreSetup,
    defaultTyreSetup,
    chassisSetup,
    timeTrial,
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
  /** The results card was closed for this race */
  const [resultsClosed, setResultsClosed] = useState(false);

  // ---- Laps, ghosts, leaderboards
  const [lapSummary, setLapSummary] = useState<{ summary: LapSummaryData; recording: LapRecording } | null>(null);
  const [submitState, setSubmitState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  /** Place of the uploaded lap on its board, and how many drivers that board has */
  const [submitRank, setSubmitRank] = useState<ReturnType<typeof placeOf>>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** Bumped by every new or closed lap card and every upload: only the upload of the card still shown may land on it */
  const submitReqRef = useRef(0);
  const [driverKeyNotice, setDriverKeyNotice] = useState<string | null>(null);
  const ghostSourceRef = useRef<"pb" | "other">("pb");
  /** Bumped by every ghost choice, so a slower PB load cannot replace a ghost picked after it started */
  const ghostReqRef = useRef(0);
  /** Bumped by every leaderboard refresh; only the latest one updates the panel */
  const leaderboardReqRef = useRef(0);
  /** This car's best laps on this circuit, saved in this browser */
  const [localLaps, setLocalLaps] = useState<LeaderboardEntry[]>([]);
  /** Bumped when the online board may have changed (a lap went up), so the panel reads it again */
  const [boardVersion, setBoardVersion] = useState(0);
  /** This site has an online lap board switched on (asked once at start) */
  const [boardOn, setBoardOn] = useState(false);
  const boardOnRef = useRef(false);
  /** Scheduled races run on this site, and how often (seconds) */
  const [races, setRaces] = useState<{ on: boolean; slotS: number }>({ on: false, slotS: DEFAULT_RACE_SLOT_S });
  /** This player's entry in the next scheduled race */
  const [raceEntry, setRaceEntry] = useState<ScheduledRaceStatus>({ state: "idle", startsMs: null, text: "" });
  useEffect(() => {
    let live = true;
    void boardOnline().then((on) => {
      boardOnRef.current = on;
      if (live) setBoardOn(on);
    });
    void getOnlineConfig().then((config) => {
      if (live) setRaces({ on: config.races, slotS: config.raceSlotS });
    });
    return () => {
      live = false;
    };
  }, []);

  // ---- VR, FFB meter
  const [vrSupported, setVrSupported] = useState(false);
  const [ffbMeter, setFfbMeter] = useState(wheelFfb.meter);
  const [touchVisible, setTouchVisible] = useState(false);

  /** The next view in the camera cycle, from the key, the pad, the touch pads and the menus alike */
  const cycleCamera = useCallback(() => setSettings((prev) => ({ ...prev, camera: nextCameraMode(prev.camera ?? "chase") })), []);

  // ---- Session and run: the one place that starts, restarts and leaves what is on track (the session resets the run)
  /** A new run re-opens the race results card (a flashback keeps it as it was) */
  const onRunReset = useCallback((reason: RunResetReason) => {
    if (reason !== "flashback") setResultsClosed(false);
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
    if (ownRules) {
      const own = ownRules;
      ownRules = null;
      setSettings((prev) => ({ ...prev, ...own }));
    }
    session?.resetRun("session");
    session?.setRace({ kind: "practice" });
    clearSessionState();
    session?.car.resetToStartGrid(false);
    setPhase("title");
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
    (next: CarId) => {
      session?.unlockAudio();
      if (next === carIdRef.current) return;
      carIdRef.current = next;
      setCarId(next);
      vehicleModelRef.current = carPhysics(next);
      setVehicleModel(vehicleModelRef.current);
      saveCarChoice(next);
      session?.setCar(next);
    },
    [session]
  );
  /** The car picker: the car is fixed for a multiplayer race (its start picks one the class allows) */
  const handleChangeCar = useCallback(
    (next: CarId) => {
      if (session?.race.kind === "mp") return;
      changeCar(next);
    },
    [session, changeCar]
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

  const handleLiveryChange = useCallback((livery: LiveryConfig) => setPreference("liveryId", livery.id), [setPreference]);

  const handleToggleRacingLine = useCallback(() => {
    setSettings((prev) => ({ ...prev, racingLine: !prev.racingLine }));
  }, []);

  const handleToggleMute = useCallback(() => session?.toggleMute(), [session]);

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
        if (isMpHostRef.current && !flyingStart) getMultiplayerManager().startRace();
        return;
      }
      // polish:A — a flying restart outside a race puts the time trial's conditions on first
      if (race.kind === "practice" && flyingStart) return session.restartFlyingLap();
      const physics = session.car;
      session.resetRun("restart");
      // A restart from the menu uses the race's own start; the flying-lap key always gives a rolling one
      if (race.kind === "ai") startAiRace(race.field, settingsRef.current.race, flyingStart ? false : undefined);
      else physics.resetToStartGrid(flyingStart);
    },
    [session]
  );

  const handleToggleAiOpponents = useCallback(() => {
    session?.unlockAudio();
    // Not in a multiplayer race: the AI field would run alongside it
    if (!session || session.race.kind === "mp") return;
    session.resetRun("race");
    if (session.race.kind === "ai") {
      session.setRace({ kind: "practice" });
      return;
    }
    const field = session.takeAiField();
    session.setRace({ kind: "ai", field });
    startAiRace(field, settingsRef.current.race);
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
  const handleHostP2PRoom = useCallback(() => getMultiplayerManager().hostRoom(), []);
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
      const car = session?.car;
      const autoCompound = autoCompoundFor(env.weather.lineWaterMm, car?.tireCompound);
      if (car && car.tireCompound !== autoCompound) handleTireCompoundChange(autoCompound);
    }
  }, [conditionsKey, getTrackEnv, session, handleTireCompoundChange]);
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
      const field = race && session ? (aiFieldOf(session.race) ?? session.takeAiField()) : null;
      startSession(field ? { kind: "ai", field } : { kind: "practice" });
      if (field) startAiRace(field, settingsRef.current.race);
      else session?.car.resetToStartGrid(false);
      setLaunchHint(true);
    },
    [session, startSession]
  );

  // In the menus (after loading, after a race): have the next race's AI field ready (a car swap asks for its own)
  useEffect(() => {
    if (phase === "loading" || phase === "driving" || !assetsReady) return;
    session?.prepareAiField();
  }, [session, phase, assetsReady]);

  /** The week's challenge rules: its assists and realism, a dry track (its car and circuit are the caller's to set) */
  const applyWeekRules = useCallback(() => {
    const week = challengeAt(Date.now());
    const own = settingsRef.current;
    ownRules ??= { assistPreset: own.assistPreset, realism: own.realism, conditions: own.conditions };
    setSettings((prev) => ({
      ...prev,
      assistPreset: week.assists,
      realism: week.realism,
      conditions: { ...prev.conditions, weather: "clear", weatherNodes: undefined },
    }));
  }, []);

  /** A multiplayer race was started (by us as host, or by the host): line up in our grid slot behind the lights */
  const startMpRace = useCallback(
    (start: RaceStartInfo) => {
      const mp = getMultiplayerManager();
      const roster = mp.lobby?.players ?? [];
      const profile = settingsRef.current.profile;
      const race = new MultiplayerRace(start, track.totalLengthM, mp.localPeerId, profile, roster);
      startSession({ kind: "mp", race });
      // The class may rule out the current car, or the race names one car for everyone (a scheduled race): take it,
      // or the first allowed one (after the session reset, so the swap finds no replay or AI field to carry over)
      const allowed = start.vehicle ? [start.vehicle] : vehicleModelsFor(start.carClass);
      if (!allowed.includes(vehicleModelRef.current)) changeCar(carForVehicle(allowed[0]).id);
      // A scheduled race is driven to the week's rules: its assists and realism, a dry track
      if (mp.inScheduledRace) applyWeekRules();
      const physics = session?.car;
      if (physics) {
        physics.resetToStartGrid(false, race.gridSlot);
        race.lapClock.reset(physics.sMeters);
      }
    },
    [session, track, changeCar, startSession, applyWeekRules]
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
      }),
    [session, getTrackEnv]
  );
  const refreshLeaderboard = useCallback(async () => {
    // Several refreshes can overlap (car change, a saved lap): only the latest may land
    const req = ++leaderboardReqRef.current;
    const local = await localLeaderboard(trackId, vehicleModelRef.current).catch((): LeaderboardEntry[] => []);
    if (req !== leaderboardReqRef.current) return;
    setLocalLaps(local);
    setBoardVersion((v) => v + 1);
  }, [trackId]);
  /** One online board for the Lap Times panel, with this player's place on it */
  const loadRemoteBoard = useCallback(
    (track: string, vehicle: VehicleModelId, filter: BoardFilter, physics: number) =>
      fetchRemoteBoard(track, vehicle, { filter, physics, name: settingsRef.current.profile.name }).catch(() => null),
    []
  );

  /** Races the personal best of this car as the ghost, replacing whichever lap was chosen */
  const loadPbGhost = useCallback(async () => {
    // A ghost picked (or another car's PB requested) while this one loads wins over it
    const req = ++ghostReqRef.current;
    // The best on the board the player is driving now (an assisted best is not their pro reference)
    const rec = await loadBestLap(trackId, vehicleModelRef.current, lapBoardClass(currentBoard())).catch(() => null);
    if (req !== ghostReqRef.current) return;
    ghostSourceRef.current = "pb";
    // A best from an earlier version of the circuit is moved onto this one
    session?.setGhost(rec ? new GhostPlayer(alignGhostToTrack(rec, track).recording) : null);
    session?.lapRecorder.setContext({ personalBestMs: rec?.lapTimeMs ?? null });
  }, [session, trackId, currentBoard, track]);

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
      // The upload this lap's card may show the result of (a later card, or a manual upload, takes over)
      const submitReq = submitReqRef.current;
      void saveBestLapIfFaster(recording)
        .then((saved) => {
          if (saved) {
            if (ghostSourceRef.current === "pb" && ghostReq === ghostReqRef.current && recording.vehicle === vehicleModelRef.current) {
              // Newer than any best still loading from before this lap
              ghostReqRef.current++;
              session?.setGhost(new GhostPlayer(recording));
            }
            void refreshLeaderboard();
          }
          // A new personal best goes on the online board by itself, and so does the best lap of this week's
          // challenge (which an older, faster lap of the same kind doesn't stand in for). Only once the player has a
          // name of their own (the first upload asks for it on the lap card) and unless they turned this off. It
          // fails quietly: the card keeps its upload button
          const week = challengeOf(recording);
          const weekBest = week ? loadChallengeBest(week) : null;
          if (!saved && !(week && (weekBest === null || recording.lapTimeMs < weekBest))) return;
          const profile = settingsRef.current.profile;
          if (!boardOnRef.current || !profile.autoUpload || profile.generated) return;
          const shown = () => submitReq === submitReqRef.current;
          if (shown()) setSubmitState("sending");
          return uploadLap(recording).then((res) => {
            if (res.ok) setBoardVersion((v) => v + 1);
            if (!shown()) return;
            setSubmitState(res.ok ? "sent" : "idle");
            setSubmitRank(placeOf(res));
          });
        })
        .catch(() => {});
    },
    [session, refreshLeaderboard]
  );
  useEffect(() => session?.onLapCompleted(onLapCompleted), [session, onLapCompleted]);

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
    const res = await uploadLap(rec);
    if (res.ok) setBoardVersion((v) => v + 1);
    // The card was closed or replaced by another lap meanwhile: this answer is not about the one shown
    if (req !== submitReqRef.current) return;
    setSubmitState(res.ok ? "sent" : "error");
    setSubmitRank(placeOf(res));
    setSubmitError(res.ok ? null : (res.error ?? null));
  }, [lapSummary]);
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
    if (launchHint && telemetry.speedKmh > 15) setLaunchHint(false);
  }, [launchHint, telemetry.speedKmh]);

  // Silence the pad rumble and FFB as soon as the pause menu opens or the car is left for the menus (the car audio
  // follows the frame loop, which pauses it on every frame the car is not driven, in every phase)
  useEffect(() => {
    const silence = paused || phase !== "driving";
    if (silence) session?.silenceFeedback();
  }, [session, paused, phase]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const session = new DriveSession(container, {
      car: carIdRef.current,
      cycleCamera,
      getTrackEnv,
      handleToggleRacingLine,
      setSettings,
      setRaceKind,
      onRunReset,
      track,
      trackId,
    });
    setSession(session);
    return () => {
      session.dispose();
      setSession(null);
    };
  }, [track, getTrackEnv, handleToggleRacingLine, onRunReset]);

  // Saved settings and the first-run flag are read after mount (the page is prerendered without storage); the
  // session takes the settings on through applySettings, whether it exists yet or not
  useEffect(() => {
    setSettings(loadPlayerSettings());
    setOnboarded(loadOnboarded());
    setInviteRoom(roomFromUrl());
    setSettingsHydrated(true);
  }, []);

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
    /**
     * In the menus a guest follows the host by itself: its circuit, then a car its class allows (or the one car a
     * scheduled race names). While driving it is asked instead (the lobby's "Switch circuit" and car choices), so a lap
     * is never cut short.
     */
    const follow = (l: LobbyState | null) => {
      if (!l || l.hostId === mp.localPeerId || (phaseRef.current !== "title" && phaseRef.current !== "loading")) return;
      if (l.settings.trackId !== trackId) {
        if (onSelectTrack && TRACKS.some((t) => t.id === l.settings.trackId)) onSelectTrack(l.settings.trackId);
        return;
      }
      const allowed = l.settings.vehicle ? [l.settings.vehicle] : vehicleModelsFor(l.settings.carClass);
      if (allowed.length > 0 && !allowed.includes(vehicleModelRef.current)) changeCar(carForVehicle(allowed[0]).id);
    };
    mp.onLobbyChange = (l) => {
      setLobby(l ? { ...l, players: [...l.players] } : null);
      // The host's weather and clock: a guest's session eases to them (a different preset restarts it)
      if (l?.weather && l.hostId !== mp.localPeerId) trackEnvRef.current?.applyWeatherSync(l.weather);
      follow(l);
    };
    // The lobby already here counts too: the scene that just loaded for its circuit still has its car to take
    follow(mp.lobby);
    setRaceEntry(mp.raceStatus);
    mp.onRaceStatusChange = setRaceEntry;
    mp.weatherProvider = () => trackEnvRef.current?.weather.snapshot() ?? null;
    mp.onRaceStart = (start) => {
      // A scheduled race nobody else entered: out of it, and the same race against the AI instead
      if (mp.inScheduledRace && start.grid.length <= 1) {
        mp.leaveScheduledRace();
        soloRaceRef.current();
        return;
      }
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
    const timer = window.setInterval(() => setPeerStats(mp.getPeerStats()), 1000);
    return () => {
      mp.onLobbyChange = undefined;
      mp.onRaceStatusChange = undefined;
      mp.weatherProvider = undefined;
      mp.onRaceStart = undefined;
      mp.onRaceAbort = undefined;
      window.clearInterval(timer);
    };
  }, [session, trackId, onSelectTrack, takeRaceStart, endMpRace, changeCar]);

  // ---- Weekly challenge
  // The week is read when the menus open (it only turns on Monday)
  const challengeWeek = challengeAt(Date.now()).id;
  const challenge = useMemo(() => challengeAt(Date.now()), [challengeWeek]);
  const challengeAvailable = TRACKS.some((t) => t.id === challenge.trackId) && CARS.some((c) => c.physics === challenge.vehicle);
  // The week's races can be on another circuit and car than its time trial
  const racesAvailable = TRACKS.some((t) => t.id === challenge.race.trackId) && CARS.some((c) => c.physics === challenge.race.vehicle);
  const loadChallengeBoard = useCallback(
    () => fetchRemoteBoard(challenge.trackId, challenge.vehicle, { event: challenge.id, name: settingsRef.current.profile.name, limit: 20 }).catch(() => null),
    [challenge]
  );
  // polish:A — the time trial's target on the HUD: the week's board, read again after each upload. Not without a
  // board, or before the player has a name of their own
  const [challengeTargetNow, setChallengeTargetNow] = useState<ChallengeTarget | null>(null);
  const targetShown = timeTrial !== null && timeTrial.vehicle === challenge.vehicle && trackId === challenge.trackId && boardOn && !settings.profile.generated;
  useEffect(() => {
    if (!targetShown) return setChallengeTargetNow(null);
    let live = true;
    void loadChallengeBoard().then((board) => {
      if (live && board) setChallengeTargetNow(challengeTarget(board));
    });
    return () => {
      live = false;
    };
  }, [targetShown, loadChallengeBoard, boardVersion, settings.profile.name]);
  /**
   * Out on track to the week's rules: its car, assists and realism, a dry track. `race`: against the AI in the car
   * and over the distance of the week's races (when its field is ready for this car; else practice).
   */
  const driveChallenge = useCallback(
    (race: boolean) => {
      const week = challengeAt(Date.now());
      applyWeekRules();
      startSession({ kind: "practice" });
      // After the session reset, so the swap finds no replay or AI field to carry over (as a multiplayer race's)
      const vehicle = race ? week.race.vehicle : week.vehicle;
      if (vehicleModelRef.current !== vehicle) changeCar(carForVehicle(vehicle).id);
      if (race && session) {
        // The field for the car now on track, over the week's race distance
        const field = session.takeAiField();
        session.setRace({ kind: "ai", field });
        // No damage, as in an open race with other drivers (their cars take none)
        startAiRace(field, { ...settingsRef.current.race, laps: week.race.laps, start: "standing", damage: "off" });
      } else {
        // polish:A — the time trial: its fixed tyre, fuel and road, from a flying start
        session?.setTimeTrial(timeTrialRules(week.vehicle));
        session?.restartFlyingLap();
        return;
      }
      setLaunchHint(true);
    },
    [session, startSession, changeCar, applyWeekRules]
  );
  /**
   * The week's challenge (`race`: its race) from any circuit: on another one the scene loads the right one first,
   * then goes out
   */
  const goChallenge = useCallback(
    (race: boolean) => {
      const week = challengeAt(Date.now());
      const circuit = race ? week.race.trackId : week.trackId;
      if (circuit !== trackId) {
        if (!onSelectTrack) return;
        pendingChallenge = { id: week.id, race };
        void onSelectTrack(circuit);
        return;
      }
      driveChallenge(race);
    },
    [trackId, onSelectTrack, driveChallenge]
  );
  const handleDriveChallenge = useCallback(() => goChallenge(false), [goChallenge]);
  /** The scheduled race nobody else entered, as a race against the AI */
  const soloRaceRef = useRef(() => {});
  soloRaceRef.current = () => goChallenge(true);
  const handleJoinRace = useCallback(() => {
    session?.unlockAudio();
    getMultiplayerManager().joinScheduledRace();
  }, [session]);
  const handleLeaveRace = useCallback(() => getMultiplayerManager().leaveScheduledRace(), []);
  // The challenge asked for from another circuit, now that this one has loaded
  useEffect(() => {
    if (!assetsReady || !pendingChallenge) return;
    const asked = pendingChallenge;
    pendingChallenge = null;
    const week = challengeAt(Date.now());
    if (week.id !== asked.id || (asked.race ? week.race.trackId : week.trackId) !== trackId) return;
    if (phaseRef.current === "loading") {
      session?.unlockAudio();
      setLoadingVisible(false);
    }
    driveChallenge(asked.race);
  }, [assetsReady, trackId, session, driveChallenge]);

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
    session?.lapRecorder.setContext({ driverName: settings.profile.name, driverCode: settings.profile.code });
  }, [session, settings.profile, vehicleModel, trackId]);

  // A car change brings back that car's personal-best ghost and leaderboard
  useEffect(() => {
    void loadPbGhost();
    void refreshLeaderboard();
    wheelFfb.resetMeter();
  }, [vehicleModel, loadPbGhost, refreshLeaderboard]);

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
      ["Restart lap (flying start)", keys(k.flyingLap)],
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
  });

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
    isMuted: muted,
    mouseSteerEnabled,
    gamepadAssist,
    autoGearbox,
    onSetAutoGearbox: setAutoGearbox,
    gamepadRumble,
    aiOpponents: raceKind === "ai",
    onToggleAiOpponents: handleToggleAiOpponents,
    aiSkill: settings.aiSkill,
    onChangeAiSkill: handleChangeAiSkill,
    raceSetup: settings.race,
    onChangeRaceSetup: handleChangeRaceSetup,
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
    challengeTarget: targetShown ? challengeTargetNow : null,
    onSelectTurn: handleSelectTurn,
    onHostP2PRoom: handleHostP2PRoom,
    onJoinP2PRoom: handleJoinP2PRoom,
    onCreateManualOffer: handleCreateManualOffer,
    onAcceptManualOffer: handleAcceptManualOffer,
    onAcceptManualAnswer: handleAcceptManualAnswer,
    onTogglePause: togglePause,
    keyNames,
    lobby: roomLobby,
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
      onEnterVr: () => session?.enterVr(),
    },
    library,
    leaderboardPanel: {
      trackName: getTrackInfo(trackId).name,
      trackId,
      trackNameOf,
      loadAllLocal: loadAllLocalLaps,
      vehicleLabel,
      local: localLaps,
      remoteEnabled: boardOn,
      loadRemote: loadRemoteBoard,
      boardVersion,
      vehicle: vehicleModel,
      driverName: settings.profile.name,
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
        if (phaseRef.current !== "loading") session?.unlockAudio();
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
                    boardOn && lapSummary.summary.valid && !lapSummary.summary.autopilot
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
          backToLobbyLabel={inScheduledRace ? "Back to the races" : undefined}
          replay={
            replayUi.active
              ? {
                  timeS: replayUi.timeS,
                  startS: replayUi.startS,
                  endS: replayUi.endS,
                  playing: replayUi.playing,
                  speed: replayUi.speed,
                  cameraLabel: CAMERA_MODES[cameraMode].label,
                  onTogglePlay: () => session?.replayTogglePlay(),
                  onSeek: (timeS: number) => session?.replaySeek(timeS),
                  onSpeed: (speed: number) => session?.replaySpeed(speed),
                  onCycleCamera: cycleCamera,
                  onExit: () => session?.exitReplay(),
                  onFlashback: () => session?.flashbackReplay(),
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
          // Back where the player was when a race entry or a room moved the game to another circuit (the scene reloads)
          initialPanel={titleInitialPanel ?? (inScheduledRace || inviteRoom || (roomLobby && !isMpHost) ? "multiplayer" : null)}
          firstRun={!onboarded}
          onDrive={() => handleTitleStart(false)}
          onRaceAi={() => handleTitleStart(true)}
          onControls={() => openControls("title")}
          trackId={trackId}
          onSelectTrack={onSelectTrack}
          challengePanel={
            boardOn
              ? {
                  challenge,
                  trackName: challengeTrackName(challenge.trackId),
                  carTitle: carForVehicle(challenge.vehicle).title,
                  available: challengeAvailable,
                  loadBoard: loadChallengeBoard,
                  boardVersion,
                  driverName: settings.profile.name,
                  onDrive: handleDriveChallenge,
                  hasRaces: races.on && racesAvailable,
                }
              : undefined
          }
          races={
            races.on && racesAvailable
              ? {
                  trackName: challengeTrackName(challenge.race.trackId),
                  carTitle: carForVehicle(challenge.race.vehicle).title,
                  slotS: races.slotS,
                  laps: challenge.race.laps,
                  entry: raceEntry,
                  entrants: inScheduledRace ? (lobby?.players ?? []).map((p) => ({ id: p.peerId, name: p.name, code: p.code, me: p.peerId === localPeerId })) : [],
                  onJoin: handleJoinRace,
                  onLeave: handleLeaveRace,
                }
              : undefined
          }
          conditionsPanel={{
            conditions: settings.conditions,
            realism: settings.realism,
            onChangeConditions: handleChangeConditions,
            onChangeRealism: handleChangeRealism,
            hostControlled: roomLobby !== null && !isMpHost,
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
