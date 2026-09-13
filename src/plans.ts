import { utcToLocalParts } from "./calendar";
import { addDays, cleanDate, cleanTime, scheduleFor, type Schedule, type TaskKind } from "./tasks";

// Spoken plans ("next Tuesday at 3, call Cindy about the venue") → calendar entries and to-dos.
//
// The model only reads dates off a reference table that the code writes; the code turns its
// local dates and times into UTC. Small models are poor at weekday arithmetic and time zones,
// and good at looking things up.

export const MAX_PLAN_ITEMS = 20;

/**
 * Whisper mirrors its prompt's script, so this is written in Simplified Chinese on purpose.
 * No colons, full-width or not: with "：" in the prompt, whisper-large-v3-turbo wrote "Ｂ" wherever
 * a comma belonged.
 */
export const DICTATION_TRANSCRIBE_PROMPT =
  "以下是一个人口述自己接下来的安排，比如约会、截止日期和待办事项。请用简体中文转写中文部分，准确保留日期、时间、人名和地点。音频可能在中文和英文之间切换。A person dictating their plans, such as appointments, deadlines and to-dos; they may switch between Chinese and English.";

export const planJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["event", "task"] },
          title: { type: "string" },
          date: { type: "string" },
          time: { type: "string" },
          duration_minutes: { type: "integer" },
          repeat: { type: "string" },
          notes: { type: "string" }
        },
        required: ["kind", "title", "date", "time", "duration_minutes", "repeat", "notes"]
      }
    }
  },
  required: ["items"]
} as const;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function weekday(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function lastDayOfMonth(date: string, monthsAhead = 0): string {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month + monthsAhead, 0)).toISOString().slice(0, 10);
}

/** Four weeks of dates, labelled by week (weeks start on Monday), plus month ends. */
export function referenceCalendar(now: number, timeZone: string): string {
  const today = utcToLocalParts(now, timeZone).date;
  const thisMonday = addDays(today, -((weekday(today) + 6) % 7));
  const weekNames = ["this week (本周)", "next week (下周)", "the week after next (下下周)", "in three weeks"];
  const lines: string[] = [];
  for (let week = 0; week < 4; week += 1) {
    const monday = addDays(thisMonday, week * 7);
    const days: string[] = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const date = addDays(monday, offset);
      const marks = date === today ? " = today" : date === addDays(today, 1) ? " = tomorrow" : date === addDays(today, 2) ? " = day after tomorrow" : "";
      days.push(`${WEEKDAYS[(offset + 1) % 7].slice(0, 3)} ${WEEKDAYS_ZH[(offset + 1) % 7]} ${date}${marks}`);
    }
    lines.push(`${weekNames[week]}: ${days.join(" | ")}`);
  }
  lines.push(`End of this month (月底): ${lastDayOfMonth(today)} · end of next month: ${lastDayOfMonth(today, 1)}`);
  return lines.join("\n");
}

export function planPrompt(transcript: string, now: number, timeZone: string): { system: string; user: string } {
  const local = utcToLocalParts(now, timeZone);
  const day = weekday(local.date);
  return {
    system:
      "You turn what a person says about their own plans into calendar entries and to-dos. " +
      "Use only what they said, and read every date from the reference dates you are given. Output JSON only.",
    user: `Now: ${WEEKDAYS[day]} (${WEEKDAYS_ZH[day]}) ${local.date} ${local.time}, time zone ${timeZone}.

Reference dates:
${referenceCalendar(now, timeZone)}

What they said (speech recognition, so expect small errors):
"""
${transcript.trim().slice(0, 4000)}
"""

Rules:
- One item per separate plan. "event" = happens at a set time (meeting, appointment, call, flight, class). "task" = something to get done, maybe by a deadline.
- title: short, starting with the action, in the language they used (Chinese → Simplified Chinese). Keep people, places and things they named, e.g. "跟 Cindy 通电话确认场地".
- date: YYYY-MM-DD, copied from the reference dates.
  - A weekday with "next" (下周二, next Tuesday) is that day in next week. A weekday alone (周五, Friday) is the first one after today.
  - A deadline (周二之前, by Friday) uses the deadline's date. 月底 / end of the month uses the end of this month.
  - If they gave no date, "".
- time: 24-hour HH:MM when they said a clock time ("下午三点" → "15:00", "half past seven tonight" → "19:30"), otherwise "".
- duration_minutes: only if they said how long ("一个小时" → 60), otherwise 0.
- repeat: if it repeats ("每周一", "every morning"), say how in a few words ("every Monday") and use the first date; otherwise "".
- notes: other useful details they said (address, what to bring, phone number), otherwise "".
- Never invent a date, time, person or place. If they said nothing that is a plan, return {"items": []}.

Return: {"items": [{"kind": "event", "title": "", "date": "", "time": "", "duration_minutes": 0, "repeat": "", "notes": ""}]}`
  };
}

export interface PlanDraft extends Schedule {
  kind: TaskKind;
  title: string;
  notes: string;
  repeat_hint: string;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Reads the model's answer defensively: a bare list, missing fields and bad dates all happen. */
export function normalizePlan(raw: unknown, now: number, timeZone: string): PlanDraft[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : [];
  const drafts: PlanDraft[] = [];
  const seen = new Set<string>();

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const title = text(item.title, 200).replace(/[。．.，,;；]+$/u, "");
    if (!title) continue;

    const kind: TaskKind = item.kind === "event" ? "event" : "task";
    const schedule = scheduleFor({
      date: cleanDate(item.date),
      time: cleanTime(item.time),
      durationMinutes: Number(item.duration_minutes) > 0 ? Number(item.duration_minutes) : null,
      kind,
      timeZone,
      now
    });

    const key = `${title.toLowerCase()}|${schedule.due_date}|${schedule.starts_at}`;
    if (seen.has(key)) continue;
    seen.add(key);

    drafts.push({ kind, title, notes: text(item.notes, 1000), repeat_hint: text(item.repeat, 80), ...schedule });
    if (drafts.length >= MAX_PLAN_ITEMS) break;
  }
  return drafts;
}

