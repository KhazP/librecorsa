import type { Metadata } from "next";
import { HomeDownloads } from "@/components/home/HomeDownloads";
import { LEAD, SiteIntro, SitePage } from "@/components/home/SitePage";
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

export default function DownloadPage() {
  return (
    <SitePage>
      <SiteIntro title="Download LibreCorsa">
        <p className={LEAD}>
          The desktop app plays offline and takes mods. The Android app runs the game full screen. Or skip both and play in
          your browser.
        </p>
      </SiteIntro>

      <HomeDownloads variant="page" />
    </SitePage>
  );
}
