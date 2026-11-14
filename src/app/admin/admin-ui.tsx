"use client";

/**
 * The pieces of the owner's numbers page (AdminStats.tsx): cards, number tiles, the bar charts and the lists, and the
 * plain names and formats the numbers are shown with.
 */
import { type ReactNode, useState } from "react";
import { SiteSection } from "@/components/home/SitePage";
import { Card as KitCard, Meter } from "@/components/ui";
import { Trend } from "@/components/ui/icons";
import { cx } from "@/components/ui/styles";

/** A quiet sentence: an empty list, a footnote */
export const NOTE = "lc-body m-0 text-lc-slate";

/**
 * The modes in a fixed order, each with its name and colour. The colours are a data palette (which mode, not how it
 * went), so they come from the palette's hues and never volt, and never the crimson of an error.
 */
export const MODES = [
  { id: "practice", name: "Practice", swatch: "bg-lc-cyan" },
  { id: "time_trial", name: "Time trial", swatch: "bg-lc-purple" },
  { id: "ai_race", name: "Race against AI", swatch: "bg-lc-green" },
  { id: "open_race", name: "Open race", swatch: "bg-lc-amber" },
  { id: "room_race", name: "Room race", swatch: "bg-lc-pink" },
] as const;
export const modeName = (id: string) => MODES.find((m) => m.id === id)?.name ?? id;

/** Plain names of the settings the numbers are split by; an unknown value shows as it is */
const SETTING_NAMES: Record<string, string> = {
  keyboard: "Keyboard",
  controller: "Controller",
  wheel: "Wheel",
  touch: "Touch screen",
  desktop: "Desktop",
  tablet: "Tablet",
  phone: "Phone",
  dry: "Dry",
  wet: "Wet",
  pro: "Pro (no assists)",
  semi_pro: "Semi-pro",
  assisted: "Assisted",
  casual: "Casual",
  standard: "Standard",
  full: "Full",
  soft: "Soft",
  medium: "Medium",
  hard: "Hard",
  intermediate: "Intermediate",
};
export const settingName = (id: string) => SETTING_NAMES[id] ?? id;

export const count = (n: number) => Math.round(n).toLocaleString("en-GB");
/** Hours from minutes: one decimal below ten hours, whole hours above */
export const hours = (minutes: number) => {
  const h = minutes / 60;
  return h >= 10 ? Math.round(h).toLocaleString("en-GB") : h.toFixed(1);
};
/** A share as a whole percentage; a small one that is not nothing reads "<1%" */
export const percent = (part: number, whole: number) => {
  if (whole <= 0) return "–";
  const p = (part / whole) * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
};
export const bytes = (n: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
};
/** "+12% on the 30 days before", or null when there is nothing to compare with */
export function change(current: number, before: number): { text: string; up: boolean } | null {
  if (before <= 0) return null;
  const p = Math.round(((current - before) / before) * 100);
  return { text: `${p > 0 ? "+" : ""}${p}%`, up: p >= 0 };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-09" → "9 Nov" */
export const dayLabel = (iso: string) => {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};
/** "2026-W46" → "Week 46" */
export const weekLabel = (week: string) => {
  const m = /^\d{4}-W(\d{1,2})$/.exec(week);
  return m ? `Week ${Number(m[1])}` : week;
};

/** Every UTC day from `from` to `to`, with the value of each (0 for the days not listed) */
export function everyDay<T extends { day: string }>(from: string, to: string, rows: T[], empty: (day: string) => T): T[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: T[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? empty(day));
  }
  return out;
}

/** A section of the page with its title and a sentence that says what it shows */
export function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <SiteSection id={id} title={title} gap="gap-4">
      {intro ? <p className="lc-body m-0 -mt-1 mb-1 max-w-[72ch] text-[15px] leading-[1.55]">{intro}</p> : null}
      {children}
    </SiteSection>
  );
}

/** A card with its title and, under it, a word on what it counts */
export function Card({ title, aside, children, className }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <KitCard title={title} description={aside} bodyClassName="gap-3" className={className}>
      {children}
    </KitCard>
  );
}

/** One number, what it is, and how it compares or a word on it */
export function Tile({ label, value, note, trend }: { label: string; value: string; note?: string; trend?: { text: string; up: boolean } | null }) {
  return (
    <KitCard bodyClassName="gap-1.5" className="justify-between">
      <p className="lc-data m-0 text-[30px] leading-none text-lc-chalk">{value}</p>
      <p className="lc-row-label m-0 pt-1 text-[14px]">{label}</p>
      {trend ? (
        <p className="lc-hint m-0">
          <span className={cx("lc-data inline-flex items-center gap-1", trend.up ? "text-lc-gain" : "text-lc-loss")}>
            <Trend direction={trend.up ? "up" : "down"} />
            {trend.text}
          </span>{" "}
          on the days before
        </p>
      ) : note ? (
        <p className="lc-hint m-0">{note}</p>
      ) : null}
    </KitCard>
  );
}

export function Tiles({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

export interface Bar {
  /** The x label ("9 Nov", "Mon") */
  label: string;
  value: number;
  /** What the readout says when this bar is hovered or tapped */
  readout: string;
}

/**
 * Bars in one colour (inline SVG). Hovering or tapping a bar shows its value above the chart; without one the
 * readout names the highest. A table of the same numbers sits under it.
 */
export function BarChart({ bars, label, unit, height = 160 }: { bars: Bar[]; label: string; unit: string; height?: number }) {
  // The days shown: another range shows other days, while the same range read again (or the weekdays) keeps them
  const span = `${bars.length}|${bars[0]?.label ?? ""}|${bars[bars.length - 1]?.label ?? ""}`;
  const [hovered, setHovered] = useState<{ span: string; i: number } | null>(null);
  // A bar hovered or tapped under another range is not this one's
  const hover = hovered !== null && hovered.span === span && hovered.i < bars.length ? hovered.i : null;
  const setHover = (i: number | null) => setHovered(i === null ? null : { span, i });
  const max = Math.max(0, ...bars.map((b) => b.value));
  const peak = bars.reduce((best, b, i) => (b.value > bars[best].value ? i : best), 0);
  const W = 1000;
  const H = height;
  const step = W / Math.max(1, bars.length);
  const gap = Math.min(6, step * 0.25);
  const shown = hover ?? (max > 0 ? peak : null);
  const ticks = bars.length > 14 ? [0, Math.floor((bars.length - 1) / 2), bars.length - 1] : bars.map((_, i) => i);
  return (
    <div className="flex flex-col gap-2">
      <p className="lc-body m-0 min-h-5 text-[14px]" aria-live="polite">
        {shown === null ? (
          "Nothing in this range."
        ) : (
          <>
            {hover === null ? "Most: " : ""}
            <span className="lc-data text-lc-chalk">{bars[shown].readout}</span>
          </>
        )}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full touch-pan-y" style={{ height: H }} role="img" aria-label={label} onPointerLeave={(e) => {
          // A finger's tap ends with a pointerleave, so a tapped bar keeps its readout until another is tapped
          if (e.pointerType !== "touch") setHover(null);
        }}>
        <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="stroke-lc-line" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {bars.map((b, i) => {
          const h = max > 0 ? (b.value / max) * (H - 6) : 0;
          return (
            <g key={`${b.label}-${i}`} onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}>
              {/* The whole column answers the pointer, not only the bar */}
              <rect x={i * step} y={0} width={step} height={H} fill="transparent" />
              {/* Neutral ink; the bar the readout names is chalk */}
              {h > 0 ? <rect x={i * step + gap / 2} y={H - h} width={Math.max(1, step - gap)} height={h} rx={3} className={i === shown ? "fill-lc-chalk" : "fill-lc-slate/60"} /> : null}
            </g>
          );
        })}
      </svg>
      <div className="lc-mono relative h-4 text-[12px] text-lc-slate">
        {ticks.map((i) => (
          <span
            key={i}
            className="absolute top-0 whitespace-nowrap"
            style={i === 0 ? { left: 0 } : i === bars.length - 1 ? { right: 0 } : { left: `${((i + 0.5) / bars.length) * 100}%`, transform: "translateX(-50%)" }}
          >
            {bars[i].label}
          </span>
        ))}
      </div>
      <details className="text-[13px] text-lc-slate">
        <summary className="inline-flex min-h-9 cursor-pointer items-center rounded-lc-nub select-none hover:text-lc-chalk pointer-coarse:min-h-11">Show as a table</summary>
        <table className="mt-2 w-full text-left">
          <thead>
            <tr className="text-lc-slate">
              <th scope="col" className="lc-lbl py-1.5">
                Day
              </th>
              <th scope="col" className="lc-lbl py-1.5 text-right">
                {unit}
              </th>
            </tr>
          </thead>
          <tbody className="lc-mono text-lc-fog">
            {bars.map((b, i) => (
              <tr key={`${b.label}-${i}`} className="border-t border-lc-titanium">
                <td className="py-1 font-normal">{b.label}</td>
                <td className="py-1 text-right">{b.readout.split(": ").pop()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

export interface Row {
  id: string;
  name: string;
  /** The bar's length and the main number */
  value: number;
  /** The main number as shown */
  shown: string;
  /** A second, quieter number beside it */
  extra?: string;
}

/** A ranked list: each row's name and number over a bar against the largest */
export function RankList({ rows, empty = "Nothing in this range.", limit = 10 }: { rows: Row[]; empty?: string; limit?: number }) {
  const top = rows.slice(0, limit);
  const max = Math.max(1, ...top.map((r) => r.value));
  if (!top.length) return <p className={NOTE}>{empty}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {top.map((r) => (
        <li key={r.id} title={r.id !== r.name ? r.id : undefined}>
          <Meter stacked tone="neutral" label={r.name} value={r.value / max} detail={r.extra ? `${r.shown} · ${r.extra}` : r.shown} />
        </li>
      ))}
    </ul>
  );
}

/** Shares of a whole: each value's name, its percentage and a bar of that percentage */
export function ShareList({ rows, total, unit, empty = "Nothing in this range." }: { rows: { id: string; value: number }[]; total: number; unit: (v: number) => string; empty?: string }) {
  if (!rows.length || total <= 0) return <p className={NOTE}>{empty}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {rows.map((r) => (
        <li key={r.id}>
          <Meter stacked tone="neutral" label={settingName(r.id)} value={r.value / total} detail={`${percent(r.value, total)} · ${unit(r.value)}`} />
        </li>
      ))}
    </ul>
  );
}

/** The mode colours with their names, above a chart that uses them */
export function ModeLegend({ present }: { present: string[] }) {
  return (
    <ul className="lc-hint m-0 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0 text-[13px] text-lc-fog" aria-label="Modes">
      {MODES.filter((m) => present.includes(m.id)).map((m) => (
        <li key={m.id} className="flex items-center gap-1.5">
          <span aria-hidden className={cx("inline-block size-2.5 rounded-full", m.swatch)} />
          {m.name}
        </li>
      ))}
    </ul>
  );
}

/** Circuits ranked by hours, each bar split into its modes (a legend above names the colours) */
export function ModeSplitList({ rows }: { rows: { id: string; name: string; minutes: number; sessions: number; modes: { mode: string; minutes: number }[] }[] }) {
  const top = rows.slice(0, 10);
  const max = Math.max(1, ...top.map((r) => r.minutes));
  const present = [...new Set(top.flatMap((r) => r.modes.filter((m) => m.minutes > 0).map((m) => m.mode)))];
  if (!top.length) return <p className={NOTE}>Nothing in this range.</p>;
  return (
    <div className="flex flex-col gap-3">
      <ModeLegend present={present} />
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {top.map((r) => (
          <li key={r.id} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-[14px] leading-tight font-medium text-lc-chalk" title={r.id}>
                {r.name}
              </span>
              <span className="lc-data shrink-0 text-[12px] text-lc-fog">
                {hours(r.minutes)} h · {count(r.sessions)} sessions
              </span>
            </div>
            <div className="h-2 rounded-full bg-lc-titanium">
              <div className="flex h-full gap-0.5" style={{ width: `${(r.minutes / max) * 100}%` }}>
                {MODES.map((m) => {
                  const part = r.modes.find((x) => x.mode === m.id)?.minutes ?? 0;
                  if (part <= 0) return null;
                  return (
                    <div key={m.id} className={cx("h-full min-w-[3px] rounded-full", m.swatch)} style={{ flexGrow: part, flexBasis: 0 }} title={`${m.name}: ${hours(part)} h`} />
                  );
                })}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A small table: a header row and rows of cells, the first column a name and the rest numbers */
export function NumberTable({ head, rows, empty = "Nothing in this range." }: { head?: string[]; rows: { key: string; cells: string[] }[]; empty?: string }) {
  if (!rows.length) return <p className={NOTE}>{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[280px] text-left text-[14px]">
        {head ? (
          <thead>
            <tr>
              {head.map((h, i) => (
                <th key={h} scope="col" className={`lc-lbl pb-2 ${i > 0 ? "text-right" : ""}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-lc-titanium first:border-t-0">
              {r.cells.map((c, i) => (
                <td key={i} title={i === 0 ? c : undefined} className={`py-2 ${i > 0 ? "lc-data text-right text-lc-chalk" : "max-w-[220px] truncate pr-3 text-lc-fog"}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
