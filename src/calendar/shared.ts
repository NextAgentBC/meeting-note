import type { CalendarTask } from "./types";

export const THIRTY_MINUTES_MS = 30 * 60 * 1000;

/** epoch ms -> `20260922T170000Z` (RFC 5545 UTC "basic" format). */
export function formatUtcBasic(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function requireStartsAt(task: CalendarTask): number {
  if (typeof task.startsAt !== "number") {
    throw new RangeError(`Timed task "${task.id}" is missing startsAt`);
  }
  return task.startsAt;
}

export function requireDate(task: CalendarTask): string {
  if (typeof task.date !== "string" || task.date === "") {
    throw new RangeError(`All-day task "${task.id}" is missing date`);
  }
  return task.date;
}

/** A timed task without endsAt lasts 30 minutes. */
export function resolveEndsAt(task: CalendarTask, startsAt: number): number {
  return task.endsAt ?? startsAt + THIRTY_MINUTES_MS;
}
