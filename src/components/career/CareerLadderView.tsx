"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFormatter, useTranslations } from "use-intl/react";
import {
  seriesAvailable,
  seriesById,
  seriesContent,
  seriesOf,
  type CareerContent,
  type CareerSeries,
} from "@/lib/career/ladder";
import {
  seasonStandings,
  type CareerRun,
  type SeasonRecord,
} from "@/lib/career/career-state";
import { Button, Card, IconButton, MediaTile, cx } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons";
import { uiZoomOf } from "@/components/ui/styles";
import { SeriesCarThumb, carTitle, seriesName } from "./career-ui";
import { SeasonArchiveModal, SeriesDetailContent, SeriesDetailModal } from "./CareerModals";

interface ConnectorEdge {
  key: string;
  d: string;
  endX: number;
  endY: number;
  state: "taken" | "open" | "locked";
}

function useIsLargeScreen(): boolean {
  const [large, setLarge] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setLarge(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return large;
}

/** Orthogonal path with subtle rounded corners from (x1, y1) to (x2, y2). */
function elbowPath(x1: number, y1: number, x2: number, y2: number, midX: number): string {
  const dy = y2 - y1;
  if (Math.abs(dy) < 2) {
    return `M ${x1} ${y1} H ${x2}`;
  }
  const dirX = x2 >= x1 ? 1 : -1;
  const dirY = dy >= 0 ? 1 : -1;
  const r = Math.min(8, Math.abs(dy) / 2, Math.abs(midX - x1), Math.abs(x2 - midX));
  return [
    `M ${x1} ${y1}`,
    `H ${midX - dirX * r}`,
    `Q ${midX} ${y1} ${midX} ${y1 + dirY * r}`,
    `V ${y2 - dirY * r}`,
    `Q ${midX} ${y2} ${midX + dirX * r} ${y2}`,
    `H ${x2}`,
  ].join(" ");
}

/** Routed path below intermediate columns when a series jumps more than one tier (e.g. Prototype Cup to Endurance). */
function skipTierPath(x1: number, y1: number, x2: number, y2: number, railY: number): string {
  const dirX = x2 >= x1 ? 1 : -1;
  const xTurn1 = x1 + dirX * 16;
  const xTurn2 = x2 - dirX * 16;
  const r = 8;
  return [
    `M ${x1} ${y1}`,
    `H ${xTurn1 - dirX * r}`,
    `Q ${xTurn1} ${y1} ${xTurn1} ${y1 + r}`,
    `V ${railY - r}`,
    `Q ${xTurn1} ${railY} ${xTurn1 + dirX * r} ${railY}`,
    `H ${xTurn2 - dirX * r}`,
    `Q ${xTurn2} ${railY} ${xTurn2} ${railY - r}`,
    `V ${y2 + r}`,
    `Q ${xTurn2} ${y2} ${xTurn2 + dirX * r} ${y2}`,
    `H ${x2}`,
  ].join(" ");
}

/**
 * Connected Career Path graph with orthogonal SVG connectors from `series.next`, completed score stamps with actual
 * car raced, non-truncating tier columns, and a docked right-hand contextual drawer on large screens.
 */
export const CareerLadderView: React.FC<{
  run: CareerRun;
  content: CareerContent;
  playerName: string;
  playerCode: string;
  onChooseSeries: (seriesId: string) => void;
}> = ({ run, content, playerName, playerCode, onChooseSeries }) => {
  const tx = useTranslations("menu.career");
  const format = useFormatter();
  const isLarge = useIsLargeScreen();
  const [inspecting, setInspecting] = useState<CareerSeries | null>(null);
  const [archiveView, setArchiveView] = useState<{ record: SeasonRecord; seasonNumber: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState<ConnectorEdge[]>([]);
  const [graphSize, setGraphSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const allSeries = useMemo(() => seriesOf(run.discipline), [run.discipline]);

  const columns = useMemo(() => {
    const byTier = new Map<number, CareerSeries[]>();
    for (const s of allSeries) {
      byTier.set(s.tier, [...(byTier.get(s.tier) ?? []), s]);
    }
    return [...byTier.entries()].sort(([a], [b]) => a - b);
  }, [allSeries]);

  // Best promoted record per series (for stamps and actual car driven)
  const promotedRecord = useMemo(() => {
    const map = new Map<string, SeasonRecord>();
    for (const h of run.history) {
      if (!h.promoted) continue;
      const prev = map.get(h.seriesId);
      if (!prev || h.position < prev.position || h.endedAt >= prev.endedAt) {
        map.set(h.seriesId, h);
      }
    }
    return map;
  }, [run.history]);

  // Live current-season readout for the current node badge
  const currentLiveBadge = useMemo(() => {
    if (!run.season) return null;
    if (!run.season.started) return tx("preseasonBadge");
    const raced = run.season.rounds.filter((r) => r !== null).length;
    const total = run.season.settings.circuits.length;
    if (raced === 0) return tx("roundOf", { round: 1, total });
    const rows = seasonStandings(run.season);
    const place = rows.findIndex((r) => r.who === "me") + 1;
    const pts = rows[place - 1]?.points ?? 0;
    return `P${place} · ${tx("historyPoints", { points: format.number(pts) })}`;
  }, [run.season, tx, format]);

  // Taken & open transitions along `series.next`
  const { takenEdges, openEdges } = useMemo(() => {
    const taken = new Set<string>();
    const open = new Set<string>();
    const promotedSeq = run.history.filter((h) => h.promoted).map((h) => h.seriesId);
    const fullPath = run.season ? [...promotedSeq, run.season.seriesId] : promotedSeq;
    for (let i = 0; i < fullPath.length - 1; i++) {
      const from = seriesById(fullPath[i]);
      const toId = fullPath[i + 1];
      if (from && from.next.includes(toId)) {
        taken.add(`${from.id}->${toId}`);
      }
    }
    // Open choices from the last promoted series (both between seasons and during pre-season switching)
    const lastPromotedId = promotedSeq[promotedSeq.length - 1];
    if (lastPromotedId && (!run.season || !run.season.started)) {
      const lastSeries = seriesById(lastPromotedId);
      for (const choiceId of run.choices) {
        if (lastSeries?.next.includes(choiceId)) {
          open.add(`${lastPromotedId}->${choiceId}`);
        }
      }
    }
    return { takenEdges: taken, openEdges: open };
  }, [run.history, run.season, run.choices]);

  const measureEdges = useCallback(() => {
    const graphEl = graphRef.current;
    if (!graphEl) return;
    const zoom = uiZoomOf(graphEl);
    const base = graphEl.getBoundingClientRect();
    const boxes = new Map<string, { left: number; right: number; top: number; bottom: number; cy: number }>();

    let maxBottom = 0;
    graphEl.querySelectorAll<HTMLElement>("[data-series-id]").forEach((el) => {
      const id = el.dataset.seriesId;
      if (!id) return;
      const r = el.getBoundingClientRect();
      const left = (r.left - base.left) / zoom;
      const right = (r.right - base.left) / zoom;
      const top = (r.top - base.top) / zoom;
      const bottom = (r.bottom - base.top) / zoom;
      boxes.set(id, { left, right, top, bottom, cy: (top + bottom) / 2 });
      if (bottom > maxBottom) maxBottom = bottom;
    });

    const computed: ConnectorEdge[] = [];
    for (const from of allSeries) {
      const a = boxes.get(from.id);
      if (!a) continue;
      from.next.forEach((toId) => {
        const to = seriesById(toId);
        const b = boxes.get(toId);
        if (!to || !b) return;
        const ltr = b.left >= a.right - 2;
        const x1 = ltr ? a.right : a.left;
        const x2 = ltr ? b.left : b.right;
        const y1 = a.cy;
        const y2 = b.cy;
        const key = `${from.id}->${toId}`;
        const state: ConnectorEdge["state"] = takenEdges.has(key)
          ? "taken"
          : openEdges.has(key)
            ? "open"
            : "locked";
        const d =
          to.tier > from.tier + 1
            ? skipTierPath(x1, y1, x2, y2, maxBottom + 16)
            : elbowPath(x1, y1, x2, y2, (x1 + x2) / 2);
        computed.push({ key, d, endX: x2, endY: y2, state });
      });
    }

    // Draw locked first, open second, taken on top
    const order = { locked: 0, open: 1, taken: 2 };
    computed.sort((x, y) => order[x.state] - order[y.state]);
    setEdges(computed);
    setGraphSize({ w: graphEl.scrollWidth, h: Math.max(graphEl.scrollHeight, maxBottom + 28) });
  }, [allSeries, takenEdges, openEdges]);

  useLayoutEffect(() => {
    measureEdges();
    const graphEl = graphRef.current;
    if (!graphEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measureEdges());
    ro.observe(graphEl);
    return () => ro.disconnect();
  }, [measureEdges, inspecting, isLarge]);

  // Horizontally bring the active or open series into view on initial mount
  useEffect(() => {
    const scroller = scrollRef.current;
    const graphEl = graphRef.current;
    if (!scroller || !graphEl) return;
    const focusId = run.season?.seriesId ?? run.choices[0];
    if (!focusId) return;
    const node = graphEl.querySelector<HTMLElement>(`[data-series-id="${focusId}"]`);
    if (!node) return;
    const targetLeft = Math.max(0, node.offsetLeft - scroller.clientWidth + node.offsetWidth + 48);
    scroller.scrollLeft = targetLeft;
  }, [run.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes the docked drawer on desktop before CareerScreen handles Back
  useEffect(() => {
    if (!inspecting || !isLarge || archiveView) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setInspecting(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inspecting, isLarge, archiveView]);

  const scrollLadder = (dir: -1 | 1) => {
    const el = scrollRef.current;
    // Right to left (Arabic) the ladder runs the other way: "next" scrolls towards the left
    const rtl = el ? getComputedStyle(el).direction === "rtl" : false;
    el?.scrollBy({ left: dir * 300 * (rtl ? -1 : 1), behavior: "smooth" });
  };

  const canChooseInspecting = Boolean(
    inspecting &&
      (!run.season || !run.season.started) &&
      run.choices.includes(inspecting.id) &&
      run.season?.seriesId !== inspecting.id,
  );
  const isSwitchInspecting = Boolean(canChooseInspecting && run.season && !run.season.started);

  return (
    <div className="flex min-w-0 items-start gap-4">
      <Card
        title={tx("ladderTitle", { discipline: tx(`discipline.${run.discipline}`) })}
        action={
          columns.length > 3 ? (
            <div className="flex items-center gap-1.5">
              <IconButton
                size="sm"
                variant="secondary"
                icon={<Icon name="previous" />}
                aria-label={tx("ladderScrollPrev")}
                onClick={() => scrollLadder(-1)}
              />
              <IconButton
                size="sm"
                variant="secondary"
                icon={<Icon name="next" />}
                aria-label={tx("ladderScrollNext")}
                onClick={() => scrollLadder(1)}
              />
            </div>
          ) : undefined
        }
        className="min-w-0 flex-1"
        bodyClassName="overflow-x-auto pb-2"
      >
        <div ref={scrollRef} className="overflow-x-auto pb-2">
          <div ref={graphRef} className="relative flex min-w-max items-start gap-10 pt-1 pb-7">
            {/* Orthogonal SVG connector layer behind tier cards */}
            {edges.length > 0 ? (
              <svg
                aria-hidden
                focusable="false"
                width={graphSize.w}
                height={graphSize.h}
                className="pointer-events-none absolute top-0 start-0 z-0 overflow-visible"
              >
                {edges.map((edge) => (
                  <g key={edge.key}>
                    <path
                      d={edge.d}
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={edge.state === "taken" ? 2.5 : edge.state === "open" ? 2 : 1.5}
                      className={
                        edge.state === "taken"
                          ? "stroke-lc-chalk"
                          : edge.state === "open"
                            ? "stroke-lc-info"
                            : "stroke-lc-line opacity-80"
                      }
                    />
                    {edge.state !== "locked" ? (
                      <circle
                        cx={edge.endX}
                        cy={edge.endY}
                        r={3}
                        className={edge.state === "taken" ? "fill-lc-chalk" : "fill-lc-info"}
                      />
                    ) : null}
                  </g>
                ))}
              </svg>
            ) : null}

            {columns.map(([tier, list]) => (
              <div key={tier} className="relative z-10 flex w-[248px] shrink-0 flex-col gap-3">
                <div className="flex items-center justify-between border-b border-lc-line pb-2">
                  <h4 className="lc-h3 text-[15px] text-lc-fog">{tx("tierHeading", { tier: tier + 1 })}</h4>
                </div>
                <div className="flex flex-col gap-3">
                  {list.map((series) => {
                    const doneRec = promotedRecord.get(series.id);
                    const isCurrent = run.season?.seriesId === series.id;
                    const isOpen = (!run.season || !run.season.started) && run.choices.includes(series.id) && !isCurrent;
                    const available = seriesAvailable(series, content);
                    const isLocked = !isCurrent && !isOpen && !doneRec;
                    const isSelected = inspecting?.id === series.id;

                    // Car actually driven for current or completed nodes
                    const sc = seriesContent(series, content);
                    const carId = isCurrent
                      ? run.season!.settings.car
                      : doneRec
                        ? doneRec.car
                        : (sc.cars[0] ?? series.cars[0]);

                    let overlay: React.ReactNode;
                    if (isCurrent) {
                      overlay = (
                        <Badge tone="info" variant="solid" size="sm" dot="live">
                          {tx("ladderCurrent")}
                        </Badge>
                      );
                    } else if (doneRec) {
                      overlay = (
                        <Badge tone="good" variant="solid" size="sm" icon="success">
                          {tx("ladderStamp", { place: doneRec.position, score: format.number(doneRec.score) })}
                        </Badge>
                      );
                    } else if (isOpen) {
                      overlay = (
                        <Badge tone="info" variant="solid" size="sm">
                          {tx("ladderOpen")}
                        </Badge>
                      );
                    } else {
                      overlay = (
                        <Badge tone="neutral" variant="solid" size="sm" icon="locked">
                          {available ? tx("ladderLocked") : tx("ladderUnavailable")}
                        </Badge>
                      );
                    }

                    const metaParts = [
                      series.region ? tx(`region.${series.region}`) : null,
                      carTitle(carId),
                    ].filter(Boolean);

                    return (
                      <div key={series.id} data-series-id={series.id} className="rounded-lc-tile bg-lc-carbon">
                        <MediaTile
                          chosen={isCurrent || isSelected}
                          navDefault={isCurrent || isOpen}
                          className={isLocked ? "opacity-65" : undefined}
                          media={<SeriesCarThumb carId={carId} />}
                          title={tx(`series.${series.family}`)}
                          meta={metaParts.join(" · ")}
                          overlay={overlay}
                          badges={
                            isCurrent && currentLiveBadge ? (
                              <Badge tone="info" size="sm">
                                {currentLiveBadge}
                              </Badge>
                            ) : null
                          }
                          onSelect={() => setInspecting(series)}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* Docked right-hand contextual drawer on large screens */}
      {inspecting && isLarge ? (
        <aside
          aria-label={seriesName(inspecting, tx)}
          className="lc-glass lc-panel-in flex w-[352px] shrink-0 flex-col overflow-hidden rounded-lc-card xl:w-[384px]"
        >
          <div className="flex items-start justify-between gap-2 border-b border-lc-line px-4 py-3.5">
            <div className="flex min-w-0 flex-col gap-1.5">
              <h3 className="lc-h3 m-0 text-[20px] text-lc-chalk">{seriesName(inspecting, tx)}</h3>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="neutral" size="sm">
                  {tx(`discipline.${inspecting.discipline}`)}
                </Badge>
                <Badge tone="info" size="sm">
                  {tx("tierHeading", { tier: inspecting.tier + 1 })}
                </Badge>
              </div>
            </div>
            <IconButton
              size="sm"
              variant="ghost"
              icon={<Icon name="close" />}
              aria-label={tx("close")}
              onClick={() => setInspecting(null)}
            />
          </div>

          <div className="max-h-[calc(100dvh-16rem)] overflow-y-auto overscroll-contain p-4">
            <SeriesDetailContent
              series={inspecting}
              content={content}
              run={run}
              compact
              onOpenRecord={(record, seasonNumber) => setArchiveView({ record, seasonNumber })}
            />
          </div>

          {canChooseInspecting ? (
            <div className="flex items-center justify-end gap-2 border-t border-lc-line px-4 py-3">
              <Button
                variant="primary"
                size="md"
                block
                icon={<Icon name="race" />}
                onClick={() => {
                  onChooseSeries(inspecting.id);
                  setInspecting(null);
                }}
              >
                {isSwitchInspecting ? tx("ladderSwitchSeries") : tx("raceThisSeries")}
              </Button>
            </div>
          ) : null}
        </aside>
      ) : null}

      {/* Phone / narrow screen modal fallback */}
      {!isLarge ? (
        <SeriesDetailModal
          series={inspecting}
          content={content}
          run={run}
          canChoose={canChooseInspecting}
          isSwitch={isSwitchInspecting}
          onChoose={onChooseSeries}
          onOpenRecord={(record, seasonNumber) => {
            setInspecting(null);
            setArchiveView({ record, seasonNumber });
          }}
          onClose={() => setInspecting(null)}
        />
      ) : null}

      {archiveView ? (
        <SeasonArchiveModal
          record={archiveView.record}
          seasonNumber={archiveView.seasonNumber}
          run={run}
          playerName={playerName}
          playerCode={playerCode}
          onClose={() => setArchiveView(null)}
        />
      ) : null}
    </div>
  );
};
