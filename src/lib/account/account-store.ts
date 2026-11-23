/**
 * The game's side of player accounts: who is signed in, this device's join and first sync, and the actions the
 * account screens call. A small store outside React (`getAccountState` / `subscribeAccount`) with a hook over it.
 *
 * CONTRACT FILE: the exported names and types below are what the account UI (src/components/account) builds on.
 * The bodies here are placeholders until the sync engine lands; keep every export and its signature.
 */
import { useSyncExternalStore } from "react";
import type { AccountInfo, AccountProvider, PasskeyMode, SignInIntent, SignInProvider } from "./api-types";

export type AccountPhase =
  /** No online side, or ONLINE_ACCOUNTS is off: nothing about accounts is shown */
  | "off"
  /** Reading the config and the session */
  | "loading"
  | "signed-out"
  | "signed-in";

/** What one side of a first sync holds, for the choice screen */
export interface SaveSummary {
  bestLaps: number;
  /** Saved setups (presets) over every car */
  setups: number;
  races: number;
  /** When it was last written; null for this device */
  savedAt: number | null;
  /** The device that wrote it (cloud), or null */
  savedBy: string | null;
}

export type FirstSyncChoice = "combine" | "cloud" | "local";

export interface SyncStatus {
  status: "idle" | "syncing" | "error";
  /** When this device last pushed or pulled successfully (ms) */
  lastSyncedAt: number | null;
  /** The last failure, for the player */
  error: string | null;
}

export interface AccountState {
  phase: AccountPhase;
  /** The ways in this server offers (Discord and Google only once set up); [] while off */
  providers: readonly AccountProvider[];
  /** Signed in: the account as the server last described it */
  account: AccountInfo | null;
  /**
   * Signed in, but this device hasn't joined the account yet: ask "Join the account of <driverName>?" before any of
   * this device's names or save go up. Declining signs this device out again.
   */
  join: { driverName: string | null; providers: readonly AccountProvider[] } | null;
  /** This device and the cloud both hold a save: ask Combine (default) / Use the cloud save / Keep this device's */
  firstSync: { local: SaveSummary; cloud: SaveSummary } | null;
  /** After joining: names this device's key holds that are on another account */
  elsewhere: readonly string[];
  sync: SyncStatus;
  /** What the last sign-in redirect or action said, for a toast; cleared by dismissNotice */
  notice: { kind: "ok" | "error"; text: string } | null;
}

const INITIAL: AccountState = {
  phase: "off",
  providers: [],
  account: null,
  join: null,
  firstSync: null,
  elsewhere: [],
  sync: { status: "idle", lastSyncedAt: null, error: null },
  notice: null,
};

let state: AccountState = INITIAL;
const listeners = new Set<() => void>();

export function getAccountState(): AccountState {
  return state;
}

export function subscribeAccount(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAccountState(): AccountState {
  return useSyncExternalStore(subscribeAccount, getAccountState, () => INITIAL);
}

const NOT_READY = "Accounts are not available yet";

/** Every action resolves null when it worked, else a sentence for the player */
export interface AccountActions {
  /** Reads the switches and the session, and handles a `#lc-account=` sign-in return; safe to call more than once */
  start(): void;
  /** Goes to the provider's page (the browser leaves the game); `returnTo` is a path on this site ("/play") */
  signIn(provider: SignInProvider, intent?: SignInIntent, returnTo?: string): void;
  passkey(mode: PasskeyMode): Promise<string | null>;
  confirmJoin(): Promise<string | null>;
  declineJoin(): Promise<void>;
  chooseFirstSync(choice: FirstSyncChoice): Promise<string | null>;
  syncNow(): Promise<string | null>;
  createLinkCode(): Promise<{ code: string; expiresAt: number } | string>;
  previewLinkCode(code: string): Promise<{ driverName: string | null; providers: AccountProvider[] } | string>;
  redeemLinkCode(code: string): Promise<string | null>;
  removeSession(id: string): Promise<string | null>;
  removeKey(id: string): Promise<string | null>;
  removePasskey(id: string): Promise<string | null>;
  removeIdentity(provider: SignInProvider): Promise<string | null>;
  signOut(): Promise<void>;
  deleteAccount(removeLaps: boolean): Promise<string | null>;
  dismissNotice(): void;
  /** A natural save point (back to the menu, Settings closed): pushes the save after a short wait, when signed in */
  pushSoon(): void;
}

export const accountActions: AccountActions = {
  start: () => {},
  signIn: () => {},
  passkey: async () => NOT_READY,
  confirmJoin: async () => NOT_READY,
  declineJoin: async () => {},
  chooseFirstSync: async () => NOT_READY,
  syncNow: async () => NOT_READY,
  createLinkCode: async () => NOT_READY,
  previewLinkCode: async () => NOT_READY,
  redeemLinkCode: async () => NOT_READY,
  removeSession: async () => NOT_READY,
  removeKey: async () => NOT_READY,
  removePasskey: async () => NOT_READY,
  removeIdentity: async () => NOT_READY,
  signOut: async () => {},
  deleteAccount: async () => NOT_READY,
  dismissNotice: () => {
    state = { ...state, notice: null };
    for (const l of listeners) l();
  },
  pushSoon: () => {},
};
