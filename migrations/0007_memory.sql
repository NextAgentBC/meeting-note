-- Memory: everything the owner may want to find again, as short passages. Transcript pieces,
-- section notes, final notes, plans and dictations are copied in as they're written, and a
-- full-text index keeps them searchable by any word, in English or Chinese.
--
-- The trigram tokenizer matches any run of three or more characters, which works for Chinese
-- without a word segmenter; shorter Chinese words fall back to LIKE. Keep writes to
-- memory_items as INSERT … ON CONFLICT DO UPDATE: INSERT OR REPLACE deletes rows without
-- firing the delete trigger, which would leave the index out of step.

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,                -- transcript:<chunk>:<n> | section:<segment> | summary:<meeting> | plan:<task> | dictation:<id>
  kind TEXT NOT NULL,                 -- transcript | section | summary | plan | dictation | fact
  source_id TEXT NOT NULL,
  meeting_id TEXT,
  chunk_sequence INTEGER,             -- where to open the meeting's transcript
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  occurred_at TEXT NOT NULL,          -- when it was said, or for a plan, when it happens (UTC ISO)
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_meeting ON memory_items(meeting_id);
CREATE INDEX IF NOT EXISTS idx_memory_occurred ON memory_items(occurred_at);
CREATE INDEX IF NOT EXISTS idx_memory_source ON memory_items(source_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title,
  text,
  content = 'memory_items',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
  INSERT INTO memory_fts (rowid, title, text) VALUES (new.rowid, new.title, new.text);
END;

CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
  INSERT INTO memory_fts (memory_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
END;

CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE OF title, text ON memory_items BEGIN
  INSERT INTO memory_fts (memory_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
  INSERT INTO memory_fts (rowid, title, text) VALUES (new.rowid, new.title, new.text);
END;
