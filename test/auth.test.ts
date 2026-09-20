import { describe, expect, it } from "vitest";
import { newRecoveryCode, nextNoteEnabled, normalizeRecoveryCode } from "../src/auth";

describe("recovery codes", () => {
  it("look like XXXX-XXXX-XXXX-XXXX in Crockford base32, with no I, L, O or U", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(newRecoveryCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    }
  });

  it("don't repeat", () => {
    const codes = new Set(Array.from({ length: 500 }, () => newRecoveryCode()));
    expect(codes.size).toBe(500);
  });

  it("survive being typed back loosely", () => {
    const code = "D2DB-KJ0S-H42J-4RTX";
    expect(normalizeRecoveryCode(code)).toBe("D2DBKJ0SH42J4RTX");
    expect(normalizeRecoveryCode(" d2db kj0s\th42j-4rtx ")).toBe("D2DBKJ0SH42J4RTX");
    // A letter O for zero, and I or L for one, are what people write by hand.
    expect(normalizeRecoveryCode("D2DB-KJOS-H42J-4RTX")).toBe("D2DBKJ0SH42J4RTX");
    expect(normalizeRecoveryCode("1111-iiii-LLLL-llll")).toBe("1111111111111111");
  });
});

describe("connected apps", () => {
  it("are one deployment's own: off unless that deployment turns them on", () => {
    // What the installer hands out, and what the template deploys with.
    expect(nextNoteEnabled({})).toBe(false);
    expect(nextNoteEnabled({ NEXTNOTE: "" })).toBe(false);
    expect(nextNoteEnabled({ NEXTNOTE: "  " })).toBe(false);
    expect(nextNoteEnabled({ NEXTNOTE: "off" })).toBe(false);
    expect(nextNoteEnabled({ NEXTNOTE: "false" })).toBe(false);
    expect(nextNoteEnabled({ NEXTNOTE: "0" })).toBe(false);

    expect(nextNoteEnabled({ NEXTNOTE: "on" })).toBe(true);
    expect(nextNoteEnabled({ NEXTNOTE: "ON" })).toBe(true);
    expect(nextNoteEnabled({ NEXTNOTE: "true" })).toBe(true);
    expect(nextNoteEnabled({ NEXTNOTE: "nextnote" })).toBe(true);
  });
});
