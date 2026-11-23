/**
 * What the account screens share among themselves, outside the account store: a join the player already confirmed
 * in the code flow, and a first-sync choice put off for now.
 */
import { useSyncExternalStore } from "react";

export interface AccountUiState {
  /**
   * When the player answered "Join the account of ...?" in the code flow and the code is being redeemed (ms), or 0.
   * The join that follows the sign-in is then made without asking the same question again.
   */
  codeJoinAt: number;
  /** The first-sync choice was put off (Not now, B, Esc): asked again from the Account tab or on the next start */
  firstSyncDeferred: boolean;
}

/** A code-flow confirmation counts for the sign-in that follows it at once, never for a later one */
const CODE_JOIN_FOR_MS = 30_000;

let state: AccountUiState = { codeJoinAt: 0, firstSyncDeferred: false };
const listeners = new Set<() => void>();

function set(next: Partial<AccountUiState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const SERVER: AccountUiState = { codeJoinAt: 0, firstSyncDeferred: false };

export function useAccountUi(): AccountUiState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER);
}

export const accountUi = {
  /** The player confirmed the join in the code flow; the code is being redeemed now */
  noteCodeJoin: () => set({ codeJoinAt: Date.now() }),
  clearCodeJoin: () => set({ codeJoinAt: 0 }),
  /** Whether a code-flow confirmation stands for the join being asked now */
  codeJoinStands: (s: AccountUiState = state) => s.codeJoinAt > 0 && Date.now() - s.codeJoinAt < CODE_JOIN_FOR_MS,
  deferFirstSync: () => set({ firstSyncDeferred: true }),
  reopenFirstSync: () => set({ firstSyncDeferred: false }),
};
