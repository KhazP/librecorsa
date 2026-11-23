"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import { t as tr } from "@/i18n/runtime";
import {
  hasTurnServer,
  loadUserTurnServer,
  MP_QUALIFYING_MINUTES,
  saveUserTurnServer,
  withLobbyDefaults,
  type CarClassRule,
  type CollisionMode,
  type LobbyPlayer,
  type LobbySettings,
  type LobbyState,
  type MpGridOrder,
  type MpQualifyingMinutes,
  type MpRaceRules,
  type MpStartType,
  type P2PConnectionStatus,
  type PeerNetStats,
} from "@/lib/sim/multiplayer-sync";
import {
  TIME_OF_DAY_LABELS,
  TIME_OF_DAY_PRESETS,
  TIME_SCALES,
  WEATHER_LABELS,
  WEATHER_PRESETS,
  type TimeOfDayId,
  type WeatherPresetId,
} from "@/lib/sim/weather";
import { DAMAGE_LEVEL_LABELS, DAMAGE_LEVELS, type DamageLevel } from "@/lib/sim/car-damage";
import { RULE_PRESET_HINTS, RULE_PRESET_LABELS, TRACK_LIMITS_CHOICE_LABELS, type TrackLimitsChoice } from "@/lib/sim/race-rules";
import { RACE_START_MODE_HINTS, RACE_START_MODE_LABELS, RACE_START_MODES, type RaceStartMode } from "@/lib/sim/race-start";
import { carClass, carClassesInUse } from "@/lib/cars/car-registry";
import { getTrackInfo, TRACKS } from "@/lib/track-registry";
import { roomTrackStatus } from "@/lib/mods/room-content";
import { Button, Card, ConfirmDialog, Disclosure, Segmented, Select, SettingRow, Stepper, TextField, Toggle, Well } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { BadgeLegend, DriverBadges } from "@/components/ui/DriverBadges";
import { PlayerTag, SessionBadge } from "@/components/ui/badges";
import { Icon } from "@/components/ui/icons";
import { TrackQualityBadge } from "@/components/menu/menu-content-ui";
import { useRaceDistance } from "@/components/menu/RaceRules";
import { fetchBadges, roomNameBadges, type BadgeContext, type DriverBadge } from "@/lib/net/awards";
import { driverNameKey } from "@/lib/net/board-client";
import { isVehicleModelId } from "@/types/f1";
import { formatLapTime } from "./hud-format";
import { RacesCard, type RacesCardProps } from "./RacesCard";

export interface MultiplayerPanelProps {
  p2pStatus?: P2PConnectionStatus;
  initialRoomCode?: string;
  onHostP2PRoom?: () => string;
  onJoinP2PRoom?: (roomCode: string) => void;
  onCreateManualOffer?: () => Promise<string>;
  onAcceptManualOffer?: (offerToken: string) => Promise<string>;
  onAcceptManualAnswer?: (answerToken: string) => Promise<boolean>;
  /** The shared lobby this player is in, or null when not in one */
  lobby?: LobbyState | null;
  localPeerId?: string;
  isHost?: boolean;
  peerStats?: PeerNetStats[];
  /** This player's identity (edited in the Display panel) */
  profile?: { name: string; code: string; color: string };
  currentTrackId?: string;
  currentVehicle?: string;
  vehicleLabel?: (id: string) => string;
  /** Vehicle ids allowed by a car-class rule (every model of the class: what a driver may race in) */
  vehiclesForClass?: (rule: CarClassRule) => string[];
  /** The listed cars a car-class rule lets in, to switch to */
  carsForClass?: (rule: CarClassRule) => { id: string; title: string }[];
  raceRunning?: boolean;
  /** Why the host can't start a race here (a hill climb: one car at a time) */
  startBlocked?: string;
  onHostLocal?: () => void;
  onSetLobbySettings?: (patch: Partial<LobbySettings>) => void;
  onSetReady?: (ready: boolean) => void;
  onStartRace?: () => void;
  onAbortRace?: () => void;
  onSwitchTrack?: (trackId: string) => void;
  onSwitchCar?: (carId: string) => void;
  /** The host picks the room's circuit (the title menu's circuit browser); absent: the circuit is read-only here */
  onPickCircuit?: () => void;
  onOpenProfile?: () => void;
  /** The open scheduled races (only where they run, and only from the title menu) */
  races?: RacesCardProps;
}

const MIN_LAPS = 1;
const MAX_LAPS = 50;

/** A collision mode's message key */
const COLLISION_KEY = { on: "on", ghost_lap1: "ghostLap1", off: "off", protected: "protected" } as const satisfies Record<CollisionMode, string>;
const collisionLabel = (mode: CollisionMode) => tr(`hud.multiplayerPanel.collision.${COLLISION_KEY[mode]}`);
const collisionHint = (mode: CollisionMode) => tr(`hud.multiplayerPanel.collisionHint.${COLLISION_KEY[mode]}`);
/** What a private room's host offers; a public room's `protected` rule only ever shows as its label */
const COLLISION_OPTIONS: { value: CollisionMode; label: string }[] = (["on", "ghost_lap1", "off"] as const).map((value) => ({
  value,
  get label() {
    return collisionLabel(value);
  },
}));

/** "Any car", or the class's name as the registry has it ("GT3", "Prototypes"): every class with cars is on offer */
const classRuleLabel = (rule: CarClassRule) => (rule === "any" ? tr("hud.multiplayerPanel.anyCar") : carClass(rule).title);
const classRuleOptions = (): { id: CarClassRule; label: string }[] => [
  { id: "any", label: classRuleLabel("any") },
  ...carClassesInUse().map((k) => ({ id: k.id, label: k.title })),
];

const START_TYPE_OPTIONS: { value: MpStartType; label: string }[] = (["standing", "rolling"] as const).map((value) => ({
  value,
  get label() {
    return tr(`hud.multiplayerPanel.startType.${value}`);
  },
}));

const GRID_ORDER_OPTIONS: { value: MpGridOrder; label: string }[] = (["qualifying", "reverse", "random"] as const).map((value) => ({
  value,
  get label() {
    return tr(`hud.multiplayerPanel.gridOrder.${value}`);
  },
}));

/** The rule presets, the AI race's labels read when shown (race-rules.ts) */
const MP_RULE_PRESET_OPTIONS: { value: MpRaceRules["preset"]; label: string }[] = (["classic", "auto", "open_wheel", "endurance_sprint"] as const).map(
  (value) => ({
    value,
    get label() {
      return value === "classic" ? tr("hud.multiplayerPanel.presetClassic") : RULE_PRESET_LABELS[value];
    },
  }),
);
const mpRulePresetHint = (preset: MpRaceRules["preset"]) =>
  preset === "classic" ? tr("hud.multiplayerPanel.presetClassicHint") : RULE_PRESET_HINTS[preset];

const gridOrderHint = (order: MpGridOrder) => tr(`hud.multiplayerPanel.gridOrderHint.${order}`);

const TIME_SCALE_OPTIONS = TIME_SCALES.map((s) => ({
  id: String(s),
  get label() {
    return s === 0 ? tr("hud.multiplayerPanel.timeScaleFixed") : `${s}x`;
  },
}));

const QUALIFYING_OPTIONS = MP_QUALIFYING_MINUTES.map((m) => ({
  id: String(m),
  get label() {
    return m === 0 ? tr("hud.multiplayerPanel.qualifyingOff") : `${m} min`;
  },
}));

/** A circuit's name, with the layout when the venue has more than one, so a guest knows which (an unknown id stays itself) */
const trackName = (id: string) => {
  const t = TRACKS.find((x) => x.id === id);
  if (!t) return id;
  return TRACKS.some((o) => o.id !== t.id && o.name === t.name) ? `${t.name} · ${t.layout}` : t.name;
};
const optionLabel = <T extends string>(options: { value: T; label: string }[], value: T) =>
  options.find((o) => o.value === value)?.label ?? value;

/** How long the ready button waits for the host to echo a change before it shows the lobby's value again */
const READY_ECHO_MS = 3000;

/** A confirmation that shows for `ms` ("Link copied"): re-arming restarts it, and it never fires after unmount */
function useFlash(ms: number): [on: boolean, show: () => void, cancel: () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<number | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setOn(false);
  }, []);
  const show = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setOn(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setOn(false);
    }, ms);
  }, [ms]);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );
  return [on, show, cancel];
}

/**
 * The manual (no broker) connection, one step at a time: the host creates an offer (1), the guest pastes it and gets an
 * answer (2), the host pastes that answer (3). Each step is only open to the side and the stage it belongs to.
 */
type ManualSdp =
  | { stage: "idle" }
  | { stage: "offered"; token: string }
  | { stage: "answered"; token: string }
  | { stage: "accepted" };

/** Ping badge tone: good under 80 ms, caution under 160 ms, else a loss */
const pingTone = (ms: number) => (ms < 80 ? "good" : ms < 160 ? "warn" : "bad");

function ReadValue({ children }: { children: React.ReactNode }) {
  return <span className="text-[15px] leading-tight font-semibold text-lc-chalk">{children}</span>;
}

/** A sub-section of "More ways to connect": a plain heading and one line on what it is for */
function ConnectSection({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-lc-line pt-3.5 first:border-t-0 first:pt-1">
      <div className="flex flex-col gap-0.5">
        <h4 className="lc-row-label m-0">{title}</h4>
        <p className="lc-hint m-0">{intro}</p>
      </div>
      {children}
    </section>
  );
}

function NetBadge({ stats }: { stats?: PeerNetStats }) {
  const tx = useTranslations("hud.multiplayerPanel.net");
  if (!stats) return null;
  return (
    <>
      {stats.relayed ? (
        <Badge size="sm" tone="info" icon="relay" title={tx("relayedTitle")}>
          {tx("relayed")}
        </Badge>
      ) : null}
      {stats.rttMs == null ? (
        <Badge size="sm" variant="outline">
          {tx("measuring")}
        </Badge>
      ) : (
        <Badge size="sm" tone={pingTone(stats.rttMs)} icon="latency" className="lc-mono">
          {tx("pingLoss", { ping: Math.round(stats.rttMs), loss: Math.round(stats.lossPct) })}
        </Badge>
      )}
    </>
  );
}

/** One setting of the room: how it reads, and the host's control for it */
interface LobbyRow {
  /** Names the row for React (the label is translated) */
  id: string;
  label: string;
  /** The value as read (a guest, or the host once a session is under way) */
  read: React.ReactNode;
  /** The host's control; absent: the host reads it too */
  edit?: React.ReactNode;
  hint?: React.ReactNode;
}

/** A setting as read: label and value on one line, so a guest takes in the whole race at a glance */
function ReadRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-4 border-b border-white/5 py-1.5 last:border-b-0">
      <dt className="shrink-0 text-[13px] font-medium text-lc-slate">{label}</dt>
      <dd className="m-0 flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-end text-[14px] leading-tight font-semibold text-lc-chalk">
        {children}
      </dd>
    </div>
  );
}

/** A card of settings: the host's controls while the room is open, else the compact read-out */
function SettingsCard({
  title,
  description,
  rows,
  editable,
}: {
  title: string;
  description?: string;
  rows: (LobbyRow | null)[];
  editable: boolean;
}) {
  const shown = rows.filter((r): r is LobbyRow => r !== null);
  return (
    <Card title={title} description={description}>
      {editable ? (
        shown.map((r) => (
          <SettingRow key={r.id} label={r.label} hint={r.hint}>
            {r.edit ?? <ReadValue>{r.read}</ReadValue>}
          </SettingRow>
        ))
      ) : (
        <dl className="m-0 flex flex-col">
          {shown.map((r) => (
            <ReadRow key={r.id} label={r.label}>
              {r.read}
            </ReadRow>
          ))}
        </dl>
      )}
    </Card>
  );
}

interface LobbySettingsCardsProps {
  state: LobbyState;
  settings: ReturnType<typeof withLobbyDefaults<LobbySettings>>;
  editable: boolean;
  isHost: boolean;
  qualifyingActive: boolean;
  locked: boolean;
  onSetLobbySettings?: (patch: Partial<LobbySettings>) => void;
  onPickCircuit?: () => void;
  carsForClass?: (rule: CarClassRule) => { id: string; title: string }[];
  vehicleLabel?: (id: string) => string;
}

/**
 * The room's race in the order the AI race sets one up: the event (circuit, cars, conditions), the race (laps,
 * qualifying, grid, start) and its rules. The host sets it while the room is open; everyone else reads it.
 */
function LobbySettingsCards({
  state,
  settings,
  editable,
  isHost,
  qualifyingActive,
  locked,
  onSetLobbySettings,
  onPickCircuit,
  carsForClass,
  vehicleLabel,
}: LobbySettingsCardsProps) {
  const tx = useTranslations("hud.multiplayerPanel.settings");
  const set = (patch: Partial<LobbySettings>) => onSetLobbySettings?.(patch);
  const rules = settings.rules;
  const updateRules = (patch: Partial<MpRaceRules>) => set({ rules: { ...rules, ...patch } });
  const isPrivate = state.roomKind !== "public";
  const weather = settings.weather ?? state.weather?.conditions.weather ?? "clear";
  const timeOfDay = settings.timeOfDay ?? state.weather?.conditions.timeOfDay ?? "golden_hour";
  const timeScale = settings.timeScale ?? state.weather?.conditions.timeScale ?? 0;
  const known = TRACKS.some((t) => t.id === settings.trackId);
  const track = getTrackInfo(settings.trackId);
  const circuit = trackName(settings.trackId);
  const distance = useRaceDistance(settings.laps, known ? track.lengthM : undefined);
  const launch: RaceStartMode = settings.manualStart ? "manual" : "assisted";

  const cars = settings.vehicle ? (vehicleLabel?.(settings.vehicle) ?? settings.vehicle) : classRuleLabel(settings.carClass);
  const carsHint = settings.vehicle
    ? tx("oneCar")
    : settings.carClass === "any"
      ? tx("classesMixed")
      : carsForClass?.(settings.carClass)
          .map((c) => c.title)
          .join(", ") || undefined;
  const qualityBadge = known ? <TrackQualityBadge track={track} size="xs" /> : null;

  const event: (LobbyRow | null)[] = [
    {
      id: "circuit",
      label: tx("circuit"),
      read: (
        <>
          {circuit}
          {qualityBadge}
        </>
      ),
      edit: onPickCircuit ? (
        <>
          {qualityBadge}
          <Button size="sm" variant="secondary" onClick={onPickCircuit} aria-label={tx("changeCircuit", { circuit })}>
            {tx("change")}
          </Button>
        </>
      ) : undefined,
      hint: onPickCircuit ? circuit : tx("circuitHint"),
    },
    {
      id: "cars",
      label: tx("cars"),
      read: cars,
      edit: settings.vehicle ? undefined : (
        <Select<CarClassRule> value={settings.carClass} options={classRuleOptions()} onChange={(carClass) => set({ carClass })} />
      ),
      hint: carsHint,
    },
    {
      id: "weather",
      label: tx("weather"),
      read: WEATHER_LABELS[weather].label,
      edit: (
        <Select<WeatherPresetId>
          value={weather}
          options={WEATHER_PRESETS.map((id) => ({ id, label: WEATHER_LABELS[id].label }))}
          onChange={(w) => set({ weather: w })}
        />
      ),
    },
    {
      id: "timeOfDay",
      label: tx("timeOfDay"),
      read: TIME_OF_DAY_LABELS[timeOfDay],
      edit: (
        <Select<TimeOfDayId>
          value={timeOfDay}
          options={TIME_OF_DAY_PRESETS.map((id) => ({ id, label: TIME_OF_DAY_LABELS[id] }))}
          onChange={(tod) => set({ timeOfDay: tod })}
        />
      ),
    },
    {
      id: "timeSpeed",
      label: tx("timeSpeed"),
      read: timeScale === 0 ? tr("hud.multiplayerPanel.timeScaleFixed") : `${timeScale}x`,
      edit: <Select<string> value={String(timeScale)} options={TIME_SCALE_OPTIONS} onChange={(v) => set({ timeScale: Number(v) })} />,
    },
  ];

  const race: (LobbyRow | null)[] = [
    {
      id: "laps",
      label: tx("laps"),
      read: distance ? `${settings.laps} · ${distance}` : settings.laps,
      edit: <Stepper value={settings.laps} min={MIN_LAPS} max={MAX_LAPS} onChange={(laps) => set({ laps: Math.min(MAX_LAPS, Math.max(MIN_LAPS, laps)) })} />,
      hint: distance ?? undefined,
    },
    isPrivate
      ? {
          id: "qualifying",
          label: tx("qualifying"),
          read: settings.qualifyingMinutes > 0 ? `${settings.qualifyingMinutes} min` : tr("hud.multiplayerPanel.qualifyingOff"),
          edit: (
            <Segmented<string>
              value={String(settings.qualifyingMinutes)}
              options={QUALIFYING_OPTIONS}
              onChange={(v) => set({ qualifyingMinutes: Number(v) as MpQualifyingMinutes })}
            />
          ),
          hint: settings.qualifyingMinutes > 0 ? tx("qualifyingHint") : undefined,
        }
      : null,
    isPrivate && settings.qualifyingMinutes > 0
      ? { id: "gridOrder", label: tx("gridOrder"), read: tx("setByQualifying") }
      : {
          id: "gridOrder",
          label: tx("gridOrder"),
          read: optionLabel(GRID_ORDER_OPTIONS, settings.gridOrder),
          edit: (
            <Segmented<MpGridOrder>
              value={settings.gridOrder}
              options={GRID_ORDER_OPTIONS.map((o) => ({ id: o.value, label: o.label }))}
              onChange={(gridOrder) => set({ gridOrder })}
            />
          ),
          hint: gridOrderHint(settings.gridOrder),
        },
    {
      id: "start",
      label: tx("start"),
      read: optionLabel(START_TYPE_OPTIONS, settings.startType),
      edit: (
        <Segmented<MpStartType>
          value={settings.startType}
          options={START_TYPE_OPTIONS.map((o) => ({ id: o.value, label: o.label }))}
          onChange={(startType) => set({ startType, manualStart: startType === "rolling" ? false : settings.manualStart })}
        />
      ),
    },
    settings.startType === "standing"
      ? {
          id: "launch",
          label: tx("launch"),
          read: RACE_START_MODE_LABELS[launch],
          edit: (
            <Segmented<RaceStartMode>
              value={launch}
              options={RACE_START_MODES.map((id) => ({ id, label: RACE_START_MODE_LABELS[id] }))}
              onChange={(m) => set({ manualStart: m === "manual" })}
            />
          ),
          hint: RACE_START_MODE_HINTS[launch],
        }
      : null,
  ];

  const rulesRows: (LobbyRow | null)[] = [
    {
      id: "rules",
      label: tx("rulePreset"),
      read: optionLabel(MP_RULE_PRESET_OPTIONS, rules.preset),
      edit: (
        <Select<MpRaceRules["preset"]>
          value={rules.preset}
          options={MP_RULE_PRESET_OPTIONS.map((o) => ({ id: o.value, label: o.label }))}
          onChange={(preset) => updateRules({ preset })}
        />
      ),
      hint: mpRulePresetHint(rules.preset),
    },
    {
      id: "trackLimits",
      label: tx("trackLimits"),
      read: TRACK_LIMITS_CHOICE_LABELS[rules.trackLimits],
      edit: (
        <Segmented<TrackLimitsChoice>
          value={rules.trackLimits}
          options={(["auto", "off"] as const).map((id) => ({ id, label: TRACK_LIMITS_CHOICE_LABELS[id] }))}
          onChange={(trackLimits) => updateRules({ trackLimits })}
        />
      ),
    },
    {
      id: "penalties",
      label: tx("penalties"),
      read: rules.penalties !== false ? tx("penaltiesOn") : tx("penaltiesOff"),
      edit: <Toggle checked={rules.penalties !== false} onChange={(penalties) => updateRules({ penalties })} />,
      hint: tx("penaltiesHint"),
    },
    {
      id: "damage",
      label: tx("damage"),
      read: DAMAGE_LEVEL_LABELS[rules.damage ?? "off"],
      edit: (
        <Segmented<DamageLevel>
          value={rules.damage ?? "off"}
          options={DAMAGE_LEVELS.map((id) => ({ id, label: DAMAGE_LEVEL_LABELS[id] }))}
          onChange={(damage) => updateRules({ damage })}
        />
      ),
    },
    {
      id: "collisions",
      label: tx("collisions"),
      read: collisionLabel(settings.collisions),
      edit: (
        <Select<CollisionMode>
          value={settings.collisions}
          options={COLLISION_OPTIONS.map((o) => ({ id: o.value, label: o.label }))}
          onChange={(collisions) => set({ collisions })}
        />
      ),
      hint: collisionHint(settings.collisions),
    },
  ];

  const lockedNote = isHost && locked ? (qualifyingActive ? tx("lockedQualifying") : tx("lockedRace")) : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SettingsCard title={tx("event")} description={lockedNote} rows={event} editable={editable} />
      <SettingsCard title={tx("race")} rows={race} editable={editable} />
      <SettingsCard title={tx("rules")} rows={rulesRows} editable={editable} />
    </div>
  );
}

/** Private rooms: host one and share its link, or join a friend's with their code; the lobby once in one */
export const MultiplayerPanel: React.FC<MultiplayerPanelProps> = ({
  p2pStatus,
  initialRoomCode = "",
  onHostP2PRoom,
  onJoinP2PRoom,
  onCreateManualOffer,
  onAcceptManualOffer,
  onAcceptManualAnswer,
  lobby,
  localPeerId,
  peerStats,
  profile,
  currentTrackId,
  currentVehicle,
  vehicleLabel,
  vehiclesForClass,
  carsForClass,
  raceRunning = false,
  startBlocked,
  onHostLocal,
  onSetLobbySettings,
  onSetReady,
  onStartRace,
  onAbortRace,
  onSwitchTrack,
  onSwitchCar,
  onPickCircuit,
  onOpenProfile,
  races,
}) => {
  const tx = useTranslations("hud.multiplayerPanel");
  // Connect box
  const [roomCodeInput, setRoomCodeInput] = useState(initialRoomCode);
  /** What the player did last in the room card: a failed join is told at the code field */
  const [lastAction, setLastAction] = useState<"host" | "join" | null>(null);
  /** Why the typed code can't be joined, before anything is asked of the network */
  const [joinHint, setJoinHint] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const joinReady = roomCodeInput.trim().length >= 3;
  const [copiedLink, flashCopiedLink] = useFlash(2000);
  const [canShare, setCanShare] = useState(false);

  // Manual connection (advanced)
  const [sdpInput, setSdpInput] = useState("");
  const [sdp, setSdp] = useState<ManualSdp>({ stage: "idle" });
  const [sdpError, setSdpError] = useState("");
  const [copiedToken, flashCopiedToken, cancelCopiedToken] = useFlash(1800);
  const [sdpBusy, setSdpBusy] = useState(false);
  const generatedToken = sdp.stage === "offered" || sdp.stage === "answered" ? sdp.token : "";

  // TURN relay (advanced)
  const [turnUrl, setTurnUrl] = useState("");
  const [turnUser, setTurnUser] = useState("");
  const [turnCred, setTurnCred] = useState("");
  const [turnConfigured, setTurnConfigured] = useState(false);
  const [turnError, setTurnError] = useState("");
  const [turnSaved, flashTurnSaved, cancelTurnSaved] = useFlash(1800);

  // Ready toggle: the lobby's value, except for a few seconds after a press while the host has not echoed it yet
  const serverReady = lobby?.players.find((p) => p.peerId === localPeerId)?.ready ?? false;
  const [pendingReady, setPendingReady] = useState<boolean | null>(null);
  const ready = pendingReady ?? serverReady;

  // Driver badges for peers in the room: batch-fetched once per distinct set of player names
  const [driverBadges, setDriverBadges] = useState<Record<string, DriverBadge[]>>({});
  const lobbyPlayerNamesKey = lobby
    ? Array.from(new Set(lobby.players.map((p) => driverNameKey(p.name)).filter(Boolean)))
        .sort()
        .join("\n")
    : "";
  useEffect(() => {
    if (!lobbyPlayerNamesKey) return;
    let live = true;
    void fetchBadges(lobbyPlayerNamesKey.split("\n")).then((map) => {
      if (live) setDriverBadges(Object.fromEntries(Object.entries(map).map(([key, list]) => [key, roomNameBadges(list)])));
    });
    return () => {
      live = false;
    };
  }, [lobbyPlayerNamesKey]);

  // Browser-only values are read after mount so server and client markup match
  useEffect(() => {
    const saved = loadUserTurnServer();
    if (saved) {
      setTurnUrl(Array.isArray(saved.urls) ? (saved.urls[0] ?? "") : saved.urls);
      setTurnUser(typeof saved.username === "string" ? saved.username : "");
      setTurnCred(typeof saved.credential === "string" ? saved.credential : "");
    }
    setTurnConfigured(hasTurnServer());
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);

  // The host echoed the press (the lobby now agrees), or never did: either way the lobby's value shows again
  useEffect(() => {
    if (pendingReady === null) return;
    if (pendingReady === serverReady) {
      setPendingReady(null);
      return;
    }
    const id = window.setTimeout(() => setPendingReady(null), READY_ECHO_MS);
    return () => window.clearTimeout(id);
  }, [pendingReady, serverReady]);

  /** Runs one manual step; a failure shows under the steps instead of being lost */
  const runSdp = async (fn: () => Promise<void>, failText: string) => {
    setSdpBusy(true);
    setSdpError("");
    try {
      await fn();
    } catch {
      setSdpError(failText);
    } finally {
      setSdpBusy(false);
    }
  };
  const resetSdp = () => {
    setSdp({ stage: "idle" });
    setSdpInput("");
    setSdpError("");
    cancelCopiedToken();
  };

  // Only a room this player hosts or has joined can be shared, never a code still being typed
  const activeCode = (p2pStatus?.roomCode ?? "").replace(/^(RWA|LC)-/i, "").toUpperCase();

  // Once in a room, its own code leaves the join field (an invite link put it there)
  useEffect(() => {
    if (activeCode) setRoomCodeInput((typed) => (typed.trim().toUpperCase() === activeCode ? "" : typed));
  }, [activeCode]);

  const getInviteUrl = (): string | null => {
    if (!activeCode || typeof window === "undefined") return null;
    return `${window.location.origin}${window.location.pathname}?room=LC-${activeCode}`;
  };

  const copyLink = () => {
    const url = getInviteUrl();
    if (!url) return;
    navigator.clipboard?.writeText(url).catch(() => undefined);
    flashCopiedLink();
  };

  const shareInvite = async () => {
    const url = getInviteUrl();
    if (!url || typeof navigator === "undefined" || typeof navigator.share !== "function") return;
    try {
      await navigator.share({ title: tx("room.shareTitle"), text: tx("room.shareText"), url });
    } catch {
      // Share sheet dismissed or unavailable
    }
  };

  const toggleReady = () => {
    const next = !ready;
    setPendingReady(next);
    onSetReady?.(next);
  };

  const saveTurn = () => {
    const url = turnUrl.trim();
    if (!/^turns?:/i.test(url)) {
      setTurnError(tx("connect.turnPrefix"));
      return;
    }
    setTurnError("");
    saveUserTurnServer({
      urls: url,
      username: turnUser.trim() || undefined,
      credential: turnCred || undefined,
    });
    setTurnConfigured(hasTurnServer());
    flashTurnSaved();
  };

  const clearTurn = () => {
    saveUserTurnServer(null);
    setTurnUrl("");
    setTurnUser("");
    setTurnCred("");
    setTurnError("");
    cancelTurnSaved();
    setTurnConfigured(hasTurnServer());
  };

  // A new room always gets a fresh code: the field below is only for joining a friend's
  const hostRoom = () => {
    onHostP2PRoom?.();
    setRoomCodeInput("");
    setJoinHint(null);
    setLastAction("host");
  };
  const joinRoom = () => {
    if (!joinReady) {
      setJoinHint(tx("room.codeTooShort"));
      return;
    }
    setJoinHint(null);
    setLastAction("join");
    onJoinP2PRoom?.(roomCodeInput.trim());
  };

  const connected = p2pStatus?.connectedWebRtcPeers ?? 0;
  const hostedCode = p2pStatus?.roomCode;
  const p2pState = p2pStatus?.state ?? "idle";
  // A failed join is said under the code field; any other failure under the room card
  const joinFailed = lastAction === "join" && p2pState === "error";
  const joinError = joinHint ?? (joinFailed ? p2pStatus?.statusText || tx("room.joinFailed") : undefined);

  // The room's race, worked out once for the drivers card and the settings beside it
  const view = lobby ? lobbyView(lobby) : null;
  function lobbyView(state: LobbyState) {
    const settings = withLobbyDefaults(state.settings);
    const qualifyingActive = state.session?.phase === "qualifying";
    const locked = raceRunning || qualifyingActive;
    // Who hosts comes from one place, the lobby's host id: the host badge, "You are host" and the host's controls agree
    const isHost = localPeerId !== undefined && state.hostId === localPeerId;
    // Every model of the class may race (a car only listed elsewhere too). A scheduled race's one car is taken at the
    // start by itself, so it flags nobody here
    const allowedVehicles = vehiclesForClass ? vehiclesForClass(settings.carClass) : null;
    return { state, settings, qualifyingActive, locked, isHost, editable: isHost && !locked, allowedVehicles };
  }

  /** The drivers in the room, the warnings for this player, and the start (host) or ready (guest) button */
  const renderDrivers = ({ state, settings, qualifyingActive, isHost, allowedVehicles }: NonNullable<typeof view>) => {
    const isPrivate = state.roomKind !== "public";
    const qualifyingTimes = new Map((state.session?.times ?? []).map((t) => [t.peer, t.ms]));
    const isHostPlayer = (p: LobbyPlayer) => p.peerId === state.hostId;
    const hostPlayer = state.players.find(isHostPlayer);
    const outOfClass = (vehicle: string | undefined) => !!allowedVehicles && !!vehicle && !allowedVehicles.includes(vehicle);
    const lobbyBadgeContext: BadgeContext =
      settings.vehicle && isVehicleModelId(settings.vehicle)
        ? { scope: "vehicle", vehicle: settings.vehicle }
        : settings.carClass !== "any"
          ? { scope: "class", classId: settings.carClass }
          : { scope: "all" };

    // Warnings for this player, compared with the host's race settings
    const trackMismatch = currentTrackId !== undefined && currentTrackId !== settings.trackId;
    // A mod circuit this copy hasn't got, or has in another version: no switching to it
    const roomTrack = roomTrackStatus(settings.trackId, settings.trackMod);
    const vehicleBlocked = outOfClass(currentVehicle);
    const switchCars = carsForClass?.(settings.carClass) ?? [];

    const orderedPlayers = qualifyingActive
      ? [...state.players].sort((a, b) => {
          const am = qualifyingTimes.get(a.peerId) ?? null;
          const bm = qualifyingTimes.get(b.peerId) ?? null;
          if (am !== null && bm !== null) return am - bm;
          if (am !== null) return -1;
          if (bm !== null) return 1;
          return 0;
        })
      : state.players;

    return (
      <Card
        title={tx("drivers.title")}
        description={hostPlayer?.name ? tx("drivers.host", { name: hostPlayer.name }) : undefined}
        action={
          <>
            {qualifyingActive ? <Badge tone="info">{tx("drivers.qualifying")}</Badge> : null}
            <Badge variant="outline">{state.players.length}</Badge>
          </>
        }
        bodyClassName="gap-3"
      >
        <ul className="m-0 flex list-none flex-col p-0">
          {orderedPlayers.map((p) => {
            const isMe = p.peerId === localPeerId;
            const carName = p.vehicle ? (vehicleLabel?.(p.vehicle) ?? p.vehicle) : tx("drivers.noCar");
            const qLapMs = qualifyingActive ? (qualifyingTimes.get(p.peerId) ?? null) : null;
            return (
              <li key={p.peerId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-white/5 py-2.5 last:border-b-0">
                {/* The driver's own colour: data */}
                <span aria-hidden className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                <div className="flex min-w-0 flex-[1_1_120px] flex-col">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="lc-mono shrink-0 text-[12px] font-bold tracking-[0.08em] text-lc-slate">{p.code}</span>
                    <span className="truncate text-[14px] font-semibold text-lc-chalk" title={p.name}>
                      {p.name}
                    </span>
                    <DriverBadges
                      badges={Object.hasOwn(driverBadges, driverNameKey(p.name)) ? driverBadges[driverNameKey(p.name)] : []}
                      compact
                      context={lobbyBadgeContext}
                      driverName={p.name}
                      circuitName={trackName}
                    />
                    {isMe ? <PlayerTag size="sm" /> : null}
                  </span>
                  <span className="lc-hint truncate" title={carName}>
                    {carName}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {qualifyingActive ? (
                    <Badge size="sm" tone={qLapMs !== null ? "info" : undefined} variant={qLapMs !== null ? undefined : "outline"} className="lc-mono">
                      {qLapMs !== null ? formatLapTime(qLapMs) : tx("drivers.noTime")}
                    </Badge>
                  ) : null}
                  {isHostPlayer(p) ? <SessionBadge session="host" size="sm" /> : null}
                  {outOfClass(p.vehicle) ? (
                    <Badge size="sm" tone="warn" icon="warning" title={tx("drivers.wrongClassTitle", { class: classRuleLabel(settings.carClass) })}>
                      {tx("drivers.wrongClass")}
                    </Badge>
                  ) : null}
                  {!isMe ? <NetBadge stats={peerStats?.find((s) => s.peerId === p.peerId)} /> : null}
                  {!qualifyingActive ? (
                    p.ready ? (
                      <Badge size="sm" tone="good" icon="success">
                        {tx("drivers.ready")}
                      </Badge>
                    ) : (
                      <Badge size="sm" variant="outline">
                        {tx("drivers.notReady")}
                      </Badge>
                    )
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {/* What the badges beside the names mean: their tooltips need a mouse */}
        <BadgeLegend
          badges={orderedPlayers.flatMap((p) => (Object.hasOwn(driverBadges, driverNameKey(p.name)) ? driverBadges[driverNameKey(p.name)] : []))}
          context={lobbyBadgeContext}
        />

        {/* On another circuit, or on the room's mod circuit in another version of its package (a different road) */}
        {trackMismatch || roomTrack !== "ok" ? (
          <Well className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3.5 py-2.5">
            <span className="flex items-start gap-2 text-[13px] leading-snug font-medium text-lc-caution">
              <Icon name="warning" className="mt-px" />
              {roomTrack === "ok"
                ? tx("drivers.hostOn", { circuit: trackName(settings.trackId) })
                : tx(roomTrack === "missing" ? "drivers.modMissing" : "drivers.modDifferent", {
                    // The package and its version, as far as the host said
                    mod: settings.trackMod ? [settings.trackMod.name, settings.trackMod.version].filter(Boolean).join(" ") : settings.trackId,
                  })}
            </span>
            {onSwitchTrack && roomTrack === "ok" ? (
              <Button size="sm" variant="secondary" onClick={() => onSwitchTrack(settings.trackId)}>
                {tx("drivers.switchCircuit")}
              </Button>
            ) : null}
          </Well>
        ) : null}
        {vehicleBlocked ? (
          <Well className="flex flex-col gap-2.5 px-3.5 py-2.5">
            <span className="flex items-start gap-2 text-[13px] leading-snug font-medium text-lc-caution">
              <Icon name="warning" className="mt-px" />
              {tx(switchCars.length > 0 ? "drivers.wrongCarSwitch" : "drivers.wrongCar", { class: classRuleLabel(settings.carClass) })}
            </span>
            {switchCars.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {switchCars.map((c) => (
                  <Button key={c.id} size="sm" variant="secondary" disabled={!onSwitchCar} onClick={() => onSwitchCar?.(c.id)}>
                    {c.title}
                  </Button>
                ))}
              </div>
            ) : null}
          </Well>
        ) : null}

        {isHost ? (
          <div className="flex flex-col gap-2 pt-1">
            <Button
              variant="primary"
              size="lg"
              block
              icon={raceRunning ? undefined : <Icon name="drive" />}
              disabled={raceRunning}
              disabledReason={!raceRunning ? startBlocked : undefined}
              onClick={() => onStartRace?.()}
            >
              {raceRunning
                ? tx("drivers.raceInProgress")
                : qualifyingActive
                  ? tx("drivers.startRaceNow")
                  : settings.qualifyingMinutes > 0 && isPrivate
                    ? tx("drivers.startQualifying", { minutes: settings.qualifyingMinutes })
                    : tx("drivers.startRace")}
            </Button>
            {(raceRunning || qualifyingActive) && onAbortRace ? (
              <Button variant="danger" block onClick={() => setConfirmEnd(true)}>
                {qualifyingActive ? tx("drivers.endQualifying") : tx("drivers.endRaceForEveryone")}
              </Button>
            ) : null}
            {!raceRunning && !qualifyingActive && startBlocked ? (
              <p className="m-0 text-center text-[12px] font-medium text-lc-caution">{startBlocked}</p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-2 pt-1">
            <Button
              variant={ready ? "secondary" : "primary"}
              size="lg"
              block
              aria-pressed={ready}
              icon={ready ? <Icon name="success" /> : undefined}
              // Another version of the room's mod circuit is another road: no lining up on it
              disabled={!onSetReady || (roomTrack !== "ok" && !ready)}
              onClick={toggleReady}
            >
              {ready ? tx("drivers.readyButton") : tx("drivers.readyUp")}
            </Button>
            <p className="lc-hint m-0 text-center">
              {raceRunning ? tx("drivers.raceRunning") : qualifyingActive ? tx("drivers.qualifyingRunning") : tx("drivers.waitingForHost")}
            </p>
          </div>
        )}
        <ConfirmDialog
          open={confirmEnd}
          title={qualifyingActive ? tx("drivers.confirmEndQualifying") : tx("drivers.confirmEndRace")}
          confirmLabel={qualifyingActive ? tx("drivers.confirmEndQualifyingButton") : tx("drivers.confirmEndRaceButton")}
          cancelLabel={qualifyingActive ? tx("drivers.keepQualifying") : tx("drivers.keepRacing")}
          icon={<Icon name="warning" />}
          onCancel={() => setConfirmEnd(false)}
          onConfirm={() => {
            setConfirmEnd(false);
            onAbortRace?.();
          }}
        >
          {tx("drivers.confirmBody")}
        </ConfirmDialog>
      </Card>
    );
  };

  const roomStatus =
    hostedCode || connected > 0 || p2pState !== "idle" ? (
      p2pState === "connected" ? (
        <Badge tone="good" dot>
          {tx("room.connected", { count: connected })}
        </Badge>
      ) : p2pState === "signaling" ? (
        <Badge tone="warn" dot>
          {tx("room.connecting")}
        </Badge>
      ) : p2pState === "error" ? (
        <Badge tone="bad" icon="error">
          {tx("room.notConnected")}
        </Badge>
      ) : (
        <Badge variant="outline">{tx("room.connected", { count: connected })}</Badge>
      )
    ) : null;

  return (
    <div
      className={`grid items-start gap-3 text-lc-chalk ${
        lobby || races ? "grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))]" : "max-w-xl grid-cols-1"
      }`}
    >
      {/* The connection the player waits on, read out as it changes (the badge on the room card says it on screen;
          an error is also an alert under the field or the room) */}
      <span className="sr-only" aria-live="polite">
        {p2pState === "connected" ? tx("room.connected", { count: connected }) : p2pState === "signaling" ? tx("room.connecting") : ""}
      </span>
      {/* Open races: not while in a friend's room, whose lobby takes this place */}
      {races && !lobby ? <RacesCard {...races} /> : null}

      {/* Room */}
      <div className="flex min-w-0 flex-col gap-3">
        <Card title={tx("room.title")} action={roomStatus} bodyClassName="gap-3.5">
          {hostedCode ? (
            <>
              <Well className="flex flex-col gap-1 px-4 py-3">
                <span
                  className="lc-mono text-[40px] leading-none font-bold tracking-[0.14em] break-all text-lc-chalk sm:text-[46px]"
                  aria-label={tx("room.codeAria", { code: hostedCode })}
                >
                  {hostedCode}
                </span>
                <span className="lc-hint">{tx("room.codeCaption")}</span>
              </Well>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={lobby ? "secondary" : "primary"}
                  className="flex-1"
                  disabled={!activeCode}
                  icon={<Icon name={copiedLink ? "copied" : "copy"} />}
                  onClick={copyLink}
                >
                  {copiedLink ? tx("room.linkCopied") : tx("room.copyLink")}
                </Button>
                {canShare ? (
                  <Button variant="secondary" className="flex-1" disabled={!activeCode} icon={<Icon name="share" />} onClick={() => void shareInvite()}>
                    {tx("room.share")}
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <Button variant={races || lobby || joinReady ? "secondary" : "primary"} block onClick={hostRoom}>
              {tx("room.host")}
            </Button>
          )}
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              joinRoom();
            }}
          >
            <TextField
              id="lc-room-code"
              label={hostedCode ? tx("room.joinAnother") : tx("room.joinFriend")}
              value={roomCodeInput}
              onChange={(v) => {
                setRoomCodeInput(v.toUpperCase());
                setJoinHint(null);
                if (lastAction === "join") setLastAction(null);
              }}
              placeholder={tx("room.codePlaceholder")}
              maxLength={6}
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              error={joinError}
              trailing={
                <Button type="submit" size="sm" variant={joinReady && !hostedCode && !races && !lobby ? "primary" : "secondary"} className="-me-2">
                  {tx("room.join")}
                </Button>
              }
            />
          </form>
          {hostedCode ? (
            <Button size="sm" variant="ghost" className="self-start" onClick={hostRoom}>
              {tx("room.newRoom")}
            </Button>
          ) : null}
          {/* What the connection is doing; nothing to say before a room is hosted or joined (a failed join says it at the field) */}
          {p2pStatus?.statusText && p2pState !== "idle" && p2pState !== "connected" && !joinFailed ? (
            <p
              role={p2pState === "error" ? "alert" : undefined}
              className={`m-0 flex items-start gap-2 text-[13px] leading-snug ${p2pState === "error" ? "font-medium text-lc-loss" : "text-lc-slate"}`}
            >
              {p2pState === "error" ? <Icon name="error" size="xs" className="mt-0.5" /> : null}
              {p2pStatus.statusText}
            </p>
          ) : null}
        </Card>

        {profile ? (
          <Well className="flex min-h-11 min-w-0 items-center gap-2.5 py-1 pe-1 ps-3.5" aria-label={tx("room.racingAs", { name: profile.name })}>
            {/* The driver's own colour: data */}
            <span aria-hidden className="size-3 shrink-0 rounded-full" style={{ backgroundColor: profile.color }} />
            <span className="lc-mono text-[12px] font-bold tracking-[0.08em] text-lc-slate">{profile.code}</span>
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{profile.name}</span>
            {onOpenProfile ? (
              <Button size="sm" variant="ghost" icon={<Icon name="edit" />} onClick={onOpenProfile}>
                {tx("room.edit")}
              </Button>
            ) : null}
          </Well>
        ) : null}

        {view ? renderDrivers(view) : null}

        <div className="flex flex-col gap-1 px-2">
          <Disclosure moreLabel={tx("connect.more")} lessLabel={tx("connect.hide")}>
            <div className="flex flex-col gap-3.5 pb-2">
              <ConnectSection title={tx("connect.localTitle")} intro={tx("connect.localIntro")}>
                <Button size="sm" variant="secondary" className="self-start" disabled={!onHostLocal} onClick={() => onHostLocal?.()}>
                  {tx("connect.localConnect")}
                </Button>
              </ConnectSection>

              <ConnectSection title={tx("connect.manualTitle")} intro={tx("connect.manualIntro")}>
                <div className="flex flex-wrap items-center gap-2">
                  {/* A guest that answered an offer does not start one of its own (Start over first) */}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={sdpBusy || sdp.stage === "answered"}
                    onClick={() =>
                      runSdp(async () => {
                        const offer = await onCreateManualOffer?.();
                        if (offer) {
                          setSdp({ stage: "offered", token: offer });
                          setSdpInput("");
                          cancelCopiedToken();
                        }
                      }, tx("connect.offerFailed"))
                    }
                  >
                    {tx("connect.createOffer")}
                  </Button>
                  {/* A host waiting on the answer to its own offer does not paste an offer (Start over first) */}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={sdpBusy || !sdpInput.trim() || sdp.stage === "offered"}
                    onClick={() =>
                      runSdp(async () => {
                        const ans = await onAcceptManualOffer?.(sdpInput.trim());
                        if (ans) {
                          setSdp({ stage: "answered", token: ans });
                          setSdpInput("");
                          cancelCopiedToken();
                        }
                      }, tx("connect.badOffer"))
                    }
                  >
                    {tx("connect.acceptOffer")}
                  </Button>
                  {/* Only the host that made the offer accepts an answer */}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={sdpBusy || !sdpInput.trim() || sdp.stage !== "offered"}
                    onClick={() =>
                      runSdp(async () => {
                        const ok = await onAcceptManualAnswer?.(sdpInput.trim());
                        if (ok === false) throw new Error("answer refused");
                        setSdp({ stage: "accepted" });
                        setSdpInput("");
                        cancelCopiedToken();
                      }, tx("connect.badAnswer"))
                    }
                  >
                    {tx("connect.acceptAnswer")}
                  </Button>
                </div>
                <TextField
                  label={tx("connect.remoteToken")}
                  value={sdpInput}
                  onChange={(v) => {
                    setSdpInput(v);
                    setSdpError("");
                  }}
                  placeholder={tx("connect.pasteToken")}
                  autoComplete="off"
                  spellCheck={false}
                  error={sdpError || undefined}
                />
                {sdp.stage === "accepted" ? (
                  <p className="m-0 flex items-center gap-2 text-[13px] font-medium text-lc-gain">
                    <Icon name="success" size="xs" />
                    {tx("connect.answerAccepted")}
                  </p>
                ) : null}
                {generatedToken ? (
                  <TextField
                    label={tx("connect.yourToken")}
                    value={generatedToken}
                    onChange={() => undefined}
                    readOnly
                    trailing={
                      <Button
                        size="sm"
                        variant="secondary"
                        className="-me-2"
                        icon={<Icon name={copiedToken ? "copied" : "copy"} />}
                        onClick={() => {
                          navigator.clipboard?.writeText(generatedToken).catch(() => undefined);
                          flashCopiedToken();
                        }}
                      >
                        {copiedToken ? tx("connect.copied") : tx("connect.copy")}
                      </Button>
                    }
                  />
                ) : null}
                {sdp.stage !== "idle" ? (
                  <Button size="sm" variant="ghost" className="self-start" disabled={sdpBusy} onClick={resetSdp}>
                    {tx("connect.reset")}
                  </Button>
                ) : null}
              </ConnectSection>

              <ConnectSection title={tx("connect.turnTitle")} intro={tx("connect.turnIntro")}>
                <div className="grid gap-2.5 sm:grid-cols-3">
                  <TextField
                    label={tx("connect.relayAddress")}
                    value={turnUrl}
                    onChange={(v) => {
                      setTurnUrl(v);
                      setTurnError("");
                    }}
                    placeholder="turn:host:3478"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    error={turnError || undefined}
                  />
                  <TextField label={tx("connect.username")} value={turnUser} onChange={setTurnUser} autoComplete="off" spellCheck={false} />
                  <TextField label={tx("connect.password")} type="password" value={turnCred} onChange={setTurnCred} autoComplete="new-password" />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={turnSaved ? <Icon name="success" /> : undefined}
                    disabled={!turnUrl.trim()}
                    onClick={saveTurn}
                  >
                    {turnSaved ? tx("connect.saved") : tx("connect.save")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={clearTurn}>
                    {tx("connect.clear")}
                  </Button>
                </div>
              </ConnectSection>
            </div>
          </Disclosure>
          {turnConfigured ? (
            <p className="lc-hint m-0 flex items-center gap-1.5">
              <Icon name="relay" size="xs" />
              {tx("connect.ownRelay")}
            </p>
          ) : null}
        </div>
      </div>

      {view ? (
        <LobbySettingsCards
          state={view.state}
          settings={view.settings}
          editable={view.editable}
          isHost={view.isHost}
          qualifyingActive={view.qualifyingActive}
          locked={view.locked}
          onSetLobbySettings={onSetLobbySettings}
          onPickCircuit={view.editable ? onPickCircuit : undefined}
          carsForClass={carsForClass}
          vehicleLabel={vehicleLabel}
        />
      ) : null}
    </div>
  );
};
