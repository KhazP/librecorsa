"use client";

/**
 * The owner's numbers (GET <api>/admin/stats, and Cloudflare's own at <api>/admin/cloudflare), laid out to be read top
 * to bottom: a summary in words, then driving, what it is driven with, drivers, boards, races and the site. The key is
 * asked for once and kept for this browser tab only (sessionStorage); it goes out only in the X-Admin-Key header.
 */
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { onlineUrl } from "@/lib/net/online-config";
import type { AdminStats as StatsBody, Count, UsageGroup } from "../../../cloudflare/api/admin";
import type { CloudflareStats } from "../../../cloudflare/api/analytics";
import {
  BarChart,
  bytes,
  Card,
  CARD,
  change,
  count,
  dayLabel,
  everyDay,
  hours,
  ModeSplitList,
  modeName,
  NOTE,
  NumberTable,
  percent,
  RankList,
  Section,
  ShareList,
  Tile,
  Tiles,
  weekLabel,
} from "./admin-ui";

const KEY_STORE = "librecorsa.adminKey";
const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

const readKey = (): string => {
  try {
    return sessionStorage.getItem(KEY_STORE) ?? "";
  } catch {
    return "";
  }
};
const keepKey = (key: string | null) => {
  try {
    if (key) sessionStorage.setItem(KEY_STORE, key);
    else sessionStorage.removeItem(KEY_STORE);
  } catch {
    // Not kept: asked again on the next visit
  }
};

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

/** Circuit and car names, loaded once there are numbers to name (the car list brings the sims with it) */
function useNames(active: boolean): { circuit: Namer; car: Namer } {
  const [names, setNames] = useState<{ circuit: Namer; car: Namer }>({ circuit: asIs, car: asIs });
  useEffect(() => {
    if (!active) return;
    let live = true;
    void Promise.all([import("@/lib/track-registry"), import("@/lib/cars/car-registry")])
      .then(([tracks, cars]) => {
        if (!live) return;
        const circuit: Namer = (id) => {
          const t = tracks.TRACKS.find((x) => x.id === id);
          if (!t) return id;
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
  }, [active]);
  return names;
}

const SECTIONS = [
  { id: "summary", name: "Summary" },
  { id: "driving", name: "Driving" },
  { id: "setups", name: "Setups" },
  { id: "drivers", name: "Drivers" },
  { id: "boards", name: "Boards" },
  { id: "races", name: "Races" },
  { id: "site", name: "Site" },
] as const;

type CloudflareState = { state: "loading" } | { state: "off" } | { state: "error" } | { state: "ok"; stats: CloudflareStats };

export function AdminStats() {
  const [key, setKey] = useState("");
  const [draft, setDraft] = useState("");
  const [days, setDays] = useState<Range>(30);
  const [stats, setStats] = useState<StatsBody | null>(null);
  /** When the shown numbers arrived: "Starts in …" counts from here */
  const [statsAtMs, setStatsAtMs] = useState(0);
  const [cloudflare, setCloudflare] = useState<CloudflareState>({ state: "loading" });
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const names = useNames(stats !== null);

  useEffect(() => setKey(readKey()), []);

  // The links to the parts land below the sticky bar, whatever its height (it wraps on a phone)
  const scrollRef = useRef<HTMLElement>(null);
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
  }, [key, stats !== null]);

  // Only the latest request may land: a slow answer for a range left behind must not replace the one now chosen
  const requestRef = useRef(0);
  const load = useCallback(async (adminKey: string, range: Range) => {
    const request = ++requestRef.current;
    const current = () => request === requestRef.current;
    const url = onlineUrl(`/admin/stats?days=${range}`);
    if (!url) {
      setState("error");
      setMessage("This build has no online side.");
      return;
    }
    setState("loading");
    setMessage(null);
    try {
      const res = await fetch(url, { headers: { "X-Admin-Key": adminKey }, credentials: "omit", cache: "no-store" });
      if (!current()) return;
      if (res.status === 404) {
        keepKey(null);
        setKey("");
        setStats(null);
        setState("error");
        setMessage("That key opens nothing here.");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as StatsBody;
      if (!current()) return;
      setStats(body);
      setStatsAtMs(Date.now());
      setState("idle");
    } catch {
      if (!current()) return;
      setState("error");
      setMessage("The numbers could not be read. Try again in a moment.");
    }
  }, []);

  // Cloudflare's numbers cover the last 7 days whatever the range, so they are read once per key
  const loadCloudflare = useCallback(async (adminKey: string) => {
    const url = onlineUrl("/admin/cloudflare");
    if (!url) return setCloudflare({ state: "off" });
    setCloudflare({ state: "loading" });
    try {
      const res = await fetch(url, { headers: { "X-Admin-Key": adminKey }, credentials: "omit", cache: "no-store" });
      // 404: no analytics token set on the Worker (or an older Worker)
      if (res.status === 404) return setCloudflare({ state: "off" });
      if (!res.ok) throw new Error(String(res.status));
      setCloudflare({ state: "ok", stats: (await res.json()) as CloudflareStats });
    } catch {
      setCloudflare({ state: "error" });
    }
  }, []);

  useEffect(() => {
    if (key) void load(key, days);
  }, [key, days, load]);
  useEffect(() => {
    if (key) void loadCloudflare(key);
  }, [key, loadCloudflare]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const k = draft.trim();
    if (!k) return;
    keepKey(k);
    setDraft("");
    setKey(k);
  };
  const forget = () => {
    keepKey(null);
    setKey("");
    setStats(null);
    setMessage(null);
  };

  return (
    // The body never scrolls (the game fills the screen), so this page scrolls itself
    <main ref={scrollRef} id="admin-scroll" className="h-dvh overflow-y-auto scroll-smooth bg-[#08090D] text-[#F5F7FA]">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-8 px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] sm:px-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <Link href="/" aria-label="LibreCorsa home" className="no-underline">
            <LibreCorsaLogo variant="compact" size="sm" />
          </Link>
          {key ? (
            <button type="button" onClick={forget} className="rounded-full border border-[#262B3D] px-4 py-2 text-[14px] text-[#8E96AA] transition-colors hover:border-[#3A4157] hover:text-[#F5F7FA]">
              Forget key
            </button>
          ) : null}
        </header>

        <section className="flex flex-col gap-3">
          <h1 className="lc-disp text-[clamp(36px,7vw,56px)] text-[#F5F7FA]">Numbers</h1>
          <p className="max-w-[680px] text-[15px] leading-relaxed text-[#C5CBD8]">
            How much people drive, where, in what and with what. The driving totals carry no player id. The drivers, boards and races
            parts count the names people race under, as the boards show them.
          </p>
        </section>

        {!key ? (
          <form onSubmit={submit} className={`${CARD} flex max-w-[480px] flex-col gap-3 p-5`}>
            <label htmlFor="admin-key" className="text-[14px] text-[#C5CBD8]">
              Admin key
            </label>
            <div className="flex gap-2">
              <input
                id="admin-key"
                type="password"
                autoComplete="off"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="lc-data min-w-0 flex-1 rounded-[12px] border border-[#262B3D] bg-[#08090D] px-3 py-2.5 text-[15px] text-[#F5F7FA] outline-none focus:border-[#CCFF00]"
              />
              <button type="submit" className="lc-title rounded-full bg-[#CCFF00] px-5 py-2.5 text-[15px] text-[#08090D] transition-colors hover:bg-[#99BF00]">
                Open
              </button>
            </div>
            <p className="text-[13px] text-[#8E96AA]">Kept in this tab only.</p>
            {message ? <p className="text-[14px] text-[#FF6B6B]">{message}</p> : null}
          </form>
        ) : (
          <>
            <div ref={barRef} className="sticky top-0 z-10 -mx-4 flex flex-col gap-2.5 border-b border-[#1A1E2A] bg-[#08090D]/95 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div role="radiogroup" aria-label="Range" className="inline-flex rounded-full border border-[#262B3D] bg-[#11131A] p-1">
                  {RANGES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      role="radio"
                      aria-checked={days === r}
                      onClick={() => setDays(r)}
                      className={`rounded-full px-4 py-1.5 text-[14px] transition-colors ${days === r ? "bg-[#CCFF00] font-semibold text-[#08090D]" : "text-[#8E96AA] hover:text-[#F5F7FA]"}`}
                    >
                      {r} days
                    </button>
                  ))}
                </div>
                <p className="text-[14px] text-[#8E96AA]" aria-live="polite">
                  {state === "loading" ? "Loading…" : stats ? `${dayLabel(stats.from)} – ${dayLabel(stats.to)} (UTC)` : ""}
                </p>
              </div>
              {stats ? (
                <nav aria-label="Parts of the page" className="flex gap-x-4 gap-y-1 overflow-x-auto whitespace-nowrap text-[14px] [scrollbar-width:none] sm:flex-wrap">
                  {SECTIONS.map((s) => (
                    <a key={s.id} href={`#${s.id}`} className="text-[#8E96AA] no-underline transition-colors hover:text-[#F5F7FA]">
                      {s.name}
                    </a>
                  ))}
                </nav>
              ) : null}
            </div>
            {message ? <p className="text-[14px] text-[#FF6B6B]">{message}</p> : null}
            {stats ? <Dashboard stats={stats} nowMs={statsAtMs} names={names} cloudflare={cloudflare} /> : null}
          </>
        )}
      </div>
    </main>
  );
}

/** "in 12 min", "in 1 h 5 min", "now" */
function startsIn(startsMs: number, nowMs: number): string {
  const min = Math.round((startsMs - nowMs) / 60_000);
  if (min <= 0) return "now";
  return min >= 60 ? `in ${Math.floor(min / 60)} h ${min % 60} min` : `in ${min} min`;
}

const minutesOf = (rows: UsageGroup[]) => rows.reduce((n, r) => n + r.minutes, 0);
const countsOf = (rows: Count[]) => rows.reduce((n, r) => n + r.n, 0);
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function Dashboard({ stats, nowMs, names, cloudflare }: { stats: StatsBody; nowMs: number; names: { circuit: Namer; car: Namer }; cloudflare: CloudflareState }) {
  const { totals, previous, board, races, extras } = stats;
  const perSession = totals.sessions > 0 ? totals.minutes / totals.sessions : 0;
  const countries = stats.byCountry.filter((c) => c.id !== "XX").length;
  const raceCount = races ? races.open + races.room : 0;

  const days = everyDay(stats.from, stats.to, stats.perDay, (day) => ({ day, sessions: 0, minutes: 0 }));
  // Average hours on each weekday (Monday first), over the weekdays the range covers
  const weekday = WEEKDAYS.map((name, i) => {
    const these = days.filter((d) => (new Date(`${d.day}T00:00:00Z`).getUTCDay() + 6) % 7 === i);
    const minutes = these.length ? these.reduce((n, d) => n + d.minutes, 0) / these.length : 0;
    return { name, label: name.slice(0, 3), value: minutes, readout: `${name}: ${hours(minutes)} h on average` };
  });
  const busiest = weekday.reduce((a, b) => (b.value > a.value ? b : a), weekday[0]);

  const circuitRows = stats.byCircuit.map((c) => ({
    id: c.id,
    name: names.circuit(c.id),
    minutes: c.minutes,
    sessions: c.sessions,
    modes: stats.circuitModes.filter((m) => m.trackId === c.id).map((m) => ({ mode: m.mode, minutes: m.minutes })),
  }));
  const hourRows = (rows: UsageGroup[], name: Namer) => rows.map((r) => ({ id: r.id, name: name(r.id), value: r.minutes, shown: `${hours(r.minutes)} h`, extra: `${count(r.sessions)} sessions` }));

  const extrasMinutes = extras ? minutesOf(extras.input) : 0;
  const share = (rows: UsageGroup[]) => rows.map((r) => ({ id: r.id, value: r.minutes }));
  const lapShare = (rows: Count[]) => rows.map((r) => ({ id: r.id, value: r.n }));
  const top = (rows: UsageGroup[]) => rows[0];

  return (
    <div className="flex flex-col gap-12">
      <Section
        id="summary"
        title="Summary"
        intro={
          <>
            In these {stats.days} days people drove <b className="text-[#F5F7FA]">{hours(totals.minutes)} hours</b> over{" "}
            <b className="text-[#F5F7FA]">{count(totals.sessions)} sessions</b>.
            {top(stats.byCircuit) ? (
              <>
                {" "}The most-driven circuit was <b className="text-[#F5F7FA]">{names.circuit(top(stats.byCircuit).id)}</b>
              </>
            ) : null}
            {top(stats.byCar) ? (
              <>
                {top(stats.byCircuit) ? " and the most-driven car the " : " The most-driven car was the "}
                <b className="text-[#F5F7FA]">{names.car(top(stats.byCar).id)}</b>
              </>
            ) : null}
            {top(stats.byCircuit) || top(stats.byCar) ? "." : null} {count(board.lapsInRange)} board times were set
            {races ? `, ${count(raceCount)} races were run` : ""} and {count(board.driversNew)} new driver names were claimed.
          </>
        }
      >
        <Tiles>
          <Tile label="Hours driven" value={hours(totals.minutes)} trend={change(totals.minutes, previous.minutes)} note="Nothing to compare with yet" />
          <Tile label="Sessions" value={count(totals.sessions)} trend={change(totals.sessions, previous.sessions)} note="Nothing to compare with yet" />
          <Tile label="Minutes a session" value={perSession.toFixed(1)} note="A session is one stretch of driving" />
          {stats.live ? (
            <Tile label="Next open race" value={`${count(stats.live.waiting)} waiting`} note={`Starts ${startsIn(stats.live.startsMs, nowMs)}`} />
          ) : (
            <Tile label="Countries" value={count(countries)} note="Where the driving came from" />
          )}
        </Tiles>
      </Section>

      <Section id="driving" title="Driving" intro="When, where, in what and how people drive. Hover or tap a bar for its numbers.">
        <Card title="Hours driven per day">
          <BarChart
            label={`Hours driven per day, ${dayLabel(stats.from)} to ${dayLabel(stats.to)}`}
            unit="Hours"
            bars={days.map((d) => ({ label: dayLabel(d.day), value: d.minutes, readout: `${dayLabel(d.day)}: ${hours(d.minutes)} h, ${count(d.sessions)} sessions` }))}
          />
        </Card>
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Busiest day of the week" aside={busiest.value > 0 ? busiest.name : undefined}>
            <BarChart label="Average hours driven on each day of the week" unit="Hours" bars={weekday} height={120} />
          </Card>
          <Card title="Modes" aside="Hours · sessions">
            <RankList rows={hourRows(stats.byMode, modeName)} />
          </Card>
        </div>
        <Card title="Circuits" aside="Each bar split by mode">
          <ModeSplitList rows={circuitRows} />
        </Card>
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Cars" aside="Hours · sessions">
            <RankList rows={hourRows(stats.byCar, names.car)} />
          </Card>
          <Card title="Countries" aside={`${count(countries)} countries`}>
            <RankList rows={hourRows(stats.byCountry, countryName)} />
          </Card>
        </div>
      </Section>

      <Section
        id="setups"
        title="Setups"
        intro={
          extras ? (
            <>
              What the driving was done with, as a share of the hours. Builds before this was added don&apos;t send it, so these cover{" "}
              <b className="text-[#F5F7FA]">{percent(extrasMinutes, totals.minutes)}</b> of the hours in the range.
            </>
          ) : (
            "What the driving was done with. This shows once the database has migration 0004 (the deploy applies it)."
          )
        }
      >
        {extras ? (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <Card title="Input">
                <ShareList rows={share(extras.input)} total={minutesOf(extras.input)} unit={(m) => `${hours(m)} h`} empty="Nothing sent yet." />
              </Card>
              <Card title="Screen">
                <ShareList rows={share(extras.device)} total={minutesOf(extras.device)} unit={(m) => `${hours(m)} h`} empty="Nothing sent yet." />
              </Card>
              <Card title="Assists">
                <ShareList rows={share(extras.assists)} total={minutesOf(extras.assists)} unit={(m) => `${hours(m)} h`} empty="Nothing sent yet." />
              </Card>
              <Card title="Weather">
                <ShareList rows={share(extras.weather)} total={minutesOf(extras.weather)} unit={(m) => `${hours(m)} h`} empty="Nothing sent yet." />
              </Card>
            </div>
            <Card title="Builds" aside="Commit the game was built from">
              <RankList
                rows={extras.build.map((b) => ({ id: b.id, name: b.id, value: b.minutes, shown: percent(b.minutes, minutesOf(extras.build)), extra: `${hours(b.minutes)} h` }))}
                empty="Nothing sent yet. Local builds send none."
              />
            </Card>
          </>
        ) : null}
      </Section>

      <Section id="drivers" title="Drivers" intro="Only drivers who claimed a name are counted here. The driving totals above carry no player id, so they can't say how many people drove.">
        <Tiles>
          <Tile label="Names claimed" value={count(board.drivers)} note="All time" />
          <Tile label="Names active" value={count(board.driversActive)} note="Seen on the boards in the range" />
          <Tile label="New names" value={count(board.driversNew)} note="First claimed in the range" />
          <Tile label="Returning names" value={count(board.driversReturning)} note="Claimed before, seen again" />
        </Tiles>
        <Card title="New names per day">
          <BarChart
            label="Driver names claimed per day"
            unit="Names"
            height={120}
            bars={everyDay(stats.from, stats.to, board.namesPerDay.map((d) => ({ day: d.id, n: d.n })), (day) => ({ day, n: 0 })).map((d) => ({
              label: dayLabel(d.day),
              value: d.n,
              readout: `${dayLabel(d.day)}: ${count(d.n)} ${d.n === 1 ? "name" : "names"}`,
            }))}
          />
        </Card>
      </Section>

      <Section
        id="boards"
        title="Boards"
        intro="A driver's newer best replaces their older one on a board, so these count the times still standing, by the day each was set. Older days shrink as people improve."
      >
        <Tiles>
          <Tile label="Times on the boards" value={count(board.laps)} note="All time" />
          <Tile label="Times set" value={count(board.lapsInRange)} note="In the range, still standing" />
          <Tile label="Boards with times" value={count(board.boards.length)} note={board.boards.length >= 50 ? "The 50 busiest" : "Circuit, car and physics"} />
          <Tile label="Weekly challenges" value={count(board.challenges.length)} note="With times on their board" />
        </Tiles>
        <Card title="Times set per day">
          <BarChart
            label="Board times set per day"
            unit="Times"
            height={120}
            bars={everyDay(stats.from, stats.to, board.lapsPerDay.map((d) => ({ day: d.id, n: d.n })), (day) => ({ day, n: 0 })).map((d) => ({
              label: dayLabel(d.day),
              value: d.n,
              readout: `${dayLabel(d.day)}: ${count(d.n)} ${d.n === 1 ? "time" : "times"}`,
            }))}
          />
        </Card>
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Assists" aside="Times set in the range">
            <ShareList rows={lapShare(board.lapsBy.assists)} total={countsOf(board.lapsBy.assists)} unit={(n) => count(n)} />
          </Card>
          <Card title="Realism" aside="Times set in the range">
            <ShareList rows={lapShare(board.lapsBy.realism)} total={countsOf(board.lapsBy.realism)} unit={(n) => count(n)} />
          </Card>
          <Card title="Track" aside="Times set in the range">
            <ShareList rows={lapShare(board.lapsBy.surface)} total={countsOf(board.lapsBy.surface)} unit={(n) => count(n)} />
          </Card>
          <Card title="Tyres" aside="Times set in the range">
            <ShareList rows={lapShare(board.lapsBy.compound)} total={countsOf(board.lapsBy.compound)} unit={(n) => count(n)} />
          </Card>
        </div>
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

      <Section
        id="races"
        title="Races"
        intro={races ? "Open races finished in the range. Room results are not stored, so room races don't show here." : "Race results show once the database has migration 0002."}
      >
        {races ? (
          <>
            <Tiles>
              <Tile label="Races run" value={count(raceCount)} note={races.room > 0 ? `${count(races.open)} open, ${count(races.room)} room` : "Open races"} />
              <Tile label="Cars classified" value={count(races.cars)} note="Across all those races" />
              <Tile label="Cars a race" value={raceCount > 0 ? (races.cars / raceCount).toFixed(1) : "–"} note="Average grid" />
              <Tile label="Finished" value={percent(races.cars - races.dnf, races.cars)} note={`${count(races.dnf)} did not finish`} />
            </Tiles>
            <div className="grid gap-4 md:grid-cols-2">
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

      <SiteSection cloudflare={cloudflare} />
    </div>
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
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-[14px] leading-relaxed text-[#C5CBD8]">
              <li>
                In the Cloudflare dashboard, create an API token with <b className="text-[#F5F7FA]">Account Analytics: Read</b> (and{" "}
                <b className="text-[#F5F7FA]">Zone Analytics: Read</b> for the site&apos;s visitors).
              </li>
              <li>
                Run <code className="lc-data text-[#F5F7FA]">npx wrangler secret put CF_ANALYTICS_TOKEN</code> and paste it.
              </li>
              <li>
                For visitors per day, add the domain&apos;s zone id to <code className="lc-data text-[#F5F7FA]">vars</code> in wrangler.jsonc as{" "}
                <code className="lc-data text-[#F5F7FA]">ANALYTICS_ZONE_ID</code> and deploy.
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
              height={120}
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
          <summary className="cursor-pointer select-none hover:text-[#C5CBD8]">
            {cf.problems.length} {cf.problems.length === 1 ? "part" : "parts"} could not be read
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {cf.problems.map((p) => (
              <li key={p.part}>
                <span className="text-[#C5CBD8]">{p.part}:</span> {p.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Section>
  );
}

