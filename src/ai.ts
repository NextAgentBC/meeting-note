import { extractJson, stripThinking } from "./summary";
import type { Env } from "./types";

export function runModel(env: Env, model: string, input: unknown): Promise<unknown> {
  return (env.AI as unknown as { run: (model: string, input: unknown) => Promise<unknown> }).run(model, input);
}

/**
 * GLM thinks before it answers, and the thinking counts against max_tokens. The answers here are
 * short JSON objects, so switch thinking off and leave the whole budget for the answer.
 */
export function modelOptions(model: string): Record<string, unknown> {
  return /glm-/i.test(model) ? { chat_template_kwargs: { enable_thinking: false } } : {};
}

/**
 * The text a Workers AI text model answered with. Models disagree on the shape: most put a
 * string, or JSON they already parsed, in `response`; OpenAI-style models such as gpt-oss and
 * Kimi answer in `choices[0].message.content`; Responses-style ones in an `output` list.
 */
export function modelText(result: unknown): string {
  if (typeof result === "string") return stripThinking(result);
  if (!result || typeof result !== "object") return "";
  const object = result as Record<string, unknown>;
  if (object.response !== undefined && object.response !== null) {
    return typeof object.response === "string" ? stripThinking(object.response) : JSON.stringify(object.response);
  }

  const choice = Array.isArray(object.choices) ? (object.choices[0] as Record<string, unknown> | undefined) : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  if (message?.content !== undefined && message.content !== null) {
    return typeof message.content === "string" ? stripThinking(message.content) : JSON.stringify(message.content);
  }

  if (Array.isArray(object.output)) {
    const texts = (object.output as Array<Record<string, unknown>>)
      .flatMap((item) => (Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : []))
      .filter((part) => part.type === "output_text" && typeof part.text === "string")
      .map((part) => part.text as string);
    if (texts.length) return stripThinking(texts.join(""));
  }

  if (object.result !== undefined) return typeof object.result === "string" ? stripThinking(object.result) : JSON.stringify(object.result);
  return JSON.stringify(result);
}

function usageOf(result: unknown): { neurons: number; raw: string | null } {
  if (!result || typeof result !== "object") return { neurons: 0, raw: null };
  const usage = (result as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return { neurons: 0, raw: null };
  const neurons = Number((usage as Record<string, unknown>).neurons);
  return {
    neurons: Number.isFinite(neurons) ? neurons : 0,
    raw: JSON.stringify(usage).slice(0, 500)
  };
}

/** A model's JSON, including a bare list, which extractJson (written for objects) would mangle. */
export function parseModelJson(text: string): unknown {
  const trimmed = stripThinking(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to extraction and repair
    }
  }
  return extractJson(trimmed);
}

/** Never let accounting failures take down a job that otherwise succeeded. */
export async function recordUsage(env: Env, meetingId: string | null, kind: string, model: string, result: unknown, audioMs = 0) {
  try {
    const { neurons, raw } = usageOf(result);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO ai_usage (meeting_id, kind, model, neurons, audio_ms, raw_usage, day, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(meetingId, kind, model, neurons, audioMs, raw, now.slice(0, 10), now).run();
  } catch (error) {
    console.error("Could not record AI usage", error);
  }
}

/** Workers Free stops Workers AI for the rest of the UTC day once the free neurons are gone. */
export function isDailyLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b4006\b|daily free allocation/i.test(message);
}
