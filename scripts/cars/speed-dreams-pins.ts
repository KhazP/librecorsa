/**
 * Re-pins the Speed Dreams cars the sd-car importer fetches (speed-dreams-cars.json): every car in the official asset
 * database, each at the head of its repository on forge.a-lec.org today (or, without one, the database's zip and
 * sha256), and the speed-dreams-data and speed-dreams-code heads. Run it to move the pins forward, then check a car or
 * two still imports.
 *
 *   node --import tsx scripts/cars/speed-dreams-pins.ts
 */
import { writeFileSync } from "node:fs";
import { PINS_FILE, readPins, type PinnedCar, type Pins } from "./sd-fetch";

const FORGE_API = "https://forge.a-lec.org/api/v1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** JSON from the forge's API, waiting while it says it is busy */
async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": "librecorsa-mod-tool" } });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 429 && attempt < 6) {
      await sleep(20_000 * (attempt + 1));
      continue;
    }
    throw new Error(`${url}: HTTP ${res.status}`);
  }
}

interface Asset {
  name: string;
  category: string;
  author: string;
  license: string;
  url: string;
  hash: string;
  size: string;
  directory: string;
}

async function head(repo: string): Promise<string> {
  const info = await getJson<{ default_branch: string }>(`${FORGE_API}/repos/speed-dreams/${repo}`);
  const branch = await getJson<{ commit: { id: string } }>(`${FORGE_API}/repos/speed-dreams/${repo}/branches/${info.default_branch}`);
  return branch.commit.id;
}

async function main(): Promise<void> {
  const old = readPins();
  const db = await getJson<{ cars: Asset[] }>(old.assetsDatabase);
  const repos = new Set<string>();
  for (let page = 1; ; page++) {
    const list = await getJson<{ name: string }[]>(`${FORGE_API}/orgs/speed-dreams/repos?page=${page}&limit=50`);
    if (!list.length) break;
    for (const r of list) repos.add(r.name);
  }
  const cars: Record<string, PinnedCar> = {};
  for (const a of [...db.cars].sort((x, y) => x.directory.localeCompare(y.directory))) {
    const pin: PinnedCar = { name: a.name, category: a.category, author: a.author.trim(), license: a.license };
    if (repos.has(a.directory)) {
      pin.repo = `https://forge.a-lec.org/speed-dreams/${a.directory}.git`;
      pin.commit = await head(a.directory);
    } else {
      pin.zip = a.url;
      pin.sha256 = a.hash;
      pin.size = Number(a.size);
    }
    cars[a.directory] = pin;
    console.log(`${a.directory} ${pin.commit ?? pin.sha256}`);
    // The forge refuses bursts
    await sleep(1500);
  }
  const pins: Pins & { about: string } = {
    about: (JSON.parse(JSON.stringify(old)) as { about: string }).about,
    pinned: new Date().toISOString().slice(0, 10),
    assetsDatabase: old.assetsDatabase,
    data: { repo: old.data.repo, commit: await head("speed-dreams-data") },
    code: { repo: old.code.repo, commit: await head("speed-dreams-code") },
    cars,
  };
  writeFileSync(PINS_FILE, `${JSON.stringify(pins, null, 2)}\n`);
  console.log(`wrote ${PINS_FILE}: ${Object.keys(cars).length} cars`);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
