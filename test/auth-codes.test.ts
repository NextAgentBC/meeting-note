/**
 * A code opens a copy once, and sign-in attempts are counted: the passkey routes run for real
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
// A test can hold the next passkey check until it opens a gate, to run something else in between.
const registrationGates: Array<Promise<void>> = [];
const authenticationGates: Array<Promise<void>> = [];
function gate(queue: Array<Promise<void>>): () => void {
  let open!: () => void;
  queue.push(new Promise<void>((resolve) => { open = resolve; }));
  return open;
}
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(async () => {
      const id = `cred-${++credentialSerial}`;
      await registrationGates.shift();
      return { verified: true, registrationInfo: { credential: { id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: [] } } };
    }),
    verifyAuthenticationResponse: vi.fn(async () => {
      await authenticationGates.shift();
      return { verified: true, authenticationInfo: { newCounter: 1 } };
    })
  };
});

const { addressBucket, authRoutes, sha256Hex } = await import("../src/auth");
const { applyMigrations, retireClaimCode } = await import("../src/schema");
const { MIGRATIONS } = await import("../src/migrations.generated");

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
const ORIGIN = "https://notes.example.test";
const CLAIM_CODE = "ABCD-EFGH-JKLM-NPQR";
const RECOVERY_LINK_CODE = "WXYZ-2345-6789-ABCD";

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
        return results.map((result) => ({ success: true, meta: { changes: Number(result.changes) } }));
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  } as unknown as D1Database;
}

function migratedDb(upTo = Infinity): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort().slice(0, upTo)) {
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

async function post(path: string, body: unknown = {}, cookie = "", address = "203.0.113.7") {
  return app.request(`${ORIGIN}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": address, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  }, env);
}

/** The session cookie a response set, ready to send back. */
function sessionCookie(response: Response): string {
  const match = /__Host-session=([^;]+)/.exec(response.headers.get("set-cookie") || "");
  return match ? `__Host-session=${match[1]}` : "";
}

async function sessionHashes(): Promise<string[]> {
  return (db.prepare("SELECT token_hash FROM sessions").all() as Array<{ token_hash: string }>).map((row) => row.token_hash);
}

async function hashOfCookie(cookie: string): Promise<string> {
  return sha256Hex(decodeURIComponent(cookie.split("=")[1]));
}

async function me() {
  return (await app.request(`${ORIGIN}/api/auth/me`, {}, env)).json() as Promise<Record<string, any>>;
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
async function installerRecoveryCode(code: string, grantedAt = Date.now()) {
  db.prepare("INSERT INTO setup_code_grants (code_hash, granted_at) VALUES (?, ?)").run(await sha256Hex(code), grantedAt);
  env.SETUP_CODE = code;
}

/** An owner who claimed before migration 0014 existed: no spent code was ever recorded. */
function ownerClaimedLongAgo() {
  db.prepare("INSERT INTO owners (id, name, webauthn_user_id, recovery_hash, created_at) VALUES ('own_old', 'Owner', 'dXNlcg', NULL, 1)").run();
  db.prepare("INSERT INTO credentials (id, owner_id, public_key, counter, transports, created_at) VALUES ('cred-old', 'own_old', 'AQID', 0, '[]', 1)").run();
}

function credentialIds(): string[] {
  return (db.prepare("SELECT id FROM credentials ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
}

beforeEach(() => {
  credentialSerial = 0;
  db = migratedDb();
  // The installer's copies run src/standalone.ts, which sets INSTALLER_COPY on every request.
  env = { DB: d1(db), SETUP_CODE: CLAIM_CODE, INSTALLER_COPY: "1", UPDATE_CHANNEL: "https://install.example.test" } as unknown as Env;
});

describe("a claim code", () => {
  it("claims the copy once, and then opens nothing, not even recovery", async () => {
    const claimed = await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" });
    expect(claimed.status).toBe(200);
    expect(claimed.data.recoveryCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);

    const again = await registerOptions({ purpose: "setup", setupCode: CLAIM_CODE, name: "Someone" });
    expect(again).toMatchObject({ status: 409, data: { code: "already_set_up" } });

    // The link from the chat, typed into "Lost every device?": spent by the claim, and refused.
    const recover = await registerOptions({ purpose: "owner-recover", code: CLAIM_CODE });
    expect(recover).toMatchObject({ status: 403, data: { code: "setup_code_used" } });
    expect(credentialIds()).toEqual(["cred-1"]);
  });

  it("is refused once spent, even on a copy that has somehow lost its owner", async () => {
    await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" });
    db.exec("DELETE FROM credentials; DELETE FROM owners;");
    const again = await registerOptions({ purpose: "setup", setupCode: CLAIM_CODE, name: "Someone" });
    expect(again).toMatchObject({ status: 403, data: { code: "setup_code_used" } });
  });

  it("from before this release recovers nothing on an installer's copy, even with UPDATE_CHANNEL deleted", async () => {
    ownerClaimedLongAgo();
    // The owner turned the update check off by deleting the variable; the copy is still the installer's.
    delete (env as Partial<Env>).UPDATE_CHANNEL;
    const refused = await registerOptions({ purpose: "owner-recover", code: CLAIM_CODE });
    expect(refused).toMatchObject({ status: 403, data: { code: "setup_code_not_granted" } });
    expect(credentialIds()).toEqual(["cred-old"]);
  });

  it("is refused when it does not match, and the copy reports that it takes recovery links", async () => {
    const wrong = await registerOptions({ purpose: "setup", setupCode: "WRONG-CODE", name: "Owner" });
    expect(wrong).toMatchObject({ status: 403, data: { code: "wrong_setup_code" } });
    expect(await me()).toMatchObject({ hasOwner: false, setupCodeRequired: true, recoveryGrants: true, installer: "https://install.example.test" });
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

  it("finishes one of two recoveries started with it, not both", async () => {
    const claimed = await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" });
    const first = await registerOptions({ purpose: "owner-recover", code: claimed.data.recoveryCode });
    const second = await registerOptions({ purpose: "owner-recover", code: claimed.data.recoveryCode }, "198.51.100.9");
    expect([first.status, second.status]).toEqual([200, 200]);

    expect((await registerVerify(first.data.challengeId)).status).toBe(200);
    const late = await registerVerify(second.data.challengeId, "198.51.100.9");
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(credentialIds()).toEqual(["cred-2"]);
  });

  it("stops opening a recovery someone began with it once the owner makes a new one", async () => {
    const claimed = await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" });
    const held = await registerOptions({ purpose: "owner-recover", code: claimed.data.recoveryCode }, "198.51.100.9");
    expect(held.status).toBe(200);

    // The owner, signed in, replaces the code from the Me tab.
    db.prepare("INSERT INTO sessions (token_hash, owner_id, expires_at, created_at) SELECT ?, id, ?, ? FROM owners").run(await sha256Hex("owner-session"), Date.now() + 60_000, Date.now());
    const rotated = await app.request(`${ORIGIN}/api/auth/recovery-code`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie: "__Host-session=owner-session" }
    }, env);
    expect(rotated.status).toBe(200);

    expect(await registerVerify(held.data.challengeId, "198.51.100.9")).toMatchObject({ status: 409, data: { code: "code_used" } });
    expect(credentialIds()).toEqual(["cred-1"]);
  });
});

describe("a one-time recovery link from the installer", () => {
  it("opens the copy once", async () => {
    await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" });
    await installerRecoveryCode(RECOVERY_LINK_CODE);

    const recovered = await register({ purpose: "owner-recover", code: RECOVERY_LINK_CODE });
    expect(recovered.status).toBe(200);
    expect(credentialIds()).toEqual(["cred-2"]);

    const again = await registerOptions({ purpose: "owner-recover", code: RECOVERY_LINK_CODE });
    expect(again).toMatchObject({ status: 403, data: { code: "setup_code_used" } });
  });

  it("lets only one of two racing recoveries in, and leaves the loser's passkey out", async () => {
    await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" });
    await installerRecoveryCode(RECOVERY_LINK_CODE);

    // Both get past the options check while the code is still unused.
    const first = await registerOptions({ purpose: "owner-recover", code: RECOVERY_LINK_CODE });
    const second = await registerOptions({ purpose: "owner-recover", code: RECOVERY_LINK_CODE }, "198.51.100.9");
    expect([first.status, second.status]).toEqual([200, 200]);

    expect((await registerVerify(first.data.challengeId)).status).toBe(200);
    const late = await registerVerify(second.data.challengeId, "198.51.100.9");
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(credentialIds()).toEqual(["cred-2"]);
  });

  it("takes a copy back from someone who claimed it, and a recovery they kept waiting cannot undo that", async () => {
    // A squatter claimed through a leaked link and holds its recovery code.
    const squatter = await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Squatter" }, "198.51.100.9");
    const held = await registerOptions({ purpose: "owner-recover", code: squatter.data.recoveryCode }, "198.51.100.9");
    expect(held.status).toBe(200);

    // The Cloudflare account owner makes a recovery link in the installer and uses it.
    await installerRecoveryCode(RECOVERY_LINK_CODE);
    expect((await register({ purpose: "owner-recover", code: RECOVERY_LINK_CODE })).status).toBe(200);
    expect(credentialIds()).toEqual(["cred-2"]);

    // The squatter's waiting recovery fails on its spent code, and the code no longer matches.
    expect(await registerVerify(held.data.challengeId, "198.51.100.9")).toMatchObject({ status: 409, data: { code: "code_used" } });
    expect(await registerOptions({ purpose: "owner-recover", code: squatter.data.recoveryCode }, "198.51.100.9")).toMatchObject({ status: 403, data: { code: "wrong_recovery_code" } });
    expect(credentialIds()).toEqual(["cred-2"]);
  });

  it("does nothing without the installer's grant", async () => {
    await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" });
    env.SETUP_CODE = RECOVERY_LINK_CODE; // the secret changed, but nobody granted it

    const refused = await registerOptions({ purpose: "owner-recover", code: RECOVERY_LINK_CODE });
    expect(refused).toMatchObject({ status: 403, data: { code: "setup_code_not_granted" } });
    expect(credentialIds()).toEqual(["cred-1"]);
  });

  it("expires a day after the installer granted it", async () => {
    await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" });
    await installerRecoveryCode(RECOVERY_LINK_CODE, Date.now() - 25 * 60 * 60_000);

    const refused = await registerOptions({ purpose: "owner-recover", code: RECOVERY_LINK_CODE });
    expect(refused).toMatchObject({ status: 403, data: { code: "setup_code_not_granted" } });
  });
});

describe("a squatter who claimed first", () => {
  async function squatterAndOwnerLink() {
    const claimed = await post("/register/options", { purpose: "setup", setupCode: CLAIM_CODE, name: "Squatter" }, "", "198.51.100.9");
    const verified = await post("/register/verify", { challengeId: (await claimed.json() as any).challengeId, response: { id: "stubbed" } }, "", "198.51.100.9");
    const squatter = { cookie: sessionCookie(verified), recoveryCode: (await verified.json() as any).recoveryCode as string };
    await installerRecoveryCode(RECOVERY_LINK_CODE);
    return squatter;
  }

  it("cannot stop the owner's recovery by rotating the recovery code in a loop", async () => {
    const squatter = await squatterAndOwnerLink();
    const options = await registerOptions({ purpose: "owner-recover", code: RECOVERY_LINK_CODE });
    for (let round = 0; round < 5; round += 1) {
      expect((await post("/recovery-code", {}, squatter.cookie, "198.51.100.9")).status).toBe(200);
    }
    const recovered = await post("/register/verify", { challengeId: options.data.challengeId, response: { id: "stubbed" } });
    expect(recovered.status).toBe(200);
    expect(credentialIds()).toEqual(["cred-2"]);
    expect(await sessionHashes()).toEqual([await hashOfCookie(sessionCookie(recovered))]);
  });

  it("loses a recovery it runs alongside the owner's, whichever finishes first", async () => {
    for (const squatterFirst of [false, true]) {
      credentialSerial = 0;
      db = migratedDb();
      env = { ...env, DB: d1(db), SETUP_CODE: CLAIM_CODE } as Env;
      const squatter = await squatterAndOwnerLink();
      const theirs = await registerOptions({ purpose: "owner-recover", code: squatter.recoveryCode }, "198.51.100.9");
      const ours = await registerOptions({ purpose: "owner-recover", code: RECOVERY_LINK_CODE });

      // One verify waits at its passkey check while the other finishes.
      const release = gate(registrationGates);
      const [held, run] = squatterFirst ? [ours, theirs] : [theirs, ours];
      const heldAddress = squatterFirst ? "203.0.113.7" : "198.51.100.9";
      const waiting = post("/register/verify", { challengeId: held.data.challengeId, response: { id: "stubbed" } }, "", heldAddress);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const first = await post("/register/verify", { challengeId: run.data.challengeId, response: { id: "stubbed" } }, "", squatterFirst ? "198.51.100.9" : "203.0.113.7");
      release();
      const second = await waiting;

      const owner = squatterFirst ? second : first;
      expect(owner.status).toBe(200);
      if (!squatterFirst) expect(second.status).toBe(409);
      // The owner holds the only passkey and the only session.
      expect(credentialIds()).toHaveLength(1);
      expect(await sessionHashes()).toEqual([await hashOfCookie(sessionCookie(owner))]);
    }
  });

  it("cannot add a device through a link made before the owner took the copy back", async () => {
    const squatter = await squatterAndOwnerLink();
    const link = await post("/device-link", {}, squatter.cookie, "198.51.100.9");
    const token = /#add-device=(.+)$/.exec((await link.json() as any).url)![1];
    const linkOptions = await registerOptions({ purpose: "link-device", token }, "198.51.100.9");
    expect(linkOptions.status).toBe(200);

    expect((await register({ purpose: "owner-recover", code: RECOVERY_LINK_CODE })).status).toBe(200);
    const late = await registerVerify(linkOptions.data.challengeId, "198.51.100.9");
    expect(late).toMatchObject({ status: 400, data: { code: "link_expired" } });
    expect(credentialIds()).toEqual(["cred-2"]);
  });

  it("gets no session from a sign-in whose check passed just before the owner took the copy back", async () => {
    await squatterAndOwnerLink();
    const signIn = await call("/login/options", {}, "198.51.100.9");
    const release = gate(authenticationGates);
    const waiting = post("/login/verify", { challengeId: signIn.data.challengeId, response: { id: "cred-1", response: {} } }, "", "198.51.100.9");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const recovered = await post("/register/options", { purpose: "owner-recover", code: RECOVERY_LINK_CODE });
    const owner = await post("/register/verify", { challengeId: (await recovered.json() as any).challengeId, response: { id: "stubbed" } });
    expect(owner.status).toBe(200);
    release();

    expect((await waiting).status).toBe(400);
    expect(await sessionHashes()).toEqual([await hashOfCookie(sessionCookie(owner))]);
  });

  it("loses the app tokens it made when the owner takes the copy back", async () => {
    await squatterAndOwnerLink();
    db.prepare("INSERT INTO integration_tokens (id, owner_id, label, token_hash, created_at) SELECT 'tok1', id, 'NextNote', 'hash', 1 FROM owners").run();
    expect((await register({ purpose: "owner-recover", code: RECOVERY_LINK_CODE })).status).toBe(200);
    expect(db.prepare("SELECT revoked_at FROM integration_tokens WHERE id = 'tok1'").get()).not.toEqual({ revoked_at: null });
  });
});

describe("a SETUP_CODE on a copy deployed by hand", () => {
  it("recovers once without any grant, because its owner set it and nobody handed it out", async () => {
    delete (env as Partial<Env>).INSTALLER_COPY;
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

describe("the update that brings migration 0014", () => {
  it("retires the claim code of a copy that already has an owner", async () => {
    const old = migratedDb(MIGRATIONS.length - 1);
    old.prepare("INSERT INTO owners (id, name, webauthn_user_id, recovery_hash, created_at) VALUES ('own_old', 'Owner', 'dXNlcg', NULL, 1)").run();
    const oldEnv = { DB: d1(old), SETUP_CODE: CLAIM_CODE } as unknown as Env;

    const applied = await applyMigrations(oldEnv.DB);
    expect(applied).toContain("0014_setup_codes_and_attempts.sql");
    await retireClaimCode(oldEnv, applied);

    const spent = old.prepare("SELECT code_hash FROM spent_codes").all() as Array<{ code_hash: string }>;
    expect(spent.map((row) => row.code_hash)).toEqual([await sha256Hex(CLAIM_CODE)]);
  });

  it("leaves the code of a copy nobody has claimed yet alone", async () => {
    const old = migratedDb(MIGRATIONS.length - 1);
    const oldEnv = { DB: d1(old), SETUP_CODE: CLAIM_CODE } as unknown as Env;
    await retireClaimCode(oldEnv, await applyMigrations(oldEnv.DB));
    expect(old.prepare("SELECT COUNT(*) AS n FROM spent_codes").get()).toEqual({ n: 0 });
  });
});

describe("a copy whose schema update has not landed", () => {
  it("still lets the owner recover with the recovery code", async () => {
    const claimed = await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" });
    db.exec("DROP TABLE spent_codes;");
    expect((await register({ purpose: "owner-recover", code: claimed.data.recoveryCode })).status).toBe(200);
  });

  it("lets the owner sign in, and says a code check is waiting for the update instead of failing", async () => {
    db.exec("DROP TABLE auth_attempts; DROP TABLE spent_codes; DROP TABLE setup_code_grants;");
    expect((await call("/login/options")).status).toBe(200);
    expect(await registerOptions({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" })).toMatchObject({ status: 503, data: { code: "update_pending" } });
    // ...and tells the installer not to write a grant yet.
    expect(await me()).toMatchObject({ recoveryGrants: false });
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

  it("stop guessing at recovery codes too", async () => {
    await register({ purpose: "setup", setupCode: CLAIM_CODE, name: "Owner" }, "192.0.2.44");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await registerOptions({ purpose: "owner-recover", code: `NOPE-${attempt}` })).data.code).toBe("wrong_recovery_code");
    }
    expect(await registerOptions({ purpose: "owner-recover", code: "NOPE-X" })).toMatchObject({ status: 429, data: { code: "too_many_attempts" } });
  });

  it("count an IPv6 address by its /64, so one host cannot rotate through its own block", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await registerOptions({ purpose: "setup", setupCode: `WRONG-${attempt}`, name: "Owner" }, `2001:db8:1:2::${attempt + 1}`);
    }
    const blocked = await registerOptions({ purpose: "setup", setupCode: "WRONG", name: "Owner" }, "2001:db8:1:2:ffff::9");
    expect(blocked).toMatchObject({ status: 429, data: { code: "too_many_attempts" } });
    expect((await registerOptions({ purpose: "setup", setupCode: "WRONG", name: "Owner" }, "2001:db8:1:3::1")).data.code).toBe("wrong_setup_code");
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
});

describe("address buckets", () => {
  it("keep IPv4 as it is, group IPv6 by /64, and read an IPv4-mapped address as IPv4", () => {
    expect(addressBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(addressBucket("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressBucket("::ffff:198.51.100.9")).toBe("198.51.100.9");
    expect(addressBucket("local")).toBe("local");
  });
});
