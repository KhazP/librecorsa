import type { Metadata } from "next";
import { TrackGate } from "@/components/TrackGate";
import { AccountDialogs } from "@/components/account/AccountDialogs";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";

export const metadata: Metadata = {
  title: "Play",
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/play" },
  openGraph: { type: "website", url: "/play", siteName: SITE_NAME, title: `Play | ${SITE_NAME}`, description: SITE_DESCRIPTION, locale: "en_US" },
};

/** The game itself. The home page (src/app/page.tsx) links here; nothing of the simulator loads before that. */
export default function PlayPage() {
  return (
    <main className="h-dvh w-screen overflow-hidden bg-lc-void">
      {/* Read by screen readers and search engines; the game itself draws to a canvas */}
      <h1 className="sr-only">Play LibreCorsa: free open-source racing simulator in your browser</h1>
      <p className="sr-only">{SITE_DESCRIPTION}</p>
      <TrackGate />
      {/* Once for the whole page, across circuit reloads: starts the account side and asks its questions */}
      <AccountDialogs />
    </main>
  );
}
