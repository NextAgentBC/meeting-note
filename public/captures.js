// Quick notes: text plus phone-compressed WebP photos. Original files, including their EXIF/GPS
// metadata, never leave this browser.

import { t } from "./preferences.js";

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

export function isPhotoFile(file) {
  if (file.type?.startsWith("image/")) return true;
  return /\.(?:jpe?g|png|webp|heic|heif)$/i.test(file.name || "");
}

function decodeWithImageElement(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  return new Promise((resolve, reject) => {
    image.onload = () => resolve({ source: image, cleanup: () => URL.revokeObjectURL(url) });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Safari could not decode this photo."));
    };
    image.src = url;
  });
}

async function decode(file) {
  if ("createImageBitmap" in window) {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, cleanup: () => bitmap.close?.() };
    } catch { /* iOS Safari has formats/options createImageBitmap cannot decode; use <img> below */ }
  }
  return decodeWithImageElement(file);
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
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("This device could not prepare the photo.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvas;
}

let wasmEncoder;

async function wasmWebp(canvas, quality) {
  wasmEncoder ||= import("./vendor/webp/encoder.js").then((module) => module.encodeWebp);
  const encode = await wasmEncoder;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This device could not read the prepared photo.");
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const buffer = await encode(pixels, { quality: Math.round(quality * 100) });
  const blob = new Blob([buffer], { type: "image/webp" });
  if (!blob.size) throw new Error("The converted photo was empty.");
  return blob;
}

async function webp(canvas, quality, forceWasm = false) {
  if (!forceWasm && typeof canvas.toBlob === "function") {
    try {
      const native = await new Promise((resolve) => {
        canvas.toBlob(resolve, "image/webp", quality);
      });
      if (native?.size && native.type === "image/webp") return native;
    } catch { /* Fall through to the local encoder. */ }
  }
  // Home-screen Safari versions without Canvas WebP encoding use the bundled local encoder.
  return wasmWebp(canvas, quality);
}

async function boundedWebp(canvas, target, qualities, forceWasm) {
  let result = null;
  for (const quality of qualities) {
    result = await webp(canvas, quality, forceWasm);
    if (result.size <= target) break;
  }
  return result;
}

export async function compressPhoto(file, { forceWasm = false } = {}) {
  if (!isPhotoFile(file)) throw new Error(`${file.name || "That file"} is not a supported photo.`);
  if (file.size > MAX_SOURCE_BYTES) throw new Error(`${file.name || "That photo"} is larger than 30 MB.`);
  let decoded;
  try {
    decoded = await decode(file);
    const fullCanvas = canvasFor(decoded.source, FULL_EDGE);
    const width = fullCanvas.width;
    const height = fullCanvas.height;
    const full = await boundedWebp(fullCanvas, FULL_TARGET, [0.8, 0.72, 0.64], forceWasm);
    // Release the large canvas before preparing the thumbnail. This matters on memory-constrained iPhones.
    fullCanvas.width = 1;
    fullCanvas.height = 1;
    const thumbCanvas = canvasFor(decoded.source, THUMB_EDGE);
    const thumbnail = await boundedWebp(thumbCanvas, THUMB_TARGET, [0.72, 0.62, 0.52], forceWasm);
    thumbCanvas.width = 1;
    thumbCanvas.height = 1;
    return {
      name: file.name || "Photo",
      originalBytes: file.size,
      width,
      height,
      full,
      thumbnail,
      previewUrl: URL.createObjectURL(thumbnail)
    };
  } catch (error) {
    throw new Error(`Could not prepare ${file.name || "that photo"}. JPEG, PNG and WebP are supported. If an older iPhone sends HEIC, choose “Most Compatible” in Camera settings or use a screenshot. ${error.message || "Please try again."}`.trim());
  } finally {
    decoded?.cleanup?.();
  }
}

function clearPending() {
  for (const photo of pendingPhotos) URL.revokeObjectURL(photo.previewUrl);
  pendingPhotos = [];
  $("#quickNoteImages").value = "";
  $("#quickNoteCamera").value = "";
  $("#quickNoteCompression").classList.remove("error");
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
  const buttons = [$("#takeQuickNotePhoto"), $("#addQuickNoteImages")];
  buttons.forEach((button) => { button.disabled = true; });
  $("#quickNoteCompression").classList.remove("error");
  $("#quickNoteCompression").textContent = "Converting to WebP…";
  try {
    for (const file of chosen) {
      pendingPhotos.push(await compressPhoto(file));
      renderPreviews();
    }
  } catch (error) {
    console.error("Photo preparation failed", error);
    const message = t("Could not prepare this photo. Please try again. For HEIC, choose “Most Compatible” in iPhone Camera settings.");
    $("#quickNoteCompression").textContent = message;
    $("#quickNoteCompression").classList.add("error");
    window.alert(message);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
    if (pendingPhotos.length) renderPreviews();
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
  $("#takeQuickNotePhoto").addEventListener("click", () => $("#quickNoteCamera").click());
  $("#addQuickNoteImages").addEventListener("click", () => $("#quickNoteImages").click());
  for (const input of [$("#quickNoteCamera"), $("#quickNoteImages")]) {
    input.addEventListener("change", (event) => {
      const files = event.target.files;
      void choosePhotos(files);
      // iOS otherwise ignores selecting the same photo twice after it was removed.
      event.target.value = "";
    });
  }
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
      window.alert(t(`The note may be saved, but a photo could not finish uploading. ${error.message}`));
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
    if (!button || !window.confirm(t("Delete this quick note and all of its photos?"))) return;
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
