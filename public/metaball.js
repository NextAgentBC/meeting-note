// Dragging a photo out of a note. While the finger moves, the photo and the place it came from
// stay connected by a liquid neck: the neck thins with distance, and past a threshold it breaks
// and both ends pull back into rounded blobs. Let go before it breaks and the photo springs home.
//
// The look is one SVG filter — blur, then a steep alpha curve — over two circles and the bar
// between them. Nothing here decides anything: breaking calls back, and the caller removes.

const BREAK_DISTANCE = 96;
const NECK_WIDTH = 26;

let layer = null;

function overlay() {
  if (layer) return layer;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "metaball-layer");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = `
    <defs>
      <filter id="metaball-goo" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="9" result="soft" />
        <feColorMatrix in="soft" type="matrix"
          values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9" result="goo" />
        <feBlend in="SourceGraphic" in2="goo" />
      </filter>
    </defs>
    <g filter="url(#metaball-goo)" fill="currentColor">
      <circle data-anchor r="0" />
      <line data-neck stroke="currentColor" stroke-linecap="round" />
      <circle data-finger r="0" />
    </g>`;
  document.body.append(svg);
  layer = svg;
  return svg;
}

function draw(from, to, distance, colour) {
  const svg = overlay();
  const ratio = Math.min(1, distance / BREAK_DISTANCE);
  svg.style.color = colour;
  svg.style.opacity = "1";
  const anchor = svg.querySelector("[data-anchor]");
  const finger = svg.querySelector("[data-finger]");
  const neck = svg.querySelector("[data-neck]");
  anchor.setAttribute("cx", from.x);
  anchor.setAttribute("cy", from.y);
  // The source blob gives itself up to the one being dragged.
  anchor.setAttribute("r", String(20 - ratio * 9));
  finger.setAttribute("cx", to.x);
  finger.setAttribute("cy", to.y);
  finger.setAttribute("r", "26");
  neck.setAttribute("x1", from.x);
  neck.setAttribute("y1", from.y);
  neck.setAttribute("x2", to.x);
  neck.setAttribute("y2", to.y);
  // The neck is what says how close this is to breaking.
  neck.setAttribute("stroke-width", String(Math.max(0, NECK_WIDTH * (1 - ratio) ** 1.6)));
}

function clear() {
  if (layer) layer.style.opacity = "0";
}

/**
 * Makes everything matching `selector` inside `container` draggable out of place.
 * `onBreak(element)` is called when one is pulled far enough, and nothing else happens here.
 */
export function metaballDrag(container, selector, onBreak) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  container.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const handle = event.target.closest(selector);
    // The × button is still the plain way to do this, and must keep working.
    if (!handle || event.target.closest("button[data-remove-photo]")) return;
    const rect = handle.getBoundingClientRect();
    const from = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const start = { x: event.clientX, y: event.clientY };
    const colour = getComputedStyle(handle).getPropertyValue("--glow-color").trim() || "#8fa0ad";
    let moved = 0;
    let broken = false;
    // Capture keeps the moves coming even when the finger leaves the chip; not every pointer can.
    try { handle.setPointerCapture(event.pointerId); } catch { /* nothing to capture */ }
    handle.classList.add("dragging");

    const move = (pointer) => {
      const to = { x: pointer.clientX, y: pointer.clientY };
      const dx = to.x - start.x;
      const dy = to.y - start.y;
      moved = Math.hypot(dx, dy);
      if (moved > 6) pointer.preventDefault();
      handle.style.transform = `translate(${dx}px, ${dy}px) scale(${1 - Math.min(0.12, moved / 900)})`;
      broken = moved >= BREAK_DISTANCE;
      if (broken) clear();
      else draw(from, { x: from.x + dx, y: from.y + dy }, moved, colour);
    };

    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      handle.classList.remove("dragging");
      clear();
      if (broken) {
        handle.classList.add("breaking");
        window.setTimeout(() => {
          onBreak(handle);
          // Still here? Then breaking meant something other than leaving: put it back.
          if (handle.isConnected) {
            handle.classList.remove("breaking");
            handle.classList.add("returning");
            handle.style.transform = "";
            window.setTimeout(() => handle.classList.remove("returning"), 320);
          }
        }, 160);
        return;
      }
      // Not far enough: the neck pulls it back.
      handle.classList.add("returning");
      handle.style.transform = "";
      window.setTimeout(() => handle.classList.remove("returning"), 320);
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
}
