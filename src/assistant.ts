import { Hono, type Context } from "hono";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { isDailyLimitError, modelOptions, modelText, recordUsage, runModel } from "./ai";
import { sha256Hex } from "./auth";
import { buildEventIcs, buildFeedIcs, icsFilename, type CalendarTask } from "./calendar";
import { deepSimplify, simplifyEnabled, toSimplified } from "./chinese";
import { dictationItem, planItem, rememberSource, safely } from "./memory";
import { resolveDatePhrase } from "./dates";
import { DICTATION_TRANSCRIBE_PROMPT, normalizePlan, planJsonSchema, planPrompt, type PlanDraft } from "./plans";
import { extractJson } from "./summary";
import { cleanDate, cleanTime, scheduleFor, taskView, toCalendarTask, validTimeZone, type TaskRow } from "./tasks";
import type { Env } from "./types";

// Plans and to-dos: say them, confirm them, and put them on a calendar. There is no calendar
// login to set up: each plan gets an "add to Google Calendar" link and an .ics file, and the
// owner can subscribe once to a private feed of everything they have confirmed.

type AppContext = Context<{ Bindings: Env }>;

const TIMEZONE_KEY = "timezone";
const FEED_TOKEN_KEY = "calendar_feed_token";
const MAX_DICTATION_BYTES = 8 * 1024 * 1024;
const MAX_DICTATION_MS = 3 * 60_000;
/** A subscribed calendar keeps hearing about a cancelled plan for this long, so it removes it. */
const CANCELLED_FEED_DAYS = 30;

export const assistantRoutes = new Hono<{ Bindings: Env }>();

function isoNow(): string {
  return new Date().toISOString();
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function jsonError(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/** Plans need a model that is good with dates; it runs once per dictation, so it can be a stronger one. */
export function planModel(env: Env): string {
  return env.PLAN_MODEL || env.FINAL_MODEL || env.SUMMARY_MODEL;
}

async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(key, value, isoNow()).run();
}

/** The owner's time zone: whatever their browser last said, remembered for background jobs. */
export async function ownerTimeZone(env: Env, fromBrowser?: string | null): Promise<string> {
  const stored = await getSetting(env.DB, TIMEZONE_KEY);
  const browser = validTimeZone(fromBrowser);
  if (browser) {
    if (browser !== stored) await setSetting(env.DB, TIMEZONE_KEY, browser);
    return browser;
  }
  return validTimeZone(stored) ?? "UTC";
}

async function findTask(db: D1Database, id: string): Promise<TaskRow | null> {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<TaskRow>();
}

function insertTask(db: D1Database, row: TaskRow): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO tasks
       (id, title, notes, kind, status, all_day, due_date, starts_at, ends_at, timezone, repeat_hint, assignee,
        source, dictation_id, meeting_id, segment_seq, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    row.id, row.title, row.notes, row.kind, row.status, row.all_day, row.due_date, row.starts_at, row.ends_at, row.timezone,
    row.repeat_hint, row.assignee, row.source, row.dictation_id, row.meeting_id, row.segment_seq, row.created_at, row.updated_at
  );
}

function draftToRow(draft: PlanDraft, extra: Pick<TaskRow, "timezone" | "source" | "dictation_id">): TaskRow {
  const now = isoNow();
  return {
    id: crypto.randomUUID(),
    title: draft.title,
    notes: draft.notes,
    kind: draft.kind,
    status: "suggested",
    all_day: draft.all_day,
    due_date: draft.due_date,
    starts_at: draft.starts_at,
    ends_at: draft.ends_at,
    repeat_hint: draft.repeat_hint,
    assignee: "",
    meeting_id: null,
    segment_seq: null,
    created_at: now,
    updated_at: now,
    ...extra
  };
}

/** Plans are remembered once confirmed; a suggestion or a cancelled plan is forgotten. */
async function rememberPlan(db: D1Database, row: TaskRow): Promise<void> {
  await safely("remember a plan", () => rememberSource(db, row.id, row.status === "confirmed" || row.status === "done" ? [planItem(row)] : []));
}

function calendarTaskWithLink(c: AppContext, row: TaskRow): CalendarTask | null {
  const calendar = toCalendarTask(row);
  return calendar ? { ...calendar, url: new URL(c.req.url).origin } : null;
}

// ── Tasks ────────────────────────────────────────────────────────────────────

assistantRoutes.get("/tasks", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.*, m.title AS meeting_title FROM tasks t LEFT JOIN meetings m ON m.id = t.meeting_id
      WHERE t.status IN ('suggested', 'confirmed') OR (t.status = 'done' AND t.updated_at > ?)
      ORDER BY CASE t.status WHEN 'suggested' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END,
               t.due_date IS NULL, t.due_date, t.starts_at, t.created_at
      LIMIT 300`
  ).bind(isoDaysAgo(14)).all<TaskRow>();
  return c.json({ ok: true, tasks: results.map(taskView) });
});

const taskFields = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(2000),
  kind: z.enum(["task", "event"]),
  status: z.enum(["suggested", "confirmed", "done", "cancelled"]),
  date: z.string().max(10).nullable(),
  time: z.string().max(8).nullable(),
  durationMinutes: z.number().int().min(5).max(1440).nullable(),
  timezone: z.string().max(64)
});

function readDateAndTime(body: { date?: string | null; time?: string | null }) {
  const date = body.date ? cleanDate(body.date) : null;
  if (body.date && !date) return { error: "Give the date as YYYY-MM-DD." };
  const time = body.time ? cleanTime(body.time) : null;
  if (body.time && !time) return { error: "Give the time as HH:MM." };
  return { date, time };
}

assistantRoutes.post("/tasks", async (c) => {
  const parsed = taskFields.partial({ notes: true, kind: true, status: true, date: true, time: true, durationMinutes: true, timezone: true })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid plan");
  const body = parsed.data;
  const when = readDateAndTime(body);
  if ("error" in when) return jsonError(when.error!);

  const timeZone = await ownerTimeZone(c.env, body.timezone ?? c.req.header("x-timezone"));
  const kind = body.kind ?? (when.time ? "event" : "task");
  const now = isoNow();
  const row: TaskRow = {
    id: crypto.randomUUID(),
    title: body.title,
    notes: body.notes ?? "",
    kind,
    status: body.status ?? "confirmed",
    ...scheduleFor({ date: when.date, time: when.time, durationMinutes: body.durationMinutes, kind, timeZone, now: Date.now() }),
    timezone: timeZone,
    repeat_hint: "",
    assignee: "",
    source: "manual",
    dictation_id: null,
    meeting_id: null,
    segment_seq: null,
    created_at: now,
    updated_at: now
  };
  await insertTask(c.env.DB, row).run();
  await rememberPlan(c.env.DB, row);
  return c.json({ ok: true, task: taskView(row) }, 201);
});

assistantRoutes.post("/tasks/confirm", async (c) => {
  const parsed = z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(50) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError("Choose which plans to add");
  const now = isoNow();
  await c.env.DB.batch(parsed.data.ids.map((id) =>
    c.env.DB.prepare("UPDATE tasks SET status = 'confirmed', updated_at = ? WHERE id = ? AND status = 'suggested'").bind(now, id)
  ));
  const placeholders = parsed.data.ids.map(() => "?").join(", ");
  const { results } = await c.env.DB.prepare(`SELECT * FROM tasks WHERE id IN (${placeholders})`).bind(...parsed.data.ids).all<TaskRow>();
  for (const row of results) await rememberPlan(c.env.DB, row);
  return c.json({ ok: true, tasks: results.map(taskView) });
});

assistantRoutes.patch("/tasks/:id", async (c) => {
  const row = await findTask(c.env.DB, c.req.param("id"));
  if (!row) return jsonError("That plan no longer exists", 404);
  const parsed = taskFields.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid change");
  const body = parsed.data;

  const next: TaskRow = { ...row };
  if (body.title !== undefined) next.title = body.title;
  if (body.notes !== undefined) next.notes = body.notes;
  if (body.kind !== undefined) next.kind = body.kind;
  if (body.status !== undefined) next.status = body.status;

  if (body.date !== undefined || body.time !== undefined || body.durationMinutes !== undefined || body.timezone !== undefined) {
    const current = taskView(row);
    const when = readDateAndTime({
      date: body.date !== undefined ? body.date : current.date,
      time: body.time !== undefined ? body.time : current.time
    });
    if ("error" in when) return jsonError(when.error!);
    const timeZone = validTimeZone(body.timezone) ?? row.timezone;
    Object.assign(next, scheduleFor({
      date: when.date,
      time: when.time,
      durationMinutes: body.durationMinutes !== undefined ? body.durationMinutes : current.durationMinutes,
      kind: next.kind,
      timeZone,
      now: Date.now()
    }), { timezone: timeZone });
  }
  next.updated_at = isoNow();

  await c.env.DB.prepare(
    `UPDATE tasks SET title = ?, notes = ?, kind = ?, status = ?, all_day = ?, due_date = ?, starts_at = ?, ends_at = ?,
       timezone = ?, updated_at = ? WHERE id = ?`
  ).bind(next.title, next.notes, next.kind, next.status, next.all_day, next.due_date, next.starts_at, next.ends_at, next.timezone, next.updated_at, row.id).run();
  await rememberPlan(c.env.DB, next);
  return c.json({ ok: true, task: taskView(next) });
});

/** A suggestion is simply dropped; anything confirmed is marked cancelled so subscribed calendars remove it. */
assistantRoutes.delete("/tasks/:id", async (c) => {
  const row = await findTask(c.env.DB, c.req.param("id"));
  if (!row) return c.json({ ok: true, removed: "already_gone" });
  await safely("forget a plan", () => rememberSource(c.env.DB, row.id, []));
  if (row.status === "suggested") {
    await c.env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(row.id).run();
    return c.json({ ok: true, removed: "deleted" });
  }
  await c.env.DB.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?").bind(isoNow(), row.id).run();
  return c.json({ ok: true, removed: "cancelled" });
});

assistantRoutes.get("/tasks/:id/event.ics", async (c) => {
  const row = await findTask(c.env.DB, c.req.param("id"));
  if (!row) return jsonError("That plan no longer exists", 404);
  const calendar = calendarTaskWithLink(c, row);
  if (!calendar) return jsonError("Give this plan a date first", 409);
  return new Response(buildEventIcs(calendar, { domain: new URL(c.req.url).hostname }), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      // inline: iPhone and Mac open it straight into Calendar; other browsers download it.
      "content-disposition": `inline; filename="${icsFilename(calendar)}"`,
      "cache-control": "no-store"
    }
  });
});

/**
 * A finished meeting's to-dos, offered as suggestions. Dates come from the words in the note
 * ("下周二之前", "by Friday"), counted from the day of the meeting. Each to-do is suggested once per
 * meeting: its id comes from the meeting and the wording, so a rebuilt note doesn't repeat it or
 * undo an edit.
 */
export async function suggestTasksFromMeeting(
  env: Env,
  meeting: { id: string; started_at: string },
  items: Array<{ task: string; owner: string; due: string }>
): Promise<void> {
  const timeZone = await ownerTimeZone(env);
  const meetingTime = Date.parse(meeting.started_at) || Date.now();
  const now = isoNow();
  const statements: D1PreparedStatement[] = [];
  for (const item of items.slice(0, 30)) {
    const title = item.task.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!title) continue;
    const id = `meeting-${(await sha256Hex(`${meeting.id}|${title.toLowerCase()}`)).slice(0, 24)}`;
    const due = item.due?.trim() ?? "";
    const time = /(\d{1,2}):(\d{2})/.exec(due);
    const schedule = scheduleFor({
      date: due ? resolveDatePhrase(due, meetingTime, timeZone) ?? cleanDate(due.slice(0, 10)) : null,
      time: time ? cleanTime(time[0]) : null,
      kind: time ? "event" : "task",
      timeZone,
      now: meetingTime
    });
    const assignee = item.owner && !/^(unassigned|无|none|n\/a|全体.*)$/i.test(item.owner.trim()) ? item.owner.trim().slice(0, 80) : "";
    statements.push(env.DB.prepare(
      `INSERT INTO tasks
         (id, title, notes, kind, status, all_day, due_date, starts_at, ends_at, timezone, repeat_hint, assignee,
          source, dictation_id, meeting_id, segment_seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'suggested', ?, ?, ?, ?, ?, '', ?, 'meeting', NULL, ?, NULL, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(id, title, due && !schedule.due_date ? `Due: ${due}` : "", time ? "event" : "task", schedule.all_day, schedule.due_date,
      schedule.starts_at, schedule.ends_at, timeZone, assignee, meeting.id, now, now));
  }
  if (statements.length) await env.DB.batch(statements);
}

// ── Calendar feed and settings ───────────────────────────────────────────────

function feedUrl(c: AppContext, token: string): string {
  return `${new URL(c.req.url).origin}/cal/${token}.ics`;
}

assistantRoutes.get("/calendar", async (c) => {
  const token = await getSetting(c.env.DB, FEED_TOKEN_KEY);
  return c.json({ ok: true, timezone: await ownerTimeZone(c.env, c.req.header("x-timezone")), feedUrl: token ? feedUrl(c, token) : null });
});

/** Creates the private feed address, or replaces it: the old address stops working. */
assistantRoutes.post("/calendar/feed", async (c) => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Buffer.from(bytes).toString("base64url");
  await setSetting(c.env.DB, FEED_TOKEN_KEY, token);
  return c.json({ ok: true, feedUrl: feedUrl(c, token) });
});

assistantRoutes.put("/settings/timezone", async (c) => {
  const body = await c.req.json().catch(() => null) as { timezone?: unknown } | null;
  const timeZone = validTimeZone(body?.timezone);
  if (!timeZone) return jsonError("Unknown time zone");
  await setSetting(c.env.DB, TIMEZONE_KEY, timeZone);
  return c.json({ ok: true, timezone: timeZone });
});

/**
 * GET /cal/<token>.ics: everything confirmed, for calendar apps to subscribe to. Calendar apps
 * can't sign in with a passkey, so the long random address is the only key; it can be replaced.
 */
export async function calendarFeed(c: AppContext): Promise<Response> {
  const token = (c.req.param("file") ?? "").replace(/\.ics$/i, "");
  const expected = await getSetting(c.env.DB, FEED_TOKEN_KEY);
  if (!expected || token.length < 20 || (await sha256Hex(token)) !== (await sha256Hex(expected))) {
    return new Response("Not found", { status: 404 });
  }

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM tasks
      WHERE due_date IS NOT NULL
        AND (status IN ('confirmed', 'done') OR (status = 'cancelled' AND updated_at > ?))
      ORDER BY due_date DESC LIMIT 1000`
  ).bind(isoDaysAgo(CANCELLED_FEED_DAYS)).all<TaskRow>();
  const events = results.map((row) => calendarTaskWithLink(c, row)).filter((task): task is CalendarTask => task !== null);
  const timeZone = validTimeZone(await getSetting(c.env.DB, TIMEZONE_KEY)) ?? "UTC";

  return new Response(buildFeedIcs(events, { domain: new URL(c.req.url).hostname, calendarName: "Meeting Note", timezone: timeZone }), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "private, max-age=300",
      "x-robots-tag": "noindex"
    }
  });
}

// ── Dictation ────────────────────────────────────────────────────────────────

async function extractPlans(env: Env, transcript: string, now: number, timeZone: string): Promise<PlanDraft[]> {
  const { system, user } = planPrompt(transcript, now, timeZone);
  const request = {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    max_tokens: 2500,
    temperature: 0.1,
    ...modelOptions(planModel(env))
  };
  const model = planModel(env);
  let result: unknown;
  try {
    result = await runModel(env, model, { ...request, response_format: { type: "json_schema", json_schema: { name: "plans", strict: true, schema: planJsonSchema } } });
  } catch (error) {
    // Not every model accepts a JSON schema; the prompt already asks for JSON, so ask once more without it.
    if (isDailyLimitError(error)) throw error;
    result = await runModel(env, model, request);
  }
  await recordUsage(env, null, "plan", model, result);
  return normalizePlan(extractJson(modelText(result)), now, timeZone);
}

/**
 * POST /api/dictations with the recording as the body. Transcribes it, finds the plans in it,
 * and saves them as suggestions. The audio is not kept: only the words.
 */
assistantRoutes.post("/dictations", async (c) => {
  const env = c.env;
  const mimeType = (c.req.header("content-type") || "").split(";")[0];
  if (!mimeType.startsWith("audio/")) return jsonError("Send the recording as audio", 415);
  const audio = await c.req.arrayBuffer();
  if (audio.byteLength === 0) return jsonError("The recording is empty");
  if (audio.byteLength > MAX_DICTATION_BYTES) return jsonError("Keep a spoken plan under two minutes", 413);
  const durationMs = Math.min(MAX_DICTATION_MS, Math.max(0, Number(c.req.header("x-duration-ms")) || 0));
  const timeZone = await ownerTimeZone(env, c.req.header("x-timezone"));
  const now = Date.now();

  let transcript: string;
  try {
    const result = await runModel(env, env.ASR_MODEL, {
      audio: Buffer.from(audio).toString("base64"),
      vad_filter: true,
      initial_prompt: DICTATION_TRANSCRIBE_PROMPT
    }) as Record<string, unknown>;
    await recordUsage(env, null, "dictation", env.ASR_MODEL, result, durationMs);
    const info = result.transcription_info as Record<string, unknown> | undefined;
    const raw = String(result.text ?? info?.text ?? result.transcription ?? "").trim();
    transcript = simplifyEnabled(env.CHINESE_SCRIPT) ? toSimplified(raw) : raw;
  } catch (error) {
    console.error("Dictation transcription failed", error);
    return isDailyLimitError(error)
      ? jsonError("Today's free AI allowance is used up. It comes back at 00:00 UTC.", 429)
      : jsonError("Couldn't transcribe that recording. Please try again.", 502);
  }
  if (!transcript) {
    return c.json({ ok: true, dictation: null, tasks: [], message: "Nothing was heard. Try again, a little closer to the microphone." });
  }

  let drafts: PlanDraft[] = [];
  let status = "done";
  let lastError: string | null = null;
  try {
    drafts = await extractPlans(env, transcript, now, timeZone);
    if (simplifyEnabled(env.CHINESE_SCRIPT)) drafts = deepSimplify(drafts);
  } catch (error) {
    console.error("Plan extraction failed", error);
    status = "not_understood";
    lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  }

  const dictationId = crypto.randomUUID();
  const rows = drafts.map((draft) => draftToRow(draft, { timezone: timeZone, source: "dictation", dictation_id: dictationId }));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO dictations (id, transcript, duration_ms, timezone, status, last_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(dictationId, transcript, durationMs, timeZone, status, lastError, new Date(now).toISOString()),
    ...rows.map((row) => insertTask(env.DB, row))
  ]);
  await safely("remember a dictation", () =>
    rememberSource(env.DB, dictationId, [dictationItem({ id: dictationId, transcript, created_at: new Date(now).toISOString() })])
  );

  return c.json({
    ok: true,
    dictation: { id: dictationId, transcript, status, createdAt: new Date(now).toISOString() },
    tasks: rows.map(taskView),
    message: status === "not_understood"
      ? (lastError && isDailyLimitError(lastError) ? "Today's free AI allowance is used up, so the words are saved but not sorted into plans." : "The words are saved, but they couldn't be sorted into plans. Add them by hand below.")
      : rows.length === 0 ? "No plans with something to do were found in that." : null
  }, 201);
});
