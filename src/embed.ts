import { sha256Hex } from "./auth";
import { recordUsage, runModel } from "./ai";
import { getSetting, setSetting } from "./settings";
import type { Env } from "./types";

// Semantic search: Workers AI embeds short passages with a multilingual model, and Vectorize
// finds the nearest ones by cosine distance. Both are optional — MEMORY_VECTORS doesn't exist in
// the public one-click template, only in a hand-configured copy — so every function here checks
// for the binding first, and a copy without it keeps working on full-text and LIKE search alone.
//
// Embedding always happens in its own queue job, never inside the request or job that wrote the
// memory: transcribing, segmenting and the final merge stay fast, and a slow or rate-limited
// embedding call only ever retries itself.

const EMBED_BATCH_SIZE = 16;
const BACKLOG_LIMIT = 1000;
const BACKLOG_SETTING_KEY = "memory_embed_backfill_queued_at";

export function embedModel(env: Env): string {
  return env.EMBED_MODEL || "@cf/baai/bge-m3";
}

/**
 * Vectorize ids are capped at 64 bytes, and memory ids such as `transcript:<chunkId>:<n>` can run
 * longer, so the vector's own id is a stable prefix of the memory id's SHA-256 hex digest instead.
 * The real memory id travels in the vector's metadata, which is how a query match is matched back
 * to its row in D1 (see queryVectors).
 */
export async function vectorId(memoryId: string): Promise<string> {
  return (await sha256Hex(memoryId)).slice(0, 32);
}

function embeddingVectors(result: unknown): number[][] {
  if (!result || typeof result !== "object") return [];
  const data = (result as Record<string, unknown>).data;
  return Array.isArray(data) ? data.filter((row): row is number[] => Array.isArray(row)) : [];
}

/** Queues embedding for rows just written or changed. A no-op without Vectorize, or with nothing to embed. */
export async function queueEmbed(env: Env, ids: string[]): Promise<void> {
  if (!env.MEMORY_VECTORS || !ids.length) return;
  for (let start = 0; start < ids.length; start += EMBED_BATCH_SIZE) {
    await env.JOBS.send({ type: "embed", ids: ids.slice(start, start + EMBED_BATCH_SIZE) });
  }
}

/** A memory row was deleted outright (not superseded): its vector must go too. */
export async function deleteVectors(env: Env, ids: string[]): Promise<void> {
  if (!env.MEMORY_VECTORS || !ids.length) return;
  await env.MEMORY_VECTORS.deleteByIds(await Promise.all(ids.map(vectorId)));
}

interface EmbeddableRow {
  id: string;
  kind: string;
  occurred_at: string;
  text: string;
  embedded_hash: string | null;
}

/**
 * The `{ type: "embed", ids }` job. Re-reads the rows (by the time this runs, they may have moved
 * on again) and skips any whose text hash already matches what was last embedded, so a burst of
 * writes to the same id only ever pays for one embedding call.
 */
export async function runEmbed(env: Env, ids: string[]): Promise<void> {
  if (!env.MEMORY_VECTORS || !ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, kind, occurred_at, text, embedded_hash FROM memory_items WHERE id IN (${placeholders})`
  ).bind(...ids).all<EmbeddableRow>();
  if (!results.length) return;

  const pending: Array<{ row: EmbeddableRow; hash: string }> = [];
  for (const row of results) {
    const hash = await sha256Hex(row.text);
    if (hash !== row.embedded_hash) pending.push({ row, hash });
  }
  if (!pending.length) return;

  const model = embedModel(env);
  const result = await runModel(env, model, { text: pending.map((item) => item.row.text) });
  await recordUsage(env, null, "embed", model, result);
  const vectors = embeddingVectors(result);
  if (vectors.length !== pending.length) {
    throw new Error(`Embedding model returned ${vectors.length} vectors for ${pending.length} inputs`);
  }

  const vectorsToUpsert = await Promise.all(pending.map(async (item, index) => ({
    id: await vectorId(item.row.id),
    values: vectors[index],
    metadata: { id: item.row.id, kind: item.row.kind, occurredAt: Date.parse(item.row.occurred_at) || 0 }
  })));
  await env.MEMORY_VECTORS.upsert(vectorsToUpsert);

  const now = new Date().toISOString();
  await env.DB.batch(pending.map((item) =>
    env.DB.prepare("UPDATE memory_items SET embedded_at = ?, embedded_hash = ? WHERE id = ?").bind(now, item.hash, item.row.id)
  ));
}

/** The text's own embedding, matched against every memory's, as candidate memory ids and cosine scores. */
export async function queryVectors(env: Env, text: string, topK = 20): Promise<Array<{ id: string; score: number }>> {
  if (!env.MEMORY_VECTORS) return [];
  const model = embedModel(env);
  const result = await runModel(env, model, { text: [text] });
  await recordUsage(env, null, "embed", model, result);
  const vector = embeddingVectors(result)[0];
  if (!vector) return [];
  const matches = await env.MEMORY_VECTORS.query(vector, { topK, returnMetadata: "all" });
  return matches.matches
    .map((match) => ({ id: typeof match.metadata?.id === "string" ? match.metadata.id : "", score: match.score }))
    .filter((hit): hit is { id: string; score: number } => Boolean(hit.id));
}

/**
 * Once-only catch-up for rows written before Vectorize existed, or before this copy had it bound:
 * everything with no vector yet, queued in the same batches as a live write. Safe to call on every
 * request — after the first time, the marker in `settings` makes it a single cheap lookup.
 */
export async function embedBacklog(env: Env): Promise<boolean> {
  if (!env.MEMORY_VECTORS) return false;
  if (await getSetting(env.DB, BACKLOG_SETTING_KEY)) return false;
  const { results } = await env.DB.prepare(
    "SELECT id FROM memory_items WHERE embedded_at IS NULL ORDER BY occurred_at DESC LIMIT ?"
  ).bind(BACKLOG_LIMIT).all<{ id: string }>();
  for (let start = 0; start < results.length; start += EMBED_BATCH_SIZE) {
    await env.JOBS.send({ type: "embed", ids: results.slice(start, start + EMBED_BATCH_SIZE).map((row) => row.id) });
  }
  await setSetting(env.DB, BACKLOG_SETTING_KEY, new Date().toISOString());
  return results.length > 0;
}
