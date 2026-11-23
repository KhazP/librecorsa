import type { HomeCoverage } from "@/components/home/home-data";

/**
 * One row of the home page's Press & media card. One piece an outlet posted on several platforms ("AppMunchies on
 * Instagram", "AppMunchies on YouTube", the same title) is one row, named for the outlet, with each platform's link,
 * so the card shows different coverage rather than one video three times. The press page keeps every entry.
 */
export interface CoverageRow {
  /** A stable key: the first entry's link */
  key: string;
  /** The outlet ("AppMunchies" for a group, else the entry's own outlet, "AppMunchies on TikTok" included) */
  outlet: string;
  title: string;
  /** The platforms of a group, newest first, each with its link; empty for a single entry */
  platforms: { name: string; url: string }[];
}

/** "AppMunchies on YouTube" → ["AppMunchies", "YouTube"]; an outlet without " on " has no platform */
function splitOutlet(outlet: string): [name: string, platform: string | null] {
  const at = outlet.lastIndexOf(" on ");
  return at > 0 ? [outlet.slice(0, at), outlet.slice(at + 4)] : [outlet, null];
}

/** The card's rows, in the entries' order (newest first), each group where its newest entry was */
export function groupCoverage(items: readonly HomeCoverage[]): CoverageRow[] {
  const groups = new Map<string, { name: string; first: HomeCoverage; platforms: CoverageRow["platforms"] }>();
  const order: (string | HomeCoverage)[] = [];
  for (const item of items) {
    const [name, platform] = splitOutlet(item.outlet);
    if (!platform) {
      order.push(item);
      continue;
    }
    const id = `${name}\n${item.title}`;
    const group = groups.get(id);
    if (group) {
      group.platforms.push({ name: platform, url: item.url });
    } else {
      groups.set(id, { name, first: item, platforms: [{ name: platform, url: item.url }] });
      order.push(id);
    }
  }
  return order.map((entry): CoverageRow => {
    const group = typeof entry === "string" ? groups.get(entry) : undefined;
    // A piece on one platform only stays as it was listed, outlet and platform in one name
    if (!group || group.platforms.length < 2) {
      const item = group?.first ?? (entry as HomeCoverage);
      return { key: item.url, outlet: item.outlet, title: item.title, platforms: [] };
    }
    return { key: group.first.url, outlet: group.name, title: group.first.title, platforms: group.platforms };
  });
}
