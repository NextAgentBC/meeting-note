// Ask: questions about past meetings and plans, answered from what was recorded, with the
// passages the answer came from. A passage from a meeting opens that meeting.

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

const KIND = {
  transcript: "transcript",
  section: "notes",
  summary: "summary",
  plan: "plan",
  dictation: "said aloud",
  fact: "remembered"
};

function sourceHtml(source) {
  const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(source.occurredAt));
  const heading = source.kind === "plan" ? `Plan · ${date}` : `${source.title || "Meeting"} · ${date} · ${KIND[source.kind] ?? source.kind}`;
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

$("#askForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = $("#askInput").value.trim();
  if (!question) return;
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const answer = $("#askAnswer");
  button.disabled = true;
  answer.classList.remove("hidden");
  answer.classList.add("thinking");
  $("#askText").textContent = "Looking through your meetings and plans…";
  $("#askSources").innerHTML = "";

  try {
    const response = await fetch("/api/ask", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-timezone": browserTimeZone() },
      body: JSON.stringify({ question })
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) window.dispatchEvent(new CustomEvent("meetingnote:signin-required"));
    if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
    $("#askText").innerHTML = answerHtml(data.answer);
    $("#askSources").innerHTML = (data.sources || []).map(sourceHtml).join("");
  } catch (error) {
    $("#askText").textContent = error.message;
  } finally {
    answer.classList.remove("thinking");
    button.disabled = false;
  }
});

$("#askSources").addEventListener("click", (event) => {
  const source = event.target.closest(".ask-source");
  if (!source) return;
  if (source.dataset.meeting) {
    window.dispatchEvent(new CustomEvent("meetingnote:open-meeting", { detail: { id: source.dataset.meeting } }));
  } else if (source.dataset.kind === "plan") {
    $("#plansSection").scrollIntoView({ behavior: "smooth", block: "start" });
  }
});
