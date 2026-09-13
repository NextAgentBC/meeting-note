import { modelOptions, modelText, parseModelJson, recordUsage, runModel } from "./ai";
import { utcToLocalParts } from "./calendar";
import { queueEmbed } from "./embed";
import { upsertMemory, type MemoryItem } from "./memory";
import { ownerTimeZone } from "./settings";
import { languageInstruction, noteLanguage } from "./summary";
import type { Env, JobMessage } from "./types";

// Durable facts ("长期事实记忆"): after a meeting's note is written, one extra model call looks for
// the kind of thing worth knowing in a later, unrelated meeting — hours, prices, policies, roles,
// standing venues, preferences, recurring commitments — as distinct from that meeting's one-off
// to-dos or the fact that a decision happened at all. A fact that updates an earlier one on the
// same topic supersedes it rather than replacing it, so the history stays (see memory_items.
// superseded_by, which mergeHits already penalises).
//
// This runs as its own queue job, after the note: a failure here must never affect the note.

export const factsJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          topic: { type: "string", description: "A short, stable 2-4 word label such as 'clinic hours' or 'workshop venue', reusable to look this fact up later" },
          statement: { type: "string" }
        },
        required: ["topic", "statement"]
      }
    }
  },
  required: ["facts"]
} as const;

export interface FactCandidate {
  topic: string;
  statement: string;
}

const FACTS_SYSTEM_PROMPT = "You extract durable facts worth remembering across future meetings from a transcript. You only report what the transcript supports. Output JSON only.";

export function factsUserPrompt(meeting: { title: string; language: string }, transcriptText: string, localDate: string, timeZone: string): string {
  const language = noteLanguage(transcriptText, meeting.language);
  return `Meeting title: ${meeting.title}\nMeeting started: ${localDate} in time zone ${timeZone}\n\nExtract durable facts about the business or project that would still be useful to know in a later, unrelated meeting: hours, prices, policies, team roles, standing venues, ongoing costs or splits, recurring commitments.

Rules:
- Do NOT extract one-off action items (someone doing something by a deadline) — those belong to a different part of this system.
- Do NOT extract "a decision was made" as the fact. Extract the resulting policy or state itself (for example, not "the team decided on Saturday hours" but "clinic is open Saturdays 9am-1pm starting [date]").
- Each fact needs a short, stable topic label (2-4 words) that could be reused to look this fact up later, and one grounded statement in a single sentence.
- Never list the same topic twice. If the transcript updates a fact partway through, keep only the final, current value.
- Correct obvious ASR mishearings of product names in your output (keep verbatim quotes as heard): "cloud flyer" / "chat GDP" / "chatsdp" -> the speakers mean "Cloudflare" and "ChatGPT". Treat other unclear or nonsensical phrases as uncertain and omit them; never invent a meaning for them.
${languageInstruction(language)}
- Never state a fact the transcript does not support. If nothing durable was said, return an empty facts array.

FULL ORIGINAL TRANSCRIPT
${transcriptText}`;
}

/** Collapses case, spacing and punctuation, so "Clinic Hours" and "clinic-hours" count as one topic. */
export function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase().replace(/[\s\p{P}]+/gu, " ").trim();
}

export interface CurrentFact {
  id: string;
  /** Its statement, without the "From: ..." line, when known: an identical new one isn't a new version. */
  statement?: string;
}

/** A short, stable key for a normalised topic (FNV-1a), so a rebuilt note rewrites the same fact row. */
export function topicKey(normalizedTopic: string): string {
  let hash = 0x811c9dc5;
  for (const character of normalizedTopic) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const sameStatement = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

export interface FactPlanItem {
  id: string;
  topic: string;
  statement: string;
  /** The current fact row — from this meeting or any earlier one — that this one replaces. */
  supersedes: string | null;
}

/**
 * What to write for one meeting's extracted facts: at most one row per normalised topic (the
 * model is told never to repeat a topic, but a later candidate still wins if it does), each
 * pointed at whichever current fact shares its topic, so runFacts can supersede it.
 */
export function planFacts(
  candidates: readonly FactCandidate[],
  currentByTopic: ReadonlyMap<string, CurrentFact>,
  newId: (index: number, normalizedTopic: string) => string
): FactPlanItem[] {
  const byTopic = new Map<string, FactCandidate>();
  for (const candidate of candidates) {
    const topic = candidate.topic?.trim();
    const statement = candidate.statement?.trim();
    if (!topic || !statement) continue;
    byTopic.set(normalizeTopic(topic), { topic, statement });
  }
  return [...byTopic.entries()].flatMap(([normalized, candidate], index): FactPlanItem[] => {
    const id = newId(index, normalized);
    const current = currentByTopic.get(normalized);
    // Saying the same thing again (or rebuilding the same note) isn't a new version of the fact.
    if (current?.statement !== undefined && sameStatement(current.statement, candidate.statement)) return [];
    return [{
      id,
      topic: candidate.topic,
      statement: candidate.statement,
      // A rebuilt note rewrites its own row in place; it must never mark that row superseded by itself.
      supersedes: current && current.id !== id ? current.id : null
    }];
  });
}

/** The stored text: the statement plus where it came from, so a passage found on its own still says. */
export function factText(statement: string, meetingTitle: string, localDate: string): string {
  return `${statement}\nFrom: ${meetingTitle}, ${localDate}`;
}

/** The statement alone, without the "From: ..." line factText appends. */
export function factStatement(text: string): string {
  return text.replace(/\nFrom: [^\n]*$/, "");
}

export async function queueFacts(env: Env, meetingId: string): Promise<void> {
  await env.JOBS.send({ type: "facts", meetingId } satisfies JobMessage);
}

function isFactCandidate(value: unknown): value is FactCandidate {
  return Boolean(value) && typeof value === "object"
    && typeof (value as FactCandidate).topic === "string"
    && typeof (value as FactCandidate).statement === "string";
}

/**
 * The `{ type: "facts", meetingId }` job: one model call over the whole transcript, then an
 * upsert per fact, each optionally superseding a current fact on the same topic.
 */
export async function runFacts(env: Env, meetingId: string): Promise<void> {
  const meeting = await env.DB.prepare("SELECT id, title, started_at, language FROM meetings WHERE id = ?")
    .bind(meetingId).first<{ id: string; title: string; started_at: string; language: string }>();
  if (!meeting) return;

  const chunks = await env.DB.prepare(
    "SELECT transcript_text FROM audio_chunks WHERE meeting_id = ? AND status = 'done' ORDER BY sequence"
  ).bind(meetingId).all<{ transcript_text: string | null }>();
  const transcriptText = chunks.results.map((row) => row.transcript_text || "").join("\n").trim();
  if (!transcriptText) return;

  const timeZone = await ownerTimeZone(env);
  const localDate = utcToLocalParts(Date.parse(meeting.started_at) || Date.now(), timeZone).date;
  const model = env.SUMMARY_MODEL;
  const messages = [
    { role: "system", content: FACTS_SYSTEM_PROMPT },
    { role: "user", content: factsUserPrompt(meeting, transcriptText, localDate, timeZone) }
  ];
  const request = { messages, max_tokens: 1200, temperature: 0.1, ...modelOptions(model) };

  let result: unknown;
  try {
    result = await runModel(env, model, { ...request, response_format: { type: "json_schema", json_schema: { name: "facts", strict: true, schema: factsJsonSchema } } });
  } catch {
    result = await runModel(env, model, request);
  }
  await recordUsage(env, meetingId, "facts", model, result);

  let candidates: FactCandidate[] = [];
  try {
    const parsed = parseModelJson(modelText(result)) as { facts?: unknown } | null;
    if (Array.isArray(parsed?.facts)) candidates = parsed.facts.filter(isFactCandidate);
  } catch (error) {
    console.error("Facts: could not parse the model's output", error);
    return;
  }
  if (!candidates.length) return;

  const current = await env.DB.prepare("SELECT id, title, text FROM memory_items WHERE kind = 'fact' AND superseded_by IS NULL")
    .all<{ id: string; title: string; text: string }>();
  const currentByTopic = new Map(current.results.map((row) => [normalizeTopic(row.title), { id: row.id, statement: factStatement(row.text) }]));

  const plan = planFacts(candidates, currentByTopic, (_index, normalized) => `fact:${meetingId}:${topicKey(normalized)}`);
  if (!plan.length) return;

  const now = new Date().toISOString();
  const statements = plan.flatMap((item): D1PreparedStatement[] => {
    const fact: MemoryItem = {
      id: item.id,
      kind: "fact",
      sourceId: `facts:${meetingId}`,
      meetingId,
      chunkSequence: null,
      title: item.topic.slice(0, 120),
      text: factText(item.statement, meeting.title, localDate).slice(0, 2000),
      occurredAt: meeting.started_at
    };
    const insert = upsertMemory(env.DB, fact);
    return item.supersedes
      ? [insert, env.DB.prepare("UPDATE memory_items SET superseded_by = ?, updated_at = ? WHERE id = ?").bind(item.id, now, item.supersedes)]
      : [insert];
  });
  await env.DB.batch(statements);
  await queueEmbed(env, plan.map((item) => item.id));
}
