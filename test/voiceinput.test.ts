import { describe, expect, it } from "vitest";
import { doneRedirect, VOICEINPUT_SCRIPT } from "../installer/src/voiceinput";

// The Worker that goes into the user's account, loaded the way Cloudflare runs it: as a module.
// Node has no crypto.subtle.timingSafeEqual (a Workers addition), so the test supplies one.
const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
subtle.timingSafeEqual ??= (a, b) => Buffer.from(a).equals(Buffer.from(b));
const worker = (await import(`data:text/javascript,${encodeURIComponent(VOICEINPUT_SCRIPT)}`)).default as {
  fetch(request: Request, env: unknown): Promise<Response>;
};

const KEY = "k".repeat(43);
function env(run: (model: string, input: unknown) => unknown) {
  const calls: Array<{ model: string; input: unknown }> = [];
  return {
    calls,
    value: { KEY, AI: { run: async (model: string, input: unknown) => { calls.push({ model, input }); return run(model, input); } } }
  };
}
const post = (path: string, body: unknown, key = KEY) =>
  new Request(`https://voiceinput-ai.x.workers.dev${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });

describe("the VoiceInput Worker", () => {
  it("answers only with its key", async () => {
    const e = env(() => ({ text: "hi" }));
    expect((await worker.fetch(post("/ai/run/@cf/openai/whisper-large-v3-turbo", { audio: "x" }, "wrong"), e.value)).status).toBe(401);
    expect(e.calls).toHaveLength(0);
    const probe = new Request("https://voiceinput-ai.x.workers.dev/ai/models/search?per_page=1", { headers: { authorization: `Bearer ${KEY}` } });
    expect((await worker.fetch(probe, e.value)).status).toBe(200);
    expect((await worker.fetch(new Request("https://voiceinput-ai.x.workers.dev/health"), e.value)).status).toBe(200);
  });

  it("runs Whisper like the REST API", async () => {
    const e = env(() => ({ text: "你好" }));
    const response = await worker.fetch(post("/ai/run/@cf/openai/whisper-large-v3-turbo", { audio: "AAAA", language: "zh" }), e.value);
    expect(await response.json()).toEqual({ success: true, result: { text: "你好" } });
    expect(e.calls[0]).toEqual({ model: "@cf/openai/whisper-large-v3-turbo", input: { audio: "AAAA", language: "zh" } });
  });

  it("answers chat in the OpenAI shape and offers only its models", async () => {
    const e = env(() => ({ response: "整理好的句子" }));
    const body = { model: "@cf/zai-org/glm-4.7-flash", messages: [{ role: "user", content: "嗯" }], max_tokens: 500 };
    const answer = await (await worker.fetch(post("/ai/v1/chat/completions", body), e.value)).json() as { choices: Array<{ message: { content: string } }> };
    expect(answer.choices[0].message.content).toBe("整理好的句子");
    expect(e.calls[0].input).toEqual({ messages: body.messages, max_tokens: 500 });
    expect((await worker.fetch(post("/ai/v1/chat/completions", { ...body, model: "@cf/meta/llama-3" }), e.value)).status).toBe(404);
    expect((await worker.fetch(post("/ai/run/@cf/black-forest-labs/flux-1-schnell", {}), e.value)).status).toBe(404);
  });

  it("says when the free day is used up", async () => {
    const e = env(() => { throw new Error("4006: you have used up your daily free allocation of 10,000 neurons"); });
    expect((await worker.fetch(post("/ai/run/@cf/openai/whisper-large-v3-turbo", { audio: "x" }), e.value)).status).toBe(429);
  });
});

describe("the way back to the app", () => {
  it("carries the Worker and its key in the fragment, never in a query", async () => {
    const page = await doneRedirect("https://voiceinput-ai.x.workers.dev", KEY).text();
    expect(page).toContain(`voiceinput://cloudflare#worker=https%3A%2F%2Fvoiceinput-ai.x.workers.dev&#38;key=${KEY}`);
  });
});

describe("a brand-new Cloudflare account", () => {
  it("is told to verify its email instead of failing", async () => {
    const { needsEmailVerification } = await import("../installer/src/voiceinput");
    const { InstallError } = await import("../installer/src/provision");
    expect(needsEmailVerification(new InstallError("worker", "You must verify your email address before creating a Worker"))).toBe(true);
    expect(needsEmailVerification(new InstallError("worker", "Forbidden", [10034]))).toBe(true);
    expect(needsEmailVerification(new InstallError("worker", "Subdomain unavailable", [10031]))).toBe(false);
    expect(needsEmailVerification("not an error")).toBe(false);
  });

  it("carries on in the same session from the verify page", async () => {
    const { verifyEmailPage } = await import("../installer/src/voiceinput");
    const page = await verifyEmailPage("abc123").text();
    expect(page).toContain('action="/oauth/voiceinput/account"');
    expect(page).toContain('value="abc123"');
  });
});

describe("the Worker's answers", () => {
  it("never pastes an empty answer", async () => {
    const e = env(() => ({}));
    const body = { model: "@cf/openai/gpt-oss-120b", messages: [{ role: "user", content: "好的" }] };
    expect((await worker.fetch(post("/ai/v1/chat/completions", body), e.value)).status).toBe(502);
  });

  it("reads a Responses-style output list", async () => {
    const e = env(() => ({ output: [{ type: "message", content: [{ type: "output_text", text: "好的。" }] }] }));
    const body = { model: "@cf/openai/gpt-oss-120b", messages: [{ role: "user", content: "好的" }] };
    const answer = await (await worker.fetch(post("/ai/v1/chat/completions", body), e.value)).json() as { choices: Array<{ message: { content: string } }> };
    expect(answer.choices[0].message.content).toBe("好的。");
  });
});

describe("the day's usage", () => {
  function kv() {
    const store = new Map<string, string>();
    return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v); } };
  }
  const ctx = { waitUntil: (p: Promise<unknown>) => { void p; } };

  it("counts Whisper by audio length and reports it", async () => {
    const usage = kv();
    const value = { KEY, USAGE: usage, AI: { run: async () => ({ text: "好", transcription_info: { duration: 60 } }) } };
    const response = await (worker.fetch as (r: Request, e: unknown, c: unknown) => Promise<Response>)(
      post("/ai/run/@cf/openai/whisper-large-v3-turbo", { audio: "x" }), value, ctx);
    expect(response.headers.get("x-voiceinput-neurons-today")).toBe("47");
    expect(response.headers.get("x-voiceinput-neurons-free")).toBe("10000");
  });

  it("counts chat tokens, and says nothing without the namespace", async () => {
    const usage = kv();
    const run = async () => ({ choices: [{ message: { content: "好的" } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } });
    const fetch = worker.fetch as (r: Request, e: unknown, c: unknown) => Promise<Response>;
    const body = { model: "@cf/zai-org/glm-4.7-flash", messages: [{ role: "user", content: "嗯" }] };
    expect((await fetch(post("/ai/v1/chat/completions", body), { KEY, USAGE: usage, AI: { run } }, ctx)).headers.get("x-voiceinput-neurons-today")).toBe("5500");
    expect((await fetch(post("/ai/v1/chat/completions", body), { KEY, AI: { run } }, ctx)).headers.get("x-voiceinput-neurons-today")).toBeNull();
  });
});

// D1 as the Worker uses it (prepare → bind → first / run), on Node's SQLite.
function fakeD1() {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => db.prepare(sql).get(...(args as never[])) ?? null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } })
  });
  return { prepare: (sql: string) => statement(sql) };
}

describe("the synced documents", () => {
  const at = (path: string, init: RequestInit = {}, key = KEY) =>
    new Request(`https://voiceinput-ai.x.workers.dev${path}`, { ...init, headers: { authorization: `Bearer ${key}`, ...(init.headers || {}) } });
  const put = (name: string, body: string, version: number) =>
    at(`/docs/${name}`, { method: "PUT", body, headers: { "x-if-version": String(version) } });

  it("keeps a document and refuses a write that missed another", async () => {
    const e = { KEY, DOCS: fakeD1() };
    const missing = await worker.fetch(at("/docs/Vocabulary.json"), e);
    expect([missing.status, missing.headers.get("x-version")]).toEqual([404, "0"]);
    expect(await (await worker.fetch(put("Vocabulary.json", "v1", 0), e)).json()).toEqual({ ok: true, version: 1 });
    expect((await worker.fetch(put("Vocabulary.json", "again", 0), e)).status).toBe(409);
    const read = await worker.fetch(at("/docs/Vocabulary.json"), e);
    expect([await read.text(), read.headers.get("x-version")]).toEqual(["v1", "1"]);
    expect((await worker.fetch(put("Vocabulary.json", "v2", 1), e)).status).toBe(200);
    expect((await worker.fetch(put("Vocabulary.json", "stale", 1), e)).status).toBe(409);
    expect(await (await worker.fetch(at("/docs/Vocabulary.json"), e)).text()).toBe("v2");
    const gone = await worker.fetch(at("/docs/Vocabulary.json", { method: "DELETE", headers: { "x-if-version": "2" } }), e);
    expect(gone.status).toBe(200);
    expect((await worker.fetch(at("/docs/Vocabulary.json"), e)).status).toBe(404);
  });

  it("asks for its key, a version and a plain name, and says when sync isn't set up", async () => {
    const e = { KEY, DOCS: fakeD1() };
    expect((await worker.fetch(at("/docs/a.json", {}, "wrong"), e)).status).toBe(401);
    expect((await worker.fetch(at("/docs/a.json", { method: "PUT", body: "x" }), e)).status).toBe(428);
    expect((await worker.fetch(at("/docs/..%2Fetc", {}), e)).status).toBe(400);
    expect((await worker.fetch(put("big.json", "x".repeat(1_500_001), 0), e)).status).toBe(413);
    expect((await worker.fetch(at("/docs/a.json"), { KEY })).status).toBe(501);
  });
});
