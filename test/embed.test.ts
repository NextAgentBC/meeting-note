import { describe, expect, it } from "vitest";
import { vectorId } from "../src/embed";

describe("vectorId", () => {
  it("is 32 lowercase hex characters — 16 bytes, well under Vectorize's 64-byte id cap", async () => {
    const id = await vectorId("transcript:8f14e45f-ceea-4b16-9e0c-1c2b3d4e5f00-0004:37");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is stable: the same memory id always derives the same vector id", async () => {
    const a = await vectorId("summary:8f14e45f-ceea-4b16-9e0c-1c2b3d4e5f00");
    const b = await vectorId("summary:8f14e45f-ceea-4b16-9e0c-1c2b3d4e5f00");
    expect(a).toBe(b);
  });

  it("different memory ids derive different vector ids", async () => {
    const a = await vectorId("fact:meeting-1:0");
    const b = await vectorId("fact:meeting-1:1");
    expect(a).not.toBe(b);
  });

  it("stays 32 characters even for a memory id already longer than Vectorize's 64-byte limit", async () => {
    const longId = `transcript:${"x".repeat(80)}:12`;
    expect(longId.length).toBeGreaterThan(64);
    const id = await vectorId(longId);
    expect(id).toHaveLength(32);
  });
});
