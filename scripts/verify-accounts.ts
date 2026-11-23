/**
 * Headless checks of player accounts (cloudflare/api/accounts), through the API's own entry (handleApi) on in-memory
 * SQLite databases and a bucket, with Discord, Google and Steam played by a stand-in fetch:
 *   - the config, the switch, and the ways in offered with and without the OAuth secrets
 *   - each provider's sign-in: the state cookie, the state used once and in time, PKCE, Google's claims, Steam's own
 *     check, a player who backs out; where it sends the player back; the session cookie
 *   - an Origin on everything that changes something; sessions that slide and end
 *   - a device joining with its driver key and names; the four places that prove a name (uploads and renames, race
 *     results, the Creator badge) taking any key of the name's account; a removed key; names on accounts not lapsing
 *   - link codes, folding one account into another, the cloud save and its ghosts, deleting an account
 *   - passkeys, with a stand-in verifier, and one real round trip with a software authenticator
 *
 *   npx tsx scripts/verify-accounts.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { handleApi, onlineConfig } from '../cloudflare/api/index';
import { adminStats, type AdminStats } from '../cloudflare/api/admin';
import { badgesOf } from '../cloudflare/api/awards';
import { provenNameKeys } from '../cloudflare/api/results';
import { safeReturn } from '../cloudflare/api/accounts/oauth';
import { normaliseLinkCode, LINK_CODE_ALPHABET, MAX_GHOSTS_PER_ACCOUNT, type SaveDoc } from '../src/lib/account/api-types';
import type { AccountsDeps, WebAuthnLib } from '../cloudflare/api/accounts/deps';
import type { D1Database, Env, RateLimit } from '../cloudflare/api/types';
import { fakeD1, fakeR2 } from './lib/fake-cloudflare';
import { getActiveTrackData } from '../src/lib/track-data';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { LapRecorder } from '../src/lib/sim/lap-recorder';
import { lapPhysicsVersion, type LapRecording } from '../src/lib/sim/lap-types';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(72)} ${detail}`);
  if (!ok) failures.push(name);
};

const SITE = 'https://librecorsa.org';
const boardSchema = readdirSync(join(__dirname, '../cloudflare/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(__dirname, '../cloudflare/migrations', f), 'utf8'))
  .join('\n');
const accountsSchema = readFileSync(join(__dirname, '../cloudflare/migrations-accounts/0001_accounts.sql'), 'utf8');

// The clock: the board's (Date.now) and the accounts' (injected) are the same hand-run clock
let clock = Date.UTC(2026, 10, 23, 12);
Date.now = () => clock;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const hex = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = (text: string) => b64url(new TextEncoder().encode(text));
const s256 = async (text: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
const rows = async <T = Record<string, unknown>>(db: D1Database, sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).all<T>()).results;
const one = async <T = Record<string, unknown>>(db: D1Database, sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).first<T>();

/** A rate limit that lets `max` through per key, and counts */
function fakeLimit(max: number): RateLimit & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    limit: async ({ key }) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= max };
    },
  };
}

// The providers ---------------------------------------------------------------------------------------------------------
interface ProviderCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Discord, Google and Steam as the checks need them: codes map to users, and every call is kept */
class Providers {
  calls: ProviderCall[] = [];
  discordCodes = new Map<string, string>();
  googleCodes = new Map<string, Record<string, unknown>>();
  steamValid = true;
  down = false;
  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init.body === 'string' ? init.body : '';
    this.calls.push({ url: input, method: init.method ?? 'GET', headers, body });
    if (this.down) throw new TypeError('fetch failed');
    const form = new URLSearchParams(body);
    if (input === 'https://discord.com/api/oauth2/token') {
      const user = this.discordCodes.get(form.get('code') ?? '');
      return user ? Response.json({ access_token: `at-${user}`, token_type: 'Bearer' }) : Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    if (input === 'https://discord.com/api/users/@me') {
      const auth = headers.authorization ?? '';
      return auth.startsWith('Bearer at-') ? Response.json({ id: auth.slice('Bearer at-'.length), username: 'never-kept' }) : new Response('', { status: 401 });
    }
    if (input === 'https://oauth2.googleapis.com/token') {
      const claims = this.googleCodes.get(form.get('code') ?? '');
      if (!claims) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const jwt = `${b64urlText(JSON.stringify({ alg: 'RS256' }))}.${b64urlText(JSON.stringify(claims))}.c2ln`;
      return Response.json({ id_token: jwt, access_token: 'g-at' });
    }
    if (input === 'https://steamcommunity.com/openid/login' && init.method === 'POST') {
      return new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${this.steamValid ? 'true' : 'false'}\n`);
    }
    return new Response('not found', { status: 404 });
  };
}

// A world: the Worker's bindings, the providers and the injections ------------------------------------------------------
interface World {
  env: Env;
  board: D1Database;
  accounts: D1Database;
  ghosts: ReturnType<typeof fakeR2>;
  providers: Providers;
  inject: Partial<AccountsDeps>;
  authLimit: ReturnType<typeof fakeLimit>;
  saveLimit: ReturnType<typeof fakeLimit>;
}

function makeWorld(opts: { secrets?: boolean; webauthn?: WebAuthnLib; envExtra?: Partial<Env>; authMax?: number; saveMax?: number } = {}): World {
  const board = fakeD1(boardSchema);
  const accounts = fakeD1(accountsSchema);
  const ghosts = fakeR2();
  const providers = new Providers();
  const authLimit = fakeLimit(opts.authMax ?? 1_000_000);
  const saveLimit = fakeLimit(opts.saveMax ?? 1_000_000);
  const secrets = opts.secrets ?? true;
  const env = {
    ONLINE_ACCOUNTS: 'on',
    ONLINE_BOARD: 'on',
    ONLINE_RACES: 'on',
    BOARD_DB: board,
    ACCOUNTS_DB: accounts,
    GHOSTS: ghosts,
    AUTH_LIMIT: authLimit,
    SAVE_LIMIT: saveLimit,
    ...(secrets ? { DISCORD_CLIENT_ID: 'disc-id', DISCORD_CLIENT_SECRET: 'disc-secret', GOOGLE_CLIENT_ID: 'goog-id.apps', GOOGLE_CLIENT_SECRET: 'goog-secret' } : {}),
    ...opts.envExtra,
  } as unknown as Env;
  const inject: Partial<AccountsDeps> = { fetch: providers.fetch, now: () => clock, ...(opts.webauthn ? { webauthn: opts.webauthn } : {}) };
  return { env, board, accounts, ghosts, providers, inject, authLimit, saveLimit };
}

let ipCounter = 0;

/** A browser: its cookies, its address, and the site it is on */
class Browser {
  jar = new Map<string, string>();
  setCookies: string[] = [];
  ip = `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
  constructor(
    private world: World,
    public base = SITE,
  ) {}
  async call(method: string, path: string, opts: { body?: unknown; raw?: string; origin?: string | null; headers?: Record<string, string>; freshIp?: boolean } = {}): Promise<Response> {
    const url = new URL(path, this.base);
    const headers = new Headers(opts.headers);
    headers.set('CF-Connecting-IP', opts.freshIp ? `10.9.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}` : this.ip);
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.set('Cookie', cookie);
    // A sign-in starts from one of the site's own pages, as the browser says
    if (url.pathname.startsWith('/api/auth/start/') && !headers.has('Sec-Fetch-Site')) headers.set('Sec-Fetch-Site', 'same-origin');
    const origin = opts.origin === undefined ? (method === 'GET' ? null : this.base) : opts.origin;
    if (origin) headers.set('Origin', origin);
    let body: string | undefined;
    if (opts.raw !== undefined) body = opts.raw;
    else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers.set('Content-Type', 'application/json');
    }
    const res = await handleApi(new Request(url, { method, headers, body }), this.world.env, url, { accounts: this.world.inject });
    this.setCookies = res.headers.getSetCookie();
    for (const c of this.setCookies) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      if (/Max-Age=0(;|$)/.test(c)) this.jar.delete(name);
      else this.jar.set(name, pair.slice(eq + 1));
    }
    return res;
  }
  get = (path: string, opts = {}) => this.call('GET', path, opts);
  post = (path: string, body?: unknown, opts: Parameters<Browser['call']>[2] = {}) => this.call('POST', path, { ...opts, body });
  put = (path: string, body?: unknown, opts: Parameters<Browser['call']>[2] = {}) => this.call('PUT', path, { ...opts, body });
  async json<T = Record<string, unknown>>(res: Response): Promise<T> {
    return (await res.json()) as T;
  }
  async account(): Promise<{ status: number; body: Record<string, any> }> {
    const res = await this.get('/api/account');
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }
}

const resultOf = (res: Response): string | null => /#lc-account=([a-z-]+)$/.exec(res.headers.get('Location') ?? '')?.[1] ?? null;

/** Discord's half of a sign-in: start, then the callback with a code for `user` */
async function viaDiscord(w: World, b: Browser, user: string, opts: { intent?: string; ret?: string; mangle?: (q: URLSearchParams) => void } = {}) {
  const start = await b.get(`/api/auth/start/discord?intent=${opts.intent ?? 'signin'}&return=${encodeURIComponent(opts.ret ?? '/play')}`);
  const to = new URL(start.headers.get('Location') ?? 'https://x.invalid');
  const state = to.searchParams.get('state') ?? '';
  const code = `code-${user}-${Math.random().toString(36).slice(2)}`;
  w.providers.discordCodes.set(code, user);
  const q = new URLSearchParams({ code, state });
  opts.mangle?.(q);
  const back = await b.get(`/api/auth/callback/discord?${q}`);
  return { start, to, state, code, back, result: resultOf(back) };
}

async function viaGoogle(w: World, b: Browser, sub: string, opts: { intent?: string; claims?: (nonce: string) => Record<string, unknown> } = {}) {
  const start = await b.get(`/api/auth/start/google?intent=${opts.intent ?? 'signin'}&return=/play`);
  const to = new URL(start.headers.get('Location') ?? 'https://x.invalid');
  const state = to.searchParams.get('state') ?? '';
  const nonce = to.searchParams.get('nonce') ?? '';
  const code = `g-${sub}-${Math.random().toString(36).slice(2)}`;
  w.providers.googleCodes.set(code, opts.claims ? opts.claims(nonce) : { iss: 'https://accounts.google.com', aud: 'goog-id.apps', sub, nonce, exp: Math.floor(clock / 1000) + 3600, iat: Math.floor(clock / 1000) });
  const back = await b.get(`/api/auth/callback/google?${new URLSearchParams({ code, state })}`);
  return { start, to, state, nonce, code, back, result: resultOf(back) };
}

const STEAM = 'https://steamcommunity.com/openid/login';
async function viaSteam(w: World, b: Browser, steamId: string, opts: { intent?: string; mangle?: (q: URLSearchParams) => void } = {}) {
  const start = await b.get(`/api/auth/start/steam?intent=${opts.intent ?? 'signin'}&return=/play`);
  // A start refused at once comes straight back with its result
  if (!/^https:/.test(start.headers.get('Location') ?? '')) return { start, to: new URL(SITE), returnTo: '', back: start, result: resultOf(start) };
  const to = new URL(start.headers.get('Location') ?? 'https://x.invalid');
  const returnTo = to.searchParams.get('openid.return_to') ?? '';
  const claimed = `https://steamcommunity.com/openid/id/${steamId}`;
  const q = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': STEAM,
    'openid.claimed_id': claimed,
    'openid.identity': claimed,
    'openid.return_to': returnTo,
    'openid.response_nonce': '2026-11-23T12:00:00Zabc',
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'c2lnbmF0dXJl',
  });
  opts.mangle?.(q);
  const back = await b.get(`${returnTo.replace(SITE, '')}&${q}`);
  return { start, to, returnTo, back, result: resultOf(back) };
}

/** A driver key, and its SHA-256 as the board keeps it */
const keyNo = (n: number) => `key${String(n).padStart(2, '0')}`.padEnd(43, 'k');
const claim = async (w: World, nameKey: string, key: string, opts: { lastSeen?: number; accountId?: string | null; shown?: string } = {}) => {
  await w.board
    .prepare('INSERT INTO drivers (name_key, key_hash, claimed_at, last_seen, account_id) VALUES (?, ?, ?, ?, ?)')
    .bind(nameKey, await hex(key), clock - DAY, opts.lastSeen ?? clock - HOUR, opts.accountId ?? null)
    .run();
  if (opts.shown) await addLap(w, nameKey, opts.shown);
};
let lapNo = 0;
const addLap = async (w: World, nameKey: string, shown: string, extra: { event?: string; track?: string } = {}) => {
  const id = `00000000-0000-4000-8000-${String(++lapNo).padStart(12, '0')}`;
  await w.board
    .prepare(
      "INSERT INTO laps (id, track_id, vehicle, physics, event, assists, realism, surface, compound, name_key, driver_name, driver_code, lap_time_ms, s1_ms, s2_ms, s3_ms, recorded_at, created_at) VALUES (?, ?, 'lc26', 7, ?, 'pro', 'full', 'dry', 'medium', ?, ?, 'DRV', ?, 1, 1, 1, ?, ?)",
    )
    .bind(id, extra.track ?? `track_${lapNo}`, extra.event ?? '', nameKey, shown, 60_000 + lapNo, clock, clock)
    .run();
  await w.ghosts.put(`laps/${id}.json`, '{"lap":true}');
  return id;
};

const saveDoc = (marker: string, ghosts: string[] = []): SaveDoc => ({
  v: 1,
  savedAt: clock,
  savedBy: 'Test device',
  keys: { 'bugesera.track': { value: marker, t: clock } },
  settings: {},
  bestLaps: Object.fromEntries(ghosts.map((g, i) => [`track|lc26|${i}`, { trackId: 'track', vehicle: 'lc26', lapTimeMs: 60_000 + i, recordedAt: clock, ghost: g }])),
  removed: {},
});

async function main() {
  // 1. The config and the switch ------------------------------------------------------------------------------------------
  {
    const w = makeWorld();
    const c = onlineConfig(w.env);
    check('config: accounts on with the switch and the bindings', c.accounts === true);
    check('config: every way in once the OAuth secrets are set', c.accountProviders.join() === 'discord,google,steam,passkey', c.accountProviders.join());
    const bare = onlineConfig(makeWorld({ secrets: false }).env);
    check('config: without the secrets, Steam and passkeys only', bare.accounts && bare.accountProviders.join() === 'steam,passkey', bare.accountProviders.join());
    const halfEnv = makeWorld({ secrets: false, envExtra: { DISCORD_CLIENT_ID: 'only-the-id' } }).env;
    check('config: Discord needs both of its values', !onlineConfig(halfEnv).accountProviders.includes('discord'));
    const offWorld = makeWorld({ envExtra: { ONLINE_ACCOUNTS: 'off' } });
    const off = onlineConfig(offWorld.env);
    check('config: the switch off turns accounts off, with no ways in', off.accounts === false && off.accountProviders.length === 0);
    check('config: no accounts database, no accounts', !onlineConfig({ ...w.env, ACCOUNTS_DB: undefined } as Env).accounts);
    const viaApi = (await (await handleApi(new Request(`${SITE}/api/config`), w.env, new URL(`${SITE}/api/config`))).json()) as Record<string, unknown>;
    check('config: GET /api/config carries both fields', viaApi.accounts === true && Array.isArray(viaApi.accountProviders));
    const b = new Browser(offWorld);
    const answers = await Promise.all([b.get('/api/account'), b.post('/api/auth/signout'), b.get('/api/auth/start/steam'), b.post('/api/account/save'), b.get('/api/auth/nothing')]);
    const bodies = await Promise.all(answers.map((r) => r.json() as Promise<{ error?: string }>));
    check('switch off: every /api/auth and /api/account route is 404 "Accounts are off"', answers.every((r) => r.status === 404) && bodies.every((x) => x.error === 'Accounts are off'), answers.map((r) => r.status).join());
  }

  // 2. Discord ------------------------------------------------------------------------------------------------------------
  const w = makeWorld();
  {
    const b = new Browser(w);
    const run = await viaDiscord(w, b, '111111111111111111', { ret: '/account' });
    const to = run.to;
    check('discord: start goes to its authorize page', run.start.status === 302 && to.origin + to.pathname === 'https://discord.com/oauth2/authorize');
    check(
      'discord: scope identify, code flow, PKCE S256, the exact redirect',
      to.searchParams.get('scope') === 'identify' &&
        to.searchParams.get('response_type') === 'code' &&
        to.searchParams.get('code_challenge_method') === 'S256' &&
        to.searchParams.get('redirect_uri') === `${SITE}/api/auth/callback/discord` &&
        to.searchParams.get('client_id') === 'disc-id',
    );
    const authCookie = run.start.headers.getSetCookie().find((c) => c.startsWith('__Host-lc_auth='));
    check('discord: the state is bound to the browser by a short __Host- cookie', !!authCookie && /Max-Age=600;/.test(authCookie) && /HttpOnly/.test(authCookie) && /SameSite=Lax/.test(authCookie) && /Secure/.test(authCookie) && /Path=\//.test(authCookie), authCookie);
    check('discord: the cookie holds the state sent', authCookie?.split(';')[0] === `__Host-lc_auth=${run.state}`);
    const tokenCall = w.providers.calls.find((c) => c.url === 'https://discord.com/api/oauth2/token');
    const form = new URLSearchParams(tokenCall?.body ?? '');
    check('discord: the token call sends the PKCE verifier that matches the challenge', !!form.get('code_verifier') && (await s256(form.get('code_verifier')!)) === to.searchParams.get('code_challenge'));
    check('discord: the token call sends the code, the redirect and the client', form.get('code') === run.code && form.get('redirect_uri') === `${SITE}/api/auth/callback/discord` && form.get('client_secret') === 'disc-secret');
    check('discord: a new sign-in makes an account, back to the return path', run.back.status === 302 && run.back.headers.get('Location') === '/account#lc-account=created');
    const session = run.back.headers.getSetCookie().find((c) => c.startsWith('__Host-lc_session='));
    check(
      'session cookie: __Host-, Secure, HttpOnly, SameSite=Lax, Path=/, 400 days',
      !!session && /; Path=\/;/.test(session) && /Max-Age=34560000;/.test(session) && /HttpOnly/.test(session) && /SameSite=Lax/.test(session) && /Secure$/.test(session),
      session,
    );
    check('session cookie: 32 random bytes as base64url', /^__Host-lc_session=[A-Za-z0-9_-]{43};/.test(session ?? ''));
    check('discord: the auth cookie is cleared on the callback', run.back.headers.getSetCookie().some((c) => c.startsWith('__Host-lc_auth=;') && /Max-Age=0/.test(c)));
    const token = b.jar.get('__Host-lc_session') ?? '';
    const stored = await rows(w.accounts, 'SELECT * FROM sessions');
    check('session: only the SHA-256 of the token is stored', stored.length === 1 && stored[0].id === (await hex(token)) && !JSON.stringify(stored).includes(token));
    const ids = await rows(w.accounts, 'SELECT * FROM identities');
    check('discord: the identity keeps the user id and nothing else', ids.length === 1 && ids[0].provider === 'discord' && ids[0].subject === '111111111111111111' && !JSON.stringify(ids).includes('never-kept'));
    const me = await b.account();
    check('GET /api/account: signed in, not joined yet', me.status === 200 && me.body.ok && me.body.thisDevice.joined === false && me.body.account.identities[0].provider === 'discord', JSON.stringify(me.body).slice(0, 120));

    // The state: single use, bound, in time
    b.jar.set('__Host-lc_auth', run.state);
    const replay = await b.get(`/api/auth/callback/discord?${new URLSearchParams({ code: run.code, state: run.state })}`);
    check('discord: a state is used once (the same callback again fails)', resultOf(replay) === 'failed');
    const other = new Browser(w);
    const begun = await viaDiscord(w, other, '222222222222222222', { mangle: () => other.jar.delete('__Host-lc_auth') });
    check('discord: a callback without the state cookie fails (login CSRF)', begun.result === 'failed' && (await rows(w.accounts, "SELECT * FROM identities WHERE subject = '222222222222222222'")).length === 0);
    const third = new Browser(w);
    const wrong = await viaDiscord(w, third, '333333333333333333', { mangle: () => third.jar.set('__Host-lc_auth', 'x'.repeat(43)) });
    check('discord: a cookie for another state fails', wrong.result === 'failed');
    const slow = new Browser(w);
    const startSlow = await slow.get('/api/auth/start/discord');
    const slowState = new URL(startSlow.headers.get('Location')!).searchParams.get('state')!;
    w.providers.discordCodes.set('slow-code', '444444444444444444');
    clock += 11 * MIN;
    const late = await slow.get(`/api/auth/callback/discord?code=slow-code&state=${slowState}`);
    check('discord: a state older than 10 minutes fails', resultOf(late) === 'failed');
    const quit = new Browser(w);
    const cancelled = await viaDiscord(w, quit, '555555555555555555', { mangle: (q) => (q.delete('code'), q.set('error', 'access_denied')) });
    check('discord: backing out on its page is "cancelled"', cancelled.result === 'cancelled');
    const refused = await viaDiscord(w, new Browser(w), '555555555555555555', { mangle: (q) => (q.delete('code'), q.set('error', 'server_error')) });
    check('discord: another provider error is "failed"', refused.result === 'failed');
    const badCode = await viaDiscord(w, new Browser(w), '555555555555555555', { mangle: (q) => q.set('code', 'not-a-known-code') });
    check('discord: a code the provider refuses is "failed"', badCode.result === 'failed');
    w.providers.down = true;
    const down = await viaDiscord(w, new Browser(w), '555555555555555555');
    w.providers.down = false;
    check('discord: the provider out of reach is "failed"', down.result === 'failed');
    const again = await viaDiscord(w, new Browser(w), '111111111111111111');
    check('discord: the same user again signs in to the same account', again.result === 'signed-in' && (await rows(w.accounts, 'SELECT * FROM accounts')).length === 1);
    const unconfigured = makeWorld({ secrets: false });
    const noDiscord = await new Browser(unconfigured).get('/api/auth/start/discord?return=/account');
    check('discord: without its secrets the start comes straight back "failed"', noDiscord.headers.get('Location') === '/account#lc-account=failed');
    const unknown = await b.get('/api/auth/start/github');
    check('an unknown provider is the plain 404', unknown.status === 404 && ((await unknown.json()) as { error: string }).error === 'Not found');
  }

  // 3. Google -------------------------------------------------------------------------------------------------------------
  {
    const b = new Browser(w);
    const run = await viaGoogle(w, b, '1093847561029384756');
    const to = run.to;
    check('google: start goes to its authorize page', to.origin + to.pathname === 'https://accounts.google.com/o/oauth2/v2/auth');
    check('google: scope openid only, with a nonce and PKCE', to.searchParams.get('scope') === 'openid' && run.nonce.length >= 16 && to.searchParams.get('code_challenge_method') === 'S256');
    check('google: the exact redirect', to.searchParams.get('redirect_uri') === `${SITE}/api/auth/callback/google`);
    const form = new URLSearchParams(w.providers.calls.filter((c) => c.url === 'https://oauth2.googleapis.com/token').at(-1)?.body ?? '');
    check('google: the PKCE verifier is sent and matches', (await s256(form.get('code_verifier') ?? '')) === to.searchParams.get('code_challenge'));
    check('google: a new sign-in makes an account', run.result === 'created');
    check('google: the account keeps the sub', (await rows(w.accounts, "SELECT * FROM identities WHERE provider = 'google' AND subject = '1093847561029384756'")).length === 1);
    const exp = Math.floor(clock / 1000) + 600;
    const bad = async (claims: (nonce: string) => Record<string, unknown>) => (await viaGoogle(w, new Browser(w), '9', { claims })).result;
    check('google: another issuer fails', (await bad((nonce) => ({ iss: 'https://evil.example', aud: 'goog-id.apps', sub: '9', nonce, exp }))) === 'failed');
    check('google: another audience fails', (await bad((nonce) => ({ iss: 'https://accounts.google.com', aud: 'someone-else', sub: '9', nonce, exp }))) === 'failed');
    check('google: an expired token fails', (await bad((nonce) => ({ iss: 'https://accounts.google.com', aud: 'goog-id.apps', sub: '9', nonce, exp: Math.floor(clock / 1000) - 1 }))) === 'failed');
    check('google: another nonce fails', (await bad(() => ({ iss: 'https://accounts.google.com', aud: 'goog-id.apps', sub: '9', nonce: 'replayed', exp }))) === 'failed');
    check('google: no sub fails', (await bad((nonce) => ({ iss: 'https://accounts.google.com', aud: 'goog-id.apps', nonce, exp }))) === 'failed');
    check('google: the short issuer and an audience list with azp pass', (await bad((nonce) => ({ iss: 'accounts.google.com', aud: ['goog-id.apps', 'x'], azp: 'goog-id.apps', sub: '9', nonce, exp }))) === 'created');
  }

  // 4. Steam --------------------------------------------------------------------------------------------------------------
  {
    const b = new Browser(w);
    const before = w.providers.calls.length;
    const run = await viaSteam(w, b, '76561197960287930');
    const to = run.to;
    check('steam: start goes to its OpenID login', to.origin + to.pathname === STEAM && to.searchParams.get('openid.mode') === 'checkid_setup');
    check('steam: identifier_select, the realm is the site', to.searchParams.get('openid.identity') === 'http://specs.openid.net/auth/2.0/identifier_select' && to.searchParams.get('openid.realm') === SITE);
    check('steam: return_to is the callback with the state', run.returnTo.startsWith(`${SITE}/api/auth/callback/steam?state=`) && b.jar.has('__Host-lc_auth') === false);
    check('steam: a new sign-in makes an account', run.result === 'created', String(run.result));
    const checkCall = w.providers.calls.slice(before).find((c) => c.method === 'POST' && c.url === STEAM);
    const checked = new URLSearchParams(checkCall?.body ?? '');
    check('steam: the answer is checked with check_authentication, the rest as received', checked.get('openid.mode') === 'check_authentication' && checked.get('openid.sig') === 'c2lnbmF0dXJl' && checked.get('openid.return_to') === run.returnTo);
    check('steam: the account keeps the SteamID64', (await rows(w.accounts, "SELECT * FROM identities WHERE provider = 'steam' AND subject = '76561197960287930'")).length === 1);
    w.providers.steamValid = false;
    check('steam: is_valid:false fails', (await viaSteam(w, new Browser(w), '76561197960287931')).result === 'failed');
    w.providers.steamValid = true;
    const calls = w.providers.calls.length;
    check('steam: a return_to other than the one sent fails, unchecked', (await viaSteam(w, new Browser(w), '76561197960287932', { mangle: (q) => q.set('openid.return_to', `${SITE}/api/auth/callback/steam?state=other`) })).result === 'failed' && w.providers.calls.length === calls);
    check('steam: a claimed id that is not a SteamID64 fails', (await viaSteam(w, new Browser(w), '1234')).result === 'failed');
    check('steam: an identity unlike the claimed id fails', (await viaSteam(w, new Browser(w), '76561197960287933', { mangle: (q) => q.set('openid.identity', 'https://steamcommunity.com/openid/id/76561197960287934') })).result === 'failed');
    check('steam: another op_endpoint fails', (await viaSteam(w, new Browser(w), '76561197960287935', { mangle: (q) => q.set('openid.op_endpoint', 'https://evil.example/openid/login') })).result === 'failed');
    check('steam: claimed_id left out of the signed fields fails', (await viaSteam(w, new Browser(w), '76561197960287936', { mangle: (q) => q.set('openid.signed', 'signed,op_endpoint,identity,return_to,response_nonce') })).result === 'failed');
    {
      // A forged claimed_id and identity in front of Steam's genuine, signed ones
      const victim = 'https://steamcommunity.com/openid/id/76561197960287999';
      const calls = w.providers.calls.length;
      const forged = await viaSteam(w, new Browser(w), '76561197960287938', {
        mangle: (q) => {
          const all = [...q];
          for (const [k] of all) q.delete(k);
          q.append('openid.claimed_id', victim);
          q.append('openid.identity', victim);
          for (const [k, v] of all) q.append(k, v);
        },
      });
      check('steam: an answer with a field sent twice fails, unchecked', forged.result === 'failed' && w.providers.calls.length === calls);
      const twoStates = await viaSteam(w, new Browser(w), '76561197960287939', { mangle: (q) => q.append('state', 'another') });
      check('steam: a state sent twice fails', twoStates.result === 'failed');
    }
    check('steam: backing out is "cancelled"', (await viaSteam(w, new Browser(w), '76561197960287937', { mangle: (q) => q.set('openid.mode', 'cancel') })).result === 'cancelled');
  }

  // 5. Where the player lands, plain http, Origin, sessions ---------------------------------------------------------------
  {
    check(
      'return: paths on this site only, else /play',
      safeReturn('/account') === '/account' &&
        safeReturn('/a/b_c-d') === '/a/b_c-d' &&
        safeReturn('//evil.example') === '/play' &&
        safeReturn('https://evil.example') === '/play' &&
        safeReturn('/play?x=1') === '/play' &&
        safeReturn('/../x') === '/play' &&
        safeReturn('') === '/play' &&
        safeReturn(null) === '/play' &&
        safeReturn('/\\evil') === '/play',
    );
    const evil = await viaDiscord(w, new Browser(w), '666666666666666666', { ret: '//evil.example/x' });
    check('return: a // return lands on /play', evil.back.headers.get('Location') === '/play#lc-account=created');
    const dev = makeWorld({ envExtra: { DEV_ORIGINS: 'http://localhost:3000' } });
    const devRef = new Browser(dev);
    const s = await devRef.get('/api/auth/start/discord?return=/account', { headers: { Referer: 'http://localhost:3000/play' } });
    const st = new URL(s.headers.get('Location')!).searchParams.get('state')!;
    dev.providers.discordCodes.set('dev-code', '777777777777777777');
    const devBack = await devRef.get(`/api/auth/callback/discord?code=dev-code&state=${st}`);
    check('return: a start from a DEV_ORIGINS page lands back there', devBack.headers.get('Location') === 'http://localhost:3000/account#lc-account=created', String(devBack.headers.get('Location')));
    const foreignRef = new Browser(dev);
    const s2 = await foreignRef.get('/api/auth/start/discord?return=/account', { headers: { Referer: 'https://evil.example/' } });
    const st2 = new URL(s2.headers.get('Location')!).searchParams.get('state')!;
    dev.providers.discordCodes.set('dev-code-2', '888888888888888888');
    const foreignBack = await foreignRef.get(`/api/auth/callback/discord?code=dev-code-2&state=${st2}`);
    check('return: any other referrer lands on this site', foreignBack.headers.get('Location') === '/account#lc-account=created');

    const local = makeWorld();
    const http = new Browser(local, 'http://localhost:8787');
    const plain = await viaSteam(local, http, '76561197960280002');
    const cookie = plain.back.headers.getSetCookie().find((c) => c.startsWith('lc_session='));
    check('plain http: the cookie is lc_session without Secure', !!cookie && !/Secure/.test(cookie) && /HttpOnly/.test(cookie), cookie);
    check('plain http: the auth cookie is lc_auth', plain.start.headers.getSetCookie().some((c) => c.startsWith('lc_auth=')));

    const b = new Browser(w);
    await viaSteam(w, b, '76561197960280003');
    const noOrigin = await b.post('/api/auth/signout', undefined, { origin: null });
    check('origin: a POST without Origin is refused (403)', noOrigin.status === 403);
    const foreign = await b.post('/api/auth/signout', undefined, { origin: 'https://evil.example' });
    check('origin: a POST from another site is refused (403)', foreign.status === 403);
    const putNoOrigin = await b.put('/api/account/save', { baseRev: 0, doc: saveDoc('x') }, { origin: null });
    check('origin: a PUT without Origin is refused (403)', putNoOrigin.status === 403);
    check('origin: the session survived the refused sign-outs', (await b.account()).status === 200);
    const allAnswers = [noOrigin, foreign, putNoOrigin, await b.get('/api/account')];
    check('every answer says no-store', allAnswers.every((r) => r.headers.get('Cache-Control') === 'no-store'));
    const devCall = await handleApi(
      new Request(`${SITE}/api/account`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } }),
      { ...w.env, DEV_ORIGINS: 'http://localhost:3000' } as Env,
      new URL(`${SITE}/api/account`),
      { accounts: w.inject },
    );
    check('dev origins: the preflight allows credentials and PUT', devCall.status === 204 && devCall.headers.get('Access-Control-Allow-Credentials') === 'true' && /PUT/.test(devCall.headers.get('Access-Control-Allow-Methods') ?? ''));

    // Sliding and ending
    const id = (await rows<{ id: string; last_seen_at: number }>(w.accounts, 'SELECT id, last_seen_at FROM sessions WHERE id = ?', await hex(b.jar.get('__Host-lc_session')!)))[0];
    clock += 30 * MIN;
    await b.account();
    const quiet = b.setCookies.length === 0 && (await one<{ last_seen_at: number }>(w.accounts, 'SELECT last_seen_at FROM sessions WHERE id = ?', id.id))?.last_seen_at === id.last_seen_at;
    clock += 31 * MIN;
    await b.account();
    const touched = (await one<{ last_seen_at: number }>(w.accounts, 'SELECT last_seen_at FROM sessions WHERE id = ?', id.id))?.last_seen_at === clock;
    check('session: its last use is written at most once an hour, with the cookie set again', quiet && touched && b.setCookies.some((c) => c.startsWith('__Host-lc_session=')));
    clock += 366 * DAY;
    const idle = await b.account();
    check('session: a year unused ends it (401 signedOut, cookie cleared)', idle.status === 401 && idle.body.signedOut === true && !b.jar.has('__Host-lc_session'));
    const nobody = await new Browser(w).account();
    check('GET /api/account signed out: 401 signedOut', nobody.status === 401 && nobody.body.signedOut === true);
    const out = new Browser(w);
    await viaSteam(w, out, '76561197960280004');
    const signOut = await out.post('/api/auth/signout');
    check('sign out: ok, the cookie cleared, the session gone', signOut.status === 200 && !out.jar.has('__Host-lc_session') && (await out.account()).status === 401);
  }

  // 6. Devices, names and the four widened checks --------------------------------------------------------------------------
  const K1 = keyNo(1); // holds alpha and beta
  const K2 = keyNo(2); // holds gamma
  const K5 = keyNo(5); // a second device of A, no names of its own
  const K6 = keyNo(6); // on no account
  const K9 = 'signout-cafe'.padEnd(43, 'c'); // holds a name on account A without being on it (a state an earlier fault could leave)
  const a = new Browser(w);
  const accountB = new Browser(w);
  let aId = '';
  let bId = '';
  {
    await claim(w, 'alpha', K1, { shown: 'Alpha' });
    await claim(w, 'beta', K1);
    await claim(w, 'gamma', K2, { shown: 'Gamma' });
    await viaDiscord(w, a, '900000000000000001');
    aId = (await a.account()).body.account.id;
    const joined = (await (await a.post('/api/account/device', { driverKey: K1, label: 'Chrome on macOS' })).json()) as { ok: boolean; attached: string[]; elsewhere: string[]; keyElsewhere: boolean };
    check('device: a key with two names brings both', joined.ok && joined.attached.join() === 'Alpha,beta' && joined.elsewhere.length === 0 && joined.keyElsewhere === false, JSON.stringify(joined));
    check('device: the names carry the account on the board', (await rows(w.board, 'SELECT name_key FROM drivers WHERE account_id = ? ORDER BY name_key', aId)).map((r) => r.name_key).join() === 'alpha,beta');
    const me = (await a.account()).body;
    check('device: joined now, its key listed as this device', me.thisDevice.joined === true && me.account.keys.length === 1 && me.account.keys[0].current === true && me.account.keys[0].id === (await hex(K1)).slice(0, 12) && me.account.keys[0].label === 'Chrome on macOS');
    check('device: the session carries the label', me.account.sessions.find((s: { current: boolean }) => s.current)?.label === 'Chrome on macOS');
    check('account: its names and driver name', me.account.names.length === 2 && ['Alpha', 'beta'].includes(me.account.driverName));

    await viaGoogle(w, accountB, '200000000000000002');
    bId = (await accountB.account()).body.account.id;
    await accountB.post('/api/account/device', { driverKey: K2, label: 'Firefox on Linux' });
    const onB = (await (await accountB.post('/api/account/device', { driverKey: K1, label: 'Firefox on Linux' })).json()) as { attached: string[]; elsewhere: string[]; keyElsewhere: boolean };
    check('device: a key on another account stays there (keyElsewhere), its names with it', onB.keyElsewhere === true && onB.attached.length === 0 && onB.elsewhere.join() === 'Alpha,beta', JSON.stringify(onB));
    check('device: the key is still on the first account', (await one<{ account_id: string }>(w.board, 'SELECT account_id FROM account_keys WHERE key_hash = ?', await hex(K1)))?.account_id === aId);
    await claim(w, 'delta', K9, { accountId: aId });
    await claim(w, 'epsilon', K9);
    const split = (await (await accountB.post('/api/account/device', { driverKey: K9, label: 'x' })).json()) as { attached: string[]; elsewhere: string[]; keyElsewhere: boolean };
    check('device: a name on another account is "elsewhere"; the key\'s free names attach', split.keyElsewhere === false && split.attached.join() === 'epsilon' && split.elsewhere.join() === 'delta', JSON.stringify(split));
    const badKey = await a.post('/api/account/device', { driverKey: 'short', label: 'x' });
    check('device: a malformed driver key is refused', badKey.status === 400);
    check('device: needs a session', (await new Browser(w).post('/api/account/device', { driverKey: K1, label: 'x' })).status === 401);
    // A's second device
    const a2 = new Browser(w);
    const code = ((await (await a.post('/api/account/link-code')).json()) as { code: string }).code;
    await a2.post('/api/auth/link-code/redeem', { code });
    const second = (await (await a2.post('/api/account/device', { driverKey: K5, label: 'Safari on iOS' })).json()) as { attached: string[] };
    check('device: a key with no names joins with none', second.attached.length === 0 && (await a.account()).body.account.keys.length === 2);
  }

  // The lap the uploads send: the LC26 on autopilot round RISE Motordrome, as the game records it
  const track = getActiveTrackData();
  const car = new F1Physics2026(track);
  car.aiAutopilot = true;
  const recorder = new LapRecorder({ trackLengthM: track.totalLengthM, turns: [], trackId: 'rwanda_official_short', vehicle: 'lc26', driverName: 'Alpha', driverCode: 'ALP' });
  let lap: LapRecording | null = null;
  for (let f = 0, laps = 0; f < 60 * 400 && !lap; f++) {
    const t = car.step(1 / 60, {});
    const done = recorder.update({
      telemetry: t,
      position: car.worldPosition,
      quaternion: car.worldQuaternion,
      conditions: { assists: 'pro', compound: 'medium', surface: 'dry', realism: 'full', physicsVersion: lapPhysicsVersion('lc26', 'rwanda_official_short'), autopilot: false },
    });
    if (done && ++laps === 2) lap = done.recording;
  }
  if (!lap) throw new Error('No lap completed');
  const upload = async (name: string, key: string) => {
    const rec = { ...lap!, driverName: name };
    const res = await new Browser(w).call('POST', '/api/laps', { body: { rec, driverKey: key }, origin: null, freshIp: true });
    return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; taken?: boolean; notFaster?: boolean } };
  };
  const rename = async (from: string, to: string, key: string) => {
    const res = await new Browser(w).call('POST', '/api/drivers/rename', { body: { from, to, driverKey: key }, origin: null, freshIp: true });
    return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; taken?: boolean; moved?: number } };
  };
  {
    const before = clock;
    const up = await upload('Alpha', K5);
    check('upload: a second key of the account posts under its name', up.status === 200 && up.body.ok, JSON.stringify(up.body));
    check('upload: an account key\'s last use is written', (await one<{ last_used_at: number }>(w.board, 'SELECT last_used_at FROM account_keys WHERE key_hash = ?', await hex(K5)))?.last_used_at === before);
    const stranger = await upload('Alpha', K6);
    check('upload: a key on no account is refused under it', stranger.status === 409 && stranger.body.taken === true);
    check(
      'upload: the refusal mentions signing in',
      stranger.body.error === 'This name is taken. Sign in to the account that holds it, import your driver key under Lap Times, or race under another name',
      stranger.body.error,
    );
    check('upload: a key of another account is refused under it', (await upload('Alpha', K2)).status === 409);
    clock += 10 * MIN;
    await upload('Beta', K5);
    check('upload: the last use is written at most once an hour', (await one<{ last_used_at: number }>(w.board, 'SELECT last_used_at FROM account_keys WHERE key_hash = ?', await hex(K5)))?.last_used_at === before);
    const fresh = await upload('Zeta', K5);
    const zeta = await one<{ key_hash: string; account_id: string }>(w.board, "SELECT key_hash, account_id FROM drivers WHERE name_key = 'zeta'");
    check('upload: a fresh claim by an account key joins the account', fresh.status === 200 && zeta?.account_id === aId && zeta.key_hash === (await hex(K5)));

    const moved = await rename('Alpha', 'Alpha Two', K5);
    const two = await one<{ key_hash: string; account_id: string }>(w.board, "SELECT key_hash, account_id FROM drivers WHERE name_key = 'alpha two'");
    check('rename: a second key of the account renames its name, laps along', moved.status === 200 && (moved.body.moved ?? 0) >= 1 && two?.account_id === aId && !(await one(w.board, "SELECT 1 FROM drivers WHERE name_key = 'alpha'")), JSON.stringify(moved.body));
    check('rename: a key on no account can\'t take an account name', (await rename('', 'Beta', K6)).status === 409);
    check('rename: an account key may write an account name in other letters', (await rename('Beta', 'BETA', K5)).status === 200);

    // Race results
    const proven = await provenNameKeys(w.board, {
      p1: { name: 'Beta', code: 'BET', keyHash: await hex(K5) },
      p2: { name: 'Beta', code: 'BET', keyHash: await hex(K6) },
      p3: { name: 'Gamma', code: 'GAM', keyHash: await hex(K5) },
      p4: { name: 'Gamma', code: 'GAM', keyHash: await hex(K2) },
      p5: { name: 'Beta', code: 'BET' },
    });
    check('race results: an account key proves an account name; others don\'t', [...proven.keys()].sort().join() === 'p1,p4', [...proven.keys()].join());

    // The Creator badge
    const creatorK5 = [await hex(K5)];
    const badges = await badgesOf(w.board, ['beta', 'gamma', 'alpha two'], clock, [], creatorK5);
    check('creator: any name of an account a creator key is on wears it', badges.beta?.some((x) => x.type === 'creator') === true && badges['alpha two']?.some((x) => x.type === 'creator') === true);
    check('creator: a name of another account does not', !badges.gamma?.some((x) => x.type === 'creator'));
    const viaApi = await handleApi(new Request(`${SITE}/api/badges?names=beta,gamma`), { ...w.env, CREATOR_KEY_HASH: creatorK5[0] } as Env, new URL(`${SITE}/api/badges?names=beta,gamma`));
    const apiBadges = ((await viaApi.json()) as { badges: Record<string, { type: string }[]> }).badges;
    check('creator: GET /api/badges agrees', apiBadges.beta?.some((x) => x.type === 'creator') === true && !apiBadges.gamma?.some((x) => x.type === 'creator'));
  }

  // 7. A removed key, names that don't lapse -------------------------------------------------------------------------------
  {
    const kid = (await hex(K1)).slice(0, 12);
    const removed = await a.post('/api/account/keys/remove', { id: kid });
    check('keys/remove: ok', removed.status === 200);
    const beta = await one<{ key_hash: string; account_id: string }>(w.board, "SELECT key_hash, account_id FROM drivers WHERE name_key = 'beta'");
    check('keys/remove: its names stay on the account under the account\'s own hash', beta?.key_hash === `account:${aId}` && beta.account_id === aId);
    check('keys/remove: the removed key no longer posts under them', (await rename('', 'Beta', K1)).status === 409);
    check('keys/remove: the account\'s other keys still do', (await rename('', 'Beta', K5)).status === 200);
    const me = (await a.account()).body;
    check('keys/remove: the device that used it is no longer joined', me.thisDevice.joined === false && me.account.keys.length === 1);
    {
      // Signing out takes the device's key off the account, unless another session still holds it
      const visit = new Browser(w);
      await viaSteam(w, visit, '76561197960287990');
      const K9 = keyNo(9);
      check('signout: a device joins', (await visit.post('/api/account/device', { driverKey: K9, label: 'Cafe PC' })).status === 200);
      await claim(w, 'visitor', K9);
      const visitorAccount = (await visit.account()).body.account.id as string;
      await w.board.prepare("UPDATE drivers SET account_id = ? WHERE name_key = 'visitor'").bind(visitorAccount).run();
      const K10 = 'signout-home'.padEnd(43, 'h');
      await (async () => {
        const second = new Browser(w);
        await viaSteam(w, second, '76561197960287990');
        await second.post('/api/account/device', { driverKey: K10, label: 'Home' });
      })();
      check('signout: before it, the key posts under the name', (await rename('', 'Visitor', K9)).status === 200);
      check('signout: ok', (await visit.post('/api/auth/signout')).status === 200);
      const left = await one<{ key_hash: string }>(w.board, "SELECT key_hash FROM drivers WHERE name_key = 'visitor'");
      check('signout: the key leaves the account', !(await one(w.board, 'SELECT 1 FROM account_keys WHERE key_hash = ?', await hex(K9))) && left?.key_hash === `account:${visitorAccount}`);
      check('signout: the next person at that device can\'t post under the name', (await rename('', 'Visitor', K9)).status === 409);
      check('signout: the account\'s other device still can', (await rename('', 'Visitor', K10)).status === 200);
    }
    check('keys/remove: an id not on the account is 404', (await a.post('/api/account/keys/remove', { id: (await hex(K2)).slice(0, 12) })).status === 404);

    await claim(w, 'omega', keyNo(7), { lastSeen: clock - 200 * DAY });
    await w.board.prepare("UPDATE drivers SET last_seen = ? WHERE name_key = 'beta'").bind(clock - 200 * DAY).run();
    const K8 = keyNo(8);
    check('lapse: a name on no account lapses after six months', (await rename('', 'Omega', K8)).status === 200);
    check('lapse: a name on an account does not', (await rename('', 'Beta', K8)).status === 409 && (await one<{ account_id: string }>(w.board, "SELECT account_id FROM drivers WHERE name_key = 'beta'"))?.account_id === aId);
  }

  // 8. Link codes ----------------------------------------------------------------------------------------------------------
  {
    const made = (await (await a.post('/api/account/link-code')).json()) as { ok: boolean; code: string; expiresAt: number };
    check('link code: 8 characters of the alphabet, 10 minutes', made.ok && made.code.length === 8 && [...made.code].every((ch) => LINK_CODE_ALPHABET.includes(ch)) && made.expiresAt === clock + 10 * MIN);
    const stored = await rows<{ code_hash: string }>(w.accounts, 'SELECT code_hash FROM link_codes');
    check('link code: only its SHA-256 is stored', stored.length === 1 && stored[0].code_hash === (await hex(made.code)) && !JSON.stringify(await rows(w.accounts, 'SELECT * FROM link_codes')).includes(made.code));
    const newer = (await (await a.post('/api/account/link-code')).json()) as { code: string };
    const other = new Browser(w);
    check('link code: a new one replaces the older', (await other.post('/api/auth/link-code/preview', { code: made.code })).status === 404);
    const typed = `${newer.code.slice(0, 4).toLowerCase()} - ${newer.code.slice(4).toLowerCase()}`;
    check('link code: typing ignores case, spaces and dashes', normaliseLinkCode(typed) === newer.code);
    const preview = (await (await other.post('/api/auth/link-code/preview', { code: typed })).json()) as { ok: boolean; driverName: string | null; providers: string[] };
    check('link code: the preview names the account', preview.ok && preview.driverName !== null && preview.providers.join() === 'discord', JSON.stringify(preview));
    check('link code: a preview leaves it good', (await other.post('/api/auth/link-code/preview', { code: newer.code })).status === 200);
    const redeemed = (await (await other.post('/api/auth/link-code/redeem', { code: typed })).json()) as { ok: boolean; result: string };
    check('link code: redeeming signs this browser in to the account', redeemed.ok && redeemed.result === 'signed-in' && (await other.account()).body.account.id === aId);
    check('link code: used once', (await new Browser(w).post('/api/auth/link-code/redeem', { code: newer.code })).status === 404);
    const late = (await (await a.post('/api/account/link-code')).json()) as { code: string };
    clock += 11 * MIN;
    const lateBrowser = new Browser(w);
    check('link code: gone after 10 minutes', (await lateBrowser.post('/api/auth/link-code/preview', { code: late.code })).status === 404 && (await lateBrowser.post('/api/auth/link-code/redeem', { code: late.code })).status === 404);
    check('link code: a code that can\'t be one is a 400', (await lateBrowser.post('/api/auth/link-code/preview', { code: 'ABC' })).status === 400 && (await lateBrowser.post('/api/auth/link-code/preview', { code: 'ABCDEFG0' })).status === 400);
    check('link code: making one needs a session', (await new Browser(w).post('/api/account/link-code')).status === 401);
    const limited = makeWorld({ authMax: 2 });
    const lb = new Browser(limited);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await lb.post('/api/auth/link-code/preview', { code: 'ABCDEFGH' })).status);
    statuses.push((await lb.post('/api/auth/link-code/redeem', { code: 'ABCDEFGH' })).status);
    check('link code: previews and redeems count against AUTH_LIMIT', statuses.join() === '404,404,429,429', statuses.join());
    // Switching accounts with a code
    const onB = new Browser(w);
    await viaGoogle(w, onB, '200000000000000002');
    const switchCode = (await (await a.post('/api/account/link-code')).json()) as { code: string };
    const oldSession = await hex(onB.jar.get('__Host-lc_session')!);
    await onB.post('/api/auth/link-code/redeem', { code: switchCode.code });
    check('link code: a browser signed in elsewhere switches, its old session ended', (await onB.account()).body.account.id === aId && !(await one(w.accounts, 'SELECT 1 FROM sessions WHERE id = ?', oldSession)));
  }

  // 9. The cloud save and its ghosts ---------------------------------------------------------------------------------------
  const ghostText = (n: number) => JSON.stringify({ trackId: 'track', samples: [n, n + 1, n + 2] });
  {
    const empty = (await (await a.get('/api/account/save')).json()) as { ok: boolean; rev: number; doc: unknown; pending: unknown[] };
    check('save: none yet is rev 0, no doc', empty.ok && empty.rev === 0 && empty.doc === null && empty.pending.length === 0);
    const g1 = await hex(ghostText(1));
    const g2 = await hex(ghostText(2));
    const missing = (await (await a.post('/api/account/ghosts/missing', { shas: [g1, g2, g1] })).json()) as { missing: string[] };
    check('ghosts: missing lists what the cloud lacks, once each', missing.missing.join() === `${g1},${g2}`);
    const put1 = await a.call('PUT', `/api/account/ghosts/${g1}`, { raw: ghostText(1) });
    check('ghosts: a PUT whose hash matches is stored', put1.status === 200 && (await rows(w.accounts, 'SELECT * FROM cloud_ghosts')).length === 1);
    const r2Key = (await one<{ r2_key: string }>(w.accounts, 'SELECT r2_key FROM cloud_ghosts WHERE sha256 = ?', g1))?.r2_key ?? '';
    check('ghosts: kept in the ghost bucket under accounts/ghosts/', /^accounts\/ghosts\/[0-9a-f-]{36}\.json$/.test(r2Key) && w.ghosts.objects.get(r2Key) === ghostText(1));
    const mismatch = await a.call('PUT', `/api/account/ghosts/${g2}`, { raw: ghostText(3) });
    check('ghosts: a body that doesn\'t match its hash is a 400', mismatch.status === 400);
    check('ghosts: a second PUT of the same changes nothing', (await a.call('PUT', `/api/account/ghosts/${g1}`, { raw: ghostText(1) })).status === 200 && (await rows(w.accounts, 'SELECT * FROM cloud_ghosts')).length === 1);
    const got = await a.get(`/api/account/ghosts/${g1}`);
    check('ghosts: GET gives the text back', got.status === 200 && (await got.text()) === ghostText(1));
    check('ghosts: one the account lacks is 404', (await a.get(`/api/account/ghosts/${g2}`)).status === 404);
    check('ghosts: another account can\'t read it', (await accountB.get(`/api/account/ghosts/${g1}`)).status === 404);
    const big = 'x'.repeat(2 * 1024 * 1024 + 1);
    check('ghosts: larger than 2 MB is a 413', (await a.call('PUT', `/api/account/ghosts/${await hex(big)}`, { raw: big })).status === 413);
    check('ghosts: not JSON is a 400', (await a.call('PUT', `/api/account/ghosts/${await hex('nope')}`, { raw: 'nope' })).status === 400);

    const first = (await (await a.put('/api/account/save', { baseRev: 0, doc: saveDoc('one', [g1]), combinedPending: [] })).json()) as { ok: boolean; rev: number };
    check('save: the first write is rev 1', first.ok && first.rev === 1);
    const read = (await (await a.get('/api/account/save')).json()) as { rev: number; doc: SaveDoc };
    check('save: read back as written', read.rev === 1 && read.doc.keys['bugesera.track'].value === 'one');
    const clash = await a.put('/api/account/save', { baseRev: 0, doc: saveDoc('two'), combinedPending: [] });
    const clashBody = (await clash.json()) as { conflict: boolean; rev: number; doc: SaveDoc };
    check('save: a write over an older rev is a 409 with what is there', clash.status === 409 && clashBody.conflict === true && clashBody.rev === 1 && clashBody.doc.keys['bugesera.track'].value === 'one');
    const second = (await (await a.put('/api/account/save', { baseRev: 1, doc: saveDoc('two', [g1]), combinedPending: [] })).json()) as { rev: number };
    check('save: a write over the current rev goes up by one', second.rev === 2);
    const stale = await a.put('/api/account/save', { baseRev: 1, doc: saveDoc('three'), combinedPending: [] });
    check('save: the stale rev again is a 409 with rev 2', stale.status === 409 && ((await stale.json()) as { rev: number }).rev === 2);
    const huge = saveDoc('big');
    huge.keys.big = { value: 'x'.repeat(1_000_001), t: 0 };
    check('save: larger than 1 MB is a 413', (await a.put('/api/account/save', { baseRev: 2, doc: huge, combinedPending: [] })).status === 413);
    check('save: a doc of another shape is a 400', (await a.put('/api/account/save', { baseRev: 2, doc: { v: 2 }, combinedPending: [] })).status === 400);
    check('save: needs a session', (await new Browser(w).get('/api/account/save')).status === 401);
    const info = (await a.account()).body.account.save;
    check('account: the save\'s rev, time and size', info.rev === 2 && info.bytes > 0);

    // The ghosts' sweep: g2 goes up, no save points at it
    await a.call('PUT', `/api/account/ghosts/${g2}`, { raw: ghostText(2) });
    const g2Key = (await one<{ r2_key: string }>(w.accounts, 'SELECT r2_key FROM cloud_ghosts WHERE sha256 = ?', g2))!.r2_key;
    await a.put('/api/account/save', { baseRev: 2, doc: saveDoc('three', [g1]), combinedPending: [] });
    check('ghosts: an unused one younger than an hour stays', w.ghosts.objects.has(g2Key) && !!(await one(w.accounts, 'SELECT 1 FROM cloud_ghosts WHERE sha256 = ?', g2)));
    clock += 61 * MIN;
    await a.put('/api/account/save', { baseRev: 3, doc: saveDoc('four', [g1]), combinedPending: [] });
    check('ghosts: an hour on, the next save sweeps it (row and file)', !w.ghosts.objects.has(g2Key) && !(await one(w.accounts, 'SELECT 1 FROM cloud_ghosts WHERE sha256 = ?', g2)) && w.ghosts.objects.has(r2Key));

    // The cap
    const capWorld = makeWorld();
    const capped = new Browser(capWorld);
    await viaSteam(capWorld, capped, '76561197960281000');
    const capId = (await capped.account()).body.account.id;
    for (let i = 0; i < MAX_GHOSTS_PER_ACCOUNT; i++) {
      await capWorld.accounts.prepare('INSERT INTO cloud_ghosts (account_id, sha256, r2_key, bytes, created_at) VALUES (?, ?, ?, 1, ?)').bind(capId, i.toString(16).padStart(64, '0'), `k${i}`, clock).run();
    }
    const over = await capped.call('PUT', `/api/account/ghosts/${await hex(ghostText(9))}`, { raw: ghostText(9) });
    check(`ghosts: past ${MAX_GHOSTS_PER_ACCOUNT} per account is refused (409)`, over.status === 409);
    const limited = makeWorld({ saveMax: 1 });
    const lim = new Browser(limited);
    await viaSteam(limited, lim, '76561197960281001');
    const saveStatuses = [(await lim.get('/api/account/save')).status, (await lim.get('/api/account/save')).status, (await lim.post('/api/account/ghosts/missing', { shas: [] })).status];
    check('save: SAVE_LIMIT per address, the ghosts on a budget of their own', saveStatuses.join() === '200,429,200', saveStatuses.join());
  }

  // 10. Folding one account into another (link) ---------------------------------------------------------------------------
  {
    // B: a passkey, a Google sign-in, a save, a pending save of its own, ghosts (one A has too), a link code
    const g1 = await hex(ghostText(1));
    const g3 = await hex(ghostText(3));
    await accountB.call('PUT', `/api/account/ghosts/${g1}`, { raw: ghostText(1) });
    await accountB.call('PUT', `/api/account/ghosts/${g3}`, { raw: ghostText(3) });
    const bTwin = (await one<{ r2_key: string }>(w.accounts, 'SELECT r2_key FROM cloud_ghosts WHERE account_id = ? AND sha256 = ?', bId, g1))!.r2_key;
    const aTwin = (await one<{ r2_key: string }>(w.accounts, 'SELECT r2_key FROM cloud_ghosts WHERE account_id = ? AND sha256 = ?', aId, g1))!.r2_key;
    await accountB.put('/api/account/save', { baseRev: 0, doc: saveDoc('from B', [g1, g3]), combinedPending: [] });
    await w.accounts.prepare("INSERT INTO pending_saves (account_id, from_account_id, doc, created_at) VALUES (?, 'older', ?, ?)").bind(bId, JSON.stringify(saveDoc('older')), clock).run();
    await w.accounts.prepare("INSERT INTO passkeys (id, account_id, public_key, counter, transports, label, created_at) VALUES ('cred-b', ?, 'AQID', 0, '[]', 'Passkey added', ?)").bind(bId, clock).run();
    await accountB.post('/api/account/link-code');
    // B's key K2 had dropped one name before: it carries B's own hash
    await claim(w, 'kappa', keyNo(12), { accountId: bId });
    await w.board.prepare("UPDATE drivers SET key_hash = ? WHERE name_key = 'kappa'").bind(`account:${bId}`).run();

    const linked = await viaGoogle(w, a, '200000000000000002', { intent: 'link' });
    check('merge: proving B\'s sign-in while signed in to A is "merged"', linked.result === 'merged', String(linked.result));
    check('merge: B is gone, a merges_log row says so', !(await one(w.accounts, 'SELECT 1 FROM accounts WHERE id = ?', bId)) && !!(await one(w.accounts, 'SELECT 1 FROM merges_log WHERE into_account_id = ? AND from_account_id = ?', aId, bId)));
    check('merge: B\'s sign-ins and passkeys are A\'s', (await rows(w.accounts, 'SELECT provider FROM identities WHERE account_id = ?', aId)).some((r) => r.provider === 'google') && (await one<{ account_id: string }>(w.accounts, "SELECT account_id FROM passkeys WHERE id = 'cred-b'"))?.account_id === aId);
    check('merge: B\'s devices are signed in to A', (await accountB.account()).body.account?.id === aId);
    check('merge: B\'s names and keys are A\'s', (await one<{ account_id: string }>(w.board, "SELECT account_id FROM drivers WHERE name_key = 'gamma'"))?.account_id === aId && (await one<{ account_id: string }>(w.board, 'SELECT account_id FROM account_keys WHERE key_hash = ?', await hex(K2)))?.account_id === aId);
    check('merge: a name only B held is A\'s alone now', (await one<{ key_hash: string; account_id: string }>(w.board, "SELECT key_hash, account_id FROM drivers WHERE name_key = 'kappa'"))?.key_hash === `account:${aId}`);
    check('merge: B\'s key now posts under A\'s names', (await rename('', 'Zeta', K2)).status === 200);
    const ghostsOfA = await rows<{ sha256: string; r2_key: string }>(w.accounts, 'SELECT sha256, r2_key FROM cloud_ghosts WHERE account_id = ? ORDER BY sha256', aId);
    check('merge: ghosts move, one both had kept once (B\'s copy deleted)', ghostsOfA.length === 2 && ghostsOfA.some((g) => g.sha256 === g3) && ghostsOfA.find((g) => g.sha256 === g1)?.r2_key === aTwin && !w.ghosts.objects.has(bTwin) && w.ghosts.objects.has(aTwin));
    const pending = (await (await a.get('/api/account/save')).json()) as { pending: { id: number; doc: SaveDoc }[] };
    check('merge: B\'s save and its pending save wait for A\'s next sync', pending.pending.length === 2 && pending.pending.some((p) => p.doc.keys['bugesera.track'].value === 'from B'));
    check('merge: B\'s save row and link codes are gone', !(await one(w.accounts, 'SELECT 1 FROM saves WHERE account_id = ?', bId)) && !(await one(w.accounts, 'SELECT 1 FROM link_codes WHERE account_id = ?', bId)));
    check('account: pendingMerges counts them', (await a.account()).body.account.pendingMerges === 2);
    // A ghost a pending save points at survives the sweep
    clock += 2 * HOUR;
    const cur = (await (await a.get('/api/account/save')).json()) as { rev: number };
    await a.put('/api/account/save', { baseRev: cur.rev, doc: saveDoc('five', [g1]), combinedPending: [] });
    check('ghosts: one a pending save points at survives the sweep', !!(await one(w.accounts, 'SELECT 1 FROM cloud_ghosts WHERE account_id = ? AND sha256 = ?', aId, g3)));
    const combined = await a.put('/api/account/save', { baseRev: cur.rev, doc: saveDoc('six', [g1]), combinedPending: pending.pending.map((p) => p.id) });
    check('save: a conflict leaves the pending saves', combined.status === 409 && (await rows(w.accounts, 'SELECT * FROM pending_saves WHERE account_id = ?', aId)).length === 2);
    await a.put('/api/account/save', { baseRev: cur.rev + 1, doc: saveDoc('six', [g1]), combinedPending: pending.pending.map((p) => p.id) });
    check('save: combinedPending clears them once written', (await rows(w.accounts, 'SELECT * FROM pending_saves WHERE account_id = ?', aId)).length === 0);

    check('link: the same sign-in again is "already-linked"', (await viaGoogle(w, a, '200000000000000002', { intent: 'link' })).result === 'already-linked');
    check('link: a free sign-in is "linked"', (await viaSteam(w, a, '76561197960289999', { intent: 'link' })).result === 'linked');
    check('link: without a session it fails', (await viaSteam(w, new Browser(w), '76561197960289998', { intent: 'link' })).result === 'failed');
    const switched = new Browser(w);
    await viaSteam(w, switched, '76561197960289997');
    const crossSite = await switched.get('/api/auth/start/discord?intent=link', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    check('link: a start from another site is refused', resultOf(crossSite) === 'failed');
    const noSignal = await switched.get('/api/auth/start/discord?intent=link', { headers: { 'Sec-Fetch-Site': 'none' } });
    check('link: a start typed or bookmarked is refused', resultOf(noSignal) === 'failed');
    const startLink = await switched.get('/api/auth/start/discord?intent=link');
    const linkState = new URL(startLink.headers.get('Location')!).searchParams.get('state')!;
    const keepAuth = switched.jar.get('__Host-lc_auth')!;
    await viaSteam(w, switched, '76561197960289996');
    switched.jar.set('__Host-lc_auth', keepAuth);
    w.providers.discordCodes.set('switch-code', '900000000000000777');
    const crossed = await switched.get(`/api/auth/callback/discord?code=switch-code&state=${linkState}`);
    check('link: signed in to another account by the callback, it fails', resultOf(crossed) === 'failed');
  }

  // 11. Ways in, devices --------------------------------------------------------------------------------------------------
  {
    const solo = new Browser(w);
    await viaDiscord(w, solo, '930000000000000001');
    const last = await solo.post('/api/account/identities/remove', { provider: 'discord' });
    check('ways in: the last sign-in can\'t be removed (409)', last.status === 409);
    await viaSteam(w, solo, '76561197960285555', { intent: 'link' });
    check('ways in: with another, it can', (await solo.post('/api/account/identities/remove', { provider: 'discord' })).status === 200);
    check('ways in: a sign-in not on the account is 404', (await solo.post('/api/account/identities/remove', { provider: 'google' })).status === 404);
    check('ways in: an unknown provider is a 400', (await solo.post('/api/account/identities/remove', { provider: 'myspace' })).status === 400);
    const soloId = (await solo.account()).body.account.id;
    await w.accounts.prepare("INSERT INTO passkeys (id, account_id, public_key, counter, transports, label, created_at) VALUES ('cred-solo', ?, 'AQID', 0, '[]', 'p', ?)").bind(soloId, clock).run();
    check('ways in: a passkey goes while a sign-in is left', (await solo.post('/api/account/passkeys/remove', { id: 'cred-solo' })).status === 200);
    check('ways in: a passkey not on the account is 404', (await solo.post('/api/account/passkeys/remove', { id: 'cred-b' })).status === 404);
    await w.accounts.prepare("INSERT INTO passkeys (id, account_id, public_key, counter, transports, label, created_at) VALUES ('cred-solo2', ?, 'AQID', 0, '[]', 'p', ?)").bind(soloId, clock).run();
    await solo.post('/api/account/identities/remove', { provider: 'steam' });
    check('ways in: the last passkey can\'t be removed either', (await solo.post('/api/account/passkeys/remove', { id: 'cred-solo2' })).status === 409);
    // Sessions
    const other = new Browser(w);
    const code = ((await (await solo.post('/api/account/link-code')).json()) as { code: string }).code;
    await other.post('/api/auth/link-code/redeem', { code });
    const listed = (await solo.account()).body.account.sessions as { id: string; current: boolean }[];
    const theirs = listed.find((s) => !s.current)!;
    check('sessions: listed by public id, this one marked', listed.length === 2 && listed.filter((s) => s.current).length === 1 && !/^[0-9a-f]{64}$/.test(theirs.id));
    check('sessions: remove signs that device out', (await solo.post('/api/account/sessions/remove', { id: theirs.id })).status === 200 && (await other.account()).status === 401);
    check('sessions: one of another account is 404', (await solo.post('/api/account/sessions/remove', { id: ((await a.account()).body.account.sessions[0] as { id: string }).id })).status === 404);
    const mine = listed.find((s) => s.current)!;
    await solo.post('/api/account/sessions/remove', { id: mine.id });
    check('sessions: removing this one signs it out', !solo.jar.has('__Host-lc_session') && (await solo.account()).status === 401);
  }

  // 12. Deleting an account -----------------------------------------------------------------------------------------------
  {
    const d = makeWorld();
    const dev = new Browser(d);
    const KD1 = keyNo(21);
    const KD2 = keyNo(22);
    await claim(d, 'dee one', KD1, { shown: 'Dee One' });
    await claim(d, 'dee two', KD2, { shown: 'Dee Two' });
    await viaDiscord(d, dev, '940000000000000001');
    const dId = (await dev.account()).body.account.id;
    const second = new Browser(d);
    await second.post('/api/auth/link-code/redeem', { code: ((await (await dev.post('/api/account/link-code')).json()) as { code: string }).code });
    await second.post('/api/account/device', { driverKey: KD2, label: 'two' });
    await dev.post('/api/account/device', { driverKey: KD1, label: 'one' });
    await dev.post('/api/account/keys/remove', { id: (await hex(KD2)).slice(0, 12) });
    await dev.put('/api/account/save', { baseRev: 0, doc: saveDoc('d'), combinedPending: [] });
    const gd = await hex(ghostText(40));
    await dev.call('PUT', `/api/account/ghosts/${gd}`, { raw: ghostText(40) });
    const gdKey = (await one<{ r2_key: string }>(d.accounts, 'SELECT r2_key FROM cloud_ghosts WHERE sha256 = ?', gd))!.r2_key;
    check('delete: needs confirm "delete"', (await dev.post('/api/account/delete', { removeLaps: false })).status === 400);
    const gone = (await (await dev.post('/api/account/delete', { removeLaps: false, confirm: 'delete' })).json()) as { ok: boolean; removedLaps: number };
    check('delete (keep laps): ok, no laps removed', gone.ok && gone.removedLaps === 0);
    const one1 = await one<{ key_hash: string; account_id: string | null }>(d.board, "SELECT key_hash, account_id FROM drivers WHERE name_key = 'dee one'");
    const two2 = await one<{ key_hash: string; account_id: string | null }>(d.board, "SELECT key_hash, account_id FROM drivers WHERE name_key = 'dee two'");
    check('delete (keep laps): names leave the account, each with its key', one1?.account_id === null && one1.key_hash === (await hex(KD1)) && two2?.account_id === null);
    check('delete (keep laps): a name only the account held goes to this device\'s key', two2?.key_hash === (await hex(KD1)));
    check('delete (keep laps): the laps stay', (await rows(d.board, 'SELECT * FROM laps')).length === 2);
    check('delete: no account_keys left', (await rows(d.board, 'SELECT * FROM account_keys')).length === 0);
    const leftovers = await Promise.all(['accounts', 'identities', 'sessions', 'passkeys', 'saves', 'pending_saves', 'cloud_ghosts', 'link_codes', 'auth_states', 'merges_log'].map(async (t) => [t, (await rows(d.accounts, `SELECT * FROM ${t}`)).length] as const));
    check('delete: nothing of the account is left in its database', leftovers.every(([, n]) => n === 0), leftovers.map(([t, n]) => `${t}=${n}`).join(' '));
    check('delete: its cloud ghost files are gone', !d.ghosts.objects.has(gdKey));
    check('delete: this browser is signed out, the other device too', !dev.jar.has('__Host-lc_session') && (await dev.account()).status === 401 && (await second.account()).status === 401);

    // Without a device key: a name only the account held keeps the account's hash and lapses in time
    const e = makeWorld();
    const eb = new Browser(e);
    await claim(e, 'ee', keyNo(31));
    await viaSteam(e, eb, '76561197960282222');
    const eId = (await eb.account()).body.account.id;
    await eb.post('/api/account/device', { driverKey: keyNo(31), label: 'x' });
    await eb.post('/api/account/keys/remove', { id: (await hex(keyNo(31))).slice(0, 12) });
    await eb.post('/api/account/delete', { removeLaps: false, confirm: 'delete' });
    const ee = await one<{ key_hash: string; account_id: string | null }>(e.board, "SELECT key_hash, account_id FROM drivers WHERE name_key = 'ee'");
    check('delete (keep laps), no device key: the name keeps the account\'s hash, off the account', ee?.key_hash === `account:${eId}` && ee.account_id === null);

    // With removeLaps
    const r = makeWorld();
    const rb = new Browser(r);
    const KR = keyNo(41);
    await claim(r, 'arr', KR);
    const lapIds = [await addLap(r, 'arr', 'Arr'), await addLap(r, 'arr', 'Arr')];
    const keepLap = await addLap(r, 'someone', 'Someone');
    await r.board.prepare("INSERT INTO races (id, week, kind, track_id, vehicle, laps, finished_ms) VALUES ('race-1', '2026-W47', 'open', 't', 'lc26', 3, ?)").bind(clock).run();
    await r.board.prepare("INSERT INTO race_cars (race_id, position, name_key, name, code, time_s, penalty_s, laps, best_lap_ms, dnf, grid) VALUES ('race-1', 1, 'arr', 'Arr', 'ARR', 100, 0, 3, 30000, 0, 1)").run();
    await r.board.prepare("INSERT INTO race_cars (race_id, position, name_key, name, code, time_s, penalty_s, laps, best_lap_ms, dnf, grid) VALUES ('race-1', 2, 'someone', 'Someone', 'SOM', 101, 0, 3, 30000, 0, 2)").run();
    await r.board.prepare("INSERT INTO driver_awards (name_key, badge_type, note, awarded_at, awarded_by, driver_name) VALUES ('arr', 'bulb', 'idea', ?, 'admin', 'Arr')").bind(clock).run();
    await r.board.prepare("INSERT INTO driver_awards (name_key, badge_type, note, awarded_at, awarded_by, driver_name) VALUES ('someone', 'bulb', 'idea', ?, 'admin', 'Someone')").bind(clock).run();
    await viaSteam(r, rb, '76561197960283333');
    await rb.post('/api/account/device', { driverKey: KR, label: 'x' });
    const removed = (await (await rb.post('/api/account/delete', { removeLaps: true, confirm: 'delete' })).json()) as { ok: boolean; removedLaps: number };
    check('delete (remove laps): its laps and their ghosts go, counted', removed.ok && removed.removedLaps === 2 && lapIds.every((id) => !r.ghosts.objects.has(`laps/${id}.json`)) && (await rows(r.board, "SELECT * FROM laps WHERE name_key = 'arr'")).length === 0);
    check('delete (remove laps): another driver\'s lap stays', r.ghosts.objects.has(`laps/${keepLap}.json`) && (await rows(r.board, "SELECT * FROM laps WHERE name_key = 'someone'")).length === 1);
    const carRow = await one<{ name_key: string | null; name: string; code: string }>(r.board, "SELECT name_key, name, code FROM race_cars WHERE race_id = 'race-1' AND position = 1");
    check('delete (remove laps): its race results stay as an anonymous Driver', carRow?.name_key === null && carRow.name === 'Driver' && carRow.code === 'DRV');
    check('delete (remove laps): other cars of the race are untouched', (await one<{ name_key: string }>(r.board, "SELECT name_key FROM race_cars WHERE position = 2"))?.name_key === 'someone');
    check('delete (remove laps): its badges go, others stay', (await rows(r.board, "SELECT * FROM driver_awards WHERE name_key = 'arr'")).length === 0 && (await rows(r.board, "SELECT * FROM driver_awards WHERE name_key = 'someone'")).length === 1);
    check('delete (remove laps): the name is free', !(await one(r.board, "SELECT 1 FROM drivers WHERE name_key = 'arr'")));
  }

  // 13. Passkeys with a stand-in verifier ----------------------------------------------------------------------------------
  {
    let n = 0;
    const seen: { kind: string; opts: Record<string, any> }[] = [];
    const fake: WebAuthnLib = {
      generateRegistrationOptions: (async (o: Record<string, any>) => {
        seen.push({ kind: 'regOptions', opts: o });
        return { challenge: `reg-challenge-${++n}`, rp: { name: o.rpName, id: o.rpID }, user: { id: 'u', name: o.userName, displayName: o.userDisplayName }, pubKeyCredParams: [] };
      }) as unknown as WebAuthnLib['generateRegistrationOptions'],
      generateAuthenticationOptions: (async (o: Record<string, any>) => {
        seen.push({ kind: 'authOptions', opts: o });
        return { challenge: `auth-challenge-${++n}`, rpId: o.rpID, allowCredentials: [] };
      }) as unknown as WebAuthnLib['generateAuthenticationOptions'],
      verifyRegistrationResponse: (async (o: Record<string, any>) => {
        seen.push({ kind: 'verifyReg', opts: o });
        if (o.response.bad) throw new Error('bad attestation');
        return { verified: true, registrationInfo: { credential: { id: o.response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] } } };
      }) as unknown as WebAuthnLib['verifyRegistrationResponse'],
      verifyAuthenticationResponse: (async (o: Record<string, any>) => {
        seen.push({ kind: 'verifyAuth', opts: o });
        if (o.response.bad) return { verified: false, authenticationInfo: { newCounter: 0 } };
        return { verified: true, authenticationInfo: { credentialID: o.credential.id, newCounter: o.credential.counter + 1 } };
      }) as unknown as WebAuthnLib['verifyAuthenticationResponse'],
    };
    const p = makeWorld({ webauthn: fake });
    const maker = new Browser(p);
    const opts = (await (await maker.post('/api/auth/passkey/options', { mode: 'create', displayName: 'Secret Display Name' })).json()) as { ok: boolean; challengeId: string; options: { challenge: string } };
    const regOpts = seen.find((s) => s.kind === 'regOptions')!.opts;
    check(
      'passkey: create asks for a discoverable credential on this host',
      opts.ok && regOpts.rpID === 'librecorsa.org' && regOpts.authenticatorSelection.residentKey === 'required' && regOpts.authenticatorSelection.userVerification === 'preferred' && regOpts.attestationType === 'none',
    );
    const created = (await (await maker.post('/api/auth/passkey/verify', { challengeId: opts.challengeId, response: { id: 'cred-one', response: {} } })).json()) as { ok: boolean; result: string };
    const verifyReg = seen.find((s) => s.kind === 'verifyReg')!.opts;
    check('passkey: create makes an account and signs in', created.ok && created.result === 'created' && (await maker.account()).body.account.passkeys.length === 1);
    check('passkey: verified against the stored challenge, the site\'s origin and host', verifyReg.expectedChallenge === opts.options.challenge && verifyReg.expectedOrigin.includes(SITE) && verifyReg.expectedRPID === 'librecorsa.org');
    const dump = JSON.stringify([...(await rows(p.accounts, 'SELECT * FROM accounts')), ...(await rows(p.accounts, 'SELECT * FROM passkeys')), ...(await rows(p.accounts, 'SELECT * FROM auth_states'))]);
    check('passkey: the display name is never stored', !dump.includes('Secret Display Name'));
    const day = new Date(clock);
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][day.getUTCMonth()];
    check('passkey: labelled by the day it was added', (await maker.account()).body.account.passkeys[0].label === `Passkey added ${day.getUTCDate()} ${month} ${day.getUTCFullYear()}`);
    const regUser = regOpts.userID as Uint8Array;
    const handle = (await one<{ webauthn_user_id: string }>(p.accounts, 'SELECT webauthn_user_id FROM accounts'))!.webauthn_user_id;
    check('passkey: the account keeps the user handle the authenticator got', b64url(regUser) === handle);
    check('passkey: a challenge is used once', (await maker.post('/api/auth/passkey/verify', { challengeId: opts.challengeId, response: { id: 'cred-x', response: {} } })).status === 410);
    check('passkey: create while signed in is refused', (await maker.post('/api/auth/passkey/options', { mode: 'create' })).status === 409);

    const elsewhere = new Browser(p);
    const signOpts = (await (await elsewhere.post('/api/auth/passkey/options', { mode: 'signin' })).json()) as { challengeId: string };
    const authOpts = seen.find((s) => s.kind === 'authOptions')!.opts;
    check('passkey: sign-in asks for any discoverable passkey of this host', authOpts.rpID === 'librecorsa.org' && authOpts.allowCredentials.length === 0 && authOpts.userVerification === 'preferred');
    const signedIn = (await (await elsewhere.post('/api/auth/passkey/verify', { challengeId: signOpts.challengeId, response: { id: 'cred-one', response: {} } })).json()) as { result: string };
    check('passkey: sign-in with it reaches the same account', signedIn.result === 'signed-in' && (await elsewhere.account()).body.account.id === (await maker.account()).body.account.id);
    check('passkey: its counter and last use are written', (await one<{ counter: number; last_used_at: number }>(p.accounts, "SELECT counter, last_used_at FROM passkeys WHERE id = 'cred-one'"))?.counter === 1);
    const unknownOpts = (await (await new Browser(p).post('/api/auth/passkey/options', { mode: 'signin' })).json()) as { challengeId: string };
    check('passkey: one no account has is a 404', (await new Browser(p).post('/api/auth/passkey/verify', { challengeId: unknownOpts.challengeId, response: { id: 'cred-nobody', response: {} } })).status === 404);
    const badOpts = (await (await new Browser(p).post('/api/auth/passkey/options', { mode: 'signin' })).json()) as { challengeId: string };
    check('passkey: a signature that doesn\'t check out is a 400', (await new Browser(p).post('/api/auth/passkey/verify', { challengeId: badOpts.challengeId, response: { id: 'cred-one', bad: true, response: {} } })).status === 400);
    const lateOpts = (await (await new Browser(p).post('/api/auth/passkey/options', { mode: 'signin' })).json()) as { challengeId: string };
    clock += 11 * MIN;
    check('passkey: a challenge older than 10 minutes is refused', (await new Browser(p).post('/api/auth/passkey/verify', { challengeId: lateOpts.challengeId, response: { id: 'cred-one', response: {} } })).status === 410);
    check('passkey: an unknown mode is a 400', (await new Browser(p).post('/api/auth/passkey/options', { mode: 'steal' })).status === 400);
    check('passkey: add needs a session', (await new Browser(p).post('/api/auth/passkey/options', { mode: 'add' })).status === 401);

    // add, then link (fold)
    const disc = new Browser(p);
    await viaDiscord(p, disc, '950000000000000001');
    const addOpts = (await (await disc.post('/api/auth/passkey/options', { mode: 'add' })).json()) as { challengeId: string };
    const addReg = seen.filter((s) => s.kind === 'regOptions').at(-1)!.opts;
    const discHandle = (await one<{ webauthn_user_id: string }>(p.accounts, 'SELECT a.webauthn_user_id FROM accounts a JOIN identities i ON i.account_id = a.id WHERE i.subject = ?', '950000000000000001'))!.webauthn_user_id;
    check('passkey: add uses the account\'s user handle', b64url(addReg.userID as Uint8Array) === discHandle);
    const added = (await (await disc.post('/api/auth/passkey/verify', { challengeId: addOpts.challengeId, response: { id: 'cred-two', response: {} } })).json()) as { result: string };
    check('passkey: add is "linked"', added.result === 'linked' && (await disc.account()).body.account.passkeys.length === 1);
    const again = (await (await disc.post('/api/auth/passkey/options', { mode: 'add' })).json()) as { challengeId: string };
    check('passkey: add leaves out the account\'s passkeys', (seen.filter((s) => s.kind === 'regOptions').at(-1)!.opts.excludeCredentials as { id: string }[]).map((c) => c.id).join() === 'cred-two');
    check('passkey: the same credential again is refused', (await disc.post('/api/auth/passkey/verify', { challengeId: again.challengeId, response: { id: 'cred-two', response: {} } })).status === 409);
    const linkOpts = (await (await disc.post('/api/auth/passkey/options', { mode: 'link' })).json()) as { challengeId: string };
    const folded = (await (await disc.post('/api/auth/passkey/verify', { challengeId: linkOpts.challengeId, response: { id: 'cred-one', response: {} } })).json()) as { result: string };
    const discId = (await disc.account()).body.account.id;
    check('passkey: link with another account\'s passkey folds it in ("merged")', folded.result === 'merged' && (await one<{ account_id: string }>(p.accounts, "SELECT account_id FROM passkeys WHERE id = 'cred-one'"))?.account_id === discId);
    check('passkey: the folded account\'s other device is now on this one', (await maker.account()).body.account.id === discId);
    const linkAgain = (await (await disc.post('/api/auth/passkey/options', { mode: 'link' })).json()) as { challengeId: string };
    check('passkey: link with one of this account is "already-linked"', ((await (await disc.post('/api/auth/passkey/verify', { challengeId: linkAgain.challengeId, response: { id: 'cred-one', response: {} } })).json()) as { result: string }).result === 'already-linked');
    const limited = makeWorld({ webauthn: fake, authMax: 1 });
    const lb = new Browser(limited);
    const st = [(await lb.post('/api/auth/passkey/options', { mode: 'signin' })).status, (await lb.post('/api/auth/passkey/options', { mode: 'signin' })).status];
    check('passkey: options count against AUTH_LIMIT', st.join() === '200,429');
  }

  // 14. Passkeys for real: a software authenticator (ES256) through @simplewebauthn/server -------------------------------
  {
    const real = makeWorld();
    const device = await softAuthenticator();
    const browser = new Browser(real);
    const opts = (await (await browser.post('/api/auth/passkey/options', { mode: 'create', displayName: 'Laptop' })).json()) as { challengeId: string; options: RegOptions };
    const attestation = await device.register(opts.options, SITE);
    const made = await browser.post('/api/auth/passkey/verify', { challengeId: opts.challengeId, response: attestation });
    const madeBody = (await made.json()) as { ok: boolean; result: string; error?: string };
    check('real passkey: a new ES256 credential makes an account', made.status === 200 && madeBody.result === 'created', JSON.stringify(madeBody));
    const stored = await one<{ id: string; public_key: string; counter: number }>(real.accounts, 'SELECT id, public_key, counter FROM passkeys');
    check('real passkey: its credential id and COSE public key are stored', stored?.id === device.id && (stored?.public_key.length ?? 0) > 40);
    const other = new Browser(real);
    const signOpts = (await (await other.post('/api/auth/passkey/options', { mode: 'signin' })).json()) as { challengeId: string; options: AuthOptions };
    const handle = (await one<{ webauthn_user_id: string }>(real.accounts, 'SELECT webauthn_user_id FROM accounts'))!.webauthn_user_id;
    const assertion = await device.authenticate(signOpts.options, SITE, handle);
    const signed = await other.post('/api/auth/passkey/verify', { challengeId: signOpts.challengeId, response: assertion });
    const signedBody = (await signed.json()) as { result: string; error?: string };
    check('real passkey: its signature signs another browser in', signed.status === 200 && signedBody.result === 'signed-in', JSON.stringify(signedBody));
    check('real passkey: the signature counter is kept', (await one<{ counter: number }>(real.accounts, 'SELECT counter FROM passkeys'))?.counter === 1);
    const replayOpts = (await (await new Browser(real).post('/api/auth/passkey/options', { mode: 'signin' })).json()) as { challengeId: string };
    const replay = await new Browser(real).post('/api/auth/passkey/verify', { challengeId: replayOpts.challengeId, response: assertion });
    check('real passkey: an old assertion on a new challenge is refused', replay.status === 400);
    const wrongOrigin = (await (await new Browser(real).post('/api/auth/passkey/options', { mode: 'signin' })).json()) as { challengeId: string; options: AuthOptions };
    const phished = await device.authenticate(wrongOrigin.options, 'https://librecorsa.org.evil.example', handle);
    check('real passkey: an assertion made for another origin is refused', (await new Browser(real).post('/api/auth/passkey/verify', { challengeId: wrongOrigin.challengeId, response: phished })).status === 400);
  }

  // 15. Admin counts ------------------------------------------------------------------------------------------------------
  {
    const answer = await adminStats({ db: w.board, accountsDb: w.accounts, now: () => clock }, new URL(`${SITE}/api/admin/stats`));
    const stats = answer.body as AdminStats;
    const total = (await rows(w.accounts, 'SELECT * FROM accounts')).length;
    check('admin: account counts', stats.accounts !== null && stats.accounts.total === total && stats.accounts.byProvider.google >= 1 && stats.accounts.byProvider.steam >= 1, JSON.stringify(stats.accounts));
    check('admin: accounts with a save, and made in the last 7 days', stats.accounts !== null && stats.accounts.withSave >= 1 && stats.accounts.last7d <= total);
    const without = (await adminStats({ db: w.board, now: () => clock }, new URL(`${SITE}/api/admin/stats`))).body as AdminStats;
    check('admin: without the accounts database, null', without.accounts === null);
  }

  console.log(failures.length === 0 ? '\nAll account checks passed.' : `\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  if (failures.length > 0) process.exit(1);
}

// A software authenticator: an ES256 key pair, its credential, and the CBOR and signatures a browser would pass on ------
interface RegOptions {
  challenge: string;
  rp: { id: string };
}
interface AuthOptions {
  challenge: string;
  rpId: string;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const sha = async (data: Uint8Array | string) => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : (data as Uint8Array<ArrayBuffer>)));
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

/** WebCrypto signs ECDSA as r|s; WebAuthn wants it DER-encoded */
function derOf(raw: Uint8Array): Uint8Array {
  const int = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    const v = x.slice(i);
    return v[0] & 0x80 ? concat(new Uint8Array([0]), v) : v;
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return concat(new Uint8Array([0x30, r.length + s.length + 4, 0x02, r.length]), r, new Uint8Array([0x02, s.length]), s);
}

async function softAuthenticator() {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const id = b64url(credId);
  let signCount = 0;
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, raw.slice(1, 33)],
      [-3, raw.slice(33)],
    ]),
  );
  return {
    id,
    async register(options: RegOptions, origin: string) {
      const clientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
      // User present, user verified, attested credential data
      const authData = concat(await sha(options.rp.id), new Uint8Array([0x45]), u32(signCount), new Uint8Array(16), new Uint8Array([0, credId.length]), credId, cose);
      const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]) as never);
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: { clientDataJSON: b64url(clientData), attestationObject: b64url(attestationObject), transports: ['internal'] },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
    async authenticate(options: AuthOptions, origin: string, userHandle: string) {
      signCount++;
      const clientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
      const authData = concat(await sha(options.rpId), new Uint8Array([0x05]), u32(signCount));
      const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, concat(authData, await sha(clientData))));
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(derOf(signature)), userHandle },
        clientExtensionResults: {},
      };
    },
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
