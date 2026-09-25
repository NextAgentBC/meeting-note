import { describe, expect, it } from "vitest";
// @ts-expect-error Browser modules are shipped as plain JavaScript without declaration files.
import { FR, LANGUAGES, t, ZH } from "../public/preferences.js";

// The interface language dictionary: a plain English -> translated lookup, keyed by the exact
// English string authored in public/*.js and index.html (see preferences.js). There is no other
// source of truth for "which strings need translating" than ZH's own key list, so completeness
// means FR has exactly the same keys — neither a string ZH already covers and FR forgot, nor a
// stray FR entry that can never be looked up because nothing in the UI is written that way.

describe("the interface language switch", () => {
  it("offers French next to English and Chinese", () => {
    expect(LANGUAGES).toEqual(["en", "zh", "fr"]);
  });
});

describe("French dictionary completeness", () => {
  it("translates every UI string the Chinese dictionary does, and nothing else", () => {
    const zhKeys = Object.keys(ZH);
    const frKeys = Object.keys(FR);
    const missingFromFrench = zhKeys.filter((key) => !(key in FR));
    const onlyInFrench = frKeys.filter((key) => !(key in ZH));
    expect(missingFromFrench).toEqual([]);
    expect(onlyInFrench).toEqual([]);
  });

  it("never leaves a French entry blank", () => {
    // Not "never equal to the English key": genuine French cognates exist ("Plans", "Note", "Date").
    for (const [key, value] of Object.entries(FR as Record<string, string>)) {
      expect(value.trim(), `FR["${key}"]`).not.toBe("");
    }
  });
});

describe("t() dispatches to the right dictionary", () => {
  it("passes English through unchanged, and looks the same string up in Chinese and French", () => {
    expect(t("Meetings", "en")).toBe("Meetings");
    expect(t("Meetings", "zh")).toBe("会议");
    expect(t("Meetings", "fr")).toBe("Réunions");
  });

  it("falls back to the English string for a key neither dictionary has", () => {
    expect(t("Not a real UI string", "zh")).toBe("Not a real UI string");
    expect(t("Not a real UI string", "fr")).toBe("Not a real UI string");
  });

  it("translates the same dynamically-built strings in French as it does in Chinese", () => {
    expect(t("3 chunks", "zh")).toBe("3 个音频片段");
    expect(t("3 chunks", "fr")).toBe("3 segments audio");
    expect(t("1 chunk", "fr")).toBe("1 segment audio");
    expect(t("Note ready →", "zh")).toBe("笔记已完成 →");
    expect(t("Note ready →", "fr")).toBe("Note prête →");
    expect(t("Uploading photo 2/5…", "fr")).toBe("Envoi de la photo 2/5…");
    expect(t("Open this in Safari or Chrome, not WeChat", "fr")).toContain("WeChat");
  });
});
