/**
 * Setup codes open a copy once, and sign-in attempts are counted: the passkey routes run for real
 * against node:sqlite with every migration applied. Only the passkey check itself is stubbed out —
 * a vitest run has no authenticator — so each "passkey" it accepts is a new credential id.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

let credentialSerial = 0;
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(async () => ({
      verified: true,
      registrationInfo: { credential: { id: `cred-${++credentialSerial}`, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: [] } }
    }))
  };
});

const { authRoutes, sha256Hex } = await import("../src/auth");

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
const ORIGIN = "https://notes.example.test";
const CLAIM_CODE = "ABCD-EFGH-JKLM-NPQR";

/** The D1 binding over node:sqlite, with bound values in batches and a batch as one transaction. */
function d1(db: DatabaseSync): D1Database {
  const clean = (values: unknown[]) => values.map((value) => (value === undefined ? null : value)) as never[];
  const statement = (sql: string, values: unknown[] = []): any => ({
    sql,
    values,
    bind: (...bound: unknown[]) => statement(sql, bound),
    run: async () => ({ success: true, meta: db.prepare(sql).run(...clean(values)) }),
    all: async () => ({ results: db.prepare(sql).all(...clean(values)) }),
    first: async () => db.prepare(sql).get(...clean(values)) ?? null
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<{ sql: string; values: unknown[] }>) => {
      db.exec("BEGIN");
      try {
        const results = statements.map((item) => db.prepare(item.sql).run(...clean(item.values)));
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  } as unknown as D1Database;
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`${migrationsDir}/${file}`, "utf8"));
  }
  return db;
}

let db: DatabaseSync;
let env: Env;
const app = new Hono<{ Bindings: Env }>().route("/api/auth", authRoutes);

async function call(path: string, body: unknown = {}, address = "203.0.113.7") {
  const response = await app.request(`${ORIGIN}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": address },
    body: JSON.stringify(body)
  }, env);
  return { status: response.status, data: await response.json() as Record<string, any> };
}

/** Both halves of making a passkey: the options (where codes are checked) and the verify. */
async function registerOptions(body: Record<string, unknown>, address?: string) {
  return call("/register/options", body, address);
}
async function registerVerify(challengeId: string, address?: string) {
  return call("/register/verify", { challengeId, response: { id: "stubbed" } }, address);
}
async function register(body: Record<string, unknown>, address?: string) {
  const options = await registerOptions(body, address);
  if (options.status !== 200) return options;
  return registerVerify(options.data.challengeId, address);
}

/** What the installer does for "Make a recovery link": grant the new code, then make it the secret. */
async function installerRecoveryCode(code: string) {
  db.prepare("INSERT INTO setup_code_grants (code_hash, granted_at) VALUES (?, ?)").run(await sha256Hex(code), Date.now());
  env.SETUP_CODE = code;
}

function credentialIds(): string[] {
  return (db.prepare("SELECT id FROM credentials ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
}

beforeEach(() => {
  credentialSerial = 0;
  db = freshDb();
  env = { DB: d1(db), SETUP_CODE: CLAIM_CODE, UPDATE_CHANNEL: "https://install.example.test" } as unknown as Env;
});

describe("a claim code", () => {
  it("claims the copy once, and then opens nothing, not even recovery", async () => {
    const claimed = await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" });
    expect(claimed.status).toBe(200);
    expect(claimed.data.recoveryCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);

    const again = await registerOptions({ purpose: "setup", setupCode: CLAIM_CODE, name: "Someone" });
    expect(again).toMatchObject({ status: 409, data: { code: "already_set_up" } });

    // The link from the chat, typed into "Lost every device?": refused, and the owner's passkey stays.
    const recover = await registerOptions({ purpose: "owner-recover", code: CLAIM_CODE });
    expect(recover).toMatchObject({ status: 403, data: { code: "setup_code_used" } });
    expect(credentialIds()).toEqual(["cred-1"]);
  });

  it("is refused when it does not match, and says the copy can report that it takes recovery links", async () => {
    const wrong = await registerOptions({ purpose: "setup", setupCode: "WRONG-CODE", name: "Owner" });
    expect(wrong).toMatchObject({ status: 403, data: { code: "wrong_setup_code" } });

    const me = await app.request(`${ORIGIN}/api/auth/me`, {}, env);
    expect(await me.json()).toMatchObject({ hasOwner: false, setupCodeRequired: true, recoveryGrants: true });
  });
});

describe("the recovery code shown at setup", () => {
  it("still replaces the passkeys, signs everything out, and is replaced itself", async () => {
    const claimed = await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" });
    const recovered = await register({ purpose: "owner-recover", code: claimed.data.recoveryCode });
    expect(recovered.status).toBe(200);
    expect(recovered.data.recoveryCode).not.toBe(claimed.data.recoveryCode);
    expect(credentialIds()).toEqual(["cred-2"]);

    const reused = await registerOptions({ purpose: "owner-recover", code: claimed.data.recoveryCode });
    expect(reused).toMatchObject({ status: 403, data: { code: "wrong_recovery_code" } });
  });
});

describe("a one-time recovery code from the installer", () => {
  it("opens the copy once", async () => {
    await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" });
    await installerRecoveryCode("WXYZ-2345-6789-ABCD");

    const recovered = await register({ purpose: "owner-recover", code: "WXYZ-2345-6789-ABCD" });
    expect(recovered.status).toBe(200);
    expect(credentialIds()).toEqual(["cred-2"]);

    const again = await registerOptions({ purpose: "owner-recover", code: "WXYZ-2345-6789-ABCD" });
    expect(again).toMatchObject({ status: 403, data: { code: "setup_code_used" } });
  });

  it("lets only one of two racing recoveries in, and leaves the loser's passkey out", async () => {
    await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" });
    await installerRecoveryCode("WXYZ-2345-6789-ABCD");

    // Both get past the options check while the code is still unused.
    const first = await registerOptions({ purpose: "owner-recover", code: "WXYZ-2345-6789-ABCD" });
    const second = await registerOptions({ purpose: "owner-recover", code: "WXYZ-2345-6789-ABCD" }, "198.51.100.9");
    expect([first.status, second.status]).toEqual([200, 200]);

    expect((await registerVerify(first.data.challengeId)).status).toBe(200);
    const late = await registerVerify(second.data.challengeId, "198.51.100.9");
    expect(late).toMatchObject({ status: 409, data: { code: "setup_code_used" } });
    expect(credentialIds()).toEqual(["cred-2"]);
  });

  it("does nothing without the installer's grant", async () => {
    await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" });
    env.SETUP_CODE = "WXYZ-2345-6789-ABCD"; // the secret changed, but nobody granted it

    const refused = await registerOptions({ purpose: "owner-recover", code: "WXYZ-2345-6789-ABCD" });
    expect(refused).toMatchObject({ status: 403, data: { code: "setup_code_used" } });
    expect(credentialIds()).toEqual(["cred-1"]);
  });
});

describe("a SETUP_CODE on a copy deployed by hand", () => {
  it("recovers once without any grant, because its owner set it and nobody handed it out", async () => {
    env.UPDATE_CHANNEL = "";
    await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" });
    // The code the copy was claimed with is spent...
    expect(await registerOptions({ purpose: "owner-recover", code: CLAIM_CODE })).toMatchObject({ status: 403, data: { code: "setup_code_used" } });

    // ...and a new secret opens it once.
    env.SETUP_CODE = "my own long code 2026";
    expect((await register({ purpose: "owner-recover", code: "my own long code 2026" })).status).toBe(200);
    expect(credentialIds()).toEqual(["cred-2"]);
    expect(await registerOptions({ purpose: "owner-recover", code: "my own long code 2026" })).toMatchObject({ status: 403, data: { code: "setup_code_used" } });
  });
});

describe("attempt limits", () => {
  it("stop guessing at codes after ten wrong ones from one address, even with the right code", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const wrong = await registerOptions({ purpose: "setup", setupCode: `WRONG-${attempt}`, name: "Owner" });
      expect(wrong.data.code).toBe("wrong_setup_code");
    }
    const blocked = await registerOptions({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" });
    expect(blocked).toMatchObject({ status: 429, data: { code: "too_many_attempts" } });

    // Someone else, somewhere else, is not held up by it.
    const elsewhere = await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" }, "192.0.2.44");
    expect(elsewhere.status).toBe(200);
  });

  it("count challenges, so a flood cannot spend the database's writes", async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await call("/login/options")).status).toBe(200);
    }
    expect(await call("/login/options")).toMatchObject({ status: 429, data: { code: "too_many_attempts" } });
    expect((await call("/login/options", {}, "192.0.2.44")).status).toBe(200);
    // A refused request writes nothing.
    const rows = db.prepare("SELECT COUNT(*) AS n FROM auth_attempts").get() as { n: number };
    expect(rows.n).toBe(31);
  });

  it("forget attempts older than the window", async () => {
    const key = await sha256Hex("attempt:203.0.113.7");
    const insert = db.prepare("INSERT INTO auth_attempts (ip_hash, kind, at) VALUES (?, 'challenge', ?)");
    for (let attempt = 0; attempt < 30; attempt += 1) insert.run(key, Date.now() - 16 * 60_000);
    expect((await call("/login/options")).status).toBe(200);
  });

  it("let the owner sign in on a copy whose schema update has not landed", async () => {
    db.exec("DROP TABLE auth_attempts");
    expect((await call("/login/options")).status).toBe(200);
  });
});
