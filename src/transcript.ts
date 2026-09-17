import { Hono } from "hono";
import { z } from "zod";
import { modelOptions, modelText, recordUsage, runModel } from "./ai";
import { audioRetentionDays } from "./audio";
import { simplifyEnabled, toSimplified } from "./chinese";
import { getSetting, setSetting } from "./settings";
import type { Env } from "./types";

// How Whisper is asked, what is cleaned up after it, and the owner's vocabulary.
//
// Measured on a real 20-minute meeting in Mandarin with English product names (2026-09-16), two
// 3-minute stretches scored against a Gemini transcript: the old settings (VAD on, a prompt telling
// Whisper to write Chinese) left a line of Russian, 150 "嗯?" over real speech and a lost price.
// WHISPER_OPTIONS below removed those and cut the character error rate by 15–25%; the vocabulary
// pass lifted brand names from 9 to 14 of 16 in the brand-heavy stretch. Everyday words it can't fix.

export const VOCABULARY_SETTING = "asr_glossary";
const MAX_TERMS = 60;
const MAX_TERM_LENGTH = 60;
/** Whisper keeps only the last ~224 tokens of its prompt; stay well under that. */
const PROMPT_TERM_CHARS = 240;
/** Shorter than this, a correction has too little context to be trusted. */
const MIN_CORRECTION_CHARS = 40;

/** Decoding settings that stop a pause from turning into repeated or invented text. */
export const WHISPER_OPTIONS = {
  // VAD cut real speech in the test meeting and did not prevent the loops; these thresholds do.
  vad_filter: false,
  condition_on_previous_text: false,
  compression_ratio_threshold: 2.0,
  no_speech_threshold: 0.6,
  log_prob_threshold: -1.0,
  hallucination_silence_threshold: 2,
  beam_size: 5
} as const;

/** One term per line (commas and 、 also separate), trimmed, de-duplicated, capped. */
export function parseVocabulary(value: string | null | undefined): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of String(value ?? "").split(/[\n\r,，、;；]+/)) {
    const term = raw.trim().replace(/\s+/g, " ").slice(0, MAX_TERM_LENGTH);
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

export async function loadVocabulary(env: Env): Promise<string[]> {
  return parseVocabulary(await getSetting(env.DB, VOCABULARY_SETTING));
}

/**
 * Whisper's initial prompt. In Simplified Chinese on purpose (Whisper mirrors the prompt's script), with
 * no colon anywhere (a "：" made whisper-large-v3-turbo write "Ｂ" for commas), and without asking for
 * Chinese output: that instruction made it translate or drop English product names.
 */
export function whisperPrompt(vocabulary: string[]): string {
  const base = "以下是一场商务会议的录音，普通话里夹杂英文单词和英文产品名，英文照原样写出。";
  let terms = "";
  for (const term of vocabulary) {
    const clean = term.replace(/[:：]/g, " ");
    const next = terms ? `${terms}、${clean}` : clean;
    if (next.length > PROMPT_TERM_CHARS) break;
    terms = next;
  }
  return terms ? `${base}常用词有 ${terms}。` : `${base}Business meeting in Mandarin with English words mixed in.`;
}

export function whisperInput(audioBase64: string, language: string, vocabulary: string[]): Record<string, unknown> {
  const input: Record<string, unknown> = { audio: audioBase64, ...WHISPER_OPTIONS, initial_prompt: whisperPrompt(vocabulary) };
  if (language !== "auto") input.language = language;
  return input;
}

/**
 * Decoding loops the thresholds let through: one to four characters repeated six or more times in a
 * row ("想想想想想想", "嗯?嗯?嗯?…") become one. Digits never count, so 10000 and 8888 stay whole, and
 * ordinary repetition such as 我明白我明白我明白 or 对对对对 is left alone.
 */
export function collapseLoops(text: string): string {
  return text.replace(/([^\s\d]{1,4}?)(?:[\s。，,.、?？!！]*\1){5,}/gu, "$1");
}

function characterPairs(text: string): Set<string> {
  const pairs = new Set<string>();
  const compact = text.replace(/\s+/g, "");
  for (let index = 0; index < compact.length - 1; index += 1) pairs.add(compact.slice(index, index + 2));
  return pairs;
}

/**
 * A vocabulary pass may fix words, not rewrite: the result has to stay within 15% of the original length
 * and keep at least 80% of its character pairs. A paraphrase, a translation or a summary fails both.
 * Calibrated on real 3-minute chunks: the model's genuine fixes kept 94–100% of the pairs, while two
 * different Whisper decodings of the same audio shared only 62%.
 */
export function acceptCorrection(original: string, corrected: string): boolean {
  const before = original.trim();
  const after = corrected.trim();
  if (!after) return false;
  const ratio = after.length / Math.max(1, before.length);
  if (ratio < 0.85 || ratio > 1.15) return false;
  const beforePairs = characterPairs(before);
  const afterPairs = characterPairs(after);
  if (afterPairs.size === 0) return beforePairs.size === 0;
  let shared = 0;
  for (const pair of afterPairs) if (beforePairs.has(pair)) shared += 1;
  return shared / afterPairs.size >= 0.8;
}

/** Strips what a model sometimes wraps around the text it was asked to return verbatim. */
export function cleanCorrection(text: string): string {
  return text
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .replace(/^(?:纠正后的全文|校对后的文本|纠正后|以下是纠正后的全文)[^\n]*[:：]\s*/, "")
    .trim();
}

/**
 * Corrects near-misses of the owner's vocabulary (荔猪蓝 → 丽珠兰, wrestland → Restylane) with a text
 * model. Anything that looks like more than word fixes is thrown away and Whisper's words kept.
 */
export async function correctTranscript(env: Env, meetingId: string, text: string, vocabulary: string[]): Promise<string> {
  if (!vocabulary.length || text.trim().length < MIN_CORRECTION_CHARS) return text;
  const model = env.CORRECT_MODEL || env.SUMMARY_MODEL;
  const result = await runModel(env, model, {
    messages: [
      { role: "system", content: "你是语音识别校对员。只纠正同音错字，以及拼错的词表里的名称，其余一字不改：不改写句子、不增删内容、不翻译、不加解释。" },
      { role: "user", content: `词表：${vocabulary.join("、")}\n\n识别文本：\n${text}\n\n只输出纠正后的全文。` }
    ],
    max_tokens: Math.min(4000, text.length * 2 + 200),
    temperature: 0,
    ...modelOptions(model)
  });
  await recordUsage(env, meetingId, "asr_correct", model, result);
  let candidate = cleanCorrection(modelText(result));
  if (simplifyEnabled(env.CHINESE_SCRIPT)) candidate = toSimplified(candidate);
  return acceptCorrection(text, candidate) ? candidate : text;
}

export const transcriptRoutes = new Hono<{ Bindings: Env }>();

/** The Me page's transcription settings, and whether this copy keeps audio permanently. */
transcriptRoutes.get("/settings/transcription", async (c) => c.json({
  ok: true,
  vocabulary: await loadVocabulary(c.env),
  permanentStorage: Boolean(c.env.RECORDINGS),
  retentionDays: audioRetentionDays(c.env)
}));

const vocabularyBody = z.object({
  vocabulary: z.union([z.string().max(10_000), z.array(z.string().max(200)).max(500)])
});

transcriptRoutes.put("/settings/transcription", async (c) => {
  const parsed = vocabularyBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: "Send the vocabulary as text, one term per line." }, 400);
  const raw = Array.isArray(parsed.data.vocabulary) ? parsed.data.vocabulary.join("\n") : parsed.data.vocabulary;
  const terms = parseVocabulary(raw);
  await setSetting(c.env.DB, VOCABULARY_SETTING, terms.join("\n"));
  return c.json({ ok: true, vocabulary: terms });
});
