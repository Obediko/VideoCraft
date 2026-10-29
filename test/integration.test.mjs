import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";
import Redis from "ioredis";
import { migrateDatabase, PostgresProjectRepository, PostgresAuditRepository, PostgresFeedbackRepository, PostgresRenderJobRepository } from "@videocraft/persistence";
import { S3ObjectStorage } from "@videocraft/storage";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const skip = !databaseUrl || !redisUrl;

test("PostgreSQL persistence and Redis connectivity are available", { skip }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  await migrateDatabase(pool);
  const projectId = "integration-project-" + Date.now();
  await pool.query("INSERT INTO projects (id, owner_id, name, revision, created_at, updated_at) VALUES ($1,$2,$3,$4,now(),now())", [projectId, "integration-user", "Integration " + projectId, 0]);
  const renderJobs = new PostgresRenderJobRepository(pool);
  const job = { id: "integration-render-" + Date.now(), projectId, revision: 1, settings: { format: "mp4", videoCodec: "libx264", audioCodec: "aac", width: 1280, height: 720, frameRate: 30 }, idempotencyKey: "integration-" + Date.now(), status: "queued", progress: 0 };
  await renderJobs.save(job);
  assert.equal((await renderJobs.get(job.id))?.projectId, projectId);
  const secondProjectId = projectId + "-second";
  await pool.query("INSERT INTO projects (id, owner_id, name, revision, created_at, updated_at) VALUES ($1,$2,$3,$4,now(),now())", [secondProjectId, "integration-user", "Second " + projectId, 0]);
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
  if (process.env.S3_ENDPOINT) {
    const bucket = process.env.S3_BUCKET ?? "videocraft-ci";
    const client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "videocraft",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "videocraft-secret",
      },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    const directory = await mkdtemp(join(tmpdir(), "videocraft-s3-integration-"));
    const source = join(directory, "source.bin");
    const destination = join(directory, "staged.bin");
    const key = "integration/" + Date.now() + "/source.bin";
    try {
      await writeFile(source, "provider contract");
      const storage = new S3ObjectStorage({ bucket, region: process.env.S3_REGION ?? "us-east-1", endpoint: process.env.S3_ENDPOINT, forcePathStyle: true, client });
      await storage.putFile(source, key);
      assert.equal((await storage.list("integration/")).some((object) => object.key === key), true);
      await storage.downloadToFile(key, destination);
      assert.equal(await readFile(destination, "utf8"), "provider contract");
      await storage.remove(key);
      assert.equal((await storage.list("integration/")).some((object) => object.key === key), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const redis = new Redis(redisUrl);
  const pong = await redis.ping();
  assert.equal(pong, "PONG");
  await redis.quit();
  await pool.query("DELETE FROM projects WHERE id = ANY($1)", [[projectId, secondProjectId]]);
  await pool.end();
});

test("migration 006 renames existing duplicate project names, then enforces uniqueness per owner", { skip }, async () => {
  const { readdir } = await import("node:fs/promises");
  const admin = new Pool({ connectionString: databaseUrl });
  const name = "vc_migration_" + Date.now();
  await admin.query("CREATE DATABASE " + name);
  const url = new URL(databaseUrl); url.pathname = "/" + name;
  const pool = new Pool({ connectionString: url.toString() });
  try {
    // A database as staging had it before 006: migrations 001-005 applied, duplicate names present.
    const dir = new URL("../packages/persistence/migrations/", import.meta.url);
    await pool.query("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
      if (file >= "006") break;
      await pool.query(await readFile(new URL(file, dir), "utf8"));
      await pool.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
    }
    const rows = [["p1", "obed", "My first cut", "2026-10-22T21:00:00Z"], ["p2", "obed", "My first cut", "2026-10-22T21:07:00Z"], ["p3", "obed", "my  first CUT ", "2026-10-23T10:00:00Z"], ["p4", "obed", "My first cut (2)", "2026-10-23T11:00:00Z"], ["p5", "obed", "My first cut", "2026-10-24T09:00:00Z"], ["q1", "someone-else", "My first cut", "2026-10-23T09:00:00Z"]];
    for (const [id, owner, n, at] of rows) await pool.query("INSERT INTO projects (id, owner_id, name, revision, created_at, updated_at) VALUES ($1,$2,$3,0,$4,$4)", [id, owner, n, at]);

    assert.deepEqual(await migrateDatabase(pool), ["006_unique_project_names.sql"]);
    const names = Object.fromEntries((await pool.query("SELECT id, name FROM projects ORDER BY id")).rows.map((r) => [r.id, r.name]));
    assert.equal(names.p1, "My first cut", "the oldest keeps its name");
    assert.equal(names.p4, "My first cut (2)", "an existing numbered name is left alone");
    assert.deepEqual([names.p2, names.p3, names.p5].sort(), ["My first cut (3)", "my first CUT (4)", "My first cut (5)"].sort(), "duplicates are numbered without colliding: " + JSON.stringify(names));
    assert.equal(names.q1, "My first cut", "another person's project is untouched");

    await assert.rejects(pool.query("INSERT INTO projects (id, owner_id, name, revision, created_at, updated_at) VALUES ('p9','obed',' MY FIRST   cut',0,now(),now())"), (e) => e.code === "23505");
    const repo = new PostgresProjectRepository(pool);
    await assert.rejects(repo.save({ id: "p10", ownerId: "obed", name: "My First Cut", revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), (e) => e.code === "project_name_taken");
    await repo.save({ id: "p11", ownerId: "obed", name: "Launch reel", revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  } finally {
    await pool.end();
    await admin.query("DROP DATABASE IF EXISTS " + name);
    await admin.end();
  }
});
