import { describe, expect, it } from "vitest";
import { parseModelJson } from "../src/ai";
import { localDateWindow } from "../src/ask";
import { planItem } from "../src/memory";
import { meetingTodoSchedule } from "../src/plans";
import { mergeHits, querySignals } from "../src/recall";
import type { TaskRow } from "../src/tasks";

const VANCOUVER = "America/Vancouver";
// Saturday 2026-09-12, 20:00 in Vancouver.
const SATURDAY = Date.UTC(2026, 8, 13, 3, 0);

describe("a meeting's to-do, dated from the words in the note", () => {
  it("makes an event only for a real clock time, and reads 12-hour and Chinese times", () => {
    expect(meetingTodoSchedule("Friday 3:00 PM", SATURDAY, VANCOUVER)).toMatchObject({ kind: "event", due_date: "2026-09-18", starts_at: "2026-09-18T22:00:00.000Z" });
    expect(meetingTodoSchedule("周五下午3:00", SATURDAY, VANCOUVER)).toMatchObject({ kind: "event", starts_at: "2026-09-18T22:00:00.000Z" });
    expect(meetingTodoSchedule("下周二之前 (2026-09-15)", SATURDAY, VANCOUVER)).toMatchObject({ kind: "task", all_day: 1, due_date: "2026-09-15" });
    expect(meetingTodoSchedule("讲座那天 (2026-09-22)", SATURDAY, VANCOUVER)).toMatchObject({ kind: "task", due_date: "2026-09-22" });
    expect(meetingTodoSchedule("讲座当天", SATURDAY, VANCOUVER)).toMatchObject({ kind: "task", due_date: null });
    expect(meetingTodoSchedule("", SATURDAY, VANCOUVER)).toMatchObject({ kind: "task", due_date: null });
  });
});

describe("plans in a range, for owners ahead of UTC", () => {
  it("counts 'tomorrow' by the owner's dates in Shanghai", () => {
    const SHANGHAI = "Asia/Shanghai";
    const mondayMorning = Date.UTC(2026, 8, 14, 2, 0); // 10:00 on the 14th in Shanghai
    const { range } = querySignals("明天有什么安排？", mondayMorning, SHANGHAI);
    expect(range).toBeDefined();
    expect(localDateWindow(range!, SHANGHAI)).toEqual({ from: "2026-09-15", to: "2026-09-16" });
  });

  it("keeps an all-day plan on its own day in memory, even in Auckland", () => {
    const task = { id: "t", title: "Rent", notes: "", repeat_hint: "", meeting_id: null, created_at: "2026-09-01T00:00:00.000Z", starts_at: null, due_date: "2026-09-30", timezone: "Pacific/Auckland" } as unknown as TaskRow;
    expect(planItem(task).occurredAt).toBe("2026-09-29T23:00:00.000Z"); // noon on the 30th in Auckland, on summer time (UTC+13)
  });
});

describe("model JSON", () => {
  it("reads bare lists and fenced objects, and refuses prose", () => {
    expect(parseModelJson('[{"title":"Call"}]')).toEqual([{ title: "Call" }]);
    expect(parseModelJson('```json\n{"items": []}\n```')).toEqual({ items: [] });
    expect(parseModelJson('Sure! {"items": [1]}')).toEqual({ items: [1] });
    expect(() => parseModelJson("Sam is making the poster.")).toThrow();
  });
});

describe("merging search hits stays cheap", () => {
  it("re-ranks 60 long passages in a few milliseconds", () => {
    const text = (index: number) => `Passage ${index}: ` + "we discussed the venue, the poster, the budget and who brings the projector ".repeat(80);
    const hits = Array.from({ length: 60 }, (_, index) => ({ id: `h${index}`, score: 60 - index, text: text(index) }));
    mergeHits([{ route: "fulltext", hits }, { route: "tag", hits: hits.slice(0, 30) }], { limit: 10 }); // warm up
    const started = performance.now();
    const merged = mergeHits([{ route: "fulltext", hits }, { route: "tag", hits: hits.slice(0, 30) }], { limit: 10 });
    expect(performance.now() - started).toBeLessThan(15); // about 1 ms alone; the suite runs files in parallel
    expect(merged).toHaveLength(10);
  });
});
