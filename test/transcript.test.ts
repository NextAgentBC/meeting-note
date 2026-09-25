import { describe, expect, it } from "vitest";
import { WHISPER_OPTIONS, acceptCorrection, cleanCorrection, collapseLoops, parseVocabulary, whisperInput, whisperPrompt } from "../src/transcript";

describe("collapseLoops", () => {
  it("collapses the decoding loops seen in a real meeting", () => {
    expect(collapseLoops("修复抗衰力吧 ok 好想想想想想想想想想想想想 ok 那这个")).toBe("修复抗衰力吧 ok 好想 ok 那这个");
    const hummed = `最后跟我说,我在一起改都可以。 ${"嗯?".repeat(150)} 感谢观看`;
    expect(collapseLoops(hummed).length).toBeLessThan(60);
    expect(collapseLoops(hummed)).toContain("我在一起改都可以");
  });

  it("leaves ordinary repetition alone", () => {
    expect(collapseLoops("我明白我明白我明白 我琢磨琢磨")).toBe("我明白我明白我明白 我琢磨琢磨");
    expect(collapseLoops("对对对对，就这样")).toBe("对对对对，就这样");
    expect(collapseLoops("OK。 OK。 好的")).toBe("OK。 OK。 好的");
  });

  it("never touches digits", () => {
    expect(collapseLoops("一共10000000元，电话8888888")).toBe("一共10000000元，电话8888888");
  });
});

describe("parseVocabulary", () => {
  it("splits on lines, commas and 、, trims, and drops duplicates regardless of case", () => {
    expect(parseVocabulary("丽珠兰\nRejuran, rejuran\n  Restylane   Skinbooster Vital 、PDRN\n\n")).toEqual([
      "丽珠兰", "Rejuran", "Restylane Skinbooster Vital", "PDRN"
    ]);
  });

  it("caps the number of terms and their length", () => {
    const many = Array.from({ length: 80 }, (_, index) => `term${index}`).join("\n");
    expect(parseVocabulary(many)).toHaveLength(60);
    expect(parseVocabulary("x".repeat(100))[0]).toHaveLength(60);
    expect(parseVocabulary(null)).toEqual([]);
  });
});

describe("whisperPrompt", () => {
  it("has no colon, even when a term brings one, and never asks for Chinese-only output", () => {
    const prompt = whisperPrompt(["NCTF: 135HA", "丽珠兰"]);
    expect(prompt).not.toMatch(/[:：]/);
    expect(prompt).toContain("丽珠兰");
    expect(prompt).not.toContain("请用简体中文转写");
    expect(whisperPrompt([])).not.toMatch(/[:：]/);
  });

  it("stops adding terms before the prompt gets long enough for Whisper to cut it", () => {
    const prompt = whisperPrompt(Array.from({ length: 60 }, (_, index) => `Product name number ${index}`));
    expect(prompt.length).toBeLessThan(340);
  });

  it("writes a French meeting its own French prompt, with no Chinese script to mirror", () => {
    const prompt = whisperPrompt(["NCTF 135HA", "Cindy Wong"], "fr");
    expect(prompt).not.toMatch(/[:：]/);
    expect(prompt).toContain("Cindy Wong");
    expect(prompt).toMatch(/fran[cç]ais/i);
    expect(/[\u3400-\u9fff]/.test(prompt)).toBe(false);
    // Untouched for every language this app knew before French.
    expect(whisperPrompt([], "auto")).toContain("以下是一场商务会议的录音");
    expect(whisperPrompt([], "zh")).toContain("以下是一场商务会议的录音");
    expect(whisperPrompt([], "en")).toContain("以下是一场商务会议的录音");
  });
});

describe("whisperInput", () => {
  it("uses the tuned decoding options, and sets a language only when the meeting has one", () => {
    const auto = whisperInput("AAAA", "auto", []);
    expect(auto).toMatchObject({ audio: "AAAA", vad_filter: false, condition_on_previous_text: false, beam_size: 5 });
    expect(auto).not.toHaveProperty("language");
    expect(whisperInput("AAAA", "zh", [])).toMatchObject({ language: "zh" });
    expect(WHISPER_OPTIONS.hallucination_silence_threshold).toBeGreaterThan(0);
  });

  it("sets French like any other explicit language, with its own French prompt", () => {
    const french = whisperInput("AAAA", "fr", ["Cindy Wong"]);
    expect(french).toMatchObject({ language: "fr" });
    expect(french.initial_prompt).toMatch(/fran[cç]ais/i);
    expect(french.initial_prompt).toContain("Cindy Wong");
  });
});

describe("acceptCorrection", () => {
  // A real Whisper passage and the vocabulary pass's answer for it (立珠兰 → 丽珠兰, four times).
  const original = "那这个这个也不要把它放出来 可以下面写立珠兰白瓷水光 但是英文里头不要写就直接写 OK 对 然后立珠兰然后这个英文也不要写出来 中文可以写立珠兰瓷水光 就这个拿掉吧 我觉得这个拿掉它 呃 暂时留着 maybe OK 暂时留着吧 暂时留着 OK 然后它也主要是修复立珠兰 然后修复补水 OK 嗯 然后这个 Legrogen 然后这个英文拿掉写 就要这个Advanced Collagen Matrix 可以的";

  it("accepts word fixes", () => {
    expect(acceptCorrection(original, original.replaceAll("立珠兰", "丽珠兰"))).toBe(true);
  });

  it("rejects a rewrite, a summary, a translation and an empty answer", () => {
    expect(acceptCorrection(original, "他们讨论了丽珠兰和 Restylane 在菜单上的中英文写法。")).toBe(false);
    expect(acceptCorrection(original, "In Chinese you can write the Rejuran white porcelain skin booster, and put Restylane next to it.")).toBe(false);
    expect(acceptCorrection(original, "")).toBe(false);
  });

  // The owner's vocabulary is one global list (see AGENTS.md), so a French meeting can reach the
  // correction pass carrying Chinese or English terms with nothing to fix. The safety net below —
  // not a language check — is what keeps that pass from mangling French: a real name fix keeps it,
  // anything that reads like a translation or a rewrite does not.
  const french = "Le rendez-vous avec Cindy Wong est confirmé pour mardi à quinze heures, au bureau de Montréal. On garde le même produit que la dernière fois, la Restylane, et on ajoute le NCTF comme convenu.";

  it("accepts a genuine accent or name fix on a French transcript", () => {
    expect(acceptCorrection(french, french.replace("Cindy Wong", "Cindy Wong-Tremblay"))).toBe(true);
  });

  it("does not let a French transcript come back mangled into Chinese or rewritten", () => {
    expect(acceptCorrection(french, "会议时间定在周二下午三点，在蒙特利尔办公室，产品不变。")).toBe(false);
    expect(acceptCorrection(french, "The meeting with Cindy Wong is confirmed for Tuesday at three, same product as before.")).toBe(false);
  });
});

describe("cleanCorrection", () => {
  it("removes code fences and a leading label", () => {
    expect(cleanCorrection("```\n丽珠兰白瓷水光\n```")).toBe("丽珠兰白瓷水光");
    expect(cleanCorrection("纠正后的全文：丽珠兰白瓷水光")).toBe("丽珠兰白瓷水光");
  });
});
