/**
 * Sentence-aware chunker for indexing (Vectorize passages + FTS5 rows). New
 * for v2 — nextclaw-cloud ingests whole messages as a single chunk and has no
 * equivalent splitter.
 *
 * Splits on 。！？!?. and newlines, then greedily packs consecutive sentences
 * into pieces up to `maxChars`. A single sentence longer than `maxChars` is
 * further split by character, but never inside a run of [A-Za-z0-9] (CJK has
 * no such run, so it always safely splits at the exact boundary there).
 */

const SENTENCE_BOUNDARY_RE = /(?<=[。!?！？.\n])/u;
const LATIN_WORD_CHAR_RE = /[A-Za-z0-9]/;

export function splitForIndex(text: string, maxChars = 800): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const pieces: string[] = [];
  let buffer = "";

  const flush = (): void => {
    const t = buffer.trim();
    if (t.length > 0) {
      pieces.push(t);
    }
    buffer = "";
  };

  for (const sentence of splitSentences(trimmed)) {
    if (sentence.length > maxChars) {
      flush();
      for (const piece of splitLong(sentence.trim(), maxChars)) {
        pieces.push(piece);
      }
      continue;
    }
    if (buffer.length > 0 && buffer.length + sentence.length > maxChars) {
      flush();
    }
    buffer += sentence;
  }
  flush();

  return pieces;
}

function splitSentences(text: string): string[] {
  return text.split(SENTENCE_BOUNDARY_RE).filter((s) => s.length > 0);
}

/** Hard-wraps a single over-long sentence, backing off to a word boundary for Latin runs. */
function splitLong(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = maxChars;
    if (isLatinWordChar(rest[cut - 1]) && isLatinWordChar(rest[cut])) {
      let back = cut;
      while (back > 0 && isLatinWordChar(rest[back - 1])) {
        back -= 1;
      }
      if (back > 0) {
        cut = back;
      }
      // else: a single token >= maxChars (e.g. a URL) — hard cut, unavoidable.
    }
    const piece = rest.slice(0, cut).trim();
    if (piece.length > 0) {
      out.push(piece);
    }
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) {
    out.push(rest);
  }
  return out;
}

function isLatinWordChar(ch: string | undefined): boolean {
  return ch !== undefined && LATIN_WORD_CHAR_RE.test(ch);
}
