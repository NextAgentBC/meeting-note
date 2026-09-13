/**
 * New tests for buildFtsQuery -- no nextclaw-cloud equivalent (its fulltext
 * route uses a parameterised Postgres plainto_tsquery call, which has neither
 * a minimum-term-length problem nor this injection surface).
 */

import { describe, expect, it } from "vitest";
import { buildFtsQuery } from "../../src/recall/fts";

describe("buildFtsQuery", () => {
  it("mixed EN/CN input: >=3 char terms become OR-ed phrases, short CJK terms fall back to LIKE", () => {
    const { match, likeTerms } = buildFtsQuery("报价 quotation 下周 deadline");
    expect(match).toBe('"quotation" OR "deadline"');
    expect(likeTerms).toEqual(["报价", "下周"]);
  });

  it("terms shorter than 3 chars never appear in match", () => {
    const { match, likeTerms } = buildFtsQuery("ab cd");
    expect(match).toBeNull();
    expect(likeTerms).toEqual(["ab", "cd"]);
  });

  it("empty query -> null match, no like terms", () => {
    expect(buildFtsQuery("")).toEqual({ match: null, likeTerms: [] });
    expect(buildFtsQuery("   ")).toEqual({ match: null, likeTerms: [] });
  });

  it("escapes an embedded double quote inside a qualifying term", () => {
    const { match } = buildFtsQuery('he"llo world');
    expect(match).toBe('"he""llo" OR "world"');
  });

  for (const attack of ['" OR * NEAR(', '*:*', 'a" OR "1"="1', 'NEAR(a, b, 5)', '((()))']) {
    it(`injection attempt does not throw and produces safe output: ${attack}`, () => {
      expect(() => buildFtsQuery(attack)).not.toThrow();
      const { match } = buildFtsQuery(attack);
      if (match !== null) {
        // Every phrase must be a well-formed, balanced double-quoted FTS5 string:
        // for the whole match string, the number of unescaped quote *pairs* must
        // be consistent -- i.e. splitting on `""` (the escape) never leaves a
        // dangling lone `"`.
        const withoutEscapes = match.replace(/""/g, "");
        const quoteCount = (withoutEscapes.match(/"/g) ?? []).length;
        expect(quoteCount % 2).toBe(0);
      }
    });
  }

  it("the classic `\" OR * NEAR(` injection collapses to an inert phrase", () => {
    const { match, likeTerms } = buildFtsQuery('" OR * NEAR(');
    expect(match).toBe('"NEAR"');
    expect(likeTerms).toEqual(['"', "OR"]);
  });

  it("FTS5 structural characters are stripped from within a term, not left dangling", () => {
    const { match } = buildFtsQuery("path:foo*bar");
    expect(match).toBe('"pathfoobar"');
  });
});
