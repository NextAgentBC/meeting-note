-- Rolling 5-minute segment notes.
--
-- A segment is a contiguous run of transcribed chunks covering roughly five
-- minutes. Segments are summarised while the meeting is still running, so the
-- final note is a cheap merge of short segment notes instead of one giant
-- pass over a two-hour transcript.

CREATE TABLE IF NOT EXISTS meeting_segments (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  start_chunk INTEGER NOT NULL,
  end_chunk INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  notes_json TEXT,
  headline TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  UNIQUE (meeting_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_segments_meeting_seq
  ON meeting_segments(meeting_id, seq);

CREATE INDEX IF NOT EXISTS idx_segments_status
  ON meeting_segments(status);

-- Set by POST /api/meetings/:id/force-summary. Lets the final note be built
-- from whatever transcribed successfully, instead of waiting forever for a
-- chunk that will never finish.
ALTER TABLE meetings ADD COLUMN force_summary INTEGER NOT NULL DEFAULT 0;
