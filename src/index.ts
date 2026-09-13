import { Hono } from "hono";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { applyFinalSynthesis, cueExcerpts, extractJson, finalSynthesisJsonSchema, finalSynthesisPrompt, restoreActionDetails, summaryHasUsefulContent, summaryLanguageLooksHealthy, toMarkdown } from "./summary";
import { deepSimplify, simplifyEnabled, toSimplified } from "./chinese";
import { modelOptions, modelText, recordUsage, runModel } from "./ai";
import { askRoutes } from "./ask";
import { assistantRoutes, calendarFeed, suggestTasksFromMeeting } from "./assistant";
import { runEmbed } from "./embed";
import { queueFacts, runFacts } from "./facts";
import { rememberMeeting, rememberSource, safely, sectionItem, summaryItem, transcriptItems } from "./memory";
import { memoryRoutes } from "./memory-routes";
import { authRoutes, requireOwner, sameOriginWrites } from "./auth";
import {
  SEGMENT_TARGET_MS,
  SegmentNoteSchema,
  fallbackSegmentNote,
  mergeSegments,
  parseSegmentNote,
  segmentJsonSchema,
  planSegment,
  segmentPrompt,
  segmentsToMarkdown,
  segmentNoteHasContent,
  segmentsHaveContent,
  segmentsToPromptText,
  type SegmentNote,
  type StoredSegment
} from "./segment";
import type { ChunkRow, Env, JobMessage, MeetingRow, SegmentRow } from "./types";

const app = new Hono<{ Bindings: Env }>();

/** Workers AI free allocation, in neurons per UTC day. */
const DEFAULT_FREE_DAILY_NEURONS = 10_000;

/**
 * Measured Whisper cost, used only until this deployment has data of its own.
 * Eight chunks of real audio all came back at exactly this rate.
 */
const FALLBACK_NEURONS_PER_AUDIO_SECOND = 0.7772;

/** A chunk left in 'processing' for longer than this is assumed abandoned. */
const STUCK_PROCESSING_MS = 10 * 60 * 1000;

/** Audio chunks delete themselves from KV after this long. KV's minimum is one minute. */
function audioRetentionSeconds(env: Env): number {
  const days = Number(env.AUDIO_RETENTION_DAYS);
  return Math.max(60, Math.round((Number.isFinite(days) && days > 0 ? days : 7) * 86_400));
}

/** How much transcribed audio one rolling note covers. Tunable per environment. */
function segmentTargetMs(env: Env): number {
  const minutes = Number(env.SEGMENT_TARGET_MINUTES);
  if (!Number.isFinite(minutes) || minutes <= 0) return SEGMENT_TARGET_MS;
  return Math.round(minutes * 60 * 1000);
}

const createMeetingSchema = z.object({
  title: z.string().trim().min(1).max(160),
  template: z.enum(["workshop", "meeting", "interview"]).default("workshop"),
  language: z.enum(["auto", "en", "zh"]).default("auto")
});

const finalizeSchema = z.object({
  expectedChunks: z.number().int().positive().max(500)
});

function isoNow(): string {
  return new Date().toISOString();
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function jsonError(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/** The final merge runs once per meeting, so it can afford a stronger model. */
function finalModel(env: Env): string {
  return env.FINAL_MODEL || env.SUMMARY_MODEL;
}

function simplify<T>(env: Env, value: T): T {
  return simplifyEnabled(env.CHINESE_SCRIPT) ? deepSimplify(value) : value;
}

function meetingView(row: MeetingRow) {
  return {
    id: row.id,
    title: row.title,
    template: row.template,
    language: row.language,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    expectedChunks: row.expected_chunks,
    processedChunks: row.processed_chunks,
    summaryStatus: row.summary_status,
    summary: row.summary_json ? JSON.parse(row.summary_json) : null,
    summaryMarkdown: row.summary_markdown,
    forceSummary: row.force_summary === 1,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function findMeeting(db: D1Database, id: string): Promise<MeetingRow | null> {
  return db.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first<MeetingRow>();
}

async function listSegments(db: D1Database, meetingId: string): Promise<SegmentRow[]> {
  const result = await db.prepare(
    "SELECT * FROM meeting_segments WHERE meeting_id = ? ORDER BY seq"
  ).bind(meetingId).all<SegmentRow>();
  return result.results;
}

async function recordEvent(env: Env, meetingId: string, eventType: string, detail = "", chunkId: string | null = null) {
  await env.DB.prepare(
    "INSERT INTO job_events (meeting_id, chunk_id, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(meetingId, chunkId, eventType, detail.slice(0, 2000), isoNow()).run();
}

/**
 * Only the owner, signed in with a passkey, can use the API (see src/auth.ts). Static
 * assets are served before the Worker runs and are not covered: they are the app shell
 * only; every byte of meeting data goes through /api.
 */
app.use("/api/*", sameOriginWrites);
app.use("/api/*", requireOwner);
app.route("/api/auth", authRoutes);
app.route("/api", assistantRoutes);
app.route("/api", askRoutes);
app.route("/api", memoryRoutes);

app.get("/api/health", (c) => c.json({ ok: true, service: "meetingnote-cloudflare" }));

/**
 * How much Workers AI this app has consumed, and therefore how much longer it
 * can record today.
 *
 * Counts only this Worker's own calls — anything else in the account is
 * invisible here — but it needs no API token and never leaves the account.
 */
app.get("/api/usage", async (c) => {
  const freeDaily = Number(c.env.FREE_DAILY_NEURONS) || DEFAULT_FREE_DAILY_NEURONS;
  const today = isoNow().slice(0, 10);

  const totals = await c.env.DB.prepare(
    `SELECT
       (SELECT COALESCE(SUM(neurons), 0) FROM ai_usage WHERE day = ?1) AS today_neurons,
       (SELECT COALESCE(SUM(audio_ms), 0) FROM ai_usage WHERE day = ?1 AND kind = 'asr') AS today_audio_ms,
       (SELECT COALESCE(SUM(neurons), 0) FROM ai_usage WHERE kind IN ('asr', 'segment', 'final')) AS all_neurons,
       (SELECT COALESCE(SUM(audio_ms), 0) FROM ai_usage WHERE kind = 'asr') AS all_audio_ms`
  ).bind(today).first<{ today_neurons: number; today_audio_ms: number; all_neurons: number; all_audio_ms: number }>();

  const kinds = await c.env.DB.prepare(
    "SELECT kind, COALESCE(SUM(neurons), 0) AS neurons, COUNT(*) AS calls FROM ai_usage WHERE day = ? GROUP BY kind"
  ).bind(today).all<{ kind: string; neurons: number; calls: number }>();

  const days = await c.env.DB.prepare(
    `SELECT day, COALESCE(SUM(neurons), 0) AS neurons, COALESCE(SUM(audio_ms), 0) AS audio_ms
       FROM ai_usage GROUP BY day ORDER BY day DESC LIMIT 14`
  ).all<{ day: string; neurons: number; audio_ms: number }>();

  // Cost per second of *recorded audio*, including the notes written from it —
  // that is the number that answers "how much longer can I record". Dictated plans
  // still use up today's allowance, but don't change what a meeting costs.
  const measuredSeconds = (totals?.all_audio_ms ?? 0) / 1000;
  const perAudioSecond = measuredSeconds > 60
    ? (totals?.all_neurons ?? 0) / measuredSeconds
    : FALLBACK_NEURONS_PER_AUDIO_SECOND;

  const used = totals?.today_neurons ?? 0;
  const remaining = Math.max(0, freeDaily - used);

  const reset = new Date();
  reset.setUTCHours(24, 0, 0, 0);

  return c.json({
    ok: true,
    day: today,
    freeDailyNeurons: freeDaily,
    // On Workers Free, Workers AI stops at the allocation instead of billing past it.
    plan: (c.env.WORKERS_PLAN || "free").toLowerCase(),
    hardLimit: (c.env.WORKERS_PLAN || "free").toLowerCase() !== "paid",
    usedNeurons: Number(used.toFixed(2)),
    remainingNeurons: Number(remaining.toFixed(2)),
    neuronsPerAudioSecond: Number(perAudioSecond.toFixed(4)),
    measured: measuredSeconds > 60,
    recordedSecondsToday: Math.round((totals?.today_audio_ms ?? 0) / 1000),
    remainingRecordingSeconds: perAudioSecond > 0 ? Math.round(remaining / perAudioSecond) : 0,
    resetsAt: reset.toISOString(),
    byKind: kinds.results.map((row) => ({ kind: row.kind, neurons: Number(row.neurons.toFixed(2)), calls: row.calls })),
    days: days.results.map((row) => ({
      day: row.day,
      neurons: Number(row.neurons.toFixed(2)),
      recordedSeconds: Math.round(row.audio_ms / 1000)
    }))
  });
});

app.get("/api/meetings", async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT * FROM meetings ORDER BY created_at DESC LIMIT 50"
  ).all<MeetingRow>();
  return c.json({ ok: true, meetings: result.results.map(meetingView) });
});

app.post("/api/meetings", async (c) => {
  const parsed = createMeetingSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid meeting details");

  const id = crypto.randomUUID();
  const now = isoNow();
  await c.env.DB.prepare(
    `INSERT INTO meetings
      (id, title, template, language, status, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'recording', ?, ?, ?)`
  ).bind(id, parsed.data.title, parsed.data.template, parsed.data.language, now, now, now).run();

  const row = await findMeeting(c.env.DB, id);
  return c.json({ ok: true, meeting: meetingView(row!) }, 201);
});

app.get("/api/meetings/:id", async (c) => {
  const meeting = await findMeeting(c.env.DB, c.req.param("id"));
  if (!meeting) return jsonError("Meeting not found", 404);

  const chunks = await c.env.DB.prepare(
    `SELECT id, meeting_id, sequence, mime_type, duration_ms, size_bytes, status,
            transcript_text, retry_count, last_error, created_at, updated_at
       FROM audio_chunks WHERE meeting_id = ? ORDER BY sequence`
  ).bind(meeting.id).all<ChunkRow>();

  const segments = await listSegments(c.env.DB, meeting.id);

  return c.json({
    ok: true,
    meeting: meetingView(meeting),
    segments: segments.map((row) => ({
      id: row.id,
      seq: row.seq,
      startChunk: row.start_chunk,
      endChunk: row.end_chunk,
      durationMs: row.duration_ms,
      status: row.status,
      headline: row.headline,
      note: parseSegmentNote(row.notes_json),
      lastError: row.last_error,
      updatedAt: row.updated_at
    })),
    chunks: chunks.results.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      mimeType: row.mime_type,
      durationMs: row.duration_ms,
      sizeBytes: row.size_bytes,
      status: row.status,
      transcript: row.transcript_text,
      retryCount: row.retry_count,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  });
});

app.put("/api/meetings/:id/chunks/:sequence", async (c) => {
  const meetingId = c.req.param("id");
  const sequence = Number(c.req.param("sequence"));
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 499) return jsonError("Invalid chunk sequence");

  const meeting = await findMeeting(c.env.DB, meetingId);
  if (!meeting) return jsonError("Meeting not found", 404);
  if (meeting.status !== "recording" && meeting.status !== "finalizing") {
    return jsonError("Meeting is no longer accepting audio", 409);
  }

  const existing = await c.env.DB.prepare(
    "SELECT * FROM audio_chunks WHERE meeting_id = ? AND sequence = ?"
  ).bind(meetingId, sequence).first<ChunkRow>();
  if (existing) {
    if ((existing.status === "uploaded" || existing.status === "failed") && (await c.env.AUDIO.list({ prefix: existing.r2_key, limit: 1 })).keys.length > 0) {
      await c.env.DB.prepare("UPDATE audio_chunks SET status = 'uploaded', last_error = NULL, updated_at = ? WHERE id = ?")
        .bind(isoNow(), existing.id).run();
      await c.env.JOBS.send({ type: "transcribe", meetingId, chunkId: existing.id });
      return c.json({ ok: true, duplicate: true, requeued: true, chunkId: existing.id, status: "uploaded" });
    }
    return c.json({ ok: true, duplicate: true, chunkId: existing.id, status: existing.status });
  }

  const mimeType = (c.req.header("content-type") || "audio/webm").split(";")[0];
  if (!mimeType.startsWith("audio/")) return jsonError("Request body must be audio", 415);
  const audio = await c.req.arrayBuffer();
  if (audio.byteLength === 0) return jsonError("Audio chunk is empty");
  if (audio.byteLength > 25 * 1024 * 1024) return jsonError("Audio chunk exceeds 25 MB", 413);

  const durationMs = Math.max(0, Number(c.req.header("x-duration-ms") || 0));
  const chunkId = `${meetingId}-${String(sequence).padStart(4, "0")}`;
  const extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : "webm";
  const r2Key = `meetings/${meetingId}/chunks/${String(sequence).padStart(4, "0")}.${extension}`;
  const now = isoNow();

  await c.env.AUDIO.put(r2Key, audio, {
    expirationTtl: audioRetentionSeconds(c.env),
    metadata: { meetingId, sequence, durationMs, contentType: mimeType }
  });

  try {
    await c.env.DB.prepare(
      `INSERT INTO audio_chunks
        (id, meeting_id, sequence, r2_key, mime_type, duration_ms, size_bytes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded', ?, ?)`
    ).bind(chunkId, meetingId, sequence, r2Key, mimeType, durationMs, audio.byteLength, now, now).run();
  } catch (error) {
    await c.env.AUDIO.delete(r2Key);
    throw error;
  }
  await c.env.JOBS.send({ type: "transcribe", meetingId, chunkId });
  await recordEvent(c.env, meetingId, "chunk_uploaded", `sequence=${sequence};bytes=${audio.byteLength}`, chunkId);

  return c.json({ ok: true, chunkId, status: "uploaded" }, 201);
});

app.post("/api/meetings/:id/finalize", async (c) => {
  const meetingId = c.req.param("id");
  const parsed = finalizeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError("expectedChunks must be a positive integer");

  const meeting = await findMeeting(c.env.DB, meetingId);
  if (!meeting) return jsonError("Meeting not found", 404);
  const now = isoNow();
  await c.env.DB.prepare(
    `UPDATE meetings SET status = 'finalizing', ended_at = COALESCE(ended_at, ?),
       expected_chunks = ?, updated_at = ? WHERE id = ?`
  ).bind(now, parsed.data.expectedChunks, now, meetingId).run();
  await advance(c.env, meetingId);

  return c.json({ ok: true, status: "finalizing" });
});

app.post("/api/meetings/:id/retry", async (c) => {
  const meetingId = c.req.param("id");
  const meeting = await findMeeting(c.env.DB, meetingId);
  if (!meeting) return jsonError("Meeting not found", 404);

  // Chunks that failed outright, plus chunks abandoned mid-flight by a worker
  // that died between marking 'processing' and writing a transcript.
  const stuckBefore = isoAgo(STUCK_PROCESSING_MS);
  const retryable = await c.env.DB.prepare(
    `SELECT id FROM audio_chunks
       WHERE meeting_id = ?
         AND (status = 'failed' OR (status = 'processing' AND updated_at < ?))
       ORDER BY sequence`
  ).bind(meetingId, stuckBefore).all<{ id: string }>();
  for (const chunk of retryable.results) {
    await c.env.DB.prepare("UPDATE audio_chunks SET status = 'uploaded', last_error = NULL, updated_at = ? WHERE id = ?")
      .bind(isoNow(), chunk.id).run();
    await c.env.JOBS.send({ type: "transcribe", meetingId, chunkId: chunk.id });
  }

  const failedSegments = await c.env.DB.prepare(
    `SELECT id FROM meeting_segments
       WHERE meeting_id = ?
         AND (status = 'failed' OR (status = 'processing' AND updated_at < ?))
       ORDER BY seq`
  ).bind(meetingId, stuckBefore).all<{ id: string }>();
  for (const segment of failedSegments.results) {
    await c.env.DB.prepare("UPDATE meeting_segments SET status = 'queued', last_error = NULL, updated_at = ? WHERE id = ?")
      .bind(isoNow(), segment.id).run();
    await c.env.JOBS.send({ type: "segment", meetingId, segmentId: segment.id });
  }

  if (meeting.summary_status === "failed") {
    await c.env.DB.prepare(
      "UPDATE meetings SET summary_status = 'waiting', summary_enqueued_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?"
    ).bind(isoNow(), meetingId).run();
  }
  await advance(c.env, meetingId);

  return c.json({
    ok: true,
    retriedChunks: retryable.results.length,
    retriedSegments: failedSegments.results.length
  });
});

/**
 * Build the note from whatever transcribed successfully.
 *
 * Without this, one chunk that can never transcribe holds the whole meeting
 * hostage: the final merge waits for a chunk count it will never reach.
 */
app.post("/api/meetings/:id/force-summary", async (c) => {
  const meetingId = c.req.param("id");
  const meeting = await findMeeting(c.env.DB, meetingId);
  if (!meeting) return jsonError("Meeting not found", 404);

  const now = isoNow();
  await c.env.DB.prepare(
    `UPDATE meetings SET force_summary = 1,
       status = CASE WHEN status = 'recording' THEN 'finalizing' ELSE status END,
       ended_at = COALESCE(ended_at, ?),
       summary_status = CASE WHEN summary_status = 'failed' THEN 'waiting' ELSE summary_status END,
       summary_enqueued_at = CASE WHEN summary_status = 'failed' THEN NULL ELSE summary_enqueued_at END,
       updated_at = ? WHERE id = ?`
  ).bind(now, now, meetingId).run();
  await recordEvent(c.env, meetingId, "force_summary_requested");
  await advance(c.env, meetingId);

  return c.json({ ok: true, forced: true });
});

/**
 * Write the note again from the transcript already saved, for instance after a better model or
 * prompt. Audio and transcripts are left alone, so a bad note never means recording again.
 */
app.post("/api/meetings/:id/rebuild-note", async (c) => {
  const meetingId = c.req.param("id");
  const meeting = await findMeeting(c.env.DB, meetingId);
  if (!meeting) return jsonError("Meeting not found", 404);
  if (meeting.status === "recording") return jsonError("Stop the recording first", 409);

  const transcripts = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM audio_chunks WHERE meeting_id = ? AND status = 'done' AND LENGTH(TRIM(COALESCE(transcript_text, ''))) > 0"
  ).bind(meetingId).first<{ count: number }>();
  if (!transcripts?.count) return jsonError("There's no saved transcript to write a note from", 409);

  const now = isoNow();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM meeting_segments WHERE meeting_id = ?").bind(meetingId),
    // The rewritten notes are remembered afresh; transcript passages stay.
    c.env.DB.prepare("DELETE FROM memory_items WHERE meeting_id = ? AND kind IN ('section', 'summary')").bind(meetingId),
    c.env.DB.prepare(
      `UPDATE meetings SET status = 'finalizing', summary_status = 'waiting',
         summary_json = NULL, summary_markdown = NULL, summary_enqueued_at = NULL,
         force_summary = 0, last_error = NULL, updated_at = ? WHERE id = ?`
    ).bind(now, meetingId)
  ]);
  await recordEvent(c.env, meetingId, "note_rebuild_started", `transcripts=${transcripts.count}`);
  await advance(c.env, meetingId);
  return c.json({ ok: true, status: "rebuilding", transcripts: transcripts.count });
});

app.get("/api/meetings/:id/export.md", async (c) => {
  const meeting = await findMeeting(c.env.DB, c.req.param("id"));
  if (!meeting) return jsonError("Meeting not found", 404);

  let markdown = meeting.summary_markdown;
  if (!markdown) {
    // Fall back to the running notes so a meeting in progress is still usable.
    const segments = await listSegments(c.env.DB, meeting.id);
    const written = segments.filter((segment) => segment.notes_json);
    if (written.length === 0) return jsonError("No notes are available yet", 409);
    markdown = segmentsToMarkdown(meeting.title, written as unknown as StoredSegment[]);
  }

  const filename = meeting.title.replace(/[^a-z0-9一-鿿]+/gi, "-").replace(/^-|-$/g, "") || "meeting-note";
  return new Response(markdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${encodeURIComponent(filename)}.md"`
    }
  });
});

// A calendar app subscribing to the owner's plans. Outside /api: calendar apps can't sign in.
app.get("/cal/:file", calendarFeed);

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((error, c) => {
  console.error(error);
  return c.json({ ok: false, error: "Unexpected server error" }, 500);
});

// ---------------------------------------------------------------------------
// Rolling segments
// ---------------------------------------------------------------------------

/**
 * Close one segment if enough transcribed audio has accumulated.
 *
 * Segments must stay contiguous and in order, so a chunk that has not finished
 * transcribing stops the walk — unless `force` is set, which is how a meeting
 * closes out over chunks that will never arrive.
 */
async function createNextSegment(env: Env, meetingId: string, force: boolean): Promise<boolean> {
  const last = await env.DB.prepare(
    "SELECT MAX(seq) AS max_seq, MAX(end_chunk) AS max_end FROM meeting_segments WHERE meeting_id = ?"
  ).bind(meetingId).first<{ max_seq: number | null; max_end: number | null }>();

  const nextSeq = (last?.max_seq ?? -1) + 1;
  const startChunk = (last?.max_end ?? -1) + 1;

  const rows = await env.DB.prepare(
    "SELECT sequence, status, duration_ms FROM audio_chunks WHERE meeting_id = ? AND sequence >= ? ORDER BY sequence"
  ).bind(meetingId, startChunk).all<{ sequence: number; status: string; duration_ms: number }>();

  const plan = planSegment(rows.results, startChunk, segmentTargetMs(env), force);
  if (!plan.ready) return false;
  const endChunk = plan.endChunk;

  const now = isoNow();
  const id = `${meetingId}-seg-${String(nextSeq).padStart(3, "0")}`;
  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO meeting_segments
       (id, meeting_id, seq, start_chunk, end_chunk, duration_ms, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
  ).bind(id, meetingId, nextSeq, startChunk, endChunk, plan.accumulatedMs, now, now).run();
  if ((insert.meta.changes ?? 0) !== 1) return false;

  await env.JOBS.send({ type: "segment", meetingId, segmentId: id });
  await recordEvent(env, meetingId, "segment_queued", `seq=${nextSeq};chunks=${startChunk}-${endChunk}`);
  return true;
}

interface AdvanceCounts {
  pending_chunks: number;
  total_chunks: number;
  max_seq: number;
  max_end: number;
  open_segments: number;
}

async function advanceCounts(env: Env, meetingId: string): Promise<AdvanceCounts> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM audio_chunks WHERE meeting_id = ?1 AND status NOT IN ('done','failed')) AS pending_chunks,
       (SELECT COUNT(*) FROM audio_chunks WHERE meeting_id = ?1) AS total_chunks,
       (SELECT COALESCE(MAX(sequence), -1) FROM audio_chunks WHERE meeting_id = ?1) AS max_seq,
       (SELECT COALESCE(MAX(end_chunk), -1) FROM meeting_segments WHERE meeting_id = ?1) AS max_end,
       (SELECT COUNT(*) FROM meeting_segments WHERE meeting_id = ?1 AND status NOT IN ('done','failed')) AS open_segments`
  ).bind(meetingId).first<AdvanceCounts>();
  return row ?? { pending_chunks: 0, total_chunks: 0, max_seq: -1, max_end: -1, open_segments: 0 };
}

/**
 * Move a meeting forward as far as it can currently go: roll out any segment
 * that is ready, and queue the final merge once nothing is outstanding.
 *
 * Safe to call repeatedly — every state change is guarded.
 */
async function advance(env: Env, meetingId: string) {
  const meeting = await findMeeting(env.DB, meetingId);
  if (!meeting) return;

  for (let guard = 0; guard < 60; guard++) {
    if (!(await createNextSegment(env, meetingId, false))) break;
  }

  const forced = meeting.force_summary === 1;
  if (meeting.status !== "finalizing" && !forced) return;
  if (meeting.summary_status !== "waiting") return;

  const counts = await advanceCounts(env, meetingId);
  const everythingUploaded = meeting.expected_chunks === null || counts.total_chunks >= meeting.expected_chunks;
  if (!forced && (counts.pending_chunks > 0 || !everythingUploaded)) return;

  for (let guard = 0; guard < 60; guard++) {
    if (!(await createNextSegment(env, meetingId, true))) break;
  }

  const after = await advanceCounts(env, meetingId);
  if (after.max_seq < 0) return; // nothing was ever recorded
  if (after.max_end < after.max_seq) return;
  if (after.open_segments > 0) return;

  const now = isoNow();
  const update = await env.DB.prepare(
    `UPDATE meetings SET summary_status = 'queued', summary_enqueued_at = ?, updated_at = ?
     WHERE id = ? AND summary_status = 'waiting' AND summary_enqueued_at IS NULL`
  ).bind(now, now, meetingId).run();
  if ((update.meta.changes ?? 0) === 1) {
    try {
      await env.JOBS.send({ type: "final", meetingId });
      await recordEvent(env, meetingId, "final_queued");
    } catch (error) {
      await env.DB.prepare(
        "UPDATE meetings SET summary_status = 'waiting', summary_enqueued_at = NULL, updated_at = ? WHERE id = ?"
      ).bind(isoNow(), meetingId).run();
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

async function transcribeChunk(env: Env, message: Extract<JobMessage, { type: "transcribe" }>) {
  const chunk = await env.DB.prepare("SELECT * FROM audio_chunks WHERE id = ? AND meeting_id = ?")
    .bind(message.chunkId, message.meetingId).first<ChunkRow>();
  if (!chunk || chunk.status === "done") return;

  const audio = await env.AUDIO.get(chunk.r2_key, "arrayBuffer");
  if (!audio) throw new Error(`Audio is missing (expired or never stored): ${chunk.r2_key}`);
  const audioBase64 = Buffer.from(audio).toString("base64");
  const meeting = await findMeeting(env.DB, message.meetingId);
  if (!meeting) throw new Error("Meeting disappeared before transcription");

  await env.DB.prepare("UPDATE audio_chunks SET status = 'processing', updated_at = ? WHERE id = ?")
    .bind(isoNow(), chunk.id).run();

  const input: Record<string, unknown> = {
    audio: audioBase64,
    vad_filter: true,
    // Written in Simplified Chinese on purpose: Whisper mirrors the script of
    // its prompt, and defaults to Traditional characters for Mandarin otherwise.
    initial_prompt: "以下是一场商务工作坊或会议的录音。请用简体中文转写中文部分，准确保留人名、公司名、产品名、网址、数字、提问和待办事项。音频可能在中文和英文之间切换。Business workshop or meeting; the audio may switch between Chinese and English."
  };
  if (meeting.language !== "auto") input.language = meeting.language;

  const result = await runModel(env, env.ASR_MODEL, input);
  await recordUsage(env, message.meetingId, "asr", env.ASR_MODEL, result, chunk.duration_ms);
  const resultObject = result as Record<string, unknown>;
  const transcriptionInfo = resultObject.transcription_info as Record<string, unknown> | undefined;
  const rawTranscript = String(resultObject.text ?? transcriptionInfo?.text ?? resultObject.transcription ?? "").trim();
  // Prompting alone does not reliably keep Whisper in Simplified characters.
  const transcript = simplifyEnabled(env.CHINESE_SCRIPT) ? toSimplified(rawTranscript) : rawTranscript;

  // An empty transcript is a legitimate result, not a failure: a break, a muted
  // microphone or a silent stretch all produce one, and treating it as an error
  // used to deadlock the whole meeting behind a chunk that could never succeed.
  const now = isoNow();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE audio_chunks SET status = 'done', transcript_text = ?, transcript_json = ?, last_error = NULL, updated_at = ? WHERE id = ?"
    ).bind(transcript, JSON.stringify(result), now, chunk.id),
    env.DB.prepare(
      `UPDATE meetings SET processed_chunks =
        (SELECT COUNT(*) FROM audio_chunks WHERE meeting_id = ? AND status = 'done'), updated_at = ? WHERE id = ?`
    ).bind(message.meetingId, now, message.meetingId)
  ]);
  await safely("remember a transcript", () => rememberSource(env, chunk.id, transcriptItems(meeting, chunk, transcript)));
  await recordEvent(
    env,
    message.meetingId,
    transcript ? "chunk_transcribed" : "chunk_silent",
    `sequence=${chunk.sequence};chars=${transcript.length}`,
    chunk.id
  );
  await advance(env, message.meetingId);
}

async function runSegment(env: Env, message: Extract<JobMessage, { type: "segment" }>) {
  const segment = await env.DB.prepare("SELECT * FROM meeting_segments WHERE id = ? AND meeting_id = ?")
    .bind(message.segmentId, message.meetingId).first<SegmentRow>();
  if (!segment || segment.status === "done") return;

  const meeting = await findMeeting(env.DB, message.meetingId);
  if (!meeting) throw new Error("Meeting disappeared before the segment note");

  await env.DB.prepare("UPDATE meeting_segments SET status = 'processing', updated_at = ? WHERE id = ?")
    .bind(isoNow(), segment.id).run();

  const chunks = await env.DB.prepare(
    `SELECT sequence, transcript_text FROM audio_chunks
       WHERE meeting_id = ? AND sequence BETWEEN ? AND ? AND status = 'done'
       ORDER BY sequence`
  ).bind(message.meetingId, segment.start_chunk, segment.end_chunk)
    .all<Pick<ChunkRow, "sequence" | "transcript_text">>();

  const usable = chunks.results.filter((chunk) => (chunk.transcript_text ?? "").trim());

  let note: SegmentNote;
  if (usable.length === 0) {
    // Silence, or chunks skipped at close-out. Record the gap without spending a model call.
    note = SegmentNoteSchema.parse({
      headline: "No speech was transcribed in this section",
      bullets: [],
      decisions: [],
      questions: [],
      action_items: [],
      tools: [],
      resources: [],
      quotes: []
    });
  } else {
    const minutesLabel = `section ${segment.seq + 1}, chunks ${segment.start_chunk}-${segment.end_chunk}`;
    const result = await runModel(env, env.SUMMARY_MODEL, {
      messages: [
        { role: "system", content: "You are a precise bilingual meeting analyst. You only report what participants actually said in the transcript, never any context notes given alongside it. Write in the language the instructions name. Always give a headline, even for a short excerpt." },
        { role: "user", content: segmentPrompt(usable, minutesLabel, meeting.language) }
      ],
      response_format: { type: "json_schema", json_schema: { name: "segment_note", strict: true, schema: segmentJsonSchema } },
      max_tokens: 900,
      temperature: 0.1,
      ...modelOptions(env.SUMMARY_MODEL)
    });
    await recordUsage(env, message.meetingId, "segment", env.SUMMARY_MODEL, result);

    try {
      note = SegmentNoteSchema.parse(extractJson(modelText(result)));
      if (!segmentNoteHasContent(note)) throw new Error("The model returned an empty section note");
    } catch (error) {
      note = fallbackSegmentNote(usable);
      await recordEvent(env, message.meetingId, "segment_fallback", error instanceof Error ? error.message : String(error));
    }
    // An empty headline renders as a blank section in the app and in the export.
    if (!note.headline.trim()) {
      note.headline = note.bullets[0]?.slice(0, 120)
        || (usable[0]?.transcript_text ?? "").trim().slice(0, 120)
        || `Section ${segment.seq + 1}`;
    }
  }

  note = simplify(env, note);

  const now = isoNow();
  await env.DB.prepare(
    "UPDATE meeting_segments SET status = 'done', notes_json = ?, headline = ?, last_error = NULL, updated_at = ? WHERE id = ?"
  ).bind(JSON.stringify(note), note.headline.slice(0, 300), now, segment.id).run();
  const remembered = sectionItem(meeting, segment, note);
  await safely("remember a section note", () => rememberSource(env, segment.id, remembered ? [remembered] : []));
  await recordEvent(env, message.meetingId, "segment_done", `seq=${segment.seq};bullets=${note.bullets.length}`);
  await advance(env, message.meetingId);
}

/** Merge the rolling segment notes into the final structured note. */
async function runFinal(env: Env, meetingId: string) {
  const meeting = await findMeeting(env.DB, meetingId);
  if (!meeting || meeting.summary_status === "done") return;
  await env.DB.prepare("UPDATE meetings SET summary_status = 'processing', updated_at = ? WHERE id = ?")
    .bind(isoNow(), meetingId).run();

  const segmentRows = await listSegments(env.DB, meetingId);
  if (segmentRows.length === 0) throw new Error("No segment notes to merge");
  const segments = segmentRows as unknown as StoredSegment[];

  // Guaranteed usable, and the fallback if the model's merge cannot be parsed.
  const deterministic = mergeSegments(segments);
  const promptText = segmentsToPromptText(segments);
  const transcriptRows = await env.DB.prepare(
    "SELECT sequence, transcript_text FROM audio_chunks WHERE meeting_id = ? AND status = 'done' ORDER BY sequence"
  ).bind(meetingId).all<Pick<ChunkRow, "sequence" | "transcript_text">>();
  const fullTranscript = transcriptRows.results
    .map((row) => `[CHUNK ${row.sequence}]\n${row.transcript_text || ""}`)
    .join("\n\n");
  const cues = cueExcerpts(transcriptRows.results);
  const cueText = cues
    .map((excerpt) => `[CHUNK ${excerpt.sequence}] ${excerpt.text}`)
    .join("\n");

  let summary = deterministic;
  if (promptText.trim() && segmentsHaveContent(segments)) {
    // GLM's long context comfortably fits a normal meeting transcript. Keep a bounded
    // cue fallback for unusually long recordings so the job still completes instead of
    // exceeding the provider limit.
    const useFullTranscript = fullTranscript.length <= 70_000;
    const transcriptSource = useFullTranscript ? fullTranscript : cueText;
    const result = await runModel(env, finalModel(env), {
      messages: [
        { role: "system", content: "You are a precise bilingual meeting analyst. Produce strict JSON grounded only in the supplied notes and transcript excerpts. Output JSON only, with no commentary." },
        { role: "user", content: finalSynthesisPrompt(meeting, transcriptSource, useFullTranscript) }
      ],
      response_format: { type: "json_schema", json_schema: { name: "meeting_synthesis", strict: true, schema: finalSynthesisJsonSchema } },
      max_tokens: 2000,
      temperature: 0.1,
      ...modelOptions(finalModel(env), true)
    });
    await recordUsage(env, meetingId, "final", finalModel(env), result);
    const outputText = modelText(result);
    try {
      const extracted = extractJson(outputText);
      const applied = applyFinalSynthesis(extracted, deterministic);
      const transcriptText = transcriptRows.results.map((row) => row.transcript_text || "").join("\n");
      if (applied.recoveredFields.length === 0 || !summaryHasUsefulContent(applied.summary, deterministic)) {
        throw new Error("Model returned no usable synthesis fields");
      }
      if (!summaryLanguageLooksHealthy(applied.summary, transcriptText)) {
        throw new Error("Model synthesis failed the language quality check");
      }
      summary = { ...applied.summary, action_items: restoreActionDetails(applied.summary.action_items, deterministic.action_items) };
      await recordEvent(
        env,
        meetingId,
        applied.recoveredFields.length === 8 ? "final_synthesized" : "final_partial_recovered",
        `fields=${applied.recoveredFields.join(",")};source=${useFullTranscript ? "full" : "cues"};chars=${transcriptSource.length}`
      );
    } catch (error) {
      summary = deterministic;
      const message = error instanceof Error ? error.message : String(error);
      await recordEvent(env, meetingId, "final_fallback", `${message};output=${outputText.slice(0, 500)}`);
    }
  }

  summary = simplify(env, summary);
  const markdown = toMarkdown(meeting.title, summary);
  const now = isoNow();
  await env.DB.prepare(
    `UPDATE meetings SET status = 'ready', summary_status = 'done', summary_json = ?, summary_markdown = ?,
       last_error = NULL, updated_at = ? WHERE id = ?`
  ).bind(JSON.stringify(summary), markdown, now, meetingId).run();
  const remembered = summaryItem(meeting, summary);
  await safely("remember a meeting note", () => rememberSource(env, meetingId, remembered ? [remembered] : []));
  await safely("suggest the meeting's to-dos", () => suggestTasksFromMeeting(env, meeting, summary.action_items));
  await safely("queue the meeting's durable facts", () => queueFacts(env, meetingId));
  await recordEvent(env, meetingId, "final_completed", `sections=${segmentRows.length}`);
}

async function markJobFailed(env: Env, body: JobMessage, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  const now = isoNow();

  // Embedding has no single meeting to blame it on (its ids can span several, or none), and no
  // status column of its own: the backlog scan or the next write queues it again regardless.
  if (body.type === "embed") {
    console.error("Embedding failed permanently", body.ids, detail);
    return;
  }

  if (body.type === "transcribe") {
    await env.DB.prepare(
      "UPDATE audio_chunks SET status = 'failed', retry_count = retry_count + 1, last_error = ?, updated_at = ? WHERE id = ?"
    ).bind(detail.slice(0, 2000), now, body.chunkId).run();
  } else if (body.type === "segment") {
    await env.DB.prepare(
      "UPDATE meeting_segments SET status = 'failed', retry_count = retry_count + 1, last_error = ?, updated_at = ? WHERE id = ?"
    ).bind(detail.slice(0, 2000), now, body.segmentId).run();
  } else if (body.type === "final" || body.type === "summarize") {
    await env.DB.prepare(
      "UPDATE meetings SET summary_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?"
    ).bind(detail.slice(0, 2000), now, body.meetingId).run();
  }
  await recordEvent(env, body.meetingId, "job_failed", `${body.type}: ${detail}`, body.type === "transcribe" ? body.chunkId : null);

  // A dead chunk or segment must not hold the rest of the meeting hostage.
  if (body.type === "transcribe" || body.type === "segment") {
    try {
      await advance(env, body.meetingId);
    } catch (advanceError) {
      console.error("advance after failure did not complete", advanceError);
    }
  }
}

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<JobMessage>, env: Env) {
    for (const message of batch.messages) {
      try {
        const body = message.body;
        if (body.type === "transcribe") await transcribeChunk(env, body);
        else if (body.type === "segment") await runSegment(env, body);
        else if (body.type === "remember") await rememberMeeting(env, body.meetingId);
        else if (body.type === "embed") await runEmbed(env, body.ids);
        else if (body.type === "facts") await runFacts(env, body.meetingId);
        else await runFinal(env, body.meetingId);
        message.ack();
      } catch (error) {
        console.error("Queue job failed", message.body, error);
        const attempts = message.attempts;
        if (attempts >= 3) {
          await markJobFailed(env, message.body, error);
          message.ack();
        } else {
          message.retry({ delaySeconds: Math.min(60, attempts * 10) });
        }
      }
    }
  }
};
