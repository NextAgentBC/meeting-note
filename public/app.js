import { ensureSignedIn } from "./auth.js";
import { initCaptures, loadImageAiSetting } from "./captures.js";
import { initPreferences } from "./preferences.js";
import { inAppBrowser, openOutsideSteps } from "./in-app-browser.js";
import { initGlass } from "./glass.js";
import { cylinderScroll, depthScroll } from "./motion.js";
import { hdAvailable, initHd } from "./hd.js";
import { initPlans, isDictating, loadPlans } from "./plans.js";
import { createVersionWatch, VERSION_CHECK_INTERVAL } from "./version-watch.js";
import "./ask.js";
import "./transcription.js";

const CHUNK_MS = 3 * 60 * 1000;
// Input quieter than this counts as nothing reaching the recorder. Normal speech
// sits around -20 to -35 dBFS; the first silent test recording measured -66.
const SILENCE_DBFS = -50;
const SILENCE_WARN_MS = 20 * 1000;
// Mono Opus. 32 kbps was split across two channels before the capture chain was
// made mono, which left speech about 16 kbps and unrecognisable.
const CHUNK_BITRATE = 48_000;
const BACKUP_BITRATE = 64_000;
const FINALIZE_PREFIX = "meetingnote-pending-finalize:";
const HOMESCREEN_KEY = "meetingnote:homescreen-offered";
const UPDATE_CHECKED_KEY = "meetingnote:update-checked";
const UPDATE_SKIPPED_KEY = "meetingnote:update-skipped";
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;

initPreferences();

const $ = (selector) => document.querySelector(selector);
const form = $("#newMeetingForm");
const recorderPanel = $("#recorderPanel");
const progressPanel = $("#progressPanel");
const stopButton = $("#stopButton");
const toast = $("#toast");

let activeMeeting = null;
let isRecording = false;
let startedAt = 0;
let sequence = 0;
let chunkRecorder = null;
let chunkTimer = null;
let timerInterval = null;
let pollInterval = null;
let pendingChunkStop = null;
let inputStreams = [];
let audioContext = null;
let analyser = null;
let levelFrame = null;
let uploadPumpPromise = null;
let uploadQueue = [];
let inferredExpectedChunks = 0;
let activeHasProcessingFailure = false;
let deferredInstallPrompt = null;
let wakeLock = null;
let lastSoundAt = 0;
let backupRecorder = null;
let backupParts = [];
let backupUrl = null;
let signedIn = false;
// Set once the server runs a newer version than this page (see version-watch.js).
let newerVersion = "";
let refreshDeclined = "";

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function showToast(message, duration = 5000) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.setTimeout(() => toast.classList.add("hidden"), duration);
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isMobileDevice() {
  return window.matchMedia("(max-width: 700px), (pointer: coarse)").matches;
}

function configureMobileCapture() {
  const screenInput = form.querySelector('input[name="source"][value="screen"]');
  const micInput = form.querySelector('input[name="source"][value="microphone"]');
  const screenChoice = screenInput.closest("label");
  const mobileOnly = isMobileDevice() || !navigator.mediaDevices?.getDisplayMedia;
  $("#mobileCaptureNote").classList.toggle("hidden", !mobileOnly);
  screenChoice.closest(".segmented").classList.toggle("hidden", mobileOnly);
  screenChoice.classList.toggle("unsupported", mobileOnly);
  screenInput.disabled = mobileOnly;
  if (mobileOnly) micInput.checked = true;
}

async function requestWakeLock() {
  if (!isRecording || !navigator.wakeLock || document.visibilityState !== "visible") return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch (error) {
    console.warn("Screen wake lock unavailable", error);
  }
}

async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch { /* already released */ }
  wakeLock = null;
}

// Safari never fires beforeinstallprompt, so on an iPhone — where most of this app is used — the
// only way onto the home screen is the Share menu, and someone has to say so.
function homeScreenSteps() {
  // No app's built-in browser can add anything to a home screen: that starts with leaving it.
  if (inAppBrowser()) return openOutsideSteps();
  const agent = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(agent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
    return [
      "Tap the Share button: the square with an arrow, at the bottom of Safari.",
      "Scroll down that list and choose “Add to Home Screen”.",
      "Tap Add. Meeting Note now sits with your other apps."
    ];
  }
  if (/Android/.test(agent)) {
    return [
      "Open the browser menu: the three dots at the top right.",
      "Choose “Install app”, or “Add to Home screen”.",
      "Confirm. Meeting Note now sits with your other apps."
    ];
  }
  return [
    "In Chrome or Edge, click the install icon at the right of the address bar.",
    "In Safari, open the File menu and choose “Add to Dock”.",
    "Meeting Note then opens in its own window, with no address bar."
  ];
}

function openHomeScreenSheet() {
  const dialog = $("#homeScreenDialog");
  $("#homeScreenSteps").replaceChildren(...homeScreenSteps().map((step) => {
    const item = document.createElement("li");
    item.textContent = step;
    return item;
  }));
  $("#appAddress").value = location.origin;
  $("#homeScreenInstall").classList.toggle("hidden", !deferredInstallPrompt);
  dismissHomeScreenBanner();
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  // A long address scrolls to its end on its own; the part worth reading is the start.
  $("#appAddress").scrollLeft = 0;
}

async function installApp() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $("#homeScreenInstall").classList.add("hidden");
}

// Offered once. Someone who says "not now" is not asked again on this device.
function dismissHomeScreenBanner() {
  $("#homeScreenBanner").classList.add("hidden");
  try { localStorage.setItem(HOMESCREEN_KEY, "1"); } catch { /* private browsing can deny storage */ }
}

// An installed copy is one Worker in its owner's own Cloudflare account: nobody can push new code
// into it. So it asks the installer that made it whether a newer release exists, and says so.
// The owner authorizes once there, and the update keeps the database, the audio and the passkey.
async function checkForUpdate() {
  let skipped = "";
  try {
    if (Date.now() - Number(localStorage.getItem(UPDATE_CHECKED_KEY) || 0) < UPDATE_CHECK_INTERVAL) return;
    localStorage.setItem(UPDATE_CHECKED_KEY, String(Date.now()));
    skipped = localStorage.getItem(UPDATE_SKIPPED_KEY) || "";
  } catch { /* private browsing denies storage; asking every time is better than never */ }
  try {
    const health = await api("/api/health");
    if (!health.updateChannel || !health.version) return;
    const response = await fetch(`${health.updateChannel}/api/release`, { cache: "no-store" });
    if (!response.ok) return;
    const latest = await response.json();
    if (!latest.version || latest.version === health.version || latest.version === skipped) return;
    $("#updateLink").href = health.updateChannel;
    $("#updateBanner").dataset.version = latest.version;
    // One banner at a time: getting onto the home screen comes first.
    if ($("#homeScreenBanner").classList.contains("hidden") && $("#refreshBanner").classList.contains("hidden")) {
      $("#updateBanner").classList.remove("hidden");
    }
  } catch {
    // Offline, or the installer is gone. The app carries on as it is.
  }
}

// The Worker was updated while this page stayed open. A refresh swaps the new version in, but never
// by surprise: it waits for a recording or a spoken plan to finish, and the owner is the one who taps.
function offerRefresh() {
  if (!newerVersion || newerVersion === refreshDeclined || isRecording || isDictating()) return;
  if (!$("#reauthBanner").classList.contains("hidden")) return;
  // It outranks the other invitations: the installer's is stale now, and both come back later.
  $("#updateBanner").classList.add("hidden");
  $("#homeScreenBanner").classList.add("hidden");
  $("#refreshBanner").classList.remove("hidden");
}

const versionWatch = createVersionWatch({
  fetchVersion: async () => {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error(`Health check failed: ${response.status}`);
    return (await response.json()).version;
  },
  onNewer: (version) => {
    newerVersion = version;
    offerRefresh();
  }
});

function offerHomeScreen() {
  if (isStandalone() || !isMobileDevice()) return;
  try {
    if (localStorage.getItem(HOMESCREEN_KEY)) return;
  } catch {
    return;
  }
  window.setTimeout(() => {
    if (!isStandalone() && $("#reauthBanner").classList.contains("hidden") && $("#refreshBanner").classList.contains("hidden")) {
      $("#homeScreenBanner").classList.remove("hidden");
    }
  }, 2500);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    // The session ran out: auth.js offers to sign in again without leaving the page.
    if (response.status === 401) window.dispatchEvent(new CustomEvent("meetingnote:signin-required"));
    const error = new Error(body?.error || body || `Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

const delay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

async function apiWithRetry(path, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await api(path, options);
    } catch (error) {
      lastError = error;
      const shouldRetry = navigator.onLine && (!error.status || error.status >= 500);
      if (!shouldRetry || attempt === attempts - 1) break;
      await delay(500 * (2 ** attempt));
    }
  }
  throw lastError;
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function statusLabel(meeting) {
  const labels = {
    recording: "Recording",
    finalizing: "Transcribing",
    ready: "Note ready",
    failed: "Needs attention"
  };
  return labels[meeting.status] || meeting.status;
}

function formatHours(seconds) {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} hours`;
  return `${Math.max(0, Math.round(seconds / 60))} minutes`;
}

/**
 * How much recording today's Workers AI allocation still affords.
 *
 * Whisper costs a flat 0.7772 neurons per second of audio, so a two-hour session
 * is roughly 5,600 neurons of the 10,000 free each day — before the notes. This
 * needs to be visible before a long session, not discovered during one.
 */
async function loadUsage() {
  try {
    const data = await api("/api/usage");
    const left = data.remainingRecordingSeconds;
    $("#usageHeadline").textContent = `${formatHours(left)} of recording left today`;
    $("#usageLine").textContent = `About ${formatHours(left)} of free recording left today`;

    const percent = Math.min(100, data.freeDailyNeurons ? data.usedNeurons / data.freeDailyNeurons * 100 : 0);
    const bar = $("#usageBar");
    bar.style.width = `${percent}%`;
    bar.classList.toggle("warn", left < 2 * 3600);
    bar.classList.toggle("over", left <= 0);

    const kindNames = {
      asr: "transcription", segment: "section notes", final: "meeting notes",
      plan: "plans", ask: "answers", search: "search", facts: "facts",
      embed: "memory search", vision: "photo understanding"
    };
    const kinds = data.byKind.length
      ? data.byKind.map((item) => `${kindNames[item.kind] || item.kind} ${Math.round(item.neurons)}`).join(" · ")
      : "nothing used yet";
    const perHour = Math.round(data.neuronsPerAudioSecond * 3600);
    $("#usageMeta").textContent = `${Math.round(data.usedNeurons).toLocaleString()} of ${data.freeDailyNeurons.toLocaleString()} free AI units used (${kinds}). An hour of recording uses about ${perHour.toLocaleString()}.${data.hardLimit ? " At the limit AI pauses until it resets; nothing is billed." : ""}`;
    $("#usageReset").textContent = `resets ${new Date(data.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    $("#usageBreakdown").innerHTML = (data.byKind || []).map((item) => {
      const units = Math.round(item.neurons);
      const amount = units > 0 ? `${units.toLocaleString()} units · ` : "";
      return `<span><b>${escapeHtml(kindNames[item.kind] || item.kind)}</b> ${amount}${item.calls} call${item.calls === 1 ? "" : "s"}</span>`;
    }).join("");
    $("#usageCard").classList.remove("hidden");
  } catch (error) {
    console.warn("Usage unavailable", error);
  }
}

async function loadMeetings() {
  const container = $("#meetingList");
  try {
    const data = await api("/api/meetings");
    if (!data.meetings.length) {
      container.innerHTML = '<p class="empty-state">No recordings yet. Your first meeting will appear here.</p>';
      return;
    }
    container.innerHTML = data.meetings.map((meeting) => `
      <button class="meeting-row" type="button" data-id="${escapeHtml(meeting.id)}">
        <span><strong>${escapeHtml(meeting.title)}</strong><small>${escapeHtml(formatDate(meeting.startedAt))}</small></span>
        <time>${escapeHtml(formatDate(meeting.startedAt))}</time>
        <span class="row-status">${escapeHtml(statusLabel(meeting))} →</span>
      </button>`).join("");
    container.querySelectorAll(".meeting-row").forEach((row) => row.addEventListener("click", () => openMeeting(row.dataset.id)));
  } catch (error) {
    container.innerHTML = `<p class="empty-state">Could not load meetings: ${escapeHtml(error.message)}</p>`;
  }
}

async function createCaptureStream(source) {
  const mic = await navigator.mediaDevices.getUserMedia({
    // Mono: speech recognition gains nothing from two channels, and at 32 kbps a
    // stereo stream splits the budget, leaving about 16 kbps per channel.
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  });
  inputStreams.push(mic);

  audioContext = new AudioContext();
  // A context created outside a user gesture starts suspended, and a suspended
  // graph silently produces nothing.
  if (audioContext.state === "suspended") await audioContext.resume().catch(() => undefined);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;

  if (source === "microphone") {
    const micNode = audioContext.createMediaStreamSource(mic);
    micNode.connect(analyser);
    return mic;
  }

  if (!navigator.mediaDevices.getDisplayMedia) {
    throw new Error("Screen audio capture is not available on this device. Choose microphone only.");
  }
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    inputStreams.push(display);
  } catch (error) {
    mic.getTracks().forEach((track) => track.stop());
    throw error;
  }

  const destination = audioContext.createMediaStreamDestination();
  destination.channelCount = 1;
  destination.channelCountMode = "explicit";
  destination.channelInterpretation = "speakers";

  const mix = audioContext.createGain();
  const micNode = audioContext.createMediaStreamSource(mic);
  micNode.connect(mix);

  if (display.getAudioTracks().length) {
    const displayAudio = new MediaStream(display.getAudioTracks());
    audioContext.createMediaStreamSource(displayAudio).connect(mix);
  } else {
    showToast("The shared window supplied no audio. Microphone recording will continue; choose a browser tab with audio or enable system audio for the Zoom voices.", 9000);
  }

  // Shared application audio arrives far quieter than a microphone: the first
  // real test averaged -44 dBFS, of which the speech detector kept under a
  // fifth, and the transcript that came back was guesswork. Level the mix and
  // make up the difference so quiet call audio reaches the recogniser usable.
  const leveller = audioContext.createDynamicsCompressor();
  leveller.threshold.value = -30;
  leveller.knee.value = 20;
  leveller.ratio.value = 4;
  leveller.attack.value = 0.01;
  leveller.release.value = 0.25;
  const makeup = audioContext.createGain();
  makeup.gain.value = 2.2; // about +7 dB, applied after the compressor caps peaks

  mix.connect(leveller);
  leveller.connect(makeup);
  makeup.connect(destination);
  makeup.connect(analyser);
  display.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (isRecording) showToast("Screen sharing ended. Your microphone is still captured in the current mixed stream.", 7000);
  });
  return destination.stream;
}

function preferredMimeType() {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function startChunk(stream, mimeType) {
  if (!isRecording) return;
  const parts = [];
  const chunkStartedAt = Date.now();
  chunkRecorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: CHUNK_BITRATE });
  chunkRecorder.ondataavailable = (event) => {
    if (event.data.size) parts.push(event.data);
  };
  chunkRecorder.onstop = async () => {
    const durationMs = Date.now() - chunkStartedAt;
    const blob = new Blob(parts, { type: chunkRecorder.mimeType || mimeType || "audio/webm" });
    try {
      if (blob.size > 0 && activeMeeting) {
        const chunkSequence = sequence;
        sequence += 1;
        const item = { key: `${activeMeeting.id}:${chunkSequence}`, meetingId: activeMeeting.id, sequence: chunkSequence, durationMs, blob, mimeType: blob.type };
        inferredExpectedChunks = Math.max(inferredExpectedChunks, chunkSequence + 1);
        $("#chunkCount").textContent = String(sequence);
        try {
          await savePending(item);
        } catch (error) {
          console.warn("Could not cache audio in IndexedDB; attempting direct upload", error);
          showToast("This audio chunk could not be cached locally. Keeping the app open while it uploads.", 7000);
        }
        uploadQueue.push(item);
        void processUploads();
      }
    } finally {
      pendingChunkStop?.();
      pendingChunkStop = null;
      if (isRecording) startChunk(stream, mimeType);
    }
  };
  chunkRecorder.start();
  chunkTimer = window.setTimeout(() => {
    if (chunkRecorder?.state === "recording") chunkRecorder.stop();
  }, CHUNK_MS);
}

/**
 * Level meter, plus the check that something is actually being heard.
 *
 * A recording that captures silence used to run to the end and produce an empty
 * note with no warning at any point — the failure only became visible two hours
 * later. The meter now measures real input level and says so on screen.
 */
/**
 * Second recorder over the same stream, kept for the whole session.
 *
 * This is the safety net for a one-shot event: if anything in the cloud path
 * fails, the raw audio still exists on this machine. Two MediaRecorders on one
 * MediaStream is supported; a failure here must never stop the real recording.
 */
function startBackupRecorder(stream, mimeType) {
  backupParts = [];
  if (backupUrl) { URL.revokeObjectURL(backupUrl); backupUrl = null; }
  $("#backupLink").classList.add("hidden");
  try {
    backupRecorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: BACKUP_BITRATE });
    backupRecorder.ondataavailable = (event) => { if (event.data.size) backupParts.push(event.data); };
    backupRecorder.start(10_000);
  } catch (error) {
    backupRecorder = null;
    console.warn("Local backup recorder unavailable", error);
    showToast("The local backup recording could not start. Cloud recording continues as normal.", 7000);
  }
}

async function stopBackupRecorder(title) {
  if (!backupRecorder) return;
  const recorder = backupRecorder;
  backupRecorder = null;
  if (recorder.state !== "inactive") {
    await new Promise((resolve) => {
      recorder.addEventListener("stop", resolve, { once: true });
      try { recorder.stop(); } catch { resolve(); }
    });
  }
  if (!backupParts.length) return;

  const blob = new Blob(backupParts, { type: recorder.mimeType || "audio/webm" });
  backupParts = [];
  backupUrl = URL.createObjectURL(blob);
  const link = $("#backupLink");
  link.href = backupUrl;
  link.download = `${(title || "meeting").replace(/[^\w\u4e00-\u9fff-]+/g, "-")}.webm`;
  link.textContent = `Download the full local recording (${(blob.size / 1048576).toFixed(1)} MB)`;
  link.classList.remove("hidden");
}

function startMeter() {
  const canvas = $("#levelMeter");
  const context = canvas.getContext("2d");
  const data = new Uint8Array(analyser.frequencyBinCount);
  const samples = new Uint8Array(analyser.fftSize);
  const warning = $("#silenceWarning");
  lastSoundAt = Date.now();

  const draw = () => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const value = (sample - 128) / 128;
      sum += value * value;
    }
    const dbfs = 20 * Math.log10(Math.sqrt(sum / samples.length) || 1e-9);
    $("#levelDb").textContent = dbfs > -90 ? `${Math.round(dbfs)} dB` : "silent";

    if (dbfs > SILENCE_DBFS) lastSoundAt = Date.now();
    const silentFor = Date.now() - lastSoundAt;
    if (isRecording && silentFor > SILENCE_WARN_MS) {
      warning.textContent = `Nothing has been heard for ${Math.round(silentFor / 1000)} seconds. Check that your microphone is not muted — and if you are sharing Zoom, that you ticked “Share tab audio” or “Share system audio” in the Chrome dialog. Audio recorded now will produce an empty note.`;
      warning.classList.remove("hidden");
      document.body.classList.add("input-silent");
    } else {
      warning.classList.add("hidden");
      document.body.classList.remove("input-silent");
    }

    analyser.getByteFrequencyData(data);
    context.clearRect(0, 0, canvas.width, canvas.height);
    const bars = 52;
    const gap = 5;
    const width = (canvas.width - gap * (bars - 1)) / bars;
    for (let index = 0; index < bars; index++) {
      const sample = data[Math.floor(index * data.length / bars)] / 255;
      const height = 5 + sample * 58;
      context.fillStyle = `rgba(0, 229, 208, ${0.18 + sample * 0.82})`;
      context.fillRect(index * (width + gap), (canvas.height - height) / 2, width, height);
    }
    levelFrame = requestAnimationFrame(draw);
  };
  draw();
}

// ── Navigation: one view at a time, chosen by the address (#/meetings, #/meetings/<id>, #/plans,
// #/memory, #/me), so the tab bar, the back gesture and home-screen shortcuts all just change it.
// A recording carries on whichever tab is open; the red pill in the top bar leads back to it.

const TABS = ["meetings", "plans", "memory", "me"];
const TITLES = { meetings: "Meetings", meeting: "Meeting", plans: "Plans", memory: "Notes", me: "Me" };
const TEMPLATE_LABELS = { meeting: "Business meeting", workshop: "Workshop", interview: "Interview" };
let currentView = "";

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("?")[0].split("/").filter(Boolean);
  const tab = TABS.includes(parts[0]) ? parts[0] : "meetings";
  if (tab === "meetings" && parts[1]) return { view: "meeting", tab, id: decodeURIComponent(parts[1]) };
  return { view: tab, tab };
}

function navigate(hash) {
  if (location.hash === hash) renderRoute();
  else location.hash = hash;
}

function updateRecordingPill() {
  const route = parseRoute();
  const onRecording = route.view === "meeting" && route.id === activeMeeting?.id;
  $("#recordingPill").classList.toggle("hidden", !isRecording || onRecording);
  if (isRecording) $("#recordingPillTime").textContent = formatDuration(Date.now() - startedAt).replace(/^00:/, "");
}

function renderRoute() {
  if (!signedIn) return;
  const route = parseRoute();
  const changed = route.view !== currentView || route.view === "meeting";
  currentView = route.view;
  document.querySelectorAll(".app-view").forEach((view) => view.classList.toggle("hidden", view.dataset.view !== route.view));
  document.querySelectorAll("#tabbar a").forEach((link) => {
    if (link.dataset.tab === route.tab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  $("#backButton").classList.toggle("hidden", route.view !== "meeting");
  $("#viewTitle").textContent = TITLES[route.view];
  updateRecordingPill();
  if (changed) window.scrollTo(0, 0);

  if (route.view === "meeting") {
    void showMeeting(route.id);
    return;
  }
  // Leaving a meeting stops refreshing it, unless it's the one being recorded.
  if (!isRecording) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (route.view === "meetings") void loadMeetings();
  if (route.view === "plans") void loadPlans();
  if (route.view === "me") {
    void loadUsage();
    void loadImageAiSetting();
    window.dispatchEvent(new CustomEvent("meetingnote:me-shown"));
  }
  if (route.view === "memory") window.dispatchEvent(new CustomEvent("meetingnote:memory-shown"));
}

function goHome() {
  navigate("#/meetings");
}

function setPane(name) {
  const note = name !== "transcript";
  $("#noteTab").setAttribute("aria-selected", String(note));
  $("#transcriptTab").setAttribute("aria-selected", String(!note));
  $("#notePane").classList.toggle("pane-hidden", !note);
  $("#transcriptPane").classList.toggle("pane-hidden", note);
}

async function beginMeeting(event) {
  event.preventDefault();
  if (isDictating()) {
    showToast("Finish or cancel the spoken plan first.");
    return;
  }
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    showToast("This browser cannot record audio. Use a current version of Chrome.");
    return;
  }

  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  submit.querySelector("span:last-child").textContent = "Waiting for permission…";
  let stream;
  try {
    const source = new FormData(form).get("source");
    stream = await createCaptureStream(source);
    const result = await api("/api/meetings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: $("#meetingTitle").value,
        template: $("#meetingTemplate").value,
        language: $("#meetingLanguage").value
      })
    });
    activeMeeting = result.meeting;
    isRecording = true;
    document.body.classList.add("recording-active");
    startedAt = Date.now();
    sequence = 0;
    inferredExpectedChunks = 0;
    activeHasProcessingFailure = false;
    setPane("note");
    navigate(`#/meetings/${encodeURIComponent(activeMeeting.id)}`);
    $("#activeMeetingTitle").textContent = activeMeeting.title;
    $("#meetingKicker").textContent = TEMPLATE_LABELS[activeMeeting.template] ?? activeMeeting.template;
    $("#meetingStatus").textContent = "Recording";
    $("#timer").textContent = "00:00:00";
    $("#chunkCount").textContent = "0";
    $("#transcribedCount").textContent = "0";
    $("#retryFinalizeButton").textContent = "Retry finishing this meeting";
    recorderPanel.classList.remove("hidden");
    progressPanel.classList.add("hidden");
    $("#transcriptList").innerHTML = '<p class="empty-state">The first transcript appears after the initial 3-minute chunk.</p>';
    $("#summaryContent").innerHTML = '<p class="empty-state">Notes appear here about five minutes after you start.</p>';

    const mimeType = preferredMimeType();
    startChunk(stream, mimeType);
    startBackupRecorder(stream, mimeType);
    startMeter();
    void requestWakeLock();
    timerInterval = window.setInterval(() => {
      $("#timer").textContent = formatDuration(Date.now() - startedAt);
      updateRecordingPill();
    }, 500);
    startPolling(activeMeeting.id);
  } catch (error) {
    inputStreams.forEach((input) => input.getTracks().forEach((track) => track.stop()));
    inputStreams = [];
    if (error.name === "NotAllowedError") showToast("Recording permission was cancelled. Nothing was created.");
    else showToast(`Could not start: ${error.message}`, 7000);
  } finally {
    submit.disabled = false;
    submit.querySelector("span:last-child").textContent = "Start recording";
  }
}

async function stopRecording() {
  if (!isRecording || !activeMeeting) return;
  stopButton.disabled = true;
  stopButton.lastChild.textContent = " Saving final chunk…";
  isRecording = false;
  updateRecordingPill();
  document.body.classList.remove("recording-active");
  clearTimeout(chunkTimer);
  clearInterval(timerInterval);
  clearInterval(pollInterval);

  await stopBackupRecorder(activeMeeting.title);

  if (chunkRecorder?.state === "recording") {
    await new Promise((resolve) => {
      pendingChunkStop = resolve;
      try { chunkRecorder.requestData(); } catch { /* stop() still flushes data */ }
      window.setTimeout(() => {
        if (chunkRecorder?.state === "recording") chunkRecorder.stop();
      }, 120);
    });
  }

  inputStreams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  inputStreams = [];
  cancelAnimationFrame(levelFrame);
  await audioContext?.close().catch(() => undefined);
  await releaseWakeLock();

  recorderPanel.classList.add("hidden");
  progressPanel.classList.remove("hidden");
  $("#meetingStatus").textContent = "Finalizing";
  $("#progressTitle").textContent = "Uploading final audio";
  $("#progressDetail").textContent = "Keeping this page open until the last chunk is safely stored…";
  $("#retryFinalizeButton").classList.add("hidden");
  try {
    if (sequence === 0) throw new Error("No audio was captured. Please start a new test and speak for at least two seconds before stopping.");
    await finishMeeting(activeMeeting.id, sequence);
    showToast("Audio uploaded. Cloud transcription is continuing in the background.", 7000);
    startPolling(activeMeeting.id);
    await refreshActiveMeeting();
  } catch (error) {
    $("#meetingStatus").textContent = "Needs attention";
    $("#progressTitle").textContent = "Could not finish this recording";
    $("#progressDetail").textContent = error.message;
    $("#retryFinalizeButton").textContent = "Retry finishing this meeting";
    $("#retryFinalizeButton").classList.remove("hidden");
    showToast(`The audio is cached on this device and will retry automatically: ${error.message}`, 9000);
  } finally {
    stopButton.disabled = false;
    stopButton.lastChild.textContent = " Stop & create note";
    // The last chunk is stored (or waiting in IndexedDB), so a refresh held back until now is safe.
    offerRefresh();
  }
}

function openMeeting(id) {
  navigate(`#/meetings/${encodeURIComponent(id)}`);
}

/** Shows one meeting; for the meeting being recorded, the live recorder stays as it is. */
async function showMeeting(id) {
  if (isRecording && activeMeeting?.id !== id) {
    showToast("Stop the recording before opening another meeting.");
    navigate(`#/meetings/${encodeURIComponent(activeMeeting.id)}`);
    return;
  }
  if (isRecording) {
    await refreshActiveMeeting();
    return;
  }
  if (activeMeeting?.id !== id) {
    if (backupUrl) { URL.revokeObjectURL(backupUrl); backupUrl = null; $("#backupLink").classList.add("hidden"); }
    activeMeeting = { id };
    $("#audioButton").classList.add("hidden");
    $("#rebuildNoteButton").classList.add("hidden");
    $("#hdButton").classList.add("hidden");
    $("#hdPanel").classList.add("hidden");
    $("#exportLink").classList.add("hidden");
    progressPanel.classList.add("hidden");
    $("#activeMeetingTitle").textContent = "Loading…";
    $("#summaryContent").innerHTML = '<p class="empty-state">Loading…</p>';
    $("#transcriptList").innerHTML = "";
    setPane("note");
  }
  recorderPanel.classList.add("hidden");
  await refreshActiveMeeting();
  startPolling(id);
}

function startPolling(id) {
  clearInterval(pollInterval);
  pollInterval = window.setInterval(() => {
    if (activeMeeting?.id === id) void refreshActiveMeeting();
  }, 5000);
}

function renderTranscript(chunks) {
  $("#transcriptMeta").textContent = `${chunks.length} chunk${chunks.length === 1 ? "" : "s"}`;
  if (!chunks.length) {
    $("#transcriptList").innerHTML = '<p class="empty-state">No audio chunks have arrived yet.</p>';
    return;
  }
  $("#transcriptList").innerHTML = chunks.map((chunk) => `
    <article class="transcript-chunk">
      <span class="chunk-index">${String(chunk.sequence + 1).padStart(2, "0")}</span>
      ${chunk.transcript
        ? `<p>${escapeHtml(chunk.transcript)}</p>`
        : `<span class="chunk-state ${chunk.status === "failed" || chunk.status === "done" ? "failed" : ""}">${escapeHtml(
            chunk.status === "failed" ? (chunk.lastError || "Transcription failed")
              : chunk.status === "done" ? "No speech detected in this chunk"
              : `${chunk.status}…`)}</span>`}
    </article>`).join("");
}

function renderSegments(segments) {
  const written = segments.filter((segment) => segment.note);
  if (!written.length) {
    const pending = segments.length > 0;
    $("#summaryContent").innerHTML = `<p class="empty-state">${pending
      ? "Writing the first section note…"
      : "Notes appear here about five minutes after you start, and are merged into one note when you stop."}</p>`;
    return;
  }

  $("#summaryContent").innerHTML = `
    <p class="running-hint">Written while the meeting runs · merged into one note when you stop</p>
    ${written.map((segment) => {
      const note = segment.note;
      const chips = [
        ...note.tools.map((item) => ({ kind: "tool", text: item })),
        ...note.resources.map((item) => ({ kind: "resource", text: item }))
      ];
      return `
      <section class="segment-note">
        <header>
          <span class="segment-index">${String(segment.seq + 1).padStart(2, "0")}</span>
          <h3>${escapeHtml(note.headline)}</h3>
        </header>
        ${note.bullets.length ? `<ul>${note.bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
        ${note.decisions.length ? `<p class="segment-label">Decisions</p><ul>${note.decisions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
        ${note.questions.length ? `<p class="segment-label">Questions</p><ul>${note.questions.map((item) => `<li><strong>${escapeHtml(item.question)}</strong>${item.answer ? `<br>${escapeHtml(item.answer)}` : ""}</li>`).join("")}</ul>` : ""}
        ${note.action_items.length ? `<p class="segment-label">Action items</p>${note.action_items.map((item) => `<div class="action">${escapeHtml(item.task)}<small>${escapeHtml([item.owner, item.due].filter(Boolean).join(" · "))}</small></div>`).join("")}` : ""}
        ${chips.length ? `<p class="segment-chips">${chips.map((chip) => `<span class="chip ${chip.kind}">${escapeHtml(chip.text)}</span>`).join("")}</p>` : ""}
      </section>`;
    }).join("")}`;
}

function renderNote(summary, segments) {
  if (!summary) {
    renderSegments(segments);
    return;
  }
  const questions = summary.audience_questions || [];
  const actions = summary.action_items || [];
  const decisions = summary.decisions || [];
  $("#summaryContent").innerHTML = `
    <section class="summary-block"><h3>Overview</h3><p>${escapeHtml(summary.overview)}</p></section>
    <section class="summary-block"><h3>Key points</h3><ul>${(summary.key_points || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>None captured</li>"}</ul></section>
    <section class="summary-block"><h3>Decisions</h3><ul>${decisions.map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>None captured</li>"}</ul></section>
    <section class="summary-block"><h3>Audience questions</h3><ul>${questions.map((item) => `<li><strong>${escapeHtml(item.question)}</strong>${item.answer ? `<br>${escapeHtml(item.answer)}` : ""}</li>`).join("") || "<li>None captured</li>"}</ul></section>
    <section class="summary-block"><h3>Action items</h3>${actions.map((item) => `<div class="action">${escapeHtml(item.task)}<small>${escapeHtml([item.owner, item.due].filter(Boolean).join(" · "))}</small></div>`).join("") || '<p class="empty-state">None captured</p>'}</section>
    <section class="summary-block"><h3>Resources promised</h3><ul>${(summary.resources_promised || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>None captured</li>"}</ul></section>
    <section class="summary-block"><h3>Follow-up</h3><p>${escapeHtml(summary.follow_up_message)}</p></section>`;
}

async function refreshActiveMeeting() {
  if (!activeMeeting?.id) return;
  try {
    const data = await api(`/api/meetings/${activeMeeting.id}`);
    if (activeMeeting?.id !== data.meeting.id) return; // the owner has moved on to another meeting
    activeMeeting = data.meeting;
    $("#activeMeetingTitle").textContent = activeMeeting.title;
    $("#meetingKicker").textContent = [formatDate(activeMeeting.startedAt), TEMPLATE_LABELS[activeMeeting.template] ?? activeMeeting.template].filter(Boolean).join(" · ");
    $("#meetingStatus").textContent = statusLabel(activeMeeting);
    $("#transcribedCount").textContent = String(activeMeeting.processedChunks);
    const segments = data.segments || [];
    renderTranscript(data.chunks);
    // transcription.js shows the Recording button once there is audio to play or download.
    window.dispatchEvent(new CustomEvent("meetingnote:meeting-refreshed", { detail: { id: activeMeeting.id, chunks: data.chunks.length } }));
    renderNote(activeMeeting.summary, segments);
    const writtenSegments = segments.filter((segment) => segment.note).length;
    $("#segmentCount").textContent = String(writtenSegments);
    const serverChunkCount = data.chunks.reduce((count, chunk) => Math.max(count, chunk.sequence + 1), 0);
    const localChunkCount = uploadQueue
      .filter((item) => item.meetingId === activeMeeting.id)
      .reduce((count, item) => Math.max(count, item.sequence + 1), 0);
    inferredExpectedChunks = Math.max(inferredExpectedChunks, activeMeeting.expectedChunks || 0, serverChunkCount, localChunkCount);

    const expected = activeMeeting.expectedChunks || Math.max(data.chunks.length, 1);
    const transcriptPercent = Math.min(88, Math.round(activeMeeting.processedChunks / expected * 88));
    if (activeMeeting.status === "finalizing") {
      progressPanel.classList.remove("hidden");
      $("#progressBar").style.width = `${activeMeeting.summaryStatus === "processing" ? 94 : transcriptPercent}%`;
      $("#progressTitle").textContent = activeMeeting.summaryStatus === "processing" ? "Merging your meeting note" : "Finishing transcript";
      $("#progressDetail").textContent = `${activeMeeting.processedChunks} of ${expected} audio chunks transcribed · ${writtenSegments} section${writtenSegments === 1 ? "" : "s"} written`;
      // Nothing should be able to hold the note hostage indefinitely.
      $("#forceSummaryButton").classList.toggle("hidden", writtenSegments === 0 || activeMeeting.forceSummary === true);
    } else if (activeMeeting.status === "ready") {
      $("#rebuildNoteButton").classList.remove("hidden");
      void hdAvailable(activeMeeting.id);
      progressPanel.classList.add("hidden");
      $("#retryFinalizeButton").classList.add("hidden");
      $("#forceSummaryButton").classList.add("hidden");
      clearInterval(pollInterval);
    }
    if (writtenSegments > 0 || activeMeeting.summaryMarkdown) {
      $("#exportLink").href = `/api/meetings/${activeMeeting.id}/export.md`;
      $("#exportLink").textContent = activeMeeting.summaryMarkdown ? "Export .md" : "Export notes so far";
      $("#exportLink").classList.remove("hidden");
    }
    if (activeMeeting.status === "recording" && !isRecording && inferredExpectedChunks > 0) {
      progressPanel.classList.remove("hidden");
      $("#progressTitle").textContent = "This recording still needs to be finished";
      $("#progressDetail").textContent = "Your audio is available. Tap retry to finish transcription and create the note.";
      $("#retryFinalizeButton").textContent = "Retry finishing this meeting";
      $("#retryFinalizeButton").classList.remove("hidden");
    }
    activeHasProcessingFailure = activeMeeting.summaryStatus === "failed" || data.chunks.some((chunk) => chunk.status === "failed");
    if (activeHasProcessingFailure) {
      progressPanel.classList.remove("hidden");
      $("#meetingStatus").textContent = "Needs Attention";
      $("#progressTitle").textContent = "Processing needs attention";
      $("#progressDetail").textContent = activeMeeting.lastError || "One or more chunks could not be processed. The audio is still stored safely.";
      $("#retryFinalizeButton").textContent = "Retry processing this meeting";
      $("#retryFinalizeButton").classList.remove("hidden");
      if (writtenSegments > 0 && activeMeeting.summaryStatus !== "done") $("#forceSummaryButton").classList.remove("hidden");
    }
  } catch (error) {
    showToast(`Could not refresh the meeting: ${error.message}`);
  }
}

function openPendingDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("meetingnote-pending", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("chunks", { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, operation) {
  const db = await openPendingDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("chunks", mode);
    const store = transaction.objectStore("chunks");
    const request = operation(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

const savePending = (item) => withStore("readwrite", (store) => store.put(item));
const deletePending = (key) => withStore("readwrite", (store) => store.delete(key));
const readPending = () => withStore("readonly", (store) => store.getAll());

async function processUploads() {
  if (uploadPumpPromise) return uploadPumpPromise;
  if (!navigator.onLine) return;
  uploadPumpPromise = (async () => {
    while (uploadQueue.length && navigator.onLine) {
      const item = uploadQueue[0];
      try {
        await apiWithRetry(`/api/meetings/${item.meetingId}/chunks/${item.sequence}`, {
          method: "PUT",
          headers: { "content-type": item.mimeType || "audio/webm", "x-duration-ms": String(item.durationMs) },
          body: item.blob
        });
        await deletePending(item.key);
        uploadQueue.shift();
        if (activeMeeting?.id === item.meetingId) void refreshActiveMeeting();
      } catch (error) {
        showToast(`Chunk ${item.sequence + 1} is cached on this device and will retry: ${error.message}`, 7000);
        break;
      }
    }
  })().finally(() => {
    uploadPumpPromise = null;
  });
  return uploadPumpPromise;
}

function rememberFinalization(meetingId, expectedChunks) {
  try { localStorage.setItem(`${FINALIZE_PREFIX}${meetingId}`, String(expectedChunks)); } catch { /* storage may be unavailable */ }
}

function forgetFinalization(meetingId) {
  try { localStorage.removeItem(`${FINALIZE_PREFIX}${meetingId}`); } catch { /* storage may be unavailable */ }
}

async function waitForMeetingUploads(meetingId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (uploadQueue.some((item) => item.meetingId === meetingId) && navigator.onLine && Date.now() < deadline) {
    await processUploads();
    if (uploadQueue.some((item) => item.meetingId === meetingId)) await delay(600);
  }
}

async function finishMeeting(meetingId, expectedChunks) {
  rememberFinalization(meetingId, expectedChunks);
  await waitForMeetingUploads(meetingId);
  await apiWithRetry(`/api/meetings/${meetingId}/finalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedChunks })
  });
  forgetFinalization(meetingId);
}

async function resumePendingFinalizations() {
  const pending = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(FINALIZE_PREFIX)) {
        const meetingId = key.slice(FINALIZE_PREFIX.length);
        const expectedChunks = Number(localStorage.getItem(key));
        if (meetingId && Number.isInteger(expectedChunks) && expectedChunks > 0) pending.push({ meetingId, expectedChunks });
      }
    }
  } catch { return; }
  for (const item of pending) {
    try {
      await finishMeeting(item.meetingId, item.expectedChunks);
      showToast("Recovered and finished an interrupted recording.", 7000);
    } catch (error) {
      console.warn("Pending finalization will retry later", error);
    }
  }
}

async function retryActiveFinalization() {
  if (!activeMeeting?.id) return;
  if (!activeHasProcessingFailure && inferredExpectedChunks < 1) {
    showToast("No saved audio chunk is available for this recording.");
    return;
  }
  const button = $("#retryFinalizeButton");
  button.disabled = true;
  $("#meetingStatus").textContent = "Finalizing";
  $("#progressTitle").textContent = "Retrying safely";
  $("#progressDetail").textContent = "Uploading any cached audio before creating the note…";
  try {
    if (activeHasProcessingFailure) {
      await apiWithRetry(`/api/meetings/${activeMeeting.id}/retry`, { method: "POST" });
      activeHasProcessingFailure = false;
    } else {
      await finishMeeting(activeMeeting.id, inferredExpectedChunks);
    }
    button.classList.add("hidden");
    startPolling(activeMeeting.id);
    await refreshActiveMeeting();
  } catch (error) {
    $("#meetingStatus").textContent = "Needs attention";
    $("#progressTitle").textContent = "Could not finish this recording";
    $("#progressDetail").textContent = error.message;
    showToast(`Still unable to finish; it will retry when the connection returns: ${error.message}`, 9000);
  } finally {
    button.disabled = false;
  }
}

/** Writes the note again from the saved transcript; the recording and transcript are kept. */
async function rebuildNote(confirmFirst = true) {
  if (!activeMeeting?.id) return;
  if (confirmFirst && !window.confirm("Write this note again from the saved transcript? The current note is replaced.")) return;
  const button = $("#rebuildNoteButton");
  button.disabled = true;
  try {
    await apiWithRetry(`/api/meetings/${activeMeeting.id}/rebuild-note`, { method: "POST" });
    button.classList.add("hidden");
    showToast("Writing the note again. It takes a minute or two.", 7000);
    startPolling(activeMeeting.id);
    await refreshActiveMeeting();
  } catch (error) {
    showToast(`Could not rewrite the note: ${error.message}`, 9000);
  } finally {
    button.disabled = false;
  }
}

async function forceSummary() {
  if (!activeMeeting?.id) return;
  const button = $("#forceSummaryButton");
  button.disabled = true;
  try {
    await apiWithRetry(`/api/meetings/${activeMeeting.id}/force-summary`, { method: "POST" });
    showToast("Building the note from the sections that transcribed successfully.", 7000);
    startPolling(activeMeeting.id);
    await refreshActiveMeeting();
  } catch (error) {
    showToast(`Could not build the note: ${error.message}`, 9000);
  } finally {
    button.disabled = false;
  }
}

async function restorePendingUploads() {
  try {
    const items = await readPending();
    uploadQueue = items.sort((a, b) => a.sequence - b.sequence);
    if (items.length) {
      showToast(`Recovered ${items.length} audio chunk${items.length === 1 ? "" : "s"} waiting to upload.`);
      void processUploads();
    }
  } catch (error) {
    console.warn("Could not inspect pending audio", error);
  }
}

function updateConnection() {
  $("#offlinePill").classList.toggle("hidden", navigator.onLine);
  const state = $("#connectionState");
  state.lastChild.textContent = navigator.onLine ? " Online" : " Offline · caching";
  state.querySelector("i").style.background = navigator.onLine ? "var(--cyan)" : "var(--amber)";
  if (navigator.onLine && signedIn) {
    void processUploads();
    void resumePendingFinalizations();
  }
}

form.addEventListener("submit", beginMeeting);
stopButton.addEventListener("click", stopRecording);
$("#forceSummaryButton").addEventListener("click", forceSummary);
$("#rebuildNoteButton").addEventListener("click", () => void rebuildNote());
// The HD pass rewrites the note through the same path, having already asked its own question.
initHd({ onRebuild: () => rebuildNote(false) });
$("#backButton").addEventListener("click", goHome);
$("#recordingPill").addEventListener("click", () => {
  if (activeMeeting?.id) navigate(`#/meetings/${encodeURIComponent(activeMeeting.id)}`);
});
$("#noteTab").addEventListener("click", () => setPane("note"));
$("#transcriptTab").addEventListener("click", () => setPane("transcript"));
window.addEventListener("hashchange", renderRoute);
$("#refreshButton").addEventListener("click", loadMeetings);
$("#retryFinalizeButton").addEventListener("click", retryActiveFinalization);
window.addEventListener("online", updateConnection);
window.addEventListener("online", () => void versionWatch.check());
window.addEventListener("offline", updateConnection);
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (!isStandalone()) {
    $("#installButton").classList.remove("hidden");
    $("#homeScreenInstall").classList.remove("hidden");
  }
});
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  $("#installButton").classList.add("hidden");
  $("#homeScreenDialog").close();
  dismissHomeScreenBanner();
  showToast("Meeting Note is installed and ready from your home screen.");
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (isRecording) void requestWakeLock();
  // A home-screen app comes back here rather than reloading, so this is when it asks what changed.
  void versionWatch.check();
  if (signedIn) void checkForUpdate();
});
window.addEventListener("beforeunload", (event) => {
  if (isRecording) {
    event.preventDefault();
    event.returnValue = "";
  }
});

updateConnection();
configureMobileCapture();
$("#installButton").addEventListener("click", openHomeScreenSheet);
$("#homeScreenInstall").addEventListener("click", () => void installApp());
$("#homeScreenShow").addEventListener("click", openHomeScreenSheet);
$("#homeScreenLater").addEventListener("click", dismissHomeScreenBanner);
$("#updateLater").addEventListener("click", () => {
  const banner = $("#updateBanner");
  banner.classList.add("hidden");
  // Asked again when the next release comes out, not for this one.
  try { localStorage.setItem(UPDATE_SKIPPED_KEY, banner.dataset.version || ""); } catch { /* denied */ }
});
$("#refreshNow").addEventListener("click", () => location.reload());
$("#refreshLater").addEventListener("click", () => {
  // Not asked again for this version while the page stays open; the next launch loads it anyway.
  refreshDeclined = newerVersion;
  $("#refreshBanner").classList.add("hidden");
});
$("#closeHomeScreenDialog").addEventListener("click", () => $("#homeScreenDialog").close());
$("#copyAppAddress").addEventListener("click", async (event) => {
  try {
    await navigator.clipboard.writeText($("#appAddress").value);
    event.currentTarget.textContent = "Copied";
  } catch {
    $("#appAddress").select();
  }
});
// Every browser that cannot install by itself still needs the row that explains how.
if (!isStandalone()) $("#installButton").classList.remove("hidden");
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/service-worker.js").catch((error) => console.warn("PWA registration failed", error)));
  // A new service worker taking over only hints that something changed. It used to reload the page
  // on the spot; now the version check decides, since the page itself usually came over the network
  // already new, and a real update is offered as a banner rather than done to the owner.
  navigator.serviceWorker.addEventListener("controllerchange", () => void versionWatch.check({ force: true }));
}
// The first answer is the version this page runs; later ones can only be newer.
void versionWatch.check();
window.setInterval(() => {
  if (document.visibilityState === "visible") void versionWatch.check();
}, VERSION_CHECK_INTERVAL);
if (navigator.storage?.persist) void navigator.storage.persist();
// Home-screen shortcuts (manifest.webmanifest) arrive as ?action=record / dictate / ask / note.
const shortcut = new URLSearchParams(location.search).get("action");
if (shortcut) history.replaceState(null, "", `${location.pathname}${shortcut === "dictate" ? "#/plans" : shortcut === "ask" || shortcut === "note" ? "#/memory" : "#/meetings"}`);
try {
  $("#timezoneLabel").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || "—";
} catch {
  // leave the dash
}
// Nothing is fetched until the owner has signed in with their passkey (see auth.js).
void ensureSignedIn().then(() => {
  signedIn = true;
  document.body.classList.add("signed-in");
  void restorePendingUploads().then(resumePendingFinalizations);
  void initPlans();
  initCaptures();
  void loadUsage();
  void loadImageAiSetting();
  renderRoute();
  initGlass();
  depthScroll();
  cylinderScroll();
  offerHomeScreen();
  window.setTimeout(() => void checkForUpdate(), 4000);
  if (shortcut === "record") window.setTimeout(() => $("#meetingTitle").focus(), 300);
  if (shortcut === "note") window.setTimeout(() => $("#quickNoteBody").focus(), 300);
});
// A passage in an Ask answer that came from a meeting opens that meeting.
window.addEventListener("meetingnote:open-meeting", (event) => {
  if (isRecording || isDictating()) {
    showToast(isRecording ? "Stop the recording before opening another meeting." : "Finish or cancel the spoken plan first.");
    return;
  }
  if (event.detail?.id) openMeeting(event.detail.id);
});
// One banner at a time: a sign-in warning outranks an invitation to the home screen or to refresh.
window.addEventListener("meetingnote:signin-required", () => {
  $("#homeScreenBanner").classList.add("hidden");
  $("#refreshBanner").classList.add("hidden");
});
// After signing in again mid-session, send whatever audio was waiting.
window.addEventListener("meetingnote:signed-in", () => {
  if (!signedIn) return;
  void processUploads();
  void loadPlans();
  void loadUsage();
  offerRefresh();
});
