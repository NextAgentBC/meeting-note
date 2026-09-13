import { localDateTimeToUtc } from "./calendar";
import { deleteVectors, queryVectors, queueEmbed } from "./embed";
import { buildFtsQuery, isJunk, mergeHits, splitForIndex, type MergedHit, type RouteResult, type TimeRange } from "./recall";
import { parseSegmentNote, type SegmentNote } from "./segment";
import { SummarySchema, type MeetingSummary } from "./summary";
import type { TaskRow } from "./tasks";
import type { Env } from "./types";

// Memory: short passages copied from everything the owner records or plans, so a question
// like "what did we decide about the venue?" can find them again. See migrations/0007_memory.sql.

export type MemoryKind = "transcript" | "section" | "summary" | "plan" | "dictation" | "fact";

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  sourceId: string;
  meetingId: string | null;
  chunkSequence: number | null;
  title: string;
  text: string;
  occurredAt: string;
}

export interface MemoryRow {
  id: string;
  kind: MemoryKind;
  source_id: string;
  meeting_id: string | null;
  chunk_sequence: number | null;
  title: string;
  text: string;
  occurred_at: string;
  superseded_by: string | null;
}

const PASSAGE_CHARS = 800;

// ── What goes in ────────────────────────────────────────────────────────────

export function transcriptItems(meeting: { id: string; title: string }, chunk: { id: string; sequence: number; created_at: string }, transcript: string): MemoryItem[] {
  return splitForIndex(transcript, PASSAGE_CHARS)
    .filter((piece) => !isJunk(piece))
    .map((piece, index) => ({
      id: `transcript:${chunk.id}:${index}`,
      kind: "transcript",
      sourceId: chunk.id,
      meetingId: meeting.id,
      chunkSequence: chunk.sequence,
      title: meeting.title,
      text: piece,
      occurredAt: chunk.created_at
    }));
}

/** Dated when the section was recorded (its row is created then), not when a retry finally wrote it. */
export function sectionItem(meeting: { id: string; title: string }, segment: { id: string; start_chunk: number; created_at: string }, note: SegmentNote): MemoryItem | null {
  const lines = [
    note.headline,
    ...note.bullets,
    ...note.decisions.map((decision) => `Decision: ${decision}`),
    ...note.questions.map((item) => `Q: ${item.question}${item.answer ? ` A: ${item.answer}` : ""}`),
    ...note.action_items.map((item) => `To do: ${item.task}${item.owner && item.owner !== "Unassigned" ? ` (${item.owner})` : ""}${item.due ? `, due ${item.due}` : ""}`)
  ].filter((line) => line.trim());
  if (lines.length <= 1 && !note.bullets.length) return null;
  return {
    id: `section:${segment.id}`,
    kind: "section",
    sourceId: segment.id,
    meetingId: meeting.id,
    chunkSequence: segment.start_chunk,
    title: meeting.title,
    text: lines.join("\n").slice(0, 4000),
    occurredAt: segment.created_at
  };
}

export function summaryItem(meeting: { id: string; title: string; started_at: string }, summary: MeetingSummary): MemoryItem | null {
  const lines = [
    summary.overview,
    ...summary.key_points,
    ...summary.decisions.map((decision) => `Decision: ${decision}`),
    ...summary.action_items.map((item) => `To do: ${item.task}${item.owner && item.owner !== "Unassigned" ? ` (${item.owner})` : ""}${item.due ? `, due ${item.due}` : ""}`),
    ...summary.resources_promised.map((item) => `Promised: ${item}`)
  ].filter((line) => line.trim());
  if (!lines.length) return null;
  return {
    id: `summary:${meeting.id}`,
    kind: "summary",
    sourceId: meeting.id,
    meetingId: meeting.id,
    chunkSequence: null,
    title: meeting.title,
    text: lines.join("\n").slice(0, 6000),
    occurredAt: meeting.started_at
  };
}

/** A plan is remembered for when it happens, so "what's on next week" finds it. */
export function planItem(task: TaskRow): MemoryItem {
  // An all-day plan sits at noon in its own time zone, so it stays on its day wherever that is.
  const when = task.starts_at ?? (task.due_date ? new Date(localDateTimeToUtc(task.timezone, task.due_date, "12:00")).toISOString() : task.created_at);
  const text = [task.title, task.notes, task.repeat_hint ? `Repeats ${task.repeat_hint}` : ""].filter(Boolean).join("\n");
  return {
    id: `plan:${task.id}`,
    kind: "plan",
    sourceId: task.id,
    meetingId: task.meeting_id,
    chunkSequence: null,
    title: task.title,
    text,
    occurredAt: when
  };
}

export function dictationItem(dictation: { id: string; transcript: string; created_at: string }): MemoryItem {
  return {
    id: `dictation:${dictation.id}`,
    kind: "dictation",
    sourceId: dictation.id,
    meetingId: null,
    chunkSequence: null,
    title: "Said aloud",
    text: dictation.transcript.slice(0, 4000),
    occurredAt: dictation.created_at
  };
}

export function upsertMemory(db: D1Database, item: MemoryItem): D1PreparedStatement {
  const now = new Date().toISOString();
  return db.prepare(
    `INSERT INTO memory_items (id, kind, source_id, meeting_id, chunk_sequence, title, text, occurred_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind, source_id = excluded.source_id, meeting_id = excluded.meeting_id,
       chunk_sequence = excluded.chunk_sequence, title = excluded.title, text = excluded.text,
       occurred_at = excluded.occurred_at, updated_at = excluded.updated_at
     WHERE memory_items.text IS NOT excluded.text OR memory_items.title IS NOT excluded.title
        OR memory_items.occurred_at IS NOT excluded.occurred_at`
  ).bind(item.id, item.kind, item.sourceId, item.meetingId, item.chunkSequence, item.title, item.text, item.occurredAt, now, now);
}

export function forgetSource(db: D1Database, sourceId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM memory_items WHERE source_id = ?").bind(sourceId);
}

/**
 * Replaces everything remembered from one source, e.g. a chunk transcribed again. Embedding for
 * whatever is kept is queued in the background (a no-op without MEMORY_VECTORS); whatever is
 * dropped has its vector deleted too, alongside the row.
 */
export async function rememberSource(env: Env, sourceId: string, items: MemoryItem[]): Promise<void> {
  const db = env.DB;
  const keep = new Set(items.map((item) => item.id));
  const { results } = await db.prepare("SELECT id FROM memory_items WHERE source_id = ?").bind(sourceId).all<{ id: string }>();
  const stale = results.filter((row) => !keep.has(row.id));
  const statements = [
    ...stale.map((row) => db.prepare("DELETE FROM memory_items WHERE id = ?").bind(row.id)),
    ...items.map((item) => upsertMemory(db, item))
  ];
  if (statements.length) await db.batch(statements);
  if (stale.length) await deleteVectors(env, stale.map((row) => row.id));
  if (items.length) await queueEmbed(env, items.map((item) => item.id));
}

/** Memory is a convenience: a failure to remember must never fail the recording or the plan. */
export async function safely(label: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(`Memory: could not ${label}`, error);
  }
}

// ── What comes out ──────────────────────────────────────────────────────────

// Only the start of each passage comes back: the answer uses 900 characters, and parsing and comparing
// whole meeting notes would eat into the free plan's 10 ms of CPU.
const COLUMNS = "m.id, m.kind, m.source_id, m.meeting_id, m.chunk_sequence, m.title, substr(m.text, 1, 1000) AS text, m.occurred_at, m.superseded_by";

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * "海报设计" won't match a transcript that says "海报下周二要发出去", and the trigram index can't
 * look for anything shorter than three characters, so longer Chinese words are also searched for
 * by their two-character pieces.
 */
export function chineseBigrams(term: string): string[] {
  const runs = term.match(/[\u3400-\u9fff]{3,}/g) ?? [];
  return runs.flatMap((run) => Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2)));
}

export interface SearchResult extends MergedHit {
  row: MemoryRow;
}

/**
 * Up to four searches, merged: full-text on words of three or more characters, LIKE for shorter
 * (mostly Chinese) words, whatever falls in a time range the question mentioned, and — when
 * MEMORY_VECTORS is bound — nearest neighbours of the question's own embedding.
 */
export async function searchMemory(env: Env, query: { terms: string[]; text?: string; range?: TimeRange; limit?: number }): Promise<SearchResult[]> {
  const db = env.DB;
  const rows = new Map<string, MemoryRow>();
  const routes: RouteResult[] = [];
  const terms = [...new Set(query.terms.map((term) => term.trim()).filter(Boolean))].slice(0, 12);
  const fts = buildFtsQuery(terms.join(" "));

  if (fts.match) {
    const { results } = await db.prepare(
      // Titles count for a tenth: every passage of a meeting carries its title, and a meeting called
      // "Poster review" shouldn't outrank the one passage elsewhere that says who makes the poster.
      `SELECT ${COLUMNS}, bm25(memory_fts, 0.1, 1.0) AS rank
         FROM memory_fts JOIN memory_items m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ?
        ORDER BY rank LIMIT 40`
    ).bind(fts.match).all<MemoryRow & { rank: number }>();
    // By position: bm25 values shrink towards zero when a word is in most passages, as in a small archive.
    routes.push({ route: "fulltext", hits: results.map((row, index) => ({ id: row.id, score: results.length - index, text: row.text, supersededBy: row.superseded_by })) });
    for (const row of results) rows.set(row.id, row);
  }

  const likeTerms = [...new Set([...fts.likeTerms, ...terms.flatMap(chineseBigrams)])].slice(0, 16);
  if (likeTerms.length) {
    const clauses = likeTerms.map(() => "(m.text LIKE ? ESCAPE '\\' OR m.title LIKE ? ESCAPE '\\')").join(" OR ");
    const bindings = likeTerms.flatMap((term) => [`%${escapeLike(term)}%`, `%${escapeLike(term)}%`]);
    const { results } = await db.prepare(
      `SELECT ${COLUMNS} FROM memory_items m WHERE ${clauses} ORDER BY m.occurred_at DESC LIMIT 60`
    ).bind(...bindings).all<MemoryRow>();
    routes.push({
      route: "tag",
      hits: results.map((row) => ({
        id: row.id,
        score: likeTerms.filter((term) => row.text.includes(term) || row.title.includes(term)).length,
        text: row.text,
        supersededBy: row.superseded_by
      }))
    });
    for (const row of results) rows.set(row.id, row);
  }

  if (query.range) {
    const { results } = await db.prepare(
      `SELECT ${COLUMNS} FROM memory_items m
        WHERE m.occurred_at >= ? AND m.occurred_at < ? AND m.kind != 'transcript'
        ORDER BY m.occurred_at DESC LIMIT 30`
    ).bind(new Date(query.range.from).toISOString(), new Date(query.range.to).toISOString()).all<MemoryRow>();
    routes.push({ route: "time", hits: results.map((row, index) => ({ id: row.id, score: results.length - index, text: row.text, supersededBy: row.superseded_by })) });
    for (const row of results) rows.set(row.id, row);
  }

  const embedText = (query.text ?? terms.join(" ")).trim();
  if (env.MEMORY_VECTORS && embedText) {
    try {
      const candidates = await queryVectors(env, embedText);
      if (candidates.length) {
        const placeholders = candidates.map(() => "?").join(",");
        const { results } = await db.prepare(`SELECT ${COLUMNS} FROM memory_items m WHERE m.id IN (${placeholders})`)
          .bind(...candidates.map((candidate) => candidate.id)).all<MemoryRow>();
        const byId = new Map(results.map((row) => [row.id, row]));
        const hits = candidates.filter((candidate) => byId.has(candidate.id));
        routes.push({
          route: "vector",
          hits: hits.map((candidate) => ({ id: candidate.id, score: candidate.score, text: byId.get(candidate.id)!.text, supersededBy: byId.get(candidate.id)!.superseded_by }))
        });
        for (const row of results) rows.set(row.id, row);
      }
    } catch (error) {
      console.error("Memory: vector search failed; continuing with full-text only", error);
    }
  }

  return mergeHits(routes, { limit: query.limit ?? 12 })
    .map((hit) => ({ ...hit, row: rows.get(hit.id)! }))
    .filter((hit) => hit.row);
}

// ── Catching up ─────────────────────────────────────────────────────────────

/** Remembers a whole meeting again: for copies that recorded meetings before memory existed. */
export async function rememberMeeting(env: Env, meetingId: string): Promise<void> {
  const db = env.DB;
  const meeting = await db.prepare("SELECT id, title, started_at, summary_json FROM meetings WHERE id = ?")
    .bind(meetingId).first<{ id: string; title: string; started_at: string; summary_json: string | null }>();
  if (!meeting) return;

  const chunks = await db.prepare(
    "SELECT id, sequence, created_at, transcript_text FROM audio_chunks WHERE meeting_id = ? AND status = 'done' ORDER BY sequence"
  ).bind(meetingId).all<{ id: string; sequence: number; created_at: string; transcript_text: string | null }>();
  for (const chunk of chunks.results) {
    await rememberSource(env, chunk.id, transcriptItems(meeting, chunk, chunk.transcript_text ?? ""));
  }

  const segments = await db.prepare(
    "SELECT id, start_chunk, created_at, notes_json FROM meeting_segments WHERE meeting_id = ? AND status = 'done' ORDER BY seq"
  ).bind(meetingId).all<{ id: string; start_chunk: number; created_at: string; notes_json: string | null }>();
  for (const segment of segments.results) {
    const note = parseSegmentNote(segment.notes_json);
    const item = note ? sectionItem(meeting, segment, note) : null;
    await rememberSource(env, segment.id, item ? [item] : []);
  }

  const summary = meeting.summary_json ? SummarySchema.safeParse(JSON.parse(meeting.summary_json)) : null;
  const item = summary?.success ? summaryItem(meeting, summary.data) : null;
  await rememberSource(env, meeting.id, item ? [item] : []);
}
