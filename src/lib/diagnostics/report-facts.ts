import { pageBuild } from "@/lib/build-id";
import { isInstalledApp } from "@/lib/install-app";
import { connectedPads, isLikelyWheel, padDisplayName } from "@/lib/input/device-input";
import { dualSenseHid } from "@/lib/input/webhid-dualsense";
import { webHidFfb, wheelFfb } from "@/lib/input/wheel-ffb";
import { queuedBoardMisses } from "@/lib/net/leaderboard";
import type { BoardState } from "@/lib/net/online-config";
import { drivingFrameSummary, drivingInputUsed } from "@/lib/render/frame-stats";
import type { PlayerSettings } from "@/lib/settings/player-settings";
import { hudLayout } from "@/lib/settings/hud-layouts";
import { isLapInput, PHYSICS_VERSION, type LapInput } from "@/lib/sim/lap-types";
import { isStoreBuild } from "@/lib/store-mode";
import { getActiveTimedLengthM, TURN_METADATA } from "@/lib/track-data";
import type { CarTelemetry } from "@/types/f1";
import {
  appChannel,
  boardLine,
  deviceLine,
  nearestTurn,
  turnLabel,
  type DriveFacts,
  type ReportFacts,
} from "./report-details";
import { inEnglish } from "@/lib/text";

/*
 * The game's side of a bug report: what it knows at the moment the report opens, read once. The wording is
 * report-details.ts's.
 */

const INPUT_NAMES: Record<LapInput, string> = {
  keyboard: "Keyboard",
  controller: "Controller",
  wheel: "Wheel",
  touch: "Touch screen",
};

/** The water on the racing line as the HUD's surface badge grades it (WeatherBadge.tsx) */
const surfaceOf = (waterMm: number) => (waterMm < 0.03 ? "dry" : waterMm < 0.14 ? "damp" : waterMm < 1.1 ? "wet" : "flooded");

/** The pads and wheels the browser sees, and what drives the force feedback */
function devicesLine(settings: PlayerSettings): string | null {
  const names = connectedPads().map((p) => `${padDisplayName(p.id)}${isLikelyWheel(p) ? " (wheel)" : ""}`);
  const hid = webHidFfb.status;
  if (hid.state === "ready" && hid.device) names.push(`force feedback over WebHID: ${hid.device}`);
  const bridge = wheelFfb.getStatus();
  if (settings.wheel.ffbEnabled && !(hid.state === "ready") && bridge.connection === "connected")
    names.push(`force feedback bridge${bridge.device ? `: ${bridge.device}` : ""}`);
  const ds = dualSenseHid.getStatus();
  if (ds.state === "connected" && ds.name) names.push(`${ds.name} over WebHID${ds.transport ? ` (${ds.transport})` : ""}`);
  return names.length ? [...new Set(names)].join(", ") : null;
}

/** The assist presets and realism levels as the settings name them */
const ASSISTS: Record<PlayerSettings["assistPreset"], string> = { pro: "no assists", semi_pro: "TC + ABS", assisted: "full assists" };
const REALISM: Record<PlayerSettings["realism"], string> = { casual: "Casual", standard: "Standard", full: "Full" };

/** Assists, realism, gearbox, line, frame cap, automatic quality, HUD and force feedback, in one line */
function settingsLine(s: PlayerSettings): string {
  const g = s.graphics;
  const parts = [
    ASSISTS[s.assistPreset] ?? s.assistPreset,
    `realism ${REALISM[s.realism] ?? s.realism}`,
    `${s.autoGearbox ? "automatic" : "manual"} gearbox`,
    `racing line ${s.racingLine ? "on" : "off"}`,
    g.fpsCap ? `${g.fpsCap} fps cap` : "no fps cap",
    g.autoQuality ? `auto quality on (lowest ${Math.round(g.autoQualityMinScale * 100)}%)` : "auto quality off",
    `HUD ${hudLayout(s.hud.preset).label}`,
  ];
  if (s.device === "wheel") parts.push(`force feedback ${s.wheel.ffbEnabled ? (s.wheel.hidFfb ? "WebHID" : "bridge") : "off"}`);
  return parts.join(", ");
}

export interface ReportFactsInput {
  settings: PlayerSettings;
  /** The on-screen controls are showing */
  touchVisible: boolean;
  /** The input the last lap of this page was driven with */
  lastLapInput: LapInput | null;
  boardState: BoardState | null;
  /** From the pause menu: the car's state at the moment the report opened */
  drive: {
    telemetry: CarTelemetry;
    /** "Practice", "Race against AI"… */
    mode: string;
    replay: boolean;
    waterMm: number;
  } | null;
}

/** Everything a report adds, read now */
export function collectReportFacts(i: ReportFactsInput): ReportFacts {
  const setUp: LapInput = i.settings.device === "keyboard" && i.touchVisible ? "touch" : i.settings.device;
  // What drove the car: the last minute of driving, else the last lap's, else only what is set up
  const used = drivingInputUsed();
  const driven: [LapInput, string] | null = isLapInput(used) ? [used, "driven"] : i.lastLapInput ? [i.lastLapInput, "last lap"] : null;
  const input = driven
    ? `${INPUT_NAMES[driven[0]]} (${driven[1]})${driven[0] !== setUp ? `, ${INPUT_NAMES[setUp]} set up` : ""}`
    : `${INPUT_NAMES[setUp]} (set up)`;
  let drive: DriveFacts | null = null;
  if (i.drive) {
    const t = i.drive.telemetry;
    const lengthM = getActiveTimedLengthM();
    const turn = nearestTurn(TURN_METADATA, t.trackDistanceM, lengthM);
    drive = {
      mode: i.drive.mode,
      lap: Math.max(1, t.race?.lap ?? t.lapCount),
      totalLaps: t.race?.totalLaps ?? null,
      distanceM: t.trackDistanceM,
      lengthM,
      turn: turn ? turnLabel(turn) : null,
      speedKmh: t.speedKmh,
      surface: surfaceOf(i.drive.waterMm),
      replay: i.drive.replay,
    };
  }
  const nav = typeof navigator === "undefined" ? null : (navigator as Navigator & { deviceMemory?: number });
  let waiting = 0;
  try {
    waiting = queuedBoardMisses().length;
  } catch {
    // Storage blocked: nothing can be waiting either
  }
  return {
    build: pageBuild(),
    physicsVersion: PHYSICS_VERSION,
    app: appChannel({ userAgent: nav?.userAgent ?? "", storeBuild: isStoreBuild(), installed: isInstalledApp() }),
    device: deviceLine(nav?.hardwareConcurrency, nav?.deviceMemory),
    input,
    devices: devicesLine(i.settings),
    frames: drivingFrameSummary(),
    // The HUD's name comes from the layouts' labels, which follow the language: the report keeps them English
    settings: inEnglish(() => settingsLine(i.settings)),
    board: boardLine(i.boardState, waiting),
    drive,
    driver: i.settings.profile.name ? `${i.settings.profile.name} (${i.settings.profile.code})` : null,
  };
}
