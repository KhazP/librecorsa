"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import { BASE_ALTITUDE_M, type BuiltTrackData, DEFAULT_TRACK_ID, TURN_METADATA } from "@/lib/track-data";
import { getTrackInfo } from "@/lib/track-registry";
import { formatMegabytes, useAssetProgress, type AssetTask } from "@/lib/loading/asset-progress";
import { connectedPads } from "@/lib/input/device-input";
import { keyLabel } from "@/lib/input/bindings";
import { useKeyLayout } from "@/lib/input/use-key-layout";
import { enterFullscreenOnTouch } from "@/lib/install-app";
import { padPressTracker } from "./useMenuNav";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { Meter } from "@/components/ui";
import { Icon } from "@/components/ui/icons";
import { useUnits } from "@/lib/settings/ui-prefs";
import { DISTANCE_LABEL, distanceIn } from "@/lib/settings/units";
import { carById, type CarId } from "@/lib/cars/car-registry";
import { supportLabel } from "@/lib/modder-support";
import { carMaker, circuitMaker, GAME_MAKER } from "@/lib/modders";
import { useStoreBuild } from "@/lib/use-store-build";

type LoadingTranslator = ReturnType<typeof useTranslations<"menu.loading">>;

/** The tips, naming the player's own camera and racing-line keys as printed on their keyboard */
const tipsFor = (tx: LoadingTranslator, camera: string, line: string, freeCamera: string, tvCamera: string) => [
  tx("tipMenu"),
  tx("tipBraking"),
  tx("tipCamera", { key: camera }),
  tx("tipFreeCamera", { freeKey: freeCamera, tvKey: tvCamera }),
  tx("tipLine", { key: line }),
  tx("tipBoost"),
];

/** A tip for a circuit high enough for the thin air to matter (to the nearest 50 m) */
const altitudeTip = (tx: LoadingTranslator, m: number) =>
  tx("tipAltitude", { altitude: (Math.round(m / 50) * 50).toLocaleString("en-US") });

const LIGHTS = 5;

/** One line of status: what is arriving now, with its size where it is known */
function statusLine(tx: LoadingTranslator, tasks: readonly AssetTask[]): string {
  const now = tasks.find((t) => t.status === "loading") ?? tasks.find((t) => t.status === "pending");
  if (!now) return tx("ready");
  if (now.id === "shaders") return now.status === "loading" ? tx("compilingShaders") : tx("shadersQueued");
  if (now.status === "pending") return tx("assetQueued", { asset: now.label });
  return now.totalBytes > 0
    ? tx("assetProgress", { asset: now.label, loaded: formatMegabytes(now.loadedBytes), total: formatMegabytes(now.totalBytes) })
    : `${now.label}`;
}

/** Shown once loaded; touch screens are told to tap */
const ContinuePrompt: React.FC = () => {
  const tx = useTranslations("menu.loading");
  return (
    <span className="lc-disp text-[24px] text-lc-volt sm:text-[28px] phone:text-[22px]">
      <span className="pointer-coarse:hidden">{tx("pressAnyKey")}</span>
      <span className="hidden pointer-coarse:inline">{tx("tapToContinue")}</span>
    </span>
  );
};

/**
 * Who made what is about to load: the circuit's modder, the car's (in its credit's words: the Liana's is its
 * physics), and the game. A maker who takes donations gets a direct link plus a reminder that their Source button
 * always carries it. Left out in the Android app (store-mode.ts).
 */
const MakersLines: React.FC<{ trackId: string; trackName: string; carId: CarId }> = ({ trackId, trackName, carId }) => {
  const store = useStoreBuild();
  const tx = useTranslations("menu.loading");
  const circuit = circuitMaker(trackId);
  const car = carMaker(carId);
  const carTitle = carById(carId).title;
  const name = (chunks: React.ReactNode) => <span className="font-semibold text-lc-chalk">{chunks}</span>;
  const lines = [
    circuit ? { key: "circuit", text: tx.rich("circuitBy", { circuit: trackName, maker: circuit.name, name }), maker: circuit } : null,
    {
      key: "car",
      // In the credit's own words: the Liana's is its physics
      text:
        car.role === "Model"
          ? tx.rich("carModelBy", { car: carTitle, maker: car.name, name })
          : car.role === "Physics"
            ? tx.rich("carPhysicsBy", { car: carTitle, maker: car.name, name })
            : tx.rich("carRoleBy", { car: carTitle, role: car.role.toLowerCase(), maker: car.name, name }),
      maker: car,
    },
    { key: "game", text: tx.rich("gameBy", { maker: GAME_MAKER.name, name }), maker: GAME_MAKER },
  ].filter((l): l is NonNullable<typeof l> => l !== null);
  const anySupport = !store && lines.some((l) => l.maker.support);
  return (
    <div className="flex flex-col gap-2 border-t border-lc-line pt-3.5 short:pt-2.5">
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[14px] leading-snug text-lc-slate short:text-[12px]">
        {lines.map((l) => (
          <li key={l.key}>
            {l.text}
            {!store && l.maker.support ? (
              <>
                {" · "}
                <a
                  href={l.maker.support.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-lc-fog underline decoration-lc-keyline underline-offset-2 transition-colors hover:text-lc-volt"
                >
                  {supportLabel(l.maker.support)}
                </a>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {anySupport ? (
        <p className="m-0 flex items-start gap-1.5 text-[13px] leading-snug text-lc-fog short:hidden">
          <Icon name="support" className="mt-px shrink-0 text-lc-volt" />
          {tx("donateHint")}
        </p>
      ) : null}
    </div>
  );
};

/** One start-light column (two lamps) inside the gantry */
const LightColumn: React.FC<{ lit: boolean; ready: boolean }> = ({ lit, ready }) => {
  // Real start lights: red lamps, out for the go (green here, once everything is in)
  const lamp = `size-4.5 rounded-full sm:size-5.5 phone:size-4.5 ${
    ready
      ? "bg-lc-gain shadow-[0_0_14px_var(--color-lc-gain)]"
      : lit
        ? "bg-lc-crimson shadow-[0_0_16px_var(--color-lc-crimson)]"
        : "bg-lc-titanium inset-shadow-sm inset-shadow-lc-void"
  }`;
  return (
    <span className="flex flex-col gap-1.5 rounded-lc-row bg-lc-void p-1.5">
      <span className={lamp} />
      <span className={lamp} />
    </span>
  );
};

/**
 * Full-screen LibreCorsa loading screen: the circuit draws itself in Corsa Volt as the assets arrive and the
 * five start lights fill; once everything is ready the lights go out and any key / click / controller button continues.
 */
export const LoadingScreen: React.FC<{
  track: BuiltTrackData;
  /** The car about to drive, for its maker's line */
  carId: CarId;
  ready: boolean;
  /** The camera and racing-line keys (KeyboardEvent.code) the tips name, as printed on this keyboard */
  cameraKey?: string;
  freeCameraKey?: string;
  tvCameraKey?: string;
  lineKey?: string;
  /** Called synchronously inside the user gesture (audio unlock) */
  onStart: () => void;
  /** Called once the fade-out has finished */
  onDone: () => void;
}> = ({ track, carId, ready, cameraKey, freeCameraKey, tvCameraKey, lineKey, onStart, onDone }) => {
  const progress = useAssetProgress();
  const units = useUnits();
  const layout = useKeyLayout();
  const tx = useTranslations("menu.loading");
  const tips = useMemo(() => {
    const base = tipsFor(
      tx,
      keyLabel(cameraKey ?? "KeyC"),
      keyLabel(lineKey ?? "KeyR"),
      keyLabel(freeCameraKey ?? "F7"),
      keyLabel(tvCameraKey ?? "F8"),
    );
    return BASE_ALTITUDE_M >= 1000 ? [altitudeTip(tx, BASE_ALTITUDE_M), ...base] : base;
    // Re-run when the layout is read (its identity changes): the key names follow it; and with the language
  }, [layout, cameraKey, freeCameraKey, tvCameraKey, lineKey, tx]);
  const [tip, setTip] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);
  // The fade's end; cleared only on unmount (the listeners' effect can re-run mid-fade and must not drop it)
  const doneTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (doneTimer.current !== null) window.clearTimeout(doneTimer.current);
    },
    []
  );
  const shown = ready ? 1 : progress.progress;
  const trackInfo = getTrackInfo(track.id ?? DEFAULT_TRACK_ID);

  const circuit = useMemo(() => {
    // A hill climb draws its run, from the start line to the finish, not the loop its data closes
    const finishS = track.pointToPoint?.finishS;
    const samples = finishS === undefined ? track.samples : track.samples.filter((s) => s.s <= finishS);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const s of samples) {
      minX = Math.min(minX, s.position.x);
      maxX = Math.max(maxX, s.position.x);
      minZ = Math.min(minZ, s.position.z);
      maxZ = Math.max(maxZ, s.position.z);
    }
    const size = Math.max(maxX - minX, maxZ - minZ);
    const ox = (size - (maxX - minX)) / 2;
    const oz = (size - (maxZ - minZ)) / 2;
    const pts = samples
      .filter((_, i) => i % 3 === 0)
      .map((s) => [((s.position.x - minX + ox) / size) * 100, ((s.position.z - minZ + oz) / size) * 100] as const);
    const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
    return { d: finishS === undefined ? `${d} Z` : d, pts };
  }, [track]);
  const outline = circuit.d;
  // Start / finish marker across the first segment, and the comet at the drawing's leading edge
  const sf = useMemo(() => {
    const [a, b] = [circuit.pts[0], circuit.pts[1] ?? circuit.pts[0]];
    if (!a) return null;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    // Label on the side of the line that faces away from the circuit's centre
    const out = (a[0] - 50) * nx + (a[1] - 50) * ny >= 0 ? 1 : -1;
    return { x: a[0], y: a[1], nx, ny, out };
  }, [circuit]);
  const comet = circuit.pts.length
    ? circuit.pts[Math.min(circuit.pts.length - 1, Math.floor(shown * circuit.pts.length))]
    : null;

  useEffect(() => {
    setTip(Math.floor(Math.random() * tips.length));
    const id = window.setInterval(() => setTip((t) => (t + 1) % tips.length), 5200);
    return () => window.clearInterval(id);
  }, [tips]);

  // The press that leaves: one only, and the screen always goes, whatever the start (audio unlock) does
  const start = useCallback(() => {
    if (!ready || leavingRef.current) return;
    leavingRef.current = true;
    try {
      onStart();
    } catch (err) {
      console.warn("Loading screen start failed; leaving it anyway", err);
    }
    // A phone or tablet tab goes full screen on this tap, after the audio unlock: a fullscreen request uses up the
    // tap's user activation, and starting the sound does not, so both get it in this order. From the pad poll there
    // is no activation, and the browser just says no (it never throws)
    enterFullscreenOnTouch();
    setLeaving(true);
    doneTimer.current = window.setTimeout(onDone, 520);
  }, [ready, onStart, onDone]);

  useEffect(() => {
    if (!ready) return;
    const onKey = (e: KeyboardEvent) => {
      // Only the key that starts is used up: during the fade the menu underneath already takes keys
      if (e.repeat || leavingRef.current) return;
      e.preventDefault();
      start();
    };
    const onPointer = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("a")) return;
      if ((e.type === "pointerdown") === (e.pointerType === "mouse")) start();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("pointerup", onPointer);
    // A real press on some pad: not a release while another pad holds a button, nor a pad connecting with one held
    let raf = 0;
    const pressed = padPressTracker();
    const poll = () => {
      raf = requestAnimationFrame(poll);
      if (pressed(connectedPads())) start();
    };
    raf = requestAnimationFrame(poll);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("pointerup", onPointer);
      cancelAnimationFrame(raf);
    };
  }, [ready, start]);

  const litLights = ready ? 0 : Math.min(LIGHTS, Math.floor(shown * LIGHTS + 0.001));
  const lengthKm = (track.pointToPoint?.finishS ?? track.totalLengthM) / 1000;

  return (
    <div
      // The account side may reload the page for a newer cloud save while this is up and not yet pressed through
      // (src/lib/account/account-store.ts)
      data-loading-screen={leaving ? undefined : ""}
      className={`lc-ui-zoom pointer-events-auto fixed inset-0 z-50 flex flex-col overflow-y-auto bg-lc-void text-lc-chalk transition-opacity duration-500 ${
        leaving ? "opacity-0" : "opacity-100"
      }`}
    >
      {/* The one thing a player waits for here, read out once: the track is ready (not the percentage, which climbs) */}
      <span className="sr-only" aria-live="polite">
        {ready ? tx("readyAnnouncement") : ""}
      </span>
      {/* The circuit's own outline echoed in faint contour rings behind the drawing */}
      <svg
        aria-hidden
        viewBox="-60 -60 220 220"
        className="pointer-events-none fixed top-1/2 left-1/2 h-[170vmax] w-[170vmax] -translate-x-1/2 -translate-y-1/2 lg:start-[74%] lg:h-[150vmin] lg:w-[150vmin]"
      >
        <g fill="none" stroke="var(--color-lc-carbon)" strokeWidth="1">
          {[
            { k: 1.05, r: 8 },
            { k: 1.3, r: 4 },
            { k: 1.6, r: 0 },
          ].map(({ k, r }) => (
            <path
              key={k}
              d={outline}
              vectorEffect="non-scaling-stroke"
              transform={`translate(50 50) scale(${k}) rotate(${r}) translate(-50 -50)`}
            />
          ))}
        </g>
      </svg>

      <div className="relative mx-auto flex w-full max-w-[1440px] flex-1 flex-col pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] pt-[max(clamp(28px,4.4vh,48px),env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:pl-[max(2.5rem,env(safe-area-inset-left))] sm:pr-[max(2.5rem,env(safe-area-inset-right))] lg:pl-[max(4rem,env(safe-area-inset-left))] lg:pr-[max(4rem,env(safe-area-inset-right))]">
        <div className="grid flex-1 grid-cols-1 items-center gap-8 lg:grid-cols-2 lg:gap-10 short:grid-cols-[minmax(0,1fr)_auto] short:gap-6">
          <div className="order-2 flex max-w-[560px] min-w-0 flex-col gap-[clamp(20px,3.6vh,36px)] lg:order-1 short:order-1">
            <LibreCorsaLogo variant="full" size="lg" />

            {/* Percentage and the start lights as the progress indicator: the lights under the number, so "100%" never
                pushes them to another line as it arrives (beside it on a landscape phone, where height is short) */}
            <div className="flex flex-col items-start gap-4 short:flex-row short:items-end short:gap-x-5">
              <span className="lc-disp text-[clamp(72px,12vw,168px)] tracking-[-0.02em] text-lc-chalk tabular-nums phone:text-[48px]">
                {Math.round(shown * 100)}%
              </span>
              <div
                role="img"
                aria-label={ready ? tx("lightsOut") : tx("lights", { lit: String(litLights), total: String(LIGHTS) })}
                className="flex gap-2 rounded-lc-tile border border-lc-line bg-lc-carbon px-3 py-2.5 short:mb-2 phone:gap-1.5 phone:px-2 phone:py-2"
              >
                {Array.from({ length: LIGHTS }, (_, i) => (
                  <LightColumn key={i} lit={i < litLights} ready={ready} />
                ))}
              </div>
            </div>

            {/* What is arriving now: the overall progress and one line of status; once all of it is in, compact screens drop it for the pinned prompt */}
            <div className={`flex flex-col gap-2.5 ${ready ? "compact:hidden" : ""}`}>
              <Meter label={ready ? tx("ready") : statusLine(tx, progress.tasks)} value={shown} tone={ready ? "good" : "info"} stacked />
              {progress.anyFailed ? (
                <p className="m-0 flex items-start gap-2 text-[13px] leading-snug text-lc-caution">
                  <Icon name="warning" className="mt-px" />
                  {tx("assetsFailed")}
                </p>
              ) : null}
            </div>

            <div className={`min-h-[60px] ${ready ? "compact:hidden" : ""}`}>
              {ready ? (
                <ContinuePrompt />
              ) : (
                <p key={tip} className="lc-body m-0 max-w-[60ch] text-[15px] sm:text-base">
                  {tips[tip % tips.length]}
                </p>
              )}
            </div>

            <MakersLines trackId={trackInfo.id} trackName={trackInfo.name} carId={carId} />
          </div>

          {/* The circuit drawing itself in Corsa Volt, named under it */}
          <div className="order-1 mx-auto flex w-full max-w-[min(280px,32vh)] flex-col items-center justify-center gap-3 lg:order-2 lg:max-w-[min(640px,100%,calc(100dvh_-_14rem))] short:order-2 short:w-[min(220px,45vh)] short:max-w-none short:gap-1.5">
            <svg
              viewBox="-8 -8 116 116"
              className="h-auto w-full overflow-visible"
              role="img"
              aria-label={tx("drawing", { circuit: trackInfo.name })}
            >
              <path d={outline} fill="none" stroke="var(--color-lc-carbon)" strokeWidth="5.6" strokeLinejoin="round" />
              <path d={outline} fill="none" stroke="var(--color-lc-titanium)" strokeWidth="1.6" strokeLinejoin="round" />
              <path
                d={outline}
                pathLength={1}
                fill="none"
                stroke="var(--color-lc-volt)"
                strokeWidth="1.6"
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray="1 1"
                strokeDashoffset={1 - shown}
                style={{ transition: "stroke-dashoffset 300ms ease-out" }}
              />
              {!ready && comet ? (
                <circle
                  cx={comet[0]}
                  cy={comet[1]}
                  r="1.6"
                  fill="var(--color-lc-chalk)"
                  className="lc-breathe"
                />
              ) : null}
              {sf ? (
                  <line
                    x1={sf.x - sf.nx * 3.4}
                    y1={sf.y - sf.ny * 3.4}
                    x2={sf.x + sf.nx * 3.4}
                    y2={sf.y + sf.ny * 3.4}
                    stroke="var(--color-lc-chalk)"
                    strokeWidth="1.1"
                    strokeLinecap="round"
                  />
              ) : null}
            </svg>
            <div className="flex flex-col items-center gap-0.5 text-center">
              <span className="lc-h3 text-balance text-lc-chalk short:text-[14px]">{trackInfo.name}</span>
              <span className="lc-hint short:text-[11px]">
                {tx("trackLine", {
                  place: [trackInfo.layout, trackInfo.city].filter(Boolean).join(" · "),
                  length: `${distanceIn(lengthKm, units.speed).toFixed(2)} ${DISTANCE_LABEL[units.speed]}`,
                  turns: TURN_METADATA.length,
                })}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Compact screens: the prompt stays pinned to the bottom instead of falling below the fold */}
      {ready ? (
        <div className="sticky bottom-0 hidden border-t border-lc-line bg-lc-void/92 pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-md compact:block sm:pl-[max(2.5rem,env(safe-area-inset-left))] sm:pr-[max(2.5rem,env(safe-area-inset-right))]">
          <div className="mx-auto max-w-[1440px]">
            <ContinuePrompt />
          </div>
        </div>
      ) : null}
    </div>
  );
};
