-- Player accounts on the lap boards (cloudflare/api/accounts; the accounts themselves live in librecorsa-accounts).
--
-- A name can belong to an account. Any driver key on that account (`account_keys`) proves the name, as the key that
-- claimed it does (board.ts claimName, results.ts provenNameKeys, awards.ts's Creator badge), and a name on an
-- account never lapses. When a key leaves an account, the names on the account that it held get the key hash
-- 'account:<account id>', which no key has: only the account's remaining keys post under them.
ALTER TABLE drivers ADD COLUMN account_id TEXT;
CREATE INDEX drivers_account ON drivers (account_id) WHERE account_id IS NOT NULL;
-- The names a driver key holds, read when a device joins an account
CREATE INDEX drivers_key ON drivers (key_hash);

-- The driver keys of each account (their SHA-256, as in `drivers`); one account per key
CREATE TABLE account_keys (
  key_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  -- What the device said it was when it joined ("Chrome on macOS")
  label TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL,
  -- The last upload or name change with the key (refreshed at most once an hour)
  last_used_at INTEGER
);
CREATE INDEX account_keys_account ON account_keys (account_id);
