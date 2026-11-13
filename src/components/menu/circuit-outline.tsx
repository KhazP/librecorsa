"use client";

import React, { useEffect, useReducer, useState } from "react";
import { buildHudMap, mapPoint, SECTOR_COLORS, type HudMap } from "@/components/hud/styles/hud-style-parts";
import { withBasePath } from "@/lib/base-path";
import {
  ACTIVE_TRACK_ID,
  DEFAULT_TRACK_ID,
  DEFAULT_TRACK_JSON,
  getTrackData,
  type RawTrackJson,
  type TrackMetaExtras,
} from "@/lib/track-data";
import type { TrackInfo } from "@/lib/track-registry";

/** Circuit outline from a centreline: a volt thumbnail, or coloured by sector with the flow dashes */
export const TrackOutline: React.FC<{ map: HudMap; sectors?: boolean; className?: string; label?: string; thin?: boolean }> = ({
  map,
  sectors = false,
  className,
  label,
  thin = false,
}) => {
  const pad = 60;
  const [sx, sy] = mapPoint(map, 0);
  return (
    <svg
      viewBox={`${-pad} ${-pad} ${map.w + pad * 2} ${map.h + pad * 2}`}
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={map.path} fill="none" stroke={sectors ? "#141822" : "#1B1F2B"} strokeWidth={sectors ? 52 : thin ? 44 : 56} strokeLinejoin="round" />
      {sectors ? (
        map.sectorPaths.map((d, i) => (
          <path key={i} d={d} fill="none" stroke={SECTOR_COLORS[i]} strokeWidth={16} strokeLinejoin="round" strokeLinecap="round" />
        ))
      ) : (
        <path d={map.path} fill="none" stroke={thin ? "#C5CBD8" : "#CCFF00"} strokeWidth={thin ? 16 : 22} strokeLinejoin="round" />
      )}
      {sectors ? (
        <path d={map.path} fill="none" stroke="#F5F7FA" strokeOpacity={0.7} strokeWidth={4} strokeDasharray="3 37" className="lc-flow" />
      ) : null}
      <rect x={sx - 6} y={sy - 28} width={12} height={56} rx={3} fill="#F5F7FA" />
    </svg>
  );
};

/**
 * Outlines of circuits other than the loaded one, drawn from each circuit's own `track_data.json` centreline (the same
 * samples the scene is built from). Fetched on demand, one at a time, and kept for the session; the loaded circuit and
 * the bundled default circuit need no fetch. A failed fetch is retried the next time the outline is wanted, once
 * RETRY_AFTER_MS has passed (or at once when the browser comes back online).
 */
const outlines = new Map<string, HudMap>();
/** When each circuit's last fetch failed */
const failedAt = new Map<string, number>();
const listeners = new Set<() => void>();
const queue: TrackInfo[] = [];
let fetching = false;
const RETRY_AFTER_MS = 15_000;
/** A request that hangs gives up after this, so the outlines queued behind it still load */
const FETCH_TIMEOUT_MS = 12_000;

const notify = () => {
  for (const l of listeners) l();
};

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    if (failedAt.size === 0) return;
    failedAt.clear();
    notify();
  });
}

const outlineOfRaw = (raw: RawTrackJson): HudMap =>
  buildHudMap({
    totalLengthM: raw.metadata.lengthMeters,
    pointToPoint: (raw.metadata as RawTrackJson["metadata"] & TrackMetaExtras).pointToPoint,
    samples: raw.samples.map((s) => ({ position: { x: s.p[0], z: s.p[2] }, sector: s.sec })),
  });

/** The outline when it is at hand: `undefined` = not loaded yet (or due a retry), `null` = it could not be loaded */
function outlineNow(t: TrackInfo): HudMap | null | undefined {
  const known = outlines.get(t.id);
  if (known !== undefined) return known;
  const failed = failedAt.get(t.id);
  if (failed !== undefined) {
    if (performance.now() - failed < RETRY_AFTER_MS) return null;
    failedAt.delete(t.id);
  }
  let map: HudMap | undefined;
  if (t.id === ACTIVE_TRACK_ID) map = buildHudMap(getTrackData());
  else if (t.id === DEFAULT_TRACK_ID || !t.dataUrl) map = outlineOfRaw(DEFAULT_TRACK_JSON);
  if (map) outlines.set(t.id, map);
  return map;
}

async function pump(): Promise<void> {
  if (fetching) return;
  fetching = true;
  try {
    while (queue.length) {
      const t = queue.shift()!;
      if (outlines.has(t.id) || failedAt.has(t.id) || !t.dataUrl) continue;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(withBasePath(t.dataUrl), { signal: abort.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        outlines.set(t.id, outlineOfRaw((await res.json()) as RawTrackJson));
      } catch {
        failedAt.set(t.id, performance.now());
      } finally {
        clearTimeout(timer);
      }
      notify();
    }
  } finally {
    fetching = false;
  }
}

/** Queues a circuit's outline; `urgent` (the detail pane) goes to the front */
function request(t: TrackInfo, urgent: boolean): void {
  if (outlineNow(t) !== undefined) return;
  const i = queue.findIndex((q) => q.id === t.id);
  if (i >= 0) {
    if (!urgent) return;
    queue.splice(i, 1);
  }
  if (urgent) queue.unshift(t);
  else queue.push(t);
  void pump();
}

/**
 * A circuit's real outline. `want` starts the load (a card once it scrolls near the view, the detail pane at once);
 * until it arrives this returns undefined, and null when the data could not be fetched.
 */
export function useCircuitOutline(track: TrackInfo | undefined, want: boolean, urgent = false): HudMap | null | undefined {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    listeners.add(refresh);
    return () => {
      listeners.delete(refresh);
    };
  }, []);
  const map = track ? outlineNow(track) : undefined;
  useEffect(() => {
    if (track && want && map === undefined) request(track, urgent);
  }, [track, want, urgent, map]);
  return map;
}

/** True once the element has come within a screen of the view (and stays true) */
export function useNearView(ref: React.RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "200px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, near]);
  return near;
}
