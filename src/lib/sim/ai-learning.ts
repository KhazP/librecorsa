/**
 * Lap-to-lap learning of an AI driver, after the way Speed Dreams' robots adapt during a session (the idea only):
 * each car watches itself through every corner (its braking zone included) and, at the corner exit, nudges its
 * own parameters for that corner within fixed bounds:
 *
 *  - off the track, well wide of its line or locking a wheel → brake a little earlier, take a little less speed in
 *  - a clean, tidy corner (on the line, tyres inside their peak) → brake a touch later, carry a touch more speed
 *
 * Corners spent in traffic (contact, or pushed off line by a pass / defence) teach nothing. Everything is driven
 * by what the physics did, so a headless race with a fixed seed learns the same way every run.
 */
import type { TrackSection } from './ai-tuning';
import { inSection } from './ai-tuning';

/** Bounds of what a car may learn for one corner */
export const LEARN_BOUNDS = {
  brakeMargin: [0, 0.15] as const,
  apex: [-0.05, 0.015] as const,
};

const STEP = {
  /** after an incident */
  brakeUp: 0.03,
  apexDown: 0.012,
  /** after a clean corner */
  brakeDown: 0.006,
  apexUp: 0.003,
};

export interface CornerFrame {
  s: number;
  /** All four wheels off the track */
  offTrack: boolean;
  /** Distance from where the car meant to be (m) */
  lineErrorM: number;
  /** Largest normalised combined slip of the four tyres (1 ≈ at the peak) */
  maxSlip: number;
  /** A loaded wheel locked under braking */
  lockup: boolean;
  /** The car's own traffic offset (m): a corner spent passing or defending is not learnt from */
  trafficBiasM: number;
  /** Touched another car this frame */
  contact: boolean;
}

interface CornerState {
  brakeMargin: number;
  apex: number;
  /** Running observation of the current pass through the corner */
  off: boolean;
  maxErr: number;
  maxSlip: number;
  lock: boolean;
  disturbed: boolean;
  frames: number;
  /** Outcome counters (for the headless report) */
  incidents: number;
  clean: number;
}

export interface LearnedCorner {
  label: string;
  brakeMargin: number;
  apex: number;
  incidents: number;
  clean: number;
}

export class AiSectionLearner {
  private readonly state: CornerState[];
  private current = -1;

  constructor(
    readonly sections: readonly TrackSection[],
    private readonly lapLengthM: number,
    initial?: readonly { brakeMargin: number; apex: number }[]
  ) {
    this.state = sections.map((_, i) => ({
      brakeMargin: clampTo(initial?.[i]?.brakeMargin ?? 0, LEARN_BOUNDS.brakeMargin),
      apex: clampTo(initial?.[i]?.apex ?? 0, LEARN_BOUNDS.apex),
      off: false,
      maxErr: 0,
      maxSlip: 0,
      lock: false,
      disturbed: true, // the first corner starts mid-way (grid): skip it
      frames: 0,
      incidents: 0,
      clean: 0,
    }));
  }

  /** Index of the section containing s (-1 when none) */
  sectionAt(s: number): number {
    for (let i = 0; i < this.sections.length; i++) {
      if (inSection(s, this.sections[i].fromM, this.sections[i].toM, this.lapLengthM)) return i;
    }
    return -1;
  }

  /** Learnt brake-margin and apex-speed offsets at s */
  offsetsAt(s: number): { brakeMargin: number; apex: number } {
    const i = this.sectionAt(s);
    return i < 0 ? { brakeMargin: 0, apex: 0 } : { brakeMargin: this.state[i].brakeMargin, apex: this.state[i].apex };
  }

  /** Feed one frame; returns true when a corner was just evaluated (its parameters may have changed) */
  observe(f: CornerFrame): boolean {
    const i = this.sectionAt(f.s);
    let evaluated = false;
    if (i !== this.current) {
      if (this.current >= 0) evaluated = this.evaluate(this.state[this.current]);
      this.current = i;
      if (i >= 0) {
        const st = this.state[i];
        st.off = st.lock = false;
        st.disturbed = false;
        st.maxErr = st.maxSlip = 0;
        st.frames = 0;
      }
    }
    if (i < 0) return evaluated;
    const st = this.state[i];
    st.frames++;
    st.off ||= f.offTrack;
    st.lock ||= f.lockup;
    st.maxErr = Math.max(st.maxErr, f.lineErrorM);
    st.maxSlip = Math.max(st.maxSlip, f.maxSlip);
    st.disturbed ||= f.contact || Math.abs(f.trafficBiasM) > 0.8;
    return evaluated;
  }

  /** The car was put back on track (stuck recovery): the current corner teaches nothing */
  interrupt(): void {
    if (this.current >= 0) this.state[this.current].disturbed = true;
  }

  private evaluate(st: CornerState): boolean {
    if (st.disturbed || st.frames < 10) return false;
    if (st.off || st.maxErr > 2.5 || st.lock) {
      st.incidents++;
      st.brakeMargin = clampTo(st.brakeMargin + STEP.brakeUp, LEARN_BOUNDS.brakeMargin);
      st.apex = clampTo(st.apex - STEP.apexDown, LEARN_BOUNDS.apex);
      return true;
    }
    if (st.maxErr < 1.0 && st.maxSlip < 1.0) {
      st.clean++;
      st.brakeMargin = clampTo(st.brakeMargin - STEP.brakeDown, LEARN_BOUNDS.brakeMargin);
      st.apex = clampTo(st.apex + STEP.apexUp, LEARN_BOUNDS.apex);
      return true;
    }
    return false;
  }

  snapshot(): LearnedCorner[] {
    return this.sections.map((sec, i) => ({
      label: sec.label,
      brakeMargin: this.state[i].brakeMargin,
      apex: this.state[i].apex,
      incidents: this.state[i].incidents,
      clean: this.state[i].clean,
    }));
  }
}

const clampTo = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/** localStorage key of what a class has learnt on a circuit */
const storageKey = (trackId: string, classId: string, code: string) => `librecorsa.ai-learn.v1.${trackId}.${classId}.${code}`;

/** Learnt offsets saved for a driver (empty when none, or storage is unavailable) */
export function loadLearnedCorners(trackId: string, classId: string, code: string, count: number): { brakeMargin: number; apex: number }[] | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(trackId, classId, code));
    if (!raw) return undefined;
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== count) return undefined;
    return arr.map((e) => ({
      brakeMargin: typeof e?.b === 'number' ? e.b : 0,
      apex: typeof e?.a === 'number' ? e.a : 0,
    }));
  } catch {
    return undefined;
  }
}

export function saveLearnedCorners(trackId: string, classId: string, code: string, corners: readonly LearnedCorner[]): void {
  try {
    globalThis.localStorage?.setItem(
      storageKey(trackId, classId, code),
      JSON.stringify(corners.map((c) => ({ b: Math.round(c.brakeMargin * 1e4) / 1e4, a: Math.round(c.apex * 1e4) / 1e4 })))
    );
  } catch {
    // Storage unavailable: the learning lasts for this session only
  }
}
