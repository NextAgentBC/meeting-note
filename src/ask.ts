import { Hono } from "hono";
import { z } from "zod";
import { isDailyLimitError, modelOptions, modelText, parseModelJson, recordUsage, runModel } from "./ai";
import { archiveBacklog } from "./audio";
import { embedBacklog } from "./embed";
import { getSetting, ownerTimeZone, setSetting } from "./settings";
import { utcToLocalParts } from "./calendar";
import { deepSimplify, simplifyEnabled } from "./chinese";
import { searchMemory, type SearchResult } from "./memory";
import { querySignals, type TimeRange } from "./recall";
import type { TaskRow } from "./tasks";
import type { JobMessage } from "./types";
import type { Env } from "./types";

// "Ask": questions about the owner's own meetings, quick notes and plans, answered only from what was
// recorded, with the passages it used. One small model call picks search words, D1 finds the
// passages, and one call writes the answer.

export const askRoutes = new Hono<{ Bindings: Env }>();

const MAX_PASSAGES = 10;

export function askModel(env: Env): string {
  return env.ASK_MODEL || env.FINAL_MODEL || env.SUMMARY_MODEL;
}

const termsJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { terms: { type: "array", items: { type: "string" } } },
  required: ["terms"]
} as const;

const answerJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { answer: { type: "string" }, sources: { type: "array", items: { type: "integer" } } },
  required: ["answer", "sources"]
} as const;

/**
 * Asks for JSON and returns it parsed, with the raw text for when it isn't JSON after all (a model
 * that rejects the schema and is asked again without one may just write prose).
 * maxTokens includes any reasoning the model does before answering.
 */
async function runJson(env: Env, model: string, kind: string, messages: Array<{ role: string; content: string }>, schema: object, maxTokens: number): Promise<{ parsed: unknown; text: string }> {
  const request = { messages, max_tokens: maxTokens, temperature: 0.1, ...modelOptions(model) };
  let result: unknown;
  try {
    result = await runModel(env, model, { ...request, response_format: { type: "json_schema", json_schema: { name: kind, strict: true, schema } } });
  } catch (error) {
    if (isDailyLimitError(error)) throw error;
    result = await runModel(env, model, request);
  }
  await recordUsage(env, null, kind, model, result);
  const text = modelText(result);
  try {
    return { parsed: parseModelJson(text), text };
  } catch {
    return { parsed: null, text };
  }
}

/** Words to search a bilingual transcript for: the question's names and topics, in both languages. */
async function searchTerms(env: Env, question: string): Promise<string[]> {
  const parsed = await runJson(env, env.SUMMARY_MODEL, "search", [
    { role: "system", content: "You choose keywords for searching meeting transcripts. Output JSON only." },
    {
      role: "user",
      content: `A person asks about their own meetings, quick notes, photos and plans:\n"""\n${question.slice(0, 500)}\n"""\n\nThe saved material mixes Chinese and English. Give 4 to 10 short search words: the names, places, things and topics in the question, each in English AND in Simplified Chinese. Use single words, not phrases: for Chinese, mostly two-character words (海报, 场地, 预算). Leave out dates, filler and question words.\nReturn {"terms": ["..."]}`
    }
  ], termsJsonSchema, 800);
  const found = parsed.parsed as { terms?: unknown } | null;
  const terms = Array.isArray(found?.terms) ? found.terms : [];
  return terms.filter((term): term is string => typeof term === "string").map((term) => term.trim()).filter((term) => term && term.length <= 40).slice(0, 10);
}

const KIND_LABEL: Record<string, string> = {
  transcript: "transcript",
  section: "meeting notes",
  summary: "meeting summary",
  plan: "plan",
  dictation: "said aloud",
  fact: "remembered",
  capture: "quick note"
};

function passageLabel(hit: SearchResult, timeZone: string): string {
  const { date } = utcToLocalParts(Date.parse(hit.row.occurred_at), timeZone);
  if (hit.row.kind === "plan") return `plan for ${date}`;
  if (hit.row.meeting_id) return `meeting "${hit.row.title}", ${date}, ${KIND_LABEL[hit.row.kind]}`;
  return `${KIND_LABEL[hit.row.kind] ?? hit.row.kind}, ${date}`;
}

/** Passages are often in the other language, and models drift towards it; so say which one. */
export function answerLanguage(question: string): string {
  return /[\u3400-\u9fff]/.test(question) ? "用简体中文回答。" : "Answer in English, even where the passages are in Chinese.";
}

/**
 * The plans falling in a range. Timed plans compare as instants; all-day plans by date as the owner
 * counts dates: in Shanghai, "tomorrow" starts at 16:00 UTC today, so UTC dates would pick today.
 */
export function localDateWindow(range: TimeRange, timeZone: string): { from: string; to: string } {
  return { from: utcToLocalParts(range.from, timeZone).date, to: utcToLocalParts(range.to, timeZone).date };
}

async function plansIn(db: D1Database, range: TimeRange, timeZone: string): Promise<TaskRow[]> {
  const from = new Date(range.from).toISOString();
  const to = new Date(range.to).toISOString();
  const days = localDateWindow(range, timeZone);
  const { results } = await db.prepare(
    `SELECT * FROM tasks
      WHERE status IN ('confirmed', 'suggested', 'done')
        AND ((starts_at IS NOT NULL AND starts_at >= ? AND starts_at < ?)
          OR (starts_at IS NULL AND due_date >= ? AND due_date < ?))
      ORDER BY due_date, starts_at LIMIT 30`
  ).bind(from, to, days.from, days.to).all<TaskRow>();
  return results;
}

askRoutes.post("/ask", async (c) => {
  const parsed = z.object({ question: z.string().trim().min(2).max(500) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: "Ask a question in a few words." }, 400);
  const question = parsed.data.question;
  const env = c.env;
  const now = Date.now();
  const timeZone = await ownerTimeZone(env, c.req.header("x-timezone"));
  const signals = querySignals(question, now, timeZone);

  const catchingUp = await catchUpMemory(env);
  const catchUpNote = catchingUp ? " (Older meetings are still being added; ask again in a minute if something is missing.)" : "";

  let terms: string[];
  try {
    terms = await searchTerms(env, signals.cleaned || question);
  } catch (error) {
    if (isDailyLimitError(error)) return c.json({ ok: false, error: "Today's free AI allowance is used up. It comes back at 00:00 UTC." }, 429);
    console.error("Search terms failed; using the question's own words", error);
    terms = [];
  }
  if (!terms.length) terms = [...signals.tags, ...signals.cleaned.split(/\s+/)];

  const hits = await searchMemory(env, { terms, text: question, range: signals.range, limit: MAX_PASSAGES });
  const plans = signals.range ? await plansIn(env.DB, signals.range, timeZone) : [];
  if (!hits.length && !plans.length) {
    return c.json({ ok: true, answer: `I couldn't find anything about that in your meetings or plans.${catchUpNote}`, sources: [], searched: terms });
  }

  const local = utcToLocalParts(now, timeZone);
  const passages = hits.map((hit, index) => `[${index + 1}] (${passageLabel(hit, timeZone)})\n${hit.row.text.slice(0, 900)}`).join("\n\n");
  const planLines = plans.map((task) => {
    const when = task.starts_at ? `${utcToLocalParts(Date.parse(task.starts_at), task.timezone).date} ${utcToLocalParts(Date.parse(task.starts_at), task.timezone).time}` : task.due_date;
    return `- ${task.title} (${when}${task.status === "suggested" ? ", not yet confirmed" : task.status === "done" ? ", done" : ""})`;
  }).join("\n");

  let reply: { parsed: unknown; text: string };
  try {
    reply = await runJson(env, askModel(env), "ask", [
      {
        role: "system",
        content: "You answer questions about the user's own meetings, quick notes, photos and plans using only the numbered passages and plan list. Cite the passages you used like [2]. If they don't contain the answer, say so plainly instead of guessing. Answer in the language of the question; for Chinese, use Simplified Chinese. Be brief. Output JSON only."
      },
      {
        role: "user",
        content: `Now: ${local.date} ${local.time} (${timeZone}).\nQuestion: ${question}\n\nPassages:\n${passages || "(none)"}${planLines ? `\n\nPlans in that period:\n${planLines}` : ""}\n\n${answerLanguage(question)}\nReturn {"answer": "...", "sources": [passage numbers used]}`
      }
    ], answerJsonSchema, 2000);
  } catch (error) {
    if (isDailyLimitError(error)) return c.json({ ok: false, error: "Today's free AI allowance is used up. It comes back at 00:00 UTC." }, 429);
    throw error;
  }

  const answer = reply.parsed as { answer?: unknown; sources?: unknown } | null;
  // Prose instead of JSON still answers the question; its [n] markers say which passages it used.
  const prose = reply.text.trim().startsWith("{") ? "" : reply.text.trim();
  const text = typeof answer?.answer === "string" && answer.answer.trim()
    ? answer.answer.trim()
    : prose.slice(0, 2000) || "I couldn't put an answer together from what was found.";
  const numbers = Array.isArray(answer?.sources) ? answer.sources.map(Number) : [...text.matchAll(/\[(\d{1,2})\]/g)].map((match) => Number(match[1]));
  const cited = [...new Set(numbers.filter((n) => Number.isInteger(n) && n >= 1 && n <= hits.length))];
  const shown = cited.length ? cited : hits.slice(0, 3).map((_, index) => index + 1);

  return c.json({
    ok: true,
    answer: `${simplifyEnabled(env.CHINESE_SCRIPT) ? deepSimplify(text) : text}${catchUpNote}`,
    sources: shown.map((n) => {
      const hit = hits[n - 1];
      return {
        n,
        kind: hit.row.kind,
        title: hit.row.title,
        meetingId: hit.row.meeting_id,
        chunkSequence: hit.row.chunk_sequence,
        occurredAt: hit.row.occurred_at,
        snippet: hit.row.text.slice(0, 240)
      };
    }),
    plans: plans.length,
    searched: terms
  });
});

async function queueRemember(env: Env, meetingIds: string[]): Promise<void> {
  for (let start = 0; start < meetingIds.length; start += 100) {
    await env.JOBS.sendBatch(meetingIds.slice(start, start + 100).map((meetingId) => ({ body: { type: "remember", meetingId } satisfies JobMessage })));
  }
}

/**
 * Meetings recorded before memory existed, copied in once, in the background. The marker is written
 * only after every job is queued, so a failed send is simply tried again next time. Also catches up
 * embedding (its own, separate once-only marker — see embedBacklog), so a copy that only gets
 * MEMORY_VECTORS bound later still backfills its existing memory.
 */
export async function catchUpMemory(env: Env): Promise<boolean> {
  let queued = false;
  if (!(await getSetting(env.DB, "memory_backfill_queued_at"))) {
    const { results } = await env.DB.prepare(
      "SELECT id FROM meetings m WHERE NOT EXISTS (SELECT 1 FROM memory_items i WHERE i.meeting_id = m.id) ORDER BY created_at DESC LIMIT 1000"
    ).all<{ id: string }>();
    await queueRemember(env, results.map((row) => row.id));
    await setSetting(env.DB, "memory_backfill_queued_at", new Date().toISOString());
    queued = results.length > 0;
  }
  if (await embedBacklog(env)) queued = true;
  // Same once-only pattern: audio recorded before the RECORDINGS bucket was bound gets its permanent copy.
  if (await archiveBacklog(env)) queued = true;
  return queued;
}

/** Called when the app opens, so older meetings are searchable before the first question. */
askRoutes.post("/memory/catch-up", async (c) => c.json({ ok: true, queued: await catchUpMemory(c.env) }));

/**
 * Rebuilds the search index from memory_items (after restoring a database, say: the index is a
 * virtual table that exports don't carry) and remembers every meeting again, in the background.
 */
askRoutes.post("/memory/rebuild", async (c) => {
  await c.env.DB.prepare("INSERT INTO memory_fts (memory_fts) VALUES ('rebuild')").run();
  const { results } = await c.env.DB.prepare("SELECT id FROM meetings").all<{ id: string }>();
  await queueRemember(c.env, results.map((row) => row.id));
  return c.json({ ok: true, meetings: results.length });
});
