/**
 * Query builder for a D1 FTS5 table created with `tokenize='trigram'`. New for
 * v2 — nextclaw-cloud's fulltext route builds a Postgres `plainto_tsquery`
 * call instead, which has no equivalent injection surface (parameterised,
 * fixed grammar) and no minimum-term-length problem.
 *
 * The trigram tokenizer indexes overlapping 3-character shingles, so it can
 * only ever match query phrases of length >= 3; anything shorter must fall
 * back to a `LIKE '%term%'` scan, which the caller runs against `likeTerms`.
 *
 * Safety: every qualifying term becomes its own double-quoted FTS5 phrase
 * (embedded `"` doubled per FTS5's own escaping rule), and OR-ed together.
 * A handful of FTS5 syntax characters (`* ( ) :` — prefix/grouping/NEAR/column
 * filter) are stripped from each term before quoting, so nothing in `match`
 * can ever be parsed as an operator: even pathological input like
 * `" OR * NEAR(` degrades to inert phrase content instead of a syntax error.
 */

const TERM_DELIMITER_RE = /[\s,，。！？!?;；、]+/u;
const FTS5_STRIP_RE = /[*():]/g;
const MIN_MATCH_LEN = 3;

export interface FtsQuery {
  /** OR-joined double-quoted FTS5 phrases, or null when no term qualifies. */
  match: string | null;
  /** Terms too short for the trigram index; match with LIKE '%term%' instead. */
  likeTerms: string[];
}

export function buildFtsQuery(query: string): FtsQuery {
  const rawTerms = query.split(TERM_DELIMITER_RE).filter((t) => t.length > 0);
  const phrases: string[] = [];
  const likeTerms: string[] = [];

  for (const raw of rawTerms) {
    const term = raw.replace(FTS5_STRIP_RE, "");
    if (term.length === 0) {
      continue;
    }
    if (term.length >= MIN_MATCH_LEN) {
      phrases.push(quotePhrase(term));
    } else {
      likeTerms.push(term);
    }
  }

  return {
    match: phrases.length > 0 ? phrases.join(" OR ") : null,
    likeTerms,
  };
}

function quotePhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}
