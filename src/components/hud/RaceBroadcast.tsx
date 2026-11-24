"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { useTranslations } from "use-intl/react";
import type { RaceStatus } from "@/types/f1";
import type { HudPreset } from "@/lib/settings/hud-layouts";
import { BroadcastCardQueue, CARD_MS, RaceEventDetector, type RaceEvent, type RaceEventKind } from "@/lib/broadcast/race-events";
import { BattleTracker, type BattleForecast, type BattleView } from "@/lib/broadcast/battle";
import { showDriver, type ShowContext } from "@/lib/show/show-context";
import { COMPOUNDS } from "@/components/ui/badges/compounds";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { PlayerTag } from "@/components/ui/badges";
import { DriverSilhouette, InfoBar } from "./pre-race/show-parts";
import { formatGap, formatLapTime } from "./hud-format";

/**
 * Where the broadcast sits: a side of the screen, how far down it starts (% of the screen's height), and for a layout
 * whose panels fill that edge, how far in past them (px at 100 %)
 */
interface BroadcastSlot {
  side: "left" | "right";
  top: number;
  inset?: number;
}

const EDGE = "clamp(14px, 2.2vw, 24px)";
const LEFT: BroadcastSlot = { side: "left", top: 38 };
const RIGHT: BroadcastSlot = { side: "right", top: 38 };
/** Past a 252–264 px column at the left edge (Telemetry's, Classic's), over the scenery */
const INSET_LEFT: BroadcastSlot = { side: "left", top: 40, inset: 272 };
/**
 * Each HUD layout's slot, clear of its panels (measured on screen in a race): a layout whose tower lists the whole
 * field down the left keeps it on the right, where a longer field cannot reach it
 */
const LAYOUT_SLOT: Readonly<Record<HudPreset, BroadcastSlot>> = {
  broadcast: RIGHT,
  dash: LEFT,
  telemetry: INSET_LEFT,
  classic: INSET_LEFT,
  minimal: RIGHT,
  touring: RIGHT,
  formula: LEFT,
  irdashies: RIGHT,
  racevision: RIGHT,
  h2h: RIGHT,
  retro: LEFT,
  blocks: RIGHT,
  "grand-prix": LEFT,
};

/**
 * The in-race broadcast of an offline AI race, a career round's included (never online, nor in a replay: the HUD
 * hides it there): the driver cards for what happens to any driver (`race-events.ts`), one at a time and never on top
 * of race control's messages, and the battle strip with its forecast (`battle.ts`). In a career round the drivers are
 * named by the round's context (first and last names, numbers); elsewhere by the names the standings carry.
 *
 * It reads each new race standing once (the HUD re-renders more often than the worker reports): mounted for the whole
 * race, shown only while `shown` (the live HUD), so a pause does not lose what it has seen.
 */
export const RaceBroadcast: React.FC<{
  race: RaceStatus;
  context: ShowContext | null;
  shown: boolean;
  /** The HUD's size (× 1) */
  scale: number;
  /** The HUD layout drawn */
  layout: HudPreset;
}> = ({ race, context, shown, scale, layout }) => {
  const slot = LAYOUT_SLOT[layout] ?? LEFT;
  const detectorRef = useRef<RaceEventDetector | null>(null);
  const queueRef = useRef<BroadcastCardQueue | null>(null);
  const battlesRef = useRef<BattleTracker | null>(null);
  detectorRef.current ??= new RaceEventDetector();
  queueRef.current ??= new BroadcastCardQueue();
  battlesRef.current ??= new BattleTracker();
  const detector = detectorRef.current;
  const queue = queueRef.current;
  const battles = battlesRef.current;
  const battleRef = useRef<BattleView | null>(null);

  useEffect(() => {
    const now = performance.now();
    queue.push(detector.update(race, now), now);
    battleRef.current = battles.update(race, now);
  }, [race, detector, queue, battles]);

  // Hidden (paused, the HUD cleared): nothing is used up meanwhile
  if (!shown) return null;
  const now = performance.now();
  // Race control speaking: no new card until it is done (the one up plays out)
  const card = queue.current(now, Boolean(race.raceControl?.length));
  const battle = battleRef.current;
  if (!card && !battle) return null;
  return (
    <div
      data-race-broadcast={slot.side}
      className={`pointer-events-none absolute flex flex-col gap-2.5 ${slot.side === "left" ? "items-start" : "items-end"}`}
      style={{
        top: `${slot.top}%`,
        [slot.side]: slot.inset ? `calc(${EDGE} + ${Math.round(slot.inset * scale)}px)` : EDGE,
        transformOrigin: `${slot.side} top`,
        transform: scale !== 1 ? `scale(${scale})` : undefined,
      }}
    >
      {battle ? <BattleStrip key={`battle-${battle.id}`} battle={battle} context={context} /> : null}
      {card ? (
        <EventCard
          key={`card-${card.id}`}
          event={card.event}
          context={context}
          leaving={now - card.startMs > CARD_MS - CARD_OUT_MS}
        />
      ) : null}
    </div>
  );
};

/** The card's way out, at the end of its time (ms) */
const CARD_OUT_MS = 360;

/** The event bar's colours, by event */
const BAR: Record<RaceEventKind, string> = {
  winner: "bg-lc-podium-gold text-lc-void",
  newLeader: "bg-lc-volt text-lc-void",
  fastestLap: "bg-lc-best text-lc-chalk",
  pitStop: "bg-lc-chalk text-lc-void",
  retired: "bg-lc-loss text-lc-chalk",
};

function useBroadcastText() {
  const tx = useTranslations("hud.raceBroadcast");
  return useMemo(
    () => ({
      region: tx("region"),
      event: {
        winner: tx("event.winner"),
        newLeader: tx("event.newLeader"),
        fastestLap: tx("event.fastestLap"),
        pitStop: tx("event.pitStop"),
        retired: tx("event.retired"),
      } satisfies Record<RaceEventKind, string>,
      lap: (lap: number) => tx("lap", { lap }),
      stationary: (seconds: number) => tx("stationary", { seconds: seconds.toFixed(1) }),
      battleFor: (position: number) => tx("battleFor", { position }),
      forecast: (f: BattleForecast): string => {
        if (f.kind === "attacking") return tx("attacking");
        if (f.kind === "pullingAway") return tx("pullingAway");
        if (f.kind === "stable") return tx("stable");
        const rate = f.rateS.toFixed(2);
        return f.catchLaps !== null ? tx("closingCatch", { rate, laps: f.catchLaps }) : tx("closing", { rate });
      },
    }),
    [tx]
  );
}

/** A driver's names as the card shows them: the first name over the last (a career's), or the race's one name */
function namesOf(context: ShowContext | null, code: string, color: string, isPlayer: boolean) {
  const d = showDriver(context, code, color, isPlayer);
  // A last name that is a number (a stand-in driver "Driver 7") reads as one name
  const numericLast = Boolean(d.first) && /^\d+$/.test(d.last);
  return {
    first: numericLast ? "" : d.first,
    last: numericLast ? `${d.first} ${d.last}` : d.last,
    number: d.number,
    color: d.color || color,
  };
}

/**
 * One driver card, TV style: the panel opens in the driver's colour, their black silhouette rises out of it (the head
 * past the card's top), a shine sweeps it, the name and number slide in, and the event bar opens under them
 */
const EventCard: React.FC<{ event: RaceEvent; context: ShowContext | null; leaving: boolean }> = ({ event, context, leaving }) => {
  const text = useBroadcastText();
  const n = namesOf(context, event.code, event.color, event.isPlayer);
  const detail =
    event.kind === "newLeader" && event.lap
      ? text.lap(event.lap)
      : event.kind === "fastestLap" && event.lapMs
        ? formatLapTime(event.lapMs)
        : event.kind === "pitStop" && event.stationaryS !== undefined
          ? text.stationary(event.stationaryS)
          : null;
  return (
    <article
      role="status"
      aria-label={text.region}
      data-event={event.kind}
      className={`lc-cast-card relative w-[min(380px,calc(100vw-32px))] pt-6 ${leaving ? "lc-cast-out" : ""}`}
    >
      <div className="relative flex h-[96px] shadow-lc-sheet">
        {/* The driver's colour bay: halftone, a shine across it, and the silhouette standing in it */}
        <div
          className="relative w-[104px] shrink-0 overflow-hidden"
          style={{ backgroundImage: `linear-gradient(160deg, ${n.color}, color-mix(in srgb, ${n.color} 30%, var(--color-lc-void)))` }}
        >
          <div
            aria-hidden
            className="absolute inset-0 opacity-45"
            style={{ backgroundImage: "radial-gradient(circle, var(--color-lc-void) 1.2px, transparent 1.7px)", backgroundSize: "6px 6px" }}
          />
          <div aria-hidden className="lc-show-stripes absolute inset-0 opacity-70" />
        </div>
        {/* The plate: number, first and last name */}
        <div
          className="relative flex min-w-0 flex-1 items-center gap-3 overflow-hidden border-t-[3px] bg-lc-void/94 ps-3.5 pe-3"
          style={{ borderTopColor: event.isPlayer ? "var(--color-lc-volt)" : n.color }}
        >
          {n.number !== null ? (
            <span className="lc-cast-slide lc-disp shrink-0 text-[34px] leading-none text-lc-chalk" style={{ animationDelay: "420ms" }}>
              {n.number}
            </span>
          ) : null}
          <div className="lc-cast-slide flex min-w-0 flex-col" style={{ animationDelay: "500ms" }}>
            {n.first ? <span className="truncate text-[13px] font-semibold leading-tight text-lc-fog">{n.first}</span> : null}
            <span className={`lc-disp truncate text-[26px] leading-[1.02] ${event.isPlayer ? "text-lc-volt" : "text-lc-chalk"}`}>{n.last}</span>
          </div>
          {event.isPlayer ? <PlayerTag size="sm" className="lc-cast-slide ms-auto shrink-0" /> : null}
        </div>
        {/* The silhouette rises over the bay, its head past the card's top edge */}
        <div aria-hidden className="pointer-events-none absolute bottom-0 left-0 w-[104px]">
          <DriverSilhouette color={n.color} className="lc-cast-rise mx-auto block h-[112px] w-auto" />
        </div>
        <div aria-hidden className="lc-cast-shine pointer-events-none absolute inset-y-0 left-0 w-[104px] overflow-hidden" />
        {/* The panel opens in the driver's colour, then gives way to the card */}
        <div aria-hidden className="lc-cast-curtain pointer-events-none absolute inset-0" style={{ backgroundColor: n.color }} />
      </div>
      {/* The event bar */}
      <div className={`lc-cast-bar flex h-9 items-center gap-3 px-3.5 ${BAR[event.kind]}`}>
        <span className="lc-disp text-[17px] leading-none">{text.event[event.kind]}</span>
        {detail ? <span className="lc-mono text-[15px] font-bold leading-none">{detail}</span> : null}
        {event.kind === "pitStop" && event.compound ? (
          <span className="ms-auto inline-flex items-center gap-1.5">
            <CompoundGlyph compound={event.compound} size={18} />
            <span className="lc-mono text-[13px] font-bold leading-none">{COMPOUNDS[event.compound].name}</span>
          </span>
        ) : null}
      </div>
    </article>
  );
};

/** The battle strip: the place fought for, the two cars and the gap, and the forecast once there is one */
const BattleStrip: React.FC<{ battle: BattleView; context: ShowContext | null }> = ({ battle, context }) => {
  const text = useBroadcastText();
  const name = (e: BattleView["ahead"]) => {
    const n = namesOf(context, e.driverCode, e.teamColorHex, e.isPlayer);
    return { text: context?.drivers[e.driverCode] ? n.last : (e.name ?? e.driverCode), dot: n.color };
  };
  return (
    <InfoBar
      leadVolt
      className="max-w-[min(640px,calc(100vw-32px))]"
      items={[
        text.battleFor(battle.position),
        { ...name(battle.ahead), tone: battle.ahead.isPlayer ? "volt" : "chalk" },
        { text: `+${formatGap(battle.gapS, true)}`, tone: "fog" },
        { ...name(battle.behind), tone: battle.behind.isPlayer ? "volt" : "chalk" },
        battle.forecast ? { text: text.forecast(battle.forecast), tone: "info" } : null,
      ]}
    />
  );
};
