import { crc32 as nodeCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { audioRetentionDays, partAvailability } from "../src/audio";
import type { Env } from "../src/types";
// @ts-expect-error — plain browser JavaScript from public/, no type declarations
import { buildZip, crc32 } from "../public/zip.js";

const DAY = 86_400_000;
const now = Date.parse("2026-09-17T12:00:00Z");
const daysAgo = (days: number) => new Date(now - days * DAY).toISOString();

describe("partAvailability", () => {
  it("is kept once a permanent copy exists, however old", () => {
    expect(partAvailability({ archived_at: daysAgo(30), audio_deleted_at: null, created_at: daysAgo(30) }, 7, now)).toBe("kept");
  });

  it("is temporary inside retention and gone after it, without a permanent copy", () => {
    expect(partAvailability({ archived_at: null, audio_deleted_at: null, created_at: daysAgo(6.9) }, 7, now)).toBe("temporary");
    expect(partAvailability({ archived_at: null, audio_deleted_at: null, created_at: daysAgo(7.1) }, 7, now)).toBe("gone");
  });

  it("is gone once the owner deleted it, even with a permanent copy recorded", () => {
    expect(partAvailability({ archived_at: daysAgo(1), audio_deleted_at: daysAgo(0), created_at: daysAgo(1) }, 7, now)).toBe("gone");
  });
});

describe("audioRetentionDays", () => {
  it("reads AUDIO_RETENTION_DAYS and falls back to 7", () => {
    expect(audioRetentionDays({ AUDIO_RETENTION_DAYS: "3" } as Env)).toBe(3);
    expect(audioRetentionDays({ AUDIO_RETENTION_DAYS: "" } as Env)).toBe(7);
    expect(audioRetentionDays({ AUDIO_RETENTION_DAYS: "-1" } as Env)).toBe(7);
  });
});

describe("buildZip (public/zip.js)", () => {
  it("computes the same CRC-32 as zlib", () => {
    const bytes = new TextEncoder().encode("Susanna 水光针会议 part-01");
    expect(crc32(bytes)).toBe(nodeCrc32(bytes));
  });

  it("writes stored entries a ZIP reader can walk: local headers, central directory, end record", async () => {
    const first = new Uint8Array([1, 2, 3, 4, 5]);
    const second = new TextEncoder().encode("second part");
    const blob: Blob = buildZip([{ name: "part-01.webm", data: first }, { name: "第二段.webm", data: second.buffer }]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);

    const endOffset = bytes.length - 22;
    expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
    expect(view.getUint16(endOffset + 10, true)).toBe(2);
    const centralOffset = view.getUint32(endOffset + 16, true);
    expect(centralOffset + view.getUint32(endOffset + 12, true)).toBe(endOffset);

    let cursor = centralOffset;
    const names: string[] = [];
    for (let entry = 0; entry < 2; entry += 1) {
      expect(view.getUint32(cursor, true)).toBe(0x02014b50);
      const size = view.getUint32(cursor + 20, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
      names.push(name);
      expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
      const data = bytes.subarray(localOffset + 30 + nameLength, localOffset + 30 + nameLength + size);
      expect(view.getUint32(cursor + 16, true)).toBe(nodeCrc32(data));
      cursor += 46 + nameLength;
    }
    expect(names).toEqual(["part-01.webm", "第二段.webm"]);
  });
});
