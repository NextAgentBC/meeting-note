import { Hono } from "hono";
import { deleteVectors } from "./embed";
import { normalizeTopic, factStatement } from "./facts";
import { searchMemory, type MemoryKind, type MemoryRow } from "./memory";
import type { Env } from "./types";

// The Memory page: browsing and searching everything remembered (GET /api/memory), the current
// durable facts (GET /api/memory/facts), and forgetting one item (DELETE /api/memory/:id). Shapes
// are documented in AGENTS.md. Every route runs behind requireOwner/sameOriginWrites, mounted
// alongside the other /api routers in src/index.ts.

export const memoryRoutes = new Hono<{ Bindings: Env }>();

const KINDS: readonly MemoryKind[] = ["transcript", "section", "summary", "plan", "dictation", "fact"];

function isMemoryKind(value: string | undefined): value is MemoryKind {
  return Boolean(value) && (KINDS as readonly string[]).includes(value as string);
}

interface ListRow {
  id: string;
  kind: string;
  title: string;
  snippet: string;
  meeting_id: string | null;
  chunk_sequence: number | null;
  occurred_at: string;
  superseded_by: string | null;
}

function listItemView(row: ListRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    snippet: row.snippet,
    meetingId: row.meeting_id,
    chunkSequence: row.chunk_sequence,
    occurredAt: row.occurred_at,
    superseded: Boolean(row.superseded_by)
  };
}

/** Opaque, but just base64 of "occurred_at|id" — the two columns the list orders by. */
export function encodeMemoryCursor(occurredAt: string, id: string): string {
  return btoa(`${occurredAt}|${id}`);
}

export function decodeMemoryCursor(cursor: string): { occurredAt: string; id: string } | null {
  try {
    const raw = atob(cursor);
    const sep = raw.indexOf("|");
    if (sep < 0) return null;
    const occurredAt = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    return occurredAt && id ? { occurredAt, id } : null;
  } catch {
    return null;
  }
}

const LIST_COLUMNS = "id, kind, title, substr(text, 1, 240) AS snippet, meeting_id, chunk_sequence, occurred_at, superseded_by";

/**
 * GET /api/memory?kind=&q=&cursor=&limit= — newest-first when `q` is absent (a cursor over
 * (occurred_at, id) DESC); the existing hybrid search, ranked by relevance, when it's given.
 */
memoryRoutes.get("/memory", async (c) => {
  const kindParam = c.req.query("kind");
  const kind = isMemoryKind(kindParam) ? kindParam : undefined;
  const q = c.req.query("q")?.trim();
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 30));

  if (q) {
    const hits = await searchMemory(c.env, { terms: [q], text: q, limit });
    const items = hits
      .filter((hit) => !kind || hit.row.kind === kind)
      .map((hit) => listItemView({
        id: hit.row.id,
        kind: hit.row.kind,
        title: hit.row.title,
        snippet: hit.row.text.slice(0, 240),
        meeting_id: hit.row.meeting_id,
        chunk_sequence: hit.row.chunk_sequence,
        occurred_at: hit.row.occurred_at,
        superseded_by: hit.row.superseded_by
      }));
    return c.json({ ok: true, items, nextCursor: null });
  }

  const cursorParam = c.req.query("cursor");
  const cursor = cursorParam ? decodeMemoryCursor(cursorParam) : null;
  if (cursorParam && !cursor) return c.json({ ok: false, error: "That cursor isn't valid." }, 400);

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (kind) {
    conditions.push("kind = ?");
    params.push(kind);
  }
  if (cursor) {
    conditions.push("(occurred_at < ? OR (occurred_at = ? AND id < ?))");
    params.push(cursor.occurredAt, cursor.occurredAt, cursor.id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit + 1);

  const { results } = await c.env.DB.prepare(
    `SELECT ${LIST_COLUMNS} FROM memory_items ${where} ORDER BY occurred_at DESC, id DESC LIMIT ?`
  ).bind(...params).all<ListRow>();

  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  const last = page[page.length - 1];
  return c.json({
    ok: true,
    items: page.map(listItemView),
    nextCursor: hasMore && last ? encodeMemoryCursor(last.occurred_at, last.id) : null
  });
});

/** GET /api/memory/facts — current (non-superseded) facts, with the source meeting and a count of earlier versions. */
memoryRoutes.get("/memory/facts", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, kind, source_id, meeting_id, chunk_sequence, title, text, occurred_at, superseded_by FROM memory_items WHERE kind = 'fact' ORDER BY occurred_at DESC"
  ).all<MemoryRow>();

  const priorVersions = new Map<string, number>();
  for (const row of results) {
    const key = normalizeTopic(row.title);
    priorVersions.set(key, (priorVersions.get(key) ?? 0) + 1);
  }

  const current = results.filter((row) => !row.superseded_by);
  const meetingIds = [...new Set(current.map((row) => row.meeting_id).filter((id): id is string => Boolean(id)))];
  const meetingTitles = new Map<string, string>();
  if (meetingIds.length) {
    const placeholders = meetingIds.map(() => "?").join(",");
    const { results: meetings } = await c.env.DB.prepare(`SELECT id, title FROM meetings WHERE id IN (${placeholders})`)
      .bind(...meetingIds).all<{ id: string; title: string }>();
    for (const meeting of meetings) meetingTitles.set(meeting.id, meeting.title);
  }

  return c.json({
    ok: true,
    facts: current.map((row) => ({
      id: row.id,
      topic: row.title,
      statement: factStatement(row.text),
      meetingId: row.meeting_id,
      meetingTitle: row.meeting_id ? meetingTitles.get(row.meeting_id) ?? null : null,
      occurredAt: row.occurred_at,
      priorVersions: (priorVersions.get(normalizeTopic(row.title)) ?? 1) - 1
    }))
  });
});

/**
 * DELETE /api/memory/:id — forgets one row (the FTS trigger keeps the index in step) and its
 * vector. A fact forgets its whole topic: every earlier version, not just the current one.
 */
memoryRoutes.delete("/memory/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT id, kind, title FROM memory_items WHERE id = ?")
    .bind(id).first<{ id: string; kind: string; title: string }>();
  if (!row) return c.json({ ok: true, removed: 0 });

  let ids: string[];
  if (row.kind === "fact") {
    const topic = normalizeTopic(row.title);
    const { results } = await c.env.DB.prepare("SELECT id, title FROM memory_items WHERE kind = 'fact'")
      .all<{ id: string; title: string }>();
    ids = results.filter((candidate) => normalizeTopic(candidate.title) === topic).map((candidate) => candidate.id);
  } else {
    ids = [row.id];
  }
  if (!ids.length) return c.json({ ok: true, removed: 0 });

  await c.env.DB.batch(ids.map((itemId) => c.env.DB.prepare("DELETE FROM memory_items WHERE id = ?").bind(itemId)));
  await deleteVectors(c.env, ids);
  return c.json({ ok: true, removed: ids.length });
});
