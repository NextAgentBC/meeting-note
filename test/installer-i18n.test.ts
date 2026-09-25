import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The installer page (installer/public/index.html) is translated with data-zh/data-en/data-fr
// attributes, read generically by installer/public/app.js as element.dataset[language]. There is
// no build step to catch a new data-en/data-zh pair that forgot its data-fr, or a typo in the
// attribute name, so this reads the actual shipped file the way the browser would.

const html = readFileSync(join(__dirname, "..", "installer", "public", "index.html"), "utf8");

function attributesOf(tag: RegExp): string[] {
  return [...html.matchAll(tag)].map((match) => match[1]);
}

describe("the installer page's Chinese/English/French markup", () => {
  it("gives every translatable element all three languages", () => {
    const englishValues = attributesOf(/data-en="((?:[^"\\]|\\.)*)"/g);
    const chineseValues = attributesOf(/data-zh="((?:[^"\\]|\\.)*)"/g);
    const frenchValues = attributesOf(/data-fr="((?:[^"\\]|\\.)*)"/g);
    expect(englishValues.length).toBeGreaterThan(50); // sanity: the extraction regex still matches
    expect(chineseValues).toHaveLength(englishValues.length);
    expect(frenchValues).toHaveLength(englishValues.length);
    for (const value of frenchValues) expect(value.trim()).not.toBe("");
  });
});
