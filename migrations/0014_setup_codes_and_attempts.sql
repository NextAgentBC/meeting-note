-- A code opens this copy once.
--
-- The installer hands a new copy's SETUP_CODE out as a claim link, and people paste links into chats.
-- The code used to keep working as a recovery code for ever, so an old link could wipe the owner's
-- passkeys. Now every setup code and recovery code that opens the copy is recorded here by SHA-256,
-- in the same transaction as the claim or recovery, and a spent code is refused.
CREATE TABLE IF NOT EXISTS spent_codes (
  code_hash TEXT PRIMARY KEY,
  used_at INTEGER NOT NULL
);

-- On a copy the installer made, recovering with a setup code also needs a grant: a row the installer
-- writes into this database when the Cloudflare account owner asks it for a recovery link. A grant
-- lasts a day. A claim code never gets one.
CREATE TABLE IF NOT EXISTS setup_code_grants (
  code_hash TEXT PRIMARY KEY,
  granted_at INTEGER NOT NULL
);

-- Sign-in attempts from one address (an IPv6 address by its /64), so nobody can spend the free
-- plan's database writes on passkey challenges or keep guessing codes. Rows older than an hour are
-- pruned as new ones arrive, through the index on `at`.
CREATE TABLE IF NOT EXISTS auth_attempts (
  ip_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('challenge', 'code')),
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_attempts_by_ip ON auth_attempts (ip_hash, kind, at);
CREATE INDEX IF NOT EXISTS auth_attempts_by_time ON auth_attempts (at);
