import { googleCalendarUrl, localDateTimeToUtc, utcToLocalParts, type CalendarTask } from "./calendar";

export type TaskStatus = "suggested" | "confirmed" | "done" | "cancelled";
export type TaskKind = "task" | "event";

export interface TaskRow {
  id: string;
  title: string;
  notes: string;
  kind: TaskKind;
  status: TaskStatus;
  all_day: number;
  due_date: string | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string;
  repeat_hint: string;
  assignee: string;
  source: "dictation" | "meeting" | "manual";
  dictation_id: string | null;
  meeting_id: string | null;
  segment_seq: number | null;
  created_at: string;
  updated_at: string;
}

/** The columns that say when something happens. */
export interface Schedule {
  all_day: number;
  due_date: string | null;
  starts_at: string | null;
  ends_at: string | null;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;

/** A real calendar date written YYYY-MM-DD (not 2026-02-30), or null. */
export function cleanDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = DATE.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  if (year < 2000 || year > 2200) return null;
  return match[0];
}

/** "15:00", "9:05" or "15:00:00" → "HH:MM", otherwise null. */
export function cleanTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = TIME.exec(value.trim());
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : null;
}

export function validTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** Events default to an hour; a to-do with a time gets a half-hour slot. */
export function defaultDurationMinutes(kind: TaskKind): number {
  return kind === "event" ? 60 : 30;
}

/**
 * Turns a local date and optional time into stored columns. A time without a date means the
 * next time the clock shows it: later today, or tomorrow if that time has already passed.
 */
export function scheduleFor(input: {
  date: string | null;
  time: string | null;
  durationMinutes?: number | null;
  kind: TaskKind;
  timeZone: string;
  now: number;
}): Schedule {
  let date = input.date;
  const time = input.time;
  if (time && !date) {
    const today = utcToLocalParts(input.now, input.timeZone).date;
    date = localDateTimeToUtc(input.timeZone, today, time) > input.now ? today : addDays(today, 1);
  }
  if (!date) return { all_day: 1, due_date: null, starts_at: null, ends_at: null };
  if (!time) return { all_day: 1, due_date: date, starts_at: null, ends_at: null };

  const minutes = Math.min(24 * 60, Math.max(5, Math.round(Number(input.durationMinutes) || defaultDurationMinutes(input.kind))));
  const startsAt = localDateTimeToUtc(input.timeZone, date, time);
  return {
    all_day: 0,
    // The date as the owner sees it, even if a DST gap nudged the time.
    due_date: utcToLocalParts(startsAt, input.timeZone).date,
    starts_at: new Date(startsAt).toISOString(),
    ends_at: new Date(startsAt + minutes * 60_000).toISOString()
  };
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** What a calendar needs, or null while the plan has no date. */
export function toCalendarTask(row: TaskRow): CalendarTask | null {
  const notes = [
    row.notes,
    row.assignee ? `For: ${row.assignee}` : "",
    row.repeat_hint ? `Repeats ${row.repeat_hint} (set the repeat in your calendar app)` : ""
  ].filter(Boolean).join("\n");
  const base = {
    id: row.id,
    title: row.title,
    notes,
    timezone: row.timezone,
    status: row.status,
    updatedAt: Date.parse(row.updated_at)
  };
  if (row.all_day === 0 && row.starts_at) {
    return { ...base, allDay: false, startsAt: Date.parse(row.starts_at), endsAt: row.ends_at ? Date.parse(row.ends_at) : null };
  }
  if (row.due_date) return { ...base, allDay: true, date: row.due_date };
  return null;
}

export function taskView(row: TaskRow) {
  const timed = row.all_day === 0 && row.starts_at !== null;
  const local = timed ? utcToLocalParts(Date.parse(row.starts_at!), row.timezone) : null;
  const calendar = toCalendarTask(row);
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    kind: row.kind,
    status: row.status,
    allDay: !timed,
    date: local?.date ?? row.due_date,
    time: local?.time ?? null,
    durationMinutes: timed && row.ends_at ? Math.round((Date.parse(row.ends_at) - Date.parse(row.starts_at!)) / 60_000) : null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    repeatHint: row.repeat_hint,
    assignee: row.assignee,
    source: row.source,
    meetingId: row.meeting_id,
    dictationId: row.dictation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    googleCalendarUrl: calendar ? googleCalendarUrl(calendar) : null,
    icsUrl: calendar ? `/api/tasks/${encodeURIComponent(row.id)}/event.ics` : null
  };
}

export type TaskView = ReturnType<typeof taskView>;
