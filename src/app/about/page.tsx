import type { Metadata } from "next";
import Link from "next/link";
import { GAME_FACTS } from "@/components/home/home-data";
import { LEAD, READ, SiteIntro, SitePage, SiteSection, TEXT_LINK } from "@/components/home/SitePage";
import enHome from "@/i18n/messages/en/home.json";
import { CONTACT_EMAIL, DOCS_URL, REPO_URL, SITE_NAME } from "@/lib/site";

// What LibreCorsa is and what signing in is for, as a page that reads the same without running any script: the home
// page's About tab says the same only once the page runs. It is also the home page link on Google's sign-in consent
// screen, which Google's review reads this way.
const DESCRIPTION = "What LibreCorsa is, what is in it, and what signing in is for.";

export const metadata: Metadata = {
  title: "About",
  description: DESCRIPTION,
  alternates: { canonical: "/about" },
  openGraph: { type: "website", url: "/about", siteName: SITE_NAME, title: `About | ${SITE_NAME}`, description: DESCRIPTION, locale: "en_US" },
  twitter: { card: "summary", title: `About | ${SITE_NAME}`, description: DESCRIPTION },
};

export default function AboutPage() {
  return (
    <SitePage>
      <SiteIntro title={`About ${SITE_NAME}`}>
        <p className={LEAD}>
          {SITE_NAME} is a free, open-source racing simulator that runs in your browser. Drive hot laps, career seasons, time
          trials and races against AI, join multiplayer rooms and post lap times online, on a computer, phone or tablet, with
          nothing to install.
        </p>
      </SiteIntro>

      <SiteSection id="game" title="What is in it">
        <dl className="m-0 flex max-w-[68ch] flex-col">
          {GAME_FACTS.map((fact) => {
            const { label, text } = enHome.hub.facts[fact];
            return (
              <div key={fact} className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-5 border-t border-lc-line py-3.5 max-sm:grid-cols-1 max-sm:gap-y-1">
                <dt className="lc-lbl pt-0.5">{label}</dt>
                <dd className="lc-body m-0 text-[16px] text-lc-chalk">{text}</dd>
              </div>
            );
          })}
        </dl>
      </SiteSection>

      <SiteSection id="accounts" title="Accounts and sign-in">
        <p className={READ}>
          You don’t need an account to play. An account is optional: signing in with Google, Discord, Steam or a passkey
          keeps your driver names and save the same on every device you play on.
        </p>
        <p className={READ}>
          Signing in with Google asks only for Google’s basic sign-in. {SITE_NAME} keeps the id Google gives your account
          and uses it only to sign you in. It never receives or stores your email, name or photo, and nothing about your
          account is shared, sold or used for advertising.{" "}
          <Link href="/privacy" className={TEXT_LINK}>
            The privacy policy
          </Link>{" "}
          says what an account stores and how to delete it.
        </p>
      </SiteSection>

      <SiteSection id="maker" title="Who makes it">
        <p className={READ}>
          {SITE_NAME} is a one-person project. Its code is open source on{" "}
          <a href={REPO_URL} className={TEXT_LINK}>
            GitHub
          </a>
          , and the{" "}
          <a href={DOCS_URL} className={TEXT_LINK}>
            docs
          </a>{" "}
          explain how it works. For questions, email{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className={TEXT_LINK}>
            {CONTACT_EMAIL}
          </a>
          .
        </p>
        <p className={READ}>
          <Link href="/stats" className={TEXT_LINK}>
            Public stats
          </Link>
          {" · "}
          <Link href="/press" className={TEXT_LINK}>
            Press &amp; media
          </Link>
          {" · "}
          <Link href="/privacy" className={TEXT_LINK}>
            Privacy policy
          </Link>
        </p>
      </SiteSection>
    </SitePage>
  );
}
