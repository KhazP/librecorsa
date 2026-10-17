"use client";

import React, { useState } from "react";
import { Check, Copy, Radio } from "lucide-react";
import type { P2PConnectionStatus } from "@/lib/sim/multiplayer-sync";

export interface MultiplayerPanelProps {
  p2pStatus?: P2PConnectionStatus;
  initialRoomCode?: string;
  onHostP2PRoom?: (customCode?: string) => string;
  onJoinP2PRoom?: (roomCode: string) => void;
  onCreateManualOffer?: () => Promise<string>;
  onAcceptManualOffer?: (offerToken: string) => Promise<string>;
  onAcceptManualAnswer?: (answerToken: string) => Promise<boolean>;
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
}) => {
  const [roomCodeInput, setRoomCodeInput] = useState(initialRoomCode);
  const [sdpInput, setSdpInput] = useState("");
  const [generatedToken, setGeneratedToken] = useState("");
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [sdpBusy, setSdpBusy] = useState(false);

  const runSdp = async (fn: () => Promise<void>) => {
    setSdpBusy(true);
    try {
      await fn();
    } finally {
      setSdpBusy(false);
    }
  };

  return (
    <div className="rounded-md bg-[#14141c] p-4 text-white">
      <div className="mb-3 flex items-center justify-between border-b border-white/10 pb-2">
        <span className="flex items-center gap-2 font-f1-italic text-base uppercase tracking-wider text-[#00D2BE]">
          <Radio className="h-4 w-4" />
          Multiplayer (peer-to-peer)
        </span>
        <span
          className={`rounded px-2 py-0.5 font-f1-mono text-[11px] font-bold uppercase ${
            p2pStatus?.state === "connected"
              ? "bg-[#00D26A]/25 text-[#00D26A]"
              : p2pStatus?.state === "signaling"
                ? "bg-[#FFD700]/25 text-[#FFD700]"
                : "bg-zinc-800 text-zinc-400"
          }`}
        >
          {p2pStatus?.connectedWebRtcPeers ?? 0} connected
        </span>
      </div>
      <p className="mb-3 font-f1-mono text-[11px] text-zinc-400">
        {p2pStatus?.statusText ?? "Same-browser tabs connect automatically. Use a room code for other devices."}
      </p>

      <div className="mb-3 rounded border border-white/10 bg-black/30 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-f1-italic text-sm uppercase">Room code</span>
          {p2pStatus?.roomCode ? (
            <span className="rounded bg-[#E10600] px-2 py-0.5 font-f1-mono text-sm font-black tracking-widest">
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
            className="cursor-pointer rounded bg-[#E10600] px-3 py-2 font-f1-italic text-xs uppercase tracking-wider hover:bg-[#ff1e18]"
          >
            Host
          </button>
          <input
            type="text"
            maxLength={6}
            value={roomCodeInput}
            onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
            placeholder="CODE"
            className="w-28 rounded border border-white/20 bg-[#0B0B10] px-2 py-1.5 font-f1-mono text-sm font-bold uppercase tracking-widest placeholder:text-zinc-600 focus:border-[#00D2BE] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => {
              if (roomCodeInput.trim().length >= 3) onJoinP2PRoom?.(roomCodeInput.trim());
            }}
            className="cursor-pointer rounded bg-[#00D2BE] px-3 py-2 font-f1-italic text-xs uppercase tracking-wider text-[#0B0B10] hover:opacity-90"
          >
            Join
          </button>
          <button
            type="button"
            disabled={!(p2pStatus?.roomCode || roomCodeInput.trim())}
            onClick={() => {
              const activeCode = (p2pStatus?.roomCode || roomCodeInput.trim()).replace(/^RWA-/i, "").toUpperCase();
              if (!activeCode || typeof window === "undefined") return;
              navigator.clipboard?.writeText(`${window.location.origin}${window.location.pathname}?room=RWA-${activeCode}`);
              setCopiedLink(true);
              setTimeout(() => setCopiedLink(false), 2000);
            }}
            className="cursor-pointer rounded border border-white/20 bg-white/10 px-3 py-2 font-f1-italic text-xs uppercase tracking-wider hover:bg-white/20 disabled:opacity-40"
          >
            {copiedLink ? "Link copied" : "Copy invite"}
          </button>
        </div>
      </div>

      <div className="rounded border border-white/10 bg-black/30 p-3">
        <div className="mb-2 font-f1-italic text-sm uppercase text-[#FFD700]">Manual connection (no broker)</div>
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
            className="cursor-pointer rounded border border-[#00D2BE]/50 bg-[#00D2BE]/15 px-2.5 py-1.5 font-f1-italic text-xs uppercase text-[#00D2BE]"
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
            className="cursor-pointer rounded border border-[#FFD700]/50 bg-[#FFD700]/15 px-2.5 py-1.5 font-f1-italic text-xs uppercase text-[#FFD700] disabled:opacity-40"
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
            className="cursor-pointer rounded border border-[#00D26A]/50 bg-[#00D26A]/20 px-2.5 py-1.5 font-f1-italic text-xs uppercase text-[#00D26A] disabled:opacity-40"
          >
            3 · Accept answer (host)
          </button>
        </div>
        <input
          type="text"
          value={sdpInput}
          onChange={(e) => setSdpInput(e.target.value)}
          placeholder="Paste the other player's token here"
          className="w-full rounded border border-white/15 bg-[#0B0B10] px-2 py-1.5 font-f1-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-[#00D2BE] focus:outline-none"
        />
        {generatedToken ? (
          <div className="mt-2 flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={generatedToken}
              className="flex-1 rounded border border-[#00D26A]/50 bg-[#0B0B10] px-2 py-1.5 font-f1-mono text-xs text-[#00D26A]"
            />
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(generatedToken);
                setCopiedToken(true);
                setTimeout(() => setCopiedToken(false), 1800);
              }}
              className="flex cursor-pointer items-center gap-1 rounded bg-[#00D26A] px-2.5 py-1.5 font-f1-italic text-xs uppercase text-[#0B0B10]"
            >
              {copiedToken ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copiedToken ? "Copied" : "Copy"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
};
