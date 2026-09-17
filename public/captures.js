// Quick notes: text plus phone-compressed WebP photos. Original files, including their EXIF/GPS
// metadata, never leave this browser.

const $ = (selector) => document.querySelector(selector);
const MAX_IMAGES = 6;
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const FULL_EDGE = 2048;
const THUMB_EDGE = 480;
const FULL_TARGET = 900 * 1024;
const THUMB_TARGET = 110 * 1024;

let pendingPhotos = [];
let initialized = false;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function timeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "x-timezone": timeZone(), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new CustomEvent("meetingnote:signin-required"));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function bytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

async function decode(file) {
  if ("createImageBitmap" in window) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* fallback below */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasFor(image, maxEdge) {
  const sourceWidth = image.width || image.naturalWidth;
  const sourceHeight = image.height || image.naturalHeight;
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0, width, height);
  return canvas;
}

function webp(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (!blob || blob.type !== "image/webp") reject(new Error("This browser cannot make WebP photos. Update Safari or Chrome and try again."));
    else resolve(blob);
  }, "image/webp", quality));
}

async function boundedWebp(canvas, target, qualities) {
  let result = null;
  for (const quality of qualities) {
    result = await webp(canvas, quality);
    if (result.size <= target) break;
  }
  return result;
}

export async function compressPhoto(file) {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name || "That file"} is not a photo.`);
  if (file.size > MAX_SOURCE_BYTES) throw new Error(`${file.name || "That photo"} is larger than 30 MB.`);
  let image;
  try {
    image = await decode(file);
    const fullCanvas = canvasFor(image, FULL_EDGE);
    const thumbCanvas = canvasFor(image, THUMB_EDGE);
    const [full, thumbnail] = await Promise.all([
      boundedWebp(fullCanvas, FULL_TARGET, [0.8, 0.72, 0.64]),
      boundedWebp(thumbCanvas, THUMB_TARGET, [0.72, 0.62, 0.52])
    ]);
    return {
      name: file.name || "Photo",
      originalBytes: file.size,
      width: fullCanvas.width,
      height: fullCanvas.height,
      full,
      thumbnail,
      previewUrl: URL.createObjectURL(thumbnail)
    };
  } catch (error) {
    throw new Error(`Could not read ${file.name || "that photo"}. If it is HEIC, try a screenshot or export it as JPEG. ${error.message || ""}`.trim());
  } finally {
    if (typeof image?.close === "function") image.close();
  }
}

function clearPending() {
  for (const photo of pendingPhotos) URL.revokeObjectURL(photo.previewUrl);
  pendingPhotos = [];
  $("#quickNoteImages").value = "";
  renderPreviews();
}

function renderPreviews() {
  const container = $("#quickNotePreviews");
  container.classList.toggle("hidden", pendingPhotos.length === 0);
  container.innerHTML = pendingPhotos.map((photo, index) => `
    <figure class="photo-preview">
      <img src="${escapeHtml(photo.previewUrl)}" width="160" height="160" alt="Photo ready to upload" />
      <button type="button" data-remove-photo="${index}" aria-label="Remove photo">×</button>
      <figcaption>${escapeHtml(bytes(photo.originalBytes))} → ${escapeHtml(bytes(photo.full.size))}</figcaption>
    </figure>`).join("");
  $("#quickNoteCompression").textContent = pendingPhotos.length ? `${pendingPhotos.length}/${MAX_IMAGES} ready` : "";
}

async function choosePhotos(files) {
  const room = MAX_IMAGES - pendingPhotos.length;
  const chosen = [...files].slice(0, room);
  if (!chosen.length) return;
  const button = $("#addQuickNoteImages");
  button.disabled = true;
  $("#quickNoteCompression").textContent = "Converting to WebP…";
  try {
    for (const file of chosen) {
      pendingPhotos.push(await compressPhoto(file));
      renderPreviews();
    }
  } catch (error) {
    window.alert(error.message);
  } finally {
    button.disabled = false;
    renderPreviews();
  }
}

async function uploadPhoto(captureId, photo) {
  const created = await api(`/api/captures/${encodeURIComponent(captureId)}/images`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ width: photo.width, height: photo.height })
  });
  const id = encodeURIComponent(created.attachment.id);
  const base = `/api/captures/${encodeURIComponent(captureId)}/images/${id}`;
  await api(`${base}/full`, { method: "PUT", headers: { "content-type": "image/webp" }, body: photo.full });
  await api(`${base}/thumbnail`, { method: "PUT", headers: { "content-type": "image/webp" }, body: photo.thumbnail });
}

const CATEGORY = {
  inbox: "Inbox", idea: "Idea", journal: "Journal", meeting: "Meeting",
  plan: "Plan", life: "Life", reference: "Reference"
};

function captureHtml(capture) {
  const photos = (capture.attachments || []).filter((item) => item.status === "ready");
  const images = photos.length ? `<div class="capture-photos">${photos.map((photo) => `
    <button type="button" data-view-photo="${escapeHtml(photo.imageUrl)}" data-photo-alt="${escapeHtml(photo.caption || "Photo attached to this note")}">
      <img src="${escapeHtml(photo.thumbnailUrl)}" loading="lazy" width="180" height="180" alt="${escapeHtml(photo.caption || "Photo attached to this note")}" />
      ${photo.aiStatus === "queued" || photo.aiStatus === "processing" ? '<span>AI reading…</span>' : photo.aiStatus === "failed" ? '<span>AI skipped</span>' : ""}
    </button>`).join("")}</div>` : "";
  const captions = photos.map((photo) => photo.caption).filter(Boolean);
  const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(capture.occurredAt));
  return `
    <article class="capture-card" data-capture="${escapeHtml(capture.id)}">
      <header><span class="kind">${escapeHtml(CATEGORY[capture.category] || capture.category)}</span><time>${escapeHtml(date)}</time></header>
      <h3>${escapeHtml(capture.title)}</h3>
      ${capture.body ? `<p>${escapeHtml(capture.body)}</p>` : ""}
      ${images}
      ${captions.length ? `<p class="capture-caption">${escapeHtml(captions.join(" · "))}</p>` : ""}
      <button class="plan-remove capture-delete" type="button" data-delete-capture="${escapeHtml(capture.id)}" aria-label="Delete this note">Delete</button>
    </article>`;
}

export async function loadCaptures() {
  try {
    const data = await api("/api/captures");
    const captures = data.captures || [];
    $("#capturesBlock").classList.toggle("hidden", captures.length === 0);
    $("#capturesList").innerHTML = captures.map(captureHtml).join("");
  } catch {
    $("#capturesBlock").classList.add("hidden");
  }
}

export async function loadImageAiSetting() {
  try {
    const data = await api("/api/settings/image-ai");
    $("#imageAiToggle").checked = Boolean(data.enabled);
  } catch {
    $("#imageAiToggle").checked = false;
  }
}

export function initCaptures() {
  if (initialized) return;
  initialized = true;
  $("#addQuickNoteImages").addEventListener("click", () => $("#quickNoteImages").click());
  $("#quickNoteImages").addEventListener("change", (event) => void choosePhotos(event.target.files));
  $("#quickNotePreviews").addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-photo]");
    if (!remove) return;
    const [photo] = pendingPhotos.splice(Number(remove.dataset.removePhoto), 1);
    if (photo) URL.revokeObjectURL(photo.previewUrl);
    renderPreviews();
  });

  $("#quickNoteForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = $("#quickNoteBody").value.trim();
    if (!body && !pendingPhotos.length) {
      $("#quickNoteBody").focus();
      return;
    }
    const button = $("#saveQuickNote");
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      const created = await api("/api/captures", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, category: $("#quickNoteCategory").value })
      });
      for (let index = 0; index < pendingPhotos.length; index += 1) {
        button.textContent = `Uploading photo ${index + 1}/${pendingPhotos.length}…`;
        await uploadPhoto(created.capture.id, pendingPhotos[index]);
      }
      $("#quickNoteBody").value = "";
      $("#quickNoteCategory").value = "inbox";
      clearPending();
      await loadCaptures();
      window.dispatchEvent(new CustomEvent("meetingnote:memory-refresh"));
      window.setTimeout(loadCaptures, 6000);
    } catch (error) {
      window.alert(`The note may be saved, but a photo could not finish uploading. ${error.message}`);
      await loadCaptures();
    } finally {
      button.disabled = false;
      button.textContent = "Save note";
    }
  });

  $("#capturesList").addEventListener("click", async (event) => {
    const photo = event.target.closest("[data-view-photo]");
    if (photo) {
      $("#captureLightboxImage").src = photo.dataset.viewPhoto;
      $("#captureLightboxImage").alt = photo.dataset.photoAlt || "Photo attached to this note";
      $("#captureLightbox").showModal();
      return;
    }
    const button = event.target.closest("[data-delete-capture]");
    if (!button || !window.confirm("Delete this quick note and all of its photos?")) return;
    button.disabled = true;
    try {
      await api(`/api/captures/${encodeURIComponent(button.dataset.deleteCapture)}`, { method: "DELETE" });
      button.closest(".capture-card")?.remove();
      if (!$("#capturesList").children.length) $("#capturesBlock").classList.add("hidden");
    } catch (error) {
      button.disabled = false;
      window.alert(error.message);
    }
  });

  $("#closeCaptureLightbox").addEventListener("click", () => $("#captureLightbox").close());
  $("#captureLightbox").addEventListener("click", (event) => {
    if (event.target === $("#captureLightbox")) $("#captureLightbox").close();
  });

  $("#imageAiToggle").addEventListener("change", async (event) => {
    const enabled = event.target.checked;
    event.target.disabled = true;
    try {
      await api("/api/settings/image-ai", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled })
      });
    } catch (error) {
      event.target.checked = !enabled;
      window.alert(error.message);
    } finally {
      event.target.disabled = false;
    }
  });

  window.addEventListener("meetingnote:memory-shown", () => void loadCaptures());
}
