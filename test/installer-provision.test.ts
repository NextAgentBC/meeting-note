import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallError, listInstalls, provisionMeetingNote } from "../installer/src/provision";

function response(result: unknown, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, result, errors: status < 400 ? [] : [{ message: "missing" }] }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function failure(code: number, message: string, status = 400) {
  return new Response(JSON.stringify({ success: false, result: null, errors: [{ code, message }] }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const release = { version: "1.2.3", migrations: [{ name: "0001.sql", sql: "CREATE TABLE test (id TEXT);" }] };

describe("personal Cloudflare installer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates the private resources, uploads the Worker and enables its address", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/workers/subdomain") && !init?.method) return response({ subdomain: "quiet-harbour" });
      if (url.endsWith("/d1/database") && init?.method === "POST") return response({ uuid: "db-1" });
      if (url.endsWith("/storage/kv/namespaces")) return response({ id: "kv-1" });
      if (url.endsWith("/queues")) return response({ queue_id: "queue-1" });
      if (url.includes("/d1/database/db-1/query")) return response([{}]);
      if (url.includes("/workers/scripts/meeting-note-install1") && init?.method === "PUT") return response({ id: "meeting-note-install1" });
      if (url.endsWith("/queues/queue-1/consumers")) return response({ consumer_id: "consumer-1" });
      if (url.endsWith("/workers/scripts/meeting-note-install1/subdomain")) return response({ enabled: true });
      throw new Error(`Unexpected request ${init?.method || "GET"} ${url}`);
    }));

    const result = await provisionMeetingNote({
      accountId: "account-1",
      accessToken: "secret-oauth-token",
      releaseScript: "export default { fetch(){ return new Response('ok') } }",
      release,
      installId: "install-1234"
    });

    expect(result.appUrl).toBe("https://meeting-note-install1.quiet-harbour.workers.dev");
    expect(result.addressIsNew).toBe(false);
    expect(result.setupCode).toMatch(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);
    // An account that already has an address keeps it.
    expect(requests.some((request) => request.url.endsWith("/workers/subdomain") && request.init?.method === "PUT")).toBe(false);
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

  it("registers a workers.dev subdomain before uploading, because a fresh account has none", async () => {
    const requests: Array<{ url: string; method: string; body?: BodyInit | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      requests.push({ url, method, body: init?.body });
      // What Cloudflare answers on an account that has never opened the Workers dashboard.
      if (url.endsWith("/workers/subdomain") && method === "GET") return failure(10007, "workers.dev subdomain not found", 404);
      if (url.endsWith("/workers/subdomain") && method === "PUT") {
        const chosen = JSON.parse(String(init?.body)).subdomain as string;
        return response({ subdomain: chosen });
      }
      if (url.endsWith("/d1/database") && method === "POST") return response({ uuid: "db-1" });
      if (url.endsWith("/storage/kv/namespaces")) return response({ id: "kv-1" });
      if (url.endsWith("/queues")) return response({ queue_id: "queue-1" });
      if (url.includes("/d1/database/db-1/query")) return response([{}]);
      if (url.includes("/workers/scripts/meeting-note-install1") && method === "PUT") return response({ id: "meeting-note-install1" });
      if (url.endsWith("/queues/queue-1/consumers")) return response({ consumer_id: "consumer-1" });
      if (url.endsWith("/workers/scripts/meeting-note-install1/subdomain")) return response({ enabled: true });
      throw new Error(`Unexpected request ${method} ${url}`);
    }));

    const result = await provisionMeetingNote({
      accountId: "account-1",
      accessToken: "secret-oauth-token",
      releaseScript: "export default {}",
      release,
      installId: "install-1234"
    });

    const registered = JSON.parse(String(requests.find((request) => request.method === "PUT" && request.url.endsWith("/workers/subdomain"))!.body)).subdomain;
    expect(registered).toMatch(/^meeting-note-[a-z0-9]{6}$/);
    expect(result.appUrl).toBe(`https://meeting-note-install1.${registered}.workers.dev`);
    expect(result.addressIsNew).toBe(true);
    const registerIndex = requests.findIndex((request) => request.method === "PUT" && request.url.endsWith("/workers/subdomain"));
    const uploadIndex = requests.findIndex((request) => request.method === "PUT" && request.url.endsWith("/workers/scripts/meeting-note-install1"));
    // Cloudflare rejects the upload itself (10063) when the account has no address yet.
    expect(registerIndex).toBeLessThan(uploadIndex);
    // Nothing is created before the account can host a Worker at all.
    expect(requests.findIndex((request) => request.url.endsWith("/d1/database"))).toBeGreaterThan(registerIndex);
  });

  it("asks for another subdomain when the first name is already taken", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      if (url.endsWith("/workers/subdomain") && method === "GET") return failure(10007, "not found", 404);
      if (url.endsWith("/workers/subdomain") && method === "PUT") {
        const chosen = JSON.parse(String(init?.body)).subdomain as string;
        asked.push(chosen);
        if (asked.length === 1) return failure(10031, "Subdomain is unavailable");
        return response({ subdomain: chosen });
      }
      if (url.endsWith("/d1/database") && method === "POST") return response({ uuid: "db-1" });
      if (url.endsWith("/storage/kv/namespaces")) return response({ id: "kv-1" });
      if (url.endsWith("/queues")) return response({ queue_id: "queue-1" });
      if (url.includes("/d1/database/db-1/query")) return response([{}]);
      if (url.includes("/workers/scripts/meeting-note-install1") && method === "PUT") return response({ id: "ok" });
      if (url.endsWith("/queues/queue-1/consumers")) return response({ consumer_id: "consumer-1" });
      if (url.endsWith("/workers/scripts/meeting-note-install1/subdomain")) return response({ enabled: true });
      throw new Error(`Unexpected request ${method} ${url}`);
    }));

    const result = await provisionMeetingNote({
      accountId: "account-1",
      accessToken: "secret-oauth-token",
      releaseScript: "export default {}",
      release,
      installId: "install-1234"
    });

    expect(asked).toHaveLength(2);
    expect(asked[0]).not.toBe(asked[1]);
    expect(result.appUrl).toBe(`https://meeting-note-install1.${asked[1]}.workers.dev`);
  });

  it("says which step failed, and names a missing address by its own code", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      if (method === "DELETE") return response(null);
      if (url.endsWith("/workers/subdomain") && method === "GET") return response({ subdomain: "quiet-harbour" });
      if (url.endsWith("/d1/database") && method === "POST") return response({ uuid: "db-1" });
      if (url.endsWith("/storage/kv/namespaces")) return response({ id: "kv-1" });
      if (url.endsWith("/queues")) return response({ queue_id: "queue-1" });
      if (url.includes("/d1/database/db-1/query")) return response([{}]);
      if (url.includes("/workers/scripts/meeting-note-install1") && method === "PUT") {
        return failure(10063, "You need a workers.dev subdomain in order to proceed.");
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    }));

    const failed = await provisionMeetingNote({
      accountId: "account-1",
      accessToken: "secret-oauth-token",
      releaseScript: "export default {}",
      release,
      installId: "install-1234"
    }).catch((error) => error);

    expect(failed).toBeInstanceOf(InstallError);
    expect((failed as InstallError).code).toBe("workers_subdomain");
    expect((failed as InstallError).apiCodes).toContain(10063);
  });

  it("lists what this account already has, so a second run is a choice and not a surprise", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/workers/subdomain")) return response({ subdomain: "quiet-harbour" });
      if (url.endsWith("/workers/scripts")) {
        return response([
          { id: "meeting-note-abcd1234", created_on: "2026-09-19T10:00:00Z" },
          { id: "meeting-note-installer", created_on: "2026-09-01T10:00:00Z" },
          { id: "my-other-worker", created_on: "2026-09-18T10:00:00Z" },
          { id: "meeting-note-zz11", created_on: "2026-09-20T10:00:00Z" }
        ]);
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    const apps = await listInstalls("secret-oauth-token", "account-1");

    // Newest first, and neither the installer itself nor an unrelated Worker counts as an install.
    expect(apps.map((app) => app.name)).toEqual(["meeting-note-zz11", "meeting-note-abcd1234"]);
    expect(apps[0].url).toBe("https://meeting-note-zz11.quiet-harbour.workers.dev");
  });

  it("says an account has nothing rather than failing, when it cannot look", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // An account that has never opened the Workers dashboard cannot hold an install yet.
      if (url.endsWith("/workers/subdomain")) return failure(10007, "not found", 404);
      throw new Error(`Unexpected request ${url}`);
    }));

    await expect(listInstalls("secret-oauth-token", "account-1")).resolves.toEqual([]);
  });

  it("removes half-created resources when installation fails", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      requests.push({ url, method });
      if (method === "DELETE") return response(null);
      if (url.endsWith("/workers/subdomain") && method === "GET") return response({ subdomain: "quiet-harbour" });
      if (url.endsWith("/d1/database") && method === "POST") return response({ uuid: "db-broken" });
      if (url.endsWith("/storage/kv/namespaces")) return response({ id: "kv-broken" });
      if (url.endsWith("/queues")) return response({ queue_id: "queue-broken" });
      if (url.includes("/d1/database/db-broken/query")) return response(null, 500);
      throw new Error(`Unexpected request ${method} ${url}`);
    }));

    const failed = await provisionMeetingNote({
      accountId: "account-1",
      accessToken: "secret-oauth-token",
      releaseScript: "export default {}",
      release: { version: "1.2.3", migrations: [{ name: "0001.sql", sql: "broken" }] },
      installId: "cleanup-1234"
    }).catch((error) => error);

    expect(failed).toBeInstanceOf(InstallError);
    expect((failed as InstallError).code).toBe("database");
    expect((failed as InstallError).message).toBe("missing");
    expect(requests.filter((request) => request.method === "DELETE").map((request) => new URL(request.url).pathname)).toEqual([
      "/client/v4/accounts/account-1/queues/queue-broken",
      "/client/v4/accounts/account-1/storage/kv/namespaces/kv-broken",
      "/client/v4/accounts/account-1/d1/database/db-broken"
    ]);
  });
});
