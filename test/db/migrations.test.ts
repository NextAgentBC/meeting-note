/**
 * The migrations themselves, run for real against node:sqlite (DatabaseSync, Node >= 22.5) rather
 * than mocked: no D1 in a vitest run, but SQLite is SQLite, and this catches anything a mock
 * wouldn't — the FTS5 trigram triggers from 0007, and the supersede/forget patterns memory.ts,
 * facts.ts and memory-routes.ts run against real D1.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) db.exec(readFileSync(`${migrationsDir}/${file}`, "utf8"));
  return db;
}

function insertMeeting(db: DatabaseSync, id: string, title = "Weekly planning"): void {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO meetings (id, title, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, title, now, now, now);
}

function insertMemory(db: DatabaseSync, row: { id: string; kind?: string; title?: string; text?: string; meetingId?: string | null; occurredAt?: string }): void {
  const now = row.occurredAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_items (id, kind, source_id, meeting_id, chunk_sequence, title, text, occurred_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
  ).run(row.id, row.kind ?? "fact", row.id, row.meetingId ?? null, row.title ?? "topic", row.text ?? "statement", now, now, now);
}

function matches(db: DatabaseSync, term: string): unknown[] {
  return db.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?").all(term);
}

describe("migrations 0001-0009 on node:sqlite", () => {
  it("apply cleanly, in one pass, and create the tables later code depends on", () => {
    const db = freshDb();
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining(["meetings", "memory_items", "memory_fts", "device_links", "settings"]));
  });

  it("0009 adds embedded_at / embedded_hash, both starting NULL", () => {
    const db = freshDb();
    insertMeeting(db, "m1");
    insertMemory(db, { id: "fact:m1:0" });
    const row = db.prepare("SELECT embedded_at, embedded_hash FROM memory_items WHERE id = ?").get("fact:m1:0") as { embedded_at: unknown; embedded_hash: unknown };
    expect(row.embedded_at).toBeNull();
    expect(row.embedded_hash).toBeNull();
  });

  it("0011 keeps audio by default, with archived_at / audio_deleted_at starting NULL", () => {
    const db = freshDb();
    insertMeeting(db, "m1");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO audio_chunks (id, meeting_id, sequence, r2_key, mime_type, duration_ms, size_bytes, status, created_at, updated_at)
       VALUES ('m1-0000', 'm1', 0, 'meetings/m1/chunks/0000.webm', 'audio/webm', 1000, 10, 'uploaded', ?, ?)`
    ).run(now, now);
    const meeting = db.prepare("SELECT keep_audio FROM meetings WHERE id = 'm1'").get() as { keep_audio: number };
    const chunk = db.prepare("SELECT archived_at, audio_deleted_at FROM audio_chunks WHERE id = 'm1-0000'").get() as { archived_at: unknown; audio_deleted_at: unknown };
    expect(meeting.keep_audio).toBe(1);
    expect(chunk.archived_at).toBeNull();
    expect(chunk.audio_deleted_at).toBeNull();
  });

  it("an insert is mirrored into memory_fts, and deleting the row removes it there too", () => {
    const db = freshDb();
    insertMeeting(db, "m1");
    insertMemory(db, { id: "section:s1", kind: "section", title: "Standup", text: "we discussed the product roadmap" });
    expect(matches(db, "roadmap")).toHaveLength(1);

    db.prepare("DELETE FROM memory_items WHERE id = ?").run("section:s1");
    expect(matches(db, "roadmap")).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_items").get()).toEqual({ n: 0 });
  });

  it("INSERT ... ON CONFLICT DO UPDATE (the upsertMemory pattern) replaces the FTS row instead of duplicating it", () => {
    const db = freshDb();
    insertMeeting(db, "m1");
    const now = new Date().toISOString();
    const upsert = (text: string) => db.prepare(
      `INSERT INTO memory_items (id, kind, source_id, meeting_id, chunk_sequence, title, text, occurred_at, created_at, updated_at)
       VALUES ('section:s1', 'section', 's1', 'm1', NULL, 'Standup', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
       WHERE memory_items.text IS NOT excluded.text`
    ).run(text, now, now, now);

    upsert("first draft of the note");
    upsert("second draft of the note");

    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_items").get()).toEqual({ n: 1 });
    expect(matches(db, "first")).toHaveLength(0);
    expect(matches(db, "second")).toHaveLength(1);
  });

  it("superseding a fact keeps both rows: the old one points at the new one, only the new one is current", () => {
    const db = freshDb();
    insertMeeting(db, "m1");
    insertMeeting(db, "m2");
    insertMemory(db, { id: "fact:m1:0", title: "clinic hours", text: "Open 9-5 weekdays.", meetingId: "m1", occurredAt: "2026-01-01T00:00:00.000Z" });
    insertMemory(db, { id: "fact:m2:0", title: "clinic hours", text: "Open 9-5 weekdays, and Saturdays 10-2.", meetingId: "m2", occurredAt: "2026-02-01T00:00:00.000Z" });
    db.prepare("UPDATE memory_items SET superseded_by = ? WHERE id = ?").run("fact:m2:0", "fact:m1:0");

    const rows = db.prepare("SELECT id, superseded_by FROM memory_items WHERE kind = 'fact' ORDER BY id").all();
    expect(rows).toEqual([
      { id: "fact:m1:0", superseded_by: "fact:m2:0" },
      { id: "fact:m2:0", superseded_by: null }
    ]);
    const current = db.prepare("SELECT id FROM memory_items WHERE kind = 'fact' AND superseded_by IS NULL").all();
    expect(current).toEqual([{ id: "fact:m2:0" }]);
  });

  it("forgetting a fact's whole history removes every version, from D1 and from the FTS index", () => {
    const db = freshDb();
    insertMeeting(db, "m1");
    insertMeeting(db, "m2");
    insertMemory(db, { id: "fact:m1:0", title: "clinic hours", text: "Open 9-5 weekdays in sunnydale.", meetingId: "m1" });
    insertMemory(db, { id: "fact:m2:0", title: "clinic hours", text: "Open 9-5 weekdays and Saturdays in sunnydale.", meetingId: "m2" });
    db.prepare("UPDATE memory_items SET superseded_by = ? WHERE id = ?").run("fact:m2:0", "fact:m1:0");

    for (const id of ["fact:m1:0", "fact:m2:0"]) db.prepare("DELETE FROM memory_items WHERE id = ?").run(id);

    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE kind = 'fact'").get()).toEqual({ n: 0 });
    expect(matches(db, "sunnydale")).toHaveLength(0);
  });

  it("a plain non-fact row is forgotten alone: it never touches other rows or their vectors", () => {
    const db = freshDb();
    insertMeeting(db, "m1");
    insertMemory(db, { id: "section:s1", kind: "section", title: "Standup", text: "alpha topic" });
    insertMemory(db, { id: "section:s2", kind: "section", title: "Standup", text: "beta topic" });

    db.prepare("DELETE FROM memory_items WHERE id = ?").run("section:s1");

    expect(db.prepare("SELECT id FROM memory_items").all()).toEqual([{ id: "section:s2" }]);
    expect(matches(db, "beta")).toHaveLength(1);
  });
});
