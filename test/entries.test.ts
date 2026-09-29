/**
 * The two Worker entries, called the way Cloudflare calls them: src/standalone.ts (the installer's
 * bundle) and src/index.ts (the template). What a copy may do with a setup code depends on which
 * one it runs, and the schema runner behind both retires an old claim code once.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import standalone from "../src/standalone";
import template from "../src/index";
import { sha256Hex } from "../src/auth";
import { MIGRATIONS } from "../src/migrations.generated";
import type { Env } from "../src/types";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
const ORIGIN = "https://notes.example.test";
const CLAIM_CODE = "ABCD-EFGH-JKLM-NPQR";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

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

function ownerClaimedLongAgo(db: DatabaseSync) {
  db.prepare("INSERT INTO owners (id, name, webauthn_user_id, recovery_hash, created_at) VALUES ('own_old', 'Owner', 'dXNlcg', NULL, 1)").run();
}

type Entry = { fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> };

async function recoverOptions(worker: Entry, env: Env, code: string) {
  return worker.fetch(new Request(`${ORIGIN}/api/auth/register/options`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify({ purpose: "owner-recover", code })
  }), env, ctx);
}

describe("the Worker entries", () => {
  // First in this file: the schema runner runs once per isolate, so this is the request that
  // brings migration 0014 to a copy claimed before it existed.
  it("retire the claim code of an owned copy on the request that brings migration 0014", async () => {
    const db = migratedDb(MIGRATIONS.length - 1);
    ownerClaimedLongAgo(db);
    const env = { DB: d1(db), SETUP_CODE: CLAIM_CODE } as unknown as Env;

    const health = await template.fetch(new Request(`${ORIGIN}/api/health`), env, ctx);
    expect(health.status).toBe(200);
    const spent = db.prepare("SELECT code_hash FROM spent_codes").all() as Array<{ code_hash: string }>;
    expect(spent.map((row) => row.code_hash)).toEqual([await sha256Hex(CLAIM_CODE)]);

    // The old claim link, typed into recovery, is refused by either entry.
    for (const worker of [standalone, template]) {
      expect(await (await recoverOptions(worker, env, CLAIM_CODE)).json()).toMatchObject({ code: "setup_code_used" });
    }
  });

  it("tell an installer's copy from a hand-deployed one without any variable", async () => {
    const db = migratedDb();
    ownerClaimedLongAgo(db);
    // A new secret nobody granted: no UPDATE_CHANNEL either way, so only the entry tells them apart.
    const env = { DB: d1(db), SETUP_CODE: "a code nobody granted 2026" } as unknown as Env;

    const installed = await recoverOptions(standalone, env, "a code nobody granted 2026");
    expect(installed.status).toBe(403);
    expect(await installed.json()).toMatchObject({ code: "setup_code_not_granted" });

    // The template's copy was deployed by its owner, who set this secret: it opens once.
    const handDeployed = await recoverOptions(template, env, "a code nobody granted 2026");
    expect(handDeployed.status).toBe(200);
  });
});
