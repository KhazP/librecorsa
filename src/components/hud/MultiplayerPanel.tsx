"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, Crown, Minus, Pencil, Play, Plus, Share2 } from "lucide-react";
import {
  hasTurnServer,
  loadUserTurnServer,
  saveUserTurnServer,
  type CarClassRule,
  type CollisionMode,
  type LobbyPlayer,
  type LobbySettings,
  type LobbyState,
  type P2PConnectionStatus,
  type PeerNetStats,
} from "@/lib/sim/multiplayer-sync";
import { getTrackInfo, TRACKS } from "@/lib/track-registry";
import { Segmented, TrackQualityBadge } from "@/components/menu/menu-ui";
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
  /** Vehicle ids allowed by a car-class rule */
  vehiclesForClass?: (rule: CarClassRule) => string[];
  raceRunning?: boolean;
  onHostLocal?: () => void;
  onSetLobbySettings?: (patch: Partial<LobbySettings>) => void;
  onSetReady?: (ready: boolean) => void;
  onStartRace?: () => void;
  onAbortRace?: () => void;
  onSwitchTrack?: (trackId: string) => void;
  onSwitchVehicle?: (vehicle: string) => void;
  onOpenProfile?: () => void;
  /** The open scheduled races (only where they run, and only from the title menu) */
  races?: RacesCardProps;
}

const MIN_LAPS = 1;
const MAX_LAPS = 50;

const COLLISION_OPTIONS: { value: CollisionMode; label: string }[] = [
  { value: "on", label: "On" },
  { value: "ghost_lap1", label: "Ghosted lap 1" },
  { value: "off", label: "Off" },
];

const CLASS_OPTIONS: { value: CarClassRule; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "f1", label: "Open-wheelers only" },
  { value: "gt3", label: "GT3 only" },
];

const trackName = (id: string) => TRACKS.find((t) => t.id === id)?.name ?? id;
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

/** Ping chip tint: green under 80 ms, amber under 160 ms, else crimson */
const pingChip = (ms: number) =>
  ms < 80 ? "bg-[#00E676]/[0.12] text-[#00E676]" : ms < 160 ? "bg-[#FFB300]/[0.12] text-[#FFB300]" : "bg-[#FF2A3C]/[0.12] text-[#FF2A3C]";

/**
 * A card inside the panel. In the pause menu it is a frosted card over the dimmed scene; inside the title
 * menu's panel sheet (`.lc-title-frame`) it becomes the darker inset card of the Racing Line boards.
 */
const CARD =
  "rounded-[24px] border border-white/[0.07] bg-[#0D0F15]/[0.82] p-[18px] [.lc-title-frame_&]:rounded-[22px] [.lc-title-frame_&]:border-[#262B3D] [.lc-title-frame_&]:bg-[#08090D]/60";
const CHIP =
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 font-f1-mono text-[10px] font-extrabold tracking-[0.06em] whitespace-nowrap";
const PILL =
  "inline-flex min-h-[44px] cursor-pointer items-center justify-center gap-2 rounded-full px-4 text-[14px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const PILL_VOLT = `${PILL} border-0 bg-[#CCFF00] text-[#08090D] hover:bg-[#d9ff33]`;
const PILL_DARK = `${PILL} border border-[#262B3D] bg-[#1B1F2B] text-[#F5F7FA] hover:border-[#3A4157] hover:bg-[#262B3D]`;
const PILL_CYAN = `${PILL} border-0 bg-[#00E5FF] px-5 text-[#08090D] hover:opacity-90`;
const stepButtonClass =
  "flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-[#262B3D] bg-[#1B1F2B] text-[#F5F7FA] transition-colors hover:border-[#CCFF00] disabled:cursor-not-allowed disabled:opacity-40";
const inputClass =
  "h-11 w-full min-w-0 rounded-[14px] border border-[#262B3D] bg-[#08090D] px-3.5 font-f1-mono text-[13px] text-[#F5F7FA] placeholder:text-[#8E96AA] focus:border-[#CCFF00] focus:shadow-[0_0_0_4px_rgba(204,255,0,0.12)] focus:outline-none";

function ReadValue({ children }: { children: React.ReactNode }) {
  return <span className="text-[14px] leading-tight font-bold text-[#F5F7FA]">{children}</span>;
}

/** Host's choice of a lobby rule (a pill segmented control), or its value for everyone else */
function RuleRow<T extends string>({
  label,
  value,
  options,
  editable,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  editable: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="col-span-full flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="lc-lbl w-[74px] shrink-0">{label}</span>
      {editable ? (
        <Segmented
          label={label}
          className="min-w-0 flex-1 [&_button]:min-h-9 [&_button]:px-2 [&_button]:text-[12px] [&_button]:whitespace-nowrap"
          options={options.map((o) => ({ id: o.value, label: o.label }))}
          value={value}
          onChange={onChange}
        />
      ) : (
        <ReadValue>{optionLabel(options, value)}</ReadValue>
      )}
    </div>
  );
}

function NetBadge({ stats }: { stats?: PeerNetStats }) {
  if (!stats) return null;
  return (
    <>
      {stats.relayed ? (
        <span
          title="Traffic reaches you through the host"
          className={`${CHIP} uppercase shadow-[inset_0_0_0_1px_rgba(0,229,255,0.5)] text-[#00E5FF]`}
        >
          relayed
        </span>
      ) : null}
      {stats.rttMs == null ? (
        <span className={`${CHIP} text-[#8E96AA] shadow-[inset_0_0_0_1px_#262B3D]`}>measuring…</span>
      ) : (
        <span className={`${CHIP} ${pingChip(stats.rttMs)}`}>
          {Math.round(stats.rttMs)} ms · {Math.round(stats.lossPct)}% loss
        </span>
      )}
    </>
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
  raceRunning = false,
  onHostLocal,
  onSetLobbySettings,
  onSetReady,
  onStartRace,
  onAbortRace,
  onSwitchTrack,
  onSwitchVehicle,
  onOpenProfile,
  races,
}) => {
  // Connect box
  const [roomCodeInput, setRoomCodeInput] = useState(initialRoomCode);
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
      await navigator.share({ title: "LibreCorsa race", text: "Join my race", url });
    } catch {
      // Share sheet dismissed or unavailable
    }
  };

  const toggleReady = () => {
    const next = !ready;
    setPendingReady(next);
    onSetReady?.(next);
  };

  const setLaps = (laps: number) => {
    onSetLobbySettings?.({ laps: Math.min(MAX_LAPS, Math.max(MIN_LAPS, laps)) });
  };

  const saveTurn = () => {
    const url = turnUrl.trim();
    if (!/^turns?:/i.test(url)) {
      setTurnError("The address must start with turn: or turns:");
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
  };
  const joinRoom = () => {
    if (joinReady) onJoinP2PRoom?.(roomCodeInput.trim());
  };

  const connected = p2pStatus?.connectedWebRtcPeers ?? 0;
  const hostedCode = p2pStatus?.roomCode;

  const renderLobby = (state: LobbyState) => {
    const settings = state.settings;
    // Who hosts comes from one place, the lobby's host id: the crown, "You are host" and the host's controls agree
    const isHostPlayer = (p: LobbyPlayer) => p.peerId === state.hostId;
    const hostPlayer = state.players.find(isHostPlayer);
    const isHost = localPeerId !== undefined && state.hostId === localPeerId;

    // Warnings for this player, compared with the host's race settings
    const trackMismatch = currentTrackId !== undefined && currentTrackId !== settings.trackId;
    const allowedVehicles = vehiclesForClass ? vehiclesForClass(settings.carClass) : null;
    const vehicleBlocked = !!allowedVehicles && !!currentVehicle && !allowedVehicles.includes(currentVehicle);

    return (
      <div className="flex min-w-0 flex-col gap-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <span className="lc-title text-[18px] leading-tight text-[#F5F7FA]">
            Lobby · host <span className="text-[#CCFF00]">{hostPlayer?.name ?? "—"}</span>
          </span>
          {isHost ? <span className={`${CHIP} bg-[#CCFF00]/[0.12] text-[#CCFF00] uppercase`}>You are host</span> : null}
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div className={`${CARD} flex flex-col gap-2 !p-3 !rounded-[18px]`}>
            <span className="lc-lbl">Laps</span>
            {isHost ? (
              <div className="flex items-center justify-between gap-1.5">
                <button
                  type="button"
                  aria-label="Fewer laps"
                  disabled={settings.laps <= MIN_LAPS}
                  onClick={() => setLaps(settings.laps - 1)}
                  className={stepButtonClass}
                >
                  <Minus className="h-4 w-4" />
                </button>
                <span className="lc-data min-w-8 text-center text-[24px] leading-none text-[#F5F7FA]">{settings.laps}</span>
                <button
                  type="button"
                  aria-label="More laps"
                  disabled={settings.laps >= MAX_LAPS}
                  onClick={() => setLaps(settings.laps + 1)}
                  className={stepButtonClass}
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <span className="lc-data text-[24px] leading-none text-[#F5F7FA]">{settings.laps}</span>
            )}
          </div>

          <div className={`${CARD} flex flex-col gap-2 !p-3 !rounded-[18px]`}>
            <span className="lc-lbl">Circuit</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <ReadValue>{trackName(settings.trackId)}</ReadValue>
              <TrackQualityBadge track={getTrackInfo(settings.trackId)} size="xs" />
            </div>
          </div>

          <RuleRow
            label="Collisions"
            value={settings.collisions}
            options={COLLISION_OPTIONS}
            editable={isHost}
            onChange={(collisions) => onSetLobbySettings?.({ collisions })}
          />
          <RuleRow
            label="Car class"
            value={settings.carClass}
            options={CLASS_OPTIONS}
            editable={isHost}
            onChange={(carClass) => onSetLobbySettings?.({ carClass })}
          />
        </div>

        <ul className="flex flex-col gap-1.5">
          {state.players.map((p) => {
            const isMe = p.peerId === localPeerId;
            const carName = p.vehicle ? (vehicleLabel?.(p.vehicle) ?? p.vehicle) : "—";
            return (
              <li
                key={p.peerId}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[16px] border border-[#262B3D] bg-[#11131A] px-3 py-2.5"
              >
                <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                <div className="flex min-w-0 flex-[1_1_90px] flex-col">
                  <span className="flex min-w-0 items-center gap-2 text-[14px] font-bold text-[#F5F7FA]">
                    <span className="font-f1-mono text-[12px] font-extrabold tracking-[0.1em]">{p.code}</span>
                    <span className="truncate">
                      {p.name}
                      {isMe ? <span className="font-normal text-[#8E96AA]"> (you)</span> : null}
                    </span>
                  </span>
                  <span className="truncate text-[12px] text-[#8E96AA]">{carName}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {isHostPlayer(p) ? (
                    <span className={`${CHIP} bg-[#CCFF00]/[0.12] text-[#CCFF00] uppercase`}>
                      <Crown className="h-3 w-3" strokeWidth={2.4} />
                      Host
                    </span>
                  ) : null}
                  {!isMe ? <NetBadge stats={peerStats?.find((s) => s.peerId === p.peerId)} /> : null}
                  <span
                    className={`${CHIP} uppercase ${
                      p.ready ? "bg-[#00E676]/[0.12] text-[#00E676]" : "text-[#8E96AA] shadow-[inset_0_0_0_1px_#262B3D]"
                    }`}
                  >
                    {p.ready ? "Ready" : "Not ready"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>

        {trackMismatch || vehicleBlocked ? (
          <div className="flex flex-col gap-2">
            {trackMismatch ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-[16px] border border-[#FFB300]/40 bg-[#FFB300]/[0.08] px-3.5 py-2.5">
                <span className="text-[13px] font-semibold text-[#FFB300]">The host is on {trackName(settings.trackId)}</span>
                {onSwitchTrack ? (
                  <button
                    type="button"
                    onClick={() => onSwitchTrack(settings.trackId)}
                    className="inline-flex min-h-9 cursor-pointer items-center rounded-full border border-[#FFB300]/60 bg-[#FFB300]/15 px-3.5 text-[13px] font-bold text-[#FFB300] hover:bg-[#FFB300]/25"
                  >
                    Switch circuit
                  </button>
                ) : null}
              </div>
            ) : null}
            {vehicleBlocked && allowedVehicles ? (
              <div className="flex flex-col gap-2 rounded-[16px] border border-[#FFB300]/40 bg-[#FFB300]/[0.08] px-3.5 py-2.5">
                <span className="text-[13px] font-semibold text-[#FFB300]">
                  Your car is not allowed in {optionLabel(CLASS_OPTIONS, settings.carClass)} races. Pick one:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {allowedVehicles.map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => onSwitchVehicle?.(id)}
                      disabled={!onSwitchVehicle}
                      className="inline-flex min-h-9 cursor-pointer items-center rounded-full border border-[#FFB300]/60 bg-[#FFB300]/15 px-3.5 text-[13px] font-bold text-[#FFB300] hover:bg-[#FFB300]/25 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {vehicleLabel?.(id) ?? id}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {isHost ? (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={raceRunning}
              onClick={() => onStartRace?.()}
              className="inline-flex h-14 cursor-pointer items-center justify-center gap-3 rounded-full border-0 bg-[#CCFF00] text-[#08090D] shadow-[0_0_0_5px_rgba(204,255,0,0.12),0_14px_34px_rgba(204,255,0,0.2)] transition-colors hover:bg-[#d9ff33] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              <Play aria-hidden className="h-[18px] w-[18px]" fill="currentColor" strokeWidth={0} />
              <span className="lc-disp text-[22px]">{raceRunning ? "Race in progress" : "Start race"}</span>
            </button>
            {raceRunning && onAbortRace ? (
              <button
                type="button"
                onClick={() => onAbortRace()}
                className="inline-flex min-h-[44px] cursor-pointer items-center justify-center rounded-full border border-[#FF2A3C]/60 bg-[#FF2A3C]/[0.12] px-4 text-[14px] font-bold text-[#FF2A3C] hover:bg-[#FF2A3C]/25"
              >
                End race for everyone
              </button>
            ) : null}
            {!raceRunning ? (
              <span className="text-center text-[12px] text-[#8E96AA]">Everyone not ready will still start.</span>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              aria-pressed={ready}
              disabled={!onSetReady}
              onClick={toggleReady}
              className={`inline-flex h-14 w-full cursor-pointer items-center justify-center gap-2.5 rounded-full border-0 text-[#08090D] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                ready
                  ? "bg-[#00E676] shadow-[0_0_0_5px_rgba(0,230,118,0.12)] hover:bg-[#2BEB8A]"
                  : "bg-[#CCFF00] shadow-[0_0_0_5px_rgba(204,255,0,0.12),0_14px_34px_rgba(204,255,0,0.2)] hover:bg-[#d9ff33]"
              }`}
            >
              {ready ? <Check aria-hidden className="h-5 w-5" strokeWidth={3} /> : null}
              <span className="lc-disp text-[22px]">{ready ? "Ready" : "Ready up"}</span>
            </button>
            <span className="text-center text-[12px] text-[#8E96AA]">
              {raceRunning ? "Race in progress." : "Tap to toggle. The host starts the race."}
            </span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className={`grid items-start gap-[22px] text-[#F5F7FA] ${
        lobby || races ? "grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))]" : "max-w-xl grid-cols-1"
      }`}
    >
      {/* Open races: not while in a friend's room, whose lobby takes this place */}
      {races && !lobby ? <RacesCard {...races} /> : null}

      {/* Room */}
      <div className="flex min-w-0 flex-col gap-3.5">
        <div className={`${CARD} flex flex-col gap-3.5`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="lc-lbl">Room code</span>
            <span
              className={`${CHIP} h-[26px] text-[11px] uppercase ${
                p2pStatus?.state === "connected"
                  ? "bg-[#00E676]/[0.12] text-[#00E676]"
                  : p2pStatus?.state === "signaling"
                    ? "bg-[#FFB300]/[0.12] text-[#FFB300]"
                    : "text-[#8E96AA] shadow-[inset_0_0_0_1px_#262B3D]"
              }`}
            >
              <span className="relative inline-flex h-[7px] w-[7px]">
                {p2pStatus?.state === "connected" ? (
                  <span className="lc-ping absolute inset-0 rounded-full bg-current" />
                ) : null}
                <span className="relative h-[7px] w-[7px] rounded-full bg-current" />
              </span>
              {connected} connected
            </span>
          </div>
          {hostedCode ? (
            <>
              <div
                className="font-f1-mono text-[40px] leading-none font-extrabold tracking-[0.14em] break-all text-[#CCFF00] tabular-nums sm:text-[46px]"
                aria-label={`Room code ${hostedCode}`}
              >
                {hostedCode}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={!activeCode} onClick={copyLink} className={`flex-1 ${PILL_VOLT}`}>
                  {copiedLink ? <Check aria-hidden className="h-4 w-4" strokeWidth={2.4} /> : <Copy aria-hidden className="h-4 w-4" strokeWidth={2.2} />}
                  {copiedLink ? "Link copied" : "Copy invite link"}
                </button>
                {canShare ? (
                  <button type="button" disabled={!activeCode} onClick={() => void shareInvite()} className={`flex-1 ${PILL_DARK}`}>
                    <Share2 aria-hidden className="h-4 w-4" strokeWidth={2.2} />
                    Share…
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <p className="m-0 text-[14px] leading-snug text-[#8E96AA]">
                {races ? "To race only your friends, host" : "Host"} a room and send them the link, or join theirs with the code they gave you.
              </p>
              <button type="button" onClick={hostRoom} className={`w-full ${joinReady ? PILL_DARK : PILL_VOLT}`}>
                Host a room
              </button>
            </>
          )}
          <div className="h-px bg-[#262B3D]" />
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              joinRoom();
            }}
          >
            <label htmlFor="lc-room-code" className="lc-lbl">
              {hostedCode ? "Join another room" : "Join a friend's room"}
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id="lc-room-code"
                type="text"
                maxLength={6}
                value={roomCodeInput}
                onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                placeholder="CODE"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="h-11 min-w-[7rem] flex-1 rounded-full border border-[#262B3D] bg-[#08090D] px-4 font-f1-mono text-[15px] font-extrabold tracking-[0.3em] text-[#F5F7FA] uppercase placeholder:text-[#8E96AA] focus:border-[#CCFF00] focus:shadow-[0_0_0_4px_rgba(204,255,0,0.12)] focus:outline-none"
              />
              <button type="submit" disabled={!joinReady} className={joinReady ? PILL_VOLT : PILL_DARK}>
                Join
              </button>
            </div>
          </form>
          {hostedCode ? (
            <button
              type="button"
              onClick={hostRoom}
              className="self-start cursor-pointer text-left text-[13px] font-semibold text-[#00E5FF] hover:text-[#CCFF00] hover:underline"
            >
              Host a new room instead
            </button>
          ) : null}
        </div>

        {profile ? (
          <div className="flex min-w-0 items-center gap-2.5 rounded-full border border-[#262B3D] bg-[#08090D]/60 py-1.5 pr-3 pl-3.5">
            <span className="lc-lbl">You</span>
            <span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ backgroundColor: profile.color }} />
            <span className="font-f1-mono text-[12px] font-extrabold tracking-[0.1em]">{profile.code}</span>
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{profile.name}</span>
            {onOpenProfile ? (
              <button
                type="button"
                onClick={onOpenProfile}
                className="inline-flex min-h-8 shrink-0 cursor-pointer items-center gap-1.5 px-1 text-[13px] font-bold text-[#00E5FF] hover:text-[#CCFF00]"
              >
                <Pencil aria-hidden className="h-3.5 w-3.5" strokeWidth={2.2} />
                Edit
              </button>
            ) : null}
          </div>
        ) : null}

        <div
          className={`border border-[#262B3D] transition-[border-radius] ${
            advancedOpen ? "rounded-[22px] bg-[#08090D]/60" : "rounded-[22px] bg-transparent"
          }`}
        >
          <button
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
            className="flex min-h-[44px] w-full cursor-pointer items-center justify-between gap-2 rounded-[22px] px-4 py-2 text-left hover:bg-white/[0.04]"
          >
            <span className="lc-title text-[14px] text-[#8E96AA]">More ways to connect</span>
            <span className="flex shrink-0 items-center gap-2">
              {turnConfigured ? <span className={`${CHIP} bg-[#00E5FF]/[0.12] text-[#00E5FF] uppercase`}>Own relay</span> : null}
              <ChevronDown
                aria-hidden
                className={`h-4 w-4 text-[#8E96AA] transition-transform ${advancedOpen ? "rotate-180" : ""}`}
                strokeWidth={2.2}
              />
            </span>
          </button>

          {advancedOpen ? (
            <div className="flex flex-col gap-4 border-t border-[#262B3D] p-4">
              <div className="flex flex-col gap-2">
                <span className="lc-title text-[14px] text-[#00E676]">Two windows on this computer</span>
                <p className="m-0 text-[12px] leading-snug text-[#8E96AA]">
                  Open the game in another tab or window of this browser, then start a race between them here. No room needed.
                </p>
                <button
                  type="button"
                  disabled={!onHostLocal}
                  onClick={() => onHostLocal?.()}
                  className={`${PILL_DARK} min-h-9 self-start text-[13px]`}
                >
                  Race these tabs
                </button>
              </div>

              <div className="flex flex-col gap-2.5 border-t border-[#262B3D] pt-4">
                <span className="lc-title text-[14px] text-[#FFB300]">Connect by hand</span>
                <p className="m-0 text-[12px] leading-snug text-[#8E96AA]">
                  Works without any room: the host makes an offer, the other player answers it, and you send each other the
                  two tokens.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {/* A guest that answered an offer does not start one of its own (Start over first) */}
                  <button
                    type="button"
                    disabled={sdpBusy || sdp.stage === "answered"}
                    onClick={() =>
                      runSdp(async () => {
                        const offer = await onCreateManualOffer?.();
                        if (offer) {
                          setSdp({ stage: "offered", token: offer });
                          setSdpInput("");
                          cancelCopiedToken();
                        }
                      }, "Couldn't create an offer. Try again.")
                    }
                    className="inline-flex min-h-9 cursor-pointer items-center rounded-full border border-[#00E5FF]/50 bg-[#00E5FF]/[0.12] px-3.5 text-[12px] font-bold text-[#00E5FF] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    1 · Create offer (host)
                  </button>
                  {/* A host waiting on the answer to its own offer does not paste an offer (Start over first) */}
                  <button
                    type="button"
                    disabled={sdpBusy || !sdpInput.trim() || sdp.stage === "offered"}
                    onClick={() =>
                      runSdp(async () => {
                        const ans = await onAcceptManualOffer?.(sdpInput.trim());
                        if (ans) {
                          setSdp({ stage: "answered", token: ans });
                          setSdpInput("");
                          cancelCopiedToken();
                        }
                      }, "That offer didn't work. Check you pasted all of it.")
                    }
                    className="inline-flex min-h-9 cursor-pointer items-center rounded-full border border-[#FFB300]/50 bg-[#FFB300]/[0.12] px-3.5 text-[12px] font-bold text-[#FFB300] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    2 · Paste offer, get answer
                  </button>
                  {/* Only the host that made the offer accepts an answer */}
                  <button
                    type="button"
                    disabled={sdpBusy || !sdpInput.trim() || sdp.stage !== "offered"}
                    onClick={() =>
                      runSdp(async () => {
                        const ok = await onAcceptManualAnswer?.(sdpInput.trim());
                        if (ok === false) throw new Error("answer refused");
                        setSdp({ stage: "accepted" });
                        setSdpInput("");
                        cancelCopiedToken();
                      }, "That answer didn't work. Check you pasted all of it.")
                    }
                    className="inline-flex min-h-9 cursor-pointer items-center rounded-full border border-[#00E676]/50 bg-[#00E676]/[0.12] px-3.5 text-[12px] font-bold text-[#00E676] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    3 · Accept answer (host)
                  </button>
                </div>
                <input
                  type="text"
                  value={sdpInput}
                  onChange={(e) => {
                    setSdpInput(e.target.value);
                    setSdpError("");
                  }}
                  placeholder="Paste the other player's token here"
                  aria-label="Connection token"
                  className={inputClass}
                />
                {sdpError ? (
                  <p role="alert" className="m-0 text-[12px] font-semibold text-[#FF2A3C]">
                    {sdpError}
                  </p>
                ) : null}
                {sdp.stage === "accepted" ? (
                  <p className="m-0 text-[12px] font-semibold text-[#00E676]">Answer accepted. Connecting…</p>
                ) : null}
                {generatedToken ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={generatedToken}
                      aria-label="Generated token"
                      className={`${inputClass} flex-1 !border-[#00E676]/50 text-[#00E676]`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(generatedToken).catch(() => undefined);
                        flashCopiedToken();
                      }}
                      className="inline-flex h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-[#00E676] px-4 text-[13px] font-bold text-[#08090D]"
                    >
                      {copiedToken ? <Check aria-hidden className="h-4 w-4" /> : <Copy aria-hidden className="h-4 w-4" />}
                      {copiedToken ? "Copied" : "Copy"}
                    </button>
                  </div>
                ) : null}
                {sdp.stage !== "idle" ? (
                  <button
                    type="button"
                    disabled={sdpBusy}
                    onClick={resetSdp}
                    className="self-start cursor-pointer text-[12px] font-semibold text-[#8E96AA] hover:text-[#CCFF00] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Start over
                  </button>
                ) : null}
              </div>

              <div className="flex flex-col gap-2.5 border-t border-[#262B3D] pt-4">
                <span className="lc-title text-[14px] text-[#00E5FF]">Your own relay server</span>
                <p className="m-0 text-[12px] leading-snug text-[#8E96AA]">
                  Only if players still can&apos;t reach each other: the address and login of a TURN server you run or rent.
                  Used for connections made after you save it.
                </p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <input
                    type="text"
                    value={turnUrl}
                    onChange={(e) => {
                      setTurnUrl(e.target.value);
                      setTurnError("");
                    }}
                    placeholder="turn:host:3478"
                    aria-label="Relay address"
                    autoComplete="off"
                    className={inputClass}
                  />
                  <input
                    type="text"
                    value={turnUser}
                    onChange={(e) => setTurnUser(e.target.value)}
                    placeholder="Username"
                    aria-label="Relay username"
                    autoComplete="off"
                    className={inputClass}
                  />
                  <input
                    type="password"
                    value={turnCred}
                    onChange={(e) => setTurnCred(e.target.value)}
                    placeholder="Password"
                    aria-label="Relay password"
                    autoComplete="new-password"
                    className={inputClass}
                  />
                </div>
                {turnError ? <p className="m-0 text-[12px] font-semibold text-[#FF2A3C]">{turnError}</p> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" disabled={!turnUrl.trim()} onClick={saveTurn} className={`${PILL_CYAN} min-h-9 text-[13px]`}>
                    {turnSaved ? "Saved" : "Save"}
                  </button>
                  <button type="button" onClick={clearTurn} className={`${PILL_DARK} min-h-9 text-[13px] hover:!border-[#FF2A3C]`}>
                    Clear
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <p
          role={p2pStatus?.state === "error" ? "alert" : undefined}
          className={`m-0 font-f1-mono leading-normal ${
            p2pStatus?.state === "error" ? "text-[13px] font-semibold text-[#FF2A3C]" : "text-[13px] text-[#8E96AA]"
          }`}
        >
          {p2pStatus?.statusText ?? "Host a room and send the link, or join with a friend's code."}
        </p>
      </div>

      {lobby ? renderLobby(lobby) : null}
    </div>
  );
};
