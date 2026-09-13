/**
 * Ported from nextclaw-cloud's test/ingest.test.ts `trashFilter` cases,
 * retargeted at the boolean `isJunk` export.
 */

import { describe, expect, it } from "vitest";
import { isJunk } from "../../src/recall/trash";

describe("isJunk", () => {
  it("passes real Chinese/English content", () => {
    expect(isJunk("老板决定周三闭店做全店盘点,店员提前一天到岗准备标签")).toBe(false);
    expect(isJunk("We shipped the deploy pipeline to production today")).toBe(false);
  });

  it("blocks chatter and empty input", () => {
    expect(isJunk("好的")).toBe(true);
    expect(isJunk("Sure!")).toBe(true);
    expect(isJunk("")).toBe(true);
    expect(isJunk("   ")).toBe(true);
    expect(isJunk("OK")).toBe(true);
    expect(isJunk("收到,我马上处理。")).toBe(true);
  });

  it("blocks pure stack traces / grep output", () => {
    expect(isJunk("    at Foo.bar (/app/src/index.ts:12:3)")).toBe(true);
    expect(isJunk("src/a.ts:12:const x = 1\nsrc/b.ts:30:const y = 2")).toBe(true);
  });

  it("blocks anything under the 5-token floor regardless of content", () => {
    expect(isJunk("blue red green")).toBe(true); // 3 tokens
  });

  it("5-7 tokens needs a verb hint to pass; without one it's still junk", () => {
    expect(isJunk("we shipped the deploy pipeline")).toBe(false); // 5 tokens, has "shipped"
    expect(isJunk("blue red green yellow purple")).toBe(true); // 5 tokens, no verb hint
  });
});
