"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { LibreCorsaSimulator } from "@/components/LibreCorsaSimulator";
import { RenderProfiler } from "@/components/dev/RenderProfiler";
import { activateTrack, getTrackInfo, loadStoredTrackId, RWANDA_TRACK_ID } from "@/lib/track-registry";
import { registerAssetCache } from "@/lib/service-worker";

/** How long the "couldn't load" notice stays up (ms) */
const ERROR_NOTICE_MS = 6000;

/**
 * Activates the chosen circuit before the simulator mounts, and remounts it (fresh scene, physics and
 * menus) when the player picks another one from the title menu.
 */
export const TrackGate: React.FC = () => {
  const [trackId, setTrackId] = useState<string | null>(null);
  /** The circuit the simulator is mounted on (null before the first load lands) */
  const trackIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Only the latest pick counts: a slower load of a circuit picked earlier must not land after it
  const requestRef = useRef(0);
  const select = useCallback(async (id: string) => {
    const req = ++requestRef.current;
    // A new pick replaces the last one's notice
    setError(null);
    try {
      const info = await activateTrack(id);
      if (req !== requestRef.current) return;
      trackIdRef.current = info.id;
      setTrackId(info.id);
    } catch (err) {
      if (req !== requestRef.current) return;
      const current = trackIdRef.current;
      if (current !== null) {
        // A failed load never replaces the active circuit: the one in use stays, as it is
        console.warn(`Track switch failed, staying on ${current}:`, err);
        setError(`Couldn't load that circuit. Staying on ${getTrackInfo(current).name}.`);
        return;
      }
      // The first load has nothing to stay on: Rwanda ships with the bundle
      console.warn("Track load failed, using Rwanda:", err);
      try {
        await activateTrack(RWANDA_TRACK_ID);
      } catch (fallbackErr) {
        // This only fails if the bundled circuit is broken too
        console.error("Rwanda fallback failed:", fallbackErr);
      }
      if (req !== requestRef.current) return;
      trackIdRef.current = RWANDA_TRACK_ID;
      setTrackId(RWANDA_TRACK_ID);
      setError(`Couldn't load that circuit. Driving ${getTrackInfo(RWANDA_TRACK_ID).name} instead.`);
    }
  }, []);

  useEffect(() => {
    registerAssetCache();
    void select(loadStoredTrackId());
  }, [select]);

  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(null), ERROR_NOTICE_MS);
    return () => window.clearTimeout(id);
  }, [error]);

  if (!trackId) return null;
  return (
    <>
      <RenderProfiler id="sim">
        <LibreCorsaSimulator key={trackId} trackId={trackId} onSelectTrack={(id) => void select(id)} />
      </RenderProfiler>
      {error ? (
        <div
          role="alert"
          className="lc-ui-zoom pointer-events-none fixed bottom-4 left-1/2 z-50 inline-flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2.5 rounded-full border border-[#FF2A3C]/45 bg-[#08090D]/85 px-4 py-2 font-f1-mono text-[12px] font-bold text-[#F5F7FA] shadow-[0_14px_40px_rgba(0,0,0,0.5)] backdrop-blur-md"
        >
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-[#FF2A3C]" />
          {error}
        </div>
      ) : null}
    </>
  );
};
