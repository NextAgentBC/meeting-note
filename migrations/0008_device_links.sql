-- Adding a phone or computer. A signed-in device makes a one-time link, shown as a QR code; the new
-- device opens it and creates its own passkey, and every other device keeps working. Only the SHA-256
-- of the link's token is stored, and a link works once, for ten minutes.
--
-- (Numbered 0008 so it sorts after migrations being developed elsewhere; wrangler applies any
-- migration it hasn't seen, whatever its number.)

CREATE TABLE IF NOT EXISTS device_links (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
