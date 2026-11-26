import type { Metadata } from "next";
import Link from "next/link";
import { LEAD, READ, SiteIntro, SitePage, SiteSection, TEXT_LINK } from "@/components/home/SitePage";
import { CONTACT_EMAIL, REPO_URL, SITE_NAME } from "@/lib/site";

// What the site keeps about the people who play it. Every statement here follows from the code: the browser's own
// storage, cloudflare/api (boards, races, rooms, usage, accounts), the connection servers in multiplayer-sync.ts and
// the desktop app's own requests (launcher/update.go, launcher/toolchain.go).
// Change this page in the same commit as anything that changes what is stored or sent.
const DESCRIPTION = "What LibreCorsa keeps in your browser, what it sends online and when, and how to have it removed.";
const UPDATED = "26 November 2026";

export const metadata: Metadata = {
  title: "Privacy",
  description: DESCRIPTION,
  alternates: { canonical: "/privacy" },
  openGraph: { type: "website", url: "/privacy", siteName: SITE_NAME, title: `Privacy | ${SITE_NAME}`, description: DESCRIPTION, locale: "en_US" },
  twitter: { card: "summary", title: `Privacy | ${SITE_NAME}`, description: DESCRIPTION },
};

const LIST = "lc-body m-0 flex max-w-[68ch] list-disc flex-col gap-3 ps-5 text-[16px] leading-[1.6] marker:text-lc-dim";
const B = "font-semibold text-lc-chalk";

export default function PrivacyPage() {
  return (
    <SitePage>
      <SiteIntro title="Privacy">
        <p className={LEAD}>
          LibreCorsa has no ads and no third-party trackers. Accounts are optional, and the only cookies are the ones
          that sign you in to one. You can play without an account and without giving a name. This page says what the
          game keeps, what it sends online and when.
        </p>
        <p className="lc-hint m-0">Last changed {UPDATED}</p>
      </SiteIntro>

      <SiteSection id="browser" title="What stays in your browser">
        <p className={READ}>
          Your settings, controls, car setups, saved laps, race history, careers and driver name are kept in your browser’s
          own storage on your device. So is a driver key: a random code that proves a name on the lap boards is yours.
          None of it leaves your device except as described below, and clearing this site’s data in your browser
          removes all of it.
        </p>
      </SiteSection>

      <SiteSection id="online" title="What goes online, and when">
        <ul className={LIST}>
          <li>
            <span className={B}>Lap boards.</span> When a lap is posted, the board stores your driver name and
            three-letter code, the lap (times, circuit, car, assists, realism, tyre, and whether it was driven on a keyboard, controller, wheel
            or touch screen), the car setup it was driven with (without its fuel load) and a recording of it that
            others can race as a ghost. It also stores a scrambled form of your driver key, which can’t be turned back
            into the key. Names, laps and setups on a board are public. Laps go up under your driver name, including
            the one the game gives you at first, and you can switch off “Auto-upload best laps” in the settings.
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
            car, the mode, the minutes driven and how many laps you completed. The site adds them to that day’s totals,
            by country, and the lap boards show the laps as each circuit’s total. It also
            says what you drove with (keyboard, controller, wheel or touch screen), on what (desktop, tablet or phone),
            whether the track was wet, which assists were on and which version of the game you had. Each of these is
            counted on its own, never combined with another or with the circuit or country. The report carries no
            name, key or id, and it can’t be tied to you or to your other sessions. Besides each circuit’s laps, the
            site shows two things made from these totals: the hours and laps driven and the number of countries, all
            added together, on the press page; and the circuits and cars driven most over the last 30 days, as an order
            with no numbers, in the menus. A circuit or car takes a place in that order only after at least 50
            sessions.
          </li>
          <li>
            <span className={B}>Live count.</span> While the game is open and its tab is in view, your browser sends an
            empty message to the site once a minute, and none while the tab is hidden. The site counts the messages of
            the last minute to show how many people are playing right now. The message carries no name, key or id. The
            site keeps only the time each one arrived, in memory, and forgets it after a minute.
          </li>
        </ul>
      </SiteSection>

      <SiteSection id="accounts" title="Accounts">
        <p className={READ}>
          An account is optional. It keeps your driver names and save the same on every device you sign in on. You
          sign in with Discord, Google, Steam or a passkey. An account stores:
        </p>
        <ul className={LIST}>
          <li>
            <span className={B}>Sign-ins.</span> For each sign-in, the account id that Discord, Google or Steam gives
            the site, and when it was added and last used.
          </li>
          <li>
            <span className={B}>Passkeys.</span> For each passkey, its public key and when it was added and last used.
            The passkey itself never leaves your device or password manager.
          </li>
          <li>
            <span className={B}>Devices.</span> For each signed-in browser or app, a label such as “Chrome on macOS”
            and when it signed in and was last seen. For each device that joined, a scrambled form of its driver key,
            so that it can post laps under the account’s driver names until it signs out.
          </li>
          <li>
            <span className={B}>The synced save.</span> Your settings (not controls, graphics or volumes), car setups,
            liveries, race history, careers, driver totals, and best laps with their ghosts.
          </li>
        </ul>
        <p className={READ}>
          An account stores no email address, no user name and no avatar. Of what Discord, Google or Steam send back
          when you sign in, the site keeps the account id and nothing else. Signing in sets a cookie that keeps that browser signed in. It holds a random code
          and nothing else. While a sign-in page is open, a second cookie checks that the sign-in comes back to the
          same browser, and it ends after ten minutes.
        </p>
        <p className={READ}>
          Signing in with Google uses Google’s basic sign-in (the “openid” scope) and nothing more. The site receives your
          Google account’s unique id, which it stores only to sign you in. It isn’t used for anything else, shared with
          anyone, sold, or used for advertising or AI, and it is deleted with the account. You can also end the site’s
          access at any time in your Google Account, under Security, then Your connections to third-party apps and
          services. Signing in with Discord or Steam works the same way: the site keeps only the account id they give it.
        </p>
        <p className={READ}>
          LibreCorsa’s use and transfer of information received from Google APIs adheres to the{" "}
          <a href="https://developers.google.com/terms/api-services-user-data-policy" className={TEXT_LINK}>
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
        <p className={READ}>
          To delete an account, open Settings, then Profile and data, then Account, or sign in at{" "}
          <Link href="/account" className={TEXT_LINK}>
            librecorsa.org/account
          </Link>
          , and choose Delete. The account, its sign-ins, passkeys, devices and synced save are deleted at once. Its
          driver names and laps stay on the boards, unless you tick “Also remove my laps and race results from the
          boards”, which removes them as well.
        </p>
      </SiteSection>

      <SiteSection id="desktop-app" title="The desktop app">
        <p className={READ}>
          The desktop app plays the same game. While it is online it loads the game’s pages, cars and circuits from
          librecorsa.org as a browser would, and keeps a copy on your computer so it can play offline, so everything on
          this page applies to it too. Apart from that, it sends only this:
        </p>
        <ul className={LIST}>
          <li>
            <span className={B}>Update checks.</span> Shortly after it starts and every six hours while it runs, it asks
            GitHub for the app’s latest release, and downloads a newer one from GitHub when there is one. GitHub sees your
            IP address and which version of the app you have.
          </li>
          <li>
            <span className={B}>The converter’s tools.</span> Only when you convert a circuit or a car and agree to the
            download: uv and Node.js from GitHub and nodejs.org, then Python and the converter’s packages through uv, from
            GitHub and the Python Package Index. Those sites see your IP address.
          </li>
        </ul>
        <p className={READ}>
          Your mods, the files you convert and what the converter makes stay on your computer. The game’s window tells
          the app it is still open, so the app can quit when you close it; that message never leaves your computer.
        </p>
      </SiteSection>

      <SiteSection id="addresses" title="IP addresses and logs">
        <p className={READ}>
          The site is served by Cloudflare, which handles your IP address to deliver the pages, to work out the country
          for the usage totals, and to limit how often one address can post, sign in or send the live count’s message. Cloudflare keeps request logs for a few
          days. The site’s own database stores no IP address. To limit lap uploads it keeps a scrambled form of
          the address for up to two hours and then deletes it.
        </p>
      </SiteSection>

      <SiteSection id="kept" title="How long it is kept">
        <ul className={LIST}>
          <li>Laps and race results stay for as long as the boards exist, or until you ask for them to be removed.</li>
          <li>
            A driver name on an account stays the account’s for as long as the account exists. Any other driver name
            stays yours while you use it, and after six months without a lap it can be claimed by someone else.
          </li>
          <li>
            An account and its synced save stay until the account is deleted. A browser or app that hasn’t been used for
            a year is signed out.
          </li>
          <li>The usage totals are kept as daily totals. They hold nothing about any one player.</li>
          <li>The live count keeps nothing: each message is forgotten a minute after it arrives.</li>
        </ul>
      </SiteSection>

      <SiteSection id="choices" title="Your choices">
        <p className={READ}>
          You can play without a name or an account, switch off posting laps, delete your account, and clear the
          browser’s storage at any time. To see
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
