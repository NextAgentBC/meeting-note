import fs from "node:fs";

const css = fs.readFileSync(new URL("../public/preferences.css", import.meta.url), "utf8");
const themes = ["pine", "celadon", "dusk", "pomegranate", "lilac", "rosewood", "butter"];

function blockFor(theme) {
  const selector = theme === "pine" ? `:root, html[data-theme="pine"]` : `html[data-theme="${theme}"]`;
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing theme block: ${theme}`);
  const end = css.indexOf("}\n", start);
  const block = css.slice(start, end);
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [match[1], match[2]]));
}

function rgb(hex) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

function luminance(hex) {
  return rgb(hex).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
}

function contrast(a, b) {
  const [bright, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (bright + .05) / (dark + .05);
}

const modeText = {
  light: { ink: "#17201d", ink2: "#43504b", ink3: "#68746f" },
  dark: { ink: "#f4f7f9", ink2: "#c4ced5", ink3: "#8f9ba8" }
};
const checks = [];

for (const theme of themes) {
  const tokens = blockFor(theme);
  for (const mode of ["light", "dark"]) {
    const canvas = tokens[`theme-${mode}-canvas`];
    const surface = tokens[`theme-${mode}-surface`];
    const brand = tokens[`theme-${mode}-brand`];
    const brandText = tokens[`theme-${mode}-brand-text`];
    const brandFg = tokens[`theme-${mode}-brand-fg`];
    const pairs = [
      ["body on canvas", modeText[mode].ink, canvas, 4.5],
      ["secondary on canvas", modeText[mode].ink2, canvas, 4.5],
      ["muted on canvas", modeText[mode].ink3, canvas, 3],
      ["body on card", modeText[mode].ink, surface, 4.5],
      ["brand text on canvas", brandText, canvas, 4.5],
      ["button text on brand", brandFg, brand, 4.5]
    ];
    for (const [label, foreground, background, minimum] of pairs) {
      const ratio = contrast(foreground, background);
      checks.push({ theme, mode, label, ratio, minimum });
    }
  }
}

const failed = checks.filter((check) => check.ratio < check.minimum);
for (const check of failed) {
  console.error(`${check.theme}/${check.mode} ${check.label}: ${check.ratio.toFixed(2)} < ${check.minimum}`);
}
if (failed.length) process.exit(1);
console.log(`${themes.length} themes × 2 modes: ${checks.length} contrast checks passed.`);

