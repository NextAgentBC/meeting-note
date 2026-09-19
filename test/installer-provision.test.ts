import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionMeetingNote } from "../installer/src/provision";

function response(result: unknown, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, result, errors: status < 400 ? [] : [{ message: "missing" }] }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("personal Cloudflare installer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates the private resources, uploads the Worker and enables its address", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/d1/database") && init?.method === "POST") return response({ uuid: "db-1" });
      if (url.endsWith("/storage/kv/namespaces")) return response({ id: "kv-1" });
      if (url.endsWith("/queues")) return response({ queue_id: "queue-1" });
      if (url.includes("/d1/database/db-1/query")) return response([{}]);
      if (url.includes("/workers/scripts/meeting-note-install1") && init?.method === "PUT") return response({ id: "meeting-note-install1" });
      if (url.endsWith("/queues/queue-1/consumers")) return response({ consumer_id: "consumer-1" });
      if (url.endsWith("/workers/subdomain") && !init?.method) return response(null, 404);
      if (url.endsWith("/workers/subdomain") && init?.method === "PUT") return response({ subdomain: "meeting-note-install1" });
      if (url.endsWith("/workers/scripts/meeting-note-install1/subdomain")) return response({ enabled: true });
      throw new Error(`Unexpected request ${init?.method || "GET"} ${url}`);
    }));

    const result = await provisionMeetingNote({
      accountId: "account-1",
      accessToken: "secret-oauth-token",
      releaseScript: "export default { fetch(){ return new Response('ok') } }",
      release: { version: "1.2.3", migrations: [{ name: "0001.sql", sql: "CREATE TABLE test (id TEXT);" }] },
      installId: "install-1234"
    });

    expect(result.appUrl).toBe("https://meeting-note-install1.meeting-note-install1.workers.dev");
    expect(result.setupCode).toMatch(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);
    const upload = requests.find((request) => request.url.endsWith("/workers/scripts/meeting-note-install1") && request.init?.method === "PUT");
    expect(upload?.init?.body).toBeInstanceOf(FormData);
    const metadataPart = (upload!.init!.body as FormData).get("metadata") as Blob;
    const metadata = JSON.parse(await metadataPart.text());
    expect(metadata.main_module).toBe("standalone.js");
    expect(metadata.bindings).toEqual(expect.arrayContaining([
      { type: "d1", name: "DB", database_id: "db-1" },
      { type: "kv_namespace", name: "AUDIO", namespace_id: "kv-1" },
      { type: "queue", name: "JOBS", queue_name: "meeting-note-jobs-install1" },
      { type: "ai", name: "AI" }
    ]));
    expect(requests.every((request) => request.init?.headers && String((request.init.headers as Record<string, string>).authorization).includes("secret-oauth-token"))).toBe(true);
  });

  it("removes half-created resources when installation fails", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      requests.push({ url, method });
      if (method === "DELETE") return response(null);
      if (url.endsWith("/d1/database") && method === "POST") return response({ uuid: "db-broken" });
      if (url.endsWith("/storage/kv/namespaces")) return response({ id: "kv-broken" });
      if (url.endsWith("/queues")) return response({ queue_id: "queue-broken" });
      if (url.includes("/d1/database/db-broken/query")) return response(null, 500);
      throw new Error(`Unexpected request ${method} ${url}`);
    }));

    await expect(provisionMeetingNote({
      accountId: "account-1",
      accessToken: "secret-oauth-token",
      releaseScript: "export default {}",
      release: { version: "1.2.3", migrations: [{ name: "0001.sql", sql: "broken" }] },
      installId: "cleanup-1234"
    })).rejects.toThrow("missing");

    expect(requests.filter((request) => request.method === "DELETE").map((request) => new URL(request.url).pathname)).toEqual([
      "/client/v4/accounts/account-1/queues/queue-broken",
      "/client/v4/accounts/account-1/storage/kv/namespaces/kv-broken",
      "/client/v4/accounts/account-1/d1/database/db-broken"
    ]);
  });
});
