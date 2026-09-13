import { z } from "zod";
import type { MeetingSummary } from "./summary";

/** Roughly how much transcribed audio one rolling note covers. */
export const SEGMENT_TARGET_MS = 5 * 60 * 1000;

/** Used when a chunk arrived without a usable client-reported duration. */
export const ASSUMED_CHUNK_MS = 3 * 60 * 1000;

export const SegmentNoteSchema = z.object({
  headline: z.string(),
  bullets: z.array(z.string()),
  decisions: z.array(z.string()),
  questions: z.array(z.object({
    question: z.string(),
    answer: z.string().default("")
  })),
  action_items: z.array(z.object({
    task: z.string(),
    owner: z.string().default("Unassigned"),
    due: z.string().default("")
  })),
  tools: z.array(z.string()),
  resources: z.array(z.string()),
  quotes: z.array(z.object({
    chunk: z.number().int().nonnegative(),
    quote: z.string()
  }))
});

export type SegmentNote = z.infer<typeof SegmentNoteSchema>;

export const segmentJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    headline: { type: "string" },
    bullets: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { question: { type: "string" }, answer: { type: "string" } },
        required: ["question", "answer"]
      }
    },
    action_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { task: { type: "string" }, owner: { type: "string" }, due: { type: "string" } },
        required: ["task", "owner", "due"]
      }
    },
    tools: { type: "array", items: { type: "string" } },
    resources: { type: "array", items: { type: "string" } },
    quotes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { chunk: { type: "integer" }, quote: { type: "string" } },
        required: ["chunk", "quote"]
      }
    }
  },
  required: ["headline", "bullets", "decisions", "questions", "action_items", "tools", "resources", "quotes"]
} as const;

export interface ChunkState {
  sequence: number;
  status: string;
  duration_ms: number;
}

export interface SegmentPlan {
  /** Last chunk this segment would cover, or -1 when nothing can be covered. */
  endChunk: number;
  accumulatedMs: number;
  /** Whether the segment should be created now. */
  ready: boolean;
}

/**
 * Decide which chunks the next rolling segment covers.
 *
 * Segments must stay contiguous and in order, so anything not yet transcribed
 * stops the walk and the segment waits. `force` is close-out mode: skip over
 * whatever will never arrive so the meeting can still produce a note.
 */
export function planSegment(rows: ChunkState[], startChunk: number, targetMs: number, force: boolean): SegmentPlan {
  let expected = startChunk;
  let accumulated = 0;
  let endChunk = -1;

  for (const row of rows) {
    if (row.sequence < startChunk) continue;
    if (row.sequence !== expected && !force) break; // a chunk in the middle never uploaded
    if (row.status === "done") {
      accumulated += row.duration_ms > 0 ? row.duration_ms : ASSUMED_CHUNK_MS;
      endChunk = row.sequence;
    } else if (force) {
      endChunk = row.sequence; // failed, or still unfinished at close-out
    } else {
      break;
    }
    expected = row.sequence + 1;
    if (accumulated >= targetMs) break;
  }

  return {
    endChunk,
    accumulatedMs: accumulated,
    ready: endChunk >= startChunk && (force || accumulated >= targetMs)
  };
}

export interface SegmentChunk {
  sequence: number;
  transcript_text: string | null;
}

export function segmentPrompt(chunks: SegmentChunk[], minutesLabel: string): string {
  const body = chunks
    .map((chunk) => `[CHUNK ${chunk.sequence}]\n${(chunk.transcript_text ?? "").trim()}`)
    .join("\n\n");
  return `This is roughly five minutes of a longer meeting (${minutesLabel}). Summarise only what is in this excerpt. Do not speculate about what came before or after, and do not invent owners, deadlines, answers or promises. Quotes must be short verbatim excerpts with their zero-based [CHUNK n] number. If a field has nothing in this excerpt, return an empty array or an empty string.\n\n${body}`;
}

/** A model can return valid JSON with nothing in it; that is no note at all. */
export function segmentNoteHasContent(note: SegmentNote): boolean {
  return note.bullets.some((item) => item.trim())
    || note.decisions.some((item) => item.trim())
    || note.questions.some((item) => item.question.trim() || item.answer.trim())
    || note.action_items.some((item) => item.task.trim())
    || note.tools.some((item) => item.trim())
    || note.resources.some((item) => item.trim());
}

/** A transcript-grounded note used when the model output cannot be parsed. */
export function fallbackSegmentNote(chunks: SegmentChunk[]): SegmentNote {
  const usable = chunks
    .map((chunk) => ({ sequence: chunk.sequence, text: (chunk.transcript_text || "").trim() }))
    .filter((chunk) => chunk.text);
  const joined = usable.map((chunk) => chunk.text).join(" ");
  return SegmentNoteSchema.parse({
    headline: joined.slice(0, 120) || "No speech was transcribed in this section",
    bullets: usable.slice(0, 4).map((chunk) => chunk.text.slice(0, 280)),
    decisions: [],
    questions: [],
    action_items: [],
    tools: [],
    resources: [],
    quotes: usable.slice(0, 2).map((chunk) => ({ chunk: chunk.sequence, quote: chunk.text.slice(0, 180) }))
  });
}

export interface StoredSegment {
  seq: number;
  start_chunk: number;
  end_chunk: number;
  status: string;
  notes_json: string | null;
}

export function parseSegmentNote(value: string | null): SegmentNote | null {
  if (!value) return null;
  try {
    return SegmentNoteSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Compact text handed to the final merge pass — this is what keeps it small. */
export function segmentsToPromptText(segments: StoredSegment[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    const note = parseSegmentNote(segment.notes_json);
    if (!note) continue;
    const lines = [
      `SECTION ${segment.seq + 1} (chunks ${segment.start_chunk}-${segment.end_chunk})`,
      `Headline: ${note.headline}`
    ];
    if (note.bullets.length) lines.push(`Points: ${note.bullets.join(" | ")}`);
    if (note.decisions.length) lines.push(`Decisions: ${note.decisions.join(" | ")}`);
    if (note.questions.length) lines.push(`Questions: ${note.questions.map((item) => `Q: ${item.question}${item.answer ? ` A: ${item.answer}` : ""}`).join(" | ")}`);
    if (note.action_items.length) lines.push(`Actions: ${note.action_items.map((item) => `${item.task}${item.owner ? ` (owner ${item.owner})` : ""}${item.due ? ` (due ${item.due})` : ""}`).join(" | ")}`);
    if (note.tools.length) lines.push(`Tools: ${note.tools.join(", ")}`);
    if (note.resources.length) lines.push(`Resources: ${note.resources.join(", ")}`);
    if (note.quotes.length) lines.push(`Quotes: ${note.quotes.map((item) => `[CHUNK ${item.chunk}] "${item.quote}"`).join(" | ")}`);
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

/**
 * Deterministic merge of segment notes into the final shape.
 *
 * Used as the fallback when the model's merge cannot be parsed, so a meeting
 * always produces a usable note as long as at least one segment succeeded.
 */
export function mergeSegments(segments: StoredSegment[]): MeetingSummary {
  const notes = segments
    .map((segment) => ({ segment, note: parseSegmentNote(segment.notes_json) }))
    .filter((entry): entry is { segment: StoredSegment; note: SegmentNote } => entry.note !== null);

  const unique = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];

  return {
    overview: unique(notes.map((entry) => entry.note.headline)).join(" ").slice(0, 1500),
    chapters: notes.map((entry) => ({
      title: entry.note.headline.slice(0, 90) || `Part ${entry.segment.seq + 1}`,
      summary: [...entry.note.bullets, ...entry.note.decisions].join(" ").slice(0, 700),
      start_chunk: entry.segment.start_chunk
    })),
    key_points: unique(notes.flatMap((entry) => entry.note.bullets)).slice(0, 14),
    tools_mentioned: unique(notes.flatMap((entry) => entry.note.tools)),
    audience_questions: notes.flatMap((entry) => entry.note.questions),
    action_items: notes.flatMap((entry) => entry.note.action_items),
    resources_promised: unique(notes.flatMap((entry) => entry.note.resources)),
    follow_up_message: "",
    evidence: notes.flatMap((entry) =>
      entry.note.quotes.map((quote) => ({ claim: entry.note.headline, chunk: quote.chunk, quote: quote.quote }))
    ).slice(0, 20)
  };
}

/**
 * Whether any segment captured something beyond a headline.
 *
 * A meeting that recorded only silence has nothing to merge, so the final pass
 * skips the model rather than spending a call to restate empty sections.
 */
export function segmentsHaveContent(segments: StoredSegment[]): boolean {
  return segments.some((segment) => {
    const note = parseSegmentNote(segment.notes_json);
    if (!note) return false;
    return note.bullets.length > 0 || note.decisions.length > 0 || note.questions.length > 0
      || note.action_items.length > 0 || note.tools.length > 0 || note.resources.length > 0
      || note.quotes.length > 0;
  });
}

/** Running Markdown while the meeting is still in progress. */
export function segmentsToMarkdown(title: string, segments: StoredSegment[]): string {
  const lines = [`# ${title}`, "", "_Running notes — this meeting has not been finalised yet._", ""];
  for (const segment of segments) {
    const note = parseSegmentNote(segment.notes_json);
    lines.push(`## Section ${segment.seq + 1}${note ? ` · ${note.headline}` : ""}`, "");
    if (!note) {
      lines.push(segment.status === "failed" ? "_This section could not be summarised._" : "_This section is still being written._", "");
      continue;
    }
    for (const bullet of note.bullets) lines.push(`- ${bullet}`);
    if (note.decisions.length) {
      lines.push("", "**Decisions**", "");
      for (const decision of note.decisions) lines.push(`- ${decision}`);
    }
    if (note.action_items.length) {
      lines.push("", "**Action items**", "");
      for (const item of note.action_items) {
        const suffix = [item.owner && `Owner: ${item.owner}`, item.due && `Due: ${item.due}`].filter(Boolean).join(" · ");
        lines.push(`- [ ] ${item.task}${suffix ? ` — ${suffix}` : ""}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
