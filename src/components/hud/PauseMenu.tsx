"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
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
import { ACTIVE_TRACK_ID, LIVERIES, TRACK_TOTAL_LENGTH_M, TURN_METADATA } from "@/lib/track-data";
import { getTrackInfo } from "@/lib/track-registry";
import { COCKPIT_FOV_MAX_DEG, COCKPIT_FOV_MIN_DEG } from "@/lib/settings/player-settings";
import { MultiplayerPanel, type MultiplayerPanelProps } from "./MultiplayerPanel";
import { DisplayPanel, type DisplayPanelProps } from "./DisplayPanel";
import { LeaderboardPanel, type LeaderboardPanelProps } from "./LeaderboardPanel";
import { focusInZone, focusZone, useFocusNav } from "@/components/menu/useFocusNav";
import { PromptBar, RailItem, TabStrip } from "@/components/menu/menu-ui";
import {
  CornerDownRight,
  Gamepad2,
  Gauge,
  LogOut,
  MonitorCog,
  Pause,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Timer,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";

export const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: "Chase",
  tv_pod: "T-cam",
  cockpit_shoulder: "Shoulder",
  cockpit: "Cockpit",
  nose: "Nose",
  helicopter: "Helicopter",
  tv_side: "Trackside TV",
};

/** Views the C key (and the pause menu's camera button) cycles through */
export const CAMERA_CYCLE: readonly CameraMode[] = ["cockpit", "tv_pod", "chase", "tv_side"];

/** The view after `mode` in the C-key cycle (views outside the cycle return to its start) */
export function nextCameraMode(mode: CameraMode): CameraMode {
  return CAMERA_CYCLE[(CAMERA_CYCLE.indexOf(mode) + 1) % CAMERA_CYCLE.length];
}

interface SliderLimits {
  min: number;
  max: number;
  step: number;
}
export interface TyreSetupLimits {
  pressurePsi: SliderLimits;
  camberFrontDeg: SliderLimits;
  camberRearDeg: SliderLimits;
}

const F1_TYRE_SETUP_LIMITS: TyreSetupLimits = {
  pressurePsi: { min: 17, max: 27, step: 0.5 },
  camberFrontDeg: { min: -4.5, max: -1.5, step: 0.1 },
  camberRearDeg: { min: -3, max: -0.5, step: 0.1 },
};

/**
 * Slider ranges for the tyre setup per car, shared with the simulator's validation of saved setups
 */
export const TYRE_SETUP_LIMITS: Record<VehicleModelId, TyreSetupLimits> = {
  vf26: F1_TYRE_SETUP_LIMITS,
  "f12026-car": F1_TYRE_SETUP_LIMITS,
  "amg-gt3": {
    pressurePsi: { min: 15, max: 30, step: 0.5 },
    camberFrontDeg: { min: -4, max: 0, step: 0.1 },
    camberRearDeg: { min: -3, max: 0.5, step: 0.1 },
  },
};

/** The cars in the picker (pause menu and the setup flow) */
export const VEHICLE_CHOICES: {
  id: VehicleModelId;
  title: string;
  sub: string;
  badge: string;
  badgeColor: string;
}[] = [
  {
    id: "vf26",
    title: "FA-26 Prototype",
    sub: "Curvilinear 2026 model · active aero",
    badge: "FA-26",
    badgeColor: "#CCFF00",
  },
  {
    id: "f12026-car",
    title: "FA-26 Rigid-Body",
    sub: "6-DOF rigid-body · track colliders · DRS",
    badge: "6-DOF",
    badgeColor: "#CCFF00",
  },
  {
    id: "amg-gt3",
    title: "Mercedes-AMG GT3",
    sub: "GT3 Pro · 6.2L V8 · Multi-stage ABS / TC",
    badge: "GT3 PRO",
    badgeColor: "#00E5FF",
  },
];

export interface PauseMenuProps extends MultiplayerPanelProps {
  telemetry: CarTelemetry;
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
  gamepadRumble: boolean;
  aiOpponents: boolean;
  vehicleModel: VehicleModelId;
  onChangeVehicle: (vehicle: VehicleModelId) => void;
  openMultiplayer?: boolean;
  onToggleAiOpponents: () => void;
  onToggleGamepadAssist?: () => void;
  onToggleGamepadRumble: () => void;
  onChangeAeroPreset: (preset: AeroSetupPreset) => void;
  onChangeAssistPreset: (preset: DriverAssistPreset) => void;
  onCycleCamera: () => void;
  onChangeTireCompound: (compound: TireCompound) => void;
  onChangeTyreSetup: (setup: TyreSetup) => void;
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
  /** Leaves the session for the title menu */
  onExitToTitle?: () => void;
  /** Rows of the controls cheat-sheet, from the player's bindings */
  controlsCheatSheet?: readonly (readonly [string, string])[];
  /** Key names for the hints on the toggles (defaults: the original layout) */
  keyNames?: Partial<Record<"camera" | "racingLine" | "mute" | "mouseSteer" | "autopilot" | "restart", string>>;
  /** HUD layout, graphics, touch controls and VR */
  displayPanel?: DisplayPanelProps;
  /** Lap times, ghosts and the online board */
  leaderboardPanel?: LeaderboardPanelProps;
}

type Panel = "settings" | "setup" | "corners" | "multiplayer" | "display" | "leaderboard";

export const Toggle: React.FC<{
  label: string;
  detail?: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}> = ({ label, detail, checked, onChange, disabled }) => (
  <label
    className={`flex items-center justify-between gap-4 rounded px-1.5 py-1.5 transition-colors ${
      disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-white/5"
    }`}
  >
    <span>
      <span className="block font-f1-italic text-[15px] text-[#F5F7FA] uppercase">{label}</span>
      {detail ? <span className="block font-f1-mono text-[11px] text-[#8E96AA]">{detail}</span> : null}
    </span>
    <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="peer sr-only" />
    <span
      aria-hidden
      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-[#CCFF00] ${
        checked ? "border-[#CCFF00] bg-[#CCFF00]" : "border-[#262B3D] bg-[#08090D]"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4.5 w-4.5 rounded-full transition-transform ${
          checked ? "translate-x-[22px] bg-[#08090D]" : "translate-x-0.5 bg-[#8E96AA]"
        }`}
      />
    </span>
  </label>
);

export const TyreSlider: React.FC<{
  label: string;
  value: number;
  limits: { min: number; max: number; step: number };
  format: (value: number) => string;
  onChange: (value: number) => void;
}> = ({ label, value, limits, format, onChange }) => (
  <label className="block rounded px-1.5 py-1.5 hover:bg-white/5">
    <span className="flex items-center justify-between gap-3">
      <span className="font-f1-italic text-[15px] text-[#F5F7FA] uppercase">{label}</span>
      <span className="font-f1-mono text-sm font-bold text-[#CCFF00] tabular-nums">{format(value)}</span>
    </span>
    <input
      type="range"
      min={limits.min}
      max={limits.max}
      step={limits.step}
      value={value}
      onChange={(e) => onChange(Number((Math.round(Number(e.target.value) / limits.step) * limits.step).toFixed(1)))}
      className="mt-1 w-full cursor-pointer accent-[#CCFF00]"
    />
  </label>
);

const formatPsi = (value: number) => `${value.toFixed(1)} psi`;
const formatCamber = (value: number) => `${value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)}°`;

export const Choice: React.FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`min-h-[44px] cursor-pointer rounded border px-2.5 py-2 text-left transition-all ${
      active
        ? "border-[#CCFF00] bg-[#CCFF00]/15 text-[#F5F7FA] shadow-[inset_0_0_12px_rgba(204,255,0,0.12)]"
        : "border-[#262B3D] bg-[#08090D]/80 text-[#8E96AA] hover:border-[#8E96AA]/40 hover:bg-[#1B1F2B] hover:text-[#F5F7FA]"
    }`}
  >
    {children}
  </button>
);

/**
 * Esc / Menu: race actions in a rail on the left, the session's panels as tabs on the right.
 * A controller reaches every control; LB / RB switch tabs, Ⓑ steps back (panel → tabs → rail →
 * resume) and Menu resumes from anywhere.
 */
export const PauseMenu: React.FC<PauseMenuProps> = (props) => {
  const { telemetry, onTogglePause, onResetCar, aiOpponents, onOpenControls, onExitToTitle, displayPanel, leaderboardPanel } = props;
  // In a multiplayer race only the host restarts it (for everyone); there is no flying lap
  const mpRace = telemetry.race?.multiplayer === true;
  const canRestart = !mpRace || props.isHost === true;
  const [panel, setPanel] = useState<Panel>(props.openMultiplayer ? "multiplayer" : "settings");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const trackInfo = getTrackInfo(ACTIVE_TRACK_ID);

  const tabs = useMemo(
    () =>
      [
        { id: "settings" as const, label: "Session", icon: SlidersHorizontal },
        { id: "setup" as const, label: "Car setup", icon: Wrench },
        { id: "corners" as const, label: "Corners", icon: CornerDownRight },
        { id: "multiplayer" as const, label: "Multiplayer", icon: Users },
        ...(leaderboardPanel ? [{ id: "leaderboard" as const, label: "Lap times", icon: Timer }] : []),
        ...(displayPanel ? [{ id: "display" as const, label: "Display", icon: MonitorCog }] : []),
      ] satisfies { id: Panel; label: string; icon: LucideIcon }[],
    [leaderboardPanel, displayPanel]
  );

  const actions = useMemo(
    () => [
      { id: "resume", label: "Resume", detail: "Back on track", icon: Play, primary: true, run: () => onTogglePause() },
      ...(canRestart
        ? [
            {
              id: "grid",
              label: aiOpponents || mpRace ? "Restart race" : "Grid start",
              detail: mpRace
                ? "Everyone back to the grid behind the lights"
                : aiOpponents
                  ? "Line up on the grid behind the lights"
                  : "Standing start from the grid",
              icon: RotateCcw,
              run: () => {
                onResetCar(false);
                onTogglePause();
              },
            },
          ]
        : []),
      ...(!mpRace
        ? [
            {
              id: "flying",
              label: aiOpponents ? "Rolling start" : "Flying lap",
              detail: aiOpponents ? "Restart the race on the move" : "Timed lap from the main straight",
              icon: Gauge,
              run: () => {
                onResetCar(true);
                onTogglePause();
              },
            },
          ]
        : []),
      ...(onOpenControls
        ? [{ id: "controls", label: "Controls", detail: "Keys, controller, wheel calibration", icon: Gamepad2, run: onOpenControls }]
        : []),
      ...(onExitToTitle ? [{ id: "title", label: "Main menu", detail: "Leave the session", icon: LogOut, run: onExitToTitle }] : []),
    ],
    [aiOpponents, mpRace, canRestart, onResetCar, onTogglePause, onOpenControls, onExitToTitle]
  );

  const focusActiveTab = () =>
    rootRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });

  const selectTab = useCallback((next: Panel) => {
    setPanel(next);
    // Below lg the panel sits under the rail: bring it into view
    if (!window.matchMedia("(min-width: 64rem)").matches) {
      requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: "start" }));
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
  // Esc is the simulator's pause toggle; Ⓑ steps back, Menu resumes
  useFocusNav(rootRef, {
    onBack: back,
    onStart: onTogglePause,
    onPrevTab: () => cycle(-1),
    onNextTab: () => cycle(1),
    keyboardBack: false,
  });

  const race = telemetry.race;

  return (
    <div
      ref={rootRef}
      className="pointer-events-auto fixed inset-0 z-40 flex flex-col overflow-y-auto bg-[#08090D]/88 px-5 pt-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] backdrop-blur-md sm:px-10 short:pt-3"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#262B3D] pb-4">
          <div>
            <div className="flex items-center gap-2 font-f1-mono text-xs font-black tracking-[0.22em] text-[#CCFF00]">
              <Pause aria-hidden className="h-3.5 w-3.5" strokeWidth={3} />
              PAUSED
            </div>
            <h1 className="mt-1 font-f1-italic text-3xl leading-none tracking-wide text-[#F5F7FA] uppercase sm:text-5xl">
              {trackInfo.name}
            </h1>
            <div className="mt-2 flex flex-wrap gap-1.5 font-f1-mono text-[11px] font-bold tracking-wide uppercase">
              <span className="rounded border border-[#262B3D] bg-[#11131A] px-2 py-0.5 text-[#8E96AA]">
                {trackInfo.city}, {trackInfo.country}
              </span>
              <span className="rounded border border-[#262B3D] bg-[#11131A] px-2 py-0.5 text-[#F5F7FA]">
                Lap {Math.max(1, race?.lap ?? telemetry.lapCount)}
                {race?.totalLaps ? ` / ${race.totalLaps}` : ""}
              </span>
              {race ? (
                <span className="rounded bg-[#CCFF00] px-2 py-0.5 text-[#08090D]">
                  P{race.position} of {race.fieldSize}
                </span>
              ) : null}
              {mpRace ? <span className="rounded bg-[#00E5FF] px-2 py-0.5 text-[#08090D]">Online race</span> : null}
            </div>
          </div>
          <LibreCorsaLogo variant="compact" />
        </div>

        <div className="mt-5 grid flex-1 grid-cols-1 gap-5 lg:grid-cols-[minmax(240px,280px)_1fr] short:mt-3">
          <nav className="flex flex-col gap-1.5" data-nav-zone="rail" aria-label="Pause menu">
            {actions.map((a) => (
              <RailItem
                key={a.id}
                navId={a.id}
                label={a.label}
                detail={a.detail}
                icon={a.icon}
                primary={"primary" in a ? a.primary : undefined}
                onClick={a.run}
              />
            ))}
          </nav>

          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            <TabStrip tabs={tabs} value={panel} onChange={selectTab} />
            <section ref={panelRef} className="min-h-0 scroll-mt-4" data-nav-zone="panel">
              <div key={panel} className="lc-panel-in">
                {panel === "settings" ? <SessionPanel {...props} /> : null}
                {panel === "setup" ? <SetupPanel {...props} /> : null}
                {panel === "corners" ? (
                  <CornersPanel
                    onSelect={(n) => {
                      props.onSelectTurn(n);
                      onTogglePause();
                    }}
                  />
                ) : null}
                {panel === "multiplayer" ? <MultiplayerPanel {...props} /> : null}
                {panel === "display" && displayPanel ? <DisplayPanel {...displayPanel} /> : null}
                {panel === "leaderboard" && leaderboardPanel ? <LeaderboardPanel {...leaderboardPanel} /> : null}
              </div>
            </section>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[#262B3D] pt-3">
          <PromptBar
            prompts={[
              { action: "move", label: "Move" },
              { action: "select", label: "Select" },
              { action: "tabs", label: "Tabs" },
              { action: "back", label: "Back", key: "⌫" },
              { action: "start", label: "Resume", key: "Esc" },
            ]}
          />
          <span className="hidden font-f1-mono text-[11px] font-bold tracking-wide text-[#8E96AA] md:inline">
            {(TRACK_TOTAL_LENGTH_M / 1000).toFixed(2)} KM · {TURN_METADATA.length} TURNS · LIBRECORSA
          </span>
        </div>
      </div>
    </div>
  );
};

export const SessionPanel: React.FC<PauseMenuProps> = (p) => {
  const k = {
    camera: "C",
    racingLine: "R",
    mute: "M",
    mouseSteer: "V",
    autopilot: "P",
    ...p.keyNames,
  };
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="f1-panel f1-corner-tr rounded-lg border border-[#262B3D] bg-[#11131A] p-4 text-[#F5F7FA]">
        <div className="mb-2.5 flex items-center gap-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-[#8E96AA]">
          <span className="h-2.5 w-1 rounded-full bg-[#CCFF00]" />
          SESSION
        </div>
        <Toggle
          label="AI opponents"
          detail="Race 5 AI cars from a standing start"
          checked={p.aiOpponents}
          onChange={p.onToggleAiOpponents}
        />
        <Toggle
          label="Racing line"
          detail={`Braking-aware line on the track (${k.racingLine})`}
          checked={p.showRacingLine}
          onChange={p.onToggleRacingLine}
        />
        <Toggle label="Engine sound" detail={k.mute} checked={!p.isMuted} onChange={p.onToggleMute} />
        <Toggle
          label="Gamepad steering assist"
          detail="Stick steers up to the front-tyre grip limit"
          checked={p.gamepadAssist}
          onChange={() => p.onToggleGamepadAssist?.()}
        />
        <Toggle
          label="Gamepad rumble"
          detail="Kerbs, lock-up, wheelspin and grass through the pad"
          checked={p.gamepadRumble}
          onChange={p.onToggleGamepadRumble}
        />
        <Toggle
          label="Mouse steering"
          detail={k.mouseSteer}
          checked={p.mouseSteerEnabled}
          onChange={() => p.onToggleMouseSteer?.()}
        />
        <Toggle
          label="Autopilot"
          detail={`The AI drives your car (${k.autopilot})`}
          checked={p.telemetry.aiAutopilot}
          onChange={p.onToggleAiAutopilot}
        />
        <div className="mt-2 flex items-center justify-between px-1.5">
          <span className="font-f1-italic text-[15px] uppercase">Camera</span>
          <button
            type="button"
            onClick={p.onCycleCamera}
            className="cursor-pointer rounded border border-[#262B3D] bg-[#08090D] px-3 py-1.5 font-f1-mono text-xs font-bold text-[#CCFF00] uppercase hover:border-[#CCFF00]"
          >
            {CAMERA_LABELS[p.cameraMode]} · {k.camera}
          </button>
        </div>
        {p.onChangeCockpitFov ? (
          <div className="mt-1">
            <TyreSlider
              label="Cockpit FOV · [ ]"
              value={p.cockpitFovDeg ?? p.cockpitFovDefaultDeg ?? 60}
              limits={{ min: COCKPIT_FOV_MIN_DEG, max: COCKPIT_FOV_MAX_DEG, step: 1 }}
              format={(v) => (p.cockpitFovDeg == null ? `${v}° · car` : `${v}°`)}
              onChange={p.onChangeCockpitFov}
            />
            {p.cockpitFovDeg != null ? (
              <button
                type="button"
                onClick={() => p.onChangeCockpitFov?.(null)}
                className="cursor-pointer px-1.5 font-f1-mono text-[11px] font-bold text-[#8E96AA] uppercase hover:text-[#CCFF00]"
              >
                Car default{p.cockpitFovDefaultDeg ? ` (${p.cockpitFovDefaultDeg}°)` : ""}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="f1-panel f1-corner-tr rounded-lg border border-[#262B3D] bg-[#11131A] p-4 text-[#F5F7FA]">
        <div className="mb-2.5 flex items-center gap-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-[#8E96AA]">
          <span className="h-2.5 w-1 rounded-full bg-[#00E5FF]" />
          CONTROLS
        </div>
        <div className="flex flex-col gap-2 font-f1-mono text-[13px]">
          {(
            p.controlsCheatSheet ?? [
              ["Throttle / brake", "W S · ↑ ↓"],
              ["Steer", "A D · ← →"],
              ["Boost (manual override)", "Space · B"],
              ["Active aero X / Z", "X"],
              ["Gear up / down", "E / Q"],
              ["Camera", "C"],
              ["Cockpit FOV", "[ / ]"],
              ["Racing line", "R"],
              ["Restart", "Backspace"],
              ["Pad", "RT / LT · stick · A boost"],
            ]
          ).map(([label, keys]) => (
            <div key={label} className="flex items-center justify-between gap-3 border-b border-[#262B3D]/60 pb-1.5">
              <span className="text-[#8E96AA]">{label}</span>
              <span className="font-bold text-[#F5F7FA]">{keys}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export const SetupPanel: React.FC<PauseMenuProps> = (p) => {
  const limits = TYRE_SETUP_LIMITS[p.vehicleModel];
  return (
    <div className="f1-panel f1-corner-tr rounded-lg border border-[#262B3D] bg-[#11131A] p-4 text-[#F5F7FA]">
      <div className="mb-2 flex items-center gap-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-[#8E96AA]">
        <span className="h-2.5 w-1 rounded-full bg-[#CCFF00]" />
        VEHICLE CLASS &amp; CHASSIS
      </div>
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {VEHICLE_CHOICES.map((car) => (
          <Choice key={car.id} active={p.vehicleModel === car.id} onClick={() => p.onChangeVehicle(car.id)}>
            <div className="mb-1 flex items-center justify-between">
              <span className="font-f1-italic text-sm text-[#F5F7FA] uppercase">{car.title}</span>
              <span
                className="rounded-sm px-1.5 py-0.5 font-f1-display text-[8px] font-black italic"
                style={{ backgroundColor: car.badgeColor, color: "#08090D" }}
              >
                {car.badge}
              </span>
            </div>
            <div className="font-f1-mono text-[11px] opacity-80">{car.sub}</div>
          </Choice>
        ))}
      </div>

      <div className="mb-2 flex items-center gap-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-[#8E96AA]">
        <span className="h-2.5 w-1 rounded-full bg-[#00E5FF]" />
        AERO PACKAGE
      </div>
      <div className="grid grid-cols-3 gap-2">
        {(
          [
            { id: "low_downforce", title: "Low downforce", sub: "Top speed" },
            { id: "balanced", title: "Balanced", sub: "Reference setup" },
            {
              id: "high_downforce",
              title: "High downforce",
              sub: "Corner grip",
            },
          ] as const
        ).map((item) => (
          <Choice key={item.id} active={p.aeroPreset === item.id} onClick={() => p.onChangeAeroPreset(item.id)}>
            <div className="font-f1-italic text-sm text-[#F5F7FA] uppercase">{item.title}</div>
            <div className="font-f1-mono text-[11px] opacity-80">{item.sub}</div>
          </Choice>
        ))}
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-[#8E96AA]">TYRES</div>
          <div className="grid grid-cols-3 gap-2">
            {(["soft", "medium", "hard"] as const).map((c) => (
              <Choice key={c} active={p.tireCompound === c} onClick={() => p.onChangeTireCompound(c)}>
                <div className="text-center font-f1-italic text-sm text-[#F5F7FA] uppercase">{c}</div>
              </Choice>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-[#8E96AA]">TRACTION &amp; ABS</div>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { id: "pro", label: "Off" },
                { id: "semi_pro", label: "TC + ABS" },
                { id: "assisted", label: "Full" },
              ] as const
            ).map((a) => (
              <Choice key={a.id} active={p.assistPreset === a.id} onClick={() => p.onChangeAssistPreset(a.id)}>
                <div className="text-center font-f1-italic text-sm text-[#F5F7FA] uppercase">{a.label}</div>
              </Choice>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-f1-mono text-[11px] font-bold tracking-[0.16em] text-[#8E96AA]">
            TYRES · PRESSURE &amp; CAMBER
          </span>
          <button
            type="button"
            onClick={() => p.onChangeTyreSetup(p.defaultTyreSetup)}
            className="cursor-pointer rounded border border-[#262B3D] bg-[#08090D] px-2.5 py-1 font-f1-mono text-[11px] font-bold text-[#8E96AA] uppercase hover:border-[#CCFF00] hover:text-[#CCFF00]"
          >
            Reset
          </button>
        </div>
        <div className="grid gap-x-4 md:grid-cols-2">
          <TyreSlider
            label="Front cold pressure"
            value={p.tyreSetup.coldPressurePsi.front}
            limits={limits.pressurePsi}
            format={formatPsi}
            onChange={(v) =>
              p.onChangeTyreSetup({
                ...p.tyreSetup,
                coldPressurePsi: { ...p.tyreSetup.coldPressurePsi, front: v },
              })
            }
          />
          <TyreSlider
            label="Rear cold pressure"
            value={p.tyreSetup.coldPressurePsi.rear}
            limits={limits.pressurePsi}
            format={formatPsi}
            onChange={(v) =>
              p.onChangeTyreSetup({
                ...p.tyreSetup,
                coldPressurePsi: { ...p.tyreSetup.coldPressurePsi, rear: v },
              })
            }
          />
          <TyreSlider
            label="Front camber"
            value={p.tyreSetup.camberDeg.front}
            limits={limits.camberFrontDeg}
            format={formatCamber}
            onChange={(v) =>
              p.onChangeTyreSetup({
                ...p.tyreSetup,
                camberDeg: { ...p.tyreSetup.camberDeg, front: v },
              })
            }
          />
          <TyreSlider
            label="Rear camber"
            value={p.tyreSetup.camberDeg.rear}
            limits={limits.camberRearDeg}
            format={formatCamber}
            onChange={(v) =>
              p.onChangeTyreSetup({
                ...p.tyreSetup,
                camberDeg: { ...p.tyreSetup.camberDeg, rear: v },
              })
            }
          />
        </div>
        <p className="mt-1 font-f1-mono text-[11px] text-[#8E96AA]">
          Read the tread temps on the tyre panel: inner hotter than outer by 5–10 °C is ideal.
        </p>
      </div>

      <div className="mt-4 mb-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-[#8E96AA]">LIVERY</div>
      <div className="grid grid-cols-5 gap-2">
        {LIVERIES.map((liv) => (
          <Choice key={liv.id} active={p.selectedLivery.id === liv.id} onClick={() => p.onChangeLivery(liv)}>
            <span
              className="mb-1 block h-3 w-full rounded-sm"
              style={{
                background: `linear-gradient(90deg, ${liv.primary} 50%, ${liv.secondary} 50%)`,
              }}
            />
            <span className="block text-center font-f1-mono text-xs font-bold text-[#F5F7FA]">#{liv.number}</span>
          </Choice>
        ))}
      </div>
    </div>
  );
};

const CornersPanel: React.FC<{ onSelect: (turn: number) => void }> = ({ onSelect }) => (
  <div className="f1-panel f1-corner-tr rounded-lg border border-[#262B3D] bg-[#11131A] p-4 text-[#F5F7FA]">
    <div className="mb-3 flex items-center gap-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-[#8E96AA]">
      <span className="h-2.5 w-1 rounded-full bg-[#CCFF00]" />
      JUMP TO A CORNER · APEX SPEED · GEAR
    </div>
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {TURN_METADATA.map((t) => (
        <button
          key={t.number}
          type="button"
          onClick={() => onSelect(t.number)}
          className="flex cursor-pointer items-center gap-3 rounded border border-[#262B3D] bg-[#08090D]/80 px-3 py-2 text-left transition-colors hover:border-[#CCFF00] hover:bg-[#1B1F2B]"
        >
          <span className="hud-num w-9 text-[20px] text-[#CCFF00]">T{t.number}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-f1-italic text-sm text-[#F5F7FA] uppercase">
              {t.name.replace(/^Turn \d+\s*[—-]\s*/, "")}
            </span>
            <span className="block truncate font-f1-mono text-[11px] text-[#8E96AA]">{t.complexName}</span>
          </span>
          <span className="hud-num text-[15px] text-[#F5F7FA]">{t.apexSpeedKmh}</span>
          <span className="hud-num w-6 text-right text-[15px] text-[#00E5FF]">{t.gear}</span>
        </button>
      ))}
    </div>
  </div>
);
