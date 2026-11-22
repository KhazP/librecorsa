"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import type { HomeVenueHero } from "./home-data";

interface ResolvedHero {
  key: string;
  src: string;
  srcSet: string;
  focalClass: string;
}

/**
 * On desktop (`lg:row-span-2`), the Drive tile is taller than 16:9 (~700+ px tall), so `object-cover` needs ~1300+ px
 * source width to avoid upscaling the 540 px height of `hero-960.webp`; phones/tablets stay on `hero-960.webp`.
 */
export const VENUE_HERO_SIZES = "(min-width: 64rem) 90vw, 100vw";

const FALLBACK_HERO: ResolvedHero = {
  key: "__fallback__",
  src: withBasePath("/home/hero-1600.webp"),
  srcSet: [960, 1600, 2560].map((w) => `${withBasePath(`/home/hero-${w}.webp`)} ${w}w`).join(", "),
  focalClass: "object-[62%_50%]",
};

const BASE_IMG_CLASS =
  "absolute inset-0 h-full w-full object-cover transition-[opacity,transform] duration-500 ease-lc group-hover:scale-[1.02] motion-reduce:transition-none";

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Warms the browser cache for a newly picked venue's hero while the user is browsing the Circuits tab */
export function preloadVenueHero(hero: HomeVenueHero | null): void {
  if (!hero || typeof window === "undefined") return;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return;
  const img = new Image();
  img.sizes = VENUE_HERO_SIZES;
  img.srcset = hero.srcSet;
  img.src = hero.src;
}

/**
 * Scenic backdrop for the Home hub's Drive tile. Renders a standard `<img>` with `fetchPriority="high"` for fast LCP,
 * crossfades without blank flashes when the selected venue changes, and falls back smoothly to the stock hero still if
 * a hosted venue's still is unavailable.
 */
export const VenueHero: React.FC<{ venueId: string; hero: HomeVenueHero | null }> = ({ venueId, hero }) => {
  const [failedKeys, setFailedKeys] = useState<ReadonlySet<string>>(() => new Set());

  const target = useMemo<ResolvedHero>(() => {
    if (!hero || failedKeys.has(venueId)) return FALLBACK_HERO;
    return { key: venueId, src: hero.src, srcSet: hero.srcSet, focalClass: "object-center" };
  }, [venueId, hero, failedKeys]);

  const [shown, setShown] = useState<ResolvedHero>(target);
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const incomingRef = useRef<HTMLImageElement | null>(null);
  const pendingRafRef = useRef<number | null>(null);

  const baseHero = shown.key !== FALLBACK_HERO.key && failedKeys.has(shown.key) ? FALLBACK_HERO : shown;
  const incoming = target.key !== baseHero.key ? target : null;
  const incomingReady = Boolean(incoming && readyKey === incoming.key);

  const markFailed = useCallback((failedKey: string) => {
    if (failedKey === FALLBACK_HERO.key) return;
    setFailedKeys((prev) => {
      if (prev.has(failedKey)) return prev;
      const next = new Set(prev);
      next.add(failedKey);
      return next;
    });
  }, []);

  const revealIncoming = useCallback((img: HTMLImageElement, nextHero: ResolvedHero) => {
    if (prefersReducedMotion()) {
      setShown(nextHero);
      setReadyKey(null);
      return;
    }
    const schedule = () => {
      if (pendingRafRef.current !== null) cancelAnimationFrame(pendingRafRef.current);
      pendingRafRef.current = requestAnimationFrame(() => {
        pendingRafRef.current = null;
        setReadyKey(nextHero.key);
      });
    };
    if (typeof img.decode === "function") {
      void img.decode().then(schedule, schedule);
    } else {
      schedule();
    }
  }, []);

  // Cancel any pending rAF when the target changes or on unmount; if already cached, reveal immediately
  useEffect(() => {
    if (pendingRafRef.current !== null) {
      cancelAnimationFrame(pendingRafRef.current);
      pendingRafRef.current = null;
    }
    if (!incoming) return;
    const img = incomingRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      revealIncoming(img, incoming);
    }
    return () => {
      if (pendingRafRef.current !== null) {
        cancelAnimationFrame(pendingRafRef.current);
        pendingRafRef.current = null;
      }
    };
  }, [incoming, revealIncoming]);

  // Promote after fade finishes even if transitionend doesn't fire (background tab / reduced motion)
  useEffect(() => {
    if (!incoming || !incomingReady) return;
    const timer = window.setTimeout(() => {
      setShown(incoming);
      setReadyKey(null);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [incoming, incomingReady]);

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={baseHero.key}
        src={baseHero.src}
        srcSet={baseHero.srcSet}
        sizes={VENUE_HERO_SIZES}
        width={1600}
        height={900}
        alt=""
        fetchPriority="high"
        onError={() => markFailed(baseHero.key)}
        className={`${BASE_IMG_CLASS} ${baseHero.focalClass}`}
      />
      {incoming ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={incomingRef}
          key={incoming.key}
          src={incoming.src}
          srcSet={incoming.srcSet}
          sizes={VENUE_HERO_SIZES}
          width={1600}
          height={900}
          alt=""
          decoding="async"
          onLoad={(e) => revealIncoming(e.currentTarget, incoming)}
          onError={() => markFailed(incoming.key)}
          onTransitionEnd={(e) => {
            if (e.propertyName === "opacity" && incomingReady) {
              setShown(incoming);
              setReadyKey(null);
            }
          }}
          className={`${BASE_IMG_CLASS} ${incoming.focalClass} ${incomingReady ? "opacity-100" : "opacity-0"}`}
        />
      ) : null}
    </>
  );
};
