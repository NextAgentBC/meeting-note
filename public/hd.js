import { t } from "./preferences.js";

// "Who said what": a second pass over a finished meeting with a model that separates speakers.
// It costs money in the owner's own Cloudflare account, so nothing here starts without a yes, and
// the price is on screen before the button is pressed.

const $ = (selector) => document.querySelector(selector);
let meetingId = null;
let poll = 0;
let speakers = [];

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}

function speakerRows() {
  const list = $("#hdSpeakers");
  list.classList.toggle("hidden", !speakers.length);
  list.replaceChildren(...speakers.map((speaker) => {
    const row = document.createElement("label");
    row.className = "hd-speaker";
    const said = document.createElement("span");
    const minutes = Math.max(1, Math.round(speaker.seconds / 60));
    said.textContent = `${speaker.label} · ${minutes} min`;
    const input = document.createElement("input");
    input.value = speaker.name || "";
    input.maxLength = 60;
    input.placeholder = t("Their name");
    input.dataset.speaker = speaker.id;
    row.append(said, input);
    return row;
  }));
}

function render(state) {
  const running = state.status === "queued" || state.status === "running";
  $("#hdCost").textContent = state.minutes
    ? `${state.minutes} ${t("minutes of audio")} · ${t("about")} US$${state.estimatedUsd.toFixed(2)}`
    : "";
  $("#hdStatus").textContent = running
    ? `${t("Listening again")} ${state.chunksDone}/${state.chunksTotal}`
    : state.lastError || (state.status === "done" ? t("Done. Name the voices you recognise.") : "");
  speakers = state.speakers || [];
  speakerRows();
  $("#hdStart").classList.toggle("hidden", running || state.status === "done");
  $("#hdStart").disabled = running;
  $("#hdSaveNames").classList.toggle("hidden", state.status !== "done" || !speakers.length);
  $("#hdApply").classList.toggle("hidden", state.status !== "done" || !speakers.length);
  if (running && !poll) poll = window.setInterval(() => void refresh(), 4000);
  if (!running && poll) {
    window.clearInterval(poll);
    poll = 0;
  }
}

async function refresh() {
  if (!meetingId) return;
  try {
    render(await api(`/api/meetings/${encodeURIComponent(meetingId)}/hd`));
  } catch (error) {
    $("#hdStatus").textContent = error.message;
  }
}

/** Shown on a finished meeting; the panel itself stays closed until it is asked for. */
export async function hdAvailable(id) {
  meetingId = id;
  try {
    const state = await api(`/api/meetings/${encodeURIComponent(id)}/hd`);
    $("#hdButton").classList.toggle("hidden", !state.available);
    return state.available;
  } catch {
    $("#hdButton").classList.add("hidden");
    return false;
  }
}

export function initHd({ onRebuild }) {
  $("#hdButton").addEventListener("click", () => {
    $("#hdPanel").classList.toggle("hidden");
    if (!$("#hdPanel").classList.contains("hidden")) void refresh();
  });
  $("#hdClose").addEventListener("click", () => {
    $("#hdPanel").classList.add("hidden");
    if (poll) {
      window.clearInterval(poll);
      poll = 0;
    }
  });

  $("#hdStart").addEventListener("click", async () => {
    const cost = $("#hdCost").textContent;
    // The one place this app spends money: it asks first, with the number in the question.
    if (!window.confirm(`${t("This runs a paid model in your own Cloudflare account.")}\n\n${cost}\n\n${t("Start?")}`)) return;
    $("#hdStart").disabled = true;
    try {
      render(await api(`/api/meetings/${encodeURIComponent(meetingId)}/hd`, { method: "POST" }));
    } catch (error) {
      $("#hdStatus").textContent = error.message;
      $("#hdStart").disabled = false;
    }
  });

  $("#hdSaveNames").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const names = Object.fromEntries([...document.querySelectorAll(".hd-speaker input")]
      .map((input) => [input.dataset.speaker, input.value.trim()]));
    button.disabled = true;
    try {
      const saved = await api(`/api/meetings/${encodeURIComponent(meetingId)}/hd/speakers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ names })
      });
      speakers = saved.speakers || speakers;
      speakerRows();
      $("#hdStatus").textContent = t("Names saved.");
    } catch (error) {
      $("#hdStatus").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $("#hdApply").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (!window.confirm(t("Rewrite this meeting's note from the new transcript, with the names?"))) return;
    button.disabled = true;
    $("#hdStatus").textContent = t("Rewriting…");
    try {
      await api(`/api/meetings/${encodeURIComponent(meetingId)}/hd/apply`, { method: "POST" });
      await onRebuild();
      $("#hdPanel").classList.add("hidden");
    } catch (error) {
      $("#hdStatus").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}
