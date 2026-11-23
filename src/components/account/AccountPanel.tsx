"use client";

import React, { useEffect, useRef, useState } from "react";
import { Button, Card, ConfirmDialog, SettingRow } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons";
import { accountActions, useAccountState, type AccountState } from "@/lib/account/account-store";
import {
  PROVIDER_LABELS,
  SIGN_IN_PROVIDERS,
  type AccountInfo,
  type PasskeyMode,
  type SignInProvider,
} from "@/lib/account/api-types";
import { AccountDialog, ErrorLine, TickBox } from "./AccountDialog";
import { formatAgo, formatDay, providerList, useInDesktopApp } from "./format";
import { LinkCodeDialog } from "./LinkCodeDialog";
import { ShowCodeRow } from "./ShowCodeRow";
import { accountUi, useAccountUi } from "./ui-state";

/**
 * Where the account screen is drawn: Settings > Profile and data > Account in the game, or the /account page, which
 * works without the game (signing in there comes back to it, and it offers no code sign-in: a device joins an
 * account in the game)
 */
export type AccountWhere = "settings" | "page";

/** The page a sign-in comes back to */
const RETURN_TO: Record<AccountWhere, string> = { settings: "/play", page: "/account" };

/** One action at a time per card: which one runs (its key), and what the last one said */
function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = async (key: string, action: () => Promise<string | null | void>): Promise<boolean> => {
    if (busy) return false;
    setBusy(key);
    setError(null);
    const failed = await action();
    if (!alive.current) return !failed;
    setBusy(null);
    if (failed) setError(failed);
    return !failed;
  };
  return { busy, error, run, setError };
}

/** A quiet line in place of the account while it is read */
function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="lc-hint m-0 px-1 py-3">{children}</p>;
}

/** The account screen: signed out, the ways in; signed in, the account and everything on it */
export function AccountPanel({ where }: { where: AccountWhere }) {
  const state = useAccountState();
  /** What the last thing done here said once the account went (deleted) */
  const [note, setNote] = useState<string | null>(null);
  if (state.phase === "off") return null;
  if (state.phase === "loading") return <Quiet>Checking your account</Quiet>;
  if (state.phase === "signed-out") return <SignedOut where={where} state={state} note={note} />;
  if (!state.account) return <Quiet>Checking your account</Quiet>;
  return (
    <SignedIn
      where={where}
      state={state}
      account={state.account}
      onDeleted={(removedLaps) => setNote(removedLaps ? "The account and its laps are deleted." : "The account is deleted.")}
    />
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Signed out

function SignedOut({ where, state, note }: { where: AccountWhere; state: AccountState; note: string | null }) {
  const desktop = useInDesktopApp();
  const { busy, error, run } = useAction();
  const [codeOpen, setCodeOpen] = useState(false);
  const [leaving, setLeaving] = useState<SignInProvider | null>(null);
  const oauth = SIGN_IN_PROVIDERS.filter((p) => state.providers.includes(p));
  const passkeys = state.providers.includes("passkey");
  // The desktop app can't come back from a sign-in page: it leads with the code, then the passkey
  const showOauth = !desktop && oauth.length > 0;
  const codeFirst = desktop && where === "settings";

  // The page leaves for the provider's: if it hasn't after a while (blocked, offline), the buttons come back
  useEffect(() => {
    if (!leaving) return;
    const id = window.setTimeout(() => setLeaving(null), 8000);
    return () => window.clearTimeout(id);
  }, [leaving]);

  const signIn = (p: SignInProvider) => {
    setLeaving(p);
    accountActions.signIn(p, "signin", RETURN_TO[where]);
  };
  const passkey = (mode: PasskeyMode) => void run(mode, () => accountActions.passkey(mode));

  const codeRow =
    where === "settings" ? (
      <SettingRow
        label="Use a code from another device"
        hint="On a device that is signed in, choose Show a code, then type it here"
      >
        <Button size="sm" variant="secondary" onClick={() => setCodeOpen(true)} data-nav-default={codeFirst ? "" : undefined}>
          Enter a code
        </Button>
      </SettingRow>
    ) : null;

  return (
    <>
      {note ? (
        <p className="lc-body m-0 flex items-center gap-2 px-1 text-lc-chalk">
          <Icon name="success" size="md" className="text-lc-gain" />
          {note}
        </p>
      ) : null}
      {/* On /account the page's own heading already says Account */}
      <Card
        title={where === "page" ? "Sign in" : "Account"}
        description="Sign in to keep your driver names and save on every device. No email is collected."
      >
        {codeFirst ? codeRow : null}
        {showOauth || passkeys ? (
          <SettingRow
            label="Sign in with"
            hint={showOauth ? "Opens their sign-in page, then comes back here" : "A passkey on this device, a phone or a security key"}
          >
            <div className="flex min-w-0 flex-wrap justify-end gap-2">
              {showOauth
                ? oauth.map((p, i) => (
                    <Button
                      key={p}
                      size="sm"
                      variant="secondary"
                      loading={leaving === p}
                      disabled={leaving !== null && leaving !== p}
                      onClick={() => signIn(p)}
                      data-nav-default={!codeFirst && i === 0 ? "" : undefined}
                    >
                      {PROVIDER_LABELS[p]}
                    </Button>
                  ))
                : null}
              {passkeys ? (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Icon name="locked" />}
                  loading={busy === "signin"}
                  onClick={() => passkey("signin")}
                  data-nav-default={!codeFirst && !showOauth ? "" : undefined}
                >
                  Passkey
                </Button>
              ) : null}
            </div>
          </SettingRow>
        ) : null}
        {passkeys && where === "settings" ? (
          <SettingRow label="Create an account with a passkey" hint="No other sign-in needed">
            <Button size="sm" variant="secondary" loading={busy === "create"} onClick={() => passkey("create")}>
              Create
            </Button>
          </SettingRow>
        ) : null}
        {codeFirst ? null : codeRow}
        {desktop && oauth.length > 0 ? (
          <p className="lc-hint m-0 pt-1">
            {where === "settings"
              ? `${providerList(oauth)} sign-in needs a browser. Sign in at librecorsa.org/account, choose Show a code, and type it here.`
              : `${providerList(oauth)} sign-in needs a browser.`}
          </p>
        ) : null}
        <ErrorLine error={error} className="pt-1" />
      </Card>
      {where === "settings" ? <LinkCodeDialog open={codeOpen} onClose={() => setCodeOpen(false)} /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Signed in

type Removal =
  | { kind: "identity"; provider: SignInProvider }
  | { kind: "passkey"; id: string }
  | { kind: "key"; id: string; label: string };

const REMOVAL_TEXT = {
  identity: (r: Extract<Removal, { kind: "identity" }>) => ({
    title: `Remove the ${PROVIDER_LABELS[r.provider]} sign-in?`,
    body: `${PROVIDER_LABELS[r.provider]} no longer signs in to this account. You can add it again later.`,
  }),
  passkey: () => ({
    title: "Remove this passkey?",
    body: "It no longer signs in to this account. You can also delete it from the device or password manager that keeps it.",
  }),
  key: (r: Extract<Removal, { kind: "key" }>) => ({
    title: "Remove this driver key?",
    body: `Laps from ${r.label} no longer post under the account's names. Its laps already on the boards stay.`,
  }),
};

function removalText(r: Removal) {
  if (r.kind === "identity") return REMOVAL_TEXT.identity(r);
  if (r.kind === "passkey") return REMOVAL_TEXT.passkey();
  return REMOVAL_TEXT.key(r);
}

function SignedIn({
  where,
  state,
  account,
  onDeleted,
}: {
  where: AccountWhere;
  state: AccountState;
  account: AccountInfo;
  onDeleted: (removedLaps: boolean) => void;
}) {
  const desktop = useInDesktopApp();
  const ui = useAccountUi();
  const top = useAction();
  const ways = useAction();
  const devices = useAction();
  const keys = useAction();
  const [removing, setRemoving] = useState<Removal | null>(null);
  const [deleting, setDeleting] = useState(false);
  const now = Date.now();

  const linked = new Set(account.identities.map((i) => i.provider));
  const offered = SIGN_IN_PROVIDERS.filter((p) => linked.has(p) || (state.providers.includes(p) && !desktop));
  const passkeysOffered = state.providers.includes("passkey") || account.passkeys.length > 0;
  const waysIn = account.identities.length + account.passkeys.length;
  const lastWay = waysIn <= 1 ? "The last way in can't be removed. Delete the account instead." : undefined;
  const signedInWith = providerList(
    [...account.identities.map((i) => i.provider), ...(account.passkeys.length ? ["passkey" as const] : [])],
    true,
  );

  const sync = state.sync;
  const syncHint =
    sync.status === "syncing"
      ? "Syncing now"
      : sync.status === "error" && sync.error
        ? sync.error
        : sync.lastSyncedAt
          ? `Synced ${formatAgo(sync.lastSyncedAt, now)}`
          : account.save
            ? `The cloud save was written ${formatAgo(account.save.updatedAt, now)}`
            : "Not synced yet";
  const firstSyncWaiting = where === "settings" && state.firstSync !== null && ui.firstSyncDeferred;

  const confirmRemoval = async () => {
    const r = removing;
    if (!r) return;
    const runner = r.kind === "key" ? keys : ways;
    await runner.run(`remove:${r.kind}`, () =>
      r.kind === "identity"
        ? accountActions.removeIdentity(r.provider)
        : r.kind === "passkey"
          ? accountActions.removePasskey(r.id)
          : accountActions.removeKey(r.id),
    );
    setRemoving(null);
  };
  const removalBusy = removing ? (removing.kind === "key" ? keys.busy : ways.busy) !== null : false;
  const text = removing ? removalText(removing) : null;

  return (
    <>
      {/* Named by its driver name, the way other players know it; no label line above it */}
      <Card
        title={account.driverName ?? "Your account"}
        description={signedInWith ? `Signed in with ${signedInWith}` : undefined}
      >
        {firstSyncWaiting ? (
          <SettingRow label="Saves to combine" hint="This device and the account both have a save">
            <Button size="sm" variant="primary" onClick={accountUi.reopenFirstSync} data-nav-default="">
              Choose
            </Button>
          </SettingRow>
        ) : null}
        <SettingRow label="Save" hint={<span className={sync.status === "error" ? "text-lc-loss" : undefined}>{syncHint}</span>}>
          <Button
            size="sm"
            variant="secondary"
            icon={<Icon name="refresh" />}
            loading={top.busy === "sync" || sync.status === "syncing"}
            onClick={() => void top.run("sync", () => accountActions.syncNow())}
            data-nav-default={firstSyncWaiting ? undefined : ""}
          >
            Sync now
          </Button>
        </SettingRow>
        <SettingRow label="Sign out" hint="This device keeps its save. It posts laps under your names again once you sign in">
          <Button size="sm" variant="secondary" icon={<Icon name="leave" />} loading={top.busy === "signout"} onClick={() => void top.run("signout", () => accountActions.signOut())}>
            Sign out
          </Button>
        </SettingRow>
        <ShowCodeRow />
        <ErrorLine error={top.error} className="pt-1" />
      </Card>

      <Card
        title="Driver names"
        description="Every device on this account can post laps under these names. They stay yours while the account exists."
      >
        {account.names.length ? (
          <ul className="m-0 flex list-none flex-col p-0">
            {account.names.map((n) => (
              <li key={n.nameKey} className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-0.5 border-b border-lc-line py-2 last:border-b-0">
                <span className="lc-row-label min-w-0 truncate">{n.displayName}</span>
                <span className="lc-hint">{n.lastSeen ? `Last lap ${formatAgo(n.lastSeen, now)}` : "No laps yet"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="lc-body m-0 py-1">No driver names yet. The name you post your first lap under joins the account.</p>
        )}
        {state.elsewhere.length ? (
          <div className="flex flex-col gap-2 pt-2">
            <p className="m-0 flex items-start gap-2 text-[13px] leading-[1.45] font-medium text-lc-caution">
              <Icon name="warning" size="sm" className="mt-px" />
              <span>
                {`${listNames(state.elsewhere)} ${state.elsewhere.length === 1 ? "is" : "are"} on another account. To combine the two, add that account's sign-in below.`}
              </span>
            </p>
          </div>
        ) : null}
      </Card>

      <Card title="Ways to sign in" description="Only the account's id at each is kept: no email, user name or picture.">
        {offered.map((p) => {
          const id = account.identities.find((i) => i.provider === p);
          return (
            <SettingRow
              key={p}
              label={PROVIDER_LABELS[p]}
              hint={id ? `Added ${formatDay(id.linkedAt)}${id.lastUsedAt ? `, used ${formatAgo(id.lastUsedAt, now)}` : ""}` : "Not added"}
            >
              {id ? (
                <Button size="sm" variant="ghost" icon={<Icon name="remove" />} disabledReason={lastWay} onClick={() => setRemoving({ kind: "identity", provider: p })}>
                  Remove
                </Button>
              ) : (
                <Button size="sm" variant="secondary" icon={<Icon name="add" />} onClick={() => accountActions.signIn(p, "link", RETURN_TO[where])}>
                  Add
                </Button>
              )}
            </SettingRow>
          );
        })}
        {account.passkeys.map((k) => (
          <SettingRow key={k.id} label={k.label} hint={k.lastUsedAt ? `Used ${formatAgo(k.lastUsedAt, now)}` : `Added ${formatDay(k.createdAt)}`}>
            <Button size="sm" variant="ghost" icon={<Icon name="remove" />} disabledReason={lastWay} onClick={() => setRemoving({ kind: "passkey", id: k.id })}>
              Remove
            </Button>
          </SettingRow>
        ))}
        {passkeysOffered ? (
          <SettingRow label="Add a passkey" hint="Signs in with this device's screen lock, a phone or a security key">
            <Button size="sm" variant="secondary" icon={<Icon name="add" />} loading={ways.busy === "add"} onClick={() => void ways.run("add", () => accountActions.passkey("add"))}>
              Add
            </Button>
          </SettingRow>
        ) : null}
        {passkeysOffered && state.elsewhere.length ? (
          <SettingRow label="Combine with an account that has a passkey" hint="Its names, devices and save join this account">
            <Button size="sm" variant="secondary" loading={ways.busy === "link"} onClick={() => void ways.run("link", () => accountActions.passkey("link"))}>
              Use passkey
            </Button>
          </SettingRow>
        ) : null}
        {desktop ? <p className="lc-hint m-0 pt-1">Other sign-ins can be added at librecorsa.org/account in a browser.</p> : null}
        <ErrorLine error={ways.error} className="pt-1" />
      </Card>

      <Card title="Devices" description="The browsers and apps signed in to this account.">
        {account.sessions.map((s) => (
          <SettingRow
            key={s.id}
            label={
              <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0">{s.label || (s.current ? "This browser" : "A device that hasn't joined yet")}</span>
                {s.current ? <Badge size="sm" tone="info">This device</Badge> : null}
              </span>
            }
            hint={`Signed in ${formatDay(s.createdAt)}, last seen ${formatAgo(s.lastSeenAt, now)}`}
          >
            {s.current ? null : (
              <Button size="sm" variant="ghost" icon={<Icon name="leave" />} loading={devices.busy === `session:${s.id}`} onClick={() => void devices.run(`session:${s.id}`, () => accountActions.removeSession(s.id))}>
                Sign out
              </Button>
            )}
          </SettingRow>
        ))}
        <ErrorLine error={devices.error} className="pt-1" />
      </Card>

      <Card
        title="Driver keys"
        description="Each device signs its laps with its own driver key. Every key here may post under the account's names."
      >
        {account.keys.length ? (
          account.keys.map((k) => {
            const label = k.label || `Driver key ${k.id.slice(0, 6)}`;
            return (
              <SettingRow
                key={k.id}
                label={
                  <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0">{label}</span>
                    {k.current ? <Badge size="sm" tone="info">This device</Badge> : null}
                  </span>
                }
                hint={`Added ${formatDay(k.addedAt)}${k.lastUsedAt ? `, last lap ${formatAgo(k.lastUsedAt, now)}` : ""}`}
              >
                {k.current ? null : (
                  <Button size="sm" variant="ghost" icon={<Icon name="remove" />} onClick={() => setRemoving({ kind: "key", id: k.id, label })}>
                    Remove
                  </Button>
                )}
              </SettingRow>
            );
          })
        ) : (
          <p className="lc-body m-0 py-1">No driver keys yet. A device adds its key when it joins the account.</p>
        )}
        <ErrorLine error={keys.error} className="pt-1" />
      </Card>

      <Card title="Delete account">
        <SettingRow label="Delete this account" hint="Deletes its sign-ins and cloud save. You choose whether your laps stay">
          <Button size="sm" variant="danger" icon={<Icon name="delete" />} onClick={() => setDeleting(true)}>
            Delete
          </Button>
        </SettingRow>
      </Card>

      <ConfirmDialog
        open={removing !== null}
        title={text?.title ?? ""}
        confirmLabel="Remove"
        busy={removalBusy}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void confirmRemoval()}
      >
        {text?.body ?? ""}
      </ConfirmDialog>
      <DeleteDialog open={deleting} onClose={() => setDeleting(false)} onDeleted={onDeleted} />
    </>
  );
}

/** "Alp", "Alp and Bo", "Alp, Bo and Cy" */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Delete account: the one question, with the tick box for the laps (off unless ticked) */
function DeleteDialog({
  open,
  onClose,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  onDeleted: (removedLaps: boolean) => void;
}) {
  const [removeLaps, setRemoveLaps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setRemoveLaps(false);
    setBusy(false);
    setError(null);
  }, [open]);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const failed = await accountActions.deleteAccount(removeLaps);
    setBusy(false);
    if (failed) {
      setError(failed);
      return;
    }
    onClose();
    onDeleted(removeLaps);
  };

  return (
    <AccountDialog
      open={open}
      tone="danger"
      title="Delete this account?"
      onDismiss={onClose}
      busy={busy}
      error={error}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabledReason={busy ? "Wait for it to finish" : undefined} data-nav-default="">
            Cancel
          </Button>
          <Button variant="danger" icon={<Icon name="delete" />} loading={busy} onClick={() => void confirm()}>
            Delete account
          </Button>
        </>
      }
    >
      <p className="m-0">This deletes the account, its sign-ins and its cloud save. What is saved on this device stays.</p>
      <p className="m-0">
        {removeLaps
          ? "Your driver names come off the boards with their laps, race results and badges, and are free for anyone to take."
          : "Your driver names and laps stay on the boards. Without an account, a name lapses after six months without a lap."}
      </p>
      <TickBox checked={removeLaps} onChange={setRemoveLaps} disabled={busy}>
        Also remove my laps and race results from the boards
      </TickBox>
    </AccountDialog>
  );
}
