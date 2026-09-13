import { describe, expect, it } from "vitest";
import { modelText } from "../src/ai";
import { lastDayOfMonth, normalizePlan, planPrompt, referenceCalendar } from "../src/plans";
import { cleanDate, cleanTime, scheduleFor, taskView, toCalendarTask, validTimeZone, type TaskRow } from "../src/tasks";

const VANCOUVER = "America/Vancouver";
// Saturday 2026-09-12, 20:00 in Vancouver (PDT, UTC-7).
const SATURDAY_EVENING = Date.UTC(2026, 8, 13, 3, 0);

describe("the reference calendar the model reads dates from", () => {
  it("labels today, tomorrow and next week's Tuesday, with weeks starting on Monday", () => {
    const table = referenceCalendar(SATURDAY_EVENING, VANCOUVER);
    expect(table).toContain("Sat 周六 2026-09-12 = today");
    expect(table).toContain("Sun 周日 2026-09-13 = tomorrow");
    const nextWeek = table.split("\n").find((line) => line.startsWith("next week"));
    expect(nextWeek).toContain("Mon 周一 2026-09-14");
    expect(nextWeek).toContain("Tue 周二 2026-09-15");
    expect(table).toContain("End of this month (月底): 2026-09-30");
  });

  it("uses the owner's local date, not UTC's, late in the evening", () => {
    // 03:00 UTC on the 13th is still the 12th in Vancouver.
    expect(planPrompt("明天下午三点开会", SATURDAY_EVENING, VANCOUVER).user).toContain("Now: Saturday (周六) 2026-09-12 20:00");
  });

  it("knows month ends, including February", () => {
    expect(lastDayOfMonth("2026-09-12")).toBe("2026-09-30");
    expect(lastDayOfMonth("2026-12-05", 1)).toBe("2027-01-31");
    expect(lastDayOfMonth("2028-02-10")).toBe("2028-02-29");
  });
});

describe("reading the model's plans", () => {
  it("turns a local date and time into UTC, with a default length per kind", () => {
    const [call, deadline] = normalizePlan({
      items: [
        { kind: "event", title: "跟 Cindy 通电话确认场地。", date: "2026-09-15", time: "15:00", duration_minutes: 0, repeat: "", notes: "" },
        { kind: "task", title: "Send the poster to OCCA", date: "2026-09-18", time: "", duration_minutes: 0, repeat: "", notes: "PDF and PNG" }
      ]
    }, SATURDAY_EVENING, VANCOUVER);

    expect(call).toMatchObject({ kind: "event", title: "跟 Cindy 通电话确认场地", all_day: 0, due_date: "2026-09-15" });
    expect(call.starts_at).toBe("2026-09-15T22:00:00.000Z");
    expect(call.ends_at).toBe("2026-09-15T23:00:00.000Z");
    expect(deadline).toMatchObject({ all_day: 1, due_date: "2026-09-18", starts_at: null, notes: "PDF and PNG" });
  });

  it("puts a time without a date on the next day that clock time comes round", () => {
    const [later, passed] = normalizePlan([
      { kind: "event", title: "Call mum", time: "21:30" },
      { kind: "event", title: "Walk the dog", time: "07:00" }
    ], SATURDAY_EVENING, VANCOUVER);
    expect(later.due_date).toBe("2026-09-12");
    expect(passed.due_date).toBe("2026-09-13");
  });

  it("follows the clock change: 10:00 on 2 November is 18:00 UTC, not 17:00", () => {
    const [plan] = normalizePlan({ items: [{ kind: "event", title: "Dentist", date: "2026-11-02", time: "10:00", duration_minutes: 45 }] }, SATURDAY_EVENING, VANCOUVER);
    expect(plan.starts_at).toBe("2026-11-02T18:00:00.000Z");
    expect(plan.ends_at).toBe("2026-11-02T18:45:00.000Z");
  });

  it("drops what can't be used rather than guessing", () => {
    const plans = normalizePlan({
      items: [
        { kind: "task", title: "", date: "2026-09-15" },
        { kind: "task", title: "Pay rent", date: "2026-02-30", time: "25:00" },
        { kind: "task", title: "Pay rent", date: "2026-02-30", time: "25:00" },
        "not an item",
        { kind: "meeting?", title: "Renew licence", date: "sometime" }
      ]
    }, SATURDAY_EVENING, VANCOUVER);
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({ title: "Pay rent", due_date: null, all_day: 1 });
    expect(plans[1]).toMatchObject({ kind: "task", title: "Renew licence", due_date: null });
  });

  it("trusts the date words over the model's arithmetic", () => {
    const [call] = normalizePlan({ items: [{ kind: "event", title: "Call Cindy", date_phrase: "明天下午", date: "2026-09-12", time: "15:00" }] }, SATURDAY_EVENING, VANCOUVER);
    expect(call.due_date).toBe("2026-09-13");
    const [unknown] = normalizePlan({ items: [{ kind: "task", title: "Renew passport", date_phrase: "before the trip", date: "2026-10-01" }] }, SATURDAY_EVENING, VANCOUVER);
    expect(unknown.due_date).toBe("2026-10-01");
  });

  it("keeps a repeat as words, and an empty answer as no plans", () => {
    const [weekly] = normalizePlan({ items: [{ kind: "event", title: "周会", date: "2026-09-14", time: "09:00", repeat: "every Monday" }] }, SATURDAY_EVENING, VANCOUVER);
    expect(weekly.repeat_hint).toBe("every Monday");
    expect(normalizePlan({ items: [] }, SATURDAY_EVENING, VANCOUVER)).toEqual([]);
    expect(normalizePlan(null, SATURDAY_EVENING, VANCOUVER)).toEqual([]);
  });
});

describe("dates, times and time zones typed by a person or a model", () => {
  it("accepts real dates and clock times only", () => {
    expect(cleanDate("2026-09-22")).toBe("2026-09-22");
    expect(cleanDate("2026-2-3")).toBeNull();
    expect(cleanDate("2026-02-29")).toBeNull();
    expect(cleanTime("9:05")).toBe("09:05");
    expect(cleanTime("15:00:00")).toBe("15:00");
    expect(cleanTime("24:00")).toBeNull();
    expect(validTimeZone("America/Vancouver")).toBe("America/Vancouver");
    expect(validTimeZone("Mars/Olympus")).toBeNull();
  });

  it("clamps silly durations", () => {
    const schedule = scheduleFor({ date: "2026-09-22", time: "18:30", durationMinutes: 100000, kind: "event", timeZone: VANCOUVER, now: SATURDAY_EVENING });
    expect(Date.parse(schedule.ends_at!) - Date.parse(schedule.starts_at!)).toBe(24 * 3600_000);
  });
});

function row(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "task-1",
    title: "Workshop at OCCA",
    notes: "Bring the clicker",
    kind: "event",
    status: "confirmed",
    all_day: 0,
    due_date: "2026-09-22",
    starts_at: "2026-09-23T01:30:00.000Z",
    ends_at: "2026-09-23T03:30:00.000Z",
    timezone: VANCOUVER,
    repeat_hint: "",
    assignee: "",
    source: "dictation",
    dictation_id: "d1",
    meeting_id: null,
    segment_seq: null,
    created_at: "2026-09-12T20:00:00.000Z",
    updated_at: "2026-09-12T20:00:00.000Z",
    ...overrides
  };
}

describe("a stored plan, as the app and calendars see it", () => {
  it("shows the local date and time, and how to add it to a calendar", () => {
    const view = taskView(row());
    expect(view).toMatchObject({ date: "2026-09-22", time: "18:30", durationMinutes: 120, allDay: false, icsUrl: "/api/tasks/task-1/event.ics" });
    expect(view.googleCalendarUrl).toContain("dates=20260923T013000Z%2F20260923T033000Z");
    expect(view.googleCalendarUrl).toContain("ctz=America%2FVancouver");
  });

  it("offers no calendar link until there is a date", () => {
    const view = taskView(row({ all_day: 1, due_date: null, starts_at: null, ends_at: null }));
    expect(view.googleCalendarUrl).toBeNull();
    expect(view.icsUrl).toBeNull();
    expect(toCalendarTask(row({ all_day: 1, due_date: null, starts_at: null }))).toBeNull();
  });

  it("carries who it's for and how it repeats into the calendar notes", () => {
    const calendar = toCalendarTask(row({ assignee: "Sam", repeat_hint: "every Monday" }));
    expect(calendar?.notes).toBe("Bring the clicker\nFor: Sam\nRepeats every Monday (set the repeat in your calendar app)");
  });
});

describe("model answers in every shape Workers AI returns", () => {
  it("reads response strings, parsed JSON, chat choices and Responses-style output", () => {
    expect(modelText({ response: "<think>hmm</think>{\"items\":[]}" })).toBe("{\"items\":[]}");
    expect(modelText({ response: { items: [] } })).toBe("{\"items\":[]}");
    expect(modelText({ choices: [{ message: { content: "{\"a\":1}", reasoning_content: "thinking" } }] })).toBe("{\"a\":1}");
    expect(modelText({ output: [{ type: "reasoning", content: [] }, { type: "message", content: [{ type: "output_text", text: "{\"b\":2}" }] }] })).toBe("{\"b\":2}");
    expect(modelText({ response: null, choices: [{ message: { content: "ok" } }] })).toBe("ok");
  });
});
