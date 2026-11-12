/**
 * Cloudflare's own numbers for the site, for the owner's page: GET /api/admin/cloudflare with the admin key. They come
 * from Cloudflare's GraphQL Analytics API with a read-only token (the secret CF_ANALYTICS_TOKEN, "Account Analytics:
 * Read", plus "Zone Analytics: Read" for the site's traffic) and cover the last 7 days: the Workers numbers can be
 * asked for a week at most, and the others keep about a month.
 *
 * One request per dataset: a field Cloudflare renames fails only its own part, which comes back as a problem with
 * Cloudflare's message instead of taking the rest down.
 */
import { utcDay } from "./usage";
import type { Env } from "./types";

const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const DAY_MS = 86_400_000;
export const CLOUDFLARE_DAYS = 7;
/** The site's Worker and its R2 buckets (wrangler.jsonc) */
const SCRIPT = "librecorsa";
const BUCKETS = ["librecorsa-assets", "librecorsa-ghosts"];

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface CloudflareStats {
  ok: true;
  /** First and last UTC day: the last 7 days */
  from: string;
  to: string;
  /** The site's Worker: the API and the large files (static pages are served without it) */
  worker: { requests: number; errors: number; subrequests: number; cpuP50Ms: number; cpuP99Ms: number } | null;
  /** The boards' database */
  d1: { readQueries: number; writeQueries: number; rowsRead: number; rowsWritten: number; sizeBytes: number | null } | null;
  r2: { bucket: string; requests: number | null; objects: number | null; bytes: number | null }[] | null;
  /** Rooms and races */
  durableObjects: { requests: number } | null;
  /** The site's traffic per day; needs ANALYTICS_ZONE_ID */
  site: { day: string; requests: number; pageViews: number; visitors: number; bytes: number; cachedBytes: number }[] | null;
  /** The parts that could not be read, with Cloudflare's message */
  problems: { part: string; message: string }[];
}

export function analyticsConfigured(env: Env): boolean {
  return Boolean(env.CF_ANALYTICS_TOKEN && env.ANALYTICS_ACCOUNT_ID);
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** GraphQL types of the query variables: times for the datasets filtered by datetime, days for those by date */
const VAR_TYPES: Record<string, string> = { t0: "Time!", t1: "Time!", d0: "Date!", d1: "Date!" };

type Row = { sum?: Record<string, unknown>; max?: Record<string, unknown>; quantiles?: Record<string, unknown>; uniq?: Record<string, unknown>; dimensions?: Record<string, unknown> };

/** One GraphQL query; Cloudflare answers errors with a 200 and an `errors` list */
async function query(fetcher: Fetcher, token: string, text: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetcher(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: text, variables }),
  });
  const body = (await res.json().catch(() => null)) as { data?: unknown; errors?: { message?: unknown }[] | null } | null;
  if (body?.errors?.length) throw new Error(body.errors.map((e) => String(e.message ?? "error")).join("; "));
  if (!res.ok || !body?.data) throw new Error(`HTTP ${res.status}`);
  return body.data as Record<string, unknown>;
}

/** The rows of one dataset under viewer.accounts[0] or viewer.zones[0] */
function rows(data: Record<string, unknown>, scope: "accounts" | "zones"): Row[] {
  const viewer = data.viewer as Record<string, unknown> | undefined;
  const first = (viewer?.[scope] as Record<string, unknown>[] | undefined)?.[0];
  const set = first?.rows;
  return Array.isArray(set) ? (set as Row[]) : [];
}

export async function cloudflareStats(env: Env, nowMs: number, fetcher: Fetcher): Promise<CloudflareStats> {
  const token = env.CF_ANALYTICS_TOKEN ?? "";
  const account = env.ANALYTICS_ACCOUNT_ID ?? "";
  const from = utcDay(nowMs - (CLOUDFLARE_DAYS - 1) * DAY_MS);
  const to = utcDay(nowMs);
  const range = { d0: from, d1: to, t0: `${from}T00:00:00Z`, t1: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z") };
  const problems: CloudflareStats["problems"] = [];

  const part = async <T>(name: string, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (err) {
      problems.push({ part: name, message: err instanceof Error ? err.message.slice(0, 300) : "error" });
      return null;
    }
  };
  const accountRows = async (dataset: string, filter: string, fields: string, vars: Record<string, unknown>, extraArgs = "") =>
    rows(
      await query(
        fetcher,
        token,
        `query($acct: string!, ${Object.keys(vars)
          .map((k) => `$${k}: ${VAR_TYPES[k] ?? "string!"}`)
          .join(", ")}) { viewer { accounts(filter: { accountTag: $acct }) { rows: ${dataset}(limit: 1${extraArgs}, filter: { ${filter} }) { ${fields} } } } }`,
        { acct: account, ...vars },
      ),
      "accounts",
    );

  const worker = part("Worker", async () => {
    const [r] = await accountRows(
      "workersInvocationsAdaptive",
      "scriptName: $script, datetime_geq: $t0, datetime_leq: $t1",
      "sum { requests errors subrequests } quantiles { cpuTimeP50 cpuTimeP99 }",
      { script: SCRIPT, t0: range.t0, t1: range.t1 },
    );
    // CPU time comes in microseconds
    return {
      requests: num(r?.sum?.requests),
      errors: num(r?.sum?.errors),
      subrequests: num(r?.sum?.subrequests),
      cpuP50Ms: Math.round(num(r?.quantiles?.cpuTimeP50) / 10) / 100,
      cpuP99Ms: Math.round(num(r?.quantiles?.cpuTimeP99) / 10) / 100,
    };
  });

  const d1Id = env.ANALYTICS_D1_ID;
  const d1 = d1Id
    ? part("D1", async () => {
        const [use] = await accountRows(
          "d1AnalyticsAdaptiveGroups",
          "databaseId: $db, date_geq: $d0, date_leq: $d1",
          "sum { readQueries writeQueries rowsRead rowsWritten }",
          { db: d1Id, d0: range.d0, d1: range.d1 },
        );
        const size = await part("D1 size", async () => {
          const [s] = await accountRows("d1StorageAdaptiveGroups", "databaseId: $db, date_geq: $d0, date_leq: $d1", "max { databaseSizeBytes }", {
            db: d1Id,
            d0: range.d0,
            d1: range.d1,
          });
          return numOrNull(s?.max?.databaseSizeBytes);
        });
        return {
          readQueries: num(use?.sum?.readQueries),
          writeQueries: num(use?.sum?.writeQueries),
          rowsRead: num(use?.sum?.rowsRead),
          rowsWritten: num(use?.sum?.rowsWritten),
          sizeBytes: size,
        };
      })
    : Promise.resolve(null);

  const r2 = Promise.all(
    BUCKETS.map(async (bucket) => {
      const vars = { bucket, t0: range.t0, t1: range.t1 };
      const [requests, stored] = await Promise.all([
        part(`R2 ${bucket} requests`, async () => {
          const [r] = await accountRows("r2OperationsAdaptiveGroups", "bucketName: $bucket, datetime_geq: $t0, datetime_leq: $t1", "sum { requests }", vars);
          return num(r?.sum?.requests);
        }),
        part(`R2 ${bucket} storage`, async () => {
          const [r] = await accountRows(
            "r2StorageAdaptiveGroups",
            "bucketName: $bucket, datetime_geq: $t0, datetime_leq: $t1",
            "max { objectCount payloadSize }",
            vars,
            ", orderBy: [datetime_DESC]",
          );
          return { objects: numOrNull(r?.max?.objectCount), bytes: numOrNull(r?.max?.payloadSize) };
        }),
      ]);
      return { bucket, requests, objects: stored?.objects ?? null, bytes: stored?.bytes ?? null };
    }),
  );

  const durableObjects = part("Durable Objects", async () => {
    const [r] = await accountRows("durableObjectsInvocationsAdaptiveGroups", "date_geq: $d0, date_leq: $d1", "sum { requests }", { d0: range.d0, d1: range.d1 });
    return { requests: num(r?.sum?.requests) };
  });

  const zone = env.ANALYTICS_ZONE_ID;
  const site = zone
    ? part("Site traffic", async () => {
        const data = await query(
          fetcher,
          token,
          "query($zone: string!, $d0: Date!, $d1: Date!) { viewer { zones(filter: { zoneTag: $zone }) { rows: httpRequests1dGroups(limit: 31, orderBy: [date_ASC], filter: { date_geq: $d0, date_leq: $d1 }) { dimensions { date } sum { requests pageViews bytes cachedBytes } uniq { uniques } } } } }",
          { zone, d0: range.d0, d1: range.d1 },
        );
        return rows(data, "zones").map((r) => ({
          day: String(r.dimensions?.date ?? ""),
          requests: num(r.sum?.requests),
          pageViews: num(r.sum?.pageViews),
          visitors: num(r.uniq?.uniques),
          bytes: num(r.sum?.bytes),
          cachedBytes: num(r.sum?.cachedBytes),
        }));
      })
    : Promise.resolve(null);

  const [w, d, buckets, dos, traffic] = await Promise.all([worker, d1, r2, durableObjects, site]);
  return {
    ok: true,
    from,
    to,
    worker: w,
    d1: d,
    r2: buckets.every((b) => b.requests === null && b.objects === null) ? null : buckets,
    durableObjects: dos,
    site: traffic,
    problems,
  };
}
