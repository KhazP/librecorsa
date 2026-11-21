"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type {
  AeroSetupPreset,
  CameraMode,
  CarTelemetry,
  DriverAssistPreset,
  LiveTunerPatch,
  LiveryConfig,
  TireCompound,
  TyreSetup,
  VehicleModelId,
} from "@/types/f1";
import { ACTIVE_TRACK_ID, TURN_METADATA, activeLapWord, getActiveTimedLengthM, getTrackData, inDeadZone } from "@/lib/track-data";
import { getTrackInfo } from "@/lib/track-registry";
import type { ChassisSetup } from "@/lib/sim/car-setup";
import type { RaceSetup } from "@/lib/sim/race-setup";
import { EngineersGarage } from "@/components/menu/EngineersGarage";
import type { LibraryProps } from "@/components/menu/ContentBrowser";
import { ConditionsPanel, type ConditionsPanelProps } from "@/components/menu/ConditionsPanel";
import { RaceRules } from "@/components/menu/RaceRules";
import type { SettingsCategory } from "@/components/settings/SettingsScreen";
import { carById, type CarId } from "@/lib/cars/car-registry";
import type { PlayerSettings } from "@/lib/settings/player-settings";
import { useUnits } from "@/lib/settings/ui-prefs";
import { SPEED_LABEL, speedIn } from "@/lib/settings/units";
import { MultiplayerPanel, type MultiplayerPanelProps } from "./MultiplayerPanel";
import { PerfReportCard } from "./PerfReportCard";
import { LeaderboardPanel, type LeaderboardPanelProps } from "./LeaderboardPanel";
import { focusInZone, focusOnHover, focusZone, useFocusNav } from "@/components/menu/useFocusNav";
import { useInputMode } from "@/components/menu/input-mode";
import { TrackQualityBadge } from "@/components/menu/menu-content-ui";
import { HeroAction, RailRow, RESET_ROW_PROMPT, ShellPrompts, usePanelReadingOrder, useRowResettable } from "@/components/menu/menu-shell";
import { Button, Card, Select, SettingRow, Tabs, Toggle } from "@/components/ui";
import { CAMERA_MODES, DRIVING_CAMERA_MODES } from "@/lib/render/camera-modes";
import { HUD_TOUCH_NOTE, HudLayoutPicker } from "@/components/settings/HudLayoutPicker";
import { isTouchDevice } from "@/lib/input/touch-input";
import { usePhoneLayout } from "./styles/PhoneHud";
import { SessionBadge } from "@/components/ui/badges/SessionBadge";
import { Icon } from "@/components/ui/icons/Icon";
import type { NowPlaying } from "@/lib/audio/bgm-controller";
import type { IconName } from "@/components/ui/icons/registry";
import { KeyCap } from "@/components/ui/prompts/KeyCap";
import { PadGlyph } from "@/components/ui/prompts/PadGlyph";
import type { Prompt } from "@/components/ui/prompts/PromptBar";
import { CURSOR_PILL, cx, HOVER_PILL, MOTION, PRESSED_PILL } from "@/components/ui/styles";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { UpdateReady } from "@/components/menu/UpdateReady";
import { feedbackContextOf, RequestPanel } from "@/components/menu/RequestPanel";
import type { ReportFacts } from "@/lib/diagnostics/report-details";
import { SourceChip } from "@/components/SourceChip";
import { carModelSource, trackModelSource } from "@/lib/model-source";

/**
 * What the HUD and the menus pass along as the player's settings (the old Display panel's props, whose rows now live
 * in the Settings screen): the title menu reads them for the profile button and the feedback form.
 */
export interface DisplayPanelProps {
  settings: PlayerSettings;
  onChangeSettings: (update: (prev: PlayerSettings) => PlayerSettings) => void;
  /** WebXR immersive-vr is available on this device */
  vrSupported: boolean;
  vrActive: boolean;
  onEnterVr: () => void;
  /** A new name, claimed on the online board: null once it has taken, else why not */
  onRenameDriver?: (name: string) => Promise<string | null>;
  /** Closes the menu onto the seat panel (only while driving) */
  onOpenSeatPanel?: () => void;
}

export interface PauseMenuProps extends MultiplayerPanelProps {
  telemetry: CarTelemetry;
  settings?: PlayerSettings;
  onChangeSettings?: (update: (prev: PlayerSettings) => PlayerSettings) => void;
  /** The current car's steering lock (road-wheel degrees), for the countersteer slider */
  steerLockDeg?: number;
  aeroPreset: AeroSetupPreset;
  assistPreset: DriverAssistPreset;
  cameraMode: CameraMode;
  /** Player's driver's-eye field of view (vertical °); null = the car's own */
  cockpitFovDeg?: number | null;
  /** The current car's own driver's-eye field of view */
  cockpitFovDefaultDeg?: number;
  /** null returns to the car's own field of view */
  onChangeCockpitFov?: (fovDeg: number | null) => void;
  tireCompound: TireCompound;
  tyreSetup: TyreSetup;
  defaultTyreSetup: TyreSetup;
  selectedLivery: LiveryConfig;
  showRacingLine: boolean;
  isMuted: boolean;
  mouseSteerEnabled: boolean;
  gamepadAssist: boolean;
  autoGearbox?: boolean;
  onSetAutoGearbox?: (enabled: boolean) => void;
  gamepadRumble: boolean;
  aiOpponents: boolean;
  /** AI opponents' skill (0 Rookie … 100 Alien) and its setter */
  aiSkill?: number;
  onChangeAiSkill?: (skill: number) => void;
  /** AI race setup (laps, field, grid, damage, start) and its setter; applies from the next start */
  raceSetup?: RaceSetup;
  onChangeRaceSetup?: (patch: Partial<RaceSetup>) => void;
  /** The chosen car, and the vehicle model it drives on (setups and records are per vehicle model) */
  carId: CarId;
  vehicleModel: VehicleModelId;
  onChangeCar: (car: CarId) => void;
  openMultiplayer?: boolean;
  /** Why the game paused itself (a wheel unplugged), shown under the heading */
  pauseNotice?: string | null;
  onToggleAiOpponents: () => void;
  onToggleGamepadAssist?: () => void;
  onToggleGamepadRumble: () => void;
  onChangeAeroPreset: (preset: AeroSetupPreset) => void;
  onChangeAssistPreset: (preset: DriverAssistPreset) => void;
  onCycleCamera: () => void;
  onSelectCamera?: (mode: CameraMode) => void;
  onToggleFreeCamera?: () => void;
  onChangeTireCompound: (compound: TireCompound) => void;
  onChangeTyreSetup: (setup: TyreSetup) => void;
  /** Engineer's garage: chassis offsets from the car's baseline, and the electronics' dials */
  chassisSetup?: ChassisSetup;
  onChangeChassisSetup?: (setup: ChassisSetup) => void;
  onChangeLiveTuner?: (patch: LiveTunerPatch) => void;
  onChangeLivery: (livery: LiveryConfig) => void;
  onToggleRacingLine: () => void;
  onToggleMute: () => void;
  onToggleAiAutopilot: () => void;
  onToggleMouseSteer?: () => void;
  onResetCar: (flyingStart: boolean) => void;
  onSelectTurn: (turnNumber: number) => void;
  onTogglePause: () => void;
  /** Opens the controls setup (keyboard / controller / wheel) */
  onOpenControls?: () => void;
  /** Opens the Settings screen over this menu, on a category and a tab in it (the links from Conditions, the Garage and the HUD tab) */
  onOpenSettings?: (category?: SettingsCategory, tab?: string) => void;
  /** Weather, time of day and the track's grip: applies live, so pause offers it too */
  conditionsPanel?: ConditionsPanelProps;
  /** Leaves the session for the title menu */
  onExitToTitle?: () => void;
  /** The music playing (none while it is held, before the lights) and the skip to the next track */
  nowPlaying?: NowPlaying | null;
  onSkipTrack?: () => void;
  /** The music alone switched off (the title screen's music button), and its switch */
  musicMuted?: boolean;
  onToggleMusicMute?: () => void;
  /** Key names for the hints on the toggles (defaults: the original layout) */
  keyNames?: Partial<Record<"camera" | "freeCamera" | "racingLine" | "mute" | "mouseSteer" | "autopilot" | "restart" | "shiftUp" | "shiftDown", string>>;
  /** HUD layout, graphics, touch controls and VR */
  displayPanel?: DisplayPanelProps;
  /** Lap times, ghosts and the online board */
  leaderboardPanel?: LeaderboardPanelProps;
  /** Favourite and recent cars / circuits for the content browsers */
  library?: LibraryProps;
  /**
   * Settings is open over the menu. On iOS the menu is then not drawn (.lc-menu-covered in globals.css), as its layers
   * under Settings cost about 70 MB in the iOS simulator (#110); it keeps its tab, scroll and the row Settings hands
   * the focus back to.
   */
  covered?: boolean;
  /** `?perf=1`: the session's performance report as text, which the Session tab copies or saves */
  perfReport?: (() => string) | null;
  /** The bug report's facts, read when it opens (`fromDrive`: from the pause menu, with where the car is) */
  reportFacts?: (fromDrive: boolean) => ReportFacts;
  /** The scene's next frame as a picture for a bug report */
  captureScreen?: (maxWidth?: number) => Promise<Blob | null>;
}

type Panel = "settings" | "hud" | "conditions" | "setup" | "corners" | "multiplayer" | "leaderboard" | "report";

/** "Circuit by Mitja Bonca [Source]  Model by gregsediting [Source]", at the pause menu's bottom right */
const MadeBy: React.FC<{ trackSource: ReturnType<typeof trackModelSource>; carId: CarId }> = ({ trackSource, carId }) => {
  const car = carById(carId);
  const carSource = carModelSource(car);
  const items = [
    trackSource ? { key: "circuit", lead: "Circuit by", source: trackSource } : null,
    { key: "car", lead: `${(car.credit.label ?? "Model by").replace(/ by$/, "")} by`, source: carSource },
  ].filter((i): i is NonNullable<typeof i> => i !== null);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-end gap-x-6 gap-y-2 short:mt-2">
      {items.map((i) => (
        <span key={i.key} className="inline-flex min-w-0 items-center gap-2 text-[13px] text-lc-slate">
          <span className="truncate" title={`${i.lead} ${i.source.author}`}>
            {i.lead} <span className="font-semibold text-lc-fog">{i.source.author}</span>
          </span>
          <SourceChip source={i.source} />
        </span>
      ))}
    </div>
  );
};

/**
 * Esc / Menu: race actions in a rail on the left, the session's panels as tabs on the right.
 * A controller reaches every control; LB / RB switch tabs, B steps back (panel, tabs, rail, resume) and Menu resumes
 * from anywhere.
 */
export const PauseMenu: React.FC<PauseMenuProps> = (props) => {
  const { telemetry, onTogglePause, onResetCar, aiOpponents, onOpenControls, onExitToTitle, leaderboardPanel, conditionsPanel, displayPanel } = props;
  const { nowPlaying, onSkipTrack } = props;
  const phoneScreen = usePhoneLayout();
  // Online: the host restarts the race for everyone and nobody has a flying lap; a guest in a lobby restarts nothing
  // (racing or not). The shell guards the same handlers.
  const mpRace = telemetry.race?.multiplayer === true || props.raceRunning === true;
  const guest = (mpRace || Boolean(props.lobby)) && props.isHost !== true;
  const canRestart = !guest;
  const canFly = !mpRace && !guest;
  const [chosenPanel, setPanel] = useState<Panel>(props.openMultiplayer ? "multiplayer" : "settings");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { mode, family } = useInputMode();
  // Restart, then close the menu, unless the restart already did: an online host's restart resumes everyone itself,
  // and toggling after it would pause again. By the next frame React has rendered the reset, so a menu still mounted
  // means the game is still paused.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const restartAndResume = useCallback(
    (flyingStart: boolean) => {
      onResetCar(flyingStart);
      requestAnimationFrame(() => {
        if (mounted.current) onTogglePause();
      });
    },
    [onResetCar, onTogglePause]
  );
  const panelRef = useRef<HTMLElement | null>(null);
  const panelId = useId();
  const trackInfo = getTrackInfo(ACTIVE_TRACK_ID);

  const tabs = useMemo(
    () =>
      [
        { id: "settings" as const, label: "Session", icon: "options" as const },
        // The HUD layout, one press from the session tab: it changes the moment the race resumes (not on a phone, which
        // always drives with the Phone HUD)
        ...(displayPanel && !phoneScreen ? [{ id: "hud" as const, label: "HUD", icon: "hud" as const }] : []),
        ...(conditionsPanel ? [{ id: "conditions" as const, label: "Conditions", icon: "conditions" as const }] : []),
        { id: "setup" as const, label: "Garage", icon: "garage" as const },
        // No jumping round the circuit in an online race
        ...(mpRace ? [] : [{ id: "corners" as const, label: "Corners", icon: "corners" as const }]),
        { id: "multiplayer" as const, label: "Multiplayer", icon: "multiplayer" as const },
        ...(leaderboardPanel ? [{ id: "leaderboard" as const, label: "Lap times", icon: "lapTimes" as const }] : []),
        // A bug report from where it happened: the car's place on the circuit and a picture of the scene go with it
        ...(props.reportFacts ? [{ id: "report" as const, label: "Report a bug", icon: "feedback" as const }] : []),
      ] satisfies { id: Panel; label: string; icon: IconName }[],
    [leaderboardPanel, mpRace, conditionsPanel, displayPanel, phoneScreen, props.reportFacts]
  );

  const actions: { id: string; label: string; detail?: string; icon: IconName; run: () => void }[] = useMemo(
    () => [
      ...(canRestart
        ? [
            {
              id: "grid",
              label: aiOpponents || mpRace ? "Restart race" : "Grid start",
              icon: "restart" as const,
              run: () => restartAndResume(false),
            },
          ]
        : []),
      ...(canFly
        ? [
            {
              id: "flying",
              label: aiOpponents ? "Rolling start" : "Flying lap",
              icon: "flyingLap" as const,
              run: () => restartAndResume(true),
            },
          ]
        : []),
      ...(nowPlaying && onSkipTrack
        ? [{ id: "music", label: "Skip track", detail: `${nowPlaying.title}, ${nowPlaying.composer}`, icon: "skip" as const, run: onSkipTrack }]
        : []),
      ...(onOpenControls
        ? [{ id: "settings", label: "Settings", icon: "settings" as const, run: onOpenControls }]
        : []),
      ...(onExitToTitle ? [{ id: "title", label: "Main menu", icon: "leave" as const, run: onExitToTitle }] : []),
    ],
    [aiOpponents, mpRace, canRestart, canFly, restartAndResume, nowPlaying, onSkipTrack, onOpenControls, onExitToTitle]
  );

  // A tab that went away while open (Corners when an online race starts) shows the session tab instead
  const panel: Panel = tabs.some((t) => t.id === chosenPanel) ? chosenPanel : "settings";

  // Scrolled down a long panel, LB / RB or B still lands on a tab the player can see
  const focusActiveTab = () => {
    const tab = rootRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    tab?.focus({ preventScroll: true });
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
    // Then the strip, whose scroll margin keeps the tab's ring clear of the top edge (the tab's own margin is lost to
    // the tab list it scrolls in)
    tab?.closest('[data-nav-zone="tabs"]')?.scrollIntoView({ block: "nearest" });
  };

  const selectTab = useCallback((next: Panel) => {
    setPanel(next);
    // Below lg the panel sits under the rail: bring the tabs to the top with the panel under them (the panel itself
    // at the top would push the focused tab off the screen)
    if (!window.matchMedia("(min-width: 64rem)").matches) {
      requestAnimationFrame(() => rootRef.current?.querySelector('[data-nav-zone="tabs"]')?.scrollIntoView({ block: "start" }));
    }
  }, []);

  const cycle = (step: number) => {
    const i = tabs.findIndex((t) => t.id === panel);
    const next = tabs[(i + step + tabs.length) % tabs.length];
    flushSync(() => setPanel(next.id));
    focusActiveTab();
  };

  const back = () => {
    const root = rootRef.current;
    if (focusInZone(root, "panel")) return void focusActiveTab();
    if (focusInZone(root, "tabs")) return void focusZone(root, "rail");
    onTogglePause();
  };
  // Esc is the simulator's pause toggle; B steps back, Menu resumes
  useFocusNav(rootRef, {
    onBack: back,
    onStart: onTogglePause,
    onPrevTab: () => cycle(-1),
    onNextTab: () => cycle(1),
    keyboardBack: false,
    // The Garage's rows have a reset each: Delete / X puts the row under the cursor back, and the prompt bar says so
    rowReset: panel === "setup",
  });
  const rowResettable = useRowResettable(panel === "setup");
  // Up / down inside a panel follow reading order and never fall out to the rail
  usePanelReadingOrder(rootRef);

  const race = telemetry.race;
  const place = trackInfo.city && trackInfo.city !== trackInfo.country ? `${trackInfo.city}, ${trackInfo.country}` : trackInfo.country;
  // The shoulder prompts show from `sm` up, as before
  const shoulder = (button: "lb" | "rb", key: string) => (
    <span className="hidden sm:inline-flex">{mode === "pad" ? <PadGlyph button={button} family={family} /> : <KeyCap>{key}</KeyCap>}</span>
  );

  const prompts: Prompt[] = [
    { action: "move", label: "Move" },
    { action: "select", label: panel === "corners" ? "Jump there" : "Select" },
    ...(rowResettable ? [RESET_ROW_PROMPT] : []),
    { action: "tabs", label: "Tabs" },
    ...(panel === "leaderboard" && leaderboardPanel?.remoteEnabled ? [{ action: "pages" as const, label: "Page" }] : []),
    { action: "back", label: "Back", key: "Bksp" },
    { action: "start", label: "Resume", key: "Esc" },
  ];
  const phonePrompts = prompts.filter((p) => p.action !== "move" && p.action !== "tabs");

  return (
    <div
      ref={rootRef}
      className={cx(
        "lc-menu-screen lc-ui-zoom pointer-events-auto fixed inset-0 z-40 flex flex-col overflow-y-auto [scrollbar-gutter:stable_both-edges] bg-lc-void/84 pt-[max(1.5rem,env(safe-area-inset-top))] pr-[max(1.25rem,env(safe-area-inset-right))] pb-[max(1.125rem,env(safe-area-inset-bottom))] pl-[max(1.25rem,env(safe-area-inset-left))] backdrop-blur-md sm:pr-[max(2.5rem,env(safe-area-inset-right))] sm:pl-[max(2.5rem,env(safe-area-inset-left))] short:pt-[max(0.75rem,env(safe-area-inset-top))]",
        props.covered && "lc-menu-covered",
      )}
    >
      <div className="mx-auto flex w-full max-w-[1320px] flex-1 flex-col">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-lc-line pb-4 short:pb-3">
          <div className="flex min-w-0 flex-col gap-2.5 short:gap-1.5">
            <h2 className="lc-h1 text-lc-chalk">{trackInfo.name}</h2>
            {props.pauseNotice ? (
              <p role="alert" className="m-0 flex items-center gap-2 text-[14px] font-semibold text-lc-caution">
                <Icon name="warning" />
                {props.pauseNotice}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <TrackQualityBadge track={trackInfo} size="sm" />
              <span className="lc-mono text-[12px] font-semibold tracking-[0.04em] text-lc-fog">
                {place}
                <span aria-hidden className="mx-2 text-lc-dim">·</span>
                {race ? "Lap" : activeLapWord()} {Math.max(1, race?.lap ?? telemetry.lapCount)}
                {race?.totalLaps ? `/${race.totalLaps}` : ""}
                {race ? (
                  <>
                    <span aria-hidden className="mx-2 text-lc-dim">·</span>
                    <span className="text-lc-chalk">P{race.position}/{race.fieldSize}</span>
                  </>
                ) : null}
              </span>
              {mpRace ? <SessionBadge session="online" size="sm">Online</SessionBadge> : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-x-5 gap-y-3">
            {/* A newer build is out: reloading from here ends what is under way, so it asks first */}
            <UpdateReady
              endsSession={
                mpRace
                  ? "Leaves the current race."
                  : props.lobby
                    ? "Leaves the current room."
                    : "Ends the current session."
              }
            />
            <LibreCorsaLogo variant="compact" size="sm" />
          </div>
        </header>

        <div className="mt-5 grid flex-1 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(240px,270px)_minmax(0,1fr)] short:mt-3 short:gap-4">
          <nav className="flex flex-col gap-0.5" data-nav-zone="rail" aria-label="Pause menu">
            <HeroAction id="resume" label="Resume" onClick={() => onTogglePause()} size="rail" />
            {actions.map((a) => (
              <RailRow key={a.id} id={a.id} label={a.label} detail={a.detail} icon={a.icon} onClick={a.run} />
            ))}
          </nav>

          <div className="flex min-h-0 min-w-0 flex-col gap-3.5">
            <Tabs
              aria-label="Sections"
              tabs={tabs.map((t) => ({ id: t.id, label: t.label, icon: <Icon name={t.icon} /> }))}
              value={panel}
              onChange={selectTab}
              prevPrompt={shoulder("lb", "Q")}
              nextPrompt={shoulder("rb", "E")}
              reselect
              panelId={panelId}
              className="scroll-mt-4 [&>[role=tablist]]:flex-1"
            />
            <section
              ref={panelRef}
              id={panelId}
              role="tabpanel"
              className="min-h-0 scroll-mt-4"
              data-nav-zone="panel"
              aria-label={tabs.find((t) => t.id === panel)?.label}
            >
              <div key={panel}>
                {panel === "settings" ? <SessionPanel {...props} /> : null}
                {panel === "hud" && displayPanel ? <HudPanel display={displayPanel} onOpenSettings={props.onOpenSettings} /> : null}
                {panel === "conditions" && conditionsPanel ? (
                  <ConditionsPanel {...conditionsPanel} onOpenSettings={props.onOpenSettings} session />
                ) : null}
                {panel === "setup" ? <EngineersGarage {...props} onOpenSettings={props.onOpenSettings} /> : null}
                {panel === "corners" ? (
                  <CornersPanel
                    onSelect={(n) => {
                      props.onSelectTurn(n);
                      onTogglePause();
                    }}
                  />
                ) : null}
                {panel === "multiplayer" ? <MultiplayerPanel {...props} /> : null}
                {panel === "leaderboard" && leaderboardPanel ? <LeaderboardPanel {...leaderboardPanel} /> : null}
                {panel === "report" && props.reportFacts ? (
                  <RequestPanel
                    context={feedbackContextOf(trackInfo, carById(props.carId).title, props.settings)}
                    facts={() => props.reportFacts!(true)}
                    screenshot={props.captureScreen ? () => props.captureScreen!() : undefined}
                  />
                ) : null}
              </div>
            </section>
          </div>
        </div>

        {/* Who made this circuit and this car, each with its Source button (the modder's donate link first): on
            touch screens too, where the key prompts below are hidden */}
        <MadeBy trackSource={trackModelSource(trackInfo)} carId={props.carId} />

        {/* Touch screens have no keys to show: the footer comes back with a pad */}
        <footer className={`mt-5 flex items-center gap-3 border-t border-lc-line pt-3 short:mt-3 ${mode === "pad" ? "" : "pointer-coarse:hidden"}`}>
          <ShellPrompts prompts={prompts} phonePrompts={phonePrompts} />
        </footer>
      </div>
    </div>
  );
};

/**
 * The session tab: the race's rules (the same rows as the title's Race panel), with Autopilot in the field card. Rows
 * that restart the race say so; the rest apply from the next start.
 */
export const SessionPanel: React.FC<PauseMenuProps> = (p) => {
  const mpRace = p.telemetry.race?.multiplayer === true || p.raceRunning === true;
  const cameraOptions = useMemo(
    () => DRIVING_CAMERA_MODES.map((id) => ({ id, label: CAMERA_MODES[id].label, detail: CAMERA_MODES[id].blurb })),
    []
  );
  const savedCamera: CameraMode = p.cameraMode === "free" ? (p.settings?.camera ?? "chase") : p.cameraMode;
  const autopilot = (
    <SettingRow label="Autopilot" hint={`Key ${p.keyNames?.autopilot ?? "P"}`}>
      <Toggle checked={p.telemetry.aiAutopilot} onChange={() => p.onToggleAiAutopilot()} />
    </SettingRow>
  );
  const cameraCard =
    p.onSelectCamera || p.onToggleFreeCamera ? (
      <Card title="Camera">
        {p.onSelectCamera ? (
          <SettingRow label="Camera view" hint={`Cycle: ${p.keyNames?.camera ?? "C"}`}>
            <Select
              aria-label="Camera view"
              options={cameraOptions}
              value={savedCamera}
              onChange={(mode) => p.onSelectCamera?.(mode)}
            />
          </SettingRow>
        ) : null}
        {p.onToggleFreeCamera ? (
          <SettingRow
            label="Free camera"
            hint={`Key ${p.keyNames?.freeCamera ?? "F7"} · Drag look, WASD fly, Q/E height`}
          >
            <Button
              size="sm"
              variant={p.cameraMode === "free" ? "primary" : "secondary"}
              icon={<Icon name="camera" size="sm" />}
              onClick={() => {
                p.onToggleFreeCamera?.();
                p.onTogglePause();
              }}
            >
              {p.cameraMode === "free" ? "Exit free cam" : "Free camera"}
            </Button>
          </SettingRow>
        ) : null}
      </Card>
    ) : null;
  const rules = !p.onChangeRaceSetup ? (
    <Card title="Session">{autopilot}</Card>
  ) : (
    <RaceRules
      context="pause"
      setup={p.raceSetup}
      onChange={p.onChangeRaceSetup}
      aiSkill={p.aiSkill}
      onChangeAiSkill={p.onChangeAiSkill}
      aiOpponents={p.aiOpponents}
      // An online race has no AI cars to add
      onToggleAiOpponents={mpRace ? undefined : p.onToggleAiOpponents}
      trackLengthM={getActiveTimedLengthM()}
      extraFieldRows={autopilot}
    />
  );
  return (
    <div className="flex flex-col gap-3">
      {p.perfReport ? <PerfReportCard report={p.perfReport} /> : null}
      {cameraCard}
      {rules}
    </div>
  );
};

/**
 * The HUD tab: the layout picker (the same one as Settings > Display > HUD). The HUD is hidden under the menu, so the
 * new layout shows as soon as the race resumes; size, delta bar and the rest stay in Settings, one press away.
 */
const HudPanel: React.FC<{ display: DisplayPanelProps; onOpenSettings?: (category?: SettingsCategory, tab?: string) => void }> = ({
  display,
  onOpenSettings,
}) => (
  <Card
    title="HUD layout"
    description={isTouchDevice() ? HUD_TOUCH_NOTE : undefined}
    action={
      onOpenSettings ? (
        <Button variant="ghost" size="sm" icon={<Icon name="settings" />} onClick={() => onOpenSettings("display", "hud")}>
          HUD settings
        </Button>
      ) : undefined
    }
  >
    <HudLayoutPicker
      value={display.settings.hud.preset}
      onChange={(id) => display.onChangeSettings((s) => ({ ...s, hud: { ...s.hud, preset: id } }))}
      navDefault
    />
  </Card>
);

const cornerName = (name: string) => name.replace(/^Turn \d+\s*[—-]\s*/, "");

/** The active circuit's outline, start line and corner positions, fitted to an SVG viewBox */
function buildCornerMap() {
  const track = getTrackData();
  // A hill climb's road is open: no closing stretch (its dead zone has no road), as the minimap draws it
  const p2p = track.pointToPoint;
  const samples = p2p ? track.samples.filter((s) => !inDeadZone(p2p, s.s)) : track.samples;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const s of samples) {
    if (s.position.x < minX) minX = s.position.x;
    if (s.position.x > maxX) maxX = s.position.x;
    if (s.position.z < minZ) minZ = s.position.z;
    if (s.position.z > maxZ) maxZ = s.position.z;
  }
  const pad = 48;
  const scale = 704 / Math.max(maxX - minX, maxZ - minZ, 1);
  const width = (maxX - minX) * scale + pad * 2;
  const height = (maxZ - minZ) * scale + pad * 2;
  const pt = (x: number, z: number) => ({ x: (x - minX) * scale + pad, y: (z - minZ) * scale + pad });

  let d = "";
  for (let i = 0; i < samples.length; i += 2) {
    const p = pt(samples[i].position.x, samples[i].position.z);
    // A gap in the road (the dead zone's edges) starts a new stroke rather than a line across it
    const jump = i > 0 && !!p2p && Math.abs(samples[i].s - samples[i - 2].s) > 30;
    d += `${i === 0 || jump ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }
  if (!p2p) d += "Z";

  // Start / finish: a short bar across the track, perpendicular to the direction of travel
  const sf = track.getSampleAtDistance(0);
  const sfPt = pt(sf.position.x, sf.position.z);
  const tl = Math.hypot(sf.tangent.x, sf.tangent.z) || 1;
  const nx = -sf.tangent.z / tl;
  const ny = sf.tangent.x / tl;

  const turns = TURN_METADATA.map((t) => {
    const s = track.getSampleAtDistance(t.sApprox);
    return { number: t.number, ...pt(s.position.x, s.position.z) };
  });

  return {
    viewBox: `0 0 ${width.toFixed(0)} ${height.toFixed(0)}`,
    d,
    startLine: { x1: sfPt.x - nx * 28, y1: sfPt.y - ny * 28, x2: sfPt.x + nx * 28, y2: sfPt.y + ny * 28 },
    turns,
  };
}

const CornersPanel: React.FC<{ onSelect: (turn: number) => void }> = ({ onSelect }) => {
  const map = useMemo(buildCornerMap, []);
  const units = useUnits();
  const speedUnit = SPEED_LABEL[units.speed];
  // The corner under the pointer, else the focused one, lit on the map (kept apart, so leaving one row with the pointer
  // falls back to the focused row instead of clearing)
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const hot = hover ?? focused;
  const hotTurn = hot == null ? undefined : TURN_METADATA.find((t) => t.number === hot);
  const hotPoint = hot == null ? undefined : map.turns.find((t) => t.number === hot);

  return (
    <Card title="Corners">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-3.5">
        <div className="flex min-w-0 flex-col gap-2.5">
          <svg
            viewBox={map.viewBox}
            role="img"
            aria-label={`Circuit map with ${TURN_METADATA.length} numbered turns`}
            className="hidden h-auto max-h-[400px] w-full sm:block short:max-h-[200px]"
          >
            <path d={map.d} fill="none" stroke="var(--color-lc-carbon)" strokeWidth={46} strokeLinejoin="round" />
            <path d={map.d} fill="none" stroke="var(--color-lc-keyline)" strokeWidth={10} strokeLinejoin="round" />
            <line {...map.startLine} stroke="var(--color-lc-chalk)" strokeWidth={8} />
            <g className="lc-mono" fontSize={20} fontWeight={800} textAnchor="middle">
              {map.turns.map((t) =>
                t.number === hot ? null : (
                  <g key={t.number}>
                    <circle cx={t.x} cy={t.y} r={22} fill="var(--color-lc-carbon)" stroke="var(--color-lc-dim)" strokeWidth={3} />
                    <text x={t.x} y={t.y + 7} fill="var(--color-lc-chalk)">
                      {t.number}
                    </text>
                  </g>
                )
              )}
              {/* The corner under the cursor wears the cursor's volt */}
              {hotPoint ? (
                <g>
                  <circle cx={hotPoint.x} cy={hotPoint.y} r={40} fill="var(--color-lc-volt)" opacity={0.22} />
                  <circle cx={hotPoint.x} cy={hotPoint.y} r={26} fill="var(--color-lc-volt)" stroke="var(--color-lc-void)" strokeWidth={4} />
                  <text x={hotPoint.x} y={hotPoint.y + 7} fill="var(--color-lc-void)">
                    {hotPoint.number}
                  </text>
                </g>
              ) : null}
            </g>
          </svg>
          <div className="hidden min-h-11 items-center gap-3 sm:flex">
            {hotTurn ? (
              <>
                <span className="lc-disp shrink-0 text-[24px] text-lc-chalk">T{hotTurn.number}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="lc-row-label truncate">{cornerName(hotTurn.name)}</span>
                  <span className="lc-hint truncate">
                    {hotTurn.complexName} · Sector {hotTurn.sector}
                  </span>
                </span>
              </>
            ) : (
              <span className="lc-hint">Select a corner</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 content-start gap-1.5 min-[420px]:grid-cols-2">
          {TURN_METADATA.map((t) => {
            const apex = Math.round(speedIn(t.apexSpeedKmh, units.speed));
            return (
              <button
                key={t.number}
                type="button"
                onClick={() => onSelect(t.number)}
                onPointerEnter={(e) => {
                  setHover(t.number);
                  focusOnHover(e);
                }}
                onPointerLeave={() => setHover((h) => (h === t.number ? null : h))}
                onFocus={() => setFocused(t.number)}
                onBlur={() => setFocused((f) => (f === t.number ? null : f))}
                aria-label={`T${t.number}, turn ${t.number}: ${cornerName(t.name)}, ${t.complexName}. Apex ${apex} ${speedUnit}, gear ${t.gear}`}
                title={`${cornerName(t.name)} · ${t.complexName}`}
                className={cx(
                  "group grid min-h-11 cursor-pointer grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lc-row bg-lc-well px-3 py-1 text-left text-lc-chalk inset-ring inset-ring-lc-line",
                  MOTION,
                  HOVER_PILL,
                  PRESSED_PILL,
                  CURSOR_PILL,
                )}
              >
                <span className="lc-disp text-[20px]">T{t.number}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="lc-data text-[13px]">
                    {apex}
                    <span className="lc-hint font-normal text-lc-slate group-focus:text-lc-void/70"> {speedUnit}</span>
                  </span>
                  <span className="truncate text-[11px] text-lc-slate group-focus:text-lc-void/70 sm:hidden">{cornerName(t.name)}</span>
                </span>
                <span className="lc-hint text-lc-slate group-focus:text-lc-void/70">
                  Gear <span className="lc-data text-[13px] text-lc-chalk group-focus:text-lc-void">{t.gear}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </Card>
  );
};
