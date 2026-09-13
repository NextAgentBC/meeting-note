/**
 * New tests for querySignals (no direct nextclaw-cloud equivalent test file --
 * that repo's temporal.test.ts, if any, works in UTC day-buckets; v2 needs
 * IANA-timezone correctness including across a DST transition).
 *
 * Reference fact used throughout: 2026-11-01 is a Sunday, so US/Canada DST
 * ends that day at 02:00 America/Vancouver local time (PDT UTC-7 -> PST
 * UTC-8).
 */

import { describe, expect, it } from "vitest";
import { querySignals } from "../../src/recall/query-signals";

const TZ = "America/Vancouver";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("querySignals: past expressions", () => {
  const NOW = Date.parse("2026-09-15T20:00:00Z"); // 13:00 PDT, Tuesday

  it.each([
    ["today", "today's standup"],
    ["今天", "今天的站会"],
  ])("%s -> [start of today, start of tomorrow)", (_label, q) => {
    const { range } = querySignals(q, NOW, TZ);
    expect(iso(range!.from)).toBe("2026-09-15T07:00:00.000Z");
    expect(iso(range!.to)).toBe("2026-09-16T07:00:00.000Z");
  });

  it.each([
    ["yesterday", "yesterday's notes"],
    ["昨天", "昨天的笔记"],
  ])("%s -> [start of yesterday, start of today)", (_label, q) => {
    const { range } = querySignals(q, NOW, TZ);
    expect(iso(range!.from)).toBe("2026-09-14T07:00:00.000Z");
    expect(iso(range!.to)).toBe("2026-09-15T07:00:00.000Z");
  });

  it("前天 (day before yesterday, Chinese only)", () => {
    const { range } = querySignals("前天开的会", NOW, TZ);
    expect(iso(range!.from)).toBe("2026-09-13T07:00:00.000Z");
    expect(iso(range!.to)).toBe("2026-09-14T07:00:00.000Z");
  });

  it.each([
    ["this week", "this week's agenda"],
    ["本周", "本周的议程"],
    ["这周", "这周的议程"],
  ])("%s -> Monday..Monday containing today", (_label, q) => {
    const { range } = querySignals(q, NOW, TZ);
    // 2026-09-15 is itself the Tuesday of its week; Monday is 2026-09-14.
    expect(iso(range!.from)).toBe("2026-09-14T07:00:00.000Z");
    expect(iso(range!.to)).toBe("2026-09-21T07:00:00.000Z");
  });

  it.each([
    ["last week", "last week's agenda"],
    ["上周", "上周的议程"],
  ])("%s -> the previous Monday..Monday", (_label, q) => {
    const { range } = querySignals(q, NOW, TZ);
    expect(iso(range!.from)).toBe("2026-09-07T07:00:00.000Z");
    expect(iso(range!.to)).toBe("2026-09-14T07:00:00.000Z");
  });

  it.each([
    ["this month", "this month's summary"],
    ["本月", "本月的总结"],
    ["这个月", "这个月的总结"],
  ])("%s -> whole calendar month containing today", (_label, q) => {
    const { range } = querySignals(q, NOW, TZ);
    expect(iso(range!.from)).toBe("2026-09-01T07:00:00.000Z");
    expect(iso(range!.to)).toBe("2026-10-01T07:00:00.000Z");
  });

  it.each([
    ["last month", "last month's summary"],
    ["上个月", "上个月的总结"],
  ])("%s -> the previous whole calendar month", (_label, q) => {
    const { range } = querySignals(q, NOW, TZ);
    expect(iso(range!.from)).toBe("2026-08-01T07:00:00.000Z");
    expect(iso(range!.to)).toBe("2026-09-01T07:00:00.000Z");
  });

  it.each([
    ["English", "3 days ago we discussed pricing"],
    ["Chinese", "3天前的报价讨论"],
  ])("N days ago (%s)", (_label, q) => {
    const { range } = querySignals(q, NOW, TZ);
    expect(iso(range!.from)).toBe("2026-09-12T07:00:00.000Z");
    expect(iso(range!.to)).toBe("2026-09-13T07:00:00.000Z");
  });

  it("N days ago is clamped to [0, 365]", () => {
    const { range } = querySignals("999 days ago", NOW, TZ);
    const from = new Date(range!.from);
    expect(from.getUTCFullYear()).toBe(2025); // 365 days back, not 999
  });
});

describe("querySignals: future expressions", () => {
  const NOW = Date.parse("2026-09-15T20:00:00Z"); // 13:00 PDT, Tuesday

  it.each([
    ["tomorrow", "tomorrow's plan"],
    ["明天", "明天的计划"],
  ])("%s -> [start of tomorrow, start of day after)", (_label, q) => {
    const { range } = querySignals(q, NOW, TZ);
    expect(iso(range!.from)).toBe("2026-09-16T07:00:00.000Z");
    expect(iso(range!.to)).toBe("2026-09-17T07:00:00.000Z");
  });

  it.each([
    ["day after tomorrow", "day after tomorrow we ship"],
    ["后天", "后天开会"],
  ])("%s", (_label, q) => {
    const { range } = querySignals(q, NOW, TZ);
    expect(iso(range!.from)).toBe("2026-09-17T07:00:00.000Z");
    expect(iso(range!.to)).toBe("2026-09-18T07:00:00.000Z");
  });

  it.each([
    ["next week", "next week's agenda"],
    ["下周", "下周的议程"],
  ])("%s -> the following Monday..Monday", (_label, q) => {
    const { range } = querySignals(q, NOW, TZ);
    expect(iso(range!.from)).toBe("2026-09-21T07:00:00.000Z");
    expect(iso(range!.to)).toBe("2026-09-28T07:00:00.000Z");
  });

  it.each([
    ["next month", "next month's plan"],
    ["下个月", "下个月的计划"],
  ])("%s -> the following whole calendar month", (_label, q) => {
    const { range } = querySignals(q, NOW, TZ);
    expect(iso(range!.from)).toBe("2026-10-01T07:00:00.000Z");
    expect(iso(range!.to)).toBe("2026-11-01T07:00:00.000Z");
  });

  it.each([
    ["English", "in 3 days we meet again"],
    ["Chinese", "3天后开会"],
  ])("in N days (%s)", (_label, q) => {
    const { range } = querySignals(q, NOW, TZ);
    expect(iso(range!.from)).toBe("2026-09-18T07:00:00.000Z");
    expect(iso(range!.to)).toBe("2026-09-19T07:00:00.000Z");
  });

  it("day-after-tomorrow / 后天 is matched before the plain tomorrow / 明天 rule", () => {
    const en = querySignals("day after tomorrow we ship", NOW, TZ);
    const cn = querySignals("后天开会", NOW, TZ);
    expect(iso(en.range!.from)).toBe("2026-09-17T07:00:00.000Z");
    expect(iso(cn.range!.from)).toBe("2026-09-17T07:00:00.000Z");
  });
});

describe("querySignals: DST transition (America/Vancouver, 2026-11-01)", () => {
  it("yesterday spans the 25-hour fall-back day when evaluated the day after", () => {
    const now = Date.parse("2026-11-02T20:00:00Z"); // 12:00 PST
    const { range } = querySignals("yesterday's meeting notes", now, TZ);
    // 2026-11-01 00:00 local is still PDT (-7); 2026-11-02 00:00 local is PST (-8).
    expect(iso(range!.from)).toBe("2026-11-01T07:00:00.000Z");
    expect(iso(range!.to)).toBe("2026-11-02T08:00:00.000Z");
    expect(range!.to - range!.from).toBe(25 * 60 * 60 * 1000);
  });

  it("today stays a plain 24h day when evaluated before the transition", () => {
    const now = Date.parse("2026-10-31T18:00:00Z"); // 11:00 PDT
    const { range } = querySignals("today's standup", now, TZ);
    expect(iso(range!.from)).toBe("2026-10-31T07:00:00.000Z");
    expect(iso(range!.to)).toBe("2026-11-01T07:00:00.000Z");
    expect(range!.to - range!.from).toBe(24 * 60 * 60 * 1000);
  });

  it("last week's range is 169h when the transition falls inside that week", () => {
    const now = Date.parse("2026-11-03T18:00:00Z"); // Tue, after transition
    const { range } = querySignals("last week's agenda", now, TZ);
    expect(iso(range!.from)).toBe("2026-10-26T07:00:00.000Z");
    expect(iso(range!.to)).toBe("2026-11-02T08:00:00.000Z");
    expect(range!.to - range!.from).toBe(169 * 60 * 60 * 1000);
  });

  it("in 3 days resolves the target day's own (correct) offset, not now's offset", () => {
    // "now" is still PDT (Oct 30); the target day (Nov 2) is already PST.
    const now = Date.parse("2026-10-30T18:00:00Z");
    const { range } = querySignals("in 3 days we meet again", now, TZ);
    expect(iso(range!.from)).toBe("2026-11-02T08:00:00.000Z");
    expect(iso(range!.to)).toBe("2026-11-03T08:00:00.000Z");
  });
});

describe("querySignals: tags and cleaned", () => {
  const NOW = Date.parse("2026-09-01T00:00:00Z");

  it("strips the matched time phrase from `cleaned` and derives tags from the remainder", () => {
    const { range, tags, cleaned } = querySignals("报价 quotation 下周 deadline", NOW, TZ);
    expect(range).toBeDefined();
    expect(cleaned).toBe("报价 quotation deadline");
    expect(tags).toContain("quotation");
    expect(tags).toContain("deadline");
    // "报价" is 2 chars, below the >=3 char tag gate -- correctly excluded.
    expect(tags).not.toContain("报价");
  });

  it("no time expression -> no range, cleaned is just whitespace-normalised query", () => {
    const result = querySignals("  what's   the roadmap status  ", NOW, TZ);
    expect(result.range).toBeUndefined();
    expect(result.cleaned).toBe("what's the roadmap status");
  });

  it("tags: hyphenated identifiers are extracted whole and by part", () => {
    const { tags } = querySignals("who touched deploy-pipeline last week", NOW, TZ);
    expect(tags).toContain("deploy-pipeline");
    expect(tags).toContain("deploy");
    expect(tags).toContain("pipeline");
  });
});
