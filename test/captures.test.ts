import { describe, expect, it } from "vitest";
import { modelText } from "../src/ai";
import { normalizeVision } from "../src/captures";

describe("photo understanding output", () => {
  it("reads the description response returned by the zero-setup LLaVA model", () => {
    expect(modelText({ description: "A handwritten shopping list." })).toBe("A handwritten shopping list.");
  });

  it("keeps a grounded caption, OCR and supported category", () => {
    expect(normalizeVision({
      caption: "A grocery receipt on a kitchen counter.",
      ocr_text: "Milk 4.99",
      category: "life"
    })).toEqual({
      caption: "A grocery receipt on a kitchen counter.",
      ocrText: "Milk 4.99",
      category: "life"
    });
  });

  it("falls back to inbox instead of accepting an invented category", () => {
    expect(normalizeVision({ caption: "A whiteboard", category: "secret" })).toEqual({
      caption: "A whiteboard",
      ocrText: "",
      category: "inbox"
    });
  });

  it("salvages a plain prose model response as the caption", () => {
    expect(normalizeVision(null, "A handwritten shopping list.")).toEqual({
      caption: "A handwritten shopping list.",
      ocrText: "",
      category: "inbox"
    });
  });
});
