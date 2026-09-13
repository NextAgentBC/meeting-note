/**
 * timezone.ts — wall-clock (local date/time) <-> UTC instant conversion.
 *
 * Ported from nextagent-stack/apps/addons/src/timezone.ts, trimmed to just the
 * conversion primitives Meeting Note v2 needs. No Node APIs: only Intl and Date,
 * both available in the Workers runtime.
 *
 * DST correctness: a fixed UTC offset (e.g. -8 for Vancouver) breaks half the year.
 * We derive the offset from Intl.DateTimeFormat for the actual instant in question,
 * so the daylight-saving transition is always read from the runtime's tz database
 * rather than hard-coded.
 */

export interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
}

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) return cached;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, fmt);
  return fmt;
}

/** The wall-clock reading `timeZone` shows at the UTC instant `ms`. */
function wallClockIn(timeZone: string, ms: number): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found === undefined ? 0 : Number(found.value);
  };
  // en-US + hour12:false reports midnight as "24" in some engines; normalize to 0.
  const hour = pick("hour") % 24;
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour,
    minute: pick("minute"),
    second: pick("second"),
  };
}

/**
 * `timeZone`'s offset from UTC (minutes, east positive) at instant `ms`.
 * Vancouver is -420 in summer (PDT) and -480 in winter (PST).
 */
function tzOffsetMinutes(timeZone: string, ms: number): number {
  const w = wallClockIn(timeZone, ms);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/**
 * Local wall-clock time in `timeZone` -> UTC epoch ms.
 *
 * Two passes: the first guesses the offset from the naive instant, the second
 * re-reads the offset at that guess and corrects for the case where the guess
 * landed on the other side of a DST transition. This covers every wall-clock
 * time except the one that falls inside a spring-forward gap (e.g. Vancouver's
 * 2:00-2:59 AM on 2026-03-08, which never actually occurs) — those normalize to
 * a nearby real instant instead of throwing.
 */
function localToUtc(timeZone: string, wall: Omit<WallClock, "second">): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const firstOffset = tzOffsetMinutes(timeZone, naive);
  const guess = naive - firstOffset * 60_000;
  const refined = naive - tzOffsetMinutes(timeZone, guess) * 60_000;
  return refined;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/** "2026-09-22" + "10:00" in `timeZone` -> UTC epoch ms. Throws RangeError on bad input. */
export function localDateTimeToUtc(timeZone: string, date: string, time: string): number {
  const d = DATE_RE.exec(date.trim());
  const t = TIME_RE.exec(time.trim());
  if (d === null) throw new RangeError(`Expected date as YYYY-MM-DD, got: ${date}`);
  if (t === null) throw new RangeError(`Expected time as HH:MM, got: ${time}`);
  return localToUtc(timeZone, {
    year: Number(d[1]),
    month: Number(d[2]),
    day: Number(d[3]),
    hour: Number(t[1]),
    minute: Number(t[2]),
  });
}

/** UTC epoch ms -> the local date/time `timeZone` shows at that instant. */
export function utcToLocalParts(ms: number, timeZone: string): LocalParts {
  const w = wallClockIn(timeZone, ms);
  return {
    date: `${String(w.year).padStart(4, "0")}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`,
    time: `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`,
  };
}

/** "2026-09-30" -> "2026-10-01". Pure calendar arithmetic, timezone-agnostic. */
export function nextLocalDate(date: string): string {
  const d = DATE_RE.exec(date.trim());
  if (d === null) throw new RangeError(`Expected date as YYYY-MM-DD, got: ${date}`);
  const at = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + 1));
  return at.toISOString().slice(0, 10);
}
