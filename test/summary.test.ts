import { describe, expect, it } from "vitest";
import {
  applyFinalSynthesis,
  cueExcerpts,
  extractJson,
  fallbackSummary,
  finalSynthesisPrompt,
  recoverSummaryFields,
  SummarySchema,
  summaryHasUsefulContent,
  summaryLanguageLooksHealthy,
  toMarkdown
} from "../src/summary";

const valid = {
  overview: "A useful workshop.",
  chapters: [{ title: "Opening", summary: "Introductions", start_chunk: 0 }],
  key_points: ["Start from the business problem"],
  decisions: ["Use the first poster"],
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
    expect(markdown).toContain("- Use the first poster");
    expect(markdown).toContain("Chunk 3");
  });

  it("creates a valid transcript-grounded fallback", () => {
    const summary = fallbackSummary([{ sequence: 0, transcript_text: "This is a short test." }]);
    expect(summary.overview).toBe("This is a short test.");
    expect(summary.chapters[0]?.start_chunk).toBe(0);
  });

  it("rejects a schema-valid summary that discarded all source content", () => {
    const empty = SummarySchema.parse({
      overview: "", chapters: [], key_points: [], tools_mentioned: [], audience_questions: [],
      action_items: [], resources_promised: [], follow_up_message: "", evidence: []
    });
    expect(summaryHasUsefulContent(empty, SummarySchema.parse(valid))).toBe(false);
    expect(summaryHasUsefulContent(SummarySchema.parse(valid), SummarySchema.parse(valid))).toBe(true);
  });

  it("requires the final merge to retain key points, chapter detail and evidence", () => {
    const candidate = SummarySchema.parse({ ...valid, key_points: [] });
    expect(summaryHasUsefulContent(candidate, SummarySchema.parse(valid))).toBe(false);
  });

  it("salvages valid fields when a truncated response breaks only its tail", () => {
    const fallback = SummarySchema.parse(valid);
    const recovered = recoverSummaryFields({
      chapters: [{ title: "Recovered", summary: "Useful detail", start_chunk: 3 }],
      action_items: [{ task: "Send topics", owner: "Unassigned", due: "" }],
      evidence: [{ claim: "broken item without the required quote", chunk: 2 }]
    }, fallback);
    expect(recovered.recoveredFields).toEqual(["chapters", "action_items"]);
    expect(recovered.summary.chapters[0]?.title).toBe("Recovered");
    expect(recovered.summary.action_items[0]?.task).toBe("Send topics");
    expect(recovered.summary.evidence).toEqual(fallback.evidence);
    expect(recovered.summary.overview).toBe(fallback.overview);
  });

  it("applies a compact synthesis without replacing grounded chapters or evidence", () => {
    const fallback = SummarySchema.parse(valid);
    const result = applyFinalSynthesis({
      overview: "A polished overview.",
      key_points: ["A clearer point"],
      decisions: ["Use the first poster"],
      tools_mentioned: ["ChatGPT"],
      audience_questions: [],
      action_items: [{ task: "Send the revised topics", owner: "Song", due: "Tomorrow" }],
      resources_promised: ["AI toolkit"],
      follow_up_message: "Thanks — the revised topics will follow tomorrow."
    }, fallback);
    expect(result.recoveredFields).toEqual([
      "overview", "key_points", "decisions", "tools_mentioned",
      "action_items", "resources_promised", "follow_up_message"
    ]);
    expect(result.summary.overview).toBe("A polished overview.");
    expect(result.summary.chapters).toEqual(fallback.chapters);
    expect(result.summary.evidence).toEqual(fallback.evidence);
    // A compact synthesis may legitimately have no questions, but it must not
    // erase a non-empty grounded source array.
    expect(result.summary.audience_questions).toEqual(fallback.audience_questions);
  });

  it("selects action and question cues across the whole transcript", () => {
    const excerpts = cueExcerpts([
      { sequence: 0, transcript_text: "大家先讨论。那就用第一版海报，我明天把内容发给你。" },
      { sequence: 8, transcript_text: "你能不能开发预约链接？没问题，我可以做。" },
      { sequence: 14, transcript_text: "会后我把主题改一改，再发到群里确认。" }
    ], 3);
    expect(excerpts.map((item) => item.sequence)).toEqual([0, 8, 14]);
    expect(excerpts[0]?.text).toContain("我明天");
    expect(excerpts[1]?.text).toContain("能不能");
    expect(excerpts[2]?.text).toContain("改一改");
  });

  it("rejects Chinese decoding noise and repeated generation loops", () => {
    const clean = SummarySchema.parse(valid);
    expect(summaryLanguageLooksHealthy(clean, "A useful workshop.")).toBe(true);

    const rareGlyph = SummarySchema.parse({ ...valid, overview: "会议讨论了服务的䮜定方案。" });
    expect(summaryLanguageLooksHealthy(rareGlyph, "会议讨论了服务方案。")).toBe(false);
    expect(summaryLanguageLooksHealthy(rareGlyph, "发言人姓名中确实有䮜这个字。")).toBe(true);

    const loop = SummarySchema.parse({
      ...valid,
      overview: "确认一个小时的固定订阅。确认一个小时的固定订阅。确认一个小时的固定订阅。"
    });
    expect(summaryLanguageLooksHealthy(loop)).toBe(false);
  });
});

describe("empty answers from a model", () => {
  it("count as no note, so the merged section notes are used instead", async () => {
    const { segmentNoteHasContent, SegmentNoteSchema } = await import("../src/segment");
    const empty = SummarySchema.parse({
      ...valid, overview: "", key_points: [], decisions: [], action_items: [],
      audience_questions: [], chapters: [], evidence: []
    });
    expect(summaryHasUsefulContent(SummarySchema.parse(valid))).toBe(true);
    // What Llama 3.3 returned for a short Mandarin meeting: valid JSON, every field empty.
    expect(summaryHasUsefulContent(empty)).toBe(false);
    expect(summaryHasUsefulContent({ ...empty, overview: "周会" })).toBe(false);

    const blank = SegmentNoteSchema.parse({ headline: "周会", bullets: [], decisions: [], questions: [], action_items: [], tools: [], resources: [], quotes: [] });
    expect(segmentNoteHasContent(blank)).toBe(false);
    expect(segmentNoteHasContent({ ...blank, decisions: ["场地定在图书馆"] })).toBe(true);
  });
});

describe("finalSynthesisPrompt", () => {
  const meeting = { title: "Weekly sync", template: "meeting", language: "auto" };

  it("includes the meeting title and the retained extraction and grounding rules", () => {
    const prompt = finalSynthesisPrompt(meeting, "[CHUNK 0]\nhello", true);
    expect(prompt).toContain("Weekly sync");
    expect(prompt).toContain("FULL ORIGINAL TRANSCRIPT");
    expect(prompt).toContain("decisions: choices actually accepted by the speakers");
    expect(prompt).toContain("DeepSeek");
    expect(prompt).toContain("Ignore opaque or nonsensical ASR phrases");
    expect(prompt).toContain("A name heard in a greeting does not establish who the presenter is");
    expect(prompt).toContain("Preserve stated amounts exactly");
    expect(prompt).toContain("A possible request");
  });

  it("switches to the excerpt header when the transcript does not fit", () => {
    const prompt = finalSynthesisPrompt(meeting, "[CHUNK 0] hello", false);
    expect(prompt).toContain("SELECTED ORIGINAL TRANSCRIPT EXCERPTS");
    expect(prompt).not.toContain("FULL ORIGINAL TRANSCRIPT");
  });

  it("does not include the workshop-specific rules dropped from the fork's prompt", () => {
    const prompt = finalSynthesisPrompt(meeting, "[CHUNK 0]\nhello", true);
    expect(prompt).not.toContain("CIM");
    expect(prompt).not.toContain("CRM");
    expect(prompt).not.toContain("client projects");
    expect(prompt).not.toContain("next year");
    expect(prompt).not.toContain("handout, app, demo or toolkit");
  });
});

describe("the note's language, decided in code", () => {
  it("follows the recording's language setting, else weighs Chinese characters against English words", async () => {
    const { noteLanguage } = await import("../src/summary");
    expect(noteLanguage("We picked the blue box design. Sarah orders samples by next Friday.")).toBe("en");
    expect(noteLanguage("我们决定用蓝色的包装。Sarah 下周五之前订样品。")).toBe("zh");
    expect(noteLanguage("OK 那就这样 let's go with the ChatGPT plan and the Cloudflare account")).toBe("en");
    expect(noteLanguage("我们决定用蓝色的包装", "en")).toBe("en");
    expect(noteLanguage("")).toBe("en");
  });
});

describe("restoring a to-do's owner and deadline from the section notes", () => {
  it("copies what the final merge dropped, only for a close match", async () => {
    const { restoreActionDetails } = await import("../src/summary");
    const sections = [
      { task: "整理好报名表", owner: "Unassigned", due: "下次开会前" },
      { task: "Sam发出海报", owner: "Sam", due: "下周二之前 (2026-09-15)" }
    ];
    const merged = restoreActionDetails([
      { task: "整理报名表", owner: "", due: "" },
      { task: "发出海报", owner: "Unassigned", due: "" },
      { task: "Order printed samples", owner: "Sarah", due: "next Friday" },
      { task: "完全不同的事情", owner: "", due: "" }
    ], sections);
    expect(merged[0]).toMatchObject({ owner: "", due: "下次开会前" });
    expect(merged[1]).toMatchObject({ owner: "Sam", due: "下周二之前 (2026-09-15)" });
    expect(merged[2]).toMatchObject({ owner: "Sarah", due: "next Friday" });
    expect(merged[3]).toMatchObject({ owner: "", due: "" });
  });
});
