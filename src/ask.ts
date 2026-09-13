import { Hono } from "hono";
import { z } from "zod";
import { isDailyLimitError, modelOptions, modelText, recordUsage, runModel } from "./ai";
import { ownerTimeZone } from "./assistant";
import { utcToLocalParts } from "./calendar";
import { deepSimplify, simplifyEnabled } from "./chinese";
import { searchMemory, type SearchResult } from "./memory";
import { querySignals, type TimeRange } from "./recall";
import { extractJson } from "./summary";
import type { TaskRow } from "./tasks";
import type { Env } from "./types";

// "Ask": questions about the owner's own meetings and plans, answered only from what was
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

/** maxTokens includes any reasoning the model does before answering (glm-4.7-flash thinks first). */
async function runJson(env: Env, model: string, kind: string, messages: Array<{ role: string; content: string }>, schema: object, maxTokens: number): Promise<unknown> {
  const request = { messages, max_tokens: maxTokens, temperature: 0.1, ...modelOptions(model) };
  let result: unknown;
  try {
    result = await runModel(env, model, { ...request, response_format: { type: "json_schema", json_schema: { name: kind, strict: true, schema } } });
  } catch (error) {
    if (isDailyLimitError(error)) throw error;
    result = await runModel(env, model, request);
  }
  await recordUsage(env, null, kind, model, result);
  return extractJson(modelText(result));
}

/** Words to search a bilingual transcript for: the question's names and topics, in both languages. */
async function searchTerms(env: Env, question: string): Promise<string[]> {
  const parsed = await runJson(env, env.SUMMARY_MODEL, "search", [
    { role: "system", content: "You choose keywords for searching meeting transcripts. Output JSON only." },
    {
      role: "user",
      content: `A person asks about their own meetings and plans:\n"""\n${question.slice(0, 500)}\n"""\n\nGive 3 to 8 keywords to search the transcripts with: the names, places, products and topics in the question, each as it would be said, plus its English or Simplified Chinese equivalent. Leave out dates, filler and question words.\nReturn {"terms": ["..."]}`
    }
  ], termsJsonSchema, 800) as { terms?: unknown } | null;
  const terms = Array.isArray(parsed?.terms) ? parsed.terms : [];
  return terms.filter((term): term is string => typeof term === "string").map((term) => term.trim()).filter((term) => term && term.length <= 40).slice(0, 8);
}

const KIND_LABEL: Record<string, string> = {
  transcript: "transcript",
  section: "meeting notes",
  summary: "meeting summary",
  plan: "plan",
  dictation: "said aloud",
  fact: "remembered"
};

function passageLabel(hit: SearchResult, timeZone: string): string {
  const { date } = utcToLocalParts(Date.parse(hit.row.occurred_at), timeZone);
  if (hit.row.kind === "plan") return `plan for ${date}`;
  if (hit.row.meeting_id) return `meeting "${hit.row.title}", ${date}, ${KIND_LABEL[hit.row.kind]}`;
  return `${KIND_LABEL[hit.row.kind] ?? hit.row.kind}, ${date}`;
}

async function plansIn(db: D1Database, range: TimeRange): Promise<TaskRow[]> {
  const from = new Date(range.from).toISOString();
  const to = new Date(range.to).toISOString();
  const { results } = await db.prepare(
    `SELECT * FROM tasks
      WHERE status IN ('confirmed', 'suggested', 'done')
        AND ((starts_at IS NOT NULL AND starts_at >= ? AND starts_at < ?)
          OR (starts_at IS NULL AND due_date >= ? AND due_date < ?))
      ORDER BY due_date, starts_at LIMIT 30`
  ).bind(from, to, from.slice(0, 10), to.slice(0, 10)).all<TaskRow>();
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

  const counts = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM memory_items) AS remembered, (SELECT COUNT(*) FROM meetings) AS meetings"
  ).first<{ remembered: number; meetings: number }>();
  if (!counts?.remembered && counts?.meetings) {
    const { results } = await env.DB.prepare("SELECT id FROM meetings").all<{ id: string }>();
    for (const meeting of results) await env.JOBS.send({ type: "remember", meetingId: meeting.id });
    return c.json({ ok: true, answer: "Your earlier meetings are being made searchable. Ask again in a minute.", sources: [], preparing: true });
  }

  let terms: string[];
  try {
    terms = await searchTerms(env, signals.cleaned || question);
  } catch (error) {
    if (isDailyLimitError(error)) return c.json({ ok: false, error: "Today's free AI allowance is used up. It comes back at 00:00 UTC." }, 429);
    console.error("Search terms failed; using the question's own words", error);
    terms = [];
  }
  if (!terms.length) terms = [...signals.tags, ...signals.cleaned.split(/\s+/)];

  const hits = await searchMemory(env.DB, { terms, range: signals.range, limit: MAX_PASSAGES });
  const plans = signals.range ? await plansIn(env.DB, signals.range) : [];
  if (!hits.length && !plans.length) {
    return c.json({ ok: true, answer: "I couldn't find anything about that in your meetings or plans.", sources: [], searched: terms });
  }

  const local = utcToLocalParts(now, timeZone);
  const passages = hits.map((hit, index) => `[${index + 1}] (${passageLabel(hit, timeZone)})\n${hit.row.text.slice(0, 900)}`).join("\n\n");
  const planLines = plans.map((task) => {
    const when = task.starts_at ? `${utcToLocalParts(Date.parse(task.starts_at), task.timezone).date} ${utcToLocalParts(Date.parse(task.starts_at), task.timezone).time}` : task.due_date;
    return `- ${task.title} (${when}${task.status === "suggested" ? ", not yet confirmed" : task.status === "done" ? ", done" : ""})`;
  }).join("\n");

  let answer: { answer?: unknown; sources?: unknown } | null;
  try {
    answer = await runJson(env, askModel(env), "ask", [
      {
        role: "system",
        content: "You answer questions about the user's own meetings and plans using only the numbered passages and plan list. Cite the passages you used like [2]. If they don't contain the answer, say so plainly instead of guessing. Answer in the language of the question; for Chinese, use Simplified Chinese. Be brief. Output JSON only."
      },
      {
        role: "user",
        content: `Now: ${local.date} ${local.time} (${timeZone}).\nQuestion: ${question}\n\nPassages:\n${passages || "(none)"}${planLines ? `\n\nPlans in that period:\n${planLines}` : ""}\n\nReturn {"answer": "...", "sources": [passage numbers used]}`
      }
    ], answerJsonSchema, 2000) as typeof answer;
  } catch (error) {
    if (isDailyLimitError(error)) return c.json({ ok: false, error: "Today's free AI allowance is used up. It comes back at 00:00 UTC." }, 429);
    throw error;
  }

  const text = typeof answer?.answer === "string" && answer.answer.trim() ? answer.answer.trim() : "I couldn't put an answer together from what was found.";
  const cited = Array.isArray(answer?.sources)
    ? [...new Set(answer.sources.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= hits.length))]
    : [];
  const shown = cited.length ? cited : hits.slice(0, 3).map((_, index) => index + 1);

  return c.json({
    ok: true,
    answer: simplifyEnabled(env.CHINESE_SCRIPT) ? deepSimplify(text) : text,
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

/** Makes every meeting searchable again, in the background. */
askRoutes.post("/memory/rebuild", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id FROM meetings").all<{ id: string }>();
  for (const meeting of results) await c.env.JOBS.send({ type: "remember", meetingId: meeting.id });
  return c.json({ ok: true, meetings: results.length });
});
