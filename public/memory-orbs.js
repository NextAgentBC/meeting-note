// Remembered facts as a field of drifting circles. They knock into each other and off the walls;
// pick one up and it grows into something you can read. The physics is tiny on purpose: equal
// masses, elastic collisions, a little drag, and a gentle pull towards the middle so nothing piles
// up in a corner. Everything is transform-only, and none of it runs when the device asks for less
// motion or when the field is off screen.

const MAX_ORBS = 24;
const MIN_RADIUS = 30;
const MAX_RADIUS = 54;
const DRAG = 0.994;
/** How far past the edge an orb may wander before it comes back in on the other side. */
const MARGIN = 0.35;
/** Soft collisions: a push proportional to how deep the overlap is, not an instant swap. */
const PUSH = 0.028;
const WANDER = 0.0055;

let field = null;
let orbs = [];
let frame = 0;
let held = null;
let visible = true;

const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function radiusFor(fact) {
  // Big enough for its own name first, then a little bigger for a long or often-updated fact.
  const topic = (fact.topic || fact.title || "").trim();
  const longestWord = topic.split(/\s+/).reduce((longest, word) => Math.max(longest, word.length), 0);
  const forName = 22 + longestWord * 3.4 + topic.length * 0.5;
  const weight = (fact.statement || "").length + (Number(fact.priorVersions) || 0) * 40;
  return Math.round(Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, forName, MIN_RADIUS + Math.sqrt(weight) * 1.1)));
}

/** A colour of its own per topic, mixed with the theme so the field still belongs to the app. */
function hueFor(topic) {
  let hash = 0;
  for (const character of topic || "") hash = (hash * 31 + character.charCodeAt(0)) % 360;
  return hash;
}

function orbElement(fact) {
  const orb = document.createElement("button");
  orb.type = "button";
  orb.className = "orb";
  orb.dataset.id = fact.id;
  orb.style.setProperty("--orb-hue", String(hueFor(fact.topic || fact.title || "")));
  const label = document.createElement("span");
  label.textContent = fact.topic || fact.title || "fact";
  orb.append(label);
  return orb;
}


function step() {
  frame = 0;
  const box = field.getBoundingClientRect();
  const width = box.width || 320;
  const height = box.height || 380;
  const edgeX = width * MARGIN;
  const edgeY = height * MARGIN;
  for (const orb of orbs) {
    if (orb === held) continue;
    // Each one wanders on its own slowly turning heading, so the field never settles into a pattern.
    orb.angle += orb.spin;
    orb.vx += Math.cos(orb.angle) * WANDER;
    orb.vy += Math.sin(orb.angle) * WANDER;
    orb.vx *= DRAG;
    orb.vy *= DRAG;
    orb.x += orb.vx;
    orb.y += orb.vy;
    // No walls. An orb that leaves comes back from the opposite side, so the field is a window on
    // something larger rather than a box with everything crammed inside it.
    if (orb.x < -edgeX - orb.r) orb.x = width + edgeX + orb.r;
    if (orb.x > width + edgeX + orb.r) orb.x = -edgeX - orb.r;
    if (orb.y < -edgeY - orb.r) orb.y = height + edgeY + orb.r;
    if (orb.y > height + edgeY + orb.r) orb.y = -edgeY - orb.r;
  }
  // Soft contact: the closer two get, the harder they push apart, and they keep their own speed.
  for (let i = 0; i < orbs.length; i += 1) {
    for (let j = i + 1; j < orbs.length; j += 1) {
      const a = orbs[i];
      const b = orbs[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 0.01;
      const overlap = a.r + b.r - distance;
      if (overlap <= 0) continue;
      const nx = dx / distance;
      const ny = dy / distance;
      const force = Math.min(1.6, overlap * PUSH);
      if (a !== held) { a.vx -= nx * force; a.vy -= ny * force; }
      if (b !== held) { b.vx += nx * force; b.vy += ny * force; }
      // A touch of separation as well, or a deep overlap takes too long to ease apart.
      const ease = overlap * 0.06;
      if (a !== held) { a.x -= nx * ease; a.y -= ny * ease; }
      if (b !== held) { b.x += nx * ease; b.y += ny * ease; }
    }
  }
  for (const orb of orbs) {
    orb.element.style.transform = `translate3d(${(orb.x - orb.r).toFixed(1)}px, ${(orb.y - orb.r).toFixed(1)}px, 0)`;
    // Fading at the edge is what makes leaving and returning look deliberate.
    const outside = Math.max(0, -orb.x, orb.x - width, -orb.y, orb.y - height);
    orb.element.style.opacity = outside <= 0 ? "1" : Math.max(0, 1 - outside / (orb.r * 2.4)).toFixed(2);
  }
  if (visible) frame = requestAnimationFrame(step);
}

function start() {
  if (!frame && visible && !still()) frame = requestAnimationFrame(step);
}

function stop() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
}

/** Reading one: it comes to the front, grows, and shows everything it knows. */
function open(fact) {
  const card = field.parentElement.querySelector(".orb-detail");
  card.querySelector(".orb-detail-topic").textContent = fact.topic || fact.title || "";
  card.querySelector(".orb-detail-text").textContent = fact.statement || fact.snippet || "";
  card.querySelector(".orb-detail-source").textContent = [fact.meetingTitle, fact.when].filter(Boolean).join(" · ");
  card.querySelector("[data-forget]").dataset.forget = fact.id;
  card.style.setProperty("--orb-hue", String(hueFor(fact.topic || fact.title || "")));
  card.classList.remove("hidden");
}

function close() {
  field.parentElement.querySelector(".orb-detail")?.classList.add("hidden");
}

/**
 * Draws the facts as a field of circles inside `host`, and returns true when it did. The caller
 * keeps its own list for anything this cannot show.
 */
export function memoryOrbs(host, facts) {
  stop();
  orbs = [];
  held = null;
  host.replaceChildren();
  if (!facts.length) return false;
  field = document.createElement("div");
  field.className = "orb-field";
  host.append(field);

  const detail = document.createElement("div");
  detail.className = "orb-detail hidden";
  detail.innerHTML = `
    <p class="orb-detail-topic"></p>
    <p class="orb-detail-text"></p>
    <p class="orb-detail-source"></p>
    <div class="orb-detail-actions">
      <button type="button" class="quick-add-button ghost" data-close-orb>Close</button>
      <button type="button" class="plan-remove" data-forget aria-label="Forget this fact">Forget</button>
    </div>`;
  host.append(detail);
  detail.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-orb]")) close();
  });

  const shown = facts.slice(0, MAX_ORBS);
  const box = field.getBoundingClientRect();
  const width = box.width || host.clientWidth || 320;
  const height = box.height || 360;
  for (const fact of shown) {
    const element = orbElement(fact);
    const r = radiusFor(fact);
    element.style.width = `${r * 2}px`;
    element.style.height = `${r * 2}px`;
    field.append(element);
    const orb = {
      element,
      fact,
      r,
      x: r + Math.random() * Math.max(1, width - r * 2),
      y: r + Math.random() * Math.max(1, height - r * 2),
      vx: (Math.random() - 0.5) * 0.7,
      vy: (Math.random() - 0.5) * 0.7,
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.02
    };
    element.style.transform = `translate3d(${orb.x - r}px, ${orb.y - r}px, 0)`;
    orbs.push(orb);

    let moved = 0;
    element.addEventListener("pointerdown", (event) => {
      held = orb;
      moved = 0;
      element.classList.add("held");
      try { element.setPointerCapture(event.pointerId); } catch { /* nothing to capture */ }
      const start = { x: event.clientX, y: event.clientY, ox: orb.x, oy: orb.y };
      const move = (pointer) => {
        moved = Math.hypot(pointer.clientX - start.x, pointer.clientY - start.y);
        const nextX = start.ox + (pointer.clientX - start.x);
        const nextY = start.oy + (pointer.clientY - start.y);
        orb.vx = nextX - orb.x;
        orb.vy = nextY - orb.y;
        orb.x = nextX;
        orb.y = nextY;
        if (moved > 6) pointer.preventDefault();
      };
      const end = () => {
        element.removeEventListener("pointermove", move);
        element.removeEventListener("pointerup", end);
        element.removeEventListener("pointercancel", end);
        element.classList.remove("held");
        held = null;
        // A tap reads it; a drag throws it back into the field with whatever speed it had.
        if (moved < 6) open(orb.fact);
        start();
      };
      element.addEventListener("pointermove", move);
      element.addEventListener("pointerup", end);
      element.addEventListener("pointercancel", end);
      start();
    });
  }

  if (still()) {
    field.classList.add("orb-field-static");
    return true;
  }
  // Only while the field is actually on screen.
  new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    if (visible) start();
    else stop();
  }, { threshold: 0.05 }).observe(field);
  window.addEventListener("resize", start);
  start();
  return true;
}
