import type { Metadata } from "next";
import { HomeDownloads } from "@/components/home/HomeDownloads";
import { LEAD, SiteIntro, SitePage, TEXT_LINK } from "@/components/home/SitePage";
import { day } from "@/components/home/home-data";
import { APP_RELEASE } from "@/lib/downloads";
import { SITE_NAME } from "@/lib/site";

const DESCRIPTION =
  "Download LibreCorsa apps for Windows, macOS, Linux and Android. Free, open-source 500 Hz racing simulator with silent WebHID for wheels and fullscreen Android TWA.";

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

export default function DownloadPage() {
  return (
    <SitePage wide>
      <SiteIntro title="Download LibreCorsa">
        <p className={LEAD}>
          Optional native apps for Windows, macOS, Linux and Android. They open librecorsa.org directly, so new tracks, cars
          and physics updates arrive without reinstalling.
        </p>
        <p className="lc-mono m-0 text-[13px] text-lc-slate">
          Latest release{" "}
          <a href={APP_RELEASE.releaseUrl} target="_blank" rel="noopener" className={TEXT_LINK}>
            v{APP_RELEASE.version}
          </a>{" "}
          <span aria-hidden>·</span> {day(APP_RELEASE.date)}
        </p>
      </SiteIntro>

      <HomeDownloads variant="page" />
    </SitePage>
  );
}
