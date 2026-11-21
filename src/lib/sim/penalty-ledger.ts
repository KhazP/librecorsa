/**
 * The penalties race control hands out in a race, per car: every call kept with its kind and reason, the time
 * penalties summed for the classification. Sprint races have no pit lane, so every penalty is time added at the
 * flag, a warning, or a disqualification.
 *
 * No three.js and no DOM: the worker and the race server can import this file.
 */

export type PenaltyKind = "warning" | "black_white" | "time_penalty" | "disqualification";

export type PenaltyReason =
  | "track_limits"
  | "corner_cut"
  | "illegal_overtake"
  | "yellow_overtake"
  | "blue_flag"
  | "vsc_delta"
  | "formation_corridor"
  | "jump_start"
  | "collision"
  | "unsafe_rejoin"
  | "unsportsmanlike";

export interface PenaltyEntry {
  id: number;
  kind: PenaltyKind;
  reason: PenaltyReason;
  /** Time added at the flag (s); 0 for a warning or a disqualification */
  seconds: number;
  /** Race time it was given (s) */
  atS: number;
  label: string;
}

export class PenaltyLedger {
  private readonly byCar = new Map<string, PenaltyEntry[]>();
  private nextId = 1;

  clear(): void {
    this.byCar.clear();
  }

  add(code: string, entry: Omit<PenaltyEntry, "id">): PenaltyEntry {
    const e = { ...entry, id: this.nextId++ };
    const list = this.byCar.get(code);
    if (list) list.push(e);
    else this.byCar.set(code, [e]);
    return e;
  }

  /** The time penalties of a car, summed (s) */
  secondsOf(code: string): number {
    let s = 0;
    for (const e of this.byCar.get(code) ?? []) if (e.kind === "time_penalty") s += e.seconds;
    return s;
  }

  disqualified(code: string): boolean {
    return (this.byCar.get(code) ?? []).some((e) => e.kind === "disqualification");
  }

  entriesOf(code: string): readonly PenaltyEntry[] {
    return this.byCar.get(code) ?? [];
  }
}
