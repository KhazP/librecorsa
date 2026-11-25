/**
 * The career's pre-race show, as a timeline: which scene plays when, laid out on the music's own landmarks so each
 * scene lands on its beat. Pure (no three.js, no DOM): the director (render/pre-race-show.ts) steps it, the overlay
 * draws the scene it names, and the verify suite drives it.
 *
 * Three shows, one per moment of a round:
 * - race: a round raced straight from the grid. The event's title, its circuit drawn in 3D, aerial shots and the
 *   weather, the tyres, then the starting grid two cars at a time from the back to pole, and the start card.
 * - qualifying: a round with a qualifying session. The same opening, then the field (who is entered), then the card.
 * - grid: the race after that qualifying. Only the grid in qualifying order and the start card.
 * - test: a test day, the opening's short version (the title, the circuit, one or two aerial shots, the tyres), then
 *   the car itself and the start card. Its cue starts late enough for the tyres to land on their section.
 *
 * The start card waits for the player; nothing starts by itself.
 *
 * A press moves on one graphic (`nextStopS`): each scene in turn, the grid's pairs in two steps (the player's own pair,
 * then pole); a second press within `DOUBLE_PRESS_MS` goes straight to the start card.
 */

export type ShowKind = "race" | "qualifying" | "grid" | "test";

export type ShowSceneId = "title" | "circuit" | "aerial" | "tyres" | "gridIntro" | "gridPair" | "field" | "car" | "ready";

/** Where the music's sections fall (s into the cue): the scenes are cut to them */
export interface ShowMarkers {
  /** A new section: the tyres come in on it */
  tyresAtS: number;
  /** The grid's title card */
  gridAtS: number;
  /** The music's peak: pole is shown on it */
  climaxS: number;
}

/** The landmarks of the show's own cue (music-catalog.ts); a cue without them uses these */
export const DEFAULT_SHOW_MARKERS: ShowMarkers = { tyresAtS: 43, gridAtS: 52, climaxS: 88 };

/** The event's title card, over the circuit as it starts to draw (s) */
export const TITLE_S = 4.5;
/**
 * The circuit on its own after the title (s): its drawing is done 8.2 s into the show (CircuitStage), then a few
 * seconds to read its facts. The aerial shots, with the weather and the standings, take the rest up to the tyres
 */
export const CIRCUIT_S = 9;
/** The grid's title card before the first pair (s) */
export const GRID_INTRO_S = 3.5;
/** One pair of the grid on screen (s): stretched or squeezed to land pole on the music's peak, within these */
export const PAIR_MIN_S = 2.2;
export const PAIR_MAX_S = 3.6;
/** The aerial shots share the scene between them, cut every this long or a little less (s) */
export const AERIAL_CUT_S = 6.5;
/** A test day's circuit and aerial scenes (s): the opening's short version */
export const TEST_CIRCUIT_S = 9;
export const TEST_AERIAL_S = 8;
/** A test day's car, on its card (s) */
export const CAR_S = 8;
/** The field (qualifying): a moment per row of four entries, within these (s) */
const FIELD_MIN_S = 10;
const FIELD_MAX_S = 20;
const FIELD_PER_ROW_S = 2.5;

export interface ShowScene {
  id: ShowSceneId;
  /** Start and end on the show's clock (s); the start card's end is Infinity */
  startS: number;
  endS: number;
  /** gridPair: which pair (0 = the back row) */
  pair?: number;
}

export interface ShowTimeline {
  kind: ShowKind;
  scenes: readonly ShowScene[];
  /** Where the start card begins (s): a skip goes straight there */
  readyAtS: number;
  /** Where the music starts on the cue (s): the grid show starts it inside the grid's section, pole on the peak */
  musicFromS: number;
  /** Seconds of each grid pair (0 without the grid) */
  pairS: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * The scenes of one show. `gridSize`: the cars on the grid (the player included), `markers`: the cue's sections
 * (sane ones assumed: tyres after the opening, the grid after the tyres, the peak after the grid).
 */
export function buildShowTimeline(kind: ShowKind, gridSize: number, markers: ShowMarkers = DEFAULT_SHOW_MARKERS): ShowTimeline {
  const m = saneMarkers(markers);
  const scenes: ShowScene[] = [];
  const add = (id: ShowSceneId, startS: number, endS: number, pair?: number) => {
    if (endS > startS) scenes.push(pair === undefined ? { id, startS, endS } : { id, startS, endS, pair });
  };
  const cars = Math.max(0, Math.floor(gridSize));
  const pairs = Math.ceil(cars / 2);
  let t = 0;
  let musicFromS = 0;
  if (kind === "test") {
    // The opening cut short, its cue started late enough for the tyres to come in on their section, then the car
    const circuitEnd = TITLE_S + TEST_CIRCUIT_S;
    const tyresS = circuitEnd + TEST_AERIAL_S;
    add("title", 0, TITLE_S);
    add("circuit", TITLE_S, circuitEnd);
    add("aerial", circuitEnd, tyresS);
    add("tyres", tyresS, tyresS + (m.gridAtS - m.tyresAtS));
    t = tyresS + (m.gridAtS - m.tyresAtS);
    add("car", t, t + CAR_S);
    t += CAR_S;
    scenes.push({ id: "ready", startS: t, endS: Infinity });
    return { kind, scenes, readyAtS: t, musicFromS: Math.max(0, m.tyresAtS - tyresS), pairS: 0 };
  }
  if (kind !== "grid") {
    // The opening: the title, the circuit, the aerial shots up to the tyres' section, then the tyres to the grid's (a
    // short cue's opening keeps half of it for the aerial shots)
    const circuitEnd = TITLE_S + Math.min(CIRCUIT_S, (m.tyresAtS - TITLE_S) * 0.5);
    add("title", 0, TITLE_S);
    add("circuit", TITLE_S, circuitEnd);
    add("aerial", circuitEnd, m.tyresAtS);
    add("tyres", m.tyresAtS, m.gridAtS);
    t = m.gridAtS;
  } else musicFromS = m.gridAtS;
  let pairS = 0;
  if (kind === "qualifying") {
    const fieldS = clamp(Math.ceil(cars / 4) * FIELD_PER_ROW_S, FIELD_MIN_S, FIELD_MAX_S);
    add("field", t, t + fieldS);
    t += fieldS;
  } else if (pairs > 0) {
    // The grid: its card, then the pairs from the back, pole landing on the music's peak when the pairs allow
    add("gridIntro", t, t + GRID_INTRO_S);
    t += GRID_INTRO_S;
    const room = m.climaxS - m.gridAtS - GRID_INTRO_S;
    pairS = clamp(room / pairs, PAIR_MIN_S, PAIR_MAX_S);
    for (let i = 0; i < pairs; i++) add("gridPair", t + i * pairS, t + (i + 1) * pairS, i);
    t += pairs * pairS;
    // The grid alone: its cue starts late enough for pole to land on the peak whatever the grid's size
    if (kind === "grid") musicFromS = Math.max(0, m.climaxS - t);
  }
  const readyAtS = t;
  scenes.push({ id: "ready", startS: readyAtS, endS: Infinity });
  return { kind, scenes, readyAtS, musicFromS, pairS };
}

function saneMarkers(m: ShowMarkers): ShowMarkers {
  const tyresAtS = Number.isFinite(m.tyresAtS) && m.tyresAtS > TITLE_S + 8 ? m.tyresAtS : DEFAULT_SHOW_MARKERS.tyresAtS;
  const gridAtS = Number.isFinite(m.gridAtS) && m.gridAtS > tyresAtS + 4 ? m.gridAtS : tyresAtS + 9;
  const climaxS = Number.isFinite(m.climaxS) && m.climaxS > gridAtS + GRID_INTRO_S + PAIR_MIN_S ? m.climaxS : gridAtS + 36;
  return { tyresAtS, gridAtS, climaxS };
}

export interface ShowSceneAt {
  scene: ShowScene;
  index: number;
  /** Seconds into the scene */
  localS: number;
  /** 0..1 through the scene (0 for the start card, which has no end) */
  progress: number;
}

/** The scene playing `timeS` into the show (the first before 0, the start card past the end) */
export function sceneAt(timeline: ShowTimeline, timeS: number): ShowSceneAt {
  const scenes = timeline.scenes;
  const t = Math.max(0, timeS);
  let index = scenes.length - 1;
  for (let i = 0; i < scenes.length; i++) {
    if (t < scenes[i].endS) {
      index = i;
      break;
    }
  }
  const scene = scenes[index];
  const localS = Math.max(0, t - scene.startS);
  const span = scene.endS - scene.startS;
  return { scene, index, localS, progress: Number.isFinite(span) && span > 0 ? Math.min(1, localS / span) : 0 };
}

/**
 * The grid's pairs from the back of the grid to pole: pair 0 is the last row. `order`: the grid in starting order
 * (pole first). The rows pair up from the front, so with an odd field the car at the back is the one shown alone.
 */
export function gridPairs<T>(order: readonly T[]): T[][] {
  const pairs: T[][] = [];
  for (let i = 0; i < order.length; i += 2) pairs.push(order.slice(i, i + 2));
  return pairs.reverse();
}

/** The aerial shot playing `localS` into the aerial scene, and seconds into it: cuts spread evenly over the scene */
export function aerialCut(sceneS: number, localS: number): { shot: number; shotS: number; cutS: number } {
  const shots = Math.max(1, Math.round(sceneS / AERIAL_CUT_S));
  const cutS = sceneS / shots;
  const shot = Math.min(shots - 1, Math.max(0, Math.floor(localS / cutS)));
  return { shot, shotS: localS - shot * cutS, cutS };
}

/** Two presses this close together (ms) skip the whole show to the start card; one moves on a graphic */
export const DOUBLE_PRESS_MS = 600;

/**
 * Where one press goes from `timeS`: the start of the next graphic. Every scene is one, but the grid's pairs (a dozen on
 * a full grid) are two: the player's own pair (`playerPair`, 0 = the back of the grid) and pole. Past the last, and on
 * the start card, the start card.
 */
export function nextStopS(timeline: ShowTimeline, timeS: number, playerPair: number | null = null): number {
  const pairs = timeline.scenes.filter((s) => s.id === "gridPair").length;
  for (const scene of timeline.scenes) {
    if (scene.startS <= timeS + 1e-6) continue;
    if (scene.id === "gridPair" && scene.pair !== pairs - 1 && scene.pair !== playerPair) continue;
    return Math.min(scene.startS, timeline.readyAtS);
  }
  return timeline.readyAtS;
}

/**
 * The show's state from frame to frame: its clock, the scene it is on, a press to the next graphic or a skip to the
 * start card. Pure: the director steps it with each frame's dt (0 while the pause menu is open) and reads back whether
 * the scene changed.
 */
export class ShowClock {
  timeS = 0;
  private sceneIndex = -1;

  constructor(readonly timeline: ShowTimeline) {}

  get at(): ShowSceneAt {
    return sceneAt(this.timeline, this.timeS);
  }

  get onReadyCard(): boolean {
    return this.timeS >= this.timeline.readyAtS;
  }

  /** Moves the clock on; true when the scene changed (the overlay redraws) */
  step(dt: number): boolean {
    if (dt > 0 && Number.isFinite(dt)) this.timeS += Math.min(dt, 0.25);
    return this.syncScene();
  }

  /** On to the next graphic (`nextStopS`); true when that moved it */
  next(playerPair: number | null = null): boolean {
    if (this.onReadyCard) return false;
    this.timeS = nextStopS(this.timeline, this.timeS, playerPair);
    return this.syncScene();
  }

  /** Straight to the start card; true when that moved it */
  skip(): boolean {
    if (this.onReadyCard) return false;
    this.timeS = this.timeline.readyAtS;
    return this.syncScene();
  }

  private syncScene(): boolean {
    const index = this.at.index;
    if (index === this.sceneIndex) return false;
    this.sceneIndex = index;
    return true;
  }
}
