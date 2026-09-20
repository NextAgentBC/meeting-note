// Plans: say them, check them, put them on a calendar. app.js calls initPlans() once the owner is
// signed in. What the AI finds is only a suggestion until the owner presses Add.

const $ = (selector) => document.querySelector(selector);
const MAX_DICTATION_MS = 2 * 60 * 1000;
const GROUPS = ["Overdue", "Today", "Tomorrow", "Next 7 days", "Later", "No date yet", "Done"];

let tasks = [];
// One place that says what the dictate button is doing, set before any await, so a second tap during
// the microphone prompt or an upload can't start a second recording.
let phase = "idle"; // idle | starting | recording | stopping | sending
let dictation = null; // the recording in progress
let pendingUpload = null; // a recording that didn't reach the server, kept for "try again"
let editingId = null;
let started = false;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

let toastTimer = 0;
function toast(message, duration = 5000) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.remove("hidden");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element.classList.add("hidden"), duration);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "x-timezone": browserTimeZone(), ...(options.headers || {}) }
  });
  const type = response.headers.get("content-type") || "";
  const body = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new CustomEvent("meetingnote:signin-required"));
    const error = new Error(body?.error || `Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

const json = (value) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

// ── Dates, as the owner reads them ──────────────────────────────────────────

function localToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: browserTimeZone() || undefined }).format(new Date());
}

function addDays(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function dayLabel(date) {
  const today = localToday();
  if (date === today) return "today";
  if (date === addDays(today, 1)) return "tomorrow";
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day, 12)));
}

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function whenText(task) {
  if (!task.date) return "";
  const day = dayLabel(task.date);
  if (task.allDay) return task.kind === "event" ? capitalise(day) : `Due ${day}`;
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: task.timezone }).format(new Date(task.startsAt));
  const zone = task.timezone !== browserTimeZone() ? ` ${task.timezone}` : "";
  const length = !task.durationMinutes ? "" : task.durationMinutes % 60 === 0 ? `${task.durationMinutes / 60} h` : `${task.durationMinutes} min`;
  return [capitalise(day), `${time}${zone}`, length].filter(Boolean).join(" · ");
}

function groupOf(task, today) {
  if (task.status === "done") return "Done";
  if (!task.date) return "No date yet";
  if (task.date < today) return "Overdue";
  if (task.date === today) return "Today";
  if (task.date === addDays(today, 1)) return "Tomorrow";
  if (task.date <= addDays(today, 7)) return "Next 7 days";
  return "Later";
}

// ── The lists ───────────────────────────────────────────────────────────────

function rowHtml(task) {
  if (task.id === editingId) return editHtml(task);
  const suggested = task.status === "suggested";
  const meta = [
    whenText(task) || (suggested ? "No date: add one with Edit, or keep it as a to-do" : "No date"),
    task.repeatHint ? `repeats ${task.repeatHint}` : "",
    task.assignee ? `for ${task.assignee}` : ""
  ].filter(Boolean).join(" · ");
  const origin = task.meetingId && task.meetingTitle
    ? `<button class="plan-origin" type="button" data-action="open-meeting" data-meeting="${escapeHtml(task.meetingId)}">From “${escapeHtml(task.meetingTitle)}”</button>`
    : "";
  const calendarLinks = !suggested && task.status !== "done" && task.googleCalendarUrl
    ? `<a class="quick-add-button ghost" href="${escapeHtml(task.googleCalendarUrl)}" target="_blank" rel="noopener">Google</a>
       <a class="quick-add-button ghost" href="${escapeHtml(task.icsUrl)}">Apple · Outlook</a>`
    : "";
  return `
    <article class="plan-row ${escapeHtml(task.status)}" data-id="${escapeHtml(task.id)}">
      ${suggested
        ? `<span class="plan-kind" role="img" aria-label="${task.kind === "event" ? "Event" : "To-do"}" title="${task.kind === "event" ? "Event" : "To-do"}">${task.kind === "event" ? "◷" : "◇"}</span>`
        : `<button class="plan-check" type="button" data-action="toggle" aria-label="${task.status === "done" ? "Mark as not done" : "Mark as done"}">${task.status === "done" ? "✓" : ""}</button>`}
      <div class="plan-main">
        <strong>${escapeHtml(task.title)}</strong>
        <small class="${task.date ? "" : "missing"}">${escapeHtml(meta)}</small>
        ${task.notes ? `<p class="plan-notes">${escapeHtml(task.notes)}</p>` : ""}
        ${origin}
      </div>
      <div class="plan-actions">
        ${suggested ? '<button class="quick-add-button" type="button" data-action="confirm">Add</button>' : calendarLinks}
        <button class="quick-add-button ghost" type="button" data-action="edit">Edit</button>
        <button class="plan-remove" type="button" data-action="remove" aria-label="${suggested ? "Dismiss" : "Remove"}" title="${suggested ? "Dismiss" : "Remove"}">✕</button>
      </div>
    </article>`;
}

function editHtml(task) {
  return `
    <form class="plan-row plan-edit-row" data-id="${escapeHtml(task.id)}">
      <span></span>
      <div class="plan-edit">
        <input name="title" value="${escapeHtml(task.title)}" maxlength="200" required aria-label="Plan" />
        <label class="stamp"><span>Date</span><input name="date" type="date" value="${escapeHtml(task.date ?? "")}" aria-label="Date" /></label>
        <label class="stamp"><span>Time</span><input name="time" type="time" value="${escapeHtml(task.time ?? "")}" aria-label="Time" /></label>
        <input class="notes" name="notes" value="${escapeHtml(task.notes)}" maxlength="2000" placeholder="Notes" aria-label="Notes" />
        <div class="edit-actions">
          <button class="quick-add-button" type="submit">Save</button>
          <button class="quick-add-button ghost" type="button" data-action="cancel-edit">Cancel</button>
        </div>
      </div>
    </form>`;
}

function render() {
  const suggested = tasks.filter((task) => task.status === "suggested");
  $("#plansBadge").textContent = suggested.length > 9 ? "9+" : String(suggested.length);
  $("#plansBadge").classList.toggle("hidden", suggested.length === 0);
  $("#suggestedBlock").classList.toggle("hidden", suggested.length === 0);
  $("#confirmAllButton").classList.toggle("hidden", suggested.length < 2);
  $("#suggestedList").innerHTML = suggested.map(rowHtml).join("");

  const rest = tasks.filter((task) => task.status !== "suggested");
  if (!rest.length) {
    $("#taskList").innerHTML = '<p class="empty-state">Nothing planned yet. Say a plan, or type one.</p>';
    return;
  }
  const today = localToday();
  const groups = new Map();
  for (const task of rest) {
    const group = groupOf(task, today);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(task);
  }
  $("#taskList").innerHTML = GROUPS.filter((group) => groups.has(group))
    .map((group) => `<p class="plan-group ${group === "Overdue" ? "overdue" : ""}">${group}</p>${groups.get(group).map(rowHtml).join("")}`)
    .join("");
}

export async function loadPlans() {
  try {
    const data = await api("/api/tasks");
    tasks = data.tasks;
    if (!editingId) render(); // a background refresh mustn't throw away an edit in progress
  } catch (error) {
    if (error.status !== 401) $("#taskList").innerHTML = `<p class="empty-state">Couldn't load your plans: ${escapeHtml(error.message)}</p>`;
  }
}

/** Remembers this device's time zone (meetings resolve "next Tuesday" with it), then shows the plans. */
export function initPlans() {
  if (!started) {
    started = true;
    const zone = browserTimeZone();
    if (zone) void api("/api/settings/timezone", { method: "PUT", ...json({ timezone: zone }) }).catch(() => undefined);
    // Meetings recorded before memory existed become searchable in the background.
    void api("/api/memory/catch-up", { method: "POST" }).catch(() => undefined);
  }
  return loadPlans();
}

async function act(button, work) {
  if (button) button.disabled = true;
  try {
    await work();
  } catch (error) {
    toast(error.message, 7000);
  } finally {
    if (button) button.disabled = false;
  }
}

$("#plansSection").addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const id = button.closest("[data-id]")?.dataset.id;
  const task = tasks.find((item) => item.id === id);
  const action = button.dataset.action;

  if (action === "open-meeting") {
    window.dispatchEvent(new CustomEvent("meetingnote:open-meeting", { detail: { id: button.dataset.meeting } }));
  } else if (action === "edit") {
    editingId = id;
    render();
    $(`[data-id="${CSS.escape(id)}"] input[name="title"]`)?.focus();
  } else if (action === "cancel-edit") {
    editingId = null;
    render();
  } else if (action === "confirm") {
    void act(button, async () => {
      await api("/api/tasks/confirm", { method: "POST", ...json({ ids: [id] }) });
      await loadPlans();
    });
  } else if (action === "toggle" && task) {
    void act(button, async () => {
      await api(`/api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", ...json({ status: task.status === "done" ? "confirmed" : "done" }) });
      await loadPlans();
    });
  } else if (action === "remove" && task) {
    void act(button, async () => {
      await api(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (task.status !== "suggested") toast("Removed. A subscribed calendar drops it at its next update.");
      await loadPlans();
    });
  }
});

$("#plansSection").addEventListener("submit", (event) => {
  const form = event.target.closest(".plan-edit-row");
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  void act(form.querySelector('button[type="submit"]'), async () => {
    await api(`/api/tasks/${encodeURIComponent(form.dataset.id)}`, {
      method: "PATCH",
      ...json({ title: data.get("title"), date: data.get("date") || null, time: data.get("time") || null, notes: data.get("notes") || "" })
    });
    editingId = null;
    await loadPlans();
  });
});

$("#confirmAllButton").addEventListener("click", (event) => {
  const ids = tasks.filter((task) => task.status === "suggested").map((task) => task.id);
  if (!ids.length) return;
  void act(event.currentTarget, async () => {
    for (let start = 0; start < ids.length; start += 50) {
      await api("/api/tasks/confirm", { method: "POST", ...json({ ids: ids.slice(start, start + 50) }) });
    }
    await loadPlans();
  });
});

$("#quickAddForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  void act(form.querySelector('button[type="submit"]'), async () => {
    await api("/api/tasks", {
      method: "POST",
      ...json({ title: $("#quickAddTitle").value, date: $("#quickAddDate").value || null, time: $("#quickAddTime").value || null })
    });
    form.reset();
    await loadPlans();
  });
});

// ── Dictation ───────────────────────────────────────────────────────────────

function formatClock(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function resetDictateButton() {
  $("#dictateLabel").textContent = "Tap and say your plans";
  $("#dictateSub").textContent = "Up to two minutes · English or 中文";
}

function showResult(message, transcript) {
  $("#dictateMessage").textContent = message;
  $("#dictateTranscript").textContent = transcript;
  $("#dictateResult").classList.remove("hidden");
}

/** Whether a spoken plan is being recorded or sent; a meeting mustn't start over it. */
export function isDictating() {
  return phase !== "idle";
}

async function startDictation() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast("This browser can't record audio. Type the plan instead.");
    return;
  }
  if (document.body.classList.contains("recording-active")) {
    toast("Stop the meeting recording first.");
    return;
  }
  phase = "starting";
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
  } catch (error) {
    phase = "idle";
    toast(error.name === "NotAllowedError" ? "Microphone permission was declined. Nothing was recorded." : `Couldn't use the microphone: ${error.message}`, 7000);
    return;
  }

  const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
  const parts = [];
  let recorder;
  let context;
  let analyser;
  try {
    recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 48_000 });
    recorder.ondataavailable = (event) => {
      if (event.data.size) parts.push(event.data);
    };
    recorder.start(1000);
    context = new AudioContext();
    if (context.state === "suspended") await context.resume().catch(() => undefined);
    analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context?.close().catch(() => undefined);
    phase = "idle";
    toast(`Couldn't start recording: ${error.message}`, 7000);
    return;
  }
  const samples = new Uint8Array(analyser.fftSize);

  dictation = { recorder, stream, parts, mimeType, context, startedAt: Date.now(), frame: 0 };
  phase = "recording";
  $("#dictateButton").setAttribute("aria-pressed", "true");
  document.body.classList.add("dictating");
  $("#dictateLabel").textContent = "Listening… tap when you're done";
  $("#dictateCancel").classList.remove("hidden");
  $("#dictateResult").classList.add("hidden");

  const orb = $(".dictate-orb i");
  const tick = () => {
    if (!dictation) return;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const value = (sample - 128) / 128;
      sum += value * value;
    }
    orb.style.transform = `scale(${1 + Math.min(1, Math.sqrt(sum / samples.length) * 6) * 0.9})`;
    const elapsed = Date.now() - dictation.startedAt;
    $("#dictateSub").textContent = `${formatClock(elapsed)} of 2:00`;
    if (elapsed >= MAX_DICTATION_MS) {
      void finishDictation();
      return;
    }
    dictation.frame = requestAnimationFrame(tick);
  };
  tick();
}

async function stopCapture() {
  const current = dictation;
  dictation = null;
  phase = "stopping";
  $("#dictateButton").setAttribute("aria-pressed", "false");
  cancelAnimationFrame(current.frame);
  if (current.recorder.state !== "inactive") {
    await new Promise((resolve) => {
      current.recorder.addEventListener("stop", resolve, { once: true });
      try { current.recorder.stop(); } catch { resolve(); }
    });
  }
  current.stream.getTracks().forEach((track) => track.stop());
  await current.context.close().catch(() => undefined);
  document.body.classList.remove("dictating");
  $(".dictate-orb i").style.transform = "";
  $("#dictateCancel").classList.add("hidden");
  return current;
}

async function finishDictation() {
  if (!dictation) return;
  const current = await stopCapture();
  const durationMs = Date.now() - current.startedAt;
  const blob = new Blob(current.parts, { type: current.recorder.mimeType || current.mimeType || "audio/webm" });
  if (durationMs < 1000 || blob.size < 500) {
    phase = "idle";
    resetDictateButton();
    showResult("That was too short. Tap, say your plan, then tap again.", "");
    return;
  }
  await sendDictation({ blob, durationMs });
}

async function sendDictation(upload) {
  phase = "sending";
  pendingUpload = upload;
  const button = $("#dictateButton");
  button.disabled = true;
  document.body.classList.add("dictate-busy");
  $("#dictateLabel").textContent = "Writing down your plans…";
  $("#dictateSub").textContent = "This usually takes a few seconds";
  $("#dictateRetry").classList.add("hidden");
  try {
    const result = await api("/api/dictations", {
      method: "POST",
      headers: { "content-type": upload.blob.type || "audio/webm", "x-duration-ms": String(Math.round(upload.durationMs)) },
      body: upload.blob
    });
    pendingUpload = null;
    const count = result.tasks.length;
    const found = count ? `Found ${count} plan${count === 1 ? "" : "s"}. Check ${count === 1 ? "it" : "them"} and press Add.` : "";
    showResult(result.message || found, result.dictation?.transcript ? `“${result.dictation.transcript}”` : "");
    await loadPlans();
    if (count) $("#suggestedBlock").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    const final = [413, 415, 429].includes(error.status);
    showResult(final ? error.message : `Couldn't send it: ${error.message}`, "");
    if (final) pendingUpload = null;
    else $("#dictateRetry").classList.remove("hidden");
  } finally {
    button.disabled = false;
    document.body.classList.remove("dictate-busy");
    resetDictateButton();
    phase = "idle";
  }
}

$("#dictateButton").addEventListener("click", () => {
  if (phase === "recording") void finishDictation();
  else if (phase === "idle") void startDictation();
  // starting, stopping or sending: the tap is ignored
});

/** Stops a spoken plan without sending it. */
export async function cancelDictation() {
  if (phase !== "recording") return;
  await stopCapture();
  phase = "idle";
  resetDictateButton();
}

$("#dictateCancel").addEventListener("click", () => void cancelDictation());
$("#dictateRetry").addEventListener("click", () => {
  if (pendingUpload && phase === "idle") void sendDictation(pendingUpload);
});

// ── Calendar sync ───────────────────────────────────────────────────────────

function showFeed(url) {
  $("#feedEmpty").classList.toggle("hidden", Boolean(url));
  $("#feedReady").classList.toggle("hidden", !url);
  if (url) {
    $("#feedUrl").value = url;
    $("#webcalLink").href = url.replace(/^https?:/, "webcal:");
    $("#copyFeedButton").textContent = "Copy address";
  }
}

async function openCalendarSync() {
  const dialog = $("#calendarDialog");
  try {
    showFeed((await api("/api/calendar")).feedUrl);
  } catch (error) {
    toast(error.message);
    return;
  }
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

$("#calendarSyncButton").addEventListener("click", () => void openCalendarSync());
$("#calendarSyncRow").addEventListener("click", () => void openCalendarSync());

$("#createFeedButton").addEventListener("click", (event) => {
  void act(event.currentTarget, async () => showFeed((await api("/api/calendar/feed", { method: "POST" })).feedUrl));
});

$("#resetFeedButton").addEventListener("click", (event) => {
  if (!window.confirm("Replace the address? Calendars subscribed to the old one stop updating until you subscribe again.")) return;
  void act(event.currentTarget, async () => showFeed((await api("/api/calendar/feed", { method: "POST" })).feedUrl));
});

$("#copyFeedButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText($("#feedUrl").value);
    button.textContent = "Copied";
  } catch {
    $("#feedUrl").select();
  }
});

$("#closeCalendarDialog").addEventListener("click", () => {
  const dialog = $("#calendarDialog");
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
});
