"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
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
import { Button, Card, ConfirmDialog, Disclosure, Select, SettingRow, Stepper, TextField, Well } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { PlayerTag, SessionBadge } from "@/components/ui/badges";
import { Icon } from "@/components/ui/icons";
import { TrackQualityBadge } from "@/components/menu/menu-content-ui";
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
  /** Why the host can't start a race here (a hill climb: one car at a time) */
  startBlocked?: string;
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
  if (!stats) return null;
  return (
    <>
      {stats.relayed ? (
        <Badge size="sm" tone="info" icon="relay" title="Traffic reaches you through the host">
          Relayed
        </Badge>
      ) : null}
      {stats.rttMs == null ? (
        <Badge size="sm" variant="outline">
          Measuring
        </Badge>
      ) : (
        <Badge size="sm" tone={pingTone(stats.rttMs)} icon="latency" className="lc-mono">
          {Math.round(stats.rttMs)} ms · {Math.round(stats.lossPct)}% loss
        </Badge>
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
  startBlocked,
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
    setJoinHint(null);
    setLastAction("host");
  };
  const joinRoom = () => {
    if (!joinReady) {
      setJoinHint("Type the code your friend sent you: at least 3 letters or digits.");
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
  const joinError = joinHint ?? (joinFailed ? p2pStatus?.statusText || "Couldn't join that room. Check the code." : undefined);

  const renderLobby = (state: LobbyState) => {
    const settings = state.settings;
    // Who hosts comes from one place, the lobby's host id: the host badge, "You are host" and the host's controls agree
    const isHostPlayer = (p: LobbyPlayer) => p.peerId === state.hostId;
    const hostPlayer = state.players.find(isHostPlayer);
    const isHost = localPeerId !== undefined && state.hostId === localPeerId;

    // Warnings for this player, compared with the host's race settings
    const trackMismatch = currentTrackId !== undefined && currentTrackId !== settings.trackId;
    const allowedVehicles = vehiclesForClass ? vehiclesForClass(settings.carClass) : null;
    const vehicleBlocked = !!allowedVehicles && !!currentVehicle && !allowedVehicles.includes(currentVehicle);

    return (
      <div className="flex min-w-0 flex-col gap-3">
        <Card
          title="Lobby"
          description={`Hosted by ${hostPlayer?.name ?? "nobody yet"}`}
          action={isHost ? <SessionBadge session="host">You are host</SessionBadge> : null}
        >
          <SettingRow label="Laps">
            {isHost ? (
              <Stepper value={settings.laps} min={MIN_LAPS} max={MAX_LAPS} onChange={setLaps} />
            ) : (
              <span className="lc-mono text-[18px] font-bold text-lc-chalk">{settings.laps}</span>
            )}
          </SettingRow>
          <SettingRow label="Circuit">
            <span className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              <ReadValue>{trackName(settings.trackId)}</ReadValue>
              <TrackQualityBadge track={getTrackInfo(settings.trackId)} size="xs" />
            </span>
          </SettingRow>
          <SettingRow label="Collisions">
            {isHost ? (
              <Select
                value={settings.collisions}
                options={COLLISION_OPTIONS.map((o) => ({ id: o.value, label: o.label }))}
                onChange={(collisions) => onSetLobbySettings?.({ collisions })}
              />
            ) : (
              <ReadValue>{optionLabel(COLLISION_OPTIONS, settings.collisions)}</ReadValue>
            )}
          </SettingRow>
          <SettingRow label="Car class">
            {isHost ? (
              <Select
                value={settings.carClass}
                options={CLASS_OPTIONS.map((o) => ({ id: o.value, label: o.label }))}
                onChange={(carClass) => onSetLobbySettings?.({ carClass })}
              />
            ) : (
              <ReadValue>{optionLabel(CLASS_OPTIONS, settings.carClass)}</ReadValue>
            )}
          </SettingRow>
        </Card>

        <Card title="Drivers" action={<Badge variant="outline">{state.players.length}</Badge>} bodyClassName="gap-3">
          <ul className="m-0 flex list-none flex-col p-0">
            {state.players.map((p) => {
              const isMe = p.peerId === localPeerId;
              const carName = p.vehicle ? (vehicleLabel?.(p.vehicle) ?? p.vehicle) : "No car yet";
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
                      {isMe ? <PlayerTag size="sm" /> : null}
                    </span>
                    <span className="lc-hint truncate" title={carName}>
                      {carName}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {isHostPlayer(p) ? <SessionBadge session="host" size="sm" /> : null}
                    {!isMe ? <NetBadge stats={peerStats?.find((s) => s.peerId === p.peerId)} /> : null}
                    {p.ready ? (
                      <Badge size="sm" tone="good" icon="success">
                        Ready
                      </Badge>
                    ) : (
                      <Badge size="sm" variant="outline">
                        Not ready
                      </Badge>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {trackMismatch ? (
            <Well className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3.5 py-2.5">
              <span className="flex items-start gap-2 text-[13px] leading-snug font-medium text-lc-caution">
                <Icon name="warning" className="mt-px" />
                The host is on {trackName(settings.trackId)}
              </span>
              {onSwitchTrack ? (
                <Button size="sm" variant="secondary" onClick={() => onSwitchTrack(settings.trackId)}>
                  Switch circuit
                </Button>
              ) : null}
            </Well>
          ) : null}
          {vehicleBlocked && allowedVehicles ? (
            <Well className="flex flex-col gap-2.5 px-3.5 py-2.5">
              <span className="flex items-start gap-2 text-[13px] leading-snug font-medium text-lc-caution">
                <Icon name="warning" className="mt-px" />
                Your car is not allowed in {optionLabel(CLASS_OPTIONS, settings.carClass)} races. Pick one:
              </span>
              <div className="flex flex-wrap gap-1.5">
                {allowedVehicles.map((id) => (
                  <Button key={id} size="sm" variant="secondary" disabled={!onSwitchVehicle} onClick={() => onSwitchVehicle?.(id)}>
                    {vehicleLabel?.(id) ?? id}
                  </Button>
                ))}
              </div>
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
                {raceRunning ? "Race in progress" : "Start race"}
              </Button>
              {raceRunning && onAbortRace ? (
                <Button variant="danger" block onClick={() => setConfirmEnd(true)}>
                  End race for everyone
                </Button>
              ) : null}
              {!raceRunning ? (
                <p className={`m-0 text-center text-[12px] ${startBlocked ? "font-medium text-lc-caution" : "text-lc-slate"}`}>
                  {startBlocked ?? "Everyone not ready will still start."}
                </p>
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
                disabled={!onSetReady}
                onClick={toggleReady}
              >
                {ready ? "Ready" : "Ready up"}
              </Button>
              <p className="lc-hint m-0 text-center">
                {raceRunning ? "Race in progress." : ready ? "Press again if you are not ready. The host starts the race." : "The host starts the race."}
              </p>
            </div>
          )}
        </Card>
        <ConfirmDialog
          open={confirmEnd}
          title="End the race for everyone?"
          confirmLabel="End race"
          cancelLabel="Keep racing"
          icon={<Icon name="warning" />}
          onCancel={() => setConfirmEnd(false)}
          onConfirm={() => {
            setConfirmEnd(false);
            onAbortRace?.();
          }}
        >
          Every driver in the room stops where they are and goes back to the lobby.
        </ConfirmDialog>
      </div>
    );
  };

  const roomStatus =
    hostedCode || connected > 0 || p2pState !== "idle" ? (
      p2pState === "connected" ? (
        <Badge tone="good" dot="live">
          {connected} connected
        </Badge>
      ) : p2pState === "signaling" ? (
        <Badge tone="warn" dot>
          Connecting
        </Badge>
      ) : p2pState === "error" ? (
        <Badge tone="bad" icon="error">
          Not connected
        </Badge>
      ) : (
        <Badge variant="outline">{connected} connected</Badge>
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
        {p2pState === "connected"
          ? `${connected} connected`
          : p2pState === "signaling"
            ? "Connecting"
            : ""}
      </span>
      {/* Open races: not while in a friend's room, whose lobby takes this place */}
      {races && !lobby ? <RacesCard {...races} /> : null}

      {/* Room */}
      <div className="flex min-w-0 flex-col gap-3">
        <Card title="Private room" action={roomStatus} bodyClassName="gap-3.5">
          {hostedCode ? (
            <>
              <Well className="flex flex-col gap-1 px-4 py-3">
                <span
                  className="lc-mono text-[40px] leading-none font-bold tracking-[0.14em] break-all text-lc-chalk sm:text-[46px]"
                  aria-label={`Room code ${hostedCode}`}
                >
                  {hostedCode}
                </span>
                <span className="lc-hint">Your room code. Friends join with it, or with the invite link.</span>
              </Well>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={lobby ? "secondary" : "primary"}
                  className="flex-1"
                  disabled={!activeCode}
                  icon={<Icon name={copiedLink ? "copied" : "copy"} />}
                  onClick={copyLink}
                >
                  {copiedLink ? "Link copied" : "Copy invite link"}
                </Button>
                {canShare ? (
                  <Button variant="secondary" className="flex-1" disabled={!activeCode} icon={<Icon name="share" />} onClick={() => void shareInvite()}>
                    Share
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <Button variant={races || lobby || joinReady ? "secondary" : "primary"} block onClick={hostRoom}>
              Host a room
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
              label={hostedCode ? "Join another room" : "Join a friend's room"}
              value={roomCodeInput}
              onChange={(v) => {
                setRoomCodeInput(v.toUpperCase());
                setJoinHint(null);
                if (lastAction === "join") setLastAction(null);
              }}
              placeholder="Room code"
              maxLength={6}
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              error={joinError}
              trailing={
                <Button type="submit" size="sm" variant={joinReady && !hostedCode && !races && !lobby ? "primary" : "secondary"} className="-mr-2">
                  Join
                </Button>
              }
            />
          </form>
          {hostedCode ? (
            <Button size="sm" variant="ghost" className="self-start" onClick={hostRoom}>
              Host a new room instead
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
          <Well className="flex min-h-11 min-w-0 items-center gap-2.5 py-1 pr-1 pl-3.5" aria-label={`Racing as ${profile.name}`}>
            {/* The driver's own colour: data */}
            <span aria-hidden className="size-3 shrink-0 rounded-full" style={{ backgroundColor: profile.color }} />
            <span className="lc-mono text-[12px] font-bold tracking-[0.08em] text-lc-slate">{profile.code}</span>
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{profile.name}</span>
            {onOpenProfile ? (
              <Button size="sm" variant="ghost" icon={<Icon name="edit" />} onClick={onOpenProfile}>
                Edit
              </Button>
            ) : null}
          </Well>
        ) : null}

        <div className="flex flex-col gap-1 px-2">
          <Disclosure moreLabel="More ways to connect" lessLabel="Fewer ways to connect">
            <div className="flex flex-col gap-3.5 pb-2">
              <ConnectSection title="Two windows on this computer" intro="Race another tab or window of this browser, without a room.">
                <Button size="sm" variant="secondary" className="self-start" disabled={!onHostLocal} onClick={() => onHostLocal?.()}>
                  Race these tabs
                </Button>
              </ConnectSection>

              <ConnectSection
                title="Connect by hand"
                intro="No room: the host makes an offer, the other player answers, and you swap the two tokens."
              >
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
                      }, "Couldn't create an offer. Try again.")
                    }
                  >
                    1. Create offer (host)
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
                      }, "That offer didn't work. Check you pasted all of it.")
                    }
                  >
                    2. Paste offer, get answer
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
                      }, "That answer didn't work. Check you pasted all of it.")
                    }
                  >
                    3. Accept answer (host)
                  </Button>
                </div>
                <TextField
                  label="Token from the other player"
                  value={sdpInput}
                  onChange={(v) => {
                    setSdpInput(v);
                    setSdpError("");
                  }}
                  placeholder="Paste it here"
                  autoComplete="off"
                  spellCheck={false}
                  error={sdpError || undefined}
                />
                {sdp.stage === "accepted" ? (
                  <p className="m-0 flex items-center gap-2 text-[13px] font-medium text-lc-gain">
                    <Icon name="success" size="xs" />
                    Answer accepted. Connecting…
                  </p>
                ) : null}
                {generatedToken ? (
                  <TextField
                    label="Your token: send it to the other player"
                    value={generatedToken}
                    onChange={() => undefined}
                    readOnly
                    trailing={
                      <Button
                        size="sm"
                        variant="secondary"
                        className="-mr-2"
                        icon={<Icon name={copiedToken ? "copied" : "copy"} />}
                        onClick={() => {
                          navigator.clipboard?.writeText(generatedToken).catch(() => undefined);
                          flashCopiedToken();
                        }}
                      >
                        {copiedToken ? "Copied" : "Copy"}
                      </Button>
                    }
                  />
                ) : null}
                {sdp.stage !== "idle" ? (
                  <Button size="sm" variant="ghost" className="self-start" disabled={sdpBusy} onClick={resetSdp}>
                    Start over
                  </Button>
                ) : null}
              </ConnectSection>

              <ConnectSection
                title="Your own relay server"
                intro="If players can't reach each other: a relay (TURN) server you run or rent, for connections made after saving."
              >
                <div className="grid gap-2.5 sm:grid-cols-3">
                  <TextField
                    label="Relay address"
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
                  <TextField label="Username" value={turnUser} onChange={setTurnUser} autoComplete="off" spellCheck={false} />
                  <TextField label="Password" type="password" value={turnCred} onChange={setTurnCred} autoComplete="new-password" />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={turnSaved ? <Icon name="success" /> : undefined}
                    disabled={!turnUrl.trim()}
                    onClick={saveTurn}
                  >
                    {turnSaved ? "Saved" : "Save"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={clearTurn}>
                    Clear
                  </Button>
                </div>
              </ConnectSection>
            </div>
          </Disclosure>
          {turnConfigured ? (
            <p className="lc-hint m-0 flex items-center gap-1.5">
              <Icon name="relay" size="xs" />
              Using your own relay server
            </p>
          ) : null}
        </div>
      </div>

      {lobby ? renderLobby(lobby) : null}
    </div>
  );
};
