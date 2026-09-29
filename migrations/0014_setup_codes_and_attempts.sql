-- A setup code opens this copy once.
--
-- The installer hands a new copy's SETUP_CODE out as a claim link, and people paste links into chats.
-- The code used to keep working as a recovery code for ever, so an old link could wipe the owner's
-- passkeys. Now every use is recorded here by SHA-256 and a used code is refused. On a copy the
-- installer made, recovering with a setup code also needs a grant: a row the installer writes into
-- this database when the Cloudflare account owner asks it for a one-time recovery code. A claim code
-- never gets a grant.

CREATE TABLE IF NOT EXISTS setup_code_uses (
  code_hash TEXT PRIMARY KEY,
  used_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS setup_code_grants (
  code_hash TEXT PRIMARY KEY,
  granted_at INTEGER NOT NULL
);

-- Sign-in attempts from one address, so nobody can spend the free plan's database writes on
-- passkey challenges or keep guessing codes. Rows older than an hour are pruned as new ones arrive.
CREATE TABLE IF NOT EXISTS auth_attempts (
  ip_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('challenge', 'code')),
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_attempts_by_ip ON auth_attempts (ip_hash, kind, at);
