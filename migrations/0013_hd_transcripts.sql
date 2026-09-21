-- High-definition re-transcription: one Deepgram pass per chunk, with speaker numbers, plus the
-- meeting-wide speaker list the owner can name. The ordinary Whisper transcript is left untouched;
-- this sits beside it, and only exists for meetings whose owner asked for it and paid for it.
CREATE TABLE hd_runs (
  meeting_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  model TEXT NOT NULL,
  chunks_total INTEGER NOT NULL DEFAULT 0,
  chunks_done INTEGER NOT NULL DEFAULT 0,
  -- [{ id, label, name, seconds }] once the run has reconciled its per-chunk speaker numbers.
  speakers_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

-- Each chunk's diarized utterances: [{ speaker, start, end, text }], speaker numbered per chunk.
ALTER TABLE audio_chunks ADD COLUMN hd_json TEXT;
