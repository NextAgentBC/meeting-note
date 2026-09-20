// Liquid glass for the two bars. Three things make it read as glass rather than as a grey panel:
// the backdrop is blurred and saturated, a highlight rides the edge that meets the content and
// slides as the page moves, and the whole thing takes its tint from whatever is passing behind it.
// Everything is CSS custom properties; this file only measures.

const SAMPLE_INTERVAL_MS = 250;
const MAX_SHIFT_PX = 26;
/** Below this the glass is sitting over something dark, and its text has to go light. */
const LIGHT_BACKDROP = 0.55;

let bars = [];
let shift = 0;
let previousScroll = 0;
let lastSample = 0;
let running = false;

function channel(value) {
  const ratio = value / 255;
  return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance, 0 (black) to 1 (white), of an "rgb(r g b / a)" string. */
function luminance(color) {
  const parts = color.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return null;
  const [red, green, blue] = parts.map(Number);
  const alpha = parts.length > 3 ? Number(parts[3]) : 1;
  if (alpha < 0.35) return null; // see-through: whatever is under it decides
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

/** What the eye sees at this point: the first element behind it with a colour of its own. */
function luminanceAt(x, y) {
  let element = document.elementFromPoint(x, y);
  while (element) {
    const value = luminance(getComputedStyle(element).backgroundColor);
    if (value !== null) return value;
    element = element.parentElement;
  }
  return null;
}

/** Samples just outside the bar, where the content is about to slide under it. */
function backdropLuminance(bar) {
  const rect = bar.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return null;
  const outside = bar.classList.contains("tabbar") && rect.top > window.innerHeight / 2;
  const y = outside ? Math.max(1, rect.top - 6) : Math.min(window.innerHeight - 1, rect.bottom + 6);
  const values = [0.25, 0.5, 0.75]
    .map((across) => luminanceAt(Math.round(rect.left + rect.width * across), Math.round(y)))
    .filter((value) => value !== null);
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function adapt() {
  const visible = bars.filter((bar) => bar.offsetParent !== null || getComputedStyle(bar).position === "fixed");
  let measured = null;
  for (const bar of visible) {
    const value = backdropLuminance(bar);
    if (value === null) continue;
    measured = measured === null ? value : (measured + value) / 2;
    bar.dataset.glass = value > LIGHT_BACKDROP ? "light" : "dark";
  }
  if (measured !== null) document.documentElement.dataset.glass = measured > LIGHT_BACKDROP ? "light" : "dark";
}

function frame() {
  const scrolled = window.scrollY || document.documentElement.scrollTop || 0;
  const velocity = scrolled - previousScroll;
  previousScroll = scrolled;
  // The highlight is pushed by the movement and drifts back when it stops: liquid, not sliding.
  shift = Math.max(-MAX_SHIFT_PX, Math.min(MAX_SHIFT_PX, (shift + velocity * 0.4) * 0.9));
  if (Math.abs(shift) < 0.05) shift = 0;
  const lean = Math.min(1, Math.abs(velocity) / 14);
  for (const bar of bars) {
    bar.style.setProperty("--glass-shift", `${shift.toFixed(2)}px`);
    bar.style.setProperty("--glass-lean", lean.toFixed(2));
  }
  const now = performance.now();
  if (now - lastSample > SAMPLE_INTERVAL_MS) {
    lastSample = now;
    adapt();
  }
  if (shift !== 0 || velocity !== 0) requestAnimationFrame(frame);
  else running = false;
}

function start() {
  if (running || document.visibilityState === "hidden") return;
  running = true;
  requestAnimationFrame(frame);
}

export function initGlass() {
  bars = [...document.querySelectorAll(".appbar, .tabbar")];
  if (!bars.length) return;
  adapt();
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!still) {
    previousScroll = window.scrollY || 0;
    window.addEventListener("scroll", start, { passive: true });
  }
  // The tint also changes when the view, the theme or the window does, with nothing scrolling.
  window.addEventListener("hashchange", () => window.setTimeout(adapt, 60));
  window.addEventListener("resize", adapt);
  window.addEventListener("meetingnote:appearance-changed", () => window.setTimeout(adapt, 60));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") adapt();
  });
}
