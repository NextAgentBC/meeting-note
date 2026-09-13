-- Plans on their way to a calendar: what the owner says aloud ("next Tuesday at 3, call
-- Cindy"), and later the to-dos pulled out of meetings.
--
-- Everything the AI finds starts as 'suggested' and only reaches a calendar once the owner
-- confirms it. Cancelled plans are kept, so a subscribed calendar learns to remove them.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The words only. The recording itself is transcribed straight away and never stored.
CREATE TABLE IF NOT EXISTS dictations (
  id TEXT PRIMARY KEY,
  transcript TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done',        -- done | not_understood
  last_error TEXT,
  created_at TEXT NOT NULL                     -- relative dates were resolved against this
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'task',           -- task: get something done | event: happens at a time
  status TEXT NOT NULL DEFAULT 'suggested',    -- suggested | confirmed | done | cancelled
  all_day INTEGER NOT NULL DEFAULT 1,
  due_date TEXT,                               -- YYYY-MM-DD in `timezone`; NULL while it has no date
  starts_at TEXT,                              -- UTC ISO, only when all_day = 0
  ends_at TEXT,
  timezone TEXT NOT NULL,
  repeat_hint TEXT NOT NULL DEFAULT '',        -- "every Monday", as said; not expanded into dates
  assignee TEXT NOT NULL DEFAULT '',           -- who a meeting's to-do belongs to
  source TEXT NOT NULL,                        -- dictation | meeting | manual
  dictation_id TEXT,
  meeting_id TEXT,
  segment_seq INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_dictation ON tasks(dictation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_meeting ON tasks(meeting_id);
