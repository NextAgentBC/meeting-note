import { z } from "zod";

export const SummarySchema = z.object({
  overview: z.string(),
  chapters: z.array(z.object({
    title: z.string(),
    summary: z.string(),
    start_chunk: z.number().int().nonnegative()
  })),
  key_points: z.array(z.string()),
  decisions: z.array(z.string()).default([]),
  tools_mentioned: z.array(z.string()),
  audience_questions: z.array(z.object({
    question: z.string(),
    answer: z.string().default("")
  })),
  action_items: z.array(z.object({
    task: z.string(),
    owner: z.string().default("Unassigned"),
    due: z.string().default("")
  })),
  resources_promised: z.array(z.string()),
  follow_up_message: z.string(),
  evidence: z.array(z.object({
    claim: z.string(),
    chunk: z.number().int().nonnegative(),
    quote: z.string()
  }))
});

export type MeetingSummary = z.infer<typeof SummarySchema>;

export type NoteLanguage = "zh" | "en" | "fr";

/**
 * Which language a note is written in, decided in code rather than left to the model: GLM once wrote
 * an all-English meeting's section note in Chinese. The language chosen when recording wins ("fr" is
 * only ever that choice, never guessed); for "auto", Chinese characters are weighed against English
 * words (a Chinese character carries about two-thirds of a word). "auto" stays a Chinese/English
 * guess on purpose — it is the bilingual mode measured on a real meeting (see WHISPER_OPTIONS in
 * transcript.ts) — and a French meeting always has its own language recorded instead.
 */
export function noteLanguage(text: string, meetingLanguage = "auto"): NoteLanguage {
  if (meetingLanguage === "zh" || meetingLanguage === "en" || meetingLanguage === "fr") return meetingLanguage;
  const han = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const words = (text.match(/[A-Za-z]+/g) ?? []).length;
  return han >= words * 1.5 && han > 0 ? "zh" : "en";
}

export function languageInstruction(language: NoteLanguage): string {
  if (language === "zh") {
    return "Write every field except verbatim quotes in fluent Simplified Chinese (简体中文), never English or Traditional Chinese. Keep product and company names in their canonical form.";
  }
  if (language === "fr") {
    return "Write every field except verbatim quotes in fluent French, even where someone briefly speaks another language. Keep product and company names in their canonical form.";
  }
  return "Write every field except verbatim quotes in English, even where someone briefly speaks Chinese. Keep product and company names in their canonical form.";
}

type ActionItem = MeetingSummary["action_items"][number];

function similarity(a: string, b: string): number {
  const pieces = (value: string) => {
    const text = value.toLowerCase().replace(/[\s\p{P}]/gu, "");
    const set = new Set<string>();
    for (let index = 0; index < text.length - 1; index += 1) set.add(text.slice(index, index + 2));
    return set;
  };
  const left = pieces(a);
  const right = pieces(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const piece of left) if (right.has(piece)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/**
 * The final merge sometimes rewrites a to-do and drops the owner or deadline its section note already
 * had. Put them back from the closest-matching section to-do; nothing new is invented.
 */
export function restoreActionDetails(items: ActionItem[], fromSections: ActionItem[]): ActionItem[] {
  const missing = (value: string) => !value.trim() || /^(unassigned|未指定|无|none|non assigné[e]?|aucun[e]?)$/i.test(value.trim());
  return items.map((item) => {
    if (!missing(item.owner) && item.due.trim()) return item;
    let best: ActionItem | null = null;
    let bestScore = 0;
    for (const candidate of fromSections) {
      const score = similarity(item.task, candidate.task);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best || bestScore < 0.5) return item;
    return {
      ...item,
      owner: missing(item.owner) && !missing(best.owner) ? best.owner : item.owner,
      due: item.due.trim() ? item.due : best.due
    };
  });
}

/**
 * The final model only writes fields that benefit from cross-section language
 * understanding. Chapters and evidence are copied from the grounded rolling
 * notes, which keeps the response small and prevents token-limit truncation.
 */
export const FinalSynthesisSchema = z.object({
  overview: z.string(),
  key_points: z.array(z.string()),
  decisions: z.array(z.string()),
  tools_mentioned: z.array(z.string()),
  audience_questions: z.array(z.object({
    question: z.string(),
    answer: z.string().default("")
  })),
  action_items: z.array(z.object({
    task: z.string(),
    owner: z.string().default("Unassigned"),
    due: z.string().default("")
  })),
  resources_promised: z.array(z.string()),
  follow_up_message: z.string()
});

export type FinalSynthesis = z.infer<typeof FinalSynthesisSchema>;

export function synthesisFromSummary(summary: MeetingSummary): FinalSynthesis {
  return FinalSynthesisSchema.parse({
    overview: summary.overview,
    key_points: summary.key_points,
    decisions: summary.decisions,
    tools_mentioned: summary.tools_mentioned,
    audience_questions: summary.audience_questions,
    action_items: summary.action_items,
    resources_promised: summary.resources_promised,
    follow_up_message: summary.follow_up_message
  });
}

/**
 * Apply every independently valid synthesis field to a grounded fallback.
 * A model is not allowed to erase a non-empty source array with an empty one.
 */
export function applyFinalSynthesis(value: unknown, fallback: MeetingSummary): {
  summary: MeetingSummary;
  recoveredFields: string[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { summary: fallback, recoveredFields: [] };
  }

  const object = value as Record<string, unknown>;
  const base = synthesisFromSummary(fallback) as Record<string, unknown>;
  const recoveredFields: string[] = [];
  for (const [key, schema] of Object.entries(FinalSynthesisSchema.shape)) {
    if (!(key in object)) continue;
    const parsed = schema.safeParse(object[key]);
    if (!parsed.success) continue;
    if (typeof parsed.data === "string" && key === "overview" && !parsed.data.trim()) continue;
    if (Array.isArray(parsed.data) && Array.isArray(base[key]) && base[key].length > 0 && parsed.data.length === 0) continue;
    base[key] = parsed.data;
    recoveredFields.push(key);
  }

  return {
    summary: SummarySchema.parse({ ...fallback, ...base }),
    recoveredFields
  };
}

export interface TranscriptExcerpt {
  sequence: number;
  text: string;
}

/**
 * Pull short transcript windows likely to contain questions, decisions or
 * commitments. The final model sees these verbatim windows in addition to the
 * rolling notes, so conversational Mandarin such as “我明天发” is not lost.
 */
export function cueExcerpts(
  chunks: Array<{ sequence: number; transcript_text: string | null }>,
  maxExcerpts = 16
): TranscriptExcerpt[] {
  const cue = /我(?:会|可以|明天|今晚|一会|下来|这边|把)|我们(?:会|可以|先|要|需要|计划)|你(?:把|再|先|就|可以)|到时候|后续|下一步|确认|安排|添加|加上|改一改|调整|发给|发到|准备|开发|预约|排进去|有没有|能不能|是否|要不要|怎么|什么|吗[，。？！?]/g;
  const perChunk: TranscriptExcerpt[][] = [];

  for (const chunk of chunks) {
    const text = (chunk.transcript_text || "").trim();
    if (!text) continue;
    const excerpts: TranscriptExcerpt[] = [];
    let lastEnd = -1;
    for (const match of text.matchAll(cue)) {
      const index = match.index ?? 0;
      const start = Math.max(0, index - 90);
      const end = Math.min(text.length, index + match[0].length + 150);
      if (start <= lastEnd - 30) continue;
      excerpts.push({ sequence: chunk.sequence, text: text.slice(start, end).trim() });
      lastEnd = end;
      if (excerpts.length >= 3) break;
    }
    if (excerpts.length) perChunk.push(excerpts);
  }

  const selected: TranscriptExcerpt[] = [];
  for (let position = 0; selected.length < maxExcerpts; position++) {
    let found = false;
    for (const excerpts of perChunk) {
      const excerpt = excerpts[position];
      if (!excerpt) continue;
      found = true;
      selected.push(excerpt);
      if (selected.length >= maxExcerpts) break;
    }
    if (!found) break;
  }
  return selected;
}

/**
 * Reject schema-valid summaries that have discarded the useful source notes.
 * The second argument is the deterministic merge built from those notes.
 */
export function summaryHasUsefulContent(summary: MeetingSummary, source?: MeetingSummary): boolean {
  if (!summary.overview.trim()) return false;

  const detailedChapters = summary.chapters.filter((chapter) => chapter.summary.trim()).length;
  const details = summary.key_points.some((item) => item.trim())
    || detailedChapters > 0
    || summary.action_items.some((item) => item.task.trim())
    || summary.audience_questions.some((item) => item.question.trim() || item.answer.trim())
    || summary.evidence.some((item) => item.quote.trim());
  if (!details) return false;

  if (!source) return true;
  if (source.key_points.length > 0 && !summary.key_points.some((item) => item.trim())) return false;
  if (source.chapters.some((chapter) => chapter.summary.trim()) && detailedChapters === 0) return false;
  if (source.evidence.length > 0 && !summary.evidence.some((item) => item.quote.trim())) return false;
  return true;
}

/**
 * Structured output can still be linguistically broken (for example a model
 * looping one phrase or emitting rare CJK glyphs that were never spoken).
 * Keep that output out of the saved note and fall back to grounded rolling
 * notes instead.
 */
export function summaryLanguageLooksHealthy(summary: MeetingSummary, sourceText = ""): boolean {
  const generated = [
    summary.overview,
    ...summary.key_points,
    ...summary.decisions,
    ...summary.audience_questions.flatMap((item) => [item.question, item.answer]),
    ...summary.action_items.flatMap((item) => [item.task, item.owner, item.due]),
    ...summary.tools_mentioned,
    ...summary.resources_promised,
    summary.follow_up_message
  ].join("\n");

  if (/�/.test(generated)) return false;

  // Extension/compatibility ideographs are valid Unicode, but a new one that
  // is absent from the transcript is a strong signal of Chinese decoding noise.
  const unusualHan = generated.match(/[㐀-䶿豈-﫿]/gu) ?? [];
  if (unusualHan.some((character) => !sourceText.includes(character))) return false;

  const normalize = (value: string) => value.replace(/[\s，、,.。！？!?；;：:“”'"（）()\-—]/gu, "");
  const overviewClauses = summary.overview
    .split(/[。！？!?；;\n]+/u)
    .map(normalize)
    .filter((value) => value.length >= 8);
  if (new Set(overviewClauses).size < overviewClauses.length) return false;

  const hasDuplicate = (values: string[]) => {
    const normalized = values.map(normalize).filter((value) => value.length >= 8);
    return new Set(normalized).size < normalized.length;
  };
  if (hasDuplicate(summary.key_points) || hasDuplicate(summary.decisions)) return false;

  // A ten-character phrase appearing three times is almost always a generation
  // loop, while still allowing normal topic words such as “人工智能” to recur.
  const compact = normalize(summary.overview);
  const grams = new Map<string, number>();
  for (let index = 0; index <= compact.length - 10; index++) {
    const gram = compact.slice(index, index + 10);
    const count = (grams.get(gram) ?? 0) + 1;
    if (count >= 3) return false;
    grams.set(gram, count);
  }

  return true;
}

/**
 * Recover independently valid top-level fields from a response truncated near
 * the end. One broken evidence item must not discard good chapters or actions.
 */
export function recoverSummaryFields(value: unknown, fallback: MeetingSummary): {
  summary: MeetingSummary;
  recoveredFields: string[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { summary: fallback, recoveredFields: [] };
  }

  const object = value as Record<string, unknown>;
  const recovered: Record<string, unknown> = { ...fallback };
  const recoveredFields: string[] = [];
  for (const [key, schema] of Object.entries(SummarySchema.shape)) {
    if (!(key in object)) continue;
    const parsed = schema.safeParse(object[key]);
    if (!parsed.success) continue;
    recovered[key] = parsed.data;
    recoveredFields.push(key);
  }
  return { summary: SummarySchema.parse(recovered), recoveredFields };
}

/**
 * Remove reasoning blocks some models emit before their answer.
 *
 * Not needed by the default model, but the summary model is an environment
 * variable — a thinking model must not silently break note generation.
 */
export function stripThinking(value: string): string {
  return value
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

/**
 * Close a JSON object that was cut off mid-way.
 *
 * A model that runs to its token limit truncates inside an array or a string,
 * which used to throw away an entire meeting's worth of work. Salvaging the
 * complete part of the response is far better than discarding all of it.
 */
export function repairTruncatedJson(text: string): string | null {
  const stack: string[] = [];
  // Positions where a value finished, with the brackets still open at that point.
  const cuts: Array<{ index: number; open: string[] }> = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') { inString = false; cuts.push({ index: i + 1, open: [...stack] }); }
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{" || char === "[") { stack.push(char); continue; }
    if (char === "}" || char === "]") { stack.pop(); cuts.push({ index: i + 1, open: [...stack] }); continue; }
    if (char === ",") { cuts.push({ index: i, open: [...stack] }); continue; }
  }

  if (stack.length === 0 && !inString) return null; // nothing was truncated

  // Walk back through the cut points, closing the structures that were still
  // open there. JSON.parse decides whether a candidate is actually valid, so a
  // cut that lands on a dangling key simply fails and we try an earlier one.
  const limit = Math.max(0, cuts.length - 400);
  for (let k = cuts.length - 1; k >= limit; k--) {
    const cut = cuts[k];
    const body = text.slice(0, cut.index).replace(/,\s*$/, "");
    const closers = [...cut.open].reverse().map((open) => (open === "{" ? "}" : "]")).join("");
    const candidate = body + closers;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // this cut was not a value boundary after all — try the one before it
    }
  }
  return null;
}

export function extractJson(value: unknown): unknown {
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    if ("response" in object) return extractJson(object.response);
    if ("result" in object) return extractJson(object.result);
    return value;
  }
  if (typeof value !== "string") throw new Error("Model returned no JSON payload");

  const trimmed = stripThinking(value).replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");
  const first = trimmed.indexOf("{");
  if (first < 0) throw new Error("Model response did not contain a JSON object");

  const last = trimmed.lastIndexOf("}");
  if (last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      // fall through to the repair path
    }
  }

  const repaired = repairTruncatedJson(trimmed.slice(first));
  if (repaired) {
    try {
      return JSON.parse(repaired);
    } catch {
      // fall through
    }
  }
  throw new Error("Model response was not valid JSON, even after repair");
}

export function fallbackSummary(chunks: Array<{ sequence: number; transcript_text: string | null }>): MeetingSummary {
  const usable = chunks
    .map((chunk) => ({ sequence: chunk.sequence, text: (chunk.transcript_text || "").trim() }))
    .filter((chunk) => chunk.text);
  const completeText = usable.map((chunk) => chunk.text).join(" ");
  return SummarySchema.parse({
    overview: completeText.slice(0, 1200),
    chapters: usable.map((chunk, index) => ({
      title: usable.length === 1 ? "Conversation" : `Part ${index + 1}`,
      summary: chunk.text.slice(0, 700),
      start_chunk: chunk.sequence
    })),
    key_points: usable.slice(0, 8).map((chunk) => chunk.text.slice(0, 280)),
    decisions: [],
    tools_mentioned: [],
    audience_questions: [],
    action_items: [],
    resources_promised: [],
    follow_up_message: "",
    evidence: usable.slice(0, 8).map((chunk) => ({
      claim: "Transcript excerpt",
      chunk: chunk.sequence,
      quote: chunk.text.slice(0, 180)
    }))
  });
}

export function toMarkdown(title: string, summary: MeetingSummary): string {
  const lines = [
    `# ${title}`,
    "",
    "## Overview",
    "",
    summary.overview,
    "",
    "## Key points",
    "",
    ...summary.key_points.map((item) => `- ${item}`),
    "",
    "## Chapters",
    ""
  ];

  for (const chapter of summary.chapters) {
    lines.push(`### ${chapter.title}`, "", chapter.summary, "", `_Starts near chunk ${chapter.start_chunk + 1}_`, "");
  }

  lines.push("## Audience questions", "");
  if (summary.audience_questions.length === 0) lines.push("- None captured");
  for (const item of summary.audience_questions) {
    lines.push(`- **Q:** ${item.question}${item.answer ? `  \n  **A:** ${item.answer}` : ""}`);
  }

  lines.push("", "## Action items", "");
  if (summary.action_items.length === 0) lines.push("- None captured");
  for (const item of summary.action_items) {
    const suffix = [item.owner && `Owner: ${item.owner}`, item.due && `Due: ${item.due}`].filter(Boolean).join(" · ");
    lines.push(`- [ ] ${item.task}${suffix ? ` — ${suffix}` : ""}`);
  }

  lines.push("", "## Decisions", "");
  if (summary.decisions.length === 0) lines.push("- None captured");
  for (const decision of summary.decisions) lines.push(`- ${decision}`);

  lines.push(
    "",
    "## Tools mentioned",
    "",
    ...(summary.tools_mentioned.length ? summary.tools_mentioned.map((item) => `- ${item}`) : ["- None captured"]),
    "",
    "## Resources promised",
    "",
    ...(summary.resources_promised.length ? summary.resources_promised.map((item) => `- ${item}`) : ["- None captured"]),
    "",
    "## Follow-up message",
    "",
    summary.follow_up_message,
    "",
    "## Evidence",
    "",
    ...summary.evidence.map((item) => `- **Chunk ${item.chunk + 1}:** ${item.claim} — “${item.quote}”`),
    ""
  );

  return lines.join("\n");
}

export const summaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    overview: { type: "string" },
    chapters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          start_chunk: { type: "integer" }
        },
        required: ["title", "summary", "start_chunk"]
      }
    },
    key_points: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    tools_mentioned: { type: "array", items: { type: "string" } },
    audience_questions: {
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
    resources_promised: { type: "array", items: { type: "string" } },
    follow_up_message: { type: "string" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { claim: { type: "string" }, chunk: { type: "integer" }, quote: { type: "string" } },
        required: ["claim", "chunk", "quote"]
      }
    }
  },
  required: ["overview", "chapters", "key_points", "decisions", "tools_mentioned", "audience_questions", "action_items", "resources_promised", "follow_up_message", "evidence"]
} as const;

export const finalSynthesisJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    overview: { type: "string", maxLength: 500 },
    key_points: { type: "array", maxItems: 10, items: { type: "string", maxLength: 180 } },
    decisions: { type: "array", maxItems: 10, items: { type: "string", maxLength: 180 } },
    tools_mentioned: { type: "array", maxItems: 15, items: { type: "string", maxLength: 80 } },
    audience_questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { question: { type: "string", maxLength: 180 }, answer: { type: "string", maxLength: 260 } },
        required: ["question", "answer"]
      }
    },
    action_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", maxLength: 80, description: "Exactly one self-contained agreed task; never concatenate multiple tasks" },
          owner: { type: "string", maxLength: 60 },
          due: { type: "string", maxLength: 60 }
        },
        required: ["task", "owner", "due"]
      }
    },
    resources_promised: { type: "array", maxItems: 10, items: { type: "string", maxLength: 180 } },
    follow_up_message: { type: "string", maxLength: 240 }
  },
  required: ["overview", "key_points", "decisions", "tools_mentioned", "audience_questions", "action_items", "resources_promised", "follow_up_message"]
} as const;

/**
 * The user prompt for the final merge model call. Chapters and evidence are
 * deliberately excluded from what the model must return — applyFinalSynthesis
 * copies those from the deterministic section-note merge — so this only asks
 * for the eight FinalSynthesisSchema fields.
 */
export function finalSynthesisPrompt(
  meeting: { title: string; template: string; language: string },
  transcriptSource: string,
  useFullTranscript: boolean
): string {
  return `Meeting title: ${meeting.title}\nTemplate: ${meeting.template}\n\nBelow is the original transcript. It is the only source of truth. Produce a faithful executive synthesis grounded only in it. Remove duplicates and preserve chronology. ${languageInstruction(noteLanguage(transcriptSource, meeting.language))}

Requirements:
- overview: a coherent 2-4 sentence paragraph explaining purpose, discussion and outcome; do not concatenate section headings.
- key_points: 6-10 concrete, non-overlapping points covering the whole meeting.
- decisions: choices actually accepted by the speakers. Conversational confirmations such as “那就用第一版” or "let's go with that" count. A suggestion without acceptance does not.
- action_items: every explicit commitment or agreed next step. Phrases such as “我明天发”, “我来改”, “把工具包加上”, “按两周排进去”, "I'll send it", "I'll get that done", or a request followed by acceptance such as “没问题” or "sure, I will" are actions. Rewrite spoken fragments as short, complete task sentences without adding facts. Return exactly one task per action_items object; never join multiple tasks into one string. Keep the stated owner and due date; use owner "Unassigned" and due "" only when absent. Do not turn general ideas into tasks.
- audience_questions: substantive questions with the answer actually given; omit greetings and rhetorical filler.
- tools_mentioned and resources_promised: use canonical names. A tool that was merely discussed is not a promised resource. Correct obvious ASR variants when context is unambiguous: chatGDP/chatsdp/欠的GDP → ChatGPT; cloud flyer → Cloudflare; deep seek → DeepSeek. Do not change verbatim excerpts.
- follow_up_message: a useful copy-ready follow-up under 80 Chinese characters or 80 English words.

Grounding rules:
- Ignore opaque or nonsensical ASR phrases; never assign them a plausible-sounding meaning.
- A name heard in a greeting does not establish who the presenter is. Only assign roles or action owners when the surrounding transcript makes them explicit.
- Preserve stated amounts exactly; never add a currency such as 元 or 美元 when none was spoken.
- A possible request (for example “说不定可以请你看看”) is not an action unless someone explicitly accepts it.

Do not invent facts, owners, deadlines, answers or promises. Fields genuinely absent may be empty. Return the complete compact JSON object; chapters and evidence are deliberately handled outside this model call.

${useFullTranscript ? "FULL ORIGINAL TRANSCRIPT" : "SELECTED ORIGINAL TRANSCRIPT EXCERPTS"}
${transcriptSource || "None"}`;
}
