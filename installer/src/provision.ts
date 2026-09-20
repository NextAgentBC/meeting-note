const API = "https://api.cloudflare.com/client/v4";

type ApiError = { message?: string; code?: number };
type ApiEnvelope<T> = { success: boolean; result: T; errors?: ApiError[] };
type Release = { version: string; migrations: Array<{ name: string; sql: string }> };

// Cloudflare refuses to accept a Worker script on an account that has never opened the Workers
// dashboard (error 10063), so the subdomain is registered before anything else is created.
const SUBDOMAIN_REQUIRED = 10063;
const SUBDOMAIN_MISSING = 10007;
const SUBDOMAIN_TAKEN = 10031;

export type InstallErrorCode =
  | "workers_subdomain"
  | "database"
  | "storage"
  | "queue"
  | "worker"
  | "address"
  | "unknown";

export class InstallError extends Error {
  constructor(readonly code: InstallErrorCode, message: string, readonly apiCodes: number[] = []) {
    super(message);
    this.name = "InstallError";
  }
}

class CloudflareError extends Error {
  constructor(message: string, readonly codes: number[]) {
    super(message);
    this.name = "CloudflareError";
  }
}

export type ProvisionInput = {
  accountId: string;
  accessToken: string;
  releaseScript: string;
  release: Release;
  installId: string;
};

export type ProvisionResult = {
  appUrl: string;
  setupCode: string;
  workerName: string;
  version: string;
  addressIsNew: boolean;
};

async function cf<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }),
      ...(init.headers || {})
    }
  });
  const data: ApiEnvelope<T> = await response.json<ApiEnvelope<T>>().catch(() => ({ success: false, result: null as T, errors: [] }));
  if (!response.ok || !data.success) {
    const detail = data.errors?.map((error) => error.message || error.code).filter(Boolean).join("; ");
    const codes = data.errors?.map((error) => error.code).filter((code): code is number => typeof code === "number") || [];
    throw new CloudflareError(detail || `Cloudflare request failed (${response.status})`, codes);
  }
  return data.result;
}

// Every Cloudflare failure reaches the browser as a code the installer page can say in the reader's
// own language, instead of one English sentence written for the dashboard.
async function step<T>(code: InstallErrorCode, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof InstallError) throw error;
    if (error instanceof CloudflareError) {
      throw new InstallError(error.codes.includes(SUBDOMAIN_REQUIRED) ? "workers_subdomain" : code, error.message, error.codes);
    }
    throw new InstallError(code, error instanceof Error ? error.message : String(error));
  }
}

async function remove(token: string, path: string): Promise<void> {
  try {
    const response = await fetch(`${API}${path}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok && response.status !== 404) {
      console.error("Installer rollback could not remove", path, response.status);
    }
  } catch (error) {
    console.error("Installer rollback could not remove", path, error);
  }
}

function suffix(id: string): string {
  return id.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 8);
}

function setupCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const value = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
  return value.match(/.{1,4}/g)!.join("-");
}

// A workers.dev subdomain is one name for the whole account, so it cannot reuse the install id:
// a second account installing from the same page would ask for a name that is already taken.
function subdomainCandidate(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `meeting-note-${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}

export async function ensureWorkersSubdomain(token: string, account: string): Promise<{ subdomain: string; created: boolean }> {
  try {
    const current = await cf<{ subdomain?: string | null }>(token, `/accounts/${account}/workers/subdomain`);
    if (current?.subdomain) return { subdomain: current.subdomain, created: false };
  } catch (error) {
    // A fresh account answers 10007 here; anything else is still worth one registration attempt.
    if (!(error instanceof CloudflareError)) throw new InstallError("workers_subdomain", error instanceof Error ? error.message : String(error));
    if (error.codes.length && !error.codes.includes(SUBDOMAIN_MISSING) && !error.codes.includes(SUBDOMAIN_REQUIRED)) {
      console.error("Unexpected workers.dev subdomain lookup failure", error.codes, error.message);
    }
  }
  let lastError = "";
  let lastCodes: number[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = subdomainCandidate();
    try {
      const created = await cf<{ subdomain?: string }>(token, `/accounts/${account}/workers/subdomain`, {
        method: "PUT",
        body: JSON.stringify({ subdomain: candidate })
      });
      return { subdomain: created?.subdomain || candidate, created: true };
    } catch (error) {
      if (!(error instanceof CloudflareError)) throw new InstallError("workers_subdomain", error instanceof Error ? error.message : String(error));
      lastError = error.message;
      lastCodes = error.codes;
      // Only a name someone else already holds is worth a second guess.
      if (!error.codes.includes(SUBDOMAIN_TAKEN)) break;
    }
  }
  throw new InstallError("workers_subdomain", lastError || "Could not register a workers.dev subdomain", lastCodes);
}

export async function provisionMeetingNote(input: ProvisionInput): Promise<ProvisionResult> {
  const id = suffix(input.installId);
  const workerName = `meeting-note-${id}`;
  const databaseName = `meeting-note-db-${id}`;
  const namespaceName = `meeting-note-audio-${id}`;
  const queueName = `meeting-note-jobs-${id}`;
  const ownerCode = setupCode();
  const account = encodeURIComponent(input.accountId);

  // Before any resource exists, so a missing subdomain costs the account nothing to roll back.
  const address = await ensureWorkersSubdomain(input.accessToken, account);

  let databaseId = "";
  let namespaceId = "";
  let queueId = "";
  let workerCreated = false;

  try {
    const database = await step("database", () => cf<{ uuid: string }>(input.accessToken, `/accounts/${account}/d1/database`, {
      method: "POST",
      body: JSON.stringify({ name: databaseName })
    }));
    databaseId = database.uuid;
    const namespace = await step("storage", () => cf<{ id: string }>(input.accessToken, `/accounts/${account}/storage/kv/namespaces`, {
      method: "POST",
      body: JSON.stringify({ title: namespaceName })
    }));
    namespaceId = namespace.id;
    const queue = await step("queue", () => cf<{ queue_id: string }>(input.accessToken, `/accounts/${account}/queues`, {
      method: "POST",
      body: JSON.stringify({ queue_name: queueName })
    }));
    queueId = queue.queue_id;

    for (const migration of input.release.migrations) {
      await step("database", () => cf(input.accessToken, `/accounts/${account}/d1/database/${databaseId}/query`, {
        method: "POST",
        body: JSON.stringify({ sql: migration.sql })
      }));
    }

    const bindings = [
      { type: "d1", name: "DB", database_id: databaseId },
      { type: "kv_namespace", name: "AUDIO", namespace_id: namespaceId },
      { type: "queue", name: "JOBS", queue_name: queueName },
      { type: "ai", name: "AI" },
      { type: "secret_text", name: "SETUP_CODE", text: ownerCode },
      ...Object.entries({
        ASR_MODEL: "@cf/openai/whisper-large-v3-turbo",
        SUMMARY_MODEL: "@cf/zai-org/glm-4.7-flash",
        FINAL_MODEL: "@cf/zai-org/glm-4.7-flash",
        PLAN_MODEL: "@cf/zai-org/glm-4.7-flash",
        ASK_MODEL: "@cf/zai-org/glm-4.7-flash",
        VISION_MODEL: "@cf/llava-hf/llava-1.5-7b-hf",
        CHINESE_SCRIPT: "simplified",
        FREE_DAILY_NEURONS: "10000",
        WORKERS_PLAN: "free",
        AUDIO_RETENTION_DAYS: "7",
        SEGMENT_TARGET_MINUTES: "5"
      }).map(([name, text]) => ({ type: "plain_text", name, text }))
    ];
    const metadata = {
      main_module: "standalone.js",
      compatibility_date: "2026-09-10",
      compatibility_flags: ["nodejs_compat"],
      bindings,
      annotations: { "workers/message": `Meeting Note personal installer ${input.release.version}` }
    };
    const form = new FormData();
    form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.set("standalone.js", new Blob([input.releaseScript], { type: "application/javascript+module" }), "standalone.js");
    await step("worker", () => cf(input.accessToken, `/accounts/${account}/workers/scripts/${workerName}`, { method: "PUT", body: form }));
    workerCreated = true;

    await step("queue", () => cf(input.accessToken, `/accounts/${account}/queues/${queueId}/consumers`, {
      method: "POST",
      body: JSON.stringify({
        type: "worker",
        script_name: workerName,
        settings: { batch_size: 1, max_retries: 3, max_wait_time_ms: 5000 }
      })
    }));
    await step("address", () => cf(input.accessToken, `/accounts/${account}/workers/scripts/${workerName}/subdomain`, {
      method: "POST",
      body: JSON.stringify({ enabled: true, previews_enabled: false })
    }));

    return {
      appUrl: `https://${workerName}.${address.subdomain}.workers.dev`,
      setupCode: ownerCode,
      workerName,
      version: input.release.version,
      // A name registered seconds ago can take a few minutes to resolve; the page says so.
      addressIsNew: address.created
    };
  } catch (error) {
    // A retry should start cleanly instead of colliding with half-created resources.
    if (workerCreated) await remove(input.accessToken, `/accounts/${account}/workers/scripts/${workerName}`);
    if (queueId) await remove(input.accessToken, `/accounts/${account}/queues/${queueId}`);
    if (namespaceId) await remove(input.accessToken, `/accounts/${account}/storage/kv/namespaces/${namespaceId}`);
    if (databaseId) await remove(input.accessToken, `/accounts/${account}/d1/database/${databaseId}`);
    throw error;
  }
}
