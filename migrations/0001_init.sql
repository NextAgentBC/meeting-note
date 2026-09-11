PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  template TEXT NOT NULL DEFAULT 'workshop',
  language TEXT NOT NULL DEFAULT 'auto',
  status TEXT NOT NULL DEFAULT 'recording',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  expected_chunks INTEGER,
  processed_chunks INTEGER NOT NULL DEFAULT 0,
  summary_status TEXT NOT NULL DEFAULT 'waiting',
  summary_json TEXT,
  summary_markdown TEXT,
  summary_enqueued_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audio_chunks (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploaded',
  transcript_text TEXT,
  transcript_json TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  UNIQUE (meeting_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_chunks_meeting_sequence
  ON audio_chunks(meeting_id, sequence);

CREATE INDEX IF NOT EXISTS idx_chunks_status
  ON audio_chunks(status);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL,
  chunk_id TEXT,
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

