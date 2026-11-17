"use client";

/*
 * The lap board while driving: the player's place on the circuit's online board for the car they drive. Folded, one
 * line ("SACHSENRING  P14/312"); open, a timing tower: a white cap with the circuit and the place, the top three, a
 * gap, the two places above the player's, their row in volt and the two below, and the circuit's laps at the foot (in
 * the top five, a plain top of the board). The bound key (J) or a click opens and folds it; a small gear picks when it
 * opens (the HUD setting "Lap board"): for ten seconds after each lap, always, or never by itself.
 *
 * A leaf of the HUD with plain props, so the HUD's frame-by-frame renders pass it by; it reads the board itself, and
 * rarely: when it mounts, when it opens, at a lap's end, and every few minutes while it stays open. Never per frame.
 */
import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { VehicleModelId } from "@/types/f1";
import type { BoardWidgetMode } from "@/lib/settings/player-settings";
import { HUD_TOGGLE_EVENT } from "@/lib/input/bindings";
import { fetchBoardPage, fetchCircuitTotals, formatCount, driverNameKey, type BoardPage, type CircuitTotals } from "@/lib/net/board-client";
import { lapPhysicsVersion } from "@/lib/sim/lap-types";
import { Icon } from "@/components/ui/icons/Icon";
import { PositionBadge } from "@/components/ui/badges/PositionBadge";
import { InputIcon } from "@/components/board/InputIcon";
import { HUD_GLASS, HUD_LBL, formatLapTime } from "./hud-format";
import { CHROME_PX, NEAR, ROW_PX, TOP, towerLines } from "./board-data";
import { SkinButton, skinCss, SkinPanel, skinRootClass, SkinTag, useHudSkin } from "./styles/third-party-skin";

export { towerLines };

/**
 * A lap ended (`lap`), or its upload came back with the lap's new place (`result`): the game sends these on `window`,
 * and an open-at-lap-end board opens on them
 */
export const BOARD_LAP_EVENT = "lc:board-lap";
export type BoardLapDetail = { kind: "lap" } | { kind: "result"; rank: number; total: number | null };

/** Sends a lap's end, or its upload's answer, to the lap board */
export function signalBoardLap(detail: BoardLapDetail): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<BoardLapDetail>(BOARD_LAP_EVENT, { detail }));
}

/** How long a lap's end keeps the board open (ms) */
const LAP_END_OPEN_MS = 10_000;
/** A board read this recently is shown as it is when the widget opens (ms) */
const FRESH_MS = 60_000;
/** While it stays open, it is read again this often (ms) */
const REFRESH_OPEN_MS = 4 * 60_000;
/** After a lap, how long to wait for its upload's answer before reading the board anyway (ms) */
const RESULT_WAIT_MS = 4_000;

const MODE_LABEL: Record<BoardWidgetMode, string> = { lapEnd: "Open at lap end", open: "Always open", closed: "Always closed" };
const MODES: readonly BoardWidgetMode[] = ["lapEnd", "open", "closed"];

/** What the widget last read for a board, kept across remounts (the HUD hides and comes back) */
interface Read {
  at: number;
  page: BoardPage | null;
  totals: CircuitTotals | null;
}
const reads = new Map<string, Read>();

export interface BoardWidgetProps {
  trackId: string;
  /** The circuit's name for the cap ("Sachsenring") */
  trackName: string;
  vehicle: VehicleModelId;
  driverName: string;
  mode: BoardWidgetMode;
  onChangeMode: (mode: BoardWidgetMode) => void;
  /** The key that opens and folds it, as its cap reads ("J"); none when unbound */
  keyName?: string;
}

/** The cursor on the widget's controls, for the keys only (a click lets go of the focus at once, see `letGo`) */
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-lc-volt";

/** Keeps a pressed HUD control from holding the focus: Space (boost) must never press it again */
const letGo = (e: React.SyntheticEvent<HTMLElement>) => e.currentTarget.blur();

const BoardWidgetImpl: React.FC<BoardWidgetProps> = ({ trackId, trackName, vehicle, driverName, mode, onChangeMode, keyName }) => {
  const skin = useHudSkin();
  const name = driverName.trim();
  const physics = lapPhysicsVersion(vehicle);
  const boardKey = `${trackId}|${vehicle}|${physics}|${driverNameKey(name)}`;
  /** The board shown now: a read that answers after the car, circuit or name changed is cached, never shown */
  const shownKey = useRef(boardKey);
  useLayoutEffect(() => {
    shownKey.current = boardKey;
  }, [boardKey]);
  const [read, setRead] = useState<Read | null>(() => reads.get(boardKey) ?? null);
  /** The place an upload just gave the lap, shown at once while the board is read again */
  const [justSet, setJustSet] = useState<{ rank: number; total: number | null } | null>(null);

  // Open or folded: the mode's own state, which the key and a click turn over, and a lap's end opens for a while
  const [toggled, setToggled] = useState<{ mode: BoardWidgetMode; open: boolean } | null>(null);
  const [lapOpenUntil, setLapOpenUntil] = useState(0);
  const lapOpen = lapOpenUntil > 0;
  const open = toggled && toggled.mode === mode ? toggled.open : mode === "open" || (mode === "lapEnd" && lapOpen);
  const [menu, setMenu] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /**
   * Rows the open tower has room for: down to the HUD panels below it in its corner (`data-hud-floor`: the tyres, the
   * trace, the key hints), at the HUD's size. Measured when it opens and when the window changes, never per frame.
   */
  const [rowsRoom, setRowsRoom] = useState(99);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = rootRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const scale = el.offsetWidth > 0 ? box.width / el.offsetWidth : 1;
      let floor = window.innerHeight - 12;
      // The corner's own panels, and on a narrower window the centre pod or dash and the MFD where they reach under it
      for (const below of document.querySelectorAll<HTMLElement>("[data-hud-floor], [data-hud-avoid]")) {
        const b = below.getBoundingClientRect();
        if (b.height < 1 || b.right <= box.left || b.left >= box.right || b.top <= box.top) continue;
        floor = Math.min(floor, b.top - 10);
      }
      // What its own corner group holds under it (the Telemetry layout's lap analysis) moves down with it
      let group: HTMLElement | null = el.parentElement;
      while (group && getComputedStyle(group).position !== "absolute") group = group.parentElement;
      const under = group ? Math.max(0, group.getBoundingClientRect().bottom - box.bottom) : 0;
      setRowsRoom(Math.floor(((floor - box.top - under) / scale - CHROME_PX) / ROW_PX));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, read]);

  const load = useCallback(
    async (force = false) => {
      const known = reads.get(boardKey);
      if (!force && known && Date.now() - known.at < FRESH_MS) {
        setRead(known);
        return;
      }
      const [page, totals] = await Promise.all([
        fetchBoardPage(trackId, vehicle, { physics, name: name || undefined, limit: TOP, near: name ? NEAR : undefined }).catch(() => null),
        fetchCircuitTotals(trackId, vehicle, physics).catch(() => null),
      ]);
      // A failed read keeps what was shown; a first failed read shows nothing (the board may be off)
      const next: Read = { at: Date.now(), page: page ?? known?.page ?? null, totals: totals ?? known?.totals ?? null };
      reads.set(boardKey, next);
      if (shownKey.current !== boardKey) return;
      setRead(next);
      if (page) setJustSet(null);
    },
    [boardKey, trackId, vehicle, physics, name],
  );

  // On mount, and for another circuit, car or name: the board as last read, read again when older than a few minutes
  useEffect(() => {
    const known = reads.get(boardKey);
    setRead(known ?? null);
    if (!known || Date.now() - known.at > REFRESH_OPEN_MS) void load(true);
  }, [boardKey, load]);

  // Opened: read again unless just read; while it stays open, every few minutes
  useEffect(() => {
    if (!open) return;
    void load(false);
    const id = window.setInterval(() => void load(true), REFRESH_OPEN_MS);
    return () => window.clearInterval(id);
  }, [open, load]);

  // The bound key (or pad button): opens or folds it; folding a lap's-end opening ends it
  useEffect(() => {
    const onKey = () => {
      setLapOpenUntil(0);
      setToggled((t) => ({ mode, open: !(t && t.mode === mode ? t.open : mode === "open" || (mode === "lapEnd" && lapOpen)) }));
    };
    window.addEventListener(HUD_TOGGLE_EVENT.board, onKey);
    return () => window.removeEventListener(HUD_TOGGLE_EVENT.board, onKey);
  }, [mode, lapOpen]);

  // A lap's end: opens it for ten seconds (open at lap end), and reads the board once the upload has answered
  const resultTimer = useRef<number | null>(null);
  useEffect(() => {
    const onLap = (e: Event) => {
      const detail = (e as CustomEvent<BoardLapDetail>).detail;
      if (!detail) return;
      if (mode === "lapEnd") {
        setToggled(null);
        setLapOpenUntil(Date.now() + LAP_END_OPEN_MS);
      }
      if (resultTimer.current !== null) window.clearTimeout(resultTimer.current);
      resultTimer.current = null;
      if (detail.kind === "result") {
        setJustSet({ rank: detail.rank, total: detail.total });
        void load(true);
      } else {
        // No faster lap, no upload: read it anyway once the upload had its time (if it was older than a minute)
        resultTimer.current = window.setTimeout(() => void load(false), RESULT_WAIT_MS);
      }
    };
    window.addEventListener(BOARD_LAP_EVENT, onLap);
    return () => {
      window.removeEventListener(BOARD_LAP_EVENT, onLap);
      if (resultTimer.current !== null) window.clearTimeout(resultTimer.current);
    };
  }, [mode, load]);

  // A lap's-end opening folds again after ten seconds
  useEffect(() => {
    if (!lapOpenUntil) return;
    const id = window.setTimeout(() => setLapOpenUntil(0), Math.max(0, lapOpenUntil - Date.now()));
    return () => window.clearTimeout(id);
  }, [lapOpenUntil]);

  // The gear's menu closes on a press anywhere else
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("pointerdown", away, { capture: true });
    return () => window.removeEventListener("pointerdown", away, { capture: true });
  }, [menu]);

  const page = read?.page ?? null;
  // Nothing read (the board is off or out of reach): no widget rather than an empty one
  if (!page) return null;
  const me = page.me;
  const rank = justSet?.rank ?? me?.pos ?? null;
  const total = justSet?.total ?? page.total;
  const place = rank !== null ? `P${rank}/${formatCount(total)}` : null;
  const lines = towerLines(page, driverNameKey(name), rowsRoom);
  // Wide enough for the longest place shown ("1284"), the same on every row so the codes line up
  const maxPos = lines.reduce((m, l) => ("pos" in l ? Math.max(m, l.pos) : m), 0);
  const posCol = { "--lc-pos-w": `max(26px, ${String(maxPos).length}ch)` } as React.CSSProperties;
  const laps = read?.totals?.laps ?? null;

  const toggle = () => {
    setLapOpenUntil(0);
    setToggled({ mode, open: !open });
  };

  if (skin !== null) {
    const gearButton = (
      <SkinButton
        aria-label="When the lap board opens"
        aria-haspopup="menu"
        aria-expanded={menu}
        active={menu}
        soft
        title="When the lap board opens"
        onClick={(e) => {
          letGo(e);
          setMenu((m) => !m);
        }}
        className="size-6.5 shrink-0"
      >
        <Icon name="settings" size="xs" className="size-3.5" />
      </SkinButton>
    );

    const dropdownMenu = menu ? (
      <SkinPanel
        cut="sm"
        role="menu"
        aria-label="When the lap board opens"
        className="absolute top-full right-0 z-20 mt-1.5 w-44"
        innerClassName="flex flex-col gap-0.5 p-1"
      >
        {MODES.map((m) => (
          <SkinButton
            key={m}
            role="menuitemradio"
            aria-checked={m === mode}
            active={m === mode}
            soft
            onClick={(e) => {
              letGo(e);
              setMenu(false);
              setToggled(null);
              setLapOpenUntil(0);
              onChangeMode(m);
            }}
            className="h-8 justify-start px-2.5 text-left text-[12px] font-semibold"
          >
            <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
              {m === mode ? <Icon name="check" size="xs" className="size-3.5" /> : null}
            </span>
            {MODE_LABEL[m]}
          </SkinButton>
        ))}
      </SkinPanel>
    ) : null;

    return (
      <div ref={rootRef} className={`pointer-events-auto relative w-[264px] max-w-full ${skinRootClass(skin) ?? ""}`} data-hud-board>
        {open ? (
          <SkinPanel cut="md" role="region" aria-label="Lap board">
            <button
              type="button"
              onClick={(e) => {
                letGo(e);
                toggle();
              }}
              aria-expanded
              aria-label={`Fold the lap board${keyName ? ` (${keyName})` : ""}`}
              title={trackName}
              className={`flex h-11 w-full cursor-pointer items-center gap-2.5 pr-2.5 pl-3 text-left ${skinCss.headerBar} ${skinCss.ink}`}
            >
              <span className="min-w-0 flex-1 truncate text-[15px] leading-none font-bold tracking-[0.04em] uppercase">{trackName}</span>
              {rank !== null ? (
                <span className="inline-flex shrink-0 items-center gap-1">
                  <SkinTag tone="accent" filled className="px-1.5 py-0.5 text-[11px] font-bold">
                    P{rank}
                  </SkinTag>
                  <span className={`lc-data text-[11px] ${skinCss.inkDim}`}>/{formatCount(total)}</span>
                </span>
              ) : (
                <span className={`lc-data shrink-0 text-[11px] ${skinCss.inkDim}`}>{formatCount(total)} {total === 1 ? "driver" : "drivers"}</span>
              )}
            </button>
            {lines.length === 0 ? (
              <p className={`lc-data m-0 px-3 py-3 text-[12px] ${skinCss.inkDim}`}>No times here yet. Yours can be the first.</p>
            ) : (
              <ol className="m-0 flex list-none flex-col gap-0.5 px-1.5 pt-1.5 pb-1.5">
                {lines.map((l) =>
                  "gap" in l ? (
                    <li key={l.key} aria-label="Places between" className={`flex h-5 items-center justify-center ${skinCss.inkDim}`}>
                      <Icon name="more" size="xs" className="size-3.5" />
                    </li>
                  ) : (
                    <li
                      key={`${l.pos}-${l.entry.code}`}
                      title={l.entry.name}
                      style={posCol}
                      aria-current={l.mine ? "true" : undefined}
                      className={`lc-data grid h-7 grid-cols-[var(--lc-pos-w,26px)_34px_minmax(0,1fr)_auto] items-center gap-1.5 pr-2.5 pl-2 text-[13px] ${skinCss.row} ${
                        l.mine ? `font-bold ${skinCss.playerRow}` : skinCss.ink
                      }`}
                    >
                      <span className={`text-center ${skinCss.pos} ${l.mine ? "" : skinCss.inkDim}`}>{l.pos}</span>
                      <span className="tracking-[0.1em]">{l.entry.code.slice(0, 3)}</span>
                      <span dir="auto" className={`truncate text-left font-sans text-[12px] ${l.mine ? "" : skinCss.inkSoft}`}>{l.entry.name}</span>
                      <span className="text-right text-[12px]">{formatLapTime(l.entry.lapTimeMs)}</span>
                    </li>
                  ),
                )}
              </ol>
            )}
            <div className={`flex h-8 items-center gap-2 border-t pr-1 pl-3 ${skinCss.divider}`}>
              <span className={`flex-1 ${skinCss.label}`}>Laps driven</span>
              <span className={`lc-data text-[11px] ${skinCss.inkSoft}`}>{laps !== null ? formatCount(laps) : "--"}</span>
              {gearButton}
            </div>
          </SkinPanel>
        ) : (
          <SkinPanel cut="sm" innerClassName="flex h-9 items-center gap-1.5 pr-1.5 pl-3">
            <button
              type="button"
              onClick={(e) => {
                letGo(e);
                toggle();
              }}
              aria-expanded={false}
              aria-label={`Open the lap board${keyName ? ` (${keyName})` : ""}: ${trackName}, ${place ?? "no time yet"}`}
              title={trackName}
              className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left ${skinCss.ink}`}
            >
              <span className="min-w-0 flex-1 truncate text-[13px] leading-none font-bold uppercase">{trackName}</span>
              <span className={`lc-data shrink-0 text-[12px] ${skinCss.ink}`}>
                {place ?? <span className={skinCss.inkDim}>No time yet</span>}
              </span>
              <Icon name="expand" size="xs" className={`size-3.5 shrink-0 ${skinCss.inkDim}`} />
            </button>
            {gearButton}
          </SkinPanel>
        )}
        {dropdownMenu}
      </div>
    );
  }

  const gear = (
    <div className="relative">
      <button
        type="button"
        aria-label="When the lap board opens"
        aria-haspopup="menu"
        aria-expanded={menu}
        title="When the lap board opens"
        onClick={(e) => {
          letGo(e);
          setMenu((m) => !m);
        }}
        className={`relative inline-flex size-7 items-center justify-center rounded-full text-lc-slate pointer-fine:after:absolute pointer-fine:after:-inset-1 transition-colors duration-200 ease-lc hover:bg-white/8 hover:text-lc-chalk aria-expanded:bg-white/8 aria-expanded:text-lc-chalk ${FOCUS}`}
      >
        <Icon name="settings" size="xs" className="size-3.5" />
      </button>
      {menu ? (
        <div role="menu" aria-label="When the lap board opens" className={`absolute top-full right-0 z-10 mt-1.5 flex w-44 flex-col rounded-lc-row p-1 ${HUD_GLASS}`}>
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="menuitemradio"
              aria-checked={m === mode}
              onClick={(e) => {
                letGo(e);
                setMenu(false);
                setToggled(null);
                setLapOpenUntil(0);
                onChangeMode(m);
              }}
              className={`flex h-8 items-center gap-2 rounded-full px-2.5 text-left text-[12px] font-semibold text-lc-fog transition-colors duration-200 ease-lc hover:bg-white/8 hover:text-lc-chalk aria-checked:text-lc-chalk ${FOCUS}`}
            >
              <span className="inline-flex size-3.5 shrink-0 items-center justify-center">{m === mode ? <Icon name="check" size="xs" className="size-3.5" /> : null}</span>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <div ref={rootRef} className="pointer-events-auto w-[264px] max-w-full" data-hud-board>
      {open ? (
        <section aria-label="Lap board" className={`overflow-visible rounded-lc-tile ${HUD_GLASS}`}>
          {/* The cap: the circuit and the place, white, as the timing tower's */}
          <button
            type="button"
            onClick={(e) => {
              letGo(e);
              toggle();
            }}
            aria-expanded
            aria-label={`Fold the lap board${keyName ? ` (${keyName})` : ""}`}
            title={trackName}
            className={`flex h-11 w-full items-center gap-2.5 rounded-t-lc-tile rounded-b-lc-row bg-lc-chalk pr-2.5 pl-3 text-left text-lc-void ${FOCUS}`}
          >
            <span className="lc-disp min-w-0 flex-1 truncate text-[17px] leading-none">{trackName}</span>
            {rank !== null ? (
              <span className="inline-flex shrink-0 items-center gap-1">
                <PositionBadge position={rank} player size="sm" />
                <span className="lc-data text-[11px] text-lc-void/60">/{formatCount(total)}</span>
              </span>
            ) : (
              <span className="lc-data shrink-0 text-[11px] text-lc-void/60">{formatCount(total)} {total === 1 ? "driver" : "drivers"}</span>
            )}
          </button>
          {lines.length === 0 ? (
            <p className="lc-data m-0 px-3 py-3 text-[12px] text-lc-slate">No times here yet. Yours can be the first.</p>
          ) : (
            <ol className="m-0 list-none pt-1.5 pb-1">
              {lines.map((l) =>
                "gap" in l ? (
                  <li key={l.key} aria-label="Places between" className="flex h-5 items-center justify-center text-lc-slate">
                    <Icon name="more" size="xs" className="size-3.5" />
                  </li>
                ) : (
                  <li
                    key={`${l.pos}-${l.entry.code}`}
                    title={l.entry.name}
                    style={posCol}
                    aria-current={l.mine ? "true" : undefined}
                    className={`lc-data grid h-7 grid-cols-[var(--lc-pos-w,26px)_34px_minmax(0,1fr)_auto] items-center gap-1.5 text-[13px] ${
                      l.mine ? "mx-1.5 my-0.5 rounded-full bg-lc-volt pr-2.5 pl-0.5 text-lc-void" : "pr-2.5 pl-2 text-lc-chalk"
                    }`}
                  >
                    <span className={`text-center ${l.mine ? "" : "text-lc-slate"}`}>{l.pos}</span>
                    <span className="tracking-[0.1em]">{l.entry.code.slice(0, 3)}</span>
                    <span className="flex min-w-0 items-center gap-1">
                      <span dir="auto" className={`truncate font-sans text-[12px] ${l.mine ? "" : "text-lc-fog"}`}>{l.entry.name}</span>
                      <InputIcon input={l.entry.conditions?.input} className={l.mine ? "" : "text-lc-slate"} />
                    </span>
                    <span className="text-right text-[12px]">{formatLapTime(l.entry.lapTimeMs)}</span>
                  </li>
                ),
              )}
            </ol>
          )}
          {/* The foot: how many laps the circuit has seen in this car, and the gear */}
          <div className="flex h-8 items-center gap-2 border-t border-white/7 pr-1 pl-3">
            <span className={`${HUD_LBL} flex-1`}>Laps driven</span>
            <span className="lc-data text-[11px] text-lc-fog">{laps !== null ? formatCount(laps) : "--"}</span>
            {gear}
          </div>
        </section>
      ) : (
        <div className={`flex h-9 items-center gap-1 rounded-full pr-1 pl-3.5 ${HUD_GLASS}`}>
          <button
            type="button"
            onClick={(e) => {
              letGo(e);
              toggle();
            }}
            aria-expanded={false}
            aria-label={`Open the lap board${keyName ? ` (${keyName})` : ""}: ${trackName}, ${place ?? "no time yet"}`}
            title={trackName}
            className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-full text-left text-lc-chalk ${FOCUS}`}
          >
            <span className="lc-disp min-w-0 flex-1 truncate text-[14px] leading-none">{trackName}</span>
            <span className="lc-data shrink-0 text-[12px] text-lc-chalk">{place ?? <span className="text-lc-slate">No time yet</span>}</span>
            <Icon name="expand" size="xs" className="size-3.5 shrink-0 text-lc-slate" />
          </button>
          {gear}
        </div>
      )}
    </div>
  );
};

/** The lap board while driving: passed over by the HUD's own renders while its props stay the same */
export const BoardWidget = memo(BoardWidgetImpl);

/**
 * A screen large enough for the board: at least 1280 × 720. Narrower, the top-centre column (the launch hint, race
 * control's notices) reaches over the top-left corner where the Wheel dash and Minimal layouts put the board
 */
const LARGE_QUERY = "(min-width: 80rem) and (min-height: 45rem)";
const subscribeLarge = (onChange: () => void) => {
  const query = window.matchMedia(LARGE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/** True on a screen large enough for the lap board: below it the board is not mounted at all (no reads, no key) */
export function useLargeScreen(): boolean {
  return useSyncExternalStore(subscribeLarge, () => window.matchMedia(LARGE_QUERY).matches, () => false);
}
