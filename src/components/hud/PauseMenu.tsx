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
import { LIVERIES, TRACK_TOTAL_LENGTH_M, TURN_METADATA } from "@/lib/track-data";
import { COCKPIT_FOV_MAX_DEG, COCKPIT_FOV_MIN_DEG } from "@/lib/settings/player-settings";
import { MultiplayerPanel, type MultiplayerPanelProps } from "./MultiplayerPanel";
import { useListNav } from "@/components/menu/useMenuNav";

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
}[] = [
  { id: "vf26", title: "VF26", sub: "Curvilinear 2026 model · active aero" },
  {
    id: "f12026-car",
    title: "f12026-car",
    sub: "6-DOF rigid-body · track colliders · DRS",
  },
  {
    id: "amg-gt3",
    title: "AMG GT3",
    sub: "Mercedes-AMG GT3 · 6.2L V8 · ABS / TC",
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
}

type Panel = "settings" | "setup" | "corners" | "multiplayer";

export const Toggle: React.FC<{
  label: string;
  detail?: string;
  checked: boolean;
  onChange: () => void;
}> = ({ label, detail, checked, onChange }) => (
  <label className="flex cursor-pointer items-center justify-between gap-4 rounded px-1 py-1.5 hover:bg-white/5">
    <span>
      <span className="block font-f1-italic text-[15px] uppercase">{label}</span>
      {detail ? <span className="block font-f1-mono text-[11px] text-zinc-500">{detail}</span> : null}
    </span>
    <input type="checkbox" checked={checked} onChange={onChange} className="peer sr-only" />
    <span
      aria-hidden
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-white ${
        checked ? "bg-[#00D26A]" : "bg-zinc-700"
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
          checked ? "translate-x-[22px]" : "translate-x-0.5"
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
  <label className="block rounded px-1 py-1.5 hover:bg-white/5">
    <span className="flex items-center justify-between gap-3">
      <span className="font-f1-italic text-[15px] uppercase">{label}</span>
      <span className="font-f1-mono text-sm font-bold tabular-nums">{format(value)}</span>
    </span>
    <input
      type="range"
      min={limits.min}
      max={limits.max}
      step={limits.step}
      value={value}
      onChange={(e) => onChange(Number((Math.round(Number(e.target.value) / limits.step) * limits.step).toFixed(1)))}
      className="mt-1 w-full cursor-pointer accent-[#E10600]"
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
    className={`cursor-pointer rounded border px-2 py-2 text-left transition-colors ${
      active
        ? "border-[#E10600] bg-[#E10600]/20 text-white"
        : "border-white/10 bg-black/30 text-zinc-400 hover:bg-white/5"
    }`}
  >
    {children}
  </button>
);

/** Esc menu: race / session actions on the left, the selected panel on the right */
export const PauseMenu: React.FC<PauseMenuProps> = (props) => {
  const { telemetry, onTogglePause, onResetCar, aiOpponents, onOpenControls, onExitToTitle } = props;
  const [panel, setPanel] = useState<Panel>(props.openMultiplayer ? "multiplayer" : "settings");
  const panelRef = useRef<HTMLElement | null>(null);
  // Below lg the panel sits under the rail, usually off-screen: render the one just opened and bring it into view
  const openPanel = useCallback((next: Panel) => {
    if (window.matchMedia("(min-width: 64rem)").matches) return setPanel(next);
    flushSync(() => setPanel(next));
    // Instant: the tap's own touch gesture would cancel a smooth scroll
    panelRef.current?.scrollIntoView({ block: "start" });
  }, []);

  const menuItems = useMemo(
    () => [
      {
        id: "resume",
        label: "Resume",
        detail: "Back on track",
        run: () => onTogglePause(),
      },
      {
        id: "grid",
        label: aiOpponents ? "Restart race" : "Grid start",
        detail: aiOpponents ? "Line up on the grid behind the lights" : "Standing start from the grid",
        run: () => {
          onResetCar(false);
          onTogglePause();
        },
      },
      {
        id: "flying",
        label: aiOpponents ? "Rolling start" : "Flying lap",
        detail: aiOpponents ? "Restart the race on the move" : "Timed lap from the main straight",
        run: () => {
          onResetCar(true);
          onTogglePause();
        },
      },
      {
        id: "settings",
        label: "Session",
        detail: "AI opponents, assists, camera",
        run: () => openPanel("settings"),
      },
      {
        id: "setup",
        label: "Car setup",
        detail: "Aero, tyres, traction, livery",
        run: () => openPanel("setup"),
      },
      {
        id: "corners",
        label: "Corners",
        detail: `Practise any of the ${TURN_METADATA.length} turns`,
        run: () => openPanel("corners"),
      },
      {
        id: "multiplayer",
        label: "Multiplayer",
        detail: "Race friends peer-to-peer",
        run: () => openPanel("multiplayer"),
      },
      ...(onOpenControls
        ? [
            {
              id: "controls",
              label: "Controls",
              detail: "Keys, controller, wheel calibration",
              run: onOpenControls,
            },
          ]
        : []),
      ...(onExitToTitle
        ? [
            {
              id: "title",
              label: "Main menu",
              detail: "Leave the session",
              run: onExitToTitle,
            },
          ]
        : []),
    ],
    [aiOpponents, onResetCar, onTogglePause, onOpenControls, onExitToTitle, openPanel],
  );

  // Esc is the simulator's pause toggle; on a controller B or Menu resumes
  const [menuIndex, setMenuIndex] = useListNav(menuItems.length, {
    onSelect: (i) => menuItems[i]?.run(),
    onBack: onTogglePause,
    onStart: onTogglePause,
    keyboardBack: false,
  });

  const race = telemetry.race;

  return (
    <div className="pointer-events-auto fixed inset-0 z-40 flex flex-col overflow-y-auto bg-[#07070c]/85 px-5 pt-7 pb-[max(1.75rem,env(safe-area-inset-bottom))] backdrop-blur-md sm:px-10 short:pt-4">
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col">
        <div className="font-f1-mono text-xs font-black tracking-[0.22em] text-[#E10600]">PAUSED</div>
        <h1 className="mt-1 font-f1-italic text-4xl uppercase leading-none tracking-wide text-white sm:text-6xl">
          Rwanda Grand Prix
        </h1>
        <p className="mt-2 font-f1-mono text-xs font-bold tracking-wide text-zinc-400">
          BUGESERA · LAP {Math.max(1, race?.lap ?? telemetry.lapCount)}
          {race ? ` · P${race.position} OF ${race.fieldSize}` : ""} · FAN PROJECT
        </p>

        <div className="mt-8 grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(240px,280px)_1fr] short:mt-4">
          <nav className="flex flex-col gap-1.5">
            {menuItems.map((item, index) => {
              const active = index === menuIndex;
              const open = item.id === panel;
              return (
                <button
                  key={item.id}
                  type="button"
                  onMouseEnter={() => setMenuIndex(index)}
                  onClick={item.run}
                  className={`flex cursor-pointer flex-col rounded-md border-l-4 px-3 py-2.5 text-left ${
                    active ? "bg-white text-[#111]" : "bg-[#14141c] text-white hover:bg-[#1c1c26]"
                  } ${open ? "border-[#E10600]" : "border-transparent"}`}
                >
                  <span className="font-f1-italic text-base uppercase">{item.label}</span>
                  <span className={`font-f1-mono text-[11px] ${active ? "text-zinc-600" : "text-zinc-500"}`}>
                    {item.detail}
                  </span>
                </button>
              );
            })}
          </nav>

          <section ref={panelRef} className="min-h-0 scroll-mt-4">
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
          </section>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-2 font-f1-mono text-[11px] font-bold tracking-wide text-zinc-500">
          <span>
            BUGESERA · {(TRACK_TOTAL_LENGTH_M / 1000).toFixed(2)} KM · {TURN_METADATA.length} TURNS · FAN PROJECT
          </span>
          <span>↑↓ NAVIGATE · ENTER / Ⓐ SELECT · ESC / Ⓑ RESUME</span>
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
      <div className="rounded-md bg-[#14141c] p-4 text-white">
        <div className="mb-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-zinc-500">SESSION</div>
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
        <div className="mt-2 flex items-center justify-between px-1">
          <span className="font-f1-italic text-[15px] uppercase">Camera</span>
          <button
            type="button"
            onClick={p.onCycleCamera}
            className="cursor-pointer rounded bg-black/40 px-3 py-1.5 font-f1-mono text-xs font-bold uppercase"
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
                className="cursor-pointer px-1 font-f1-mono text-[11px] font-bold uppercase text-zinc-400 hover:text-white"
              >
                Car default{p.cockpitFovDefaultDeg ? ` (${p.cockpitFovDefaultDeg}°)` : ""}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="rounded-md bg-[#14141c] p-4 text-white">
        <div className="mb-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-zinc-500">CONTROLS</div>
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
            <div key={label} className="flex items-center justify-between gap-3 border-b border-white/5 pb-1.5">
              <span className="text-zinc-300">{label}</span>
              <span className="font-bold text-white">{keys}</span>
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
    <div className="rounded-md bg-[#14141c] p-4 text-white">
      <div className="mb-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-zinc-500">CAR</div>
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {VEHICLE_CHOICES.map((car) => (
          <Choice key={car.id} active={p.vehicleModel === car.id} onClick={() => p.onChangeVehicle(car.id)}>
            <div className="font-f1-italic text-sm uppercase">{car.title}</div>
            <div className="font-f1-mono text-[11px] opacity-75">{car.sub}</div>
          </Choice>
        ))}
      </div>

      <div className="mb-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-zinc-500">AERO PACKAGE</div>
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
            <div className="font-f1-italic text-sm uppercase">{item.title}</div>
            <div className="font-f1-mono text-[11px] opacity-75">{item.sub}</div>
          </Choice>
        ))}
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-zinc-500">TYRES</div>
          <div className="grid grid-cols-3 gap-2">
            {(["soft", "medium", "hard"] as const).map((c) => (
              <Choice key={c} active={p.tireCompound === c} onClick={() => p.onChangeTireCompound(c)}>
                <div className="text-center font-f1-italic text-sm uppercase">{c}</div>
              </Choice>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-zinc-500">TRACTION & ABS</div>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { id: "pro", label: "Off" },
                { id: "semi_pro", label: "TC + ABS" },
                { id: "assisted", label: "Full" },
              ] as const
            ).map((a) => (
              <Choice key={a.id} active={p.assistPreset === a.id} onClick={() => p.onChangeAssistPreset(a.id)}>
                <div className="text-center font-f1-italic text-sm uppercase">{a.label}</div>
              </Choice>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-f1-mono text-[11px] font-bold tracking-[0.16em] text-zinc-500">
            TYRES · PRESSURE & CAMBER
          </span>
          <button
            type="button"
            onClick={() => p.onChangeTyreSetup(p.defaultTyreSetup)}
            className="cursor-pointer rounded bg-black/40 px-2 py-1 font-f1-mono text-[11px] font-bold uppercase text-zinc-300 hover:bg-white/10"
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
        <p className="mt-1 font-f1-mono text-[11px] text-zinc-500">
          Read the tread temps on the tyre panel: inner hotter than outer by 5–10 °C is ideal.
        </p>
      </div>

      <div className="mt-4 mb-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-zinc-500">LIVERY</div>
      <div className="grid grid-cols-5 gap-2">
        {LIVERIES.map((liv) => (
          <Choice key={liv.id} active={p.selectedLivery.id === liv.id} onClick={() => p.onChangeLivery(liv)}>
            <span
              className="mb-1 block h-3 w-full rounded-sm"
              style={{
                background: `linear-gradient(90deg, ${liv.primary} 50%, ${liv.secondary} 50%)`,
              }}
            />
            <span className="block text-center font-f1-mono text-xs font-bold">#{liv.number}</span>
          </Choice>
        ))}
      </div>
    </div>
  );
};

const CornersPanel: React.FC<{ onSelect: (turn: number) => void }> = ({ onSelect }) => (
  <div className="rounded-md bg-[#14141c] p-4 text-white">
    <div className="mb-3 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-zinc-500">
      JUMP TO A CORNER · APEX SPEED · GEAR
    </div>
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {TURN_METADATA.map((t) => (
        <button
          key={t.number}
          type="button"
          onClick={() => onSelect(t.number)}
          className="flex cursor-pointer items-center gap-3 rounded border border-white/10 bg-black/30 px-3 py-2 text-left hover:border-[#E10600] hover:bg-[#1c1c26]"
        >
          <span className="hud-num w-9 text-[20px] text-[#E10600]">T{t.number}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-f1-italic text-sm uppercase">
              {t.name.replace(/^Turn \d+\s*[—-]\s*/, "")}
            </span>
            <span className="block truncate font-f1-mono text-[11px] text-zinc-500">{t.complexName}</span>
          </span>
          <span className="hud-num text-[15px] text-white/85">{t.apexSpeedKmh}</span>
          <span className="hud-num w-6 text-right text-[15px] text-[#FFD700]">{t.gear}</span>
        </button>
      ))}
    </div>
  </div>
);
