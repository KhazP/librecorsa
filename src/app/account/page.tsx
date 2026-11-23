import type { Metadata } from "next";
import { AccountIntro, AccountPageBody } from "@/components/account/AccountPage";
import { SitePage } from "@/components/home/SitePage";
import { SITE_NAME } from "@/lib/site";

// The account outside the game: sign in, see what the account holds, sign out or delete it. App stores ask for a web
// page that deletes an account; this is it, and it needs nothing of the game to load
const DESCRIPTION = "Sign in to your LibreCorsa account to see its driver names, sign-ins and devices, or to delete it.";

export const metadata: Metadata = {
  title: "Account",
  description: DESCRIPTION,
  alternates: { canonical: "/account" },
  openGraph: { type: "website", url: "/account", siteName: SITE_NAME, title: `Account | ${SITE_NAME}`, description: DESCRIPTION, locale: "en_US" },
  twitter: { card: "summary", title: `Account | ${SITE_NAME}`, description: DESCRIPTION },
};

export default function AccountPage() {
  return (
    <SitePage>
      <AccountIntro />
      <AccountPageBody />
    </SitePage>
  );
}
