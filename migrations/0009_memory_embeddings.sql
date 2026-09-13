-- Semantic search over memory_items, on top of the full-text search from 0007. Embedding runs in
-- its own queue job (see src/embed.ts), never in the request or job that wrote the memory, so
-- these two columns say which rows still need it: embedded_at is when a row was last embedded,
-- and embedded_hash is the SHA-256 of the text as of that embedding, so a later text change (a
-- rewritten note, a superseded fact never reuses an id so this mostly covers edits-in-place) is
-- noticed and queued again instead of silently going stale.
--
-- The vector itself lives in Vectorize (MEMORY_VECTORS), an optional binding: a copy without it
-- never sets these columns and keeps searching full-text only, as it always has.

ALTER TABLE memory_items ADD COLUMN embedded_at TEXT;
ALTER TABLE memory_items ADD COLUMN embedded_hash TEXT;

-- Finds rows still owed an embedding; mostly NULL, which SQLite indexes just as well as any value.
CREATE INDEX IF NOT EXISTS idx_memory_embedded_at ON memory_items(embedded_at);

-- Speeds up GET /api/memory?kind=&cursor=, which orders by occurred_at within a kind.
CREATE INDEX IF NOT EXISTS idx_memory_kind_occurred ON memory_items(kind, occurred_at);
