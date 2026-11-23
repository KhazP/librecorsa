"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "use-intl/react";
import { LEAD, SiteIntro, TEXT_LINK } from "@/components/home/SitePage";
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
  const tx = useTranslations("settings.account");
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
          {settled ? tx("unavailable") : tx("checking")}
        </p>
      ) : (
        <AccountPanel where="page" />
      )}
      <AccountNotice />
    </div>
  );
}

/** The page's heading and introduction, in the player's language like the account under it */
export function AccountIntro() {
  const tx = useTranslations("settings.account");
  return (
    <SiteIntro title={tx("signedOut.title")}>
      <p className={LEAD}>{tx("page.intro")}</p>
      <p className="lc-hint m-0">
        {tx.rich("page.privacy", {
          link: (chunks) => (
            <Link href="/privacy#accounts" className={TEXT_LINK}>
              {chunks}
            </Link>
          ),
        })}
      </p>
    </SiteIntro>
  );
}
