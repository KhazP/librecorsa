"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
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
import type { DisplayPanelProps } from "./hud/DisplayPanel";
import type { LeaderboardPanelProps } from "./hud/LeaderboardPanel";
import type { CarId } from "@/lib/cars/car-registry";
import { type BuiltTrackData } from "@/lib/track-data";
import { HUD_TOGGLE_EVENT } from "@/lib/input/bindings";
import { TrackMinimap } from "./TrackMinimap";
import { LapPanel, TimingTower } from "./hud/TimingPanels";
import { SpeedCluster } from "./hud/SpeedCluster";
import { TyrePanel } from "./hud/TyrePanel";
import { StartLights } from "./hud/StartLights";
import { nextCameraMode, PauseMenu } from "./hud/PauseMenu";
import { F12026ChannelsPanel } from "./hud/F12026ChannelsPanel";
import { MultiPageMfd } from "./hud/MultiPageMfd";
import { useLapDeltaTracker } from "./hud/useLapDelta";
import { HUD_CYAN, HUD_GLASS, HUD_LBL, HUD_RED, HUD_VOLT } from "./hud/hud-format";
import { LibreCorsaLogo } from "./ui/LibreCorsaLogo";
import { InputTrace } from "./hud/InputTrace";
import { PedalBars, pedalLayers } from "./hud/PedalBars";
import { ProximityRadar } from "./hud/ProximityRadar";
import { virtualMirrorRect } from "@/lib/render/virtual-mirror";
import { DeltaBar } from "./hud/DeltaBar";
import { FfbMeter } from "./hud/FfbMeter";
import { LapSummary } from "./hud/LapSummary";
import { RaceResults } from "./hud/RaceResults";
import { RaceControlBanner } from "./hud/RaceControlBanner";
import { ReplayBar } from "./hud/ReplayBar";
import { TouchControls, type TouchControlsProps } from "./hud/TouchControls";
import { getTrackInfo } from "@/lib/track-registry";
import { useInputMode } from "./menu/input-mode";
import { PadGlyph } from "./menu/menu-ui";
import { ACTIVE_TRACK_ID } from "@/lib/track-data";
import { BroadcastHud } from "./hud/styles/BroadcastHud";
import { WheelDashHud } from "./hud/styles/WheelDashHud";
import { TelemetryHud } from "./hud/styles/TelemetryHud";
import { PhoneHud, usePhoneLayout } from "./hud/styles/PhoneHud";
import { buildHudMap, revRangeOf, useLapInvalid, type HudDesignProps } from "./hud/styles/hud-style-parts";
import type { HudPreset } from "@/lib/settings/player-settings";

/** The full-screen HUD styles; Classic and Minimal use the corner panels below */
const HUD_STYLES: Partial<Record<HudPreset, { component: React.FC<HudDesignProps>; bottomClearance: number }>> = {
  broadcast: { component: BroadcastHud, bottomClearance: 128 },
  dash: { component: WheelDashHud, bottomClearance: 252 },
  telemetry: { component: TelemetryHud, bottomClearance: 252 },
};
/** Every preset gives way to the Phone HUD on a phone-sized screen */
const PHONE_STYLE = { component: PhoneHud, bottomClearance: 16 };

interface F1TelemetryHudProps extends MultiplayerPanelProps {
  track: BuiltTrackData;
  telemetry: CarTelemetry;
  aeroPreset: AeroSetupPreset;
  assistPreset: DriverAssistPreset;
  cameraMode: CameraMode;
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
  gamepadRumble: boolean;
  aiOpponents: boolean;
  onToggleAiOpponents: () => void;
  carId: CarId;
  vehicleModel: VehicleModelId;
  onChangeCar: (car: CarId) => void;
  onToggleGamepadAssist?: () => void;
  onToggleGamepadRumble: () => void;
  onChangeAeroPreset: (preset: AeroSetupPreset) => void;
  onChangeAssistPreset: (preset: DriverAssistPreset) => void;
  onChangeCameraMode: (mode: CameraMode) => void;
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
  onTogglePause: () => void;
  onOpenControls?: () => void;
  onExitToTitle?: () => void;
  controlsCheatSheet?: readonly (readonly [string, string])[];
  keyNames?: Partial<Record<"camera" | "racingLine" | "mute" | "mouseSteer" | "autopilot" | "restart", string>>;
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
  /** Instant replay in progress: only the transport bar shows */
  replay?: React.ComponentProps<typeof ReplayBar> | null;
  /** On-screen pedals and steering (touch screens) */
  touchControls?: TouchControlsProps | null;
  displayPanel?: DisplayPanelProps;
  leaderboardPanel?: LeaderboardPanelProps;
}

/** Normalises a ?room= invite link value to the bare room code, or null when it is not one */
export function roomFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("room");
  const code = raw?.trim().replace(/^(RWA|LC)-/i, "").toUpperCase().slice(0, 6) ?? "";
  return code.length >= 3 ? code : null;
}

/** The last DRS detection crossed (f12026-car), shown for 2.5 s after it happens */
function useDrsDetectionNotice(
  detection: { zone: string; eligible: boolean; atMs: number } | null
): { zone: string; eligible: boolean } | null {
  const [notice, setNotice] = useState<{ zone: string; eligible: boolean } | null>(null);
  const key = detection ? `${detection.zone}@${detection.atMs}` : "";
  useEffect(() => {
    if (!detection) return;
    setNotice({ zone: detection.zone, eligible: detection.eligible });
    const id = window.setTimeout(() => setNotice(null), 2500);
    return () => window.clearTimeout(id);
    // Re-arm only when a new detection point is crossed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return notice;
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
    launchHintText = "Hold W / ↑ to launch · Esc for menu",
    mouseSteerEnabled = false,
    gamepadAssist = true,
    paused,
    onChangeCameraMode,
  } = props;

  const [inviteRoom] = useState(roomFromUrl);
  const { mode: inputMode, family: padFamily } = useInputMode();
  const { tracker: lapTracker, deltaS } = useLapDeltaTracker(telemetry, track.totalLength);
  const race = telemetry.race;
  const f12026 = telemetry.f12026;
  const drsNotice = useDrsDetectionNotice(f12026?.drsDetection ?? null);
  const hudMap = useMemo(() => buildHudMap(track), [track]);
  const phone = usePhoneLayout();
  const lapInvalid = useLapInvalid(telemetry);
  // Under the virtual mirror's strip (its rect is shared with the renderer), with a little air
  const mirrorTop = props.virtualMirror && !phone && typeof window !== "undefined" ? (() => {
    const r = virtualMirrorRect(window.innerWidth, window.innerHeight);
    return r.y + r.h + 8;
  })() : null;
  // The HUD pad button (R3 by default) clears every panel off the screen; start lights and alerts stay
  const [hudHidden, setHudHidden] = useState(false);
  const [hiddenNote, setHiddenNote] = useState(false);
  useEffect(() => {
    const toggle = () => setHudHidden((h) => !h);
    window.addEventListener(HUD_TOGGLE_EVENT.hud, toggle);
    return () => window.removeEventListener(HUD_TOGGLE_EVENT.hud, toggle);
  }, []);
  useEffect(() => {
    setHiddenNote(hudHidden);
    if (!hudHidden) return;
    const id = window.setTimeout(() => setHiddenNote(false), 2500);
    return () => window.clearTimeout(id);
  }, [hudHidden]);

  const cycleCamera = useCallback(() => {
    onChangeCameraMode(nextCameraMode(cameraMode));
  }, [cameraMode, onChangeCameraMode]);

  if (props.replay && !paused) {
    return (
      <div className="pointer-events-none fixed inset-0 z-20 select-none">
        <div
          role="status"
          className="absolute top-[52px] left-1/2 inline-flex h-[38px] -translate-x-1/2 items-center gap-2.5 rounded-full pr-[18px] pl-3.5 text-[#F5F7FA] shadow-[0_10px_30px_rgba(255,42,60,0.35)] sm:top-[68px] short:top-8"
          style={{ backgroundColor: HUD_RED }}
        >
          <span className="relative inline-flex h-2 w-2">
            <span className="lc-ping absolute inset-0 rounded-full bg-[#F5F7FA]" />
            <span className="relative h-2 w-2 rounded-full bg-[#F5F7FA]" />
          </span>
          <span className="lc-disp text-[18px]">Replay</span>
        </div>
        <div className="pointer-events-auto">
          <ReplayBar {...props.replay} />
        </div>
      </div>
    );
  }

  if (paused) {
    return (
      <PauseMenu
        {...props}
        mouseSteerEnabled={mouseSteerEnabled}
        gamepadAssist={gamepadAssist}
        initialRoomCode={inviteRoom ?? ""}
        openMultiplayer={Boolean(inviteRoom) && (props.p2pStatus?.connectedWebRtcPeers ?? 0) === 0}
        onCycleCamera={cycleCamera}
      />
    );
  }

  const lightsPhase = race?.phase === "lights";
  const hud = props.hud;
  const preset = hud?.preset ?? "broadcast";
  const style = phone ? PHONE_STYLE : HUD_STYLES[preset];
  const classic = !phone && preset === "classic";
  const minimal = !phone && preset === "minimal";
  const showTyres = classic;
  const showMap = classic;
  const showChannels = classic;
  const showKeyHints = !phone && preset !== "minimal" && preset !== "telemetry";
  // Telemetry has its own trace and force meter; a phone's thumbs sit where the trace would
  const showTrace = !phone && preset !== "telemetry" && hud?.inputTrace === true;
  const showFfb = Boolean(props.ffbMeter) && classic;
  const scale = hud?.scale ?? 1;
  const trackInfo = getTrackInfo(ACTIVE_TRACK_ID);
  const menuButton = (
    <button
      type="button"
      onClick={props.onTogglePause}
      className={`pointer-events-auto hidden h-11 cursor-pointer rounded-full px-5 lc-title text-[15px] text-[#CCFF00] pointer-coarse:block ${HUD_GLASS}`}
    >
      Menu
    </button>
  );
  /** Scales a corner group of the HUD about that corner */
  const corner = (origin: string): React.CSSProperties | undefined =>
    scale === 1 ? undefined : { transform: `scale(${scale})`, transformOrigin: origin };
  const showResults = Boolean(race?.results) && !props.resultsClosed;
  // Classic and Telemetry fill both right-hand corners, and on a laptop Broadcast's sits over the pod, so the MFD starts as its status pill there
  // The lap summary toast lifts itself above anything marked data-hud-avoid
  const mfdNode = (
    <div data-hud-avoid>
      <MultiPageMfd
        telemetry={telemetry}
        onChangeTuner={props.onChangeLiveTuner}
        tracker={lapTracker}
        trackLengthM={track.totalLength}
        compound={tireCompound}
        autoFold={hud?.mfdAutoCollapse ?? true}
        defaultFolded={(hud?.mfdAutoCollapse ?? true) || classic || preset === "telemetry" || (preset === "broadcast" && window.innerWidth < 1280)}
      />
    </div>
  );

  return (
    <div className="pointer-events-none fixed inset-0 z-20 select-none p-3 sm:p-4">
      {/* Proximity radar: centred just under the horizon, invisible until a car is within 25 m */}
      {hud?.radar !== false && !hudHidden && !lightsPhase && !phone ? (
        <div className="absolute top-[58%] left-1/2 -translate-x-1/2 -translate-y-1/2">
          <ProximityRadar blips={telemetry.radar} />
        </div>
      ) : null}
      {/* Off the track: a crimson edge glow that breathes behind the HUD (opacity-only animation) */}
      {telemetry.offTrack && !lightsPhase ? (
        <div
          className="lc-vign absolute inset-0"
          style={{ background: "radial-gradient(ellipse at center, rgba(255,42,60,0) 62%, rgba(255,42,60,0.32) 100%)" }}
          aria-hidden="true"
        />
      ) : null}
      {/* Broadcast, Wheel Dash or Telemetry: one full-screen layer */}
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
          mfd={phone ? undefined : mfdNode}
          touch={Boolean(props.touchControls)}
          lapInvalid={lapInvalid}
          towerGaps={hud?.towerGaps}
          mapMode={hud?.mapMode}
        />
      ) : (
        /* Classic / Minimal top-left: timing tower (race) and lap timing */
        <div className="absolute top-3 left-3 flex flex-col gap-2 sm:top-4 sm:left-4" style={corner("top left")}>
          {race ? <TimingTower race={race} trackCode={trackInfo.country.slice(0, 3).toUpperCase()} gaps={hud?.towerGaps} /> : null}
          <LapPanel telemetry={telemetry} deltaS={deltaS} variant={minimal ? "minimal" : "full"} lapInvalid={lapInvalid} />
        </div>
      )}

      {/* Top-centre: start lights and race-control notifications (under the Phone HUD's speed pod) */}
      <div
        className={`absolute left-1/2 -translate-x-1/2 ${
          phone ? "top-[calc(env(safe-area-inset-top,0px)+96px)] portrait:top-[calc(env(safe-area-inset-top,0px)+208px)]" : "top-4"
        }`}
        style={mirrorTop !== null ? { top: mirrorTop } : undefined}
      >
      <div className="flex flex-col items-center gap-2" style={corner("top center")}>
        {style && !(phone && props.touchControls) ? menuButton : null}
        <StartLights race={race} />
        {/* The ±1 s ribbon sits under every preset except the Phone HUD, whose speed pod owns this spot */}
        {hud?.deltaBar && !phone && !lightsPhase ? <DeltaBar deltaS={deltaS} /> : null}
        {!lightsPhase ? (
          <RaceControlBanner status={telemetry.trackLimits} offTrack={telemetry.offTrack} race={Boolean(race)} />
        ) : null}
        {drsNotice ? (
          <div
            className="inline-flex h-10 items-center gap-2.5 rounded-full border pr-5 pl-2 shadow-[0_14px_40px_rgba(0,0,0,0.5)]"
            style={{
              backgroundColor: drsNotice.eligible ? HUD_VOLT : "rgba(8, 9, 13, 0.86)",
              color: drsNotice.eligible ? "#08090D" : "#F5F7FA",
              borderColor: drsNotice.eligible ? HUD_VOLT : "#262B3D",
            }}
          >
            <span
              className="lc-data inline-flex h-7 items-center rounded-full px-2.5 text-[11px] tracking-[0.1em]"
              style={{
                backgroundColor: drsNotice.eligible ? "#08090D" : "#1B1F2B",
                color: drsNotice.eligible ? HUD_VOLT : "#8E96AA",
              }}
            >
              {drsNotice.zone}
            </span>
            <span className="lc-disp text-[16px]">{drsNotice.eligible ? "DRS enabled" : "DRS not enabled"}</span>
          </div>
        ) : null}
        {showLaunchHint && !race ? (
          <div className={`inline-flex min-h-11 items-center gap-3 rounded-full py-1.5 pr-5 pl-2 ${HUD_GLASS}`}>
            <span className="inline-flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full bg-[#CCFF00]">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="#08090D" aria-hidden="true">
                <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" />
              </svg>
            </span>
            <span className="lc-title text-[13px] text-[#F5F7FA] sm:text-[15px]">{launchHintText}</span>
          </div>
        ) : null}
        {props.wheelUncalibrated && !race ? (
          <button
            type="button"
            onClick={() => props.onOpenControls?.()}
            className="lc-data pointer-events-auto inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-full border border-[#FFB300] bg-[#08090D]/[0.86] px-4 py-1 text-[11px] text-[#FFB300] uppercase transition-colors hover:bg-[#FFB300]/15"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[#FFB300]" />
            Pedals not set up · click to calibrate throttle &amp; brake
          </button>
        ) : null}
        {lightsPhase ? (
          <div className={`inline-flex h-11 items-center gap-3 rounded-full pr-5 pl-2 ${HUD_GLASS}`}>
            <span className="inline-flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full bg-[#CCFF00]">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="#08090D" aria-hidden="true">
                <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" />
              </svg>
            </span>
            <span className="lc-title lc-breathe text-[13px] text-[#F5F7FA] sm:text-[15px]">
              Hold the throttle · go when the lights go out
            </span>
          </div>
        ) : null}
        {mouseSteerEnabled ? (
          <div className={`flex flex-col items-center gap-1.5 rounded-[18px] px-4 py-2 ${HUD_GLASS}`}>
            <span className={HUD_LBL} style={{ color: HUD_CYAN }}>
              Mouse steering · V to exit
            </span>
            <span className="relative h-2 w-44 overflow-hidden rounded-full bg-[#1B1F2B]">
              <span className="absolute inset-y-0 left-1/2 w-px bg-[#F5F7FA]/40" />
              <span
                className="absolute inset-y-0 w-2.5 -translate-x-1/2 rounded-full"
                style={{ left: `${50 + telemetry.steering * 48}%`, backgroundColor: HUD_CYAN }}
              />
            </span>
          </div>
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
      <div className="absolute bottom-3 left-3 flex flex-col items-start gap-2 sm:bottom-4 sm:left-4" style={corner("bottom left")}>
        {showFfb && props.ffbMeter ? <FfbMeter {...props.ffbMeter} /> : null}
        {/* Classic's centred speed cluster spans a phone's width, so the tyre matrix waits for tablet width */}
        {showTyres ? (
          <div className={!style && !minimal ? "hidden md:block" : undefined}>
            <TyrePanel telemetry={telemetry} compound={tireCompound} />
          </div>
        ) : null}
        <div
          className={`${showKeyHints ? (style ? "xl:flex" : "sm:flex") : ""} hidden flex-wrap items-center gap-x-3 gap-y-2 rounded-full py-2 pr-3.5 pl-2 text-[12px] font-bold text-[#F5F7FA] ${HUD_GLASS}`}
        >
          <LibreCorsaLogo variant="mark" className="h-[22px] w-[22px]" />
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
            [props.keyNames?.restart ?? "⌫", "Restart"],
          ]).map(([k, label]) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span className="lc-data inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-[#CCFF00] px-1.5 text-[10px] text-[#08090D]">
                {k}
              </span>
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Classic / Minimal bottom-right: Live Tuner MFD, engineering channels (when active); Minimal's speed pills sit here too */}
      <div className={`absolute right-3 bottom-3 flex-col items-end gap-2 sm:right-4 sm:bottom-4 ${style ? "hidden" : "flex"}`} style={corner("bottom right")}>
        <div className="hidden sm:block">
          {mfdNode}
        </div>
        {f12026 && showChannels ? (
          <div className="hidden sm:block">
            <F12026ChannelsPanel channels={f12026} />
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
                    throttleOut: p.throttleOut,
                    brakeOut: p.brakeOut,
                    ffbClip: p.ffbClip,
                  }}
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
        <div
          role="status"
          className={`lc-panel-in absolute bottom-6 left-1/2 inline-flex h-9 -translate-x-1/2 items-center rounded-full px-4 lc-title text-[13px] text-[#F5F7FA] ${HUD_GLASS}`}
        >
          HUD hidden{props.hudToggleButton ? ` · ${props.hudToggleButton} brings it back` : ""}
        </div>
      ) : null}

      {/* Portalled to the page: places itself bottom right over the MFD and dash, top centre on touch */}
      {props.lapSummary ? <LapSummary {...props.lapSummary} /> : null}

      {props.touchControls ? (
        <div className="pointer-events-auto">
          <TouchControls {...props.touchControls} />
        </div>
      ) : null}

      {showResults && race ? (
        <div className="pointer-events-auto">
          <RaceResults
            race={race}
            trackName={trackInfo.name}
            onClose={() => props.onCloseResults?.()}
            onRestart={props.onRestartRace}
            onBackToLobby={props.onBackToLobby}
            trackLimitStrikes={telemetry.trackLimits?.totalStrikes ?? 0}
          />
        </div>
      ) : null}
    </div>
  );
};
