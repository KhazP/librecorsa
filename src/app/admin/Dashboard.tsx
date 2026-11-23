"use client";

/**
 * The owner's numbers once the key has opened them (GET <api>/admin/stats, and Cloudflare's own at <api>/admin/cloudflare),
 * laid out to be read top to bottom: a summary with the live count, the days of the range, driving, how long sessions
 * last, builds, drivers, boards, races and the site. Loaded by AdminStats.tsx only after the key is accepted.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { SitePage } from "@/components/home/SitePage";
import { Badge } from "@/components/ui/Badge";
import { Button, Segmented } from "@/components/ui";
import { Icon } from "@/components/ui/icons";
import { onlineUrl } from "@/lib/net/online-config";
import type { AdminStats as StatsBody, Count, UsageGroup } from "../../../cloudflare/api/admin";
import type { CloudflareStats } from "../../../cloudflare/api/analytics";
import { readAdmin } from "./admin-fetch";
import { AwardsSection } from "./AwardsSection";
import { type BuildDay, buildDays } from "./build-days";
import {
  AverageList,
  BarChart,
  bytes,
  Card,
  Caution,
  change,
  count,
  dayLabel,
  everyDay,
  hours,
  idWords,
  ModeSplitList,
  modeName,
  NOTE,
  NumberTable,
  percent,
  perSession,
  RankList,
  Section,
  settingName,
  ShareList,
  SplitChart,
  type SplitDay,
  Tile,
  Tiles,
  TrendChart,
  type TrendRow,
  weekLabel,
} from "./admin-ui";

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();
const countryName = (code: string) => {
  if (code === "XX") return "Unknown";
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
};

type Namer = (id: string) => string;
const asIs: Namer = (id) => id;

/** Circuit and car names, loaded with the dashboard (the car list brings the sims with it) */
function useNames(): { circuit: Namer; car: Namer } {
  const [names, setNames] = useState<{ circuit: Namer; car: Namer }>({ circuit: idWords, car: asIs });
  useEffect(() => {
    let live = true;
    void Promise.all([import("@/lib/track-registry"), import("@/lib/cars/car-registry")])
      .then(([tracks, cars]) => {
        if (!live) return;
        const circuit: Namer = (id) => {
          const t = tracks.TRACKS.find((x) => x.id === id);
          // A circuit the game no longer has keeps its id, in words
          if (!t) return idWords(id);
          const layouts = tracks.venueOf(id)?.layouts.length ?? 1;
          return layouts > 1 && t.layout ? `${t.name} · ${t.layout}` : t.name;
        };
        // The first car on that vehicle model, as the boards name it (not carForVehicle: it falls back to another car)
        const car: Namer = (id) => cars.CARS.find((c) => c.physics === id)?.title ?? id;
        setNames({ circuit, car });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return names;
}

/** Tabs with the game in view right now (the public GET /api/stats, kept 30 s at the edge), read again every 30 s while this tab is in view; null when off */
function useLiveCount(): number | null | undefined {
  const [live, setLive] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    const url = onlineUrl("/stats");
    if (!url) {
      setLive(null);
      return;
    }
    let alive = true;
    const read = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const body = (await (await fetch(url, { credentials: "omit" })).json()) as { live?: unknown };
        if (alive) setLive(typeof body.live === "number" ? body.live : null);
      } catch {
        if (alive) setLive(null);
      }
    };
    void read();
    const timer = setInterval(read, 30_000);
    const shown = () => void read();
    document.addEventListener("visibilitychange", shown);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, []);
  return live;
}

/** This page's own build (the deployed commit, from the lc-build meta tag); none on a local build */
function usePageBuild(): string | null {
  const [build, setBuild] = useState<string | null>(null);
  useEffect(() => setBuild(document.querySelector('meta[name="lc-build"]')?.getAttribute("content") || null), []);
  return build;
}

const SECTIONS = [
  { id: "summary", name: "Summary" },
  { id: "days", name: "Days" },
  { id: "driving", name: "Driving" },
  { id: "sessions", name: "Sessions" },
  { id: "builds", name: "Builds" },
  { id: "drivers", name: "Drivers" },
  { id: "accounts", name: "Accounts" },
  { id: "boards", name: "Boards" },
  { id: "races", name: "Races" },
  { id: "awards", name: "Badges" },
  { id: "site", name: "Site" },
] as const;

type CloudflareState = { state: "loading" } | { state: "off" } | { state: "error" } | { state: "ok"; stats: CloudflareStats };

export function Dashboard({ adminKey, initial, initialDays, onForget }: { adminKey: string; initial: StatsBody; initialDays: number; onForget: () => void }) {
  const [stats, setStats] = useState(initial);
  /** When the shown numbers arrived: "Starts in …" counts from here */
  const [statsAtMs, setStatsAtMs] = useState(() => Date.now());
  /** A range asked for and not in yet */
  const [pending, setPending] = useState<Range | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [cloudflare, setCloudflare] = useState<CloudflareState>({ state: "loading" });
  const live = useLiveCount();
  const names = useNames();
  const pageBuild = usePageBuild();

  // The links to the parts land below the sticky bar, whatever its height (it wraps on a phone)
  const scrollRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = barRef.current;
    const scroller = scrollRef.current;
    if (!bar || !scroller || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      scroller.style.scrollPaddingTop = `${Math.ceil(bar.getBoundingClientRect().height) + 16}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  // Only the latest request may land: a slow answer for a range left behind must not replace the one now chosen
  const requestRef = useRef(0);
  const pickRange = async (range: Range) => {
    const request = ++requestRef.current;
    setPending(range);
    setMessage(null);
    const read = await readAdmin<StatsBody>(`/admin/stats?days=${range}`, adminKey);
    if (request !== requestRef.current) return;
    setPending(null);
    if (read.state === "ok") {
      setStats(read.body);
      setStatsAtMs(Date.now());
    } else {
      setMessage(read.state === "busy" ? "Too many requests in a minute. Wait, then pick the range again." : "The numbers could not be read. Try again in a moment.");
    }
  };

  // Cloudflare's numbers cover the last 7 days whatever the range, so they are read once, after the key opened the page
  useEffect(() => {
    let alive = true;
    void readAdmin<CloudflareStats>("/admin/cloudflare", adminKey).then((r) => {
      if (!alive) return;
      // The key opened the numbers, so a 404 here means no analytics token on the Worker
      setCloudflare(r.state === "ok" ? { state: "ok", stats: r.body } : r.state === "refused" ? { state: "off" } : { state: "error" });
    });
    return () => {
      alive = false;
    };
  }, [adminKey]);

  const shownDays = pending ?? (RANGES.includes(stats.days as Range) ? (stats.days as Range) : (initialDays as Range));

  return (
    <SitePage
      scrollRef={scrollRef}
      id="admin-scroll"
      className="motion-safe:scroll-smooth"
      action={
        <Button variant="secondary" size="sm" icon={<Icon name="locked" />} onClick={onForget}>
          Lock
        </Button>
      }
    >
      <div className="flex flex-col gap-8">
        <div ref={barRef} className="sticky top-0 z-10 -mx-4 flex flex-col gap-3 border-b border-lc-line bg-lc-void/95 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented
              aria-label="Range"
              size="sm"
              value={String(shownDays)}
              onChange={(id) => void pickRange(Number(id) as Range)}
              options={RANGES.map((r) => ({ id: String(r), label: `${r} days` }))}
            />
            <p className="lc-data m-0 text-[13px] font-medium text-lc-slate" aria-live="polite">
              {pending ? "Loading…" : `${dayLabel(stats.from)} – ${dayLabel(stats.to)} (UTC)`}
            </p>
          </div>
          <nav aria-label="Parts of the page" className="-mx-2 flex overflow-x-auto whitespace-nowrap [scrollbar-width:none] sm:flex-wrap">
            {SECTIONS.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="inline-flex min-h-8 items-center rounded-full px-2 text-[14px] font-medium text-lc-slate no-underline transition-colors duration-200 hover:text-lc-chalk pointer-coarse:min-h-11"
              >
                {s.name}
              </a>
            ))}
          </nav>
        </div>
        {message ? (
          <p role="alert" className="m-0 flex items-start gap-2 text-[14px] font-medium text-lc-loss">
            <Icon name="error" className="mt-0.5" />
            {message}
          </p>
        ) : null}
        {/* A range on its way keeps the numbers in hand, dimmed, instead of a blank page */}
        <div className={pending ? "opacity-60 transition-opacity duration-200" : "transition-opacity duration-200"} aria-busy={pending !== null}>
          <Numbers stats={stats} nowMs={statsAtMs} names={names} cloudflare={cloudflare} live={live} pageBuild={pageBuild} adminKey={adminKey} />
        </div>
      </div>
    </SitePage>
  );
}

/** "in 12 min", "in 1 h 5 min", "now" */
function startsIn(startsMs: number, nowMs: number): string {
  const min = Math.round((startsMs - nowMs) / 60_000);
  if (min <= 0) return "now";
  return min >= 60 ? `in ${Math.floor(min / 60)} h ${min % 60} min` : `in ${min} min`;
}

const minutesOf = (rows: UsageGroup[]) => rows.reduce((n, r) => n + r.minutes, 0);
const sessionsOf = (rows: { sessions: number }[]) => rows.reduce((n, r) => n + r.sessions, 0);
const countsOf = (rows: Count[]) => rows.reduce((n, r) => n + r.n, 0);
const avgOf = (r: UsageGroup) => (r.sessions > 0 ? r.minutes / r.sessions : 0);
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** A circuit's name, with a "Removed" badge when the game no longer has it */
function CircuitName({ id, name, removed }: { id: string; name: string; removed: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2" title={id}>
      <span className="min-w-0 truncate">{name}</span>
      {removed ? (
        <Badge tone="warn" size="sm" icon="warning">
          Removed
        </Badge>
      ) : null}
    </span>
  );
}

/** "c31ac20 and 8e2edf9", "a, b and c" */
const andList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/** A day of the builds chart: its split, and what the readout says about it (build-days.ts decides what is replaced) */
function splitOf(d: BuildDay, firstDay: string): SplitDay {
  if (d.total === 0) return { day: d.day, fresh: 0, stale: 0, readout: `${dayLabel(d.day)}: no builds sent` };
  const parts = d.builds.slice(0, 3).map((b) => `${b.build} ${percent(b.sessions, d.total)}`);
  const more = d.builds.length > 3 ? `, ${d.builds.length - 3} more` : "";
  const replaced = d.builds.filter((b) => b.replaced).map((b) => b.build);
  // The range's first day shows every build as first seen there when they came before it: say nothing of new ones then
  const fresh = d.day !== firstDay && d.fresh.length ? `; first seen that day: ${andList(d.fresh)}` : "";
  const behind = d.replaced > 0 ? `; ${percent(d.replaced, d.total)} still on a build replaced before that day (${andList(replaced)})` : "";
  return { day: d.day, fresh: d.total - d.replaced, stale: d.replaced, readout: `${dayLabel(d.day)}: ${count(d.total)} sessions, ${parts.join(", ")}${more}${fresh}${behind}` };
}

function Numbers({
  stats,
  nowMs,
  names,
  cloudflare,
  live,
  pageBuild,
  adminKey,
}: {
  stats: StatsBody;
  nowMs: number;
  names: { circuit: Namer; car: Namer };
  cloudflare: CloudflareState;
  live: number | null | undefined;
  pageBuild: string | null;
  adminKey: string;
}) {
  const { totals, previous, board, races, extras } = stats;
  const raceCount = races ? races.open + races.room : 0;
  const overall = totals.sessions > 0 ? totals.minutes / totals.sessions : 0;
  const removed = new Set(stats.retired.map((r) => r.id));
  const circuitName = (id: string) => <CircuitName id={id} name={names.circuit(id)} removed={removed.has(id)} />;

  // The days of the range; the last is today, still counting
  const dayRows = everyDay(stats.from, stats.to, stats.perDay, (day) => ({ day, sessions: 0, minutes: 0, laps: 0, countries: 0 }));
  const days = dayRows.map((d) => d.day);
  const byDay = (rows: Count[]) => {
    const m = new Map(rows.map((r) => [r.id, r.n]));
    return days.map((d) => m.get(d) ?? 0);
  };
  const firstLapDay = dayRows.find((d) => d.laps > 0)?.day ?? null;
  const trendRows: TrendRow[] = [
    { id: "sessions", name: "Sessions", values: dayRows.map((d) => d.sessions), format: count, total: count(totals.sessions) },
    { id: "hours", name: "Hours driven", values: dayRows.map((d) => d.minutes), format: (m) => `${hours(m)} h`, total: `${hours(totals.minutes)} h` },
    { id: "countries", name: "Countries", values: dayRows.map((d) => d.countries), format: count, total: count(stats.countries) },
    { id: "board", name: "Board times", values: byDay(board.lapsPerDay), format: count, total: count(board.lapsInRange) },
    { id: "names", name: "New names", values: byDay(board.namesPerDay), format: count, total: count(board.driversNew) },
    ...(stats.lapsCounted ? [{ id: "laps", name: "Laps driven", values: dayRows.map((d) => d.laps), format: count, total: count(totals.laps) }] : []),
  ];

  // Average hours on each weekday (Monday first), over the weekdays the range covers
  const weekday = WEEKDAYS.map((name, i) => {
    const these = dayRows.filter((d) => (new Date(`${d.day}T00:00:00Z`).getUTCDay() + 6) % 7 === i);
    const minutes = these.length ? these.reduce((n, d) => n + d.minutes, 0) / these.length : 0;
    return { name, label: name.slice(0, 3), value: minutes, readout: `${name}: ${hours(minutes)} h on average` };
  });
  const busiest = weekday.reduce((a, b) => (b.value > a.value ? b : a), weekday[0]);

  const circuitRows = stats.byCircuit.map((c) => ({
    id: c.id,
    name: circuitName(c.id),
    minutes: c.minutes,
    sessions: c.sessions,
    modes: stats.circuitModes.filter((m) => m.trackId === c.id).map((m) => ({ mode: m.mode, minutes: m.minutes })),
  }));
  const hourRows = (rows: UsageGroup[], name: Namer) => rows.map((r) => ({ id: r.id, name: name(r.id), value: r.minutes, shown: `${hours(r.minutes)} h`, extra: `${count(r.sessions)} sessions` }));

  const retiredSessions = stats.retired.reduce((n, r) => n + r.sessions, 0);
  const lastRetired = stats.retired.reduce((d, r) => (r.lastDay > d ? r.lastDay : d), "");

  // How long sessions last: one scale for every list in the section, so their bars compare
  const averageRows = (rows: UsageGroup[], name: Namer) => rows.map((r) => ({ id: r.id, name: name(r.id), sessions: r.sessions, minutes: r.minutes }));
  const allAverages = [...(extras ? [...extras.device, ...extras.input, ...extras.assists, ...extras.weather] : []), ...stats.byMode].filter((r) => r.sessions >= 20).map(avgOf);
  const scale = Math.max(overall * 1.5, ...allAverages) * 1.05;
  const device = (id: string) => extras?.device.find((d) => d.id === id);
  const phone = device("phone");
  const desktop = device("desktop");
  const extrasSessions = extras ? sessionsOf(extras.input) : 0;
  const sessionTable = (rows: UsageGroup[], name: (id: string) => ReactNode, title: Namer) =>
    [...rows]
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 12)
      .map((r) => ({ key: r.id, title: title(r.id), cells: [name(r.id), count(r.sessions), perSession(r.minutes, r.sessions), hours(r.minutes)] }));

  // Builds: each day's split. A deploy day always splits between the build before and the new one (usage is per UTC
  // day), so a build counts as replaced only on the days after a newer one was first seen (build-days.ts)
  const builtDays = buildDays(stats.builds?.perDay ?? [], stats.builds?.firstSeen ?? [], days);
  const split = builtDays.map((d) => splitOf(d, stats.from));
  const withBuilds = builtDays.map((d, i) => (d.total > 0 ? i : -1)).filter((i) => i >= 0);
  // The latest whole day with builds; today (still counting) only when it is the one day there is
  const defaultBuildDay = withBuilds.filter((i) => i < days.length - 1).pop() ?? withBuilds.pop() ?? null;
  const buildDay = defaultBuildDay === null ? null : builtDays[defaultBuildDay];
  const replacedTop = buildDay?.builds.find((b) => b.replaced) ?? null;
  const today = builtDays[builtDays.length - 1];
  const todayReplaced = today && today !== buildDay && today.replaced > 0 ? today : null;
  const recentBuildDays = builtDays.filter((d) => d.total > 0).slice(-5).reverse();
  const firstSeen = new Map((stats.builds?.firstSeen ?? []).map((b) => [b.build, b.day]));
  const buildTotals = new Map<string, number>();
  for (const r of stats.builds?.perDay ?? []) buildTotals.set(r.build, (buildTotals.get(r.build) ?? 0) + r.sessions);
  const buildSessions = [...buildTotals.values()].reduce((n, v) => n + v, 0);

  const awayFrom = races ? races.cars - races.dnf : 0;
  const humanModes = stats.byMode.filter((m) => m.id === "ai_race" || m.id === "open_race" || m.id === "room_race");

  return (
    <div className="flex flex-col gap-12">
      <Section
        id="summary"
        title="Summary"
        intro={
          <>
            In these {stats.days} days people drove <b className="text-lc-chalk">{hours(totals.minutes)} hours</b> over{" "}
            <b className="text-lc-chalk">{count(totals.sessions)} sessions</b> from {count(stats.countries)} countries.
            {stats.byCircuit[0] ? (
              <>
                {" "}The most-driven circuit was <b className="text-lc-chalk">{names.circuit(stats.byCircuit[0].id)}</b>
                {stats.byCar[0] ? (
                  <>
                    {" "}and the most-driven car the <b className="text-lc-chalk">{names.car(stats.byCar[0].id)}</b>
                  </>
                ) : null}
                .
              </>
            ) : null}{" "}
            {count(board.lapsInRange)} board times were set{races ? `, ${count(raceCount)} races were run` : ""} and {count(board.driversNew)} new driver names were
            claimed.
          </>
        }
      >
        <Tiles three>
          <Tile
            live={typeof live === "number"}
            label="Driving now"
            value={live === undefined ? "…" : live === null ? "–" : count(live)}
            note={live === null ? "The live count is off" : "Tabs with the game in view, read every 30 s"}
          />
          {stats.live ? (
            <Tile label="Waiting for the next race" value={count(stats.live.waiting)} note={`It starts ${startsIn(stats.live.startsMs, nowMs)}`} />
          ) : (
            <Tile label="Board times set" value={count(board.lapsInRange)} note="Still standing on the boards" />
          )}
          <Tile label="Hours driven" value={hours(totals.minutes)} trend={change(totals.minutes, previous.minutes)} note="Nothing to compare with yet" />
          <Tile label="Sessions" value={count(totals.sessions)} trend={change(totals.sessions, previous.sessions)} note="Nothing to compare with yet" />
          <Tile
            label="Minutes a session"
            value={overall.toFixed(1)}
            note={phone && desktop ? `Phone ${perSession(phone.minutes, phone.sessions)}, desktop ${perSession(desktop.minutes, desktop.sessions)}` : "A session is one stretch of driving"}
          />
          <Tile label="Countries" value={count(stats.countries)} note="Where the driving came from" />
        </Tiles>
      </Section>

      <Section id="days" title="Days" intro="Each row on its own scale. Point at a day, tap it or use the arrow keys for its numbers. Today is still counting.">
        <Card>
          <TrendChart days={days} rows={trendRows} partialLast label={`Numbers per day, ${dayLabel(stats.from)} to ${dayLabel(stats.to)}`} />
          {!stats.lapsCounted ? (
            <p className={NOTE}>Laps driven show once the database has migration 0006 (the deploy applies it).</p>
          ) : firstLapDay && firstLapDay > stats.from ? (
            <p className={NOTE}>Laps driven are counted from {dayLabel(firstLapDay)}: older builds send none.</p>
          ) : !firstLapDay ? (
            <p className={NOTE}>No build has sent laps driven yet.</p>
          ) : null}
        </Card>
      </Section>

      <Section id="driving" title="Driving" intro="Where, when and in what people drive.">
        <Card title="Circuits" aside="Hours, each bar split by mode">
          <ModeSplitList rows={circuitRows} />
        </Card>
        {stats.retired.length ? (
          <Card title="Circuits no longer in the game" aside="Driven on old builds, or ids that never were a circuit">
            <Caution>
              {count(retiredSessions)} sessions ({percent(retiredSessions, totals.sessions)}) ran one of these, the last on {dayLabel(lastRetired)}.
            </Caution>
            <NumberTable
              head={["Circuit id", "Sessions", "Hours", "Last seen"]}
              rows={stats.retired.slice(0, 15).map((r) => ({ key: r.id, title: r.id, cells: [r.id, count(r.sessions), hours(r.minutes), dayLabel(r.lastDay)] }))}
            />
            <p className="lc-hint m-0">
              Sessions a day:{" "}
              {stats.retiredPerDay.map((d, i) => (
                // The separator outside the unbroken day, so a narrow screen wraps between days
                <span key={d.day}>
                  {i > 0 ? " · " : ""}
                  <span className="lc-data whitespace-nowrap text-lc-fog">
                    {dayLabel(d.day)} {count(d.sessions)}
                  </span>
                </span>
              ))}
            </p>
          </Card>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Cars" aside="Hours · sessions">
            <RankList rows={hourRows(stats.byCar, names.car)} />
          </Card>
          <Card title="Countries" aside={`Hours · sessions; ${count(stats.countries)} in all`}>
            <RankList rows={hourRows(stats.byCountry, countryName)} />
          </Card>
          <Card title="Modes" aside="Hours · sessions">
            <RankList rows={hourRows(stats.byMode, modeName)} />
          </Card>
          <Card title="Busiest day of the week" aside={busiest.value > 0 ? `${busiest.name}, on average` : undefined}>
            <BarChart label="Average hours driven on each day of the week" unit="Hours" bars={weekday} height={110} />
          </Card>
        </div>
      </Section>

      <Section
        id="sessions"
        title="Sessions"
        intro={
          <>
            Minutes a session, and how many sessions. The tick on each bar is the average over all of them,{" "}
            <b className="text-lc-chalk">{overall.toFixed(1)} min</b>.
            {phone && desktop && phone.sessions > 0 && desktop.sessions > 0 ? (
              <>
                {" "}A session on a phone lasts <b className="text-lc-chalk">{perSession(phone.minutes, phone.sessions)} min</b>, on a desktop{" "}
                <b className="text-lc-chalk">{perSession(desktop.minutes, desktop.sessions)}</b>.
              </>
            ) : null}
            {extras ? <> Screen, input, assists and weather come from newer builds only: {percent(extrasSessions, totals.sessions)} of the sessions.</> : null}
          </>
        }
      >
        {extras ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Card title="Screen">
              <AverageList rows={averageRows(extras.device, settingName)} scale={scale} overall={overall} />
            </Card>
            <Card title="Input">
              <AverageList rows={averageRows(extras.input, settingName)} scale={scale} overall={overall} />
            </Card>
          </div>
        ) : (
          <p className={NOTE}>Screen, input, assists and weather show once the database has migration 0004.</p>
        )}
        <div className="grid gap-4 md:grid-cols-3">
          <Card title="Mode">
            <AverageList rows={averageRows(stats.byMode, modeName)} scale={scale} overall={overall} />
          </Card>
          {extras ? (
            <>
              <Card title="Assists">
                <AverageList rows={averageRows(extras.assists, settingName)} scale={scale} overall={overall} />
              </Card>
              <Card title="Weather">
                <AverageList rows={averageRows(extras.weather, settingName)} scale={scale} overall={overall} />
              </Card>
            </>
          ) : null}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Circuits" aside="Most sessions first">
            <NumberTable head={["Circuit", "Sessions", "Min", "Hours"]} rows={sessionTable(stats.byCircuit, circuitName, names.circuit)} />
          </Card>
          <Card title="Cars" aside="Most sessions first">
            <NumberTable head={["Car", "Sessions", "Min", "Hours"]} rows={sessionTable(stats.byCar, names.car, names.car)} />
          </Card>
        </div>
      </Section>

      <Section
        id="builds"
        title="Builds"
        intro={
          !stats.builds ? (
            "Builds show once the database has migration 0004."
          ) : !buildDay ? (
            "No build was sent in this range. Local builds send none."
          ) : (
            <>
              {buildDay.replaced > 0 && replacedTop ? (
                <>
                  On {dayLabel(buildDay.day)}, <b className="text-lc-chalk">{percent(buildDay.replaced, buildDay.total)}</b> of {count(buildDay.total)} sessions still
                  ran a build replaced before that day. Most of them ran <b className="lc-data text-lc-chalk">{replacedTop.build}</b>, first seen{" "}
                  {dayLabel(replacedTop.firstSeen)}: {count(replacedTop.sessions)} sessions.
                </>
              ) : buildDay.fresh.length > 0 && buildDay.day !== stats.from ? (
                <>
                  On {dayLabel(buildDay.day)} {andList(buildDay.fresh)} {buildDay.fresh.length === 1 ? "was" : "were"} first seen. Usage is counted per UTC day,
                  so a deploy day splits between the build before it and the new one, and neither counts as behind.
                </>
              ) : (
                <>On {dayLabel(buildDay.day)} no session ran a build replaced before that day.</>
              )}
              {todayReplaced ? (
                <>
                  {" "}Today so far, {percent(todayReplaced.replaced, todayReplaced.total)} of sessions still run a build replaced before today (
                  {andList(todayReplaced.builds.filter((b) => b.replaced).map((b) => b.build))}).
                </>
              ) : null}
            </>
          )
        }
      >
        {stats.builds && buildDay ? (
          <>
            <Card
              title="Sessions on a replaced build"
              aside="Share of each day's sessions. A build counts as replaced from the day after a newer one is first seen: a deploy day splits between both builds"
            >
              <SplitChart days={split} partialLast defaultDay={defaultBuildDay} label="Share of sessions on a build replaced before that day, per day" />
            </Card>
            <Card title="Builds per day" aside="The last days with builds, newest first">
              <div className="flex flex-col gap-5">
                {recentBuildDays.map((d) => (
                  <NumberTable
                    key={d.day}
                    head={[`${dayLabel(d.day)}${d.day === stats.to ? ", so far" : ""}`, "First seen", "Sessions", "Share"]}
                    rows={d.builds.map((b) => ({
                      key: b.build,
                      title: b.build,
                      cells: [
                        <span key="b" className="flex flex-col items-start gap-1">
                          <span className="lc-data text-lc-chalk">{b.build}</span>
                          {b.replaced ? (
                            <Badge size="sm" tone="warn" icon="warning">
                              Replaced
                            </Badge>
                          ) : null}
                        </span>,
                        dayLabel(b.firstSeen),
                        count(b.sessions),
                        percent(b.sessions, d.total),
                      ],
                    }))}
                  />
                ))}
              </div>
            </Card>
            <Card title="Builds" aside="Newest first">
              <NumberTable
                head={["Build", "First seen", "Sessions", "Share"]}
                rows={[...buildTotals]
                  .sort(([a], [b]) => (firstSeen.get(b) ?? "").localeCompare(firstSeen.get(a) ?? "") || (buildTotals.get(b) ?? 0) - (buildTotals.get(a) ?? 0))
                  .map(([build, n]) => ({
                    key: build,
                    title: build,
                    cells: [
                      <span key="b" className="flex flex-col">
                        <span className="lc-data text-lc-chalk">{build}</span>
                        {build === pageBuild ? <span className="lc-hint">This page&rsquo;s build</span> : null}
                      </span>,
                      dayLabel(firstSeen.get(build) ?? stats.from),
                      count(n),
                      percent(n, buildSessions),
                    ],
                  }))}
              />
            </Card>
          </>
        ) : null}
      </Section>

      <Section id="drivers" title="Drivers" intro="Names claimed on the boards. A name is seen when it uploads a lap.">
        <Tiles>
          <Tile label="Names claimed" value={count(board.drivers)} note="All time" />
          <Tile label="New names" value={count(board.driversNew)} note="First claimed in the range" />
          <Tile label="Seen in the range" value={count(board.driversActive)} note={`${count(board.driversReturning)} of them claimed before it`} />
          <Tile label="Came back" value={count(board.cameBack)} note={`${percent(board.cameBack, board.cameBackOf)} uploaded again a day or more after the claim`} />
        </Tiles>
      </Section>

      <AccountsSection accounts={stats.accounts ?? null} />

      <Section id="boards" title="Boards" intro="A newer best replaces the older one, so these are the times still standing, by the day each was set.">
        <Tiles>
          <Tile label="Times on the boards" value={count(board.laps)} note="All time" />
          <Tile label="Times set" value={count(board.lapsInRange)} note="In the range, still standing" />
          <Tile label="Boards with times" value={count(board.boards.length)} note={board.boards.length >= 50 ? "The 50 busiest" : "Circuit, car and physics"} />
          <Tile label="Weekly challenges" value={count(board.challenges.length)} note="With times on their board" />
        </Tiles>
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Assists" aside="Times set in the range">
            <ShareList rows={board.lapsBy.assists.map((r) => ({ id: r.id, value: r.n }))} total={countsOf(board.lapsBy.assists)} unit={count} />
          </Card>
          <Card title="Realism" aside="Times set in the range">
            <ShareList rows={board.lapsBy.realism.map((r) => ({ id: r.id, value: r.n }))} total={countsOf(board.lapsBy.realism)} unit={count} />
          </Card>
          <Card title="Track" aside="Times set in the range">
            <ShareList rows={board.lapsBy.surface.map((r) => ({ id: r.id, value: r.n }))} total={countsOf(board.lapsBy.surface)} unit={count} />
          </Card>
          <Card title="Tyres" aside="Times set in the range">
            <ShareList rows={board.lapsBy.compound.map((r) => ({ id: r.id, value: r.n }))} total={countsOf(board.lapsBy.compound)} unit={count} />
          </Card>
        </div>
        <Card title="By class" aside="Assists, realism and track together, times set in the range">
          <NumberTable
            head={["Assists", "Realism", "Track", "Times", "Share"]}
            rows={board.lapsByClass.map((c) => ({
              key: `${c.assists}/${c.realism}/${c.surface}`,
              cells: [settingName(c.assists), settingName(c.realism), settingName(c.surface), count(c.n), percent(c.n, board.lapsInRange)],
            }))}
          />
        </Card>
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Busiest boards" aside="Times · drivers, all time">
            <RankList
              rows={board.boards.map((b) => ({
                id: `${b.trackId}/${b.vehicle}/${b.physics}/${b.event}`,
                name: `${names.circuit(b.trackId)} · ${names.car(b.vehicle)}${b.event ? ` · ${weekLabel(b.event)}` : ""}`,
                value: b.laps,
                shown: count(b.laps),
                extra: `${count(b.drivers)} ${b.drivers === 1 ? "driver" : "drivers"}`,
              }))}
              empty="No times on the boards yet."
            />
          </Card>
          <Card title="Most times set" aside="In the range">
            <NumberTable head={["Driver", "Times", "Boards"]} rows={board.topDrivers.map((d) => ({ key: d.name, cells: [d.name, count(d.laps), count(d.boards)] }))} />
          </Card>
        </div>
        <Card title="Weekly challenges" aside="Newest first, all time">
          <NumberTable
            head={["Week", "Times", "Drivers"]}
            rows={board.challenges.map((c) => ({ key: c.event, cells: [weekLabel(c.event), count(c.laps), count(c.drivers)] }))}
            empty="No challenge times yet."
          />
        </Card>
      </Section>

      <Section id="races" title="Races" intro={races ? "Open races finished in the range. Room races aren't stored." : "Race results show once the database has migration 0002."}>
        {races ? (
          <>
            <Tiles>
              <Tile label="Races run" value={count(raceCount)} note={races.room > 0 ? `${count(races.open)} open, ${count(races.room)} room` : "Open races"} />
              <Tile label="Cars a race" value={raceCount > 0 ? (races.cars / raceCount).toFixed(1) : "–"} note={raceCount > 0 ? `${races.fieldMin} to ${races.fieldMax} on a grid` : "No grids yet"} />
              <Tile label="Finished" value={percent(awayFrom, races.cars)} note={`${count(races.dnf)} of ${count(races.cars)} cars did not finish`} />
              <Tile label="Proven names" value={count(races.proven)} note={`Of ${count(races.cars)} cars; ${count(races.drivers)} different drivers`} />
            </Tiles>
            <div className="grid gap-4 md:grid-cols-2">
              <Card title="Races per day">
                <BarChart
                  label="Open races finished per day"
                  unit="Races"
                  height={110}
                  partialLast
                  bars={everyDay(stats.from, stats.to, races.perDay, (day) => ({ day, races: 0, cars: 0, dnf: 0 })).map((d) => ({
                    label: dayLabel(d.day),
                    value: d.races,
                    readout: `${dayLabel(d.day)}: ${count(d.races)} ${d.races === 1 ? "race" : "races"}, ${count(d.cars)} cars, ${count(d.dnf)} did not finish`,
                  }))}
                />
              </Card>
              <Card title="Against AI or people" aside="Racing sessions, hours · sessions">
                <RankList rows={hourRows(humanModes, modeName)} empty="No racing in this range." />
                <p className="lc-hint m-0">Open races have no AI cars: every car on their grids is a player. Races against AI run in the browser and show only here.</p>
              </Card>
              <Card title="Races per week" aside="Newest first">
                <NumberTable head={["Week", "Races", "Cars"]} rows={[...races.perWeek].reverse().map((w) => ({ key: w.week, cells: [weekLabel(w.week), count(w.races), count(w.cars)] }))} />
              </Card>
              <Card title="Where they ran">
                <RankList
                  rows={races.byCircuit.map((r) => ({ id: `${r.trackId}/${r.vehicle}`, name: `${names.circuit(r.trackId)} · ${names.car(r.vehicle)}`, value: r.races, shown: count(r.races) }))}
                />
              </Card>
            </div>
            <Card title="Drivers" aside="Most wins, then podiums">
              <NumberTable head={["Driver", "Wins", "Podiums", "Starts"]} rows={races.topDrivers.map((d) => ({ key: d.name, cells: [d.name, count(d.wins), count(d.podiums), count(d.races)] }))} />
            </Card>
          </>
        ) : null}
      </Section>

      <AwardsSection adminKey={adminKey} />

      <SiteSection cloudflare={cloudflare} />
    </div>
  );
}

/** Player accounts: counts only, nothing about anyone */
function AccountsSection({ accounts }: { accounts: StatsBody["accounts"] }) {
  if (!accounts) {
    return (
      <Section id="accounts" title="Accounts" intro="Accounts are off, or their database isn't set up yet.">
        {null}
      </Section>
    );
  }
  const ways = [
    { id: "discord", name: "Discord", value: accounts.byProvider.discord },
    { id: "google", name: "Google", value: accounts.byProvider.google },
    { id: "steam", name: "Steam", value: accounts.byProvider.steam },
    { id: "passkey", name: "Passkey", value: accounts.byProvider.passkey },
  ]
    .sort((a, b) => b.value - a.value)
    .map((w) => ({ ...w, shown: count(w.value), extra: percent(w.value, accounts.total) }));
  return (
    <Section id="accounts" title="Accounts" intro="Player accounts, all time. No email or user name is kept, so these are counts only.">
      <Tiles three>
        <Tile label="Accounts" value={count(accounts.total)} note="All time" />
        <Tile label="New accounts" value={count(accounts.last7d)} note="In the last 7 days" />
        <Tile label="With a cloud save" value={count(accounts.withSave)} note={`${percent(accounts.withSave, accounts.total)} of the accounts`} />
      </Tiles>
      <Card title="Ways in" aside="Accounts with each; one with two counts under both">
        <RankList rows={ways} empty="No accounts yet." />
      </Card>
    </Section>
  );
}

function SiteSection({ cloudflare }: { cloudflare: CloudflareState }) {
  if (cloudflare.state !== "ok") {
    const intro =
      cloudflare.state === "loading"
        ? "Reading Cloudflare's numbers…"
        : cloudflare.state === "error"
          ? "Cloudflare's numbers could not be read. Try again in a moment."
          : "Cloudflare's own numbers for the site (visitors, requests, database and storage) show here once the Worker has an analytics token.";
    return (
      <Section id="site" title="Site" intro={intro}>
        {cloudflare.state === "off" ? (
          <Card>
            <ol className="lc-body m-0 flex list-decimal flex-col gap-2 ps-5 leading-relaxed">
              <li>
                In the Cloudflare dashboard, create an API token with <b className="text-lc-chalk">Account Analytics: Read</b> (and{" "}
                <b className="text-lc-chalk">Zone Analytics: Read</b> for the site’s visitors).
              </li>
              <li>
                Run <code className="lc-data text-lc-chalk">npx wrangler secret put CF_ANALYTICS_TOKEN</code> and paste it.
              </li>
              <li>
                For visitors per day, add the domain’s zone id to <code className="lc-data text-lc-chalk">vars</code> in wrangler.jsonc as{" "}
                <code className="lc-data text-lc-chalk">ANALYTICS_ZONE_ID</code> and deploy.
              </li>
            </ol>
          </Card>
        ) : null}
      </Section>
    );
  }
  const cf = cloudflare.stats;
  const site = cf.site ?? [];
  const pageViews = site.reduce((n, d) => n + d.pageViews, 0);
  const requests = site.reduce((n, d) => n + d.requests, 0);
  const visitorsADay = site.length ? site.reduce((n, d) => n + d.visitors, 0) / site.length : 0;
  const sent = site.reduce((n, d) => n + d.bytes, 0);
  const cached = site.reduce((n, d) => n + d.cachedBytes, 0);
  return (
    <Section id="site" title="Site" intro={`From Cloudflare, for the last 7 days (${dayLabel(cf.from)} – ${dayLabel(cf.to)}) whatever the range above.`}>
      {cf.site ? (
        <>
          <Tiles>
            <Tile label="Visitors a day" value={count(visitorsADay)} note="Average; Cloudflare's count of addresses" />
            <Tile label="Page views" value={count(pageViews)} note="Pages, not files" />
            <Tile label="Requests" value={count(requests)} note="Every file the site served" />
            <Tile label="Served from cache" value={percent(cached, sent)} note={`${bytes(sent)} sent`} />
          </Tiles>
          <Card title="Visitors per day">
            <BarChart
              label="Visitors per day, from Cloudflare"
              unit="Visitors"
              height={110}
              bars={site.map((d) => ({ label: dayLabel(d.day), value: d.visitors, readout: `${dayLabel(d.day)}: ${count(d.visitors)} visitors, ${count(d.pageViews)} page views` }))}
            />
          </Card>
        </>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {cf.worker ? (
          <Card title="Worker" aside="The API and the large files">
            <NumberTable
              rows={[
                { key: "r", cells: ["Requests", count(cf.worker.requests)] },
                { key: "e", cells: ["Errors", `${count(cf.worker.errors)} (${percent(cf.worker.errors, cf.worker.requests)})`] },
                { key: "c", cells: ["CPU time, typical", `${cf.worker.cpuP50Ms} ms`] },
                { key: "p", cells: ["CPU time, slowest 1%", `${cf.worker.cpuP99Ms} ms`] },
              ]}
            />
          </Card>
        ) : null}
        {cf.d1 ? (
          <Card title="Database" aside="Boards, races and usage">
            <NumberTable
              rows={[
                { key: "rr", cells: ["Rows read", count(cf.d1.rowsRead)] },
                { key: "rw", cells: ["Rows written", count(cf.d1.rowsWritten)] },
                { key: "q", cells: ["Queries", count(cf.d1.readQueries + cf.d1.writeQueries)] },
                ...(cf.d1.sizeBytes !== null ? [{ key: "s", cells: ["Size", bytes(cf.d1.sizeBytes)] }] : []),
              ]}
            />
          </Card>
        ) : null}
        {cf.r2 ? (
          <Card title="Storage" aside="R2 buckets">
            <NumberTable
              head={["Bucket", "Files", "Size", "Requests"]}
              rows={cf.r2.map((b) => ({
                key: b.bucket,
                cells: [b.bucket.replace(/^librecorsa-/, ""), b.objects === null ? "–" : count(b.objects), b.bytes === null ? "–" : bytes(b.bytes), b.requests === null ? "–" : count(b.requests)],
              }))}
            />
          </Card>
        ) : null}
        {cf.durableObjects ? (
          <Card title="Rooms and races" aside="Durable Objects">
            <NumberTable rows={[{ key: "r", cells: ["Requests", count(cf.durableObjects.requests)] }]} />
          </Card>
        ) : null}
      </div>
      {cf.problems.length ? (
        <details className={NOTE}>
          <summary className="inline-flex min-h-9 cursor-pointer items-center select-none hover:text-lc-chalk pointer-coarse:min-h-11">
            {cf.problems.length} {cf.problems.length === 1 ? "part" : "parts"} could not be read
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {cf.problems.map((p) => (
              <li key={p.part}>
                <span className="text-lc-fog">{p.part}:</span> {p.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}
