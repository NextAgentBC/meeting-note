import { describe, expect, it } from "vitest";
import { extractJson, fallbackSummary, SummarySchema, toMarkdown } from "../src/summary";

const valid = {
  overview: "A useful workshop.",
  chapters: [{ title: "Opening", summary: "Introductions", start_chunk: 0 }],
  key_points: ["Start from the business problem"],
  tools_mentioned: ["Cloudflare Workers"],
  audience_questions: [{ question: "Is it private?", answer: "Access is restricted." }],
  action_items: [{ task: "Send handout", owner: "Sam", due: "Next week" }],
  resources_promised: ["Workshop handout"],
  follow_up_message: "Thanks for joining.",
  evidence: [{ claim: "A handout was promised", chunk: 2, quote: "I will send the handout" }]
};

describe("summary helpers", () => {
  it("extracts fenced JSON", () => {
    expect(extractJson(`\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)).toEqual(valid);
  });

  it("unwraps structured Workers AI responses", () => {
    expect(extractJson({ response: valid })).toEqual(valid);
  });

  it("validates and renders markdown", () => {
    const parsed = SummarySchema.parse(valid);
    const markdown = toMarkdown("Team workshop", parsed);
    expect(markdown).toContain("# Team workshop");
    expect(markdown).toContain("- [ ] Send handout");
    expect(markdown).toContain("Chunk 3");
  });

  it("creates a valid transcript-grounded fallback", () => {
    const summary = fallbackSummary([{ sequence: 0, transcript_text: "This is a short test." }]);
    expect(summary.overview).toBe("This is a short test.");
    expect(summary.chapters[0]?.start_chunk).toBe(0);
  });
});

describe("empty answers from a model", () => {
  it("count as no note, so the merged section notes are used instead", async () => {
    const { summaryHasContent } = await import("../src/summary");
    const { segmentNoteHasContent, SegmentNoteSchema } = await import("../src/segment");
    const empty = SummarySchema.parse({ ...valid, overview: "", key_points: [], action_items: [], audience_questions: [], chapters: [] });
    expect(summaryHasContent(SummarySchema.parse(valid))).toBe(true);
    // What Llama 3.3 returned for a short Mandarin meeting: valid JSON, every field empty.
    expect(summaryHasContent(empty)).toBe(false);
    expect(summaryHasContent({ ...empty, overview: "周会" })).toBe(false);

    const blank = SegmentNoteSchema.parse({ headline: "周会", bullets: [], decisions: [], questions: [], action_items: [], tools: [], resources: [], quotes: [] });
    expect(segmentNoteHasContent(blank)).toBe(false);
    expect(segmentNoteHasContent({ ...blank, decisions: ["场地定在图书馆"] })).toBe(true);
  });
});
