// VoiceInput's one-click Cloudflare setup: the same sign-in as a Meeting Note install, but what goes
// into the user's account is one tiny Worker, `voiceinput-ai`, that runs Workers AI through its AI
// binding for the VoiceInput apps (speech with Whisper, text cleanup with GLM). The apps hold only
// the Worker's address and a random key; no Cloudflare credential stays anywhere once the installer
// revokes its own access. The Worker answers the same paths as the Workers AI REST API, so the apps
// treat it exactly like an account ID + API token.

import { cf, ensureWorkersSubdomain, InstallError, settle, step, waitForApp } from "./provision";

export const VOICEINPUT_WORKER = "voiceinput-ai";
export const VOICEINPUT_SCOPES = "workers-scripts.write workers-kv-storage.write ai.write user-details.read";
/** The KV namespace (in the user's account) where the Worker keeps the day's count. */
export const VOICEINPUT_USAGE_NAMESPACE = "voiceinput-usage";
/** Where the apps' web sign-in sheet waits; it closes when the browser is sent here. */
export const VOICEINPUT_CALLBACK = "voiceinput://cloudflare";

/** The Worker that goes into the user's account. Plain JavaScript: uploaded as it is. */
export const VOICEINPUT_SCRIPT = `
const MODELS = new Set([
  "@cf/openai/whisper-large-v3-turbo",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/openai/gpt-oss-120b"
]);

// What each model costs in neurons (Cloudflare's published rates, 2026-10). The free allowance is
// 10,000 neurons a day, reset at 00:00 UTC. The count is the Worker's own estimate from these rates:
// Workers AI reports no usage to a binding.
const RATES = {
  "@cf/openai/whisper-large-v3-turbo": { perAudioMinute: 46.63 },
  "@cf/zai-org/glm-4.7-flash": { inPerM: 5500, outPerM: 36400 },
  "@cf/openai/gpt-oss-120b": { inPerM: 31818, outPerM: 68182 }
};
const FREE_PER_DAY = 10000;

function speechNeurons(model, result, request) {
  const seconds = Number(result?.transcription_info?.duration) || Number(request.headers.get("x-audio-seconds")) || 0;
  return seconds / 60 * (RATES[model]?.perAudioMinute || 0);
}

function chatNeurons(model, usage, input, content) {
  const rate = RATES[model];
  if (!rate?.inPerM) return 0;
  // Token counts when the model reports them; else about two characters a token.
  const inTokens = Number(usage?.prompt_tokens) || JSON.stringify(input.messages || []).length / 2;
  const outTokens = Number(usage?.completion_tokens) || (content || "").length / 2;
  return (inTokens * rate.inPerM + outTokens * rate.outPerM) / 1e6;
}

const dayKey = () => "neurons:" + new Date().toISOString().slice(0, 10);

async function usedToday(env) {
  return env.USAGE ? Number(await env.USAGE.get(dayKey())) || 0 : null;
}

// Read, add, write: two requests at the same moment can lose one addition — an estimate either way.
async function count(env, ctx, neurons) {
  const used = await usedToday(env);
  if (used === null || !(neurons > 0)) return used;
  const now = Math.round((used + neurons) * 100) / 100;
  ctx.waitUntil(env.USAGE.put(dayKey(), String(now), { expirationTtl: 3 * 86400 }).catch(() => {}));
  return now;
}

// Every answer says how much of today's free allowance is used, so the apps can show it.
function withUsage(response, used) {
  if (used === null || used === undefined) return response;
  response.headers.set("x-voiceinput-neurons-today", String(Math.round(used)));
  response.headers.set("x-voiceinput-neurons-free", String(FREE_PER_DAY));
  return response;
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function refused(status, message) {
  return json({ success: false, errors: [{ code: status, message }] }, status);
}

// Constant-time comparison of the bearer key.
async function authorized(request, key) {
  const given = new TextEncoder().encode(request.headers.get("authorization") || "");
  const wanted = new TextEncoder().encode("Bearer " + key);
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", given), crypto.subtle.digest("SHA-256", wanted)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// The free daily allowance used up comes back as an error mentioning neurons: the apps read 429 as
// "quota used up for today" and recognize on the device instead.
function failed(error) {
  const message = error instanceof Error ? error.message : String(error);
  return refused(/neuron|4006|daily/i.test(message) ? 429 : 502, message);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "voiceinput-ai" });
    if (!(await authorized(request, env.KEY))) return refused(401, "Authentication error");
    // The apps' connection test: key checked, no model run.
    if (request.method === "GET" && url.pathname === "/ai/models/search") return withUsage(json({ success: true, result: [] }), await usedToday(env));
    if (request.method === "GET" && url.pathname === "/usage") {
      return withUsage(json({ success: true, result: { neurons: await usedToday(env), free: FREE_PER_DAY } }), await usedToday(env));
    }
    if (request.method !== "POST") return refused(405, "Method not allowed");
    const input = await request.json().catch(() => null);
    if (!input || typeof input !== "object") return refused(400, "Expected a JSON body");

    const run = url.pathname.match(/^\\/ai\\/run\\/(@cf\\/.+)$/);
    if (run) {
      const model = decodeURIComponent(run[1]);
      if (!MODELS.has(model)) return refused(404, "Model not offered");
      try {
        const result = await env.AI.run(model, input);
        return withUsage(json({ success: true, result }), await count(env, ctx, speechNeurons(model, result, request)));
      } catch (error) {
        return withUsage(failed(error), await usedToday(env));
      }
    }

    if (url.pathname === "/ai/v1/chat/completions") {
      const { model, ...rest } = input;
      if (!MODELS.has(model)) return refused(404, "Model not offered");
      try {
        const result = await env.AI.run(model, rest);
        if (result && Array.isArray(result.choices)) {
          const used = await count(env, ctx, chatNeurons(model, result.usage, rest, result.choices[0]?.message?.content));
          return withUsage(json(result), used);
        }
        // Older models answer { response }, the Responses-style ones an output list; nothing usable
        // is an error, so the app keeps the raw text instead of pasting an empty answer.
        const content = typeof result?.response === "string" ? result.response
          : (Array.isArray(result?.output) ? result.output : []).flatMap((part) => part?.content || [])
            .map((piece) => piece?.text || "").join("");
        if (!content) return refused(502, "The model gave no text");
        const used = await count(env, ctx, chatNeurons(model, result?.usage, rest, content));
        return withUsage(json({
          object: "chat.completion",
          model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }]
        }), used);
      } catch (error) {
        return withUsage(failed(error), await usedToday(env));
      }
    }
    return refused(404, "Not found");
  }
};
`;

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** The usage namespace, made once and found again when setting up anew. */
async function usageNamespace(accessToken: string, account: string): Promise<string> {
  const existing = await cf<Array<{ id: string; title: string }>>(accessToken, `/accounts/${account}/storage/kv/namespaces?per_page=100`);
  const found = existing.find((namespace) => namespace.title === VOICEINPUT_USAGE_NAMESPACE);
  if (found) return found.id;
  return (await cf<{ id: string }>(accessToken, `/accounts/${account}/storage/kv/namespaces`, {
    method: "POST",
    body: JSON.stringify({ title: VOICEINPUT_USAGE_NAMESPACE })
  })).id;
}

/**
 * Puts `voiceinput-ai` into the account with a new key. Setting up again replaces the key, so a
 * device set up before needs the new one (the Mac's "Send keys to iPhone" carries it).
 */
export async function provisionVoiceInput(accessToken: string, accountId: string): Promise<{ worker: string; key: string; ready: boolean }> {
  const account = encodeURIComponent(accountId);
  const address = await ensureWorkersSubdomain(accessToken, account, "voiceinput");
  const key = randomKey();
  const usage = await step("storage", () => usageNamespace(accessToken, account));
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify({
    main_module: "worker.js",
    compatibility_date: "2026-09-10",
    bindings: [
      { type: "ai", name: "AI" },
      { type: "secret_text", name: "KEY", text: key },
      { type: "kv_namespace", name: "USAGE", namespace_id: usage }
    ],
    annotations: { "workers/message": "VoiceInput one-click setup" }
  })], { type: "application/json" }));
  form.set("worker.js", new Blob([VOICEINPUT_SCRIPT], { type: "application/javascript+module" }), "worker.js");
  // A subdomain registered a second ago refuses the upload for a moment (10063): `settle` tries again.
  await step("worker", () => settle("voiceinput upload", () =>
    cf(accessToken, `/accounts/${account}/workers/scripts/${VOICEINPUT_WORKER}`, { method: "PUT", body: form })));
  await step("address", () => settle("voiceinput address", () =>
    cf(accessToken, `/accounts/${account}/workers/scripts/${VOICEINPUT_WORKER}/subdomain`, {
      method: "POST",
      body: JSON.stringify({ enabled: true, previews_enabled: false })
    })));
  const worker = `https://${VOICEINPUT_WORKER}.${address.subdomain}.workers.dev`;
  return { worker, key, ready: await waitForApp(worker, "/health", 15) };
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The installer's small pages for this flow: Chinese first, English under it. */
export function voiceInputPage(title: string, body: string, extraHead = ""): Response {
  // A form takes a while (a new account: 1–2 minutes): its buttons go quiet and a note says so.
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const busy = `<script nonce="${nonce}">document.querySelectorAll("form").forEach(function (form) {
form.addEventListener("submit", function () { setTimeout(function () {
document.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
var note = document.getElementById("busy"); if (note) note.hidden = false; }, 0); }); });</script>`;
  const html = `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${extraHead}
<title>${escape(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#F7F1E8;--fg:#2A2420;--muted:#6E645C;--accent:#A84D35;--card:#fffaf3}
@media (prefers-color-scheme:dark){:root{--bg:#1F1B18;--fg:#F4EEE6;--muted:#B5AAA0;--card:#2A2420}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,"PingFang SC","Hiragino Sans GB",sans-serif}
main{max-width:30rem;margin:0 auto;padding:2.5rem 1.25rem}
h1{font-size:1.5rem;margin:0 0 .75rem}
p{margin:.5rem 0}.en{color:var(--muted);font-size:.9rem}
.card{background:var(--card);border-radius:18px;padding:1rem 1.1rem;margin:1rem 0;box-shadow:0 1px 3px rgb(0 0 0/.08)}
button,.button{display:block;width:100%;box-sizing:border-box;margin:.6rem 0;padding:.85rem 1rem;border:0;border-radius:14px;
background:var(--accent);color:#fff;font:600 1rem/1.2 inherit;text-align:center;text-decoration:none;cursor:pointer}
</style></head><body><main>${body}</main>${busy}</body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      "referrer-policy": "same-origin"  // a form post keeps its Origin (no-referrer sends "null")
    }
  });
}

export function chooseAccountPage(accounts: Array<{ id: string; name: string }>): Response {
  const forms = accounts.map((account) => `<form method="post" action="/oauth/voiceinput/account">
<input type="hidden" name="accountId" value="${escape(account.id)}"><button>${escape(account.name)}</button></form>`).join("");
  return voiceInputPage("连接声入 · Connect VoiceInput", `<h1>把声入接到你的 Cloudflare</h1>
<p class="en">Connect VoiceInput to your Cloudflare</p>
<div class="card"><p>会在你的账户里建一个名为 <b>${VOICEINPUT_WORKER}</b> 的小程序，用 Cloudflare 的免费额度做语音识别和文字整理。录音和文字只经过你自己的账户。</p>
<p class="en">A small Worker named ${VOICEINPUT_WORKER} is created in your account to run speech recognition and text cleanup on Cloudflare's free allowance. Your recordings and text pass only through your own account.</p>
<p>装好后，我们对你账户的授权会马上撤销。</p><p class="en">Our access to your account is revoked as soon as it is done.</p></div>
<p>${accounts.length > 1 ? "选一个账户：" : "确认账户："}</p>
<p class="en">点下去以后要等一会儿：新账户约 1–2 分钟。 · It takes a moment after you tap: about 1–2 minutes for a new account.</p>${forms}
<p id="busy" class="card" hidden>正在你的账户里开通……新账户第一次要准备网址，大约要 1–2 分钟，请别关闭这个页面。<br><span class="en">Setting it up in your account… a new account's first address takes about 1–2 minutes. Please keep this page open.</span></p>`);
}

export function doneRedirect(worker: string, key: string): Response {
  const target = `${VOICEINPUT_CALLBACK}#${new URLSearchParams({ worker, key }).toString()}`;
  return voiceInputPage("已连接 · Connected", `<h1>已连接，正在回到声入…</h1><p class="en">Connected. Going back to VoiceInput…</p>
<a class="button" href="${escape(target)}">回到声入 · Back to VoiceInput</a>`, `<meta http-equiv="refresh" content="0;url=${escape(target)}">`);
}

/**
 * A brand-new Cloudflare account can't create Workers until its email address is verified. Cloudflare
 * documents no code for it, so the message decides (and 10034, seen for it in the wild).
 */
export function needsEmailVerification(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const codes = error instanceof InstallError ? error.apiCodes : [];
  return codes.includes(10034) || /verif|confirm (your|the) email|email (address )?(is )?not (yet )?(verified|confirmed)/i.test(error.message);
}

/** The new account's one manual step, then the same session carries on (no second sign-in). */
export function verifyEmailPage(accountId: string): Response {
  return voiceInputPage("验证邮箱 · Verify your email", `<h1>只差一步：验证邮箱</h1>
<p class="en">One step left: verify your email</p>
<div class="card"><p>Cloudflare 给你注册的邮箱发了一封信，点一下里面的验证链接，再回到这里点「继续」。</p>
<p class="en">Cloudflare has sent a message to the address you signed up with. Click the link in it, then come back here and tap Continue.</p></div>
<form method="post" action="/oauth/voiceinput/account"><input type="hidden" name="accountId" value="${escape(accountId)}">
<button>继续 · Continue</button></form>
<p id="busy" class="card" hidden>正在你的账户里开通……新账户第一次要准备网址，大约要 1–2 分钟，请别关闭这个页面。<br><span class="en">Setting it up in your account… a new account's first address takes about 1–2 minutes. Please keep this page open.</span></p>`);
}

export function failedPage(message: string): Response {
  return voiceInputPage("没有连上 · Not connected", `<h1>这次没有连上</h1><p class="en">That didn't work</p>
<div class="card"><p>${escape(message)}</p></div><a class="button" href="/oauth/voiceinput/account">再试一次 · Try again</a>`);
}
