import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS, secureResponse } from "../src/headers";
import { serveEmbeddedAsset } from "../src/standalone-assets.generated";
import standalone from "../src/standalone";
import template from "../src/index";
import type { Env } from "../src/types";

/** Enough of D1 for the schema runner and /api/health, over node:sqlite. */
function d1(db: DatabaseSync): D1Database {
  const statement = (sql: string, values: unknown[] = []): any => ({
    sql,
    values,
    bind: (...bound: unknown[]) => statement(sql, bound),
    run: async () => ({ success: true, meta: db.prepare(sql).run(...(values as never[])) }),
    all: async () => ({ results: db.prepare(sql).all(...(values as never[])) }),
    first: async () => db.prepare(sql).get(...(values as never[])) ?? null
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<{ sql: string; values: unknown[] }>) => {
      db.exec("BEGIN");
      try {
        const results = statements.map((item) => db.prepare(item.sql).run(...(item.values as never[])));
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  } as unknown as D1Database;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const headersFile = fileURLToPath(new URL("../public/_headers", import.meta.url));

describe("security headers", () => {
  it("are the same in public/_headers as in the Worker", () => {
    const lines = readFileSync(headersFile, "utf8").split("\n");
    expect(lines[0]).toBe("/*");
    const declared = Object.fromEntries(lines.slice(1).filter((line) => line.trim()).map((line) => {
      const [name, ...value] = line.trim().split(":");
      return [name, value.join(":").trim()];
    }));
    expect(declared).toEqual(SECURITY_HEADERS);
  });

  it("forbid framing on every response, and keep what the response already said", () => {
    const secured = secureResponse(new Response("{}", { status: 401, headers: { "content-type": "application/json", "referrer-policy": "no-referrer" } }));
    expect(secured.status).toBe(401);
    expect(secured.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(secured.headers.get("x-frame-options")).toBe("DENY");
    expect(secured.headers.get("referrer-policy")).toBe("no-referrer");
    expect(secured.headers.get("content-type")).toBe("application/json");
  });

  it("reach the pages an installed copy serves from inside its Worker", () => {
    const page = secureResponse(serveEmbeddedAsset(new Request("https://notes.example.test/")));
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toBe(SECURITY_HEADERS["Content-Security-Policy"]);
    // The instruction file for Cloudflare's asset server is not one of the app's pages.
    expect(serveEmbeddedAsset(new Request("https://notes.example.test/_headers")).headers.get("content-type")).toContain("text/html");
  });
  it("come from both Worker entries: the installer's bundle and the template", async () => {
    const env = { DB: d1(new DatabaseSync(":memory:")), UPDATE_CHANNEL: "off" } as unknown as Env;

    const asset = await standalone.fetch(new Request("https://notes.example.test/"), env, ctx);
    expect(asset.headers.get("x-frame-options")).toBe("DENY");

    for (const worker of [standalone, template]) {
      const health = await worker.fetch(new Request("https://notes.example.test/api/health"), env, ctx);
      expect(health.headers.get("content-security-policy")).toBe(SECURITY_HEADERS["Content-Security-Policy"]);
      // "off" is the owner's opt-out: the copy reports no update channel at all.
      expect(await health.json()).toMatchObject({ ok: true, updateChannel: "" });
    }
  });
});
