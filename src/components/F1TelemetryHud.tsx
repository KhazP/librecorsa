"use client";

import React, { useCallback, useEffect, useState } from "react";
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
import type { P2PConnectionStatus } from "@/lib/sim/multiplayer-sync";
import { type BuiltTrackData } from "@/lib/track-data";
import { TrackMinimap } from "./TrackMinimap";
import { LapPanel, TimingTower } from "./hud/TimingPanels";
import { SpeedCluster } from "./hud/SpeedCluster";
import { TyrePanel } from "./hud/TyrePanel";
import { StartLights } from "./hud/StartLights";
import { nextCameraMode, PauseMenu } from "./hud/PauseMenu";
import { F12026ChannelsPanel } from "./hud/F12026ChannelsPanel";
import { useLapDelta } from "./hud/useLapDelta";

interface F1TelemetryHudProps {
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
  p2pStatus?: P2PConnectionStatus;
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
}

/** Normalises a ?room= invite link value to the bare room code, or null when it is not one */
export function roomFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("room");
  const code = raw?.trim().replace(/^RWA-/i, "").toUpperCase().slice(0, 6) ?? "";
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
 * Race HUD in the style of the official F1 games: timing top-left, start lights and
 * notifications top-centre, map top-right, tyres bottom-left, speed cluster bottom-right.
 * Escape opens the full-screen pause menu.
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
  const deltaS = useLapDelta(telemetry, track.totalLength);
  const race = telemetry.race;
  const f12026 = telemetry.f12026;
  const drsNotice = useDrsDetectionNotice(f12026?.drsDetection ?? null);

  const cycleCamera = useCallback(() => {
    onChangeCameraMode(nextCameraMode(cameraMode));
  }, [cameraMode, onChangeCameraMode]);

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

  return (
    <div className="pointer-events-none fixed inset-0 z-20 select-none p-3 sm:p-4">
      {/* Top-left: timing tower (race) and lap timing */}
      <div className="absolute top-3 left-3 flex flex-col gap-2 sm:top-4 sm:left-4">
        {race ? <TimingTower race={race} /> : null}
        <LapPanel telemetry={telemetry} deltaS={deltaS} />
      </div>

      {/* Top-centre: start lights and notifications */}
      <div className="absolute top-4 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
        <StartLights race={race} />
        {telemetry.offTrack && !lightsPhase ? (
          <div className="hud-slant bg-[#E10600] px-5 py-1.5 font-f1-italic text-sm uppercase tracking-wider text-white shadow-xl">
            Track limits · lap invalid
          </div>
        ) : null}
        {drsNotice ? (
          <div
            className="hud-slant px-5 py-1.5 font-f1-italic text-sm uppercase tracking-wider shadow-xl"
            style={{
              backgroundColor: drsNotice.eligible ? "#00D26A" : "rgba(12,12,18,0.85)",
              color: drsNotice.eligible ? "#0B0B10" : "#fff",
            }}
          >
            {drsNotice.eligible ? "DRS enabled" : "DRS not enabled"} · {drsNotice.zone}
          </div>
        ) : null}
        {showLaunchHint && !race ? (
          <div className="hud-panel rounded px-4 py-1.5 font-f1-italic text-xs uppercase tracking-wider text-white">
            {launchHintText}
          </div>
        ) : null}
        {props.wheelUncalibrated && !race ? (
          <button
            type="button"
            onClick={() => props.onOpenControls?.()}
            className="pointer-events-auto cursor-pointer rounded border border-[#FFD700]/60 bg-[#0B0B10]/90 px-3 py-1 font-f1-mono text-[11px] font-bold uppercase text-[#FFD700] hover:bg-[#FFD700]/15"
          >
            Pedals not set up · click to calibrate throttle &amp; brake
          </button>
        ) : null}
        {lightsPhase ? (
          <div className="hud-panel rounded px-4 py-1.5 font-f1-italic text-xs uppercase tracking-wider text-white">
            Hold the throttle · go when the lights go out
          </div>
        ) : null}
        {mouseSteerEnabled ? (
          <div className="hud-panel flex flex-col items-center gap-1 rounded px-3 py-1.5">
            <span className="hud-label !text-[#00D26A]">Mouse steering · V to exit</span>
            <span className="relative h-2 w-44 overflow-hidden rounded bg-zinc-900">
              <span className="absolute inset-y-0 left-1/2 w-0.5 bg-white/40" />
              <span
                className="absolute inset-y-0 w-2.5 -translate-x-1/2 rounded bg-[#00D26A]"
                style={{ left: `${50 + telemetry.steering * 48}%` }}
              />
            </span>
          </div>
        ) : null}
      </div>

      {/* Top-right: circuit map, and on touch screens (no Esc key) a button for the pause menu */}
      <div className="pointer-events-auto absolute top-3 right-3 flex flex-col items-end gap-2 sm:top-4 sm:right-4">
        <button
          type="button"
          onClick={props.onTogglePause}
          className="hud-panel hidden cursor-pointer rounded px-4 py-2 font-f1-italic text-sm uppercase tracking-wider text-white pointer-coarse:block"
        >
          Menu
        </button>
        <div className="hidden md:block">
          <TrackMinimap track={track} telemetry={telemetry} onSelectTurn={props.onSelectTurn} />
        </div>
      </div>

      {/* Bottom-left: tyres and key hints */}
      <div className="absolute bottom-3 left-3 flex flex-col items-start gap-2 sm:bottom-4 sm:left-4">
        <TyrePanel telemetry={telemetry} compound={tireCompound} />
        <div className="hidden gap-1.5 font-f1-mono text-[11px] font-bold text-white/70 sm:flex">
          {[
            ["ESC", "Menu"],
            [props.keyNames?.camera ?? "C", "Camera"],
            [props.keyNames?.racingLine ?? "R", "Line"],
            [props.keyNames?.restart ?? "⌫", "Restart"],
          ].map(([k, label]) => (
            <span key={k} className="hud-panel flex items-center gap-1.5 rounded px-2 py-1">
              <span className="rounded bg-white/90 px-1 text-[#111]">{k}</span>
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Bottom-right: f12026-car channels (when driving it) and the speed cluster */}
      <div className="absolute right-3 bottom-3 flex flex-col items-end gap-2 sm:right-4 sm:bottom-4">
        {f12026 ? (
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
    </div>
  );
};
