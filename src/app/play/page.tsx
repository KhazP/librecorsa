import type { Metadata } from "next";
import { TrackGate } from "@/components/TrackGate";
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
    <main className="h-screen w-screen overflow-hidden bg-[#07070c]">
      {/* Read by screen readers and search engines; the game itself draws to a canvas */}
      <h1 className="sr-only">Play LibreCorsa: free open-source racing simulator in your browser</h1>
      <p className="sr-only">{SITE_DESCRIPTION}</p>
      <TrackGate />
    </main>
  );
}
