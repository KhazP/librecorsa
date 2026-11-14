import type { Metadata } from "next";
import { LEAD, READ, SiteIntro, SitePage, SiteSection, TEXT_LINK } from "@/components/home/SitePage";
import { CONTACT_EMAIL, REPO_URL, SITE_NAME } from "@/lib/site";

// What the site keeps about the people who play it. Every statement here follows from the code: the browser's own
// storage, cloudflare/api (boards, races, rooms, usage) and the connection servers in multiplayer-sync.ts. Change this
// page in the same commit as anything that changes what is stored or sent.
const DESCRIPTION = "What LibreCorsa keeps in your browser, what it sends online and when, and how to have it removed.";
const UPDATED = "12 November 2026";

export const metadata: Metadata = {
  title: "Privacy",
  description: DESCRIPTION,
  alternates: { canonical: "/privacy" },
  openGraph: { type: "website", url: "/privacy", siteName: SITE_NAME, title: `Privacy | ${SITE_NAME}`, description: DESCRIPTION, locale: "en_US" },
  twitter: { card: "summary", title: `Privacy | ${SITE_NAME}`, description: DESCRIPTION },
};

const LIST = "lc-body m-0 flex max-w-[68ch] list-disc flex-col gap-3 pl-5 text-[16px] leading-[1.6] marker:text-lc-dim";
const B = "font-semibold text-lc-chalk";

export default function PrivacyPage() {
  return (
    <SitePage>
      <SiteIntro title="Privacy">
        <p className={LEAD}>
          LibreCorsa has no accounts, no ads and no third-party trackers, and it sets no cookies. You can play without
          giving a name. This page says what the game keeps, what it sends online and when.
        </p>
        <p className="lc-hint m-0">Last changed {UPDATED}</p>
      </SiteIntro>

      <SiteSection id="browser" title="What stays in your browser">
        <p className={READ}>
          Your settings, controls, car setups, saved laps, race history and driver name are kept in your browser’s
          own storage on your device. So is a driver key: a random code that proves a name on the lap boards is yours.
          None of it leaves your device except as described below, and clearing this site’s data in your browser
          removes all of it.
        </p>
      </SiteSection>

      <SiteSection id="online" title="What goes online, and when">
        <ul className={LIST}>
          <li>
            <span className={B}>Lap boards.</span> When a lap is posted, the board stores your driver name and
            three-letter code, the lap (times, circuit, car, assists, realism, tyre) and a recording of it that others
            can race as a ghost. It also stores a scrambled form of your driver key, which can’t be turned back
            into the key. Names and laps on a board are public. Laps are posted only once you have chosen a name of
            your own, and you can switch off “Post my best laps online” in the settings.
          </li>
          <li>
            <span className={B}>Open races.</span> The race server passes each car’s position to the others while
            a race runs, and stores the result: the name you raced under, your place, times and best lap. The
            week’s standings list a name only when its driver key proved it.
          </li>
          <li>
            <span className={B}>Rooms with friends.</span> The site pairs the players of a room code. After that the
            cars’ data goes straight between your browsers, so, as in any game that connects players directly,
            the other players’ devices can see your IP address. To find that direct route your browser asks
            public connection servers run by Google, which see your IP address and nothing else. Where no direct
            route exists, the data passes through a relay run by Cloudflare. If the site’s own pairing is switched off,
            a public pairing service (PeerJS) pairs the room instead and sees your IP address too. Nothing from a room
            is stored.
          </li>
          <li>
            <span className={B}>Usage totals.</span> When a stretch of driving ends, the game reports the circuit, the
            car, the mode and the minutes driven. The site adds them to that day’s totals, by country. It also
            says what you drove with (keyboard, controller, wheel or touch screen), on what (desktop, tablet or phone),
            whether the track was wet, which assists were on and which version of the game you had. Each of these is
            counted on its own, never combined with another or with the circuit or country. The report carries no
            name, key or id, and it can’t be tied to you or to your other sessions.
          </li>
        </ul>
      </SiteSection>

      <SiteSection id="addresses" title="IP addresses and logs">
        <p className={READ}>
          The site is served by Cloudflare, which handles your IP address to deliver the pages, to work out the country
          for the usage totals, and to limit how often one address can post. Cloudflare keeps request logs for a few
          days. The site’s own database stores no IP address. To limit lap uploads it keeps a scrambled form of
          the address for up to two hours and then deletes it.
        </p>
      </SiteSection>

      <SiteSection id="kept" title="How long it is kept">
        <ul className={LIST}>
          <li>Laps and race results stay for as long as the boards exist, or until you ask for them to be removed.</li>
          <li>A driver name stays yours while you use it. After six months without a lap it can be claimed by someone else.</li>
          <li>The usage totals are kept as daily totals. They hold nothing about any one player.</li>
        </ul>
      </SiteSection>

      <SiteSection id="choices" title="Your choices">
        <p className={READ}>
          You can play without a name, switch off posting laps, and clear the browser’s storage at any time. To see
          what is stored under your driver name, or to have your name, laps and race results deleted, email me at{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className={TEXT_LINK}>
            {CONTACT_EMAIL}
          </a>{" "}
          or open an issue on{" "}
          <a href={`${REPO_URL}/issues`} className={TEXT_LINK}>
            GitHub
          </a>
          . Tell me the driver name; I will ask you to confirm it is yours.
        </p>
        <p className={READ}>
          LibreCorsa is made and run by Alp Yalay. The code that does everything described here is open: the game and
          its online side are in the same{" "}
          <a href={REPO_URL} className={TEXT_LINK}>
            repository
          </a>
          . This page changes whenever what the site keeps changes.
        </p>
      </SiteSection>
    </SitePage>
  );
}
