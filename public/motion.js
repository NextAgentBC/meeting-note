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

// ── Damping and flow: the content has weight, the glass reacts to it ────────

let cylinderFrame = 0;
let flow = 0;
let lastScroll = 0;
let lastFrame = 0;
let restTimer = 0;

/** How far this row lags behind the scroll, so a list settles instead of stopping dead. */
function lagFor(index) {
  return 0.55 + (index % 3) * 0.22;
}

function shapeList(lag) {
  // A phone shows one column: sections there breathe as they pass the middle of the screen. A wide
  // window puts them side by side, where the same motion reads as wobble, so it only gets the lag.
  const breathe = window.innerWidth <= 760;
  const middle = window.innerHeight / 2;
  for (const list of document.querySelectorAll("[data-cylinder]")) {
    [...list.children].forEach((item, index) => {
      if (item.classList.contains("hidden")) return;
      const rect = item.getBoundingClientRect();
      if (rect.bottom < -120 || rect.top > window.innerHeight + 120) {
        item.style.removeProperty("transform");
        item.style.removeProperty("opacity");
        return;
      }
      const drift = `translateY(${(lag * lagFor(index)).toFixed(2)}px)`;
      if (!breathe) {
        item.style.transform = drift;
        item.style.removeProperty("opacity");
        return;
      }
      // 0 in the middle of the screen, 1 at either edge. No rotation: a tilted block's corners
      // reach past its own box and sit on top of the next one.
      const away = Math.min(1, Math.abs(rect.top + rect.height / 2 - middle) / middle);
      const eased = away * away * (3 - 2 * away);
      item.style.transform = `${drift} scale(${(1 - eased * 0.1).toFixed(4)})`;
      item.style.opacity = (1 - eased * 0.45).toFixed(3);
    });
  }
}

function flowTick(now) {
  cylinderFrame = 0;
  const elapsed = lastFrame ? Math.min(80, now - lastFrame) : 16.7;
  lastFrame = now;
  // Damping per frame would settle at whatever speed the device happens to draw; per millisecond
  // it settles in the same quarter of a second on a 120Hz phone and on a throttled background tab.
  const steps = elapsed / 16.7;
  const scrolled = window.scrollY || document.documentElement.scrollTop || 0;
  const velocity = scrolled - lastScroll;
  lastScroll = scrolled;
  // A spring with heavy damping: the scroll pulls the content, and it settles back on its own.
  flow = (flow + velocity * 0.45) * 0.86 ** steps;
  if (Math.abs(flow) < 0.05) flow = 0;
  const lag = Math.max(-14, Math.min(14, flow));
  const root = document.documentElement;
  root.style.setProperty("--flow", `${lag.toFixed(2)}px`);
  // 0 when still, 1 when moving fast: the glass saturates and brightens with the movement.
  root.style.setProperty("--flow-strength", Math.min(1, Math.abs(lag) / 14).toFixed(3));
  shapeList(lag);
  // Frames can stop coming — a background tab, a phone saving power — and content must not be
  // left leaning. If no frame arrives for a while, everything goes back to rest on a timer.
  window.clearTimeout(restTimer);
  if (flow !== 0) restTimer = window.setTimeout(rest, 400);
  if (document.visibilityState === "hidden") {
    flow = 0;
    lastFrame = 0;
    return;
  }
  if (flow !== 0 || velocity !== 0) cylinderFrame = requestAnimationFrame(flowTick);
  else lastFrame = 0;
}

export function cylinderScroll() {
  if (still()) return;
  lastScroll = window.scrollY || 0;
  const schedule = () => {
    if (!cylinderFrame) cylinderFrame = requestAnimationFrame(flowTick);
  };
  shapeList(0);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      lastScroll = window.scrollY || 0;
      schedule();
    }
  });
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  window.addEventListener("hashchange", () => window.setTimeout(schedule, 60));
  // Lists are rebuilt whenever their data changes.
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
}
