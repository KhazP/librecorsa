-- Player accounts (cloudflare/api/accounts), in their own database `librecorsa-accounts` (binding ACCOUNTS_DB). The lap
-- boards' database only learns which account a name and a driver key belong to (cloudflare/migrations/0011_accounts.sql).
--
-- No email, user name or avatar is kept: a sign-in is the provider's account id and nothing else. Times are ms since
-- the epoch. Every id here is random.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  -- The last request a session of the account made (refreshed at most once an hour)
  last_seen_at INTEGER NOT NULL,
  -- The WebAuthn user handle its passkeys carry (random, base64url), so a passkey made later on the same device
  -- replaces the earlier one instead of sitting beside it
  webauthn_user_id TEXT UNIQUE NOT NULL
);

-- A sign-in through a provider: 'discord' (user id), 'google' (OpenID `sub`) or 'steam' (SteamID64)
CREATE TABLE identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_account ON identities (account_id);

-- A signed-in browser or app. `id` is the SHA-256 (hex) of the cookie's token, so the table alone signs nobody in;
-- `public_id` is what the account page shows and removes. `key_hash` is the SHA-256 of the driver key this device
-- registered (POST /api/account/device), NULL until it has
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  public_id TEXT UNIQUE NOT NULL,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  key_hash TEXT
);
CREATE INDEX sessions_account ON sessions (account_id);
-- For the sweep of sessions idle for a year
CREATE INDEX sessions_seen ON sessions (last_seen_at);

-- Passkeys: the credential id and its public key (both base64url), the signature counter and the transports (JSON)
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_account ON passkeys (account_id);

-- A sign-in under way, used once and good for 10 minutes. 'oauth': `id` is the SHA-256 of the `state` sent to the
-- provider (and kept in a short cookie on the browser that started it), `verifier` the PKCE verifier, `nonce` Google's
-- OpenID nonce. 'webauthn': `id` is the challenge id the browser sends back with its answer, `challenge` the challenge,
-- and for a passkey that makes a new account `nonce` holds the user handle it was given. `account_id` is the signed-in
-- account for a link or an added passkey
CREATE TABLE auth_states (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('oauth', 'webauthn')),
  provider TEXT NOT NULL DEFAULT '',
  intent TEXT NOT NULL,
  account_id TEXT,
  return_to TEXT NOT NULL DEFAULT '/play',
  verifier TEXT,
  challenge TEXT,
  nonce TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX auth_states_created ON auth_states (created_at);
CREATE INDEX auth_states_account ON auth_states (account_id) WHERE account_id IS NOT NULL;

-- Codes a signed-in device shows to sign another one in: the SHA-256 of the code, one use, 10 minutes
CREATE TABLE link_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX link_codes_account ON link_codes (account_id);
CREATE INDEX link_codes_expires ON link_codes (expires_at);

-- The cloud save (src/lib/account/api-types.ts SaveDoc, as JSON): `rev` counts the writes, so a device writes only
-- over the version it read
CREATE TABLE saves (
  account_id TEXT PRIMARY KEY,
  rev INTEGER NOT NULL,
  doc TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Saves of accounts folded into this one, waiting for the next device that syncs to combine them in
CREATE TABLE pending_saves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  from_account_id TEXT NOT NULL,
  doc TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX pending_saves_account ON pending_saves (account_id);

-- Recordings of an account's personal bests, by the SHA-256 of their JSON text; the text itself is in the
-- librecorsa-ghosts R2 bucket under `r2_key` (accounts/ghosts/<uuid>.json)
CREATE TABLE cloud_ghosts (
  account_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, sha256)
);

-- One row per account folded into another (ids only)
CREATE TABLE merges_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  into_account_id TEXT NOT NULL,
  from_account_id TEXT NOT NULL,
  merged_at INTEGER NOT NULL
);
