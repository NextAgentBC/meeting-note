import { describe, expect, it } from "vitest";
import {
  buildEventIcs,
  buildFeedIcs,
  googleCalendarUrl,
  icsFilename,
  localDateTimeToUtc,
  utcToLocalParts,
  type CalendarTask,
} from "../src/calendar";

const VANCOUVER = "America/Vancouver";
const BASE_UPDATED_AT = Date.UTC(2026, 8, 12, 0, 0, 0);
// 2026-09-22 10:00 America/Vancouver == 2026-09-22T17:00:00Z (PDT, UTC-7).
const BASE_STARTS_AT = Date.UTC(2026, 8, 22, 17, 0, 0);

function makeTask(overrides: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id: "task-1",
    title: "Untitled task",
    allDay: false,
    timezone: VANCOUVER,
    status: "confirmed",
    updatedAt: BASE_UPDATED_AT,
    ...overrides,
  };
}

/** Unfold RFC 5545 continuation lines (CRLF + one leading space/tab) back into logical lines. */
function unfoldIcs(ics: string): string[] {
  const physical = ics.split("\r\n");
  if (physical.length > 0 && physical[physical.length - 1] === "") physical.pop();
  const logical: string[] = [];
  for (const line of physical) {
    if (logical.length > 0 && (line.startsWith(" ") || line.startsWith("\t"))) {
      logical[logical.length - 1] += line.slice(1);
    } else {
      logical.push(line);
    }
  }
  return logical;
}

/** Inverse of the escaping rules in src/ics.ts's escapeIcsText. */
function unescapeIcsText(escaped: string): string {
  let out = "";
  for (let i = 0; i < escaped.length; i++) {
    const c = escaped[i];
    if (c === "\\" && i + 1 < escaped.length) {
      const next = escaped[i + 1];
      if (next === "n" || next === "N") {
        out += "\n";
        i++;
        continue;
      }
      if (next === "\\" || next === ";" || next === ",") {
        out += next;
        i++;
        continue;
      }
    }
    out += c;
  }
  return out;
}

function extractVevents(logicalLines: string[]): string[][] {
  const events: string[][] = [];
  let current: string[] | null = null;
  for (const line of logicalLines) {
    if (line === "BEGIN:VEVENT") {
      current = [];
      continue;
    }
    if (line === "END:VEVENT") {
      if (current !== null) events.push(current);
      current = null;
      continue;
    }
    if (current !== null) current.push(line);
  }
  return events;
}

function findLine(lines: string[], property: string): string {
  const line = lines.find((l) => l.startsWith(`${property}:`));
  if (line === undefined) throw new Error(`No ${property} line in:\n${lines.join("\n")}`);
  return line.slice(property.length + 1);
}

describe("localDateTimeToUtc / utcToLocalParts", () => {
  it("converts through Vancouver's 2026 spring-forward transition (2026-03-08)", () => {
    const before = localDateTimeToUtc(VANCOUVER, "2026-03-08", "01:30"); // still PST (-08:00)
    expect(before).toBe(Date.UTC(2026, 2, 8, 9, 30));
    expect(utcToLocalParts(before, VANCOUVER)).toEqual({ date: "2026-03-08", time: "01:30" });

    const after = localDateTimeToUtc(VANCOUVER, "2026-03-08", "03:30"); // now PDT (-07:00)
    expect(after).toBe(Date.UTC(2026, 2, 8, 10, 30));
    expect(utcToLocalParts(after, VANCOUVER)).toEqual({ date: "2026-03-08", time: "03:30" });

    // The hour that never occurs (02:00-02:59) must not throw.
    expect(() => localDateTimeToUtc(VANCOUVER, "2026-03-08", "02:30")).not.toThrow();
  });

  it("converts through Vancouver's 2026 fall-back transition (2026-11-01)", () => {
    const dayBefore = localDateTimeToUtc(VANCOUVER, "2026-10-31", "12:00"); // unambiguous PDT
    expect(dayBefore).toBe(Date.UTC(2026, 9, 31, 19, 0));

    const dayAfter = localDateTimeToUtc(VANCOUVER, "2026-11-02", "12:00"); // unambiguous PST
    expect(dayAfter).toBe(Date.UTC(2026, 10, 2, 20, 0));

    // 01:30 occurs twice; whichever instant is chosen must round-trip consistently.
    const ambiguous = localDateTimeToUtc(VANCOUVER, "2026-11-01", "01:30");
    expect(utcToLocalParts(ambiguous, VANCOUVER)).toEqual({ date: "2026-11-01", time: "01:30" });

    // 02:30 only exists after the clocks fall back, so it is unambiguously PST.
    const afterFallback = localDateTimeToUtc(VANCOUVER, "2026-11-01", "02:30");
    expect(afterFallback).toBe(Date.UTC(2026, 10, 1, 10, 30));
  });

  it("converts a normal date: 2026-09-22 10:00 America/Vancouver -> 17:00Z", () => {
    expect(localDateTimeToUtc(VANCOUVER, "2026-09-22", "10:00")).toBe(BASE_STARTS_AT);
    expect(utcToLocalParts(BASE_STARTS_AT, VANCOUVER)).toEqual({ date: "2026-09-22", time: "10:00" });
  });

  it("throws RangeError on malformed date or time input", () => {
    expect(() => localDateTimeToUtc(VANCOUVER, "2026/09/22", "10:00")).toThrow(RangeError);
    expect(() => localDateTimeToUtc(VANCOUVER, "2026-09-22", "10am")).toThrow(RangeError);
  });
});

describe("buildEventIcs - timed events", () => {
  it("emits DTSTART/DTEND in UTC basic format with Z", () => {
    const task = makeTask({ allDay: false, startsAt: BASE_STARTS_AT, endsAt: BASE_STARTS_AT + 60 * 60 * 1000 });
    const lines = unfoldIcs(buildEventIcs(task, { domain: "example.com" }));
    expect(findLine(lines, "DTSTART")).toBe("20260922T170000Z");
    expect(findLine(lines, "DTEND")).toBe("20260922T180000Z");
  });

  it("defaults to a 30-minute duration when endsAt is absent", () => {
    const task = makeTask({ allDay: false, startsAt: BASE_STARTS_AT });
    const lines = unfoldIcs(buildEventIcs(task, { domain: "example.com" }));
    expect(findLine(lines, "DTSTART")).toBe("20260922T170000Z");
    expect(findLine(lines, "DTEND")).toBe("20260922T173000Z");
  });

  it("adds a VALARM 15 minutes before start", () => {
    const task = makeTask({ allDay: false, startsAt: BASE_STARTS_AT });
    const lines = unfoldIcs(buildEventIcs(task, { domain: "example.com" }));
    const alarmStart = lines.indexOf("BEGIN:VALARM");
    const alarmEnd = lines.indexOf("END:VALARM");
    expect(alarmStart).toBeGreaterThan(-1);
    expect(alarmEnd).toBeGreaterThan(alarmStart);
    expect(lines.slice(alarmStart, alarmEnd)).toContain("ACTION:DISPLAY");
    expect(lines.slice(alarmStart, alarmEnd)).toContain("TRIGGER:-PT15M");
  });
});

describe("buildEventIcs - all-day events", () => {
  it("emits DTSTART;VALUE=DATE and DTEND;VALUE=DATE for the next day", () => {
    const task = makeTask({ allDay: true, date: "2026-09-22" });
    const lines = unfoldIcs(buildEventIcs(task, { domain: "example.com" }));
    expect(lines).toContain("DTSTART;VALUE=DATE:20260922");
    expect(lines).toContain("DTEND;VALUE=DATE:20260923");
  });

  it("rolls DTEND over a month boundary", () => {
    const task = makeTask({ allDay: true, date: "2026-09-30" });
    const lines = unfoldIcs(buildEventIcs(task, { domain: "example.com" }));
    expect(lines).toContain("DTSTART;VALUE=DATE:20260930");
    expect(lines).toContain("DTEND;VALUE=DATE:20261001");
  });

  it("has no VALARM", () => {
    const task = makeTask({ allDay: true, date: "2026-09-22" });
    const lines = unfoldIcs(buildEventIcs(task, { domain: "example.com" }));
    expect(lines).not.toContain("BEGIN:VALARM");
  });
});

describe("buildEventIcs - text handling", () => {
  it("escapes backslash, semicolon, comma and newline", () => {
    const title = "Q&A, Part 1; Draft\\Final";
    const notes = "Line one\nLine two, with a comma; and a semicolon\\and a backslash";
    const task = makeTask({ allDay: false, startsAt: BASE_STARTS_AT, title, notes });
    const lines = unfoldIcs(buildEventIcs(task, { domain: "example.com" }));

    expect(unescapeIcsText(findLine(lines, "SUMMARY"))).toBe(title);
    expect(unescapeIcsText(findLine(lines, "DESCRIPTION"))).toBe(notes);
    // Escaping must have actually happened (no raw special characters left unescaped).
    expect(findLine(lines, "SUMMARY")).toBe("Q&A\\, Part 1\\; Draft\\\\Final");
  });

  it("keeps a short Chinese title intact", () => {
    const title = "会议记录";
    const task = makeTask({ allDay: false, startsAt: BASE_STARTS_AT, title });
    const lines = unfoldIcs(buildEventIcs(task, { domain: "example.com" }));
    expect(findLine(lines, "SUMMARY")).toBe(title);
  });

  it("folds a long Chinese summary at 75 octets and unfolds back to the original text", () => {
    const title = "这是一段用来验证折行逻辑在多字节字符下是否正确工作的很长很长的中文会议标题，".repeat(3);
    const task = makeTask({ allDay: false, startsAt: BASE_STARTS_AT, title });
    const ics = buildEventIcs(task, { domain: "example.com" });

    const encoder = new TextEncoder();
    const physicalLines = ics.split("\r\n").filter((l) => l !== "");
    for (const line of physicalLines) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
    // Confirm at least one continuation line was produced.
    expect(physicalLines.some((l) => l.startsWith(" "))).toBe(true);

    const lines = unfoldIcs(ics);
    expect(findLine(lines, "SUMMARY")).toBe(title);
  });
});

describe("buildEventIcs - status", () => {
  it("maps status to STATUS:CONFIRMED or STATUS:CANCELLED", () => {
    for (const status of ["suggested", "confirmed", "done"] as const) {
      const task = makeTask({ allDay: false, startsAt: BASE_STARTS_AT, status });
      const lines = unfoldIcs(buildEventIcs(task, { domain: "example.com" }));
      expect(findLine(lines, "STATUS")).toBe("CONFIRMED");
    }
    const cancelled = makeTask({ allDay: false, startsAt: BASE_STARTS_AT, status: "cancelled" });
    const lines = unfoldIcs(buildEventIcs(cancelled, { domain: "example.com" }));
    expect(findLine(lines, "STATUS")).toBe("CANCELLED");
  });
});

describe("buildFeedIcs", () => {
  it("sets calendar-level feed headers", () => {
    const feed = buildFeedIcs([], { domain: "example.com", calendarName: "Meeting Note", timezone: VANCOUVER });
    const lines = unfoldIcs(feed);
    expect(lines).toContain("X-WR-CALNAME:Meeting Note");
    expect(lines).toContain("X-WR-TIMEZONE:America/Vancouver");
    expect(lines).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT1H");
    expect(lines).toContain("X-PUBLISHED-TTL:PT1H");
  });

  it("includes confirmed and done, cancels cancelled, and skips suggested", () => {
    const confirmed = makeTask({ id: "t-confirmed", status: "confirmed", allDay: false, startsAt: BASE_STARTS_AT });
    const done = makeTask({ id: "t-done", status: "done", allDay: true, date: "2026-09-25" });
    const cancelled = makeTask({ id: "t-cancelled", status: "cancelled", allDay: false, startsAt: BASE_STARTS_AT });
    const suggested = makeTask({ id: "t-suggested", status: "suggested", allDay: false, startsAt: BASE_STARTS_AT });

    const feed = buildFeedIcs([confirmed, done, cancelled, suggested], {
      domain: "example.com",
      calendarName: "Meeting Note",
      timezone: VANCOUVER,
    });
    const events = extractVevents(unfoldIcs(feed));
    expect(events).toHaveLength(3);

    const byId = (id: string): string[] => {
      const found = events.find((e) => e.includes(`UID:${id}@example.com`));
      if (found === undefined) throw new Error(`missing VEVENT for ${id}`);
      return found;
    };
    expect(byId("t-confirmed")).toContain("STATUS:CONFIRMED");
    expect(byId("t-done")).toContain("STATUS:CONFIRMED");
    expect(byId("t-cancelled")).toContain("STATUS:CANCELLED");
    expect(events.some((e) => e.includes("UID:t-suggested@example.com"))).toBe(false);
  });
});

describe("googleCalendarUrl", () => {
  it("builds a timed-event link in UTC basic format", () => {
    const task = makeTask({
      allDay: false,
      startsAt: BASE_STARTS_AT,
      title: "Ship v2",
      notes: "Bring laptop",
      url: "https://example.com/doc",
    });
    const url = new URL(googleCalendarUrl(task));
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("Ship v2");
    expect(url.searchParams.get("dates")).toBe("20260922T170000Z/20260922T173000Z");
    expect(url.searchParams.get("details")).toBe("Bring laptop\nhttps://example.com/doc");
    expect(url.searchParams.get("ctz")).toBe(VANCOUVER);
  });

  it("builds an all-day link spanning to the next day", () => {
    const task = makeTask({ allDay: true, date: "2026-09-30", title: "Offsite" });
    const url = new URL(googleCalendarUrl(task));
    expect(url.searchParams.get("dates")).toBe("20260930/20261001");
  });
});

describe("icsFilename", () => {
  it("returns a safe ascii filename ending in .ics", () => {
    const task = makeTask({ id: "abc123", title: "会议纪要 Q3 Review!" });
    const filename = icsFilename(task);
    expect(filename.endsWith(".ics")).toBe(true);
    expect(/^[\x21-\x7e]+$/.test(filename)).toBe(true);
    expect(filename).toContain("q3-review");
    expect(filename).toContain("abc123");
  });
});
