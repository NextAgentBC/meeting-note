import { MIGRATIONS, type Migration, type MigrationSentinel } from "./migrations.generated";
import type { Env } from "./types";

// An installed copy is updated by replacing its Worker, and the new code may need columns the
// database has never seen. Nobody is there to run `wrangler d1 migrations apply`, so the app
// carries its own migrations and applies what is missing the first time it runs.

let ensured: Promise<unknown> | null = null;

export function ensureSchema(env: Env): Promise<unknown> {
  if (!ensured) {
    ensured = applyMigrations(env.DB).catch((error) => {
      // A failure must not stick for the life of the isolate: the next request tries again.
      ensured = null;
      throw error;
    });
  }
  return ensured;
}

/** Runs what this copy of the code needs and the database does not have yet. Returns their names. */
export async function applyMigrations(db: D1Database, migrations: Migration[] = MIGRATIONS): Promise<string[]> {
  await db.prepare("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)").run();
  const recorded = await db.prepare("SELECT name FROM schema_migrations").all<{ name: string }>();
  const done = new Set((recorded.results || []).map((row) => row.name));
  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.name)) continue;
    // A copy installed before this table existed already has these tables: adopt, don't re-run.
    const present = migration.sentinel ? await objectExists(db, migration.sentinel) : false;
    if (!present) {
      // One transaction per migration, so a failure half way leaves nothing recorded and nothing done.
      await db.batch(migration.statements.map((statement) => db.prepare(statement)));
      applied.push(migration.name);
    }
    await db.prepare("INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)")
      .bind(migration.name, new Date().toISOString())
      .run();
  }
  return applied;
}

async function objectExists(db: D1Database, sentinel: MigrationSentinel): Promise<boolean> {
  if (sentinel.kind === "table") {
    const row = await db.prepare("SELECT name FROM sqlite_master WHERE name = ? LIMIT 1").bind(sentinel.name).first<{ name: string }>();
    return Boolean(row);
  }
  // SQLite rewrites a table's stored CREATE statement when a column is added, so it is the record.
  const table = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .bind(sentinel.name)
    .first<{ sql: string }>();
  return Boolean(table?.sql && new RegExp(`\\b${sentinel.column}\\b`).test(table.sql));
}
