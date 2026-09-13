import { describe, expect, it } from "vitest";
import { resolveDatePhrase } from "../src/dates";

const VANCOUVER = "America/Vancouver";
// Saturday 2026-09-12, 20:00 in Vancouver.
const SATURDAY = Date.UTC(2026, 8, 13, 3, 0);
// Monday 2026-09-14, 09:00 in Vancouver.
const MONDAY = Date.UTC(2026, 8, 14, 16, 0);

const on = (phrase: string, now = SATURDAY) => resolveDatePhrase(phrase, now, VANCOUVER);

describe("Chinese date words", () => {
  it("counts days from today in the owner's time zone", () => {
    expect(on("今天")).toBe("2026-09-12");
    expect(on("今晚七点")).toBe("2026-09-12");
    expect(on("明天下午三点")).toBe("2026-09-13");
    expect(on("明早")).toBe("2026-09-13");
    expect(on("后天")).toBe("2026-09-14");
    expect(on("大后天")).toBe("2026-09-15");
    expect(on("三天后")).toBe("2026-09-15");
    expect(on("10天以后")).toBe("2026-09-22");
    expect(on("两天之后")).toBe("2026-09-14");
  });

  it("reads weekdays by the week they fall in", () => {
    expect(on("下周二")).toBe("2026-09-15");
    expect(on("下周二", MONDAY)).toBe("2026-09-22");
    expect(on("下个星期五")).toBe("2026-09-18");
    expect(on("下下周一")).toBe("2026-09-21");
    expect(on("周二", MONDAY)).toBe("2026-09-15");
    expect(on("礼拜天")).toBe("2026-09-13");
    expect(on("这周五", MONDAY)).toBe("2026-09-18");
    expect(on("这周五")).toBeNull(); // already past on Saturday: leave it to the model
  });

  it("knows month ends and written dates", () => {
    expect(on("月底之前")).toBe("2026-09-30");
    expect(on("下个月底")).toBe("2026-10-31");
    expect(on("下个月初")).toBe("2026-10-01");
    expect(on("9月22号")).toBe("2026-09-22");
    expect(on("十月一日")).toBe("2026-10-01");
    expect(on("二月三十号")).toBeNull();
    expect(on("1月5号")).toBe("2027-01-05");
  });
});

describe("English date words", () => {
  it("counts days and reads weekdays the same way", () => {
    expect(on("tonight")).toBe("2026-09-12");
    expect(on("tomorrow morning")).toBe("2026-09-13");
    expect(on("the day after tomorrow")).toBe("2026-09-14");
    expect(on("next Tuesday")).toBe("2026-09-15");
    expect(on("next Tuesday", MONDAY)).toBe("2026-09-22");
    expect(on("by Friday")).toBe("2026-09-18");
    expect(on("on Sunday")).toBe("2026-09-13");
    expect(on("this Wednesday", MONDAY)).toBe("2026-09-16");
    expect(on("in 3 days")).toBe("2026-09-15");
    expect(on("in two weeks")).toBe("2026-09-26");
    expect(on("end of the month")).toBe("2026-09-30");
  });

  it("reads month names either way round", () => {
    expect(on("September 22nd")).toBe("2026-09-22");
    expect(on("22 Sept")).toBe("2026-09-22");
    expect(on("the 3rd of October")).toBe("2026-10-03");
    expect(on("Jan 5")).toBe("2027-01-05");
  });

  it("returns nothing for words it doesn't know", () => {
    expect(on("")).toBeNull();
    expect(on("sometime soon")).toBeNull();
    expect(on("next week")).toBeNull();
  });
});

describe("words that only look like dates", () => {
  it("doesn't read month words as Monday, and knows 'Tuesday next week'", () => {
    const MONDAY_14 = Date.UTC(2026, 8, 14, 16, 0);
    for (const phrase of ["next month", "by next month", "month end", "monthly", "this month", "next week", "sunny afternoon"]) {
      expect(resolveDatePhrase(phrase, MONDAY_14, VANCOUVER), phrase).toBeNull();
    }
    expect(resolveDatePhrase("Tuesday next week", MONDAY_14, VANCOUVER)).toBe("2026-09-22");
    expect(resolveDatePhrase("Tue.", MONDAY_14, VANCOUVER)).toBe("2026-09-15");
    expect(resolveDatePhrase("thurs", MONDAY_14, VANCOUVER)).toBe("2026-09-17");
  });

  it("puts a month and day from last week in the past, not next year", () => {
    const JAN_3_2027 = Date.UTC(2027, 0, 3, 20, 0);
    expect(resolveDatePhrase("12月31日", JAN_3_2027, VANCOUVER)).toBe("2026-12-31");
    expect(resolveDatePhrase("December 31", JAN_3_2027, VANCOUVER)).toBe("2026-12-31");
  });
});

describe("clock times in a to-do's due words", () => {
  it("reads twelve-hour and Chinese times", async () => {
    const { clockTimeIn, isoDateIn } = await import("../src/dates");
    expect(clockTimeIn("Friday 3:00 PM")).toBe("15:00");
    expect(clockTimeIn("by 9:30pm")).toBe("21:30");
    expect(clockTimeIn("12 a.m.")).toBe("00:00");
    expect(clockTimeIn("周五下午3:00")).toBe("15:00");
    expect(clockTimeIn("晚上六点半")).toBe("18:30");
    expect(clockTimeIn("中午12点")).toBe("12:00");
    expect(clockTimeIn("中午1点")).toBe("13:00");
    expect(clockTimeIn("上午10点15分")).toBe("10:15");
    expect(clockTimeIn("9月22日18:30")).toBe("18:30");
    expect(clockTimeIn("下周二之前")).toBeNull();
    expect(clockTimeIn("Q3 planning")).toBeNull();
    expect(isoDateIn("下周二之前 (2026-09-15)")).toBe("2026-09-15");
    expect(isoDateIn("2026-02-30")).toBeNull();
  });
});
