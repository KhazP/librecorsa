"use client";

/*
 * The home page's lap times: the game's online board (src/components/board/OnlineBoard.tsx) in its own Lap times section,
 * every car's by default (the home page drives no car) or one car's, with its circuit picker and pages, and the weekly
 * challenge's boards beside it (HomeBoards.tsx). Nothing of it loads with
 * the page: once the page has finished loading and the section comes near the view, the online side is asked whether
 * its boards are on, and only then are the board's code and its first page fetched. Until then it shows a loading
 * card; with the boards off, out of reach or no online side at all, it says the lap times are offline.
 */
import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { VehicleModelId } from "@/types/f1";
import type { BoardCarTag } from "@/components/board/OnlineBoard";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icon } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/Skeleton";

const HomeBoards = lazy(() => import("./HomeBoards").then((m) => ({ default: m.HomeBoards })));

/** Set at build time: without an online side there is no board to look for */
const HAS_API = Boolean(process.env.NEXT_PUBLIC_ONLINE_API?.trim());

export interface HomeLapTimesProps {
  circuits: readonly { id: string; label: string }[];
  /** The circuit the hub has picked: the board starts there and follows it until another is picked here */
  circuit: string;
  carTags: Readonly<Partial<Record<VehicleModelId, BoardCarTag>>>;
  /** The cars the board can be narrowed to */
  carChoices: readonly { id: VehicleModelId; label: string; detail?: string }[];
  /** Car names by car id, for the challenge weeks */
  carTitles: Readonly<Record<string, string>>;
  /** The box the page scrolls in (the hub's panel), for "near the view" */
  scrollRoot: React.RefObject<HTMLElement | null>;
  /** The board is on screen (the prompt bar names its page keys then) */
  onShown?: (shown: boolean) => void;
}

/** Once the page has loaded and the browser is idle: the section never competes with what the page shows first */
function afterLoad(run: () => void): () => void {
  let idle = 0;
  let timer = 0;
  const go = () => {
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) idle = ric(run, { timeout: 2000 });
    else timer = window.setTimeout(run, 200);
  };
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
  return () => {
    window.removeEventListener("load", go);
    (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(idle);
    window.clearTimeout(timer);
  };
}

const LoadingCard: React.FC = () => (
  <div role="status" aria-label="Loading lap times…" className="flex flex-col gap-3 rounded-lc-card border border-white/7 bg-lc-carbon/80 p-4.5">
    <Skeleton shape="line" className="h-5 w-40" />
    <Skeleton shape="line" className="h-3 w-56" />
    <Skeleton className="mt-2 h-48 w-full rounded-lc-row" />
  </div>
);

export const HomeLapTimes: React.FC<HomeLapTimesProps> = ({ circuits, circuit, carTags, carChoices, carTitles, scrollRoot, onShown }) => {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"waiting" | "on" | "off" | "unreachable">("waiting");
  const [picked, setPicked] = useState<{ from: string; id: string } | null>(null);
  // The hub's pick, until another circuit is picked here (a new pick on the hub wins again)
  const shownCircuit = picked && picked.from === circuit ? picked.id : circuit;

  useEffect(() => {
    if (!HAS_API) return;
    let observer: IntersectionObserver | null = null;
    let live = true;
    let unwatch: (() => void) | null = null;
    const stop = afterLoad(() => {
      const el = sentinelRef.current;
      if (!live || !el) return;
      observer = new IntersectionObserver(
        (seen) => {
          if (!seen.some((s) => s.isIntersecting)) return;
          observer?.disconnect();
          // Followed, not asked once: a board out of reach shows up here once it answers; only "off" hides it
          void import("@/lib/net/online-config")
            .then((m) => {
              if (!live) return;
              unwatch = m.watchOnlineConfig((online) => {
                // Out of reach says so (not a loading card for good); a later "on" replaces it. A board already showing
                // stays up through a failed refresh.
                const next = m.boardStateOf(online);
                setState((s) => (next === "unreachable" && s === "on" ? s : next));
              });
            })
            .catch(() => {
              if (live) setState("off");
            });
        },
        { root: scrollRoot.current, rootMargin: "0px 0px 400px 0px" },
      );
      observer.observe(el);
    });
    return () => {
      live = false;
      stop();
      observer?.disconnect();
      unwatch?.();
    };
  }, [scrollRoot]);

  useEffect(() => {
    onShown?.(state === "on");
  }, [state, onShown]);

  return (
    // A timing list reads best at a list's width, not a wall's: centred under the tiles on a wide screen
    <div ref={sentinelRef} className="mx-auto min-h-px w-full max-w-[1200px]">
      {!HAS_API || state === "off" ? (
        <EmptyState icon={<Icon name="offline" size="lg" />}>Lap times are offline right now.</EmptyState>
      ) : state === "unreachable" ? (
        <EmptyState icon={<Icon name="offline" size="lg" />}>Leaderboard unreachable. Retrying…</EmptyState>
      ) : state === "on" ? (
        <Suspense fallback={<LoadingCard />}>
          <HomeBoards
            circuits={circuits}
            circuit={shownCircuit}
            onCircuitChange={(id) => setPicked({ from: circuit, id })}
            carTag={(v) => carTags[v] ?? { label: v, color: "slate" }}
            carChoices={carChoices}
            carTitles={carTitles}
          />
        </Suspense>
      ) : (
        <LoadingCard />
      )}
    </div>
  );
};
