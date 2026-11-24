/**
 * /feed.xml (src/lib/whats-new-feed.ts): the What's new patch notes as RSS 2.0. Every day of notes becomes one item,
 * newest first, with a unique guid and an RFC 822 date; the text is escaped so a note with "&" or "<" can't break the
 * XML; and every item links to the home page's What's new tab, which HomeHub opens from the hash.
 *
 *   npx tsx scripts/verify/verify-feed.ts
 */
import { readFileSync } from 'node:fs';
import type { WhatsNewDay } from '../../src/components/home/home-data';
import whatsNewJson from '../../src/lib/home/whats-new.json';
import { escapeXml, FEED_PATH, rfc822Day, WHATS_NEW_HASH, whatsNewFeed } from '../../src/lib/whats-new-feed';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};

const SITE = 'https://librecorsa.org';
const days = whatsNewJson as WhatsNewDay[];
const xml = whatsNewFeed(days, SITE);
const items = xml.split('<item>').slice(1);

check('starts with the XML declaration and an RSS 2.0 root', xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"'));
check('ends with the closing tags and a newline', xml.endsWith('</channel>\n</rss>\n'));
check('one item per day of notes', items.length === days.length, `${items.length} items, ${days.length} days`);

const dates = items.map((item) => /<guid isPermaLink="false">librecorsa-whats-new-(\d{4}-\d{2}-\d{2})<\/guid>/.exec(item)?.[1] ?? '');
check('every item has a guid named after its day', dates.every(Boolean));
check('the guids are unique', new Set(dates).size === dates.length);
check('newest day first', dates.every((d, i) => i === 0 || dates[i - 1] >= d), dates.slice(0, 3).join(', '));

const pubDates = items.map((item) => /<pubDate>([^<]+)<\/pubDate>/.exec(item)?.[1] ?? '');
check('every item has an RFC 822 date', pubDates.every((d) => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} 12:00:00 GMT$/.test(d)));
check('the date names the right weekday', rfc822Day('2026-11-23') === 'Mon, 23 Nov 2026 12:00:00 GMT', rfc822Day('2026-11-23'));
check('the dates read back as their days', pubDates.every((d, i) => new Date(d).toISOString().slice(0, 10) === dates[i]));
check('lastBuildDate is the newest day', xml.includes(`<lastBuildDate>${rfc822Day(dates[0])}</lastBuildDate>`));

check('every item links to the What\'s new tab', items.every((item) => item.includes(`<link>${SITE}/${WHATS_NEW_HASH}</link>`)));
check('the self link names the feed', xml.includes(`<atom:link href="${SITE}${FEED_PATH}" rel="self" type="application/rss+xml"/>`));
const hub = readFileSync('src/components/home/HomeHub.tsx', 'utf8');
check('HomeHub has the tab the links open', hub.includes(`{ id: "${WHATS_NEW_HASH.slice(1)}"`));
check('HomeHub opens a tab from the hash', /window\.location\.hash/.test(hub) && /hashchange/.test(hub));

// Escaping: a note with markup or an ampersand stays text, and no raw "<" or "&" reaches the XML outside the tags
const tricky: WhatsNewDay[] = [{ date: '2026-01-02', title: 'Fish & <chips>', items: ['A < B && "C"', "it's"], commits: 1, lastSha: '0'.repeat(40) }];
const trickyXml = whatsNewFeed(tricky, SITE);
check('the title is escaped', trickyXml.includes('<title>Fish &amp; &lt;chips&gt;</title>'));
check('the notes are escaped twice inside the description', trickyXml.includes('&lt;li&gt;A &amp;lt; B &amp;amp;&amp;amp; &amp;quot;C&amp;quot;&lt;/li&gt;'));
const textOnly = trickyXml.replace(/<\/?[a-zA-Z:]+(\s[^<>]*)?\/?>|<\?xml[^>]*\?>/g, '');
check('no bare "<" or "&" outside the tags', !/<|&(?!(amp|lt|gt|quot|apos);)/.test(textOnly));
check('escapeXml covers the five XML characters', escapeXml(`&<>"'`) === '&amp;&lt;&gt;&quot;&apos;');
check('an empty list still makes a valid channel', whatsNewFeed([], SITE).includes('<channel>') && !whatsNewFeed([], SITE).includes('<item>'));

if (failures.length) {
  console.error(`\n${failures.length} feed check(s) failed`);
  process.exit(1);
}
console.log('\nAll feed checks passed.');
