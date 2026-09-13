import { utcToLocalParts } from "./calendar";
import { addDays } from "./tasks";

// The date words people say ("明天", "下周二", "by Friday", "9月22号"), turned into a date by rule.
// The model copies the words out of what was said; this does the arithmetic, which models get
// wrong now and then even with a calendar in front of them. Anything it doesn't recognise
// returns null, and the model's own date stands.
//
// Weeks start on Monday. "下周二" / "next Tuesday" is Tuesday of next week; a weekday on its own
// is the first one after today.

const ZH_WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 末: 6 };
const EN_WEEKDAY: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
const EN_MONTH: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ZH_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** "3", "十", "十五", "二十一", "两" → a number. */
function zhNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  if (!value || ![...value].every((character) => character in ZH_DIGIT || character === "十")) return null;
  if (!value.includes("十")) return value.length === 1 ? ZH_DIGIT[value] : null;
  const [tens, ones] = value.split("十");
  return (tens ? ZH_DIGIT[tens] ?? NaN : 1) * 10 + (ones ? ZH_DIGIT[ones] ?? NaN : 0) || null;
}

/** ISO weekday: Monday 1 … Sunday 7. */
function isoWeekday(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
}

function lastDayOfMonth(date: string, monthsAhead: number): string {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month + monthsAhead, 0)).toISOString().slice(0, 10);
}

function firstDayOfMonth(date: string, monthsAhead: number): string {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + monthsAhead, 1)).toISOString().slice(0, 10);
}

/** The weekday in the week `weeksAhead` from this one. */
function weekdayInWeek(today: string, weekday: number, weeksAhead: number): string {
  const monday = addDays(today, 1 - isoWeekday(today));
  return addDays(monday, weeksAhead * 7 + weekday - 1);
}

/** The first such weekday after today. */
function nextWeekday(today: string, weekday: number): string {
  const ahead = (weekday - isoWeekday(today) + 7) % 7 || 7;
  return addDays(today, ahead);
}

/** A month and day with no year: this year's, unless that is well past, then next year's. */
function monthDay(today: string, month: number, day: number): string | null {
  const year = Number(today.slice(0, 4));
  for (const candidate of [year, year + 1]) {
    const date = new Date(Date.UTC(candidate, month - 1, day));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    const iso = date.toISOString().slice(0, 10);
    if (iso >= addDays(today, -7)) return iso;
  }
  return null;
}

export function resolveDatePhrase(phrase: string, now: number, timeZone: string): string | null {
  const today = utcToLocalParts(now, timeZone).date;
  const zh = phrase.replace(/\s+/g, "");
  const en = phrase.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  if (!zh) return null;

  // Chinese
  if (/^(今天|今日|今晚|今早|今天晚上|今天下午|今天上午)/.test(zh)) return today;
  if (/^大后天/.test(zh)) return addDays(today, 3);
  if (/^后天/.test(zh)) return addDays(today, 2);
  if (/^(明天|明日|明早|明晚)/.test(zh)) return addDays(today, 1);

  let match = /^(下下|下|这|本)?(?:个)?(?:周|星期|礼拜)([一二三四五六日天末])/.exec(zh);
  if (match) {
    const weekday = ZH_WEEKDAY[match[2]];
    if (match[1] === "下下") return weekdayInWeek(today, weekday, 2);
    if (match[1] === "下") return weekdayInWeek(today, weekday, 1);
    if (match[1] === "这" || match[1] === "本") {
      const date = weekdayInWeek(today, weekday, 0);
      return date >= today ? date : null;
    }
    return nextWeekday(today, weekday);
  }

  if (/^(这个|本)?月底/.test(zh)) return lastDayOfMonth(today, 0);
  if (/^下(个)?月底/.test(zh)) return lastDayOfMonth(today, 1);
  if (/^下(个)?月初/.test(zh)) return firstDayOfMonth(today, 1);

  match = /^([\d零一二两三四五六七八九十]+)天(以后|之后|后)/.exec(zh);
  if (match) {
    const days = zhNumber(match[1]);
    return days !== null && days > 0 && days <= 366 ? addDays(today, days) : null;
  }

  match = /^([\d一二三四五六七八九十]+)月([\d一二三四五六七八九十]+)(号|日)/.exec(zh);
  if (match) {
    const month = zhNumber(match[1]);
    const day = zhNumber(match[2]);
    return month && day ? monthDay(today, month, day) : null;
  }

  // English
  const bare = en.replace(/^(by|on|before|this coming|until|due)\s+/, "");
  if (/^(today|tonight|this (morning|afternoon|evening))\b/.test(bare)) return today;
  if (/^(the )?day after tomorrow\b/.test(bare)) return addDays(today, 2);
  if (/^tomorrow\b/.test(bare)) return addDays(today, 1);

  match = /^(next |this )?(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/.exec(bare);
  if (match) {
    const weekday = EN_WEEKDAY[match[2]];
    if (match[1] === "next ") return weekdayInWeek(today, weekday, 1);
    if (match[1] === "this ") {
      const date = weekdayInWeek(today, weekday, 0);
      return date >= today ? date : null;
    }
    return nextWeekday(today, weekday);
  }

  if (/^(the )?end of (the |this )?month\b/.test(bare)) return lastDayOfMonth(today, 0);
  if (/^(the )?end of next month\b/.test(bare)) return lastDayOfMonth(today, 1);

  match = /^in (\d{1,3}|a|one|two|three|four|five|six|seven) (day|week)s?\b/.exec(bare);
  if (match) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    const count = words[match[1]] ?? Number(match[1]);
    return addDays(today, count * (match[2] === "week" ? 7 : 1));
  }

  const dated = bare.replace(/^the /, "");
  match = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* (?:the )?(\d{1,2})(st|nd|rd|th)?\b/.exec(dated)
    ?? /^(\d{1,2})(?:st|nd|rd|th)? (?:of )?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.exec(dated);
  if (match) {
    const [month, day] = /^\d/.test(match[1]) ? [EN_MONTH[match[2]], Number(match[1])] : [EN_MONTH[match[1]], Number(match[2])];
    return monthDay(today, month, day);
  }

  return null;
}
