/**
 * ics.ts — RFC 5545 (iCalendar) text generation for a single task or a feed.
 *
 * Ported from nextagent-stack/apps/addons/src/ics.ts. The RFC details that are
 * easy to get wrong (and just make imports silently fail rather than error):
 *   - line endings must be CRLF;
 *   - each physical line is <=75 *octets* (UTF-8 bytes, not characters — one
 *     Chinese character is 3 bytes), folded with CRLF + a single leading space;
 *   - `\` `;` `,` and newlines in text values must be backslash-escaped;
 *   - a cancelled task must be emitted as STATUS:CANCELLED, not omitted —
 *     subscribed calendars only learn "this one is gone" by UID, not by absence.
 */

import type { CalendarTask } from "./types";
import { nextLocalDate } from "./timezone";
import { formatUtcBasic, requireDate, requireStartsAt, resolveEndsAt } from "./shared";

const PRODID = "-//Meeting Note v2//Calendar//EN";

export function escapeIcsText(raw: string): string {
  return raw
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** UTF-8 length of one code point, worked out rather than encoded: a feed folds thousands of lines. */
function utf8Bytes(codePoint: number): number {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/** Fold a single logical line at 75 UTF-8 octets. Continuation lines start with one space. */
export function foldIcsLine(line: string): string {
  if (line.length <= 25) return line; // at most 4 bytes per character
  let total = 0;
  for (const char of line) total += utf8Bytes(char.codePointAt(0)!);
  if (total <= 75) return line;
  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of line) {
    const size = utf8Bytes(char.codePointAt(0)!);
    // The continuation prefix costs 1 octet, so later lines get a 74-octet budget.
    const budget = out.length === 0 ? 75 : 74;
    if (currentBytes + size > budget) {
      out.push(current);
      current = char;
      currentBytes = size;
    } else {
      current += char;
      currentBytes += size;
    }
  }
  if (current !== "") out.push(current);
  return out.map((piece, i) => (i === 0 ? piece : ` ${piece}`)).join("\r\n");
}

function foldAndJoin(lines: readonly string[]): string {
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

function icsStatus(status: CalendarTask["status"]): "CONFIRMED" | "CANCELLED" {
  return status === "cancelled" ? "CANCELLED" : "CONFIRMED";
}

function buildVeventLines(task: CalendarTask, domain: string): string[] {
  const lines: string[] = [
    "BEGIN:VEVENT",
    `UID:${task.id}@${domain}`,
    `DTSTAMP:${formatUtcBasic(task.updatedAt)}`,
    `LAST-MODIFIED:${formatUtcBasic(task.updatedAt)}`,
    // Seconds since 2023-11-14: grows with every edit, so calendars that track SEQUENCE (Outlook) take the change.
    `SEQUENCE:${Math.max(0, Math.floor(task.updatedAt / 1000) - 1_700_000_000)}`,
  ];

  if (task.allDay) {
    const date = requireDate(task);
    lines.push(`DTSTART;VALUE=DATE:${date.replace(/-/g, "")}`);
    lines.push(`DTEND;VALUE=DATE:${nextLocalDate(date).replace(/-/g, "")}`);
  } else {
    const startsAt = requireStartsAt(task);
    const endsAt = resolveEndsAt(task, startsAt);
    lines.push(`DTSTART:${formatUtcBasic(startsAt)}`);
    lines.push(`DTEND:${formatUtcBasic(endsAt)}`);
  }

  lines.push(`SUMMARY:${escapeIcsText(task.title)}`);

  const description = [task.notes, task.url].filter((v): v is string => v !== undefined && v !== "").join("\n");
  if (description !== "") lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
  if (task.url !== undefined && task.url !== "") lines.push(`URL:${escapeIcsText(task.url)}`);

  lines.push(`STATUS:${icsStatus(task.status)}`);

  if (!task.allDay) {
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeIcsText(task.title)}`, "TRIGGER:-PT15M", "END:VALARM");
  }

  lines.push("END:VEVENT");
  return lines;
}

export interface EventIcsOptions {
  /** UID suffix (`<task.id>@<domain>`); not resolved or fetched, just needs to be stable. */
  domain: string;
  calendarName?: string;
}

/** One task -> a standalone VCALENDAR with a single VEVENT (for a "download .ics" link). */
export function buildEventIcs(task: CalendarTask, opts: EventIcsOptions): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  if (opts.calendarName !== undefined) lines.push(`X-WR-CALNAME:${escapeIcsText(opts.calendarName)}`);
  lines.push(...buildVeventLines(task, opts.domain));
  lines.push("END:VCALENDAR");
  return foldAndJoin(lines);
}

export interface FeedIcsOptions {
  domain: string;
  calendarName: string;
  timezone: string;
}

/**
 * All tasks -> one subscribable VCALENDAR feed.
 * Suggested tasks are skipped (nothing to put on a calendar yet); cancelled
 * tasks are kept as STATUS:CANCELLED so calendars that already synced them
 * learn to remove them.
 */
export function buildFeedIcs(tasks: readonly CalendarTask[], opts: FeedIcsOptions): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(opts.calendarName)}`,
    `X-WR-TIMEZONE:${opts.timezone}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const task of tasks) {
    if (task.status === "suggested") continue;
    lines.push(...buildVeventLines(task, opts.domain));
  }
  lines.push("END:VCALENDAR");
  return foldAndJoin(lines);
}
