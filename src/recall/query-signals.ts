/**
 * Deterministic query-side signal inference -- 0 LLM, 0 embedding calls.
 *
 * Ported from nextclaw-cloud's src/recall/query-signals.ts:
 *   - concept-tag extraction: inferConceptTagsFromQuery, unchanged (same
 *     regex rules), renamed `extractTags` and made private -- v2 exposes it
 *     only as the `tags` field of `querySignals`.
 *   - temporal inference: inferTimeBucketsFromQuery ported in spirit, not
 *     byte-for-byte. nextclaw-cloud works in UTC day buckets and only
 *     recognises past expressions; v2 needs actual IANA-timezone-correct UTC
 *     instants (Meeting Note runs across timezones and DST) and symmetric
 *     future expressions (querying upcoming scheduled meetings), so the range
 *     math below is a new implementation built for that contract. See the
 *     "temporal range rules" section for the exact mapping.
 *
 * No dependencies: only Intl (for timezone-aware calendar math), matching the
 * Workers-only constraint.
 */

export interface TimeRange {
  /** UTC epoch ms, inclusive. */
  from: number;
  /** UTC epoch ms, exclusive. */
  to: number;
}

export interface QuerySignals {
  /** Only present when a past/future time expression was recognised. */
  range?: TimeRange;
  /** Up to 8 salient tokens from the query, longest first (see extractTags). */
  tags: string[];
  /** `query` with the matched time expression removed and whitespace collapsed. */
  cleaned: string;
}

export function querySignals(query: string, now: number, timeZone: string): QuerySignals {
  const today = zonedYmd(now, timeZone);
  const match = findTimeMatch(query, today, timeZone);

  const cleaned = normalizeWhitespace(
    match ? query.slice(0, match.index) + query.slice(match.index + match.length) : query,
  );

  return {
    ...(match ? { range: match.range } : {}),
    tags: extractTags(cleaned),
    cleaned,
  };
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/* ------------------------------ concept tags ------------------------------ */
/** Ported as-is from nextclaw-cloud's inferConceptTagsFromQuery. */

const CT_STOP = new Set([
  "the", "and", "with", "from", "that", "this", "into", "onto", "over", "under",
  "have", "has", "had", "was", "were", "will", "would", "could", "should", "than",
]);

function extractTags(query: string): string[] {
  const seen = new Set<string>();
  const add = (t: string): void => {
    const lower = t.toLowerCase();
    if (lower.length < 3 || lower.length > 32) {
      return;
    }
    if (CT_STOP.has(lower)) {
      return;
    }
    seen.add(lower);
  };
  for (const m of query.matchAll(/[A-Za-z][A-Za-z0-9]+(?:-[A-Za-z][A-Za-z0-9]+)+/g)) {
    add(m[0]);
    for (const p of m[0].split("-")) {
      add(p);
    }
  }
  for (const m of query.matchAll(/\b[A-Za-z][a-z]+(?:[A-Z][a-z]+)+\b/g)) {
    const w = m[0];
    add(w);
    for (const p of w.split(/(?=[A-Z])/)) {
      add(p);
    }
  }
  for (const m of query.matchAll(/[一-鿿]{2,6}/g)) {
    add(m[0]);
  }
  for (const m of query.matchAll(/\b[A-Za-z][A-Za-z0-9]{3,}\b/g)) {
    add(m[0]);
  }
  return [...seen].sort((a, b) => b.length - a.length).slice(0, 8);
}

/* -------------------------- calendar-date primitives -------------------------- */
/**
 * All range math below happens in two separate steps:
 *   1. Pure calendar arithmetic (weekday, +/- days/months) on a {y,m,d} triple,
 *      done with Date's UTC getters/setters as a proleptic-Gregorian
 *      calculator only -- never as a real instant.
 *   2. Converting a {y,m,d} local midnight to a real UTC instant *in
 *      `timeZone`*, via `zonedYmdToUtc`, which is the only place DST offsets
 *      matter.
 * Keeping these separate is what makes "this week"/"this month" etc. correct
 * across a DST transition without special-casing it anywhere.
 */

interface Ymd {
  y: number;
  m: number; // 1-12
  d: number;
}

function calDate(ymd: Ymd): Date {
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d));
}

function fromCalDate(d: Date): Ymd {
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function addDays(ymd: Ymd, n: number): Ymd {
  const d = calDate(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return fromCalDate(d);
}

function addMonths(ymd: Ymd, n: number): Ymd {
  const d = calDate(ymd);
  d.setUTCMonth(d.getUTCMonth() + n, 1);
  return fromCalDate(d);
}

function startOfMonth(ymd: Ymd): Ymd {
  return { y: ymd.y, m: ymd.m, d: 1 };
}

/** ISO weekday, Monday-first: 0 = Monday .. 6 = Sunday. */
function isoWeekday(ymd: Ymd): number {
  const dow = calDate(ymd).getUTCDay(); // 0 (Sun) .. 6 (Sat)
  return dow === 0 ? 6 : dow - 1;
}

function startOfWeek(ymd: Ymd): Ymd {
  return addDays(ymd, -isoWeekday(ymd));
}

/* --------------------------- timezone conversion --------------------------- */

function zonedParts(utcMs: number, timeZone: string): Ymd & { hour: number; minute: number; second: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }
  return {
    y: Number(map.year),
    m: Number(map.month),
    d: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function zonedYmd(utcMs: number, timeZone: string): Ymd {
  const p = zonedParts(utcMs, timeZone);
  return { y: p.y, m: p.m, d: p.d };
}

/** Offset (ms) such that `local = utc + offset`, at the instant `utcMs`. */
function tzOffsetMs(timeZone: string, utcMs: number): number {
  const p = zonedParts(utcMs, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, p.second);
  return asUtc - utcMs;
}

/**
 * Local midnight of `ymd` in `timeZone`, as a UTC epoch ms. Two-pass offset
 * correction (standard zoned-time-to-UTC trick): guess assuming offset 0,
 * read the real offset at that guess, correct, then re-check in case the
 * correction crossed the DST transition itself.
 */
function zonedYmdToUtc(ymd: Ymd, timeZone: string): number {
  const guess = Date.UTC(ymd.y, ymd.m - 1, ymd.d, 0, 0, 0);
  const offset1 = tzOffsetMs(timeZone, guess);
  const candidate = guess - offset1;
  const offset2 = tzOffsetMs(timeZone, candidate);
  return offset2 === offset1 ? candidate : guess - offset2;
}

function dayRange(ymd: Ymd, timeZone: string): TimeRange {
  return { from: zonedYmdToUtc(ymd, timeZone), to: zonedYmdToUtc(addDays(ymd, 1), timeZone) };
}

function weekRange(startYmd: Ymd, timeZone: string): TimeRange {
  return {
    from: zonedYmdToUtc(startYmd, timeZone),
    to: zonedYmdToUtc(addDays(startYmd, 7), timeZone),
  };
}

function monthRange(startYmd: Ymd, timeZone: string): TimeRange {
  return {
    from: zonedYmdToUtc(startYmd, timeZone),
    to: zonedYmdToUtc(addMonths(startYmd, 1), timeZone),
  };
}

/* ----------------------------- temporal range rules ----------------------------- */
/**
 * Mapping to nextclaw-cloud's inferTimeBucketsFromQuery, by rule:
 *   today/yesterday/this week/last week/this month/last month/N days ago --
 *     same trigger phrases (今天/昨天/本周.../这周/上周/本月/这个月/上周/N天前 +
 *     English equivalents); range semantics upgraded from UTC day-bucket keys
 *     to real timezone-correct whole-unit ranges (see file header).
 *   前天 (day before yesterday) -- kept from the original (大前天 dropped, not
 *     in v2's spec).
 *   tomorrow/day after tomorrow/next week/next month/in N days/明天/后天/下周/
 *     下个月/N天后 -- new, mirroring the past rules symmetrically (Meeting
 *     Note can hold notes for scheduled future meetings).
 *   explicit ISO/CN dates -- not ported; not in v2's spec.
 *
 * Order matters only where one phrase is a substring of another: "day after
 * tomorrow"/后天 must be checked before "tomorrow"/明天.
 */

type RangeBuilder = (today: Ymd, timeZone: string, m: RegExpExecArray) => TimeRange;

interface TimeRule {
  re: RegExp;
  toRange: RangeBuilder;
}

function clampDays(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isNaN(n) ? 0 : Math.max(0, Math.min(365, n));
}

const TIME_RULES: TimeRule[] = [
  { re: /\btoday\b|今天|今儿/i, toRange: (t, tz) => dayRange(t, tz) },
  { re: /\byesterday\b|昨天|昨儿/i, toRange: (t, tz) => dayRange(addDays(t, -1), tz) },
  { re: /前天/, toRange: (t, tz) => dayRange(addDays(t, -2), tz) },
  { re: /\bday after tomorrow\b|后天/i, toRange: (t, tz) => dayRange(addDays(t, 2), tz) },
  { re: /\btomorrow\b|明天/i, toRange: (t, tz) => dayRange(addDays(t, 1), tz) },
  {
    re: /(\d{1,3})\s*天前|\b(\d{1,3})\s+days?\s+ago\b/i,
    toRange: (t, tz, m) => dayRange(addDays(t, -clampDays(m[1] ?? m[2])), tz),
  },
  {
    re: /(\d{1,3})\s*天后|\bin\s+(\d{1,3})\s+days?\b/i,
    toRange: (t, tz, m) => dayRange(addDays(t, clampDays(m[1] ?? m[2])), tz),
  },
  { re: /\bthis week\b|本周|这周/i, toRange: (t, tz) => weekRange(startOfWeek(t), tz) },
  { re: /\blast week\b|上周/i, toRange: (t, tz) => weekRange(addDays(startOfWeek(t), -7), tz) },
  { re: /\bnext week\b|下周/i, toRange: (t, tz) => weekRange(addDays(startOfWeek(t), 7), tz) },
  { re: /\bthis month\b|本月|这个月/i, toRange: (t, tz) => monthRange(startOfMonth(t), tz) },
  { re: /\blast month\b|上个月/i, toRange: (t, tz) => monthRange(addMonths(startOfMonth(t), -1), tz) },
  { re: /\bnext month\b|下个月/i, toRange: (t, tz) => monthRange(addMonths(startOfMonth(t), 1), tz) },
];

interface TimeMatch {
  range: TimeRange;
  index: number;
  length: number;
}

function findTimeMatch(query: string, today: Ymd, timeZone: string): TimeMatch | null {
  for (const rule of TIME_RULES) {
    const m = rule.re.exec(query);
    if (m) {
      return { range: rule.toRange(today, timeZone, m), index: m.index, length: m[0].length };
    }
  }
  return null;
}
