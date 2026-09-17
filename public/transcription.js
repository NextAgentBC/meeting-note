// The owner's vocabulary (Me → Transcription), and a meeting's recording: play or download each part,
// download them all as one .zip, keep a permanent copy or not, or delete the audio.
import { buildZip } from "./zip.js";

const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new CustomEvent("meetingnote:signin-required"));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function openSheet(dialog) {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeSheet(dialog) {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

// ── Vocabulary ──────────────────────────────────────────────────────────────

let settings = null;

function renderSettings() {
  const count = settings?.vocabulary?.length ?? 0;
  $("#vocabularySummary").textContent = count
    ? `${count} term${count === 1 ? "" : "s"} · spelled right in every transcript`
    : "Names and terms the transcript should spell right";
  $("#privacyFootnote").textContent = settings?.permanentStorage
    ? "Only you can sign in · recordings are kept until you delete them"
    : `Only you can sign in · audio deletes itself after ${settings?.retentionDays ?? 7} days`;
}

async function loadSettings() {
  try {
    settings = await api("/api/settings/transcription");
    renderSettings();
  } catch {
    // an older copy without these routes: leave the defaults showing
  }
}

window.addEventListener("meetingnote:me-shown", () => void loadSettings());

$("#vocabularyRow").addEventListener("click", async () => {
  const dialog = $("#vocabularyDialog");
  $("#vocabularyStatus").textContent = "";
  if (!settings) await loadSettings();
  $("#vocabularyInput").value = (settings?.vocabulary ?? []).join("\n");
  openSheet(dialog);
});

$("#saveVocabulary").addEventListener("click", async () => {
  const button = $("#saveVocabulary");
  button.disabled = true;
  $("#vocabularyStatus").textContent = "Saving…";
  try {
    const data = await api("/api/settings/transcription", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vocabulary: $("#vocabularyInput").value })
    });
    settings = { ...(settings ?? {}), vocabulary: data.vocabulary };
    $("#vocabularyInput").value = data.vocabulary.join("\n");
    $("#vocabularyStatus").textContent = data.vocabulary.length
      ? `Saved ${data.vocabulary.length} term${data.vocabulary.length === 1 ? "" : "s"}. They apply from the next recording.`
      : "Saved. The vocabulary is empty.";
    renderSettings();
  } catch (error) {
    $("#vocabularyStatus").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#closeVocabularyDialog").addEventListener("click", () => closeSheet($("#vocabularyDialog")));

// ── A meeting's recording ───────────────────────────────────────────────────

let meetingId = null;
let audio = null;

// app.js tells us which meeting is open, and how many chunks it has, every time it refreshes it.
window.addEventListener("meetingnote:meeting-refreshed", (event) => {
  meetingId = event.detail.id;
  $("#audioButton").classList.toggle("hidden", !(event.detail.chunks > 0));
});

function clock(ms) {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

function size(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function extension(mimeType = "") {
  return mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : "webm";
}

function meetingTitle() {
  return ($("#activeMeetingTitle").textContent || "meeting").replace(/[\\/:*?"<>|]+/g, " ").trim() || "meeting";
}

function statusLine(data) {
  const parts = data.parts;
  if (!parts.length) return "No audio has been uploaded for this meeting yet.";
  const available = parts.filter((part) => part.availability !== "gone");
  if (!available.length) {
    return parts.some((part) => part.deleted)
      ? "The audio was deleted. The transcript and the note are still here."
      : "The audio has expired. The transcript and the note are still here.";
  }
  const kept = parts.filter((part) => part.availability === "kept").length;
  if (data.permanentStorage && data.keep) {
    return kept === parts.length
      ? `Kept permanently · all ${parts.length} part${parts.length === 1 ? "" : "s"} saved`
      : `Kept permanently · ${kept} of ${parts.length} parts saved so far`;
  }
  return `Temporary · each part deletes itself ${data.retentionDays} days after it was recorded`;
}

function renderAudio() {
  const data = audio;
  $("#audioStatus").textContent = statusLine(data);
  const available = data.parts.filter((part) => part.availability !== "gone");
  $("#keepAudioRow").classList.toggle("hidden", !(data.permanentStorage && available.length));
  $("#keepAudioToggle").checked = data.keep;
  $("#downloadAllAudio").classList.toggle("hidden", available.length < 2);
  $("#deleteAudioButton").classList.toggle("hidden", !available.length);

  let startMs = 0;
  $("#audioParts").innerHTML = data.parts.map((part) => {
    const from = clock(startMs);
    startMs += part.durationMs;
    const label = part.availability === "kept" ? "kept" : part.availability === "temporary" ? "temporary" : part.deleted ? "deleted" : "expired";
    const url = `/api/meetings/${encodeURIComponent(meetingId)}/audio/${part.sequence}`;
    return `
      <div class="audio-part">
        <div class="audio-part-head">
          <strong>Part ${part.sequence + 1}</strong>
          <small>${escapeHtml(`${from}–${clock(startMs)} · ${size(part.sizeBytes)} · ${label}`)}</small>
        </div>
        ${part.availability === "gone" ? "" : `
          <audio controls preload="none" src="${url}?inline=1"></audio>
          <a class="text-button" href="${url}" download="${escapeHtml(`${meetingTitle()} part-${String(part.sequence + 1).padStart(2, "0")}.${extension(part.mimeType)}`)}">Download</a>`}
      </div>`;
  }).join("");
}

async function loadAudio() {
  $("#audioStatus").textContent = "Loading…";
  $("#audioParts").innerHTML = "";
  $("#audioHint").textContent = "";
  try {
    audio = await api(`/api/meetings/${encodeURIComponent(meetingId)}/audio`);
    renderAudio();
  } catch (error) {
    $("#audioStatus").textContent = error.message;
  }
}

$("#audioButton").addEventListener("click", () => {
  if (!meetingId) return;
  openSheet($("#audioDialog"));
  void loadAudio();
});

$("#closeAudioDialog").addEventListener("click", () => {
  document.querySelectorAll("#audioParts audio").forEach((player) => player.pause());
  closeSheet($("#audioDialog"));
});

$("#keepAudioToggle").addEventListener("change", async (event) => {
  const keep = event.target.checked;
  if (!keep && !window.confirm(`Stop keeping this recording? The permanent copy is deleted now, and the rest deletes itself within ${audio?.retentionDays ?? 7} days of recording.`)) {
    event.target.checked = true;
    return;
  }
  event.target.disabled = true;
  try {
    await api(`/api/meetings/${encodeURIComponent(meetingId)}/audio`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keep })
    });
    $("#audioHint").textContent = keep ? "Saving a permanent copy of every part still stored…" : "";
    await loadAudio();
  } catch (error) {
    event.target.checked = !keep;
    $("#audioHint").textContent = error.message;
  } finally {
    event.target.disabled = false;
  }
});

$("#deleteAudioButton").addEventListener("click", async () => {
  if (!window.confirm("Delete this meeting's audio? The transcript and the note stay. This can't be undone.")) return;
  const button = $("#deleteAudioButton");
  button.disabled = true;
  try {
    document.querySelectorAll("#audioParts audio").forEach((player) => player.pause());
    await api(`/api/meetings/${encodeURIComponent(meetingId)}/audio`, { method: "DELETE" });
    await loadAudio();
  } catch (error) {
    $("#audioHint").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#downloadAllAudio").addEventListener("click", async () => {
  const button = $("#downloadAllAudio");
  const parts = (audio?.parts ?? []).filter((part) => part.availability !== "gone");
  if (!parts.length) return;
  button.disabled = true;
  try {
    const files = [];
    for (const [index, part] of parts.entries()) {
      $("#audioHint").textContent = `Preparing part ${index + 1} of ${parts.length}…`;
      const response = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}/audio/${part.sequence}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`Part ${part.sequence + 1} could not be downloaded (${response.status}).`);
      files.push({ name: `part-${String(part.sequence + 1).padStart(2, "0")}.${extension(part.mimeType)}`, data: await response.arrayBuffer() });
    }
    const url = URL.createObjectURL(buildZip(files));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${meetingTitle()} recording.zip`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    $("#audioHint").textContent = `Downloaded ${files.length} parts as one .zip.`;
  } catch (error) {
    $("#audioHint").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
