/**
 * Carries the online lap board over from the Supabase project it used to live on to the site's own board
 * (cloudflare/api/board.ts): every lap with its ghost, and every claimed driver name with the hash of its key, so
 * nobody loses a time or a name.
 *
 *   SUPABASE_URL=https://<project>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<key> npx tsx scripts/migrate-supabase-board.ts [--dry-run] [--local]
 *
 * (The two variables may also sit in .env.migrate.local, which git ignores.) The service-role key is needed because
 * the tables are closed to the public key; it is only sent to that Supabase project.
 *
 * Safe to run again: names already claimed on the new board keep their owner, a lap only replaces a slower one of
 * the same driver and class, and ghosts are written under the lap's own id. Run it once at the switch, and once more
 * a few days later for laps posted by players whose browser still had the old version of the game.
 *
 * --dry-run reads Supabase and reports what would be written. --local writes to wrangler's local database and bucket.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driverNameKey } from '../cloudflare/api/board';
import { checkLap, type CheckedLap } from '../cloudflare/api/lap-check';

const DATABASE = 'librecorsa-board';
const BUCKET = 'librecorsa-ghosts';
const PAGE = 40;

export interface SupabaseLap {
  id: string;
  rec: unknown;
  created_at: string;
}
export interface SupabaseDriver {
  name_key: string;
  key_hash: string;
  claimed_at: string;
  last_seen: string;
}
export interface ImportPlan {
  /** SQL to run on the new board, in order */
  sql: string[];
  /** Ghost objects to write: R2 key -> JSON text */
  ghosts: Map<string, string>;
  laps: number;
  drivers: number;
  /** Why rows were left out, with how many */
  skipped: Record<string, number>;
}

const quote = (value: string | number): string => (typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * What to write for these Supabase rows. `owners` are the claims already on the new board (name key -> key hash): a
 * name someone else has claimed there since keeps its new owner, and the old owner's laps under it are left behind.
 */
export function planImport(laps: readonly SupabaseLap[], drivers: readonly SupabaseDriver[], owners: ReadonlyMap<string, string>): ImportPlan {
  const plan: ImportPlan = { sql: [], ghosts: new Map(), laps: 0, drivers: 0, skipped: {} };
  const skip = (why: string) => (plan.skipped[why] = (plan.skipped[why] ?? 0) + 1);
  const claims = new Map<string, string>();

  for (const d of drivers) {
    if (typeof d.name_key !== 'string' || !d.name_key || d.name_key.length > 64 || !HASH_RE.test(d.key_hash ?? '')) {
      skip('malformed name claim');
      continue;
    }
    const taken = owners.get(d.name_key);
    if (taken !== undefined && taken !== d.key_hash) {
      skip('name claimed by someone else on the new board');
      continue;
    }
    claims.set(d.name_key, d.key_hash);
    const claimed = Date.parse(d.claimed_at) || Date.now();
    const seen = Date.parse(d.last_seen) || claimed;
    plan.sql.push(
      `INSERT INTO drivers (name_key, key_hash, claimed_at, last_seen) VALUES (${quote(d.name_key)}, ${quote(d.key_hash)}, ${claimed}, ${seen}) ` +
        `ON CONFLICT (name_key) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen) WHERE key_hash = excluded.key_hash;`,
    );
    plan.drivers++;
  }

  for (const row of laps) {
    if (!UUID_RE.test(row.id ?? '')) {
      skip('lap without an id');
      continue;
    }
    const checked = checkLap(row.rec);
    if (!checked.ok) {
      // Laps from before conditions were recorded sit on the old "legacy" board, which the game never showed
      skip(checked.error.startsWith('Missing lap conditions') ? 'lap from before conditions were recorded' : `invalid lap (${checked.error})`);
      continue;
    }
    const rec: CheckedLap = checked.rec;
    const nameKey = driverNameKey(rec.driverName);
    if (!claims.has(nameKey)) {
      skip(owners.has(nameKey) ? 'lap under a name claimed by someone else on the new board' : 'lap without a name claim');
      continue;
    }
    const c = rec.conditions;
    const created = Date.parse(row.created_at) || Date.now();
    const values = [row.id, rec.trackId, rec.vehicle, c.physicsVersion, '', c.assists, c.realism, c.surface, c.compound, nameKey, rec.driverName, rec.driverCode, rec.lapTimeMs, rec.sectorTimesMs[0], rec.sectorTimesMs[1], rec.sectorTimesMs[2], rec.recordedAt, created];
    // One lap per driver and class: the faster one stays, whichever board it came from
    plan.sql.push(
      'INSERT INTO laps (id, track_id, vehicle, physics, event, assists, realism, surface, compound, name_key, driver_name, driver_code, lap_time_ms, s1_ms, s2_ms, s3_ms, recorded_at, created_at) ' +
        `VALUES (${values.map(quote).join(', ')}) ` +
        'ON CONFLICT (track_id, vehicle, physics, event, assists, realism, surface, name_key) DO UPDATE SET ' +
        'id = excluded.id, compound = excluded.compound, driver_name = excluded.driver_name, driver_code = excluded.driver_code, lap_time_ms = excluded.lap_time_ms, ' +
        's1_ms = excluded.s1_ms, s2_ms = excluded.s2_ms, s3_ms = excluded.s3_ms, recorded_at = excluded.recorded_at, created_at = excluded.created_at ' +
        'WHERE excluded.lap_time_ms < laps.lap_time_ms;',
    );
    plan.ghosts.set(`laps/${row.id}.json`, JSON.stringify(rec));
    plan.laps++;
  }
  return plan;
}

// ---- Running it ------------------------------------------------------------------------------------------------------

function readEnvFile(): void {
  const file = join(__dirname, '..', '.env.migrate.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function readTable<T>(base: string, key: string, table: string, order: string): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(`${base}/rest/v1/${table}?select=*&order=${order}&limit=${PAGE}&offset=${offset}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`Supabase ${table}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const page = (await res.json()) as T[];
    rows.push(...page);
    process.stdout.write(`\r  ${table}: ${rows.length} rows`);
    if (page.length < PAGE) break;
  }
  process.stdout.write('\n');
  return rows;
}

function wrangler(args: string[]): string {
  const res = spawnSync('npx', ['wrangler', ...args], { cwd: join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed:\n${res.stderr || res.stdout}`);
  return res.stdout;
}

async function main(): Promise<void> {
  readEnvFile();
  const dryRun = process.argv.includes('--dry-run');
  const where = process.argv.includes('--local') ? '--local' : '--remote';
  const base = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base) || !key) {
    console.error('Set SUPABASE_URL (https://<project>.supabase.co) and SUPABASE_SERVICE_ROLE_KEY (in the environment or in .env.migrate.local).');
    process.exit(1);
  }

  console.log(`Reading ${base}`);
  const drivers = await readTable<SupabaseDriver>(base, key, 'drivers', 'name_key');
  const laps = await readTable<SupabaseLap>(base, key, 'laps', 'id');

  console.log(`Reading the names already claimed on ${DATABASE} (${where})`);
  const out = wrangler(['d1', 'execute', DATABASE, where, '--json', '--command', 'SELECT name_key, key_hash FROM drivers']);
  const existing = (JSON.parse(out) as { results: { name_key: string; key_hash: string }[] }[])[0]?.results ?? [];
  const owners = new Map(existing.map((r) => [r.name_key, r.key_hash]));

  const plan = planImport(laps, drivers, owners);
  console.log(`\n${plan.drivers} name claims and ${plan.laps} laps to carry over (of ${drivers.length} and ${laps.length}).`);
  for (const [why, n] of Object.entries(plan.skipped)) console.log(`  left out: ${n} × ${why}`);
  if (dryRun) {
    console.log('\nDry run: nothing written.');
    return;
  }

  const dir = join(tmpdir(), `librecorsa-board-import-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  // Ghosts first: a row never points at a ghost that isn't there
  let n = 0;
  for (const [objectKey, text] of plan.ghosts) {
    const file = join(dir, 'ghost.json');
    writeFileSync(file, text);
    wrangler(['r2', 'object', 'put', `${BUCKET}/${objectKey}`, '--file', file, '--content-type', 'application/json', where]);
    process.stdout.write(`\r  ghosts: ${++n} / ${plan.ghosts.size}`);
  }
  process.stdout.write('\n');
  const sqlFile = join(dir, 'import.sql');
  writeFileSync(sqlFile, plan.sql.join('\n'));
  wrangler(['d1', 'execute', DATABASE, where, '--file', sqlFile, '--yes']);
  const count = wrangler(['d1', 'execute', DATABASE, where, '--json', '--command', 'SELECT (SELECT COUNT(*) FROM laps) AS laps, (SELECT COUNT(*) FROM drivers) AS drivers']);
  console.log('Done. The new board now holds:', JSON.stringify((JSON.parse(count) as { results: unknown[] }[])[0]?.results[0]));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
