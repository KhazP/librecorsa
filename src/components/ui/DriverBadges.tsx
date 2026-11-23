"use client";

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t, useI18nState } from "@/i18n/runtime";
import type { MessageKey } from "@/i18n/types";
import {
  BADGE_TYPES,
  MIN_RECORD_DRIVERS,
  badgeDetail,
  badgeLabel,
  badgeName,
  filterBadgesForContext,
  groupBoardsByClass,
  groupBoardsByVehicle,
  sortBadges,
  type BadgeContext,
  type BadgeType,
  type DriverBadge,
  type RecordBoard,
} from "@/lib/net/awards";
import { VEHICLE_CLASS_META, vehicleClassOf, vehicleDisplayName } from "@/lib/cars/vehicle-class";
import { isVehicleModelId, type VehicleModelId } from "@/types/f1";
import { Badge, type BadgeToneProp, type BadgeVariant } from "./Badge";
import { IconButton } from "./Button";
import { Icon } from "./icons/Icon";
import type { IconName } from "./icons/registry";
import { cx, uiZoomOf } from "./styles";

/*
 * The words come from the language runtime (`t`, re-rendered by useI18nState) rather than the provider, so the badges
 * also draw on their own (scripts/verify-awards.ts renders them bare).
 */

interface BadgeStyle {
  icon: IconName;
  tone: BadgeToneProp;
  variant: BadgeVariant;
}

const STYLE: Record<BadgeType, BadgeStyle> = {
  weekly_gold: { icon: "challenge", tone: { color: "amber" }, variant: "soft" },
  weekly_silver: { icon: "medal", tone: { color: "chalk" }, variant: "soft" },
  weekly_bronze: { icon: "medal", tone: { color: "amber" }, variant: "outline" },
  track_record: { icon: "lapTimes", tone: "best", variant: "soft" },
  og: { icon: "favouriteOn", tone: { color: "cyan" }, variant: "soft" },
  bulb: { icon: "idea", tone: { color: "lemon" }, variant: "soft" },
  creator: { icon: "creator", tone: { color: "pink" }, variant: "soft" },
};

/** Short tag for compact board rows so every badge is told apart without relying on colour alone (none for the bulb) */
function shortOf(type: BadgeType): string {
  switch (type) {
    case "weekly_gold":
      return t("board.driverBadges.short.gold");
    case "weekly_silver":
      return t("board.driverBadges.short.silver");
    case "weekly_bronze":
      return t("board.driverBadges.short.bronze");
    case "track_record":
      return t("board.driverBadges.flCompact", { count: 1 });
    case "og":
      return t("board.driverBadges.short.og");
    case "bulb":
    case "creator":
      return "";
  }
}

/** A count shown only past one ("×2"): the plural messages' `=1` arm drops it */
const timesOf = (count: number) => Math.max(1, count);

/** Cap inline class-tagged FL pills on multi-class drivers so phone rows never wrap into clutter */
const MAX_INLINE_FL_CLASSES = 2;

const humanizeTrack = (id: string): string => id.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Pure m:ss.mmm formatter (mirrors hud-format.ts without pulling simulator/HUD dependencies into UI badges) */
function formatLapTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-:--.---";
  const whole = Math.floor(ms);
  const totalSec = Math.floor(whole / 1000);
  const totalMin = Math.floor(totalSec / 60);
  const hours = Math.floor(totalMin / 60);
  const rest = `${(totalSec % 60).toString().padStart(2, "0")}.${(whole % 1000).toString().padStart(3, "0")}`;
  return hours > 0 ? `${hours}:${(totalMin % 60).toString().padStart(2, "0")}:${rest}` : `${totalMin}:${rest}`;
}

export interface DriverBadgesProps {
  badges: readonly DriverBadge[];
  /** Compact inline pills for timing rows; omit for full badge names */
  compact?: boolean;
  /** Board or lobby scope: narrows Fastest Lap pills to that car or car class */
  context?: BadgeContext;
  /** Driver display name for the Fastest Lap popover header */
  driverName?: string;
  /** Resolves a track id to a human-readable circuit name inside the popover */
  circuitName?: (trackId: string) => string;
  /** Jumps straight to a record's board when tapped inside the Fastest Lap popover */
  onOpenBoard?: (trackId: string, vehicle: VehicleModelId) => void;
  /** Set false for static previews (e.g. Admin badge list) */
  interactive?: boolean;
  className?: string;
}

function tooltipOf(b: DriverBadge): string {
  const label = badgeLabel(b);
  if (b.type === "bulb") return label;
  const detail = badgeDetail(b);
  return detail ? t("board.driverBadges.tooltip", { label, detail }) : label;
}

interface PopoverPlace {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
  zoomed: boolean;
}

const POP_GAP = 8;
const POP_MARGIN = 12;

interface RecordPopoverProps {
  anchor: HTMLElement | null;
  driverName?: string;
  scopedBoards: readonly RecordBoard[];
  allBoards: readonly RecordBoard[];
  manualCount: number;
  note?: string;
  context?: BadgeContext;
  circuitName?: (trackId: string) => string;
  onOpenBoard?: (trackId: string, vehicle: VehicleModelId) => void;
  onClose: (refocus?: boolean) => void;
}

const RecordPopover: React.FC<RecordPopoverProps> = ({
  anchor,
  driverName,
  scopedBoards,
  allBoards,
  manualCount,
  note,
  context,
  circuitName,
  onOpenBoard,
  onClose,
}) => {
  useI18nState();
  const popRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const hasOtherRecords = Boolean(context && context.scope !== "all" && allBoards.length > scopedBoards.length);
  const [showAll, setShowAll] = useState(false);
  const [place, setPlace] = useState<PopoverPlace | null>(null);

  const shownBoards = showAll || !context || context.scope === "all" ? allBoards : scopedBoards;
  const groups = groupBoardsByVehicle(shownBoards);
  const shownCount = shownBoards.length + (showAll || !context || context.scope === "all" ? manualCount : 0);

  const scopeLabel =
    context?.scope === "vehicle"
      ? vehicleDisplayName(context.vehicle)
      : context?.scope === "class"
        ? VEHICLE_CLASS_META[context.classId].label
        : null;

  const measure = useCallback(() => {
    if (!anchor) return;
    const zoom = uiZoomOf(anchor);
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const desiredW = Math.min(352, vw - POP_MARGIN * 2);
    const below = vh - r.bottom - POP_MARGIN;
    const above = r.top - POP_MARGIN;
    const up = below < 240 && above > below;
    const clampedLeft = Math.max(POP_MARGIN, Math.min(r.left, vw - desiredW - POP_MARGIN));
    setPlace({
      left: clampedLeft / zoom,
      top: up ? undefined : (r.bottom + POP_GAP) / zoom,
      bottom: up ? (vh - r.top + POP_GAP) / zoom : undefined,
      width: desiredW / zoom,
      maxHeight: Math.min(420, Math.max(180, (up ? above : below) - POP_GAP)) / zoom,
      zoomed: zoom !== 1,
    });
  }, [anchor]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose(true);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchor, measure, onClose]);

  if (!place || typeof document === "undefined") return null;

  const formatCircuit = (id: string) => (circuitName ? circuitName(id) : humanizeTrack(id));

  return createPortal(
    <div
      ref={popRef}
      role="dialog"
      aria-labelledby={titleId}
      className={cx(
        "fixed z-(--z-lc-notice) flex flex-col gap-2.5 overflow-hidden rounded-lc-tile border border-white/10 bg-lc-carbon/98 p-3.5 text-lc-chalk shadow-lc-pop backdrop-blur-md",
        place.zoomed ? "lc-ui-zoom" : undefined,
      )}
      style={{
        left: place.left,
        top: place.top,
        bottom: place.bottom,
        width: place.width,
        maxHeight: place.maxHeight,
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <h4 id={titleId} className="m-0 truncate text-[14px] font-bold text-lc-chalk">
              {driverName ? t("board.driverBadges.popoverTitleNamed", { driver: driverName }) : t("board.driverBadges.popoverTitle")}
            </h4>
            <Badge size="sm" tone="best" variant="soft" icon="lapTimes" className="px-1.5">
              ×{shownCount}
            </Badge>
          </div>
          <p className="m-0 text-[11px] text-lc-slate">
            {t("board.driverBadges.contested", { min: String(MIN_RECORD_DRIVERS) })}
          </p>
        </div>
        <IconButton
          size="sm"
          variant="ghost"
          icon={<Icon name="close" />}
          aria-label={t("board.driverBadges.close")}
          onClick={() => onClose(true)}
          className="-mt-1 -me-1 shrink-0"
        />
      </div>

      {/* Scope toggle when opened from a car/class board and the driver holds records elsewhere too */}
      {hasOtherRecords && scopeLabel ? (
        <div className="flex items-center gap-1 rounded-lc-nub border border-white/8 bg-lc-void/60 p-0.5 text-[11px]">
          <button
            type="button"
            onClick={() => setShowAll(false)}
            className={cx(
              "flex-1 cursor-pointer rounded-lc-nub px-2 py-1 font-semibold transition-colors",
              !showAll ? "bg-white/12 text-lc-chalk" : "text-lc-fog hover:text-lc-chalk",
            )}
          >
            {t("board.driverBadges.scopeCount", { scope: scopeLabel, count: String(scopedBoards.length) })}
          </button>
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className={cx(
              "flex-1 cursor-pointer rounded-lc-nub px-2 py-1 font-semibold transition-colors",
              showAll ? "bg-white/12 text-lc-chalk" : "text-lc-fog hover:text-lc-chalk",
            )}
          >
            {t("board.driverBadges.allClasses", { count: String(allBoards.length + manualCount) })}
          </button>
        </div>
      ) : null}

      {/* Scrollable per-vehicle record list */}
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain pe-0.5">
        {groups.map((g) => {
          const classMeta = g.classId ? VEHICLE_CLASS_META[g.classId] : null;
          return (
            <div key={g.vehicle} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  {classMeta ? (
                    <Badge size="hud" tone={{ color: classMeta.color }} variant="soft">
                      {classMeta.short}
                    </Badge>
                  ) : null}
                  <span className="truncate text-[12px] font-bold text-lc-chalk">{vehicleDisplayName(g.vehicle)}</span>
                </span>
                <span className="lc-mono shrink-0 text-[11px] font-bold text-lc-slate">×{g.count}</span>
              </div>
              <ul className="m-0 flex list-none flex-col divide-y divide-white/5 overflow-hidden rounded-lc-row border border-white/7 bg-lc-void/50 p-0">
                {g.boards.map((b) => {
                  const trackLabel = formatCircuit(b.trackId);
                  const canJump = Boolean(onOpenBoard && isVehicleModelId(b.vehicle));
                  const rowContent = (
                    <>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-lc-chalk" title={trackLabel}>
                        {trackLabel}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {b.lapTimeMs !== undefined ? (
                          <span className="lc-mono text-[12px] font-bold text-lc-best-ink">{formatLapTime(b.lapTimeMs)}</span>
                        ) : null}
                        {b.drivers !== undefined ? (
                          <span
                            className="lc-mono text-[11px] text-lc-slate"
                            title={t("board.driverBadges.boardDrivers", { count: b.drivers, drivers: String(b.drivers) })}
                          >
                            {t("board.driverBadges.driversShort", { drivers: String(b.drivers) })}
                          </span>
                        ) : null}
                        {canJump ? (
                          <Icon name="next" size="xs" className="text-lc-slate transition-transform group-hover:translate-x-0.5 group-hover:text-lc-chalk" />
                        ) : null}
                      </span>
                    </>
                  );
                  return (
                    <li key={`${b.trackId}-${b.vehicle}`}>
                      {canJump ? (
                        <button
                          type="button"
                          onClick={() => {
                            onOpenBoard?.(b.trackId, b.vehicle as VehicleModelId);
                            onClose(false);
                          }}
                          className="group flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-start transition-colors hover:bg-white/[0.06] focus-visible:bg-lc-volt focus-visible:text-lc-void focus-visible:outline-none group-focus-visible:[&_span]:text-lc-void"
                        >
                          {rowContent}
                        </button>
                      ) : (
                        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">{rowContent}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
        {manualCount > 0 && (showAll || !context || context.scope === "all") ? (
          <p className="m-0 text-[11px] text-lc-slate">
            {note
              ? t("board.driverBadges.manualNote", { count: String(manualCount), note })
              : t("board.driverBadges.manual", { count: String(manualCount) })}
          </p>
        ) : null}
      </div>

      {onOpenBoard && groups.length > 0 ? (
        <p className="m-0 border-t border-white/6 pt-2 text-[11px] text-lc-slate">
          {t("board.driverBadges.tapCircuit")}
        </p>
      ) : null}
    </div>,
    document.body,
  );
};

interface FlPillSpec {
  key: string;
  tone: BadgeToneProp;
  text: string;
  ariaLabel: string;
  title: string;
  icon?: IconName;
}

function buildFlPills(b: DriverBadge, compact: boolean, context?: BadgeContext): FlPillSpec[] {
  const classGroups = groupBoardsByClass(b.boards);
  const fullTooltip = tooltipOf(b);

  // Manual-only FL (no board metadata)
  if (classGroups.length === 0) {
    const count = timesOf(b.count);
    return [
      {
        key: "track_record",
        tone: "best",
        icon: "lapTimes",
        text: compact ? t("board.driverBadges.flCompact", { count }) : t("board.driverBadges.fastestLap", { count }),
        ariaLabel: badgeLabel(b),
        title: fullTooltip,
      },
    ];
  }

  // Single-vehicle board: class-colored pill without redundant class prefix
  if (context?.scope === "vehicle") {
    const classId = vehicleClassOf(context.vehicle) ?? classGroups[0].classId;
    const meta = VEHICLE_CLASS_META[classId];
    const count = timesOf(b.count);
    return [
      {
        key: `track_record:${context.vehicle}`,
        tone: { color: meta.color },
        icon: "lapTimes",
        text: compact
          ? t("board.driverBadges.flCompact", { count })
          : t("board.driverBadges.classFastestLap", { class: meta.short, count }),
        ariaLabel: t("board.driverBadges.carFastestLap", { car: vehicleDisplayName(context.vehicle), count }),
        title: fullTooltip,
      },
    ];
  }

  // Single-class room/filter: class-colored & class-tagged pill
  if (context?.scope === "class") {
    const meta = VEHICLE_CLASS_META[context.classId];
    const count = timesOf(b.count);
    return [
      {
        key: `track_record:${context.classId}`,
        tone: { color: meta.color },
        icon: "lapTimes",
        text: compact
          ? t("board.driverBadges.flClassCompact", { class: meta.short, count })
          : t("board.driverBadges.classFastestLap", { class: meta.short, count }),
        ariaLabel: t("board.driverBadges.classFastestLap", { class: meta.label, count }),
        title: fullTooltip,
      },
    ];
  }

  // All cars / open lobby / Hall of Fame: up to 2 class-colored & class-tagged pills + optional +N overflow
  const pills: FlPillSpec[] = classGroups.slice(0, MAX_INLINE_FL_CLASSES).map((g) => {
    const meta = VEHICLE_CLASS_META[g.classId];
    const count = timesOf(g.count);
    return {
      key: `track_record:${g.classId}`,
      tone: { color: meta.color },
      icon: "lapTimes",
      text: compact
        ? t("board.driverBadges.flClassCompact", { class: meta.short, count })
        : t("board.driverBadges.classFl", { class: meta.short, count }),
      ariaLabel: t("board.driverBadges.classFastestLap", { class: meta.label, count }),
      title: fullTooltip,
    };
  });
  const shownBoardCount = classGroups.slice(0, MAX_INLINE_FL_CLASSES).reduce((sum, g) => sum + g.count, 0);
  const remaining = Math.max(0, b.count - shownBoardCount);
  if (remaining > 0) {
    pills.push({
      key: "track_record:more",
      tone: "best",
      text: `+${remaining}`,
      ariaLabel: t("board.driverBadges.moreRecords", { count: remaining }),
      title: fullTooltip,
    });
  }
  return pills;
}

/** A driver's badges (the Creator, weekly podiums, class-colored fastest laps with tap popover, OG, Bulb) */
export const DriverBadges: React.FC<DriverBadgesProps> = ({
  badges,
  compact = false,
  context,
  driverName,
  circuitName,
  onOpenBoard,
  interactive = true,
  className = "",
}) => {
  useI18nState();
  const [openAnchor, setOpenAnchor] = useState<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const visible = filterBadgesForContext(badges, context);
  const rawRecord = badges.find((b) => b.type === "track_record");
  const allBoards = rawRecord?.boards ?? [];
  const manualCount = rawRecord ? Math.max(0, rawRecord.count - allBoards.length) : 0;

  const closePopover = useCallback((refocus = false) => {
    setOpenAnchor(null);
    if (refocus) openerRef.current?.focus({ preventScroll: true });
  }, []);

  // Close popover if the surrounding board or room scope changes
  const contextKey =
    !context || context.scope === "all"
      ? "all"
      : context.scope === "vehicle"
        ? `v:${context.vehicle}`
        : `c:${context.classId}`;
  useEffect(() => {
    setOpenAnchor(null);
  }, [contextKey]);

  if (visible.length === 0) return null;
  const ordered = sortBadges(visible);
  const scopedRecord = ordered.find((b) => b.type === "track_record");
  const scopedBoards = scopedRecord?.boards ?? [];
  const canOpenPopover = interactive && allBoards.length > 0;

  return (
    <span className={`inline-flex shrink-0 flex-wrap items-center gap-1 ${className}`}>
      {ordered.map((b) => {
        if (b.type === "track_record") {
          const pills = buildFlPills(b, compact, context);
          return pills.map((p) => {
            const badgeEl = (
              <Badge
                tone={p.tone}
                variant="soft"
                size={compact ? "sm" : "md"}
                icon={p.icon}
                title={canOpenPopover ? undefined : p.title}
                aria-label={canOpenPopover ? undefined : p.ariaLabel}
                className={cx(compact ? "px-1.5" : undefined, canOpenPopover ? "transition-[filter] group-hover/fl:brightness-110" : undefined)}
              >
                {p.text}
              </Badge>
            );
            if (!canOpenPopover) return <React.Fragment key={p.key}>{badgeEl}</React.Fragment>;
            const isOpen = openAnchor !== null;
            return (
              <button
                key={p.key}
                type="button"
                title={p.title}
                aria-label={t("board.driverBadges.inspect", { badge: p.ariaLabel })}
                aria-haspopup="dialog"
                aria-expanded={isOpen}
                onClick={(e) => {
                  e.stopPropagation();
                  const btn = e.currentTarget;
                  if (openAnchor === btn) {
                    setOpenAnchor(null);
                  } else {
                    openerRef.current = btn;
                    setOpenAnchor(btn);
                  }
                }}
                className="group/fl inline-flex cursor-pointer appearance-none rounded-lc-nub border-0 bg-transparent p-0 focus-visible:ring-2 focus-visible:ring-lc-volt focus-visible:outline-none active:scale-[0.97]"
              >
                {badgeEl}
              </button>
            );
          });
        }
        const s = STYLE[b.type];
        const short = shortOf(b.type);
        const text = compact
          ? short
            ? t("board.driverBadges.shortTimes", { short, count: timesOf(b.count) })
            : b.count > 1
              ? `×${b.count}`
              : null
          : t("board.driverBadges.named", { name: badgeName(b.type), count: timesOf(b.count) });
        return (
          <Badge
            key={b.type}
            tone={s.tone}
            variant={s.variant}
            size={compact ? "sm" : "md"}
            icon={s.icon}
            title={tooltipOf(b)}
            aria-label={badgeLabel(b)}
            className={compact ? "px-1.5" : undefined}
          >
            {text}
          </Badge>
        );
      })}
      {openAnchor && canOpenPopover ? (
        <RecordPopover
          anchor={openAnchor}
          driverName={driverName}
          scopedBoards={scopedBoards}
          allBoards={allBoards}
          manualCount={manualCount}
          note={rawRecord?.note}
          context={context}
          circuitName={circuitName}
          onOpenBoard={onOpenBoard}
          onClose={closePopover}
        />
      ) : null}
    </span>
  );
};

const WEEKLY_MEDALS = ["weekly_gold", "weekly_silver", "weekly_bronze"] as const;
type WeeklyMedalType = (typeof WEEKLY_MEDALS)[number];
const isWeeklyMedal = (type: BadgeType): type is WeeklyMedalType => (WEEKLY_MEDALS as readonly BadgeType[]).includes(type);

/** The weekly medals in the key, as the message's select value: one place, or the run of places held */
function weeklyGroup(medals: readonly WeeklyMedalType[]): string {
  if (medals.length === 3) return "all";
  if (medals.length === 1) return medals[0] === "weekly_gold" ? "gold" : medals[0] === "weekly_silver" ? "silver" : "bronze";
  if (medals[0] === "weekly_gold" && medals[1] === "weekly_silver") return "goldSilver";
  if (medals[0] === "weekly_silver" && medals[1] === "weekly_bronze") return "silverBronze";
  return "goldBronze";
}

const MEANING: Record<Exclude<BadgeType, WeeklyMedalType>, MessageKey> = {
  track_record: "board.driverBadges.legend.trackRecord",
  og: "board.driverBadges.legend.og",
  bulb: "board.driverBadges.legend.bulb",
  creator: "board.driverBadges.legend.creator",
};

function flLegendMeta(context?: BadgeContext): { tone: BadgeToneProp; short: string } {
  if (context?.scope === "vehicle") {
    const classId = vehicleClassOf(context.vehicle);
    const meta = classId ? VEHICLE_CLASS_META[classId] : null;
    return {
      tone: meta ? { color: meta.color } : "best",
      short: t("board.driverBadges.flCompact", { count: 1 }),
    };
  }
  if (context?.scope === "class") {
    const meta = VEHICLE_CLASS_META[context.classId];
    return {
      tone: { color: meta.color },
      short: t("board.driverBadges.flClassCompact", { class: meta.short, count: 1 }),
    };
  }
  return {
    tone: "best",
    short: t("board.driverBadges.flCompact", { count: 1 }),
  };
}

export interface BadgeLegendProps {
  /** The badges a board shows; each kind present gets a compact entry */
  badges: readonly DriverBadge[];
  /** Matches the context passed to DriverBadges so hidden FL badges aren't listed in the key */
  context?: BadgeContext;
  className?: string;
}

/** Compact key for the badge pills visible on a board or lobby */
export const BadgeLegend: React.FC<BadgeLegendProps> = ({ badges, context, className = "" }) => {
  useI18nState();
  const visible = filterBadgesForContext(badges, context);
  const present = new Set(visible.map((b) => b.type));
  const weekly = WEEKLY_MEDALS.filter((type) => present.has(type));
  const others = BADGE_TYPES.filter((type): type is Exclude<BadgeType, WeeklyMedalType> => !isWeeklyMedal(type) && present.has(type));
  if (weekly.length === 0 && others.length === 0) return null;
  const flMeta = flLegendMeta(context);

  return (
    <ul className={cx("m-0 flex list-none flex-wrap items-center gap-x-4 gap-y-1.5 p-0", className)} aria-label={t("board.driverBadges.legend.key")}>
      {weekly.length > 0 ? (
        <li className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span aria-hidden="true" className="inline-flex items-center gap-1">
            {weekly.map((type) => {
              const s = STYLE[type];
              return (
                <Badge key={type} tone={s.tone} variant={s.variant} size="sm" icon={s.icon} className="px-1.5">
                  {shortOf(type)}
                </Badge>
              );
            })}
          </span>
          <span className="text-[12px] leading-none text-lc-fog">{t("board.driverBadges.legend.weekly", { medals: weeklyGroup(weekly) })}</span>
        </li>
      ) : null}
      {others.map((type) => {
        const s = STYLE[type];
        const tone = type === "track_record" ? flMeta.tone : s.tone;
        const short = type === "track_record" ? flMeta.short : shortOf(type);
        return (
          <li key={type} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span aria-hidden="true" className="inline-flex">
              <Badge tone={tone} variant={s.variant} size="sm" icon={s.icon} className="px-1.5">
                {short || null}
              </Badge>
            </span>
            <span className="text-[12px] leading-none text-lc-fog">{t(MEANING[type])}</span>
          </li>
        );
      })}
    </ul>
  );
};
