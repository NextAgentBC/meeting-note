import { validTimeZone } from "./tasks";
import type { Env } from "./types";

// Small owner settings kept in D1: the time zone, the calendar feed address, one-off markers.

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(key, value, new Date().toISOString()).run();
}

/** The owner's time zone: whatever their browser last said, remembered for background jobs. */
export async function ownerTimeZone(env: Env, fromBrowser?: string | null): Promise<string> {
  const stored = await getSetting(env.DB, "timezone");
  const browser = validTimeZone(fromBrowser);
  if (browser) {
    if (browser !== stored) await setSetting(env.DB, "timezone", browser);
    return browser;
  }
  return validTimeZone(stored) ?? "UTC";
}
