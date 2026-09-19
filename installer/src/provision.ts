const API = "https://api.cloudflare.com/client/v4";

type ApiEnvelope<T> = { success: boolean; result: T; errors?: Array<{ message?: string; code?: number }> };
type Release = { version: string; migrations: Array<{ name: string; sql: string }> };

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
    throw new Error(detail || `Cloudflare request failed (${response.status})`);
  }
  return data.result;
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

async function ensureWorkersSubdomain(token: string, accountId: string, id: string): Promise<string> {
  try {
    const current = await cf<{ subdomain: string }>(token, `/accounts/${accountId}/workers/subdomain`);
    if (current.subdomain) return current.subdomain;
  } catch { /* A new account does not have a workers.dev subdomain yet. */ }
  const chosen = `meeting-note-${suffix(id)}`;
  const created = await cf<{ subdomain: string }>(token, `/accounts/${accountId}/workers/subdomain`, {
    method: "PUT",
    body: JSON.stringify({ subdomain: chosen })
  });
  return created.subdomain;
}

export async function provisionMeetingNote(input: ProvisionInput): Promise<ProvisionResult> {
  const id = suffix(input.installId);
  const workerName = `meeting-note-${id}`;
  const databaseName = `meeting-note-db-${id}`;
  const namespaceName = `meeting-note-audio-${id}`;
  const queueName = `meeting-note-jobs-${id}`;
  const ownerCode = setupCode();
  const account = encodeURIComponent(input.accountId);

  let databaseId = "";
  let namespaceId = "";
  let queueId = "";
  let workerCreated = false;

  try {
    const database = await cf<{ uuid: string }>(input.accessToken, `/accounts/${account}/d1/database`, {
      method: "POST",
      body: JSON.stringify({ name: databaseName })
    });
    databaseId = database.uuid;
    const namespace = await cf<{ id: string }>(input.accessToken, `/accounts/${account}/storage/kv/namespaces`, {
      method: "POST",
      body: JSON.stringify({ title: namespaceName })
    });
    namespaceId = namespace.id;
    const queue = await cf<{ queue_id: string }>(input.accessToken, `/accounts/${account}/queues`, {
      method: "POST",
      body: JSON.stringify({ queue_name: queueName })
    });
    queueId = queue.queue_id;

    for (const migration of input.release.migrations) {
      await cf(input.accessToken, `/accounts/${account}/d1/database/${databaseId}/query`, {
        method: "POST",
        body: JSON.stringify({ sql: migration.sql })
      });
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
    await cf(input.accessToken, `/accounts/${account}/workers/scripts/${workerName}`, { method: "PUT", body: form });
    workerCreated = true;

    await cf(input.accessToken, `/accounts/${account}/queues/${queueId}/consumers`, {
      method: "POST",
      body: JSON.stringify({
        type: "worker",
        script_name: workerName,
        settings: { batch_size: 1, max_retries: 3, max_wait_time_ms: 5000 }
      })
    });
    const subdomain = await ensureWorkersSubdomain(input.accessToken, input.accountId, input.installId);
    await cf(input.accessToken, `/accounts/${account}/workers/scripts/${workerName}/subdomain`, {
      method: "POST",
      body: JSON.stringify({ enabled: true, previews_enabled: false })
    });

    return {
      appUrl: `https://${workerName}.${subdomain}.workers.dev`,
      setupCode: ownerCode,
      workerName,
      version: input.release.version
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
