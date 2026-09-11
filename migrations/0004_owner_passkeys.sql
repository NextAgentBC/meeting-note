-- Meeting Note has one user: whoever deployed it. They sign in with a passkey.
-- Times here are epoch milliseconds.

CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- The random handle this owner is known by inside each passkey.
  webauthn_user_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  -- At most one owner, enforced by the database: two people racing to claim a fresh
  -- deployment cannot both win.
  singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1)
);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,                -- base64url credential id, as the browser reports it
  owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,           -- base64url COSE public key
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- Only the SHA-256 of a session token is stored; the token itself lives in the owner's cookie.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- One-time WebAuthn challenges, kept for five minutes.
CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  challenge TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  expires_at INTEGER NOT NULL
);
