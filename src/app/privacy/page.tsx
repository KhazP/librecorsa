import type { Metadata } from "next";
import Link from "next/link";
import { Play } from "lucide-react";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { CONTACT_EMAIL, REPO_URL, SITE_NAME } from "@/lib/site";

// What the site keeps about the people who play it. Every statement here follows from the code: the browser's own
// storage, cloudflare/api (boards, races, rooms, usage) and the connection servers in multiplayer-sync.ts. Change this
// page in the same commit as anything that changes what is stored or sent.
const DESCRIPTION = "What LibreCorsa keeps in your browser, what it sends online and when, and how to have it removed.";
const UPDATED = "11 November 2026";

export const metadata: Metadata = {
  title: "Privacy",
  description: DESCRIPTION,
  alternates: { canonical: "/privacy" },
  openGraph: { type: "website", url: "/privacy", siteName: SITE_NAME, title: `Privacy | ${SITE_NAME}`, description: DESCRIPTION, locale: "en_US" },
};

const SECTION = "flex flex-col gap-4 border-t border-[#262B3D] pt-8";
const H2 = "lc-disp text-[28px] text-[#F5F7FA]";
const P = "m-0 max-w-[680px] text-[15px] leading-relaxed text-[#C5CBD8]";
const LIST = "m-0 flex max-w-[680px] list-disc flex-col gap-2.5 pl-5 text-[15px] leading-relaxed text-[#C5CBD8]";
const LINK = "text-[#F5F7FA] underline decoration-[#3A4157] underline-offset-4 hover:decoration-[#CCFF00]";
const B = "font-semibold text-[#F5F7FA]";

export default function PrivacyPage() {
  return (
    <main className="h-dvh overflow-y-auto bg-[#08090D] text-[#F5F7FA]">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-10 px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] sm:px-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <Link href="/" aria-label="LibreCorsa home" className="no-underline">
            <LibreCorsaLogo variant="compact" size="sm" />
          </Link>
          <Link
            href="/play"
            className="lc-title inline-flex items-center gap-2 rounded-full bg-[#CCFF00] px-5 py-2.5 text-[15px] text-[#08090D] no-underline transition-colors hover:bg-[#99BF00]"
          >
            <Play aria-hidden className="h-4 w-4" strokeWidth={2.5} />
            Play now
          </Link>
        </header>

        <section className="flex flex-col gap-4">
          <h1 className="lc-disp text-[clamp(44px,9vw,72px)] text-[#F5F7FA]">Privacy</h1>
          <p className="m-0 max-w-[680px] text-[17px] leading-relaxed text-[#C5CBD8]">
            LibreCorsa has no accounts, no ads and no third-party trackers, and it sets no cookies. You can play without
            giving a name. This page says what the game keeps, what it sends online and when.
          </p>
          <p className="m-0 text-[13px] text-[#8E96AA]">Last changed {UPDATED}</p>
        </section>

        <section className={SECTION} aria-labelledby="browser">
          <h2 id="browser" className={H2}>
            What stays in your browser
          </h2>
          <p className={P}>
            Your settings, controls, car setups, saved laps, race history and driver name are kept in your browser&apos;s
            own storage on your device. So is a driver key: a random code that proves a name on the lap boards is yours.
            None of it leaves your device except as described below, and clearing this site&apos;s data in your browser
            removes all of it.
          </p>
        </section>

        <section className={SECTION} aria-labelledby="online">
          <h2 id="online" className={H2}>
            What goes online, and when
          </h2>
          <ul className={LIST}>
            <li>
              <span className={B}>Lap boards.</span> When a lap is posted, the board stores your driver name and
              three-letter code, the lap (times, circuit, car, assists, realism, tyre) and a recording of it that others
              can race as a ghost. It also stores a scrambled form of your driver key, which can&apos;t be turned back
              into the key. Names and laps on a board are public. Laps are posted only once you have chosen a name of
              your own, and you can switch off &quot;Post my best laps online&quot; in the settings.
            </li>
            <li>
              <span className={B}>Open races.</span> The race server passes each car&apos;s position to the others while
              a race runs, and stores the result: the name you raced under, your place, times and best lap. The
              week&apos;s standings list a name only when its driver key proved it.
            </li>
            <li>
              <span className={B}>Rooms with friends.</span> The site pairs the players of a room code. After that the
              cars&apos; data goes straight between your browsers, so, as in any game that connects players directly,
              the other players&apos; devices can see your IP address. To find that direct route your browser asks
              public connection servers run by Google, which see your IP address and nothing else. Where no direct
              route exists, the data passes through a relay run by Cloudflare. If the site&apos;s own pairing is switched off,
              a public pairing service (PeerJS) pairs the room instead and sees your IP address too. Nothing from a room
              is stored.
            </li>
            <li>
              <span className={B}>Usage totals.</span> When a stretch of driving ends, the game reports the circuit, the
              car, the mode and the minutes driven. The site adds them to that day&apos;s totals, by country. The report
              carries no name, key or id, and it can&apos;t be tied to you or to your other sessions.
            </li>
          </ul>
        </section>

        <section className={SECTION} aria-labelledby="addresses">
          <h2 id="addresses" className={H2}>
            IP addresses and logs
          </h2>
          <p className={P}>
            The site is served by Cloudflare, which handles your IP address to deliver the pages, to work out the country
            for the usage totals, and to limit how often one address can post. Cloudflare keeps request logs for a few
            days. The site&apos;s own database stores no IP address. To limit lap uploads it keeps a scrambled form of
            the address for up to two hours and then deletes it.
          </p>
        </section>

        <section className={SECTION} aria-labelledby="kept">
          <h2 id="kept" className={H2}>
            How long it is kept
          </h2>
          <ul className={LIST}>
            <li>Laps and race results stay for as long as the boards exist, or until you ask for them to be removed.</li>
            <li>A driver name stays yours while you use it. After six months without a lap it can be claimed by someone else.</li>
            <li>The usage totals are kept as daily totals. They hold nothing about any one player.</li>
          </ul>
        </section>

        <section className={SECTION} aria-labelledby="choices">
          <h2 id="choices" className={H2}>
            Your choices
          </h2>
          <p className={P}>
            You can play without a name, switch off posting laps, and clear the browser&apos;s storage at any time. To see
            what is stored under your driver name, or to have your name, laps and race results deleted, email me at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className={LINK}>
              {CONTACT_EMAIL}
            </a>{" "}
            or open an issue on{" "}
            <a href={`${REPO_URL}/issues`} className={LINK}>
              GitHub
            </a>
            . Tell me the driver name; I will ask you to confirm it is yours.
          </p>
          <p className={P}>
            LibreCorsa is made and run by Alp Yalay. The code that does everything described here is open: the game and
            its online side are in the same{" "}
            <a href={REPO_URL} className={LINK}>
              repository
            </a>
            . This page changes whenever what the site keeps changes.
          </p>
        </section>
      </div>
    </main>
  );
}
