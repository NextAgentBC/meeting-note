import { describe, expect, it } from "vitest";
import { modelText } from "../src/ai";
import { normalizeVision } from "../src/captures";
// @ts-expect-error Browser modules are shipped as plain JavaScript without declaration files.
import { isPhotoFile } from "../public/captures.js";

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

describe("photo selection compatibility", () => {
  it("accepts iPhone JPEG files even when Safari omits the MIME type", () => {
    expect(isPhotoFile({ name: "IMG_1234.JPG", type: "" } as File)).toBe(true);
    expect(isPhotoFile({ name: "photo.jpeg", type: "application/octet-stream" } as File)).toBe(true);
  });

  it("accepts image MIME types and rejects unrelated files", () => {
    expect(isPhotoFile({ name: "camera", type: "image/jpeg" } as File)).toBe(true);
    expect(isPhotoFile({ name: "notes.pdf", type: "application/pdf" } as File)).toBe(false);
  });
});
