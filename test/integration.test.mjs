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
  await renderJobs.update({ ...job, status: "cancelled", progress: 5 });
  await renderJobs.update({ ...job, status: "running", progress: 25 });
  await renderJobs.update({ ...job, status: "succeeded", progress: 100 });
  assert.equal((await renderJobs.get(job.id)).status, "cancelled", "worker progress cannot undo cancellation");
  await renderJobs.update({ ...secondJob, status: "succeeded", progress: 100 });
  await renderJobs.update({ ...secondJob, status: "cancelled", progress: 5 });
  assert.equal((await renderJobs.get(secondJob.id)).status, "succeeded", "late cancellation cannot undo success");
  const history = await renderJobs.listForProject(projectId);
  assert.ok(history.length > 0 && history.every(item => item.projectId === projectId));

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

    assert.ok((await migrateDatabase(pool)).includes("006_unique_project_names.sql"), "006 is applied on top of 001-005");
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

test("session refresh: concurrent refreshes from two tabs both succeed; logged-out and stale rotated sessions are refused", { skip }, async () => {
  const Fastify = (await import("fastify")).default;
  const rateLimit = (await import("@fastify/rate-limit")).default;
  const { registerAuthRoutes } = await import("../apps/api/dist/auth-routes.js");
  const pool = new Pool({ connectionString: databaseUrl });
  await migrateDatabase(pool);
  const server = Fastify();
  await server.register(rateLimit, { global: true, max: 1000, timeWindow: "1 minute" });
  registerAuthRoutes(server, { database: pool, secret: "integration-secret-0123456789abcdef0123", allowedEmails: "*" });
  await server.ready();
  const cookieOf = (response) => String(response.headers["set-cookie"]).split(";")[0];
  try {
    const email = "tabs-" + Date.now() + "@example.org";
    const registered = await server.inject({ method: "POST", url: "/auth/register", payload: { email, password: "correct horse battery staple" } });
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = cookieOf(registered);
    const refresh = (c) => server.inject({ method: "POST", url: "/auth/refresh", headers: { cookie: c } });
    // Two tabs reload at once with the same cookie.
    const [a, b] = await Promise.all([refresh(cookie), refresh(cookie)]);
    assert.deepEqual([a.statusCode, b.statusCode], [200, 200], "neither tab is signed out");
    // The same old cookie again, still inside the grace minute: accepted.
    assert.equal((await refresh(cookie)).statusCode, 200);
    // Outside the grace window the replaced cookie no longer works.
    await pool.query("UPDATE auth_sessions SET rotated_at = NOW() - INTERVAL '2 minutes' WHERE rotated_at IS NOT NULL");
    assert.equal((await refresh(cookie)).statusCode, 401, "a long-replaced session is refused");
    // Logging out ends the current session for good.
    const current = cookieOf(a);
    await server.inject({ method: "POST", url: "/auth/logout", headers: { cookie: current } });
    assert.equal((await refresh(current)).statusCode, 401, "a logged-out session is refused even within a minute");
  } finally { await server.close(); await pool.end(); }
});

test("deleting a project removes its rows everywhere and leaves other projects alone", { skip }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await migrateDatabase(pool);
    const stamp = Date.now();
    const ids = ["del-" + stamp, "keep-" + stamp];
    for (const id of ids) {
      await pool.query("INSERT INTO projects (id, owner_id, name, revision, created_at, updated_at) VALUES ($1,$2,$3,1,now(),now())", [id, "del-user", "P " + id]);
      await pool.query("INSERT INTO assets (id, project_id, kind, storage_key, checksum_sha256, metadata, created_at) VALUES ($1,$2,'video',$3,$4,'{}',now())", ["a-" + id, id, "projects/" + id + "/assets/a.media", "c".repeat(64)]);
      await pool.query("INSERT INTO transcript_segments (id, asset_id, start_us, end_us, text, words, provider) VALUES ($1,$2,0,1000,'hi','[]','t')", ["t-" + id, "a-" + id]);
      await pool.query("INSERT INTO project_revisions (project_id, revision, timeline, accepted_proposal_ids, created_at, created_by) VALUES ($1,1,$2,'[]',now(),'del-user')", [id, JSON.stringify({ durationUs: 0, tracks: [] })]);
    }
    await new PostgresProjectRepository(pool).delete(ids[0]);
    const count = async (sql, id) => Number((await pool.query(sql, [id])).rows[0].n);
    for (const [table, sql] of [["projects", "SELECT count(*) n FROM projects WHERE id = $1"], ["assets", "SELECT count(*) n FROM assets WHERE project_id = $1"], ["transcripts", "SELECT count(*) n FROM transcript_segments t JOIN assets a ON a.id = t.asset_id WHERE a.project_id = $1"], ["revisions", "SELECT count(*) n FROM project_revisions WHERE project_id = $1"]]) {
      assert.equal(await count(sql, ids[0]), 0, table + " of the deleted project are gone");
      assert.equal(await count(sql, ids[1]), 1, table + " of the other project stay");
    }
    assert.equal(await count("SELECT count(*) n FROM transcript_segments WHERE asset_id = $1", "a-" + ids[0]), 0);
    await new PostgresProjectRepository(pool).delete(ids[1]);
  } finally { await pool.end(); }
});
