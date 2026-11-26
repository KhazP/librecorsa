import type { Metadata } from "next";
import { SITE_NAME } from "@/lib/site";
import { PublicStats } from "./PublicStats";

const DESCRIPTION =
  "Live and 30-day public stats for LibreCorsa: hours and laps driven, popular circuits and cars, input devices, assists, weekly challenges and open races.";

const SHARE_IMAGE = {
  url: "/opengraph-image.jpg",
  width: 1200,
  height: 630,
  alt: "A LibreCorsa open-wheeler on the start-finish straight of the Rwanda International Circuit",
};

export const metadata: Metadata = {
  title: "Stats",
  description: DESCRIPTION,
  alternates: { canonical: "/stats" },
  openGraph: {
    type: "website",
    url: "/stats",
    siteName: SITE_NAME,
    title: `Stats | ${SITE_NAME}`,
    description: DESCRIPTION,
    locale: "en_US",
    images: [SHARE_IMAGE],
  },
  twitter: { card: "summary_large_image", title: `Stats | ${SITE_NAME}`, description: DESCRIPTION, images: [SHARE_IMAGE] },
};

export default function StatsPage() {
  return <PublicStats />;
}
