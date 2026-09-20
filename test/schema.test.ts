/**
 * The app's own migration runner, against real SQLite rather than a mock: it decides whether a
 * database that was installed months ago already has what a new release needs.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/schema";
import { MIGRATIONS } from "../src/migrations.generated";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** Just enough of the D1 binding for schema work, over node:sqlite. */
function d1(db: DatabaseSync): D1Database {
  const statement = (sql: string, values: unknown[] = []): any => ({
    bind: (...bound: unknown[]) => statement(sql, bound),
    run: async () => ({ success: true, results: db.prepare(sql).all(...(values as never[])) }),
    all: async () => ({ results: db.prepare(sql).all(...(values as never[])) }),
    first: async () => db.prepare(sql).get(...(values as never[])) ?? null,
    sql
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<{ sql: string }>) => {
      db.exec("BEGIN");
      try {
        for (const item of statements) db.exec(item.sql);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return [];
    }
  } as unknown as D1Database;
}

function migratedByHand(upTo: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort().slice(0, upTo);
  for (const file of files) db.exec(readFileSync(`${migrationsDir}/${file}`, "utf8"));
  return db;
}

describe("the app's own schema updates", () => {
  it("builds a database from nothing", async () => {
    const db = new DatabaseSync(":memory:");
    const applied = await applyMigrations(d1(db));

    expect(applied).toEqual(MIGRATIONS.map((migration) => migration.name));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row: any) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["meetings", "owners", "memory_items", "captures", "schema_migrations"]));
  });

  it("adopts a database that was installed before migrations were tracked", async () => {
    // Everything a copy installed by the old installer already has, with nothing recorded anywhere.
    const db = migratedByHand(MIGRATIONS.length);

    const applied = await applyMigrations(d1(db));

    // Nothing re-run — CREATE TABLE without IF NOT EXISTS would have thrown — but all of it known.
    expect(applied).toEqual([]);
    const recorded = db.prepare("SELECT name FROM schema_migrations ORDER BY name").all().map((row: any) => row.name);
    expect(recorded).toEqual(MIGRATIONS.map((migration) => migration.name));
  });

  it("applies only what an older copy is missing", async () => {
    const db = migratedByHand(MIGRATIONS.length - 2);

    const applied = await applyMigrations(d1(db));

    expect(applied).toEqual(MIGRATIONS.slice(-2).map((migration) => migration.name));
    const captures = db.prepare("SELECT name FROM sqlite_master WHERE name = 'captures'").all();
    expect(captures).toHaveLength(1);
  });

  it("does nothing the second time, and nothing the third", async () => {
    const db = new DatabaseSync(":memory:");
    await applyMigrations(d1(db));

    expect(await applyMigrations(d1(db))).toEqual([]);
    expect(await applyMigrations(d1(db))).toEqual([]);
  });
});
