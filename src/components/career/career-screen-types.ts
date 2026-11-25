/**
 * The contract between the career screen (CareerScreen.tsx, the UI) and the simulator that runs the career's races
 * (LibreCorsaSimulator.tsx): what the screen is given and what it asks for. The career's rules and data are in
 * src/lib/career/ (ladder.ts, career-state.ts, rivals.ts): the screen changes a career only through their functions
 * and hands the new save to `onSave`.
 */
import type { CareerContent } from "@/lib/career/ladder";
import type { CareerSave, RaceScoreParts, RoundResult, SeasonEnd, StandingRow } from "@/lib/career/career-state";

/** What the screen shows first, over everything: the race just run, then (after the last round) its season's end */
export type CareerSummary =
  | {
      kind: "race";
      runId: string;
      seriesId: string;
      /** The round just raced (0-based) and the season's number of rounds */
      roundIndex: number;
      rounds: number;
      result: RoundResult;
      parts: RaceScoreParts;
      /** The championship before and after this round (for the places gained or lost) */
      before: StandingRow[];
      after: StandingRow[];
      /** Promotion places this season */
      promotion: number;
    }
  | {
      kind: "season";
      runId: string;
      end: Omit<SeasonEnd, "run">;
    };

export interface CareerScreenProps {
  /** Every career the player has, and the one to show */
  save: CareerSave;
  /** What this build can race (circuits listed, cars present): series without enough are locked */
  content: CareerContent;
  /** The player's driver: code and name as the race shows them */
  playerCode: string;
  playerName: string;
  /** The whole save after any change the screen made (career-state.ts functions) */
  onSave: (save: CareerSave) => void;
  onClose: () => void;
  /** Race the active career's next round (the simulator loads its circuit and car and starts the weekend) */
  onRaceNext: (runId: string) => void;
  /** A pre-season test day: free practice at the series' first circuit in its car */
  onTestDay: (runId: string) => void;
  /** Shown first (a modal) until `onCloseSummary`; a queue, the first entry shown */
  summaries: readonly CareerSummary[];
  onCloseSummary: () => void;
  /**
   * A career round left before its finish: the player chooses a mulligan (race it again; only while mulligans are
   * left) or to retire from it (last, no points)
   */
  unfinished: { runId: string } | null;
  onResolveUnfinished: (useMulligan: boolean) => void;
}
