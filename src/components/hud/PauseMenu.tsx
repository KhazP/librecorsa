"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
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
import { ACTIVE_TRACK_ID, LIVERIES, TRACK_TOTAL_LENGTH_M, TURN_METADATA, getTrackData } from "@/lib/track-data";
import { getTrackInfo } from "@/lib/track-registry";
import type { ChassisSetup } from "@/lib/sim/car-setup";
import { EngineersGarage } from "@/components/menu/EngineersGarage";
import { COCKPIT_FOV_MAX_DEG, COCKPIT_FOV_MIN_DEG } from "@/lib/settings/player-settings";
import { MultiplayerPanel, type MultiplayerPanelProps } from "./MultiplayerPanel";
import { DisplayPanel, type DisplayPanelProps } from "./DisplayPanel";
import { LeaderboardPanel, type LeaderboardPanelProps } from "./LeaderboardPanel";
import { focusInZone, focusOnHover, focusZone, useFocusNav } from "@/components/menu/useFocusNav";
import { PromptBar, RailItem, TabStrip } from "@/components/menu/menu-ui";
import {
  ChevronRight,
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
  // The rigid-body car's own profile ranges (F12026CarSim clamps to these, so the sliders must not go further)
  "f12026-car": {
    pressurePsi: { min: 15, max: 25, step: 0.5 },
    camberFrontDeg: { min: -3.6, max: 0, step: 0.1 },
    camberRearDeg: { min: -2, max: 0, step: 0.1 },
  },
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
    className={`flex min-h-[44px] items-center justify-between gap-4 rounded-[14px] px-2 py-1.5 transition-colors ${
      disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-white/[0.04]"
    }`}
  >
    <span className="flex min-w-0 flex-col">
      <span className="text-[15px] leading-tight font-bold text-[#F5F7FA]">{label}</span>
      {detail ? <span className="text-[12px] leading-snug text-[#8E96AA]">{detail}</span> : null}
    </span>
    <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="peer sr-only" />
    <span
      aria-hidden
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-[#CCFF00] ${
        checked ? "bg-[#CCFF00]" : "bg-[#1B1F2B] shadow-[inset_0_0_0_1px_#262B3D]"
      }`}
    >
      <span
        className={`absolute top-1 left-1 h-5 w-5 rounded-full transition-transform duration-[220ms] ease-[cubic-bezier(.2,.8,.2,1)] ${
          checked ? "translate-x-5 bg-[#08090D]" : "translate-x-0 bg-[#8E96AA]"
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
  <label className="flex flex-col gap-2.5 rounded-[14px] px-2 py-2 hover:bg-white/[0.04]">
    <span className="flex items-center justify-between gap-3">
      <span className="min-w-0 truncate text-[14px] font-bold text-[#F5F7FA]" title={label}>
        {label}
      </span>
      <span className="shrink-0 font-f1-mono text-sm font-extrabold whitespace-nowrap text-[#CCFF00] tabular-nums">{format(value)}</span>
    </span>
    <input
      type="range"
      min={limits.min}
      max={limits.max}
      step={limits.step}
      value={value}
      onChange={(e) => onChange(Number((Math.round(Number(e.target.value) / limits.step) * limits.step).toFixed(1)))}
      className="lc-range"
      style={{ "--lc-fill": `${((value - limits.min) / (limits.max - limits.min || 1)) * 100}%` } as React.CSSProperties}
    />
  </label>
);

export const formatPsi = (value: number) => `${value.toFixed(1)} psi`;
export const formatCamber = (value: number) => `${value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)}°`;

/** Compounds in the garage's segmented row, with their sidewall ring colour */
export const COMPOUNDS: readonly { id: TireCompound; label: string; name: string; ring: string }[] = [
  { id: "soft", label: "Soft", name: "Soft tyres", ring: "#FF2A3C" },
  { id: "medium", label: "Med", name: "Medium tyres", ring: "#FFB300" },
  { id: "hard", label: "Hard", name: "Hard tyres", ring: "#F5F7FA" },
];

/** One option of a pill segmented row (aria-pressed, like Choice) */
const SEG_BTN =
  "inline-flex min-h-[44px] min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 rounded-full px-1.5 text-[13px] font-bold whitespace-nowrap transition-[background-color,color,box-shadow] duration-200";

export const Choice: React.FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`relative min-h-[44px] cursor-pointer rounded-[18px] px-4 py-3 text-left transition-[background-color,border-color,color] duration-200 ${
      active
        ? "border-[1.5px] border-[#CCFF00] bg-[#CCFF00]/[0.08] pr-10 text-[#F5F7FA]"
        : "border border-[#262B3D] bg-[#08090D]/50 text-[#C5CBD8] hover:border-[#3A4157] hover:bg-[#1B1F2B] hover:text-[#F5F7FA]"
    }`}
  >
    {children}
    {active ? (
      <span
        aria-hidden
        className="absolute top-3 right-3 inline-flex h-[22px] w-[22px] items-center justify-center rounded-full bg-[#CCFF00]"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#08090D" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
    ) : null}
  </button>
);

/** Pill status tag in the pause header (place, lap, online) */
const HEADER_CHIP =
  "inline-flex h-7 items-center rounded-full px-3 font-f1-mono text-[11px] font-extrabold tracking-[0.08em] whitespace-nowrap uppercase";

/** A card inside a pause panel: the frosted 24 px sheet of the Racing Line boards */
const PANEL_CARD =
  "flex flex-col gap-3 rounded-[24px] border border-white/[0.07] bg-[#0D0F15]/82 px-5 py-[18px] text-[#F5F7FA]";

/** Dot + tracked mono label heading a group of controls */
export const PanelSection: React.FC<{ children: React.ReactNode; color?: string; className?: string }> = ({
  children,
  color = "#CCFF00",
  className = "",
}) => (
  <div className={`flex items-center gap-2 ${className}`}>
    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
    <span className="lc-lbl">{children}</span>
  </div>
);

/**
 * The rail's main action (Resume): RailItem's behaviour (focus follows the pointer, the rail's
 * default focus, volt when focused) with the round play badge of the pause board.
 */
const PrimaryRailItem: React.FC<{
  label: string;
  detail?: string;
  icon: LucideIcon;
  onClick: () => void;
  navId: string;
}> = ({ label, detail, icon: Icon, onClick, navId }) => (
  <button
    type="button"
    data-rail-id={navId}
    data-nav-default=""
    onPointerEnter={focusOnHover}
    onClick={onClick}
    className="group relative mb-1 flex min-h-[76px] w-full cursor-pointer items-center gap-3.5 rounded-[22px] border-0 bg-[#CCFF00]/10 px-4 py-1.5 text-left text-[#F5F7FA] shadow-[inset_0_0_0_1.5px_rgba(204,255,0,0.5)] outline-none transition-[background-color,box-shadow,color] duration-[220ms] ease-[cubic-bezier(.2,.8,.2,1)] focus:bg-[#CCFF00] focus:text-[#08090D] focus:shadow-[0_0_0_6px_rgba(204,255,0,0.12),0_16px_40px_rgba(204,255,0,0.2)] focus-visible:outline-none short:min-h-[60px]"
  >
    <span
      aria-hidden
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#CCFF00] text-[#08090D] transition-colors duration-[220ms] group-focus:bg-[#08090D] group-focus:text-[#CCFF00] short:h-9 short:w-9"
    >
      <Icon className="h-[18px] w-[18px]" fill="currentColor" strokeWidth={0} />
    </span>
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="lc-disp text-[30px] short:text-[24px]">{label}</span>
      {detail ? (
        <span className="truncate text-[12px] text-[#C5CBD8] group-focus:font-semibold group-focus:text-[#08090D]/70">
          {detail}
        </span>
      ) : null}
    </span>
    <ChevronRight aria-hidden className="hidden h-[18px] w-[18px] shrink-0 group-focus:block" strokeWidth={2.6} />
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
      className="pointer-events-auto fixed inset-0 z-40 flex flex-col overflow-y-auto bg-[#08090D]/84 px-5 pt-[26px] pb-[max(1.125rem,env(safe-area-inset-bottom))] backdrop-blur-md sm:px-[clamp(20px,3.4vw,48px)] short:pt-3"
    >
      <div className="mx-auto flex w-full max-w-[1320px] flex-1 flex-col">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#262B3D] pb-[18px] short:pb-3">
          <div className="flex min-w-0 flex-col gap-2.5 short:gap-1.5">
            <div className="flex items-center gap-2 font-f1-mono text-xs font-extrabold tracking-[0.22em] text-[#CCFF00]">
              <Pause aria-hidden className="h-3.5 w-3.5" fill="currentColor" strokeWidth={0} />
              PAUSED
            </div>
            <h1 className="lc-disp m-0 text-[clamp(32px,4.2vw,60px)] text-[#F5F7FA] short:text-[28px]">
              {trackInfo.name}
            </h1>
            <div className="flex flex-wrap gap-2">
              <span className={`${HEADER_CHIP} border border-[#262B3D] bg-[#11131A] text-[#8E96AA]`}>
                {trackInfo.city}, {trackInfo.country}
              </span>
              <span className={`${HEADER_CHIP} border border-[#262B3D] bg-[#11131A] text-[#F5F7FA]`}>
                Lap {Math.max(1, race?.lap ?? telemetry.lapCount)}
                {race?.totalLaps ? ` / ${race.totalLaps}` : ""}
              </span>
              {race ? (
                <span className={`${HEADER_CHIP} bg-[#CCFF00] text-[#08090D]`}>
                  P{race.position} of {race.fieldSize}
                </span>
              ) : null}
              {mpRace ? <span className={`${HEADER_CHIP} bg-[#00E5FF] text-[#08090D]`}>Online race</span> : null}
            </div>
          </div>
          <LibreCorsaLogo variant="compact" />
        </div>

        <div className="mt-5 grid flex-1 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(240px,270px)_minmax(0,1fr)] short:mt-3 short:gap-4">
          <nav className="flex flex-col gap-1" data-nav-zone="rail" aria-label="Pause menu">
            {actions.map((a) =>
              "primary" in a && a.primary ? (
                <PrimaryRailItem
                  key={a.id}
                  navId={a.id}
                  label={a.label}
                  detail={a.detail}
                  icon={a.icon}
                  onClick={a.run}
                />
              ) : (
                <RailItem key={a.id} navId={a.id} label={a.label} detail={a.detail} icon={a.icon} onClick={a.run} />
              )
            )}
          </nav>

          <div className="flex min-h-0 min-w-0 flex-col gap-3.5">
            <TabStrip tabs={tabs} value={panel} onChange={selectTab} />
            <section ref={panelRef} className="min-h-0 scroll-mt-4" data-nav-zone="panel">
              <div key={panel} className="lc-panel-in">
                {panel === "settings" ? <SessionPanel {...props} /> : null}
                {panel === "setup" ? <EngineersGarage {...props} /> : null}
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

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[#262B3D] pt-3 short:mt-3">
          <PromptBar
            prompts={[
              { action: "move", label: "Move" },
              { action: "select", label: panel === "corners" ? "Jump there" : "Select" },
              { action: "tabs", label: "Tabs" },
              { action: "back", label: "Back", key: "⌫" },
              { action: "start", label: "Resume", key: "Esc" },
            ]}
          />
          <span className="hidden font-f1-mono text-[11px] font-bold tracking-[0.12em] text-[#8E96AA] md:inline">
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
    <div className="grid items-start gap-3.5 xl:grid-cols-[1.45fr_1fr]">
      <section className={PANEL_CARD} aria-label="Session">
        <PanelSection>Session</PanelSection>
        <div className="grid gap-x-[22px] gap-y-0.5 sm:grid-cols-2">
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
          <div className="flex min-h-[48px] items-center justify-between gap-3 px-2">
            <span className="text-[16px] leading-tight font-bold text-[#F5F7FA]">Camera</span>
            <button
              type="button"
              onClick={p.onCycleCamera}
              className="inline-flex h-9 shrink-0 cursor-pointer items-center rounded-full border border-[#262B3D] bg-[#08090D] px-3.5 font-f1-mono text-xs font-extrabold text-[#CCFF00] transition-colors hover:border-[#CCFF00]"
            >
              {CAMERA_LABELS[p.cameraMode]} · {k.camera}
            </button>
          </div>
        </div>
        {p.onChangeCockpitFov ? (
          <div className="border-t border-[#262B3D] pt-1.5">
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
                className="min-h-[32px] cursor-pointer px-2 font-f1-mono text-[11px] font-extrabold tracking-[0.12em] text-[#8E96AA] uppercase transition-colors hover:text-[#CCFF00]"
              >
                Car default{p.cockpitFovDefaultDeg ? ` (${p.cockpitFovDefaultDeg}°)` : ""}
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className={PANEL_CARD} aria-label="Controls">
        <PanelSection color="#00E5FF">Controls</PanelSection>
        <div className="flex flex-col">
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
            <div
              key={label}
              className="flex items-baseline justify-between gap-3 border-b border-[#262B3D]/70 py-[7px] last:border-b-0"
            >
              <span className="text-[13px] text-[#8E96AA]">{label}</span>
              <span className="text-right font-f1-mono text-[12px] font-extrabold text-[#F5F7FA]">{keys}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

export const SetupPanel: React.FC<PauseMenuProps> = (p) => {
  const limits = TYRE_SETUP_LIMITS[p.vehicleModel];
  return (
    <div className="lc-glass flex flex-col gap-[18px] rounded-[28px] p-5 text-[#F5F7FA] sm:px-7 sm:pt-6 sm:pb-[26px] short:p-4 [.lc-title-frame_&]:border-0 [.lc-title-frame_&]:bg-transparent [.lc-title-frame_&]:p-0 [.lc-title-frame_&]:shadow-none [.lc-title-frame_&]:[backdrop-filter:none]">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(360px,100%),1fr))] gap-[26px] short:gap-5">
        <div className="flex min-w-0 flex-col gap-[18px]">
          <div className="flex flex-col gap-2.5">
            <PanelSection>Vehicle class &amp; chassis</PanelSection>
            {VEHICLE_CHOICES.map((car) => {
              const active = p.vehicleModel === car.id;
              return (
                <Choice key={car.id} active={active} onClick={() => p.onChangeVehicle(car.id)}>
                  <span className="flex flex-col gap-[3px]">
                    <span className="flex flex-wrap items-center gap-2.5">
                      <span className="lc-title text-[17px] leading-tight">{car.title}</span>
                      <span
                        className="rounded-full px-[7px] py-0.5 font-f1-mono text-[9px] font-extrabold"
                        style={
                          active
                            ? { backgroundColor: car.badgeColor, color: "#08090D" }
                            : { boxShadow: `inset 0 0 0 1px ${car.badgeColor}`, color: car.badgeColor }
                        }
                      >
                        {car.badge}
                      </span>
                    </span>
                    <span className={`text-[13px] ${active ? "text-[#C5CBD8]" : "text-[#8E96AA]"}`}>{car.sub}</span>
                  </span>
                </Choice>
              );
            })}
          </div>

          <div className="flex flex-col gap-2.5">
            <PanelSection color="#00E5FF">Aero package</PanelSection>
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
              ).map((item) => {
                const active = p.aeroPreset === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => p.onChangeAeroPreset(item.id)}
                    className={`flex min-h-[60px] min-w-0 cursor-pointer flex-col justify-center gap-0.5 rounded-2xl px-3 py-2.5 text-left transition-[background-color,border-color,color] duration-200 ${
                      active
                        ? "border-[1.5px] border-[#CCFF00] bg-[#CCFF00]/[0.07] text-[#F5F7FA]"
                        : "border border-[#262B3D] bg-[#08090D]/50 text-[#C5CBD8] hover:border-[#3A4157] hover:bg-[#1B1F2B] hover:text-[#F5F7FA]"
                    }`}
                  >
                    <span className="text-[14px] leading-tight font-bold">{item.title}</span>
                    <span className={`text-[12px] ${active ? "text-[#C5CBD8]" : "text-[#8E96AA]"}`}>{item.sub}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-[18px]">
          <div className="grid gap-3.5 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-2.5">
              <PanelSection>Tyres</PanelSection>
              <div className="flex rounded-full border border-[#262B3D] bg-[#08090D] p-1">
                {COMPOUNDS.map((c) => {
                  const active = p.tireCompound === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={active}
                      aria-label={c.name}
                      onClick={() => p.onChangeTireCompound(c.id)}
                      className={`${SEG_BTN} ${
                        active
                          ? "bg-[#1B1F2B] text-[#F5F7FA] shadow-[inset_0_0_0_1px_#3A4157]"
                          : "text-[#8E96AA] hover:text-[#F5F7FA]"
                      }`}
                    >
                      <span
                        aria-hidden
                        className="h-3 w-3 shrink-0 rounded-full border-[3px]"
                        style={{ borderColor: c.ring }}
                      />
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-2.5">
              <PanelSection>Traction &amp; ABS</PanelSection>
              <div className="flex rounded-full border border-[#262B3D] bg-[#08090D] p-1">
                {(
                  [
                    { id: "pro", label: "Off" },
                    { id: "semi_pro", label: "TC + ABS" },
                    { id: "assisted", label: "Full" },
                  ] as const
                ).map((a) => {
                  const active = p.assistPreset === a.id;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => p.onChangeAssistPreset(a.id)}
                      className={`${SEG_BTN} ${
                        active ? "flex-[1.6] bg-[#CCFF00] text-[#08090D]" : "text-[#8E96AA] hover:text-[#F5F7FA]"
                      }`}
                    >
                      {a.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-[20px] border border-[#262B3D] bg-[#08090D]/55 p-4">
            <div className="flex items-center justify-between gap-3">
              <PanelSection>Tyres · pressure &amp; camber</PanelSection>
              <button
                type="button"
                onClick={() => p.onChangeTyreSetup(p.defaultTyreSetup)}
                className="inline-flex h-[30px] shrink-0 cursor-pointer items-center rounded-full border border-[#262B3D] px-3 font-f1-mono text-[10px] font-extrabold tracking-[0.12em] text-[#8E96AA] uppercase transition-colors hover:border-[#CCFF00] hover:text-[#CCFF00]"
              >
                Reset
              </button>
            </div>
            <div className="grid gap-x-5 gap-y-1 sm:grid-cols-2">
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
            <p className="m-0 text-[12px] leading-normal text-[#8E96AA]">
              Read the tread temps on the tyre panel: inner hotter than outer by 5–10 °C is ideal.
            </p>
          </div>

          <div className="flex flex-col gap-2.5">
            <PanelSection>Livery</PanelSection>
            <div className="grid grid-cols-5 gap-2">
              {LIVERIES.map((liv) => {
                const active = p.selectedLivery.id === liv.id;
                return (
                  <button
                    key={liv.id}
                    type="button"
                    aria-pressed={active}
                    aria-label={liv.name}
                    title={`${liv.name} · ${liv.team}`}
                    onClick={() => p.onChangeLivery(liv)}
                    className={`flex min-h-[44px] min-w-0 cursor-pointer flex-col gap-2 rounded-2xl p-2 text-left transition-[background-color,border-color,color] duration-200 ${
                      active
                        ? "border-[1.5px] border-[#CCFF00] bg-[#CCFF00]/[0.07] text-[#F5F7FA]"
                        : "border border-[#262B3D] bg-[#08090D]/50 text-[#C5CBD8] hover:border-[#3A4157] hover:bg-[#1B1F2B] hover:text-[#F5F7FA]"
                    }`}
                  >
                    <span
                      aria-hidden
                      className="block h-[26px] w-full rounded-[10px]"
                      style={{
                        background: `linear-gradient(135deg, ${liv.primary} 0 55%, ${liv.accent} 55% 65%, ${liv.secondary} 65% 100%)`,
                      }}
                    />
                    <span className="truncate text-[11px] font-bold">{liv.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const cornerName = (name: string) => name.replace(/^Turn \d+\s*[—-]\s*/, "");

/** The active circuit's outline, start line and corner positions, fitted to an SVG viewBox */
function buildCornerMap() {
  const track = getTrackData();
  const samples = track.samples;
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
    d += `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }
  d += "Z";

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
  // The corner under the pointer or the focus, lit on the map
  const [hot, setHot] = useState<number | null>(null);
  const hotTurn = hot == null ? undefined : TURN_METADATA.find((t) => t.number === hot);
  const hotPoint = hot == null ? undefined : map.turns.find((t) => t.number === hot);

  return (
    <section
      aria-label="Jump to a corner"
      className="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-3.5 rounded-[24px] border border-white/[0.07] bg-[#0D0F15]/82 p-[18px] text-[#F5F7FA] short:p-3.5"
    >
      <div className="flex min-w-0 flex-col gap-2.5">
        <PanelSection>Jump to a corner · apex speed · gear</PanelSection>
        <svg
          viewBox={map.viewBox}
          role="img"
          aria-label={`Circuit map with ${TURN_METADATA.length} numbered turns`}
          className="hidden h-auto max-h-[400px] w-full sm:block short:max-h-[200px]"
        >
          <path d={map.d} fill="none" stroke="#141822" strokeWidth={46} strokeLinejoin="round" />
          <path d={map.d} fill="none" stroke="#3A4157" strokeWidth={10} strokeLinejoin="round" />
          <path
            d={map.d}
            fill="none"
            stroke="#CCFF00"
            strokeOpacity={0.6}
            strokeWidth={3}
            strokeDasharray="3 37"
            className="lc-flow"
          />
          <line {...map.startLine} stroke="#F5F7FA" strokeWidth={8} />
          <g className="font-f1-mono" fontSize={20} fontWeight={800} textAnchor="middle">
            {map.turns.map((t) =>
              t.number === hot ? null : (
                <g key={t.number}>
                  <circle cx={t.x} cy={t.y} r={22} fill="#11131A" stroke="#5B6275" strokeWidth={3} />
                  <text x={t.x} y={t.y + 7} fill="#F5F7FA">
                    {t.number}
                  </text>
                </g>
              )
            )}
            {hotPoint ? (
              <g>
                <circle cx={hotPoint.x} cy={hotPoint.y} r={40} fill="#CCFF00" opacity={0.22} />
                <circle cx={hotPoint.x} cy={hotPoint.y} r={26} fill="#CCFF00" stroke="#08090D" strokeWidth={4} />
                <text x={hotPoint.x} y={hotPoint.y + 7} fill="#08090D">
                  {hotPoint.number}
                </text>
              </g>
            ) : null}
          </g>
        </svg>
        <div className="hidden min-h-[44px] items-center gap-3 sm:flex">
          {hotTurn ? (
            <>
              <span className="lc-disp shrink-0 text-[24px] text-[#CCFF00]">T{hotTurn.number}</span>
              <span className="flex min-w-0 flex-col">
                <span className="lc-title truncate text-[15px] text-[#F5F7FA]">{cornerName(hotTurn.name)}</span>
                <span className="truncate text-[12px] text-[#8E96AA]">
                  {hotTurn.complexName} · Sector {hotTurn.sector}
                </span>
              </span>
            </>
          ) : (
            <span className="text-[13px] text-[#8E96AA]">Pick a corner to jump there.</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 content-start gap-1.5 min-[420px]:grid-cols-2">
        {TURN_METADATA.map((t) => (
          <button
            key={t.number}
            type="button"
            onClick={() => onSelect(t.number)}
            onPointerEnter={() => setHot(t.number)}
            onPointerLeave={() => setHot((h) => (h === t.number ? null : h))}
            onFocus={() => setHot(t.number)}
            onBlur={() => setHot((h) => (h === t.number ? null : h))}
            aria-label={`Turn ${t.number}: ${cornerName(t.name)}, ${t.complexName}. Apex ${t.apexSpeedKmh} km/h, gear ${t.gear}`}
            title={`${cornerName(t.name)} · ${t.complexName}`}
            className="group grid min-h-[44px] cursor-pointer grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[14px] bg-[#08090D]/55 px-3 py-1 text-left text-[#F5F7FA] shadow-[inset_0_0_0_1px_#1B1F2B] outline-none transition-[background-color,box-shadow,color] duration-200 hover:shadow-[inset_0_0_0_1px_#CCFF00] focus:bg-[#CCFF00] focus:text-[#08090D] focus:shadow-[0_0_0_4px_rgba(204,255,0,0.15)]"
          >
            <span className="lc-disp text-[20px] text-[#CCFF00] group-focus:text-[#08090D]">T{t.number}</span>
            <span className="flex min-w-0 flex-col">
              <span className="font-f1-mono text-[13px] font-extrabold tabular-nums">
                {t.apexSpeedKmh}
                <span className="text-[10px] text-[#8E96AA] group-focus:text-[#08090D]/70"> KM/H</span>
              </span>
              <span className="truncate text-[11px] text-[#8E96AA] group-focus:text-[#08090D]/70 sm:hidden">
                {cornerName(t.name)}
              </span>
            </span>
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#00E5FF]/12 font-f1-mono text-[12px] font-extrabold text-[#00E5FF] group-focus:bg-[#08090D] group-focus:text-[#CCFF00]">
              {t.gear}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
};
