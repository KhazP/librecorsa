import type { Metadata } from "next";
import { HomeDownloads } from "@/components/home/HomeDownloads";
import { LEAD, SiteIntro, SitePage, TEXT_LINK } from "@/components/home/SitePage";
import { day } from "@/components/home/home-data";
import { ANDROID_RELEASE, DESKTOP_RELEASE, releasePageUrl, type AppRelease } from "@/lib/downloads";
import { SITE_NAME } from "@/lib/site";

const DESCRIPTION =
  "Download LibreCorsa for Windows, macOS, Linux and Android. The free, open-source 500 Hz racing simulator as a desktop app that plays offline and takes mods, and a fullscreen Android app.";

const SHARE_IMAGE = {
  url: "/opengraph-image.jpg",
  width: 1200,
  height: 630,
  alt: "A LibreCorsa open-wheeler on the start-finish straight of the Rwanda International Circuit",
};

export const metadata: Metadata = {
  title: "Download",
  description: DESCRIPTION,
  alternates: { canonical: "/download" },
  openGraph: {
    type: "website",
    url: "/download",
    siteName: SITE_NAME,
    title: `Download | ${SITE_NAME}`,
    description: DESCRIPTION,
    locale: "en_US",
    images: [SHARE_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: `Download | ${SITE_NAME}`,
    description: DESCRIPTION,
    images: [SHARE_IMAGE],
  },
};

/** "Desktop app v0.3.0 · 1 Dec 2026", the version linking to the release; "coming soon" while it isn't out */
function ReleaseLine({ app, release }: { app: string; release: AppRelease }) {
  return (
    <span>
      {app}{" "}
      <a href={releasePageUrl(release)} target="_blank" rel="noopener" className={TEXT_LINK}>
        v{release.version}
      </a>{" "}
      <span aria-hidden>·</span> {release.published && release.date ? day(release.date) : "coming soon"}
    </span>
  );
}

export default function DownloadPage() {
  return (
    <SitePage wide>
      <SiteIntro title="Download LibreCorsa">
        <p className={LEAD}>
          A desktop app for Windows, macOS and Linux that plays offline too and takes mods, and an app for Android. Online,
          both play the live game, so new tracks, cars and physics updates arrive without reinstalling.
        </p>
        <p className="lc-mono m-0 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-lc-slate">
          <ReleaseLine app="Desktop app" release={DESKTOP_RELEASE} />
          <ReleaseLine app="Android app" release={ANDROID_RELEASE} />
        </p>
      </SiteIntro>

      <HomeDownloads variant="page" />
    </SitePage>
  );
}
