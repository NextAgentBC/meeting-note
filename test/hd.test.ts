import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reconcileSpeakers, utterancesFrom } from "../src/hd";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

function d1(db: DatabaseSync): D1Database {
  const statement = (sql: string, values: unknown[] = []): any => ({
    bind: (...bound: unknown[]) => statement(sql, bound),
    run: async () => ({ success: true, results: db.prepare(sql).all(...(values as never[])) }),
    all: async () => ({ results: db.prepare(sql).all(...(values as never[])) }),
    first: async () => db.prepare(sql).get(...(values as never[])) ?? null,
    sql
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

function meetingWith(chunks: Array<{ sequence: number; utterances: unknown }>): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`${migrationsDir}/${file}`, "utf8"));
  }
  const now = new Date().toISOString();
  db.prepare("INSERT INTO meetings (id, title, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("m1", "Trio", now, now, now);
  db.prepare("INSERT INTO hd_runs (meeting_id, status, model, chunks_total, chunks_done, created_at, updated_at) VALUES (?, 'running', 'model', ?, 0, ?, ?)")
    .run("m1", chunks.length, now, now);
  for (const chunk of chunks) {
    db.prepare(
      `INSERT INTO audio_chunks (id, meeting_id, sequence, r2_key, mime_type, duration_ms, hd_json, created_at, updated_at)
       VALUES (?, 'm1', ?, ?, 'audio/webm', 180000, ?, ?, ?)`
    ).run(`c${chunk.sequence}`, chunk.sequence, `k${chunk.sequence}`, JSON.stringify(chunk.utterances), now, now);
  }
  return db;
}

describe("reading what the model heard", () => {
  it("prefers utterances, which already carry the speaker", () => {
    const result = {
      results: { utterances: [{ speaker: 1, start: 0, end: 4, transcript: "我们先确认场地" }, { speaker: 0, start: 4, end: 6, transcript: "好的" }] }
    };
    expect(utterancesFrom(result)).toEqual([
      { speaker: 1, start: 0, end: 4, text: "我们先确认场地" },
      { speaker: 0, start: 4, end: 6, text: "好的" }
    ]);
  });

  it("falls back to words, grouping a run of one speaker — and does not put spaces inside Chinese", () => {
    const result = {
      results: {
        channels: [{
          alternatives: [{
            transcript: "ignored",
            words: [
              { word: "场地", speaker: 0, start: 0, end: 1 },
              { word: "已经", speaker: 0, start: 1, end: 2 },
              { word: "okay", speaker: 1, start: 2, end: 3 },
              { word: "then", speaker: 1, start: 3, end: 4 }
            ]
          }]
        }]
      }
    };
    expect(utterancesFrom(result)).toEqual([
      { speaker: 0, start: 0, end: 2, text: "场地已经" },
      { speaker: 1, start: 2, end: 4, text: "okay then" }
    ]);
  });

  it("still returns the plain transcript when there is no diarization at all", () => {
    const result = { results: { channels: [{ alternatives: [{ transcript: "just words" }] }] } };
    expect(utterancesFrom(result)).toEqual([{ speaker: 0, start: 0, end: 0, text: "just words" }]);
  });
});

describe("holding the chunks together", () => {
  it("groups speaker numbers across chunks, biggest talker first, when no model is available", async () => {
    const db = meetingWith([
      { sequence: 1, utterances: [{ speaker: 0, start: 0, end: 100, text: "long one" }, { speaker: 1, start: 100, end: 110, text: "short" }] },
      { sequence: 2, utterances: [{ speaker: 0, start: 0, end: 80, text: "long again" }, { speaker: 1, start: 80, end: 90, text: "short again" }] }
    ]);
    // No SUMMARY_MODEL: the numbers themselves are the grouping, which is the documented fallback.
    const env = { DB: d1(db) } as never;

    const speakers = await reconcileSpeakers(env, "m1");

    expect(speakers.map((speaker) => ({ id: speaker.id, seconds: speaker.seconds, members: speaker.members }))).toEqual([
      { id: "S1", seconds: 180, members: ["1:0", "2:0"] },
      { id: "S2", seconds: 20, members: ["1:1", "2:1"] }
    ]);
    const stored = db.prepare("SELECT speakers_json FROM hd_runs WHERE meeting_id = 'm1'").get() as { speakers_json: string };
    expect(JSON.parse(stored.speakers_json)).toHaveLength(2);
  });
});
