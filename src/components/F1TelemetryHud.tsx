"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { MultiplayerPanelProps } from "./hud/MultiplayerPanel";
import type { HudSettings } from "@/lib/settings/player-settings";
import type { DisplayPanelProps } from "./hud/PauseMenu";
import type { ConditionsPanelProps } from "./menu/ConditionsPanel";
import type { SettingsCategory } from "./settings/SettingsScreen";
import type { LeaderboardPanelProps } from "./hud/LeaderboardPanel";
import type { CarId } from "@/lib/cars/car-registry";
import { type BuiltTrackData } from "@/lib/track-data";
import { HUD_TOGGLE_EVENT } from "@/lib/input/bindings";
import { TrackMinimap } from "./TrackMinimap";
import { ChallengeTargetPanel, LapPanel, TimingTower } from "./hud/TimingPanels";
import { SpeedCluster } from "./hud/SpeedCluster";
import { TyrePanel } from "./hud/TyrePanel";
import { StartLights } from "./hud/StartLights";
import { PauseMenu } from "./hud/PauseMenu";
import { F12026ChannelsPanel } from "./hud/F12026ChannelsPanel";
import { MultiPageMfd } from "./hud/MultiPageMfd";
import { useLapDeltaTracker } from "./hud/useLapDelta";
import { HUD_GLASS, HUD_INFO, HUD_LBL, aidsActive, raceState } from "./hud/hud-format";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Icon } from "./ui/icons/Icon";
import { KeyCap, PadGlyph } from "./ui/prompts";
import { HudModeContext, type HudMode } from "./hud/hud-mode";
import { type AeroNotice, aeroNotice, aeroReadout, latestAeroEvent } from "./hud/aero-label";
import { LibreCorsaLogo } from "./ui/LibreCorsaLogo";
import { InputTrace } from "./hud/InputTrace";
import { PedalBars, pedalLayers } from "./hud/PedalBars";
import { ProximityRadar } from "./hud/ProximityRadar";
import { virtualMirrorRect } from "@/lib/render/virtual-mirror";
import { DeltaBar } from "./hud/DeltaBar";
import { SplitGaps } from "./hud/SplitGaps";
import { WeatherBadge, type WeatherHudState } from "./hud/WeatherBadge";
import { FfbMeter } from "./hud/FfbMeter";
import { LapSummary } from "./hud/LapSummary";
import { RaceResults } from "./hud/RaceResults";
import { RaceControlBanner } from "./hud/RaceControlBanner";
import { QualityNotice } from "./hud/QualityNotice";
import { RaceIncidentFeed } from "./hud/RaceIncidentFeed";
import { DamageWidget } from "./hud/DamageWidget";
import { ReplayBar } from "./hud/ReplayBar";
import { TouchControls, type TouchCarState, type TouchControlsProps } from "./hud/TouchControls";
import { getTrackInfo } from "@/lib/track-registry";
import { useInputMode } from "./menu/input-mode";
import { ACTIVE_TRACK_ID } from "@/lib/track-data";
import { BroadcastHud } from "./hud/styles/BroadcastHud";
import { WheelDashHud } from "./hud/styles/WheelDashHud";
import { TelemetryHud } from "./hud/styles/TelemetryHud";
import { PhoneHud, usePhoneLayout } from "./hud/styles/PhoneHud";
import { IrDashiesHud } from "./hud/styles/IrDashiesHud";
import { RaceVisionHud } from "./hud/styles/RaceVisionHud";
import { HeadToHeadHud } from "./hud/styles/HeadToHeadHud";
import { RetroHud } from "./hud/styles/RetroHud";
import { BlocksHud } from "./hud/styles/BlocksHud";
import { HudRunProvider } from "./hud/styles/third-party-parts";
import {
  HudSkinProvider,
  SkinBanner,
  SkinButton,
  SkinPanel,
  SkinTag,
  type SkinTone,
  skinCss,
  skinRootClass,
  thirdPartySkinOf,
} from "./hud/styles/third-party-skin";
import { useUiZoom } from "@/lib/ui-zoom";
import { buildHudMap, revRangeOf, useLapInvalid, type HudDesignProps } from "./hud/styles/hud-style-parts";
import type { BoardWidgetMode, HudPreset } from "@/lib/settings/player-settings";
import { showsPhoneHud } from "@/lib/settings/hud-layouts";
import { BoardWidget, useLargeScreen } from "./hud/BoardWidget";
import { PodiumOverlay } from "./hud/PodiumOverlay";
import type { NextRaceProps } from "./hud/RaceResults";
import type { PodiumUi } from "@/lib/render/podium-shot";
import type { RaceRecord } from "@/lib/sim/race-history";

/** A full-screen HUD style and what the shared layer around it does for it */
interface HudStyleDef {
  component: React.FC<HudDesignProps>;
  /** Height kept clear at the bottom centre (px at 100 %): the optional input trace sits above it */
  bottomClearance: number;
  /** The style draws its own input trace: the optional one stays off */
  ownTrace?: boolean;
  /** The style fills the bottom-left corner: the key hints stay off */
  ownsBottomLeft?: boolean;
  /** The MFD starts folded to its status pill */
  mfdFolded?: boolean;
  /** Height the style takes at the top centre (px at 100 %): start lights, notices and the delta bar start below it */
  topClearance?: number;
  /** The style shows the live delta at the top centre itself: the shared delta bar stays off */
  ownDeltaBar?: boolean;
  /** The style draws its own proximity radar or spotter: the shared radar stays off */
  ownRadar?: boolean;
  /** The style draws car damage inside its own condition panel: the shared DamageWidget stays off */
  ownDamage?: boolean;
}

/** The full-screen HUD styles; Classic and Minimal use the corner panels below */
const HUD_STYLES: Partial<Record<HudPreset, HudStyleDef>> = {
  broadcast: { component: BroadcastHud, bottomClearance: 128 },
  dash: { component: WheelDashHud, bottomClearance: 252 },
  telemetry: { component: TelemetryHud, bottomClearance: 252, ownTrace: true, ownsBottomLeft: true, mfdFolded: true },
  // Third-party layouts (hud-layouts.ts), recreated from other open-source HUD projects
  irdashies: { component: IrDashiesHud, bottomClearance: 200, ownTrace: true, ownsBottomLeft: true, mfdFolded: true, ownDeltaBar: true, ownRadar: true },
  racevision: { component: RaceVisionHud, bottomClearance: 200, ownTrace: true, ownsBottomLeft: true, mfdFolded: true, topClearance: 80, ownDeltaBar: true, ownRadar: true },
  h2h: { component: HeadToHeadHud, bottomClearance: 200, ownsBottomLeft: true, mfdFolded: true, ownDeltaBar: true, ownRadar: true },
  retro: { component: RetroHud, bottomClearance: 292, ownsBottomLeft: true, mfdFolded: true, topClearance: 120, ownDeltaBar: true, ownRadar: true, ownDamage: true },
  blocks: { component: BlocksHud, bottomClearance: 200, ownsBottomLeft: true, mfdFolded: true, topClearance: 124, ownDeltaBar: true, ownRadar: true },
};
/** Every preset gives way to the Phone HUD on a phone-sized screen, and the game's own wherever the touch controls are up (`showsPhoneHud`) */
const PHONE_STYLE: HudStyleDef = { component: PhoneHud, bottomClearance: 16 };

interface F1TelemetryHudProps extends MultiplayerPanelProps {
  track: BuiltTrackData;
  telemetry: CarTelemetry;
  aeroPreset: AeroSetupPreset;
  assistPreset: DriverAssistPreset;
  cameraMode: CameraMode;
  /** The seat panel is open: the HUD steps aside, as for the pause menu */
  seatPanel?: boolean;
  /** Player's driver's-eye field of view (vertical °); null = the car's own */
  cockpitFovDeg?: number | null;
  /** The current car's own driver's-eye field of view */
  cockpitFovDefaultDeg?: number;
  onChangeCockpitFov?: (fovDeg: number | null) => void;
  /** Wheel driving without its pedals bound: shows a shortcut to the wheel setup */
  wheelUncalibrated?: boolean;
  tireCompound: TireCompound;
  tyreSetup: TyreSetup;
  defaultTyreSetup: TyreSetup;
  selectedLivery: LiveryConfig;
  showRacingLine: boolean;
  isMuted: boolean;
  boostLatch: boolean;
  showLaunchHint?: boolean;
  /** First-drive hint for the player's input device */
  launchHintText?: string;
  /** Controller button that shows / hides the HUD (RS by default), named in the "HUD hidden" note */
  hudToggleButton?: string;
  mouseSteerEnabled?: boolean;
  gamepadAssist?: boolean;
  /** Automatic gearbox (pause menu toggle) */
  autoGearbox?: boolean;
  onSetAutoGearbox?: (enabled: boolean) => void;
  gamepadRumble: boolean;
  aiOpponents: boolean;
  onToggleAiOpponents: () => void;
  /** AI opponents' skill 0..100 and its setter (pause menu) */
  aiSkill?: number;
  onChangeAiSkill?: (skill: number) => void;
  /** AI race setup and its setter (pause menu) */
  raceSetup?: import("@/lib/sim/race-setup").RaceSetup;
  onChangeRaceSetup?: (patch: Partial<import("@/lib/sim/race-setup").RaceSetup>) => void;
  carId: CarId;
  vehicleModel: VehicleModelId;
  onChangeCar: (car: CarId) => void;
  onToggleGamepadAssist?: () => void;
  onToggleGamepadRumble: () => void;
  onChangeAeroPreset: (preset: AeroSetupPreset) => void;
  onChangeAssistPreset: (preset: DriverAssistPreset) => void;
  /** The next view in the camera cycle */
  onCycleCamera: () => void;
  /** Off the track: the crimson edge glow that breathes behind the HUD, which the renderer draws into the frame */
  onOffTrackGlow?: (on: boolean) => void;
  onChangeTireCompound: (compound: TireCompound) => void;
  onChangeTyreSetup: (setup: TyreSetup) => void;
  onChangeLivery: (livery: LiveryConfig) => void;
  onToggleRacingLine: () => void;
  onToggleMute: () => void;
  onToggleAiAutopilot: () => void;
  onToggleXMode: () => void;
  onToggleBoostLatch: () => void;
  onChangeLiveTuner?: (patch: LiveTunerPatch) => void;
  onToggleMouseSteer?: () => void;
  onResetCar: (flyingStart: boolean) => void;
  onSelectTurn: (turnNumber: number) => void;
  onHostP2PRoom?: (customCode?: string) => string;
  onJoinP2PRoom?: (roomCode: string) => void;
  onCreateManualOffer?: () => Promise<string>;
  onAcceptManualOffer?: (offerToken: string) => Promise<string>;
  onAcceptManualAnswer?: (answerToken: string) => Promise<boolean>;
  paused: boolean;
  /** Settings is open over the pause menu: the menu keeps its state but is not drawn under it */
  pauseMenuCovered?: boolean;
  onTogglePause: () => void;
  onOpenControls?: () => void;
  /** Opens Settings over the pause menu on a category (the pause menu's links from Conditions and the Garage) */
  onOpenSettings?: (category?: SettingsCategory, tab?: string) => void;
  /** Weather, time of day and the track's grip, for the pause menu's Conditions tab */
  conditionsPanel?: ConditionsPanelProps;
  onExitToTitle?: () => void;
  keyNames?: Partial<Record<"camera" | "racingLine" | "mute" | "mouseSteer" | "autopilot" | "restart" | "shiftUp" | "shiftDown" | "board", string>>;
  /** The lap board's gear: when it opens (the HUD setting), changed from the board itself; without it, no lap board */
  onChangeBoardWidget?: (mode: BoardWidgetMode) => void;
  /** HUD layout preset, size and optional widgets */
  hud?: HudSettings;
  /** The sim draws the virtual rear-view mirror at the top centre: the notifications there move under it */
  virtualMirror?: boolean;
  /** Wheel force meter (wheel with force feedback only) */
  ffbMeter?: React.ComponentProps<typeof FfbMeter> | null;
  /** Card after a completed lap */
  lapSummary?: React.ComponentProps<typeof LapSummary> | null;
  /** The results card was closed for this race */
  resultsClosed?: boolean;
  onCloseResults?: () => void;
  onRestartRace?: () => void;
  onBackToLobby?: () => void;
  backToLobbyLabel?: string;
  /** polish:B after the flag: the podium shot (before the table), the player's last races, the next open race */
  raceEnd?: { podium: PodiumUi; onSkipPodium: () => void; history: readonly RaceRecord[]; nextRace?: NextRaceProps };
  /** Instant replay in progress: only the transport bar shows */
  replay?: React.ComponentProps<typeof ReplayBar> | null;
  /** On-screen pedals and steering (touch screens) */
  touchControls?: TouchControlsProps | null;
  displayPanel?: DisplayPanelProps;
  leaderboardPanel?: LeaderboardPanelProps;
  /** Air / track temperature and the track's wetness (weather.ts) */
  weather?: WeatherHudState | null;
  /** The room in the page's invite link: the pause menu opens on it until a peer is connected */
  inviteRoom?: string | null;
  /** polish:A — the time trial's target while the weekly challenge is driven (best, fastest, place) */
  challengeTarget?: import("@/lib/net/challenge-target").ChallengeTarget | null;
  /** The automatic quality's quiet note (drive-session.ts), a new id each time */
  qualityNotice?: { id: number; kind: "lowered" | "floor" } | null;
  /** `?perf=1`: the session's performance report, for the pause menu to copy or save */
  perfReport?: (() => string) | null;
  /** The bug report's facts, read when it opens (`fromDrive`: from the pause menu, with where the car is) */
  reportFacts?: (fromDrive: boolean) => import("@/lib/diagnostics/report-details").ReportFacts;
  /** The scene's next frame as a picture for a bug report */
  captureScreen?: (maxWidth?: number) => Promise<Blob | null>;
}

/**
 * The HUD's buttons sit over the driving view, where the mouse may be steering: hovering one must not give it the
 * focus (the kit's buttons take it on hover, for menus), or Space, a driving key, would press it
 */
const keepFocusOffHover = (e: React.PointerEvent<HTMLElement>) => {
  if (document.activeElement === e.currentTarget) e.currentTarget.blur();
};

/**
 * The flaps' notice in the car's era's words (f12026-car): the last DRS detection crossed, or for a 2026 car the last
 * straight coming up or Overtake verdict, each shown for 2.5 s after it happens; and while a press of the flap button
 * waits for the zone, that it will open there
 */
function useAeroNotice(t: CarTelemetry): AeroNotice | null {
  const event = latestAeroEvent(t);
  const key = event ? `${event.kind}@${event.atMs}` : "";
  const [shownKey, setShownKey] = useState("");
  useEffect(() => {
    if (!key) return;
    setShownKey(key);
    const id = window.setTimeout(() => setShownKey(""), 2500);
    return () => window.clearTimeout(id);
  }, [key]);
  if (t.f12026?.drsQueued && t.activeAeroMode !== "X_MODE") return aeroNotice(t.overtakingRules, { kind: "queued" });
  return event && key === shownKey ? aeroNotice(t.overtakingRules, event) : null;
}

/** Which touch driving buttons the car uses and how lit they are, read the way the speed cluster reads them */
function touchCarState(t: CarTelemetry, lights: boolean): TouchCarState {
  const channels = t.f12026;
  const aero = aeroReadout(t);
  const overtakeLocked = t.overtakingRules === "straight-mode-2026" && t.overtakeAvailable === false;
  return {
    hasErs: channels?.hasErs ?? true,
    hasAero: (!channels || channels.hasDrs) && t.overtakingRules !== "none",
    aeroOpen: aero.open,
    // A car without the DRS channel cannot say where the flaps may open: its button never looks unusable
    aeroArmed: aero.armed || !channels,
    boostOn: !overtakeLocked && t.manualOverrideActive,
    boostLocked: overtakeLocked,
    gear: t.gear,
    speedKmh: t.speedKmh,
    runId: t.runId ?? 0,
    lights,
  };
}

/**
 * LibreCorsa In-Race Telemetry HUD: timing tower & lap delta top-left, start gantry and race control
 * alerts top-centre, GPS circuit map top-right, 4-corner tyre matrix bottom-left, MoTeC speed cluster bottom-right.
 */
export const F1TelemetryHud: React.FC<F1TelemetryHudProps> = (props) => {
  const {
    track,
    telemetry,
    tireCompound,
    cameraMode,
    boostLatch,
    showLaunchHint = false,
    launchHintText = "Hold W or the up arrow to launch · Esc for menu",
    mouseSteerEnabled = false,
    gamepadAssist = true,
    paused,
    onCycleCamera,
  } = props;

  const inviteRoom = props.inviteRoom ?? null;
  // An invite link opens the multiplayer panel on the first pause only
  const [inviteUsed, setInviteUsed] = useState(false);
  useEffect(() => {
    if (paused) setInviteUsed(true);
  }, [paused]);
  const { mode: inputMode, family: padFamily } = useInputMode();
  const { tracker: lapTracker, deltaS } = useLapDeltaTracker(telemetry, track.totalLengthM);
  const race = telemetry.race;
  const f12026 = telemetry.f12026;
  const aeroNoticeNow = useAeroNotice(telemetry);
  const hudMap = useMemo(() => buildHudMap(track), [track]);
  const hud = props.hud;
  const preset = hud?.preset ?? "broadcast";
  const touch = Boolean(props.touchControls);
  // The Phone HUD on a phone-sized screen, and for the game's own presets wherever the touch pads are up; a third-party
  // layout keeps its look on a tablet and steps out of the pads' way itself (`touch`)
  const phone = showsPhoneHud(preset, { phone: usePhoneLayout(), touchControls: touch });
  // The lap board is for large screens only: not mounted below 1280 × 720
  const largeScreen = useLargeScreen();
  const lapInvalid = useLapInvalid(telemetry);
  // Under the virtual mirror's strip (its rect is shared with the renderer), with a little air
  // The renderer draws the mirror into this rect; the HUD frames it and starts the top-centre column under it
  const mirrorRect = props.virtualMirror && !phone && typeof window !== "undefined" ? virtualMirrorRect(window.innerWidth, window.innerHeight) : null;
  const mirrorTop = mirrorRect ? mirrorRect.y + mirrorRect.h + 10 : null;
  const uiZoom = useUiZoom();
  // polish:B the podium shot comes first: the table waits for it, and the HUD gives it the screen
  const podiumStage = props.raceEnd?.podium.stage;
  const podiumUp = podiumStage === "playing";
  const showResults = raceState(race).classified && !props.resultsClosed && podiumStage !== "waiting" && !podiumUp;
  // Paused or in a replay, the HUD stays mounted (folds, lap history and timers carry on) but hides and takes no input;
  // the results card owns the D-pad and keys while it is up
  const hudMode: HudMode = paused || props.seatPanel || props.replay || podiumUp ? "hidden" : showResults ? "results" : "live";
  const hudModeRef = useRef(hudMode);
  hudModeRef.current = hudMode;
  // The HUD pad button (R3 by default) clears every panel off the screen; start lights and alerts stay
  const [hudHidden, setHudHidden] = useState(false);
  const [hiddenNote, setHiddenNote] = useState(false);
  useEffect(() => {
    const toggle = () => {
      if (hudModeRef.current !== "hidden") setHudHidden((h) => !h);
    };
    window.addEventListener(HUD_TOGGLE_EVENT.hud, toggle);
    return () => window.removeEventListener(HUD_TOGGLE_EVENT.hud, toggle);
  }, []);
  useEffect(() => {
    setHiddenNote(hudHidden);
    if (!hudHidden) return;
    const id = window.setTimeout(() => setHiddenNote(false), 2500);
    return () => window.clearTimeout(id);
  }, [hudHidden]);


  const lightsPhase = race?.phase === "lights";
  const style = phone ? PHONE_STYLE : HUD_STYLES[preset];
  const thirdPartySkin = thirdPartySkinOf(preset, phone);
  const isThirdParty = thirdPartySkin !== null;
  const showDelta = Boolean(hud?.deltaBar && !phone && !lightsPhase);
  const showRadar = hud?.radar !== false && !lightsPhase;
  const classic = !phone && preset === "classic";
  const minimal = !phone && preset === "minimal";
  // Split gaps (AI races, multiplayer) and weather sit under the top corner groups, not in the middle of the screen
  const splitsNode =
    hud?.splitGaps !== false && !isThirdParty && !phone && !lightsPhase && race?.phase === "racing" ? (
      <SplitGaps splits={race.splits} variant="panel" />
    ) : null;
  // The split gaps, and the car's damage once something is broken (AI race)
  const damageNode =
    race?.damage && (!style?.ownDamage || touch) ? (
      <DamageWidget damage={race.damage} />
    ) : race?.damage && style?.ownDamage ? (
      <div className="hidden compact:block">
        <DamageWidget damage={race.damage} />
      </div>
    ) : null;
  const gapsNode =
    splitsNode || damageNode ? (
      <>
        {splitsNode}
        {damageNode}
      </>
    ) : null;
  const weatherNode = props.weather && !phone && !minimal && !lightsPhase ? <WeatherBadge weather={props.weather} variant="panel" /> : null;
  const trackInfo = getTrackInfo(ACTIVE_TRACK_ID);
  // The lap board: large screens only (never with the touch pads or the phone layout), outside races, where the race's
  // own tower and split gaps sit. A leaf with plain props, so this frame's render passes it by
  const boardKeyName = props.keyNames?.board;
  const boardNode =
    props.onChangeBoardWidget && largeScreen && !phone && !race ? (
      <div>
        <BoardWidget
          trackId={ACTIVE_TRACK_ID}
          trackName={trackInfo.name}
          vehicle={props.vehicleModel}
          driverName={props.displayPanel?.settings.profile.name ?? ""}
          mode={hud?.boardWidget ?? "lapEnd"}
          onChangeMode={props.onChangeBoardWidget}
          keyName={boardKeyName && boardKeyName !== "—" ? boardKeyName : undefined}
        />
      </div>
    ) : null;
  // polish:A — the time trial's target sits where a race's split gaps would, the lap board under it
  const targetNode = props.challengeTarget && !race && !phone ? <ChallengeTargetPanel target={props.challengeTarget} /> : null;
  const leftNode =
    gapsNode ??
    (targetNode || boardNode ? (
      <>
        {targetNode}
        {boardNode}
      </>
    ) : null);

  const showTyres = classic;
  const showMap = classic;
  const showChannels = classic;
  const showKeyHints = !phone && preset !== "minimal" && !style?.ownsBottomLeft;
  // Telemetry (and the styles with a trace of their own) have their own; a phone's thumbs sit where the trace would
  const showTrace = !phone && !style?.ownTrace && hud?.inputTrace === true;
  const showFfb = Boolean(props.ffbMeter) && classic;
  const scale = (hud?.scale ?? 1) * uiZoom;
  // A style's own top-centre group (under the virtual mirror when that is up): the notices start below it
  const topClearance = phone
    ? 0
    : thirdPartySkin === "irdashies"
      ? showDelta
        ? 52
        : 0
      : thirdPartySkin === "h2h"
        ? race && showDelta
          ? 56
          : 0
        : thirdPartySkin === "retro"
          ? showDelta
            ? 120
            : 0
          : thirdPartySkin === "blocks"
            ? lightsPhase
              ? 52
              : showDelta
                ? 124
                : 52
            : (style?.topClearance ?? 0);
  // Touch screens have no Esc key: a Menu button opens the pause menu
  const menuButton = (
    <span className="pointer-events-auto hidden pointer-coarse:block">
      {isThirdParty ? (
        <SkinButton
          onClick={props.onTogglePause}
          onPointerEnter={keepFocusOffHover}
          className="h-9 gap-2 px-3.5 text-[12px] font-bold uppercase"
        >
          <Icon name="menu" size="sm" />
          Menu
        </SkinButton>
      ) : (
        <Button variant="secondary" size="md" icon={<Icon name="menu" />} onClick={props.onTogglePause} onPointerEnter={keepFocusOffHover}>
          Menu
        </Button>
      )}
    </span>
  );
  /** Scales a corner group of the HUD about that corner */
  const corner = (origin: string): React.CSSProperties | undefined =>
    scale === 1 ? undefined : { transform: `scale(${scale})`, transformOrigin: origin };
  // Classic and Telemetry fill both right-hand corners, and on a laptop Broadcast's sits over the pod, so the MFD starts as its status pill there
  // The lap summary toast lifts itself above anything marked data-hud-avoid
  const mfdNode = (
    <div data-hud-avoid>
      <MultiPageMfd
        telemetry={telemetry}
        onChangeTuner={props.onChangeLiveTuner}
        tracker={lapTracker}
        trackLengthM={track.totalLengthM}
        compound={tireCompound}
        autoFold={hud?.mfdAutoCollapse ?? false}
        defaultFolded={(hud?.mfdAutoCollapse ?? false) || classic || Boolean(style?.mfdFolded) || (preset === "broadcast" && window.innerWidth < 1280)}
      />
    </div>
  );

  const hidden = hudMode === "hidden";
  // The off-track edge glow is drawn into the frame (the last render pass), not as a page layer over the canvas; it
  // hides with the HUD and during the start lights
  const offTrackGlow = telemetry.offTrack && !lightsPhase && !hidden;
  const { onOffTrackGlow } = props;
  useEffect(() => {
    onOffTrackGlow?.(offTrackGlow);
    return () => onOffTrackGlow?.(false);
  }, [offTrackGlow, onOffTrackGlow]);
  const aeroSkinTone: SkinTone =
    aeroNoticeNow?.tone === "good"
      ? "gain"
      : aeroNoticeNow?.tone === "warn"
        ? "caution"
        : aeroNoticeNow?.tone === "bad"
          ? "loss"
          : aeroNoticeNow?.tone === "info" || aeroNoticeNow?.tone === "best"
            ? "info"
            : "default";
  return (
    <HudModeContext.Provider value={hudMode}>
    <HudSkinProvider skin={thirdPartySkin}>
    {/* The corner groups keep clear of a notch and the home indicator, and past 2.4:1 (a 32:9 screen) they keep to
        a centred frame instead of the far edges. What belongs to the whole window is fixed to it instead. */}
    <div
      inert={hidden}
      className={`lc-safe-frame pointer-events-none fixed z-20 mx-auto max-w-[calc(100vh*2.4)] select-none p-3 sm:p-4 ${hidden ? "invisible" : ""} ${skinRootClass(thirdPartySkin) ?? ""}`}
    >
      {/* Proximity radar: centred just under the horizon, invisible until a car is within 25 m */}
      {hud?.radar !== false && !style?.ownRadar && !hudHidden && !lightsPhase && !phone ? (
        <div className="absolute top-[58%] left-1/2 -translate-x-1/2 -translate-y-1/2">
          <ProximityRadar blips={telemetry.radar} />
        </div>
      ) : null}
      {/* A full-screen style (Broadcast, Wheel Dash, Telemetry, a third-party layout): one layer. The run's laps, fuel
          use and clock live above it, so hiding the HUD or switching layout keeps them */}
      <HudRunProvider t={telemetry}>
      {hudHidden ? null : style ? (
        <style.component
          t={telemetry}
          deltaS={deltaS}
          map={hudMap}
          compound={tireCompound}
          revRange={revRangeOf(telemetry)}
          scale={scale}
          trackCode={trackInfo.country.slice(0, 3).toUpperCase()}
          ffb={props.ffbMeter ? <FfbMeter {...props.ffbMeter} /> : null}
          mfd={phone || touch ? undefined : mfdNode}
          touch={touch}
          topInset={mirrorTop ?? undefined}
          lapInvalid={lapInvalid}
          towerGaps={hud?.towerGaps}
          mapMode={hud?.mapMode}
          leftExtra={leftNode}
          rightExtra={isThirdParty ? null : weatherNode}
          weather={!lightsPhase ? (props.weather ?? null) : null}
          showDeltaBar={showDelta}
          showRadar={showRadar}
        />
      ) : (
        /* Classic / Minimal top-left: timing tower (race) and lap timing */
        <div className="absolute top-3 left-3 flex flex-col gap-2 sm:top-4 sm:left-4" style={corner("top left")}>
          {race ? <TimingTower race={race} trackCode={trackInfo.country.slice(0, 3).toUpperCase()} gaps={hud?.towerGaps} /> : null}
          <LapPanel telemetry={telemetry} deltaS={deltaS} variant={minimal ? "minimal" : "full"} lapInvalid={lapInvalid} />
          {leftNode}
          {weatherNode}
        </div>
      )}
      </HudRunProvider>

      {/* A frame round the virtual mirror, so its sky never reads as the real one (the renderer places it in window pixels) */}
      {mirrorRect && !hudHidden ? (
        <div
          aria-hidden
          className={`fixed shadow-[0_0_0_3px_var(--color-lc-void),0_0_0_4px_rgb(255_255_255/0.14),0_14px_40px_rgb(0_0_0/0.5)] ${
            isThirdParty && thirdPartySkin !== "irdashies" ? "rounded-none" : "rounded-md"
          }`}
          style={{ left: mirrorRect.x, top: mirrorRect.y, width: mirrorRect.w, height: mirrorRect.h }}
        />
      ) : null}
      {/* Top-centre: start lights and race-control notifications (under the Phone HUD's speed pod). As wide as its
          widest notice up to the screen's width less a margin: placed at left 50 % it would otherwise get only half
          the screen, and in portrait the notices wrapped to three lines and spilled out of their pills */}
      <div
        className={`absolute left-1/2 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 ${phone ? "top-[96px] portrait:top-[208px]" : "top-4"}`}
        style={
          mirrorTop !== null
            ? { top: `calc(${mirrorTop + Math.round(topClearance * scale)}px - env(safe-area-inset-top, 0px))` }
            : topClearance
              ? { top: `${16 + Math.round(topClearance * scale)}px` }
              : undefined
        }
      >
      <div className="flex flex-col items-center gap-2" style={corner("top center")}>
        {/* The touch controls carry their own pause button */}
        {style && !touch ? menuButton : null}
        <StartLights race={race} />
        {/* The ±1 s ribbon sits under every preset except the Phone HUD, whose speed pod owns this spot, and the
            layouts that show the delta up here themselves */}
        {hud?.deltaBar && !phone && !style?.ownDeltaBar && !lightsPhase ? <DeltaBar deltaS={deltaS} runId={telemetry.runId ?? 0} /> : null}
        {!lightsPhase ? (
          <RaceControlBanner
            status={telemetry.trackLimits}
            offTrack={telemetry.offTrack}
            race={Boolean(race)}
            yellow={Boolean(race?.yellow)}
            yellowGiveBack={race?.giveBack}
          />
        ) : null}
        {!lightsPhase && race ? (
          <RaceIncidentFeed messages={race.raceControl} yellow={race.yellow} doubleYellow={race.doubleYellow} blueFlag={race.blueFlag} />
        ) : null}
        {aeroNoticeNow ? (
          isThirdParty ? (
            <SkinBanner
              role="status"
              tone={aeroSkinTone}
              cut="sm"
              className="inline-flex min-h-10 items-center gap-2.5 py-1 pr-4 pl-2.5"
            >
              <SkinTag
                tone={aeroSkinTone}
                filled={aeroNoticeNow.variant === "solid"}
                className="px-2 py-0.5 text-[11px] font-bold uppercase"
              >
                {aeroNoticeNow.icon ? <Icon name={aeroNoticeNow.icon} size="xs" /> : null}
                {aeroNoticeNow.badge}
              </SkinTag>
              <span className="text-[15px] font-bold">{aeroNoticeNow.text}</span>
            </SkinBanner>
          ) : (
            <div role="status" className={`inline-flex min-h-10 items-center gap-2.5 rounded-full py-1 pr-5 pl-2 text-lc-chalk ${HUD_GLASS}`}>
              <Badge tone={aeroNoticeNow.tone} variant={aeroNoticeNow.variant} size="lg" icon={aeroNoticeNow.icon}>
                {aeroNoticeNow.badge}
              </Badge>
              <span className="lc-disp text-[16px]">{aeroNoticeNow.text}</span>
            </div>
          )
        ) : null}
        {/* Under the driving notices in the same column: stacked, never over them */}
        <QualityNotice notice={props.qualityNotice ?? null} />
        {showLaunchHint && !race ? (
          isThirdParty ? (
            <SkinBanner cut="sm" className="inline-flex min-h-10 items-center gap-2.5 py-1.5 pr-4 pl-3">
              <Icon name="play" size="xs" />
              <span className="text-[13px] font-semibold sm:text-[14px]">{launchHintText}</span>
            </SkinBanner>
          ) : (
            <div className={`inline-flex min-h-11 items-center gap-3 rounded-full py-1.5 pr-5 pl-2 ${HUD_GLASS}`}>
              <span className="inline-flex size-7.5 flex-none items-center justify-center rounded-full bg-lc-line text-lc-chalk">
                <Icon name="play" size="xs" />
              </span>
              <span className="lc-title text-[13px] text-lc-chalk sm:text-[15px]">{launchHintText}</span>
            </div>
          )
        ) : null}
        {props.wheelUncalibrated && !race ? (
          <span className="pointer-events-auto">
            {isThirdParty ? (
              <SkinButton
                onClick={() => props.onOpenControls?.()}
                onPointerEnter={keepFocusOffHover}
                className="h-9 gap-2 px-3.5 text-[12px] font-semibold"
              >
                <Icon name="warning" size="xs" className={skinCss.inkCaution} />
                Pedals not set up: calibrate throttle and brake
              </SkinButton>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon name="warning" className="text-lc-caution" />}
                onClick={() => props.onOpenControls?.()}
                onPointerEnter={keepFocusOffHover}
              >
                Pedals not set up: calibrate throttle and brake
              </Button>
            )}
          </span>
        ) : null}
        {lightsPhase ? (
          isThirdParty ? (
            <SkinBanner cut="sm" className="inline-flex h-10 items-center gap-2.5 pr-4 pl-3">
              <Icon name="play" size="xs" />
              <span className="lc-breathe text-[13px] font-semibold sm:text-[14px]">
                Hold the throttle · go when the lights go out
              </span>
            </SkinBanner>
          ) : (
            <div className={`inline-flex h-11 items-center gap-3 rounded-full pr-5 pl-2 ${HUD_GLASS}`}>
              <span className="inline-flex size-7.5 flex-none items-center justify-center rounded-full bg-lc-line text-lc-chalk">
                <Icon name="play" size="xs" />
              </span>
              <span className="lc-title lc-breathe text-[13px] text-lc-chalk sm:text-[15px]">
                Hold the throttle · go when the lights go out
              </span>
            </div>
          )
        ) : null}
        {mouseSteerEnabled ? (
          isThirdParty ? (
            <SkinPanel cut="sm" innerClassName="flex flex-col items-center gap-1.5 px-4 py-2">
              <span className={`text-[10px] font-bold uppercase ${skinCss.inkInfo}`}>Mouse steering · V to exit</span>
              <span className={`relative h-2 w-44 overflow-hidden ${skinCss.bgDeep} ${skinCss.radiusSm}`}>
                <span className={`absolute inset-y-0 left-1/2 w-px ${skinCss.fillDim}`} />
                <span
                  className={`absolute inset-y-0 w-2.5 -translate-x-1/2 ${skinCss.radiusSm} ${skinCss.fillInfo}`}
                  style={{ left: `${50 + telemetry.steering * 48}%` }}
                />
              </span>
            </SkinPanel>
          ) : (
            <div className={`flex flex-col items-center gap-1.5 rounded-lc-tile px-4 py-2 ${HUD_GLASS}`}>
              <span className={HUD_LBL} style={{ color: HUD_INFO }}>
                Mouse steering · V to exit
              </span>
              <span className="relative h-2 w-44 overflow-hidden rounded-full bg-lc-titanium">
                <span className="absolute inset-y-0 left-1/2 w-px bg-lc-chalk/40" />
                <span
                  className="absolute inset-y-0 w-2.5 -translate-x-1/2 rounded-full"
                  style={{ left: `${50 + telemetry.steering * 48}%`, backgroundColor: HUD_INFO }}
                />
              </span>
            </div>
          )
        ) : null}
      </div>
      </div>

      {hudHidden ? null : (
      <>
      {/* Classic / Minimal top-right: circuit map, and on touch screens (no Esc key) a button for the pause menu */}
      {!style ? (
        <div className="pointer-events-auto absolute top-3 right-3 flex flex-col items-end gap-2 sm:top-4 sm:right-4" style={corner("top right")}>
          {menuButton}
          <div className={showMap ? "hidden md:block" : "hidden"}>
            <TrackMinimap track={track} telemetry={telemetry} onSelectTurn={props.onSelectTurn} />
          </div>
        </div>
      ) : null}

      {/* Bottom-left: 4-corner tyre matrix, LibreCorsa badge, and key hints */}
      {/* data-hud-floor: the lap board above this corner keeps clear of it */}
      <div data-hud-floor className="absolute bottom-3 left-3 flex flex-col items-start gap-2 sm:bottom-4 sm:left-4" style={corner("bottom left")}>
        {showFfb && props.ffbMeter ? <FfbMeter {...props.ffbMeter} /> : null}
        {/* Classic's centred speed cluster spans a phone's width, so the tyre matrix waits for tablet width */}
        {showTyres ? (
          <div className={!style && !minimal ? "hidden md:block" : undefined}>
            <TyrePanel telemetry={telemetry} compound={tireCompound} />
          </div>
        ) : null}
        <div
          className={`${showKeyHints ? (style ? "2xl:flex" : "sm:flex") : ""} hidden flex-wrap items-center gap-x-3 gap-y-2 rounded-full py-2 pr-3.5 pl-2 text-[12px] font-bold text-lc-chalk ${HUD_GLASS}`}
        >
          <LibreCorsaLogo variant="mark" className="h-5.5 w-5.5" />
          {inputMode === "pad" ? (
            <span className="inline-flex items-center gap-1.5">
              <PadGlyph button="menu" family={padFamily} />
              Menu
            </span>
          ) : null}
          {(inputMode === "pad" ? [] : [
            ["ESC", "Menu"],
            [props.keyNames?.camera ?? "C", "Camera"],
            [props.keyNames?.racingLine ?? "R", "Line"],
            [props.keyNames?.restart ?? "Bksp", "Restart"],
            // The lap board's key, while there is one on screen
            ...(boardNode && boardKeyName && boardKeyName !== "—" ? [[boardKeyName, "Board"]] : []),
          ]).map(([k, label]) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <KeyCap>{k}</KeyCap>
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Classic / Minimal bottom-right: Live Tuner MFD, engineering channels (when active); Minimal's speed pills sit here too */}
      {/* Only without a full-screen style: a style draws its own MFD, and a second (hidden) one would still take the D-pad */}
      {!style ? (
      <div className="absolute right-3 bottom-3 flex flex-col items-end gap-2 sm:right-4 sm:bottom-4" style={corner("bottom right")}>
        <div className="hidden sm:block">
          {mfdNode}
        </div>
        {f12026 && showChannels ? (
          <div className="hidden sm:block">
            <F12026ChannelsPanel channels={f12026} aero={aeroReadout(telemetry)} aids={aidsActive(telemetry)} />
          </div>
        ) : null}
        {minimal ? (
          <div data-hud-avoid>
          <SpeedCluster
            telemetry={telemetry}
            boostLatch={boostLatch}
            onToggleBoostLatch={props.onToggleBoostLatch}
            onToggleXMode={props.onToggleXMode}
            variant="minimal"
          />
          </div>
        ) : null}
      </div>
      ) : null}

      {/* Bottom-centre: input trace (above the style's strip or dash) and Classic's speed cluster */}
      <div
        className="absolute bottom-3 left-1/2 -translate-x-1/2 sm:bottom-4"
        style={style ? { bottom: Math.round(style.bottomClearance * scale) } : undefined}
      >
        <div className="flex flex-col items-center gap-2" style={corner("bottom center")}>
          {showTrace ? (() => {
            const p = pedalLayers(telemetry);
            return (
              <div className="hidden sm:block">
                <InputTrace
                  sample={{
                    throttle: telemetry.throttle,
                    brake: telemetry.brake,
                    steering: telemetry.steering,
                    steerInput: telemetry.steerInput,
                    throttleOut: p.throttleOut,
                    brakeOut: p.brakeOut,
                    ffbClip: p.ffbClip,
                  }}
                  steerLockDeg={telemetry.steerLockDeg}
                  aside={<PedalBars t={telemetry} />}
                />
              </div>
            );
          })() : null}
          {!style && !minimal ? (
            <div data-hud-avoid>
            <SpeedCluster
              telemetry={telemetry}
              boostLatch={boostLatch}
              onToggleBoostLatch={props.onToggleBoostLatch}
              onToggleXMode={props.onToggleXMode}
              variant="full"
            />
            </div>
          ) : null}
        </div>
      </div>
      </>
      )}

      {hiddenNote ? (
        isThirdParty ? (
          <SkinBanner
            role="status"
            cut="sm"
            className="lc-panel-in absolute bottom-6 left-1/2 inline-flex h-9 -translate-x-1/2 items-center px-4 text-[13px] font-semibold"
          >
            HUD hidden{props.hudToggleButton ? ` · ${props.hudToggleButton} brings it back` : ""}
          </SkinBanner>
        ) : (
          <div
            role="status"
            className={`lc-panel-in absolute bottom-6 left-1/2 inline-flex h-9 -translate-x-1/2 items-center rounded-full px-4 lc-title text-[13px] text-lc-chalk ${HUD_GLASS}`}
          >
            HUD hidden{props.hudToggleButton ? ` · ${props.hudToggleButton} brings it back` : ""}
          </div>
        )
      ) : null}

      {/* Portalled to the page: places itself bottom right over the MFD and dash, top centre on touch */}
      {props.lapSummary ? <LapSummary {...props.lapSummary} /> : null}

      {props.touchControls ? (
        <div className="pointer-events-auto">
          <TouchControls {...props.touchControls} car={touchCarState(telemetry, lightsPhase)} />
        </div>
      ) : null}

      {/* Mounted only while it can take input: under the pause menu or a replay it would be a second focus owner */}
      {showResults && race && !hidden ? (
        <div className="pointer-events-auto">
          <RaceResults
            race={race}
            trackName={trackInfo.name}
            onClose={() => props.onCloseResults?.()}
            onRestart={props.onRestartRace}
            onBackToLobby={props.onBackToLobby}
            backLabel={props.backToLobbyLabel}
            trackLimitStrikes={telemetry.trackLimits?.totalStrikes ?? 0}
            history={props.raceEnd?.history}
            nextRace={props.raceEnd?.nextRace}
          />
        </div>
      ) : null}
    </div>

    {podiumUp && !paused && props.raceEnd ? (
      <PodiumOverlay rows={props.raceEnd.podium.rows} trackName={trackInfo.name} onSkip={props.raceEnd.onSkipPodium} />
    ) : null}

    {/* Instant replay: only the badge and the transport bar show (under the pause menu, neither) */}
    {props.replay && !paused ? (
      <div className="lc-safe-frame pointer-events-none fixed z-20 select-none">
        <div
          role="status"
          className={`lc-ui-zoom absolute top-13 left-1/2 inline-flex h-9.5 -translate-x-1/2 items-center gap-2.5 rounded-full pr-4.5 pl-3.5 text-lc-chalk sm:top-17 short:top-8 ${HUD_GLASS}`}
        >
          <Icon name="replay" size="sm" />
          <span className="lc-disp text-[18px]">Replay</span>
        </div>
        <div className="pointer-events-auto">
          <ReplayBar {...props.replay} />
        </div>
      </div>
    ) : null}

    {paused ? (
      <PauseMenu
        {...props}
        mouseSteerEnabled={mouseSteerEnabled}
        gamepadAssist={gamepadAssist}
        initialRoomCode={inviteRoom ?? ""}
        openMultiplayer={!inviteUsed && Boolean(inviteRoom) && (props.p2pStatus?.connectedWebRtcPeers ?? 0) === 0}
        onCycleCamera={onCycleCamera}
        covered={props.pauseMenuCovered}
      />
    ) : null}
    </HudSkinProvider>
    </HudModeContext.Provider>
  );
};
