-- Permanent audio, for a copy that binds the optional RECORDINGS R2 bucket (see src/audio.ts). The
-- one-click template never binds it: there, audio lives only in KV and expires after
-- AUDIO_RETENTION_DAYS, and these columns simply stay at their defaults.
--
-- keep_audio is the owner's choice per meeting: 1 keeps a permanent copy of every chunk in R2, 0 keeps
-- only the temporary KV copy (for a session where people were promised deletion after 7 days).
-- archived_at says a chunk's permanent copy exists; audio_deleted_at that the owner deleted the audio,
-- after which the transcript and notes remain but the chunk can't be played or transcribed again.

ALTER TABLE meetings ADD COLUMN keep_audio INTEGER NOT NULL DEFAULT 1;
ALTER TABLE audio_chunks ADD COLUMN archived_at TEXT;
ALTER TABLE audio_chunks ADD COLUMN audio_deleted_at TEXT;

-- Finds chunks still owed a permanent copy.
CREATE INDEX IF NOT EXISTS idx_chunks_archived_at ON audio_chunks(archived_at);
