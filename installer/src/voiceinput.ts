// VoiceInput's one-click Cloudflare setup: the same sign-in as a Meeting Note install, but what goes
// into the user's account is one tiny Worker, `voiceinput-ai`, that runs Workers AI through its AI
// binding for the VoiceInput apps (speech with Whisper, text cleanup with GLM). The apps hold only
// the Worker's address and a random key; no Cloudflare credential stays anywhere once the installer
// revokes its own access. The Worker answers the same paths as the Workers AI REST API, so the apps
// treat it exactly like an account ID + API token.

import { ensureWorkersSubdomain, InstallError } from "./provision";

const API = "https://api.cloudflare.com/client/v4";
export const VOICEINPUT_WORKER = "voiceinput-ai";
export const VOICEINPUT_SCOPES = "workers-scripts.write ai.write user-details.read";
/** Where the apps' web sign-in sheet waits; it closes when the browser is sent here. */
export const VOICEINPUT_CALLBACK = "voiceinput://cloudflare";

/** The Worker that goes into the user's account. Plain JavaScript: uploaded as it is. */
export const VOICEINPUT_SCRIPT = `
const MODELS = new Set([
  "@cf/openai/whisper-large-v3-turbo",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/openai/gpt-oss-120b"
]);

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
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "voiceinput-ai" });
    if (!(await authorized(request, env.KEY))) return refused(401, "Authentication error");
    // The apps' connection test: key checked, no model run.
    if (request.method === "GET" && url.pathname === "/ai/models/search") return json({ success: true, result: [] });
    if (request.method !== "POST") return refused(405, "Method not allowed");
    const input = await request.json().catch(() => null);
    if (!input || typeof input !== "object") return refused(400, "Expected a JSON body");

    const run = url.pathname.match(/^\\/ai\\/run\\/(@cf\\/.+)$/);
    if (run) {
      const model = decodeURIComponent(run[1]);
      if (!MODELS.has(model)) return refused(404, "Model not offered");
      try {
        return json({ success: true, result: await env.AI.run(model, input) });
      } catch (error) {
        return failed(error);
      }
    }

    if (url.pathname === "/ai/v1/chat/completions") {
      const { model, ...rest } = input;
      if (!MODELS.has(model)) return refused(404, "Model not offered");
      try {
        const result = await env.AI.run(model, rest);
        if (result && Array.isArray(result.choices)) return json(result);
        const content = typeof result?.response === "string" ? result.response : JSON.stringify(result?.response ?? "");
        return json({
          object: "chat.completion",
          model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }]
        });
      } catch (error) {
        return failed(error);
      }
    }
    return refused(404, "Not found");
  }
};
`;

async function cf<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }) }
  });
  const data = await response.json<{ success: boolean; result: T; errors?: Array<{ message?: string }> }>()
    .catch(() => ({ success: false, result: null as T, errors: [] }));
  if (!response.ok || !data.success) {
    throw new InstallError("worker", data.errors?.map((error) => error.message).filter(Boolean).join("; ") || `Cloudflare request failed (${response.status})`);
  }
  return data.result;
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Waits for a new workers.dev address to answer (its certificate is issued on first use). */
async function answers(url: string, attempts = 15): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) });
      if (response.ok) return true;
    } catch {
      // Not there yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

/**
 * Puts `voiceinput-ai` into the account with a new key. Setting up again replaces the key, so a
 * device set up before needs the new one (the Mac's "Send keys to iPhone" carries it).
 */
export async function provisionVoiceInput(accessToken: string, accountId: string): Promise<{ worker: string; key: string; ready: boolean }> {
  const account = encodeURIComponent(accountId);
  const address = await ensureWorkersSubdomain(accessToken, account, "voiceinput");
  const key = randomKey();
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify({
    main_module: "worker.js",
    compatibility_date: "2026-09-10",
    bindings: [{ type: "ai", name: "AI" }, { type: "secret_text", name: "KEY", text: key }],
    annotations: { "workers/message": "VoiceInput one-click setup" }
  })], { type: "application/json" }));
  form.set("worker.js", new Blob([VOICEINPUT_SCRIPT], { type: "application/javascript+module" }), "worker.js");
  // A subdomain registered a second ago can refuse the upload for a moment (10063): try again.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await cf(accessToken, `/accounts/${account}/workers/scripts/${VOICEINPUT_WORKER}`, { method: "PUT", body: form });
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  await cf(accessToken, `/accounts/${account}/workers/scripts/${VOICEINPUT_WORKER}/subdomain`, {
    method: "POST",
    body: JSON.stringify({ enabled: true, previews_enabled: false })
  });
  const worker = `https://${VOICEINPUT_WORKER}.${address.subdomain}.workers.dev`;
  return { worker, key, ready: await answers(worker) };
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The installer's small pages for this flow: Chinese first, English under it. */
export function voiceInputPage(title: string, body: string, extraHead = ""): Response {
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
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer"
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
<p>${accounts.length > 1 ? "选一个账户：" : "确认账户："}</p>${forms}`);
}

export function doneRedirect(worker: string, key: string): Response {
  const target = `${VOICEINPUT_CALLBACK}#${new URLSearchParams({ worker, key }).toString()}`;
  return voiceInputPage("已连接 · Connected", `<h1>已连接，正在回到声入…</h1><p class="en">Connected. Going back to VoiceInput…</p>
<a class="button" href="${escape(target)}">回到声入 · Back to VoiceInput</a>`, `<meta http-equiv="refresh" content="0;url=${escape(target)}">`);
}

export function failedPage(message: string): Response {
  return voiceInputPage("没有连上 · Not connected", `<h1>这次没有连上</h1><p class="en">That didn't work</p>
<div class="card"><p>${escape(message)}</p></div><a class="button" href="/oauth/voiceinput">再试一次 · Try again</a>`);
}
