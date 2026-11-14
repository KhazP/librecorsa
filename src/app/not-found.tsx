import type { Metadata } from "next";
import { SiteNotice } from "@/components/home/SiteNotice";

export const metadata: Metadata = { title: "Page not found", robots: { index: false, follow: false } };

/** Any address the site does not have */
export default function NotFound() {
  return <SiteNotice title="Page not found">Nothing is at this address. The link may be old or mistyped.</SiteNotice>;
}
