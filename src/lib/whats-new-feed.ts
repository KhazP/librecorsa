/**
 * The What's new patch notes (src/lib/home/whats-new.json) as an RSS 2.0 feed, served at /feed.xml
 * (src/app/feed.xml/route.ts) so feed readers and news sites can follow updates. One item per day, newest first, each
 * linking to the What's new tab on the home page. English only, like the notes themselves.
 *
 * Pure: the route passes the notes and the site address, and scripts/verify-feed.ts checks the output.
 */
import type { WhatsNewDay } from "@/components/home/home-data";

/** Where a feed item links: the home page opened on its What's new tab (HomeHub reads the hash) */
export const WHATS_NEW_HASH = "#whats-new";
/** The feed's path on the site */
export const FEED_PATH = "/feed.xml";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Text made safe inside an XML element */
export const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** A YYYY-MM-DD day as an RFC 822 date at midday UTC, which RSS asks for ("Mon, 23 Nov 2026 12:00:00 GMT") */
export function rfc822Day(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d, 12));
  return `${WEEKDAYS[at.getUTCDay()]}, ${String(d).padStart(2, "0")} ${MONTHS[m - 1]} ${y} 12:00:00 GMT`;
}

/** The feed's XML for these days of notes, newest first, with links on `siteUrl` (no trailing slash) */
export function whatsNewFeed(days: readonly WhatsNewDay[], siteUrl: string): string {
  const sorted = [...days].sort((a, b) => b.date.localeCompare(a.date));
  const link = `${siteUrl}/${WHATS_NEW_HASH}`;
  const items = sorted.map((day) => {
    const body = `<ul>${day.items.map((item) => `<li>${escapeXml(item)}</li>`).join("")}</ul>`;
    return [
      "    <item>",
      `      <title>${escapeXml(day.title)}</title>`,
      `      <link>${escapeXml(link)}</link>`,
      `      <guid isPermaLink="false">librecorsa-whats-new-${day.date}</guid>`,
      `      <pubDate>${rfc822Day(day.date)}</pubDate>`,
      `      <description>${escapeXml(body)}</description>`,
      "    </item>",
    ].join("\n");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    "    <title>LibreCorsa: What's new</title>",
    `    <link>${escapeXml(link)}</link>`,
    "    <description>Patch notes for LibreCorsa, the free open-source racing sim in your browser.</description>",
    "    <language>en</language>",
    `    <atom:link href="${escapeXml(siteUrl + FEED_PATH)}" rel="self" type="application/rss+xml"/>`,
    ...(sorted.length ? [`    <lastBuildDate>${rfc822Day(sorted[0].date)}</lastBuildDate>`] : []),
    ...items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}
