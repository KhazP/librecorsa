"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AeroSetupPreset,
  CameraMode,
  CarTelemetry,
  DriverAssistPreset,
  LiveryConfig,
  TireCompound,
  TyreSetup,
  VehicleModelId,
} from "@/types/f1";
import type { MultiplayerPanelProps } from "./hud/MultiplayerPanel";
import type { HudSettings } from "@/lib/settings/player-settings";
import type { DisplayPanelProps } from "./hud/DisplayPanel";
import type { LeaderboardPanelProps } from "./hud/LeaderboardPanel";
import { type BuiltTrackData } from "@/lib/track-data";
import { TrackMinimap } from "./TrackMinimap";
import { LapPanel, TimingTower } from "./hud/TimingPanels";
import { SpeedCluster } from "./hud/SpeedCluster";
import { TyrePanel } from "./hud/TyrePanel";
import { StartLights } from "./hud/StartLights";
import { nextCameraMode, PauseMenu } from "./hud/PauseMenu";
import { F12026ChannelsPanel } from "./hud/F12026ChannelsPanel";
import { useLapDelta } from "./hud/useLapDelta";
import { HUD_CYAN, HUD_RED, HUD_VOLT } from "./hud/hud-format";
import { LibreCorsaLogo } from "./ui/LibreCorsaLogo";
import { InputTrace } from "./hud/InputTrace";
import { DeltaBar } from "./hud/DeltaBar";
import { FfbMeter } from "./hud/FfbMeter";
import { LapSummary } from "./hud/LapSummary";
import { RaceResults } from "./hud/RaceResults";
import { ReplayBar } from "./hud/ReplayBar";
import { TouchControls, type TouchControlsProps } from "./hud/TouchControls";
import { getTrackInfo } from "@/lib/track-registry";
import { useInputMode } from "./menu/input-mode";
import { PadGlyph } from "./menu/menu-ui";
import { ACTIVE_TRACK_ID } from "@/lib/track-data";
import { BroadcastHud } from "./hud/styles/BroadcastHud";
import { WheelDashHud } from "./hud/styles/WheelDashHud";
import { TelemetryHud } from "./hud/styles/TelemetryHud";
import { buildHudMap, revRangeOf, type HudDesignProps } from "./hud/styles/hud-style-parts";
import type { HudPreset } from "@/lib/settings/player-settings";

/** The full-screen HUD styles; Classic and Minimal use the corner panels below */
const HUD_STYLES: Partial<Record<HudPreset, { component: React.FC<HudDesignProps>; bottomClearance: number }>> = {
  broadcast: { component: BroadcastHud, bottomClearance: 128 },
  dash: { component: WheelDashHud, bottomClearance: 252 },
  telemetry: { component: TelemetryHud, bottomClearance: 252 },
};

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
  mouseSteerEnabled?: boolean;
  gamepadAssist?: boolean;
  gamepadRumble: boolean;
  aiOpponents: boolean;
  onToggleAiOpponents: () => void;
  vehicleModel: VehicleModelId;
  onChangeVehicle: (vehicle: VehicleModelId) => void;
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
  const deltaS = useLapDelta(telemetry, track.totalLength);
  const race = telemetry.race;
  const f12026 = telemetry.f12026;
  const drsNotice = useDrsDetectionNotice(f12026?.drsDetection ?? null);
  const hudMap = useMemo(() => buildHudMap(track), [track]);

  const cycleCamera = useCallback(() => {
    onChangeCameraMode(nextCameraMode(cameraMode));
  }, [cameraMode, onChangeCameraMode]);

  if (props.replay && !paused) {
    return (
      <div className="pointer-events-none fixed inset-0 z-20 select-none">
        <div className="absolute top-4 left-1/2 -translate-x-1/2 hud-slant px-5 py-1.5 font-f1-italic text-sm tracking-wider text-white uppercase" style={{ backgroundColor: HUD_RED }}>
          Replay
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
  const style = HUD_STYLES[preset];
  const classic = preset === "classic";
  const showTyres = classic;
  const showMap = classic;
  const showChannels = classic;
  const showKeyHints = preset !== "minimal" && preset !== "telemetry";
  // Telemetry has its own trace and force meter
  const showTrace = preset !== "telemetry" && hud?.inputTrace === true;
  const showFfb = Boolean(props.ffbMeter) && classic;
  const scale = hud?.scale ?? 1;
  const trackInfo = getTrackInfo(ACTIVE_TRACK_ID);
  const menuButton = (
    <button
      type="button"
      onClick={props.onTogglePause}
      className="pointer-events-auto hud-panel hidden cursor-pointer rounded border-[#CCFF00]/50 px-4 py-2 font-f1-italic text-sm tracking-wider text-[#CCFF00] uppercase pointer-coarse:block"
    >
      Menu
    </button>
  );
  /** Scales a corner group of the HUD about that corner */
  const corner = (origin: string): React.CSSProperties | undefined =>
    scale === 1 ? undefined : { transform: `scale(${scale})`, transformOrigin: origin };
  const showResults = Boolean(race?.results) && !props.resultsClosed;

  return (
    <div className="pointer-events-none fixed inset-0 z-20 select-none p-3 sm:p-4">
      {/* Broadcast, Wheel Dash or Telemetry: one full-screen layer */}
      {style ? (
        <style.component
          t={telemetry}
          deltaS={deltaS}
          map={hudMap}
          compound={tireCompound}
          revRange={revRangeOf(telemetry)}
          scale={scale}
          trackCode={trackInfo.country.slice(0, 3).toUpperCase()}
          ffb={props.ffbMeter ? <FfbMeter {...props.ffbMeter} /> : null}
        />
      ) : (
        /* Classic / Minimal top-left: timing tower (race) and lap timing */
        <div className="absolute top-3 left-3 flex flex-col gap-2 sm:top-4 sm:left-4" style={corner("top left")}>
          {race ? <TimingTower race={race} /> : null}
          <LapPanel telemetry={telemetry} deltaS={deltaS} />
        </div>
      )}

      {/* Top-centre: start lights and race-control notifications */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2">
      <div className="flex flex-col items-center gap-2" style={corner("top center")}>
        {style ? menuButton : null}
        <StartLights race={race} />
        {/* The styles carry their own delta */}
        {hud?.deltaBar && !style && !lightsPhase ? <DeltaBar deltaS={deltaS} /> : null}
        {telemetry.offTrack && !lightsPhase ? (
          <div
            className="hud-slant px-5 py-1.5 font-f1-italic text-sm tracking-wider text-white uppercase shadow-xl"
            style={{ backgroundColor: HUD_RED }}
          >
            Track limits · lap invalid
          </div>
        ) : null}
        {drsNotice ? (
          <div
            className="hud-slant border px-5 py-1.5 font-f1-italic text-sm tracking-wider uppercase shadow-xl"
            style={{
              backgroundColor: drsNotice.eligible ? HUD_VOLT : "rgba(17, 19, 26, 0.92)",
              color: drsNotice.eligible ? "#08090D" : "#F5F7FA",
              borderColor: drsNotice.eligible ? HUD_VOLT : "#262B3D",
            }}
          >
            {drsNotice.eligible ? "DRS enabled" : "DRS not enabled"} · {drsNotice.zone}
          </div>
        ) : null}
        {showLaunchHint && !race ? (
          <div className="hud-panel rounded-md border-l-2 border-l-[#CCFF00] px-4 py-1.5 font-f1-italic text-xs tracking-wider text-[#F5F7FA] uppercase">
            {launchHintText}
          </div>
        ) : null}
        {props.wheelUncalibrated && !race ? (
          <button
            type="button"
            onClick={() => props.onOpenControls?.()}
            className="pointer-events-auto cursor-pointer rounded border border-[#FFB300]/70 bg-[#08090D]/95 px-3 py-1 font-f1-mono text-[11px] font-bold text-[#FFB300] uppercase hover:bg-[#FFB300]/15"
          >
            Pedals not set up · click to calibrate throttle &amp; brake
          </button>
        ) : null}
        {lightsPhase ? (
          <div className="hud-panel rounded-md border-l-2 border-l-[#CCFF00] px-4 py-1.5 font-f1-italic text-xs tracking-wider text-[#F5F7FA] uppercase">
            Hold the throttle · go when the lights go out
          </div>
        ) : null}
        {mouseSteerEnabled ? (
          <div className="hud-panel flex flex-col items-center gap-1 rounded-md px-3 py-1.5">
            <span className="hud-label" style={{ color: HUD_CYAN }}>
              Mouse steering · V to exit
            </span>
            <span className="relative h-2 w-44 overflow-hidden rounded bg-[#08090D] border border-[#262B3D]">
              <span className="absolute inset-y-0 left-1/2 w-0.5 bg-white/40" />
              <span
                className="absolute inset-y-0 w-2.5 -translate-x-1/2 rounded"
                style={{ left: `${50 + telemetry.steering * 48}%`, backgroundColor: HUD_CYAN }}
              />
            </span>
          </div>
        ) : null}
      </div>
      </div>

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
        {showTyres ? <TyrePanel telemetry={telemetry} compound={tireCompound} /> : null}
        <div className={`${showKeyHints ? "sm:flex" : ""} hidden items-center gap-1.5 font-f1-mono text-[11px] font-bold text-[#8E96AA]`}>
          <span className="hud-panel flex items-center justify-center rounded p-1">
            <LibreCorsaLogo variant="mark" className="h-5 w-5" />
          </span>
          {inputMode === "pad" ? (
            <span className="hud-panel flex items-center gap-1.5 rounded px-2 py-1 text-[#F5F7FA]">
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
            <span key={k} className="hud-panel flex items-center gap-1.5 rounded px-2 py-1 text-[#F5F7FA]">
              <span className="rounded bg-[#CCFF00] px-1 font-extrabold text-[#08090D]">{k}</span>
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Classic / Minimal bottom-right: engineering channels (when active) and MoTeC speed cluster */}
      <div className={`absolute right-3 bottom-3 flex-col items-end gap-2 sm:right-4 sm:bottom-4 ${style ? "hidden" : "flex"}`} style={corner("bottom right")}>
        {f12026 && showChannels ? (
          <div className="hidden sm:block">
            <F12026ChannelsPanel channels={f12026} />
          </div>
        ) : null}
        <SpeedCluster
          telemetry={telemetry}
          boostLatch={boostLatch}
          onToggleBoostLatch={props.onToggleBoostLatch}
          onToggleXMode={props.onToggleXMode}
        />
      </div>

      {/* Bottom-centre: input trace, and the lap summary after a lap (above the style's strip or dash) */}
      <div
        className="absolute bottom-3 left-1/2 -translate-x-1/2 sm:bottom-4"
        style={style ? { bottom: Math.round(style.bottomClearance * scale) } : undefined}
      >
        <div className="flex flex-col items-center gap-2" style={corner("bottom center")}>
          {props.lapSummary ? (
            <div className="pointer-events-auto">
              <LapSummary {...props.lapSummary} />
            </div>
          ) : null}
          {showTrace ? (
            <div className="hidden sm:block">
              <InputTrace sample={{ throttle: telemetry.throttle, brake: telemetry.brake, steering: telemetry.steering }} />
            </div>
          ) : null}
        </div>
      </div>

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
          />
        </div>
      ) : null}
    </div>
  );
};
