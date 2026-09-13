/**
 * Deterministic filler filter, ported from nextclaw-cloud's
 * src/ingest/trash.ts::trashFilter (0 LLM, no dependencies). Collapsed to a
 * single boolean (`isJunk`) since v2 doesn't need the reject-reason enum.
 */

const BOILERPLATE: RegExp[] = [
  /^(I'?ll|Let me|I will)\s+(proceed|help|continue|now)/i,
  /^(Sure|OK|Okay|Got it|Understood|Alright|Done|Thanks)[,!.\s]*$/i,
  /^(Yes|No|Maybe)[!.\s]*$/i,
  // Single-line Chinese chatter/acknowledgements — no factual content.
  /^(好|收到|明白|了解|谢谢|太棒了)[,!.\s。，]*$/u,
  /^(好的?|没问题|没事|可以的?|当然|当然可以|行)[,，]?\s*(我?(?:来|去|这就|马上|立?刻|现在))*\s*(帮你?|为你?|给你)?\s*(处理|看一?下|搞定|安排|做|来做|去做|开始|动手|搞起)[一下]*[。.!！\s]*$/u,
  /^(明白了?|了解了?|收到了?)[,，]?\s*(我?(?:马上|立?刻|这就|现在))?\s*(处理|去做|搞定|开始|动手)[。.!！\s]*$/u,
  /^(我?来|我?去|我?给你)\s*(看一?下|处理|搞定|搞起|搞|做)\s*[。.!！\s]*$/u,
];

const STACKTRACE = /^\s*at\s+[\w$.<>]+\s+\([^)]+:\d+:\d+\)/m;
const PURE_GREP_OUTPUT = /^[^:\n]+:\d+:[^\n]*$/;

const MIN_TOKENS_NO_VERB = 8;
const MIN_TOKENS = 5;

const VERB_HINT_LATIN =
  /\b(?:is|are|was|were|did|do|does|will|have|has|had|need|like|prefer|run|ran|running|see|saw|build|built|ship|shipped|review|merge|merged|push|pushed|pull|test|tested|fix|fixed|add|added|remove|removed|use|uses|used|using|work|works|worked|working|edit|edited|write|wrote|read|set|got|made|change|changed|track|store|stored|storing)\b/i;
const VERB_HINT_CJK =
  /(?:是|有|做|想|要|喜欢|讨厌|改|写|跑|看|建|发|合并|推送|拉|测|修|加|删|用|去|来|吃|喝|跑了|改了|写了|做了|看了)/u;

/** CJK char ~= 1 token, Latin word ~= 1 token. Good enough for a length gate. */
function approxTokenCount(text: string): number {
  let count = 0;
  let inWord = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af);
    if (isCjk) {
      count += 1;
      inWord = false;
    } else if (/\w/.test(ch)) {
      if (!inWord) {
        count += 1;
      }
      inWord = true;
    } else {
      inWord = false;
    }
  }
  return count;
}

/** True when `text` is chatter/boilerplate/tool-output noise not worth indexing. */
export function isJunk(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return true;
  }

  for (const re of BOILERPLATE) {
    if (re.test(trimmed)) {
      return true;
    }
  }

  if (STACKTRACE.test(trimmed)) {
    return true;
  }

  const lines = trimmed.split("\n").filter((l) => l.length > 0);
  if (lines.length > 0 && lines.every((l) => PURE_GREP_OUTPUT.test(l))) {
    return true;
  }

  const tok = approxTokenCount(trimmed);
  if (tok < MIN_TOKENS) {
    return true;
  }
  const hasVerb = VERB_HINT_LATIN.test(trimmed) || VERB_HINT_CJK.test(trimmed);
  if (tok < MIN_TOKENS_NO_VERB && !hasVerb) {
    return true;
  }

  return false;
}
