import type { WhatsNewDay } from "@/components/home/home-data";
import whatsNewJson from "@/lib/home/whats-new.json";
import { SITE_URL } from "@/lib/site";
import { whatsNewFeed } from "@/lib/whats-new-feed";

// Written once at build time from the patch notes in the build
export const dynamic = "force-static";

/** /feed.xml: the What's new patch notes as RSS (src/lib/whats-new-feed.ts) */
export function GET() {
  return new Response(whatsNewFeed(whatsNewJson as WhatsNewDay[], SITE_URL), {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
