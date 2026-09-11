import { z } from "zod";

export const SummarySchema = z.object({
  overview: z.string(),
  chapters: z.array(z.object({
    title: z.string(),
    summary: z.string(),
    start_chunk: z.number().int().nonnegative()
  })),
  key_points: z.array(z.string()),
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
  required: ["overview", "chapters", "key_points", "tools_mentioned", "audience_questions", "action_items", "resources_promised", "follow_up_message", "evidence"]
} as const;
