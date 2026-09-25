import { Hono } from "hono";
import { modelOptions, modelText, recordUsage, runModel } from "./ai";
import { chunkAudio } from "./audio";
import { simplifyEnabled, toSimplified } from "./chinese";
import { loadVocabulary } from "./transcript";
import type { ChunkRow, Env } from "./types";

/**
 * High-definition re-transcription. The live pipeline stays exactly as it is — Whisper, chunk by
 * chunk, inside the free allowance. This is a second pass over a meeting that is already finished,
 * with a model that also says who is speaking, and it is only ever started by the owner, for one
 * meeting at a time, because it is billed per audio minute against their own Cloudflare account.
 *
 * The audio never leaves that account: the model runs on Workers AI through the same `AI` binding
 * as everything else. That is the whole reason this is the first paid tier rather than a better
 * one from somewhere else.
 */

/** What an owner sets HD_MODEL to when they choose to turn the feature on. */
export const DEFAULT_HD_MODEL = "@cf/deepgram/nova-3";
/** Cloudflare's published price for the batch endpoint, to show a cost before anyone agrees to it. */
const USD_PER_AUDIO_MINUTE = 0.0052;
/** Keyterms sharpen names and product words; more than this and the request gets unwieldy. */
const MAX_KEYTERMS = 40;

export const hdRoutes = new Hono<{ Bindings: Env }>();

type HdRow = {
  meeting_id: string;
  status: string;
  model: string;
  chunks_total: number;
  chunks_done: number;
  speakers_json: string | null;
  last_error: string | null;
};

type Utterance = { speaker: number; start: number; end: number; text: string };
/** A speaker as the meeting knows them, gathering the per-chunk numbers that turned out to be them. */
type Speaker = { id: string; label: string; name: string | null; seconds: number; members: string[] };

export function hdModel(env: Env): string {
  // Off unless the owner turns it on. It is the one thing in the app that is billed, and a fresh
  // copy promises $0 with no card on file — so a missing HD_MODEL must mean off, not the default.
  return (env.HD_MODEL ?? "").trim();
}

function isoNow(): string {
  return new Date().toISOString();
}

/** Deepgram answers with utterances when asked; otherwise its words carry the speaker numbers. */
export function utterancesFrom(result: unknown): Utterance[] {
  const data = result as Record<string, any> | null;
  const results = data?.results ?? data;
  const spoken = results?.utterances;
  if (Array.isArray(spoken) && spoken.length) {
    return spoken
      .map((item: Record<string, unknown>) => ({
        speaker: Number(item.speaker ?? 0),
        start: Number(item.start ?? 0),
        end: Number(item.end ?? 0),
        text: String(item.transcript ?? item.text ?? "").trim()
      }))
      .filter((item) => item.text);
  }
  const alternative = results?.channels?.[0]?.alternatives?.[0];
  const words = alternative?.words;
  if (Array.isArray(words) && words.length) {
    const grouped: Utterance[] = [];
    for (const word of words) {
      const speaker = Number(word.speaker ?? 0);
      const last = grouped[grouped.length - 1];
      const text = String(word.punctuated_word ?? word.word ?? "").trim();
      if (!text) continue;
      // Chinese has no spaces; joining on one would litter the transcript with gaps.
      const joiner = /[一-鿿]$/.test(last?.text ?? "") || /^[一-鿿]/.test(text) ? "" : " ";
      if (last && last.speaker === speaker) {
        last.text += `${joiner}${text}`;
        last.end = Number(word.end ?? last.end);
      } else {
        grouped.push({ speaker, start: Number(word.start ?? 0), end: Number(word.end ?? 0), text });
      }
    }
    return grouped.filter((item) => item.text);
  }
  const transcript = String(alternative?.transcript ?? "").trim();
  return transcript ? [{ speaker: 0, start: 0, end: 0, text: transcript }] : [];
}

async function readRun(env: Env, meetingId: string): Promise<HdRow | null> {
  return env.DB.prepare("SELECT * FROM hd_runs WHERE meeting_id = ?").bind(meetingId).first<HdRow>();
}

async function setStatus(env: Env, meetingId: string, status: string, error: string | null = null): Promise<void> {
  await env.DB.prepare("UPDATE hd_runs SET status = ?, last_error = ?, updated_at = ? WHERE meeting_id = ?")
    .bind(status, error, isoNow(), meetingId).run();
}

/**
 * Deepgram numbers speakers from zero *per request*, so chunk 3's "speaker 0" is nobody in
 * particular. The chunks are held together here: a model reads a short profile of each chunk's
 * speakers and groups the ones that are the same person. If it cannot, the numbers themselves are
 * the fallback, which is right more often than it is wrong for a meeting with stable seats.
 */
export async function reconcileSpeakers(env: Env, meetingId: string): Promise<Speaker[]> {
  const chunks = await env.DB.prepare(
    "SELECT sequence, hd_json FROM audio_chunks WHERE meeting_id = ? AND hd_json IS NOT NULL ORDER BY sequence"
  ).bind(meetingId).all<{ sequence: number; hd_json: string }>();

  const seconds = new Map<string, number>();
  const samples = new Map<string, string[]>();
  for (const row of chunks.results || []) {
    let utterances: Utterance[] = [];
    try {
      utterances = JSON.parse(row.hd_json) as Utterance[];
    } catch {
      continue;
    }
    for (const utterance of utterances) {
      const key = `${row.sequence}:${utterance.speaker}`;
      seconds.set(key, (seconds.get(key) || 0) + Math.max(0, utterance.end - utterance.start));
      const kept = samples.get(key) || [];
      if (kept.length < 3 && utterance.text.length > 8) kept.push(utterance.text.slice(0, 90));
      samples.set(key, kept);
    }
  }
  const keys = [...seconds.keys()];
  if (!keys.length) return [];

  let groups: string[][] = [];
  const model = env.SUMMARY_MODEL;
  if (keys.length > 1 && model) {
    const profile = keys.map((key) => ({ id: key, seconds: Math.round(seconds.get(key) || 0), says: samples.get(key) || [] }));
    try {
      const result = await runModel(env, model, {
        messages: [
          {
            role: "system",
            content: "You group voices. Each id is one speaker inside one slice of the same meeting, numbered independently per slice, so the same person appears under several ids. Group the ids that are the same person. Reply with JSON only: {\"groups\": [[\"1:0\", \"2:1\"], [\"1:1\"]]}. Every id appears exactly once."
          },
          { role: "user", content: JSON.stringify(profile) }
        ],
        ...modelOptions(model)
      });
      await recordUsage(env, meetingId, "hd_speakers", model, result);
      const parsed = JSON.parse(modelText(result).replace(/^[^[{]*/, "").replace(/[^\]}]*$/, ""));
      const proposed = Array.isArray(parsed?.groups) ? parsed.groups : [];
      const seen = new Set<string>();
      groups = proposed
        .map((group: unknown) => (Array.isArray(group) ? group.filter((id): id is string => typeof id === "string" && keys.includes(id) && !seen.has(id) && seen.add(id) !== undefined) : []))
        .filter((group: string[]) => group.length);
      for (const key of keys) if (!seen.has(key)) groups.push([key]);
    } catch (error) {
      console.error("Speaker reconciliation fell back to the numbers", error);
      groups = [];
    }
  }
  if (!groups.length) {
    // The numbers themselves: speaker 0 in every chunk is treated as one person, and so on.
    const byNumber = new Map<string, string[]>();
    for (const key of keys) {
      const number = key.split(":")[1];
      byNumber.set(number, [...(byNumber.get(number) || []), key]);
    }
    groups = [...byNumber.values()];
  }

  const speakers: Speaker[] = groups
    .map((members, index) => ({
      id: `S${index + 1}`,
      label: `Speaker ${index + 1}`,
      name: null,
      seconds: Math.round(members.reduce((total, key) => total + (seconds.get(key) || 0), 0)),
      members
    }))
    .sort((first, second) => second.seconds - first.seconds)
    .map((speaker, index) => ({ ...speaker, id: `S${index + 1}`, label: `Speaker ${index + 1}` }));

  await env.DB.prepare("UPDATE hd_runs SET speakers_json = ?, updated_at = ? WHERE meeting_id = ?")
    .bind(JSON.stringify(speakers), isoNow(), meetingId).run();
  return speakers;
}

/** The queue job: one model call per chunk, resumable, and it never touches the Whisper transcript. */
export async function runHd(env: Env, meetingId: string): Promise<void> {
  const model = hdModel(env);
  const run = await readRun(env, meetingId);
  if (!run || !model || run.status === "done") return;
  await setStatus(env, meetingId, "running");

  const meeting = await env.DB.prepare("SELECT language FROM meetings WHERE id = ?")
    .bind(meetingId).first<{ language: string }>();
  const vocabulary = await loadVocabulary(env);
  const chunks = await env.DB.prepare("SELECT * FROM audio_chunks WHERE meeting_id = ? ORDER BY sequence")
    .bind(meetingId).all<ChunkRow & { hd_json: string | null; audio_deleted_at: string | null }>();
  const rows = chunks.results || [];
  let done = 0;
  let missing = 0;

  for (const chunk of rows) {
    if (chunk.hd_json) {
      done += 1;
      continue;
    }
    const audio = chunk.audio_deleted_at ? null : await chunkAudio(env, chunk);
    if (!audio) {
      // Expired or deleted: the rest of the meeting can still be re-transcribed.
      missing += 1;
      done += 1;
      continue;
    }
    const input: Record<string, unknown> = {
      audio: { body: audio, contentType: chunk.mime_type || "audio/webm" },
      diarize: true,
      utterances: true,
      punctuate: true,
      smart_format: true
    };
    if (meeting?.language && meeting.language !== "auto") input.language = meeting.language;
    else input.detect_language = true;
    if (vocabulary.length) input.keyterm = vocabulary.slice(0, MAX_KEYTERMS).join(",");

    const result = await runModel(env, model, input);
    await recordUsage(env, meetingId, "hd_asr", model, result, chunk.duration_ms);
    const utterances = utterancesFrom(result).map((utterance) => ({
      ...utterance,
      text: simplifyEnabled(env.CHINESE_SCRIPT) ? toSimplified(utterance.text) : utterance.text
    }));
    done += 1;
    await env.DB.prepare("UPDATE audio_chunks SET hd_json = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(utterances), isoNow(), chunk.id).run();
    await env.DB.prepare("UPDATE hd_runs SET chunks_done = ?, updated_at = ? WHERE meeting_id = ?")
      .bind(done, isoNow(), meetingId).run();
  }

  await reconcileSpeakers(env, meetingId);
  await env.DB.prepare("UPDATE hd_runs SET status = 'done', chunks_done = ?, last_error = ?, updated_at = ? WHERE meeting_id = ?")
    .bind(done, missing ? `${missing} chunk(s) had no audio left` : null, isoNow(), meetingId).run();
}

/** The meeting as this pass heard it, one line per turn, with whatever names the owner has given. */
export async function hdTranscript(env: Env, meetingId: string): Promise<{ text: string; perChunk: Map<string, string> }> {
  const run = await readRun(env, meetingId);
  const speakers: Speaker[] = run?.speakers_json ? JSON.parse(run.speakers_json) : [];
  const nameOf = new Map<string, string>();
  for (const speaker of speakers) {
    for (const member of speaker.members) nameOf.set(member, speaker.name?.trim() || speaker.label);
  }
  const chunks = await env.DB.prepare(
    "SELECT id, sequence, hd_json FROM audio_chunks WHERE meeting_id = ? AND hd_json IS NOT NULL ORDER BY sequence"
  ).bind(meetingId).all<{ id: string; sequence: number; hd_json: string }>();

  const perChunk = new Map<string, string>();
  const lines: string[] = [];
  for (const row of chunks.results || []) {
    let utterances: Utterance[] = [];
    try {
      utterances = JSON.parse(row.hd_json) as Utterance[];
    } catch {
      continue;
    }
    const chunkLines = utterances.map((utterance) => {
      const who = nameOf.get(`${row.sequence}:${utterance.speaker}`) || `Speaker ${utterance.speaker + 1}`;
      return `${who}: ${utterance.text}`;
    });
    perChunk.set(row.id, chunkLines.join("\n"));
    lines.push(...chunkLines);
  }
  return { text: lines.join("\n"), perChunk };
}

async function summary(env: Env, meetingId: string) {
  const run = await readRun(env, meetingId);
  const duration = await env.DB.prepare(
    "SELECT COALESCE(SUM(duration_ms), 0) AS ms, COUNT(*) AS chunks FROM audio_chunks WHERE meeting_id = ?"
  ).bind(meetingId).first<{ ms: number; chunks: number }>();
  const minutes = (duration?.ms || 0) / 60000;
  return {
    available: Boolean(hdModel(env)),
    model: hdModel(env),
    status: run?.status ?? "none",
    chunksTotal: run?.chunks_total ?? duration?.chunks ?? 0,
    chunksDone: run?.chunks_done ?? 0,
    speakers: run?.speakers_json ? (JSON.parse(run.speakers_json) as Speaker[]).map(({ members, ...rest }) => rest) : [],
    lastError: run?.last_error ?? null,
    minutes: Math.round(minutes),
    // What this will cost the owner, in their own Cloudflare account, before they agree to it.
    estimatedUsd: Number((minutes * USD_PER_AUDIO_MINUTE).toFixed(2))
  };
}

hdRoutes.get("/meetings/:id/hd", async (c) => c.json({ ok: true, ...(await summary(c.env, c.req.param("id"))) }));

hdRoutes.post("/meetings/:id/hd", async (c) => {
  const meetingId = c.req.param("id");
  if (!hdModel(c.env)) return c.json({ error: "High-definition transcription is switched off for this app" }, 404);
  const meeting = await c.env.DB.prepare("SELECT id, status FROM meetings WHERE id = ?")
    .bind(meetingId).first<{ id: string; status: string }>();
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);
  if (meeting.status === "recording") return c.json({ error: "Stop the recording first" }, 409);

  const existing = await readRun(c.env, meetingId);
  if (existing && (existing.status === "queued" || existing.status === "running")) {
    return c.json({ ok: true, ...(await summary(c.env, meetingId)) });
  }
  const chunks = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM audio_chunks WHERE meeting_id = ?")
    .bind(meetingId).first<{ count: number }>();
  if (!chunks?.count) return c.json({ error: "This meeting has no audio to re-transcribe" }, 409);

  const now = isoNow();
  await c.env.DB.prepare(
    `INSERT INTO hd_runs (meeting_id, status, model, chunks_total, chunks_done, created_at, updated_at)
     VALUES (?, 'queued', ?, ?, 0, ?, ?)
     ON CONFLICT (meeting_id) DO UPDATE SET status = 'queued', model = excluded.model,
       chunks_total = excluded.chunks_total, chunks_done = 0, last_error = NULL, updated_at = excluded.updated_at`
  ).bind(meetingId, hdModel(c.env), chunks.count, now, now).run();
  await c.env.JOBS.send({ type: "hd", meetingId });
  return c.json({ ok: true, ...(await summary(c.env, meetingId)) });
});

/** Names for the voices, and then the note is rebuilt from the transcript that carries them. */
hdRoutes.post("/meetings/:id/hd/speakers", async (c) => {
  const meetingId = c.req.param("id");
  const run = await readRun(c.env, meetingId);
  if (!run?.speakers_json) return c.json({ error: "There are no speakers to name yet" }, 409);
  const body = await c.req.json<{ names?: Record<string, string> }>().catch(() => ({}) as { names?: Record<string, string> });
  const speakers: Speaker[] = JSON.parse(run.speakers_json);
  const named = speakers.map((speaker) => ({
    ...speaker,
    name: (body.names?.[speaker.id] ?? speaker.name ?? "").toString().trim().slice(0, 60) || null
  }));
  await c.env.DB.prepare("UPDATE hd_runs SET speakers_json = ?, updated_at = ? WHERE meeting_id = ?")
    .bind(JSON.stringify(named), isoNow(), meetingId).run();
  return c.json({ ok: true, speakers: named.map(({ members, ...rest }) => rest) });
});

/**
 * Puts this pass's words, with the names, where the note writer reads from. Whisper's own result
 * stays in `transcript_json`, so nothing is lost; the note is then rebuilt by the usual route.
 */
hdRoutes.post("/meetings/:id/hd/apply", async (c) => {
  const meetingId = c.req.param("id");
  const run = await readRun(c.env, meetingId);
  if (run?.status !== "done") return c.json({ error: "The high-definition pass has not finished" }, 409);
  const { perChunk } = await hdTranscript(c.env, meetingId);
  if (!perChunk.size) return c.json({ error: "That pass produced no transcript" }, 409);
  const now = isoNow();
  await c.env.DB.batch([...perChunk].map(([chunkId, text]) =>
    c.env.DB.prepare("UPDATE audio_chunks SET transcript_text = ?, updated_at = ? WHERE id = ?").bind(text, now, chunkId)
  ));
  return c.json({ ok: true, chunks: perChunk.size });
});
