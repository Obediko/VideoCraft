import { createPool } from "./index.js";
import { migrateDatabase } from "./migration-runner.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.trim()) throw new Error("DATABASE_URL is required");
const pool = createPool(databaseUrl);
try {
  const applied = await migrateDatabase(pool);
  console.log(JSON.stringify({ event: "database.migrations_applied", applied }));
} finally {
  await pool.end();
}
