/**
 * New tests for splitForIndex -- no nextclaw-cloud equivalent (it indexes
 * whole messages as a single chunk).
 */

import { describe, expect, it } from "vitest";
import { splitForIndex } from "../../src/recall/split";

describe("splitForIndex", () => {
  it("empty / whitespace-only input -> no pieces", () => {
    expect(splitForIndex("")).toEqual([]);
    expect(splitForIndex("   \n  ")).toEqual([]);
  });

  it("short text under maxChars stays a single piece", () => {
    expect(splitForIndex("今天开会讨论报价。", 800)).toEqual(["今天开会讨论报价。"]);
  });

  it("packs multiple short sentences into one piece up to maxChars", () => {
    const pieces = splitForIndex("First point here. Second point here. Third point here. Fourth point here.", 40);
    expect(pieces).toEqual(["First point here. Second point here.", "Third point here. Fourth point here."]);
  });

  it("splits long Chinese text on sentence punctuation, respecting maxChars", () => {
    const sentence = "今天我们讨论了报价,客户觉得有点贵,需要再谈一下折扣。下周三之前给回复!这是补充说明的一段话。";
    const long = sentence.repeat(15);
    const pieces = splitForIndex(long, 100);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(100);
    }
    // Content is preserved modulo the whitespace/trim normalisation splitForIndex applies.
    expect(pieces.join("").replace(/\s+/g, "")).toBe(long.replace(/\s+/g, ""));
  });

  it("splits long English text on sentence punctuation without breaking mid-word", () => {
    const sentence =
      "The quarterly roadmap review covers pricing feedback and delivery timelines for the next cycle. ";
    const long = sentence.repeat(30);
    const pieces = splitForIndex(long, 120);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(120);
    }
    for (let i = 0; i < pieces.length - 1; i += 1) {
      const endsWithWordChar = /[A-Za-z0-9]$/.test(pieces[i]!);
      const nextStartsWithWordChar = /^[A-Za-z0-9]/.test(pieces[i + 1]!);
      expect(endsWithWordChar && nextStartsWithWordChar).toBe(false);
    }
  });

  it("hard-wraps a single token longer than maxChars (unavoidable mid-word cut)", () => {
    const url = "https://example.com/" + "a".repeat(50);
    const pieces = splitForIndex(url, 20);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(20);
    }
    expect(pieces.join("")).toBe(url);
  });

  it("a sentence longer than maxChars is still wrapped at a word boundary when one exists", () => {
    const text =
      "This single sentence has no terminal punctuation and keeps going well past the character limit for a while";
    const pieces = splitForIndex(text, 30);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(30);
      expect(p.trim()).toBe(p);
    }
    expect(pieces.join(" ")).toBe(text);
  });
});
