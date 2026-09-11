-- Workers AI consumption, measured rather than estimated.
--
-- Every Workers AI response carries usage.neurons, which is the unit Cloudflare
-- bills and rate-limits in. Recording it per call is what makes the question
-- "how much longer can I record today?" answerable, and it needs no API token
-- and no call off the account.

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT,
  kind TEXT NOT NULL,               -- asr | segment | final
  model TEXT NOT NULL,
  neurons REAL NOT NULL DEFAULT 0,
  audio_ms INTEGER NOT NULL DEFAULT 0,
  raw_usage TEXT,
  day TEXT NOT NULL,                -- UTC date; Cloudflare's free allocation resets at 00:00 UTC
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_day ON ai_usage(day);
CREATE INDEX IF NOT EXISTS idx_usage_meeting ON ai_usage(meeting_id);
