// Motion and light that follow the content: a photo lends its colour to the space around it, the
// page has depth as it scrolls, and a long list bends away at its edges. All of it is decoration,
// so all of it is skipped when the device asks for less motion, and none of it changes any data.

const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ── Ambient glow: a photo lights the space around it ────────────────────────

const glowBySource = new Map();
const GLOW_FALLBACK = "128 138 148";

/**
 * The colour a photo leaves in the room: an average weighted towards the colourful pixels, so a
 * green plant on a grey table glows green rather than grey.
 */
function dominantColour(image) {
  const canvas = document.createElement("canvas");
  canvas.width = 12;
  canvas.height = 12;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return GLOW_FALLBACK;
  context.drawImage(image, 0, 0, 12, 12);
  let red = 0;
  let green = 0;
  let blue = 0;
  let total = 0;
  const { data } = context.getImageData(0, 0, 12, 12);
  for (let index = 0; index < data.length; index += 4) {
    const [r, g, b] = [data[index], data[index + 1], data[index + 2]];
    const high = Math.max(r, g, b);
    const low = Math.min(r, g, b);
    const saturation = high === 0 ? 0 : (high - low) / high;
    // Near-black and near-white pixels say little about the mood of a photo.
    const weight = (0.2 + saturation) * (high > 18 && low < 245 ? 1 : 0.2);
    red += r * weight;
    green += g * weight;
    blue += b * weight;
    total += weight;
  }
  if (!total) return GLOW_FALLBACK;
  const average = [red / total, green / total, blue / total];
  // A glow has to be seen: lift a dark average without losing which colour it was.
  const brightest = Math.max(...average);
  const lift = brightest < 90 ? 90 / Math.max(brightest, 1) : 1;
  return average.map((value) => Math.round(Math.min(255, value * lift))).join(" ");
}

function glowFrom(image) {
  const source = image.currentSrc || image.src;
  if (!source) return null;
  if (glowBySource.has(source)) return glowBySource.get(source);
  let colour = GLOW_FALLBACK;
  try {
    colour = dominantColour(image);
  } catch {
    // A photo from somewhere else would taint the canvas; the default glow is fine.
  }
  glowBySource.set(source, colour);
  return colour;
}

/** Gives every photo on the page its glow, and keeps doing it as more of them load. */
export function ambientGlow(root = document) {
  for (const image of root.querySelectorAll("img[data-glow]")) {
    const paint = () => {
      const colour = glowFrom(image);
      if (!colour) return;
      const target = image.closest("[data-glow-target]") || image.parentElement;
      // Registered in shell.css with @property, so changing it is a transition, not a jump.
      if (target) target.style.setProperty("--glow-color", `rgb(${colour.replaceAll(" ", " ")})`);
    };
    if (image.complete && image.naturalWidth) paint();
    else image.addEventListener("load", paint, { once: true });
  }
}

/** The colour of one photo, for the lightbox: the transition between two is done by CSS. */
export function glowForImage(image) {
  return glowFrom(image) || GLOW_FALLBACK;
}

// ── Depth of field: three layers, one scroll ────────────────────────────────

let depthFrame = 0;

function depthTick() {
  depthFrame = 0;
  const scrolled = window.scrollY || document.documentElement.scrollTop || 0;
  const reach = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  const progress = Math.min(1, scrolled / reach);
  const root = document.documentElement;
  // The far layer drifts slowest and softens; the near layer is the content itself, untouched.
  root.style.setProperty("--depth-far", `${(-scrolled * 0.12).toFixed(1)}px`);
  root.style.setProperty("--depth-mid", `${(-scrolled * 0.04).toFixed(1)}px`);
  root.style.setProperty("--depth-blur", `${(14 + progress * 26).toFixed(1)}px`);
  root.style.setProperty("--depth-dim", (1 - progress * 0.35).toFixed(3));
}

export function depthScroll() {
  if (still()) return;
  const schedule = () => {
    if (!depthFrame) depthFrame = requestAnimationFrame(depthTick);
  };
  depthTick();
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
}

// ── Cylinder scroll: a long list curves away at both ends ───────────────────

let cylinderFrame = 0;

function cylinderTick() {
  cylinderFrame = 0;
  // A wide window shows whole rows side by side; the curve belongs to a phone's single column.
  if (window.innerWidth > 760) return;
  const middle = window.innerHeight / 2;
  for (const list of document.querySelectorAll("[data-cylinder]")) {
    for (const item of list.children) {
      const rect = item.getBoundingClientRect();
      if (rect.bottom < -80 || rect.top > window.innerHeight + 80) {
        item.style.removeProperty("transform");
        item.style.removeProperty("opacity");
        continue;
      }
      // How far this row sits from the middle of the screen, as -1 … 0 … 1.
      const offset = Math.max(-1, Math.min(1, (rect.top + rect.height / 2 - middle) / middle));
      const away = Math.abs(offset);
      item.style.transform = `perspective(900px) rotateX(${(-offset * 7).toFixed(2)}deg) scale(${(1 - away * 0.035).toFixed(4)})`;
      item.style.opacity = (1 - away * 0.28).toFixed(3);
    }
  }
}

export function cylinderScroll() {
  if (still()) return;
  const schedule = () => {
    if (!cylinderFrame) cylinderFrame = requestAnimationFrame(cylinderTick);
  };
  cylinderTick();
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  window.addEventListener("hashchange", () => window.setTimeout(schedule, 60));
  // Lists are rebuilt whenever their data changes.
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
}
