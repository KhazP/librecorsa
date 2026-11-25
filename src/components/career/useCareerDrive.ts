"use client";

/**
 * The career's side of the simulator (LibreCorsaSimulator.tsx): its save, its screen, and its rounds driven.
 *
 * - A round is raced on the round's own terms (`DriveSession.setRaceOverride`: the laps, the stops, the field's skill and
 *   the career's rivals as its drivers) on the round's circuit in the season's car, neither of which becomes the
 *   player's own choice (`remember: false`); the player's car comes back when the round is left.
 * - A round on another circuit loads it first (`pendingCareer`, as the weekly challenge does): the simulator remounts
 *   for a new circuit, so what must outlive that is kept at module level.
 * - The result is recorded once the classification closes (or when the player leaves after the flag): the rivals are
 *   credited by the codes the race used, laps led counted on the way. The last round closes the season.
 * - A restart costs a mulligan (none left: no restart); leaving before the flag asks for a mulligan or a retirement.
 * - A test day is practice on the next round's circuit (the first before the season starts) in the season's car, dry,
 *   at the round's time of day, with its own short show. Its target lap comes from a reference lap of the car there
 *   (sim/reference-lap.ts); each lap completed is kept on the season at once (its laps and the player's best).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CarId } from "@/lib/cars/car-registry";
import { CARS } from "@/lib/cars/car-registry";
import { carPhysics } from "@/lib/cars/f1-mod-physics";
import { vehicleModelSpec } from "@/lib/cars/vehicle-models";
import {
  EMPTY_SAVE,
  endSeason,
  loadCareerSave,
  markRoundStarted,
  nextRound,
  promotionPlaces,
  racePlan,
  raceScore,
  roundConditions,
  recordRound,
  recordTestDay,
  retireFromRound,
  seasonStandings,
  seasonTest,
  storeCareerSave,
  spendMulligan,
  testCircuit,
  testTargetMs,
  withRun,
  type CareerRacePlan,
  type CareerRun,
  type CareerSave,
} from "@/lib/career/career-state";
import { seriesById, type CareerContent } from "@/lib/career/ladder";
import { rivalAsDriver, rivalCode } from "@/lib/career/rivals";
import type { ShowContext, ShowDriver, ShowTestDay } from "@/lib/show/show-context";
import { ReferenceLap } from "@/lib/sim/reference-lap";
import { SHOW_CUE_MARKERS } from "@/lib/audio/music-catalog";
import type { DriveSession, SessionRace } from "@/lib/drive-session";
import { startAiRace, type RaceSetup } from "@/lib/sim/race-setup";
import { getTrackInfo, LISTED_TRACKS, trackDefaultTimeOfDay } from "@/lib/track-registry";
import type { TimeOfDayId, WeatherPresetId } from "@/lib/sim/weather";
import { accountActions } from "@/lib/account/account-store";
import type { PlayerSettings } from "@/lib/settings/player-settings";
import type { PitTelemetry, RaceResultEntry, RaceStatus } from "@/types/f1";
import type { CareerSummary } from "./career-screen-types";

type DriveMode = "race" | "test";

/** A round or test day asked for from another circuit: driven once that circuit (`trackId`) has loaded */
let pendingCareer: { runId: string; mode: DriveMode; trackId: string } | null = null;
/** The career screen opens again on the title menu after a remount */
let careerScreenResume = false;
/** What is being driven for the career, and the player's own car to give back */
let careerDrive: {
  runId: string;
  mode: DriveMode;
  plan: CareerRacePlan | null;
  ownCar: CarId;
  lapsLed: number;
  lastLap: number;
  recorded: boolean;
  /** A test day's: its circuit and car, the show told of it, and the reference lap its target comes from */
  test: { trackId: string; car: CarId; show: ShowContext; ref: ReferenceLap; targetMs: number | null } | null;
} | null = null;
/**
 * Page time per frame the test day's reference lap is driven for (ms): more while its show holds the car (a road car's
 * lap is some 5 s of work on a desktop: the target is known by the show's car or soon after)
 */
const TEST_REF_BUDGET_MS = 2;
const TEST_REF_SHOW_BUDGET_MS = 6;
let queuedSummaries: CareerSummary[] = [];
let queuedUnfinished: { runId: string; plan: CareerRacePlan } | null = null;

export interface CareerDriveDeps {
  session: DriveSession | null;
  trackId: string;
  assetsReady: boolean;
  race: RaceStatus | undefined;
  /** The player's pit stop state (its stops made against the race's required ones) */
  pit: PitTelemetry | undefined;
  /** The session's race is the career round's AI race (not online, not practice) */
  raceIsAi: boolean;
  settingsRef: React.RefObject<PlayerSettings>;
  carIdRef: React.RefObject<CarId>;
  changeCar: (car: CarId, opts?: { remember?: boolean }) => void;
  startSession: (race: SessionRace) => void;
  leaveSession: () => void;
  onSelectTrack?: (id: string, opts?: { remember?: boolean }) => void | Promise<void>;
  /** The loading screen leaves for the drive (a round asked for from another circuit) */
  leaveLoading: () => void;
  /** The round's weather and time of day, for this drive only (the player's own come back on leaving) */
  applyConditions: (c: { weather: WeatherPresetId; timeOfDay: TimeOfDayId }) => void;
  setLaunchHint: (on: boolean) => void;
}

export function useCareerDrive(d: CareerDriveDeps) {
  const [save, setSave] = useState<CareerSave>(EMPTY_SAVE);
  const saveRef = useRef(save);
  saveRef.current = save;
  const [open, setOpen] = useState(careerScreenResume);
  const [summaries, setSummaries] = useState<CareerSummary[]>(queuedSummaries);
  const [unfinished, setUnfinished] = useState(queuedUnfinished);
  const [driving, setDriving] = useState(careerDrive !== null);
  /** The round being driven has its result: no restart (a mulligan) for it any more */
  const [roundRecorded, setRoundRecorded] = useState(careerDrive?.recorded ?? false);

  useEffect(() => {
    const loaded = loadCareerSave();
    setSave(loaded);
    // The simulator mounted again with a drive under way (a lost GPU context restarts it, switching circuit from the
    // Multiplayer tab reloads it): the new mount starts on the title menu, so that drive is over. A round without its
    // result is settled as one left before the flag, and the next race is not taken for it
    const cut = careerDrive;
    if (cut) {
      careerDrive = null;
      setDriving(false);
      setRoundRecorded(false);
      if (cut.mode === "race" && !cut.recorded && cut.plan && !queuedUnfinished) {
        queuedUnfinished = { runId: cut.runId, plan: cut.plan };
        setUnfinished(queuedUnfinished);
        careerScreenResume = true;
        setOpen(true);
      }
      return;
    }
    // A round started and never finished (the tab closed mid-race): settled now, a mulligan or a retirement
    if (!queuedUnfinished) {
      const run = loaded.runs.find((r) => r.status === "active" && r.season?.racing !== undefined);
      const plan = run ? racePlan(run, (id) => getTrackInfo(id).lengthM, "") : null;
      if (run && plan && plan.roundIndex === run.season?.racing) {
        queuedUnfinished = { runId: run.id, plan };
        setUnfinished(queuedUnfinished);
        careerScreenResume = true;
        setOpen(true);
      }
    }
  }, []);

  const content = useMemo<CareerContent>(
    () => ({ tracks: new Set(LISTED_TRACKS.map((t) => t.id)), cars: new Set(CARS.map((c) => c.id)) }),
    []
  );

  const commit = useCallback((next: CareerSave) => {
    saveRef.current = next;
    setSave(next);
    storeCareerSave(next);
    accountActions.pushSoon();
  }, []);

  const pushSummaries = useCallback((more: CareerSummary[]) => {
    queuedSummaries = [...queuedSummaries, ...more];
    setSummaries(queuedSummaries);
  }, []);

  const runOf = (id: string): CareerRun | undefined => saveRef.current.runs.find((r) => r.id === id);
  const lapLength = (id: string) => getTrackInfo(id).lengthM;

  /** Record the round being raced from the race's classification */
  const record = useCallback(
    (results: readonly RaceResultEntry[]) => {
      const drive = careerDrive;
      if (!drive || drive.mode !== "race" || drive.recorded || !drive.plan) return;
      const run = runOf(drive.runId);
      if (!run?.season) return;
      const plan = drive.plan;
      const before = seasonStandings(run.season);
      let next = recordRound(run, plan, {
        results: results.map((r) => ({
          code: r.driverCode,
          isPlayer: r.isPlayer,
          position: r.position,
          dnf: r.dnf,
          dq: r.dq,
          gridPosition: r.gridPosition,
          lapsCompleted: r.lapsCompleted,
          bestLapMs: r.bestLapMs,
          penaltyS: r.penaltyS,
        })),
        laps: plan.laps,
        lapsLed: drive.lapsLed,
      });
      drive.recorded = true;
      setRoundRecorded(true);
      const season = next.season;
      const result = season?.rounds[plan.roundIndex];
      if (!season || !result) return;
      const series = seriesById(season.seriesId)!;
      const more: CareerSummary[] = [
        {
          kind: "race",
          runId: run.id,
          seriesId: season.seriesId,
          roundIndex: plan.roundIndex,
          rounds: season.rounds.length,
          result,
          parts: raceScore(result, season.race.gridSize, season.race),
          before,
          after: seasonStandings(season),
          promotion: promotionPlaces(series, season.race.gridSize),
        },
      ];
      if (nextRound(season) === null) {
        const end = endSeason(next, content);
        if (end) {
          next = end.run;
          const { run: _run, ...rest } = end;
          void _run;
          more.push({ kind: "season", runId: run.id, end: rest });
        }
      }
      commit(withRun(saveRef.current, next));
      pushSummaries(more);
    },
    [commit, content, pushSummaries]
  );

  /** The round or test day on the circuit now loaded */
  const drive = useCallback(
    (runId: string, mode: DriveMode) => {
      const session = d.session;
      const run = runOf(runId);
      const season = run?.season;
      if (!session || !run || !season) return;
      const profile = d.settingsRef.current.profile;
      const plan = mode === "race" ? racePlan(run, lapLength, profile.code) : null;
      if (mode === "race" && (!plan || plan.trackId !== d.trackId)) return;
      const testAt = mode === "test" ? testCircuit(season) : null;
      if (mode === "test" && testAt?.trackId !== d.trackId) return;
      careerScreenResume = false;
      setOpen(false);
      const ownCar = careerDrive?.ownCar ?? d.carIdRef.current;
      d.startSession({ kind: "practice" });
      d.changeCar(season.settings.car, { remember: false });
      // A test day's flying laps start at the car's own pace: the boards' start hands a slow car the circuit car's speed
      session.setFairFlyingStart(true);
      const at = plan ?? testAt;
      const round = at ? roundConditions(run, season.seriesId, at.roundIndex, trackDefaultTimeOfDay(at.trackId) === "night") : null;
      // A test day runs dry (its target is a dry lap), at the time of day of the round there
      const conditions = round && !plan ? { weather: "clear" as const, timeOfDay: round.timeOfDay } : round;
      if (conditions) d.applyConditions(conditions);
      // The pre-race show: for a round, the series, the round, the field's names, the table; for a test day, its car
      let test: NonNullable<typeof careerDrive>["test"] = null;
      if (testAt && conditions) {
        const ref = new ReferenceLap(season.settings.car);
        // Until its reference lap is driven, the target this test day had before (the field may have changed since)
        const targetMs =
          ref.lapMs !== null
            ? testTargetMs(run, ref.lapMs, ref.base)
            : (seasonTest(season, testAt.trackId, season.settings.car)?.targetMs ?? null);
        const show = testShowContextOf(run, testAt.roundIndex, season.settings.car, targetMs, profile, conditions);
        test = { trackId: testAt.trackId, car: season.settings.car, show, ref, targetMs };
      }
      session.preRaceShow.arm(plan && conditions ? showContextOf(run, plan, profile, conditions) : (test?.show ?? null), SHOW_CUE_MARKERS);
      careerDrive = { runId, mode, plan, ownCar, lapsLed: 0, lastLap: 0, recorded: false, test };
      setDriving(true);
      setRoundRecorded(false);
      // Saved as under way: leaving it without a result later is settled, not forgotten
      if (plan) commit(withRun(saveRef.current, markRoundStarted(run, plan.roundIndex)));
      if (mode === "test" || !plan) {
        session.setRaceOverride(null);
        session.car.resetToStartGrid(false);
        d.setLaunchHint(true);
        return;
      }
      const setup: RaceSetup = {
        ...d.settingsRef.current.race,
        laps: plan.laps,
        opponents: plan.drivers.length,
        grid: "back",
        aiGrid: "qualifying",
        damage: plan.damage,
        startMode: "standing",
        aggression: "normal",
        rulePreset: "auto",
        trackLimits: "auto",
        qualifying: plan.qualifying,
        pitStops: plan.pitStops,
      };
      const drivers = plan.drivers.map((x) => rivalAsDriver(run.rivals.find((r) => r.id === x.id)!, profile.code));
      session.setRaceOverride({
        setup,
        skill: plan.aiSkill,
        drivers,
        // A restart is a mulligan: none left, no restart
        onRestart: () => {
          const cur = careerDrive;
          // A round with its result is over: no mulligan spent on it
          if (!cur || cur.recorded) return false;
          const now = runOf(cur.runId);
          const used = now ? spendMulligan(now) : null;
          if (!used) return false;
          // Under way again from the lights
          commit(withRun(saveRef.current, markRoundStarted(used, plan.roundIndex)));
          cur.lapsLed = 0;
          cur.lastLap = 0;
          return true;
        },
      });
      const field = session.takeAiField();
      if (plan.qualifying > 0) session.startQualifying(field, plan.qualifying);
      else {
        session.setRace({ kind: "ai", field });
        startAiRace(field, setup, profile);
      }
      d.setLaunchHint(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d.session, d.trackId, d.startSession, d.changeCar, commit]
  );

  /** Race the next round: on its circuit (loaded first when it is another) */
  const raceNext = useCallback(
    (runId: string) => {
      const run = runOf(runId);
      if (!run) return;
      const plan = racePlan(run, lapLength, d.settingsRef.current.profile.code);
      if (!plan) return;
      if (plan.trackId !== d.trackId) {
        if (!d.onSelectTrack) return;
        pendingCareer = { runId, mode: "race", trackId: plan.trackId };
        setOpen(false);
        void d.onSelectTrack(plan.trackId, { remember: false });
        return;
      }
      drive(runId, "race");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d.trackId, d.onSelectTrack, drive]
  );

  /** A test day: practice on the next round's circuit (the first before the season starts) in the season's car */
  const testDay = useCallback(
    (runId: string) => {
      const season = runOf(runId)?.season;
      const circuit = season ? testCircuit(season)?.trackId : undefined;
      if (!circuit) return;
      if (circuit !== d.trackId) {
        if (!d.onSelectTrack) return;
        pendingCareer = { runId, mode: "test", trackId: circuit };
        setOpen(false);
        void d.onSelectTrack(circuit, { remember: false });
        return;
      }
      drive(runId, "test");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d.trackId, d.onSelectTrack, drive]
  );

  // The round asked for from another circuit, once that circuit has loaded
  useEffect(() => {
    if (!d.assetsReady || !pendingCareer || !d.session) return;
    const asked = pendingCareer;
    pendingCareer = null;
    // The circuit asked for did not load (the game stayed where it was): the round waits on the career screen
    if (asked.trackId !== d.trackId) {
      careerScreenResume = true;
      setOpen(true);
      return;
    }
    d.leaveLoading();
    drive(asked.runId, asked.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.assetsReady, d.session, drive]);

  // A test day's target: its reference lap driven a slice per frame until known (the show told of it then)
  useEffect(() => {
    const session = d.session;
    if (!driving || !session) return;
    let raf = 0;
    const tick = () => {
      const cur = careerDrive;
      const test = cur?.mode === "test" ? cur.test : null;
      if (!cur || !test || test.ref.done) return;
      raf = requestAnimationFrame(tick);
      if (!test.ref.step(session.preRaceShow.playing ? TEST_REF_SHOW_BUDGET_MS : TEST_REF_BUDGET_MS)) return;
      const run = runOf(cur.runId);
      const targetMs = run && test.ref.lapMs !== null ? testTargetMs(run, test.ref.lapMs, test.ref.base) : null;
      if (targetMs === null) return;
      test.targetMs = targetMs;
      test.show = { ...test.show, test: { ...test.show.test!, targetMs } };
      session.preRaceShow.arm(test.show);
    };
    tick();
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driving, d.session]);

  // A test day's laps: each one kept on the season as it is completed (its best only when the player drove it clean)
  useEffect(() => {
    const session = d.session;
    if (!session) return;
    return session.onLapCompleted((lap) => {
      const cur = careerDrive;
      const test = cur?.mode === "test" ? cur.test : null;
      const run = cur ? runOf(cur.runId) : undefined;
      if (!test || !run?.season || !(lap.lapTimeMs > 0)) return;
      const own = lap.valid && !lap.autopilot && !lap.wallContact;
      commit(
        withRun(
          saveRef.current,
          recordTestDay(run, { trackId: test.trackId, car: test.car, laps: 1, bestMs: own ? lap.lapTimeMs : null, targetMs: test.targetMs })
        )
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.session, commit]);

  // On the way: laps led, and the result once the classification closes
  const race = d.race;
  const pit = d.pit;
  const raceIsAi = d.raceIsAi;
  useEffect(() => {
    const cur = careerDrive;
    if (!cur || cur.mode !== "race" || cur.recorded || !race || !raceIsAi) return;
    // A lap is led when the player is in front as it ends: at each new lap, and at the flag for the last one
    if (race.phase === "racing" && race.lap > cur.lastLap) {
      if (cur.lastLap > 0 && race.position === 1) cur.lapsLed++;
      cur.lastLap = race.lap;
    }
    const total = race.totalLaps ?? cur.plan?.laps ?? 0;
    if (race.phase === "finished" && cur.lastLap > 0 && cur.lastLap <= total && race.results?.some((r) => r.isPlayer)) {
      if (race.position === 1) cur.lapsLed++;
      cur.lastLap = total + 1;
    }
    if (!(race.phase === "finished" && race.resultsFinal)) return;
    const me = race.results?.find((r) => r.isPlayer);
    if (!me || !race.results) return;
    // A required stop not made is +30 s at the flag: recorded only once race control has added it
    const missed = pit ? pit.stopsRequired - pit.stopsMade : 0;
    if (missed > 0 && (me.penaltyS ?? 0) < 30 * missed) return;
    record(race.results);
  }, [race, pit, raceIsAi, record]);

  /** The car and the race's terms back to the player's own */
  const endDrive = useCallback(() => {
    const cur = careerDrive;
    careerDrive = null;
    setDriving(false);
    d.session?.setRaceOverride(null);
    d.session?.setFairFlyingStart(false);
    d.session?.preRaceShow.arm(null);
    if (cur && cur.ownCar !== d.carIdRef.current) d.changeCar(cur.ownCar, { remember: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.session, d.changeCar]);

  /**
   * Out of the car to the career screen: the round's race after its flag is recorded with the order as it stands (only
   * the round's own AI race: anything else finished since is not the round)
   */
  const backToCareer = useCallback(() => {
    const cur = careerDrive;
    if (cur?.mode === "race" && !cur.recorded && cur.plan) {
      if (raceIsAi && race?.phase === "finished" && race.results?.some((r) => r.isPlayer)) record(race.results);
      else {
        queuedUnfinished = { runId: cur.runId, plan: cur.plan };
        setUnfinished(queuedUnfinished);
      }
    }
    endDrive();
    d.leaveSession();
    careerScreenResume = true;
    setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [race, raceIsAi, record, endDrive, d.leaveSession]);

  const resolveUnfinished = useCallback(
    (mulligan: boolean) => {
      const u = queuedUnfinished;
      queuedUnfinished = null;
      setUnfinished(null);
      if (!u) return;
      const run = runOf(u.runId);
      if (!run) return;
      if (mulligan) {
        const used = spendMulligan(run);
        if (used) return commit(withRun(saveRef.current, used));
      }
      const before = run.season ? seasonStandings(run.season) : [];
      let next = retireFromRound(run, u.plan);
      const more: CareerSummary[] = [];
      const season = next.season;
      const result = season?.rounds[u.plan.roundIndex];
      if (season && result) {
        const series = seriesById(season.seriesId)!;
        more.push({
          kind: "race",
          runId: run.id,
          seriesId: season.seriesId,
          roundIndex: u.plan.roundIndex,
          rounds: season.rounds.length,
          result,
          parts: raceScore(result, season.race.gridSize, season.race),
          before,
          after: seasonStandings(season),
          promotion: promotionPlaces(series, season.race.gridSize),
        });
        if (nextRound(season) === null) {
          const end = endSeason(next, content);
          if (end) {
            next = end.run;
            const { run: _run, ...rest } = end;
            void _run;
            more.push({ kind: "season", runId: run.id, end: rest });
          }
        }
      }
      commit(withRun(saveRef.current, next));
      pushSummaries(more);
    },
    [commit, content, pushSummaries]
  );

  const closeSummary = useCallback(() => {
    queuedSummaries = queuedSummaries.slice(1);
    setSummaries(queuedSummaries);
  }, []);

  const openScreen = useCallback(() => {
    careerScreenResume = true;
    setOpen(true);
  }, []);
  const closeScreen = useCallback(() => {
    careerScreenResume = false;
    setOpen(false);
  }, []);

  /** A restart now is a mulligan: possible only while the season has one left, and the round has no result yet */
  const driveRun = careerDrive ? save.runs.find((r) => r.id === careerDrive?.runId) : undefined;
  const canRestart =
    !driving ||
    careerDrive?.mode !== "race" ||
    (!roundRecorded && Boolean(driveRun?.season && driveRun.season.mulligansUsed < driveRun.season.settings.mulligans));
  const mulligansLeft = driveRun?.season ? driveRun.season.settings.mulligans - driveRun.season.mulligansUsed : 0;

  /** The career shown on the title menu: the active one under way, its series and next round */
  const status = useMemo(() => {
    const run = save.runs.find((r) => r.id === save.activeId && r.status === "active");
    const season = run?.season;
    if (!season) return null;
    const next = nextRound(season);
    return { seriesId: season.seriesId, round: season.started && next !== null ? next + 1 : null, rounds: season.settings.circuits.length };
  }, [save]);

  return {
    save,
    commit,
    canRestart,
    /** Mulligans the season under way has left (for the restart's label) */
    mulligansLeft,
    status,
    content,
    open,
    openScreen,
    closeScreen,
    summaries,
    closeSummary,
    unfinished: unfinished ? { runId: unfinished.runId } : null,
    resolveUnfinished,
    raceNext,
    testDay,
    /** A career round or test day is being driven */
    driving,
    /** A career round (not a test day) is being raced */
    racing: driving && careerDrive?.mode === "race",
    /** Leaving the car while driving for the career: back to its screen */
    backToCareer,
  };
}

/** The player as the show names them: the last word of their name as the surname (a name ending in a number, like a handle, stays whole) */
function showPlayer(profile: PlayerSettings["profile"]): ShowDriver {
  const words = profile.name.trim().split(/\s+/).filter(Boolean);
  const split = words.length > 1 && /\p{L}/u.test(words[words.length - 1]);
  const last = split ? words[words.length - 1] : words.join(" ") || profile.code;
  const first = split ? words.slice(0, -1).join(" ") : "";
  return { code: profile.code, first, last, number: null, color: profile.color, isPlayer: true };
}

/** What the car's card shows of a car: its vehicle model's weight, balance, driven axles and rev limit */
function carCardOf(car: CarId, targetMs: number | null): ShowTestDay {
  const model = vehicleModelSpec(carPhysics(car));
  const chassis = model.rigConfig.chassis;
  const rig = model.rigConfig;
  return {
    car,
    massKg: chassis.totalMassKg > 0 ? Math.round(chassis.totalMassKg) : null,
    frontPct: chassis.frontWeightFraction > 0 ? Math.round(chassis.frontWeightFraction * 1000) / 10 : null,
    drivetrain: rig.awd ? "awd" : rig.drivenAxle === "front" ? "fwd" : "rwd",
    limiterRpm: model.limiterRpm > 0 ? Math.round(model.limiterRpm) : null,
    targetMs,
  };
}

/** What a test day's show tells: the series, the car and its target; no field, terms or table */
function testShowContextOf(
  run: CareerRun,
  roundIndex: number,
  car: CarId,
  targetMs: number | null,
  profile: PlayerSettings["profile"],
  conditions: { weather: WeatherPresetId; timeOfDay: TimeOfDayId }
): ShowContext {
  const season = run.season!;
  return {
    seriesId: season.seriesId,
    roundIndex,
    rounds: season.settings.circuits.length,
    laps: 0,
    pitStops: 0,
    qualifyingMin: 0,
    drivers: { [profile.code]: showPlayer(profile) },
    standings: [],
    weather: conditions.weather,
    timeOfDay: conditions.timeOfDay,
    test: carCardOf(car, targetMs),
  };
}

/** What the pre-race show tells of a round: its series and number, the field by race code, the table before it */
function showContextOf(
  run: CareerRun,
  plan: CareerRacePlan,
  profile: PlayerSettings["profile"],
  conditions: { weather: WeatherPresetId; timeOfDay: TimeOfDayId }
): ShowContext {
  const season = run.season!;
  const drivers: Record<string, ShowDriver> = {};
  for (const x of plan.drivers) {
    const r = run.rivals.find((y) => y.id === x.id);
    if (r) drivers[x.code] = { code: x.code, first: r.first, last: r.last, number: r.number, color: r.color, isPlayer: false };
  }
  drivers[profile.code] = showPlayer(profile);
  const codeOf = (who: string) => {
    if (who === "me") return profile.code;
    const r = run.rivals.find((y) => y.id === who);
    return r ? rivalCode(r, profile.code) : who;
  };
  return {
    seriesId: season.seriesId,
    roundIndex: plan.roundIndex,
    rounds: season.rounds.length,
    laps: plan.laps,
    pitStops: plan.pitStops,
    qualifyingMin: plan.qualifying,
    drivers,
    standings: seasonStandings(season).map((row, i) => ({ position: i + 1, code: codeOf(row.who), points: row.points, isPlayer: row.who === "me" })),
    weather: conditions.weather,
    timeOfDay: conditions.timeOfDay,
  };
}
