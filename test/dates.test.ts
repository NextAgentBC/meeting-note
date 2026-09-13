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
