/**
 * calendar.ts — Meeting Note v2's task-to-calendar-entry surface.
 *
 * Entry point for the module: the CalendarTask shape, ICS export (single event
 * and subscribable feed), a "Add to Google Calendar" link builder, and a safe
 * download filename. No Node APIs — must run inside Cloudflare Workers.
 */

export type { CalendarTask, CalendarTaskStatus } from "./types";
export { localDateTimeToUtc, utcToLocalParts } from "./timezone";
export type { LocalParts } from "./timezone";
export { buildEventIcs, buildFeedIcs } from "./ics";
export type { EventIcsOptions, FeedIcsOptions } from "./ics";

import type { CalendarTask } from "./types";
import { nextLocalDate } from "./timezone";
import { formatUtcBasic, requireDate, requireStartsAt, resolveEndsAt } from "./shared";

/** "Add to Google Calendar" link. Timed events use UTC instants; all-day events use bare dates. */
export function googleCalendarUrl(task: CalendarTask): string {
  const params = new URLSearchParams();
  params.set("action", "TEMPLATE");
  params.set("text", task.title);

  if (task.allDay) {
    const date = requireDate(task);
    const start = date.replace(/-/g, "");
    const end = nextLocalDate(date).replace(/-/g, "");
    params.set("dates", `${start}/${end}`);
  } else {
    const startsAt = requireStartsAt(task);
    const endsAt = resolveEndsAt(task, startsAt);
    params.set("dates", `${formatUtcBasic(startsAt)}/${formatUtcBasic(endsAt)}`);
  }

  const details = [task.notes, task.url].filter((v): v is string => v !== undefined && v !== "").join("\n");
  params.set("details", details);
  params.set("ctz", task.timezone);

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

const COMBINING_MARKS_RE = new RegExp("[\\u0300-\\u036f]", "g");

function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(COMBINING_MARKS_RE, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** A safe ASCII filename for a downloaded event, e.g. "book-flights-a1b2c3.ics". */
export function icsFilename(task: CalendarTask): string {
  const titleSlug = slugify(task.title).slice(0, 60);
  const idSlug = slugify(task.id).slice(0, 40);
  const base = [titleSlug, idSlug].filter((v) => v !== "").join("-");
  return `${base === "" ? "event" : base}.ics`;
}
