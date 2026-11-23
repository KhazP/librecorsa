"use client";

import React, { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
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
import { accountWords } from "@/lib/account/account-words";
import { AccountDialog, ErrorLine, TickBox } from "./AccountDialog";
import { formatAgo, formatDay, nameList, providerList, useInDesktopApp } from "./format";
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
  const tx = useTranslations("settings.account");
  const state = useAccountState();
  /** What the last thing done here said once the account went (deleted) */
  const [note, setNote] = useState<"deleted" | "deletedLaps" | null>(null);
  if (state.phase === "off") return null;
  if (state.phase === "loading") return <Quiet>{tx("checking")}</Quiet>;
  if (state.phase === "signed-out") return <SignedOut where={where} state={state} note={note ? tx(note) : null} />;
  if (!state.account) return <Quiet>{tx("checking")}</Quiet>;
  return (
    <SignedIn
      where={where}
      state={state}
      account={state.account}
      onDeleted={(removedLaps) => setNote(removedLaps ? "deletedLaps" : "deleted")}
    />
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Signed out

function SignedOut({ where, state, note }: { where: AccountWhere; state: AccountState; note: string | null }) {
  const tx = useTranslations("settings.account.signedOut");
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
        label={tx("codeLabel")}
        hint={tx("codeHint")}
      >
        <Button size="sm" variant="secondary" onClick={() => setCodeOpen(true)} data-nav-default={codeFirst ? "" : undefined}>
          {tx("enterCode")}
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
        title={where === "page" ? tx("titlePage") : tx("title")}
        description={tx("description")}
      >
        {codeFirst ? codeRow : null}
        {showOauth || passkeys ? (
          <SettingRow
            label={tx("signInWith")}
            hint={showOauth ? tx("oauthHint") : tx("passkeyHint")}
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
                  {tx("passkey")}
                </Button>
              ) : null}
            </div>
          </SettingRow>
        ) : null}
        {passkeys && where === "settings" ? (
          <SettingRow label={tx("createLabel")} hint={tx("createHint")}>
            <Button size="sm" variant="secondary" loading={busy === "create"} onClick={() => passkey("create")}>
              {tx("create")}
            </Button>
          </SettingRow>
        ) : null}
        {codeFirst ? null : codeRow}
        {desktop && oauth.length > 0 ? (
          <p className="lc-hint m-0 pt-1">
            {where === "settings"
              ? tx("needsBrowserCode", { providers: providerList(oauth) })
              : tx("needsBrowser", { providers: providerList(oauth) })}
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

type Words = ReturnType<typeof useTranslations<"settings.account">>;

/** The question and its explanation before a way in or a driver key comes off the account */
function removalText(r: Removal, tx: Words) {
  if (r.kind === "identity") {
    const provider = PROVIDER_LABELS[r.provider];
    return { title: tx("remove.identityTitle", { provider }), body: tx("remove.identityBody", { provider }) };
  }
  if (r.kind === "passkey") return { title: tx("remove.passkeyTitle"), body: tx("remove.passkeyBody") };
  return { title: tx("remove.keyTitle"), body: tx("remove.keyBody", { label: r.label }) };
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
  const tx = useTranslations("settings.account");
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
  const lastWay = waysIn <= 1 ? tx("signedIn.lastWay") : undefined;
  const signedInWith = providerList(
    [...account.identities.map((i) => i.provider), ...(account.passkeys.length ? ["passkey" as const] : [])],
    true,
  );

  const sync = state.sync;
  const syncHint =
    sync.status === "syncing"
      ? tx("signedIn.syncing")
      : sync.status === "error" && sync.error
        ? accountWords(sync.error)
        : sync.lastSyncedAt
          ? tx("signedIn.synced", { ago: formatAgo(sync.lastSyncedAt, now) })
          : account.save
            ? tx("signedIn.cloudWritten", { ago: formatAgo(account.save.updatedAt, now) })
            : tx("signedIn.notSynced");
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
  const text = removing ? removalText(removing, tx) : null;

  return (
    <>
      {/* Named by its driver name, the way other players know it; no label line above it */}
      <Card
        title={account.driverName ?? tx("signedIn.yourAccount")}
        description={signedInWith ? tx("signedIn.signedInWith", { ways: signedInWith }) : undefined}
      >
        {firstSyncWaiting ? (
          <SettingRow label={tx("signedIn.combineLabel")} hint={tx("signedIn.combineHint")}>
            <Button size="sm" variant="primary" onClick={accountUi.reopenFirstSync} data-nav-default="">
              {tx("signedIn.choose")}
            </Button>
          </SettingRow>
        ) : null}
        <SettingRow label={tx("signedIn.save")} hint={<span className={sync.status === "error" ? "text-lc-loss" : undefined}>{syncHint}</span>}>
          <Button
            size="sm"
            variant="secondary"
            icon={<Icon name="refresh" />}
            loading={top.busy === "sync" || sync.status === "syncing"}
            onClick={() => void top.run("sync", () => accountActions.syncNow())}
            data-nav-default={firstSyncWaiting ? undefined : ""}
          >
            {tx("signedIn.syncNow")}
          </Button>
        </SettingRow>
        <SettingRow label={tx("signedIn.signOut")} hint={tx("signedIn.signOutHint")}>
          <Button size="sm" variant="secondary" icon={<Icon name="leave" />} loading={top.busy === "signout"} onClick={() => void top.run("signout", () => accountActions.signOut())}>
            {tx("signedIn.signOut")}
          </Button>
        </SettingRow>
        <ShowCodeRow />
        <ErrorLine error={top.error} className="pt-1" />
      </Card>

      <Card
        title={tx("names.title")}
        description={tx("names.description")}
      >
        {account.names.length ? (
          <ul className="m-0 flex list-none flex-col p-0">
            {account.names.map((n) => (
              <li key={n.nameKey} className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-0.5 border-b border-lc-line py-2 last:border-b-0">
                <span className="lc-row-label min-w-0 truncate">{n.displayName}</span>
                <span className="lc-hint">{n.lastSeen ? tx("names.lastLap", { ago: formatAgo(n.lastSeen, now) }) : tx("names.noLaps")}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="lc-body m-0 py-1">{tx("names.none")}</p>
        )}
        {state.elsewhere.length ? (
          <div className="flex flex-col gap-2 pt-2">
            <p className="m-0 flex items-start gap-2 text-[13px] leading-[1.45] font-medium text-lc-caution">
              <Icon name="warning" size="sm" className="mt-px" />
              <span>
                {tx("names.elsewhere", { count: state.elsewhere.length, names: nameList(state.elsewhere) })}
              </span>
            </p>
          </div>
        ) : null}
      </Card>

      <Card title={tx("ways.title")} description={tx("ways.description")}>
        {offered.map((p) => {
          const id = account.identities.find((i) => i.provider === p);
          return (
            <SettingRow
              key={p}
              label={PROVIDER_LABELS[p]}
              hint={
                id
                  ? id.lastUsedAt
                    ? tx("ways.addedUsed", { date: formatDay(id.linkedAt), ago: formatAgo(id.lastUsedAt, now) })
                    : tx("ways.added", { date: formatDay(id.linkedAt) })
                  : tx("ways.notAdded")
              }
            >
              {id ? (
                <Button size="sm" variant="ghost" icon={<Icon name="remove" />} disabledReason={lastWay} onClick={() => setRemoving({ kind: "identity", provider: p })}>
                  {tx("ways.remove")}
                </Button>
              ) : (
                <Button size="sm" variant="secondary" icon={<Icon name="add" />} onClick={() => accountActions.signIn(p, "link", RETURN_TO[where])}>
                  {tx("ways.add")}
                </Button>
              )}
            </SettingRow>
          );
        })}
        {account.passkeys.map((k) => (
          <SettingRow
            key={k.id}
            label={tx("ways.passkeyName", { date: formatDay(k.createdAt) })}
            hint={k.lastUsedAt ? tx("ways.used", { ago: formatAgo(k.lastUsedAt, now) }) : tx("ways.added", { date: formatDay(k.createdAt) })}
          >
            <Button size="sm" variant="ghost" icon={<Icon name="remove" />} disabledReason={lastWay} onClick={() => setRemoving({ kind: "passkey", id: k.id })}>
              {tx("ways.remove")}
            </Button>
          </SettingRow>
        ))}
        {passkeysOffered ? (
          <SettingRow label={tx("ways.addPasskey")} hint={tx("ways.addPasskeyHint")}>
            <Button size="sm" variant="secondary" icon={<Icon name="add" />} loading={ways.busy === "add"} onClick={() => void ways.run("add", () => accountActions.passkey("add"))}>
              {tx("ways.add")}
            </Button>
          </SettingRow>
        ) : null}
        {passkeysOffered && state.elsewhere.length ? (
          <SettingRow label={tx("ways.combinePasskey")} hint={tx("ways.combinePasskeyHint")}>
            <Button size="sm" variant="secondary" loading={ways.busy === "link"} onClick={() => void ways.run("link", () => accountActions.passkey("link"))}>
              {tx("ways.usePasskey")}
            </Button>
          </SettingRow>
        ) : null}
        {desktop ? <p className="lc-hint m-0 pt-1">{tx("ways.desktopOthers")}</p> : null}
        <ErrorLine error={ways.error} className="pt-1" />
      </Card>

      <Card title={tx("devices.title")} description={tx("devices.description")}>
        {account.sessions.map((s) => (
          <SettingRow
            key={s.id}
            label={
              <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0">{s.label || (s.current ? tx("devices.thisBrowser") : tx("devices.notJoined"))}</span>
                {s.current ? <Badge size="sm" tone="info">{tx("devices.thisDevice")}</Badge> : null}
              </span>
            }
            hint={tx("devices.seen", { date: formatDay(s.createdAt), ago: formatAgo(s.lastSeenAt, now) })}
          >
            {s.current ? null : (
              <Button size="sm" variant="ghost" icon={<Icon name="leave" />} loading={devices.busy === `session:${s.id}`} onClick={() => void devices.run(`session:${s.id}`, () => accountActions.removeSession(s.id))}>
                {tx("devices.signOut")}
              </Button>
            )}
          </SettingRow>
        ))}
        <ErrorLine error={devices.error} className="pt-1" />
      </Card>

      <Card
        title={tx("keys.title")}
        description={tx("keys.description")}
      >
        {account.keys.length ? (
          account.keys.map((k) => {
            const label = k.label || tx("keys.fallback", { id: k.id.slice(0, 6) });
            return (
              <SettingRow
                key={k.id}
                label={
                  <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0">{label}</span>
                    {k.current ? <Badge size="sm" tone="info">{tx("devices.thisDevice")}</Badge> : null}
                  </span>
                }
                hint={
                  k.lastUsedAt
                    ? tx("keys.addedLap", { date: formatDay(k.addedAt), ago: formatAgo(k.lastUsedAt, now) })
                    : tx("keys.added", { date: formatDay(k.addedAt) })
                }
              >
                {k.current ? null : (
                  <Button size="sm" variant="ghost" icon={<Icon name="remove" />} onClick={() => setRemoving({ kind: "key", id: k.id, label })}>
                    {tx("ways.remove")}
                  </Button>
                )}
              </SettingRow>
            );
          })
        ) : (
          <p className="lc-body m-0 py-1">{tx("keys.none")}</p>
        )}
        <ErrorLine error={keys.error} className="pt-1" />
      </Card>

      <Card title={tx("delete.title")}>
        <SettingRow label={tx("delete.label")} hint={tx("delete.hint")}>
          <Button size="sm" variant="danger" icon={<Icon name="delete" />} onClick={() => setDeleting(true)}>
            {tx("delete.button")}
          </Button>
        </SettingRow>
      </Card>

      <ConfirmDialog
        open={removing !== null}
        title={text?.title ?? ""}
        confirmLabel={tx("remove.confirm")}
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
  const tx = useTranslations("settings.account.delete");
  const tc = useTranslations("common.confirm");
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
      title={tx("question")}
      onDismiss={onClose}
      busy={busy}
      error={error}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabledReason={busy ? tc("busy") : undefined} data-nav-default="">
            {tc("cancel")}
          </Button>
          <Button variant="danger" icon={<Icon name="delete" />} loading={busy} onClick={() => void confirm()}>
            {tx("confirm")}
          </Button>
        </>
      }
    >
      <p className="m-0">{tx("body")}</p>
      <p className="m-0">
        {removeLaps ? tx("lapsGo") : tx("lapsStay")}
      </p>
      <TickBox checked={removeLaps} onChange={setRemoveLaps} disabled={busy}>
        {tx("tick")}
      </TickBox>
    </AccountDialog>
  );
}
