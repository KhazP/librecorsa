/**
 * The online boards' sentences in the player's language. Posting a lap and renaming a driver answer in English (the
 * game's own checks in leaderboard.ts, and the Worker's `{ ok: false, error }`), which the lap card shows as it came;
 * `boardWords` gives the sentences a player meets there in the current language (game.board.errors), passes the
 * account's own on to `accountWords`, and leaves anything else (a technical answer a player shouldn't meet) as it is.
 * scripts/verify/verify-leaderboard.ts holds the English here to the sentences the game and the Worker send.
 */
import type { MessageKey } from "@/i18n/types";
import { accountWords } from "@/lib/account/account-words";
import { text } from "@/lib/text";

/** Each English sentence as the game or the Worker sends it, and its message */
export const BOARD_SENTENCES: Readonly<Record<string, MessageKey>> = {
  "Couldn't reach the online board, I'll keep trying": "game.board.errors.unreachable",
  "Couldn't reach the online board": "game.board.errors.unreachableGaveUp",
  "This lap is from an older version of the physics or the circuit, and that board is read only": "game.board.errors.olderPhysics",
  "This lap is from an older version of the physics or the circuit. Reload the game to drive on the new one": "game.board.errors.olderPhysicsReload",
  "Laps with mod cars or mod circuits stay off the online boards": "game.board.errors.modLap",
  "Unknown circuit: laps on circuits the game doesn't ship stay off the boards": "game.board.errors.unknownCircuit",
  "The online board is not available right now": "game.board.errors.boardOff",
  "The lap recording is invalid": "game.board.errors.invalidRecording",
  "This lap was recorded by an older version of the game": "game.board.errors.olderGame",
  "Too many uploads, try again later": "game.board.errors.tooManyUploads",
  "Too many changes, try again later": "game.board.errors.tooManyChanges",
  "This name is taken. Sign in to the account that holds it, import your driver key under Lap Times, or race under another name": "game.board.errors.nameTaken",
  "Pick another name": "game.board.errors.pickName",
  "That weekly challenge has ended": "game.board.errors.challengeEnded",
  "This lap was not driven to this week's challenge rules": "game.board.errors.challengeRules",
};

/** `sentence` in the current language when it is one the boards send, else as it came */
export function boardWords(sentence: string): string;
export function boardWords(sentence: string | null): string | null;
export function boardWords(sentence: string | null): string | null {
  if (!sentence) return sentence;
  const key = Object.hasOwn(BOARD_SENTENCES, sentence.trim()) ? BOARD_SENTENCES[sentence.trim()] : undefined;
  return key ? text(key) : accountWords(sentence);
}
