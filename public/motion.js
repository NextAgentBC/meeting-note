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
  const root = document.documentElement;
  // Only the two translations. Animating the blur radius or the opacity of a full-screen layer
  // repaints it every frame; moving it is a compositor job and costs nothing.
  root.style.setProperty("--depth-far", `${(-scrolled * 0.12).toFixed(1)}px`);
  root.style.setProperty("--depth-mid", `${(-scrolled * 0.04).toFixed(1)}px`);
}

export function depthScroll() {
  if (still() || document.documentElement.dataset.motion === "light") return;
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

// Reading an element's box forces the browser to work out the layout again. Doing that for every
// block on every frame is most of what a phone was choking on, so the boxes are measured once and
// re-measured only when something could have moved them.
let measured = [];
let measuredAt = 0;
// A transformed ancestor moves the native date and time pickers with it, which puts them off the
// screen and paints them wrong. While anything is being typed into, nothing is transformed.
let formFocus = false;

function clearShapes() {
  for (const entry of measured) {
    entry.item.style.removeProperty("transform");
    entry.item.style.removeProperty("opacity");
    entry.last = "off";
  }
}

function measure() {
  measured = [];
  const scrolled = window.scrollY || document.documentElement.scrollTop || 0;
  for (const list of document.querySelectorAll("[data-cylinder]")) {
    [...list.children].forEach((item, index) => {
      if (item.classList.contains("hidden")) return;
      const rect = item.getBoundingClientRect();
      if (!rect.height) return;
      measured.push({ item, index, top: rect.top + scrolled, height: rect.height, last: "" });
    });
  }
  measuredAt = performance.now();
}

function shapeList(lag) {
  if (!measured.length || formFocus) return;
  const breathe = window.innerWidth <= 760;
  const middle = window.innerHeight / 2;
  const scrolled = window.scrollY || document.documentElement.scrollTop || 0;
  for (const entry of measured) {
    const top = entry.top - scrolled;
    if (top + entry.height < -120 || top > window.innerHeight + 120) {
      if (entry.last !== "off") {
        entry.item.style.removeProperty("transform");
        entry.item.style.removeProperty("opacity");
        entry.last = "off";
      }
      continue;
    }
    const drift = `translateY(${(lag * lagFor(entry.index)).toFixed(2)}px)`;
    if (!breathe) {
      if (entry.last !== drift) {
        entry.item.style.transform = drift;
        entry.item.style.removeProperty("opacity");
        entry.last = drift;
      }
      continue;
    }
    // 0 in the middle of the screen, 1 at either edge. No rotation: a tilted block's corners
    // reach past its own box and sit on top of the next one.
    const away = Math.min(1, Math.abs(top + entry.height / 2 - middle) / middle);
    const eased = away * away * (3 - 2 * away);
    const transform = `${drift} scale(${(1 - eased * 0.1).toFixed(3)})`;
    if (entry.last === transform) continue;
    entry.item.style.transform = transform;
    entry.item.style.opacity = (1 - eased * 0.45).toFixed(2);
    entry.last = transform;
  }
}

function rest() {
  flow = 0;
  lastFrame = 0;
  shapeList(0);
}

// A device that cannot keep up gets the app without the movement, rather than the movement badly.
// The judgement is made fresh every visit: it is never remembered, because the thing being judged
// is this build, and the next one may be lighter.
const FRAME_BUDGET_MS = 32;
let slowFrames = 0;
let watchedFrames = 0;
let badWindows = 0;

function degrade() {
  document.documentElement.dataset.motion = "light";
  clearShapes();
  window.dispatchEvent(new CustomEvent("meetingnote:motion-light"));
}

function watchFrameRate(elapsed) {
  if (document.documentElement.dataset.motion === "light") return;
  watchedFrames += 1;
  if (elapsed > FRAME_BUDGET_MS) slowFrames += 1;
  if (watchedFrames < 60) return;
  // Half the frames late, twice in a row: a stutter someone can see, not a slow first paint.
  badWindows = slowFrames / watchedFrames > 0.5 ? badWindows + 1 : 0;
  if (badWindows >= 2) degrade();
  watchedFrames = 0;
  slowFrames = 0;
}

function flowTick(now) {
  cylinderFrame = 0;
  const elapsed = lastFrame ? Math.min(80, now - lastFrame) : 16.7;
  lastFrame = now;
  watchFrameRate(elapsed);
  if (document.documentElement.dataset.motion === "light") return;
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
  if (now - measuredAt > 1200) measure();
  shapeList(lag);
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
  // An older build remembered its own verdict. It does not get to hold this one back.
  try { localStorage.removeItem("meetingnote:motion"); } catch { /* denied */ }
  lastScroll = window.scrollY || 0;
  measure();
  const schedule = () => {
    if (!cylinderFrame) cylinderFrame = requestAnimationFrame(flowTick);
  };
  shapeList(0);
  const remeasure = () => { measure(); schedule(); };
  window.addEventListener("resize", remeasure);
  window.addEventListener("hashchange", () => window.setTimeout(remeasure, 60));
  new MutationObserver(remeasure).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      lastScroll = window.scrollY || 0;
      schedule();
    }
  });
  window.addEventListener("scroll", schedule, { passive: true });
  document.addEventListener("focusin", (event) => {
    if (!event.target.closest?.("input, textarea, select")) return;
    formFocus = true;
    clearShapes();
  });
  document.addEventListener("focusout", () => {
    formFocus = false;
    window.setTimeout(schedule, 120);
  });
}
