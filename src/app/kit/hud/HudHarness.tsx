"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { getActiveTrackData } from "@/lib/track-data";
import { useUiZoom } from "@/lib/ui-zoom";
import { MultiPageMfd } from "@/components/hud/MultiPageMfd";
import { SplitGaps } from "@/components/hud/SplitGaps";
import { HudEditor } from "@/components/hud/HudEditor";
import { cleanHudLayoutParts, HUD_PART_IDS, type HudLayoutParts } from "@/lib/settings/hud-parts";
import { useLapDeltaTracker } from "@/components/hud/useLapDelta";
import { HudRunProvider } from "@/components/hud/styles/third-party-parts";
import { buildHudMap, revRangeOf, setActiveHudParts, type HudDesignProps, type HudStyleOptions } from "@/components/hud/styles/hud-style-parts";
import { BladeHud, BLADE_STYLE } from "@/components/hud/styles/BladeHud";
import { TracksideHud, TRACKSIDE_STYLE } from "@/components/hud/styles/TracksideHud";
import { PitWallHud, PIT_WALL_STYLE } from "@/components/hud/styles/PitWallHud";
import { EnduranceHud, ENDURANCE_STYLE } from "@/components/hud/styles/EnduranceHud";
import { RacingLineHud, RACING_LINE_STYLE } from "@/components/hud/styles/RacingLineHud";
import { TelemetryHud } from "@/components/hud/styles/TelemetryHud";
import { GtLikeHud } from "@/components/hud/styles/GtLikeHud";
import { F1LikeHud } from "@/components/hud/styles/F1LikeHud";
import { HudPreview } from "@/components/settings/hud-preview";
import { HUD_LAYOUTS } from "@/lib/settings/hud-layouts";
import { HUD_SCENARIOS, hudFixture, type HudScenario } from "./hud-fixture";

/** The layouts this page draws, with the options the in-race HUD gives each */
const STYLES: Record<string, { component: React.FC<HudDesignProps>; options: HudStyleOptions }> = {
  blade: { component: BladeHud, options: BLADE_STYLE },
  trackside: { component: TracksideHud, options: TRACKSIDE_STYLE },
  "pit-wall": { component: PitWallHud, options: PIT_WALL_STYLE },
  endurance: { component: EnduranceHud, options: ENDURANCE_STYLE },
  "racing-line": { component: RacingLineHud, options: RACING_LINE_STYLE },
  telemetry: { component: TelemetryHud, options: { bottomClearance: 252, mfdFolded: true } },
  touring: { component: GtLikeHud, options: { bottomClearance: 228, mfdFolded: true } },
  formula: { component: F1LikeHud, options: { bottomClearance: 160, mfdFolded: true } },
};

const DEFAULT_BG = "/press/screenshots/rise-side-by-side.jpg";

interface HarnessQuery {
  style: string;
  scenario: HudScenario;
  bg: string;
  mfd: boolean;
  extras: boolean;
  map: "full" | "local";
  chrome: boolean;
  /** HUD size (Settings > Display > HUD size), 0.75..1.5 */
  size: number;
  /** Moved and resized parts (hud-parts.ts), as the layout editor saves them */
  parts: HudLayoutParts;
  /** The layout editor over the HUD, framing each part it finds */
  edit: boolean;
}

/**
 * `parts=` takes the saved JSON, or a name for a quick check: `shrunk` (every part at 0.6), `grown` (every part at 1.6),
 * `moved` (every part pulled 6 % towards the middle)
 */
function readParts(raw: string | null): HudLayoutParts {
  if (!raw) return {};
  const all = (f: (id: (typeof HUD_PART_IDS)[number]) => { x: number; y: number; scale: number }) =>
    cleanHudLayoutParts(Object.fromEntries(HUD_PART_IDS.map((id) => [id, f(id)])));
  if (raw === "shrunk") return all(() => ({ x: 0, y: 0, scale: 0.6 }));
  if (raw === "grown") return all(() => ({ x: 0, y: 0, scale: 1.6 }));
  if (raw === "moved")
    return all((id) => ({ x: id.includes("left") ? 6 : id.includes("right") ? -6 : 0, y: id.startsWith("top") ? 6 : id.startsWith("bottom") ? -6 : 0, scale: 1 }));
  try {
    return cleanHudLayoutParts(JSON.parse(raw));
  } catch {
    return {};
  }
}

function readQuery(): HarnessQuery {
  const q = new URLSearchParams(window.location.search);
  const scenario = q.get("scenario") as HudScenario | null;
  return {
    style: q.get("style") && STYLES[q.get("style")!] ? q.get("style")! : "blade",
    scenario: scenario && HUD_SCENARIOS.includes(scenario) ? scenario : "race",
    bg: q.get("bg") ?? DEFAULT_BG,
    mfd: q.get("mfd") !== "0",
    extras: q.get("extras") === "1",
    map: q.get("map") === "local" ? "local" : "full",
    chrome: q.get("chrome") !== "0",
    size: Math.max(0.75, Math.min(1.5, Number(q.get("size") ?? 1) || 1)),
    parts: readParts(q.get("parts")),
    edit: q.get("edit") === "1",
  };
}

/**
 * The HUD test page: one layout over a still game frame, fed a fixed moment of a session (hud-fixture.ts).
 * `?style=blade&scenario=race|practice|gt3|lights&bg=/path.jpg&mfd=0&extras=1&map=local&chrome=0`.
 * `size=0.75..1.5` is the HUD size, `parts=shrunk|grown|moved|<json>` the layout editor's moved and resized parts, and
 * `edit=1` puts the layout editor over it. `chrome=0` drops the page's own switcher, for screenshots; `?previews=1`
 * shows every layout's picker picture instead.
 */
export function HudHarness() {
  const [query, setQuery] = useState<HarnessQuery | null>(null);
  const [previews, setPreviews] = useState(false);
  useEffect(() => {
    setQuery(readQuery());
    setPreviews(new URLSearchParams(window.location.search).get("previews") === "1");
  }, []);
  if (previews) return <Previews />;
  if (!query) return null;
  return <Harness query={query} onChange={(q) => {
    const next = { ...query, ...q };
    const params = new URLSearchParams({ style: next.style, scenario: next.scenario, mfd: next.mfd ? "1" : "0", extras: next.extras ? "1" : "0", map: next.map });
    if (next.bg !== DEFAULT_BG) params.set("bg", next.bg);
    window.history.replaceState(null, "", `?${params}`);
    setQuery(next);
  }} />;
}

function Harness({ query, onChange }: { query: HarnessQuery; onChange: (q: Partial<HarnessQuery>) => void }) {
  const track = useMemo(() => getActiveTrackData(1200), []);
  const map = useMemo(() => buildHudMap(track), [track]);
  const fixture = useMemo(() => hudFixture(track, query.scenario), [track, query.scenario]);
  const { tracker } = useLapDeltaTracker(fixture.t, track.totalLengthM);
  const zoom = useUiZoom();
  const frameRef = useRef<HTMLDivElement>(null);
  const [parts, setParts] = useState<HudLayoutParts>(query.parts);
  // As F1TelemetryHud does: the layout's corner groups read the parts while they render (`anchor`)
  setActiveHudParts(parts);
  const style = STYLES[query.style];
  const Style = style.component;
  const mfd = query.mfd ? (
    <div data-hud-avoid>
      <MultiPageMfd telemetry={fixture.t} tracker={tracker} trackLengthM={track.totalLengthM} compound={fixture.compound} defaultFolded={Boolean(style.options.mfdFolded)} />
    </div>
  ) : undefined;
  const leftExtra = query.extras && fixture.t.race ? <SplitGaps splits={fixture.t.race.splits} variant="panel" /> : null;

  return (
    <div className="fixed inset-0 overflow-hidden bg-lc-void">
      {/* eslint-disable-next-line @next/next/no-img-element -- a still game frame, drawn as is */}
      <img src={query.bg} alt="" className="absolute inset-0 h-full w-full object-cover" />
      {/* Left to right in every language, as the in-race HUD is */}
      <div ref={frameRef} dir="ltr" className="lc-safe-frame pointer-events-none fixed inset-0 z-20 mx-auto max-w-[calc(100vh*2.4)] select-none p-3 sm:p-4">
        <HudRunProvider t={fixture.t}>
          <Style
            t={fixture.t}
            deltaS={fixture.deltaS}
            map={map}
            compound={fixture.compound}
            revRange={revRangeOf(fixture.t)}
            scale={zoom * query.size}
            trackCode="RWA"
            mfd={mfd}
            lapInvalid={false}
            towerGaps="interval"
            mapMode={query.map}
            weather={query.scenario === "lights" ? null : fixture.weather}
            leftExtra={leftExtra}
            showDeltaBar
            showRadar
            cameraMode="chase"
            carId={query.scenario === "gt3" ? "amg-gt3" : "lc26"}
          />
        </HudRunProvider>
      </div>
      {query.edit ? <HudEditor parts={parts} hudRootRef={frameRef} onChange={setParts} onDone={() => {}} onCancel={() => setParts(query.parts)} /> : null}
      {query.chrome ? (
        <div className="fixed top-1/2 left-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 flex-wrap items-center gap-2 bg-lc-void/90 p-2 text-[12px] opacity-0 transition-opacity hover:opacity-100">
          {Object.keys(STYLES).map((id) => (
            <button key={id} type="button" onClick={() => onChange({ style: id })} className={`px-2 py-1 ${id === query.style ? "bg-lc-volt text-lc-void" : "text-lc-chalk"}`}>
              {id}
            </button>
          ))}
          {HUD_SCENARIOS.map((s) => (
            <button key={s} type="button" onClick={() => onChange({ scenario: s })} className={`px-2 py-1 ${s === query.scenario ? "bg-lc-chalk text-lc-void" : "text-lc-slate"}`}>
              {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Every layout's picker picture, large, to check the drawings */
function Previews() {
  return (
    <div className="fixed inset-0 grid grid-cols-4 content-start gap-4 overflow-y-auto bg-lc-carbon p-6">
      {HUD_LAYOUTS.map((l) => (
        <figure key={l.id} className="flex flex-col gap-1.5">
          <HudPreview preset={l.id} className="w-full" />
          <figcaption className="text-[13px] text-lc-fog">{l.label}</figcaption>
        </figure>
      ))}
    </div>
  );
}
