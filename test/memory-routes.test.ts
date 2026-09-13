import { describe, expect, it } from "vitest";
import { decodeMemoryCursor, encodeMemoryCursor } from "../src/memory-routes";

describe("memory list cursor", () => {
  it("round-trips occurred_at and id", () => {
    const cursor = encodeMemoryCursor("2026-09-13T10:00:00.000Z", "section:seg-003");
    expect(decodeMemoryCursor(cursor)).toEqual({ occurredAt: "2026-09-13T10:00:00.000Z", id: "section:seg-003" });
  });

  it("round-trips a memory id that itself contains colons", () => {
    const cursor = encodeMemoryCursor("2026-09-13T10:00:00.000Z", "transcript:8f14e45f-0004:3");
    expect(decodeMemoryCursor(cursor)).toEqual({ occurredAt: "2026-09-13T10:00:00.000Z", id: "transcript:8f14e45f-0004:3" });
  });

  it("rejects a cursor that isn't valid base64", () => {
    expect(decodeMemoryCursor("not base64 at all !!")).toBeNull();
  });

  it("rejects a cursor missing the occurred_at|id separator", () => {
    expect(decodeMemoryCursor(btoa("no-separator-here"))).toBeNull();
  });

  it("rejects a cursor with an empty id half", () => {
    expect(decodeMemoryCursor(btoa("2026-09-13T10:00:00.000Z|"))).toBeNull();
  });

  it("two cursors from different rows never collide", () => {
    const a = encodeMemoryCursor("2026-09-13T10:00:00.000Z", "a");
    const b = encodeMemoryCursor("2026-09-13T10:00:00.000Z", "b");
    expect(a).not.toBe(b);
  });
});
