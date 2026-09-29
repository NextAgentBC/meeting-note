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
  | "update_first"
  | "unreachable"
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
  /** Where the copy asks whether a newer release exists. Empty to leave it checking nothing. */
  updateChannel: string;
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

const SETTLING_CODES = new Set([
  10063, // "You need a workers.dev subdomain in order to proceed" — registered, not yet usable
  10031, // subdomain unavailable, which a moment after registering can mean "not yours yet"
  10007, // subdomain lookup finds nothing, right after it was created
  10000 // Cloudflare's catch-all authentication/availability wobble
]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cloudflare answers "not there" for a few seconds after it creates something. Every step here is
 * idempotent enough to repeat — a create that already happened answers with the same object, and
 * a script upload is a PUT — so a step that fails on a settling error is simply tried again.
 */
async function settle<T>(label: string, work: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      last = error;
      const settling = error instanceof CloudflareError
        && (error.codes.some((code) => SETTLING_CODES.has(code)) || error.codes.length === 0);
      if (!settling || attempt === attempts) break;
      const wait = 1500 * attempt;
      console.log(`Installer ${label}: ${error instanceof Error ? error.message : error} — retrying in ${wait}ms (${attempt}/${attempts - 1})`);
      await sleep(wait);
    }
  }
  throw last;
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
      // A name registered this second is not usable this second. The pause covers the common case;
      // the script upload retries on 10063 for the rest.
      await sleep(1500);
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

/** What every copy runs with. The upgrade adds the ones an older copy has never had. */
export const APP_VARS: Record<string, string> = {
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
  SEGMENT_TARGET_MINUTES: "5",
  // The paid second pass that tells speakers apart. Off in every installed copy: it is billed per
  // audio minute, and the installer promises $0 with no card. An owner who wants it sets
  // HD_MODEL to "@cf/deepgram/nova-3" in their own Worker. Updates keep whatever they chose.
  HD_MODEL: ""
};

const SCRIPT_METADATA = {
  main_module: "standalone.js",
  compatibility_date: "2026-09-10",
  compatibility_flags: ["nodejs_compat"]
};

function scriptUpload(metadata: Record<string, unknown>, script: string): FormData {
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.set("standalone.js", new Blob([script], { type: "application/javascript+module" }), "standalone.js");
  return form;
}

export type ExistingInstall = {
  name: string;
  url: string;
  createdOn: string;
  /** The release the copy is running, as it reports itself; empty when it could not be asked. */
  version: string;
  /** False while nobody has created the owner passkey yet: that copy is still up for grabs. */
  claimed: boolean;
};

// A failed attempt leaves nothing behind, but a finished one does, and its owner may have lost the
// address. Before installing again, the page says what this account already has.
async function ask(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    return response.ok ? await response.json<Record<string, unknown>>() : null;
  } catch {
    return null;
  }
}

export async function listInstalls(token: string, account: string): Promise<ExistingInstall[]> {
  try {
    const current = await cf<{ subdomain?: string | null }>(token, `/accounts/${account}/workers/subdomain`);
    const subdomain = current?.subdomain;
    if (!subdomain) return [];
    const scripts = await cf<Array<{ id?: string; created_on?: string }>>(token, `/accounts/${account}/workers/scripts`);
    const found = (scripts || [])
      .filter((script) => typeof script.id === "string" && /^meeting-note-[a-z0-9]{1,8}$/.test(script.id))
      .map((script) => ({
        name: script.id as string,
        url: `https://${script.id}.${subdomain}.workers.dev`,
        createdOn: script.created_on || ""
      }))
      .sort((first, second) => second.createdOn.localeCompare(first.createdOn));
    // Each copy says what it is running and whether anyone has claimed it. Both routes are public,
    // and neither answer is worth failing the page over.
    return await Promise.all(found.map(async (install) => {
      const [health, me] = await Promise.all([ask(`${install.url}/api/health`), ask(`${install.url}/api/auth/me`)]);
      return { ...install, version: String(health?.version || ""), claimed: Boolean(me?.hasOwner) };
    }));
  } catch (error) {
    // Never a reason to stop someone installing: an unreadable account simply has nothing to show.
    console.error("Could not list existing installations", error);
    return [];
  }
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
      ...Object.entries({ ...APP_VARS, UPDATE_CHANNEL: input.updateChannel })
        .map(([name, text]) => ({ type: "plain_text", name, text }))
    ];
    const form = scriptUpload({
      ...SCRIPT_METADATA,
      bindings,
      annotations: { "workers/message": `Meeting Note personal installer ${input.release.version}` }
    }, input.releaseScript);
    await step("worker", () => settle("script upload", () => cf(input.accessToken, `/accounts/${account}/workers/scripts/${workerName}`, { method: "PUT", body: form })));
    workerCreated = true;

    await step("queue", () => settle("queue consumer", () => cf(input.accessToken, `/accounts/${account}/queues/${queueId}/consumers`, {
      method: "POST",
      body: JSON.stringify({
        type: "worker",
        script_name: workerName,
        settings: { batch_size: 1, max_retries: 3, max_wait_time_ms: 5000 }
      })
    })));
    await step("address", () => settle("publish address", () => cf(input.accessToken, `/accounts/${account}/workers/scripts/${workerName}/subdomain`, {
      method: "POST",
      body: JSON.stringify({ enabled: true, previews_enabled: false })
    })));

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


export type UpgradeInput = {
  accountId: string;
  accessToken: string;
  workerName: string;
  releaseScript: string;
  version: string;
  updateChannel: string;
};

const INSTALL_NAME = /^meeting-note-[a-z0-9]{1,8}$/;

/**
 * Replaces the code of a copy that is already installed, keeping its database, its audio, its queue
 * and its owner. The new code applies whatever database changes it needs the first time it runs
 * (src/schema.ts), so this only has to get the script and the bindings right.
 */
export async function upgradeInstall(input: UpgradeInput): Promise<{ version: string }> {
  if (!INSTALL_NAME.test(input.workerName)) throw new InstallError("worker", "That is not a Meeting Note installation");
  const account = encodeURIComponent(input.accountId);
  const settings = await step("worker", () => cf<{ bindings?: Array<Record<string, unknown>> }>(
    input.accessToken,
    `/accounts/${account}/workers/scripts/${encodeURIComponent(input.workerName)}/settings`
  ));
  const existing = settings?.bindings || [];
  // Data bindings are carried over exactly as they are: this is what keeps the owner's meetings.
  const carried = existing.filter((binding) => binding.type !== "secret_text" && binding.type !== "plain_text");
  for (const required of ["d1", "kv_namespace", "queue", "ai"]) {
    if (!carried.some((binding) => binding.type === required)) {
      throw new InstallError("worker", `This Worker has no ${required} binding; the installer will not overwrite it`);
    }
  }
  // Settings the owner may have changed stay as they are; only missing ones take the new default.
  const vars = new Map(existing
    .filter((binding) => binding.type === "plain_text")
    .map((binding) => [String(binding.name), String(binding.text ?? "")]));
  for (const [name, text] of Object.entries(APP_VARS)) if (!vars.has(name)) vars.set(name, text);
  // "off" is the owner's opt-out from the update check; an update must not quietly undo it.
  if (input.updateChannel && vars.get("UPDATE_CHANNEL")?.trim().toLowerCase() !== "off") vars.set("UPDATE_CHANNEL", input.updateChannel);

  const form = scriptUpload({
    ...SCRIPT_METADATA,
    bindings: [...carried, ...[...vars].map(([name, text]) => ({ type: "plain_text", name, text }))],
    // The owner's setup code, and anything else secret, survives the upload untouched.
    keep_bindings: ["secret_text"],
    annotations: { "workers/message": `Meeting Note update ${input.version}` }
  }, input.releaseScript);
  await step("worker", () => cf(input.accessToken, `/accounts/${account}/workers/scripts/${encodeURIComponent(input.workerName)}`, {
    method: "PUT",
    body: form
  }));
  return { version: input.version };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ReclaimResult = { setupCode: string; mode: "claim" | "recover" };

/**
 * The two ways back into a copy, both for the Cloudflare account owner who has just signed in here.
 *
 * - Nobody has claimed it (the claim link was lost, or opened in a browser that cannot make a
 *   passkey): a new claim code replaces the old one.
 * - It has an owner who lost every device and the recovery code as well: a one-time recovery code.
 *   The copy's database records the code as granted before the code is set, and the copy spends it
 *   on first use, so this link cannot sit in a chat and open the app again later. A copy too old to
 *   know about grants is refused, because there the code would keep working for ever.
 */
export async function reclaimInstall(input: { accountId: string; accessToken: string; workerName: string; url: string }): Promise<ReclaimResult> {
  if (!INSTALL_NAME.test(input.workerName)) throw new InstallError("worker", "That is not a Meeting Note installation");
  const me = await ask(`${input.url}/api/auth/me`);
  // Not knowing whether the copy has an owner is not the same as knowing it has none.
  if (!me || typeof me.hasOwner !== "boolean") {
    throw new InstallError("unreachable", "This copy did not answer. Check that it is online, then try again");
  }
  const account = encodeURIComponent(input.accountId);
  const script = `/accounts/${account}/workers/scripts/${encodeURIComponent(input.workerName)}`;
  const code = setupCode();
  let mode: ReclaimResult["mode"] = "claim";

  if (me.hasOwner) {
    if (me.recoveryGrants !== true) {
      throw new InstallError("update_first", "This copy is too old for a one-time recovery link. Update it, then try again");
    }
    const settings = await step("worker", () => cf<{ bindings?: Array<Record<string, unknown>> }>(input.accessToken, `${script}/settings`));
    const database = (settings?.bindings || []).find((binding) => binding.type === "d1" && binding.name === "DB");
    const databaseId = String(database?.id ?? database?.database_id ?? "");
    if (!databaseId) throw new InstallError("database", "This Worker has no database binding");
    // Granted first: a code with no grant opens nothing, so a failure after this leaves no way in.
    // Only the hash is written, the way the copy stores every code.
    const codeHash = await sha256Hex(code);
    await step("database", () => cf(input.accessToken, `/accounts/${account}/d1/database/${encodeURIComponent(databaseId)}/query`, {
      method: "POST",
      body: JSON.stringify({
        sql: "INSERT INTO setup_code_grants (code_hash, granted_at) VALUES (?, ?)",
        // The query API takes its parameters as strings; the INTEGER column stores a number.
        params: [codeHash, String(Date.now())]
      })
    }));
    mode = "recover";
  }

  await step("worker", () => cf(input.accessToken, `${script}/secrets`, {
    method: "PUT",
    body: JSON.stringify({ name: "SETUP_CODE", text: code, type: "secret_text" })
  }));
  return { setupCode: code, mode };
}
