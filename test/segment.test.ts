import { describe, expect, it } from "vitest";
import {
  SegmentNoteSchema,
  fallbackSegmentNote,
  mergeSegments,
  parseSegmentNote,
  planSegment,
  segmentPrompt,
  segmentsToMarkdown,
  segmentsToPromptText,
  type StoredSegment
} from "../src/segment";
import { SummarySchema, toMarkdown } from "../src/summary";

function note(overrides: Record<string, unknown> = {}) {
  return SegmentNoteSchema.parse({
    headline: "Opening and the free toolbox",
    bullets: ["Free tools only", "Four hands-on rounds"],
    decisions: ["No product pitch tonight"],
    questions: [{ question: "Is it private?", answer: "Access is restricted." }],
    action_items: [{ task: "Send the handout", owner: "Sam", due: "Tomorrow" }],
    tools: ["ChatGPT", "NotebookLM"],
    resources: ["Workshop handout"],
    quotes: [{ chunk: 2, quote: "There is no product at the end of this" }],
    ...overrides
  });
}

function stored(seq: number, overrides: Partial<StoredSegment> = {}): StoredSegment {
  return {
    seq,
    start_chunk: seq * 2,
    end_chunk: seq * 2 + 1,
    status: "done",
    notes_json: JSON.stringify(note()),
    ...overrides
  };
}

describe("segment notes", () => {
  it("keeps chunk numbers in the segment prompt", () => {
    const prompt = segmentPrompt([{ sequence: 4, transcript_text: "hello there" }], "section 3", "2026-09-15T09:00:00.000Z");
    expect(prompt).toContain("[CHUNK 4]");
    expect(prompt).toContain("hello there");
    expect(prompt).toContain("section 3");
  });

  it("tells the model the meeting's start time and time zone, defaulting the zone to UTC", () => {
    const defaulted = segmentPrompt([{ sequence: 0, transcript_text: "hello" }], "section 1", "2026-09-15T09:00:00.000Z");
    expect(defaulted).toContain("2026-09-15T09:00:00.000Z");
    expect(defaulted).toContain("time zone UTC");

    const zoned = segmentPrompt([{ sequence: 0, transcript_text: "hello" }], "section 1", "2026-09-15T09:00:00.000Z", "America/Vancouver");
    expect(zoned).toContain("time zone America/Vancouver");
  });

  it("requires grounded details for a non-empty transcript in the prompt", () => {
    const prompt = segmentPrompt([{ sequence: 4, transcript_text: "hello there" }], "section 3", "2026-09-15T09:00:00.000Z");
    expect(prompt).toContain("bullets MUST contain");
    expect(prompt).toContain("quotes MUST contain");
    expect(prompt).toContain("我明天发");
    expect(prompt).toContain("chatGDP/chatsdp");
    expect(prompt).toContain("DeepSeek");
    expect(prompt).toContain("the date in brackets");
    expect(prompt).toContain("下周二之前 (2026-09-15)");
  });

  it("returns null for unparseable stored notes instead of throwing", () => {
    expect(parseSegmentNote(null)).toBeNull();
    expect(parseSegmentNote("not json")).toBeNull();
    expect(parseSegmentNote(JSON.stringify({ headline: "missing fields" }))).toBeNull();
    expect(parseSegmentNote(JSON.stringify(note()))?.headline).toBe("Opening and the free toolbox");
  });

  it("builds a transcript-grounded fallback when the model output is unusable", () => {
    const fallback = fallbackSegmentNote([
      { sequence: 0, transcript_text: "  first part  " },
      { sequence: 1, transcript_text: "" }
    ]);
    expect(fallback.headline).toContain("first part");
    expect(fallback.quotes).toHaveLength(1);
    expect(fallback.quotes[0]?.chunk).toBe(0);
  });

  it("describes a silent segment rather than failing", () => {
    const fallback = fallbackSegmentNote([{ sequence: 7, transcript_text: "   " }]);
    expect(fallback.headline).toBe("No speech was transcribed in this section");
    expect(fallback.bullets).toEqual([]);
  });
});

describe("final merge", () => {
  it("compacts segments into a short prompt that keeps chunk references", () => {
    const text = segmentsToPromptText([stored(0), stored(1)]);
    expect(text).toContain("SECTION 1 (chunks 0-1)");
    expect(text).toContain("SECTION 2 (chunks 2-3)");
    expect(text).toContain("[CHUNK 2]");
    // The whole point of segmenting: the merge input stays small.
    expect(text.length).toBeLessThan(2000);
  });

  it("skips segments that failed instead of dropping the meeting", () => {
    const text = segmentsToPromptText([
      stored(0),
      stored(1, { status: "failed", notes_json: null })
    ]);
    expect(text).toContain("SECTION 1");
    expect(text).not.toContain("SECTION 2");
  });

  it("merges deterministically into a valid final summary", () => {
    const merged = mergeSegments([stored(0), stored(1)]);
    expect(() => SummarySchema.parse(merged)).not.toThrow();
    expect(merged.chapters).toHaveLength(2);
    expect(merged.chapters[0]?.start_chunk).toBe(0);
    expect(merged.chapters[1]?.start_chunk).toBe(2);
    // Duplicate tools across segments collapse.
    expect(merged.tools_mentioned).toEqual(["ChatGPT", "NotebookLM"]);
    expect(merged.action_items).toHaveLength(2);
    // Duplicate decisions across segments collapse too.
    expect(merged.decisions).toEqual(["No product pitch tonight"]);
    expect(toMarkdown("Workshop", merged)).toContain("# Workshop");
  });

  it("still produces a summary when every segment note is missing", () => {
    const merged = mergeSegments([stored(0, { status: "failed", notes_json: null })]);
    expect(() => SummarySchema.parse(merged)).not.toThrow();
    expect(merged.chapters).toEqual([]);
  });

  it("renders running notes for a meeting that has not finished", () => {
    const markdown = segmentsToMarkdown("Workshop", [
      stored(0),
      stored(1, { status: "queued", notes_json: null })
    ]);
    expect(markdown).toContain("Running notes");
    expect(markdown).toContain("## Section 1 · Opening and the free toolbox");
    expect(markdown).toContain("- [ ] Send the handout — Owner: Sam · Due: Tomorrow");
    expect(markdown).toContain("still being written");
  });
});

const FIVE_MIN = 5 * 60 * 1000;
const THREE_MIN = 3 * 60 * 1000;

function chunk(sequence: number, status = "done", duration_ms = THREE_MIN) {
  return { sequence, status, duration_ms };
}

describe("planSegment", () => {
  it("waits until roughly five minutes of audio has transcribed", () => {
    expect(planSegment([chunk(0)], 0, FIVE_MIN, false).ready).toBe(false);
    const plan = planSegment([chunk(0), chunk(1)], 0, FIVE_MIN, false);
    expect(plan).toEqual({ endChunk: 1, accumulatedMs: 6 * 60 * 1000, ready: true });
  });

  it("stops at the target instead of swallowing the whole meeting", () => {
    const plan = planSegment([chunk(0), chunk(1), chunk(2), chunk(3)], 0, FIVE_MIN, false);
    expect(plan.endChunk).toBe(1);
  });

  it("starts where the previous segment ended", () => {
    const rows = [chunk(0), chunk(1), chunk(2), chunk(3)];
    const plan = planSegment(rows, 2, FIVE_MIN, false);
    expect(plan).toEqual({ endChunk: 3, accumulatedMs: 6 * 60 * 1000, ready: true });
  });

  it("waits for a chunk that is still transcribing, to keep sections in order", () => {
    const plan = planSegment([chunk(0), chunk(1, "processing"), chunk(2)], 0, FIVE_MIN, false);
    expect(plan.ready).toBe(false);
    expect(plan.endChunk).toBe(0);
  });

  it("waits for a chunk that never uploaded", () => {
    // Sequence 1 is absent entirely.
    const plan = planSegment([chunk(0), chunk(2)], 0, FIVE_MIN, false);
    expect(plan.ready).toBe(false);
    expect(plan.endChunk).toBe(0);
  });

  it("will not build a section around a failed chunk while the meeting runs", () => {
    const plan = planSegment([chunk(0), chunk(1, "failed"), chunk(2)], 0, FIVE_MIN, false);
    expect(plan.ready).toBe(false);
  });

  it("skips failed, missing and unfinished chunks when closing the meeting out", () => {
    const plan = planSegment([chunk(0), chunk(1, "failed"), chunk(3, "processing"), chunk(4)], 0, FIVE_MIN, true);
    expect(plan.ready).toBe(true);
    expect(plan.endChunk).toBe(4);
    // Only the two transcribed chunks contribute audio.
    expect(plan.accumulatedMs).toBe(6 * 60 * 1000);
  });

  it("still advances at close-out when nothing transcribed, so the tail terminates", () => {
    const plan = planSegment([chunk(0, "failed"), chunk(1, "failed")], 0, FIVE_MIN, true);
    expect(plan).toEqual({ endChunk: 1, accumulatedMs: 0, ready: true });
  });

  it("reports nothing to do when no chunks remain", () => {
    expect(planSegment([], 4, FIVE_MIN, true)).toEqual({ endChunk: -1, accumulatedMs: 0, ready: false });
    expect(planSegment([chunk(0)], 1, FIVE_MIN, true).ready).toBe(false);
  });

  it("falls back to an assumed chunk length when the client reported none", () => {
    const plan = planSegment([chunk(0, "done", 0), chunk(1, "done", 0)], 0, FIVE_MIN, false);
    expect(plan.accumulatedMs).toBe(6 * 60 * 1000);
    expect(plan.ready).toBe(true);
  });

  it("honours a shorter target", () => {
    expect(planSegment([chunk(0)], 0, 2 * 60 * 1000, false).ready).toBe(true);
  });
});
