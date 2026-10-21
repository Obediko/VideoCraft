import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import Redis from "ioredis";
import { migrateDatabase, PostgresAuditRepository, PostgresFeedbackRepository, PostgresRenderJobRepository } from "@videocraft/persistence";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const skip = !databaseUrl || !redisUrl;

test("PostgreSQL persistence and Redis connectivity are available", { skip }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  await migrateDatabase(pool);
  const projectId = "integration-project-" + Date.now();
  await pool.query("INSERT INTO projects (id, owner_id, name, revision, created_at, updated_at) VALUES ($1,$2,$3,$4,now(),now())", [projectId, "integration-user", "Integration", 0]);
  const renderJobs = new PostgresRenderJobRepository(pool);
  const job = { id: "integration-render-" + Date.now(), projectId, revision: 1, settings: { format: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1280, height: 720, frameRate: 30 }, idempotencyKey: "integration-" + Date.now(), status: "queued", progress: 0 };
  await renderJobs.save(job);
  assert.equal((await renderJobs.get(job.id))?.projectId, projectId);
  const secondProjectId = projectId + "-second";
  await pool.query("INSERT INTO projects (id, owner_id, name, revision, created_at, updated_at) VALUES ($1,$2,$3,$4,now(),now())", [secondProjectId, "integration-user", "Second", 0]);
  const secondJob = { ...job, id: job.id + "-second", projectId: secondProjectId };
  await renderJobs.save(secondJob);
  assert.equal((await renderJobs.get(secondJob.id))?.projectId, secondProjectId);
  const feedback = new PostgresFeedbackRepository(pool);
  await feedback.append({ id: "integration-feedback-" + Date.now(), projectId, revision: 1, type: "accepted", createdAt: new Date().toISOString() });
  const audit = new PostgresAuditRepository(pool);
  const auditId = "integration-audit-" + Date.now();
  await audit.append({ id: auditId, actorId: "integration-user", projectId, action: "/v1/projects/:projectId", method: "GET", route: "/v1/projects/:projectId", statusCode: 200, requestId: auditId, createdAt: new Date().toISOString() });
  const auditRow = await pool.query("SELECT actor_id, project_id, status_code FROM audit_events WHERE id = $1", [auditId]);
  assert.deepEqual(auditRow.rows[0], { actor_id: "integration-user", project_id: projectId, status_code: 200 });
  const redis = new Redis(redisUrl);
  const pong = await redis.ping();
  assert.equal(pong, "PONG");
  await redis.quit();
  await pool.query("DELETE FROM projects WHERE id = ANY($1)", [[projectId, secondProjectId]]);
  await pool.end();
});
