import { describe, expect, it } from "vitest";
import { deepSimplify, simplifyEnabled, toSimplified } from "../src/chinese";
import { extractJson, repairTruncatedJson, stripThinking } from "../src/summary";

describe("simplified chinese", () => {
  it("converts what Whisper actually returned in the first live test", () => {
    expect(toSimplified("我們來測試一下, this is a test.")).toBe("我们来测试一下, this is a test.");
  });

  it("leaves English, numbers and product names alone", () => {
    expect(toSimplified("Cloudflare Workers AI 2026 · NotebookLM")).toBe("Cloudflare Workers AI 2026 · NotebookLM");
  });

  it("is idempotent, so re-running it never degrades text", () => {
    const once = toSimplified("繁體字轉換與會議紀錄");
    expect(toSimplified(once)).toBe(once);
  });

  it("does not rewrite regional vocabulary into something the speaker did not say", () => {
    // Characters convert; 網路 becomes 网路, not 网络.
    expect(toSimplified("網路")).toBe("网路");
  });

  it("walks nested note structures", () => {
    const simplified = deepSimplify({
      headline: "測試",
      bullets: ["第一點", "第二點"],
      quotes: [{ chunk: 0, quote: "這是引用" }],
      nothing: null,
      count: 3
    });
    expect(simplified).toEqual({
      headline: "测试",
      bullets: ["第一点", "第二点"],
      quotes: [{ chunk: 0, quote: "这是引用" }],
      nothing: null,
      count: 3
    });
  });

  it("can be switched off", () => {
    expect(simplifyEnabled(undefined)).toBe(true);
    expect(simplifyEnabled("simplified")).toBe(true);
    expect(simplifyEnabled("off")).toBe(false);
    expect(simplifyEnabled("OFF")).toBe(false);
  });
});

describe("model output cleanup", () => {
  it("removes reasoning blocks", () => {
    expect(stripThinking("<think>weighing options</think>\n{\"a\":1}")).toBe('{"a":1}');
    expect(stripThinking("<think>never closed")).toBe("");
  });

  it("returns null when there is nothing to repair", () => {
    expect(repairTruncatedJson('{"a":1}')).toBeNull();
  });

  it("closes an array truncated mid-element", () => {
    const repaired = repairTruncatedJson('{"key_points":["one","two","thr');
    expect(repaired).toBe('{"key_points":["one","two"]}');
    expect(JSON.parse(repaired!)).toEqual({ key_points: ["one", "two"] });
  });

  it("drops a dangling key with no value", () => {
    const repaired = repairTruncatedJson('{"a":1,"b":');
    expect(JSON.parse(repaired!)).toEqual({ a: 1 });
  });

  it("closes nested structures in the right order", () => {
    const repaired = repairTruncatedJson('{"chapters":[{"title":"One","summary":"Two"},{"title":"Thr');
    expect(JSON.parse(repaired!)).toEqual({ chapters: [{ title: "One", summary: "Two" }] });
  });

  it("salvages a truncated response instead of losing the meeting", () => {
    // This is the failure that wasted 22 seconds and produced an empty note.
    const truncated = '{"overview":"A workshop","key_points":["Free tools only","Four hands-on rou';
    const parsed = extractJson(truncated) as Record<string, unknown>;
    expect(parsed.overview).toBe("A workshop");
    expect(parsed.key_points).toEqual(["Free tools only"]);
  });

  it("still parses clean responses, fenced or not", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('<think>hmm</think>{"a":1}')).toEqual({ a: 1 });
  });

  it("throws when there is no JSON at all", () => {
    expect(() => extractJson("I could not do that")).toThrow();
  });
});
