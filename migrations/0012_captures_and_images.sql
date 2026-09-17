-- Quick notes: text and phone-compressed WebP images. The original camera file never reaches
-- the Worker. D1 keeps searchable metadata; the private image bytes live in the existing AUDIO
-- KV namespace under images/ (without the seven-day audio expiry).

CREATE TABLE captures (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'inbox',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX captures_occurred_idx ON captures(occurred_at DESC, id DESC);
CREATE INDEX captures_category_idx ON captures(category, occurred_at DESC);

CREATE TABLE capture_attachments (
  id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL,
  image_key TEXT NOT NULL UNIQUE,
  thumbnail_key TEXT NOT NULL UNIQUE,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  thumbnail_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | ready | failed
  caption TEXT NOT NULL DEFAULT '',
  ocr_text TEXT NOT NULL DEFAULT '',
  ai_status TEXT NOT NULL DEFAULT 'off',        -- off | queued | processing | done | failed
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE
);

CREATE INDEX capture_attachments_capture_idx ON capture_attachments(capture_id, created_at);
CREATE INDEX capture_attachments_ai_idx ON capture_attachments(ai_status, created_at);
