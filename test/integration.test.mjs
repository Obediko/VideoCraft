import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import Redis from "ioredis";
import { PostgresFeedbackRepository, PostgresRenderJobRepository } from "@videocraft/persistence";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const skip = !databaseUrl || !redisUrl;

test("PostgreSQL persistence and Redis connectivity are available", { skip }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const migration = await readFile(new URL("../packages/persistence/migrations/001_initial.sql", import.meta.url), "utf8");
  await pool.query(migration);
  const projectId = "integration-project-" + Date.now();
  await pool.query("INSERT INTO projects (id, owner_id, name, revision, created_at, updated_at) VALUES ($1,$2,$3,$4,now(),now())", [projectId, "integration-user", "Integration", 0]);
  const renderJobs = new PostgresRenderJobRepository(pool);
  const job = { id: "integration-render-" + Date.now(), projectId, revision: 1, settings: { format: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1280, height: 720, frameRate: 30 }, idempotencyKey: "integration-" + Date.now(), status: "queued", progress: 0 };
  await renderJobs.save(job);
  assert.equal((await renderJobs.get(job.id))?.projectId, projectId);
  const feedback = new PostgresFeedbackRepository(pool);
  await feedback.append({ id: "integration-feedback-" + Date.now(), projectId, revision: 1, type: "accepted", createdAt: new Date().toISOString() });
  const redis = new Redis(redisUrl);
  const pong = await redis.ping();
  assert.equal(pong, "PONG");
  await redis.quit();
  await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
  await pool.end();
});
