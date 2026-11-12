/**
 * Writes each RISE Motordrome lap's `otherLayoutRoads` into its track data: the stretches where the other lap's road
 * leaves it (scripts/lib/layout-limits.ts). Run after export_json.py; the layout check recomputes them.
 *
 *   npx tsx scripts/rwanda-official/layout-limits.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { otherLayoutRoads } from '../lib/layout-limits';
import type { RawTrackJson } from '../../src/lib/track-data';

const IDS = ['rwanda_official', 'rwanda_official_short'] as const;
const path = (id: string) => `public/tracks/${id}/track_data.json`;
const raws = IDS.map((id) => JSON.parse(readFileSync(path(id), 'utf8')) as RawTrackJson);
IDS.forEach((id, k) => {
  const raw = raws[k];
  const stretches = otherLayoutRoads(id, raw, raws[1 - k]);
  (raw.metadata as unknown as { otherLayoutRoads?: [number, number][] }).otherLayoutRoads = stretches;
  writeFileSync(path(id), JSON.stringify(raw));
  console.log(`${id}: ${stretches.map(([a, b]) => `${a}-${b} m`).join(', ')}`);
});
