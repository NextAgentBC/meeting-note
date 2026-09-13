// Memory: ask about past meetings and plans, and see (and forget) what's remembered. An answer lists
// the passages it came from; one from a meeting opens that meeting.

const $ = (selector) => document.querySelector(selector);

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

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "x-timezone": browserTimeZone(), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new CustomEvent("meetingnote:signin-required"));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const KIND = {
  transcript: "transcript",
  section: "notes",
  summary: "meeting note",
  plan: "plan",
  dictation: "said aloud",
  fact: "fact"
};

function shortDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function openSource(kind, meetingId) {
  if (meetingId) window.dispatchEvent(new CustomEvent("meetingnote:open-meeting", { detail: { id: meetingId } }));
  else if (kind === "plan") location.hash = "#/plans";
}

// ── Ask ─────────────────────────────────────────────────────────────────────

function sourceHtml(source) {
  const heading = source.kind === "plan" ? `Plan · ${shortDate(source.occurredAt)}` : `${source.title || "Meeting"} · ${shortDate(source.occurredAt)} · ${KIND[source.kind] ?? source.kind}`;
  return `
    <button class="ask-source" type="button" data-kind="${escapeHtml(source.kind)}" data-meeting="${escapeHtml(source.meetingId ?? "")}">
      <b>${source.n}</b>
      <span><strong>${escapeHtml(heading)}</strong><small>${escapeHtml(source.snippet)}</small></span>
    </button>`;
}

/** The answer's [2]-style citations become small badges. */
function answerHtml(text) {
  return escapeHtml(text).replace(/\[(\d{1,2})\]/g, '<span class="cite">$1</span>');
}

async function ask(question) {
  $("#memoryIntro").classList.add("hidden");
  const button = $("#askForm").querySelector('button[type="submit"]');
  const answer = $("#askAnswer");
  button.disabled = true;
  answer.classList.remove("hidden");
  answer.classList.add("thinking");
  $("#askText").textContent = "Looking through your meetings and plans…";
  $("#askSources").innerHTML = "";
  try {
    const data = await api("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
    $("#askText").innerHTML = answerHtml(data.answer);
    $("#askSources").innerHTML = (data.sources || []).map(sourceHtml).join("");
  } catch (error) {
    $("#askText").textContent = error.message;
  } finally {
    answer.classList.remove("thinking");
    button.disabled = false;
  }
}

$("#askForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const question = $("#askInput").value.trim();
  if (question) void ask(question);
});

$("#askForm").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-example]");
  if (!chip) return;
  $("#askInput").value = chip.dataset.example;
  void ask(chip.dataset.example);
});

$("#askSources").addEventListener("click", (event) => {
  const source = event.target.closest(".ask-source");
  if (source) openSource(source.dataset.kind, source.dataset.meeting);
});

// ── What's remembered ───────────────────────────────────────────────────────

let memoryCursor = null;

function memoryRowHtml(item) {
  const when = shortDate(item.occurredAt);
  return `
    <div class="memory-row" data-id="${escapeHtml(item.id)}">
      <button class="memory-open" type="button" data-kind="${escapeHtml(item.kind)}" data-meeting="${escapeHtml(item.meetingId ?? "")}">
        <span class="kind">${escapeHtml(KIND[item.kind] ?? item.kind)}${when ? ` · ${escapeHtml(when)}` : ""}</span>
        <strong>${escapeHtml(item.title || "")}</strong>
        <small>${escapeHtml(item.snippet || "")}</small>
      </button>
      <button class="plan-remove" type="button" data-forget="${escapeHtml(item.id)}" aria-label="Forget this" title="Forget this">✕</button>
    </div>`;
}

function factRowHtml(fact) {
  const earlier = Number(fact.earlierVersions ?? fact.history ?? fact.previousCount ?? 0);
  const source = [fact.meetingTitle, shortDate(fact.occurredAt)].filter(Boolean).join(" · ");
  return `
    <div class="memory-row" data-id="${escapeHtml(fact.id)}">
      <button class="memory-open" type="button" data-kind="fact" data-meeting="${escapeHtml(fact.meetingId ?? "")}">
        <span class="kind">${escapeHtml(fact.topic ?? fact.title ?? "fact")}${earlier ? ` · updated ${earlier}×` : ""}</span>
        <strong>${escapeHtml(fact.statement ?? fact.snippet ?? "")}</strong>
        ${source ? `<small>${escapeHtml(source)}</small>` : ""}
      </button>
      <button class="plan-remove" type="button" data-forget="${escapeHtml(fact.id)}" aria-label="Forget this fact" title="Forget this fact">✕</button>
    </div>`;
}

async function loadFacts() {
  try {
    const data = await api("/api/memory/facts");
    const facts = data.facts || [];
    $("#factsBlock").classList.toggle("hidden", facts.length === 0);
    $("#factsList").innerHTML = facts.map(factRowHtml).join("");
  } catch {
    $("#factsBlock").classList.add("hidden"); // not available on this copy yet
  }
}

async function loadMemory(append = false) {
  const kind = $("#memoryKind").value;
  const params = new URLSearchParams({ limit: "20" });
  if (kind) params.set("kind", kind);
  if (append && memoryCursor) params.set("cursor", memoryCursor);
  try {
    const data = await api(`/api/memory?${params}`);
    memoryCursor = data.nextCursor || null;
    const html = (data.items || []).map(memoryRowHtml).join("");
    $("#memoryList").innerHTML = append ? $("#memoryList").innerHTML + html : html || '<p class="empty-state">Nothing remembered here yet.</p>';
    $("#memoryMore").classList.toggle("hidden", !memoryCursor);
    $("#memoryBlock").classList.remove("hidden");
  } catch {
    $("#memoryBlock").classList.add("hidden");
  }
}

window.addEventListener("meetingnote:memory-shown", () => {
  void loadFacts();
  void loadMemory();
});

$("#memoryKind").addEventListener("change", () => void loadMemory());
$("#memoryMore").addEventListener("click", () => void loadMemory(true));

for (const list of ["#memoryList", "#factsList"]) {
  $(list).addEventListener("click", async (event) => {
    const forget = event.target.closest("[data-forget]");
    if (forget) {
      if (!window.confirm("Forget this? Ask won't find it any more. The meeting itself is kept.")) return;
      forget.disabled = true;
      try {
        await api(`/api/memory/${encodeURIComponent(forget.dataset.forget)}`, { method: "DELETE" });
        forget.closest(".memory-row")?.remove();
      } catch (error) {
        forget.disabled = false;
        window.alert(error.message);
      }
      return;
    }
    const open = event.target.closest(".memory-open");
    if (open) openSource(open.dataset.kind, open.dataset.meeting);
  });
}
