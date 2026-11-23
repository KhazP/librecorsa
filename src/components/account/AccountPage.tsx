"use client";

import React, { useEffect, useState } from "react";
import { accountActions, useAccountState } from "@/lib/account/account-store";
import { AccountNotice } from "./AccountDialogs";
import { AccountPanel } from "./AccountPanel";

/** How long the page waits for the account side to say it is on before it says accounts are not available (ms) */
const OFF_AFTER_MS = 4000;

/**
 * The body of /account: the account without the game. It starts the account side itself, so it works when the
 * game never loads; signing in here comes back here.
 */
export function AccountPageBody() {
  const { phase } = useAccountState();
  // The static page starts with accounts "off" until the account side has read the switches: only an answer from it,
  // or a long wait, says they really are off
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    accountActions.start();
    const id = window.setTimeout(() => setSettled(true), OFF_AFTER_MS);
    return () => window.clearTimeout(id);
  }, []);
  useEffect(() => {
    if (phase !== "off") setSettled(true);
  }, [phase]);

  return (
    <div className="flex w-full max-w-[760px] flex-col gap-3">
      {phase === "off" ? (
        <p className="lc-body m-0 text-[16px] text-lc-slate">
          {settled ? "Accounts are not available right now. Try again later." : "Checking your account"}
        </p>
      ) : (
        <AccountPanel where="page" />
      )}
      <AccountNotice />
    </div>
  );
}
