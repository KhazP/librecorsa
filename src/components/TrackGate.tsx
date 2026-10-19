"use client";

import React, { useCallback, useEffect, useState } from "react";
import { LibreCorsaSimulator } from "@/components/LibreCorsaSimulator";
import { activateTrack, loadStoredTrackId, RWANDA_TRACK_ID } from "@/lib/track-registry";

/**
 * Activates the chosen circuit before the simulator mounts, and remounts it (fresh scene, physics and
 * menus) when the player picks another one from the title menu.
 */
export const TrackGate: React.FC = () => {
  const [trackId, setTrackId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const select = useCallback(async (id: string) => {
    try {
      const info = await activateTrack(id);
      setError(null);
      setTrackId(info.id);
    } catch (err) {
      console.warn("Track switch failed, staying on Rwanda:", err);
      setError(`Could not load that circuit (${String(err)})`);
      await activateTrack(RWANDA_TRACK_ID);
      setTrackId(RWANDA_TRACK_ID);
    }
  }, []);

  useEffect(() => {
    void select(loadStoredTrackId());
  }, [select]);

  if (!trackId) return null;
  return (
    <>
      <LibreCorsaSimulator key={trackId} trackId={trackId} onSelectTrack={(id) => void select(id)} />
      {error ? (
        <div
          role="alert"
          className="pointer-events-none fixed bottom-4 left-1/2 z-50 inline-flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2.5 rounded-full border border-[#FF2A3C]/45 bg-[#08090D]/85 px-4 py-2 font-f1-mono text-[12px] font-bold text-[#F5F7FA] shadow-[0_14px_40px_rgba(0,0,0,0.5)] backdrop-blur-md"
        >
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-[#FF2A3C]" />
          {error}
        </div>
      ) : null}
    </>
  );
};
