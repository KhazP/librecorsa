"use client";

import React, { useEffect, useState } from "react";
import { Check, ChevronDown, Copy, Crown, Minus, Pencil, Plus, Radio, Share2 } from "lucide-react";
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
import { TRACKS } from "@/lib/track-registry";

export interface MultiplayerPanelProps {
  p2pStatus?: P2PConnectionStatus;
  initialRoomCode?: string;
  onHostP2PRoom?: (customCode?: string) => string;
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
  { value: "f1", label: "F1 only" },
  { value: "gt3", label: "GT3 only" },
];

const trackName = (id: string) => TRACKS.find((t) => t.id === id)?.name ?? id;
const optionLabel = <T extends string>(options: { value: T; label: string }[], value: T) =>
  options.find((o) => o.value === value)?.label ?? value;

const pingColor = (ms: number) => (ms < 80 ? "text-[#00E676]" : ms < 160 ? "text-[#FFB300]" : "text-[#FF5252]");

const chipClass = "rounded px-1.5 py-0.5 font-f1-mono text-[10px] font-bold tracking-wider uppercase";
const stepButtonClass =
  "flex h-8 w-8 cursor-pointer items-center justify-center rounded border border-[#262B3D] bg-[#1B1F2B] text-[#F5F7FA] hover:border-[#CCFF00] disabled:cursor-default disabled:opacity-40";
const inputClass =
  "w-full rounded border border-[#262B3D] bg-[#11131A] px-2.5 py-1.5 font-f1-mono text-xs text-[#F5F7FA] placeholder:text-[#8E96AA]/50 focus:border-[#00E5FF] focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="font-f1-mono text-[10px] tracking-wider text-[#8E96AA] uppercase">{label}</span>
      {children}
    </div>
  );
}

function ReadValue({ children }: { children: React.ReactNode }) {
  return <span className="font-f1-mono text-sm font-bold text-[#F5F7FA]">{children}</span>;
}

function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={`cursor-pointer rounded border px-2.5 py-1.5 font-f1-italic text-xs tracking-wider uppercase transition-colors ${
              active
                ? "border-[#CCFF00] bg-[#CCFF00] text-[#08090D]"
                : "border-[#262B3D] bg-[#1B1F2B] text-[#F5F7FA] hover:border-[#CCFF00]/60"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function NetBadge({ stats }: { stats?: PeerNetStats }) {
  if (!stats) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {stats.rttMs == null ? (
        <span className="font-f1-mono text-[11px] text-[#8E96AA]">measuring…</span>
      ) : (
        <span className={`font-f1-mono text-[11px] font-bold ${pingColor(stats.rttMs)}`}>
          {Math.round(stats.rttMs)} ms · {Math.round(stats.lossPct)}% loss
        </span>
      )}
      {stats.relayed ? (
        <span
          title="Traffic reaches you through the host"
          className={`${chipClass} border border-[#00E5FF]/40 text-[#00E5FF]`}
        >
          relayed
        </span>
      ) : null}
    </span>
  );
}

/** Peer-to-peer multiplayer: room codes over a public WebRTC broker, or a manual SDP exchange */
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
  isHost = false,
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
}) => {
  // Connect box
  const [roomCodeInput, setRoomCodeInput] = useState(initialRoomCode);
  const [copiedLink, setCopiedLink] = useState(false);
  const [canShare, setCanShare] = useState(false);

  // Manual connection (advanced)
  const [sdpInput, setSdpInput] = useState("");
  const [generatedToken, setGeneratedToken] = useState("");
  const [copiedToken, setCopiedToken] = useState(false);
  const [sdpBusy, setSdpBusy] = useState(false);

  // TURN relay (advanced)
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [turnUrl, setTurnUrl] = useState("");
  const [turnUser, setTurnUser] = useState("");
  const [turnCred, setTurnCred] = useState("");
  const [turnConfigured, setTurnConfigured] = useState(false);
  const [turnError, setTurnError] = useState("");
  const [turnSaved, setTurnSaved] = useState(false);

  // Ready toggle: mirrors this player's lobby entry, and applies immediately when pressed
  const serverReady = lobby?.players.find((p) => p.peerId === localPeerId)?.ready ?? false;
  const [ready, setReadyLocal] = useState(serverReady);

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

  useEffect(() => {
    setReadyLocal(serverReady);
  }, [serverReady]);

  const runSdp = async (fn: () => Promise<void>) => {
    setSdpBusy(true);
    try {
      await fn();
    } finally {
      setSdpBusy(false);
    }
  };

  const activeCode = (p2pStatus?.roomCode || roomCodeInput.trim()).replace(/^(RWA|LC)-/i, "").toUpperCase();

  const getInviteUrl = (): string | null => {
    if (!activeCode || typeof window === "undefined") return null;
    return `${window.location.origin}${window.location.pathname}?room=LC-${activeCode}`;
  };

  const copyLink = () => {
    const url = getInviteUrl();
    if (!url) return;
    navigator.clipboard?.writeText(url).catch(() => undefined);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
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
    setReadyLocal(next);
    onSetReady?.(next);
  };

  const setLaps = (laps: number) => {
    onSetLobbySettings?.({ laps: Math.min(MAX_LAPS, Math.max(MIN_LAPS, laps)) });
  };

  const saveTurn = () => {
    const url = turnUrl.trim();
    if (!/^turns?:/i.test(url)) {
      setTurnError("The URL must start with turn: or turns:");
      return;
    }
    setTurnError("");
    saveUserTurnServer({
      urls: url,
      username: turnUser.trim() || undefined,
      credential: turnCred || undefined,
    });
    setTurnConfigured(hasTurnServer());
    setTurnSaved(true);
    setTimeout(() => setTurnSaved(false), 1800);
  };

  const clearTurn = () => {
    saveUserTurnServer(null);
    setTurnUrl("");
    setTurnUser("");
    setTurnCred("");
    setTurnError("");
    setTurnConfigured(hasTurnServer());
  };

  const renderLobby = (state: LobbyState) => {
    const settings = state.settings;
    const hostPlayer = state.players.find((p) => p.peerId === state.hostId);
    const isHostPlayer = (p: LobbyPlayer) => p.isHost || p.peerId === state.hostId;

    // Warnings for this player, compared with the host's race settings
    const trackMismatch = currentTrackId !== undefined && currentTrackId !== settings.trackId;
    const allowedVehicles = vehiclesForClass ? vehiclesForClass(settings.carClass) : null;
    const vehicleBlocked = !!allowedVehicles && !!currentVehicle && !allowedVehicles.includes(currentVehicle);

    return (
      <div className="mb-3 rounded border border-[#262B3D] bg-[#08090D]/80 p-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[#262B3D] pb-2">
          <span className="font-f1-italic text-sm tracking-wider text-[#CCFF00] uppercase">
            Lobby · host {hostPlayer?.name ?? "—"}
          </span>
          {isHost ? (
            <span className={`${chipClass} bg-[#CCFF00]/15 text-[#CCFF00]`}>You are host</span>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Laps">
            {isHost ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label="Fewer laps"
                  disabled={settings.laps <= MIN_LAPS}
                  onClick={() => setLaps(settings.laps - 1)}
                  className={stepButtonClass}
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
                <span className="min-w-10 text-center font-f1-mono text-base font-black text-[#F5F7FA]">
                  {settings.laps}
                </span>
                <button
                  type="button"
                  aria-label="More laps"
                  disabled={settings.laps >= MAX_LAPS}
                  onClick={() => setLaps(settings.laps + 1)}
                  className={stepButtonClass}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <ReadValue>{settings.laps}</ReadValue>
            )}
          </Field>

          <Field label="Circuit">
            <ReadValue>{trackName(settings.trackId)}</ReadValue>
          </Field>

          <Field label="Collisions">
            {isHost ? (
              <Choice
                value={settings.collisions}
                options={COLLISION_OPTIONS}
                onChange={(collisions) => onSetLobbySettings?.({ collisions })}
              />
            ) : (
              <ReadValue>{optionLabel(COLLISION_OPTIONS, settings.collisions)}</ReadValue>
            )}
          </Field>

          <Field label="Car class">
            {isHost ? (
              <Choice
                value={settings.carClass}
                options={CLASS_OPTIONS}
                onChange={(carClass) => onSetLobbySettings?.({ carClass })}
              />
            ) : (
              <ReadValue>{optionLabel(CLASS_OPTIONS, settings.carClass)}</ReadValue>
            )}
          </Field>
        </div>

        <ul className="mt-3 flex flex-col gap-1.5">
          {state.players.map((p) => {
            const isMe = p.peerId === localPeerId;
            const carName = p.vehicle ? (vehicleLabel?.(p.vehicle) ?? p.vehicle) : "—";
            return (
              <li
                key={p.peerId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded border border-[#262B3D] bg-[#11131A] px-2.5 py-2"
              >
                <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="font-f1-mono text-xs font-bold tracking-widest text-[#F5F7FA]">{p.code}</span>
                    <span className="truncate font-f1-italic text-sm text-[#F5F7FA]">
                      {p.name}
                      {isMe ? " (you)" : ""}
                    </span>
                  </div>
                  <span className="truncate font-f1-mono text-[11px] text-[#8E96AA]">{carName}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {isHostPlayer(p) ? (
                    <span className={`${chipClass} flex items-center gap-1 bg-[#CCFF00]/15 text-[#CCFF00]`}>
                      <Crown className="h-3 w-3" />
                      Host
                    </span>
                  ) : null}
                  <span
                    className={`${chipClass} ${
                      p.ready ? "bg-[#00E676]/20 text-[#00E676]" : "border border-[#262B3D] text-[#8E96AA]"
                    }`}
                  >
                    {p.ready ? "Ready" : "Not ready"}
                  </span>
                  {!isMe ? <NetBadge stats={peerStats?.find((s) => s.peerId === p.peerId)} /> : null}
                </div>
              </li>
            );
          })}
        </ul>

        {trackMismatch || vehicleBlocked ? (
          <div className="mt-3 flex flex-col gap-2">
            {trackMismatch ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-[#FFB300]/50 bg-[#FFB300]/10 px-3 py-2">
                <span className="font-f1-mono text-xs text-[#FFB300]">
                  The host is on {trackName(settings.trackId)}
                </span>
                {onSwitchTrack ? (
                  <button
                    type="button"
                    onClick={() => onSwitchTrack(settings.trackId)}
                    className="cursor-pointer rounded border border-[#FFB300]/60 bg-[#FFB300]/15 px-2.5 py-1.5 font-f1-italic text-xs tracking-wider text-[#FFB300] uppercase hover:bg-[#FFB300]/25"
                  >
                    Switch circuit
                  </button>
                ) : null}
              </div>
            ) : null}
            {vehicleBlocked && allowedVehicles ? (
              <div className="flex flex-col gap-2 rounded border border-[#FFB300]/50 bg-[#FFB300]/10 px-3 py-2">
                <span className="font-f1-mono text-xs text-[#FFB300]">
                  Your car is not allowed in {optionLabel(CLASS_OPTIONS, settings.carClass)} races. Pick one:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {allowedVehicles.map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => onSwitchVehicle?.(id)}
                      disabled={!onSwitchVehicle}
                      className="cursor-pointer rounded border border-[#FFB300]/60 bg-[#FFB300]/15 px-2.5 py-1.5 font-f1-italic text-xs tracking-wider text-[#FFB300] uppercase hover:bg-[#FFB300]/25 disabled:cursor-default disabled:opacity-40"
                    >
                      {vehicleLabel?.(id) ?? id}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-3">
          {isHost ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={raceRunning}
                  onClick={() => onStartRace?.()}
                  className="cursor-pointer rounded bg-[#CCFF00] px-5 py-3 font-f1-italic text-base tracking-wider text-[#08090D] uppercase hover:bg-[#d9ff33] disabled:cursor-default disabled:opacity-40"
                >
                  {raceRunning ? "Race in progress" : "Start race"}
                </button>
                {raceRunning && onAbortRace ? (
                  <button
                    type="button"
                    onClick={() => onAbortRace()}
                    className="cursor-pointer rounded border border-[#FF5252]/60 bg-[#FF5252]/15 px-3.5 py-2.5 font-f1-italic text-xs tracking-wider text-[#FF5252] uppercase hover:bg-[#FF5252]/25"
                  >
                    End race for everyone
                  </button>
                ) : null}
              </div>
              {!raceRunning ? (
                <p className="font-f1-mono text-[11px] text-[#8E96AA]">Everyone not ready will still start.</p>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                aria-pressed={ready}
                disabled={!onSetReady}
                onClick={toggleReady}
                className={`flex w-full cursor-pointer items-center justify-center gap-2 rounded py-3 font-f1-italic text-base tracking-wider uppercase transition-colors disabled:cursor-default disabled:opacity-50 ${
                  ready ? "bg-[#00E676] text-[#08090D] hover:bg-[#2BEB8A]" : "bg-[#CCFF00] text-[#08090D] hover:bg-[#d9ff33]"
                }`}
              >
                {ready ? <Check className="h-5 w-5" /> : null}
                {ready ? "Ready" : "Ready up"}
              </button>
              <p className="text-center font-f1-mono text-[11px] text-[#8E96AA]">
                {raceRunning ? "Race in progress." : "Tap to toggle. The host starts the race."}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="f1-panel f1-corner-tr rounded-lg border border-[#262B3D] bg-[#11131A] p-4 text-[#F5F7FA]">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[#262B3D] pb-2">
        <span className="flex min-w-0 items-center gap-2 font-f1-italic text-base tracking-wider text-[#00E5FF] uppercase">
          <Radio className="h-4 w-4 shrink-0 text-[#CCFF00]" />
          Multiplayer (WebRTC Peer-to-Peer)
        </span>
        <span
          className={`rounded px-2 py-0.5 font-f1-mono text-[11px] font-bold uppercase ${
            p2pStatus?.state === "connected"
              ? "bg-[#00E676]/20 text-[#00E676]"
              : p2pStatus?.state === "signaling"
                ? "bg-[#FFB300]/20 text-[#FFB300]"
                : "border border-[#262B3D] bg-[#08090D] text-[#8E96AA]"
          }`}
        >
          {p2pStatus?.connectedWebRtcPeers ?? 0} connected
        </span>
      </div>
      <p className="mb-3 font-f1-mono text-[11px] text-[#8E96AA]">
        {p2pStatus?.statusText ?? "Same-browser tabs connect automatically. Use a room code for other devices."}
      </p>

      {profile ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded border border-[#262B3D] bg-[#08090D]/80 px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="font-f1-mono text-[10px] tracking-wider text-[#8E96AA] uppercase">You</span>
            <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: profile.color }} />
            <span className="rounded bg-[#1B1F2B] px-1.5 py-0.5 font-f1-mono text-[11px] font-bold tracking-widest text-[#F5F7FA]">
              {profile.code}
            </span>
            <span className="truncate font-f1-italic text-sm text-[#F5F7FA]">{profile.name}</span>
          </div>
          {onOpenProfile ? (
            <button
              type="button"
              onClick={onOpenProfile}
              className="flex shrink-0 cursor-pointer items-center gap-1 font-f1-mono text-[11px] text-[#00E5FF] hover:underline"
            >
              <Pencil className="h-3 w-3" />
              Edit
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mb-3 rounded border border-[#262B3D] bg-[#08090D]/80 p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="font-f1-italic text-sm text-[#F5F7FA] uppercase">Room code</span>
          {p2pStatus?.roomCode ? (
            <span className="rounded bg-[#CCFF00] px-2 py-0.5 font-f1-mono text-sm font-black tracking-widest text-[#08090D]">
              {p2pStatus.roomCode}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const code = onHostP2PRoom?.(roomCodeInput || undefined);
              if (code) setRoomCodeInput(code);
            }}
            className="cursor-pointer rounded bg-[#CCFF00] px-3.5 py-2 font-f1-italic text-xs tracking-wider text-[#08090D] uppercase hover:bg-[#d9ff33]"
          >
            Host
          </button>
          <input
            type="text"
            maxLength={6}
            value={roomCodeInput}
            onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
            placeholder="CODE"
            aria-label="Room code"
            className="w-28 rounded border border-[#262B3D] bg-[#11131A] px-2.5 py-1.5 font-f1-mono text-sm font-bold tracking-widest text-[#F5F7FA] uppercase placeholder:text-[#8E96AA]/50 focus:border-[#CCFF00] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => {
              if (roomCodeInput.trim().length >= 3) onJoinP2PRoom?.(roomCodeInput.trim());
            }}
            className="cursor-pointer rounded bg-[#00E5FF] px-3.5 py-2 font-f1-italic text-xs tracking-wider text-[#08090D] uppercase hover:opacity-90"
          >
            Join
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!activeCode}
            onClick={copyLink}
            className="flex cursor-pointer items-center gap-1.5 rounded border border-[#262B3D] bg-[#1B1F2B] px-3 py-2 font-f1-italic text-xs tracking-wider text-[#F5F7FA] uppercase hover:border-[#CCFF00] disabled:cursor-default disabled:opacity-40"
          >
            {copiedLink ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copiedLink ? "Link copied" : "Copy link"}
          </button>
          {canShare ? (
            <button
              type="button"
              disabled={!activeCode}
              onClick={() => void shareInvite()}
              className="flex cursor-pointer items-center gap-1.5 rounded border border-[#262B3D] bg-[#1B1F2B] px-3 py-2 font-f1-italic text-xs tracking-wider text-[#F5F7FA] uppercase hover:border-[#00E5FF] disabled:cursor-default disabled:opacity-40"
            >
              <Share2 className="h-3.5 w-3.5" />
              Share…
            </button>
          ) : null}
        </div>
        <button
          type="button"
          disabled={!onHostLocal}
          onClick={() => onHostLocal?.()}
          className="mt-2 cursor-pointer font-f1-mono text-[11px] text-[#00E5FF] hover:underline disabled:cursor-default disabled:opacity-40 disabled:no-underline"
        >
          Race these tabs (same browser)
        </button>
      </div>

      {lobby ? renderLobby(lobby) : null}

      <div className="rounded border border-[#262B3D] bg-[#08090D]/80">
        <button
          type="button"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
          className="flex w-full cursor-pointer items-center justify-between gap-2 p-3 text-left"
        >
          <span className="font-f1-italic text-sm tracking-wider text-[#8E96AA] uppercase">Advanced</span>
          <span className="flex items-center gap-2">
            {turnConfigured ? (
              <span className={`${chipClass} bg-[#00E5FF]/15 text-[#00E5FF]`}>TURN relay configured</span>
            ) : null}
            <ChevronDown
              className={`h-4 w-4 text-[#8E96AA] transition-transform ${advancedOpen ? "rotate-180" : ""}`}
            />
          </span>
        </button>

        {advancedOpen ? (
          <div className="flex flex-col gap-3 border-t border-[#262B3D] p-3">
            <div>
              <div className="mb-2 font-f1-italic text-sm text-[#FFB300] uppercase">Manual connection (no broker)</div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={sdpBusy}
                  onClick={() =>
                    runSdp(async () => {
                      const offer = await onCreateManualOffer?.();
                      if (offer) setGeneratedToken(offer);
                    })
                  }
                  className="cursor-pointer rounded border border-[#00E5FF]/50 bg-[#00E5FF]/15 px-2.5 py-1.5 font-f1-italic text-xs text-[#00E5FF] uppercase"
                >
                  1 · Create offer (host)
                </button>
                <button
                  type="button"
                  disabled={sdpBusy || !sdpInput.trim()}
                  onClick={() =>
                    runSdp(async () => {
                      const ans = await onAcceptManualOffer?.(sdpInput.trim());
                      if (ans) setGeneratedToken(ans);
                    })
                  }
                  className="cursor-pointer rounded border border-[#FFB300]/50 bg-[#FFB300]/15 px-2.5 py-1.5 font-f1-italic text-xs text-[#FFB300] uppercase disabled:opacity-40"
                >
                  2 · Paste offer, get answer
                </button>
                <button
                  type="button"
                  disabled={sdpBusy || !sdpInput.trim()}
                  onClick={() =>
                    runSdp(async () => {
                      await onAcceptManualAnswer?.(sdpInput.trim());
                    })
                  }
                  className="cursor-pointer rounded border border-[#00E676]/50 bg-[#00E676]/20 px-2.5 py-1.5 font-f1-italic text-xs text-[#00E676] uppercase disabled:opacity-40"
                >
                  3 · Accept answer (host)
                </button>
              </div>
              <input
                type="text"
                value={sdpInput}
                onChange={(e) => setSdpInput(e.target.value)}
                placeholder="Paste the other player's token here"
                aria-label="Connection token"
                className={inputClass}
              />
              {generatedToken ? (
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={generatedToken}
                    aria-label="Generated token"
                    className="min-w-0 flex-1 rounded border border-[#00E676]/50 bg-[#11131A] px-2.5 py-1.5 font-f1-mono text-xs text-[#00E676]"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(generatedToken).catch(() => undefined);
                      setCopiedToken(true);
                      setTimeout(() => setCopiedToken(false), 1800);
                    }}
                    className="flex shrink-0 cursor-pointer items-center gap-1 rounded bg-[#00E676] px-2.5 py-1.5 font-f1-italic text-xs text-[#08090D] uppercase"
                  >
                    {copiedToken ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copiedToken ? "Copied" : "Copy"}
                  </button>
                </div>
              ) : null}
            </div>

            <div className="border-t border-[#262B3D] pt-3">
              <div className="mb-1 font-f1-italic text-sm text-[#00E5FF] uppercase">TURN relay</div>
              <p className="mb-2 font-f1-mono text-[11px] text-[#8E96AA]">
                Needed when players are on strict NATs or mobile data. Free TURN: Cloudflare Calls, Metered.ca. Applies
                to new connections.
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                <input
                  type="text"
                  value={turnUrl}
                  onChange={(e) => setTurnUrl(e.target.value)}
                  placeholder="turn:host:3478"
                  aria-label="TURN URL"
                  autoComplete="off"
                  className={inputClass}
                />
                <input
                  type="text"
                  value={turnUser}
                  onChange={(e) => setTurnUser(e.target.value)}
                  placeholder="Username"
                  aria-label="TURN username"
                  autoComplete="off"
                  className={inputClass}
                />
                <input
                  type="password"
                  value={turnCred}
                  onChange={(e) => setTurnCred(e.target.value)}
                  placeholder="Credential"
                  aria-label="TURN credential"
                  autoComplete="new-password"
                  className={inputClass}
                />
              </div>
              {turnError ? <p className="mt-2 font-f1-mono text-[11px] text-[#FF5252]">{turnError}</p> : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!turnUrl.trim()}
                  onClick={saveTurn}
                  className="cursor-pointer rounded bg-[#00E5FF] px-3 py-1.5 font-f1-italic text-xs tracking-wider text-[#08090D] uppercase hover:opacity-90 disabled:cursor-default disabled:opacity-40"
                >
                  {turnSaved ? "Saved" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={clearTurn}
                  className="cursor-pointer rounded border border-[#262B3D] bg-[#1B1F2B] px-3 py-1.5 font-f1-italic text-xs tracking-wider text-[#F5F7FA] uppercase hover:border-[#FF5252]"
                >
                  Clear
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
