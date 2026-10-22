import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Pool } from "pg";

export async function migrateDatabase(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const migrationDirectory = new URL("../migrations/", import.meta.url);
    const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
    const applied = new Set((await client.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((row) => row.version));
    const appliedNow: string[] = [];
    for (const file of files) {
      const version = basename(file);
      if (applied.has(version)) continue;
      await client.query(await readFile(new URL(file, migrationDirectory), "utf8"));
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      appliedNow.push(version);
    }
    await client.query("COMMIT");
    return appliedNow;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
